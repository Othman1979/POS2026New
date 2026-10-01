# Phase 5 Helper Ownership and Frontend Paths — Break-Review Prompt

You are the adversarial owner of Phase 5. Your job is to disprove that the backend helper extraction and frontend path migration are complete, behavior-preserving, and aligned with Phases 1-4. Use ponytail at full intensity: demand one real owner per behavior, delete pass-through layers, and reject speculative abstractions. Do not execute Phase 6.

## Required evidence order

Read these before judging the diff:

1. `CLAUDE.md`
2. `docs/superpowers/plans/2026-07-22-pos-architecture-refactor-roadmap.md`
3. Phase 1 architecture foundations and saved-line evidence
4. `docs/superpowers/plans/2026-07-22-table-order-save-transaction.md`
5. `docs/superpowers/plans/2026-07-22-checkout-transaction.md`
6. `docs/superpowers/plans/2026-07-23-pos-state-ownership.md`
7. `docs/superpowers/evidence/2026-07-23-pos-state-ownership-owner-audit.md`
8. `docs/superpowers/plans/2026-07-23-backend-helper-ownership.md`
9. `docs/superpowers/plans/2026-07-23-frontend-runtime-paths.md`
10. The complete phase-base diff and every directly importing caller/test.

Never accept a plan statement as proof. Use `rg`, `git diff`, file reads, focused tests, the production build, and the settlement benchmark.

## Scope firewall

- Phase 5A may change backend ownership/imports/tests only. It may not change frontend, schema, dependencies, endpoints, transactions, SQL semantics, or query counts.
- Phase 5B may change frontend paths/imports/config/tests only. It may not change backend, behavior, public facades, state ownership, templates, CSS, or dependencies.
- Phase 6 native HTTP/admin decomposition must not leak into either diff.

## Attack Phase 5A: backend helper ownership

### 1. Find every old edge

Search all route, module, service, test, auth, admin, and print import forms—not only `./helpers`. Reject if `backend/routes/pos/helpers.js` exists, if any service/module imports from a route, or if an adapter/barrel simply moved the same export bag elsewhere.

### 2. Apply the deletion test to each new module

For every new module, ask: if deleted, would its complexity duplicate across multiple callers? Reject one-function hypothetical seams unless the function has multiple independent callers (cash and print sanitization qualify). Reject generic repositories, controllers, dependency bags, or “utils” dumping grounds.

### 3. Prove Phase 1 saved-line identity survived

Trace saved table lines through `SavedOrderLines`, `saveTableOrder`, void/reduction detection, kitchen delta construction, split settlement, and checkout. Attack custom lines, repeated product/note rows, frozen `order_item_id`, modifiers, bundles, zero/removed quantities, and printed lines. No second line-key algorithm may silently diverge.

### 4. Prove Phase 2 transaction ownership survived

Confirm routes still delegate table save/mark-printed to their modules. Compare transaction start/commit/rollback, lock order, stock mutation order, audit calls, kitchen printing, table broadcasts, and query counts. Table realtime remains best-effort and emits the exact room/event/action/payload.

### 5. Prove Phase 3 checkout ownership survived

Confirm `executeCheckout` still owns locks, pricing, persistence, idempotent recovery, audit, and result construction. Race concurrent requests. Verify `activeCheckoutLocks` cannot leak between tests. Force both post-commit cache invalidators to throw and confirm the committed order still succeeds. The cache module must remain dynamically spyable.

### 6. Attack authorization and manager override

Test admin/programmer bypass, table-manager overridable-only grants, invalid PIN, lockout threshold/window, expired cleanup, rehash, success/failure/locked audit events, IP/user attempt isolation, and request-local mutation. Reject a service that receives Express `req`/`res` or grants non-overridable permissions.

### 7. Attack inventory, pricing, payments, and settings

Compare SQL text and parameters, row locks, bundle parent-only stock, NULL stock, insufficient stock, negative quantity, frozen prices, modifier surcharge/tax, tax registration fallback, service-charge snapshot settings, money tolerance, cash/card/split validation, and error messages. Run the 14/24/5 query-count benchmark.

### 8. Attack HTTP sanitization

Exercise production 500s and every database marker for POS and admin. Exact fallback strings must remain domain-specific. Confirm `code` and success payload merging are unchanged. Search for a second sanitizer implementation.

## Attack Phase 5B: frontend paths

### 1. Inventory all path forms

Search static imports, dynamic imports, side-effect imports, `vi.mock`, test imports, `readFileSync`, `existsSync`, comments used by source tests, config aliases, and tracked files. Reject any `assets/js` runtime/test reference or any duplicate old/new file.

### 2. Break alias resolution

Run Vite build and Vitest from the repository root. Inspect both configs: `@` must use `fileURLToPath(new URL('./src', import.meta.url))` and resolve identically. Reject cwd-dependent aliases, multiple aliases for the same root, or alias use in backend CommonJS runtime.

### 3. Break mock identity

For each moved dependency mocked with `vi.mock`, compare the production import specifier and mock specifier exactly. A passing test that mocks the old adapter while production imports the new file is false confidence. Delete all adapters before judging.

### 4. Prove Phase 4 state ownership survived

Compare `useCart()` and `useTables()` complete returned key sets and ref/function identity. Confirm only two Pinia stores exist. Components may import facades and public session storage, never `src/pos/stores/orderSession/*` leaves. Trace checkout, split, active-table normalization, table-session tokens, persistence, and checkout attempt cache through their new paths.

### 5. Attack all four Vite entries

Build index, admin, print receipt, and menu. Exercise shared i18n, auth interceptor side effects, favicon dynamic import, system settings, and receipt printing from every entry that consumes them. Reject a move that works only for the main POS entry.

### 6. Prove Git history and cleanup

Inspect `git diff --summary`, `git ls-files assets/js src/shared src/pos`, and status. Reject copied files, committed adapters, empty compatibility directories, stale path comments, or untracked generated output.

## Mandatory verification

Run focused tests after each reproduced defect. At the final owner gate run:

```powershell
npm run pretest:unit
npm run test:unit -- --silent
npm run build
node scripts/benchmark-table-settlement.js  # required only when Phase 5A changed SQL-owning modules
git diff --check
```

Also run zero-stale searches from both implementation plans. Error logs from negative-path tests are not failures; use the final exit status and test summary.

## Required review output

For every finding provide:

- severity (`P0`-`P3`);
- exact path and line;
- reproduction or static proof;
- violated Phase 1-5 invariant;
- smallest root-cause correction;
- focused regression that fails before the correction;
- whether it blocks the backend half, frontend half, or all of Phase 5.

End with:

- explicit Phase 1/2/3/4 alignment verdicts;
- backend and frontend stale-path manifests;
- duplicate-implementation/deletion pass;
- focused/full/build/benchmark evidence;
- `merge-ready` or `not merge-ready`.

Reject Phase 5 if any old helper/path survives, any adapter is committed, any rule has two owners, any mock misses production, any source-reading test points at stale text, any facade/state/HTTP/SQL/query contract drifts, or Phase 6 work leaks in.
