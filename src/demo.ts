import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { HeuristicExtractor } from "./assistant/extract/heuristic.js";
import { loadRfq } from "./assistant/extract/input.js";
import type { RfqDocument } from "./assistant/extract/schema.js";
import { inProcessTools } from "./assistant/in-process.js";
import { draftInput, reviewRfq, type QuoteReview } from "./assistant/pipeline.js";
import { cleanText } from "./tools/define.js";

/**
 * `commerce-b2b-mcp demo`: the whole RFQ-to-draft-quote flow in one command,
 * with no API key, no store and nothing written to disk. The server runs in
 * this process against the mock store, as a buyer at Harbour Marine
 * Engineering, and intake uses the free rule-based extractor.
 */

const SAMPLE_RFQ = `From: purchasing@harbour.example
Subject: RFQ HM-DEMO-01

Hi,

Please quote the following for delivery to our Southampton yard:

1. M8x30 A4 hex setcrew - 2,000 off
2. M12*50 HH setscrews 316 - x 1500
3. flat washer M16 316 - 2,000 off
4. M6*20 A2-70 setscrew hex hd - 20 boxes of 100
5. hexagon bolts M12*100 grade 8.8 galvanised - 100 off
6. M10 hexagon nut BZP - 200 pcs
7. M 10 nyloc nut BZP - 3k
8. hexagon nut M 12 316 - qty 200
9. M8x25 SS hex setscrew - 1,000 off
10. M10 hex bolts 8.8 zinc - 500 off
11. M8 x 30 A4-80 hex setscrew - 500 off

We need 3.1 material certificates on all stainless lines.

Thanks,
Sam`;

const HELP = `commerce-b2b-mcp demo: see the RFQ quote assistant work, with no API key and no store.

  npx -y github:sohelrana09/commerce-b2b-mcp demo              run the built-in sample RFQ
  npx -y github:sohelrana09/commerce-b2b-mcp demo --rfq <file> review your own RFQ (.txt, .eml or .csv)

Everything runs against the built-in mock store. Nothing is saved and nothing is sent anywhere.`;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s);
const step = (n: number, title: string) => console.log(`\n${bold(`Step ${n} of 3 · ${title}`)}\n`);
/** RFQ text is untrusted: drop control characters (escape sequences could rewrite the terminal), keep the line breaks. */
const indent = (s: string) => s.split("\n").map((l) => `    ${l.replace(/[\p{Cc}\p{Cf}]/gu, "")}`).join("\n");
const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}\u2026` : s.padEnd(n));

/**
 * The review sheet laid out for a terminal. The assistant's own report
 * (`rfq-quote review --out`) is Markdown for a rep's editor; here the same
 * facts are aligned columns. Customer text goes through cleanText, which
 * strips markup and control characters.
 */
function renderForTerminal(r: QuoteReview): string {
  const cur = r.totals.currency ?? "";
  const out: string[] = [];
  out.push(
    `    ${r.lines.length} lines: ${green(`${r.totals.ready_lines} ready`)}, ${yellow(`${r.totals.review_lines} need review`)}. Ready subtotal ${cur} ${r.totals.ready_subtotal.toFixed(2)}`,
  );
  for (const s of r.extraction.suspicious_instructions) out.push(`    ${yellow("Ignored instruction in the RFQ:")} "${cleanText(s, 120)}"`);
  out.push("");
  out.push(dim(`    ${"#".padStart(2)}  ${"Customer wrote".padEnd(44)} ${"Qty".padStart(6)}  ${"Match".padEnd(20)} ${"Unit".padStart(6)} ${"Total".padStart(9)}  Status`));
  for (const l of r.lines) {
    const status = l.status === "ready" ? green("ready") : yellow("review");
    out.push(
      `    ${String(l.index + 1).padStart(2)}  ${fit(cleanText(l.line.raw_text, 200), 44)} ${String(l.qty_each).padStart(6)}  ${fit(l.match?.sku ?? "-", 20)} ${(l.price ? l.price.unit_price.toFixed(2) : "-").padStart(6)} ${(l.price ? l.price.line_total.toFixed(2) : "-").padStart(9)}  ${status}`,
    );
  }
  const flagged = r.lines.filter((l) => l.status === "review");
  if (flagged.length) {
    out.push("");
    out.push(bold("    What a person must check"));
    for (const l of flagged) {
      out.push(`    ${yellow(`Line ${l.index + 1}`)}  "${cleanText(l.line.raw_text, 80)}"`);
      for (const f of l.flags) out.push(`      ${cleanText(f.message, 160)}`);
      if (l.alternatives.length) out.push(dim(`      Options: ${l.alternatives.map((a) => a.sku).join(", ")}`));
    }
  }
  return out.join("\n");
}

export async function runDemo(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { rfq: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log(HELP);
    return;
  }

  if (values.rfq && !existsSync(values.rfq)) throw new Error(`No file at ${values.rfq}. Pass the path to an RFQ saved as .txt, .eml or .csv.`);
  const doc: RfqDocument = values.rfq ? loadRfq(values.rfq) : { kind: "text", name: "sample-rfq.txt", text: SAMPLE_RFQ };
  if (doc.kind === "pdf") throw new Error("The demo reads text, email and CSV files. PDF intake needs Claude: use rfq-quote review with ANTHROPIC_API_KEY set.");

  console.log(bold("commerce-b2b-mcp demo"));
  console.log(dim("Mock store, buyer: Harbour Marine Engineering. Rule-based intake. No API key, nothing saved."));

  step(1, "An RFQ arrives");
  console.log(indent(doc.text.trim()));

  step(2, "The assistant reads it, matches each line, and checks stock and the company's price");
  const tools = await inProcessTools();
  try {
    const review = await reviewRfq(doc, new HeuristicExtractor(), tools);
    console.log(renderForTerminal(review));

    step(3, "A draft negotiable quote is proposed for a person to approve");
    const input = draftInput(review, { name: `Demo quote ${review.extraction.rfq_reference ?? (values.rfq ? doc.name : "HM-DEMO-01")}` });
    if (!input.lines.length) {
      console.log("No lines are ready to quote, so there is nothing to draft. Every line needs a rep's decision first.");
    } else {
      const preview = await tools.call("draft_negotiable_quote", input);
      if (preview.isError) throw new Error(preview.data?.error?.message ?? "The draft preview failed.");
      const p = preview.data.preview;
      console.log(`    Draft "${cleanText(p.name, 80)}" for ${preview.data.company}, ready lines only:\n`);
      for (const l of p.lines) console.log(`    ${l.sku.padEnd(20)} ${String(l.qty).padStart(6)} x ${l.unit_price.toFixed(3)} = ${l.row_total.toFixed(2).padStart(8)}`);
      console.log(`    ${"".padEnd(20)} ${"".padStart(6)}   ${"Subtotal".padStart(5)} ${bold(`${p.currency} ${p.subtotal.toFixed(2)}`)}`);
      for (const w of preview.data.warnings ?? []) console.log(`    ${yellow("Warning:")} ${w}`);
      console.log(
        `\n${dim("    Not saved. The tool returned a preview and a confirmation token. Only a second call with that")}` +
          `\n${dim("    token saves anything, and then only as a DRAFT the customer never sees. Flagged lines stay out")}` +
          `\n${dim("    until a person resolves them.")}`,
      );
    }
  } finally {
    await tools.close();
  }

  console.log(`\n${bold("Next")}
  Review your own RFQ:   npx -y github:sohelrana09/commerce-b2b-mcp demo --rfq my-rfq.txt
  Use it from Claude:    add the server to your MCP client, see the README ("Quick start")
  Claude intake:         rfq-quote review <file> with ANTHROPIC_API_KEY set (finds more lines; paid)
  Remote server:         the README's Docker section runs the server over HTTP with OAuth sign-in`);
}
