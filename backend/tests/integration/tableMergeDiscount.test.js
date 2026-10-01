const { tableActionIntent } = require('../fixtures/tableActionIntent');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('table merge order-discount boundary', () => {
    let cookie;
    const cart = [{ id: SEED.product2.id, qty: 2, price: 2, tax_rate: 0 }];
    const fixed = { type: 'fixed', value: 1 };
    const percent = { type: 'percent', value: 25 };
    const post = (path, body) => request(app).post(`/api/pos/${path}`).set('Cookie', cookie).send(body);
    const action = async (name = 'merge') => post('tables/transfer', await tableActionIntent(pool, {
        sourceTableId: SEED.table.id, targetTableId: SEED.table2.id, action: name
    }));
    const save = async (tableId, discount = null, items = cart) => {
        const subtotal = items.reduce((sum, item) => sum + item.qty * item.price, 0);
        const reduction = discount?.type === 'percent'
            ? subtotal * discount.value / 100 : (discount?.value || 0);
        const response = await post('table_order', {
            table_id: tableId, cart: items, subtotal, tax: 0, total: subtotal - reduction,
            order_discount_type: discount?.type ?? null,
            order_discount_value: discount?.value ?? 0
        });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        return response.body.invoice_id;
    };
    const billState = async () => {
        const [orders] = await pool.query('SELECT * FROM orders ORDER BY invoice_id');
        const [items] = await pool.query('SELECT * FROM order_items ORDER BY id');
        const [tables] = await pool.query('SELECT * FROM restaurant_tables ORDER BY id');
        const [audits] = await pool.query("SELECT * FROM audit_events WHERE event_type='table_merge' ORDER BY id");
        return { orders, items, tables, audits };
    };

    beforeEach(async () => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        cookie = login.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    it.each([
        ['source fixed', fixed, null, 7],
        ['target fixed', null, fixed, 7],
        ['both fixed', fixed, fixed, 6],
        ['source percent', percent, null, 7],
        ['target percent', null, percent, 7],
        ['both percent', percent, percent, 6],
        ['mixed rules', fixed, percent, 6],
        ['fully discounted source', { type: 'percent', value: 100 }, null, 4]
    ])('rejects %s without changing either bill or table', async (_name, sourceDiscount, targetDiscount, total) => {
        await save(SEED.table.id, sourceDiscount);
        await save(SEED.table2.id, targetDiscount);
        const before = await billState();
        expect(before.orders.reduce((sum, order) => sum + Number(order.total), 0)).toBe(total);
        global.__mockEmit__.mockClear();

        const response = await action();

        expect(response.statusCode, JSON.stringify(response.body)).toBe(409);
        expect(response.body.code).toBe('ORDER_DISCOUNT_MERGE_CONFLICT');
        expect(await billState()).toEqual(before);
        expect(global.__mockEmit__).not.toHaveBeenCalled();
    });

    it('still merges bills with zero-valued order-discount rules', async () => {
        const source = await save(SEED.table.id, { type: 'fixed', value: 0 });
        const target = await save(SEED.table2.id, { type: 'percent', value: 0 });

        const response = await action();

        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        const state = await billState();
        expect(state.orders).toHaveLength(1);
        expect(state.orders[0].invoice_id).toBe(target);
        expect(Number(state.orders[0].total)).toBe(8);
        expect(state.items.reduce((sum, item) => sum + Number(item.quantity), 0)).toBe(4);
        expect(state.audits).toHaveLength(1);
        expect(state.audits[0].entity_id).toBe(source);
    });

    it('still combines line discounts without adding an order-discount rule', async () => {
        // Line discounts are carried with their lines; the conflict concerns the
        // single order-wide rule, which cannot retain two separate bill scopes.
        const line = { ...cart[0], discountType: 'percent', discountValue: 25 };
        const source = await post('table_order', { table_id: SEED.table.id, cart: [line], subtotal: 3, tax: 0, total: 3 });
        const target = await post('table_order', { table_id: SEED.table2.id, cart: [line], subtotal: 3, tax: 0, total: 3 });
        expect(source.statusCode, JSON.stringify(source.body)).toBe(200);
        expect(target.statusCode, JSON.stringify(target.body)).toBe(200);

        const response = await action();

        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        const state = await billState();
        expect(state.orders).toHaveLength(1);
        expect(Number(state.orders[0].total)).toBe(6);
        expect(state.items.reduce((sum, item) => sum + Number(item.quantity), 0)).toBe(4);
        expect(state.items.every(item => item.discount_type === 'percent' && Number(item.discount_value) === 25)).toBe(true);
    });

    it('still transfers a discounted bill to an empty table', async () => {
        const source = await save(SEED.table.id, fixed);
        const before = await billState();

        const response = await action('transfer');

        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        const after = await billState();
        expect(after.orders).toEqual([{ ...before.orders[0], table_id: SEED.table2.id }]);
        expect(after.items).toEqual(before.items);
        expect(after.tables.find(table => table.id === SEED.table2.id).current_order_id).toBe(source);
        expect(after.tables.find(table => table.id === SEED.table.id).current_order_id).toBeNull();
    });

    it('still swaps discounted bills without repricing them', async () => {
        const source = await save(SEED.table.id, fixed);
        const target = await save(SEED.table2.id, percent);
        const before = await billState();

        const response = await action('swap');

        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        const after = await billState();
        expect(after.orders).toEqual(before.orders.map(order => ({
            ...order, table_id: order.invoice_id === source ? SEED.table2.id : SEED.table.id
        })));
        expect(after.items).toEqual(before.items);
        expect(after.tables.map(table => table.current_order_id)).toEqual([target, source]);
    });

    it('can retry a rejected merge and then pay both original bills without changing their charges', async () => {
        const opened = await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie)
            .send({ user_id: SEED.adminUser.id, starting_cash: 20 });
        expect(opened.statusCode, JSON.stringify(opened.body)).toBe(200);
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.adminUser.id]);
        const source = await save(SEED.table.id, fixed);
        const target = await save(SEED.table2.id);
        const before = await billState();

        for (let attempt = 0; attempt < 2; attempt++) {
            const rejected = await action();
            expect(rejected.statusCode, JSON.stringify(rejected.body)).toBe(409);
            expect(rejected.body.code).toBe('ORDER_DISCOUNT_MERGE_CONFLICT');
        }
        expect(await billState()).toEqual(before);

        for (const [invoiceId, tableId, total, discount] of [
            [source, SEED.table.id, 3, fixed], [target, SEED.table2.id, 4, null]
        ]) {
            const loaded = await request(app).get(`/api/pos/table_order?order_id=${invoiceId}`).set('Cookie', cookie);
            expect(loaded.statusCode, JSON.stringify(loaded.body)).toBe(200);
            const paid = await post('checkout', {
                edit_invoice_id: invoiceId, table_id: tableId, shift_id: shift.id,
                cart: loaded.body.cart, subtotal: 4, tax: 0, total,
                order_discount_type: discount?.type ?? null, order_discount_value: discount?.value ?? 0,
                payment_method: 'cash', amount_tendered: total, change_due: 0
            });
            expect(paid.statusCode, JSON.stringify(paid.body)).toBe(200);
        }
        const after = await billState();
        expect(after.orders.map(order => [order.invoice_id, order.payment_method, Number(order.total)]))
            .toEqual([[source, 'cash', 3], [target, 'cash', 4]]);
        expect(after.tables.every(table => table.status === 'available' && table.current_order_id == null)).toBe(true);
        expect(after.audits).toEqual([]);
        const closed = await request(app).put('/api/auth/shifts?action=close').set('Cookie', cookie)
            .send({ shift_id: shift.id, actual_cash: 27 });
        expect(closed.statusCode, JSON.stringify(closed.body)).toBe(200);
        const [[closedShift]] = await pool.query('SELECT status, expected_cash, actual_cash FROM shifts WHERE id=?', [shift.id]);
        expect(closedShift.status).toBe('closed');
        expect(Number(closedShift.expected_cash)).toBe(27);
        expect(Number(closedShift.actual_cash)).toBe(27);
    });
});
