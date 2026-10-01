# POS State Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Use ponytail at full intensity. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 3,295-line POS session store easier to change by extracting four already-proven internal seams while preserving the single Pinia state owner, every `useCart()` / `useTables()` consumer contract, browser-storage behavior except for the explicit logout cleanup defect below, and every Phase 1–3 backend/HTTP contract. Correct one proven split-line identity defect at the seam where its regression belongs.

**Architecture:** `useOrderSessionStore` remains the only persistent POS order/table Pinia store and the only orchestrator of Vue refs, permissions, `fetch`, alerts, printing, and navigation. Extract pure data transformations for split checks and checkout, one browser-storage adapter, and one small table-session boundary object. `useCart.js` and `useTables.js` remain compatibility facades. Do not move files into `src/` in this phase; Phase 5 owns path migration and will move the new cohesive directory as a unit.

**Tech Stack:** Vue 3 Composition API, Pinia, JavaScript ES modules, browser `localStorage`, native `fetch`, Vitest 4, Vite.

**Planning status:** Implemented and owner-corrected on `codex/pos-state-ownership`. The final gate passed on 2026-07-23; Phase 5 has not started.

## Global constraints

- Phases 1–3 are prerequisites. Keep `SavedOrderLines`, `saveTableOrder`, `markTablePrinted`, and `executeCheckout` as the backend sources of truth established there.
- Preserve all public URLs and JSON shapes, especially `api/pos/checkout`, `api/pos/table_order`, `api/pos/table_splits/split`, and table workspace endpoints.
- Preserve the complete returned key sets and ref/function semantics of `useCart()` and `useTables()`. Components must not import the new internal modules.
- Keep `useOrderSessionStore` and `useOrderUiStore` as the only POS Pinia stores. Do not add an Order, Checkout, Split, Persistence, or Table Pinia store.
- Do not introduce a controller/service/repository hierarchy, dependency-injection container, context bag, class framework, TypeScript conversion, package, schema change, HTTP client, or backend edit.
- New extraction modules receive plain values and return plain values. They must not import Pinia stores, composables, components, the router, or browser UI globals.
- The one exception is `tableSession.js`: it may accept the existing Vue refs and storage object in a small constructor because the monotonic session token is stateful by definition. It must not perform HTTP, navigation, alerts, or order mutation.
- Do not change money algorithms. Continue using `src/utils/posTotals.js` and `src/utils/receiptPresentation.js`; extracted code imports those canonical utilities rather than copying formulas.
- Do not move runtime roots or rewrite imports in this phase. That is Phase 5.
- Use focused tests at each extraction. Run the full unit suite and production build once at the final gate, unless production code changes after that gate.
- File-size reduction is evidence, not a target. Do not move unrelated code merely to reduce the store's line count.

## Evidence and corrected boundary

- `assets/js/composables/stores/orderSessionStore.js` is 3,295 lines and exposes both order and table behavior.
- `assets/js/composables/useCart.js` is a 148-line logic-free facade used by POS components; `assets/js/composables/useTables.js` is a 90-line facade with only two router-binding wrappers.
- `assets/js/composables/stores/orderUiStore.js` already owns transient modal/input state. Creating another UI or split store would duplicate that lifecycle.
- Split behavior is cohesive at `orderSessionStore.js:1458-1642`: item division/movement, fee allocation, order-discount allocation, and request payload construction. Its money-sensitive cases already have regressions in `backend/tests/unit/orderSessionStore.test.js`.
- The three existing split move functions merge on product ID + note + price only (`orderSessionStore.js:1518`, `1532`, and `1547`). Two frozen lines can share those fields while differing by `order_item_id`, modifiers, tax, or surcharge. Merging them destroys the Phase 1 saved-line identity needed by split settlement. Phase 4 must make the merge identity include the full financially relevant line identity, with a failing regression first.
- Checkout attempt and transformation behavior spans `orderSessionStore.js:474-578` and `2649-2879`. Browser attempt persistence already has one owner in `stores/checkoutAttemptCache.js`; do not duplicate it.
- Order persistence is currently scattered across store watchers, `clearOrderSlice`, `loadSavedOrder`, `posSessionStorage.js`, and the mount handoff in `src/components/PosTerminal.vue:1605-1656`.
- `posSessionStorage.js` clears seven keys on logout/session expiry but omits `pos_service_charge_snapshot` and `pos_checkout_attempt`. This is a concrete stale-session cleanup defect. Phase 4 must add both to the canonical cleanup list with a failing regression first. `pos_backup_order_types` is terminal reference data, not order/customer/session data, and remains outside that list.
- Table async race protection is cohesive at `orderSessionStore.js:313-340`: token capture, current-session comparison, invalidation, QR-residue cleanup, and leave. The workspace fetch/save actions depend on order state, UI, permissions, HTTP, and navigation; moving them now would require a broad port object or a second store with circular checkout ownership.
- `backend/tests/unit/tableFloorPlan.transfer.static.test.js` reads `orderSessionStore.js` text directly. Its transfer/join block is not moved in Phase 4, so the path remains valid. If implementation scope changes, replace that source-slice assertion in the same commit rather than silently breaking it.
- Phase 4 changes no SQL and cannot change the Phase 2/3 query-count baselines. Backend database benchmarks are therefore out of scope; frontend build output and focused test duration are recorded as comparative evidence only.

## Corrected ownership after Phase 4

| File | Responsibility |
|---|---|
| `assets/js/composables/stores/orderSessionStore.js` | Sole persistent Pinia owner; Vue refs/computed values, permissions, HTTP orchestration, UI effects, printing, navigation handoff, and calls to extracted transformations. |
| `assets/js/composables/stores/orderUiStore.js` | Existing transient POS UI state. Unchanged except for a proven defect. |
| `assets/js/composables/stores/orderSession/splitChecks.js` | Pure split quantity/movement, fee-cent allocation, discount allocation, and request-data construction. |
| `assets/js/composables/stores/orderSession/checkoutFlow.js` | Pure checkout fingerprint source, payment allocation, frozen request snapshot/payload, and successful receipt/last-order data construction. |
| `assets/js/composables/stores/orderSession/orderSessionPersistence.js` | Canonical storage keys and safe read/write/remove/consume operations for order, table, and handoff state. |
| `assets/js/composables/stores/orderSession/tableSession.js` | Monotonic table-session token, stale-response check, QR-residue clearing, active-table persistence boundary, and table normalization. |
| `assets/js/composables/stores/checkoutAttemptCache.js` | Existing versioned checkout-attempt key cache. Remains the sole attempt-cache implementation. |
| `assets/js/composables/posSessionStorage.js` | Compatibility export used by auth/app callers; delegates its canonical key list and cleanup to `orderSessionPersistence.js`. |
| `assets/js/composables/useCart.js`, `assets/js/composables/useTables.js` | Unchanged public migration facades. |

The dependency direction is:

```text
components -> useCart/useTables -> orderSessionStore
                                  -> orderUiStore
orderSessionStore -> splitChecks / checkoutFlow / orderSessionPersistence / tableSession
checkoutFlow -> canonical posTotals + receiptPresentation utilities
posSessionStorage -> orderSessionPersistence
```

No extracted module imports `orderSessionStore`, `orderUiStore`, `useCart`, `useTables`, or a component.

---

### Task 1: Freeze the public and ownership contracts

**Files:**
- Create: `backend/tests/unit/orderSessionBoundaries.test.js`
- Create: `docs/superpowers/evidence/2026-07-23-pos-state-ownership.md`
- Read only: `assets/js/composables/useCart.js`
- Read only: `assets/js/composables/useTables.js`
- Read only: `assets/js/composables/stores/orderSessionStore.js`
- Read only: `assets/js/composables/stores/orderUiStore.js`

**Interfaces:**
- Consumes: the merged Phase 3 frontend and backend contract.
- Produces: an exact facade-key baseline, a forbidden-import boundary, and pre-change build/size evidence.

- [x] **Step 1: Add facade contract assertions**

Instantiate both facades with Pinia/router/terminal mocks and assert their complete sorted returned key arrays. Copy the keys from the current runtime result, not from this prose. Assert representative semantics as well: `cart` and `activeTable` are refs; `processCheckout`, `confirmSplit`, `closeTable`, and `restoreTableSplit` are functions; the router wrappers still pass the active router.

- [x] **Step 2: Add the internal dependency boundary assertion**

Once the directory exists, inspect each file under `stores/orderSession/` and reject imports containing `orderSessionStore`, `orderUiStore`, `useCart`, `useTables`, `/components/`, or `vue-router`. Allow `vue` only in `tableSession.js`. Also assert `useCart.js` and `useTables.js` do not directly import any new leaf module.

- [x] **Step 3: Verify RED and record baseline**

```powershell
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js
npm run build
(Get-Content assets/js/composables/stores/orderSessionStore.js).Count
git rev-parse HEAD
```

The new boundary test must fail only because the planned module directory does not exist. Record the exact commit, store line count, build result, generated asset sizes, and command wall time in the evidence file. Do not create a hard timing threshold.

- [x] **Step 4: Commit the contract baseline**

```powershell
git add backend/tests/unit/orderSessionBoundaries.test.js docs/superpowers/evidence/2026-07-23-pos-state-ownership.md
git commit -m "test: baseline POS state boundaries"
```

---

### Task 2: Extract split transformations without moving split state

**Files:**
- Create: `assets/js/composables/stores/orderSession/splitChecks.js`
- Create: `backend/tests/unit/splitChecks.test.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `backend/tests/unit/orderSessionBoundaries.test.js`

**Interfaces:**
- Consumes: plain split items/seats, order discount, service-charge fee/snapshot, and parent table identity.
- Produces: new arrays or a plain `{ tableId, currentOrderId, splits, voidReason }` request object. It performs no fetch and mutates no Pinia/UI state.

- [x] **Step 1: Characterize the pure split rules in RED tests**

Cover at least:

- 1/3 and 1/6 fractional quantity conservation at four decimals, with residue on the last piece;
- moving a partial/full quantity between unassigned and seat collections without mutating the input arrays;
- merge identity preserving distinct same-product lines when note or price differs;
- percent and fixed order-discount distribution, including capped fixed discount and exact sum conservation;
- service-charge cents distributed by largest remainder with deterministic index tie-breaking;
- no active seats produces no request; each generated split retains `order_discount` and frozen item fields.

Run:

```powershell
npx vitest run backend/tests/unit/splitChecks.test.js
```

Expected: RED because the module does not exist.

- [x] **Step 2: Move only transformations**

Export a small explicit interface:

```js
splitItemFractionally(items, index, ways, makeId)
moveSplitItem({ fromItems, toItems, index, makeId })
distributeOrderDiscount(seatSubtotals, discount)
buildSplitRequest({ table, seats, orderDiscount, serviceChargeSnapshot, serviceChargeLine, makeId })
```

Use `lineNet` and `roundMoney` from the canonical totals utility. `makeId` is a function supplied by the store so tests remain deterministic; do not add an ID service. The merge comparison must cover saved `order_item_id`, product identity, price, note, modifiers, tax, surcharge, and discount context; implement one small canonical comparator in this module rather than repeating a compound condition. Keep drag events, DOM scrolling, permissions, modal state, alerts, `fetch`, close/navigation, and `isProcessing` in the store.

The store replaces its arithmetic/payload blocks with calls to these functions, then applies returned arrays to `orderUiStore` and posts the returned request unchanged.

- [x] **Step 3: Verify split parity**

```powershell
npx vitest run backend/tests/unit/splitChecks.test.js backend/tests/unit/orderSessionStore.test.js
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js
git diff --check
```

Do not weaken existing split assertions. Compare the request body in the existing 10% discount test before and after extraction.

- [x] **Step 4: Commit**

```powershell
git add assets/js/composables/stores/orderSession/splitChecks.js assets/js/composables/stores/orderSessionStore.js backend/tests/unit/splitChecks.test.js backend/tests/unit/orderSessionBoundaries.test.js
git commit -m "refactor: extract split check transformations"
```

---

### Task 3: Extract checkout transformations around the existing attempt cache

**Files:**
- Create: `assets/js/composables/stores/orderSession/checkoutFlow.js`
- Create: `backend/tests/unit/checkoutFlow.test.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Read only: `assets/js/composables/stores/checkoutAttemptCache.js`
- Test: `backend/tests/unit/orderSessionStore.test.js`
- Test: `backend/tests/unit/checkoutAttemptCache.test.js`

**Interfaces:**
- Consumes: plain order, table, payment, actor/shift, tax, customer, service-charge, and server-result values.
- Produces: a fingerprint source, frozen checkout context/payload, and last-order receipt data. It performs no storage, fetch, printing, navigation, UI mutation, or idempotency-key generation.

- [x] **Step 1: Add RED contract tests**

Test exact behavior for:

- actor, shift, table/edit identity, customer/order metadata, payment fields, cart fields, and service-charge identity in the fingerprint source;
- cash, card, and split revenue plus tendered/change fields;
- deep cart freeze so a later live-cart mutation cannot change the request or receipt;
- split-table parent IDs and subscription purchase inclusion;
- server totals/receipt object winning over frozen fallbacks;
- fallback receipt construction using the frozen tax mode, discount, items, and totals;
- preservation of invoice/order/ticket/table/cashier/customer fields in `lastOrder`.

Run the new test and confirm RED.

- [x] **Step 2: Extract the plain transformation interface**

Export:

```js
buildCheckoutFingerprintSource(input)
buildCheckoutRequest(input)
buildSuccessfulCheckoutResult({ response, frozen })
```

`buildCheckoutRequest` returns `{ payload, frozen }`. `frozen` contains only values needed after the await: cart, table owner snapshot, customer/cashier/order-type display data, tax mode, and display totals. The store remains responsible for required-hash validation, `resolveCheckoutAttemptKey`, `completedCheckoutKeys`, request submission, response parsing, service-charge conflict handling, current-table token checks, state reset, printing, kitchen dispatch, alerts, and navigation.

Do not merge `checkoutAttemptCache.js` into this module and do not implement a second fingerprint hash. The cache hashes the plain source returned by `buildCheckoutFingerprintSource`.

- [x] **Step 3: Attack async mutation and duplicate seams**

```powershell
npx vitest run backend/tests/unit/checkoutFlow.test.js backend/tests/unit/checkoutAttemptCache.test.js
npx vitest run backend/tests/unit/orderSessionStore.test.js -t "checkout|idempotency|receipt|table session"
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js
git diff --check
```

Preserve the existing rule that a receipt-print failure cannot turn a completed charge into a checkout failure and that a late Table A response cannot clear Table B.

- [x] **Step 4: Commit**

```powershell
git add assets/js/composables/stores/orderSession/checkoutFlow.js assets/js/composables/stores/orderSessionStore.js backend/tests/unit/checkoutFlow.test.js
git commit -m "refactor: extract checkout flow transformations"
```

---

### Task 4: Establish one order-session persistence adapter

**Files:**
- Create: `assets/js/composables/stores/orderSession/orderSessionPersistence.js`
- Create: `backend/tests/unit/orderSessionPersistence.test.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `assets/js/composables/posSessionStorage.js`
- Modify: `src/components/PosTerminal.vue`
- Modify: `backend/tests/unit/posSessionStorage.test.js`
- Test: `backend/tests/unit/tableSession.logic.test.js`

**Interfaces:**
- Consumes: an explicit storage object and plain values.
- Produces: safe persisted snapshots and one-time handoff reads. It does not know Vue, Pinia, auth, router, HTTP, alerts, or components.

- [x] **Step 1: Add RED persistence and logout-cleanup tests**

Cover:

- canonical key groups for order data, active-table data, one-time handoffs, kitchen-fired residue, service-charge snapshot, and checkout attempt;
- safe JSON reads return a caller-provided fallback and remove malformed one-time handoffs when consumed;
- empty/falsy note and discount values do not inherit stale stored values;
- consuming `pos_restore_held_order` removes it exactly once;
- clearing POS order/session data removes `pos_service_charge_snapshot` and `pos_checkout_attempt` as well as the seven existing keys;
- `pos_backup_order_types` is not cleared by order/session cleanup.

- [x] **Step 2: Implement explicit storage functions**

Keep the interface narrow and named for behavior:

```js
readOrderSnapshot(storage)
writeCart(storage, cart)
writeOrderNote(storage, note)
writeOrderDiscount(storage, discount)
writeServiceChargeSnapshot(storage, snapshot)
readActiveTable(storage)
writeActiveTable(storage, table)
consumeStoredJson(storage, key)
hasPendingTableSession(storage, activeTable)
clearOrderData(storage)
clearPosOrderSession(storage)
```

Export the key constants used by callers. Do not expose a generic storage repository or a `get(key)` / `set(key)` abstraction.

Import `CHECKOUT_ATTEMPT_CACHE_KEY` from the existing `checkoutAttemptCache.js` when building the cleanup key list; do not redeclare the checkout-attempt literal or its value format in the persistence adapter.

- [x] **Step 3: Rewire all owned literals**

Replace order/cart/note/discount/service-snapshot/active-table/restore-handoff reads and writes in the store and the `PosTerminal.vue` mount restore block. Keep auth/session-user storage, language preferences, reference cache, and unrelated component storage untouched.

`posSessionStorage.js` becomes a compatibility re-export/delegator so the existing imports in App, Login, auth, idle tracking, and admin session remain unchanged.

- [x] **Step 4: Prove no stale duplicate ownership remains**

```powershell
npx vitest run backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/posSessionStorage.test.js backend/tests/unit/tableSession.logic.test.js
npx vitest run backend/tests/unit/orderSessionStore.test.js -t "startNewOrder|restoreHeldOrder|loadSavedOrder|clearCart|service charge|idempotency"
rg -n "pos_cart|pos_order_note|pos_order_discount|pos_service_charge_snapshot|pos_active_table|pos_restore_held_order|pos_checkout_attempt" assets/js/composables/stores/orderSessionStore.js src/components/PosTerminal.vue assets/js/composables/posSessionStorage.js assets/js/composables/stores/orderSession
git diff --check
```

Expected: key declarations and storage mechanics are in `orderSessionPersistence.js`; the store/component may mention imported semantic functions but contain no direct owned-key storage calls. `checkoutAttemptCache.js` may retain its canonical checkout-cache key and mechanics.

- [x] **Step 5: Commit**

```powershell
git add assets/js/composables/stores/orderSession/orderSessionPersistence.js assets/js/composables/stores/orderSessionStore.js assets/js/composables/posSessionStorage.js src/components/PosTerminal.vue backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/posSessionStorage.test.js
git commit -m "refactor: centralize POS session persistence"
```

---

### Task 5: Extract the table-session race boundary, not the table feature

**Files:**
- Create: `assets/js/composables/stores/orderSession/tableSession.js`
- Create: `backend/tests/unit/tableSessionBoundary.test.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Test: `backend/tests/unit/tableSession.logic.test.js`
- Test: `backend/tests/unit/orderSessionStore.test.js`

**Interfaces:**
- Consumes: existing `activeTable` and `activeQrDraft` refs plus the persistence adapter/storage.
- Produces: `tableSessionSeq`, `capture()`, `isCurrent(owner)`, `invalidate()`, `leave()`, and `normalizeTable(table, options)`.

- [x] **Step 1: Add RED state-machine tests**

Test enter/switch/leave sequences, monotonically increasing tokens, QR draft cleanup, active-table persistence/removal, null IDs, string-vs-number ID comparison, and stale Table A owners after entering Table B. Test `normalizeTable` against the exact fields currently preserved by `loadTableOrder`, including Phase 2/3 public display IDs and split parent identity.

- [x] **Step 2: Move the existing boundary mechanically**

Construct the boundary once inside `useOrderSessionStore` and alias its returned members to the existing local names. Keep the public `tableSessionSeq`, `invalidateTableSession`, and `clearTableScopedResidue` behavior compatible with current tests. The store's async table load/save/draft/checkout actions continue to capture and verify the boundary around awaits.

Do not move `loadTableWorkspace`, `loadActiveTableOrder`, `updateActiveTableOrder`, hold, transfer/join/disjoin, split HTTP, printing, permissions, or navigation. Those actions are coupled orchestration; moving them behind callbacks in this phase would hide dependencies rather than improve ownership.

- [x] **Step 3: Run race and table cohorts**

```powershell
npx vitest run backend/tests/unit/tableSessionBoundary.test.js backend/tests/unit/tableSession.logic.test.js
npx vitest run backend/tests/unit/orderSessionStore.test.js -t "table|split|guest check|service charge|checkout"
npx vitest run backend/tests/unit/tableFloorPlan.transfer.static.test.js backend/tests/unit/orderSessionBoundaries.test.js
git diff --check
```

- [x] **Step 4: Commit**

```powershell
git add assets/js/composables/stores/orderSession/tableSession.js assets/js/composables/stores/orderSessionStore.js backend/tests/unit/tableSessionBoundary.test.js
git commit -m "refactor: extract table session boundary"
```

---

### Task 6: Adversarial review and one final phase gate

**Files:**
- Modify only for concrete extraction defects: Phase 4 files above
- Modify: `docs/superpowers/evidence/2026-07-23-pos-state-ownership.md`
- Modify: `docs/superpowers/plans/2026-07-22-pos-architecture-refactor-roadmap.md`

**Interfaces:**
- Consumes: four green extraction commits.
- Produces: unchanged facades and HTTP behavior, one implementation per rule, recorded verification, and no Phase 5 path migration.

- [x] **Step 1: Execute the separate break prompt**

Follow `docs/superpowers/plans/2026-07-23-pos-state-ownership-break-review-prompt.md`. Fix only reproducible defects or plan violations. For each production-code fix, rerun the smallest owning test cohort.

- [x] **Step 2: Prove public and dependency contracts**

```powershell
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js
rg -n "from .*orderSession/(splitChecks|checkoutFlow|orderSessionPersistence|tableSession)" assets/js src
rg -n "from .*orderSessionStore|from .*orderUiStore|from .*useCart|from .*useTables|vue-router|/components/" assets/js/composables/stores/orderSession
rg -n "api/pos/checkout|api/pos/table_splits/split|api/pos/table_order" assets/js/composables/stores/orderSessionStore.js assets/js/composables/stores/orderSession
git diff --check
```

Expected: only the store and persistence compatibility adapter import leaf modules; components still use facades; leaf modules contain no forbidden upward imports; endpoint literals and fetch orchestration remain in the store.

- [x] **Step 3: Run the final gate once**

```powershell
npm run test:unit
npm run build
```

Record exact file/test counts, schema-drift result from `pretest:unit`, build output asset sizes, command times, final store line count, and commit in the evidence file. Compare build asset sizes to Task 1 without inventing a threshold. Any unexpected material growth must be explained or corrected.

- [x] **Step 4: Inspect scope and duplicate implementations**

```powershell
git diff --stat master...HEAD
git diff --name-status master...HEAD
git diff master...HEAD -- package.json package-lock.json backend server.js
rg -n "const distributeOrderDiscount|const buildCheckoutFingerprint|function buildCheckoutFingerprint|localStorage\.(getItem|setItem|removeItem)" assets/js/composables/stores/orderSessionStore.js assets/js/composables/stores/orderSession
```

Expected: no backend, schema, dependency, URL, or root-path migration; no duplicate extracted implementation; direct storage calls in the store remain only for explicitly out-of-scope reference or kitchen/printing behavior, with each occurrence justified in evidence.

- [x] **Step 5: Record completion and commit docs**

Update only Phase 4 in the roadmap after the final gate passes. Do not mark Phase 5 started.

```powershell
git add docs/superpowers/evidence/2026-07-23-pos-state-ownership.md docs/superpowers/plans/2026-07-22-pos-architecture-refactor-roadmap.md
git commit -m "docs: record POS state ownership verification"
```

## Explicit deferrals

- Moving `assets/js` runtime code into `src/pos/**` is Phase 5 path work.
- A separate table Pinia store is deferred until checkout no longer creates a circular owner and a real independent lifecycle is proven.
- Moving table HTTP actions is deferred; do not replace visible dependencies with callback/port bags.
- Native HTTP wrapper migration, backend table relationships/split persistence, helper ownership, prototype cleanup, and admin structure are not Phase 4.
- No offline order backup, cloud sync, or new persistence layer is introduced.

## Self-review result

- The original “table workspace lifecycle” item was narrowed to the actual table-session race boundary. This prevents a speculative second store or dependency-injection factory while preserving the most failure-prone lifecycle invariant.
- Split and checkout modules own transformations, not state or side effects; the store remains the visible workflow orchestrator.
- Existing `checkoutAttemptCache.js`, `posTotals.js`, and `receiptPresentation.js` remain canonical instead of being copied.
- Every new path, modified path, public interface, source-reading test, focused cohort, final gate, and Phase 5 deferral is named.
- The only intentional behavior fixes are complete logout/session cleanup of service-charge/checkout-attempt residue and preservation of financially distinct split lines. Both are tied to exact current-code evidence and protected by RED tests.
