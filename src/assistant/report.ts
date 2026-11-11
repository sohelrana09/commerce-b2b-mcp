import { cleanText } from "../tools/define.js";
import { FLAG_SEVERITY, type QuoteReview } from "./pipeline.js";

const money = (n: number | undefined, cur: string | null) => (n === undefined ? "—" : `${cur ?? ""} ${n.toFixed(2)}`.trim());
/**
 * Untrusted text (from the RFQ, through the model) shown as a code span: Markdown renders nothing inside it, so links,
 * images, raw HTML and headings in a customer's words stay visible text. One line, markup and invisible characters removed.
 */
const cell = (s: string) => {
  const t = cleanText(s, 500).replace(/`/g, "'").replace(/\|/g, "\\|");
  return t ? `\`${t}\`` : "—";
};

/** The rep's review sheet, as Markdown. Customer text is shown as quoted data, never as instructions. */
export function renderReview(r: QuoteReview): string {
  const cur = r.totals.currency;
  const out: string[] = [];
  out.push(`# RFQ review: ${cell(r.extraction.rfq_reference ?? r.document)}`);
  out.push("");
  out.push(
    `${r.lines.length} lines · **${r.totals.ready_lines} ready** · **${r.totals.review_lines} need review** · ready subtotal ${money(r.totals.ready_subtotal, cur)}`,
  );
  out.push(`Customer: ${r.extraction.customer_name ? cell(r.extraction.customer_name) : "not stated"} · Intake: ${cell(r.extractor)}`);

  if (r.extraction.suspicious_instructions.length) {
    out.push("");
    out.push("> **Warning: the RFQ contains instructions aimed at the assistant or the process.** They were ignored. Read the original before sending:");
    for (const s of r.extraction.suspicious_instructions) out.push(`> - ${cell(s)}`);
  }
  if (r.extraction.other_requests.length) {
    out.push("");
    out.push("**Other requests from the customer**");
    for (const s of r.extraction.other_requests) out.push(`- ${cell(s)}`);
  }

  out.push("");
  out.push("| # | Customer wrote | Qty (each) | Match | Score | Stock | Unit price | Line total | Status |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const l of r.lines) {
    out.push(
      `| ${cell(String(l.line.line_ref ?? l.index + 1))} | ${cell(l.line.raw_text)} | ${l.qty_each} | ${l.match ? cell(l.match.sku) : "—"} | ${
        l.match ? l.match.score.toFixed(2) : "—"
      } | ${l.stock ? (l.stock.salable_qty ?? (l.stock.in_stock ? "in stock" : "0")) : "—"} | ${money(l.price?.unit_price, cur)} | ${money(
        l.price?.line_total,
        cur,
      )} | ${l.status === "ready" ? "ready" : "**review**"} |`,
    );
  }

  const flagged = r.lines.filter((l) => l.flags.length);
  if (flagged.length) {
    out.push("");
    out.push("## What to check");
    for (const l of flagged) {
      out.push("");
      out.push(`**Line ${cell(String(l.line.line_ref ?? l.index + 1))}:** ${cell(l.line.raw_text)}`);
      for (const f of l.flags) out.push(`- ${FLAG_SEVERITY[f.code] === "review" ? "Review" : "Note"} (${f.code}): ${cleanText(f.message, 400)}`);
      if (l.alternatives.length) {
        out.push(`- Alternatives: ${l.alternatives.map((a) => `${cell(a.sku)} ${cleanText(a.name, 120)} (${a.score.toFixed(2)})`).join("; ")}`);
      }
    }
  }
  if (r.usage) {
    out.push("");
    out.push(
      `_Intake model ${r.usage.model}: ${r.usage.input_tokens} input tokens (${r.usage.cache_read_input_tokens} from cache), ${r.usage.output_tokens} output, ${(r.usage.ms / 1000).toFixed(1)}s._`,
    );
  }
  return out.join("\n");
}
