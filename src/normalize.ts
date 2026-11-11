import type { Material, PartAttributes, SearchQuery } from "./backend/types.js";

/**
 * Fastener query normaliser.
 *
 * Turns free text such as "M8x30 SS hex" or "m8 x 30 316 setscrew" into
 * structured attribute filters. Explicit filters from the caller always win
 * over anything parsed from text.
 */

type Parsed = SearchQuery["filters"] & { stainless_any?: boolean };

const MATERIAL_WORDS: Array<[RegExp, Material | "stainless_any"]> = [
  [/\b(a4|316|a4-70|a4-80|marine)\b/, "stainless_a4"],
  [/\b(a2|304|18-8|a2-70)\b/, "stainless_a2"],
  [/\b(ss|s\/s|stainless|inox)\b/, "stainless_any"],
  [/\b(brass)\b/, "brass"],
  [/\b(nylon|plastic)\b/, "nylon"],
];

const FINISH_WORDS: Array<[RegExp, PartAttributes["finish"]]> = [
  [/\b(bzp|zp|zinc|zinc[- ]plated)\b/, "zinc"],
  [/\b(hdg|galv|galvanised|galvanized)\b/, "hot_dip_galvanised"],
  [/\b(self[- ]colou?r|plain|black)\b/, "plain"],
];

const HEAD_WORDS: Array<[RegExp, NonNullable<PartAttributes["head"]>]> = [
  // Countersunk first: "csk socket screw" is a countersunk socket screw, not a socket cap.
  [/\b(csk|countersunk|countersink)\b/, "countersunk"],
  [/\b(socket|cap|shcs|allen)\b/, "socket_cap"],
  [/\b(pan)\b/, "pan"],
  [/\b(hex|hexagon|hh|setscrew|set screw)\b/, "hex"],
];

const TYPE_WORDS: Array<[RegExp, PartAttributes["part_type"]]> = [
  [/\b(nut|nuts)\b/, "nut"],
  [/\b(washer|washers)\b/, "washer"],
  [/\b(studding|threaded rod|all[- ]thread)\b/, "threaded_rod"],
  [/\b(setscrew|set screw|screw|screws|shcs)\b/, "screw"],
  [/\b(bolt|bolts)\b/, "bolt"],
];

function first<T>(text: string, table: Array<[RegExp, T]>): T | undefined {
  for (const [re, value] of table) if (re.test(text)) return value;
  return undefined;
}

export function parseFastenerText(raw: string): Parsed {
  const text = raw.toLowerCase().replace(/×/g, "x");
  const out: Parsed = {};

  // M8x30, M8 x 30, M8*30, M 8 x 30
  const size = text.match(/\bm\s?(\d+(?:\.\d+)?)\s*[x*]\s*(\d+(?:\.\d+)?)\b/);
  if (size) {
    out.thread = `M${size[1]}`;
    out.length_mm = Number(size[2]);
  } else {
    const thread = text.match(/\bm\s?(\d+(?:\.\d+)?)\b/);
    if (thread) out.thread = `M${thread[1]}`;
    const len = text.match(/\b(\d+(?:\.\d+)?)\s?mm\b/);
    if (len) out.length_mm = Number(len[1]);
  }

  const grade = text.match(/\b(4\.6|8\.8|10\.9|12\.9)\b/) ?? text.match(/\b(a[24]-(?:50|70|80))\b/);
  if (grade) out.grade = grade[1]!.toUpperCase();

  const material = first(text, MATERIAL_WORDS);
  if (material === "stainless_any") out.stainless_any = true;
  else if (material) out.material = material;
  else if (out.grade) out.material = "steel";

  const finish = first(text, FINISH_WORDS);
  if (finish) out.finish = finish;

  const head = first(text, HEAD_WORDS);
  if (head) out.head = head;

  const type = first(text, TYPE_WORDS);
  if (type) out.part_type = type;

  return out;
}

export interface MatchScore {
  score: number; // 0..1
  matched: string[];
  mismatched: string[];
}

const WEIGHTS: Record<string, number> = {
  thread: 3,
  length_mm: 3,
  material: 2,
  part_type: 2,
  head: 1,
  grade: 1,
  finish: 1,
};

/**
 * Score how well a part satisfies parsed filters. A mismatch on thread or
 * length is a hard fail: an M8x30 is never an acceptable substitute for M8x40.
 */
export function scorePart(attrs: PartAttributes, want: Parsed): MatchScore | null {
  let total = 0;
  let got = 0;
  const matched: string[] = [];
  const mismatched: string[] = [];

  const check = (key: string, ok: boolean) => {
    const w = WEIGHTS[key] ?? 1;
    total += w;
    if (ok) {
      got += w;
      matched.push(key);
    } else mismatched.push(key);
  };

  if (want.thread !== undefined) check("thread", attrs.thread === want.thread);
  if (want.length_mm !== undefined) check("length_mm", attrs.length_mm === want.length_mm);
  if (want.material !== undefined) check("material", attrs.material === want.material);
  else if (want.stainless_any) check("material", attrs.material?.startsWith("stainless") ?? false);
  if (want.part_type !== undefined && want.part_type !== null) {
    // Trade usage blurs bolt vs. screw for hex heads; treat them as compatible.
    const boltish = new Set(["bolt", "screw"]);
    const got = attrs.part_type;
    check("part_type", got === want.part_type || (got !== null && boltish.has(got) && boltish.has(want.part_type)));
  }
  // Head type only distinguishes bolts and screws; "hex nut" says nothing a nut's attributes can mismatch.
  const headless = attrs.head === null && (attrs.part_type === "nut" || attrs.part_type === "washer" || attrs.part_type === "threaded_rod");
  if (want.head !== undefined && !headless) check("head", attrs.head === want.head);
  if (want.grade !== undefined) check("grade", attrs.grade === want.grade);
  if (want.finish !== undefined) check("finish", attrs.finish === want.finish);

  if (mismatched.includes("thread") || mismatched.includes("length_mm")) return null;
  return { score: total === 0 ? 0 : Math.round((got / total) * 100) / 100, matched, mismatched };
}

/**
 * Derive structured attributes from free text (a product name, or attribute
 * labels joined together). Used for stores whose catalogue doesn't carry
 * fastener attributes in a known shape. Unknown values stay null rather
 * than being guessed.
 */
export function attributesFromText(text: string): PartAttributes {
  const p = parseFastenerText(text);
  return {
    part_type: p.part_type ?? null,
    head: p.head ?? null,
    thread: p.thread ?? null,
    length_mm: p.length_mm ?? null,
    material: p.material ?? (p.stainless_any ? "stainless" : null),
    grade: p.grade ?? null,
    finish: p.finish ?? null,
    standard: text.match(/\b(ISO|DIN)\s?(\d{3,5})\b/i)?.slice(1, 3).join(" ").toUpperCase() ?? null,
  };
}
