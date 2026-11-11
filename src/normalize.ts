import type { Material, PartAttributes, SearchQuery } from "./backend/types.js";

/**
 * Fastener query normaliser.
 *
 * Turns free text such as "M8x30 SS hex" or "m8 x 30 316 setscrew" into
 * structured attribute filters. Explicit filters from the caller always win
 * over anything parsed from text.
 */

type Parsed = SearchQuery["filters"] & { stainless_any?: boolean; pitch?: number };

/** ISO metric pitches, coarse and fine. */
const ISO_PITCHES = new Set([0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.75, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4]);
/** ISO 261 coarse pitch by diameter: what a thread with no stated pitch is. */
const COARSE_PITCH: Record<string, number> = {
  "M1.6": 0.35, "M2": 0.4, "M2.5": 0.45, "M3": 0.5, "M4": 0.7, "M5": 0.8, "M6": 1, "M8": 1.25, "M10": 1.5, "M12": 1.75, "M14": 2, "M16": 2,
  "M18": 2.5, "M20": 2.5, "M22": 2.5, "M24": 3, "M27": 3, "M30": 3.5, "M33": 3.5, "M36": 4,
};
export const coarsePitch = (thread: string | null | undefined) => (thread ? COARSE_PITCH[thread] : undefined);

/**
 * Words that name something outside the part types this server knows (bolt,
 * screw, nut, washer, threaded rod), even though they contain one of those
 * words: a "Screw Gudgeon" is a hinge pin, an "Anchor Bolt" goes in concrete,
 * a "Rivet Nut" is an insert. Such names get no part type, so they can never
 * look like an exact match for a plain bolt, screw or nut.
 */
const OUT_OF_RANGE =
  /\b(gudgeons?|pintles?|hinges?|anchors?|through[- ]bolts?|rivet[- ]?nuts?|rivnuts?|nutserts?|inserts?|rivets?|eye[- ]?bolts?|u[- ]bolts?|j[- ]bolts?|hook[- ]bolts?|carriage[- ]bolts?|coach[- ]bolts?|coach[- ]screws?|cup[- ]square|screw[- ]cups?|nut[- ]covers?|cover[- ]caps?)\b/;

/** Tools and chemicals sold beside fasteners. Their sizes ("Spanner 13mm") are not fastener sizes. */
const NOT_A_FASTENER =
  /\b(spanners?|wrench(es)?|keys?|drivers?|bits?|taps?|dies?|drills?|socket[- ]sets?|threadlock(er)?s?|loctite|sealants?|grease|adhesives?|cable[- ]ties?|pliers)\b/;

/**
 * Rewrites applied before reading head and type: trade abbreviations, and
 * modifiers that contain a type word without being that type ("washer head
 * screw" is a screw, "nylon insert nut" is a nyloc nut, not a nylon part).
 */
const REWRITES: Array<[RegExp, string]> = [
  [/\bnylon[- ]insert(ed)?\b/g, "nyloc"],
  [/\bwasher[- ](head(ed)?|faced?)\b/g, " "],
  [/(?<![\w/])c\/s(?:unk)?(?![\w/])/g, "countersunk"],
  [/\bskt\b/g, "socket"],
  [/\bscr\b/g, "screw"],
  [/(?<![\w/])h\/t(?![\w/])/g, "8.8"],
];

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
  let text = raw.toLowerCase().replace(/×/g, "x");
  for (const [re, to] of REWRITES) text = text.replace(re, to);
  const out: Parsed = {};

  // M8x30, M8 x 30, M8*30, M 8 x 30; with a pitch: M10 x 1.25, M8-1.25 x 30, M10 x 1.25 x 40
  const size = text.match(/\bm\s?(\d+(?:\.\d+)?)\s*([x*-])\s*(\d+(?:\.\d+)?)\b(?:\s*[x*]\s*(\d+(?:\.\d+)?)\b)?/);
  const d = size ? Number(size[1]) : 0;
  const second = size ? Number(size[3]) : 0;
  // A pitch is a standard ISO pitch no bigger than a quarter of the diameter: M10 x 1.25 is a pitch, M3 x 3 and M2 x 2.5 are lengths.
  const isPitch = size !== null && ISO_PITCHES.has(second) && second <= d / 4;
  if (size && (isPitch || size[2] !== "-")) {
    out.thread = `M${size[1]}`;
    if (isPitch) {
      out.pitch = second;
      if (size[4]) out.length_mm = Number(size[4]);
    } else out.length_mm = second;
  } else {
    const thread = text.match(/\bm\s?(\d+(?:\.\d+)?)\b/);
    if (thread) out.thread = `M${thread[1]}`;
    const len = text.match(/\b(\d+(?:\.\d+)?)\s?mm\b/);
    if (len) out.length_mm = Number(len[1]);
  }

  if (NOT_A_FASTENER.test(text)) {
    // Keep only the thread a tool is for ("Tap M8"); nothing else describes a fastener.
    const keep: Parsed = {};
    if (out.thread) keep.thread = out.thread;
    if (out.pitch !== undefined) keep.pitch = out.pitch;
    return keep;
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

  const type = OUT_OF_RANGE.test(text) ? undefined : first(text, TYPE_WORDS);
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
  pitch: 2,
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
  // Pitch: unstated means coarse, on both sides. Check it when either side names a pitch that is not the coarse one,
  // so a fine-pitch nut never stands in for a plain one, and a coarse nut never for the fine pitch a customer asked for.
  const coarse = coarsePitch(want.thread ?? attrs.thread);
  const fineOffered = attrs.pitch !== undefined && attrs.pitch !== null && attrs.pitch !== coarse;
  if (want.pitch !== undefined || fineOffered) check("pitch", (want.pitch ?? coarse) === (attrs.pitch ?? coarse));
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
    pitch: p.pitch ?? null,
  };
}
