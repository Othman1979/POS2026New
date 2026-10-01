const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { invalidateUserSessions } = require('../../middleware/auth');
const { getBusinessDate } = require('../../utils/businessDate');

describe('Tax-exempt cross-module workflow', () => {
    let cashierCookie;
    let adminCookie;
    let cashierShiftId;

    beforeEach(async () => {
        await seedDatabase();

        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'tax_inclusive_pricing' THEN '1'
            WHEN 'service_charge_enabled' THEN '1'
            WHEN 'service_charge_percentage' THEN '10'
            WHEN 'service_charge_tax_rate' THEN '16'
            WHEN 'tax_registration_type' THEN 'sales_tax'
            ELSE setting_value END
            WHERE setting_key IN ('tax_inclusive_pricing', 'service_charge_enabled',
                                  'service_charge_percentage', 'service_charge_tax_rate',
                                  'tax_registration_type')`);
        await pool.query(
            'UPDATE products SET price=20.000000, tax_rate=16, modifiers=? WHERE id=?',
            [JSON.stringify([{ name: 'Extra', options: [{ name: 'Cheese', price: 0.15 }] }]), SEED.product1.id]
        );
        await pool.query(
            "INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.tax_exempt'), (?, 'pos.service_charge')",
            [SEED.cashierUser.id, SEED.cashierUser.id]
        );
        invalidateUserSessions(SEED.cashierUser.id);

        const cashierLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = cashierLogin.headers['set-cookie'][0];
        const adminLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminLogin.headers['set-cookie'][0];

        const shift = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 50 });
        expect(shift.statusCode).toBe(200);
        const [[openShift]] = await pool.query(
            "SELECT id FROM shifts WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1",
            [SEED.cashierUser.id]
        );
        cashierShiftId = openShift.id;

        await pool.query(
            `INSERT INTO printers (name, role, type, windows_name, is_active)
             VALUES ('Workflow Receipt', 'receipt', 'windows', 'Workflow-Receipt', 1)
             ON DUPLICATE KEY UPDATE is_active=1`
        );
    });

    afterAll(async () => { await pool.end(); });

    it('keeps exempt money identical through checkout, report, reprint, refund, and JoFotara', async () => {
        const draft = await request(app)
            .post('/api/pos/service_charge_snapshots')
            .set('Cookie', cashierCookie)
            .send({});
        expect(draft.statusCode).toBe(200);
        const snapshot = draft.body.snapshot;

        const checkout = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [
                    {
                        id: SEED.product1.id,
                        qty: 1,
                        price: 20.15,
                        tax_rate: 16,
                        selectedModifiers: [{ group: 'Extra', option: 'Cheese', price: 0.15 }]
                    },
                    { id: 'FEE_1', qty: 1, price: 2.02, tax_rate: 16, note: 'Auto-Gratuity' }
                ],
                service_charge_snapshot: { id: snapshot.id, version: snapshot.version },
                shift_id: cashierShiftId,
                subtotal: 22.17,
                tax: 0,
                total: 22.17,
                tax_exempt: true,
                payment_method: 'cash',
                amount_tendered: 22.17,
                change_due: 0,
                idempotency_key: 'tax-exempt-cross-module-sale'
            });
        expect(checkout.statusCode).toBe(200);
        expect(checkout.body).toMatchObject({ tax_exempt: true, tax: 0, total: 22.17 });

        const invoiceId = checkout.body.invoice_id;
        const [[order]] = await pool.query(
            'SELECT tax_exempt_at_sale, subtotal, tax, total, created_at FROM orders WHERE invoice_id=?',
            [invoiceId]
        );
        expect(order).toMatchObject({ tax_exempt_at_sale: 1, subtotal: '22.17', tax: '0.00', total: '22.17' });
        const [lines] = await pool.query(
            `SELECT price_at_sale, price_before_tax_exemption, tax_rate, tax_amount, note
               FROM order_items WHERE invoice_id=? ORDER BY id`,
            [invoiceId]
        );
        expect(lines).toHaveLength(2);
        expect(Number(lines[0].price_at_sale)).toBeCloseTo(20.15, 6);
        expect(Number(lines[0].price_before_tax_exemption)).toBeCloseTo(20.15, 6);
        expect(Number(lines[0].tax_amount)).toBe(0);
        expect(Number(lines[1].price_at_sale)).toBe(2.02);
        expect(lines[1].price_before_tax_exemption).toBeNull();
        expect(Number(lines[1].tax_amount)).toBe(0);

        const [[audit]] = await pool.query(
            "SELECT event_type, new_value FROM audit_events WHERE event_type='tax_exempt_checkout' AND entity_id=? ORDER BY id DESC LIMIT 1",
            [invoiceId]
        );
        expect(audit.event_type).toBe('tax_exempt_checkout');
        expect(JSON.parse(audit.new_value)).toMatchObject({
            original_total: 25.68,
            exempt_total: 22.17,
            tax_removed: 3.51,
            final_tax: 0
        });

        // The summary report scopes rows by business date, not by the UTC calendar
        // date. Between local midnight and the 06:00 business-day boundary the two
        // differ, so deriving this window from toISOString() made the report return
        // no rows and this test fail for six hours out of every day.
        const orderDate = getBusinessDate(new Date(order.created_at));
        const report = await request(app)
            .get(`/api/admin/reports/summary?start_date=${orderDate}&end_date=${orderDate}`)
            .set('Cookie', adminCookie);
        expect(report.statusCode).toBe(200);
        expect(Number(report.body.summary.sales_processed)).toBeCloseTo(22.17, 2);

        // Historical consumers must use the persisted sale facts even after the
        // restaurant changes its global pricing mode and current product price.
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='tax_inclusive_pricing'");
        await pool.query('UPDATE products SET price=5.000000, tax_rate=16, modifiers=NULL WHERE id=?', [SEED.product1.id]);

        const print = await request(app)
            .post('/api/print/print')
            .set('Cookie', cashierCookie)
            .send({ print_type: 'receipt', invoice_id: invoiceId, print_request_id: `checkout-receipt:${invoiceId}:primary` });
        expect(print.statusCode).toBe(200);
        const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
        const printPayload = JSON.parse(job.payload).data;
        expect(printPayload.receipt_display_v1).toMatchObject({
            taxExempt: true,
            summary: { taxAmount: 0, taxLabel: '(معفي من الضريبة)', total: 22.17 }
        });

        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Workflow Seller'
            ELSE setting_value END
            WHERE setting_key IN ('jofotara_sales_tax_income_source_sequence',
                                  'jofotara_sales_tax_seller_tax_number',
                                  'jofotara_sales_tax_seller_registered_name')`);
        const xml = await request(app)
            .get(`/api/admin/jofotara/invoices/${invoiceId}/xml`)
            .set('Cookie', adminCookie);
        expect(xml.statusCode).toBe(200);
        expect(xml.text).toContain('<cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">Z</cbc:ID>');
        expect(xml.text).toContain('<cbc:TaxAmount currencyID="JO">0.000000</cbc:TaxAmount>');
        expect(xml.text).not.toContain('<cbc:TaxAmount currencyID="JO">-');

        const refund = await request(app)
            .post('/api/pos/refunds')
            .set('Cookie', adminCookie)
            .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
        expect(refund.statusCode).toBe(200);
        expect(Number(refund.body.amount_refunded)).toBe(22.17);
        const [[refundRow]] = await pool.query(
            'SELECT subtotal_refunded, tax_refunded, amount_refunded FROM refunds WHERE invoice_id=?',
            [invoiceId]
        );
        expect(refundRow).toMatchObject({ subtotal_refunded: '22.17', tax_refunded: '0.00', amount_refunded: '22.17' });

        const next = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                shift_id: cashierShiftId,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 5.8,
                change_due: 0,
                idempotency_key: 'tax-exempt-cross-module-next-normal'
            });
        expect(next.statusCode).toBe(200);
        expect(next.body).toMatchObject({ tax_exempt: false, subtotal: 5, tax: 0.8, total: 5.8 });

        await pool.query("DELETE FROM user_permissions WHERE user_id=? AND perm_key='pos.tax_exempt'", [SEED.cashierUser.id]);
        invalidateUserSessions(SEED.cashierUser.id);
        const relogin = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = relogin.headers['set-cookie'][0];
        const forged = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                shift_id: cashierShiftId,
                subtotal: 5,
                tax: 0,
                total: 5,
                tax_exempt: true,
                payment_method: 'cash',
                amount_tendered: 5,
                change_due: 0,
                idempotency_key: 'tax-exempt-cross-module-forged'
            });
        expect(forged.statusCode).toBe(403);
        const [forgedOrders] = await pool.query(
            "SELECT invoice_id FROM orders WHERE idempotency_key='tax-exempt-cross-module-forged'"
        );
        expect(forgedOrders).toHaveLength(0);
    });
});
