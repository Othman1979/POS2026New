const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const counts = require('../../services/StockCountService');

// A big count posts in one short transaction. The numbers printed here (wall time of the whole post and how long
// the product / ingredient rows stayed locked, first lock to commit) are loopback timings, not customer numbers.
describe('stock count at scale', () => {
    let cookie;
    const actor = { id: SEED.adminUser.id, name: SEED.adminUser.name };
    const key = () => randomUUID();
    const api = (method, path) => request(app)[method](`/api/admin/stock-counts${path}`).set('Cookie', cookie);

    async function seedItems(total) {
        const simple = Math.round(total * 0.5);
        const linked = Math.round(total * 0.1);
        const ingredients = total - simple - linked;
        const category = (await pool.query("INSERT INTO categories(name,is_notes) VALUES ('Scale',0)"))[0].insertId;
        const simpleRows = Array.from({ length: simple }, (_, i) => [`Scale simple ${String(i).padStart(4, '0')}`, 1, 10, category, 1]);
        await pool.query('INSERT INTO products(name,price,stock,category_id,cost_price) VALUES ?', [simpleRows]);
        const linkedRows = Array.from({ length: linked }, (_, i) => [`Scale linked ${String(i).padStart(4, '0')}`, 1, 20, category, 1]);
        const firstProduct = (await pool.query('INSERT INTO products(name,price,stock,category_id,cost_price) VALUES ?', [linkedRows]))[0].insertId;
        const firstItem = (await pool.query('INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ?',
            [linkedRows.map((row) => [row[0], 'count', 'unit', 'active'])]))[0].insertId;
        const itemIds = Array.from({ length: linked }, (_, i) => firstItem + i);
        await pool.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known) VALUES ?', [itemIds.map((id) => [id, 20, 1])]);
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES ?', [itemIds.map((id, i) => [firstProduct + i, id, 1])]);
        await pool.query(
            "INSERT INTO ingredients(name,measure,display_unit,unit_cost,working_quantity,working_quantity_known,working_initialized) VALUES ?",
            [Array.from({ length: ingredients }, (_, i) => [`Scale ingredient ${String(i).padStart(4, '0')}`, 'weight', 'g', 0.002, 10000, 1, 1])]);
        return { simple, linked, ingredients };
    }

    async function scenario(total) {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key IN ('stock_enabled','recipe_ledger_enabled')");
        const mix = await seedItems(total);
        const created = await api('post', '/').send({ reference: `Scale ${total}`, groups: [`category:${(await pool.query("SELECT id FROM categories WHERE name='Scale'"))[0][0].id}`, 'ingredients'], request_key: key() });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const counted = created.body.data;
        const fetchStart = Date.now();
        expect((await api('get', `/${counted.id}`)).body.data.lines).toHaveLength(counted.lines.length);
        const fetchMs = Date.now() - fetchStart;
        const lines = counted.lines.filter((line) => line.name.startsWith('Scale'));
        expect(lines.length).toBeGreaterThanOrEqual(total);
        const saveStart = Date.now();
        for (let offset = 0; offset < lines.length; offset += 100) {
            const batch = lines.slice(offset, offset + 100).map((line) => ({ id: line.id, qty: line.group_key === 'ingredients' ? '9.5' : '8', unit_label: line.group_key === 'ingredients' ? 'g' : 'unit', unit_factor: '1' }));
            const saved = await api('put', `/${counted.id}/lines`).send({ lines: batch });
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        }
        const saveMs = Date.now() - saveStart;
        const reviewStart = Date.now();
        const review = await api('get', `/${counted.id}/review`);
        expect(review.status).toBe(200);
        const reviewMs = Date.now() - reviewStart;
        const started = Date.now();
        const result = await counts.postCount(pool, { id: counted.id, body: { request_key: key() }, actor, ipAddress: null });
        const wallMs = Date.now() - started;
        expect(result.count.status).toBe('posted');
        expect(result.count.counted_count).toBe(lines.length);
        // Spot-check each kind.
        expect(Number((await pool.query("SELECT stock FROM products WHERE name='Scale simple 0000'"))[0][0].stock)).toBe(8);
        expect(Number((await pool.query("SELECT stock FROM products WHERE name='Scale linked 0000'"))[0][0].stock)).toBe(8);
        expect(Number((await pool.query("SELECT quantity FROM stock_balances b JOIN stock_items s ON s.id=b.stock_item_id WHERE s.name='Scale linked 0000'"))[0][0].quantity)).toBe(8);
        expect(Number((await pool.query("SELECT working_quantity FROM ingredients WHERE name='Scale ingredient 0000'"))[0][0].working_quantity)).toBe(9.5);
        console.log(`[stock-count scale] lines=${lines.length} mix=${JSON.stringify(mix)} get=${fetchMs}ms save(all)=${saveMs}ms review=${reviewMs}ms post wall=${wallMs}ms locks held=${result.timing.locks_held_ms}ms`);
    }

    afterAll(() => pool.end());

    it('posts 300 counted lines', async () => { await scenario(300); }, 120000);
    it('posts 1000 counted lines', async () => { await scenario(1000); }, 240000);
});
