import { describe, it, expect } from 'vitest';
import { formatMoney } from './money.js';

describe('formatMoney', () => {
    it('formats a number to two decimals', () => {
        expect(formatMoney(12.5)).toBe('12.50');
        expect(formatMoney(10)).toBe('10.00');
    });
    it('formats a numeric string', () => {
        expect(formatMoney('12.5')).toBe('12.50');
    });
    it('returns 0.00 for null / undefined / empty / non-numeric', () => {
        expect(formatMoney(null)).toBe('0.00');
        expect(formatMoney(undefined)).toBe('0.00');
        expect(formatMoney('')).toBe('0.00');
        expect(formatMoney('abc')).toBe('0.00');
    });
});
