# Progressive Split-Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the existing cent-safe split protocol while keeping the live table open through progressive seat payments and releasing it only after the final bucket settles.

**Architecture:** `held_orders` remains the unpaid bucket store and gains nullable relational parent/table ownership. The original `unpaid_table` order remains the table and inventory authority; existing checkout creates paid child invoices, and its final-child branch closes the parent/table atomically. Active split existence is the state gate, avoiding a new group/status framework.

**Tech Stack:** Vue 3, Pinia, Express 5, MySQL/InnoDB, Vitest/Supertest, existing POS financial and JoFotara services.

## Global Constraints

- No brainstorming and no enterprise seat-assignment workflow.
- Reuse `SplitMoneyAllocator`, `PosCalculator`, `TableSettlementContext`, service-charge snapshots, receipt presentation, checkout, and audit services.
- No client-authoritative ownership or money.
- Table -> parent order -> held siblings is the canonical mutation lock order.
- Parent inventory remains deducted; split-child checkout does not deduct stock.
- Cancellation is whole-group and pre-first-payment only.
- No new runtime dependency and no duplicate calculator.

---

### Task 1: Relational split ownership

**Files:**
- Create: `backend/migrations/2026-07-24-progressive-split-checks.sql`
- Create: `backend/migrations/2026-07-24-progressive-split-checks-verify.sql`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`

**Interfaces:**
- Produces: nullable `held_orders.parent_invoice_id`, `held_orders.table_id`, indexes and foreign keys.

- [ ] Add a failing schema-authority assertion for both columns and indexes; run the focused unit test and confirm RED.
- [ ] Add both columns to the test seed and an idempotent phpMyAdmin-safe migration that backfills valid split parents from JSON and derives table ownership from `orders`.
- [ ] Add a read-only verifier and update schema authority; run the focused test GREEN.

### Task 2: Create progressive buckets without closing the table

**Files:**
- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/modules/tables/splitChecks.js`

**Interfaces:**
- Produces: `assertNoActiveSplitChecks(conn, invoiceIds)` and progressive `createSplitChecks`.

- [ ] Write integration tests proving split creation leaves parent `unpaid_table`, table/group occupied, original stock unchanged, relational ownership populated, and duplicate split creation rejected; observe RED.
- [ ] Remove split-time restock/parent void/table release, persist ownership columns, replace `void_split` with a durable split-open audit, and export one shared active-split assertion.
- [ ] Run focused split tests GREEN, including cents, bundles, discount, tax mode, service charge, ownership, and rollback tests.

### Task 3: Gate every conflicting parent mutation

**Files:**
- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/tests/integration/checkout.test.js`
- Modify: `backend/modules/tables/saveTableOrder.js`
- Modify: `backend/modules/tables/tableRelationships.js`
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/routes/pos/tables.js`
- Modify: `src/pos/stores/orderSessionStore.js`

**Interfaces:**
- Consumes: `assertNoActiveSplitChecks`.
- Produces: HTTP 409 with `SPLIT_CHECKS_OPEN` for normal edit/settle/structural operations and table-order load routing metadata.

- [ ] Write RED tests for normal parent checkout, parent save, transfer/swap/merge, join, and disjoin while splits are open.
- [ ] Apply the one shared gate after canonical table/order locks; make table-order GET identify active splits so the frontend routes the operator to the split board instead of loading an editable parent.
- [ ] Run the focused integration and order-session tests GREEN.

### Task 4: Progressive child settlement and final release

**Files:**
- Modify: `backend/tests/integration/checkout.test.js`
- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/services/ServiceChargeSnapshotService.js`

**Interfaces:**
- Consumes: relational split ownership and existing checkout protocol.
- Produces: intermediate child settlement that keeps the table open and final child settlement that voids the parent lifecycle and releases the group.

- [ ] Write RED tests proving first payment removes only its bucket, leaves parent/table open, does not deduct stock again, and creates a paid child with exact parent lineage.
- [ ] Write RED tests proving final payment alone zeroes/voids the parent, releases joined tables, preserves total inventory once, and survives concurrent payment attempts without mismatch.
- [ ] Change split checkout to probe ownership, lock table/group and parent through the existing table context, lock all sibling holds deterministically, and authenticate the selected row.
- [ ] Skip inventory deduction for split children. On the last sibling only, close the parent lifecycle, complete the parent service-charge state, release the table group, audit, and broadcast table/held changes.
- [ ] Run checkout/table/service-charge tests GREEN.

### Task 5: Safe cancel-and-resplit

**Files:**
- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/modules/tables/splitChecks.js`
- Modify: `backend/routes/pos/tables.js`
- Modify: `backend/services/ServiceChargeSnapshotService.js`
- Modify: `src/components/TableSplits.vue`
- Modify: `src/pos/stores/orderSessionStore.js`
- Modify: `src/pos/useTables.js`

**Interfaces:**
- Produces: `cancelSplitGroup(id)` behind the existing DELETE endpoint.

- [ ] Write RED tests proving cancellation deletes every unpaid sibling and restores the parent snapshot without changing order/items/stock/table, while cancellation after one paid child returns 409 and changes nothing.
- [ ] Replace progressive per-seat discard with locked whole-group cancellation; preserve the audited legacy discard fallback for pre-migration rows.
- [ ] Add one group-level Cancel & Resplit action to the existing board and route back to the still-open table after success.
- [ ] Run focused backend and frontend tests GREEN.

### Task 6: Remaining balance, realtime, and compatibility

**Files:**
- Modify: `backend/routes/pos/tables.js`
- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `src/pos/stores/orderSessionStore.js`

**Interfaces:**
- Produces: `active_split_count` and remaining `active_order_total` on the floor; post-confirm navigation to `/table-splits`.

- [ ] Write RED tests for the remaining floor total after each payment, split-list relational filtering with safe legacy fallback, and post-confirm frontend navigation.
- [ ] Join one grouped held-order aggregate into both table-list queries, emit table and held refresh events after create/pay/cancel, and navigate split creation directly to the board.
- [ ] Run focused tests GREEN.

### Task 7: Aggressive verification and cleanup

**Files:**
- Modify only files needed by findings.

- [ ] Run split/table/checkout/refund/receipt/JoFotara/service-charge/inventory/order-session suites.
- [ ] Run schema authority and drift validation after applying the migration to dev and test databases.
- [ ] Run `npm test` production build.
- [ ] Search for stale split-time parent restock/release/void behavior, JSON-only ownership, duplicated active-split queries, and missing socket emissions; fix findings with a RED test first.
- [ ] Review the diff with ponytail: delete speculative helpers/files and retain only the minimum proven lifecycle.
