// globals (describe, it, expect) injected by vitest globals: true
const { calculateExpectedTotals } = require('../../services/PosCalculator');

describe('Mixed taxed/untaxed cart', () => {
    it('taxes only the taxed line, leaves the untaxed line untaxed', () => {
        const cart = [
            { product_id: 1, qty: 2, price: 5.00, discountType: null, discountValue: 0 }, // taxed 8%
            { product_id: 2, qty: 1, price: 4.00, discountType: null, discountValue: 0 }  // 0% tax
        ];
        const productMap = new Map([
            [1, { id: 1, tax_rate: 8 }],
            [2, { id: 2, tax_rate: 0 }]
        ]);
        const totals = calculateExpectedTotals({}, cart, productMap, false);
        expect(totals.subtotal).toBe(14.00);   // 10.00 + 4.00
        expect(totals.tax).toBe(0.80);          // 10.00 * 8% only
        expect(totals.total).toBe(14.80);
    });
});
