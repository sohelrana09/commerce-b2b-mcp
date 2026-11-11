import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ToolError } from "./errors.js";

/**
 * Propose-then-approve for write tools.
 *
 * A write tool called without a token returns a preview and a token. The token
 * is an HMAC over (tool, caller, canonical input, expiry), so it only works for
 * the exact same call by the same caller within the TTL. Changing a quantity
 * after seeing the preview invalidates it.
 */

/**
 * Remembers which confirmation tokens have been used, so one approved preview saves one draft.
 * `claim` returns true for the first caller only. Over HTTP it is backed by the shared state store,
 * so it holds across instances; otherwise it lives in this process.
 */
export interface TokenLedger {
  claim(token: string, ttlMs: number): Promise<boolean>;
}

export function memoryLedger(now: () => number = Date.now): TokenLedger {
  const used = new Map<string, number>();
  return {
    async claim(token, ttlMs) {
      for (const [t, until] of used) if (until <= now()) used.delete(t);
      if (used.has(token)) return false;
      used.set(token, now() + ttlMs);
      return true;
    },
  };
}

/** Milliseconds until a verified token's expiry, plus a minute of clock slack. */
export function tokenLifetimeMs(token: string, now = Date.now()): number {
  return Math.max(0, Number(token.split(".")[0]) * 1000 - now) + 60_000;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(tool: string, caller: string, input: unknown): string {
  return createHash("sha256").update(`${tool}\n${caller}\n${canonical(input)}`).digest("base64url");
}

function sign(secret: Buffer, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueToken(
  secret: Buffer,
  ttlSeconds: number,
  tool: string,
  caller: string,
  input: unknown,
  now = Date.now(),
): { token: string; expires_at: string } {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload = `${exp}.${digest(tool, caller, input)}`;
  return { token: `${payload}.${sign(secret, payload)}`, expires_at: new Date(exp * 1000).toISOString() };
}

export function verifyToken(
  secret: Buffer,
  token: string,
  tool: string,
  caller: string,
  input: unknown,
  now = Date.now(),
): void {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ToolError("CONFIRMATION_INVALID", "Malformed confirmation token.");
  const [expStr, dig, sig] = parts as [string, string, string];

  const expected = Buffer.from(sign(secret, `${expStr}.${dig}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new ToolError("CONFIRMATION_INVALID", "Confirmation token signature is invalid.");
  }
  if (Number(expStr) * 1000 < now) {
    throw new ToolError(
      "CONFIRMATION_INVALID",
      "Confirmation token has expired.",
      "Call the tool again without confirmation_token to get a fresh preview.",
    );
  }
  if (dig !== digest(tool, caller, input)) {
    throw new ToolError(
      "CONFIRMATION_INVALID",
      "Confirmation token was issued for different input.",
      "Inputs changed after the preview. Request a new preview and have the human approve it.",
    );
  }
}
