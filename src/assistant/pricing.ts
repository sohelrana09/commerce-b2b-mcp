import type { ExtractionUsage } from "./extract/schema.js";

/**
 * USD per million tokens, standard (non-batch) API, prompts up to 100K tokens.
 * Cache writes use the 5-minute TTL (1.25x input). Check current prices before
 * quoting these to anyone: they are a snapshot for comparing settings.
 */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  // Haiku cache read is not in the published table we used; 0.1x input is assumed (negligible either way).
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Cost of one call in USD, priced by the model that actually answered. Undefined for an unknown model. */
export function usageCost(u: ExtractionUsage): number | undefined {
  const p = PRICES[u.model] ?? PRICES[Object.keys(PRICES).find((k) => u.model.startsWith(k)) ?? ""];
  if (!p) return undefined;
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_input_tokens * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1e6
  );
}
