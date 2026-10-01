import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { withBundleIntegrityChecksDisabled } = require('../helpers/bundleIntegrityFixtures');
const {
    scanBundleIntegrity,
    readBundleConstraintState,
    applyBundleIntegrityConstraints
} = require('../../migrations/apply-bundle-integrity-constraints');

describe('bundle integrity migration schema', () => {
    beforeEach(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        await pool.end();
    });

    async function createOrder() {
        const [result] = await pool.query(
            `INSERT INTO orders (user_id, subtotal, tax, total, payment_method)
             VALUES (?, 1, 0, 1, 'cash')`,
            [SEED.adminUser.id]
        );
        return result.insertId;
    }

    it('enforces positive item quantities and same-invoice bundle parents', async () => {
        const firstInvoiceId = await createOrder();
        const secondInvoiceId = await createOrder();
        const [parent] = await pool.query(
            'INSERT INTO order_items (invoice_id, quantity, price_at_sale) VALUES (?, 1, 1)',
            [firstInvoiceId]
        );
        const [child] = await pool.query(
            'INSERT INTO order_items (invoice_id, quantity, price_at_sale) VALUES (?, 1, 1)',
            [secondInvoiceId]
        );

        await expect(pool.query(
            'INSERT INTO order_items (invoice_id, quantity, price_at_sale) VALUES (?, 0, 1)',
            [firstInvoiceId]
        )).rejects.toThrow();

        await expect(pool.query(
            'UPDATE order_items SET parent_item_id = ? WHERE id = ?',
            [parent.insertId, child.insertId]
        )).rejects.toThrow();

        const state = await readBundleConstraintState(pool);
        expect(state.referencedUniqueIndex).toBeTruthy();
        expect(state.childIndex).toBeTruthy();
        expect(state.quantityCheck).toBeTruthy();
        expect(state.compositeSelfForeignKey).toBeTruthy();
        expect(state.legacySelfForeignKeys).toEqual([]);
    });

    it('adds the named cascading composite FK to a clean stage-one schema with no self FK', async () => {
        await pool.query('ALTER TABLE order_items DROP FOREIGN KEY fk_order_items_parent_invoice');

        const before = await readBundleConstraintState(pool);
        expect(before.referencedUniqueIndex).toBeTruthy();
        expect(before.childIndex).toBeTruthy();
        expect(before.quantityCheck).toBeTruthy();
        expect(before.legacySelfForeignKeys).toEqual([]);
        expect(before.compositeSelfForeignKey).toBeNull();

        // The migration returns its freshly verified final database state.
        const after = await applyBundleIntegrityConstraints(pool);
        expect(after.compositeSelfForeignKey).toMatchObject({
            name: 'fk_order_items_parent_invoice',
            deleteRule: 'CASCADE'
        });

        expect((await applyBundleIntegrityConstraints(pool)).compositeSelfForeignKey).toMatchObject({
            name: 'fk_order_items_parent_invoice',
            deleteRule: 'CASCADE'
        });
        // Complete the metadata/DDL checks before another case resets this DB.
    }, 90_000);

    it('reports exact corrupt row and held/cart reasons when fixture checks are disabled', async () => {
        const invoiceId = await createOrder();
        let nonPositiveItemId;
        await withBundleIntegrityChecksDisabled(pool, async conn => {
            const [item] = await conn.query(
                'INSERT INTO order_items (invoice_id, quantity, price_at_sale) VALUES (?, 0, 1)',
                [invoiceId]
            );
            nonPositiveItemId = item.insertId;
            await conn.query(
                `INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal)
                 VALUES (?, 'bad bundle', ?, 0)`,
                [SEED.adminUser.id, JSON.stringify({ items: [{ cartId: 'broken-bundle', qty: 0, bundleItems: [{ product_id: 1, qty: 1 }] }] })]
            );
        });

        await expect(scanBundleIntegrity(pool)).resolves.toEqual(expect.arrayContaining([
            { entity: 'order_item', reason: 'non_positive_quantity', invoiceId, rowId: nonPositiveItemId, parentId: null },
            expect.objectContaining({ entity: 'held_order', reason: 'non_positive_parent_quantity' })
        ]));
    });

    it('reports bundle definitions whose bundle or component product no longer exists', async () => {
        await withBundleIntegrityChecksDisabled(pool, async conn => {
            await conn.query(
                'INSERT INTO product_bundle_items (bundle_id, product_id, qty) VALUES (?, ?, ?), (?, ?, ?)',
                [190, 1, 1, SEED.bundleProduct.id, 191, 1]
            );
        });

        await expect(scanBundleIntegrity(pool)).resolves.toEqual(expect.arrayContaining([
            {
                entity: 'product_bundle_item',
                reason: 'missing_bundle_product',
                bundleId: 190,
                productId: 1,
                quantity: '1.000'
            },
            {
                entity: 'product_bundle_item',
                reason: 'missing_component_product',
                bundleId: SEED.bundleProduct.id,
                productId: 191,
                quantity: '1.000'
            }
        ]));
    });
});
