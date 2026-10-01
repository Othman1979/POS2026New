const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Admin Users API — hardening', () => {
    let adminCookie;
    beforeEach(async () => {
        await seedDatabase();
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    async function listUsers() {
        const res = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
        return res.body.users;
    }

    describe('name is trimmed before storage', () => {
        it('stores a padded name without surrounding whitespace', async () => {
            const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: '  John Padded  ', user_number: '8001', role: 'cashier', allowed_sections: '' });
            expect(create.statusCode).toBe(200);
            const users = await listUsers();
            const john = users.find(u => u.user_number === '8001');
            expect(john).toBeDefined();
            expect(john.name).toBe('John Padded');
        });
    });

    describe('allowed_sections is validated', () => {
        it('rejects a non-numeric section token with 400', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'BadSec', user_number: '8101', role: 'cashier', allowed_sections: 'abc' });
            expect(res.statusCode).toBe(400);
        });
        it('drops a non-existent section id (stores null)', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'GhostSec', user_number: '8102', role: 'cashier', allowed_sections: '999' });
            expect(res.statusCode).toBe(200);
            const list = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
            const u = list.body.users.find(x => x.user_number === '8102');
            expect(u.allowed_sections == null || u.allowed_sections === '').toBe(true);
        });
        it('keeps a valid existing section id', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'GoodSec', user_number: '8103', role: 'cashier', allowed_sections: '1' });
            expect(res.statusCode).toBe(200);
            const list = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
            const u = list.body.users.find(x => x.user_number === '8103');
            expect(u.allowed_sections).toBe('1');
        });
    });

    // <-- append new describe blocks above this line
});
