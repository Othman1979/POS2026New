const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const cache = require('../../config/cache');
const { generateStaticMenu } = require('../../config/menuCache');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('settings save invalidation scope', () => {
    let cookie;
    beforeAll(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        await generateStaticMenu();
    });
    afterAll(() => pool.end());

    it.each([
        [{ order_type_numbering: '1' }, false, false, false],
        [{ print_method: 'backend', duplicate_customer_receipt: '0' }, false, false, false],
        [{}, false, false, false],
        [{ service_charge_percentage: '12' }, true, false, false],
        [{ tables_enabled: '1' }, true, true, false],
        [{ recipe_ledger_enabled: '1' }, true, true, false],
        [{ low_stock_threshold: '5' }, false, true, false],
        [{ store_name: 'Scoped settings fixture' }, false, false, true],
    ])('preserves unrelated caches for %j', async (body, catalogChanged, dashboardChanged, menuChanged) => {
        const catalogGeneration = cache.getCatalogCacheGeneration();
        const dashboardGeneration = cache.getDashboardCacheGeneration();
        const queries = vi.spyOn(pool, 'query');
        try {
            const res = await request(app).post('/api/system/settings').set('Cookie', cookie).send(body);
            expect(res.status).toBe(200);
            expect(cache.getCatalogCacheGeneration() > catalogGeneration).toBe(catalogChanged);
            expect(cache.getDashboardCacheGeneration() > dashboardGeneration).toBe(dashboardChanged);
            // Detect the actual menu-builder read, not a mocked invalidation call.
            const menuReads = queries.mock.calls.filter(([sql, params]) => String(sql).startsWith('SELECT setting_key')
                && Array.isArray(params) && ['store_name', 'store_address', 'store_phone', 'admin_language'].every(key => params.includes(key)));
            expect(menuReads.length > 0).toBe(menuChanged);
        } finally {
            queries.mockRestore();
            // Drain background rebuilds before the next sample or pool shutdown.
            await generateStaticMenu();
        }
    });

    it('invalidates catalog metadata so the next read contains the new setting', async () => {
        const first = await request(app).get('/api/pos/products').set('Cookie', cookie);
        const old = first.body.settings.service_charge_percentage;
        const next = old === '15' ? '16' : '15';
        expect((await request(app).post('/api/system/settings').set('Cookie', cookie).send({ service_charge_percentage: next })).status).toBe(200);
        const refreshed = await request(app).get('/api/pos/products').set('Cookie', cookie).set('If-None-Match', first.headers.etag);
        expect(refreshed.status).toBe(200);
        expect(refreshed.body.settings.service_charge_percentage).toBe(next);
        await generateStaticMenu();
    });
});
