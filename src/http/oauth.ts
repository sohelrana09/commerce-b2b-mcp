import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Response, type Router } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

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

interface Pending {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  resource: string;
  expiresAt: number;
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
  /** Called when a grant ends (revoked or expired) so its MCP sessions can be closed. */
  onGrantEnded?: (grantId: string) => void;
  now?: () => number;
}

const CODE_TTL_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
 * the client signs in again. State is in memory, so this is one instance only.
 */
export class CommerceOAuthProvider implements OAuthServerProvider {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, Code>();
  private readonly tokens = new Map<string, Grant>();
  private readonly failures = new Map<string, { count: number; since: number }>();
  private readonly now: () => number;

  constructor(private readonly opts: ProviderOptions) {
    this.now = opts.now ?? Date.now;
  }

  // ------------------------------------------------------------ clients

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.clients.get(id),
      registerClient: (meta) => {
        for (const uri of meta.redirect_uris) this.checkRedirect(String(uri));
        if (this.clients.size >= MAX_CLIENTS) {
          // Forget the oldest registration; its user can register again.
          this.clients.delete(this.clients.keys().next().value!);
        }
        const client: OAuthClientInformationFull = {
          ...meta,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(this.now() / 1000),
        };
        this.clients.set(client.client_id, client);
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
    this.pending.set(id, { client, params, resource, expiresAt: this.now() + PENDING_TTL_MS });
    this.renderLogin(res, id, client, params.redirectUri);
  }

  private renderLogin(res: Response, requestId: string, client: OAuthClientInformationFull, redirectUri: string, error?: string, status = 200) {
    const app = esc(client.client_name ?? "An MCP client");
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
<p class="who"><strong>${app}</strong> wants to act as you on the store: see your company's catalogue, prices, stock and orders, and save draft quotes. After sign-in you will be sent to <strong>${host}</strong>.</p>
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
      const p = this.pending.get(requestId);
      if (!p || p.expiresAt < this.now()) {
        this.pending.delete(requestId);
        res.status(400).type("text/plain").send("This sign-in request has expired. Start again from your AI assistant.");
        return;
      }
      const key = `${req.ip ?? "?"}|${email.toLowerCase()}`;
      if (this.tooManyFailures(key)) {
        this.renderLogin(res, requestId, p.client, p.params.redirectUri, "Too many failed attempts. Wait 15 minutes and try again.", 429);
        return;
      }
      let user: SignedInUser;
      try {
        if (!email || !password) throw new Error("missing");
        user = await this.opts.identity.signIn(email, password);
      } catch {
        this.recordFailure(key);
        // One message for every failure, so the page does not reveal which emails exist.
        this.renderLogin(res, requestId, p.client, p.params.redirectUri, "Sign-in failed. Check your email and password, and that your account belongs to a company.", 401);
        return;
      }
      this.failures.delete(key);
      this.pending.delete(requestId);
      const code = opaque();
      this.codes.set(code, {
        clientId: p.client.client_id,
        redirectUri: p.params.redirectUri,
        challenge: p.params.codeChallenge,
        resource: p.resource,
        user,
        expiresAt: this.now() + CODE_TTL_MS,
      });
      const target = new URL(p.params.redirectUri);
      target.searchParams.set("code", code);
      if (p.params.state !== undefined) target.searchParams.set("state", p.params.state);
      res.redirect(302, target.href);
    });
    return router;
  }

  private tooManyFailures(key: string): boolean {
    const f = this.failures.get(key);
    if (!f) return false;
    if (this.now() - f.since > FAILURE_WINDOW_MS) {
      this.failures.delete(key);
      return false;
    }
    return f.count >= MAX_FAILURES;
  }

  private recordFailure(key: string): void {
    const f = this.failures.get(key);
    if (!f || this.now() - f.since > FAILURE_WINDOW_MS) this.failures.set(key, { count: 1, since: this.now() });
    else f.count++;
  }

  // ------------------------------------------------------------ tokens

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.codes.get(code);
    if (!c || c.clientId !== client.client_id || c.expiresAt < this.now()) throw new InvalidGrantError("Invalid or expired authorization code.");
    return c.challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const c = this.codes.get(code);
    this.codes.delete(code); // single use, even when the exchange fails
    if (!c || c.clientId !== client.client_id || c.expiresAt < this.now()) throw new InvalidGrantError("Invalid or expired authorization code.");
    if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    if (resource && this.resourceFor(resource) !== c.resource) throw new InvalidTargetError("Resource does not match the authorization request.");

    const token = opaque();
    const ttl = this.opts.tokenTtlSeconds;
    this.tokens.set(hash(token), {
      id: randomUUID(),
      clientId: client.client_id,
      user: c.user,
      resource: c.resource,
      expiresAt: this.now() + ttl * 1000,
    });
    return { access_token: token, token_type: "bearer", expires_in: ttl, scope: SCOPE };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new InvalidGrantError("Refresh tokens are not issued. Sign in again.");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const g = this.tokens.get(hash(token));
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
    const g = this.tokens.get(key);
    if (!g || g.clientId !== client.client_id) return; // RFC 7009: unknown tokens are not an error
    this.endGrant(key, g);
  }

  /** The signed-in user behind a live grant (server side only). */
  userForGrant(grantId: string): SignedInUser | undefined {
    for (const g of this.tokens.values()) if (g.id === grantId && g.expiresAt >= this.now()) return g.user;
    return undefined;
  }

  private endGrant(key: string, g: Grant): void {
    this.tokens.delete(key);
    this.opts.onGrantEnded?.(g.id);
    void this.opts.identity.signOut(g.user).catch(() => undefined);
  }

  /** Drop expired codes, sign-in requests, failure counters and grants. Called on a timer. */
  sweep(): void {
    const now = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
    for (const [k, v] of this.failures) if (now - v.since > FAILURE_WINDOW_MS) this.failures.delete(k);
    for (const [k, g] of this.tokens) if (g.expiresAt < now) this.endGrant(k, g);
  }
}
