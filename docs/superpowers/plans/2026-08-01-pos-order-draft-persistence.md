# POS Order Draft Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: Use `executing-plans` inline, `ponytail`, `test-driven-development`, `vue`, and `verification-before-completion`. Do not use subagents or brainstorming. Follow the scope and ownership rules below literally. Stop and report evidence instead of expanding the architecture.

**Goal:** Preserve the business context of an unfinished POS order across a browser refresh without allowing state from one order, table, held order, subscription, user, or checkout attempt to leak into another.

**Architecture:** Extend the existing `orderSessionPersistence.js` boundary with one versioned `pos_order_context` record. Keep the existing cart, note, discount, service-charge snapshot, and tax-exempt keys for compatibility. The Pinia order-session store remains the single owner of hydration and reset behavior. Table financial state remains authoritative from the backend; only exact-table-matched checkout context may be merged from local storage after the table order reloads.

**Tech stack:** Vue 3, Pinia, browser `localStorage`, Vitest, Playwright, Express/MySQL backend unchanged.

---

## Evidence and root cause

1. `PosTerminal.vue` calls `loadSavedOrder()` before `fetchOrderTypes()` during mount.
2. `loadSavedOrder()` currently restores only cart, note, discount, service-charge snapshot, and tax exemption.
3. `applyDefaultOrderTypeToNewRegisterOrder()` refuses to apply the configured default whenever the cart is nonempty. Therefore a restored cart with no restored order type displays no selection.
4. The backend still applies `default_order_type_id` when checkout omits an order type. The visible blank default is misleading, while loss of a manually selected type is more serious: checkout can silently fall back to the backend default.
5. The checkout fingerprint includes order type, hash, customer, delivery date, totals, and payment. Those business fields must be stable for safe reuse of the existing idempotency key after a refresh.
6. Closing the checkout modal correctly clears only modal state and its in-memory active key. It does not cause the loss; refresh exposes the incomplete persistence contract.
7. Subscription sale intent is currently memory-only. The backend already rejects a hidden subscription product without matching `subscription_purchase` intent through `assertSubscriptionSaleProductIntent()`. Preserve the valid intent locally, but do not duplicate or replace this backend authority.
8. Restored held orders currently lose their reference, order type/hash, customer/delivery context, and frozen tax-registration context on a second refresh.
9. Table order GET restores authoritative cart, discount, tax context, and service-charge snapshot, but it does not return order type, hash, customer details, delivery date, or order note. Those checkout-only fields may be restored locally only for the same table ID.
10. `loadActiveTableOrder()` clears the order draft before its first awaited request. A matching local snapshot must be captured before that clear and carried through the guarded load.
11. A missing or invalid saved cart can currently leave note, discount, or service-charge residue behind. Hydration must be all-or-nothing for order-scoped storage.
12. Logout, login replacement, idle timeout, and cross-tab logout already clear every key in `POS_ORDER_SESSION_KEYS`. Adding the context key there extends those existing safety paths without a new logout mechanism.

## Ownership rules

| State | Refresh behavior | Authority |
|---|---|---|
| Cart, note, discount, service snapshot, tax exemption | Keep existing storage keys | Existing order-session persistence |
| Order type, hash, customer, delivery date | Persist in one context record | Current order draft |
| Restored-held reference and frozen tax-registration type | Persist in context | Claimed held-order payload |
| Subscription purchase intent | Persist in context | POS intent plus existing backend validation |
| Table cart, discount, service snapshot, tax mode/exemption/registration | Reload from backend; never merge local copies over it | Table order API |
| Table order type/hash/customer/delivery/note | Merge only when context scope matches the exact table ID | Same-table local checkout draft |
| Payment method, tendered amount, split amounts, keypad state, drawers/modals/errors | Never persist | Transient UI store |
| Editing-invoice state | Never persist | URL plus authoritative invoice reload |
| Checkout idempotency payload | Keep existing hashed attempt cache; do not duplicate raw data | `checkoutAttemptCache.js` |

## Non-negotiable scope

- No database migration.
- No backend route, checkout, hold, table, or subscription-service changes.
- No new production file, dependency, composable, controller, repository, storage adapter, or generic state framework.
- No persistence of payment or modal UI state.
- No replacement of the existing individual order-data keys.
- No attempt to make every Pinia field durable.
- No page redesign or unrelated cleanup.
- Preserve the current uncommitted tax-exempt UI changes in `src/components/PosTerminal.vue` and `backend/tests/unit/orderSessionBoundaries.test.js`.
- Do not touch `POS1.zip` or `posapp.7z`.

## Context contract

Add one internal local-storage record:

```js
const ORDER_CONTEXT_VERSION = 1;

{
  version: 1,
  scope: {
    kind: 'register' | 'held' | 'table' | 'subscription',
    id: string | null
  },
  selectedOrderType: number | null,
  hashNumber: '',
  customerPhone: '',
  customerName: '',
  customerAddress: '',
  orderDate: '',
  restoredHeldReference: '',
  taxRegistrationType: 'sales_tax' | 'income_tax' | null,
  subscriptionPurchase: null | {
    plan_id: number,
    starts_on: string | null,
    ends_on: string | null,
    payment_terms?: 'receivable',
    payment_due_on?: string,
    receivable_reason?: string
  }
}
```

Rules:

- The record exists only while a valid nonempty cart exists.
- IDs are normalized to positive integers and stored scope IDs are strings for exact comparison.
- Unknown versions, invalid scope kinds/IDs, and malformed subscription intent invalidate the context. Invalid optional order-type and tax-registration values normalize to `null` so one optional field cannot erase otherwise valid customer context.
- Strings are normalized to strings; do not invent business validation in the persistence layer.
- A malformed context is removed and treated as absent. Existing backend validation remains the fail-closed authority for a subscription cart whose intent is missing.
- The record may contain customer PII because it is a terminal-local unfinished draft. Existing logout/session cleanup must remove it.

---

### Task 1: Add the minimal persistence contract

**Files:**

- Modify: `backend/tests/unit/orderSessionPersistence.test.js`
- Modify: `src/pos/stores/orderSession/orderSessionPersistence.js`

- [ ] **Step 1: Write failing persistence tests**

Add focused tests proving:

1. A valid version-1 context round-trips through `writeOrderContext()` and `readOrderSnapshot()`.
2. Numeric IDs are normalized consistently.
3. An unknown version, invalid scope, malformed JSON, or invalid subscription plan ID returns `context: null` and removes `pos_order_context`.
4. A non-array cart is normalized to `[]`; callers never receive a truthy object and mistake it for a valid cart.
5. `clearOrderData()` and `clearPosOrderSession()` remove `pos_order_context`.
6. Blocked/unavailable browser storage remains best-effort and never throws.

Update existing exact snapshot expectations to include `context: null`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run backend/tests/unit/orderSessionPersistence.test.js
```

Expected failure: missing context key/functions and old snapshot shape. Do not change assertions merely to make the test pass.

- [ ] **Step 3: Implement only the storage boundary**

In `orderSessionPersistence.js`:

1. Add `context: 'pos_order_context'` to `POS_ORDER_KEYS` and include it in `POS_ORDER_SESSION_KEYS`.
2. Add a private `normalizeOrderContext(value)` implementing the contract above.
3. Make `readOrderSnapshot()` return a normalized array cart and normalized context.
4. Add `writeOrderContext(storage, context)`: write a normalized context, or remove the key when context is null/invalid.
5. Include the context key in `clearOrderData()`.
6. Reuse the existing safe `getItem`, `setItem`, `removeItem`, and JSON helpers. Do not create another persistence abstraction.

- [ ] **Step 4: Run the test and confirm GREEN**

```bash
npx vitest run backend/tests/unit/orderSessionPersistence.test.js
```

- [ ] **Step 5: Commit the isolated contract**

```bash
git add src/pos/stores/orderSession/orderSessionPersistence.js backend/tests/unit/orderSessionPersistence.test.js
git commit -m "fix(pos): persist versioned order draft context"
```

---

### Task 2: Hydrate register, held-order, and subscription context safely

**Files:**

- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `src/pos/stores/orderSessionStore.js`

- [ ] **Step 1: Write failing store tests**

Add tests for these exact contracts:

1. A legacy nonempty saved cart with no context receives the configured default after `fetchOrderTypes()`.
2. A manually selected order type, required hash, customer details, delivery date, and note survive store recreation and hydration.
3. A valid selected type on an active cart is not rewritten when the configured default changes.
4. When a nonempty successful order-type response no longer contains the saved selected type, clear its hash, select the current default (or blank when no default exists), and show one warning toast.
5. When order-type loading fails and both the response and cache are empty, preserve the saved selected type rather than declaring it invalid without evidence.
6. A restored-held context restores `restoredHeldReference` and frozen `activeOrderTaxRegistrationType` along with customer/order-type fields.
7. A valid subscription context restores `pendingSubscriptionSale`, including receivable terms, and leaves `canHoldOrder === false`.
8. A missing, non-array, empty, or legacy-invalid cart clears all stored order data; it cannot leave an orphan discount, note, service snapshot, tax exemption, or context.
9. `startNewOrder()`, `finalizeCheckout()`, successful hold cleanup, subscription cancellation, and `clearCart()` remove the context.
10. Closing checkout preserves business context, while payment method, tendered amount, split amounts, modal state, and keypad state remain transient after store recreation.
11. Re-entering the same payment details after refresh with the restored business context produces the same checkout fingerprint and reuses the existing cached idempotency key.

- [ ] **Step 2: Run the focused store tests and confirm RED**

```bash
npx vitest run backend/tests/unit/orderSessionStore.test.js
```

- [ ] **Step 3: Add one batched context writer**

Import `writeOrderContext` and add one watcher in `orderSessionStore.js`. Watch:

- `cart.length`
- selected order type and hash
- customer phone/name/address
- delivery date
- restored-held reference
- active tax-registration type
- pending subscription intent (deep)
- active table ID

The writer must remove the context when `cart.length === 0`. Otherwise build one context with this scope priority:

1. pending subscription -> `{ kind: 'subscription', id: String(plan_id) }`
2. active table -> `{ kind: 'table', id: String(activeTable.id) }`
3. restored held order -> `{ kind: 'held', id: restoredHeldReference }`
4. ordinary register -> `{ kind: 'register', id: null }`

Do not add one watcher per field. Do not persist computed totals or payment state.

- [ ] **Step 4: Make hydration all-or-nothing**

Refactor `loadSavedOrder()` without extracting a new module:

1. Read the snapshot once.
2. Accept only a nonempty array cart that passes the existing modifier compatibility check.
3. If the cart is absent/empty/invalid, call `clearOrderData(localStorage)`, keep the order refs at fresh defaults, and return. Do not apply note/discount/service/tax/context afterward.
4. If valid, restore the existing persisted values, then restore normalized context fields.
5. Import and reuse the existing `readActiveTable()` helper. For a `table` context, verify the stored active-table record exists and its ID matches the context scope before applying table checkout context. If it does not match, discard the context and do not treat it as a register draft.
6. Restore subscription intent only from a `subscription` context whose scope ID equals its normalized `plan_id`.
7. Restore held-only fields only from a `held` context.
8. Continue supporting legacy carts with no context.

- [ ] **Step 5: Repair default selection and reconcile stale types**

Change the cart guard in `applyDefaultOrderTypeToNewRegisterOrder()` so a cart blocks default replacement only when it already has a selected type:

```js
if (
  activeTable.value ||
  editingInvoiceId.value ||
  restoredHeldReference.value ||
  (cart.value.length > 0 && selectedOrderType.value)
) return;
```

Add one private `reconcileDraftOrderType()` and call it after order types are available:

- If `orderTypes` is empty, preserve the selection because validity is unknown.
- If no type is selected, apply the default using the existing helper.
- If the selected ID exists, preserve it even when the configured default changed.
- If the selected ID does not exist, clear `hashNumber`, choose the current default or blank, and warn once.
- Never run this reconciliation against editing-invoice state or a restored table’s authoritative load before its context has been applied.

Do not move order-type ownership to another file or change backend fallback behavior.

- [ ] **Step 6: Run focused tests and confirm GREEN**

```bash
npx vitest run backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/checkoutAttemptCache.test.js backend/tests/unit/checkoutFlow.test.js
```

- [ ] **Step 7: Commit the register/held/subscription behavior**

```bash
git add src/pos/stores/orderSessionStore.js backend/tests/unit/orderSessionStore.test.js
git commit -m "fix(pos): restore unfinished order business context"
```

---

### Task 3: Preserve same-table checkout context without overriding server money

**Files:**

- Modify: `backend/tests/unit/tableSession.logic.test.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify: `src/pos/stores/orderSessionStore.js`

- [ ] **Step 1: Write failing table tests**

Add tests proving:

1. `loadActiveTableOrder()` captures the persisted snapshot before `clearOrderDraft()` and before the first await.
2. For context scope `{ kind: 'table', id: '7' }` loading table 7 restores only:
   - order note
   - selected order type and hash
   - customer phone/name/address
   - delivery date
3. Local cart, discount, service snapshot, tax-inclusive mode, tax exemption, tax-registration type, invoice IDs, and saved item baselines never overwrite the table API response.
4. Context for table 7 is ignored when table 8 loads.
5. A late table-7 response still cannot paint over table 8; extend the existing cross-table race test rather than creating a second race harness.
6. A failed table load clears the captured table context through existing session cleanup and does not convert it into a register draft.

- [ ] **Step 2: Run the focused table tests and confirm RED**

```bash
npx vitest run backend/tests/unit/tableSession.logic.test.js backend/tests/unit/orderSessionStore.test.js
```

- [ ] **Step 3: Inject one narrow persistence reader**

When creating `createTableOrderWorkflow()` in `orderSessionStore.js`, pass:

```js
readPersistedOrderSnapshot: () => readOrderSnapshot(localStorage)
```

Add that parameter to `createTableOrderWorkflow()`. Do not inject localStorage itself and do not create a repository/interface layer.

- [ ] **Step 4: Capture before clear, merge after authority**

In `loadActiveTableOrder()`:

1. Capture `readPersistedOrderSnapshot()` before the first `clearOrderDraft()`.
2. Carry the captured snapshot through the existing sequence-token guarded request.
3. Pass it to `loadTableOrder()` only for the still-current response.

In `loadTableOrder()`:

1. Clear residue as it does today.
2. Apply the table API cart, invoice/order IDs, discount, service snapshot, and all tax fields first and unchanged.
3. If the captured context is `table` scoped and its ID exactly matches `normalizedTable.id`, apply only the six checkout-context groups listed in Step 1.
4. Never apply local financial/tax fields over the server payload.
5. Let the existing watcher write the newly normalized same-table context after hydration.

This is an ownership merge, not a generic object spread.

- [ ] **Step 5: Run table and boundary regression tests**

```bash
npx vitest run backend/tests/unit/tableSession.logic.test.js backend/tests/unit/tableSessionBoundary.test.js backend/tests/unit/tableOrderModuleWiring.test.js backend/tests/unit/orderSessionStore.test.js
```

- [ ] **Step 6: Commit the table behavior**

```bash
git add src/pos/stores/orderSession/tableOrderWorkflow.js src/pos/stores/orderSessionStore.js backend/tests/unit/tableSession.logic.test.js backend/tests/unit/orderSessionStore.test.js
git commit -m "fix(pos): retain same-table checkout draft on refresh"
```

---

### Task 4: Prove the real refresh workflows in a browser

**Files:**

- Modify: `tests/e2e/specs/cashier.checkout.spec.js`
- Modify: `tests/e2e/specs/subscription-receivables.spec.js`

- [ ] **Step 1: Add a register refresh regression**

In `cashier.checkout.spec.js`, use the existing shift-opening and product-selection patterns:

1. Open a shift and add a product.
2. Open Complete Payment and verify the configured default order type is selected.
3. Close through the checkout dialog’s accessible `Close` button.
4. Reload the page, wait for the ledger connection, reopen Complete Payment, and verify the default remains selected.
5. Seed or configure a second active order type that requires a hash. Select it, enter a hash and customer/delivery fields, close, reload, and assert those values survive.
6. Before another reload choose card or split and enter tendered/split values. After reload, reopen checkout and assert the transient payment state has reset to the normal default while the business context remains.

Prefer accessible roles/labels already present in `CheckoutModal.vue`; do not add production test IDs unless no stable accessible selector exists.

- [ ] **Step 2: Extend the existing subscription receivable workflow**

In the existing `issues once, collects...` test in `subscription-receivables.spec.js`:

1. After `Sell Subscription` opens checkout, close checkout without submitting.
2. Reload the POS.
3. Reopen checkout through Pay.
4. Verify `Issue as receivable` is still shown and complete the existing flow.
5. Preserve the existing database assertions proving only one receivable order and one subscription are created.

Do not build a new subscription fixture or duplicate the long end-to-end workflow.

- [ ] **Step 3: Run the real browser workflows**

```bash
npx playwright test tests/e2e/specs/cashier.checkout.spec.js tests/e2e/specs/subscription-receivables.spec.js --project=cashier-tests
```

- [ ] **Step 4: Commit browser regressions**

```bash
git add tests/e2e/specs/cashier.checkout.spec.js tests/e2e/specs/subscription-receivables.spec.js
git commit -m "test(pos): cover checkout draft refresh workflows"
```

---

### Task 5: Final adversarial verification and cleanup

**Files:** Review only the files changed by Tasks 1-4.

- [ ] **Step 1: Run the scoped suite**

```bash
npx vitest run backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/checkoutAttemptCache.test.js backend/tests/unit/checkoutFlow.test.js backend/tests/unit/tableSession.logic.test.js backend/tests/unit/tableSessionBoundary.test.js backend/tests/unit/tableOrderModuleWiring.test.js backend/tests/integration/subscriptionPurchase.test.js
npx playwright test tests/e2e/specs/cashier.checkout.spec.js tests/e2e/specs/subscription-receivables.spec.js --project=cashier-tests
npm run build
```

- [ ] **Step 2: Attack the implementation with this review prompt**

> Review this order-draft persistence change as a hostile POS state-boundary audit. Trace every write, hydrate, clear, refresh, checkout, hold, held restore, subscription sale, table switch, table load failure, logout, and checkout retry path. Prove that business context survives only for its owning order scope; prove that payment UI state never survives; prove that local table state cannot overwrite server cart, totals, discounts, service-charge snapshots, or tax authority; prove stale order types cannot silently replace a valid selection; prove invalid carts cannot leave orphan financial state; prove a malformed subscription intent still fails closed in the existing backend; and prove no new abstraction or duplicate source of truth was introduced. Cite code and tests for every claim. Fix only scope defects found by this audit.

- [ ] **Step 3: Inspect the final diff**

```bash
git diff --check
git status --short
git diff --stat HEAD~4..HEAD
```

Confirm:

- One new storage key, no new production files.
- No backend or schema changes.
- No payment/tendered/split/modal persistence.
- No unrelated formatting churn.
- Existing tax-exempt uncommitted changes are preserved and not accidentally folded into these task commits.
- User archives remain untouched.

- [ ] **Step 4: Commit only a real audit correction, if required**

If the adversarial review required a scoped correction, stage the corrected files explicitly (never use `git add .`) and commit them separately with message `fix(pos): harden order draft state boundaries`.

If no correction was needed, do not create an empty commit.

## Acceptance checklist

- [ ] Add item -> Pay -> Close -> Refresh -> Pay still shows the default order type.
- [ ] A manual order type and its hash survive refresh and are not replaced by a changed default.
- [ ] Customer and scheduled-delivery fields survive an unfinished order refresh.
- [ ] Payment method, tendered cash, split amounts, keypad state, and modal visibility do not survive.
- [ ] Restored held-order identity and tax-registration context survive until completion or re-hold.
- [ ] Subscription checkout intent and receivable terms survive, while the backend remains fail closed.
- [ ] A table refresh restores only same-table checkout context and reloads all money/tax state from the server.
- [ ] Switching tables cannot leak context.
- [ ] Empty/invalid carts cannot leave discounts, notes, service snapshots, exemption state, or customer context.
- [ ] Clear, checkout, hold, cancellation, logout, idle expiry, and cross-tab logout remove the context.
- [ ] Existing checkout idempotency behavior remains stable after re-entering the same payment.
- [ ] Focused unit, integration, browser, and build commands pass.

## Strict execution prompt

> Execute `docs/superpowers/plans/2026-08-01-pos-order-draft-persistence.md` inline on the current feature branch. Use Ponytail, test-driven development, Vue, and verification-before-completion. Do not use brainstorming or subagents. Follow each task in order, first making its focused tests fail for the intended missing behavior, then implementing the smallest change that makes them pass. Do not add production files, database migrations, backend behavior, dependencies, generic persistence abstractions, or payment-state persistence. Preserve the existing individual cart/note/discount/service/tax-exempt keys and add only the versioned `pos_order_context` key. Treat backend table money/tax state as authoritative and merge only exact-table-matched checkout context. Rely on the existing subscription backend guard rather than duplicating it. Preserve all pre-existing uncommitted work and do not touch user archives. Commit each task group exactly as planned. After implementation, run the scoped Vitest, Playwright, and build commands, execute the adversarial review prompt, fix only findings within scope, and report evidence, commits, tests, and any remaining risk. Do not merge or push.
