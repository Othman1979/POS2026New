# Shifts Thermal spooler routing and compact Y output

Implemented on `codex/pos-frontend-audit`, starting from `d9817736`. Only the Shifts page changes its dropdown delivery policy: **Thermal goes to the spooler; A4 stays in browser preview.** This applies to selected-shift X/Z, official X/Z, Period, Items, Y, and Reopen last Y.

Thermal carries this device's `pos_receipt_printer_id`. The admin report routes select that active receipt printer, or the first active receipt printer by ID when the saved ID is absent/unavailable. No active receipt printer produces an error. Other receipt/kitchen printer-selection rules are unchanged. Report amounts are built on the server; the client does not submit authoritative totals.

The page reports queue success only after `print_queued: true`, serializes print actions across both formats, and never retries or opens a browser automatically after a lost Thermal response. A4 retains its existing nonce-bound same-origin preview handshake and works without a configured printer.

Y prints its calculations, discounts, tax, category totals and aggregated items. Individual receipt identities, notes and line-detail sections were removed from its browser/A4 and spooler layouts. Queued Y data also omits `orders`, so already-installed spoolers receive no receipt details to render. Full receipt/held data stays in the recovery archive. Thermal queue insertion, Y archive insertion and removal of included held orders share one transaction; a missing printer or failed queue write leaves the holds intact. Reopen queues the existing snapshot without removing new holds.

## Verification

- Before production edits: 10 frontend routing regressions and 9 backend delivery regressions failed. The A4 and spooler rendering tests also failed on unwanted Y receipt content.
- Final frontend suite: **730 tests in 115 files passed**. Coverage includes all seven print actions in both formats, saved/default printer parameters, declined Y confirmation, missing queue acknowledgement, busy protection and lost responses.
- Isolated backend suite: **67 tests in 6 files passed** (`shiftReportDelivery`, `auditReports`, `yHeldItemsReport`, `categoryItemsReport`, `printShiftReport`, `printDispatchOwnership`). It covers canonical financial data, serial/reprint behavior, role restrictions, printer selection, Y rollback and archive recovery.
- Built browser: **32 dropdown print checks passed**, across English desktop and Arabic mobile. Sixteen Thermal actions created the correct durable jobs without popups; sixteen A4 actions invoked their preview print double without creating jobs. Both selected-shift X and Z were included. No page runtime errors remained.
- Spooler `report-html` and `spooler-report-rendering` checks passed. Real Chromium/canvas artifacts preserved every row:

| Fixture | Width | Raster rows / rendered height | Bands |
| --- | ---: | ---: | ---: |
| Y from the browser/API fixture | 576 dots | 842 / 842 | 4 |
| Y with 200 item rows | 576 dots | 13,180 / 13,180 | 52 |
| Audit with 200 rows | 576 dots | 7,430 / 7,430 | 30 |

The Y summary screenshot and A4 output were visually reviewed. The large Y retained Item 200; width checks found no horizontal overflow. Production build and architecture generation/check passed.

Browser harness corrections addressed fixture-only issues: storage initialization on an opaque blank popup and an ambiguous mobile Close selector. The render probe was adjusted to launch the installed Chrome headless shell. No production workaround was added for these harness issues.

Raw evidence is under ignored `scratch/shifts-print-*`; maintained reproduction commands are in [verification.md](../agents/verification.md). Tests used generated loopback databases, queue fixtures and local rendered artifacts. No customer printer, production database, push, PR or deployment was involved; physical driver/paper output still requires validation on the affected machine.

## Follow-up: adversarial verification

The additional tests exposed two reproducible defects and a misleading failure message:

1. **RTL clipping with long unbroken names.** A 576px document could still draw names and quantities almost 1,900px beyond the left edge; `scrollWidth` remained 576. A new real-Chromium regression checks every text-run rectangle, including long English/Arabic names, categories, cashier/store names and large amounts, across X, Z, audit, Items and Y. Report-only CSS now wraps names within the fixed raster and reserves space for the value column. Receipt/kitchen layouts are outside this CSS change. The failing layout log is `scratch/shifts-hostile-layout-red.log`.
2. **Selection changed during A4 startup.** All seven print handlers previously read live selection after the preview became ready. Changing the date, selected shift or Y archive while it loaded could print a different selection. Handlers now capture identifiers/dates at click time, before preview readiness or confirmation. Seven new regression cases failed before the fix and pass after it; actual delayed browser navigation also verifies the original date survives a filter change.
3. **Lost Thermal response.** The previous alert mentioned a preview network error even when the server had already queued the report. English and Arabic now explicitly explain that queueing may have succeeded and direct the operator to Printing before retrying. No automatic resend or browser fallback was added.

Before the production corrections, the frontend file had **8 failures / 19 passes**. After correction it has **28 passes**, including a canonical-payload check moved from a source-regex test. Evidence: `scratch/shifts-hostile-frontend-red.log`.

Additional acceptance:

- **738 frontend tests in 115 files pass**, and the production build passes. The first broad run found two old source-regex checks that required reading live selection inside print callbacks; those checks were replaced with runtime assertions for canonical payloads and read-only archive retrieval. The clean final log is `scratch/shifts-hostile-frontend-all-final.log`.
- **15 isolated backend tests pass.** Four simultaneous Y requests return one success and three empty-set responses, with exactly one archive/job and no lost holds. Missing receipt printers and failed queue insertion preserve held orders. Inactive/kitchen saved printers are excluded from fallback. Missing, expired and restored Y archives cannot enqueue a new job.
- **42 built-browser checks pass** in English at 1280px and Arabic at 390px: the original 32 dropdown checks, four deliberate archive reprints, four Y failures after commit (reset/truncated body), and two delayed A4 previews. Failed responses leave one durable job and an accessible archive; no automatic retry occurs. Explicit archive reprint preserves held orders created afterward. No uncaught page errors. The first extended harness attempt used a nonexistent dialog-role selector for the alert; correcting the harness to click its visible OK button resolved that harness-only failure.
- **All 32 spooler test scripts pass under packaged Node 22.23.0**, including transport failure classification, uncertain-send/restart handling, renderer, queue priority, sync, journal, Windows helper doubles and the new 10-case layout regression.
- **Real end-to-end spooler delivery passes** through HTTP report routes, database queue, V2 sync, durable local journal, workers, Chromium/canvas and loopback TCP. X/Z/Y bytes match both journal and cloud artifact hashes. Losing the result acknowledgement then restarting keeps the TCP delivery count at 4 → 4; only the durable result is replayed. A connection refused before submission persists safe retry state and delivers exactly once after restart when the same endpoint becomes available. The harness removes its generated database and temporary journal.
- Real raster output still includes all 13,180 rows of the 200-item Y and all 7,430 rows of the large audit. The long-name Y includes all 1,174 rows at 576 dots, with a final cut command. Its screenshot was visually reviewed; neither names nor quantities escape the paper width.

Raw follow-up logs: `scratch/shifts-hostile-*`; spooler end-to-end evidence: `scratch/shift-report-spooler-recovery/results.json`; browser checks: `scratch/shifts-print-browser.json`; rendered artifacts: `scratch/shifts-print-render/`.

These experiments verify local delivery, durable recovery and layout behavior. They do not establish physical paper completion, actual Windows driver behavior, or every customer printer model. The long-name CSS correction is in the spooler source, so installed spoolers need that source update to receive it; server-side Y receipt omission is already enforced in queued data.
