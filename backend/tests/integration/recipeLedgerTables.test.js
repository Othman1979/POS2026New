const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('recipe ledger table save and checkout', () => {
    let adminCookie;
    let cashierCookie;
    let cashierShiftId;
    let chicken;
    let pepsi;

    beforeEach(async () => {
        await seedDatabase();
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];
        const cashierRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = cashierRes.headers['set-cookie'][0];
        const [chickenResult] = await pool.query(`
            INSERT INTO ingredients
              (name, measure, display_unit, unit_cost, par_qty, pack_name, pack_size, is_active)
            VALUES ('Chicken', 'weight', 'kg', 0.0045, 5000, 'sack', 10000, 1)
        `);
        const [pepsiResult] = await pool.query(`
            INSERT INTO ingredients
              (name, measure, display_unit, unit_cost, par_qty, pack_name, pack_size, is_active)
            VALUES ('Pepsi', 'count', 'unit', 0.35, NULL, 'carton', 24, 1)
        `);
        chicken = chickenResult.insertId;
        pepsi = pepsiResult.insertId;
        await pool.query(`
            INSERT INTO product_recipe_lines (product_id, ingredient_id, qty_per_unit, sort_order)
            VALUES (?, ?, 200, 0), (?, ?, 1, 0)
        `, [SEED.product1.id, chicken, SEED.product2.id, pepsi]);
    });

    afterAll(async () => {
        await pool.end();
    });

    async function enableLedger() {
        await pool.query(
            "UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'"
        );
    }

    async function openShift() {
        const res = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 50.00 });
        expect(res.statusCode).toBe(200);
        const [rows] = await pool.query(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
            [SEED.cashierUser.id]
        );
        cashierShiftId = rows[0].id;
        return cashierShiftId;
    }

    async function saveTable(cart, totals, invoiceId = null) {
        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                cart,
                ...totals
            });
        expect(res.statusCode).toBe(200);
        return res.body.invoice_id || res.body.order_id;
    }

    async function parentLines(invoiceId) {
        const [rows] = await pool.query(
            `SELECT id, product_id, quantity, note, recipe_line_key
               FROM order_items
              WHERE invoice_id = ? AND parent_item_id IS NULL
              ORDER BY id`,
            [invoiceId]
        );
        return rows;
    }

    async function netFor(ingredientId, lineKey) {
        const [[row]] = await pool.query(
            "SELECT COALESCE(SUM(qty), 0) AS qty FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? AND line_key=?",
            [ingredientId, lineKey]
        );
        return Number(row.qty);
    }

    async function movementCount() {
        const [[row]] = await pool.query("SELECT COUNT(*) AS c FROM stock_movements WHERE movement_type='ingredient' ");
        return Number(row.c);
    }

    it('mints keys on first save, freezes usage across re-saves, and writes nothing on settle', async () => {
        await enableLedger();
        const invoiceId = await saveTable(
            [
                { id: SEED.product1.id, qty: 2, price: 5, note: '' },
                { id: SEED.product1.id, qty: 1, price: 5, note: 'no onion' }
            ],
            { subtotal: 15, tax: 2.4, total: 17.4 }
        );
        let lines = await parentLines(invoiceId);
        expect(lines).toHaveLength(2);
        const keyA = lines.find((row) => !row.note).recipe_line_key;
        const keyB = lines.find((row) => row.note === 'no onion').recipe_line_key;
        expect(keyA).toMatch(/^[0-9a-f]{32}$/);
        expect(keyB).toMatch(/^[0-9a-f]{32}$/);
        expect(keyA).not.toBe(keyB);
        expect(await netFor(chicken, keyA)).toBe(-400);
        expect(await netFor(chicken, keyB)).toBe(-200);

        const afterFirst = await movementCount();
        await saveTable(
            [
                { id: SEED.product1.id, qty: 2, price: 5, note: '', order_item_id: lines.find((row) => !row.note).id },
                { id: SEED.product1.id, qty: 1, price: 5, note: 'no onion', order_item_id: lines.find((row) => row.note === 'no onion').id }
            ],
            { subtotal: 15, tax: 2.4, total: 17.4 },
            invoiceId
        );
        lines = await parentLines(invoiceId);
        expect(lines.find((row) => !row.note).recipe_line_key).toBe(keyA);
        expect(lines.find((row) => row.note === 'no onion').recipe_line_key).toBe(keyB);
        expect(await movementCount()).toBe(afterFirst);

        await saveTable(
            [
                { id: SEED.product1.id, qty: 3, price: 5, note: '', order_item_id: lines.find((row) => !row.note).id },
                { id: SEED.product1.id, qty: 1, price: 5, note: 'no onion', order_item_id: lines.find((row) => row.note === 'no onion').id }
            ],
            { subtotal: 20, tax: 3.2, total: 23.2 },
            invoiceId
        );
        expect(await netFor(chicken, keyA)).toBe(-600);
        expect(await netFor(chicken, keyB)).toBe(-200);

        await pool.query('UPDATE product_recipe_lines SET qty_per_unit = 250 WHERE product_id = ?', [SEED.product1.id]);
        lines = await parentLines(invoiceId);
        await saveTable(
            [
                { id: SEED.product1.id, qty: 4, price: 5, note: '', order_item_id: lines.find((row) => !row.note).id },
                { id: SEED.product1.id, qty: 1, price: 5, note: 'no onion', order_item_id: lines.find((row) => row.note === 'no onion').id }
            ],
            { subtotal: 25, tax: 4, total: 29 },
            invoiceId
        );
        expect(await netFor(chicken, keyA)).toBe(-800);
        expect(await netFor(chicken, keyB)).toBe(-200);

        lines = await parentLines(invoiceId);
        await saveTable(
            [
                { id: SEED.product1.id, qty: 4, price: 5, note: '', order_item_id: lines.find((row) => !row.note).id },
                { id: SEED.product1.id, qty: 1, price: 5, note: 'no onion', order_item_id: lines.find((row) => row.note === 'no onion').id },
                { id: SEED.product1.id, qty: 1, price: 5, note: '' }
            ],
            { subtotal: 30, tax: 4.8, total: 34.8 },
            invoiceId
        );
        lines = await parentLines(invoiceId);
        const lineA = lines.find((row) => row.recipe_line_key === keyA);
        const lineB = lines.find((row) => row.recipe_line_key === keyB);
        const lineC = lines.find((row) => row.recipe_line_key && row.recipe_line_key !== keyA && row.recipe_line_key !== keyB);
        expect(lineC?.recipe_line_key).toMatch(/^[0-9a-f]{32}$/);
        expect(Number(lineA.quantity)).toBe(4);
        expect(Number(lineB.quantity)).toBe(1);
        expect(await netFor(chicken, keyA)).toBe(-800);
        expect(await netFor(chicken, keyB)).toBe(-200);
        expect(await netFor(chicken, lineC.recipe_line_key)).toBe(-250);

        await openShift();
        const beforeSettle = await movementCount();
        const pay = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [
                    { id: SEED.product1.id, qty: 4, price: 5, note: '', order_item_id: lineA.id, recipe_line_key: 'ffffffffffffffffffffffffffffffff' },
                    { id: SEED.product1.id, qty: 1, price: 5, note: 'no onion', order_item_id: lineB.id },
                    { id: SEED.product1.id, qty: 1, price: 5, note: '', order_item_id: lineC.id }
                ],
                shift_id: cashierShiftId,
                edit_invoice_id: invoiceId,
                table_id: SEED.table.id,
                subtotal: 30,
                tax: 4.8,
                total: 34.8,
                payment_method: 'cash',
                amount_tendered: 34.8,
                change_due: 0,
                idempotency_key: `recipe-ledger-settle-${invoiceId}`
            });
        expect(pay.statusCode).toBe(200);
        const settled = await parentLines(invoiceId);
        expect(settled.map((row) => row.recipe_line_key).sort()).toEqual(
            [keyA, keyB, lineC.recipe_line_key].sort()
        );
        expect(await movementCount()).toBe(beforeSettle);
        expect(await netFor(chicken, keyA)).toBe(-800);
        expect(await netFor(chicken, keyB)).toBe(-200);
        expect(await netFor(chicken, lineC.recipe_line_key)).toBe(-250);
    });

    it('does not mint keys or write usage for lines saved while the setting is off', async () => {
        const invoiceId = await saveTable(
            [{ id: SEED.product1.id, qty: 2, price: 5, note: '' }],
            { subtotal: 10, tax: 1.6, total: 11.6 }
        );
        let [line] = await parentLines(invoiceId);
        expect(line.recipe_line_key).toBeNull();
        expect(await movementCount()).toBe(0);

        await enableLedger();
        await saveTable(
            [{ id: SEED.product1.id, qty: 2, price: 5, note: '', order_item_id: line.id }],
            { subtotal: 10, tax: 1.6, total: 11.6 },
            invoiceId
        );
        [line] = await parentLines(invoiceId);
        expect(line.recipe_line_key).toBeNull();
        expect(await movementCount()).toBe(0);
    });

    it('writes keys and usage on direct checkout and held-order checkout', async () => {
        await enableLedger();
        await openShift();
        const direct = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product2.id, qty: 2, price: 2 }],
                shift_id: cashierShiftId,
                subtotal: 4,
                tax: 0,
                total: 4,
                payment_method: 'cash',
                amount_tendered: 4,
                change_due: 0,
                idempotency_key: 'recipe-ledger-direct-drinks'
            });
        expect(direct.statusCode).toBe(200);
        const [directLines] = await pool.query(
            'SELECT recipe_line_key FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL',
            [direct.body.invoice_id]
        );
        expect(directLines).toHaveLength(1);
        expect(directLines[0].recipe_line_key).toMatch(/^[0-9a-f]{32}$/);
        expect(await netFor(pepsi, directLines[0].recipe_line_key)).toBe(-2);

        const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
            reference_name: 'recipe-ledger-hold',
            subtotal: 4,
            cart: { items: [{ id: SEED.product2.id, qty: 2, price: 2 }] }
        });
        expect(held.statusCode).toBe(200);
        const [[heldRow]] = await pool.query('SELECT version FROM held_orders WHERE id=?', [held.body.id]);
        const claim = await request(app)
            .post(`/api/pos/held_orders/${held.body.id}/claim`)
            .set('Cookie', cashierCookie)
            .send({ claim_token: 'e'.repeat(64), expected_version: Number(heldRow?.version || 1) });
        expect(claim.statusCode).toBe(200);
        const heldPay = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: JSON.parse(claim.body.order.cart_data).items,
            held_order_context: {
                id: held.body.id,
                claim_token: claim.body.claim.claimToken,
                expected_version: claim.body.claim.version,
                operation_id: `77777777-7777-4777-8777-${String(held.body.id).padStart(12, '0')}`
            },
            shift_id: cashierShiftId,
            subtotal: 4,
            tax: 0,
            total: 4,
            payment_method: 'cash',
            amount_tendered: 4,
            change_due: 0,
            idempotency_key: 'recipe-ledger-held-drinks'
        });
        expect(heldPay.statusCode).toBe(200);
        const [heldLines] = await pool.query(
            'SELECT recipe_line_key FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL',
            [heldPay.body.invoice_id]
        );
        expect(heldLines).toHaveLength(1);
        expect(heldLines[0].recipe_line_key).toMatch(/^[0-9a-f]{32}$/);
        expect(await netFor(pepsi, heldLines[0].recipe_line_key)).toBe(-2);
    });
});
