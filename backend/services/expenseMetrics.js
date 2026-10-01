function normalizeRange(range) {
    if (!range?.start || !range?.end) {
        throw new Error('Expense range requires start and end timestamps.');
    }
    return [range.start, range.end];
}

async function getExpenseTotalsForRange(executor, range) {
    const [start, end] = normalizeRange(range);
    const [[row]] = await executor.query(`
        SELECT
            COUNT(*) AS expense_count,
            COALESCE(SUM(amount), 0) AS expense_total,
            COALESCE(SUM(CASE WHEN source = 'drawer' THEN amount ELSE 0 END), 0) AS drawer_total,
            COALESCE(SUM(CASE WHEN source = 'outside' THEN amount ELSE 0 END), 0) AS outside_total
        FROM expenses
        WHERE status = 'active' AND created_at >= ? AND created_at < ?
    `, [start, end]);

    return {
        count: Number(row?.expense_count || 0),
        total: Number(row?.expense_total || 0),
        drawer: Number(row?.drawer_total || 0),
        outside: Number(row?.outside_total || 0),
    };
}

async function getCashExpensesByShift(executor, shiftIds, range = null) {
    if (!Array.isArray(shiftIds) || shiftIds.length === 0) return {};

    const params = [...shiftIds];
    let rangeSql = '';
    if (range?.start && range?.end) {
        rangeSql = 'AND created_at >= ? AND created_at < ?';
        params.push(range.start, range.end);
    }

    const [rows] = await executor.query(`
        SELECT shift_id, COALESCE(SUM(amount), 0) AS total
        FROM expenses
        WHERE status = 'active'
          AND source = 'drawer'
          AND shift_id IN (${shiftIds.map(() => '?').join(',')})
          ${rangeSql}
        GROUP BY shift_id
    `, params);

    return Object.fromEntries(rows.map(row => [Number(row.shift_id), Number(row.total || 0)]));
}

async function getCashExpenseCategoriesByShift(executor, shiftIds, range = null) {
    if (!Array.isArray(shiftIds) || shiftIds.length === 0) return {};
    const params = [...shiftIds];
    let rangeSql = '';
    if (range?.start && range?.end) {
        rangeSql = 'AND e.created_at >= ? AND e.created_at < ?';
        params.push(range.start, range.end);
    }
    const [rows] = await executor.query(`
        SELECT e.shift_id, e.category_id, c.name AS category_name,
               COUNT(*) AS expense_count, COALESCE(SUM(e.amount), 0) AS total
        FROM expenses e
        JOIN expense_categories c ON c.id=e.category_id
        WHERE e.status='active' AND e.source='drawer'
          AND e.shift_id IN (${shiftIds.map(() => '?').join(',')})
          ${rangeSql}
        GROUP BY e.shift_id, e.category_id, c.name
        ORDER BY e.shift_id, total DESC, c.name
    `, params);
    const result = {};
    for (const row of rows) {
        const shiftId = Number(row.shift_id);
        if (!result[shiftId]) result[shiftId] = [];
        result[shiftId].push({
            category_id: Number(row.category_id),
            category_name: row.category_name,
            count: Number(row.expense_count || 0),
            total: Number(row.total || 0),
        });
    }
    return result;
}

module.exports = { getExpenseTotalsForRange, getCashExpensesByShift, getCashExpenseCategoriesByShift };
