#!/usr/bin/env node
/**
 * Golden-set eval for the RFQ quote assistant.
 *
 *   npm run eval                          # heuristic intake: free, deterministic, runs in CI
 *   npm run eval -- --extractor claude    # Claude intake: calls the API and costs money
 *
 * Runs every RFQ in evals/golden through the real pipeline against the mock
 * store (in-process MCP server, Harbour Marine Engineering buyer) and scores
 * it against evals/golden/expected.json. Writes a JSON result and a Markdown
 * summary to evals/results/.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { memoryAuditSink } from "../../audit.js";
import { loadConfig } from "../../config.js";
import { createServer } from "../../server.js";
import { connectTransport, type CommerceTools } from "../commerce.js";
import { ClaudeExtractor, EFFORTS, type Effort } from "../extract/claude.js";
import { HeuristicExtractor } from "../extract/heuristic.js";
import { loadRfq } from "../extract/input.js";
import type { Extractor } from "../extract/schema.js";
import { reviewRfq, type LineReview, type QuoteReview } from "../pipeline.js";

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

export async function inProcessTools(callerEmail = "sam.purchasing@harbour.example"): Promise<CommerceTools> {
  const config = loadConfig({ COMMERCE_BACKEND: "mock", COMMERCE_CALLER_EMAIL: callerEmail, COMMERCE_CONFIRM_SECRET: "eval-only-secret" });
  const { server } = createServer(config, { audit: memoryAuditSink() });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  return connectTransport(clientT);
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

export function summarise(name: string, s: Scores, cost?: { input: number; output: number; ms: number }): string {
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
  if (cost) out.push("", `Intake tokens: ${cost.input} in, ${cost.output} out, ${(cost.ms / 1000).toFixed(1)}s total.`);
  if (s.unsafe_examples.length) out.push("", "Wrong lines marked ready:", ...s.unsafe_examples.map((x) => `- ${x}`));
  return out.join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      extractor: { type: "string", default: "heuristic" },
      golden: { type: "string", default: "evals/golden" },
      out: { type: "string", default: "evals/results" },
    },
  });
  let extractor: Extractor;
  if (values.extractor === "claude") {
    const effort = process.env.RFQ_EFFORT;
    if (effort && !(EFFORTS as readonly string[]).includes(effort)) throw new Error(`RFQ_EFFORT must be one of ${EFFORTS.join(", ")}.`);
    extractor = new ClaudeExtractor({ ...(process.env.RFQ_MODEL ? { model: process.env.RFQ_MODEL } : {}), ...(effort ? { effort: effort as Effort } : {}) });
  } else extractor = new HeuristicExtractor();

  const expected = JSON.parse(readFileSync(join(values.golden!, "expected.json"), "utf8")) as ExpectedDoc[];
  const tools = await inProcessTools();
  const runs: QuoteReview[] = [];
  try {
    for (const doc of expected) runs.push(await reviewRfq(loadRfq(join(values.golden!, doc.file)), extractor, tools));
  } finally {
    await tools.close();
  }
  const s = score(expected, runs);
  const cost = runs.some((r) => r.usage)
    ? runs.reduce((c, r) => ({ input: c.input + (r.usage?.input_tokens ?? 0), output: c.output + (r.usage?.output_tokens ?? 0), ms: c.ms + (r.usage?.ms ?? 0) }), { input: 0, output: 0, ms: 0 })
    : undefined;
  const md = summarise(extractor.name, s, cost);
  mkdirSync(values.out!, { recursive: true });
  const stem = join(values.out!, extractor.name.replace(/[^a-z0-9.-]+/gi, "_"));
  writeFileSync(`${stem}.json`, JSON.stringify({ extractor: extractor.name, scores: s, cost, runs }, null, 2));
  writeFileSync(`${stem}.md`, `${md}\n`);
  console.log(md);
  if (s.unsafe_ready > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
