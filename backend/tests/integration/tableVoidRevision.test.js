const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');

describe('saved table void expected revision', () => {
    let cookie;
    const post = (path, body) => request(app).post(`/api/${path}`).set('Cookie', cookie).send(body);
    const rows = async (sql, params = []) => (await pool.query(sql, params))[0];
    const ok = res => { expect(res.statusCode, JSON.stringify(res.body)).toBe(200); return res.body; };
    const load = async id => ok(await request(app).get(`/api/pos/table_order?order_id=${id}`).set('Cookie', cookie));
    const snapshot = async () => {
        const result = {};
        for (const table of ['orders', 'order_items', 'restaurant_tables', 'held_orders', 'products', 'stock_movements',
            'recipe_ledger_lines', 'service_charge_snapshots', 'refunds', 'refund_items', 'deleted', 'audit_events', 'print_queue'])
            result[table] = await rows(`SELECT * FROM ${table} ORDER BY 1`);
        return result;
    };
    beforeEach(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
        ok(await post('system/settings', { stock_enabled: '1', recipe_ledger_enabled: '1' }));
        await pool.query('UPDATE products SET stock=100 WHERE id IN (1,2)');
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost,is_active) VALUES('Void revision ingredient','count','unit',1,1)");
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) VALUES(2,?,1,0)', [ingredient.insertId]);
    });
    afterAll(() => pool.end());
    const save = async () => {
        const saved = ok(await post('pos/table_order', { table_id: 1, cart: [{ id: 2, name: 'Test Drink', qty: 2, price: 2 }], subtotal: 4, tax: 0, total: 4 }));
        return load(saved.invoice_id);
    };
    const cancel = (bill, extra = {}) => post('pos/refunds', { invoice_id: bill.invoice_id, intent: 'void', expected_version: bill.version, ...extra });
    it.each([undefined, null, '1', 0, 1.5, true])('rejects a missing or invalid revision (%j) before any writes', async version => {
        const bill = await save(), before = await snapshot();
        const res = await cancel(bill, { expected_version: version });
        expect(res.statusCode).toBe(409); expect(res.body.code).toBe('TABLE_ORDER_VERSION_CONFLICT');
        expect(await snapshot()).toEqual(before);
    });
    it.each([0, 1].flatMap(xyz => [false, true].flatMap(fee => [false, true].map(printed => ({ xyz, fee, printed })))))
    ('preserves a concurrent add on stale Clear and Remove (xyz=$xyz fee=$fee printed=$printed)', async ({ xyz, fee, printed }) => {
        await pool.query('UPDATE users SET xyz=? WHERE id=1', [xyz]);
        if (fee) ok(await post('system/settings', { service_charge_enabled: '1', auto_apply_service_charge: '1', service_charge_percentage: '10', service_charge_tax_rate: '0' }));
        const old = await save();
        ok(await post('pos/table_order', { table_id: 1, current_order_id: old.invoice_id, expected_version: old.version,
            service_charge_snapshot: old.service_charge_snapshot,
            cart: [...old.cart, { id: 1, name: 'Test Burger', qty: 1, price: 5, tax_rate: 16 }], subtotal: 9, tax: 0.8, total: 9.8 }));
        if (printed) ok(await post('pos/table_order', { action: 'mark_printed', table_id: 1, expected_invoice_id: old.invoice_id }));
        const before = await snapshot();
        for (const extra of [{}, { items: [{ order_item_id: old.cart.find(item => item.id === 2).order_item_id, qty: 0.5 }] }]) {
            const res = await cancel(old, extra);
            expect(res.statusCode, JSON.stringify(res.body)).toBe(409); expect(res.body.code).toBe('TABLE_ORDER_VERSION_CONFLICT');
            expect(await snapshot()).toEqual(before);
        }
        const current = await load(old.invoice_id);
        expect(current.cart.some(item => item.id === 1)).toBe(true);
        ok(await cancel(current));
        expect(await rows('SELECT * FROM orders WHERE invoice_id=?', [old.invoice_id])).toEqual([]);
        expect(Number((await rows('SELECT stock FROM products WHERE id=2'))[0].stock)).toBe(100);
    });
    it.each([0, 1])('does not apply a lost partial response twice, and permits a reviewed new intent (xyz=%s)', async xyz => {
        await pool.query('UPDATE users SET xyz=? WHERE id=1', [xyz]);
        const bill = await save(), items = [{ order_item_id: bill.cart[0].order_item_id, qty: 0.5 }];
        ok(await cancel(bill, { items })); // Treat the response as lost.
        const afterFirst = await snapshot();
        const replay = await cancel(bill, { items });
        expect(replay.statusCode).toBe(409); expect(replay.body.code).toBe('TABLE_ORDER_VERSION_CONFLICT');
        expect(await snapshot()).toEqual(afterFirst);
        const fresh = await load(bill.invoice_id);
        expect(fresh.version).toBe(bill.version + 1); expect(fresh.cart[0].qty).toBe(1.5);
        ok(await cancel(fresh, { items: [{ order_item_id: fresh.cart[0].order_item_id, qty: 0.5 }] }));
        expect((await load(bill.invoice_id)).cart[0].qty).toBe(1);
        expect(Number((await rows('SELECT stock FROM products WHERE id=2'))[0].stock)).toBe(99);
        expect(Number((await rows("SELECT SUM(qty) qty FROM stock_movements WHERE movement_type='ingredient'"))[0].qty)).toBe(-1);
        expect((await rows('SELECT * FROM deleted')).length).toBe(xyz ? 0 : 2);
        expect((await rows("SELECT * FROM refunds WHERE kind='refund'")).length).toBe(0);
    });
    it('tells staff terminals to revalidate stock after clearing an unpaid table', async () => {
        const bill = await save();
        global.__mockEmit__.mockClear();
        ok(await cancel(bill));
        await vi.waitFor(() => expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'inventory_changed'))
            .toEqual([['inventory_changed', { scope: 'stock', productIds: expect.arrayContaining([2]) }]]));
    });
    it('serializes identical concurrent partial voids into one change and one conflict', async () => {
        const bill = await save(), extra = { items: [{ order_item_id: bill.cart[0].order_item_id, qty: 0.5 }] };
        const responses = await Promise.all([cancel(bill, extra), cancel(bill, extra)]);
        expect(responses.map(res => res.statusCode).sort()).toEqual([200, 409]);
        expect((await load(bill.invoice_id)).cart[0].qty).toBe(1.5);
        expect((await rows('SELECT * FROM deleted')).length).toBe(1);
    });
});
