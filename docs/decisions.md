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
| 11 | [Remote transport: OAuth where each token is one company user](#11-remote-transport-oauth-where-each-token-is-one-company-user) | Delivery, security |
| 12 | [The quote assistant is a workflow, not an agent](#12-the-quote-assistant-is-a-workflow-not-an-agent) | Solution design |
| 13 | [RFQ intake: structured outputs, no tools, injection reported](#13-rfq-intake-structured-outputs-no-tools-injection-reported) | Safety, prompting |
| 14 | [A line is ready only on an exact, unique, stocked, priced match](#14-a-line-is-ready-only-on-an-exact-unique-stocked-priced-match) | Human in the loop |
| 15 | [Model, effort and caching for intake](#15-model-effort-and-caching-for-intake) | Cost, latency |
| 16 | [Evals: one number that must be zero](#16-evals-one-number-that-must-be-zero) | Evaluation |
| 17 | [Fix matching with catalogue data, not prompts](#17-fix-matching-with-catalogue-data-not-prompts) | Data, lifecycle |
| 18 | [Minimise customer data, and make deletion a command](#18-minimise-customer-data-and-make-deletion-a-command) | Governance, privacy |
| 19 | [Shared sign-in state in Redis, encrypted, for more than one instance](#19-shared-sign-in-state-in-redis-encrypted-for-more-than-one-instance) | Scaling, security |
| 20 | [A stateless HTTP mode for load balancers and serverless](#20-a-stateless-http-mode-for-load-balancers-and-serverless) | Delivery, scaling |
| 21 | [A Vercel function entry that refuses in-memory state](#21-a-vercel-function-entry-that-refuses-in-memory-state) | Delivery |
| 22 | [RFQ review as an MCP tool, with intake inside the server](#22-rfq-review-as-an-mcp-tool-with-intake-inside-the-server) | Solution design, safety |
| 23 | [Submitting and closing quotes are opt-in writes](#23-submitting-and-closing-quotes-are-opt-in-writes) | Human oversight |
| 24 | [A review page for reps, beside the MCP endpoint](#24-a-review-page-for-reps-beside-the-mcp-endpoint) | Delivery, security |
| 25 | [RFQs from an IMAP inbox, reviewed but never drafted](#25-rfqs-from-an-imap-inbox-reviewed-but-never-drafted) | Intake, safety |

---

### 1. Act as one company user, never an admin

**Context.** Existing Magento MCP servers authenticate with an admin token or admin username and password. An agent with an admin token can see every company's prices, orders and customers.

**Decision.** The server always acts as one company user (`COMMERCE_CALLER_EMAIL`) with that user's customer token. Admin tokens are rejected at startup. Magento applies shared catalogue visibility, group and tier pricing, and company ACL itself. The PaaS adapter also checks, on every call, that the token's email is the configured caller, that the user is active and that they belong to a company.

**Rejected.** An admin token with filtering in the server: one bug in our filter leaks another company's data. A per-tool admin ACL: still one credential for all companies.

**Consequences.** The blast radius of a prompt-injected or confused agent is one company user's own permissions. Over HTTP each OAuth token is one company user (see 11). Cross-company work (a rep acting for many customers) means one sign-in per customer account. Another company's order returns the same `NOT_FOUND` as a missing one, so existence is not leaked.

### 2. Writes are propose-then-approve, and only ever drafts

**Context.** The only write is creating a negotiable quote. A wrong quote that reaches a customer costs margin and trust.

**Decision.** A write call without a token returns a priced preview and a `confirmation_token`: an HMAC over the tool, the caller and the canonical input, valid for 10 minutes. Confirming with any change to the input fails. Even a confirmed call only saves a draft; a person submits it in the storefront. If the store reports any status other than draft, the tool says so loudly.

**Rejected.** A `confirm: true` flag (the model can set it in one step). Letting the agent submit (no human checkpoint before the customer sees prices).

**Consequences.** A token is single use: it is recorded as used before the store is called (an atomic counter in the state store over HTTP, in memory otherwise), so a repeat or a parallel confirm is refused. If the store call then fails, the token is spent and a new preview is needed. If only a line note fails after the draft exists, the call reports success with a warning. The token proves the confirmed call equals the previewed one, not that a human saw the preview; that depends on the client. That is why the write is limited to drafts, and why the quote assistant's CLI asks the person at a terminal and has no flag to skip it.

### 3. Store content is data, never instructions

**Context.** Product descriptions, quote notes and RFQs are written by third parties and can carry prompt injection.

**Decision.** Tool descriptions and server instructions are static. Store text is stripped of markup, length-capped and returned under a `merchant_content` label. Every other string in a tool result or error goes through the same cleaning (entities decoded, markup and invisible characters removed, 300-character cap) in `defineTool`, so a field added later is covered too. Cleaning removes markup, not wording: injected sentences stay visible to the human and the model is still told to treat them as data. The server instructions tell the model to never follow instructions found in it. A fixture product carries an injection attempt so the behaviour is tested.

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

### 11. Remote transport: OAuth where each token is one company user

**Context.** v0.1 to v0.3 shipped stdio only: one process, one fixed company user, on the user's machine. A hosted server shared by many users needs to know who each request is for, without weakening decision 1.

**Decision.** Streamable HTTP, with the server as its own OAuth 2.1 authorization server (dynamic registration, PKCE, revocation, protected-resource metadata). The user signs in with their store credentials on our page; on PaaS the store checks them (`generateCustomerToken`) and we confirm an active company membership before issuing anything. Each access token is opaque, stored as a hash, bound to the `/mcp` resource and to one company user, and lives at most an hour. Each MCP session gets its own server and backend for that user; another user's token on the session is refused, and a session only accepts the sign-in that opened it. The Magento customer token stays server-side, never in `AuthInfo`. Redirect URIs are limited to loopback and configured hosts. A fixed caller in the environment is rejected in this mode.

**Rejected.** A shared API key (one key for many users breaks caller scoping and auditing). Passing the Magento customer token through as the bearer token (it would reach the client and every proxy log, and could not be bound to this resource or revoked by us). Refresh tokens (the store session lasts an hour anyway; signing in again is simpler and re-checks company membership). Delegating to Adobe IMS now (the right answer for ACCS, not for PaaS customer accounts).

**Consequences.** Decision 1 holds over the network: the blast radius is still one company user. State was in memory, so this was single-instance; decision 19 adds a shared store. Each tool call gets a `trace_id` (returned in `_meta`) and the audit line records the session, OAuth client and the store requests the call made, so a slow or failed call can be traced to one user, one session and the store.

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

**Measured.** $0.078 and 39 seconds per RFQ on the golden set (about 220 output tokens and 2.3 seconds per line), within the [service targets](service-targets.md). Most of the cost is output, so it scales with lines, not with the prompt. Caching the 2,850-token system prompt saves about $0.011 per RFQ (about 12%).

**Next.** The sweep (`npm run eval -- --sweep`) runs low and high effort, Sonnet and Haiku in parallel and picks the cheapest setting with 0 wrong lines marked ready, the injection noticed, and top-1 and needs-review recall within 2 points of the best. It is built but not yet run. At current volumes the saving is small; at 10,000 RFQs a month it is worth the run. Haiku has no server-side refusal fallback, so the intake does not request one there.

### 16. Evals: one number that must be zero

**Decision.** A golden set of RFQs with expected SKUs and expected review decisions. Metrics: lines found, quantity accuracy, top-1 and top-3, review recall and precision, accepted without edits, injection noticed, and wrong lines marked ready. The last must be 0; the eval exits non-zero and a test fails otherwise. A rule-based intake is the baseline and runs in CI for free.

**Consequences.** The current set is synthetic and shares vocabulary with the rule-based parser, which flatters the baseline. The real measure is a set built from a merchant's past quotes; the rep corrections log grows it.

### 17. Fix matching with catalogue data, not prompts

**Context.** On a real fastener catalogue, the assistant flagged 8 of 8 sample lines. Nyloc nuts are named "Hex Nyloc Nut", fine-pitch nuts have no pitch attribute, anchors share size names with screws.

**Decision.** Treat this as a data problem. Map real catalogue attributes (pitch, nut style, product family) through `COMMERCE_ATTRIBUTE_MAP` rather than teaching a prompt to guess from names.

**Consequences.** Match quality depends on the merchant's product data. That is a discovery question for every deployment, and a finding worth showing the merchant.

**Update.** Names still carry some facts reliably, so the name parser now reads them, under one rule: when a name does not say what a part is, the value stays empty. Pitch is read apart from length ("M10 x 1.0"), and a non-coarse pitch must match on both sides. Names that contain "bolt", "screw" or "nut" without being one (anchors, rivet nuts, inserts, gudgeons, special bolts) get no part type, and tools sold beside fasteners are not read as fasteners. Nut style and product family still need catalogue attributes.

### 18. Minimise customer data, and make deletion a command

**Context.** RFQs carry personal data (names, emails, phone numbers, signatures). It can end up in five places: the Claude API, run files, the corrections log, the audit log and Magento. The corrections log is meant to grow the eval set, so customer text could become test data.

**Decision.** The intake schema keeps only lines, the RFQ reference and the customer name, so contact details are not copied forward. The audit log has a `shape` mode that logs free text only as its length while keeping SKUs, quantities, IDs and attributes. `rfq-quote forget` deletes corrections by RFQ or by age, for erasure requests and scheduled retention. Every copy, its owner, lifetime and deletion route is listed in [data-handling.md](data-handling.md). Corrections must be anonymised before they join a golden set, and real golden sets never go in a public repository.

**Rejected.** Encrypting the logs instead of minimising them (the operator holds the key, so the data is still there to leak). Leaving deletion to manual file editing (error-prone, and nobody does it on time). A blanket "no logging" mode (it breaks the audit trail decision 1 depends on).

**Consequences.** `full` stays the default, because it is the most useful while debugging; production deployments should set `shape`. Run files have no automatic expiry yet. Anthropic retention depends on the account (30 days standard, or zero data retention on request) and on the model: the Covered Models (the Fable and Mythos families) require 30-day retention.

### 19. Shared sign-in state in Redis, encrypted, for more than one instance

**Context.** Decision 11 kept OAuth clients, sign-in requests, codes, access-token grants and sign-in failure counters in one process's memory. That means one instance: no failover, no rolling deploy without signing everyone out, and a sign-in lockout that a second instance would not see. The grants hold each user's Magento customer token, so wherever they are shared becomes the most sensitive store in the deployment.

**Decision.** One `StateStore` interface with two implementations: memory (the default, unchanged behaviour) and Redis (`COMMERCE_STATE_STORE=redis`). The provider uses only get, set with a TTL, take (read and delete in one step), a windowed counter and a schedule of grant expiries. In Redis:

- every value is encrypted with AES-256-GCM under a key derived from `COMMERCE_STATE_KEY`, with the Redis key as associated data, so a value copied to another key does not decrypt;
- every key is a keyed hash (HMAC-SHA-256 under a key derived from `COMMERCE_STATE_KEY`) of the real id, so a dump or `MONITOR` shows no usable code, access token or email address, and a guessed email or address cannot be tested against the key names;
- each sealed value carries its own expiry, so a copy put back later or given a longer Redis TTL still stops working on time (it cannot be made single-use again by an attacker who can write to Redis: that needs Redis to be trusted);
- lifetimes are Redis TTLs, so nothing outlives its expiry even if every instance stops;
- single-use codes and sign-in requests are taken with `GETDEL`, so two instances cannot both redeem one;
- grant expiries are a sorted set, and `ZREM` hands each expired grant to exactly one instance, which signs the user out at the store.

Each instance still closes its own MCP sessions: on its one-minute sweep it checks every session's grant against the store, so a token revoked or expired on another instance ends the session here too, and the bearer check refuses the token at once on every instance.

**Rejected.** Stateless tokens (signed JWTs carrying the customer token): they cannot be revoked before expiry, and the customer token would travel to the client inside them. A database table: it adds a schema and migrations for data that lives an hour. Encrypting only the customer token field: the email and client metadata are personal data too, and one rule ("everything is sealed") is easier to review than a field list. Sharing the MCP sessions themselves: a session is a live server object with an open stream, and the Streamable HTTP spec already lets a client recover from a lost session by starting a new one.

**Consequences.** Several instances can run behind one public URL. MCP sessions stay on the instance that opened them, so the load balancer should route by the `Mcp-Session-Id` header; without that, a request that lands elsewhere gets 404 and the client opens a new session, which works but costs an initialize round trip. Every instance needs the same `COMMERCE_STATE_KEY`, and changing it signs everyone out (old values no longer decrypt and are treated as absent). Redis becomes a dependency to run and secure: use `rediss://`, a password, and no persistence or encrypted persistence. The memory store keeps its 1,000-client cap; in Redis, registrations expire after 30 days and `/register` is rate-limited per address by each instance's own in-memory counter (set `COMMERCE_TRUST_PROXY` behind a proxy so "address" is the client). App Builder also needs a stateless HTTP mode: decision 20.

### 20. A stateless HTTP mode for load balancers and serverless

**Context.** With decision 19, any instance can verify a token, but an MCP session is still a live object on the instance that opened it, so several instances need sticky routing by `Mcp-Session-Id`. Serverless platforms such as Adobe App Builder (I/O Runtime) cannot do that at all: each invocation may run anywhere and nothing stays in memory between them.

**Decision.** `COMMERCE_HTTP_SESSIONS=stateless` uses the Streamable HTTP transport with no session id. Each POST to `/mcp` is checked against the OAuth store, gets a fresh McpServer and transport for the token's user, is answered as plain JSON (no SSE stream), and both are closed when the response ends. GET and DELETE return 405. Nothing about the request is kept, except one backend per grant for a few minutes, so the PaaS company-membership check (cached 60 seconds inside the backend) is not repeated on every call. Writes are unaffected: the confirmation token is an HMAC over the tool, the caller and the input (decision 2), so a draft previewed on one instance can be confirmed on another, as long as every instance has the same `COMMERCE_CONFIRM_SECRET`.

**Rejected.** Sharing session objects through Redis (a session holds an open stream and an SDK server; serialising them is fragile and the spec does not need it). Making stateless the default (stateful mode keeps server-to-client notifications and the SSE stream that some clients use, and costs nothing on one instance). Per-request backends with no reuse (an extra GraphQL round trip to the store on every tool call).

**Consequences.** Any instance or invocation can answer any request, so no sticky routing is needed. The server cannot push notifications or hold long-running streams; none of the current tools need them. The audit line has no `session_id` in this mode; the `trace_id`, caller and OAuth client still identify the call. On a serverless platform the one-minute sweep may never run, so expired grants are not signed out at the store early: Redis drops them by TTL, and the store's own customer token expires on its own schedule. Running on App Builder itself still needs packaging and a deployment guide.

### 21. A Vercel function entry that refuses in-memory state

**Context.** Deployed to Vercel as-is, the server crashed on every request: `src/index.ts` starts a long-running listener, while a Vercel function must export a request handler. Vercel instances also come and go and share no memory, so the default stateful sessions and in-memory sign-in store would lose OAuth codes, tokens and sessions between requests and sign users out at random.

**Decision.** `src/vercel.ts` exports a handler that loads the config, builds the Express app once per warm instance (waiting for the Redis check), and passes each request to it. `api/index.js` re-exports it from `dist/`, and `vercel.json` builds with `npm run build` and rewrites every path to that function, with a static output holding only `public/robots.txt` (Vercel rejects an empty one), so no repository file is served. The handler refuses to start unless `COMMERCE_HTTP_SESSIONS=stateless`, `COMMERCE_STATE_STORE=redis` and an https `COMMERCE_PUBLIC_URL` are set. Until then it answers 503 with a fixed message and writes the reason to the function log; a failed start is retried on the next request. `.vercelignore` keeps the same local files out of uploads as `.dockerignore`.

**Rejected.** Vercel's zero-config Express detection (it picked up `src/index.ts`, which listens instead of exporting). Allowing the in-memory store on Vercel for demos (it fails intermittently, which is harder to diagnose than a clear refusal). Returning the configuration error to the caller (it names the deployment's settings; the log is the right place).

**Consequences.** One deployment needs a Redis (for example Upstash) even for the mock store. Vercel's per-deployment URLs are refused by the DNS-rebinding check unless `COMMERCE_PUBLIC_URL` names them, so clients use the production domain. Decision 20's consequences apply: no server-to-client stream, and the one-minute sweep may not run.

### 22. RFQ review as an MCP tool, with intake inside the server

**Context.** The quote assistant only ran as a CLI, so a buyer working in Claude Desktop or another MCP client had to leave the chat, save the RFQ as a file and run `rfq-quote review`. Exposing the review as a tool raises one question: who reads the RFQ? The calling agent could extract the lines itself and pass them in, but that agent has tools, and the RFQ is untrusted text from outside the company. Decision 13 exists so that the model reading an RFQ cannot act on it.

**Decision.** `review_rfq` takes the RFQ as text or a base64 PDF and runs the existing pipeline inside the server: the intake step (rule-based by default, Claude when `COMMERCE_RFQ_EXTRACTOR=claude`) has no tools, then matching, stock and price go through the server's own tools over an in-memory MCP connection, acting as the same caller, with the same allowlist and audit log. The result is the review in a trimmed form: each line's text, match, alternatives, stock, price, flags and status; customer-written fields grouped under `customer_content` with a notice that they are data; and a `draft_input` built by `draftInput` from the ready lines only. It saves nothing. The audit log records the RFQ's size, never its text. One review returns at most 80 lines, so the result stays inside the context budget (decision 6).

**Rejected.** Letting the calling agent extract the lines (a hostile RFQ would reach a model with tools). Saving the review on the server and returning an id (stdio has no shared store, and the agent already holds the result). Defaulting the server to Claude intake (every tool call would be a paid API call the operator did not choose).

**Consequences.** The calling agent still sees whatever the person pastes into the chat: the tool cannot prevent that, so the server instructions and the result both say that RFQ text is data and that `suspicious_instructions` are never acted on. The rule-based default cannot read PDFs and does not report injected instructions; an operator who wants either sets the Claude extractor and accepts about $0.08 per RFQ. The draft still needs `draft_negotiable_quote`'s preview and a person's approval (decision 2).

### 23. Submitting and closing quotes are opt-in writes

**Context.** Decision 2 limited every write to a draft: a person submitted the quote in the storefront. That kept the agent away from anything the seller sees, but it also ended the assistant's help at the draft. A buyer still had to leave the chat to send the quote, read the seller's counter-offer, reply to it or decline it.

**Decision.** Two read tools, `list_negotiable_quotes` and `get_negotiable_quote`, show the buyer's quotes, their negotiated prices and the comment history. Comments are labelled third-party text, like product descriptions (decision 3). Two writes, `submit_negotiable_quote` (send a draft to the seller, or reply to an updated quote) and `close_negotiable_quote`, follow the propose-then-approve pattern. Their confirmation token is bound to the action's input and to the quote's state at preview time (status, update time, lines and prices). If the seller changes the quote before the buyer confirms, the approval no longer matches and a new preview is needed. Each token works once. Both writes are registered only when `COMMERCE_TOOLS_ENABLED` names them. Accepting an offer stays in the storefront, because it means checking out and placing an order.

**Rejected.** Turning the writes on by default (an existing setup would gain the power to send things to the seller just by upgrading). A token bound to the input alone (a buyer could approve one price and confirm against another). Accepting through `placeNegotiableQuoteOrder` (placing orders and taking payment stay out of scope).

**Consequences.** Decision 2 now reads: drafts by default; submit and close only when the operator turns them on, and every call is approved by a person. The quote GraphQL calls follow the B2B storefront schema, but they have not been checked against a live store, and the storefront API has no status filter for quotes, so the list is not filtered by status.

### 24. A review page for reps, beside the MCP endpoint

**Context.** Reviewing an RFQ meant a terminal: `rfq-quote review`, then editing a JSON run file or passing `correct` flags, then `draft` with a y/N prompt. Inside sales reps work in a browser, and the MCP tool (decision 22) needs an AI client. Both left out the person the review sheet is for.

**Decision.** The HTTP server can serve a review page at `/rfq` (`COMMERCE_RFQ_WEB=on`, off by default). A rep signs in with their store account through the same identity check and the same lockout counters as the OAuth sign-in page (decision 11). The session is a random cookie value whose hash keys a record in the state store, so it works on one instance, on several with Redis, and in stateless mode. The record holds the user's store token and expires with it. The rep pastes or attaches an RFQ, sees the review sheet, picks one of the offered parts (or leaves a line out) and sets quantities. Changed lines are re-priced from the store and marked as the rep's decision. Then the rep previews the draft and saves it. Every store call goes through the server's own tools as that user, so scoping, the allowlist, the audit log and the propose-then-approve token apply unchanged. Reviews are kept per user in the state store and expire after `COMMERCE_RFQ_RETENTION_DAYS`. Every POST needs the session's CSRF token and passes a same-origin check. The sign-in form carries a single-use nonce. Every customer or store string is cleaned and HTML-escaped, and the CSP allows only the page's own script and stylesheet. A user may start 30 reviews an hour.

**Rejected.** Reusing the OAuth bearer tokens in the browser (they would have to live in script-readable storage). A separate front-end app (a second deployment and an API surface for one page). Letting a rep type any SKU (a typo could put the wrong part in a quote; the rep chooses among the parts the matcher offered, and a part it never found is a "leave out" and a manual quote). A multipart upload parser (another dependency; the page reads the file into a form field instead).

**Consequences.** The server gains a second sign-in surface, so it is off by default and shares the lockout. A rep's choice settles a line's matching flags, but a line is ready only with a store price. The eval's safety number covers the pipeline before any rep edit, and the rep owns each edit. Saved reviews hold customer data on the server for the retention period (see `docs/data-handling.md`). Without JavaScript, a rep can still paste text but cannot attach a file.

### 25. RFQs from an IMAP inbox, reviewed but never drafted

**Context.** Most RFQs arrive by email. With the review page (decision 24), a rep still had to copy each one in. The obvious step is to read a shared RFQ mailbox. But mail is the least trusted input there is: anyone can send it, it can be large, and its attachments can be anything.

**Decision.** `rfq-inbox` is a separate process. It reads unread mail over IMAP with TLS only, using an app password kept in `.env`. Each poll, it:
- skips any message it has seen before (by Message-ID);
- sets aside mail from senders outside `COMMERCE_INBOX_ALLOWED_SENDERS` (addresses or domains);
- reads up to 5 attachments of the types the assistant reads (text, CSV, email, and PDF only with Claude intake), each 20 MB at most, or else the body;
- runs the review as the one company user it is configured for, through the server's own tools;
- saves the result to that user's queue in the shared Redis store, where the review page shows it.

It never drafts or sends anything. A person does that on the page, with the usual preview and approval. Processed mail is moved to `COMMERCE_INBOX_DONE_FOLDER`, or marked read. When the store or the intake model is down, the message is left unread for the next poll. A lease in the store keeps two pollers off one mailbox. Logs carry counts and reasons, never message text, addresses or connection details. IMAP is generic, so it works with Microsoft 365, Gmail, Zoho or any host.

**Rejected.** Running the poller inside the HTTP server. Over HTTP, the config forbids a fixed store identity, so that no client can share one (decision 11). The poller needs exactly one, so it gets its own process and settings. Drafting automatically from mail (a hostile or mistaken email would reach the store without a person). Provider-specific APIs such as Microsoft Graph or the Gmail API (more setup and tied to one vendor; IMAP covers them all). Storing the original email (the review keeps what the rep needs; decision 18).

**Consequences.** The web page and the poller must share Redis (`COMMERCE_STATE_STORE=redis`). With an empty allowlist, anyone who knows the address can fill the queue, so startup warns. With Claude intake, every email is a paid call, so startup says so. If a multi-part email fails partway with a temporary error, the parts already reviewed are reviewed again on the retry. Two new dependencies, `imapflow` and `mailparser`, both MIT, are pinned to exact versions.
