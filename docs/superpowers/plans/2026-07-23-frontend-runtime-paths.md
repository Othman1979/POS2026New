# Frontend Runtime Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Use ponytail at full intensity. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all 22 bundled runtime JavaScript files from `assets/js` into explicit `src/shared` and `src/pos` owners, update every runtime/test/source-reading path, and delete `assets/js` without changing behavior or public facade contracts.

**Architecture:** Shared browser infrastructure lives in `src/shared`; the complete Phase 4 POS graph moves as one cohesive unit to `src/pos`, preserving its internal directory shape and Pinia ownership. `@` means the `src` root in both Vite and Vitest. Temporary old-path adapters may protect an in-progress caller batch but must be deleted before its task commit.

**Tech Stack:** Vue 3, Pinia, JavaScript ES modules, Vite 6, Vitest 4.

**Execution status:** Implemented on `codex/phase-5-helper-paths` and adversarially re-verified on 2026-07-23. Final evidence is in `docs/superpowers/evidence/2026-07-23-frontend-runtime-paths.md` and `docs/superpowers/evidence/2026-07-23-phase-5-post-luna-review.md`.

## Global constraints

- This is a path/import refactor only. Do not change behavior, export names, facade key sets, state ownership, storage keys, payloads, money logic, CSS, templates, dependencies, or backend code.
- Preserve `useOrderSessionStore` and `useOrderUiStore` as the only POS Pinia stores. Preserve `useCart()` and `useTables()` as public migration facades.
- Move files with `git mv`; do not copy/recreate them. A moved file's content may change only for import paths and stale path comments.
- Configure the same `@ -> <repo>/src` alias in `vite.config.mjs` and `vitest.config.mjs` in the first commit that imports `@/...`.
- Use `@/...` for imports crossing top-level `src` owners. Keep short relative imports inside one cohesive directory such as `src/pos/stores/orderSession`.
- Update runtime imports, dynamic imports, `vi.mock` IDs, test imports, and `readFileSync`/`existsSync` path assertions in the same task as each move.
- Temporary adapters are uncommitted scaffolding only. Delete each after `rg` reports zero old-path consumers; no adapter may survive a task commit.
- Do not move Vue components, `src/utils`, CSS, prototypes, admin pages, backend code, or introduce TypeScript.
- Do not run the full test suite after each mechanical cohort. Run focused tests and the production build per cohort; run the full suite once at the final gate.

## Final path map

### Shared cohort

| Old path | Final path |
| --- | --- |
| `assets/js/admin/i18n.js` | `src/shared/i18n.js` |
| `assets/js/authInterceptor.js` | `src/shared/authInterceptor.js` |
| `assets/js/faviconInjector.js` | `src/shared/faviconInjector.js` |
| `assets/js/composables/systemSettings.js` | `src/shared/systemSettings.js` |
| `assets/js/composables/receiptPrint.js` | `src/shared/receiptPrint.js` |

### POS cohort

Move every remaining file under `assets/js/composables` to the same relative path under `src/pos`:

```text
categoryPriceSync.js
posSessionStorage.js
useAuth.js
useCart.js
useIdleTracker.js
usePermissions.js
useProducts.js
useSocket.js
useTables.js
useTerminal.js
stores/checkoutAttemptCache.js
stores/orderSessionStore.js
stores/orderUiStore.js
stores/orderSession/checkoutFlow.js
stores/orderSession/orderSessionPersistence.js
stores/orderSession/splitChecks.js
stores/orderSession/tableSession.js
```

## Task 1: Freeze the path and public contracts

**Files:**
- Create: `backend/tests/unit/frontendRuntimePaths.test.js`
- Create: `docs/superpowers/evidence/2026-07-23-frontend-runtime-paths.md`
- Read: all 81 files returned by `rg -l "assets/js" src backend/tests -g "*.js" -g "*.vue"`

**Interfaces:**
- Consumes: the 22-file old runtime tree and Phase 4 facade/boundary tests.
- Produces: a complete old-path consumer manifest and final-state assertions.

- [ ] **Step 1: Record baseline evidence**

Record HEAD, the 22-file manifest, the 81 source/test consumers, `npm run build` modules/assets/timing, and the focused POS/shared unit counts.

- [ ] **Step 2: Add path-manifest and public-contract assertions**

Add active tests for the exact 22-file old tree, the recorded old-path consumer manifest, the Phase 4 leaf directory, component-to-leaf dependency rule, and unchanged `useCart()` / `useTables()` returned key sets. Tasks 2-3 update the path manifests to their new expected state; do not use skipped tests.

The final Task 3 state must assert:

- identical `@` aliases in both config files;
- no `assets/js` path in runtime code or tests;
- no `assets/js` directory;
- final Phase 4 leaf directory at `src/pos/stores/orderSession`;
- no component importing Phase 4 leaf modules directly;
- unchanged `useCart()` / `useTables()` returned key sets.

- [ ] **Step 3: Commit baseline**

```powershell
git add backend/tests/unit/frontendRuntimePaths.test.js docs/superpowers/evidence/2026-07-23-frontend-runtime-paths.md
git commit -m "test: freeze frontend runtime paths"
```

## Task 2: Add one alias and move the shared cohort

**Files:**
- Modify: `vite.config.mjs`
- Modify: `vitest.config.mjs`
- Move: the five shared-cohort files in the map above
- Modify: every runtime/test/static-reader caller of those five paths
- Modify: moved-file imports of `src/utils/receiptPresentation.js`

**Interfaces:**
- Produces: `@/shared/i18n.js`, `authInterceptor.js`, `faviconInjector.js`, `systemSettings.js`, and `receiptPrint.js` with unchanged exports/side effects.

- [ ] **Step 1: Add the alias in both configs**

Use Node URL resolution, not a cwd-dependent string:

```js
import { fileURLToPath, URL } from 'node:url'

resolve: {
  alias: {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  },
},
```

Keep all existing config fields unchanged. Add the block once in each config.

- [ ] **Step 2: Move the five files with `git mv`**

While editing callers, optional old-path adapters may re-export from `@/shared/...`; `authInterceptor.js` uses a side-effect import. Do not stage those adapters.

- [ ] **Step 3: Update every caller class**

Update static imports, dynamic `import()`, `vi.mock`, test imports, and source-reading localization tests. Use `@/shared/...` from any file outside `src/shared`; use `./...` within `src/shared`.

- [ ] **Step 4: Prove no shared old paths remain and delete adapters**

```powershell
rg -n "assets/js/admin/i18n|assets/js/authInterceptor|assets/js/faviconInjector|assets/js/composables/(systemSettings|receiptPrint)" src backend/tests assets/js
```

Expected: no caller output. Delete the five old adapters/directories before verification.

- [ ] **Step 5: Run focused checks and commit**

```powershell
npx vitest run backend/tests/unit/receiptPrint.test.js backend/tests/unit/serviceChargeDisplay.test.js src/admin src/components --silent
npm run build
git diff --check
git add vite.config.mjs vitest.config.mjs src/shared src backend/tests assets/js
git commit -m "refactor: move shared browser runtime into src"
```

## Task 3: Move the complete POS graph as one cohort

**Files:**
- Move: all 17 files listed in the POS map from `assets/js/composables` to `src/pos`
- Modify: all POS components, entry/router files, admin session caller, unit imports/mocks, and source-reading tests that reference them
- Delete: empty `assets/js` tree

**Interfaces:**
- Produces: unchanged `@/pos/useCart.js`, `@/pos/useTables.js`, `@/pos/posSessionStorage.js`, stores, and Phase 4 leaf modules.
- Preserves: every facade key/ref/function identity and the one-store ownership established in Phase 4.

- [ ] **Step 1: Move the entire graph with `git mv`**

Do not split the four `orderSession` leaves from `orderSessionStore.js`; Phase 4 designed them as one cohesive directory. Preserve relative imports within `src/pos` and replace crossings to utilities/shared code with `@/utils/...` and `@/shared/...`.

- [ ] **Step 2: Update all runtime callers**

Update `src/main.js`, `src/router.js`, `src/App.vue`, POS components/modals, Login, and `src/admin/composables/useAdminSession.js`. Components continue importing facades, never `src/pos/stores/orderSession/*` leaves.

- [ ] **Step 3: Update every test identity/path**

Update all imports and `vi.mock` IDs together so mocks still intercept the exact identifier used by production. Update these source-reading contracts explicitly:

- `backend/tests/unit/orderSessionBoundaries.test.js`
- `backend/tests/unit/tableFloorPlan.transfer.static.test.js`
- `src/components/__tests__/posSubscriptionWiring.spec.js`
- `src/components/__tests__/categoryPricePosWiring.spec.js`
- `src/utils/useAuthHydration.spec.js`

- [ ] **Step 4: Enable final-state assertions and remove adapters/tree**

```powershell
rg -n "assets/js" src backend/tests vite.config.mjs vitest.config.mjs
Test-Path assets/js
rg -n "from .*pos/stores/orderSession/" src/components src/admin
```

Expected: first and third commands have no output; `Test-Path` is `False`.

- [ ] **Step 5: Run the complete focused POS cohort and build**

```powershell
npx vitest run backend/tests/unit/orderSessionBoundaries.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderUiStore.test.js backend/tests/unit/tableSession.logic.test.js backend/tests/unit/tableSessionBoundary.test.js backend/tests/unit/splitChecks.test.js backend/tests/unit/checkoutFlow.test.js backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/posSessionStorage.test.js backend/tests/unit/checkoutAttemptCache.test.js backend/tests/unit/useCart.logic.test.js backend/tests/unit/useProducts.independence.test.js backend/tests/unit/useTerminal.test.js backend/tests/unit/categoryPriceSync.test.js backend/tests/unit/tableFloorPlan.transfer.static.test.js src/components src/utils/useAuthHydration.spec.js --silent
npm run build
git diff --check
```

- [ ] **Step 6: Commit**

```powershell
git add src/pos src backend/tests assets/js
git commit -m "refactor: move POS runtime into src"
```

## Task 4: Adversarial review and final Phase 5B gate

- [ ] **Step 1: Execute the Phase 5 break-review prompt**

Use `docs/superpowers/plans/2026-07-23-phase-5-break-review-prompt.md`. Fix only missed paths, mock-identity defects, duplicate files, contract drift, or build/runtime resolution failures.

- [ ] **Step 2: Inspect repository identity, not only import text**

```powershell
git status --short
git diff --summary <phase-base>..HEAD
git ls-files assets/js src/shared src/pos
rg -n "assets/js|\.\./\.\./\.\./assets" src backend/tests vite.config.mjs vitest.config.mjs
```

Expected: Git reports moves rather than duplicated old/new tracked files; only `src/shared` and `src/pos` runtime paths remain.

- [ ] **Step 3: Run the final gate once**

```powershell
npm run pretest:unit
npm run test:unit -- --silent
npm run build
git diff --check
```

Expected: zero schema drift, no test failures, successful four-entry Vite build, and no whitespace errors. Compare module count/asset sizes to Task 1; timing is evidence, not a threshold.

- [ ] **Step 4: Record completion**

Record exact commit, moved/deleted paths, test counts, build assets/timing, alias definitions, zero-old-path searches, and final facade contract result in the evidence file. Update only the frontend half of Phase 5 in the roadmap; do not start Phase 6.

## Rejection conditions

- Any tracked adapter or duplicate old/new runtime file remains.
- Vite and Vitest resolve `@` differently or depend on process cwd.
- A runtime import, dynamic import, `vi.mock`, direct test import, or source-reading path still names `assets/js`.
- A component bypasses `useCart`/`useTables` to import a Phase 4 leaf.
- A facade key, Pinia owner, storage key, checkout/split/table payload, money function, dependency, backend file, or Vue behavior changes.
- The move is implemented as delete/add when `git mv` could preserve history.
