import { describe, expect, it } from 'vitest';
import calculator from '../../services/ServiceChargeCalculator.js';

const {
    serviceChargeBase,
    serviceChargeFee,
    canonicalizeServiceCharge,
    allocateServiceChargeCents
} = calculator;

describe('ServiceChargeCalculator', () => {
    it('uses raw line-discounted goods and rounds once', () => {
        const items = [{ price: 0.045, qty: 1 }];
        expect(serviceChargeBase(items)).toBe(0.045);
        expect(serviceChargeFee(items, 10)).toBe(0);
    });

    it('excludes fee lines and applies fixed discounts per unit', () => {
        const items = [
            { price: 10, qty: 2, discountType: 'fixed', discountValue: 2 },
            { price: 99, qty: 1, note: 'Auto-Gratuity' }
        ];
        expect(serviceChargeBase(items)).toBe(16);
        expect(serviceChargeFee(items, 12.5)).toBe(2);
    });

    it('uses the modifier net when its price already includes the parent tax', () => {
        const item = {
            price: 5.15,
            qty: 1,
            tax_rate: 8,
            modifier_surcharge: 0.15,
            modifier_tax_amount: 0.011111111
        };
        expect(serviceChargeBase([item])).toBeCloseTo(5.138888889, 9);
        expect(serviceChargeFee([item], 10)).toBe(0.51);
        expect(serviceChargeBase([{ ...item, modifier_tax_amount: null }])).toBe(5.15);
    });

    it('rejects malformed and duplicate fee lines', () => {
        const snapshot = { id: 's1', percentage: 10, taxRate: 5 };
        expect(() => canonicalizeServiceCharge([
            { price: 10, qty: 1 },
            { price: 1, qty: 2, note: 'Auto-Gratuity' }
        ], snapshot)).toThrow(/quantity/i);
        expect(() => canonicalizeServiceCharge([
            { price: 10, qty: 1 },
            { price: 1, qty: 1, note: 'Auto-Gratuity' },
            { price: 1, qty: 1, note: 'Auto-Gratuity' }
        ], snapshot)).toThrow(/one service-charge line/i);
    });

    it('returns a server-stamped canonical fee line', () => {
        const snapshot = { id: 's1', percentage: 10, taxRate: 5 };
        const result = canonicalizeServiceCharge([
            { product_id: 1, price: 10, qty: 1 },
            { id: 'FEE_x', price: 1, qty: 1, note: 'Auto-Gratuity', tax_rate: 5 }
        ], snapshot);
        expect(result.fee).toBe(1);
        expect(result.items[1]).toMatchObject({
            product_id: null,
            name: '10% Service Charge',
            note: 'Auto-Gratuity',
            price: 1,
            qty: 1,
            tax_rate: 5,
            discountType: null,
            discountValue: 0
        });
    });

    it('keeps the configured percentage but freezes zero sales tax in income-tax mode', () => {
        const snapshot = { id: 's-income', percentage: 10, taxRate: 16 };
        const result = canonicalizeServiceCharge([
            {
                product_id: 1,
                price: 12,
                qty: 1,
                tax_rate: 16,
                modifier_surcharge: 2,
                modifier_tax_amount: 0.275862
            },
            { id: 'FEE', price: 1.2, qty: 1, note: 'Auto-Gratuity', tax_rate: 16 }
        ], snapshot, { taxRegistrationType: 'income_tax' });

        expect(result.base).toBe(12);
        expect(result.fee).toBe(1.2);
        expect(result.items[1]).toMatchObject({ price: 1.2, tax_rate: 0 });
    });

    it('calculates an exempt inclusive service charge from the already-exempt goods base once', () => {
        const items = [{ price: 20, qty: 1, tax_rate: 16 }];
        expect(serviceChargeBase(items, { taxInclusivePricing: true, taxExempt: true })).toBeCloseTo(17.241379, 6);
        expect(serviceChargeFee(items, 10, { taxInclusivePricing: true, taxExempt: true })).toBe(1.72);

        const result = canonicalizeServiceCharge([
            ...items,
            { price: 1.72, qty: 1, note: 'Auto-Gratuity', tax_rate: 16 }
        ], { id: 'exempt', percentage: 10, taxRate: 16 }, {
            taxInclusivePricing: true,
            taxExempt: true
        });
        expect(result.base).toBeCloseTo(17.241379, 6);
        expect(result.fee).toBe(1.72);
        expect(result.items[1]).toMatchObject({ price: 1.72, tax_rate: 16 });
    });

    it('allocates parent cents without gain or loss', () => {
        const cents = allocateServiceChargeCents([
            { items: [{ price: 3.333, qty: 1 }] },
            { items: [{ price: 3.333, qty: 1 }] },
            { items: [{ price: 3.334, qty: 1 }] }
        ], 1, 10);
        expect(cents).toEqual([33, 33, 34]);
        expect(cents.reduce((a, b) => a + b, 0)).toBe(100);
    });

    it('conserves integer cents across 5000 seeded seat partitions', () => {
        let seed = 0x51e7c0de;
        const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 0x100000000;
        };
        for (let run = 0; run < 5000; run += 1) {
            const seatCount = 1 + Math.floor(random() * 8);
            const seats = Array.from({ length: seatCount }, () => ({
                items: [{ price: 0.01 + random() * 100, qty: 0.1 + random() * 4 }]
            }));
            const percentage = [0.0001, 5, 10, 12.5, 100][Math.floor(random() * 5)];
            const parentFee = calculator.serviceChargeFee(
                seats.flatMap(seat => seat.items), percentage
            );
            const allocated = allocateServiceChargeCents(seats, parentFee, percentage);
            expect(allocated.reduce((sum, cents) => sum + cents, 0)).toBe(Math.round(parentFee * 100));
            expect(allocated.every(cents => Number.isInteger(cents) && cents >= 0)).toBe(true);
        }
    });
});
