# Typst-only spooler retirement review

Branch: `codex/typst-transport-reliability`. Implementation and local verification completed on 2026-09-25. No deployment, service replacement or physical printing was performed.

## Decision and scope

The spooler now has one document engine: Typst. Removed the Chromium renderer, Puppeteer dependency and configuration, browser setup/download paths, renderer fallback/cooldown, Full packaging target and Chromium rollback target. Existing Full manifests are recognized only as migration sources. The POS application's browser previews and Playwright browser tests remain separate from the spooler runtime.

Three GPT-6 Sol medium workers implemented report layouts, renderer compatibility and packaging independently. The primary agent reviewed each result separately, returned concrete corrections, inspected actual rendered images, and then verified their integration.

## Rendering and compatibility

- Native layouts cover X/Z, audit, category items, Y held items, all four daily reports, expense and cancellation slips, in addition to receipts and kitchen tickets.
- Money, tax, refunds, voids, expenses, reconciliation and report identifiers come from the saved job. No new server queries, schema columns or Hostinger rendering process were added.
- Receipt design and content are retained with corrected wrapping. Short invoice/date and order/type pairs share a line. When too long, identifiers receive the full width and the companion field stays at the right edge. Related pending separator-spacing improvements were reviewed, tested and included so the final receipt does not put the last item against the divider.
- Fractional quantities retain three decimals. Arabic/English names, notes, modifiers, discounts, QR and custom positioned logos were exercised.
- One warm compiler processes reports in bounded sections, releases each decoded image, and publishes one complete, fsynced artifact with one final cut. Limits remain explicit: 12,000 printable rows per section, 24 sections, 200,000 aggregate rows, 16 MiB artifact and 120-second report budget. A limit failure occurs before transport; nothing is silently truncated.
- Category traversal is iterative and bounded, with explicit cycle rejection. Large refund-event item groups and long centered text participate in pagination.
- Drawer-only jobs keep the separate five-byte raw writer and never start Typst. Renderer errors do not switch engines or retry a transport.
- Old built-in structured payloads have a native adapter. A malformed present native layout fails closed. Historical custom HTML-only jobs without `nativeLayout` are not supported: drain the server queue and stations before migration. The updater checks pending local work before replacement and again after stopping the service; it does not inspect the cloud queue.

## Packaging

Setup, core update and runtime update produce only `Typst-Only` spooler artifacts. A runtime transition removes managed Chromium cache/dependencies while preserving ProgramData configuration bytes, identity, journals and outcome-unknown markers. The core updater refuses mismatched runtimes. Fresh CI/source setup downloads hash-pinned Typst/fonts through `scripts/setup-spooler-typst.ps1`, verifies them, applies the existing verified watcher patch, and carries the licenses. A clean, initially empty vendor-cache setup was exercised successfully.

No new installer EXEs were built or installed in this pass. Installer payload/bootstrap contracts and PowerShell syntax were verified; a release still needs its installer build and Windows station acceptance.

## Verification evidence

- All **40 spooler test files** passed, including native C# Windows simulations, TCP faults, transport serialization, cancellation/uncertainty, restart recovery and preserved hostile-runtime/agent checks. Focused native report and receipt checks were rerun after final review corrections.
- **151 focused backend checks** passed across packaging/bootstrap, receipt presentation and audit-report integration after replacing obsolete Chromium-specific assertions. The first aggregate run exposed three obsolete test references; the corrected receipt suite passed 24/24, and the final package/receipt run passed 32/32.
- **22 frontend print-presentation checks** passed.
- The native receipt/kitchen workflow rendered **11 fixtures** and verified raster coverage, hashes, one cut, drawer/beep rules, QR/logo presence, long identifiers and bilingual content. Reviewed the actual PNGs, not generated mockups.
- All **11 report/slip types** compiled with the pinned fonts. Stress cases covered 200 long-name Y rows, 200 audit shifts, a 200-item refund event, deep categories and malformed/cyclic category data.
- Real isolated API -> database queue -> durable agent -> Typst -> loopback TCP passed for X/Z/Y. Lost result acknowledgment was replayed after restart with no additional TCP delivery. A pre-send connection failure recovered exactly once.
- Three four-printer bursts delivered byte-identical artifacts. A ready artifact on a different printer reached the sink in 7–12 ms while a 200-row report rendered. Newly arriving kitchen work followed the current render at 257–285 ms; the serial render lane is intentionally retained.
- Architecture generation/check and diff whitespace checks passed. Source scans found no live dependency on the deleted Chromium renderer; historical evidence and explicit migration/rejection checks retain descriptive references.

Local evidence: `scratch/typst-retirement-spooler-tests.log`, `scratch/typst-retirement-backend.json`, `scratch/typst-retirement-package-final.json`, `scratch/typst-retirement-frontend.json`, `scratch/typst-retirement-e2e/`, `scratch/typst-report-comparison/`, `scratch/shift-report-spooler-recovery/results.json`, `scratch/typst-retirement-queue.json`.

## Paired local render measurements

Same saved fixture through the old renderer before its deletion and the final native renderer, one warm-up plus three warm samples each, Node 22.23.0 on this Windows workstation. These are render medians, not printer-paper completion times or robust p95 estimates.

| Job | Chromium median | Typst median | Chromium / Typst height |
| --- | ---: | ---: | ---: |
| X report | 94.8 ms | 46.0 ms | 1345 / 1271 px |
| Z report | 97.3 ms | 38.8 ms | 1345 / 1229 px |
| Audit report | 101.2 ms | 64.0 ms | 2025 / 2173 px |
| Y report | 59.3 ms | 44.3 ms | 948 / 981 px |
| Daily summary | 91.4 ms | 59.8 ms | 1283 / 1148 px |
| Daily sales | 93.9 ms | 40.8 ms | 1137 / 1180 px |
| Daily refunds | 67.2 ms | 49.7 ms | 1023 / 974 px |
| Daily expenses | 60.3 ms | 36.7 ms | 934 / 821 px |

Some Arabic reports are modestly longer to preserve readable spacing. The resource probe completed a mixed compiled/legacy/report workload in 3.55 seconds with 2.66 seconds of aggregate process CPU, 168.5 MiB peak committed memory and 183.8 MiB sampled working set. This is a single local workload, not an idle-memory figure or a customer-machine guarantee.

## Remaining release evidence

Physical paper output, specific Windows drivers, cut behavior and an actual packaged runtime upgrade require station acceptance. TCP byte/hash success cannot prove paper completion. No claim of 100% field correctness is made. The existing multi-terminal transport ownership and uncertainty protections were retained and exercised, not weakened to accelerate printing.

## Follow-up completeness check

Rechecked server factories, queue producers, the document router, report types,
package/lock files and all bootstrap paths. The legacy `zreport` request alias is
normalized to `z_report` before queueing. Expanded the routing check to every one
of the 13 document types and reran actual native report, receipt and kitchen
renders successfully. Cash-drawer jobs remain the intentional raw-command path.

Corrected stale browser-download wording in the lightweight bundle builder and
its README. Pruned local extraneous Puppeteer dependencies without changing the
tracked package/lock files. Automatic approval review blocked deletion of the
ignored `.cache/puppeteer` directory (`blocked by policy`); those old comparison
binaries remain on this development machine but have no runtime route and are
explicitly forbidden in new spooler payloads. Historical documentation, migration
cleanup/rejection checks and the separate POS browser-test setup still mention
Chromium by design.
