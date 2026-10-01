const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { loginSeedUser } = require('../helpers/auth');
const {
    seedReceiptPrinter,
    insertShift,
    insertPaidOrder,
    insertOrderItem,
    insertOrderRefund,
    latestPrintPayload,
} = require('../helpers/fixtures');
const { expectMoney } = require('../helpers/assertions');
const { getPrintStoreInfo } = require('../../services/printStoreInfo');
const { buildShiftReportPayload } = require('../../services/shiftReportPayload');

describe('Print shift reports', () => {
    let adminCookie;

    beforeAll(async () => {
        await seedDatabase();
        adminCookie = await loginSeedUser(request, app, 'adminUser');
        await seedReceiptPrinter(pool);
    });

    it('shows platform sales separately without adding them to expected cash', async () => {
        const shiftId = await insertShift(pool, { starting_cash: 10, status: 'open' });
        const [platformType] = await pool.query(`
            INSERT INTO order_types (name, is_active, is_deferred_settlement)
            VALUES ('Talabat', 1, 1)
        `);
        await insertPaidOrder(pool, {
            shift_id: shiftId,
            order_type_id: platformType.insertId,
            subtotal: 20,
            tax: 0,
            total: 20,
            payment_method: 'platform',
            cash_amount: 0,
            card_amount: 0,
        });

        const res = await request(app)
            .post('/api/print/print')
            .set('Cookie', adminCookie)
            .send({ print_type: 'x_report', shift_id: shiftId });

        expect(res.statusCode).toBe(200);
        const payload = await latestPrintPayload(pool);
        expectMoney(payload.data.gross_sales, 20);
        expectMoney(payload.data.platform_sales, 20);
        expectMoney(payload.data.cash_sales, 0);
        expectMoney(payload.data.card_sales, 0);
        expectMoney(payload.data.expected_cash, 10);
        expect(payload.data.platform_order_type_breakdown).toEqual([
            { order_type_name: 'Talabat', total_sales: 20 }
        ]);
    });

    afterAll(async () => {
        await pool.end();
    });

    it('queues X/Z payloads net of shift refunds', async () => {
        const shiftId = await insertShift(pool, {
            starting_cash: 50.00,
            status: 'open',
            opened_at: '2025-07-01 09:00:00',
        });

        const invoiceId = await insertPaidOrder(pool, {
            shift_id: shiftId,
            subtotal: 100.00,
            tax: 0.00,
            total: 100.00,
            payment_method: 'cash',
            cash_amount: 100.00,
            card_amount: 0.00,
            created_at: '2025-07-01 10:00:00',
            invoice_issued_at: '2025-07-01 10:00:00',
        });

        await insertOrderRefund(pool, {
            invoice_id: invoiceId,
            shift_id: shiftId,
            subtotal_refunded: 40.00,
            amount_refunded: 40.00,
            user_id: SEED.adminUser.id,
        });
        await pool.query("INSERT INTO expense_categories (id, name, sort_order) VALUES (1, 'Supplies', 10)");
        await pool.query(`
            INSERT INTO expenses (category_id, amount, source, shift_id, status, created_by, created_at)
            VALUES (1, 10, 'drawer', ?, 'active', ?, '2025-07-01 10:30:00')
        `, [shiftId, SEED.adminUser.id]);

        const res = await request(app)
            .post('/api/print/print')
            .set('Cookie', adminCookie)
            .send({ print_type: 'x_report', shift_id: shiftId });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const payload = await latestPrintPayload(pool);
        const data = payload.data;

        expectMoney(data.gross_sales, 60.00);
        expectMoney(data.cash_sales, 60.00);
        expectMoney(data.card_sales, 0.00);
        expectMoney(data.cash_expenses, 10.00);
        expectMoney(data.expected_cash, 100.00);
        expect(data.expense_categories).toEqual([{
            category_id: 1,
            category_name: 'Supplies',
            count: 1,
            total: 10,
        }]);
        expect(data.order_type_breakdown).toEqual([
            { order_type_name: 'Dine In', total_sales: 60 }
        ]);
    });

    it('includes line and order discounts in shift report totals', async () => {
        const shiftId = await insertShift(pool, {
            starting_cash: 25.00,
            status: 'open',
            opened_at: '2025-07-01 11:00:00',
        });

        const invoiceId = await insertPaidOrder(pool, {
            shift_id: shiftId,
            subtotal: 8.00,
            tax: 0.00,
            total: 7.00,
            discount_type: 'fixed',
            discount_value: 1.00,
            payment_method: 'cash',
            cash_amount: 7.00,
            card_amount: 0.00,
            created_at: '2025-07-01 11:30:00',
            invoice_issued_at: '2025-07-01 11:30:00',
        });

        await insertOrderItem(pool, {
            invoice_id: invoiceId,
            quantity: 1.000,
            price_at_sale: 10.000000,
            tax_rate: 0.00,
            tax_amount: 0.000000,
            discount_type: 'fixed',
            discount_value: 2.00,
        });

        const res = await request(app)
            .post('/api/print/print')
            .set('Cookie', adminCookie)
            .send({ print_type: 'x_report', shift_id: shiftId });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const payload = await latestPrintPayload(pool);
        expectMoney(payload.data.total_discounts, 3.00);
    });

    it('uses one canonical payload for spooler dispatch and read-only browser preview', async () => {
        const shiftId = await insertShift(pool, {
            starting_cash: 15.00,
            status: 'open',
            opened_at: '2025-07-01 12:00:00',
        });
        await insertPaidOrder(pool, {
            shift_id: shiftId,
            subtotal: 12.00,
            tax: 0.00,
            total: 12.00,
            payment_method: 'cash',
            cash_amount: 12.00,
            card_amount: 0.00,
            created_at: '2025-07-01 12:30:00',
            invoice_issued_at: '2025-07-01 12:30:00',
        });

        const expected = await buildShiftReportPayload(pool, {
            shiftId,
            printType: 'x_report',
            user: SEED.adminUser,
            storeInfo: await getPrintStoreInfo(pool),
            receiptPrinterId: null,
        });

        const dispatch = await request(app)
            .post('/api/print/print')
            .set('Cookie', adminCookie)
            .send({ print_type: 'x_report', shift_id: shiftId });
        expect(dispatch.statusCode).toBe(200);
        expect((await latestPrintPayload(pool)).data).toEqual(JSON.parse(JSON.stringify(expected)));

        const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        const preview = await request(app)
            .get(`/api/admin/shift-reports/${shiftId}/print-payload?type=x_report`)
            .set('Cookie', adminCookie);
        const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');

        expect(preview.statusCode).toBe(200);
        const browserExpected = { ...expected };
        delete browserExpected.receipt_printer_id;
        expect(preview.body).toEqual({ success: true, print_payload: JSON.parse(JSON.stringify(browserExpected)) });
        expect(Number(after.count)).toBe(Number(before.count));
    });

    it('keeps browser preview validation and authorization failures explicit', async () => {
        const shiftId = await insertShift(pool, { status: 'open' });

        const badType = await request(app)
            .get(`/api/admin/shift-reports/${shiftId}/print-payload?type=receipt`)
            .set('Cookie', adminCookie);
        const missing = await request(app)
            .get('/api/admin/shift-reports/99999999/print-payload?type=x_report')
            .set('Cookie', adminCookie);

        expect(badType.statusCode).toBe(400);
        expect(missing.statusCode).toBe(404);
        await expect(buildShiftReportPayload(pool, {
            shiftId,
            printType: 'x_report',
            user: { id: 999999, role: 'cashier' },
            storeInfo: {},
        })).rejects.toMatchObject({ statusCode: 403 });
    });
});
