const express = require('express');
const router = express.Router();
const { requireAuth, rejectCallCenterRole } = require('../../middleware/auth');
const { normalizeCheckoutAttemptKey, findOwnedCheckoutAttempt } = require('../../services/CheckoutAttemptService');
const { appendAuditEvent } = require('../../services/auditEvents');
const { executeCheckout } = require('../../modules/checkout/executeCheckout');
const { authorizeManagerOverride } = require('../../services/ManagerOverrideService');
const { CHECKOUT_APPROVAL_ACTIONS } = require('../../config/permissionPolicy.cjs');
const { enqueuePrintJobs, selectReceiptPrinter } = require('../../services/printDispatch');
const { sanitizePrintString } = require('../../services/printText');
const { commitAndPublishSpoolerSyncWake } = require('../../services/spoolerSyncWake');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { sendPosSuccess: sendSuccess, sendPosError: sendError } = require('../../http/jsonResponse');
const { createKeyedRateLimiter, actorKey } = require('../../middleware/rateLimit');
const {
    prepareCheckoutInvoiceIfAutomatic, submitCheckoutInvoiceIfAutomatic, getCheckoutInvoiceState
} = require('../../services/JofotaraService');

// 30/minute per device (then per user) is far above a real terminal, which cannot
// physically complete a checkout every two seconds. The optional override exists only
// so a Supertest suite — which drives hundreds of checkouts as one actor as fast as it
// can — does not rate-limit itself; it is not operator configuration and appears in no
// env template. Production leaves it unset and gets 30.
const checkoutRateLimit = createKeyedRateLimiter({
    windowMs: 60 * 1000,
    max: Number(process.env.CHECKOUT_RATE_LIMIT_MAX || 30),
    message: 'Too many checkout requests. Please try again in a minute.',
    keyForRequest: actorKey,
});

// POST /api/pos/checkout
router.post('/checkout', requireAuth, rejectCallCenterRole, checkoutRateLimit, async (req, res) => {
    const data = req.body;
    if (data?.subscription_purchase != null) {
        return sendError(res, 410, 'Subscriptions are no longer available.', 'SUBSCRIPTIONS_RETIRED');
    }
    if (!data || !Array.isArray(data.cart) || data.cart.length === 0) {
        return sendError(res, 400, "Cart is empty.");
    }

    const editInvoiceId = data.edit_invoice_id || null;
    if (editInvoiceId && (!Number.isInteger(Number(editInvoiceId)) || Number(editInvoiceId) <= 0)) {
        return sendError(res, 400, "Invalid edit_invoice_id.");
    }
    if (data.shift_id && (!Number.isInteger(Number(data.shift_id)) || Number(data.shift_id) <= 0)) {
        return sendError(res, 400, "Invalid shift_id.");
    }
    if (data.table_id && (!Number.isInteger(Number(data.table_id)) || Number(data.table_id) <= 0)) {
        return sendError(res, 400, "Invalid table_id.");
    }
    if (data.order_type_id && (!Number.isInteger(Number(data.order_type_id)) || Number(data.order_type_id) <= 0)) {
        return sendError(res, 400, "Invalid order_type_id.");
    }
    try {
        data.idempotency_key = normalizeCheckoutAttemptKey(data.idempotency_key);
    } catch (error) {
        return sendError(res, error.statusCode || 400, error.message);
    }

    try {
        const result = await executeCheckout({
            user: req.user,
            input: data,
            heldOrderContext: data.held_order_context || null,
            io: req.io,
            ipAddress: req.ip || null,
            authorizeManagerOverride: async (managerPin, executor) => {
                const result = await authorizeManagerOverride({
                    user: req.user,
                    managerPin,
                    actions: CHECKOUT_APPROVAL_ACTIONS,
                    executor,
                    ipAddress: req.ip || req.socket?.remoteAddress || null,
                    route: req.originalUrl
                });
                req.auditManagerId = result.managerId || null;
                return result;
            }
        });
        try {
            result.jofotara = await prepareCheckoutInvoiceIfAutomatic({ invoiceId: result.invoice_id, actorUserId: req.user.id });
        } catch (fiscalError) {
            logger.error({ err: fiscalError, invoiceId: result.invoice_id, publicCode: fiscalError.publicCode }, 'JoFotara checkout preparation failed after payment commit.');
            result.jofotara = { required: true, status: 'preparation_failed', code: fiscalError.publicCode || 'JOFOTARA_PREPARATION_FAILED' };
        }
        return sendSuccess(res, result);
    } catch (e) {
        logger.error({
            err: e,
            route: req.originalUrl,
            method: req.method,
            userId: req.user?.id,
            role: req.user?.role,
            invoiceId: data.edit_invoice_id || null,
            tableId: data.table_id || null,
            shiftId: data.shift_id || null,
            paymentMethod: data.payment_method,
            idempotencyKey: data.idempotency_key || null
        }, 'Checkout failed.');
        let status = e.statusCode || (e.message?.startsWith('Forbidden:') ? 403 : (e.message?.startsWith('Conflict:') ? 409 : 500));
        const isDbError = !!(e.errno || e.sqlState || e.sql || String(e.code || '').startsWith('ER_'));
        if (status === 500 && !isDbError && (
            e.message?.includes('mismatch') ||
            e.message?.includes('required') ||
            e.message?.includes('Forbidden') ||
            e.message?.includes('less than') ||
            e.message?.includes('negative') ||
            e.message?.includes('payment method')
        )) status = 400;
        const msg = (status !== 500 && !isDbError)
            ? e.message
            : 'Checkout failed. Please try again and contact support if the issue persists.';
        return sendError(res, status, msg, e.publicCode || null);
    }
});

router.post('/checkout/jofotara', requireAuth, rejectCallCenterRole, checkoutRateLimit, async (req, res) => {
    let key;
    try { key = normalizeCheckoutAttemptKey(req.body?.idempotency_key); }
    catch (error) { return sendError(res, error.statusCode || 400, error.message); }
    try {
        if (!key) return sendError(res, 400, 'A checkout idempotency key is required.');
        const attempt = await findOwnedCheckoutAttempt(pool, { key, userId: req.user.id });
        if (!attempt) return sendError(res, 404, 'Checkout attempt not found.');
        const fiscal = await submitCheckoutInvoiceIfAutomatic({ invoiceId: attempt.invoice_id, actorUserId: req.user.id });
        return sendSuccess(res, fiscal);
    } catch (error) {
        if (error.statusCode) return sendError(res, error.statusCode, error.message, error.publicCode || null);
        logger.error({ err: error, userId: req.user?.id }, 'JoFotara checkout finalization failed.');
        return sendError(res, 500, 'JoFotara finalization failed.');
    }
});

router.post('/checkout/jofotara/status', requireAuth, rejectCallCenterRole, checkoutRateLimit, async (req, res) => {
    let key;
    try { key = normalizeCheckoutAttemptKey(req.body?.idempotency_key); }
    catch (error) { return sendError(res, error.statusCode || 400, error.message); }
    try {
        if (!key) return sendError(res, 400, 'A checkout idempotency key is required.');
        const attempt = await findOwnedCheckoutAttempt(pool, { key, userId: req.user.id });
        if (!attempt) return sendError(res, 404, 'Checkout attempt not found.');
        return sendSuccess(res, await getCheckoutInvoiceState(attempt.invoice_id));
    } catch (error) {
        if (error.statusCode) return sendError(res, error.statusCode, error.message, error.publicCode || null);
        logger.error({ err: error, userId: req.user?.id }, 'JoFotara checkout status lookup failed.');
        return sendError(res, 500, 'JoFotara status lookup failed.');
    }
});

// POST /api/pos/log_drawer_pop
router.post('/log_drawer_pop', requireAuth, rejectCallCenterRole, async (req, res) => {
    if (!['cashier', 'admin', 'programmer'].includes(req.user.role)) {
        return sendError(res, 403, 'Forbidden: You cannot open the cash drawer.');
    }

    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const [printers] = await conn.query("SELECT * FROM printers WHERE role = 'receipt' AND is_active = 1");
        const printer = selectReceiptPrinter(printers, { printerId: req.body?.receipt_printer_id });
        if (!printer) {
            const error = new Error('No receipt printer found.');
            error.statusCode = 400;
            throw error;
        }

        const reason = 'No sale / Manual drawer open';
        if (req.user.role === 'cashier') {
            await appendAuditEvent(conn, {
                eventType: 'drawer_pop',
                userId: req.user.id,
                newValue: { reason, printer_id: printer.id },
                ipAddress: req.ip || null
            });
        }

        await enqueuePrintJobs(conn, [{
            printer_id: printer.id,
            printer_name: sanitizePrintString(printer.windows_name, 200),
            printer_type: printer.type,
            network_ip: printer.network_ip,
            network_port: printer.network_port,
            status_capability: printer.status_capability || 'write_only',
            print_type: 'cash_drawer',
            data: {
                requested_by_user_id: req.user.id,
                reason
            }
        }]);
        await commitAndPublishSpoolerSyncWake(conn);

        logger.warn({
            event: 'no_sale_drawer_pop',
            cashier_id: req.user.id,
            cashier_name: req.user.name,
            role: req.user.role,
            printer_id: printer.id
        }, 'No Sale: cash drawer pulse queued');

        return sendSuccess(res, { message: 'Cash drawer pulse queued.', printer_id: printer.id });
    } catch (e) {
        await conn?.rollback().catch(() => {});
        if (!e.statusCode) logger.error({ err: e }, 'Cash drawer request failed');
        return sendError(
            res,
            e.statusCode || 500,
            e.statusCode ? e.message : 'Failed to open cash drawer.'
        );
    } finally {
        conn?.release();
    }
});

module.exports = router;
