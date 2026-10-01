import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as i18n from '../i18n.js';
import { serveArabicDictionary } from './serveArabicDictionary.js';

const facadePath = resolve(process.cwd(), 'src/shared/i18n.js');
const catalogPath = resolve(process.cwd(), 'src/shared/i18n/ar.json');

describe('shared i18n catalog boundary', () => {
    beforeAll(async () => {
        serveArabicDictionary();
        expect(await i18n.prepareLanguage('ar')).toBe(true);
    });

    it('keeps the existing public module as a thin compatibility facade', () => {
        const source = readFileSync(facadePath, 'utf8');
        expect(source.trim()).toBe("export * from './i18n/runtime.js';");
        expect(Object.keys(i18n).sort()).toEqual([
            'POS_I18N_KEY',
            'createPosI18n',
            'currentLanguage',
            'deferLanguage',
            'getDirection',
            'initI18n',
            'languageChoices',
            'onLanguageChange',
            'prepareLanguage',
            'retryDeferredLanguage',
            'setLanguage',
            't'
        ]);
    });

    it('keeps the Arabic catalog out of the bundle, loaded on demand as a hashed asset', () => {
        const runtime = readFileSync(resolve(process.cwd(), 'src/shared/i18n/runtime.js'), 'utf8');
        expect(runtime).toContain("import arDictionaryUrl from './ar.json?url'");
        expect(runtime).toContain('ar: () => fetchDictionary(arDictionaryUrl)');
        expect(runtime).not.toMatch(/import\s+ar\s+from\s+['"]\.\/ar\.json['"]/);
    });

    it('preserves static Arabic catalog entries and routes canonical keys through t()', () => {
        expect(existsSync(catalogPath)).toBe(true);
        if (!existsSync(catalogPath)) return;

        const ar = JSON.parse(readFileSync(catalogPath, 'utf8'));
        expect(ar['The server is busy. Try again in a moment.']).toBeTruthy();
        expect(ar['This POS must be opened over HTTPS before you can sign in.']).toBeTruthy();
        expect(Object.keys(ar).length).toBeGreaterThan(0);
        const nonCanonicalKeys = Object.keys(ar).filter(
            (key) => key !== key.replace(/\s+/g, ' ').trim()
        );
        expect(nonCanonicalKeys).toEqual(['Custom Background: ']);
        for (const [key, value] of Object.entries(ar)) {
            expect(typeof value).toBe('string');
            expect(value.trim()).not.toBe('');
            if (!nonCanonicalKeys.includes(key)) expect(i18n.t(key, 'ar')).toBe(value);
        }
    });

    it('preserves English identity, outer whitespace and dynamic Arabic rules', () => {
        expect(i18n.t('  Orders  ', 'en')).toBe('  Orders  ');
        expect(i18n.t('  Orders  ', 'ar')).toBe('  الطلبات  ');
        expect(i18n.t('Cashier: Maya', 'ar')).toBe('الكاشير: Maya');
        expect(i18n.t('Only 2.00 JD remaining', 'ar')).toBe('تبقى 2.00 JD فقط');
        expect(i18n.t('2 selected', 'ar')).toBe('عنصران محددان');
        expect(i18n.t('3 selected', 'ar')).toBe('3 عناصر محددة');
        expect(i18n.t('Shifts settled on another business day', 'ar')).toBe('مناوبات أُغلقت في يوم عمل آخر');
    });

    it('translates the barcode-taken message and keeps the barcode and the product name as sent', () => {
        const message = 'Barcode 6281 is already used by Cola 1.5L.';
        expect(i18n.t(message, 'en')).toBe(message);
        const arabic = i18n.t(message, 'ar');
        expect(arabic).toMatch(/[؀-ۿ]/);
        expect(arabic).toContain('6281');
        expect(arabic).toContain('Cola 1.5L');
    });

    it('explains denied table access in Arabic', () => {
        for (const message of ['Forbidden: This table is outside your assigned sections.', 'Forbidden: Tables access permission required.']) {
            expect(i18n.t(message, 'ar')).toMatch(/[\u0600-\u06ff]/);
        }
    });

    it('explains the busy-table join rejection in the selected language', () => {
        const message = 'Occupied tables cannot be joined.';
        expect(i18n.t(message, 'ar')).toMatch(/[\u0600-\u06ff]/);
        expect(i18n.t(message, 'en')).toBe(message);
    });
});
