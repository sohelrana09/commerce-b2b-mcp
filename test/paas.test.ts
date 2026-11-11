import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { memoryAuditSink } from "../src/audit.js";
import { PaasBackend, type PaasOptions } from "../src/backend/paas/paas-backend.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { b64, companyContextReply, fakeStore, JANE, money, part } from "./fake-store.js";

const SECRET = "x".repeat(32);
const BASE_ENV = {
  COMMERCE_BACKEND: "paas",
  COMMERCE_BASE_URL: "https://store.example.com",
  COMMERCE_CALLER_EMAIL: JANE,
  COMMERCE_CUSTOMER_TOKEN: "cust-token-1",
  COMMERCE_CONFIRM_SECRET: SECRET,
};

async function connectPaas(
  store: ReturnType<typeof fakeStore>,
  overrides: Partial<PaasOptions> = {},
  env: Record<string, string> = {},
) {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const backend = new PaasBackend({ ...config.paas!, ...overrides, fetch: store.fetch });
  const audit = memoryAuditSink();
  const { server } = createServer(config, { backend, audit });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ text: string }>;
    return { isError: Boolean(res.isError), data: JSON.parse(content[0]!.text) };
  };
  return { call, audit };
}

const ctx = () => companyContextReply();

describe("config", () => {
  it("rejects plain http for remote hosts but allows .test", () => {
    expect(() => loadConfig({ ...BASE_ENV, COMMERCE_BASE_URL: "http://store.example.com" })).toThrow(/https/);
    expect(loadConfig({ ...BASE_ENV, COMMERCE_BASE_URL: "http://magento.test/" }).paas?.baseUrl).toBe("http://magento.test");
  });

  it("requires a customer credential and a long confirm secret", () => {
    const { COMMERCE_CUSTOMER_TOKEN: _t, ...noAuth } = BASE_ENV;
    expect(() => loadConfig(noAuth)).toThrow(/Admin tokens are not supported/);
    expect(() => loadConfig({ ...BASE_ENV, COMMERCE_CONFIRM_SECRET: "short" })).toThrow(/32\+/);
  });

  it("validates attribute map keys", () => {
    expect(() => loadConfig({ ...BASE_ENV, COMMERCE_ATTRIBUTE_MAP: '{"colour":"color"}' })).toThrow(/unknown key "colour"/);
  });
});

describe("company context and identity", () => {
  it("maps B2B ACL resources, credit and payment on account; sends customer token and store header", async () => {
    const store = fakeStore({
      CompanyContext: ctx,
      CompanyCredit: () => ({
        body: { data: { company: { credit: { available_credit: money(6749.6), credit_limit: money(25000), outstanding_balance: money(-18250.4) } } } },
      }),
    });
    const { call } = await connectPaas(store, { storeCode: "uk_b2b" });
    const { data } = await call("get_company_context");
    expect(data.permissions.sort()).toEqual(["catalog.view", "company.view_credit", "orders.view_own", "quotes.create"]);
    expect(data.user.role).toBe("Buyer");
    expect(data.credit).toMatchObject({ limit: 25000, available: 6749.6 });
    expect(data.payment_on_account_enabled).toBe(true);
    expect(data.sales_rep.email).toBe("priya.shah@fastenco.example");
    expect(store.calls[0]!.headers).toMatchObject({ Authorization: "Bearer cust-token-1", Store: "uk_b2b" });
  });

  it("records store calls and timing per tool call in the audit log", async () => {
    const store = fakeStore({ CompanyContext: ctx, CompanyCredit: () => ({ body: { data: { company: null } } }) });
    const { call, audit } = await connectPaas(store);
    await call("get_company_context");
    const entry = audit.entries.at(-1)!;
    expect(entry.trace_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.upstream).toMatchObject({ calls: 2, errors: 0 });
  });

  it("gives the company admin every permission", async () => {
    const store = fakeStore({ CompanyContext: () => companyContextReply({ admin: true, acl: [] }), CompanyCredit: () => ({ body: { data: { company: null } } }) });
    const { call } = await connectPaas(store);
    const { data } = await call("get_company_context");
    expect(data.user.role).toBe("company_admin");
    expect(data.permissions).toContain("orders.view_all");
  });

  it("refuses to act when the token belongs to someone else", async () => {
    const store = fakeStore({ CompanyContext: () => companyContextReply({ email: "someone.else@northwind.example" }) });
    const { call } = await connectPaas(store);
    const res = await call("search_parts", { query: "M8x30" });
    expect(res.data.error.code).toBe("FORBIDDEN");
    // Only identity checks ran; no catalogue query was made as the wrong user.
    expect(new Set(store.calls.map((c) => c.op))).toEqual(new Set(["CompanyContext"]));
  });

  it("re-authenticates once with password auth when the token expires", async () => {
    let issued = 0;
    const store = fakeStore({
      Login: () => ({ body: { data: { generateCustomerToken: { token: `fresh-${++issued}` } } } }),
      CompanyContext: (_v, h) =>
        h.Authorization === "Bearer fresh-1" && issued === 1 && store.calls.filter((c) => c.op === "CompanyContext").length === 1
          ? { body: { errors: [{ message: "The current customer isn't authorized.", extensions: { category: "graphql-authorization" } }] } }
          : ctx(),
      CompanyCredit: () => ({ body: { data: { company: null } } }),
    });
    const { COMMERCE_CUSTOMER_TOKEN: _t, ...env } = BASE_ENV;
    const config = loadConfig({ ...env, COMMERCE_CUSTOMER_PASSWORD: "pw" });
    const backend = new PaasBackend({ ...config.paas!, fetch: store.fetch });
    const res = await backend.getCompanyContext({ email: JANE });
    expect(res.company_name).toBe("Northwind Fixings Ltd");
    expect(issued).toBe(2);
    // The password goes only to the login mutation, never in a header.
    expect(store.calls.filter((c) => c.op === "Login").every((c) => !JSON.stringify(c.headers).includes("pw"))).toBe(true);
  });

  it("reports an expired static token as FORBIDDEN with a hint", async () => {
    const store = fakeStore({ CompanyContext: () => ({ status: 401, body: {} }) });
    const { call } = await connectPaas(store);
    const res = await call("get_company_context");
    expect(res.data.error).toMatchObject({ code: "FORBIDDEN", retryable: false });
    expect(res.data.error.hint).toMatch(/COMMERCE_CUSTOMER_TOKEN/);
  });
});

describe("catalog", () => {
  const items = [
    part("FX-1001", "Hex Setscrew M8 x 30 A4 Stainless ISO 4017"),
    part("FX-1002", "Hex Setscrew M8 x 30 A2 Stainless"),
    part("FX-1003", "Hex Bolt M8 x 40 A4"),
    { ...part("FX-PARENT", "Hex Setscrew M8 range"), __typename: "ConfigurableProduct" },
  ];

  it("derives attributes from product names, drops configurable parents, and searches by thread too", async () => {
    const store = fakeStore({ CompanyContext: ctx, CompanyCredit: () => ({ body: { data: { company: null } } }), SearchParts: () => ({ body: { data: { products: { items } } } }) });
    const { call } = await connectPaas(store);
    const { data } = await call("search_parts", { query: "M8x30 316 hex" });
    expect(data.results.map((r: { sku: string }) => r.sku)).toEqual(["FX-1001", "FX-1002"]);
    expect(data.results[0]).toMatchObject({ score: 1, attributes: { material: "stainless_a4", standard: "ISO 4017" } });
    const searches = store.calls.filter((c) => c.op === "SearchParts").map((c) => c.variables.search);
    expect(searches).toEqual(["M8x30 316 hex", "M8"]);
  });

  it("lets mapped store attributes override the name", async () => {
    const withAttrs = part("FX-2001", "Setscrew 8 x 30", {
      custom_attributesV2: {
        items: [
          { code: "fx_thread", value: "M8" },
          { code: "fx_length", value: "30" },
          { code: "fx_material", selected_options: [{ label: "A4 Stainless (316)" }] },
        ],
      },
    });
    const store = fakeStore({ CompanyContext: ctx, CompanyCredit: () => ({ body: { data: { company: null } } }), SearchParts: () => ({ body: { data: { products: { items: [withAttrs] } } } }) });
    const { call } = await connectPaas(store, { attributeMap: { thread: "fx_thread", length_mm: "fx_length", material: "fx_material" } });
    const { data } = await call("search_parts", { query: "M8x30 A4" });
    expect(data.results[0]).toMatchObject({ sku: "FX-2001", score: 1, attributes: { thread: "M8", length_mm: 30, material: "stainless_a4" } });
    expect(store.calls.find((c) => c.op === "SearchParts")).toBeDefined();
  });
});

describe("search fallback", () => {
  it("falls back to the name filter, with the compact size token, when full-text search is empty", async () => {
    const store = fakeStore({
      CompanyContext: ctx,
      CompanyCredit: () => ({ body: { data: { company: null } } }),
      SearchParts: () => ({ body: { data: { products: { items: [] } } } }),
      SearchPartsByName: (v) => ({
        body: { data: { products: { items: v.match === "M8x30" ? [part("BL-1", "M8x30 Hex Set Screw 316 Stainless")] : [] } } },
      }),
    });
    const { call } = await connectPaas(store);
    const { data } = await call("search_parts", { query: "M8 x 30 A4 hex" });
    expect(data.results[0]).toMatchObject({ sku: "BL-1", score: 1 });
    expect(store.calls.filter((c) => c.op === "SearchPartsByName").map((c) => c.variables.match)).toEqual(["M8 x 30 A4 hex", "M8x30"]);
  });
});

describe("availability", () => {
  const visible = () => ({ body: { data: { products: { items: [part("FX-1001", "Hex Setscrew M8 x 30 A4", { quantity: 120 })] } } } });

  it("without an inventory token, reports storefront stock only", async () => {
    const store = fakeStore({ CompanyContext: ctx, CompanyCredit: () => ({ body: { data: { company: null } } }), PartsBySku: visible });
    const { call } = await connectPaas(store);
    const { data } = await call("check_availability", { skus: ["FX-1001"], qty_needed: { "FX-1001": 500 } });
    expect(data.items[0]).toMatchObject({ salable_qty: 120, can_fulfil: false });
    expect(store.calls.some((c) => c.kind === "rest")).toBe(false);
  });

  it("with an inventory token, uses MSI salable qty and per-source stock", async () => {
    const store = fakeStore(
      { CompanyContext: ctx, CompanyCredit: () => ({ body: { data: { company: null } } }), PartsBySku: visible },
      {
        "get-product-salable-quantity/FX-1001/2": () => ({ body: 450 }),
        "inventory/sources": () => ({ body: { items: [{ source_code: "leeds", name: "Leeds DC" }, { source_code: "bristol", name: "Bristol" }] } }),
        "inventory/source-items": () => ({
          body: { items: [{ source_code: "leeds", quantity: 800, status: 1 }, { source_code: "bristol", quantity: 0, status: 1 }] },
        }),
      },
    );
    const { call } = await connectPaas(store, { inventoryToken: "inv-token", stockId: 2, sourceLeadTimes: { leeds: 1 } });
    const { data } = await call("check_availability", { skus: ["FX-1001"], by_source: true });
    expect(data.items[0]).toMatchObject({ salable_qty: 450, in_stock: true, sources: [{ source_name: "Leeds DC", quantity: 800, lead_time_days: 1 }] });
    expect(data.items[0].message).toMatch(/Ships in 1 day/);
    expect(store.calls.filter((c) => c.kind === "rest").every((c) => c.headers.Authorization === "Bearer inv-token")).toBe(true);
  });

  it("never asks inventory about a SKU the company can't see", async () => {
    const store = fakeStore(
      { CompanyContext: ctx, CompanyCredit: () => ({ body: { data: { company: null } } }), PartsBySku: () => ({ body: { data: { products: { items: [] } } } }) },
      {},
    );
    const { call } = await connectPaas(store, { inventoryToken: "inv-token" });
    const res = await call("check_availability", { skus: ["SECRET-SKU"] });
    expect(res.data.error.code).toBe("NOT_FOUND");
    expect(store.calls.some((c) => c.kind === "rest")).toBe(false);
  });
});

describe("pricing", () => {
  it("uses the customer's final price and tier prices", async () => {
    const store = fakeStore({
      CompanyContext: ctx,
      CompanyCredit: () => ({ body: { data: { company: null } } }),
      PartsBySku: () => ({ body: { data: { products: { items: [part("FX-1001", "Hex M8x30 A4")] } } } }),
      CustomerPrices: () => ({
        body: {
          data: {
            products: {
              items: [
                {
                  sku: "FX-1001",
                  price_range: { minimum_price: { regular_price: money(0.34), final_price: money(0.27) } },
                  price_tiers: [{ quantity: 2000, final_price: money(0.25) }],
                },
              ],
            },
          },
        },
      }),
    });
    const { call } = await connectPaas(store);
    const { data } = await call("get_customer_price", { lines: [{ sku: "FX-1001", qty: 100 }, { sku: "FX-1001", qty: 2000 }] });
    expect(data.lines.map((l: { unit_price: number; price_source: string }) => [l.unit_price, l.price_source])).toEqual([
      [0.27, "customer_price"],
      [0.25, "tier"],
    ]);
    expect(data.subtotal).toBe(527);
  });
});

describe("orders and requisition lists", () => {
  const order = {
    number: "000104512",
    order_date: "2026-10-28 09:14:00",
    status: "Complete",
    email: JANE,
    total: { grand_total: money(1290) },
    items: [{ product_sku: "FX-1001", product_name: "Hex M8x30 A4", quantity_ordered: 3000, quantity_shipped: 3000, product_sale_price: { value: 0.27 } }],
    shipments: [{ tracking: [{ carrier: "custom", number: "DPD15502981", title: "DPD" }] }],
  };

  it("lists and reads orders through the customer's own GraphQL scope", async () => {
    const store = fakeStore({
      CompanyContext: ctx,
      CompanyCredit: () => ({ body: { data: { company: null } } }),
      ListOrders: (v) => ({ body: { data: { customer: { orders: { total_count: 3, items: v.filter ? [] : [order] } } } } }),
      OrderDetail: (v) => ({ body: { data: { customer: { orders: { items: v.number === order.number ? [order] : [] } } } } }),
    });
    const { call } = await connectPaas(store);
    const list = (await call("list_orders", { page_size: 1 })).data;
    expect(list).toMatchObject({ total: 3, has_more: true, items: [{ order_number: "000104512", line_count: 1 }] });
    await call("list_orders", { status: "processing" });
    expect(store.calls.filter((c) => c.op === "ListOrders")[1]!.variables.filter).toEqual({ status: { eq: "processing" } });

    const detail = (await call("get_order_status", { order_number: "000104512" })).data;
    expect(detail.shipments).toEqual([{ tracking_number: "DPD15502981", carrier: "DPD", shipped_at: null }]);
    expect((await call("get_order_status", { order_number: "000999999" })).data.error.code).toBe("NOT_FOUND");
  });

  it("reads requisition lists by uid", async () => {
    const store = fakeStore({
      CompanyContext: ctx,
      CompanyCredit: () => ({ body: { data: { company: null } } }),
      RequisitionList: () => ({
        body: {
          data: {
            customer: {
              requisition_lists: {
                items: [
                  {
                    uid: "Mw==",
                    name: "Pontoon kit",
                    description: null,
                    items_count: 1,
                    updated_at: null,
                    list_items: { items: [{ quantity: 2000, product: { sku: "FX-1001" } }] },
                  },
                ],
              },
            },
          },
        },
      }),
    });
    const { call } = await connectPaas(store);
    const { data } = await call("read_requisition_list", { list_id: "Mw==" });
    expect(data.items).toEqual([{ sku: "FX-1001", qty: 2000 }]);
  });
});

describe("draft negotiable quote", () => {
  const input = { name: "RFQ-2211", lines: [{ sku: "FX-1001", qty: 1000, note: "Match bolt grade" }] };

  function quoteStore(status: string) {
    return fakeStore({
      CompanyContext: ctx,
      CompanyCredit: () => ({ body: { data: { company: null } } }),
      PartsBySku: () => ({ body: { data: { products: { items: [part("FX-1001", "Hex M8x30 A4", { quantity: 5000 })] } } } }),
      CustomerPrices: () => ({
        body: { data: { products: { items: [{ sku: "FX-1001", price_range: { minimum_price: { regular_price: money(0.34), final_price: money(0.27) } }, price_tiers: [] }] } } },
      }),
      NewQuoteCart: () => ({ body: { data: { addProductsToNewCart: { cart: { id: "cart-new-1" }, user_errors: [] } } } }),
      DraftQuote: () => ({
        body: {
          data: {
            requestNegotiableQuote: {
              quote: {
                uid: "cart-new-1",
                name: "RFQ-2211",
                status,
                created_at: "2026-11-09 10:00:00",
                items: [{ uid: "item-1", quantity: 1000, product: { sku: "FX-1001", name: "Hex M8x30 A4" }, prices: { price: money(0.27), row_total: money(270) } }],
                prices: { subtotal_excluding_tax: money(270) },
              },
            },
          },
        },
      }),
      LineNote: () => ({ body: { data: { setLineItemNote: { quote: { uid: "cart-new-1" } } } } }),
    });
  }

  it("previews without writing, then drafts in a new cart with is_draft and line notes", async () => {
    const store = quoteStore("DRAFT");
    const { call } = await connectPaas(store, { quoteReviewUrl: "https://store.example.com/negotiable_quote/quote/" });
    const preview = (await call("draft_negotiable_quote", input)).data;
    expect(preview.preview.subtotal).toBe(270);
    expect(store.calls.some((c) => ["NewQuoteCart", "DraftQuote"].includes(c.op))).toBe(false);

    const saved = (await call("draft_negotiable_quote", { ...input, confirmation_token: preview.confirmation_token })).data;
    expect(saved).toMatchObject({ status: "draft_saved", quote: { quote_id: "cart-new-1", status: "draft", subtotal: 270 } });
    expect(store.calls.find((c) => c.op === "DraftQuote")!.variables.input).toMatchObject({ cart_id: "cart-new-1", is_draft: true });
    expect(store.calls.find((c) => c.op === "LineNote")!.variables.input).toEqual({ quote_uid: "cart-new-1", quote_item_uid: "item-1", note: "Match bolt grade" });
  });

  it("says so loudly if the store submitted instead of drafting", async () => {
    const store = quoteStore("SUBMITTED");
    const { call } = await connectPaas(store);
    const preview = (await call("draft_negotiable_quote", input)).data;
    const saved = (await call("draft_negotiable_quote", { ...input, confirmation_token: preview.confirmation_token })).data;
    expect(saved.status).toBe("saved_with_unexpected_status");
    expect(saved.warning).toMatch(/submitted/);
  });

  it("surfaces cart errors as INVALID_INPUT", async () => {
    const patched = fakeStore({
      CompanyContext: ctx,
      CompanyCredit: () => ({ body: { data: { company: null } } }),
      NewQuoteCart: () => ({ body: { data: { addProductsToNewCart: { cart: null, user_errors: [{ code: "INSUFFICIENT_STOCK", message: "The requested qty is not available" }] } } } }),
    });
    const backend = new PaasBackend({ ...loadConfig(BASE_ENV).paas!, fetch: patched.fetch });
    await expect(backend.createDraftQuote({ email: JANE }, { name: "x", lines: [{ sku: "FX-1001", qty: 1 }] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringMatching(/requested qty is not available/),
    });
  });
});

describe("draft quote cart safety", () => {
  it("handles user_errors: null from the store", async () => {
    const store = fakeStore({
      CompanyContext: ctx,
      CompanyCredit: () => ({ body: { data: { company: null } } }),
      NewQuoteCart: () => ({ body: { data: { addProductsToNewCart: { cart: { id: "c1" }, user_errors: null } } } }),
      DraftQuote: () => ({
        body: { data: { requestNegotiableQuote: { quote: { uid: "c1", name: "x", status: "DRAFT", created_at: null, items: [], prices: null } } } },
      }),
    });
    const backend = new PaasBackend({ ...loadConfig(BASE_ENV).paas!, fetch: store.fetch });
    const q = await backend.createDraftQuote({ email: JANE }, { name: "x", lines: [{ sku: "FX-1001", qty: 1 }] });
    expect(q.status).toBe("draft");
    expect(store.calls.some((c) => c.op === "RestoreCart")).toBe(false);
  });

  it("restores the buyer's previous cart when the quote request fails", async () => {
    const store = fakeStore({
      CompanyContext: ctx,
      CompanyCredit: () => ({ body: { data: { company: null } } }),
      NewQuoteCart: () => ({ body: { data: { addProductsToNewCart: { cart: { id: "c2" }, user_errors: [] } } } }),
      DraftQuote: () => ({ status: 503, body: {} }),
      RestoreCart: () => ({ body: { data: { setCartAsInactive: { success: true, error: null } } } }),
    });
    const backend = new PaasBackend({ ...loadConfig(BASE_ENV).paas!, fetch: store.fetch });
    await expect(backend.createDraftQuote({ email: JANE }, { name: "x", lines: [{ sku: "FX-1001", qty: 1 }] })).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(store.calls.find((c) => c.op === "RestoreCart")?.variables).toEqual({ cartId: "c2" });
  });
});

describe("upstream failures", () => {
  it("maps 503 to a retryable UPSTREAM_UNAVAILABLE", async () => {
    const store = fakeStore({ CompanyContext: () => ({ status: 503, body: { message: "maintenance" } }) });
    const { call } = await connectPaas(store);
    expect((await call("get_company_context")).data.error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true });
  });

  it("times out slow stores", async () => {
    const store = fakeStore({ CompanyContext: () => "timeout" });
    const { call } = await connectPaas(store, { timeoutMs: 50 });
    expect((await call("get_company_context")).data.error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true });
  });

  it("maps GraphQL input errors to INVALID_INPUT", async () => {
    const store = fakeStore({
      CompanyContext: ctx,
      CompanyCredit: () => ({ body: { data: { company: null } } }),
      PartDetail: () => ({ body: { errors: [{ message: "Field sku is invalid", extensions: { category: "graphql-input" } }] } }),
    });
    const { call } = await connectPaas(store);
    expect((await call("get_product", { sku: "FX-1001" })).data.error.code).toBe("INVALID_INPUT");
  });

  it("caches company context instead of re-querying on every call", async () => {
    const store = fakeStore({
      CompanyContext: ctx,
      CompanyCredit: () => ({ body: { data: { company: null } } }),
      PartDetail: () => ({ body: { data: { products: { items: [{ ...part("FX-1001", "Hex M8x30 A4"), description: { html: "<p>Good</p>" } }] } } } }),
    });
    const { call } = await connectPaas(store);
    await call("get_product", { sku: "FX-1001" });
    await call("get_product", { sku: "FX-1001" });
    expect(store.calls.filter((c) => c.op === "CompanyContext")).toHaveLength(1);
  });
});
