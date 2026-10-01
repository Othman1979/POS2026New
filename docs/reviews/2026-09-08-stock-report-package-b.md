# Package B: published facts, invalidation and Arabic working list

This completes the remaining Package B workflow on `codex/ingredients-ui-fix` after A cutover `c17fbfb3`. It does not start packages C–J, migrate production, or certify the 2-CPU/4-GiB gate. Independent-review ingredient-cutover regressions remain.

Earlier B slices stay in force: [bounded stock reads](2026-09-08-stock-read-b1.md), [generation metadata](2026-09-08-stock-report-generations-b2.md), [typed facts and the internal worker](2026-09-08-stock-report-facts-b2.md). This slice wires those pieces into one database → API → Arabic UI path.

## Behavior

Source transactions mark dirty scopes in the same connection after document and stock locks. `StockReportInvalidation` sorts unique day/scope keys and flushes them in chunks of 64. Invoice partitions hash `order` identities; refund rows map to the original invoice; `void` and other non-invoice physical rows dirty all 32 partitions for that movement day. Checkout writes the paid-invoice marker once after recipe sync; recipe usage is marked from `RecipeLedgerService.insertRows`, not a second adapter `markDirty`. Rollback rolls the markers back with the source.

`ensureCoverage` INSERT IGNOREs missing scopes for source days that have fewer than 32 dirty rows, at most eight days per call. Production startup covers the last 14 business days, then `runOne`. Pending work polls every 500 ms; idle polls every 10 s. GET `/api/admin/ingredients/analysis` is a read-only published-fact read: it never calls `ensureCoverage` or rebuilds. Source days with no dirty rows are `unavailable` with `totals: null`, not a clean zero. Partial publication is `stale` and still shows the last published totals. `rebuilding` also keeps totals null.

Published meals exclude `product_id=0`; unallocated and excluded revenue fold into global totals. Lists cap at 50 rows with `*_has_more`. Count comparisons reuse the historical ingredient-movement interval query. `IngredientAnalysisService.getAnalysis` remains the live reconciliation reference and is not the interactive report path.

`GET /api/admin/stock/items` projects `barcode` and `attention`, supports location chips, and searches `barcode=? OR name LIKE prefix`. The Arabic quantity ledger on Inventory uses that endpoint. The ingredients catalog page now requests 50-row cursors instead of the full table. Additive migration `2026-09-08-stock-item-projections-v1` (checksum `6d81e9659ccd1da36f4067f8791d60c0311d48ec94249745a4164617a2d34f9b`) does not change `stock_core_columns: 41`. Fresh baseline SHA-256 is `82e4439595e24fc3951d4f18af5ad37c1c8559ea9fd50efad0ac8af9a1b71ed8`. Installer table count stays 70.

## Source-writer registry

| Source | Production writer | Marker |
| --- | --- | --- |
| Paid checkout | `executeCheckout` after recipe sync and cost capture | invoice partition for the paid id (and the replaced table invoice when present) |
| Recipe usage / reversals | `RecipeLedgerService.insertRows` after journal | `fromMovements` |
| Paid refund | `RefundService` after stock restore and recipe reversal | original invoice partition |
| Open-table void | `voidOpenTableOrder` → `reverseLinesUsage` (`source_type=void`) | all 32 scopes for the movement day; void ids are never treated as invoices |
| Quantity-ledger post | `StockLedgerService.post` | operation partition |
| Ingredient/product activation | `StockActivationService` | operation partition |
| Adapter journal | `StockIngredientAdapter.journalIngredientRows` | none; the recipe insert is the marker |
| Price-only paid-invoice edit | none | tests simulate `UPDATE orders` plus `invalidation.invoices` |
| Catalog import | none | remaining gap |
| Unactivated `products.stock` PUT | legacy catalog/InventoryService | remaining gap; activated products reject catalog quantity writes |

## Verification

Serial isolated/backend checks on generated loopback databases. Frontend checks do not use MySQL. No application database was migrated.

| Check | Result |
| --- | --- |
| `backend/tests/integration/stockRead.test.js` | 6/6 |
| `backend/tests/integration/recipeLedgerSplitsMerges.test.js` | 3/3 |
| `backend/tests/integration/recipeLedgerAdmin.test.js` | 5/5 |
| `backend/tests/integration/stockItemProjectionsMigration.test.js` | 2/2, ~108 s |
| `backend/tests/integration/stockReportPackageB.test.js` | 11/11 |
| `backend/tests/integration/checkoutPerformanceContract.test.js` | 12/12 (recipe=false: 22 commands / 1 dirty write; recipe=true: 29 commands / 2 dirty writes; ordinary graph 13 SQL / 16 commands; stock-enabled 16 SQL / 19 commands) |
| `backend/tests/unit/schemaAuthority.test.js` | 102/102 |
| `backend/tests/unit/automaticMigrations.test.js` | 45/45 |
| `backend/tests/unit/spoolerV2OnlyContract.test.js` | 12/12 |
| `backend/tests/unit/stockReportWorkerRunner.test.js` | 1/1 |
| `stockIngredientActivation.test.js -t "independent review"` | 2 passed / 5 skipped |
| `backend/tests/integration/stockReportGenerations.test.js` | 9/9 |
| `backend/tests/integration/ingredientAnalysis.test.js` | 12/12 |
| `backend/tests/integration/stockReportWorker.test.js` | 6/6 |
| `backend/tests/integration/automaticMigrations.test.js` | 12/12, ~349 s on clean `posapp_auto_migration_test` |
| `npm run architecture:check` | 259 nodes, 72 flows, 530 steps, 70 tables |
| `npm run build:admin` | passed |
| frontend `ingredientAnalysis.spec.js`, `stockWorkingList.spec.js`, `ingredientsPage.spec.js` | 19/19 |

Package B adversarial tests cover source rollback, void-all-partitions, refund→invoice mapping, ledger operation dirtying, unlinked recipe rows (no invented movement ids), old-date edits, unavailable/rebuilding/current, partial-scope stale, price-only correction rebuild, later lower invoice ids, eight-day coverage batches, and HTTP checkout → published totals.

## Browser journey

Review fixture `posapp_review_recipe_p1_58a2915bbea8` served at `127.0.0.1:3013` by `scripts/reviews/recipe-ledger-phase3-browser-server.cjs`. That helper listens only; it does not call `onServerStarted()`, so the production worker did not run. Coverage/publish used a one-shot drain. Login 9001, Arabic UI, stock and recipe ledger enabled.

1. Quantity ledger (`سجل الكمية`): barcode, attention, kind and location filters; empty copy `لا توجد أصناف مخزون مطابقة.` Seed products are not activated `stock_items`.
2. Paid sale inserted without dirty rows: analysis banner `لا تظهر المجاميع حتى تُنشر هذه الفترة.` No metric zeros.
3. After `ensureCoverage` + drain: freshness current, net meal revenue 5.00, Test Burger 1/0, incomplete cost 0/1 (no recipe). Margin remains a dash while cost is incomplete.

Local screenshots stayed under ignored `scratch/` and the Cursor temp screenshot directory. This is not a production or printer check.

## A+B measurements (this workstation)

Node v24.16.0, MariaDB 10.4.32, i7-14700KF, ~32 GiB RAM. These are not 2-CPU/4-GiB, million-movement, or 100,000-invoice certification. The guarded 100k rebuild (84.57 ms max window, 566.8 s) remains the earlier facts-slice result and was not rerun here.

[Stock list](2026-09-08-stock-read-package-b.json) (`scripts/reviews/stock-read-performance.cjs`, 10,000 items, 1,000 samples):

| Query | p95 ms | Bytes |
| --- | ---: | ---: |
| Default page | 1.26 | 12,498 |
| UI default `{status:all,locations:1,kind:all}` | 3.43 | 19,293 |
| Attention `ok` | 1.27 | 12,498 |
| Name prefix `Stock 080` | 9.83 | 12,610 |
| Barcode `BC00000051` | 10.48 | 304 |

Prefix/barcode latency rose versus the earlier name-only ~1 ms page because search is now `barcode=? OR name LIKE`. It remains under the 300 ms / 100 KiB interactive budgets.

[Published analysis](2026-09-08-stock-report-published-read-performance.json) (1,000 one-line invoices, 100 samples): p95 **13.24 ms**, **1,047 bytes**, 1 meal, `freshness=current`, live `net_revenue` 5000. Not a 100k rebuild.

[Checkout HTTP](2026-09-08-stock-report-checkout-performance.json) (100 samples): p95 **7.41 ms**, 32 pending dirty scopes, no rebuild inside checkout. Not a before/after versus `c17fbfb3`; the command-count contract is the hot-path bound.

[Unactivated stock deduct](2026-09-08-stock-adjustment-package-b.json) versus `3dd0bc60`: current p95 ~1.53–1.56 ms vs baseline ~1.66–1.80 ms. Durable receipt p95 3.59 ms. `--activated` comparison failed because baseline `3dd0bc60` does not journal the current ledger; treat as a script/baseline mismatch, not a new quantity bug.

## Remaining gaps for independent review

- Catalog import does not journal or dirty report scopes.
- There is no production paid-invoice price-edit writer.
- Unactivated `products.stock` PUT/import still bypass the quantity ledger.
- General resolved compositions, remapped original-stock returns and unified recipe authority remain Package A exits.
- 200-component recipes versus the 100-line post cap (Package E).
- The Phase 3 review server does not start the report worker.
- Prefix search uses one OR predicate rather than two indexed queries.
- Ingredients.vue still filters shortages locally on loaded pages; Inventory quantity ledger is the server-filtered attention/barcode/location surface.
- No million-movement, 365-day, concurrent mixed-load or 2-CPU/4-GiB certification.
- Do not begin C–J until this A+B gate is independently reviewed.
