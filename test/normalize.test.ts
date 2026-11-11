import { describe, expect, it } from "vitest";
import { parseFastenerText, scorePart } from "../src/normalize.js";
import type { PartAttributes } from "../src/backend/types.js";

describe("parseFastenerText", () => {
  it.each([
    ["M8x30 SS hex", { thread: "M8", length_mm: 30, stainless_any: true, head: "hex" }],
    ["m8 x 30 316 setscrew", { thread: "M8", length_mm: 30, material: "stainless_a4", part_type: "screw", head: "hex" }],
    ["M10*50 8.8 BZP bolts", { thread: "M10", length_mm: 50, grade: "8.8", material: "steel", finish: "zinc", part_type: "bolt" }],
    ["M8 A2 nuts", { thread: "M8", material: "stainless_a2", part_type: "nut" }],
    ["M6 × 20 socket cap A2", { thread: "M6", length_mm: 20, material: "stainless_a2", head: "socket_cap" }],
    ["M10 x 50 HDG", { thread: "M10", length_mm: 50, finish: "hot_dip_galvanised" }],
  ])("%s", (text, expected) => {
    expect(parseFastenerText(text)).toEqual(expected);
  });
});

describe("scorePart", () => {
  const a4: PartAttributes = {
    part_type: "bolt",
    head: "hex",
    thread: "M8",
    length_mm: 30,
    material: "stainless_a4",
    grade: "A4-70",
    finish: "plain",
    standard: null,
  };

  it("treats wrong length as a hard fail", () => {
    expect(scorePart(a4, { thread: "M8", length_mm: 40 })).toBeNull();
  });

  it("accepts either stainless grade for SS", () => {
    expect(scorePart(a4, { thread: "M8", length_mm: 30, stainless_any: true })?.score).toBe(1);
  });

  it("reports partial matches", () => {
    const s = scorePart(a4, { thread: "M8", length_mm: 30, material: "stainless_a2" });
    expect(s?.mismatched).toEqual(["material"]);
    expect(s!.score).toBeLessThan(1);
  });
});
