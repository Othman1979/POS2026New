const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

async function invoice(id, { supplierId, date, status = 'posted', lines }) {
    await pool.query(
        `INSERT INTO stock_documents (id, doc_type, item_kind, status, supplier_id, reference, doc_date, payment_status)
         VALUES (?, 'purchase', 'product', ?, ?, ?, ?, 'paid')`, [id, status, supplierId, `INV-${id}`, date]);
    for (const [index, line] of lines.entries()) {
        const subtotal = line.qty * line.price;
        await pool.query(
            `INSERT INTO stock_document_lines (document_id, line_no, product_id, qty, unit_label, unit_factor, unit_price, line_subtotal, line_tax, line_total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
            [id, index + 1, SEED.product1.id, line.qty, line.label || 'unit', line.factor || 1, line.price, subtotal, subtotal]);
    }
}

describe('purchase item insights', () => {
    let cookie;
    const key = `product:${SEED.product1.id}`;
    const insights = (query) => request(app).get(`/api/admin/purchases/items/insights?kind=product&keys=${key}${query || ''}`).set('Cookie', cookie);

    beforeEach(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        await pool.query("INSERT INTO purchase_suppliers (id, name) VALUES (1, 'Mine'), (2, 'Other')");
        await pool.query('UPDATE products SET stock = 17 WHERE id = ?', [SEED.product1.id]);
        await invoice(1, { supplierId: 1, date: '2026-09-01', lines: [{ qty: 10, price: 0.2 }] });
        await invoice(2, { supplierId: 2, date: '2026-09-20', lines: [{ qty: 2, label: 'box', factor: 12, price: 3.6 }] });
        await invoice(3, { supplierId: 1, date: '2026-09-25', status: 'reversed', lines: [{ qty: 1, price: 9 }] });
        await invoice(4, { supplierId: 2, date: '2026-09-28', status: 'draft', lines: [{ qty: 1, price: 9 }] });
    });

    afterAll(async () => {
        await pool.end();
    });

    it('returns the latest posted price from any supplier, the supplier price, the weighted average, and stock', async () => {
        const res = await insights('&supplier_id=1');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const [entry] = res.body.data;
        expect(entry.last).toMatchObject({ unit_price: 3.6, unit_factor: 12, base_price: 0.3, invoice_date: '2026-09-20', supplier_name: 'Other', reference: 'INV-2' });
        expect(entry.supplier_last).toMatchObject({ base_price: 0.2, invoice_date: '2026-09-01', supplier_name: 'Mine' });
        // (2.000 + 7.200) / (10 + 24) units
        expect(entry.average_base_price).toBeCloseTo(9.2 / 34, 6);
        expect(entry.on_hand).toBe(17);
    });

    it('skips keys of the other kind and leaves supplier history empty without a supplier', async () => {
        const res = await request(app).get(`/api/admin/purchases/items/insights?kind=product&keys=${key},ingredient:5`).set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].supplier_last).toBeNull();
    });
});
