const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('System settings role projection', () => {
    let adminCookie;
    let callCenterCookie;

    beforeAll(async () => {
        await seedDatabase();
        await pool.query(`
            INSERT INTO users (id, user_number, name, role, is_active)
            VALUES (20, '9020', 'Call Center Settings', 'call_center', 1)
        `);

        const adminLogin = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminLogin.headers['set-cookie'][0];

        const callCenterLogin = await request(app)
            .post('/api/auth/login')
            .send({ user_number: '9020' });
        callCenterCookie = callCenterLogin.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    it('keeps the complete existing projection for ordinary staff', async () => {
        const res = await request(app)
            .get('/api/system/settings')
            .set('Cookie', adminCookie);

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            store_name: expect.any(String),
            barcode_enabled: expect.any(String),
            print_method: expect.any(String),
            tax_registration_type: expect.any(String),
            jofotara_sales_tax_seller_tax_number: expect.any(String),
            jofotara_income_tax_seller_tax_number: expect.any(String),
            tables_enabled: expect.any(String),
            recipe_ledger_enabled: expect.any(String),
            receipt_config: null,
            spooler_address: expect.any(String)
        });
    });

    it('returns presentation and POS catalog settings, and nothing sensitive, to a call-center session', async () => {
        const res = await request(app)
            .get('/api/system/settings')
            .set('Cookie', callCenterCookie);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            store_name: 'POS',
            store_icon: null,
            admin_language: 'en',
            stock_enabled: expect.any(String),
            recipe_ledger_enabled: expect.any(String),
            tables_enabled: expect.any(String),
            service_charge_enabled: expect.any(String),
            service_charge_percentage: expect.any(String),
            auto_apply_service_charge: expect.any(String)
        });
    });
});
