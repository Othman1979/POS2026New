# Service-Charge Canonicalization Design

**Date:** 2026-07-11

**Status:** Owner-approved design; implementation is not authorized by this document.

**Prerequisite:** POS Calculation Part C must be merged first. This design consumes the backend `PosCalculator` authority and frontend `src/utils/posTotals.js` introduced there.

## Goal

Make service-charge calculation deterministic, server-authoritative, reproducible for the lifetime of an order, and identical across register checkout, tables, held orders, split checks, and frontend display.

The change must eliminate the current raw-versus-rounded base and `toFixed(2)`-versus-`roundMoney` drift without silently repricing an open order.

## Non-Goals

- Tax-exempt sale support.
- Receipt presentation redesign.
- Changes to ordinary product, bundle, modifier, refund, or order-discount formulas.
- Table-merge service-charge reconciliation or source-snapshot cleanup; merging two fee-bearing orders already needs a separate owner-approved financial policy.
- Changing global `MONEY_TOLERANCE` behavior outside service-charge validation.
- Inferring historical service-charge rates from rounded fee amounts.

## Approved Business Rules

1. A service-charge percentage and tax rate freeze when the charge is first applied.
2. The frozen snapshot lasts for the full order lifetime.
3. Later settings changes, including disabling the feature, affect new orders only.
4. Removing and re-adding the charge on the same order reuses its frozen snapshot.
5. The fee base is the raw sum of non-fee line nets after item-level discounts.
6. The fee base is calculated before any order-level discount.
7. The fee is added to the order subtotal, so an order-level discount reduces the fee proportionally with the other lines.
8. The service-charge tax is calculated through the existing order-discount ratio and tax rollup.
9. Split checks conserve the parent fee exactly; splitting may not create or lose a cent.
10. Deployment requires an operational cutoff with no open table or held order containing `Auto-Gratuity`.

## Canonical Calculation Contract

For cart-shaped items:

```text
base = sum(lineNet(item) for every item whose note is not "Auto-Gratuity")
fee  = roundMoney(base * frozenPercentage / 100)
```

Rules:

- `lineNet` uses the Part C definition: `price * qty`, fixed discount per unit or percent discount per line, clamped at zero.
- Bundle children remain zero-value lines; only the priced parent contributes.
- The base is not rounded before percentage multiplication.
- `roundMoney` is applied exactly once to the resulting fee.
- `toFixed()` is allowed only when formatting output for display.
- Non-finite percentage, tax, price, quantity, or discount input fails closed on the backend.
- Percentage must be within `0..100` and fit `DECIMAL(7,4)`.
- Tax rate must be within `0..100` and fit `DECIMAL(5,2)`.
- A zero goods base produces no fee line. The snapshot remains attached to an active order so re-adding after later cart edits uses the same frozen rates.

## Canonical Fee-Line Shape

An accepted service-charge line is server-generated or server-overwritten to:

```javascript
{
  product_id: null,
  name: `${formattedPercentage}% Service Charge`,
  note: 'Auto-Gratuity',
  price: canonicalFee,
  qty: 1,
  tax_rate: frozenTaxRate,
  discountType: null,
  discountValue: 0
}
```

There may be at most one service-charge line per unsplit cart or split seat. Modifiers, bundles, line discounts, alternate quantities, and product IDs are forbidden on this line.

## Authority Boundaries

### Backend

Add a pure CommonJS service-charge calculator that reuses `PosCalculator.calculateLineTotal` and `roundMoney`. It owns:

- base calculation;
- fee calculation;
- frozen-rate validation;
- fee-line shape validation;
- canonical fee-line stamping.

Checkout, table save, hold, held claim/re-hold, and split routes call this authority. No route keeps an inline fee formula.

The backend recalculates after database product-price pinning and before `calculateExpectedTotals`. Accepted fee fields are overwritten with canonical server values before persistence. Client values never become financial authority.

### Frontend

Extend `src/utils/posTotals.js` with pure mirrored helpers for service-charge base and fee. `orderSessionStore.js` uses those helpers for both initial add and subsequent cart edits. The frontend uses the frozen snapshot returned by the server, never live settings once a snapshot exists.

A differential test compares frontend and backend service-charge results over deterministic and seeded multi-line grids.

## Snapshot Creation API

Adding a service charge makes one server request; later cart edits remain local.

```text
POST /api/pos/service_charge_snapshots
```

The server:

1. verifies authentication and `pos.service_charge` permission;
2. locks/reads current service-charge settings;
3. requires the feature to be enabled;
4. validates percentage and tax precision/range;
5. creates a `draft` snapshot with a 24-hour expiry;
6. returns its opaque ID, percentage, tax rate, and version.

The frontend adds the fee only after this request succeeds. A failed request leaves the cart unchanged. Re-adding on an order that already owns a snapshot does not create a new snapshot.

The existing deep `watch(cart, ..., { deep: true })` in `orderSessionStore.js` remains the single automatic recomputation hook. It schedules `updateServiceCharge` with `nextTick`; that action reads the frozen snapshot and mirrored helper, updates only when the canonical fee/name changed, and therefore reaches a fixed point without watcher recursion. Individual cart mutation actions do not duplicate fee recomputation.

## Persistence Model

Create `service_charge_snapshots` with:

- `id CHAR(36)` primary key;
- `percentage DECIMAL(7,4) NOT NULL`;
- `tax_rate DECIMAL(5,2) NOT NULL`;
- `parent_snapshot_id CHAR(36) NULL` for split lineage;
- `state ENUM('draft','held','claimed','open_order','split_parent','finalized','abandoned')`;
- `holder_type ENUM('none','held_order','claim','order')`;
- `holder_id VARCHAR(80) NULL`;
- `claim_token_hash CHAR(64) NULL`;
- `created_by INT NOT NULL`;
- `version INT NOT NULL DEFAULT 1`;
- `expires_at DATETIME NULL`;
- `created_at` and `updated_at` timestamps.

Add nullable references:

- `orders.service_charge_snapshot_id CHAR(36)`;
- `held_orders.service_charge_snapshot_id CHAR(36)`.

Historical finalized orders may retain `NULL`; their frozen `order_items` remain the source for receipts and refunds.

## Snapshot State Machine

```text
draft -> open_order -> finalized
draft -> finalized
draft -> held -> claimed -> finalized
draft -> held -> claimed -> held
draft -> held -> claimed -> abandoned
held -> finalized
open_order -> split_parent
split_parent -> child held snapshots -> claimed -> finalized
draft -> abandoned
```

All state changes lock the snapshot row and check `version`. Invalid transitions fail closed.

- Direct register checkout finalizes its draft in the checkout transaction.
- If a direct-register draft reaches checkout with no fee line, checkout transitions it to `abandoned` and does not link it to the finalized order. The snapshot remains retained only while the order is active so remove/re-add can reuse it.
- First table save binds the draft to the unpaid order. Later saves and checkout load rates from that row, not settings.
- A hold binds the draft to the new held row.
- Claim atomically moves the snapshot to `claimed`, generates a one-time 256-bit random token, stores only its SHA-256 hash, and returns the plaintext token with the claimed order. Verification uses a constant-time comparison.
- Checkout or re-hold must present that token. Successful use clears the claim token and moves the snapshot to its next holder.
- Replaying a consumed token or binding a snapshot to another lineage returns a conflict.
- Bound and finalized snapshots do not expire.
- Unused drafts expire after 24 hours and are cleaned up. Expiration requires visible reapplication; it never causes silent repricing.
- Starting a new order sends a best-effort abandon request. Cleanup remains safe if that request is lost.

## Settings Changes

- Percentage, tax, and enabled changes apply only when creating a new snapshot.
- Existing snapshots remain valid when settings change or the feature is disabled.
- An order with no snapshot cannot add a fee while the current feature setting is disabled.
- Settings validation rejects precision that persistence cannot represent: more than four decimal places for percentage or two for tax rate.

## Held Orders

Hold creation must validate and canonicalize the service-charge line instead of storing an unchecked client cart.

- A new hold binds a draft snapshot in the same transaction as the held row insert.
- The held row exposes snapshot rates for display but not as authority.
- Claim uses the one-time token transition described above so the existing atomic-delete behavior remains intact.
- Re-holding preserves the same snapshot and rate even if settings changed while the ticket was claimed.
- Kitchen firing and held-card display use the frozen canonical fee line already stored in `cart_data`.

## Table Orders

- First save with a fee binds the snapshot to the table order.
- Loading a table returns the snapshot identity, rates, and version to the store.
- Cart edits recalculate with frozen rates.
- Subsequent saves select the order and snapshot `FOR UPDATE`, validate version/association, canonicalize the line, and persist it atomically.
- Removing the line does not remove the snapshot from the open order.
- Re-adding uses the existing snapshot without consulting settings.
- Final checkout uses the order-bound snapshot and marks it finalized in the checkout transaction.

## Split-Check Conservation

The server ignores client placement and value of the parent fee during a split. It generates child fees from the frozen parent snapshot.

1. Compute each non-empty seat's raw fee share from its authoritative discounted goods base.
2. Convert the parent fee to integer cents.
3. Floor every raw seat share to cents.
4. Distribute remaining cents in descending fractional-remainder order.
5. Use stable submitted seat order as the tie-breaker.
6. Generate one canonical fee line for each seat receiving a nonzero share.
7. Create one child snapshot per resulting held split, linked to the parent and carrying identical frozen percentage/tax.
8. Persist each seat's allocated fee cents inside the server-generated held payload so settlement validates the allocation without recomputing it.

Required conservation identity:

```text
sum(child service-charge cents) == parent service-charge cents
```

The parent snapshot moves to `split_parent`. A child follows held/claim/finalize when restored for editing, or the exact `held -> finalized` settlement path when its split seat is paid directly.

Split settlement is deliberately separate from direct-draft and claimed-hold checkout. Checkout locks the held row and reads its child snapshot FK; it ignores any client snapshot payload. Because allocated child cents can differ from independently rounded `seatBase * percentage`, checkout validates the stored canonical fee line against the persisted allocation cents and frozen tax/shape exactly, without calling the ordinary fee recomputation helper. The child snapshot transitions directly from `held` to `finalized` in the same transaction that deletes the held row and creates the paid order.

If a claimed held order reaches checkout or re-hold with its fee removed, the one-time claim token is still consumed but the snapshot transitions `claimed -> abandoned` and is not linked to the finalized order.

## Error Policy

- `400 Bad Request`: malformed fee shape, invalid numeric input, multiple fee lines, unsupported precision, or invalid snapshot payload.
- `401 Unauthorized`: missing or invalid user authentication, handled by the existing authentication middleware.
- `403 Forbidden`: missing service-charge permission or new application while disabled.
- `409 Conflict`: expired/stale snapshot, invalid or consumed claim token, invalid state transition, version conflict, replayed claim, or exact-cent mismatch caused by stale cart state. Snapshot conflicts carry a stable public `code`.
- `500`: unexpected persistence failure; transaction rolls back and cart remains intact.

The service-charge fee itself does not use general `MONEY_TOLERANCE`. After both values are canonically rounded, submitted and expected cents must be equal. Global tolerance behavior for other totals remains unchanged.

The server never silently charges a different fee on checkout. An expired unbound draft returns `409` with `code: "SERVICE_CHARGE_SNAPSHOT_EXPIRED"`; the frontend removes the fee line, clears the expired snapshot from Pinia/local storage, and tells the operator to add the service charge again. A bound table/version conflict returns `SERVICE_CHARGE_SNAPSHOT_CONFLICT`; the frontend retains the fee, reloads the order-bound snapshot/cart state, and asks the operator to retry. It must never replace a bound frozen rate with current settings.

## Migration and Rollout

1. Deploy only during the approved operational cutoff.
2. Run a preflight query that fails if any unpaid table order or held order contains an `Auto-Gratuity` line.
3. Add the snapshot table and nullable references.
4. Add indexes and foreign keys where non-polymorphic references allow them.
5. Update test fixtures in the same commit as the migration.
6. Deploy backend support before enabling the new frontend add flow.
7. Historical finalized orders remain untouched and un-backfilled.
8. Do not infer rates from fee names or rounded amounts.

Rollback before new snapshots exist is schema-only. After new snapshots exist, application rollback requires disabling new service-charge application and retaining the snapshot schema until all affected open orders are finalized.

## Testing Strategy

### Pure calculation tests

- Raw versus rounded base boundary (`0.045` at `10%`).
- `1.005` and other EPSILON-sensitive results.
- Fixed and percent line discounts.
- Fractional quantities and six-decimal prices.
- Mixed tax rates and taxable service charge.
- Bundle parent/child ownership.
- Zero base and zero percentage.
- Maximum supported percentage/tax and precision rejection.

### Differential experiments

- Deterministic Cartesian grid comparing backend and frontend base/fee.
- Seeded multi-line carts with mixed discounts, quantities, bundles, and fee tax.
- Charged-field parity through `calculateExpectedTotals` after canonical fee insertion.

### Snapshot integration tests

- Settings change after add does not change an active snapshot.
- Global disable blocks new snapshots but not existing bound orders.
- Remove/re-add retains rates.
- Table save/load/update/checkout preserves identity and values.
- Hold/claim/re-hold/checkout preserves identity and rejects token replay.
- Concurrent claim or snapshot bind has exactly one winner.
- Forged rate, tax, quantity, discount, duplicate line, snapshot ID, and snapshot lineage fail closed.
- Transaction failure rolls back snapshot and order/held mutations together.

### Split property tests

- Child cents always sum to parent cents over seeded seat/base grids.
- Stable tie-breaking gives reproducible allocations.
- Empty seats receive no fee.
- Child snapshots inherit rates and link to the parent.
- Settlement persists exactly the allocated fee and correct discounted tax.

### Verification

- Existing checkout, tables, held-order, split, bundle, refund, and receipt suites pass.
- Full Vitest suite passes from an execution-start baseline.
- Admin production build passes.
- No tax-exempt or receipt-presentation behavior enters this work.

## Success Criteria

- Initial add and every update produce the same cent for the same cart/snapshot.
- Frontend and backend helpers have zero differential mismatches for valid inputs.
- Backend persistence never trusts client fee fields.
- Settings changes never silently reprice an existing order.
- An overnight cart with an expired draft has a visible recovery path and cannot become a checkout dead-end.
- A direct checkout with its fee removed abandons the unused draft and stores no snapshot FK.
- Held/re-held and table orders retain their frozen rate for their complete lifetime.
- Split checks conserve the parent fee exactly.
- No historical finalized order is modified.
- No service-charge calculation uses `toFixed()` or a rounded subtotal as an arithmetic input.
