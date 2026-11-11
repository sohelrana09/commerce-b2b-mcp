# commerce-b2b-mcp

MCP server for Adobe Commerce B2B (company users, negotiable quotes) plus an RFQ quote assistant that turns a customer RFQ into a reviewed draft quote. TypeScript, Node 20+, ESM.

## Commands

| Command | What it does | Cost |
|---|---|---|
| `npm test` | Vitest suite, including the golden-set safety gate | Free |
| `npm run typecheck` | `tsc --noEmit` | Free |
| `npm run build` | Compile to `dist/` | Free |
| `npm run dev` | Run the server from source (stdio, mock store) | Free |
| `npm run eval` | Golden-set eval with the rule-based intake | Free |
| `npm run eval -- --compare` | Rebuild `evals/results/comparison.md` from saved results | Free |
| `npm run eval -- --extractor claude` | Golden-set eval with Claude intake | **Paid API calls** |
| `npm run eval -- --sweep ...` | Several Claude settings in parallel | **Paid, several times over** |
| `rfq-quote review <file>` | Defaults to Claude intake; pass `--extractor heuristic` for free | **Paid by default** |

Before finishing any change: `npm run typecheck && npm test`. CI runs both on Node 20, 22 and 24.

## Layout

- `src/index.ts`: entry point; picks stdio or HTTP from `COMMERCE_TRANSPORT`.
- `src/config.ts`: every `COMMERCE_*` setting is parsed and validated here. Add new settings here, not with ad-hoc `process.env` reads.
- `src/server.ts`, `src/tools/`: MCP tools. Each tool is declared with `defineTool` in `src/tools/define.ts`, which audits, traces and maps errors for it.
- `src/backend/`: `mock/` (in-memory store and fixtures) and `paas/` (GraphQL client for a real store, acting as one company user).
- `src/http/`: Streamable HTTP transport, OAuth provider, sign-in page, session handling.
- `src/audit.ts`, `src/trace.ts`: audit log and per-call tracing.
- `src/assistant/`: the RFQ quote assistant (intake extractors, pipeline, CLI, corrections, eval, pricing).
- `evals/golden/`: synthetic golden set. `evals/results/`: committed Markdown summaries (JSON is ignored).
- `docs/decisions.md`: architecture decisions (ADRs). `docs/service-targets.md`, `docs/data-handling.md`: what the assistant promises and how it handles data.

## Rules

These protect real customer data and the merchant's store. They are not style preferences.

- **Caller-scoped access only.** Every store call acts as one signed-in company user (ADR 1). Never add an admin token or an integration token, not even for a script or a test.
- **Credentials stay in ignored files**: `.env`, `.env.*` (except `.env.example`), `.mcp.json`, `scripts/`. Never print, log or commit a token, password or API key. Any audit field whose key contains token, secret, password or authorization must stay redacted.
- **No client names, store URLs or customer data in committed files.** Test data is synthetic (Harbour Marine Engineering in the mock store). Before committing, check the staged diff for anything that names a real merchant or a real person.
- **No paid API runs without the person's go-ahead**: that covers `--extractor claude`, `--sweep` and `rfq-quote review` without `--extractor heuristic`. Say what will run and the rough cost first (about $0.08 per RFQ, $0.70 per golden-set run at Opus 5.5 medium).
- **The safety gate stays at zero.** "Wrong lines marked ready" must be 0 on the golden set; a test enforces it. Never loosen a flag rule or a threshold in `src/assistant/eval/targets.ts` to make a run pass. If a change moves another target, update `docs/service-targets.md` in the same change.
- **The golden set is synthetic.** Never copy a real RFQ or a rep correction into `evals/golden/` without the anonymising steps in `docs/data-handling.md`.
- **Intake has no tools.** The model reads the RFQ and returns structured fields; it never searches, prices or writes (ADR 13). Keep it that way.
- **stdout is the MCP protocol channel** in stdio mode. Diagnostics go to stderr.

## Conventions

- Errors reach the client as `ToolError` (`src/errors.ts`) with a plain-language message and a retryable flag (ADR 5); never leak raw GraphQL errors or stack traces.
- A new tool needs: a zod input schema with descriptions, a test in `test/tools.test.ts` against the mock store, and, if it writes, the propose-then-approve confirmation token used by the quote tools (ADR 2).
- A significant design choice gets an ADR in `docs/decisions.md` (context, decision, consequences).
- Prices in `src/assistant/pricing.ts` are a list-price snapshot; when you change them, re-run `--compare` and update `docs/service-targets.md`.
- Commit messages: imperative subject, a body that says why. One logical change per commit.
