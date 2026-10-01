// integration/bundle.heldOrders.fire.test.js
// Task 10 (I3): held-order fire_kitchen must preserve bundleItems so
// expandBundlesForKitchen can route sub-items to their kitchen stations.
//
// Test strategy: inspect the durable print queue after the held-order route
// commits. The production route now owns routing/queueing, so mocking the
// legacy print helper would miss the real idempotency boundary.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const request = require('supertest');
const { app } = require('../../../server');
const { seedDatabase, SEED } = require('../fixtures/seed');
const pool = require('../../config/db');
const { BUNDLE_ORDER_CORRUPT, BUNDLE_ORDER_CORRUPT_MESSAGE } = require('../../services/bundleIntegrity');

describe('fire_kitchen — bundle data survives map to printKitchenOrder (I3)', () => {
    let cashierCookie;
    let kitchenPrinterIds = [];
    let unroutedProduct;

    beforeAll(async () => {
        await seedDatabase();
        await pool.query("INSERT INTO categories (id, name, is_active) VALUES (2, 'Unrouted Drinks', 1)");
        const [unrouted] = await pool.query(
            "INSERT INTO products (name, price, tax_rate, jofotara_tax_category, category_id, is_active) VALUES ('Unrouted Cola', 2.00, 0, 'O', 2, 1)"
        );
        unroutedProduct = { id: unrouted.insertId, name: 'Unrouted Cola', price: 2.00, tax_rate: 0, category_id: 2 };
        await pool.query("INSERT INTO categories (id, name) VALUES (5, 'Cat 5'), (6, 'Cat 6') ON DUPLICATE KEY UPDATE name=name");
        for (const [name, categoryId] of [['Bundle Seed Kitchen', SEED.category.id], ['Bundle Cat 5 Kitchen', 5], ['Bundle Cat 6 Kitchen', 6]]) {
            const [printer] = await pool.query(
                'INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES (?, \'kitchen\', \'windows\', ?, ?)',
                [name, name, `bundle-${categoryId}`]
            );
            kitchenPrinterIds.push(printer.insertId);
            await pool.query('INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)', [printer.insertId, categoryId]);
        }
        const c = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = c.headers['set-cookie'][0];
    });

    afterAll(async () => {
        if (kitchenPrinterIds.length) {
            await pool.query(`DELETE FROM printer_categories WHERE printer_id IN (${kitchenPrinterIds.map(() => '?').join(',')})`, kitchenPrinterIds);
            await pool.query(`DELETE FROM printers WHERE id IN (${kitchenPrinterIds.map(() => '?').join(',')})`, kitchenPrinterIds);
        }
    });

    async function fireHeld(id, operationId = `bundle-fire-${id}-${Date.now().toString(36)}`) {
        const [[row]] = await pool.query('SELECT version FROM held_orders WHERE id=?', [id]);
        return request(app)
            .post('/api/pos/held_orders/fire_kitchen')
            .set('Cookie', cashierCookie)
            .send({ id, operation_id: operationId, expected_version: Number(row?.version || 1) });
    }

    async function claimHeld(id, token = 'b'.repeat(64)) {
        const [[row]] = await pool.query('SELECT version FROM held_orders WHERE id=?', [id]);
        const response = await request(app)
            .post(`/api/pos/held_orders/${id}/claim`)
            .set('Cookie', cashierCookie)
            .send({ claim_token: token, expected_version: Number(row?.version || 1) });
        expect(response.statusCode).toBe(200);
        return response;
    }

    async function withoutCategoryRoute(categoryId, callback) {
        const [routes] = await pool.query(
            `SELECT printer_id FROM printer_categories
             WHERE category_id = ? AND printer_id IN (${kitchenPrinterIds.map(() => '?').join(',')})`,
            [categoryId, ...kitchenPrinterIds]
        );
        await pool.query(
            `DELETE FROM printer_categories WHERE category_id = ? AND printer_id IN (${kitchenPrinterIds.map(() => '?').join(',')})`,
            [categoryId, ...kitchenPrinterIds]
        );
        try {
            return await callback();
        } finally {
            for (const route of routes) {
                await pool.query(
                    'INSERT IGNORE INTO printer_categories (printer_id, category_id) VALUES (?, ?)',
                    [route.printer_id, categoryId]
                );
            }
        }
    }

    const scheduledCart = cart => ({ ...cart, delivery_date: '2099-01-01 12:00:00' });

    it('bundle cart item reaches printKitchenOrder with is_bundle + bundleItems intact', async () => {
        const [originalProducts] = await pool.query(
            'SELECT id, category_id FROM products WHERE id IN (?, ?)',
            [SEED.product1.id, SEED.product2.id]
        );
        await pool.query("INSERT INTO categories (id, name) VALUES (5, 'Cat 5'), (6, 'Cat 6') ON DUPLICATE KEY UPDATE name=name");
        await pool.query("UPDATE products SET category_id = 5 WHERE id = ?", [SEED.product1.id]);
        await pool.query("UPDATE products SET category_id = 6 WHERE id = ?", [SEED.product2.id]);

        // Build a held order whose cart contains one bundle item with two sub-items
        // using distinct category_ids so routing would split them if expanded.
        const bundleCart = {
            items: [
                {
                    id: SEED.bundleProduct.id,
                    product_id: SEED.bundleProduct.id,
                    name: SEED.bundleProduct.name,
                    qty: 1,
                    price: SEED.bundleProduct.price,
                    tax_rate: SEED.bundleProduct.tax_rate,
                    category_id: SEED.category.id,
                    is_bundle: true,
                    bundleItems: [
                        { product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, category_id: 5,  removed: false },
                        { product_id: SEED.product2.id, name: SEED.product2.name, qty: 1, category_id: 6, removed: false }
                    ]
                }
            ]
        };

        try {
            // 1. Save the held order
            const holdRes = await request(app)
                .post('/api/pos/held_orders')
                .set('Cookie', cashierCookie)
                .send({ reference_name: 'Bundle Fire Test I3', cart: scheduledCart(bundleCart), subtotal: SEED.bundleProduct.price });
            expect(holdRes.statusCode).toBe(200);
            const holdId = holdRes.body.id;
            expect(holdId).toBeGreaterThan(0);

            // 2. Fire to kitchen
            const fireRes = await fireHeld(holdId, `bundle-fire-${holdId}`);
            expect(fireRes.statusCode).toBe(200);
            expect(fireRes.body.kitchen_fired).toBe(true);

            // 3. The durable queue receives expanded bundle children with their
            // server-resolved category routing and stable line identity.
            const [queueRows] = await pool.query(
                'SELECT payload FROM print_queue WHERE idempotency_key LIKE ? ORDER BY id',
                [`kitchen:held-${holdId}-%`]
            );
            const queuedItems = queueRows.flatMap(row => JSON.parse(row.payload).data.items)
                .filter(item => item._isOther !== true);
            expect(queuedItems).toHaveLength(2);
            const subIds = queuedItems.map(s => s.product_id);
            expect(subIds).toContain(SEED.product1.id);
            expect(subIds).toContain(SEED.product2.id);
            const subCatIds = queuedItems.map(s => s.category_id);
            expect(subCatIds).toContain(5);
            expect(subCatIds).toContain(6);
        } finally {
            for (const product of originalProducts) {
                await pool.query('UPDATE products SET category_id = ? WHERE id = ?', [product.category_id, product.id]);
            }
            await pool.query('DELETE FROM categories WHERE id IN (5, 6)');
        }
    });

    it('blocks bundle corruption before kitchen_fired update or print dispatch', async () => {
        const [holdRes] = await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
             VALUES (?, 'Bundle Integrity Fire Corrupt', 5.00, ?)`,
            [SEED.cashierUser.id, JSON.stringify({
                items: [{
                    id: SEED.bundleProduct.id,
                    product_id: SEED.bundleProduct.id,
                    name: 'Broken Bundle',
                    qty: 0,
                    is_bundle: true,
                    bundleItems: [{ product_id: SEED.product1.id, name: 'Prod1', qty: 1, removed: false }]
                }]
            })]
        );

        const response = await request(app)
            .post('/api/pos/held_orders/fire_kitchen')
            .set('Cookie', cashierCookie)
            .send({ id: holdRes.insertId, operation_id: `corrupt-bundle-${holdRes.insertId}`, expected_version: 1 });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        const [[held]] = await pool.query('SELECT kitchen_fired FROM held_orders WHERE id = ?', [holdRes.insertId]);
        expect(held.kitchen_fired).toBe(0);
    });

    it('rejects a non-bundle held-save payload with nested children before persisting it', async () => {
        const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders');

        const response = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'Forged non-bundle hold',
                subtotal: SEED.product2.price,
                cart: {
                    items: [{
                        id: SEED.product2.id,
                        product_id: SEED.product2.id,
                        name: SEED.product2.name,
                        qty: 1,
                        price: SEED.product2.price,
                        bundleItems: [{
                            product_id: SEED.product1.id,
                            name: 'Injected kitchen child',
                            qty: 1,
                            category_id: 999,
                            removed: false
                        }]
                    }]
                }
            });

        expect(response.statusCode).toBe(400);
        const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders');
        expect(Number(after.count)).toBe(Number(before.count));
    });

    it('canonicalizes held bundle children from DB before storing and firing them', async () => {
        const [[originalMember]] = await pool.query(
            'SELECT qty FROM product_bundle_items WHERE bundle_id = ? AND product_id = ?',
            [SEED.bundleProduct.id, SEED.product1.id]
        );
        await pool.query(
            'UPDATE product_bundle_items SET qty = ? WHERE bundle_id = ? AND product_id = ?',
            [2.5, SEED.bundleProduct.id, SEED.product1.id]
        );

        try {
            const holdResponse = await request(app)
                .post('/api/pos/held_orders')
                .set('Cookie', cashierCookie)
                .send({
                    reference_name: 'Canonical bundle hold',
                    subtotal: SEED.bundleProduct.price * 2,
                    cart: scheduledCart({
                        items: [{
                            id: SEED.bundleProduct.id,
                            product_id: SEED.bundleProduct.id,
                            name: 'Forged bundle name',
                            qty: 2,
                            price: SEED.bundleProduct.price,
                            category_id: 999,
                            is_bundle: false,
                            bundleItems: [
                                {
                                    product_id: SEED.product1.id,
                                    name: 'Forged child name',
                                    qty: 99,
                                    category_id: 999,
                                    note: 'hold sauce',
                                    removed: false
                                },
                                {
                                    product_id: SEED.product2.id,
                                    name: 'Forged removed child',
                                    qty: 99,
                                    category_id: 999,
                                    removed: true
                                }
                            ]
                        }]
                    })
                });

            expect(holdResponse.statusCode).toBe(200);
            const [[held]] = await pool.query('SELECT cart_data FROM held_orders WHERE id = ?', [holdResponse.body.id]);
            const persistedBundle = JSON.parse(held.cart_data).items[0];
            expect(persistedBundle.is_bundle).toBe(true);
            expect(persistedBundle.bundleItems).toEqual([
                {
                    product_id: SEED.product1.id,
                    name: SEED.product1.name,
                    category_id: SEED.category.id,
                    qty: 2.5,
                    note: 'hold sauce',
                    removed: false
                },
                {
                    product_id: SEED.product2.id,
                    name: SEED.product2.name,
                    category_id: SEED.category.id,
                    qty: 1,
                    note: null,
                    removed: true
                }
            ]);

            const fireResponse = await fireHeld(holdResponse.body.id, `canonical-bundle-fire-${holdResponse.body.id}`);

            expect(fireResponse.statusCode).toBe(200);
            const [queueRows] = await pool.query(
                'SELECT payload FROM print_queue WHERE idempotency_key LIKE ? ORDER BY id',
                [`kitchen:held-${holdResponse.body.id}-%`]
            );
            const queuedItems = queueRows.flatMap(row => JSON.parse(row.payload).data.items);
            expect(queuedItems.map(item => ({
                product_id: item.product_id,
                name: item.name,
                category_id: item.category_id,
                qty: item.qty,
                removed: item.removed
            }))).toEqual(persistedBundle.bundleItems.filter(item => !item.removed).map(item => ({
                product_id: item.product_id,
                name: item.name,
                category_id: item.category_id,
                qty: item.qty * persistedBundle.qty,
                removed: item.removed
            })));
            expect(queuedItems.find(item => item.product_id === SEED.product1.id).note).toBe('hold sauce');
        } finally {
            await pool.query(
                'UPDATE product_bundle_items SET qty = ? WHERE bundle_id = ? AND product_id = ?',
                [originalMember.qty, SEED.bundleProduct.id, SEED.product1.id]
            );
        }
    });

    it('rejects a legacy non-bundle nested hold before kitchen state or printing changes', async () => {
        const [held] = await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
             VALUES (?, 'Legacy forged non-bundle hold', 2.00, ?)`,
            [SEED.cashierUser.id, JSON.stringify({
                items: [{
                    id: SEED.product2.id,
                    product_id: SEED.product2.id,
                    name: SEED.product2.name,
                    qty: 1,
                    price: SEED.product2.price,
                    bundleItems: [{
                        product_id: SEED.product1.id,
                        name: 'Injected kitchen child',
                        qty: 1,
                        removed: false
                    }]
                }]
            })]
        );

        const response = await request(app)
            .post('/api/pos/held_orders/fire_kitchen')
            .set('Cookie', cashierCookie)
            .send({ id: held.insertId, operation_id: `legacy-corrupt-${held.insertId}`, expected_version: 1 });

        expect(response.statusCode).toBe(400);
        const [[after]] = await pool.query('SELECT kitchen_fired FROM held_orders WHERE id = ?', [held.insertId]);
        expect(after.kitchen_fired).toBe(0);
    });

    it.each([
        ['malformed JSON', 'not-valid-json-{'],
        ['an object with non-array items', JSON.stringify({ items: { product_id: SEED.product1.id } })]
    ])('blocks legacy held fire for %s before kitchen state or printing changes', async (_label, cartData) => {
        const [held] = await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
             VALUES (?, 'Malformed held fire', 5.00, ?)`,
            [SEED.cashierUser.id, cartData]
        );

        const response = await request(app)
            .post('/api/pos/held_orders/fire_kitchen')
            .set('Cookie', cashierCookie)
            .send({ id: held.insertId, operation_id: `malformed-${held.insertId}`, expected_version: 1 });

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({
            code: BUNDLE_ORDER_CORRUPT,
            message: BUNDLE_ORDER_CORRUPT_MESSAGE
        });
        const [[after]] = await pool.query('SELECT kitchen_fired FROM held_orders WHERE id = ?', [held.insertId]);
        expect(after.kitchen_fired).toBe(0);
    });

    it('fires a valid legacy top-level cart array with normalized kitchen items', async () => {
        const [held] = await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
             VALUES (?, 'Legacy array held fire', 10.00, ?)`,
            [SEED.cashierUser.id, JSON.stringify([{
                id: SEED.product1.id,
                product_id: SEED.product1.id,
                name: SEED.product1.name,
                qty: 2,
                price: SEED.product1.price
            }])]
        );

        const response = await request(app)
            .post('/api/pos/held_orders/fire_kitchen')
            .set('Cookie', cashierCookie)
            .send({ id: held.insertId, operation_id: `legacy-array-${held.insertId}`, expected_version: 1 });

        expect(response.statusCode).toBe(200);
        expect(response.body.kitchen_fired).toBe(true);
        const [[after]] = await pool.query('SELECT kitchen_fired FROM held_orders WHERE id = ?', [held.insertId]);
        expect(after.kitchen_fired).toBe(1);
        const [queueRows] = await pool.query(
            'SELECT payload FROM print_queue WHERE idempotency_key LIKE ? ORDER BY id',
            [`kitchen:held-${held.insertId}-%`]
        );
        const queuedItems = queueRows.flatMap(row => JSON.parse(row.payload).data.items);
        expect(queuedItems).toMatchObject([{
            product_id: SEED.product1.id,
            name: SEED.product1.name,
            qty: 2,
            category_id: SEED.category.id
        }]);
    });

    it('rejects a held save with a null cart item before inserting a row', async () => {
        const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders');

        const response = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'Null held item',
                subtotal: 0,
                cart: [null]
            });

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({
            code: BUNDLE_ORDER_CORRUPT,
            message: BUNDLE_ORDER_CORRUPT_MESSAGE
        });
        const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders');
        expect(Number(after.count)).toBe(Number(before.count));
    });

    it.each([
        ['a null item', JSON.stringify([null])],
        ['an item with own non-array bundleItems', JSON.stringify([{ bundleItems: {} }])]
    ])('blocks legacy held fire for %s before kitchen state or printing changes', async (_label, cartData) => {
        const [held] = await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
             VALUES (?, 'Invalid held item fire', 5.00, ?)`,
            [SEED.cashierUser.id, cartData]
        );

        const response = await request(app)
            .post('/api/pos/held_orders/fire_kitchen')
            .set('Cookie', cashierCookie)
            .send({ id: held.insertId, operation_id: `invalid-item-${held.insertId}`, expected_version: 1 });

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({
            code: BUNDLE_ORDER_CORRUPT,
            message: BUNDLE_ORDER_CORRUPT_MESSAGE
        });
        const [[after]] = await pool.query('SELECT kitchen_fired FROM held_orders WHERE id = ?', [held.insertId]);
        expect(after.kitchen_fired).toBe(0);
    });

    it('keeps a held ticket retryable after an unrouted dispatch and retries with stable identity', async () => {
        const hold = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'Retryable kitchen hold',
                subtotal: SEED.product2.price,
                cart: scheduledCart({ items: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }] })
            });
        expect(hold.statusCode).toBe(200);

        const failed = await withoutCategoryRoute(SEED.category.id, () => fireHeld(hold.body.id, `unrouted-first-${hold.body.id}`));
        expect(failed.statusCode).toBe(422);
        const [[afterFailure]] = await pool.query('SELECT kitchen_fired FROM held_orders WHERE id=?', [hold.body.id]);
        expect(afterFailure.kitchen_fired).toBe(0);

        const retry = await fireHeld(hold.body.id, `unrouted-retry-${hold.body.id}`);

        expect(retry.statusCode).toBe(200);
        const [queueRows] = await pool.query(
            'SELECT idempotency_key FROM print_queue WHERE idempotency_key LIKE ? ORDER BY id',
            [`kitchen:held-${hold.body.id}-%`]
        );
        expect(queueRows.length).toBeGreaterThan(0);
        expect(queueRows.every(row => row.idempotency_key.includes(`held-${hold.body.id}`))).toBe(true);
    });

    it('saves a fired bundle without mistaking its parent row for new kitchen work', async () => {
        const cart = {
            items: [{
                id: SEED.bundleProduct.id,
                product_id: SEED.bundleProduct.id,
                name: SEED.bundleProduct.name,
                qty: 1,
                price: SEED.bundleProduct.price,
                tax_rate: SEED.bundleProduct.tax_rate,
                category_id: SEED.category.id,
                is_bundle: true,
                bundleItems: [
                    { product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, category_id: SEED.category.id, removed: false },
                ],
            }],
        };
        const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie)
            .send({ reference_name: 'Fired bundle save', cart: scheduledCart(cart), subtotal: SEED.bundleProduct.price });
        expect(held.statusCode).toBe(200);
        const fired = await fireHeld(held.body.id, `bundle-save-fire-${held.body.id}`);
        expect(fired.statusCode).toBe(200);
        const claimToken = 'c'.repeat(64);
        const claim = await request(app).post(`/api/pos/held_orders/${held.body.id}/claim`).set('Cookie', cashierCookie)
            .send({ claim_token: claimToken, expected_version: fired.body.version });
        expect(claim.statusCode).toBe(200);
        const saved = await request(app).patch(`/api/pos/held_orders/${held.body.id}`).set('Cookie', cashierCookie)
            .send({
                operation_id: `bundle-save-${held.body.id}`,
                claim_token: claimToken,
                expected_version: claim.body.claim.version,
                cart: JSON.parse(claim.body.order.cart_data),
                subtotal: SEED.bundleProduct.price,
            });
        expect(saved.statusCode).toBe(200);
    });

    it('keeps a held ticket retryable when no kitchen printer route matches', async () => {
        const hold = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'Unrouted kitchen hold',
                subtotal: SEED.product2.price,
                cart: scheduledCart({ items: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }] })
            });
        const response = await withoutCategoryRoute(SEED.category.id, () => fireHeld(hold.body.id, `unrouted-only-${hold.body.id}`));

        expect(response.statusCode).toBe(422);
        const [[row]] = await pool.query('SELECT kitchen_fired FROM held_orders WHERE id=?', [hold.body.id]);
        expect(row.kitchen_fired).toBe(0);
    });

    it('allows only one concurrent fire request to dispatch a held ticket', async () => {
        const hold = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'Concurrent kitchen hold',
                subtotal: SEED.product2.price,
                cart: scheduledCart({ items: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }] })
            });
        const responses = await Promise.all([
            fireHeld(hold.body.id, `concurrent-a-${hold.body.id}`),
            fireHeld(hold.body.id, `concurrent-b-${hold.body.id}`)
        ]);

        expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    });

    it('fires a mixed held order: routed items ticket, unrouted items are receipt-only', async () => {
        const hold = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'Mixed kitchen hold',
                subtotal: SEED.product1.price + unroutedProduct.price,
                cart: scheduledCart({
                    items: [
                        { id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: SEED.product1.tax_rate },
                        { id: unroutedProduct.id, qty: 1, price: unroutedProduct.price, tax_rate: unroutedProduct.tax_rate, category_id: 2 }
                    ]
                })
            });
        expect(hold.statusCode).toBe(200);

        const fire = await fireHeld(hold.body.id, `mixed-fire-${hold.body.id}`);
        expect(fire.statusCode).toBe(200);

        const [queueRows] = await pool.query(
            "SELECT payload FROM print_queue WHERE print_type='kitchen' AND idempotency_key LIKE ?",
            [`kitchen:held-${hold.body.id}-%`]
        );
        expect(queueRows).toHaveLength(1);
        const payload = JSON.parse(queueRows[0].payload);
        const ticketItems = payload.data.items.filter(item => item._isOther !== true);
        expect(ticketItems).toEqual([expect.objectContaining({ product_id: SEED.product1.id })]);
        expect(ticketItems.some(item => Number(item.product_id) === Number(unroutedProduct.id))).toBe(false);

        const [[row]] = await pool.query('SELECT kitchen_snapshot, cart_data FROM held_orders WHERE id=?', [hold.body.id]);
        const snapshot = JSON.parse(row.kitchen_snapshot);
        expect(snapshot.lines).toHaveLength(1);
        expect(snapshot.lines[0].item.product_id).toBe(SEED.product1.id);
        const cart = JSON.parse(row.cart_data);
        expect(cart.items).toHaveLength(2);
        expect(cart.items.map(item => Number(item.product_id || item.id)).sort()).toEqual(
            [SEED.product1.id, unroutedProduct.id].sort()
        );
    });

    it('follow-up with only unrouted additions reports no delta', async () => {
        const hold = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'Unrouted follow-up hold',
                subtotal: SEED.product1.price,
                cart: scheduledCart({ items: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: SEED.product1.tax_rate }] })
            });
        expect(hold.statusCode).toBe(200);
        const fired = await fireHeld(hold.body.id, `unrouted-follow-fire-${hold.body.id}`);
        expect(fired.statusCode).toBe(200);

        const token = 'd'.repeat(64);
        const claim = await claimHeld(hold.body.id, token);
        const cart = JSON.parse(claim.body.order.cart_data);
        cart.items.push({ id: unroutedProduct.id, qty: 1, price: unroutedProduct.price, tax_rate: unroutedProduct.tax_rate, category_id: 2 });

        const followUp = await request(app)
            .post(`/api/pos/held_orders/${hold.body.id}/follow-up`)
            .set('Cookie', cashierCookie)
            .send({
                operation_id: `unrouted-follow-${hold.body.id}`,
                claim_token: token,
                expected_version: claim.body.claim.version,
                cart
            });
        expect(followUp.statusCode).toBe(409);
        expect(followUp.body.code).toBe('HELD_KITCHEN_NO_DELTA');
    });

    it('firing an all-unrouted held order is an empty-preparation error', async () => {
        const hold = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'All-unrouted kitchen hold',
                subtotal: unroutedProduct.price,
                cart: scheduledCart({ items: [{ id: unroutedProduct.id, qty: 1, price: unroutedProduct.price, tax_rate: unroutedProduct.tax_rate, category_id: 2 }] })
            });
        expect(hold.statusCode).toBe(200);

        const fire = await fireHeld(hold.body.id, `all-unrouted-fire-${hold.body.id}`);
        expect(fire.statusCode).toBe(422);
        expect(fire.body.code).toBe('HELD_KITCHEN_ITEMS_EMPTY');
    });

    it('unmapping a routed category mid-order does not block follow-up or checkout', async () => {
        const hold = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'Mid-order unmap hold',
                subtotal: SEED.product1.price,
                cart: scheduledCart({ items: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: SEED.product1.tax_rate }] })
            });
        expect(hold.statusCode).toBe(200);
        const fired = await fireHeld(hold.body.id, `unmap-fire-${hold.body.id}`);
        expect(fired.statusCode).toBe(200);

        await withoutCategoryRoute(SEED.category.id, async () => {
            const editToken = 'e'.repeat(64);
            const claimed = await claimHeld(hold.body.id, editToken);
            const cart = JSON.parse(claimed.body.order.cart_data);
            cart.items.push({ id: SEED.product2.id, qty: 1, price: SEED.product2.price, tax_rate: SEED.product2.tax_rate });

            const saved = await request(app)
                .patch(`/api/pos/held_orders/${hold.body.id}`)
                .set('Cookie', cashierCookie)
                .send({
                    operation_id: `unmap-edit-${hold.body.id}`,
                    claim_token: editToken,
                    expected_version: claimed.body.claim.version,
                    cart,
                    subtotal: SEED.product1.price + SEED.product2.price
                });
            expect(saved.statusCode).toBe(200);

            const followToken = 'f'.repeat(64);
            const followClaim = await claimHeld(hold.body.id, followToken);
            const followUp = await request(app)
                .post(`/api/pos/held_orders/${hold.body.id}/follow-up`)
                .set('Cookie', cashierCookie)
                .send({
                    operation_id: `unmap-follow-${hold.body.id}`,
                    claim_token: followToken,
                    expected_version: followClaim.body.claim.version,
                    cart: JSON.parse(followClaim.body.order.cart_data)
                });
            expect(followUp.statusCode).toBe(409);
            expect(followUp.body.code).toBe('HELD_KITCHEN_NO_DELTA');
            expect(followUp.body.code).not.toBe('HELD_KITCHEN_SENT_LINE_CONFLICT');

            const shiftRes = await request(app)
                .post('/api/auth/shifts?action=open')
                .set('Cookie', cashierCookie)
                .send({ user_id: SEED.cashierUser.id, starting_cash: 0 });
            expect(shiftRes.statusCode).toBe(200);
            const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.cashierUser.id]);

            const checkout = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: JSON.parse(followClaim.body.order.cart_data).items,
                    held_order_context: {
                        id: hold.body.id,
                        claim_token: followClaim.body.claim.claimToken,
                        expected_version: followClaim.body.claim.version,
                        operation_id: `unmap-checkout-${hold.body.id}`
                    },
                    shift_id: shift.id,
                    subtotal: 7,
                    tax: 0.8,
                    total: 7.8,
                    payment_method: 'cash',
                    amount_tendered: 7.8,
                    change_due: 0,
                    idempotency_key: `unmap-checkout-${hold.body.id}`
                });
            expect(checkout.statusCode).toBe(200);
        });
    });
});
