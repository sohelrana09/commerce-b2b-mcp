import type { PartAttributes } from "../types.js";
import type { FixtureProduct } from "./fixtures.js";

/**
 * A generated reference catalogue of a few hundred metric fasteners, used by
 * the "Harbour Fixings" mock company. It is big enough to make RFQ matching
 * realistic (many near-identical SKUs) and fully deterministic, so the
 * matching eval gives the same numbers on every run and in CI.
 *
 * Prices, stock and pack sizes are invented. No real merchant data.
 */

interface Spec {
  code: string;
  material: PartAttributes["material"];
  grade: string | null;
  finish: PartAttributes["finish"];
  label: string;
  price: number; // multiplier on the steel/zinc base price
}

const SPECS: Spec[] = [
  { code: "88Z", material: "steel", grade: "8.8", finish: "zinc", label: "Grade 8.8 Zinc Plated", price: 1 },
  { code: "88G", material: "steel", grade: "8.8", finish: "hot_dip_galvanised", label: "Grade 8.8 Hot-Dip Galvanised", price: 1.5 },
  { code: "109", material: "steel", grade: "10.9", finish: "plain", label: "Grade 10.9 Self Colour", price: 1.4 },
  { code: "A2", material: "stainless_a2", grade: "A2-70", finish: "plain", label: "A2 Stainless", price: 2.6 },
  { code: "A4", material: "stainless_a4", grade: "A4-70", finish: "plain", label: "A4 Marine Stainless", price: 3.6 },
];

const SOCKET_SPECS: Spec[] = [
  { code: "129", material: "steel", grade: "12.9", finish: "plain", label: "Grade 12.9 Black", price: 1.3 },
  SPECS[3]!,
  SPECS[4]!,
];

// Base price per piece for steel/zinc by thread, before length.
const THREAD_BASE: Record<string, number> = { M5: 0.03, M6: 0.04, M8: 0.07, M10: 0.11, M12: 0.17, M16: 0.38, M20: 0.7 };

type Family = {
  prefix: string;
  part_type: NonNullable<PartAttributes["part_type"]>;
  head: PartAttributes["head"];
  noun: string;
  standard: string;
  threads: string[];
  lengths: (thread: string) => number[];
  specs: Spec[];
  pack: (thread: string) => number;
};

const lengthsFrom = (from: number, to: number, step: number) => {
  const out: number[] = [];
  for (let l = from; l <= to; l += step) out.push(l);
  return out;
};

const FAMILIES: Family[] = [
  {
    prefix: "HSS",
    part_type: "screw",
    head: "hex",
    noun: "Hex Set Screw",
    standard: "ISO 4017",
    threads: ["M6", "M8", "M10", "M12"],
    lengths: (t) => ({ M6: [16, 20, 25, 30], M8: [16, 20, 25, 30, 40], M10: [20, 25, 30, 40, 50], M12: [25, 30, 40, 50] })[t] ?? [],
    specs: SPECS.filter((s) => s.code !== "88G"),
    pack: (t) => (t === "M12" ? 50 : 100),
  },
  {
    prefix: "HXB",
    part_type: "bolt",
    head: "hex",
    noun: "Hex Bolt",
    standard: "ISO 4014",
    threads: ["M8", "M10", "M12", "M16", "M20"],
    lengths: (t) =>
      ({ M8: [40, 50, 60, 80], M10: [50, 60, 70, 80, 100], M12: [50, 60, 80, 100, 120], M16: [60, 80, 100, 150], M20: [80, 100, 150] })[t] ?? [],
    specs: SPECS,
    pack: (t) => (t === "M16" || t === "M20" ? 25 : 50),
  },
  {
    prefix: "SHC",
    part_type: "screw",
    head: "socket_cap",
    noun: "Socket Cap Screw",
    standard: "ISO 4762",
    threads: ["M5", "M6", "M8", "M10"],
    lengths: (t) => ({ M5: [10, 16, 20], M6: [12, 16, 20, 25, 30], M8: [16, 20, 25, 30, 40], M10: [20, 30, 40] })[t] ?? [],
    specs: SOCKET_SPECS,
    pack: () => 100,
  },
  {
    prefix: "CSK",
    part_type: "screw",
    head: "countersunk",
    noun: "Countersunk Socket Screw",
    standard: "ISO 10642",
    threads: ["M5", "M6", "M8"],
    lengths: (t) => ({ M5: [12, 16, 20], M6: [16, 20, 25], M8: [20, 25, 30] })[t] ?? [],
    specs: [SPECS[3]!, SPECS[4]!, { ...SOCKET_SPECS[0]!, code: "109B", grade: "10.9", label: "Grade 10.9 Black" }],
    pack: () => 100,
  },
];

const NUT_THREADS = ["M5", "M6", "M8", "M10", "M12", "M16", "M20"];

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Small deterministic hash, so stock and prices are stable across runs. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

function tiersFor(sku: string, base: number) {
  return hash(`${sku}:tier`) < 0.6
    ? [
        { min_qty: 1000, unit_price: round(base * 0.88) },
        { min_qty: 5000, unit_price: round(base * 0.78) },
      ]
    : [];
}

function build(): FixtureProduct[] {
  const out: FixtureProduct[] = [];

  for (const f of FAMILIES) {
    for (const thread of f.threads) {
      for (const length of f.lengths(thread)) {
        for (const spec of f.specs) {
          // Galvanised parts start at M10 in this catalogue, as in most UK ranges.
          if (spec.finish === "hot_dip_galvanised" && ["M5", "M6", "M8"].includes(thread)) continue;
          const sku = `${f.prefix}-${thread}-${length}-${spec.code}`;
          const base = round((THREAD_BASE[thread] ?? 0.1) * spec.price * (1 + length / 100));
          out.push({
            sku,
            name: `${f.noun} ${thread} x ${length} ${spec.label}`,
            attributes: {
              part_type: f.part_type,
              head: f.head,
              thread,
              length_mm: length,
              material: spec.material,
              grade: spec.grade,
              finish: spec.finish,
              standard: f.standard,
            },
            base_price: base,
            tiers: tiersFor(sku, base),
            pack_size: f.pack(thread),
            uom: "each",
            description: `${f.standard} ${f.noun.toLowerCase()}, ${spec.label.toLowerCase()}.`,
          });
        }
      }
    }
  }

  for (const thread of NUT_THREADS) {
    for (const spec of SPECS.filter((s) => s.code !== "109")) {
      if (spec.finish === "hot_dip_galvanised" && ["M5", "M6", "M8"].includes(thread)) continue;
      const nutGrade = spec.material === "steel" ? "8" : spec.grade;
      const label = spec.label.replace("Grade 8.8", "Grade 8");
      const base = round((THREAD_BASE[thread] ?? 0.1) * spec.price * 0.6);
      const sku = `NUT-${thread}-${spec.code}`;
      out.push({
        sku,
        name: `Hex Nut ${thread} ${label}`,
        attributes: { part_type: "nut", head: null, thread, length_mm: null, material: spec.material, grade: nutGrade, finish: spec.finish, standard: "ISO 4032" },
        base_price: base,
        tiers: tiersFor(sku, base),
        pack_size: 100,
        uom: "each",
        description: `ISO 4032 full hex nut, ${label.toLowerCase()}.`,
      });

      const nyloc = `NYL-${thread}-${spec.code}`;
      if (spec.finish !== "hot_dip_galvanised") {
        out.push({
          sku: nyloc,
          name: `Nyloc Nut ${thread} ${label}`,
          attributes: { part_type: "nut", head: null, thread, length_mm: null, material: spec.material, grade: nutGrade, finish: spec.finish, standard: "DIN 985" },
          base_price: round(base * 1.6),
          tiers: tiersFor(nyloc, base * 1.6),
          pack_size: 100,
          uom: "each",
          description: `DIN 985 nylon insert lock nut, ${label.toLowerCase()}.`,
        });
      }

      const washer = `WSH-${thread}-${spec.code}`;
      out.push({
        sku: washer,
        name: `Flat Washer ${thread} ${spec.label.replace(/Grade 8\.8 /, "")}`,
        attributes: { part_type: "washer", head: null, thread, length_mm: null, material: spec.material, grade: null, finish: spec.finish, standard: "ISO 7089" },
        base_price: round(base * 0.4),
        tiers: [],
        pack_size: 200,
        uom: "each",
        description: `ISO 7089 form A flat washer, ${spec.label.replace(/Grade 8\.8 /, "").toLowerCase()}.`,
      });
    }
  }

  for (const thread of ["M8", "M10", "M12", "M16"]) {
    for (const spec of [
      { code: "Z", material: "steel" as const, grade: "4.6", finish: "zinc" as const, label: "Grade 4.6 Zinc" },
      { code: "A2", material: "stainless_a2" as const, grade: "A2-70", finish: "plain" as const, label: "A2 Stainless" },
    ]) {
      const sku = `ROD-${thread}-1000-${spec.code}`;
      const base = round((THREAD_BASE[thread] ?? 0.1) * 14 * (spec.code === "A2" ? 2.8 : 1));
      out.push({
        sku,
        name: `Threaded Rod ${thread} x 1000 ${spec.label}`,
        attributes: { part_type: "threaded_rod", head: null, thread, length_mm: 1000, material: spec.material, grade: spec.grade, finish: spec.finish, standard: "DIN 976" },
        base_price: base,
        tiers: [{ min_qty: 50, unit_price: round(base * 0.9) }],
        pack_size: 10,
        uom: "each",
        description: `DIN 976 metre-length studding, ${spec.label.toLowerCase()}.`,
      });
    }
  }
  return out;
}

/** SKUs carry an HF- prefix so they never collide with the hand-written demo fixtures. */
export const REFERENCE_PRODUCTS: FixtureProduct[] = build().map((p) => ({ ...p, sku: `HF-${p.sku}` }));

/** Every reference product is visible to Harbour; about 1 in 5 has a negotiated price. */
export const REFERENCE_CATALOG_PRICES: Record<string, number | null> = Object.fromEntries(
  REFERENCE_PRODUCTS.map((p) => [p.sku, hash(`${p.sku}:contract`) < 0.2 ? round(p.base_price * 0.85) : null]),
);

/**
 * Stock by source. Roughly 8% of SKUs are out of stock everywhere and 15%
 * only exist at the slow supplier source, so the assistant has real
 * shortfalls and lead times to flag.
 */
export function referenceStock(sources: string[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = Object.fromEntries(sources.map((s) => [s, {}]));
  for (const p of REFERENCE_PRODUCTS) {
    const r = hash(`${p.sku}:stock`);
    if (r < 0.08) continue;
    const big = Math.round(500 + hash(`${p.sku}:qty`) * 20000);
    if (r < 0.23) {
      out[sources[sources.length - 1]!]![p.sku] = big;
      continue;
    }
    out[sources[0]!]![p.sku] = big;
    if (r > 0.6 && sources[1]) out[sources[1]]![p.sku] = Math.round(big / 3);
  }
  return out;
}

export const REFERENCE_RESERVATIONS: Record<string, number> = Object.fromEntries(
  REFERENCE_PRODUCTS.filter((p) => hash(`${p.sku}:res`) < 0.1).map((p) => [p.sku, 300]),
);
