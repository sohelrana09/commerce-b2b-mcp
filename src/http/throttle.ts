import type { StateStore } from "./state.js";

/** Failed sign-ins allowed per address and email in the window. */
export const MAX_FAILURES = 5;
/** Per email across all addresses, so rotating addresses does not give unlimited guesses. */
export const MAX_EMAIL_FAILURES = 20;
export const MAX_EMAIL_LENGTH = 254;
export const FAILURE_WINDOW_MS = 15 * 60_000;

/**
 * The sign-in lockout shared by every sign-in form (the OAuth page and the RFQ web page), so they count against
 * one budget. The attempt is reserved before the store is asked, so parallel guesses cannot all pass a
 * check-then-increment race. Success clears the address counter; the per-email counter is left to expire.
 */
export async function reserveSignIn(store: StateStore, ip: string | undefined, email: string): Promise<{ allowed: boolean; succeeded: () => Promise<void> }> {
  const key = `${ip ?? "?"}|${email.toLowerCase()}`;
  const emailKey = `*|${email.toLowerCase()}`;
  const byAddress = await store.increment("failure", key, FAILURE_WINDOW_MS);
  const byEmail = await store.increment("failure", emailKey, FAILURE_WINDOW_MS);
  return {
    allowed: byAddress <= MAX_FAILURES && byEmail <= MAX_EMAIL_FAILURES,
    succeeded: () => store.delete("failure", key),
  };
}
