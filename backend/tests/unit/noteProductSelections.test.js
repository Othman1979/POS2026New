import { describe, expect, it } from 'vitest';
import {
    editableItemNote,
    hasNoteProduct,
    isNoteProduct,
    noteProductIds,
    syncNoteProducts,
    toggleNoteProduct,
    saveEditableItemNote,
} from '@/pos/noteProductSelections.js';

describe('catalog-backed priced note selections', () => {
    it('toggles by product id and updates price, surcharge, tax, and display together', () => {
        const line = { price: 2.7, tax_rate: 8, note: 'No onions', selectedModifiers: null, modifier_surcharge: null };
        const product = { id: 91, name: 'Two slices', price: 0.172414, tax_rate: 16 };

        expect(toggleNoteProduct(line, product)).toBe(true);
        expect(line).toMatchObject({ price: 2.9, modifier_surcharge: 0.2, note: 'No onions\nTwo slices (+0.20)' });
        expect(line.modifier_tax_amount).toBeCloseTo(0.014815, 6);
        expect(hasNoteProduct(line, 91)).toBe(true);

        expect(toggleNoteProduct(line, product)).toBe(false);
        expect(line).toMatchObject({ price: 2.7, modifier_surcharge: null, modifier_tax_amount: null, note: 'No onions' });
    });

    it('keeps same-name products independent and never duplicates one id', () => {
        const line = { price: 2.7, tax_rate: 0, note: '', selectedModifiers: [] };
        toggleNoteProduct(line, { id: 91, name: 'Extra', price: 0.2, tax_rate: 0 });
        toggleNoteProduct(line, { id: 92, name: 'Extra', price: 0.3, tax_rate: 0 });
        expect(noteProductIds(line)).toEqual([91, 92]);

        toggleNoteProduct(line, { id: 91, name: 'Extra', price: 0.2, tax_rate: 0 });
        expect(noteProductIds(line)).toEqual([92]);
    });

    it('edits manual text without exposing generated structured lines', () => {
        const line = {
            note: 'Extra\nSize: Large (0.50 JD)\nExtra (+0.20)',
            selectedModifiers: [
                { gid: 'size', oid: 'large', group: 'Size', option: 'Large', price: 0.5 },
                { noteProductId: 91, group: 'Extra', option: 'Extra', price: 0.2 }
            ]
        };
        expect(editableItemNote(line)).toBe('Extra');
        saveEditableItemNote(line, 'Extra\nPack separately');
        expect(line.note).toBe('Extra\nPack separately\nSize: Large (0.50 JD)\nExtra (+0.20)');
    });

    it('preserves formal modifiers, accepts free notes, and keeps quantity out of per-unit money', () => {
        const line = {
            qty: 3,
            price: 2.7,
            tax_rate: 0,
            note: 'Free text (+99.00)',
            selectedModifiers: [{ group: 'Sauce', option: 'Hot', price: 0.1 }],
            modifier_surcharge: 0.1,
        };
        toggleNoteProduct(line, { id: 91, name: 'Free note', price: 0, tax_rate: 0 });
        expect(line.price).toBe(2.7);
        expect(line.modifier_surcharge).toBe(0.1);
        expect(line.selectedModifiers).toEqual(expect.arrayContaining([
            { group: 'Sauce', option: 'Hot', price: 0.1 },
            { noteProductId: 91, group: 'Free note', option: 'Free note', price: 0 },
        ]));
        expect(line.note).toBe('Free text (+99.00)\nSauce: Hot (0.10 JD)\nFree note');
    });

    it('refuses a fifty-first selection and classifies from the product metadata only', () => {
        const line = {
            price: 1,
            selectedModifiers: Array.from({ length: 50 }, (_, index) => ({ noteProductId: index + 1, group: 'N', option: 'N', price: 0 })),
        };
        expect(toggleNoteProduct(line, { id: 99, name: 'N', price: 0, tax_rate: 0 })).toBe(false);
        expect(noteProductIds(line)).toHaveLength(50);
        expect(isNoteProduct({ category_is_notes: 1 })).toBe(true);
        expect(isNoteProduct({ category_is_notes: 0 })).toBe(false);
    });

    it('repairs a legacy priced-note snapshot without treating it as an ordinary modifier', () => {
        const line = {
            price: 2.9,
            tax_rate: 0,
            note: 'No onion\nTwo slices (+0.20)',
            selectedModifiers: [{ group: 'Two slices', option: 'Two slices', price: 0.2 }],
            modifier_surcharge: 0.2,
        };

        expect(syncNoteProducts(line, new Map([[91, {
            id: 91,
            name: 'Two slices',
            price: 0.2,
            tax_rate: 0,
        }]]))).toEqual({ repaired: 1 });
        expect(line.note).toBe('No onion');
        expect(line.selectedModifiers).toBeNull();
        expect(line.modifier_surcharge).toBeNull();
    });
});
