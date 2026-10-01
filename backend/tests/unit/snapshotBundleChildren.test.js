import { describe, it, expect } from 'vitest';
import bundleOrderItems from '../../services/bundleOrderItems.js';

const { insertSnapshotBundleChildren } = bundleOrderItems;

function fakeConnection() {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            return [{ insertId: calls.length }];
        }
    };
}

describe('insertSnapshotBundleChildren', () => {
    it('preserves a trusted held snapshot while auditing removed children', async () => {
        const conn = fakeConnection();

        const nextSortOrder = await insertSnapshotBundleChildren(conn, {
            invoiceId: 42,
            parentItemId: 99,
            parentQty: 2,
            snapshotSubs: [
                { product_id: 11, name: 'Burger', qty: 1, note: 'No onion', removed: false },
                { product_id: 12, name: 'Drink', qty: 1, note: null, removed: true }
            ],
            startSortOrder: 3,
            cashierId: 7,
            auditRemoved: true
        });

        expect(nextSortOrder).toBe(4);
        expect(conn.calls).toHaveLength(2);
        expect(conn.calls[0]).toMatchObject({
            params: [[[42, 11, 'Burger', 2, 0, 0, 0, 'No onion', null, 0, 3, 99]]]
        });
        expect(conn.calls[1].sql).toContain('INSERT INTO bundle_modifications');
        expect(conn.calls[1].params).toEqual([42, 7, 'Drink']);
    });
});
