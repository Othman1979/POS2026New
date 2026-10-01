// integration/bundle.print.test.js — kitchen bundle expansion
const { expandBundlesForKitchen } = require('../../routes/print');

describe('expandBundlesForKitchen', () => {
    const captureBundleError = fn => {
        try { fn(); } catch (error) { return error; }
        throw new Error('Expected bundle corruption error.');
    };

    it('expands a nested bundle (cart/fire shape) into routable sub-items with _bundleLabel', () => {
        const items = [
            {
                id: 10, name: 'Family Package', qty: 2, is_bundle: 1,
                bundleItems: [
                    { product_id: 1, name: 'Burger', qty: 1, category_id: 5, removed: false },
                    { product_id: 2, name: 'Drink',  qty: 1, category_id: 6, removed: false }
                ]
            }
        ];
        const out = expandBundlesForKitchen(items);

        expect(out).toHaveLength(2);
        expect(out.every(i => i._bundleLabel === 'Family Package')).toBe(true);

        const burger = out.find(i => i.product_id === 1);
        expect(burger.category_id).toBe(5);
        expect(Number(burger.qty)).toBe(2); // sub.qty(1) * bundle.qty(2)

        // the bundle parent itself must NOT appear as a routable item
        expect(out.find(i => i.name === 'Family Package')).toBeUndefined();
    });

    it('drops removed sub-items', () => {
        const items = [
            {
                id: 10, name: 'Combo', qty: 1, is_bundle: 1,
                bundleItems: [
                    { product_id: 1, name: 'Burger', qty: 1, category_id: 5, removed: false },
                    { product_id: 2, name: 'Drink',  qty: 1, category_id: 6, removed: true }
                ]
            }
        ];
        const out = expandBundlesForKitchen(items);
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe('Burger');
    });

    it('handles DB-row shape: parent bundle row dropped, child rows tagged via parent lookup', () => {
        const items = [
            { id: 100, name: 'Family Package', is_bundle: 1, category_id: 9, parent_item_id: null, quantity: 2 },
            { id: 101, name: 'Burger', is_bundle: 0, category_id: 5, parent_item_id: 100, quantity: 2 },
            { id: 102, name: 'Drink',  is_bundle: 0, category_id: 6, parent_item_id: 100, quantity: 2 },
            { id: 200, name: 'Standalone Fries', is_bundle: 0, category_id: 7, parent_item_id: null, quantity: 1 }
        ];
        const out = expandBundlesForKitchen(items);

        // bundle parent (id 100) removed; two children + one standalone remain
        expect(out).toHaveLength(3);
        expect(out.find(i => i.id === 100)).toBeUndefined();
        expect(out.find(i => i.id === 101)._bundleLabel).toBe('Family Package');
        expect(out.find(i => i.id === 102)._bundleLabel).toBe('Family Package');
        const standalone = out.find(i => i.id === 200);
        expect(standalone._bundleLabel).toBeUndefined();
    });

    it('passes plain items through untouched', () => {
        const items = [{ id: 1, name: 'Espresso', category_id: 3, quantity: 1 }];
        const out = expandBundlesForKitchen(items);
        expect(out).toEqual(items);
    });

    it('rejects a zero-quantity nested bundle instead of routing it as quantity one', () => {
        const error = captureBundleError(() => expandBundlesForKitchen([{
            id: 4, name: 'Family Package', qty: 0, is_bundle: 1,
            bundleItems: [{ product_id: 1, name: 'Burger', qty: 1, removed: false }]
        }]));
        expect(error).toMatchObject({ statusCode: 409, publicCode: 'BUNDLE_ORDER_CORRUPT' });
    });

    it('rejects a DB child whose parent is absent from the invoice payload', () => {
        const error = captureBundleError(() => expandBundlesForKitchen([{
            id: 11, invoice_id: 7, parent_item_id: 10,
            product_id: 1, name: 'Burger', quantity: 1
        }]));
        expect(error).toMatchObject({ statusCode: 409, publicCode: 'BUNDLE_ORDER_CORRUPT' });
    });
});
