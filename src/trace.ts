import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-tool-call trace. Each tool call runs inside one; the PaaS HTTP client
 * counts its store requests into it, and the audit line records the totals,
 * so a slow call can be split into "our code" and "the store".
 */
export interface Trace {
  trace_id: string;
  upstream: { calls: number; ms: number; errors: number };
}

const store = new AsyncLocalStorage<Trace>();

export function runTraced<T>(trace: Trace, fn: () => Promise<T>): Promise<T> {
  return store.run(trace, fn);
}

export function currentTrace(): Trace | undefined {
  return store.getStore();
}

/** Record one upstream request on the current trace, if any. */
export function recordUpstream(ms: number, failed: boolean): void {
  const t = store.getStore();
  if (!t) return;
  t.upstream.calls++;
  t.upstream.ms += ms;
  if (failed) t.upstream.errors++;
}
