const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const cache = require('../../config/cache');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('checkout post-commit effects', () => {
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
        cache.invalidateCatalogCache.mockRestore?.();
        cache.invalidateDashboardCache.mockRestore?.();
        logger.error.mockRestore?.();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('returns success when inventory broadcasting fails after commit', async () => {
        const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        global.__mockEmit__.mockImplementation(event => {
            if (event === 'inventory_changed') throw new Error('socket unavailable');
        });

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 10,
                change_due: 4.2,
                idempotency_key: 'checkout-post-commit-broadcast'
            });

        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);
        const [[order]] = await pool.query(
            'SELECT invoice_id, payment_method FROM orders WHERE invoice_id = ?',
            [response.body.invoice_id]
        );
        expect(order).toMatchObject({ payment_method: 'cash' });
        // The stock notification runs off the response path and logs its own failure.
        await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.objectContaining({ message: 'socket unavailable' }), invoiceId: order.invoice_id, route: '/api/pos/checkout' }),
            'Stock event emit failed.'
        ));
    });

    it('clears the catalog when settling a table restores saved stock even though tracking is now off', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query('UPDATE products SET stock=50 WHERE id=?', [SEED.product1.id]); // a stock-tracked line
        const saved = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: 5, note: '' }],
            subtotal: 5, tax: 0.8, total: 5.8,
        });
        expect(saved.statusCode).toBe(200);
        const invoiceId = saved.body.invoice_id || saved.body.order_id;
        const [[line]] = await pool.query('SELECT id FROM order_items WHERE invoice_id=? AND product_id=?', [invoiceId, SEED.product1.id]);

        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='stock_enabled'");
        cache.invalidateCatalogCache();
        expect((await request(app).get('/api/pos/products').set('Cookie', adminCookie)).statusCode).toBe(200);
        const generation = cache.getCatalogGenerationToken();
        const paid = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: [{ id: SEED.product1.id, order_item_id: line.id, qty: 1, price: 5, tax_rate: 16 }],
            edit_invoice_id: invoiceId, table_id: SEED.table.id,
            subtotal: 5, tax: 0.8, total: 5.8,
            payment_method: 'cash', amount_tendered: 10, change_due: 4.2,
            order_discount_type: null, order_discount_value: 0,
            idempotency_key: 'checkout-post-commit-saved-stock-restore',
        });
        expect(paid.statusCode).toBe(200);
        // Settling restored the saved (stock-tracked) quantity into products.stock.
        expect(cache.getCatalogGenerationToken()).not.toBe(generation);
    });

    it('keeps the catalog cache and generation when stock tracking is off', async () => {
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='stock_enabled'");
        const warm = await request(app).get('/api/pos/products').set('Cookie', adminCookie);
        expect(warm.statusCode).toBe(200);
        const generation = cache.getCatalogGenerationToken();

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                subtotal: 5, tax: 0.8, total: 5.8,
                payment_method: 'cash', amount_tendered: 10, change_due: 4.2,
                idempotency_key: 'checkout-post-commit-stock-off'
            });

        expect(response.statusCode).toBe(200);
        expect(cache.getCatalogGenerationToken()).toBe(generation);
        expect(cache.getCachedCatalog()).toBeTruthy();
    });

    it('invalidates the catalog before announcing a stock change', async () => {
        const effects = [];
        vi.spyOn(cache, 'invalidateCatalogCache').mockImplementation(() => {
            effects.push('catalog');
        });
        global.__mockEmit__.mockImplementation(event => {
            if (event === 'inventory_changed') effects.push('inventory');
        });

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 10,
                change_due: 4.2,
                idempotency_key: 'checkout-post-commit-cache-order'
            });

        expect(response.statusCode).toBe(200);
        await vi.waitFor(() => expect(effects).toEqual(['catalog', 'inventory']));
    });

    it('returns success and keeps the order when both cache invalidators fail after commit', async () => {
        const invalidatorOrder = [];
        const catalogError = new Error('catalog cache unavailable');
        const dashboardError = new Error('dashboard cache unavailable');
        vi.spyOn(cache, 'invalidateCatalogCache').mockImplementation(() => {
            invalidatorOrder.push('catalog');
            throw catalogError;
        });
        vi.spyOn(cache, 'invalidateDashboardCache').mockImplementation(() => {
            invalidatorOrder.push('dashboard');
            throw dashboardError;
        });
        const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 10,
                change_due: 4.2,
                idempotency_key: 'checkout-post-commit-cache'
            });

        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);
        const [[order]] = await pool.query(
            'SELECT invoice_id, payment_method FROM orders WHERE idempotency_key = ?',
            ['checkout-post-commit-cache']
        );
        expect(order).toMatchObject({ payment_method: 'cash' });
        expect(invalidatorOrder).toEqual(['catalog', 'dashboard']);
        expect(logSpy).toHaveBeenCalledWith(
            { err: catalogError, invoiceId: order.invoice_id },
            'Checkout catalog cache invalidation failed after commit.'
        );
        expect(logSpy).toHaveBeenCalledWith(
            { err: dashboardError, invoiceId: order.invoice_id },
            'Checkout dashboard cache invalidation failed after commit.'
        );
    });

    it('prepares the automatic JoFotara document after the checkout transaction commits', async () => {
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MINUTE), '%Y-%m-%d %H:%i:%s')
            WHEN 'jofotara_sales_tax_client_id' THEN 'client' WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 10, change_due: 4.2,
                idempotency_key: 'checkout-post-commit-jofotara'
            });
        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.jofotara).toMatchObject({ required: true, status: 'pending' });
        const [[document]] = await pool.query('SELECT status FROM jofotara_documents WHERE source_key=?', [`invoice:${response.body.invoice_id}`]);
        expect(document.status).toBe('pending');
    });

    it('keeps the paid order when automatic JoFotara preparation fails after commit', async () => {
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MINUTE), '%Y-%m-%d %H:%i:%s')
            ELSE setting_value END WHERE setting_key IN ('jofotara_enabled', 'jofotara_auto_submit', 'jofotara_auto_submit_since')`);

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 10, change_due: 4.2,
                idempotency_key: 'checkout-post-commit-jofotara-failure'
            });

        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            jofotara: { required: true, status: 'preparation_failed', code: 'JOFOTARA_SELLER_INCOMPLETE' }
        });
        const [[order]] = await pool.query(
            'SELECT invoice_id, payment_method FROM orders WHERE idempotency_key=?',
            ['checkout-post-commit-jofotara-failure']
        );
        expect(order).toMatchObject({ payment_method: 'cash' });
    });
});
