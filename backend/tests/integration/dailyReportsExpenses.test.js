const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Daily expense reports', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        const login = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = login.headers['set-cookie'][0];

        const [shift] = await pool.query(`
            INSERT INTO shifts (user_id, starting_cash, status, opened_at)
            VALUES (?, 50, 'open', '2026-07-18 06:00:00')
        `, [SEED.cashierUser.id]);
        await pool.query("INSERT INTO expense_categories (id, name, is_active, sort_order) VALUES (1, 'Supplies', 1, 10)");
        await pool.query(`
            INSERT INTO expenses
                (category_id, amount, source, shift_id, note, status, created_by, created_at)
            VALUES
                (1, 10, 'drawer', ?, 'Milk', 'active', ?, '2026-07-18 08:00:00'),
                (1,  5, 'outside', NULL, 'Gas', 'active', ?, '2026-07-18 09:00:00'),
                (1,  2, 'drawer', ?, 'Mistake', 'canceled', ?, '2026-07-18 10:00:00'),
                (1,  7, 'outside', NULL, 'Next day', 'active', ?, '2026-07-19 08:00:00')
        `, [
            shift.insertId, SEED.cashierUser.id,
            SEED.adminUser.id,
            shift.insertId, SEED.cashierUser.id,
            SEED.adminUser.id,
        ]);
        await pool.query(`
            INSERT INTO orders
                (order_id, user_id, shift_id, subtotal, tax, total, payment_method, cash_amount, created_at, invoice_issued_at)
            VALUES (1, ?, ?, 100, 0, 100, 'cash', 100, '2026-07-18 08:30:00', '2026-07-18 08:30:00')
        `, [SEED.cashierUser.id, shift.insertId]);
    });

    afterAll(async () => {
        await pool.end();
    });

    it('returns active totals while preserving canceled entries in history', async () => {
        const response = await request(app)
            .get('/api/admin/reports/expenses?start_date=2026-07-18&end_date=2026-07-18')
            .set('Cookie', adminCookie);

        expect(response.statusCode).toBe(200);
        expect(response.body.summary).toEqual({ count: 2, total: 15, drawer: 10, outside: 5 });
        expect(response.body.by_category).toEqual([
            expect.objectContaining({ category_name: 'Supplies', count: 2, total: 15 }),
        ]);
        expect(response.body.entries).toHaveLength(3);
        expect(response.body.entries.find(row => row.status === 'canceled').amount).toBe(2);
    });

    it('adds expenses and remaining-after-expenses without changing collected sales', async () => {
        const response = await request(app)
            .get('/api/admin/reports/summary?start_date=2026-07-18&end_date=2026-07-18')
            .set('Cookie', adminCookie);

        expect(response.statusCode).toBe(200);
        expect(response.body.summary.sales_collected).toBe(100);
        expect(response.body.summary.expenses_total).toBe(15);
        expect(response.body.summary.expense_count).toBe(2);
        expect(response.body.summary.drawer_expenses_total).toBe(10);
        expect(response.body.summary.outside_expenses_total).toBe(5);
        expect(response.body.summary.remaining_after_expenses).toBe(85);
    });
});
