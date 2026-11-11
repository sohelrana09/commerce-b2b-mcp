import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { RfqDocument } from "./schema.js";

const MAX_BYTES = 20 * 1024 * 1024;

/** Load an RFQ file: plain text, an email saved as .eml/.txt, a CSV export, or a PDF. */
export function loadRfq(path: string): RfqDocument {
  const size = statSync(path).size;
  if (size > MAX_BYTES) throw new Error(`${path} is ${(size / 1e6).toFixed(1)} MB; the limit is 20 MB.`);
  const name = basename(path);
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return { kind: "pdf", name, base64: readFileSync(path).toString("base64") };
  if (ext === ".xlsx" || ext === ".xls") throw new Error("Save the spreadsheet as CSV first (File > Save As > CSV).");
  return { kind: "text", name, text: readFileSync(path, "utf8") };
}
