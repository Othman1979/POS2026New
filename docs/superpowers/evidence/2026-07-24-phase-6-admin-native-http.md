# Phase 6 Admin Native HTTP — Verification Evidence

Branch: `codex/phase-6-admin-http`

## Scope verdict

- Added `src/shared/http.js` with one native `fetch` + JSON parsing responsibility.
- Migrated the 12 Inventory request sites without changing URLs, methods, headers, bodies, success branches, error branches, optimistic rollback, stale-response suppression, refresh behavior, or loading behavior.
- Extracted Stock Activity because it owns two feeds, two loading flags, two loaders, and audit presentation.
- Rejected product/category/template splitting because the live state is coupled and extraction would mostly add props/events.
- Deferred `tableRelationships.js` and `splitChecks.js` to Phase 7 because they are independent transaction-risk domains, not small frontend fixes.

## Hostile-review finding fixed

`backend/tests/unit/frontendRuntimePaths.test.js` recursively treated `src/shared/__tests__/http.spec.js` as a runtime module, exposing that the old exact 22-file manifest would reject every legitimate future shared module. The boundary now requires every migrated runtime file and `src/shared/http.js` without forbidding additional owned modules. Old-tree and old-path consumer assertions remain strict and recursive.

## Fresh verification

Focused command:

```powershell
npx vitest run src/shared/__tests__/http.spec.js src/admin/composables/__tests__/useInventoryActivity.spec.js src/admin/pages/__tests__/inventoryPriceLists.spec.js backend/tests/unit/frontendRuntimePaths.test.js
```

Result: 4 files passed, 16 tests passed, 0 failed.

Production build:

```powershell
npm run build
```

Result: Vite 6.4.2 built all four entry points, 276 modules transformed, exit code 0, 6.72 seconds.

Static gates:

- `git diff --check master...HEAD`: clean.
- `rg -n "\bfetch\s*\(" src/admin/pages/Inventory.vue`: zero matches.
- `fetchJson(` search: exactly 12 Inventory/activity call sites.
- Backend production diff: zero files; only the runtime-path boundary test changed under `backend/tests`.
- Auth ownership trace: `src/shared/authInterceptor.js` still exclusively wraps `window.fetch`, adds same-origin credentials, and redirects internal API 401 responses.

The full backend suite and settlement benchmark were not repeated: Phase 6 changes no backend production, schema, SQL, pricing, settlement, or POS transaction path. The focused tests plus the four-entry production build are the proportional gate for this frontend-only phase.
