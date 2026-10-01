
function fail(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    throw error;
}

function normalizeAmount(raw) {
    if (!['number', 'string'].includes(typeof raw) || String(raw).trim() === '') {
        fail(400, 'Expense amount is required.');
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) fail(400, 'Expense amount cannot be negative.');
    if (value > 99999999.99) fail(400, 'Expense amount exceeds the maximum allowed.');
    if (Number(value.toFixed(2)) !== value) {
        fail(400, 'Expense amount cannot have more than two decimal places.');
    }
    return value;
}

function normalizeNote(raw) {
    const note = String(raw || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
    if (note.length > 255) fail(400, 'Expense note cannot exceed 255 characters.');
    return note;
}

async function loadActiveCategory(executor, categoryId) {
    const id = Number(categoryId);
    if (!Number.isInteger(id) || id <= 0) fail(400, 'An expense category is required.');
    const [[category]] = await executor.query(
        'SELECT id, name FROM expense_categories WHERE id=? AND is_active=1',
        [id]
    );
    if (!category) fail(400, 'The selected expense category is unavailable.');
    return category;
}

async function calculateLiveExpectedCash(executor, shift) {
    const [[orders]] = await executor.query(`
        SELECT COALESCE(SUM(cash_amount), 0) AS cash_sales
        FROM orders
        WHERE shift_id=? AND payment_method NOT IN ('unpaid_table','voided')
    `, [shift.id]);
    const [[refunds]] = await executor.query(`
        SELECT COALESCE(SUM(amount_refunded), 0) AS cash_refunds
        FROM refunds
        WHERE shift_id=? AND kind='refund' AND refund_method='cash'
    `, [shift.id]);
    const [[expenses]] = await executor.query(`
        SELECT COALESCE(SUM(amount), 0) AS cash_expenses
        FROM expenses
        WHERE shift_id=? AND source='drawer' AND status='active'
    `, [shift.id]);

    return Number(shift.starting_cash || 0)
        + Number(orders.cash_sales || 0)
        - Number(refunds.cash_refunds || 0)
        - Number(expenses.cash_expenses || 0);
}

async function readExpense(executor, expenseId) {
    const [[expense]] = await executor.query(`
        SELECT e.*, c.name AS category_name, u.name AS created_by_name,
               cu.name AS canceled_by_name
        FROM expenses e
        JOIN expense_categories c ON c.id=e.category_id
        JOIN users u ON u.id=e.created_by
        LEFT JOIN users cu ON cu.id=e.canceled_by
        WHERE e.id=?
    `, [expenseId]);
    if (!expense) fail(404, 'Expense not found.');
    return {
        ...expense,
        id: Number(expense.id),
        category_id: Number(expense.category_id),
        shift_id: expense.shift_id === null ? null : Number(expense.shift_id),
        amount: Number(expense.amount),
        is_active: expense.status === 'active',
    };
}

async function createExpense(executor, {
    actorId,
    categoryId,
    amount: rawAmount,
    note: rawNote,
    source,
    shiftId = null,
    ownShiftOnly = false,
    requestId = null,
}) {
    const amount = normalizeAmount(rawAmount);
    const note = normalizeNote(rawNote);
    const category = await loadActiveCategory(executor, categoryId);
    let selectedShift = null;

    if (source === 'drawer') {
        const params = ownShiftOnly ? [actorId] : [Number(shiftId)];
        const where = ownShiftOnly ? 'user_id=?' : 'id=?';
        const [[shift]] = await executor.query(
            `SELECT id, user_id, starting_cash, status FROM shifts WHERE ${where} AND status='open' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
            params
        );
        if (!shift) fail(409, ownShiftOnly ? 'You need an open shift to record a drawer expense.' : 'The selected shift is not open.');
        if (ownShiftOnly && Number(shift.user_id) !== Number(actorId)) fail(403, 'You can only use your own cash shift.');
        const expectedCash = await calculateLiveExpectedCash(executor, shift);
        if (amount - expectedCash > 0.000001) fail(409, 'Expense amount exceeds the cash expected in this drawer.');
        selectedShift = shift;
    } else if (source !== 'outside') {
        fail(400, 'Expense source must be drawer or outside POS.');
    }

    const [result] = await executor.query(`
        INSERT INTO expenses (category_id, amount, source, shift_id, note, created_by, request_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [category.id, amount, source, selectedShift?.id || null, note, actorId, requestId]);

    return readExpense(executor, result.insertId);
}

async function cancelExpense(executor, { expenseId, actorId }) {
    const id = Number(expenseId);
    if (!Number.isInteger(id) || id <= 0) fail(400, 'A valid expense id is required.');

    const [[candidate]] = await executor.query('SELECT shift_id FROM expenses WHERE id=?', [id]);
    if (!candidate) fail(404, 'Expense not found.');
    // The caller owns the transaction. Match expense creation/shift closure lock order.
    let shift = null;
    if (candidate.shift_id !== null) {
        const [[row]] = await executor.query('SELECT id, status FROM shifts WHERE id=? FOR UPDATE', [candidate.shift_id]);
        if (!row) fail(404, 'Shift not found.');
        shift = row;
    }

    const [[expense]] = await executor.query('SELECT status, amount FROM expenses WHERE id=? FOR UPDATE', [id]);
    if (!expense) fail(404, 'Expense not found.');
    if (expense.status !== 'active') fail(409, 'Expense is already canceled.');
    if (shift?.status === 'closed') {
        // Reverse this deduction only; preserve the counted cash and other cash corrections.
        await executor.query(
            'UPDATE shifts SET expected_cash=ROUND(COALESCE(expected_cash, 0) + ?, 2) WHERE id=?',
            [expense.amount, shift.id]
        );
    }

    await executor.query(
        "UPDATE expenses SET status='canceled', canceled_by=?, canceled_at=CURRENT_TIMESTAMP WHERE id=?",
        [actorId, id]
    );
    return readExpense(executor, id);
}

module.exports = {
    normalizeAmount,
    calculateLiveExpectedCash,
    createExpense,
    cancelExpense,
    readExpense,
};
