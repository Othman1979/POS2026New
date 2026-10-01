const request = require('supertest');
const pool = require('../../config/db');
const { app } = require('../../../server');
const { seedDatabase } = require('../fixtures/seed');

const RESPONSE_KEYS = [
    'id', 'reference_name', 'cart_data', 'subtotal', 'created_at',
    'table_id', 'parent_invoice_id', 'cashier_name', 'paid_split_count',
    'receipt_display_v1', 'receipt_display_error'
].sort();
const SECRET_OR_UNUSED = ['claim_token_hash', 'last_operation_result', 'kitchen_snapshot',
    'user_id', 'hold_request_id', 'claimed_by_user_id', 'claim_expires_at', 'kitchen_dispatch_version',
    'last_operation_id', 'last_operation_kind', 'call_center_user_id', 'kitchen_fired', 'service_charge_snapshot_id', 'updated_at'];
const LEGACY_PAID_COUNT_SQL = `SELECT h.id,
    (SELECT COUNT(*) FROM orders paid
      WHERE paid.parent_invoice_id=h.parent_invoice_id
        AND paid.payment_method IN ('cash','card','split')) AS paid_split_count
    FROM held_orders h WHERE (h.parent_invoice_id IS NOT NULL OR h.table_id IS NOT NULL)`;

let admin, parent, orphanParent;
beforeEach(async () => {
    await seedDatabase();
    const [order] = await pool.query("INSERT INTO orders(user_id,table_id,subtotal,tax,total,payment_method) VALUES(1,1,6,0,6,'unpaid_table')");
    parent = order.insertId;
    await pool.query("UPDATE restaurant_tables SET current_order_id=?,status='occupied' WHERE id=1", [parent]);
    const cart = seat => JSON.stringify({
        items: [{ id: 2, product_id: 2, name: 'Drink', qty: 1, price: 2, tax_rate: 0, cartId: `c${seat}` }],
        progressive_split_version: 2, parent_invoice_id: parent, table_id: 1, tax_inclusive_at_sale: 0, split_role: seat === 1 ? 'remainder' : 'check'
    });
    await pool.query(`INSERT INTO held_orders(user_id,reference_name,subtotal,cart_data,parent_invoice_id,table_id,
        claim_token_hash,kitchen_snapshot,last_operation_id,last_operation_kind,last_operation_result,claimed_by_user_id,claim_expires_at) VALUES ?`,
        [[1, 2, 3].map(seat => [1, `Table 1 - Seat ${seat}`, 2, cart(seat), parent, 1,
            'a'.repeat(64), '{"secret":"kitchen"}', 'op-1', 'hold', '{"secret":"result"}', 1, '2030-01-01 00:00:00'])]);
    for (const method of ['cash', 'card', 'split', 'unpaid_table', 'voided']) {
        await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,parent_invoice_id) VALUES(1,2,0,2,?,?)", [method, parent]);
    }
    const [orphan] = await pool.query("INSERT INTO orders(user_id,table_id,subtotal,tax,total,payment_method) VALUES(1,2,2,0,2,'unpaid_table')");
    orphanParent = orphan.insertId;
    await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,parent_invoice_id) VALUES(1,2,0,2,'cash',?)", [orphanParent]);
    await pool.query("INSERT INTO held_orders(user_id,reference_name,subtotal,cart_data,table_id) VALUES(1,'Table 2',2,?,2)",
        ['{"items":[{"id":2,"product_id":2,"name":"Drink","qty":1,"price":2,"tax_rate":0}],"tax_inclusive_at_sale":0}']);
    admin = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
});
afterAll(() => pool.end());

it('returns only the whitelisted split fields with the legacy paid-child count semantics', async () => {
    const response = await request(app).get('/api/pos/table_splits').set('Cookie', admin);
    expect(response.statusCode).toBe(200);
    expect(response.body.data).toHaveLength(4);
    const [oracle] = await pool.query(LEGACY_PAID_COUNT_SQL);
    const expectedCounts = new Map(oracle.map(row => [row.id, Number(row.paid_split_count)]));
    for (const row of response.body.data) {
        expect(Object.keys(row).sort()).toEqual(RESPONSE_KEYS);
        for (const key of SECRET_OR_UNUSED) expect(row).not.toHaveProperty(key);
        expect(JSON.stringify(row)).not.toContain('secret');
        expect(JSON.stringify(row)).not.toContain('a'.repeat(64));
        expect(row.paid_split_count).toBe(expectedCounts.get(row.id));
        expect(row.receipt_display_v1).toBeTruthy();
        expect(row.receipt_display_v1.summary.total).toBe(2);
        expect(row.receipt_display_error).toBeNull();
        expect(row.cashier_name).toEqual(expect.any(String));
    }
    const splits = response.body.data.filter(row => row.parent_invoice_id === parent);
    expect(splits).toHaveLength(3);
    expect(splits.every(row => row.paid_split_count === 3 && row.table_id === 1)).toBe(true);
    const legacy = response.body.data.find(row => row.parent_invoice_id === null);
    expect(legacy.table_id).toBe(2);
    expect(legacy.paid_split_count).toBe(0);
    expect(splits.map(row => Number(row.subtotal))).toEqual([2, 2, 2]);
});

it('keeps the parent filter and count with a targeted read', async () => {
    const response = await request(app).get(`/api/pos/table_splits?parent_invoice_id=${parent}`).set('Cookie', admin);
    expect(response.statusCode).toBe(200);
    expect(response.body.data).toHaveLength(3);
    const [oracle] = await pool.query(`${LEGACY_PAID_COUNT_SQL} AND h.parent_invoice_id=?`, [parent]);
    expect(response.body.data.map(row => [row.id, row.paid_split_count]).sort((a, b) => a[0] - b[0]))
        .toEqual(oracle.map(row => [row.id, Number(row.paid_split_count)]).sort((a, b) => a[0] - b[0]));
    for (const row of response.body.data) expect(Object.keys(row).sort()).toEqual(RESPONSE_KEYS);
});
