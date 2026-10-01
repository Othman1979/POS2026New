import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = resolve(process.cwd(), 'src/admin/components/counts');
const arText = readFileSync(resolve(process.cwd(), 'src/shared/i18n/ar.json'), 'utf8');
const ar = JSON.parse(arText);

// Every literal handed to t()/$t(), a label: or heading: field, or an error-code table entry.
function shownStrings() {
    const found = new Map();
    const add = (text, file) => found.set(text.replace(/\\'/g, "'"), file);
    for (const file of readdirSync(dir).filter(name => /\.(vue|js)$/.test(name) && name !== 'countMath.js')) {
        const source = readFileSync(resolve(dir, file), 'utf8');
        for (const match of source.matchAll(/\$?\bt\(\s*(['"])((?:(?!\1)[^\\\n]|\\.)+)\1/g)) add(match[2], file);
        for (const match of source.matchAll(/(?:label|heading):\s*(['"])((?:(?!\1).)+)\1/g)) add(match[2], file);
        for (const match of source.matchAll(/^\s+STOCK_COUNT_\w+:\s*(['"])((?:(?!\1).)+)\1/gm)) add(match[2], file);
    }
    return found;
}

describe('stock count screen localization', () => {
    it('finds the strings it is meant to check', () => {
        expect(shownStrings().size).toBeGreaterThan(60);
    });

    it('has an Arabic entry for every string the screen can show', () => {
        const missing = [...shownStrings()].filter(([text]) => !(text in ar)).map(([text, file]) => `${file}: ${text}`);
        expect(missing).toEqual([]);
    });

    it('keeps the Arabic entries Arabic and the placeholders intact', () => {
        for (const [text] of shownStrings()) {
            expect(ar[text]).toMatch(/[؀-ۿ]/);
            expect(text).toBe(text.replace(/\s+/g, ' ').trim());
            expect([...text.matchAll(/\{\w+\}/g)].map(match => match[0]).sort()).toEqual([...ar[text].matchAll(/\{\w+\}/g)].map(match => match[0]).sort());
        }
    });

    it('keeps the new keys in one block right after the purchase anchor', () => {
        const keys = Object.keys(ar);
        const anchor = keys.indexOf('Purchase invoices could not be loaded. Check the connection and open the tab again.');
        expect(anchor).toBeGreaterThan(-1);
        expect(keys[anchor + 1]).toBe('A stock count is already open. Finish or delete it before starting another.');
        expect(keys[anchor + 65]).toBe('Choose a count from the list, or start a new one.');
        expect(keys.slice(anchor + 66, anchor + 70)).toEqual(['Counted items', 'Other items', 'kilogram', 'litre']);
    });
});
