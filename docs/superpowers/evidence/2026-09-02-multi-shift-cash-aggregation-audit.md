# Multi-shift cash aggregation audit

- Repository: `C:\xampp\htdocs\posapp`, branch `master`, commit `552d516f`
- Type: audit-only handoff. No files were modified or executed during the audit.
- Scope: combined Expected Cash / Actual Cash / Starting Cash totals in daily, X, Z, period, A4, thermal, stored audit documents, reprints and API payloads.

## 1. Root cause: confirmed

Closing balances (point-in-time snapshots of one drawer) are summed as if they were financial movements.

| Evidence | Location |
|---|---|
| `expected_cash += exp; actual_cash += act;` for every closed shift in range, emitted as `cash_status.expected_cash / actual_cash / variance` | `backend/services/dailyReportBuilder.js:158-172`, `:185-197` |
| `starting_cash_total`, `expected_cash_total`, `actual_cash_total` are `reduce` sums over `shifts` (period, X and Z) | `backend/services/auditReportBuilder.js:334-344` |
| `shifts` has `user_id` only; no drawer/register/device column; `actual_cash DEFAULT 0.00` (not NULL) | `deployment/database/baseline.sql:288-303` |
| Open-shift guard is per user (`WHERE user_id = ? AND status='open'`); concurrent open shifts by different users are allowed | `backend/routes/auth.js:428-435` |
| Concurrency is intended, not accidental | `backend/tests/integration/shift.test.js:78` ("concurrent first shifts"), `docs/architecture.json:116` |
| Previous-shift drawer reference returns `NULL` while any shift is open because "the schema has no physical-drawer identity" | `backend/routes/auth.js:277-289`, `docs/superpowers/specs/2026-08-31-shift-opening-drawer-reference-design.md:12` |

### Reproduction against the code

Shift 1: 100 -> 400 expected / 400 actual. Shift 2: 400 -> 700 expected / 700 actual. Daily cash sales 600. Final drawer 700.

- `dailyReportBuilder`: `expected_cash=1100`, `actual_cash=1100`, `variance=0`, `state='balanced'`.
- `auditReportBuilder` period: `starting_cash_total=500`, `expected_cash_total=1100`, `actual_cash_total=1100`, `variance_total=0`.
- Period A4 (`src/print/AdminReportA4.vue:533-541`) prints "opening 500 + cash sales 600 + receivables 0 - expenses 0 = expected 1100". Arithmetically self-consistent, which is why it looks right.
- Cash sales (600), overall sales, and every per-shift expected/actual/variance are correct throughout.

### Confirmed distinctions

- Variance cancellation: `sum(actual_i - expected_i)` is a legitimate movement sum, so it stays correct while the two balance columns feeding it are wrong.
- Tax is not involved. `expected_cash = starting + gross cash - cash refunds + receivable cash - drawer expenses` (`backend/routes/auth.js:517`).

### Additional defects in the same sums (not in the original handoff)

1. **Cross-day shifts are counted twice.** The shift selector (`dailyReportBuilder.js:113-139`, `auditReportBuilder.js:87-119`) includes a shift if it opened in range OR closed in range OR had activity in range. A shift opened 22:00 day 1 and closed 08:00 day 2 contributes its full lifetime `expected_cash`/`actual_cash` snapshot to both days.
2. **Per-shift movements are range-scoped, the snapshot is lifetime.** In the audit payload `cash_sales`, `cash_expenses` etc. are filtered by range (`getCashExpensesByShift(..., range)`, `paidOrderTimeSql`), while `expected_cash` for a closed shift is the value stored at close. For a cross-day shift the printed equation `starting + cash + receivables - expenses = expected` does not add up.
3. `cash_status.expected_cash` is emitted even when `state='in_progress'` (partial sum of closed shifts) and printed unconditionally by `src/print/PrintReceiptApp.vue:223` and `pos-spooler-printer/report-html.js:230`.

## 2. Consumer / impact map

### Producers

- `backend/services/dailyReportBuilder.js:189-197` -> `cash_status { state, open_shifts, closed_shifts, shifts_needing_review, expected_cash, actual_cash, variance }`. Also serves multi-day ranges (`start_date..end_date`), so a week view sums 7+ closing balances.
- `backend/services/auditReportBuilder.js:334-344` -> `cash_reconciliation { starting_cash_total, cash_expenses_total, expected_cash_total, actual_cash_total, variance_total }` for X, Z and period.

### Consumers of `cash_status`

| Surface | Location | Behaviour |
|---|---|---|
| API | `backend/routes/admin/reports.js:246` | `GET /api/admin/reports/summary` |
| Admin UI | `src/admin/pages/ReportsSummary.vue:257-260` | Shows Expected/Actual/Variance unless `in_progress`/`no_shifts`; variance `+0.00` rendered teal even when `state='review'` |
| Browser print payload | `src/admin/pages/dailyReportPayloads.js:41` | Pass-through |
| Thermal (browser) | `src/print/PrintReceiptApp.vue:222-233` | Expected Cash printed unconditionally |
| A4 (browser) | `src/print/AdminReportA4.vue:410-418`, `:790` | `CASH_STATUS_FIELDS` |
| Spooler v1 thermal | `pos-spooler-printer/report-html.js:201-233` | Legacy queue path, still accepted by `backend/routes/print.js:385`, `:864` |
| Sanitizer | `backend/routes/print.js:204-210` | Validates `state` only |
| Tests | `backend/tests/integration/dailyReportsSummary.test.js:179`, `dailyReportsAdversarial.test.js:263-266`, `backend/tests/unit/dailyReportPrintContract.test.js:15`, `pos-spooler-printer/tests/report-html.test.js:39`, `src/admin/pages/__tests__/dailyReportPayloads.spec.js:49-76`, `src/print/__tests__/reportPrintBranches.spec.js:46`, `src/print/__tests__/adminReportA4Rendering.spec.js:257` | |

### Consumers of `cash_reconciliation`

| Surface | Location | Behaviour |
|---|---|---|
| Stored evidence | `audit_report_documents.payload_json`, written at `backend/routes/admin/auditReports.js:272-291` | X/Z only. Period reports are never persisted (`:340-346`) |
| Reprints | `backend/routes/admin/auditReports.js:151-168` | Replays stored `payload_json` unchanged |
| A4 non-period X/Z | `src/print/AdminReportA4.vue:315` (`isPerCashierAudit`), `src/print/auditReportPresentation.js` | Already ignores totals; per-shift + `summarizeAuditShifts` verdict |
| A4 period | `src/print/AdminReportA4.vue:51`, `:183`, `:213`, `:512-517`, `:533-541`, `:622-626` | Still foregrounds totals; verdict "balanced" when `variance_total === 0` |
| Thermal (browser) period | `src/print/PrintReceiptApp.vue:475-482` | Totals. Non-period (`:483-490`) already per-shift |
| Spooler v2 renderer | `pos-spooler-printer/v2/artifact-renderer.js:179`, `:224-229` | Totals for every `audit_report` regardless of `is_period`. Dormant (browser preview replaced it) but reachable via queue |
| Tests | `backend/tests/integration/auditReports.test.js:493`, `:676-677`; `src/print/__tests__/adminReportA4Rendering.spec.js:68-73`, `:136-140`, `:218-223` | |

### Not affected (already per-shift)

- `backend/services/dashboardDataBuilder.js:30-38` (per-shift variances only)
- `backend/services/shiftReportPayload.js`, `backend/routes/auth.js` `zreport` (single shift)
- `src/admin/pages/Shifts.vue` (no aggregation)
- `backend/routes/auth.js:277-289` drawer reference (latest single shift; suppressed while any shift is open)

## 3. Drawer identity: nothing safe exists

- The physical drawer is kicked through the receipt printer (`backend/routes/pos/checkout.js:166-187`, `printers.role='receipt'`).
- The POS browser's chosen printer lives in `localStorage.pos_receipt_printer_id` (`src/pos/useTerminal.js:23`), is sent per request, falls back server-side when absent, and is only recorded in `audit_events` for cashier-role drawer pops. It is not on `shifts` or `orders`.
- `spooler_stations`, `webauthn_credentials.device_label` and `printers` identify print infrastructure or browsers, not tills.
- Conclusion: no existing identity can be attached to historical shifts. `printers(role='receipt')` is the natural anchor for a future `register_id`, nothing more.

## 4. Business rules as implemented

- Concurrent open shifts by different users are permitted and tested.
- `first_shift_starting_cash` is suggested to every concurrent opening shift until the first shift closes that business day.
- The drawer reference feature already treats drawer ownership as unknowable while more than one shift may be active.
- Therefore the code neither assumes one shared drawer nor models several; ownership is undefined.

## 5. Adversarial examples

Per-shift values are correct in every case; only the sums are wrong.

| Case | Setup | Summed result | Truth |
|---|---|---|---|
| Sequential, one drawer | 100->400, 400->700 | expected/actual 1100 | drawer 700; overstated by the carried 400 |
| Concurrent, two drawers | A 100->400, B 100->300 | 700 | 700 (correct). "Use the last shift" would give 300 or 400: undercount |
| Overlapping, one drawer | A opens 06:00/100, B opens 10:00/100, both sell | anything | physically unreconcilable; no rule recovers it |
| Mismatched handoff | shift 1 closes 400, manager drops 300 to safe, shift 2 opens 100 -> 400 | expected 800 | drawer 400 + safe 300; float counted twice; no `cash_movements` row explains the 300; an equality chain heuristic silently falls back to "independent" |
| Open shift | shift 1 400/400, shift 2 open | `cash_status.expected_cash=400` while `in_progress`; audit `expected_cash_total` = 400 + live expected of shift 2 | not a final figure |
| Expense | shift 1 100+300-50=350/350; shift 2 350->650/650 | 1000 | 650. `cash_expenses_total=50` is a legitimate movement sum |
| Cross-shift refund | shift 2 refunds 20 cash on a shift-1 order (`refunds.shift_id=2`) | 350+630=980 | per-shift correct (shift 2 expected 630) |
| Receivable collection | 50 cash collected in shift 2 | 700 | per-shift correct |
| Starting-cash edit | admin edits shift 2 float to 380 after orders (`auth.js:547-616`) | chain breaks | audited via `shift_cash_edited` |
| Opposite variances | +4 and -4 | daily `state='review'` but card shows `+0.00` teal (`ReportsSummary.vue:260`); period A4 says balanced (`AdminReportA4.vue:515`) | two shifts need review |
| Multi-day | 7-day summary; or one 22:00->08:00 shift | 14 balances summed; the cross-day shift lands in both days | meaningless |

## 6. Recommended accounting semantics

Rule: a balance (starting, expected, actual) belongs to exactly one shift and is never added to another shift's balance: not within a day, not across days, not across drawers. Only movements and counts aggregate.

May be summed: `cash_sales` net of refunds (already `summary.cash_collected` / `payments.cash_sales`), receivable cash collections, drawer `cash_expenses`, signed variances (as a movement), counts.

### Proposed fields

`cash_status` (daily):

- keep `state`, `open_shifts`, `closed_shifts`, `shifts_needing_review`
- add `net_variance` (signed sum; `null` while any included shift is open), `shortage_total` (abs sum of negative variances), `overage_total`
- remove `expected_cash`, `actual_cash`; drop `variance` in favour of `net_variance` so no consumer silently keeps reading the old key
- attribute a shift's variance to the business day of `closed_at` only (fixes the double count)

`cash_reconciliation` (audit X/Z/period):

- keep `cash_expenses_total`
- add `net_variance_total`, `shortage_total`, `overage_total`, `shifts_needing_review`, `open_shifts`, `uncounted_shifts`
- remove `starting_cash_total`, `expected_cash_total`, `actual_cash_total`, `variance_total`
- everything a verdict needs is already computed client-side by `summarizeAuditShifts`; moving it server-side lets the period path share it

### Display when drawer ownership is unknown (always, today)

Per-shift table, counts, net over/short with gross shortage and overage side by side, and one line of copy: "Balances are shown per shift. The system does not track physical drawers, so opening, expected and counted cash are not combined." No dash placeholder for a combined balance; the row should not exist.

## 7. Solution directions compared

| Direction | Verdict |
|---|---|
| Remove combined balances; per-shift reconciliation + variance aggregates | Correct in every case above; loses nothing truthful; smallest diff. **Recommended.** |
| Derive a sequential chain when shifts do not overlap and next `starting_cash == previous actual_cash` | Reject. Fails mismatched handoff, starting-cash edits, coincidental equality; when it works the result equals the last shift's `actual_cash`, which is already visible in the last row. Adds a false-precision failure mode. |
| Explicit drawer/register identity | Only correct if cash movements between shifts (drops, pickups, float adjustments) are also recorded; otherwise mismatched handoffs still break. A feature, not a fix. Defer until a consumer needs "cash currently in tills" or true multi-register operations. |
| Staged | Do direction 1 now; direction 3 only on demonstrated need. Direction 1 is not a stopgap; it is the correct model for the data the schema has. |

## 8. Smallest safe fix

1. `backend/services/dailyReportBuilder.js:152-197` and `backend/services/auditReportBuilder.js:334-344`: replace balance sums with the fields in section 6.
2. Period renderers: `src/print/AdminReportA4.vue:51, 183, 213, 512-541, 622-626` and `src/print/PrintReceiptApp.vue:475-482` reuse the existing per-cashier blocks for `is_period` too (the `isPerCashierAudit` split becomes unnecessary; one path). `pos-spooler-printer/v2/artifact-renderer.js:224-229` same.
3. Daily summary renderers: `src/admin/pages/ReportsSummary.vue:257-260`, `src/print/PrintReceiptApp.vue:222-230`, `src/print/AdminReportA4.vue:410-418`, `pos-spooler-printer/report-html.js:230-232`.
4. Update the tests listed in section 2 and add those in section 10.

### Migration and backward compatibility

- No schema change, no migration, no rewrite of `audit_report_documents`.
- Stored X/Z documents keep their legacy `cash_reconciliation` keys in JSON and their `payload_hash` remains valid; the non-period renderer already ignores those keys, so reprints are already correct today.
- Daily summary and period reports are computed on request, so history is corrected the moment the builder changes.
- New documents get a new payload shape and hash, which is normal for a new issuance.
- Renderers must tolerate both shapes: missing new keys on old documents render as dashes, never zeroes.

## 9. Ideal long-term model (only on demonstrated need)

- `registers` table (may reference `printers.id`), nullable `shifts.register_id`.
- `cash_movements (shift_id, kind ENUM('drop','pickup','float_adjust'), amount, user_id, created_at)`.
- One open shift per register via the existing generated-column trick (`spooler_agents.active_station_key`, `baseline.sql:695-697`): `open_register_key = IF(status='open', register_id, NULL)` + UNIQUE.
- Per-register aggregate = first opening float + cash movements - drops + pickups, reconciled against the last count.
- Historical shifts stay `register_id NULL` and remain per-shift only; nothing is backfilled.
- Post-floor migration under the Luna workflow (`.auto.sql`, manifest entry, fallback parity), per `CLAUDE.md`.

## 10. Tests that prove the fix

- `backend/tests/integration/dailyReportsSummary.test.js`
  - two sequential closed shifts 100->400/400 and 400->700/700: `cash_status` has no `expected_cash`/`actual_cash`; `closed_shifts=2`; `net_variance=0`; `state='balanced'`; `summary.cash_collected=600`
  - +4 / -4: `state='review'`, `shifts_needing_review=2`, `net_variance=0`, `shortage_total=4`, `overage_total=4`
  - one closed, one open: `net_variance=null`, no balance fields, `state='in_progress'`
  - cross-day shift (opened day 1 22:00, closed day 2 08:00, variance -3): day 1 `closed_shifts=0`, `net_variance=0`; day 2 `net_variance=-3`; a two-day range reports -3 once
- `backend/tests/integration/auditReports.test.js`
  - period payload for the sequential pair with a 50 drawer expense: `cash_reconciliation` lacks starting/expected/actual totals; `cash_expenses_total=50`; `net_variance_total`, `shortage_total`, `overage_total` populated; `payload_hash` stable when rebuilt from the same data
- `src/print/__tests__/adminReportA4Rendering.spec.js`
  - period fixture 100/400/700: text never contains `1,100.00` or `500.00`; contains two `رصيد الافتتاح`; +4/-4 period verdict is review, not balanced
- `src/print/__tests__/reportPrintBranches.spec.js:46`: extend the removed-field list with `cash_status?.expected_cash`, `cash_status?.actual_cash`, `cash_reconciliation?.expected_cash_total`, `cash_reconciliation?.actual_cash_total`, `cash_reconciliation?.starting_cash_total`
- `pos-spooler-printer/tests/report-html.test.js` and the v2 renderer test: no combined Expected/Actual line in output
- Reprint regression: insert an old-shape `payload_json` with the legacy totals (pattern at `backend/tests/integration/printPayloadSecrets.test.js:154-169`); assert the reprint renders per-shift and the stored hash is untouched

## 11. Must not be summed

`shifts.starting_cash`, `shifts.expected_cash`, `shifts.actual_cash`, and `previous_shift_closing_cash`: across shifts, across drawers, across business days, and never the same shift into two days.

Everything else in the payload (cash sales, refunds, receivable collections, drawer expenses, variances, counts) is a movement or a count and may aggregate.
