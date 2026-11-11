import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { QuoteReview } from "./pipeline.js";

/**
 * The "learn" step. Each rep decision on a line becomes one JSONL record in
 * the same shape as the golden eval cases, so corrections grow the eval set
 * directly and every prompt or model change is re-measured against them.
 */
export interface CorrectionRecord {
  id: string;
  source: "rep_correction";
  recorded_at: string;
  document: string;
  raw_text: string;
  predicted_sku: string | null;
  /** The SKU the rep chose, or null when the right answer is "no catalogue part / ask the customer". */
  expected_sku: string | null;
  expected_qty_each: number | null;
  rep_note: string | null;
}

export function recordCorrection(
  path: string,
  review: QuoteReview,
  lineRef: string,
  decision: { sku: string | null; qty_each?: number; note?: string },
): CorrectionRecord {
  const line = review.lines.find((l) => (l.line.line_ref ?? String(l.index + 1)) === lineRef);
  if (!line) throw new Error(`Line ${lineRef} is not in the review for "${review.document}".`);
  const rec: CorrectionRecord = {
    id: `${review.document}#${lineRef}@${Date.now()}`,
    source: "rep_correction",
    recorded_at: new Date().toISOString(),
    document: review.document,
    raw_text: line.line.raw_text,
    predicted_sku: line.match?.sku ?? null,
    expected_sku: decision.sku,
    expected_qty_each: decision.qty_each ?? line.qty_each,
    rep_note: decision.note ?? null,
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(rec)}\n`);
  return rec;
}

export function readCorrections(path: string): CorrectionRecord[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CorrectionRecord);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
