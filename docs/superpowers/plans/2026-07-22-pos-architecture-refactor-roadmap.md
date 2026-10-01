# POS Architecture Refactor Roadmap

**Goal:** Raise project structure, backend architecture, frontend architecture, duplication control, and future editability toward 8/10 without changing POS behavior, public URLs, database schema, authentication style, or deployment requirements.

**Decision:** Refactor by business-rule ownership before physical relocation. Existing HTTP routes and frontend facades remain stable while implementation moves behind them. File moves happen only after a stable interface exists.

## Non-goals

- Do not change number-only employee login.
- Do not add or schedule backups.
- Do not convert the project to TypeScript.
- Do not add a controller/service/repository hierarchy.
- Do not add an HTTP client dependency.
- Do not rename public `/api/**`, `/pos`, `/tables`, or `/admin/**` paths.
- Do not change database tables as part of the structural refactor.
- Do not rewrite all imports in one commit.

## Evidence inventory

| Area | Evidence | Consequence |
|---|---|---|
| Checkout | `backend/routes/pos/checkout.js`, 1,634 lines | Extract a deep checkout transaction module behind the unchanged route. |
| Tables | `backend/routes/pos/tables.js`, 2,890 lines | Extract save first; relationship and split operations follow independently. |
| Shared route helpers | `backend/routes/pos/helpers.js`, 857 lines and a wide export interface | Move behavior to real owners after checkout/table extraction. |
| POS state | `assets/js/composables/stores/orderSessionStore.js`, 3,296 lines | Extract cohesive internal modules while retaining `useCart()` and `useTables()`. |
| Frontend roots | Runtime imports cross between `src` and `assets/js` | Make `src` the only runtime-code root through incremental re-export adapters. |
| Literal paths | 28 tests read source files through hard-coded paths | Update each path-reading test in the same commit as its move; prefer runtime behavior tests. |
| Network calls | Approximately 166 direct `fetch()` calls | Introduce one native JSON request module and migrate one feature at a time. |
| Prototypes | Approximately 4,700 lines under production `src/**/__prototypes__` | Move outside `src` or delete after confirming zero runtime imports. |

## Target ownership

```text
backend/
  routes/                       thin Express adapters
  modules/
    orders/SavedOrderLines.js   historical line identity and money context
    checkout/executeCheckout.js checkout transaction
    tables/saveTableOrder.js    table-order save transaction
    tables/tableRelationships.js transfer, join, disjoin
    tables/splitChecks.js       split creation and discard persistence
  services/                     retained until each existing module has a real owner
  config/
  middleware/
  migrations/
  tests/

src/
  shared/                       browser session, i18n, money, printing, native HTTP
  pos/
    order/                      cart/customer/discount/totals
    checkout/                   payment attempt and result processing
    tables/                     active table, persistence, split state
    ui/                         transient modal/input state
  admin/
  menu/
  print/

assets/
  css/
  fonts/
  icons/
  images/
```

## Dependency rules

1. Express route adapters may import module interfaces; modules must not import Express `req` or `res`.
2. Transaction modules may use `mysql2` directly. No repository interface exists until two real adapters exist.
3. A business rule has one canonical implementation. Compatibility files may only re-export it.
4. `src/shared` is for code imported by at least two application surfaces; it is not a new generic utilities folder.
5. POS state ownership is one-way: table order may call the Order interface; Checkout may read Order and table identity; Order must not import Table order.
6. External URLs, middleware order, response shapes, and database writes remain behaviorally identical throughout extraction.
7. File moves use `git mv`; path-only commits do not contain business-rule changes.
8. Every extraction uses a red-green test cycle and a rollback-sized commit.

## Execution plans

### Phase 1 — Foundations and saved-order lines

Detailed plan: `docs/superpowers/plans/2026-07-22-architecture-foundations.md`

Deliverables:

- Remove the artificial `useProducts → useCart` circular dependency.
- Introduce the Saved Order Lines module.
- Route checkout and table-save frozen-line rules through the same implementation.
- Preserve checkout/table endpoint behavior through existing integration tests.

### Phase 2 — Table-order save transaction

Detailed plan: `docs/superpowers/plans/2026-07-22-table-order-save-transaction.md`

Completed on `codex/table-order-save-transaction`: Phase 2 added the missing normal table-save benchmark, extracted the independent `mark_printed` transaction behind `backend/modules/tables/markTablePrinted.js`, and moved the normal save transaction behind `backend/modules/tables/saveTableOrder.js`. The post-review gate passed 163 test files / 1,734 tests, the production build, zero schema drift, and unchanged query counts (save 14, checkout 24, check-drop 5). Transfer, join, disjoin, table layout, GET, drafts, and splits remain in the route during this phase.

Acceptance conditions:

- Express handler contains action dispatch, HTTP parsing, and response translation only.
- `markTablePrinted({ user, input, io })` owns the check-drop transaction.
- `saveTableOrder({ user, input, io, auditManagerId, ipAddress, printKitchenOrder })` owns the complete normal save transaction and its post-commit effects.
- Existing `/api/pos/table_order` integration tests pass without URL changes.
- Normal table-save and check-drop query counts do not increase from the recorded Phase 2 baseline.
- No database repository or domain class is added.

### Phase 3 — Checkout transaction

Completed on `codex/checkout-transaction`: Phase 3 moved the checkout transaction behind `backend/modules/checkout/executeCheckout.js` while retaining rate-limit and authentication middleware order in `server.js` and `backend/routes/pos/checkout.js`. The final gate passed 165 test files / 1,739 tests, the production build, zero schema drift, and unchanged checkout query counts of 24 median / 24 max. Express `req`/`res` remain outside the module; Phase 4 and Phase 5 have not started.

Acceptance conditions:

- `executeCheckout({ user, input, io, ipAddress, authorizeManagerOverride })` owns locks, pricing, persistence, audit, receipt result construction, and idempotent recovery.
- Express response formatting remains outside the module.
- Checkout integration, concurrency, rollback, bundle, tax, subscription, and receipt tests remain green.

### Phase 4 — POS state ownership

Detailed plan: `docs/superpowers/plans/2026-07-23-pos-state-ownership.md`

Adversarial review prompt: `docs/superpowers/plans/2026-07-23-pos-state-ownership-break-review-prompt.md`

Completed on `codex/pos-state-ownership`: Phase 4 extracted split, checkout, persistence, and table-session seams while preserving `useCart()` and `useTables()` as migration interfaces. The owner correction pass fixed two stale-session races, canonicalized browser-session ownership and active-table normalization, preserved bundle composition in split identity, and made storage failures best-effort. The final gate passed 170 test files / 1,766 tests, the production build, and zero schema drift. Phase 5 has not started.

The completed extraction order was:

1. Split arithmetic and request payload construction.
2. Checkout attempt/payload/result processing.
3. Order-session storage and restoration.
4. The table-session token, normalization, persistence, and stale-response boundary.

The original broad “table workspace lifecycle” item was narrowed after tracing the implementation. Table HTTP/workspace actions remain in the single order-session orchestrator because moving them now would require a callback/port bag or create circular Order/Table/Checkout ownership. Do not create another Pinia store. Pure internal modules are preferred; the stateful table-session boundary may be a small plain object over the existing refs. Phase 5, not Phase 4, moves the resulting modules into the target `src/pos/**` paths.

### Phase 5 — Helper ownership and frontend paths

Backend plan: `docs/superpowers/plans/2026-07-23-backend-helper-ownership.md`

Frontend plan: `docs/superpowers/plans/2026-07-23-frontend-runtime-paths.md`

Adversarial review prompt: `docs/superpowers/plans/2026-07-23-phase-5-break-review-prompt.md`

Luna execution prompt: `docs/superpowers/plans/2026-07-23-phase-5-luna-execution-prompt.md`

Plan-review evidence: `docs/superpowers/evidence/2026-07-23-phase-5-plan-review.md`

Implementation completed on `codex/phase-5-helper-paths` from merged Phase 4, with backend and frontend evidence recorded in `docs/superpowers/evidence/2026-07-23-backend-helper-ownership.md`, `docs/superpowers/evidence/2026-07-23-frontend-runtime-paths.md`, and `docs/superpowers/evidence/2026-07-23-phase-5-post-luna-review.md`. The owner review fixed the nondeterministic subscription date fixture and the final gate passes 178 test files / 1,780 tests, the four-entry production build, zero schema drift, and the 14/24/5 settlement query ceilings:

- [x] Phase 5A: move behavior out of `backend/routes/pos/helpers.js` to the explicit owners in the backend plan and delete the helper.
- [x] Phase 5B: move all 22 bundled runtime files from `assets/js` into `src/shared` and `src/pos`, then delete `assets/js`.

Add a single `@` alias in Vite and Vitest only in the first commit that consumes it. Delete each adapter immediately after `rg` finds zero old-path callers.

### Phase 6 — Admin and native HTTP

Introduce `src/shared/http.js` using native `fetch`, starting with Inventory. Split large admin pages only by independent behavior and state ownership, not by line-count targets.

Implementation completed on `codex/phase-6-admin-http`. The phase added the behavior-preserving `fetchJson` seam, migrated all 12 Inventory JSON request sites, and extracted only the independently owned Stock Activity state/behavior into `useInventoryActivity`. The hostile review rejected mass fetch migration and product/category/template splitting. It also found and fixed the stale Phase 5 runtime-manifest test, which had counted a new `__tests__` file as production runtime code.

- [x] Phase 6A: add the native JSON fetch seam and migrate Inventory without changing request, response, auth, or error behavior.
- [x] Phase 6B: extract the Stock Activity controller; retain the coupled catalog/template behavior in Inventory.

Evidence: `docs/superpowers/evidence/2026-07-24-phase-6-admin-native-http.md`

### Phase 7 — Remaining table transaction owners

The roadmap target's `tableRelationships.js` and `splitChecks.js` are not Phase 6 cleanup. Live-code review found relationship transactions at `backend/routes/pos/tables.js:258-986` and split persistence at `backend/routes/pos/tables.js:1349-1949`, with locks, transactions, permissions, audits, money invariants, and post-commit broadcasts. They require separate backend review and rollback boundaries.

- [x] Phase 7A: extract transfer/swap/merge, join, and disjoin as one cohesive `tableRelationships.js` owner.
- [x] Phase 7B: extract destructive split persistence into `splitChecks.js`; keep split settlement in the existing checkout owner.

Plan: `docs/superpowers/plans/2026-07-24-phase-7-table-transaction-modules.md`

Evidence: `docs/superpowers/evidence/2026-07-24-phase-7-table-transactions.md`

## Verification gates

Every task:

```powershell
npx vitest run <targeted-test-files>
git diff --check
```

Every phase:

```powershell
npm run test:unit
npm run build
node scripts/benchmark-table-settlement.js
```

Before deleting any compatibility path:

```powershell
rg -n --fixed-strings '<old path or filename>' src assets backend tests
```

The only acceptable remaining match is the compatibility file itself. Delete it, rerun the search, then run the phase verification gate.

## Expected score movement

| Area | Current | Target |
|---|---:|---:|
| Project structure | 5 | 7.5–8 |
| Backend architecture | 6 | 8 |
| Frontend architecture | 5 | 7–7.5 |
| Duplication/modularity | 4.5 | 7.5–8 |
| Future editability | 5 | 8 |

The target deliberately stops at approximately 8/10. Chasing 9–10 would invite speculative interfaces, broad rewrites, and layers without real adapters.
