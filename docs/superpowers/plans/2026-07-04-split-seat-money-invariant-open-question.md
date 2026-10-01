# Split Seat Money Invariant - Open Question

Date: 2026-07-04
Status: Deferred until the table workflow plan set is complete

## Context

The table split endpoint currently accepts each seat's submitted `subtotal` if it matches either:

- the seat's server-calculated discounted pre-tax subtotal, or
- the seat's server-calculated payable total.

The parent split reconciliation uses the same compatibility rule at the order level: the sum of seat `subtotal` values may match either the parent's discounted subtotal or the parent's total.

This is not currently exploitable because split checkout re-derives the final charge server-side from the held split items, persisted split discount, frozen prices, and tax settings. The newer item-conservation guard also prevents swapping products/quantities while preserving only the money total.

## Why This Is Deferred

The API contract for `seat.subtotal` is ambiguous across existing callers/tests. Some paths treat it as a pre-tax discounted subtotal, while others treat it as a payable total. Tightening this now could break working split flows before we decide which meaning the UI and API should standardize on.

## Coupling Note

As of commit `566b775b`, `/api/pos/table_splits/split` rejects requests without both `tableId` and `currentOrderId`, so every reachable split-check creation is table-backed. The route's `normalizedSplits` setup currently lives inside that table-split branch and the held-seat insert loop depends on it.

If parentless/non-table split checks are ever intentionally reintroduced, move or rebuild that normalization for the non-table path first. Otherwise a loosened guard could accept the request but insert no held split rows. This does not affect normal checkout split payments (`payment_method: "split"`), which use `/api/pos/checkout` and do not touch `normalizedSplits`.

## Decision Needed

Choose exactly one meaning for `seat.subtotal` in `/api/pos/table_splits/split`:

1. `seat.subtotal` means discounted pre-tax subtotal.
2. `seat.subtotal` means payable total after tax/inclusive-tax handling.

After that decision, update the frontend payload, backend validation, print/display naming, and tests to use the same meaning everywhere.

## Proposed Future Invariant

Once the contract is chosen:

- Compute the expected seat amount for the active `tax_inclusive_pricing` mode.
- Compare submitted `seat.subtotal` to that single expected value.
- Compare the sum of submitted seat amounts to the matching single parent anchor.
- Remove the current dual `matchesSubtotal || matchesTotal` compatibility branch.

## Acceptance Criteria

- Valid table split still works for tax-exclusive and tax-inclusive settings.
- Split with a malformed seat discount is rejected.
- Split with conserved items but wrong money is rejected.
- Split checkout still uses the held split payload as the source of truth.
- Bundle-containing table split still passes.
