import { parseFastenerText } from "../../normalize.js";
import type { ExtractedLine, Extraction, Extractor, RfqDocument } from "./schema.js";

/**
 * Rule-based intake, with no model call. It is the baseline the Claude
 * extractor is measured against, and it lets the demo run with no API key.
 * It reads one item per text line, or the rows of a CSV.
 */
const FASTENER = /\b(m\s?\d+(\.\d+)?(\s*[x*×]\s*\d+(\.\d+)?(mm)?)?|bolts?|screws?|setscrews?|nuts?|nyloc|washers?|studding|threaded rod|all[- ]thread|shcs|csk)\b/i;
const TENTATIVE = /\?|\b(about|approx|approximately|around|roughly|say|circa|maybe|tbc)\b/i;
const NUMBER = (s: string) => Number(s.replace(/,/g, ""));

function quantityOf(text: string): Pick<ExtractedLine, "quantity" | "unit" | "units_per_pack"> | null {
  // Remove the size so "M8 x 30" is not read as a quantity.
  const t = text
    .toLowerCase()
    .replace(/\bm\s?\d+(\.\d+)?\s*[x*×]\s*\d+(\.\d+)?(\s?mm)?\b/g, " ")
    .replace(/\bm\s?\d+(\.\d+)?\b/g, " ")
    .replace(/\b\d+(\.\d+)?\s?mm\b/g, " ")
    .replace(/\b(4\.6|8\.8|10\.9|12\.9|a[24]-[78]0|304|316|18-8)\b/g, " ")
    .replace(/\b(iso|din)\s?\d+\b/g, " ");

  let m = t.match(/(\d[\d,]*)\s*(boxes|box|packs|pack|bags|bag)\s*(of|x|@)\s*(\d[\d,]*)/);
  if (m) return { quantity: NUMBER(m[1]!), unit: unitWord(m[2]!), units_per_pack: NUMBER(m[4]!) };
  m = t.match(/(\d[\d,]*)\s*(boxes|box|packs|pack|bags|bag)\b/);
  if (m) return { quantity: NUMBER(m[1]!), unit: unitWord(m[2]!), units_per_pack: null };
  m = t.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (m) return { quantity: Math.round(Number(m[1]) * 1000), unit: "each", units_per_pack: null };
  m = t.match(/(?:qty|quantity)\s*[:=]?\s*(\d[\d,]*)/) ?? t.match(/(\d[\d,]*)\s*(?:pcs|pieces|off|no\.?|nos|each|ea)\b/) ?? t.match(/\bx\s?(\d[\d,]*)\b/);
  if (m) return { quantity: NUMBER(m[1]!), unit: "each", units_per_pack: null };
  const nums = [...t.matchAll(/\b(\d[\d,]*)\b/g)].map((x) => NUMBER(x[1]!)).filter((n) => n > 0);
  const last = nums.at(-1);
  return last ? { quantity: last, unit: "each", units_per_pack: null } : null;
}

function unitWord(w: string): ExtractedLine["unit"] {
  if (w.startsWith("box")) return "box";
  if (w.startsWith("pack")) return "pack";
  return "bag";
}

/** Minimal CSV row split that respects double quotes ("2,000 off" stays one field). */
function csvFields(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of row) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** One candidate item per row: CSV rows become "ref. description - qty", table rows lose their pipes. */
function splitRows(doc: Extract<RfqDocument, { kind: "text" }>): string[] {
  const rows = doc.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (/\.csv$/i.test(doc.name)) {
    return rows.slice(1).map((r) => {
      const [first = "", ...rest] = csvFields(r);
      return /^\d{1,3}$/.test(first) ? `${first}. ${rest.join(" - ")}` : [first, ...rest].join(" - ");
    });
  }
  return rows.map((r) => (r.startsWith("|") ? r.replace(/^\|\s*/, "").replace(/\s*\|\s*$/, "").replace(/\s*\|\s*/g, " - ") : r));
}

export class HeuristicExtractor implements Extractor {
  readonly name = "heuristic";

  async extract(doc: RfqDocument): Promise<{ extraction: Extraction }> {
    if (doc.kind !== "text") throw new Error("The heuristic extractor reads text and CSV only. Use the Claude extractor for PDFs.");
    const lines: ExtractedLine[] = [];
    for (const row of splitRows(doc)) {
      if (!FASTENER.test(row)) continue;
      const ref = row.match(/^\s*(\d{1,3})\s*[.)\]:-]\s+/);
      const body = ref ? row.slice(ref[0].length) : row;
      const q = quantityOf(body);
      if (!q) continue;
      const p = parseFastenerText(body);
      const material: ExtractedLine["material"] =
        p.material === "stainless" || (!p.material && p.stainless_any) ? "stainless_unspecified" : (p.material ?? null);
      lines.push({
        line_ref: ref?.[1] ?? null,
        raw_text: row,
        description: body,
        part_type: p.part_type ?? null,
        head: p.head ?? null,
        thread: p.thread ?? null,
        length_mm: p.length_mm ?? null,
        material,
        grade: p.grade ?? null,
        finish: p.finish ?? null,
        ...q,
        ...(TENTATIVE.test(body)
          ? { uncertain: true, uncertainty_reason: "The quantity or item is tentative (\"about\", \"say\", a question mark)." }
          : { uncertain: false, uncertainty_reason: null }),
      });
    }
    return { extraction: { rfq_reference: null, customer_name: null, lines, other_requests: [], suspicious_instructions: [] } };
  }
}
