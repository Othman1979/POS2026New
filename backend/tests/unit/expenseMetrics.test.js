const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const {
    getExpenseTotalsForRange,
    getCashExpensesByShift,
    getCashExpenseCategoriesByShift,
} = require('../../services/expenseMetrics');

describe('expense metrics', () => {
    beforeEach(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('excludes canceled and end-boundary expenses from period totals', async () => {
        const [shift] = await pool.query(
            "INSERT INTO shifts (user_id, starting_cash, status, opened_at) VALUES (?, 50, 'open', '2026-07-18 06:00:00')",
            [SEED.cashierUser.id]
        );
        await pool.query("INSERT INTO expense_categories (id, name, is_active, sort_order) VALUES (1, 'Supplies', 1, 10)");
        await pool.query(`
            INSERT INTO expenses
                (category_id, amount, source, shift_id, note, status, created_by, created_at)
            VALUES
                (1, 10.00, 'drawer', ?, 'Milk', 'active', ?, '2026-07-18 08:00:00'),
                (1,  5.00, 'outside', NULL, 'Gas', 'active', ?, '2026-07-18 09:00:00'),
                (1,  3.00, 'drawer', ?, 'Canceled', 'canceled', ?, '2026-07-18 10:00:00'),
                (1,  7.00, 'drawer', ?, 'Next day', 'active', ?, '2026-07-19 06:00:00')
        `, [
            shift.insertId, SEED.cashierUser.id,
            SEED.adminUser.id,
            shift.insertId, SEED.cashierUser.id,
            shift.insertId, SEED.cashierUser.id,
        ]);

        const totals = await getExpenseTotalsForRange(pool, {
            start: '2026-07-18 06:00:00',
            end: '2026-07-19 06:00:00',
        });

        expect(totals).toEqual({
            count: 2,
            total: 15,
            drawer: 10,
            outside: 5,
        });
    });

    it('groups only active drawer expenses by shift', async () => {
        const [first] = await pool.query(
            "INSERT INTO shifts (user_id, starting_cash, status) VALUES (?, 50, 'open')",
            [SEED.cashierUser.id]
        );
        const [second] = await pool.query(
            "INSERT INTO shifts (user_id, starting_cash, status) VALUES (?, 30, 'open')",
            [SEED.adminUser.id]
        );
        await pool.query("INSERT INTO expense_categories (id, name, is_active, sort_order) VALUES (1, 'Supplies', 1, 10)");
        await pool.query(`
            INSERT INTO expenses (category_id, amount, source, shift_id, status, created_by)
            VALUES
                (1, 4.25, 'drawer', ?, 'active', ?),
                (1, 1.75, 'drawer', ?, 'active', ?),
                (1, 8.00, 'outside', NULL, 'active', ?),
                (1, 2.00, 'drawer', ?, 'canceled', ?)
        `, [
            first.insertId, SEED.cashierUser.id,
            first.insertId, SEED.cashierUser.id,
            SEED.adminUser.id,
            second.insertId, SEED.adminUser.id,
        ]);

        const byShift = await getCashExpensesByShift(pool, [first.insertId, second.insertId]);

        expect(byShift[first.insertId]).toBe(6);
        expect(byShift[second.insertId]).toBeUndefined();

        const categories = await getCashExpenseCategoriesByShift(pool, [first.insertId, second.insertId]);
        expect(categories[first.insertId]).toEqual([{
            category_id: 1,
            category_name: 'Supplies',
            count: 2,
            total: 6,
        }]);
        expect(categories[second.insertId]).toBeUndefined();
    });
});
