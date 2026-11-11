import { describe, expect, it } from "vitest";
import { attributesFromText, parseFastenerText, scorePart } from "../src/normalize.js";
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

/**
 * Names written the way real catalogues write them (all invented, none from a
 * real store). The rule: a name that does not say what the part is, or names
 * something outside the taxonomy, gets null, never a guess. A wrong part type
 * can make a wrong line look like an exact match; null cannot.
 */
describe("catalogue-style product names", () => {
  const attrs = (name: string) => attributesFromText(name);

  it.each([
    // [name, expected subset]
    ["Hex Nut M10 x 1.0 Fine Pitch BZP", { part_type: "nut", thread: "M10", length_mm: null, pitch: 1, finish: "zinc" }],
    ["Hex Nut M12x1.25 A4", { part_type: "nut", thread: "M12", length_mm: null, pitch: 1.25, material: "stainless_a4" }],
    ["Hex Set Screw M10 x 1.25 x 40 Grade 8.8", { part_type: "screw", thread: "M10", pitch: 1.25, length_mm: 40, grade: "8.8" }],
    ["Socket Cap Screw M8-1.25 x 30 12.9", { part_type: "screw", thread: "M8", pitch: 1.25, length_mm: 30, head: "socket_cap" }],
    ["Grub Screw M3 x 3 A2", { thread: "M3", length_mm: 3, pitch: null }],
    ["Pan Head Machine Screw M2 x 2.5 A2", { thread: "M2", length_mm: 2.5, pitch: null, head: "pan" }],
    ["Hex Bolt M20 x 2.5 x 120 8.8", { thread: "M20", pitch: 2.5, length_mm: 120 }],
  ])("reads pitch apart from length: %s", (name, expected) => {
    expect(attrs(name)).toMatchObject(expected);
  });

  it.each([
    ["Screw Gudgeon 316 Stainless", { part_type: null }],
    ["Sleeve Anchor M8 x 30 BZP", { part_type: null, thread: "M8", length_mm: 30 }],
    ["Anchor Bolt M10 x 80 Zinc", { part_type: null }],
    ["Through Bolt M12 x 100 Wedge Anchor", { part_type: null }],
    ["Rivet Nut M6 Steel Zinc", { part_type: null }],
    ["Threaded Insert M8 Brass", { part_type: null }],
    ["Eye Bolt M10 x 20 Galvanised", { part_type: null }],
    ["U Bolt M8 x 50 x 100 A4", { part_type: null }],
    ["Carriage Bolt M8 x 60 BZP", { part_type: null }],
    ["Coach Bolt M10 x 100 HDG", { part_type: null }],
    ["Screw Cup No 8 Chrome", { part_type: null }],
    ["Nut Cover Cap M8 White", { part_type: null }],
  ])("does not claim a bolt, screw or nut for out-of-range items: %s", (name, expected) => {
    expect(attrs(name)).toMatchObject(expected);
  });

  it.each([
    ["Washer Head Screw M6 x 20 A2", { part_type: "screw" }],
    ["Washer Faced Hex Nut M8 Zinc", { part_type: "nut" }],
    ["Nylon Insert Lock Nut M10 A4", { part_type: "nut", material: "stainless_a4" }],
    ["Nylon Insert Nut M8 Zinc Plated", { part_type: "nut", material: null, finish: "zinc" }],
    ["Nylon Washer M10 White", { part_type: "washer", material: "nylon" }],
    ["Skt Cap Scr M6 x 25 A2", { part_type: "screw", head: "socket_cap", thread: "M6", length_mm: 25 }],
    ["C/Sunk Skt Scr M5 x 16 A4", { part_type: "screw", head: "countersunk" }],
    ["Hex Hd Set Scr M8 x 40 H/T", { part_type: "screw", head: "hex", grade: "8.8" }],
  ])("reads modifiers and trade abbreviations: %s", (name, expected) => {
    expect(attrs(name)).toMatchObject(expected);
  });

  it.each([
    ["Combination Spanner 13mm"],
    ["Hex Key 6mm Long Arm"],
    ["Tap M8 x 1.25 HSS Plug"],
    ["Socket Set 1/2in Drive 24pc"],
    ["Threadlocker Medium Strength 50ml"],
    ["Nut Driver 10mm Magnetic"],
  ])("does not read tools and chemicals as fasteners: %s", (name) => {
    expect(attrs(name)).toMatchObject({ part_type: null, head: null, length_mm: null });
  });
});

describe("scorePart and thread pitch", () => {
  const nut = (pitch: number | null): PartAttributes => ({
    part_type: "nut",
    head: null,
    thread: "M10",
    length_mm: null,
    material: "steel",
    grade: "8",
    finish: "zinc",
    standard: null,
    pitch,
  });

  it("never treats a coarse nut as a fine-pitch one the customer asked for", () => {
    const want = parseFastenerText("M10 x 1.0 nut zinc");
    expect(scorePart(nut(null), want)?.mismatched).toContain("pitch");
    expect(scorePart(nut(1), want)?.score).toBe(1);
  });

  it("does not offer a fine-pitch nut when no pitch was asked for, and accepts a stated coarse pitch", () => {
    expect(scorePart(nut(1), parseFastenerText("M10 nut zinc"))?.mismatched).toContain("pitch");
    expect(scorePart(nut(null), parseFastenerText("M10 nut zinc"))?.score).toBe(1);
    expect(scorePart(nut(null), parseFastenerText("M10 x 1.5 nut zinc"))?.score).toBe(1);
    expect(scorePart(nut(1.5), parseFastenerText("M10 nut zinc"))?.score).toBe(1);
  });
});
