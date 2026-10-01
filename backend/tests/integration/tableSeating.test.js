const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { tableActionIntent } = require('../fixtures/tableActionIntent');

describe('seating membership with independent bills', () => {
    let cookie;
    const post = (path, body) => request(app).post(`/api/pos/${path}`).set('Cookie', cookie).send(body);
    const ok = response => { expect(response.statusCode, JSON.stringify(response.body)).toBe(200); return response.body; };
    const create = async (tableId, qty = 2) => ok(await post('table_order', {
        table_id: tableId, cart: [{ id: 2, name: 'Test Drink', qty, price: 2, tax_rate: 0 }], subtotal: qty * 2, tax: 0, total: qty * 2
    }));
    const join = (parent = 1, children = [2]) => post('tables/join', { parentTableId: parent, childTableIds: children });
    const load = async id => ok(await request(app).get(`/api/pos/table_order?order_id=${id}`).set('Cookie', cookie));
    const bills = async () => {
        const state = {};
        for (const table of ['orders', 'order_items', 'held_orders', 'products', 'stock_movements', 'service_charge_snapshots']) {
            state[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY 1`))[0];
        }
        return state;
    };
    const seats = async () => (await pool.query('SELECT id,current_order_id,parent_table_id,seating_parent_id,status FROM restaurant_tables ORDER BY id'))[0];
    beforeEach(async () => {
        await seedDatabase();
        await pool.query("INSERT INTO restaurant_tables(id,section_id,table_number) VALUES(3,1,'3'),(4,1,'4')");
        cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
    });
    afterAll(() => pool.end());

    it('joins occupied bills without changing money, item identities, waiter ownership or stock', async () => {
        const a = await create(1), b = await create(2, 3);
        await pool.query('UPDATE orders SET waiter_id=CASE WHEN invoice_id=? THEN 3 ELSE 1 END WHERE invoice_id IN (?,?)', [a.invoice_id, a.invoice_id, b.invoice_id]);
        const before = await bills();
        ok(await join());
        expect(await bills()).toEqual(before);
        expect(await seats()).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 1, current_order_id: a.invoice_id, parent_table_id: null, seating_parent_id: null }),
            expect.objectContaining({ id: 2, current_order_id: b.invoice_id, parent_table_id: null, seating_parent_id: 1 })
        ]));
        expect((await load(b.invoice_id)).cart[0].qty).toBe(3);
        const floor = ok(await request(app).get('/api/pos/get_tables').set('Cookie', cookie));
        expect(floor.tables.find(row => row.id === 2)).toMatchObject({ current_order_id: b.invoice_id, seating_parent_id: 1 });
    });

    it('opens and edits separate bills on seats joined while empty', async () => {
        ok(await join());
        const a = await create(1), b = await create(2, 3);
        expect(b.invoice_id).not.toBe(a.invoice_id);
        const loaded = await load(b.invoice_id);
        ok(await post('table_order', { table_id: 2, current_order_id: b.invoice_id, expected_version: loaded.version,
            cart: loaded.cart, subtotal: 6, tax: 0, total: 5, order_discount_type: 'fixed', order_discount_value: 1 }));
        const [orders] = await pool.query('SELECT invoice_id,table_id,total FROM orders ORDER BY invoice_id');
        expect(orders.map(row => [row.invoice_id, row.table_id, Number(row.total)])).toEqual([[a.invoice_id, 1, 4], [b.invoice_id, 2, 5]]);
    });

    it('separates seating without releasing either independent bill', async () => {
        await create(1); await create(2, 3); ok(await join());
        const before = await bills();
        ok(await post('tables/disjoin', { tableIds: [2] }));
        expect(await bills()).toEqual(before);
        expect((await seats()).slice(0, 2).every(row => row.current_order_id && row.status === 'occupied' && row.seating_parent_id == null)).toBe(true);
    });

    it('keeps shared issued bill aliases after seating separation', async () => {
        const a = await create(1);
        // This is the billing shape issued before seating and billing were separated.
        await pool.query("UPDATE restaurant_tables SET parent_table_id=1,current_order_id=?,status='occupied' WHERE id=2", [a.invoice_id]);
        ok(await join()); const before = await bills();
        ok(await post('tables/disjoin', { tableIds: [2] }));
        expect(await bills()).toEqual(before);
        expect((await seats())[1]).toMatchObject({ parent_table_id: 1, current_order_id: a.invoice_id, seating_parent_id: null });
        expect((await load(a.invoice_id)).cart).toHaveLength(1);
    });

    it.each([1, 2])('excludes a printed source or target (%s) on the server', async printedId => {
        await create(1); await create(2);
        await pool.query("UPDATE restaurant_tables SET status='printed' WHERE id=?", [printedId]);
        const before = await bills();
        const response = await join();
        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('TABLE_CHECK_PRINTED');
        expect(await bills()).toEqual(before);
    });

    it('combines seating groups without changing their four separate bills', async () => {
        for (const id of [1, 2, 3, 4]) await create(id, id);
        ok(await join(1, [2])); ok(await join(3, [4]));
        const before = await bills(); ok(await join(1, [3]));
        expect(await bills()).toEqual(before);
        expect((await seats()).map(row => row.seating_parent_id)).toEqual([null, 1, 1, 1]);
    });

    it('rejects a printed hidden member and cross-section membership without partial changes', async () => {
        for (const id of [1, 2, 3, 4]) await create(id);
        ok(await join(3, [4]));
        await pool.query("UPDATE restaurant_tables SET status='printed' WHERE id=4");
        const before = await seats();
        expect((await join(1, [3])).body.code).toBe('TABLE_CHECK_PRINTED');
        expect(await seats()).toEqual(before);
        await pool.query("UPDATE restaurant_tables SET status='occupied' WHERE id=4");
        await pool.query("INSERT INTO sections(id,name) VALUES(2,'Hidden')");
        await pool.query('UPDATE restaurant_tables SET section_id=2 WHERE id=4');
        cookie = (await request(app).post('/api/auth/login').send({ user_number: '9003' })).headers['set-cookie'][0];
        expect((await join(1, [3])).statusCode).toBe(403);
    });

    it('settles one bill and preserves its occupied seating neighbor', async () => {
        const a = await create(1), b = await create(2, 3); ok(await join());
        ok(await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: 1, starting_cash: 0 }));
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=1 AND status='open'");
        const loaded = await load(a.invoice_id);
        ok(await post('checkout', { table_id: 1, edit_invoice_id: a.invoice_id, shift_id: shift.id, cart: loaded.cart,
            subtotal: 4, tax: 0, total: 4, payment_method: 'card', amount_received: 4 }));
        expect((await seats()).slice(0, 2)).toEqual([
            expect.objectContaining({ id: 1, current_order_id: null, status: 'available' }),
            expect.objectContaining({ id: 2, current_order_id: b.invoice_id, status: 'occupied', seating_parent_id: 1 })
        ]);
        expect((await load(b.invoice_id)).cart[0].qty).toBe(3);
    });

    it('moves a joined independent bill without overwriting the neighboring bill', async () => {
        const a = await create(1), b = await create(2, 3); ok(await join());
        const intent = await tableActionIntent(pool, { sourceTableId: 2, targetTableId: 3, action: 'transfer' });
        ok(await post('tables/transfer', intent));
        const rows = await seats();
        expect(rows[0].current_order_id).toBe(a.invoice_id);
        expect(rows[1]).toMatchObject({ current_order_id: null, seating_parent_id: 1 });
        expect(rows[2].current_order_id).toBe(b.invoice_id);
    });

    it('marks and voids only the selected bill while preserving seating and its neighbor', async () => {
        const a = await create(1), b = await create(2, 3); ok(await join());
        ok(await post('table_order', { action: 'mark_printed', table_id: 2, expected_invoice_id: b.invoice_id }));
        expect((await seats()).slice(0, 2).map(row => row.status)).toEqual(['occupied', 'printed']);
        ok(await post('refunds', { invoice_id: b.invoice_id, expected_version: await currentTableRevision(b.invoice_id), intent: 'void', reason: 'Cancelled' }));
        expect((await seats()).slice(0, 2)).toEqual([
            expect.objectContaining({ id: 1, current_order_id: a.invoice_id, status: 'occupied' }),
            expect.objectContaining({ id: 2, current_order_id: null, status: 'available', seating_parent_id: 1 })
        ]);
    });

    it('rolls back the whole seating change on audit failure and then safely retries', async () => {
        await create(1); await create(2, 3);
        const before = await bills(), tablesBefore = await seats(), acquire = pool.getConnection.bind(pool);
        let injected = false;
        const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
            const conn = await acquire(), query = conn.query.bind(conn);
            conn.query = (sql, ...args) => {
                if (/INSERT INTO audit_events/.test(String(sql))) { injected = true; throw new Error('Injected seating audit failure'); }
                return query(sql, ...args);
            };
            return conn;
        });
        try { expect((await join()).statusCode).toBe(500); } finally { spy.mockRestore(); }
        expect(injected).toBe(true); expect(await seats()).toEqual(tablesBefore); expect(await bills()).toEqual(before);
        ok(await join()); expect(await bills()).toEqual(before);
    });

    it('allows only one parent when concurrent terminals join the same occupied seat', async () => {
        for (const id of [1, 2, 3]) await create(id);
        const before = await bills();
        const overlapping = pool.pool.config.connectionLimit > 1;
        let release, arrivals = 0;
        const gate = new Promise(resolve => { release = resolve; });
        const acquire = pool.getConnection.bind(pool);
        const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
            const conn = await acquire(), execute = conn.execute.bind(conn);
            conn.execute = async (sql, ...args) => {
                if (overlapping && /SELECT t.id/.test(String(sql)) && /seating_parent_id/.test(String(sql))) {
                    if (++arrivals === 2) release();
                    await gate;
                }
                return execute(sql, ...args);
            };
            return conn;
        });
        let responses;
        try { responses = await Promise.all([join(1, [3]), join(2, [3])]); }
        finally { release(); spy.mockRestore(); }
        if (overlapping) expect(arrivals).toBe(2);
        expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
        expect([1, 2]).toContain((await seats())[2].seating_parent_id);
        expect(await bills()).toEqual(before);
    });

    it('preserves separately split bills while joining and separating their seating', async () => {
        const parents = [await create(1), await create(2)];
        for (let n = 0; n < 2; n++) {
            const bill = await load(parents[n].invoice_id);
            ok(await post('table_splits/split', { tableId: n + 1, currentOrderId: parents[n].invoice_id,
                splits: [1, 2].map(seat => ({ referenceName: `Seat ${seat}`, subtotal: 2, items: [{ ...bill.cart[0], qty: 1 }] })) }));
        }
        const before = await bills(); ok(await join()); expect(await bills()).toEqual(before);
        ok(await post('tables/disjoin', { tableIds: [2] })); expect(await bills()).toEqual(before);
    });
});
