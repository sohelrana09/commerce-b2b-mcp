import { randomBytes } from "node:crypto";
import type { AttributeKey, PaasOptions } from "./backend/paas/paas-backend.js";
import { ToolError } from "./errors.js";

export const ALL_TOOLS = [
  "search_parts",
  "get_product",
  "check_availability",
  "get_customer_price",
  "get_company_context",
  "list_orders",
  "get_order_status",
  "read_requisition_list",
  "draft_negotiable_quote",
] as const;

export type ToolName = (typeof ALL_TOOLS)[number];

export interface Config {
  backend: "mock" | "paas";
  /** Identity the stdio server acts as. Every call is scoped to this company user. */
  callerEmail: string;
  enabledTools: ReadonlySet<ToolName>;
  /** "stderr" or a file path for the JSONL audit log. */
  auditLog: string;
  confirmSecret: Buffer;
  confirmTtlSeconds: number;
  maxPageSize: number;
  /** Present when backend is "paas". */
  paas?: Omit<PaasOptions, "fetch">;
}

const ATTRIBUTE_KEYS: AttributeKey[] = ["part_type", "head", "thread", "length_mm", "material", "grade", "finish"];

function parseJson<T>(name: string, raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
}

function isLocalDevHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".test") || host.endsWith(".localhost");
}

function loadPaas(env: NodeJS.ProcessEnv, callerEmail: string): Omit<PaasOptions, "fetch"> {
  const raw = env.COMMERCE_BASE_URL;
  if (!raw) throw new Error("COMMERCE_BASE_URL is required for the paas backend, e.g. https://store.example.com");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`COMMERCE_BASE_URL is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== "https:" && !isLocalDevHost(url.hostname)) {
    throw new Error("COMMERCE_BASE_URL must use https (plain http is only allowed for localhost and .test hosts).");
  }

  const token = env.COMMERCE_CUSTOMER_TOKEN;
  const password = env.COMMERCE_CUSTOMER_PASSWORD;
  if (!token && !password) {
    throw new Error(
      "Set COMMERCE_CUSTOMER_TOKEN (preferred) or COMMERCE_CUSTOMER_PASSWORD for the company user. Admin tokens are not supported by design.",
    );
  }

  const attributeMap = parseJson<Record<string, string>>("COMMERCE_ATTRIBUTE_MAP", env.COMMERCE_ATTRIBUTE_MAP);
  for (const key of Object.keys(attributeMap ?? {})) {
    if (!ATTRIBUTE_KEYS.includes(key as AttributeKey)) {
      throw new Error(`COMMERCE_ATTRIBUTE_MAP has unknown key "${key}". Allowed: ${ATTRIBUTE_KEYS.join(", ")}`);
    }
  }
  const leadTimes = parseJson<Record<string, number>>("COMMERCE_SOURCE_LEAD_TIMES", env.COMMERCE_SOURCE_LEAD_TIMES);
  for (const [code, days] of Object.entries(leadTimes ?? {})) {
    if (typeof days !== "number" || days < 0) throw new Error(`COMMERCE_SOURCE_LEAD_TIMES["${code}"] must be a non-negative number.`);
  }
  const stockId = env.COMMERCE_STOCK_ID ? Number(env.COMMERCE_STOCK_ID) : undefined;
  if (stockId !== undefined && !(Number.isInteger(stockId) && stockId > 0)) throw new Error("COMMERCE_STOCK_ID must be a positive integer.");

  return {
    baseUrl: url.origin + url.pathname.replace(/\/+$/, ""),
    ...(env.COMMERCE_STORE_CODE ? { storeCode: env.COMMERCE_STORE_CODE } : {}),
    auth: token ? { kind: "static", token } : { kind: "password", email: callerEmail, password: password! },
    ...(env.COMMERCE_INVENTORY_TOKEN ? { inventoryToken: env.COMMERCE_INVENTORY_TOKEN } : {}),
    ...(stockId !== undefined ? { stockId } : {}),
    ...(leadTimes ? { sourceLeadTimes: leadTimes } : {}),
    ...(attributeMap ? { attributeMap: attributeMap as PaasOptions["attributeMap"] } : {}),
    ...(env.COMMERCE_QUOTE_REVIEW_URL ? { quoteReviewUrl: env.COMMERCE_QUOTE_REVIEW_URL } : {}),
    timeoutMs: Number(env.COMMERCE_TIMEOUT_MS ?? 15000),
  };
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Tool allowlist. COMMERCE_TOOLS_ENABLED wins over COMMERCE_TOOLS_DISABLED;
 * unknown names are rejected so a typo never silently enables everything.
 */
function resolveTools(enabled?: string[], disabled?: string[]): Set<ToolName> {
  const known = new Set<string>(ALL_TOOLS);
  for (const name of [...(enabled ?? []), ...(disabled ?? [])]) {
    if (!known.has(name)) {
      throw new Error(`Unknown tool in allowlist: "${name}". Known tools: ${ALL_TOOLS.join(", ")}`);
    }
  }
  if (enabled) return new Set(enabled as ToolName[]);
  const off = new Set(disabled ?? []);
  return new Set(ALL_TOOLS.filter((t) => !off.has(t)));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const backend = (env.COMMERCE_BACKEND ?? "mock") as Config["backend"];
  if (backend !== "mock" && backend !== "paas") {
    throw new Error(`COMMERCE_BACKEND must be "mock" or "paas", got "${backend}"`);
  }

  const callerEmail = env.COMMERCE_CALLER_EMAIL ?? (backend === "mock" ? "jane.buyer@northwind.example" : "");
  if (!callerEmail) {
    throw new Error("COMMERCE_CALLER_EMAIL is required: the server always acts as one company user, never as admin.");
  }

  const secret = env.COMMERCE_CONFIRM_SECRET;
  if (backend !== "mock" && (!secret || secret.length < 32)) {
    throw new Error("COMMERCE_CONFIRM_SECRET (32+ characters) is required outside mock mode; it signs write confirmation tokens.");
  }

  return {
    backend,
    callerEmail,
    enabledTools: resolveTools(parseList(env.COMMERCE_TOOLS_ENABLED), parseList(env.COMMERCE_TOOLS_DISABLED)),
    auditLog: env.COMMERCE_AUDIT_LOG ?? "stderr",
    confirmSecret: secret ? Buffer.from(secret, "utf8") : randomBytes(32),
    confirmTtlSeconds: Number(env.COMMERCE_CONFIRM_TTL_SECONDS ?? 600),
    maxPageSize: 20,
    ...(backend === "paas" ? { paas: loadPaas(env, callerEmail) } : {}),
  };
}

export function assertEnabled(config: Config, tool: ToolName): void {
  if (!config.enabledTools.has(tool)) {
    throw new ToolError("TOOL_DISABLED", `The tool "${tool}" is disabled on this store.`);
  }
}
