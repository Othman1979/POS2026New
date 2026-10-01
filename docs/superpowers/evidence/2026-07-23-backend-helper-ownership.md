# Phase 5A backend helper ownership baseline

Recorded on 2026-07-23 before moving production code, from branch `codex/phase-5-helper-paths`.

## Baseline

- Baseline commit: `a6828b07 docs: add Luna Phase 5 execution prompt`
- `backend/routes/pos/helpers.js`: 857 lines
- Direct helper importer manifest: 22 files
- Known service-to-route reverse dependencies: `backend/services/printDispatch.js`, `backend/services/kitchenPrintRouting.js`
- Untracked user files were present before execution and remain untouched.

## Verification

- `npm run pretest:unit`: passed; schema drift check reported zero drift.
- Focused cohort:
  `backend/tests/unit/helpers.test.js`, `backend/tests/integration/permissions.test.js`,
  `backend/tests/integration/security.test.js`, `backend/tests/integration/checkout.test.js`,
  `backend/tests/integration/tables.test.js`, `backend/tests/integration/refunds.test.js`
- Focused result: 6 test files passed, 453 tests passed, Vitest exit code 0.
- Ownership characterization: `backend/tests/unit/posHelperOwnership.test.js` passed (2 tests).
- The cohort intentionally emits error-level logs for expected negative-path assertions (authorization failures, stale sessions, rollback simulations, and invalid payloads); these are not test failures.

## Settlement benchmark

```json
{
  "tableSave": { "medianMs": 7.64, "p95Ms": 71.48, "medianQueries": 14, "maxQueries": 14 },
  "checkout": { "medianMs": 8.76, "p95Ms": 14.74, "medianQueries": 24, "maxQueries": 24 },
  "markPrinted": { "medianMs": 4.14, "p95Ms": 4.62, "medianQueries": 5, "maxQueries": 5 }
}
```

These query ceilings are the Phase 2/3 regression guardrails and must remain unchanged through Phase 5.

## Task 2 checkpoint

- Added `backend/services/printText.js`, `backend/services/CashValidation.js`, and `backend/services/ManagerOverrideService.js`.
- Added permission predicates, print access, and saved-unit void authorization to `backend/services/PermissionService.js`.
- Rewired print dispatch/kitchen routing, print/auth/admin-shift/POS routes, checkout, table join/disjoin, and tests to their owners.
- Removed the duplicate manager-override state machine, cash validator, print sanitizer, and print access implementation from `backend/routes/pos/helpers.js`.
- Ownership characterization now reports 15 remaining helper importers; service-to-route reverse dependencies are zero.
- Post-cleanup focused unit cohort: 5 files passed, 80 tests passed.
- Authorization/security/print/auth regression command completed after cleanup with no emitted test failure; expected negative-path logs remained non-fatal.

## Task 3 checkpoint

- Added `InventoryService`, `OrderPricing`, and `CheckoutValidation`; extended `SavedOrderLines` with canonical saved-line void/new-item diffs.
- Rewired checkout, table-save, orders, subscriptions, refunds, admin product/subscription, tax-source tests, and unit tests to the new owners.
- Added the single-table realtime owner needed by `OrderPricing` healing; it has no route-helper dependency.
- Schema drift check: passed with zero drift.
- Task 3 focused unit cohort: 4 files passed, 92 tests passed.
- Settlement benchmark after rewiring: table save 14/14 queries, checkout 24/24, mark printed 5/5; all Phase 2/3 ceilings preserved.
- Ownership characterization now reports 12 remaining helper importers; service-to-route reverse dependencies remain zero.

## Task 4 checkpoint

- Commit: `5ad19cb2 refactor: assign POS realtime and checkout state`.
- Moved single and batch table broadcasts to `backend/services/TableRealtime.js` without SQL or payload changes.
- Moved `activeCheckoutLocks` to `backend/modules/checkout/executeCheckout.js` and kept cache calls spyable through the cache module object.
- Added `backend/tests/unit/tableRealtime.test.js`; realtime/post-commit smoke cohort passed 2 files and 5 tests.
- Serialized cross-module gate passed 2 files and 266 tests for checkout/tables, plus 3 files and 110 tests for refunds/permissions/security.
- Ownership manifest reduced to 10 before final helper deletion; service-to-route reverse dependencies remained zero.

## Task 5 checkpoint

- Added `backend/http/jsonResponse.js` as the single POS/admin JSON response sanitizer and `backend/tests/unit/jsonResponse.test.js`.
- Admin helpers now re-export the shared admin response pair; POS routes/modules import infrastructure and response owners directly.
- Localized `isRegisterHold` in `backend/routes/pos/orders.js`, removed its barrel test dependency, and deleted `backend/routes/pos/helpers.js` (857 baseline lines; 478 tracked lines on the final pre-delete branch).
- Final ownership test passed with the helper absent and zero importers; the focused sanitizer/helper cohort passed 3 files and 75 tests.
- Routing/auth cohort passed 5 files and 90 tests; serialized checkout/tables/refunds regression cohort passed 3 files and 323 tests.
- `npm run pretest:unit`: passed with zero schema drift.
- Final settlement benchmark:

```json
{
  "tableSave": { "medianMs": 8.5, "p95Ms": 18.15, "medianQueries": 14, "maxQueries": 14 },
  "checkout": { "medianMs": 7.1, "p95Ms": 14.23, "medianQueries": 24, "maxQueries": 24 },
  "markPrinted": { "medianMs": 3.09, "p95Ms": 4.01, "medianQueries": 5, "maxQueries": 5 }
}
```

- `git diff --check`: passed; only normal Git LF/CRLF warnings were emitted.
