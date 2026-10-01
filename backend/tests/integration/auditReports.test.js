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
    insertVoidedOrder,
} = require('../helpers/fixtures');
const { expectMoney } = require('../helpers/assertions');
const { dispatchReceiptPrint } = require('../../services/printDispatch');
const { summarizeAuditShifts } = require('../../../pos-spooler-printer/v2/report-data');

const LEGACY_BALANCE_TOTALS = [
    'starting_cash_total',
    'expected_cash_total',
    'actual_cash_total',
    'variance_total',
];

function expectNoLegacyBalanceTotals(reconciliation) {
    for (const key of LEGACY_BALANCE_TOTALS) {
        expect(reconciliation).not.toHaveProperty(key);
    }
}

describe('audit report persistence', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        adminCookie = await loginSeedUser(request, app, 'adminUser');
    });

    it('allocates split refunds consistently across report payments and shift drawer cash', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');
        const shiftId = await insertShift(pool, {
            starting_cash: 20,
            status: 'open',
            opened_at: '2026-07-01 06:00:00',
            closed_at: null,
        });
        const invoiceId = await insertPaidOrder(pool, {
            shift_id: shiftId,
            subtotal: 100,
            tax: 16,
            total: 116,
            payment_method: 'split',
            cash_amount: 69.60,
            card_amount: 46.40,
            created_at: '2026-07-01 10:00:00',
            invoice_issued_at: '2026-07-01 10:00:00',
        });
        await insertOrderRefund(pool, {
            invoice_id: invoiceId,
            shift_id: shiftId,
            subtotal_refunded: 10.01,
            tax_refunded: 1.60,
            amount_refunded: 11.61,
            refund_method: 'split',
            created_at: '2026-07-01 11:00:00',
        });

        const payload = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-01',
            serialLabel: 'X-SPLIT',
            generatedByUser: SEED.adminUser,
        });

        expectMoney(payload.summary.sales_incl_tax, 104.39);
        expectMoney(payload.payments.cash_sales, 62.63);
        expectMoney(payload.payments.card_sales, 41.76);
        expectMoney(payload.shifts[0].cash_sales, 62.63);
        expectMoney(payload.shifts[0].expected_cash, 82.63);
    });

    afterAll(async () => {
        await pool.end();
    });

    it('has no rows yet, so the next serial for a fresh report_type starts at 1', async () => {
        const [[xRow]] = await pool.query(
            "SELECT COALESCE(MAX(serial_no), 0) + 1 AS next_serial FROM audit_report_documents WHERE report_type = 'x_audit'"
        );
        const [[zRow]] = await pool.query(
            "SELECT COALESCE(MAX(serial_no), 0) + 1 AS next_serial FROM audit_report_documents WHERE report_type = 'z_audit'"
        );

        expect(Number(xRow.next_serial)).toBe(1);
        expect(Number(zRow.next_serial)).toBe(1);
    });

    it('builds a business-date audit payload from authoritative report math', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');

        const shiftId = await insertShift(pool, {
            starting_cash: 20.00,
            expected_cash: 31.60,
            actual_cash: 31.60,
            status: 'closed',
            opened_at: '2026-07-01 07:00:00',
            closed_at: '2026-07-02 02:40:00',
        });

        const invoiceId = await insertPaidOrder(pool, {
            order_id: 1,
            shift_id: shiftId,
            subtotal: 10.00,
            tax: 1.60,
            total: 11.60,
            cash_amount: 11.60,
            card_amount: 0.00,
            created_at: '2026-07-02 02:30:00',
            invoice_issued_at: '2026-07-02 02:30:00',
        });
        await insertOrderItem(pool, { invoice_id: invoiceId });

        await insertPaidOrder(pool, {
            order_id: 2,
            shift_id: shiftId,
            subtotal: 99.00,
            tax: 0.00,
            total: 99.00,
            cash_amount: 99.00,
            card_amount: 0.00,
            created_at: '2026-07-02 03:30:00',
            invoice_issued_at: '2026-07-02 03:30:00',
        });

        const payload = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-01',
            serialLabel: 'X-1',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.report_type).toBe('x_audit');
        expect(payload.serial_label).toBe('X-1');
        expect(payload.business_date).toBe('2026-07-01');
        expectMoney(payload.summary.sales_incl_tax, 11.60);
        expect(payload.summary.total_orders).toBe(1);
        expectMoney(payload.payments.cash_sales, 11.60);
        expect(payload.shifts).toHaveLength(1);
        expect(payload.shifts[0]).toMatchObject({
            shift_id: shiftId,
            cashier_name: SEED.cashierUser.name,
        });
        expectMoney(payload.shifts[0].gross_sales, 11.60);
        expectMoney(payload.shifts[0].expected_cash, 31.60);
        expect(payload.payload_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('builds a periodical payload aggregating shifts across a multi-day range', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');

        // Shift A: business date 2026-07-01
        const shiftAId = await insertShift(pool, {
            starting_cash: 10.00,
            expected_cash: 25.00,
            actual_cash: 25.00,
            status: 'closed',
            opened_at: '2026-07-01 08:00:00',
            closed_at: '2026-07-01 20:00:00',
        });
        const invoiceAId = await insertPaidOrder(pool, {
            order_id: 1,
            shift_id: shiftAId,
            subtotal: 15.00,
            tax: 0.00,
            total: 15.00,
            cash_amount: 15.00,
            card_amount: 0.00,
            created_at: '2026-07-01 09:00:00',
            invoice_issued_at: '2026-07-01 09:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: invoiceAId,
            quantity: 3.000,
            price_at_sale: 5.000000,
            tax_rate: 0.00,
            tax_amount: 0.000000,
        });

        // Shift B: business date 2026-07-02 (next day)
        const shiftBId = await insertShift(pool, {
            starting_cash: 10.00,
            expected_cash: 32.00,
            actual_cash: 32.00,
            status: 'closed',
            opened_at: '2026-07-02 08:00:00',
            closed_at: '2026-07-02 20:00:00',
        });
        const invoiceBId = await insertPaidOrder(pool, {
            order_id: 2,
            shift_id: shiftBId,
            subtotal: 22.00,
            tax: 0.00,
            total: 22.00,
            cash_amount: 22.00,
            card_amount: 0.00,
            created_at: '2026-07-02 09:00:00',
            invoice_issued_at: '2026-07-02 09:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: invoiceBId,
            quantity: 2.000,
            price_at_sale: 11.000000,
            tax_rate: 0.00,
            tax_amount: 0.000000,
        });

        const payload = await buildAuditReportPayload(pool, {
            startDate: '2026-07-01',
            endDate: '2026-07-02',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.is_period).toBe(true);
        expect(payload.report_type).toBe('period');
        expect(payload.period_start_date).toBe('2026-07-01');
        expect(payload.period_end_date).toBe('2026-07-02');
        expect(payload.business_date).toBeNull();
        // Both shifts' sales combined: 15 + 22 = 37
        expect(payload.summary.sales_incl_tax).toBe(37);
        expect(payload.shifts).toHaveLength(2);
        expect(payload.shifts.map(s => s.shift_id).sort()).toEqual([shiftAId, shiftBId].sort());
    });

    it('single-date payloads are unaffected by the period-mode addition', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');
        await insertBusinessDateShift();

        const payload = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-01',
            serialLabel: 'X-1',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.is_period).toBe(false);
        expect(payload.report_type).toBe('x_audit');
        expect(payload.period_start_date).toBeNull();
        expect(payload.business_date).toBe('2026-07-01');
    });

    it('reports discounts and voids that happened inside each shift', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');

        const shiftId = await insertShift(pool, {
            starting_cash: 20.00,
            expected_cash: 20.00,
            actual_cash: 20.00,
            status: 'closed',
            opened_at: '2026-07-01 07:00:00',
            closed_at: '2026-07-02 02:40:00',
        });

        // Discounted order: subtotal 20.00, 25% order discount -> discount_applied = 5.00
        const discountedInvoiceId = await insertPaidOrder(pool, {
            order_id: 1,
            shift_id: shiftId,
            subtotal: 20.00,
            tax: 0.00,
            total: 15.00,
            cash_amount: 15.00,
            card_amount: 0.00,
            discount_type: 'percent',
            discount_value: 25.00,
            created_at: '2026-07-01 08:00:00',
            invoice_issued_at: '2026-07-01 08:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: discountedInvoiceId,
            quantity: 2.000,
            price_at_sale: 10.000000,
            tax_rate: 0.00,
            tax_amount: 0.000000,
        });

        // Voided order: must not appear in any sales/discount total, but must be counted as a shift void.
        await insertVoidedOrder(pool, {
            order_id: 2,
            shift_id: shiftId,
            subtotal: 30.00,
            tax: 0.00,
            total: 30.00,
            created_at: '2026-07-01 09:00:00',
            invoice_issued_at: null,
        });

        // Refunded order: paid in full, then partially refunded in cash from this shift's drawer.
        const refundedInvoiceId = await insertPaidOrder(pool, {
            order_id: 3,
            shift_id: shiftId,
            subtotal: 12.00,
            tax: 0.00,
            total: 12.00,
            cash_amount: 12.00,
            card_amount: 0.00,
            created_at: '2026-07-01 10:00:00',
            invoice_issued_at: '2026-07-01 10:00:00',
        });
        await insertOrderRefund(pool, {
            invoice_id: refundedInvoiceId,
            shift_id: shiftId,
            subtotal_refunded: 4.00,
            tax_refunded: 0.00,
            amount_refunded: 4.00,
            refund_method: 'cash',
            user_id: SEED.cashierUser.id,
            created_at: '2026-07-01 10:30:00',
        });

        const payload = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-01',
            serialLabel: 'X-1',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.shifts).toHaveLength(1);
        expect(payload.shifts[0]).toMatchObject({
            gross_sales: 23, // 15 (discounted order) + 12 (refunded order) - 4 (refund) = 23
            total_discounts: 5,
            order_discounts: 5,
            line_discounts: 0,
            refund_count: 1,
            refund_value: 4,
            void_count: 1,
            void_value: 30,
        });
        // Voided order must not leak into shift sales/cash totals; refund nets against the paid order it targets.
        expect(payload.summary.sales_incl_tax).toBe(23);
    });



    it('nets shift-level line_discounts against an item-level refund (audit finding)', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');

        const shiftId = await insertShift(pool, {
            starting_cash: 10.00,
            expected_cash: 10.00,
            actual_cash: 10.00,
            status: 'closed',
            opened_at: '2026-07-01 07:00:00',
            closed_at: '2026-07-02 02:40:00',
        });

        // Line-level discount: price 5.00 x2, fixed 1.00/unit -> line_discount = 2.00 pre-refund.
        const invoiceId = await insertPaidOrder(pool, {
            order_id: 1,
            shift_id: shiftId,
            subtotal: 8.00,
            tax: 0.00,
            total: 8.00,
            cash_amount: 8.00,
            card_amount: 0.00,
            created_at: '2026-07-01 08:00:00',
            invoice_issued_at: '2026-07-01 08:00:00',
        });
        const orderItemId = await insertOrderItem(pool, {
            invoice_id: invoiceId,
            quantity: 2,
            price_at_sale: 5.000000,
            tax_rate: 0.00,
            tax_amount: 0.000000,
            discount_type: 'fixed',
            discount_value: 1.00,
        });

        const payloadBefore = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-01',
            serialLabel: 'X-1',
            generatedByUser: SEED.adminUser,
        });
        expect(payloadBefore.shifts[0].line_discounts).toBe(2);

        const freshAdminCookie = await loginSeedUser(request, app, 'adminUser');

        const refundRes = await request(app)
            .post('/api/pos/refunds')
            .set('Cookie', freshAdminCookie)
            .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash', items: [{ order_item_id: orderItemId, qty: 1 }] });
        expect(refundRes.statusCode).toBe(200);

        const payloadAfter = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-01',
            serialLabel: 'X-2',
            generatedByUser: SEED.adminUser,
        });
        // Only 1 of the 2 discounted units remains active -> 1.00 discount left.
        expect(payloadAfter.shifts[0].line_discounts).toBe(1);
    });

    it('includes stale shifts with in-range activity in the business-date audit payload', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');

        const shiftId = await insertShift(pool, {
            starting_cash: 30.00,
            expected_cash: 90.00,
            actual_cash: null,
            status: 'open',
            opened_at: '2026-06-30 08:00:00',
            closed_at: null,
        });

        await insertPaidOrder(pool, {
            order_id: 1,
            shift_id: shiftId,
            subtotal: 60.00,
            tax: 0.00,
            total: 60.00,
            cash_amount: 60.00,
            card_amount: 0.00,
            created_at: '2026-07-01 08:00:00',
            invoice_issued_at: '2026-07-01 08:00:00',
        });

        const payload = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-01',
            serialLabel: 'X-1',
            generatedByUser: SEED.adminUser,
        });

        const shift = payload.shifts.find(row => row.shift_id === shiftId);
        expect(shift).toMatchObject({
            shift_id: shiftId,
            status: 'open',
            gross_sales: 60,
            cash_sales: 60,
            expected_cash: 90,
            actual_cash: null,
        });
        expect(payload.summary.sales_incl_tax).toBe(60);
        expect(payload.cash_reconciliation).toMatchObject({
            open_shifts: 1,
            closed_shifts: 0,
            net_variance_total: null,
            shortage_total: null,
            overage_total: null,
        });
        expectNoLegacyBalanceTotals(payload.cash_reconciliation);
    });

    async function insertBusinessDateShift({ status = 'closed' } = {}) {
        const shiftId = await insertShift(pool, {
            user_id: SEED.cashierUser.id,
            starting_cash: 20.00,
            expected_cash: 31.60,
            actual_cash: status === 'closed' ? 31.60 : null,
            status,
            opened_at: '2026-07-01 07:00:00',
            closed_at: status === 'closed' ? '2026-07-02 02:40:00' : null,
        });

        const invoiceId = await insertPaidOrder(pool, {
            order_id: 1,
            shift_id: shiftId,
            subtotal: 10.00,
            tax: 1.60,
            total: 11.60,
            cash_amount: 11.60,
            card_amount: 0.00,
            created_at: '2026-07-01 08:00:00',
            invoice_issued_at: '2026-07-01 08:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: invoiceId,
            product_id: SEED.product1.id,
            quantity: 2.000,
            price_at_sale: 5.000000,
            tax_rate: 16.00,
            tax_amount: 1.600000,
        });

        return shiftId;
    }

    it('issues X and Z audit payloads from independent serialized counters without queueing', async () => {
        await insertBusinessDateShift();

        const xRes = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'x_audit', business_date: '2026-07-01' });
        expect(xRes.statusCode).toBe(200);
        expect(xRes.body.document.serial_label).toBe('X-1');
        expect(xRes.body.print_payload.print_type).toBe('audit_report');
        expect(xRes.body.print_payload.serial_label).toBe('X-1');

        const zRes = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'z_audit', business_date: '2026-07-01' });
        expect(zRes.statusCode).toBe(200);
        expect(zRes.body.document.serial_label).toBe('Z-1');
        expect(zRes.body.print_payload.print_type).toBe('audit_report');
        expect(zRes.body.print_payload.serial_label).toBe('Z-1');

        const [[xNext]] = await pool.query(
            "SELECT COALESCE(MAX(serial_no), 0) + 1 AS next_serial FROM audit_report_documents WHERE report_type = 'x_audit'"
        );
        const [[zNext]] = await pool.query(
            "SELECT COALESCE(MAX(serial_no), 0) + 1 AS next_serial FROM audit_report_documents WHERE report_type = 'z_audit'"
        );
        expect(Number(xNext.next_serial)).toBe(2);
        expect(Number(zNext.next_serial)).toBe(2);

        const [[{ queued }]] = await pool.query('SELECT COUNT(*) AS queued FROM print_queue');
        expect(Number(queued)).toBe(0);
    });

    it('returns serialized audit payloads with immutable document metadata', async () => {
        await insertBusinessDateShift();

        const xRes = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'x_audit', business_date: '2026-07-01' });
        expect(xRes.statusCode).toBe(200);

        expect(xRes.body.print_payload.print_type).toBe('audit_report');
        expect(xRes.body.print_payload.audit_report_document_id).toBe(xRes.body.document.id);
        expect(xRes.body.print_payload.serial_label).toBe('X-1');
        expect(xRes.body.print_payload.copy_label).toBe('ORIGINAL');
        expect(xRes.body.print_payload.payload_hash).toBe(xRes.body.document.payload_hash);
        const [[{ queued }]] = await pool.query('SELECT COUNT(*) AS queued FROM print_queue');
        expect(Number(queued)).toBe(0);
    });

    it('keeps a forged compiled artifact out of a real report dispatch and on the report renderer path', async () => {
        const printerId = await seedReceiptPrinter(pool);

        await dispatchReceiptPrint({
            io: null,
            printerId,
            printType: 'audit_report',
            data: {
                report_type: 'x_audit',
                serial_label: 'X-forged-artifact',
                compiled_document_v1: { html: '<main>forged</main>' },
                jofotara: { status: 'accepted', qrText: 'forged' }
            }
        });

        const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
        const payload = JSON.parse(job.payload);
        expect(payload.print_type).toBe('audit_report');
        expect(payload.data.serial_label).toBe('X-forged-artifact');
        expect(payload.compiled_document_v1).toBeUndefined();
        expect(payload.data.compiled_document_v1).toBeUndefined();
        expect(payload.data.jofotara).toBeUndefined();
    });

    it('reprints the existing Z report instead of issuing a duplicate for the same business date', async () => {
        await insertBusinessDateShift();

        const first = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'z_audit', business_date: '2026-07-01' });
        expect(first.statusCode).toBe(200);
        expect(first.body.document.serial_label).toBe('Z-1');
        expect(first.body.document.reprint).toBe(false);

        const second = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'z_audit', business_date: '2026-07-01' });
        expect(second.statusCode).toBe(200);
        expect(second.body.document.serial_label).toBe('Z-1');
        expect(second.body.document.reprint).toBe(true);
        expect(second.body.print_payload.copy_label).toBe('REPRINT');
        expect(second.body.print_payload.payload_hash).toBe(first.body.print_payload.payload_hash);

        const [[{ docs }]] = await pool.query("SELECT COUNT(*) AS docs FROM audit_report_documents WHERE report_type = 'z_audit'");
        expect(Number(docs)).toBe(1);

        const [[zDoc]] = await pool.query(
            "SELECT reprint_count, last_print_status FROM audit_report_documents WHERE report_type = 'z_audit' LIMIT 1"
        );
        expect(Number(zDoc.reprint_count)).toBe(1);
        expect(zDoc.last_print_status).toBe('browser_ready');
        const [[{ queued }]] = await pool.query('SELECT COUNT(*) AS queued FROM print_queue');
        expect(Number(queued)).toBe(0);
    });

    it('reprints an old-shape Z document without rewriting stored JSON or hash', async () => {
        const knownHash = 'ab'.repeat(32);
        const legacyPayload = {
            print_type: 'audit_report',
            report_type: 'z_audit',
            serial_label: 'Z-99',
            business_date: '2026-07-01',
            storeInfo: { store_name: 'Legacy Store' },
            summary: { sales_incl_tax: 600, total_orders: 2 },
            payments: { cash_sales: 600, total_collected: 600 },
            cash_reconciliation: {
                starting_cash_total: 1100,
                expected_cash_total: 1100,
                actual_cash_total: 1100,
                variance_total: 0,
                cash_expenses_total: 50,
            },
            shifts: [
                { shift_id: 1, cashier_name: 'Ali', status: 'closed', starting_cash: 100, expected_cash: 400, actual_cash: 400, variance: 0 },
                { shift_id: 2, cashier_name: 'Sara', status: 'closed', starting_cash: 400, expected_cash: 700, actual_cash: 700, variance: 0 },
            ],
        };
        await pool.query(
            `INSERT INTO audit_report_documents
                (report_type, serial_no, serial_label, business_date, business_start_at,
                 business_end_at, z_business_date_lock, payload_json, payload_hash, issued_by_user_id)
             VALUES ('z_audit', 99, 'Z-99', '2026-07-01', '2026-07-01 06:00:00',
                     '2026-07-02 06:00:00', '2026-07-01', ?, ?, ?)`,
            [JSON.stringify(legacyPayload), knownHash, SEED.adminUser.id]
        );

        const [[before]] = await pool.query(
            "SELECT payload_json, payload_hash FROM audit_report_documents WHERE serial_label = 'Z-99'"
        );
        expect(before.payload_hash).toBe(knownHash);
        const storedPayload = typeof before.payload_json === 'string'
            ? JSON.parse(before.payload_json)
            : before.payload_json;
        expect(storedPayload).toMatchObject({
            cash_reconciliation: {
                starting_cash_total: 1100,
                expected_cash_total: 1100,
                actual_cash_total: 1100,
                variance_total: 0,
            },
        });
        expect(storedPayload.cash_reconciliation).not.toHaveProperty('net_variance_total');

        const reprint = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'z_audit', business_date: '2026-07-01' });

        expect(reprint.statusCode).toBe(200);
        expect(reprint.body.print_payload.copy_label).toBe('REPRINT');
        expect(reprint.body.print_payload.payload_hash).toBe(before.payload_hash);
        expect(reprint.body.document.payload_hash).toBe(before.payload_hash);

        const [[after]] = await pool.query(
            "SELECT payload_json, payload_hash FROM audit_report_documents WHERE serial_label = 'Z-99'"
        );
        expect(after.payload_hash).toBe(before.payload_hash);
        expect(after.payload_json).toEqual(before.payload_json);
    });

    it('keeps durable issuance and reprint metadata valid before the browser-ready enum migration lands', async () => {
        await pool.query(`
            ALTER TABLE audit_report_documents
            MODIFY COLUMN last_print_status ENUM('queued','printed','failed') NOT NULL DEFAULT 'queued'
        `);
        await insertBusinessDateShift();

        const first = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'z_audit', business_date: '2026-07-01' });
        const second = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'z_audit', business_date: '2026-07-01' });

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        const [[document]] = await pool.query(
            "SELECT last_print_status, reprint_count FROM audit_report_documents WHERE report_type = 'z_audit'"
        );
        expect(document.last_print_status).toBe('queued');
        expect(Number(document.reprint_count)).toBe(1);
    });

    it('excludes open shifts from cash drawer totals instead of counting null actual_cash as zero', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');
        await insertBusinessDateShift({ status: 'open' });

        const payload = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-01',
            serialLabel: 'X-1',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.shifts[0].actual_cash).toBeNull();
        expect(payload.shifts[0].variance).toBeNull();
        expect(payload.cash_reconciliation).toEqual({
            cash_expenses_total: 0,
            open_shifts: 1,
            closed_shifts: 0,
            closed_outside_window: 0,
            uncounted_shifts: 0,
            shifts_needing_review: 0,
            net_variance_total: null,
            shortage_total: null,
            overage_total: null,
        });
        expectNoLegacyBalanceTotals(payload.cash_reconciliation);
    });

    async function insertDrawerExpense(shiftId, amount, createdAt) {
        await pool.query(
            "INSERT INTO expense_categories (name, is_active, sort_order) VALUES ('Audit Supplies', 1, 10)"
        );
        const [[category]] = await pool.query(
            "SELECT id FROM expense_categories WHERE name = 'Audit Supplies'"
        );
        await pool.query(`
            INSERT INTO expenses (category_id, amount, source, shift_id, note, status, created_by, created_at)
            VALUES (?, ?, 'drawer', ?, 'Drawer', 'active', ?, ?)
        `, [category.id, amount, shiftId, SEED.cashierUser.id, createdAt]);
    }

    it('does not sum sequential drawer snapshots and keeps a 50 JD expense as a movement', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');
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
        await insertDrawerExpense(secondShiftId, 50, '2026-07-14 14:00:00');

        const payload = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-14',
            serialLabel: 'X-SEQ',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.cash_reconciliation).toEqual({
            cash_expenses_total: 50,
            open_shifts: 0,
            closed_shifts: 2,
            closed_outside_window: 0,
            uncounted_shifts: 0,
            shifts_needing_review: 0,
            net_variance_total: 0,
            shortage_total: 0,
            overage_total: 0,
        });
        expectNoLegacyBalanceTotals(payload.cash_reconciliation);
        expect(payload.shifts).toHaveLength(2);
        expect(payload.shifts.every(shift => shift.closed_in_window === true)).toBe(true);
        expect(payload.shifts.every(shift => shift.within_window === true)).toBe(true);

        const rendered = summarizeAuditShifts(payload.shifts);
        const { cash_expenses_total: _cashExpensesTotal, ...reconciliation } = payload.cash_reconciliation;
        expect({
            open_shifts: rendered.open,
            closed_shifts: rendered.closed,
            closed_outside_window: rendered.closedOutsideWindow,
            uncounted_shifts: rendered.uncounted,
            shifts_needing_review: rendered.needsReview,
            net_variance_total: rendered.netVariance,
            shortage_total: rendered.shortage,
            overage_total: rendered.overage,
        }).toEqual(reconciliation);
    });

    it('attributes a cross-day shift with activity on both dates to the closing window', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');
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

        const day1 = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-01',
            serialLabel: 'X-D1',
            generatedByUser: SEED.adminUser,
        });
        const day2 = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-02',
            serialLabel: 'X-D2',
            generatedByUser: SEED.adminUser,
        });

        expect(day1.shifts).toHaveLength(1);
        expect(day1.shifts[0]).toMatchObject({
            shift_id: shiftId,
            closed_in_window: false,
            within_window: false,
        });
        expect(day1.cash_reconciliation).toMatchObject({
            closed_shifts: 0,
            closed_outside_window: 1,
            net_variance_total: null,
            shortage_total: null,
            overage_total: null,
        });
        expectNoLegacyBalanceTotals(day1.cash_reconciliation);

        expect(day2.shifts[0]).toMatchObject({
            shift_id: shiftId,
            closed_in_window: true,
            within_window: false,
            actual_cash: 77,
            variance: -3,
        });
        expect(day2.cash_reconciliation).toMatchObject({
            closed_shifts: 1,
            closed_outside_window: 0,
            shifts_needing_review: 1,
            net_variance_total: -3,
            shortage_total: 3,
            overage_total: 0,
        });
    });

    it('includes a close-only cross-day shift on the closing business day', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');
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
            subtotal: 30,
            tax: 0,
            total: 30,
            payment_method: 'cash',
            cash_amount: 30,
            created_at: '2026-07-01 23:00:00',
            invoice_issued_at: '2026-07-01 23:00:00',
        });

        const day2 = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-02',
            serialLabel: 'X-CLOSE',
            generatedByUser: SEED.adminUser,
        });

        expect(day2.shifts).toEqual([
            expect.objectContaining({
                shift_id: shiftId,
                closed_in_window: true,
                within_window: false,
                variance: -3,
            }),
        ]);
        expect(day2.cash_reconciliation.net_variance_total).toBe(-3);
    });

    it('preserves null actual_cash on a closed uncounted row and blanks aggregate money', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');
        const shiftId = await insertShift(pool, {
            status: 'closed',
            opened_at: '2026-07-14 06:00:00',
            closed_at: '2026-07-14 14:00:00',
            starting_cash: 50,
            expected_cash: 90,
            actual_cash: 90,
        });
        await pool.query('UPDATE shifts SET actual_cash = NULL WHERE id = ?', [shiftId]);

        const payload = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-14',
            serialLabel: 'X-NULL',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.shifts[0]).toMatchObject({
            shift_id: shiftId,
            status: 'closed',
            closed_in_window: true,
            actual_cash: null,
            variance: null,
        });
        expect(payload.cash_reconciliation).toMatchObject({
            closed_shifts: 1,
            uncounted_shifts: 1,
            net_variance_total: null,
            shortage_total: null,
            overage_total: null,
        });
        expectNoLegacyBalanceTotals(payload.cash_reconciliation);
    });

    it('preserves null expected_cash on a closed uncounted row and blanks aggregate money', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');
        const shiftId = await insertShift(pool, {
            status: 'closed',
            opened_at: '2026-07-14 06:00:00',
            closed_at: '2026-07-14 14:00:00',
            starting_cash: 50,
            expected_cash: 90,
            actual_cash: 90,
        });
        await pool.query('UPDATE shifts SET expected_cash = NULL WHERE id = ?', [shiftId]);

        const payload = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-14',
            serialLabel: 'X-NULL-EXPECTED',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.shifts[0]).toMatchObject({
            shift_id: shiftId,
            status: 'closed',
            closed_in_window: true,
            expected_cash: null,
            actual_cash: 90,
            variance: null,
        });
        expect(payload.cash_reconciliation).toMatchObject({
            closed_shifts: 1,
            uncounted_shifts: 1,
            net_variance_total: null,
            shortage_total: null,
            overage_total: null,
        });
        expectNoLegacyBalanceTotals(payload.cash_reconciliation);
    });

    it('keeps independently built audit hashes stable when generated_at is frozen', async () => {
        const { buildAuditReportPayload } = require('../../services/auditReportBuilder');
        await insertShift(pool, {
            status: 'closed',
            opened_at: '2026-07-14 06:00:00',
            closed_at: '2026-07-14 14:00:00',
            starting_cash: 20,
            expected_cash: 20,
            actual_cash: 20,
        });
        const options = {
            reportType: 'x_audit',
            businessDate: '2026-07-14',
            serialLabel: 'X-HASH',
            generatedByUser: SEED.adminUser,
        };

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-03T12:00:00.000Z'));
        try {
            const first = await buildAuditReportPayload(pool, options);
            const second = await buildAuditReportPayload(pool, options);
            expect(second.payload_hash).toBe(first.payload_hash);
        } finally {
            vi.useRealTimers();
        }
    });

    it('blocks official Z issuance while a business-date shift is still open', async () => {
        await seedReceiptPrinter(pool);
        const shiftId = await insertBusinessDateShift({ status: 'open' });

        const res = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'z_audit', business_date: '2026-07-01' });

        expect(res.statusCode).toBe(409);
        expect(res.body.open_shifts).toEqual([
            expect.objectContaining({ shift_id: shiftId, cashier_name: SEED.cashierUser.name })
        ]);
    });

    it('blocks official Z issuance when an earlier stale shift is still open', async () => {
        await seedReceiptPrinter(pool);
        const shiftId = await insertShift(pool, {
            starting_cash: 20.00,
            expected_cash: 20.00,
            status: 'open',
            opened_at: '2026-06-30 08:00:00',
        });

        await insertPaidOrder(pool, {
            order_id: 1,
            shift_id: shiftId,
            subtotal: 10.00,
            tax: 0.00,
            total: 10.00,
            cash_amount: 10.00,
            card_amount: 0.00,
            created_at: '2026-07-01 08:00:00',
            invoice_issued_at: '2026-07-01 08:00:00',
        });

        const res = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'z_audit', business_date: '2026-07-01' });

        expect(res.statusCode).toBe(409);
        expect(res.body.open_shifts).toEqual([
            expect.objectContaining({ shift_id: shiftId, cashier_name: SEED.cashierUser.name })
        ]);
    });

    describe('Periodical Audit Report (Task 3)', () => {
        it('returns a periodical payload without creating a document, serial, or queue row', async () => {
            await insertBusinessDateShift();

            const res = await request(app)
                .post('/api/admin/audit-reports/print-period')
                .set('Cookie', adminCookie)
                .send({ start_date: '2026-06-25', end_date: '2026-07-01' });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.print_payload.print_type).toBe('audit_report');
            expect(res.body.print_payload.report_type).toBe('period');

            const [[{ docs }]] = await pool.query('SELECT COUNT(*) AS docs FROM audit_report_documents');
            const [[{ queued }]] = await pool.query('SELECT COUNT(*) AS queued FROM print_queue');
            expect(Number(docs)).toBe(0);
            expect(Number(queued)).toBe(0);
        });

        it('rejects end_date before start_date', async () => {
            await seedReceiptPrinter(pool);

            const res = await request(app)
                .post('/api/admin/audit-reports/print-period')
                .set('Cookie', adminCookie)
                .send({ start_date: '2026-07-01', end_date: '2026-06-25' });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('rejects a range spanning more than 366 days', async () => {
            await seedReceiptPrinter(pool);

            const res = await request(app)
                .post('/api/admin/audit-reports/print-period')
                .set('Cookie', adminCookie)
                .send({ start_date: '2020-01-01', end_date: '2026-07-01' });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('rejects a malformed date', async () => {
            await seedReceiptPrinter(pool);

            const res = await request(app)
                .post('/api/admin/audit-reports/print-period')
                .set('Cookie', adminCookie)
                .send({ start_date: 'not-a-date', end_date: '2026-07-01' });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });
    });
});
