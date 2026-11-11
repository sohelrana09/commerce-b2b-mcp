import { randomBytes } from "node:crypto";
import type { AttributeKey, PaasOptions } from "./backend/paas/paas-backend.js";
import type { AuditInputMode } from "./audit.js";
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

export interface HttpConfig {
  host: string;
  port: number;
  /** Public base URL: OAuth issuer, and the MCP endpoint is `${publicUrl}/mcp`. */
  publicUrl: URL;
  /** Access token lifetime. Capped at one hour (the default Magento customer token lifetime). */
  tokenTtlSeconds: number;
  /** Hosts an OAuth client may redirect to after sign-in. Loopback is always allowed. */
  redirectHosts: string[];
  /** Mock backend only: the shared demo password for fixture users. */
  mockPassword: string;
  /** Where sign-in state lives: this process's memory, or Redis shared by several instances (ADR 19). */
  state: StateConfig;
  /**
   * "stateful": MCP sessions, each held by the instance that opened it (needs sticky routing with several).
   * "stateless": every POST stands alone, so any instance or a serverless function can answer it (ADR 20).
   */
  sessions: "stateful" | "stateless";
}

export type StateConfig =
  | { kind: "memory" }
  | {
      kind: "redis";
      url: string;
      /** Encrypts every stored value (AES-256-GCM). 32+ characters. */
      secret: string;
      prefix: string;
      /** False for redis:// to a host other than loopback: values are encrypted, but the Redis password is not. */
      tls: boolean;
    };

export interface Config {
  backend: "mock" | "paas";
  transport: "stdio" | "http";
  /**
   * stdio: the one company user the server acts as. Every call is scoped to them.
   * http: empty; each session acts as the user its OAuth token was issued to.
   */
  callerEmail: string;
  enabledTools: ReadonlySet<ToolName>;
  /** "stderr" or a file path for the JSONL audit log. */
  auditLog: string;
  /** "full" or "shape" (free text in tool inputs is replaced by its length). */
  auditInput: AuditInputMode;
  confirmSecret: Buffer;
  confirmTtlSeconds: number;
  maxPageSize: number;
  /** Present when backend is "paas". `auth` is absent over HTTP: each session brings its own customer token. */
  paas?: Omit<PaasOptions, "fetch" | "auth"> & { auth?: PaasOptions["auth"] };
  /** Present when transport is "http". */
  http?: HttpConfig;
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

function loadPaas(env: NodeJS.ProcessEnv, callerEmail: string, perSession: boolean): NonNullable<Config["paas"]> {
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
  if (!perSession && !token && !password) {
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
    ...(perSession ? {} : { auth: token ? { kind: "static" as const, token } : { kind: "password" as const, email: callerEmail, password: password! } }),
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

function loadHttp(env: NodeJS.ProcessEnv, backend: Config["backend"]): HttpConfig {
  const host = env.COMMERCE_HTTP_HOST ?? "127.0.0.1";
  const port = Number(env.COMMERCE_HTTP_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("COMMERCE_HTTP_PORT must be a port number.");
  const rawUrl = env.COMMERCE_PUBLIC_URL ?? `http://localhost:${port}`;
  let publicUrl: URL;
  try {
    publicUrl = new URL(rawUrl);
  } catch {
    throw new Error(`COMMERCE_PUBLIC_URL is not a valid URL: "${rawUrl}"`);
  }
  if (publicUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(publicUrl.hostname)) {
    throw new Error("COMMERCE_PUBLIC_URL must use https (plain http is only allowed for localhost). Tokens and passwords cross it.");
  }
  if (publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") {
    throw new Error("COMMERCE_PUBLIC_URL must be an origin with no path, query or fragment, e.g. https://mcp.example.com");
  }
  const ttl = Number(env.COMMERCE_HTTP_TOKEN_TTL_SECONDS ?? 3600);
  if (!(ttl >= 60)) throw new Error("COMMERCE_HTTP_TOKEN_TTL_SECONDS must be at least 60.");
  const mockPassword = env.COMMERCE_MOCK_PASSWORD ?? "";
  if (backend === "mock" && mockPassword.length < 12) {
    throw new Error("COMMERCE_MOCK_PASSWORD (12+ characters) is required for the mock backend over HTTP: it is the demo users' sign-in password.");
  }
  return {
    host,
    port,
    publicUrl,
    state: loadState(env),
    sessions: loadSessions(env.COMMERCE_HTTP_SESSIONS),
    tokenTtlSeconds: Math.min(ttl, 3600),
    redirectHosts: parseList(env.COMMERCE_OAUTH_REDIRECT_HOSTS) ?? [],
    mockPassword,
  };
}

function loadSessions(raw: string | undefined): HttpConfig["sessions"] {
  const v = raw ?? "stateful";
  if (v !== "stateful" && v !== "stateless") throw new Error(`COMMERCE_HTTP_SESSIONS must be "stateful" or "stateless", got "${v}"`);
  return v;
}

function loadState(env: NodeJS.ProcessEnv): StateConfig {
  const kind = env.COMMERCE_STATE_STORE ?? "memory";
  if (kind === "memory") {
    if (env.COMMERCE_REDIS_URL) throw new Error('COMMERCE_REDIS_URL is set but COMMERCE_STATE_STORE is not "redis". Set COMMERCE_STATE_STORE=redis to use it.');
    return { kind };
  }
  if (kind !== "redis") throw new Error(`COMMERCE_STATE_STORE must be "memory" or "redis", got "${kind}"`);
  const raw = env.COMMERCE_REDIS_URL;
  if (!raw) throw new Error("COMMERCE_REDIS_URL is required when COMMERCE_STATE_STORE=redis, e.g. rediss://:password@redis.example.com:6380");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Never echo the value: it usually holds the Redis password.
    throw new Error("COMMERCE_REDIS_URL is not a valid URL. Use redis://host:6379 or rediss://host:6380.");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("COMMERCE_REDIS_URL must start with redis:// or rediss://.");
  const secret = env.COMMERCE_STATE_KEY ?? "";
  if (secret.length < 32) {
    throw new Error("COMMERCE_STATE_KEY (32+ characters) is required with Redis: it encrypts the customer tokens kept there. Use the same value on every instance.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return { kind, url: raw, secret, prefix: env.COMMERCE_REDIS_PREFIX ?? "commerce-b2b-mcp:", tls: url.protocol === "rediss:" || loopback };
}

function parseAuditInput(raw: string | undefined): AuditInputMode {
  const v = raw ?? "full";
  if (v !== "full" && v !== "shape") throw new Error(`COMMERCE_AUDIT_INPUT must be "full" or "shape", got "${v}"`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const backend = (env.COMMERCE_BACKEND ?? "mock") as Config["backend"];
  if (backend !== "mock" && backend !== "paas") {
    throw new Error(`COMMERCE_BACKEND must be "mock" or "paas", got "${backend}"`);
  }
  const transport = (env.COMMERCE_TRANSPORT ?? "stdio") as Config["transport"];
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`COMMERCE_TRANSPORT must be "stdio" or "http", got "${transport}"`);
  }
  const perSession = transport === "http";
  if (perSession && (env.COMMERCE_CALLER_EMAIL || env.COMMERCE_CUSTOMER_TOKEN || env.COMMERCE_CUSTOMER_PASSWORD)) {
    throw new Error(
      "Over HTTP each user signs in with OAuth. Unset COMMERCE_CALLER_EMAIL, COMMERCE_CUSTOMER_TOKEN and COMMERCE_CUSTOMER_PASSWORD so no fixed identity is shared by every client.",
    );
  }

  const callerEmail = perSession ? "" : (env.COMMERCE_CALLER_EMAIL ?? (backend === "mock" ? "jane.buyer@northwind.example" : ""));
  if (!perSession && !callerEmail) {
    throw new Error("COMMERCE_CALLER_EMAIL is required: the server always acts as one company user, never as admin.");
  }

  const secret = env.COMMERCE_CONFIRM_SECRET;
  if (backend !== "mock" && (!secret || secret.length < 32)) {
    throw new Error("COMMERCE_CONFIRM_SECRET (32+ characters) is required outside mock mode; it signs write confirmation tokens.");
  }

  return {
    backend,
    transport,
    callerEmail,
    enabledTools: resolveTools(parseList(env.COMMERCE_TOOLS_ENABLED), parseList(env.COMMERCE_TOOLS_DISABLED)),
    auditLog: env.COMMERCE_AUDIT_LOG ?? "stderr",
    auditInput: parseAuditInput(env.COMMERCE_AUDIT_INPUT),
    confirmSecret: secret ? Buffer.from(secret, "utf8") : randomBytes(32),
    confirmTtlSeconds: Number(env.COMMERCE_CONFIRM_TTL_SECONDS ?? 600),
    maxPageSize: 20,
    ...(backend === "paas" ? { paas: loadPaas(env, callerEmail, perSession) } : {}),
    ...(perSession ? { http: loadHttp(env, backend) } : {}),
  };
}

export function assertEnabled(config: Config, tool: ToolName): void {
  if (!config.enabledTools.has(tool)) {
    throw new ToolError("TOOL_DISABLED", `The tool "${tool}" is disabled on this store.`);
  }
}
