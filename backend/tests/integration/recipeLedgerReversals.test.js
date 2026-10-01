const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { getBusinessDate } = require('../../utils/businessDate');

describe('recipe ledger reversals', () => {
    let adminCookie;
    let cashierCookie;
    let cashierShiftId;
    let chicken;
    let pepsi;

    beforeEach(async () => {
        await seedDatabase();
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
        const [[shift]] = await pool.query(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
            [SEED.cashierUser.id]
        );
        cashierShiftId = shift.id;
    });

    afterAll(async () => {
        await pool.end();
    });

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

    async function checkoutBurgers(qty, extras = {}) {
        const subtotal = 5 * qty;
        const discounted = extras.order_discount_type === 'percent'
            ? Number((subtotal * (1 - extras.order_discount_value / 100)).toFixed(2))
            : subtotal;
        const tax = Number((discounted * 0.16).toFixed(2));
        const total = Number((discounted + tax).toFixed(2));
        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: SEED.product1.id, qty, price: 5 }],
            shift_id: cashierShiftId,
            subtotal,
            tax,
            total,
            payment_method: 'cash',
            amount_tendered: total,
            change_due: 0,
            idempotency_key: extras.idempotency_key || `recipe-refund-${qty}-${Date.now()}`,
            ...extras
        });
        expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
        const [[line]] = await pool.query(
            'SELECT id, recipe_line_key FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
            [res.body.invoice_id]
        );
        return { invoiceId: res.body.invoice_id, line };
    }

    it('refunds reverse frozen usage, reject a third pass, and ignore a 30% discount', async () => {
        const { invoiceId, line } = await checkoutBurgers(3);
        const key = line.recipe_line_key;
        expect(await netFor(chicken, key)).toBe(-600);
        const [[usage]] = await pool.query(
            "SELECT unit_cost FROM stock_movements WHERE movement_type='ingredient' AND line_key=? AND kind='usage' ORDER BY id LIMIT 1",
            [key]
        );

        const partial = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie).send({
            invoice_id: invoiceId,
            intent: 'refund',
            refund_method: 'cash',
            items: [{ order_item_id: line.id, qty: 1 }]
        });
        expect(partial.statusCode).toBe(200);
        expect(await netFor(chicken, key)).toBe(-400);
        const [[reversal]] = await pool.query(
            "SELECT unit_cost FROM stock_movements WHERE movement_type='ingredient' AND line_key=? AND kind='reversal' ORDER BY id DESC LIMIT 1",
            [key]
        );
        expect(Number(reversal.unit_cost)).toBe(Number(usage.unit_cost));

        const full = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie).send({
            invoice_id: invoiceId,
            intent: 'refund',
            refund_method: 'cash',
            items: [{ order_item_id: line.id, qty: 2 }]
        });
        expect(full.statusCode).toBe(200);
        expect(await netFor(chicken, key)).toBe(0);
        const afterFull = await movementCount();

        const extra = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie).send({
            invoice_id: invoiceId,
            intent: 'refund',
            refund_method: 'cash',
            items: [{ order_item_id: line.id, qty: 1 }]
        });
        expect(extra.statusCode).toBeGreaterThanOrEqual(400);
        expect(await movementCount()).toBe(afterFull);

        const discountedSubtotal = 15;
        const discountedTax = 1.68;
        const discountedTotal = 12.18;
        const discountedPay = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: [{ id: SEED.product1.id, qty: 3, price: 5 }],
            subtotal: discountedSubtotal,
            tax: discountedTax,
            total: discountedTotal,
            payment_method: 'cash',
            amount_tendered: discountedTotal,
            change_due: 0,
            order_discount_type: 'percent',
            order_discount_value: 30,
            idempotency_key: 'recipe-refund-discounted'
        });
        expect(discountedPay.statusCode, JSON.stringify(discountedPay.body)).toBe(200);
        const [[discountedLine]] = await pool.query(
            'SELECT id, recipe_line_key FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
            [discountedPay.body.invoice_id]
        );
        expect(await netFor(chicken, discountedLine.recipe_line_key)).toBe(-600);
        const discRefund = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie).send({
            invoice_id: discountedPay.body.invoice_id,
            intent: 'refund',
            refund_method: 'cash',
            items: [{ order_item_id: discountedLine.id, qty: 1 }]
        });
        expect(discRefund.statusCode).toBe(200);
        expect(await netFor(chicken, discountedLine.recipe_line_key)).toBe(-400);
    });

    it('voids only the remaining bundle composition', async () => {
        const save = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [{
                id: SEED.bundleProduct.id,
                product_id: SEED.bundleProduct.id,
                name: SEED.bundleProduct.name,
                qty: 1,
                price: 10,
                is_bundle: true,
                bundleItems: [
                    { product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, removed: false },
                    { product_id: SEED.product2.id, name: SEED.product2.name, qty: 1, removed: true }
                ]
            }],
            subtotal: 10,
            tax: 1.6,
            total: 11.6
        });
        expect(save.statusCode, JSON.stringify(save.body)).toBe(200);
        const invoiceId = save.body.invoice_id || save.body.order_id;
        const [[parent]] = await pool.query(
            'SELECT id, recipe_line_key FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
            [invoiceId]
        );
        expect(await netFor(chicken, parent.recipe_line_key)).toBe(-200);
        expect(await netFor(pepsi, parent.recipe_line_key)).toBe(0);

        const voidRes = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie).send({
            invoice_id: invoiceId,
            expected_version: await currentTableRevision(invoiceId), intent: 'void',
            items: [{ order_item_id: parent.id, qty: 1 }]
        });
        expect(voidRes.statusCode).toBe(200);
        expect(await netFor(chicken, parent.recipe_line_key)).toBe(0);
        const [[pepsiRows]] = await pool.query(
            "SELECT COUNT(*) AS c FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=?",
            [pepsi]
        );
        expect(Number(pepsiRows.c)).toBe(0);
    });

    it('still reverses after the setting is turned off', async () => {
        const { invoiceId, line } = await checkoutBurgers(1, { idempotency_key: 'recipe-refund-after-off' });
        expect(await netFor(chicken, line.recipe_line_key)).toBe(-200);
        await pool.query(
            "UPDATE settings SET setting_value='0' WHERE setting_key='recipe_ledger_enabled'"
        );
        const refund = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie).send({
            invoice_id: invoiceId,
            intent: 'refund',
            refund_method: 'cash',
            items: [{ order_item_id: line.id, qty: 1 }]
        });
        expect(refund.statusCode).toBe(200);
        expect(await netFor(chicken, line.recipe_line_key)).toBe(0);
    });
});
