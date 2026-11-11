# Data handling: RFQ quote assistant and MCP server

What customer data the system touches, where each copy lives, how long it stays, and how to delete it. Written for the merchant's data protection lead and for whoever runs the deployment. It describes the software as built; the merchant decides the lawful basis, the retention periods and what goes in their privacy notice. It is not legal advice.

## What data is involved

An RFQ is a business email or file, but it usually carries **personal data**: the buyer's name, email address, phone number and signature, sometimes a site address, and free-text notes. The company user who signs in is also identified, by email, in every audit line. Prices, stock and SKUs are the merchant's commercial data, not personal data.

## Where each copy lives

| # | Data | Where | Who controls it | How long | How to delete |
|---|---|---|---|---|---|
| 1 | Full RFQ text or PDF | Sent to the Claude API for intake (Claude intake only) | Anthropic, as processor | 30 days on standard commercial terms; nothing stored with zero data retention (ZDR) | Expires on its own; ZDR avoids storage |
| 2 | RFQ file itself | Wherever the rep saved it | Merchant | Merchant's rule | Delete the file |
| 3 | Review run: extracted lines, customer name, RFQ reference, other requests, suspicious text, matches and prices | `<rfq>.run.json` next to the RFQ (or `--save`), and `--out` Markdown if asked for | Merchant | Until deleted; no automatic expiry | Delete the files |
| 4 | Rep corrections: RFQ line text, chosen SKU, rep note, RFQ file name | `evals/corrections.jsonl` (or `--log`) | Merchant | Until deleted | `rfq-quote forget --document <name>` or `--older-than <days>` |
| 5 | Audit log: caller email, company ID, tool, tool input, outcome, timings, trace ID; over HTTP also the session and OAuth client | stderr or `COMMERCE_AUDIT_LOG` file | Merchant (operator) | Until the operator's log retention removes it | Log rotation; `COMMERCE_AUDIT_INPUT=shape` keeps free text out in the first place |
| 6 | Draft negotiable quote: name, SKUs, quantities, line notes ("RFQ line 3") | Magento | Merchant | Magento's own rules | Delete the quote in Magento |
| 7 | HTTP mode sign-in state: OAuth clients, hashed access tokens, the company user's Magento token, sign-in failure counters (IP address and email) | Server memory only, never disk | Merchant (operator) | Tokens at most 1 hour; failure counters 15 minutes; all lost on restart | Revoke the token, or restart |
| 8 | Diagnostics: store error messages, failed tool calls | stderr | Merchant (operator) | Operator's log retention | Log rotation |
| 9 | Golden eval set and published results | This repository | Project | Permanent | Synthetic data only, so nothing to delete |

Not stored anywhere: passwords (the sign-in page passes them to the store's `generateCustomerToken` and keeps nothing), the Magento customer token outside server memory, and the original RFQ inside the run file (only the extracted fields are kept).

## Design choices that limit data

- **Intake keeps only what quoting needs.** The extraction schema has fields for lines, the RFQ reference and the customer name. Signatures, phone numbers and addresses in the email are not copied into the output.
- **The model only reads; it does not search, price or write.** Intake has no tools (decision 13), so RFQ text cannot reach the store through the model.
- **Secrets never reach the audit log.** Any input key containing token, secret, password or authorization is replaced with `[redacted]`.
- **Minimised audit mode.** With `COMMERCE_AUDIT_INPUT=shape`, free text in tool inputs (search phrases built from RFQ lines, quote names, comments and notes) is logged only as its length, for example `"[text, 35 chars]"`. SKUs, quantities, IDs and catalogue attributes stay, so the log still answers "who did what, when, to which part". Use `full` while debugging, and `shape` in production.
- **Caller-scoped access.** Every call acts as one company user, so a mistake or a prompt injection can only see what that user can see (decision 1).
- **No customer data in the JSON schema.** Structured outputs cache the schema (not the content) for up to 24 hours; the schema holds only field names.

## Anthropic as processor

On Anthropic's own documentation as of November 2026:

- Data sent to the API is not used for model training without the customer's express permission.
- Standard commercial API retention is 30 days. Zero data retention is available on request through Anthropic sales. The intake uses only features that are eligible for it: Messages, structured outputs and prompt caching.
- Some models, the "Covered Models" (the Fable and Mythos families), require 30-day retention and are not available under ZDR. The default intake model, Claude Opus 5.5, is not one of them. If a merchant needs ZDR, keep the intake model off that list.
- **Open question:** the intake requests a server-side fallback model for safety declines. Confirm with Anthropic which model the fallback uses and whether it is covered by the same retention arrangement, or turn the fallback off for ZDR deployments.

Through Amazon Bedrock or Google Cloud, the cloud provider is the processor and its terms apply instead.

## Running it: recommended settings

1. Set `COMMERCE_AUDIT_INPUT=shape` and write the audit log to a file under the merchant's normal log rotation, with a stated retention (for example 90 days).
2. Store run files and the corrections log in one controlled folder, not next to RFQs on personal drives. Delete run files once the quote is sent, unless the merchant keeps them as a record.
3. Run `rfq-quote forget --older-than <days>` on a schedule that matches the merchant's retention for quote records.
4. Use the rule-based intake for an RFQ that must not leave the merchant's systems. It finds fewer lines (see [service targets](service-targets.md)) but sends nothing to Anthropic.
5. Ask Anthropic for ZDR if the merchant's policy requires no third-party storage.

## Turning corrections into eval data

The corrections log is designed to grow the golden eval set, which means real customer text could end up in a test file. Before any correction joins the golden set:

- Keep only the line text and the expected answer. Drop the RFQ file name and rep notes.
- Remove names, emails, phone numbers and site references from the line text.
- Keep the golden set inside the merchant's systems. **Never commit it to a public repository.**

## Requests from individuals

- **Access:** search run files, the corrections log and the audit log for the person's name or email. With `shape` mode, the audit log holds the signed-in rep's email but not the buyer's details.
- **Erasure:** delete the RFQ and its run files, run `rfq-quote forget --document <rfq file name>`, and delete or anonymise the draft in Magento. Data sent to Anthropic expires on its own (30 days on standard terms) or was never stored (ZDR).

## Gaps

- No automatic expiry for run files: they are deleted manually or by a scheduled job.
- The audit log has no built-in rotation; it relies on the platform.
- With `full` mode, search phrases in the audit log can contain customer text.
- The open question above about the fallback model.
