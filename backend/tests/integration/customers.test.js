// customers.test.js — Integration tests for the admin Customers CRUD route
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Admin Customers Route', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    describe('Method guarding', () => {
        it('returns 405 for unsupported methods (PATCH)', async () => {
            const res = await request(app)
                .patch('/api/admin/customers')
                .set('Cookie', adminCookie)
                .send({});
            expect(res.statusCode).toBe(405);
            expect(res.body.success).toBe(false);
        });
    });

    describe('Input validation', () => {
        const create = (body) =>
            request(app).post('/api/admin/customers').set('Cookie', adminCookie).send(body);
        const update = (body) =>
            request(app).put('/api/admin/customers').set('Cookie', adminCookie).send(body);

        it('rejects deletion cleanly when a checkout commits after deletion begins', async () => {
            const created = await create({ name: 'Concurrent buyer', phone: '0799990011' });
            let enteredDelete, releaseDelete;
            const entered = new Promise(resolve => { enteredDelete = resolve; });
            const gate = new Promise(resolve => { releaseDelete = resolve; });
            const originalQuery = pool.query.bind(pool);
            const spy = vi.spyOn(pool, 'query').mockImplementation(async (sql, params) => {
                if (String(sql).startsWith('DELETE FROM customers')) {
                    enteredDelete();
                    await gate;
                }
                return originalQuery(sql, params);
            });
            let deleting;
            try {
                deleting = request(app).delete('/api/admin/customers').set('Cookie', adminCookie)
                    .send({ id: created.body.id }).then(result => result);
                await entered;
                const sale = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
                    cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                    subtotal: 2, tax: 0, total: 2, payment_method: 'cash', amount_tendered: 2, change_due: 0,
                    customer_name: 'Concurrent buyer', customer_phone: '0799990011', idempotency_key: 'customer-delete-race',
                });
                expect(sale.statusCode, JSON.stringify(sale.body)).toBe(200);
                releaseDelete();
                expect((await deleting).statusCode).toBe(400);
                const [[saved]] = await pool.query('SELECT customer_id FROM orders WHERE invoice_id=?', [sale.body.invoice_id]);
                expect(Number(saved.customer_id)).toBe(created.body.id);
                const [[buyer]] = await pool.query('SELECT id FROM customers WHERE id=?', [created.body.id]);
                expect(buyer.id).toBe(created.body.id);
            } finally {
                releaseDelete();
                if (deleting) await deleting;
                spy.mockRestore();
            }
        });

        it('deletes an unreferenced customer successfully', async () => {
            const created = await create({ name: 'Unused buyer', phone: '0799990022' });
            const result = await request(app).delete('/api/admin/customers').set('Cookie', adminCookie)
                .send({ id: created.body.id });
            expect(result.statusCode).toBe(200);
            const [rows] = await pool.query('SELECT id FROM customers WHERE id=?', [created.body.id]);
            expect(rows).toHaveLength(0);
        });

        it('rejects POST with missing name', async () => {
            const res = await create({ phone: '0790000001', address: 'x' });
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('rejects POST with missing phone', async () => {
            const res = await create({ name: 'No Phone', address: 'x' });
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('trims fields and treats whitespace-padded phone as duplicate', async () => {
            const first = await create({ name: 'Ann', phone: '0790000009' });
            expect(first.statusCode).toBe(200);

            const dup = await create({ name: 'Bob', phone: '  0790000009  ' });
            expect(dup.statusCode).toBe(400);
            expect(dup.body.success).toBe(false);
        });

        it('stores canonical digits and rejects differently formatted duplicates', async () => {
            const first = await create({ name: 'Formatted', phone: '+962 (79) 000-0029' });
            expect(first.statusCode).toBe(200);

            const [[stored]] = await pool.query('SELECT phone FROM customers WHERE id = ?', [first.body.id]);
            expect(stored.phone).toBe('962790000029');

            const duplicate = await create({ name: 'Duplicate', phone: '962790000029' });
            expect(duplicate.statusCode).toBe(400);
            expect(duplicate.body.success).toBe(false);
        });

        it('serializes simultaneous formatted creates for the same phone', async () => {
            const responses = await Promise.all([
                create({ name: 'First', phone: '+962 79 000 0039' }),
                create({ name: 'Second', phone: '962790000039' })
            ]);
            expect(responses.map(response => response.statusCode).sort()).toEqual([200, 400]);

            const [[count]] = await pool.query(
                'SELECT COUNT(*) AS total FROM customers WHERE phone_normalized = ?',
                ['962790000039']
            );
            expect(Number(count.total)).toBe(1);
        });

        it('does not wait for the same customer lock held in another database', async () => {
            const foreign = await pool.getConnection();
            await foreign.query('USE information_schema');
            const originalGet = pool.getConnection.bind(pool);
            const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
                const conn = await originalGet();
                const originalQuery = conn.query;
                conn.query = async function (sql, params) {
                    if (String(sql).includes('GET_LOCK')) {
                        const [[held]] = await foreign.query(sql, params);
                        expect(Number(held.acquired)).toBe(1);
                    }
                    return originalQuery.call(this, sql, params);
                };
                const release = conn.release;
                conn.release = function () {
                    conn.query = originalQuery;
                    conn.release = release;
                    return release.call(this);
                };
                return conn;
            });
            try {
                const result = await create({ name: 'Independent tenant', phone: '0790000059' });
                expect(result.statusCode).toBe(200);
            } finally {
                spy.mockRestore();
                // Closing the session releases its locks and changed database.
                foreign.destroy();
            }
        });

        it('rejects a formatted update that collides after normalization', async () => {
            const first = await create({ name: 'First', phone: '0790000041' });
            const second = await create({ name: 'Second', phone: '0790000042' });
            expect(first.statusCode).toBe(200);
            expect(second.statusCode).toBe(200);

            const collision = await update({
                id: second.body.id,
                name: 'Second',
                phone: '079 000-0041'
            });
            expect(collision.statusCode).toBe(400);
            expect(collision.body.success).toBe(false);
        });

        it('rejects PUT with no id', async () => {
            const res = await update({ name: 'X', phone: '0790000010' });
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('rejects PUT with missing name', async () => {
            const created = await create({ name: 'Cara', phone: '0790000011' });
            const res = await update({ id: created.body.id, phone: '0790000011' });
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });
    });
});
