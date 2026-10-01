# POS ERP Readiness Discussion

Date: 2026-07-18
Status: Deferred discussion; no implementation is authorized by this document.

## Purpose

This document preserves the discussion about evolving the POS into the sales side of an in-house ERP. The intended future consumers are our own inventory and accounting modules, not public third-party integrations.

This is not a phased plan. It records the current assessment, the architectural direction we agreed is sensible, the evidence found during the read-only audit, and the cleanup decisions that can be revisited later.

## Current conclusion

The POS does not need a rewrite. Its financial core is a strong foundation:

- Checkout and refunds use transactions and row locks.
- Checkout supports idempotency.
- Prices, taxes, discounts, service charges, and payment totals are validated server-side.
- Sale-time product names, prices, quantities, and tax values are retained in order items.
- Refunds retain subtotal, tax, total, method, actor, shift, and time.
- Service-charge settings are snapshotted for table workflows.
- Receipt presentation already has an explicit versioned financial model.
- The durable print queue demonstrates a proven local pattern for retryable work.

The main weakness is not the sales calculation engine. It is the boundary around it: schema deployment is not fully authoritative, some business logic still lives in route modules, and the current stock balance is not an inventory ledger.

The recommended long-term shape is a modular monolith. The POS remains the authoritative source for finalized sales, refunds, and POS expenses. Inventory and accounting can consume durable, versioned internal ERP events without being allowed to block checkout.

## Proposed internal ERP boundary

The smallest reliable future integration is an append-only internal event stream, not a generic webhook or plugin platform.

A future `erp_events` record would be inserted in the same database transaction as the source document. Events would represent facts such as:

- Sale finalized.
- Refund issued.
- Expense recorded.
- Expense canceled.
- Inventory moved.

Our own modules could poll events by monotonic ID and process them idempotently. Held orders, unpaid table orders, and ordinary operational drafts must never be treated as accounting revenue.

The accounting module should post journals from finalized source documents and events, not copy daily-report queries. The inventory module should maintain movements and balances locally without requiring a remote accounting response before checkout completes.

## Inventory foundation discussion

The current product table supports a simple optional stock balance, but it is not yet an accounting-grade inventory model.

Audit facts:

- `products.stock` is an integer.
- Order and bundle quantities support three decimal places.
- The current data already contains a fractional order quantity of `0.500`.
- Stock tracking is currently disabled.
- All 189 current products have `stock = NULL`, so the type mismatch is not presently corrupting balances.
- Stock is changed directly by checkout/refund code rather than through an append-only movement record.
- Bundle checkout currently travels through the ordinary top-level stock path; a real inventory module must decide whether to consume bundle components or recipe ingredients.
- `products.warehouse_id` exists without a warehouse table or working warehouse feature.

The minimum credible inventory foundation would be an `inventory_movements` ledger with a decimal quantity delta, reason, source document and line, actor, time, and cost snapshot. `products.stock` could remain as a fast cached balance, but every mutation would be backed by a movement in the same transaction.

Warehouses, suppliers, purchasing, recipes, transfers, and costing methods should not be built until their actual requirements exist. The movement ledger is the useful foundation; the rest would currently be speculative.

## Accounting document discussion

The current database already preserves most facts required to construct a reliable sale document:

- Invoice and order identity.
- Order and invoice timestamps.
- Cash, card, and split tender totals.
- Subtotal, tax, discount, service-charge, and final total information.
- Item quantity, price, tax rate, tax amount, and name at sale.
- Separate refund documents and refund items.
- Drawer and outside-POS expense documents.

Several semantics should be normalized at the future ERP boundary rather than forcing a large schema rewrite immediately:

- `orders.payment_method` currently mixes tender values (`cash`, `card`, `split`) with lifecycle values (`unpaid_table`, `voided`). An ERP document builder can expose separate `status` and `payment_method` fields without immediately changing the 100+ existing callers.
- Service-charge lines are currently recognized through a null product and the `Auto-Gratuity` note. Accounting should consume a canonical line classification rather than parse that magic string. An explicit persisted line type can be considered when the ERP document builder is implemented.
- The business date is derived from the current timezone and day-start configuration. A future event should snapshot both the UTC occurrence time and the business date so later configuration changes do not reclassify history.
- Historical cost of goods sold cannot be reconstructed from the current live `products.cost_price`. Inventory movements must capture the applicable unit cost.
- Outside-POS expenses do not yet identify the accounting cash/bank account used. That mapping belongs in the accounting design when it is built.

## Schema and data-integrity audit

Positive schema facts:

- The live database has 31 tables.
- All current tables use InnoDB.
- Every current table has a primary key.
- Core financial amounts use decimal columns.
- Useful foreign keys, unique constraints, checks, and indexes are already present.

Important integrity finding:

- The bundle migration defines foreign keys from `product_bundle_items` to `products`, but those foreign keys are absent in the live database.
- Eight live bundle-component rows reference missing bundle product `190`.
- One historical order references an order type that no longer exists. This may be an intentional historical-retention case, but it reinforces the need to distinguish operational constraints from historical snapshots.

The stale bundle rows must not be deleted automatically. Before cleanup, confirm that bundle product `190` is intentionally gone and that those eight component definitions are not recoverable catalog data. Once confirmed, the stale rows can be removed and the intended foreign keys restored.

## Migration authority discussion

There is no migration ledger recording which migration files were applied to each database. The current drift checker compares development and test databases; if both drift in the same way, it can still report success.

Some runtime services also inspect and alter tables:

- `backend/services/printQueue.js`
- `backend/services/printerStatus.js`

The print queue performs repeated metadata checks during ordinary queue operations and can execute `ALTER TABLE` when expected columns or indexes are absent. This duplicates migration responsibility, requires runtime DDL privileges, and can allow installations to converge on different schemas.

The smallest suitable authority model for the current phpMyAdmin deployment workflow is:

- SQL migration files remain canonical.
- A small `schema_migrations` table records migration filename, checksum, and applied time.
- phpMyAdmin production-sync files apply changes and record their migration versions.
- Server startup validates the required schema version and reports a clear missing-migration error.
- Ordinary runtime services stop issuing DDL.

No migration framework, cloud deployment system, or new dependency is required.

## Code-boundary audit

Several good reusable services already exist, including the POS calculator, service-charge calculator, receipt presentation, expense service, and table settlement context.

The clearest boundary problem is that multiple service modules import financial SQL from route modules. Examples include daily sales, refund, product, shift, audit, and financial metric builders importing `backend/routes/admin/helpers.js`. `auditReportBuilder` also imports `backend/routes/admin/financeMetrics.js`, even though that file contains service logic rather than an HTTP router.

The practical cleanup is small:

- Move financial query expressions from the admin route helper into a service-level financial SQL module.
- Move `routes/admin/financeMetrics.js` into services.
- Leave HTTP response helpers, middleware, and pagination in the route layer.
- Avoid repository interfaces or a class for every table.

The expense implementation is a useful pattern: routes handle transport and permissions, while `expenseService` owns shared validation and business behavior inside a caller-supplied transaction.

Audit-event inserts are also repeated in several workflows. A small transaction-aware audit append function would make actor, entity, JSON, and IP handling consistent without introducing an event framework.

## Overengineering audit retained for later

### Unused warehouse field

`products.warehouse_id` has no current application behavior, warehouse table, or foreign key. It can be removed now and reintroduced correctly through inventory locations and movements when multi-location inventory becomes a real requirement.

### Repeated rate limiters

`server.js` contains nearly identical in-memory rate-limiter implementations for general, public, and checkout traffic. This is a code-quality cleanup, not an ERP blocker. One small shared factory/helper would be sufficient. Redis or a distributed limiter is unnecessary for the current single-process installation.

The spooler limiter should remain separate because it uses a different identity and operating profile.

### Redundant indexes

The live audit found:

- Two `print_queue` indexes with the same `(status, created_at)` columns.
- A `qr_table_drafts` secondary unique index duplicating its primary key.
- A `restaurant_tables` non-unique index whose columns are already covered by a unique index.

These are not emergency performance problems. They add write and schema-maintenance overhead and should be removed through a reviewed migration after confirming that no foreign key depends on the redundant index.

### Runtime schema repair

Runtime DDL duplicates migration responsibility and is the highest-value cleanup in this group. It should be replaced by authoritative migrations plus startup validation before an ERP event or inventory foundation is added.

## Candidate work that is useful before the ERP is built

These are independent discussion choices, not ordered phases:

1. **Schema authority and runtime DDL cleanup**

   Add a migration ledger compatible with phpMyAdmin, move existing print/printer schema requirements into canonical migration SQL, and make runtime code validate rather than alter.

2. **Bundle data-integrity cleanup**

   Confirm the fate of missing bundle product `190`, clean the eight stale definitions if appropriate, and restore the intended bundle foreign keys.

3. **Redundant-index cleanup**

   Remove only the indexes proven redundant by the live-schema audit.

4. **Service/route dependency cleanup**

   Relocate financial metrics and SQL helpers so services no longer depend on HTTP route modules.

5. **Audit-write unification**

   Introduce one small transaction-aware audit append helper and route existing audit inserts through it as affected workflows are touched.

6. **Unused warehouse-field removal**

   Remove `products.warehouse_id` from the live schema and test schema until real inventory locations are designed.

7. **Rate-limiter deduplication**

   Replace the three equivalent in-memory implementations with one shared helper. This is safe to delay because it does not affect ERP correctness.

The inventory movement ledger and ERP event stream are intentionally deferred product work, not cleanup tasks. They should be designed when inventory/accounting implementation is approved.

## Explicitly deferred

- Public third-party integration support.
- Microservices.
- OAuth or a generic API-client platform.
- A plugin or connector framework.
- Full warehouse, supplier, purchasing, recipe, transfer, or costing features.
- A wholesale rewrite of checkout or table settlement.
- An immediate migration separating order status from payment method.
- Accounting journals inside the POS application.
- Inventory or accounting calculations based on daily report output.

## Decision status

The ERP, inventory ledger, accounting integration, and receipt-builder hardening are deferred. This document exists so the investigation and decisions are not lost.

Any cleanup selected from this discussion should receive its own narrowly scoped implementation review before database or production changes are made.
