const express = require('express');
const router = express.Router();
const {
    pool,
    sendSuccess,
    sendError,
    logAdminRouteError,
    requireAuth,
    requireAdmin,
    REFUNDS_ROLLUP_JOIN,
    NET_TOTAL,
    NET_TAX,
    NET_CASH,
    NET_CARD,
    activeOrderDiscountApplied,
    lineSubtotalAfterOrderDiscount,
    ACTIVE_ORDER_DISCOUNT_SUMS,
    getRefundsByShift,
    invoiceIdentitySelect,
    paidOrderTimeSql,
    paidOrderWhere,
    orderBusinessTimeSql,
    refundItemsValueJoin,
    refundVoidValueSql,
    refundEventValueSql,
} = require('./helpers');
const {
    businessLocalTimestampSql,
    businessLocalDateSql,
    businessLocalHourSql,
    businessLocalHourSortSql,
    getBusinessDate,
    getBusinessDateRange
} = require('../../utils/businessDate');
const {
    getFinancialMetricsForRange,
} = require('../../services/financeMetrics');

async function sendShiftReport(req, res) {
    const date = req.query.date || getBusinessDate();
    const range = getBusinessDateRange(date, date);
    const shiftId = req.query.shift_id ? parseInt(req.query.shift_id, 10) : null;
    if (req.query.shift_id && !shiftId) {
        return sendError(res, 400, 'Invalid shift_id.');
    }

    const shiftWhere = [`s.opened_at < ? AND (
        s.opened_at >= ?
        OR EXISTS (
            SELECT 1 FROM orders so
            WHERE so.shift_id = s.id
              AND ${paidOrderTimeSql('so')} >= ? AND ${paidOrderTimeSql('so')} < ?
              AND so.payment_method NOT IN ('unpaid_table', 'voided')
        )
        OR EXISTS (
            SELECT 1 FROM refunds sr
            WHERE sr.shift_id = s.id AND sr.created_at >= ? AND sr.created_at < ?
        )
        OR EXISTS (
            SELECT 1 FROM orders svo
            WHERE svo.shift_id = s.id
              AND svo.created_at >= ? AND svo.created_at < ?
              AND svo.payment_method = 'voided'
        )
        OR EXISTS (
            SELECT 1 FROM expenses se
            WHERE se.shift_id = s.id AND se.created_at >= ? AND se.created_at < ?
        )
    )`];
    const shiftParams = [
        range.end,
        range.start,
        range.start, range.end,
        range.start, range.end,
        range.start, range.end,
        range.start, range.end,
    ];
    if (shiftId) {
        shiftWhere.push('s.id = ?');
        shiftParams.push(shiftId);
    }

    const [shiftRows] = await pool.query(`
        SELECT
            s.id AS shift_id,
            s.user_id,
            s.status,
            s.opened_at,
            s.closed_at,
            u.name AS cashier_name
        FROM shifts s
        JOIN users u ON u.id = s.user_id
        WHERE ${shiftWhere.join(' AND ')}
        ORDER BY s.opened_at ASC
    `, shiftParams);

    if (shiftRows.length === 0) {
        return sendSuccess(res, {
            mode: 'shift',
            business_date: date,
            grand_total: {
                sales_incl_tax: 0,
                order_count: 0,
                shift_count: 0,
            },
            shifts: []
        });
    }

    const shiftIds = shiftRows.map(s => s.shift_id);
    const placeholders = shiftIds.map(() => '?').join(',');
    const [orderRows] = await pool.query(`
        SELECT
            o.shift_id,
            COALESCE(SUM(o.total), 0) AS gross_sales,
            COUNT(o.invoice_id) AS order_count
        FROM orders o
        WHERE o.shift_id IN (${placeholders})
          AND ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?
          AND o.payment_method NOT IN ('unpaid_table', 'voided')
        GROUP BY o.shift_id
    `, [...shiftIds, range.start, range.end]);
    const ordersByShift = Object.fromEntries(orderRows.map(row => [row.shift_id, row]));
    const refundsByShift = await getRefundsByShift(pool, shiftIds, range);
    const currentBusinessDate = getBusinessDate();

    const shifts = shiftRows.map(s => {
        const orderAgg = ordersByShift[s.shift_id] || { gross_sales: 0, order_count: 0 };
        const refundAgg = refundsByShift[s.shift_id] || { amt: 0 };
        const openedBusinessDate = getBusinessDate(new Date(s.opened_at));
        const sales = Number(orderAgg.gross_sales || 0) - Number(refundAgg.amt || 0);
        return {
            shift_id: Number(s.shift_id),
            cashier_name: s.cashier_name,
            opened_at: s.opened_at,
            closed_at: s.closed_at,
            is_open: s.status === 'open',
            is_stale: s.status === 'open' && openedBusinessDate < currentBusinessDate,
            sales_incl_tax: Math.round(sales * 100) / 100,
            order_count: Number(orderAgg.order_count || 0),
        };
    });

    const grand = shifts.reduce((acc, s) => {
        acc.sales_incl_tax += s.sales_incl_tax;
        acc.order_count += s.order_count;
        acc.shift_count += 1;
        return acc;
    }, {
        sales_incl_tax: 0,
        order_count: 0,
        shift_count: 0,
    });
    grand.sales_incl_tax = Math.round(grand.sales_incl_tax * 100) / 100;

    return sendSuccess(res, {
        mode: 'shift',
        business_date: date,
        grand_total: grand,
        shifts
    });
}

router.get('/reports/summary', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');
        const { buildDailySummary } = require('../../services/dailyReportBuilder');
        const period = parseDailyReportPeriod({ startDate: req.query.start_date, endDate: req.query.end_date });
        return sendSuccess(res, await buildDailySummary(pool, period));
    } catch (error) {
        const status = error.statusCode || 500;
        if (status === 500) logAdminRouteError(req, error);
        return sendError(res, status, error.message);
    }
});

router.get('/reports/expenses', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');
        const { buildDailyExpenseReport } = require('../../services/dailyExpenseReportBuilder');
        const period = parseDailyReportPeriod({ startDate: req.query.start_date, endDate: req.query.end_date });
        return sendSuccess(res, await buildDailyExpenseReport(pool, period));
    } catch (error) {
        const status = error.statusCode || 500;
        if (status === 500) logAdminRouteError(req, error);
        return sendError(res, status, error.message);
    }
});

router.get('/reports/ingredients', requireAuth, requireAdmin, async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await conn.query('START TRANSACTION READ ONLY');
        const L = require('../../services/RecipeLedgerService');
        const report = await L.getDaySummary(conn, { businessDate: req.query.date });
        await conn.commit();
        return sendSuccess(res, report);
    } catch (error) {
        if (conn) await conn.rollback();
        const status = error.statusCode || 500;
        if (status === 500) logAdminRouteError(req, error);
        return sendError(res, status, error.message);
    } finally {
        conn?.release();
    }
});

router.get('/reports/product-profit', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');
        const { buildProductProfitReport } = require('../../services/productProfitReportBuilder');
        const period = parseDailyReportPeriod({ startDate: req.query.start_date, endDate: req.query.end_date });
        return sendSuccess(res, await buildProductProfitReport(pool, period));
    } catch (error) {
        const status = error.statusCode || 500;
        if (status === 500) logAdminRouteError(req, error);
        return sendError(res, status, error.message);
    }
});

router.get('/reports/sales-details', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');
        const { buildDailySalesDetails } = require('../../services/dailySalesDetailsBuilder');
        const period = parseDailyReportPeriod({ startDate: req.query.start_date, endDate: req.query.end_date });
        return sendSuccess(res, await buildDailySalesDetails(pool, period));
    } catch (error) {
        const status = error.statusCode || 500;
        if (status === 500) logAdminRouteError(req, error);
        return sendError(res, status, error.message);
    }
});

// GET /api/admin/reports
router.get('/reports', requireAuth, requireAdmin, async (req, res) => {
    try {
        const mode = req.query.mode || 'business_day';
        if (mode === 'shift') {
            return sendShiftReport(req, res);
        }
        if (mode !== 'business_day') {
            return sendError(res, 400, 'Invalid report mode.');
        }

        const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');
        const { buildDailySummary } = require('../../services/dailyReportBuilder');
        const period = parseDailyReportPeriod({
            startDate: req.query.start_date || req.query.date,
            endDate: req.query.end_date || req.query.date
        });
        const summaryData = await buildDailySummary(pool, period);

        return sendSuccess(res, {
            date: req.query.start_date && req.query.end_date ? `${req.query.start_date} to ${req.query.end_date}` : (req.query.date || getBusinessDate()),
            sales_summary: summaryData.summary,
            comparison: summaryData.comparison,
            payments: summaryData.payments,
            platform_reconciliation: summaryData.platform_reconciliation,
            order_type_mix: summaryData.order_types,
            hourly_sales: summaryData.hourly_sales,
            cash_status: summaryData.cash_status
        });
    } catch (e) {
        const status = e.statusCode || 500;
        if (status === 500) logAdminRouteError(req, e);
        sendError(res, status, e.message);
    }
});

// GET /api/admin/reports/waiters
router.get('/reports/waiters', requireAuth, requireAdmin, async (req, res) => {
    try {
        const date = req.query.date || getBusinessDate();
        const range = getBusinessDateRange(date, date);

        // 1. Summary of waiters for the date — Site 13, order-level money netted
        const [waitersSummary] = await pool.query(`
            SELECT
                u.id as waiter_id,
                u.name as waiter_name,
                COUNT(o.invoice_id) as total_tables,
                COALESCE(SUM(${NET_TOTAL}), 0) as total_sales
            FROM orders o
            JOIN users u ON o.waiter_id = u.id
            ${REFUNDS_ROLLUP_JOIN}
            WHERE o.table_id IS NOT NULL
              AND ${paidOrderTimeSql('o')} >= ?
              AND ${paidOrderTimeSql('o')} < ?
              AND o.payment_method NOT IN ('unpaid_table', 'voided')
            GROUP BY u.id
        `, [range.start, range.end]);

        // 2. Detailed orders of waiters — raw rows, no aggregation (unchanged)
        const [waiterOrders] = await pool.query(`
            SELECT
                o.invoice_id,
                o.order_id,
                ${invoiceIdentitySelect('o')},
                o.total,
                o.created_at,
                o.payment_method,
                o.waiter_id,
                t.table_number
            FROM orders o
            JOIN restaurant_tables t ON o.table_id = t.id
            WHERE o.table_id IS NOT NULL
              AND ${paidOrderTimeSql('o')} >= ?
              AND ${paidOrderTimeSql('o')} < ?
              AND o.payment_method NOT IN ('unpaid_table', 'voided')
            ORDER BY o.invoice_id DESC
        `, [range.start, range.end]);

        return sendSuccess(res, {
            date,
            summary: waitersSummary,
            orders: waiterOrders
        });
    } catch (e) {
        logAdminRouteError(req, e);
        sendError(res, 500, e.message);
    }
});

// GET /api/admin/reports/refunds — dedicated Refunds/Voids tab data.
// Attribution is by refund EVENT date (refunds.created_at), not the sale date.
router.get('/reports/refunds', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');
        const { buildRefundReport } = require('../../services/dailyRefundReportBuilder');
        const period = parseDailyReportPeriod({ startDate: req.query.start_date, endDate: req.query.end_date });
        const data = await buildRefundReport(pool, period, req.query);
        return sendSuccess(res, data);
    } catch (e) {
        logAdminRouteError(req, e);
        sendError(res, e.statusCode || 500, e.message);
    }
});

// GET /api/admin/reports/refunds/print-data — full events and items print data.
router.get('/reports/refunds/print-data', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');
        const { buildRefundPrintData } = require('../../services/dailyRefundReportBuilder');
        const period = parseDailyReportPeriod({ startDate: req.query.start_date, endDate: req.query.end_date });
        const data = await buildRefundPrintData(pool, period);
        return sendSuccess(res, data);
    } catch (e) {
        logAdminRouteError(req, e);
        sendError(res, e.statusCode || 500, e.message);
    }
});

// GET /api/admin/reports/refunds/:refundId/items — line items for one refund row (drill-down).
router.get('/reports/refunds/:refundId/items', requireAuth, requireAdmin, async (req, res) => {
    try {
        const refundId = parseInt(req.params.refundId);
        if (!refundId) return sendError(res, 400, 'Refund ID required.');
        const [[items], [orderRow]] = await Promise.all([
            pool.query(`
                SELECT ri.order_item_id, ri.product_id,
                       COALESCE(NULLIF(ri.item_name, ''), p.name, '—') AS item_name,
                       ri.note, ri.quantity, ri.unit_price, ri.line_subtotal, ri.line_tax, ri.line_total
                FROM refund_items ri
                LEFT JOIN products p ON p.id = ri.product_id
                WHERE ri.refund_id = ?
            `, [refundId]),
            pool.query(`
                SELECT o.total AS order_total, o.created_at AS order_date
                FROM refunds r JOIN orders o ON o.invoice_id = r.invoice_id
                WHERE r.id = ?
            `, [refundId])
        ]);
        return sendSuccess(res, {
            items,
            order_total: orderRow[0] ? Number(orderRow[0].order_total) : null,
            order_date: orderRow[0] ? orderRow[0].order_date : null
        });
    } catch (e) {
        logAdminRouteError(req, e);
        sendError(res, 500, e.message);
    }
});

module.exports = router;
