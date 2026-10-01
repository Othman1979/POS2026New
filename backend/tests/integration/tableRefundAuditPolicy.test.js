const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { getRefundsByShift } = require('../../services/financialSql');

describe('table void and paid refund audit policy', () => {
    afterAll(async () => { await pool.end(); });

    it.each([0, 1])('uses the current actor xyz=%s for both actions without changing cash or duplicate-refund protection', async xyz => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: '9001' });
        const cookie = login.headers['set-cookie'][0];
        const post = (url, body) => request(app).post(url).set('Cookie', cookie).send(body);
        const opened = await post('/api/auth/shifts?action=open', { user_id: 1, starting_cash: 50 });
        expect(opened.status).toBe(200);
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=1 AND status='open'");
        // Change after login: audit policy must use the DB, not cached/browser grants.
        await pool.query('UPDATE users SET xyz=? WHERE id=1', [xyz]);
        const cart = [{ id: 2, qty: 2, price: 2 }];
        const save = async () => {
            const res = await post('/api/pos/table_order', { table_id: 1, shift_id: shift.id, cart, subtotal: 4, tax: 0, total: 4 });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            return res.body.invoice_id;
        };
        const cancelledId = await save();
        const cancelled = await post('/api/pos/refunds', { invoice_id: cancelledId, expected_version: await currentTableRevision(cancelledId), intent: 'void' });
        expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
        expect(cancelled.body).toMatchObject({ amount_refunded: 0, table_freed: true });
        const [voidHistory] = await pool.query("SELECT * FROM refunds WHERE kind='void'");
        const [deleted] = await pool.query('SELECT * FROM deleted');
        const [voidItems] = await pool.query('SELECT * FROM refund_items');
        expect(voidHistory).toHaveLength(xyz ? 0 : 1);
        expect(deleted).toHaveLength(xyz ? 0 : 1);
        expect(voidItems).toHaveLength(xyz ? 0 : 1);
        expect(cancelled.body.refund_id === null).toBe(Boolean(xyz));
        const paidId = await save();
        const paid = await post('/api/pos/checkout', { edit_invoice_id: paidId, table_id: 1, shift_id: shift.id,
            cart, subtotal: 4, tax: 0, total: 4, payment_method: 'cash', amount_tendered: 4, change_due: 0 });
        expect(paid.status, JSON.stringify(paid.body)).toBe(200);
        const refundBody = { invoice_id: paidId, intent: 'refund', refund_method: 'cash', reason: 'Fixture table return' };
        const refunded = await post('/api/pos/refunds', refundBody);
        expect(refunded.status, JSON.stringify(refunded.body)).toBe(200);
        expect(refunded.body).toMatchObject({ amount_refunded: 4, refund_status: 'full' });
        expect((await pool.query("SELECT * FROM refunds WHERE kind='refund'"))[0]).toHaveLength(1);
        expect((await pool.query('SELECT * FROM refund_items WHERE refund_id=?', [refunded.body.refund_id]))[0]).toHaveLength(1);
        expect((await post('/api/pos/refunds', refundBody)).status).toBe(400);
        const [audits] = await pool.query("SELECT event_type FROM audit_events WHERE event_type IN ('void_order','refund') ORDER BY id");
        expect(audits.map(row => row.event_type)).toEqual(xyz ? [] : ['void_order', 'refund']);
        expect(await getRefundsByShift(pool, [shift.id])).toEqual({
            [shift.id]: { refund_count: 1, amt: 4, cash: 4, card: 0, platform: 0, tax: 0 },
        });
        const closed = await request(app).put('/api/auth/shifts?action=close').set('Cookie', cookie)
            .send({ shift_id: shift.id, actual_cash: 50 });
        expect(closed.status).toBe(200);
        expect(Number(closed.body.expected_cash)).toBe(50);
    });

    it.each([
        ['occupied', 'last item'], ['printed', 'last item'], ['occupied', 'Clear'], ['printed', 'Clear'],
    ])('omits every history row for xyz table %s / %s while restoring stock, recipe quantities and distinct kitchen tickets', async (status, finish) => {
        await seedDatabase();
        const cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
        const post = (url, body) => request(app).post(url).set('Cookie', cookie).send(body);
        await pool.query('UPDATE users SET xyz=1 WHERE id=1');
        await pool.query('UPDATE products SET stock=100 WHERE id=1');
        await post('/api/system/settings', { stock_enabled: '1', recipe_ledger_enabled: '1' });
        const [ingredient] = await pool.query(`INSERT INTO ingredients(name,measure,display_unit,unit_cost,is_active)
            VALUES('Fixture recipe','weight','g',0.01,1)`);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) VALUES(1,?,200,0)', [ingredient.insertId]);
        const saved = await post('/api/pos/table_order', { table_id: 1, cart: [{ id: 1, qty: 2, price: 5 }], subtotal: 10, tax: 1.6, total: 11.6 });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const invoiceId = saved.body.invoice_id;
        const [[item]] = await pool.query('SELECT * FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL', [invoiceId]);
        expect(item.recipe_line_key).toBeTruthy();
        const netRecipe = async () => Number((await pool.query("SELECT COALESCE(SUM(qty),0) qty FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=?", [ingredient.insertId]))[0][0].qty);
        expect(await netRecipe()).toBe(-400);
        const [printer] = await pool.query("INSERT INTO printers(name,role,type,windows_name,is_active) VALUES('Fixture','kitchen','windows','Fixture',1)");
        await pool.query('INSERT INTO printer_categories(printer_id,category_id) VALUES(?,1)', [printer.insertId]);
        await pool.query('UPDATE restaurant_tables SET status=? WHERE id=1', [status]);
        const auditBefore = (await pool.query('SELECT * FROM audit_events ORDER BY id'))[0];
        const first = await post('/api/pos/refunds', { invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void', items: [{ order_item_id: item.id, qty: 0.5 }] });
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(first.body).toMatchObject({ refund_id: null, table_freed: false, amount_refunded: 0 });
        expect(await netRecipe()).toBe(-300);
        const last = await post('/api/pos/refunds', { invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void',
            ...(finish === 'last item' ? { items: [{ order_item_id: item.id, qty: 1.5 }] } : {}) });
        expect(last.status, JSON.stringify(last.body)).toBe(200);
        expect(last.body).toMatchObject({ refund_id: null, table_freed: true, amount_refunded: 0 });
        expect(await netRecipe()).toBe(0);
        expect(Number((await pool.query('SELECT stock FROM products WHERE id=1'))[0][0].stock)).toBe(100);
        for (const table of ['deleted', 'refunds', 'refund_items']) expect((await pool.query(`SELECT * FROM ${table}`))[0]).toEqual([]);
        expect((await pool.query('SELECT * FROM audit_events ORDER BY id'))[0]).toEqual(auditBefore);
        expect((await pool.query('SELECT * FROM orders WHERE invoice_id=?', [invoiceId]))[0]).toEqual([]);
        expect((await pool.query('SELECT * FROM order_items WHERE invoice_id=?', [invoiceId]))[0]).toEqual([]);
        const jobs = (await pool.query("SELECT payload FROM print_queue WHERE print_type='kitchen' ORDER BY id"))[0].map(row => JSON.parse(row.payload));
        expect(jobs).toHaveLength(2);
        expect(jobs.map(job => job.data.items[0].qty)).toEqual([0.5, 1.5]);
        expect(new Set(jobs.map(job => job.data.print_batch_id)).size).toBe(2);
        expect(jobs.every(job => job.data.void_ticket === true)).toBe(true);
        expect((await post('/api/pos/refunds', { invoice_id: invoiceId, expected_version: await currentTableRevision(invoiceId), intent: 'void' })).status).toBe(404);
        expect(await netRecipe()).toBe(0);
    });

    it('keeps a previous ordinary void when an xyz user clears the remainder', async () => {
        await seedDatabase();
        const cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
        const post = (url, body) => request(app).post(url).set('Cookie', cookie).send(body);
        const saved = await post('/api/pos/table_order', { table_id: 1, cart: [{ id: 2, qty: 2, price: 2 }], subtotal: 4, tax: 0, total: 4 });
        const [[item]] = await pool.query('SELECT id FROM order_items WHERE invoice_id=?', [saved.body.invoice_id]);
        // Body flags cannot suppress server-owned policy for an ordinary actor.
        const normal = await post('/api/pos/refunds', { invoice_id: saved.body.invoice_id, expected_version: await currentTableRevision(saved.body.invoice_id), intent: 'void', xyz: true,
            auditDisabled: true, items: [{ order_item_id: item.id, qty: 0.5 }] });
        expect(normal.status).toBe(200);
        expect(normal.body.refund_id).toBeGreaterThan(0);
        const before = (await pool.query('SELECT * FROM deleted'))[0];
        await pool.query('UPDATE users SET xyz=1 WHERE id=1');
        const last = await post('/api/pos/refunds', { invoice_id: saved.body.invoice_id, expected_version: await currentTableRevision(saved.body.invoice_id), intent: 'void' });
        expect(last.status).toBe(200);
        expect((await pool.query('SELECT * FROM deleted'))[0]).toEqual(before);
        expect((await pool.query('SELECT * FROM refunds'))[0]).toHaveLength(1);
        expect((await pool.query('SELECT * FROM refund_items'))[0]).toHaveLength(1);
        expect((await pool.query("SELECT * FROM audit_events WHERE event_type='void_order'"))[0]).toHaveLength(1);
    });

    it('does not turn xyz into permission to void a saved table', async () => {
        await seedDatabase();
        const admin = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
        const cashier = (await request(app).post('/api/auth/login').send({ user_number: '9002' })).headers['set-cookie'][0];
        const saved = await request(app).post('/api/pos/table_order').set('Cookie', admin)
            .send({ table_id: 1, cart: [{ id: 2, qty: 1, price: 2 }], subtotal: 2, tax: 0, total: 2 });
        await pool.query('UPDATE users SET xyz=1 WHERE id=2');
        const res = await request(app).post('/api/pos/refunds').set('Cookie', cashier)
            .send({ invoice_id: saved.body.invoice_id, expected_version: await currentTableRevision(saved.body.invoice_id), intent: 'void' });
        expect(res.status).toBe(403);
        expect((await pool.query('SELECT * FROM orders WHERE invoice_id=?', [saved.body.invoice_id]))[0][0].payment_method).toBe('unpaid_table');
        expect((await pool.query('SELECT * FROM refunds'))[0]).toEqual([]);
    });

    it('rolls back an unrecorded whole-table void before allowing a retry', async () => {
        await seedDatabase();
        const cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
        const post = (url, body) => request(app).post(url).set('Cookie', cookie).send(body);
        await pool.query('UPDATE users SET xyz=1 WHERE id=1');
        await pool.query('UPDATE products SET stock=100 WHERE id=2');
        await post('/api/system/settings', { stock_enabled: '1' });
        const saved = await post('/api/pos/table_order', { table_id: 1, cart: [{ id: 2, qty: 2, price: 2 }], subtotal: 4, tax: 0, total: 4 });
        expect(saved.status).toBe(200);
        const state = async () => ({
            orders: (await pool.query('SELECT * FROM orders'))[0], items: (await pool.query('SELECT * FROM order_items'))[0],
            table: (await pool.query('SELECT * FROM restaurant_tables WHERE id=1'))[0],
            stock: (await pool.query('SELECT id,stock,stock_version FROM products ORDER BY id'))[0],
            movements: (await pool.query('SELECT * FROM stock_movements ORDER BY id'))[0],
        });
        const before = await state(), original = pool.getConnection.bind(pool);
        const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
            const conn = await original(), query = conn.query, release = conn.release;
            conn.query = function(sql, params) {
                if (String(sql).startsWith('DELETE FROM orders')) throw new Error('Injected unrecorded-void delete failure');
                return query.call(this, sql, params);
            };
            conn.release = function() { conn.query = query; conn.release = release; return release.call(this); };
            return conn;
        });
        try { expect((await post('/api/pos/refunds', { invoice_id: saved.body.invoice_id, expected_version: await currentTableRevision(saved.body.invoice_id), intent: 'void' })).status).toBe(500); }
        finally { spy.mockRestore(); }
        expect(await state()).toEqual(before);
        for (const table of ['deleted', 'refunds', 'refund_items']) expect((await pool.query(`SELECT * FROM ${table}`))[0]).toEqual([]);
        expect((await post('/api/pos/refunds', { invoice_id: saved.body.invoice_id, expected_version: await currentTableRevision(saved.body.invoice_id), intent: 'void' })).status).toBe(200);
        expect(Number((await pool.query('SELECT stock FROM products WHERE id=2'))[0][0].stock)).toBe(100);
    });
});
