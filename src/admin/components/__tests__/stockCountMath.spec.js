import { describe, expect, it } from 'vitest';
import {
    canonQty, formatThousandths, groupName, nextIndex, parseQty, sameUnit, sortByAbsValue, sumValues, toBaseQty, toThousandths, trimQty, unitKey, unitOptionText,
} from '../counts/countMath.js';

describe('parseQty', () => {
    it('treats blank as not counted and 0 as a real count', () => {
        expect(parseQty('')).toEqual({ state: 'empty', value: null });
        expect(parseQty('   ')).toEqual({ state: 'empty', value: null });
        expect(parseQty('0')).toEqual({ state: 'ok', value: '0.000' });
    });

    it('accepts up to three decimals, comma and Arabic digits, and rejects the rest', () => {
        expect(parseQty('2,5').value).toBe('2.500');
        expect(parseQty('٣٫٢٥').value).toBe('3.250');
        expect(parseQty('1.2345').state).toBe('invalid');
        expect(parseQty('-1').state).toBe('invalid');
        expect(parseQty('1e3').state).toBe('invalid');
        expect(parseQty('abc').state).toBe('invalid');
    });
});

describe('exact decimal math', () => {
    it('multiplies by the pack size without float drift', () => {
        expect(toBaseQty('0.1', '3')).toBe('0.300');
        expect(toBaseQty('2.500', '12')).toBe('30.000');
        expect(toBaseQty('1.005', '1')).toBe('1.005');
        expect(toBaseQty('0.001', '0.5')).toBe('0.001'); // half-up at the third decimal
        expect(toBaseQty('x', '1')).toBeNull();
    });

    it('sums money strings exactly', () => {
        expect(sumValues(['0.100', '0.200'])).toBe('0.300');
        expect(sumValues(['-1.000', '4.500', null])).toBe('3.500');
        expect(sumValues([])).toBe('0.000');
    });

    it('rounds half away from zero on the third decimal and formats negatives', () => {
        expect(toThousandths('1.0005')).toBe(1001n);
        expect(toThousandths('-1.0005')).toBe(-1001n);
        expect(formatThousandths(-50n)).toBe('-0.050');
    });

    it('canonicalizes stored quantities and trims them for display', () => {
        expect(canonQty('3')).toBe('3.000');
        expect(canonQty(null)).toBeNull();
        expect(trimQty('10.000')).toBe('10');
        expect(trimQty('2.500')).toBe('2.5');
        expect(trimQty('0.000')).toBe('0');
        expect(trimQty(null)).toBe('');
    });
});

describe('units', () => {
    const names = { g: 'gram', kg: 'kilogram', ml: 'millilitre', l: 'litre', unit: 'piece' };

    it('reads standard units as translated names with no factor', () => {
        const options = [{ label: 'g', factor: '1' }, { label: 'kg', factor: '1000' }];
        expect(unitOptionText(options[0], 'g', names, options)).toBe('gram');
        expect(unitOptionText(options[1], 'g', names, options)).toBe('kilogram');
        expect(unitOptionText({ label: 'unit', factor: '1' }, 'unit', names, [])).toBe('piece');
    });

    it('reads a pack as label (size) in kg or l when the item has that unit, else in the base unit', () => {
        const withKg = [{ label: 'g', factor: '1' }, { label: 'kg', factor: '1000' }, { label: 'sack', factor: '25000' }];
        expect(unitOptionText(withKg[2], 'g', names, withKg)).toBe('sack (25 kilogram)');
        const gramsOnly = [{ label: 'g', factor: '1' }, { label: 'potato', factor: '100' }];
        expect(unitOptionText(gramsOnly[1], 'g', names, gramsOnly)).toBe('potato (100 gram)');
        const liquid = [{ label: 'ml', factor: '1' }, { label: 'l', factor: '1000' }, { label: 'can', factor: '330' }];
        expect(unitOptionText(liquid[2], 'ml', names, liquid)).toBe('can (0.33 litre)');
    });

    it('translates fixed groups by key and leaves categories alone', () => {
        const tr = key => `T:${key}`;
        expect(groupName({ group_key: 'ingredients', group_label: 'Ingredients' }, tr)).toBe('T:Ingredients');
        expect(groupName({ group_key: 'other', group_label: 'Other items' }, tr)).toBe('T:Other items');
        expect(groupName({ item_key: 'ingredient:4', group_label: 'Ingredients' }, tr)).toBe('T:Ingredients');
        expect(groupName({ item_key: 'product:9', group_label: 'Other items' }, tr)).toBe('T:Other items');
        expect(groupName({ group_key: 'category:12', group_label: 'Starters' }, tr)).toBe('Starters');
    });

    it('compares units by label and pack size however the factor is written', () => {
        expect(sameUnit('box', '500', 'box', '500.000')).toBe(true);
        expect(sameUnit('box', '500', 'crate', '500')).toBe(false);
        expect(unitKey({ label: 'box', factor: '500' })).toBe(unitKey({ label: 'box', factor: '500.000' }));
    });
});

describe('navigation and ordering', () => {
    const lines = [{ qty: '' }, { qty: '3' }, { qty: '0' }, { qty: '' }, { qty: 'x' }];

    it('finds the next uncounted line forward and any previous line backward', () => {
        expect(nextIndex(lines, 0, 1, true)).toBe(3);
        expect(nextIndex(lines, 3, 1, true)).toBe(4);
        expect(nextIndex(lines, 4, 1, true)).toBe(-1);
        expect(nextIndex(lines, 3, -1, false)).toBe(2);
        expect(nextIndex(lines, 0, -1, false)).toBe(-1);
    });

    it('sorts review lines by absolute money value with missing values last', () => {
        const sorted = sortByAbsValue([
            { name: 'a', variance_value: '1.000' },
            { name: 'b', variance_value: null },
            { name: 'c', variance_value: '-5.000' },
            { name: 'd', variance_value: '0.000' },
        ]);
        expect(sorted.map(line => line.name)).toEqual(['c', 'a', 'd', 'b']);
    });
});
