# Release validation: schema consolidation and query changes

PR #15 covers the completed stock schema phases, measured database optimizations, performance guidance and historical/open/closed-shift expense cancellation. Further table consolidation remains deferred. Customer databases and Hostinger have not been exercised.

## Fresh installer startup

Importing the exact regenerated deployment-kit SQL exposed a missing migration ledger stamp for the held-report date index already present in the canonical baseline. The regression failed before the installer change. Bootstrap now stamps that existing index migration alongside the other baseline entries. Eleven focused installer/index checks passed; importing the exact candidate SQL and running two startup/schema validation passes also passed with no pending migrations. Original kit login seeds were preserved.

## Migration fixtures

The first complete CI run exposed two outdated fixture assumptions. The order-number migration test selected the last manifest entry, which now identifies a different migration. It selects the named numbering migration explicitly. The legacy stock-return test called the current movement writer against only the phase-1 schema; runtime checks now complete successor migrations before using current services, as server startup does. Phase-specific preservation/rejection tests still stop at their intended migration.

Both failures were reproduced locally before correction. Fifteen stock migration checks passed, including a real migration with overlapping historical ingredient/physical IDs spanning a physical report page. All 102 physical facts and their exact incoming quantity were retained. Historical ingredient rows lack physical operation links; newly attached movements use the common allocator. No report pagination behavior was changed for that review finding.

## MariaDB 11.4 refund-query regression

CI read 25,300 rows for 100 selected invoices among 4,100 orders and 201 shifts, violating the existing 2,000-row bound. An isolated, checksum-verified MariaDB 11.4.13 Windows runtime reproduced exactly 25,300 reads. `ANALYZE FORMAT=JSON` showed lateral execution of the outer invoice aggregate rebuilding the entire selected refund aggregate 100 times. Every refund lookup had an index; the problem was repeated work.

The scoped discount helper now sums refunds through the existing `refund_items(order_item_id)` lookup for each selected item. It retains the original refund-kind predicate and financial expressions. It adds no queries, settings, indexes or stored data changes. The unscoped SQL exports remain equivalent after whitespace normalization. The existing performance test keeps its original bound and also covers 500 selected invoices with the same per-invoice work allowance.

Twenty alternating measured samples per variant, after one warmup, used the same generated 4,100-order fixture and connection. Complete returned rows were equal. Session `Rows_read` measures row visits rather than unique records.

| Database | Before row visits | After row visits | Before median | After median |
| --- | ---: | ---: | ---: | ---: |
| MariaDB 11.4.13 | 25,300 | 450 | 13.392 ms | 1.318 ms |
| MariaDB 10.4.32 | 400 | 450 | 4.343 ms | 4.311 ms |

The older optimizer reads 50 additional rows in this fixture, with similar latency. These are local measurements, not customer throughput guarantees. The unchanged work bound and financial cases run in the required CI gate. Rollback for this query change is a source revert; stock-schema rollback separately requires the matching pre-upgrade database backup.

Evidence is retained in ignored scratch files: `release-installer-red.json`, `release-installer-green.json`, `release-fresh-sql.log`, `release-legacy-fixture-red.json`, `release-legacy-fixture-green.json`, `release-numbering-fixture-red.json`, `release-mariadb114-red.json`, `release-mariadb114-green.json`, `release-scoped-financial114.json`, and `release-discount-11.4.13.json` / `release-discount-10.4.32.json`. The MariaDB 11.4 runs passed 38 workflow/migration checks and 24 scoped financial checks, including partial/full refunds, discounts, zero subtotals, Orders filters/pagination and selected-row work bounds. Required GitHub Release gate completion is recorded on PR #15 before integration.

The same scoped financial workflows also passed all 22 checks on MariaDB 10.4.32 (release-scoped-financial104.json), including both 100- and 500-invoice work bounds.
