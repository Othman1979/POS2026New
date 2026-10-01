const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { getRefundsByShift, REFUNDS_ROLLUP_JOIN, NET_TOTAL, NET_SUBTOTAL, NET_TAX, NET_CASH } = require('../../services/financialSql');

describe('future saved table cancellations', () => {
    let cookie, shiftId;
    beforeEach(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
        const opened = await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie)
            .send({ user_id: 1, starting_cash: 50 });
        expect(opened.status).toBe(200);
        [[{ id: shiftId }]] = await pool.query("SELECT id FROM shifts WHERE user_id=1 AND status='open'");
    });
    afterAll(async () => { await pool.end(); });

    async function save(qty = 2) {
        const res = await request(app).post('/api/pos/table_order').set('Cookie', cookie).send({
            table_id: 1, shift_id: shiftId, cart: [{ id: 1, qty, price: 5, note: 'No onions' }],
            subtotal: 5 * qty, tax: 0.8 * qty, total: 5.8 * qty,
        });
        expect(res.status).toBe(200);
        const [[order]] = await pool.query("SELECT * FROM orders WHERE table_id=1 AND payment_method='unpaid_table'");
        expect(order.order_id).toBeNull();
        expect(order.invoice_number).toBeNull();
        const [[item]] = await pool.query('SELECT * FROM order_items WHERE invoice_id=?', [order.invoice_id]);
        return { order, item };
    }
    const cancel = async (invoiceId, items = null) => request(app).post('/api/pos/refunds').set('Cookie', cookie)
        .send({ invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', ...(items ? { items } : {}) });

    it.each(['occupied', 'printed'])('Clear archives %s items and keeps non-cash history after deleting the never-issued bill', async status => {
        const { order, item } = await save();
        await pool.query('UPDATE restaurant_tables SET status=? WHERE id=1', [status]);
        const before = await getRefundsByShift(pool, [shiftId]);
        const res = await cancel(order.invoice_id);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ kind: 'void', amount_refunded: 0, table_freed: true });
        expect((await pool.query('SELECT * FROM orders WHERE invoice_id=?', [order.invoice_id]))[0]).toEqual([]);
        expect((await pool.query('SELECT * FROM order_items WHERE invoice_id=?', [order.invoice_id]))[0]).toEqual([]);
        const [[archived]] = await pool.query('SELECT * FROM deleted WHERE refund_id=?', [res.body.refund_id]);
        expect(archived).toMatchObject({ source_invoice_id: order.invoice_id, source_order_item_id: item.id, item_name: item.item_name });
        expect(Number(archived.quantity)).toBe(2);
        const snapshot = typeof archived.item_snapshot === 'string' ? JSON.parse(archived.item_snapshot) : archived.item_snapshot;
        expect(snapshot).toMatchObject({ note: 'No onions', id: item.id, stock_authority: item.stock_authority });
        const [[event]] = await pool.query('SELECT * FROM refunds WHERE id=?', [res.body.refund_id]);
        expect(event).toMatchObject({ kind: 'void', invoice_id: null, refund_method: null });
        expect(Number(event.amount_refunded)).toBe(0);
        expect((await pool.query('SELECT * FROM refund_items WHERE refund_id=?', [event.id]))[0]).toHaveLength(1);
        expect(await getRefundsByShift(pool, [shiftId])).toEqual(before);
        const day = require('../../utils/businessDate').getBusinessDate();
        const report = await request(app).get(`/api/admin/reports/refunds?start_date=${day}&end_date=${day}`).set('Cookie', cookie);
        expect(report.status).toBe(200);
        expect(report.body.summary).toMatchObject({ refund_count: 0, void_count: 1, refund_cash: 0, void_value: 11.6 });
        const detail = await request(app).get(`/api/admin/reports/refunds/${event.id}/items`).set('Cookie', cookie);
        expect(detail.status).toBe(200);
        expect(detail.body.items).toHaveLength(1);
        expect(detail.body.items[0].note).toBe('No onions');
        expect((await pool.query('SELECT status,current_order_id FROM restaurant_tables WHERE id=1'))[0][0])
            .toEqual({ status: 'available', current_order_id: null });
        // A retry cannot create a second event or cancel the next party's order.
        const retry = await cancel(order.invoice_id);
        expect(retry.status).toBe(404);
        await save(1);
        expect((await cancel(order.invoice_id)).status).toBe(404);
        expect((await pool.query('SELECT * FROM refunds'))[0]).toHaveLength(1);
    });

    it('archives only a removed fraction, then preserves both events when the last item is removed', async () => {
        const { order, item } = await save(2.5);
        const first = await cancel(order.invoice_id, [{ order_item_id: item.id, qty: 0.25 }]);
        expect(first.status).toBe(200);
        expect(first.body.table_freed).toBe(false);
        expect(Number((await pool.query('SELECT quantity FROM order_items WHERE id=?', [item.id]))[0][0].quantity)).toBe(2.25);
        const last = await cancel(order.invoice_id, [{ order_item_id: item.id, qty: 2.25 }]);
        expect(last.status).toBe(200);
        expect((await pool.query('SELECT * FROM orders WHERE invoice_id=?', [order.invoice_id]))[0]).toEqual([]);
        const [archives] = await pool.query('SELECT quantity FROM deleted WHERE source_invoice_id=? ORDER BY id', [order.invoice_id]);
        expect(archives.map(row => Number(row.quantity))).toEqual([0.25, 2.25]);
        const [events] = await pool.query('SELECT invoice_id,kind,amount_refunded FROM refunds ORDER BY id');
        expect(events).toHaveLength(2);
        expect(events.every(row => row.invoice_id === null && row.kind === 'void' && Number(row.amount_refunded) === 0)).toBe(true);
    });

    it('excludes normal and malformed legacy voids from cash/refund counts and net sales tax, but retains real refunds', async () => {
        const [paid] = await pool.query(`INSERT INTO orders
            (user_id,shift_id,subtotal,tax,total,payment_method,cash_amount)
            VALUES (1,?,100,16,116,'cash',116)`, [shiftId]);
        await pool.query(`INSERT INTO refunds
            (kind,invoice_id,subtotal_refunded,tax_refunded,amount_refunded,refund_method,user_id,shift_id)
            VALUES ('refund',?,10,1.6,11.6,'cash',1,?),('void',?,5,0.8,5.8,'cash',1,?),('void',?,5,0.8,0,NULL,1,?)`,
        [paid.insertId, shiftId, paid.insertId, shiftId, paid.insertId, shiftId]);
        expect(await getRefundsByShift(pool, [shiftId])).toEqual({
            [shiftId]: { refund_count: 1, amt: 11.6, cash: 11.6, card: 0, platform: 0, tax: 1.6 },
        });
        const [[net]] = await pool.query(`SELECT ${NET_TOTAL} total, ${NET_SUBTOTAL} subtotal, ${NET_TAX} tax, ${NET_CASH} cash
            FROM orders o ${REFUNDS_ROLLUP_JOIN} WHERE o.invoice_id=?`, [paid.insertId]);
        expect(Object.fromEntries(Object.entries(net).map(([key, value]) => [key, Number(value)])))
            .toEqual({ total: 104.4, subtotal: 90, tax: 14.4, cash: 104.4 });
        const closed = await request(app).put('/api/auth/shifts?action=close').set('Cookie', cookie)
            .send({ shift_id: shiftId, actual_cash: 154.4 });
        expect(closed.status).toBe(200);
        expect(Number(closed.body.expected_cash)).toBe(154.4);
    });

    it.each(['order_id=99', 'invoice_number=99', 'invoice_issued_at=NOW()', 'cash_amount=1', "idempotency_key='saved-checkout'"])
    ('retains a historical/financial anchor with %s', async marker => {
        const { order } = await save();
        await pool.query(`UPDATE orders SET ${marker} WHERE invoice_id=?`, [order.invoice_id]);
        expect((await cancel(order.invoice_id)).status).toBe(200);
        const [[retained]] = await pool.query('SELECT * FROM orders WHERE invoice_id=?', [order.invoice_id]);
        expect(retained.payment_method).toBe('voided');
        expect((await pool.query('SELECT * FROM deleted WHERE source_invoice_id=?', [order.invoice_id]))[0]).toHaveLength(1);
    });

    it('rejects voiding both a paid split and its unpaid parent without recording a cancellation', async () => {
        const { order, item } = await save();
        const [child] = await pool.query(`INSERT INTO orders (user_id,parent_invoice_id,subtotal,tax,total,payment_method,cash_amount)
            VALUES (1,?,2,0,2,'cash',2)`, [order.invoice_id]);
        expect((await cancel(child.insertId)).status).toBe(409);
        const rejected = await cancel(order.invoice_id);
        expect(rejected.status).toBe(409);
        expect(rejected.body.code).toBe('SPLIT_ALREADY_PAID');
        expect((await pool.query('SELECT * FROM orders WHERE invoice_id=?', [order.invoice_id]))[0]).toEqual([order]);
        expect((await pool.query('SELECT * FROM order_items WHERE invoice_id=?', [order.invoice_id]))[0]).toEqual([item]);
        for (const table of ['refunds', 'refund_items', 'deleted']) expect((await pool.query(`SELECT * FROM ${table}`))[0]).toEqual([]);
    });

    it('preserves modifiers, bundle links, notes and the source quantities for a fraction', async () => {
        const { order, item } = await save(2.5);
        await pool.query('UPDATE order_items SET selected_modifiers=? WHERE id=?', ['[]', item.id]);
        const [child] = await pool.query(`INSERT INTO order_items
            (invoice_id,parent_item_id,product_id,item_name,quantity,price_at_sale,tax_rate,tax_amount,note)
            VALUES (?,?,2,'Saved bundle drink',5,0,0,0,'Cold')`, [order.invoice_id, item.id]);
        const res = await cancel(order.invoice_id, [{ order_item_id: item.id, qty: 0.25 }]);
        expect(res.status).toBe(200);
        const [rows] = await pool.query('SELECT * FROM deleted WHERE refund_id=? ORDER BY id', [res.body.refund_id]);
        expect(rows.map(row => Number(row.quantity))).toEqual([0.25, 0.5]);
        expect(rows[1]).toMatchObject({ source_parent_item_id: item.id, source_order_item_id: child.insertId });
        const snapshots = rows.map(row => JSON.parse(row.item_snapshot));
        expect(snapshots[0].selected_modifiers).toBe('[]');
        expect(Number(snapshots[0].quantity)).toBe(2.5);
        expect(snapshots[1].note).toBe('Cold');
        const [live] = await pool.query('SELECT quantity FROM order_items WHERE invoice_id=? ORDER BY parent_item_id', [order.invoice_id]);
        expect(live.map(row => Number(row.quantity))).toEqual([2.25, 4.5]);
    });

    it('preserves a bundle child snapshot when the cancelled portion is below stored quantity precision', async () => {
        const { order, item } = await save(2);
        await pool.query(`INSERT INTO order_items
            (invoice_id,parent_item_id,product_id,item_name,quantity,price_at_sale,tax_rate,tax_amount)
            VALUES (?,?,2,'Tiny saved component',0.000001,0,0,0)`, [order.invoice_id, item.id]);
        const res = await cancel(order.invoice_id, [{ order_item_id: item.id, qty: 0.000001 }]);
        expect(res.status).toBe(200);
        const [rows] = await pool.query('SELECT quantity FROM deleted WHERE refund_id=? ORDER BY id', [res.body.refund_id]);
        expect(rows.map(row => Number(row.quantity))).toEqual([0.000001, 0]);
        const [[child]] = await pool.query('SELECT quantity FROM order_items WHERE parent_item_id=?', [item.id]);
        expect(Number(child.quantity)).toBe(0.000001);
        expect((await cancel(order.invoice_id)).status).toBe(200);
        const [[archivedChildren]] = await pool.query('SELECT SUM(quantity) qty FROM deleted WHERE source_parent_item_id=?', [item.id]);
        expect(Number(archivedChildren.qty)).toBe(0.000001);
    });

    it('rejects a cancellation below the supported six-decimal precision without an archive or history event', async () => {
        const { order, item } = await save();
        const res = await cancel(order.invoice_id, [{ order_item_id: item.id, qty: 0.0000004 }]);
        expect(res.status).toBe(400);
        expect((await pool.query('SELECT * FROM deleted'))[0]).toEqual([]);
        expect((await pool.query('SELECT * FROM refunds'))[0]).toEqual([]);
        expect(Number((await pool.query('SELECT quantity FROM order_items WHERE id=?', [item.id]))[0][0].quantity)).toBe(2);
    });

    it.each(['INSERT INTO deleted', 'DELETE FROM orders'])('rolls back stock, history, archive and the table when %s fails', async failedSql => {
        await pool.query('UPDATE products SET stock=100 WHERE id=1');
        const settings = await request(app).post('/api/system/settings').set('Cookie', cookie).send({ stock_enabled: '1' });
        expect(settings.status).toBe(200);
        const { order } = await save();
        const state = async () => ({
            orders: (await pool.query('SELECT * FROM orders ORDER BY invoice_id'))[0],
            items: (await pool.query('SELECT * FROM order_items ORDER BY id'))[0],
            table: (await pool.query('SELECT * FROM restaurant_tables WHERE id=1'))[0],
            stock: (await pool.query('SELECT id,stock FROM products ORDER BY id'))[0],
            movements: (await pool.query('SELECT * FROM stock_movements ORDER BY id'))[0],
        });
        const before = await state();
        const original = pool.getConnection.bind(pool);
        const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
            const conn = await original(), query = conn.query, release = conn.release;
            conn.query = function(sql, params) {
                if (String(sql).includes(failedSql)) throw new Error('Injected cancellation failure');
                return query.call(this, sql, params);
            };
            conn.release = function() { conn.query = query; conn.release = release; return release.call(this); };
            return conn;
        });
        try { expect((await cancel(order.invoice_id)).status).toBe(500); }
        finally { spy.mockRestore(); }
        expect(await state()).toEqual(before);
        expect((await pool.query('SELECT * FROM deleted'))[0]).toEqual([]);
        expect((await pool.query('SELECT * FROM refunds'))[0]).toEqual([]);
        expect((await pool.query('SELECT * FROM refund_items'))[0]).toEqual([]);
        expect((await cancel(order.invoice_id)).status).toBe(200);
        expect(Number((await pool.query('SELECT stock FROM products WHERE id=1'))[0][0].stock)).toBe(100);
    });

    it('commits just once for simultaneous whole-order requests', async () => {
        const { order } = await save();
        const results = await Promise.all([cancel(order.invoice_id), cancel(order.invoice_id)]);
        expect(results.filter(result => result.status === 200)).toHaveLength(1);
        expect([404, 409]).toContain(results.find(result => result.status !== 200).status);
        expect((await pool.query('SELECT * FROM refunds'))[0]).toHaveLength(1);
        expect((await pool.query('SELECT * FROM deleted'))[0]).toHaveLength(1);
    });

    it('queues the captured kitchen cancellation after the never-issued order and live items are gone', async () => {
        const { order } = await save();
        const [printer] = await pool.query(`INSERT INTO printers(name,role,type,windows_name,is_active)
            VALUES('Fixture kitchen','kitchen','windows','Fixture-Kitchen',1)`);
        await pool.query('INSERT INTO printer_categories(printer_id,category_id) VALUES (?,1)', [printer.insertId]);
        const res = await cancel(order.invoice_id);
        expect(res.status).toBe(200);
        expect((await pool.query('SELECT * FROM orders WHERE invoice_id=?', [order.invoice_id]))[0]).toEqual([]);
        const [jobs] = await pool.query("SELECT payload FROM print_queue WHERE print_type='kitchen' ORDER BY id");
        expect(jobs).toHaveLength(1);
        const payload = JSON.parse(jobs[0].payload);
        expect(payload.data).toMatchObject({ void_ticket: true, internal_invoice_id: order.invoice_id,
            invoice_id: null, order_id: null, table_number: '1', print_batch_id: `table-void-${res.body.refund_id}` });
        expect(payload.data.items).toHaveLength(1);
        expect(payload.data.items[0]).toMatchObject({ name: 'Test Burger', qty: 2, note: 'No onions' });
    });
});
