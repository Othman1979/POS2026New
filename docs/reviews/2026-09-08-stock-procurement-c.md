# Package C procurement — execution evidence

Status: **executor report, superseded by independent review; C and C-specific J are not accepted as complete** on `codex/ingredients-ui-fix`. This does not accept D–I, mark all of J done, push, merge or deploy. A+B remains accepted under the revised functional/query gates.

Read [the independent review](2026-09-08-stock-procurement-independent-review.md) for reproduced defects, fixes and remaining operator workflows. The implementation/evidence statements below describe the original executor commits, not current acceptance.

## What shipped

Physical receiving uses the established stock writer only. Documents snapshot pack size and cost. Installation currency is `JD`. Unknown price stays `NULL`; zero is stored. Collection reads are cursor-paged (default 50, max 100) with prefix search. Drafts use `expected_version` and return 409 when stale. Posted retries return the original document with `replayed: true` before a stale-version check.

Purchase orders move `draft → approved → partially_received → closed`, or `cancelled` for outstanding quantity. Cancellation never reverses received stock. Concurrent receipts serialize on the PO row and cannot over-consume remaining quantity. Amendments keep the prior revision and cannot change lines behind received quantity.

Vendor returns post `issue` lines limited by received minus previously returned quantity. Documented vendor-return source lines may reverse an unknown receipt without inventing an opening count. Price-only adjustments dirty the physical business-day scopes and do not change quantity. Discounts and nonrecoverable charges allocate across known-cost lines with last-line residual conservation. Recoverable tax is stored separately. No payable, expense or valuation tables are written.

## J for C

- Implemented catalog keys: `inventory.read`, `receipt.enter`, `receipt.post`, `purchase.approve`, `supplier.manage`. Admin/programmer inherit through `userHas`. Cashiers without grants receive 403. `inventory.read` lists omit cost fields.
- Reserved D–I keys exist with `implemented=0`. Users UI shows them as coming soon; grant writes filter to `implemented=1`.
- CSV preview validates identity, units, duplicates, pack mappings, activation and currency. Staging creates a receipt draft only. Final post uses the same request key as a manual receipt.
- Barcode lookup distinguishes item barcodes from supplier-pack barcodes. Keyboard scan is the receiving baseline.
- Receiving UI is Arabic/English, RTL-capable, 390 px, 44 px controls, 100-line drafts, server-paged history, empty/error/uncertain-save states. History search is sent to the server.

## Verification

| Check | Result |
| --- | --- |
| `npm run test:isolated -- stockProcurement` | **9/9 passed** (7 HTTP/transaction + 2 upgrade/no-op/fail-closed). Isolated DB `posapp_review_recipe_p1_564379465a73`. |
| `npm run test:isolated -- automaticMigrations -t "upgrades the exact July 29 floor"` | **passed** after placing the procurement ledger row in name order (`stock-ledger-core` then `stock-procurement` then `stock-read-index`). Isolated DB `posapp_review_recipe_p1_e0c73d2548dc`. |
| `npm run test:frontend -- receivingPage.spec.js sidebarNavigation.spec.js` | **8/8 passed**. |
| `backend/tests/unit/automaticMigrations.test.js` + `schemaAuthority.test.js` | **157 passed**, including procurement hash/fallback parity. |
| `npm run test:isolated -- stockLedgerCore` | **19 passed**. The vendor-return unknown-issue exception did not break A+B ledger cases. |
| `installerBaseline` count/hash/guarded bootstrap | **4 passed**. Fresh baseline is **80** `CREATE TABLE` statements. SHA-256 `c03e7976f4f4028868145f23c7309aeaa94e6704ceb4297f92480505ca9e926b`. |
| `npm run build:admin` then `node scripts/reviews/stock-receiving-browser.cjs` | English 1280 px and Arabic 390 px: scan/add, 1 pack + 500 loose at pack size 6500 = 7000, failed POST preserves the draft row, reload recovers `BRW-en`, server history cursor past 50 rows, RTL, no horizontal overflow. JSON: `scratch/stock-receiving-browser.json`. |
| Architecture | 268 nodes, 73 flows, 534 steps, 85 tables, 31 route modules. |

Hardware benchmarks were not run.

## Query and lock bounds

- Receipt/PO/supplier/return/adjustment lists: `LIMIT :limit+1` (max 101). Receipt history prefix uses `supplier_document_ref LIKE 'q%' ESCAPE '='` with `idx_stock_receipt_supplier_ref`.
- EXPLAIN of `SELECT id FROM stock_receipts WHERE status='posted' ORDER BY id LIMIT 51` used `PRIMARY` or `idx_stock_receipt_status_date` with an estimated row count ≤ 51 in the isolated fixture.
- Posting lock order: receipt `FOR UPDATE` → purchase order `FOR UPDATE` → PO lines → `StockLedgerService.post` (sorted item/lot/balance locks) → dirty flush on `commit` through `StockReportInvalidation.getConnection`.
- Price-only posting dirties the 32 physical-day partitions once; it does not scan movement history.

## Remaining D–I / J dependencies

- D count sessions, E recipe versions, F preparations, G lots/transfers, H valuation/payables/period close and I demand/planning are not implemented. Their permission rows stay `implemented=0` with no routes or screens.
- J for those packages remains dependent on the packages themselves. Passing C screens does not complete J.
- The fresh-install baseline omission reported here was reproduced and fixed during independent review. The real installer validator now passes with all recipe/A+B prerequisites.
- No production cutover, application-database mutation, push or deploy was performed.

## Rollout checklist (not executed)

1. Ship one compatible application version that includes this migration and the new writers.
2. Apply `2026-09-08-stock-procurement-v1` after `2026-09-08-stock-report-daily-projection-v1`. Hostinger fallback block is in `deployment/database/hostinger-manual-migrations.sql`.
3. Do not run mixed old/new receipt writers during cutover.
4. Preserve every machine `.env`. Rollback is drop-the-new-app-version plus leaving unused C tables; do not delete posted `stock_operations`.
5. Reversible only before documents are posted in production. After posting, reverse with vendor returns / price adjustments, not table drops.
