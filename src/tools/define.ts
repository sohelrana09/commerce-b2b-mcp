import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { AuditSink } from "../audit.js";
import type { Caller, CommerceBackend } from "../backend/types.js";
import type { Config, ToolName } from "../config.js";
import type { TokenLedger } from "../confirm.js";
import { asToolError, ToolError } from "../errors.js";
import { runTraced, type Trace } from "../trace.js";

/** Largest tool result sent to the model: about 15k tokens. */
export const MAX_RESULT_BYTES = 60_000;

export interface ToolDeps {
  backend: CommerceBackend;
  config: Config;
  audit: AuditSink;
  caller: Caller;
  /** Marks confirmation tokens used. Shared by every server in the process (and across instances over HTTP). */
  ledger: TokenLedger;
}

export interface ToolSpec<Shape extends z.ZodRawShape> {
  name: ToolName;
  title: string;
  /** Static text written by us. Never interpolate store content into it. */
  description: string;
  input: Shape;
  annotations: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<Shape>>, deps: ToolDeps) => Promise<unknown>;
}

export function toResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

/**
 * Registers one tool with the cross-cutting safety behaviour:
 * - disabled tools are never registered, so the agent never sees them;
 * - every call is audited (caller, company, tool, redacted input, size, timing);
 * - every failure becomes a structured error with a `retryable` flag.
 */
export function defineTool<Shape extends z.ZodRawShape>(server: McpServer, deps: ToolDeps, spec: ToolSpec<Shape>): boolean {
  if (!deps.config.enabledTools.has(spec.name)) return false;

  let companyId: string | null | undefined;
  const company = async () => {
    if (companyId === undefined) {
      companyId = await deps.backend.getCompanyContext(deps.caller).then(
        (c) => c.company_id,
        () => null,
      );
    }
    return companyId;
  };

  server.registerTool(
    spec.name,
    { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: spec.annotations },
    // The SDK's generic callback type does not narrow through our own generic; the
    // input has already been validated against `spec.input` when this runs.
    (async (args: z.infer<z.ZodObject<Shape>>, extra: { sessionId?: string; authInfo?: { clientId: string } }) => {
      const started = Date.now();
      const trace: Trace = { trace_id: randomUUID(), upstream: { calls: 0, ms: 0, errors: 0 } };
      let result: CallToolResult;
      let errorCode: string | undefined;
      try {
        result = toResult(sanitizeResult(await runTraced(trace, () => spec.handler(args, deps))));
      } catch (err) {
        const te = asToolError(err);
        errorCode = te.code;
        if (te.code === "INTERNAL") process.stderr.write(`[commerce-b2b-mcp] ${spec.name} failed (trace ${trace.trace_id}): ${String(err)}\n`);
        result = toResult(sanitizeResult(te.toJSON()), true);
      }
      let text = result.content[0]?.type === "text" ? result.content[0].text : "";
      // Last line of defence for the context budget, whatever a backend or a future tool returns.
      if (!errorCode && Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
        errorCode = "RESULT_TOO_LARGE";
        result = toResult(
          new ToolError("RESULT_TOO_LARGE", "The result is too large to return.", "Ask for fewer items or a narrower search.").toJSON(),
          true,
        );
        text = result.content[0]?.type === "text" ? result.content[0].text : "";
      }
      deps.audit.write({
        ts: new Date(started).toISOString(),
        caller: deps.caller.email,
        company_id: await company(),
        tool: spec.name,
        input: args,
        outcome: errorCode ? "error" : "ok",
        ...(errorCode ? { error_code: errorCode } : {}),
        result_bytes: Buffer.byteLength(text, "utf8"),
        duration_ms: Date.now() - started,
        trace_id: trace.trace_id,
        ...(extra?.sessionId ? { session_id: extra.sessionId } : {}),
        ...(extra?.authInfo ? { client_id: extra.authInfo.clientId } : {}),
        upstream: trace.upstream,
      });
      // The trace id lets a user or support quote one call; it carries no data.
      return { ...result, _meta: { trace_id: trace.trace_id } };
    }) as never,
  );
  return true;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Plain text from store-authored or otherwise untrusted text: entities decoded first (so "&lt;b&gt;" cannot hide markup),
 * tags removed (an unterminated tag is removed to the end), whitespace collapsed, control, zero-width and Unicode tag
 * characters dropped, then capped. Pass `Infinity` to skip the cap.
 */
export function cleanText(raw: string, max = 300): string {
  let s = raw;
  for (let i = 0; i < 3; i++) {
    const prev = s;
    s = decodeEntities(s).replace(/<[/!a-z][^>]*>?/gi, " ");
    if (s === prev) break;
  }
  s = s.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "") + "\u2026";
}

/** Every string in a tool result or error passes through cleanText, so store text anywhere in it is plain and bounded. */
export function sanitizeResult(value: unknown, key = ""): unknown {
  if (typeof value === "string") return cleanText(value, key === "text" ? 700 : 300);
  if (Array.isArray(value)) return value.map((v) => sanitizeResult(v, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeResult(v, k)]));
  }
  return value;
}

/** Store-authored text: strip markup, cap length, and label it as data. */
export function merchantText(raw: string, max = 600): { source: "merchant_content"; text: string; truncated: boolean } {
  const plain = cleanText(raw, Infinity);
  return { source: "merchant_content", text: plain.slice(0, max), truncated: plain.length > max };
}
