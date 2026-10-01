const request = require('supertest');
const fs = require('node:fs');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { syncOrderRefundStatus } = require('../../services/RefundService');
const { getRefundsByShift } = require('../../services/financialSql');

describe('paid table refund status uses financial refunds', () => {
    let cookie, shiftId;
    const metrics = [];
    const rows = async (sql, params = []) => (await pool.query(sql, params))[0];
    const post = (path, body) => request(app).post(`/api/${path}`).set('Cookie', cookie).send(body);
    const ok = res => { expect(res.statusCode, JSON.stringify(res.body)).toBe(200); return res.body; };
    const load = async id => ok(await request(app).get(`/api/pos/table_order?order_id=${id}`).set('Cookie', cookie));
    const order = async id => (await rows('SELECT * FROM orders WHERE invoice_id=?', [id]))[0];
    beforeEach(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
        ok(await post('auth/shifts?action=open', { user_id: 1, starting_cash: 50 }));
        shiftId = (await rows("SELECT id FROM shifts WHERE status='open'"))[0].id;
        ok(await post('system/settings', { stock_enabled: '1' }));
        await pool.query('UPDATE products SET stock=100 WHERE id=2');
    });
    afterAll(async () => {
        await pool.end();
        if (process.env.TABLE_PAID_STATUS_METRICS) fs.writeFileSync(process.env.TABLE_PAID_STATUS_METRICS, JSON.stringify(metrics, null, 2));
    });
    const prepare = async (xyz = 0, fee = false) => {
        await pool.query('UPDATE users SET xyz=? WHERE id=1', [xyz]);
        if (fee) ok(await post('system/settings', { service_charge_enabled: '1', auto_apply_service_charge: '1', service_charge_percentage: '10', service_charge_tax_rate: '0' }));
        const saved = ok(await post('pos/table_order', { table_id: 1, shift_id: shiftId, cart: [{ id: 2, name: 'Test Drink', qty: 4, price: 2 }], subtotal: 8, tax: 0, total: 8 }));
        for (let i = 0; i < 2; i++) {
            const bill = await load(saved.invoice_id);
            ok(await post('pos/refunds', { invoice_id: saved.invoice_id, intent: 'void', expected_version: bill.version,
                items: [{ order_item_id: bill.cart.find(item => item.id === 2).order_item_id, qty: 1 }] }));
        }
        return saved.invoice_id;
    };
    const pay = async (id, label = {}) => {
        const bill = await load(id), saved = await order(id);
        const payload = { edit_invoice_id: id, table_id: 1, shift_id: shiftId, cart: bill.cart, service_charge_snapshot: bill.service_charge_snapshot,
            subtotal: Number(saved.subtotal), tax: Number(saved.tax), total: Number(saved.total), payment_method: 'cash', amount_tendered: Number(saved.total), change_due: 0 };
        const acquire = pool.getConnection; let queries = 0, returned = 0, leases = 0;
        pool.getConnection = async function (...args) {
            const conn = await acquire.apply(this, args), query = conn.query, execute = conn.execute, release = conn.release; leases++;
            const observe = method => async function (sql, values) { queries++; const result = await method.call(this, sql, values); if (Array.isArray(result[0])) returned += result[0].length; return result; };
            conn.query = observe(query); conn.execute = observe(execute);
            conn.release = function () { leases--; conn.query = query; conn.execute = execute; conn.release = release; return release.call(this); };
            return conn;
        };
        const start = performance.now();
        try { ok(await post('pos/checkout', payload)); }
        finally {
            pool.getConnection = acquire;
            metrics.push({ ...label, queries, returned, leases, milliseconds: performance.now() - start });
        }
        expect(leases).toBe(0); return payload;
    };
    const filtered = async status => ok(await request(app).get(`/api/admin/orders?refund_status=${status}&filter_type=tables`).set('Cookie', cookie));
    it.each([0, 1].flatMap(xyz => [false, true].map(fee => ({ xyz, fee }))))
    ('clears only void status on payment, then tracks actual partial/full refunds (xyz=$xyz fee=$fee)', async ({ xyz, fee }) => {
        const id = await prepare(xyz, fee);
        expect((await order(id)).refund_status).toBe(xyz ? 'none' : 'partial');
        const history = await rows("SELECT * FROM refunds WHERE kind='void'");
        const payload = await pay(id, { xyz, fee });
        expect((await order(id)).refund_status).toBe('none');
        expect(await rows("SELECT * FROM refunds WHERE kind='void'")).toEqual(history);
        expect(await getRefundsByShift(pool, [shiftId])).toEqual({});
        expect((await filtered('none')).orders.map(row => row.invoice_id)).toContain(id);
        expect((await filtered('partial')).orders.map(row => row.invoice_id)).not.toContain(id);
        const item = (await rows('SELECT id FROM order_items WHERE invoice_id=? AND product_id=2', [id]))[0];
        const firstRefund = ok(await post('pos/refunds', { invoice_id: id, intent: 'refund', refund_method: 'cash', items: [{ order_item_id: item.id, qty: 1 }] }));
        expect(Number(firstRefund.amount_refunded)).toBe(2);
        expect((await order(id)).refund_status).toBe('partial');
        expect((await filtered('partial')).orders.map(row => row.invoice_id)).toContain(id);
        const lastRefund = ok(await post('pos/refunds', { invoice_id: id, intent: 'refund', refund_method: 'cash' }));
        expect(Number(lastRefund.amount_refunded)).toBe(fee ? 2.4 : 2);
        expect((await order(id)).refund_status).toBe('full');
        expect((await filtered('full')).orders.map(row => row.invoice_id)).toContain(id);
        const beforeRejected = await rows('SELECT * FROM refunds ORDER BY id');
        expect((await post('pos/refunds', { invoice_id: id, intent: 'refund', refund_method: 'cash' })).statusCode).toBe(400);
        expect((await post('pos/checkout', payload)).statusCode).toBe(403);
        expect((await order(id)).refund_status).toBe('full');
        expect(await rows('SELECT * FROM refunds ORDER BY id')).toEqual(beforeRejected);
        expect(Number((await rows('SELECT stock FROM products WHERE id=2'))[0].stock)).toBe(100);
        const totals = await getRefundsByShift(pool, [shiftId]);
        expect(totals[shiftId]).toMatchObject({ refund_count: 2, cash: fee ? 4.4 : 4 });
        const closed = ok(await request(app).put('/api/auth/shifts?action=close').set('Cookie', cookie).send({ shift_id: shiftId, actual_cash: 50 }));
        expect(Number(closed.expected_cash)).toBe(50);
    });
    it('repairs paid status with only void evidence without treating a legacy void amount as refunded cash', async () => {
        const id = await prepare(); await pay(id);
        await pool.query("UPDATE refunds SET amount_refunded=20,refund_method='cash' WHERE invoice_id=? AND kind='void'", [id]);
        await pool.query("UPDATE orders SET refund_status='partial' WHERE invoice_id=?", [id]);
        expect(await syncOrderRefundStatus(pool, id)).toBe('none');
        expect((await order(id)).refund_status).toBe('none');
        expect(await getRefundsByShift(pool, [shiftId])).toEqual({});
        // Legacy rows may retain a line reference. Their cancelled quantity must
        // not use up the paid item's refundable units either.
        const item = (await rows('SELECT id FROM order_items WHERE invoice_id=?', [id]))[0];
        await pool.query("UPDATE refund_items ri JOIN refunds r ON r.id=ri.refund_id SET ri.order_item_id=? WHERE r.invoice_id=? AND r.kind='void'", [item.id, id]);
        const refunded = ok(await post('pos/refunds', { invoice_id: id, intent: 'refund', refund_method: 'cash' }));
        expect(Number(refunded.amount_refunded)).toBe(4); expect(refunded.refund_status).toBe('full');
    });
    it('invoice-ID status repair requires refunded money as well as complete item coverage', async () => {
        const id = await prepare(1); await pay(id);
        const item = (await rows('SELECT id,quantity FROM order_items WHERE invoice_id=?', [id]))[0];
        const [refund] = await pool.query("INSERT INTO refunds(kind,invoice_id,subtotal_refunded,tax_refunded,amount_refunded,refund_method,user_id,shift_id) VALUES('refund',?,1,0,1,'cash',1,?)", [id, shiftId]);
        await pool.query('INSERT INTO refund_items(refund_id,order_item_id,product_id,item_name,quantity,unit_price,line_subtotal,line_tax,line_total) VALUES(?,?,2,\'Test Drink\',?,2,1,0,1)', [refund.insertId, item.id, item.quantity]);
        expect(await syncOrderRefundStatus(pool, id)).toBe('partial');
        await pool.query('UPDATE refunds SET amount_refunded=4 WHERE id=?', [refund.insertId]);
        expect(await syncOrderRefundStatus(pool, id)).toBe('full');
    });
});
