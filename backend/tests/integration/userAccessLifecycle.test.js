const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('user access edit lifecycle', () => {
    let cookie;
    beforeEach(async () => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        cookie = login.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });
    const users = async () => (await request(app).get('/api/admin/users').set('Cookie', cookie)).body.users;
    const cashier = async () => (await users()).find(row => row.id === SEED.cashierUser.id);
    const save = data => request(app).put('/api/admin/users').set('Cookie', cookie).send(data);
    const grants = async () => (await pool.query('SELECT perm_key FROM user_permissions WHERE user_id=? ORDER BY perm_key', [SEED.cashierUser.id]))[0].map(row => row.perm_key);

    it('rejects a stale name edit that would restore a revoked grant', async () => {
        const original = await cashier();
        expect(original.edit_version).toMatch(/^[a-f0-9]{64}$/);
        const permissions = original.permissions.filter(key => key !== 'pos.checkout');
        const revoked = await save({ ...original, permissions });
        expect(revoked.status).toBe(200);
        expect(revoked.body.edit_version).not.toBe(original.edit_version);
        const stale = await save({ ...original, name: 'Stale name' });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe('USER_EDIT_CONFLICT');
        expect(await grants()).not.toContain('pos.checkout');
        expect((await cashier()).name).toBe(original.name);
        expect((await save({ ...await cashier(), name: 'Current name' })).status).toBe(200);
    });

    it('allows exactly one of two edits based on the same profile', async () => {
        const original = await cashier();
        const results = await Promise.all([save({ ...original, name: 'First editor' }), save({ ...original, name: 'Second editor' })]);
        expect(results.map(row => row.status).sort()).toEqual([200, 409]);
    });

    it('rejects missing versions and notices external grant changes', async () => {
        const original = await cashier();
        const { edit_version, ...withoutVersion } = original;
        expect((await save(withoutVersion)).status).toBe(409);
        await pool.query("DELETE FROM user_permissions WHERE user_id=? AND perm_key='pos.checkout'", [original.id]);
        expect((await save(original)).status).toBe(409);
        expect(await grants()).not.toContain('pos.checkout');
    });

    it('revokes existing sessions and records the access delta without PINs', async () => {
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        const oldCookie = login.headers['set-cookie'][0];
        const original = await cashier();
        const updated = await save({ ...original, permissions: [], user_number: '99887766' });
        expect(updated.status).toBe(200);
        expect((await request(app).get('/api/auth/me').set('Cookie', oldCookie)).status).toBe(401);
        const [events] = await pool.query("SELECT user_id,entity_id,old_value,new_value FROM audit_events WHERE event_type='user_access_changed'");
        expect(events).toHaveLength(1);
        expect(events[0].user_id).toBe(SEED.adminUser.id);
        expect(Number(events[0].entity_id)).toBe(original.id);
        const before = typeof events[0].old_value === 'string' ? JSON.parse(events[0].old_value) : events[0].old_value;
        const after = typeof events[0].new_value === 'string' ? JSON.parse(events[0].new_value) : events[0].new_value;
        expect(before.permissions).toContain('pos.checkout');
        expect(after.permissions).toEqual([]);
        expect(after.login_pin_changed).toBe(true);
        expect(JSON.stringify(events)).not.toContain('99887766');
        expect((await users()).every(row => !Object.hasOwn(row, 'admin_pin'))).toBe(true);
    });

    it('returns a usable version on create and canonicalizes duplicate grants', async () => {
        const payload = { name: 'New employee', user_number: '99887766', role: 'cashier', permissions: ['pos.checkout', 'pos.checkout'], table_access_scope: 'all', allowed_sections: '' };
        const created = await request(app).post('/api/admin/users').set('Cookie', cookie).send(payload);
        expect(created.status).toBe(200);
        expect(created.body.edit_version).toMatch(/^[a-f0-9]{64}$/);
        expect((await save({ ...payload, id: created.body.id, edit_version: created.body.edit_version, name: 'Edited immediately' })).status).toBe(200);
    });

    it('keeps a name-only edit to one catalog read and no grant writes', async () => {
        const original = await cashier();
        const acquire = pool.getConnection.bind(pool);
        const queries = [];
        let active = 0;
        const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
            const conn = await acquire();
            active++;
            const query = conn.query, release = conn.release;
            conn.query = function(sql, ...args) { queries.push(sql.replace(/\s+/g, ' ').trim()); return query.call(this, sql, ...args); };
            conn.release = function() { conn.query = query; conn.release = release; active--; return release.call(this); };
            return conn;
        });
        try {
            expect((await save({ ...original, name: 'Only a name change' })).status).toBe(200);
            expect(queries.filter(sql => /^SELECT perm_key FROM permissions/.test(sql))).toHaveLength(1);
            expect(queries.filter(sql => /^(INSERT INTO|DELETE FROM) user_permissions/.test(sql))).toEqual([]);
            expect(queries.filter(sql => /^INSERT INTO audit_events/.test(sql))).toEqual([]);
            expect(active).toBe(0);
        } finally { spy.mockRestore(); }
    });

    it('clears manager credentials on a role downgrade and versions the resulting profile', async () => {
        const payload = { name: 'Temporary manager', user_number: '99887766', role: 'admin', admin_override_pin: '5678' };
        const created = await request(app).post('/api/admin/users').set('Cookie', cookie).send(payload);
        expect(created.status).toBe(200);
        const original = (await users()).find(user => user.id === created.body.id);
        const changed = await save({ ...original, role: 'cashier', permissions: [], admin_override_pin: '' });
        expect(changed.status).toBe(200);
        const [[stored]] = await pool.query('SELECT admin_pin FROM users WHERE id=?', [original.id]);
        expect(stored.admin_pin).toBeNull();
        expect((await users()).find(user => user.id === original.id).edit_version).toBe(changed.body.edit_version);
    });
});
