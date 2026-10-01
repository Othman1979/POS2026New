# Split-check cent allocation

## Status

Decision note only. The cent-conservation fix described here has not been implemented.

## Problem

Fractional item splitting currently conserves quantity but rounds each child check independently. This can make the children differ from the original parent by one cent.

Example with a tax-exclusive item:

```text
Raw parent gross:  4.749968 -> 4.75
Raw half gross:    2.374984 -> 2.37
Two child checks:  2.37 + 2.37 = 4.74
```

The opposite drift is also possible for an exact tax-inclusive amount:

```text
Parent:            4.75
Raw half:          2.375
Two child checks:  2.38 + 2.38 = 4.76
```

This is not only a display issue. The backend calculates and rounds each child check independently. Its current `0.02` money tolerance accepts a one-cent aggregate difference, so the discrepancy can reach held checks, settlement, receipts, and finalized order totals.

The tax-inclusive fractional-price UI exposed this pre-existing accounting edge case; it did not create the underlying independent-rounding behavior.

## Evidence

- `src/pos/stores/orderSession/splitChecks.js` divides quantities and rounds quantities to four decimals, but does not allocate currency remainders.
- `backend/services/PosCalculator.js` rounds each child subtotal, tax, and total independently.
- `backend/services/CheckoutValidation.js` uses a `0.02` comparison tolerance.
- A direct backend calculation of two tax-inclusive halves of `4.75` produced `2.38` for each child and an aggregate of `4.76`.
- `backend/modules/tables/splitChecks.js` already persists server-authored per-child service-charge cents, providing a suitable pattern for trusted split-money allocation.

## Decision

Do not solve this by changing product prices, quantities, tax rates, displaying three decimals, or adding a fake discount or service charge.

Use deterministic integer-cent allocation at the split boundary. For equal halves of `4.75`, the correct allocation is:

```text
475 cents -> 238 cents + 237 cents
4.75      -> 2.38 + 2.37
```

For taxed orders, conserve the parent's financial components independently:

```text
Parent subtotal: 409 cents -> 205 + 204
Parent tax:       66 cents ->  33 +  33
Parent total:    475 cents -> 238 + 237
```

Use a deterministic largest-remainder allocation with stable seat order as the tie-breaker. The backend remains authoritative because it owns the locked parent order and frozen tax context.

## Recommended minimal scope

Keep the change inside the split-check lifecycle:

1. At split creation, calculate authoritative parent subtotal, discount, tax, and total cents and allocate them across active seats.
2. Persist each server-approved allocation in the held split's existing `cart_data` JSON, following the established `service_charge_allocation_cents` pattern. A database migration should not be necessary.
3. At split settlement, validate and use the trusted persisted allocation instead of independently re-rounding the child into a different payable amount.
4. Make held-check receipt presentation and the split modal display the same allocation.
5. Add focused tests for upward and downward half-cent cases, two/three/four-way splits, tax-inclusive and tax-exclusive modes, discounts, and aggregate parent conservation.

A representative payload shape is:

```js
split_money_cents: {
  subtotal: 204,
  discount: 0,
  tax: 33,
  total: 237
}
```

The sibling seat would hold the complementary cents so every component and the payable total reconcile exactly to the parent.

## Expected impact

This is a contained cross-layer correction, not a system-wide money rewrite. Expected production touch points are split creation, held split restoration/presentation, split checkout settlement, and split modal preview. Normal checkout, products, customers, inventory, and report calculation paths should not need redesign; reports will consume the corrected finalized child totals.

## Merge warning

The current split-check UI branch includes tax-inclusive and fractional price presentation, but the cent-conservation issue remains open. Do not treat this document as evidence that the accounting correction is complete.
