const { tableActionIntent } = require('../fixtures/tableActionIntent');
const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
afterAll(() => pool.end());

describe.each(['0','1'])('recipe ledger splits and merges (typed numbering=%s)', (numbering) => {
    let adminCookie;
    let cashierCookie;
    let cashierShiftId;
    let chicken;
    let pepsi;

    beforeEach(async () => {
        await seedDatabase();
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='order_type_numbering'", [numbering]);
        adminCookie = (await request(app).post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        cashierCookie = (await request(app).post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
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
        await pool.query(
            "UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'"
        );
        const shiftRes = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 50.00 });
        expect(shiftRes.statusCode).toBe(200);
        const [shifts] = await pool.query(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
            [SEED.cashierUser.id]
        );
        cashierShiftId = shifts[0].id;
    });


    async function saveTable(tableId, cart, totals, invoiceId = null) {
        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({ table_id: tableId, current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId), cart, ...totals });
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

    async function movementCount() {
        const [[row]] = await pool.query("SELECT COUNT(*) AS c FROM stock_movements WHERE movement_type='ingredient' ");
        return Number(row.c);
    }

    async function netFor(ingredientId, lineKey) {
        const [[row]] = await pool.query(
            "SELECT COALESCE(SUM(qty), 0) AS qty FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? AND line_key=?",
            [ingredientId, lineKey]
        );
        return Number(row.qty);
    }

    async function settleSplit(heldRow, cart, key) {
        const allocation = JSON.parse(heldRow.cart_data).split_money_cents;
        const totals = {
            subtotal: allocation.subtotal / 100,
            tax: allocation.tax / 100,
            total: allocation.total / 100
        };
        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart,
            shift_id: cashierShiftId,
            split_check_id: heldRow.id,
            table_id: SEED.table.id,
            payment_method: 'cash',
            cash_amount: totals.total,
            amount_tendered: totals.total,
            change_due: 0,
            idempotency_key: key,
            ...totals
        });
        expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
        return res.body.invoice_id;
    }

    it('copies an id-matched key onto progressive split children and writes no new usage', async () => {
        const invoiceId = await saveTable(
            SEED.table.id,
            [{ id: SEED.product1.id, qty: 2, price: 5, note: '' }],
            { subtotal: 10, tax: 1.6, total: 11.6 }
        );
        const [line] = await parentLines(invoiceId);
        const keyA = line.recipe_line_key;
        expect(keyA).toMatch(/^[0-9a-f]{32}$/);
        expect(await netFor(chicken, keyA)).toBe(-400);
        const afterSave = await movementCount();

        const split = await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
            tableId: SEED.table.id,
            currentOrderId: invoiceId,
            splits: [
                {
                    referenceName: 'Table 1 - Seat 1',
                    subtotal: 5.80,
                    items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16, order_item_id: line.id }]
                },
                {
                    referenceName: 'Table 1 - Seat 2',
                    subtotal: 5.80,
                    items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16, order_item_id: line.id }]
                }
            ]
        });
        expect(split.statusCode, JSON.stringify(split.body)).toBe(200);
        const [held] = await pool.query('SELECT id, cart_data FROM held_orders ORDER BY id');
        expect(held).toHaveLength(2);
        for (const row of held) {
            const payload = JSON.parse(row.cart_data);
            expect(payload.items[0].recipe_line_key).toBe(keyA);
        }

        const childIds = [];
        for (const row of held) {
            childIds.push(await settleSplit(
                row,
                [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16, order_item_id: line.id }],
                `recipe-split-${row.id}`
            ));
        }
        expect(await movementCount()).toBe(afterSave);
        expect(await netFor(chicken, keyA)).toBe(-400);
        for (const childId of childIds) {
            const children = await parentLines(childId);
            expect(children).toHaveLength(1);
            expect(children[0].recipe_line_key).toBe(keyA);
            const [[paidLine]]=await pool.query('SELECT recipe_cost_snapshot FROM order_items WHERE id=?',[children[0].id]);
            expect(JSON.parse(paidLine.recipe_cost_snapshot)).toMatchObject([{ingredient_id:chicken,qty_per_portion:200,cost_per_portion:0.9,complete:true}]);
        }
        const generations = require('../../services/StockReportGenerationService');
        const worker = require('../../services/StockReportWorker');
        const { getBusinessDate } = require('../../utils/businessDate');
        await generations.ensureCoverage(pool, { startDate: getBusinessDate(), endDate: getBusinessDate() });
        await worker.drain(pool);
        const analysis=await request(app).get('/api/admin/ingredients/analysis').set('Cookie',adminCookie);
        expect(analysis.body.totals).toMatchObject({net_revenue:10,known_cost:1.8,estimated_margin:8.2,incomplete:false});
        const history=await request(app).get('/api/pos/order_notes').set('Cookie',adminCookie);
        expect(history.statusCode).toBe(200);
        const historyItems=history.body.orders.flatMap(order=>order.items);
        expect(historyItems.length).toBeGreaterThan(0);
        expect(historyItems.every(item=>!Object.hasOwn(item,'recipe_cost_snapshot'))).toBe(true);
    });

    it('drops the key on fallback-matched seats and keeps it on a three-way id match', async () => {
        const invoiceId = await saveTable(
            SEED.table.id,
            [{ id: SEED.product1.id, qty: 1, price: 5, note: '' }],
            { subtotal: 5, tax: 0.8, total: 5.8 }
        );
        const [line] = await parentLines(invoiceId);
        const keyA = line.recipe_line_key;
        const afterSave = await movementCount();

        const fallback = await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
            tableId: SEED.table.id,
            currentOrderId: invoiceId,
            splits: [
                { referenceName: 'Fallback 1', subtotal: 2.90, items: [{ id: SEED.product1.id, qty: 0.5, price: 5, tax_rate: 16 }] },
                { referenceName: 'Fallback 2', subtotal: 2.90, items: [{ id: SEED.product1.id, qty: 0.5, price: 5, tax_rate: 16 }] }
            ]
        });
        expect(fallback.statusCode, JSON.stringify(fallback.body)).toBe(200);
        const [fallbackHeld] = await pool.query('SELECT cart_data FROM held_orders ORDER BY id');
        for (const row of fallbackHeld) {
            const payload = JSON.parse(row.cart_data);
            expect(payload.items[0].recipe_line_key == null).toBe(true);
        }

        await pool.query('DELETE FROM held_orders');
        const threeWay = await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
            tableId: SEED.table.id,
            currentOrderId: invoiceId,
            splits: [
                { referenceName: 'T1', subtotal: 1.94, items: [{ id: SEED.product1.id, qty: 1 / 3, price: 5, tax_rate: 16, order_item_id: line.id }] },
                { referenceName: 'T2', subtotal: 1.93, items: [{ id: SEED.product1.id, qty: 1 / 3, price: 5, tax_rate: 16, order_item_id: line.id }] },
                { referenceName: 'T3', subtotal: 1.93, items: [{ id: SEED.product1.id, qty: 1 / 3, price: 5, tax_rate: 16, order_item_id: line.id }] }
            ]
        });
        expect(threeWay.statusCode, JSON.stringify(threeWay.body)).toBe(200);
        const [held] = await pool.query('SELECT id, cart_data FROM held_orders ORDER BY id');
        expect(held).toHaveLength(3);
        expect(held.every((row) => JSON.parse(row.cart_data).items[0].recipe_line_key === keyA)).toBe(true);

        for (const row of held) {
            const qty = JSON.parse(row.cart_data).items[0].qty;
            await settleSplit(
                row,
                [{ id: SEED.product1.id, qty, price: 5, tax_rate: 16, order_item_id: line.id }],
                `recipe-three-${row.id}`
            );
        }
        expect(await movementCount()).toBe(afterSave);
        expect(await netFor(chicken, keyA)).toBe(-200);
    });

    it('keeps differently keyed drink lines separate across a merge', async () => {
        const sourceId = await saveTable(
            SEED.table.id,
            [
                { id: SEED.product1.id, qty: 1, price: 5, note: '' },
                { id: SEED.product2.id, qty: 1, price: 2, note: '' }
            ],
            { subtotal: 7, tax: 0.8, total: 7.8 }
        );
        const targetId = await saveTable(
            SEED.table2.id,
            [{ id: SEED.product2.id, qty: 1, price: 2, note: '' }],
            { subtotal: 2, tax: 0, total: 2 }
        );
        const sourceLines = await parentLines(sourceId);
        const targetLines = await parentLines(targetId);
        const keyA = sourceLines.find((row) => Number(row.product_id) === SEED.product1.id).recipe_line_key;
        const keyD = sourceLines.find((row) => Number(row.product_id) === SEED.product2.id).recipe_line_key;
        const keyE = targetLines[0].recipe_line_key;
        expect(new Set([keyA, keyD, keyE]).size).toBe(3);
        const afterSaves = await movementCount();

        const merge = await request(app).post('/api/pos/tables/transfer').set('Cookie', adminCookie).send(await tableActionIntent(pool, {
            sourceTableId: SEED.table.id,
            targetTableId: SEED.table2.id,
            action: 'merge'
        }));
        expect(merge.statusCode).toBe(200);
        const merged = await parentLines(targetId);
        expect(merged).toHaveLength(3);
        expect(merged.map((row) => row.recipe_line_key).sort()).toEqual([keyA, keyD, keyE].sort());
        expect(await movementCount()).toBe(afterSaves);

        await saveTable(
            SEED.table2.id,
            merged.map((row) => ({
                id: Number(row.product_id),
                qty: Number(row.quantity),
                price: Number(row.product_id) === SEED.product1.id ? 5 : 2,
                note: '',
                order_item_id: row.id
            })),
            { subtotal: 9, tax: 0.8, total: 9.8 },
            targetId
        );
        expect(await movementCount()).toBe(afterSaves);
        expect(await netFor(chicken, keyA)).toBe(-200);
        expect(await netFor(pepsi, keyD)).toBe(-1);
        expect(await netFor(pepsi, keyE)).toBe(-1);
    });
});
