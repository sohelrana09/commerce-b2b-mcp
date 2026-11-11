import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { Redis } from "ioredis";

/**
 * Where the HTTP transport keeps its sign-in state: registered OAuth clients,
 * sign-in requests, authorization codes, access-token grants and sign-in
 * failure counters (ADR 19).
 *
 * With the memory store, one server instance holds it all. With Redis,
 * several instances share it: a client can register on one, sign in on
 * another and call /mcp on a third. Every operation is async so the two are
 * interchangeable; every value is JSON, so nothing a caller holds can change
 * a stored entry by accident.
 */
export interface StateStore {
  readonly kind: "memory" | "redis";
  get<T>(ns: string, key: string): Promise<T | undefined>;
  set(ns: string, key: string, value: unknown, ttlMs: number): Promise<void>;
  /** Read and delete in one step. Of two concurrent callers, only one gets the value. */
  take<T>(ns: string, key: string): Promise<T | undefined>;
  delete(ns: string, key: string): Promise<void>;
  /** Add one to a counter that expires `windowMs` after its first increment. Returns the new count. */
  increment(ns: string, key: string, windowMs: number): Promise<number>;
  /** The current value of a counter written by `increment`, or 0. */
  count(ns: string, key: string): Promise<number>;
  /** Remember that `member` falls due at `at` (ms). Scheduling again moves it. */
  schedule(ns: string, member: string, at: number): Promise<void>;
  unschedule(ns: string, member: string): Promise<void>;
  /** Members due by `now`, removed from the schedule. Each member is handed to exactly one caller. */
  claimDue(ns: string, now: number, limit: number): Promise<string[]>;
  /** Resolves once the store can be used; rejects with a plain message if it can't. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

// ------------------------------------------------------------------ memory

export interface MemoryStoreOptions {
  now?: () => number;
  /** Most entries kept per namespace; the oldest is dropped beyond it. Bounds memory against mass registration. */
  maxEntries?: Record<string, number>;
}

/** One instance only. Also the reference behaviour the Redis store is tested against. */
export class MemoryStore implements StateStore {
  readonly kind = "memory" as const;
  private readonly data = new Map<string, Map<string, { json: string; expiresAt: number }>>();
  private readonly schedules = new Map<string, Map<string, number>>();
  private readonly now: () => number;

  constructor(private readonly opts: MemoryStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  private ns(ns: string) {
    let m = this.data.get(ns);
    if (!m) this.data.set(ns, (m = new Map()));
    return m;
  }

  private live(ns: string, key: string) {
    const m = this.ns(ns);
    const e = m.get(key);
    if (e && e.expiresAt <= this.now()) {
      m.delete(key);
      return undefined;
    }
    return e;
  }

  async get<T>(ns: string, key: string): Promise<T | undefined> {
    const e = this.live(ns, key);
    return e ? (JSON.parse(e.json) as T) : undefined;
  }

  async set(ns: string, key: string, value: unknown, ttlMs: number): Promise<void> {
    const m = this.ns(ns);
    m.delete(key); // re-insert so insertion order is age order
    const max = this.opts.maxEntries?.[ns];
    if (max !== undefined && m.size >= max) {
      for (const [k, e] of m) if (e.expiresAt <= this.now()) m.delete(k);
      while (m.size >= max) m.delete(m.keys().next().value!);
    }
    m.set(key, { json: JSON.stringify(value), expiresAt: this.now() + ttlMs });
  }

  async take<T>(ns: string, key: string): Promise<T | undefined> {
    // No await between the read and the delete, so concurrent callers cannot both read it.
    const e = this.live(ns, key);
    this.ns(ns).delete(key);
    return e ? (JSON.parse(e.json) as T) : undefined;
  }

  async delete(ns: string, key: string): Promise<void> {
    this.ns(ns).delete(key);
  }

  async increment(ns: string, key: string, windowMs: number): Promise<number> {
    const e = this.live(ns, key);
    const count = e ? (JSON.parse(e.json) as number) + 1 : 1;
    this.ns(ns).set(key, { json: JSON.stringify(count), expiresAt: e ? e.expiresAt : this.now() + windowMs });
    return count;
  }

  async count(ns: string, key: string): Promise<number> {
    return (await this.get<number>(ns, key)) ?? 0;
  }

  private schedule_(ns: string) {
    let m = this.schedules.get(ns);
    if (!m) this.schedules.set(ns, (m = new Map()));
    return m;
  }

  async schedule(ns: string, member: string, at: number): Promise<void> {
    this.schedule_(ns).set(member, at);
  }

  async unschedule(ns: string, member: string): Promise<void> {
    this.schedule_(ns).delete(member);
  }

  async claimDue(ns: string, now: number, limit: number): Promise<string[]> {
    const m = this.schedule_(ns);
    const due = [...m].filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([k]) => k);
    for (const k of due) m.delete(k);
    return due;
  }

  /** Drop expired entries. Reads already ignore them; this only frees memory. */
  sweep(): void {
    const now = this.now();
    for (const m of this.data.values()) for (const [k, e] of m) if (e.expiresAt <= now) m.delete(k);
  }

  async ready(): Promise<void> {}
  async close(): Promise<void> {}
}

// ------------------------------------------------------------------ redis

export interface RedisStoreOptions {
  url: string;
  /** 32+ characters. Every value is encrypted with a key derived from it (AES-256-GCM). */
  secret: string;
  /** Prefix for every key, so one Redis can serve several deployments. */
  prefix: string;
  /** For tests: an already-created client. */
  client?: Redis;
  /** For tests: the clock used to check the expiry sealed into each value. */
  now?: () => number;
}

const INCREMENT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

/**
 * Shared state in Redis for running more than one instance.
 *
 * Values hold Magento customer tokens, so they are encrypted with AES-256-GCM
 * and bound to their key (a value copied to another key does not decrypt).
 * Keys are SHA-256 hashes of the real ids, so a Redis dump or `MONITOR`
 * shows no usable code, token or email address. TTLs are Redis's own, so
 * nothing outlives its lifetime even if every instance stops.
 */
export class RedisStore implements StateStore {
  readonly kind = "redis" as const;
  private readonly redis: Redis;
  private readonly key: Buffer;
  /** Keys the hashing of ids, separately from the encryption key. */
  private readonly macKey: Buffer;
  private readonly prefix: string;
  private readonly now: () => number;

  constructor(opts: RedisStoreOptions) {
    this.key = createHash("sha256").update("commerce-b2b-mcp state v1\0").update(opts.secret).digest();
    this.macKey = createHash("sha256").update("commerce-b2b-mcp state keys v2\0").update(opts.secret).digest();
    this.now = opts.now ?? Date.now;
    this.prefix = opts.prefix;
    this.redis =
      opts.client ??
      new Redis(opts.url, {
        lazyConnect: true,
        connectTimeout: 5_000,
        maxRetriesPerRequest: 2,
        enableOfflineQueue: true,
      });
    // Without a listener, a lost connection crashes the process. The message never includes the URL (it may hold a password).
    this.redis.on("error", (err: Error & { code?: string }) => {
      process.stderr.write(`[commerce-b2b-mcp] Redis state store: ${err.code ?? "error"}\n`);
    });
  }

  private k(ns: string, key: string): string {
    // Keyed, so someone who can read Redis cannot test a guessed email, address or id against the key names.
    return `${this.prefix}${ns}:${createHmac("sha256", this.macKey).update(`${ns}\0${key}`).digest("base64url")}`;
  }

  private z(ns: string): string {
    return `${this.prefix}schedule:${ns}`;
  }

  /** The value is sealed together with its own expiry, so a copy put back later, or with a longer Redis TTL, still dies on time. */
  private seal(redisKey: string, value: unknown, ttlMs: number): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(redisKey));
    const body = Buffer.concat([c.update(JSON.stringify({ e: this.now() + ttlMs, v: value }), "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  }

  private open<T>(redisKey: string, sealed: string | null): T | undefined {
    if (sealed === null) return undefined;
    const raw = Buffer.from(sealed, "base64");
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(redisKey));
      d.setAuthTag(raw.subarray(12, 28));
      const env = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8")) as { e: number; v: T };
      return typeof env.e === "number" && env.e >= this.now() ? env.v : undefined;
    } catch {
      // Written with another COMMERCE_STATE_KEY, or tampered with: treat as absent, never as trusted.
      return undefined;
    }
  }

  async get<T>(ns: string, key: string): Promise<T | undefined> {
    const k = this.k(ns, key);
    return this.open<T>(k, await this.redis.get(k));
  }

  async set(ns: string, key: string, value: unknown, ttlMs: number): Promise<void> {
    const k = this.k(ns, key);
    await this.redis.set(k, this.seal(k, value, ttlMs), "PX", Math.max(1, Math.ceil(ttlMs)));
  }

  async take<T>(ns: string, key: string): Promise<T | undefined> {
    const k = this.k(ns, key);
    return this.open<T>(k, await this.redis.getdel(k));
  }

  async delete(ns: string, key: string): Promise<void> {
    await this.redis.del(this.k(ns, key));
  }

  async increment(ns: string, key: string, windowMs: number): Promise<number> {
    return Number(await this.redis.eval(INCREMENT, 1, this.k(ns, key), Math.max(1, Math.ceil(windowMs))));
  }

  async schedule(ns: string, member: string, at: number): Promise<void> {
    await this.redis.zadd(this.z(ns), at, member);
  }

  async unschedule(ns: string, member: string): Promise<void> {
    await this.redis.zrem(this.z(ns), member);
  }

  async claimDue(ns: string, now: number, limit: number): Promise<string[]> {
    const z = this.z(ns);
    const due = await this.redis.zrangebyscore(z, "-inf", now, "LIMIT", 0, limit);
    const claimed: string[] = [];
    // ZREM returns 1 to exactly one instance, so each member is claimed once.
    for (const m of due) if ((await this.redis.zrem(z, m)) === 1) claimed.push(m);
    return claimed;
  }

  /** Counters are plain INCR values, not sealed: a count is not sensitive, and Lua has to increment it. */
  async count(ns: string, key: string): Promise<number> {
    return Number((await this.redis.get(this.k(ns, key))) ?? 0);
  }

  async ready(): Promise<void> {
    try {
      if (this.redis.status === "wait") await this.redis.connect();
      await this.redis.ping();
    } catch {
      throw new Error("Cannot reach the Redis state store at COMMERCE_REDIS_URL. Check the address, password and TLS setting.");
    }
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
