import { describe, expect, it } from "vitest";
import { connect } from "./helpers.js";

describe("tool listing and allowlist", () => {
  it("registers all tools with read-only hints on reads", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "check_availability",
        "draft_negotiable_quote",
        "get_company_context",
        "get_customer_price",
        "get_order_status",
        "get_product",
        "list_orders",
        "read_requisition_list",
        "search_parts",
      ].sort(),
    );
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(t.name !== "draft_negotiable_quote");
  });

  it("hides disabled tools entirely", async () => {
    const { client } = await connect({ COMMERCE_TOOLS_DISABLED: "draft_negotiable_quote,list_orders" });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("draft_negotiable_quote");
    expect(names).not.toContain("list_orders");
  });

  it("rejects unknown tool names in the allowlist", async () => {
    await expect(connect({ COMMERCE_TOOLS_ENABLED: "search_part" })).rejects.toThrow(/Unknown tool/);
  });
});

describe("search_parts", () => {
  it("matches messy RFQ text and ranks exact material first", async () => {
    const { call } = await connect();
    const { data } = await call("search_parts", { query: "M8 x 30 316 hex setscrew" });
    expect(data.interpreted).toMatchObject({ thread: "M8", length_mm: 30, material: "stainless_a4" });
    expect(data.results[0]).toMatchObject({ sku: "HXB-M8-30-A4", score: 1 });
    expect(data.results.map((r: { sku: string }) => r.sku)).not.toContain("HXB-M8-40-A4");
  });

  it("returns both stainless grades for SS", async () => {
    const { call } = await connect();
    const { data } = await call("search_parts", { query: "M8x30 SS hex" });
    expect(data.results.map((r: { sku: string }) => r.sku).sort()).toEqual(["HXB-M8-30-A2", "HXB-M8-30-A4"]);
  });

  it("never offers a different size and says so", async () => {
    const { call } = await connect();
    const { data } = await call("search_parts", { query: "M8x35 A4 hex" });
    expect(data.results).toEqual([]);
    expect(data.note).toMatch(/human review/);
  });

  it("only searches the caller's shared catalog", async () => {
    const { call } = await connect({ COMMERCE_CALLER_EMAIL: "li.wei@acme.example" });
    const { data } = await call("search_parts", { query: "M8x30 A4" });
    // Acme's catalog has no A4 bolt: only the A2 one, flagged as a material mismatch.
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toMatchObject({ sku: "HXB-M8-30-A2", mismatched: ["material"] });
  });
});

describe("pricing, stock and product", () => {
  it("applies the lowest of base, tier and shared-catalog price", async () => {
    const { call } = await connect();
    const { data } = await call("get_customer_price", {
      lines: [
        { sku: "HXB-M8-30-A4", qty: 100 }, // shared catalog 0.27 < base 0.34
        { sku: "HXB-M8-30-A4", qty: 2000 }, // tier 0.25 < 0.27
        { sku: "WSH-M8-A4", qty: 10 }, // base only
      ],
    });
    expect(data.lines.map((l: { unit_price: number; price_source: string }) => [l.unit_price, l.price_source])).toEqual([
      [0.27, "shared_catalog"],
      [0.25, "tier"],
      [0.04, "base"],
    ]);
  });

  it("gives another company its own price", async () => {
    const { call } = await connect({ COMMERCE_CALLER_EMAIL: "li.wei@acme.example" });
    const { data } = await call("get_customer_price", { lines: [{ sku: "HXB-M8-30-A2", qty: 100 }] });
    expect(data.lines[0].unit_price).toBe(0.21);
  });

  it("computes MSI salable qty minus reservations and reports shortfall", async () => {
    const { call } = await connect();
    const { data } = await call("check_availability", {
      skus: ["HXB-M8-30-A4"],
      qty_needed: { "HXB-M8-30-A4": 1000 },
      by_source: true,
    });
    // leeds 800 + bristol 300 - reserved 650 = 450
    expect(data.items[0]).toMatchObject({ salable_qty: 450, can_fulfil: false });
    expect(data.items[0].message).toMatch(/short by 550/);
    expect(data.items[0].sources).toHaveLength(2);
  });

  it("returns merchant text as labelled data", async () => {
    const { call } = await connect();
    const { data } = await call("get_product", { sku: "SHC-M6-20-A2" });
    expect(data.description.source).toBe("merchant_content");
  });

  it("hides SKUs outside the shared catalog as NOT_FOUND", async () => {
    const { call } = await connect();
    const res = await call("get_product", { sku: "ROD-M10-1000-Z" });
    expect(res.isError).toBe(true);
    expect(res.data.error).toMatchObject({ code: "NOT_FOUND", retryable: false });
  });
});

describe("company scoping", () => {
  it("returns company context and credit", async () => {
    const { call } = await connect();
    const { data } = await call("get_company_context");
    expect(data).toMatchObject({ company_id: "CO-1001", credit: { available: 6749.6 } });
  });

  it("hides credit from users without permission", async () => {
    const { call } = await connect({ COMMERCE_CALLER_EMAIL: "tom.site@northwind.example" });
    expect((await call("get_company_context")).data.credit).toBeNull();
  });

  it("lists only the caller's company orders", async () => {
    const { call } = await connect();
    const { data } = await call("list_orders", {});
    expect(data.total).toBe(2);
    expect(data.items[0].order_number).toBe("000104977");
  });

  it("restricts users without orders.view_all to their own orders", async () => {
    const { call } = await connect({ COMMERCE_CALLER_EMAIL: "tom.site@northwind.example" });
    const { data } = await call("list_orders", {});
    expect(data.items.map((o: { placed_by: string }) => o.placed_by)).toEqual(["tom.site@northwind.example"]);
  });

  it("answers another company's order with the same NOT_FOUND as a missing one", async () => {
    const { call } = await connect();
    const other = await call("get_order_status", { order_number: "000104980" });
    const missing = await call("get_order_status", { order_number: "000999999" });
    expect(other.data.error.code).toBe("NOT_FOUND");
    expect(missing.data.error.code).toBe("NOT_FOUND");
  });

  it("paginates orders", async () => {
    const { call } = await connect();
    const { data } = await call("list_orders", { page: 1, page_size: 1 });
    expect(data).toMatchObject({ total: 2, has_more: true });
    expect(data.items).toHaveLength(1);
  });

  it("reads requisition lists", async () => {
    const { call } = await connect();
    expect((await call("read_requisition_list")).data.lists).toHaveLength(1);
    expect((await call("read_requisition_list", { list_id: "RL-11" })).data.items).toHaveLength(3);
    expect((await call("read_requisition_list", { list_id: "RL-27" })).data.error.code).toBe("NOT_FOUND");
  });

  it("rejects bad input with a structured error", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "get_order_status", arguments: { order_number: "abc" } });
    expect(res.isError).toBe(true);
  });
});

describe("draft_negotiable_quote", () => {
  const input = {
    name: "RFQ-2211 Harbour pontoons",
    lines: [
      { sku: "HXB-M8-30-A4", qty: 1000 },
      { sku: "NUT-M8-A4", qty: 1000, note: "Match bolt grade" },
    ],
  };

  it("previews first, then saves a draft only with a valid token", async () => {
    const { call, audit } = await connect();
    const preview = (await call("draft_negotiable_quote", input)).data;
    expect(preview.status).toBe("preview_requires_approval");
    expect(preview.preview.subtotal).toBe(330); // 1000*0.27 + 1000*0.06
    expect(preview.warnings).toEqual(["HXB-M8-30-A4: requested 1000, salable 450"]);

    const saved = (await call("draft_negotiable_quote", { ...input, confirmation_token: preview.confirmation_token })).data;
    expect(saved.status).toBe("draft_saved");
    expect(saved.quote).toMatchObject({ status: "draft", subtotal: 330 });

    const log = audit.entries.filter((e) => e.tool === "draft_negotiable_quote");
    expect(log).toHaveLength(2);
    expect((log[1]!.input as { confirmation_token: string }).confirmation_token).toBe("[redacted]");
  });

  it("rejects a token reused with changed input", async () => {
    const { call } = await connect();
    const preview = (await call("draft_negotiable_quote", input)).data;
    const changed = { ...input, lines: [{ sku: "HXB-M8-30-A4", qty: 5000 }], confirmation_token: preview.confirmation_token };
    const res = await call("draft_negotiable_quote", changed);
    expect(res.data.error).toMatchObject({ code: "CONFIRMATION_INVALID", retryable: false });
  });

  it("rejects a token from another caller", async () => {
    // Same input, visible to both companies: only the caller differs.
    const shared = { name: "Shared", lines: [{ sku: "HXB-M8-30-A2", qty: 10 }] };
    const a = await connect();
    const token = (await a.call("draft_negotiable_quote", shared)).data.confirmation_token;
    const b = await connect({ COMMERCE_CALLER_EMAIL: "li.wei@acme.example" });
    const res = await b.call("draft_negotiable_quote", { ...shared, confirmation_token: token });
    expect(res.data.error.code).toBe("CONFIRMATION_INVALID");
  });

  it("forbids users without quotes.create", async () => {
    const { call } = await connect({ COMMERCE_CALLER_EMAIL: "tom.site@northwind.example" });
    expect((await call("draft_negotiable_quote", input)).data.error.code).toBe("FORBIDDEN");
  });

  it("rejects duplicate SKUs", async () => {
    const { call } = await connect();
    const res = await call("draft_negotiable_quote", { name: "x", lines: [{ sku: "NUT-M8-A4", qty: 1 }, { sku: "nut-m8-a4", qty: 2 }] });
    expect(res.data.error.code).toBe("INVALID_INPUT");
  });
});

describe("audit input minimisation", () => {
  it("keeps SKUs, quantities and attributes but replaces free text with its length in shape mode", async () => {
    const { connect } = await import("./helpers.js");
    const { call, audit } = await connect({ COMMERCE_AUDIT_INPUT: "shape" });
    await call("search_parts", { query: "M8x30 hex bolts for Mr Smith's boat", filters: { thread: "M8" } });
    const input = audit.entries.at(-1)!.input as Record<string, unknown>;
    expect(input.query).toBe("[text, 35 chars]");
    expect(input.filters).toEqual({ thread: "M8" });
    expect(input.limit).toBe(5);
  });

  it("rejects an unknown mode", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig({ COMMERCE_AUDIT_INPUT: "none" })).toThrow(/COMMERCE_AUDIT_INPUT/);
  });
});
