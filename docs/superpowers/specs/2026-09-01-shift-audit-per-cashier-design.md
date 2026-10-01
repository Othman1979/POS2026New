# Shift audit per-cashier reconciliation design

## Goal

Make the business-day X and Z audit reports on the Shifts page explain how each cashier performed. Daily sales remain a business-day total, while drawer reconciliation is shown separately for every included shift. All report timestamps use the configured restaurant business time and a 12-hour clock.

## Scope

This design applies only to the top-level `Print X Report` and `Print Z Report` actions in `src/admin/pages/Shifts.vue`, whose payload type is `audit_report`.

It does not change:

- the single-shift X/Z action inside the shift details modal;
- checkout, refunds, expenses, shift closing, or financial calculations;
- Daily Reports, Order History, Items, Y, or period-report behavior;
- the spooler or any printer transport;
- the stored audit-document schema or migration chain.

## Existing authority

`backend/services/auditReportBuilder.js` remains the financial authority. Its `shifts` array already carries, per shift:

- cashier, status, opening time, and closing time;
- order count, gross sales, tax, cash, card, and platform sales;
- receivable cash and card collections;
- discounts, refunds, voids, and cash expenses;
- starting, expected, actual, and variance amounts.

The current defect is in presentation. For non-period X/Z documents, `src/print/PrintReceiptApp.vue` and `src/print/AdminReportA4.vue` foreground `cash_reconciliation.*_total`. Summing starting, expected, and actual drawer balances across sequential shifts double-counts carried cash. Netting shift variances can also hide a shortage behind an equal surplus.

The aggregate fields remain in the payload for stored-document compatibility, but non-period browser A4 and thermal X/Z audit reports must not present them as one physical drawer result. The period report remains outside this change.

## Report structure

### Business-day summary

Print once for the selected business date:

- total orders;
- sales including tax, pre-tax sales, and tax collected;
- payment-method totals;
- discounts, refunds, voids, platform reconciliation, and order-type totals.

These are legitimate business-day aggregates and remain unchanged.

### Per-shift reconciliation

Print one clearly bounded section per shift, ordered by `opened_at` and then shift ID. Each section shows:

1. Shift ID, cashier, status, opened time, and closed time.
2. Order count, sales including tax, and tax collected.
3. Cash, card, platform, and receivable collections.
4. Discounts, refunds, voids, and drawer expenses.
5. The drawer equation: starting cash + net cash sales + receivable cash collections - drawer expenses = expected cash.
6. Actual cash and that shift's shortage or surplus.

An open shift shows the current expected cash, a dash for actual cash and variance, and an explicit `not closed` state. Missing values are never coerced to zero.

The A4 layout uses a readable ledger block for each cashier and avoids splitting a block across pages where the browser supports it. The thermal layout prints the same facts sequentially with one divider between cashiers. Neither layout prints a combined starting-cash, expected-cash, or actual-cash total.

## Audit verdict

For non-period X/Z reports, the report-level verdict is derived from individual shift states:

- any open shift: closing is incomplete;
- any closed shift without actual cash: cash count is incomplete;
- any individual non-zero variance: manager review is required, with the number of affected shifts;
- only when every included shift is closed, counted, and individually balanced may the report say the drawers are balanced.

Opposite variances never cancel for verdict purposes. A `+4.00` shift and a `-4.00` shift require review even though their arithmetic sum is zero.

## Time presentation

The parent admin application already loads the business SQL offset and day-start configuration. The browser-print handoff carries that existing configuration into the print window; it does not infer time from the office computer.

All non-period X/Z audit timestamps are formatted through the existing business-time utility as:

`YYYY-MM-DD hh:mm AM/PM`

This applies to generated time, business-window boundaries, and each shift's opened and closed times. Raw ISO timestamps ending in `Z` must never appear in either printed layout.

## Compatibility and failure behavior

- No schema change or migration is required.
- Existing stored audit documents can be reprinted because they already contain the `shifts` array. Missing historical fields render as dashes rather than fabricated zeroes.
- The payload hash is unchanged by display formatting; the renderer formats after receiving the persisted payload.
- X reports may include open shifts and clearly mark them as provisional.
- Existing Z issuance rules remain unchanged.
- A formatting failure falls back to the original value rather than preventing printing, but valid ISO and SQL timestamps must be covered by tests.

## Verification

1. Two sequential shifts that each start with `100.00` print two individual `100.00` opening balances and never a combined `200.00` drawer balance.
2. A `+4.00` variance and a `-4.00` variance produce two visible results and a report-level review verdict.
3. Two individually balanced shifts produce the balanced verdict.
4. An open shift prints expected cash but no actual cash or variance and prevents a completed verdict.
5. The drawer equation uses the existing per-shift values without recalculating sales or tax in the renderer.
6. ISO `Z`, SQL datetime, midnight-crossing, and null closing timestamps render in configured business time using a 12-hour clock.
7. A4 and thermal render the same cashier identities, opening balances, expected amounts, actual amounts, and variances.
8. The per-shift modal X/Z report and unrelated report types remain unchanged.

## Window-gated equation and period reports

The drawer equation (starting + net cash sales + receivable cash collections − drawer expenses = expected) is shown only when `shift.within_window === true`. Missing flags on stored documents are not permission to print the equation; those rows still show per-shift starting, expected, actual, and variance.

Period reports now share the same per-shift X/Z presentation. Range-scoped activity sits under its own heading, and each shift's drawer snapshot sits under a separate closing-balance heading. Combined starting, expected, and actual totals are never printed for period, X, or Z.
