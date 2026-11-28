import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HeuristicExtractor } from "../src/assistant/extract/heuristic.js";
import { inProcessTools } from "../src/assistant/in-process.js";
import { applyEdits, draftInput, reviewRfq } from "../src/assistant/pipeline.js";
import { ReviewStore } from "../src/assistant/reviews.js";
import { MemoryStore } from "../src/http/state.js";

const golden = (f: string) => readFileSync(join(import.meta.dirname, "..", "evals", "golden", f), "utf8");

async function sampleReview() {
  const tools = await inProcessTools();
  const review = await reviewRfq({ kind: "text", name: "rfq-01", text: golden("rfq-01-email.txt") }, new HeuristicExtractor(), tools);
  return { tools, review };
}

describe("applyEdits", () => {
  it("lets a rep settle a flagged line with an offered part, re-priced from the store", async () => {
    const { tools, review } = await sampleReview();
    try {
      const line = review.lines.find((l) => l.status === "review" && (l.match || l.alternatives.length))!;
      expect(line).toBeDefined();
      const pick = (line.match ?? line.alternatives[0])!;
      const next = await applyEdits(review, [{ index: line.index, sku: pick.sku, qty_each: 100 }], tools);
      const l = next.lines[line.index]!;
      expect(l).toMatchObject({ rep_confirmed: true, qty_each: 100, match: { sku: pick.sku } });
      expect(l.price?.unit_price).toBeGreaterThan(0);
      expect(l.status).toBe("ready");
      expect(draftInput(next).lines.find((d) => d.sku === pick.sku)?.note).toMatch(/rep confirmed/);
      // The original review is untouched.
      expect(review.lines[line.index]!.rep_confirmed).toBeUndefined();
    } finally {
      await tools.close();
    }
  });

  it("refuses a part the matcher never offered, and an impossible quantity", async () => {
    const { tools, review } = await sampleReview();
    try {
      const line = review.lines.find((l) => l.match)!;
      await expect(applyEdits(review, [{ index: line.index, sku: "NOT-OFFERED-1" }], tools)).rejects.toThrow(/was not offered/);
      await expect(applyEdits(review, [{ index: line.index, sku: line.match!.sku, qty_each: 0 }], tools)).rejects.toThrow(/whole number/);
    } finally {
      await tools.close();
    }
  });

  it("leaves an excluded line out of the draft", async () => {
    const { tools, review } = await sampleReview();
    try {
      const ready = review.lines.find((l) => l.status === "ready")!;
      const next = await applyEdits(review, [{ index: ready.index, sku: null }], tools);
      expect(next.lines[ready.index]).toMatchObject({ rep_excluded: true, match: null, status: "review" });
      expect(next.totals.ready_lines).toBe(review.totals.ready_lines - 1);
    } finally {
      await tools.close();
    }
  });
});

describe("ReviewStore", () => {
  it("keeps one queue per user, newest first, and forgets old entries", async () => {
    let t = Date.parse("2026-11-01T00:00:00Z");
    const store = new ReviewStore(new MemoryStore({ now: () => t }), 14, () => t);
    const { tools, review } = await sampleReview();
    await tools.close();
    const a = await store.create("Sam@Harbour.example", "inbox", "first", review);
    t += 3 * 24 * 3600_000;
    const b = await store.create("sam@harbour.example", "upload", "second", review);
    await store.create("jane@northwind.example", "upload", "jane's", review);
    expect((await store.list("sam@harbour.example")).map((r) => r.title)).toEqual(["second", "first"]);
    expect(await store.get("jane@northwind.example", a.id)).toBeUndefined();
    expect(await store.forget("sam@harbour.example", 2)).toBe(1);
    expect((await store.list("sam@harbour.example")).map((r) => r.id)).toEqual([b.id]);
    // Past the retention period the entry is gone.
    t += 15 * 24 * 3600_000;
    expect(await store.list("sam@harbour.example")).toEqual([]);
  });
});
