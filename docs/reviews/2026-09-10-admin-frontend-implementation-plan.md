# Admin frontend resource cuts — implementation plan

Approved scope: implement the five measured findings in the admin frontend audit. Preserve the dashboard/orders/inventory KeepAlive cache, route navigation, fresh data, complete report totals and printing, catalog import behavior, and Arabic/RTL interactions. No backend changes, deployment, push or merge. The requested writing-plans skill was not found in installed skill locations; this plan is authored directly.

## 1. Make import preparation responsive and load it on demand

- Own `ImportModal.vue`, a small browser worker/client boundary and focused tests. Keep the existing modal and import HTTP contract.
- Record existing workbook inspection/template behavior before editing: named template sheets, legacy column width/samples/default mapping, empty/invalid files and template values.
- Move SheetJS inspection and template generation into a short-lived, on-demand worker. Transfer buffers, return only required metadata/file output, terminate on completion/error/cancel/unmount. Latest file wins; disable submission while inspection is pending and preserve replacement confirmation.
- Verify baseline fixtures, worker failures, removal/replacement races and actual production worker loading. No SheetJS on Inventory navigation, and no main-thread spreadsheet parser fallback.

## 2. Bound report rendering and redundant reads

- Sales page: reuse simple pagination for the product table only. Filter the full dataset, reset/clamp pages on filter/data changes, preserve totals and full print payload. Test first/last pages, zero matches, shrinking results and print data before/after.
- Inventory: keep category data for normal product search/paging; reload categories for activation, explicit refresh, writes and relevant signals. Collapse event bursts and preserve a trailing refresh for changes arriving during an in-flight read. Superseded/deactivated reads must not repaint stale data; existing stock-disabled reconciliation must still pass.
- Sidebar: coalesce badge events locally, preserve initial/final refresh and discard work after unmount.
- Write race/request-count regression tests before changing the affected behavior. Retain current cache and route boundaries; no generic state framework or unrelated splitting.

## 3. Verify complete flows and record measured results

- Run focused frontend regressions, then the frontend suite and production build. Inspect imports and worker assets/CSP compatibility.
- Use an isolated synthetic HTTP browser harness only: no customer database. Verify EN/AR desktop/mobile navigation without document reloads, cached filter state, fresh data after return, report pagination/search and complete print payload, import/template/selection/cancel/error behavior, request bursts and delayed response races.
- Re-run the audit workloads at native and 4× CPU speed, sequentially, preserving baseline evidence. Compare compressed bytes, main-thread long tasks and retained heap separately; include total elapsed inspection time to avoid confusing responsiveness with faster parsing.
- Review the final diff for missing imports, lifecycle cleanup, freshness races, accidental scope growth and regressions. Correct failures, update this plan/results, and make task-sized local commits. No push/merge/deployment without separate authorization.

## Status

- Planning: complete. Before/after contracts reviewed against current source and the measured audit.
- Task 1: complete in `1b325994`. Worker preparation, bounded metadata, original-file upload, Arabic progress text and cancellation/invalid-replacement regressions are implemented.
- Task 2: complete in `1f660c6b`. Sales pagination, category reuse, burst/trailing refreshes, stale-read cleanup and stock-disabled reconciliation are verified.
- Task 3: complete. All 108 frontend files / 634 tests, production build, architecture check, and 44 browser acceptance groups across EN/AR desktop/mobile passed. Native and 4× CPU workloads were each repeated three times per paired locale/viewport, with baseline evidence preserved. Sol's final reviews found no unresolved defects.
- [Measured outcomes and limitations](2026-09-10-admin-frontend-resource-cuts.md) and [comparison samples](2026-09-10-admin-frontend-resource-cuts-measurements.json) are recorded. Navigation preserves the existing document and cached filters; full print payloads and original upload bytes were checked against isolated fixtures. No customer DB, physical printer, push, merge or deployment was used.
