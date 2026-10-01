const { seedDatabase, SEED } = require('../fixtures/seed');
const pool = require('../../config/db');
const {
    insertShift,
    insertPaidOrder,
    insertOrderItem,
    insertOrderRefund,
} = require('../helpers/fixtures');
const { expectMoney } = require('../helpers/assertions');
const { buildCategoryItemsReportPayload } = require('../../services/categoryItemsReportBuilder');
const request = require('supertest');
const { app } = require('../../../server');
const { loginSeedUser } = require('../helpers/auth');
const { seedReceiptPrinter } = require('../helpers/fixtures');

describe('category/subcategory/items report builder', () => {
    beforeEach(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('breaks down items by name ordered by tax-inclusive total (business date)', async () => {
        const shiftId = await insertShift(pool, {
            starting_cash: 20.00, expected_cash: 20.00, actual_cash: 20.00,
            status: 'closed', opened_at: '2026-07-01 07:00:00', closed_at: '2026-07-02 02:40:00',
        });

        // One order with two different products.
        const invoiceId = await insertPaidOrder(pool, {
            order_id: 1, shift_id: shiftId, subtotal: 16.00, tax: 1.60, total: 17.60,
            cash_amount: 17.60, card_amount: 0.00,
            created_at: '2026-07-01 08:00:00', invoice_issued_at: '2026-07-01 08:00:00',
        });
        // 2x Test Burger @ 5.00, 16% tax -> line gross = 10.00 + 1.60 = 11.60
        await insertOrderItem(pool, {
            invoice_id: invoiceId, product_id: SEED.product1.id,
            quantity: 2.000, price_at_sale: 5.000000, tax_rate: 16.00, tax_amount: 1.600000,
        });
        // 3x Test Drink @ 2.00, 0% tax -> line gross = 6.00
        await insertOrderItem(pool, {
            invoice_id: invoiceId, product_id: SEED.product2.id,
            quantity: 3.000, price_at_sale: 2.000000, tax_rate: 0.00, tax_amount: 0.000000,
        });

        const payload = await buildCategoryItemsReportPayload(pool, {
            businessDate: '2026-07-01',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.print_type).toBe('category_items_report');
        expect(payload.is_period).toBe(false);
        expect(payload.items).toHaveLength(2);
        expect(payload.items[0].item_name).toBe(SEED.product1.name); // 'Test Burger'
        expect(payload.items[0].qty_sold).toBe(2);
        expectMoney(payload.items[0].gross_revenue, 11.60);
        expect(payload.items[1].item_name).toBe(SEED.product2.name); // 'Test Drink'
        expect(payload.items[1].qty_sold).toBe(3);
        expectMoney(payload.items[1].gross_revenue, 6.00);
    });

    it('aggregates item breakdown across a multi-day period and sets is_period', async () => {
        // Day 1: 2x Test Burger (tax-free for simple arithmetic)
        const shiftAId = await insertShift(pool, {
            starting_cash: 10.00, expected_cash: 10.00, actual_cash: 10.00,
            status: 'closed', opened_at: '2026-07-01 08:00:00', closed_at: '2026-07-01 20:00:00',
        });
        const invoiceAId = await insertPaidOrder(pool, {
            order_id: 1, shift_id: shiftAId, subtotal: 10.00, tax: 0.00, total: 10.00,
            cash_amount: 10.00, card_amount: 0.00,
            created_at: '2026-07-01 09:00:00', invoice_issued_at: '2026-07-01 09:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: invoiceAId, product_id: SEED.product1.id,
            quantity: 2.000, price_at_sale: 5.000000, tax_rate: 0.00, tax_amount: 0.000000,
        });

        // Day 2: 3x Test Burger — same product, must merge with Day 1 in the period rollup.
        const shiftBId = await insertShift(pool, {
            starting_cash: 10.00, expected_cash: 10.00, actual_cash: 10.00,
            status: 'closed', opened_at: '2026-07-02 08:00:00', closed_at: '2026-07-02 20:00:00',
        });
        const invoiceBId = await insertPaidOrder(pool, {
            order_id: 2, shift_id: shiftBId, subtotal: 15.00, tax: 0.00, total: 15.00,
            cash_amount: 15.00, card_amount: 0.00,
            created_at: '2026-07-02 09:00:00', invoice_issued_at: '2026-07-02 09:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: invoiceBId, product_id: SEED.product1.id,
            quantity: 3.000, price_at_sale: 5.000000, tax_rate: 0.00, tax_amount: 0.000000,
        });

        const payload = await buildCategoryItemsReportPayload(pool, {
            startDate: '2026-07-01', endDate: '2026-07-02',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.is_period).toBe(true);
        expect(payload.business_date).toBeNull();
        expect(payload.items).toHaveLength(1);
        expect(payload.items[0].item_name).toBe(SEED.product1.name);
        expect(payload.items[0].qty_sold).toBe(5);        // 2 + 3 merged across days
        expectMoney(payload.items[0].gross_revenue, 25.00); // 10 + 15
    });

    it('rolls up subcategory sales into their top-level category total, and omits direct-to-root sales from the subcategories section', async () => {
        // SEED.category (id 1, 'Test Category') is a root category (parent_id NULL) that
        // SEED.product1 ('Test Burger') is already directly assigned to.
        // Add a real subcategory under it, and a new product assigned to that subcategory.
        await pool.query(
            "INSERT INTO categories (id, parent_id, name, is_active) VALUES (100, 1, 'Test Subcategory', 1)"
        );
        await pool.query(
            "INSERT INTO products (id, category_id, name, price, tax_rate, is_active, is_bundle) VALUES (100, 100, 'Sub Item', 3.0000, 0, 1, 0)"
        );

        const shiftId = await insertShift(pool, {
            starting_cash: 10.00, expected_cash: 10.00, actual_cash: 10.00,
            status: 'closed', opened_at: '2026-07-01 07:00:00', closed_at: '2026-07-02 02:40:00',
        });

        // Direct-to-root sale: 1x Test Burger @ 5.00, 0% tax -> gross 5.00, assigned to root category 1.
        const invoiceId = await insertPaidOrder(pool, {
            order_id: 1, shift_id: shiftId, subtotal: 5.00, tax: 0.00, total: 5.00,
            cash_amount: 5.00, card_amount: 0.00,
            created_at: '2026-07-01 08:00:00', invoice_issued_at: '2026-07-01 08:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: invoiceId, product_id: SEED.product1.id,
            quantity: 1.000, price_at_sale: 5.000000, tax_rate: 0.00, tax_amount: 0.000000,
        });

        // Subcategory sale: 2x Sub Item @ 3.00, 0% tax -> gross 6.00, assigned to subcategory 100 (root 1).
        const invoice2Id = await insertPaidOrder(pool, {
            order_id: 2, shift_id: shiftId, subtotal: 6.00, tax: 0.00, total: 6.00,
            cash_amount: 6.00, card_amount: 0.00,
            created_at: '2026-07-01 09:00:00', invoice_issued_at: '2026-07-01 09:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: invoice2Id, product_id: 100,
            quantity: 2.000, price_at_sale: 3.000000, tax_rate: 0.00, tax_amount: 0.000000,
        });

        const payload = await buildCategoryItemsReportPayload(pool, {
            businessDate: '2026-07-01',
            generatedByUser: SEED.adminUser,
        });

        // Categories: root total = 5.00 (direct) + 6.00 (subcategory) = 11.00, qty 1 + 2 = 3.
        expect(payload.categories).toHaveLength(1);
        expect(payload.categories[0].category_name).toBe(SEED.category.name);
        expect(payload.categories[0].qty_sold).toBe(3);
        expectMoney(payload.categories[0].gross_revenue, 11.00);

        // Subcategories: exactly one group (the root), containing exactly the subcategory's
        // own row — the direct-to-root Test Burger sale must NOT appear here.
        expect(payload.subcategories).toHaveLength(1);
        expect(payload.subcategories[0].category_name).toBe(SEED.category.name);
        expect(payload.subcategories[0].rows).toHaveLength(1);
        expect(payload.subcategories[0].rows[0].category_name).toBe('Test Subcategory');
        expect(payload.subcategories[0].rows[0].qty_sold).toBe(2);
        expectMoney(payload.subcategories[0].rows[0].gross_revenue, 6.00);
    });

    it('does not double-subtract a pre-checkout item void from the category breakdown (ported audit finding)', async () => {
        const shiftId = await insertShift(pool, {
            starting_cash: 5.00, expected_cash: 5.00, actual_cash: 5.00,
            status: 'closed', opened_at: '2026-07-01 07:00:00', closed_at: '2026-07-02 02:40:00',
        });

        // Order was rung up with 2 units, one got voided on the floor before checkout —
        // order_items.quantity already reflects only the 1 remaining unit (physically
        // shrunk in place), matching what POST /api/pos/refunds intent=void does.
        const invoiceId = await insertPaidOrder(pool, {
            order_id: 1, shift_id: shiftId, subtotal: 5.00, tax: 0.00, total: 5.00,
            cash_amount: 5.00, card_amount: 0.00,
            created_at: '2026-07-01 08:00:00', invoice_issued_at: '2026-07-01 08:00:00',
        });
        const orderItemId = await insertOrderItem(pool, {
            invoice_id: invoiceId, quantity: 1.000, price_at_sale: 5.000000,
            tax_rate: 0.00, tax_amount: 0.000000,
        });

        // The pre-checkout void still leaves its audit trail in refunds/refund_items —
        // a 'void' kind record for the unit that was removed before payment.
        const voidRefundId = await insertOrderRefund(pool, {
            kind: 'void', invoice_id: invoiceId, subtotal_refunded: 5.00, tax_refunded: 0.00,
            amount_refunded: 0.00, refund_method: null, user_id: SEED.cashierUser.id, shift_id: shiftId,
        });
        await pool.query(`
            INSERT INTO refund_items (refund_id, order_item_id, product_id, quantity, unit_price, line_subtotal, line_tax, line_total)
            VALUES (?, ?, ?, 1.000, 5.000000, 5.00, 0.00, 5.00)
        `, [voidRefundId, orderItemId, SEED.product1.id]);

        const payload = await buildCategoryItemsReportPayload(pool, {
            businessDate: '2026-07-01',
            generatedByUser: SEED.adminUser,
        });

        // The category breakdown must match the true remaining sale — not re-subtract the
        // void a second time via refund_items (the 'void' kind must be excluded).
        const categoryTotal = payload.categories.reduce((sum, c) => sum + c.gross_revenue, 0);
        expect(categoryTotal).toBe(5);
        expect(payload.categories[0].qty_sold).toBe(1);
    });

    describe('ad-hoc print route', () => {
        let adminCookie;

        beforeEach(async () => {
            adminCookie = await loginSeedUser(request, app, 'adminUser');
        });

        it('returns a single-date items payload without creating a document, serial, or queue row', async () => {

            const res = await request(app)
                .post('/api/admin/audit-reports/print-items')
                .set('Cookie', adminCookie)
                .send({ business_date: '2026-07-01' });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.print_payload.print_type).toBe('category_items_report');
            expect(res.body.print_payload.is_period).toBe(false);
            expect(res.body.print_payload.business_date).toBe('2026-07-01');
            expect(res.body.print_payload.summary).toEqual({
                product_count: res.body.print_payload.items.length,
                total_quantity: res.body.print_payload.items.reduce((sum, item) => sum + Number(item.qty_sold), 0),
                gross_revenue: res.body.print_payload.items.reduce((sum, item) => sum + Number(item.gross_revenue), 0),
            });

            const [[{ docs }]] = await pool.query('SELECT COUNT(*) AS docs FROM audit_report_documents');
            const [[{ queued }]] = await pool.query('SELECT COUNT(*) AS queued FROM print_queue');
            expect(Number(docs)).toBe(0);
            expect(Number(queued)).toBe(0);
        });

        it('returns a periodical items payload when start_date/end_date are given', async () => {

            const res = await request(app)
                .post('/api/admin/audit-reports/print-items')
                .set('Cookie', adminCookie)
                .send({ start_date: '2026-06-25', end_date: '2026-07-01' });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            expect(res.body.print_payload.print_type).toBe('category_items_report');
            expect(res.body.print_payload.is_period).toBe(true);
            expect(res.body.print_payload.period_start_date).toBe('2026-06-25');
            expect(res.body.print_payload.period_end_date).toBe('2026-07-01');
            const [[{ queued }]] = await pool.query('SELECT COUNT(*) AS queued FROM print_queue');
            expect(Number(queued)).toBe(0);
        });

        it('rejects a request with neither business_date nor start_date', async () => {
            await seedReceiptPrinter(pool);

            const res = await request(app)
                .post('/api/admin/audit-reports/print-items')
                .set('Cookie', adminCookie)
                .send({});

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });
    });
});
