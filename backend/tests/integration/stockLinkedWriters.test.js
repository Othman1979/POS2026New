const { tableActionIntent } = require('../fixtures/tableActionIntent');
const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const ledger = require('../../services/StockLedgerService');
const { deductStockForCart } = require('../../services/InventoryService');
const { getConnection } = require('../../services/StockReportInvalidation');
const { getBusinessDate } = require('../../utils/businessDate');
afterAll(() => pool.end());

describe.each(['0','1'])('Linked stock through HTTP writers (typed numbering=%s)', (numbering) => {
    let adminCookie, cashierCookie, shiftId, itemId;
    beforeEach(async () => {
        await seedDatabase();
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='order_type_numbering'", [numbering]);
        adminCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        cashierCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
        expect((await request(app).post('/api/auth/shifts?action=open').set('Cookie', cashierCookie).send({ user_id: SEED.cashierUser.id, starting_cash: 0 })).status).toBe(200);
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.cashierUser.id]);
        shiftId = shift.id;
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query('UPDATE products SET stock=10 WHERE id=?', [SEED.product1.id]);
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,legacy_product_id,tracking_state) VALUES ('Linked fixture','count','unit',?,'active')", [SEED.product1.id]);
        itemId = item.insertId;

        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)', [SEED.product1.id, itemId]);
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await ledger.post(conn, { kind: 'opening', request_key: randomUUID(), business_date: getBusinessDate(),
                lines: [{ stock_item_id: itemId, quantity: '10', expected_version: '0' }] }, 1);
            await conn.commit();
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
    });

    // Stock comes in through purchase invoices and is corrected through count documents.
    const purchase = async (qty) => {
        const supplierId = (await request(app).post('/api/admin/purchases/suppliers').set('Cookie', adminCookie).send({ name: `Linked writers supplier ${randomUUID().slice(0, 8)}` })).body.data.id;
        const created = await request(app).post('/api/admin/purchases/invoices').set('Cookie', adminCookie).send({
            client_key: randomUUID(), kind: 'product', supplier_id: supplierId, supplier_invoice_no: `INV-${randomUUID().slice(0, 8)}`, invoice_date: getBusinessDate(),
            payment_status: 'credit', lines: [{ item_key: `product:${SEED.product1.id}`, qty, unit_label: 'Unit', unit_factor: 1, unit_price: 1, tax_rate: 0 }] });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        return created.body.data;
    };
    const postPurchase = (invoice, requestKey = randomUUID()) => request(app).post(`/api/admin/purchases/invoices/${invoice.id}/post`)
        .set('Cookie', adminCookie).send({ expected_version: invoice.version, request_key: requestKey });
    const countProduct = async (qty) => {
        const [[{ category_id: category }]] = await pool.query('SELECT category_id FROM products WHERE id=?', [SEED.product1.id]);
        await pool.query("DELETE FROM stock_documents WHERE doc_type='count' AND status='draft'");
        const api = (method, path) => request(app)[method](`/api/admin/stock-counts${path}`).set('Cookie', adminCookie);
        const created = await api('post', '/').send({ reference: 'Linked writers', groups: [`category:${category}`], request_key: randomUUID() });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const line = created.body.data.lines.find(row => row.item_key === `product:${SEED.product1.id}`);
        const saved = await api('put', `/${created.body.data.id}/lines`).send({ lines: [{ id: line.id, qty: String(qty), unit_label: line.unit_label, unit_factor: line.unit_factor }] });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        return api('post', `/${created.body.data.id}/post`).send({ request_key: randomUUID() });
    };
    async function quantities() {
        const [[row]] = await pool.query('SELECT CAST(p.stock AS CHAR) AS product,CAST(b.quantity AS CHAR) AS ledger FROM products p JOIN product_stock_links l ON l.product_id=p.id JOIN stock_balances b ON b.stock_item_id=l.stock_item_id WHERE p.id=?', [SEED.product1.id]);
        return row;
    }
    test('checkout retry and refund affect physical stock once and retain source identities', async () => {
        const key = randomUUID();
        const body = { cart: [{ id: SEED.product1.id, qty: 1, price: 5, stock_authority: 'none', stock_snapshot: { stock_item_id: '999' } }], shift_id: shiftId,
            subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6, change_due: 0.2, idempotency_key: key };
        const sale = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(body);
        expect(sale.status, JSON.stringify(sale.body)).toBe(200);
        expect((await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(body)).status).toBe(200);
        expect(await quantities()).toEqual({ product: '9.000000', ledger: '9.000000' });
        const [[order]] = await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key=?', [key]);
        const [[line]] = await pool.query('SELECT stock_authority,stock_snapshot FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL', [order.invoice_id]);
        expect(line.stock_authority).toBe('product');
        expect(typeof line.stock_snapshot === 'string' ? JSON.parse(line.stock_snapshot) : line.stock_snapshot)
            .toEqual({ version: 3, components: [{ stock_item_id: String(itemId), qty_per_sale: '1.000000', policy_version: '1' }] });
        await pool.query('UPDATE product_stock_links SET policy_version=2 WHERE product_id=?', [SEED.product1.id]);
        const refund = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
            .send({ invoice_id: order.invoice_id, intent: 'refund', refund_method: 'cash' });
        expect(refund.status, JSON.stringify(refund.body)).toBe(200);
        expect(await quantities()).toEqual({ product: '10.000000', ledger: '10.000000' });
        const [movements] = await pool.query('SELECT source_line FROM stock_movements WHERE stock_item_id=? AND source_line IS NOT NULL ORDER BY id', [itemId]);
        expect(movements).toHaveLength(2);
        expect(movements[0].source_line).toBe(`invoice:${order.invoice_id}:product:${SEED.product1.id}`);
        expect(movements[1].source_line).toMatch(/^refund:\d+:product:1$/);
    });
    test('a sale without product stock tracking does not invent a return after tracking is enabled', async () => {
        await pool.query('DELETE FROM product_stock_links WHERE product_id=?', [SEED.product1.id]);
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='stock_enabled'");
        const key = randomUUID();
        const sale = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: SEED.product1.id, qty: 1, price: 5 }], shift_id: shiftId,
            subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6, change_due: 0.2, idempotency_key: key
        });
        expect(sale.status, JSON.stringify(sale.body)).toBe(200);
        const [[order]] = await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key=?', [key]);
        const [[line]] = await pool.query('SELECT stock_authority FROM order_items WHERE invoice_id=?', [order.invoice_id]);
        expect(line.stock_authority).toBe('none');
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        const refund = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
            .send({ invoice_id: order.invoice_id, intent: 'refund', refund_method: 'cash' });
        expect(refund.status, JSON.stringify(refund.body)).toBe(200);
        const [[product]] = await pool.query('SELECT CAST(stock AS CHAR) AS stock FROM products WHERE id=?', [SEED.product1.id]);
        expect(product.stock).toBe('10.000000');
    });
    test('raw counts cannot bypass authority and pausing stock withdraws known balances', async () => {
        const edit = await request(app).put('/api/admin/products').set('Cookie', adminCookie).send({ id: SEED.product1.id, stock: 99, expected_stock_version: '0' });
        expect(edit.status).toBe(409);
        const settings = await request(app).post('/api/system/settings').set('Cookie', adminCookie).send({ stock_enabled: '0' });
        expect(settings.status, JSON.stringify(settings.body)).toBe(200);
        expect(await quantities()).toEqual({ product: null, ledger: '10.000000' });
    });

    const pause = async () => {
        const result = await request(app).post('/api/system/settings').set('Cookie', adminCookie).send({stock_enabled:'0'});
        expect(result.status, JSON.stringify(result.body)).toBe(200);
    };
    async function sellOne() {
        const key = randomUUID();
        const result = await request(app).post('/api/pos/checkout').set('Cookie',cashierCookie).send({
            cart:[{id:SEED.product1.id,qty:1,price:5}],shift_id:shiftId,subtotal:5,tax:0.8,total:5.8,
            payment_method:'cash',amount_tendered:6,change_due:0.2,idempotency_key:key
        });
        expect(result.status,JSON.stringify(result.body)).toBe(200);
        return (await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key=?',[key]))[0][0].invoice_id;
    }
    test('pause permits sales, preserves original returns, and requires a fresh count before strict stock resumes', async () => {
        const tracked = await sellOne();
        await pause();
        const untracked = await sellOne();
        expect(await quantities()).toEqual({product:null,ledger:'9.000000'});
        expect((await pool.query('SELECT stock_authority FROM order_items WHERE invoice_id=?',[untracked]))[0][0].stock_authority).toBe('none');
        for (const invoice of [tracked,untracked]) {
            const result = await request(app).post('/api/pos/refunds').set('Cookie',adminCookie).send({invoice_id:invoice,intent:'refund',refund_method:'cash'});
            expect(result.status,JSON.stringify(result.body)).toBe(200);
        }
        expect(await quantities()).toEqual({product:null,ledger:'10.000000'});
        const retry = await request(app).post('/api/pos/refunds').set('Cookie',adminCookie).send({invoice_id:tracked,intent:'refund',refund_method:'cash'});
        expect(retry.status).toBeGreaterThanOrEqual(400);
        expect(await quantities()).toEqual({product:null,ledger:'10.000000'});
        expect((await request(app).post('/api/system/settings').set('Cookie',adminCookie).send({stock_enabled:'1'})).status).toBe(200);
        const [[state]] = await pool.query('SELECT quantity_known FROM stock_balances WHERE stock_item_id=?',[itemId]);
        expect(state.quantity_known).toBe(0);
        const counted = await countProduct(8);
        expect(counted.status,JSON.stringify(counted.body)).toBe(200);
        await sellOne();
        expect(await quantities()).toEqual({product:'7.000000',ledger:'7.000000'});
    });
    test('voiding an original table after pause restores its saved source once', async () => {
        const saved = await request(app).post('/api/pos/table_order').set('Cookie',adminCookie).send({table_id:SEED.table.id,cart:[{id:SEED.product1.id,qty:1,price:5}],subtotal:5,tax:0.8,total:5.8});
        expect(saved.status,JSON.stringify(saved.body)).toBe(200);
        const invoice = saved.body.invoice_id || saved.body.order_id;
        await pause();
        const result = await request(app).post('/api/pos/refunds').set('Cookie',adminCookie).send({invoice_id:invoice,expected_version: await currentTableRevision(invoice), intent:'void'});
        expect(result.status,JSON.stringify(result.body)).toBe(200);
        expect(await quantities()).toEqual({product:null,ledger:'10.000000'});
        const again = await request(app).post('/api/pos/refunds').set('Cookie',adminCookie).send({invoice_id:invoice,expected_version: await currentTableRevision(invoice), intent:'void'});
        expect(again.status).toBeGreaterThanOrEqual(400);
        expect(await quantities()).toEqual({product:null,ledger:'10.000000'});
    });
    test('replacing a table while paused releases old reservations and makes the replacement untracked', async () => {
        const body = {table_id:SEED.table.id,cart:[{id:SEED.product1.id,qty:1,price:5}],subtotal:5,tax:0.8,total:5.8};
        const saved = await request(app).post('/api/pos/table_order').set('Cookie',adminCookie).send(body);
        expect(saved.status,JSON.stringify(saved.body)).toBe(200);
        const invoice = saved.body.invoice_id || saved.body.order_id;
        await pause();
        const edited = await request(app).post('/api/pos/table_order').set('Cookie',adminCookie).send({...body,current_order_id:invoice, expected_version: await currentTableRevision(invoice),cart:[{id:SEED.product1.id,qty:2,price:5}],subtotal:10,tax:1.6,total:11.6});
        expect(edited.status,JSON.stringify(edited.body)).toBe(200);
        expect(await quantities()).toEqual({product:null,ledger:'10.000000'});
        const [lines] = await pool.query('SELECT stock_authority FROM order_items WHERE invoice_id=?',[invoice]);
        expect(lines.every(line=>line.stock_authority==='none')).toBe(true);
        const result = await request(app).post('/api/pos/refunds').set('Cookie',adminCookie).send({invoice_id:invoice,expected_version: await currentTableRevision(invoice), intent:'void'});
        expect(result.status,JSON.stringify(result.body)).toBe(200);
        expect(await quantities()).toEqual({product:null,ledger:'10.000000'});
    });

    test('settling a table while paused releases the previous reservation without inventing a later refund', async () => {
        const saved=await request(app).post('/api/pos/table_order').set('Cookie',adminCookie).send({table_id:SEED.table.id,cart:[{id:SEED.product1.id,qty:1,price:5}],subtotal:5,tax:0.8,total:5.8});
        expect(saved.status,JSON.stringify(saved.body)).toBe(200);
        const invoice=saved.body.invoice_id||saved.body.order_id;
        const [[line]]=await pool.query('SELECT id FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',[invoice]);
        await pause();
        const sale=await request(app).post('/api/pos/checkout').set('Cookie',cashierCookie).send({
            edit_invoice_id:invoice,table_id:SEED.table.id,cart:[{id:SEED.product1.id,qty:1,price:5,order_item_id:line.id}],
            shift_id:shiftId,subtotal:5,tax:0.8,total:5.8,payment_method:'cash',amount_tendered:6,change_due:0.2,idempotency_key:randomUUID()
        });
        expect(sale.status,JSON.stringify(sale.body)).toBe(200);
        expect(await quantities()).toEqual({product:null,ledger:'10.000000'});
        const [[settled]]=await pool.query('SELECT stock_authority FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',[invoice]);
        expect(settled.stock_authority).toBe('none');
        const refund=await request(app).post('/api/pos/refunds').set('Cookie',adminCookie).send({invoice_id:invoice,intent:'refund',refund_method:'cash'});
        expect(refund.status,JSON.stringify(refund.body)).toBe(200);
        expect(await quantities()).toEqual({product:null,ledger:'10.000000'});
    });

    test('pausing recipe tracking invalidates shared product count forms and permits a fresh count', async () => {
        const [ingredient]=await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Shared unit','count','unit')");
        await pool.query(`UPDATE ingredients SET stock_item_id=?,stock_movement_watermark=0,stock_activation_operation_id=(SELECT operation_id FROM stock_movements WHERE stock_item_id=? ORDER BY id LIMIT 1),stock_observation_token=REPEAT('a',64),stock_activation_quantity=10,stock_activation_quantity_known=1,stock_activation_request_key='shared-pause-fixture',stock_activated_at=CURRENT_TIMESTAMP(6) WHERE id=?`,[itemId,itemId,ingredient.insertId]);
        const settings=flag=>request(app).post('/api/system/settings').set('Cookie',adminCookie).send({recipe_ledger_enabled:flag});
        expect((await settings('1')).status).toBe(200);
        expect((await request(app).post('/api/system/settings').set('Cookie',adminCookie).send({low_stock_threshold:'10'})).status).toBe(200);
        await pool.query('UPDATE products SET stock=NULL WHERE id<>?',[SEED.product1.id]);
        const catalog=await request(app).get('/api/pos/products').set('Cookie',adminCookie);
        expect(Number(catalog.body.products.find(row=>row.id===SEED.product1.id).stock)).toBe(10);
        const dashboard=await request(app).get('/api/admin/dashboard').set('Cookie',adminCookie);
        expect(dashboard.body.attention.some(row=>row.message_key==='low_stock')).toBe(true);
        expect((await settings('0')).status).toBe(200);
        expect(await quantities()).toEqual({product:null,ledger:'10.000000'});
        const refreshedCatalog=await request(app).get('/api/pos/products').set('Cookie',adminCookie).set('If-None-Match',catalog.headers.etag);
        expect.soft(refreshedCatalog.status).toBe(200);
        expect.soft(refreshedCatalog.body.products?.find(row=>row.id===SEED.product1.id)?.stock).toBeNull();
        const refreshedDashboard=await request(app).get('/api/admin/dashboard').set('Cookie',adminCookie);
        expect.soft(refreshedDashboard.body.attention.some(row=>row.message_key==='low_stock')).toBe(false);
        const fresh=await countProduct(8);
        expect(fresh.status,JSON.stringify(fresh.body)).toBe(200);
        expect(await quantities()).toEqual({product:'8.000000',ledger:'8.000000'});
    });
    test('purchase receipts and count documents journal once and replay by key', async () => {
        const invoice = await purchase('0.25');
        const key = randomUUID();
        const receipt = await postPurchase(invoice, key);
        expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
        expect(await quantities()).toEqual({ product: '10.250000', ledger: '10.250000' });
        const count = await countProduct('8.125');
        expect(count.status, JSON.stringify(count.body)).toBe(200);
        expect(await quantities()).toEqual({ product: '8.125000', ledger: '8.125000' });
        expect((await postPurchase(invoice, key)).status).toBe(200);
        expect((await postPurchase(await purchase(1), key)).status).toBe(409);
        expect(await quantities()).toEqual({ product: '8.125000', ledger: '8.125000' });
        const [movements] = await pool.query('SELECT CAST(quantity AS CHAR) AS quantity FROM stock_movements WHERE stock_item_id=? AND source_line IS NOT NULL ORDER BY id', [itemId]);
        expect(movements).toEqual([{ quantity: '0.250000' }, { quantity: '-2.125000' }]);
    });
    test('concurrent purchase posts serialize both projections without duplicate movement', async () => {
        const first = await purchase(1);
        const key = randomUUID();
        const responses = await Promise.all([postPurchase(first, key), postPurchase(first, key), postPurchase(await purchase(2))]);
        for (const response of responses) expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(await quantities()).toEqual({ product: '13.000000', ledger: '13.000000' });
        const [[row]] = await pool.query('SELECT COUNT(*) AS count FROM stock_movements WHERE stock_item_id=? AND source_line IS NOT NULL', [itemId]);
        expect(row.count).toBe(2);
    });
    test('progressive split settlements preserve server stock snapshots without deducting again', async () => {
        const saved = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id, cart: [{ id: SEED.product1.id, qty: 2, price: 5 }], subtotal: 10, tax: 1.6, total: 11.6
        });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const invoiceId = saved.body.invoice_id || saved.body.order_id;
        const [[line]] = await pool.query('SELECT id,stock_authority,stock_snapshot FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL', [invoiceId]);
        expect(line.stock_authority).toBe('product');
        const split = await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
            tableId: SEED.table.id, currentOrderId: invoiceId,
            splits: [1, 2].map(seat => ({ referenceName: `Seat ${seat}`, subtotal: 5.8,
                items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16, order_item_id: line.id, stock_authority: 'none' }] }))
        });
        expect(split.status, JSON.stringify(split.body)).toBe(200);
        const [held] = await pool.query('SELECT id,cart_data FROM held_orders ORDER BY id');
        expect(held).toHaveLength(2);
        for (const row of held) {
            const payload = JSON.parse(row.cart_data);
            expect(payload.items[0].stock_authority).toBe('product');
            const paid = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5, stock_authority: 'none' }],
                shift_id: shiftId, split_check_id: row.id, table_id: SEED.table.id,
                subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', cash_amount: 5.8,
                amount_tendered: 5.8, change_due: 0, idempotency_key: randomUUID()
            });
            expect(paid.status, JSON.stringify(paid.body)).toBe(200);
            const [[child]] = await pool.query('SELECT stock_authority,stock_snapshot FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL', [paid.body.invoice_id]);
            expect(child).toEqual({ stock_authority: line.stock_authority, stock_snapshot: line.stock_snapshot });
        }
        expect(await quantities()).toEqual({ product: '8.000000', ledger: '8.000000' });
        const [[count]] = await pool.query('SELECT COUNT(*) AS total FROM stock_movements WHERE stock_item_id=? AND source_line IS NOT NULL', [itemId]);
        expect(count.total).toBe(1);
    });
    test('table merge retains the linked mapping on merged stock quantities', async () => {
        let targetId;
        for (const tableId of [SEED.table.id, SEED.table2.id]) {
            const saved = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
                table_id: tableId, cart: [{ id: SEED.product1.id, qty: 1, price: 5 }], subtotal: 5, tax: 0.8, total: 5.8
            });
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            targetId = saved.body.invoice_id || saved.body.order_id;
        }
        const merged = await request(app).post('/api/pos/tables/transfer').set('Cookie', adminCookie).send(await tableActionIntent(pool, {
            sourceTableId: SEED.table.id, targetTableId: SEED.table2.id, action: 'merge'
        }));
        expect(merged.status, JSON.stringify(merged.body)).toBe(200);
        const [lines] = await pool.query('SELECT stock_authority,stock_snapshot,quantity FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL', [targetId]);
        expect(lines.reduce((sum, line) => sum + Number(line.quantity), 0)).toBe(2);
        for (const line of lines) {
            expect(line.stock_authority).toBe('product');
            const snapshot = typeof line.stock_snapshot === 'string' ? JSON.parse(line.stock_snapshot) : line.stock_snapshot;
            expect(snapshot.components).toEqual([{ stock_item_id: String(itemId), qty_per_sale: '1.000000', policy_version: '1' }]);
        }
        expect(await quantities()).toEqual({ product: '8.000000', ledger: '8.000000' });
    });
    test('a transaction snapshot predating the stock link cannot bypass the new authority', async () => {
        await pool.query('DELETE FROM product_stock_links WHERE product_id=?', [SEED.product1.id]);
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            expect((await conn.query('SELECT * FROM product_stock_links WHERE product_id=?', [SEED.product1.id]))[0]).toHaveLength(0);
            await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)', [SEED.product1.id, itemId]);
            const snapshots = await deductStockForCart(conn, [{ product_id: SEED.product1.id, qty: 1 }], {
                source: { type: 'invoice', id: 'activation-race' }, businessDate: getBusinessDate(), actorId: 1
            });
            expect(snapshots.get(SEED.product1.id).authority).toBe('product');
            await conn.commit();
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
        expect(await quantities()).toEqual({ product: '9.000000', ledger: '9.000000' });
    });
    test('distinct linked products do not serialize on a shared category or default location', async () => {
        await pool.query('UPDATE products SET stock=10,category_id=? WHERE id=?', [SEED.category.id, SEED.product2.id]);
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,legacy_product_id,tracking_state) VALUES ('Second linked item','count','unit',?,'active')", [SEED.product2.id]);

        await pool.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known,version) VALUES (?,10,1,1)', [item.insertId]);
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)', [SEED.product2.id, item.insertId]);
        const first = await getConnection(pool);
        const second = await getConnection(pool);
        let pending, timer, completed, failure, lastQuery;
        const query = second.query.bind(second);
        second.query = async (...args) => { lastQuery=args[0]; const result=await query(...args);lastQuery=null;return result; };
        let blockedQuery;
        try {
            await first.beginTransaction();
            await second.beginTransaction();
            const context = { source: { type: 'invoice', id: 'independent-products' }, businessDate: getBusinessDate(), actorId: 1 };
            await deductStockForCart(first, [{ product_id: SEED.product1.id, qty: 1 }], context);
            pending = deductStockForCart(second, [{ product_id: SEED.product2.id, qty: 1 }], context)
                .then(() => true, error => { failure = error; return false; });
            completed = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
            blockedQuery=lastQuery;
        } finally {
            clearTimeout(timer);
            await first.rollback();
            if (pending) await pending;
            await second.rollback();
            first.release();
            second.release();
        }
        expect(failure).toBeUndefined();
        expect(completed, blockedQuery).toBe(true);
    });
});
