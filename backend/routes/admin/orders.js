const express = require('express');
const router = express.Router();
const {
    pool,
    sendSuccess,
    sendError,
    logAdminRouteError,
    invoiceIdentitySelect,
    activeOrderDiscountApplied,
} = require('./helpers');
const { getBusinessDate, getBusinessDateRange } = require('../../utils/businessDate');
const { buildOrderPresentationForRead } = require('../../services/ReceiptPresentationSources');
const { BUNDLE_ORDER_CORRUPT } = require('../../services/bundleIntegrity');
const { orderBusinessRangeBranches, activeOrderDiscountSumsSql } = require('../../services/financialSql');

// GET /api/admin/orders
router.get('/orders', async (req, res) => {
    try {
        const start_date = req.query.start_date || null;
        const end_date = req.query.end_date || null;
        const invoiceSearch = String(req.query.invoice || '').trim();
        const orderSearch = String(req.query.order || '').trim();
        const payment_methods = String(req.query.payment_methods || '').trim();
        const cashier_id = parseInt(req.query.cashier_id) || null;
        const shift_id = parseInt(req.query.shift_id) || null;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 200);
        const offset = (page - 1) * limit;
        let filterClause = "";
        const params = [];
        let dateRange = null;
        if (start_date && end_date) {
            dateRange = getBusinessDateRange(start_date, end_date);
        } else if (!invoiceSearch && !orderSearch) {
            // Default to today's orders when no explicit date range is specified and not searching by ID
            dateRange = getBusinessDateRange(getBusinessDate(), getBusinessDate());
        }
        if (invoiceSearch) {
            const val = parseInt(invoiceSearch, 10);
            if (!isNaN(val)) {
                filterClause += " AND o.invoice_number = ?";
                params.push(val);
            }
        }
        if (orderSearch) {
            const normalized = orderSearch.toUpperCase().replace(/^([A-Z]+)-?(\d+)$/, '$1-$2');
            if (/^\d+$/.test(normalized)) {
                filterClause += " AND o.order_id = ?";
                params.push(Number(normalized));
            } else if (/^[A-Z]+-\d+$/.test(normalized)) {
                const [prefix, number] = normalized.split('-');
                filterClause += ' AND o.order_id = ? AND o.order_seq_scope LIKE ?';
                params.push(Number(number), `type:%:%:${prefix}`);
            } else {
                return sendError(res, 400, 'Invalid order number.');
            }
        }
        if (payment_methods) {
            const methods = payment_methods.split(',').filter(Boolean);
            if (methods.length > 0) {
                filterClause += ` AND o.payment_method IN (${methods.map(() => '?').join(',')})`;
                params.push(...methods);
            }
        }
        if (cashier_id) {
            filterClause += " AND o.user_id = ?";
            params.push(cashier_id);
        }
        if (shift_id) {
            filterClause += " AND o.shift_id = ?";
            params.push(shift_id);
        }

        const totalAmount = parseFloat(req.query.total);
        if (Number.isFinite(totalAmount)) {
            filterClause += " AND ABS(o.total - ?) < 0.005";
            params.push(totalAmount);
        }

        const filterType = String(req.query.filter_type || '').trim();
        if (filterType === 'tables') {
            filterClause += " AND o.table_id IS NOT NULL";
        } else if (filterType === 'register') {
            filterClause += " AND o.table_id IS NULL";
        }

        const refundStatus = String(req.query.refund_status || '').trim();
        if (['none', 'partial', 'full'].includes(refundStatus)) {
            filterClause += " AND o.refund_status = ?";
            params.push(refundStatus);
        }

        const jofotaraStatus = String(req.query.jofotara_status || '').trim();
        if (jofotaraStatus === 'not_submitted') {
            filterClause += ` AND NOT EXISTS (
                SELECT 1 FROM jofotara_documents jdf
                WHERE jdf.source_key = CONCAT('invoice:', o.invoice_id)
            )`;
        } else if (jofotaraStatus === 'accepted') {
            filterClause += ` AND EXISTS (
                SELECT 1 FROM jofotara_documents jdf
                WHERE jdf.source_key = CONCAT('invoice:', o.invoice_id)
                  AND jdf.status = 'accepted'
            )`;
        } else if (jofotaraStatus === 'needs_attention') {
            filterClause += ` AND EXISTS (
                SELECT 1 FROM jofotara_documents jdf
                WHERE jdf.source_key = CONCAT('invoice:', o.invoice_id)
                  AND jdf.status IN ('pending', 'submitting', 'rejected', 'unknown')
            )`;
        }

        const discounted = req.query.discounted === '1';
        if (discounted) {
            filterClause += ` AND (
                (o.discount_type IS NOT NULL AND o.discount_value > 0)
                OR EXISTS (
                  SELECT 1 FROM order_items oi
                  WHERE oi.invoice_id = o.invoice_id
                    AND oi.parent_item_id IS NULL
                    AND oi.discount_type IS NOT NULL AND oi.discount_value > 0
                )
            )`;
        }

        const dateBranches = dateRange ? orderBusinessRangeBranches('o') : ['1=1'];
        const candidateOrders = dateBranches.map(predicate => `
            SELECT o.invoice_id, o.total, o.payment_method FROM orders o
            WHERE ${predicate} ${filterClause}
        `).join(' UNION ALL ');
        const statsParams = dateBranches.flatMap(() => dateRange
            ? [dateRange.start, dateRange.end, ...params] : params);

        // Revenue is NET of refunds: each order contributes (total - amount refunded against it),
        // and voided orders (cancelled, money never collected) contribute nothing. The refund is
        // attributed to the original sale's payment bucket so gross and net stay on the same axis.
        const [statsRows] = await pool.query(`
            WITH candidate_orders AS (${candidateOrders}), refunds_by_order AS (
                SELECT r.invoice_id, SUM(r.amount_refunded) AS refunded
                FROM refunds r
                JOIN candidate_orders co ON co.invoice_id = r.invoice_id
                WHERE r.kind = 'refund' GROUP BY r.invoice_id
            )
            SELECT
                COUNT(*) as total,
                COALESCE(SUM(CASE WHEN o.payment_method = 'voided' THEN 0 ELSE o.total - COALESCE(rf.refunded, 0) END), 0) as total_revenue,
                COALESCE(SUM(CASE WHEN o.payment_method = 'cash' THEN o.total - COALESCE(rf.refunded, 0) ELSE 0 END), 0) as cash_revenue,
                COALESCE(SUM(CASE WHEN o.payment_method = 'card' THEN o.total - COALESCE(rf.refunded, 0) ELSE 0 END), 0) as card_revenue,
                COALESCE(SUM(CASE WHEN o.payment_method = 'platform' THEN o.total - COALESCE(rf.refunded, 0) ELSE 0 END), 0) as platform_revenue,
                COALESCE(SUM(CASE WHEN o.payment_method = 'split' THEN o.total - COALESCE(rf.refunded, 0) ELSE 0 END), 0) as split_revenue
            FROM candidate_orders o
            LEFT JOIN refunds_by_order rf ON rf.invoice_id = o.invoice_id
        `, statsParams);
        const stats = statsRows[0];

        const queryStr = `
            WITH candidate_orders AS (${candidateOrders}), page_orders AS (
                SELECT o.* FROM orders o
                JOIN candidate_orders selected ON selected.invoice_id = o.invoice_id
                ORDER BY o.invoice_id DESC LIMIT ? OFFSET ?
            )
            SELECT o.invoice_id, o.order_id, ${invoiceIdentitySelect('o')}, o.created_at, o.total, o.payment_method, o.refund_status,
                   ${activeOrderDiscountApplied('o', 'ads')} AS order_discount_amount,
                   COALESCE(ads.line_discount_amount, 0) AS line_discount_amount,
                   u.name as cashier_name,
                   COALESCE(jd.status, 'not_submitted') AS jofotara_status,
                   jrs.jofotara_return_status,
                   (jd.status = 'accepted' AND jd.qr_text IS NOT NULL) AS jofotara_has_qr
            FROM page_orders o
            LEFT JOIN users u ON o.user_id = u.id
            LEFT JOIN jofotara_documents jd ON jd.source_key = CONCAT('invoice:', o.invoice_id)
            LEFT JOIN (
                SELECT r.invoice_id,
                       CASE
                           WHEN SUM(CASE WHEN rd.status = 'unknown' THEN 1 ELSE 0 END) > 0 THEN 'unknown'
                           WHEN SUM(CASE WHEN rd.status = 'rejected' THEN 1 ELSE 0 END) > 0 THEN 'rejected'
                           WHEN SUM(CASE WHEN rd.status = 'submitting' THEN 1 ELSE 0 END) > 0 THEN 'submitting'
                           WHEN SUM(CASE WHEN rd.status = 'pending' THEN 1 ELSE 0 END) > 0 THEN 'pending'
                           WHEN SUM(CASE WHEN rd.id IS NULL THEN 1 ELSE 0 END) > 0 THEN 'not_submitted'
                           WHEN COUNT(*) = SUM(CASE WHEN rd.status = 'accepted' THEN 1 ELSE 0 END) THEN 'accepted'
                           ELSE 'unknown'
                       END AS jofotara_return_status
                FROM refunds r
                JOIN page_orders refund_scope ON refund_scope.invoice_id = r.invoice_id
                LEFT JOIN jofotara_documents rd ON rd.source_key = CONCAT('refund:', r.id)
                WHERE r.kind = 'refund'
                GROUP BY r.invoice_id
            ) jrs ON jrs.invoice_id = o.invoice_id
            LEFT JOIN ${activeOrderDiscountSumsSql('page_orders')} ads ON ads.invoice_id = o.invoice_id
            ORDER BY o.invoice_id DESC
        `;
        const queryParams = [...statsParams, limit, offset];

        const [orders] = await pool.query(queryStr, queryParams);

        return sendSuccess(res, {
            orders,
            pagination: {
                total: parseInt(stats.total),
                page: page,
                limit: limit,
                total_pages: Math.ceil(stats.total / limit)
            },
            stats: {
                total_revenue: parseFloat(stats.total_revenue),
                cash_revenue: parseFloat(stats.cash_revenue),
                card_revenue: parseFloat(stats.card_revenue),
                platform_revenue: parseFloat(stats.platform_revenue),
                split_revenue: parseFloat(stats.split_revenue)
            }
        });
    } catch (e) {
        logAdminRouteError(req, e);
        sendError(res, 500, e.message);
    }
});

// GET /api/admin/order_details?id=X
router.get('/order_details', async (req, res) => {
    try {
        const invoice_id = req.query.id;
        if (!invoice_id) return sendError(res, 400, "Invoice ID required.");

        const [orders] = await pool.query(`
            SELECT o.*, ${invoiceIdentitySelect('o')}, u.name as cashier_name, ot.name as order_type_name,
                   c.name as customer_name, c.phone as customer_phone, c.address as customer_address
            FROM orders o
            LEFT JOIN users u ON o.user_id = u.id
            LEFT JOIN order_types ot ON o.order_type_id = ot.id
            LEFT JOIN customers c ON o.customer_id = c.id
            WHERE o.invoice_id = ?
        `, [invoice_id]);

        if (orders.length === 0) return sendError(res, 404, "Order not found.");

        // refunded_quantity = units already returned per line, so the refund UI can show
        // (and cap to) the remaining refundable quantity instead of relying on a 400.
        const [items] = await pool.query(`
            SELECT oi.*, COALESCE(oi.item_name, p.name) as product_name, oi.tax_rate,
                   p.price_override_locked,
                   COALESCE(rfi.refunded_qty, 0) AS refunded_quantity
            FROM order_items oi
            LEFT JOIN products p ON oi.product_id = p.id
            LEFT JOIN (
                SELECT ri.order_item_id, SUM(ri.quantity) AS refunded_qty
                FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
                WHERE r.kind = 'refund'
                GROUP BY ri.order_item_id
            ) rfi ON rfi.order_item_id = oi.id
            WHERE oi.invoice_id = ?
        `, [invoice_id]);

        const order = orders[0];
        const [[jofotara]] = await pool.query(
            "SELECT document_uuid, qr_text FROM jofotara_documents WHERE source_key = ? AND status = 'accepted' LIMIT 1",
            [`invoice:${invoice_id}`]
        );
        if (jofotara) order.jofotara = { status: 'accepted', uuid: jofotara.document_uuid, qrText: jofotara.qr_text };
        const resRead = buildOrderPresentationForRead({ order, items });
        const [refunds] = await pool.query(
            "SELECT id, amount_refunded, reason, created_at FROM refunds WHERE invoice_id = ? AND kind = 'refund' ORDER BY id",
            [invoice_id]
        );
        const responsePayload = { order, items, refunds };
        if (resRead.presentation) {
            responsePayload.receipt_display_v1 = resRead.presentation;
        } else {
            responsePayload.receipt_display_legacy_reason = resRead.legacyReason;
        }
        return sendSuccess(res, responsePayload);
    } catch (e) {
        if (e.publicCode === BUNDLE_ORDER_CORRUPT) {
            logAdminRouteError(req, e);
            return res.status(e.statusCode || 409).json({
                success: false,
                message: e.message,
                publicCode: e.publicCode
            });
        }
        if (e.statusCode === 422) {
            return res.status(422).json({ success: false, message: e.message, publicCode: e.publicCode });
        }
        logAdminRouteError(req, e);
        sendError(res, 500, e.message);
    }
});

module.exports = router;
