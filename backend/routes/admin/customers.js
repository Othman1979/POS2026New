const express = require('express');
const router = express.Router();
const {
    pool,
    sendSuccess,
    sendError,
    logAdminRouteError,
    REFUNDS_ROLLUP_JOIN,
    NET_TOTAL
} = require('./helpers');
const { normalizeCustomerPhone } = require('../../services/customerPhone');

async function withCustomerPhoneLock(normalizedPhone, action) {
    let conn = await pool.getConnection();
    const lockName = `posapp:customer:${normalizedPhone}`;
    let ownsLock = false;
    try {
        // Named locks are server-wide; hash the database scope to fit MySQL's 64-character limit.
        const [[lock]] = await conn.query("SELECT GET_LOCK(SHA2(CONCAT(DATABASE(), ':', ?), 256), 5) AS acquired", [lockName]);
        if (Number(lock?.acquired) !== 1) {
            const error = new Error('This customer is being updated by another request. Try again.');
            error.statusCode = 503;
            error.publicCode = 'CUSTOMER_PHONE_BUSY';
            throw error;
        }
        ownsLock = true;
        return await action(conn);
    } finally {
        if (ownsLock && conn) {
            try {
                await conn.query("SELECT RELEASE_LOCK(SHA2(CONCAT(DATABASE(), ':', ?), 256)) AS released", [lockName]);
            } catch (_) {
                // A pooled connection must never retain a session-level advisory lock.
                try { conn.destroy(); } catch (_) { /* connection is already unusable */ }
                conn = null;
            }
        }
        if (conn) conn.release();
    }
}

// ALL /api/admin/customers
router.all('/customers', async (req, res) => {
    try {
        if (req.method === 'GET') {
            const search = String(req.query.search || '').trim();
            const where = [];
            const params = [];
            if (search) {
                where.push("(c.name LIKE ? OR c.phone LIKE ?)");
                const q = `%${search}%`;
                params.push(q, q);
            }
            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
            const offset = (page - 1) * limit;
            const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total FROM customers c ${whereSql}`, params);

            const [customers] = await pool.query(`
                SELECT c.id, c.name, c.phone, c.address,
                       COUNT(o.invoice_id) as total_orders,
                       COALESCE(SUM(${NET_TOTAL}), 0) as total_spent
                FROM customers c
                LEFT JOIN orders o ON c.id = o.customer_id AND o.payment_method NOT IN ('unpaid_table', 'voided')
                ${REFUNDS_ROLLUP_JOIN}
                ${whereSql}
                GROUP BY c.id
                ORDER BY c.id DESC
                LIMIT ? OFFSET ?
            `, [...params, limit, offset]);

            const total = Number(countRow?.total || 0);
            return sendSuccess(res, {
                customers,
                pagination: {
                    total,
                    page,
                    limit,
                    total_pages: Math.max(1, Math.ceil(total / limit))
                }
            });
        }
        else if (req.method === 'POST') {
            const name = String(req.body.name || '').trim();
            const rawPhone = String(req.body.phone || '').trim();
            const address = String(req.body.address || '').trim();
            if (!name || !rawPhone) return sendError(res, 400, "Name and phone are required.");
            const phone = normalizeCustomerPhone(rawPhone);

            const result = await withCustomerPhoneLock(phone, async (conn) => {
                const [check] = await conn.query(
                    "SELECT id FROM customers WHERE phone_normalized = ? ORDER BY id ASC LIMIT 1",
                    [phone]
                );
                if (check.length > 0) return null;

                const [insert] = await conn.query(
                    "INSERT INTO customers (name, phone, address) VALUES (?, ?, ?)",
                    [name, phone, address || null]
                );
                return insert;
            });
            if (!result) return sendError(res, 400, "Phone number already exists.");
            return sendSuccess(res, { message: "Customer created successfully.", id: result.insertId });
        }
        else if (req.method === 'PUT') {
            const id = req.body.id;
            const name = String(req.body.name || '').trim();
            const rawPhone = String(req.body.phone || '').trim();
            const address = String(req.body.address || '').trim();
            if (!id) return sendError(res, 400, "Customer id is required.");
            if (!name || !rawPhone) return sendError(res, 400, "Name and phone are required.");
            const phone = normalizeCustomerPhone(rawPhone);

            const updated = await withCustomerPhoneLock(phone, async (conn) => {
                const [check] = await conn.query(
                    "SELECT id FROM customers WHERE phone_normalized = ? AND id != ? ORDER BY id ASC LIMIT 1",
                    [phone, id]
                );
                if (check.length > 0) return false;

                await conn.query(
                    "UPDATE customers SET name = ?, phone = ?, address = ? WHERE id = ?",
                    [name, phone, address || null, id]
                );
                return true;
            });
            if (!updated) return sendError(res, 400, "Phone number already used by another customer.");
            return sendSuccess(res, { message: "Customer updated." });
        }
        else if (req.method === 'DELETE') {
            const { id } = req.body;
            // Let the FK check and row lock decide atomically. A separate order
            // precheck can become stale while a concurrent checkout commits.
            try {
                await pool.query("DELETE FROM customers WHERE id = ?", [id]);
            } catch (error) {
                if (error.code !== 'ER_ROW_IS_REFERENCED_2' && error.errno !== 1451) throw error;
                return sendError(res, 400, "Cannot delete a customer who has existing orders. Please edit their info instead.");
            }
            return sendSuccess(res, { message: "Customer removed." });
        }
        else {
            return sendError(res, 405, "Method not allowed.");
        }
    } catch (e) {
        logAdminRouteError(req, e);
        sendError(res, e.statusCode || 500, e.message, e.publicCode || null);
    }
});

module.exports = router;
