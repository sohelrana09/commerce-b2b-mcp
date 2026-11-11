# commerce-b2b-mcp

An MCP server that lets an AI agent work as a **B2B buyer's assistant or a sales rep's assistant** on Adobe Commerce: find the right part from messy RFQ text, check MSI stock, get the company's real price, look up orders and reorder lists, and draft a negotiable quote for a human to approve.

It is built for the B2B layer that generic Magento MCP servers leave out: company accounts, shared catalogs, negotiable quotes, requisition lists and MSI salable quantity. It is designed to run against both Adobe Commerce PaaS and Adobe Commerce as a Cloud Service (ACCS).

> **Status: v0.2.** Mock mode and an Adobe Commerce PaaS adapter (2.4.7+ with B2B), verified end to end on a live **Adobe Commerce 2.4.8-p5 with B2B 1.5.2-p3** store (local copy of a production fastener catalogue, ~17,000 products). ACCS is next.

## Try it in 2 minutes

```bash
npm install
npm run build
```

Add it to Claude Desktop (`claude_desktop_config.json`) or any MCP client:

```json
{
  "mcpServers": {
    "commerce-b2b": {
      "command": "node",
      "args": ["/absolute/path/to/commerce-b2b-mcp/dist/index.js"],
      "env": { "COMMERCE_BACKEND": "mock" }
    }
  }
}
```

Then ask things like:

- "What's our price and stock for 1,000 M8x30 316 hex setscrews?"
- "Has order 000104977 shipped?"
- "Quote me my pontoon repair reorder list, but double the bolts."

Mock mode acts as Jane, a purchasing manager at *Northwind Fixings*. Set `COMMERCE_CALLER_EMAIL` to `tom.site@northwind.example` (limited permissions) or `li.wei@acme.example` (a different company) to see caller scoping in action.

## Tools

| Tool | Type | What it does |
|---|---|---|
| `get_company_context` | read | Company, user role and B2B permissions, shared catalog, credit limit and available credit, payment on account, sales rep |
| `search_parts` | read | Attribute-aware fastener search from free text ("M8x30 SS hex", "m10 x 50 8.8 bzp"), with a match score and the attributes that did and didn't match |
| `get_product` | read | One SKU with attributes, pack size, variants; merchant description returned as labelled data |
| `check_availability` | read | MSI salable qty (sources minus reservations), shortfall against a needed qty, lead-time message, optional per-source breakdown |
| `get_customer_price` | read | Final unit price for this company: lowest of base, tier and shared-catalog price |
| `list_orders` | read | This company's orders, paginated; own orders only without `orders.view_all` |
| `get_order_status` | read | Lines, shipped qty and tracking for one of this company's orders |
| `read_requisition_list` | read | The user's saved reorder lists, or one list's items |
| `draft_negotiable_quote` | write | Preview, then save a **draft** quote after human approval. Never submits it |

Placing orders, payments, customer edits and deletes are deliberately out of scope for v1.

## Safety model

This is the part that matters most when an agent touches a live B2B store.

1. **Caller-scoped, never admin-scoped.** The server always acts as one company user. Shared catalogs control what that user can see and pay; orders and lists are filtered to their company and permissions. Another company's order returns the same `NOT_FOUND` as a missing one, so existence isn't leaked.
2. **Read by default, propose-then-approve for writes.** A write call without a token returns a priced preview, stock warnings and a signed `confirmation_token`. The token is an HMAC over the tool, the caller and the exact input, and expires after 10 minutes. Changing anything after the preview invalidates it. Even when confirmed, the quote is only saved as a draft for a person to submit.
3. **Per-tool allowlist.** `COMMERCE_TOOLS_ENABLED` or `COMMERCE_TOOLS_DISABLED`. Disabled tools aren't registered, so the agent never sees them. Unknown names fail at startup, so a typo can't silently enable everything.
4. **Audit log.** One JSONL line per call: time, caller, company, tool, input (tokens and secrets redacted), outcome, error code, result size and duration.
5. **Store content is data.** Descriptions and notes are stripped of markup, length-capped and labelled `merchant_content`. Tool descriptions and server instructions are static text and never include store content. The fixtures include a product whose description contains a prompt-injection attempt, so you can test this.
6. **Structured errors.** Every failure has a `code`, `message`, `retryable` flag and sometimes a `hint`, so the agent can tell "fix your input" from "try again later" from "ask a human".
7. **Context budget.** Pagination, a hard page-size cap, and trimmed payloads (summaries and IDs, not full Magento entities).

**Known limit of propose-then-approve.** The token proves that the confirmed call matches the previewed one. It can't prove a human saw the preview: that depends on the MCP client showing it to them. For that reason the write tool is limited to drafts, and the server instructions tell the agent to wait for explicit approval.

## Connect to Adobe Commerce (PaaS)

Requirements: Adobe Commerce 2.4.7+ with the B2B extension, GraphQL enabled, and a company user account for the agent to act as.

```bash
cp .env.example .env   # fill in, then load it in your MCP client config
```

```json
{
  "mcpServers": {
    "commerce-b2b": {
      "command": "node",
      "args": ["/absolute/path/to/commerce-b2b-mcp/dist/index.js"],
      "env": {
        "COMMERCE_BACKEND": "paas",
        "COMMERCE_BASE_URL": "https://store.example.com",
        "COMMERCE_CALLER_EMAIL": "buyer@company.example",
        "COMMERCE_CUSTOMER_TOKEN": "<customer token>",
        "COMMERCE_CONFIRM_SECRET": "<32+ random characters>"
      }
    }
  }
}
```

### How the adapter stays caller-scoped

- **Everything company-specific uses storefront GraphQL with the company user's customer token**: catalogue search and visibility, prices, company and credit, orders, requisition lists and quotes. Magento itself applies the shared catalog, customer-group and tier pricing, and company role permissions.
- **No admin token, by design.** Config refuses to start without a customer token or password. Before every call the adapter checks (cached for 60 seconds) that the token's user matches `COMMERCE_CALLER_EMAIL` and is an active company member.
- **MSI quantities are the one exception.** Salable quantity and per-source stock are only exposed through the admin REST API. If you want them, create an integration with **only** the inventory read ACLs (`Magento_InventoryApi::source`, `Magento_InventoryApi::stock`, salable quantity) and set `COMMERCE_INVENTORY_TOKEN`. The adapter first checks with the customer token that the SKU is visible to the company, and only then asks inventory. Without the token, availability falls back to the storefront `stock_status` and `quantity` fields.
- **Draft quotes never touch the buyer's open cart.** Lines go into a new cart (`addProductsToNewCart`), which becomes a negotiable quote via `requestNegotiableQuote` with `is_draft: true`. Line notes are added with `setLineItemNote`. If the store returns any status other than `DRAFT` (older B2B versions may ignore the flag), the tool reports it as a warning instead of calling it a draft.
- **Fastener attributes** come from the product name by default. If your catalogue has dedicated attributes, map them with `COMMERCE_ATTRIBUTE_MAP` and they override what the name says.

### Verified on a live store (2.4.8-p5, B2B 1.5.2-p3)

| Check | Result |
| --- | --- |
| `requestNegotiableQuote` with `is_draft: true` | Saved as `DRAFT`; line notes stored as buyer notes |
| Buyer's open cart | Unchanged. `addProductsToNewCart` makes the new cart active, the quote request hands the previous cart back, and on any failure the adapter calls `setCartAsInactive`, which also restores it |
| Company ACL mapping | Matches the role's grants in the database, for a company admin and a "Default User" buyer |
| Storefront `quantity` field | `null` on this store: exact stock needs `COMMERCE_INVENTORY_TOKEN` |

Fixes the live run forced:
- `Customer.group` and `RequisitionList.requisition_list_items` are 2.4.9-only. The adapter now uses fields that exist on 2.4.7 to 2.4.9.
- The store returns `user_errors: null`, not `[]`, from `addProductsToNewCart`.
- Full-text `search` can fail silently when a store's search index is misconfigured; the store returns zero results and logs the error. `search_parts` then falls back to the GraphQL name filter, plus a compact size token such as `M8x30`.

Some B2B versions have no requisition-list ACL resource. There, only company admins show `requisition_lists.view`, but Magento still lets buyers use their lists.

### Known PaaS limits

- **Orders**: storefront GraphQL returns the logged-in user's own orders, so `list_orders` doesn't include colleagues' orders even when the role allows it.
- **Not exposed to the storefront API**: shared catalog name, the "allow exceeding credit limit" setting, PO numbers on orders, and shipment dates. These come back as `null` rather than guessed values.
- **Lead times**: MSI has no lead-time field. Set `COMMERCE_SOURCE_LEAD_TIMES` per source, or messages omit them.
- **Pack size and unit of measure** default to `1` and `each` until mapped.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `COMMERCE_BACKEND` | `mock` | `mock` or `paas` |
| `COMMERCE_CALLER_EMAIL` | Jane (mock only) | The company user the server acts as. Required outside mock mode |
| `COMMERCE_TOOLS_ENABLED` | all | Comma-separated allowlist |
| `COMMERCE_TOOLS_DISABLED` | none | Comma-separated denylist (ignored if `ENABLED` is set) |
| `COMMERCE_AUDIT_LOG` | `stderr` | `stderr` or a file path for JSONL audit lines |
| `COMMERCE_CONFIRM_SECRET` | random per process (mock only) | HMAC secret for confirmation tokens. Required outside mock mode |
| `COMMERCE_CONFIRM_TTL_SECONDS` | `600` | Confirmation token lifetime |

PaaS only:

| Variable | Required | Purpose |
|---|---|---|
| `COMMERCE_BASE_URL` | yes | Store base URL. Must be https, except for localhost and `.test` hosts |
| `COMMERCE_CUSTOMER_TOKEN` | one of these two | Company user's customer token (preferred: no password stored) |
| `COMMERCE_CUSTOMER_PASSWORD` | one of these two | Company user's password; the adapter logs in as `COMMERCE_CALLER_EMAIL` and refreshes expired tokens |
| `COMMERCE_STORE_CODE` | no | Sent as the GraphQL `Store` header and REST store path |
| `COMMERCE_INVENTORY_TOKEN` | no | Least-privilege integration token for MSI read APIs |
| `COMMERCE_STOCK_ID` | no (default `1`) | MSI stock for salable quantity |
| `COMMERCE_SOURCE_LEAD_TIMES` | no | JSON, e.g. `{"leeds":1,"bristol":2}` |
| `COMMERCE_ATTRIBUTE_MAP` | no | JSON from `thread`, `length_mm`, `material`, `grade`, `finish`, `head`, `part_type` to your attribute codes |
| `COMMERCE_QUOTE_REVIEW_URL` | no | Storefront page where buyers review quotes, returned with each draft |
| `COMMERCE_TIMEOUT_MS` | no (default `15000`) | Per-request timeout |

## Architecture

```
MCP client (Claude)
      │  stdio  (Streamable HTTP + OAuth: planned)
      ▼
tools/            schema validation, allowlist, audit, structured errors,
                  confirmation tokens, merchant-text labelling
      │
      ▼
CommerceBackend   one interface, always called with the caller identity
 ├─ MockBackend   fixtures: 2 companies, shared catalogs, MSI sources, reservations
 ├─ PaasBackend   storefront GraphQL as the company user,
 │                optional least-privilege MSI REST token
 └─ ACCS adapter  ACCS APIs with Adobe IMS                          (planned)
```

`src/normalize.ts` handles fastener naming: thread and length (`M8x30`, `M8 x 30`, `M8*30`), stainless grades (`A2`/`304`, `A4`/`316`, `SS` = either), steel grades, finishes (`BZP`, `HDG`) and head types. Thread and length must match exactly. A partial match on other attributes is returned with its score and what differs, so the agent can flag it instead of guessing.

## Development

```bash
npm test          # vitest: unit tests, end-to-end MCP tests, PaaS adapter tests against a fake store
npm run typecheck
npm run dev       # run from source with tsx
```

## Roadmap

- [x] v0.1: 9 tools, safety model, mock backend, tests, CI
- [x] v0.2: PaaS adapter (GraphQL as the company user, optional MSI token, draft quotes in a new cart)
- [x] Verify the PaaS adapter on a live B2B instance (2.4.8-p5, B2B 1.5.2-p3)
- [ ] Test with an inventory integration token (MSI salable qty, per-source stock)
- [ ] Parser evals on real catalogue names (e.g. "Screw Gudgeon" is read as a screw)
- [ ] Streamable HTTP transport with OAuth, mapping each token to a company user
- [ ] ACCS adapter with Adobe IMS; confirm which B2B APIs ACCS exposes before claiming parity
- [ ] App Builder / I/O Runtime deployment in stateless HTTP mode
- [ ] `npx` and Docker one-command demo, demo GIF

## Related projects

- [magebitcom/magento2-mcp-module](https://packagist.org/packages/magebitcom/magento2-mcp-module): a well-built PHP module for admin-side catalog, orders, customers, CMS and reports on PaaS. Use it for admin workflows; this project covers the B2B buyer and sales-rep side, and targets ACCS as well.
- [boldcommerce/magento2-mcp](https://github.com/boldcommerce/magento2-mcp) and [iranimij/magento-mcp](https://github.com/iranimij/magento-mcp): smaller product-query servers.

## Licence

MIT
