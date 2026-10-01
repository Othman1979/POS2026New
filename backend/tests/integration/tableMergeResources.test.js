const request = require('supertest');
const pool = require('../../config/db');
const { app } = require('../../../server');
const { seedDatabase } = require('../fixtures/seed');
const { tableActionIntent } = require('../fixtures/tableActionIntent');
let cookie;
beforeEach(async () => {
    await seedDatabase();
    cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
});
afterAll(() => pool.end());
const post = (path, data) => request(app).post('/api/pos/' + path).set('Cookie', cookie).send(data);
const merge = async () => post('tables/transfer', await tableActionIntent(pool, { sourceTableId: 1, targetTableId: 2, action: 'merge' }));
async function parent(tableId) {
    const [order] = await pool.query("INSERT INTO orders(user_id,table_id,subtotal,tax,total,payment_method,tax_inclusive_at_sale,tax_registration_type_at_sale) VALUES(1,?,0,0,0,'unpaid_table',0,'sales_tax')", [tableId]);
    await pool.query("UPDATE restaurant_tables SET current_order_id=?,status='occupied' WHERE id=?", [order.insertId, tableId]);
    return order.insertId;
}
async function line(invoice, changes = {}) {
    const row = { invoice_id: invoice, product_id: 2, item_name: 'Drink', quantity: 1, price_at_sale: 2, tax_rate: 0, jofotara_tax_category: 'O', note: '', discount_type: null, discount_value: 0, ...changes };
    const [result] = await pool.query('INSERT INTO order_items SET ?', row);
    return result.insertId;
}

it('bounds merge reads and tax writes while preserving 80 saved lines and their total', async () => {
    const count = 80;
    for (const tableId of [1, 2]) {
        const size = tableId === 1 ? count : 1;
        const response = await post('table_order', { table_id: tableId,
            cart: Array.from({ length: size }, (_, n) => ({ id: 1, name: 'Test Burger', qty: 1, price: 5, note: `${tableId}:${n}` })),
            subtotal: size * 5, tax: size * .8, total: size * 5.8 });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    }
    const getConnection = pool.getConnection.bind(pool), statements = [];
    const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
        const conn = await getConnection();
        const saved = { query: conn.query, execute: conn.execute, release: conn.release };
        for (const method of ['query', 'execute']) conn[method] = async function (sql, ...args) {
            statements.push(String(sql)); return saved[method].call(this, sql, ...args);
        };
        conn.release = function () { Object.assign(conn, saved); return saved.release.call(this); };
        return conn;
    });
    let response;
    try { response = await merge(); } finally { spy.mockRestore(); }
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    const [items] = await pool.query('SELECT quantity,tax_rate,tax_amount FROM order_items');
    expect(items).toHaveLength(81);
    expect(items.every(row => Number(row.quantity) === 1 && Number(row.tax_rate) === 16 && Number(row.tax_amount) === .8)).toBe(true);
    const [[order]] = await pool.query('SELECT total FROM orders');
    expect(Number(order.total)).toBe(469.8);
    expect(statements.filter(sql => /^\s*SELECT/i.test(sql)).length).toBeLessThanOrEqual(20);
    expect(statements.length).toBeLessThanOrEqual(count + 45);
});

it('never quantity-merges an ordinary zero-price line into a persisted bundle child', async () => {
    const source = await parent(1), target = await parent(2);
    const bundle = await line(target, { product_id: 4, item_name: 'Bundle', price_at_sale: 10 });
    const child = await line(target, { item_name: 'Drink', price_at_sale: 0, parent_item_id: bundle });
    await line(source, { item_name: 'Drink', price_at_sale: 0 });
    const response = await merge(); expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    const [rows] = await pool.query('SELECT id,parent_item_id,quantity FROM order_items WHERE invoice_id=? ORDER BY id', [target]);
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.id === child)).toMatchObject({ parent_item_id: bundle, quantity: '1.000000' });
    expect(rows.filter(row => row.parent_item_id == null)).toHaveLength(2);
});

it('retains every saved price, tax, modifier, recipe and stock distinction and coalesces exact new matches', async () => {
    const source = await parent(1), target = await parent(2);
    const stock = id => JSON.stringify({ version: 1, stock_item_id: String(id), qty_per_sale: '1.000000', policy_version: '1' });
    const cost = price => JSON.stringify([{ ingredient_id: 1, qty_per_portion: 1, cost_per_portion: price, complete: true }]);
    const variants = [
        ['product_id', 1, 2], ['item_name', 'DRINK', 'Drink'], ['price_at_sale', 2.5, 2],
        ['price_before_tax_exemption', 2.32, null], ['discount_type', 'percent', null], ['discount_value', 10, 0],
        ['tax_rate', 16, 8], ['jofotara_tax_category', 'Z', 'O'],
        ['selected_modifiers', '[{"option":"A"}]', '[{"option":"a"}]'],
        ['modifier_surcharge', .5, .6], ['modifier_tax_amount', .08, .04],
        ['recipe_line_key', 'a'.repeat(32), 'b'.repeat(32)],
        ['recipe_cost_snapshot', cost(2), cost(3)], ['stock_authority', 'none', 'legacy'],
        ['stock_snapshot', stock(1), stock(2)],
    ];
    const expected = [];
    for (const [field, left, right] of variants) {
        const common = { note: 'identity:' + field, ...(field === 'stock_snapshot' ? { stock_authority: 'product' } : {}) };
        await line(source, { ...common, [field]: left });
        await line(target, { ...common, [field]: right });
        expected.push({ field, left, right, note: common.note });
    }
    await line(source, { note: 'new identical', quantity: .125 });
    await line(source, { note: 'new identical', quantity: .375 });
    const response = await merge(); expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    const [rows] = await pool.query('SELECT * FROM order_items WHERE invoice_id=?', [target]);
    for (const { field, left, right, note } of expected) {
        const pair = rows.filter(row => row.note === note);
        expect(pair, field).toHaveLength(2);
        const normalize = value => value == null ? null : ['price_at_sale','price_before_tax_exemption','discount_value','tax_rate','modifier_surcharge','modifier_tax_amount','product_id'].includes(field) ? Number(value) : value;
        expect(pair.map(row => normalize(row[field])).sort(), field).toEqual([normalize(left), normalize(right)].sort());
    }
    const combined = rows.filter(row => row.note === 'new identical');
    expect(combined).toHaveLength(1);
    expect(Number(combined[0].quantity)).toBe(.5);
});

it('rolls back the complete merge after a later tax batch fails and safely retries the same intent', async () => {
    const source = await parent(1), target = await parent(2);
    await pool.query('INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,note) VALUES ?',
        [Array.from({ length: 205 }, (_, i) => [source, 2, 'Drink', 1, 2, `line:${i}`])]);
    await line(target, { note: 'target' });
    const snapshot = async () => {
        const result = {};
        for (const table of ['orders', 'order_items', 'restaurant_tables', 'table_action_operations', 'audit_events', 'stock_movements']) {
            result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY 1`))[0];
        }
        return result;
    };
    const before = await snapshot();
    const intent = await tableActionIntent(pool, { sourceTableId: 1, targetTableId: 2, action: 'merge' });
    const getConnection = pool.getConnection.bind(pool); let batches = 0, releases = 0;
    const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
        const conn = await getConnection(), query = conn.query, release = conn.release;
        conn.query = function (sql, ...args) {
            if (/UPDATE order_items SET tax_rate/.test(String(sql)) && ++batches === 2) throw new Error('Injected second tax-batch failure');
            return query.call(this, sql, ...args);
        };
        conn.release = function () { releases++; conn.query = query; conn.release = release; return release.call(this); };
        return conn;
    });
    let response;
    try { response = await post('tables/transfer', intent); } finally { spy.mockRestore(); }
    expect(response.statusCode).toBe(500);
    expect([batches, releases]).toEqual([2, 1]);
    expect(await snapshot()).toEqual(before);
    const retried = await post('tables/transfer', intent);
    expect(retried.statusCode, JSON.stringify(retried.body)).toBe(200);
    const [[order]] = await pool.query('SELECT total FROM orders WHERE invoice_id=?', [target]);
    expect(Number(order.total)).toBe(412);
    expect((await pool.query("SELECT id FROM audit_events WHERE event_type='table_merge'"))[0]).toHaveLength(1);
});
