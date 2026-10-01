import { describe, expect, it } from 'vitest';

const barcodes = require('../../services/productBarcodes');

const failure = (work) => {
    try { work(); } catch (error) { return { statusCode: error.statusCode, publicCode: error.publicCode }; }
    return null;
};
const invalid = { statusCode: 400, publicCode: 'PRODUCT_BARCODE_INVALID' };

describe('product barcode input', () => {
    it('trims the main barcode, treats empty as cleared and leaves an unsent one unsent', () => {
        expect(barcodes.normalizeMainBarcode(undefined)).toBeUndefined();
        expect(barcodes.normalizeMainBarcode('  628100  ')).toBe('628100');
        for (const empty of [null, '', '   ', 0, false]) expect(barcodes.normalizeMainBarcode(empty)).toBeNull();
        expect(barcodes.normalizeMainBarcode('M'.repeat(50))).toHaveLength(50);
        expect(failure(() => barcodes.normalizeMainBarcode('M'.repeat(51)))).toEqual(invalid);
    });

    it('trims every extra, drops empty ones and keeps the order; an unsent list stays unsent', () => {
        expect(barcodes.normalizeExtraBarcodes(undefined)).toBeUndefined();
        expect(barcodes.normalizeExtraBarcodes([' b ', '', '  ', 'a'])).toEqual(['b', 'a']);
        expect(barcodes.normalizeExtraBarcodes([])).toEqual([]);
    });

    it('counts characters, not bytes, and allows exactly 20 extras', () => {
        expect(barcodes.normalizeExtraBarcodes(['١'.repeat(50)])).toHaveLength(1);
        expect(failure(() => barcodes.normalizeExtraBarcodes(['١'.repeat(51)]))).toEqual(invalid);
        expect(barcodes.normalizeExtraBarcodes(Array.from({ length: 20 }, (_, i) => `code-${i}`))).toHaveLength(20);
        expect(failure(() => barcodes.normalizeExtraBarcodes(Array.from({ length: 21 }, (_, i) => `code-${i}`)))).toEqual(invalid);
    });

    it('refuses a list that is not a list and entries that are not text', () => {
        for (const value of [null, 'code', 7, { 0: 'code' }]) expect(failure(() => barcodes.normalizeExtraBarcodes(value)), String(value)).toEqual(invalid);
        for (const entry of [7, null, ['x'], {}]) expect(failure(() => barcodes.normalizeExtraBarcodes([entry])), String(entry)).toEqual(invalid);
    });

    it('refuses a code twice on one product, whatever its case, main or extra', () => {
        expect(failure(() => barcodes.assertDistinct('A-1', ['a-1']))).toEqual(invalid);
        expect(failure(() => barcodes.assertDistinct(null, ['x', 'X']))).toEqual(invalid);
        expect(failure(() => barcodes.assertDistinct('A-1', ['A-2', 'A-3']))).toBeNull();
        expect(failure(() => barcodes.assertDistinct(null, []))).toBeNull();
    });
});

describe('product barcode write conflicts', () => {
    const taken = { statusCode: 409, publicCode: 'PRODUCT_BARCODE_TAKEN' };
    const duplicate = (key) => Object.assign(new Error(`Duplicate entry 'x' for key '${key}'`), { code: 'ER_DUP_ENTRY', sqlMessage: `Duplicate entry 'x' for key '${key}'` });

    it('turns a duplicate on either barcode key into the same 409', () => {
        for (const key of ['idx_barcode', 'uq_product_barcode']) {
            const mapped = barcodes.asBarcodeConflict(duplicate(key));
            expect({ statusCode: mapped.statusCode, publicCode: mapped.publicCode }).toEqual(taken);
        }
    });

    it('leaves every other error as it was', () => {
        const sku = duplicate('sku');
        expect(barcodes.asBarcodeConflict(sku)).toBe(sku);
        const other = new Error('boom');
        expect(barcodes.asBarcodeConflict(other)).toBe(other);
    });

    it('names the first submitted code that another product holds, in the case the admin typed it', async () => {
        const db = { query: async () => [[{ barcode: 'TAKEN-1', name: 'Holder' }, { barcode: 'TAKEN-2', name: 'Other holder' }]] };
        await expect(barcodes.assertFree(db, 5, ['free', 'taken-2', 'taken-1'])).rejects.toMatchObject({
            ...taken, message: 'Barcode taken-2 is already used by Other holder.',
        });
        await expect(barcodes.assertFree({ query: async () => [[]] }, 5, ['free'])).resolves.toBeUndefined();
        // nothing to check, nothing asked
        await expect(barcodes.assertFree({ query: async () => { throw new Error('no query expected'); } }, 5, [])).resolves.toBeUndefined();
    });
});
