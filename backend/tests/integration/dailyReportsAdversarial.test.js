const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const {
    insertShift,
    insertPaidOrder,
    insertOrderItem,
    insertOrderRefund,
} = require('../helpers/fixtures');
const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');
const { buildDailySummary } = require('../../services/dailyReportBuilder');
const { buildDailySalesDetails } = require('../../services/dailySalesDetailsBuilder');
const { buildRefundReport } = require('../../services/dailyRefundReportBuilder');
const { expectMoney } = require('../helpers/assertions');

const periodFor = (date) => parseDailyReportPeriod({ startDate: date, endDate: date });

async function addRefundItem({ refundId, orderItemId, productId = SEED.product1.id, amount, quantity = 1 }) {
    await pool.query(`
        INSERT INTO refund_items (
            refund_id, order_item_id, product_id, item_name, quantity,
            unit_price, line_subtotal, line_tax, line_total
        ) VALUES (?, ?, ?, 'Test Burger', ?, ?, ?, 0, ?)
    `, [refundId, orderItemId, productId, quantity, amount, amount, amount]);
}

describe('Daily Reports adversarial financial invariants', () => {
    beforeEach(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('keeps a sale-day discount immutable after a later full refund', async () => {
        const shiftId = await insertShift(pool, { opened_at: '2026-07-06 06:00:00' });
        const orderId = await insertPaidOrder(pool, {
            shift_id: shiftId,
            subtotal: 100,
            tax: 0,
            total: 90,
            payment_method: 'cash',
            cash_amount: 90,
            discount_type: 'fixed',
            discount_value: 10,
            created_at: '2026-07-06 10:00:00',
            invoice_issued_at: '2026-07-06 10:00:00',
        });
        const orderItemId = await insertOrderItem(pool, {
            invoice_id: orderId,
            quantity: 1,
            price_at_sale: 100,
            tax_rate: 0,
            tax_amount: 0,
        });

        const beforeRefund = await buildDailySummary(pool, periodFor('2026-07-06'));
        const refundId = await insertOrderRefund(pool, {
            invoice_id: orderId,
            amount_refunded: 90,
            subtotal_refunded: 90,
            refund_method: 'cash',
            created_at: '2026-07-07 11:00:00',
        });
        await addRefundItem({ refundId, orderItemId, amount: 90 });
        const afterRefund = await buildDailySummary(pool, periodFor('2026-07-06'));

        expectMoney(beforeRefund.summary.discounts_total, 10);
        expectMoney(afterRefund.summary.discounts_total, 10);
        expect(afterRefund.summary.discounted_orders).toBe(1);
    });

    it('uses the same frozen tender allocation on Summary and Refunds for split refunds', async () => {
        const shiftId = await insertShift(pool, { opened_at: '2026-07-14 06:00:00' });
        const orderId = await insertPaidOrder(pool, {
            shift_id: shiftId,
            subtotal: 100,
            tax: 0,
            total: 100,
            payment_method: 'split',
            cash_amount: 60,
            card_amount: 40,
            created_at: '2026-07-14 10:00:00',
            invoice_issued_at: '2026-07-14 10:00:00',
        });
        await insertOrderRefund(pool, {
            invoice_id: orderId,
            shift_id: shiftId,
            amount_refunded: 10.01,
            subtotal_refunded: 10.01,
            refund_method: 'split',
            created_at: '2026-07-14 11:00:00',
        });

        const period = periodFor('2026-07-14');
        const summary = await buildDailySummary(pool, period);
        const refunds = await buildRefundReport(pool, period);

        expectMoney(60 - summary.summary.cash_collected, 6.01);
        expectMoney(40 - summary.summary.card_collected, 4);
        expectMoney(refunds.summary.refund_cash, 6.01);
        expectMoney(refunds.summary.refund_card, 4);
        expectMoney(refunds.summary.refund_cash + refunds.summary.refund_card, refunds.summary.refund_total);
    });

    it('allocates an order discount to the service charge and keeps product totals reconcilable', async () => {
        const shiftId = await insertShift(pool, { opened_at: '2026-07-14 06:00:00' });
        const orderId = await insertPaidOrder(pool, {
            shift_id: shiftId,
            subtotal: 110,
            tax: 0,
            total: 99,
            payment_method: 'cash',
            cash_amount: 99,
            discount_type: 'percent',
            discount_value: 10,
            created_at: '2026-07-14 10:00:00',
            invoice_issued_at: '2026-07-14 10:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: orderId,
            quantity: 1,
            price_at_sale: 100,
            tax_rate: 0,
            tax_amount: 0,
        });
        const serviceChargeItemId = await insertOrderItem(pool, {
            invoice_id: orderId,
            product_id: null,
            quantity: 1,
            price_at_sale: 10,
            tax_rate: 0,
            tax_amount: 0,
        });
        await pool.query("UPDATE order_items SET note = 'Auto-Gratuity' WHERE id = ?", [serviceChargeItemId]);

        const period = periodFor('2026-07-14');
        const summary = await buildDailySummary(pool, period);
        const details = await buildDailySalesDetails(pool, period);
        const productNet = details.products.reduce((sum, product) => sum + Number(product.net_sales), 0);

        expectMoney(summary.summary.service_charges_collected, 9);
        expectMoney(details.totals.service_charges_collected, 9);
        expectMoney(details.totals.menu_sales, 90);
        expectMoney(productNet, details.totals.menu_sales);
    });

    it('attributes cyclic categories once under Uncategorized', async () => {
        const [categoryA] = await pool.query("INSERT INTO categories (name, parent_id) VALUES ('Cycle A', NULL)");
        const [categoryB] = await pool.query("INSERT INTO categories (name, parent_id) VALUES ('Cycle B', ?)", [categoryA.insertId]);
        await pool.query('UPDATE categories SET parent_id = ? WHERE id = ?', [categoryB.insertId, categoryA.insertId]);
        await pool.query('UPDATE products SET category_id = ? WHERE id = ?', [categoryA.insertId, SEED.product1.id]);

        const shiftId = await insertShift(pool, { opened_at: '2026-07-14 06:00:00' });
        const orderId = await insertPaidOrder(pool, {
            shift_id: shiftId,
            subtotal: 10,
            tax: 0,
            total: 10,
            payment_method: 'cash',
            cash_amount: 10,
            created_at: '2026-07-14 10:00:00',
            invoice_issued_at: '2026-07-14 10:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: orderId,
            quantity: 1,
            price_at_sale: 10,
            tax_rate: 0,
            tax_amount: 0,
        });

        const details = await buildDailySalesDetails(pool, periodFor('2026-07-14'));
        const activeCategories = details.categories.filter(category => Number(category.net_sales) !== 0);

        expect(activeCategories).toHaveLength(1);
        expect(activeCategories[0].category_id).toBeNull();
        expect(activeCategories[0].name).toBe('Uncategorized');
        expectMoney(activeCategories[0].net_sales, 10);
        expectMoney(details.categories.reduce((sum, category) => sum + Number(category.net_sales), 0), 10);
    });

    it('reconciles order types across Other sales and refund-only types', async () => {
        const mondayShift = await insertShift(pool, { opened_at: '2026-07-13 06:00:00' });
        const tuesdayShift = await insertShift(pool, { opened_at: '2026-07-14 06:00:00' });
        const oldOrderId = await insertPaidOrder(pool, {
            shift_id: mondayShift,
            subtotal: 10,
            tax: 0,
            total: 10,
            payment_method: 'cash',
            cash_amount: 10,
            created_at: '2026-07-13 10:00:00',
            invoice_issued_at: '2026-07-13 10:00:00',
        });
        const oldItemId = await insertOrderItem(pool, {
            invoice_id: oldOrderId,
            quantity: 1,
            price_at_sale: 10,
            tax_rate: 0,
            tax_amount: 0,
        });
        const refundId = await insertOrderRefund(pool, {
            invoice_id: oldOrderId,
            shift_id: tuesdayShift,
            amount_refunded: 10,
            subtotal_refunded: 10,
            refund_method: 'cash',
            created_at: '2026-07-14 11:00:00',
        });
        await addRefundItem({ refundId, orderItemId: oldItemId, amount: 10 });

        const otherOrderId = await insertPaidOrder(pool, {
            shift_id: tuesdayShift,
            order_type_id: null,
            subtotal: 20,
            tax: 0,
            total: 20,
            payment_method: 'cash',
            cash_amount: 20,
            created_at: '2026-07-14 12:00:00',
            invoice_issued_at: '2026-07-14 12:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: otherOrderId,
            quantity: 1,
            price_at_sale: 20,
            tax_rate: 0,
            tax_amount: 0,
        });

        const period = periodFor('2026-07-14');
        const summary = await buildDailySummary(pool, period);
        const details = await buildDailySalesDetails(pool, period);

        expectMoney(summary.order_types.reduce((sum, row) => sum + row.net_sales, 0), summary.summary.sales_collected);
        expectMoney(details.order_types.reduce((sum, row) => sum + row.net_sales, 0), details.totals.sales_collected);
        expect(summary.order_types.find(row => row.name === 'Other')?.net_sales).toBe(20);
        expect(summary.order_types.find(row => row.name === 'Dine In')?.net_sales).toBe(-10);
        expect(details.order_types.find(row => row.name === 'Other')?.net_sales).toBe(20);
        expect(details.order_types.find(row => row.name === 'Dine In')?.net_sales).toBe(-10);
    });

    it('marks a spanning open shift as in progress when it has activity in the period', async () => {
        const shiftId = await insertShift(pool, {
            status: 'open',
            opened_at: '2026-07-13 20:00:00',
            closed_at: null,
        });
        await insertPaidOrder(pool, {
            shift_id: shiftId,
            subtotal: 10,
            tax: 0,
            total: 10,
            payment_method: 'cash',
            cash_amount: 10,
            created_at: '2026-07-14 10:00:00',
            invoice_issued_at: '2026-07-14 10:00:00',
        });

        const summary = await buildDailySummary(pool, periodFor('2026-07-14'));

        expect(summary.cash_status).toEqual({
            state: 'in_progress',
            open_shifts: 1,
            closed_shifts: 0,
            closed_outside_window: 0,
            uncounted_shifts: 0,
            shifts_needing_review: 0,
            net_variance: null,
            shortage_total: null,
            overage_total: null,
        });
        for (const key of ['expected_cash', 'actual_cash', 'variance']) {
            expect(summary.cash_status).not.toHaveProperty(key);
        }
    });

    it('does not sum sequential drawer snapshots and reports zero variance for two balanced closes', async () => {
        const firstShiftId = await insertShift(pool, {
            status: 'closed',
            opened_at: '2026-07-14 06:00:00',
            closed_at: '2026-07-14 12:00:00',
            starting_cash: 100,
            expected_cash: 400,
            actual_cash: 400,
        });
        await insertPaidOrder(pool, {
            shift_id: firstShiftId,
            subtotal: 300,
            tax: 0,
            total: 300,
            payment_method: 'cash',
            cash_amount: 300,
            created_at: '2026-07-14 10:00:00',
            invoice_issued_at: '2026-07-14 10:00:00',
        });
        const secondShiftId = await insertShift(pool, {
            status: 'closed',
            opened_at: '2026-07-14 12:00:00',
            closed_at: '2026-07-14 18:00:00',
            starting_cash: 400,
            expected_cash: 700,
            actual_cash: 700,
        });
        await insertPaidOrder(pool, {
            shift_id: secondShiftId,
            subtotal: 300,
            tax: 0,
            total: 300,
            payment_method: 'cash',
            cash_amount: 300,
            created_at: '2026-07-14 13:00:00',
            invoice_issued_at: '2026-07-14 13:00:00',
        });

        const result = await buildDailySummary(pool, periodFor('2026-07-14'));

        expectMoney(result.summary.cash_collected, 600);
        expect(result.cash_status).toEqual({
            state: 'balanced', open_shifts: 0, closed_shifts: 2,
            closed_outside_window: 0, uncounted_shifts: 0,
            shifts_needing_review: 0, net_variance: 0,
            shortage_total: 0, overage_total: 0,
        });
        for (const key of ['expected_cash', 'actual_cash', 'variance']) {
            expect(result.cash_status).not.toHaveProperty(key);
        }
    });

    it('keeps opposite shortages and overages as review with separate totals', async () => {
        await insertShift(pool, {
            status: 'closed',
            opened_at: '2026-07-14 06:00:00',
            closed_at: '2026-07-14 12:00:00',
            starting_cash: 100,
            expected_cash: 100,
            actual_cash: 104,
        });
        await insertShift(pool, {
            status: 'closed',
            opened_at: '2026-07-14 12:00:00',
            closed_at: '2026-07-14 18:00:00',
            starting_cash: 104,
            expected_cash: 100,
            actual_cash: 96,
        });

        const result = await buildDailySummary(pool, periodFor('2026-07-14'));

        expect(result.cash_status).toEqual({
            state: 'review',
            open_shifts: 0,
            closed_shifts: 2,
            closed_outside_window: 0,
            uncounted_shifts: 0,
            shifts_needing_review: 2,
            net_variance: 0,
            shortage_total: 4,
            overage_total: 4,
        });
    });

    it('treats a closed shift with null actual_cash as uncounted in-progress money', async () => {
        const shiftId = await insertShift(pool, {
            status: 'closed',
            opened_at: '2026-07-14 06:00:00',
            closed_at: '2026-07-14 14:00:00',
            starting_cash: 50,
            expected_cash: 90,
            actual_cash: 90,
        });
        await pool.query('UPDATE shifts SET actual_cash = NULL WHERE id = ?', [shiftId]);

        const result = await buildDailySummary(pool, periodFor('2026-07-14'));

        expect(result.cash_status).toEqual({
            state: 'in_progress',
            open_shifts: 0,
            closed_shifts: 1,
            closed_outside_window: 0,
            uncounted_shifts: 1,
            shifts_needing_review: 0,
            net_variance: null,
            shortage_total: null,
            overage_total: null,
        });
        for (const key of ['expected_cash', 'actual_cash', 'variance']) {
            expect(result.cash_status).not.toHaveProperty(key);
        }
    });

    it('attributes a cross-day shift variance to the closing business window exactly once', async () => {
        const shiftId = await insertShift(pool, {
            status: 'closed',
            opened_at: '2026-07-01 22:00:00',
            closed_at: '2026-07-02 08:00:00',
            starting_cash: 50,
            expected_cash: 80,
            actual_cash: 77,
        });
        await insertPaidOrder(pool, {
            shift_id: shiftId,
            subtotal: 20,
            tax: 0,
            total: 20,
            payment_method: 'cash',
            cash_amount: 20,
            created_at: '2026-07-01 23:00:00',
            invoice_issued_at: '2026-07-01 23:00:00',
        });
        await insertPaidOrder(pool, {
            shift_id: shiftId,
            subtotal: 10,
            tax: 0,
            total: 10,
            payment_method: 'cash',
            cash_amount: 10,
            created_at: '2026-07-02 07:00:00',
            invoice_issued_at: '2026-07-02 07:00:00',
        });

        const day1 = await buildDailySummary(pool, periodFor('2026-07-01'));
        const day2 = await buildDailySummary(pool, periodFor('2026-07-02'));
        const bothDays = await buildDailySummary(pool, parseDailyReportPeriod({
            startDate: '2026-07-01',
            endDate: '2026-07-02',
        }));

        expect(day1.cash_status).toMatchObject({
            state: 'no_shifts',
            open_shifts: 0,
            closed_shifts: 0,
            closed_outside_window: 1,
            uncounted_shifts: 0,
            shifts_needing_review: 0,
            net_variance: null,
            shortage_total: null,
            overage_total: null,
        });
        expect(day2.cash_status).toMatchObject({
            state: 'review',
            open_shifts: 0,
            closed_shifts: 1,
            closed_outside_window: 0,
            uncounted_shifts: 0,
            shifts_needing_review: 1,
            net_variance: -3,
            shortage_total: 3,
            overage_total: 0,
        });
        expect(bothDays.cash_status).toMatchObject({
            closed_shifts: 1,
            closed_outside_window: 0,
            net_variance: -3,
            shortage_total: 3,
            overage_total: 0,
        });
    });

    it('loads refund-only dimension names without per-row lookup queries', async () => {
        const shiftId = await insertShift(pool, { opened_at: '2026-07-13 06:00:00' });
        const invoiceId = await insertPaidOrder(pool, {
            shift_id: shiftId,
            user_id: SEED.cashierUser.id,
            subtotal: 10,
            tax: 0,
            total: 10,
            payment_method: 'cash',
            cash_amount: 10,
            created_at: '2026-07-13 10:00:00',
            invoice_issued_at: '2026-07-13 10:00:00',
        });
        const orderItemId = await insertOrderItem(pool, {
            invoice_id: invoiceId,
            product_id: SEED.product1.id,
            quantity: 1,
            price_at_sale: 10,
            tax_rate: 0,
            tax_amount: 0,
        });
        const refundId = await insertOrderRefund(pool, {
            invoice_id: invoiceId,
            shift_id: shiftId,
            amount_refunded: 10,
            subtotal_refunded: 10,
            refund_method: 'cash',
            created_at: '2026-07-14 10:00:00',
        });
        await addRefundItem({ refundId, orderItemId, amount: 10 });

        let perRowLookups = 0;
        const executor = {
            query(sql, params) {
                if (/SELECT name FROM users WHERE id = \?/i.test(sql) || /WHERE t\.id = \?/i.test(sql)) {
                    perRowLookups += 1;
                }
                return pool.query(sql, params);
            },
        };
        const details = await buildDailySalesDetails(executor, periodFor('2026-07-14'));

        expect(details.cashiers).toEqual(expect.arrayContaining([
            expect.objectContaining({ user_id: SEED.cashierUser.id, orders: 0, returned_amount: 10 })
        ]));
        expect(perRowLookups).toBe(0);
    });
});
