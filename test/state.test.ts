import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { MemoryStore, RedisStore, type StateStore } from "../src/http/state.js";

/**
 * One contract for both stores. The Redis half runs when
 * COMMERCE_TEST_REDIS_URL points at a disposable Redis (CI starts one);
 * otherwise it is skipped.
 */
const REDIS_URL = process.env.COMMERCE_TEST_REDIS_URL;
const SECRET = "test-state-key-0123456789abcdef-0123";
const opened: StateStore[] = [];
afterAll(async () => {
  for (const s of opened) await s.close();
});

const redisStore = (secret = SECRET, prefix = `test:${randomUUID()}:`) => {
  const s = new RedisStore({ url: REDIS_URL!, secret, prefix });
  opened.push(s);
  return s;
};

const stores: Array<[string, () => StateStore, boolean]> = [
  ["memory", () => new MemoryStore(), true],
  ["redis", () => redisStore(), Boolean(REDIS_URL)],
];

for (const [name, make, enabled] of stores) {
  describe.skipIf(!enabled)(`${name} state store`, () => {
    it("stores JSON values until their TTL", async () => {
      const s = make();
      await s.ready();
      await s.set("grant", "a", { email: "sam@harbour.example", n: 1 }, 60_000);
      expect(await s.get("grant", "a")).toEqual({ email: "sam@harbour.example", n: 1 });
      await s.set("grant", "short", 1, 30);
      await new Promise((r) => setTimeout(r, 60));
      expect(await s.get("grant", "short")).toBeUndefined();
      await s.delete("grant", "a");
      expect(await s.get("grant", "a")).toBeUndefined();
    });

    it("hands a taken value to exactly one of several concurrent callers", async () => {
      const s = make();
      await s.set("code", "c1", { user: "sam" }, 60_000);
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => s.take("code", "c1")));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("counts within a window that starts at the first increment", async () => {
      const s = make();
      expect(await s.count("failure", "ip|sam")).toBe(0);
      for (let i = 0; i < 4; i++) await s.increment("failure", "ip|sam", 60_000);
      expect(await s.increment("failure", "ip|sam", 60_000)).toBe(5);
      expect(await s.count("failure", "ip|sam")).toBe(5);
      await s.increment("failure", "short", 30);
      await new Promise((r) => setTimeout(r, 60));
      expect(await s.count("failure", "short")).toBe(0);
    });

    it("claims each due member once, in due order, and never one that is not due", async () => {
      const s = make();
      await s.schedule("grant-expiry", "late", 3_000);
      await s.schedule("grant-expiry", "b", 2_000);
      await s.schedule("grant-expiry", "a", 1_000);
      await s.schedule("grant-expiry", "gone", 1_500);
      await s.unschedule("grant-expiry", "gone");
      const [x, y] = await Promise.all([s.claimDue("grant-expiry", 2_500, 10), s.claimDue("grant-expiry", 2_500, 10)]);
      expect([...x, ...y].sort()).toEqual(["a", "b"]);
      expect(await s.claimDue("grant-expiry", 2_500, 10)).toEqual([]);
      expect(await s.claimDue("grant-expiry", 3_000, 10)).toEqual(["late"]);
    });
  });
}

describe("memory state store", () => {
  it("keeps at most the configured number of entries per namespace, dropping the oldest", async () => {
    const s = new MemoryStore({ maxEntries: { client: 2 } });
    await s.set("client", "1", 1, 60_000);
    await s.set("client", "2", 2, 60_000);
    await s.set("client", "3", 3, 60_000);
    expect(await s.get("client", "1")).toBeUndefined();
    expect(await s.get("client", "3")).toBe(3);
  });
});

describe.skipIf(!REDIS_URL)("redis state store at rest", () => {
  it("keeps no readable id, email or token in Redis, and binds each value to its key", async () => {
    const prefix = `test:${randomUUID()}:`;
    const s = redisStore(SECRET, prefix);
    await s.set("token", "access-token-hash-xyz", { email: "sam.purchasing@harbour.example", customerToken: "magento-secret" }, 60_000);

    const raw = new Redis(REDIS_URL!);
    try {
      const keys = await raw.keys(`${prefix}*`);
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toContain("access-token-hash-xyz");
      const value = (await raw.get(keys[0]!))!;
      expect(value).not.toContain("harbour");
      expect(Buffer.from(value, "base64").toString("latin1")).not.toContain("magento-secret");

      // A value copied under another key does not decrypt.
      await s.set("token", "other", "x", 60_000);
      const other = (await raw.keys(`${prefix}*`)).find((k) => k !== keys[0])!;
      await raw.set(other, value, "PX", 60_000);
      expect(await s.get("token", "other")).toBeUndefined();
    } finally {
      raw.disconnect();
    }

    // Another COMMERCE_STATE_KEY cannot read it.
    expect(await redisStore("another-state-key-0123456789abcdef", prefix).get("token", "access-token-hash-xyz")).toBeUndefined();
    expect(await s.get("token", "access-token-hash-xyz")).toMatchObject({ customerToken: "magento-secret" });
  });

  it("reports an unreachable Redis with a plain message that does not echo the URL", async () => {
    const s = new RedisStore({ url: "redis://:hunter2-password@127.0.0.1:1", secret: SECRET, prefix: "x:" });
    opened.push(s);
    const err = await s.ready().then(() => undefined, (e: Error) => e);
    expect(err?.message).toContain("Cannot reach the Redis state store");
    expect(err?.message).not.toContain("hunter2");
  });
});
