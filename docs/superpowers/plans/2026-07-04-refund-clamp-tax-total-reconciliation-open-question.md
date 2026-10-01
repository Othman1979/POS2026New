# Refund Clamp — Tax / Total Reconciliation Open Question

Date: 2026-07-04
Status: Deferred until the table workflow plan set is complete
Related: `backend/routes/pos/refunds.js` (over-refund cap + line rescale, ~L179-213)

## Context

When the over-refund cap clamps a refund's header `subtotal_refunded`, the code
rescales the per-line `refund_items.line_subtotal` rows so that
`SUM(line_subtotal) == refunds.subtotal_refunded` (P3-3), and the last-line
allocation is now floored at 0 so no line goes negative (fixed 2026-07-04,
commit `831806b`).

That reconciliation is **subtotal-only**. Two related quantities are left
divergent when a clamp fires:

1. **Tax is not rescaled.** `line_tax` / `taxRefunded` keep their full
   (pre-clamp) values while the subtotal is clamped down, so the refund's
   internal subtotal:tax ratio no longer matches the original sale lines.
2. **Header amount vs line totals.** `amount_refunded` is computed as
   `roundMoney(subtotalRefunded + taxRefunded)` and then **separately** clamped
   by `remainingTotal`. After that clamp, `SUM(refund_items.line_total)` can
   diverge from `refunds.amount_refunded`.

## Why This Is Not Currently Urgent

- The clamp normally fires only on rounding overshoot, so both divergences are
  cents in the common case (larger only under heavy order-level discounts that
  make line subtotals sub-cent — the same path as the negative-line bug).
- The money actually returned to the customer is `refunds.amount_refunded`
  (the header), which is correctly capped; the divergence is between the header
  and its own child rows, i.e. a reporting/receipt reconciliation gap, not an
  over-refund.
- Restock uses `refund_items.quantity` (untouched by the rescale), so inventory
  is unaffected.

This was explicitly scoped OUT of Plan 5. Do not expand the P3-3 patch to cover
it — decide it deliberately once the plan set is done.

## Decision Needed / Proposed Future Invariant

When the header is clamped, reconcile the child rows on all three axes, not just
subtotal:

- Scale `line_tax` by the same clamp ratio (or re-derive each line's tax from its
  clamped subtotal) so `SUM(line_tax) == taxRefunded`.
- Ensure `SUM(refund_items.line_total) == refunds.amount_refunded` after any
  `remainingTotal` clamp (rescale line_total, or re-derive the header amount from
  the reconciled lines).
- Keep the non-negative + exact-sum guarantees already in place.

## Acceptance Criteria (for the future fix)

- Multi-line clamped refund: `SUM(line_subtotal) == subtotal_refunded`,
  `SUM(line_tax) == tax_refunded`, `SUM(line_total) == amount_refunded`.
- No `refund_items` row has a negative `line_subtotal`, `line_tax`, or
  `line_total`.
- Holds for both `intent='refund'` and `intent='void'`, tax-inclusive and
  tax-exclusive settings, and orders with an order-level discount.

## Revision Log

| Date | Change |
|---|---|
| 2026-07-04 | Created. Negative-line half already fixed (`831806b`); tax/total reconciliation deferred. |
