import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Held Orders - automatic kitchen firing', () => {
    let cashierCookie;
    let callCenterCookie;
    let kitchenPrinterId;

    beforeAll(async () => {
        await seedDatabase();
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Auto Fire Kitchen', 'kitchen', 'windows', 'Auto Fire Kitchen', 'auto-fire-test')"
        );
        kitchenPrinterId = printer.insertId;
        await pool.query(
            'INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)',
            [kitchenPrinterId, SEED.category.id]
        );
        const login = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = login.headers['set-cookie'][0];
        await pool.query(`
            INSERT INTO users (id, user_number, name, role, is_active, xyz)
            VALUES (82, '9082', 'Automatic Fire Phone Desk', 'call_center', 1, 0)
        `);
        const callCenterLogin = await request(app)
            .post('/api/auth/login')
            .send({ user_number: '9082' });
        callCenterCookie = callCenterLogin.headers['set-cookie'][0];
    });

    afterAll(async () => {
        if (!kitchenPrinterId) return;
        await pool.query('DELETE FROM print_queue WHERE printer_id=?', [kitchenPrinterId]);
        await pool.query('DELETE FROM printer_categories WHERE printer_id=?', [kitchenPrinterId]);
        await pool.query('DELETE FROM printers WHERE id=?', [kitchenPrinterId]);
    });

    it('automatically queues an unscheduled held order through the durable kitchen path', async () => {
        const holdRequestId = `auto-fire-${crypto.randomUUID()}`;
        const response = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                hold_request_id: holdRequestId,
                reference_name: 'Immediate kitchen hold',
                subtotal: 5,
                cart: {
                    items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                }
            });

        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(response.body).toMatchObject({
            kitchen_fired: true,
            kitchen_ticket_count: 1,
            kitchen_dispatch_version: 1
        });

        const [[held]] = await pool.query(
            'SELECT kitchen_fired, kitchen_dispatch_version, kitchen_snapshot FROM held_orders WHERE id=?',
            [response.body.id]
        );
        expect(Number(held.kitchen_fired)).toBe(1);
        expect(Number(held.kitchen_dispatch_version)).toBe(1);
        expect(JSON.parse(held.kitchen_snapshot)).toMatchObject({ held_id: response.body.id, sequence: 1 });

        const [jobs] = await pool.query(
            'SELECT payload FROM print_queue WHERE printer_id=? AND idempotency_key LIKE ? ORDER BY id',
            [kitchenPrinterId, `kitchen:held-${response.body.id}-%`]
        );
        expect(jobs).toHaveLength(1);
        expect(JSON.parse(jobs[0].payload).data).toMatchObject({
            order_id: Number(response.body.order_display_no),
            order_display_no: response.body.order_display_no,
            ticket_display_no: null
        });
    });

    it('replays a lost creation response without firing the held order twice', async () => {
        const payload = {
            hold_request_id: `auto-fire-replay-${crypto.randomUUID()}`,
            reference_name: 'Replay-safe kitchen hold',
            subtotal: 5,
            cart: {
                items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
            }
        };
        const first = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send(payload);
        expect(first.statusCode).toBe(200);

        const replay = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send(payload);
        expect(replay.statusCode).toBe(200);
        expect(replay.body).toMatchObject({
            id: first.body.id,
            replay: true,
            kitchen_fired: true,
            kitchen_ticket_count: 1,
            kitchen_dispatch_version: 1
        });

        const [[count]] = await pool.query(
            'SELECT COUNT(*) count FROM print_queue WHERE printer_id=? AND idempotency_key LIKE ?',
            [kitchenPrinterId, `kitchen:held-${first.body.id}-%`]
        );
        expect(Number(count.count)).toBe(1);
    });

    it('automatically fires an unscheduled call-center hold without granting manual-fire access', async () => {
        const response = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', callCenterCookie)
            .send({
                hold_request_id: `phone-auto-fire-${crypto.randomUUID()}`,
                subtotal: 5,
                cart: {
                    customer_name: 'Phone Customer',
                    customer_phone: '0791234567',
                    customer_address: 'Amman',
                    order_type_id: 1,
                    items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                }
            });

        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(response.body.kitchen_fired).toBe(true);
        const deniedManualFire = await request(app)
            .post('/api/pos/held_orders/fire_kitchen')
            .set('Cookie', callCenterCookie)
            .send({ id: response.body.id });
        expect(deniedManualFire.statusCode).toBe(403);
    });

    it('leaves an explicitly scheduled phone hold unfired', async () => {
        const response = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', callCenterCookie)
            .send({
                hold_request_id: `scheduled-hold-${crypto.randomUUID()}`,
                subtotal: 5,
                cart: {
                    customer_name: 'Scheduled Customer',
                    customer_phone: '0791234568',
                    customer_address: 'Amman',
                    delivery_date: '2026-09-01T14:30',
                    order_type_id: 1,
                    items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                }
            });

        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(response.body).toMatchObject({
            kitchen_fired: false,
            kitchen_ticket_count: 0,
            kitchen_dispatch_version: 0
        });
        const [[held]] = await pool.query(
            'SELECT kitchen_fired, kitchen_snapshot FROM held_orders WHERE id=?',
            [response.body.id]
        );
        expect(Number(held.kitchen_fired)).toBe(0);
        expect(held.kitchen_snapshot).toBeNull();
    });

    it('fires an unfired phone hold when an edit removes its schedule', async () => {
        const created = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', callCenterCookie)
            .send({
                hold_request_id: `unschedule-${crypto.randomUUID()}`,
                subtotal: 5,
                cart: {
                    customer_name: 'Immediate Customer',
                    customer_phone: '0791234569',
                    customer_address: 'Amman',
                    delivery_date: '2026-09-01T15:30',
                    order_type_id: 1,
                    items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                }
            });
        expect(created.statusCode).toBe(200);
        expect(created.body.kitchen_fired).toBe(false);

        const claimToken = 'a'.repeat(64);
        const claimed = await request(app)
            .post(`/api/pos/held_orders/${created.body.id}/claim`)
            .set('Cookie', callCenterCookie)
            .send({ claim_token: claimToken, expected_version: 1, phone: '0791234569' });
        expect(claimed.statusCode).toBe(200);
        const cart = JSON.parse(claimed.body.order.cart_data);
        cart.delivery_date = '';

        const savePayload = {
            operation_id: `save-${crypto.randomUUID()}`,
            expected_version: claimed.body.claim.version,
            claim_token: claimToken,
            cart
        };
        const saved = await request(app)
            .patch(`/api/pos/held_orders/${created.body.id}`)
            .set('Cookie', callCenterCookie)
            .send(savePayload);

        expect(saved.statusCode).toBe(200);
        expect(saved.body.kitchen_fired).toBe(true);
        const [[held]] = await pool.query(
            'SELECT kitchen_fired, kitchen_dispatch_version, kitchen_snapshot FROM held_orders WHERE id=?',
            [created.body.id]
        );
        expect(Number(held.kitchen_fired)).toBe(1);
        expect(Number(held.kitchen_dispatch_version)).toBe(1);
        expect(JSON.parse(held.kitchen_snapshot).held_id).toBe(created.body.id);
        const [[jobs]] = await pool.query(
            'SELECT COUNT(*) count FROM print_queue WHERE printer_id=? AND idempotency_key LIKE ?',
            [kitchenPrinterId, `kitchen:held-${created.body.id}-%`]
        );
        expect(Number(jobs.count)).toBe(1);

        const replay = await request(app)
            .patch(`/api/pos/held_orders/${created.body.id}`)
            .set('Cookie', callCenterCookie)
            .send(savePayload);
        expect(replay.statusCode).toBe(200);
        expect(replay.body).toMatchObject({ replay: true, kitchen_fired: true, kitchen_dispatch_version: 1 });
        const [[afterReplay]] = await pool.query(
            'SELECT COUNT(*) count FROM print_queue WHERE printer_id=? AND idempotency_key LIKE ?',
            [kitchenPrinterId, `kitchen:held-${created.body.id}-%`]
        );
        expect(Number(afterReplay.count)).toBe(1);
    });

    it('rejects a malformed cashier schedule instead of treating it as an auto-fire exemption', async () => {
        const response = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                hold_request_id: `invalid-schedule-${crypto.randomUUID()}`,
                reference_name: 'Invalid schedule',
                subtotal: 5,
                cart: {
                    delivery_date: 'later',
                    items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                }
            });

        expect(response.statusCode).toBe(400);
        expect(response.body.code).toBe('HELD_DELIVERY_DATE_INVALID');
    });

    it('keeps the hold when no kitchen route exists and reports that it was not fired', async () => {
        await pool.query('DELETE FROM printer_categories WHERE printer_id=?', [kitchenPrinterId]);
        try {
            const response = await request(app)
                .post('/api/pos/held_orders')
                .set('Cookie', cashierCookie)
                .send({
                    hold_request_id: `no-route-${crypto.randomUUID()}`,
                    reference_name: 'No kitchen venue',
                    subtotal: 5,
                    cart: {
                        items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                    }
                });

            expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
            expect(response.body).toMatchObject({
                kitchen_fired: false,
                kitchen_ticket_count: 0,
                kitchen_dispatch_version: 0
            });
            const [[held]] = await pool.query(
                'SELECT kitchen_fired FROM held_orders WHERE id=?',
                [response.body.id]
            );
            expect(Number(held.kitchen_fired)).toBe(0);
        } finally {
            await pool.query('INSERT IGNORE INTO printer_categories(printer_id,category_id) VALUES(?,?)', [kitchenPrinterId,SEED.category.id]);
        }
    });

    it('keeps a cashier-entered Table prefix as display text, not hold-kind authority', async () => {
        const response = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                hold_request_id: `table-split-${crypto.randomUUID()}`,
                reference_name: 'Table 12 - Seat 1',
                subtotal: 5,
                cart: {
                    items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                }
            });

        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(response.body.kitchen_fired).toBe(true);
        const [[held]] = await pool.query(
            'SELECT kitchen_fired, parent_invoice_id, table_id FROM held_orders WHERE id=?',
            [response.body.id]
        );
        expect(Number(held.kitchen_fired)).toBe(1);
        expect(held.parent_invoice_id).toBeNull();
        expect(held.table_id).toBeNull();

        const listed = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
        expect(listed.statusCode).toBe(200);
        expect(listed.body.data.some(row => Number(row.id) === Number(response.body.id))).toBe(true);

        const claimed = await request(app)
            .post(`/api/pos/held_orders/${response.body.id}/claim`)
            .set('Cookie', cashierCookie)
            .send({ claim_token: 'b'.repeat(64), expected_version: 1 });
        expect(claimed.statusCode).toBe(200);
    });
});
