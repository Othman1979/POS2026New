// integration/bundle.admin.test.js — Bundle admin CRUD
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Bundle Admin API', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = loginRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    it('GET bundle-items returns the seeded sub-items in sort order', async () => {
        const res = await request(app)
            .get(`/api/admin/products/${SEED.bundleProduct.id}/bundle-items`)
            .set('Cookie', adminCookie);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.items).toHaveLength(2);
        expect(res.body.items[0].product_id).toBe(SEED.product1.id);
        expect(res.body.items[0].name).toBe(SEED.product1.name);
        expect(res.body.items[1].product_id).toBe(SEED.product2.id);
        expect(Number(res.body.items[0].sort_order)).toBe(0);
    });

    it('PUT replaces the sub-item set', async () => {
        const res = await request(app)
            .put(`/api/admin/products/${SEED.bundleProduct.id}/bundle-items`)
            .set('Cookie', adminCookie)
            .send({ items: [{ product_id: SEED.product2.id, qty: 3, sort_order: 0 }] });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const [rows] = await pool.query(
            "SELECT product_id, qty, sort_order FROM product_bundle_items WHERE bundle_id = ? ORDER BY sort_order",
            [SEED.bundleProduct.id]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].product_id).toBe(SEED.product2.id);
        expect(Number(rows[0].qty)).toBe(3);
    });

    it('PUT tells staff terminals to reload only the saved bundle', async () => {
        const res = await request(app)
            .put(`/api/admin/products/${SEED.bundleProduct.id}/bundle-items`)
            .set('Cookie', adminCookie)
            .send({ items: [{ product_id: SEED.product2.id, qty: 3, sort_order: 0 }] });

        expect(res.statusCode).toBe(200);
        expect(global.__mockTo__).toHaveBeenCalledWith('staff');
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'inventory_changed'))
            .toEqual([['inventory_changed', { scope: 'catalog', productIds: [SEED.bundleProduct.id] }]]);
    });

    it('PUT rejects a sub-item that is itself a bundle', async () => {
        const res = await request(app)
            .put(`/api/admin/products/${SEED.bundleProduct.id}/bundle-items`)
            .set('Cookie', adminCookie)
            .send({ items: [{ product_id: SEED.bundleProduct.id, qty: 1, sort_order: 0 }] });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(String(res.body.message)).toMatch(/bundle/i);
    });

    it('PUT on a non-bundle product is rejected', async () => {
        const res = await request(app)
            .put(`/api/admin/products/${SEED.product1.id}/bundle-items`)
            .set('Cookie', adminCookie)
            .send({ items: [{ product_id: SEED.product2.id, qty: 1, sort_order: 0 }] });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('DELETE of a product that is a sub-item returns 409', async () => {
        const res = await request(app)
            .delete('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ id: SEED.product1.id });

        expect(res.statusCode).toBe(409);
        expect(res.body.success).toBe(false);
        expect(String(res.body.message)).toMatch(/used in a bundle/i);
    });
});
