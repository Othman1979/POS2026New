const request = require('supertest');
const fs = require('node:fs');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');

describe('server-owned progressive split provenance', () => {
    let admin, cashier, shiftId;
    const metrics = [];
    const post = (path, body, cookie = admin) => request(app).post(`/api/${path}`).set('Cookie', cookie).send(body);
    const rows = async (sql, params = []) => (await pool.query(sql, params))[0];
    const ok = res => { expect(res.statusCode, JSON.stringify(res.body)).toBe(200); return res.body; };
    const snapshot = async () => {
        const state = {};
        for (const table of ['orders', 'order_items', 'held_orders', 'restaurant_tables', 'products', 'stock_movements', 'recipe_ledger_lines', 'audit_events', 'service_charge_snapshots']) {
            state[table] = await rows(`SELECT * FROM ${table} ORDER BY 1`);
        }
        return state;
    };
    beforeEach(async () => {
        await seedDatabase();
        admin = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
        await pool.query("INSERT IGNORE INTO user_permissions(user_id,perm_key) VALUES(2,'tables.access'),(2,'waiter.checkout')");
        cashier = (await request(app).post('/api/auth/login').send({ user_number: '9002' })).headers['set-cookie'][0];
        ok(await post('auth/shifts?action=open', { user_id: 2, starting_cash: 50 }, cashier));
        shiftId = (await rows("SELECT id FROM shifts WHERE user_id=2 AND status='open'"))[0].id;
        ok(await post('system/settings', { stock_enabled: '1', recipe_ledger_enabled: '1' }));
        await pool.query('UPDATE products SET stock=100 WHERE id IN (1,2)');
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost,is_active) VALUES('Provenance ingredient','count','unit',1,1)");
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) VALUES(2,?,1,0)', [ingredient.insertId]);
    });
    afterAll(async () => {
        await pool.end();
        if (process.env.TABLE_SPLIT_PROVENANCE_METRICS) fs.writeFileSync(process.env.TABLE_SPLIT_PROVENANCE_METRICS, JSON.stringify(metrics, null, 2));
    });
    const save = async (qty = 2, extra = {}) => ok(await post('pos/table_order', { table_id: 1,
        cart: [{ id: 2, name: 'Test Drink', qty, price: 2, tax_rate: 0 }], subtotal: qty * 2, tax: 0, total: qty * 2, ...extra }));
    const split = async (saved, amounts = [1, 1]) => {
        const cart = ok(await request(app).get(`/api/pos/table_order?order_id=${saved.invoice_id}`).set('Cookie', admin)).cart;
        const total = Number((await rows('SELECT total FROM orders WHERE invoice_id=?', [saved.invoice_id]))[0].total);
        const quantity = amounts.reduce((sum, value) => sum + value, 0);
        ok(await post('pos/table_splits/split', { tableId: 1, currentOrderId: saved.invoice_id,
            splits: amounts.map((qty, index) => ({ referenceName: `Check ${index + 1}`, split_role: index === 0 ? 'remainder' : 'check',
                subtotal: Math.round(total * qty / quantity * 100) / 100, items: [{ ...cart.find(item => item.note !== 'Auto-Gratuity'), qty }] })) }));
        return rows('SELECT * FROM held_orders ORDER BY id');
    };
    const pay = async (held, extra = {}, label = {}) => {
        const payload = JSON.parse(held.cart_data), money = payload.split_money_cents || { subtotal: 200, tax: 0, total: 200 };
        const acquire = pool.getConnection; let queries = 0, returned = 0, provenanceReads = 0, leases = 0;
        pool.getConnection = async function (...args) {
            const conn = await acquire.apply(this, args), query = conn.query, execute = conn.execute, release = conn.release; leases++;
            const observe = method => async function (sql, values) {
                queries++; if (String(sql).includes("event_type = 'split_check_created'")) provenanceReads++;
                const result = await method.call(this, sql, values); if (Array.isArray(result[0])) returned += result[0].length; return result;
            };
            conn.query = observe(query); conn.execute = observe(execute);
            conn.release = function () { leases--; conn.query = query; conn.execute = execute; conn.release = release; return release.call(this); };
            return conn;
        };
        const start = performance.now();
        try {
            const res = await post('pos/checkout', { cart: payload.items, shift_id: shiftId, split_check_id: held.id,
                table_id: 1, split_revision: payload.split_revision || 1,
                subtotal: money.subtotal / 100, tax: money.tax / 100, total: money.total / 100,
                payment_method: 'cash', amount_tendered: money.total / 100, change_due: 0, ...extra }, cashier);
            metrics.push({ ...label, status: res.statusCode, queries, returned, provenanceReads, leases, milliseconds: performance.now() - start });
            expect(leases).toBe(0);
            return { res, provenanceReads };
        } finally { pool.getConnection = acquire; }
    };
    const rewrite = (held, splits) => request(app).put('/api/pos/table_splits').set('Cookie', admin).send({ splitId: held[0].id,
        expectedChecks: held.map(row => ({ id: row.id, revision: JSON.parse(row.cart_data).split_revision })), splits });
    it.each([0, 1].flatMap(xyz => [false, true].map(fee => ({ xyz, fee }))))('settles both checks without optional audit dependency (xyz=$xyz fee=$fee)', async ({ xyz, fee }) => {
        await pool.query('UPDATE users SET xyz=? WHERE id=1', [xyz]);
        if (fee) ok(await post('system/settings', { service_charge_enabled: '1', auto_apply_service_charge: '1', service_charge_percentage: '10', service_charge_tax_rate: '0' }));
        const saved = await save(), held = await split(saved);
        expect((await rows("SELECT * FROM audit_events WHERE event_type='split_check_created'")).length).toBe(xyz ? 0 : 2);
        for (const [index, check] of held.entries()) {
            const { res, provenanceReads } = await pay(check, {}, { xyz, fee, index });
            ok(res); expect(provenanceReads).toBe(0);
        }
        expect(await rows('SELECT * FROM held_orders')).toEqual([]);
        expect(Number((await rows('SELECT stock FROM products WHERE id=2'))[0].stock)).toBe(98);
        expect(Number((await rows("SELECT SUM(qty) qty FROM stock_movements WHERE movement_type='ingredient'"))[0].qty)).toBe(-2);
        expect((await rows("SELECT * FROM orders WHERE parent_invoice_id=? AND payment_method='cash'", [saved.invoice_id])).length).toBe(2);
    });
    it('settles a new xyz check added after a sibling was paid, keeping the paid invoice unchanged', async () => {
        const saved = await save(3), held = await split(saved, [2, 1]);
        ok((await pay(held[1])).res);
        const paidBefore = await rows("SELECT * FROM orders WHERE parent_invoice_id=? AND payment_method='cash'", [saved.invoice_id]);
        await pool.query('UPDATE users SET xyz=1 WHERE id=1');
        const payload = JSON.parse(held[0].cart_data), item = payload.items[0];
        ok(await request(app).put('/api/pos/table_splits').set('Cookie', admin).send({ splitId: held[0].id,
            expectedChecks: [{ id: held[0].id, revision: payload.split_revision }],
            splits: [{ id: held[0].id, split_role: 'remainder', items: [{ ...item, qty: 1 }] }, { split_role: 'check', items: [{ ...item, qty: 1 }] }] }));
        const remaining = await rows('SELECT * FROM held_orders ORDER BY id DESC');
        expect(await rows("SELECT * FROM audit_events WHERE event_type='split_check_created' AND entity_id=?", [remaining[0].id])).toEqual([]);
        for (const check of remaining) ok((await pay(check)).res);
        expect(await rows('SELECT * FROM orders WHERE invoice_id=?', [paidBefore[0].invoice_id])).toEqual(paidBefore);
        expect(Number((await rows('SELECT stock FROM products WHERE id=2'))[0].stock)).toBe(97);
    });
    it('preserves an xyz-created bundle snapshot through catalog changes at settlement', async () => {
        await pool.query('UPDATE users SET xyz=1 WHERE id=1');
        const saved = await save(2, { cart: [{ id: 4, name: 'Family Package', qty: 2, price: 10, tax_rate: 16, is_bundle: true,
            bundleItems: [{ product_id: 1, qty: 1, removed: false }, { product_id: 2, qty: 1, removed: false }] }], subtotal: 20, tax: 3.2, total: 23.2 });
        const held = await split(saved);
        await pool.query('UPDATE product_bundle_items SET qty=3 WHERE bundle_id=4');
        for (const check of held) ok((await pay(check)).res);
        const children = await rows('SELECT oi.product_id,SUM(oi.quantity) qty FROM order_items oi JOIN orders o ON o.invoice_id=oi.invoice_id WHERE o.parent_invoice_id=? AND oi.parent_item_id IS NOT NULL GROUP BY oi.product_id ORDER BY oi.product_id', [saved.invoice_id]);
        expect(children.map(row => [row.product_id, Number(row.qty)])).toEqual([[1, 2], [2, 2]]);
    });
    it('rejects a split rewrite that adds units the unpaid group does not have', async () => {
        const saved = await save(3), held = await split(saved, [2, 1]);
        const item = JSON.parse(held[0].cart_data).items[0];
        const res = await rewrite(held, [{ id: held[0].id, split_role: 'remainder', items: [{ ...item, qty: 2 }] },
            { id: held[1].id, split_role: 'check', items: [{ ...item, qty: 2 }] }]);
        expect(res.statusCode).toBe(409); expect(res.body.code).toBe('SPLIT_ITEMS_MISMATCH');
        expect(await rows('SELECT * FROM held_orders ORDER BY id')).toEqual(held);
    });
    it('pins a seat to the parent line price when the client sends its order_item_id with a lowered price', async () => {
        const saved = await save();
        const line = ok(await request(app).get(`/api/pos/table_order?order_id=${saved.invoice_id}`).set('Cookie', admin)).cart[0];
        expect(line.order_item_id).toEqual(expect.any(Number));
        ok(await post('pos/table_splits/split', { tableId: 1, currentOrderId: saved.invoice_id,
            splits: [{ referenceName: 'Seat 1', subtotal: 4, items: [{ ...line, qty: 2, price: 0.5 }] }] }));
        const [held] = await rows('SELECT * FROM held_orders');
        expect(Number(JSON.parse(held.cart_data).items[0].price)).toBe(2);
    });
    it('splits a fixed order discount across rewritten checks instead of repeating it on each', async () => {
        const saved = await save(3, { order_discount_type: 'fixed', order_discount_value: 1, total: 5 }), held = await split(saved, [2, 1]);
        const item = JSON.parse(held[0].cart_data).items[0];
        ok(await rewrite(held, [{ id: held[0].id, split_role: 'remainder', items: [{ ...item, qty: 1 }] },
            { id: held[1].id, split_role: 'check', items: [{ ...item, qty: 1 }] }, { split_role: 'check', items: [{ ...item, qty: 1 }] }]));
        const checks = await rows('SELECT * FROM held_orders ORDER BY id'), payloads = checks.map(row => JSON.parse(row.cart_data));
        expect(payloads.map(payload => payload.order_discount.value)).toEqual([0.34, 0.33, 0.33]);
        expect(payloads.map(payload => payload.split_money_cents.discount)).toEqual([34, 33, 33]);
        ok((await pay(checks[2])).res);
    });
    it.each(['missing relations', 'wrong JSON parent', 'wrong request table', 'stale revision'])('rejects %s without changing the split or money', async reason => {
        const saved = await save(), held = await split(saved);
        const check = held[0], extra = {};
        if (reason === 'missing relations') await pool.query('UPDATE held_orders SET parent_invoice_id=NULL,table_id=NULL WHERE id=?', [check.id]);
        if (reason === 'wrong JSON parent') {
            const payload = JSON.parse(check.cart_data); payload.parent_invoice_id = 999999;
            await pool.query('UPDATE held_orders SET cart_data=? WHERE id=?', [JSON.stringify(payload), check.id]);
            check.cart_data = JSON.stringify(payload);
        }
        if (reason === 'wrong request table') extra.table_id = 2;
        if (reason === 'stale revision') extra.split_revision = 999;
        const before = await snapshot(), { res } = await pay(check, extra);
        expect(res.statusCode).toBe(409); expect(await snapshot()).toEqual(before);
    });
});
