const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const cache = require('../../config/cache');
const { invalidateDashboardCache } = cache;
const { getBusinessDate, getBusinessDateRange } = require('../../utils/businessDate');
const fs = require('node:fs');
const path = require('node:path');

describe('GET /api/admin/dashboard', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        invalidateDashboardCache();
        adminCookie = (await request(app).post('/api/auth/login')
            .send({ user_number: '9001' })).headers['set-cookie'][0];
    });

    async function fetchDashboard() {
        const response = await request(app).get('/api/admin/dashboard').set('Cookie', adminCookie);
        expect(response.status).toBe(200);
        return response.body;
    }

    async function seedOrderWithRefund({ orderTotal = 100, refundAmt = 30, method = 'cash' } = {}) {
        const [orderResult] = await pool.query(
            `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, card_amount, amount_tendered)
             VALUES (1, 1, 86.21, 13.79, ?, ?, ?, ?, ?)`,
            [
                orderTotal,
                method,
                method === 'cash' ? orderTotal : 0,
                method === 'card' ? orderTotal : 0,
                orderTotal,
            ]
        );
        const invoiceId = orderResult.insertId;

        const [itemResult] = await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
             VALUES (?, 1, 'Test Burger', 2, 50.000000, 16.00, 13.790000)`,
            [invoiceId]
        );

        if (refundAmt > 0) {
            const [refundResult] = await pool.query(
                `INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, refund_method, user_id)
                 VALUES ('refund', ?, 'order', 25.86, 4.14, ?, ?, 1)`,
                [invoiceId, refundAmt, method]
            );
            await pool.query(
                `INSERT INTO refund_items (refund_id, order_item_id, product_id, item_name, quantity, unit_price, line_subtotal, line_tax, line_total)
                 VALUES (?, ?, 1, 'Test Burger', 1, 50.000000, 25.86, 4.14, 30.00)`,
                [refundResult.insertId, itemResult.insertId]
            );
        }

        return { invoiceId, orderItemId: itemResult.insertId };
    }

    it('returns presentation-neutral current-day payload and no legacy dashboard fields', async () => {
        await seedOrderWithRefund({ orderTotal: 100, refundAmt: 30, method: 'cash' });

        const data = await fetchDashboard();

        expect(data).toMatchObject({
            success: true,
            history: expect.objectContaining({
                eligible_days: expect.any(Number),
                comparison_ready: expect.any(Boolean),
            }),
            headline: expect.objectContaining({ sales_today: 70, orders: 1, average_check: 100 }),
            pace: expect.objectContaining({ points: expect.any(Array) }),
            attention: expect.any(Array),
            products: expect.any(Array),
            payments: expect.any(Array),
        });
        expect(data).not.toHaveProperty('finance');
        expect(data).not.toHaveProperty('trend');
        expect(data).not.toHaveProperty('topItems');
    });

    it('keeps old-order refunds on refund day instead of restating original sale day', async () => {
        const { invoiceId } = await seedOrderWithRefund({ orderTotal: 100, refundAmt: 0 });
        const range = getBusinessDateRange(getBusinessDate());
        await pool.query(
            'UPDATE orders SET invoice_issued_at=DATE_SUB(?, INTERVAL 7 DAY), created_at=DATE_SUB(?, INTERVAL 7 DAY) WHERE invoice_id=?',
            [range.start, range.start, invoiceId]
        );
        await pool.query(`
            INSERT INTO refunds
              (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, refund_method, user_id, created_at)
            VALUES ('refund', ?, 'order', 20, 0, 20, 'cash', 1, ?)
        `, [invoiceId, range.start]);
        invalidateDashboardCache();

        const data = await fetchDashboard();

        expect(data.headline.sales_today).toBe(-20);
        expect(data.headline.orders).toBe(0);
    });

    it('returns full product names and net values', async () => {
        await seedOrderWithRefund({ orderTotal: 100, refundAmt: 30 });

        const data = await fetchDashboard();

        expect(data.products[0]).toMatchObject({ name: 'Test Burger', net_units: 1 });
        expect(data.products[0].name).not.toContain('...');
    });

    it('counts a paid table order by invoice time instead of its earlier save time', async () => {
        const range = getBusinessDateRange(getBusinessDate());
        await pool.query(
            `INSERT INTO orders
              (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, invoice_number, invoice_issued_at, created_at)
             VALUES (20, 1, 30, 0, 30, 'cash', 30, 13001, ?, DATE_SUB(?, INTERVAL 1 DAY))`,
            [range.start, range.start]
        );
        invalidateDashboardCache();

        const data = await fetchDashboard();

        expect(data.headline.sales_today).toBe(30);
        expect(data.headline.orders).toBe(1);
    });

    it('does not reuse cache after minute bucket or business-date rollover', () => {
        const generation = cache.getDashboardCacheGeneration();
        expect(cache.setDashboardAnalyticsCache(
            '2026-07-14:100',
            { marker: 1 },
            Date.now() + 30000,
            generation
        )).toBe(true);

        expect(cache.getDashboardAnalyticsCache('2026-07-14:100').payload.marker).toBe(1);
        expect(cache.getDashboardAnalyticsCache('2026-07-14:101')).toBeNull();
        expect(cache.getDashboardAnalyticsCache('2026-07-15:100')).toBeNull();
    });

    it('preserves zero as the dashboard low-stock threshold', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='low_stock_threshold'");
        await pool.query('UPDATE products SET stock=10 WHERE is_active=1 AND stock IS NOT NULL');
        await pool.query('UPDATE products SET stock=0 WHERE id=1');
        await pool.query('UPDATE products SET stock=1 WHERE id=2');
        invalidateDashboardCache();

        const data = await fetchDashboard();
        const stock = data.attention.find(item => item.type === 'stock');
        expect(stock?.params?.count).toBe(1);
    });

    it('falls back on corrupt thresholds and binds a valid fractional value exactly', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query('UPDATE products SET stock=NULL');
        await pool.query('UPDATE products SET stock=3 WHERE id=1');
        await pool.query('UPDATE products SET stock=4 WHERE id=2');

        for (const value of [null, '', '   ', 'not-a-number']) {
            if (value === null) {
                await pool.query("DELETE FROM settings WHERE setting_key='low_stock_threshold'");
            } else {
                await pool.query(
                    `INSERT INTO settings (setting_key, setting_value) VALUES ('low_stock_threshold', ?)
                     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`,
                    [value]
                );
            }
            invalidateDashboardCache();
            const data = await fetchDashboard();
            expect(data.attention.find(item => item.type === 'stock')?.params?.count).toBe(1);
        }

        await pool.query(
            `INSERT INTO settings (setting_key, setting_value) VALUES ('low_stock_threshold', '2.5')
             ON DUPLICATE KEY UPDATE setting_value='2.5'`
        );
        invalidateDashboardCache();
        const originalQuery = pool.query.bind(pool);
        const querySpy = vi.spyOn(pool, 'query').mockImplementation((sql, values) => originalQuery(sql, values));
        try {
            await fetchDashboard();
            const stockQuery = querySpy.mock.calls.find(([sql]) =>
                String(sql).includes('stock <= ?'));
            expect(stockQuery?.[1]).toEqual([2.5]);
        } finally {
            querySpy.mockRestore();
        }
    });

    it('rejects stale and malformed dashboard cache writes', () => {
        const buildGeneration = cache.getDashboardCacheGeneration();
        invalidateDashboardCache();
        expect(cache.setDashboardAnalyticsCache(
            'stale-build',
            { marker: 'stale' },
            Date.now() + 30000,
            buildGeneration
        )).toBe(false);
        expect(cache.getDashboardAnalyticsCache('stale-build')).toBeNull();

        for (const generation of [undefined, '1', Number.POSITIVE_INFINITY]) {
            expect(cache.setDashboardAnalyticsCache(
                'invalid-generation', {}, Date.now() + 30000, generation
            )).toBe(false);
        }
        expect(cache.getDashboardAnalyticsCache('invalid-generation')).toBeNull();
    });

    it('does not repopulate the route cache from a build invalidated in flight', async () => {
        const originalQuery = pool.query.bind(pool);
        let releaseSettings;
        let settingsReached;
        const reached = new Promise(resolve => { settingsReached = resolve; });
        let intercepted = false;
        const querySpy = vi.spyOn(pool, 'query').mockImplementation((sql, values) => {
            if (!intercepted && String(sql).includes(
                "WHERE setting_key IN ('tables_enabled','stock_enabled','low_stock_threshold')"
            )) {
                intercepted = true;
                settingsReached();
                return new Promise(resolve => { releaseSettings = async () => resolve(await originalQuery(sql, values)); });
            }
            return originalQuery(sql, values);
        });

        try {
            const responsePromise = request(app)
                .get('/api/admin/dashboard')
                .set('Cookie', adminCookie)
                .then(response => response);
            await reached;
            invalidateDashboardCache();
            await releaseSettings();
            const response = await responsePromise;
            expect(response.status).toBe(200);
            const key = `${response.body.business_date}:${Math.floor(new Date(response.body.refreshed_at).getTime() / 60000)}`;
            expect(cache.getDashboardAnalyticsCache(key)).toBeNull();
        } finally {
            querySpy.mockRestore();
        }
    });

    it('passes the captured generation as the fourth route cache-set argument', () => {
        const source = fs.readFileSync(
            path.join(process.cwd(), 'backend', 'routes', 'admin', 'dashboard.js'),
            'utf8'
        );
        const generationIndex = source.indexOf('const buildGeneration = getDashboardCacheGeneration()');
        const buildIndex = source.indexOf('buildDashboardData', generationIndex);
        expect(generationIndex).toBeGreaterThanOrEqual(0);
        expect(generationIndex).toBeLessThan(buildIndex);
        const setter = source.slice(source.indexOf('setDashboardAnalyticsCache(', buildIndex));
        expect(setter.slice(0, setter.indexOf(');'))).toContain('buildGeneration');
    });
});
