# Admin Browser Report Printing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every report-print action in Admin Shifts and the shared Daily Reports header offer an 80mm thermal or detailed A4 layout and then open the browser's native print preview, regardless of the global print method or restaurant printer configuration.

**Architecture:** Keep the existing report builders and `print_receipt.html` application. Each report action becomes an accessible dropdown whose two choices pass `thermal` or `a4` to the print application; the browser preview still chooses the physical printer. Replace admin spooler dispatch with an authenticated payload-return contract and a same-origin `postMessage` handoff. Thermal copies the approved V2 spooler presentation; A4 is a separate detailed presentation inside the same print application, not a stretched receipt or a second reporting system.

**Tech Stack:** Vue 3, Vite, Vitest, Express 5, MySQL/MariaDB, native browser `window.open`, `postMessage`, `window.print`, CSS paged media.

## Global Constraints

- Plan fixed point: `master` at `f07163a2ea09006efcaabc2e9f703727156a6219`. Re-read current source and adjust line anchors if HEAD advances before execution.
- Work on a normal feature branch in the main checkout, for example `codex/admin-browser-report-printing`. Do not create an isolated worktree.
- These admin actions must ignore `settings.print_method`, `pos_receipt_printer_id`, receipt-printer availability, and spooler connectivity.
- Each included Print button is a dropdown with exactly two document layouts: `Thermal (80mm)` and `Detailed A4`. Do not add a saved preference or Settings field. The browser preview remains responsible for choosing the actual printer and matching physical paper.
- Do not modify `src/admin/pages/Orders.vue`, its `reprintReceipt`/`reprintDirect` functions, `backend/services/printReprint.js`, or the Orders History audited reprint routes.
- Do not change checkout receipt, kitchen ticket, cashier shift-close, expense creation/cancellation auto-slip, or print-queue recovery behavior. The explicit expense-row **Reprint** action is also an operational expense slip, not the Daily Report document; leave it on its current path.
- The complete inventory of admin print entry points is: `useThermalReportPrint.js:41,43` (in scope), `Shifts.vue:769` and the four `audit-reports/*` calls (in scope), `Orders.vue:1142,1220` (out), `WaiterPerformance.vue:324` (out), `ReportsExpenses.vue:89` (out), `DeliveryInvoice.vue:327` (out), and `TableMapEditor.vue:571` (out). Do not convert the two out-of-scope `window.print()` sites or either order-reprint surface while passing through.
- Keep the old spooler report render branches and `backend/services/auditPrintStatus.js` for already-queued jobs and older installed agents. Stop creating new spooler jobs only from the named admin report actions.
- Preserve the X/Z serial, Z one-per-business-date rule, open-shift blocker, payload hash, Y archive/delete/restore transaction, active held-order claim blocker, and `held_orders_changed` notification.
- A browser can report that a preview is ready; it cannot prove that paper was printed. Never label a browser preview as a physical print success.
- Preserve English/Arabic UI, RTL report content, keyboard focus, and current report date-range limits. The admin app has **one** visual theme (light surfaces, dark sidebar) — it has no theme toggle, no `.dark` class and no `prefers-color-scheme` rule anywhere in `src/admin/styles.css`. Do not write a task or an acceptance step that assumes a second admin theme. The printed document is always black on white regardless.
- Report money is computed on the server. No task may add, re-derive or adjust a financial figure in Vue; the browser only formats what a server payload already contains.
- Migration files are written by the `luna_max` agent per `CLAUDE.md`, never by the executing agent, and every post-floor migration also appends to `deployment/database/hostinger-manual-migrations.sql`.
- Use focused RED/GREEN tests. Do not run the complete repository suite for this feature.

---

## Evidence and Decisions

### Confirmed current behavior

1. `src/admin/composables/useThermalReportPrint.js:19-52` reads the global print method and posts Daily Reports to `api/print/print` when spooler mode is selected. This directly contradicts the cloud-office use case.
2. `src/admin/components/ReportsLayout.vue:40-46` exposes one shared 80mm action for Summary, Sales Breakdown, Refunds & Voids, and Expenses. The four pages register payload providers at `ReportsSummary.vue:247`, `ReportsSalesDetails.vue:205`, `ReportsRefunds.vue:244`, and `ReportsExpenses.vue:106`; their data builders do not need replacement.
3. `src/admin/pages/Shifts.vue:743-882` sends the selected-shift X/Z report plus official X/Z, period, Items, and Y reports through spooler endpoints and includes `pos_receipt_printer_id` in every request.
4. `backend/routes/admin/auditReports.js:98-129,174-478` couples report generation to `dispatchReceiptPrint` and, for Y, resolves a receipt printer before it will archive anything.
5. Y is not a harmless print request. `backend/routes/admin/auditReports.js:389-452` locks eligible held orders, archives their payload, deletes them, and commits before delivery. Browser handoff must therefore be ready before this POST is allowed to run, and the committed archive must support reopening its saved report.
6. The browser renderer and spooler renderer have drifted. The approved thermal reference is `pos-spooler-printer/v2/artifact-renderer.js:104-350`; the browser audit/Items/Y branches are `src/print/PrintReceiptApp.vue:395-574`. The browser contains newer platform-remittance disclosure that the spooler branch lacks. Matching the approved design means matching its separators, density, and section hierarchy—not deleting newer financial disclosure from the report payload.
7. `src/print.css:4-13` forces every browser document to `80mm`, so an A4 printer receives a receipt-width column. A print window renders exactly one layout, so it needs exactly one `@page` rule — chosen at load, not two named pages.

### Corrections to earlier drafts of this plan (verified against `f07163a2`)

Every item below was asserted by an earlier revision and is wrong. They are recorded so no executor re-derives them.

- **`PrintReceiptApp.vue` already renders `x_report` and `z_report`** — `src/print/PrintReceiptApp.vue:84-114`. The branch is not missing; it is *thin*. It renders gross, cash, card, cash expenses, expense categories, expected and actual cash, and silently drops `platform_sales`, `total_discounts`, `order_type_breakdown`, `platform_order_type_breakdown`, both `subscription_receivable_*` collection figures and `starting_cash` — all of which the server sends and the spooler prints. Task 1 extends this branch. Adding a second `v-if` for the same print types would render both.
- **The selected-shift X/Z payload is built by the server, not the client.** `backend/routes/print.js:836-931` discards the posted numbers and rebuilds the document from the database: refund-netted gross/cash/card/platform, `getShiftDiscountsByShift`, `getCashExpensesByShift`, `getCashExpenseCategoriesByShift`, `getSubscriptionCollectionsByShift`, live expected cash, and a per-order-type breakdown. It also enforces admin-or-shift-owner at `:854-858`. Building this payload in Vue from a list row would print stale, thinner and unauthorised numbers.
- **The V2 reference is measured in printer dots, not CSS pixels.** `artifact-renderer.js:63-91` sets `body { width: 576px; padding: 5px 10px 60px }` — 576 dots is the 80 mm / 203 dpi printable width, so its content column is 556 units and `font-size: 25px` means 25 *dots*. The browser thermal document is `80mm` wide with `5mm` padding — a 70 mm content column, which is 264.6 CSS px at 96 dpi. **One V2 unit = 264.6/556 ≈ 0.476 CSS px.** Copying V2 pixel values literally makes every element about 2.1× too large and overflows the paper.
- **The print window loads no web fonts.** `print_receipt.html` links only `/src/print.css`, and `print.css:23-24` names `Cairo` for RTL — a family that is never loaded in that window, unlike `index.html:13` and `admin.html:13` which both link `/assets/css/fonts.css`. The approved spooler output uses `Tahoma, 'Segoe UI', Arial` for its Arabic sections (`artifact-renderer.js:194,296`) and `'Helvetica Neue', Helvetica, Arial` for Latin (`:67`). Matching the approved design means matching those stacks.
- **The X/Z thermal report is English in both renderers** (`artifact-renderer.js:106`, `PrintReceiptApp.vue:86`). Only the audit, Items and Y reports are Arabic. Do not translate X/Z.
- **The admin app has no second theme.** See Global Constraints.

### Defect found while verifying this plan — must be fixed inside it

`backend/services/auditReportBuilder.js:29-32`:

```js
async function getStoreInfo(executor) {
    const [rows] = await executor.query('SELECT setting_key, setting_value FROM settings');
    return Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
}
```

This reads **the whole settings table** into `payload.storeInfo` for every audit, period, Items and Y report. Measured on the dev database: `audit_report_documents.payload_json` id 3 carries 41 `storeInfo` keys including a live 280-character `jofotara_sales_tax_secret_key` and a 36-character `jofotara_sales_tax_client_id`. The payload is persisted, and `payload_hash` is computed over it.

This is the same defect `44e85cbe` fixed in `backend/routes/print.js` (allowlist `PRINT_STORE_INFO_KEYS`) at a second source that commit did not reach, and the `cacd5dc7` redaction script covers only `print_queue.payload`, not `audit_report_documents` or `master_held`.

It blocks this plan specifically: Task 2 changes these routes to **return the payload to the admin browser**, moving a live credential from the database and the LAN spooler into an HTTP response body that is readable in DevTools at any admin terminal, and into a `postMessage` to a popup window. Task 2 Step 0 fixes it first.
8. `audit_report_documents.last_print_status` only permits `queued`, `printed`, and `failed` in `deployment/database/baseline.sql:179` and `backend/tests/fixtures/seed.js:275`. None honestly describes a browser preview that is ready.
9. Orders History uses independent audited paths in `src/admin/pages/Orders.vue:1142-1245`; it must remain byte-for-byte outside the feature diff.

### Decisions taken

- Reuse `print_receipt.html` and `PrintReceiptApp.vue`; add one focused A4 report component, not a PDF service, iframe renderer, or second report application.
- Use a same-origin nonce handshake over `postMessage`, not `localStorage`, for these reports. Large 366-day/Y payloads can exceed storage limits, and one shared localStorage key can be overwritten by concurrent tabs. Keep the existing localStorage fallback only for untouched legacy receipt callers.
- Open and handshake with the print window after the user chooses a layout but before invoking the async provider. If popups are blocked or the print app fails to load, no serialized report is issued and Y orders are not archived.
- Move the five-key print-letterhead allowlist into a small shared CommonJS service imported by both `routes/print.js` and `auditReportBuilder.js`; do not import a route from a service or change the print router's export shape. Redact extra keys already stored in `audit_report_documents.payload_json` and `master_held.report_payload`.
- The selected-shift X/Z payload stays server-built. Extract the existing block in `backend/routes/print.js` into one shared builder and call it from both the unchanged operational route and a new read-only admin endpoint. Do not reimplement it and do not compute it in Vue.
- Choose the page size by appending one `@page` rule at load, not with named pages. A print window renders exactly one layout, `@page` cannot be selected by an attribute, and named pages plus the `page` property are the least supported way to express a choice already made at URL-parse time. `src/admin/components/A4Receipt.vue:358-361` is the existing A4 precedent in this repo and it uses a plain `@page` block.
- Add `browser_ready` to the existing audit status enum. It means the server prepared and returned the immutable browser-preview payload, not that the user completed printing. Nothing reads this column in the UI — `/audit-reports/status` does not select it — so the status write must never be able to fail a report: an un-migrated database has to degrade to a logged warning, not a 500 on an already-committed document.
- Extend Y archive recovery with a read-only “Reopen last Y” payload endpoint. It does not archive, delete, restore, or increment anything.
- Remove the admin force-close auto-spooler call. After a successful force close, the user can use the explicit Z button. An automatic browser preview after an awaited close request is popup-blocker-prone and is not a reliable browser-print workflow.

---

## Task 1: Build the Browser Preview Transport and Dual-Layout Print Surface

**Files:**

- Create: `src/admin/composables/useBrowserReportPrint.js`
- Create: `src/admin/composables/__tests__/useBrowserReportPrint.spec.js`
- Modify: `src/print/PrintReceiptApp.vue` — script/handshake at `:580-647`, X/Z branch at `:84-114`, audit/Items/Y branches at `:395-574`
- Modify: `print_receipt.html` *(link the self-hosted font sheet)*
- Create: `src/print/AdminReportA4.vue`
- Modify: `src/print.css`
- Modify: `src/print/__tests__/reportPrintBranches.spec.js`
- Create: `src/print/__tests__/adminReportPrintDesign.spec.js`

- [ ] **Step 1: Write RED transport tests.**

Test the public composable contract:

```js
const { printReport, isPrinting } = useBrowserReportPrint();
await printReport('a4', async () => ({ print_type: 'daily_summary_report', summary: {} }));
```

Required assertions:

- `window.open('about:blank', '_blank', ...)` occurs synchronously before the provider is called; the listener is installed before that window is navigated to the print app, so a fast readiness event cannot be missed.
- The provider is not called until a same-origin `POS_ADMIN_PRINT_READY` message arrives from that exact popup with the matching nonce.
- A different origin, source window, or nonce is ignored.
- A blocked popup rejects before the provider is called.
- A readiness timeout closes the popup, removes the message listener, and does not call the provider.
- System settings are loaded and reduced to exactly the five letterhead keys before the provider runs; a settings failure does not call the provider.
- A valid provider result is posted once as `POS_ADMIN_PRINT_PAYLOAD` with the same nonce, current admin language/direction, and exactly those five store-info keys. A provider-supplied `storeInfo` is reduced through the same picker rather than trusted or merged whole.
- A provider result of exactly `false` means the user canceled: close the prepared popup quietly, post nothing, and show no error. Other missing/invalid payloads remain errors.
- The selected layout is validated to exactly `thermal` or `a4`, is carried in the print URL/message, and an unknown value fails before the provider runs.
- The code contains no branch on `print_method`, no `pos_receipt_printer_id`, and no request to `api/print/print`.
- Concurrent calls use different nonces and cannot exchange payloads.

Run:

```powershell
npx vitest run src/admin/composables/__tests__/useBrowserReportPrint.spec.js
```

Expected RED: the composable does not exist.

- [ ] **Step 2: Implement the smallest same-origin handshake.**

The composable must expose only:

```js
export function useBrowserReportPrint() {
  return { printReport, isPrinting };
}
```

Implementation order inside `printReport(layout, provider)`:

1. Reject duplicate clicks while `isPrinting` is true.
2. Validate the first argument as `thermal` or `a4`, then generate a non-secret nonce without requiring a secure context.
3. Open `about:blank` immediately.
4. Fail with the localized popup-blocked message if `window.open` returns null. Do not call `provider`.
5. Install the exact source/origin/nonce listener, then navigate that popup to `print_receipt.html?admin_report=<encoded nonce>&layout=<thermal|a4>`. Wait at most 10 seconds for readiness.
6. Recheck `popup.closed`.
7. Load `getSystemSettings()` and reduce it immediately to exactly the five print-letterhead fields. This must finish before the provider runs, so a settings failure cannot consume an X/Z serial or commit a destructive Y archive.
8. Call `window.focus()` so any confirmation the provider raises is visible — the popup takes focus when it opens, and a `showAdminConfirm` modal raised behind it looks like a hang. Then call `provider()`. Treat exactly `false` as a quiet user cancellation; otherwise require a supported `print_type`. Reduce `providerPayload.storeInfo` through the same five-key picker when it exists; otherwise attach the already-prepared letterhead.
9. Recheck `popup.closed` **again** — a 366-day provider can run for many seconds and the user may have closed the window meanwhile — then post the payload once to the exact popup and clean up listeners/timers in `finally`.
10. On any failure, including a provider that throws (the Refunds provider fetches `api/admin/reports/refunds/print-data` and throws on a bad response), close the popup and show the existing admin alert surface. Do not claim that printing succeeded.

The popup itself must show a plain localized “Preparing print preview…” state while it waits.

Build the print URL as an absolute same-origin path — `new URL('/print-receipt', location.origin)` — not the relative `print_receipt.html` the current composable uses. `/print-receipt` is the canonical route (`server.js:469`); `/print_receipt.html` is a 301 to it (`server.js:483`), and the relative form only resolves correctly because `admin.html:7` happens to carry `<base href="/">`.

- [ ] **Step 3: Teach the print app the handshake without breaking existing callers.**

In `PrintReceiptApp.vue`:

- If `admin_report` is present, validate `layout` as exactly `thermal` or `a4`, register a one-shot same-origin message listener, notify `window.opener` with `POS_ADMIN_PRINT_READY`, accept only `POS_ADMIN_PRINT_PAYLOAD` with the matching nonce/layout, then render and call `window.print()` after `nextTick`.
- If `admin_report` is absent, retain the current `pos_print_payload` localStorage path exactly for checkout/legacy browser receipt callers and force the existing thermal layout default.
- Never accept a payload from another origin, another window, or without the nonce.
- Remove the message listener before calling print.

- [ ] **Step 4: Keep thermal output exact and isolate the detailed A4 presentation.**

`@page` cannot be selected by an attribute or a custom property, and a print window renders exactly one layout. So: delete the hard-coded `@page` from `src/print.css`, move its `width`/`padding` behind `html[data-print-layout="thermal"]`, set `document.documentElement.dataset.printLayout` from the validated URL value, and append the one page rule that layout needs before first render.

```css
/* src/print.css — no bare @page any more */
html[data-print-layout="thermal"] body { width: 80mm; padding: 5mm; }
html[data-print-layout="a4"]      body { width: auto; padding: 0; }
```

```js
// PrintReceiptApp.vue, before render
document.head.appendChild(Object.assign(document.createElement('style'), {
    textContent: layout === 'a4'
        ? '@page { size: A4 portrait; margin: 22mm 12mm 16mm; }'
        : '@page { size: 80mm auto; margin: 0; }'
}));
```

The browser dialog may still override paper; the document layout stays whatever the dropdown chose. Also link the self-hosted font sheet the other two entry documents already use, so A4 can use IBM Plex Sans Arabic:

```html
<!-- print_receipt.html, matching index.html:13 and admin.html:13 -->
<link rel="stylesheet" href="/assets/css/fonts.css">
```

Pagination rules, exactly these and no more:

```css
thead              { display: table-header-group; }  /* headings repeat   */
tbody tr           { break-inside: avoid; }          /* a row never splits*/
.section-head      { break-after: avoid; }           /* heading ≠ last line */
.metrics, .docket  { break-inside: avoid; }          /* atomic blocks     */
p, li              { orphans: 3; widows: 3; }
```

Two traps to avoid. Never give a totals row `display: table-footer-group` — it repeats on every page and a financial document then appears to carry several totals; totals go in the last `tbody` row. Never put `break-inside: avoid` on a whole `<table>` or `<section>` — a 214-row item ledger would be pushed to a fresh page and overflow it anyway.

- [ ] **Step 5: Lock the approved report design.**

Port the V2 thermal visual grammar from `pos-spooler-printer/v2/artifact-renderer.js:104-350` into the browser's `x_report`/`z_report` branch at `PrintReceiptApp.vue:84-114` — **extend that existing branch, do not add a second one** — and into the official `audit_report`, `category_items_report` and `y_held_items_report` branches at `:395-574`.

Convert every size: **one V2 unit = 0.476 CSS px** (see Corrections above). Express the port as `calc(N * var(--u))` with `--u: calc(70mm / 556)` so the browser column stays proportional to the approved 556-dot column at any DPI, rather than pasting `font-size: 25px` into a document 2.1× smaller than the one it was authored for.

Use the spooler's own font stacks — `'Helvetica Neue', Helvetica, Arial` for Latin sections and `Tahoma, 'Segoe UI', Arial` for Arabic sections. Do not use `Cairo`; `print.css:24` names it but nothing loads it, so it has never rendered. Do not use IBM Plex here either — thermal parity means matching the approved output, and A4 is where the better face belongs.

Carry across:

- centered store identity and report title;
- solid major separators and dashed minor separators;
- dense label/value ledger rows, right-to-left for the Arabic reports;
- section order for audit: sales, payments, platform reconciliation when present, drawer, shifts, order types, blockers, end marker/hash;
- section order for Items/Y: Y summary/details when applicable, root categories, subcategories, items, end marker;
- same headings and financial precision — Arabic for audit/Items/Y, **English for X/Z**, which is English in both renderers;
- the newer platform reconciliation block, using the same approved row grammar.

Close the six-field gap in the X/Z branch while you are in it: `platform_sales`, `total_discounts`, `starting_cash`, `order_type_breakdown`, `platform_order_type_breakdown` and both `subscription_receivable_*` collection figures are already in the server payload and already printed by the spooler.

The design test must assert: the `x_report`/`z_report` branch appears exactly once; the six previously-dropped fields are referenced; section order matches between the V2 reference and each thermal browser branch; the RTL/font/separator tokens are present; `src/print.css` contains no bare `@page`; and the A4 component is selected only for the included admin report types.

- [ ] **Step 6: Implement genuinely detailed A4 reports.**

`AdminReportA4.vue` consumes only `{ printType, data }` and renders black-on-white printable documents. It must not fetch data, calculate accounting values from raw orders, dispatch printing, or know about the spooler. Use the already-built payload fields:

- **Daily Summary:** business period, headline sales/refunds/net/service-charge figures, payment and platform-reconciliation tables, comparison, order types, hourly sales, and complete cash status.
- **Daily Sales:** totals followed by full category, product, order-type, cashier, waiter, and table tables. Omit sections only when their payload arrays are empty.
- **Refunds & Voids:** headline rates/counts/value, staff activity, top reasons, and the complete event ledger with identity, type, reason, staff, time, method, and amount.
- **Expenses:** totals and remaining cash, source/category breakdowns, and the complete expense ledger including canceled state and actor information.
- **Legacy selected-shift X/Z:** all supplied shift, payment, order-type, expected/actual, discount, and variance fields in labeled tables.
- **Official X/Z/period audit:** immutable serial/date/hash metadata plus complete sales, payments, platform reconciliation, drawer, shifts, order types, and blocker tables.
- **Items:** a summary strip plus complete root-category, subcategory, and item tables with quantity and gross revenue.
- **Y:** archived-order summary, complete held-order/item details, then the same category/subcategory/item tables.

For Items A4 summary, extend the builder in Task 2 to provide `summary.product_count`, `summary.total_quantity`, and `summary.gross_revenue`; the browser must not recompute money.

#### A4 design system

The A4 report is a **ledger sheet**, not a widened receipt. The thermal ticket is a till artifact — thumb-width, read once, spiked. The A4 is an archive artifact — filed, stapled, handed to an accountant. Same facts, different object.

**Ink.** Black on white, but hierarchy comes from rule weight and type weight, never from grey figures — every number on the page is pure black so a photocopy survives.

```css
--ink: #000;  --ink-70: #4a4a4a;  --ink-40: #8a8a8a;  --wash: #f2f2f2;
--rule-hair: 0.5pt solid;   /* between data rows                      */
--rule-thin: 1pt solid;     /* under an eyebrow, above a total        */
--rule-thick: 2pt solid;    /* document boundary                      */
--rule-dash: 0.75pt dashed; /* minor split — mirrors the thermal rule  */
```

`--wash` is the only tint and appears in exactly two places: the `thead` band and total rows. Anything lighter vanishes on a cheap laser; anything darker eats toner.

**Type.** IBM Plex Sans Arabic, weights 300/400/600/700, already self-hosted in `assets/fonts/` — one family covering both scripts, so a page that mixes Arabic headings with `Z-114` and Western digits stays unified, with digits designed for technical documentation. Sizes in `pt`, which is the correct unit for paged media:

| role | size / weight |
| --- | --- |
| document title | 15pt / 700 |
| store identity, running header | 8–10pt / 600, tracking .08em, uppercase |
| section eyebrow | 8.5pt / 700, tracking .12em, uppercase |
| metric figure | 16pt / 600, tabular |
| metric label | 6.5pt / 300, tracking .06em, uppercase, `--ink-70` |
| table cell / figure | 8.5pt / 400 · 600 tabular |
| total row | 9.5pt / 700 |
| docket value, meta | 7–9pt / 300–600 |
| footer, hash | 6.5pt / 300, `--ink-40` |

**Space.** 3 mm base: `1.5mm` cell padding, `3mm` intra-block, `6mm` eyebrow-to-content, `9mm` between sections, `22mm 12mm 16mm` page margin (the top and bottom bands are reserved for the running header and footer).

**Signature — the docket.** A `2pt`-ruled block at the top of page 1 holds only metadata the payload actually owns. Every report can show its report kind, business window and preparation time. Serialized audit documents may additionally show serial, issuer, payload hash and copy state. Daily reports, selected-shift X/Z, Items and Y must never fabricate those fields. When a real copy state exists, it is the only reversed element: `ORIGINAL` sits in a `1.5pt` outline and `REPRINT` is white on solid black.

**Running header and footer.** `position: fixed` repeats them on every page. Header: store name, report kind, business window and the real serial when present, closed by a `2pt` rule. Footer: date, end-marker text and the real payload hash when present. Do not render `page n of m`: native Chromium printing does not expose reliable total-page counters without introducing a pagination engine, and this feature intentionally adds none. The browser's optional native headers remain the user's choice.

**Metric register, not cards.** `grid-template-columns: repeat(4, 1fr)` bounded by hairlines top and bottom, cells divided by `border-inline-start` hairlines, first cell's border removed. No boxes, no radius, no shadow. A ledger book separates columns with rules; the card-with-a-big-number is the dashboard default and is deliberately not used.

**Tables.** `border-collapse: collapse`, real `<table>` markup (never grid or flex — those break `table-header-group`), `th` on `--wash` between two `1pt` rules, `td` on `0.5pt`, totals as the last `tbody` row on `--wash`.

**RTL.** `dir="rtl"` flips the table so the first column sits on the right, and logical properties (`border-inline-start`, `text-align: start|end`, `padding-inline`) make that automatic. Numbers must not flip:

```css
.num { text-align: end; font-variant-numeric: tabular-nums;
       direction: ltr; unicode-bidi: isolate; }
```

`unicode-bidi: isolate` is the part that matters — without it `-32.00 د.أ` reorders to `د.أ 32.00-`. Keep Western digits, as the existing reports do with `data-no-i18n`.

**Consistency contract with thermal.** Testable, and this is what "consistent" means here:

| carries across | deliberately differs |
| --- | --- |
| section order, identical | thermal: one label/value column; A4: metric register + true columns |
| headings verbatim (Arabic for audit/Items/Y, English for X/Z) | A4 adds per-page running identity |
| 2-dp money, same currency mark | A4 prints every ledger row, thermal summarises |
| solid = major, dashed = minor | A4 scopes rules to their table; thermal spans full width |
| real serial, hash, ORIGINAL/REPRINT when supplied | thermal once at top; A4 in the docket and running bands when supplied |
| — | thermal keeps the spooler's Tahoma/Helvetica stacks; A4 uses IBM Plex Sans Arabic |

A working reference mock of this system, both scripts, is at `docs/superpowers/evidence/2026-08-23-a4-report-design.html`. Open it and press Ctrl+P to see the paged result.

Run:

```powershell
npx vitest run src/admin/composables/__tests__/useBrowserReportPrint.spec.js src/print/__tests__/reportPrintBranches.spec.js src/print/__tests__/adminReportPrintDesign.spec.js
```

Expected GREEN: all focused transport, exact-thermal, and detailed-A4 tests pass.

- [ ] **Step 7: Commit Task 1.**

```powershell
git add src/admin/composables/useBrowserReportPrint.js src/admin/composables/__tests__/useBrowserReportPrint.spec.js src/print/PrintReceiptApp.vue print_receipt.html src/print/AdminReportA4.vue src/print.css src/print/__tests__/reportPrintBranches.spec.js src/print/__tests__/adminReportPrintDesign.spec.js
git commit -m "feat(admin): add browser report print preview"
```

---

## Task 2: Return Report Payloads Instead of Queueing Spooler Jobs

**Files:**

- Create: `backend/services/printStoreInfo.js`
- Modify: `backend/services/auditReportBuilder.js`
- Modify: `backend/routes/print.js` *(import the shared allowlist — preserve the router export and route behaviour)*
- Modify: `backend/routes/admin/auditReports.js`
- Modify: `backend/services/categoryItemsReportBuilder.js`
- Modify: `backend/tests/integration/printPayloadSecrets.test.js`
- Modify: `backend/tests/integration/auditReports.test.js`
- Modify: `backend/tests/integration/categoryItemsReport.test.js`
- Modify: `backend/tests/integration/yHeldItemsReport.test.js`
- Modify: `backend/tests/manual/redactPrintPayloadSecrets.js`
- Create: `backend/migrations/2026-08-23-audit-browser-preview.sql` *(dated evidence migration)*
- Create: `backend/migrations/2026-08-23-audit-browser-preview-v1.auto.sql`
- Create: `backend/migrations/2026-08-23-audit-browser-preview-v1.preflight.sql`
- Modify: `backend/migrations/auto-manifest.json`
- Modify: `deployment/database/hostinger-manual-migrations.sql`
- Modify: `deployment/database/baseline.sql`
- Modify: `backend/tests/fixtures/seed.js`
- Create: `backend/tests/unit/auditBrowserPreviewMigration.test.js`

- [ ] **Step 0: Stop these payloads carrying credentials. Do this before anything returns a payload to a browser.**

Move the existing allowlist out of the print route into one small shared service. `backend/routes/print.js` must continue exporting the Express router directly because `server.js` and existing tests require that shape:

```js
// backend/services/printStoreInfo.js
const PRINT_STORE_INFO_KEYS = [
    'store_name', 'store_address', 'store_phone',
    'receipt_config', 'tax_inclusive_pricing'
];

async function getPrintStoreInfo(executor) {
    return getSettings(executor, PRINT_STORE_INFO_KEYS);
}

module.exports = { PRINT_STORE_INFO_KEYS, getPrintStoreInfo };

// backend/services/auditReportBuilder.js
async function getStoreInfo(executor) {
    return getPrintStoreInfo(executor);
}
```

Then extend `backend/tests/manual/redactPrintPayloadSecrets.js`, which today covers only `print_queue.payload`, to redact the same extra keys from `audit_report_documents.payload_json` and `master_held.report_payload`. Redact, do not delete: those rows remain the recovery/reprint source, and only the extra settings keys go.

Two consequences to handle rather than discover:

- **Audit hashes must remain truthful.** `cacd5dc7` could leave `print_queue.payload_hash` stale because its reprint path rebuilds and re-hashes. Audit reprints do not: they replay `payload_json` with the stored `payload_hash`. For each changed `audit_report_documents` row, remove the extra settings, recompute the canonical hash with `auditReportBuilder.hashPayload`, write that hash into both `payload_json.payload_hash` and the `payload_hash` column in the same transaction, and append an `audit_report.credentials_redacted` audit event containing only the old and new hashes. `master_held.report_payload` has no audit hash and only needs the allowlist redaction.
- **A reprint reads `payload_json` from the database**, so a document issued before this fix still carries the credential until the redaction runs. Run it as part of the same deployment.

RED test: extend `backend/tests/integration/printPayloadSecrets.test.js` to issue an X audit, an Items report and a Y report, and assert that no returned or stored payload contains `secret_key` or `client_id`, and that `storeInfo` has exactly the five allowlisted keys. Confirm it fails first — on `f07163a2` it will, with 41 keys.

The credentials still need rotating in the JoFotara portal. Removing the copies does not undo the exposure.

- [ ] **Step 1: Write RED route tests for delivery independence.**

Change focused integration expectations so every successful admin report response contains its canonical payload under `print_payload` and creates zero new `print_queue` rows:

```js
expect(res.body.print_payload.print_type).toBe('audit_report');
expect(Number(queued)).toBe(0);
```

Cover:

- original X and Z issuance;
- same-date Z reprint reuses the same immutable document and increments `reprint_count`;
- period audit;
- single-date and period Items;
- Items payloads include server-built A4 summary values (`product_count`, `total_quantity`, `gross_revenue`) without changing existing category/item totals;
- Y succeeds with no configured printer, archives/deletes exactly once, returns the exact archived payload, and still emits the held-order change;
- Y active-claim and no-orders failures remain unchanged;
- `GET /api/admin/audit-reports/y-archives/:id/print-payload` returns the saved payload only for a current, unexpired, unrestored archive and changes no rows;
- an expired, restored, missing, or non-integer archive id cannot return a payload;
- legacy `auditPrintStatus` tests remain green for old queued jobs.

Run the affected tests and confirm RED because routes still dispatch:

```powershell
npx vitest run backend/tests/integration/auditReports.test.js backend/tests/integration/categoryItemsReport.test.js backend/tests/integration/yHeldItemsReport.test.js
```

- [ ] **Step 2: Add the truthful audit status value.**

**This step's SQL is written by the `luna_max` agent** (`.codex/agents/luna-max.toml`) per `CLAUDE.md`, not by the executing agent. Luna does not decide scope, approve, merge, push or touch a production database; the main agent gathers the evidence, requests approval, and independently verifies the output.

Append, never reorder, `browser_ready`:

```sql
ENUM('queued','printed','failed','browser_ready') NOT NULL DEFAULT 'queued'
```

The preflight must accept exactly the current enum or the already-upgraded enum and reject unrelated drift. Update the baseline (`deployment/database/baseline.sql:179`) and test fixture (`backend/tests/fixtures/seed.js:275`) in the same commit. The manifest entry is the successor of `2026-08-17-spooler-v2-agents-v1`, checksum `e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985` — verified as the current manifest tail — with checksums generated from the final bytes, never typed from this plan. Then append the exact approved Hostinger-safe block, verbatim and not a rewrite, to `deployment/database/hostinger-manual-migrations.sql` between its `-- BEGIN/END AUTO MIGRATION` markers. Do not touch production data manually.

**Make the status write unable to break a report.** Nothing surfaces this column — `/audit-reports/status` at `auditReports.js:153` does not select it. Insert new documents using the existing/default `queued` value, commit the immutable document, and only then perform a separate best-effort `browser_ready` update. For a reprint, update `reprint_count`, requester and request time in an old-schema-compatible statement first, then perform the separate status update. If the enum migration has not landed, only that bookkeeping statement may warn and fail; issuing/reopening the payload and the durable reprint count must still succeed. Once migrated, every newly prepared browser document ends as `browser_ready`.

The unit test must verify manifest predecessor/checksum/file hashes, preflight presence, fallback-block parity with the `.auto.sql`, baseline parity, fixture parity, and append-only enum ordering.

- [ ] **Step 3: Replace dispatch with payload preparation.**

In `auditReports.js`:

- Remove `dispatchReceiptPrint` and `resolveReceiptPrinter` imports from this route.
- Replace `queueAuditPrint` with a pure payload normalizer plus the minimal audit-document update.
- For original/reprinted serialized reports, attach `audit_report_document_id`, `copy_label`, and the stored `payload_hash`; update durable request metadata and increment `reprint_count` only for a true reprint in an old-schema-compatible statement, then separately attempt `last_print_status='browser_ready'` and clear `last_print_error`.
- Insert new serialized documents with the existing/default `queued` value, commit, then perform the same best-effort `browser_ready` transition. Do not place the new enum literal inside the serial-issuing transaction.
- Return `{ success: true, document, print_payload, message }` only after the document transaction commits.
- Period and Items routes return their builders' payload directly and never inspect printer configuration.
- `buildCategoryItemsReportPayload` adds a `summary` derived once from its canonical `items` array: product row count, decimal-safe total quantity, and rounded gross revenue. Do not recompute these financial totals in Vue.
- Y removes the printer precondition, preserves its transaction byte-for-byte through commit, then returns the exact payload stored in `master_held.report_payload`.
- The read-only Y archive payload endpoint parses the saved payload and never invokes the builder again.

Do not rename endpoints in this change; cached admin bundles may still call the existing URLs during a server update.

- [ ] **Step 4: Run focused GREEN tests.**

```powershell
npx vitest run backend/tests/unit/auditBrowserPreviewMigration.test.js backend/tests/integration/auditReports.test.js backend/tests/integration/categoryItemsReport.test.js backend/tests/integration/yHeldItemsReport.test.js backend/tests/integration/spoolerV2Sync.test.js
```

The single spooler sync file is included because it owns legacy audit ACK status. Do not run other spooler suites.

- [ ] **Step 5: Commit Task 2.**

```powershell
git add backend/services/printStoreInfo.js backend/services/auditReportBuilder.js backend/routes/print.js backend/tests/integration/printPayloadSecrets.test.js backend/tests/manual/redactPrintPayloadSecrets.js
git commit -m "fix(reports): stop audit payloads carrying every settings row"

git add backend/routes/admin/auditReports.js backend/services/categoryItemsReportBuilder.js backend/tests/integration/auditReports.test.js backend/tests/integration/categoryItemsReport.test.js backend/tests/integration/yHeldItemsReport.test.js backend/tests/integration/spoolerV2Sync.test.js backend/migrations/2026-08-23-audit-browser-preview.sql backend/migrations/2026-08-23-audit-browser-preview-v1.auto.sql backend/migrations/2026-08-23-audit-browser-preview-v1.preflight.sql backend/migrations/auto-manifest.json deployment/database/hostinger-manual-migrations.sql deployment/database/baseline.sql backend/tests/fixtures/seed.js backend/tests/unit/auditBrowserPreviewMigration.test.js
git commit -m "refactor(admin): return browser report payloads"
```

Step 0 commits separately: it is a security fix that stands on its own and should be cherry-pickable to a release branch without the rest of this feature.

---

## Task 3: Switch the Shared Daily Reports Action to Browser-Only Printing

**Files:**

- Create: `src/admin/components/ReportPrintMenu.vue`
- Create: `src/admin/components/__tests__/reportPrintMenu.spec.js`
- Modify: `src/admin/components/ReportsLayout.vue`
- Delete: `src/admin/composables/useThermalReportPrint.js`
- Modify: `src/admin/pages/__tests__/dailyReportsNavigation.spec.js`
- Modify: `src/admin/pages/__tests__/dailyReportsLocalization.spec.js`
- Modify: `src/shared/i18n/ar.json`

- [ ] **Step 1: Write the RED Daily Reports contract.**

Update tests to require:

- one shared, plainly labeled Print dropdown;
- exactly two choices: `Thermal (80mm)` and `Detailed A4`;
- no saved paper/layout preference and no Settings dependency;
- use of `useBrowserReportPrint`;
- no import/reference to `useThermalReportPrint`;
- all four existing provider pages remain registered;
- Arabic keys exist for “Print”, preview preparation, popup blocked, and preview failure.

Run:

```powershell
npx vitest run src/admin/pages/__tests__/dailyReportsNavigation.spec.js src/admin/pages/__tests__/dailyReportsLocalization.spec.js src/admin/pages/__tests__/dailyReportPayloads.spec.js
```

Expected RED: the layout still has a single 80mm-only button and imports the spooler-aware composable.

- [ ] **Step 2: Build the shared accessible dropdown.**

`ReportPrintMenu.vue` has one responsibility and one emitted event:

```vue
<ReportPrintMenu
  :label="$t('Print')"
  :disabled="!reportSupported"
  :busy="isPrinting"
  @select="printReportLayout"
/>
```

```js
emit('select', 'thermal');
emit('select', 'a4');
```

Render one compact menu trigger: the existing report label plus a caret inside the same button width. Clicking anywhere on it opens the two layout choices; there is no undocumented default action and no separate split-button segment. This preserves the dense Shifts toolbar while matching the user's requirement that every report button is a dropdown. Accept a `variant` prop so each caller keeps the emphasis it has today (`admin-grid-button--dark`, `--primary`, `--soft`, plain).

It must use a normal button with `aria-haspopup="menu"`/`aria-expanded`, menu items with visible labels and concise descriptions, close after selection, close on Escape/outside click, restore focus to the trigger, and be reachable by keyboard in both text directions (the caret sits at the inline end, so use logical properties). It owns no printing or report state.

- [ ] **Step 3: Wire the existing providers to `printReport`.**

Keep `registerDailyReportPrint` and all four page payload builders. In `ReportsLayout.vue`, rename thermal-only local state (`thermalSupported`, `printThermal`) to neutral report terms and call `printReport(layout, printProvider.value)`. The menu remains disabled when the active page has not registered a payload or a preview is already being prepared.

Delete `useThermalReportPrint.js`; no code should retain its method/printer branch.

- [ ] **Step 4: Run GREEN tests and commit.**

```powershell
npx vitest run src/admin/components/__tests__/reportPrintMenu.spec.js src/admin/pages/__tests__/dailyReportsNavigation.spec.js src/admin/pages/__tests__/dailyReportsLocalization.spec.js src/admin/pages/__tests__/dailyReportPayloads.spec.js src/admin/composables/__tests__/useBrowserReportPrint.spec.js
git add src/admin/components/ReportPrintMenu.vue src/admin/components/__tests__/reportPrintMenu.spec.js src/admin/components/ReportsLayout.vue src/admin/composables/useThermalReportPrint.js src/admin/pages/__tests__/dailyReportsNavigation.spec.js src/admin/pages/__tests__/dailyReportsLocalization.spec.js src/shared/i18n/ar.json
git commit -m "refactor(admin): print daily reports in browser"
```

---

## Task 4: Switch Every Shifts Report Button and Close the Boundaries

**Files:**

- Create: `backend/services/shiftReportPayload.js`
- Modify: `backend/routes/print.js`
- Modify: `backend/routes/admin/auditReports.js`
- Modify: `backend/tests/integration/print.test.js`
- Modify: `src/admin/pages/Shifts.vue`
- Modify: `src/admin/pages/__tests__/shiftsPage.bugfix.spec.js`
- Modify: `src/admin/pages/__tests__/shiftsPage.quality.spec.js`
- Modify: `src/shared/i18n/ar.json`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

- [ ] **Step 0: Keep the selected-shift X/Z payload server-built.**

The X/Z document is not the numbers the Shifts list happens to hold. `backend/routes/print.js:836-931` throws away what the client posts and rebuilds it from the database — refund-netted gross/cash/card/platform, `getShiftDiscountsByShift`, `getCashExpensesByShift`, `getCashExpenseCategoriesByShift`, `getSubscriptionCollectionsByShift`, live expected cash and a per-order-type breakdown — and it enforces admin-or-shift-owner at `:854-858`. A list row carries none of the expense or subscription figures and may be minutes stale.

Extract that block, unchanged, into `backend/services/shiftReportPayload.js`:

```js
// returns the same object print.js builds today, or throws { statusCode }
async function buildShiftReportPayload(pool, { shiftId, printType, user, storeInfo })
```

Call it from `print.js` exactly where the inline block was — the operational route's behaviour must not change by one field — and from a new read-only admin endpoint that returns the payload and prints nothing:

```
GET /api/admin/shift-reports/:shiftId/print-payload?type=x_report|z_report
→ { success: true, print_payload }
```

Keep the same authorisation check and the same 400/403/404 codes. This endpoint is the provider for the selected-shift dropdown.

A pure-extraction test: for a seeded shift, the object from `buildShiftReportPayload` deep-equals what `POST /api/print/print` dispatches for the same shift.

- [ ] **Step 1: Write RED Shifts-page tests.**

Require that `Shifts.vue`:

- imports and uses `useBrowserReportPrint`;
- renders `ReportPrintMenu` for selected-shift X/Z and for official X, Z, period, Items, Y, and Reopen last Y actions, with both layout choices reaching the corresponding provider;
- contains no `pos_receipt_printer_id`, no `api/print/print`, and no “queued for printing” success copy in its report functions;
- sends no printer id to official X/Z, period, Items, or Y endpoints;
- returns each endpoint's `print_payload` from the provider passed to `printReport(layout, provider)`;
- fetches the selected-shift X/Z payload from `GET /api/admin/shift-reports/:shiftId/print-payload` and never assembles shift money in Vue — assert that `printShiftReport` contains no `gross_sales:`, `expected_cash:` or `order_type_breakdown:` object literal;
- starts the preview helper directly from the Y layout-menu click, then performs Y confirmation inside the async provider after the popup handshake and before the destructive POST;
- exposes “Reopen last Y” via the read-only archive payload endpoint;
- no longer auto-calls `printShiftReport()` after force close;
- retains the Z open-shift disable rule and all Y restore controls.

Also add a hard scope assertion that `Orders.vue` still contains both `reprintReceipt` and `reprintDirect` plus its `pos_receipt_printer_id` path. This is a regression boundary, not an instruction to edit Orders.

Run:

```powershell
npx vitest run src/admin/pages/__tests__/shiftsPage.bugfix.spec.js src/admin/pages/__tests__/shiftsPage.quality.spec.js src/admin/pages/__tests__/ordersSetupBindings.spec.js
```

- [ ] **Step 2: Wire all Shifts report actions.**

The Shifts audit toolbar (`Shifts.vue:121-144`) is a right-aligned wrapping row of compact `admin-grid-button`s, one of which is a 9-unit-wide `Y`. `ReportPrintMenu` therefore keeps each existing button's footprint: label and caret share one trigger and clicking either opens the same two-item menu. Match `admin-grid-button` and its `--dark`/`--primary`/`--soft` variants so each report keeps the emphasis it has today.

Use one `printReport` instance and the shared dropdown for:

- selected shift X/Z;
- official serialized X/Z;
- period audit;
- Items;
- Y;
- reopening the last Y archive.

Each dropdown emits the selected layout into its existing report function; do not duplicate each report button into separate thermal/A4 buttons. For Y specifically, call `printReport(layout, provider)` immediately from that selection event so the popup is not blocked; the provider asks for confirmation and returns exactly `false` without POSTing when declined, and the helper closes the unused popup without showing an error. Remove printer fields and queued alerts. A successful provider handoff needs no “printed” alert because the browser preview is visible. Keep failures actionable and localized. After force close, refresh and close the modal without auto-printing; the explicit Z action remains available.

- [ ] **Step 3: Update architecture truthfully.**

In `docs/architecture.json`:

The flows that exist today and are the ones to touch: `flow-daily-report`, `auth-flow-shift-open-close-zreport`, `flow-y-report-archive`. Leave `flow-audited-reprint` and `flow-guest-check-print` alone.

- rewrite `flow-daily-report` from conditional browser/spooler delivery to browser-only preview;
- rewrite the audit/shift-report delivery steps in `auth-flow-shift-open-close-zreport` to authenticated payload return plus browser preview, and add the new shift-report payload endpoint;
- keep official Z serialization and X/Z audit document persistence;
- keep `flow-y-report-archive` as the transactional server flow and add the read-only archive reopen edge;
- record the narrowed `getStoreInfo` on the audit-builder node — it is an invariant now, not an implementation detail;
- leave `flow-audited-reprint` and Orders History edges unchanged;
- do not remove spooler report rendering nodes because they still serve legacy queued jobs.

Regenerate, never hand-edit, HTML:

```powershell
npm run architecture
npm run architecture:check
```

- [ ] **Step 4: Focused verification and build.**

```powershell
npx vitest run src/admin/components/__tests__/reportPrintMenu.spec.js src/admin/composables/__tests__/useBrowserReportPrint.spec.js src/print/__tests__/reportPrintBranches.spec.js src/print/__tests__/adminReportPrintDesign.spec.js src/admin/pages/__tests__/dailyReportsNavigation.spec.js src/admin/pages/__tests__/dailyReportsLocalization.spec.js src/admin/pages/__tests__/dailyReportPayloads.spec.js src/admin/pages/__tests__/shiftsPage.bugfix.spec.js src/admin/pages/__tests__/shiftsPage.quality.spec.js src/admin/pages/__tests__/ordersSetupBindings.spec.js backend/tests/unit/auditBrowserPreviewMigration.test.js backend/tests/integration/auditReports.test.js backend/tests/integration/categoryItemsReport.test.js backend/tests/integration/yHeldItemsReport.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/printPayloadSecrets.test.js backend/tests/integration/print.test.js
npm run build:admin
npm run architecture:check
```

- [ ] **Step 5: Manual browser acceptance.**

Test with global `print_method=spooler`, no local receipt-printer id, and the spooler stopped:

1. Summary, Sales Breakdown, Refunds & Voids, and Expenses each expose the same two layout choices and open native preview.
2. Choose Thermal (80mm), then an 80mm printer/paper in the browser dialog: output matches the approved spooler design without clipping or horizontal overflow.
3. Choose Detailed A4, then an A4 printer/paper in the browser dialog: the expanded metrics and full tables use the page width, headings repeat, long ledgers paginate, and rows are not split incorrectly.
4. Official X and Z preserve serial labels/hash/open-shift rules and create no queue rows.
5. Items and Y visually follow the V2 approved hierarchy in RTL.
6. Block popups and retry X/Z/Y: no new audit document and no Y archive/deletion occurs before a print window is ready.
7. Close the Y preview after the archive commits, then use Reopen last Y: the saved payload reopens without deleting or archiving again.
8. Restore last Y still restores the same rows once.
9. Orders History Reprint still follows its existing spooler/audited path.
10. Print one Arabic audit report and one Arabic Items report to paper and check the numerals: `-32.00 د.أ` must read left-to-right with the minus on the left and the currency mark after it. This is what `unicode-bidi: isolate` is for and it is invisible in a screenshot review.
11. Print a selected-shift Z from the modal and a Z audit for the same business date, and reconcile them against the Shifts list row. The three must agree; if the modal's Z differs, the payload is being built client-side somewhere.
12. Print an Items report for a date with more than one page of items: column headings repeat on page 2, no row is split across the fold, and the totals row appears exactly once.

- [ ] **Step 6: Inspect the final diff and commit.**

```powershell
git diff --check
git diff --name-only f07163a2ea09006efcaabc2e9f703727156a6219..HEAD
git diff --name-only
git diff f07163a2ea09006efcaabc2e9f703727156a6219 -- src/admin/pages/Orders.vue src/admin/pages/WaiterPerformance.vue backend/services/printReprint.js
```

The final command must be empty. Then:

```powershell
git add backend/services/shiftReportPayload.js backend/routes/print.js backend/routes/admin/auditReports.js backend/tests/integration/print.test.js src/admin/pages/Shifts.vue src/admin/pages/__tests__/shiftsPage.bugfix.spec.js src/admin/pages/__tests__/shiftsPage.quality.spec.js src/shared/i18n/ar.json docs/architecture.json docs/architecture.html docs/superpowers/evidence/2026-08-23-a4-report-design.html
git commit -m "refactor(admin): print shift reports in browser"
```

---

## Adversarial Exit Gate

The feature is not complete until every answer below is backed by a test or manual observation:

- **Credentials:** Does any returned, posted or stored report payload still contain `secret_key` or `client_id`? `storeInfo` must hold exactly the five allowlisted letterhead keys in the browser message, the response, `audit_report_documents.payload_json` and `master_held.report_payload`; a provider-supplied object is reduced again at the browser boundary.
- **Financial provenance:** Is every figure on every printed report traceable to a server payload field? No task may compute one in Vue, and the selected-shift X/Z must come from the server builder, not the list row.
- **Thermal scale:** Does an 80 mm print of X/Z, audit, Items and Y fit the paper without horizontal clipping? A literal pixel port of the 576-dot reference is about 2.1× too wide and this is how it shows up.
- **Un-migrated database:** With `browser_ready` absent from the enum, does issuing an X audit still return its payload and does a reprint still increment its durable count? Only the separate status update may degrade and warn.
- **Spooler setting:** Does setting the entire installation to spooler mode still leave these exact admin buttons browser-only?
- **No printer:** Can every included report prepare with zero printers configured?
- **Popup failure:** Can a popup blocker create an X/Z serial or delete Y-held orders? It must not.
- **Concurrent tabs:** Can two office tabs exchange or overwrite payloads? The nonce/source/origin checks must prevent it.
- **Large payload:** Does a long report avoid localStorage quota entirely?
- **Y response loss:** Can the last committed Y payload be reopened without repeating its destructive transaction?
- **Audit honesty:** Is `browser_ready` used instead of `printed` or `queued` for new browser previews?
- **Layout choice:** Does every included Print dropdown offer exactly Thermal (80mm) and Detailed A4, without a global or saved setting?
- **Thermal design:** Do X/Z, Items, and Y retain the approved V2 density, hierarchy, separators, RTL, and money precision without dropping newer platform reconciliation?
- **A4 detail:** Does A4 use its width for the complete server-provided detail rather than stretching the thermal receipt or recalculating financial values in Vue?
- **Scope:** Are Orders History, Waiter Performance order reprints, checkout receipts, kitchen tickets, cashier shift closing, operational expense slips, and legacy queue recovery unchanged?

## Definition of Done

- All named Admin Shifts and shared Daily Reports print actions are browser-only even when global printing is configured for spooler.
- Each Print dropdown chooses the thermal or detailed A4 document layout; native preview chooses the physical printer.
- No report payload carries a settings row outside the five-key letterhead allowlist, in transit or at rest; remediated audit documents have matching embedded/column hashes and a durable redaction event.
- Every printed figure comes from a server payload; the selected-shift X/Z uses the same server builder as the operational route.
- Thermal and A4 render inside the existing print application, with no new PDF/export subsystem.
- Thermal X/Z, Items, and Y use the approved V2 report appearance; A4 uses expanded metrics and full ledgers.
- No new queue rows are created by the included admin report routes.
- X/Z/Y state and audit invariants remain intact, including safe Y reopen/recovery.
- Orders History and Waiter Performance order printing are unchanged.
- Focused tests, admin build, architecture check, and manual browser acceptance pass.
