# Phase 5 Post-Luna Owner Review

**Branch:** `codex/phase-5-helper-paths`

**Phase base:** `a6828b07`

**Reviewed implementation HEAD:** `d6c8ef70`

## Hostile-owner prompt

Assume Phase 5 is wrong until the base-to-HEAD diff proves otherwise. For every extracted backend behavior, prove one owner, correct dependency direction, unchanged SQL, payload, transaction and cache-spy semantics, and no pass-through barrel. For every frontend move, prove Git identity, exact runtime/mock/source-reader resolution, identical aliases, facade identity, and no leaf bypass. A green test is evidence only when it actually scans or executes the intended path. Reproduce each defect first, fix the smallest root cause, and reject Phase 6 expansion.

## Reproduced findings and corrections

### P2 — frontend leaf boundary executed zero assertions

- Path: `backend/tests/unit/frontendRuntimePaths.test.js`
- Proof: `sourceConsumers()` returned only files containing `assets/js`; the final-state result was empty, so the component loop never read a component. Its regex also recognized only `src/pos/...`, not the actual `@/pos/...` form, and omitted TypeScript.
- Correction: scan all JS/MJS/TS/Vue component/admin files independently and reject alias, source-root, and relative leaf imports.
- Phase blocked before correction: Phase 5B.

### P2 — final runtime manifest was not frozen

- Path: `backend/tests/unit/frontendRuntimePaths.test.js`
- Proof: the test checked only the leaf directory and two facades, despite the plan requiring the exact 22-file final map.
- Correction: assert the complete 17 POS + 5 shared manifest and exactly one identical URL-based alias expression per config.
- Phase blocked before correction: Phase 5B.

### P2 — deleted backend owner remained in coverage configuration

- Path: `vitest.config.mjs`
- Proof: coverage still included `backend/routes/pos/helpers.js` after that file was deleted.
- RED: the new ownership assertion failed on the stale path.
- Correction: replace it with `jsonResponse.js`, `SavedOrderLines.js`, and `executeCheckout.js`; services remain covered by the existing service glob.
- Phase blocked before correction: Phase 5A.

### P2 — full-suite failure came from a clock-dependent fixture

- Path: `backend/tests/integration/subscriptionManagement.test.js`
- Reproduction: isolated run failed with expected collections `21.6`, received `0`.
- Root cause: the fixture inserted an order with the database current timestamp while requesting metrics only for `2026-07-22`; `subscriptionMetrics.js` correctly filters `COALESCE(invoice_issued_at, created_at)` to that window.
- Correction: insert the purchase with deterministic `created_at = '2026-07-22 12:00:00'`.
- Focused result: the six-test integration file passed; final full suite passed.
- Phase blocked before correction: all Phase 5, because its final gate required zero failures.

### P3 — phase-wide whitespace evidence was false

- Path: `backend/services/InventoryService.js`
- Proof: `git diff --check a6828b07..HEAD` reported trailing whitespace even though a clean post-commit `git diff --check` reported nothing.
- Correction: trim the copied SQL line endings and run the check from the phase base.

### P3 — private sanitizer detail was exported

- Path: `backend/http/jsonResponse.js`
- Proof: the plan specified one private database-message detector, but `isDatabaseMessage` was in `module.exports` with no caller.
- Correction: remove the unused export; the four public response functions remain unchanged.

## Structural proof

- `backend/routes/pos/helpers.js` is absent and no production importer remains.
- No backend service or module imports a route.
- Extracted behavior has one production owner; no replacement helper barrel or adapter exists.
- Git records all 22 browser runtime files as moves into `src/shared` and `src/pos`; `assets/js` is absent.
- Exactly two POS Pinia stores remain: `useOrderSessionStore` and `useOrderUiStore`.
- `useCart()` and `useTables()` facade key/ref/function contracts pass.
- No component/admin file imports a Phase 4 order-session leaf.
- Vite and Vitest use the same URL-derived `@ -> src` alias.
- No Phase 6 native HTTP/admin decomposition entered the diff.

## Verification

- Schema: zero drift.
- Corrected reproductions: 4 files / 23 tests passed.
- Backend owner/security gate: 11 files / 106 tests passed.
- Frontend path/facade gate: 24 files / 216 tests passed.
- Full suite: 178 files / 1,780 tests passed in 701.81 seconds.
- Production build: 274 modules; index, admin, print receipt, and menu entries built in 4.66 seconds.
- Settlement benchmark:
  - table save: 14 median / 14 max queries; 5.89 ms median.
  - checkout: 24 median / 24 max queries; 6.90 ms median.
  - mark printed: 5 median / 5 max queries; 3.68 ms median.
- `git diff --check a6828b07`: clean after correction.

## Alignment verdict

- Phase 1 saved-line identity: aligned.
- Phase 2 table transaction and realtime ownership: aligned.
- Phase 3 checkout transaction, lock, and post-commit cache ownership: aligned.
- Phase 4 frontend facade, store, persistence, split, checkout, and table-session ownership: aligned.
- Phase 5 backend helper ownership and frontend paths: merge-ready after the corrections above.
