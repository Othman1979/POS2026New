# POS Calculation Part C Rewrite Design

**Status:** Approved 2026-07-11

## Objective

Reduce duplicated POS line-net and tax math without changing charged or persisted money. Keep behavior changes out of the mechanical refactor. Make every retained exception explicit and covered by tests.

## Scope

### Phase 1: behavior-preserving unification

- Add backend `resolveTaxRate` and `stampLineTax` helpers to `backend/services/PosCalculator.js`.
- Route checkout, table-save, and open-order healing through those helpers using the existing `backend/routes/pos/helpers.js` import boundary.
- Add pure frontend `src/utils/posTotals.js` for normalized cart display math.
- Delegate live-cart and held-order display totals to the frontend helper.
- Preserve existing service-charge base and rounding behavior exactly.
- Preserve existing frontend and backend discount-display rounding, including their known half-cent divergence.
- Keep refund math unchanged because it intentionally consumes frozen `tax_amount` and already delegates line-net calculation to `calculateLineTotal`.

### Deferred behavior changes

- Service-charge canonicalization: raw versus rounded base and `toFixed(2)` versus `roundMoney` need owner approval and their own financial migration tests.
- Receipt presentation: net versus gross line columns, discount presentation, and field precedence need owner approval before customer-visible changes.
- Tax exemption: current toggle has no server-side sale contract. It requires a separate design covering authorization, request shape, persistence, line stamping, receipts, edits, tables, refunds, and audit history.
- Bundle zero-quantity recovery: corrupt-data policy is unrelated to tax unification and will not be silently introduced here.

## Architecture

### Backend authority

`PosCalculator.js` remains the authoritative calculation module. `backend/routes/pos/helpers.js` imports and re-exports calculator functions; POS routes continue importing from `./helpers` rather than adding a second service dependency.

`resolveTaxRate(product, fallbackRate)` uses the catalog rate whenever a product row exists, including `NULL -> 0`. Only custom lines without a product row use the frozen/client fallback.

`stampLineTax(item, taxRate, discountRatio, taxInclusivePricing)` computes per-line persisted tax from `calculateLineTotal`. Inclusive mode stamps zero, matching current order rollups.

### Frontend authority

`src/utils/posTotals.js` is pure ESM with no Vue or DOM imports. It owns normalized frontend line net, line tax, gross display, order discount amount, and cart totals.

Input contract uses cart-shaped fields: `price`, `qty`, `discountType`, `discountValue`, and `tax_rate`. Adapters normalize alternate DB/held names before calling it.

`orderNotesTax.js` becomes a compatibility adapter over `posTotals`; it no longer owns a separate fixed-discount or tax formula.

Receipt-specific helpers remain adapters because receipts consume frozen `tax_amount` and multiple payload shapes. They are not treated as charge authorities.

## Money Invariants

- `roundMoney` remains `Math.round((finite(value) + Number.EPSILON) * 100) / 100`.
- Backend `calculateExpectedTotals` outputs remain byte-identical in Phase 1.
- Frontend `cartSubtotal`, `cartTax`, and `cartTotal` remain identical for valid current cart states.
- Existing frontend `cartOrderDiscountAmount` behavior remains unchanged.
- FE/BE parity gates compare charged fields: `subtotal`, `tax`, and `total`.
- Backend response `discount` is characterized separately because floating-point subtraction can differ from frontend direct discount rounding by one cent.
- Service-charge line prices do not change in Phase 1.
- Bundle children keep zero price and zero tax; parent carries bundle money.
- Tax-inclusive order and line tax remain zero under current application semantics.

## Error and Invalid-State Policy

- Backend validation remains authoritative for negative values, percent discounts over 100, invalid quantities/prices, and tax rates outside 0-100.
- Frontend pure helpers are defensive display functions: non-finite numeric input becomes zero and line totals clamp at zero.
- Frontend helpers do not claim parity for invalid states the backend rejects.
- Catalog-rate parity tests include product rows with `NULL` tax and custom lines without product rows.
- Corrupt bundle parent quantity does not receive an invented fallback in this work.

## Testing Strategy

### Characterization before delegation

- Capture current store totals for normal, multi-rate, line-discounted, order-discounted, inclusive, blank-price, fractional-quantity, and half-cent cases.
- Capture existing FE/BE discount-display divergence with `15.00` subtotal and `0.5%` order discount: frontend `0.08`, backend `0.07`; charged fields remain equal.
- Capture current service-charge results at half-cent boundaries so Phase 1 proves no fee drift.

### Backend helper coverage

- Product tax, `NULL` catalog tax, custom-line fallback, and non-finite fallback.
- Exclusive, inclusive, zero-rate, fixed-line-discount, and percent-line-discount stamping.
- Checkout, table-save, and open-order-heal integration assertions for `orders.tax`, `orders.total`, and `order_items.tax_amount`.

### Frontend differential coverage

- Deterministic grid comparing `posTotals` against `calculateExpectedTotals` for `subtotal`, `tax`, and `total`.
- Separate tests for frontend discount display and backend discount response.
- Held-order regression for multi-quantity fixed discount.
- Build verification proving both backend Vitest and Vite can load pure ESM helper.

## Delivery Boundaries

1. Backend helper extraction and route wiring.
2. Pure frontend helper plus differential tests.
3. Store and held-order delegation with behavior characterization.
4. Rule-lock tests only.

Each boundary gets its own commit and focused verification. Full `npx vitest run` and `npm run build:admin` gate completion. Only one Vitest process may run because integration tests share `posapp_test`.

## Out of Scope

- Tax-exempt sale implementation.
- Service-charge financial behavior changes.
- Receipt line-display changes.
- Product-card pricing changes.
- Modifier surcharge tax changes.
- Refund formula redesign.
- Bundle corruption recovery.
- Rounding-formula changes.
