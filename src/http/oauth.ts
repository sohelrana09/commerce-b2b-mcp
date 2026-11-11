import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Response, type Router } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { MemoryStore, type StateStore } from "./state.js";

/** The one scope this server issues: act as the signed-in company user. */
export const SCOPE = "commerce";

/** A company user who has proven who they are. `customerToken` stays on the server. */
export interface SignedInUser {
  email: string;
  customerToken?: string;
}

/** Checks a company user's credentials against the store. Never an admin login. */
export interface IdentityProvider {
  /** Resolve to the user, or throw (any error) when the credentials are wrong or the user is not an active company user. */
  signIn(email: string, password: string): Promise<SignedInUser>;
  signOut(user: SignedInUser): Promise<void>;
}

export interface Grant {
  id: string;
  clientId: string;
  user: SignedInUser;
  resource: string;
  expiresAt: number; // ms
}

/** A sign-in request between /authorize and /login. Plain JSON, so any instance can read it. */
interface Pending {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  resource: string;
}

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  user: SignedInUser;
  expiresAt: number;
}

export interface ProviderOptions {
  identity: IdentityProvider;
  /** The protected MCP endpoint, e.g. https://mcp.example.com/mcp. Every token is bound to it. */
  resource: URL;
  tokenTtlSeconds: number;
  /** Hosts allowed in redirect URIs besides loopback. */
  redirectHosts: string[];
  /** Delays before each retry of a failed sign-out at the store, in ms. Default: 1 s, then 5 s. */
  revokeRetryMs?: number[];
  /** Called when a grant ends (revoked or expired) so this instance's MCP sessions can be closed. */
  onGrantEnded?: (grantId: string) => void;
  /** Sign-in state. Defaults to memory (one instance); Redis shares it between instances (ADR 19). */
  store?: StateStore;
  now?: () => number;
}

const CODE_TTL_MS = 60_000;
/** Registrations are kept 30 days; a client that is forgotten registers again. */
const CLIENT_TTL_MS = 30 * 24 * 3600_000;
/** Grants stay readable this long after expiry, so the sweep can still sign the user out at the store. */
const GRANT_GRACE_MS = 24 * 3600_000;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 1000;
/** Registrations accepted per day across all addresses; bounds how many client records the store can be made to hold. */
const MAX_REGISTRATIONS_PER_DAY = 1000;
const MAX_CLIENT_NAME = 100;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_METADATA_BYTES = 4096;
const MAX_FAILURES = 5;
/** Per email across all addresses, so rotating addresses does not give unlimited guesses. */
const MAX_EMAIL_FAILURES = 20;
/** Failed sign-ins one sign-in request survives before it must be started again. */
const MAX_REQUEST_FAILURES = 10;
const MAX_EMAIL_LENGTH = 254;
const FAILURE_WINDOW_MS = 15 * 60_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** PKCE S256: base64url(SHA-256(verifier)) equals the stored challenge. */
function sameChallenge(verifier: string, challenge: string): boolean {
  const expected = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * OAuth 2.1 authorization server and token verifier for the HTTP transport.
 *
 * The company user signs in with their store email and password on our page;
 * the store checks them (ADR 1: never an admin). Each access token is opaque,
 * stored only as a SHA-256 hash, bound to this MCP resource and to exactly
 * one company user, and lives at most an hour. There are no refresh tokens:
 * the client signs in again. State is in a StateStore: memory for one
 * instance, Redis for several (ADR 19).
 */
export class CommerceOAuthProvider implements OAuthServerProvider {
  /**
   * We check the PKCE verifier ourselves, inside the single-use exchange, so a wrong verifier spends the code
   * (the SDK's own check would read the code without consuming it).
   */
  readonly skipLocalPkceValidation = true;
  readonly store: StateStore;
  private readonly now: () => number;

  constructor(private readonly opts: ProviderOptions) {
    this.now = opts.now ?? Date.now;
    this.store = opts.store ?? new MemoryStore({ now: this.now, maxEntries: { client: MAX_CLIENTS, failure: 50_000, "request-failure": 50_000 } });
  }

  // ------------------------------------------------------------ clients

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.store.get<OAuthClientInformationFull>("client", id),
      registerClient: async (meta) => {
        if (meta.redirect_uris.length > MAX_REDIRECT_URIS) throw new InvalidClientMetadataError(`At most ${MAX_REDIRECT_URIS} redirect URIs.`);
        if (meta.redirect_uris.some((u) => String(u).length > MAX_REDIRECT_URI_LENGTH)) throw new InvalidClientMetadataError("A redirect URI is too long.");
        if ((meta.client_name?.length ?? 0) > MAX_CLIENT_NAME) throw new InvalidClientMetadataError(`client_name is limited to ${MAX_CLIENT_NAME} characters.`);
        if (Buffer.byteLength(JSON.stringify(meta), "utf8") > MAX_METADATA_BYTES) throw new InvalidClientMetadataError("Client metadata is too large.");
        for (const uri of meta.redirect_uris) this.checkRedirect(String(uri));
        if ((await this.store.increment("registrations", "day", 24 * 3600_000)) > MAX_REGISTRATIONS_PER_DAY) {
          throw new TooManyRequestsError("Too many clients registered today. Try again tomorrow.");
        }
        const client: OAuthClientInformationFull = {
          ...meta,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(this.now() / 1000),
        };
        // The memory store keeps at most MAX_CLIENTS and forgets the oldest; Redis relies on the TTL and the
        // SDK's per-address rate limit on /register.
        await this.store.set("client", client.client_id, client, CLIENT_TTL_MS);
        return client;
      },
    };
  }

  /**
   * Any app can register itself, so the redirect URI is what stops a phishing
   * app from receiving a user's code. Only loopback and configured hosts pass.
   */
  private checkRedirect(uri: string): void {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      throw new InvalidClientMetadataError(`Invalid redirect URI: ${uri}`);
    }
    const loopback = LOOPBACK.has(u.hostname) && (u.protocol === "http:" || u.protocol === "https:");
    const allowed = u.protocol === "https:" && this.opts.redirectHosts.includes(u.hostname);
    if (!loopback && !allowed) {
      throw new InvalidClientMetadataError(
        `Redirect URI host "${u.hostname}" is not allowed. The operator can add it to COMMERCE_OAUTH_REDIRECT_HOSTS.`,
      );
    }
  }

  // ------------------------------------------------------------ authorize

  private resourceFor(requested: URL | undefined): string {
    const ours = this.opts.resource.href;
    if (!requested) return ours;
    if (requested.href.replace(/\/$/, "") !== ours.replace(/\/$/, "")) {
      throw new InvalidTargetError("This server only issues tokens for its own MCP endpoint.");
    }
    return ours;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const resource = this.resourceFor(params.resource);
    if (params.scopes?.some((s) => s !== SCOPE)) {
      res.status(400).type("text/plain").send(`Unknown scope. This server only issues "${SCOPE}".`);
      return;
    }
    const id = opaque();
    const p: Pending = {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      resource,
    };
    await this.store.set("pending", id, p, PENDING_TTL_MS);
    this.renderLogin(res, id, p);
  }

  private renderLogin(res: Response, requestId: string, p: Pending, error?: string, status = 200) {
    const app = esc(p.clientName ?? "An MCP client");
    const redirectUri = p.redirectUri;
    const host = esc(new URL(redirectUri).host);
    res
      .status(status)
      .set({
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      })
      .type("html")
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
label{display:block;margin-top:1rem}input{width:100%;padding:.5rem;font:inherit;box-sizing:border-box}button{margin-top:1.5rem;padding:.6rem 1.2rem;font:inherit}
.who{background:#f3f3f3;padding:.75rem;border-radius:6px}.err{color:#b00020}</style></head><body>
<h1>Sign in to your company account</h1>
<p class="who"><strong>${app}</strong> (a name the app chose for itself; it is not verified) wants to act as you on the store: see your company's catalogue, prices, stock and orders, and save draft quotes. After sign-in you will be sent to <strong>${host}</strong>.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/login"><input type="hidden" name="request" value="${esc(requestId)}">
<label>Email<input name="email" type="email" autocomplete="username" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in and allow</button></form>
<p>Only sign in if you started this from your own AI assistant.</p></body></html>`);
  }

  /** POST /login: check credentials with the store, then send the user back with a one-time code. */
  loginRouter(): Router {
    const router = express.Router();
    router.post("/login", express.urlencoded({ extended: false, limit: "10kb" }), async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const requestId = typeof body.request === "string" ? body.request : "";
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const p = requestId ? await this.store.get<Pending>("pending", requestId) : undefined;
      if (!p) {
        res.status(400).type("text/plain").send("This sign-in request has expired. Start again from your AI assistant.");
        return;
      }
      const failed = async () => {
        // One message for every failure, so the page does not reveal which emails exist.
        // A sign-in request survives only a few failures, so one free /authorize cannot feed unlimited guesses
        // or unlimited counters.
        if ((await this.store.increment("request-failure", requestId, PENDING_TTL_MS)) >= MAX_REQUEST_FAILURES) {
          await this.store.delete("pending", requestId);
        }
        this.renderLogin(res, requestId, p, "Sign-in failed. Check your email and password, and that your account belongs to a company.", 401);
      };
      if (!email || !password || email.length > MAX_EMAIL_LENGTH) return failed();

      // Reserve the attempt before asking the store, so parallel guesses cannot all pass a check-then-increment race.
      // Success clears the address counter; the per-email counter (any address) is left to expire.
      const key = `${req.ip ?? "?"}|${email.toLowerCase()}`;
      const emailKey = `*|${email.toLowerCase()}`;
      const [byAddress, byEmail] = [
        await this.store.increment("failure", key, FAILURE_WINDOW_MS),
        await this.store.increment("failure", emailKey, FAILURE_WINDOW_MS),
      ];
      if (byAddress > MAX_FAILURES || byEmail > MAX_EMAIL_FAILURES) {
        this.renderLogin(res, requestId, p, "Too many failed attempts. Wait 15 minutes and try again.", 429);
        return;
      }
      let user: SignedInUser;
      try {
        user = await this.opts.identity.signIn(email, password);
      } catch {
        return failed();
      }
      await this.store.delete("failure", key);
      // Single use: of two concurrent sign-ins on one request, only the first gets a code.
      if (!(await this.store.take<Pending>("pending", requestId))) {
        void this.signOutWithRetry("(unissued)", user);
        res.status(400).type("text/plain").send("This sign-in request has expired. Start again from your AI assistant.");
        return;
      }
      const code = opaque();
      const c: Code = {
        clientId: p.clientId,
        redirectUri: p.redirectUri,
        challenge: p.codeChallenge,
        resource: p.resource,
        user,
        expiresAt: this.now() + CODE_TTL_MS,
      };
      await this.store.set("code", code, c, CODE_TTL_MS);
      const target = new URL(p.redirectUri);
      target.searchParams.set("code", code);
      if (p.state !== undefined) target.searchParams.set("state", p.state);
      res.redirect(302, target.href);
    });
    return router;
  }

  // ------------------------------------------------------------ tokens

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = await this.store.get<Code>("code", code);
    if (!c || c.clientId !== client.client_id || c.expiresAt < this.now()) throw new InvalidGrantError("Invalid or expired authorization code.");
    return c.challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const c = await this.store.take<Code>("code", code); // single use, even when the exchange fails
    if (!c || c.clientId !== client.client_id || c.expiresAt < this.now()) throw new InvalidGrantError("Invalid or expired authorization code.");
    if (!verifier || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) || !sameChallenge(verifier, c.challenge)) {
      throw new InvalidGrantError("code_verifier does not match the challenge");
    }
    // The authorization request always carries a redirect_uri, so the token request must repeat it exactly.
    if (redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    if (resource && this.resourceFor(resource) !== c.resource) throw new InvalidTargetError("Resource does not match the authorization request.");

    const token = opaque();
    const ttl = this.opts.tokenTtlSeconds;
    const g: Grant = { id: randomUUID(), clientId: client.client_id, user: c.user, resource: c.resource, expiresAt: this.now() + ttl * 1000 };
    const key = hash(token);
    const keep = ttl * 1000 + GRANT_GRACE_MS;
    await this.store.set("token", key, g, keep);
    await this.store.set("grant", g.id, key, keep);
    await this.store.schedule("grant-expiry", g.id, g.expiresAt);
    return { access_token: token, token_type: "bearer", expires_in: ttl, scope: SCOPE };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new InvalidGrantError("Refresh tokens are not issued. Sign in again.");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const g = await this.store.get<Grant>("token", hash(token));
    if (!g || g.expiresAt < this.now()) throw new InvalidTokenError("Invalid or expired access token.");
    return {
      token,
      clientId: g.clientId,
      scopes: [SCOPE],
      expiresAt: Math.floor(g.expiresAt / 1000),
      resource: new URL(g.resource),
      // The customer token is deliberately not here: AuthInfo reaches tool handlers.
      extra: { email: g.user.email, grant_id: g.id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = hash(request.token);
    const g = await this.store.get<Grant>("token", key);
    if (!g || g.clientId !== client.client_id) return; // RFC 7009: unknown tokens are not an error
    await this.store.unschedule("grant-expiry", g.id);
    await this.endGrant(key, g);
  }

  /** The signed-in user behind a live grant (server side only). */
  async userForGrant(grantId: string): Promise<SignedInUser | undefined> {
    const key = await this.store.get<string>("grant", grantId);
    const g = key ? await this.store.get<Grant>("token", key) : undefined;
    return g && g.id === grantId && g.expiresAt >= this.now() ? g.user : undefined;
  }

  private async endGrant(key: string, g: Grant): Promise<void> {
    await this.store.delete("token", key);
    await this.store.delete("grant", g.id);
    this.opts.onGrantEnded?.(g.id);
    void this.signOutWithRetry(g.id, g.user);
  }

  /** Sign the user out at the store, retrying a few times. A final failure is logged (never the token); the store's own expiry is the backstop. */
  private async signOutWithRetry(grantId: string, user: SignedInUser): Promise<void> {
    const delays = this.opts.revokeRetryMs ?? [1_000, 5_000];
    for (let attempt = 0; ; attempt++) {
      try {
        await this.opts.identity.signOut(user);
        return;
      } catch {
        if (attempt >= delays.length) {
          process.stderr.write(`[commerce-b2b-mcp] WARNING could not sign grant ${grantId} out at the store after ${attempt + 1} tries; its store token lives until the store expires it\n`);
          return;
        }
        await new Promise((r) => setTimeout(r, delays[attempt]).unref());
      }
    }
  }

  /**
   * End grants that have expired: sign the user out at the store and close
   * their sessions here. With several instances each grant is claimed by
   * exactly one of them. Codes, sign-in requests and failure counters expire
   * by TTL. Called on a timer.
   */
  async sweep(): Promise<void> {
    if (this.store instanceof MemoryStore) this.store.sweep();
    for (;;) {
      const due = await this.store.claimDue("grant-expiry", this.now(), 100);
      for (const id of due) {
        const key = await this.store.get<string>("grant", id);
        const g = key ? await this.store.get<Grant>("token", key) : undefined;
        if (key && g) await this.endGrant(key, g);
      }
      if (due.length < 100) return;
    }
  }
}
