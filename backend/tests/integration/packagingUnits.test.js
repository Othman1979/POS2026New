const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('packaging units', () => {
    let adminCookie, cashierCookie, shiftId, category, gum, supplierId;
    const admin = (method, path) => request(app)[method](path).set('Cookie', adminCookie);
    const balance = async (productId) => {
        const [[row]] = await pool.query(
            `SELECT CAST(b.quantity AS CHAR) AS quantity FROM product_stock_links l
               JOIN stock_balances b ON b.stock_item_id = l.stock_item_id WHERE l.product_id = ?`, [productId]);
        return Number(row.quantity);
    };
    const grid = async () => (await admin('get', `/api/pos/products?category_id=${category}&sales_context=register`)).body.products.map(row => row.id);
    const lookup = async (barcode) => (await request(app).get('/api/pos/product_lookup').query({ barcode, sales_context: 'register' })
        .set('Cookie', cashierCookie)).body.product;
    const savePacks = (productId, packs) => admin('put', `/api/admin/products/${productId}/packs`).send({ packs });

    beforeAll(async () => {
        await seedDatabase();
        adminCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        cashierCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
        expect((await request(app).post('/api/auth/shifts?action=open').set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 0 })).status).toBe(200);
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.cashierUser.id]);
        shiftId = shift.id;
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query("UPDATE settings SET setting_value='sales_tax' WHERE setting_key='tax_registration_type'");
        const [c] = await pool.query("INSERT INTO categories (name) VALUES ('Packaging sweets')");
        category = c.insertId;
        const [p] = await pool.query("INSERT INTO products (name, price, tax_rate, category_id, barcode, stock) VALUES ('Extra gum', 0.5, 0, ?, 'GUM-PIECE', 0)", [category]);
        gum = p.insertId;
        supplierId = (await admin('post', '/api/admin/purchases/suppliers').send({ name: `Packs supplier ${randomUUID().slice(0, 8)}` })).body.data.id;
    });
    afterAll(() => pool.end());

    it('validates packs and refuses a pack barcode owned by another product', async () => {
        expect((await savePacks(gum, [{ label: 'Packet', factor: 0 }])).status).toBe(400);
        expect((await savePacks(gum, [{ label: 'Packet', factor: 20 }, { label: 'packet', factor: 10 }])).status).toBe(400);
        // A pack that is not sold has no sale entry, so a barcode typed without a price is dropped.
        const unpriced = await savePacks(gum, [{ label: 'Packet', factor: 20, barcode: 'X1' }]);
        expect(unpriced.status, JSON.stringify(unpriced.body)).toBe(200);
        expect(unpriced.body.packs[0]).toMatchObject({ barcode: null, sale_product_id: null });
        expect((await savePacks(gum, [])).status).toBe(200);
        const taken = await savePacks(gum, [{ label: 'Packet', factor: 20, sale_price: 9, barcode: String(SEED.product1.barcode || 'GUM-PIECE') }]);
        expect(taken.status).toBe(409);
        expect((await admin('get', `/api/admin/products/${gum}/packs`)).body.packs).toEqual([]);
    });

    it('sells a pack by its own barcode at its own price, from the base product stock', async () => {
        const saved = await savePacks(gum, [{ label: 'Packet', factor: 20, sale_price: 9, barcode: 'GUM-PACKET' }, { label: 'Carton', factor: 240 }]);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.packs).toEqual([
            expect.objectContaining({ label: 'Packet', factor: '20', sale_price: 9, barcode: 'GUM-PACKET', sale_product_id: expect.any(Number) }),
            expect.objectContaining({ label: 'Carton', factor: '240', sale_price: null, barcode: null, sale_product_id: null }),
        ]);
        const packetId = saved.body.packs[0].sale_product_id;
        const [[link]] = await pool.query('SELECT CAST(qty_per_sale AS CHAR) AS qty FROM product_stock_links WHERE product_id=?', [packetId]);
        expect(Number(link.qty)).toBe(20);
        expect((await lookup('GUM-PACKET'))).toMatchObject({ id: packetId, name: 'Extra gum - Packet' });
        expect((await lookup('GUM-PIECE'))).toMatchObject({ id: gum });
        // The pack is not a separate tile on the grid.
        expect(await grid()).toEqual([gum]);

        // Bought as printed: 2 cartons at 72.000 plus 40 free pieces = 520 pieces for 144.000.
        const created = await admin('post', '/api/admin/purchases/invoices').send({
            client_key: randomUUID(), kind: 'product', supplier_id: supplierId, supplier_invoice_no: `INV-${randomUUID().slice(0, 8)}`,
            invoice_date: '2026-09-29', payment_status: 'credit',
            lines: [{ item_key: `product:${gum}`, qty: 2, bonus_qty: 40, unit_label: 'Carton', unit_factor: 240, unit_price: 72, tax_rate: 0 }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        expect(created.body.data.lines[0]).toMatchObject({ qty: 2, bonus_qty: 40, line_subtotal: 144 });
        const items = (await admin('get', '/api/admin/purchases/items?kind=product&q=Extra')).body.data;
        expect(items.map(row => row.name)).toEqual(['Extra gum']);
        expect(items[0].packs).toEqual(expect.arrayContaining([{ label: 'Packet', factor: 20 }, { label: 'Carton', factor: 240 }]));
        const posted = await admin('post', `/api/admin/purchases/invoices/${created.body.data.id}/post`)
            .send({ expected_version: created.body.data.version, request_key: randomUUID() });
        expect(posted.status, JSON.stringify(posted.body)).toBe(200);
        expect(await balance(gum)).toBe(520);
        const insights = (await admin('get', `/api/admin/purchases/items/insights?kind=product&keys=product:${gum}`)).body.data[0];
        expect(insights).toMatchObject({ on_hand: 520 });
        expect(insights.average_base_price).toBeCloseTo(144 / 520, 6);

        const sale = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: packetId, qty: 1, price: 9 }, { id: gum, qty: 3, price: 0.5 }], shift_id: shiftId,
            subtotal: 10.5, tax: 0, total: 10.5, payment_method: 'cash', amount_tendered: 10.5, change_due: 0, idempotency_key: randomUUID(),
        });
        expect(sale.status, JSON.stringify(sale.body)).toBe(200);
        expect(await balance(gum)).toBe(520 - 20 - 3);
        expect(await balance(packetId)).toBe(497);
        const today = (await pool.query("SELECT DATE_FORMAT(CURRENT_DATE, '%Y-%m-%d') AS d"))[0][0].d;
        const report = await admin('get', `/api/admin/reports/product-profit?start_date=2026-09-01&end_date=${today}`);
        expect(report.status, JSON.stringify(report.body)).toBe(200);
        const row = report.body.products.find(product => product.product_id === gum);
        expect(report.body.products.some(product => product.product_id === packetId)).toBe(false);
        expect(row).toMatchObject({ net_qty: 23, net_sales: 10.5, cost_source: 'purchase_average' });
        expect(row.cost).toBeCloseTo(23 * 144 / 520, 2);
    });

    it('keeps the pack sale product when its price changes and retires it when the pack stops selling', async () => {
        const before = (await admin('get', `/api/admin/products/${gum}/packs`)).body.packs[0].sale_product_id;
        const repriced = await savePacks(gum, [{ label: 'Packet', factor: 20, sale_price: 8.5, barcode: 'GUM-PACKET' }]);
        expect(repriced.status, JSON.stringify(repriced.body)).toBe(200);
        expect(repriced.body.packs[0]).toMatchObject({ sale_product_id: before, sale_price: 8.5 });
        const unsold = await savePacks(gum, [{ label: 'Packet', factor: 20 }]);
        expect(unsold.body.packs[0]).toMatchObject({ sale_product_id: null, sale_price: null });
        const [[retired]] = await pool.query('SELECT is_active, barcode FROM products WHERE id=?', [before]);
        expect(retired).toEqual({ is_active: 0, barcode: null });
        expect(await lookup('GUM-PACKET')).toBeNull();

        // Past pack sales still count as base units of the product after the pack stops selling.
        const today = (await pool.query("SELECT DATE_FORMAT(CURRENT_DATE, '%Y-%m-%d') AS d"))[0][0].d;
        const report = (await admin('get', `/api/admin/reports/product-profit?start_date=2026-09-01&end_date=${today}`)).body;
        expect(report.products.some(product => product.product_id === before)).toBe(false);
        expect(report.products.find(product => product.product_id === gum)).toMatchObject({ net_qty: 23, net_sales: 10.5 });
        const removed = await savePacks(gum, []);
        expect(removed.status).toBe(400);
        expect((await admin('get', `/api/admin/products/${gum}/packs`)).body.packs).toHaveLength(1);

        // Selling the pack again brings back the same sale entry.
        const resold = await savePacks(gum, [{ label: 'Packet', factor: 20, sale_price: 9, barcode: 'GUM-PACKET' }]);
        expect(resold.status, JSON.stringify(resold.body)).toBe(200);
        expect(resold.body.packs[0]).toMatchObject({ sale_product_id: before, sale_price: 9, barcode: 'GUM-PACKET' });
        expect(await lookup('GUM-PACKET')).toMatchObject({ id: before });
    });

    it('hides a category from the POS grid while its products still sell by barcode', async () => {
        const res = await admin('put', '/api/admin/categories').send({ id: category, name: 'Packaging sweets', hide_in_pos: 1 });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(await grid()).toEqual([]);
        expect(await lookup('GUM-PIECE')).toMatchObject({ id: gum });
    });

    it('starts a product with no stock entered at a known zero when its first pack is saved', async () => {
        const [p] = await pool.query("INSERT INTO products (name, price, tax_rate, category_id, barcode) VALUES ('Cola can', 0.35, 0, ?, 'COLA-PIECE')", [category]);
        const saved = await savePacks(p.insertId, [{ label: 'Shrink', factor: 24, sale_price: 7.5, barcode: 'COLA-SHRINK' }]);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const created = await admin('post', '/api/admin/purchases/invoices').send({
            client_key: randomUUID(), kind: 'product', supplier_id: supplierId, supplier_invoice_no: `INV-${randomUUID().slice(0, 8)}`,
            invoice_date: '2026-09-29', payment_status: 'credit',
            lines: [{ item_key: `product:${p.insertId}`, qty: 1, unit_label: 'Shrink', unit_factor: 24, unit_price: 6, tax_rate: 0 }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const posted = await admin('post', `/api/admin/purchases/invoices/${created.body.data.id}/post`)
            .send({ expected_version: created.body.data.version, request_key: randomUUID() });
        expect(posted.status, JSON.stringify(posted.body)).toBe(200);
        const [[row]] = await pool.query(
            `SELECT CAST(b.quantity AS CHAR) AS quantity, b.quantity_known FROM product_stock_links l
               JOIN stock_balances b ON b.stock_item_id = l.stock_item_id WHERE l.product_id = ?`, [p.insertId]);
        expect({ quantity: Number(row.quantity), known: Number(row.quantity_known) }).toEqual({ quantity: 24, known: 1 });
        const insights = (await admin('get', `/api/admin/purchases/items/insights?kind=product&keys=product:${p.insertId}`)).body.data[0];
        expect(insights).toMatchObject({ on_hand: 24 });
    });
});
