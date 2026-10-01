const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('POS action connection and committed response lifetime', () => {
    let cookie;
    let categoryId;
    let printerId;
    let shiftId;

    beforeEach(async () => {
        if (process.env.POSAPP_REVIEW_CONNECTION_LIMIT) {
            expect(pool.pool.config.connectionLimit).toBe(Number(process.env.POSAPP_REVIEW_CONNECTION_LIMIT));
        }
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        cookie = login.headers['set-cookie'][0];
        const [shift] = await pool.query("INSERT INTO shifts (user_id, starting_cash, status) VALUES (?, 50, 'open')", [SEED.adminUser.id]);
        shiftId = shift.insertId;
        const [category] = await pool.query("INSERT INTO expense_categories (name, is_active, created_by) VALUES ('Supplies', 1, ?)", [SEED.adminUser.id]);
        categoryId = category.insertId;
        const [printer] = await pool.query("INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Fixture Receipt', 'receipt', 'windows', 'Fixture Receipt', 1)");
        printerId = printer.insertId;
    });
    afterEach(() => { global.__mockEmit__.mockReset(); });
    afterAll(async () => { await pool.end(); });

    const breakNotification = eventName => global.__mockEmit__.mockImplementation(event => {
        if (event === eventName) throw new Error('Injected notification failure after commit');
    });

    it.each([false, true])('returns committed availability with one connection (notification failure: %s)', async fail => {
        if (fail) breakNotification('product_availability_changed');
        const response = await request(app).patch(`/api/pos/products/${SEED.product1.id}/availability`)
            .set('Cookie', cookie).send({ is_available: false }).timeout({ deadline: 3000 });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(response.body.product.is_available).toBe(0);
        const [[product]] = await pool.query('SELECT is_available FROM products WHERE id = ?', [SEED.product1.id]);
        expect(product.is_available).toBe(0);
    });

    it.each([false, true])('returns a saved drawer expense and queues its receipt with one connection (notification failure: %s)', async fail => {
        if (fail) breakNotification('expenses_changed');
        const response = await request(app).post('/api/pos/expenses').set('Cookie', cookie)
            .send({ category_id: categoryId, amount: 10, receipt_printer_id: printerId }).timeout({ deadline: 3000 });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(response.body.print_queued).toBe(true);
        const [[expense]] = await pool.query('SELECT amount, shift_id FROM expenses WHERE id = ?', [response.body.expense.id]);
        expect(Number(expense.amount)).toBe(10);
        expect(expense.shift_id).toBe(shiftId);
    });

    it('returns a committed partial refund when its shift notification fails', async () => {
        const sale = await request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
            cart: [{ id: SEED.product2.id, qty: 2, price: 2 }], shift_id: shiftId,
            subtotal: 4, tax: 0, total: 4, payment_method: 'cash', amount_tendered: 4, change_due: 0,
        });
        expect(sale.statusCode, JSON.stringify(sale.body)).toBe(200);
        const [[item]] = await pool.query('SELECT id FROM order_items WHERE invoice_id = ?', [sale.body.invoice_id]);
        breakNotification('shifts_changed');
        const refund = await request(app).post('/api/pos/refunds').set('Cookie', cookie).send({
            invoice_id: sale.body.invoice_id, intent: 'refund', refund_method: 'cash',
            items: [{ order_item_id: item.id, qty: 1 }],
        }).timeout({ deadline: 3000 });
        expect(refund.statusCode, JSON.stringify(refund.body)).toBe(200);
        expect(Number(refund.body.amount_refunded)).toBe(2);
        const [[stored]] = await pool.query('SELECT COUNT(*) AS count, SUM(amount_refunded) AS total FROM refunds WHERE invoice_id = ?', [sale.body.invoice_id]);
        expect(Number(stored.count)).toBe(1);
        expect(Number(stored.total)).toBe(2);
    });
});
