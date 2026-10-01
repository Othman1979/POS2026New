import { describe, expect, it } from 'vitest';
const { normalizeAmount } = require('../../services/expenseService');

describe('expense amount validation', () => {
    it('accepts zero while rejecting blank, negative, and malformed amounts', () => {
        expect(normalizeAmount(0)).toBe(0);
        expect(normalizeAmount('0')).toBe(0);

        for (const invalid of ['', '   ', null, undefined, false, [], {}, -0.01, 'not-a-number']) {
            expect(() => normalizeAmount(invalid)).toThrow();
        }
    });

    it('accepts cent precision and rejects any value that the database would round', () => {
        for (const valid of [0.01, 1.23, '99999999.99']) {
            expect(normalizeAmount(valid)).toBe(Number(valid));
        }

        for (const overPrecise of [0.001, 1.234, '0.0000000001']) {
            expect(() => normalizeAmount(overPrecise)).toThrow('more than two decimal places');
        }
    });
});
