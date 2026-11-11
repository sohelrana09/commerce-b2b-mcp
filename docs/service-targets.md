# Service targets: RFQ quote assistant

What a merchant can expect from the quote assistant, and how each promise is measured. Every number below is checked by `npm run eval` against the golden set and printed in the result's "Service targets" table, so a change that breaks a target is visible in the same run that introduced it.

**Scope.** From an RFQ arriving to a rep seeing the reviewed lines: Claude reading the RFQ (intake), then matching, stock, pricing and flags through the MCP server. Human review time is not included.

## Targets

Measured on the golden set (9 RFQs, 151 lines) with Claude Opus 5.5 at medium effort, list prices, 11 November 2026.

| Target | Threshold | Measured | Why this threshold |
|---|---|---|---|
| **Wrong lines marked ready** | **0** | 0 | A wrong line that skips review reaches a customer at a price. This is the only release gate: the eval fails if it is missed. |
| Lines found | ≥ 98% | 100% | A missed line is a missed sale and an unhappy buyer; the rep would have to re-read the RFQ to notice. |
| Needs-review caught | ≥ 95% | 100% | A line that needed a question (no grade, no length, odd quantity) but was not flagged reaches the draft on the strength of the match alone. |
| Review flags that were needed | ≥ 70% | 73.7% | Below this, reps learn to ignore flags. The closest target to failing; see below. |
| Accepted without edits | ≥ 70% | 74.8% | The share of lines the rep only has to glance at. This is where time is saved. |
| Intake cost per RFQ | ≤ $0.15 | $0.078 | Leaves room for longer RFQs and higher effort without a pricing conversation. |
| Intake time per line | ≤ 3.0 s average | 2.3 s | Sets how long a rep waits; see sizing. |
| Slowest RFQ (up to 20 lines) | ≤ 90 s | 45 s | Keeps a typical RFQ within a coffee-break wait. |

The free rule-based intake meets the safety gate but misses two targets (95.4% of lines found, 85.7% of needed reviews caught), and it does not notice prompt injection. That gap is what the model is paid for.

## Sizing

Intake cost and time grow with the number of lines, because most of the cost is output tokens (about 220 per line, including thinking).

| RFQ size | Intake time | Intake cost |
|---|---|---|
| 10 lines | about 25 s | about $0.05 |
| 20 lines | about 45 s | about $0.09 |
| 50 lines | about 2 minutes | about $0.23 |
| 100 lines | about 4 minutes | about $0.45 |

Monthly intake cost at an average of 17 lines per RFQ: 500 RFQs about $40, 2,000 about $155, 10,000 about $780.

RFQs above about 30 lines should run in the background and notify the rep when ready, rather than keep them waiting on screen.

## What these targets do not cover yet

- **Store time.** Matching, stock and price calls go to the merchant's store. The audit log now records store calls and their time for every tool call (`upstream` in each line), so this can be measured per store. The golden set runs against the mock store, where it is negligible.
- **Claude API outages.** There is no automatic fallback yet. The rule-based intake is the natural degraded mode: lower recall, same safety gate.
- **Real RFQs.** The golden set is synthetic. The targets should be re-measured on a set built from the merchant's past quotes before they are promised in a contract.
- **Cheaper settings.** The sweep across effort levels and smaller models (`npm run eval -- --sweep ...`) is built but not yet run. At the current cost the saving is small; it matters at high volume.

## Watch list

- **Review precision (73.7%)** is 3.7 points above its threshold. All 10 unneeded flags came from the model marking a line uncertain, mostly quantities written as "x 100" with no unit. Tightening the intake prompt on that one case is the first fix if it drops.
- **Prices** are list prices from `src/assistant/pricing.ts`. Re-check them before quoting a customer.

## Questions for the merchant

These turn the targets into a business case:

1. How many RFQs a month, and how many lines on a typical one?
2. How long does a rep spend on one today, from email to draft quote?
3. How fast do buyers expect a reply, and how often is a quote lost to a faster competitor?
4. Which mistakes cost the most: wrong part, wrong quantity, wrong price, or a slow reply?

With answers 1 and 2, the saving is roughly: RFQs × rep minutes × the share of lines accepted without edits, minus the time spent on flagged lines.
