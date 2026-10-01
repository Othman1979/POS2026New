# Stock schema consolidation: phase 3

Scope: `codex/schema-consolidation-audit`, following phase 2 commit `ed1781f18e3d3f222b1a5673b8ef31682bf86218`. Verification used generated loopback fixtures only. No application/customer database, Hostinger deployment, GitHub branch, PR or release was changed.

## Result

The fresh-install baseline now contains **75 tables**, down from 76 after phases 1/2 and 80 before consolidation. Phase 3 removes `ingredient_movements`; its complete history lives in typed rows of `stock_movements`. The ten retired purchasing tables retained by some older installations remain a separate decision, so 75 is not the table count of every upgraded installation.

`StockLedgerService` now owns movement insertion for both physical items and ingredients. `StockIngredientAdapter` was removed. Recipe composition, costing and working-balance rules remain in `RecipeLedgerService`; readers, reports, coverage backfill, schema validation and bootstrap use the shared ledger. No frontend product flow, invoice total, payment rule or receipt template was changed.

- The primary key is `(movement_type,id)`. Historical stock and ingredient rows retain their original IDs even when both domains used the same number. All ingredient lookups and count/correction joins specify the ingredient domain. New IDs allocate above both original counters.
- Ingredient `qty` retains its original meaning, including absolute counts. Optional physical `quantity` stores a signed delta. A count from 100 to 80 therefore retains `qty=80` and `quantity=-20` on one new ingredient row.
- Historical mirrored physical rows remain intact. New activated ingredient movements insert their ingredient and physical fields together once. Unactivated ingredients remain valid without physical fields. Operation headers and every source/provenance row remain.
- Original costs, prices, correction links, source/user fields, business dates and ingredient timestamps are copied exactly. Physical rows continue using their operation's `posted_at`; migration does not invent a new historical timestamp for them.
- Keyed ingredient postings use a transaction savepoint. If a stale request reaches a duplicate client key after preparing stock effects, those effects are rolled back before the existing replay handler returns the winning response. Deadlocks preserve `ER_LOCK_DEADLOCK` for the outer transaction owner.

## Verification

The first workflow tests passed on the old schema while the single shared-row contract failed. The migration timestamp and deadlock cases were also observed failing before their corrections. A first benchmark exposed avoidable work from inserting and then updating ingredient rows; the final writer uses one insert.

**524 checks passed across 56 test files**, using the latest complete result for each file. There are no failing or pending checks in that inventory. The final selling run passed 120 checks; the final writer/retry run passed 56. `scratch/unified-verification-summary.json` records the input reports and totals.

| Area | Evidence |
|---|---|
| Baseline and new movement contract | `scratch/unified-movements-red.json`; final `stockUnifiedMovements` checks cover counts, receipts, priced/free stock, shared usage, partial returns, corrections before a newer count, unknown quantities, rollback after physical effects, lost responses and stale-transaction replay |
| Selling and inventory | `scratch/unified-operational-first.json`, `scratch/unified-single-write-regression.json`, `scratch/unified-final-selling.json`; checkout/retry, held orders, table edits/merges, split settlements, refunds/reversals, independent feature flags, strict/estimate stock, concurrent writers and failure rollback |
| Upgrade and schema | `scratch/unified-reports-upgrades.json`, `scratch/unified-final-regression.json`; populated copy, exact decimal/source metadata, overlapping IDs, high-water mark above JavaScript's safe integer range, partial-copy/drop interruption, conflicting copy, missing predecessor, checksum conflicts, raw rerun, complete managed chain and fresh 75-table bootstrap |
| Larger retained history | 10,000 additional rows copied with exact aggregate quantity/cost equality and unchanged balances; source rows are checked individually by migration SQL before dropping the old table |
| Database recovery | `scratch/unified-movement-restore.json`: real dump of the phase-2 fixture, upgrade, successful new-code receipt, restore, exact data fingerprints for all **86 fixture tables**, and successful re-upgrade. Fixture includes the ten legacy purchasing tables. UTC session settings were matched when comparing TIMESTAMP values |
| Reports | Published facts, original count/correction intervals, continuation/backfill, invalidation and page readers; `scratch/unified-final-regression.json` and `scratch/unified-reports-upgrades.json` |
| Browser | `scratch/unified-activated-browser.log`: English 1280 px and Arabic 390 px receiving, picker/waste pagination, archive/recipe controls and stock pause/resume. Material 109's working and activated physical quantities agree at 102 then 104. No page errors |
| Report browser | `scratch/unified-reports-browser.log`: all 105 fixture meals visited without duplicate/omitted pages, last-meal search and real event drilldown in both languages. No page errors |
| Build | `scratch/unified-build.log`: production admin/POS build completed |
| Final artifacts | `scratch/unified-verification-summary.json`: 75 baseline tables, all three consolidation migration/evidence/fallback pairs and hashes match, 45 changed/new JavaScript files parse. `architecture` and `architecture:check` pass; generated map updated. `git diff --check` passes |

Earlier aggregate logs include obsolete test expectations that were corrected: physical-only row counts needed a physical predicate, the managed migration list needed its new entry, and the new history test needed the actual response shape. The final merged test inventory uses the latest complete result for each file; it does not count an earlier failing assertion as passed or inflate totals by repeated runs.

## Performance

`scripts/reviews/stock-unified-movements-performance.cjs` loads the exact phase-2 implementation against its matching schema and alternates baseline/current/current/baseline on generated fixtures. Every case has 10 warmups and 100 measured samples per variant. Each run verifies final physical and working quantities. Machine: Node 24.16.0, local MariaDB 10.4.32, i7-14700KF.

| Operation | Phase 2 queries | Phase 3 queries | Phase 2 p50 range | Phase 3 p50 range |
|---|---:|---:|---:|---:|
| 100 physical items issued in one transaction | 10 | 10 | 4.43–6.13 ms | 4.74–7.74 ms |
| 100 unactivated ingredient receipt lines | 8 | 8 | 8.29–9.55 ms | 6.61–6.80 ms |
| 50 ingredient picker rows | 3 | 3 | 1.03–1.11 ms | 0.49–0.67 ms |
| 100 activated ingredient receipt lines | 21 | 22 | 19.70–21.07 ms | 12.74–13.55 ms |
| Sale using one activated ingredient | 23 | 22 | 4.46–5.13 ms | 3.69–4.86 ms |
| Sale using five activated ingredients | 23 | 22 | 5.62–7.49 ms | 6.05–6.77 ms |

The keyed activated batch has one extra SQL round trip because of its savepoint, but avoids the second movement write. Its 110 warmup/measured batches create **11,000 movement rows instead of 22,000**, a 50% reduction. Sale calls remain constant from one to five ingredients and decrease by one relative to phase 2. Timings vary; physical-only writes are not a demonstrated speedup. These are service-transaction measurements, not end-to-end HTTP or Hostinger latency guarantees. Raw evidence: `scratch/stock-unified-movements-performance.json`; the slower initial implementation is retained in `scratch/stock-unified-movements-performance-first.json`.

## Deployment and compatibility limits

The migration, fresh baseline, bootstrap stamp, schema validator, manifest and cumulative manual fallback move together. Stop all old application processes/workers before migration; do not allow mixed old/new writers. Back up first. A rollback requires restoring the matching pre-upgrade database and application version together; running old code against removed tables is not supported. The generated-fixture restore test passed, but customer backup size, server capacity and Hostinger migration duration were not tested.

The separate, gitignored invoice-support utility still targets removed tables from these consolidations. It was not changed or rebuilt here and must not be used against the consolidated schema until separately adapted and verified. Historical migration/evidence scripts retain historical table names intentionally; they are not compatibility views or active POS runtime readers.

Printing/template tables, financial documents, platform settlements and any other table families remain deferred for the next discussion. Passing these checks is evidence of the tested behavior, not a claim of 100% correctness on every customer installation.
