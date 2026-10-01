# Tax-Inclusive Priced Modifiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every positive modifier price tax-inclusive at its parent product’s frozen tax rate, so selecting a `0.15 JD` modifier increases the customer’s payable amount by exactly `0.15 JD`, while zero-price modifiers remain non-financial.

**Architecture:** Keep `modifier_surcharge` as the server-authored per-unit gross modifier price and add one nullable frozen value, `modifier_tax_amount`, containing the tax already embedded in that surcharge. The canonical calculator subtracts that embedded tax from exclusive-mode subtotal before calculating the parent line’s VAT; a NULL value preserves the currently deployed untaxed-modifier behavior for historical and already-open orders. Every path that already carries `modifier_surcharge` carries the new value beside it.

**Tech Stack:** Node.js/CommonJS, Express, mysql2/InnoDB, Vue 3/Pinia, Vitest/Supertest.

## Global Constraints

- A modifier inherits its parent product’s frozen `tax_rate`; modifiers do not define a separate rate.
- Positive modifier prices are gross/tax-inclusive. Zero-price modifiers do not affect subtotal, tax, or total.
- The modifier price must increase the final payable amount by exactly its configured amount before discounts.
- `modifier_surcharge` remains the configured gross amount; do not silently change its meaning.
- `modifier_tax_amount` is per-unit and server-authored. Never trust the client value on checkout/table save/hold.
- `modifier_tax_amount IS NULL` means legacy behavior. Do not backfill finalized or open orders.
- For a positive modifier with a zero-rate parent, persist `modifier_tax_amount = 0`; this distinguishes the new rule from legacy NULL.
- Existing saved tables, held orders, split checks, refunds, and finalized receipts must retain their frozen behavior.
- Service charge base, refunds, reports, and receipts must use the same canonical line subtotal as checkout.
- No new modifier table, rate field, UI control, or tax category is required.

## Canonical Formula

For one unit in tax-exclusive catalog mode:

```text
base_net             = folded_price - modifier_surcharge
modifier_net         = modifier_surcharge / (1 + parent_tax_rate / 100)
modifier_tax_amount  = modifier_surcharge - modifier_net
line_unit_net        = folded_price - modifier_tax_amount
line_tax             = discounted_line_net * parent_tax_rate / 100
line_payable          = discounted_line_net + line_tax
```

Example: base `5.00`, modifier `0.15`, tax `8%`:

```text
modifier_net = 0.15 / 1.08 = 0.138888889
modifier_tax = 0.15 - 0.138888889 = 0.011111111
line_net     = 5.15 - 0.011111111 = 5.138888889
line_tax     = 5.138888889 * 8% = 0.411111111
payable      = 5.55
```

Without the modifier the payable is `5.40`; therefore the modifier adds exactly `0.15`, not `0.162`.

In global tax-inclusive catalog mode, the existing POS contract remains: folded price `base + modifier`, stored order tax `0`, payable equals folded price after discounts. JoFotara later reconstructs legal VAT from the frozen rate.

---

## File Map

| File | Change |
|---|---|
| `backend/migrations/2026-07-21-modifier-inclusive-tax.sql` | Add nullable frozen embedded-tax amount |
| `backend/tests/fixtures/seed.js` | Test schema parity |
| `backend/services/PosCalculator.js` | Canonical line subtotal/tax modes |
| `src/utils/posTotals.js` | Frontend parity |
| `src/utils/receiptLineTotals.js` | Receipt/split fallback parity |
| `backend/routes/pos/helpers.js` | Server derivation and recomputation |
| `backend/routes/pos/checkout.js` | Persist/freeze field |
| `backend/routes/pos/tables.js` | Persist/copy/freeze/restore field |
| `backend/routes/pos/orders.js` | Hold save/claim field |
| `backend/services/ServiceChargeCalculator.js` | Canonical service-charge base |
| `backend/routes/pos/refunds.js` | Canonical refundable subtotal |
| `backend/services/ReceiptPresentationSources.js` | Frozen receipt subtotal |
| `backend/services/yHeldItemsReportBuilder.js` | Report allocation parity |
| `backend/routes/print.js` | Carry field to split/guest-check presentation |
| `assets/js/composables/stores/orderSessionStore.js` | Live preview, persistence, restore, service charge |
| `src/components/PosTerminal.vue` | Unit display fallback parity |

### Task 1: Add the frozen modifier embedded-tax column

**Interfaces:**
- `order_items.modifier_tax_amount DECIMAL(10,6) NULL` is per-unit.
- NULL preserves legacy untaxed-modifier behavior.

- [ ] Add a failing schema-drift assertion for `order_items.modifier_tax_amount`.
- [ ] Create `backend/migrations/2026-07-21-modifier-inclusive-tax.sql`:

```sql
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS modifier_tax_amount DECIMAL(10,6) DEFAULT NULL
  AFTER modifier_surcharge;
```

- [ ] Add the identical nullable column to the `order_items` definition in `backend/tests/fixtures/seed.js`.
- [ ] Do not update existing rows. Run the migration twice; the second run must be harmless.
- [ ] Run `node scripts/validate-schema-drift.js`; expect PASS.
- [ ] Commit: `feat(pos): snapshot modifier included tax`.

### Task 2: Replace the backend’s untaxed-surcharge rule with a versioned line calculation

**Interfaces:**
- Produces `deriveModifierTaxAmount(surcharge, taxRate) -> number|null`.
- Produces `calculateLineSubtotal(item, taxRate, taxInclusivePricing) -> number`.
- `taxableLineTotal` remains available but delegates to the versioned rule.

- [ ] Rewrite the modifier block in `backend/tests/unit/PosCalculator.test.js` first. Required assertions:

```js
expect(deriveModifierTaxAmount(0.15, 8)).toBeCloseTo(0.011111111, 9);
expect(deriveModifierTaxAmount(0, 8)).toBeNull();
expect(deriveModifierTaxAmount(0.15, 0)).toBe(0);

const current = {
  price: 5.15, qty: 1, tax_rate: 8,
  modifier_surcharge: 0.15,
  modifier_tax_amount: 0.011111111
};
expect(calculateLineSubtotal(current, 8, false)).toBeCloseTo(5.138888889, 9);
expect(stampLineTax(current, 8, 1, false)).toBeCloseTo(0.411111111, 9);

const legacy = { ...current, modifier_tax_amount: null };
expect(calculateLineSubtotal(legacy, 8, false)).toBe(5.15);
expect(stampLineTax(legacy, 8, 1, false)).toBeCloseTo(0.4, 9);
```

- [ ] Implement in `backend/services/PosCalculator.js`:

```js
const deriveModifierTaxAmount = (surcharge, taxRate) => {
  const gross = sanitizeModifierSurcharge(surcharge);
  if (gross === null) return null;
  const rate = validateTaxRate(taxRate);
  if (rate === 0) return 0;
  return gross - (gross / (1 + rate / 100));
};

const hasInclusiveModifierSnapshot = item =>
  item.modifier_surcharge != null && item.modifier_tax_amount != null;

const calculateLineSubtotal = (item, taxRate, taxInclusivePricing = false) => {
  if (taxInclusivePricing || !hasInclusiveModifierSnapshot(item)) {
    return calculateLineTotal(item);
  }
  return calculateLineTotal({
    ...item,
    price: Math.max(0, toFiniteNumber(item.price) - toFiniteNumber(item.modifier_tax_amount))
  });
};
```

- [ ] Preserve legacy tax exactly: when surcharge is positive and `modifier_tax_amount` is NULL, subtotal remains folded gross while `taxableLineTotal` continues excluding `modifier_surcharge`.
- [ ] New-mode tax uses `calculateLineSubtotal`; line and order discounts apply to the combined base-plus-modifier net before VAT.
- [ ] Change `normalizeCartItems` to strip client `modifier_tax_amount` beside `modifier_surcharge`.
- [ ] Change `calculateExpectedTotals` to resolve each line’s tax rate first, sum `calculateLineSubtotal`, derive the order discount ratio from that subtotal, and stamp tax with the same line mode.
- [ ] Run `npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/unit/posTotalsParity.test.js`; expect the new formula and parity tests to pass.
- [ ] Commit: `feat(pos): tax priced modifiers inclusively`.

### Task 3: Match frontend totals and receipt fallbacks

**Interfaces:**
- `lineNet(item, { taxInclusive })` mirrors `calculateLineSubtotal`.
- `lineTax`, `lineGross`, `posTotals`, and receipt fallbacks consume that same result.

- [ ] Replace the old “untaxed modifier surcharge” tests in `backend/tests/unit/posTotals.test.js` and `backend/tests/unit/receiptLineTotals.test.js` with the `5.00 + 0.15 @ 8% = 5.55` case, legacy NULL case, zero-rate case, percent discount, and tax-inclusive catalog case.
- [ ] Add `modifierTaxAmount`/`hasInclusiveModifierSnapshot` helpers in `src/utils/posTotals.js`; do not duplicate the formula in components.
- [ ] Make `posTotals` calculate subtotal and tax from the same line function. Its expected exclusive result for the example is subtotal `5.14`, tax `0.41`, total `5.55` after currency rounding.
- [ ] Update `src/utils/receiptLineTotals.js` so saved `tax_amount` remains authoritative and fallback subtotal/tax recognizes `modifier_tax_amount`.
- [ ] Run the three focused unit test files; expect PASS.
- [ ] Commit: `feat(pos): align modifier totals in the terminal`.

### Task 4: Author the new snapshot from database prices

**Interfaces:**
- `applyDatabasePrices(..., { taxInclusivePricing })` attaches server-owned `modifier_surcharge` and `modifier_tax_amount`.

- [ ] Update `backend/tests/unit/helpers.test.js` first to prove client-supplied values are overwritten and parent rates `8`, `0`, and invalid are handled.
- [ ] In `backend/routes/pos/helpers.js`, after resolving the database modifier surcharge and product tax rate, set:

```js
item.modifier_surcharge = extraPrice > 0 ? Number(extraPrice.toFixed(6)) : null;
item.modifier_tax_amount = extraPrice > 0
  ? Number(deriveModifierTaxAmount(extraPrice, product.tax_rate).toFixed(6))
  : null;
```

- [ ] Keep folded display price as `basePrice + extraPrice`. The calculator—not the fold—removes embedded VAT from the exclusive subtotal.
- [ ] Pass checkout tax mode into the helper only where needed for calculation; the stored embedded amount itself is derived regardless of global mode.
- [ ] Ensure custom lines, service-charge lines, and bundle children receive NULL.
- [ ] Run `npx vitest run backend/tests/unit/helpers.test.js backend/tests/unit/PosCalculator.test.js`; expect PASS.
- [ ] Commit: `feat(pos): derive modifier tax from product rate`.

### Task 5: Carry the snapshot through every saved-order path

**Interfaces:**
- Every carrier of `modifier_surcharge` also carries `modifier_tax_amount`.

- [ ] In `backend/routes/pos/checkout.js`, add the column to saved-row SELECTs, `registerSavedRow`, frozen maps, checkout INSERT, and value arrays.
- [ ] In `backend/routes/pos/tables.js`, add it to table-order GET mapping, save INSERT, frozen-context keys/maps, merge matching/copy INSERTs, split creation, and split settlement.
- [ ] In `backend/routes/pos/orders.js`, save it into held `cart_data`, restore it by index, and derive it for legacy register holds only when the hold is repriced from current database modifier definitions. Do not mutate old saved-table rows.
- [ ] In `backend/services/ReceiptPresentationSources.js` and `backend/routes/print.js`, pass it beside `modifier_surcharge` into presentation builders.
- [ ] In `assets/js/composables/stores/orderSessionStore.js`, carry it through local storage, hold claim, table load, edit load, split copies, and `processFinalAddToCart`.
- [ ] Add integration assertions to `checkout.test.js`, `tables.test.js`, and `heldOrders.test.js` proving the field survives checkout, save→leave→reload→add→save, merge, split, hold→claim, and reprice.
- [ ] Run those focused integration files one at a time because they share the test database; expect PASS.
- [ ] Commit: `feat(pos): preserve modifier tax snapshots`.

### Task 6: Update service-charge bases without creating snapshot conflicts

**Interfaces:**
- Backend and frontend service-charge base receive `{ taxInclusivePricing }` and use canonical line subtotal.

- [ ] Add a failing `ServiceChargeCalculator` test: a 10% fee on the example’s exclusive net `5.138888889` rounds to `0.51`, and an old NULL row keeps its previous base.
- [ ] Change `backend/services/ServiceChargeCalculator.js` so `serviceChargeBase`, `serviceChargeFee`, `canonicalizeServiceCharge`, and `allocateServiceChargeCents` use `calculateLineSubtotal(item, item.tax_rate, taxInclusivePricing)`.
- [ ] Pass the frozen/current tax mode from checkout, table save, hold save, and split settlement call sites.
- [ ] Change frontend `serviceChargeBase/serviceChargeFee` and the store’s `updateServiceCharge`/`appendServiceCharge` calls to pass the same tax mode.
- [ ] Add a table regression: saved auto-service-charge table with a priced modifier can be reopened, receive a new item, and save/guest-check/checkout without “Service charge changed”.
- [ ] Run focused service-charge, table, and checkout tests; expect PASS.
- [ ] Commit: `fix(pos): keep service charge aligned with modifier tax`.

### Task 7: Reconcile refunds, receipts, reports, and audit money

**Interfaces:**
- All derived subtotal consumers use the frozen modifier mode; stored `tax_amount` remains authoritative.

- [ ] In `backend/routes/pos/refunds.js`, select `modifier_surcharge`, `modifier_tax_amount`, `tax_rate`, and `tax_inclusive_at_sale`; calculate refundable line subtotal with `calculateLineSubtotal` before multiplying by the saved order-discount ratio. Continue scaling stored line tax by refunded fraction.
- [ ] In `backend/services/ReceiptPresentationSources.js`, pass both modifier fields and use the canonical line subtotal when rebuilding raw subtotal/order-discount display.
- [ ] In `backend/services/yHeldItemsReportBuilder.js`, use canonical line subtotal plus `stampLineTax` for item/category allocations.
- [ ] In `backend/services/auditEvents.js`, calculate displayed line-discount money from the same canonical subtotal where the tax mode/rate is available; do not change the recorded discount type/value.
- [ ] In `backend/routes/pos/orders.js`, replace held-order canonical subtotal’s direct `calculateLineTotal` call with `calculateLineSubtotal` using the hold tax mode.
- [ ] Add focused tests for partial refund, full refund, partial void, Y report, receipt presentation, and discount audit using the `0.15 @ 8%` example plus one legacy NULL row.
- [ ] Run existing focused files; do not create a second report/refund calculator.
- [ ] Commit: `fix(pos): reconcile modifier tax across financial reads`.

### Task 8: Activate frontend modifier creation atomically

**Interfaces:**
- `confirmModifiers` writes gross surcharge plus embedded tax preview.
- Backend still overwrites both values before persistence.

- [ ] Update `backend/tests/unit/orderSessionStore.test.js` first: zero-price selections produce both fields NULL; `0.15 @ 8%` produces surcharge `0.15`, embedded tax about `0.011111`, and payable increase exactly `0.15`.
- [ ] In `confirmModifiers`, derive the preview from the active product’s `tax_rate` and pass both fields to `processFinalAddToCart`:

```js
const modifierTax = extraPrice > 0
  ? modifierTaxAmount(extraPrice, Number(product.tax_rate || 0))
  : null;
```

- [ ] Ensure cart-line merge identity still distinguishes modifier selections through the existing selected-modifier snapshot/note; do not use floating tax amount as the sole identity.
- [ ] Update PosTerminal’s unit-price fallback to use the shared line helper. Do not place separate modifier-tax copy in the template.
- [ ] Run store tests and `npm run build:admin`; expect PASS.
- [ ] Commit: `feat(pos): activate inclusive modifier pricing`.

### Task 9: Final parity and deployment gate

- [ ] Run the existing modifier, totals parity, checkout, held-order, table, refund, service-charge, receipt, report, and schema-drift tests. Reuse existing coverage; add a test only for an uncovered rule above.
- [ ] Verify these cases manually through the calculator/API fixtures:
  - zero-price modifier;
  - `0.15` modifier with 8% parent tax;
  - zero-rate parent;
  - line percentage/fixed discounts;
  - order percentage/fixed discounts;
  - automatic service charge;
  - saved table reopened with a new item;
  - held order claim;
  - split check;
  - partial refund and void;
  - global tax-inclusive pricing.
- [ ] Confirm every frontend subtotal/tax/total is within the existing checkout tolerance and every saved `SUM(order_items.tax_amount)` reconciles with the order tax contract.
- [ ] Deploy migration before code. Do not backfill. Existing NULL rows retain legacy behavior; newly added priced modifiers receive the new snapshot.
- [ ] Commit: `test(pos): verify inclusive modifier taxation`.

## JoFotara Dependency

JoFotara must consume the frozen line mode:

- New priced-modifier rows (`modifier_tax_amount != NULL`) stay inside their parent product line. Their legal pre-tax extension subtracts the embedded modifier VAT before discounts and recalculates tax at the parent rate.
- Legacy rows (`modifier_tax_amount == NULL`) reproduce their historically stored subtotal/tax rather than being reinterpreted.
- Zero-price modifiers remain display-only and create no allowance or invoice line.

