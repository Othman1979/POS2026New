# POS Frontend Editability Implementation Plan

> Execution is intentionally deferred. This plan preserves the public POS behavior and explicitly rejects a big-bang store rewrite.

**Goal:** Make the POS frontend easier to change by giving transport, catalog UI, cart UI, and table workflow clearer owners while preserving one reactive source of truth and the current `useCart()` / `useTables()` caller contracts.

**Architecture:** Apply an incremental strangler refactor. First pin caller contracts and move misplaced network calls to domain owners. Then extract two complete visual workspaces from `PosTerminal.vue`. Finally attempt one private table-workflow extraction behind the existing Pinia store only if its dependency interface passes a strict depth test. Do not create multiple public stores merely to reduce line counts.

**Stack:** Vue 3.5, Pinia 2.2, Vite 6, Vitest 4, Playwright.

## Non-goals

- No UI redesign or changed cashier/table workflow.
- No TypeScript conversion.
- No new state, query, HTTP, or component library.
- No admin-dashboard `fetch()` migration.
- No global ban on `fetch()` inside legitimate feature owners such as `useAuth()`.
- No cart/table/checkout public-store rewrite.
- No changes to `useCart()` or `useTables()` call sites unless narrowing a proven-unused key.
- No one-function files, context bags, or prop/event forwarding forests.

## Planned production files

**Create:**

- `src/pos/stores/orderSession/orderSessionApi.js`
- `src/components/pos/PosCatalogWorkspace.vue`
- `src/components/pos/PosCartWorkspace.vue`

**Conditionally create only after Task 5's dependency gate passes:**

- `src/pos/stores/orderSession/tableOrderWorkflow.js`

**Modify:**

- `src/pos/stores/orderSessionStore.js`
- `src/pos/useProducts.js`
- `src/pos/categoryPriceSync.js`
- `src/pos/useAuth.js`
- `src/components/PosTerminal.vue`
- `backend/tests/unit/orderSessionBoundaries.test.js`
- `backend/tests/unit/frontendRuntimePaths.test.js`
- focused component/source tests listed below

Do not move files or rename the existing public paths.

## Design budgets

These are stop conditions, not aspirations:

- `useCart()` and `useTables()` key sets remain unchanged until a key is proven unused by every production consumer.
- A new workspace component may call existing facades directly; it must not receive dozens of props that mirror a facade.
- A workspace component should have at most 6 shell-level props/events combined. If it needs more, ownership is drawn incorrectly.
- `tableOrderWorkflow.js`, if created, may accept at most 12 named inbound capabilities and no anonymous `context`, `deps`, or `helpers` bag.
- The table workflow must remove or relocate at least 500 cohesive lines from `orderSessionStore.js`; otherwise do not add the file.
- No task may temporarily maintain duplicate cart/table refs.
- No task adds more than one production file per extracted ownership seam.

## Task 1: Build truthful consumer and transport manifests

**Files:**

- Modify `backend/tests/unit/orderSessionBoundaries.test.js`
- Create or modify `src/components/__tests__/posTerminalOwnership.spec.js`

**Step 1: Pin the direct-store boundary**

Extend the existing boundary test to assert that production files outside `src/pos/useCart.js` and `src/pos/useTables.js` do not call `useOrderSessionStore()`.

Exclude tests from the production scan. This makes the compatibility facades an enforceable boundary.

**Step 2: Record facade usage before narrowing anything**

Create a small test-local scanner or explicit manifest that identifies keys destructured from `useCart()` and `useTables()` by each production consumer. The scanner is test code, not a runtime dependency.

Use the manifest to classify keys as:

- used by a current production caller;
- compatibility-only but intentionally retained;
- unreferenced and removable.

Do not delete a key in this task.

**Step 3: Pin terminal component ownership without blessing misplaced transport**

Assert that POS components never import private order-session leaf modules. Do not snapshot the current count of three terminal `fetch()` calls as an accepted contract. Add the zero-fetch assertion as the red test immediately before Task 2's transport move, and do not commit that assertion until it is green.

**Step 4: Run the focused tests**

```powershell
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js src/components/__tests__/posTerminalOwnership.spec.js
```

**Step 5: Commit the boundary evidence**

```powershell
git add backend/tests/unit/orderSessionBoundaries.test.js src/components/__tests__/posTerminalOwnership.spec.js
git commit -m "test: pin POS frontend ownership boundaries"
```

## Task 2: Move POS transport to existing domain owners

**Files:**

- Create `src/pos/stores/orderSession/orderSessionApi.js`
- Modify `src/pos/stores/orderSessionStore.js`
- Modify `src/pos/useProducts.js`
- Modify `src/pos/categoryPriceSync.js`
- Modify `src/pos/useAuth.js`
- Modify `src/components/PosTerminal.vue`
- Modify focused tests

### Step 1: Create one private order-session API module

Move the 23 request/JSON operations currently embedded in `orderSessionStore.js` into named functions in one file. Group them by comments, not subfiles:

- order/session: saved order, order types, customer lookup, held orders;
- table/session: drafts, table order load/save/print, workspace, relationships;
- split checks: list/create/cancel;
- financial actions: service-charge snapshots, subscription redemption, open-table void, checkout, drawer pop.

Each exported function should represent a domain request, not a generic HTTP verb. Preserve whether each caller needs:

- response status or `ok`;
- parsed data only;
- tolerant JSON parsing;
- fire-and-forget behavior;
- request cancellation/sequence handling in the caller.

Use the existing `src/shared/http.js` only where its current `fetchJson()` contract is sufficient. Do not silently turn all non-2xx responses into thrown exceptions because current callers inspect response bodies and status differently.

### Step 2: Keep state transitions in the store

Replace direct transport mechanics in `orderSessionStore.js` with named API calls. Keep in the store:

- request sequence and stale-owner guards;
- reactive mutations;
- UI errors/toasts;
- recovery of unsaved changes;
- checkout idempotency ownership;
- table-session invalidation;
- cross-workflow transitions.

The API file must not import Pinia stores, Vue components, router, or UI stores.

### Step 3: Rehome the three terminal requests

- Move product availability mutation into `useProducts()` as a named action.
- Move register category-price resolution into `categoryPriceSync.js` or a named `useProducts()` action, whichever keeps catalog ownership in one place without duplicating `syncCategoryPrices()`.
- Move active-shift lookup into `useAuth()` as a named action.
- Make `PosTerminal.vue` invoke these existing owners and contain zero direct `fetch()` calls.

Do not move the surrounding UI confirmation/toast into transport unless it is already product-owner behavior. The owner should return data/errors; the component decides presentation.

### Step 4: Test response-contract parity

Update/add unit tests for:

- success and error JSON parsing;
- open-table void conflict response preservation;
- checkout response status and idempotency behavior;
- table save/split error payloads;
- product availability success/error;
- shift lookup success/no-shift/network failure.

Then run:

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/unit/useCart.logic.test.js
npx vitest run src/components/__tests__/categoryPricePosWiring.spec.js src/utils/useAuthHydration.spec.js src/components/__tests__/posTerminalOwnership.spec.js
npx vitest run src/shared/__tests__/http.spec.js backend/tests/unit/frontendRuntimePaths.test.js
```

### Step 5: Negative checks and commit

```powershell
rg -n "fetch\(" src/pos/stores/orderSessionStore.js src/components/PosTerminal.vue
rg -n "useOrderSessionStore|useOrderUiStore|vue-router|/components/" src/pos/stores/orderSession/orderSessionApi.js
```

Expected: no matches in either command.

```powershell
git add src/pos/stores/orderSession/orderSessionApi.js src/pos/stores/orderSessionStore.js src/pos/useProducts.js src/pos/categoryPriceSync.js src/pos/useAuth.js src/components/PosTerminal.vue backend/tests/unit/orderSessionStore.test.js backend/tests/unit/frontendRuntimePaths.test.js src/components/__tests__/categoryPricePosWiring.spec.js src/components/__tests__/posTerminalOwnership.spec.js src/utils/useAuthHydration.spec.js
git commit -m "refactor: move POS requests to feature owners"
```

Stage only files actually changed.

## Task 3: Extract the catalog workspace as one component

**Files:**

- Create `src/components/pos/PosCatalogWorkspace.vue`
- Modify `src/components/PosTerminal.vue`
- Modify `src/components/__tests__/posTerminalOwnership.spec.js`

**Step 1: Move a complete visual seam**

Move the catalog navigation, category rail, loading/error/empty states, product grid, and product-card markup together. Move its owned logic:

- active category presentation;
- notes-category behavior;
- product sellability and bundle availability;
- card color/contrast presentation;
- product click/context-menu/long-press behavior;
- product-availability UI flow;
- catalog pagination.

The component should call `useProducts()`, `useCart()`, and `usePermissions()` directly. Those calls return the existing singleton/shared sources; do not mirror them into new local refs.

Shell inputs/events should be limited to facts genuinely owned by the shell, such as whether the terminal is in a table session or a shell navigation action. Prefer direct router/facade access over forwarding a large method list.

**Step 2: Preserve DOM and scoped styles**

Move the catalog-specific scoped styles with the catalog markup, including sold-out styling and category rail behavior. Keep IDs/data attributes used by scrolling, tests, barcode focus, or CSS. Do not redesign classes or responsive breakpoints in this refactor.

**Step 3: Preserve lifecycle ownership**

Long-press timers/listeners created by the catalog component must be cleaned up by that component. Global socket and page activation logic remain in `PosTerminal.vue` unless the catalog component can subscribe/unsubscribe without duplicating terminal lifecycle ownership.

**Step 4: Verify**

```powershell
npx vitest run src/components/__tests__/posTerminalOwnership.spec.js backend/tests/unit/orderSessionBoundaries.test.js
npm run build
npx playwright test tests/e2e/specs/cashier.checkout.spec.js --project=cashier-tests
```

Manually inspect desktop and a narrow viewport for unchanged category navigation, scrolling, sold-out cards, long press, notes products, add-to-cart, and mobile cart opening.

**Step 5: Commit**

```powershell
git add src/components/pos/PosCatalogWorkspace.vue src/components/PosTerminal.vue src/components/__tests__/posTerminalOwnership.spec.js
git commit -m "refactor: extract POS catalog workspace"
```

## Task 4: Extract the cart workspace as one component

**Files:**

- Create `src/components/pos/PosCartWorkspace.vue`
- Modify `src/components/PosTerminal.vue`
- Modify focused component tests

**Step 1: Move the complete cart workspace**

Move together:

- cart sidebar/header and split action;
- QR draft notification located within the cart workspace;
- line list, bundle-child presentation, selection, and saved-line cues;
- note/course/remove actions;
- numpad and modes;
- subtotal/discount/tax/total rows;
- update/hold/pay/clear actions owned by this workspace.

Move cart-row presentation and bundle-child note/removal interaction with the markup. Call `useCart()` and `useTables()` directly. Do not pass all 157 facade entries through `PosTerminal.vue`.

Keep shell-owned modals and global navigation in `PosTerminal.vue`. Use a small explicit event for a shell modal only when direct store ownership does not exist.

**Step 2: Preserve responsive behavior and styles**

Keep the existing mobile drawer/open state, width rules, touch targets, scroll regions, RTL behavior, and totals/action layout. Move only cart-specific scoped styles.

**Step 3: Verify**

Run the focused store/component tests, build, and cashier checkout smoke from Task 3. Add a narrow viewport pass that covers opening the cart, selecting a line, using numpad controls, and returning to catalog without layout overflow.

**Step 4: Commit**

```powershell
git add src/components/pos/PosCartWorkspace.vue src/components/PosTerminal.vue src/components/__tests__/posTerminalOwnership.spec.js
git commit -m "refactor: extract POS cart workspace"
```

## Task 5: Gate and, only if deep, extract the private table workflow

**Files:**

- Analyze `src/pos/stores/orderSessionStore.js`
- Conditionally create `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify `src/pos/stores/orderSessionStore.js`
- Modify `backend/tests/unit/orderSessionBoundaries.test.js`
- Modify `backend/tests/unit/orderSessionStore.test.js`

### Step 1: Produce the dependency matrix before code

Map the table-owned region covering:

- active table/session/draft state;
- workspace loading and activation;
- table order load/save/print/hold;
- split state/actions;
- transfer/join/disjoin;
- saved-item void and recovery;
- table close/invalidation.

Classify every dependency as:

- state owned by the table workflow;
- order/cart fact it reads;
- order/cart command it invokes;
- UI state/command;
- external feature owner (`auth`, `products`, `terminal`, permissions, router);
- API function.

### Step 2: Apply the depth gate

Proceed only if the module can:

- own its table refs itself and return those same refs to the root Pinia store;
- accept no more than 12 named inbound capabilities;
- avoid importing `useOrderSessionStore`, `useCart`, `useTables`, Vue components, or router;
- avoid a generic context/deps bag;
- preserve one-way dependency direction;
- relocate at least 500 cohesive lines;
- leave checkout/cross-domain coordination in the root store when it truly spans both owners.

If any condition fails, record the failed matrix in the evidence document, make no production extraction, and stop this task. A rejected shallow module is a successful design review.

### Step 3: Extract state and actions without duplication

If the gate passes, create one factory such as:

```js
export function createTableOrderWorkflow({
  api,
  readOrderDraft,
  replaceOrderDraft,
  clearOrderDraft,
  preserveDraftChanges,
  restoreDraftChanges,
  ui,
  getActor,
  getCatalog,
  can,
  navigate
}) { /* owns and returns table refs/actions */ }
```

The exact names must come from the dependency matrix; do not copy this example blindly. If the real interface becomes broad, abort.

Instantiate it once inside `useOrderSessionStore()`, and spread/return the same public table refs/actions currently exposed. Do not create a second Pinia store. Do not temporarily mirror refs between old and new implementations.

### Step 4: Preserve the facade contract exactly

`Object.keys(useCart()).sort()` and `Object.keys(useTables()).sort()` must remain unchanged. Components remain unable to import the private workflow. Add a source-boundary assertion that the root store no longer contains the relocated table API calls and that the workflow contains no facade/store/component imports.

### Step 5: Verify in increasing scope

```powershell
npx vitest run backend/tests/unit/tableSession.logic.test.js backend/tests/unit/tableSessionBoundary.test.js
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/useCart.logic.test.js
npx vitest run backend/tests/integration/refunds.test.js backend/tests/integration/tableOrderPostCommit.test.js
npx vitest run backend/tests/integration/tables.test.js
npm run build
npx playwright test tests/e2e/specs/waiter.tables.spec.js --project=waiter-tests
npx playwright test tests/e2e/specs/cashier.checkout.spec.js --project=cashier-tests
```

Run each expensive suite once after its relevant implementation is stable; do not repeat the full suite after a no-change merge.

### Step 6: Commit only a successful deep extraction

```powershell
git add src/pos/stores/orderSession/tableOrderWorkflow.js src/pos/stores/orderSessionStore.js backend/tests/unit/orderSessionBoundaries.test.js backend/tests/unit/orderSessionStore.test.js
git commit -m "refactor: isolate private table order workflow"
```

If the gate failed, do not create or commit a placeholder module.

## Task 6: Narrow only proven-unused facade entries

**Files:**

- Modify `src/pos/useCart.js` and/or `src/pos/useTables.js` only if the Task 1 manifest proves unused entries
- Modify `backend/tests/unit/orderSessionBoundaries.test.js`

**Step 1: Re-run the production consumer manifest**

Remove only entries with zero production consumers and no documented compatibility reason. Do not rename live keys in the same change.

**Step 2: Remove dead root-store returns when also internally unused**

Use `rg` to prove each candidate has no internal or test-supported role. A facade removal does not automatically justify deleting a store member used inside the aggregate.

**Step 3: Verify and commit**

Run boundary/store tests and build. Commit only if there are real deletions:

```powershell
git commit -m "refactor: narrow unused POS facade surface"
```

## Task 7: Final ownership and smoke audit

**Files:** No planned production edits.

**Step 1: Static audit**

Confirm:

- only facades directly consume `useOrderSessionStore()` in production;
- `PosTerminal.vue` has zero direct `fetch()`;
- `orderSessionStore.js` has zero direct `fetch()`;
- components do not import private leaf modules;
- no duplicate cart/table refs exist;
- no new file merely forwards a single function;
- no new dependency was added;
- unrelated 101 admin transport calls were not churned.

**Step 2: Behavioral smoke**

Exercise:

- register sale: search/category/product add, modifiers/notes/discount, cash/card/split checkout;
- mobile/narrow cart open/close and numpad;
- table open/load/save/print, partial item void, whole clear, split, transfer/join/disjoin;
- socket catalog availability and table updates;
- QR draft notification/import/dismiss;
- shift bootstrap and logout;
- expense/subscription modal entry points.

**Step 3: Final targeted verification**

Run the union of changed-area tests once, then `npm run build`. Run the full Vitest suite only if the extraction touched shared behavior beyond these named areas or targeted results reveal cross-domain uncertainty.

## Frontend acceptance gate

The frontend task is complete when:

- public caller behavior and facade semantics are unchanged or strictly narrowed by proven deletion;
- `PosTerminal.vue` is a shell over two complete workspace components and global orchestration;
- POS component/store transport is owned by feature/API modules rather than inline `fetch()`;
- the store is either reduced by one deep private table workflow or explicitly left intact because the dependency gate disproved the split;
- no duplicated state, circular public stores, prop forests, generic context bags, or file explosion were introduced;
- build and targeted desktop/mobile/table/checkout smoke tests pass.

## Recommended sequencing with the backend plan

1. Execute the backend open-table void ownership plan first and verify it.
2. Execute frontend Tasks 1–2 (contracts and transport).
3. Extract the catalog workspace, verify, then the cart workspace, verify.
4. Attempt the private table-workflow gate last, after the UI and transport noise is gone.
5. Narrow dead facade keys only after all moves settle.

This order keeps each commit reviewable and prevents simultaneous backend financial movement and frontend state movement.
