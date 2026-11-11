import type { FetchLike } from "../src/backend/paas/http.js";

/**
 * A fake Adobe Commerce store for adapter tests. GraphQL operations are routed
 * by operation name; REST by path. Each handler gets the parsed request and
 * returns a JSON body (and optional status). Every request is recorded.
 */

export interface Recorded {
  kind: "graphql" | "rest";
  op: string;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
  path: string;
}

type Reply = { status?: number; body: unknown } | "timeout";
type GqlHandler = (vars: Record<string, unknown>, headers: Record<string, string>) => Reply;
type RestHandler = (path: string, headers: Record<string, string>) => Reply;

export function fakeStore(gql: Record<string, GqlHandler>, rest: Record<string, RestHandler> = {}) {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    let reply: Reply | undefined;

    if (u.pathname.endsWith("/graphql")) {
      const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      const op = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "anonymous";
      calls.push({ kind: "graphql", op, variables, headers, path: u.pathname });
      const h = gql[op];
      if (!h) throw new Error(`fake store: no GraphQL handler for ${op}`);
      reply = h(variables, headers);
    } else {
      const path = decodeURIComponent(u.pathname + u.search);
      calls.push({ kind: "rest", op: path, variables: {}, headers, path });
      const key = Object.keys(rest).find((k) => path.includes(k));
      if (!key) throw new Error(`fake store: no REST handler for ${path}`);
      reply = rest[key]!(path, headers);
    }

    if (reply === "timeout") {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: fetchImpl, calls };
}

export const money = (value: number, currency = "GBP") => ({ value, currency });
export const b64 = (s: string) => Buffer.from(s).toString("base64");

export function part(sku: string, name: string, extra: Record<string, unknown> = {}) {
  return { uid: b64(sku), sku, name, __typename: "SimpleProduct", stock_status: "IN_STOCK", only_x_left_in_stock: null, quantity: null, ...extra };
}

export const JANE = "jane.buyer@northwind.example";

export function companyContextReply(opts: { email?: string; admin?: boolean; acl?: string[] } = {}) {
  const email = opts.email ?? JANE;
  return {
    body: {
      data: {
        customer: {
          email,
          firstname: "Jane",
          lastname: "Okafor",
          job_title: "Purchasing Manager",
          status: "ACTIVE",
          group: { uid: "MQ==" },
          role: {
            name: "Buyer",
            permissions: [
              {
                id: b64("Magento_Company::index"),
                children: (opts.acl ?? ["Magento_Sales::view_orders", "Magento_NegotiableQuote::manage", "Magento_Company::credit"]).map((r) => ({
                  id: b64(r),
                  children: [],
                })),
              },
            ],
          },
        },
        company: {
          id: "Mg==",
          name: "Northwind Fixings Ltd",
          company_admin: { email: opts.admin ? email : "boss@northwind.example" },
          payment_methods: ["checkmo", "companycredit"],
          sales_representative: { firstname: "Priya", lastname: "Shah", email: "priya.shah@fastenco.example" },
        },
      },
    },
  };
}
