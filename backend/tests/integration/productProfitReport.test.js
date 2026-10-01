const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { insertPaidOrder, insertOrderItem, insertOrderRefund } = require('../helpers/fixtures');

async function postedPurchase(id, docDate, lines, { status = 'posted', costIncludesTax = 0 } = {}) {
    await pool.query(
        `INSERT INTO stock_documents (id, doc_type, item_kind, status, supplier_id, reference, doc_date, payment_status, cost_includes_tax)
         VALUES (?, 'purchase', 'product', ?, 1, ?, ?, 'paid', ?)`,
        [id, status, `INV-${id}`, docDate, costIncludesTax]);
    for (const [index, line] of lines.entries()) {
        await pool.query(
            `INSERT INTO stock_document_lines (document_id, line_no, product_id, qty, unit_label, unit_factor, unit_price, line_subtotal, line_tax, line_total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, index + 1, line.product_id, line.qty, line.unit_label || 'unit', line.unit_factor || 1, line.unit_price,
                line.subtotal, line.tax || 0, line.subtotal + (line.tax || 0)]);
    }
}

describe('Product profit report', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = login.headers['set-cookie'][0];
        await pool.query("INSERT INTO purchase_suppliers (id, name) VALUES (1, 'General supplier')");
    });

    afterAll(async () => {
        await pool.end();
    });

    it('subtracts the weighted average purchase cost from net sales before tax', async () => {
        // 10 units at 2.000 and one box of 10 at 40.000 -> 3.000 per unit.
        await postedPurchase(1, '2026-07-01', [{ product_id: SEED.product1.id, qty: 10, unit_price: 2, subtotal: 20, tax: 3.2 }]);
        await postedPurchase(2, '2026-07-02', [{ product_id: SEED.product1.id, qty: 1, unit_label: 'box', unit_factor: 10, unit_price: 40, subtotal: 40 }]);
        await postedPurchase(3, '2026-07-02', [{ product_id: SEED.product1.id, qty: 10, unit_price: 100, subtotal: 1000 }], { status: 'reversed' });
        await postedPurchase(4, '2026-07-20', [{ product_id: SEED.product1.id, qty: 10, unit_price: 100, subtotal: 1000 }]);

        const invoiceId = await insertPaidOrder(pool, {
            subtotal: 20, tax: 3.2, total: 23.2, invoice_issued_at: '2026-07-05 10:00:00', created_at: '2026-07-05 10:00:00',
        });
        const itemId = await insertOrderItem(pool, { invoice_id: invoiceId, quantity: 4, price_at_sale: 5, tax_amount: 3.2 });
        const refundId = await insertOrderRefund(pool, {
            invoice_id: invoiceId, subtotal_refunded: 5, tax_refunded: 0.8, amount_refunded: 5.8, created_at: '2026-07-05 11:00:00',
        });
        await pool.query(
            `INSERT INTO refund_items (refund_id, order_item_id, product_id, item_name, quantity, unit_price, line_subtotal, line_tax, line_total)
             VALUES (?, ?, ?, 'Test Burger', 1, 5, 5, 0.8, 5.8)`, [refundId, itemId, SEED.product1.id]);

        const response = await request(app)
            .get('/api/admin/reports/product-profit?start_date=2026-07-05&end_date=2026-07-05')
            .set('Cookie', adminCookie);

        expect(response.statusCode).toBe(200);
        expect(response.body.costing_method).toBe('weighted_average');
        expect(response.body.products).toEqual([expect.objectContaining({
            product_id: SEED.product1.id, net_qty: 3, net_sales: 15, unit_cost: 3, cost_source: 'purchase_average',
            purchase_invoices: 2, cost: 9, profit: 6, margin_pct: 40,
        })]);
        expect(response.body.totals).toMatchObject({ net_sales: 15, known_cost: 9, profit: 6, margin_pct: 40, missing_cost: 0 });
    });

    it('falls back to the product cost price and reports products without any cost', async () => {
        await pool.query('UPDATE products SET cost_price = 1.5 WHERE id = ?', [SEED.product1.id]);
        const [[other]] = await pool.query('SELECT id FROM products WHERE id <> ? ORDER BY id LIMIT 1', [SEED.product1.id]);
        await pool.query('UPDATE products SET cost_price = 0 WHERE id = ?', [other.id]);
        const invoiceId = await insertPaidOrder(pool, {
            subtotal: 20, tax: 0, total: 20, invoice_issued_at: '2026-07-05 10:00:00', created_at: '2026-07-05 10:00:00',
        });
        await insertOrderItem(pool, { invoice_id: invoiceId, quantity: 2, price_at_sale: 5, tax_amount: 0 });
        await insertOrderItem(pool, { invoice_id: invoiceId, product_id: other.id, quantity: 2, price_at_sale: 5, tax_amount: 0 });

        const response = await request(app)
            .get('/api/admin/reports/product-profit?start_date=2026-07-05&end_date=2026-07-05')
            .set('Cookie', adminCookie);

        expect(response.statusCode).toBe(200);
        expect(response.body.products.find(row => row.product_id === SEED.product1.id))
            .toMatchObject({ unit_cost: 1.5, cost_source: 'product_cost', cost: 3, profit: 7 });
        expect(response.body.products.find(row => row.product_id === other.id))
            .toMatchObject({ unit_cost: null, cost_source: 'unknown', cost: null, profit: null });
        expect(response.body.totals).toMatchObject({ net_sales: 20, known_cost: 3, profit: 7, margin_pct: 70, missing_cost: 1 });
    });
});
