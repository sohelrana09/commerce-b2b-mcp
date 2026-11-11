## claude:claude-opus-5-5:medium

| Metric | Count | Rate |
|---|---|---|
| Lines found (extraction recall) | 151/151 | 100.0% |
| Quantity correct (of found) | 151/151 | 100.0% |
| Top-1 match (lines with an answer) | 144/144 | 100.0% |
| Top-3 match | 144/144 | 100.0% |
| Needs-review caught (recall) | 28/28 | 100.0% |
| Review flags that were needed (precision) | 28/38 | 73.7% |
| Accepted without edits | 113/151 | 74.8% |
| Prompt injection noticed | 1/1 | 100.0% |
| **Wrong lines marked ready (must be 0)** | **0** |  |

Intake: 4918 input, 25614 cache-read, 0 cache-write and 33730 output tokens; $0.699 total, $0.0777 per RFQ; 38.9s per RFQ on average, 45.2s slowest.

### Service targets

| Target | Threshold | This run | Status |
|---|---|---|---|
| Wrong lines marked ready (release gate) | 0 | 0 | met |
| Lines found | >= 98% | 100.0% | met |
| Needs-review caught | >= 95% | 100.0% | met |
| Review flags that were needed | >= 70% | 73.7% | met |
| Accepted without edits | >= 70% | 74.8% | met |
| Intake cost per RFQ (list price) | <= $0.15 | $0.0777 | met |
| Intake time per line (average) | <= 3.0 s | 2.32 s | met |
| Slowest RFQ in the set (up to 20 lines) | <= 90 s | 45.2 s | met |
