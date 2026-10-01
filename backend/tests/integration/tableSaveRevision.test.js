const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const { tableActionIntent } = require('../fixtures/tableActionIntent');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { recomputeOrderTotals } = require('../../services/OrderPricing');

describe('table save expected revision', () => {
    let cookie;
    const post = (path, body) => request(app).post(`/api/pos/${path}`).set('Cookie', cookie).send(body);
    const ok = response => {
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        return response.body;
    };
    const create = async (tableId = 1) => ok(await post('table_order', {
        table_id: tableId, cart: [{ id: 2, qty: 2, price: 2, tax_rate: 0 }], subtotal: 4, tax: 0, total: 4
    }));
    const load = async invoiceId => ok(await request(app).get(`/api/pos/table_order?order_id=${invoiceId}`).set('Cookie', cookie));
    const edit = (loaded, extra = {}) => post('table_order', {
        table_id: 1, current_order_id: loaded.invoice_id, expected_version: loaded.version ?? 1,
        cart: loaded.cart, subtotal: 4, tax: 0, total: 4,
        order_discount_type: loaded.order_discount_type, order_discount_value: loaded.order_discount_value,
        ...extra
    });
    const state = async () => {
        const result = {};
        for (const table of ['orders', 'order_items', 'restaurant_tables', 'audit_events', 'products', 'stock_movements', 'service_charge_snapshots']) {
            result[table] = (await pool.query(`SELECT * FROM ${table}`))[0];
        }
        return result;
    };
    const discount = { order_discount_type: 'fixed', order_discount_value: 1, total: 3 };
    beforeEach(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    it('rejects the old same-item cart after another terminal saves a discount, then permits a reviewed reload', async () => {
        const created = await create();
        const a = await load(created.invoice_id);
        ok(await edit(a, discount));
        const before = await state();
        global.__mockEmit__.mockClear();
        for (let attempt = 0; attempt < 2; attempt++) {
            const stale = await edit(a);
            expect(stale.statusCode, JSON.stringify(stale.body)).toBe(409);
            expect(stale.body.code).toBe('TABLE_ORDER_VERSION_CONFLICT');
            expect(await state()).toEqual(before);
        }
        expect(global.__mockEmit__).not.toHaveBeenCalled();
        const fresh = await load(created.invoice_id);
        expect(fresh.version).toBe((a.version ?? 1) + 1);
        expect(fresh.order_discount_value).toBe(1);
        const saved = ok(await edit(fresh, { total: 3 }));
        expect(saved.version).toBe(fresh.version + 1);
        const [[order]] = await pool.query('SELECT total,discount_value FROM orders WHERE invoice_id=?', [created.invoice_id]);
        expect([order.total, order.discount_value].map(Number)).toEqual([3, 1]);
    });

    it.each([undefined, null, '', 0, -1, 1.5, true, [], {}, '1x'])('requires a valid expected revision (%j) even with matching item identities', async version => {
        const created = await create();
        const loaded = await load(created.invoice_id);
        const before = await state();
        const response = await edit(loaded, { expected_version: version });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(409);
        expect(response.body.code).toBe('TABLE_ORDER_VERSION_CONFLICT');
        expect(await state()).toEqual(before);
    });

    it('lets only one concurrent save of the same revision commit', async () => {
        const loaded = await load((await create()).invoice_id);
        const responses = await Promise.all([edit(loaded, discount), edit(loaded, discount)]);
        expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
        const current = await load(loaded.invoice_id);
        expect(current.version).toBe((loaded.version ?? 1) + 1);
        expect(current.order_discount_value).toBe(1);
    });

    it('invalidates a previously loaded cart when a merge changes the surviving bill', async () => {
        const loaded = await load((await create()).invoice_id);
        await create(2);
        ok(await post('tables/transfer', await tableActionIntent(pool, { sourceTableId: 2, targetTableId: 1, action: 'merge' })));
        const response = await edit(loaded, { cart: loaded.cart.map(item => ({ ...item, qty: 4 })), subtotal: 8, total: 8 });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(409);
        expect(response.body.code).toBe('TABLE_ORDER_VERSION_CONFLICT');
    });

    it('invalidates a previously loaded cart after the existing catalog-healing recalculation', async () => {
        const loaded = await load((await create()).invoice_id);
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await recomputeOrderTotals(conn, loaded.invoice_id);
            await conn.commit();
        } finally { conn.release(); }
        const response = await edit(loaded);
        expect(response.statusCode, JSON.stringify(response.body)).toBe(409);
        expect(response.body.code).toBe('TABLE_ORDER_VERSION_CONFLICT');
    });

    it('rolls back the revision and money when item persistence fails, then allows the original retry', async () => {
        const loaded = await load((await create()).invoice_id);
        const before = await state();
        const acquire = pool.getConnection;
        let released = 0;
        pool.getConnection = async function (...args) {
            const conn = await acquire.apply(this, args);
            const query = conn.query, release = conn.release;
            conn.query = async function (sql, ...values) {
                if (String(sql).includes('DELETE FROM order_items WHERE invoice_id=')) throw new Error('Injected item persistence failure');
                return query.call(this, sql, ...values);
            };
            conn.release = function () { released++; conn.query = query; conn.release = release; return release.call(this); };
            return conn;
        };
        try { expect((await edit(loaded, discount)).statusCode).toBe(500); }
        finally { pool.getConnection = acquire; }
        expect(released).toBe(1);
        expect(await state()).toEqual(before);
        expect(ok(await edit(loaded, discount)).version).toBe(loaded.version + 1);
    });

    it('rejects a pre-void draft, and a reloaded remainder can be saved and paid at the saved discount', async () => {
        ok(await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: 1, starting_cash: 20 }));
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=1 AND status='open'");
        const created = await create();
        const original = await load(created.invoice_id);
        ok(await edit(original, discount));
        const discounted = await load(created.invoice_id);
        ok(await post('refunds', { invoice_id: created.invoice_id, expected_version: await currentTableRevision(created.invoice_id), intent: 'void', reason: 'One cancelled drink', items: [{ order_item_id: discounted.cart[0].order_item_id, qty: 1 }] }));
        const stale = await edit(discounted, { total: 3 });
        expect(stale.statusCode).toBe(409);
        expect(stale.body.code).toBe('TABLE_ORDER_VERSION_CONFLICT');
        const fresh = await load(created.invoice_id);
        expect(fresh.version).toBe(discounted.version + 1);
        expect(fresh.cart[0].qty).toBe(1);
        ok(await edit(fresh, { subtotal: 2, total: 1 }));
        const payable = await load(created.invoice_id);
        ok(await post('checkout', { table_id: 1, edit_invoice_id: created.invoice_id, shift_id: shift.id, cart: payable.cart,
            subtotal: 2, tax: 0, total: 1, order_discount_type: 'fixed', order_discount_value: 1,
            payment_method: 'cash', amount_tendered: 1, change_due: 0 }));
        const [[table]] = await pool.query('SELECT status,current_order_id FROM restaurant_tables WHERE id=1');
        expect(table).toEqual({ status: 'available', current_order_id: null });
        ok(await request(app).put('/api/auth/shifts?action=close').set('Cookie', cookie).send({ shift_id: shift.id, actual_cash: 21 }));
        const [[closed]] = await pool.query('SELECT expected_cash,actual_cash FROM shifts WHERE id=?', [shift.id]);
        expect([closed.expected_cash, closed.actual_cash].map(Number)).toEqual([21, 21]);
    });

    it('treats a historical null revision as 1 and advances it on save', async () => {
        const created = await create();
        await pool.query('UPDATE orders SET version=NULL WHERE invoice_id=?', [created.invoice_id]);
        const loaded = await load(created.invoice_id);
        expect(loaded.version).toBe(1);
        expect(ok(await edit(loaded)).version).toBe(2);
    });

    it('invalidates a draft when splitting backfills historical accounting, even after the split is cancelled', async () => {
        const created = await create();
        // The current schema allows a historical null accounting flag; its
        // registration column is NOT NULL and must retain a valid enum value.
        await pool.query('UPDATE orders SET tax_inclusive_at_sale=NULL WHERE invoice_id=?', [created.invoice_id]);
        const loaded = await load(created.invoice_id);
        ok(await post('table_splits/split', { tableId: 1, currentOrderId: created.invoice_id,
            splits: [{ referenceName: 'Historical bill', subtotal: 4, items: loaded.cart }] }));
        const [[held]] = await pool.query('SELECT id FROM held_orders WHERE parent_invoice_id=?', [created.invoice_id]);
        ok(await request(app).delete(`/api/pos/table_splits?id=${held.id}`).set('Cookie', cookie));
        const response = await edit(loaded);
        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('TABLE_ORDER_VERSION_CONFLICT');
        const fresh = await load(created.invoice_id);
        expect(fresh.version).toBeGreaterThan(loaded.version);
        ok(await edit(fresh));
    });
});
