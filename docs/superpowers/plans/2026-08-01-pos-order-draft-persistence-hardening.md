# POS Order Draft Persistence Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans`, `ponytail`, `test-driven-development`, `vue`, `debugging-and-error-recovery`, and `verification-before-completion`. Execute inline without further subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the proven order-identity, shift-boundary, order-type-authority, and unsaved dynamic-table gaps in the newly added POS draft persistence without expanding the architecture.

**Architecture:** Keep `orderSessionPersistence.js` as the deep module owning serialization, normalization, and table-context identity matching. Keep `orderSessionStore.js` as the only hydration/reset owner, and let `tableOrderWorkflow.js` consume two narrow injected functions for matching and restoring a captured unsaved table snapshot. Replace ambiguous version-1 table context with a version-2 owner identity containing table, active order, split check, and table-number identity; do not add a production file or generic persistence framework.

**Tech Stack:** Vue 3, Pinia, browser `localStorage`, Vitest, Playwright, Express/MySQL unchanged.

## Global Constraints

- Work only on the current `codex/tax-exempt-checks` feature branch.
- Mandatory test-first TDD: each production correction must be preceded by a focused test that fails for the intended reason.
- Do not use subagents, brainstorming, a new dependency, database migration, backend route change, controller, repository, storage adapter, composable, or production file.
- Do not persist payment method, tendered cash, split amounts, modal state, keypad state, or processing flags.
- Server cart, totals, discount, service-charge snapshot, and tax state remain authoritative for an already-saved table order.
- Local cart and financial draft fields may be restored for a table only when it has no server order yet and the complete version-2 table identity matches.
- A cached order-type list may populate controls and supply a default, but only a successful live response may invalidate a saved selected type.
- A successful shift close must remove all POS order-session keys before reload; a failed close must preserve the draft.
- Preserve the untracked `POS1.zip` and `posapp.7z` exactly. Never stage or modify them.
- Keep existing tax-exempt behavior and UI wording unchanged.
- Commit each task separately. Do not merge or push.

---

### Task 1: Make table context identify an order, not merely furniture

**Files:**

- Modify: `src/pos/stores/orderSession/orderSessionPersistence.js`
- Modify: `backend/tests/unit/orderSessionPersistence.test.js`

**Interfaces:**

- Produces: normalized version-2 `context.scope` records.
- Produces: `matchesTableOrderContext(context, table): boolean`.
- Existing callers continue using `readOrderSnapshot()` and `writeOrderContext()`.

- [ ] **Step 1: Write failing version-2 normalization tests**

Add tests demonstrating this exact table scope:

```js
{
  version: 2,
  scope: {
    kind: 'table',
    id: '7',
    orderId: '707',
    splitCheckId: null,
    tableNumber: 'A7'
  },
  selectedOrderType: 4,
  restoredHeldReference: '',
  subscriptionPurchase: null
}
```

Test all of these independently:

1. Numeric table/order/split IDs normalize to strings.
2. An unsaved dynamic table accepts `id: null`, `orderId: null`, `splitCheckId: null`, and nonempty `tableNumber`.
3. A table scope with no ID, order ID, split ID, or table number is rejected.
4. Invalid non-null order/split IDs reject the context instead of normalizing them to null.
5. Version 1 is rejected and removed because its table ownership is ambiguous.
6. Register, held, and subscription scopes retain their existing behavior under version 2.

- [ ] **Step 2: Write failing identity matcher tests**

Import `matchesTableOrderContext` and prove:

```js
expect(matchesTableOrderContext(context, {
  id: 7, current_order_id: 707, split_check_id: null, table_number: 'A7'
})).toBe(true);

expect(matchesTableOrderContext(context, {
  id: 7, current_order_id: 808, split_check_id: null, table_number: 'A7'
})).toBe(false);
```

Also prove:

- Split check 77 does not match split check 78 on the same parent table.
- An unsaved dynamic table matches the same normalized table number.
- An unsaved dynamic table does not match a different table number.
- A non-table context always returns false.

- [ ] **Step 3: Run RED**

```powershell
npx vitest run backend/tests/unit/orderSessionPersistence.test.js
```

Expected: failures because version 2 and `matchesTableOrderContext` do not exist.

- [ ] **Step 4: Implement the minimal version-2 contract**

In `orderSessionPersistence.js`:

```js
const ORDER_CONTEXT_VERSION = 2;

const optionalPositiveId = (value) => {
  if (value == null || value === '') return null;
  const normalized = positiveInteger(value);
  return normalized ? String(normalized) : undefined;
};
```

For `scope.kind === 'table'`, normalize:

```js
const id = optionalPositiveId(scope.id);
const orderId = optionalPositiveId(scope.orderId);
const splitCheckId = optionalPositiveId(scope.splitCheckId);
const tableNumber = text(scope.tableNumber).trim();
if (id === undefined || orderId === undefined || splitCheckId === undefined) return null;
if (!id && !orderId && !splitCheckId && !tableNumber) return null;
scopeId = id;
normalizedScope = {
  kind: 'table',
  id,
  orderId,
  splitCheckId,
  tableNumber,
};
```

Keep non-table scope normalization as small as it is now. Return `normalizedScope` from the context instead of rebuilding only `{ kind, id }`.

Add the matcher in the same file:

```js
export const matchesTableOrderContext = (context, table) => {
  if (context?.scope?.kind !== 'table' || !table) return false;
  const scope = context.scope;
  const tableId = optionalPositiveId(table.id);
  const orderId = optionalPositiveId(table.current_order_id);
  const splitCheckId = optionalPositiveId(table.split_check_id);
  if (tableId === undefined || orderId === undefined || splitCheckId === undefined) return false;
  if (scope.id !== tableId) return false;
  if (scope.orderId !== orderId) return false;
  if (scope.splitCheckId !== splitCheckId) return false;
  if (!scope.id && scope.tableNumber !== text(table.table_number).trim()) return false;
  return true;
};
```

Do not export the normalizer or create a class.

- [ ] **Step 5: Run GREEN**

```powershell
npx vitest run backend/tests/unit/orderSessionPersistence.test.js
```

- [ ] **Step 6: Commit**

```powershell
git add src/pos/stores/orderSession/orderSessionPersistence.js backend/tests/unit/orderSessionPersistence.test.js
git commit -m "fix(pos): bind table drafts to order identity"
```

---

### Task 2: Apply exact table ownership and recover unsaved table drafts

**Files:**

- Modify: `src/pos/stores/orderSessionStore.js`
- Modify: `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `backend/tests/unit/tableSession.logic.test.js`

**Interfaces:**

- Consumes: `matchesTableOrderContext(context, table)` from Task 1.
- Produces internally in `orderSessionStore.js`: `restorePersistedDraftSnapshot(snapshot): boolean`.
- Adds to `createTableOrderWorkflow()` injection: `restorePersistedDraftSnapshot`.

- [ ] **Step 1: Write the reproduced same-table turnover regression**

In `tableSession.logic.test.js`, add the hostile test from the audit:

1. Store context for table 7/order 707/customer `Old Guest`.
2. Make `getTableOrder` return table 7/order 808 and a new cart.
3. Call `loadActiveTableOrder()` for order 808.
4. Assert server cart wins and customer, hash, order type, address, and delivery date are empty.

This test must initially fail with `Old Guest` restored.

- [ ] **Step 2: Write split identity regressions**

Add tests proving:

- Context for parent table 7/split check 77 is ignored for split check 78.
- Context for split check 77 is accepted only when active storage and restored split both identify 77.
- The same parent table ID alone is insufficient.

- [ ] **Step 3: Write unsaved fixed and dynamic table recovery tests**

For each case, seed a captured snapshot with a nonempty cart, note, discount, tax exemption, service snapshot, and checkout context:

```js
{
  id: null,
  current_order_id: null,
  split_check_id: null,
  table_number: '41'
}
```

Prove:

1. Matching unsaved dynamic table 41 restores the local draft.
2. Dynamic table 42 does not restore table 41's draft.
3. Matching unsaved fixed table 7 restores the local draft.
4. A saved table order never accepts local cart, discount, service snapshot, or tax fields; only server values survive.
5. Restored unsaved items retain their original unsaved `originalQty` semantics and are not treated as server-saved/voidable rows.

- [ ] **Step 4: Run RED**

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/unit/tableSession.logic.test.js
```

Expected: same-table turnover, split identity, and unsaved table recovery tests fail.

- [ ] **Step 5: Centralize snapshot hydration inside the existing store**

In `orderSessionStore.js`, extract only two private functions from `loadSavedOrder()`:

```js
const applyPersistedOrderContext = (context) => {
  if (!context) return;
  selectedOrderType.value = context.selectedOrderType ?? '';
  hashNumber.value = context.hashNumber;
  customerPhone.value = context.customerPhone;
  customerName.value = context.customerName;
  customerAddress.value = context.customerAddress;
  orderDate.value = context.orderDate;
  if (context.scope.kind === 'held') {
    restoredHeldReference.value = context.restoredHeldReference;
    activeOrderTaxRegistrationType.value = context.taxRegistrationType;
  }
  if (context.scope.kind === 'subscription') {
    pendingSubscriptionSale.value = context.subscriptionPurchase;
  }
};
```

`restorePersistedDraftSnapshot(snapshot)` must:

- Reject empty/non-array/legacy-modifier carts using the existing compatibility rule.
- Call `resetOrderDraftRefs()` once.
- Restore cart, note, discount, service snapshot, tax exemption, and normalized context.
- Leave `originalSavedItems` empty and preserve each cart line's existing `originalQty` value.
- Return true only after a valid restoration.
- Not access `activeTable` and not decide ownership; callers must match identity first.

Make `loadSavedOrder()` reuse it after its existing context checks. Keep invalid-cart cleanup and warning behavior unchanged.

- [ ] **Step 6: Write version-2 scope from the watcher**

When `activeTable.value` exists—even with `id: null`—write:

```js
{
  kind: 'table',
  id: activeTable.value.id == null ? null : String(activeTable.value.id),
  orderId: activeTable.value.current_order_id == null ? null : String(activeTable.value.current_order_id),
  splitCheckId: activeTable.value.split_check_id == null ? null : String(activeTable.value.split_check_id),
  tableNumber: String(activeTable.value.table_number ?? '').trim(),
}
```

Write context version 2. Extend the existing single watcher to observe current order ID, split-check ID, table number, and split status. Do not add another watcher.

- [ ] **Step 7: Replace both table-ID-only comparisons**

- In `loadSavedOrder()`, validate stored table context against `readActiveTable(localStorage)` with `matchesTableOrderContext()`.
- In `loadTableOrder()`, apply checkout-only context only when `matchesTableOrderContext(persistedContext, normalizedTable)` returns true.
- Never compare only `scope.id` again.

- [ ] **Step 8: Restore a matching unsaved table after authority is known absent**

Inject `restorePersistedDraftSnapshot` into `createTableOrderWorkflow()`.

In `loadActiveTableOrder()`, keep server-order behavior unchanged. In the `!normalized.current_order_id` branch:

```js
const restoredLocalDraft = matchesTableOrderContext(
  persistedOrderSnapshot?.context,
  normalized
) && restorePersistedDraftSnapshot?.(persistedOrderSnapshot);

if (!restoredLocalDraft && options.clearEmpty !== false) {
  clearOrderDraft({ startNew: true });
} else if (restoredLocalDraft) {
  ui.resetTransient();
  persistActiveTable();
}
```

Do not route an unsaved local cart through `loadTableOrder()`, because that function intentionally marks server-loaded items through `originalSavedItems`.

- [ ] **Step 9: Run GREEN and regressions**

```powershell
npx vitest run backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/tableSession.logic.test.js backend/tests/unit/tableSessionBoundary.test.js backend/tests/unit/tableOrderModuleWiring.test.js
```

- [ ] **Step 10: Commit**

```powershell
git add src/pos/stores/orderSessionStore.js src/pos/stores/orderSession/tableOrderWorkflow.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/tableSession.logic.test.js
git commit -m "fix(pos): isolate table drafts by active order"
```

---

### Task 3: Separate live order-type authority from fallback display data

**Files:**

- Modify: `src/pos/stores/orderSessionStore.js`
- Modify: `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `backend/tests/unit/tableSession.logic.test.js`

**Interfaces:**

- Changes private store function to `reconcileDraftOrderType({ canInvalidate = true } = {})`.
- Adds table-workflow injection: `reconcileDraftOrderType`.

- [ ] **Step 1: Write the reproduced stale-cache regression**

Create a register draft with selected type 4 and `VALID-HASH`. Seed a current cache containing only default type 1, then make the live request reject. Assert type 4 and its hash remain unchanged.

Expected RED result before the fix: selected type becomes 1.

- [ ] **Step 2: Write the reproduced table reconciliation regression**

Load matching table context containing selected type 999 and `STALE-HASH`, while the successful live response contains only active default type 1. Assert type becomes 1, hash clears, and one warning is shown.

Cover both request orderings:

1. Live types resolve before table context is applied.
2. Table context is applied before live types resolve.

Expected RED result before the fix: type remains 999 in at least one ordering.

- [ ] **Step 3: Run RED**

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/unit/tableSession.logic.test.js
```

- [ ] **Step 4: Make reconciliation authority explicit**

Change the private function:

```js
const reconcileDraftOrderType = ({ canInvalidate = true } = {}) => {
  if (!orderTypes.value.length || editingInvoiceId.value) return;
  const selected = selectedOrderType.value;
  if (selected && orderTypes.value.some(type => String(type.id) === String(selected))) return;
  if (selected && !canInvalidate) return;

  if (selected) {
    selectedOrderType.value = '';
    hashNumber.value = '';
    window.showPosToast?.(
      t('The saved order type is no longer available. The default was selected.'),
      'warning'
    );
  }
  applyDefaultOrderTypeToNewRegisterOrder();
};
```

Adjust the default helper only as required so an active table with a missing/invalid selection may receive the default after context hydration. Do not permit it to replace an existing valid selection.

In `fetchOrderTypes()`:

- Track whether a successful live response supplied an array.
- Call `reconcileDraftOrderType({ canInvalidate: true })` only for live authority.
- On cached fallback call `reconcileDraftOrderType({ canInvalidate: false })`; this may fill a blank selection but must never erase an existing one.
- Treat malformed successful response data as unavailable, not as an empty authoritative list.

- [ ] **Step 5: Reconcile after table context hydration**

Inject a narrow callback into `createTableOrderWorkflow()`:

```js
reconcileDraftOrderType: options => reconcileDraftOrderType(options)
```

At the end of `loadTableOrder()`, after matching checkout context is applied, call:

```js
reconcileDraftOrderType?.({ canInvalidate: true });
```

If order types have not loaded, the function naturally returns; the later successful live fetch performs reconciliation. Do not create timing flags or another watcher.

- [ ] **Step 6: Run GREEN**

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/unit/tableSession.logic.test.js backend/tests/unit/checkoutFlow.test.js backend/tests/unit/checkoutAttemptCache.test.js
```

- [ ] **Step 7: Commit**

```powershell
git add src/pos/stores/orderSessionStore.js src/pos/stores/orderSession/tableOrderWorkflow.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/tableSession.logic.test.js
git commit -m "fix(pos): reconcile draft types from live authority"
```

---

### Task 4: End draft ownership when a shift closes

**Files:**

- Modify: `src/pos/useAuth.js`
- Modify: `backend/tests/unit/orderSessionBoundaries.test.js`
- Modify: `tests/e2e/specs/cashier.checkout.spec.js`

**Interfaces:**

- Reuses existing `clearPosOrderSessionStorage()`; no new session API.

- [ ] **Step 1: Write a failing static boundary guard**

In `orderSessionBoundaries.test.js`, assert that the success branch of `closeShiftAndPrint()` calls `clearPosOrderSessionStorage()` before scheduling `window.location.reload()`.

This is a narrow source invariant, not the only behavioral proof.

- [ ] **Step 2: Write the browser shift-turnover regression**

Extend the existing cashier workflow without creating a second seed fixture:

1. Open a shift.
2. Add one item and set customer/order-type/hash context.
3. Close the checkout modal without paying.
4. Close the shift successfully through the existing Z-report workflow.
5. After reload, assert every key in `POS_ORDER_SESSION_KEYS` is absent.
6. Open a new shift and assert the cart is empty and checkout cannot reopen.

Also add a focused failure-path unit/static assertion or mocked behavior proving unsuccessful shift closure does not clear storage.

- [ ] **Step 3: Run RED**

```powershell
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js
npx playwright test tests/e2e/specs/cashier.checkout.spec.js --project=cashier-tests -g "shift"
```

- [ ] **Step 4: Clear only after confirmed success**

`useAuth.js` already imports `clearPosOrderSessionStorage`. In the `if (data.success)` branch of `closeShiftAndPrint()`, call:

```js
clearPosOrderSessionStorage();
```

Place it before the delayed reload. Do not clear before the server confirms closure, and do not change printing or report behavior.

- [ ] **Step 5: Run GREEN**

```powershell
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js backend/tests/unit/posSessionStorage.test.js
npx playwright test tests/e2e/specs/cashier.checkout.spec.js --project=cashier-tests -g "shift"
```

- [ ] **Step 6: Commit**

```powershell
git add src/pos/useAuth.js backend/tests/unit/orderSessionBoundaries.test.js tests/e2e/specs/cashier.checkout.spec.js
git commit -m "fix(pos): clear drafts when shifts close"
```

---

### Task 5: Browser proof, architecture truth, and adversarial closure

**Files:**

- Modify: `tests/e2e/specs/cashier.checkout.spec.js`
- Modify: `docs/architecture.json`
- Generate only: `docs/architecture.html`

**Interfaces:** None.

- [ ] **Step 1: Add one same-table turnover browser workflow if the existing fixtures support it**

Use the existing table fixtures and API/database helpers. Prove that after table 7 changes from one server order to another, a reload shows the new server cart without the first order's customer/type/hash context.

If the existing browser fixture cannot create two successive active orders on one table without duplicating a large setup, keep the proven unit regression and document that decision in the commit message; do not build a new fixture framework.

- [ ] **Step 2: Run the complete scoped verification**

```powershell
npx vitest run backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderSessionBoundaries.test.js backend/tests/unit/posSessionStorage.test.js backend/tests/unit/checkoutAttemptCache.test.js backend/tests/unit/checkoutFlow.test.js backend/tests/unit/tableSession.logic.test.js backend/tests/unit/tableSessionBoundary.test.js backend/tests/unit/tableOrderModuleWiring.test.js backend/tests/integration/subscriptionPurchase.test.js
npx playwright test tests/e2e/specs/cashier.checkout.spec.js tests/e2e/specs/subscription-receivables.spec.js --project=cashier-tests
npm run build
```

Expected: all commands pass with no unexpected console errors.

- [ ] **Step 3: Update the architecture source of truth**

Update `docs/architecture.json` to record:

- `orderSessionPersistence.js` as owner of versioned local draft normalization and table identity matching.
- `orderSessionStore.js` as owner of hydration/reset and live-vs-cache order-type reconciliation.
- `tableOrderWorkflow.js` as server-authoritative for saved table money and local-authoritative only for an exact-matched unsaved table draft.
- Shift close as a POS order-session cleanup boundary.

Do not manually edit `docs/architecture.html`. Generate and validate:

```powershell
npm run architecture
npm run architecture:check
```

- [ ] **Step 4: Execute the hostile review prompt**

> Review the final hardening diff as hostile POS state-boundary code. Attempt same-table order turnover, split-seat collision, joined-table normalization, unsaved fixed and dynamic table refresh, stale active order types, incomplete fallback caches, malformed version-1/version-2 storage, successful and failed shift closure, logout, hold/re-hold, subscription receivable refresh, checkout retry, and server/local financial authority inversion. For every suspicion, trace all writers/readers/clearers and produce a reproducible path or discard it. Reject style-only findings and new abstractions. Fix only a proven defect inside this plan's scope using test-first TDD.

- [ ] **Step 5: Inspect scope and repository state**

```powershell
git diff --check
git status --short
git log --oneline 446c1213..HEAD
```

Confirm:

- No backend or schema change.
- No new production file or dependency.
- No payment/modal state persisted.
- User archives remain untracked and untouched.
- Every production correction has a test that was observed failing first.

- [ ] **Step 6: Commit documentation or a proven audit correction only**

```powershell
git add docs/architecture.json docs/architecture.html tests/e2e/specs/cashier.checkout.spec.js
git commit -m "docs: map POS draft ownership boundaries"
```

Omit unchanged paths. If the adversarial review finds no correction and no browser test was added, commit only generated architecture changes. Never create an empty commit.

## Acceptance Checklist

- [ ] Table 7/order 707 context cannot enter table 7/order 808.
- [ ] Split check 77 context cannot enter split check 78 on the same parent table.
- [ ] Matching saved tables restore checkout-only context while server money/tax/cart remains authoritative.
- [ ] Matching unsaved fixed and dynamic tables recover their local cart and business context without marking lines as server-saved.
- [ ] A successful live order-type response reconciles deleted/inactive selections for register, held, and table drafts.
- [ ] A fallback cache never invalidates an existing saved selection or clears its hash.
- [ ] Successful shift closure clears all POS order-session storage before reload; failed closure preserves it.
- [ ] Login, logout, idle expiry, cross-tab logout, checkout, hold, re-hold, cancellation, clear, and table close remain correct.
- [ ] No local saved-table financial/tax state overwrites the server response.
- [ ] Existing checkout idempotency remains stable for unchanged business and payment input.
- [ ] Scoped unit, integration, browser, build, and architecture checks pass.

## Max-Effort Executor Prompt

> You are Luna, the sole max-effort executor for `docs/superpowers/plans/2026-08-01-pos-order-draft-persistence-hardening.md`. Execute the plan completely and literally on the current `codex/tax-exempt-checks` branch, inline and without spawning any subagent. Start by reading `CLAUDE.md`, the full plan, every changed commit from `ae9a1348^..HEAD`, and every production caller touched by the plan. Use Ponytail at full intensity, TDD, Vue, debugging-and-error-recovery, and verification-before-completion. For each task, write the smallest behavioral test first, run it and personally observe the expected failure, then implement the narrowest root-cause fix and rerun the focused regressions before committing exactly the task's files. Treat tests as evidence, not authority: after green, trace all writers, readers, clearers, async timing, and backend ownership manually. Do not add production files, dependencies, database/backend changes, generic abstractions, payment persistence, or unrelated cleanup. Never compare table ownership by physical table ID alone; distinguish server order and split identities, and restore local financial fields only when no server order exists. Never let fallback cache data invalidate a saved type. Clear drafts only after confirmed shift closure. Preserve `POS1.zip`, `posapp.7z`, and all unrelated user work. If the written code sketch conflicts with verified repository behavior, stop that task, document the evidence, and choose the smallest correction that still satisfies every acceptance criterion—do not silently broaden scope. Run all specified unit, integration, browser, build, and architecture checks, then execute the hostile review prompt and fix only proven in-scope defects through another red-green cycle. Commit task groups, but do not merge or push. Finish with commits, exact test results, remaining risks, and `git status`.
