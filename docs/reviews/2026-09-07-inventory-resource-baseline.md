# Inventory resource baseline — measured 2026-09-07

Reproduce with `node scripts/reviews/inventory-advancement-benchmark.cjs`. Raw evidence: [JSON](2026-09-07-inventory-resource-baseline.json). The script creates and removes only its own guarded loopback database. No product changes or new feature performance are measured here.

Environment: v24.16.0, 10.4.32-MariaDB, Intel(R) Core(TM) i7-14700KF, 28 logical CPUs, 31.84 GiB RAM. Shared local database service; 12 warm sequential samples per operation. p95 here is the largest sample, not a robust tail estimate.

| Items / movements / invoices | Operation | p50 ms | p95 ms | Node CPU ms/call | Queries | JSON bytes | Sampled Node RSS MiB |
|---|---|---:|---:|---:|---:|---:|---:|
| 100 / 2,100 / 1,000 | all ingredient summaries | 6.32 | 6.60 | 2.58 | 1 | 46,793 | 88.8 |
| 100 / 2,100 / 1,000 | 50 ingredient balances by IDs | 1.52 | 1.86 | 0.00 | 1 | 3,492 | 89.6 |
| 100 / 2,100 / 1,000 | purchase costs for 20 ingredients | 1.23 | 1.68 | 0.00 | 1 | 1,152 | 90.2 |
| 100 / 2,100 / 1,000 | whole-period sales analysis | 21.39 | 56.98 | 16.92 | 14 | 39,056 | 132.3 |
| 1,000 / 21,000 / 10,000 | all ingredient summaries | 56.56 | 78.67 | 14.33 | 1 | 468,894 | 152.6 |
| 1,000 / 21,000 / 10,000 | 50 ingredient balances by IDs | 1.50 | 2.03 | 1.33 | 1 | 3,492 | 148.7 |
| 1,000 / 21,000 / 10,000 | purchase costs for 20 ingredients | 1.38 | 2.48 | 1.33 | 1 | 1,152 | 148.8 |
| 1,000 / 21,000 / 10,000 | whole-period sales analysis | 329.44 | 374.04 | 136.75 | 104 | 388,666 | 225.6 |
| 10,000 / 210,000 / 100,000 | all ingredient summaries | 536.92 | 783.30 | 72.83 | 1 | 4,698,895 | 339.9 |
| 10,000 / 210,000 / 100,000 | 50 ingredient balances by IDs | 1.88 | 3.21 | 1.33 | 1 | 3,492 | 342.9 |
| 10,000 / 210,000 / 100,000 | purchase costs for 20 ingredients | 0.69 | 0.78 | 1.33 | 1 | 1,152 | 342.9 |
| 10,000 / 210,000 / 100,000 | whole-period sales analysis | 7743.48 | 8217.65 | 1259.08 | 1004 | 3,909,706 | 369.2 |

## Findings

1. Ingredient summaries scale with the whole catalog and return approximately 4.7 MB at 10,000 items. Server pagination and projection-backed filters are prerequisites for advancing the UI.
2. Whole-period analysis costs scale with invoice count: 14, 104, then 1,004 queries. At 100,000 invoices the median is 7.74 seconds and Node CPU is 1.26 seconds per request. Large report rebuilds cannot remain unrestricted interactive work.
3. Bounded 20-item purchase-cost lookup remains small on this synthetic distribution. Do not rewrite all price lookup logic without a measured hot-item/old-history problem.
4. The balance-only 50-ID prototype demonstrates bounded work, but it omits full summary fields and real filtering/cursor semantics. It is not a feature-equivalent performance comparison.
5. The deterministic replenishment interleaving reproduced stock 15 instead of 14 using an actual sale deduction followed by the current absolute-update semantics. Prototype atomic delta returns 14. Production fix and HTTP retry/concurrency tests are still required.

## Limits and cost interpretation

- No direct Node-versus-MySQL CPU attribution for the database process was available. Database CPU and RAM remain unmeasured. Timings include database/driver wait but cannot identify CPU usage from elapsed time.
- Node CPU includes assertions and JSON serialization in the measurement loop; elapsed samples time the service call before those checks/serialization. Zero short-operation CPU values are timer-resolution artifacts.
- Sampled Node RSS/heap includes fixture construction and retained driver objects; the 369 MiB maximum is not incremental endpoint memory. A 10 ms sampler can miss short peaks.
- Final information_schema approximate fixture storage was 51,347,456 data bytes and 95,682,560 index bytes, including fixture tables. No per-feature annual storage cost is inferred.
- The fixtures use one-line invoices, frozen complete recipes, one product, no refunds and only 20 movements since each count. There are 100/1,000/10,000 ingredients; 2,100/21,000/210,000 movements; 1,000/10,000/100,000 invoices.
- No full checkout, HTTP, browser, network, printer, mixed-concurrency, 1-million-movement or low-end-device certification was run. Do not claim the advanced implementation is cheap before the v2 resource gates pass.
- The run is one warmed experiment per size with 12 observations. Repeat on deployment-class hardware/database, isolate other activity, and capture at least 1,000 samples for meaningful hot-path p99.

## Implementation decisions

Use bounded item reads, small transaction work, incremental report generations with visible freshness, and one throttled worker. Do not add server capacity, Redis or another runtime merely to accommodate repeated full-history scans. Keep correctness reconciliation independent from interactive report latency.
