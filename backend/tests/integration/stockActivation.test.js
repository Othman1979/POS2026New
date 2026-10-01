const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Product stock authority activation', () => {
    let adminCookie, cashierCookie;
    beforeEach(async () => {
        await seedDatabase();
        adminCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        cashierCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query('UPDATE products SET stock=10 WHERE id=?', [SEED.product1.id]);
    });
    afterAll(() => pool.end());
    const inspect = () => request(app).get(`/api/admin/stock/products/${SEED.product1.id}/activation`).set('Cookie', adminCookie);
    const activate = (body = { expected_stock_version: '0', request_key: randomUUID() }, cookie = adminCookie) =>
        request(app).post(`/api/admin/stock/products/${SEED.product1.id}/activate`).set('Cookie', cookie).send(body);
    async function stock() {
        const [[row]] = await pool.query(`SELECT CAST(p.stock AS CHAR) AS product,CAST(p.stock_version AS CHAR) AS stock_version,
            CAST(b.quantity AS CHAR) AS quantity,b.quantity_known,CAST(b.version AS CHAR) AS balance_version
            FROM products p JOIN product_stock_links l ON l.product_id=p.id JOIN stock_balances b ON b.stock_item_id=l.stock_item_id WHERE p.id=?`, [SEED.product1.id]);
        return row;
    }
    test('activates reconciled opening stock once and exposes the linked state in product reads', async () => {
        const preview = await inspect();
        expect(preview.status).toBe(200);
        expect(preview.body).toMatchObject({ can_activate: true, active: false, stock: '10.000000', stock_version: '0' });
        expect((await pool.query('SELECT id FROM stock_items'))[0]).toHaveLength(0);
        const body = { expected_stock_version: '0', request_key: randomUUID() };
        const responses = await Promise.all([activate(body), activate(body)]);
        for (const result of responses) expect(result.status, JSON.stringify(result.body)).toBe(200);
        expect(responses.filter(result => result.body.replayed)).toHaveLength(1);
        expect(await stock()).toEqual({ product: '10.000000', stock_version: '1', quantity: '10.000000', quantity_known: 1, balance_version: '1' });
        expect((await pool.query('SELECT id FROM stock_movements'))[0]).toHaveLength(1);
        expect((await pool.query("SELECT id FROM audit_events WHERE event_type='stock_authority_activated'"))[0]).toHaveLength(1);
        expect((await inspect()).body).toMatchObject({ active: true, can_activate: false });
        const catalog = await request(app).get('/api/admin/products?page=1&limit=20').set('Cookie', adminCookie);
        expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
        expect(catalog.body.products.find(product => product.id === SEED.product1.id).stock_item_id).toBe(responses[0].body.stock_item_id);
        expect((await activate({ ...body, expected_stock_version: '1' })).status).toBe(409);
        const bundle = await request(app).put('/api/admin/products').set('Cookie', adminCookie).send({ id: SEED.product1.id, is_bundle: 1 });
        expect(bundle.status).toBe(409);
        const disabled = await request(app).post('/api/system/settings').set('Cookie', adminCookie).send({ stock_enabled: '0' });
        expect(disabled.status).toBe(200);
        expect(await stock()).toMatchObject({product:null,quantity_known:0});
    });
    test('keeps unknown stock unknown until an explicit observed count, including zero', async () => {
        await pool.query('UPDATE products SET stock=NULL WHERE id=?', [SEED.product1.id]);
        const result = await activate();
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        expect(await stock()).toEqual({ product: null, stock_version: '1', quantity: '0.000000', quantity_known: 0, balance_version: '0' });
        expect((await pool.query('SELECT id FROM stock_movements'))[0]).toHaveLength(0);
        const opened = await request(app).post('/api/auth/shifts?action=open').set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 0 });
        expect(opened.status).toBe(200);
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.cashierUser.id]);
        const sale = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: SEED.product1.id, qty: 1, price: 5 }], shift_id: shift.id,
            subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6, change_due: 0.2, idempotency_key: randomUUID()
        });
        expect(sale.status, JSON.stringify(sale.body)).toBe(409);
        expect((await pool.query('SELECT invoice_id FROM orders'))[0]).toHaveLength(0);
        expect((await pool.query('SELECT id FROM stock_movements'))[0]).toHaveLength(0);
        const [[{ category_id: category }]] = await pool.query('SELECT category_id FROM products WHERE id=?', [SEED.product1.id]);
        const counts = (method, path) => request(app)[method](`/api/admin/stock-counts${path}`).set('Cookie', adminCookie);
        const created = await counts('post', '/').send({ reference: 'Opening', groups: [`category:${category}`], request_key: randomUUID() });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const line = created.body.data.lines.find(row => row.item_key === `product:${SEED.product1.id}`);
        expect((await counts('put', `/${created.body.data.id}/lines`).send({ lines: [{ id: line.id, qty: '0', unit_label: line.unit_label, unit_factor: line.unit_factor }] })).status).toBe(200);
        const postKey = randomUUID();
        const counted = await counts('post', `/${created.body.data.id}/post`).send({ request_key: postKey });
        expect(counted.status, JSON.stringify(counted.body)).toBe(200);
        expect((await counts('post', `/${created.body.data.id}/post`).send({ request_key: postKey })).status).toBe(200);
        expect(await stock()).toEqual({ product: '0.000000', stock_version: '2', quantity: '0.000000', quantity_known: 1, balance_version: '1' });
        expect((await pool.query('SELECT id FROM stock_movements'))[0]).toHaveLength(1);
    });
    test('rejects stale observations and cashier access without creating stock identities', async () => {
        expect((await activate(undefined, cashierCookie)).status).toBe(403);
        await pool.query('UPDATE products SET stock=9,stock_version=stock_version+1 WHERE id=?', [SEED.product1.id]);
        expect((await activate()).status).toBe(409);
        expect((await pool.query('SELECT id FROM stock_items'))[0]).toHaveLength(0);
    });
    test('blocks unresolved table stock and leaves its existing quantity intact', async () => {
        const saved = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id, cart: [{ id: SEED.product1.id, qty: 1, price: 5 }], subtotal: 5, tax: 0.8, total: 5.8
        });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const preview = await inspect();
        expect(preview.body.blockers.some(row => row.code === 'open_order')).toBe(true);
        const result = await activate({ expected_stock_version: preview.body.stock_version, request_key: randomUUID() });
        expect(result.status).toBe(409);
        expect((await pool.query('SELECT id FROM stock_items'))[0]).toHaveLength(0);
        expect(Number((await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product1.id]))[0][0].stock)).toBe(9);
    });
    test.each([
        [{ id: 1, qty: 1 }], [{ product_id: '1', qty: 1 }],
        { items: [{ id: '1', qty: 1 }] }, { items: [{ product_id: 1, qty: 1 }] }
    ].map(payload => ({ payload })))('blocks legacy and current held product references: %j', async ({ payload }) => {
        await pool.query('INSERT INTO held_orders(user_id,reference_name,cart_data) VALUES (1,?,?)', ['Held fixture', JSON.stringify(payload)]);
        const preview = await inspect();
        expect(preview.body.blockers.some(row => row.code === 'held_order')).toBe(true);
        expect((await activate()).status).toBe(409);
        expect((await pool.query('SELECT id FROM stock_items'))[0]).toHaveLength(0);
    });
    test.each(['not-json', 'null', '{}', '{"items":{}}'])('blocks unreadable held payload %s without creating an opening', async payload => {
        await pool.query('INSERT INTO held_orders(user_id,reference_name,cart_data) VALUES (1,?,?)', ['Malformed fixture', payload]);
        const preview = await inspect();
        expect(preview.status, JSON.stringify(preview.body)).toBe(200);
        expect(preview.body.blockers.some(row => row.code === 'invalid_hold')).toBe(true);
        expect((await activate()).status).toBe(409);
        expect((await pool.query('SELECT id FROM stock_items'))[0]).toHaveLength(0);
    });
    test('does not block an unrelated held product and does not replace recipe authority', async () => {
        await pool.query('INSERT INTO held_orders(user_id,reference_name,cart_data) VALUES (1,?,?)', ['Other product', JSON.stringify({ items: [{ id: 2, qty: 1 }] })]);
        expect((await inspect()).body.can_activate).toBe(true);
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Chicken','weight','g')");
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) VALUES (?,?,100,0)', [SEED.product1.id, ingredient.insertId]);
        expect((await inspect()).body.blockers.some(row => row.code === 'recipe')).toBe(true);
        expect((await activate()).status).toBe(409);
    });
    test('maps a closed legacy sale return once after activation without inventing its cost', async () => {
        const shift = await request(app).post('/api/auth/shifts?action=open').set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 0 });
        expect(shift.status).toBe(200);
        const [[row]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.cashierUser.id]);
        const key = randomUUID();
        const sale = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: SEED.product1.id, qty: 2, price: 5 }], shift_id: row.id,
            subtotal: 10, tax: 1.6, total: 11.6, payment_method: 'cash', amount_tendered: 12, change_due: 0.4, idempotency_key: key
        });
        expect(sale.status, JSON.stringify(sale.body)).toBe(200);
        const preview = await inspect();
        expect(preview.body.can_activate).toBe(true);
        expect((await activate({ expected_stock_version: preview.body.stock_version, request_key: randomUUID() })).status).toBe(200);
        const [[order]] = await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key=?', [key]);
        const refund = () => request(app).post('/api/pos/refunds').set('Cookie', adminCookie).send({ invoice_id: order.invoice_id, intent: 'refund', refund_method: 'cash' });
        const returned = await refund();
        expect(returned.status, JSON.stringify(returned.body)).toBe(200);
        expect((await refund()).status).not.toBe(200);
        expect(await stock()).toMatchObject({ product: '10.000000', quantity: '10.000000' });
        const [movements] = await pool.query('SELECT CAST(quantity AS CHAR) AS quantity,source_line FROM stock_movements ORDER BY id');
        expect(movements).toHaveLength(2);
        expect(movements[0].quantity).toBe('8.000000');
        expect(movements[1].quantity).toBe('2.000000');
        expect(movements[1].source_line).toMatch(/^refund:/);
    });
});
