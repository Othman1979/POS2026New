const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const reads = require('../../services/StockReadService');

// The Stock levels list: every stock-tracked item (simple product, linked product, ingredient).
describe('Stock levels list', () => {
    let adminCookie, cashierCookie, category;
    const setting = (key, value) => pool.query('UPDATE settings SET setting_value=? WHERE setting_key=?', [value, key]);
    beforeEach(async () => {
        await seedDatabase();
        adminCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        cashierCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
        await setting('stock_enabled', '1');
        await setting('recipe_ledger_enabled', '1');
        category = (await pool.query("INSERT INTO categories(name,is_notes) VALUES ('ZZ shelf',0)"))[0].insertId;
    });
    afterAll(() => pool.end());
    const get = query => request(app).get('/api/admin/stock/items').query(query || {}).set('Cookie', adminCookie);
    const names = response => response.body.items.map(row => row.name);
    const product = async (name, stock = 10, barcode = null) => (await pool.query(
        'INSERT INTO products(name,price,stock,category_id,barcode,is_active) VALUES (?,1,?,?,?,1)', [name, stock, category, barcode]))[0].insertId;
    const ingredient = async (name, known = 1, quantity = 5, par = null) => (await pool.query(
        "INSERT INTO ingredients(name,measure,display_unit,par_qty,working_quantity,working_quantity_known,is_active) VALUES (?,'weight','g',?,?,?,1)",
        [name, par, quantity, known]))[0].insertId;
    async function linked(name, quantity, known = 1) {
        const id = await product(name, 0);
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES (?,'count','unit','active')", [name + ' item']);
        if (quantity != null) await pool.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known) VALUES (?,?,?)', [item.insertId, quantity, known]);
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)', [id, item.insertId]);
        return id;
    }
    async function seedMix() {
        const ids = {
            simple: await product('ZZ simple', 10, '7700001'),
            linked: await linked('ZZ linked', '4.5'),
            flour: await ingredient('ZZ flour', 1, 8),
        };
        await product('ZZ unlimited', null);
        return ids;
    }

    test('lists simple, linked and ingredient items together, without unlimited products', async () => {
        const ids = await seedMix();
        const response = await get({ q: 'ZZ' });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(names(response)).toEqual(['ZZ flour', 'ZZ linked', 'ZZ simple']);
        const byKey = new Map(response.body.items.map(row => [row.item_key, row]));
        expect(byKey.get(`product:${ids.simple}`)).toMatchObject({ kind: 'product', quantity: '10.000000', quantity_known: true, group_label: 'ZZ shelf', base_unit: 'unit', attention: 'ok' });
        expect(byKey.get(`product:${ids.linked}`)).toMatchObject({ kind: 'product', quantity: '4.500000', quantity_known: true, attention: 'ok' });
        expect(byKey.get(`ingredient:${ids.flour}`)).toMatchObject({ kind: 'ingredient', quantity: '8.000000', base_unit: 'g', display_unit: 'g', group_label: 'Ingredients' });
        expect(response.body).toMatchObject({ limit: 50, has_more: false, next_cursor: null });
    });

    test('returns a large ingredient balance exactly', async () => {
        await ingredient('ZZ big', 1, '123456789012.5');
        const response = await get({ q: 'ZZ big' });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body.items[0]).toMatchObject({ quantity: '123456789012.500000', quantity_known: true });
    });

    test('a turned-off flag hides its kind', async () => {
        await seedMix();
        await setting('stock_enabled', '0');
        expect(names(await get({ q: 'ZZ' }))).toEqual(['ZZ flour']);
        await setting('stock_enabled', '1');
        await setting('recipe_ledger_enabled', '0');
        expect(names(await get({ q: 'ZZ' }))).toEqual(['ZZ linked', 'ZZ simple']);
    });

    test('attention: unknown, negative, low and ok per kind', async () => {
        await setting('low_stock_threshold', '3');
        await product('ZZ p-neg', -1);
        await product('ZZ p-low', 3);
        await product('ZZ p-zero', 0);
        await linked('ZZ p-unknown', null);
        await linked('ZZ p-unknown2', '7', 0);
        await ingredient('ZZ i-unknown', 0, 0);
        await ingredient('ZZ i-neg', 1, -2, 10);
        await ingredient('ZZ i-low', 1, 4, 10);
        await ingredient('ZZ i-ok', 1, 10, 10);
        await ingredient('ZZ i-nopar', 1, 1, null);
        const by = async query => Object.fromEntries((await get({ q: 'ZZ', ...query })).body.items.map(row => [row.name, row.attention]));
        expect(await by()).toEqual({
            'ZZ p-neg': 'negative', 'ZZ p-low': 'low', 'ZZ p-zero': 'negative', 'ZZ p-unknown': 'unknown', 'ZZ p-unknown2': 'unknown',
            'ZZ i-unknown': 'unknown', 'ZZ i-neg': 'negative', 'ZZ i-low': 'low', 'ZZ i-ok': 'ok', 'ZZ i-nopar': 'ok',
        });
        const unknown = (await get({ q: 'ZZ', attention: 'unknown' })).body.items;
        expect(unknown.map(row => row.name)).toEqual(['ZZ i-unknown', 'ZZ p-unknown', 'ZZ p-unknown2']);
        expect(unknown.every(row => row.quantity === null && row.quantity_known === false)).toBe(true);
        expect(Object.keys(await by({ attention: 'low' }))).toEqual(['ZZ i-low', 'ZZ p-low']);
        expect(Object.keys(await by({ attention: 'negative' }))).toEqual(['ZZ i-neg', 'ZZ p-neg', 'ZZ p-zero']);
        expect((await get({ attention: 'inactive' })).status).toBe(400);
    });

    test('finds a product by an extra barcode typed exactly', async () => {
        const ids = await seedMix();
        await pool.query("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, '7700002'), (?, '7700003')", [ids.simple, ids.linked]);
        expect(names(await get({ q: '7700002' }))).toEqual(['ZZ simple']);
        expect(names(await get({ q: '7700003' }))).toEqual(['ZZ linked']);
        expect(names(await get({ q: '770000' }))).toEqual([]);
        expect(names(await get({ q: '7700002', kind: 'ingredient' }))).toEqual([]);
    });

    test('searches by name prefix and product barcode, and filters by kind', async () => {
        await seedMix();
        expect(names(await get({ q: 'ZZ s' }))).toEqual(['ZZ simple']);
        expect(names(await get({ q: '7700001' }))).toEqual(['ZZ simple']);
        expect(names(await get({ q: 'ZZ', kind: 'ingredient' }))).toEqual(['ZZ flour']);
        expect(names(await get({ q: 'ZZ', kind: 'product' }))).toEqual(['ZZ linked', 'ZZ simple']);
        expect((await get({ kind: 'prepared' })).status).toBe(400);
        expect((await get({ status: 'all' })).status).toBe(400);
        expect((await get({ day: '2026-09-08' })).status).toBe(400);
    });

    test('pages across both kinds with a filter-bound cursor, equal names included', async () => {
        for (let i = 0; i < 7; i++) await product(`ZZ item ${i}`, 5);
        for (let i = 0; i < 7; i++) await ingredient(`ZZ item ${i}`, 1, 5);
        await product('ZZ same', 5); await ingredient('ZZ same', 1, 5); await product('ZZ same', 5);
        const seen = []; let cursor;
        do {
            const response = await get({ limit: '4', q: 'ZZ', ...(cursor ? { cursor } : {}) });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            expect(response.body.items.length).toBeLessThanOrEqual(4);
            seen.push(...response.body.items.map(row => row.item_key));
            cursor = response.body.next_cursor;
            if (cursor) {
                expect((await get({ cursor, q: 'ZZ', kind: 'product' })).status).toBe(400);
                expect((await get({ cursor, q: 'Different' })).status).toBe(400);
            }
        } while (cursor);
        expect(seen).toHaveLength(17);
        expect(new Set(seen).size).toBe(17);
        expect((await get({ limit: '101' })).status).toBe(400);
        expect((await get({ cursor: 'broken' })).status).toBe(400);
    });

    test('is admin only', async () => {
        const forbidden = await request(app).get('/api/admin/stock/items').set('Cookie', cashierCookie);
        expect(forbidden.status).toBe(403);
    });

    test('runs a constant number of statements per page, with no history or count scans', async () => {
        for (let i = 0; i < 30; i++) await product(`ZZ bulk ${String(i).padStart(2, '0')}`, 5);
        for (let i = 0; i < 30; i++) await ingredient(`ZZ bulk ${String(i).padStart(2, '0')}b`, 1, 5);
        const calls = [];
        const connection = { query(sql, args) { calls.push(sql); return pool.query(sql, args); } };
        const page = await reads.list(connection, { limit: '10', q: 'ZZ bulk' });
        expect(page.items).toHaveLength(10);
        expect(page.has_more).toBe(true);
        expect(calls).toHaveLength(3);
        expect(calls.some(sql => /stock_movements|OFFSET/i.test(sql))).toBe(false);
    });
});
