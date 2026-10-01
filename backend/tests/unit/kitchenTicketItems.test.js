import { describe, it, expect, vi } from 'vitest';
const { normalizeKitchenTicketItems } = require('../../services/kitchenTicketItems');

function fakeDb(products) {
    return {
        query: vi.fn(async (sql, params) => {
            expect(sql).toContain('FROM products');
            const wanted = new Set(params.map(Number));
            return [products.filter(product => wanted.has(Number(product.id)))];
        })
    };
}

describe('normalizeKitchenTicketItems', () => {
    it('preserves repeated cart rows as distinct kitchen lines and refreshes categories from products', async () => {
        const db = fakeDb([
            { id: 1, name: 'Test Burger', category_id: 10, is_bundle: 0 },
            { id: 2, name: 'Test Drink', category_id: 20, is_bundle: 0 }
        ]);

        const items = await normalizeKitchenTicketItems([
            { id: 1, product_id: 1, cartId: 'cart-a', name: 'Old Burger', qty: 1, category_id: 999 },
            { id: 1, product_id: 1, name: 'Old Burger', qty: 1, category_id: 999 },
            { id: 2, product_id: 2, cartId: 'cart-c', name: 'Old Drink', quantity: 3, category_id: 999 }
        ], { db, linePrefix: 'held-42' });

        expect(items).toHaveLength(3);
        expect(items.map(item => item.cartId)).toEqual(['cart-a', 'held-42-2-1', 'cart-c']);
        expect(new Set(items.map(item => item.cartId)).size).toBe(3);
        expect(items.map(item => item.product_id)).toEqual([1, 1, 2]);
        expect(items.map(item => item.category_id)).toEqual([10, 10, 20]);
        expect(items[2].qty).toBe(3);
    });

    it('uses product_id ahead of id when a cart row has both fields', async () => {
        const db = fakeDb([
            { id: 7, name: 'Real Product', category_id: 70, is_bundle: 0 }
        ]);

        const items = await normalizeKitchenTicketItems([
            { id: 'frontend-row-1', product_id: 7, name: 'Client Name', qty: 2, category_id: 999 }
        ], { db, linePrefix: 'held-99' });

        expect(items).toHaveLength(1);
        expect(items[0].id).toBe('frontend-row-1');
        expect(items[0].product_id).toBe(7);
        expect(items[0].category_id).toBe(70);
        expect(items[0].cartId).toBe('held-99-1-7');
    });

    it('preserves custom items without product lookup matches', async () => {
        const db = fakeDb([]);

        const items = await normalizeKitchenTicketItems([
            { id: 'CUSTOM_1', name: 'Manual Kitchen Item', qty: 1, category_id: 55, note: 'no onion' }
        ], { db, linePrefix: 'held-custom' });

        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            id: 'CUSTOM_1',
            product_id: null,
            cartId: 'held-custom-1-CUSTOM_1',
            category_id: 55,
            name: 'Manual Kitchen Item',
            qty: 1,
            note: 'no onion',
            is_bundle: 0
        });
    });

    it('normalizes bundle sub-items with their own line identity and refreshed categories', async () => {
        const db = fakeDb([
            { id: 4, name: 'Family Package', category_id: 40, is_bundle: 1 },
            { id: 1, name: 'Burger', category_id: 10, is_bundle: 0 },
            { id: 2, name: 'Drink', category_id: 20, is_bundle: 0 }
        ]);

        const items = await normalizeKitchenTicketItems([
            {
                id: 4,
                product_id: 4,
                cartId: 'bundle-parent',
                name: 'Package',
                qty: 2,
                category_id: 999,
                is_bundle: true,
                bundleItems: [
                    { product_id: 1, name: 'Old Burger', qty: 1, category_id: 999, removed: false },
                    { product_id: 2, name: 'Old Drink', qty: 1, category_id: 999, removed: true }
                ]
            }
        ], { db, linePrefix: 'held-bundle' });

        expect(items).toHaveLength(1);
        expect(items[0].is_bundle).toBeTruthy();
        expect(items[0].category_id).toBe(40);
        expect(items[0].bundleItems).toHaveLength(2);
        expect(items[0].bundleItems[0].product_id).toBe(1);
        expect(items[0].bundleItems[0].category_id).toBe(10);
        expect(items[0].bundleItems[0].cartId).toBe('bundle-parent-bundle-1-1');
        expect(items[0].bundleItems[1].removed).toBe(true);
        expect(items[0].bundleItems[1].category_id).toBe(20);
    });

    it('preserves DB-row bundle parent links so print expansion can attach bundle labels', async () => {
        const db = fakeDb([
            { id: 4, name: 'Family Package', category_id: 40, is_bundle: 1 },
            { id: 1, name: 'Burger', category_id: 10, is_bundle: 0 }
        ]);

        const items = await normalizeKitchenTicketItems([
            { id: 900, product_id: 4, name: 'Family Package', quantity: 1, category_id: 999, is_bundle: 1 },
            { id: 901, parent_item_id: 900, product_id: 1, name: 'Burger', quantity: 2, category_id: 999, is_bundle: 0 }
        ], { db, linePrefix: 'order-44' });

        expect(items).toHaveLength(2);
        expect(items[1].parent_item_id).toBe(900);
        expect(items[1].cartId).toBe('order-44-2-1');
        expect(items[1].qty).toBe(2);
        expect(items[1].category_id).toBe(10);
    });
});
