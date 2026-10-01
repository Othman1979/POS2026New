const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { invalidateUserSessions } = require('../../middleware/auth');

describe('checkout authority follows the persisted order workflow', () => {
    let admin, waiter;
    const cart = [{ id: 2, product_id: 2, name: 'Test Drink', qty: 1, price: 2, tax_rate: 0 }];
    const totals = { cart, subtotal: 2, tax: 0, total: 2, payment_method: 'cash', amount_tendered: 2 };
    const login = async number => (await request(app).post('/api/auth/login').send({ user_number: number })).headers['set-cookie'][0];
    beforeEach(async () => {
        await seedDatabase();
        await pool.query('DELETE FROM user_permissions WHERE user_id=?', [SEED.waiterUser.id]);
        await pool.query("INSERT INTO user_permissions(user_id,perm_key) VALUES(?,'waiter.checkout')", [SEED.waiterUser.id]);
        await pool.query("INSERT INTO shifts(user_id,status,starting_cash) VALUES(?,'open',0)", [SEED.waiterUser.id]);
        invalidateUserSessions(SEED.waiterUser.id);
        admin = await login(SEED.adminUser.user_number);
        waiter = await login(SEED.waiterUser.user_number);
    });
    afterAll(async () => { await pool.end(); });

    it('does not let table-payment authority finalize a counter sale', async () => {
        const result = await request(app).post('/api/pos/checkout').set('Cookie', waiter).send(totals);
        expect(result.status).toBe(403);
        const [[row]] = await pool.query("SELECT COUNT(*) AS count FROM orders WHERE payment_method='cash'");
        expect(Number(row.count)).toBe(0);
    });

    it('allows that same waiter to settle a real saved table order', async () => {
        const saved = await request(app).post('/api/pos/table_order').set('Cookie', admin).send({ ...totals, table_id: 1 });
        expect(saved.status).toBe(200);
        const result = await request(app).post('/api/pos/checkout').set('Cookie', waiter).send({ ...totals, table_id: 1, edit_invoice_id: saved.body.invoice_id });
        expect(result.status).toBe(200);
        const [[order]] = await pool.query('SELECT payment_method,total FROM orders WHERE invoice_id=?', [saved.body.invoice_id]);
        expect(order.payment_method).toBe('cash');
        expect(Number(order.total)).toBe(2);
    });
});
