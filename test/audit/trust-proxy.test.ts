/** Regression for SEC-03: behind a proxy, rate limits and lockout are per client, not per proxy. */
import { createServer as createNodeServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createHttpApp } from "../../src/http/app.js";

async function run(trust: string | undefined) {
  const node = createNodeServer();
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
  const h = createHttpApp(
    loadConfig({
      COMMERCE_BACKEND: "mock",
      COMMERCE_TRANSPORT: "http",
      COMMERCE_PUBLIC_URL: base,
      COMMERCE_MOCK_PASSWORD: "demo-password-123",
      COMMERCE_CONFIRM_SECRET: "s",
      ...(trust === undefined ? {} : { COMMERCE_TRUST_PROXY: trust }),
    }),
  );
  node.on("request", h.app);
  const token = (xff: string) =>
    fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": xff },
      body: "grant_type=authorization_code&code=x&code_verifier=y&client_id=nope",
    });
  try {
    for (let i = 0; i < 55; i++) await token("10.0.0.1");
    return (await token("10.0.0.2")).status;
  } finally {
    await h.close();
    await new Promise((r) => node.close(r));
  }
}

describe("trust proxy", () => {
  it("gives each forwarded client its own /token rate-limit bucket when one proxy is trusted", async () => {
    expect(await run("1")).not.toBe(429);
  });
  it("ignores X-Forwarded-For by default (a client cannot pick its own bucket)", async () => {
    expect(await run(undefined)).toBe(429);
  });
  it("rejects a bad setting", () => {
    expect(() => loadConfig({ COMMERCE_BACKEND: "mock", COMMERCE_TRANSPORT: "http", COMMERCE_MOCK_PASSWORD: "demo-password-123", COMMERCE_TRUST_PROXY: "yes" })).toThrow(/COMMERCE_TRUST_PROXY/);
  });
});
