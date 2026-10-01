const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');

describe('table void split lifecycle guard', () => {
    let cookie, shiftId;
    const post = (path, body) => request(app).post(`/api/${path}`).set('Cookie', cookie).send(body);
    const ok = response => { expect(response.statusCode, JSON.stringify(response.body)).toBe(200); return response.body; };
    const rows = async (sql, args = []) => (await pool.query(sql, args))[0];
    const state = async () => {
        const result = {};
        for (const table of ['orders', 'order_items', 'restaurant_tables', 'held_orders', 'products',
            'stock_movements', 'recipe_ledger_lines', 'service_charge_snapshots', 'refunds', 'refund_items', 'deleted', 'audit_events', 'print_queue']) {
            result[table] = await rows(`SELECT * FROM ${table} ORDER BY 1`);
        }
        return result;
    };
    beforeEach(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
        ok(await post('auth/shifts?action=open', { user_id: 1, starting_cash: 50 }));
        shiftId = (await rows("SELECT id FROM shifts WHERE user_id=1 AND status='open'"))[0].id;
        ok(await post('system/settings', { stock_enabled: '1', recipe_ledger_enabled: '1' }));
        await pool.query('UPDATE products SET stock=100 WHERE id=2');
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost,is_active) VALUES('Void guard ingredient','count','unit',1,1)");
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) VALUES(2,?,1,0)', [ingredient.insertId]);
    });
    afterAll(() => pool.end());
    const save = async (fee = false) => {
        if (fee) ok(await post('system/settings', { service_charge_enabled: '1', auto_apply_service_charge: '1', service_charge_percentage: '10', service_charge_tax_rate: '0' }));
        return ok(await post('pos/table_order', { table_id: 1, shift_id: shiftId,
            cart: [{ id: 2, qty: 2, price: 2, tax_rate: 0 }], subtotal: 4, tax: 0, total: 4 }));
    };
    const split = async saved => {
        const [[order]] = await pool.query('SELECT total FROM orders WHERE invoice_id=?', [saved.invoice_id]);
        ok(await post('pos/table_splits/split', { tableId: 1, currentOrderId: saved.invoice_id,
            splits: [1, 2].map(index => ({ referenceName: `Check ${index}`, subtotal: Number(order.total) / 2,
                items: [{ id: 2, name: 'Test Drink', qty: 1, price: 2, tax_rate: 0 }] })) }));
        return rows('SELECT * FROM held_orders ORDER BY id');
    };
    const pay = async held => {
        const payload = JSON.parse(held.cart_data), money = payload.split_money_cents;
        return ok(await post('pos/checkout', { cart: payload.items, shift_id: shiftId, split_check_id: held.id, table_id: 1,
            subtotal: money.subtotal / 100, tax: money.tax / 100, total: money.total / 100,
            payment_method: 'cash', amount_tendered: money.total / 100, change_due: 0 }));
    };
    const cases = [false, true].flatMap(fee => [false, true].flatMap(paid => [0, 1].map(xyz => ({ fee, paid, xyz }))));
    it.each(cases)('rejects every parent void without changes (fee=$fee paid=$paid xyz=$xyz)', async ({ fee, paid, xyz }) => {
        const saved = await save(fee), held = await split(saved);
        if (paid) await pay(held[0]);
        // Change only the void actor policy; xyz split provenance is a separate defect.
        await pool.query('UPDATE users SET xyz=? WHERE id=1', [xyz]);
        const [[item]] = await pool.query('SELECT id FROM order_items WHERE invoice_id=? AND product_id=2', [saved.invoice_id]);
        const before = await state();
        for (const items of [null, [{ order_item_id: item.id, qty: 2 }], [{ order_item_id: item.id, qty: 0.5 }]]) {
            const res = await post('pos/refunds', { invoice_id: saved.invoice_id, expected_version: await currentTableRevision(saved.invoice_id), intent: 'void', ...(items ? { items } : {}) });
            expect(res.statusCode, JSON.stringify(res.body)).toBe(409);
            expect(res.body.code).toBe('SPLIT_CHECKS_OPEN');
            expect(await state()).toEqual(before);
        }
    });
    it('protects a paid child even if the remaining held check is missing', async () => {
        const saved = await save(), held = await split(saved);
        await pay(held[0]);
        await pool.query('DELETE FROM held_orders WHERE parent_invoice_id=?', [saved.invoice_id]);
        const before = await state();
        const res = await post('pos/refunds', { invoice_id: saved.invoice_id, expected_version: await currentTableRevision(saved.invoice_id), intent: 'void' });
        expect(res.statusCode, JSON.stringify(res.body)).toBe(409);
        expect(res.body.code).toBe('SPLIT_ALREADY_PAID');
        expect(await state()).toEqual(before);
    });
    it('sees splits committed after the void transaction started its consistent-read snapshot', async () => {
        const saved = await save();
        const acquire = pool.getConnection;
        let releaseProbe, reachedProbe;
        const reached = new Promise(resolve => { reachedProbe = resolve; });
        const gate = new Promise(resolve => { releaseProbe = resolve; });
        pool.getConnection = async function (...args) {
            const conn = await acquire.apply(this, args), query = conn.query, release = conn.release;
            conn.query = async function (sql, params) {
                const result = await query.call(this, sql, params);
                if (String(sql).includes('SELECT payment_method, table_id FROM orders WHERE invoice_id=? LIMIT 1')) {
                    reachedProbe(); await gate;
                }
                return result;
            };
            conn.release = function () { conn.query = query; conn.release = release; return release.call(this); };
            return conn;
        };
        let pending;
        try {
            pending = post('pos/refunds', { invoice_id: saved.invoice_id, expected_version: await currentTableRevision(saved.invoice_id), intent: 'void' }).then(response => response);
            await reached;
            await split(saved);
            const before = await state();
            releaseProbe();
            const res = await pending;
            expect(res.statusCode, JSON.stringify(res.body)).toBe(409);
            expect(res.body.code).toBe('SPLIT_CHECKS_OPEN');
            expect(await state()).toEqual(before);
        } finally { releaseProbe(); await pending; pool.getConnection = acquire; }
    });
});
