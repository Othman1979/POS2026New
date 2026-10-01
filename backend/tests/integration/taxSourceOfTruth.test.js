const { currentTableRevision } = require('../fixtures/tableOrderRevision');
// globals (describe, it, expect, beforeEach, afterAll) injected by vitest globals: true
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { healOpenOrdersForProduct } = require('../../services/OrderPricing');

describe('Tax source-of-truth & resilient money validation', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    // Create a saved table order with N x product1 (price 5.00 @ seed tax_rate).
    async function createTableOrder(qty, tax, total) {
        const subtotal = Number((SEED.product1.price * qty).toFixed(2));
        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty, price: SEED.product1.price }],
                subtotal, tax, total
            });
        expect(res.statusCode).toBe(200);
        return res.body.order_id; // invoice_id
    }

    it('heals an open order when the product tax changes out-of-band (symptom 1 & 2)', async () => {
        // Seed product1 is 16% tax: 2 x 5.00 => subtotal 10.00, tax 1.60, total 11.60
        const invoiceId = await createTableOrder(2, 1.60, 11.60);

        // Product tax changes under the order (simulating an inventory fix).
        await pool.query("UPDATE products SET tax_rate = 8 WHERE id = ?", [SEED.product1.id]);

        // Event-driven heal (no button).
        await healOpenOrdersForProduct(SEED.product1.id, null);

        const [[order]] = await pool.query("SELECT subtotal, tax, total FROM orders WHERE invoice_id = ?", [invoiceId]);
        expect(Number(order.subtotal)).toBe(10.00);
        expect(Number(order.tax)).toBe(0.80);   // 10.00 * 8%
        expect(Number(order.total)).toBe(10.80);

        const [items] = await pool.query("SELECT tax_rate, tax_amount FROM order_items WHERE invoice_id = ?", [invoiceId]);
        expect(Number(items[0].tax_rate)).toBe(8);
        expect(Number(items[0].tax_amount)).toBeCloseTo(0.80, 2);
    });

    it('reprices the remaining bill from live tax after an item-level void (symptom 3)', async () => {
        const invoiceId = await createTableOrder(2, 1.60, 11.60);

        // Drift the product tax after save.
        await pool.query("UPDATE products SET tax_rate = 8 WHERE id = ?", [SEED.product1.id]);

        const [[savedItem]] = await pool.query(
            "SELECT id FROM order_items WHERE invoice_id = ? AND product_id = ?",
            [invoiceId, SEED.product1.id]
        );

        // Saved units are removed through the void endpoint. The endpoint accepts no
        // client-authored totals, then reprices the remaining live bill from the catalog.
        const res = await request(app)
            .post('/api/pos/refunds')
            .set('Cookie', adminCookie)
            .send({
                invoice_id: invoiceId,
                expected_version: await currentTableRevision(invoiceId), intent: 'void',
                items: [{ order_item_id: savedItem.id, qty: 1 }]
            });
        expect(res.statusCode).toBe(200);

        const [[order]] = await pool.query("SELECT subtotal, tax, total FROM orders WHERE invoice_id = ?", [invoiceId]);
        expect(Number(order.subtotal)).toBe(5.00);
        expect(Number(order.tax)).toBe(0.40);   // server-authoritative: 5.00 * 8%
        expect(Number(order.total)).toBe(5.40);
    });

    it('still blocks a tampered subtotal (security anchor retained)', async () => {
        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                subtotal: 1.00, tax: 0.16, total: 1.16 // subtotal lies (real is 10.00)
            });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(res.body)).toMatch(/Subtotal mismatch/i);
    });

    it('freezes a finalized (paid) order — product tax change does not touch it', async () => {
        const invoiceId = await createTableOrder(2, 1.60, 11.60);

        // Cash out the table (finalize). edit_invoice_id settles the existing table order.
        const cashoutRes = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                edit_invoice_id: invoiceId,
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                subtotal: 10.00, tax: 1.60, total: 11.60,
                payment_method: 'cash', amount_tendered: 11.60
            });
        expect(cashoutRes.statusCode).toBe(200);

        const [[before]] = await pool.query("SELECT subtotal, tax, total FROM orders WHERE invoice_id = ?", [invoiceId]);

        // Change product tax, then attempt a heal — finalized order must be untouched.
        await pool.query("UPDATE products SET tax_rate = 8 WHERE id = ?", [SEED.product1.id]);
        await healOpenOrdersForProduct(SEED.product1.id, null);

        const [[after]] = await pool.query("SELECT subtotal, tax, total FROM orders WHERE invoice_id = ?", [invoiceId]);
        expect(Number(after.tax)).toBe(Number(before.tax));
        expect(Number(after.total)).toBe(Number(before.total));
    });
});
