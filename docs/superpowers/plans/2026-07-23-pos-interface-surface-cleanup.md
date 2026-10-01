# POS Interface Surface Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Use ponytail at full intensity. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow misleading POS and checkout module interfaces without changing cashier, table, checkout, printing, money, persistence, HTTP, or backend transaction behavior.

**Architecture:** Preserve `useOrderSessionStore` as the only persistent Order/Table Pinia owner and `useOrderUiStore` as the transient UI owner. Keep `useCart()` and `useTables()` as compatibility facades, but remove terminal ownership and entries with no runtime facade caller. Keep existing implementations in place; this plan creates no runtime module and moves no workflow.

**Tech Stack:** Vue 3 Composition API, Pinia 2, native JavaScript modules, CommonJS backend modules, Vitest 4, Vite 6.

## Global Constraints

- This is an interface-only, behavior-preserving cleanup after architecture Phases 1–7.
- Keep `useOrderSessionStore` and `useOrderUiStore` as the only POS Pinia stores.
- Do not split `orderSessionStore.js`, create a controller/service/repository hierarchy, introduce dependency injection, or add a package.
- Do not change endpoint URLs, native `fetch` behavior, JSON shapes, auth interception, retries, status handling, or migrate more HTTP calls.
- Do not change money formulas, tolerance values, payment methods, split allocation, table behavior, permissions, checkout locks, storage keys, receipt output, or printing behavior.
- Do not change or hide `overrideAttempts`; its shared Map remains the pragmatic integration-test cleanup seam until those tests are independently redesigned.
- Do not remove a store entry merely because no Vue component uses it if an existing store-level test uses it to drive or verify real behavior. This plan removes only five store return entries with no external source or test consumer.
- Do not create test-only production factories, reset hooks, adapter objects, barrels, or one-function files.
- Preserve all unrelated working-tree changes. In particular, do not stage, restore, or discard the current tracked prototype deletions or unrelated untracked files.
- Before execution, ensure the prototype deletion work is committed or deliberately carried into the execution branch. Never stash or drop it implicitly.
- Run focused tests after each task. Run the combined focused gate and production build once at the end; do not run the full suite unless a focused failure implicates broader behavior.
- Each commit stages only the exact files named by its task.

---

## Plan-authoring prompt

Use this prompt to regenerate or amend this plan without widening it:

```text
Act as the senior owner of a live restaurant POS during a Friday-night rush.
Use ponytail at full intensity: delete interface noise before adding anything,
and reject file-count improvements that move complexity into shallow modules.

Read, in order:
1. docs/superpowers/plans/2026-07-22-pos-architecture-refactor-roadmap.md
2. docs/superpowers/plans/2026-07-23-pos-state-ownership.md
3. docs/superpowers/plans/2026-07-24-phase-6-admin-native-http.md
4. docs/superpowers/plans/2026-07-24-phase-7-table-transaction-modules.md
5. src/pos/useCart.js, src/pos/useTables.js, src/pos/useTerminal.js
6. src/pos/stores/orderSessionStore.js and src/pos/stores/orderSession/*.js
7. every runtime caller of useCart(), useTables(), and useTerminal()
8. backend/tests/unit/orderSessionBoundaries.test.js and orderSessionStore.test.js
9. backend/services/CheckoutValidation.js, backend/modules/checkout/executeCheckout.js,
   src/pos/stores/orderSession/splitChecks.js, and every caller/test of their exports

Build an exact producer/caller/test matrix before scheduling a removal. Treat Vue
templates, Options API setup returns, Pinia ref semantics, dynamic property access,
source-reading tests, and store-level tests as callers. Preserve the single Order
session owner and existing transaction modules.

The permitted scope is only:
- route receipt/store/printing consumers directly to useTerminal();
- remove facade entries with no runtime facade consumer;
- stop returning five verified internal-only store helpers;
- remove activeCheckoutLocks from the CommonJS export while leaving the private Set;
- make MONEY_TOLERANCE and normalizePaymentMethod private and consolidate duplicate tests;
- make distributeOrderDiscount private while retaining its behavior coverage through
  buildSplitRequest().

Reject new stores, new runtime files, endpoint functions, generic HTTP clients,
mass fetch migration, business-rule changes, and overrideAttempts redesign. Give
every task exact paths, exact removals, a RED/GREEN check where a contract changes,
proportional focused tests, and a narrow commit. If a candidate cannot be proven
unused from runtime and tests, leave it exposed and record why.
```

## Verified ownership and caller baseline

| Interface | Current surface | Verified role |
|---|---:|---|
| `useOrderSessionStore` return | approximately 158 entries | Sole persistent Order/Table owner; only facades call it in production |
| `useCart()` | 123 entries | Cart/checkout compatibility facade plus 10 misplaced terminal proxies |
| `useTables()` | 65 entries | Table compatibility facade; two router-binding functions contain its only wrappers |
| `useTerminal()` | existing singleton composable | Actual owner of store identity, receipt state, and printing |
| `CheckoutValidation` | 5 exports | Three production interfaces plus two test-driven internals |
| frontend `splitChecks.js` | 4 exports | Three caller-facing pure operations plus one internal allocation helper |

Expected final surfaces after every task:

```text
useCart(): 101 entries (123 - 10 terminal proxies - 12 unused mappings)
useTables(): 56 entries (65 - 9 unused mappings)
useOrderSessionStore return: approximately 153 entries (five internal names removed)
CheckoutValidation: 3 exports
frontend splitChecks.js: 3 exports
executeCheckout.js: 1 export
```

### Runtime terminal-proxy consumers

- `src/components/pos/ReceiptPreviewModal.vue` obtains all ten terminal values through `useCart()` and uses no Order-session entry.
- `src/components/pos/ShiftReportModal.vue` already calls `useTerminal()` for `printMethod` but calls `useCart()` only for `storeName`.
- `src/components/TableSplits.vue` calls `useCart()` only for `storeName`, `storeAddress`, and `storePhone`.
- `src/components/PosTerminal.vue` already obtains terminal values directly from `useTerminal()`.

### Conservative facade-removal manifest

Remove these only from the compatibility facades, not from their owning stores:

```text
useCart (12):
originalSavedItems
activeOrderTaxInclusive
cartGrossSubtotal
splitBalanceDue
selectedOrderTypeObj
canVoidItems
canReprint
getItemTotal
applyLiveNumpad
processFinalAddToCart
openCashDrawer
quickLock

useTables (9):
restoredHeldReference
heldOrders
isDynamicTableMode
isFixedTableMode
isInsideTableOrder
selectedTable
fetchHeldOrders
markActiveTablePrinted
handleDropOnMaster
```

These names have no runtime source consumer through either facade. Several remain intentionally public on `useOrderSessionStore` because focused store tests use them or store actions depend on them.

### Internal-only store-return manifest

Keep each declaration and every internal use; remove only these five entries from the final `return` object in `src/pos/stores/orderSessionStore.js`:

```text
activeOrderTaxRegistrationType
canBypassPrintedLock
pricesMatch
findScannedCartLineIndex
getAddQuantity
```

No runtime file or test accesses those five through the Pinia store.

## Execution preflight

This plan is written on a dirty `master` where the owner has already approved 11 tracked prototype deletions and has unrelated untracked files. Do not begin implementation in that state.

- [ ] Confirm the prototype deletions have been committed to `master` or explicitly included in the chosen execution base.
- [ ] Create or switch to `codex/pos-interface-surface-cleanup`, preferably in an isolated worktree created through `using-git-worktrees`.
- [ ] Run `git status --short` and record every pre-existing path. Stop if the execution setup would omit, stash, stage, restore, or overwrite owner work.
- [ ] Confirm `git merge-base --is-ancestor master HEAD` exits 0 before Task 1.
- [ ] Do not run implementation from the disposable HTML-report path or create another runtime tree.

## Phase A — Frontend ownership and interface cleanup

### Task 1: Route terminal consumers to the terminal owner

**Files:**
- Modify: `src/components/pos/ReceiptPreviewModal.vue:243-266`
- Modify: `src/components/pos/ShiftReportModal.vue:203-219`
- Modify: `src/components/TableSplits.vue:282-301`
- Modify: `src/pos/useCart.js:5-7,136-147`
- Test: `backend/tests/unit/orderSessionBoundaries.test.js:14-24,42-67,106-129`

**Interfaces:**
- Consumes: the existing singleton `useTerminal()` return values, unchanged.
- Produces: `useCart()` with no dependency on `useTerminal()` and no receipt/store/printing entries; all three consumers retain the same refs/functions from their real owner.

- [ ] **Step 1: Change the facade contract test first**

Remove these exact keys from `CART_KEYS`:

```js
'storeName',
'storeAddress',
'storePhone',
'showReceiptModal',
'closeReceiptModal',
'lastOrder',
'receiptConfig',
'printReceipt',
'isPrintingBackend',
'useInvoiceNoOnly',
```

Add a source-ownership assertion inside `describe('POS state public boundaries', ...)`:

```js
it('keeps terminal state out of the cart facade', () => {
  const cartSource = readFileSync(resolve(process.cwd(), 'src/pos/useCart.js'), 'utf8');
  expect(cartSource).not.toContain("from './useTerminal.js'");
  expect(cartSource).not.toMatch(/\bterminal\./);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js
```

Expected: FAIL because `useCart()` still returns the ten terminal entries and still imports `useTerminal()`.

- [ ] **Step 3: Route each consumer directly**

In `ReceiptPreviewModal.vue`, replace:

```js
import { useCart } from '@/pos/useCart.js';
```

with:

```js
import { useTerminal } from '@/pos/useTerminal.js';
```

and replace the closing call of the existing ten-entry destructuring assignment:

```js
} = useCart();
```

with:

```js
} = useTerminal();
```

In `ShiftReportModal.vue`, delete the `useCart` import and replace:

```js
const { printMethod } = useTerminal();
const { storeName } = useCart();
```

with:

```js
const { printMethod, storeName } = useTerminal();
```

In `TableSplits.vue`, replace the `useCart` import with:

```js
import { useTerminal } from '@/pos/useTerminal.js';
```

and replace:

```js
const cartStore = useCart();
const { storeName, storeAddress, storePhone } = cartStore;
```

with:

```js
const { storeName, storeAddress, storePhone } = useTerminal();
```

In `useCart.js`, delete:

```js
import { useTerminal } from './useTerminal.js';
```

delete:

```js
const terminal = useTerminal();
```

and delete the complete `// terminal proxy` return block.

- [ ] **Step 4: Run the focused test and ownership searches**

Run:

```bash
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js
rg -n "useCart|cartStore" src/components/pos/ReceiptPreviewModal.vue src/components/pos/ShiftReportModal.vue src/components/TableSplits.vue
rg -n "useTerminal" src/components/pos/ReceiptPreviewModal.vue src/components/pos/ShiftReportModal.vue src/components/TableSplits.vue
```

Expected: PASS; first search returns no old facade/cartStore ownership in those files; second search finds all three direct terminal imports/calls.

- [ ] **Step 5: Commit only Task 1 files**

```bash
git add src/components/pos/ReceiptPreviewModal.vue src/components/pos/ShiftReportModal.vue src/components/TableSplits.vue src/pos/useCart.js backend/tests/unit/orderSessionBoundaries.test.js
git commit -m "refactor(pos): route terminal consumers to their owner"
```

### Task 2: Remove unused facade entries

**Files:**
- Modify: `src/pos/useCart.js:20-130`
- Modify: `src/pos/useTables.js:19-81`
- Test: `backend/tests/unit/orderSessionBoundaries.test.js:42-79`

**Interfaces:**
- Consumes: Task 1's terminal-free `useCart()`.
- Produces: the same compatibility facades minus the exact 21-entry conservative removal manifest; all remaining ref/function semantics are unchanged.

- [ ] **Step 1: Remove the 21 names from the expected contract arrays**

Delete the exact names listed in the conservative facade-removal manifest from `CART_KEYS` and `TABLE_KEYS`. Do not remove any additional key during execution, even if another key looks unused; expand scope only through a separately reviewed plan amendment.

- [ ] **Step 2: Run the facade test and verify RED**

Run:

```bash
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js
```

Expected: the two exact-key assertions FAIL because the facades still return the removed names.

- [ ] **Step 3: Delete only the matching return mappings**

Delete the 12 matching mappings from `useCart.js` and the 9 matching mappings from `useTables.js`. Do not alter imports, wrappers, Pinia usage, state declarations, actions, computed values, or the store return object in this task.

- [ ] **Step 4: Verify GREEN and prove no runtime facade caller was missed**

Run:

```bash
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js
rg -n "\b(originalSavedItems|activeOrderTaxInclusive|cartGrossSubtotal|splitBalanceDue|selectedOrderTypeObj|canVoidItems|canReprint|getItemTotal|applyLiveNumpad|processFinalAddToCart|openCashDrawer|quickLock)\b" src/components --glob "*.vue" --glob "*.js"
rg -n "\b(restoredHeldReference|heldOrders|isDynamicTableMode|isFixedTableMode|isInsideTableOrder|selectedTable|fetchHeldOrders|markActiveTablePrinted|handleDropOnMaster)\b" src/components --glob "*.vue" --glob "*.js"
```

Expected: test PASS; searches may find local/component-owned names but must find no destructuring/member access from `useCart()` or `useTables()`. If ownership is ambiguous, stop and retain that entry.

- [ ] **Step 5: Commit only Task 2 files**

```bash
git add src/pos/useCart.js src/pos/useTables.js backend/tests/unit/orderSessionBoundaries.test.js
git commit -m "refactor(pos): narrow compatibility facade surfaces"
```

### Task 3: Stop publishing internal store helpers

**Files:**
- Modify: `src/pos/stores/orderSessionStore.js:2854-3031`
- Test: `backend/tests/unit/orderSessionStore.test.js`
- Test: `backend/tests/unit/orderSessionBoundaries.test.js`

**Interfaces:**
- Consumes: the existing private declarations and internal calls, unchanged.
- Produces: the same store behavior while omitting five internal-only names from its Pinia return interface.

- [ ] **Step 1: Prove the five names have no external store consumer**

Run:

```bash
rg -n "\b(activeOrderTaxRegistrationType|canBypassPrintedLock|pricesMatch|findScannedCartLineIndex|getAddQuantity)\b" src backend/tests --glob "*.vue" --glob "*.js" --glob "*.ts"
```

Expected: matches are limited to declarations/internal uses/return lines in `orderSessionStore.js`; no component, facade, or test reads them. If any external consumer appears, remove that name from this task.

- [ ] **Step 2: Remove only the five return entries**

Delete these lines from the store's final return object:

```js
activeOrderTaxRegistrationType,
canBypassPrintedLock,
pricesMatch,
findScannedCartLineIndex,
getAddQuantity,
```

Leave their declarations and internal uses untouched.

- [ ] **Step 3: Run the focused Order-session gate**

Run:

```bash
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js backend/tests/unit/orderSessionStore.test.js
```

Expected: PASS with the existing test count; no Order behavior changes.

- [ ] **Step 4: Commit only the store**

```bash
git add src/pos/stores/orderSessionStore.js
git commit -m "refactor(pos): keep store helpers private"
```

## Phase B — Backend and pure-module test surfaces

### Task 4: Narrow CheckoutValidation to production interfaces

**Files:**
- Modify: `backend/services/CheckoutValidation.js:69-75`
- Modify: `backend/tests/unit/helpers.test.js:4-84`
- Delete: `backend/tests/unit/checkoutValidation.test.js`

**Interfaces:**
- Consumes: production callers of `hasDiscountsInPayload`, `assertNearMoney`, and `validatePayments`.
- Produces: exactly those three CommonJS exports; `MONEY_TOLERANCE` and `normalizePaymentMethod` remain private implementation details with behavior covered through the production interfaces.

- [ ] **Step 1: Make the desired interface fail first**

Replace the CheckoutValidation import at the top of `helpers.test.js` with:

```js
const checkoutValidation = require('../../services/CheckoutValidation');
const {
    assertNearMoney,
    validatePayments,
    hasDiscountsInPayload,
} = checkoutValidation;
```

Add before the current `assertNearMoney` tests:

```js
describe('CheckoutValidation interface', () => {
    it('exports only production validation operations', () => {
        expect(Object.keys(checkoutValidation).sort()).toEqual([
            'assertNearMoney',
            'hasDiscountsInPayload',
            'validatePayments',
        ]);
    });
});
```

Delete the direct `MONEY_TOLERANCE` assertion and the entire direct `normalizePaymentMethod` describe block. Add these behavior assertions inside the existing `validatePayments` describe:

```js
it('normalizes surrounding whitespace through the payment interface', () => {
    const result = validatePayments({
        payment_method: '  card  ',
        amount_tendered: 10,
        cash_amount: 0,
        card_amount: 10,
        change_due: 0,
    }, 10);
    expect(result.paymentMethod).toBe('card');
});

it.each([null, undefined, '', 'bitcoin'])('rejects invalid payment method %s', (paymentMethod) => {
    expect(() => validatePayments({
        payment_method: paymentMethod,
        amount_tendered: 10,
        cash_amount: 10,
        card_amount: 0,
        change_due: 0,
    }, 10)).toThrow('Invalid payment method');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run backend/tests/unit/helpers.test.js
```

Expected: only the exact-interface assertion FAILS because two extra exports remain.

- [ ] **Step 3: Narrow the CommonJS export and delete duplicate coverage**

Change `CheckoutValidation.js` to:

```js
module.exports = {
    hasDiscountsInPayload,
    assertNearMoney,
    validatePayments
};
```

Delete `backend/tests/unit/checkoutValidation.test.js`; its single test duplicates the more complete behavior and interface coverage in `helpers.test.js`.

- [ ] **Step 4: Verify callers and focused tests**

Run:

```bash
npx vitest run backend/tests/unit/helpers.test.js
rg -n "MONEY_TOLERANCE|normalizePaymentMethod" backend --glob "*.js"
rg -n "CheckoutValidation" backend/modules backend/routes backend/services --glob "*.js"
```

Expected: test PASS; the first search finds both names only inside `CheckoutValidation.js`; production callers import only the three retained operations.

- [ ] **Step 5: Commit only Task 4 files**

```bash
git add backend/services/CheckoutValidation.js backend/tests/unit/helpers.test.js backend/tests/unit/checkoutValidation.test.js
git commit -m "refactor(checkout): narrow validation module interface"
```

### Task 5: Test split discount allocation through the request interface

**Files:**
- Modify: `src/pos/stores/orderSession/splitChecks.js:52,94`
- Modify: `backend/tests/unit/splitChecks.test.js:73-84`

**Interfaces:**
- Consumes: `buildSplitRequest({ table, seats, orderDiscount, serviceChargeSnapshot, serviceChargeLine, makeId })`.
- Produces: unchanged fixed-discount allocation with `distributeOrderDiscount` private to the module implementation.

- [ ] **Step 1: Replace the internal-helper test with interface-level behavior**

Replace the current `distributes fixed order discount...` test with:

```js
it('caps and distributes a fixed order discount through the split request', async () => {
  const { buildSplitRequest } = await loadSplitChecks();
  const request = buildSplitRequest({
    table: { id: 5, table_number: 'A1', current_order_id: 8 },
    seats: [
      { id: 1, name: 'Seat 1', items: [{ id: 1, qty: 1, price: 10, note: '', tax_rate: 0 }] },
      { id: 2, name: 'Seat 2', items: [{ id: 2, qty: 1, price: 20, note: '', tax_rate: 0 }] },
      { id: 3, name: 'Seat 3', items: [{ id: 3, qty: 1, price: 0, note: '', tax_rate: 0 }] },
    ],
    orderDiscount: { type: 'fixed', value: 50 },
    serviceChargeSnapshot: null,
    serviceChargeLine: null,
    makeId: ids,
  });

  expect(request.splits.map((split) => split.subtotal)).toEqual([0, 0, 0]);
  expect(request.splits.map((split) => split.order_discount)).toEqual([
    { type: 'fixed', value: 10 },
    { type: 'fixed', value: 20 },
    { type: 'fixed', value: 0 },
  ]);
});
```

- [ ] **Step 2: Run the split test before changing production**

Run:

```bash
npx vitest run backend/tests/unit/splitChecks.test.js
```

Expected: PASS, proving the public request interface already covers the same capped-allocation behavior.

- [ ] **Step 3: Make the helper private**

Change:

```js
export const distributeOrderDiscount = (seatSubtotals, discount) => {
```

to:

```js
const distributeOrderDiscount = (seatSubtotals, discount) => {
```

Do not move or rewrite its implementation.

- [ ] **Step 4: Verify the interface and focused test**

Run:

```bash
npx vitest run backend/tests/unit/splitChecks.test.js
rg -n "distributeOrderDiscount" src backend/tests --glob "*.js"
```

Expected: test PASS; search finds only the private declaration and internal call in `splitChecks.js`.

- [ ] **Step 5: Commit only Task 5 files**

```bash
git add src/pos/stores/orderSession/splitChecks.js backend/tests/unit/splitChecks.test.js
git commit -m "refactor(pos): test split discounts through request interface"
```

### Task 6: Keep the checkout lock private

**Files:**
- Modify: `backend/modules/checkout/executeCheckout.js:1396`
- Modify: `backend/tests/unit/checkoutModuleWiring.test.js:12-23`

**Interfaces:**
- Consumes: the existing private `activeCheckoutLocks` Set and exported `executeCheckout` function.
- Produces: exactly `{ executeCheckout }`; lock acquisition/release behavior remains unchanged.

- [ ] **Step 1: Add the failing export contract**

Inside the existing `delegates checkout to the deep transaction module` test, add:

```js
expect(moduleSource).toMatch(/module\.exports\s*=\s*\{\s*executeCheckout\s*\};/);
expect(moduleSource).not.toMatch(/module\.exports\s*=.*activeCheckoutLocks/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run backend/tests/unit/checkoutModuleWiring.test.js
```

Expected: FAIL because the current export still includes `activeCheckoutLocks`.

- [ ] **Step 3: Narrow only the export**

Change the final line to:

```js
module.exports = { executeCheckout };
```

Do not modify the Set declaration or any `has`, `add`, or `delete` call.

- [ ] **Step 4: Verify lock ownership and focused tests**

Run:

```bash
npx vitest run backend/tests/unit/checkoutModuleWiring.test.js
rg -n "activeCheckoutLocks" backend --glob "*.js"
```

Expected: test PASS; search finds the declaration and lock lifecycle only in `executeCheckout.js`, with no import elsewhere.

- [ ] **Step 5: Commit only Task 6 files**

```bash
git add backend/modules/checkout/executeCheckout.js backend/tests/unit/checkoutModuleWiring.test.js
git commit -m "refactor(checkout): keep checkout lock private"
```

## Final gate

### Task 7: Verify the combined cleanup without widening scope

**Files:**
- Read only: all files changed by Tasks 1–6
- Do not create an evidence file unless the owner explicitly requests one.

**Interfaces:**
- Consumes: all narrowed interfaces from Tasks 1–6.
- Produces: a merge-readiness report; no production or test change unless a reproducible finding requires returning to its owning task.

- [ ] **Step 1: Run the combined focused test gate once**

```bash
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/useCart.logic.test.js backend/tests/unit/receiptPresentationContract.test.js backend/tests/unit/helpers.test.js backend/tests/unit/splitChecks.test.js backend/tests/unit/checkoutModuleWiring.test.js
```

Expected: all listed files and tests PASS.

- [ ] **Step 2: Run the production build once**

```bash
npm run build
```

Expected: Vite exits 0 and builds all configured entries. This is the relevant runtime-import check for the three direct `useTerminal()` migrations.

- [ ] **Step 3: Run structural and stale-interface checks**

```bash
rg -n "useCart\.js|useCart\(|cartStore" src/components/pos/ReceiptPreviewModal.vue src/components/pos/ShiftReportModal.vue src/components/TableSplits.vue
rg -n "MONEY_TOLERANCE|normalizePaymentMethod" backend --glob "*.js"
rg -n "distributeOrderDiscount" src backend/tests --glob "*.js"
rg -n "activeCheckoutLocks" backend --glob "*.js"
git diff --check
git status --short
```

Expected:

- no `useCart` import remains in the three terminal-only consumers;
- validation internals appear only inside `CheckoutValidation.js`;
- discount allocation appears only privately inside frontend `splitChecks.js`;
- checkout locks appear only inside `executeCheckout.js` and not in its export;
- `git diff --check` exits 0;
- status contains only this plan's intended changes plus the owner's pre-existing prototype deletions and unrelated untracked files.

- [ ] **Step 4: Compare the final diff against the scope ceiling**

```bash
git diff --stat master...HEAD
git diff --name-status master...HEAD
```

Reject the branch if it adds a runtime file, creates a store/module hierarchy, migrates HTTP, changes a payload/endpoint/formula, modifies `overrideAttempts`, or touches an unrelated source file.

- [ ] **Step 5: Do not create a verification-only commit**

If all gates pass, report the exact focused test count, build result, final facade key counts, deleted test file, and narrowed export lists. Tests have already run; do not rerun them solely before merge.

## Explicitly deferred work

- No mass migration of the remaining 150 direct `fetch()` calls. Continue using `fetchJson()` only when a feature is already being edited and needs parsed JSON without response metadata.
- No universal HTTP error module until backend error envelopes are consistent and a real feature requires it.
- No split of `orderSessionStore.js` by line count. Extract a pure `cartLines.js` only when a real cart-line/modifier/bundle/barcode feature proves duplicated transformation rules.
- No `overrideAttempts` redesign. A test-only reset interface or injected Map would be a larger interface, not a smaller one.
- No removal of store entries currently used by `orderSessionStore.test.js`; test-driven access is reviewed separately only when those tests can exercise the same behavior through an existing higher-level interface.

## Adversarial plan-attack prompt

Run this prompt against the plan before execution:

```text
Assume the POS Interface Surface Cleanup plan is wrong, incomplete, and capable
of breaking a Friday-night checkout even if every named test passes. Your job is
to disprove its safety before code execution. Use ponytail at full intensity.

Re-read the Phase 4 state-ownership plan, Phase 5 path plan, Phase 6 native-HTTP
plan, Phase 7 table transaction plan, and the current source—not remembered line
numbers. Rebuild these manifests independently:

1. Every runtime and test caller of useCart(), useTables(), useTerminal(), and
   useOrderSessionStore(). Include Vue templates, setup returns, object aliases,
   dynamic bracket access, source-reading tests, and mocked composables.
2. Every producer and consumer of the 21 facade-removal candidates and five
   store-return candidates. Reject any removal with an unexplained consumer.
3. Every CheckoutValidation import. Prove hasDiscountsInPayload, assertNearMoney,
   and validatePayments stay exported; prove the deleted test has no unique case.
4. Every distributeOrderDiscount caller. Prove buildSplitRequest retains fixed,
   percent, capped, zero-seat, and service-charge behavior without exporting the
   helper.
5. Every activeCheckoutLocks reference and all early-return/catch/finally release
   paths. Prove only export visibility changes—not concurrency behavior.

Attack singleton identity: confirm direct useTerminal() calls return the same
module-scoped refs used by checkout and PosTerminal, and no consumer relies on
useCart() initialization side effects. Attack reactivity: confirm every migrated
value remains a ref/function with identical Options API unwrapping. Attack scope:
reject new runtime files, generic clients, HTTP migration, new Pinia stores,
overrideAttempts changes, payload/formula/storage/permission/printing changes,
and unrelated cleanup.

Inspect each proposed RED test: it must fail for the intended interface reason,
not syntax, mocks, database setup, or stale source text. Inspect each GREEN gate:
it must execute or scan the actual changed path. Check commands on Windows
PowerShell and correct quoting if needed. Keep one final build and one combined
focused test run; do not demand a full suite for export-only and import-only work.

Return: (a) blocking findings ordered by severity with exact path/line evidence,
(b) missing callers/tests, (c) overengineering to delete, (d) corrected task text,
and (e) a final GO/NO-GO. Do not execute implementation.
```

## Plan self-review record

- **Spec coverage:** terminal ownership → Task 1; unused facade surface → Task 2; internal store surface → Task 3; validation internals/duplicate test → Task 4; split helper → Task 5; checkout lock export → Task 6; proportional combined verification → Task 7.
- **Scope control:** native HTTP migration, store splitting, new modules, and `overrideAttempts` are explicitly deferred.
- **File creation:** zero runtime/test files created; one duplicate test file deleted during implementation.
- **Behavior:** every production implementation remains in place. Only imports, return objects, and export objects narrow.
- **Test proportionality:** focused RED/GREEN per changed interface, one combined focused gate, one production build, no automatic full suite.
- **Dirty-tree safety:** execution is blocked until the already-approved prototype deletions are committed or deliberately carried; unrelated untracked files remain untouched.

## Adversarial review outcome

The plan-attack prompt was applied against the current repository. Result: **GO for later execution after the dirty-tree preflight passes.** No implementation was executed.

Corrections made during the attack:

- Added an explicit execution block for the currently uncommitted prototype deletions; an executor may not silently branch from a base that omits them.
- Corrected the final stale-import search to avoid fragile PowerShell quote escaping.
- Added `useCart.logic.test.js` and `receiptPresentationContract.test.js` to the combined focused gate so facade behavior and the receipt surfaces run together.
- Added exact expected final interface counts, preventing an executor from deleting extra “apparently unused” entries.
- Independently re-scanned direct/dynamic composable access. No bracket/dynamic facade consumer was found; `Object.keys()` is limited to the intended facade contract test.
- Independently confirmed the five store-return candidates have no caller outside `orderSessionStore.js`.
- Independently confirmed all production `CheckoutValidation` callers use only the three retained exports.
- Independently confirmed `distributeOrderDiscount` has one internal call and one direct test caller, and `activeCheckoutLocks` has no caller outside its owning module.
- Confirmed `useTerminal()` owns module-scope singleton refs; calling it directly preserves identity and does not require initialization arguments for receipt/store/printing consumers.

Rejected during the attack:

- Removing additional facade entries from a broader text-only candidate list.
- Removing store entries used by `orderSessionStore.test.js` merely to make the public count smaller.
- Adding an HTTP client, feature endpoint modules, a test-reset interface, or a new Pinia store.
- Requiring the full test suite for import/return/export-only changes when the focused gate and production build exercise the affected paths.
