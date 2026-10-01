import { describe, expect, it } from 'vitest';
import {
    cartDisagreesWithCatalogRows,
    chunkProductIds,
    collectCartCatalogProductIds,
    requestedIdsCoverCurrentDraft,
    syncCategoryPrices,
} from '@/pos/categoryPriceSync.js';

describe('category price cart sync', () => {
    it('reprices only eligible unsaved register lines and keeps modifiers', () => {
        const lines = [
            { id: 1, price: 1.1, modifier_surcharge: 0.1, tax_rate: 8 },
            { id: 2, price: 3, manual_price_override: true },
            { id: 3, price: 4, order_item_id: 99 },
            { id: 'service_charge', price: 1, is_service_charge: true }
        ];
        syncCategoryPrices(lines, [{ product_id: 1, price: 2, tax_rate: 16 }]);
        expect(lines[0]).toMatchObject({ price: 2.1, tax_rate: 16 });
        expect(lines[1].price).toBe(3);
        expect(lines[2].price).toBe(4);
        expect(lines[3].price).toBe(1);
    });

    it('keeps a priced note through refresh and canonicalizes its name and price', () => {
        const lines = [{
            id: 1, price: 2.9, tax_rate: 0, modifier_surcharge: 0.2, modifier_tax_amount: 0,
            note: 'Two slices (+0.20)',
            selectedModifiers: [{ noteProductId: 91, group: 'Two slices', option: 'Two slices', price: 0.2 }]
        }];

        const result = syncCategoryPrices(lines, [
            { product_id: 1, price: 2.7, tax_rate: 0 },
            { product_id: 91, name: 'Three slices', price: 0.25, tax_rate: 0, product_is_active: 1, category_is_active: 1, category_is_notes: 1 }
        ]);

        expect(lines[0]).toMatchObject({ price: 2.95, modifier_surcharge: 0.25, note: 'Three slices (+0.25)' });
        expect(result.repairedNoteSelections).toBe(0);
    });

    it('repairs only an id-less structured priced-note fragment', () => {
        const lines = [{
            id: 1, price: 2.9, tax_rate: 0, modifier_surcharge: null,
            note: 'No onions\nTwo slices (+0.20)',
            selectedModifiers: [
                { group: 'Two slices', option: 'Two slices', price: 0.2 },
                { gid: 'g1', oid: 'o1', group: 'Size', option: 'Large', price: 0 }
            ]
        }];

        const result = syncCategoryPrices(lines, [{ product_id: 1, price: 2.7, tax_rate: 0 }]);

        expect(lines[0]).toMatchObject({ price: 2.7, note: 'No onions\nSize: Large' });
        expect(lines[0].selectedModifiers).toEqual([{ gid: 'g1', oid: 'o1', group: 'Size', option: 'Large', price: 0 }]);
        expect(result.repairedNoteSelections).toBe(1);
    });

    it('does not reprice frozen lines or rewrite ordinary free text and guards stale refresh coverage', () => {
        const frozen = { id: 1, order_item_id: 10, price: 2.9, note: 'Two slices (+0.20)' };
        const ordinaryText = { id: 2, price: 2.7, note: 'Two slices (+0.20)', selectedModifiers: null };
        syncCategoryPrices([frozen, ordinaryText], [{ product_id: 1, price: 1, tax_rate: 0 }, { product_id: 2, price: 1, tax_rate: 0 }]);
        expect(frozen.price).toBe(2.9);
        expect(ordinaryText.note).toBe('Two slices (+0.20)');
        expect(requestedIdsCoverCurrentDraft([1, 91], [1, 92])).toBe(false);
        expect(requestedIdsCoverCurrentDraft([1, 91], [1])).toBe(true);
    });

    it('requests and refreshes locks for saved and manually priced lines without rewriting prices', () => {
        const saved = { id: 1, order_item_id: 10, price: 9 };
        const manual = { id: 2, manual_price_override: true, price: 8 };
        const requestedIds = collectCartCatalogProductIds([saved, manual]);

        expect(requestedIds).toEqual([1, 2]);
        syncCategoryPrices([saved, manual], [
            { product_id: 1, price: 3, tax_rate: 0, price_override_locked: 1 },
            { product_id: 2, price: 3, tax_rate: 0, price_override_locked: 1 }
        ]);

        expect(saved).toMatchObject({ price: 9, price_override_locked: 1 });
        expect(manual).toMatchObject({ price: 8, price_override_locked: 1 });
    });

    it('refreshes lock metadata without repricing a server-canonical held line', () => {
        const held = { id: 1, price: 9 };

        syncCategoryPrices(
            [held],
            [{ product_id: 1, price: 3, tax_rate: 0, price_override_locked: 1 }],
            { refreshPrices: false }
        );

        expect(held).toMatchObject({ price: 9, price_override_locked: 1 });
    });

    it('batches at the resolver maximum and collects both base and structured note ids', () => {
        expect(chunkProductIds(Array.from({ length: 301 }, (_, index) => index + 1)))
            .toEqual([Array.from({ length: 300 }, (_, index) => index + 1), [301]]);
        expect(collectCartCatalogProductIds([
            { id: 1, selectedModifiers: [{ noteProductId: 91 }] },
            { id: 2, order_item_id: 10, selectedModifiers: [{ noteProductId: 92 }] },
            { id: 3, manual_price_override: true, selectedModifiers: [{ noteProductId: 93 }] },
        ])).toEqual([1, 91, 2, 3]);
    });

    it('treats a tax-rate change at an unchanged price as a cart that needs re-pricing', () => {
        const lines = [{ id: 1, price: 2, tax_rate: 8 }];
        expect(cartDisagreesWithCatalogRows(lines, [{ id: 1, price: 2, tax_rate: 16 }])).toBe(true);
        expect(cartDisagreesWithCatalogRows(lines, [{ id: 1, price: 2, tax_rate: 8 }])).toBe(false);
    });
});
