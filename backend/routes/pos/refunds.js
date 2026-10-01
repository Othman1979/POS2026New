const { getConnection: getStockConnection } = require('../../services/StockReportInvalidation');
const express = require('express');
const router = express.Router();
const printRouter = require('../print');
const { requireAuth, rejectCallCenterRole } = require('../../middleware/auth');
const {
    isAdminRole: isAdminUser,
    hasRefundPermission
} = require('../../services/PermissionService');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const cache = require('../../config/cache');
const { invalidateDashboardCache } = cache;
const { sendPosError: sendError, sendPosSuccess: sendSuccess } = require('../../http/jsonResponse');
const { refundPaidOrder } = require('../../services/RefundService');
const { announceStockChanged } = require('../../services/StockEventScope');
const { voidOpenTableOrder } = require('../../modules/refunds/voidOpenTableOrder');

// POST /api/pos/refunds — void an unpaid open table or refund a paid order.
router.post('/refunds', requireAuth, rejectCallCenterRole, async (req, res) => {
    const invoiceId = Number(req.body.invoice_id);
    if (!invoiceId) return sendError(res, 400, 'invoice_id is required.');

    const itemsSupplied = Object.prototype.hasOwnProperty.call(req.body, 'items');
    if (itemsSupplied && !Array.isArray(req.body.items)) {
        return sendError(res, 400, 'items must be an array when supplied.');
    }
    const requestedItems = itemsSupplied ? req.body.items : null;
    const intent = req.body.intent;
    if (intent !== 'void' && intent !== 'refund') {
        return sendError(res, 400, 'intent is required ("void" or "refund").');
    }
    if (intent === 'refund' && !isAdminUser(req.user) && !hasRefundPermission(req.user)) {
        return sendError(res, 403, 'You do not have permission to process refunds.');
    }
    if (requestedItems && requestedItems.length === 0) {
        return sendError(res, 400, 'No items selected to refund.');
    }
    if (requestedItems) {
        const seenOrderItemIds = new Set();
        for (const item of requestedItems) {
            const orderItemId = Number(item.order_item_id);
            if (seenOrderItemIds.has(orderItemId)) {
                return sendError(res, 400, 'Each order item may only be selected once.');
            }
            seenOrderItemIds.add(orderItemId);
        }
    }

    if (intent === 'refund') {
        let paidConn;
        try {
            paidConn = await getStockConnection(pool);
            await paidConn.beginTransaction();
            const result = await refundPaidOrder(paidConn, {
                invoiceId,
                items: requestedItems,
                refundMethod: req.body.refund_method ? String(req.body.refund_method).trim() : null,
                reason: req.body.reason ? String(req.body.reason).trim() : null,
                actorId: req.user.id,
                ipAddress: req.ip || null
            });
            await paidConn.commit();
            paidConn.release();
            paidConn = null;
            if (result.stock_enabled) {
                try {
                    cache.invalidateCatalogCache();
                } catch (error) {
                    logger.error({ err: error, invoiceId, refundId: result.refund_id || null }, 'Paid refund catalog cache invalidation failed after commit.');
                }
            }
            try {
                invalidateDashboardCache();
                if (req.io) {
                    req.io.to('staff').emit('shifts_changed', {
                        shift_id: result.shift_id || null,
                        invoice_id: invoiceId
                    });
                    if (result.stock_enabled) announceStockChanged(req.io, { productIds: result.stock_product_ids, ingredientIds: result.ledger_changed_ingredient_ids, stockItemIds: result.stock_item_ids, logContext: { route: '/api/pos/refunds', method: 'POST', invoiceId, refundId: result.refund_id || null } });
                    if (result.ledger_changed_ingredient_ids?.length) {
                        req.io.to('staff').emit('ingredients_changed', {
                            ingredientIds: result.ledger_changed_ingredient_ids
                        });
                    }
                }
            } catch (error) {
                logger.error({ err: error, invoiceId, refundId: result.refund_id || null }, 'Refund notification failed after commit.');
            }
            // stock_product_ids / stock_item_ids only feed the stock event; they are not API.
            const { stock_product_ids: _stockProducts, stock_item_ids: _stockItems, ...publicResult } = result;
            return sendSuccess(res, { ...publicResult, table_freed: false });
        } catch (error) {
            if (paidConn) await paidConn.rollback().catch(() => {});
            logger.error({ err: error }, 'POST /refunds failed');
            return sendError(
                res,
                error.statusCode || 500,
                error.statusCode ? error.message : 'Refund failed.',
                error.publicCode || null
            );
        } finally {
            if (paidConn) paidConn.release();
        }
    }

    try {
        const result = await voidOpenTableOrder({
            user: req.user,
            invoiceId,
            items: requestedItems,
            expectedVersion: req.body.expected_version ?? null,
            io: req.io || null,
            ipAddress: req.ip || null,
            printKitchenOrder: (io, payload) => printRouter.printKitchenOrder(io, payload)
        });
        return sendSuccess(res, result);
    } catch (error) {
        logger.error({ err: error }, 'POST /refunds failed');
        const status = error.statusCode || 500;
        return sendError(
            res,
            status,
            status === 500 ? 'Refund failed.' : error.message,
            error.publicCode || null
        );
    }
});

module.exports = router;
