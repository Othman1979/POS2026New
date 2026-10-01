# Table Row Void Flow Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan inline, one task at a time, with the focused checks below after each task.

**Goal:** Replace the open-table Refund modal with immediate, permission-controlled voiding from the existing row Remove and Clear actions, while keeping paid-order refunds unchanged and making every saved product void durable and easy to understand.

**Architecture:** Keep `POST /api/pos/refunds` as the only authority for removing persisted product units from a live table. The POS sends either one saved row or a whole-table request; the backend locks the order and table, applies the red/blue permission rule, writes `refunds` and `refund_items`, updates stock/totals/service charge atomically, and reports whether the table was freed. The existing table-save route may increase quantities and remove the automatic service charge, but it must reject persisted product reductions.

**Tech Stack:** Vue 3 Composition API/Pinia, Express 5, MySQL/InnoDB, Vitest/Supertest, Vite, 80mm HTML thermal printing.

---

## Non-negotiable behavior

- Scope is live table orders only: red `occupied` and blue `printed` tables. Split-check behavior and paid-order refunds in Admin → Orders do not change.
- Unsaved rows remove locally. Saved rows void immediately through the backend; there is no reason prompt and no confirmation.
- Row Remove voids the selected row's entire persisted quantity. If that row was locally increased, send only `originalQty`; the unsaved increase is not a void.
- Clear on a saved/printed table asks once: `Clear Table {table}? All saved items will be recorded as voids.` It does not mutate the cart until the server commits.
- Removing the final persisted product frees the table and returns the POS to the floor. A terminal response clears the local table draft as well.
- Saved quantities may increase under the existing edit/ownership rules, but may never decrease through the numpad or table-save payload. `DEL` remains only a numpad backspace.
- Ownership and `waiter.override_tables` never grant void authority. Admin/programmer bypass. Red requires `pos.void_item`; blue requires both `pos.void_item` and `pos.void_printed_item`. Do not require `pos.refund` or `waiter.edit_locked` for a table void.
- The backend assigns the reason: row request → `Item removed from table`; whole-table request → `Table cleared`. Client-supplied void reasons are ignored.
- Automatic service charge is never written to `refund_items` for this table-void flow. Its removal remains the existing admin/programmer-only action and creates no refund, void, reason, or audit row.
- No manager PIN, no kitchen cancellation ticket, no new roles, no A4 report, and no redesign beyond clear disabled/locked states.
- Preserve the existing uncommitted service-charge fix in `backend/routes/pos/tables.js` and its tests in `backend/tests/integration/serviceChargeSnapshots.test.js`. Do not reset, overwrite, or hide it in an unrelated commit.

## Task 0: Protect the current working tree

**Files:**

- Existing modification: `backend/routes/pos/tables.js`
- Existing modification: `backend/tests/integration/serviceChargeSnapshots.test.js`

1. Run `git diff -- backend/routes/pos/tables.js backend/tests/integration/serviceChargeSnapshots.test.js` and confirm the current work is the null discount-type fix plus the 1.50 tax-inclusive checkout regression test.
2. Create `codex/table-row-void-flow` from the current `master` without stashing or discarding those edits.
3. Run the existing focused regression before feature edits:

   ```powershell
   npx --no-install vitest run backend/tests/integration/serviceChargeSnapshots.test.js --pool=forks --maxWorkers=1
   ```

4. Commit only that already-completed fix first:

   ```powershell
   git add -- backend/routes/pos/tables.js backend/tests/integration/serviceChargeSnapshots.test.js
   git commit -m "fix(pos): preserve automatic service charge on table reload"
   ```

## Task 1: Make the backend void contract state-aware and durable

**Files:**

- Create: `backend/migrations/2026-07-14-refund-table-number.sql`
- Create: `backend/migrations/apply-refund-table-number.js`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `backend/tests/integration/refunds.test.js`
- Modify: `backend/routes/pos/helpers.js`
- Modify: `backend/routes/pos/refunds.js`

1. Add `refunds.table_number VARCHAR(50) NULL` to the fixture schema and an idempotent migration:

   ```sql
   ALTER TABLE refunds
     ADD COLUMN IF NOT EXISTS table_number VARCHAR(50) NULL AFTER table_id;
   ```

   This is a snapshot, not a join-only display field, so a later table rename or deletion cannot erase the audit identity. Add a small runner matching `apply-orders-tax-mode-at-sale.js`; require `REFUND_TABLE_NUMBER_MIGRATION_CONFIRM=apply-refund-table-number`, load `.env` or `.env.test` from `NODE_ENV`, apply the SQL when the column is absent, and exit cleanly when it already exists.

2. Add failing integration cases proving:

   - `occupied` + `pos.void_item` succeeds without `pos.refund`, `pos.void_printed_item`, or `waiter.edit_locked`.
   - `occupied` without `pos.void_item` fails with 403.
   - `printed` succeeds only with both void permissions; test each missing permission.
   - Admin/programmer bypass still succeeds.
   - `pos.refund` alone still governs paid refunds and does not authorize open-table voids.
   - A void is rejected with 409 unless `orders.table_id` points to a red/blue table whose `current_order_id` is the locked order.
   - Item requests store `Item removed from table`; omitted-item requests store `Table cleared`, even if the client submits another reason.
   - The refund row snapshots the current table number, actor, and timestamp.

3. Run the focused red tests:

   ```powershell
   npx --no-install vitest run backend/tests/integration/refunds.test.js --pool=forks --maxWorkers=1
   ```

4. Change `assertCanVoidSavedUnits` to accept the locked table state:

   ```js
   assertCanVoidSavedUnits(user, { isPrinted })
   ```

   Admin/programmer returns immediately. Otherwise require `pos.void_item`, and additionally require `pos.void_printed_item` only when `isPrinted === true`. Remove the `waiter.edit_locked` requirement.

5. In `POST /api/pos/refunds`, parse `intent` before permission routing. Keep `pos.refund` for `intent='refund'`. For `intent='void'`, lock and validate the order, then lock its current table and call the state-aware void helper. Do not use ownership or table-override permission as a substitute.
6. Set the server-owned void reason from request shape (`items` supplied versus omitted), insert `table_number` with the refund row, and keep the existing user, shift, table ID, IP, and timestamp fields.
7. Re-run the full refunds file and commit:

   ```powershell
   npx --no-install vitest run backend/tests/integration/refunds.test.js --pool=forks --maxWorkers=1
   git add -- backend/migrations/2026-07-14-refund-table-number.sql backend/migrations/apply-refund-table-number.js backend/tests/fixtures/seed.js backend/tests/integration/refunds.test.js backend/routes/pos/helpers.js backend/routes/pos/refunds.js
   git commit -m "feat(pos): authorize table voids by table state"
   ```

## Task 2: Keep service charge out of void records and recalculate it safely

**Files:**

- Modify: `backend/tests/integration/refunds.test.js`
- Modify: `backend/tests/integration/serviceChargeSnapshots.test.js`
- Modify: `backend/routes/pos/refunds.js`
- Modify: `backend/routes/pos/helpers.js`
- Use existing: `backend/services/ServiceChargeCalculator.js`
- Use existing: `backend/services/ServiceChargeSnapshotService.js`

1. Add failing tests for all of these cases:

   - Partial product void with an automatic charge: only the product appears in `refund_items`; the remaining fee is recalculated from remaining products; order totals reconcile.
   - Whole Clear with an automatic charge: product rows are recorded, no `Auto-Gratuity` row is recorded, the table frees, and its `open_order` snapshot becomes `abandoned`.
   - Removing the last product through row Remove frees the table even though a fee row exists.
   - Selecting the fee row directly is rejected and writes no refund/refund item.
   - Line discount, fixed and percentage order discounts, exclusive tax, and inclusive tax each produce correct remaining subtotal/tax/total after a partial void.
   - Existing direct admin/programmer fee removal still creates zero rows in `refunds` and `refund_items`.

2. Run the focused red cases:

   ```powershell
   npx --no-install vitest run backend/tests/integration/refunds.test.js backend/tests/integration/serviceChargeSnapshots.test.js --pool=forks --maxWorkers=1
   ```

3. In the void path only, define business parent rows as `parent_item_id == null && note !== SERVICE_NOTE`. Resolve selections, `emptiesOrder`, money, restocking, and `refund_items` from those rows. Keep paid-refund selection behavior unchanged.
4. Reject a request that explicitly targets an `Auto-Gratuity` row. Omitted items means all remaining business rows, never the fee.
5. On a partial product void:

   - Lock the bound service-charge snapshot if one exists.
   - Recalculate the fee with the existing `serviceChargeFee` and frozen snapshot percentage.
   - Update the single fee row's canonical name, price, quantity, tax rate, and null/zero discount fields; increment the snapshot with `touchOpenOrder`.
   - If the new fee is zero, delete the fee row, abandon the snapshot, and clear `orders.service_charge_snapshot_id` so the next save cannot fail on an invalid zero fee.
   - Call `recomputeOrderTotals` after product and fee mutations, inside the same transaction.

6. On a terminal product void, abandon an `open_order` snapshot before commit. Keep the historical fee row on the voided order if useful for the original bill, but never copy it to `refund_items` and never let it keep the table occupied.
7. Make `recomputeOrderTotals` read `orders.tax_inclusive_at_sale`; use the live setting only as a fallback for legacy null rows. This prevents a later setting change from altering an open table's tax mode during void reconciliation.
8. Run both focused files and commit:

   ```powershell
   npx --no-install vitest run backend/tests/integration/refunds.test.js backend/tests/integration/serviceChargeSnapshots.test.js --pool=forks --maxWorkers=1
   git add -- backend/routes/pos/refunds.js backend/routes/pos/helpers.js backend/tests/integration/refunds.test.js backend/tests/integration/serviceChargeSnapshots.test.js
   git commit -m "fix(pos): reconcile service charge after table voids"
   ```

## Task 3: Close the legacy table-save removal bypass

**Files:**

- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/routes/pos/tables.js`

1. Replace the old tests that expect saved quantity reductions or empty-cart voids through `POST /api/pos/table_order` with failing tests that expect 409 and no mutation to orders, items, stock, tables, refunds, or audit rows.
2. Retain explicit green tests for:

   - Increasing a saved product quantity.
   - Adding a new product row.
   - Admin/programmer removal of `Auto-Gratuity` through `auto_service_charge_removed`, with no refund/void record.
   - Split-check behavior.

3. Run the table integration file and confirm the replacement tests fail:

   ```powershell
   npx --no-install vitest run backend/tests/integration/tables.test.js --pool=forks --maxWorkers=1
   ```

4. In the existing-order table-save transaction, compare only persisted business parent rows (`note !== SERVICE_NOTE`) with submitted business rows. If any saved quantity is missing or lower, return 409 with `Saved items must be removed with the Remove action.` before any stock, order, fee, or audit mutation.
5. Reject an existing order submitted with an empty cart through this route. Preserve the separate, explicit automatic-fee removal path and exclude the fee from product-reduction detection.
6. Remove the now-unreachable legacy saved-reduction and empty-cart void mutation/audit code, then use `rg` to remove only imports that truly have no remaining caller in `tables.js`.
7. Run the table and refunds regressions and commit:

   ```powershell
   npx --no-install vitest run backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js --pool=forks --maxWorkers=1
   git add -- backend/routes/pos/tables.js backend/tests/integration/tables.test.js
   git commit -m "fix(pos): route saved table removals through voids"
   ```

## Task 4: Replace the table Refund modal with Remove and Clear

**Files:**

- Delete: `src/components/pos/RefundModal.vue`
- Modify: `src/components/PosTerminal.vue`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `assets/js/composables/useCart.js` only if its exported contract changes
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `assets/js/admin/i18n.js`

1. Rewrite/add store tests covering:

   - Unsaved selected row removes locally and makes no request.
   - Saved selected row posts `{ invoice_id, intent: 'void', items: [{ order_item_id, qty: originalQty }] }` immediately and shows no confirmation.
   - The selected row is not removed locally when the request fails.
   - A successful partial void reloads authoritative saved rows while preserving unrelated unsaved rows; it never restores the removed row or its unsaved quantity increase.
   - `table_freed: true` clears the complete table draft and returns to the floor.
   - Saved Clear shows the exact one-confirmation copy, posts a whole void with no `items`, discards unsaved additions only after success, and preserves everything on failure/cancel.
   - Red and blue permission matrices match the backend; unsaved Remove remains available without void permission.
   - Numpad input cannot set a saved row below `originalQty`; quantity increase still follows the existing edit/ownership rules.

2. Run the store file and confirm the new cases fail:

   ```powershell
   npx --no-install vitest run backend/tests/unit/orderSessionStore.test.js
   ```

3. Refactor `processRefund` into a quiet request primitive that returns the server payload and throws on failure. Let the calling Remove/Clear action own its specific success/error message so there is no generic duplicate toast.
4. Make `removeSelectedCartItem` asynchronous:

   - Service-charge row continues to use its existing admin/programmer removal control, not the void endpoint.
   - Unsaved product row splices immediately.
   - Saved product row checks the state-aware UI permission, posts only its persisted quantity, waits for commit, and then refreshes or closes the table from the response.
   - Disable repeated clicks while the request is running.

5. Make `clearCart` branch by persistence:

   - No saved product rows: keep current local clear behavior.
   - Saved/printed table: check the same state-aware permission, show the one confirmation, call whole-table void, and clear only after success.

6. In `applyLiveNumpad`, leave a saved row unchanged when the typed result is below `originalQty` and show `Use Remove to remove a saved item.` Do not make backspace itself a void action.
7. Remove the top-bar `مرتجع`/Refund button, `RefundModal` import/render/state, and delete the component. Keep Admin → Orders paid-refund UI untouched.
8. Give Remove and Clear a visible disabled/lock treatment only when a saved action is unauthorized. Do not disable removal of unsaved rows. Add natural translations:

   - `Item removed from table` → `تم حذف الصنف من الطاولة`
   - `Table cleared` → `تم إخلاء الطاولة`
   - `Clear Table {table}? All saved items will be recorded as voids.` → `إخلاء الطاولة {table}؟ ستُسجّل جميع الأصناف المحفوظة كإلغاءات.`
   - `Use Remove to remove a saved item.` → `استخدم زر الحذف لإلغاء صنف محفوظ.`
   - `You do not have permission to void saved items.` → `لا تملك صلاحية إلغاء الأصناف المحفوظة.`

9. Run the store tests and Vue build, then commit:

   ```powershell
   npx --no-install vitest run backend/tests/unit/orderSessionStore.test.js
   npm run build:admin
   git add -- src/components/PosTerminal.vue src/components/pos/RefundModal.vue assets/js/composables/stores/orderSessionStore.js assets/js/composables/useCart.js backend/tests/unit/orderSessionStore.test.js assets/js/admin/i18n.js
   git commit -m "feat(pos): void saved table items from cart actions"
   ```

## Task 5: Show table-first identity in Refunds & Voids

**Files:**

- Modify: `backend/services/dailyRefundReportBuilder.js`
- Modify: `backend/tests/integration/reportsRefunds.test.js`
- Modify: `src/admin/pages/ReportsRefunds.vue`
- Modify: `src/admin/pages/dailyReportPayloads.js` if it currently strips the new field
- Modify: `src/admin/pages/__tests__/dailyReportPayloads.spec.js`
- Modify: `src/admin/pages/__tests__/dailyReportsLocalization.spec.js`
- Modify: `pos-spooler-printer/report-html.js`
- Modify: `pos-spooler-printer/tests/report-html.test.js`
- Modify: `src/print/PrintReceiptApp.vue`
- Modify: `assets/js/admin/i18n.js`

1. Add failing report and print tests proving:

   - A void event exposes `table_number` from the refund snapshot.
   - The screen and 80mm output display `Table 4` / `الطاولة 4` as the primary identity for a void.
   - A paid refund continues to display its invoice number.
   - Actor, local date/time, and translated fixed reason remain visible.
   - Searching refunds by table number finds the void.

2. Run the report/print red tests:

   ```powershell
   npx --no-install vitest run backend/tests/integration/reportsRefunds.test.js src/admin/pages/__tests__/dailyReportPayloads.spec.js src/admin/pages/__tests__/dailyReportsLocalization.spec.js pos-spooler-printer/tests/report-html.test.js --pool=forks --maxWorkers=1
   ```

3. Select `r.table_number` in the daily refund builder. For legacy rows only, allow a joined current table number as a display fallback; new rows must use the immutable snapshot. Include table number in the search predicate.
4. In `ReportsRefunds.vue`, show table identity for `kind === 'void'` and invoice identity for `kind === 'refund'`. Keep internal order ID secondary and visually quiet only where it helps support/debugging.
5. Carry the same identity rule into `renderDailyRefundsReport` and the Vue thermal fallback. Keep the report 80mm-only; do not reintroduce A4 printing.
6. Map the two fixed system reasons to natural Arabic at presentation time while retaining their stable English database values.
7. Run the report tests and commit:

   ```powershell
   npx --no-install vitest run backend/tests/integration/reportsRefunds.test.js src/admin/pages/__tests__/dailyReportPayloads.spec.js src/admin/pages/__tests__/dailyReportsLocalization.spec.js pos-spooler-printer/tests/report-html.test.js --pool=forks --maxWorkers=1
   git add -- backend/services/dailyRefundReportBuilder.js backend/tests/integration/reportsRefunds.test.js src/admin/pages/ReportsRefunds.vue src/admin/pages/dailyReportPayloads.js src/admin/pages/__tests__/dailyReportPayloads.spec.js src/admin/pages/__tests__/dailyReportsLocalization.spec.js pos-spooler-printer/report-html.js pos-spooler-printer/tests/report-html.test.js src/print/PrintReceiptApp.vue assets/js/admin/i18n.js
   git commit -m "feat(reports): identify table voids in thermal reports"
   ```

## Task 6: Focused verification and handoff

1. Apply the new additive migration to both configured databases, prove its idempotent path, then require zero schema drift:

   ```powershell
   $oldNodeEnv = $env:NODE_ENV
   $env:REFUND_TABLE_NUMBER_MIGRATION_CONFIRM = 'apply-refund-table-number'
   Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
   node backend/migrations/apply-refund-table-number.js
   node backend/migrations/apply-refund-table-number.js
   $env:NODE_ENV = 'test'
   node backend/migrations/apply-refund-table-number.js
   node backend/migrations/apply-refund-table-number.js
   $env:NODE_ENV = $oldNodeEnv
   Remove-Item Env:REFUND_TABLE_NUMBER_MIGRATION_CONFIRM -ErrorAction SilentlyContinue
   node scripts/validate-schema-drift.js
   ```
2. Run the focused behavioral suite serially:

   ```powershell
   npx --no-install vitest run backend/tests/integration/refunds.test.js backend/tests/integration/tables.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/reportsRefunds.test.js backend/tests/unit/orderSessionStore.test.js src/admin/pages/__tests__/dailyReportPayloads.spec.js src/admin/pages/__tests__/dailyReportsLocalization.spec.js pos-spooler-printer/tests/report-html.test.js --pool=forks --maxWorkers=1
   ```

3. Run build and syntax gates:

   ```powershell
   npm run build:admin
   node --check backend/routes/pos/refunds.js
   node --check backend/routes/pos/tables.js
   node --check backend/services/dailyRefundReportBuilder.js
   node --check pos-spooler-printer/report-html.js
   git diff --check
   ```

4. Manually exercise one red table and one blue table at a 1024px POS viewport:

   - Unauthorized saved Remove/Clear show a lock and cannot call the API; unsaved Remove still works.
   - Red row Remove works with `pos.void_item`; blue requires both permissions.
   - Cancel/failure leaves the cart unchanged.
   - Successful partial row void updates the fee and totals.
   - Final row Remove and confirmed Clear free the table.
   - Direct service-charge removal creates no refund/void event.
   - Refunds & Voids screen and 80mm print show table, user, local time, and translated reason.

5. Inspect `git status --short`, `git log --oneline master..HEAD`, and the final diff. Confirm there is no Refund modal reference, no saved-reduction mutation in `table_order`, no service-charge row in void records, and no change to paid refund or split behavior.
