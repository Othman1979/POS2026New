const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { deductStockForCart, restoreStockForCart } = require('../../services/InventoryService');

describe('Product stock versioning against sales', () => {
    let cookie;
    let id;
    beforeAll(async () => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        cookie = login.headers['set-cookie'][0];
    });
    beforeEach(async () => {
        const [row] = await pool.query("INSERT INTO products(name,price,stock) VALUES ('Stock concurrency',1,10)");
        id = row.insertId;
    });
    afterAll(() => pool.end());
    const read = async () => (await pool.query('SELECT stock,stock_version FROM products WHERE id=?', [id]))[0][0];
    async function sale() {
        const conn = await pool.getConnection();
        try { await conn.beginTransaction(); await deductStockForCart(conn, [{ product_id: id, qty: 1 }]); await conn.commit(); }
        catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
    }
    test.each(['mixed', 'numeric'])('deducts repeated numeric-string quantities with %s product IDs', async (ids) => {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await deductStockForCart(conn, [{ product_id: ids === 'mixed' ? String(id) : id, qty: '2' }, { product_id: id, qty: '3' }]);
            await conn.commit();
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
        expect(Number((await read()).stock)).toBe(5);
        expect(Number((await read()).stock_version)).toBe(1);
    });
    test('a stale product edit cannot overwrite sale-and-return ABA', async () => {
        const observed = await read();
        await sale();
        await restoreStockForCart(pool, [{ product_id: id, qty: 1 }]);
        expect(Number((await read()).stock)).toBe(10);
        const edit = await request(app).put('/api/admin/products').set('Cookie', cookie)
            .send({ id, stock: 20, expected_stock_version: observed.stock_version });
        expect(edit.status).toBe(409);
        expect(Number((await read()).stock)).toBe(10);
    });
    test('rejects unversioned absolute edits and accepts an observed-version edit', async () => {
        expect((await request(app).put('/api/admin/products').set('Cookie', cookie).send({ id, stock: 99 })).status).toBe(409);
        const edit = await request(app).put('/api/admin/products').set('Cookie', cookie)
            .send({ id, stock: 7, expected_stock_version: (await read()).stock_version });
        expect(edit.status, JSON.stringify(edit.body)).toBe(200);
        expect(Number((await read()).stock)).toBe(7);
    });
});
