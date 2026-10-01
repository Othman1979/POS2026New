const pool = require('../../config/db');
const router = require('../../routes/admin/shifts');
const { seedDatabase } = require('../fixtures/seed');
const { insertShift, insertPaidOrder, insertOrderRefund } = require('../helpers/fixtures');
const { getBusinessDateRange } = require('../../utils/businessDate');

const handler = router.stack.find(layer => layer.route?.path === '/shifts').route.stack[0].handle;
const day = { start_date: '2026-07-01' };
const range = getBusinessDateRange(day.start_date, day.start_date);

async function list(query = day) {
    let body;
    let status = 200;
    await handler({ method: 'GET', query, user: { id: 1, role: 'admin' } }, {
        status(code) { status = code; return this; },
        json(value) { body = value; return this; },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    return body;
}

describe('Shifts date eligibility', () => {
    beforeEach(async () => { await seedDatabase(); });

    it('preserves issued-time precedence, legacy timestamps, payment exclusions and pagination', async () => {
        const included = [];
        const cases = [
            { invoice_issued_at: range.start, created_at: '2025-01-01 08:00:00', included: true },
            { invoice_issued_at: null, created_at: range.start, included: true },
            { invoice_issued_at: range.end, created_at: range.start, included: false },
            { invoice_issued_at: null, created_at: range.end, included: false },
            { invoice_issued_at: '2025-01-01 08:00:00', created_at: range.start, included: false },
            { invoice_issued_at: range.start, created_at: range.start, payment_method: 'unpaid_table', included: false },
            { invoice_issued_at: range.start, created_at: '2025-01-01 08:00:00', payment_method: 'voided', included: false },
            { invoice_issued_at: range.start, created_at: range.start, opened_at: range.end, included: false },
        ];
        for (const entry of cases) {
            const { included: expected, opened_at = '2025-01-01 07:00:00', ...order } = entry;
            const shift = await insertShift(pool, { opened_at, status: 'closed', actual_cash: 23, expected_cash: 20 });
            await insertPaidOrder(pool, { shift_id: shift, ...order });
            if (expected) included.push(shift);
        }
        included.reverse();
        const all = await list();
        expect(all.shifts.map(row => row.id)).toEqual(included);
        expect(all.pagination.total).toBe(2);
        for (const row of all.shifts) {
            expect(row.gross_sales).toBe(11.6);
            expect(row.cash_sales).toBe(11.6);
            expect(row.variance).toBe(3);
        }
        const page = await list({ ...day, status: 'closed', cashier_ids: '2', limit: '1', page: '2' });
        expect(page.shifts).toEqual([all.shifts[1]]);
        expect(page.pagination).toEqual({ total: 2, page: 2, limit: 1, total_pages: 2 });
        expect((await list({ ...day, status: 'open' })).shifts).toEqual([]);
        expect((await list({ ...day, search: '999999' })).shifts).toEqual([]);
        expect((await list({ limit: '200' })).pagination.total).toBe(cases.length);
    });

    it('retains old shifts with refund, void, or expense activity', async () => {
        const shifts = [];
        for (let i = 0; i < 4; i++) shifts.push(await insertShift(pool, { opened_at: '2025-01-01 07:00:00' }));
        const invoice = await insertPaidOrder(pool, { shift_id: shifts[0], created_at: '2025-01-01 08:00:00', invoice_issued_at: '2025-01-01 08:00:00' });
        await insertOrderRefund(pool, { invoice_id: invoice, shift_id: shifts[0], created_at: range.start, amount_refunded: 2, subtotal_refunded: 2 });
        await insertPaidOrder(pool, { shift_id: shifts[1], payment_method: 'voided', created_at: range.start, invoice_issued_at: '2025-01-01 08:00:00' });
        const [category] = await pool.query("INSERT INTO expense_categories(name,is_active) VALUES ('Date query',1)");
        await pool.query(`INSERT INTO expenses(category_id,amount,source,shift_id,status,created_by,created_at)
            VALUES (?,3,'drawer',?,'active',1,?),(?,4,'drawer',?,'canceled',1,?)`,
        [category.insertId, shifts[2], range.start, category.insertId, shifts[3], range.start]);
        const result = await list();
        expect(result.shifts.map(row => row.id)).toEqual([...shifts].reverse());
        const byId = Object.fromEntries(result.shifts.map(row => [row.id, row]));
        expect(byId[shifts[0]].cash_sales).toBe(-2);
        expect(byId[shifts[2]].cash_expenses).toBe(3);
        expect(byId[shifts[3]].cash_expenses).toBe(0);
    });

    it('bounds database work when historical shifts have no activity in the selected day', async () => {
        const [batch] = await pool.query(`INSERT INTO shifts(user_id,starting_cash,status,opened_at)
            VALUES ?`, [Array.from({ length: 200 }, () => [2, 0, 'open', '2025-01-01 07:00:00'])]);
        for (let offset = 0; offset < 4000; offset += 500) {
            await pool.query(`INSERT INTO orders(user_id,shift_id,subtotal,tax,total,cash_amount,payment_method,created_at,invoice_issued_at)
                VALUES ?`, [Array.from({ length: 500 }, (_, i) => [2, batch.insertId + (offset + i) % 200, 10, 0, 10, 10, 'cash', '2025-01-01 08:00:00', '2025-01-01 08:00:00'])]);
        }
        await insertPaidOrder(pool, { shift_id: batch.insertId, invoice_issued_at: range.start });
        await pool.query('ANALYZE TABLE shifts,orders,refunds,expenses');
        const conn = await pool.getConnection();
        const original = pool.query;
        try {
            pool.query = conn.query.bind(conn);
            const [[before]] = await conn.query("SHOW SESSION STATUS LIKE 'Rows_read'");
            const result = await list();
            const [[after]] = await conn.query("SHOW SESSION STATUS LIKE 'Rows_read'");
            expect(result.shifts.map(row => row.id)).toEqual([batch.insertId]);
            expect(result.shifts[0].gross_sales).toBe(11.6);
            // Generous row-work limit, not a timing or optimizer-plan assertion.
            expect(Number(after.Value) - Number(before.Value)).toBeLessThan(4000);
        } finally { pool.query = original; conn.release(); }
    });
});
