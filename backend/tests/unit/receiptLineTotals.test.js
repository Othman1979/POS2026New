import { describe, expect, it } from 'vitest';
import { receiptItemDisplayTotal } from '../../../src/utils/receiptLineTotals.js';

describe('receiptItemDisplayTotal', () => {
  it('uses saved DB tax_amount when present', () => {
    expect(receiptItemDisplayTotal({
      qty: 2,
      price: 5,
      tax_amount: 1.6,
      tax_rate: 16,
    })).toBeCloseTo(11.6, 2);
  });

  it('falls back to tax_rate for live guest-check lines', () => {
    expect(receiptItemDisplayTotal({
      qty: 2,
      price: 5,
      tax_rate: 16,
    })).toBeCloseTo(11.6, 2);
  });

  it('applies line discount before calculating fallback tax', () => {
    expect(receiptItemDisplayTotal({
      qty: 2,
      price: 5,
      discountType: 'fixed',
      discountValue: 1,
      tax_rate: 16,
    })).toBeCloseTo(9.28, 2);
  });
});

import { splitCheckTotals } from '../../../src/utils/receiptLineTotals.js';

describe('splitCheckTotals', () => {
    it('sums net line totals and adds per-line tax so the check foots', () => {
        const items = [
            { qty: 1, price: 5.00, tax_rate: 16 },
            { qty: 2, price: 2.00, tax_rate: 0 }
        ];
        const t = splitCheckTotals(items);
        expect(t.subtotal).toBe(9.00);
        expect(t.tax).toBe(0.80);
        expect(t.total).toBe(9.80);
    });

    it('honours a per-line discount before taxing', () => {
        const items = [{ qty: 1, price: 10.00, tax_rate: 10, discountType: 'percent', discountValue: 50 }];
        const t = splitCheckTotals(items);
        expect(t.subtotal).toBe(5.00);
        expect(t.tax).toBe(0.50);
        expect(t.total).toBe(5.50);
    });
});

describe('untaxed modifier surcharge fallbacks', () => {
    it('uses the frozen included modifier tax for new receipt and split fallbacks', () => {
        const item = {
            price: 5.15,
            qty: 1,
            tax_rate: 8,
            modifier_surcharge: 0.15,
            modifier_tax_amount: 0.011111111
        };
        expect(receiptItemDisplayTotal(item)).toBeCloseTo(5.55, 9);
        expect(splitCheckTotals([item])).toEqual({ subtotal: 5.14, tax: 0.41, total: 5.55 });
    });

    it('receiptItemDisplayTotal fallback grosses up only the base', () => {
        // no saved tax_amount -> fallback path
        const item = { price: 7, qty: 1, tax_rate: 16, modifier_surcharge: 2 };
        expect(receiptItemDisplayTotal(item)).toBeCloseTo(7.8, 9);
        // saved tax_amount still wins verbatim
        expect(receiptItemDisplayTotal({ ...item, tax_amount: 1.12 })).toBeCloseTo(8.12, 9);
    });

    it('splitCheckTotals taxes the reduced base', () => {
        const out = splitCheckTotals([{ price: 7, qty: 1, tax_rate: 16, modifier_surcharge: 2 }]);
        expect(out.subtotal).toBe(7);
        expect(out.tax).toBeCloseTo(0.8, 9);
        expect(out.total).toBe(7.8);
    });
});
