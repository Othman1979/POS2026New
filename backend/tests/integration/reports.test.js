// integration/reports.test.js — Integration tests for admin reports summary and waiters
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { formatDbTimestamp, getBusinessDate } = require('../../utils/businessDate');
const {
    insertShift,
    insertPaidOrder,
    insertOrderItem,
    insertOrderRefund,
    insertVoidedOrder,
} = require('../helpers/fixtures');
const { expectMoney } = require('../helpers/assertions');

describe('Reports Integration Tests', () => {
    let cashierCookie;
    let adminCookie;
    let cashierShiftId;

    beforeAll(async () => {
        await seedDatabase();

        // Login cashier and open shift once for all report tests
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = loginRes.headers['set-cookie'][0];

        // Login admin for report requests (admin route requires auth)
        const adminLoginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminLoginRes.headers['set-cookie'][0];

        const shiftRes = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 50.00 });
        expect(shiftRes.statusCode).toBe(200);

        const [rows] = await pool.query(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
            [SEED.cashierUser.id]
        );
        cashierShiftId = rows[0].id;
    });

    afterAll(async () => {
        await pool.end();
    });

    describe('Date Parameter Filtering on Summary', () => {
        it('should return summary for today when no date params are passed', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-05-12T09:00:00Z'));
            try {
                const now = formatDbTimestamp(new Date());
                await insertPaidOrder(pool, {
                    shift_id: cashierShiftId,
                    subtotal: 2.00, tax: 0.00, total: 2.00, cash_amount: 2.00,
                    created_at: now, invoice_issued_at: now,
                });

                const res = await request(app)
                    .get('/api/admin/reports')
                    .set('Cookie', adminCookie);

                expect(res.statusCode).toBe(200);
                expect(res.body.success).toBe(true);
                expect(Number(res.body.sales_summary.total_orders)).toBe(1);
                expectMoney(res.body.sales_summary.sales_processed, 2.00);
            } finally {
                vi.useRealTimers();
            }
        });

        it('should return aggregated sales summary for a date range', async () => {
            const yesterdayStr = '2026-05-19';
            const todayStr = '2026-05-20';
            for (const [date, subtotal, tax, total] of [[yesterdayStr, 5.00, 0.80, 5.80], [todayStr, 2.00, 0.00, 2.00]]) {
                await insertPaidOrder(pool, {
                    shift_id: cashierShiftId,
                    subtotal, tax, total, cash_amount: total,
                    created_at: date + ' 12:00:00', invoice_issued_at: date + ' 12:00:00',
                });
            }

            const rangeRes = await request(app)
                .get(`/api/admin/reports?start_date=${yesterdayStr}&end_date=${todayStr}`)
                .set('Cookie', adminCookie);

            expect(rangeRes.statusCode).toBe(200);
            expect(rangeRes.body.success).toBe(true);

            const summary = rangeRes.body.sales_summary;
            expect(Number(summary.total_orders)).toBe(2);
            expectMoney(summary.sales_processed, 7.80);
            expect(rangeRes.body.date).toContain('to');
        });

        it('should return zero summary for a date range with no orders', async () => {
            const farPastDate = '2000-01-01';

            const res = await request(app)
                .get(`/api/admin/reports?start_date=${farPastDate}&end_date=${farPastDate}`)
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Number(res.body.sales_summary.total_orders)).toBe(0);
            expect(Number(res.body.sales_summary.sales_processed)).toBe(0);
        });

        it('returns a client error for an invalid compatibility date', async () => {
            const res = await request(app)
                .get('/api/admin/reports?date=2026-02-30')
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(400);
            expect(res.body.message).toBe('Invalid report date.');
        });
    });

    describe('Discount and Refund Netting on Summary', () => {
        it('keeps sale-time discount totals immutable after a partial item refund', async () => {
            const date = '2025-06-24';

            const invoiceId = await insertPaidOrder(pool, {
                shift_id: cashierShiftId,
                subtotal: 100.00,
                tax: 0.00,
                total: 90.00,
                discount_type: 'fixed',
                discount_value: 10.00,
                payment_method: 'cash',
                cash_amount: 90.00,
                created_at: date + ' 10:00:00',
                invoice_issued_at: date + ' 10:00:00',
            });
            const orderItemId = await insertOrderItem(pool, {
                invoice_id: invoiceId,
                product_id: SEED.product1.id,
                quantity: 2.000,
                price_at_sale: 50.000000,
                tax_rate: 0.00,
                tax_amount: 0.000000,
            });

            const refundRes = await request(app)
                .post('/api/pos/refunds')
                .set('Cookie', adminCookie)
                .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash', items: [{ order_item_id: orderItemId, qty: 1 }] });
            expect(refundRes.statusCode).toBe(200);

            // Update the refund created_at date so it matches the test date range
            await pool.query("UPDATE refunds SET created_at = ? WHERE invoice_id = ?", [date + ' 10:30:00', invoiceId]);

            const res = await request(app)
                .get(`/api/admin/reports?start_date=${date}&end_date=${date}`)
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);

            expect(Number(res.body.sales_summary.sales_processed)).toBeCloseTo(90.00, 2);
            expect(Number(res.body.sales_summary.refunds_issued)).toBeCloseTo(45.00, 2);
            expect(Number(res.body.sales_summary.sales_collected)).toBeCloseTo(45.00, 2);
            expect(Number(res.body.sales_summary.discounts_total)).toBeCloseTo(10.00, 2);
        });
    });

    describe('Waiter Attribution & Report Filtering', () => {
        let waiterAdminCookie;
        let waiterCashierCookie;
        const today = getBusinessDate();

        beforeAll(async () => {
            const adminLogin = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.adminUser.user_number });
            waiterAdminCookie = adminLogin.headers['set-cookie'][0];

            const cashierLogin = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            waiterCashierCookie = cashierLogin.headers['set-cookie'][0];
        });

        it('preserves the original waiter on a split-check child cashed out by the cashier', async () => {
            const [parentRes] = await pool.query(`
                INSERT INTO orders (order_id, waiter_id, user_id, table_id, subtotal, tax, total, created_at, payment_method)
                VALUES (710001, ?, ?, ?, 10.00, 0.00, 10.00, ?, 'voided')
            `, [SEED.waiterUser.id, SEED.waiterUser.id, SEED.table.id, today + ' 13:00:00']);
            const parentInvoiceId = parentRes.insertId;

            const res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', waiterCashierCookie)
                .send({
                    cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                    shift_id: cashierShiftId,
                    parent_invoice_id: parentInvoiceId,
                    subtotal: 2.00, tax: 0.00, total: 2.00,
                    payment_method: 'cash', amount_tendered: 2.00, change_due: 0.00,
                    idempotency_key: 'split_child_waiter_attr_1'
                });
            expect(res.statusCode).toBe(200);

            const [[child]] = await pool.query(
                "SELECT waiter_id, user_id FROM orders WHERE invoice_id = ?",
                [res.body.invoice_id]
            );
            expect(child.waiter_id).toBe(SEED.waiterUser.id);
            expect(child.user_id).toBe(SEED.cashierUser.id);
        });

        it('excludes unpaid_table and voided orders from the waiter report', async () => {
            await pool.query(`
                INSERT INTO orders (order_id, waiter_id, user_id, table_id, subtotal, tax, total, created_at, payment_method)
                VALUES (710002, ?, ?, ?, 7.50, 0.00, 7.50, ?, 'cash')
            `, [SEED.waiterUser.id, SEED.cashierUser.id, SEED.table.id, today + ' 13:05:00']);
            await pool.query(`
                INSERT INTO orders (order_id, waiter_id, user_id, table_id, subtotal, tax, total, created_at, payment_method)
                VALUES (710003, ?, ?, ?, 10.00, 0.00, 10.00, ?, 'voided')
            `, [SEED.waiterUser.id, SEED.cashierUser.id, SEED.table.id, today + ' 13:06:00']);
            await pool.query(`
                INSERT INTO orders (order_id, waiter_id, user_id, table_id, subtotal, tax, total, created_at, payment_method)
                VALUES (710004, ?, ?, ?, 99.00, 0.00, 99.00, ?, 'unpaid_table')
            `, [SEED.waiterUser.id, SEED.waiterUser.id, SEED.table2.id, today + ' 13:07:00']);

            const res = await request(app)
                .get(`/api/admin/reports/waiters?date=${today}`)
                .set('Cookie', waiterAdminCookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            const waiterRow = res.body.summary.find(s => Number(s.waiter_id) === SEED.waiterUser.id);
            expect(waiterRow).toBeDefined();
            expect(Number(waiterRow.total_sales)).toBe(7.50);
            expect(Number(waiterRow.total_tables)).toBe(1);
        });
    });
});
