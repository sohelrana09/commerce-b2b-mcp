import { ToolError } from "../../errors.js";
import { recordUpstream } from "../../trace.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  baseUrl: string;
  storeCode: string | undefined;
  timeoutMs: number;
  fetch: FetchLike;
}

interface GraphQLError {
  message: string;
  extensions?: { category?: string };
}

/** Thrown when the customer token was rejected, so the caller can refresh once. */
export class AuthExpiredError extends Error {}

const log = (msg: string) => process.stderr.write(`[commerce-b2b-mcp] ${msg}\n`);

async function send(opts: HttpOptions, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  const started = Date.now();
  try {
    const res = await opts.fetch(url, { ...init, signal: ctrl.signal });
    recordUpstream(Date.now() - started, !res.ok);
    return res;
  } catch (err) {
    recordUpstream(Date.now() - started, true);
    const timedOut = (err as Error)?.name === "AbortError";
    log(`${init.method ?? "GET"} ${new URL(url).pathname} ${timedOut ? "timed out" : `failed: ${String(err)}`}`);
    throw new ToolError(
      "UPSTREAM_UNAVAILABLE",
      timedOut ? "The store did not respond in time." : "Could not reach the store.",
      "Try again shortly.",
    );
  } finally {
    clearTimeout(timer);
  }
}

function statusError(res: Response, what: string): ToolError {
  if (res.status === 429) return new ToolError("RATE_LIMITED", "The store is rate-limiting requests.", "Wait a little before retrying.");
  if (res.status >= 500) return new ToolError("UPSTREAM_UNAVAILABLE", `The store returned an error (${res.status}).`);
  if (res.status === 403) return new ToolError("FORBIDDEN", `The store refused access to ${what}.`);
  if (res.status === 404) return new ToolError("NOT_FOUND", `${what} was not found.`);
  return new ToolError("INTERNAL", `Unexpected response from the store (${res.status}).`);
}

/**
 * Map Magento GraphQL error categories to tool errors. Store messages are
 * passed through for input/not-found errors because they are actionable
 * ("The requested qty is not available"), and are short, store-authored text.
 */
function graphqlError(errors: GraphQLError[]): Error {
  const first = errors[0]!;
  const msg = first.message.slice(0, 300);
  switch (first.extensions?.category) {
    case "graphql-authentication":
      return new AuthExpiredError(msg);
    case "graphql-authorization":
      // Magento reports an expired/missing customer token as an authorization error
      // with this message; B2B permission denials use other wording.
      if (/current customer isn't authorized/i.test(msg)) return new AuthExpiredError(msg);
      return new ToolError("FORBIDDEN", `The store refused this action: ${msg}`);
    case "graphql-no-such-entity":
      return new ToolError("NOT_FOUND", msg);
    case "graphql-input":
      return new ToolError("INVALID_INPUT", msg);
    default:
      log(`GraphQL error: ${first.message}`);
      return new ToolError("INTERNAL", "The store returned an unexpected GraphQL error.");
  }
}

export async function graphql<T>(
  opts: HttpOptions,
  query: string,
  variables: Record<string, unknown>,
  token: string | null,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.storeCode) headers.Store = opts.storeCode;

  const res = await send(opts, `${opts.baseUrl}/graphql`, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  if (res.status === 401) throw new AuthExpiredError("Customer token rejected");

  let body: { data?: T; errors?: GraphQLError[] };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw res.ok ? new ToolError("INTERNAL", "The store returned a response that is not JSON.") : statusError(res, "the GraphQL API");
  }
  if (body.errors?.length) throw graphqlError(body.errors);
  if (!res.ok) throw statusError(res, "the GraphQL API");
  if (body.data === undefined) throw new ToolError("INTERNAL", "The store returned no data.");
  return body.data;
}

export async function restGet<T>(opts: HttpOptions, path: string, token: string): Promise<T> {
  const store = opts.storeCode ? `/${encodeURIComponent(opts.storeCode)}` : "";
  const res = await send(opts, `${opts.baseUrl}/rest${store}/V1/${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (res.status === 401) {
    throw new ToolError("INTERNAL", "The inventory integration token was rejected. Check COMMERCE_INVENTORY_TOKEN.");
  }
  if (!res.ok) throw statusError(res, "inventory data");
  return (await res.json()) as T;
}
