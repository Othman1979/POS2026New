import { describe, expect, it } from 'vitest';
import allocator from '../../services/SplitMoneyAllocator.js';

const {
    allocateCents,
    allocateSplitMoneyCents,
    validateSplitMoneyCents,
    moneyToCents
} = allocator;

const sum = (values, key) => values.reduce((total, value) => total + value[key], 0);

describe('SplitMoneyAllocator', () => {
    it('allocates the 4.75 tax-exclusive half-cent case without loss', () => {
        expect(allocateSplitMoneyCents(
            { subtotal: 4.09, tax: 0.66, total: 4.75 },
            [
                { subtotal: 2.047484, discount: 0, tax: 0.327484 },
                { subtotal: 2.047484, discount: 0, tax: 0.327484 }
            ]
        )).toEqual([
            { subtotal: 205, discount: 0, tax: 33, total: 238 },
            { subtotal: 204, discount: 0, tax: 33, total: 237 }
        ]);
    });

    it('allocates a 4.75 inclusive total as 2.38 and 2.37', () => {
        expect(allocateSplitMoneyCents(
            { subtotal: 4.75, tax: 0, total: 4.75 },
            [
                { subtotal: 2.375, discount: 0, tax: 0 },
                { subtotal: 2.375, discount: 0, tax: 0 }
            ]
        ).map(value => value.total)).toEqual([238, 237]);
    });

    it('uses stable input order to break equal remainders', () => {
        expect(allocateCents(5, [1, 1])).toEqual([3, 2]);
        expect(allocateCents(5, [1, 1])).toEqual([3, 2]);
    });

    it('gives leftover cents to the largest fractional shares first', () => {
        expect(allocateCents(1, [0.4, 0.6])).toEqual([0, 1]);
        expect(allocateCents(100, [1, 1, 1.2])).toEqual([31, 31, 38]);
        expect(allocateCents(10, [0.47, 0.53])).toEqual([5, 5]);
    });

    it('caps allocated discount cents at each allocated seat subtotal', () => {
        expect(allocateCents(3, [1.5, 1.5], [2, 1])).toEqual([2, 1]);
        expect(() => allocateCents(4, [1.5, 1.5], [2, 1])).toThrow(/capacity/i);
    });

    it('converts decimal money and rejects invalid allocation inputs', () => {
        expect(moneyToCents(4.75)).toBe(475);
        expect(moneyToCents(1.005)).toBe(101);
        expect(() => moneyToCents('not-money')).toThrow(/money/i);
        expect(() => allocateCents(-1, [1])).toThrow(/allocation/i);
        expect(() => allocateCents(1, [])).toThrow(/allocation/i);
        expect(() => allocateCents(1, [0])).toThrow(/positive weight/i);
        expect(() => allocateCents(0, [Number.POSITIVE_INFINITY])).toThrow(/weight/i);
    });

    it('rejects malformed or non-footing persisted allocations', () => {
        expect(() => validateSplitMoneyCents({ subtotal: 204, discount: 0, tax: 33, total: 238 }))
            .toThrow(/foot/i);
        expect(() => validateSplitMoneyCents({ subtotal: 204.5, discount: 0, tax: 33, total: 237 }))
            .toThrow(/integer/i);
        expect(() => validateSplitMoneyCents({ subtotal: 1, discount: 2, tax: 0, total: -1 }))
            .toThrow(/non-negative/i);
        expect(validateSplitMoneyCents({ subtotal: 204, discount: 0, tax: 33, total: 237 }))
            .toEqual({ subtotal: 204, discount: 0, tax: 33, total: 237 });
    });

    it('conserves every component across 5000 seeded partitions', () => {
        let seed = 0x5e17c0de;
        const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 0x100000000;
        };

        for (let run = 0; run < 5000; run += 1) {
            const seatCount = 2 + Math.floor(random() * 7);
            const subtotalCents = 1 + Math.floor(random() * 10000000);
            const taxRate = [0, 0.08, 0.16][Math.floor(random() * 3)];
            const taxCents = Math.round(subtotalCents * taxRate);
            const discountCents = Math.floor(random() * (subtotalCents + 1));
            const parent = {
                subtotal: subtotalCents / 100,
                tax: taxCents / 100,
                total: (subtotalCents - discountCents + taxCents) / 100
            };
            const seats = Array.from({ length: seatCount }, () => ({
                subtotal: 0.0001 + random() * subtotalCents / 100,
                discount: discountCents === 0 ? 0 : 0.0001 + random() * discountCents / 100,
                tax: taxCents === 0 ? 0 : 0.0001 + random() * taxCents / 100
            }));

            const first = allocateSplitMoneyCents(parent, seats);
            const second = allocateSplitMoneyCents(parent, seats);

            expect(second).toEqual(first);
            expect(sum(first, 'subtotal')).toBe(subtotalCents);
            expect(sum(first, 'discount')).toBe(discountCents);
            expect(sum(first, 'tax')).toBe(taxCents);
            expect(sum(first, 'total')).toBe(subtotalCents - discountCents + taxCents);
            for (const child of first) {
                expect(Object.values(child).every(Number.isSafeInteger)).toBe(true);
                expect(Object.values(child).every(value => value >= 0)).toBe(true);
                expect(child.discount).toBeLessThanOrEqual(child.subtotal);
                expect(child.subtotal - child.discount + child.tax).toBe(child.total);
            }
        }
    });
});
