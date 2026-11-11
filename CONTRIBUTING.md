# Contributing to commerce-b2b-mcp

Bug fixes, new B2B tools, adapters and better evals are all welcome. For larger changes, open an issue first so we can agree on the approach.

## Getting set up

You need Node.js 20 or later. No store and no API key are needed: the mock backend covers everything the tests use.

```bash
git clone https://github.com/sohelrana09/commerce-b2b-mcp.git
cd commerce-b2b-mcp
npm install
npm test
npm run demo
```

## Making a change

1. Fork the repository and create a branch: `git checkout -b feature/your-change`.
2. Follow the [project structure](README.md#project-structure):
   - every `COMMERCE_*` setting is parsed and validated in `src/config.ts`, not read from `process.env` elsewhere;
   - each tool is declared with `defineTool` in `src/tools/define.ts`, which adds the audit line, tracing and error mapping;
   - errors reach the client as `ToolError` (`src/errors.ts`) with a plain-language message and a retryable flag, never as a raw GraphQL error or stack trace;
   - in stdio mode stdout is the MCP protocol channel, so diagnostics go to stderr.
3. A new tool needs:
   - a zod input schema with descriptions;
   - a test in `test/tools.test.ts` against the mock store;
   - if it writes, the propose-then-approve confirmation token used by `draft_negotiable_quote`.
4. Run the checks. CI runs both on Node 20, 22, 24 and 26:

   ```bash
   npm run typecheck
   npm test
   ```

5. Commit with an imperative subject and a body that says why, one logical change per commit. Push the branch and open a pull request that says what changed and how you tested it.

A significant design choice gets an ADR in [docs/decisions.md](docs/decisions.md): context, decision, consequences.

## Rules that protect stores and customers

These are not style preferences. A pull request that breaks one won't be merged.

- **Caller-scoped access only.** Every store call acts as one signed-in company user. Don't add an admin token or an integration token, not even for a script or a test. The one exception is the optional read-only MSI inventory token described in the README.
- **No credentials in the repository.** Tokens, passwords and API keys belong in `.env` (ignored by git), never in code, tests, fixtures or logs. Audit fields whose key contains token, secret, password or authorization stay redacted.
- **No real customer data.** Test data is synthetic. Don't commit a real merchant's name, store URL, RFQ or customer, and check your diff for them before you push.
- **The safety gate stays at zero.** "Wrong lines marked ready" must be 0 on the golden set, and a test enforces it. Don't loosen a flag rule or a threshold in `src/assistant/eval/targets.ts` to make a run pass. If a change moves another target, update [docs/service-targets.md](docs/service-targets.md) in the same pull request.
- **The golden set is synthetic.** Real RFQs or rep corrections go into `evals/golden/` only after the anonymising steps in [docs/data-handling.md](docs/data-handling.md).
- **Intake has no tools.** The model reads the RFQ and returns structured fields. It never searches, prices or writes.

## Evals

`npm run eval` uses the rule-based intake: it is free, and CI runs it. `npm run eval -- --extractor claude` and `--sweep` call the Anthropic API and cost money (about $0.70 per golden-set run at Opus 5.5, medium effort), so they are never part of CI. If your change affects intake, say in the pull request whether you ran the Claude eval and paste the summary.

## Working with Claude Code

[`CLAUDE.md`](CLAUDE.md) holds the project rules for Claude Code, and [`.claude/settings.json`](.claude/settings.json) shares the team's permissions and a typecheck hook. Onboarding and the review checklist are in [docs/team-setup.md](docs/team-setup.md).

## Reporting bugs and security issues

- Bugs and ideas: [open an issue](https://github.com/sohelrana09/commerce-b2b-mcp/issues/new).
- Security problems: report them privately, see [SECURITY.md](SECURITY.md).

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
