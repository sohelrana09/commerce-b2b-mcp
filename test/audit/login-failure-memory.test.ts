/**
 * AUDIT PROOF (finding SEC-01). Intentionally FAILS until the finding is fixed.
 *
 * POST /login does not consume the sign-in request on failure and has no rate limit of its own.
 * Every failed attempt for a new email creates a new "failure" counter keyed by `${ip}|${email}`
 * in the memory store (the default), and the memory store only caps the "client" namespace.
 * One sign-in request id, which anyone can get for free from /authorize, therefore lets an
 * unauthenticated caller grow server memory without bound for 15 minutes (the counter TTL).
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer as createNodeServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createHttpApp } from "../../src/http/app.js";
import type { MemoryStore } from "../../src/http/state.js";

const REDIRECT = "http://127.0.0.1:9/callback";

describe("audit: unauthenticated memory growth through /login failure counters", () => {
  const node = createNodeServer();
  let close: () => Promise<void> = async () => undefined;
  afterAll(async () => {
    await close();
    await new Promise((r) => node.close(r));
  });

  it("keeps the number of failure counters bounded no matter how many distinct emails are tried", async () => {
    await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
    const config = loadConfig({
      COMMERCE_BACKEND: "mock",
      COMMERCE_TRANSPORT: "http",
      COMMERCE_PUBLIC_URL: base,
      COMMERCE_MOCK_PASSWORD: "demo-password-123",
      COMMERCE_CONFIRM_SECRET: "test-secret",
    });
    const h = createHttpApp(config);
    node.on("request", h.app);
    close = h.close;

    // Free for anyone: register a loopback client and open /authorize to get one sign-in request id.
    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "x", token_endpoint_auth_method: "none" }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: h.mcpUrl.href,
    });
    const html = await (await fetch(`${base}/authorize?${q}`)).text();
    const request = html.match(/name="request" value="([^"]+)"/)![1]!;

    const ATTEMPTS = 600;
    const padding = "a".repeat(2000); // the body limit is 10 kb, so each email can be large
    for (let i = 0; i < ATTEMPTS; i++) {
      await fetch(`${base}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request, email: `${padding}${i}@example.com`, password: "wrong" }).toString(),
      });
    }

    const failures = (h.provider.store as MemoryStore as unknown as { data: Map<string, Map<string, unknown>> }).data.get("failure");
    // Today this is 600: one counter per distinct email, none evicted, none rate limited.
    expect(failures?.size ?? 0).toBeLessThan(100);
  }, 60_000);
});
