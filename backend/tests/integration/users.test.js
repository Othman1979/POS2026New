const { withUserEditVersion } = require('../helpers/adminUsers');
const request = require('supertest');
const { app, io } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Admin Users API', () => {
    let adminCookie;
    beforeEach(async () => {
        await seedDatabase();
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    describe('PIN (user_number) is a digit-string, leading zeros preserved', () => {
        it('creates a leading-zero PIN and that exact PIN logs in; stripped form does not', async () => {
            const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Zero Lead', user_number: '0042', role: 'cashier', permissions: [], allowed_sections: '' });
            expect(create.statusCode).toBe(200);
            expect(create.body.success).toBe(true);

            const good = await request(app).post('/api/auth/login').send({ user_number: '0042' });
            expect(good.statusCode).toBe(200);
            expect(good.body.success).toBe(true);

            const stripped = await request(app).post('/api/auth/login').send({ user_number: '42' });
            expect(stripped.statusCode).toBe(401);
        });
        it('rejects a non-digit PIN', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Bad', user_number: '12ab', role: 'cashier' });
            expect(res.statusCode).toBe(400);
        });
        it('rejects an empty PIN', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Empty', user_number: '', role: 'cashier' });
            expect(res.statusCode).toBe(400);
        });
        it('rejects a PIN longer than 8 digits', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Long', user_number: '123456789', role: 'cashier' });
            expect(res.statusCode).toBe(400);
        });
        it('accepts an 8-digit PIN and it logs in', async () => {
            const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Eight', user_number: '10000042', role: 'cashier', allowed_sections: '' });
            expect(create.statusCode).toBe(200);
            const login = await request(app).post('/api/auth/login').send({ user_number: '10000042' });
            expect(login.statusCode).toBe(200);
        });
    });

    describe('role is allowlisted (no hidden programmer/table_manager)', () => {
        it('rejects role=programmer on create', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Sneaky', user_number: '7001', role: 'programmer' });
            expect(res.statusCode).toBe(400);
        });
        it('rejects role=table_manager on create', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'TM', user_number: '7002', role: 'table_manager' });
            expect(res.statusCode).toBe(400);
        });
        it('accepts cashier, waiter, call center and admin', async () => {
            const roles = ['cashier', 'waiter', 'call_center', 'admin'];
            for (let i = 0; i < roles.length; i++) {
                const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                    .send({ name: 'Ok' + roles[i], user_number: '720' + i, role: roles[i], allowed_sections: '' });
                expect(res.statusCode).toBe(200);
            }
        });
        it('rejects PUT escalation to programmer', async () => {
            const res = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send(await withUserEditVersion(app, adminCookie, { id: SEED.cashierUser.id, name: 'Test Cashier', user_number: SEED.cashierUser.user_number, role: 'programmer' }));
            expect(res.statusCode).toBe(400);
        });

        it('does not allow the hidden programmer to be edited or deactivated by id', async () => {
            const [insert] = await pool.query(
                "INSERT INTO users (name, user_number, role, is_active) VALUES ('Hidden Programmer', '87654321', 'programmer', 1)"
            );

            const update = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send(await withUserEditVersion(app, adminCookie, { id: insert.insertId, name: 'Exposed', user_number: '87654320', role: 'cashier', permissions: [] }));
            const remove = await request(app).delete('/api/admin/users').set('Cookie', adminCookie)
                .send({ id: insert.insertId });

            expect(update.statusCode).toBe(404);
            expect(remove.statusCode).toBe(404);
            const [[stored]] = await pool.query('SELECT name, user_number, role, is_active FROM users WHERE id=?', [insert.insertId]);
            expect(stored).toEqual({ name: 'Hidden Programmer', user_number: '87654321', role: 'programmer', is_active: 1 });
        });
    });

    describe('call center is a fixed zero-permission, sectionless role', () => {
        it('rejects grants and section scope instead of silently persisting them', async () => {
            const withGrant = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Unsafe Call Center', user_number: '7401', role: 'call_center', permissions: ['pos.checkout'], allowed_sections: '' });
            expect(withGrant.statusCode).toBe(400);

            const withSection = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Scoped Call Center', user_number: '7402', role: 'call_center', permissions: [], allowed_sections: '1' });
            expect(withSection.statusCode).toBe(400);
        });

        it('creates and projects call center with no grants or sections', async () => {
            const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Phone Desk', user_number: '7403', role: 'call_center', permissions: [], allowed_sections: '' });
            expect(create.statusCode).toBe(200);

            const [[stored]] = await pool.query('SELECT role, allowed_sections FROM users WHERE id=?', [create.body.id]);
            const [[grantCount]] = await pool.query('SELECT COUNT(*) AS count FROM user_permissions WHERE user_id=?', [create.body.id]);
            expect(stored).toEqual({ role: 'call_center', allowed_sections: null });
            expect(Number(grantCount.count)).toBe(0);

            const list = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
            const projected = list.body.users.find(user => user.id === create.body.id);
            expect(projected).toMatchObject({ role: 'call_center', allowed_sections: null, permissions: [] });
        });

        it('atomically clears stale grants and sections when converting an eligible cashier', async () => {
            await pool.query("UPDATE users SET allowed_sections='1' WHERE id=?", [SEED.cashierUser.id]);
            await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.checkout')", [SEED.cashierUser.id]);

            const update = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send(await withUserEditVersion(app, adminCookie, { id: SEED.cashierUser.id, name: SEED.cashierUser.name, user_number: SEED.cashierUser.user_number, role: 'call_center', permissions: [], allowed_sections: '' }));
            expect(update.statusCode).toBe(200);

            const [[stored]] = await pool.query('SELECT role, allowed_sections FROM users WHERE id=?', [SEED.cashierUser.id]);
            const [[grantCount]] = await pool.query('SELECT COUNT(*) AS count FROM user_permissions WHERE user_id=?', [SEED.cashierUser.id]);
            expect(stored).toEqual({ role: 'call_center', allowed_sections: null });
            expect(Number(grantCount.count)).toBe(0);
        });

        it('refuses conversion while the cashier has an open shift', async () => {
            await pool.query("INSERT INTO shifts (user_id, starting_cash, status) VALUES (?, 0, 'open')", [SEED.cashierUser.id]);
            const update = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send(await withUserEditVersion(app, adminCookie, { id: SEED.cashierUser.id, name: SEED.cashierUser.name, user_number: SEED.cashierUser.user_number, role: 'call_center', permissions: [], allowed_sections: '' }));
            expect(update.statusCode).toBe(409);
            expect(update.body.message).toMatch(/close.*shift/i);

            const [[stored]] = await pool.query('SELECT role FROM users WHERE id=?', [SEED.cashierUser.id]);
            expect(stored.role).toBe('cashier');
        });
    });

    describe('PUT requires a valid id (fixes failed-create mode-flip data loss)', () => {
        it('rejects PUT with a null id', async () => {
            const res = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send(await withUserEditVersion(app, adminCookie, { id: null, name: 'Ghost', user_number: '7301', role: 'cashier' }));
            expect(res.statusCode).toBe(400);
        });
        it('rejects PUT with a non-numeric id', async () => {
            const res = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send(await withUserEditVersion(app, adminCookie, { id: 'abc', name: 'Ghost', user_number: '7302', role: 'cashier' }));
            expect(res.statusCode).toBe(400);
        });
        it('updates a real user', async () => {
            const res = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send(await withUserEditVersion(app, adminCookie, { id: SEED.cashierUser.id, name: 'Renamed', user_number: SEED.cashierUser.user_number, role: 'cashier', permissions: [], allowed_sections: '' }));
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('releases the user held-order lease during a role change and notifies open boards', async () => {
            const [insert] = await pool.query(
                `INSERT INTO held_orders
                    (user_id, reference_name, cart_data, subtotal, version, claimed_by_user_id, claim_token_hash, claim_expires_at)
                 VALUES (?, 'role-change-claim', '{"items":[]}', 0, 4, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
                [SEED.cashierUser.id, SEED.cashierUser.id, 'f'.repeat(64)]
            );
            const emit = vi.fn();
            const to = vi.spyOn(io, 'to').mockReturnValue({ emit });
            try {
                const res = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                    .send(await withUserEditVersion(app, adminCookie, { id: SEED.cashierUser.id, name: 'Renamed', user_number: SEED.cashierUser.user_number, role: 'call_center', permissions: [], allowed_sections: '' }));
                expect(res.statusCode).toBe(200);
                const [[row]] = await pool.query(
                    'SELECT version, claimed_by_user_id, claim_token_hash, claim_expires_at FROM held_orders WHERE id=?',
                    [insert.insertId]
                );
                expect(row).toMatchObject({ version: 5, claimed_by_user_id: null, claim_token_hash: null, claim_expires_at: null });
                expect(to).toHaveBeenCalledWith('staff');
                expect(emit).toHaveBeenCalledWith('held_orders_changed', { action: 'cleared', held_order_id: null, table_id: null, parent_invoice_id: null });
            } finally {
                to.mockRestore();
            }
        });

        it('releases an active held claim when hold authority is revoked without a role change', async () => {
            const [insert] = await pool.query(
                `INSERT INTO held_orders
                    (user_id, reference_name, cart_data, subtotal, version, claimed_by_user_id, claim_token_hash, claim_expires_at)
                 VALUES (?, 'profile-only-claim', '{"items":[]}', 0, 4, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
                [SEED.cashierUser.id, SEED.cashierUser.id, 'e'.repeat(64)]
            );
            await pool.query(
                "INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.hold_orders')",
                [SEED.cashierUser.id]
            );
            const [currentGrants] = await pool.query(
                'SELECT perm_key FROM user_permissions WHERE user_id=? ORDER BY perm_key',
                [SEED.cashierUser.id]
            );
            const emit = vi.fn();
            const to = vi.spyOn(io, 'to').mockReturnValue({ emit });

            try {
                const res = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                    .send(await withUserEditVersion(app, adminCookie, {
                        id: SEED.cashierUser.id,
                        name: 'Renamed',
                        user_number: SEED.cashierUser.user_number,
                        role: 'cashier',
                        permissions: currentGrants.map(row => row.perm_key).filter(key => key !== 'pos.hold_orders'),
                        allowed_sections: ''
                    }));
                expect(res.statusCode).toBe(200);

                const [[row]] = await pool.query(
                    'SELECT version, claimed_by_user_id, claim_token_hash, claim_expires_at FROM held_orders WHERE id=?',
                    [insert.insertId]
                );
                expect(row).toMatchObject({ version: 5, claimed_by_user_id: null, claim_token_hash: null, claim_expires_at: null });
                expect(to).toHaveBeenCalledWith('staff');
                expect(emit).toHaveBeenCalledWith('held_orders_changed', { action: 'cleared', held_order_id: null, table_id: null, parent_invoice_id: null });
            } finally {
                to.mockRestore();
            }
        });

        it('does not interrupt an active held-order edit for a profile-only update', async () => {
            const [insert] = await pool.query(
                `INSERT INTO held_orders
                    (user_id, reference_name, cart_data, subtotal, version, claimed_by_user_id, claim_token_hash, claim_expires_at)
                 VALUES (?, 'profile-only-claim', '{"items":[]}', 0, 4, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
                [SEED.cashierUser.id, SEED.cashierUser.id, 'e'.repeat(64)]
            );
            await pool.query(
                "INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.hold_orders')",
                [SEED.cashierUser.id]
            );
            const [currentGrants] = await pool.query(
                'SELECT perm_key FROM user_permissions WHERE user_id=? ORDER BY perm_key',
                [SEED.cashierUser.id]
            );

            const res = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send(await withUserEditVersion(app, adminCookie, { id: SEED.cashierUser.id, name: 'Renamed', user_number: SEED.cashierUser.user_number, role: 'cashier', permissions: currentGrants.map(row => row.perm_key), allowed_sections: '' }));
            expect(res.statusCode).toBe(200);

            const [[row]] = await pool.query(
                'SELECT version, claimed_by_user_id, claim_token_hash FROM held_orders WHERE id=?',
                [insert.insertId]
            );
            expect(row).toMatchObject({
                version: 4,
                claimed_by_user_id: SEED.cashierUser.id,
                claim_token_hash: 'e'.repeat(64)
            });
        });

        it('does not release an active claim when unrelated grants change but hold authority remains', async () => {
            const [insert] = await pool.query(
                `INSERT INTO held_orders
                    (user_id, reference_name, cart_data, subtotal, version, claimed_by_user_id, claim_token_hash, claim_expires_at)
                 VALUES (?, 'unrelated-grant-claim', '{"items":[]}', 0, 4, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
                [SEED.cashierUser.id, SEED.cashierUser.id, 'g'.repeat(64)]
            );
            await pool.query(
                "INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.hold_orders'), (?, 'orders.view')",
                [SEED.cashierUser.id, SEED.cashierUser.id]
            );
            const [currentGrants] = await pool.query(
                'SELECT perm_key FROM user_permissions WHERE user_id=? ORDER BY perm_key',
                [SEED.cashierUser.id]
            );

            const res = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send(await withUserEditVersion(app, adminCookie, { id: SEED.cashierUser.id, name: SEED.cashierUser.name, user_number: SEED.cashierUser.user_number, role: 'cashier', permissions: currentGrants.map(row => row.perm_key).filter(key => key !== 'orders.view'), allowed_sections: '' }));
            expect(res.statusCode).toBe(200);

            const [[row]] = await pool.query(
                'SELECT version, claimed_by_user_id, claim_token_hash FROM held_orders WHERE id=?',
                [insert.insertId]
            );
            expect(row).toMatchObject({
                version: 4,
                claimed_by_user_id: SEED.cashierUser.id,
                claim_token_hash: 'g'.repeat(64)
            });
        });
    });

    describe('DELETE validates id; unsupported methods return 405', () => {
        it('rejects DELETE with a non-numeric id', async () => {
            const res = await request(app).delete('/api/admin/users').set('Cookie', adminCookie).send({ id: 'abc' });
            expect(res.statusCode).toBe(400);
        });
        it('returns 404 when deactivating a non-existent user', async () => {
            const res = await request(app).delete('/api/admin/users').set('Cookie', adminCookie).send({ id: 99999 });
            expect(res.statusCode).toBe(404);
        });
        it('deactivates a real user', async () => {
            const res = await request(app).delete('/api/admin/users').set('Cookie', adminCookie).send({ id: SEED.cashierUser.id });
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('releases an active held-order claim before deactivation', async () => {
            const [insert] = await pool.query(
                `INSERT INTO held_orders
                    (user_id, reference_name, cart_data, subtotal, version, claimed_by_user_id, claim_token_hash, claim_expires_at)
                 VALUES (?, 'deactivation-claim', '{"items":[]}', 0, 8, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
                [SEED.cashierUser.id, SEED.cashierUser.id, 'd'.repeat(64)]
            );

            const res = await request(app).delete('/api/admin/users').set('Cookie', adminCookie)
                .send({ id: SEED.cashierUser.id });
            expect(res.statusCode).toBe(200);

            const [[row]] = await pool.query(
                'SELECT version, claimed_by_user_id, claim_token_hash, claim_expires_at FROM held_orders WHERE id=?',
                [insert.insertId]
            );
            expect(row).toMatchObject({
                version: 9,
                claimed_by_user_id: null,
                claim_token_hash: null,
                claim_expires_at: null
            });
        });
        it('still blocks deleting the primary admin (403)', async () => {
            const res = await request(app).delete('/api/admin/users').set('Cookie', adminCookie).send({ id: 1 });
            expect(res.statusCode).toBe(403);
        });
        it('returns 405 for an unsupported method (PATCH)', async () => {
            const res = await request(app).patch('/api/admin/users').set('Cookie', adminCookie).send({});
            expect(res.statusCode).toBe(405);
        });
    });

    // <-- append new describe blocks above this line
});
