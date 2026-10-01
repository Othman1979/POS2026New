# Backend resource cuts and startup verification

Baseline: `61ab4e386fd22f1029f69a0ff57b0a05236a4645`. Implementation branch: `codex/backend-resource-cuts`.

The approved backend changes are implemented. No application database, deployed server, spooler, printer, migration SQL, or maintained deployment kit was changed. The next task is a separate **audit-only admin frontend** review.

## Changes and evidence

| Area | Implemented behavior | Regression evidence |
| --- | --- | --- |
| Catalog cache | Only the canonical 120-item register page uses the single shared cache. Invalidation generations reject publication from reads that started before a catalog write. | Real HTTP requests with different limits no longer return an incorrect 304. A paused real SQL read racing a committed rename cannot repopulate stale cache data. |
| Catalog import | XLSX loads only in a short-lived parsing worker. Parsing completes before acquiring a database connection, stock transaction, or fiscal policy lock. One import is admitted per process; upload, row, column, cell, time and worker-heap limits bound ordinary oversized inputs. | Template and legacy mapping values preserved. Real 20,000-row parse stays responsive. Invalid files acquire no stock connection. Concurrent imports return a clear 409; subsequent retries work. Existing product/import integration checks pass. |
| Import completion | Releases the database lease immediately after commit, before menu/cache/socket work; drops the uploaded buffer after parsing. | Product/import and checkout post-commit integration suites pass. Fiscal validation and catalog replacement safeguards remain transactional. |
| Production logging | Default asynchronous JSON stdout avoids a permanent transport worker. Existing `POSAPP_LOG_DIR` installations retain rotating local files. `LOG_OUTPUT=stdout` or `files` explicitly overrides the default. | All 10,001 synthetic records and their order/error payloads preserved in each comparison. Unit subprocess checks cover immediate explicit exit, invalid configuration, and retained file logging. |
| Migration ledger | One ledger read for all current/predecessor entries while holding the existing migration lock. Freshly applied migrations still verify their recorded checksum. | Current schema uses 3 total queries instead of 98. Manifest hash, predecessor, missing ledger, conflict, upgrade and repeatable-reconciliation checks pass. |
| Schema validation | Reads each required metadata source once, then runs the original validation SQL predicates against bound, statement-local CTE snapshots. | Exact maintained fresh SQL passes twice. Old upgrade/failure integration passes. Both baseline and current validators reject a deliberately removed `stock_operations` request-uniqueness index. No integrity check is skipped or persistently cached. |
| Idle stock reports | Completed coverage and balance backfills no longer repeat on each idle tick. A read probe detects incomplete coverage or missing balances; enable/restart resets discovery. | Six idle ticks perform one coverage/backfill pass rather than six. Real DB test initializes a newly inserted ingredient and repairs a deleted balance on the next poll. Existing 500 ms active / 10 s idle cadence, source-pressure yielding and shutdown behavior remain. |

The import admission limit is per Node process. Cross-process mutation safety still comes from the original database transaction/locks. Worker heap limits do not constitute a hard cap on total process/native-buffer memory.

## Measurements

Local Windows, Node `v24.16.0`, same checkout dependencies and local MariaDB. These are **not Hostinger measurements or a prediction for its 160–170 MB process**. Independent tests were stopped during the resource samples.

### Startup

`node scripts/reviews/schema-query-experiment.cjs 61ab4e38 "C:/Users/bash/Documents/New folder/fresh-database.sql"`

| Check | Baseline | Current |
| --- | --- | --- |
| No-op migration queries, including lock/unlock | 98 | 3 |
| No-op migration elapsed | 14.48 ms | 3.30–4.94 ms |
| Schema validation elapsed | 43.30 s | 3.14 / 4.21 / 3.18 s |
| Schema validation queries | 3 | 10 |

The schema improvement is about 90–93% in this experiment despite more client queries: seven metadata reads replace repeated expensive `information_schema` evaluation inside the original large statement. Baseline had one timed run; current had three. This measures migration/validation calls, not deployment upload, cold database boot, pending DDL execution, or complete browser readiness. Splitting the original query into arbitrary chunks gave inconsistent/slower results and was rejected.

### Logging and imports

`node scripts/reviews/backend-resource-experiment.cjs 61ab4e38`

Three alternating baseline/current subprocess comparisons per workload; identical 20,000-row workbook and identical log records. Import output SHA-256 matched across all six samples.

| Measurement | Baseline | Current |
| --- | --- | --- |
| Idle logger subprocess RSS | 78.79–79.23 MiB | 53.30–53.55 MiB |
| CPU for 10,001 log records, including flush window | 109–218 ms | 47–63 ms |
| Idle parser subprocess RSS | 69.22–69.97 MiB | 50.38–50.50 MiB |
| Idle parser main-isolate heap | 16.99 MiB | 4.83 MiB |
| 20,000-row parse elapsed | 205–215 ms | 308–310 ms |
| Main-thread maximum timer gap during parse | 209–219 ms | 17–20 ms |
| CPU during parse | 313–360 ms | 374–469 ms |
| Settled RSS after parse and forced GC | 111.19–112.01 MiB | 88.91–90.61 MiB |

**Tradeoff:** a worker reloads the parser and transfers rows, so each import's parsing stage uses more elapsed time/CPU. It protects concurrent checkout/request responsiveness, shortens fiscal-lock occupancy, and avoids retaining the parser when idle. It is not an import-throughput improvement. Returned rows and allocator pages still consume memory; worker exit does not return all RSS immediately. The logger and parser RSS differences cannot simply be added to forecast total server savings. Main-isolate heap excludes worker heaps; peak RSS is recorded in raw evidence but is not used to claim a device-wide peak-memory saving.

## Verification

- `npm run test:isolated -- catalogCache bundle.catalog`: 28 passed; catalog race later strengthened and rerun below.
- `npm run test:isolated -- catalogWorkbook products.test`: 39 passed.
- `npm run test:isolated -- backend/tests/unit/automaticMigrations.test.js`: 47 unit cases passed; the integration file was also run separately below.
- `npm run test:isolated -- backend/tests/integration/automaticMigrations.test.js schemaAuthority stockReportWorkerRunner`: 123 passed at that point (12 migration integration, 105 schema, 6 worker lifecycle).
- `npm run test:isolated -- catalogCache catalogImportIsolation catalogWorkbook productionLogger stockReportIdle stockReportWorkerRunner checkoutPostCommit inventoryOptionalModes products.test`: 62 passed after worker restart and import cleanup changes (worker lifecycle now 7).
- `npm run test:isolated -- productionLogger`: 3 passed after adding explicit-local-log compatibility.
- `npm run test:isolated -- backend/tests/integration/stockReportWorker.test.js backend/tests/integration/stockReportGenerations.test.js`: 15 passed, covering real rebuild/publication and generation behavior.
- `node scripts/reviews/fresh-pos-baseline.cjs "C:/Users/bash/Documents/New folder/fresh-database.sql"`: exact fresh import, two startup passes, no pending migrations, no retired procurement tables, no business data.
- Both reproducible comparison scripts passed their output-equivalence / integrity-rejection assertions.
- `npm run architecture` and `npm run architecture:check`: passed.

Six obsolete schema unit expectations still required retired procurement objects. They were removed to match the already-shipped baseline and validator; retained stock integrity expectations remain. RED experiments reproduced the wrong catalog 304, stale cache publication, repeated idle backfill, and 96 individual ledger reads before their fixes.

The focused checks support these paths; they do not certify a bug-free application. Full production memory/load measurements and actual Hostinger restart timing remain deployment observations, not claimed local results. No further backend blocker was identified within this scope.
