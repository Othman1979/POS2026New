const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const cache = require('../../config/cache');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('table-order post-commit effects', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        const login = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = login.headers['set-cookie'][0];
        await pool.query(
            "UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'"
        );
    });

    afterEach(() => {
        global.__mockEmit__.mockReset();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('returns success when inventory broadcasting fails after commit', async () => {
        const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        try {
            global.__mockEmit__.mockImplementation(event => {
                if (event === 'inventory_changed') throw new Error('socket unavailable');
            });

            const response = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{
                        id: SEED.product1.id,
                        product_id: SEED.product1.id,
                        name: SEED.product1.name,
                        qty: 1,
                        price: 5,
                        note: ''
                    }],
                    subtotal: 5,
                    tax: 0.8,
                    total: 5.8
                });

            expect(response.statusCode).toBe(200);
            const [[order]] = await pool.query(
                'SELECT invoice_id, payment_method FROM orders WHERE invoice_id=?',
                [response.body.invoice_id]
            );
            expect(order).toMatchObject({ payment_method: 'unpaid_table' });
            await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith(
                expect.objectContaining({ err: expect.objectContaining({ message: 'socket unavailable' }), invoiceId: order.invoice_id, route: '/api/pos/table_order', tableId: SEED.table.id }),
                'Stock event emit failed.'
            ));
        } finally {
            logSpy.mockRestore();
        }
    });

    it('clears the catalog when an edit restores saved stock even though tracking is now off', async () => {
        const line = (qty) => [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty, price: 5, note: '' }];
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query('UPDATE products SET stock=50 WHERE id=?', [SEED.product1.id]); // a stock-tracked line
        const first = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie)
            .send({ table_id: SEED.table.id, cart: line(1), subtotal: 5, tax: 0.8, total: 5.8 });
        expect(first.statusCode).toBe(200);

        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='stock_enabled'");
        cache.invalidateCatalogCache();
        expect((await request(app).get('/api/pos/products').set('Cookie', adminCookie)).statusCode).toBe(200);
        const generation = cache.getCatalogGenerationToken();
        const edit = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            current_order_id: first.body.invoice_id || first.body.order_id,
            expected_version: first.body.version,
            cart: line(2), subtotal: 10, tax: 1.6, total: 11.6,
        });
        expect(edit.statusCode).toBe(200);
        // The edit put the saved (stock-tracked) quantity back into products.stock.
        expect(cache.getCatalogGenerationToken()).not.toBe(generation);
    });

    it('clears the catalog after a save only while stock tracking is on', async () => {
        const save = () => request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: 5, note: '' }],
                subtotal: 5, tax: 0.8, total: 5.8
            });
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='stock_enabled'");
        expect((await request(app).get('/api/pos/products').set('Cookie', adminCookie)).statusCode).toBe(200);
        const generation = cache.getCatalogGenerationToken();
        expect((await save()).statusCode).toBe(200);
        expect(cache.getCatalogGenerationToken()).toBe(generation);
        expect(cache.getCachedCatalog()).toBeTruthy();

        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        cache.invalidateCatalogCache();
        expect((await request(app).get('/api/pos/products').set('Cookie', adminCookie)).statusCode).toBe(200);
        const again = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table2.id,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: 5, note: '' }],
                subtotal: 5, tax: 0.8, total: 5.8
            });
        expect(again.statusCode).toBe(200);
        expect(cache.getCachedCatalog()).toBeFalsy();
    });

    it('returns success and still broadcasts when catalog invalidation fails after commit', async () => {
        const cacheSpy = vi.spyOn(cache, 'invalidateCatalogCache').mockImplementationOnce(() => {
            throw new Error('cache unavailable');
        });
        const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        try {
            const response = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: 5, note: '' }],
                    subtotal: 5,
                    tax: 0.8,
                    total: 5.8
                });

            expect(response.statusCode).toBe(200);
            expect(cacheSpy).toHaveBeenCalledOnce();
            await vi.waitFor(() => expect(global.__mockEmit__).toHaveBeenCalledWith('inventory_changed', { scope: 'stock', productIds: [SEED.product1.id] }));
            expect(logSpy).toHaveBeenCalledWith(
                expect.objectContaining({ invoiceId: response.body.invoice_id }),
                'Table order catalog cache invalidation failed after commit.'
            );
        } finally {
            cacheSpy.mockRestore();
            logSpy.mockRestore();
        }
    });
});
