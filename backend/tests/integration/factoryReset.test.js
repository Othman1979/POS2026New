const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { loginSeedUser } = require('../helpers/auth');
const { insertShift, insertPaidOrder, insertOrderItem } = require('../helpers/fixtures');
const cache = require('../../config/cache');

describe('admin factory reset', () => {
    const testPassword = 'integration-reset-secret';
    const originalPasswordHash = process.env.MAINTENANCE_RESET_PASSWORD_HASH;
    let adminCookie;

    beforeEach(async () => {
        process.env.MAINTENANCE_RESET_PASSWORD_HASH = crypto.createHash('sha256').update(testPassword).digest('hex');
        await seedDatabase();
        adminCookie = await loginSeedUser(request, app, 'adminUser');
        const shiftId = await insertShift(pool);
        const invoiceId = await insertPaidOrder(pool, { shift_id: shiftId });
        await insertOrderItem(pool, { invoice_id: invoiceId });
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query('UPDATE products SET stock=10 WHERE id=?', [SEED.product2.id]);
        const activated = await request(app).post(`/api/admin/stock/products/${SEED.product2.id}/activate`)
            .set('Cookie', adminCookie).send({ expected_stock_version: '0', request_key: crypto.randomUUID() });
        expect(activated.status, JSON.stringify(activated.body)).toBe(200);
        await pool.query("INSERT INTO ingredients (name, measure, display_unit) VALUES ('_factory_flour', 'weight', 'kg')");
        await pool.query("INSERT INTO purchase_suppliers (name) VALUES ('Factory supplier')");
    });

    afterAll(async () => {
        if (originalPasswordHash === undefined) delete process.env.MAINTENANCE_RESET_PASSWORD_HASH;
        else process.env.MAINTENANCE_RESET_PASSWORD_HASH = originalPasswordHash;
        await pool.end();
    });

    it('rejects an invalid password without deleting anything', async () => {
        const response = await request(app).post('/api/admin/maintenance/factory-reset')
            .set('Cookie', adminCookie).send({ password: 'wrong-password' });
        expect(response.statusCode).toBe(403);
        const [[row]] = await pool.query('SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM orders) AS orders');
        expect(Number(row.products)).toBeGreaterThan(0);
        expect(Number(row.orders)).toBe(1);
    });

    it('does not allow a cashier to run it even with the maintenance password', async () => {
        const cashierCookie = await loginSeedUser(request, app, 'cashierUser');
        const response = await request(app).post('/api/admin/maintenance/factory-reset')
            .set('Cookie', cashierCookie).send({ password: testPassword });
        expect(response.statusCode).toBe(403);
        const [[row]] = await pool.query('SELECT COUNT(*) AS products FROM products');
        expect(Number(row.products)).toBeGreaterThan(0);
    });

    it('clears catalog, stock and sales while keeping users, settings and setup', async () => {
        const kept = ['users', 'user_permissions', 'settings', 'order_types', 'restaurant_tables', 'expense_categories', 'print_templates', 'schema_migrations'];
        const before = {};
        for (const table of kept) [before[table]] = await pool.query(`SELECT * FROM ${table}`);
        cache.setCachedCatalog({ stale: true }, 'stale');

        const response = await request(app).post('/api/admin/maintenance/factory-reset')
            .set('Cookie', adminCookie).send({ password: testPassword });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(response.body.summary.orders).toBe(1);
        expect(cache.getCachedCatalog()).toBeNull();

        for (const table of ['products', 'categories', 'product_barcodes', 'product_packs', 'product_stock_links', 'ingredients',
            'stock_items', 'stock_balances', 'stock_operations', 'stock_movements', 'stock_documents', 'purchase_suppliers',
            'customers', 'orders', 'order_items', 'shifts']) {
            const [[row]] = await pool.query(`SELECT COUNT(*) AS count FROM ${table}`);
            expect(Number(row.count), table).toBe(0);
        }
        const [audit] = await pool.query('SELECT event_type FROM audit_events');
        expect(audit.map(row => row.event_type)).toEqual(['factory_reset']);
        for (const table of kept) {
            const [after] = await pool.query(`SELECT * FROM ${table}`);
            expect(after, table).toEqual(before[table]);
        }
        const [[fk]] = await pool.query('SELECT @@FOREIGN_KEY_CHECKS AS on_flag');
        expect(Number(fk.on_flag)).toBe(1);

        const created = await request(app).post('/api/admin/categories').set('Cookie', adminCookie).send({ name: 'Fresh start' });
        expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    });
});
