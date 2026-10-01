# Backend Helper Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Use ponytail at full intensity. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `backend/routes/pos/helpers.js` by moving each behavior to its existing domain owner or the smallest justified new module, without changing HTTP, SQL, permission, money, inventory, printing, or Phase 1-3 transaction behavior.

**Architecture:** Routes remain HTTP adapters; `SavedOrderLines`, `saveTableOrder`, `markTablePrinted`, and `executeCheckout` remain the Phase 1-3 transaction owners. Shared infrastructure is imported from its real module instead of being re-exported through a route helper. New modules are allowed only where two or more independent callers prove a real seam.

**Tech Stack:** Node.js CommonJS, Express 5, MySQL2/promise, Vitest 4.

**Execution status:** Implemented on `codex/phase-5-helper-paths` and adversarially re-verified on 2026-07-23. Final evidence is in `docs/superpowers/evidence/2026-07-23-backend-helper-ownership.md` and `docs/superpowers/evidence/2026-07-23-phase-5-post-luna-review.md`.

## Global constraints

- Preserve every public URL, status, response body, error sanitizer, SQL statement, transaction boundary, lock order, Socket.IO event/room/payload, permission result, and audit event.
- Keep `SavedOrderLines`, `saveTableOrder`, `markTablePrinted`, and `executeCheckout` as the established sources of truth. Do not move their orchestration back into routes.
- Do not add controllers, repositories, classes, dependency-injection containers, generic context objects, packages, schema changes, or frontend changes.
- Use direct imports for `pool`, `logger`, `crypto`, cache functions, settings, auth middleware, `PosCalculator`, and package version. A barrel that merely re-exports them is rejected.
- Keep `executeCheckout` post-commit cache invalidation dynamically spyable. Import the cache module object and call its properties; do not destructure those two functions.
- Preserve the manager override lockout window, attempt key, mutable per-request authorization result, PIN rehash, audit events, and the test reset seam.
- Preserve Phase 2/3 benchmark ceilings: table save 14 median/max queries, checkout 24 median/max, and mark printed 5 median/max.
- A compatibility adapter may exist only inside an uncommitted task while callers move. No committed code may import `backend/routes/pos/helpers.js` after its owning task.
- Run the smallest owning test after each move. Run the full suite and settlement benchmark once at the final phase gate.

## Corrected ownership map

| Current behavior | Final owner | Reason |
| --- | --- | --- |
| `sendError`, `sendSuccess` plus duplicated admin sanitizer | `backend/http/jsonResponse.js` | One sanitizer implementation with explicit POS/admin production fallback text. |
| Permission aliases, `isAdminUser`, `assertCanVoidSavedUnits`, print access | `backend/services/PermissionService.js` | Permission decisions stay with the canonical permission catalog and `userHas`. |
| PIN override attempts, lockout, rehash, audit | `backend/services/ManagerOverrideService.js` | Stateful authorization seam; route applies returned authorization to `req`. |
| `validateCashAmount` | `backend/services/CashValidation.js` | Shared by auth and admin shift routes; not a POS route concern. |
| `sanitizePrintString` | `backend/services/printText.js` | Shared by receipt and kitchen dispatch; removes the service-to-route dependency. |
| Table reads and socket emission | `backend/services/TableRealtime.js` | Shared by Phase 2/3 modules and refund routes. |
| `hasVoidsOrReductions`, `getNewItems` | `backend/modules/orders/SavedOrderLines.js` | Both compare submitted lines to persisted lines and must use Phase 1 identity rules. |
| Product loading and stock mutation | `backend/services/InventoryService.js` | Inventory lock/query/update behavior has several transaction callers. |
| DB price application, checkout settings, open-order recomputation/healing | `backend/services/OrderPricing.js` | One Order pricing seam over `PosCalculator` and `InventoryService`. |
| Money/payment request validation | `backend/services/CheckoutValidation.js` | Shared pure validation without route, DB, or Express dependencies. |
| `activeCheckoutLocks` | `backend/modules/checkout/executeCheckout.js` | The Phase 3 checkout transaction owns its in-process concurrency guard. |
| Pool/logger/cache/settings/auth/calculator/package/crypto exports | Original modules | Delete pass-through ownership; callers import directly. |
| `isRegisterHold` | module-local in `backend/routes/pos/orders.js` | Only one production caller module; a new one-function module would be shallow. |

## Task 1: Freeze behavior and the dependency direction

**Files:**
- Create: `backend/tests/unit/posHelperOwnership.test.js`
- Create: `docs/superpowers/evidence/2026-07-23-backend-helper-ownership.md`
- Read: every current importer returned by `rg -l "pos/helpers|require\\('./helpers'\\)" backend`

**Interfaces:**
- Consumes: the current 857-line helper and the 22 production/test importer files.
- Produces: an exact export/caller manifest and static dependency assertions used by all later tasks.

- [ ] **Step 1: Record the baseline**

Record `git rev-parse HEAD`, `(Get-Content backend/routes/pos/helpers.js).Count`, `npm run pretest:unit`, the focused helper/permission/security/checkout/table/refund tests, and `node scripts/benchmark-table-settlement.js` in the evidence file.

- [ ] **Step 2: Add ownership assertions**

Add a test that records the exact current helper importer manifest and the two known service-to-route violations (`printDispatch.js` and `kitchenPrintRouting.js`) as an explicit allowlist. Each later task shrinks that list; Task 5 changes the assertion to zero importers and an absent helper file. Do not use skipped tests or create a generic architecture framework.

- [ ] **Step 3: Commit the baseline**

```powershell
git add backend/tests/unit/posHelperOwnership.test.js docs/superpowers/evidence/2026-07-23-backend-helper-ownership.md
git commit -m "test: freeze POS helper ownership"
```

## Task 2: Remove reverse dependencies and centralize authorization primitives

**Files:**
- Create: `backend/services/printText.js`
- Create: `backend/services/CashValidation.js`
- Create: `backend/services/ManagerOverrideService.js`
- Create: `backend/tests/unit/printText.test.js`
- Create: `backend/tests/unit/cashValidation.test.js`
- Modify: `backend/services/PermissionService.js`
- Modify: `backend/services/printDispatch.js`
- Modify: `backend/services/kitchenPrintRouting.js`
- Modify: `backend/routes/print.js`
- Modify: `backend/routes/auth.js`
- Modify: `backend/routes/admin/shifts.js`
- Modify: `backend/routes/pos/checkout.js`
- Test: move the matching cases out of `backend/tests/unit/helpers.test.js` into the two new unit files and `backend/tests/unit/permissionService.unit.test.js`
- Test: `backend/tests/integration/permissions.test.js`
- Test: `backend/tests/integration/security.test.js`
- Test: `backend/tests/integration/print.authz.test.js`

**Interfaces:**
- `printText.js` produces `sanitizePrintString(value, maxLength = 200): string`.
- `CashValidation.js` produces `validateCashAmount(raw): { valid: true, value } | { valid: false, message }`.
- `PermissionService.js` additionally produces the existing permission predicate names, `assertCanVoidSavedUnits(user, options)`, and `userCanAccessOrderForPrint(user, order)`.
- `ManagerOverrideService.js` produces `authorizeManagerOverride({ user, managerPin, ipAddress, route }): Promise<{ managerId, role, permissions }>` and exports `overrideAttempts` only as the established test reset seam.

- [ ] **Step 1: Move pure print and cash functions with their existing tests**

Use the bodies byte-for-byte except for import paths. Rewire all consumers, then prove:

```powershell
npx vitest run backend/tests/unit/helpers.test.js backend/tests/unit/print.unit.test.js backend/tests/integration/print.authz.test.js --silent
rg -n "routes/pos/helpers" backend/services
```

Expected: tests pass; the search has no output.

- [ ] **Step 2: Move permission decisions into `PermissionService`**

Implement each existing predicate as `userHas(user, PERMISSIONS.<KEY>)`; use `isAdminRole` instead of retaining a second `isAdminUser` implementation. Preserve exact thrown messages/statuses from `assertCanVoidSavedUnits`.

- [ ] **Step 3: Extract manager override without passing Express objects**

The service must not accept or mutate `req`. The checkout route passes plain values, then sets `req.auditManagerId`, `req.user.role`, and `req.user.permissions` from the returned result. Keep the attempt key exactly `<ip>:override:<user id>` and keep all three audit event types.

- [ ] **Step 4: Run authorization regressions and commit**

```powershell
npx vitest run backend/tests/integration/permissions.test.js backend/tests/integration/security.test.js backend/tests/integration/checkout.test.js backend/tests/integration/print.authz.test.js backend/tests/unit/auth.unit.test.js --silent
git add -- backend/services/printText.js backend/services/CashValidation.js backend/services/ManagerOverrideService.js backend/services/PermissionService.js backend/services/printDispatch.js backend/services/kitchenPrintRouting.js backend/routes/print.js backend/routes/auth.js backend/routes/admin/shifts.js backend/routes/pos/checkout.js backend/tests/unit/printText.test.js backend/tests/unit/cashValidation.test.js backend/tests/unit/permissionService.unit.test.js backend/tests/unit/helpers.test.js backend/tests/integration/permissions.test.js backend/tests/integration/security.test.js backend/tests/integration/print.authz.test.js
git commit -m "refactor: assign POS authorization helpers"
```

## Task 3: Put saved-line, inventory, pricing, and payment rules behind their owners

**Files:**
- Create: `backend/services/InventoryService.js`
- Create: `backend/services/OrderPricing.js`
- Create: `backend/services/CheckoutValidation.js`
- Create: `backend/tests/unit/inventoryService.test.js`
- Create: `backend/tests/unit/checkoutValidation.test.js`
- Modify: `backend/modules/orders/SavedOrderLines.js`
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/modules/tables/saveTableOrder.js`
- Modify: POS order/subscription/table/refund routes and admin product/subscription routes that consume these functions
- Modify: `backend/tests/unit/SavedOrderLines.test.js`
- Split: the matching blocks from `backend/tests/unit/helpers.test.js` into `inventoryService.test.js`, `checkoutValidation.test.js`, and `SavedOrderLines.test.js`; delete each moved block in the same commit

**Interfaces:**
- `InventoryService`: `fetchCartProducts`, `deductStockForCart`, `restockOrderItems`, `restoreStockForCart` with unchanged parameters and SQL.
- `OrderPricing`: `applyDatabasePrices`, `loadCheckoutSettings`, `recomputeOrderTotals`, `healOpenOrdersForProduct` with unchanged parameters/returns.
- `CheckoutValidation`: `MONEY_TOLERANCE`, `hasDiscountsInPayload`, `assertNearMoney`, `normalizePaymentMethod`, `validatePayments`.
- `SavedOrderLines`: existing exports plus `hasVoidsOrReductions(newCart, existingItems)` and `getNewItems(newCart, existingItems)` using its canonical saved-line identity helpers.

- [ ] **Step 1: Write owner imports in the existing tests and verify RED**

Change only test imports first. Expected failure: the named owner module/export does not yet exist.

- [ ] **Step 2: Move inventory code mechanically**

Keep query text, lock option, aggregation, validation, and update parameter order unchanged. `OrderPricing` calls `InventoryService.fetchCartProducts`; it must not copy the product query.

- [ ] **Step 3: Move pricing and payment validation**

Do not change tolerances, rounding, modifier surcharge/tax, frozen-price rules, tax registration fallback, service-charge settings, or return shapes.

- [ ] **Step 4: Move line-diff functions to the Phase 1 owner**

Use existing `SavedOrderLines` key helpers where their semantics match. If a test proves kitchen delta and void detection intentionally differ, retain two named functions but share only the proven key normalization—not a speculative generic diff engine.

- [ ] **Step 5: Run transaction and source-of-truth cohorts**

```powershell
npx vitest run backend/tests/unit/helpers.test.js backend/tests/integration/checkout.test.js backend/tests/integration/checkoutPostCommit.test.js backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/subscriptionRedemptions.test.js backend/tests/integration/taxSourceOfTruth.test.js --silent
```

- [ ] **Step 6: Commit**

```powershell
git add -- backend/services/InventoryService.js backend/services/OrderPricing.js backend/services/CheckoutValidation.js backend/modules/orders/SavedOrderLines.js backend/modules/checkout/executeCheckout.js backend/modules/tables/saveTableOrder.js backend/routes/pos/orders.js backend/routes/pos/subscriptions.js backend/routes/pos/tables.js backend/routes/pos/refunds.js backend/routes/admin/products.js backend/routes/admin/subscriptions.js backend/tests/unit/inventoryService.test.js backend/tests/unit/checkoutValidation.test.js backend/tests/unit/SavedOrderLines.test.js backend/tests/unit/helpers.test.js backend/tests/integration/checkout.test.js backend/tests/integration/checkoutPostCommit.test.js backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/subscriptionRedemptions.test.js backend/tests/integration/taxSourceOfTruth.test.js
git commit -m "refactor: assign POS order and inventory helpers"
```

## Task 4: Move table realtime and checkout-owned mutable state

**Files:**
- Create: `backend/services/TableRealtime.js`
- Create: `backend/tests/unit/tableRealtime.test.js`
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/modules/tables/saveTableOrder.js`
- Modify: `backend/modules/tables/markTablePrinted.js`
- Modify: `backend/routes/pos/refunds.js`
- Modify: `backend/tests/integration/checkoutPostCommit.test.js`
- Modify: permission/security test reset imports

**Interfaces:**
- `TableRealtime.js` produces `broadcastTableUpdate(io, tableId)` and `broadcastTableUpdates(io, tableIds)` with identical best-effort logging and payloads.
- `executeCheckout.js` continues to produce `executeCheckout`; it may additionally export `activeCheckoutLocks` only for deterministic test cleanup.

- [ ] **Step 1: Characterize table payload and multi-ID deduplication**

Add focused assertions for the `staff` room, `table_update` event, `update_single_table` action, waiter join, QR count, and duplicate input IDs.

- [ ] **Step 2: Move the realtime functions without SQL edits**

Copy the two SELECT statements exactly. Do not combine them, add a repository, or change error propagation; this module is intentionally best-effort.

- [ ] **Step 3: Move the checkout lock and preserve cache spyability**

Import `backend/config/cache.js` as an object in `executeCheckout.js` and call `cache.invalidateCatalogCache()` / `cache.invalidateDashboardCache()`. Update `checkoutPostCommit.test.js` to spy on that object. Move `activeCheckoutLocks` to the checkout module and update only reset/inspection imports.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run backend/tests/integration/checkoutPostCommit.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js backend/tests/integration/permissions.test.js backend/tests/integration/security.test.js --silent
git add -- backend/services/TableRealtime.js backend/tests/unit/tableRealtime.test.js backend/modules/checkout/executeCheckout.js backend/modules/tables/saveTableOrder.js backend/modules/tables/markTablePrinted.js backend/routes/pos/refunds.js backend/tests/integration/checkoutPostCommit.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js backend/tests/integration/permissions.test.js backend/tests/integration/security.test.js
git commit -m "refactor: assign POS realtime and checkout state"
```

## Task 5: Centralize JSON responses, remove pass-through imports, and delete the helper

**Files:**
- Create: `backend/http/jsonResponse.js`
- Create: `backend/tests/unit/jsonResponse.test.js`
- Modify: `backend/routes/admin/helpers.js`
- Modify: every remaining POS-helper caller from the Task 1 manifest
- Delete: `backend/routes/pos/helpers.js`
- Modify/Delete: remaining blocks in `backend/tests/unit/helpers.test.js`
- Modify: `backend/tests/unit/posHelperOwnership.test.js`

**Interfaces:**
- `jsonResponse.js` produces `sendPosError`, `sendPosSuccess`, `sendAdminError`, `sendAdminSuccess`.
- Both error functions use one private database-message detector. POS keeps `Operation failed. Please try again.`; admin keeps `An internal server error occurred.`.
- `backend/routes/admin/helpers.js` may re-export the admin pair as `sendError`/`sendSuccess` to avoid unrelated admin caller churn.

- [ ] **Step 1: Add response sanitizer parity tests**

Cover production 500s, every existing database-message marker, code inclusion, success merging, and both exact fallback strings.

- [ ] **Step 2: Rewire direct infrastructure owners**

Replace helper imports of `pool`, `logger`, `crypto`, cache, settings, calculator functions, auth middleware, and `APP_VERSION` with direct imports. Compute `APP_VERSION` in `catalog.js` from `package.json`; do not create a version service.

- [ ] **Step 3: Localize `isRegisterHold` and delete the helper**

Keep `isRegisterHold` module-local in `orders.js`. Enable the final Task 1 ownership assertion, delete the helper and empty test file, and run:

```powershell
rg -n "routes/pos/helpers|require\('./helpers'\)" backend/modules backend/services backend/routes/pos backend/routes/auth.js backend/routes/print.js backend/routes/admin backend/tests
Test-Path backend/routes/pos/helpers.js
```

Expected: no forbidden imports; `False` for the file. The `./helpers` search must be scoped/interpreted so legitimate `backend/routes/admin/helpers.js` imports are not rejected.

- [ ] **Step 4: Run routing and sanitizer cohorts and commit**

```powershell
npx vitest run backend/tests/unit/posHelperOwnership.test.js backend/tests/integration/adminRouting.test.js backend/tests/integration/security.test.js backend/tests/integration/permissions.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js --silent
git add -- backend/http/jsonResponse.js backend/tests/unit/jsonResponse.test.js backend/routes/admin/helpers.js backend/routes/pos/catalog.js backend/routes/pos/checkout.js backend/routes/pos/orders.js backend/routes/pos/refunds.js backend/routes/pos/serviceCharges.js backend/routes/pos/subscriptions.js backend/routes/pos/tables.js backend/routes/pos/helpers.js backend/routes/auth.js backend/routes/print.js backend/routes/admin/products.js backend/routes/admin/shifts.js backend/routes/admin/subscriptions.js backend/modules/checkout/executeCheckout.js backend/modules/tables/saveTableOrder.js backend/modules/tables/markTablePrinted.js backend/services/PermissionService.js backend/services/ManagerOverrideService.js backend/services/CashValidation.js backend/services/printText.js backend/services/TableRealtime.js backend/services/InventoryService.js backend/services/OrderPricing.js backend/services/CheckoutValidation.js backend/tests/unit/posHelperOwnership.test.js backend/tests/unit/helpers.test.js backend/tests/integration/adminRouting.test.js backend/tests/integration/security.test.js backend/tests/integration/permissions.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js
git commit -m "refactor: remove POS route helper barrel"
```

## Task 6: Adversarial review and final Phase 5A gate

- [ ] **Step 1: Execute the Phase 5 break-review prompt**

Use `docs/superpowers/plans/2026-07-23-phase-5-break-review-prompt.md`. Fix only reproduced defects, duplicate ownership, missed importers, or Phase 1-4 contract drift.

- [ ] **Step 2: Run static ownership checks**

```powershell
rg -n "routes/pos/helpers" backend
rg -n "const (sendError|sendSuccess|sanitizePrintString|validateCashAmount|hasVoidsOrReductions|getNewItems|fetchCartProducts|applyDatabasePrices|recomputeOrderTotals)" backend
git diff --check
```

Expected: no old helper import; exactly one owner per named behavior; no whitespace errors.

- [ ] **Step 3: Run the final gate**

```powershell
npm run pretest:unit
npm run test:unit -- --silent
node scripts/benchmark-table-settlement.js
```

Expected: zero schema drift; no failed tests; query counts remain 14/24/5 median/max. No frontend build is required for this backend-only plan.

- [ ] **Step 4: Record completion**

Append the exact commit, test counts, benchmark JSON, final owner paths, deleted helper line count, and `git diff --check` result to the evidence file. Update only the backend half of Phase 5 in the roadmap; do not mark Phase 6 started.

## Rejection conditions

- Any route/helper barrel remains as a permanent compatibility layer.
- Any service/module imports from `backend/routes`.
- The manager override service accepts `req`/`res` or changes audit/lockout behavior.
- A pricing, saved-line identity, permission, response sanitizer, inventory query, table payload, or checkout cache implementation is duplicated.
- A Phase 1-3 transaction owner, endpoint, SQL/query count, schema, dependency, or frontend path changes.
