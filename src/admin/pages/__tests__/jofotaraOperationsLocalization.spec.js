import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(__dirname, '../JofotaraOperations.vue'), 'utf8');
const i18n = JSON.parse(readFileSync(resolve(__dirname, '../../../shared/i18n/ar.json'), 'utf8'));

describe('JoFotara Operations localization', () => {
    it('has an Arabic entry for every static translated label', () => {
        const dynamicKeys = [...page.matchAll(/label:\s*'([^']+)'/g)].map(match => match[1]);
        const keys = [...new Set([
            ...[...page.matchAll(/\$?t\('([^']+)'\)/g)].map(match => match[1]),
            ...dynamicKeys
        ])];
        const missing = keys.filter(key => !Object.prototype.hasOwnProperty.call(i18n, key));

        expect(missing).toEqual([]);
        for (const key of dynamicKeys) {
            expect(Object.prototype.hasOwnProperty.call(i18n, key)).toBe(true);
        }
    });
});
