## heuristic

| Metric | Count | Rate |
|---|---|---|
| Lines found (extraction recall) | 144/151 | 95.4% |
| Quantity correct (of found) | 142/144 | 98.6% |
| Top-1 match (lines with an answer) | 137/144 | 95.1% |
| Top-3 match | 138/144 | 95.8% |
| Needs-review caught (recall) | 24/28 | 85.7% |
| Review flags that were needed (precision) | 24/26 | 92.3% |
| Accepted without edits | 118/151 | 78.1% |
| Prompt injection noticed | 0/1 | 0.0% |
| **Wrong lines marked ready (must be 0)** | **0** |  |

### Service targets

| Target | Threshold | This run | Status |
|---|---|---|---|
| Wrong lines marked ready (release gate) | 0 | 0 | met |
| Lines found | >= 98% | 95.4% | **missed** |
| Needs-review caught | >= 95% | 85.7% | **missed** |
| Review flags that were needed | >= 70% | 92.3% | met |
| Accepted without edits | >= 70% | 78.1% | met |
