import { describe, expect, it } from 'vitest';
import { getDefaultOrderTypeId } from './defaultOrderType.js';

describe('getDefaultOrderTypeId', () => {
    it('returns the configured type id from database-shaped flags', () => {
        expect(getDefaultOrderTypeId([
            { id: 1, is_default: 0 },
            { id: 7, is_default: 1 }
        ])).toBe(7);
    });

    it('accepts boolean flags and returns null when no default exists', () => {
        expect(getDefaultOrderTypeId([{ id: 3, is_default: true }])).toBe(3);
        expect(getDefaultOrderTypeId([{ id: 3, is_default: false }])).toBeNull();
        expect(getDefaultOrderTypeId([])).toBeNull();
    });
});
