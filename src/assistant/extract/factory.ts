import type { RfqConfig } from "../../config.js";
import { ClaudeExtractor } from "./claude.js";
import { HeuristicExtractor } from "./heuristic.js";
import type { Extractor } from "./schema.js";

/** The intake step the settings ask for. Both have no tools (ADR 13); only "claude" costs money. */
export function extractorFromConfig(rfq: Pick<RfqConfig, "extractor" | "model" | "effort">): Extractor {
  if (rfq.extractor === "heuristic") return new HeuristicExtractor();
  return new ClaudeExtractor({ ...(rfq.model ? { model: rfq.model } : {}), ...(rfq.effort ? { effort: rfq.effort } : {}) });
}
