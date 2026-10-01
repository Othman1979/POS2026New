const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { loginSeedUser } = require('../helpers/auth');

describe('GET /api/admin/alerts', () => {
    let adminCookie;
    let querySpy;

    beforeEach(async () => {
        await seedDatabase();
        adminCookie = await loginSeedUser(request, app, 'adminUser');
    });

    afterEach(() => {
        querySpy?.mockRestore();
        querySpy = null;
    });

    async function setSetting(key, value) {
        await pool.query(
            `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
            [key, value]
        );
    }

    async function getAlerts() {
        return request(app).get('/api/admin/alerts').set('Cookie', adminCookie);
    }

    it('preserves zero as a valid low-stock threshold', async () => {
        await setSetting('stock_enabled', '1');
        await setSetting('low_stock_threshold', '0');
        await pool.query('UPDATE products SET stock = NULL');
        await pool.query('UPDATE products SET stock = 0 WHERE id = ?', [SEED.product1.id]);
        await pool.query('UPDATE products SET stock = 1 WHERE id = ?', [SEED.product2.id]);

        const response = await getAlerts();

        expect(response.status).toBe(200);
        expect(response.body.lowStockItems.map(item => item.id)).toEqual([SEED.product1.id]);
    });

    it('reads both alert settings with one parameterized query', async () => {
        await setSetting('stock_enabled', '1');
        await setSetting('low_stock_threshold', '3');
        const originalQuery = pool.query.bind(pool);
        querySpy = vi.spyOn(pool, 'query').mockImplementation((sql, values) => originalQuery(sql, values));

        const response = await getAlerts();
        expect(response.status).toBe(200);
        const settingsCalls = querySpy.mock.calls.filter(([sql, values]) =>
            String(sql).includes('FROM settings')
            && Array.isArray(values)
            && values.includes('stock_enabled')
            && values.includes('low_stock_threshold'));
        expect(settingsCalls).toHaveLength(1);
        expect(settingsCalls[0][0]).toMatch(/IN\s*\(\s*\?\s*,\s*\?\s*\)/i);
    });

    it('skips the product query when stock alerts are disabled', async () => {
        await setSetting('stock_enabled', '0');
        const originalQuery = pool.query.bind(pool);
        querySpy = vi.spyOn(pool, 'query').mockImplementation((sql, values) => originalQuery(sql, values));

        const response = await getAlerts();
        expect(response.status).toBe(200);
        expect(response.body.lowStockItems).toEqual([]);
        const settingsCalls = querySpy.mock.calls.filter(([sql]) => String(sql).includes('FROM settings'));
        const productCalls = querySpy.mock.calls.filter(([sql]) => String(sql).includes('FROM products'));
        expect(settingsCalls).toHaveLength(1);
        expect(productCalls).toHaveLength(0);
    });

    it.each([
        ['missing', null],
        ['blank', ''],
        ['whitespace', '   '],
        ['non-numeric', 'not-a-number']
    ])('falls back to three for a %s threshold row', async (_label, value) => {
        await setSetting('stock_enabled', '1');
        if (value === null) {
            await pool.query("DELETE FROM settings WHERE setting_key = 'low_stock_threshold'");
        } else {
            await setSetting('low_stock_threshold', value);
        }
        await pool.query('UPDATE products SET stock = NULL');
        await pool.query('UPDATE products SET stock = 3 WHERE id = ?', [SEED.product1.id]);
        await pool.query('UPDATE products SET stock = 4 WHERE id = ?', [SEED.product2.id]);

        const response = await getAlerts();
        expect(response.status).toBe(200);
        expect(response.body.lowStockItems.map(item => item.id)).toEqual([SEED.product1.id]);
    });

    it('binds a valid fractional threshold without truncating it', async () => {
        await setSetting('stock_enabled', '1');
        await setSetting('low_stock_threshold', '2.5');
        const originalQuery = pool.query.bind(pool);
        querySpy = vi.spyOn(pool, 'query').mockImplementation((sql, values) => originalQuery(sql, values));

        const response = await getAlerts();
        expect(response.status).toBe(200);
        const productCall = querySpy.mock.calls.find(([sql]) => String(sql).includes('FROM products'));
        expect(productCall[1]).toEqual([2.5]);
    });
});
