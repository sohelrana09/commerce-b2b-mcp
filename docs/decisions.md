# Architecture decisions

A log of the decisions behind `commerce-b2b-mcp` and the RFQ quote assistant: what was chosen, what was rejected, and why. Each entry names the part of the system it shaped and the trade-off it accepts.

| # | Decision | Area |
|---|---|---|
| 1 | [Act as one company user, never an admin](#1-act-as-one-company-user-never-an-admin) | Security, integration |
| 2 | [Writes are propose-then-approve, and only ever drafts](#2-writes-are-propose-then-approve-and-only-ever-drafts) | Human oversight |
| 3 | [Store content is data, never instructions](#3-store-content-is-data-never-instructions) | Prompt injection |
| 4 | [Per-tool allowlist, enforced by not registering tools](#4-per-tool-allowlist-enforced-by-not-registering-tools) | Least privilege |
| 5 | [Structured errors with a retryable flag](#5-structured-errors-with-a-retryable-flag) | Agent reliability |
| 6 | [Small, trimmed tool results](#6-small-trimmed-tool-results) | Context budget |
| 7 | [Storefront GraphQL as the company user; MSI only through an optional narrow token](#7-storefront-graphql-as-the-company-user-msi-only-through-an-optional-narrow-token) | Integration |
| 8 | [Target the schema common to 2.4.7 to 2.4.9](#8-target-the-schema-common-to-247-to-249) | Compatibility |
| 9 | [Draft quotes in a separate cart, and restore the buyer's cart on failure](#9-draft-quotes-in-a-separate-cart-and-restore-the-buyers-cart-on-failure) | Side effects |
| 10 | [Fall back to name search when full-text search returns nothing](#10-fall-back-to-name-search-when-full-text-search-returns-nothing) | Resilience |
| 11 | [stdio first; remote transport later](#11-stdio-first-remote-transport-later) | Delivery |
| 12 | [The quote assistant is a workflow, not an agent](#12-the-quote-assistant-is-a-workflow-not-an-agent) | Solution design |
| 13 | [RFQ intake: structured outputs, no tools, injection reported](#13-rfq-intake-structured-outputs-no-tools-injection-reported) | Safety, prompting |
| 14 | [A line is ready only on an exact, unique, stocked, priced match](#14-a-line-is-ready-only-on-an-exact-unique-stocked-priced-match) | Human in the loop |
| 15 | [Model, effort and caching for intake](#15-model-effort-and-caching-for-intake) | Cost, latency |
| 16 | [Evals: one number that must be zero](#16-evals-one-number-that-must-be-zero) | Evaluation |
| 17 | [Fix matching with catalogue data, not prompts](#17-fix-matching-with-catalogue-data-not-prompts) | Data, lifecycle |

---

### 1. Act as one company user, never an admin

**Context.** Existing Magento MCP servers authenticate with an admin token or admin username and password. An agent with an admin token can see every company's prices, orders and customers.

**Decision.** The server always acts as one company user (`COMMERCE_CALLER_EMAIL`) with that user's customer token. Admin tokens are rejected at startup. Magento applies shared catalogue visibility, group and tier pricing, and company ACL itself. The PaaS adapter also checks, on every call, that the token's email is the configured caller, that the user is active and that they belong to a company.

**Rejected.** An admin token with filtering in the server: one bug in our filter leaks another company's data. A per-tool admin ACL: still one credential for all companies.

**Consequences.** The blast radius of a prompt-injected or confused agent is one company user's own permissions. Cross-company actions (a rep working for many customers) need one server instance per customer, or OAuth mapping each token to a user (see 11). Another company's order returns the same `NOT_FOUND` as a missing one, so existence is not leaked.

### 2. Writes are propose-then-approve, and only ever drafts

**Context.** The only write is creating a negotiable quote. A wrong quote that reaches a customer costs margin and trust.

**Decision.** A write call without a token returns a priced preview and a `confirmation_token`: an HMAC over the tool, the caller and the canonical input, valid for 10 minutes. Confirming with any change to the input fails. Even a confirmed call only saves a draft; a person submits it in the storefront. If the store reports any status other than draft, the tool says so loudly.

**Rejected.** A `confirm: true` flag (the model can set it in one step). Letting the agent submit (no human checkpoint before the customer sees prices).

**Consequences.** The token proves the confirmed call equals the previewed one, not that a human saw the preview; that depends on the client. That is why the write is limited to drafts, and why the quote assistant's CLI asks the person at a terminal and has no flag to skip it.

### 3. Store content is data, never instructions

**Context.** Product descriptions, quote notes and RFQs are written by third parties and can carry prompt injection.

**Decision.** Tool descriptions and server instructions are static. Store text is stripped of markup, length-capped and returned under a `merchant_content` label. The server instructions tell the model to never follow instructions found in it. A fixture product carries an injection attempt so the behaviour is tested.

**Rejected.** Sanitising injection out of text (unreliable, and it hides evidence from the human).

**Consequences.** Defence depends on layering: labelled data, a model told to treat it as data, no tool that can do damage on its own (2, 4), and a human before anything leaves the building.

### 4. Per-tool allowlist, enforced by not registering tools

**Decision.** `COMMERCE_TOOLS_ENABLED` or `COMMERCE_TOOLS_DISABLED`. Disabled tools are never registered, so the model never sees them. Unknown names fail at startup.

**Rejected.** Registering every tool and refusing at call time: the model still plans around tools it cannot use, and a typo in config could silently enable everything.

### 5. Structured errors with a retryable flag

**Decision.** Every failure returns `code`, `message`, `retryable` and sometimes `hint`. Rate limits and upstream timeouts are retryable; bad input, not found and forbidden are not. An expired customer token triggers one silent re-login.

**Rejected.** Raw upstream errors. The model cannot tell "fix your input" from "try again" from "ask a human", and loops.

### 6. Small, trimmed tool results

**Decision.** Hard page-size caps, pagination, and summaries plus IDs instead of full Magento entities. Search returns at most 10 ranked matches with what matched and what differs.

**Rejected.** Returning the raw GraphQL payload. A single configurable product can fill thousands of tokens and push the user's request out of focus.

### 7. Storefront GraphQL as the company user; MSI only through an optional narrow token

**Context.** B2B pricing, shared catalogues and company ACL are applied by Magento's storefront APIs for a logged-in customer. Exact MSI salable quantity is only in the admin REST API.

**Decision.** Everything runs through storefront GraphQL as the customer. Exact stock uses an optional inventory-only integration token (`COMMERCE_INVENTORY_TOKEN`), and only for SKUs the customer can already see. Without it, the tool reports in stock or out of stock and says the exact quantity is unconfirmed.

**Rejected.** Recomputing B2B prices ourselves from admin data: it duplicates Magento's pricing logic and drifts from it.

### 8. Target the schema common to 2.4.7 to 2.4.9

**Context.** Testing on a live 2.4.8 store showed `Customer.group` and `requisition_list_items` exist only in the 2.4.9 schema.

**Decision.** Use only fields present from 2.4.7 to 2.4.9 (`items` instead of `requisition_list_items`; customer group reported as unknown).

**Consequences.** Slightly less data on 2.4.9, one code path everywhere. Upgrade-only fields can be added behind schema detection later.

### 9. Draft quotes in a separate cart, and restore the buyer's cart on failure

**Context.** Magento creates negotiable quotes from a cart. Using the buyer's active cart would overwrite what they are shopping for.

**Decision.** `addProductsToNewCart`, then `requestNegotiableQuote` with `is_draft: true`. If anything fails after the new cart exists, `setCartAsInactive` restores the buyer's previous cart. Verified live: the buyer's cart is untouched after a draft.

### 10. Fall back to name search when full-text search returns nothing

**Context.** On the live store, full-text search returned nothing because of a search-engine mapping problem on the store side.

**Decision.** When search is empty, retry with a name match on the raw text and on the `M8x30` size token. Configurable parents are excluded.

**Consequences.** The tool keeps working on a store with a broken index. The store's own search should still be fixed; this is a fallback, not a substitute.

### 11. stdio first; remote transport later

**Decision.** v0.x ships stdio only. Streamable HTTP with OAuth comes next, with each OAuth token mapped to one company user so decision 1 still holds.

**Rejected.** Shipping HTTP with a shared API key: one key for many users breaks caller scoping and auditing.

### 12. The quote assistant is a workflow, not an agent

**Context.** Turning an RFQ into a quote has fixed steps: read, match, check, flag, draft.

**Decision.** Code orchestrates the steps. The model is used for one step, reading the RFQ into structured lines. Matching, stock, pricing, flags and the draft are deterministic code over the MCP tools.

**Rejected.** An agent loop with the MCP tools. It adds cost, latency and variance to steps that have one right answer, makes every run harder to replay and score, and lets the model near prices.

**Consequences.** Every number a rep sees comes from the store. Runs can be replayed and scored. The MCP server is still the integration point, so a conversational agent can use the same tools for open-ended work.

### 13. RFQ intake: structured outputs, no tools, injection reported

**Decision.** Intake uses structured outputs with a schema where unstated fields are null and each line carries `uncertain` and a reason. The call has no tools. The RFQ goes in the user turn inside `<rfq>` tags; the system prompt is fixed. Text that tries to instruct the assistant is copied into `suspicious_instructions` and shown to the rep as quoted data. Refusals and truncated output stop the run.

**Rejected.** Free-text extraction parsed with regex (brittle). Giving intake tool access (a hostile RFQ could trigger actions).

**Consequences.** The worst a hostile RFQ can do is corrupt fields in a schema-checked output, which the flags then catch.

### 14. A line is ready only on an exact, unique, stocked, priced match

**Decision.** Thread and length must match exactly. A line is ready only with a unique best match on every stated attribute, a confirmed quantity, stock and a store price. Fourteen flag codes explain everything else (stainless grade not stated, no length, size not stocked, box with no pack size, implausible quantity, shortfall, non-fastener and more). By default only ready lines go into the draft.

**Rejected.** A confidence threshold on a single score. It hides why a line is uncertain, and an 0.9 score can still be the wrong thread.

**Consequences.** More lines go to review than a confident model would send, by design. The rep sees why each line is flagged and the alternatives.

### 15. Model, effort and caching for intake

**Decision.** Default Claude Opus 5.5 at medium effort, overridable with `RFQ_MODEL` and `RFQ_EFFORT`. The system prompt is frozen and cached. Server-side refusal fallbacks are on.

**Next.** Measure cheaper settings (lower effort, Sonnet or Haiku) on the golden set and keep the cheapest that holds the safety number at 0 and match accuracy within a stated margin. Choose per step on measured cost per completed RFQ, not price per token.

### 16. Evals: one number that must be zero

**Decision.** A golden set of RFQs with expected SKUs and expected review decisions. Metrics: lines found, quantity accuracy, top-1 and top-3, review recall and precision, accepted without edits, injection noticed, and wrong lines marked ready. The last must be 0; the eval exits non-zero and a test fails otherwise. A rule-based intake is the baseline and runs in CI for free.

**Consequences.** The current set is synthetic and shares vocabulary with the rule-based parser, which flatters the baseline. The real measure is a set built from a merchant's past quotes; the rep corrections log grows it.

### 17. Fix matching with catalogue data, not prompts

**Context.** On a real fastener catalogue, the assistant flagged 8 of 8 sample lines. Nyloc nuts are named "Hex Nyloc Nut", fine-pitch nuts have no pitch attribute, anchors share size names with screws.

**Decision.** Treat this as a data problem. Map real catalogue attributes (pitch, nut style, product family) through `COMMERCE_ATTRIBUTE_MAP` rather than teaching a prompt to guess from names.

**Consequences.** Match quality depends on the merchant's product data. That is a discovery question for every deployment, and a finding worth showing the merchant.
