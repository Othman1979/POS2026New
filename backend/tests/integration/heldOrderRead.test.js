import { describe, it, expect, beforeAll } from 'vitest';
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('GET /api/pos/held_orders/:id', () => {
    let cashierCookie;
    let callCenterCookie;

    beforeAll(async () => {
        await seedDatabase();
        const c = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = c.headers['set-cookie'][0];
        await pool.query(`
            INSERT INTO users (id, user_number, name, role, is_active, xyz)
            VALUES (80, '9080', 'Phone Desk Read', 'call_center', 1, 0)
        `);
        const cc = await request(app).post('/api/auth/login').send({ user_number: '9080' });
        callCenterCookie = cc.headers['set-cookie'][0];
    });

    async function createHold(referenceName) {
        const created = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: referenceName,
                subtotal: 7,
                cart: {
                    items: [
                        { id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 },
                        { id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }
                    ]
                }
            });
        expect(created.statusCode).toBe(200);
        return created.body.id;
    }

    it('marks a hold from the automated order intake so the board can tint it', async () => {
        const posHold = await createHold('Register hold');
        const intakeHold = await createHold('Intake hold');
        // Order intake records every hold it creates; a register hold has no intake record,
        // whatever request id it was sent with.
        await pool.query('UPDATE held_orders SET hold_request_id=? WHERE id=?', [`oi-${'b'.repeat(61)}`, posHold]);
        await pool.query(
            `INSERT INTO order_intake_requests (client_id, external_request_id, request_hash, held_order_id, result_json)
             VALUES ('read-test', 'intake-1', ?, ?, '{}')`,
            ['c'.repeat(64), intakeHold]
        );

        const list = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
        expect(list.statusCode).toBe(200);
        const flag = id => Number(list.body.data.find(row => Number(row.id) === Number(id)).from_order_intake);
        expect(flag(intakeHold)).toBe(1);
        expect(flag(posHold)).toBe(0);
    });

    it('returns the single row exactly as the list presents it and announces the create with a payload', async () => {
        global.__mockEmit__.mockClear();
        const heldId = await createHold('Single read');
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'held_orders_changed')).toEqual([[
            'held_orders_changed',
            { action: 'created', held_order_id: heldId, table_id: null, parent_invoice_id: null }
        ]]);
        await createHold('Sibling row');

        const list = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
        expect(list.statusCode).toBe(200);
        const fromList = list.body.data.find(row => Number(row.id) === Number(heldId));
        expect(fromList).toBeDefined();
        expect(fromList.receipt_display_v1).not.toBeNull();

        const single = await request(app).get(`/api/pos/held_orders/${heldId}`).set('Cookie', cashierCookie);
        expect(single.statusCode).toBe(200);
        expect(single.body.success).toBe(true);
        expect(Object.keys(single.body).sort()).toEqual(['data', 'success']);
        expect(single.body.data).toEqual(fromList);
        expect(Object.keys(single.body.data).sort()).toEqual(Object.keys(fromList).sort());
    });

    it('returns 404 for a missing id and for a row the list would hide', async () => {
        const missing = await request(app).get('/api/pos/held_orders/999999').set('Cookie', cashierCookie);
        expect(missing.statusCode).toBe(404);
        expect(missing.body).toMatchObject({ success: false, message: 'Held order not found.' });

        const malformed = await request(app).get('/api/pos/held_orders/not-a-number').set('Cookie', cashierCookie);
        expect(malformed.statusCode).toBe(404);
        expect(malformed.body).toMatchObject({ success: false, message: 'Held order not found.' });

        const [orderResult] = await pool.query(
            `INSERT INTO orders (user_id, order_type_id, subtotal, tax, total, payment_method)
             VALUES (?, 1, 5, 0, 5, 'unpaid_table')`,
            [SEED.cashierUser.id]
        );
        const [split] = await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal, parent_invoice_id, table_id)
             VALUES (?, 'Table 1 - Check 2', '{"items":[]}', 5, ?, 1)`,
            [SEED.cashierUser.id, orderResult.insertId]
        );
        try {
            const list = await request(app).get('/api/pos/held_orders').set('Cookie', cashierCookie);
            expect(list.body.data.some(row => Number(row.id) === Number(split.insertId))).toBe(false);
            const hidden = await request(app).get(`/api/pos/held_orders/${split.insertId}`).set('Cookie', cashierCookie);
            expect(hidden.statusCode).toBe(404);
            expect(hidden.body).toMatchObject({ success: false, message: 'Held order not found.' });
        } finally {
            await pool.query('DELETE FROM held_orders WHERE id=?', [split.insertId]);
            await pool.query('DELETE FROM orders WHERE invoice_id=?', [orderResult.insertId]);
        }
    });

    it('rejects the call-center role like the list route', async () => {
        const heldId = await createHold('Role wall');
        const list = await request(app).get('/api/pos/held_orders').set('Cookie', callCenterCookie);
        const single = await request(app).get(`/api/pos/held_orders/${heldId}`).set('Cookie', callCenterCookie);
        expect(list.statusCode).toBe(403);
        expect(single.statusCode).toBe(403);
        expect(single.body).toEqual(list.body);
    });
});
