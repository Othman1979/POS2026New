const { withUserEditVersion } = require('../helpers/adminUsers');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Admin Users API — manager override PIN', () => {
    let adminCookie;
    beforeEach(async () => {
        await seedDatabase();
        const adminRes = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    it('hashes admin_pin on create and it approves manager overrides', async () => {
        const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
            .send({ name: 'Mgr One', user_number: '9401', role: 'admin', admin_override_pin: '4242' });
        expect(create.statusCode).toBe(200);

        const [rows] = await pool.query("SELECT admin_pin FROM users WHERE user_number = '9401'");
        expect(rows[0].admin_pin).toBeTruthy();
        expect(rows[0].admin_pin.startsWith('$2')).toBe(true);

        const ok = await request(app).post('/api/auth/manager_override').set('Cookie', adminCookie).send({ admin_pin: '4242' });
        expect(ok.statusCode).toBe(200);
    });

    it('rejects an override PIN that is not 4-8 digits', async () => {
        const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
            .send({ name: 'Bad Pin', user_number: '9402', role: 'admin', admin_override_pin: '12' });
        expect(res.statusCode).toBe(400);
    });

    it('ignores an override PIN for non-admin roles (admin_pin stays null)', async () => {
        const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
            .send({ name: 'Cash Pin', user_number: '9403', role: 'cashier', admin_override_pin: '7777', allowed_sections: '' });
        expect(create.statusCode).toBe(200);
        const [rows] = await pool.query("SELECT admin_pin FROM users WHERE user_number = '9403'");
        expect(rows[0].admin_pin).toBeNull();

        const denied = await request(app).post('/api/auth/manager_override').set('Cookie', adminCookie).send({ admin_pin: '7777' });
        expect(denied.statusCode).toBe(401);
    });

    it('PUT with a blank override PIN keeps the existing admin_pin', async () => {
        const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
            .send({ name: 'Keep Pin', user_number: '9404', role: 'admin', admin_override_pin: '5252' });
        expect(create.statusCode).toBe(200);
        const [before] = await pool.query("SELECT id, admin_pin FROM users WHERE user_number = '9404'");
        const id = before[0].id;

        const put = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
            .send(await withUserEditVersion(app, adminCookie, { id, name: 'Keep Pin', user_number: '9404', role: 'admin', admin_override_pin: '' }));
        expect(put.statusCode).toBe(200);
        const [after] = await pool.query("SELECT admin_pin FROM users WHERE id = ?", [id]);
        expect(after[0].admin_pin).toBe(before[0].admin_pin);

        const ok = await request(app).post('/api/auth/manager_override').set('Cookie', adminCookie).send({ admin_pin: '5252' });
        expect(ok.statusCode).toBe(200);
    });
});
