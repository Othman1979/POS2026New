import { describe, expect, it } from 'vitest';
import {
    lineGross,
    lineNet,
    lineTax,
    exemptUnitPrice,
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

    it('calculates exclusive tax and suppresses only tax-inclusive rollup tax', () => {
        const line = { price: 10, qty: 2, tax_rate: 16 };
        expect(lineTax(line, 0.5)).toBeCloseTo(1.6, 8);
        expect(lineTax(line, 1, { taxExempt: true })).toBe(0);
        expect(lineTax(line, 1, { taxInclusive: true })).toBe(0);
    });

    it('calculates gross display and honors tax-inclusive pricing', () => {
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

    it('removes embedded tax for an exempt inclusive line and is reversible without double conversion', () => {
        const raw = { price: 20, qty: 1, tax_rate: 16 };
        expect(exemptUnitPrice(raw, 16, true)).toBe(17.241379);
        expect(exemptUnitPrice({ ...raw, price: 17.241379 }, 16, true, { alreadyExempt: true })).toBe(17.241379);
        expect(posTotals([raw], {}, { taxInclusive: true, taxExempt: true })).toMatchObject({
            subtotal: 17.24,
            tax: 0,
            total: 17.24
        });
    });

    it('does not de-tax a generated Auto-Gratuity line a second time', () => {
        const cart = [
            { price: 20, qty: 1, tax_rate: 16 },
            { price: 1.72, qty: 1, tax_rate: 16, note: 'Auto-Gratuity' }
        ];
        expect(posTotals(cart, {}, { taxInclusive: true, taxExempt: true })).toMatchObject({
            subtotal: 18.96,
            tax: 0,
            total: 18.96
        });
    });

    it('keeps a fixed modifier surcharge exact while removing only embedded base tax', () => {
        const raw = { price: 1.31, qty: 1, tax_rate: 16, modifier_surcharge: 0.15 };
        expect(exemptUnitPrice(raw, 16, true)).toBe(1.15);
        expect(posTotals([raw], {}, { taxInclusive: true, taxExempt: true })).toMatchObject({
            subtotal: 1.15,
            tax: 0,
            total: 1.15
        });
    });
});

describe('untaxed modifier surcharge', () => {
    it('extracts parent-rate tax already included in a priced modifier', () => {
        const line = {
            price: 5.15,
            qty: 1,
            tax_rate: 8,
            modifier_surcharge: 0.15,
            modifier_tax_amount: 0.011111111
        };
        expect(lineNet(line)).toBeCloseTo(5.138888889, 9);
        expect(lineTax(line)).toBeCloseTo(0.411111111, 9);
        expect(lineGross(line)).toBeCloseTo(5.55, 9);
        expect(posTotals([line], {}, {})).toMatchObject({ subtotal: 5.14, tax: 0.41, total: 5.55 });
        expect(posTotals([line], {}, { taxInclusive: true })).toMatchObject({ subtotal: 5.15, tax: 0, total: 5.15 });
    });

    it('lineTax uses price minus surcharge; lineNet keeps full price', () => {
        const line = { price: 7, qty: 2, tax_rate: 16, modifier_surcharge: 2 };
        expect(lineNet(line)).toBe(14);
        expect(lineTax(line)).toBeCloseTo(1.6, 9);          // (7-2)*2*16%
        expect(lineGross(line)).toBeCloseTo(15.6, 9);       // 14 + 1.6
        expect(lineTax({ ...line, modifier_surcharge: null })).toBeCloseTo(2.24, 9);
        expect(lineTax({ price: 1, qty: 1, tax_rate: 16, modifier_surcharge: 2 })).toBe(0); // clamp
    });

    it('posTotals: subtotal keeps surcharge, tax excludes it', () => {
        const out = posTotals([{ price: 7, qty: 1, tax_rate: 16, modifier_surcharge: 2 }], {}, {});
        expect(out.subtotal).toBe(7);
        expect(out.tax).toBe(0.8);
        expect(out.total).toBe(7.8);
        const incl = posTotals([{ price: 7, qty: 1, tax_rate: 16, modifier_surcharge: 2 }], {}, { taxInclusive: true });
        expect(incl.tax).toBe(0);
        expect(incl.total).toBe(7);
    });
});
