const { tableActionIntent } = require('../fixtures/tableActionIntent');
const { currentTableRevision } = require('../fixtures/tableOrderRevision');
// integration/bundle.tables.test.js — Task 11 (I4): table-order bundle support.
//
// The TABLE path (POST /api/pos/table_order) must mint a priced bundle PARENT row
// plus DB-driven zero-priced CHILD rows (parent_item_id set), reject forged bundle
// carts the same way checkout does, and route bundle SUB-items to the kitchen
// (preserving bundleItems through to printKitchenOrder so expandBundlesForKitchen
// can flatten them).
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const printModule = require('../../routes/print');
const { reconstructBundleSubs } = require('../../services/bundleOrderItems');
const { withBundleIntegrityChecksDisabled } = require('../helpers/bundleIntegrityFixtures');

describe('Table-order bundle support (I4)', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    // Bundle line: parent price 10.00 @16% => tax 1.60, total 11.60. Two DB members
    // (product1 qty1, product2 qty1) carry their own category_ids for routing.
    function bundleCartItem(overrides = {}) {
        return {
            id: SEED.bundleProduct.id,
            product_id: SEED.bundleProduct.id,
            name: SEED.bundleProduct.name,
            qty: 1,
            price: SEED.bundleProduct.price,
            is_bundle: true,
            bundleItems: [
                { product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, category_id: 5, removed: false },
                { product_id: SEED.product2.id, name: SEED.product2.name, qty: 1, category_id: 6, removed: false }
            ],
            ...overrides
        };
    }

    async function openAdminShift() {
        const openRes = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', adminCookie)
            .send({ user_id: SEED.adminUser.id, starting_cash: 50.00 });
        expect(openRes.statusCode).toBe(200);
        const [[shift]] = await pool.query(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
            [SEED.adminUser.id]
        );
        return shift.id;
    }

    async function settleSplitCheck({ splitCheckId, parentInvoiceId, shiftId, idempotencyKey }) {
        return request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.bundleProduct.id, qty: 1, price: SEED.bundleProduct.price }],
                subtotal: 10.00,
                tax: 1.60,
                total: 11.60,
                payment_method: 'cash',
                amount_tendered: 11.60,
                change_due: 0,
                shift_id: shiftId,
                split_check_id: splitCheckId,
                parent_invoice_id: parentInvoiceId,
                is_split: true,
                table_id: SEED.table.id,
                idempotency_key: idempotencyKey
            });
    }

    async function corruptBundleParentQuantity(invoiceId) {
        const [items] = await pool.query(
            'SELECT id FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL',
            [invoiceId]
        );
        await withBundleIntegrityChecksDisabled(pool, async conn => {
            await conn.query('UPDATE order_items SET quantity = 0 WHERE id = ?', [items[0].id]);
        });
    }

    async function snapshotTableMutationState(invoiceId, tableId) {
        const [items] = await pool.query('SELECT * FROM order_items WHERE invoice_id = ? ORDER BY id', [invoiceId]);
        const [orders] = await pool.query('SELECT * FROM orders WHERE invoice_id = ?', [invoiceId]);
        const [tables] = await pool.query('SELECT * FROM restaurant_tables WHERE id = ?', [tableId]);
        const [stock] = await pool.query('SELECT id, stock FROM products ORDER BY id');
        const [audits] = await pool.query('SELECT * FROM audit_events WHERE entity_id = ? ORDER BY id', [invoiceId]);
        return { items, orders, tables, stock, audits };
    }

    function watchBusinessMutations() {
        const writes = [];
        const originalGetConnection = pool.getConnection.bind(pool);
        const patchedConnections = [];
        const getConnectionSpy = vi.spyOn(pool, 'getConnection').mockImplementation(async (...args) => {
            const conn = await originalGetConnection(...args);
            const originalQuery = conn.query;
            const originalExecute = conn.execute;
            const record = sql => {
                const statement = String(sql).replace(/\s+/g, ' ').trim();
                if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement)) writes.push(statement);
            };
            conn.query = async (sql, ...params) => {
                record(sql);
                return originalQuery.call(conn, sql, ...params);
            };
            conn.execute = async (sql, ...params) => {
                record(sql);
                return originalExecute.call(conn, sql, ...params);
            };
            patchedConnections.push({ conn, originalQuery, originalExecute });
            return conn;
        });

        return {
            writes,
            restore() {
                getConnectionSpy.mockRestore();
                for (const { conn, originalQuery, originalExecute } of patchedConnections) {
                    conn.query = originalQuery;
                    conn.execute = originalExecute;
                }
            }
        };
    }

    async function replaceBundleDefinition() {
        await pool.query('DELETE FROM product_bundle_items WHERE bundle_id = ?', [SEED.bundleProduct.id]);
        await pool.query(
            'INSERT INTO product_bundle_items (bundle_id, product_id, qty, sort_order) VALUES (?, ?, ?, ?)',
            [SEED.bundleProduct.id, 3, 1, 0]
        );
    }

    async function makeSavedChildrenHistorical(invoiceId) {
        const [children] = await pool.query(
            'SELECT id, product_id FROM order_items WHERE invoice_id = ? AND parent_item_id IS NOT NULL ORDER BY product_id',
            [invoiceId]
        );
        const burger = children.find(child => Number(child.product_id) === SEED.product1.id);
        await pool.query(
            "UPDATE order_items SET item_name = 'Historic Burger', note = 'No onions', quantity = 6 WHERE id = ?",
            [burger.id]
        );
    }

    it('bundle corruption: GET table_order rejects an invoice-local cross-invoice child instead of dropping it', async () => {
        const sourceRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem()],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(sourceRes.statusCode).toBe(200);

        const targetRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table2.id,
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        expect(targetRes.statusCode).toBe(200);

        const [sourceChildren] = await pool.query(
            'SELECT id FROM order_items WHERE invoice_id = ? AND parent_item_id IS NOT NULL',
            [sourceRes.body.order_id]
        );
        await withBundleIntegrityChecksDisabled(pool, async conn => {
            await conn.query('UPDATE order_items SET invoice_id = ? WHERE id = ?', [targetRes.body.order_id, sourceChildren[0].id]);
        });

        const recalled = await request(app)
            .get('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .query({ order_id: targetRes.body.order_id });

        expect(recalled.statusCode).toBe(409);
        expect(recalled.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        expect(recalled.body.success).toBe(false);
    });

    it('bundle corruption: table resave rejects corrupt persisted parent before rewriting state', async () => {
        const created = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem()],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(created.statusCode).toBe(200);
        await corruptBundleParentQuantity(created.body.order_id);
        const before = await snapshotTableMutationState(created.body.order_id, SEED.table.id);

        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: created.body.order_id, expected_version: await currentTableRevision(created.body.order_id),
                cart: [bundleCartItem()],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });

        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        expect(await snapshotTableMutationState(created.body.order_id, SEED.table.id)).toEqual(before);
    });

    it('bundle corruption: empty-cart table void rejects corrupt persisted rows before mutation', async () => {
        const created = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem()],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(created.statusCode).toBe(200);
        await corruptBundleParentQuantity(created.body.order_id);
        const before = await snapshotTableMutationState(created.body.order_id, SEED.table.id);

        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: created.body.order_id, expected_version: await currentTableRevision(created.body.order_id),
                cart: []
            });

        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        expect(await snapshotTableMutationState(created.body.order_id, SEED.table.id)).toEqual(before);
    });

    it('bundle corruption: reconstructBundleSubs rejects corrupt rows and preserves valid output', async () => {
        const zeroParent = {
            id: 10, invoice_id: 7, parent_item_id: null,
            product_id: SEED.bundleProduct.id, quantity: 0
        };
        const child = {
            id: 11, invoice_id: 7, parent_item_id: 10,
            product_id: SEED.product1.id, item_name: SEED.product1.name, quantity: 1
        };
        await expect(reconstructBundleSubs(pool, zeroParent, [child]))
            .rejects.toMatchObject({ statusCode: 409, publicCode: 'BUNDLE_ORDER_CORRUPT' });

        await expect(reconstructBundleSubs(pool, {
            ...zeroParent,
            quantity: 1
        }, [{ ...child, invoice_id: 8 }]))
            .rejects.toMatchObject({ statusCode: 409, publicCode: 'BUNDLE_ORDER_CORRUPT' });

        await expect(reconstructBundleSubs(pool, {
            ...zeroParent,
            quantity: 2
        }, [{ ...child, quantity: 4, note: 'No onions' }])).resolves.toEqual([
            {
                product_id: SEED.product1.id,
                name: SEED.product1.name,
                qty: 2,
                note: 'No onions',
                removed: false
            }
        ]);
    });

    it('saves a NEW table order with a bundle: priced parent + DB-driven zero-priced children', async () => {
        // qty 2 to also prove child qty = DB member qty (1) × parent qty (2) = 2.
        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 2 })],
                subtotal: 20.00, tax: 3.20, total: 23.20
            });
        expect(res.statusCode).toBe(200);
        const invoiceId = res.body.order_id;

        const [items] = await pool.query(
            "SELECT * FROM order_items WHERE invoice_id = ? ORDER BY sort_order", [invoiceId]
        );
        expect(items).toHaveLength(3);

        const parent = items.find(i => i.parent_item_id === null);
        expect(parent.product_id).toBe(SEED.bundleProduct.id);
        expect(Number(parent.price_at_sale)).toBe(10);
        expect(Number(parent.tax_amount)).toBe(3.2); // tax on parent only

        const children = items.filter(i => i.parent_item_id !== null);
        expect(children).toHaveLength(2);
        const childPids = children.map(c => c.product_id).sort();
        expect(childPids).toEqual([SEED.product1.id, SEED.product2.id]);
        for (const c of children) {
            expect(c.parent_item_id).toBe(parent.id);
            expect(Number(c.price_at_sale)).toBe(0);
            expect(Number(c.tax_rate)).toBe(0);
            expect(Number(c.tax_amount)).toBe(0);
            expect(Number(c.quantity)).toBe(2); // DB qty(1) × parent qty(2)
        }

        // Tax lives on the parent only.
        const taxed = items.filter(i => Number(i.tax_amount) > 0);
        expect(taxed).toHaveLength(1);
        expect(taxed[0].parent_item_id).toBeNull();
    });

    it('rejects a non-bundle product carrying forged bundleItems (forge: non-bundle parent)', async () => {
        // product1 (is_bundle=0) + bundleItems is a client forgery. Totals match product1
        // so we reach the bundle validation, not the money assertion.
        const mutations = watchBusinessMutations();
        try {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{
                        id: SEED.product1.id,
                        product_id: SEED.product1.id,
                        qty: 1,
                        price: SEED.product1.price,
                        bundleItems: [
                            { product_id: SEED.product2.id, name: SEED.product2.name, qty: 1, removed: false }
                        ]
                    }],
                    subtotal: 5.00, tax: 0.80, total: 5.80
                });
            expect(res.statusCode).toBe(400);
            expect(mutations.writes).toEqual([]);
        } finally {
            mutations.restore();
        }

        // Rollback must leave nothing: no order, no order_items, table untouched.
        const [orders] = await pool.query("SELECT invoice_id FROM orders");
        expect(orders).toHaveLength(0);
        const [oi] = await pool.query("SELECT id FROM order_items");
        expect(oi).toHaveLength(0);
        const [[t]] = await pool.query("SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
        expect(t.status).toBe('available');
        expect(t.current_order_id).toBeNull();
    });

    it('rejects a forged dynamic-table bundle before creating dynamic table rows', async () => {
        await pool.query("UPDATE settings SET setting_value = 'dynamic' WHERE setting_key = 'table_mode'");
        const mutations = watchBusinessMutations();
        try {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_number: 99,
                    cart: [{
                        id: SEED.product1.id,
                        product_id: SEED.product1.id,
                        qty: 1,
                        price: SEED.product1.price,
                        bundleItems: [{ product_id: SEED.product2.id, qty: 1, removed: false }]
                    }],
                    subtotal: 5.00, tax: 0.80, total: 5.80
                });

            expect(res.statusCode).toBe(400);
            expect(mutations.writes).toEqual([]);
        } finally {
            mutations.restore();
        }

        const [tables] = await pool.query('SELECT id FROM restaurant_tables WHERE table_number = 99');
        expect(tables).toEqual([]);
    });

    it('rejects a real bundle with a null-product_id child (forge: null child)', async () => {
        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({
                    bundleItems: [
                        { product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, removed: false },
                        { product_id: null, name: 'Injected Free Item', qty: 1, removed: false }
                    ]
                })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(res.statusCode).toBe(400);
        const [orders] = await pool.query("SELECT invoice_id FROM orders");
        expect(orders).toHaveLength(0);
        const [oi] = await pool.query("SELECT id FROM order_items");
        expect(oi).toHaveLength(0);
    });

    it('rejects a real bundle with a non-member child (forge: non-member child)', async () => {
        // product id=3 is not a member of bundle id=4 per product_bundle_items.
        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({
                    bundleItems: [
                        { product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, removed: false },
                        { product_id: 3, name: 'No Stock Item', qty: 1, removed: false }
                    ]
                })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(res.statusCode).toBe(400);
        const [orders] = await pool.query("SELECT invoice_id FROM orders");
        expect(orders).toHaveLength(0);
    });

    it('routes bundle SUB-items to the kitchen: bundleItems reach printKitchenOrder intact', async () => {
        let capturedItems;
        const spy = vi.spyOn(printModule, 'printKitchenOrder').mockImplementation(async (_io, data) => {
            capturedItems = data.items; // snapshot before expandBundlesForKitchen
            return 0;
        });

        await pool.query("INSERT INTO categories (id, name) VALUES (5, 'Cat 5'), (6, 'Cat 6') ON DUPLICATE KEY UPDATE name=name");
        await pool.query("UPDATE products SET category_id = 5 WHERE id = ?", [SEED.product1.id]);
        await pool.query("UPDATE products SET category_id = 6 WHERE id = ?", [SEED.product2.id]);

        try {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [bundleCartItem()],
                    subtotal: 10.00, tax: 1.60, total: 11.60
                });
            expect(res.statusCode).toBe(200);

            expect(capturedItems).toBeDefined();
            // The bundle line must NOT be filtered out before expansion.
            const bundleItem = capturedItems.find(i => Array.isArray(i.bundleItems));
            expect(bundleItem).toBeDefined();
            expect(bundleItem.is_bundle).toBeTruthy();
            expect(bundleItem.bundleItems).toHaveLength(2);

            const subCatIds = bundleItem.bundleItems.map(s => s.category_id);
            expect(subCatIds).toContain(5);
            expect(subCatIds).toContain(6);

            // Confirm the print module actually flattens to the two sub-items (no parent).
            const expanded = printModule.expandBundlesForKitchen(capturedItems);
            const expandedPids = expanded.map(i => i.product_id);
            expect(expandedPids).toContain(SEED.product1.id);
            expect(expandedPids).toContain(SEED.product2.id);
            expect(expanded.find(i => i.product_id === SEED.bundleProduct.id)).toBeUndefined();
        } finally {
            spy.mockRestore();
        }
    });

    it('GET /table_order reconstructs bundle items and resaving preserves structure', async () => {
        // 1. Save a table order with a bundle
        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        // 2. GET /table_order
        const getRes = await request(app)
            .get('/api/pos/table_order')
            .query({ order_id: orderId })
            .set('Cookie', adminCookie);
        expect(getRes.statusCode).toBe(200);

        const cart = getRes.body.cart;
        // Verify we only have 1 top level item (the parent bundle), not 3 items
        expect(cart).toHaveLength(1);
        expect(cart[0].id).toBe(SEED.bundleProduct.id);
        expect(cart[0].is_bundle).toBe(true);
        expect(cart[0].bundleItems).toHaveLength(2);
        
        // Assert child details are reconstructed
        const subPids = cart[0].bundleItems.map(s => s.product_id).sort();
        expect(subPids).toEqual([SEED.product1.id, SEED.product2.id]);
        expect(cart[0].bundleItems[0].removed).toBe(false);

        // 3. Resave the order with the reconstructed bundle
        const resaveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId, expected_version: await currentTableRevision(orderId),
                cart: cart,
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(resaveRes.statusCode).toBe(200);

        // Confirm database still has 3 rows (1 parent, 2 children)
        const [items] = await pool.query(
            "SELECT * FROM order_items WHERE invoice_id = ? ORDER BY sort_order", [orderId]
        );
        expect(items).toHaveLength(3);
        const parent = items.find(i => i.parent_item_id === null);
        expect(parent.product_id).toBe(SEED.bundleProduct.id);
        const children = items.filter(i => i.parent_item_id !== null);
        expect(children).toHaveLength(2);
        for (const c of children) {
            expect(c.parent_item_id).toBe(parent.id);
        }
    });

    it('recalls and resaves persisted bundle children after the catalog definition changes', async () => {
        const created = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 2 })],
                subtotal: 20.00, tax: 3.20, total: 23.20
            });
        expect(created.statusCode).toBe(200);
        const orderId = created.body.order_id;

        await makeSavedChildrenHistorical(orderId);
        await replaceBundleDefinition();

        const recalled = await request(app)
            .get('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .query({ order_id: orderId });

        expect(recalled.statusCode).toBe(200);
        expect(recalled.body.cart).toHaveLength(1);
        expect(recalled.body.cart[0].bundleItems).toEqual([
            expect.objectContaining({
                product_id: SEED.product1.id,
                name: 'Historic Burger',
                note: 'No onions',
                qty: 3,
                removed: false
            }),
            expect.objectContaining({
                product_id: SEED.product2.id,
                name: SEED.product2.name,
                note: null,
                qty: 1,
                removed: false
            })
        ]);
        expect(recalled.body.cart[0].bundleItems.some(item => Number(item.product_id) === 3)).toBe(false);

        const resavedCart = recalled.body.cart;
        // Saved table quantities may only increase through table-save. Removal/reduction
        // belongs to the dedicated Remove/refund route.
        resavedCart[0].qty = 3;
        const resaved = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId, expected_version: await currentTableRevision(orderId),
                cart: resavedCart,
                subtotal: 30.00, tax: 4.80, total: 34.80
            });

        expect(resaved.statusCode).toBe(200);
        const [children] = await pool.query(
            'SELECT product_id, item_name, note, quantity FROM order_items WHERE invoice_id = ? AND parent_item_id IS NOT NULL ORDER BY product_id',
            [orderId]
        );
        expect(children.map(child => ({ ...child, quantity: Number(child.quantity) }))).toEqual([
            expect.objectContaining({ product_id: SEED.product1.id, item_name: 'Historic Burger', note: 'No onions', quantity: 9 }),
            expect.objectContaining({ product_id: SEED.product2.id, item_name: SEED.product2.name, note: null, quantity: 3 })
        ]);
        expect(children.some(item => Number(item.product_id) === 3)).toBe(false);
    });

    it('merges persisted bundle children after the catalog definition changes', async () => {
        const source = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 2 })],
                subtotal: 20.00, tax: 3.20, total: 23.20
            });
        expect(source.statusCode).toBe(200);
        await makeSavedChildrenHistorical(source.body.order_id);

        const target = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table2.id,
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        expect(target.statusCode).toBe(200);

        await replaceBundleDefinition();
        const merged = await request(app)
            .post('/api/pos/tables/transfer')
            .set('Cookie', adminCookie)
            .send(await tableActionIntent(pool, { sourceTableId: SEED.table.id, targetTableId: SEED.table2.id, action: 'merge' }));

        expect(merged.statusCode).toBe(200);
        const [children] = await pool.query(
            `SELECT oi.product_id, oi.item_name, oi.note, oi.quantity
               FROM order_items oi
               JOIN order_items parent ON parent.id = oi.parent_item_id
              WHERE oi.invoice_id = ? AND parent.product_id = ?
              ORDER BY oi.product_id`,
            [target.body.order_id, SEED.bundleProduct.id]
        );
        expect(children.map(child => ({ ...child, quantity: Number(child.quantity) }))).toEqual([
            expect.objectContaining({ product_id: SEED.product1.id, item_name: 'Historic Burger', note: 'No onions', quantity: 6 }),
            expect.objectContaining({ product_id: SEED.product2.id, item_name: SEED.product2.name, note: null, quantity: 2 })
        ]);
        expect(children.some(item => Number(item.product_id) === 3)).toBe(false);
    });

    it('rejects forged bundleItems on a saved non-bundle line before mutation or kitchen printing', async () => {
        const created = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        expect(created.statusCode).toBe(200);
        const [[savedParent]] = await pool.query(
            'SELECT id FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL',
            [created.body.order_id]
        );
        const before = await snapshotTableMutationState(created.body.order_id, SEED.table.id);
        const printSpy = vi.spyOn(printModule, 'printKitchenOrder').mockResolvedValue(0);

        try {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: created.body.order_id, expected_version: await currentTableRevision(created.body.order_id),
                    cart: [{
                        id: SEED.product1.id,
                        product_id: SEED.product1.id,
                        order_item_id: savedParent.id,
                        qty: 2,
                        price: SEED.product1.price,
                        is_bundle: true,
                        bundleItems: [{ product_id: SEED.product1.id, qty: 1, removed: false }]
                    }],
                    subtotal: 10.00, tax: 1.60, total: 11.60
                });

            expect(res.statusCode).toBe(400);
            expect(await snapshotTableMutationState(created.body.order_id, SEED.table.id)).toEqual(before);
            expect(printSpy).not.toHaveBeenCalled();
        } finally {
            printSpy.mockRestore();
        }
    });

    it('validates a forged product identity on a saved bundle parent before mutation', async () => {
        const created = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem()],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(created.statusCode).toBe(200);
        const [[savedParent]] = await pool.query(
            'SELECT id FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL',
            [created.body.order_id]
        );
        const before = await snapshotTableMutationState(created.body.order_id, SEED.table.id);
        const mutations = watchBusinessMutations();

        try {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: created.body.order_id, expected_version: await currentTableRevision(created.body.order_id),
                    cart: [{
                        id: SEED.product1.id,
                        product_id: SEED.product1.id,
                        order_item_id: savedParent.id,
                        qty: 1,
                        price: SEED.product1.price,
                        bundleItems: [{ product_id: SEED.product2.id, qty: 1, removed: false }]
                    }],
                    subtotal: 5.00, tax: 0.80, total: 5.80
                });

            expect(res.statusCode).toBe(400);
            expect(mutations.writes).toEqual([]);
        } finally {
            mutations.restore();
        }

        expect(await snapshotTableMutationState(created.body.order_id, SEED.table.id)).toEqual(before);
    });

    it('replaces raw saved-bundle members with locked persisted children before kitchen printing', async () => {
        const created = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem()],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(created.statusCode).toBe(200);

        const recalled = await request(app)
            .get('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .query({ order_id: created.body.order_id });
        expect(recalled.statusCode).toBe(200);
        const forgedCart = recalled.body.cart;
        forgedCart[0].qty = 2;
        forgedCart[0].bundleItems.push({
            product_id: 3,
            name: 'No Stock Item',
            qty: 1,
            removed: false
        });
        let printedItems;
        const printSpy = vi.spyOn(printModule, 'printKitchenOrder').mockImplementation(async (_io, payload) => {
            printedItems = payload.items;
            return 0;
        });

        try {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: created.body.order_id, expected_version: await currentTableRevision(created.body.order_id),
                    cart: forgedCart,
                    subtotal: 20.00, tax: 3.20, total: 23.20
                });

            expect(res.statusCode).toBe(200);
            expect(printedItems).toHaveLength(1);
            expect(printedItems[0].bundleItems.map(item => Number(item.product_id)).sort()).toEqual([
                SEED.product1.id,
                SEED.product2.id
            ]);
            const [children] = await pool.query(
                'SELECT product_id, quantity FROM order_items WHERE invoice_id = ? AND parent_item_id IS NOT NULL ORDER BY product_id',
                [created.body.order_id]
            );
            expect(children.map(child => ({ ...child, quantity: Number(child.quantity) }))).toEqual([
                expect.objectContaining({ product_id: SEED.product1.id, quantity: 2 }),
                expect.objectContaining({ product_id: SEED.product2.id, quantity: 2 })
            ]);
        } finally {
            printSpy.mockRestore();
        }
    });

    it('restores locked persisted children when a saved bundle omits bundleItems before kitchen printing', async () => {
        const created = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem()],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(created.statusCode).toBe(200);

        const recalled = await request(app)
            .get('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .query({ order_id: created.body.order_id });
        const strippedCart = recalled.body.cart;
        strippedCart[0].qty = 2;
        delete strippedCart[0].bundleItems;
        let printedItems;
        const printSpy = vi.spyOn(printModule, 'printKitchenOrder').mockImplementation(async (_io, payload) => {
            printedItems = payload.items;
            return 0;
        });

        try {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: created.body.order_id, expected_version: await currentTableRevision(created.body.order_id),
                    cart: strippedCart,
                    subtotal: 20.00, tax: 3.20, total: 23.20
                });

            expect(res.statusCode).toBe(200);
            expect(printedItems[0].bundleItems.map(item => Number(item.product_id)).sort()).toEqual([
                SEED.product1.id,
                SEED.product2.id
            ]);
        } finally {
            printSpy.mockRestore();
        }
    });

    // Re-grant the seed waiter (id=3) a precise permission set, then log in fresh so
    // the new grants load into the session. Mirrors tables.test.js grantWaiter.
    async function grantWaiterAndLogin(keys) {
        await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [SEED.waiterUser.id]);
        if (keys.length) {
            await pool.query(
                "INSERT INTO user_permissions (user_id, perm_key) VALUES ?",
                [keys.map(k => [SEED.waiterUser.id, k])]
            );
        }
        const res = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.waiterUser.user_number });
        return res.headers['set-cookie'][0];
    }

    it('P1-1: waiter without pos.void_printed_item can ADD a line to a bundle table', async () => {
        // Waiter owns the order (creates it), has edit rights + void_item, but NOT
        // void_printed_item. The buggy printed-lock loop counts the two bundle CHILD
        // rows (product 1 & 2) as reductions and throws; the fix iterates parents only.
        const waiterCookie = await grantWaiterAndLogin(['tables.access', 'waiter.edit_locked', 'pos.void_item']);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        const getRes = await request(app)
            .get('/api/pos/table_order')
            .query({ order_id: orderId })
            .set('Cookie', waiterCookie);
        expect(getRes.statusCode).toBe(200);
        const reconstructed = getRes.body.cart;

        // Re-save the reconstructed bundle PLUS one new standalone line (product 3,
        // which is NOT a bundle member, so it cannot accidentally match a child row).
        const resave = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId, expected_version: await currentTableRevision(orderId),
                cart: [
                    ...reconstructed,
                    { id: 3, product_id: 3, name: 'No Stock Item', qty: 1, price: 3.00 }
                ],
                subtotal: 13.00, tax: 1.60, total: 14.60
            });
        expect(resave.statusCode).toBe(200);

        // Bundle parent + 2 children + the new standalone = 4 rows.
        const [items] = await pool.query(
            "SELECT * FROM order_items WHERE invoice_id = ? ORDER BY sort_order", [orderId]
        );
        expect(items).toHaveLength(4);
        const parent = items.find(i => i.parent_item_id === null && i.product_id === SEED.bundleProduct.id);
        expect(parent).toBeDefined();
        expect(items.filter(i => i.parent_item_id !== null)).toHaveLength(2);
        expect(items.find(i => i.product_id === 3)).toBeDefined();
    });

    it('P1-1: waiter without pos.void_printed_item can re-save a bundle UNCHANGED', async () => {
        const waiterCookie = await grantWaiterAndLogin(['tables.access', 'waiter.edit_locked', 'pos.void_item']);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        const getRes = await request(app)
            .get('/api/pos/table_order')
            .query({ order_id: orderId })
            .set('Cookie', waiterCookie);
        const reconstructed = getRes.body.cart;

        const resave = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId, expected_version: await currentTableRevision(orderId),
                cart: reconstructed,
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(resave.statusCode).toBe(200);

        const [items] = await pool.query(
            "SELECT * FROM order_items WHERE invoice_id = ?", [orderId]
        );
        expect(items).toHaveLength(3); // parent + 2 children, unchanged
    });

    it('P1-1 negative regression: waiter without pos.void_printed_item IS BLOCKED when reducing a normal saved/printed non-bundle item', async () => {
        const waiterCookie = await grantWaiterAndLogin(['tables.access', 'waiter.edit_locked', 'pos.void_item']);

        // Create a table order with a normal item (product1, Burger)
        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 2, price: SEED.product1.price }],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        // Try to reduce the quantity of the normal item from 2 to 1 without pos.void_printed_item
        const resave = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId, expected_version: await currentTableRevision(orderId),
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        
        // Waiter lacks pos.void_printed_item permission, so the reduction of a saved printed item must block with 400/403/500 (since it throws Error)
        expect(resave.statusCode).not.toBe(200);
        expect(resave.statusCode).toBe(409);
        expect(resave.body.message || '').toContain('Remove action');
    });

    it('P1-2: bundle-member stock does NOT drift on unchanged re-save', async () => {
        // Enable stock; give the two members a known stock. The bundle product (id 4)
        // keeps NULL stock (bundles usually do), so ONLY the buggy child-restore can
        // touch member stock.
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query("UPDATE products SET stock=10 WHERE id IN (?, ?)", [SEED.product1.id, SEED.product2.id]);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        // Re-save the reconstructed bundle unchanged three times.
        for (let i = 0; i < 3; i++) {
            const getRes = await request(app)
                .get('/api/pos/table_order').query({ order_id: orderId }).set('Cookie', adminCookie);
            const resave = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: orderId, expected_version: await currentTableRevision(orderId),
                    cart: getRes.body.cart,
                    subtotal: 10.00, tax: 1.60, total: 11.60
                });
            expect(resave.statusCode).toBe(200);
        }

        const [[p1]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product1.id]);
        const [[p2]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product2.id]);
        expect(Number(p1.stock)).toBe(10); // members never deducted → must never be restored
        expect(Number(p2.stock)).toBe(10);
    });

    it('P1-2: table-save rejects an empty bundle cart without inflating member stock', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query("UPDATE products SET stock=10 WHERE id IN (?, ?)", [SEED.product1.id, SEED.product2.id]);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        // Empty-cart voiding belongs to the dedicated clear/refund route.
        const voidRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({ table_id: SEED.table.id, current_order_id: orderId, expected_version: await currentTableRevision(orderId), cart: [], subtotal: 0, tax: 0, total: 0 });
        expect(voidRes.statusCode).toBe(409);

        const [[p1]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product1.id]);
        const [[p2]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product2.id]);
        expect(Number(p1.stock)).toBe(10);
        expect(Number(p2.stock)).toBe(10);
    });

    it('P1-2: splitting a bundle table order does NOT inflate member stock', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query("UPDATE products SET stock=10 WHERE id IN (?, ?)", [SEED.product1.id, SEED.product2.id]);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        // Split the table order into one split seat (this voids the parent order)
        const splitRes = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id,
                currentOrderId: orderId,
                splits: [
                    { referenceName: 'Seat 1', subtotal: 11.60, items: [bundleCartItem({ qty: 1 })] }
                ]
            });
        expect(splitRes.statusCode).toBe(200);

        const [[p1]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product1.id]);
        const [[p2]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product2.id]);
        expect(Number(p1.stock)).toBe(10);
        expect(Number(p2.stock)).toBe(10);
    });

    it('replaces forged nested bundle split content with the locked parent child snapshot', async () => {
        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem()],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);

        const [[parent]] = await pool.query(
            'SELECT id FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL',
            [saveRes.body.order_id]
        );
        const splitRes = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id,
                currentOrderId: saveRes.body.order_id,
                splits: [{
                    referenceName: 'Forged split content',
                    subtotal: 11.60,
                    items: [bundleCartItem({
                        order_item_id: parent.id,
                        bundleItems: [{
                            product_id: 3,
                            name: 'Forged child must not persist',
                            note: 'forged note',
                            qty: 99,
                            removed: false
                        }]
                    })]
                }]
            });
        expect(splitRes.statusCode).toBe(200);

        const [[held]] = await pool.query(
            "SELECT cart_data FROM held_orders WHERE reference_name = 'Forged split content'"
        );
        const storedBundle = JSON.parse(held.cart_data).items[0];
        expect(storedBundle.bundle_snapshot_version).toBe(1);
        expect(storedBundle.bundleItems).toEqual([
            { product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, note: null, removed: false },
            { product_id: SEED.product2.id, name: SEED.product2.name, qty: 1, note: null, removed: false }
        ]);
        expect(JSON.stringify(storedBundle.bundleItems)).not.toContain('Forged child must not persist');
        expect(JSON.stringify(storedBundle.bundleItems)).not.toContain('forged note');
    });

    it('does not preserve a client-forged split bundle snapshot marker', async () => {
        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        expect(saveRes.statusCode).toBe(200);
        const [[parent]] = await pool.query(
            'SELECT id FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL',
            [saveRes.body.order_id]
        );

        const splitRes = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id,
                currentOrderId: saveRes.body.order_id,
                splits: [{
                    referenceName: 'Forged snapshot marker',
                    subtotal: 5.80,
                    items: [{
                        id: SEED.product1.id,
                        order_item_id: parent.id,
                        qty: 1,
                        price: SEED.product1.price,
                        bundle_snapshot_version: 1,
                        bundleItems: [{ product_id: 3, qty: 1, removed: false }]
                    }]
                }]
            });
        expect(splitRes.statusCode).toBe(200);

        const [[held]] = await pool.query(
            "SELECT cart_data FROM held_orders WHERE reference_name = 'Forged snapshot marker'"
        );
        expect(JSON.parse(held.cart_data).items[0].bundle_snapshot_version).toBeUndefined();
    });

    it('does not let a normal held order forge the persisted split-bundle bypass', async () => {
        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem()],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const invoiceId = saveRes.body.order_id;

        // A normal hold accepts object-shaped cart metadata. The marker is therefore
        // present in its persisted JSON, but it was not created by the table-split route.
        const holdRes = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', adminCookie)
            .send({
                reference_name: 'Forged historical split bypass',
                subtotal: 10.00,
                cart: {
                    parent_invoice_id: invoiceId,
                    is_split: true,
                    items: [bundleCartItem({ bundle_snapshot_version: 1 })]
                }
            });
        expect(holdRes.statusCode).toBe(200);

        const [[beforeTable]] = await pool.query(
            'SELECT status, current_order_id FROM restaurant_tables WHERE id = ?',
            [SEED.table.id]
        );
        const [[beforeOrders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        const [beforeStock] = await pool.query('SELECT id, stock FROM products ORDER BY id');
        const key = `forged-split-marker-${holdRes.body.id}`;
        const payRes = await settleSplitCheck({
            splitCheckId: holdRes.body.id,
            parentInvoiceId: invoiceId,
            shiftId: null,
            idempotencyKey: key
        });
        expect(payRes.statusCode).toBe(409);
        expect(payRes.body.code).toBeUndefined();

        const [[stillHeld]] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [holdRes.body.id]);
        const [[paid]] = await pool.query('SELECT COUNT(*) AS count FROM orders WHERE idempotency_key = ?', [key]);
        const [[afterTable]] = await pool.query(
            'SELECT status, current_order_id FROM restaurant_tables WHERE id = ?',
            [SEED.table.id]
        );
        const [[afterOrders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        const [afterStock] = await pool.query('SELECT id, stock FROM products ORDER BY id');
        expect(stillHeld).toBeDefined();
        expect(Number(paid.count)).toBe(0);
        expect(afterTable).toEqual(beforeTable);
        expect(Number(afterOrders.count)).toBe(Number(beforeOrders.count));
        expect(afterStock).toEqual(beforeStock);
    });

    it('rejects a fresh table bundle without bundleItems before order or kitchen writes', async () => {
        const [[beforeOrders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        const [[beforeItems]] = await pool.query('SELECT COUNT(*) AS count FROM order_items');
        const { bundleItems: _ignored, ...parentOnlyBundle } = bundleCartItem();

        const response = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [parentOnlyBundle],
                subtotal: 10.00,
                tax: 1.60,
                total: 11.60
            });

        expect(response.statusCode).toBe(400);
        expect(response.body.message).toBe('Invalid bundle contents.');
        const [[afterOrders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        const [[afterItems]] = await pool.query('SELECT COUNT(*) AS count FROM order_items');
        expect(Number(afterOrders.count)).toBe(Number(beforeOrders.count));
        expect(Number(afterItems.count)).toBe(Number(beforeItems.count));
    });

    it('rejects malformed persisted split items before deleting the held check', async () => {
        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        expect(saveRes.statusCode).toBe(200);
        const invoiceId = saveRes.body.order_id;
        const [heldRes] = await pool.query(
            'INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal) VALUES (?, ?, ?, ?)',
            [
                SEED.adminUser.id,
                'Malformed persisted split',
                JSON.stringify({
                    parent_invoice_id: invoiceId,
                    is_split: true,
                    items: [{ product_id: SEED.product1.id, qty: 1, price: 5, bundleItems: {} }]
                }),
                5
            ]
        );
        await pool.query(
            `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, new_value)
             VALUES ('split_check_created', ?, 'held_order', ?, ?)`,
            [
                SEED.adminUser.id,
                heldRes.insertId,
                JSON.stringify({ parent_invoice_id: invoiceId, bundle_snapshot_version: 1 })
            ]
        );

        const response = await settleSplitCheck({
            splitCheckId: heldRes.insertId,
            parentInvoiceId: invoiceId,
            shiftId: null,
            idempotencyKey: `malformed-split-${heldRes.insertId}`
        });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        const [[stillHeld]] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [heldRes.insertId]);
        expect(stillHeld.id).toBe(heldRes.insertId);
    });

    it('settles a marked split bundle from its persisted child snapshot after the catalog changes', async () => {
        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem()],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const invoiceId = saveRes.body.order_id;

        const [[parent]] = await pool.query(
            'SELECT id FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL',
            [invoiceId]
        );
        await pool.query(
            "UPDATE order_items SET item_name = 'Historic Burger', note = 'No onions', quantity = 2 WHERE invoice_id = ? AND parent_item_id = ? AND product_id = ?",
            [invoiceId, parent.id, SEED.product1.id]
        );
        await pool.query(
            "UPDATE order_items SET item_name = 'Historic Drink', note = 'Extra cold' WHERE invoice_id = ? AND parent_item_id = ? AND product_id = ?",
            [invoiceId, parent.id, SEED.product2.id]
        );

        const splitRes = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id,
                currentOrderId: invoiceId,
                splits: [{
                    referenceName: 'Historic bundle split',
                    subtotal: 11.60,
                    items: [bundleCartItem({ order_item_id: parent.id })]
                }]
            });
        expect(splitRes.statusCode).toBe(200);

        const [[held]] = await pool.query(
            "SELECT id, cart_data FROM held_orders WHERE reference_name = 'Historic bundle split'"
        );
        const [[provenance]] = await pool.query(
            `SELECT entity_type, entity_id, new_value
             FROM audit_events
             WHERE event_type = 'split_check_created' AND entity_id = ?
             ORDER BY id DESC
             LIMIT 1`,
            [held.id]
        );
        expect(provenance).toMatchObject({ entity_type: 'held_order', entity_id: held.id });
        expect(JSON.parse(provenance.new_value)).toEqual({
            parent_invoice_id: invoiceId,
            bundle_snapshot_version: 1
        });
        const heldBundle = JSON.parse(held.cart_data).items[0];
        expect(heldBundle.bundle_snapshot_version).toBe(1);
        expect(heldBundle.bundleItems).toEqual([
            { product_id: SEED.product1.id, name: 'Historic Burger', qty: 2, note: 'No onions', removed: false },
            { product_id: SEED.product2.id, name: 'Historic Drink', qty: 1, note: 'Extra cold', removed: false }
        ]);

        await pool.query('DELETE FROM product_bundle_items WHERE bundle_id = ?', [SEED.bundleProduct.id]);
        await pool.query(
            'INSERT INTO product_bundle_items (bundle_id, product_id, qty, sort_order) VALUES (?, ?, ?, ?)',
            [SEED.bundleProduct.id, 3, 1, 0]
        );
        await pool.query('UPDATE products SET is_bundle = 0 WHERE id = ?', [SEED.bundleProduct.id]);

        const shiftId = await openAdminShift();
        const key = `persisted-split-bundle-${held.id}`;
        const payRes = await settleSplitCheck({
            splitCheckId: held.id,
            parentInvoiceId: invoiceId,
            shiftId,
            idempotencyKey: key
        });
        expect(payRes.statusCode).toBe(200);

        const [[paid]] = await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key = ?', [key]);
        const [children] = await pool.query(
            `SELECT product_id, item_name, note, quantity
             FROM order_items
             WHERE invoice_id = ? AND parent_item_id IS NOT NULL
             ORDER BY sort_order, id`,
            [paid.invoice_id]
        );
        expect(children.map(child => ({
            product_id: Number(child.product_id),
            item_name: child.item_name,
            note: child.note,
            quantity: Number(child.quantity)
        }))).toEqual([
            { product_id: SEED.product1.id, item_name: 'Historic Burger', note: 'No onions', quantity: 2 },
            { product_id: SEED.product2.id, item_name: 'Historic Drink', note: 'Extra cold', quantity: 1 }
        ]);
    });

    it('rejects an unaudited legacy split instead of guessing its provenance', async () => {
        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem()],
                subtotal: 10.00, tax: 1.60, total: 11.60
        });
        expect(saveRes.statusCode).toBe(200);
        const invoiceId = saveRes.body.order_id;
        const [held] = await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
             VALUES (?, 'Legacy current-catalog split', 10.00, ?)`,
            [SEED.adminUser.id, JSON.stringify({
                parent_invoice_id: invoiceId,
                is_split: true,
                items: [bundleCartItem()]
            })]
        );

        const key = `legacy-current-bundle-${held.insertId}`;
        const payRes = await settleSplitCheck({
            splitCheckId: held.insertId,
            parentInvoiceId: invoiceId,
            shiftId: null,
            idempotencyKey: key
        });
        expect(payRes.statusCode).toBe(409);
        expect(payRes.body.code).toBeUndefined();
        const [[stillHeld]] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [held.insertId]);
        const [[paid]] = await pool.query('SELECT COUNT(*) AS count FROM orders WHERE idempotency_key = ?', [key]);
        expect(stillHeld.id).toBe(held.insertId);
        expect(Number(paid.count)).toBe(0);
    });

    it('P1-2: settling a bundle table does NOT inflate member stock (ghost-void restore)', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query("UPDATE products SET stock=10 WHERE id IN (?, ?)", [SEED.product1.id, SEED.product2.id]);

        // Admin opens a shift (checkout attributes the sale to a shift).
        const openRes = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', adminCookie)
            .send({ user_id: SEED.adminUser.id, starting_cash: 50.00 });
        expect(openRes.statusCode).toBe(200);
        const [[shift]] = await pool.query(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1", [SEED.adminUser.id]
        );

        // Save the bundle to the table.
        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);

        // Settle it (fresh paid order + ghost-void of the old table order).
        const payRes = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60,
                payment_method: 'cash', amount_tendered: 11.60, change_due: 0,
                shift_id: shift.id,
                idempotency_key: 'p1-2-settle-bundle-stock'
            });
        expect(payRes.body.success).toBe(true);

        const [[p1]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product1.id]);
        const [[p2]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product2.id]);
        expect(Number(p1.stock)).toBe(10); // members never deducted → never restored
        expect(Number(p2.stock)).toBe(10);
    });

    it('P3-1: table-save blocks saved custom-line removal regardless of void permission', async () => {
        // Waiter owns the order and can edit, but lacks pos.void_item.
        const waiterCookie = await grantWaiterAndLogin(['tables.access', 'waiter.edit_locked']);

        // Create a normal one-product table order the waiter owns.
        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        // Inject a saved custom line (product_id NULL) directly — the merge/split
        // paths produce these; direct custom-on-fresh-table is blocked.
        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, sort_order, parent_item_id)
             VALUES (?, NULL, 'Auto-Gratuity', 1, 2.00, 0, 0, 1, NULL)`,
            [orderId]
        );

        // Re-save a cart that OMITS the custom line (a reduction). The void gate must fire.
        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId, expected_version: await currentTableRevision(orderId),
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        expect(res.statusCode).toBe(409);
        expect(res.body.message || '').toContain('Remove action');

        // Rollback: the custom line is still present.
        const [[custom]] = await pool.query(
            "SELECT quantity, item_name FROM order_items WHERE invoice_id = ? AND product_id IS NULL", [orderId]
        );
        expect(custom).toBeDefined();
        expect(custom.item_name).toBe('Auto-Gratuity');
        expect(Number(custom.quantity)).toBe(1);
    });

    it('P3-1: void permission cannot bypass the table-save removal boundary', async () => {
        // Waiter with pos.void_item + pos.void_printed_item may remove it; the removal must be audited.
        const waiterCookie = await grantWaiterAndLogin(['tables.access', 'waiter.edit_locked', 'pos.void_item', 'pos.void_printed_item']);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        const orderId = saveRes.body.order_id;

        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, sort_order, parent_item_id)
             VALUES (?, NULL, 'Auto-Gratuity', 1, 2.00, 0, 0, 1, NULL)`,
            [orderId]
        );

        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId, expected_version: await currentTableRevision(orderId),
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        expect(res.statusCode).toBe(409);
        expect(res.body.message || '').toContain('Remove action');

        const [[auditRow]] = await pool.query(
            "SELECT old_value FROM audit_events WHERE event_type='void_item' AND entity_id = ? ORDER BY id DESC LIMIT 1",
            [orderId]
        );
        expect(auditRow).toBeUndefined();
        const [[custom]] = await pool.query(
            "SELECT item_name FROM order_items WHERE invoice_id=? AND product_id IS NULL",
            [orderId]
        );
        expect(custom.item_name).toBe('Auto-Gratuity');
    });

    it('P3-1: table-save cannot remove one custom line while another remains', async () => {
        const waiterCookie = await grantWaiterAndLogin(['tables.access', 'waiter.edit_locked', 'pos.void_item', 'pos.void_printed_item']);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        const orderId = saveRes.body.order_id;

        // Inject TWO distinct custom lines
        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, sort_order, parent_item_id)
             VALUES 
             (?, NULL, 'Auto-Gratuity', 1, 2.00, 0, 0, 1, NULL),
             (?, NULL, 'Service Charge', 1, 3.00, 0, 0, 2, NULL)`,
            [orderId, orderId]
        );

        // Re-save keeping only Service Charge, removing Auto-Gratuity.
        // The client-side cart will send the normal item + Service Charge.
        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId, expected_version: await currentTableRevision(orderId),
                cart: [
                    { id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price },
                    { id: 'custom-service', product_id: null, name: 'Service Charge', qty: 1, price: 3.00 }
                ],
                subtotal: 8.00, tax: 0.80, total: 8.80
            });
        expect(res.statusCode).toBe(409);
        expect(res.body.message || '').toContain('Remove action');

        // Verify that 'Auto-Gratuity' is audited as voided.
        const [audits] = await pool.query(
            "SELECT old_value FROM audit_events WHERE event_type='void_item' AND entity_id = ? ORDER BY id DESC",
            [orderId]
        );
        
        // Find the audit row that logs the custom void
        const customAudit = audits.find(a => a.old_value.includes('Auto-Gratuity'));
        expect(customAudit).toBeUndefined();
        const [customRows] = await pool.query(
            "SELECT item_name FROM order_items WHERE invoice_id=? AND product_id IS NULL ORDER BY item_name",
            [orderId]
        );
        expect(customRows.map(row => row.item_name)).toEqual(['Auto-Gratuity', 'Service Charge']);
    });

    it('P3-1: table-save removal boundary applies before printed-table permission gates', async () => {
        const waiterCookie = await grantWaiterAndLogin(['tables.access', 'waiter.edit_locked', 'pos.void_item']);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, sort_order, parent_item_id)
             VALUES
             (?, NULL, 'Auto-Gratuity', 1, 2.00, 0, 0, 1, NULL),
             (?, NULL, 'Service Charge', 1, 3.00, 0, 0, 2, NULL)`,
            [orderId, orderId]
        );

        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId, expected_version: await currentTableRevision(orderId),
                cart: [
                    { id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price },
                    { id: 'custom-service', product_id: null, name: 'Service Charge', qty: 1, price: 3.00 }
                ],
                subtotal: 8.00, tax: 0.80, total: 8.80
            });
        expect(res.statusCode).toBe(409);
        expect(res.body.message || '').toContain('Remove action');

        const [customRows] = await pool.query(
            "SELECT item_name, quantity FROM order_items WHERE invoice_id = ? AND product_id IS NULL ORDER BY item_name",
            [orderId]
        );
        expect(customRows.map(row => row.item_name)).toEqual(['Auto-Gratuity', 'Service Charge']);
        expect(customRows.every(row => Number(row.quantity) === 1)).toBe(true);
    });
});

