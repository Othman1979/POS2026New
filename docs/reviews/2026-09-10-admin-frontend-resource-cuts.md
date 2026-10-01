# Admin frontend resource cuts — implementation and verification

The five measured findings from the [baseline audit](2026-09-10-admin-frontend-performance-audit.md) are implemented. Dashboard, Orders and Inventory retain their existing KeepAlive boundaries. Page visits preserve the current document and cached search/page-size state; returning to Inventory still refreshes products and categories.

Source commits: `1b325994` (workbook worker) and `1f660c6b` (sales rendering and refreshes), on `codex/admin-frontend-audit`. The [three-part plan](2026-09-10-admin-frontend-implementation-plan.md) was completed locally. Nothing was pushed, merged or deployed.

## Changes

- Import inspection and template generation load SheetJS inside a short-lived browser worker when requested. Inspection returns mapping metadata and up to three useful samples per column, without constructing a second full table of cell values. ArrayBuffers are transferred; the original File remains available for the upload. Workers terminate on completion, cancellation and errors. Submission is blocked while inspection runs, and replacing/clearing/closing invalidates late file reads. Invalid replacement files clear the previous selection. Replacement confirmation and the existing HTTP import contract remain intact.
- Sales Breakdown renders at most 50 matching products per page. Search/category filters still cover the full dataset; dates and filters reset the page, smaller results clamp it. Full report totals and printing use the original dataset, including products outside the current screen page/filter.
- Inventory reuses categories for ordinary search/paging and refreshes them on return, explicit refresh, writes and relevant events. A burst schedules one read; an event during a pending read schedules a final refresh. Superseded/deactivated reads cannot repaint the page. Stock-disabled reconciliation still removes low-stock filtering and returns to Products.
- Sidebar JoFotara badge reads coalesce similarly, refresh after reconnection and stop on unmount. No global cache/state framework or backend changes were added.

## Verification

All **108 frontend test files / 634 tests** passed. The production Vite build, architecture validation and whitespace checks passed. Focused regressions were used before changes for request bursts and pagination; import fixtures compare legacy width, mapping and samples against the former SheetJS conversion, including sparse ranges and unusual cell types. Sol independently reviewed request freshness and import lifecycle/worker loading, with no unresolved findings.

The [production-bundle browser harness](admin-frontend-audit.cjs) and [acceptance checks](admin-frontend-acceptance.cjs) passed all 11 groups in **English and Arabic at both 1440×900 and 390×844**, under 4× page CPU throttling and a same-origin worker CSP. There were no browser errors or unmapped endpoints. They verify:

- One document/session through navigation; cached Inventory and Orders searches and Inventory page size survive route visits.
- Newest catalog rows after events during a deliberately delayed read and after returning to a cached page; final badge count after an in-flight event burst.
- First/last report pages, bounds, zero matches and filter reset. The real print sender sends all 2,000 products and the full 133,000 JD fixture total while the screen is filtered to 11 rows, with the expected text direction.
- Actual worker template download/reopening and legacy mappings. The loopback HTTP fixture receives actual multipart uploads and verifies SHA-256 equality with both original template and legacy workbook bytes, alongside append/replace/confirmation fields.
- Disabled pending submission, removal, rapid replacement, invalid-workbook recovery and closing during inspection, with no remaining workers. Unit regressions additionally hold File.arrayBuffer unresolved through invalid replacement, clear, unmount and valid replacement.

All HTTP data and writes are synthetic and confined to an ephemeral loopback server. No application database, customer data, physical printer or deployment was used. The popup checks the print message contract, not physical paper. Existing Arabic text coverage was not comprehensively audited.

## Measurements

Final paired results are recorded in [resource-cuts measurements](2026-09-10-admin-frontend-resource-cuts-measurements.json), including individual timing samples, elapsed inspection time, request paths, compressed JS bytes, DOM counts, heap counters and browser acceptance results.

| Workload / metric | Before | After |
| --- | ---: | ---: |
| New compressed JS on first Inventory visit | 206.4 kB | 46.1 kB |
| Sales, 2,000 products: native main-thread median, EN / AR | 225 / 253 ms | 35 / 35 ms |
| Sales, 2,000 products: 4× main-thread median, EN / AR | 957 / 1,059 ms | 148 / 154 ms |
| Workbook inspection: native main-thread median, EN / AR | 641 / 629 ms | 82 / 63 ms |
| Workbook inspection: 4× main-thread median, EN / AR | 2,977 / 2,875 ms | 333 / 255 ms |
| Largest report: rendered products / connected elements | 2,000 / 16,314 | 50 / 721 |
| One Inventory search | 2 GETs | 1 GET |
| Ten same-tick Inventory events | 20 GETs | 2 GETs |
| Ten same-tick JoFotara events | 10 GETs | 1 GET |

This is about **85% less main-thread work for the large report** and **89–91% less for workbook inspection** in the 4× runs. None of the after samples for these two actions recorded a main-thread long task of 50 ms or more; the baseline maximums at 4× were 648 ms and 2,797 ms respectively. This is an observed workload result, not a guarantee for every workbook or machine.

The Inventory loading reduction is **160,249 gzip body bytes (77.6%)**, deferred until import/template intent. The actual worker request is 161,400 gzip bytes when first used. It does not make SheetJS disappear from an import session. Ordinary 12-row Inventory and 100-product report timing changed only modestly; the largest rendering benefit is at report scale.

Total workbook action/readiness elapsed time at native speed was **888 / 883 ms before and 854 / 852 ms after** (EN / AR), despite the large main-thread reduction. At 4× it was **3,141 / 3,105 ms before and 914 / 913 ms after**, but worker throttling is not equivalent to the main page's throttle. The native result particularly demonstrates responsiveness rather than a major reduction in total preparation time.

At 4×, forced-GC main-page JS heap after the warm route sequence fell from **10.61 / 10.74 MiB to 9.91 / 10.01 MiB**. After five cached-route cycles it was **11.09 / 11.23 MiB before and 10.52 / 10.61 MiB after**. Cold heap stayed approximately 4.22 / 4.31 MiB; cached DOM counts remained near 13,392 nodes. The small retained-heap reduction is separate from process RAM and excludes worker peak memory. The short cycle test neither proves nor rules out a long-session leak.

The baseline and after runs use three fresh contexts per locale/CPU rate on the same i7-14700KF / Node 24.16.0 / Chromium 148 host. Measured pairs are English desktop and Arabic mobile, so language and viewport effects are not isolated. Workloads, gzip/no-store loopback responses and cache-retention cycles match the baseline. The updated workbook readiness wait includes completion of worker inspection; it no longer relies only on the selected filename appearing.

Main-thread TaskDuration is work accumulated through action/readiness plus a 250 ms settle interval. It is not INP or total page latency. Elapsed time includes worker startup, parse completion and that settle interval. Worker CPU is excluded from the page's main-thread metric, and page CPU throttling does not impose a proven equivalent slowdown on workers. These results establish reduced main-thread work; they do not establish whole-device CPU, total browser RAM, physical four-core/4 GB performance or production network savings. Worker peak memory and long-session stability remain unmeasured.

## Reproduction

With dependencies and Playwright Chromium installed, from the repository root:

```powershell
npm run test:frontend -- --reporter=dot --reporter=json --outputFile.json=scratch/admin-frontend-final-tests.json
npm run build:admin
npm run architecture:check
$env:AUDIT_VERIFY='1'
$env:AUDIT_ROUNDS='1'
$env:AUDIT_CPU='4'
$env:AUDIT_LABEL='acceptance'
node docs/reviews/admin-frontend-audit.cjs
$env:AUDIT_VERIFY='0'
$env:AUDIT_ROUNDS='3'
$env:AUDIT_LABEL='after'
$env:AUDIT_CPU='1'
node docs/reviews/admin-frontend-audit.cjs
$env:AUDIT_CPU='4'
node docs/reviews/admin-frontend-audit.cjs
```

Run measurements sequentially without competing tests/builds. Baseline raw results are preserved under ignored `scratch/admin-frontend-audit/`; after and acceptance files use separate directories. The original baseline harness is recorded at `ec102023`; the baseline frontend is `61ab4e386fd22f1029f69a0ff57b0a05236a4645`. With those saved raw results and `scratch/admin-frontend-final-tests.json`, `node docs/reviews/admin-frontend-compare.cjs` regenerates the tracked comparison. The comparison JSON retains all figures needed to review the reported findings without local scratch files.
