# Database performance audit — 12 September 2026

Status: measured audit; application changes are **not** implemented. Four Luna audit agents covered checkout/held mutations, reports, operational reads/subscriptions, and background work. The lead reviewer inspected their source claims and harnesses, corrected measurement defects, and executed the database workloads serially.

## Scope and measurement limits

- Source revision: `af382ebe86f5ba3f904fb95c0c315f8753b212b3`, branch `codex/schema-consolidation-audit`. Application source, schema, indexes, runtime configuration and existing untracked work were preserved.
- Every database workload used a newly created, generated `posapp_review_recipe_p1_<12hex>` database on loopback, with the repository's test preload and allowlist guards. Creation refused existing databases; cleanup was restricted to databases successfully created by that harness. No customer or Hostinger database was exercised.
- Host: Intel i7-14700KF, 28 logical CPUs, approximately 32 GiB RAM; Node 24.16.0; **MariaDB 10.4.32**. This is not a MySQL 8 or low-end-PC benchmark. InnoDB buffer pool was only **16 MiB**, query cache off, isolation REPEATABLE READ, Performance Schema off. Settings were measured, not changed. Local disk/cache and the small buffer pool affect absolute times.
- Samples use real SQL or real services/routes. Session `Rows_read` measures row visits, including repeated visits, rather than unique stored records. `ANALYZE FORMAT=JSON` supplies actual plan loops/rows; EXPLAIN estimates are not presented as measurements. Global accumulated wait counters were not attributed to this task. Method reference: [MariaDB ANALYZE FORMAT JSON](https://mariadb.com/docs/server/reference/sql-statements/administrative-sql-statements/analyze-and-explain-statements/analyze-format-json).
- Reports use 20 samples after 3 warmups. The expensive second discount baseline uses 3 samples after 1 warmup, backed by the earlier 20 full-X samples. Checkout/held/splits use 25 samples after 5 warmups. Background query variants use 24 samples after 3 warmups. Authentication uses 30 bursts of 20 concurrent calls per variant.
- Operational routes use 20 warmups, 30 counter samples and a separate 30-sample pass without status probes for latency. Connection counters are measured across disjoint per-connection windows and drained between requests. SQL/route traces remain lightly instrumented even in the no-probe pass.
- Report service timings exclude HTTP/auth and physical printing; they use one pinned connection. Held/split timings include loopback HTTP and small instrumentation overhead. No printer, JoFotara request, customer deployment, browser-render benchmark or persistent worker was started.
- Scratch alternatives and indexes exist only in disposable fixtures. Equal fixture results establish a promising direction, not complete migration, concurrency, or financial acceptance coverage.

## Confirmed priorities

### 1. Shift discount aggregation repeatedly scans historical refund items

Evidence: [shiftMetrics.js](C:/xampp/htdocs/posapp/backend/services/shiftMetrics.js:7), [financialSql.js](C:/xampp/htdocs/posapp/backend/services/financialSql.js:188).

Fixture: 40,000 orders/items, 10,000 refunds/refund items, 600 closed shifts, 500 orders in the selected shift. The first full X payload took **9,554.609 ms median / 10,433.070 ms p95**, 8 queries and **10,002,504 Rows_read**.

The actual plan for its discount query lateral-materializes the derived aggregate 500 times. Each iteration scans 10,000 refund items and looks up the matching refunds: roughly 5 million refund-item visits plus 5 million refund lookups. The relevant ANALYZE execution took 9,242.7 ms; this is a separate plan execution, not the median's exact component timing.

A scratch query restricted both order-item and refund-item aggregates to invoices in the requested shift, keeping the existing financial expressions. With fixed/percentage order discounts, percentage line discounts, and a partial line refund added:

| Discount query | Samples | Median / p95 ms | Rows_read | Result |
|---|---:|---:|---:|---|
| Current | 3 | 8,913.976 / 9,617.285 | 10,001,000 | Order discounts 3.00; line discounts 4.25 |
| Shift-scoped aggregate | 20 | 18.612 / 19.954 | 2,000 | Identical |

**Recommendation:** prioritize limiting the aggregate's input rows to the selected invoices/shift. Preserve the shared discount/refund definitions. This is the largest reproduced problem. The 18.612 ms figure is the discount query only, not a newly measured complete X payload. Z uses the shared payload builder, but a separate Z timing was not collected. Before implementation acceptance, cover multiple shifts, date ranges, zero/fully refunded lines, bundle/service-charge cases, and the deployment engine's optimizer.

### 2. Admin Orders statistics cannot use date indexes effectively

Evidence: [admin/orders.js](C:/xampp/htdocs/posapp/backend/routes/admin/orders.js:133), [financialSql.js](C:/xampp/htdocs/posapp/backend/services/financialSql.js:310).

The date predicate wraps timestamps in payment-dependent `CASE`/`COALESCE`. For a 500-order day in 40,000 orders, the query reads all 40,000 orders and 10,000 refund rows.

| Statistics query | Median / p95 ms | Rows_read |
|---|---:|---:|
| First baseline | 23.862 / 25.690 | 50,000 |
| First scoped-refund CTE proposal | 36.237 / 39.198 | 60,000 |
| Second baseline with date/discount edge cases | 24.297 / 30.512 | 50,000 |
| Disjoint indexable date branches + scoped refunds | 6.185 / 7.245 | 2,121 |

The first proposal was **rejected**: equal output, worse execution. The successful scratch candidate separates paid orders with issued timestamps, paid orders falling back to creation time, and non-paid orders using creation time. Branches are disjoint and retain original totals/refund semantics. Compared output also matched for null issued timestamps, unpaid/voided rows and differing creation/issue dates.

**Recommendation:** make the actual business-time predicate indexable, then limit refund work to the resulting invoices. These measurements cover the statistics query, not the complete Orders endpoint or paginated detail query. Extra filters and all business-time boundary cases need acceptance coverage before shipping.

### 3. Y report selection lacks a useful creation-date access path

Evidence: [yHeldItemsReportBuilder.js](C:/xampp/htdocs/posapp/backend/services/yHeldItemsReportBuilder.js).

Stress fixture: 30,000 outstanding held rows, only 10 on the selected day. Current selection scans the backlog and evaluates the JSON order-type predicate. A disposable-fixture index on `(created_at, id)` allows date narrowing first and preserves result ordering.

| Y selection query | Median / p95 ms | Rows_read | Returned |
|---|---:|---:|---:|
| Current indexes | 32.818 / 35.237 | 30,011 | 10 |
| Scratch creation-date index | 0.430 / 0.587 | 11 | Same 10 complete rows |

The complete original Y payload took 34.267 ms median, 7 queries, 30,017 row visits. The index comparison times only the selection query. Backlog size is deliberate stress, not a measured customer distribution.

**Recommendation:** consider a narrow date index after checking deployment plans and write overhead. No payload truncation or report content change is required for this candidate.

## Repeated calls and transaction work

### Observed lock waits, with a deliberately blocked row

Twenty samples used a separate connection holding `held_orders.PRIMARY`, a real claim request against that row, and a simultaneous claim against another row. The observer read `INNODB_LOCK_WAITS`, `INNODB_TRX` and `INNODB_LOCKS`, filtering by the known blocker connection and exact generated database/table. Every sample observed a record lock wait, completed both claims with the expected version, and found no lingering blocker/request transaction after release. The unrelated-row claim completed before release. Blocked requests measured **363.059 ms median / 375.089 p95**; unrelated-row controls measured **5.979 / 6.885 ms**.

The blocker was retained for 200 ms **after observation**, with 150 ms observer polling, so total blocked request latency includes detection and instrumentation time. The original 5 ms polling harness failed to observe the wait; its sampling was corrected and the successful 20-sample run replaced that failed diagnostic. These are engineered waits proving lock scope/recovery, not normal production wait percentiles or a multi-terminal deadlock stress test. Existing protective locks must remain.

### Held-order claims and edits

Evidence: [HeldOrderLifecycleService.js](C:/xampp/htdocs/posapp/backend/services/HeldOrderLifecycleService.js:74), [pos/orders.js](C:/xampp/htdocs/posapp/backend/routes/pos/orders.js:494).

Across 1/10/40-line carts, claim consistently uses **10 SQL calls** and patch **9**, including two `FOR UPDATE` reads of the held row in each path. Claim median HTTP time was 3.085/3.371/3.897 ms; patch 3.230/3.353/3.945 ms. Maximum recorded patch time was 12.915 ms. Product reads remain batched; increasing line count did not create a query-per-line pattern.

Reusing an already locked row could remove a round trip, but route/lifecycle validation, current canonical cart data, version checks and replay behavior must remain intact. The claim deliberately advances both the lease and canonical-cart versions; a harness expecting one increment was corrected. This is a lower-priority opportunity, not evidence of a slow held-order endpoint on this host.

### Table split creation

Evidence: [splitChecks.js](C:/xampp/htdocs/posapp/backend/modules/tables/splitChecks.js:960), [auditEvents.js](C:/xampp/htdocs/posapp/backend/services/auditEvents.js:123).

Same eight-line source, varied seat count:

| Seats | SQL calls | Median HTTP ms | Median transaction ms | Rows_read |
|---:|---:|---:|---:|---:|
| 1 | 13 | 6.047 | 3.975 | 87 |
| 4 | 22 | 8.276 | 5.943 | 120 |
| 8 | 34 | 10.052 | 7.747 | 154 |

Query growth includes one held-row insert, audit insert and audit-disable lookup per seat. The eight-seat trace repeats the same audit-disable lookup nine times. Per-seat records are necessary; repeatedly resolving the same actor flag within one transaction is a candidate for reuse. There was no extra per-seat `FOR UPDATE` growth: three locking reads stayed constant. Batching must preserve created-ID mappings, audit entries, event behavior and atomicity.

### Authentication bursts

Evidence: [auth.js](C:/xampp/htdocs/posapp/backend/middleware/auth.js:139).

Thirty 20-request bursts against the same token:

| Token-cache state | Current SQL calls/burst | Scratch coalescing | Current median / p95 ms | Coalesced median / p95 ms |
|---|---:|---:|---:|---:|
| Cold | 40 | 2 | 1.912 / 3.927 | 0.529 / 1.439 |
| Warm | 0 | 0 | 0.028 / 0.037 | 0.008 / 0.015 |
| Activity refresh due | 20 | 1 | 1.954 / 2.397 | 0.272 / 0.360 |

The cache already prevents normal repeated authorization SQL. Concurrent cold misses and activity refreshes can stampede. A per-token in-flight operation is a possible small throughput improvement; the scratch wrapper does not establish safe revocation/invalidation behavior. This measures the verifier, not whole HTTP requests. Absolute local savings are small.

### Daily Summary and Shifts listing

- Daily Summary: **84.435 ms median / 87.113 p95**, 23 queries, 128,076 row visits. Current and comparison periods serve different purposes and are not inherently redundant. One exact subscription-collection aggregate with the same dates appears twice in the captured call. Reusing that result is a bounded candidate; its speedup was not measured, and the report fixture has no large subscription history.
- Shifts count + page SQL: **27.227 / 29.082 ms**, 2 queries, 81,451 row visits. Both repeat broad order-event checks. The actual plan does **not** establish a 40,000-row scan once per shift; it materializes the event relation. A batch of relevant shift IDs is worth investigating, but no improved equivalent query was measured. Follow-on per-shift metrics were outside this two-query benchmark.
- Platform provider list: 42.394 ms median, 2 queries with one provider. Receivables: 37.481 ms, 1 query. Remittances: 3.508 ms, 3 queries. A source-level per-provider loop exists, but one provider cannot establish multi-provider scaling. No measured N+1 conclusion is claimed.

## Optimizer statistics

### Admin Subscriptions: avoid diagnosing every bad plan as bad SQL

Admin Subscriptions is a useful counterexample. With 500 synthetic subscriptions and 250 redemption rows, the first 50-row page took **212.013 ms median / 220.137 p95**, with **501,669 row visits** and one SQL call. A subsequent valid actual plan showed two correlated redemption expressions, each doing 125,000 redemption primary-key lookups.

Refreshing table statistics in a new equivalent fixture, using the **same SQL and existing indexes**, reduced this to **12.178 ms median / 13.521 p95** and **2,669 row visits**. The plan then used `idx_subscription_redemption_items_redemption` for 250 lookups per expression. This is a **statistics-sensitive optimizer plan**, not proof that the application needs a rewrite. The deployed database's actual statistics and plan should be inspected before choosing any change. No production statistics maintenance was performed or scheduled. The report baselines and successful X/Orders candidates already used refreshed fixture statistics.

The main operational baseline's plan collector initially omitted SQL parameter bindings; those failed ANALYZE entries cannot support plan claims. Its timings and disjoint connection counters remain usable. The `large-plans.json` and `large-stats.json` follow-ups have valid bindings and actual plans for the subscription finding.

## Operational reads and payload size

These are real loopback HTTP reads with warm authorization. Small fixture: 120 generated products, 36 tables, 30 register holds, 10 split holds, 20 plans/subscriptions. Large fixture: 3,000 generated products, 600 tables, 1,000 register holds, 300 split holds, 500 plans/subscriptions; base seed rows are additional. The 500 subscriptions belong to one synthetic customer, which is a stress case, not a typical customer history.

| Read | Small median ms | Large median / p95 ms | Large SQL calls | Large Rows_read | Large uncompressed JSON bytes |
|---|---:|---:|---:|---:|---:|
| Cached root catalog | 0.598 | 0.964 / 1.118 | 0 | 0 | 12,414 |
| Uncached root catalog | 3.020 | 7.896 / 10.667 | 7 | 6,698 | 12,414 |
| Floor | 2.814 | 9.306 / 26.399 | 5 | 1,276 | 331,901 |
| Register held board | 2.171 | 30.902 / 41.285 | 1 | 2,001 | 1,583,346 |
| Held count summary | 1.134 | 1.392 / 1.601 | 1 | 1,000 | 45 |
| Split board | 1.869 | 10.704 / 18.628 | 2 | 1,602 | 496,587 |
| Customer subscriptions | 3.662 | 27.682 / 44.406 | 4 | 4,588 | 590,165 |
| POS subscription plans | 1.897 | 3.801 / 4.483 | 1 | 1,000 | 122,329 |

- [Held list](C:/xampp/htdocs/posapp/backend/routes/pos/orders.js:319) and [split list](C:/xampp/htdocs/posapp/backend/routes/pos/tables.js:742) construct and return every matching presentation. Measured query counts remain bounded; the growth is response/processing size, not N+1. A compact list representation with detail on demand, or an explicit bounded history contract, is worth assessing. It must retain access to older active work; silently dropping rows is not an acceptable performance fix. No alternative response contract or browser rendering gain was measured.
- [Floor read](C:/xampp/htdocs/posapp/backend/routes/pos/tables.js:139) has correlated split counts/totals, but 600-table latency and reads did not establish a serious query bottleneck here. Do not replace correct floor behavior merely because the SQL contains subqueries.
- [Catalog](C:/xampp/htdocs/posapp/backend/routes/pos/catalog.js:112) full no-match search uses 5 queries / 10,682 row visits / 14.266 ms median in the large fixture; lightweight no-match search uses 2 / 7,010 / 11.768 ms. **The current frontend already uses lightweight reads after metadata loads**, so redundant metadata is not an unconditional normal-search defect.
- A corrected positive barcode control found the intended sellable product with 2 queries, 4 row visits and 1.439 ms median in the large fixture. The matching lightweight text-search route found the same product with 3 queries, 7,014 row visits and 13.720 ms. Contains-search scans across name/barcode/SKU remain a candidate if real catalog sizes and typing frequency justify it; exact barcode lookup is already indexed. Do not change substring-search behavior without an explicit product decision.
- [Customer subscriptions](C:/xampp/htdocs/posapp/backend/services/SubscriptionService.js:237) return the customer's full history, with batched supporting reads. This is a conditional payload/history-sizing opportunity. Admin subscription detail used 9 queries but only 267 row visits and 4.236 ms median in the large fixture; query count alone does not justify rewriting it.

The baseline barcode fixture used an invalid object-property lookup, so its empty-result timing was discarded. `small-controls.json` and `large-controls.json` contain the corrected positive assertions. Baseline `response_rows=0` for object-shaped catalog/floor/detail responses is a collector limitation, not an empty application response; byte sizes and SQL counters remain valid, and the later collector distinguishes these shapes.

## Background source and queue detail

### Stock report source hashing

Evidence: [IngredientAnalysisService.js](C:/xampp/htdocs/posapp/backend/services/IngredientAnalysisService.js:69), [StockReportFactService.js](C:/xampp/htdocs/posapp/backend/services/StockReportFactService.js:80).

Heavy-day fixture: 20,000 invoices and ingredient movements. With refreshed statistics, for one hash scope a 16-invoice batch takes **1.687 ms median**, reading **514 rows**; a 100-movement batch takes **6.509 ms**, reading **2,947 rows**. Before explicit statistics refresh, those medians were 2.126 / 10.716 ms with the same row visits. Hash filtering rejects most otherwise date-matching rows. A real one-scope stream executes 89 queries for 619 invoices and 619 movements in 193.299 ms; this is not a timed full 32-scope day build.

The explicit-ID diagnostic returns the same IDs with 16/100 row visits, but it is given precomputed IDs outside its timed region. It therefore shows an access-cost lower bound, **not a ready replacement**. Measuring a stable indexed scope key including its write/invalidation cost would be necessary before recommending it. Worker batching, pressure checks and idle backoff already exist; expanding batches or parallelism blindly could hurt checkout responsiveness.

### Spooler retry backlog

Evidence: [spoolerSync.js](C:/xampp/htdocs/posapp/backend/services/spoolerSync.js:244).

Stress fixture: 20,000 failed jobs, 19,980 with future retry times and only the last 20 due. Claim limit 10; all variants returned identical job IDs and used rollback around locking samples.

| Claim strategy | Median / p95 ms | Rows_read |
|---|---:|---:|
| Current indexes | 65.647 / 67.844 | 20,001 |
| Added scratch index, optimizer chooses freely | 34.536 / 35.885 | 19,991 |
| Same index forced for diagnosis | 21.593 / 23.232 | 21 |

A second run refreshed table statistics before both variants: existing indexes took **34.030 ms / 19,991 row visits**; adding the index without a hint took **33.006 ms / 19,991**; forcing it took **21.205 ms / 21**. Therefore the apparent unhinted 65-to-34 ms gain above is not sufficient evidence of an index benefit: statistics alone produced essentially that gain.

The diagnostic index is `(printer_id, agent_id, status, next_retry_at, id)`. Adding it alone did not produce the low-read plan. This is a conditional backlog finding, not a blanket recommendation to add or force the index. A real follow-up must compare healthy/pending/mixed queues, multiple printers and concurrent claims while preserving FIFO, ownership, replay and retry rules. A real service smoke call returned one job; no physical printer received it.

### Existing controls that should remain

- Stock worker uses 500 ms pending / 10 s idle scheduling, pressure checks and in-flight coalescing.
- Spooler V2 has bounded capacity, owned-job replay and wakeable long polling; there is no measured justification to remove these controls or make polling more frequent.
- Pool runtime performs quiet probes only after inactivity and avoids probing an active lease. The refreshed-statistics background harness balanced 187 acquires/releases, zero enqueues/errors and zero leases left in use. This is bounded execution evidence, not a multi-hour leak test.

## Evidence and reproducibility

Generated harnesses and full SQL/plans/samples live under ignored [scratch/db-performance-audit](C:/xampp/htdocs/posapp/scratch/db-performance-audit):

- [Environment](C:/xampp/htdocs/posapp/scratch/db-performance-audit/environment.json)
- [Reports baseline](C:/xampp/htdocs/posapp/scratch/db-performance-audit/reports/admin-reports-db-performance.json), [candidate results](C:/xampp/htdocs/posapp/scratch/db-performance-audit/reports/query-candidates.json), [candidate harness](C:/xampp/htdocs/posapp/scratch/db-performance-audit/reports/verify-query-candidates.cjs)
- [Held/split results](C:/xampp/htdocs/posapp/scratch/db-performance-audit/checkout/results.json)
- [Observed lock waits](C:/xampp/htdocs/posapp/scratch/db-performance-audit/checkout/lock-wait-results.json)
- [Small operational fixture](C:/xampp/htdocs/posapp/scratch/db-performance-audit/operations/small.json), [large fixture](C:/xampp/htdocs/posapp/scratch/db-performance-audit/operations/large.json), [valid subscription plan baseline](C:/xampp/htdocs/posapp/scratch/db-performance-audit/operations/large-plans.json), [statistics control](C:/xampp/htdocs/posapp/scratch/db-performance-audit/operations/large-stats.json), [positive lookup/search controls](C:/xampp/htdocs/posapp/scratch/db-performance-audit/operations/large-controls.json)
- [Authentication bursts](C:/xampp/htdocs/posapp/scratch/db-performance-audit/auth-burst.json)
- [Background results](C:/xampp/htdocs/posapp/scratch/db-performance-audit/background/background-audit-results.json)
- [Verification and artifact hashes](C:/xampp/htdocs/posapp/scratch/db-performance-audit/verification.json)

Run harnesses serially from the repository root. Each owns and removes its generated loopback database; do not retarget them at a deployed database. Baseline harness snapshots are retained where the lead reviewer later extended a harness. Setup and instrumentation failures were corrected before accepting a run; failed assertions were not treated as application findings.

Verification checked 15 application source hashes against the measured runs: all matched. Git's tracked diff is empty. The new audit document is the only added non-ignored artifact from this task; the earlier untracked document was preserved. All 15 generated database names found in the retained evidence had no remaining schema or connection. No integration, deployment or customer write was performed.

## Recommended order and remaining coverage

1. Shift discount scoping: the strongest measured latency and row-visit win, including nonzero financial result checks.
2. Admin Orders business-date predicates and Y selection indexing: concrete, measured candidates with unchanged selected results.
3. Inspect actual deployed statistics/plans before rewriting Subscriptions or changing print-queue indexes. Then assess large held/split/customer-history payloads against real customer sizes.
4. Treat repeated actor/auth lookups and background hash filtering as later, bounded work. Their benefit and concurrency implications differ from the urgent report aggregate.

This audit does not establish production wait frequency, a low-end-PC speedup, network round-trip costs, multi-server cache coherence, or an absence of deadlocks/leaks. Ordinary paid checkout, refunds, stock-enabled checkout and physical movement writer contention were inspected as source boundaries rather than benchmarked end to end here. No change is claimed release-ready merely because a scratch comparison matched; production implementation would need focused regression coverage for its actual money, replay, permission, inventory and printing boundaries.
