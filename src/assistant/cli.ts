#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connectStdio, type CommerceTools } from "./commerce.js";
import { forgetCorrections, recordCorrection } from "./corrections.js";
import { ClaudeExtractor, EFFORTS, type Effort } from "./extract/claude.js";
import { HeuristicExtractor } from "./extract/heuristic.js";
import { loadRfq } from "./extract/input.js";
import type { Extractor } from "./extract/schema.js";
import { draftInput, reviewRfq, type QuoteReview } from "./pipeline.js";
import { renderReview } from "./report.js";

const USAGE = `rfq-quote: turn a customer RFQ into a reviewed draft negotiable quote.

  rfq-quote review <rfq.txt|.eml|.csv|.pdf> [--extractor claude|heuristic] [--out review.md] [--save run.json]
  rfq-quote draft <run.json> [--include-flagged] [--name "Quote name"]
  rfq-quote correct <run.json> --line <ref> (--sku <SKU> | --none) [--qty <each>] [--note "..."] [--log corrections.jsonl]
  rfq-quote forget (--document <name> | --older-than <days>) [--log corrections.jsonl]
                   delete corrections for one RFQ (erasure request) or past a retention period

The assistant talks to the store only through commerce-b2b-mcp, using the same COMMERCE_* settings.
With no settings it runs against the built-in mock store as a Harbour Marine Engineering buyer.
Claude intake needs ANTHROPIC_API_KEY (or an \`ant auth login\` profile). RFQ_MODEL and RFQ_EFFORT override the defaults.`;

function serverEnv(): Record<string, string | undefined> {
  const mock = (process.env.COMMERCE_BACKEND ?? "mock") === "mock";
  return {
    COMMERCE_BACKEND: process.env.COMMERCE_BACKEND ?? "mock",
    ...(mock && !process.env.COMMERCE_CALLER_EMAIL ? { COMMERCE_CALLER_EMAIL: "sam.purchasing@harbour.example" } : {}),
    COMMERCE_AUDIT_LOG: process.env.COMMERCE_AUDIT_LOG ?? "audit.jsonl",
  };
}

async function withTools<T>(fn: (tools: CommerceTools) => Promise<T>): Promise<T> {
  const entry = process.env.RFQ_SERVER ?? fileURLToPath(new URL("../index.js", import.meta.url));
  const tools = await connectStdio(entry, serverEnv());
  try {
    return await fn(tools);
  } finally {
    await tools.close();
  }
}

function extractorFor(kind: string | undefined): Extractor {
  if (kind === "heuristic") return new HeuristicExtractor();
  if (kind && kind !== "claude") throw new Error(`Unknown extractor "${kind}". Use claude or heuristic.`);
  const effort = process.env.RFQ_EFFORT;
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) throw new Error(`RFQ_EFFORT must be one of ${EFFORTS.join(", ")}.`);
  return new ClaudeExtractor({ ...(process.env.RFQ_MODEL ? { model: process.env.RFQ_MODEL } : {}), ...(effort ? { effort: effort as Effort } : {}) });
}

async function review(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { extractor: { type: "string" }, out: { type: "string" }, save: { type: "string" } },
  });
  const file = positionals[0];
  if (!file) throw new Error(USAGE);
  const doc = loadRfq(file);
  const result = await withTools((tools) => reviewRfq(doc, extractorFor(values.extractor), tools));
  const md = renderReview(result);
  if (values.out) writeFileSync(values.out, `${md}\n`);
  const save = values.save ?? `${file}.run.json`;
  writeFileSync(save, JSON.stringify(result, null, 2));
  console.log(md);
  console.error(`\nSaved the run to ${save}. Next: rfq-quote draft ${save}`);
}

async function draft(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { "include-flagged": { type: "boolean", default: false }, name: { type: "string" } },
  });
  if (!positionals[0]) throw new Error(USAGE);
  const run = JSON.parse(readFileSync(positionals[0], "utf8")) as QuoteReview;
  const input = draftInput(run, { includeFlagged: values["include-flagged"], ...(values.name ? { name: values.name } : {}) });
  if (!input.lines.length) {
    console.log("No lines are ready to quote. Resolve the review flags first, or pass --include-flagged.");
    return;
  }

  await withTools(async (tools) => {
    const preview = await tools.call("draft_negotiable_quote", input);
    if (preview.isError) throw new Error(preview.data?.error?.message ?? "Preview failed.");
    const p = preview.data.preview;
    console.log(`Draft quote "${p.name}" for ${preview.data.company}`);
    for (const l of p.lines) console.log(`  ${l.sku.padEnd(22)} ${String(l.qty).padStart(7)} x ${l.unit_price.toFixed(3)} = ${l.row_total.toFixed(2)}  ${l.note ?? ""}`);
    console.log(`  Subtotal ${p.currency} ${p.subtotal.toFixed(2)}`);
    for (const w of preview.data.warnings) console.log(`  Warning: ${w}`);

    // The approval is a person at a terminal. There is no flag to skip it.
    if (!process.stdin.isTTY) throw new Error("Saving a draft needs a person to approve it at an interactive terminal.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("\nSave this as a DRAFT negotiable quote? It will not be sent to the customer. [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("Not saved.");
      return;
    }
    const saved = await tools.call("draft_negotiable_quote", { ...input, confirmation_token: preview.data.confirmation_token });
    if (saved.isError) throw new Error(saved.data?.error?.message ?? "Save failed.");
    console.log(saved.data.status === "draft_saved" ? `Saved draft ${saved.data.quote.quote_id}. ${saved.data.next_step}` : saved.data.warning);
  });
}

async function correct(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      line: { type: "string" },
      sku: { type: "string" },
      none: { type: "boolean", default: false },
      qty: { type: "string" },
      note: { type: "string" },
      log: { type: "string", default: "evals/corrections.jsonl" },
    },
  });
  if (!positionals[0] || !values.line || (!values.sku && !values.none)) throw new Error(USAGE);
  const run = JSON.parse(readFileSync(positionals[0], "utf8")) as QuoteReview;
  const rec = recordCorrection(values.log!, run, values.line, {
    sku: values.none ? null : values.sku!,
    ...(values.qty ? { qty_each: Number(values.qty) } : {}),
    ...(values.note ? { note: values.note } : {}),
  });
  console.log(`Recorded: line ${values.line} predicted ${rec.predicted_sku ?? "none"}, rep chose ${rec.expected_sku ?? "none"} -> ${values.log}`);
}

async function forget(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      document: { type: "string" },
      "older-than": { type: "string" },
      log: { type: "string", default: "evals/corrections.jsonl" },
    },
  });
  const days = values["older-than"] === undefined ? undefined : Number(values["older-than"]);
  if (days !== undefined && !(days >= 0)) throw new Error("--older-than must be a number of days.");
  if (values.document === undefined && days === undefined) throw new Error(USAGE);
  const n = forgetCorrections(values.log!, { ...(values.document !== undefined ? { document: values.document } : {}), ...(days !== undefined ? { olderThanDays: days } : {}) });
  console.log(`Removed ${n} correction record${n === 1 ? "" : "s"} from ${values.log}. Delete the matching .run.json and review files separately.`);
}

const [cmd, ...rest] = process.argv.slice(2);
const commands: Record<string, (a: string[]) => Promise<void>> = { review, draft, correct, forget };
const run = cmd ? commands[cmd] : undefined;
if (!run) {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
run(rest).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
