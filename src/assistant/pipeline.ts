import { mapLimit } from "../concurrency.js";
import type { CommerceTools } from "./commerce.js";
import type { ExtractedLine, Extraction, ExtractionUsage, Extractor, RfqDocument } from "./extract/schema.js";

/**
 * RFQ -> reviewed, priced lines -> (human approves) -> draft negotiable quote.
 *
 * The model is used for one step only: reading the RFQ. Matching, stock,
 * pricing, flags and the quote itself are deterministic code over the MCP
 * tools, so every number a rep sees comes from the store and every decision
 * the assistant makes can be replayed and evaluated.
 */

export type FlagCode =
  | "not_a_fastener"
  | "missing_size"
  | "no_match"
  | "partial_match"
  | "ambiguous"
  | "extraction_uncertain"
  | "unit_unclear"
  | "pack_size_assumed"
  | "unusual_quantity"
  | "out_of_stock"
  | "short_stock"
  | "stock_unconfirmed"
  | "pack_rounding"
  | "no_price";

/** "review" blocks a line from the draft until a rep decides; "info" is shown but does not block. */
export const FLAG_SEVERITY: Record<FlagCode, "review" | "info"> = {
  not_a_fastener: "review",
  missing_size: "review",
  no_match: "review",
  partial_match: "review",
  ambiguous: "review",
  extraction_uncertain: "review",
  unit_unclear: "review",
  pack_size_assumed: "review",
  unusual_quantity: "review",
  out_of_stock: "review",
  short_stock: "review",
  stock_unconfirmed: "info",
  pack_rounding: "info",
  no_price: "review",
};

export interface Flag {
  code: FlagCode;
  message: string;
}

export interface Candidate {
  sku: string;
  name: string;
  score: number;
  mismatched: string[];
  pack_size: number | null;
  /** Style words shared with the customer's text; only used to break score ties. */
  style?: number;
}

export interface LineReview {
  index: number;
  line: ExtractedLine;
  qty_each: number;
  match: Candidate | null;
  alternatives: Candidate[];
  stock: { salable_qty: number | null; in_stock: boolean; message: string } | null;
  price: { unit_price: number; line_total: number; currency: string; price_source: string } | null;
  flags: Flag[];
  status: "ready" | "review";
}

export interface QuoteReview {
  document: string;
  extractor: string;
  extraction: Extraction;
  usage?: ExtractionUsage;
  lines: LineReview[];
  totals: { ready_lines: number; review_lines: number; ready_subtotal: number; currency: string | null };
}

/** The fields of tool results this pipeline reads (the tools' own output shapes). */
interface SearchRow { sku: string; name: string; score: number; mismatched?: string[]; pack_size: number | null }
interface StockRow { sku: string; salable_qty: number | null; in_stock: boolean; message: string }
interface PriceRow { sku: string; unit_price: number; line_total: number; currency: string; price_source: string }

const UNUSUAL_QTY = 250_000;
/** The draft_negotiable_quote tool refuses more than this for one SKU. */
const MAX_LINE_QTY = 1_000_000;
const SEARCH_CONCURRENCY = 5;

const needsLength = (t: ExtractedLine["part_type"]) => t === "bolt" || t === "screw" || t === null;

function qtyEach(line: ExtractedLine, catalogPack: number | null, flags: Flag[]): number {
  const q = line.quantity;
  switch (line.unit) {
    case "each":
      return q;
    case "hundred":
      return q * 100;
    case "thousand":
      return q * 1000;
    case "unknown":
      flags.push({ code: "unit_unclear", message: `The unit for "${q}" is unclear; treated as ${q} each.` });
      return q;
    default: {
      if (line.units_per_pack) return q * line.units_per_pack;
      if (catalogPack) {
        flags.push({
          code: "pack_size_assumed",
          message: `"${q} ${line.unit}" has no pack size; assumed the catalogue pack of ${catalogPack} (${q * catalogPack} each). Confirm with the customer.`,
        });
        return q * catalogPack;
      }
      flags.push({ code: "unit_unclear", message: `"${q} ${line.unit}" has no pack size; treated as ${q} each.` });
      return q;
    }
  }
}

/** Build the search_parts arguments. Stated attributes become hard filters; the customer's own words stay as the query. */
export function searchArgs(line: ExtractedLine) {
  const filters: Record<string, unknown> = {};
  if (line.part_type && line.part_type !== "other") filters.part_type = line.part_type;
  if (line.head) filters.head = line.head;
  if (line.thread && /^M\d+(\.\d+)?$/.test(line.thread)) filters.thread = line.thread;
  if (line.length_mm && line.length_mm <= 10_000) filters.length_mm = line.length_mm;
  if (line.material && line.material !== "stainless_unspecified") filters.material = line.material;
  if (line.grade && /^[A-Za-z0-9.\-]{1,10}$/.test(line.grade)) filters.grade = line.grade;
  if (line.finish) filters.finish = line.finish;

  let query = line.description.slice(0, 200) || line.raw_text.slice(0, 200);
  // "SS" with no grade: make sure the server reads it as "either A2 or A4" rather than any material.
  if (line.material === "stainless_unspecified" && !/\b(ss|s\/s|stainless|inox)\b/i.test(query)) query = `${query} stainless`.slice(0, 200);
  return { query, filters, limit: 5 };
}

// Light trade-language normalisation for the tie-break, so "hexagon bolts" counts as "hex bolt".
const TOKEN_MAP: Record<string, string> = { hexagon: "hex", hh: "hex", bolts: "bolt", nuts: "nut", washers: "washer", setscrews: "setscrew", screws: "screw", nylon: "nyloc", lock: "nyloc", studding: "rod", full: "" };
const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/set screw/g, "setscrew")
      .split(/[^a-z0-9]+/)
      .map((t) => TOKEN_MAP[t] ?? t)
      .filter((t) => t.length > 1),
  );
const STYLE_WORDS = ["hex", "bolt", "setscrew", "screw", "nyloc", "nut", "washer", "rod", "socket", "cap", "countersunk"];

/**
 * The attribute score cannot tell a hex nut from a nyloc nut, or a hex bolt
 * (ISO 4014) from a hex setscrew (ISO 4017): both score 1. Among candidates
 * tied on score, prefer the one whose name shares more style words with what
 * the customer wrote. Ties that the customer's words don't settle stay tied,
 * and are flagged as ambiguous.
 */
export function breakTies(line: ExtractedLine, candidates: Candidate[]): Candidate[] {
  const said = tokens(`${line.raw_text} ${line.description}`);
  const style = (c: Candidate) => {
    const name = tokens(c.name.replace(/set screw/i, "setscrew"));
    return STYLE_WORDS.filter((w) => said.has(w) && name.has(w)).length;
  };
  return candidates
    .map((c, i) => ({ c: { ...c, style: style(c) }, i }))
    .sort((a, b) => b.c.score - a.c.score || b.c.style - a.c.style || a.i - b.i)
    .map((x) => x.c);
}

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function reviewLines(tools: CommerceTools, extraction: Extraction): Promise<LineReview[]> {
  // 1. Match every line.
  const matched = await mapLimit(extraction.lines, SEARCH_CONCURRENCY, async (line, index) => {
    const flags: Flag[] = [];
    if (line.uncertain) flags.push({ code: "extraction_uncertain", message: line.uncertainty_reason ?? "The intake step was unsure about this line." });
    if (line.part_type === "other") {
      flags.push({ code: "not_a_fastener", message: "Not a fastener in this catalogue; quote it by hand or decline." });
      return { index, line, flags, candidates: [] as Candidate[] };
    }
    if (!line.thread || (needsLength(line.part_type) && !line.length_mm)) {
      flags.push({
        code: "missing_size",
        message: !line.thread ? "No metric thread size stated." : "No length stated. Thread and length must be confirmed, never assumed.",
      });
    }
    // With no thread there is nothing safe to search for; any "match" would be a guess.
    if (!line.thread) return { index, line, flags, candidates: [] as Candidate[] };
    // Values the search tool would refuse are left out of the search, and a person is told.
    if (line.length_mm && line.length_mm > 10_000) flags.push({ code: "extraction_uncertain", message: `Length ${line.length_mm} mm is not plausible; it was not used in the search.` });
    if (line.grade && !/^[A-Za-z0-9.\-]{1,10}$/.test(line.grade)) flags.push({ code: "extraction_uncertain", message: `"${line.grade.slice(0, 40)}" is not a property class; it was not used in the search.` });
    const res = await tools.call("search_parts", searchArgs(line));
    if (res.isError) throw new Error(`search_parts failed on line ${index + 1}: ${res.data?.error?.message ?? "unknown error"}`);
    const candidates: Candidate[] = ((res.data.results ?? []) as SearchRow[]).map((r) => ({
      sku: r.sku,
      name: r.name,
      score: r.score,
      mismatched: r.mismatched ?? [],
      pack_size: r.pack_size,
    }));
    return { index, line, flags, candidates };
  });

  // 2. Decide the best match and flag what a rep must look at.
  const reviews: LineReview[] = matched.map(({ index, line, flags, candidates: raw }) => {
    const candidates = breakTies(line, raw);
    const [best, ...rest] = candidates;
    const hasSize = !flags.some((f) => f.code === "missing_size");
    const match = best && hasSize ? best : null;
    if (line.part_type !== "other" && hasSize && !best) {
      flags.push({ code: "no_match", message: "No part in the company catalogue has this thread and length. Do not substitute; ask the customer or source it." });
    }
    if (match) {
      if (match.score < 1) {
        flags.push({ code: "partial_match", message: `Best match differs on: ${match.mismatched.join(", ")}.` });
      }
      const ties = rest.filter((c) => c.score === match.score && c.style === match.style);
      if (ties.length) {
        flags.push({
          code: "ambiguous",
          message: `${ties.length + 1} parts fit what was written equally well (${[match, ...ties].map((c) => c.sku).join(", ")}). The RFQ does not say which.`,
        });
      }
    }
    const qty = qtyEach(line, match?.pack_size ?? best?.pack_size ?? null, flags);
    if (!Number.isInteger(qty) || qty < 1 || qty > UNUSUAL_QTY) {
      flags.push({ code: "unusual_quantity", message: `Quantity ${qty} looks wrong for this line; confirm it.` });
    }
    if (match && match.pack_size && Number.isInteger(qty) && qty > 0 && qty % match.pack_size !== 0) {
      const packs = Math.ceil(qty / match.pack_size);
      flags.push({ code: "pack_rounding", message: `Sold in packs of ${match.pack_size}: ${qty} rounds up to ${packs * match.pack_size} (${packs} packs).` });
    }
    return {
      index,
      line,
      qty_each: qty,
      match,
      alternatives: (match ? rest : candidates).slice(0, 2),
      stock: null,
      price: null,
      flags,
      status: "review",
    };
  });

  // 3. Stock and price for matched lines, in batches the tools accept.
  // Lines with an implausible quantity are not priced: a rep confirms the quantity first.
  const priced = reviews.filter((r) => r.match && Number.isInteger(r.qty_each) && r.qty_each > 0 && r.qty_each <= UNUSUAL_QTY);
  for (const batch of chunk(priced, 20)) {
    const qtyNeeded: Record<string, number> = {};
    for (const r of batch) qtyNeeded[r.match!.sku] = Math.max(qtyNeeded[r.match!.sku] ?? 0, r.qty_each);
    const skus = Object.keys(qtyNeeded);
    const res = await tools.call("check_availability", { skus, qty_needed: qtyNeeded });
    if (res.isError) throw new Error(`check_availability failed: ${res.data?.error?.message ?? "unknown error"}`);
    const bySku = new Map<string, StockRow>((res.data.items as StockRow[]).map((i) => [i.sku, i]));
    for (const r of batch) {
      const a = bySku.get(r.match!.sku);
      if (!a) continue;
      r.stock = { salable_qty: a.salable_qty, in_stock: a.in_stock, message: a.message };
      if (!a.in_stock) r.flags.push({ code: "out_of_stock", message: a.message });
      else if (a.salable_qty === null) r.flags.push({ code: "stock_unconfirmed", message: a.message });
      else if (a.salable_qty < r.qty_each) r.flags.push({ code: "short_stock", message: a.message });
    }
  }
  for (const batch of chunk(priced, 50)) {
    const apply = (rows: LineReview[], lines: PriceRow[]) =>
      rows.forEach((r, i) => {
        const p = lines[i];
        if (p && p.sku === r.match!.sku) {
          r.price = { unit_price: p.unit_price, line_total: p.line_total, currency: p.currency, price_source: p.price_source };
        }
      });
    const res = await tools.call("get_customer_price", { lines: batch.map((r) => ({ sku: r.match!.sku, qty: r.qty_each })) });
    if (!res.isError) {
      apply(batch, res.data.lines);
    } else {
      // The tool refuses a whole call when one SKU has no price. Ask line by line, so one unpriced part
      // flags only its own line and the rest of the RFQ is still priced.
      for (const r of batch) {
        const one = await tools.call("get_customer_price", { lines: [{ sku: r.match!.sku, qty: r.qty_each }] });
        if (!one.isError) apply([r], one.data.lines);
        else if (one.data?.error?.retryable) throw new Error(`get_customer_price failed: ${one.data.error.message}`);
      }
    }
  }

  for (const r of reviews) {
    if (r.match && !r.price && r.qty_each <= UNUSUAL_QTY) r.flags.push({ code: "no_price", message: "The store returned no price for this SKU and quantity." });
    else if (r.price && !(r.price.unit_price > 0)) r.flags.push({ code: "no_price", message: "The store's price for this SKU is zero. Confirm it before quoting." });
    r.status = r.match && !r.flags.some((f) => FLAG_SEVERITY[f.code] === "review") ? "ready" : "review";
  }
  return reviews;
}

export async function reviewRfq(doc: RfqDocument, extractor: Extractor, tools: CommerceTools): Promise<QuoteReview> {
  const { extraction, usage } = await extractor.extract(doc);
  const lines = await reviewLines(tools, extraction);
  const ready = lines.filter((l) => l.status === "ready");
  const subtotal = Math.round(ready.reduce((s, l) => s + (l.price?.line_total ?? 0), 0) * 100) / 100;
  return {
    document: doc.name,
    extractor: extractor.name,
    extraction,
    ...(usage ? { usage } : {}),
    lines,
    totals: {
      ready_lines: ready.length,
      review_lines: lines.length - ready.length,
      ready_subtotal: subtotal,
      currency: lines.find((l) => l.price)?.price?.currency ?? null,
    },
  };
}

export interface DraftOptions {
  /** Include matched lines that still have review flags, each with a review note. Default: ready lines only. */
  includeFlagged?: boolean;
  name?: string;
}

/** The exact input sent to draft_negotiable_quote. Preview and confirm must send identical input. */
export function draftInput(review: QuoteReview, opts: DraftOptions = {}) {
  const chosen = review.lines.filter((l) => l.match && (l.status === "ready" || opts.includeFlagged));
  // The tool rejects duplicate SKUs: merge lines that matched the same part.
  const bySku = new Map<string, { sku: string; qty: number; refs: string[]; flagged: boolean }>();
  for (const l of chosen) {
    const ref = l.line.line_ref ?? String(l.index + 1);
    const cur = bySku.get(l.match!.sku);
    if (cur) {
      cur.qty += l.qty_each;
      cur.refs.push(ref);
      cur.flagged ||= l.status === "review";
    } else {
      bySku.set(l.match!.sku, { sku: l.match!.sku, qty: l.qty_each, refs: [ref], flagged: l.status === "review" });
    }
  }
  for (const l of bySku.values()) {
    if (l.qty > MAX_LINE_QTY) {
      throw new Error(`Lines ${l.refs.join(", ")} match ${l.sku} and total ${l.qty}, over the quote tool's limit of ${MAX_LINE_QTY} for one SKU. Split them across two quotes or lower a quantity.`);
    }
  }
  const name = (opts.name ?? review.extraction.rfq_reference ?? `RFQ ${review.document}`).slice(0, 120);
  const skipped = review.lines.length - chosen.length;
  return {
    name,
    comment: `Drafted by the RFQ assistant from "${review.document}". ${skipped} line(s) left out for rep review.`.slice(0, 1000),
    lines: [...bySku.values()].map((l) => ({
      sku: l.sku,
      qty: l.qty,
      note: `${l.flagged ? "REVIEW: " : ""}RFQ line ${l.refs.join(", ")}`.slice(0, 255),
    })),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Read a saved run file. It is JSON a person may have edited or received, so check the parts the next steps rely on
 * (the quote it drafts and the corrections it records) instead of trusting a cast.
 */
export function parseRun(text: string): QuoteReview {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("The run file is not valid JSON.");
  }
  const bad = (why: string): never => {
    throw new Error(`The run file is not a saved review (${why}). Make one with: rfq-quote review <rfq>`);
  };
  if (!isObj(v) || typeof v.document !== "string" || !Array.isArray(v.lines) || !isObj(v.extraction)) return bad("missing document, lines or extraction");
  v.lines.forEach((l: unknown, i: number) => {
    if (!isObj(l) || !isObj(l.line) || typeof l.line.raw_text !== "string") return bad(`line ${i + 1} has no text`);
    if (typeof l.qty_each !== "number" || !Number.isFinite(l.qty_each)) return bad(`line ${i + 1} has no quantity`);
    if (l.status !== "ready" && l.status !== "review") return bad(`line ${i + 1} has no status`);
    if (!Array.isArray(l.flags)) return bad(`line ${i + 1} has no flags`);
    if (l.match !== null && l.match !== undefined && (!isObj(l.match) || typeof l.match.sku !== "string" || !/^[\x21-\x7e]{1,64}$/.test(l.match.sku))) return bad(`line ${i + 1} has an invalid SKU`);
  });
  return v as unknown as QuoteReview;
}
