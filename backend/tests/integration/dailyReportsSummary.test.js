const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { insertShift, insertPaidOrder, insertOrderItem, insertOrderRefund } = require('../helpers/fixtures');
const { expectMoney } = require('../helpers/assertions');

describe('Daily Reports Summary API', () => {
    let adminCookie;

    beforeAll(async () => {
        await seedDatabase();

        // Login admin for reports query
        const adminLoginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminLoginRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    it('implements event-date based reporting for sales and refunds (Monday sale vs Tuesday refund)', async () => {
        // Clear orders, order_items, refunds, shifts for clean test
        await pool.query('DELETE FROM refund_items');
        await pool.query('DELETE FROM refunds');
        await pool.query('DELETE FROM order_items');
        await pool.query('DELETE FROM orders');
        await pool.query('DELETE FROM shifts');

        const shiftId = await insertShift(pool, { status: 'closed', opened_at: '2026-07-06 06:00:00', closed_at: '2026-07-06 14:00:00' });

        // Monday order: July 6 (Monday) 10:00:00
        const orderId = await insertPaidOrder(pool, {
            shift_id: shiftId,
            total: 100.00,
            subtotal: 86.21,
            tax: 13.79,
            payment_method: 'cash',
            cash_amount: 100.00,
            created_at: '2026-07-06 10:00:00',
            invoice_issued_at: '2026-07-06 10:00:00'
        });
        await insertOrderItem(pool, {
            invoice_id: orderId,
            quantity: 1,
            price_at_sale: 86.21,
            tax_rate: 16.00,
            tax_amount: 13.79
        });

        // Tuesday refund: July 7 (Tuesday) 11:00:00
        // Tuesday refund of a part of Monday's order
        const refundShiftId = await insertShift(pool, { status: 'closed', opened_at: '2026-07-07 06:00:00', closed_at: '2026-07-07 14:00:00' });
        await insertOrderRefund(pool, {
            invoice_id: orderId,
            scope: 'item',
            shift_id: refundShiftId,
            subtotal_refunded: 17.24,
            tax_refunded: 2.76,
            amount_refunded: 20.00,
            refund_method: 'cash',
            created_at: '2026-07-07 11:00:00'
        });
        await insertOrderRefund(pool, {
            kind: 'void',
            invoice_id: orderId,
            scope: 'item',
            shift_id: refundShiftId,
            amount_refunded: 0,
            created_at: '2026-07-07 11:05:00'
        });
        await insertOrderRefund(pool, {
            kind: 'void',
            invoice_id: orderId,
            scope: 'order',
            shift_id: refundShiftId,
            amount_refunded: 0,
            created_at: '2026-07-07 11:10:00'
        });

        const mondayRes = await request(app)
            .get('/api/admin/reports/summary?start_date=2026-07-06&end_date=2026-07-06')
            .set('Cookie', adminCookie);

        const tuesdayRes = await request(app)
            .get('/api/admin/reports/summary?start_date=2026-07-07&end_date=2026-07-07')
            .set('Cookie', adminCookie);

        expect(mondayRes.statusCode).toBe(200);
        expect(tuesdayRes.statusCode).toBe(200);

        expectMoney(mondayRes.body.summary.sales_processed, 100);
        expectMoney(mondayRes.body.summary.refunds_issued, 0);
        expectMoney(mondayRes.body.summary.sales_collected, 100);

        expectMoney(tuesdayRes.body.summary.sales_processed, 0);
        expectMoney(tuesdayRes.body.summary.refunds_issued, 20);
        expectMoney(tuesdayRes.body.summary.sales_collected, -20);
        expect(tuesdayRes.body.summary.refund_order_count).toBe(0);
        expect(tuesdayRes.body.summary.refund_item_count).toBe(1);
        expect(tuesdayRes.body.summary.void_order_count).toBe(1);
        expect(tuesdayRes.body.summary.void_item_count).toBe(1);
    });

    it('does not sum sequential drawer snapshots and reports per-window cash_status', async () => {
        await pool.query('DELETE FROM refund_items');
        await pool.query('DELETE FROM refunds');
        await pool.query('DELETE FROM order_items');
        await pool.query('DELETE FROM orders');
        await pool.query('DELETE FROM shifts');

        const firstShiftId = await insertShift(pool, {
            status: 'closed',
            opened_at: '2026-07-14 06:00:00',
            closed_at: '2026-07-14 12:00:00',
            starting_cash: 100,
            expected_cash: 400,
            actual_cash: 400,
        });
        const firstOrderId = await insertPaidOrder(pool, {
            shift_id: firstShiftId,
            total: 300,
            subtotal: 300,
            tax: 0,
            payment_method: 'cash',
            cash_amount: 300,
            created_at: '2026-07-14 10:00:00',
            invoice_issued_at: '2026-07-14 10:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: firstOrderId,
            quantity: 1,
            price_at_sale: 300,
            tax_rate: 0,
            tax_amount: 0,
        });

        const secondShiftId = await insertShift(pool, {
            status: 'closed',
            opened_at: '2026-07-14 12:00:00',
            closed_at: '2026-07-14 18:00:00',
            starting_cash: 400,
            expected_cash: 700,
            actual_cash: 700,
        });
        const secondOrderId = await insertPaidOrder(pool, {
            shift_id: secondShiftId,
            total: 300,
            subtotal: 300,
            tax: 0,
            payment_method: 'cash',
            cash_amount: 300,
            created_at: '2026-07-14 13:00:00',
            invoice_issued_at: '2026-07-14 13:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: secondOrderId,
            quantity: 1,
            price_at_sale: 300,
            tax_rate: 0,
            tax_amount: 0,
        });

        const res = await request(app)
            .get('/api/admin/reports/summary?start_date=2026-07-14&end_date=2026-07-14')
            .set('Cookie', adminCookie);

        expect(res.statusCode).toBe(200);
        expectMoney(res.body.summary.cash_collected, 600);
        expect(res.body.cash_status).toEqual({
            state: 'balanced',
            open_shifts: 0,
            closed_shifts: 2,
            closed_outside_window: 0,
            uncounted_shifts: 0,
            shifts_needing_review: 0,
            net_variance: 0,
            shortage_total: 0,
            overage_total: 0,
        });
        for (const key of ['expected_cash', 'actual_cash', 'variance']) {
            expect(res.body.cash_status).not.toHaveProperty(key);
        }
    });

    it('returns service charge, comparison, payments, and open shift status', async () => {
        // Clear all database tables for this check
        await pool.query('DELETE FROM refund_items');
        await pool.query('DELETE FROM refunds');
        await pool.query('DELETE FROM order_items');
        await pool.query('DELETE FROM orders');
        await pool.query('DELETE FROM shifts');

        // Seed comparison day: 2026-07-07
        const compShiftId = await insertShift(pool, { status: 'closed', opened_at: '2026-07-07 06:00:00', closed_at: '2026-07-07 14:00:00', expected_cash: 120, actual_cash: 120 });
        const oComp = await insertPaidOrder(pool, {
            shift_id: compShiftId,
            total: 100.00,
            subtotal: 100.00,
            tax: 0.00,
            payment_method: 'cash',
            cash_amount: 100.00,
            created_at: '2026-07-07 10:00:00',
            invoice_issued_at: '2026-07-07 10:00:00'
        });
        await insertOrderItem(pool, { invoice_id: oComp, quantity: 1, price_at_sale: 100.00, tax_rate: 0, tax_amount: 0 });

        // Seed current day: 2026-07-14 (exactly 7 days later)
        // Also have an open shift to trigger state: 'in_progress'
        const currShiftId = await insertShift(pool, { status: 'open', opened_at: '2026-07-14 06:00:00', closed_at: null, expected_cash: 135.80, actual_cash: null });

        // Order on 2026-07-14 with 5.80 service charge (110.00 total)
        // Service charge is order_items with note = 'Auto-Gratuity', parent_item_id is NULL
        const oCurr = await insertPaidOrder(pool, {
            shift_id: currShiftId,
            total: 110.00,
            subtotal: 104.20,
            tax: 0.00,
            payment_method: 'split',
            cash_amount: 60.00,
            card_amount: 50.00,
            created_at: '2026-07-14 10:00:00',
            invoice_issued_at: '2026-07-14 10:00:00'
        });
        await insertOrderItem(pool, {
            invoice_id: oCurr,
            quantity: 1,
            price_at_sale: 104.20,
            tax_rate: 0,
            tax_amount: 0
        });
        // Auto-Gratuity item
        const agItemId = await insertOrderItem(pool, {
            invoice_id: oCurr,
            quantity: 1,
            price_at_sale: 5.80,
            tax_rate: 0,
            tax_amount: 0
        });
        await pool.query("UPDATE order_items SET note = 'Auto-Gratuity', product_id = NULL WHERE id = ?", [agItemId]);

        const res = await request(app)
            .get('/api/admin/reports/summary?start_date=2026-07-14&end_date=2026-07-14')
            .set('Cookie', adminCookie);

        expect(res.statusCode).toBe(200);
        const { summary, comparison, cash_status, period } = res.body;

        expectMoney(summary.sales_processed, 110);
        expectMoney(summary.sales_collected, 110);
        expectMoney(summary.service_charges_collected, 5.80);
        expectMoney(summary.cash_collected + summary.card_collected, summary.sales_collected);
        expectMoney(summary.cash_collected, 60.00);
        expectMoney(summary.card_collected, 50.00);

        expect(comparison.sales_collected).toEqual({ amount: 10, percent: 10 });
        expect(cash_status).toEqual({
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
            expect(cash_status).not.toHaveProperty(key);
        }
        expect(period.business_day_start_hour).toBe(6);
    });

});
