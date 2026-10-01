# Frontend HTTP Consistency Evidence

**Date:** 2026-07-24
**Branch baseline:** `master` at `14f5081a`
**Scope:** Runtime browser code under `src/**`; tests are counted separately and backend transport is excluded.

## Decision

Standardize repeated `fetch()` followed immediately by JSON parsing through the existing native HTTP seam. Keep native `fetch()` where the caller intentionally does not parse JSON, parses conditionally, consumes text/XML or another response type, or already owns a specialized request boundary.

This is a transport-consistency change. It does not split Vue pages, move state, add feature API files, alter endpoints, introduce a dependency, or impose a new HTTP error policy.

## Baseline inventory

- 137 direct runtime `fetch()` call sites existed across 136 source lines after excluding tests and specs, including the implementation call inside `src/shared/http.js`.
- 12 Inventory calls already use `fetchJson()` through `src/shared/http.js` (10 in `Inventory.vue`, 2 in `useInventoryActivity.js`).
- 116 runtime calls use the immediate form `const response = await fetch(...); const data = await response.json();`.
- Of those 116 calls, 100 never use the `Response` after parsing; 16 use both parsed data and response metadata such as `ok`.
- Two more data-only calls use `.then(response => response.json())`.

## Existing helper contract

`fetchJson(resource, options)` currently:

1. passes `resource` and `options` directly to the current global `fetch`;
2. returns `response.json()`;
3. does not inspect or throw for `response.ok`;
4. propagates fetch and JSON parsing failures unchanged.

Existing tests already pin option forwarding and rejection propagation. The migration must preserve that contract.

## Required companion contract

The 16 response-aware immediate pairs justify one companion primitive:

```js
export async function fetchJsonResponse(resource, options) {
    const response = await fetch(resource, options);
    const data = await response.json();
    return { response, data };
}
```

`fetchJson()` should delegate to this function and return only `data`. Neither function checks status, wraps errors, adds headers, retries, times out, authenticates, caches, or logs.

## Candidate ownership

The immediate JSON pairs are spread across existing feature owners and pages. Migration changes their request primitive in place; it does not relocate their workflows.

- Shared/POS: router authentication revalidation, business-date configuration, terminal settings/printers/barcodes/printing, authentication and shift workflows, product mutations, menu loading, order notes, table split printing, login, subscription and expense modals.
- Admin composables/components: session, reports, alerts, printing, product/category editors, import, subscription editors, dashboard JoFotara status.
- Admin pages: Customers, JoFotara Operations, Orders, refund reports, Settings, Shifts, Subscriptions, table-map editing, Users, waiter reports, and expense reports.

## Native-fetch exclusions

Native `fetch()` remains correct for these categories:

- `src/shared/http.js`: the primitive implementation itself.
- `src/pos/stores/orderSession/orderSessionApi.js`: private order-session owner, including tolerant JSON parsing and best-effort snapshot abandonment.
- `src/pos/useProducts.js`: catalog loading checks `response.ok` before attempting JSON parsing, preserving non-JSON HTTP failure behavior.
- `src/shared/faviconInjector.js`: intentionally returns on a failed status before parsing.
- `src/admin/pages/Orders.vue`: JoFotara XML is consumed with `response.text()`.
- logout, idle-session ping, and best-effort cleanup calls that intentionally ignore the response body.

These exclusions are semantic, not temporary debt. A raw-call count of zero is not an acceptance criterion.

## Baseline verification

The full baseline ran 189 test files and 1,897 tests:

- 1,893 tests passed.
- Four pre-existing static source-contract assertions failed because they still inspect code that moved into `PosCartWorkspace.vue`, `PosCatalogWorkspace.vue`, and `tableOrderWorkflow.js` in the previous merged refactor.
- The HTTP migration must introduce no additional failures. Those unrelated static tests are outside this scope.

## Final inventory

- 125 of the 137 direct runtime calls were migrated in place.
- 103 data-only request sites now use `fetchJson()`.
- 22 response-aware request sites now use `fetchJsonResponse()`.
- 12 direct runtime `fetch()` calls remain, all in the semantic exclusions documented above: the shared primitive, the private order-session API owner, pre-parse status checks, XML/content-type handling, and intentionally ignored logout/idle responses.
- An AST comparison covered all 148 logical runtime request sites on `master` and this branch, including the 12 pre-existing Inventory helper calls. It found zero URL or request-options expression differences.
- No production file was added. No Vue page or component was split. Package manifests and backend production code are unchanged.
- Excluding documentation and the already committed helper contract, the call-site migration removes 87 net lines across 46 files (180 insertions, 267 deletions).

## Final verification

- HTTP helper contract: 4 tests passed.
- Focused frontend and request-boundary suite: 50 files and 346 tests passed.
- Full unit suite: 189 files; 1,894 tests passed and the same four baseline static-contract tests failed. The additional passing test is the new helper contract test; no new failure appeared.
- Production build: passed with 285 modules transformed.
- Manual review confirmed all 12 remaining direct calls are intentional and all migrated sites retain their original endpoint and request options.
- Ponytail review found the single seven-line companion helper justified by 22 callers and found no additional abstraction worth adding.

## Acceptance invariants

1. Request URLs, methods, headers, bodies, cache modes, signals, and sequencing remain byte-for-byte equivalent at call sites.
2. JSON parsing remains at the same point relative to response-status checks.
3. Existing success/error messages and catch behavior remain unchanged.
4. `fetchJson()` does not gain automatic status handling.
5. Native-fetch exclusions remain native.
6. No Vue page or component is split.
7. No production file is created except changes to the existing shared HTTP module.
8. Package manifests and backend production files remain untouched; test-only source-contract expectations may change when they intentionally pin the request primitive.
