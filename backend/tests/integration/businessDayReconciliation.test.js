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
} = require('../helpers/fixtures');
const { expectMoney } = require('../helpers/assertions');

describe('business-day reconciliation', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        adminCookie = await loginSeedUser(request, app, 'adminUser');
        await seedReceiptPrinter(pool);
    });

    afterAll(async () => {
        await pool.end();
    });

    // Boundary is 06:00 local (+03:00) === 03:00 UTC. Orders are stored naive
    // and treated as UTC, so anything before 03:00 UTC lands on the prior
    // business date, and 03:00 UTC or later lands on the next one.
    async function seedBusinessDateScenario() {
        const shiftId = await insertShift(pool, {
            starting_cash: 50.00,
            expected_cash: 81.60,
            actual_cash: 81.60,
            status: 'closed',
            opened_at: '2026-07-01 07:00:00',
            closed_at: '2026-07-02 04:00:00',
        });

        // 02:30 UTC on 07-02 -> business date 2026-07-01 (before the 03:00 UTC boundary)
        const includedInvoiceId = await insertPaidOrder(pool, {
            order_id: 1,
            shift_id: shiftId,
            subtotal: 30.00,
            tax: 4.80,
            total: 34.80,
            payment_method: 'split',
            cash_amount: 20.00,
            card_amount: 14.80,
            created_at: '2026-07-02 02:30:00',
            invoice_issued_at: '2026-07-02 02:30:00',
        });
        await insertOrderItem(pool, {
            invoice_id: includedInvoiceId,
            product_id: SEED.product1.id,
            quantity: 6.000,
            price_at_sale: 5.000000,
            tax_rate: 16.00,
            tax_amount: 4.800000,
        });

        await insertOrderRefund(pool, {
            invoice_id: includedInvoiceId,
            shift_id: shiftId,
            subtotal_refunded: 3.00,
            tax_refunded: 0.48,
            amount_refunded: 3.48,
            refund_method: 'cash',
            created_at: '2026-07-02 02:59:59',
        });

        // 03:30 UTC on 07-02 -> business date 2026-07-02 (at/after the 03:00 UTC boundary)
        const excludedInvoiceId = await insertPaidOrder(pool, {
            order_id: 2,
            shift_id: shiftId,
            subtotal: 100.00,
            tax: 0.00,
            total: 100.00,
            payment_method: 'cash',
            cash_amount: 100.00,
            card_amount: 0.00,
            created_at: '2026-07-02 03:30:00',
            invoice_issued_at: '2026-07-02 03:30:00',
        });
        await insertOrderItem(pool, {
            invoice_id: excludedInvoiceId,
            product_id: SEED.product2.id,
            quantity: 50.000,
            price_at_sale: 2.000000,
            tax_rate: 0.00,
            tax_amount: 0.000000,
        });

        return { shiftId, includedInvoiceId, excludedInvoiceId };
    }

    it('reports and X audit totals match for the same 06:00 business date', async () => {
        await seedBusinessDateScenario();

        const reportsRes = await request(app)
            .get('/api/admin/reports?mode=business_day&date=2026-07-01')
            .set('Cookie', adminCookie);
        expect(reportsRes.statusCode).toBe(200);

        const auditRes = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'x_audit', business_date: '2026-07-01' });
        expect(auditRes.statusCode).toBe(200);
        expect(auditRes.body.document.serial_label).toBe('X-1');

        const [[doc]] = await pool.query(`
            SELECT payload_json FROM audit_report_documents
            WHERE report_type = 'x_audit'
            ORDER BY id DESC LIMIT 1
        `);
        const payload = typeof doc.payload_json === 'string' ? JSON.parse(doc.payload_json) : doc.payload_json;

        // Both routes call the same getFinancialMetricsForRange() over the same
        // 06:00-anchored business-day range, so these must agree exactly —
        // any drift here means one of the two call sites diverged.
        expectMoney(payload.summary.sales_incl_tax, reportsRes.body.sales_summary.sales_collected);
        expectMoney(payload.summary.tax_collected, reportsRes.body.sales_summary.tax_collected);
        expectMoney(payload.payments.cash_sales, reportsRes.body.sales_summary.cash_collected);
        expectMoney(payload.payments.card_sales, reportsRes.body.sales_summary.card_collected);

        // Sanity-check the numbers aren't just both-zero: refund-netted total
        // for the included invoice is 34.80 - 3.48 = 31.32. The refund_method
        // is 'cash', so the full 3.48 comes off cash_sales (20.00 -> 16.52),
        // card_sales is untouched (14.80).
        expectMoney(reportsRes.body.sales_summary.sales_collected, 31.32);
        expectMoney(reportsRes.body.sales_summary.cash_collected, 16.52);
        expectMoney(reportsRes.body.sales_summary.card_collected, 14.80);
    });

    it('excludes orders settled after the 06:00 business-date boundary', async () => {
        const { includedInvoiceId, excludedInvoiceId } = await seedBusinessDateScenario();

        const previousDay = await request(app)
            .get('/api/admin/orders?start_date=2026-07-01&end_date=2026-07-01')
            .set('Cookie', adminCookie);
        expect(previousDay.statusCode).toBe(200);
        expect(previousDay.body.orders.some(order => order.invoice_id === includedInvoiceId)).toBe(true);
        expect(previousDay.body.orders.some(order => order.invoice_id === excludedInvoiceId)).toBe(false);

        const nextDay = await request(app)
            .get('/api/admin/orders?start_date=2026-07-02&end_date=2026-07-02')
            .set('Cookie', adminCookie);
        expect(nextDay.statusCode).toBe(200);
        expect(nextDay.body.orders.some(order => order.invoice_id === excludedInvoiceId)).toBe(true);
        expect(nextDay.body.orders.some(order => order.invoice_id === includedInvoiceId)).toBe(false);
    });
});
