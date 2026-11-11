/** Regression for SEC-02: parallel wrong passwords must not get past the 5-failure lockout. */
import { createHash, randomBytes } from "node:crypto";
import { createServer as createNodeServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createHttpApp } from "../../src/http/app.js";

it("lets at most five parallel guesses for one email reach the store", async () => {
  const node = createNodeServer();
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
  let calls = 0;
  const identity = {
    signIn: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 100));
      throw new Error("no");
    },
    signOut: async () => {},
  };
  const h = createHttpApp(
    loadConfig({ COMMERCE_BACKEND: "mock", COMMERCE_TRANSPORT: "http", COMMERCE_PUBLIC_URL: base, COMMERCE_MOCK_PASSWORD: "demo-password-123", COMMERCE_CONFIRM_SECRET: "s" }),
    { identity },
  );
  node.on("request", h.app);
  try {
    const reg = (await (
      await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9/cb"], token_endpoint_auth_method: "none" }),
      })
    ).json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: "http://127.0.0.1:9/cb",
      code_challenge: createHash("sha256").update(randomBytes(32)).digest("base64url"),
      code_challenge_method: "S256",
      resource: h.mcpUrl.href,
    });
    const request = (await (await fetch(`${base}/authorize?${q}`)).text()).match(/name="request" value="([^"]+)"/)![1]!;
    const rs = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        fetch(`${base}/login`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ request, email: "victim@example.com", password: `guess${i}` }).toString(),
        }),
      ),
    );
    expect(calls).toBeLessThanOrEqual(5);
    expect(rs.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(40);
  } finally {
    await h.close();
    await new Promise((r) => node.close(r));
  }
});
