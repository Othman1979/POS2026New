# POS Calculation Part C — Behavior-Preserving Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated backend tax stamps and frontend POS total formulas with one authority per side while keeping every charged and persisted amount byte-identical.

**Architecture:** `backend/services/PosCalculator.js` remains backend authority; `backend/routes/pos/helpers.js` remains route import boundary. New pure-ESM `src/utils/posTotals.js` becomes frontend display authority, with `orderSessionStore.js` and `orderNotesTax.js` delegating to it. Financial behavior changes, receipt redesign, tax exemption, and bundle-corruption recovery are excluded.

**Tech Stack:** Vue 3, Pinia, Vite 6, Node.js/Express, MySQL, Vitest 4.

## Global Constraints

- Read approved design first: `docs/superpowers/specs/2026-07-11-pos-calculation-part-c-rewrite-design.md`.
- Start from current `master` in an isolated worktree; default branch: `codex/refactor-pos-calc-part-c`.
- Baseline verified 2026-07-11: `80` test files, `972/972` tests, `npm run build:admin` passing. At execution start, record the then-current baseline; final verification uses that baseline plus the tests added here instead of treating a stale exact total as a contract.
- Run one Vitest process at a time; integration suites share `posapp_test`.
- Do not change `PosCalculator.calculateExpectedTotals()` output or `MONEY_TOLERANCE = 0.02`.
- Do not change `roundMoney`: `Math.round((finite(value) + Number.EPSILON) * 100) / 100`.
- Do not change service-charge base or rounding in this plan. `addServiceCharge` keeps rounded-base + `toFixed(2)`; `updateServiceCharge` keeps raw-base + `toFixed(2)`.
- Do not implement tax exemption server support. Current client-only toggle remains characterized but is not presented as a working server feature.
- Do not change receipts, product-card/unit-price display, modifier surcharge tax, refunds, or bundle zero-quantity recovery.
- FE/BE parity compares charged fields only: `subtotal`, `tax`, `total`. Backend and frontend `discount` are separately characterized because `15.00 × 0.5%` currently returns backend `0.07` versus frontend `0.08`.
- Locate edits by quoted snippets and reread surrounding code; line numbers below describe current master and may drift.
- Stage only files listed by each task. Never use `git add -A`.

## Owner-Visible Result

Task 4 intentionally corrects held-order board estimates for multi-quantity fixed discounts. Example: `price=10`, `qty=2`, fixed discount `4`, tax `16%` changes from the incorrect displayed `18.56` to `13.92`. This changes no charged or persisted value; held cards re-estimate frozen cart data for display. Call out this corrected card total in the implementation handoff.

## Execution Preflight

- [ ] **Step 1: Record execution-start test baseline**

Run one process:

```bash
npx vitest run
```

Expected: zero failures. Record reported test-file and test counts in execution notes as `BASELINE_FILES` and `BASELINE_TESTS`; Final Verification requires at least `BASELINE_FILES + 2` files and `BASELINE_TESTS + 26` tests.

---

## File Structure

- `backend/services/PosCalculator.js` — backend line-net, rate-resolution, tax-stamp, and order-rollup authority.
- `backend/routes/pos/helpers.js` — existing route-facing re-export boundary; imports and exports new calculator helpers.
- `backend/routes/pos/checkout.js` — checkout persistence adapter; no direct `PosCalculator` import.
- `backend/routes/pos/tables.js` — table-save persistence adapter; no direct `PosCalculator` import.
- `src/utils/posTotals.js` — new pure frontend line/order math authority; no Vue, Pinia, DOM, or backend imports.
- `assets/js/composables/stores/orderSessionStore.js` — reactive adapter over `posTotals`; preserves current service-charge and display behavior.
- `src/utils/orderNotesTax.js` — held-order field-shape compatibility adapter over `posTotals`.
- `backend/tests/unit/posTotals.test.js` — pure frontend helper contract.
- `backend/tests/unit/posTotalsParity.test.js` — charged-field FE/BE differential grid plus discount-divergence lock.
- Existing integration suites — persistence and bundle-rule gates.

---

## Task 1: Backend tax-rate and tax-stamp authority

**Files:**
- Modify: `backend/services/PosCalculator.js`
- Modify: `backend/routes/pos/helpers.js`
- Modify: `backend/routes/pos/checkout.js`
- Modify: `backend/routes/pos/tables.js`
- Test: `backend/tests/unit/PosCalculator.test.js`

**Interfaces:**
- Produces: `resolveTaxRate(product, fallbackRate = 0) -> number`.
- Produces: `stampLineTax(item, taxRate, discountRatio = 1, taxInclusivePricing = false) -> number`.
- Preserves: route imports through `require('./helpers')`.

- [ ] **Step 1: Extend the existing calculator import and add failing helper tests**

In `backend/tests/unit/PosCalculator.test.js`, add `resolveTaxRate` and `stampLineTax` to the existing top-level destructure; do not add a second `require`. Append:

```javascript
describe('resolveTaxRate', () => {
    it('uses the catalog rate whenever a product row exists', () => {
        expect(resolveTaxRate({ tax_rate: 16 }, 99)).toBe(16);
    });

    it('treats a NULL catalog rate as zero instead of trusting fallback tax', () => {
        expect(resolveTaxRate({ tax_rate: null }, 99)).toBe(0);
    });

    it('uses a custom-line fallback only when no product row exists', () => {
        expect(resolveTaxRate(null, '8')).toBe(8);
    });

    it('returns zero for a non-finite custom-line fallback', () => {
        expect(resolveTaxRate(null, NaN)).toBe(0);
    });
});

describe('stampLineTax', () => {
    it('applies fixed line discount per unit before prorated exclusive tax', () => {
        const line = { price: 10, qty: 2, discountType: 'fixed', discountValue: 2 };
        expect(stampLineTax(line, 10, 0.5, false)).toBeCloseTo(0.8, 8);
    });

    it('applies percent line discount before prorated exclusive tax', () => {
        const line = { price: 10, qty: 2, discountType: 'percent', discountValue: 25 };
        expect(stampLineTax(line, 16, 0.5, false)).toBeCloseTo(1.2, 8);
    });

    it('stamps zero in tax-inclusive mode', () => {
        const line = { price: 10, qty: 2, discountType: null, discountValue: 0 };
        expect(stampLineTax(line, 16, 1, true)).toBe(0);
    });

    it('stamps zero for a zero-rate line', () => {
        const line = { price: 10, qty: 2, discountType: null, discountValue: 0 };
        expect(stampLineTax(line, 0, 1, false)).toBe(0);
    });
});
```

- [ ] **Step 2: Run the focused test and verify red state**

Run:

```bash
npx vitest run backend/tests/unit/PosCalculator.test.js
```

Expected: FAIL because `resolveTaxRate` and `stampLineTax` are not exported functions.

- [ ] **Step 3: Add helpers and route the backend rollup through `resolveTaxRate`**

In `backend/services/PosCalculator.js`, insert after `calculateLineTotal`:

```javascript
const resolveTaxRate = (product, fallbackRate = 0) =>
    toFiniteNumber(product ? (Number(product.tax_rate) || 0) : fallbackRate, 0);

const stampLineTax = (item, taxRate, discountRatio = 1, taxInclusivePricing = false) =>
    taxInclusivePricing
        ? 0
        : calculateLineTax(calculateLineTotal(item), taxRate, discountRatio);
```

Inside `calculateExpectedTotals`, replace:

```javascript
        const taxRate = toFiniteNumber(product ? (Number(product.tax_rate) || 0) : item.tax_rate, 0);
```

with:

```javascript
        const taxRate = resolveTaxRate(product, item.tax_rate);
```

Add both names to `module.exports`:

```javascript
    resolveTaxRate,
    stampLineTax,
```

- [ ] **Step 4: Run calculator tests and verify green state**

Run:

```bash
npx vitest run backend/tests/unit/PosCalculator.test.js
```

Expected: all `PosCalculator.test.js` tests pass.

- [ ] **Step 5: Expose both helpers through the existing route boundary**

In `backend/routes/pos/helpers.js`, add both names to the existing `PosCalculator` destructure:

```javascript
    calculateExpectedTotals,
    computeModifierSurcharge,
    resolveTaxRate,
    stampLineTax
```

Add both to `module.exports` beside existing calculator exports:

```javascript
    calculateExpectedTotals,
    resolveTaxRate,
    stampLineTax,
```

Do not add direct `PosCalculator` imports to either route.

- [ ] **Step 6: Replace checkout’s inline tax stamp**

In `backend/routes/pos/checkout.js`, replace `calculateLineTax` in the existing `require('./helpers')` destructure with:

```javascript
    resolveTaxRate,
    stampLineTax,
```

Inside the item persistence loop, keep `const product = ...` and replace the inline rate/line-total/tax block with:

```javascript
                const taxRate = resolveTaxRate(product, item.tax_rate);
                const taxAmount = stampLineTax(
                    item,
                    taxRate,
                    discountRatio,
                    taxInclusivePricing
                );
```

- [ ] **Step 7: Replace table-save’s inline tax stamp**

In `backend/routes/pos/tables.js`, replace `calculateLineTax` in the existing `require('./helpers')` destructure with:

```javascript
    resolveTaxRate,
    stampLineTax,
```

Inside the item persistence loop, keep `const product = ...` and replace the inline rate/line-total/tax block with:

```javascript
                const taxRate = resolveTaxRate(product, item.tax_rate);
                const taxAmount = stampLineTax(
                    item,
                    taxRate,
                    expectedTotals.discountRatio,
                    taxInclusivePricing
                );
```

- [ ] **Step 8: Replace open-order healing’s inline tax stamp**

In `backend/routes/pos/helpers.js`, inside `recomputeOrderTotals`, replace the inline rate/line-total/tax block with:

```javascript
        const taxRate = resolveTaxRate(product, it.tax_rate);
        const lineLike = {
            price: it.price_at_sale,
            qty: it.quantity,
            discountType: it.discount_type,
            discountValue: it.discount_value
        };
        const taxAmount = stampLineTax(
            lineLike,
            taxRate,
            expected.discountRatio,
            taxInclusivePricing
        );
```

Keep the bundle-child skip immediately above this block.

- [ ] **Step 9: Run route and persistence gates**

Run one Vitest process:

```bash
npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/taxSourceOfTruth.test.js backend/tests/integration/bundle.checkout.test.js backend/tests/integration/bundle.tables.test.js
```

Expected: all selected tests pass. In particular, checkout/table routes must not throw `resolveTaxRate is not a function` or `stampLineTax is not a function`.

- [ ] **Step 10: Review diff for forbidden scope**

Run:

```bash
git diff -- backend/services/PosCalculator.js backend/routes/pos/helpers.js backend/routes/pos/checkout.js backend/routes/pos/tables.js backend/tests/unit/PosCalculator.test.js
```

Expected: no changes to service-charge formulas, receipts, bundle reconstruction, refunds, tolerance, or rounding.

- [ ] **Step 11: Commit backend authority**

```bash
git add backend/services/PosCalculator.js backend/routes/pos/helpers.js backend/routes/pos/checkout.js backend/routes/pos/tables.js backend/tests/unit/PosCalculator.test.js
git commit -m "refactor(pos): centralize backend line tax stamping"
```

---

## Task 2: Pure frontend totals authority and charged-field parity

**Files:**
- Create: `src/utils/posTotals.js`
- Create: `backend/tests/unit/posTotals.test.js`
- Create: `backend/tests/unit/posTotalsParity.test.js`

**Interfaces:**
- Produces: `roundMoney(value) -> number`.
- Produces: `lineNet(item) -> number`.
- Produces: `lineTax(item, discountRatio = 1, opts = {}) -> number`.
- Produces: `lineGross(item, opts = {}) -> number`.
- Produces: `orderDiscountAmount(rawSubtotal, discount = {}) -> number`.
- Produces: `posTotals(items, discount = {}, opts = {}) -> { subtotal, discount, discountedSubtotal, tax, total, discountRatio }`.
- Consumes: `calculateExpectedTotals()` only from tests; production helper remains frontend-only.

- [ ] **Step 1: Add failing pure-helper unit tests**

Create `backend/tests/unit/posTotals.test.js`:

```javascript
import { describe, expect, it } from 'vitest';
import {
    lineGross,
    lineNet,
    lineTax,
    orderDiscountAmount,
    posTotals,
    roundMoney
} from '../../../src/utils/posTotals.js';

describe('posTotals pure frontend authority', () => {
    it('uses the existing roundMoney formula', () => {
        expect(roundMoney(1.005)).toBe(1.01);
        expect(roundMoney('bad')).toBe(0);
    });

    it('computes fixed discount per unit and percent discount per line', () => {
        expect(lineNet({ price: 10, qty: 3, discountType: 'fixed', discountValue: 2 })).toBe(24);
        expect(lineNet({ price: 10, qty: 2, discountType: 'percent', discountValue: 25 })).toBe(15);
    });

    it('clamps line net at zero and guards blank numbers', () => {
        expect(lineNet({ price: 2, qty: 2, discountType: 'fixed', discountValue: 5 })).toBe(0);
        expect(lineNet({ price: '', qty: 2 })).toBe(0);
    });

    it('calculates exclusive tax and suppresses exempt/inclusive tax', () => {
        const line = { price: 10, qty: 2, tax_rate: 16 };
        expect(lineTax(line, 0.5)).toBeCloseTo(1.6, 8);
        expect(lineTax(line, 1, { taxExempt: true })).toBe(0);
        expect(lineTax(line, 1, { taxInclusive: true })).toBe(0);
    });

    it('calculates gross display and honors explicit mode flags', () => {
        const line = { price: 10, qty: 2, tax_rate: 16 };
        expect(lineGross(line)).toBeCloseTo(23.2, 8);
        expect(lineGross(line, { taxExempt: true })).toBe(20);
        expect(lineGross(line, { taxInclusive: true })).toBe(20);
    });

    it('preserves current order-discount amount behavior', () => {
        expect(orderDiscountAmount(10, { type: 'fixed', value: 99 })).toBe(10);
        expect(orderDiscountAmount(15, { type: 'percent', value: 0.5 })).toBe(0.075);
        expect(orderDiscountAmount(10, { type: 'percent', value: -5 })).toBe(0);
    });

    it('returns rounded cart totals while adding raw tax before final rounding', () => {
        const result = posTotals(
            [{ price: 10, qty: 1, tax_rate: 16 }],
            { type: 'percent', value: 10 }
        );
        expect(result).toMatchObject({
            subtotal: 10,
            discount: 1,
            discountedSubtotal: 9,
            tax: 1.44,
            total: 10.44
        });
    });

    it('keeps inclusive totals at discounted price with zero rollup tax', () => {
        const result = posTotals(
            [{ price: 10, qty: 1, tax_rate: 16 }],
            { type: 'fixed', value: 2 },
            { taxInclusive: true }
        );
        expect(result).toMatchObject({ subtotal: 10, discount: 2, tax: 0, total: 8 });
    });
});
```

- [ ] **Step 2: Run helper test and verify red state**

Run:

```bash
npx vitest run backend/tests/unit/posTotals.test.js
```

Expected: FAIL because `src/utils/posTotals.js` does not exist.

- [ ] **Step 3: Implement the pure ESM helper**

Create `src/utils/posTotals.js`:

```javascript
const parseFinite = (value, fallback = 0) => {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const roundMoney = (value) => {
    const parsed = Number(value);
    const finite = Number.isFinite(parsed) ? parsed : 0;
    return Math.round((finite + Number.EPSILON) * 100) / 100;
};

export const lineNet = (item = {}) => {
    const qty = parseFinite(item.qty);
    let total = parseFinite(item.price) * qty;
    const discountValue = parseFinite(item.discountValue);

    if (item.discountType === 'fixed') total -= discountValue * qty;
    if (item.discountType === 'percent') total -= total * (discountValue / 100);

    return Math.max(0, total);
};

export const orderDiscountAmount = (rawSubtotal, discount = {}) => {
    const subtotal = Math.max(0, parseFinite(rawSubtotal));
    const value = parseFinite(discount?.value);
    if (!(value > 0)) return 0;
    if (discount?.type === 'fixed') return Math.min(subtotal, value);
    if (discount?.type === 'percent') return subtotal * (value / 100);
    return 0;
};

export const lineTax = (item, discountRatio = 1, opts = {}) => {
    if (opts.taxExempt || opts.taxInclusive) return 0;
    const rate = parseFinite(item?.tax_rate);
    if (rate === 0) return 0;
    const parsedRatio = Number(discountRatio);
    const ratio = Number.isFinite(parsedRatio) ? parsedRatio : 1;
    return lineNet(item) * ratio * (rate / 100);
};

export const lineGross = (item, opts = {}) => {
    const net = lineNet(item);
    if (opts.taxExempt || opts.taxInclusive) return net;
    return net * (1 + parseFinite(item?.tax_rate) / 100);
};

export const posTotals = (items, discount = {}, opts = {}) => {
    const cart = Array.isArray(items) ? items : [];
    const rawSubtotal = cart.reduce((sum, item) => sum + lineNet(item), 0);
    const rawDiscount = orderDiscountAmount(rawSubtotal, discount);
    const rawDiscountedSubtotal = Math.max(0, rawSubtotal - rawDiscount);
    const discountRatio = rawSubtotal > 0.0001
        ? rawDiscountedSubtotal / rawSubtotal
        : 1;
    const rawTax = cart.reduce(
        (sum, item) => sum + lineTax(item, discountRatio, opts),
        0
    );

    return {
        subtotal: roundMoney(rawSubtotal),
        discount: roundMoney(rawDiscount),
        discountedSubtotal: roundMoney(rawDiscountedSubtotal),
        tax: roundMoney(rawTax),
        total: opts.taxInclusive
            ? roundMoney(rawDiscountedSubtotal)
            : roundMoney(rawDiscountedSubtotal + rawTax),
        discountRatio
    };
};
```

- [ ] **Step 4: Run helper tests and verify green state**

Run:

```bash
npx vitest run backend/tests/unit/posTotals.test.js
```

Expected: all `posTotals.test.js` tests pass.

- [ ] **Step 5: Add charged-field differential parity and discount-divergence tests**

Create `backend/tests/unit/posTotalsParity.test.js`:

```javascript
import { describe, expect, it } from 'vitest';
import calculator from '../../services/PosCalculator.js';
import { posTotals } from '../../../src/utils/posTotals.js';

const { calculateExpectedTotals } = calculator;

const expectChargedParity = ({ cart, orderDiscount, productMap, taxInclusive = false }) => {
    const frontend = posTotals(cart, orderDiscount, { taxInclusive });
    const backend = calculateExpectedTotals(
        {
            order_discount_type: orderDiscount.type,
            order_discount_value: orderDiscount.value
        },
        cart,
        productMap,
        taxInclusive
    );

    expect(frontend.subtotal).toBe(backend.subtotal);
    expect(frontend.tax).toBe(backend.tax);
    expect(frontend.total).toBe(backend.total);
    return { frontend, backend };
};

describe('posTotals charged-field parity with PosCalculator', () => {
    it('matches over a deterministic valid-input grid', () => {
        const prices = [0, 0.01, 1.005, 5, 12.345];
        const quantities = [0.25, 1, 2, 3];
        const lineDiscounts = [
            { type: null, value: 0 },
            { type: 'fixed', value: 0.5 },
            { type: 'percent', value: 10 },
            { type: 'percent', value: 100 }
        ];
        const rates = [0, 5, 16, 100];
        const orderDiscounts = [
            { type: null, value: 0 },
            { type: 'fixed', value: 0.5 },
            { type: 'percent', value: 0.5 },
            { type: 'percent', value: 25 },
            { type: 'percent', value: 100 }
        ];

        for (const price of prices) {
            for (const qty of quantities) {
                for (const lineDiscount of lineDiscounts) {
                    for (const taxRate of rates) {
                        for (const orderDiscount of orderDiscounts) {
                            for (const taxInclusive of [false, true]) {
                                const cart = [{
                                    product_id: 1,
                                    price,
                                    qty,
                                    tax_rate: taxRate,
                                    discountType: lineDiscount.type,
                                    discountValue: lineDiscount.value
                                }];
                                expectChargedParity({
                                    cart,
                                    orderDiscount,
                                    productMap: new Map([[1, { id: 1, tax_rate: taxRate }]]),
                                    taxInclusive
                                });
                            }
                        }
                    }
                }
            }
        }
    });

    it('matches a custom line whose frozen tax rate is the fallback authority', () => {
        expectChargedParity({
            cart: [{
                product_id: null,
                price: '7.500000',
                qty: '2.0000',
                tax_rate: '8.0000',
                discountType: 'fixed',
                discountValue: '0.5000'
            }],
            orderDiscount: { type: 'percent', value: 10 },
            productMap: new Map()
        });
    });

    it('uses NULL catalog tax as zero instead of client fallback tax', () => {
        const { backend } = expectChargedParity({
            cart: [{ product_id: 1, price: 10, qty: 1, tax_rate: null }],
            orderDiscount: { type: null, value: 0 },
            productMap: new Map([[1, { id: 1, tax_rate: null }]])
        });
        expect(backend.tax).toBe(0);
    });

    it('locks the known half-cent discount-display divergence without changing charges', () => {
        const { frontend, backend } = expectChargedParity({
            cart: [{ product_id: 1, price: 5, qty: 3, tax_rate: 16 }],
            orderDiscount: { type: 'percent', value: 0.5 },
            productMap: new Map([[1, { id: 1, tax_rate: 16 }]])
        });

        expect(frontend.discount).toBe(0.08);
        expect(backend.discount).toBe(0.07);
    });
});
```

- [ ] **Step 6: Run pure and differential tests**

Run:

```bash
npx vitest run backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js backend/tests/unit/roundingSimulation.test.js
```

Expected: all selected tests pass; parity assertions cover only `subtotal`, `tax`, and `total`.

- [ ] **Step 7: Commit pure frontend authority**

```bash
git add src/utils/posTotals.js backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js
git commit -m "feat(pos): add pure frontend totals authority"
```

---

## Task 3: Delegate live store math without financial behavior changes

**Files:**
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Test: `backend/tests/unit/orderSessionStore.test.js`

**Interfaces:**
- Consumes: `roundMoney`, `lineNet`, `orderDiscountAmount`, `posTotals` from Task 2.
- Preserves: all public store getter/action names and return types.
- Preserves: current service-charge formulas and current `getItemTotalGross` inclusive-mode behavior.

- [ ] **Step 1: Add characterization tests before changing the store**

Append to `backend/tests/unit/orderSessionStore.test.js`:

```javascript
describe('Part C behavior-preservation locks', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockTerminalState.taxInclusivePricing.value = false;
  });

  it('keeps the existing frontend half-cent discount display at 0.08', () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 5, qty: 3, tax_rate: 16, discountType: null, discountValue: 0 }];
    s.orderDiscount = { type: 'percent', value: 0.5 };
    expect(s.cartOrderDiscountAmount).toBe(0.08);
    expect(s.cartTax).toBe(2.39);
    expect(s.cartTotal).toBe(17.31);
  });

  it('keeps addServiceCharge rounded-base plus toFixed behavior', () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: 0.045, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
    s.addServiceCharge();
    const fee = s.cart.find(item => String(item.id).startsWith('FEE_'));
    expect(fee.price).toBe(0.01);
  });

  it('keeps updateServiceCharge raw-base plus toFixed behavior', () => {
    const s = useOrderSessionStore();
    s.cart = [
      { id: 1, price: 0.045, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 },
      { id: 'FEE_TEST', name: '10% Service Charge', price: 99, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }
    ];
    s.updateServiceCharge();
    const fee = s.cart.find(item => String(item.id).startsWith('FEE_'));
    expect(fee.price).toBe(0);
  });

  it('keeps existing gross-row behavior in inclusive mode during this refactor', () => {
    const s = useOrderSessionStore();
    mockTerminalState.taxInclusivePricing.value = true;
    const line = { id: 1, price: 10, qty: 1, tax_rate: 16, discountType: null, discountValue: 0 };
    expect(s.getItemTotalGross(line)).toBeCloseTo(11.6, 8);
  });
});
```

- [ ] **Step 2: Run characterization tests before refactor**

Run:

```bash
npx vitest run backend/tests/unit/orderSessionStore.test.js
```

Expected: all tests pass before implementation. If any new characterization fails, stop and correct expected current behavior before editing production code.

- [ ] **Step 3: Import pure helpers and remove local `roundMoney`**

After existing imports in `assets/js/composables/stores/orderSessionStore.js`, add:

```javascript
import {
  lineNet,
  orderDiscountAmount,
  posTotals,
  roundMoney
} from '../../../../src/utils/posTotals.js';
```

Delete the local `const roundMoney = ...` block. Imported `roundMoney` remains module-scoped, so `distributeOrderDiscount` continues using the same name.

- [ ] **Step 4: Delegate service-charge base only; preserve fee rounding**

Inside `updateServiceCharge`, replace only the goods reduce with:

```javascript
    const subtotalWithoutFees = cart.value
      .filter(item => !String(item.id).startsWith('FEE_'))
      .reduce((sum, item) => sum + lineNet(item), 0);
```

Keep this exact fee line unchanged:

```javascript
      const newFee = parseFloat((subtotalWithoutFees * (pct / 100)).toFixed(2));
```

Keep `addServiceCharge` unchanged, including:

```javascript
    const fee = parseFloat((cartSubtotal.value * (pct / 100)).toFixed(2));
```

- [ ] **Step 5: Replace store money computeds with helper delegation**

Replace the block from `rawSubtotal` through `cartTotal` with:

```javascript
  const rawSubtotal = computed(() =>
    cart.value.reduce((sum, item) => sum + lineNet(item), 0)
  );

  const cartSubtotal = computed(() => roundMoney(rawSubtotal.value));

  const cartOrderDiscountAmount = computed(() =>
    roundMoney(orderDiscountAmount(rawSubtotal.value, orderDiscount.value))
  );

  const rawDiscountedSubtotal = computed(() =>
    Math.max(
      0,
      rawSubtotal.value - orderDiscountAmount(rawSubtotal.value, orderDiscount.value)
    )
  );

  const discountedSubtotal = computed(() => roundMoney(rawDiscountedSubtotal.value));

  const totals = computed(() => {
    const deps = getDeps();
    return posTotals(cart.value, orderDiscount.value, {
      taxExempt: isTaxExempt.value,
      taxInclusive: !!deps.terminal.taxInclusivePricing?.value
    });
  });

  const cartTax = computed(() => totals.value.tax);
  const cartTotal = computed(() => totals.value.total);
```

This removes `rawCartTax`. No consumer outside the store return object uses it, and it is not exposed.

- [ ] **Step 6: Delegate remaining line-net copies while preserving gross display**

Replace `getItemTotal` with:

```javascript
  const getItemTotal = (item) => lineNet(item);
```

Replace `getItemTotalGross` with the following behavior-preserving version; do not pass `taxInclusive` in this task:

```javascript
  const getItemTotalGross = (item) => {
    const pretax = lineNet(item);
    if (isTaxExempt.value) return pretax;
    const rate = parseFloat(item.tax_rate) || 0;
    return pretax * (1 + rate / 100);
  };
```

Replace `getSeatTotal` with:

```javascript
  const getSeatTotal = (seat) =>
    roundMoney(seat.items.reduce((sum, item) => sum + lineNet(item), 0)).toFixed(2);
```

Keep `cartGrossSubtotal`, store exports, and `useCart.js` unchanged.

- [ ] **Step 7: Add blank-price regression test**

Append inside the money-getter test area:

```javascript
  it('treats a blank-price taxable line as zero instead of NaN', () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, price: '', qty: 2, tax_rate: 16, discountType: null, discountValue: 0 }];
    expect(s.cartSubtotal).toBe(0);
    expect(s.cartTax).toBe(0);
    expect(s.cartTotal).toBe(0);
  });
```

- [ ] **Step 8: Run store, rounding, and pure-helper tests**

Run:

```bash
npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js backend/tests/unit/roundingSimulation.test.js
```

Expected: all selected tests pass, including service-charge and inclusive-gross characterization tests unchanged.

- [ ] **Step 9: Build Vite bundles**

Run:

```bash
npm run build:admin
```

Expected: build succeeds and resolves `../../../../src/utils/posTotals.js` from the store.

- [ ] **Step 10: Review diff for accidental behavior changes**

Run:

```bash
git diff -- assets/js/composables/stores/orderSessionStore.js backend/tests/unit/orderSessionStore.test.js
```

Expected:

- no changes to `addServiceCharge`;
- `updateServiceCharge` retains `toFixed(2)`;
- `getItemTotalGross` still ignores tax-inclusive mode;
- no `useCart.js` or component changes;
- no receipt changes.

- [ ] **Step 11: Commit store delegation**

```bash
git add assets/js/composables/stores/orderSessionStore.js backend/tests/unit/orderSessionStore.test.js
git commit -m "refactor(pos): delegate store totals to pure authority"
```

---

## Task 4: Delegate held-order totals and lock retained rules

**Files:**
- Modify: `src/utils/orderNotesTax.js`
- Test: `src/utils/orderNotesTax.spec.js`
- Verify only: `backend/tests/integration/bundle.tables.test.js`

**Interfaces:**
- Consumes: `lineNet`, `orderDiscountAmount`, `posTotals` from Task 2.
- Preserves: `itemLineNet`, `applyOrderDiscount`, and `heldOrderTotal` exports.
- Visible correction: a fixed line discount is per-unit for held-order cards, matching live cart and backend.

- [ ] **Step 1: Add failing held-order fixed-discount regression**

In `src/utils/orderNotesTax.spec.js`, extend the fixed-discount test with quantity greater than one:

```javascript
  it('applies a fixed item discount per unit for multi-quantity held lines', () => {
    const item = {
      price: 10,
      qty: 2,
      discountType: 'fixed',
      discountValue: 4,
      tax_rate: 16
    };
    expect(itemLineNet(item)).toBe(12);
    expect(heldOrderTotal([item], null, false)).toBe(13.92);
  });
```

- [ ] **Step 2: Run held-order tests and verify red state**

Run:

```bash
npx vitest run src/utils/orderNotesTax.spec.js
```

Expected: FAIL because current `itemLineNet` subtracts fixed discount once and returns `16`.

- [ ] **Step 3: Replace held-order formulas with a field-shape adapter**

Replace `src/utils/orderNotesTax.js` with:

```javascript
import {
  lineNet,
  orderDiscountAmount,
  posTotals
} from './posTotals.js';

const normalizeHeldItem = (item) => {
  const source = item || {};
  return {
    price: source.price ?? source.price_at_sale ?? 0,
    qty: source.qty ?? source.quantity ?? 0,
    discountType: source.discountType ?? source.discount_type ?? null,
    discountValue: source.discountValue ?? source.discount_value ?? 0,
    tax_rate: source.tax_rate ?? source.taxRate ?? 0
  };
};

export function itemLineNet(item) {
  return lineNet(normalizeHeldItem(item));
}

export function applyOrderDiscount(subtotal, orderDiscount) {
  const rawSubtotal = Number.isFinite(Number(subtotal)) ? Number(subtotal) : 0;
  return Math.max(
    0,
    rawSubtotal - orderDiscountAmount(rawSubtotal, orderDiscount || {})
  );
}

export function heldOrderTotal(items, orderDiscount, taxInclusive) {
  const normalized = Array.isArray(items)
    ? items.map(normalizeHeldItem)
    : [];
  return posTotals(normalized, orderDiscount || {}, {
    taxInclusive: !!taxInclusive
  }).total;
}
```

- [ ] **Step 4: Run held-order and helper tests**

Run:

```bash
npx vitest run src/utils/orderNotesTax.spec.js backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js
```

Expected: all selected tests pass; multi-quantity fixed discount returns `12` net and `13.92` total.

- [ ] **Step 5: Verify and report the owner-visible held-card correction**

Before the bundle check, verify the owner-visible held-card example through the helper used by `OrderNotes.vue`:

```bash
npx vitest run src/utils/orderNotesTax.spec.js -t "multi-quantity held lines"
```

Expected: PASS with line net `12` and held total `13.92`; implementation handoff explicitly mentions this display correction.

- [ ] **Step 6: Verify bundle money ownership remains locked**

No bundle production edit is allowed. Run existing explicit parent/child assertions:

```bash
npx vitest run backend/tests/integration/bundle.tables.test.js backend/tests/integration/bundle.checkout.test.js
```

Expected: bundle parent carries tax; every bundle child keeps `price_at_sale = 0`, `tax_rate = 0`, and `tax_amount = 0`.

- [ ] **Step 7: Commit held-order delegation**

```bash
git add src/utils/orderNotesTax.js src/utils/orderNotesTax.spec.js
git commit -m "fix(pos): unify held-order total calculation"
```

---

## Final Verification

- [ ] **Step 1: Run complete test suite once**

```bash
npx vitest run
```

Expected: zero failures. Test-file count is at least the execution-start baseline plus `2`; test count is at least the execution-start baseline plus `26`. If counts are lower, identify the missing planned tests. Higher counts from intervening master changes are valid and must not be treated as failure.

- [ ] **Step 2: Run production build**

```bash
npm run build:admin
```

Expected: Vite production build succeeds.

- [ ] **Step 3: Run whitespace and scope checks**

```bash
git diff --check master...HEAD
git diff --stat master...HEAD
git status --short
```

Expected: no whitespace errors; only files named by Tasks 1-4 changed; user-owned unrelated untracked files remain unstaged.

- [ ] **Step 4: Audit forbidden touch-points**

Run:

```bash
git diff --name-only master...HEAD
```

Expected: none of these files changed:

```text
backend/services/bundleOrderItems.js
backend/routes/pos/refunds.js
src/utils/receiptLineTotals.js
src/components/pos/ReceiptPreviewModal.vue
src/print/PrintReceiptApp.vue
src/components/PosTerminal.vue
assets/js/composables/useCart.js
```

- [ ] **Step 5: Confirm no deferred behavior leaked into code**

Search:

```bash
rg -n "tax_exempt|receiptTotalsBlock|serviceChargeFee|getItemUnitGross" backend assets src
```

Expected: no new implementation from this plan for those deferred interfaces. Existing tax-exempt client references may remain unchanged.

---

## Deferred Follow-Up Plans

These require separate owner approval and must not be appended to this implementation branch:

1. **Tax-exempt sale contract** — server authorization, request/persistence schema, line stamps, tables, receipts, refunds, audit.
2. **Service-charge canonicalization** — choose raw or rounded base and `toFixed(2)` or `roundMoney`; migrate with financial regression tests.
3. **Receipt/display consistency** — choose net or gross line columns; define discount/tax field precedence for live, held, split, duplicate, and DB-reprint payloads.
4. **Tax-inclusive cart-row/product-card display** — owner-visible catalog versus order-context pricing policy.
5. **Bundle corrupt-parent recovery** — fail-fast versus explicit recovery for non-positive parent quantity.

## Self-Review Checklist

- Spec coverage: backend authority, frontend authority, store delegation, held-order adapter, service-charge preservation, discount divergence, bundle rule, and deferred scope all map to exact steps.
- Type consistency: `posTotals` signatures match every test and consumer snippet.
- Import consistency: routes import new backend helpers only through `./helpers`; store uses `../../../../src/utils/posTotals.js`; held adapter uses `./posTotals.js`.
- Behavior consistency: charged parity excludes `discount`; service-charge rounding remains untouched; inclusive gross display remains characterized, not fixed.
- Incomplete-instruction scan: no unfinished implementation instructions or unnamed tests remain.
