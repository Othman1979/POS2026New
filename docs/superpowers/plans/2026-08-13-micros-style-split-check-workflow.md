# MICROS-Style Split Check Workflow Implementation Plan

**Goal:** Let an operator move one selected item or quantity into another payable check while the rest remains on a visible Remaining Check, and let any still-unpaid checks be safely rebalanced without changing paid children, inventory, kitchen dispatch, or parent accounting.

**Architecture:** Keep the existing progressive split lifecycle. The parent `unpaid_table` order remains the inventory/table authority, `held_orders` remains the durable unpaid-check store, and paid child `orders` remain immutable. Initial creation still conserves the complete parent across held buckets, but the UI presents one bucket as the Remaining Check. Later edits lock table → parent → all unpaid siblings and atomically rewrite only those siblings while conserving their combined quantities and exact money components. No split operation prints to the kitchen.

**Scope guardrails:**

- No new split domain table, dependency, or parallel calculator.
- No changes to paid child invoices, JoFotara lifecycle, inventory ownership, or kitchen delta rules.
- No production migration or deployment in this task.
- Preserve all existing price/tax/modifier/bundle/service-charge pinning.
- Use stable relational IDs for ownership and grouping; `reference_name` is display only.

## Task 1: Preserve fractional quantities through settlement

**Files:**

- Modify: `backend/tests/fixtures/seed.js`
- Modify: `deployment/database/baseline.sql`
- Modify: `deployment/tools/bootstrap-database.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`
- Modify: `backend/tests/integration/tables.test.js`
- Create: `backend/migrations/2026-08-13-split-quantity-precision.sql`
- Create: `backend/migrations/2026-08-13-split-quantity-precision.auto.sql`
- Modify: `backend/migrations/auto-manifest.json`
- Modify: `deployment/database/hostinger-manual-migrations.sql`

1. Add a failing schema-authority assertion requiring `order_items.quantity` and `refund_items.quantity` to be `DECIMAL(12,6)`.
2. Add a failing integration test that creates and settles thirds/sixths, then proves paid child quantities sum exactly to the parent quantity.
3. Run only those focused tests and confirm RED from the current three-decimal columns.
4. Add the forward-only precision migration, test-fixture parity, Hostinger-safe auto migration, manifest predecessor/hash entry, and exact fallback block.
5. Apply only the new migration to the local test database and rerun focused tests GREEN.

## Task 2: Make Remaining Check a first-class client bucket

**Files:**

- Modify: `src/pos/stores/orderSession/splitChecks.js`
- Modify: `backend/tests/unit/splitChecks.test.js`
- Modify: `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `src/components/pos/SplitCheckModal.vue`
- Modify: `src/components/pos/__tests__/splitCheckModal.spec.js`
- Modify: `src/shared/i18n/ar.json`

1. Add failing helper tests proving a request contains the non-empty Remaining Check plus destination checks, rejects finalization with no destination item, and conserves a `0.50` quantity moved wholly or shared.
2. Add failing store tests proving opening a split starts with all items in Remaining Check and one empty Check 2, and finalization is allowed after moving only one item.
3. Run focused unit tests RED.
4. Extend the existing request builder to serialize the remainder as `split_role: 'remainder'`; keep the existing cent preview and server-owned allocations.
5. Simplify the modal copy and controls around Remaining Check, Check 2, Move one, Move all, and 1/2–1/4 sharing. Counts show quantities, not row counts.
6. Add natural Arabic strings and theme-token-only styling.
7. Run focused helper/store/modal tests GREEN.

## Task 3: Add an atomic unpaid-group rewrite boundary

**Files:**

- Modify: `backend/modules/tables/splitChecks.js`
- Modify: `backend/routes/pos/tables.js`
- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/services/ServiceChargeSnapshotService.js` only if a new held snapshot must be created or retired

1. Add failing integration tests for:
   - rebalancing two unpaid checks;
   - adding and removing an unpaid check;
   - editing remaining checks after one sibling was paid;
   - stale held-row version conflict;
   - omitted/duplicated/foreign parent line rejection;
   - exact subtotal/discount/tax/total and service-charge conservation;
   - concurrent edit versus payment yielding one winner;
   - no inventory or kitchen mutation.
2. Run only the new rewrite tests RED.
3. Implement `rewriteUnpaidSplitChecks` behind `PUT /api/pos/table_splits`:
   - lock through `lockSplitCheckForMutation`;
   - require progressive relational ownership;
   - verify expected IDs and versions against every currently unpaid sibling;
   - use current held siblings as the quantity and money authority;
   - re-pin submitted lines to parent `order_items` by `order_item_id`;
   - allocate the remaining exact cents with `SplitMoneyAllocator`;
   - update retained rows with `version=version+1`, insert new rows, and retire removed rows and child service snapshots;
   - append one `split_group_rebalanced` audit event;
   - commit before realtime broadcasts.
4. Rerun the focused rewrite/concurrency tests GREEN.

## Task 4: Restore unpaid groups into the editor, not the payment cart

**Files:**

- Modify: `src/pos/stores/orderSession/orderSessionApi.js`
- Modify: `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `src/components/TableSplits.vue`
- Modify: `src/components/pos/SplitCheckModal.vue`
- Modify: `src/components/pos/__tests__/splitCheckModal.spec.js`

1. Add failing store/component tests proving Edit Splits loads the entire unpaid sibling group with row IDs/versions, while Pay opens one immutable seat.
2. Add failing tests proving a paid-state group cannot expose cancel/resplit but can edit its remaining unpaid checks.
3. Run focused frontend tests RED.
4. Add `rewriteTableSplits`, `openSplitGroupEditor`, and edit-mode payload plumbing.
5. Make the split modal show Save Changes in edit mode and refresh the board after success.
6. Make restored Pay mode visibly read-only: disable quantity, note, remove, catalog additions, price/discount, and Save Table controls while retaining Print, Back, and Pay.
7. Run focused frontend tests GREEN.

## Task 5: Board clarity, recovery, and relational grouping

**Files:**

- Modify: `backend/routes/pos/tables.js`
- Modify: `src/components/TableSplits.vue`
- Modify: `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify: `src/shared/i18n/ar.json`
- Modify: focused board/store tests

1. Add failing tests proving split groups are keyed by `parent_invoice_id`, fetch failures remain visible, and actions are labelled Edit Splits / Cancel Splits according to actual capability.
2. Replace hardcoded light colors and undersized touch targets with existing POS theme tokens and minimum operational hit areas.
3. Stop treating a failed fetch as an empty board; show retryable error state.
4. Keep `reference_name` only as a display fallback for legacy rows.
5. Run focused board/store tests GREEN.

## Task 6: Architecture and final break review

**Files:**

- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`
- Modify only files required by break-review findings

1. Update the split creation/edit/settlement flow and invariants in `docs/architecture.json`; run `npm run architecture` and `npm run architecture:check`.
2. Attack the result with focused scenarios: 2 checks, `0.50`, thirds, sixths, duplicate products with different prices, fixed/percent discounts, service charge, bundles/modifiers, joined tables, edit after first payment, stale versions, simultaneous pay/edit/cancel, browser refresh, Arabic RTL, graphite/light themes, and network failure.
3. For every discovered defect, add a failing test before the smallest fix.
4. Run the split/table/checkout/refund/receipt/JoFotara/service-charge/inventory/order-session focused suites plus the production build.
5. Review the diff for unrelated changes and over-engineering. Do not touch the two pre-existing untracked plan files.
