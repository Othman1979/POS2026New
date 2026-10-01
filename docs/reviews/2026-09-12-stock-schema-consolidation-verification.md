# Stock schema consolidation: phases 1 and 2

This is the historical phase 1/2 result. The subsequent movement-ledger consolidation is recorded in [the phase 3 verification report](2026-09-12-unified-stock-movements-verification.md).

Scope: `codex/schema-consolidation-audit`, starting from `2cba888fce4476117052a1ce50016a2ebf40ac3b`. Only the two approved schema consolidations were implemented. Ingredient and physical movement ledgers remain separate. No application/customer database was migrated, and no deployment, push or PR was performed.

## Result

The fresh baseline has **76 tables instead of 80**. Exactly these four tables were removed:

| Removed table | Replacement |
| --- | --- |
| `stock_locations` | No active warehouse dimension; original IDs remain on historical balances/movements |
| `stock_lots` | One physical balance per stock item; original IDs remain historical provenance |
| `stock_ingredient_links` | Nullable activation/link fields on `ingredients`, with item/request uniqueness and foreign keys |
| `ingredient_working_balances` | Working quantity, known/unknown state, count boundary, usage, variance and initialization fields on `ingredients` |

This is not a movement-ledger merge. Existing receipts, stock operations, movements, ingredient movements, sale snapshots, actor/source data and operation results are retained. The ten retired purchasing tables on some older installations are outside this change and remain there; 76 is the fresh-install count, not a promise about every upgraded installation.

## Behavior and migration review

- Stock posting locks items and balances in sorted item order. New snapshots are version 3 item compositions. Version 1/2 snapshots remain readable; version 2 returns validate their original retained warehouse IDs and restore original stock after product remapping.
- Posting keeps strict/estimate availability, observed-count versions, source transactions, atomic rollback and durable replay. A saved old internal operation can replay without reposting stock or rewriting its response.
- Phase 1 rejects restricted, expired or non-default lots, traceability requirements, non-default/inactive balance locations, and multiple balances per item before destructive DDL. It does not guess how to combine unsupported warehouse data.
- Populated archived purchasing receipt lines retain their original location/lot descriptions in `legacy_stock_identity` before the parent tables disappear.
- Phase 2 rejects orphan ingredient-side rows before schema changes, copies both sources, compares every copied field using null-safe equality, and removes the sources only after validation and constraints succeed.
- Original activation quantities are distinct from current working balances. Decimal precision, known zero, unknown and uninitialized states, watermarks, count IDs, request identity and activation timestamps survive migration. Activation text retains its original collation.
- Stock updates leave catalog `updated_at` unchanged. Catalog API shapes remain unchanged; the picker does not expose the new internal fields.
- Interrupted migrations resume after the first table drop. Reapplying the completed ingredient migration cannot overwrite subsequent working-balance changes from removed source tables.
- Both migrations have matching evidence/automatic SQL, consecutive manifest predecessors, verified normalized hashes and exact manual-fallback blocks. Fresh bootstrap includes their ledger stamps. Startup validates the new columns, keys, foreign keys and absence of retired tables.

## Verification

All database writes used generated allowlisted loopback fixtures. Historical automatic-migration tests also use their existing explicitly named disposable migration database. Tests were run serially; performance measurements ran separately.

Taking the latest result for each test file across the runs below, **456 distinct tests in 50 files passed, with none failed or pending**. This is evidence for the exercised cases, not a 100% correctness guarantee. The final two-test ingredient check also verifies that stock writes preserve the catalog timestamp (`scratch/ingredient-state-timestamp-final.json`).

| Check | Evidence |
| --- | --- |
| Tests before production edits | Phase 1: item-only posting and version 3 snapshots failed. Phase 2: merged working fields and retired side-table assertions failed. `scratch/stock-consolidation-red.json`, `scratch/ingredient-state-red.json` |
| Main workflows | 64 passed: checkout, partial refunds, table/shared compositions, simultaneous sales, activation replay, pause/resume, ingredient receiving, 100-line counts, background initialization and fresh installation. `scratch/ingredient-state-flows.json` |
| Final regression | 156 passed across 18 files: automatic migration chain, stock reads, report publication, optional modes, costs, source transactions, fresh schema and consolidation behavior. `scratch/stock-consolidation-final-regression.json` |
| Operational follow-up | 97 passed across 16 files: held recipes, ingredient activation/orders, table splits/merges, reversals, admin/report flows, published counts, report generations and strengthened migration uniqueness. `scratch/stock-consolidation-operational.json` |
| Populated upgrades | Original-stock returns, archived receipts, incompatible warehouse rejection, interruption recovery, exact large decimals, original timestamps, orphan rejection and uniqueness. `stockIdentityMigration.test.js`, `ingredientStateMigration.test.js` |
| Schema authority | Required identity/state indexes, checks and migration checksum; historical migration upgrade checks and installer baseline tests. `scratch/stock-consolidation-upgrades.json` |
| English desktop / Arabic mobile | Real built UI, receiving, picker continuation/search, waste picker, stock disable and recipe removal. Quantities 100 → 102 → 104 verified in MySQL; no page errors. `scratch/stock-working-list-browser.json`, `scratch/stock-consolidation-browser.log` |
| Large report browser flow | 105 distinct meals, continuation, last-meal search and real movement drilldown in English desktop and Arabic mobile, with no page errors. `scratch/stock-consolidation-report-browser.log` |
| Static artifacts | 76 baseline tables, 2 exact migration/fallback pairs, valid hashes/predecessors; changed/new JS parsed. `scratch/stock-consolidation-artifacts.log` |
| Build / architecture | Admin production build, generated architecture map and architecture check passed. `scratch/stock-consolidation-admin-build.log`, `scratch/stock-consolidation-architecture-check.log` |

An earlier upgrade batch was interrupted because a missing **test constant** caused its migration test to hang. The constant and expected ledger order were corrected; the complete automatic-migration file subsequently passed in the final regression run. The interrupted batch is not presented as a clean suite pass. No interrupted-run result is the sole evidence for that migration chain.

## Performance experiment

`scripts/reviews/stock-schema-consolidation-performance.cjs` compares the original commit and current implementation on their matching old/new schemas, in baseline/current/current/baseline order. Each run includes ten warm-ups and 100 measured samples per workload and verifies resulting balances for every item. Local runtime: Node 24.16.0, MariaDB 10.4.32, Intel i7-14700KF.

| Workload | Baseline queries | Current queries | Baseline p50, two rounds | Current p50, two rounds |
| --- | ---: | ---: | --- | --- |
| Atomic issue of 100 physical items | 12 | 10 | 14.08 / 14.82 ms | 7.12 / 7.87 ms |
| Atomic receipt of 100 ingredients | 9 | 8 | 9.42 / 9.13 ms | 7.06 / 10.68 ms |
| Ingredient picker, 50 rows | 3 | 3 | 1.52 / 1.41 ms | 1.09 / 1.16 ms |

Physical-issue and picker timings improved in both rounds. Ingredient receipts have fewer queries but mixed latency; there is no claim that every operation became faster. Shared-workstation measurements are not Hostinger, low-end hardware, full-HTTP checkout, peak-memory or database-CPU certification. Full evidence: `scratch/stock-schema-consolidation-performance.json`.

## Remaining compatibility boundaries

The active POSApp services/routes no longer query the four removed tables, apart from startup checks asserting their absence. Historical migrations and predecessor fixtures intentionally retain the old schema. The comparison benchmark explicitly builds both schemas.

The separate, gitignored **invoice-support utility is not compatible with the new ingredient storage yet**: `tools/invoice-support/engine/recipeBalances.cjs` still inserts/locks `ingredient_working_balances`, and `engine/coordinator.cjs` still includes that table. The existing invoice-maintenance lab/verifier also target that old schema. They were identified, not silently treated as covered by POSApp tests. Their code/EXE was not modified. Do not use the existing utility against a consolidated database until its separate compatibility work and rebuild are verified.

Future rollout needs a verified backup and a maintenance window with every old application/worker process stopped. Old server code and the new schema cannot run together. Unsupported warehouse data must be reviewed instead of bypassing the migration guard. Reverting code alone after dropping tables is not a rollback; restore the matching database backup as well. No Hostinger upgrade or customer-data restoration was exercised here.

**Phase 3 remains unstarted and requires separate approval.**
