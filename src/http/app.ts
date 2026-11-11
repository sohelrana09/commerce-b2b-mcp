import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createAuditSink, type AuditSink } from "../audit.js";
import { MockBackend } from "../backend/mock/mock-backend.js";
import { PaasBackend } from "../backend/paas/paas-backend.js";
import type { CommerceBackend } from "../backend/types.js";
import type { Config } from "../config.js";
import { createServer } from "../server.js";
import { mockIdentity, paasIdentity } from "./identity.js";
import { CommerceOAuthProvider, SCOPE, type IdentityProvider, type SignedInUser } from "./oauth.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  email: string;
  grantId: string;
  lastSeen: number;
}

export interface HttpAppOptions {
  identity?: IdentityProvider;
  audit?: AuditSink;
  /** Backend shared by all sessions (mock only). PaaS builds one per session from the user's customer token. */
  sharedBackend?: CommerceBackend;
  now?: () => number;
}

const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 500;
const MAX_SESSIONS_PER_USER = 10;

const rpcError = (res: Response, status: number, message: string) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

/**
 * Streamable HTTP transport with OAuth (ADR 11). Each MCP session belongs to
 * one OAuth grant, which belongs to one company user; a session gets its own
 * McpServer whose tools act as that user only (ADR 1).
 */
export function createHttpApp(config: Config, opts: HttpAppOptions = {}) {
  const http = config.http;
  if (!http) throw new Error("HTTP transport is not configured.");
  const now = opts.now ?? Date.now;
  const mcpUrl = new URL("/mcp", http.publicUrl);
  const sessions = new Map<string, Session>();
  const audit = opts.audit ?? createAuditSink(config.auditLog);
  const shared = config.backend === "mock" ? (opts.sharedBackend ?? new MockBackend()) : undefined;

  const closeSession = (id: string) => {
    const s = sessions.get(id);
    sessions.delete(id);
    void s?.transport.close().catch(() => undefined);
  };

  const identity =
    opts.identity ?? (config.backend === "mock" ? mockIdentity(http.mockPassword) : paasIdentity(config.paas!));
  const provider = new CommerceOAuthProvider({
    identity,
    resource: mcpUrl,
    tokenTtlSeconds: http.tokenTtlSeconds,
    redirectHosts: http.redirectHosts,
    onGrantEnded: (grantId) => {
      for (const [id, s] of sessions) if (s.grantId === grantId) closeSession(id);
    },
    now,
  });

  const backendFor = (user: SignedInUser): CommerceBackend => {
    if (shared) return shared;
    if (!config.paas || !user.customerToken) throw new Error("No customer token for this session.");
    return new PaasBackend({
      ...config.paas,
      auth: { kind: "static", token: user.customerToken, expiredHint: "Your store session has ended. Reconnect and sign in again." },
    });
  };

  const local = ["localhost", "127.0.0.1", "[::1]"];
  const app: Express = createMcpExpressApp({
    host: http.host,
    allowedHosts: [...new Set([http.publicUrl.hostname, ...(local.includes(http.publicUrl.hostname) ? local : [])])],
  });
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: http.publicUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: "Adobe Commerce B2B (company user)",
    }),
  );
  app.use(provider.loginRouter());

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });

  app.all("/mcp", bearer, async (req: Request, res: Response) => {
    const email = String(req.auth!.extra!.email);
    const grantId = String(req.auth!.extra!.grant_id);
    const sid = req.header("mcp-session-id");

    if (sid) {
      const s = sessions.get(sid);
      if (!s) return void rpcError(res, 404, "Session not found. Start a new session.");
      // A session is never shared between users, whatever token arrives with its id.
      if (s.email.toLowerCase() !== email.toLowerCase()) return void rpcError(res, 403, "This session belongs to another user.");
      if (s.grantId !== grantId) {
        // Same user, new sign-in: the old session holds the old store token. Make the client start over.
        closeSession(sid);
        return void rpcError(res, 404, "Session ended after a new sign-in. Start a new session.");
      }
      s.lastSeen = now();
      await s.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(req.body)) {
      return void rpcError(res, 400, "No session. Send an initialize request first.");
    }
    const user = provider.userForGrant(grantId);
    if (!user) return void rpcError(res, 401, "Sign-in has ended. Sign in again.");
    const mine = [...sessions.values()].filter((s) => s.grantId === grantId).length;
    if (sessions.size >= MAX_SESSIONS || mine >= MAX_SESSIONS_PER_USER) {
      return void rpcError(res, 503, "Too many open sessions. Close one and try again.");
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, email: user.email, grantId, lastSeen: now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const { server } = createServer({ ...config, callerEmail: user.email }, { backend: backendFor(user), audit });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const sweep = () => {
    provider.sweep();
    for (const [id, s] of sessions) if (now() - s.lastSeen > IDLE_MS) closeSession(id);
  };
  const timer = setInterval(sweep, 60_000);
  timer.unref();

  return {
    app,
    provider,
    sessions,
    mcpUrl,
    sweep,
    async close() {
      clearInterval(timer);
      for (const id of [...sessions.keys()]) closeSession(id);
    },
  };
}
