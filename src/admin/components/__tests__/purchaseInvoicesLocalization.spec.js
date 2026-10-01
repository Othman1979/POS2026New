import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = resolve(process.cwd(), 'src/admin/components/purchases');
const ar = JSON.parse(readFileSync(resolve(process.cwd(), 'src/shared/i18n/ar.json'), 'utf8'));
// Technical literals that look like text but are never shown.
const NOT_TEXT = new Set(['Content-Type', 'TimeoutError', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Backspace', 'KeyN', 'KeyS', 'GET', 'POST', 'PUT', 'DELETE', 'PurchaseApiError', 'NaN']);

function shownStrings() {
    const found = new Map();
    for (const file of readdirSync(dir).filter(name => /\.(vue|js)$/.test(name) && name !== 'purchaseMath.js')) {
        const source = readFileSync(resolve(dir, file), 'utf8');
        for (const match of source.matchAll(/'((?:[^'\\\n]|\\.)+)'/g)) {
            const text = match[1];
            if (!/^[A-Z][a-z]/.test(text) || NOT_TEXT.has(text) || /[_=]/.test(text) || /^[A-Z][a-z]+[A-Z]/.test(text)) continue;
            if (/^(Item|Qty)\b.*\$\{/.test(text)) continue;
            found.set(text, file);
        }
    }
    return found;
}

describe('purchase invoice screen localization', () => {
    it('has an Arabic entry for every string the screen can show', () => {
        const missing = [...shownStrings()].filter(([text]) => !(text in ar)).map(([text, file]) => `${file}: ${text}`);
        expect(missing).toEqual([]);
    });

    it('keeps the new Arabic entries natural and canonical', () => {
        for (const [text] of shownStrings()) {
            if (!(text in ar)) continue;
            expect(ar[text]).toMatch(/[؀-ۿ]/);
            expect(text).toBe(text.replace(/\s+/g, ' ').trim());
        }
    });
});
