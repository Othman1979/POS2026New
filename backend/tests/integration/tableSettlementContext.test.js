const crypto = require('node:crypto');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const {
    lockTableSession,
    reconcileSavedTableSettlement
} = require('../../services/TableSettlementContext');

describe('TableSettlementContext integration', () => {
    beforeEach(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        await pool.end();
    });

    async function seedJoinedTableOrder({
        withFee = false,
        withBundle = false,
        discountType = null,
        discountValue = 0
    } = {}) {
        const snapshotId = withFee ? crypto.randomUUID() : null;
        if (snapshotId) {
            await pool.query(
                `INSERT INTO service_charge_snapshots
                    (id, percentage, tax_rate, state, holder_type, holder_id, created_by, version)
                 VALUES (?, 10, 8, 'open_order', 'order', NULL, ?, 2)`,
                [snapshotId, SEED.adminUser.id]
            );
        }

        const [orderResult] = await pool.query(
            `INSERT INTO orders
                (order_id, user_id, waiter_id, table_id, subtotal, tax, total,
                 payment_method, discount_type, discount_value, tax_inclusive_at_sale,
                 service_charge_snapshot_id)
             VALUES (NULL, ?, ?, ?, 20.00, 2.40, 22.40, 'unpaid_table', ?, ?, 0, ?)`,
            [
                SEED.waiterUser.id,
                SEED.waiterUser.id,
                SEED.table.id,
                discountType,
                discountValue,
                snapshotId
            ]
        );
        const invoiceId = orderResult.insertId;
        if (snapshotId) {
            await pool.query(
                'UPDATE service_charge_snapshots SET holder_id=? WHERE id=?',
                [String(invoiceId), snapshotId]
            );
        }

        const [productResult] = await pool.query(
            `INSERT INTO order_items
                (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate,
                 tax_amount, selected_modifiers, modifier_surcharge, discount_type,
                 discount_value, sort_order)
             VALUES (?, ?, ?, 2, 5.00, 16, 1.28, ?, 1.25, 'fixed', 0.50, 0)`,
            [
                invoiceId,
                SEED.product1.id,
                SEED.product1.name,
                JSON.stringify([{ group: 'Size', option: 'Large', price: 1.25 }])
            ]
        );

        let childItemId = null;
        if (withBundle) {
            const [parentResult] = await pool.query(
                `INSERT INTO order_items
                    (invoice_id, product_id, item_name, quantity, price_at_sale,
                     tax_rate, tax_amount, sort_order)
                 VALUES (?, ?, ?, 1, 10.00, 16, 1.60, 1)`,
                [invoiceId, SEED.bundleProduct.id, SEED.bundleProduct.name]
            );
            const [childResult] = await pool.query(
                `INSERT INTO order_items
                    (invoice_id, parent_item_id, product_id, item_name, quantity,
                     price_at_sale, tax_rate, tax_amount, note, sort_order)
                 VALUES (?, ?, ?, ?, 1, 2.00, 0, 0, 'No ice', 2)`,
                [invoiceId, parentResult.insertId, SEED.product2.id, SEED.product2.name]
            );
            childItemId = childResult.insertId;
        }

        if (withFee) {
            await pool.query(
                `INSERT INTO order_items
                    (invoice_id, product_id, item_name, quantity, price_at_sale,
                     tax_rate, tax_amount, note, sort_order)
                 VALUES (?, NULL, '10% Service Charge', 1, 2.00, 8, 0.16,
                         'Auto-Gratuity', 99)`,
                [invoiceId]
            );
        }

        await pool.query(
            `UPDATE restaurant_tables
                SET status='occupied', current_order_id=?, parent_table_id=NULL
              WHERE id=?`,
            [invoiceId, SEED.table.id]
        );
        await pool.query(
            `UPDATE restaurant_tables
                SET status='occupied', current_order_id=?, parent_table_id=?
              WHERE id=?`,
            [invoiceId, SEED.table.id, SEED.table2.id]
        );

        return {
            invoiceId,
            snapshotId,
            productItemId: productResult.insertId,
            childItemId
        };
    }

    async function withTransaction(action) {
        const conn = await pool.getConnection();
        await conn.beginTransaction();
        try {
            return await action(conn);
        } finally {
            await conn.rollback();
            conn.release();
        }
    }

    it('resolves a joined child to one sorted canonical root group with stored money', async () => {
        const fixture = await seedJoinedTableOrder({
            withFee: true,
            discountType: 'percent',
            discountValue: 10
        });

        await withTransaction(async conn => {
            const context = await lockTableSession(conn, {
                user: SEED.adminUser,
                tableId: SEED.table2.id,
                invoiceId: fixture.invoiceId,
                withMoney: true
            });

            expect(context.requestedTableId).toBe(SEED.table2.id);
            expect(context.rootTable.id).toBe(SEED.table.id);
            expect(context.groupTableIds).toEqual([SEED.table.id, SEED.table2.id]);
            expect(context.order.invoice_id).toBe(fixture.invoiceId);
            expect(context.savedItems.map(row => Number(row.id))).toEqual(
                [...context.savedItems].map(row => Number(row.id)).sort((a, b) => a - b)
            );
            expect(context.serviceChargeSnapshot.id).toBe(fixture.snapshotId);
        });
    });

    it.each([
        ['request invoice differs from the table pointer', async ({ invoiceId }) => invoiceId + 999],
        ['child points at another invoice', async ({ invoiceId }) => {
            await pool.query(
                'UPDATE restaurant_tables SET current_order_id=? WHERE id=?',
                [invoiceId + 1, SEED.table2.id]
            );
            return invoiceId;
        }],
        ['order points at another root', async ({ invoiceId }) => {
            await pool.query(
                'UPDATE orders SET table_id=? WHERE invoice_id=?',
                [SEED.table2.id, invoiceId]
            );
            return invoiceId;
        }]
    ])('rejects when %s', async (_label, arrangeInvoice) => {
        const fixture = await seedJoinedTableOrder();
        const invoiceId = await arrangeInvoice(fixture);

        await withTransaction(async conn => {
            await expect(lockTableSession(conn, {
                user: SEED.adminUser,
                tableId: SEED.table.id,
                invoiceId
            })).rejects.toMatchObject({
                statusCode: 409,
                publicCode: 'TABLE_SESSION_CONFLICT'
            });
        });
    });

    it('rejects a missing live order behind a still-bound table group', async () => {
        const { invoiceId } = await seedJoinedTableOrder();
        await pool.query('SET FOREIGN_KEY_CHECKS=0');
        await pool.query('DELETE FROM orders WHERE invoice_id=?', [invoiceId]);
        await pool.query('SET FOREIGN_KEY_CHECKS=1');

        await withTransaction(async conn => {
            await expect(lockTableSession(conn, {
                user: SEED.adminUser,
                tableId: SEED.table.id,
                invoiceId
            })).rejects.toMatchObject({
                statusCode: 409,
                publicCode: 'TABLE_SESSION_CONFLICT'
            });
        });
    });

    it('rebuilds saved fee, discount, modifiers and bundle children from database rows', async () => {
        const fixture = await seedJoinedTableOrder({
            withFee: true,
            withBundle: true,
            discountType: 'fixed',
            discountValue: 1
        });

        await withTransaction(async conn => {
            const context = await lockTableSession(conn, {
                user: SEED.adminUser,
                tableId: SEED.table.id,
                invoiceId: fixture.invoiceId
            });
            const submittedItems = context.savedItems
                .filter(row => row.parent_item_id == null && row.note !== 'Auto-Gratuity')
                .map(row => ({
                    product_id: row.product_id,
                    name: row.item_name,
                    note: row.note || '',
                    qty: Number(row.quantity),
                    price: 0.01,
                    discountType: null,
                    discountValue: 0
                }));

            const settlement = reconcileSavedTableSettlement({
                context,
                submittedItems
            });

            expect(settlement.orderDiscount).toEqual({ type: 'fixed', value: 1 });
            expect(settlement.hasBoundServiceCharge).toBe(true);
            expect(settlement.items.at(-1).note).toBe('Auto-Gratuity');
            expect(settlement.items[0]).toMatchObject({
                price: 5,
                tax_rate: 16,
                modifier_surcharge: 1.25,
                discountType: 'fixed',
                discountValue: 0.5,
                order_item_id: fixture.productItemId
            });
            expect(settlement.items.find(item => item.is_bundle)).toMatchObject({
                persistedBundleParent: expect.objectContaining({ product_id: SEED.bundleProduct.id }),
                persistedBundleChildren: [expect.objectContaining({ id: fixture.childItemId })]
            });
        });
    });

    it('rejects submitted product quantity changes', async () => {
        const fixture = await seedJoinedTableOrder();

        await withTransaction(async conn => {
            const context = await lockTableSession(conn, {
                user: SEED.adminUser,
                tableId: SEED.table.id,
                invoiceId: fixture.invoiceId
            });
            await expect(() => reconcileSavedTableSettlement({
                context,
                submittedItems: [{
                    product_id: SEED.product1.id,
                    name: SEED.product1.name,
                    note: '',
                    qty: 1
                }]
            })).toThrowError(/cannot be changed/i);
        });
    });

    it.each([
        ['an added product', [
            { product_id: SEED.product1.id, name: SEED.product1.name, note: '', qty: 2 },
            { product_id: SEED.product2.id, name: SEED.product2.name, note: '', qty: 1 }
        ]],
        ['a removed product', []],
        ['a changed quantity', [
            { product_id: SEED.product1.id, name: SEED.product1.name, note: '', qty: 1 }
        ]]
    ])('rejects %s through the single settlement reconciliation', async (_label, submittedItems) => {
        const fixture = await seedJoinedTableOrder();

        await withTransaction(async conn => {
            const context = await lockTableSession(conn, {
                user: SEED.adminUser,
                tableId: SEED.table.id,
                invoiceId: fixture.invoiceId
            });
            expect(() => reconcileSavedTableSettlement({ context, submittedItems }))
                .toThrowError(/cannot be changed/i);
        });
    });

    it('rejects duplicate or identity-swapped submitted saved-item IDs', async () => {
        const fixture = await seedJoinedTableOrder();

        await withTransaction(async conn => {
            const context = await lockTableSession(conn, {
                user: SEED.adminUser,
                tableId: SEED.table.id,
                invoiceId: fixture.invoiceId
            });
            const saved = context.savedItems.find(row => row.parent_item_id == null && row.note !== 'Auto-Gratuity');
            const duplicate = {
                product_id: SEED.product1.id,
                name: SEED.product1.name,
                note: '',
                qty: 1,
                order_item_id: saved.id
            };
            expect(() => reconcileSavedTableSettlement({ context, submittedItems: [duplicate, duplicate] }))
                .toThrowError(/saved item identity changed/i);
            expect(() => reconcileSavedTableSettlement({ context, submittedItems: [{
                ...duplicate,
                product_id: SEED.product2.id,
                name: SEED.product2.name,
                qty: 2
            }] })).toThrowError(/saved item identity changed/i);
        });
    });

    it('rebuilds duplicate product lines from their stored frozen prices despite swapped submitted IDs', async () => {
        const fixture = await seedJoinedTableOrder();
        const [second] = await pool.query(
            `INSERT INTO order_items
                (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, sort_order)
             VALUES (?, ?, ?, 1, 7.00, 16, 1.12, 1)`,
            [fixture.invoiceId, SEED.product1.id, SEED.product1.name]
        );

        await withTransaction(async conn => {
            const context = await lockTableSession(conn, {
                user: SEED.adminUser,
                tableId: SEED.table.id,
                invoiceId: fixture.invoiceId
            });
            const parents = context.savedItems.filter(row => row.parent_item_id == null && row.note !== 'Auto-Gratuity');
            const settlement = reconcileSavedTableSettlement({
                context,
                submittedItems: [...parents].reverse().map(row => ({
                    product_id: row.product_id,
                    name: row.item_name,
                    note: row.note || '',
                    qty: Number(row.quantity),
                    order_item_id: row.id,
                    price: row.id === second.insertId ? 5 : 7
                }))
            });
            expect(settlement.items.filter(item => item.note !== 'Auto-Gratuity').map(item => ({
                id: item.order_item_id,
                price: item.price,
                qty: item.qty
            }))).toEqual([
                { id: fixture.productItemId, price: 5, qty: 2 },
                { id: second.insertId, price: 7, qty: 1 }
            ]);
        });
    });

    it('rejects a saved fee line that has no bound snapshot', async () => {
        const fixture = await seedJoinedTableOrder();
        await pool.query(
            `INSERT INTO order_items
                (invoice_id, product_id, item_name, quantity, price_at_sale,
                 tax_rate, tax_amount, note, sort_order)
             VALUES (?, NULL, 'Orphan Service Charge', 1, 1.00, 0, 0,
                     'Auto-Gratuity', 99)`,
            [fixture.invoiceId]
        );

        await withTransaction(async conn => {
            const context = await lockTableSession(conn, {
                user: SEED.adminUser,
                tableId: SEED.table.id,
                invoiceId: fixture.invoiceId
            });
            expect(() => reconcileSavedTableSettlement({
                context,
                submittedItems: [{
                    product_id: SEED.product1.id,
                    name: SEED.product1.name,
                    note: '',
                    qty: 2
                }]
            })).toThrowError(/service-charge line changed/i);
        });
    });
});
