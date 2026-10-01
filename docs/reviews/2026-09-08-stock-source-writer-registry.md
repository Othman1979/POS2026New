# Stock source-writer registry

Scope: current shared checkout on `codex/ingredients-ui-fix`. This registry identifies production owners; it is not a declaration that the entire A+B acceptance gate passed. The current independent review owns acceptance status.

## Quantity authority and entrypoints

| Source / owner | Authority and operation | Reporting / rejection boundary |
| --- | --- | --- |
| Paid checkout, table checkout, invoice conversion — `modules/checkout/executeCheckout.js` | `InventoryService` resolves packaged-product physical components and frozen authority; `RecipeLedgerService` owns ingredient usage, with activated identities mirrored once by `StockIngredientAdapter`. | Invoice and movement scopes collect on the source connection and flush before the source commit. Finalized invoice edits are rejected, including programmer/admin callers. |
| Open-table creation/edit — `modules/tables/saveTableOrder.js` | Restore prior packaged authority, deduct submitted stock and reconcile frozen recipe lines in the same source transaction. | Table source and ingredient day scopes are collected. Saved reductions require the explicit void operation. |
| Split save/settlement — `modules/tables/splitChecks.js`, checkout | Split drafts preserve server-owned stock/recipe identity; settlement uses the established source adapters. | Draft-only changes do not fabricate paid revenue. Finalization invalidates source invoices; retries retain identity. |
| Financial refund — `services/RefundService.js`, `routes/pos/refunds.js`, subscription refund callers | Original sale snapshots restore the original physical keys and ratios even after remapping; frozen recipe keys reverse original consumption. | Original invoice partition on the refund business day, plus physical operation scopes. Managed subscription money-only partial refunds do not post physical stock. |
| Open-table void — `modules/refunds/voidOpenTableOrder.js` | Original packaged snapshots and frozen recipe usage reverse atomically with void rows. | Original invoice/day and physical scopes. No implicit deletion of saved consumption. |
| Subscription redemption — `routes/pos/subscriptions.js` | Product deductions and recipe consumption commit with redemption snapshots. | Movement scopes collect before commit. Collection-only money changes do not alter inventory. |
| Redemption reversal — `routes/admin/subscriptions.js` | Restore recorded product authority and original recipe keys once. | Physical and ingredient scopes collect in the same source transaction. |
| Product receipt/count — `StockAdjustmentService`, `routes/admin/products.js` | Expected versions, durable request keys; legacy unlinked adjustment or core ledger for exclusive one-to-one linked authority. | Shared/composite product-level receiving is explicitly rejected because physical components must be received individually. C adds document-based physical receiving. |
| Ingredient receipt/count/opening/waste/correction — `RecipeLedgerService`, `routes/admin/recipeLedger.js` | Immutable ingredient journal, transactional current-balance projection, core mirror for activated ingredients. | Counts use the physical authority for shared stock. Corrections preserve count boundaries. Source scopes collect before commit; finalized movement quantities are never rewritten. |
| Product activation / ingredient activation — `StockActivationService`, `routes/admin/products.js` | Observed cutover token/version, immutable opening operation and provenance; existing open-order restrictions preserved. | Core dirty scope and explicit ingredient day invalidation. Legacy history is not replayed as duplicate stock. |
| New product / import append — `routes/admin/products.js`, `routes/admin/import.js` | New, unlinked identity with an explicit legacy initial value or unknown stock. | No existing physical balance is overwritten. Later activation establishes the forward-only opening journal. |
| Category copy — `routes/admin/categoryPriceLists.js` | New product identities start at zero when tracked, otherwise unknown; no copied physical links or duplicated stock. | Catalog creation only. Current recipes copied to new identities apply only to subsequent source operations. |
| Product catalog PUT / archive — `routes/admin/products.js` | Metadata is separate from stock commands; linked quantity replacement rejected. Exclusive linked catalog metadata refreshes physical name/barcode/attention. | Shared physical identities retain their independent identity. Aliased product barcodes resolve through links. |
| Product price lists / subscription plan catalog — admin routes | Future pricing and eligible unpaid-order repricing only; these are not physical stock writers. | Frozen paid-sale price/cost snapshots are unchanged. Receipt price-only document corrections belong to C, not an existing silently accepted endpoint. |
| Operational reset — `operationalDataReset` | Reject active physical stock and any retained ingredient movement history. | An otherwise allowed financial-only reset withdraws published pointers and resets discovery checkpoints transactionally. It cannot orphan retained inventory evidence. |
| Catalog replacement import | Reject links, recipe/subscription references and any order/refund product history. | Append remains available. Replacement cannot detach historical report sources. |
| Table relationship / metadata changes — `tableRelationships`, table routes | Unpaid table relationships, routing and metadata only; no direct quantity SQL. | Finalized orders are rejected. There is no extra stock posting for renaming/moving a table. |

## Procurement source extension

`StockProcurementService` owns receipt, vendor-return and price-correction documents through the same transaction facade. Posting reads locked current documents, updates source PO/return counters, then posts sorted physical keys and flushes invalidation before commit. Vendor returns keep original receipt physical identities and operation references. The internal ledger option permitting return of uncounted received stock is caller-authorized; a `source_line` string does not grant this permission. Price corrections append immutable cost evidence and dirty the physical day without changing quantity; they are not H valuation entries.

## Write ownership rules

`StockLedgerService.post` is the sole production writer of physical movements and balances. `RecipeLedgerService.insertRows` is the sole production insertion owner for ingredient movements and their working projection. `StockProductAdapter` owns compatibility product projections for linked items; unlinked legacy mutations remain in `InventoryService` and `StockAdjustmentService`. New product creation is a separate initial-state operation.

All production multi-writer transactions use the explicit `StockReportInvalidation.getConnection` facade. Its pending scopes are transaction-local, sorted and deduplicated; they are written before the source commit, discarded on rollback, and never patched onto a pooled driver connection. Raw internal callers are restricted to a single source mutation and flush directly. An abandoned or failed-rollback lease is destroyed.

Mixed product/recipe source transactions call `InventoryService.prepareStockWrite` before their first stock post to lock the union of current and frozen physical identities. Existing product rows and recipe context are reused by later posts.

Public readers must derive shared-product availability from physical balances rather than trust the last-touched compatibility product value. This includes POS catalog/barcode, checkout context, admin product lists, activation inspection, stock alerts and dashboard attention.

## Reconciliation evidence

The real-database suites `stockLedgerCore`, `stockResolvedCompositions`, `stockLinkedWriters`, `stockIngredientActivation`, `stockPublishedCounts`, `ingredientWorkingBalances` and `stockDailyProjection` exercise signed journal/balance equality, multi-component rollback, original-stock returns, shared availability, current reads after old snapshots, count boundaries and published/reference parity. Daily working-list reads use published per-day/per-identity facts; live movement history remains reference/history work, not page hydration.

Exact passing runs and unresolved issues must be taken from the current independent review. Do not convert this registry into a blanket certification or skip source tests when extending a writer in C–J.
