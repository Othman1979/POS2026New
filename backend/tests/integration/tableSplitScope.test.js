const request = require('supertest');
const pool = require('../../config/db');
const { app } = require('../../../server');
const { seedDatabase } = require('../fixtures/seed');
let admin, waiter, parents;
beforeEach(async () => {
    await seedDatabase();
    await pool.query("INSERT INTO sections(id,name) VALUES(2,'Other section')");
    await pool.query("UPDATE restaurant_tables SET section_id=2,table_number='1' WHERE id=2");
    parents = [];
    for (const tableId of [1, 2]) {
        const [order] = await pool.query("INSERT INTO orders(user_id,table_id,subtotal,tax,total,payment_method) VALUES(1,?,4,0,4,'unpaid_table')", [tableId]);
        parents.push(order.insertId);
        await pool.query("UPDATE restaurant_tables SET current_order_id=?,status='occupied' WHERE id=?", [order.insertId, tableId]);
        const cart = JSON.stringify({ items: [{ id: 2, product_id: 2, name: 'Drink', qty: 1, price: 2, tax_rate: 0 }], progressive_split_version: 2, parent_invoice_id: order.insertId, table_id: tableId, tax_inclusive_at_sale: 0 });
        await pool.query('INSERT INTO held_orders(user_id,reference_name,subtotal,cart_data,parent_invoice_id,table_id) VALUES ?',
            [[1, 2].map(seat => [1, `Table 1 - Seat ${seat}`, 2, cart, order.insertId, tableId])]);
    }
    await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,parent_invoice_id) VALUES(1,2,0,2,'card',?)", [parents[0]]);
    admin = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
    waiter = (await request(app).post('/api/auth/login').send({ user_number: '9003' })).headers['set-cookie'][0];
});
afterAll(() => pool.end());
const read = (cookie, parent) => request(app).get(`/api/pos/table_splits?parent_invoice_id=${parent}`).set('Cookie', cookie);

it('returns only the requested bill with its presentation and paid-child protections', async () => {
    const response = await read(admin, parents[0]);
    expect(response.statusCode).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data.every(row => row.parent_invoice_id === parents[0] && row.paid_split_count === 1 && row.receipt_display_v1 && !row.receipt_display_error)).toBe(true);
    const all = await request(app).get('/api/pos/table_splits').set('Cookie', admin);
    expect(all.body.data).toHaveLength(4);
    const missing = await read(admin, 999999);
    expect(missing.statusCode).toBe(200);
    expect(missing.body.data).toEqual([]);
    const cancel = await request(app).delete('/api/pos/table_splits?id=' + response.body.data[0].id).set('Cookie', admin);
    expect(cancel.statusCode).toBe(409);
    expect(cancel.body.code).toBe('SPLIT_ALREADY_PAID');
});

it('keeps root and group-member section guards on targeted reads', async () => {
    const hidden = await read(waiter, parents[1]);
    expect(hidden.statusCode).toBe(200);
    expect(hidden.body.data).toEqual([]);
    await pool.query("INSERT INTO restaurant_tables(id,section_id,table_number,parent_table_id,current_order_id,status) VALUES(3,2,'3',1,?,'occupied')", [parents[0]]);
    const mixed = await read(waiter, parents[0]);
    expect(mixed.statusCode).toBe(200);
    expect(mixed.body.data).toEqual([]);
    expect((await read(admin, parents[0])).body.data).toHaveLength(2);
});

it('rejects malformed filters instead of silently expanding to every bill', async () => {
    for (const raw of ['', '0', '-1', '1oops', '1.5', '9007199254740992', '1&parent_invoice_id=2', '1%20OR%201=1']) {
        const response = await read(admin, raw);
        expect(response.statusCode, raw).toBe(400);
        expect(response.body.data).toBeUndefined();
    }
});
