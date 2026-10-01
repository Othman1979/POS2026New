// backend/tests/integration/duplicateReceiptSetting.test.js
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('duplicate_customer_receipt setting', () => {
    let adminCookie;
    let cashierCookie;

    beforeAll(async () => {
        await seedDatabase();

        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];

        const cashierRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = cashierRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.query("DELETE FROM settings WHERE setting_key = 'duplicate_customer_receipt'");
        await pool.end();
    });

    it('defaults to "0" when never set', async () => {
        const res = await request(app)
            .get('/api/system/settings')
            .set('Cookie', adminCookie);

        expect(res.statusCode).toBe(200);
        expect(res.body.duplicate_customer_receipt).toBe('0');
    });

    it('rejects writes from non-admin accounts', async () => {
        const res = await request(app)
            .post('/api/system/settings')
            .set('Cookie', cashierCookie)
            .send({ duplicate_customer_receipt: '1' });

        expect(res.statusCode).toBe(403);
    });

    it('persists "1" when an admin enables it', async () => {
        const postRes = await request(app)
            .post('/api/system/settings')
            .set('Cookie', adminCookie)
            .send({ duplicate_customer_receipt: '1' });

        expect(postRes.statusCode).toBe(200);
        expect(postRes.body.success).toBe(true);

        const getRes = await request(app)
            .get('/api/system/settings')
            .set('Cookie', adminCookie);

        expect(getRes.body.duplicate_customer_receipt).toBe('1');
    });

    it('coerces any non-"0"/"1" value to "0" instead of persisting garbage', async () => {
        const postRes = await request(app)
            .post('/api/system/settings')
            .set('Cookie', adminCookie)
            .send({ duplicate_customer_receipt: 'DROP TABLE settings;' });

        expect(postRes.statusCode).toBe(200);
        expect(postRes.body.success).toBe(true);

        const [rows] = await pool.query(
            "SELECT setting_value FROM settings WHERE setting_key = 'duplicate_customer_receipt'"
        );
        expect(rows[0].setting_value).toBe('0');
    });
});
