import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { AuditSink } from "../audit.js";
import type { Caller, CommerceBackend } from "../backend/types.js";
import type { Config, ToolName } from "../config.js";
import { asToolError } from "../errors.js";

export interface ToolDeps {
  backend: CommerceBackend;
  config: Config;
  audit: AuditSink;
  caller: Caller;
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
    (async (args: z.infer<z.ZodObject<Shape>>) => {
      const started = Date.now();
      let result: CallToolResult;
      let errorCode: string | undefined;
      try {
        result = toResult(await spec.handler(args, deps));
      } catch (err) {
        const te = asToolError(err);
        errorCode = te.code;
        if (te.code === "INTERNAL") process.stderr.write(`[commerce-b2b-mcp] ${spec.name} failed: ${String(err)}\n`);
        result = toResult(te.toJSON(), true);
      }
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
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
      });
      return result;
    }) as never,
  );
  return true;
}

/** Store-authored text: strip markup, cap length, and label it as data. */
export function merchantText(raw: string, max = 600): { source: "merchant_content"; text: string; truncated: boolean } {
  const plain = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return { source: "merchant_content", text: plain.slice(0, max), truncated: plain.length > max };
}
