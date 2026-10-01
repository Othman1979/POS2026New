# POS inventory core — final product boundary

Date: 2026-09-09. This is the current scope. The September 7 A–J contracts and C/J handoffs are historical documents, not a backlog. Their remaining warehouse, purchasing, production, valuation and accounting packages are cancelled.

## What the product does

POSApp serves restaurants, coffee shops and supermarkets. Selling, payments, refunds, printing and optional table service work without inventory setup. Product stock and recipe ingredients are independent opt-ins. Catalog barcodes remain useful for POS sales; supplier barcodes and supplier records are no longer an operator workflow.

The retained inventory tools are product receipts/counts, ingredient deliveries, recipes and meal consumption, waste, physical counts, corrections, low-stock information and business-day/period cost reports. No opening count is required for ingredient consumption or cost analysis. A missing quantity or cost stays unknown; an observed zero or free purchase is a valid zero.

Business dates roll over automatically using the configured boundary. There is no inventory day-close action or period-lock workflow. Cashier shift closing remains a separate existing POS operation.

## Removed, not deferred

- The Receiving page, supplier/pack directory, purchase orders and approval actions, vendor-return documents, standalone price-correction documents and procurement CSV staging.
- Their posting service, frontend helpers, navigation/icon, exclusive translations and obsolete workflow tests/browser runner.
- Purchasing/warehouse/production/valuation/period-close permission placeholders from effective grants, the permission catalog and staff reads. Existing database grants cannot reactivate them.
- Extra barcode details in the quantity table, location filters, location chips and prepared-stock categories from the public quantity list; transfer/preparation posting kinds from the internal ledger.

Retired purchasing endpoints return 410. Admin-only archived receipt reads retain bounded pagination; they expose original receipt quantities/costs without supplier details. Existing migration files, historical tables, default physical identity keys and original snapshots are retained for upgrade and data integrity. They do not expose warehouse management or accounting features. No schema or historical movement rewriting was needed.

## Optional tracking lifecycle

Pausing stock keeps source mappings and movements, withdraws known balances and lets new sales proceed untracked. A refund or table void of an originally tracked line still restores its saved physical source exactly once. A new untracked sale cannot invent a stock return later. Replacing an open table order while paused releases its old reservation and records the replacement as untracked. Progressive split lines retain their original saved authority.

Pause markers also withdraw counts entered during the untracked interval when tracking resumes. First-time enablement does not discard preconfigured stock. Recipe analysis resumes without demanding an opening count; accurate remaining quantities require a fresh count. Strict product-stock enforcement requires a current known balance. Settings explain this distinction.

Settings transitions serialize with source policy reads. Count versions advance for shared and already-unknown balances as well, so pre-pause count forms cannot overwrite post-pause state. The report worker checks the two flags, skips historical coverage/backfill/publication when both are off, and resumes automatically when either is enabled. It retains the existing ten-second idle cadence and yields to active source transactions.

## Costs stay operational and inside POS

Ingredient deliveries use the existing movement entry, including packs, display units and optional purchase price. The existing estimator takes the quantity-weighted average of explicitly priced receipts over the selected day and its preceding 29 days. SQL decimal arithmetic combines base quantities and base-unit prices; the result is rounded to eight places. Unpriced receipts do not invent purchase-price evidence. Without priced receipts, the configured reference cost is used; a missing reference stays unknown.

For example, 1 kg at 4 and 3 kg at 8 produce 7 per kg. A 200 g meal consumes 1.40 in recorded ingredient cost; 100 g of waste costs 0.70. Correcting the second delivery changes the next estimate to 4 per kg. Previously recorded sale/refund costs remain frozen at their original value. This is food-cost estimation, not on-hand accounting valuation. Existing product cost-price fields remain unchanged. Historical procurement cost evidence is not silently reinterpreted as ingredient valuation.

## Verification and stop rule

The companion [cleanup acceptance record](reviews/2026-09-09-pos-inventory-cleanup-acceptance.md) records current checks and their limits. Focused real-MySQL tests cover optional flag combinations, pause/resume, original-source refunds and table void/edit, cost calculation and correction, retired endpoint/grant rejection, archived pagination, automatic business dates and the retained query bounds. Frontend and English/Arabic browser checks cover the retained workspaces.

There is no remaining C–J implementation obligation under this scope. Future inventory additions require a concrete POS customer need. Do not reintroduce suppliers, warehouses or accounting to complete an obsolete plan. This cleanup does not authorize deployment or pushing to GitHub.
