# commerce-b2b-mcp

[![CI](https://github.com/sohelrana09/commerce-b2b-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sohelrana09/commerce-b2b-mcp/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20Streamable%20HTTP-6b4fbb)](https://modelcontextprotocol.io/)
[![Adobe Commerce](https://img.shields.io/badge/Adobe%20Commerce-B2B%202.4.7%2B-eb1000)](https://business.adobe.com/products/magento/magento-commerce.html)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ed)](#docker)
[![GitHub stars](https://img.shields.io/github/stars/sohelrana09/commerce-b2b-mcp?style=social)](https://github.com/sohelrana09/commerce-b2b-mcp)
[![License](https://img.shields.io/github/license/sohelrana09/commerce-b2b-mcp)](LICENSE)

**An open-source MCP server that lets an AI agent work as a B2B buyer's or sales rep's assistant on Adobe Commerce, scoped to one company user and safe by default.**

Built by [Sohel Rana](https://sohelrana.io), Adobe Certified Master Architect and Claude Certified Architect – Foundations (CCAR-F).

**[Demo in one command](#see-it-in-one-command)** · [Quick start](#quick-start) · [Safety model](#safety-model) · [Quote assistant](#rfq-quote-assistant) · [Architecture decisions](docs/decisions.md) · [Contributing](CONTRIBUTING.md)

With this server, an agent such as Claude can find the right part from messy RFQ text, check MSI stock and get the company's real price. It can also look up orders and reorder lists, and draft a negotiable quote for a person to approve.

It covers the B2B layer that generic Magento MCP servers leave out: company accounts, shared catalogs, negotiable quotes, requisition lists and MSI salable quantity.

**Key features**

- **Caller-scoped, never admin:** every call acts as one signed-in company user, so Magento applies that company's shared catalog, prices and role permissions. There is no admin token, by design.
- **Nine B2B tools:** company context and credit, attribute-aware part search, product detail, MSI availability, company price, orders, order status, requisition lists, and draft negotiable quotes.
- **Propose, then approve:** the one write tool returns a priced preview and a signed confirmation token. It saves only a draft quote, and never submits it.
- **RFQ quote assistant:** turns a customer's emailed or CSV request for quote into a priced review sheet, flags every line a person must check, then drafts the quote. A 151-line golden set guards it, and its safety number ("wrong lines marked ready") is held at 0.
- **Local or hosted:** stdio for one user on their own machine, or Streamable HTTP with OAuth where each access token is one company user, on one instance or several sharing an encrypted Redis store. Every call is audited and traced.
- **Verified on a real store:** Adobe Commerce 2.4.8-p5 with B2B 1.5.2-p3, on a copy of a production fastener catalogue (~17,000 products).

> **Status: v0.4.** Mock mode and an Adobe Commerce PaaS adapter (2.4.7+ with B2B). v0.3 added the [RFQ quote assistant](#rfq-quote-assistant) with a golden eval set. v0.4 adds a [remote transport](#remote-transport-streamable-http--oauth) (Streamable HTTP with OAuth, one company user per token) and per-call tracing. Adobe Commerce as a Cloud Service (ACCS) is next.

---

## Contents

- [See it in one command](#see-it-in-one-command)
- [Who it is for](#who-it-is-for)
- [What an agent can do](#what-an-agent-can-do)
- [Quick start](#quick-start)
- [RFQ quote assistant](#rfq-quote-assistant)
- [Safety model](#safety-model)
- [Connect to Adobe Commerce (PaaS)](#connect-to-adobe-commerce-paas)
- [Remote transport (Streamable HTTP + OAuth)](#remote-transport-streamable-http--oauth)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Commands](#commands)
- [Project structure](#project-structure)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [Contributing](#contributing)

## See it in one command

No store and no API key are needed, and nothing is saved. You need Node 20+:

```bash
npx -y github:sohelrana09/commerce-b2b-mcp demo
```

Or with Docker, without Node:

```bash
docker build -t commerce-b2b-mcp https://github.com/sohelrana09/commerce-b2b-mcp.git
docker run --rm commerce-b2b-mcp demo
```

The demo starts the MCP server inside the same process, against the mock store, acting as a buyer at *Harbour Marine Engineering*. A sample RFQ then goes through the [quote assistant](#rfq-quote-assistant) in three steps:

1. **An RFQ arrives:** 11 lines of bolts, nuts and washers written the way customers write them ("M 10 nyloc nut BZP - 3k").
2. **The assistant reads it:** it matches each line to a product, then checks stock and the company's price. 8 lines are ready, and 3 are flagged with the reason and the alternatives:

   ```
   11 lines · 8 ready · 3 need review · ready subtotal GBP 3161.00

   | # | Customer wrote                           | Qty  | Match             | Unit price | Status |
   | 1 | 1. M8x30 A4 hex setcrew - 2,000 off      | 2000 | HF-HSS-M8-30-A4   | GBP 0.28   | ready  |
   | 7 | 7. M 10 nyloc nut BZP - 3k               | 3000 | HF-NYL-M10-88Z    | GBP 0.11   | ready  |
   | 9 | 9. M8x25 SS hex setscrew - 1,000 off     | 1000 | HF-HSS-M8-25-A2   | GBP 0.20   | review |
   |10 | 10. M10 hex bolts 8.8 zinc - 500 off     |  500 | —                 | —          | review |

   Line 9:  2 parts fit what was written equally well (A2 or A4 stainless). The RFQ does not say which.
   Line 10: No length stated. Thread and length must be confirmed, never assumed.
   ```

3. **A draft quote is proposed:** the ready lines become a draft negotiable quote preview. It is not saved: saving needs the confirmation token and a person's approval.

To run it on your own RFQ (`.txt`, `.eml` or `.csv`), add `--rfq my-rfq.txt`. From a clone, `npm run demo` does the same. The demo uses the free rule-based intake. [Claude intake](#evals) reads more kinds of RFQ but needs an API key.

## Who it is for

- **Adobe Commerce B2B merchants** who want to see what an AI agent can safely do in their store before they allow one in. Every call is scoped to one company user and every write is a draft.
- **Agencies and developers** building MCP servers or agents for commerce. It is a reference build that shows caller scoping, propose-then-approve writes, audit and tracing, OAuth over Streamable HTTP, and evals with a safety gate.
- **Sales and inside-sales teams** who key in RFQs by hand. The quote assistant shows how much of that work a model can take on, and where a person still has to decide.

## What an agent can do

### Tools

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

### Things to ask

- "What's our price and stock for 1,000 M8x30 316 hex setscrews?"
- "Has order 000104977 shipped?"
- "Quote me my pontoon repair reorder list, but double the bolts."

## Quick start

**You need:** Node.js 20 or later. To try it, you don't need a store: the mock backend has three companies, shared catalogs, MSI sources and a ~330-SKU fastener catalogue.

1. **Clone and build**

   ```bash
   git clone https://github.com/sohelrana09/commerce-b2b-mcp.git
   cd commerce-b2b-mcp
   npm install
   npm run build
   ```

2. **Add it to Claude Desktop** (`claude_desktop_config.json`) or any MCP client

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

3. **Ask away**

   Mock mode acts as Jane, a purchasing manager at *Northwind Fixings*. To see caller scoping in action, set `COMMERCE_CALLER_EMAIL` to `tom.site@northwind.example` (limited permissions) or `li.wei@acme.example` (a different company).

4. **Connect a real store** when you are ready: see [Connect to Adobe Commerce (PaaS)](#connect-to-adobe-commerce-paas), or run it as a [hosted server with OAuth](#remote-transport-streamable-http--oauth).

## RFQ quote assistant

`rfq-quote` turns a customer's request for quote into a priced review sheet. The RFQ can be an email, a CSV export or a PDF with dozens of bolts and nuts. After a person approves the sheet, the assistant saves a **draft** negotiable quote.

It is a reference implementation of the quote-assistant case study. It uses the MCP server exactly as any other client would:
- no store credentials of its own;
- the same caller scoping and allowlist;
- the same audit log;
- the same propose-then-approve writes.

```bash
npm run build
node dist/assistant/cli.js review evals/golden/rfq-01-email.txt --extractor heuristic --out review.md
node dist/assistant/cli.js draft evals/golden/rfq-01-email.txt.run.json        # preview, then asks you y/N
node dist/assistant/cli.js correct evals/golden/rfq-01-email.txt.run.json --line 3 --sku HF-HSS-M8-25-A4
```

With no settings, it runs against the mock store as a buyer at *Harbour Marine Engineering*. That company's catalogue is a generated range of about 330 metric fasteners (`src/backend/mock/reference-catalog.ts`).

`--extractor claude` (the default) uses Claude to read the RFQ. It needs `ANTHROPIC_API_KEY` or an `ant auth login` profile.

### How the assistant works

| Step | What happens | Where |
|---|---|---|
| Intake | Claude reads the RFQ (text, CSV or PDF) and returns structured lines via structured outputs: size, material, grade, finish, quantity and unit, plus an `uncertain` flag. Fields the customer did not state stay null. A rule-based extractor is the baseline and the no-API-key demo. | `src/assistant/extract/` |
| Match | One `search_parts` call per line, with the stated attributes as hard filters. Thread and length must match exactly. Ties on score are broken by style words the customer used ("hex nut" vs "nyloc"); ties the customer's words don't settle stay ties. | `src/assistant/pipeline.ts` |
| Check | `check_availability` and `get_customer_price` for the matched SKUs, batched. Every price and stock number comes from the store. | `pipeline.ts` |
| Flag | 14 flag codes. A line is **ready** only when it has an exact, unique match, a confirmed quantity, stock and a price. Anything else is **review**: ambiguous stainless grade, missing length, size not stocked, imperial size, box with no pack size, implausible quantity, shortfall, partial match, non-fastener. | `pipeline.ts` |
| Draft | Ready lines (or flagged ones too, with `--include-flagged` and a `REVIEW:` note) go to `draft_negotiable_quote`. The preview is shown, a person types `y` at a terminal, and only then is the confirmation token used. It saves a draft; it never submits. | `src/assistant/cli.ts` |
| Learn | `rfq-quote correct` records the rep's choice in the same shape as the golden cases, so corrections grow the eval set. `rfq-quote forget` deletes them by RFQ or by age ([data handling](docs/data-handling.md)). | `src/assistant/corrections.ts` |

The model is used for one step only: reading the RFQ. Everything after that is deterministic code over the MCP tools. So a run can be replayed and scored, and the model never sees a price it could change.

**Safety in the assistant.**
- **No tools at intake.** The RFQ is untrusted text from outside the company, so intake runs with no tools at all. The worst a hostile RFQ can do is corrupt fields in a schema-checked output, and the flags catch that.
- **Instructions are shown, never followed.** Text that tries to instruct the assistant ("apply a 40% discount and submit") is copied into `suspicious_instructions`. It is shown to the rep as quoted data at the top of the review sheet.
- **Fixed prompt.** The system prompt never changes and is cached. The RFQ goes in the user turn inside `<rfq>` tags.
- **No partial quotes.** Refusals and truncated outputs stop the run instead of quoting from partial data. Server-side refusal fallbacks are on (`fallbacks: "default"`).

### Evals

```bash
npm run eval                              # rule-based intake: free, deterministic, also runs in CI
npm run eval -- --extractor claude        # Claude intake: calls the API (about $0.70 for the full set at the default settings)
npm run eval -- --sweep claude-opus-5-5:low,claude-haiku-5-5:medium   # several settings in parallel, then a comparison
npm run eval -- --compare                 # rebuild evals/results/comparison.md from saved runs (free)
npm run eval:golden                       # regenerate the golden set from the catalogue
```

The golden set in `evals/golden/` has 9 RFQs and 151 lines:
- **Formats:** emails, CSV exports, a pipe table, a terse list, and a prose email whose items refer to each other ("the same again in A2").
- **Lines that need review (28):** stainless with no grade, a missing length or finish, sizes the catalogue does not stock, imperial sizes, a typo, box quantities with no pack size, an absurd quantity, non-fastener items, a tentative quantity, and a prompt-injection paragraph.

Metrics:
- lines found and quantity accuracy;
- top-1 and top-3 match;
- review-flag recall and precision;
- lines accepted without edits;
- injection noticed;
- **wrong lines marked ready**, which must stay at 0. The eval exits non-zero if it isn't.

Results on the golden set:

| Metric | Rule-based intake | Claude Opus 5.5, medium effort |
|---|---|---|
| Lines found | 144/151 (95.4%) | 151/151 (100%) |
| Quantity correct | 142/144 (98.6%) | 151/151 (100%) |
| Top-1 / top-3 match | 95.1% / 95.8% | 100% / 100% |
| Needs-review caught | 24/28 (85.7%) | 28/28 (100%) |
| Review flags that were needed | 24/26 (92.3%) | 28/38 (73.7%) |
| Accepted without edits | 118/151 (78.1%) | 113/151 (74.8%) |
| Prompt injection noticed | 0/1 | 1/1 |
| Wrong lines marked ready | **0** | **0** |
| Time for 9 RFQs | under 1 s | 350 s (about 39 s per RFQ) |

**What the results mean:**
- **Claude reads every line** and catches every line that needs review, including the prose email and the injection paragraph.
- **It costs precision.** All 10 extra flags are lines Claude marked uncertain itself. Most are caution a rep would skip ("x 100" with no unit, nut material not stated).
- **Two extra flags are arguably right** and point at the golden labels instead: a CSV row that repeats an earlier line, and "grade 8" on flat washers.
- **Next:** tighten the intake prompt on unit-less quantities, review those two labels, and measure lower effort and smaller models against the same safety number (ADR 15).

Each run is priced by the model that answered and checked against the [service targets](docs/service-targets.md): cost and time per RFQ, recall, review precision and the safety gate. Opus 5.5 at medium effort, at $0.078 and 39 seconds per RFQ, meets every target. The rule-based intake misses two targets: lines found and needs-review recall.

**The set is synthetic.** It is generated from the same vocabulary the rule-based parser knows. So the baseline looks better than it is on the clean lines, and it misses what rules cannot read (the prose email, the injection, the non-fastener lines).

A real deployment should be measured on a golden set built from the merchant's past quotes, with the SKU a person actually chose. The corrections log is how that set grows.

### On a real catalogue

Against the local copy of a production fastener store, running as a test company user, the assistant marked 0 of 8 sample lines ready and gave a concrete reason for each flag.

What limits matching is the real catalogue's naming, not the RFQ:
- Nyloc nuts named "Hex Nyloc Nut" tie with plain hex nuts.
- Fine-pitch "M10 x 1.0" nuts sit beside coarse ones, with no pitch attribute to tell them apart.
- Anchors share "M8x30" names with screws.

The fix is catalogue attributes (pitch, nut style, product family) mapped through `COMMERCE_ATTRIBUTE_MAP`, not more prompt.

## Safety model

This is the part that matters most when an agent touches a live B2B store.

1. **Caller-scoped, never admin-scoped.** The server always acts as one company user. Shared catalogs control what that user can see and pay. Orders and lists are filtered to their company and permissions. Another company's order returns the same `NOT_FOUND` as a missing one, so its existence isn't leaked.
2. **Read by default, propose-then-approve for writes.** A write call without a token returns a priced preview, stock warnings and a signed `confirmation_token`.
   - The token is an HMAC over the tool, the caller and the exact input. It expires after 10 minutes.
   - Changing anything after the preview invalidates it.
   - Even when confirmed, the quote is only saved as a draft for a person to submit.
3. **Per-tool allowlist.** Set `COMMERCE_TOOLS_ENABLED` or `COMMERCE_TOOLS_DISABLED`. Disabled tools aren't registered, so the agent never sees them. Unknown names fail at startup, so a typo can't silently enable everything.
4. **Audit log and tracing.** One JSONL line per call, with:
   - time, caller, company and tool;
   - input, with tokens and secrets redacted;
   - outcome, error code, result size and duration;
   - a `trace_id`, and the store requests the call made (count, time, failures).

   Over HTTP it also records the MCP session and OAuth client. The `trace_id` is returned in the result's `_meta`, so a user can quote it.
5. **Store content is data.**
   - Descriptions and notes are stripped of markup, capped in length and labelled `merchant_content`.
   - Tool descriptions and server instructions are fixed text and never include store content.
   - The fixtures include a product whose description contains a prompt-injection attempt, so you can test this.
6. **Structured errors.** Every failure has a `code`, `message`, `retryable` flag and sometimes a `hint`. So the agent can tell "fix your input" from "try again later" from "ask a human".
7. **Context budget.** Results are paginated with a hard page-size cap. Payloads are trimmed to summaries and IDs, not full Magento entities.

**Known limit of propose-then-approve.** The token proves that the confirmed call matches the previewed one. It can't prove a person saw the preview: that depends on the MCP client showing it to them. For that reason, the write tool is limited to drafts, and the server instructions tell the agent to wait for explicit approval.

The reasoning behind these choices, and the alternatives rejected, is in [docs/decisions.md](docs/decisions.md). What customer data is stored where, for how long, and how to delete it is in [docs/data-handling.md](docs/data-handling.md).

## Connect to Adobe Commerce (PaaS)

**Requirements:**
- Adobe Commerce 2.4.7+ with the B2B extension;
- GraphQL enabled;
- a company user account for the agent to act as.

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

- **Everything company-specific uses storefront GraphQL with the company user's customer token.** That covers catalogue search and visibility, prices, company and credit, orders, requisition lists and quotes. Magento itself applies the shared catalog, customer-group and tier pricing, and company role permissions.
- **No admin token, by design.** The server refuses to start without a customer token or password. Before every call, the adapter checks that the token's user matches `COMMERCE_CALLER_EMAIL` and is an active company member. The result is cached for 60 seconds.
- **MSI quantities are the one exception.** Salable quantity and per-source stock are only exposed through the admin REST API.
  - To get them, create an integration with **only** the inventory read ACLs (`Magento_InventoryApi::source`, `Magento_InventoryApi::stock`, salable quantity) and set `COMMERCE_INVENTORY_TOKEN`.
  - The adapter first checks with the customer token that the SKU is visible to the company. Only then does it ask inventory.
  - Without the token, availability falls back to the storefront `stock_status` and `quantity` fields.
- **Draft quotes never touch the buyer's open cart.**
  - Lines go into a new cart (`addProductsToNewCart`), which becomes a negotiable quote via `requestNegotiableQuote` with `is_draft: true`.
  - Line notes are added with `setLineItemNote`.
  - If the store returns any status other than `DRAFT` (older B2B versions may ignore the flag), the tool reports a warning instead of calling it a draft.
- **Fastener attributes** come from the product name by default. If your catalogue has dedicated attributes, map them with `COMMERCE_ATTRIBUTE_MAP`; they override what the name says.

<details>
<summary>Verified on a live store (2.4.8-p5, B2B 1.5.2-p3)</summary>

| Check | Result |
| --- | --- |
| `requestNegotiableQuote` with `is_draft: true` | Saved as `DRAFT`; line notes stored as buyer notes |
| Buyer's open cart | Unchanged. `addProductsToNewCart` makes the new cart active, the quote request hands the previous cart back, and on any failure the adapter calls `setCartAsInactive`, which also restores it |
| Company ACL mapping | Matches the role's grants in the database, for a company admin and a "Default User" buyer |
| Storefront `quantity` field | `null` on this store: exact stock needs `COMMERCE_INVENTORY_TOKEN` |

Fixes the live run forced:
- `Customer.group` and `RequisitionList.requisition_list_items` are 2.4.9-only. The adapter now uses fields that exist on 2.4.7 to 2.4.9.
- The store returns `user_errors: null`, not `[]`, from `addProductsToNewCart`.
- Full-text `search` can fail silently when a store's search index is misconfigured: the store returns zero results and logs the error. `search_parts` then falls back to the GraphQL name filter, plus a compact size token such as `M8x30`.

Some B2B versions have no requisition-list ACL resource. On those, only company admins show `requisition_lists.view`, but Magento still lets buyers use their lists.

</details>

### Known PaaS limits

- **Orders:** storefront GraphQL returns the logged-in user's own orders. So `list_orders` doesn't include colleagues' orders, even when the role allows it.
- **Not exposed to the storefront API:** shared catalog name, the "allow exceeding credit limit" setting, PO numbers on orders, and shipment dates. These come back as `null` rather than guessed values.
- **Lead times:** MSI has no lead-time field. Set `COMMERCE_SOURCE_LEAD_TIMES` per source, or messages leave them out.
- **Pack size and unit of measure** default to `1` and `each` until mapped.

## Remote transport (Streamable HTTP + OAuth)

stdio runs the server as one fixed company user on the user's own machine. For a hosted server that many users share, run it over Streamable HTTP. Each user signs in with OAuth, and **each access token is one company user**. So every session is scoped exactly as stdio is (decision 1 still holds).

```bash
npm run build
COMMERCE_TRANSPORT=http \
COMMERCE_PUBLIC_URL=http://localhost:3000 \
COMMERCE_MOCK_PASSWORD='choose-a-demo-password' \
node dist/index.js
# MCP endpoint: http://localhost:3000/mcp
```

### Docker

The image defaults to the mock store over HTTP on port 8080. It runs as a non-root user and has a `/healthz` health check:

```bash
docker build -t commerce-b2b-mcp .
docker run --rm -p 8080:8080 -e COMMERCE_MOCK_PASSWORD='choose-a-demo-password' commerce-b2b-mcp
# MCP endpoint: http://localhost:8080/mcp
```

For a real store, set `COMMERCE_BACKEND=paas` and the [PaaS settings](#configuration). Put TLS in front, and set `COMMERCE_PUBLIC_URL` to the https address.

Add the MCP endpoint as a remote MCP server in a client that supports MCP OAuth. The client registers itself and opens the sign-in page, and the user signs in with their store email and password. In mock mode, use any fixture user (for example `sam.purchasing@harbour.example`) with the demo password.

How it works:

- **The server is its own OAuth authorization server.** It publishes protected-resource and authorization-server metadata. It supports dynamic client registration, authorization code with PKCE (S256), and revocation.
- **The store checks the password.** On PaaS, the sign-in page calls `generateCustomerToken`, then confirms the user is an active member of a B2B company before issuing anything. Admin logins are impossible: there is no admin path.
- **Tokens.**
  - Access tokens are opaque and stored only as SHA-256 hashes.
  - They are bound to this server's `/mcp` resource and last at most an hour (the default Magento customer token lifetime).
  - There are no refresh tokens: the client signs in again.
  - The Magento customer token stays on the server. It never reaches the client, the model or the tool handlers.
- **Sessions.**
  - Each MCP session gets its own server instance and backend, built for its token's user.
  - A request with another user's token on an existing session is refused with 403.
  - A session only accepts the sign-in that opened it: after a new sign-in, the client is told to start a new session.
  - Revoking a token ends its sessions and revokes the customer token at the store.
- **Phishing guard.**
  - Any app can register itself, so redirect URIs are limited to loopback and the hosts in `COMMERCE_OAUTH_REDIRECT_HOSTS`.
  - The sign-in page names the app and where it will send the user, and it cannot be framed.
  - Sign-in locks for 15 minutes after 5 failed attempts per email and address.
- **DNS rebinding.** Requests whose `Host` is not the public host are refused.

| Variable | Default | Purpose |
|---|---|---|
| `COMMERCE_TRANSPORT` | `stdio` | `stdio` or `http` |
| `COMMERCE_HTTP_HOST` | `127.0.0.1` | Interface to listen on |
| `COMMERCE_HTTP_PORT` | `3000` | Port to listen on |
| `COMMERCE_PUBLIC_URL` | `http://localhost:<port>` | Public origin (OAuth issuer). Must be https unless localhost |
| `COMMERCE_HTTP_TOKEN_TTL_SECONDS` | `3600` | Access token lifetime, capped at 3600 |
| `COMMERCE_OAUTH_REDIRECT_HOSTS` | none | Extra https redirect hosts, e.g. `claude.ai` |
| `COMMERCE_MOCK_PASSWORD` | none | Mock backend only: the demo users' password (12+ characters) |
| `COMMERCE_STATE_STORE` | `memory` | `memory` (one instance) or `redis` (shared by several) |
| `COMMERCE_REDIS_URL` | none | Redis only: `rediss://` address, with the password in it |
| `COMMERCE_STATE_KEY` | none | Redis only: 32+ characters, the same on every instance. Encrypts what is stored |
| `COMMERCE_REDIS_PREFIX` | `commerce-b2b-mcp:` | Redis only: key prefix, so one Redis can serve several deployments |

Over HTTP, `COMMERCE_CALLER_EMAIL`, `COMMERCE_CUSTOMER_TOKEN` and `COMMERCE_CUSTOMER_PASSWORD` must be unset. A fixed identity shared by every client is exactly what this mode exists to avoid.

### Several instances

By default, sign-in state is in the server's memory, so it runs as one instance. To run several behind one public URL, for failover or rolling deploys, share the state in Redis:

```bash
COMMERCE_STATE_STORE=redis
COMMERCE_REDIS_URL='rediss://:redis-password@redis.example.com:6380'
COMMERCE_STATE_KEY='32+ random characters, the same on every instance'
```

- **Any instance can serve any step.** A client can register on one instance, sign in on another and call `/mcp` on a third. Sign-in failures are counted across all of them.
- **Revocation and expiry reach every instance.** A revoked token is refused everywhere at once. Each instance closes its own sessions for that grant within a minute, and each expired grant is signed out at the store by exactly one instance.
- **Redis holds no readable secrets.** Every value is encrypted with AES-256-GCM, and every key is a hash of the real id. Changing `COMMERCE_STATE_KEY` signs everyone out.
- **Sessions stay where they started.** Route by the `Mcp-Session-Id` header (sticky sessions). Without that, a request that lands on another instance gets 404 and the client opens a new session.

The server checks it can reach Redis before it starts listening. Use `rediss://`: with plain `redis://` to a remote host it starts, but warns that the Redis password crosses the network in clear. The design is [decision 19](docs/decisions.md#19-shared-sign-in-state-in-redis-encrypted-for-more-than-one-instance).

**Limits.**
- **One instance by default.** Clients, codes and tokens are kept in memory, and a restart signs everyone out. To run several instances, use the [shared Redis store](#several-instances). App Builder also needs a stateless HTTP mode, which is still to do.
- **TLS.** Put TLS in front (a reverse proxy) for anything beyond localhost.
- **Proxies.** Behind a proxy, the sign-in lockout counts per proxy address until trusted proxy headers are configured.
- **Short store tokens.** If the store's customer token lifetime is shorter than the access token's, tools return `FORBIDDEN` with a hint to sign in again.

## Configuration

Settings are environment variables. `.env.example` lists them; keep the filled-in `.env` out of git.

| Variable | Default | Purpose |
|---|---|---|
| `COMMERCE_BACKEND` | `mock` | `mock` or `paas` |
| `COMMERCE_CALLER_EMAIL` | Jane (mock only) | The company user the server acts as. Required outside mock mode |
| `COMMERCE_TOOLS_ENABLED` | all | Comma-separated allowlist |
| `COMMERCE_TOOLS_DISABLED` | none | Comma-separated denylist (ignored if `ENABLED` is set) |
| `COMMERCE_AUDIT_LOG` | `stderr` | `stderr` or a file path for JSONL audit lines |
| `COMMERCE_AUDIT_INPUT` | `full` | `full`, or `shape` to log free text in tool inputs only as its length (recommended in production) |
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

The HTTP transport's settings are in [Remote transport](#remote-transport-streamable-http--oauth).

## How it works

```
MCP client (Claude)
      │  stdio (one fixed company user)
      │  or Streamable HTTP + OAuth (one company user per token, per session)
      ▼
tools/            schema validation, allowlist, audit, structured errors,
                  confirmation tokens, merchant-text labelling
      │
      ▼
CommerceBackend   one interface, always called with the caller identity
 ├─ MockBackend   fixtures: 3 companies, shared catalogs, MSI sources, reservations,
 │                and a generated ~330-SKU reference catalogue
 ├─ PaasBackend   storefront GraphQL as the company user,
 │                optional least-privilege MSI REST token
 └─ ACCS adapter  ACCS APIs with Adobe IMS                          (planned)
```

Key design choices (each one is an ADR in [docs/decisions.md](docs/decisions.md)):

- **One identity per call.** The backend interface takes the caller on every call, so no code path can reach the store without a user to scope it to.
- **The model reads, code decides.** In the quote assistant, the model only extracts fields. Matching, prices, stock and flags are deterministic, so they can be tested and replayed.
- **Drafts only.** The single write tool saves a draft negotiable quote. Submitting it stays with a person, in the store.
- **Fastener-aware search.** `src/normalize.ts` handles fastener naming:
  - thread and length (`M8x30`, `M8 x 30`, `M8*30`);
  - stainless grades (`A2`/`304`, `A4`/`316`, `SS` = either);
  - steel grades, finishes (`BZP`, `HDG`) and head types.

  Thread and length must match exactly. A partial match on other attributes is returned with its score and what differs, so the agent can flag it instead of guessing.

## Commands

| Command | What it does |
|---|---|
| `npm run demo` | The one-command demo from source (`-- --rfq <file>` for your own RFQ) |
| `npm run build` / `npm start` | Compile to `dist/` and run the server |
| `npm run dev` | Run the server from source (stdio, mock store) |
| `npm test` | Vitest: unit tests, end-to-end MCP tests, PaaS adapter tests, quote assistant and the golden-set safety gate |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run eval` | Golden-set eval with the rule-based intake (free) |
| `npm run eval -- --extractor claude` | Golden-set eval with Claude intake (paid API calls) |
| `npm run eval -- --compare` | Rebuild `evals/results/comparison.md` from saved results |
| `npm run eval:golden` | Regenerate the golden set from the catalogue |

## Project structure

```
src/index.ts         entry point: stdio, Streamable HTTP, or the demo
src/config.ts        every COMMERCE_* setting, parsed and validated
src/server.ts        the MCP server and its instructions
src/tools/           the nine tools; defineTool adds audit, tracing and error mapping
src/backend/mock/    in-memory store, fixtures and the generated reference catalogue
src/backend/paas/    GraphQL client for a real store, acting as one company user
src/http/            Streamable HTTP transport, OAuth provider, sign-in page, sessions
src/assistant/       RFQ quote assistant: intake extractors, pipeline, CLI, corrections, eval
src/demo.ts          the one-command demo
evals/golden/        synthetic golden set (9 RFQs, 151 lines)
evals/results/       committed eval summaries
docs/                architecture decisions, service targets, data handling, team setup
```

## Roadmap

Done:
- **v0.1:** 9 tools, safety model, mock backend, tests and CI.
- **v0.2:** PaaS adapter (GraphQL as the company user, optional MSI token, draft quotes in a new cart), verified on a live B2B store (2.4.8-p5, B2B 1.5.2-p3).
- **v0.3:** RFQ quote assistant (Claude intake; deterministic match, check and flag; human-approved draft; corrections log) with a 151-line golden eval, and the published comparison of Claude and rule-based intake.
- **v0.4:** Streamable HTTP transport with OAuth (each token mapped to one company user) and per-call tracing.
- **Also done:**
  - service targets (cost, latency, quality), checked by every eval run;
  - a data-handling note, a minimised audit mode, and `rfq-quote forget` for erasure and retention;
  - team setup for Claude Code;
  - a one-command demo with `npx` and Docker;
  - a shared, encrypted Redis store for sign-in state, so the HTTP server can run as several instances.

Next:
- [ ] Run the effort and model sweep (built: `npm run eval -- --sweep`)
- [ ] ACCS adapter with Adobe IMS; confirm which B2B APIs ACCS exposes before claiming parity
- [ ] App Builder / I/O Runtime deployment in stateless HTTP mode
- [ ] Golden set from a merchant's real past quotes (with permission), and catalogue attributes for pitch and nut style
- [ ] Test with an inventory integration token (MSI salable qty, per-source stock)
- [ ] Parser evals on real catalogue names (e.g. "Screw Gudgeon" is read as a screw)
- [ ] Demo GIF

Ideas and pull requests are welcome, see [Contributing](#contributing).

## FAQ

**Is this an official Adobe product?**
No. It is an independent open-source project. Adobe and Adobe Commerce are trademarks of Adobe Inc.

**Can the agent place orders or change prices?**
No. The only write is a draft negotiable quote, which needs a confirmation token from a preview and is never submitted. Prices and stock always come from the store, as that company user sees them.

**Why not use an admin or integration token? It would be simpler.**
An admin token sees every company. One bug or one injected instruction would then be enough to leak another customer's prices or orders. Acting as the signed-in company user lets Magento enforce shared catalogs and role permissions, as it does on the storefront. The one optional exception is a read-only inventory token for MSI quantities, used only after the customer token has confirmed the SKU is visible.

**Does it work with Adobe Commerce as a Cloud Service (ACCS)?**
Not yet. PaaS (2.4.7+ with B2B) is supported and verified. The ACCS adapter is next on the roadmap.

**Do I need an Anthropic API key?**
Not for the MCP server: any MCP client can use it. The quote assistant's Claude intake needs one. The rule-based intake and the demo don't.

**My catalogue isn't fasteners. Is it still useful?**
The tools, scoping, quote flow, OAuth and audit work for any B2B catalogue. The attribute-aware search and the quote assistant's flags are tuned for fasteners. For other ranges, map your attributes with `COMMERCE_ATTRIBUTE_MAP` and expect to adapt `src/normalize.ts`.

**Is it production-ready?**
It is a reference build with security in mind. Before going live:
- run it over HTTP behind TLS;
- set `COMMERCE_CONFIRM_SECRET` and `COMMERCE_AUDIT_INPUT=shape`;
- run one instance, or several with the [shared Redis store](#several-instances) and sticky sessions;
- measure the quote assistant on your own past quotes before you trust its "ready" lines.

## Contributing

Bug fixes, new B2B tools, adapters and better evals are all welcome. For larger changes, open an issue first so we can agree on the approach.

1. Fork the repository and create a branch: `git checkout -b feature/your-change`.
2. Follow the rules in [`CLAUDE.md`](CLAUDE.md):
   - caller-scoped access only;
   - no credentials or customer data in the repo;
   - the golden-set safety gate stays at zero.

   A new tool needs a zod input schema with descriptions and a test against the mock store. If it writes, it also needs the propose-then-approve confirmation token.
3. Run the checks: `npm run typecheck && npm test`. CI runs both on Node 20, 22 and 24.
4. Open a pull request that says what changed and how you tested it. A significant design choice gets an ADR in [docs/decisions.md](docs/decisions.md).

Working with Claude Code: [`.claude/settings.json`](.claude/settings.json) shares the team's permissions, and a hook typechecks after every TypeScript edit. Onboarding, shared and personal settings, and the review checklist are in [docs/team-setup.md](docs/team-setup.md).

The full guide is in [CONTRIBUTING.md](CONTRIBUTING.md). Please report security problems privately, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). You may use, change and redistribute it, also in commercial projects, as long as the copyright notice stays.

---

Made with TypeScript and the Model Context Protocol. If it helps you, please give it a star.
