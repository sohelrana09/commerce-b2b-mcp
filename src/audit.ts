import { appendFileSync } from "node:fs";

export interface AuditEntry {
  ts: string;
  caller: string;
  company_id: string | null;
  tool: string;
  input: unknown;
  outcome: "ok" | "error";
  error_code?: string;
  result_bytes: number;
  duration_ms: number;
  /** Unique per tool call; also returned to the client in the result's _meta. */
  trace_id?: string;
  /** MCP session (HTTP transport only). */
  session_id?: string;
  /** OAuth client that holds the token (HTTP transport only). */
  client_id?: string;
  /** Store requests made by this call: count, total time, failures. */
  upstream?: { calls: number; ms: number; errors: number };
}

export interface AuditSink {
  write(entry: AuditEntry): void;
}

/** Keys whose values never reach the audit log. */
const REDACT = /token|secret|password|authorization/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, REDACT.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

/**
 * How much of each tool input the audit log keeps.
 * - `full`: every value except secrets (default; best for debugging).
 * - `shape`: free text becomes "[text, N chars]"; numbers, flags, SKUs and IDs stay.
 *   RFQ line text, search phrases and quote notes can carry customer data, so this
 *   is the data-minimising choice for production (docs/data-handling.md).
 */
export type AuditInputMode = "full" | "shape";

/** Keys whose string values are identifiers, not free text, and are kept in `shape` mode. */
const IDENTIFIER = /^(sku|skus|id|.*_id|.*_ids|order_number|status|sort|sort_by|unit|uom|currency|thread|grade|material|finish|head|part_type)$/i;

export function shape(value: unknown, key = ""): unknown {
  if (typeof value === "string") return IDENTIFIER.test(key) ? value : `[text, ${value.length} chars]`;
  if (Array.isArray(value)) return value.map((v) => shape(v, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shape(v, k)]));
  }
  return value;
}

const minimise = (input: unknown, mode: AuditInputMode) => (mode === "shape" ? shape(redact(input)) : redact(input));

/**
 * JSONL audit sink. Writes to stderr by default: stdout belongs to the MCP
 * stdio transport and must never carry anything else.
 */
export function createAuditSink(target: string, mode: AuditInputMode = "full"): AuditSink {
  return {
    write(entry) {
      const line = JSON.stringify({ ...entry, input: minimise(entry.input, mode) }) + "\n";
      if (target === "stderr") process.stderr.write(line);
      else appendFileSync(target, line, "utf8");
    },
  };
}

export function memoryAuditSink(mode: AuditInputMode = "full"): AuditSink & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return { entries, write: (e) => entries.push({ ...e, input: minimise(e.input, mode) }) };
}
