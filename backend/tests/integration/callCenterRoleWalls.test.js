const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');

describe('fixed call-center privileged route walls', () => {
    let cookie;

    beforeEach(async () => {
        await seedDatabase();
        await pool.query(`
            INSERT INTO users (id, user_number, name, role, is_active)
            VALUES (20, '9020', 'Call Center Walls', 'call_center', 1)
        `);
        await pool.query(`
            INSERT IGNORE INTO user_permissions (user_id, perm_key)
            SELECT 20, perm_key FROM permissions WHERE implemented=1
        `);
        const login = await request(app).post('/api/auth/login').send({ user_number: '9020' });
        cookie = login.headers['set-cookie'][0];
    });

    afterAll(async () => { await pool.end(); });

    it('rejects direct financial, operational, table, print, and general-held endpoints', async () => {
        const probes = [
            ['get', '/api/admin/printers'],
            ['post', '/api/pos/checkout/jofotara'],
            ['post', '/api/pos/checkout/jofotara/status'],
            ['post', '/api/pos/log_drawer_pop'],
            ['get', '/api/pos/get_tables'],
            ['post', '/api/pos/tables/transfer'],
            ['post', '/api/pos/tables/join'],
            ['post', '/api/pos/tables/disjoin'],
            ['get', '/api/pos/table_order'],
            ['post', '/api/pos/table_order'],
            ['delete', '/api/pos/table-draft/1'],
            ['get', '/api/pos/table_splits'],
            ['delete', '/api/pos/table_splits'],
            ['post', '/api/pos/table_splits/split'],
            ['post', '/api/pos/service_charge_snapshots'],
            ['delete', '/api/pos/service_charge_snapshots/test-snapshot'],
            ['get', '/api/pos/subscription-plans'],
            ['get', '/api/pos/customer-subscriptions'],
            ['post', '/api/pos/subscriptions/1/collections'],
            ['post', '/api/pos/subscriptions/1/collections/1/reverse'],
            ['post', '/api/pos/subscriptions/1/refund'],
            ['post', '/api/pos/subscription-redemptions'],
            ['post', '/api/pos/refunds'],
            ['get', '/api/pos/expense-categories'],
            ['post', '/api/pos/expenses'],
            ['post', '/api/print/print'],
            ['get', '/api/pos/held_orders'],
            ['post', '/api/pos/held_orders/settle-platform'],
            ['post', '/api/pos/held_orders/1/baseline-confirm'],
            ['post', '/api/pos/held_orders/fire_kitchen'],
            ['get', '/api/pos/order_notes'],
        ];

        for (const [method, path] of probes) {
            const response = await request(app)[method](path).set('Cookie', cookie).send({});
            expect(response.statusCode, `${method.toUpperCase()} ${path}`).toBe(403);
            expect(response.body.message, `${method.toUpperCase()} ${path}`).toMatch(/call center/i);
        }
    });

    it('keeps the deliberately public QR table-draft read unchanged', async () => {
        const response = await request(app)
            .get('/api/pos/table-draft/1?token=test_qr_token_abc123')
            .set('Cookie', cookie);
        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({ success: true, cart: [] });
    });
});
