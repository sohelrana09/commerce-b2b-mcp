#!/usr/bin/env node
/**
 * Golden-set eval for the RFQ quote assistant.
 *
 *   npm run eval                          # heuristic intake: free, deterministic, runs in CI
 *   npm run eval -- --extractor claude    # Claude intake: calls the API and costs money
 *   npm run eval -- --sweep claude-opus-5-5:low,claude-sonnet-5-5:medium
 *                                         # several Claude settings in parallel, then a comparison
 *   npm run eval -- --compare             # rebuild evals/results/comparison.md from saved results (free)
 *
 * Runs every RFQ in evals/golden through the real pipeline against the mock
 * store (in-process MCP server, Harbour Marine Engineering buyer) and scores
 * it against evals/golden/expected.json. Writes a JSON result and a Markdown
 * summary to evals/results/.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { inProcessTools } from "../in-process.js";
import { ClaudeExtractor, EFFORTS, type Effort } from "../extract/claude.js";
import { HeuristicExtractor } from "../extract/heuristic.js";
import { loadRfq } from "../extract/input.js";
import type { Extractor } from "../extract/schema.js";
import { reviewRfq, type LineReview, type QuoteReview } from "../pipeline.js";
import { usageCost } from "../pricing.js";
import { targetTable } from "./targets.js";

export { inProcessTools };

interface ExpectedLine {
  text: string;
  qty_text: string;
  sku: string | null;
  acceptable_skus: string[];
  qty_each: number | null;
  needs_review: boolean;
  reason: string;
}
interface ExpectedDoc {
  file: string;
  expect_injection_flag: boolean;
  lines: ExpectedLine[];
}

const words = (s: string) => new Set(s.toLowerCase().replace(/set screw/g, "setscrew").split(/[^a-z0-9.]+/).filter((w) => w.length > 0));
function overlap(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(1, Math.min(A.size, B.size));
}

/** Pair each expected line with the predicted line whose raw text matches it best (one-to-one, greedy). */
export function align(expected: ExpectedLine[], predicted: LineReview[]): Array<LineReview | null> {
  const pairs: Array<{ e: number; p: number; s: number }> = [];
  expected.forEach((e, ei) =>
    predicted.forEach((p, pi) => {
      const s = overlap(`${e.text} ${e.qty_text}`, p.line.raw_text);
      if (s >= 0.6) pairs.push({ e: ei, p: pi, s });
    }),
  );
  pairs.sort((a, b) => b.s - a.s || Math.abs(a.e - a.p) - Math.abs(b.e - b.p));
  const out: Array<LineReview | null> = expected.map(() => null);
  const used = new Set<number>();
  for (const { e, p } of pairs) {
    if (out[e] || used.has(p)) continue;
    out[e] = predicted[p]!;
    used.add(p);
  }
  return out;
}

export interface Scores {
  expected_lines: number;
  predicted_lines: number;
  lines_found: number;
  qty_correct: number;
  with_answer: number;
  top1: number;
  top3: number;
  expected_review: number;
  flagged_review: number;
  review_caught: number;
  review_false_alarm: number;
  accepted_without_edits: number;
  /** Lines marked "ready" (would go into the draft unflagged) that are wrong. The number that must be 0. */
  unsafe_ready: number;
  injection_docs: number;
  injection_flagged: number;
  unsafe_examples: string[];
}

export function score(expected: ExpectedDoc[], runs: QuoteReview[]): Scores {
  const s: Scores = {
    expected_lines: 0, predicted_lines: 0, lines_found: 0, qty_correct: 0, with_answer: 0, top1: 0, top3: 0,
    expected_review: 0, flagged_review: 0, review_caught: 0, review_false_alarm: 0, accepted_without_edits: 0,
    unsafe_ready: 0, injection_docs: 0, injection_flagged: 0, unsafe_examples: [],
  };
  expected.forEach((doc, di) => {
    const run = runs[di]!;
    const aligned = align(doc.lines, run.lines);
    s.expected_lines += doc.lines.length;
    s.predicted_lines += run.lines.length;
    if (doc.expect_injection_flag) {
      s.injection_docs++;
      if (run.extraction.suspicious_instructions.length) s.injection_flagged++;
    }
    const matchedIdx = new Set(aligned.filter(Boolean).map((l) => l!.index));
    // Predicted lines with no expected counterpart: a ready one would put an unrequested part in the quote.
    for (const p of run.lines) {
      if (!matchedIdx.has(p.index) && p.status === "ready") {
        s.unsafe_ready++;
        s.unsafe_examples.push(`${doc.file}: extra line "${p.line.raw_text}" marked ready`);
      }
    }
    doc.lines.forEach((e, i) => {
      const p = aligned[i];
      const acceptable = e.acceptable_skus.length ? e.acceptable_skus : e.sku ? [e.sku] : [];
      if (e.needs_review) s.expected_review++;
      if (acceptable.length) s.with_answer++;
      if (!p) return; // missed line: counts against recall below
      s.lines_found++;
      const qtyOk = e.qty_each === null || p.qty_each === e.qty_each;
      if (qtyOk) s.qty_correct++;
      const skuOk = p.match ? acceptable.includes(p.match.sku) : acceptable.length === 0;
      if (acceptable.length && p.match && acceptable.includes(p.match.sku)) s.top1++;
      if (acceptable.length && [p.match, ...p.alternatives].slice(0, 3).some((c) => c && acceptable.includes(c.sku))) s.top3++;
      if (p.status === "review") {
        s.flagged_review++;
        if (e.needs_review) s.review_caught++;
        else s.review_false_alarm++;
      }
      if (p.status === "ready") {
        if (!e.needs_review && skuOk && qtyOk) s.accepted_without_edits++;
        else {
          s.unsafe_ready++;
          s.unsafe_examples.push(
            `${doc.file}: "${e.text}" -> ${p.match?.sku ?? "none"} x ${p.qty_each} marked ready (expected ${e.sku ?? (acceptable.join("/") || "no part")}, ${e.reason})`,
          );
        }
      }
    });
  });
  return s;
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");

export interface Cost {
  rfqs: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** Undefined when a model in the run has no price in pricing.ts. */
  usd: number | undefined;
  ms: number;
  max_ms: number;
}

export function costOf(runs: QuoteReview[]): Cost | undefined {
  const usages = runs.map((r) => r.usage).filter((u) => u !== undefined);
  if (!usages.length) return undefined;
  const prices = usages.map(usageCost);
  return {
    rfqs: runs.length,
    input: usages.reduce((n, u) => n + u.input_tokens, 0),
    output: usages.reduce((n, u) => n + u.output_tokens, 0),
    cache_read: usages.reduce((n, u) => n + u.cache_read_input_tokens, 0),
    cache_write: usages.reduce((n, u) => n + (u.cache_creation_input_tokens ?? 0), 0),
    usd: prices.every((p) => p !== undefined) ? prices.reduce((a, b) => a! + b!, 0) : undefined,
    ms: usages.reduce((n, u) => n + u.ms, 0),
    max_ms: Math.max(...usages.map((u) => u.ms)),
  };
}

export function summarise(name: string, s: Scores, cost?: Cost): string {
  const rows: Array<[string, string, string]> = [
    ["Lines found (extraction recall)", `${s.lines_found}/${s.expected_lines}`, pct(s.lines_found, s.expected_lines)],
    ["Quantity correct (of found)", `${s.qty_correct}/${s.lines_found}`, pct(s.qty_correct, s.lines_found)],
    ["Top-1 match (lines with an answer)", `${s.top1}/${s.with_answer}`, pct(s.top1, s.with_answer)],
    ["Top-3 match", `${s.top3}/${s.with_answer}`, pct(s.top3, s.with_answer)],
    ["Needs-review caught (recall)", `${s.review_caught}/${s.expected_review}`, pct(s.review_caught, s.expected_review)],
    ["Review flags that were needed (precision)", `${s.review_caught}/${s.flagged_review}`, pct(s.review_caught, s.flagged_review)],
    ["Accepted without edits", `${s.accepted_without_edits}/${s.expected_lines}`, pct(s.accepted_without_edits, s.expected_lines)],
    ["Prompt injection noticed", `${s.injection_flagged}/${s.injection_docs}`, pct(s.injection_flagged, s.injection_docs)],
    ["**Wrong lines marked ready (must be 0)**", `**${s.unsafe_ready}**`, ""],
  ];
  const out = [`## ${name}`, "", "| Metric | Count | Rate |", "|---|---|---|", ...rows.map((r) => `| ${r.join(" | ")} |`)];
  if (cost) {
    const usd = cost.usd === undefined ? "unpriced model" : `$${cost.usd.toFixed(3)} total, $${(cost.usd / cost.rfqs).toFixed(4)} per RFQ`;
    out.push(
      "",
      `Intake: ${cost.input} input, ${cost.cache_read} cache-read, ${cost.cache_write} cache-write and ${cost.output} output tokens; ${usd}; ` +
        `${(cost.ms / cost.rfqs / 1000).toFixed(1)}s per RFQ on average, ${(cost.max_ms / 1000).toFixed(1)}s slowest.`,
    );
  }
  out.push("", targetTable(s, cost));
  if (s.unsafe_examples.length) out.push("", "Wrong lines marked ready:", ...s.unsafe_examples.map((x) => `- ${x}`));
  return out.join("\n");
}

export async function runEval(extractor: Extractor, golden = "evals/golden", outDir = "evals/results") {
  const expected = JSON.parse(readFileSync(join(golden, "expected.json"), "utf8")) as ExpectedDoc[];
  const tools = await inProcessTools();
  const runs: QuoteReview[] = [];
  try {
    for (const doc of expected) runs.push(await reviewRfq(loadRfq(join(golden, doc.file)), extractor, tools));
  } finally {
    await tools.close();
  }
  const scores = score(expected, runs);
  const cost = costOf(runs);
  const md = summarise(extractor.name, scores, cost);
  mkdirSync(outDir, { recursive: true });
  const stem = join(outDir, extractor.name.replace(/[^a-z0-9.-]+/gi, "_"));
  writeFileSync(`${stem}.json`, JSON.stringify({ extractor: extractor.name, scores, cost, runs }, null, 2));
  writeFileSync(`${stem}.md`, `${md}\n`);
  return { name: extractor.name, scores, cost, md };
}

function claude(model?: string, effort?: string): ClaudeExtractor {
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) throw new Error(`Effort must be one of ${EFFORTS.join(", ")}.`);
  return new ClaudeExtractor({ ...(model ? { model } : {}), ...(effort ? { effort: effort as Effort } : {}) });
}

interface Saved {
  extractor: string;
  scores: Scores;
  cost?: Partial<Cost>;
  runs: QuoteReview[];
}

/**
 * Compare saved Claude results and pick a setting (ADR 15): the cheapest per RFQ that
 * marks no wrong line ready, notices the injection, and is within 2 points of the best
 * top-1 and the best needs-review recall. Speed breaks ties.
 */
export function compare(saved: Saved[]): string {
  const rows = saved
    .filter((r) => r.extractor.startsWith("claude:"))
    .map((r) => {
      const cost = costOf(r.runs)!; // recomputed so older result files are priced the same way
      const s = r.scores;
      return {
        name: r.extractor.replace(/^claude:/, ""),
        s,
        usd: cost.usd === undefined ? undefined : cost.usd / cost.rfqs,
        sec: cost.ms / cost.rfqs / 1000,
        maxSec: cost.max_ms / 1000,
        top1: (100 * s.top1) / s.with_answer,
        recall: (100 * s.review_caught) / s.expected_review,
        precision: s.flagged_review ? (100 * s.review_caught) / s.flagged_review : 0,
        found: (100 * s.lines_found) / s.expected_lines,
        accepted: (100 * s.accepted_without_edits) / s.expected_lines,
      };
    })
    .sort((a, b) => (a.usd ?? Infinity) - (b.usd ?? Infinity));
  if (!rows.length) return "No Claude results to compare.";
  const bestTop1 = Math.max(...rows.map((r) => r.top1));
  const bestRecall = Math.max(...rows.map((r) => r.recall));
  const eligible = (r: (typeof rows)[number]) =>
    r.s.unsafe_ready === 0 &&
    r.s.injection_flagged === r.s.injection_docs &&
    r.top1 >= bestTop1 - 2 &&
    r.recall >= bestRecall - 2 &&
    r.usd !== undefined;
  const pick = rows.filter(eligible).sort((a, b) => a.usd! - b.usd! || a.sec - b.sec)[0];
  const f = (n: number) => `${n.toFixed(1)}%`;
  return [
    "## Intake settings compared",
    "",
    "| Model : effort | Wrong ready | Lines found | Top-1 | Review recall | Review precision | Accepted as is | Injection | $ per RFQ | s per RFQ (slowest) | Meets rule |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r === pick ? `**${r.name}**` : r.name} | ${r.s.unsafe_ready} | ${f(r.found)} | ${f(r.top1)} | ${f(r.recall)} | ${f(r.precision)} | ${f(r.accepted)} | ` +
        `${r.s.injection_flagged}/${r.s.injection_docs} | ${r.usd === undefined ? "n/a" : `$${r.usd.toFixed(4)}`} | ${r.sec.toFixed(1)} (${r.maxSec.toFixed(1)}) | ${eligible(r) ? "yes" : "no"} |`,
    ),
    "",
    "Rule: the cheapest setting per RFQ with 0 wrong lines marked ready, the injection noticed, and top-1 and needs-review recall within 2 points of the best run. Speed breaks ties. Prices are list prices from `src/assistant/pricing.ts`.",
    "",
    pick ? `**Pick: ${pick.name}**, $${pick.usd!.toFixed(4)} and ${pick.sec.toFixed(1)}s per RFQ.` : "**No setting meets the rule.**",
  ].join("\n");
}

function writeComparison(outDir: string): string {
  const saved = readdirSync(outDir)
    .filter((f) => f.startsWith("claude_") && f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(outDir, f), "utf8")) as Saved);
  const md = compare(saved);
  writeFileSync(join(outDir, "comparison.md"), `${md}\n`);
  return md;
}

async function main() {
  const { values } = parseArgs({
    options: {
      extractor: { type: "string", default: "heuristic" },
      sweep: { type: "string" },
      compare: { type: "boolean", default: false },
      golden: { type: "string", default: "evals/golden" },
      out: { type: "string", default: "evals/results" },
    },
  });
  const golden = values.golden!;
  const out = values.out!;

  if (values.compare) {
    console.log(writeComparison(out));
    return;
  }
  if (values.sweep) {
    // Settings run in parallel; each one's RFQs run in order so its cache stays warm.
    const extractors = values.sweep.split(",").map((x) => {
      const [model, effort] = x.trim().split(":");
      return claude(model, effort);
    });
    const results = await Promise.allSettled(extractors.map((e) => runEval(e, golden, out)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") console.log(`${r.value.md}\n`);
      else console.error(`${extractors[i]!.name} failed: ${(r.reason as Error).message}`);
    });
    console.log(writeComparison(out));
    if (results.some((r) => r.status === "rejected" || r.value.scores.unsafe_ready > 0)) process.exitCode = 1;
    return;
  }

  const extractor: Extractor =
    values.extractor === "claude" ? claude(process.env.RFQ_MODEL, process.env.RFQ_EFFORT) : new HeuristicExtractor();
  const { md, scores } = await runEval(extractor, golden, out);
  console.log(md);
  if (scores.unsafe_ready > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
