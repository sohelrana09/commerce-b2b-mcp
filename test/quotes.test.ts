import { describe, expect, it } from "vitest";
import type { MockBackend } from "../src/backend/mock/mock-backend.js";
import { connect } from "./helpers.js";

const OPT_IN = { COMMERCE_TOOLS_ENABLED: "draft_negotiable_quote,list_negotiable_quotes,get_negotiable_quote,submit_negotiable_quote,close_negotiable_quote" };
const draft = { name: "RFQ-2211 Harbour pontoons", comment: "For the pontoon job", lines: [{ sku: "HXB-M8-30-A4", qty: 100 }] };

async function withDraft(env: Record<string, string> = {}) {
  const c = await connect({ ...OPT_IN, ...env });
  const preview = (await c.call("draft_negotiable_quote", draft)).data;
  const saved = (await c.call("draft_negotiable_quote", { ...draft, confirmation_token: preview.confirmation_token })).data;
  return { ...c, quoteId: saved.quote.quote_id as string, mock: c.backend as MockBackend };
}

describe("opt-in quote writes", () => {
  it("are not registered unless COMMERCE_TOOLS_ENABLED names them", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_negotiable_quotes");
    expect(names).toContain("get_negotiable_quote");
    expect(names).not.toContain("submit_negotiable_quote");
    expect(names).not.toContain("close_negotiable_quote");
  });

  it("are registered, as writes, when named", async () => {
    const { client } = await connect(OPT_IN);
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "submit_negotiable_quote")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === "close_negotiable_quote")?.annotations?.destructiveHint).toBe(true);
  });
});

describe("negotiation lifecycle", () => {
  it("lists and reads the buyer's draft with its comment history", async () => {
    const { call, quoteId } = await withDraft();
    const list = (await call("list_negotiable_quotes")).data;
    expect(list.items[0]).toMatchObject({ quote_id: quoteId, status: "draft", line_count: 1 });
    const q = (await call("get_negotiable_quote", { quote_id: quoteId })).data;
    expect(q.comments[0]).toMatchObject({ author: "buyer", text: { source: "merchant_content", text: "For the pontoon job" } });
  });

  it("submits only after a preview and a valid token, once", async () => {
    const { call, quoteId } = await withDraft();
    const preview = (await call("submit_negotiable_quote", { quote_id: quoteId, comment: "Please quote by Friday" })).data;
    expect(preview.status).toBe("preview_requires_approval");
    expect((await call("get_negotiable_quote", { quote_id: quoteId })).data.status).toBe("draft");

    const args = { quote_id: quoteId, comment: "Please quote by Friday", confirmation_token: preview.confirmation_token };
    const done = (await call("submit_negotiable_quote", args)).data;
    expect(done).toMatchObject({ status: "submitted", quote: { status: "submitted" } });
    const again = await call("submit_negotiable_quote", args);
    expect(again.isError).toBe(true);
  });

  it("refuses a token for a different comment", async () => {
    const { call, quoteId } = await withDraft();
    const preview = (await call("submit_negotiable_quote", { quote_id: quoteId, comment: "A" })).data;
    const res = await call("submit_negotiable_quote", { quote_id: quoteId, comment: "B", confirmation_token: preview.confirmation_token });
    expect(res.data.error.code).toBe("CONFIRMATION_INVALID");
  });

  it("refuses a preview the seller has overtaken, then lets the buyer reply to the counter-offer", async () => {
    const { call, quoteId, mock } = await withDraft();
    const p1 = (await call("submit_negotiable_quote", { quote_id: quoteId })).data;
    await call("submit_negotiable_quote", { quote_id: quoteId, confirmation_token: p1.confirmation_token });

    // Submitted quotes are with the seller: nothing to send.
    expect((await call("submit_negotiable_quote", { quote_id: quoteId })).data.error.code).toBe("INVALID_INPUT");

    mock.sellerRespond(quoteId, { comment: "Best we can do is 0.24 each", unitPrices: { "HXB-M8-30-A4": 0.24 } });
    const q = (await call("get_negotiable_quote", { quote_id: quoteId })).data;
    expect(q).toMatchObject({ status: "updated", subtotal: 24 });
    expect(q.comments.at(-1)).toMatchObject({ author: "seller" });

    const p2 = (await call("submit_negotiable_quote", { quote_id: quoteId, comment: "Can you do 0.22?" })).data;
    // The seller changes the price again before the buyer confirms: the approved preview no longer describes the quote.
    mock.sellerRespond(quoteId, { comment: "Revised", unitPrices: { "HXB-M8-30-A4": 0.25 } });
    const stale = await call("submit_negotiable_quote", { quote_id: quoteId, comment: "Can you do 0.22?", confirmation_token: p2.confirmation_token });
    expect(stale.data.error).toMatchObject({ code: "CONFIRMATION_INVALID", message: expect.stringMatching(/changed after the preview/) });
  });

  it("closes a quote after approval and refuses to close it twice", async () => {
    const { call, quoteId } = await withDraft();
    const p = (await call("close_negotiable_quote", { quote_id: quoteId })).data;
    expect(p.action).toMatch(/cannot be reopened/);
    expect((await call("close_negotiable_quote", { quote_id: quoteId, confirmation_token: p.confirmation_token })).data.quote.status).toBe("closed");
    expect((await call("close_negotiable_quote", { quote_id: quoteId })).data.error.code).toBe("INVALID_INPUT");
  });
});

describe("quote scoping", () => {
  it("hides one buyer's quotes from another company and from colleagues", async () => {
    const sam = await withDraft(); // Jane at Northwind
    // Same mock store, different callers: build their servers on Sam's backend.
    const { createServer } = await import("../src/server.js");
    const { loadConfig } = await import("../src/config.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { memoryAuditSink } = await import("../src/audit.js");
    const as = async (email: string) => {
      const config = loadConfig({ COMMERCE_BACKEND: "mock", COMMERCE_CONFIRM_SECRET: "test-secret", COMMERCE_CALLER_EMAIL: email, ...OPT_IN });
      const { server } = createServer(config, { backend: sam.backend, audit: memoryAuditSink() });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "0" });
      await Promise.all([server.connect(st), client.connect(ct)]);
      return async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        return JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
      };
    };
    const li = await as("li.wei@acme.example");
    expect((await li("get_negotiable_quote", { quote_id: sam.quoteId })).error.code).toBe("NOT_FOUND");
    expect((await li("submit_negotiable_quote", { quote_id: sam.quoteId })).error.code).toBe("NOT_FOUND");
    expect((await li("list_negotiable_quotes", {})).items).toEqual([]);
    const tom = await as("tom.site@northwind.example");
    expect((await tom("submit_negotiable_quote", { quote_id: sam.quoteId })).error.code).toBe("FORBIDDEN");
  });
});
