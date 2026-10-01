// unit/PosCalculator.test.js — Extended unit test suite for PosCalculator.js
// Replaces the original 6-test version with comprehensive edge-case coverage.
// All tests are pure: no DB, no HTTP, no mocks needed.

// globals are used directly since globals: true is enabled in vitest config
const {
    toFiniteNumber,
    roundMoney,
    normalizeDiscount,
    normalizeCartItems,
    calculateLineTotal,
    calculateLineTax,
    calculateExpectedTotals,
    computeModifierSurcharge,
    resolveTaxRate,
    stampLineTax,
    resolveLineTaxRate,
    resolveEffectiveTaxRate,
    sanitizeSelectedModifiers,
    resolveModifierSelections,
} = require('../../services/PosCalculator');

// ─── 1. toFiniteNumber ────────────────────────────────────────────────────────
describe('toFiniteNumber', () => {
    it('returns numeric values as-is', () => {
        expect(toFiniteNumber(5)).toBe(5);
        expect(toFiniteNumber(0)).toBe(0);
        expect(toFiniteNumber(-3.5)).toBe(-3.5);
    });

    it('parses numeric strings', () => {
        expect(toFiniteNumber('5.5')).toBe(5.5);
        expect(toFiniteNumber('0')).toBe(0);
        expect(toFiniteNumber('100')).toBe(100);
    });

    it('returns fallback for non-numeric strings', () => {
        expect(toFiniteNumber('invalid', 10)).toBe(10);
        expect(toFiniteNumber('', 0)).toBe(0);
        expect(toFiniteNumber('abc', 99)).toBe(99);
    });

    it('returns fallback for null and undefined', () => {
        expect(toFiniteNumber(null, 0)).toBe(0);
        expect(toFiniteNumber(undefined, 42)).toBe(42);
    });

    it('returns fallback for Infinity and NaN', () => {
        expect(toFiniteNumber(Infinity, 0)).toBe(0);
        expect(toFiniteNumber(-Infinity, 1)).toBe(1);
        expect(toFiniteNumber(NaN, 5)).toBe(5);
    });

    it('default fallback is 0 when not provided', () => {
        expect(toFiniteNumber('bad')).toBe(0);
        expect(toFiniteNumber(null)).toBe(0);
    });
});

// ─── 2. roundMoney ───────────────────────────────────────────────────────────
describe('roundMoney', () => {
    it('rounds to 2 decimal places correctly', () => {
        expect(roundMoney(10.123)).toBe(10.12);
        expect(roundMoney(10.127)).toBe(10.13);
        expect(roundMoney(10.125)).toBe(10.13); // epsilon rounding
        expect(roundMoney(10.115)).toBe(10.12);
    });

    it('handles small values that round to zero', () => {
        expect(roundMoney(0.004)).toBe(0);
        expect(roundMoney(0.001)).toBe(0);
    });

    it('handles exact values without drift', () => {
        expect(roundMoney(5.00)).toBe(5.00);
        expect(roundMoney(0.10)).toBe(0.10);
        expect(roundMoney(1.99)).toBe(1.99);
    });

    it('handles the classic floating-point trap: 1.005', () => {
        // Without Number.EPSILON correction: Math.round(1.005 * 100) / 100 === 1.00 (bug)
        // With epsilon: roundMoney(1.005) === 1.01
        expect(roundMoney(1.005)).toBe(1.01);
    });

    it('handles negative values', () => {
        expect(roundMoney(-1.005)).toBe(-1.00); // epsilon rounding symmetry
        expect(roundMoney(-10.127)).toBe(-10.13);
    });

    it('handles zero', () => {
        expect(roundMoney(0)).toBe(0);
        expect(roundMoney(-0)).toBe(0);
    });

    it('handles large values', () => {
        expect(roundMoney(99999.999)).toBe(100000.00);
        expect(roundMoney(12345.678)).toBe(12345.68);
    });

    // CRITICAL: frontend useCart.js has its own roundMoney — must produce identical results
    it('produces identical results to the frontend roundMoney formula', () => {
        // Frontend: Math.round((toFinite + Number.EPSILON) * 100) / 100
        const frontendRoundMoney = (val) => {
            const num = Number(val);
            const toFinite = Number.isFinite(num) ? num : 0;
            return Math.round((toFinite + Number.EPSILON) * 100) / 100;
        };
        const cases = [0, 0.1, 0.005, 1.005, 10.125, 99.999, 5.50, 2.335];
        for (const v of cases) {
            expect(roundMoney(v)).toBe(frontendRoundMoney(v));
        }
    });
});

// ─── 3. normalizeDiscount ─────────────────────────────────────────────────────
describe('normalizeDiscount', () => {
    it('accepts valid percent discount', () => {
        expect(normalizeDiscount('percent', 15, 'Discount')).toEqual({ type: 'percent', value: 15 });
    });

    it('accepts valid fixed discount', () => {
        expect(normalizeDiscount('fixed', 5.5, 'Discount')).toEqual({ type: 'fixed', value: 5.5 });
    });

    it('accepts zero with null type', () => {
        expect(normalizeDiscount(null, 0, 'Discount')).toEqual({ type: null, value: 0 });
    });

    it('accepts zero with undefined type', () => {
        expect(normalizeDiscount(undefined, 0, 'Discount')).toEqual({ type: null, value: 0 });
    });

    it('throws on negative discount value', () => {
        expect(() => normalizeDiscount('percent', -5, 'Order discount')).toThrow('Order discount cannot be negative');
    });

    it('throws when percent exceeds 100', () => {
        expect(() => normalizeDiscount('percent', 105, 'Item discount')).toThrow('exceed 100%');
    });

    it('throws on nonzero value with invalid type', () => {
        expect(() => normalizeDiscount('invalid', 10, 'Order discount')).toThrow('type is invalid');
    });

    it('does NOT throw on nonzero value with null type when value is 0', () => {
        // Zero value with any type — the type is irrelevant when value is 0
        expect(() => normalizeDiscount('invalid', 0, 'Discount')).not.toThrow();
    });

    it('accepts exactly 100% discount', () => {
        expect(normalizeDiscount('percent', 100, 'Discount')).toEqual({ type: 'percent', value: 100 });
    });
});

// ─── 4. normalizeCartItems ────────────────────────────────────────────────────
describe('normalizeCartItems', () => {
    const validItem = { id: 1, qty: 2, price: 5, discountType: null, discountValue: 0 };

    it('normalizes a valid cart item', () => {
        const result = normalizeCartItems([validItem]);
        expect(result).toHaveLength(1);
        expect(result[0].qty).toBe(2);
        expect(result[0].price).toBe(5);
        expect(result[0].product_id).toBe(1);
    });

    it('throws on empty cart', () => {
        expect(() => normalizeCartItems([])).toThrow('Cart is empty');
    });

    it('throws on non-array input', () => {
        expect(() => normalizeCartItems(null)).toThrow();
        expect(() => normalizeCartItems('string')).toThrow();
    });

    it('throws on invalid quantity (zero)', () => {
        expect(() => normalizeCartItems([{ ...validItem, qty: 0 }])).toThrow('Invalid quantity');
    });

    it('throws on invalid quantity (negative)', () => {
        expect(() => normalizeCartItems([{ ...validItem, qty: -1 }])).toThrow('Invalid quantity');
    });

    it('throws on invalid quantity (string)', () => {
        expect(() => normalizeCartItems([{ ...validItem, qty: 'abc' }])).toThrow('Invalid quantity');
    });

    it('throws on negative price', () => {
        expect(() => normalizeCartItems([{ ...validItem, price: -1 }])).toThrow('Invalid price');
    });

    it('accepts price of zero (custom/free items)', () => {
        const result = normalizeCartItems([{ ...validItem, price: 0 }]);
        expect(result[0].price).toBe(0);
    });

    it('normalizes product_id from item.id', () => {
        const result = normalizeCartItems([{ ...validItem, id: 42 }]);
        expect(result[0].product_id).toBe(42);
    });

    it('sets product_id to null for non-integer id (custom items)', () => {
        const result = normalizeCartItems([{ ...validItem, id: 'CUSTOM_123' }]);
        expect(result[0].product_id).toBeNull();
    });

    it('normalizes string qty and price', () => {
        const result = normalizeCartItems([{ ...validItem, qty: '3', price: '10.5' }]);
        expect(result[0].qty).toBe(3);
        expect(result[0].price).toBe(10.5);
    });
});

// ─── 5. calculateLineTotal ────────────────────────────────────────────────────
describe('calculateLineTotal', () => {
    it('calculates basic line total without discount', () => {
        expect(calculateLineTotal({ price: 5, qty: 3, discountType: null, discountValue: 0 })).toBe(15);
    });

    it('applies fixed discount per unit', () => {
        // (price - fixedDiscount) * qty
        expect(calculateLineTotal({ price: 5, qty: 3, discountType: 'fixed', discountValue: 1 })).toBe(12);
    });

    it('applies percent discount on line total', () => {
        // 10 * 2 = 20, 10% off = 18
        expect(calculateLineTotal({ price: 10, qty: 2, discountType: 'percent', discountValue: 10 })).toBe(18);
    });

    it('caps at zero — negative totals become 0', () => {
        expect(calculateLineTotal({ price: 2, qty: 1, discountType: 'fixed', discountValue: 5 })).toBe(0);
    });

    it('handles 100% discount (line total = 0)', () => {
        expect(calculateLineTotal({ price: 10, qty: 2, discountType: 'percent', discountValue: 100 })).toBe(0);
    });

    it('handles fractional quantities', () => {
        const result = calculateLineTotal({ price: 10, qty: 0.5, discountType: null, discountValue: 0 });
        expect(result).toBe(5);
    });

    it('handles high-precision price values', () => {
        const result = calculateLineTotal({ price: 5.0001, qty: 2, discountType: null, discountValue: 0 });
        expect(result).toBeCloseTo(10.0002, 4);
    });
});

// ─── 6. calculateLineTax ─────────────────────────────────────────────────────
describe('calculateLineTax', () => {
    it('calculateLineTax(100, 8, 0.9) === 100*0.9*0.08 (prorated tax)', () => {
        expect(calculateLineTax(100, 8, 0.9)).toBe(100 * 0.9 * 0.08);
    });

    it('calculateLineTax(-5, 8, 1) === 0 (clamps negative lineTotal)', () => {
        expect(calculateLineTax(-5, 8, 1)).toBe(0);
    });

    it('returns 0 when taxRate is 0', () => {
        expect(calculateLineTax(100, 0, 0.9)).toBe(0);
    });

    it('defaults discountRatio to 1 when omitted', () => {
        expect(calculateLineTax(50, 16)).toBe(50 * 1 * 0.16);
    });

    it('full discount (discountRatio=0) yields 0 tax', () => {
        expect(calculateLineTax(100, 16, 0)).toBe(0);
    });
});

describe('income-tax registration calculations', () => {
    it('uses entered item and modifier prices, applies discounts, and charges zero sales tax', () => {
        const catalog = new Map([
            [1, { id: 1, tax_rate: 16 }],
            [2, { id: 2, tax_rate: 8 }]
        ]);
        const cart = [
            {
                product_id: 1,
                price: 10,
                qty: 2,
                tax_rate: 16,
                discountType: 'percent',
                discountValue: 10
            },
            {
                product_id: 2,
                price: 5.5,
                qty: 1,
                tax_rate: 8,
                modifier_surcharge: 0.5,
                modifier_tax_amount: 0.037037,
                discountType: 'fixed',
                discountValue: 0.5
            }
        ];

        const totals = calculateExpectedTotals(
            { order_discount_type: 'fixed', order_discount_value: 3 },
            cart,
            catalog,
            false,
            { taxRegistrationType: 'income_tax' }
        );

        expect(totals).toMatchObject({ subtotal: 23, discount: 3, tax: 0, total: 20 });
        expect(resolveEffectiveTaxRate(16, 'income_tax')).toBe(0);
        expect(catalog.get(1).tax_rate).toBe(16);
        expect(catalog.get(2).tax_rate).toBe(8);
    });

    it('continues validating stored rates for sales-tax registrations', () => {
        expect(resolveEffectiveTaxRate(16, 'sales_tax')).toBe(16);
        expect(() => resolveEffectiveTaxRate(101, 'sales_tax')).toThrow(/invalid tax rate/i);
    });
});

// ─── 6. calculateExpectedTotals — Exclusive Tax ───────────────────────────────
describe('calculateExpectedTotals (exclusive tax)', () => {
    const productMap = new Map([
        [1, { id: 1, tax_rate: 16 }],
        [2, { id: 2, tax_rate: 0 }],
    ]);

    it('handles simple single-item order', () => {
        const items = [{ product_id: 1, price: 10, qty: 1, discountType: null, discountValue: 0, tax_rate: 16 }];
        const totals = calculateExpectedTotals({ order_discount_type: null, order_discount_value: 0 }, items, productMap, false);
        expect(totals.subtotal).toBe(10.00);
        expect(totals.tax).toBe(1.60);
        expect(totals.total).toBe(11.60);
    });

    it('prices a requested 14 JD weight as 0.700 of a 20 JD tax-free unit', () => {
        const items = [{ product_id: 2, price: 20, qty: 0.7, discountType: null, discountValue: 0, tax_rate: 0 }];
        const totals = calculateExpectedTotals({ order_discount_type: null, order_discount_value: 0 }, items, productMap, false);

        expect(totals.subtotal).toBe(14.00);
        expect(totals.tax).toBe(0.00);
        expect(totals.total).toBe(14.00);
    });

    it('handles multi-item order with mixed tax rates', () => {
        const items = [
            { product_id: 1, price: 10, qty: 2, discountType: 'percent', discountValue: 10, tax_rate: 16 },
            { product_id: 2, price: 5, qty: 1, discountType: null, discountValue: 0, tax_rate: 0 },
        ];
        const data = { order_discount_type: 'fixed', order_discount_value: 3 };
        const totals = calculateExpectedTotals(data, items, productMap, false);
        // Subtotal = (10*2 - 10%) + 5 = 18 + 5 = 23
        // Order discount = 3 fixed → discounted subtotal = 20
        // Discount ratio = 20/23
        // Tax = 18 * (20/23) * 0.16 ≈ 2.50
        expect(totals.subtotal).toBe(23.00);
        expect(totals.tax).toBe(2.50);
        expect(totals.total).toBe(22.50);
    });

    it('handles order with no tax items', () => {
        const items = [{ product_id: 2, price: 5, qty: 2, discountType: null, discountValue: 0, tax_rate: 0 }];
        const totals = calculateExpectedTotals({ order_discount_type: null, order_discount_value: 0 }, items, productMap, false);
        expect(totals.subtotal).toBe(10.00);
        expect(totals.tax).toBe(0.00);
        expect(totals.total).toBe(10.00);
    });

    it('handles 100% order discount', () => {
        const items = [{ product_id: 1, price: 10, qty: 1, discountType: null, discountValue: 0, tax_rate: 16 }];
        const totals = calculateExpectedTotals({ order_discount_type: 'percent', order_discount_value: 100 }, items, productMap, false);
        expect(totals.subtotal).toBe(10.00);
        expect(totals.tax).toBe(0.00);
        expect(totals.total).toBe(0.00);
    });

    it('handles order discount larger than subtotal (clamps to 0)', () => {
        const items = [{ product_id: 2, price: 5, qty: 1, discountType: null, discountValue: 0, tax_rate: 0 }];
        const totals = calculateExpectedTotals({ order_discount_type: 'fixed', order_discount_value: 100 }, items, productMap, false);
        expect(totals.subtotal).toBe(5.00);
        expect(totals.total).toBe(0.00);
    });

    it('throws on invalid tax rate', () => {
        const items = [{ product_id: null, price: 10, qty: 1, discountType: null, discountValue: 0, tax_rate: 150 }];
        expect(() => calculateExpectedTotals({ order_discount_type: null, order_discount_value: 0 }, items, new Map(), false))
            .toThrow('Invalid tax rate');
    });

    it('uses productMap tax_rate over item.tax_rate when product_id is present', () => {
        // item has tax_rate: 0 but productMap says 16%
        const items = [{ product_id: 1, price: 10, qty: 1, discountType: null, discountValue: 0, tax_rate: 0 }];
        const totals = calculateExpectedTotals({ order_discount_type: null, order_discount_value: 0 }, items, productMap, false);
        expect(totals.tax).toBe(1.60); // productMap[1].tax_rate = 16 wins
    });

    it('treats a product with NULL db tax_rate as 0 and ignores client item.tax_rate (P3-14)', () => {
        const nullTaxMap = new Map([[1, { id: 1, tax_rate: null }]]);
        const items = [{ product_id: 1, price: 10, qty: 1, discountType: null, discountValue: 0, tax_rate: 16 }];
        const totals = calculateExpectedTotals({ order_discount_type: null, order_discount_value: 0 }, items, nullTaxMap, false);
        expect(totals.tax).toBe(0);      // NULL db rate → 0, NOT the client's 16%
        expect(totals.total).toBe(10.00);
    });
});

// ─── 7. calculateExpectedTotals — Inclusive Tax ───────────────────────────────
describe('calculateExpectedTotals (inclusive tax)', () => {
    const productMap = new Map([[1, { id: 1, tax_rate: 16 }]]);

    it('returns zero separate tax for inclusive pricing', () => {
        const items = [{ product_id: 1, price: 10, qty: 2, discountType: 'percent', discountValue: 10, tax_rate: 16 }];
        const totals = calculateExpectedTotals({ order_discount_type: 'percent', order_discount_value: 10 }, items, productMap, true);
        // subtotal = 18, 10% order discount → total = 16.20
        expect(totals.subtotal).toBe(18.00);
        expect(totals.tax).toBe(0);
        expect(totals.total).toBe(16.20);
    });

    it('handles inclusive pricing with fixed order discount', () => {
        const items = [{ product_id: 1, price: 10, qty: 1, discountType: null, discountValue: 0, tax_rate: 16 }];
        const totals = calculateExpectedTotals({ order_discount_type: 'fixed', order_discount_value: 2 }, items, productMap, true);
        expect(totals.subtotal).toBe(10.00);
        expect(totals.tax).toBe(0);
        expect(totals.total).toBe(8.00);
    });
});

// ─── 8. Financial Simulation — Known Combinations ─────────────────────────────
// These test known real-world scenarios from the Jordan restaurant context.
// Each combination verifies that frontend cart total === backend total exactly.
describe('Financial simulation — real-world combinations', () => {
    const productMap = new Map([
        [1, { id: 1, tax_rate: 16 }],
        [2, { id: 2, tax_rate: 5 }],
    ]);

    const cases = [
        // [description, items, orderDiscount, taxInclusive, expectedSubtotal, expectedTax, expectedTotal]
        ['Single item, 16% tax, no discount', [{ product_id: 1, price: 3.00, qty: 1, discountType: null, discountValue: 0, tax_rate: 16 }], { type: null, value: 0 }, false, 3.00, 0.48, 3.48],
        ['Two items, mixed tax, 10% order discount', [{ product_id: 1, price: 5.00, qty: 2, discountType: null, discountValue: 0, tax_rate: 16 }, { product_id: 2, price: 3.00, qty: 1, discountType: null, discountValue: 0, tax_rate: 5 }], { type: 'percent', value: 10 }, false, 13.00, 1.58, 13.27],
        ['Item with fixed per-unit discount', [{ product_id: 2, price: 5.00, qty: 4, discountType: 'fixed', discountValue: 0.5, tax_rate: 5 }], { type: null, value: 0 }, false, 18.00, 0.90, 18.90],
        ['Inclusive tax — total = discounted subtotal', [{ product_id: 1, price: 10.00, qty: 1, discountType: null, discountValue: 0, tax_rate: 16 }], { type: 'fixed', value: 1 }, true, 10.00, 0, 9.00],
    ];

    it.each(cases)('%s', (desc, items, orderDiscount, taxInclusive, expectedSub, expectedTax, expectedTotal) => {
        const totals = calculateExpectedTotals(
            { order_discount_type: orderDiscount.type, order_discount_value: orderDiscount.value },
            items,
            productMap,
            taxInclusive
        );
        expect(totals.subtotal).toBe(expectedSub);
        expect(totals.tax).toBe(expectedTax);
        expect(totals.total).toBe(expectedTotal);
    });
});

describe('catalog-backed note-product selections', () => {
    const base = { id: 1, price: 2.7, tax_rate: 8, modifiers: null };
    const note = {
        id: 91, name: 'Two slices', price: 0.172414, tax_rate: 16,
        product_is_active: 1, category_is_active: 1, category_is_notes: 1
    };
    const products = new Map([[1, base], [91, note]]);

    it('replaces forged and duplicate note money with one catalog note', () => {
        const line = { selectedModifiers: [
            { noteProductId: 91, group: 'stale', option: 'stale', price: 99 },
            { noteProductId: 91, group: 'duplicate', option: 'duplicate', price: 0 }
        ] };

        expect(resolveModifierSelections(base, line, products)).toEqual({
            selectedModifiers: [{ noteProductId: 91, group: 'Two slices', option: 'Two slices', price: 0.2 }],
            surcharge: 0.2
        });
    });

    it('keeps note identity without client display fields', () => {
        expect(sanitizeSelectedModifiers([{ noteProductId: 91 }])).toEqual([{ noteProductId: 91 }]);
        expect(resolveModifierSelections(base, { selectedModifiers: [{ noteProductId: 91 }] }, products))
            .toEqual({
                selectedModifiers: [{ noteProductId: 91, group: 'Two slices', option: 'Two slices', price: 0.2 }],
                surcharge: 0.2
            });
    });

    it.each([91.5, 0, -1, Number.MAX_SAFE_INTEGER + 1])('drops unsafe noteProductId %s', (noteProductId) => {
        expect(sanitizeSelectedModifiers([{ noteProductId, group: 'x', option: 'x', price: 1 }]))
            .toEqual([{ group: 'x', option: 'x', price: 1 }]);
    });

    it.each([
        ['missing', new Map([[1, base]])],
        ['inactive product', new Map([[1, base], [91, { ...note, product_is_active: 0 }]])],
        ['inactive category', new Map([[1, base], [91, { ...note, category_is_active: 0 }]])],
        ['ordinary category', new Map([[1, base], [91, { ...note, category_is_notes: 0 }]])],
        ['missing price', new Map([[1, base], [91, { ...note, price: undefined }]])],
        ['negative price', new Map([[1, base], [91, { ...note, price: -1 }]])],
        ['invalid tax rate', new Map([[1, base], [91, { ...note, tax_rate: 101 }]])]
    ])('rejects unavailable %s note products with the stable public error', (_label, map) => {
        let error;
        try {
            resolveModifierSelections(base, { selectedModifiers: [{ noteProductId: 91 }] }, map);
        } catch (caught) {
            error = caught;
        }
        expect(error).toMatchObject({ statusCode: 409, publicCode: 'NOTE_PRODUCT_UNAVAILABLE' });
    });
});

describe('computeModifierSurcharge', () => {
    it('computeModifierSurcharge sums only options present in product.modifiers', () => {
        const product = { price: 5, modifiers: [{ name: 'Size', options: [{ name: 'Large', price: 0.5 }] }] };
        expect(computeModifierSurcharge(product, { selectedModifiers: [{ group:'Size', option:'Large', price:0.5 }] })).toBeCloseTo(0.5, 4);
        // forged: option not in product → 0
        expect(computeModifierSurcharge(product, { selectedModifiers: [{ group:'Size', option:'Huge', price:99 }] })).toBe(0);
        // free-text note must NOT add anything (no selectedModifiers)
        expect(computeModifierSurcharge(product, { note: 'add cheese (5 JD)' })).toBe(0);
    });
});

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

describe('resolveLineTaxRate and taxRateOverrides', () => {
    it('proves the override changes totals for the exact object only and cloned/request objects cannot reuse it', () => {
        const item1 = { product_id: 101, qty: 1, price: 10, tax_rate: 16 };
        const item2 = { product_id: 101, qty: 1, price: 10, tax_rate: 16 };
        const productMap = new Map([[101, { id: 101, tax_rate: 16 }]]);
        
        const overrides = new Map();
        overrides.set(item1, 8); // override item1's tax rate to 8%

        // Exact object item1 matches override
        expect(resolveLineTaxRate(item1, productMap, overrides)).toBe(8);

        // A clone of item1 has different object reference, so it does not match override and falls back to 16
        const item1Clone = { ...item1 };
        expect(resolveLineTaxRate(item1Clone, productMap, overrides)).toBe(16);

        // calculateExpectedTotals handles the exact item1 override
        const totalsWithOverride = calculateExpectedTotals(
            { order_discount_type: null, order_discount_value: 0 },
            [item1],
            productMap,
            false,
            { taxRateOverrides: overrides }
        );
        expect(totalsWithOverride.tax).toBe(0.8); // 10 * 8%
        expect(totalsWithOverride.total).toBe(10.8);

        // calculateExpectedTotals does not apply override to item2 or a clone
        const totalsWithoutOverride = calculateExpectedTotals(
            { order_discount_type: null, order_discount_value: 0 },
            [item1Clone],
            productMap,
            false,
            { taxRateOverrides: overrides }
        );
        expect(totalsWithoutOverride.tax).toBe(1.6); // 10 * 16%
        expect(totalsWithoutOverride.total).toBe(11.6);
    });

    it('proves invalid override rates fail', () => {
        const item = { product_id: 101, qty: 1, price: 10, tax_rate: 16 };
        const productMap = new Map([[101, { id: 101, tax_rate: 16 }]]);
        
        const overrides = new Map();
        
        // Invalid rates should throw
        overrides.set(item, -5);
        expect(() => resolveLineTaxRate(item, productMap, overrides)).toThrow('Invalid tax rate on cart line.');
        expect(() => calculateExpectedTotals({}, [item], productMap, false, { taxRateOverrides: overrides })).toThrow('Invalid tax rate on cart line.');

        overrides.set(item, 105);
        expect(() => resolveLineTaxRate(item, productMap, overrides)).toThrow('Invalid tax rate on cart line.');

        overrides.set(item, NaN);
        expect(() => resolveLineTaxRate(item, productMap, overrides)).toThrow('Invalid tax rate on cart line.');
    });

    it('proves the no-override path is byte-for-byte compatible with existing cases', () => {
        const item = { product_id: 101, qty: 1, price: 10, tax_rate: 16 };
        const productMap = new Map([[101, { id: 101, tax_rate: 16 }]]);
        
        const totals = calculateExpectedTotals(
            { order_discount_type: null, order_discount_value: 0 },
            [item],
            productMap,
            false
        );
        expect(totals.tax).toBe(1.6);
        expect(totals.total).toBe(11.6);
    });
});

describe('modifier stable ids', () => {
    const { computeModifierSurcharge, buildSelectedModifiersSnapshot, sanitizeSelectedModifiers, normalizeCartItems } = require('../../services/PosCalculator');

    const product = {
        modifiers: [{
            id: 'g1', name: 'Size',
            options: [{ id: 'o1', name: 'Large', price: 2 }, { id: 'o2', name: 'XL', price: 3 }]
        }]
    };

    it('matches by id even after group and option are renamed', () => {
        const renamed = JSON.parse(JSON.stringify(product));
        renamed.modifiers[0].name = 'Cup Size';
        renamed.modifiers[0].options[0].name = 'Grande';
        const line = { selectedModifiers: [{ gid: 'g1', oid: 'o1', group: 'Size', option: 'Large' }] };
        expect(computeModifierSurcharge(renamed, line)).toBe(2);
    });

    it('falls back to name matching for id-less legacy selections', () => {
        const line = { selectedModifiers: [{ group: 'Size', option: 'XL' }] };
        expect(computeModifierSurcharge(product, line)).toBe(3);
    });

    it('unknown ids AND unknown names yield zero (forgery-safe)', () => {
        const line = { selectedModifiers: [{ gid: 'zz', oid: 'zz', group: 'Nope', option: 'Nope', price: 99 }] };
        expect(computeModifierSurcharge(product, line)).toBe(0);
    });

    it('snapshot canonicalizes matched entries from the DB definition', () => {
        const line = { selectedModifiers: [{ group: 'Size', option: 'Large', price: 999 }] };
        expect(buildSelectedModifiersSnapshot(product, line)).toEqual([
            { gid: 'g1', oid: 'o1', group: 'Size', option: 'Large', price: 2 }
        ]);
    });

    it('snapshot keeps unmatched entries sanitized instead of dropping them', () => {
        const line = { selectedModifiers: [{ group: 'Extra Cheese', option: 'Extra Cheese', price: 0.5 }] };
        expect(buildSelectedModifiersSnapshot(product, line)).toEqual([
            { group: 'Extra Cheese', option: 'Extra Cheese', price: 0.5 }
        ]);
        expect(buildSelectedModifiersSnapshot(null, line)).toEqual([
            { group: 'Extra Cheese', option: 'Extra Cheese', price: 0.5 }
        ]);
    });

    it('sanitizer strips garbage at the trust boundary', () => {
        expect(sanitizeSelectedModifiers('not an array')).toBeNull();
        expect(sanitizeSelectedModifiers([])).toBeNull();
        expect(sanitizeSelectedModifiers([null, 42, { group: '', option: 'x' }, { group: 'ok', option: 'ok', price: 'evil', gid: { a: 1 } }]))
            .toEqual([{ group: 'ok', option: 'ok' }]);
    });

    it('normalizeCartItems sanitizes selectedModifiers in its output', () => {
        const [line] = normalizeCartItems([{ id: 1, qty: 1, price: 5, selectedModifiers: [{ group: 'Size', option: 'Large', junk: 'x' }] }]);
        expect(line.selectedModifiers).toEqual([{ group: 'Size', option: 'Large' }]);
        const [bare] = normalizeCartItems([{ id: 1, qty: 1, price: 5, selectedModifiers: 'garbage' }]);
        expect(bare.selectedModifiers).toBeNull();
    });
});

describe('modifier surcharge tax snapshots', () => {
    const { taxableLineTotal, calculateLineSubtotal, deriveModifierTaxAmount, sanitizeModifierSurcharge, stampLineTax, calculateExpectedTotals, normalizeCartItems } =
        require('../../services/PosCalculator');

    it('inherits the parent rate and extracts included tax without adding above the modifier gross', () => {
        const includedTax = deriveModifierTaxAmount(0.15, 8);
        expect(includedTax).toBeCloseTo(0.011111111, 9);
        const line = {
            product_id: 1,
            price: 5.15,
            qty: 1,
            tax_rate: 8,
            modifier_surcharge: 0.15,
            modifier_tax_amount: includedTax
        };
        expect(calculateLineSubtotal(line, 8, false)).toBeCloseTo(5.138888889, 9);
        expect(stampLineTax(line, 8)).toBeCloseTo(0.411111111, 9);
        expect(calculateExpectedTotals({}, [line], new Map(), false)).toMatchObject({
            subtotal: 5.14,
            tax: 0.41,
            total: 5.55
        });
        expect(deriveModifierTaxAmount(0.15, 0)).toBe(0);
        expect(deriveModifierTaxAmount(0, 8)).toBeNull();
    });

    it('subtracts the per-unit surcharge from the tax base only', () => {
        const line = { price: 7, qty: 2, modifier_surcharge: 2 };
        expect(taxableLineTotal(line)).toBe(10);           // (7-2)*2
        expect(stampLineTax(line, 16)).toBeCloseTo(1.6, 9); // 10 * 16%
    });

    it('treats NULL/absent/0 surcharge as legacy full-price math', () => {
        expect(taxableLineTotal({ price: 7, qty: 2 })).toBe(14);
        expect(taxableLineTotal({ price: 7, qty: 2, modifier_surcharge: null })).toBe(14);
        expect(taxableLineTotal({ price: 7, qty: 2, modifier_surcharge: 0 })).toBe(14);
        expect(stampLineTax({ price: 7, qty: 2, modifier_surcharge: null }, 16)).toBeCloseTo(2.24, 9);
    });

    it('clamps when the surcharge exceeds the (manager-overridden) price', () => {
        expect(taxableLineTotal({ price: 1, qty: 1, modifier_surcharge: 2 })).toBe(0);
        expect(stampLineTax({ price: 1, qty: 1, modifier_surcharge: 2 }, 16)).toBe(0);
    });

    it('applies line discounts to the reduced base (same shapes as full-price math)', () => {
        expect(taxableLineTotal({ price: 7, qty: 2, modifier_surcharge: 2, discountType: 'percent', discountValue: 50 })).toBe(5);
        expect(taxableLineTotal({ price: 7, qty: 2, modifier_surcharge: 2, discountType: 'fixed', discountValue: 1 })).toBe(8);
        expect(taxableLineTotal({ price: 7, qty: 1, modifier_surcharge: 2, discountType: 'fixed', discountValue: 6 })).toBe(0); // clamped
    });

    it('rollup: tax excludes surcharge, subtotal keeps it, inclusive mode unchanged', () => {
        const cart = [{ product_id: 1, price: 7, qty: 1, tax_rate: 16, modifier_surcharge: 2 }];
        const excl = calculateExpectedTotals({}, cart, new Map(), false);
        expect(excl.subtotal).toBe(7);
        expect(excl.tax).toBe(0.8);
        expect(excl.total).toBe(7.8);
        const incl = calculateExpectedTotals({}, cart, new Map(), true);
        expect(incl.tax).toBe(0);
        expect(incl.total).toBe(7);
    });

    it('rollup: order discount ratio prorates the taxable base', () => {
        // subtotal 7, 50% order discount -> ratio 0.5 -> tax = 5 * 0.5 * 16% = 0.40
        const cart = [{ product_id: 1, price: 7, qty: 1, tax_rate: 16, modifier_surcharge: 2 }];
        const out = calculateExpectedTotals(
            { order_discount_type: 'percent', order_discount_value: 50 }, cart, new Map(), false);
        expect(out.tax).toBe(0.4);
        expect(out.total).toBe(3.9);
    });

    it('sanitizer bounds values; normalizeCartItems strips client money metadata', () => {
        expect(sanitizeModifierSurcharge('2.5')).toBe(2.5);
        expect(sanitizeModifierSurcharge(0)).toBeNull();
        expect(sanitizeModifierSurcharge(-1)).toBeNull();
        expect(sanitizeModifierSurcharge('evil')).toBeNull();
        expect(sanitizeModifierSurcharge(10001)).toBeNull();
        const [prod, fee, custom] = normalizeCartItems([
            { id: 1, qty: 1, price: 7, modifier_surcharge: 2, modifier_tax_amount: 0.2 },
            { qty: 1, price: 3, note: 'Auto-Gratuity', name: '10% Service Charge', modifier_surcharge: 2 },
            { qty: 1, price: 4, name: 'Open Item', modifier_surcharge: 2 }
        ]);
        expect(prod.modifier_surcharge).toBeUndefined();
        expect(prod.modifier_tax_amount).toBeUndefined();
        expect(fee.modifier_surcharge).toBeUndefined();
        expect(custom.modifier_surcharge).toBeUndefined();
    });
});


