import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Held Orders — race-safe atomic claim', () => {
    let cashierCookie;   // SEED.cashierUser (id 2) — has pos.hold_orders
    let waiterCookie;    // SEED.waiterUser  (id 3) — has pos.hold_orders, different user
    let adminCookie;
    let kitchenPrinterId;
    let callCenterCookie;
    let secondCallCenterCookie;

    beforeAll(async () => {
        await seedDatabase();
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Held Test Kitchen', 'kitchen', 'windows', 'Held Test Kitchen', 'held-test')"
        );
        kitchenPrinterId = printer.insertId;
        await pool.query('INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)', [kitchenPrinterId, SEED.category.id]);
        const c = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = c.headers['set-cookie'][0];
        const w = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
        waiterCookie = w.headers['set-cookie'][0];
        const a = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = a.headers['set-cookie'][0];
        await pool.query(`
            INSERT INTO users (id, user_number, name, role, is_active, xyz)
            VALUES (70, '9070', 'Phone Desk One', 'call_center', 1, 0),
                   (71, '9071', 'Phone Desk Two', 'call_center', 1, 0)
        `);
        const cc = await request(app).post('/api/auth/login').send({ user_number: '9070' });
        callCenterCookie = cc.headers['set-cookie'][0];
        const cc2 = await request(app).post('/api/auth/login').send({ user_number: '9071' });
        secondCallCenterCookie = cc2.headers['set-cookie'][0];
    });

    afterAll(async () => {
        if (!kitchenPrinterId) return;
        await pool.query('DELETE FROM printer_categories WHERE printer_id=?', [kitchenPrinterId]);
        await pool.query('DELETE FROM printers WHERE id=?', [kitchenPrinterId]);
    });

    async function createPhoneHold(cookie = callCenterCookie, overrides = {}) {
        return request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cookie)
            .send({
                hold_request_id: `phone-${crypto.randomUUID()}`,
                subtotal: 5,
                cart: {
                    customer_name: 'Phone Customer',
                    customer_phone: '079-123-4567',
                    customer_address: 'Amman',
                    delivery_date: '2099-01-01T12:00',
                    order_type_id: 1,
                    items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                },
                ...overrides
            });
    }

    it('creates an idempotent phone hold with canonical identity and server-owned source', async () => {
        const holdRequestId = `phone-${crypto.randomUUID()}`;
        const payload = {
            hold_request_id: holdRequestId,
            reference_name: 'forged customer reference',
            subtotal: 5,
            call_center_user_id: 71,
            cart: {
                customer_name: ' Phone Customer ',
                customer_phone: '079-123 4567',
                customer_address: ' Amman ',
                order_type_id: 1,
                items: [{ id: SEED.product1.id, qty: 1, price: 999, tax_rate: 0 }]
            }
        };
        const created = await request(app).post('/api/pos/held_orders').set('Cookie', callCenterCookie).send(payload);
        expect(created.statusCode).toBe(200);
        expect(created.body.reference_name).toBe(`Phone #${created.body.id}`);

        const replay = await request(app).post('/api/pos/held_orders').set('Cookie', callCenterCookie).send(payload);
        expect(replay.statusCode).toBe(200);
        expect(replay.body).toMatchObject({ id: created.body.id, replay: true });
        const createdEvents = global.__mockEmit__.mock.calls.filter(([event]) => event === 'held_orders_changed');
        expect(createdEvents).toEqual([[
            'held_orders_changed',
            { action: 'created', source: 'call_center', held_order_id: created.body.id, table_id: null, parent_invoice_id: null }
        ]]);

        const [[row]] = await pool.query(
            'SELECT user_id, call_center_user_id, reference_name, cart_data FROM held_orders WHERE id=?',
            [created.body.id]
        );
        const cart = JSON.parse(row.cart_data);
        expect(row).toMatchObject({ user_id: 70, call_center_user_id: 70, reference_name: `Phone #${created.body.id}` });
        expect(cart).toMatchObject({ customer_name: 'Phone Customer', customer_phone: '0791234567', customer_address: 'Amman' });
        expect(Number(cart.items[0].price)).toBe(Number(SEED.product1.price));
        const [[createdAudit]] = await pool.query(
            "SELECT new_value FROM audit_events WHERE event_type='held_order_created' AND entity_id=? ORDER BY id DESC LIMIT 1",
            [created.body.id]
        );
        expect(JSON.parse(createdAudit.new_value)).toMatchObject({ call_center_user_id: 70 });

        const ordinary = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
            call_center_user_id: 70,
            reference_name: 'ordinary forged source', subtotal: 5,
            cart: { call_center_user_id: 70, items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }] }
        });
        expect(ordinary.statusCode).toBe(200);
        const [[ordinaryRow]] = await pool.query('SELECT call_center_user_id, cart_data FROM held_orders WHERE id=?', [ordinary.body.id]);
        expect(ordinaryRow.call_center_user_id).toBeNull();
        expect(JSON.parse(ordinaryRow.cart_data)).not.toHaveProperty('call_center_user_id');
    });

    it('preserves a scale-derived fractional line through held-order storage and listing', async () => {
        const [inserted] = await pool.query(`
            INSERT INTO products (category_id, barcode, name, price, tax_rate, is_active, is_available, stock, is_bundle)
            VALUES (NULL, '100000', 'Scale beef', 11.000000, 0, 1, 1, 10.000000, 0)
        `);
        let heldId = null;

        try {
            const created = await request(app)
                .post('/api/pos/held_orders')
                .set('Cookie', cashierCookie)
                .send({
                    reference_name: 'Scale customer',
                    subtotal: 40.59,
                    cart: {
                        items: [{ id: inserted.insertId, qty: 3.69, price: 11, tax_rate: 0 }]
                    }
                });
            expect(created.statusCode).toBe(200);
            heldId = created.body.id;

            const [[stored]] = await pool.query('SELECT subtotal, cart_data FROM held_orders WHERE id=?', [heldId]);
            const storedCart = JSON.parse(stored.cart_data);
            expect(Number(stored.subtotal)).toBe(40.59);
            expect(storedCart.items[0]).toMatchObject({ id: inserted.insertId, qty: 3.69, price: 11 });

            const listed = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
            const restored = listed.body.data.find(order => Number(order.id) === Number(heldId));
            expect(restored).toBeDefined();
            expect(JSON.parse(restored.cart_data).items[0]).toMatchObject({ id: inserted.insertId, qty: 3.69, price: 11 });
        } finally {
            if (heldId) await pool.query('DELETE FROM held_orders WHERE id=?', [heldId]);
            await pool.query('DELETE FROM products WHERE id=?', [inserted.insertId]);
        }
    });

    it('rejects missing identity, unsafe order types, and financial authority before insert', async () => {
        const missing = await createPhoneHold(callCenterCookie, {
            cart: { customer_phone: '0791234567', customer_address: 'Amman', order_type_id: 1, items: [{ id: 1, qty: 1 }] }
        });
        expect(missing.statusCode).toBe(400);

        const longName = await createPhoneHold(callCenterCookie, {
            cart: { customer_name: 'N'.repeat(101), customer_phone: '0791234567', customer_address: 'Amman', order_type_id: 1, items: [{ id: 1, qty: 1 }] }
        });
        expect(longName.statusCode).toBe(400);

        const invalidSchedule = await createPhoneHold(callCenterCookie, {
            cart: { customer_name: 'Phone Customer', customer_phone: '0791234567', customer_address: 'Amman', delivery_date: '2026-02-30T12:00', order_type_id: 1, items: [{ id: 1, qty: 1 }] }
        });
        expect(invalidSchedule.statusCode).toBe(400);
        expect(invalidSchedule.body.code).toBe('CALL_CENTER_DELIVERY_DATE_INVALID');

        await pool.query("UPDATE order_types SET is_deferred_settlement=1 WHERE id=1");
        const deferred = await createPhoneHold();
        expect(deferred.statusCode).toBe(409);
        await pool.query("UPDATE order_types SET is_deferred_settlement=0 WHERE id=1");

        for (const overrides of [
            { payment_method: 'cash' },
            { tax_exempt: true },
            { service_charge_snapshot: { id: 'forged' } },
            { cart: { customer_name: 'Phone Customer', customer_phone: '0791234567', customer_address: 'Amman', order_type_id: 1, order_discount: { type: 'percent', value: 10 }, items: [{ id: 1, qty: 1 }] } },
            { cart: { customer_name: 'Phone Customer', customer_phone: '0791234567', customer_address: 'Amman', order_type_id: 1, items: [{ id: null, note: 'Auto-Gratuity', qty: 1, price: 1 }] } }
        ]) {
            const rejected = await createPhoneHold(callCenterCookie, overrides);
            expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
        }

        await pool.query("UPDATE users SET role='cashier' WHERE id=70");
        const staleRole = await createPhoneHold();
        expect(staleRole.statusCode).toBe(403);
        expect(staleRole.body.code).toBe('CALL_CENTER_SESSION_CHANGED');
        await pool.query("UPDATE users SET role='call_center' WHERE id=70");
    });

    it('searches exact normalized phone metadata and requires that phone before revealing cart', async () => {
        const created = await createPhoneHold(callCenterCookie, {
            cart: {
                customer_name: 'Phone Customer',
                customer_phone: '0791234567',
                customer_address: 'Amman',
                delivery_date: '2026-08-11T14:30',
                order_type_id: 1,
                items: [
                    { id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 },
                    { id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }
                ]
            }
        });
        expect(created.statusCode).toBe(200);

        const matches = await request(app)
            .post('/api/pos/held_orders/phone-matches')
            .set('Cookie', secondCallCenterCookie)
            .send({ phone: '079 123 4567' });
        expect(matches.statusCode).toBe(200);
        expect(matches.headers['cache-control']).toContain('no-store');
        expect(matches.body.data).toContainEqual(expect.objectContaining({
            id: created.body.id,
            customer_name: 'Phone Customer',
            delivery_date: '2026-08-11 14:30:00',
            item_count: 2,
            kitchen_dispatch_version: 0
        }));
        expect(matches.body.data.length).toBeLessThanOrEqual(10);
        expect(JSON.stringify(matches.body.data)).not.toContain('cart_data');
        expect(JSON.stringify(matches.body.data)).not.toContain('claim_token_hash');
        expect(JSON.stringify(matches.body.data)).not.toContain('customer_address');

        const wrong = await request(app)
            .post(`/api/pos/held_orders/${created.body.id}/claim`)
            .set('Cookie', secondCallCenterCookie)
            .send({ claim_token: 'a'.repeat(64), expected_version: 1, phone: '0799999999' });
        expect(wrong.statusCode).toBe(404);

        const good = await request(app)
            .post(`/api/pos/held_orders/${created.body.id}/claim`)
            .set('Cookie', secondCallCenterCookie)
            .send({ claim_token: 'b'.repeat(64), expected_version: 1, phone: '079-123-4567' });
        expect(good.statusCode).toBe(200);
        expect(good.body.order.call_center_user_id).toBe(70);
        expect(JSON.parse(good.body.order.cart_data).customer_phone).toBe('0791234567');

        const activeWrongPhone = await request(app)
            .post(`/api/pos/held_orders/${created.body.id}/claim`)
            .set('Cookie', callCenterCookie)
            .send({ claim_token: '9'.repeat(64), expected_version: good.body.claim.version, phone: '0798888888' });
        expect(activeWrongPhone.statusCode).toBe(404);
        expect(activeWrongPhone.body.code).toBe('CALL_CENTER_HELD_ORDER_NOT_FOUND');

        const noPhone = await request(app)
            .post(`/api/pos/held_orders/${created.body.id}/claim`)
            .set('Cookie', callCenterCookie)
            .send({ claim_token: 'c'.repeat(64), expected_version: good.body.claim.version });
        expect(noPhone.statusCode).toBe(404);
        expect(noPhone.body.code).toBe('CALL_CENTER_HELD_ORDER_NOT_FOUND');
        expect(JSON.stringify(noPhone.body)).not.toContain('cart_data');
    });

    it('keeps general held-order and initial-kitchen actions closed to call center', async () => {
        const list = await request(app).get('/api/pos/held_orders').set('Cookie', callCenterCookie);
        expect(list.statusCode).toBe(403);
        const summary = await request(app).get('/api/pos/held_orders/summary').set('Cookie', callCenterCookie);
        expect(summary.statusCode).toBe(403);
        const fire = await request(app).post('/api/pos/held_orders/fire_kitchen').set('Cookie', callCenterCookie).send({ id: 1 });
        expect(fire.statusCode).toBe(403);
    });

    it('projects phone source separately in active/history views and exposes a count-only cashier summary', async () => {
        const created = await createPhoneHold();

        const active = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
        expect(active.statusCode).toBe(200);
        expect(active.body.data).toContainEqual(expect.objectContaining({
            id: created.body.id,
            call_center_user_id: 70,
            call_center_user_name: 'Phone Desk One',
            cashier_name: 'Phone Desk One',
        }));

        const summary = await request(app).get('/api/pos/held_orders/summary').set('Cookie', cashierCookie);
        expect(summary.statusCode).toBe(200);
        expect(Object.keys(summary.body).sort()).toEqual(['active_register_count', 'success']);
        expect(summary.body.active_register_count).toBeGreaterThanOrEqual(1);

        const [orderResult] = await pool.query(
            `INSERT INTO orders
             (user_id, call_center_user_id, order_type_id, subtotal, tax, total, payment_method)
             VALUES (?, 70, 1, 5, 0, 5, 'cash')`,
            [SEED.cashierUser.id]
        );
        await pool.query(
            `INSERT INTO order_items
             (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, jofotara_tax_category)
             VALUES (?, ?, 'Phone item', 1, 5, 0, 'O')`,
            [orderResult.insertId, SEED.product1.id]
        );
        const history = await request(app).get('/api/pos/order_notes').set('Cookie', adminCookie);
        expect(history.statusCode).toBe(200);
        expect(history.body.orders).toContainEqual(expect.objectContaining({
            invoice_id: orderResult.insertId,
            call_center_user_id: 70,
            call_center_user_name: 'Phone Desk One',
            cashier_name: SEED.cashierUser.name,
        }));
    });

    it('rejects a stale call-center session before it can claim a phone order', async () => {
        const created = await createPhoneHold();
        await pool.query("UPDATE users SET role='cashier' WHERE id=71");
        try {
            const claim = await request(app)
                .post(`/api/pos/held_orders/${created.body.id}/claim`)
                .set('Cookie', secondCallCenterCookie)
            .send({ claim_token: '8'.repeat(64), expected_version: 1, phone: '0791234567' });
            expect(claim.statusCode).toBe(403);
            expect(claim.body.code).toBe('CALL_CENTER_SESSION_CHANGED');
        } finally {
            await pool.query("UPDATE users SET role='call_center' WHERE id=71");
        }
    });

    it('lets another phone worker continue the same row and audits the acting worker, not the source', async () => {
        const created = await createPhoneHold();
        const token = 'c'.repeat(64);
        const claimed = await request(app)
            .post(`/api/pos/held_orders/${created.body.id}/claim`)
            .set('Cookie', secondCallCenterCookie)
            .send({ claim_token: token, expected_version: 1, phone: '0791234567' });
        expect(claimed.statusCode).toBe(200);
        const cart = JSON.parse(claimed.body.order.cart_data);
        cart.customer_address = 'Zarqa';
        cart.items.push({ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0, discountType: null, discountValue: 0 });
        const operationId = `phone-save-${crypto.randomUUID()}`;
        const saved = await request(app)
            .patch(`/api/pos/held_orders/${created.body.id}`)
            .set('Cookie', secondCallCenterCookie)
            .send({ operation_id: operationId, expected_version: claimed.body.claim.version, claim_token: token, cart });
        expect(saved.statusCode).toBe(200);

        const replay = await request(app)
            .patch(`/api/pos/held_orders/${created.body.id}`)
            .set('Cookie', secondCallCenterCookie)
            .send({ operation_id: operationId, expected_version: claimed.body.claim.version, claim_token: token, cart });
        expect(replay.statusCode).toBe(200);
        expect(replay.body.replay).toBe(true);

        const [[row]] = await pool.query('SELECT call_center_user_id, cart_data FROM held_orders WHERE id=?', [created.body.id]);
        expect(Number(row.call_center_user_id)).toBe(70);
        expect(JSON.parse(row.cart_data).customer_address).toBe('Zarqa');
        expect(JSON.parse(row.cart_data).items).toHaveLength(2);
        const [[audit]] = await pool.query(
            "SELECT user_id, new_value FROM audit_events WHERE event_type='held_order_updated' AND entity_id=? ORDER BY id DESC LIMIT 1",
            [created.body.id]
        );
        expect(Number(audit.user_id)).toBe(71);
        expect(JSON.parse(audit.new_value)).toMatchObject({ call_center_user_id: 70 });
    });

    it('preserves cashier-authored line authority when held lines are reordered', async () => {
        const created = await createPhoneHold(callCenterCookie, {
            cart: {
                customer_name: 'Phone Customer',
                customer_phone: '0791234567',
                customer_address: 'Amman',
                delivery_date: '2099-01-01T12:00',
                order_type_id: 1,
                items: [
                    { id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 },
                    { id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }
                ]
            }
        });
        const [[stored]] = await pool.query('SELECT cart_data FROM held_orders WHERE id=?', [created.body.id]);
        const storedCart = JSON.parse(stored.cart_data);
        storedCart.items[0].held_line_id = `held-${created.body.id}-1`;
        storedCart.items[0].discountType = 'fixed';
        storedCart.items[0].discountValue = 0.25;
        storedCart.items[1].held_line_id = `held-${created.body.id}-2`;
        await pool.query('UPDATE held_orders SET cart_data=? WHERE id=?', [JSON.stringify(storedCart), created.body.id]);

        const token = '7'.repeat(64);
        const claimed = await request(app)
            .post(`/api/pos/held_orders/${created.body.id}/claim`)
            .set('Cookie', secondCallCenterCookie)
            .send({ claim_token: token, expected_version: 1, phone: '0791234567' });
        expect(claimed.statusCode).toBe(200);
        const reordered = JSON.parse(claimed.body.order.cart_data);
        reordered.items.reverse();

        const saved = await request(app)
            .patch(`/api/pos/held_orders/${created.body.id}`)
            .set('Cookie', secondCallCenterCookie)
            .send({
                operation_id: `phone-reorder-${crypto.randomUUID()}`,
                expected_version: claimed.body.claim.version,
                claim_token: token,
                cart: reordered
            });
        expect(saved.statusCode).toBe(200);
        const [[updated]] = await pool.query('SELECT cart_data FROM held_orders WHERE id=?', [created.body.id]);
        const discounted = JSON.parse(updated.cart_data).items.find(item => item.held_line_id === `held-${created.body.id}-1`);
        expect(discounted).toMatchObject({ discountType: 'fixed', discountValue: 0.25 });
    });

    it('allows another phone worker to cancel an unfired phone order and honors xyz audit suppression', async () => {
        for (const [suffix, xyz, expectAudit] of [['normal', 0, true], ['suppressed', 1, false]]) {
            await pool.query('UPDATE users SET xyz=? WHERE id=71', [xyz]);
            const created = await createPhoneHold();
            const token = suffix === 'normal' ? 'd'.repeat(64) : 'e'.repeat(64);
            const claimed = await request(app)
                .post(`/api/pos/held_orders/${created.body.id}/claim`)
                .set('Cookie', secondCallCenterCookie)
                .send({ claim_token: token, expected_version: 1, phone: '0791234567' });
            const canceled = await request(app)
                .delete(`/api/pos/held_orders/${created.body.id}`)
                .set('Cookie', secondCallCenterCookie)
                .send({
                    operation_id: `phone-cancel-${suffix}-${crypto.randomUUID()}`,
                    expected_version: claimed.body.claim.version,
                    claim_token: token,
                    confirmed: true,
                    reason_code: 'customer_changed_mind'
                });
            expect(canceled.statusCode).toBe(200);
            expect(canceled.body.cancellation_ticket_count).toBe(0);
            const [[remaining]] = await pool.query('SELECT COUNT(*) count FROM held_orders WHERE id=?', [created.body.id]);
            expect(Number(remaining.count)).toBe(0);
            const [[auditCount]] = await pool.query(
                "SELECT COUNT(*) count FROM audit_events WHERE event_type='held_order_canceled' AND entity_id=?",
                [created.body.id]
            );
            expect(Number(auditCount.count) > 0).toBe(expectAudit);
        }
        await pool.query('UPDATE users SET xyz=0 WHERE id=71');
    });

    it('requires explicit FOLLOW UP for added fired work and lets another phone worker cancel with a trusted ticket', async () => {
        const created = await createPhoneHold();
        const fired = await fireHeld(cashierCookie, created.body.id, `phone-fire-${crypto.randomUUID()}`);
        expect(fired.statusCode).toBe(200);

        const token = 'f'.repeat(64);
        const claimed = await request(app)
            .post(`/api/pos/held_orders/${created.body.id}/claim`)
            .set('Cookie', secondCallCenterCookie)
            .send({ claim_token: token, expected_version: fired.body.version, phone: '0791234567' });
        expect(claimed.statusCode).toBe(200);
        const cart = JSON.parse(claimed.body.order.cart_data);
        cart.items[0].qty = 2;

        const plainSave = await request(app)
            .patch(`/api/pos/held_orders/${created.body.id}`)
            .set('Cookie', secondCallCenterCookie)
            .send({ operation_id: `phone-plain-${crypto.randomUUID()}`, expected_version: claimed.body.claim.version, claim_token: token, cart });
        expect(plainSave.statusCode).toBe(409);
        expect(plainSave.body.code).toBe('HELD_KITCHEN_FOLLOW_UP_REQUIRED');

        const followUp = await request(app)
            .post(`/api/pos/held_orders/${created.body.id}/follow-up`)
            .set('Cookie', secondCallCenterCookie)
            .send({ operation_id: `phone-follow-${crypto.randomUUID()}`, expected_version: claimed.body.claim.version, claim_token: token, cart });
        expect(followUp.statusCode).toBe(200);
        expect(followUp.body.deltaCount).toBe(1);

        const token2 = '1'.repeat(64);
        const [[afterFollowUp]] = await pool.query('SELECT version FROM held_orders WHERE id=?', [created.body.id]);
        const reclaimed = await request(app)
            .post(`/api/pos/held_orders/${created.body.id}/claim`)
            .set('Cookie', secondCallCenterCookie)
            .send({ claim_token: token2, expected_version: Number(afterFollowUp.version), phone: '0791234567' });
        const canceled = await request(app)
            .delete(`/api/pos/held_orders/${created.body.id}`)
            .set('Cookie', secondCallCenterCookie)
            .send({
                operation_id: `phone-fired-cancel-${crypto.randomUUID()}`,
                expected_version: reclaimed.body.claim.version,
                claim_token: token2,
                confirmed: true,
                reason_code: 'customer_changed_mind'
            });
        expect(canceled.statusCode).toBe(200);
        expect(canceled.body.cancellation_ticket_count).toBeGreaterThan(0);
        const [[cancelJob]] = await pool.query("SELECT payload FROM print_queue WHERE JSON_EXTRACT(payload, '$.data.cancel_ticket')=true ORDER BY id DESC LIMIT 1");
        expect(JSON.parse(cancelJob.payload).data.items[0].qty).toBe(2);
    });

    it('fails the 21st new phone order without adding another row', async () => {
        await pool.query('DELETE FROM held_orders WHERE call_center_user_id=70');
        const cart = JSON.stringify({
            customer_name: 'Queue Customer', customer_phone: '0795555555', customer_address: 'Amman',
            order_type_id: 1, items: [{ id: 1, qty: 1, price: 5, tax_rate: 16 }]
        });
        for (let index = 0; index < 20; index += 1) {
            await pool.query(
                `INSERT INTO held_orders (user_id, call_center_user_id, reference_name, cart_data, subtotal)
                 VALUES (70, 70, ?, ?, 5)`,
                [`Phone queue ${index}`, cart]
            );
        }
        const rejected = await createPhoneHold();
        expect(rejected.statusCode).toBe(409);
        expect(rejected.body.code).toBe('CALL_CENTER_HOLD_LIMIT_REACHED');
        const [[count]] = await pool.query('SELECT COUNT(*) count FROM held_orders WHERE call_center_user_id=70');
        expect(Number(count.count)).toBe(20);
        await pool.query('DELETE FROM held_orders WHERE call_center_user_id=70');
    });

    async function createHold(cookie, reference_name = '') {
        const res = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cookie)
            .send({
                reference_name,
                cart: {
                    delivery_date: '2099-01-01 12:00:00',
                    items: [{ id: SEED.product1.id, qty: 1, price: 5.0, tax_rate: 16 }]
                },
                subtotal: 5.0
            });
        return res.body; // { success, id, reference_name }
    }

    async function claimHeld(cookie, id, token = 'a'.repeat(64)) {
        const [[row]] = await pool.query('SELECT version FROM held_orders WHERE id=?', [id]);
        return request(app)
            .post(`/api/pos/held_orders/${id}/claim`)
            .set('Cookie', cookie)
            .send({ claim_token: token, expected_version: Number(row?.version || 1) });
    }

    async function fireHeld(cookie, id, operationId = `11111111-1111-4111-8111-${String(id).padStart(12, '0')}`) {
        const [[row]] = await pool.query('SELECT version FROM held_orders WHERE id=?', [id]);
        return request(app)
            .post('/api/pos/held_orders/fire_kitchen')
            .set('Cookie', cookie)
            .send({ id, operation_id: operationId, expected_version: Number(row?.version || 1) });
    }

    async function createTableSplitHold() {
        const [parent] = await pool.query(
            `INSERT INTO orders
             (user_id, table_id, order_type_id, subtotal, tax, total, payment_method)
             VALUES (?, ?, 1, 5.00, 0.80, 5.80, 'unpaid_table')`,
            [SEED.waiterUser.id, SEED.table.id]
        );
        const cartData = JSON.stringify({
            parent_invoice_id: parent.insertId,
            parent_order_id: parent.insertId,
            items: [{ id: SEED.product1.id, qty: 1, price: 5.0, tax_rate: 16 }]
        });
        const [result] = await pool.query(
            `INSERT INTO held_orders
             (user_id, reference_name, cart_data, subtotal, parent_invoice_id, table_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [SEED.waiterUser.id, 'Table 12 - Seat 1', cartData, 5.0, parent.insertId, SEED.table.id]
        );
        return result.insertId;
    }

    it('requires a boolean and permission before creating a tax-exempt register hold', async () => {
        const denied = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'unauthorized exempt hold',
                tax_exempt: true,
                cart: { items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }] },
                subtotal: 5
            });
        expect(denied.statusCode).toBe(403);

        const malformed = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', adminCookie)
            .send({
                reference_name: 'malformed exempt hold',
                tax_exempt: 'true',
                cart: { items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }] },
                subtotal: 5
            });
        expect(malformed.statusCode).toBe(400);

        const created = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', adminCookie)
            .send({
                reference_name: 'authorized exempt hold',
                tax_exempt: true,
                cart: { items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }] },
                subtotal: 5
            });
        expect(created.statusCode).toBe(200);
        const [[row]] = await pool.query('SELECT cart_data FROM held_orders WHERE id=?', [created.body.id]);
        const payload = JSON.parse(row.cart_data);
        expect(payload.tax_exempt_at_hold).toBe(true);
        await pool.query('DELETE FROM held_orders WHERE id=?', [created.body.id]);
    });

    it('rejects reusing a hold request id for a different customer or reference', async () => {
        const holdRequestId = `task2-request-${Date.now().toString(36)}`;
        const payload = {
            hold_request_id: holdRequestId,
            reference_name: 'Phone customer one',
            cart: {
                items: [{ id: SEED.product1.id, qty: 1, price: 5.0, tax_rate: 16 }],
                customer_name: 'Customer One',
                customer_phone: '0790000001',
            },
            subtotal: 5.0,
        };
        const created = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send(payload);
        expect(created.statusCode).toBe(200);

        try {
            const replay = await request(app)
                .post('/api/pos/held_orders')
                .set('Cookie', cashierCookie)
                .send(payload);
            expect(replay.statusCode).toBe(200);
            expect(replay.body.replay).toBe(true);
            expect(replay.body.id).toBe(created.body.id);

            const changed = await request(app)
                .post('/api/pos/held_orders')
                .set('Cookie', cashierCookie)
                .send({
                    ...payload,
                    reference_name: 'Phone customer two',
                    cart: {
                        ...payload.cart,
                        customer_name: 'Customer Two',
                    },
                });
            expect(changed.statusCode).toBe(409);
            expect(changed.body.code).toBe('HELD_OPERATION_CONFLICT');
        } finally {
            await pool.query('DELETE FROM held_orders WHERE id=?', [created.body.id]);
        }
    });

    it('canonicalizes a register hold and reprices it again from the current category override on claim', async () => {
        await pool.query('UPDATE categories SET price_list_root_id = id WHERE id = ?', [SEED.category.id]);
        await pool.query('UPDATE products SET tax_rate = 8 WHERE id = ?', [SEED.product1.id]);
        await pool.query(
            'INSERT INTO product_price_overrides (price_list_root_id, product_id, price) VALUES (?, ?, ?)',
            [SEED.category.id, SEED.product1.id, 0.925926]
        );

        try {
            const held = await request(app)
                .post('/api/pos/held_orders')
                .set('Cookie', cashierCookie)
                .send({
                    reference_name: 'category-price-hold',
                    cart: { items: [{ id: SEED.product1.id, qty: 1, price: 99, tax_rate: 0, manual_price_override: true }] },
                    subtotal: 99
                });
            expect(held.statusCode).toBe(200);

            const [[row]] = await pool.query('SELECT cart_data FROM held_orders WHERE id = ?', [held.body.id]);
            const saved = JSON.parse(row.cart_data);
            expect(Number(saved.items[0].price)).toBeCloseTo(0.925926, 4);
            expect(Number(saved.items[0].tax_rate)).toBe(8);
            expect(saved.items[0].manual_price_override).toBeUndefined();

            await pool.query(
                'UPDATE product_price_overrides SET price = 1.500000 WHERE price_list_root_id = ? AND product_id = ?',
                [SEED.category.id, SEED.product1.id]
            );
            const claim = await claimHeld(cashierCookie, held.body.id, 'b'.repeat(64));

            expect(claim.statusCode).toBe(200);
            const claimed = JSON.parse(claim.body.order.cart_data);
            expect(Number(claimed.items[0].price)).toBe(1.5);
            expect(claimed.items[0].manual_price_override).toBeUndefined();
            expect(claim.body.pricing_context_changed).toMatchObject({ prices: true, total: true });
        } finally {
            await pool.query('DELETE FROM product_price_overrides WHERE price_list_root_id = ?', [SEED.category.id]);
            await pool.query('UPDATE categories SET price_list_root_id = NULL WHERE id = ?', [SEED.category.id]);
            await pool.query('UPDATE products SET tax_rate = 16 WHERE id = ?', [SEED.product1.id]);
        }
    });

    it('applies the configured default order type to a new register hold', async () => {
        await pool.query(
            "INSERT INTO settings (setting_key, setting_value) VALUES ('default_order_type_id', ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
            [String(SEED.orderType.id)]
        );
        try {
            const created = await createHold(cashierCookie, 'Default type hold');
            expect(created.success).toBe(true);
            const [[row]] = await pool.query('SELECT cart_data FROM held_orders WHERE id = ?', [created.id]);
            const cart = typeof row.cart_data === 'string' ? JSON.parse(row.cart_data) : row.cart_data;
            expect(cart.order_type_id).toBe(SEED.orderType.id);
        } finally {
            await pool.query("UPDATE settings SET setting_value='' WHERE setting_key='default_order_type_id'");
        }
    });

    it('keeps a configured Y order as an ordinary listed and claimable hold', async () => {
        await pool.query(
            "INSERT INTO settings (setting_key, setting_value) VALUES ('y_order_type_id', ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
            [String(SEED.orderType.id)]
        );
        try {
            const created = await request(app)
                .post('/api/pos/held_orders')
                .set('Cookie', cashierCookie)
                .send({
                    reference_name: 'Y archive',
                    cart: {
                        order_type_id: SEED.orderType.id,
                        order_discount: { type: 'percent', value: 10 },
                        items: [{ id: SEED.product1.id, qty: 2, price: 999, tax_rate: 0 }]
                    },
                    subtotal: 999
                });

            expect(created.statusCode).toBe(200);
            const [[stored]] = await pool.query('SELECT * FROM held_orders WHERE id = ?', [created.body.id]);

            const cart = JSON.parse(stored.cart_data);
            expect(cart.order_type_id).toBe(SEED.orderType.id);
            expect(cart.items[0]).toMatchObject({
                product_id: SEED.product1.id,
                name: SEED.product1.name,
                category_id: SEED.category.id,
                qty: 2,
                price: 5,
                tax_rate: 16
            });

            const listed = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
            expect(listed.statusCode).toBe(200);
            expect(listed.body.data.some(row => row.id === created.body.id)).toBe(true);

            expect(created.body.kitchen_fired).toBe(true);

            const claim = await claimHeld(cashierCookie, created.body.id, 'c'.repeat(64));
            expect(claim.statusCode).toBe(200);
            expect(claim.body.order.id).toBe(created.body.id);
        } finally {
            await pool.query("UPDATE settings SET setting_value='' WHERE setting_key='y_order_type_id'");
        }
    });

    it('claim keeps the row and returns its durable lease to the single winner', async () => {
        const created = await createHold(cashierCookie);
        const res = await claimHeld(cashierCookie, created.id, 'd'.repeat(64));
        expect(res.statusCode).toBe(200);
        expect(res.body.order.id).toBe(created.id);
        expect(res.body.order.cart_data).toBeTruthy();
        expect(res.body.claim.claimToken).toBe('d'.repeat(64));

        const [[row]] = await pool.query("SELECT id FROM held_orders WHERE id = ?", [created.id]);
        expect(row.id).toBe(created.id);
    });

    it('audits normal held-order creation while suppressing admin and xyz=1 actors', async () => {
        const createdByCashier = await createHold(cashierCookie, `audit-cashier-${Date.now()}`);
        const createdByAdmin = await createHold(adminCookie, `audit-admin-${Date.now()}`);
        const previousXyz = (await pool.query('SELECT xyz FROM users WHERE id=?', [SEED.cashierUser.id]))[0][0].xyz;
        let createdByXyz;
        try {
            await pool.query('UPDATE users SET xyz=1 WHERE id=?', [SEED.cashierUser.id]);
            createdByXyz = await createHold(cashierCookie, `audit-xyz-${Date.now()}`);

            const [events] = await pool.query(
                `SELECT event_type, user_id FROM audit_events
                 WHERE entity_type='held_order' AND event_type='held_order_created'
                   AND entity_id IN (?, ?, ?)
                 ORDER BY entity_id`,
                [createdByCashier.id, createdByAdmin.id, createdByXyz.id]
            );
            expect(events).toEqual([{ event_type: 'held_order_created', user_id: SEED.cashierUser.id }]);
        } finally {
            await pool.query('UPDATE users SET xyz=? WHERE id=?', [previousXyz, SEED.cashierUser.id]);
            const ids = [createdByCashier.id, createdByAdmin.id, createdByXyz?.id].filter(Boolean);
            if (ids.length) {
                await pool.query(`DELETE FROM audit_events WHERE entity_type='held_order' AND entity_id IN (${ids.map(() => '?').join(',')})`, ids);
                await pool.query(`DELETE FROM held_orders WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
            }
        }
    });

    it('a second claim of the same ticket returns 409 (already taken)', async () => {
        const created = await createHold(cashierCookie);
        const first = await claimHeld(cashierCookie, created.id, 'e'.repeat(64));
        expect(first.statusCode).toBe(200);

        const second = await claimHeld(waiterCookie, created.id, 'f'.repeat(64));
        expect(second.statusCode).toBe(409);
    });

    it('replays the same claim after a lost response without changing the lease or version', async () => {
        const created = await createHold(cashierCookie, 'lost-claim-response');
        const token = '9'.repeat(64);
        const [[before]] = await pool.query('SELECT version FROM held_orders WHERE id=?', [created.id]);
        const envelope = { claim_token: token, expected_version: Number(before.version) };
        const first = await request(app).post(`/api/pos/held_orders/${created.id}/claim`)
            .set('Cookie', cashierCookie).send(envelope);
        expect(first.statusCode).toBe(200);

        const replay = await request(app).post(`/api/pos/held_orders/${created.id}/claim`)
            .set('Cookie', cashierCookie).send(envelope);
        expect(replay.statusCode).toBe(200);
        expect(replay.body.claim).toMatchObject({ claimToken: token, version: first.body.claim.version });
        expect(replay.body.order.cart_data).toBe(first.body.order.cart_data);
        const [[after]] = await pool.query('SELECT version, claimed_by_user_id FROM held_orders WHERE id=?', [created.id]);
        expect(after).toMatchObject({ version: first.body.claim.version, claimed_by_user_id: SEED.cashierUser.id });
    });

    it('saves and releases the same row, and replays a lost save response safely', async () => {
        const created = await createHold(cashierCookie, 'same-row-save');
        const token = '1'.repeat(64);
        const claimed = await claimHeld(cashierCookie, created.id, token);
        expect(claimed.statusCode).toBe(200);
        const saveEnvelope = {
            operation_id: 'save-response-loss-1',
            claim_token: token,
            expected_version: claimed.body.claim.version,
            reference_name: 'same-row-save-updated',
            cart: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }],
        };
        const saved = await request(app).patch(`/api/pos/held_orders/${created.id}`)
            .set('Cookie', cashierCookie).send(saveEnvelope);
        expect(saved.statusCode).toBe(200);
        expect(saved.body.replay).toBe(false);
        const replay = await request(app).patch(`/api/pos/held_orders/${created.id}`)
            .set('Cookie', cashierCookie).send(saveEnvelope);
        expect(replay.statusCode).toBe(200);
        expect(replay.body.replay).toBe(true);
        const [[row]] = await pool.query(
            'SELECT id, reference_name, version, claimed_by_user_id, claim_token_hash FROM held_orders WHERE id=?',
            [created.id]
        );
        expect(row).toMatchObject({ id: created.id, reference_name: 'same-row-save-updated', claimed_by_user_id: null, claim_token_hash: null });
        expect(Number(row.version)).toBe(Number(saved.body.version));

        const nextClaim = await claimHeld(cashierCookie, created.id, '2'.repeat(64));
        expect(nextClaim.statusCode).toBe(200);
        const releaseEnvelope = {
            operation_id: 'release-response-loss-1',
            claim_token: '2'.repeat(64),
            expected_version: nextClaim.body.claim.version,
        };
        const released = await request(app).post(`/api/pos/held_orders/${created.id}/release`)
            .set('Cookie', cashierCookie).send(releaseEnvelope);
        expect(released.statusCode).toBe(200);
        const releaseReplay = await request(app).post(`/api/pos/held_orders/${created.id}/release`)
            .set('Cookie', cashierCookie).send(releaseEnvelope);
        expect(releaseReplay.statusCode).toBe(200);
        expect(releaseReplay.body.replay).toBe(true);
        await pool.query('DELETE FROM held_orders WHERE id=?', [created.id]);
    });

    it('a different cashier can claim another cashier\'s listed hold (shared list, D2)', async () => {
        const created = await createHold(cashierCookie);
        const res = await claimHeld(waiterCookie, created.id, '1'.repeat(64));
        expect(res.statusCode).toBe(200);
        expect(res.body.order.id).toBe(created.id);
    });

    it('claim of a never-existent id returns 409 (nothing to claim)', async () => {
        const res = await claimHeld(cashierCookie, 999999, '2'.repeat(64));
        expect(res.statusCode).toBe(404);
    });

    it('claim with a bad id returns 400', async () => {
        const res = await request(app).post('/api/pos/held_orders/nope/claim').set('Cookie', cashierCookie).send({ claim_token: '3'.repeat(64), expected_version: 1 });
        expect(res.statusCode).toBe(400);
    });

    it('claim rejects table split rows and leaves them untouched', async () => {
        const id = await createTableSplitHold();
        const res = await claimHeld(cashierCookie, id, '4'.repeat(64));

        expect(res.statusCode).toBe(404);
        const [[row]] = await pool.query("SELECT id, reference_name FROM held_orders WHERE id = ?", [id]);
        expect(row.id).toBe(id);
        expect(row.reference_name).toMatch(/^Table /);
    });

    it('bundle corruption: claim rejects corrupt nested child and rolls back held snapshot transition', async () => {
        const cartData = JSON.stringify({
            items: [{
                id: SEED.bundleProduct.id,
                product_id: SEED.bundleProduct.id,
                qty: 1,
                price: 10,
                is_bundle: true,
                bundleItems: [{ product_id: SEED.product1.id, qty: 0, removed: false }]
            }]
        });
        const [held] = await pool.query(
            'INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal) VALUES (?, ?, ?, ?)',
            [SEED.cashierUser.id, 'Corrupt claim bundle', cartData, 10]
        );
        const snapshotId = '00000000-0000-4000-8000-000000000901';
        await pool.query(
            `INSERT INTO service_charge_snapshots
             (id, percentage, tax_rate, state, holder_type, holder_id, created_by, version)
             VALUES (?, 10, 0, 'held', 'held_order', ?, ?, 1)`,
            [snapshotId, String(held.insertId), SEED.cashierUser.id]
        );
        await pool.query('UPDATE held_orders SET service_charge_snapshot_id=? WHERE id=?', [snapshotId, held.insertId]);

        const response = await claimHeld(cashierCookie, held.insertId, '5'.repeat(64));

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        const [[heldAfter]] = await pool.query('SELECT id FROM held_orders WHERE id=?', [held.insertId]);
        expect(heldAfter.id).toBe(held.insertId);
        const [[snapshotAfter]] = await pool.query('SELECT state, holder_type, holder_id, version FROM service_charge_snapshots WHERE id=?', [snapshotId]);
        expect(snapshotAfter).toEqual({
            state: 'held', holder_type: 'held_order', holder_id: String(held.insertId), version: 1
        });
    });

    it('bundle corruption: claim rejects an own non-array bundleItems field before deleting the hold', async () => {
        const [held] = await pool.query(
            'INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal) VALUES (?, ?, ?, ?)',
            [
                SEED.cashierUser.id,
                'Malformed claim bundle',
                JSON.stringify({ items: [{ product_id: SEED.product1.id, qty: 1, price: 5, bundleItems: {} }] }),
                5
            ]
        );
        const snapshotId = '00000000-0000-4000-8000-000000000902';
        await pool.query(
            `INSERT INTO service_charge_snapshots
             (id, percentage, tax_rate, state, holder_type, holder_id, created_by, version)
             VALUES (?, 10, 0, 'held', 'held_order', ?, ?, 1)`,
            [snapshotId, String(held.insertId), SEED.cashierUser.id]
        );
        await pool.query('UPDATE held_orders SET service_charge_snapshot_id=? WHERE id=?', [snapshotId, held.insertId]);

        const response = await claimHeld(cashierCookie, held.insertId, '6'.repeat(64));

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({
            code: 'BUNDLE_ORDER_CORRUPT',
            message: 'Order bundle data is inconsistent. Manager repair required.'
        });
        const [[stillHeld]] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [held.insertId]);
        expect(stillHeld.id).toBe(held.insertId);
        const [[snapshotAfter]] = await pool.query('SELECT state, holder_type, holder_id FROM service_charge_snapshots WHERE id=?', [snapshotId]);
        expect(snapshotAfter).toEqual({ state: 'held', holder_type: 'held_order', holder_id: String(held.insertId) });
    });

    it('bundle corruption: claim rejects malformed held JSON before snapshot mutation', async () => {
        const [held] = await pool.query(
            "INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal) VALUES (?, ?, 'malformed-json-{', ?)",
            [SEED.cashierUser.id, 'Malformed JSON claim', 5]
        );
        const snapshotId = '00000000-0000-4000-8000-000000000903';
        await pool.query(
            `INSERT INTO service_charge_snapshots
             (id, percentage, tax_rate, state, holder_type, holder_id, created_by, version)
             VALUES (?, 10, 0, 'held', 'held_order', ?, ?, 1)`,
            [snapshotId, String(held.insertId), SEED.cashierUser.id]
        );
        await pool.query('UPDATE held_orders SET service_charge_snapshot_id=? WHERE id=?', [snapshotId, held.insertId]);

        const response = await claimHeld(cashierCookie, held.insertId, '7'.repeat(64));

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        const [[stillHeld]] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [held.insertId]);
        const [[snapshotAfter]] = await pool.query('SELECT state, holder_type, holder_id FROM service_charge_snapshots WHERE id=?', [snapshotId]);
        expect(stillHeld.id).toBe(held.insertId);
        expect(snapshotAfter).toEqual({ state: 'held', holder_type: 'held_order', holder_id: String(held.insertId) });
    });

    it('bundle corruption: claim rejects null held payload before snapshot mutation', async () => {
        const [held] = await pool.query(
            "INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal) VALUES (?, ?, 'null', ?)",
            [SEED.cashierUser.id, 'Null payload claim', 5]
        );
        const snapshotId = '00000000-0000-4000-8000-000000000904';
        await pool.query(
            `INSERT INTO service_charge_snapshots
             (id, percentage, tax_rate, state, holder_type, holder_id, created_by, version)
             VALUES (?, 10, 0, 'held', 'held_order', ?, ?, 1)`,
            [snapshotId, String(held.insertId), SEED.cashierUser.id]
        );
        await pool.query('UPDATE held_orders SET service_charge_snapshot_id=? WHERE id=?', [snapshotId, held.insertId]);

        const response = await claimHeld(cashierCookie, held.insertId, '8'.repeat(64));

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        const [[stillHeld]] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [held.insertId]);
        const [[snapshotAfter]] = await pool.query('SELECT state, holder_type, holder_id FROM service_charge_snapshots WHERE id=?', [snapshotId]);
        expect(stillHeld.id).toBe(held.insertId);
        expect(snapshotAfter).toEqual({ state: 'held', holder_type: 'held_order', holder_id: String(held.insertId) });
    });

    it('bundle corruption: save rejects a corrupt nested bundle before inserting held row', async () => {
        const [[before]] = await pool.query('SELECT COUNT(*) AS c FROM held_orders');

        const response = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'Corrupt held save',
                subtotal: 10,
                cart: { items: [{
                    id: SEED.bundleProduct.id,
                    product_id: SEED.bundleProduct.id,
                    qty: 1,
                    price: 10,
                    is_bundle: true,
                    bundleItems: [{ product_id: SEED.product1.id, qty: 0, removed: false }]
                }] }
            });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        const [[after]] = await pool.query('SELECT COUNT(*) AS c FROM held_orders');
        expect(Number(after.c)).toBe(Number(before.c));
    });

    it('rejects a fresh held bundle without bundleItems before inserting a hold', async () => {
        const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders');
        const response = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'Parent-only held bundle',
                subtotal: 10,
                cart: {
                    items: [{
                        id: SEED.bundleProduct.id,
                        product_id: SEED.bundleProduct.id,
                        qty: 1,
                        price: 10,
                        is_bundle: true
                    }]
                }
            });

        expect(response.statusCode).toBe(400);
        expect(response.body.message).toBe('Invalid bundle contents.');
        const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders');
        expect(Number(after.count)).toBe(Number(before.count));
    });

    it('fire_kitchen fires successfully and returns kitchen_fired: true', async () => {
        const created = await createHold(cashierCookie, 'Test Fire Hold');
        const res = await fireHeld(cashierCookie, created.id, '22222222-2222-4222-8222-222222222222');
        expect(res.statusCode).toBe(200);
        expect(res.body.kitchen_fired).toBe(true);

        const [[row]] = await pool.query("SELECT kitchen_fired FROM held_orders WHERE id = ?", [created.id]);
        expect(row.kitchen_fired).toBe(1);
    });

    it('fire_kitchen returns 409 when called a second time on the same hold', async () => {
        const created = await createHold(cashierCookie, 'Test Double Fire');
        const first = await fireHeld(cashierCookie, created.id, '33333333-3333-4333-8333-333333333333');
        expect(first.statusCode).toBe(200);

        const second = await fireHeld(cashierCookie, created.id, '44444444-4444-4444-8444-444444444444');
        expect(second.statusCode).toBe(409);
    });

    it('queues only the positive kitchen delta and replays a lost follow-up response', async () => {
        const created = await createHold(cashierCookie, 'Follow-up delta hold');
        const fired = await fireHeld(cashierCookie, created.id, '55555555-5555-4555-8555-555555555555');
        expect(fired.statusCode).toBe(200);

        const claimToken = 'f'.repeat(64);
        const claim = await claimHeld(cashierCookie, created.id, claimToken);
        expect(claim.statusCode).toBe(200);
        const operationId = 'follow-up-response-loss-1';
        const editedCart = JSON.parse(claim.body.order.cart_data);
        editedCart.items[0].qty = 2;
        const followUpPayload = {
            operation_id: operationId,
            claim_token: claimToken,
            expected_version: claim.body.claim.version,
            cart: editedCart
        };
        const followUp = await request(app)
            .post(`/api/pos/held_orders/${created.id}/follow-up`)
            .set('Cookie', cashierCookie)
            .send(followUpPayload);
        expect(followUp.statusCode).toBe(200);
        expect(followUp.body.replay).toBe(false);
        expect(followUp.body.followUpSequence).toBe(2);

        const [queueRows] = await pool.query(
            'SELECT payload FROM print_queue WHERE idempotency_key LIKE ? ORDER BY id',
            [`kitchen:held-${created.id}-%`]
        );
        const followUpPayloads = queueRows
            .map(row => JSON.parse(row.payload))
            .filter(payload => payload.data.follow_up === true);
        expect(followUpPayloads).toHaveLength(1);
        expect(followUpPayloads[0].data.follow_up_sequence).toBe(2);
        expect(followUpPayloads[0].data.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ product_id: SEED.product1.id, qty: 1 })
        ]));
        expect(followUpPayloads[0].data.items).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ qty: 2 })
        ]));

        const replay = await request(app)
            .post(`/api/pos/held_orders/${created.id}/follow-up`)
            .set('Cookie', cashierCookie)
            .send(followUpPayload);
        expect(replay.statusCode).toBe(200);
        expect(replay.body.replay).toBe(true);
        const [[row]] = await pool.query('SELECT version, kitchen_dispatch_version, kitchen_snapshot FROM held_orders WHERE id=?', [created.id]);
        expect(Number(row.version)).toBe(Number(followUp.body.version));
        expect(Number(row.kitchen_dispatch_version)).toBe(2);
        expect(JSON.parse(row.kitchen_snapshot).next_sequence).toBe(3);
    });

    it('shows a hold with a malformed kitchen snapshot as baseline-unknown without breaking the board', async () => {
        const [inserted] = await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal, kitchen_fired, kitchen_snapshot)
             VALUES (?, 'Malformed snapshot hold', ?, 5, 1, '{not json')`,
            [SEED.cashierUser.id, JSON.stringify({ items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }] })]
        );
        const id = inserted.insertId;
        try {
            const listed = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
            expect(listed.statusCode).toBe(200);
            expect(listed.body.data.find(held => held.id === id).kitchen_baseline_known).toBe(false);
            const single = await request(app).get(`/api/pos/held_orders/${id}`).set('Cookie', cashierCookie);
            expect(single.statusCode).toBe(200);
            expect(single.body.data.kitchen_baseline_known).toBe(false);
            const claim = await claimHeld(cashierCookie, id, '8'.repeat(64));
            expect(claim.statusCode).toBe(200);
            expect(claim.body.order.kitchen_baseline_known).toBe(false);
        } finally {
            await pool.query('DELETE FROM held_orders WHERE id=?', [id]);
        }
    });

    it('blocks a legacy fired hold until an explicit no-print baseline confirmation', async () => {
        const [inserted] = await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal, kitchen_fired)
             VALUES (?, 'Legacy fired hold', ?, 5, 1)`,
            [SEED.cashierUser.id, JSON.stringify({ items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }] })]
        );
        const id = inserted.insertId;
        try {
            const claim = await claimHeld(cashierCookie, id, '9'.repeat(64));
            expect(claim.statusCode).toBe(200);
            expect(claim.body.order.kitchen_baseline_known).toBe(false);
            expect(claim.body.order).not.toHaveProperty('kitchen_snapshot');
            const unknownRow = await request(app).get(`/api/pos/held_orders/${id}`).set('Cookie', cashierCookie);
            expect(unknownRow.body.data.kitchen_baseline_known).toBe(false);

            const followUp = await request(app)
                .post(`/api/pos/held_orders/${id}/follow-up`)
                .set('Cookie', cashierCookie)
                .send({
                    operation_id: 'legacy-follow-up-blocked',
                    claim_token: '9'.repeat(64),
                    expected_version: claim.body.claim.version,
                    cart: JSON.parse(claim.body.order.cart_data)
                });
            expect(followUp.statusCode).toBe(409);
            expect(followUp.body.code).toBe('HELD_KITCHEN_BASELINE_UNKNOWN');

            const confirmed = await request(app)
                .post(`/api/pos/held_orders/${id}/baseline-confirm`)
                .set('Cookie', cashierCookie)
                .send({
                    operation_id: 'legacy-baseline-confirmed',
                    claim_token: '9'.repeat(64),
                    expected_version: claim.body.claim.version,
                    confirmed: true,
                    reason_code: 'manual_review'
                });
            expect(confirmed.statusCode).toBe(200);
            expect(confirmed.body).toMatchObject({ success: true, printed: false, replay: false });

            const [[row]] = await pool.query('SELECT kitchen_snapshot, version, claimed_by_user_id FROM held_orders WHERE id=?', [id]);
            expect(JSON.parse(row.kitchen_snapshot)).toMatchObject({ held_id: id, baseline_unknown: false });
            expect(row.claimed_by_user_id).toBeNull();
            const listed = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
            const listedRow = listed.body.data.find(held => held.id === id);
            expect(listedRow.kitchen_baseline_known).toBe(true);
            expect(listedRow).not.toHaveProperty('kitchen_snapshot');
            const [audit] = await pool.query(
                `SELECT event_type, new_value FROM audit_events
                 WHERE entity_type='held_order' AND entity_id=? AND event_type='held_order_kitchen_baseline_confirmed'`,
                [id]
            );
            expect(audit).toHaveLength(1);
            expect(JSON.parse(audit[0].new_value)).toMatchObject({ printed: false, reason_code: 'manual_review' });
            const [queue] = await pool.query('SELECT id FROM print_queue WHERE idempotency_key LIKE ?', [`kitchen:held-${id}-%`]);
            expect(queue).toHaveLength(0);
        } finally {
            await pool.query('DELETE FROM audit_events WHERE entity_type=\'held_order\' AND entity_id=?', [id]);
            await pool.query('DELETE FROM held_orders WHERE id=?', [id]);
        }
    });

    it('prints a trusted cancellation ticket from the sent baseline before deleting a fired hold', async () => {
        const created = await createHold(cashierCookie, 'Cancellation ticket hold');
        const fired = await fireHeld(cashierCookie, created.id, '66666666-6666-4666-8666-666666666666');
        expect(fired.statusCode).toBe(200);
        const claimToken = 'a'.repeat(64);
        const claim = await claimHeld(cashierCookie, created.id, claimToken);
        expect(claim.statusCode).toBe(200);

        const canceled = await request(app)
            .delete(`/api/pos/held_orders/${created.id}`)
            .set('Cookie', cashierCookie)
            .send({
                operation_id: 'cancel-response-loss-1',
                claim_token: claimToken,
                expected_version: claim.body.claim.version,
                reason_code: 'customer_changed_mind',
                confirmed: true
            });
        expect(canceled.statusCode).toBe(200);
        expect(canceled.body.canceled).toBe(true);
        expect(canceled.body.cancellation_ticket_count).toBeGreaterThan(0);

        const [[removed]] = await pool.query('SELECT id FROM held_orders WHERE id=?', [created.id]);
        expect(removed).toBeUndefined();
        const [queueRows] = await pool.query(
            'SELECT payload, idempotency_key FROM print_queue WHERE idempotency_key LIKE ? ORDER BY id',
            [`kitchen:held-${created.id}-cancel-%`]
        );
        expect(queueRows).toHaveLength(1);
        const cancelPayload = JSON.parse(queueRows[0].payload);
        expect(cancelPayload.data.cancel_ticket).toBe(true);
        expect(cancelPayload.data.follow_up).toBe(false);
        expect(cancelPayload.data.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ product_id: SEED.product1.id, qty: 1 })
        ]));
    });

    it('fire_kitchen rejects table split rows and does not mark them fired', async () => {
        const id = await createTableSplitHold();
        const res = await fireHeld(cashierCookie, id, '55555555-5555-4555-8555-555555555555');

        expect(res.statusCode).toBe(404);
        const [[row]] = await pool.query("SELECT kitchen_fired FROM held_orders WHERE id = ?", [id]);
        expect(row.kitchen_fired).toBe(0);
    });

    it('delete rejects table split rows and leaves them untouched', async () => {
        const id = await createTableSplitHold();
        const res = await request(app)
            .delete('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .query({ id });

        expect(res.statusCode).toBe(410);
        const [[row]] = await pool.query("SELECT id FROM held_orders WHERE id = ?", [id]);
        expect(row.id).toBe(id);
    });

    it('rejects a held order with no cart', async () => {
        const res = await request(app).post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({ reference_name: 'x', subtotal: 5 });
        expect(res.statusCode).toBe(400);
    });

    it('rejects a held order with a non-numeric subtotal', async () => {
        const res = await request(app).post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({ reference_name: 'x', cart: { items: [{ id: 1, qty: 1 }] }, subtotal: 'abc' });
        expect(res.statusCode).toBe(400);
    });

    describe('Receipt Tax-Mode Integration tests (Task 2)', () => {
        it('stores ordinary hold mode as preview metadata, not checkout authority', async () => {
            // Create hold under setting = 0
            await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'tax_inclusive_pricing'");
            const res = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                reference_name: 'hold-tax-mode',
                subtotal: 5.00,
                cart: { items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
            });
            expect(res.statusCode).toBe(200);
            const holdId = res.body.id;

            // Fetch and assert in JSON cart_data
            const [[hold]] = await pool.query("SELECT cart_data FROM held_orders WHERE id = ?", [holdId]);
            const cart = JSON.parse(hold.cart_data);
            expect(cart.tax_inclusive_at_hold).toBe(0);

            // Claim it
            const claim = await claimHeld(cashierCookie, holdId, 'c'.repeat(64));
            expect(claim.statusCode).toBe(200);
            // Claim response should not expose tax_inclusive_at_sale as a trusted checkout field
            // Claim response should not expose tax_inclusive_at_sale as a trusted checkout field
            expect(claim.body.order.tax_inclusive_at_sale).toBeUndefined();
        });
    });

    describe('Receipt Presentation Sources - Held Orders Integration Tests', () => {
        it('isolates one corrupt held row without downgrading or hiding valid rows', async () => {
            await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Valid Hold 1', 5.00, ?)`,
                [JSON.stringify({ tax_context_version: 1, tax_inclusive_at_hold: 0, items: [{ id: SEED.product1.id, name: 'Prod1', price: 5, qty: 1, tax_rate: 16 }] })]
            );
            const [corruptRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Corrupt Hold', 5.00, 'invalid-json-{malformed}')`
            );
            const corruptId = corruptRes.insertId;
            await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Valid Hold 2', 10.00, ?)`,
                [JSON.stringify({ tax_context_version: 1, tax_inclusive_at_hold: 0, items: [{ id: SEED.product1.id, name: 'Prod1', price: 10, qty: 1, tax_rate: 16 }] })]
            );

            const listRes = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
            expect(listRes.statusCode).toBe(200);
            
            const list = listRes.body.data;
            const v1 = list.find(h => h.reference_name === 'Valid Hold 1');
            const v2 = list.find(h => h.reference_name === 'Valid Hold 2');
            const corrupt = list.find(h => h.reference_name === 'Corrupt Hold');

            expect(v1.receipt_display_v1).toBeDefined();
            expect(v2.receipt_display_v1).toBeDefined();
            expect(corrupt.receipt_display_v1).toBeNull();
            expect(corrupt.receipt_display_error).toBe('RECEIPT_PRESENTATION_INVALID');
        });

        it('isolates bundle corruption while valid held siblings remain printable', async () => {
            const [validRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Bundle Integrity Valid Sibling', 5.00, ?)`,
                [JSON.stringify({
                    tax_context_version: 1,
                    tax_inclusive_at_hold: 0,
                    items: [{ id: SEED.product1.id, name: 'Prod1', price: 5, qty: 1, tax_rate: 16 }]
                })]
            );
            const [corruptRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Bundle Integrity Corrupt', 5.00, ?)`,
                [JSON.stringify({
                    tax_context_version: 1,
                    tax_inclusive_at_hold: 0,
                    items: [{
                        id: SEED.bundleProduct.id,
                        name: 'Broken Bundle',
                        price: 5,
                        qty: 0,
                        is_bundle: true,
                        tax_rate: 16,
                        bundleItems: [{ product_id: SEED.product1.id, name: 'Prod1', qty: 1, removed: false }]
                    }]
                })]
            );

            const listRes = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
            expect(listRes.statusCode).toBe(200);
            const valid = listRes.body.data.find(row => row.id === validRes.insertId);
            const corrupt = listRes.body.data.find(row => row.id === corruptRes.insertId);
            expect(valid.receipt_display_v1).toBeDefined();
            expect(corrupt.receipt_display_v1).toBeNull();
            expect(corrupt.receipt_display_error).toBe('BUNDLE_ORDER_CORRUPT');
        });

        it('rebuilds held v1 from lifecycle-authoritative tax evidence', async () => {
            await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Legacy Hold Missing Rate', 5.00, ?)`,
                [JSON.stringify([{ product_id: SEED.product1.id, name: 'Prod1', price: 5, qty: 1 }])]
            );
            await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Legacy Hold Forged Rate', 5.00, ?)`,
                [JSON.stringify([{ product_id: SEED.product1.id, name: 'Prod1', price: 5, qty: 1, tax_rate: 99.00 }])]
            );

            const listRes = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
            expect(listRes.statusCode).toBe(200);

            const list2 = listRes.body.data;
            const missing = list2.find(h => h.reference_name === 'Legacy Hold Missing Rate');
            const forged = list2.find(h => h.reference_name === 'Legacy Hold Forged Rate');

            expect(missing.receipt_display_v1).toBeDefined();
            expect(missing.receipt_display_v1.summary.taxAmount).toBe(0.80);

            expect(forged.receipt_display_v1).toBeDefined();
            expect(forged.receipt_display_v1.summary.taxAmount).toBe(0.80);
        });

        it('proves multi-quantity fixed line discount survives into held v1', async () => {
            const cartData = {
                tax_context_version: 1,
                tax_inclusive_at_hold: 0,
                items: [{
                    id: SEED.product1.id,
                    name: 'Prod1',
                    price: 10.00,
                    qty: 2,
                    discountType: 'fixed',
                    discountValue: 4.00,
                    tax_rate: 16
                }]
            };
            const [insertRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Fixed Line Disc Hold', 12.00, ?)`,
                [JSON.stringify(cartData)]
            );
            
            const listRes = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
            expect(listRes.statusCode).toBe(200);
            
            const hold = listRes.body.data.find(h => h.id === insertRes.insertId);
            expect(hold.receipt_display_v1).toBeDefined();
            const row = hold.receipt_display_v1.rows[0];
            expect(row.unitPrice).toBe(10.00);
            expect(row.lineDiscountAmount).toBe(8.00);
            expect(row.netAmount).toBe(12.00);
        });

        it('isolates rows whose payload breaks the calculator without hiding valid rows', async () => {
            // These payloads make normalizeCartItems/calculateExpectedTotals throw
            // PLAIN Errors (not typed presentation errors); each must degrade to a
            // per-row receipt_display_error instead of 500ing the whole list.
            const [validRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Iso Valid', 5.00, ?)`,
                [JSON.stringify({ tax_context_version: 1, tax_inclusive_at_hold: 0, items: [{ id: SEED.product1.id, name: 'Prod1', price: 5, qty: 1, tax_rate: 16 }] })]
            );
            const [emptyRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Iso Empty Items', 0.00, ?)`,
                [JSON.stringify({ tax_context_version: 1, tax_inclusive_at_hold: 0, items: [] })]
            );
            const [qtyZeroRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Iso Qty Zero', 5.00, ?)`,
                [JSON.stringify({ tax_context_version: 1, tax_inclusive_at_hold: 0, items: [{ id: SEED.product1.id, name: 'Prod1', price: 5, qty: 0, tax_rate: 16 }] })]
            );
            const [badRateRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Iso Bad Rate', 5.00, ?)`,
                [JSON.stringify({ items: [{ name: 'Custom', price: 5, qty: 1, tax_rate: 250 }] })]
            );
            // Structural poison: these break BEFORE the calculator (items iteration in
            // the batch evidence loader / row mapping) and must also stay per-row.
            const [notArrayRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Iso Items Object', 5.00, ?)`,
                [JSON.stringify({ items: {} })]
            );
            const [nullItemRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Iso Null Item', 5.00, ?)`,
                [JSON.stringify({ items: [null] })]
            );
            const [primitiveItemRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Iso Primitive Item', 5.00, ?)`,
                [JSON.stringify({ items: [1] })]
            );

            const listRes = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
            expect(listRes.statusCode).toBe(200);
            const byId = id => listRes.body.data.find(h => h.id === id);

            expect(byId(validRes.insertId).receipt_display_v1).toBeDefined();
            for (const bad of [emptyRes.insertId, qtyZeroRes.insertId, badRateRes.insertId,
                notArrayRes.insertId, nullItemRes.insertId, primitiveItemRes.insertId]) {
                expect(byId(bad).receipt_display_v1).toBeNull();
                expect(byId(bad).receipt_display_error).toBe('RECEIPT_PRESENTATION_INVALID');
            }
        });

        it('claims an array-shaped legacy hold without failing', async () => {
            const [insertRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Array Shape Hold', 5.00, ?)`,
                [JSON.stringify([{ product_id: SEED.product1.id, name: 'Prod1', price: 5, qty: 1, tax_rate: 16 }])]
            );
            const res = await claimHeld(cashierCookie, insertRes.insertId, '9'.repeat(64));
            expect(res.statusCode).toBe(200);
            const claimed = JSON.parse(res.body.order.cart_data);
            expect(Array.isArray(claimed.items)).toBe(true);
            expect(claimed.items).toHaveLength(1);
            const [[stillHeld]] = await pool.query("SELECT id FROM held_orders WHERE id = ?", [insertRes.insertId]);
            expect(stillHeld.id).toBe(insertRes.insertId);
        });

        it('normalizes forged catalog rates at park and rejects a bad custom rate', async () => {
            // tax_context_version:1 promises server-authored rates: a forged catalog
            // rate must be overwritten with the DB product rate before persisting.
            const res = await request(app)
                .post('/api/pos/held_orders')
                .set('Cookie', cashierCookie)
                .send({
                    cart: { items: [{ id: SEED.product1.id, qty: 1, price: 5.0, tax_rate: 0 }] },
                    subtotal: 5.0
                });
            expect(res.statusCode).toBe(200);
            const [[row]] = await pool.query("SELECT cart_data FROM held_orders WHERE id = ?", [res.body.id]);
            const parsed = JSON.parse(row.cart_data);
            expect(parsed.tax_context_version).toBe(1);
            expect(Number(parsed.items[0].tax_rate)).toBe(16);

            const listRes = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
            const hold = listRes.body.data.find(h => h.id === res.body.id);
            expect(hold.receipt_display_v1.summary.taxAmount).toBe(0.80);

            // A custom line (no product to normalize from) fails closed on a garbage rate.
            const bad = await request(app)
                .post('/api/pos/held_orders')
                .set('Cookie', cashierCookie)
                .send({
                    cart: { items: [{ name: 'Custom Thing', qty: 1, price: 5.0, tax_rate: 250 }] },
                    subtotal: 5.0
                });
            expect(bad.statusCode).toBe(400);
        });

        it('renders a legacy pre-version hold under the current tax mode, not hardcoded exclusive', async () => {
            // Pre-plan payload: object shape, no version, no mode flag. Claim/settle
            // resolve a null flag to the current system mode, so the preview must too.
            const [insertRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Legacy Inclusive Hold', 10.00, ?)`,
                [JSON.stringify({ items: [{ product_id: SEED.product1.id, name: 'Prod1', price: 10, qty: 1 }] })]
            );
            await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'tax_inclusive_pricing'");
            try {
                const listRes = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
                expect(listRes.statusCode).toBe(200);
                const hold = listRes.body.data.find(h => h.id === insertRes.insertId);
                expect(hold.receipt_display_v1).toBeDefined();
                expect(hold.receipt_display_v1.taxMode).toBe('inclusive');
                expect(hold.receipt_display_v1.summary.taxAmount).toBe(0);
                expect(hold.receipt_display_v1.summary.total).toBe(10.00);
            } finally {
                await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'tax_inclusive_pricing'");
            }
        });

        it('proves held mode metadata remains hold-time mode after the global setting changes', async () => {
            const cartData = {
                tax_context_version: 1,
                tax_inclusive_at_hold: 0,
                items: [{ id: SEED.product1.id, name: 'Prod1', price: 10.00, qty: 1, tax_rate: 16 }]
            };
            const [insertRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                 VALUES (1, 'Frozen Mode Hold', 10.00, ?)`,
                [JSON.stringify(cartData)]
            );
            
            // Change global setting to inclusive
            await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'tax_inclusive_pricing'");
            
            try {
                const listRes = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
                expect(listRes.statusCode).toBe(200);
                
                const hold = listRes.body.data.find(h => h.id === insertRes.insertId);
                expect(hold.receipt_display_v1).toBeDefined();
                expect(hold.receipt_display_v1.taxMode).toBe('exclusive');
            } finally {
                // Restore default exclusive setting
                await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'tax_inclusive_pricing'");
            }
        });

        it('stores DB-canonical selectedModifiers in held cart_data for name-only stale clients', async () => {
            await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
                JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
                SEED.product1.id
            ]);

            try {
                const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                    reference_name: 'stale-client-mods',
                    subtotal: 7.00,
                    cart: { items: [{
                        id: SEED.product1.id, qty: 1, price: 7.00, tax_rate: 16,
                        note: 'Size: Large (2.00 JD)',
                        selectedModifiers: [{ group: 'Size', option: 'Large', price: 999 }]
                    }] }
                });
                expect(held.statusCode).toBe(200);

                const [[row]] = await pool.query('SELECT cart_data FROM held_orders WHERE id = ?', [held.body.id]);
                const parsed = JSON.parse(row.cart_data);
                expect(parsed.items[0].selectedModifiers).toEqual([
                    { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2 }
                ]);
            } finally {
                await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.product1.id]);
            }
        });

        it('claim upgrades an old name-only held row when names still match', async () => {
            await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
                JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
                SEED.product1.id
            ]);
            try {
                const cartData = JSON.stringify({ items: [{
                    id: SEED.product1.id, product_id: SEED.product1.id, qty: 1, price: 7.00, tax_rate: 16,
                    note: 'Size: Large (2.00 JD)',
                    selectedModifiers: [{ group: 'Size', option: 'Large', price: 2 }]
                }] });
                const [ins] = await pool.query(
                    'INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal) VALUES (?, ?, ?, ?)',
                    [SEED.cashierUser.id, 'legacy-name-only', cartData, 7.00]
                );

                const claim = await claimHeld(cashierCookie, ins.insertId, 'a'.repeat(64));
                expect(claim.statusCode).toBe(200);
                const claimed = JSON.parse(claim.body.order.cart_data);
                expect(claimed.items[0].selectedModifiers).toEqual([
                    { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2 }
                ]);
                expect(Number(claimed.items[0].modifier_surcharge)).toBe(2);
                expect(claim.body.pricing_context_changed.total).toBe(true);
            } finally {
                await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.product1.id]);
            }
        });

        it('hold save derives modifier_surcharge server-side and claim preserves it', async () => {
            await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
                JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
                SEED.product1.id
            ]);

            try {
                const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                    reference_name: 'hold-surcharge',
                    subtotal: 7.00,
                    cart: { items: [{
                        id: SEED.product1.id, qty: 1, price: 7.00, tax_rate: 16,
                        note: 'Size: Large (2.00 JD)',
                        selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
                    }] }
                });
                expect(held.statusCode).toBe(200);

                const [[row]] = await pool.query('SELECT cart_data FROM held_orders WHERE id = ?', [held.body.id]);
                const parsed = JSON.parse(row.cart_data);
                expect(Number(parsed.items[0].modifier_surcharge)).toBe(2);

                const claim = await claimHeld(cashierCookie, held.body.id, 'b'.repeat(64));
                expect(claim.statusCode).toBe(200);
                const claimed = JSON.parse(claim.body.order.cart_data);
                expect(Number(claimed.items[0].modifier_surcharge)).toBe(2);
            } finally {
                await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.product1.id]);
            }
        });

        it('presents held order receipt display v1 with reduced tax excluding modifier surcharge', async () => {
            await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
                JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
                SEED.product1.id
            ]);

            try {
                const cartData = {
                    tax_context_version: 1,
                    tax_inclusive_at_hold: 0,
                    items: [{
                        id: SEED.product1.id,
                        name: 'Prod1',
                        price: 7.00,
                        qty: 1,
                        tax_rate: 16,
                        modifier_surcharge: 2.00,
                        selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2.00 }]
                    }]
                };
                const [insertRes] = await pool.query(
                    `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
                     VALUES (1, 'Surcharge Presentation Hold', 7.00, ?)`,
                    [JSON.stringify(cartData)]
                );
                
                const listRes = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
                expect(listRes.statusCode).toBe(200);
                
                const hold = listRes.body.data.find(h => h.id === insertRes.insertId);
                expect(hold.receipt_display_v1).toBeDefined();
                expect(hold.receipt_display_v1.summary.taxAmount).toBe(0.80); // (7.00 - 2.00) * 0.16 = 0.80
                expect(hold.receipt_display_v1.summary.total).toBe(7.80);
            } finally {
                await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.product1.id]);
            }
        });
    });
    describe('[priced note] catalog-backed note products', () => {
        let noteId;
        let baseId;

        // This file seeds once in beforeAll and earlier tests mutate SEED.product1
        // (modifiers, subscription sale intent). Own the base product outright so the
        // priced-note assertions cannot inherit that state.
        async function createNoteFixtures() {
            // Earlier tests in this file leave the cashier at the 20-hold cap.
            await pool.query('DELETE FROM held_orders');
            const [base] = await pool.query(
                "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, is_active) VALUES (?, 'Note Base Item', 2.70, 0, 'O', 1)",
                [SEED.category.id]
            );
            const [category] = await pool.query(
                "INSERT INTO categories (name, is_notes, is_active) VALUES ('Paid notes', 1, 1)"
            );
            const [note] = await pool.query(
                "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, is_active) VALUES (?, 'Two slices', 0.20, 0, 'O', 1)",
                [category.insertId]
            );
            baseId = base.insertId;
            noteId = note.insertId;
        }

        function holdWithNote(selection) {
            return request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                hold_request_id: `note-${crypto.randomUUID()}`,
                subtotal: 2.90,
                cart: {
                    customer_name: 'Note Customer',
                    order_type_id: 1,
                    items: [{ id: baseId, qty: 1, price: 2.90, tax_rate: 0, selectedModifiers: [selection] }]
                }
            });
        }

        const claimHold = (id, token) => request(app)
            .post(`/api/pos/held_orders/${id}/claim`)
            .set('Cookie', cashierCookie)
            .send({ claim_token: token.repeat(64), expected_version: 1 });

        const claimedItems = (res) => {
            const raw = res.body.order?.cart_data;
            return (typeof raw === 'string' ? JSON.parse(raw) : (raw || {})).items || [];
        };

        beforeEach(createNoteFixtures);

        it('[priced note] canonicalizes a forged display price when the hold is saved', async () => {
            const res = await holdWithNote({ noteProductId: noteId, group: 'forged', option: 'forged', price: 99 });
            expect(res.statusCode).toBe(200);

            const [[row]] = await pool.query('SELECT cart_data FROM held_orders WHERE id=?', [res.body.id]);
            expect(JSON.parse(row.cart_data).items[0].selectedModifiers).toEqual([
                { noteProductId: noteId, group: 'Two slices', option: 'Two slices', price: 0.2 }
            ]);
        });

        it('[priced note] reprices the note from the current catalog when the hold is claimed', async () => {
            const created = await holdWithNote({ noteProductId: noteId });
            expect(created.statusCode).toBe(200);
            await pool.query('UPDATE products SET price=0.25 WHERE id=?', [noteId]);

            const claim = await claimHold(created.body.id, 'a');
            expect(claim.statusCode).toBe(200);
            const item = claimedItems(claim)[0];
            expect(Number(item.price)).toBe(2.95);
            expect(Number(item.modifier_surcharge)).toBe(0.25);
            expect(item.selectedModifiers).toEqual([
                { noteProductId: noteId, group: 'Two slices', option: 'Two slices', price: 0.25 }
            ]);
        });

        it('[priced note] drops a deactivated note instead of stranding the hold', async () => {
            const created = await holdWithNote({ noteProductId: noteId });
            expect(created.statusCode).toBe(200);
            await pool.query('UPDATE products SET is_active=0 WHERE id=?', [noteId]);

            const claim = await claimHold(created.body.id, 'b');
            // A deactivated BASE product still claims, so a deactivated note must too.
            expect(claim.statusCode).toBe(200);
            const item = claimedItems(claim)[0];
            expect(item.selectedModifiers).toBeNull();
            expect(Number(item.price)).toBe(2.70);
            // The price drop is what tells the cashier; no new signal was added for it.
            expect(claim.body.pricing_context_changed.prices).toBe(true);
        });

        it('[priced note] refuses a note-category product as a top-level held line', async () => {
            const res = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                hold_request_id: `note-top-${crypto.randomUUID()}`,
                subtotal: 0.20,
                cart: {
                    customer_name: 'Note Customer',
                    order_type_id: 1,
                    items: [{ id: noteId, qty: 1, price: 0.20, tax_rate: 0 }]
                }
            });
            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('NOTE_PRODUCT_REQUIRES_ITEM');
        });
    });
});
