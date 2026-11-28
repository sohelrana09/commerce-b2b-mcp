import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import type { AuditSink } from "../audit.js";
import type { CommerceTools } from "../assistant/commerce.js";
import { recordCorrection } from "../assistant/corrections.js";
import type { Extractor, RfqDocument } from "../assistant/extract/schema.js";
import { toolsFor } from "../assistant/in-process.js";
import { applyEdits, draftInput, FLAG_SEVERITY, type LineEdit, type LineReview } from "../assistant/pipeline.js";
import { ReviewStore, type SavedReview } from "../assistant/reviews.js";
import { MAX_RFQ_LINES, runReview } from "../assistant/summary.js";
import type { CommerceBackend } from "../backend/types.js";
import type { Config } from "../config.js";
import type { TokenLedger } from "../confirm.js";
import { ToolError } from "../errors.js";
import { cleanText } from "../tools/define.js";
import type { IdentityProvider, SignedInUser } from "./oauth.js";
import type { StateStore } from "./state.js";
import { MAX_EMAIL_LENGTH, reserveSignIn } from "./throttle.js";

/**
 * The RFQ review page (ADR 24): a rep signs in with their store account, uploads or receives an RFQ, fixes the
 * flagged lines, and saves a draft quote after seeing its preview. Every store call goes through the server's own
 * tools as the signed-in company user, exactly like an MCP client.
 *
 * Safety: sessions live in the state store (a cookie holds only a random id; the store keeps its hash); every POST
 * carries a per-session CSRF token and a same-origin check; every customer or store string is cleaned and
 * HTML-escaped; the CSP allows only this server's own script and stylesheet.
 */

export interface WebOptions {
  config: Config;
  store: StateStore;
  identity: IdentityProvider;
  audit: AuditSink;
  ledger: TokenLedger;
  backendFor: (user: SignedInUser) => CommerceBackend;
  /** Sign the user out at the store when their web session ends. */
  signOut: (user: SignedInUser) => Promise<void>;
  now?: () => number;
  /** Tests only: replaces the configured intake step. */
  extractor?: Extractor;
}

interface WebSession {
  user: SignedInUser;
  csrf: string;
  expiresAt: number;
}

const LOGIN_TTL_MS = 10 * 60_000;
/** RFQ reviews one user may start per hour. Bounds store load and, with Claude intake, API spend. */
export const MAX_UPLOADS_PER_HOUR = 30;
const MAX_TEXT = 200_000;
const MAX_PDF_BASE64 = 28_000_000;
const TEXT_TYPES = [".txt", ".eml", ".csv"];

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Customer- or store-written text: cleaned to plain text first, then escaped. */
const txt = (s: unknown, max = 500) => esc(cleanText(String(s ?? ""), max));
const money = (n: number | null | undefined, cur: string | null | undefined) => (n === null || n === undefined ? "—" : `${esc(cur ?? "")} ${n.toFixed(2)}`);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const QUOTE_ID = /^[A-Za-z0-9=_-]{1,64}$/;

const CSS = `body{font:15px/1.5 system-ui,sans-serif;margin:0;color:#1a1a1a;background:#fafafa}
header{background:#1f2a37;color:#fff;padding:.6rem 1.2rem;display:flex;gap:1.2rem;align-items:center;flex-wrap:wrap}
header a,header button{color:#fff;background:none;border:0;font:inherit;cursor:pointer;text-decoration:underline}
header form{margin-left:auto}main{max-width:72rem;margin:1.5rem auto;padding:0 1rem}
table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #ddd;padding:.4rem .5rem;text-align:left;vertical-align:top}
th{background:#f0f0f0}td:nth-child(2){min-width:16rem}.review{background:#fff7e6}.ready{background:#eefaf0}.excluded{color:#777}
.warn{border:2px solid #b45309;background:#fff7e6;padding:.75rem 1rem;margin:1rem 0}.err{color:#b00020}
.ok{color:#166534}.muted{color:#666;font-size:.9em}code{background:#f3f3f3;padding:0 .2rem;white-space:pre-wrap;word-break:break-word}
button,input,select,textarea{font:inherit}button.primary{background:#1f2a37;color:#fff;border:0;padding:.5rem 1rem;border-radius:4px;cursor:pointer}
label{display:block;margin-top:.8rem}textarea{width:100%;min-height:12rem;box-sizing:border-box}input[type=number]{width:6rem}
.actions{display:flex;gap:1rem;margin:1rem 0;flex-wrap:wrap}.actions form{margin:0}ul.flags{margin:.2rem 0;padding-left:1.1rem}`;

/** Reads a chosen file into hidden fields, so the upload is a plain form post (no multipart parser). */
const JS = `document.addEventListener("change",function(e){var i=e.target;if(!i||i.id!=="file")return;var f=i.files&&i.files[0];
var b=document.getElementById("file_base64"),n=document.getElementById("file_name"),s=document.getElementById("submit");if(!f){b.value="";n.value="";return;}
if(f.size>20*1024*1024){alert("The file is over 20 MB.");i.value="";return;}s.disabled=true;var r=new FileReader();
r.onload=function(){var u=String(r.result);b.value=u.slice(u.indexOf(",")+1);n.value=f.name;s.disabled=false;};r.readAsDataURL(f);});`;

export function rfqWebRouter(opts: WebOptions): Router {
  const { config, store } = opts;
  const http = config.http!;
  const now = opts.now ?? Date.now;
  const reviews = new ReviewStore(store, config.rfq.retentionDays, now);
  const secure = http.publicUrl.protocol === "https:";
  const cookieName = secure ? "__Host-rfq" : "rfq_session";
  const cookiePath = secure ? "/" : "/rfq";
  const sessionTtlMs = http.tokenTtlSeconds * 1000;
  const enabled = (t: string) => config.enabledTools.has(t as never);
  const router = express.Router();

  router.use((req, res, next) => {
    res.set({
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      // same-origin, not no-referrer: with no-referrer, browsers send "Origin: null" on the page's own form posts,
      // which the check below would refuse. Nothing is sent to other sites either way.
      "Referrer-Policy": "same-origin",
      "Cache-Control": "no-store",
    });
    // Same-origin check for every write, in addition to the CSRF token.
    if (req.method === "POST") {
      const origin = req.header("origin");
      if (origin && origin !== http.publicUrl.origin) return void res.status(403).type("text/plain").send("Cross-origin request refused.");
    }
    next();
  });

  router.get("/app.css", (_req, res) => void res.type("text/css").set("Cache-Control", "public, max-age=300").send(CSS));
  router.get("/app.js", (_req, res) => void res.type("application/javascript").set("Cache-Control", "public, max-age=300").send(JS));

  // ------------------------------------------------------------------ sessions

  const cookieValue = (req: Request): string | undefined => {
    for (const part of (req.header("cookie") ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === cookieName) return v.join("=");
    }
    return undefined;
  };

  const sessionOf = async (req: Request): Promise<WebSession | undefined> => {
    const raw = cookieValue(req);
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
    const s = await store.get<WebSession>("web-session", hash(raw));
    return s && s.expiresAt > now() ? s : undefined;
  };

  const setCookie = (res: Response, value: string, maxAgeMs: number) => {
    res.append(
      "Set-Cookie",
      `${cookieName}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`,
    );
  };

  type Authed = Request & { session: WebSession };
  const requireSession = async (req: Request, res: Response, next: NextFunction) => {
    const s = await sessionOf(req);
    if (!s) return void (req.method === "GET" ? res.redirect(303, "/rfq/login") : res.status(401).type("text/plain").send("Your session has ended. Sign in again."));
    if (req.method === "POST") {
      const given = typeof req.body?.csrf === "string" ? req.body.csrf : "";
      if (!given || !sameToken(given, s.csrf)) return void res.status(403).type("text/plain").send("The form has expired. Go back, reload the page and try again.");
    }
    (req as Authed).session = s;
    next();
  };

  const withTools = async <T>(s: WebSession, fn: (tools: CommerceTools) => Promise<T>): Promise<T> => {
    const tools = await toolsFor({ config, callerEmail: s.user.email, backend: opts.backendFor(s.user), audit: opts.audit, ledger: opts.ledger });
    try {
      return await fn(tools);
    } finally {
      await tools.close();
    }
  };

  const page = (res: Response, title: string, body: string, s?: WebSession, status = 200) => {
    const nav = s
      ? `<a href="/rfq">RFQ queue</a><a href="/rfq/new">New RFQ</a>${enabled("list_negotiable_quotes") ? '<a href="/rfq/quotes">Quotes</a>' : ""}
<span class="muted">${esc(s.user.email)}</span><form method="post" action="/rfq/logout">${csrf(s)}<button type="submit">Sign out</button></form>`
      : "<strong>RFQ review</strong>";
    res
      .status(status)
      .type("html")
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/rfq/app.css"><script src="/rfq/app.js" defer></script></head>
<body><header>${nav}</header><main><h1>${esc(title)}</h1>${body}</main></body></html>`);
  };
  const csrf = (s: WebSession) => `<input type="hidden" name="csrf" value="${esc(s.csrf)}">`;
  const fail = (res: Response, s: WebSession | undefined, message: string, status = 400) =>
    page(res, "Something went wrong", `<p class="err" role="alert">${txt(message, 600)}</p><p><a href="/rfq">Back to the queue</a></p>`, s, status);
  const toolMessage = (data: unknown) => (data as { error?: { message?: string } })?.error?.message ?? "The store call failed.";

  const small = express.urlencoded({ extended: false, limit: "100kb", parameterLimit: 1000 });
  const large = express.urlencoded({ extended: false, limit: "28mb", parameterLimit: 20 });

  /** Catch errors from async handlers: a ToolError's message is safe to show; anything else is logged and shown generically. */
  const handle =
    (fn: (req: Authed, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req as Authed, res);
      } catch (err) {
        const s = (req as Partial<Authed>).session;
        if (err instanceof ToolError) return fail(res, s, err.message, err.code === "RATE_LIMITED" ? 429 : 400);
        process.stderr.write(`[commerce-b2b-mcp] rfq web: ${err instanceof Error ? err.message : String(err)}\n`);
        fail(res, s, "Unexpected error. Nothing was saved or sent.", 500);
      }
    };

  // ------------------------------------------------------------------ sign-in

  const loginPage = async (res: Response, error?: string, status = 200) => {
    const nonce = opaque();
    await store.set("web-login", nonce, 1, LOGIN_TTL_MS);
    page(
      res,
      "Sign in",
      `<p>Sign in with your company account on the store. The page acts as you: your company's catalogue, prices and quotes.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/rfq/login"><input type="hidden" name="nonce" value="${esc(nonce)}">
<label>Email<input name="email" type="email" autocomplete="username" required maxlength="${MAX_EMAIL_LENGTH}"></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<p><button class="primary" type="submit">Sign in</button></p></form>`,
      undefined,
      status,
    );
  };

  router.get("/login", async (req, res) => {
    if (await sessionOf(req)) return void res.redirect(303, "/rfq");
    await loginPage(res);
  });

  router.post("/login", small, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nonce = typeof body.nonce === "string" ? body.nonce : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    // Single-use form nonce: a sign-in form posted from another site, or replayed, is refused.
    if (!nonce || !(await store.take("web-login", nonce))) return loginPage(res, "The sign-in form expired. Try again.", 400);
    const failed = () => loginPage(res, "Sign-in failed. Check your email and password, and that your account belongs to a company.", 401);
    if (!email || !password || email.length > MAX_EMAIL_LENGTH) return failed();
    const attempt = await reserveSignIn(store, req.ip, email);
    if (!attempt.allowed) return loginPage(res, "Too many failed attempts. Wait 15 minutes and try again.", 429);
    let user: SignedInUser;
    try {
      user = await opts.identity.signIn(email, password);
    } catch {
      return failed();
    }
    await attempt.succeeded();
    const value = opaque();
    const s: WebSession = { user, csrf: opaque(), expiresAt: now() + sessionTtlMs };
    await store.set("web-session", hash(value), s, sessionTtlMs);
    setCookie(res, value, sessionTtlMs);
    res.redirect(303, "/rfq");
  });

  router.post("/logout", small, requireSession, async (req, res) => {
    const raw = cookieValue(req)!;
    const s = await store.take<WebSession>("web-session", hash(raw));
    setCookie(res, "", 0);
    if (s) void opts.signOut(s.user).catch(() => undefined);
    res.redirect(303, "/rfq/login");
  });

  // ------------------------------------------------------------------ queue and upload

  router.get(
    "/",
    requireSession,
    handle(async (req, res) => {
      const items = await reviews.list(req.session.user.email);
      const rows = items
        .map(
          (r) => `<tr><td><a href="/rfq/r/${esc(r.id)}">${txt(r.title, 120)}</a>${r.suspicious ? ' <strong class="err">contains instructions</strong>' : ""}</td>
<td>${esc(r.source === "inbox" ? "Inbox" : "Upload")}</td><td>${esc(r.created_at.slice(0, 16).replace("T", " "))}</td>
<td>${r.lines} (${r.ready_lines} ready, ${r.review_lines} to review)</td><td>${r.drafted ? `Draft ${esc(r.drafted.quote_id)}` : "Not drafted"}</td></tr>`,
        )
        .join("");
      page(
        res,
        "RFQ queue",
        items.length
          ? `<table><thead><tr><th>RFQ</th><th>From</th><th>Received (UTC)</th><th>Lines</th><th>Quote</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">Reviews are deleted ${config.rfq.retentionDays} days after their last change.</p>`
          : `<p>No RFQs yet. <a href="/rfq/new">Review one now</a>.</p>`,
        req.session,
      );
    }),
  );

  router.get("/new", requireSession, (req, res) => {
    const s = (req as Authed).session;
    page(
      res,
      "New RFQ",
      `<form method="post" action="/rfq/new">${csrf(s)}
<label>Name<input name="name" required maxlength="120" placeholder="The email subject or the customer's reference"></label>
<label>Paste the RFQ (email text, lines or CSV rows)<textarea name="text" maxlength="${MAX_TEXT}"></textarea></label>
<label>Or attach a file (.txt, .eml, .csv${config.rfq.extractor === "claude" ? ", .pdf" : ""}; 20 MB at most)<input id="file" type="file" accept=".txt,.eml,.csv${config.rfq.extractor === "claude" ? ",.pdf" : ""}"></label>
<input type="hidden" id="file_base64" name="file_base64"><input type="hidden" id="file_name" name="file_name">
<p><button class="primary" id="submit" type="submit">Review</button></p>
<p class="muted">The RFQ is read by an intake step with no tools${config.rfq.extractor === "claude" ? " (Claude; a paid call)" : " (rule-based)"}. Nothing is saved to the store until you approve a draft.</p></form>`,
      s,
    );
  });

  router.post(
    "/new",
    large,
    requireSession,
    handle(async (req, res) => {
      const s = req.session;
      const b = req.body as Record<string, unknown>;
      const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
      const name = str("name").trim().slice(0, 120) || "RFQ";
      const text = str("text");
      const fileName = str("file_name").trim();
      const fileB64 = str("file_base64");
      let doc: RfqDocument;
      if (fileB64) {
        const ext = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
        if (fileB64.length > MAX_PDF_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(fileB64)) throw new ToolError("INVALID_INPUT", "The file is too large or was not read correctly.");
        if (ext === ".pdf") {
          if (!fileB64.startsWith("JVBER")) throw new ToolError("INVALID_INPUT", "The file is not a PDF.");
          doc = { kind: "pdf", name, base64: fileB64 };
        } else if (TEXT_TYPES.includes(ext)) {
          const decoded = Buffer.from(fileB64, "base64").toString("utf8");
          if (decoded.length > MAX_TEXT) throw new ToolError("INVALID_INPUT", `The file is over ${MAX_TEXT} characters. Split it.`);
          doc = { kind: "text", name, text: decoded };
        } else {
          throw new ToolError("INVALID_INPUT", "Attach a .txt, .eml, .csv or .pdf file. Save spreadsheets as CSV first.");
        }
      } else {
        if (!text.trim()) throw new ToolError("INVALID_INPUT", "Paste the RFQ or attach a file.");
        if (text.length > MAX_TEXT) throw new ToolError("INVALID_INPUT", `The RFQ is over ${MAX_TEXT} characters. Split it.`);
        doc = { kind: "text", name, text };
      }
      if ((await store.increment("rfq-uploads", s.user.email.toLowerCase(), 3600_000)) > MAX_UPLOADS_PER_HOUR) {
        throw new ToolError("RATE_LIMITED", `You can review ${MAX_UPLOADS_PER_HOUR} RFQs an hour. Try again later.`);
      }
      const review = await withTools(s, (tools) => runReview(doc, config.rfq, tools, opts.extractor));
      if (review.lines.length > MAX_RFQ_LINES) throw new ToolError("INVALID_INPUT", `The RFQ has ${review.lines.length} lines; split it into parts of ${MAX_RFQ_LINES} or fewer.`);
      const saved = await reviews.create(s.user.email, "upload", name, review);
      res.redirect(303, `/rfq/r/${saved.id}`);
    }),
  );

  // ------------------------------------------------------------------ one review

  const loadReview = async (req: Authed): Promise<SavedReview> => {
    const r = await reviews.get(req.session.user.email, String(req.params.id ?? ""));
    if (!r) throw new ToolError("NOT_FOUND", "That RFQ review was not found. It may have expired.");
    return r;
  };

  const lineRow = (l: LineReview, cur: string | null) => {
    const options = [l.match, ...l.alternatives].filter((c): c is NonNullable<typeof c> => Boolean(c));
    const select = options.length
      ? `<select name="sku_${l.index}">${options
          .map((c) => `<option value="${esc(c.sku)}"${l.match?.sku === c.sku ? " selected" : ""}>${txt(c.sku, 64)}: ${txt(c.name, 80)} (${c.score.toFixed(2)})</option>`)
          .join("")}<option value="__none__"${l.match ? "" : " selected"}>Leave out of the quote</option></select>`
      : `<span class="muted">No match in the catalogue</span>`;
    const flags = l.flags.length
      ? `<ul class="flags">${l.flags.map((f) => `<li>${FLAG_SEVERITY[f.code] === "review" ? "<strong>Review</strong>" : "Note"}: ${txt(f.message, 400)}</li>`).join("")}</ul>`
      : "";
    const cls = l.rep_excluded ? "excluded" : l.status;
    const status = l.rep_excluded ? "Left out" : l.status === "ready" ? (l.rep_confirmed ? "Ready (you confirmed)" : "Ready") : "<strong>Review</strong>";
    return `<tr class="${esc(cls)}"><td>${txt(l.line.line_ref ?? l.index + 1, 20)}</td><td><code>${txt(l.line.raw_text, 400)}</code>${flags}</td>
<td><input type="number" name="qty_${l.index}" value="${esc(l.qty_each)}" min="1" max="1000000" step="1"></td><td>${select}</td>
<td>${l.stock ? esc(l.stock.salable_qty ?? (l.stock.in_stock ? "in stock" : "0")) : "—"}</td><td>${money(l.price?.unit_price, cur)}</td><td>${money(l.price?.line_total, cur)}</td><td>${status}</td></tr>`;
  };

  router.get(
    "/r/:id",
    requireSession,
    handle(async (req, res) => {
      const saved = await loadReview(req);
      const r = saved.review;
      const cur = r.totals.currency;
      const sus = r.extraction.suspicious_instructions;
      const body = `${
        sus.length
          ? `<div class="warn" role="alert"><strong>This RFQ contains text aimed at the assistant or the process. It was ignored.</strong> Read the original before quoting:<ul>${sus
              .map((x) => `<li><code>${txt(x, 500)}</code></li>`)
              .join("")}</ul></div>`
          : ""
      }
<p>Customer: ${r.extraction.customer_name ? `<code>${txt(r.extraction.customer_name, 120)}</code>` : "not stated"} · Reference: ${
        r.extraction.rfq_reference ? `<code>${txt(r.extraction.rfq_reference, 120)}</code>` : "none"
      } · ${r.lines.length} lines · <strong>${r.totals.ready_lines} ready</strong> · <strong>${r.totals.review_lines} to review</strong> · ready subtotal ${money(r.totals.ready_subtotal, cur)}</p>
${r.extraction.other_requests.length ? `<p><strong>Other requests:</strong></p><ul>${r.extraction.other_requests.map((x) => `<li><code>${txt(x, 300)}</code></li>`).join("")}</ul>` : ""}
${saved.drafted ? `<p class="ok">Draft quote ${esc(saved.drafted.quote_id)} was saved from this review.${enabled("list_negotiable_quotes") ? ` <a href="/rfq/q/${esc(saved.drafted.quote_id)}">Open it</a>` : ""}</p>` : ""}
<form method="post" action="/rfq/r/${esc(saved.id)}/edit">${csrf(req.session)}
<table><thead><tr><th>#</th><th>Customer wrote</th><th>Qty (each)</th><th>Part</th><th>Stock</th><th>Unit price</th><th>Line total</th><th>Status</th></tr></thead>
<tbody>${r.lines.map((l) => lineRow(l, cur)).join("")}</tbody></table>
<div class="actions"><button type="submit">Apply my changes</button><span class="muted">Changed lines are re-priced from the store and count as your decision.</span></div></form>
<div class="actions"><form method="post" action="/rfq/r/${esc(saved.id)}/preview">${csrf(req.session)}<button class="primary" type="submit">Preview the draft quote</button></form>
<form method="post" action="/rfq/r/${esc(saved.id)}/delete">${csrf(req.session)}<button type="submit">Delete this review</button></form></div>`;
      page(res, saved.title, body, req.session);
    }),
  );

  router.post(
    "/r/:id/edit",
    small,
    requireSession,
    handle(async (req, res) => {
      const saved = await loadReview(req);
      const b = req.body as Record<string, unknown>;
      const edits: LineEdit[] = [];
      for (const l of saved.review.lines) {
        const rawSku = b[`sku_${l.index}`];
        const rawQty = b[`qty_${l.index}`];
        const sku = typeof rawSku === "string" ? (rawSku === "__none__" ? null : rawSku) : undefined;
        const qty = typeof rawQty === "string" && rawQty.trim() ? Number(rawQty) : undefined;
        const skuChanged = sku !== undefined && sku !== (l.match?.sku ?? null);
        const qtyChanged = qty !== undefined && qty !== l.qty_each;
        if (!skuChanged && !qtyChanged) continue;
        const target = sku !== undefined ? sku : (l.match?.sku ?? null);
        if (target === null && !skuChanged) continue; // a quantity on a line with no part changes nothing
        edits.push({ index: l.index, sku: target, ...(qty !== undefined && target !== null ? { qty_each: qty } : {}) });
      }
      if (!edits.length) return void res.redirect(303, `/rfq/r/${saved.id}`);
      let next;
      try {
        next = await withTools(req.session, (tools) => applyEdits(saved.review, edits, tools));
      } catch (err) {
        if (err instanceof Error && !(err instanceof ToolError) && /^Line |There is no line/.test(err.message)) throw new ToolError("INVALID_INPUT", err.message);
        throw err;
      }
      if (config.rfq.correctionsLog) {
        for (const e of edits) {
          const l = saved.review.lines[e.index]!;
          try {
            recordCorrection(config.rfq.correctionsLog, saved.review, l.line.line_ref ?? String(l.index + 1), {
              sku: e.sku,
              ...(e.qty_each !== undefined ? { qty_each: e.qty_each } : {}),
              note: "web review",
            });
          } catch (err) {
            process.stderr.write(`[commerce-b2b-mcp] could not record a correction: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
      }
      await reviews.update({ ...saved, review: next });
      res.redirect(303, `/rfq/r/${saved.id}`);
    }),
  );

  router.post(
    "/r/:id/delete",
    small,
    requireSession,
    handle(async (req, res) => {
      const saved = await loadReview(req);
      await reviews.delete(req.session.user.email, saved.id);
      res.redirect(303, "/rfq");
    }),
  );

  const draftFor = (saved: SavedReview) => {
    try {
      return draftInput(saved.review, { name: (saved.review.extraction.rfq_reference ?? saved.title).slice(0, 120) || "RFQ" });
    } catch (err) {
      throw new ToolError("INVALID_INPUT", err instanceof Error ? err.message : String(err));
    }
  };

  router.post(
    "/r/:id/preview",
    small,
    requireSession,
    handle(async (req, res) => {
      const saved = await loadReview(req);
      const input = draftFor(saved);
      if (!input.lines.length) throw new ToolError("INVALID_INPUT", "No line is ready. Decide the flagged lines first.");
      const preview = await withTools(req.session, (tools) => tools.call("draft_negotiable_quote", input));
      if (preview.isError) throw new ToolError("INVALID_INPUT", toolMessage(preview.data));
      const p = preview.data.preview as { name: string; currency: string; subtotal: number; lines: Array<{ sku: string; qty: number; unit_price: number; row_total: number; note: string | null }> };
      const warnings = preview.data.warnings as string[];
      const left = saved.review.lines.length - saved.review.totals.ready_lines;
      page(
        res,
        `Draft quote preview: ${p.name}`,
        `<p>For <strong>${txt(preview.data.company, 120)}</strong>. This saves a <strong>draft</strong>; it is not sent to the seller.${left ? ` ${left} line(s) still to review are left out.` : ""}</p>
${warnings.length ? `<div class="warn"><ul>${warnings.map((w) => `<li>${txt(w, 300)}</li>`).join("")}</ul></div>` : ""}
<table><thead><tr><th>SKU</th><th>Qty</th><th>Unit price</th><th>Line total</th><th>Note</th></tr></thead><tbody>${p.lines
          .map((l) => `<tr><td>${txt(l.sku, 64)}</td><td>${esc(l.qty)}</td><td>${money(l.unit_price, p.currency)}</td><td>${money(l.row_total, p.currency)}</td><td>${txt(l.note, 255)}</td></tr>`)
          .join("")}</tbody></table><p>Subtotal ${money(p.subtotal, p.currency)}</p>
<div class="actions"><form method="post" action="/rfq/r/${esc(saved.id)}/save">${csrf(req.session)}<input type="hidden" name="token" value="${esc(preview.data.confirmation_token)}">
<button class="primary" type="submit">Save as a draft quote</button></form><a href="/rfq/r/${esc(saved.id)}">Back to the review</a></div>`,
        req.session,
      );
    }),
  );

  router.post(
    "/r/:id/save",
    small,
    requireSession,
    handle(async (req, res) => {
      const saved = await loadReview(req);
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      if (!token) throw new ToolError("INVALID_INPUT", "Preview the draft first.");
      // The same input as the preview, rebuilt from the saved review: if the review changed since, the token no longer matches.
      const input = draftFor(saved);
      const result = await withTools(req.session, (tools) => tools.call("draft_negotiable_quote", { ...input, confirmation_token: token }));
      if (result.isError) throw new ToolError("INVALID_INPUT", toolMessage(result.data));
      const q = result.data.quote as { quote_id: string; status: string };
      await reviews.update({ ...saved, drafted: { quote_id: q.quote_id, at: new Date(now()).toISOString() } });
      page(
        res,
        "Draft saved",
        `${result.data.status === "draft_saved" ? `<p class="ok">Saved draft quote ${esc(q.quote_id)}.</p>` : `<div class="warn" role="alert">${txt(result.data.warning, 400)}</div>`}
${((result.data.warnings as string[] | undefined) ?? []).map((w) => `<p class="warn">${txt(w, 300)}</p>`).join("")}
<p>${enabled("submit_negotiable_quote") ? `<a href="/rfq/q/${esc(q.quote_id)}">Open the quote to send it to the seller</a>` : "A person submits it to the seller in the storefront."}</p>
<p><a href="/rfq">Back to the queue</a></p>`,
        req.session,
      );
    }),
  );

  // ------------------------------------------------------------------ quotes (when the tools are enabled)

  router.get(
    "/quotes",
    requireSession,
    handle(async (req, res) => {
      if (!enabled("list_negotiable_quotes")) throw new ToolError("TOOL_DISABLED", "Quote negotiation is not enabled on this server.");
      const list = await withTools(req.session, (tools) => tools.call("list_negotiable_quotes", { page_size: 20 }));
      if (list.isError) throw new ToolError("INVALID_INPUT", toolMessage(list.data));
      const items = list.data.items as Array<{ quote_id: string; name: string; status: string; updated_at: string | null; subtotal: number | null; currency: string }>;
      page(
        res,
        "Quotes",
        items.length
          ? `<table><thead><tr><th>Quote</th><th>Status</th><th>Changed</th><th>Subtotal</th></tr></thead><tbody>${items
              .map(
                (q) =>
                  `<tr><td><a href="/rfq/q/${esc(q.quote_id)}">${txt(q.name, 120)}</a></td><td>${q.status === "updated" ? "<strong>Seller answered</strong>" : esc(q.status)}</td><td>${esc(q.updated_at ?? "")}</td><td>${money(q.subtotal, q.currency)}</td></tr>`,
              )
              .join("")}</tbody></table>`
          : "<p>No quotes yet.</p>",
        req.session,
      );
    }),
  );

  const quoteId = (req: Request) => {
    const id = String(req.params.qid ?? "");
    if (!QUOTE_ID.test(id)) throw new ToolError("NOT_FOUND", "That quote was not found.");
    return id;
  };

  router.get(
    "/q/:qid",
    requireSession,
    handle(async (req, res) => {
      if (!enabled("get_negotiable_quote")) throw new ToolError("TOOL_DISABLED", "Quote negotiation is not enabled on this server.");
      const id = quoteId(req);
      const got = await withTools(req.session, (tools) => tools.call("get_negotiable_quote", { quote_id: id }));
      if (got.isError) throw new ToolError("NOT_FOUND", toolMessage(got.data));
      const q = got.data as {
        name: string;
        status: string;
        currency: string;
        subtotal: number | null;
        lines: Array<{ sku: string; name: string; qty: number; unit_price: number; row_total: number }>;
        comments: Array<{ at: string | null; author: string; author_name: string | null; text: { text: string } }>;
      };
      const canSubmit = enabled("submit_negotiable_quote") && ["draft", "updated", "open"].includes(q.status);
      const canClose = enabled("close_negotiable_quote") && !["ordered", "closed"].includes(q.status);
      page(
        res,
        `Quote: ${cleanText(q.name, 120)}`,
        `<p>Status: <strong>${esc(q.status)}</strong> · Subtotal ${money(q.subtotal, q.currency)}</p>
<table><thead><tr><th>SKU</th><th>Name</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr></thead><tbody>${q.lines
          .map((l) => `<tr><td>${txt(l.sku, 64)}</td><td>${txt(l.name, 120)}</td><td>${esc(l.qty)}</td><td>${money(l.unit_price, q.currency)}</td><td>${money(l.row_total, q.currency)}</td></tr>`)
          .join("")}</tbody></table>
<h2>Conversation</h2>${
          q.comments.length
            ? `<ul>${q.comments.map((c) => `<li><strong>${esc(c.author === "seller" ? "Seller" : "Buyer")}</strong>${c.author_name ? ` (${txt(c.author_name, 80)})` : ""} ${esc(c.at ?? "")}: <code>${txt(c.text.text, 600)}</code></li>`).join("")}</ul>`
            : "<p>No comments.</p>"
        }
${
  canSubmit
    ? `<form method="post" action="/rfq/q/${esc(id)}/submit">${csrf(req.session)}<label>${q.status === "draft" ? "Message to the seller (optional)" : "Your reply to the seller (optional)"}<textarea name="comment" maxlength="1000"></textarea></label>
<p><button class="primary" type="submit">Preview sending to the seller</button></p></form>`
    : ""
}
${canClose ? `<form method="post" action="/rfq/q/${esc(id)}/close">${csrf(req.session)}<button type="submit">Preview closing this quote</button></form>` : ""}
${q.status === "updated" ? "<p>To accept the seller's offer, check out the quote in the storefront.</p>" : ""}`,
        req.session,
      );
    }),
  );

  const quoteAction = (tool: "submit_negotiable_quote" | "close_negotiable_quote", confirm: boolean) =>
    handle(async (req, res) => {
      if (!enabled(tool)) throw new ToolError("TOOL_DISABLED", "This action is not enabled on this server.");
      const id = quoteId(req);
      const b = req.body as Record<string, unknown>;
      const comment = typeof b.comment === "string" && b.comment.trim() ? b.comment.trim().slice(0, 1000) : undefined;
      const args = { quote_id: id, ...(tool === "submit_negotiable_quote" && comment ? { comment } : {}) };
      const token = confirm && typeof b.token === "string" ? b.token : undefined;
      if (confirm && !token) throw new ToolError("INVALID_INPUT", "Preview the action first.");
      const result = await withTools(req.session, (tools) => tools.call(tool, { ...args, ...(token ? { confirmation_token: token } : {}) }));
      if (result.isError) throw new ToolError("INVALID_INPUT", toolMessage(result.data));
      if (confirm) {
        const st = (result.data.quote as { status: string }).status;
        return page(res, tool === "submit_negotiable_quote" ? "Sent to the seller" : "Quote closed", `<p class="ok">The quote is now ${esc(st)}.</p><p><a href="/rfq/q/${esc(id)}">Open the quote</a></p>`, req.session);
      }
      const verb = tool === "submit_negotiable_quote" ? "submit" : "close";
      page(
        res,
        tool === "submit_negotiable_quote" ? "Send to the seller?" : "Close this quote?",
        `<p>${txt(result.data.action, 200)}</p><p>Subtotal ${money(result.data.quote.subtotal, result.data.quote.currency)} · ${esc(result.data.quote.lines.length)} line(s)</p>
${comment ? `<p>Your message: <code>${txt(comment, 1000)}</code></p>` : ""}
<div class="actions"><form method="post" action="/rfq/q/${esc(id)}/${verb}/confirm">${csrf(req.session)}<input type="hidden" name="token" value="${esc(result.data.confirmation_token)}">${
          comment ? `<input type="hidden" name="comment" value="${esc(comment)}">` : ""
        }<button class="primary" type="submit">${tool === "submit_negotiable_quote" ? "Send it" : "Close it"}</button></form><a href="/rfq/q/${esc(id)}">Cancel</a></div>`,
        req.session,
      );
    });

  router.post("/q/:qid/submit", small, requireSession, quoteAction("submit_negotiable_quote", false));
  router.post("/q/:qid/submit/confirm", small, requireSession, quoteAction("submit_negotiable_quote", true));
  router.post("/q/:qid/close", small, requireSession, quoteAction("close_negotiable_quote", false));
  router.post("/q/:qid/close/confirm", small, requireSession, quoteAction("close_negotiable_quote", true));

  return router;
}
