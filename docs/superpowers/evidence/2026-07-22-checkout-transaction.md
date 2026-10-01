# Checkout transaction pre-change baseline

- Timestamp: 2026-07-22T22:23:22.6984126+03:00
- Commit: `b8bb80a5ad05003d750a961f9efb6de6c7356a05`
- Command: `node scripts/benchmark-table-settlement.js`

```json
{
  "tableSave": {
    "medianMs": 6.16,
    "p95Ms": 15.41,
    "medianQueries": 14,
    "maxQueries": 14
  },
  "checkout": {
    "medianMs": 8.37,
    "p95Ms": 14.36,
    "medianQueries": 24,
    "maxQueries": 24
  },
  "markPrinted": {
    "medianMs": 3.75,
    "p95Ms": 4.2,
    "medianQueries": 5,
    "maxQueries": 5
  }
}
```

Checkout query hard gate: median and max queries must remain at or below 24.

## Checkout transaction Phase 3 final verification

- Timestamp: `2026-07-22T23:16:00.1156211+03:00`
- Branch: `codex/checkout-transaction`
- Final code commit under test: `1217f5e7cfeaac58186a87577ad00f7dfc2915c6 test: protect checkout post-commit success`
- Route cleanup: every retained import in `backend/routes/pos/checkout.js` has a live checkout or `log_drawer_pop` reference, so no import was removed. The drawer-pop handler remains content-identical to `b8bb80a5` after newline normalization.

### Ownership gate

Commands:

```powershell
rg -n "INSERT INTO orders|UPDATE orders|INSERT INTO order_items|DELETE FROM order_items|ensurePaidInvoiceNumber|deductStockForCart|createSubscriptionFromPaidOrder" backend/routes/pos/checkout.js backend/modules/checkout
npx vitest run backend/tests/unit/checkoutModuleWiring.test.js
git diff --check
```

Results:

- All transaction markers were found only in `backend/modules/checkout/executeCheckout.js`; none remained in the route.
- `checkoutModuleWiring.test.js`: 1 test file passed, 2 tests passed, 565 ms.
- `git diff --check`: exit code 0 with no output.

### Full phase gate

The worktree initially lacked the ignored `.env` and `.env.test` files. Two `npm run test:unit` invocations stopped in the pretest hook before schema comparison or Vitest started, first for `.env` and then for `.env.test`. After copying both ignored configuration files from the main workspace, the complete configured phase gate ran once:

```powershell
npm run test:unit
npm run build
node scripts/benchmark-table-settlement.js
```

Results:

- Schema: zero drift detected between `posapp` and `posapp_test`.
- Unit suite: 165 test files passed, 1,737 tests passed, 0 failed, 755.01 s.
- Production build: Vite 6.4.2 transformed 270 modules and completed successfully in 6.56 s.
- Benchmark checkout query counts: median 24, max 24, unchanged from baseline and within the hard gate.
- At the time of this gate, the next commit contained evidence only. A later trailing-whitespace cleanup changed production-file bytes without changing JavaScript or SQL behavior; that cleanup is documented below.

Benchmark result:

```json
{
  "tableSave": {
    "medianMs": 7.07,
    "p95Ms": 34.41,
    "medianQueries": 14,
    "maxQueries": 14
  },
  "checkout": {
    "medianMs": 9.47,
    "p95Ms": 14.65,
    "medianQueries": 24,
    "maxQueries": 24
  },
  "markPrinted": {
    "medianMs": 4.21,
    "p95Ms": 4.66,
    "medianQueries": 5,
    "maxQueries": 5
  }
}
```

Timing variance from the pre-change baseline (informational; no timing threshold is asserted):

- Table save: median +0.91 ms, p95 +19.00 ms.
- Checkout: median +1.10 ms, p95 +0.29 ms.
- Mark printed: median +0.46 ms, p95 +0.46 ms.

### Final branch review

The complete `b8bb80a5..1217f5e7` range was reviewed for SQL/lock ordering, HTTP error contracts, manager-PIN timing and audit propagation, duplicate recovery, rollback/release and active-lock cleanup, post-commit behavior, stale ownership, and prohibited scope changes. The 35 checkout SQL statements and all 39 connection operations remained in baseline order; duplicate response construction remained identical; both manager-PIN call sites and the discount-audit manager source were preserved; and drawer-pop remained unchanged. No production defect or prohibited change was found.

### Post-verification whitespace cleanup

The full schema/test/build/benchmark gate above tested production commit `1217f5e7cfeaac58186a87577ad00f7dfc2915c6`. A subsequent review found six trailing-whitespace occurrences carried into `backend/modules/checkout/executeCheckout.js` by the mechanical extraction. The follow-up removed only those trailing spaces, including spaces before newlines inside two SQL template lines; it changed no JavaScript tokens, SQL meaning, runtime behavior, or query count. Module syntax, checkout ownership wiring, and the full-range `git diff --check b8bb80a5..HEAD` check passed after the cleanup. No full suite rerun was needed for this whitespace-only change.

## Phase 3 final-review fixes

- Timestamp: `2026-07-22T23:57:27.9731891+03:00`
- Branch: `codex/checkout-transaction`
- Final code commit under test: `4b93fa5954c3f6acd5b00d8cce4403023043a5de fix: harden checkout transaction cleanup`

### TDD regressions

Rollback-failure RED:

```powershell
npx vitest run backend/tests/integration/checkout.test.js -t "rejects the original duplicate error and destroys the connection when rollback fails"
```

- Exit 1: 1 failed, 99 skipped.
- Expected the rejected-rollback connection to be destroyed and not released; the existing implementation instead reported `destroyed: false` and `released: true`.

Rollback-failure GREEN, using the same command:

- Exit 0: 1 passed, 99 skipped; 1.33 s total, 793 ms tests.
- The real pooled connection now attempts rollback, is destroyed when rollback rejects, is never released, skips duplicate-success recovery, and surfaces the original `ER_DUP_ENTRY` through the route's generic 500 contract.

Post-commit cache RED:

```powershell
npx vitest run backend/tests/integration/checkoutPostCommit.test.js -t "returns success and keeps the order when both cache invalidators fail after commit"
```

- Exit 1: 1 failed, 1 skipped.
- Expected HTTP 200 after the durable commit; the existing implementation returned HTTP 500 when a cache invalidator threw.

Post-commit cache GREEN, using the same command:

- Exit 0: 1 passed, 1 skipped; 1.31 s total, 812 ms tests.
- A real HTTP checkout now remains successful and its order remains durable when both invalidators throw; catalog then dashboard invalidation are each attempted and logged separately.

### Implementation and focused verification

- `executeCheckout` now destroys and nulls a connection whose rollback rejects, rethrows the original checkout error immediately, and therefore cannot run duplicate-success recovery or return that connection to the pool with uncertain transaction state.
- Catalog and dashboard cache invalidation now have independent post-commit guards. Either or both may fail without converting a committed order into an HTTP failure.
- Three unused checkout-helper imports were removed. The module retains the CommonJS helper export object so the regression can spy on the existing runtime seam without adding test-only production APIs.
- Active checkout lock cleanup remains in `finally` on preflight duplicate, normal success, successful-rollback error/recovery, and rejected-rollback paths.

Focused commands and results:

```powershell
npx vitest run backend/tests/integration/checkout.test.js -t "rejects the original duplicate error and destroys the connection when rollback fails|should rollback transaction and release connection back to pool on unexpected database query failures"
npx vitest run backend/tests/integration/checkoutPostCommit.test.js backend/tests/unit/checkoutModuleWiring.test.js backend/tests/unit/SavedOrderLines.test.js backend/tests/unit/savedOrderLinesWiring.test.js
npx vitest run backend/tests/integration/checkoutPostCommit.test.js backend/tests/unit/checkoutModuleWiring.test.js
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/checkoutPostCommit.test.js
```

- Rollback focused cohort: 2 passed, 98 skipped; 2.10 s.
- Checkout post-commit/module/saved-line cohort: 30 passed; 3.19 s.
- Final post-commit/module cohort after simplifying the CommonJS seam: 4 passed; 2.46 s.
- Complete affected integration cohort: 102 passed; 81.44 s.

### Fresh full gate

The ignored `.env` and `.env.test` files were present and verified as ignored without exposing or committing their contents. The following gate ran against exact code commit `4b93fa5954c3f6acd5b00d8cce4403023043a5de`:

```powershell
npm run test:unit
npm run build
node scripts/benchmark-table-settlement.js
```

Results:

- Schema comparison: zero drift detected.
- Unit suite: 165 test files passed, 1,739 tests passed, 0 failed; 664.50 s.
- Production build: Vite 6.4.2 transformed 270 modules and completed successfully in 5.67 s.
- Benchmark checkout query counts: median 24, max 24, unchanged from baseline and within the hard gate.

```json
{
  "tableSave": {
    "medianMs": 5.72,
    "p95Ms": 14.53,
    "medianQueries": 14,
    "maxQueries": 14
  },
  "checkout": {
    "medianMs": 7.1,
    "p95Ms": 12.17,
    "medianQueries": 24,
    "maxQueries": 24
  },
  "markPrinted": {
    "medianMs": 3.07,
    "p95Ms": 3.66,
    "medianQueries": 5,
    "maxQueries": 5
  }
}
```

### Final structural review

- Node syntax checks passed for the checkout module, route, and both modified integration tests.
- `git diff --check b8bb80a5..HEAD` passed.
- Transaction SQL, transaction lifecycle, duplicate recovery, and active checkout lock ownership remain only in `backend/modules/checkout/executeCheckout.js`; the checkout route contains no stale owner SQL.
- The module contains no Express `req` or `res` references.
- The removed helper names have no remaining references in the checkout module.
- Every early return and throw was reviewed for connection and active-lock cleanup. No unresolved correctness concern was found.
