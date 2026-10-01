# Typed stock report facts and internal rebuild worker

Implementation remains internal. Source writers do not yet mark these generations, startup does not schedule the worker, and the public report still uses its existing source calculation. This does not complete package B or enable new stock authority.

The financial source traversal is shared with the existing analysis service. The reference report retains its 200-invoice batches; the worker retains at most 16 invoices per source batch and awaits the consumer. Frozen recipe snapshots, header-level revenue allocation, refund business dates, missing coverage and legacy estimates are preserved. Four build-scoped tables store meal, ingredient, source-event and physical-operation facts. Derived estimates are not carrying-value accounting.

Each fact transaction writes at most 500 expanded rows. The worker renews its generation lease before persistence and atomically publishes only a still-current build. Interrupted or uncertain writes abandon the build identity instead of retrying additive writes. All connections are released before yielding. A pool-local duty budget spans small chunks and successive scopes; 70 ms is the trigger for yielding the remainder of a 500-ms window. SQL is not preemptible, so the measured maximum work window must still be checked against the 100-ms target.

Cleanup shares the installation worker lease, removes at most 500 child facts per transaction and deletes the build header only after draining all children. Published/active pointers and source history are preserved. The additive migration invalidates old metadata-only publications once, preventing an empty typed projection from appearing current. Re-running the recorded migration preserves valid publications.

## Measurements so far

All fixtures are newly generated loopback databases. These are individual workstation runs, not low-end certification or latency percentiles. Node CPU excludes database CPU. Sampled RSS includes fixture retention and misses peaks between yields; it does not establish a memory reduction.

| Workload / worker version | Rebuild wall time | Node CPU | Pool source/metadata queries | Largest source payload | Maximum work window |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 invoices, original one-invoice batch and per-scope pacing | 32,710 ms | 1,171 ms | 2,621 | 2,044 bytes | 56.43 ms |
| 1,000 invoices, 16-invoice batch and shared duty window | 7,208 ms | 593 ms | 575 | 31,969 bytes | 84.37 ms |
| 10,000 invoices, revised worker | 41,275 ms | 1,532 ms | 1,832 | 32,185 bytes | 87.80 ms |
| 100,000 invoices, revised worker | 1,000,535 ms | 13,578 ms | 14,774 | 32,341 bytes | **135.15 ms — fails target** |
| 100,000 invoices, composite-index fix | 380,999 ms | 12,204 ms | 14,774 | 32,341 bytes | **105.18 ms — fails target** |
| 100,000 invoices, index fix and pre-read guard | 566,780 ms | 12,968 ms | 14,774 | 32,341 bytes | **84.57 ms — passes this run** |

Each invoice has three lines; every tenth invoice has a modifier and a next-day refund. Revenue and known-cost totals matched the reference at these sizes. The existing reference request did not consistently become faster. Rebuild work is additional background work, not a direct replacement request-latency comparison. Query counts exclude transactions that acquire a connection directly.

The [100,000-invoice / 10,000-refund result](2026-09-08-stock-report-facts-100000-baseline.json) fails the maximum-work-window target. Revenue is exactly 69,220,000 cents and stored cost exactly 136,000. The prior reference reports 136,000.00000009 because of repeated floating additions. A generated-input regression reproduced that drift; compensated cost summation fixes the reference without rounding individual lines or changing the financial allocator. Source/read assertions now require exact worked cost as well as revenue.

An EXPLAIN probe confirmed a PRIMARY range scan with post-filtered SHA partitioning; no indexed partition/date projection exists yet. A [10,000-invoice timed rerun](2026-09-08-stock-report-facts-10000-timings.json) records about 1.50 s in sales-source queries, 1.68 s in invoice-line queries and 1.14 s in fact/build inserts. The next experiment isolates one partition in a full 100,000-invoice database to locate the large-data cost without rebuilding all 64 scopes. Process elapsed time includes fixture preparation and reference calculations; only the recorded rebuild duration belongs in this table. Do not claim resource acceptance until the overrun and large-data cost are addressed.

### Measured invoice-line bottleneck and correction

The [isolated large-data partition](2026-09-08-stock-report-facts-partition-before.json) spent 5,992 ms in invoice-line reads versus 374 ms in fact/build inserts. The query optimizer used only `parent_item_id` from `idx_order_items_parent_invoice`, despite the sparse invoice filter. Merely seeing that index name in EXPLAIN would have missed the problem: key length was 5 and the second key part was absent.

[100 warm samples across five sparse ID ranges](2026-09-08-stock-report-line-query.json) measured p95 35.087 ms with the optimizer choice, 0.864 ms forcing the invoice-only index and 0.778 ms forcing the existing parent/invoice composite index. The last option used both key parts (length 9) and returned the same 48 line identities. The report now names that composite index. The facts migration ensures the canonical index name on older installations; the normal installation already has it. Runtime schema verification checks its exact column order.

The [same partition after the query fix](2026-09-08-stock-report-facts-partition-after.json) took 12,734 ms rather than 42,299 ms; sampled Node CPU was 374 rather than 641 ms. Its maximum work window fell from 114.26 to 82.88 ms. The current full source-reference request in that run took 3,951 ms versus 19,457 ms for the prior implementation, with exact worked cost and revenue. These are single comparisons, not p95 end-to-end or whole-device resource certification. Sampled RSS did not demonstrate a reduction.

The [complete 64-scope rerun](2026-09-08-stock-report-facts-100000-index-fix.json) reduced rebuild duration to 381.0 seconds, with exact cost and revenue, but one window still reached 105.18 ms. The worker now additionally checks its budget before every source query and rests when 50 ms is already consumed, reserving headroom for the next read and persistence. It retains the 70-ms emitted-fact trigger. A deterministic slow-source regression verifies that it yields before the next query and releases the sole connection; all six worker tests pass.

The [guarded complete rerun](2026-09-08-stock-report-facts-100000-guarded.json), at implementation commit `25878b7e`, completed all 64 scopes in 566.8 seconds with exact cost/revenue and a maximum measured window of 84.57 ms. The guard deliberately trades refresh throughput for headroom. Node CPU remains in a similar band to the earlier runs; these measurements do not demonstrate an overall memory reduction or whole-server CPU savings. This is one i7-14700KF / 28-logical-CPU / 31.84-GiB workstation run on MariaDB 10.4.32, not the required three low-end certification repetitions. The artifact records source hashes and runtime details for reproduction.

## Verification and outstanding work

Completed: financial source/reference tests; worker publication, cancellation and generation-race tests; exact predecessor, no-op and manual migration checks; manifest/schema checks; July 29 upgrade and fresh 68-table installation checks. Final cleanup/source checks pass with a one-connection pool (9 tests). Generation and generation-migration checks pass (12 tests, normal pool). Source/reference checks including the new floating-cost regression pass (17 tests). Architecture generation and validation pass with 250 nodes and 68 tables.

Still required: large-data resource remediation and remeasurement; indexed source boundaries and unusual-invoice memory tests; canonical legacy void origin; transactional source invalidation; initial/backfill coverage; scheduling; bounded published-fact API and freshness UI; barcode/attention projections; ingredient authority integration. No million-movement, 365-day, concurrent reader/writer or complete Node-plus-database resource gate has passed for this slice.
