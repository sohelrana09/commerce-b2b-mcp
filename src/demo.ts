import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { HeuristicExtractor } from "./assistant/extract/heuristic.js";
import { loadRfq } from "./assistant/extract/input.js";
import type { RfqDocument } from "./assistant/extract/schema.js";
import { inProcessTools } from "./assistant/in-process.js";
import { draftInput, reviewRfq } from "./assistant/pipeline.js";
import { renderReview } from "./assistant/report.js";

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
const step = (n: number, title: string) => console.log(`\n${bold(`Step ${n} of 3 · ${title}`)}\n`);
const indent = (s: string) => s.split("\n").map((l) => `    ${l}`).join("\n");

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
    console.log(renderReview(review));

    step(3, "A draft negotiable quote is proposed for a person to approve");
    const input = draftInput(review, { name: `Demo quote ${review.extraction.rfq_reference ?? (values.rfq ? doc.name : "HM-DEMO-01")}` });
    if (!input.lines.length) {
      console.log("No lines are ready to quote, so there is nothing to draft. Every line needs a rep's decision first.");
    } else {
      const preview = await tools.call("draft_negotiable_quote", input);
      if (preview.isError) throw new Error(preview.data?.error?.message ?? "The draft preview failed.");
      const p = preview.data.preview;
      console.log(`Draft "${p.name}" for ${preview.data.company}, ready lines only:\n`);
      for (const l of p.lines) console.log(`    ${l.sku.padEnd(24)} ${String(l.qty).padStart(7)} x ${l.unit_price.toFixed(3)} = ${l.row_total.toFixed(2)}`);
      console.log(`\n    Subtotal ${p.currency} ${p.subtotal.toFixed(2)}`);
      for (const w of preview.data.warnings ?? []) console.log(`    Warning: ${w}`);
      console.log(
        `\n${dim("Not saved. This is the preview step: the tool returns a confirmation token, and only a call that")}` +
          `\n${dim("repeats the same input with that token saves anything, and then only as a DRAFT the customer")}` +
          `\n${dim("never sees. Flagged lines stay out until a rep resolves them.")}`,
      );
    }
  } finally {
    await tools.close();
  }

  console.log(`\n${bold("Next")}
  Review your own RFQ:   npx -y github:sohelrana09/commerce-b2b-mcp demo --rfq my-rfq.txt
  Use it from Claude:    add the server to your MCP client, see the README ("Try it in 2 minutes")
  Claude intake:         rfq-quote review <file> with ANTHROPIC_API_KEY set (finds more lines; paid)
  Remote server:         the README's Docker section runs the server over HTTP with OAuth sign-in`);
}
