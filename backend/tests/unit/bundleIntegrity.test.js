import { describe, expect, it } from 'vitest';
const {
    BUNDLE_ORDER_CORRUPT,
    BUNDLE_ORDER_CORRUPT_MESSAGE,
    assertOrderItemBundleIntegrity,
    assertNestedBundleIntegrity
} = require('../../services/bundleIntegrity');

const expectCorrupt = (fn, reason) => {
    let error;
    try { fn(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(409);
    expect(error.publicCode).toBe(BUNDLE_ORDER_CORRUPT);
    expect(error.message).toBe(BUNDLE_ORDER_CORRUPT_MESSAGE);
    expect(error.integrityReason).toBe(reason);
    return error;
};

describe('bundleIntegrity', () => {
    it('accepts a valid flat bundle without mutating rows', () => {
        const rows = [
            { id: 10, invoice_id: 7, parent_item_id: null, quantity: 2 },
            { id: 11, invoice_id: 7, parent_item_id: 10, quantity: 4 }
        ];
        const before = structuredClone(rows);
        expect(assertOrderItemBundleIntegrity(rows)).toBe(rows);
        expect(rows).toEqual(before);
    });

    it('accepts a top-level row with no children', () => {
        const rows = [{ id: 10, invoice_id: 7, parent_item_id: null, quantity: 1 }];
        expect(assertOrderItemBundleIntegrity(rows)).toBe(rows);
    });

    it.each([
        [[{ id: 11, invoice_id: 7, parent_item_id: 10, quantity: 1 }], 'missing_same_invoice_parent'],
        [[
            { id: 10, invoice_id: 6, parent_item_id: null, quantity: 1 },
            { id: 11, invoice_id: 7, parent_item_id: 10, quantity: 1 }
        ], 'cross_invoice_parent'],
        [[
            { id: 9, invoice_id: 7, parent_item_id: null, quantity: 1 },
            { id: 10, invoice_id: 7, parent_item_id: 9, quantity: 1 },
            { id: 11, invoice_id: 7, parent_item_id: 10, quantity: 1 }
        ], 'nested_parent'],
        [[
            { id: 10, invoice_id: 7, parent_item_id: null, quantity: 0 },
            { id: 11, invoice_id: 7, parent_item_id: 10, quantity: 1 }
        ], 'non_positive_parent_quantity'],
        [[
            { id: 10, invoice_id: 7, parent_item_id: null, quantity: 1 },
            { id: 11, invoice_id: 7, parent_item_id: 10, quantity: -1 }
        ], 'non_positive_child_quantity']
    ])('rejects corrupt flat rows with %s', (rows, reason) => {
        expectCorrupt(() => assertOrderItemBundleIntegrity(rows), reason);
    });

    it.each([0, -1, NaN, Infinity])('rejects nested bundle parent quantity %s', qty => {
        expectCorrupt(() => assertNestedBundleIntegrity([{
            cartId: 'bundle-1', qty,
            bundleItems: [{ product_id: 1, qty: 1 }]
        }]), 'non_positive_parent_quantity');
    });

    it('rejects a non-positive active nested child but allows removed legacy metadata', () => {
        expectCorrupt(() => assertNestedBundleIntegrity([{
            cartId: 'bundle-1', qty: 1,
            bundleItems: [{ product_id: 1, qty: 0, removed: false }]
        }]), 'non_positive_child_quantity');
        expect(() => assertNestedBundleIntegrity([{
            cartId: 'bundle-1', qty: 1,
            bundleItems: [{ product_id: 1, removed: true }]
        }])).not.toThrow();
    });
});
