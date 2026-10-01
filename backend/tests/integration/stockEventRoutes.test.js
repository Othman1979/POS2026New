const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const cache = require('../../config/cache');
const { seedDatabase, SEED } = require('../fixtures/seed');
const ledger = require('../../services/StockLedgerService');
const { getConnection } = require('../../services/StockReportInvalidation');
const { getBusinessDate } = require('../../utils/businessDate');

// The product ids a stock event names must cover everything whose displayed
// stock moved, including products only reachable through what a save restored.
afterAll(() => pool.end());

describe('stock events name every affected product', () => {
    let adminCookie, shiftId;
    const A = SEED.product1.id;
    const B = SEED.product2.id;
    const admin = (method, path) => request(app)[method](path).set('Cookie', adminCookie);
    const stockEvents = () => global.__mockEmit__.mock.calls.filter(([event]) => event === 'inventory_changed').map(([, payload]) => payload);
    const lastStockEvent = async () => {
        await vi.waitFor(() => expect(stockEvents().length).toBeGreaterThan(0));
        return stockEvents().at(-1);
    };
    const newItem = async (name, productId) => {
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,legacy_product_id,tracking_state) VALUES (?,'count','unit',?,'active')", [name, productId]);
        const conn = await getConnection(pool);
        try {
            await conn.beginTransaction();
            await ledger.post(conn, { kind: 'opening', request_key: randomUUID(), business_date: getBusinessDate(),
                lines: [{ stock_item_id: item.insertId, quantity: '10', expected_version: '0' }] }, 1);
            await conn.commit();
        } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
        return item.insertId;
    };

    beforeEach(async () => {
        await seedDatabase();
        adminCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query('UPDATE products SET stock=10 WHERE id IN (?,?)', [A, B]);
        global.__mockEmit__.mockClear();
    });

    const openShift = async () => {
        await admin('post', '/api/auth/shifts?action=open').send({ user_id: SEED.adminUser.id, starting_cash: 0 });
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.adminUser.id]);
        shiftId = shift.id;
    };

    it('settling a saved table with a cart that leaves out one of its saved products names that product', async () => {
        await openShift();
        const line = (product, name) => ({ id: product, product_id: product, name, qty: 1, price: 2 });
        const saved = await admin('post', '/api/pos/table_order').send({
            table_id: SEED.table.id, cart: [line(A, SEED.product1.name), line(B, SEED.product2.name)], subtotal: 4, tax: 0, total: 4
        });
        expect(saved.statusCode, JSON.stringify(saved.body)).toBe(200);

        global.__mockEmit__.mockClear();
        const paid = await admin('post', '/api/pos/checkout').send({
            table_id: SEED.table.id, cart: [{ id: B, qty: 1, price: 2 }], shift_id: shiftId,
            subtotal: 2, tax: 0, total: 2, payment_method: 'cash', amount_tendered: 2, change_due: 0, idempotency_key: randomUUID()
        });
        expect(paid.statusCode, JSON.stringify(paid.body)).toBe(200);
        const event = await lastStockEvent();
        expect(event.productIds).toEqual(expect.arrayContaining([A, B]));
    });

    it('a refund names a product still linked to the stock item the sale drew from, after the sold product was relinked', async () => {
        const itemX = await newItem('Shared X', A);
        const itemY = await newItem('Shared Y', B);
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)', [A, itemX]);
        // A sibling that only shares item X with the sold product.
        const [sibling] = await pool.query('INSERT INTO products(name,price,stock) VALUES (?,1,10)', ['Refund sibling']);
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)', [sibling.insertId, itemX]);

        await openShift();
        const key = randomUUID();
        const sale = await admin('post', '/api/pos/checkout').send({
            cart: [{ id: A, qty: 1, price: 5 }], shift_id: shiftId, subtotal: 5, tax: 0.8, total: 5.8,
            payment_method: 'cash', amount_tendered: 6, change_due: 0.2, idempotency_key: key
        });
        expect(sale.statusCode, JSON.stringify(sale.body)).toBe(200);

        // The sold product now draws from item Y; the sale still owes its return to item X.
        await pool.query('UPDATE product_stock_links SET stock_item_id=? WHERE product_id=?', [itemY, A]);
        global.__mockEmit__.mockClear();
        const refund = await admin('post', '/api/pos/refunds').send({ invoice_id: sale.body.invoice_id, intent: 'refund', refund_method: 'cash' });
        expect(refund.statusCode, JSON.stringify(refund.body)).toBe(200);
        const event = await lastStockEvent();
        expect(event.productIds).toEqual(expect.arrayContaining([A, sibling.insertId]));
    });
});

// Ingredient balances move the availability of linked products, so their admin
// writes must reach the tills like a sale does.
describe('ingredient writes announce the products they affect', () => {
    let adminCookie, ingredientId, linkedProduct;
    const admin = (method, path) => request(app)[method](path).set('Cookie', adminCookie);
    const stockEvents = () => global.__mockEmit__.mock.calls.filter(([event]) => event === 'inventory_changed').map(([, payload]) => payload);

    const newIngredient = async (name) => (await admin('post', '/api/admin/ingredients').send({ name, measure: 'count', display_unit: 'unit', unit_cost: 1 })).body.ingredient.id;

    beforeEach(async () => {
        await seedDatabase();
        adminCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        ingredientId = await newIngredient('Routed flour');
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Routed flour item','count','unit','active')");
        linkedProduct = (await pool.query('INSERT INTO products(name,price,stock) VALUES (?,1,10)', ['Routed linked product']))[0].insertId;
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)', [linkedProduct, item.insertId]);
        const conn = await pool.getConnection();
        try {
            // Only the link matters here, so skip the activation-operation foreign key.
            await conn.query('SET FOREIGN_KEY_CHECKS=0');
            await conn.query(`UPDATE ingredients SET stock_item_id=?,stock_activation_operation_id=999999,stock_movement_watermark=0,
                stock_observation_token=REPEAT('a',64),stock_activation_request_key='routed-flour',stock_activated_at=NOW(),
                stock_activation_quantity_known=0 WHERE id=?`, [item.insertId, ingredientId]);
        } finally {
            await conn.query('SET FOREIGN_KEY_CHECKS=1');
            conn.release();
        }
        global.__mockEmit__.mockClear();
    });

    it('an ingredient receipt drops the catalog cache and names the linked product', async () => {
        const invalidate = vi.spyOn(cache, 'invalidateCatalogCache');
        const res = await admin('post', `/api/admin/ingredients/${ingredientId}/movements`).send({ kind: 'receipt', qty: 5, unit: 'unit', client_key: randomUUID() });
        expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
        await vi.waitFor(() => expect(stockEvents()).toEqual([{ scope: 'stock', productIds: [linkedProduct] }]));
        expect(invalidate).toHaveBeenCalled();
        invalidate.mockRestore();
    });

    it('an ingredient nothing links to emits no stock event', async () => {
        const unlinked = await newIngredient('Routed unlinked');
        global.__mockEmit__.mockClear();
        const res = await admin('post', `/api/admin/ingredients/${unlinked}/movements`).send({ kind: 'receipt', qty: 5, unit: 'unit', client_key: randomUUID() });
        expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
        // The ingredient event still goes out; only the stock event is skipped.
        await vi.waitFor(() => expect(global.__mockEmit__.mock.calls.some(([event]) => event === 'ingredients_changed')).toBe(true));
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(stockEvents()).toEqual([]);
    });
});
