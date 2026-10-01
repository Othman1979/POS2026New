// backend/tests/unit/modifierDefs.test.js
import { describe, it, expect } from 'vitest';
const { normalizeModifierDefinition } = require('../../services/modifierDefs');

describe('normalizeModifierDefinition', () => {
    it('assigns ids to groups and options missing them', () => {
        const out = normalizeModifierDefinition([{ name: 'Size', options: [{ name: 'Large', price: 2 }] }]);
        expect(out[0].id).toMatch(/^[a-f0-9]{8}$/);
        expect(out[0].options[0].id).toMatch(/^[a-f0-9]{8}$/);
        expect(out[0].options[0].price).toBe(2);
    });

    it('preserves valid existing ids and renames in place', () => {
        const out = normalizeModifierDefinition([
            { id: 'g1', name: 'Size Renamed', options: [{ id: 'o1', name: 'XL', price: 3 }] }
        ]);
        expect(out[0].id).toBe('g1');
        expect(out[0].options[0].id).toBe('o1');
        expect(out[0].options[0].name).toBe('XL');
    });

    it('re-mints a duplicated id instead of keeping the collision', () => {
        const out = normalizeModifierDefinition([
            { id: 'dup', name: 'A', options: [{ id: 'dup', name: 'x', price: 0 }] }
        ]);
        expect(out[0].id).toBe('dup');
        expect(out[0].options[0].id).not.toBe('dup');
    });

    it('accepts a JSON string and returns null for empty inputs', () => {
        expect(normalizeModifierDefinition(null)).toBeNull();
        expect(normalizeModifierDefinition('')).toBeNull();
        expect(normalizeModifierDefinition('[]')).toBeNull();
        const out = normalizeModifierDefinition('[{"name":"S","options":[{"name":"a","price":"1.5"}]}]');
        expect(out[0].options[0].price).toBe(1.5); // numeric-string coerced
    });

    it('preserves common legacy string booleans during backfill', () => {
        const out = normalizeModifierDefinition([
            { name: 'Sauce', required: '1', multi_select: 'true', options: [{ name: 'Hot', price: 0 }] }
        ]);
        expect(out[0].required).toBe(true);
        expect(out[0].multi_select).toBe(true);
    });

    it('rejects invalid shapes with a clear error', () => {
        expect(() => normalizeModifierDefinition('not json')).toThrow(/JSON/);
        expect(() => normalizeModifierDefinition({ name: 'x' })).toThrow(/list/);
        expect(() => normalizeModifierDefinition([{ name: '', options: [{ name: 'a', price: 0 }] }])).toThrow(/name/);
        expect(() => normalizeModifierDefinition([{ name: 'G', options: [] }])).toThrow(/option/);
        expect(() => normalizeModifierDefinition([{ name: 'G', options: [{ name: 'a', price: -1 }] }])).toThrow(/price/);
        expect(() => normalizeModifierDefinition([{ name: 'G', options: [{ name: 'a', price: 'abc' }] }])).toThrow(/price/);
    });
});
