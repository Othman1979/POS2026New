# Business timezone correction

## Confirmed defects

- A checkout schedule such as `2026-09-09T18:30` was interpreted through the Node host timezone in printing. UTC hosting displayed 21:30; a New York host could display 01:30 the next day.
- mysql2 decoded the business-local `orders.delivery_date` DATETIME as a UTC event. Reopening it could shift 18:30 to 21:30 even on a local deployment.
- Order-board future scheduling compared a business-local schedule against UTC `NOW()`.
- Several event-time displays and print fallbacks used device-local parsing or raw UTC text. POS startup did not load the configured business clock.
- JoFotara automatic-submission cutoffs parsed timezone-free UTC SQL text in the host timezone. Newly built issue dates and Operations date labels used the UTC calendar date. Operations and audit calendar filters used UTC midnight instead of venue midnight.
- Subscription/remittance defaults used calendar midnight instead of their backend's business-day cutoff. The persistent report header did not advance at that cutoff.

## Contract and correction

Actual events remain UTC. `parseBackendTimestamp` makes timezone-free SQL event strings explicitly UTC; browser and print formatters display those instants using the configured business offset. Date-only values remain date-only.

Schedules remain business-local clock fields, validated and stored without conversion. mysql2's field-specific cast returns `delivery_date` as a string while other DATETIME fields remain UTC Dates. Checkout, held-order restoration, order details, the order board and printing follow this distinction.

Operational dates retain the configured automatic cutoff (default 06:00). Calendar issue/audit filters use local midnight converted to UTC and an exclusive next-midnight endpoint. Indexed timestamp columns remain bare in predicates. No new tables, dependencies, per-row queries or data-rewriting migration were added.

Queued print payloads include the server's business clock; standalone spooler fallbacks use it rather than Windows timezone. The new helper is included in the installer source allowlist. Report rollover uses one timer for the next boundary and a focus refresh; historical selections are preserved.

## Verification

- Initial regression reproduced the incorrect DATETIME wire representation and schedule handling before the fixes.
- Focused isolated backend run: **13 files, 185 tests passed**, covering scheduled checkout, held/call-center orders, business dates, database pool options, receipt model/compiler and JoFotara.
- After calendar-filter corrections: **2 integration files, 48 tests passed**. Real database/API tests cover paid checkout → database → order details/order board, invalid schedules, future scheduling, and inclusive/exclusive midnight filtering. This overlaps the earlier run; the counts are not additive.
- Final complete frontend run: **100 files, 596 tests passed**. Includes automatic business-day rollover, preserved historical periods, scheduled/event formatting and report printing. Two former print expectations were corrected from raw UTC to venue time.
- Built UI/API browser acceptance: UTC and America/New_York servers, each with Asia/Amman, UTC and America/New_York browser contexts. All **six combinations** stored `2026-09-09 18:30:00` and reopened checkout as `2026-09-09T18:30`, with no page errors. Screenshots are captured after the customer-panel transition finishes.
- Spooler business-time tests passed across three host timezones; render-document and spooler-report-rendering checks passed.
- Production frontend build, architecture generation/check and whitespace check passed.

Reproduce the browser check with `node scripts/reviews/scheduled-timezone-browser.cjs`; set `POSAPP_REVIEW_TIMEZONE=America/New_York` for the second server timezone. It creates and removes only its own guarded loopback fixture. Logs, screenshots and JSON are under ignored `scratch/timezone-*`.

## Deployment boundary

This is local source/build verification, not a Hostinger deployment or physical-printer certification. The server must restart with the new pool configuration; affected spoolers need the updated source/package. Existing saved timestamps, submitted JoFotara snapshots, print artifacts and historical schedules were not rewritten. Previously saved user edits that already contain an incorrect clock value cannot safely be inferred and repaired automatically.

The existing configured fixed business offset remains authoritative; this change does not introduce automatic daylight-saving rules for other countries. Earlier ingredient wording changes and local Codex configuration were preserved separately from this task.
