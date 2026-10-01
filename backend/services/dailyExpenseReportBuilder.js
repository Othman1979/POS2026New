const { getExpenseTotalsForRange } = require('./expenseMetrics');
const { combineFinancialEvents, getFinancialEventsForPeriod } = require('./financialEventMetrics');
const { roundMoney } = require('./PosCalculator');
const { getBusinessDate } = require('../utils/businessDate');

async function buildDailyExpenseReport(executor, period) {
    const range = { start: period.business_start_at, end: period.business_end_at };
    const [summary, financialEvents, categoryResult, entriesResult, categoriesResult, shiftsResult] = await Promise.all([
        getExpenseTotalsForRange(executor, range),
        getFinancialEventsForPeriod(executor, range.start, range.end),
        executor.query(`
            SELECT e.category_id, c.name AS category_name, COUNT(*) AS expense_count,
                   COALESCE(SUM(e.amount), 0) AS expense_total
            FROM expenses e
            JOIN expense_categories c ON c.id=e.category_id
            WHERE e.status='active' AND e.created_at >= ? AND e.created_at < ?
            GROUP BY e.category_id, c.name
            ORDER BY expense_total DESC, c.name ASC
        `, [range.start, range.end]),
        executor.query(`
            SELECT e.id, e.category_id, c.name AS category_name, e.amount, e.source,
                   e.shift_id, e.note, e.status, e.created_at, e.canceled_at,
                   e.created_by, u.name AS created_by_name,
                   e.canceled_by, cu.name AS canceled_by_name
            FROM expenses e
            JOIN expense_categories c ON c.id=e.category_id
            JOIN users u ON u.id=e.created_by
            LEFT JOIN users cu ON cu.id=e.canceled_by
            WHERE e.created_at >= ? AND e.created_at < ?
            ORDER BY e.created_at DESC, e.id DESC
        `, [range.start, range.end]),
        executor.query(`
            SELECT id, name, is_active, sort_order
            FROM expense_categories
            ORDER BY sort_order, name, id
        `),
        executor.query(`
            SELECT s.id, s.user_id, u.name AS cashier_name, s.starting_cash, s.opened_at
            FROM shifts s JOIN users u ON u.id=s.user_id
            WHERE s.status='open'
            ORDER BY s.opened_at, s.id
        `),
    ]);

    const sales = combineFinancialEvents(financialEvents, financialEvents);

    return {
        period,
        summary,
        sales_collected: sales.sales_collected,
        remaining_after_expenses: roundMoney(sales.sales_collected - summary.total),
        by_source: [
            { source: 'drawer', total: summary.drawer },
            { source: 'outside', total: summary.outside },
        ],
        by_category: categoryResult[0].map(row => ({
            category_id: Number(row.category_id),
            category_name: row.category_name,
            count: Number(row.expense_count || 0),
            total: Number(row.expense_total || 0),
        })),
        entries: entriesResult[0].map(row => ({
            ...row,
            id: Number(row.id),
            category_id: Number(row.category_id),
            shift_id: row.shift_id === null ? null : Number(row.shift_id),
            amount: Number(row.amount || 0),
        })),
        categories: categoriesResult[0].map(row => ({ ...row, id: Number(row.id), is_active: Number(row.is_active) })),
        open_shifts: shiftsResult[0].map(row => ({
            ...row,
            id: Number(row.id),
            user_id: Number(row.user_id),
            starting_cash: Number(row.starting_cash || 0),
        })),
        is_current_business_day: period.is_single_day && period.start_date === getBusinessDate(),
    };
}

module.exports = { buildDailyExpenseReport };
