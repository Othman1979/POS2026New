# Frontend runtime audit — 2026-09-06

Implemented in the shared `codex/system-performance-audit` checkout. The scope was request cost, state ownership, runtime settings and recovery. No file-size refactor, new runtime dependency or pricing authority was introduced.

## Verified problems and changes

| Reachable problem | Change | Evidence |
| --- | --- | --- |
| `useProducts` did not set its loading flag for append/category reads when products were already present. Repeated Load More clicks sent the same offset repeatedly; an append could supersede the pending category read. | Keep the existing products visible while using the loading flag as the pagination lock. Retain the existing request/context sequence guard. | Three clicks: **3 append requests before, 1 after**. A new category cannot receive the prior page's appended products. |
| Order History quick-date selection fetched explicitly and through its date watcher. Older responses could overwrite newer rows, totals and loading state. | Suppress the redundant watcher fetch for quick selections; abort superseded reads and apply results only for the current request. Cancel hidden/unmounted page reads. | Quick date: **2 order reads before, 1 after**. Deferred responses completed in both orders without replacing the latest rows/statistics. |
| A pre-save settings read could repopulate the invalidated cache or return stale flags. Remote settings changes and reconnects did not invalidate the shared admin cache. | Track cache generations; stale readers join the current read. Invalidate before dispatching admin settings/reconnect notifications. Existing consumers reload language, navigation and relevant settings. | Concurrent consumers still share one read. Invalidated readers all receive the current snapshot, including when the older response finishes first. |
| Disabling tables/stock could hide controls while leaving their filters active. | Reset the selected table source to register/page 1. Clear obsolete stock filtering, leave replenishment, and replace the parallel products response made with the previous filter. | Two live admin tabs: low-stock count **1 → 135** after disabling stock; Orders returns to register sales after disabling tables. |
| Floor-plan activation/reconnect called a loader that reused the completed cache. A force request received during an existing read was dropped. | Force on later activation/reconnect; preserve ordinary cached reads; share an in-flight read and coalesce forced callers into one awaited follow-up snapshot. | Startup **1** table snapshot; return **1**; real offline/online recovery **1**. Forced requests arriving during a read produce one later read. |
| A refreshed table could merge a different server order ID into the old local cart. An old workspace response could also rewrite a newly entered/saved order. | Use the existing session teardown for a changed non-null order ID. Reconcile active-table state only if the captured table session and order still match. | RED reproduced order 101 becoming order 202 without clearing the old draft. GREEN ends that obsolete session, while unchanged orders, split checks and newer sessions/saves preserve their carts. |

Primary sources: `src/pos/useProducts.js`, `src/admin/pages/Orders.vue`, `src/shared/systemSettings.js`, `src/admin/realtime.js`, `src/admin/App.vue`, `src/admin/components/Sidebar.vue`, `src/admin/pages/Inventory.vue`, `src/components/TableFloorPlan.vue`, and `src/pos/stores/orderSession/tableOrderWorkflow.js`.

## Verification

Every new race/duplication regression was observed failing before its fix. The six focused files below passed **26 cases** in a local **1.71 s** run. The final database-free frontend run passed **516 cases across 87 files**. The existing store integration checks, including `tableSession.logic.test.js`, also passed in the broader audit verification. The production frontend build completed in **7.34 s** for the browser-tested source; this is a local build measurement, not a before/after runtime-speed claim.

```powershell
npm run test:frontend -- src/admin/pages/__tests__/ordersRequests.spec.js src/admin/pages/__tests__/inventorySettingsRequests.spec.js src/pos/tableWorkspaceRequests.spec.js src/pos/useProductsRequests.spec.js src/admin/__tests__/realtime.spec.js src/shared/__tests__/systemSettings.spec.js
npm run test:frontend
npm run test:isolated -- backend/tests/unit/tableSession.logic.test.js
npm run build:admin
```

The frontend command has no database setup or Express import. The isolated command creates its own allowlisted loopback database and removes only that database. See [focused verification](../agents/verification.md).

## Built-browser evidence

The passed, compact record is [system-frontend-browser-verification.json](../../scripts/reviews/system-frontend-browser-verification.json). Playwright used the installed repository dependency, headless Chromium and the built application at `http://127.0.0.1:3014`, with a separate guarded `posapp_review_recipe_p1_<12 hex>` database. The fixture contained the standard five products plus 130 synthetic audit products; exactly one had stock 1 and the others stock 100. Settings writes used a second admin tab's Settings UI, except the explicitly missed setting changed through authenticated test HTTP while the browser was offline.

1. Selecting Yesterday issued exactly one orders GET.
2. Disabling tables remotely hid the Tables control and requested register/page 1.
3. Disabling stock from a low-stock view expanded 1 product to all 135; recipe navigation also disappeared after disabling recipe ingredients.
4. Disabling stock in replenishment returned to Products with all 135 rows available.
5. Changing language remotely updated the open Inventory page to Arabic/RTL. The full-page screenshot was visually inspected and remains local at `scratch/system-frontend-arabic-inventory.png`.
6. Three immediate Load More clicks issued one append request, disabled the control during the read and grew the catalog from 120 to 135 products.
7. Fresh floor-plan startup made one table snapshot request.
8. POS → floor-plan navigation made one fresh snapshot request.
9. Offline/online recovery fetched one snapshot and applied the table-mode change missed while disconnected.
10. No uncaught browser errors were observed.

The local runner remains `scratch/system-frontend-browser.cjs`; it is intentionally not a general-purpose checked-in command because it requires the synthetic pagination/stock fixture and performs authenticated settings writes. The durable JSON above records the successful run. Intermediate runner corrections concerned current sidebar selectors, waiting for the existing Start Shift reload, and waiting for SPA navigation; they did not require further product changes.

Cleanup verified that the dedicated server process owned port 3014, stopped it, checked zero database sessions, dropped only `posapp_review_recipe_p1_a077fe000001`, and confirmed that schema no longer existed.

## Boundaries

Reviewed existing admin route lazy loading, dynamic PDF loading, bounded/visibility-aware dashboard and stock-alert reconciliation, print-queue refresh ownership, POS settings request sequencing, refund-report request guards, table listener lifecycle and cart persistence. These were retained where there was no demonstrated improvement justifying a change. Eager POS routes remain intact, including their active-checkout chunk-recovery behavior.

Request-count improvements are deterministic local/browser evidence. They do not establish production latency, weak-network behavior across every timing, or physical-printer completion. Money calculations, frozen line prices, split-money allocation and print delivery safeguards were not changed by this frontend work. Browser settings and pagination verification touched only the disposable local fixture; no production, deployment, push or merge was performed.
