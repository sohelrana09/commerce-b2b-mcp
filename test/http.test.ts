import { createHash, randomBytes } from "node:crypto";
import { createServer as createNodeServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { memoryAuditSink } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http/app.js";
import { paasIdentity } from "../src/http/identity.js";
import { companyContextReply, fakeStore, JANE } from "./fake-store.js";

const PASSWORD = "demo-password-123";
const SAM = "sam.purchasing@harbour.example";
const REDIRECT = "http://127.0.0.1:9/callback";

let servers: Server[] = [];
let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers) await c();
  for (const s of servers) await new Promise((r) => s.close(r));
  servers = [];
  closers = [];
});

/** Start the HTTP app on a free port with the mock backend. */
async function start(env: Record<string, string> = {}) {
  const node = createNodeServer();
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
  servers.push(node);
  const port = (node.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    COMMERCE_BACKEND: "mock",
    COMMERCE_TRANSPORT: "http",
    COMMERCE_PUBLIC_URL: base,
    COMMERCE_MOCK_PASSWORD: PASSWORD,
    COMMERCE_CONFIRM_SECRET: "test-secret",
    ...env,
  });
  const audit = memoryAuditSink();
  const h = createHttpApp(config, { audit });
  node.on("request", h.app);
  closers.push(h.close);
  return { base, audit, ...h };
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function register(base: string, redirect = REDIRECT) {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: "Test <Client>", token_endpoint_auth_method: "none" }),
  });
  return { status: res.status, body: (await res.json()) as { client_id: string; error?: string } };
}

/** Run the browser part of the flow: authorize, show the form, post credentials. */
async function signIn(base: string, clientId: string, email: string, password: string, mcpUrl: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    resource: mcpUrl,
  });
  const page = await fetch(`${base}/authorize?${q}`);
  const html = await page.text();
  const request = html.match(/name="request" value="([^"]+)"/)?.[1];
  if (!request) throw new Error(`no login form: ${page.status} ${html.slice(0, 200)}`);
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ request, email, password }),
  });
  return { html, login, verifier, request };
}

async function tokenFor(base: string, mcpUrl: string, email = SAM) {
  const { body } = await register(base);
  const { login, verifier } = await signIn(base, body.client_id, email, PASSWORD, mcpUrl);
  const loc = new URL(login.headers.get("location")!);
  const code = loc.searchParams.get("code")!;
  const exchange = () =>
    fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: body.client_id, redirect_uri: REDIRECT, resource: mcpUrl }),
    });
  const res = await exchange();
  const tok = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  return { token: tok.access_token, tok, clientId: body.client_id, loc, exchange };
}

async function mcpClient(mcpUrl: URL, token: string) {
  const transport = new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(transport);
  closers.push(() => client.close());
  return { client, transport };
}

describe("HTTP transport with OAuth", () => {
  it("publishes protected-resource and authorization-server metadata", async () => {
    const { base, mcpUrl } = await start();
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(mcpUrl.href);
    expect(prm.authorization_servers).toEqual([`${base}/`]);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.scopes_supported).toEqual(["commerce"]);
  });

  it("rejects /mcp without a token and points the client at the metadata", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("signs a company user in and scopes every tool call to them, with a trace in the audit log", async () => {
    const { base, mcpUrl, audit } = await start();
    const { token, tok, clientId, loc } = await tokenFor(base, mcpUrl.href);
    expect(loc.searchParams.get("state")).toBe("st-1");
    expect(tok.expires_in).toBe(3600);
    expect(tok.refresh_token).toBeUndefined();

    const { client, transport } = await mcpClient(mcpUrl, token);
    const res = await client.callTool({ name: "get_company_context", arguments: {} });
    const data = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    expect(data.user.email).toBe(SAM);
    expect(data.company_id).toBe("CO-3003");
    expect((res._meta as { trace_id: string }).trace_id).toMatch(/^[0-9a-f-]{36}$/);

    const entry = audit.entries.at(-1)!;
    expect(entry).toMatchObject({ caller: SAM, company_id: "CO-3003", tool: "get_company_context", client_id: clientId, session_id: transport.sessionId });
    expect(entry.trace_id).toBe((res._meta as { trace_id: string }).trace_id);
  });

  it("escapes the client name on the sign-in page and sets no-framing headers", async () => {
    const { base, mcpUrl } = await start();
    const { body } = await register(base);
    const { html } = await signIn(base, body.client_id, SAM, "wrong", mcpUrl.href);
    expect(html).toContain("Test &lt;Client&gt;");
    expect(html).not.toContain("Test <Client>");
    const page = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: body.client_id, redirect_uri: REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("refuses wrong passwords and non-company emails with one message, and locks out after five failures", async () => {
    const { base, mcpUrl } = await start();
    const { body } = await register(base);
    const bad = await signIn(base, body.client_id, SAM, "wrong-password", mcpUrl.href);
    expect(bad.login.status).toBe(401);
    expect(bad.login.headers.get("location")).toBeNull();
    const unknown = await signIn(base, body.client_id, "nobody@example.com", PASSWORD, mcpUrl.href);
    expect(await unknown.login.text()).toContain("Sign-in failed");

    for (let i = 0; i < 4; i++) await signIn(base, body.client_id, SAM, "wrong-password", mcpUrl.href);
    const locked = await signIn(base, body.client_id, SAM, PASSWORD, mcpUrl.href);
    expect(locked.login.status).toBe(429);
  });

  it("only lets clients register loopback or configured redirect hosts", async () => {
    const { base } = await start({ COMMERCE_OAUTH_REDIRECT_HOSTS: "claude.ai" });
    expect((await register(base, "https://evil.example/cb")).status).toBe(400);
    expect((await register(base, "http://claude.ai/cb")).status).toBe(400); // https only for non-loopback
    expect((await register(base, "https://claude.ai/api/mcp/auth_callback")).status).toBe(201);
  });

  it("uses each authorization code once", async () => {
    const { base, mcpUrl } = await start();
    const { exchange } = await tokenFor(base, mcpUrl.href);
    const again = await exchange();
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refuses another user's token on an existing session", async () => {
    const { base, mcpUrl } = await start();
    const sam = await tokenFor(base, mcpUrl.href, SAM);
    const jane = await tokenFor(base, mcpUrl.href, JANE);
    const { transport } = await mcpClient(mcpUrl, sam.token);
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jane.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": transport.sessionId!,
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_company_context", arguments: {} } }),
    });
    expect(res.status).toBe(403);
  });

  it("revokes a token, ends its sessions, and rejects it afterwards", async () => {
    const { base, mcpUrl, sessions } = await start();
    const { token, clientId } = await tokenFor(base, mcpUrl.href);
    await mcpClient(mcpUrl, token);
    expect(sessions.size).toBe(1);
    const rev = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ token, client_id: clientId }),
    });
    expect(rev.status).toBe(200);
    expect(sessions.size).toBe(0);
    const res = await fetch(mcpUrl, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("rejects a Host header that is not the public host (DNS rebinding)", async () => {
    const { base } = await start();
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}/healthz`);
      request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: "attacker.example" } }, (r) => resolve(r.statusCode!))
        .on("error", reject)
        .end();
    });
    expect(status).toBe(403);
  });
});

describe("HTTP config", () => {
  const base = { COMMERCE_BACKEND: "mock", COMMERCE_TRANSPORT: "http", COMMERCE_MOCK_PASSWORD: PASSWORD };
  it("refuses a fixed identity over HTTP", () => {
    expect(() => loadConfig({ ...base, COMMERCE_CALLER_EMAIL: SAM })).toThrow(/Unset COMMERCE_CALLER_EMAIL/);
  });
  it("requires https for a public URL that is not localhost", () => {
    expect(() => loadConfig({ ...base, COMMERCE_PUBLIC_URL: "http://mcp.example.com" })).toThrow(/https/);
    expect(loadConfig({ ...base, COMMERCE_PUBLIC_URL: "https://mcp.example.com" }).http!.publicUrl.host).toBe("mcp.example.com");
  });
  it("caps the token lifetime at an hour and requires a demo password for mock", () => {
    expect(loadConfig({ ...base, COMMERCE_HTTP_TOKEN_TTL_SECONDS: "86400" }).http!.tokenTtlSeconds).toBe(3600);
    expect(() => loadConfig({ COMMERCE_BACKEND: "mock", COMMERCE_TRANSPORT: "http" })).toThrow(/COMMERCE_MOCK_PASSWORD/);
  });
  it("does not need customer credentials for paas over HTTP", () => {
    const c = loadConfig({ COMMERCE_BACKEND: "paas", COMMERCE_TRANSPORT: "http", COMMERCE_BASE_URL: "https://store.example.com", COMMERCE_CONFIRM_SECRET: "x".repeat(32) });
    expect(c.paas!.auth).toBeUndefined();
  });
});

describe("PaaS sign-in", () => {
  const opts = (store: ReturnType<typeof fakeStore>) => ({ baseUrl: "https://store.example.com", fetch: store.fetch });

  it("returns the store's customer token for an active company user", async () => {
    const store = fakeStore({
      Login: (v) => ({ body: { data: { generateCustomerToken: { token: `tok-for-${String(v.email)}` } } } }),
      CompanyContext: () => companyContextReply(),
      CompanyCredit: () => ({ body: { data: { company: null } } }),
    });
    const user = await paasIdentity(opts(store)).signIn(JANE, "pw");
    expect(user).toEqual({ email: JANE, customerToken: `tok-for-${JANE}` });
    expect(store.calls[1]!.headers.Authorization).toBe(`Bearer tok-for-${JANE}`);
  });

  it("revokes the token and refuses when the user is not in a company", async () => {
    const store = fakeStore({
      Login: () => ({ body: { data: { generateCustomerToken: { token: "t1" } } } }),
      CompanyContext: () => ({ body: { data: { customer: { email: JANE, firstname: "J", lastname: "O", job_title: null, status: "ACTIVE", role: null }, company: null } } }),
      anonymous: () => ({ body: { data: { revokeCustomerToken: { result: true } } } }),
    });
    await expect(paasIdentity(opts(store)).signIn(JANE, "pw")).rejects.toThrow(/not a member/);
    expect(store.calls.at(-1)).toMatchObject({ op: "anonymous", headers: { Authorization: "Bearer t1" } });
  });

  it("refuses bad credentials", async () => {
    const store = fakeStore({ Login: () => ({ body: { errors: [{ message: "The account sign-in was incorrect", extensions: { category: "graphql-authentication" } }] } }) });
    await expect(paasIdentity(opts(store)).signIn(JANE, "bad")).rejects.toThrow(/rejected/);
  });
});
