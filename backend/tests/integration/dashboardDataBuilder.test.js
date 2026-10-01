const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { insertPaidOrder, insertShift } = require('../helpers/fixtures');
const { buildDashboardData } = require('../../services/dashboardDataBuilder');

describe('buildDashboardData', () => {
    beforeEach(seedDatabase);

    async function seedMatchingTuesday(date, sameTimeTotal, fullDayTotal) {
        await insertPaidOrder(pool, {
            total: sameTimeTotal,
            subtotal: sameTimeTotal,
            tax: 0,
            cash_amount: sameTimeTotal,
            payment_method: 'cash',
            invoice_issued_at: `${date} 06:00:00`,
            created_at: `${date} 06:00:00`,
        });
        if (fullDayTotal > sameTimeTotal) {
            const late = fullDayTotal - sameTimeTotal;
            await insertPaidOrder(pool, {
                total: late,
                subtotal: late,
                tax: 0,
                cash_amount: late,
                payment_method: 'cash',
                invoice_issued_at: `${date} 18:00:00`,
                created_at: `${date} 18:00:00`,
            });
        }
    }

    it('builds same-time comparison from at least three operating Tuesdays', async () => {
        for (const date of ['2026-07-07', '2026-06-30', '2026-06-23']) {
            await seedMatchingTuesday(date, 100, 200);
        }
        for (let index = 0; index < 5; index += 1) {
            await insertPaidOrder(pool, {
                total: 24,
                subtotal: 24,
                tax: 0,
                cash_amount: 24,
                payment_method: 'cash',
                invoice_issued_at: `2026-07-14 0${4 + index}:00:00`,
                created_at: `2026-07-14 0${4 + index}:00:00`,
            });
        }

        const data = await buildDashboardData(pool, { now: new Date('2026-07-14T09:00:00Z') });

        expect(data.business_date).toBe('2026-07-14');
        expect(data.history).toEqual({ eligible_days: 3, comparison_ready: true });
        expect(data.headline).toMatchObject({
            sales_today: 120,
            orders: 5,
            average_check: 24,
            estimated_close: 240,
        });
        expect(data.comparison).toMatchObject({ pace_state: 'ahead' });
        expect(data.pace.points.at(-1).elapsed_minute).toBe(360);
    });

    it('deduplicates merged-table order value and reports longest open table', async () => {
        const invoiceId = await insertPaidOrder(pool, {
            payment_method: 'unpaid_table',
            total: 35,
            subtotal: 35,
            cash_amount: 0,
            card_amount: 0,
            invoice_issued_at: null,
            created_at: '2026-07-14 04:00:00',
        });
        await pool.query('UPDATE orders SET table_id=? WHERE invoice_id=?', [SEED.table.id, invoiceId]);
        await pool.query(
            "UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id IN (?,?)",
            [invoiceId, SEED.table.id, SEED.table2.id]
        );
        await pool.query(
            'UPDATE restaurant_tables SET parent_table_id=? WHERE id=?',
            [SEED.table.id, SEED.table2.id]
        );

        const data = await buildDashboardData(pool, { now: new Date('2026-07-14T09:00:00Z') });

        expect(data.tables).toMatchObject({ occupied_count: 2, open_unpaid_value: 35 });
        expect(data.tables.longest_open).toMatchObject({ table_number: '1' });
    });

    it('omits tables and low-stock attention when features are disabled', async () => {
        await pool.query(
            "UPDATE settings SET setting_value='0' WHERE setting_key IN ('tables_enabled','stock_enabled')"
        );

        const data = await buildDashboardData(pool, { now: new Date('2026-07-14T09:00:00Z') });

        expect(data.tables).toBeNull();
        expect(data.attention.some(item => item.type === 'stock')).toBe(false);
    });

    it('reports stored closed-shift variance without recomputing drawer totals', async () => {
        const shiftId = await insertShift(pool, {
            status: 'closed',
            opened_at: '2026-07-14 03:30:00',
            closed_at: '2026-07-14 08:00:00',
            expected_cash: 100,
            actual_cash: 96.5,
        });

        const data = await buildDashboardData(pool, { now: new Date('2026-07-14T09:00:00Z') });

        expect(data.attention).toContainEqual(expect.objectContaining({
            type: 'register',
            params: { shift_id: shiftId, amount: 3.5, direction: 'short' },
        }));
    });

    it('shows current-day expenses separately from sales', async () => {
        await insertPaidOrder(pool, {
            total: 100,
            subtotal: 100,
            tax: 0,
            cash_amount: 100,
            payment_method: 'cash',
            invoice_issued_at: '2026-07-14 08:00:00',
            created_at: '2026-07-14 08:00:00',
        });
        await pool.query("INSERT INTO expense_categories (id, name, sort_order) VALUES (1, 'Supplies', 10)");
        await pool.query(`
            INSERT INTO expenses (category_id, amount, source, status, created_by, created_at)
            VALUES (1, 15, 'outside', 'active', ?, '2026-07-14 08:30:00'),
                   (1,  5, 'outside', 'canceled', ?, '2026-07-14 08:45:00')
        `, [SEED.adminUser.id, SEED.adminUser.id]);

        const data = await buildDashboardData(pool, { now: new Date('2026-07-14T09:00:00Z') });

        expect(data.headline).toMatchObject({
            sales_today: 100,
            expenses_today: 15,
            remaining_after_expenses: 85,
        });
    });
});
