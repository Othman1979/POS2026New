const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { invalidateUserSessions } = require('../../middleware/auth');

describe('explicit staff table section scope', () => {
    let admin;
    beforeEach(async () => {
        await seedDatabase();
        await pool.query("INSERT INTO sections(id,name) VALUES(2,'Other section')");
        await pool.query('UPDATE restaurant_tables SET section_id=2 WHERE id=2');
        admin = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });
    const payload = { name: 'Scoped employee', user_number: '7788', permissions: ['tables.access', 'tables.save', 'waiter.edit_locked'] };
    const create = data => request(app).post('/api/admin/users').set('Cookie', admin).send({ ...payload, ...data });
    const login = async () => request(app).post('/api/auth/login').send({ user_number: '7788' });
    const save = (id, cookie) => request(app).post('/api/pos/table_order').set('Cookie', cookie).send({ table_id: id, cart: [{ id: 2, qty: 1, price: 2, tax_rate: 0 }], subtotal: 2, tax: 0, total: 2 });

    it.each([['cashier', 'none', 403], ['waiter', 'all', 200]])('honors %s scope %s in login, cache reload, floor and direct save', async (role, scope, status) => {
        const created = await create({ role, table_access_scope: scope, allowed_sections: '' });
        expect(created.status).toBe(200);
        const signedIn = await login();
        expect(signedIn.body.user.table_access_scope).toBe(scope);
        const cookie = signedIn.headers['set-cookie'][0];
        invalidateUserSessions(created.body.id);
        const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
        expect(me.body.user.table_access_scope).toBe(scope);
        const floor = await request(app).get('/api/pos/get_tables').set('Cookie', cookie);
        expect(floor.status).toBe(200);
        expect(floor.body.tables.map(row => row.id)).toEqual(scope === 'all' ? [1, 2] : []);
        expect((await save(2, cookie)).status).toBe(status);
    });

    it('keeps an explicit all scope through a cashier-to-waiter role change', async () => {
        const created = await create({ role: 'cashier', table_access_scope: 'all', allowed_sections: '' });
        const updated = await request(app).put('/api/admin/users').set('Cookie', admin).send({ ...payload, id: created.body.id, edit_version: created.body.edit_version, role: 'waiter', table_access_scope: 'all', allowed_sections: '' });
        expect(updated.status).toBe(200);
        const signedIn = await login();
        expect((await save(2, signedIn.headers['set-cookie'][0])).status).toBe(200);
    });

    it('requires an actual selection for selected scope and rejects unknown scope values', async () => {
        expect((await create({ role: 'cashier', table_access_scope: 'selected', allowed_sections: '' })).status).toBe(400);
        expect((await create({ role: 'cashier', table_access_scope: 'unexpected', allowed_sections: '' })).status).toBe(400);
        const created = await create({ role: 'cashier', table_access_scope: 'selected', allowed_sections: '1' });
        expect(created.status).toBe(200);
        const signedIn = await login(), cookie = signedIn.headers['set-cookie'][0];
        expect((await save(2, cookie)).status).toBe(403);
        expect((await save(1, cookie)).status).toBe(200);
    });
});
