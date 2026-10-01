const express = require('express');
const router = express.Router();
const pool = require('../../config/db');
const { requireAuth, rejectCallCenterRole } = require('../../middleware/auth');
const { userHas, PERMISSIONS } = require('../../services/PermissionService');
const { createExpense, readExpense } = require('../../services/expenseService');
const { invalidateDashboardCache } = require('../../config/cache');
const { queueExpensePrint } = require('../../services/expensePrint');
const logger = require('../../config/logger');

function sendError(res, error) {
    const status = error.statusCode || 500;
    if (status === 500) logger.error({ err: error }, 'POS expense operation failed.');
    return res.status(status).json({
        success: false,
        message: status === 500 ? 'Failed to record expense.' : error.message,
    });
}

router.get('/expense-categories', requireAuth, rejectCallCenterRole, async (req, res) => {
    if (!userHas(req.user, PERMISSIONS.POS_EXPENSES)) {
        return res.status(403).json({ success: false, message: 'You do not have permission to record expenses.' });
    }
    const [categories] = await pool.query(
        'SELECT id, name, sort_order FROM expense_categories WHERE is_active=1 ORDER BY sort_order, name, id'
    );
    return res.json({ success: true, categories });
});

router.post('/expenses', requireAuth, rejectCallCenterRole, async (req, res) => {
    if (!userHas(req.user, PERMISSIONS.POS_EXPENSES)) {
        return res.status(403).json({ success: false, message: 'You do not have permission to record expenses.' });
    }

    const requestId = req.body.request_id == null || req.body.request_id === '' ? null : String(req.body.request_id);
    if (requestId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
        return res.status(400).json({ success: false, message: 'Invalid expense request id.' });
    }
    // A retried request returns the stored expense: no second deduction, slip or broadcast.
    const replay = async () => {
        const [[row]] = await pool.query('SELECT id FROM expenses WHERE created_by=? AND request_id=?', [req.user.id, requestId]);
        return row ? res.json({ success: true, expense: await readExpense(pool, row.id), print_queued: false, replayed: true }) : null;
    };

    let conn;
    try {
        if (requestId !== null && await replay()) return;
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const expense = await createExpense(conn, {
            actorId: req.user.id,
            categoryId: req.body.category_id,
            amount: req.body.amount,
            note: req.body.note,
            source: 'drawer',
            ownShiftOnly: true,
            requestId,
        });
        await conn.commit();
        conn.release();
        conn = null;
        try {
            invalidateDashboardCache();
            req.io?.to('staff').emit('expenses_changed', { expense_id: expense.id, action: 'created' });
        } catch (error) {
            logger.error({ err: error, expenseId: expense.id }, 'Expense notification failed after commit.');
        }
        const printQueued = await queueExpensePrint(req, expense, 'expense_slip', req.body.receipt_printer_id);
        return res.json({ success: true, expense, print_queued: printQueued });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY' && requestId !== null) {
            if (conn) { conn.release(); conn = null; }
            try { if (await replay()) return; } catch (replayError) { return sendError(res, replayError); }
        }
        return sendError(res, error);
    } finally {
        if (conn) conn.release();
    }
});

module.exports = router;
