const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { authorizeManagerOverride, overrideAttempts } = require('../../services/ManagerOverrideService');
const { invalidateUserSessions } = require('../../middleware/auth');
const { getTestDatabaseOptions } = require('../testDatabase.cjs');

describe('checkout manager override connection lifetime', () => {
    let cookie;
    let shiftId;

    beforeEach(async () => {
        if (process.env.POSAPP_REVIEW_CONNECTION_LIMIT) {
            expect(pool.pool.config.connectionLimit).toBe(Number(process.env.POSAPP_REVIEW_CONNECTION_LIMIT));
        }
        await seedDatabase();
        overrideAttempts.clear();
        const login = await request(app).post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cookie = login.headers['set-cookie'][0];
        const shift = await request(app).post('/api/auth/shifts?action=open')
            .set('Cookie', cookie).send({ user_id: SEED.cashierUser.id, starting_cash: 20 });
        expect(shift.statusCode).toBe(200);
        const [[row]] = await pool.query("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'", [SEED.cashierUser.id]);
        shiftId = row.id;
    });

    afterAll(async () => { await pool.end(); });

    const checkout = (managerPin, extra = {}) => request(app).post('/api/pos/checkout')
        .set('Cookie', cookie).send({
            cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
            shift_id: shiftId, subtotal: 2, tax: 0, total: 1.8,
            payment_method: 'cash', amount_tendered: 2, change_due: 0.2,
            order_discount_type: 'percent', order_discount_value: 10,
            manager_pin: managerPin, ...extra,
        }).timeout({ deadline: 3000 });

    // Run with POSAPP_REVIEW_CONNECTION_LIMIT=1 to exercise a completely occupied pool.
    it('finishes a PIN-authorized discount while checkout holds the only connection', async () => {
        const response = await checkout(SEED.adminUser.pin);
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        const [[order]] = await pool.query('SELECT total, discount_value FROM orders WHERE invoice_id = ?', [response.body.invoice_id]);
        expect(Number(order.total)).toBe(1.8);
        expect(Number(order.discount_value)).toBe(10);
        await vi.waitFor(async () => {
            const [[audit]] = await pool.query("SELECT manager_id FROM audit_events WHERE event_type = 'pin_override_success' AND user_id = ?", [SEED.cashierUser.id]);
            expect(audit?.manager_id).toBe(SEED.adminUser.id);
        });
    });

    const priceOnly = { cart: [{ id: SEED.product2.id, qty: 1, price: 1.5 }],
        subtotal: 1.5, total: 1.5, change_due: 0.5, order_discount_type: null, order_discount_value: 0 };

    it('does not let an admin PIN bypass a disabled discount approval', async () => {
        await pool.query("UPDATE permissions SET overridable=0 WHERE perm_key='pos.discount'");
        const response = await checkout(SEED.adminUser.pin);
        expect(response.statusCode, JSON.stringify(response.body)).toBe(403);
        expect((await pool.query('SELECT invoice_id FROM orders'))[0]).toEqual([]);
    });

    it('returns only enabled checkout fields to the temporary approval UI', async () => {
        await pool.query("UPDATE permissions SET overridable=0 WHERE perm_key='pos.discount'");
        const response = await request(app).post('/api/auth/manager_override').set('Cookie', cookie).send({ admin_pin: SEED.adminUser.pin });
        expect(response.statusCode).toBe(200);
        expect(response.body.permissions).toEqual(['pos.price_override']);
    });

    it('does not let discount approval authorize a separately disabled manual price', async () => {
        await pool.query("UPDATE permissions SET overridable=0 WHERE perm_key='pos.price_override'");
        const response = await checkout(SEED.adminUser.pin, { ...priceOnly, total: 1.35, change_due: 0.65, order_discount_type: 'percent', order_discount_value: 10 });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(403);
        expect((await pool.query('SELECT invoice_id FROM orders'))[0]).toEqual([]);
    });

    it('returns only requested supported approvals without replacing the actor', async () => {
        const user = Object.freeze({ id: SEED.cashierUser.id, role: 'cashier', table_access_scope: 'none', permissions: Object.freeze(['pos.checkout']) });
        const result = await authorizeManagerOverride({ user, managerPin: SEED.adminUser.pin, actions: ['pos.discount'], route: '/api/pos/checkout' });
        expect(result).toEqual({ managerId: SEED.adminUser.id, approvedActions: ['pos.discount'] });
        expect(user).toMatchObject({ role: 'cashier', table_access_scope: 'none', permissions: ['pos.checkout'] });
    });

    it('does not interpret arbitrary catalog overridable flags as supported actions', async () => {
        await pool.query("UPDATE permissions SET overridable=1 WHERE perm_key='pos.checkout'");
        await expect(authorizeManagerOverride({ user: { id: 2, role: 'cashier' }, managerPin: SEED.adminUser.pin, actions: ['pos.checkout'] })).rejects.toMatchObject({ statusCode: 403 });
    });

    it('verifies a combined discount and manual price once without granting later requests', async () => {
        const response = await checkout(SEED.adminUser.pin, { ...priceOnly, total: 1.35, change_due: 0.65, order_discount_type: 'percent', order_discount_value: 10 });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        await vi.waitFor(async () => {
            const [[audit]] = await pool.query("SELECT COUNT(*) AS count FROM audit_events WHERE event_type='pin_override_success'");
            expect(audit.count).toBe(1);
        });
        const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
        expect(me.body.user.role).toBe('cashier');
        expect(me.body.user.permissions).not.toContain('pos.discount');
        expect((await checkout(null)).statusCode).toBe(403);
    });

    it('authorizes a manual price with a manager PIN even without a discount', async () => {
        const response = await checkout(SEED.adminUser.pin, priceOnly);
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        const [[order]] = await pool.query('SELECT total FROM orders WHERE invoice_id = ?', [response.body.invoice_id]);
        expect(Number(order.total)).toBe(1.5);
        const [[audit]] = await pool.query("SELECT manager_id FROM audit_events WHERE event_type = 'price_override'");
        expect(audit.manager_id).toBe(SEED.adminUser.id);
    });

    it('attributes a manager only to the action their PIN approved', async () => {
        await pool.query(
            "INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.discount'), (?, 'pos.tax_exempt')",
            [SEED.cashierUser.id, SEED.cashierUser.id]
        );
        await pool.query('UPDATE users SET xyz=1 WHERE id=?', [SEED.adminUser.id]);
        invalidateUserSessions(SEED.cashierUser.id);
        const login = await request(app).post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cookie = login.headers['set-cookie'][0];

        const response = await checkout(SEED.adminUser.pin, {
            ...priceOnly,
            total: 1.35,
            change_due: 0.65,
            order_discount_type: 'percent',
            order_discount_value: 10,
            tax_exempt: true
        });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);

        const [audits] = await pool.query(
            "SELECT event_type, manager_id FROM audit_events WHERE entity_id=? AND event_type IN ('order_discount_changed','price_override','tax_exempt_checkout') ORDER BY event_type",
            [response.body.invoice_id]
        );
        expect(audits).toEqual([
            expect.objectContaining({ event_type: 'order_discount_changed', manager_id: null }),
            expect.objectContaining({ event_type: 'tax_exempt_checkout', manager_id: null })
        ]);
    });

    it('rejects an invalid manager PIN on a price-only override and retains its audit', async () => {
        const response = await checkout('wrong-pin', priceOnly);
        expect(response.statusCode).toBe(401);
        const [[order]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        expect(Number(order.count)).toBe(0);
        await vi.waitFor(async () => {
            const [[audit]] = await pool.query("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'pin_override_failed'");
            expect(Number(audit.count)).toBe(1);
        });
    });

    it('does not test an unused PIN when there is no price or discount override', async () => {
        const response = await checkout('unused-invalid-pin', {
            subtotal: 2, total: 2, change_due: 0, order_discount_type: null, order_discount_value: 0,
        });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        const [[audit]] = await pool.query("SELECT COUNT(*) AS count FROM audit_events WHERE event_type LIKE 'pin_override_%'");
        expect(Number(audit.count)).toBe(0);
    });

    it('rolls back invalid attempts, retains their audits and enforces lockout', async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
            expect((await checkout('wrong-pin')).statusCode).toBe(401);
        }
        expect((await checkout(SEED.adminUser.pin)).statusCode).toBe(429);
        const [[orders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        expect(Number(orders.count)).toBe(0);
        // Override audits run independently so checkout can release its connection.
        await vi.waitFor(async () => {
            const [audits] = await pool.query('SELECT event_type, COUNT(*) AS count FROM audit_events WHERE user_id = ? GROUP BY event_type', [SEED.cashierUser.id]);
            expect(audits).toEqual(expect.arrayContaining([
                expect.objectContaining({ event_type: 'pin_override_failed', count: 5 }),
                expect.objectContaining({ event_type: 'pin_override_locked', count: 1 }),
            ]));
        });
    });

    it('keeps tax-exemption authorization before manager override', async () => {
        const response = await checkout(SEED.adminUser.pin, { tax_exempt: true });
        expect(response.statusCode).toBe(403);
        expect(response.body.code).toBe('TAX_EXEMPT_PERMISSION_REQUIRED');
        const [[audit]] = await pool.query("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'pin_override_success'");
        expect(Number(audit.count)).toBe(0);
    });

    it('recovers a committed PIN-authorized checkout without charging or authorizing twice', async () => {
        const payload = { idempotency_key: 'manager-pin-checkout-recovery' };
        const first = await checkout(SEED.adminUser.pin, payload);
        expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
        await pool.query('UPDATE users SET is_active = 0 WHERE id = ?', [SEED.adminUser.id]);
        const replay = await checkout(SEED.adminUser.pin, payload);
        expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
        expect(replay.body.invoice_id).toBe(first.body.invoice_id);
        const [[orders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        expect(Number(orders.count)).toBe(1);
        await vi.waitFor(async () => {
            const [[audits]] = await pool.query("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'pin_override_success'");
            expect(Number(audits.count)).toBe(1);
        });
    });

    it.each([
        ['a disabled manager', 'UPDATE users SET is_active = 0 WHERE id = ?'],
        ['a revoked manager role', "UPDATE users SET role = 'cashier' WHERE id = ?"],
        ['a removed manager PIN', 'UPDATE users SET admin_pin = NULL WHERE id = ?'],
    ])('does not authorize %s from an older checkout snapshot', async (_label, update) => {
        const conn = await pool.getConnection();
        const writer = await require('mysql2/promise').createConnection(getTestDatabaseOptions());
        try {
            await conn.beginTransaction();
            await conn.query('SELECT id FROM users'); // Establish the checkout snapshot.
            await writer.query(update, [SEED.adminUser.id]);
            await expect(authorizeManagerOverride({
                user: { id: SEED.cashierUser.id, role: 'cashier', permissions: ['pos.checkout'] },
                managerPin: SEED.adminUser.pin,
                actions: ['pos.discount'],
                executor: conn,
                route: '/api/pos/checkout',
            })).rejects.toMatchObject({ statusCode: 401 });
        } finally {
            await conn.rollback();
            conn.release();
            await writer.end();
        }
    });

    it('reads the current overridable catalog after the checkout snapshot was established', async () => {
        const conn = await pool.getConnection();
        const writer = await require('mysql2/promise').createConnection(getTestDatabaseOptions());
        try {
            await conn.beginTransaction();
            await conn.query('SELECT perm_key FROM permissions');
            await writer.query("UPDATE permissions SET overridable = 0 WHERE perm_key = 'pos.discount'");
            const result = await authorizeManagerOverride({
                user: { id: SEED.cashierUser.id, role: 'cashier', permissions: ['pos.checkout'] },
                managerPin: SEED.adminUser.pin,
                actions: ['pos.discount'],
                executor: conn,
                route: '/api/pos/checkout',
            });
            expect(result.approvedActions).toEqual([]);
            expect(result).not.toHaveProperty('permissions');
            expect(result).not.toHaveProperty('role');
        } finally {
            await conn.rollback();
            conn.release();
            await writer.end();
        }
    });
});
