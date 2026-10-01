# Phase 6 — Admin Native HTTP and Inventory Ownership Plan

**Goal:** Add the roadmap's smallest useful native-fetch seam, migrate Inventory without behavior changes, and remove one genuine independent state owner from the 2,235-line page.

**Architecture:** `src/shared/http.js` owns only the repeated `fetch(resource, options) -> response.json()` transport step. The existing global auth interceptor remains the sole browser-session owner. `src/admin/composables/useInventoryActivity.js` owns the Stock Activity tab's two feeds, loading state, loaders, and audit presentation. Inventory retains catalog state, filtering, pagination, CRUD, export, lifecycle, template, and styles.

**Rejected scope:** no Axios/dependency, API client class, endpoint registry, repositories, global error policy, product/category composable split, template component split, backend route edit, or mass migration of the other 154 direct fetch calls.

## Task 1 — Establish the HTTP seam

**Files:** create `src/shared/http.js`; create `src/shared/__tests__/http.spec.js`.

1. Write tests proving `fetchJson(resource, options)` calls the current global `fetch` with the unchanged arguments and returns the parsed JSON result.
2. Prove fetch rejection and JSON parse rejection propagate unchanged; the helper must not invent error semantics.
3. Run `npx vitest run src/shared/__tests__/http.spec.js` and verify red before implementation.
4. Implement the minimum function: call `fetch`, then `response.json()`.
5. Run the focused test and commit only the helper and test.

Stop if the helper needs auth, base URLs, retries, response envelopes, headers, or dependency injection. Those are not Phase 6 requirements.

## Task 2 — Migrate Inventory transport without changing behavior

**Files:** modify `src/admin/pages/Inventory.vue`; modify `src/admin/pages/__tests__/inventoryPriceLists.spec.js` only to add boundary assertions.

1. Add a failing source-boundary assertion that Inventory imports `fetchJson` and contains no direct `fetch(`.
2. Replace each `fetch(...).then(r => r.json())` and each `await fetch(); await res.json()` with `fetchJson()` while preserving URLs, options, branches, error handling, refreshes, and concurrency guards.
3. Do not migrate `getSystemSettings`; it already has its own owner.
4. Run the Inventory source test and HTTP helper test.
5. Search `rg -n "\\bfetch\\(" src/admin/pages/Inventory.vue` and require zero matches.
6. Commit the vertical migration.

## Task 3 — Extract the independent Stock Activity owner

**Files:** create `src/admin/composables/useInventoryActivity.js`; create `src/admin/composables/__tests__/useInventoryActivity.spec.js`; modify `src/admin/pages/Inventory.vue`.

1. Write focused tests for both loaders' success and failure/finally behavior plus audit label/name/detail formatting.
2. Move exactly these members as one cohesive owner: `salesOutflowLogs`, `isOutflowLoading`, `manualAuditLogs`, `isManualAuditLoading`, `fetchSalesOutflowLogs`, `fetchManualAudit`, `auditLabel`, `auditName`, and `auditDetail`.
3. Keep active-tab orchestration in Inventory: entering `ledger` invokes both returned loaders.
4. Use `fetchJson`; do not add an injectable client, class, store, or endpoint constants.
5. Run controller, HTTP, and Inventory source tests. Search the page to prove those implementations exist only in the composable.
6. Commit the extraction.

## Task 4 — Hostile final review and proportional gate

1. Read the entire diff against `master` and execute the hostile prompt in `2026-07-24-phase-6-break-review-prompt.md`.
2. Run:

```powershell
npx vitest run src/shared/__tests__/http.spec.js src/admin/composables/__tests__/useInventoryActivity.spec.js src/admin/pages/__tests__/inventoryPriceLists.spec.js backend/tests/unit/frontendRuntimePaths.test.js
npm run build
git diff --check
rg -n "\bfetch\(" src/admin/pages/Inventory.vue
rg -n "useInventoryActivity|fetchJson" src/admin/pages/Inventory.vue src/admin/composables/useInventoryActivity.js src/shared/http.js
```

3. Update the architecture roadmap Phase 6 status and record exact results. Do not run the full suite unless a focused failure or shared-runtime change makes it necessary.

## Completion invariants

- Inventory behavior and endpoints are unchanged.
- Auth/session interception remains in `authInterceptor.js`.
- Inventory contains no direct fetch mechanics.
- Stock Activity has one implementation and one state owner.
- No backend, schema, dependency, POS workflow, or unrelated admin page changes.
- The phase adds exactly two production modules because exactly two ownership seams justify them.
