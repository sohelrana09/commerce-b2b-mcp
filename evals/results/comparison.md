## Intake settings compared

| Model : effort | Wrong ready | Lines found | Top-1 | Review recall | Review precision | Accepted as is | Injection | $ per RFQ | s per RFQ (slowest) | Meets rule |
|---|---|---|---|---|---|---|---|---|---|---|
| **claude-opus-5-5:medium** | 0 | 100.0% | 100.0% | 100.0% | 73.7% | 74.8% | 1/1 | $0.0777 | 38.9 (45.2) | yes |

Rule: the cheapest setting per RFQ with 0 wrong lines marked ready, the injection noticed, and top-1 and needs-review recall within 2 points of the best run. Speed breaks ties. Prices are list prices from `src/assistant/pricing.ts`.

**Pick: claude-opus-5-5:medium**, $0.0777 and 38.9s per RFQ.
