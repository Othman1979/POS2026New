const express = require('express');
const router = express.Router();
const { zonedLocalTimeToDate, formatDbTimestamp, addBusinessDays } = require('../../utils/businessDate');
const { isValidDateOnly } = require('../../services/dailyReportPeriod');
const { 
    pool, 
    sendSuccess, 
    sendError, 
    logAdminRouteError,
    requireAdmin,
    parsePagination
} = require('./helpers');

// GET /api/admin/audit
router.get('/audit', requireAdmin, async (req, res) => {
    try {
        const { page, limit, offset } = parsePagination(req.query);
        const eventType = req.query.event_type || null;
        const startDate = req.query.start_date || null;
        const endDate   = req.query.end_date   || null;

        if ((startDate && !isValidDateOnly(startDate)) || (endDate && !isValidDateOnly(endDate)) || (startDate && endDate && startDate > endDate)) return sendError(res, 400, 'Choose a valid date range.');
        const where = [];
        const params = [];
        if (eventType) { where.push('ae.event_type = ?');          params.push(eventType); }
        if (startDate) { where.push('ae.created_at >= ?');         params.push(formatDbTimestamp(zonedLocalTimeToDate(startDate))); }
        if (endDate)   { where.push('ae.created_at < ?');         params.push(formatDbTimestamp(zonedLocalTimeToDate(addBusinessDays(endDate, 1)))); }
        const entityType = req.query.entity_type || null;
        if (entityType) { where.push('ae.entity_type = ?'); params.push(entityType); }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total FROM audit_events ae ${whereSql}`, params
        );

        const [events] = await pool.query(`
            SELECT ae.*,
                   u.name as user_name,  u.role as user_role,
                   m.name as manager_name
            FROM audit_events ae
            LEFT JOIN users u ON ae.user_id  = u.id
            LEFT JOIN users m ON ae.manager_id = m.id
            ${whereSql}
            ORDER BY ae.created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        return sendSuccess(res, {
            events,
            pagination: {
                total: Number(total),
                page,
                limit,
                total_pages: Math.max(1, Math.ceil(Number(total) / limit))
            }
        });
    } catch (e) {
        logAdminRouteError(req, e);
        return sendError(res, 500, 'Audit log fetch failed.');
    }
});

// GET /api/admin/audit/price-history
router.get('/audit/price-history', requireAdmin, async (req, res) => {
    try {
        const productId = req.query.product_id ? parseInt(req.query.product_id, 10) : null;
        const where  = productId ? 'WHERE ph.product_id = ?' : '';
        const params = productId ? [productId] : [];

        const [rows] = await pool.query(`
            SELECT ph.*, p.name as product_name, u.name as changed_by_name
            FROM price_history ph
            LEFT JOIN products p ON ph.product_id = p.id
            LEFT JOIN users u    ON ph.changed_by  = u.id
            ${where}
            ORDER BY ph.changed_at DESC
            LIMIT 500
        `, params);

        return sendSuccess(res, { history: rows });
    } catch (e) {
        logAdminRouteError(req, e);
        return sendError(res, 500, 'Price history fetch failed.');
    }
});

module.exports = router;
