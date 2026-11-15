import { createServer as createNodeServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http/app.js";
import { MemoryStore } from "../src/http/state.js";
import { createVercelHandler, NOT_CONFIGURED, serverlessConfig } from "../src/vercel.js";

const VERCEL_ENV = {
  COMMERCE_BACKEND: "mock",
  COMMERCE_PUBLIC_URL: "https://mcp.example.com",
  COMMERCE_MOCK_PASSWORD: "demo-password-123",
  COMMERCE_HTTP_SESSIONS: "stateless",
  COMMERCE_STATE_STORE: "redis",
  COMMERCE_REDIS_URL: "rediss://:pw@redis.example.com:6380",
  COMMERCE_STATE_KEY: "test-state-key-0123456789abcdef-0123",
};

let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  servers = [];
  vi.restoreAllMocks();
});

async function serve(handler: ReturnType<typeof createVercelHandler>) {
  const node = createNodeServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
  servers.push(node);
  return `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
}

describe("serverlessConfig", () => {
  it("accepts stateless mode with Redis over https, and defaults the transport to http", () => {
    const config = serverlessConfig(VERCEL_ENV);
    expect(config.transport).toBe("http");
    expect(config.http?.sessions).toBe("stateless");
    expect(config.http?.state.kind).toBe("redis");
  });

  it("refuses stateful sessions", () => {
    expect(() => serverlessConfig({ ...VERCEL_ENV, COMMERCE_HTTP_SESSIONS: "stateful" })).toThrow(/COMMERCE_HTTP_SESSIONS=stateless/);
  });

  it("refuses in-memory sign-in state", () => {
    const { COMMERCE_REDIS_URL: _u, COMMERCE_STATE_KEY: _k, ...env } = VERCEL_ENV;
    expect(() => serverlessConfig({ ...env, COMMERCE_STATE_STORE: "memory" })).toThrow(/COMMERCE_STATE_STORE=redis/);
  });

  it("refuses a fixed identity shared by every client", () => {
    expect(() => serverlessConfig({ ...VERCEL_ENV, COMMERCE_CALLER_EMAIL: "jane.buyer@northwind.example" })).toThrow(/OAuth/);
  });
});

describe("createVercelHandler", () => {
  it("answers 503 without details when misconfigured, logs why, and retries on the next request", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const base = await serve(createVercelHandler({ COMMERCE_BACKEND: "mock" }));
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/mcp`, { method: "POST" });
      expect(res.status).toBe(503);
      expect(await res.text()).toBe(NOT_CONFIGURED);
    }
    const logged = stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("not started"));
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatch(/COMMERCE_/);
  });

  it("serves the app built once for every path", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const builds = vi.fn();
    let base = "";
    const handler = createVercelHandler(
      {},
      {
        // Locally: http on a loopback port and an in-memory store stand in for the deployment's https and Redis.
        configure: () =>
          loadConfig({
            COMMERCE_BACKEND: "mock",
            COMMERCE_TRANSPORT: "http",
            COMMERCE_PUBLIC_URL: base,
            COMMERCE_MOCK_PASSWORD: "demo-password-123",
            COMMERCE_HTTP_SESSIONS: "stateless",
          }),
        build: (config) => {
          builds();
          return createHttpApp(config, { store: new MemoryStore() });
        },
      },
    );
    base = await serve(handler);

    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const meta = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(meta.status).toBe(200);
    expect((await meta.json()).resource).toBe(`${base}/mcp`);
    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(401);
    expect(builds).toHaveBeenCalledTimes(1);
  });
});
