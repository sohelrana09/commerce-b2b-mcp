# Team setup: working on this repository with Claude Code

How a developer gets started, what is shared through the repository, and how a change gets from a branch to `main`. The goal is that every developer, and every Claude Code session, starts with the same rules, the same safe defaults and the same checks.

## First day

1. Install Node 20 or later, then run `npm ci`.
2. Run `npm run typecheck && npm test`. Everything runs against the built-in mock store; no credentials are needed.
3. Open the repository in Claude Code. It reads two shared files automatically:
   - [`CLAUDE.md`](../CLAUDE.md): commands, layout, the rules that protect customer data, and conventions.
   - [`.claude/settings.json`](../.claude/settings.json): shared permissions and a typecheck hook.
4. Read ADRs 1, 2, 3 and 16 in [decisions.md](decisions.md). They explain why the server acts as one company user, why writes are propose-then-approve, why store content is never treated as instructions, and why one eval number must stay at zero.

To work against a real store, copy `.env.example` to `.env` and follow the README. Use a test company and test customers only; never an admin or integration token.

## What is shared, and what is personal

| File | Committed | Purpose |
|---|---|---|
| `CLAUDE.md` | Yes | Project instructions for every Claude Code session |
| `.claude/settings.json` | Yes | Team permissions and hooks |
| `.claude/settings.local.json` | No (ignored) | Your own overrides, for example extra allowed commands |
| `~/.claude/CLAUDE.md`, `~/.claude/settings.json` | No | Your personal defaults across all projects |
| `.env`, `.env.*`, `.mcp.json`, `scripts/` | No (ignored) | Credentials and local store connections |

Settings merge in this order: your user settings, then the project file, then your local file. A `deny` rule in the project file cannot be overridden by a personal `allow`.

## What the shared settings do

**Allowed without asking:** tests, typecheck, build, the free rule-based eval (`npm run eval`, `--compare`), and read-only git commands (`status`, `diff`, `log`, `show`).

**Always asks first:**

- Paid Claude evals: `--extractor claude`, `--sweep`, and running the eval or `rfq-quote review` directly. A golden-set run at the default setting costs about $0.70; a sweep costs that per setting. Approve only when you intend to spend it.
- `git push`.

**Never readable by Claude Code:** `.env` and `.env.*`, `.mcp.json`, `scripts/`, the audit log (`audit.jsonl`, which holds sign-in emails) and the corrections log (`evals/corrections.jsonl`, which can hold customer text). Note that the `.env.*` rule also hides `.env.example`; read it yourself or open it in the editor when needed.

**Typecheck hook:** after Claude Code writes or edits a `.ts` file, the hook runs `tsc --noEmit`. If it fails, the first 30 lines of errors go straight back to Claude, which fixes them before moving on. It takes about a second on this codebase.

These rules reduce mistakes; they are not a security boundary. A determined shell command can still read a file. The real protection is that credentials stay out of the repository and the store token is scoped to one company user.

## Making a change

1. **Branch** from `main`: `feature/<short-name>` or `fix/<short-name>`.
2. **Plan first for anything that touches the rules in `CLAUDE.md`**: access control, the confirmation flow, the audit log, the intake prompt or schema, or the eval thresholds. Ask Claude Code for a plan, read it, then let it implement.
3. **Keep the change small**: one logical change per commit, with a message that says why.
4. **Before pushing**, run locally:
   - `npm run typecheck && npm test`
   - `npm run eval` if the change touches `src/assistant/` (free; shows every service target)
   - a check of the staged diff for real merchant names, store URLs, emails or keys
5. **Open a pull request** with: what changed, why, how it was tested, and eval results if the assistant changed. If a significant design choice was made, the PR adds an ADR.

## Reviewing a pull request

Every PR needs one human approval. CI must pass on Node 20, 22 and 24 (`npm ci`, typecheck, test, build); the test run includes the golden-set safety gate, so a change that marks a wrong line ready cannot merge.

Use Claude Code to prepare the review, then decide yourself:

- `/code-review` on the branch for correctness bugs.
- `/security-review` for any change under `src/http/`, `src/backend/paas/`, `src/audit.ts`, `src/config.ts` or `src/tools/`.
- For the quote assistant, compare the PR's eval summary with `evals/results/` on `main`.

What the human reviewer checks, that tools miss:

| Area | Question |
|---|---|
| Access | Does every store call still act as the signed-in company user? Could one user's session see another's data? |
| Writes | Does any new write go through propose-then-approve, and only ever create a draft? |
| Prompt injection | Is text from the store, an RFQ or an email treated as data, never as instructions? |
| Data | Does anything new get logged, saved or sent to the API? Is it in [data-handling.md](data-handling.md)? |
| Evals | Did a threshold or flag rule change? If so, is the reason in the PR and in [service-targets.md](service-targets.md)? |
| Cost | Does the change add API calls, raise effort or change the model? What does it cost per RFQ? |
| Errors | Do new errors give the user a plain next step, without leaking GraphQL detail or stack traces? |

## When the rules need to change

Edit `CLAUDE.md` or `.claude/settings.json` in a normal pull request, and say why in the description. A rule that keeps getting in the way is a sign the rule or the code needs fixing, not that developers should route around it in local settings.
