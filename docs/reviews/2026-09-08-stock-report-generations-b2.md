# B2 foundation: report generations and publication leases

The report publication metadata is implemented. **Source-writer integration, typed facts, chunked rebuilding, retention cleanup, report API replacement and UI freshness are not implemented by this slice.** It does not complete package B or reduce the cost of existing report requests yet.

## Implemented contract

`StockReportGenerationService` records at most 64 deduplicated, sorted day/scope keys in one statement, using 32 deterministic source partitions. Invoice-based reversals must pass the original invoice identity; non-invoice operations use their operation identity. The caller must collect all affected scopes and mark them at the end of its source transaction, after stock locks. Rollback rolls back the marker. There is no in-memory notification standing in for a committed marker.

Three additive tables store dirty scopes, build identities and a singleton installation worker lease. Claims serialize through that lease and select the oldest pending scope. A worker crash expires after 60 seconds; its successor gets a different build ID. Renewals stop when the generation changes. Generation and build IDs remain exact strings, including values above JavaScript's safe-integer range.

Publication switches the visible build pointer only if the dirty generation, active build, lease owner and unexpired lease still match. The previous publication remains readable during staging and after a rejected build. A transaction failure midway through publication rolls back the pointer and build state together. Later source commits mark the published result stale, including a lower auto-increment ID committing after a higher one. No maximum-ID checkpoint is used.

Every metadata transaction releases its one connection before returning; no connection is retained during a worker's future yield. An idle claim performs one indexed read and creates no lease row or write transaction. These lifecycle methods are internal and have no public arbitrary-publication endpoint.

## Evidence

- Behavioral RED initially failed because the generation service did not exist.
- Nine generation integration tests cover stale/complete publication, source rollback, out-of-order commits, installation-wide concurrency, expired-owner fencing, failed-publication rollback/retry, superseded renewal, explicit abandonment, exact large IDs and connection release. Source identity validation additionally rejects unsafe numeric IDs.
- Three migration checks cover exact-predecessor upgrade, preserved stock/published metadata, no-op rerun, a falsely current ledger with missing worker table, and missing/conflicting predecessor evidence.
- Historical July 29 upgrade/repair and fresh installer passed (2 tests, 113.55 seconds). The fresh baseline now has 64 tables. Only scratch databases were changed.
- 140 focused generation/manifest/schema checks passed; 99 generation/date/schema checks passed after the final exact-source-ID assertion and required-column-name tightening. These overlapping suites are not added into a misleading unique test count.
- The exact-predecessor upgrade/no-op test then passed with the final full runtime schema validator (50.40 seconds). Architecture generation/check passed with 247 nodes and 70 flows; the existing single architecture defect is unchanged.

## Write overhead experiment

[Raw before/after measurements](2026-09-08-stock-report-generation-performance.json) come from `scripts/reviews/stock-report-generation-performance.cjs`. Each variant has 1,000 committed synthetic source transactions, three alternating rounds, and one or ten concurrent clients. The baseline inserts a stock operation; the variant also dirties its invoice partition. Latency starts after pool acquisition. This is not real checkout, does not rebuild facts, and excludes database CPU/memory.

After reusing the existing date-only validator instead of calculating an unused complete business-date range:

| Workload | Baseline p95 ms, rounds 1/2/3 | With marker p95 ms, rounds 1/2/3 |
| --- | --- | --- |
| One writer | 0.968 / 1.049 / 1.034 | 1.228 / 1.327 / 1.269 |
| Ten writers, 32 partitions | 1.999 / 3.218 / 2.719 | 2.175 / 3.773 / 4.641 |

One-writer p95 overhead is 0.24–0.28 ms. Ten-writer results are more variable and throughput is lower with markers; these are costs, not performance wins. A separate single-hot-partition run reached 3.239 ms p95. The date-only change removes unnecessary work, but the SQL benchmark does not establish a consistent single-writer speedup from that small change. No memory saving is claimed.

## Remaining integration requirements

Before enabling projected reports, enumerate and wire all invoice/refund, ingredient, stock, price-correction, reset/import and old-date writers. Add typed staging facts, indexed bounded source traversal and a worker with the prescribed 200-invoice/500-fact and 100-ms/500-ms duty limits. Only that worker may call publication after all chunks commit. Cleanup must remove obsolete/abandoned staging in bounded chunks while preserving published pointers. Missing initial generations must be labelled unavailable/rebuilding rather than treated as clean zero totals. Then reconcile with the current reference analysis, replace bounded report APIs/UI, and measure the full A+B workload on the specified fixture and resource limits.
