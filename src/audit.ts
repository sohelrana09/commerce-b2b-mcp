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
 * JSONL audit sink. Writes to stderr by default: stdout belongs to the MCP
 * stdio transport and must never carry anything else.
 */
export function createAuditSink(target: string): AuditSink {
  return {
    write(entry) {
      const line = JSON.stringify({ ...entry, input: redact(entry.input) }) + "\n";
      if (target === "stderr") process.stderr.write(line);
      else appendFileSync(target, line, "utf8");
    },
  };
}

export function memoryAuditSink(): AuditSink & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return { entries, write: (e) => entries.push({ ...e, input: redact(e.input) }) };
}
