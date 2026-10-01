const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('transactional kitchen print admission', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = login.headers['set-cookie'][0];
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id, is_active) VALUES ('Admission Kitchen', 'kitchen', 'windows', 'Admission-Kitchen', 'primary', 1)"
        );
        await pool.query(
            'INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)',
            [printer.insertId, SEED.category.id]
        );
    });

    afterEach(async () => {
        await pool.query('DROP TRIGGER IF EXISTS test_reject_kitchen_queue');
    });

    afterAll(async () => {
        await pool.end();
    });

    async function rejectQueueInserts() {
        await pool.query(
            "CREATE TRIGGER test_reject_kitchen_queue BEFORE INSERT ON print_queue FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced kitchen queue failure'"
        );
    }

    const checkoutPayload = key => ({
        cart: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }],
        subtotal: 5,
        tax: 0.8,
        total: 5.8,
        payment_method: 'cash',
        amount_tendered: 10,
        change_due: 4.2,
        idempotency_key: key
    });

    it('returns a paid checkout only after its kitchen ticket is durable', async () => {
        const payload = checkoutPayload('kitchen-admission-success');
        const response = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send(payload);

        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(response.body).toMatchObject({ success: true, kitchen_ticket_count: 1 });
        const [[job]] = await pool.query(
            "SELECT status, print_type FROM print_queue WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.data.invoice_id')) = ?",
            [String(response.body.invoice_id)]
        );
        expect(job).toMatchObject({ status: 'pending', print_type: 'kitchen' });

        const replay = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send(payload);
        expect(replay.statusCode).toBe(200);
        expect(replay.body).toMatchObject({ success: true, duplicate: true, invoice_id: response.body.invoice_id });
        const [[count]] = await pool.query(
            "SELECT COUNT(*) AS count FROM print_queue WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.data.invoice_id')) = ? AND print_type='kitchen'",
            [String(response.body.invoice_id)]
        );
        expect(Number(count.count)).toBe(1);
    });

    it('rolls back checkout when its routed kitchen ticket cannot enter the outbox', async () => {
        await rejectQueueInserts();
        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send(checkoutPayload('kitchen-admission-checkout-rollback'));

        expect(response.statusCode).toBe(500);
        const [[order]] = await pool.query(
            'SELECT COUNT(*) AS count FROM orders WHERE idempotency_key=?',
            ['kitchen-admission-checkout-rollback']
        );
        expect(Number(order.count)).toBe(0);
    });

    it('rolls back a table save when its routed kitchen ticket cannot enter the outbox', async () => {
        const [[before]] = await pool.query(
            'SELECT status, current_order_id FROM restaurant_tables WHERE id=?',
            [SEED.table.id]
        );
        await rejectQueueInserts();
        const response = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, name: SEED.product1.name, price: 5, qty: 1, tax_rate: 16 }],
                subtotal: 5,
                tax: 0.8,
                total: 5.8
            });

        expect(response.statusCode).toBe(500);
        const [[after]] = await pool.query(
            'SELECT status, current_order_id FROM restaurant_tables WHERE id=?',
            [SEED.table.id]
        );
        expect(after).toEqual(before);
        const [[orders]] = await pool.query('SELECT COUNT(*) AS count FROM orders WHERE table_id=?', [SEED.table.id]);
        expect(Number(orders.count)).toBe(0);
    });
});
