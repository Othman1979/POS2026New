const express = require('express');
const router = express.Router();
const pool = require('../../config/db');
const { createExpense, cancelExpense } = require('../../services/expenseService');
const { invalidateDashboardCache } = require('../../config/cache');
const { queueExpensePrint } = require('../../services/expensePrint');
const logger = require('../../config/logger');

function sendError(res, error) {
    const status = error.statusCode || (error.code === 'ER_DUP_ENTRY' ? 409 : 500);
    if (status === 500) logger.error({ err: error }, 'Admin expense operation failed.');
    const duplicateCategory = error.code === 'ER_DUP_ENTRY'
        ? 'An expense category with this name already exists.'
        : null;
    return res.status(status).json({
        success: false,
        message: duplicateCategory || (status === 500 ? 'Expense operation failed.' : error.message),
    });
}

router.post('/expenses', async (req, res) => {
    const source = req.body.source;
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const expense = await createExpense(conn, {
            actorId: req.user.id,
            categoryId: req.body.category_id,
            amount: req.body.amount,
            note: req.body.note,
            source,
            shiftId: req.body.shift_id,
        });
        await conn.commit();
        invalidateDashboardCache();
        req.io?.to('staff').emit('expenses_changed', { expense_id: expense.id, action: 'created' });
        const printQueued = expense.source === 'drawer'
            ? await queueExpensePrint(req, expense, 'expense_slip', req.body.receipt_printer_id)
            : false;
        return res.json({ success: true, expense, print_queued: printQueued });
    } catch (error) {
        await conn.rollback();
        return sendError(res, error);
    } finally {
        conn.release();
    }
});

router.post('/expenses/:id/cancel', async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const expense = await cancelExpense(conn, { expenseId: req.params.id, actorId: req.user.id });
        await conn.commit();
        conn.release();
        conn = null;
        try {
            invalidateDashboardCache();
            req.io?.to('staff').emit('expenses_changed', { expense_id: expense.id, action: 'canceled' });
            if (expense.shift_id !== null) {
                req.io?.to('staff').emit('shifts_changed', { shift_id: expense.shift_id, action: 'expense_canceled' });
            }
        } catch (error) {
            logger.error({ err: error, expenseId: expense.id }, 'Expense cancellation notification failed after commit.');
        }
        const printQueued = expense.source === 'drawer'
            ? await queueExpensePrint(req, expense, 'expense_cancel_slip', req.body.receipt_printer_id)
            : false;
        return res.json({ success: true, expense, print_queued: printQueued });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        return sendError(res, error);
    } finally {
        if (conn) conn.release();
    }
});

router.get('/expense-categories', async (req, res) => {
    const [categories] = await pool.query(
        'SELECT id, name, is_active, sort_order FROM expense_categories ORDER BY sort_order, name, id'
    );
    return res.json({ success: true, categories });
});

router.post('/expense-categories', async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        if (!name || name.length > 120) return res.status(400).json({ success: false, message: 'Category name is required.' });
        const sortOrder = Number.isInteger(Number(req.body.sort_order)) ? Number(req.body.sort_order) : 0;
        const [result] = await pool.query(
            'INSERT INTO expense_categories (name, sort_order, created_by) VALUES (?, ?, ?)',
            [name, sortOrder, req.user.id]
        );
        const [[category]] = await pool.query('SELECT id, name, is_active, sort_order FROM expense_categories WHERE id=?', [result.insertId]);
        return res.json({ success: true, category });
    } catch (error) {
        return sendError(res, error);
    }
});

router.put('/expense-categories/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const name = String(req.body.name || '').trim();
        if (!Number.isInteger(id) || id <= 0 || !name || name.length > 120) {
            return res.status(400).json({ success: false, message: 'A valid category name is required.' });
        }
        const sortOrder = Number.isInteger(Number(req.body.sort_order)) ? Number(req.body.sort_order) : 0;
        const active = [false, 0, '0'].includes(req.body.is_active) ? 0 : 1;
        const [result] = await pool.query(
            'UPDATE expense_categories SET name=?, sort_order=?, is_active=? WHERE id=?',
            [name, sortOrder, active, id]
        );
        if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Expense category not found.' });
        const [[category]] = await pool.query('SELECT id, name, is_active, sort_order FROM expense_categories WHERE id=?', [id]);
        return res.json({ success: true, category });
    } catch (error) {
        return sendError(res, error);
    }
});

module.exports = router;
