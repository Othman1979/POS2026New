# POSApp schema consolidation audit

Date: 2026-09-12. Source: `2cba888fce4476117052a1ce50016a2ebf40ac3b`. Audit branch: `codex/schema-consolidation-audit`.

## Verdict

There is justified simplification work, concentrated in inventory. The strongest targets are retired purchasing tables on existing installations, location/lot machinery left after warehouse scope was cancelled, and the continued mirroring between ingredient and physical stock ledgers. Two one-to-one ingredient side tables are also plausible consolidation candidates.

An arbitrary table-count target would be misleading. A typed movement table is appropriate for different kinds of the same movement; it does not eliminate the need for operation headers, multiple source rows, recipe composition, or differently indexed report summaries. The current implementation already uses types extensively.

Recommend a first proposal that removes obsolete inventory dimensions and evaluates the two one-to-one merges: **80 to 76–78 fresh tables**, subject to migration and workload verification. The ten retired purchasing tables are a separate upgrade cleanup; they are already absent from those 80. A later ledger unification could remove another table and more duplicated code, but is a substantially larger change.

No application code, schema, migration ledger, customer data, or deployed database was changed by this audit. The conclusions below are design findings, not certification of an unimplemented migration.

## What actually exists

| Measure | Verified result |
| --- | --- |
| Fresh deployment baseline | 80 tables |
| Local `posapp` database | 89 tables, MariaDB 10.4.32 |
| Local-only retired purchasing tables | 10; exact `COUNT(*)` is zero for every table |
| Fresh table absent locally | `daily_order_type_sequences`; latest feature migration has not been applied to this local schema |
| Inventory/recipe tables in the fresh baseline | 25: 14 operational/catalog/link tables and 11 report tables |
| Other current features | 55 tables |

The difference is `80 + 10 - 1 = 89`. Removing ten retired tables from this exact local snapshot would leave 79; applying the missing numbering migration would bring it to 80. Neither action was performed. This is not evidence that deployed customer databases have the same contents.

Read-only evidence is in the local, gitignored [schema inventory](C:/xampp/htdocs/posapp/scratch/schema-consolidation-inventory.json) and [aggregate preflight](C:/xampp/htdocs/posapp/scratch/schema-consolidation-preflight.json). The probes use their own loopback-only MySQL connection, issue SELECTs, and close it without booting POSApp or its workers. The initial DDL extraction inventories CREATE TABLE statements; subsequent ALTER statements and runtime source were consulted where relevant, so that extraction alone must not be used as a replacement schema.

The earlier simplification is documented: purchasing, warehouse controls, transfers, preparation and valuation were cancelled, while historical tables, physical identity keys and snapshots remained for compatibility. See [inventory closeout:13](C:/xampp/htdocs/posapp/docs/2026-09-09-pos-inventory-core-closeout.md:13) and its [acceptance record](C:/xampp/htdocs/posapp/docs/reviews/2026-09-09-pos-inventory-cleanup-acceptance.md). That establishes the scope mismatch; the remembered initial six-to-eight-table count was not independently verified.

## Ranked candidates

### 1. Retired purchasing schema: remove where empty, preserve populated archives

Tables:

- `stock_suppliers`, `stock_supplier_items`
- `stock_purchase_orders`, `stock_purchase_order_lines`
- `stock_receipts`, `stock_receipt_lines`
- `stock_vendor_returns`, `stock_vendor_return_lines`
- `stock_price_adjustments`, `stock_price_adjustment_lines`

**Recommendation:** offer a guarded, one-time upgrade cleanup for installations where all ten are empty and dependencies permit removal. Do not build a new generic purchasing subsystem to replace a cancelled feature.

Current purchasing mutation routes return 410. The remaining receipt route is a paginated archive reader, and already handles missing receipt tables with 410. See [stockProcurement.js:4](C:/xampp/htdocs/posapp/backend/routes/admin/stockProcurement.js:4). Fresh baseline verification explicitly expects no retired purchasing tables: [fresh-pos-baseline.cjs:11](C:/xampp/htdocs/posapp/scripts/reviews/fresh-pos-baseline.cjs:11).

Local exact counts are all zero. Their reported data-plus-index allocation totals **655,360 bytes (640 KiB)**. Removing them would clean the schema; this measurement gives no basis to promise faster checkout.

For a populated installation, archive reads and historical references still have value. Inspect inbound foreign keys, generic source references and stored snapshots before any proposed conversion or removal. The local metadata includes 17 FK column references involving this family, including receipt-line references to lots and locations. Preserve the old migration ledger: historical entries in `auto-manifest.json` are not obsolete files that can simply be deleted. Test startup twice and an upgrade from an older predecessor so cleanup cannot be undone by migration replay.

**Count effect:** up to ten fewer tables on older installations; zero reduction in the current fresh baseline. **Risk:** low only after the empty/dependency checks; materially higher for populated archives.

### 2. Default-only stock locations and lots: remove obsolete dimensions

**Recommendation:** simplify current POS stock to one physical balance per stock item, removing `stock_locations` and `stock_lots` from the active model once historical references have an explicit migration path. Keep `stock_balances` initially; combining it with the catalog is not necessary to remove the warehouse complexity.

New product and ingredient activation creates/selects default identities. The product availability query joins links, default lots, the default location and balances. The posting service still loads and validates lots, location activity, expiry and quarantine. These are real extra joins, validations and locks for warehouse behavior that the product no longer exposes. See [StockProductAdapter.js:9](C:/xampp/htdocs/posapp/backend/services/StockProductAdapter.js:9), [StockActivationService.js:93](C:/xampp/htdocs/posapp/backend/services/StockActivationService.js:93), [StockIngredientAdapter.js:103](C:/xampp/htdocs/posapp/backend/services/StockIngredientAdapter.js:103), and [StockLedgerService.js:67](C:/xampp/htdocs/posapp/backend/services/StockLedgerService.js:67).

This is a code simplification opportunity, not a DROP TABLE operation on today's code. The balance primary key and movement FK use `(stock_item_id, location_id, lot_id)`. Sale/return snapshots also carry those identities; historical returns must still resolve their original stock. See [baseline.sql:1059](C:/xampp/htdocs/posapp/deployment/database/baseline.sql:1059) and [StockProductAdapter.js:59](C:/xampp/htdocs/posapp/backend/services/StockProductAdapter.js:59).

The local database has **two locations, one nondefault**, but zero stock items, lots, balances or physical movements. That proves neither that nondefault stock is used nor that every customer's historical stock can be collapsed. A customer preflight must identify nondefault balances/lots, multi-balance items, unknown quantities, outstanding original-source returns, receipt archives, queued payloads and stored replay results. Do not sum unknown and known stock as though both were known.

**Count effect:** two fewer fresh tables, 80 → 78. **Expected benefit to verify:** simpler availability/posting queries and a smaller lock/dependency surface. **Risk:** medium/high migration risk because saved source identities outlive current UI settings.

### 3. Two one-to-one ingredient side tables: plausible merges, not blind deletion

| Table | Proposed destination | Preserve | Tradeoff |
| --- | --- | --- | --- |
| `stock_ingredient_links` | Activation/link fields on `ingredients` | Unique stock-item link, unique request key, cutover operation, watermark, observation, activation quantity/known state | Fewer joins and one less identity lookup; more nullable catalog columns and a changed lock order |
| `ingredient_working_balances` | Working-balance fields on `ingredients` | Exact precision, known/unknown flag, initialization, last count, period usage and variance | Removes a side-row initialization/read/update path; wider ingredient rows and potentially more contention with catalog edits |

The first table has an ingredient primary key and a unique stock-item key. The second has an ingredient primary key and FK. Neither is a many-to-many relationship. See [baseline.sql:1243](C:/xampp/htdocs/posapp/deployment/database/baseline.sql:1243) and [baseline.sql:1461](C:/xampp/htdocs/posapp/deployment/database/baseline.sql:1461).

These are representation changes, not permission to discard their data. Activation quantity is a historical observation, not necessarily today's balance. The working balance is a maintained projection that avoids scanning movement history on each operation. [RecipeLedgerService.js:528](C:/xampp/htdocs/posapp/backend/services/RecipeLedgerService.js:528) initializes it once and updates it per affected ingredient. Keep that constant-per-line behavior after any merge. The local database has four ingredients, four working balances and 18 ingredient movements; these are not unused tables.

The caller already holds ingredient locks on relevant writers, which makes consolidation worth testing. All other callers, backfills and catalog updates must be checked before changing lock order. Preserve the difference between absent/uninitialized and known zero. `DECIMAL(28,6)` working precision must not silently narrow to the core balance's `DECIMAL(16,6)`.

**Count effect:** one or two more tables, 78 → 77 or 76 after candidate 2. **Risk:** medium. Keep either side table if realistic concurrent tests show that merging increases contention or complicates upgrades. One-to-one alone does not prove a bad design.

### 4. Ingredient and physical movement ledgers: the largest structural duplication

**Recommendation:** consider one stock movement writer with typed operations and sufficient ingredient/source/cost fields as a separate follow-up. This is where the user's typed-table proposal could remove duplicated behavior rather than merely rename tables.

Today `RecipeLedgerService.insertRows` writes `ingredient_movements`, updates ingredient working balances, then journals activated ingredients through `StockIngredientAdapter` into `stock_operations`/`stock_movements` and physical balances in the same caller transaction. [RecipeLedgerService.js:327](C:/xampp/htdocs/posapp/backend/services/RecipeLedgerService.js:327) and [StockIngredientAdapter.js:64](C:/xampp/htdocs/posapp/backend/services/StockIngredientAdapter.js:64) demonstrate the dual path.

These ledgers overlap but are not interchangeable. Ingredient rows preserve unit cost, count expectations, source/recipe details, correction origins, pricing provenance and historical usage. Physical rows can aggregate several sources and handle product stock shared with ingredients. Reports explicitly distinguish mirrored physical operations to avoid double counting: [StockReportFactService.js:75](C:/xampp/htdocs/posapp/backend/services/StockReportFactService.js:75).

A unified writer must represent unactivated ingredients, product-only stock, shared components, independent tracking flags, original usage/reversal, priced/free/unpriced receipts, correction-before-last-count behavior, idempotency and frozen historical costs. The current physical movement table does not contain all those semantics. A simple `INSERT ... SELECT` followed by deleting `ingredient_movements` would be incorrect.

**Count effect:** potentially one more table if `ingredient_movements` is fully retired. Do not count removing provenance or source-lock tables as automatic extra savings. **Risk:** high; requires a separate bounded design, migration and differential workflow tests. This has greater potential to reduce ongoing code maintenance than merging report-state tables.

## Cuts that looked attractive but do not hold up

| Candidate | Verified reason to retain for now |
| --- | --- |
| Merge `stock_operation_sources` into one set of columns on each movement | Multiple source rows can collapse into one physical movement. The source ordinal is not the physical movement ordinal. [StockIngredientAdapter.js:139](C:/xampp/htdocs/posapp/backend/services/StockIngredientAdapter.js:139) groups physical keys but records the full original chunk. A scalar merge loses relationships. |
| Merge operation headers with movement rows | One retry-safe operation can contain many items. Header request-key uniqueness, payload hash, result and transactional replay remain useful independently of the line type. [StockLedgerService.js:60](C:/xampp/htdocs/posapp/backend/services/StockLedgerService.js:60). |
| Remove `product_stock_links` or `product_recipe_lines` | Products can consume multiple components, and components can be shared. These are actual relationships with quantities, not catalog fields split unnecessarily. |
| Delete `recipe_ledger_lines` because it contains only two columns | It locks a source line and remembers its ingredient set across recipe changes. It is consulted before loading recorded usage and handling edits/reversals. [RecipeLedgerService.js:216](C:/xampp/htdocs/posapp/backend/services/RecipeLedgerService.js:216). Removal needs an equivalent source-lock mechanism. |
| Replace `master_held` with the live held-order table | It stores full Y-report recovery snapshots and restored/expiry state, rather than just a held number. [auditReports.js:512](C:/xampp/htdocs/posapp/backend/routes/admin/auditReports.js:512), [yHeldItemsReportBuilder.js:304](C:/xampp/htdocs/posapp/backend/services/yHeldItemsReportBuilder.js:304). |
| Merge all three sequence tables | A typed sequence store is possible and would save two tables, but must preserve their different scopes, prefix assignments and reset/retry behavior. It offers no demonstrated checkout improvement and touches the just-completed numbering feature. Low priority for this inventory-focused cleanup. |
| Fold `stock_balances` into `stock_items` immediately | Becomes a possible extra one-table cut only after multi-location/lot state is removed. Keeping a narrow mutable balance row is reasonable; its removal is not needed for candidate 2 and has no measured benefit yet. |

## Why the eleven report tables need a different decision

Seven are stored report facts, and four manage generation, publication or backfill:

| Tables | Row meaning / purpose |
| --- | --- |
| `stock_report_meals` | Meal totals within a report build |
| `stock_report_ingredients` | Ingredient contribution per meal/build |
| `stock_report_events` | Source sale/refund line facts; already typed by kind |
| `stock_report_operations` | Movement totals by item/ingredient, kind and source type |
| `stock_report_daily` | Daily physical flow and ingredient totals/opening references |
| `stock_report_counts` | Completed ingredient count intervals |
| `stock_report_count_corrections` | Original movement references needed to adjust those intervals |
| `stock_report_builds`, `stock_report_dirty` | Build lifecycle and which complete generation readers may see |
| `stock_report_worker`, `stock_report_backfill` | Worker ownership and per-source backfill progress |

All seven fact tables have live writers via the `definitions` registry and dynamic `stock_report_${table}` SQL. Literal-name searching alone undercounts these references. See [StockReportFactService.js:14](C:/xampp/htdocs/posapp/backend/services/StockReportFactService.js:14).

Their row meanings differ. Combining them into `report_rows(type, payload_json)` lowers the table count but moves schema validation, ordering and indexing into application code. Likewise, `daily` cannot currently be reconstructed just by summing `operations`: mirrored physical movements contribute to physical daily totals while being excluded from duplicated operation summaries. Count corrections retain origins because a correction to a movement before an opening count must not alter that interval incorrectly. See [StockReportFactService.js:103](C:/xampp/htdocs/posapp/backend/services/StockReportFactService.js:103) and [StockReportFactService.js:127](C:/xampp/htdocs/posapp/backend/services/StockReportFactService.js:127).

The two build/publication tables prevent readers seeing a half-built replacement; the worker lease is actively used, not a placeholder. [StockReportGenerationService.js:48](C:/xampp/htdocs/posapp/backend/services/StockReportGenerationService.js:48) and [StockReportGenerationService.js:120](C:/xampp/htdocs/posapp/backend/services/StockReportGenerationService.js:120).

This does **not** establish that eleven is the minimum possible. A narrower reporting product or a different measured aggregation strategy might need fewer. First simplify duplicate inventory sources, then compare a proposed report consolidation against the same report outputs and realistic data volume. Do not remove precomputed facts and silently replace them with full-history scans during a cashier workflow. Merging the tiny worker/backfill state tables is possible but a low-value count reduction, not a proven performance fix.

## Receipt printing

If “receipt” refers to printing rather than ingredient deliveries: the template family already uses one `document_type` for receipt/kitchen, not separate tables per type. `print_templates` stores active/draft pointers and edit version; `print_template_revisions` stores revision definitions; `print_template_revision_tests` stores multiple printer/endpoint confirmations. Their lifecycles and cardinalities differ. See [baseline.sql:768](C:/xampp/htdocs/posapp/deployment/database/baseline.sql:768) and [printTemplateManager.js:141](C:/xampp/htdocs/posapp/backend/services/printTemplateManager.js:141).

Those confirmations inform tested status for the current endpoint; this audit does not claim activation requires a confirmation. Durable `print_queue` jobs also cannot become a single status field on a template. No printing table was established as a safe removal candidate.

## Performance and execution boundary

The performance target is less duplicate work per checkout, a smaller set of locks, and bounded report/list reads. A smaller count in phpMyAdmin is a useful cleanup result but not a benchmark. MySQL's guidance focuses on row/index footprint and access patterns, and explicitly recognizes cases where splitting frequently scanned data can help: [Optimizing Data Size](https://dev.mysql.com/doc/refman/8.4/en/data-size.html). This is general design guidance, not an assertion that MySQL 8.4 DDL or collation defaults apply to the inspected MariaDB 10.4 installation.

No proposed consolidation was implemented or timed. The local core stock tables are empty, so an EXPLAIN on them would not establish performance at a busy restaurant. No Hostinger server, production data, physical printer, or other developer's deployment was accessed. Existing historical acceptance reports were read as context; their test results were not rerun or presented as validation of this proposal.

Keep implementation to three coherent stages when authorized:

1. **Retired schema cleanup:** test current/fresh/older upgrade paths, empty versus populated archives, dependency checks and repeat startup. Preserve migration history and occupied records. This can ship independently of inventory redesign.
2. **Simplify POS stock identity:** remove lot/location dimensions with original-snapshot compatibility; evaluate the two ingredient one-to-one merges. First add differential tests for checkout, shared ingredients, tables/held orders, partial/full original-source returns, independent flags, pause/resume, zero/unknown stock, counts/corrections, rollback and duplicate network retries. Compare query counts, lock waits and p50/p95 at realistic volume before accepting a merge.
3. **Evaluate one movement writer:** prototype typed ingredient/product movements on an isolated fixture, prove before/after cost/balance/report parity, including correction across business days and report-worker interruption. Only then choose the final migration. Keep this separate from stage 2 if it grows beyond a focused change.

Every implemented schema change must follow [the migration workflow](C:/xampp/htdocs/posapp/docs/agents/database-migrations.md): reviewed migration source, predecessor/checksum handling, fresh-baseline/manual-fallback consistency, guarded upgrade fixtures and verification. Before a destructive migration, prove a backup restore and define how the matching application version is restored; application-only rollback is insufficient after columns/tables are removed. Use [focused verification boundaries](C:/xampp/htdocs/posapp/docs/agents/verification.md); no production tests are implied by this audit.

## Complete fresh-table inventory

This groups every baseline table exactly once. Grouping is an inventory, not a claim that every feature received an exhaustive correctness audit.

| Family | Count | Tables |
| --- | --- | --- |
| Platform, access and audit | 10 | `settings`, `schema_migrations`, `users`, `webauthn_recovery_codes`, `webauthn_credentials`, `auth_sessions`, `webauthn_ceremonies`, `permissions`, `user_permissions`, `audit_events` |
| Menu and pricing | 7 | `categories`, `products`, `product_price_overrides`, `price_history`, `order_types`, `product_bundle_items`, `bundle_modifications` |
| Sales, floor, shifts and documents | 19 | `service_charge_snapshots`, `audit_report_documents`, `sections`, `restaurant_tables`, `shifts`, `expense_categories`, `expenses`, `customers`, `orders`, `order_items`, `refunds`, `refund_items`, `jofotara_documents`, `held_orders`, `master_held`, `invoice_sequences`, `daily_sequences`, `daily_order_type_sequences`, `qr_table_drafts` |
| Platform settlements | 3 | `platform_remittances`, `platform_remittance_lines`, `platform_remittance_adjustments` |
| Printing | 8 | `spooler_stations`, `spooler_agents`, `printers`, `printer_categories`, `print_queue`, `print_templates`, `print_template_revisions`, `print_template_revision_tests` |
| Subscriptions | 8 | `subscription_plans`, `subscription_plan_products`, `customer_subscriptions`, `subscription_collections`, `customer_subscription_products`, `subscription_extensions`, `subscription_redemptions`, `subscription_redemption_items` |
| Operational inventory and recipes | 14 | `stock_operations`, `stock_items`, `stock_locations`, `stock_lots`, `stock_balances`, `stock_movements`, `product_stock_links`, `stock_ingredient_links`, `stock_operation_sources`, `ingredients`, `product_recipe_lines`, `ingredient_movements`, `recipe_ledger_lines`, `ingredient_working_balances` |
| Inventory reports | 11 | `stock_report_builds`, `stock_report_dirty`, `stock_report_worker`, `stock_report_meals`, `stock_report_ingredients`, `stock_report_events`, `stock_report_operations`, `stock_report_backfill`, `stock_report_counts`, `stock_report_count_corrections`, `stock_report_daily` |
| **Total** | **80** | |
