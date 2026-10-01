const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const L = require('../../services/RecipeLedgerService');
const facts = require('../../services/StockReportFactService');
const { getBusinessDate } = require('../../utils/businessDate');

describe('Ingredient stock authority activation', () => {
    let adminCookie, cashierCookie, ingredientId;
    beforeEach(async () => {
        await seedDatabase();
        adminCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        cashierCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key IN ('stock_enabled','recipe_ledger_enabled')");
        const [row] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES (?,'weight','g')", [`Chicken ${randomUUID()}`]);
        ingredientId = row.insertId;
    });
    afterAll(() => pool.end());
    const inspect = () => request(app).get(`/api/admin/stock/ingredients/${ingredientId}/activation`).set('Cookie', adminCookie);
    const activate = (body, cookie = adminCookie) =>
        request(app).post(`/api/admin/stock/ingredients/${ingredientId}/activate`).set('Cookie', cookie).send(body);
    async function tokenBody(extra = {}) {
        const preview = await inspect();
        expect(preview.status, JSON.stringify(preview.body)).toBe(200);
        return { observation_token: preview.body.observation_token, request_key: randomUUID(), ...extra };
    }
    async function tx(work) {
        const conn = await pool.getConnection();
        try { await conn.beginTransaction(); const result = await work(conn); await conn.commit(); return result; }
        catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
    }

    test('independent review: two meal lines may consume the same activated ingredient', async () => {
        expect((await activate(await tokenBody())).status).toBe(200);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,10),(?,?,20)',
            [SEED.product1.id, ingredientId, SEED.product2.id, ingredientId]);
        await tx(conn => L.syncOrderLines(conn, { sourceId: 9001, actor: {id:1,name:'Review'}, businessDate:getBusinessDate(), removedKeys:[],
            lines:[{key:L.newLineKey(),product_id:SEED.product1.id,qty:1,isNew:true}, {key:L.newLineKey(),product_id:SEED.product2.id,qty:1,isNew:true}] }));
        const [[balance]] = await pool.query('SELECT CAST(b.quantity AS CHAR) quantity FROM stock_balances b JOIN ingredients l ON l.stock_item_id=b.stock_item_id WHERE l.id=?', [ingredientId]);
        expect(balance.quantity).toBe('-30.000000');
    });

    test('independent review: repeated increases on the same saved line are distinct operations', async () => {
        expect((await activate(await tokenBody())).status).toBe(200);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,10)', [SEED.product1.id,ingredientId]);
        const key = L.newLineKey();
        for (const qty of [1,2,3]) {
            await tx(conn => L.syncOrderLines(conn, { sourceId:9001,actor:{id:1,name:'Review'},businessDate:getBusinessDate(),removedKeys:[],
                lines:[{key,product_id:SEED.product1.id,qty,isNew:qty===1}] }));
        }
        const [[balance]] = await pool.query('SELECT CAST(b.quantity AS CHAR) quantity FROM stock_balances b JOIN ingredients l ON l.stock_item_id=b.stock_item_id WHERE l.id=?', [ingredientId]);
        expect(balance.quantity).toBe('-30.000000');
    });

    test('HTTP table edits aggregate shared ingredients and repeated saves do not double-post', async () => {
        expect((await activate(await tokenBody())).status).toBe(200);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,10),(?,?,20)',
            [1,ingredientId,2,ingredientId]);
        let invoiceId = null;
        for (const qty of [1,2,2,3,3]) {
            const [saved] = invoiceId ? await pool.query('SELECT id,product_id FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL', [invoiceId]) : [[]];
            const cart = [1,2].map(id => ({id,qty:id===1?qty:1,price:id===1?5:2,
                order_item_id:saved.find(line=>line.product_id===id)?.id}));
            const subtotal = qty*5+2, tax = qty*0.8;
            const response = await request(app).post('/api/pos/table_order').set('Cookie',adminCookie)
                .send({table_id:SEED.table.id,current_order_id:invoiceId, expected_version: await currentTableRevision(invoiceId),cart,subtotal,tax,total:subtotal+tax});
            expect(response.status,JSON.stringify(response.body)).toBe(200);
            invoiceId = response.body.invoice_id || response.body.order_id;
            const [[balance]] = await pool.query('SELECT CAST(b.quantity AS CHAR) quantity FROM stock_balances b JOIN ingredients l ON l.stock_item_id=b.stock_item_id WHERE l.id=?',[ingredientId]);
            expect(balance.quantity).toBe(`${-(qty*10+20)}.000000`);
        }
        const [[sources]] = await pool.query("SELECT COUNT(*) n FROM stock_operation_sources WHERE ingredient_id=? AND source_kind='ingredient_usage'",[ingredientId]);
        expect(Number(sources.n)).toBe(4);
    });

    test('activates a known opening once, stores cutover provenance and replays the same request', async () => {
        await tx(conn => L.recordManualMovement(conn, {
            ingredientId, kind: 'count', qty: 40, unit: 'g', clientKey: randomUUID(),
            actor: { id: SEED.adminUser.id, name: SEED.adminUser.name }, businessDate: getBusinessDate()
        }));
        const body = await tokenBody();
        const responses = await Promise.all([activate(body), activate(body)]);
        for (const result of responses) expect(result.status, JSON.stringify(result.body)).toBe(200);
        expect(responses.filter(result => result.body.replayed)).toHaveLength(1);
        const [[link]] = await pool.query(`SELECT CAST(stock_movement_watermark AS CHAR) watermark,stock_activation_quantity_known AS quantity_known,CAST(stock_activation_quantity AS CHAR) quantity
            FROM ingredients WHERE id=?`, [ingredientId]);
        expect(link).toMatchObject({ quantity_known: 1, quantity: '40.000000' });
        expect((await pool.query('SELECT id FROM stock_movements WHERE stock_item_id IS NOT NULL'))[0]).toHaveLength(1);
        expect((await pool.query("SELECT id FROM stock_movements WHERE movement_type='ingredient'"))[0]).toHaveLength(1);
        expect((await pool.query("SELECT source_kind FROM stock_operation_sources WHERE ingredient_id=?", [ingredientId]))[0][0].source_kind).toBe('ingredient_cutover');
        expect((await pool.query("SELECT id FROM audit_events WHERE event_type='stock_authority_activated' AND entity_type='ingredient'"))[0]).toHaveLength(1);
        expect((await inspect()).body).toMatchObject({ active: true, can_activate: false, quantity_known: true, quantity: '40.000000' });
        expect((await activate({ ...body, observation_token: 'a'.repeat(64) })).status).toBe(409);
    });

    test('keeps unknown stock unknown, records estimated usage, and does not double-count report facts', async () => {
        const body = await tokenBody();
        const result = await activate(body);
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        expect(result.body).toMatchObject({ quantity_known: false, quantity: null, availability_policy: 'estimate', active: true });
        expect((await pool.query('SELECT id FROM stock_movements'))[0]).toHaveLength(0);
        await tx(conn => L.recordManualMovement(conn, {
            ingredientId, kind: 'waste', qty: 5, unit: 'g', reason: 'spoiled', clientKey: randomUUID(),
            actor: { id: SEED.adminUser.id, name: SEED.adminUser.name }, businessDate: getBusinessDate()
        }));
        const [[balance]] = await pool.query(`SELECT CAST(b.quantity AS CHAR) quantity,b.quantity_known FROM stock_balances b
            JOIN ingredients l ON l.stock_item_id=b.stock_item_id WHERE l.id=?`, [ingredientId]);
        expect(balance).toMatchObject({ quantity: '-5.000000', quantity_known: 0 });
        const collected = [];
        for (let scope = 0; scope < 32; scope++) {
            await facts.stream(pool, { day: getBusinessDate(), scope_id: scope }, async row => {
                if (row.table === 'operations') collected.push(row);
            });
        }
        const usages = collected.filter(row => row.values[2] === 'waste' || row.values[2] === 'opening' || row.values[2] === 'activation');
        expect(usages.filter(row => row.values[2] === 'waste')).toHaveLength(1);
        expect(usages.filter(row => row.values[2] === 'opening')).toHaveLength(0);
    });

    test('blocks unresolved table and held recipes and rejects a stale observation', async () => {
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,1)', [SEED.product1.id, ingredientId]);
        const saved = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id, cart: [{ id: SEED.product1.id, qty: 1, price: 5 }], subtotal: 5, tax: 0.8, total: 5.8
        });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const blocked = await inspect();
        expect(blocked.body.blockers.some(row => row.code === 'open_order')).toBe(true);
        expect((await activate(await tokenBody())).status).toBe(409);
        expect((await pool.query('SELECT id FROM stock_items WHERE legacy_ingredient_id=?', [ingredientId]))[0]).toHaveLength(0);
        await pool.query('DELETE FROM order_items');
        await pool.query('DELETE FROM orders');
        await pool.query('INSERT INTO held_orders(user_id,reference_name,cart_data) VALUES (1,?,?)',
            ['Held recipe', JSON.stringify([{ id: SEED.product1.id, qty: 1 }])]);
        expect((await inspect()).body.blockers.some(row => row.code === 'held_order')).toBe(true);
        await pool.query('DELETE FROM held_orders');
        const stale = await tokenBody();
        await tx(conn => L.recordManualMovement(conn, {
            ingredientId, kind: 'receipt', qty: 3, unit: 'g', clientKey: randomUUID(),
            actor: { id: SEED.adminUser.id, name: SEED.adminUser.name }, businessDate: getBusinessDate()
        }));
        expect((await activate(stale)).status).toBe(409);
        expect((await activate(undefined, cashierCookie)).status).toBe(403);
    });

    test('posts sale usage to the quantity ledger and ignores a pre-count receipt correction', async () => {
        const oldReceipt = await tx(conn => L.recordManualMovement(conn, {
            ingredientId, kind: 'receipt', qty: 100, unit: 'g', clientKey: randomUUID(),
            actor: { id: SEED.adminUser.id, name: SEED.adminUser.name }, businessDate: getBusinessDate()
        }));
        await tx(conn => L.recordManualMovement(conn, {
            ingredientId, kind: 'count', qty: 40, unit: 'g', clientKey: randomUUID(),
            actor: { id: SEED.adminUser.id, name: SEED.adminUser.name }, businessDate: getBusinessDate()
        }));
        expect((await activate(await tokenBody())).status).toBe(200);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,10)', [SEED.product1.id, ingredientId]);
        const opened = await request(app).post('/api/auth/shifts?action=open').set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 0 });
        expect(opened.status).toBe(200);
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.cashierUser.id]);
        const sale = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: SEED.product1.id, qty: 1, price: 5 }], shift_id: shift.id,
            subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6, change_due: 0.2, idempotency_key: randomUUID()
        });
        expect(sale.status, JSON.stringify(sale.body)).toBe(200);
        await tx(conn => L.amendManualMovement(conn, {
            movementId: oldReceipt.movement.id, qty: 0, unit: 'g', note: 'Entered before the count',
            clientKey: randomUUID(), actor: { id: SEED.adminUser.id, name: SEED.adminUser.name }, businessDate: getBusinessDate()
        }));
        const [[balance]] = await pool.query(`SELECT CAST(b.quantity AS CHAR) quantity,b.quantity_known FROM stock_balances b
            JOIN ingredients l ON l.stock_item_id=b.stock_item_id WHERE l.id=?`, [ingredientId]);
        expect(balance).toMatchObject({ quantity: '30.000000', quantity_known: 1 });
        expect((await pool.query("SELECT kind FROM stock_operations WHERE kind='issue'"))[0]).toHaveLength(1);
    });
});
