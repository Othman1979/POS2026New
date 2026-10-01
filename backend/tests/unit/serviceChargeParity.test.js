import { describe, expect, it } from 'vitest';
import backend from '../../services/ServiceChargeCalculator.js';
import { serviceChargeBase, serviceChargeFee } from '../../../src/utils/posTotals.js';

const seeded = (seed) => () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
};

describe('service-charge FE/BE parity', () => {
    it('matches deterministic boundary combinations', () => {
        for (const price of [0, 0.001, 0.045, 1.005, 9.999999, 100]) {
            for (const qty of [0.001, 0.25, 1, 3]) {
                for (const percentage of [0, 0.0001, 5, 10, 12.5, 100]) {
                    const items = [{ price, qty, discountType: 'percent', discountValue: 0.5 }];
                    expect(serviceChargeBase(items)).toBe(backend.serviceChargeBase(items));
                    expect(serviceChargeFee(items, percentage)).toBe(backend.serviceChargeFee(items, percentage));
                }
            }
        }
    });

    it('matches 5000 seeded mixed carts', () => {
        const random = seeded(0x5c0ffee);
        for (let run = 0; run < 5000; run += 1) {
            const length = 1 + Math.floor(random() * 8);
            const feeIndex = run % 2 === 0 ? Math.floor(random() * length) : -1;
            const items = Array.from({ length }, (_, index) => ({
                price: [0.001, 0.045, 1.005, 9.99, 100][Math.floor(random() * 5)],
                qty: [0.001, 0.25, 1, 2, 3][Math.floor(random() * 5)],
                discountType: [null, 'fixed', 'percent'][Math.floor(random() * 3)],
                discountValue: [0, 0.01, 0.5, 10, 100][Math.floor(random() * 5)],
                note: index === feeIndex ? 'Auto-Gratuity' : ''
            }));
            const percentage = [0.0001, 5, 10, 12.5, 100][Math.floor(random() * 5)];
            expect(serviceChargeBase(items)).toBe(backend.serviceChargeBase(items));
            expect(serviceChargeFee(items, percentage)).toBe(backend.serviceChargeFee(items, percentage));
        }
    });

    it('matches frontend/backend exempt inclusive service-charge math', () => {
        const items = [{ price: 20, qty: 1, tax_rate: 16 }];
        const frontendOptions = { taxInclusive: true, taxExempt: true };
        const backendOptions = { taxInclusivePricing: true, taxExempt: true };
        expect(serviceChargeBase(items, frontendOptions)).toBe(backend.serviceChargeBase(items, backendOptions));
        expect(serviceChargeFee(items, 10, frontendOptions)).toBe(backend.serviceChargeFee(items, 10, backendOptions));
        expect(serviceChargeBase(items, frontendOptions)).toBeCloseTo(17.241379, 6);
        expect(serviceChargeFee(items, 10, frontendOptions)).toBe(1.72);
    });
});
