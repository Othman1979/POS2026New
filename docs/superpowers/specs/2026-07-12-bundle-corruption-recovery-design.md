# Bundle Corruption Recovery Design

**Date:** 2026-07-12
**Status:** Approved design
**Scope:** Persisted bundle structure validation, fail-closed behavior, recovery guidance, and DB prevention

## Problem

Bundle sales persist one priced parent `order_items` row plus zero-priced child rows linked through `parent_item_id`. Current code assumes every child has a parent in the same invoice and every parent quantity is positive.

Those invariants are not fully enforced:

- `parent_item_id` references any `order_items.id`; it does not require child and parent to share `invoice_id`.
- `order_items.quantity` is `NOT NULL` but has no positive-value constraint.
- `reconstructBundleSubs` divides child quantity by parent quantity without validating it.
- Kitchen expansion converts a falsy parent quantity, including zero, to one.
- Some read and mutation paths silently skip children whose parent is absent from the loaded invoice.

This creates inconsistent behavior across table recall, checkout, merge, split, refunds, receipts, and kitchen routing. A corrupt row may disappear, become `null` after JSON serialization, acquire an invented quantity, print without its bundle label, or propagate into another order.

## Verified Baseline

Direct experiments against current code produced:

- Parent quantity `0`: division produces `Infinity`; JSON serialization emits `null`.
- Parent quantity `-1`: reconstructed child quantity becomes negative.
- Missing parent object: reconstruction throws an untyped `TypeError`.
- Kitchen nested-bundle quantity `0`: current fallback treats it as `1`.

A read-only scan of the configured production DB on 2026-07-12 found zero:

- dangling parent references;
- cross-invoice parent references;
- non-positive quantities anywhere in `order_items`;
- non-positive referenced parent quantities;
- non-positive bundle-child quantities;
- active unpaid-table instances of those states.

The work therefore prevents and defines recovery for possible corruption; it does not migrate known corrupt production rows.

## Decision

Use fail-closed runtime validation plus DB prevention and explicit manual recovery.

Do not automatically infer or repair bundle quantities. Persisted rows do not contain a durable snapshot of the bundle definition, so current catalog composition cannot prove historical intent. Missing parents are similarly not reconstructable from child rows alone.

Do not add a quarantine table, order status, repair endpoint, or dedicated frontend workflow. A corrupt order is logically quarantined because guarded operations reject it until its rows are explicitly repaired.

## Integrity Contract

### Relational `order_items`

For an invoice row set:

1. Every row with `parent_item_id != null` resolves to a parent inside the same row set.
2. Child and parent carry the same `invoice_id` whenever that field is present on both rows; callers may not make a cross-invoice link look valid by loading both invoices together.
3. A resolved parent has `parent_item_id == null`; bundle nesting is invalid.
4. Referenced parent quantity is finite and greater than zero.
5. Child quantity is finite and greater than zero.

Validation is structural only. It does not require the parent product to remain marked `is_bundle`, and it does not compare historical children with the current `product_bundle_items` definition. Catalog edits must not invalidate historical sales.

A top-level bundle product with no child rows is not classified as corrupt. All members may have been intentionally removed, and current persistence lacks enough historical evidence to distinguish that state from a normal top-level row.

### Nested persisted carts and holds

For any item carrying `bundleItems`:

1. Parent quantity is finite and greater than zero.
2. Every child not marked `removed: true` has a finite quantity greater than zero.
3. Removed children may retain absent or legacy quantity metadata because they are neither persisted as active child rows nor routed to the kitchen.

The validator never mutates input, substitutes defaults, or derives values from current catalog data.

## Architecture

Add one focused module: `backend/services/bundleIntegrity.js`.

It exposes two pure guards:

- `assertOrderItemBundleIntegrity(rows)` validates flat relational invoice rows.
- `assertNestedBundleIntegrity(items)` validates nested held/cart bundle data.

Both throw an application error with:

- `statusCode: 409`
- internal `publicCode: 'BUNDLE_ORDER_CORRUPT'`
- safe public message: `Order bundle data is inconsistent. Manager repair required.`
- internal reason and implicated row IDs for structured logging only.

Validation uses maps and runs in `O(n)`. It performs no DB queries.

## Runtime Boundaries

Persisted structure must be validated immediately after loading and before totals, stock, audit, printing, deletion, or writes at these boundaries:

- active table recall and re-save;
- table checkout settlement;
- table merge and split;
- paid refund and unpaid partial/full void;
- held-order claim and kitchen fire;
- split-check settlement;
- DB receipt detail and reprint;
- kitchen routing from both nested and DB-row shapes.

Routes already loading complete invoice rows reuse them. Routes loading parents only issue one full-invoice validation query. No per-row queries are introduced.

`reconstructBundleSubs` also asserts its parent and child inputs so future callers cannot bypass the boundary guards. Kitchen expansion removes its `0 -> 1` fallback and fails with the same typed contract.

## Failure Behavior

Any integrity failure occurs before business mutation. Transactional routes roll back. Single-resource operations return HTTP `409`. Existing transport conventions remain unchanged: POS JSON uses `code: BUNDLE_ORDER_CORRUPT`, admin/print JSON uses `publicCode: BUNDLE_ORDER_CORRUPT`, and list endpoints expose `receipt_display_error: BUNDLE_ORDER_CORRUPT` on only the corrupt row. One corrupt held/history row must not 500 or hide the rest of a list.

Logs include invoice ID, route, parent/child row IDs, and one stable internal reason:

- `missing_same_invoice_parent`
- `cross_invoice_parent`
- `nested_parent`
- `non_positive_parent_quantity`
- `non_positive_child_quantity`

Order and table remain visible. Guarded operations change no money, stock, kitchen, audit, receipt, item, payment, or bundle lifecycle state.

Structural-neutral table actions that do not read, derive, or rewrite bundle rows—such as transfer/swap and status-only floor updates—remain outside the guard. Owner-approved held-order discard also remains available as an explicit recovery choice. This avoids turning integrity validation into a new global order-state subsystem.

Historical order lists remain readable. Detail and reprint operations reject corrupt structure explicitly instead of rendering an incomplete or invented document.

## DB Prevention

After a clean preflight scan, apply two guarded DDL stages:

1. First `ALTER TABLE`, while the old FK remains active:
   - add `CHECK (quantity > 0)` on `order_items`;
   - supporting unique/indexed key on `(id, invoice_id)`;
   - child-side index on `(parent_item_id, invoice_id)`.
2. Second atomic `ALTER TABLE` replaces the existing single-column self-FK with a same-invoice composite parent foreign key:
   - child `(parent_item_id, invoice_id)` references parent `(id, invoice_id)`;
   - `ON DELETE CASCADE`, preserving current bundle-family deletion behavior.

The migration must account for MariaDB 10.4.32, the configured production version verified during design. A direct DB experiment proved MariaDB cannot create this self-referential composite FK in the same `ALTER` that creates its supporting indexes (`errno: 150`). Stage 1 is safe if execution stops because the old FK remains. Stage 2 drops the old FK and adds the replacement in one atomic `ALTER`; a forced failure experiment proved MariaDB retains the old FK when that statement fails. A JS schema guard discovers the deployed FK/index names, resumes either stage idempotently, and does not assume unsupported `IF NOT EXISTS` syntax for every constraint form.

Application guards remain necessary for legacy imports, sessions created while foreign-key checks were disabled, nested JSON payloads, clearer errors, and defense in depth.

## Migration Runner

Migration runner defaults to scan-only behavior and reports affected invoice IDs, row IDs, held-order IDs, and reasons without mutation. Its CHECK preflight covers every non-positive `order_items.quantity`, including non-bundle rows, because the DB constraint is intentionally table-wide. It also parses every `held_orders.cart_data` payload and applies nested bundle validation so a deploy cannot strand a corrupt register hold or split check that DB constraints cannot see. Finally, it reports non-positive `product_bundle_items.qty` as a migration compatibility finding: the new order-item CHECK would otherwise convert a bad catalog definition into checkout-time DDL rejection when children are minted. This scan does not compare historical orders with current catalog composition.

DDL requires an explicit confirmation environment variable. Runner refuses DDL when any corruption exists. It must never print a success/refusal message after partially applying constraints.

Safe order:

1. Backup DB.
2. Run scanner.
3. Stop and repair if findings exist.
4. Apply positive-quantity and same-invoice constraints.
5. Deploy backend runtime guards.
6. Execute bundle smoke tests.

No frontend deployment is required by this work.

## Explicit Recovery

There is no generic automatic repair command.

Recovery runbook requires:

1. DB backup before changes.
2. Capture affected order, table, parent, child, audit, and bundle-definition evidence.
3. Determine intended positive parent quantity or correct parent link from backup, audit, printed check, or owner evidence.
4. Apply owner-approved SQL correction in one transaction.
5. Recompute affected open-order totals when priced parent quantity changed.
6. Verify stock/accounting implications separately; child rows carry zero money but represent kitchen composition.
7. Rerun scanner and normal order operation.

When reliable evidence is unavailable, the order remains blocked pending owner-directed void and manual accounting correction. Runtime code must not guess.

## Testing Strategy

### Pure validator tests

Cover:

- valid relational and nested bundles;
- all members intentionally removed;
- historical bundle whose current catalog definition changed;
- missing or cross-invoice parent;
- parent linked beneath another parent;
- zero, negative, `NaN`, and `Infinity` quantities;
- non-positive active child;
- removed nested child with absent legacy quantity;
- input immutability;
- stable status, public code, public message, and internal reason.

### Integration tests

Prove:

- table recall returns typed `409` for an invoice-local orphan;
- checkout, merge, split, and refund roll back without row, total, stock, or audit mutation;
- held claim and split settlement reject corrupt nested data before deleting held rows;
- kitchen routing throws instead of converting zero to one or printing an orphan standalone;
- receipt detail/reprint rejects orphan children;
- valid bundle save, recall, split, settle, merge, partial void, kitchen print, and reprint remain behavior-identical.

### Migration tests

Prove:

- clean schema accepts both constraints;
- dirty scan reports exact rows and refuses DDL;
- composite FK rejects a cross-invoice link;
- CHECK rejects zero and negative quantities;
- rollback instructions remove only the new constraints/index and do not mutate order data.

## Performance and Rollback

Validation is linear in rows per order, normally a small set. No joins or catalog lookups are added to the pure guard. Composite index adds limited write/storage overhead; order-item writes are low-volume relative to reads.

Backend code may be rolled back while DB constraints remain because existing valid write paths already require positive quantities and create same-invoice children. Constraint rollback is reserved for proven compatibility issues and never repairs or deletes data.

## Scope Exclusions

- Automatic repair or quantity inference.
- New quarantine state, table, or admin UI.
- Bundle-definition history snapshots.
- Nested bundles.
- Redesign of bundle removal or modification audit semantics.
- Deriving historical intent from current catalog definitions.
- Unrelated receipt, tax, stock, modifier, or service-charge refactors.
- Blocking structural-neutral table transfer/swap/status actions.

## Acceptance Criteria

1. Every guarded surface returns the same typed corruption contract before mutation.
2. Zero/negative parent quantities never become `null`, negative child quantities, or implicit quantity one.
3. Child rows cannot reference parents in another invoice after migration.
4. New non-positive `order_items.quantity` values are rejected by DB.
5. Migration refuses dirty DBs without partial DDL.
6. No automatic repair or silent data loss occurs.
7. Valid bundle behavior and rendered/charged money remain unchanged.
8. Recovery process is explicit, backed up, transactional, and verifiable.
