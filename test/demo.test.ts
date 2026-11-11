import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDemo } from "../src/demo.js";

async function capture(args: string[]): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  await runDemo(args);
  return lines.join("\n");
}

afterEach(() => vi.restoreAllMocks());

describe("demo", () => {
  it("reviews the sample RFQ and previews a draft without saving it", async () => {
    const out = await capture([]);
    expect(out).toContain("11 lines: 8 ready, 3 need review. Ready subtotal GBP 3161.00");
    expect(out).toMatch(/10 {2}10\. M10 hex bolts 8\.8 zinc - 500 off\s+500\s+-\s+-\s+-\s+review/);
    expect(out).toContain("No length stated.");
    expect(out).toContain("Subtotal GBP 3161.00");
    expect(out).toContain("Not saved.");
    // No Markdown in the terminal layout.
    expect(out).not.toMatch(/\*\*|`/);
  });

  it("strips terminal escape sequences from a customer's RFQ file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-test-"));
    const file = join(dir, "rfq.txt");
    writeFileSync(file, "Please quote:\n\x1b]0;owned\x07M8x30 A4 hex setscrew - 100 off\x1b[2J\n");
    const out = await capture(["--rfq", file]);
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).toContain("M8x30 A4 hex setscrew - 100 off");
  });

  it("explains a missing file instead of failing with ENOENT", async () => {
    await expect(runDemo(["--rfq", "/no/such/rfq.txt"])).rejects.toThrow(/No file at/);
  });
});
