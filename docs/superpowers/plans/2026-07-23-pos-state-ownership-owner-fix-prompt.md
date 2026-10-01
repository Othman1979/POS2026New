# Phase 4 POS State Ownership — Owner Fix Prompt

You own the correction pass on `codex/pos-state-ownership`. Fix only the
confirmed findings in
`docs/superpowers/evidence/2026-07-23-pos-state-ownership-owner-audit.md`.
Use ponytail at full intensity and strict RED → GREEN cycles. Do not begin
Phase 5.

## Non-negotiable scope

- Preserve every `useCart()` / `useTables()` key and ref/function semantic.
- Preserve Phase 1 `SavedOrderLines`, Phase 2 table transactions, Phase 3
  checkout transaction, all URLs, payload shapes, schema, middleware, and
  dependencies.
- Keep one persistent Pinia owner and one transient UI owner.
- Add no store, class, generic storage framework, callback bag, dependency, or
  runtime-root move.
- Components must not import `stores/orderSession/*` leaf modules.
- Never weaken an assertion to make a fix green.
- One finding per RED → GREEN cycle and one rollback-sized commit per logical
  owner when practical.

## Fix order

### 1. Checkout request ownership

Add a runtime regression proving a late Table A checkout cannot release Table
B's processing lock. Reuse the store's existing request-sequence pattern; the
latest checkout request alone may clear shared processing state. Preserve
Phase 3 idempotency and the frozen receipt behavior.

### 2. Table enter/switch ownership and normalization

Add a regression for same-table-ID split activation while a parent draft is in
flight. Make every stored split activation invalidate the prior session before
assignment. Route normal table load, empty table entry, and split restoration
through `normalizeActiveTable`; preserve parent/original-table overrides and
all display IDs.

### 3. Canonical browser-session persistence

Resolve the plan contradiction without changing Vue facade keys. Promote the
existing `posSessionStorage.js` compatibility module into the small public
browser-session adapter: it may re-export named semantic handoff/table
operations from the internal persistence owner. Rewire current component and
store callers to those named operations. Include `OrderNotes.vue` writers and
`PosTerminal.vue` readers/removers. Keep auth/logout/idle/admin imports stable.

Add a static ownership regression that rejects direct owned-key storage calls
outside `orderSessionPersistence.js`, `checkoutAttemptCache.js`, and the one
router guard if that guard cannot use the adapter without creating a cycle.
Prefer rewiring the router too when the dependency remains one-way.

### 4. Split merge identity

Add the failing bundle-composition regression. Extend the existing identity
only with fields whose loss changes fulfillment or money. Do not invent a
generic comparator or alter split arithmetic.

### 5. Storage failure policy

Choose best-effort POS operation: unavailable storage returns fallbacks and
does not crash checkout/register UI. Add throwing-storage tests, then guard
reads/writes/removes in the one persistence owner. Do not add retries or a
logging framework.

### 6. Records and dead code

Remove the stale placeholder comment. Mark Phase 4 tasks implemented while
leaving the final full-suite gate blocked until schema drift is resolved.
Record final commit, store line count, focused test counts, build output, and
the unresolved environment gate truthfully. Remove exports only if they remain
unused after persistence rewiring.

## Verification after the last production change

Run the new regressions and their owning cohorts, then:

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/unit/tableSession.logic.test.js backend/tests/unit/tableSessionBoundary.test.js backend/tests/unit/splitChecks.test.js backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/posSessionStorage.test.js backend/tests/unit/orderSessionBoundaries.test.js --silent
npx vitest run backend/tests/unit/SavedOrderLines.test.js backend/tests/unit/savedOrderLinesWiring.test.js backend/tests/unit/tableOrderModuleWiring.test.js backend/tests/unit/checkoutModuleWiring.test.js --silent
npm run build
git diff --check
```

Run `npm run test:unit` once only if the test database schema gate is healthy.
If schema drift blocks it, record the exact blocker and do not call the phase
fully verified. Review `master...HEAD` for backend/schema/package/path leakage
before handing off.
