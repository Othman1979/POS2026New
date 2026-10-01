const { formatOrderNumber } = require('../../utils/orderNumber');
const { getConnection: getStockConnection } = require('../../services/StockReportInvalidation');
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth, rejectCallCenterRole } = require('../../middleware/auth');
const {
    canHoldOrders,
    canCheckout,
    canViewOrders,
    isAdminRole: isAdminUser,
    isCallCenterRole,
    canApplyServiceCharge,
    canTaxExempt,
    userCanAccessOrderForPrint
} = require('../../services/PermissionService');
const pool = require('../../config/db');
const { normalizeScheduledDateTime, businessLocalTimestampSql } = require('../../utils/businessDate');
const logger = require('../../config/logger');
const { sendPosSuccess: sendSuccess, sendPosError: sendError } = require('../../http/jsonResponse');
const { emitHeldOrdersChanged } = require('../../services/HeldOrderEvents');
const { normalizeCartItems, calculateLineTotal, calculateLineSubtotal } = require('../../services/PosCalculator');
const { executeCheckout } = require('../../modules/checkout/executeCheckout');

// Table split identity is server-owned. The human reference is display text only.
const isRegisterHold = (row) => !!(row && row.parent_invoice_id == null && row.table_id == null);
const { buildOrderPresentationForRead, buildHeldPresentations } = require('../../services/ReceiptPresentationSources');
const { fetchCartProducts } = require('../../services/InventoryService');
const { applyDatabasePrices, loadCheckoutSettings } = require('../../services/OrderPricing');
const { canonicalizeServiceCharge } = require('../../services/ServiceChargeCalculator');
const { calculateExpectedTotals, validateTaxRate, buildSelectedModifiersSnapshot, computeModifierSurcharge, deriveModifierTaxAmount, resolveEffectiveTaxRate } = require('../../services/PosCalculator');
const {
    TAX_REGISTRATION_TYPES,
    normalizeTaxRegistrationType
} = require('../../config/taxRegistration');
const {
    getForUpdate,
    assertDraftUsableBy,
    bindDraft,
    claimHeld,
    consumeClaim,
    transition: transitionServiceChargeSnapshot
} = require('../../services/ServiceChargeSnapshotService');
const { buildOrderIdentity } = require('../../utils/orderIdentity');
const { normalizeKitchenTicketItems } = require('../../services/kitchenTicketItems');
const { expandBundlesForKitchen, filterRoutableKitchenLines } = require('../../services/kitchenPrintRouting');
const {
    queueHeldKitchenRound,
    queueHeldKitchenChanges,
    assignStableHeldLineIds,
    parseKitchenSnapshot,
    kitchenBaselineKnown,
    readItemsFromHeldRow,
    computePositiveKitchenDelta,
    buildHeldKitchenBaseline,
    queueHeldKitchenCancellation,
    dispatchError: heldKitchenError
} = require('../../services/HeldOrderKitchenDispatch');
const { commitAndPublishSpoolerSyncWake } = require('../../services/spoolerSyncWake');

const { attachRegisterPrices } = require('../../services/categoryPriceLists');
const { appendAuditEvent } = require('../../services/auditEvents');
const heldLifecycle = require('../../services/HeldOrderLifecycleService');
const { ensureHeldOrderNumber } = require('../../services/HeldOrderNumber');
const { prepareHeldCustomerReceipt } = require('../../services/HeldOrderReceipt');
const { validateBundleCartLines, canonicalizeBundleCartLines } = require('../../services/bundleOrderItems');
const { normalizeCustomerPhone } = require('../../services/customerPhone');
const { canonicalizeHeldCart } = require('../../services/HeldOrderCanonicalizer');
const {
    BUNDLE_ORDER_CORRUPT,
    bundleOrderCorruptionError,
    assertHeldItemStructure,
    assertOrderItemBundleIntegrity,
    assertNestedBundleIntegrity
} = require('../../services/bundleIntegrity');

const CALL_CENTER_FORBIDDEN_TOP_LEVEL = [
    'payment_method', 'amount_tendered', 'cash_amount', 'card_amount', 'change_due',
    'shift_id', 'edit_invoice_id', 'table_id', 'split_check_id', 'parent_invoice_id',
    'subscription_purchase', 'manager_pin', 'manager_override', 'idempotency_key'
];
const CALL_CENTER_FORBIDDEN_CART_FIELDS = [
    'payment_method', 'amount_tendered', 'cash_amount', 'card_amount', 'change_due',
    'shift_id', 'edit_invoice_id', 'table_id', 'split_check_id', 'parent_invoice_id',
    'subscription_purchase', 'manager_pin', 'manager_override', 'tax_exempt',
    'tax_exempt_at_hold', 'service_charge_snapshot', 'checkout', 'checkout_state',
    'call_center_user_id'
];
const CALL_CENTER_FORBIDDEN_LINE_FIELDS = [
    'discount_type', 'discount_value', 'discountType', 'discountValue',
    'manual_price_override', 'price_before_override', 'original_price'
];

function hasAuthorityValue(value) {
    if (value == null || value === false || value === '' || value === 0 || value === '0') return false;
    if (Array.isArray(value)) return value.some(hasAuthorityValue);
    if (typeof value === 'object') return Object.values(value).some(hasAuthorityValue);
    return true;
}

function callCenterError(message, statusCode, publicCode) {
    return Object.assign(new Error(message), { statusCode, publicCode });
}

function assertCallCenterInitialPayload(data, cartPayload) {
    for (const key of CALL_CENTER_FORBIDDEN_TOP_LEVEL) {
        if (hasAuthorityValue(data?.[key])) throw callCenterError('Phone orders cannot contain payment or checkout authority.', 400, 'CALL_CENTER_FINANCIAL_FIELD_FORBIDDEN');
    }
    if (data?.tax_exempt === true || hasAuthorityValue(data?.service_charge_snapshot)) {
        throw callCenterError('Phone orders cannot contain tax or service-charge authority.', 400, 'CALL_CENTER_FINANCIAL_FIELD_FORBIDDEN');
    }
    for (const key of CALL_CENTER_FORBIDDEN_CART_FIELDS) {
        if (hasAuthorityValue(cartPayload?.[key])) throw callCenterError('Phone orders cannot contain financial authority.', 400, 'CALL_CENTER_FINANCIAL_FIELD_FORBIDDEN');
    }
    if (hasAuthorityValue(cartPayload?.order_discount)) {
        throw callCenterError('Phone orders cannot contain a discount.', 400, 'CALL_CENTER_FINANCIAL_FIELD_FORBIDDEN');
    }
    for (const item of cartPayload?.items || []) {
        if (item?.note === 'Auto-Gratuity') throw callCenterError('Phone orders cannot add a service charge.', 400, 'CALL_CENTER_FINANCIAL_FIELD_FORBIDDEN');
        for (const key of CALL_CENTER_FORBIDDEN_LINE_FIELDS) {
            if (hasAuthorityValue(item?.[key])) throw callCenterError('Phone orders cannot contain line discounts or price overrides.', 400, 'CALL_CENTER_FINANCIAL_FIELD_FORBIDDEN');
        }
    }
}

function stableAuthorityValue(value) {
    return JSON.stringify(stableHoldRequestValue(value == null ? null : value));
}

function normalizeHeldDeliveryDate(value, publicCode = 'HELD_DELIVERY_DATE_INVALID') {
    return normalizeScheduledDateTime(value, publicCode);
}

function shouldAutoFireHeldOrder(cartPayload) {
    return cartPayload?.delivery_date == null || String(cartPayload.delivery_date).trim() === '';
}

async function queueAutomaticHeldKitchenRound({ db, heldOrder, items, operationId }) {
    const sequence = Number(heldOrder?.kitchen_dispatch_version || 0) + 1;
    const normalizedItems = await normalizeKitchenTicketItems(items, {
        db,
        linePrefix: `held-${heldOrder.id}`
    });
    const assigned = assignStableHeldLineIds(normalizedItems, {
        heldId: heldOrder.id,
        mode: 'initial'
    });
    try {
        const round = await queueHeldKitchenRound({
            db,
            heldOrder,
            items: assigned.items,
            operationId,
            sequence,
            kind: 'initial'
        });
        return { items: assigned.items, round };
    } catch (error) {
        if (error.publicCode !== 'HELD_KITCHEN_ITEMS_EMPTY') throw error;
        return { items: assigned.items, round: null };
    }
}

function assertCallCenterContinuationPayload(previous, submitted, body, row) {
    for (const key of CALL_CENTER_FORBIDDEN_TOP_LEVEL) {
        if (hasAuthorityValue(body?.[key])) throw callCenterError('Phone orders cannot contain payment or checkout authority.', 400, 'CALL_CENTER_FINANCIAL_FIELD_FORBIDDEN');
    }
    for (const key of [...CALL_CENTER_FORBIDDEN_CART_FIELDS, 'order_discount']) {
        if (Object.prototype.hasOwnProperty.call(submitted, key)
            && (hasAuthorityValue(previous[key]) || hasAuthorityValue(submitted[key]))
            && stableAuthorityValue(submitted[key]) !== stableAuthorityValue(previous[key])) {
            throw callCenterError('Phone workers cannot change financial order fields.', 409, 'CALL_CENTER_FINANCIAL_CONTEXT_CHANGED');
        }
    }
    const previousItems = Array.isArray(previous.items) ? previous.items : [];
    const submittedItems = Array.isArray(submitted.items) ? submitted.items : [];
    const previousByHeldLineId = new Map(previousItems.flatMap((item, index) => {
        const heldLineId = String(item?.held_line_id || '').trim();
        return heldLineId ? [[heldLineId, { item, index }]] : [];
    }));
    const matchedPrevious = new Set();
    submittedItems.forEach((item, index) => {
        const heldLineId = String(item?.held_line_id || '').trim();
        const matched = (heldLineId && previousByHeldLineId.get(heldLineId)) || {
            item: previousItems[index] || {},
            index
        };
        const oldItem = matched.item;
        const oldHasAuthority = CALL_CENTER_FORBIDDEN_LINE_FIELDS.some(key => hasAuthorityValue(oldItem[key]));
        if (oldHasAuthority && matchedPrevious.has(matched.index)) {
            throw callCenterError('Phone workers cannot duplicate discounted or overridden lines.', 409, 'CALL_CENTER_FINANCIAL_CONTEXT_CHANGED');
        }
        const oldProductId = oldItem.product_id ?? oldItem.id ?? null;
        const submittedProductId = item.product_id ?? item.id ?? null;
        const productChanged = String(oldProductId ?? '') !== String(submittedProductId ?? '')
            || (oldProductId == null && submittedProductId == null && String(oldItem.name || '') !== String(item.name || ''));
        if (oldHasAuthority && productChanged) {
            throw callCenterError('Phone workers cannot move financial authority to another product.', 409, 'CALL_CENTER_FINANCIAL_CONTEXT_CHANGED');
        }
        for (const key of CALL_CENTER_FORBIDDEN_LINE_FIELDS) {
            if ((hasAuthorityValue(oldItem[key]) || hasAuthorityValue(item[key]))
                && stableAuthorityValue(item[key]) !== stableAuthorityValue(oldItem[key])) {
                throw callCenterError('Phone workers cannot change line discounts or price overrides.', 409, 'CALL_CENTER_FINANCIAL_CONTEXT_CHANGED');
            }
        }
        if (item?.note === 'Auto-Gratuity' && oldItem?.note !== 'Auto-Gratuity') {
            throw callCenterError('Phone workers cannot add a service charge.', 409, 'CALL_CENTER_FINANCIAL_CONTEXT_CHANGED');
        }
        matchedPrevious.add(matched.index);
    });
    previousItems.forEach((item, index) => {
        const hasFinancialAuthority = CALL_CENTER_FORBIDDEN_LINE_FIELDS.some(key => hasAuthorityValue(item?.[key]));
        if (hasFinancialAuthority && !matchedPrevious.has(index)) {
            throw callCenterError('Phone workers cannot remove discounted or overridden lines.', 409, 'CALL_CENTER_FINANCIAL_CONTEXT_CHANGED');
        }
    });
    const oldFees = previousItems.filter(item => item?.note === 'Auto-Gratuity');
    const newFees = submittedItems.filter(item => item?.note === 'Auto-Gratuity');
    if (stableAuthorityValue(oldFees) !== stableAuthorityValue(newFees)) {
        throw callCenterError('Phone workers cannot change an existing service charge.', 409, 'CALL_CENTER_FINANCIAL_CONTEXT_CHANGED');
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, 'service_charge_snapshot')) {
        const submittedId = String(body.service_charge_snapshot?.id || '');
        if (submittedId !== String(row.service_charge_snapshot_id || '')) {
            throw callCenterError('Phone workers cannot change an existing service charge.', 409, 'CALL_CENTER_FINANCIAL_CONTEXT_CHANGED');
        }
    }
}

function normalizePhoneCustomer(cartPayload) {
    const customerName = String(cartPayload?.customer_name || '').trim();
    const customerAddress = String(cartPayload?.customer_address || '').trim();
    if (!customerName || customerName.length > 100 || !customerAddress || customerAddress.length > 500) {
        throw callCenterError('Customer name, phone, and address are required.', 400, 'CALL_CENTER_CUSTOMER_REQUIRED');
    }
    return {
        customer_name: customerName,
        customer_phone: normalizeCustomerPhone(cartPayload.customer_phone),
        customer_address: customerAddress,
        delivery_date: normalizeHeldDeliveryDate(cartPayload.delivery_date, 'CALL_CENTER_DELIVERY_DATE_INVALID')
    };
}

async function assertCallCenterOrderType(conn, orderTypeId) {
    const id = Number(orderTypeId);
    if (!Number.isSafeInteger(id) || id <= 0) {
        throw callCenterError('Choose an order type for this phone order.', 400, 'CALL_CENTER_ORDER_TYPE_REQUIRED');
    }
    const [[row]] = await conn.query(`
        SELECT ot.id
          FROM order_types ot
          LEFT JOIN settings y ON y.setting_key='y_order_type_id'
         WHERE ot.id=? AND ot.is_active=1 AND COALESCE(ot.is_deferred_settlement, 0)=0
           AND (COALESCE(y.setting_value, '')='' OR ot.id<>CAST(y.setting_value AS UNSIGNED))
         LIMIT 1
    `, [id]);
    if (!row) throw callCenterError('This order type is not available for phone orders.', 409, 'CALL_CENTER_ORDER_TYPE_INVALID');
    return id;
}

function readHeldPayload(row) {
    try {
        const parsed = typeof row?.cart_data === 'string' ? JSON.parse(row.cart_data) : row?.cart_data;
        return Array.isArray(parsed) ? { items: parsed } : (parsed || {});
    } catch (_) {
        throw callCenterError('The held order data needs review.', 409, 'HELD_CART_INVALID');
    }
}

async function assertCallCenterHeldRow(conn, row, { phone = null, requirePhone = false } = {}) {
    if (!row?.call_center_user_id || !isRegisterHold(row)) {
        throw callCenterError('Phone order not found.', 404, 'CALL_CENTER_HELD_ORDER_NOT_FOUND');
    }
    if (requirePhone && (typeof phone !== 'string' || !phone.trim())) {
        throw callCenterError('Phone order not found.', 404, 'CALL_CENTER_HELD_ORDER_NOT_FOUND');
    }
    const payload = readHeldPayload(row);
    await assertCallCenterOrderType(conn, payload.order_type_id);
    const storedPhone = normalizeCustomerPhone(payload.customer_phone);
    if (phone != null && normalizeCustomerPhone(phone) !== storedPhone) {
        throw callCenterError('Phone order not found.', 404, 'CALL_CENTER_HELD_ORDER_NOT_FOUND');
    }
    return { payload, storedPhone };
}

function canUseHeldLifecycle(user) {
    return canHoldOrders(user) || isCallCenterRole(user);
}

function heldSourceAudit(row) {
    const sourceId = Number(row?.call_center_user_id);
    return Number.isSafeInteger(sourceId) && sourceId > 0 ? { call_center_user_id: sourceId } : {};
}

async function lockActiveCallCenterActor(conn, user) {
    if (!isCallCenterRole(user)) return;
    const [[actor]] = await conn.query('SELECT role, is_active FROM users WHERE id=? FOR UPDATE', [user.id]);
    if (!actor || actor.role !== 'call_center' || Number(actor.is_active) !== 1) {
        throw callCenterError('Your call-center session changed. Sign in again.', 403, 'CALL_CENTER_SESSION_CHANGED');
    }
}


// GET /api/pos/held_orders
router.get('/held_orders/summary', requireAuth, rejectCallCenterRole, async (req, res) => {
    try {
        if (!canHoldOrders(req.user)) return sendError(res, 403, "Forbidden: Hold order permission required.");
        const [[row]] = await pool.query(`
            SELECT COUNT(*) AS active_register_count
              FROM held_orders
             WHERE parent_invoice_id IS NULL
               AND table_id IS NULL
        `);
        return sendSuccess(res, { active_register_count: Number(row.active_register_count || 0) });
    } catch (e) {
        logger.error({ err: e }, 'GET /held_orders/summary failed');
        return sendError(res, 500, "Operation failed. Please try again.");
    }
});

async function buildHeldOrderRows(db, { id = null } = {}) {
    const params = [];
    let idFilter = '';
    if (id != null) {
        idFilter = ' AND h.id = ?';
        params.push(id);
    }
    const [rows] = await db.query(`
        SELECT h.id, h.user_id, h.order_id, h.order_seq_scope, h.reference_name, h.cart_data, h.subtotal, h.kitchen_fired,
               h.service_charge_snapshot_id, h.parent_invoice_id, h.table_id, h.created_at,
               h.version, h.claimed_by_user_id, h.claim_expires_at, h.updated_at,
               h.kitchen_snapshot, h.kitchen_dispatch_version,
               h.call_center_user_id, u.name as cashier_name,
               source.name as call_center_user_name, claimant.name as claim_owner_name,
               EXISTS(SELECT 1 FROM order_intake_requests intake WHERE intake.held_order_id = h.id) AS from_order_intake
        FROM held_orders h 
        LEFT JOIN users u ON h.user_id = u.id 
        LEFT JOIN users source ON h.call_center_user_id = source.id
        LEFT JOIN users claimant ON h.claimed_by_user_id = claimant.id
        WHERE h.parent_invoice_id IS NULL AND h.table_id IS NULL${idFilter}
        ORDER BY h.created_at DESC
    `, params);
    const presentations = await buildHeldPresentations(db, rows, { split: false });
    presentations.forEach((pres, index) => {
        if (pres.error?.publicCode === BUNDLE_ORDER_CORRUPT) {
            const row = rows[index];
            logger.warn({
                err: pres.error,
                heldOrderId: row.id,
                integrityReason: pres.error.integrityReason,
                integrityContext: pres.error.integrityContext
            }, 'Corrupt held-order bundle data.');
        }
    });
    return rows.map(({ kitchen_snapshot, ...row }, idx) => {
        const pres = presentations[idx];
        return {
            ...row,
            kitchen_baseline_known: kitchenBaselineKnown(kitchen_snapshot),
            order_display_no: formatOrderNumber(row),
            receipt_display_v1: pres.presentation || null,
            receipt_display_error: pres.error ? (pres.error.publicCode || pres.error.code || 'RECEIPT_PRESENTATION_INVALID') : null
        };
    });
}

router.get('/held_orders', requireAuth, rejectCallCenterRole, async (req, res) => {
    try {
        if (!canHoldOrders(req.user)) return sendError(res, 403, "Forbidden: Hold order permission required.");
        const data = await buildHeldOrderRows(pool);
        return sendSuccess(res, { data });
    } catch (e) {
        logger.error({ err: e }, 'GET /held_orders failed');
        sendError(res, 500, "Operation failed. Please try again.");
    }
});

router.get('/held_orders/:id', requireAuth, rejectCallCenterRole, async (req, res) => {
    try {
        if (!canHoldOrders(req.user)) return sendError(res, 403, "Forbidden: Hold order permission required.");
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) return sendError(res, 404, 'Held order not found.');
        const [row] = await buildHeldOrderRows(pool, { id });
        if (!row) return sendError(res, 404, 'Held order not found.');
        return sendSuccess(res, { data: row });
    } catch (e) {
        logger.error({ err: e, heldOrderId: req.params.id }, 'GET /held_orders/:id failed');
        sendError(res, 500, "Operation failed. Please try again.");
    }
});

// POST /api/pos/held_orders/settle-platform — finalize register holds as
// deferred platform sales. Kitchen printing is an independent workflow.
// Each hold owns its own checkout
// transaction so a failed row never rolls back an earlier completed sale.
router.post('/held_orders/settle-platform', requireAuth, rejectCallCenterRole, async (req, res) => {
    const orderTypeId = Number(req.body?.order_type_id);
    const heldOrderIds = req.body?.held_order_ids;
    if (!Array.isArray(heldOrderIds) || heldOrderIds.length === 0 || heldOrderIds.length > 100 ||
        heldOrderIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0) ||
        new Set(heldOrderIds.map(Number)).size !== heldOrderIds.length) {
        return sendError(res, 400, 'Held order IDs must be a nonempty unique list of at most 100 orders.');
    }
    if (!Number.isSafeInteger(orderTypeId) || orderTypeId <= 0) {
        return sendError(res, 400, 'A valid platform order type is required.');
    }
    if (!canHoldOrders(req.user) || !canCheckout(req.user)) {
        return sendError(res, 403, 'Forbidden: Hold and checkout permissions are required.');
    }

    try {
        const [[orderType]] = await pool.query(
            'SELECT id FROM order_types WHERE id = ? AND is_active = 1 AND is_deferred_settlement = 1',
            [orderTypeId]
        );
        if (!orderType) {
            return sendError(res, 409, 'This order type is not configured for platform settlement.', 'PLATFORM_ORDER_TYPE_INVALID');
        }
        const [[shift]] = await pool.query(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
            [req.user.id]
        );
        if (!shift) {
            return sendError(res, 409, 'Open your own shift before closing platform orders.', 'PLATFORM_SHIFT_REQUIRED');
        }

        const successes = [];
        const failures = [];
        for (const heldOrderId of heldOrderIds.map(Number)) {
            try {
                const result = await executeCheckout({
                    user: req.user,
                    input: { shift_id: shift.id },
                    io: req.io,
                    ipAddress: req.ip || req.socket?.remoteAddress || null,
                    authorizeManagerOverride: async () => ({ allowed: false }),
                    platformHeldOrderId: heldOrderId,
                    expectedPlatformOrderTypeId: orderTypeId
                });
                successes.push({
                    held_order_id: heldOrderId,
                    invoice_id: result.invoice_id,
                    invoice_display_no: result.invoice_display_no || null,
                    total: result.total,
                    duplicate: result.duplicate === true
                });
            } catch (error) {
                logger.error({ err: error, heldOrderId, userId: req.user.id }, 'Platform held-order settlement failed.');
                const publicCode = error.publicCode || 'PLATFORM_SETTLEMENT_FAILED';
                const message = publicCode === 'PLATFORM_ORDER_TYPE_INVALID'
                    ? 'This held order type is not configured for platform settlement.'
                    : publicCode === 'PLATFORM_ORDER_TYPE_MISMATCH'
                        ? 'This held order belongs to another platform provider.'
                    : publicCode === 'PLATFORM_TAX_CONTEXT_INVALID'
                        ? 'Platform held order tax context is invalid.'
                        : publicCode === 'CALL_CENTER_PLATFORM_SETTLEMENT_FORBIDDEN'
                            ? 'Phone orders must be completed through the normal register workflow.'
                        : 'This held order could not be closed. Refresh and try again.';
                failures.push({ held_order_id: heldOrderId, publicCode, message });
            }
        }
        return sendSuccess(res, { successes, failures });
    } catch (error) {
        logger.error({ err: error, userId: req.user.id }, 'POST /held_orders/settle-platform failed');
        return sendError(res, 500, 'Operation failed. Please try again.');
    }
});

// POST /api/pos/held_orders/phone-matches — metadata only; full cart is
// returned only after a successful phone-bound claim.
router.post('/held_orders/phone-matches', requireAuth, async (req, res) => {
    if (!isCallCenterRole(req.user)) return sendError(res, 403, 'Forbidden.', 'CALL_CENTER_ROLE_REQUIRED');
    res.set('Cache-Control', 'no-store');
    try {
        const phone = normalizeCustomerPhone(req.body?.phone);
        const [rows] = await pool.query(`
            SELECT h.id, h.reference_name, h.version, h.kitchen_fired, h.kitchen_dispatch_version,
                   h.created_at, h.updated_at,
                   h.call_center_user_id, h.claimed_by_user_id, h.claim_expires_at,
                   JSON_UNQUOTE(JSON_EXTRACT(h.cart_data, '$.customer_name')) AS customer_name,
                   JSON_UNQUOTE(JSON_EXTRACT(h.cart_data, '$.delivery_date')) AS delivery_date,
                   JSON_LENGTH(JSON_EXTRACT(h.cart_data, '$.items')) AS item_count,
                   CAST(JSON_UNQUOTE(JSON_EXTRACT(h.cart_data, '$.order_type_id')) AS UNSIGNED) AS order_type_id,
                   source.name AS call_center_user_name, claimant.name AS claim_owner_name
              FROM held_orders h
              JOIN users source ON source.id=h.call_center_user_id
              LEFT JOIN users claimant ON claimant.id=h.claimed_by_user_id
              JOIN order_types ot ON ot.id=CAST(JSON_UNQUOTE(JSON_EXTRACT(h.cart_data, '$.order_type_id')) AS UNSIGNED)
              LEFT JOIN settings y ON y.setting_key='y_order_type_id'
             WHERE h.call_center_user_id IS NOT NULL
               AND h.parent_invoice_id IS NULL AND h.table_id IS NULL
               AND JSON_VALID(h.cart_data)
               AND JSON_UNQUOTE(JSON_EXTRACT(h.cart_data, '$.customer_phone'))=?
               AND ot.is_active=1 AND COALESCE(ot.is_deferred_settlement, 0)=0
               AND (COALESCE(y.setting_value, '')='' OR ot.id<>CAST(y.setting_value AS UNSIGNED))
             ORDER BY h.updated_at DESC, h.id DESC
             LIMIT 10
        `, [phone]);
        return sendSuccess(res, { data: rows.map(row => ({
            ...row,
            id: Number(row.id),
            version: Number(row.version),
            kitchen_fired: Number(row.kitchen_fired),
            kitchen_dispatch_version: Number(row.kitchen_dispatch_version),
            item_count: Number(row.item_count),
            call_center_user_id: Number(row.call_center_user_id),
            claimed_by_user_id: row.claimed_by_user_id == null ? null : Number(row.claimed_by_user_id),
            order_type_id: Number(row.order_type_id)
        })) });
    } catch (error) {
        logger.error({ err: error, userId: req.user?.id }, 'Phone-order match lookup failed.');
        return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Phone-order lookup failed.', error.publicCode || null);
    }
});

// The old body-ID claim route was destructive and is intentionally retired.
router.post('/held_orders/claim', requireAuth, async (_req, res) => {
    return sendError(res, 410, 'The old held-order claim route is retired.', 'HELD_CLAIM_ROUTE_RETIRED');
});

// POST /api/pos/held_orders/:id/claim — lease one durable held order for editing.
router.post('/held_orders/:id/claim', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const claimToken = typeof req.body?.claim_token === 'string' ? req.body.claim_token : '';
    const expectedVersion = Number(req.body?.expected_version);
    let conn;
    try {
        if (!canUseHeldLifecycle(req.user)) return sendError(res, 403, "Forbidden: Hold order permission required.");
        if (!Number.isInteger(id) || id < 1) return sendError(res, 400, "A valid held order id is required.");
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
            return sendError(res, 400, 'A valid held-order version is required.', 'HELD_VERSION_REQUIRED');
        }
        if (!/^[0-9a-f]{64}$/i.test(claimToken)) {
            return sendError(res, 400, 'A valid held-order claim token is required.', 'HELD_CLAIM_TOKEN_REQUIRED');
        }

        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        await lockActiveCallCenterActor(conn, req.user);
        if (isCallCenterRole(req.user)) {
            const candidate = await heldLifecycle.selectHeldForUpdate(conn, id);
            await assertCallCenterHeldRow(conn, candidate, { phone: req.body?.phone, requirePhone: true });
        }
        const claim = await heldLifecycle.claimHeldOrder(conn, {
            id,
            userId: req.user.id,
            claimToken,
            expectedVersion,
            now: new Date()
        });

        const [rows] = await conn.query("SELECT * FROM held_orders WHERE id = ? FOR UPDATE", [id]);
        if (rows.length === 0) {
            throw Object.assign(new Error('Held order was not found.'), { statusCode: 404, publicCode: 'HELD_ORDER_NOT_FOUND' });
        }
        if (!isRegisterHold(rows[0])) {
            await conn.rollback();
            return sendError(res, 404, "Held order not found.");
        }
        if (claim.replay) {
            let replaySnapshot = null;
            if (rows[0].service_charge_snapshot_id) {
                const snapshot = await getForUpdate(conn, rows[0].service_charge_snapshot_id);
                replaySnapshot = snapshot ? {
                    id: snapshot.id,
                    percentage: Number(snapshot.percentage),
                    taxRate: Number(snapshot.tax_rate),
                    taxCategory: snapshot.jofotara_tax_category,
                    version: Number(snapshot.version),
                } : null;
            }
            await conn.commit();
            return sendSuccess(res, {
                order: {
                    ...heldLifecycle.safeProjection(rows[0]),
                    service_charge_snapshot: replaySnapshot,
                },
                claim: {
                    version: Number(rows[0].version),
                    claimExpiresAt: rows[0].claim_expires_at,
                    claimToken,
                },
                pricing_context_changed: { taxMode: false, taxRates: false, prices: false, total: false }
            });
        }

        // 1. parse and normalize its cart (array shape = pre-object legacy payload)
        let parsedCartData;
        try {
            parsedCartData = typeof rows[0].cart_data === 'string'
                ? JSON.parse(rows[0].cart_data || '{}')
                : (rows[0].cart_data || {});
        } catch (_) {
            throw bundleOrderCorruptionError();
        }
        const cartPayload = Array.isArray(parsedCartData) ? { items: parsedCartData } : parsedCartData;
        assertHeldItemStructure(cartPayload?.items);
        assertNestedBundleIntegrity(cartPayload.items);
        assertOrderItemBundleIntegrity(cartPayload.items);

        let claimedSnapshot = null;
        if (rows[0].service_charge_snapshot_id) {
            claimedSnapshot = await getForUpdate(conn, rows[0].service_charge_snapshot_id);
            if (claimedSnapshot.state !== 'held' || claimedSnapshot.holder_type !== 'held_order' || String(claimedSnapshot.holder_id) !== String(id)) {
                throw Object.assign(new Error('Conflict: Held service-charge snapshot changed.'), { statusCode: 409, publicCode: 'SERVICE_CHARGE_SNAPSHOT_CONFLICT' });
            }
        }
        let items = normalizeCartItems((cartPayload.items || []).map(item => ({
            ...item,
            price: item.price ?? item.price_at_sale ?? 0
        })));

        // 2. batch-load current products
        const productMap = await fetchCartProducts(conn, items);

        // A deactivated base product still claims (is_available/can_sell just warn the
        // cashier), so a deactivated NOTE product must not be stricter — a 409 here
        // strands the hold forever, since the only recovery path runs on a cart draft
        // the cashier can no longer reach. Drop the dead note instead and let the
        // existing price-change signal tell them. This assignment must stay ahead of
        // applyDatabasePrices below, which reprices from the cleaned selections.
        for (const item of items) {
            if (item.note === 'Auto-Gratuity') continue;
            const product = item.product_id != null ? productMap.get(item.product_id) : null;
            item.selectedModifiers = buildSelectedModifiersSnapshot(product, item, productMap, { dropUnavailableNotes: true });
            if (product) {
                item.is_available = Number(product.is_available);
                item.can_sell = Number(product.can_sell);
            }
        }

        // Held cart_data is server-written at hold-save; normalizeCartItems strips the
        // field, so re-attach the stored value by index (indexes are 1:1 through normalize).
        for (let i = 0; i < items.length; i++) {
            const raw = cartPayload.items?.[i];
            const stored = Number(raw?.modifier_surcharge);
            items[i].modifier_surcharge = Number.isFinite(stored) && stored > 0 ? stored : null;
            const storedTax = Number(raw?.modifier_tax_amount);
            items[i].modifier_tax_amount = raw?.modifier_tax_amount != null && Number.isFinite(storedTax) && storedTax >= 0
                ? storedTax : null;
        }

        // Keep a copy of original items before modifying tax rates for old totals calculation
        const originalItems = JSON.parse(JSON.stringify(items));

        await attachRegisterPrices(conn, productMap);
        applyDatabasePrices(items, productMap, { ...req.user, role: 'cashier', permissions: [] }, false, null);
        for (const item of items) {
            if (item.product_id != null) delete item.manual_price_override;
        }
        const pricesChanged = items.some((item, index) =>
            item.product_id != null &&
            item.note !== 'Auto-Gratuity' &&
            Math.abs(Number(item.price) - Number(originalItems[index]?.price)) > 0.0001
        );

        // 3. replace every catalog-line rate with the current DB value
        let taxRatesChanged = false;
        for (const item of items) {
            if (item.product_id != null && item.note !== 'Auto-Gratuity') {
                const product = productMap.get(item.product_id);
                if (product) {
                    const heldProfile = cartPayload.tax_registration_type_at_hold == null
                        ? TAX_REGISTRATION_TYPES.SALES_TAX
                        : normalizeTaxRegistrationType(cartPayload.tax_registration_type_at_hold);
                    const currentDbRate = resolveEffectiveTaxRate(product.tax_rate, heldProfile);
                    if (Number(item.tax_rate) !== currentDbRate) {
                        taxRatesChanged = true;
                        item.tax_rate = currentDbRate;
                    }
                    item.jofotara_tax_category = product.jofotara_tax_category;
                }
            }
        }

        // Legacy register holds parked before modifier_surcharge existed carry no field.
        // Holds are not frozen-price settle paths: checkout re-runs applyDatabasePrices
        // and attaches the DB surcharge. Attach the same value here after originalItems
        // was copied, so claim display and checkout charge agree while oldTotals still
        // reflects hold-time math and the totals-changed warning remains truthful.
        for (const item of items) {
            if (item.note === 'Auto-Gratuity' || item.product_id == null) continue;
            if (item.modifier_surcharge == null) {
                const product = productMap.get(item.product_id);
                const derived = product ? computeModifierSurcharge(product, item, productMap) : 0;
                item.modifier_surcharge = derived > 0 ? Number(derived.toFixed(6)) : null;
            }
            if (item.modifier_surcharge != null) {
                item.modifier_tax_amount = Number(
                    deriveModifierTaxAmount(item.modifier_surcharge, item.tax_rate).toFixed(6)
                );
            }
        }

        // 4. preserve snapshot-canonical Auto-Gratuity
        // (Auto-Gratuity was ignored/filtered in the loop above since its product_id is null)

        // 5. calculate old hold-time and new current-mode totals server-side
        const legacySetting = await require('../../config/settingsHelper').getSettings(conn, ['tax_inclusive_pricing']);
        const legacyTaxInclusive = legacySetting.tax_inclusive_pricing === '1';
        const heldTaxRegistrationType = cartPayload.tax_registration_type_at_hold == null
            ? TAX_REGISTRATION_TYPES.SALES_TAX
            : normalizeTaxRegistrationType(cartPayload.tax_registration_type_at_hold);
        cartPayload.tax_registration_type_at_hold = heldTaxRegistrationType;
        // A legacy hold has no flag — there is no hold-time mode to compare against,
        // so treat it as the current mode instead of warning on every legacy claim.
        const oldTaxInclusive = cartPayload.tax_inclusive_at_hold != null
            ? Number(cartPayload.tax_inclusive_at_hold) === 1
            : legacyTaxInclusive;
        const taxExempt = cartPayload.tax_exempt_at_hold === true || cartPayload.tax_exempt_at_hold === 1 || cartPayload.tax_exempt_at_hold === '1';
        // Old totals must use the HOLD-TIME rates; without overrides the calculator
        // re-resolves catalog lines from the current productMap and the "total
        // changed" comparison degenerates to a mode-only check.
        const oldRateOverrides = new Map();
        for (const item of originalItems) {
            const heldRate = Number(item.tax_rate);
            if (Number.isFinite(heldRate) && heldRate >= 0 && heldRate <= 100) {
                oldRateOverrides.set(item, heldRate);
            }
        }
        const oldTotals = calculateExpectedTotals(
            {
                order_discount_type: cartPayload.order_discount?.type || null,
                order_discount_value: Number(cartPayload.order_discount?.value) || 0
            },
            originalItems,
            productMap,
            oldTaxInclusive,
            { taxRateOverrides: oldRateOverrides, taxRegistrationType: heldTaxRegistrationType, taxExempt }
        );

        const newTotals = calculateExpectedTotals(
            {
                order_discount_type: cartPayload.order_discount?.type || null,
                order_discount_value: Number(cartPayload.order_discount?.value) || 0
            },
            items,
            productMap,
            oldTaxInclusive,
            { taxRegistrationType: heldTaxRegistrationType, taxExempt }
        );

        const taxModeChanged = cartPayload.tax_inclusive_at_hold == null && oldTaxInclusive !== legacyTaxInclusive;
        const totalChanged = Math.abs(oldTotals.total - newTotals.total) > 0.02;

        // Rehydrate cart_data items
        cartPayload.items = items;
        rows[0].cart_data = JSON.stringify(cartPayload);
        const canonicalVersion = Number(claim.version) + 1;
        const [canonicalized] = await conn.query(`
            UPDATE held_orders
               SET cart_data=?, version=?, updated_at=?
             WHERE id=? AND version=?
        `, [rows[0].cart_data, canonicalVersion, new Date(), id, claim.version]);
        if (Number(canonicalized?.affectedRows) !== 1) {
            throw Object.assign(new Error('Held order changed. Refresh and try again.'), { statusCode: 409, publicCode: 'HELD_VERSION_CONFLICT' });
        }
        rows[0].version = canonicalVersion;
        await heldLifecycle.appendHeldOrderAudit(conn, {
            actor: req.user,
            eventType: 'held_order_claimed',
            heldOrderId: id,
            oldVersion: expectedVersion,
            newVersion: canonicalVersion,
            ...heldSourceAudit(rows[0])
        });
        await conn.commit();
        emitHeldOrdersChanged(req.io, 'claimed', rows[0]);
        const safeOrder = {
            ...heldLifecycle.safeProjection(rows[0]),
            cart_data: rows[0].cart_data,
            reference_name: rows[0].reference_name,
            service_charge_snapshot: claimedSnapshot ? {
                id: claimedSnapshot.id,
                percentage: Number(claimedSnapshot.percentage),
                taxRate: Number(claimedSnapshot.tax_rate),
                taxCategory: claimedSnapshot.jofotara_tax_category,
                version: claimedSnapshot.version
            } : null
        };
        return sendSuccess(res, {
            order: safeOrder,
            claim: {
                version: canonicalVersion,
                claimExpiresAt: rows[0].claim_expires_at,
                claimToken,
            },
            pricing_context_changed: {
                taxMode: taxModeChanged,
                taxRates: taxRatesChanged,
                prices: pricesChanged,
                total: totalChanged
            }
        });
    } catch (e) {
        if (conn) { try { await conn.rollback(); } catch (_) {} }
        logger.error({ err: e }, 'POST /held_orders/claim failed');
        sendError(res, e.statusCode || 500, e.statusCode ? e.message : "Operation failed. Please try again.", e.publicCode || null);
    } finally {
        if (conn) conn.release();
    }
});

const HELD_CANCEL_REASONS = new Set([
    'customer_changed_mind', 'duplicate_order', 'entered_in_error', 'other_customer_request'
]);
const HELD_BASELINE_REASONS = new Set(['kitchen_confirmed', 'manual_review']);

function stableHoldRequestValue(value) {
    if (Array.isArray(value)) return value.map(stableHoldRequestValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
        if (key === '_hold_request_fingerprint' || key === 'claim_token') return result;
        result[key] = stableHoldRequestValue(value[key]);
        return result;
    }, {});
}

function buildHoldRequestFingerprint(data) {
    const cart = Array.isArray(data?.cart) ? { items: data.cart } : data?.cart;
    const request = {
        cart,
        reference_name: String(data?.reference_name || '').trim(),
        subtotal: Number(data?.subtotal),
        tax_exempt: data?.tax_exempt === true,
        service_charge_snapshot: data?.service_charge_snapshot ? {
            id: data.service_charge_snapshot.id ? String(data.service_charge_snapshot.id) : null,
            version: Number(data.service_charge_snapshot.version) || null,
        } : null,
    };
    return crypto.createHash('sha256')
        .update(JSON.stringify(stableHoldRequestValue(request)))
        .digest('hex');
}

function heldOperationId(value) {
    const normalized = String(value || '').trim();
    return /^[a-z0-9-]{8,64}$/i.test(normalized) ? normalized : null;
}

function mergeHeldCartPayload(previous, submitted, items) {
    const next = { ...previous, ...submitted, items };
    // Settlement and creation replay trust these hold-time facts. A recalled
    // cart may echo them, but editing customer details/items cannot replace them.
    for (const field of [
        'tax_inclusive_at_hold', 'receipt_tax_inclusive_at_hold',
        'tax_registration_type_at_hold', 'tax_exempt_at_hold',
        'tax_context_version', '_hold_request_fingerprint', '_customer_receipt_requested', 'call_center_user_id'
    ]) {
        if (Object.prototype.hasOwnProperty.call(previous, field)) next[field] = previous[field];
        else delete next[field];
    }
    return next;
}

async function computeHeldKitchenDelta(conn, snapshot, items) {
    const expanded = expandBundlesForKitchen(items);
    const { routable } = await filterRoutableKitchenLines(conn, expanded);
    const preparationIds = new Set([
        ...snapshot.lines.map(line => String(line.held_line_id)),
        ...routable.map(line => String(line.held_line_id))
    ]);
    // Current routes decide which new work can be sent. The durable baseline
    // still protects earlier work when its printer or category route changes.
    return computePositiveKitchenDelta({
        baseline: snapshot.lines,
        current: expanded.filter(line => preparationIds.has(String(line.held_line_id)))
    });
}

router.patch('/held_orders/:id', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const operationId = heldOperationId(req.body?.operation_id);
    const expectedVersion = Number(req.body?.expected_version);
    const claimToken = String(req.body?.claim_token || '');
    let conn;
    try {
        if (!canUseHeldLifecycle(req.user)) return sendError(res, 403, 'Forbidden: Hold order permission required.');
        if (!Number.isSafeInteger(id) || id <= 0 || !operationId || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
            return sendError(res, 400, 'A valid held-order id, version, and operation id are required.', 'HELD_OPERATION_INVALID');
        }
        if (!/^[0-9a-f]{64}$/i.test(claimToken)) return sendError(res, 400, 'A valid held-order claim token is required.', 'HELD_CLAIM_TOKEN_REQUIRED');
        const submitted = Array.isArray(req.body?.cart) ? { items: req.body.cart } : req.body?.cart;
        if (!submitted || typeof submitted !== 'object' || !Array.isArray(submitted.items)) {
            return sendError(res, 400, 'A valid cart is required.', 'HELD_CART_INVALID');
        }
        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        await lockActiveCallCenterActor(conn, req.user);
        const existing = await heldLifecycle.selectHeldForUpdate(conn, id);
        if (isCallCenterRole(req.user)) await assertCallCenterHeldRow(conn, existing);
        const replay = heldLifecycle.readOperationReplay(existing, operationId, 'save');
        if (replay) {
            const customerReceipt = replay.customerReceiptRequested && existing.order_id != null
                ? await prepareHeldCustomerReceipt(conn, existing, {requestId:operationId, replayBrowserOnly:true}) : null;
            await conn.commit();
            return sendSuccess(res, {
                id,
                order_display_no: formatOrderNumber(existing),
                version: replay.version,
                customer_receipt: customerReceipt,
                replay: true,
                kitchen_fired: Number(existing.kitchen_fired) === 1,
                kitchen_dispatch_version: Number(existing.kitchen_dispatch_version || 0)
            });
        }
        const row = existing;
        heldLifecycle.assertClaimedHeldOrder(row, { userId: req.user.id, claimToken, expectedVersion, now: new Date() });
        if (!isRegisterHold(row)) throw Object.assign(new Error('Held order not found.'), { statusCode: 404, publicCode: 'HELD_ORDER_NOT_FOUND' });
        let previousPayload = {};
        try { previousPayload = JSON.parse(row.cart_data || '{}'); } catch (_) {}
        if (isCallCenterRole(req.user)) {
            if (req.body?.reference_name != null) throw callCenterError('Phone order references are server-owned.', 400, 'CALL_CENTER_REFERENCE_FORBIDDEN');
            assertCallCenterContinuationPayload(previousPayload, submitted, req.body, row);
            const customer = normalizePhoneCustomer({ ...previousPayload, ...submitted });
            Object.assign(submitted, customer);
            await assertCallCenterOrderType(conn, submitted.order_type_id || previousPayload.order_type_id);
        } else if (Object.prototype.hasOwnProperty.call(submitted, 'delivery_date')) {
            submitted.delivery_date = normalizeHeldDeliveryDate(submitted.delivery_date);
        }
        const { canonicalItems, canonicalSubtotal } = await canonicalizeHeldCart(conn, req.user, submitted, {
            accountingTaxInclusive: Number(previousPayload.tax_inclusive_at_hold) === 1,
            savedTaxRegistrationType: previousPayload.tax_registration_type_at_hold
        });
        let assignedItems = canonicalItems;
        let kitchenSnapshot = null;
        if (Number(row.kitchen_fired) === 1) {
            kitchenSnapshot = parseKitchenSnapshot(row.kitchen_snapshot);
            if (!kitchenSnapshot) {
                throw heldKitchenError('This fired held order needs an explicit kitchen-baseline confirmation before it can be edited.', 409, 'HELD_KITCHEN_BASELINE_UNKNOWN');
            }
            const protectedLineIds = new Set(kitchenSnapshot.lines.map(line => String(line.held_line_id)));
            const normalizedKitchenItems = await normalizeKitchenTicketItems(canonicalItems, {
                db: conn,
                linePrefix: `held-${id}`
            });
            const assigned = assignStableHeldLineIds(normalizedKitchenItems, {
                heldId: id,
                previousItems: Array.isArray(previousPayload.items) ? previousPayload.items : [],
                protectedLineIds: isCallCenterRole(req.user) ? protectedLineIds : new Set(),
                mode: 'update'
            });
            assignedItems = assigned.items;
            if (isCallCenterRole(req.user)) {
                const pendingDelta = await computeHeldKitchenDelta(conn, kitchenSnapshot, assignedItems);
                if (pendingDelta.length > 0) throw heldKitchenError('Send the new items as a FOLLOW UP.', 409, 'HELD_KITCHEN_FOLLOW_UP_REQUIRED');
            }
        } else {
            assignedItems = assignStableHeldLineIds(canonicalItems, {
                heldId: id,
                previousItems: Array.isArray(previousPayload.items) ? previousPayload.items : [],
                mode: 'update'
            }).items;
        }
        const nextPayload = {
            ...mergeHeldCartPayload(previousPayload, submitted, assignedItems),
            ...(req.body.reference_name != null ? { reference_name: String(req.body.reference_name).trim().slice(0, 100) } : {})
        };
        let automaticKitchenRound = null;
        let customerReceipt = null;
        const firstImmediate = shouldAutoFireHeldOrder(nextPayload) && !previousPayload._customer_receipt_requested;
        if (firstImmediate) {
            row.cart_data = nextPayload;
            await ensureHeldOrderNumber(conn, row);
        }
        if (kitchenSnapshot && !isCallCenterRole(req.user)) {
            automaticKitchenRound = await queueHeldKitchenChanges({ db: conn, heldOrder: row,
                items: assignedItems, operationId, snapshot: kitchenSnapshot });
        }
        if (Number(row.kitchen_fired) !== 1 && shouldAutoFireHeldOrder(nextPayload)) {
            const automatic = await queueAutomaticHeldKitchenRound({
                db: conn,
                heldOrder: {
                    ...row,
                    reference_name: req.body.reference_name == null
                        ? row.reference_name
                        : String(req.body.reference_name).trim().slice(0, 100)
                },
                items: canonicalItems,
                operationId
            });
            assignedItems = automatic.items;
            nextPayload.items = assignedItems;
            automaticKitchenRound = automatic.round;
        }
        let nextSnapshotId = row.service_charge_snapshot_id || null;
        if (Object.prototype.hasOwnProperty.call(req.body, 'service_charge_snapshot')) {
            const submittedSnapshot = req.body.service_charge_snapshot;
            if (!submittedSnapshot) {
                if (row.service_charge_snapshot_id) {
                    const currentSnapshot = await getForUpdate(conn, row.service_charge_snapshot_id);
                    if (currentSnapshot.state === 'held') {
                        await transitionServiceChargeSnapshot(conn, {
                            snapshotId: currentSnapshot.id,
                            version: currentSnapshot.version,
                            from: 'held',
                            to: 'abandoned',
                            holderType: 'none',
                            holderId: null,
                        });
                    }
                }
                nextSnapshotId = null;
            } else {
                if (String(submittedSnapshot.id) !== String(row.service_charge_snapshot_id)) {
                    throw Object.assign(new Error('A held order service charge cannot be replaced while editing.'), { statusCode: 409, publicCode: 'SERVICE_CHARGE_SNAPSHOT_CONFLICT' });
                }
                const currentSnapshot = await getForUpdate(conn, row.service_charge_snapshot_id);
                if (currentSnapshot.state !== 'held' || currentSnapshot.holder_type !== 'held_order' || String(currentSnapshot.holder_id) !== String(id)) {
                    throw Object.assign(new Error('Conflict: Held service-charge snapshot changed.'), { statusCode: 409, publicCode: 'SERVICE_CHARGE_SNAPSHOT_CONFLICT' });
                }
            }
        }
        const nextVersion = Number(row.version || 0) + 1;
        const nextKitchenFired = automaticKitchenRound ? 1 : Number(row.kitchen_fired || 0);
        const nextKitchenSnapshot = automaticKitchenRound ? JSON.stringify(automaticKitchenRound.snapshot) : row.kitchen_snapshot;
        const nextKitchenDispatchVersion = automaticKitchenRound
            ? Number(row.kitchen_dispatch_version || 0) + 1
            : Number(row.kitchen_dispatch_version || 0);
        const safeResult = heldLifecycle.safeOperationResult(automaticKitchenRound ? {
            version: nextVersion,
            status: 'queued',
            deltaCount: automaticKitchenRound.count,
            queueIds: automaticKitchenRound.queued.map(job => job.id),
            batchId: automaticKitchenRound.batchId,
            kitchenDispatchVersion: nextKitchenDispatchVersion
        } : { version: nextVersion });
        const [updated] = await conn.query(`
            UPDATE held_orders
               SET cart_data=?, subtotal=?, service_charge_snapshot_id=?, reference_name=COALESCE(?, reference_name),
                   kitchen_fired=?, kitchen_snapshot=?, kitchen_dispatch_version=?,
                   claimed_by_user_id=NULL, claim_token_hash=NULL, claim_expires_at=NULL,
                   version=?, last_operation_id=?, last_operation_kind='save', last_operation_result=?, updated_at=?
             WHERE id=? AND version=?
        `, [JSON.stringify(nextPayload), canonicalSubtotal, nextSnapshotId, req.body.reference_name == null ? null : String(req.body.reference_name).trim().slice(0, 100), nextKitchenFired, nextKitchenSnapshot, nextKitchenDispatchVersion, nextVersion, operationId, JSON.stringify(safeResult), new Date(), id, row.version]);
        if (Number(updated?.affectedRows) !== 1) throw Object.assign(new Error('Held order changed. Refresh and try again.'), { statusCode: 409, publicCode: 'HELD_VERSION_CONFLICT' });
        if (firstImmediate) {
            customerReceipt = await prepareHeldCustomerReceipt(conn, {...row,cart_data:JSON.stringify(nextPayload)}, {
                printerId:req.body.receipt_printer_id,requestId:operationId,automatic:true
            });
            if (customerReceipt?.mode === 'browser') {
                // Only this save's browser copy belongs in its retry response.
                safeResult.customerReceiptRequested = true;
                await conn.query('UPDATE held_orders SET last_operation_result=? WHERE id=?', [JSON.stringify(safeResult), id]);
            }
        }
        await heldLifecycle.appendHeldOrderAudit(conn, { actor: req.user, eventType: 'held_order_updated', heldOrderId: id, oldVersion: row.version, newVersion: nextVersion, operationId, ...heldSourceAudit(row) });
        if (automaticKitchenRound) {
            await heldLifecycle.appendHeldOrderAudit(conn, {
                actor: req.user,
                eventType: kitchenSnapshot ? 'held_order_follow_up_queued' : 'held_order_kitchen_fired',
                heldOrderId: id,
                oldVersion: row.version,
                newVersion: nextVersion,
                operationId,
                deltaCount: automaticKitchenRound.count,
                kitchen_sequence: Number(automaticKitchenRound.snapshot.sequence),
                ...heldSourceAudit(row)
            });
            await commitAndPublishSpoolerSyncWake(conn);
        } else if (customerReceipt?.mode === 'backend') {
            await commitAndPublishSpoolerSyncWake(conn);
        } else {
            await conn.commit();
        }
        emitHeldOrdersChanged(req.io, 'updated', row);
        return sendSuccess(res, {
            id,
            order_display_no:formatOrderNumber(row),
            customer_receipt:customerReceipt,
            version: nextVersion,
            replay: false,
            kitchen_fired: nextKitchenFired === 1,
            kitchen_dispatch_version: nextKitchenDispatchVersion
        });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        logger.error({ err: error, heldOrderId: id }, 'PATCH /held_orders/:id failed');
        return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Operation failed. Please try again.', error.publicCode || null);
    } finally { if (conn) conn.release(); }
});

// POST /api/pos/held_orders/:id/follow-up — queue only the new kitchen delta
// for an already-fired held order, then release the edit lease on the same row.
router.post('/held_orders/:id/follow-up', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const operationId = heldOperationId(req.body?.operation_id);
    const expectedVersion = Number(req.body?.expected_version);
    const claimToken = String(req.body?.claim_token || '');
    let conn;
    try {
        if (!canUseHeldLifecycle(req.user)) return sendError(res, 403, 'Forbidden: Hold order permission required.');
        if (!Number.isSafeInteger(id) || id <= 0 || !operationId || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
            return sendError(res, 400, 'A valid held-order id, version, and operation id are required.', 'HELD_OPERATION_INVALID');
        }
        if (!/^[0-9a-f]{64}$/i.test(claimToken)) return sendError(res, 400, 'A valid held-order claim token is required.', 'HELD_CLAIM_TOKEN_REQUIRED');
        const submitted = Array.isArray(req.body?.cart) ? { items: req.body.cart } : req.body?.cart;
        if (!submitted || typeof submitted !== 'object' || !Array.isArray(submitted.items)) {
            return sendError(res, 400, 'A valid cart is required.', 'HELD_CART_INVALID');
        }

        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        await lockActiveCallCenterActor(conn, req.user);
        const existing = await heldLifecycle.selectHeldForUpdate(conn, id);
        if (isCallCenterRole(req.user)) await assertCallCenterHeldRow(conn, existing);
        const replay = heldLifecycle.readOperationReplay(existing, operationId, 'follow_up');
        if (replay) {
            await conn.commit();
            return sendSuccess(res, { ...replay, id, replay: true });
        }
        const row = existing;
        heldLifecycle.assertClaimedHeldOrder(row, { userId: req.user.id, claimToken, expectedVersion, now: new Date() });
        if (!isRegisterHold(row)) throw Object.assign(new Error('Held order not found.'), { statusCode: 404, publicCode: 'HELD_ORDER_NOT_FOUND' });
        if (Number(row.kitchen_fired) !== 1) {
            throw heldKitchenError('Fire the held order before sending a kitchen follow-up.', 409, 'HELD_KITCHEN_NOT_FIRED');
        }
        const kitchenSnapshot = parseKitchenSnapshot(row.kitchen_snapshot);
        if (!kitchenSnapshot) {
            throw heldKitchenError('This fired held order needs an explicit kitchen-baseline confirmation before it can receive a follow-up.', 409, 'HELD_KITCHEN_BASELINE_UNKNOWN');
        }

        let previousPayload = {};
        try { previousPayload = JSON.parse(row.cart_data || '{}'); } catch (_) {
            throw heldKitchenError('The held order cart needs manual review.', 409, 'HELD_KITCHEN_CART_INVALID');
        }
        if (isCallCenterRole(req.user)) {
            assertCallCenterContinuationPayload(previousPayload, submitted, req.body, row);
            Object.assign(submitted, normalizePhoneCustomer({ ...previousPayload, ...submitted }));
            await assertCallCenterOrderType(conn, submitted.order_type_id || previousPayload.order_type_id);
        }
        const { canonicalItems, canonicalSubtotal } = await canonicalizeHeldCart(conn, req.user, submitted, {
            accountingTaxInclusive: Number(previousPayload.tax_inclusive_at_hold) === 1,
            savedTaxRegistrationType: previousPayload.tax_registration_type_at_hold
        });
        const normalizedKitchenItems = await normalizeKitchenTicketItems(canonicalItems, {
            db: conn,
            linePrefix: `held-${id}`
        });
        const assignedItems = assignStableHeldLineIds(normalizedKitchenItems, {
            heldId: id,
            previousItems: Array.isArray(previousPayload.items) ? previousPayload.items : [],
            protectedLineIds: new Set(kitchenSnapshot.lines.map(line => String(line.held_line_id))),
            mode: 'update'
        }).items;

        // The snapshot stores expanded bundle children.  Compare the same
        // preparation-line representation so a bundle quantity increase is a
        // real positive delta instead of a false remove/re-add conflict.
        const delta = await computeHeldKitchenDelta(conn, kitchenSnapshot, assignedItems);
        if (delta.length === 0) {
            throw heldKitchenError('Add or increase an item before sending a kitchen follow-up.', 409, 'HELD_KITCHEN_NO_DELTA');
        }
        const sequence = Number(kitchenSnapshot.next_sequence || (Number(kitchenSnapshot.sequence) + 1));
        if (!Number.isSafeInteger(sequence) || sequence < 1) {
            throw heldKitchenError('The kitchen follow-up sequence is invalid.', 409, 'HELD_KITCHEN_SNAPSHOT_INVALID');
        }
        await ensureHeldOrderNumber(conn, row);
        const round = await queueHeldKitchenRound({
            db: conn,
            heldOrder: row,
            items: delta,
            operationId,
            sequence,
            kind: 'follow_up',
            previousSnapshot: kitchenSnapshot
        });
        const nextVersion = Number(row.version || 0) + 1;
        const nextDispatchVersion = Number(row.kitchen_dispatch_version || 0) + 1;
        const nextPayload = mergeHeldCartPayload(previousPayload, submitted, assignedItems);
        const safeResult = heldLifecycle.safeOperationResult({
            id,
            version: nextVersion,
            status: 'queued',
            followUpSequence: sequence,
            batchId: round.batchId,
            queueIds: round.queued.map(job => job.id),
            deltaCount: delta.reduce((sum, item) => sum + Number(item.delta_qty || item.qty || 0), 0),
            kitchenDispatchVersion: nextDispatchVersion
        });
        const [updated] = await conn.query(`
            UPDATE held_orders
               SET cart_data=?, subtotal=?, kitchen_snapshot=?, kitchen_dispatch_version=?,
                   claimed_by_user_id=NULL, claim_token_hash=NULL, claim_expires_at=NULL,
                   version=?, last_operation_id=?, last_operation_kind='follow_up', last_operation_result=?, updated_at=?
             WHERE id=? AND version=?
        `, [
            JSON.stringify(nextPayload), canonicalSubtotal, JSON.stringify(round.snapshot), nextDispatchVersion,
            nextVersion, operationId, JSON.stringify(safeResult), new Date(), id, row.version
        ]);
        if (Number(updated?.affectedRows) !== 1) throw Object.assign(new Error('Held order changed. Refresh and try again.'), { statusCode: 409, publicCode: 'HELD_VERSION_CONFLICT' });
        await heldLifecycle.appendHeldOrderAudit(conn, {
            actor: req.user,
            eventType: 'held_order_follow_up_queued',
            heldOrderId: id,
            oldVersion: row.version,
            newVersion: nextVersion,
            operationId,
            kitchen_sequence: sequence,
            delta_count: delta.reduce((sum, item) => sum + Number(item.delta_qty || item.qty || 0), 0),
            batch_id: round.batchId,
            ...heldSourceAudit(row)
        });
        await commitAndPublishSpoolerSyncWake(conn);
        emitHeldOrdersChanged(req.io, 'fired', row);
        return sendSuccess(res, { ...safeResult, id, replay: false });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        logger.error({ err: error, heldOrderId: id }, 'POST /held_orders/:id/follow-up failed');
        return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Operation failed. Please try again.', error.publicCode || null);
    } finally { if (conn) conn.release(); }
});

// POST /api/pos/held_orders/:id/baseline-confirm — acknowledge a legacy fired
// row whose historical kitchen print cannot be reconstructed. This never
// queues or dispatches a ticket; it only records the current canonical lines
// as the operator-confirmed baseline.
router.post('/held_orders/:id/baseline-confirm', requireAuth, rejectCallCenterRole, async (req, res) => {
    const id = Number(req.params.id);
    const operationId = heldOperationId(req.body?.operation_id);
    const expectedVersion = Number(req.body?.expected_version);
    const claimToken = String(req.body?.claim_token || '');
    const reasonCode = String(req.body?.reason_code || '');
    let conn;
    try {
        if (!canHoldOrders(req.user)) return sendError(res, 403, 'Forbidden: Hold order permission required.');
        if (!Number.isSafeInteger(id) || id <= 0 || !operationId || !Number.isInteger(expectedVersion) || expectedVersion < 1 || req.body?.confirmed !== true || !HELD_BASELINE_REASONS.has(reasonCode)) {
            return sendError(res, 400, 'A confirmed kitchen-baseline reason is required.', 'HELD_BASELINE_CONFIRMATION_REQUIRED');
        }
        if (!/^[0-9a-f]{64}$/i.test(claimToken)) return sendError(res, 400, 'A valid held-order claim token is required.', 'HELD_CLAIM_TOKEN_REQUIRED');
        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        const existing = await heldLifecycle.selectHeldForUpdate(conn, id);
        const replay = heldLifecycle.readOperationReplay(existing, operationId, 'baseline_confirm');
        if (replay) {
            await conn.commit();
            return sendSuccess(res, { ...replay, id, replay: true, printed: false });
        }
        const row = existing;
        heldLifecycle.assertClaimedHeldOrder(row, { userId: req.user.id, claimToken, expectedVersion, now: new Date() });
        if (!isRegisterHold(row)) throw Object.assign(new Error('Held order not found.'), { statusCode: 404, publicCode: 'HELD_ORDER_NOT_FOUND' });
        if (Number(row.kitchen_fired) !== 1) throw heldKitchenError('Kitchen baseline confirmation is only for fired held orders.', 409, 'HELD_KITCHEN_NOT_FIRED');
        if (parseKitchenSnapshot(row.kitchen_snapshot)) throw heldKitchenError('This held order already has a trusted kitchen baseline.', 409, 'HELD_KITCHEN_BASELINE_ALREADY_CONFIRMED');
        const current = readItemsFromHeldRow(row);
        const { canonicalItems, canonicalSubtotal } = await canonicalizeHeldCart(conn, req.user, current.parsed, {
            accountingTaxInclusive: Number(current.parsed?.tax_inclusive_at_hold) === 1,
            savedTaxRegistrationType: current.parsed?.tax_registration_type_at_hold
        });
        const assignedItems = assignStableHeldLineIds(canonicalItems, { heldId: id, mode: 'initial' }).items;
        const baseline = await buildHeldKitchenBaseline({ db: conn, heldOrder: row, items: assignedItems, operationId });
        const nextVersion = Number(row.version || 0) + 1;
        const safeResult = heldLifecycle.safeOperationResult({ id, order_display_no:formatOrderNumber(row), version: nextVersion, status: 'confirmed', kitchenDispatchVersion: Number(row.kitchen_dispatch_version || 0) });
        const nextPayload = { ...current.parsed, items: assignedItems };
        const [updated] = await conn.query(`
            UPDATE held_orders
               SET cart_data=?, subtotal=?, kitchen_snapshot=?,
                   claimed_by_user_id=NULL, claim_token_hash=NULL, claim_expires_at=NULL,
                   version=?, last_operation_id=?, last_operation_kind='baseline_confirm', last_operation_result=?, updated_at=?
             WHERE id=? AND version=?
        `, [JSON.stringify(nextPayload), canonicalSubtotal, JSON.stringify(baseline.snapshot), nextVersion, operationId, JSON.stringify(safeResult), new Date(), id, row.version]);
        if (Number(updated?.affectedRows) !== 1) throw Object.assign(new Error('Held order changed. Refresh and try again.'), { statusCode: 409, publicCode: 'HELD_VERSION_CONFLICT' });
        await heldLifecycle.appendHeldOrderAudit(conn, {
            actor: req.user,
            eventType: 'held_order_kitchen_baseline_confirmed',
            heldOrderId: id,
            oldVersion: row.version,
            newVersion: nextVersion,
            operationId,
            reason_code: reasonCode,
            printed: false,
            ...heldSourceAudit(row)
        });
        await conn.commit();
        emitHeldOrdersChanged(req.io, 'updated', row);
        return sendSuccess(res, { ...safeResult, id, replay: false, printed: false });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        logger.error({ err: error, heldOrderId: id }, 'POST /held_orders/:id/baseline-confirm failed');
        return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Operation failed. Please try again.', error.publicCode || null);
    } finally { if (conn) conn.release(); }
});

router.post('/held_orders/:id/release', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    let conn;
    try {
        if (!canUseHeldLifecycle(req.user)) return sendError(res, 403, 'Forbidden: Hold order permission required.');
        const operationId = heldOperationId(req.body?.operation_id);
        const expectedVersion = Number(req.body?.expected_version);
        const claimToken = String(req.body?.claim_token || '');
        if (!Number.isSafeInteger(id) || !operationId || !Number.isInteger(expectedVersion) || !/^[0-9a-f]{64}$/i.test(claimToken)) {
            return sendError(res, 400, 'A valid held-order release envelope is required.', 'HELD_OPERATION_INVALID');
        }
        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        await lockActiveCallCenterActor(conn, req.user);
        if (isCallCenterRole(req.user)) {
            const row = await heldLifecycle.selectHeldForUpdate(conn, id);
            await assertCallCenterHeldRow(conn, row);
        }
        const result = await heldLifecycle.releaseClaimedHeldOrder(conn, { id, userId: req.user.id, claimToken, expectedVersion, operationId, operationKind: 'release' });
        if (!result.replay) await heldLifecycle.appendHeldOrderAudit(conn, { actor: req.user, eventType: 'held_order_released', heldOrderId: id, oldVersion: expectedVersion, newVersion: result.version, operationId, ...heldSourceAudit(result) });
        await conn.commit();
        emitHeldOrdersChanged(req.io, 'released', result);
        return sendSuccess(res, { id, version: result.version, replay: result.replay === true });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Operation failed. Please try again.', error.publicCode || null);
    } finally { if (conn) conn.release(); }
});

router.delete('/held_orders/:id', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    let conn;
    try {
        if (!canUseHeldLifecycle(req.user)) return sendError(res, 403, 'Forbidden: Hold order permission required.');
        const operationId = heldOperationId(req.body?.operation_id);
        const expectedVersion = Number(req.body?.expected_version);
        const claimToken = String(req.body?.claim_token || '');
        const reasonCode = String(req.body?.reason_code || '');
        if (!Number.isSafeInteger(id) || !operationId || !Number.isInteger(expectedVersion) || req.body?.confirmed !== true || !HELD_CANCEL_REASONS.has(reasonCode)) {
            return sendError(res, 400, 'A confirmed cancellation reason is required.', 'HELD_CANCEL_CONFIRMATION_REQUIRED');
        }
        if (!/^[0-9a-f]{64}$/i.test(claimToken)) return sendError(res, 400, 'A valid held-order claim token is required.', 'HELD_CLAIM_TOKEN_REQUIRED');
        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        await lockActiveCallCenterActor(conn, req.user);
        const row = await heldLifecycle.lockClaimedHeldOrder(conn, { id, userId: req.user.id, claimToken, expectedVersion, now: new Date() });
        if (!isRegisterHold(row)) throw Object.assign(new Error('Held order not found.'), { statusCode: 404, publicCode: 'HELD_ORDER_NOT_FOUND' });
        if (isCallCenterRole(req.user)) await assertCallCenterHeldRow(conn, row);
        const replay = heldLifecycle.readOperationReplay(row, operationId, 'cancel');
        if (replay) { await conn.commit(); return sendSuccess(res, { id, version: replay.version, replay: true }); }
        let cancellationRound = null;
        if (Number(row.kitchen_fired) === 1) {
            const kitchenSnapshot = parseKitchenSnapshot(row.kitchen_snapshot);
            cancellationRound = await queueHeldKitchenCancellation({
                db: conn,
                heldOrder: row,
                operationId,
                snapshot: kitchenSnapshot
            });
        }
        if (row.service_charge_snapshot_id) {
            const snapshot = await getForUpdate(conn, row.service_charge_snapshot_id);
            if (snapshot.state === 'held') {
                await require('../../services/ServiceChargeSnapshotService').transition(conn, {
                    snapshotId: snapshot.id, version: snapshot.version, from: 'held', to: 'abandoned', holderType: 'none', holderId: null
                });
            }
        }
        const nextVersion = Number(row.version || 0) + 1;
        await heldLifecycle.appendHeldOrderAudit(conn, {
            actor: req.user,
            eventType: 'held_order_canceled',
            heldOrderId: id,
            oldVersion: row.version,
            newVersion: nextVersion,
            operationId,
            reason_code: reasonCode,
            kitchen_cancel_batch_id: cancellationRound?.batchId || null,
            kitchen_cancel_queue_ids: cancellationRound?.queued?.map(job => job.id) || [],
            ...heldSourceAudit(row)
        });
        const [deleted] = await conn.query('DELETE FROM held_orders WHERE id=? AND version=?', [id, row.version]);
        if (Number(deleted?.affectedRows) !== 1) throw Object.assign(new Error('Held order changed. Refresh and try again.'), { statusCode: 409, publicCode: 'HELD_VERSION_CONFLICT' });
        if (cancellationRound?.queued?.length > 0) await commitAndPublishSpoolerSyncWake(conn);
        else await conn.commit();
        emitHeldOrdersChanged(req.io, 'removed', row);
        return sendSuccess(res, {
            id,
            version: nextVersion,
            canceled: true,
            replay: false,
            cancellation_ticket_count: cancellationRound?.count || 0,
            cancellation_batch_id: cancellationRound?.batchId || null
        });
    } catch (error) {
        if (conn) await conn.rollback().catch(() => {});
        return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Operation failed. Please try again.', error.publicCode || null);
    } finally { if (conn) conn.release(); }
});

// POST /api/pos/held_orders
router.post('/held_orders', requireAuth, async (req, res) => {
    const data = req.body || {};
    const isPhoneHold = isCallCenterRole(req.user);
    let conn;
    try {
        if (!canHoldOrders(req.user) && !isPhoneHold) return sendError(res, 403, "Forbidden: Hold order permission required.");
        if (isPhoneHold) {
            const incomingCart = Array.isArray(data?.cart) ? { items: data.cart } : { ...(data?.cart || {}) };
            if (!Array.isArray(incomingCart.items) || incomingCart.items.length === 0) {
                return sendError(res, 400, 'Add at least one item to the phone order.', 'CALL_CENTER_CART_REQUIRED');
            }
            assertCallCenterInitialPayload(data, incomingCart);
            Object.assign(incomingCart, normalizePhoneCustomer(incomingCart));
            data.cart = incomingCart;
            data.reference_name = '';
            data.call_center_user_id = null;
        } else {
            if (data.cart && typeof data.cart === 'object' && !Array.isArray(data.cart)) {
                data.cart = { ...data.cart };
                delete data.cart.call_center_user_id;
            }
            data.call_center_user_id = null;
        }
        const holdRequestId = data?.hold_request_id == null || data.hold_request_id === ''
            ? crypto.randomUUID()
            : String(data.hold_request_id).trim();
        if (!/^[a-z0-9-]{16,64}$/i.test(holdRequestId)) {
            return sendError(res, 400, 'A valid hold request id is required.', 'HELD_REQUEST_ID_INVALID');
        }
        const taxExemptFieldPresent = Object.prototype.hasOwnProperty.call(data || {}, 'tax_exempt');
        if (taxExemptFieldPresent && typeof data.tax_exempt !== 'boolean') {
            return sendError(res, 400, 'Tax exemption must be a boolean.', 'TAX_EXEMPT_BOOLEAN_REQUIRED');
        }
        const taxExempt = data.tax_exempt === true;
        if (taxExempt && !canTaxExempt(req.user)) {
            return sendError(res, 403, 'Forbidden: You do not have permission to apply tax exemption.', 'TAX_EXEMPT_PERMISSION_REQUIRED');
        }

        if (data.cart === null || data.cart === undefined) {
            return sendError(res, 400, "A cart is required to hold an order.");
        }
        const heldSubtotal = Number(data.subtotal);
        if (!Number.isFinite(heldSubtotal) || heldSubtotal < 0) {
            return sendError(res, 400, "A valid subtotal is required to hold an order.");
        }
        const holdRequestFingerprint = buildHoldRequestFingerprint(data);

        // Reference name is optional. When blank, serialize one from our own system
        // using the row's auto-increment id ("Hold #<id>").
        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        const [[lockedActor]] = await conn.query('SELECT id, role, is_active FROM users WHERE id=? FOR UPDATE', [req.user.id]);
        if (isPhoneHold && (!lockedActor || lockedActor.role !== 'call_center' || Number(lockedActor.is_active) !== 1)) {
            throw callCenterError('Your call-center session changed. Sign in again.', 403, 'CALL_CENTER_SESSION_CHANGED');
        }
        let [[existingRequest]] = await conn.query(
            `SELECT id, reference_name, cart_data, subtotal, version, service_charge_snapshot_id,
                    kitchen_fired, kitchen_dispatch_version, kitchen_snapshot, order_id, order_seq_scope, user_id, created_at
               FROM held_orders
              WHERE user_id=? AND hold_request_id=?`,
            [req.user.id, holdRequestId]
        );
        if (existingRequest) {
            // The creator lock serializes new requests for this user. Avoid a
            // missing-key gap lock on the shared request index; lock an existing
            // row by its primary key to read current replay/print state.
            [[existingRequest]] = await conn.query('SELECT * FROM held_orders WHERE id=? FOR UPDATE', [existingRequest.id]);
            if (!existingRequest) throw Object.assign(new Error('This held order was completed. Refresh the held orders list.'), {statusCode:409});
            let existingPayload = null;
            try { existingPayload = JSON.parse(existingRequest.cart_data || '{}'); } catch (_) {}
            let requestMatches = existingPayload?._hold_request_fingerprint === holdRequestFingerprint;
            // Older writers hashed UUIDs as null. Recover their pending requests
            // only when the actual bound UUID independently proves the same fee.
            if (!requestMatches && existingRequest.service_charge_snapshot_id &&
                String(data.service_charge_snapshot?.id || '') === String(existingRequest.service_charge_snapshot_id)) {
                const legacyFingerprint = buildHoldRequestFingerprint({
                    ...data,
                    service_charge_snapshot: { ...data.service_charge_snapshot, id: null }
                });
                requestMatches = existingPayload?._hold_request_fingerprint === legacyFingerprint;
            }
            if (!requestMatches) {
                const error = new Error('This hold request id was already used for another order.');
                error.statusCode = 409;
                error.publicCode = 'HELD_OPERATION_CONFLICT';
                throw error;
            }
            const replaySnapshot = parseKitchenSnapshot(existingRequest.kitchen_snapshot);
            const replayPrinterIds = new Set(
                (replaySnapshot?.lines || [])
                    .flatMap(line => line.printer_ids || [])
                    .map(Number)
                    .filter(Number.isSafeInteger)
            );
            const customerReceipt = existingRequest.order_id != null && existingPayload?._customer_receipt_requested
                ? await prepareHeldCustomerReceipt(conn, existingRequest, { requestId:holdRequestId, replayBrowserOnly:true }) : null;
            await conn.commit();
            return sendSuccess(res, {
                id: existingRequest.id,
                order_display_no: formatOrderNumber(existingRequest),
                customer_receipt: customerReceipt,
                reference_name: existingRequest.reference_name,
                version: existingRequest.version,
                replay: true,
                kitchen_fired: Number(existingRequest.kitchen_fired) === 1,
                kitchen_ticket_count: replayPrinterIds.size,
                kitchen_dispatch_version: Number(existingRequest.kitchen_dispatch_version || 0)
            });
        }
        if (!isAdminUser(req.user)) {
            const countSql = isPhoneHold
                ? 'SELECT COUNT(*) AS cnt FROM held_orders WHERE call_center_user_id=?'
                : 'SELECT COUNT(*) AS cnt FROM held_orders WHERE user_id=?';
            const [[{ cnt }]] = await conn.query(countSql, [req.user.id]);
            if (Number(cnt) >= 20) {
                const error = new Error(isPhoneHold
                    ? 'Your phone-order queue already has 20 active orders. Ask a cashier to complete or cancel one before starting another.'
                    : 'Maximum of 20 held orders per cashier reached. Please delete an existing hold to continue.');
                error.statusCode = 409;
                error.publicCode = isPhoneHold ? 'CALL_CENTER_HOLD_LIMIT_REACHED' : 'HELD_ORDER_LIMIT_REACHED';
                throw error;
            }
        }
        const { receiptTaxInclusiveDisplay, taxRegistrationType, defaultOrderTypeId, orderTypeNumbering } = await loadCheckoutSettings(conn);
        const cartPayload = Array.isArray(data.cart) ? { items: data.cart } : { ...data.cart };
        if (isPhoneHold) {
            cartPayload.order_type_id = await assertCallCenterOrderType(conn, cartPayload.order_type_id);
        } else {
            cartPayload.delivery_date = normalizeHeldDeliveryDate(cartPayload.delivery_date);
            if (!cartPayload.order_type_id && defaultOrderTypeId) cartPayload.order_type_id = defaultOrderTypeId;
        }
        cartPayload.tax_inclusive_at_hold = 0;
        cartPayload.receipt_tax_inclusive_at_hold = receiptTaxInclusiveDisplay ? 1 : 0;
        cartPayload.tax_registration_type_at_hold = taxRegistrationType;
        if (taxExempt && taxRegistrationType === TAX_REGISTRATION_TYPES.INCOME_TAX) {
            const error = new Error('Tax exemption is not available under the income-tax registration profile.');
            error.statusCode = 400;
            error.publicCode = 'TAX_EXEMPT_INCOME_TAX_UNAVAILABLE';
            throw error;
        }
        cartPayload.tax_exempt_at_hold = taxExempt;
        cartPayload.tax_context_version = 1;
        // Keep the idempotency evidence inside the existing held row. It is
        // server-authored and excludes one-time service-charge claim tokens,
        // so a response-loss retry can replay without mistaking repricing or
        // canonicalization fields for a changed request.
        cartPayload._hold_request_fingerprint = holdRequestFingerprint;
        delete cartPayload._customer_receipt_requested;
        assertHeldItemStructure(cartPayload.items);
        assertNestedBundleIntegrity(cartPayload.items);
        let items = normalizeCartItems((cartPayload.items || []).map(item => ({
            ...item,
            price: item.price ?? item.price_at_sale ?? 0
        })));
        await validateBundleCartLines(conn, items, { requireBundleItems: true });
        await canonicalizeBundleCartLines(conn, items);
        for (const item of items) {
            if (Array.isArray(item.bundleItems)) item.bundle_snapshot_version = 1;
        }
        const productMap = await fetchCartProducts(conn, items);
        await attachRegisterPrices(conn, productMap);
        // Held tickets are always pinned to catalog prices; a manager may override at
        // an active checkout, but a parked payload must not freeze client-forged prices.
        applyDatabasePrices(items, productMap, { ...req.user, role: 'cashier', permissions: [] }, false, null);
        for (const item of items) {
            if (item.product_id != null) delete item.manual_price_override;
        }
        // tax_context_version:1 promises every persisted rate is server-authored.
        // Overwrite catalog rates from the DB and fail closed on a bad custom rate —
        // otherwise a forged/garbage client rate becomes trusted preview evidence.
        for (const item of items) {
            if (item.note === 'Auto-Gratuity') continue; // snapshot canonicalization owns the fee rate
            const product = item.product_id != null ? productMap.get(item.product_id) : null;
            const storedRate = product
                ? (Number(product.tax_rate) || 0)
                : validateTaxRate(item.tax_rate ?? 0);
            item.tax_rate = resolveEffectiveTaxRate(storedRate, taxRegistrationType);
            item.jofotara_tax_category = product?.jofotara_tax_category || item.jofotara_tax_category || 'O';
            if (product) {
                item.name = product.name;
                item.category_id = product.category_id;
            }
        }
        const submittedSnapshot = data.service_charge_snapshot || null;
        const hasFee = items.some(item => item.note === 'Auto-Gratuity');
        let snapshot = null;
        if (hasFee) {
            if (!canApplyServiceCharge(req.user)) {
                const error = new Error('Forbidden: You do not have permission to apply a service charge.');
                error.statusCode = 403;
                throw error;
            }
            if (!submittedSnapshot?.id) {
                const error = new Error('A service charge snapshot is required.');
                error.statusCode = 400;
                throw error;
            }
            snapshot = await getForUpdate(conn, submittedSnapshot.id);
            if (submittedSnapshot.claim_token) {
                if (snapshot.state !== 'claimed') {
                    const error = new Error('Service-charge claim changed or was already consumed.');
                    error.statusCode = 409;
                    error.publicCode = 'SERVICE_CHARGE_SNAPSHOT_CONFLICT';
                    throw error;
                }
            } else {
                assertDraftUsableBy(snapshot, req.user.id, submittedSnapshot.version);
            }
            items = canonicalizeServiceCharge(items, {
                id: snapshot.id, percentage: snapshot.percentage, taxRate: snapshot.tax_rate,
                taxCategory: snapshot.jofotara_tax_category
            }, { taxInclusivePricing: false, taxRegistrationType, taxExempt }).items;
        }
        for (const item of items) {
            if (item.note === 'Auto-Gratuity') continue;
            const product = item.product_id != null ? productMap.get(item.product_id) : null;
            item.selectedModifiers = buildSelectedModifiersSnapshot(product, item, productMap);
        }
        cartPayload.items = items;
        const canonicalSubtotal = items.reduce(
            (sum, item) => sum + calculateLineSubtotal(
                item,
                item.tax_rate,
                false,
                { taxRegistrationType, taxExempt }
            ),
            0
        );
        const reference = (data.reference_name || '').toString().trim();
        const [result] = await conn.query(
            "INSERT INTO held_orders (user_id, call_center_user_id, hold_request_id, reference_name, cart_data, subtotal, service_charge_snapshot_id) VALUES (?, ?, ?, ?, ?, ?, NULL)",
            [req.user.id, isPhoneHold ? req.user.id : null, holdRequestId, reference || '', JSON.stringify(cartPayload), canonicalSubtotal]
        );
        if (snapshot) {
            if (submittedSnapshot.claim_token) {
                await consumeClaim(conn, {
                    snapshotId: snapshot.id, version: submittedSnapshot.version,
                    claimToken: submittedSnapshot.claim_token, userId: req.user.id,
                    to: 'held', holderType: 'held_order', holderId: String(result.insertId)
                });
            } else {
                await bindDraft(conn, {
                    snapshotId: snapshot.id, version: submittedSnapshot.version, userId: req.user.id,
                    state: 'held', holderType: 'held_order', holderId: String(result.insertId)
                });
            }
            await conn.query('UPDATE held_orders SET service_charge_snapshot_id=? WHERE id=?', [snapshot.id, result.insertId]);
        } else if (submittedSnapshot?.claim_token) {
            const claimed = await getForUpdate(conn, submittedSnapshot.id);
            await consumeClaim(conn, {
                snapshotId: claimed.id, version: submittedSnapshot.version,
                claimToken: submittedSnapshot.claim_token, userId: req.user.id,
                to: 'abandoned', holderType: 'none', holderId: null
            });
        }
        let referenceName = reference;
        if (!referenceName) {
            referenceName = isPhoneHold ? `Phone #${result.insertId}` : `Hold #${result.insertId}`;
            await conn.query("UPDATE held_orders SET reference_name = ? WHERE id = ?", [referenceName, result.insertId]);
        }
        let autoFireRound = null;
        let customerReceipt = null;
        const [[createdHeld]] = await conn.query('SELECT * FROM held_orders WHERE id=? FOR UPDATE', [result.insertId]);
        if (shouldAutoFireHeldOrder(cartPayload)) {
            await ensureHeldOrderNumber(conn, createdHeld, { separateByType: orderTypeNumbering });
            const automatic = await queueAutomaticHeldKitchenRound({
                db: conn,
                heldOrder: { ...createdHeld, reference_name: referenceName },
                items,
                operationId: holdRequestId
            });
            autoFireRound = automatic.round;
            if (autoFireRound) {
                cartPayload.items = automatic.items;
                const [updated] = await conn.query(`
                    UPDATE held_orders
                       SET cart_data=?, kitchen_fired=1, kitchen_snapshot=?, kitchen_dispatch_version=1
                     WHERE id=? AND kitchen_fired=0
                `, [JSON.stringify(cartPayload), JSON.stringify(autoFireRound.snapshot), result.insertId]);
                if (Number(updated?.affectedRows) !== 1) {
                    throw heldKitchenError('Held order changed. Refresh and try again.', 409, 'HELD_VERSION_CONFLICT');
                }
            }
        }
        if (shouldAutoFireHeldOrder(cartPayload)) {
            customerReceipt = await prepareHeldCustomerReceipt(conn, {...createdHeld,cart_data:JSON.stringify(cartPayload)}, {
                printerId:data.receipt_printer_id,requestId:'initial',automatic:true
            });
        }
        if (taxExempt) {
            await appendAuditEvent(conn, {
                eventType: 'tax_exempt_hold_created',
                userId: req.user.id,
                entityType: 'held_order',
                entityId: result.insertId,
                newValue: {
                    tax_exempt_at_hold: true,
                    subtotal: Number(canonicalSubtotal),
                    tax_registration_type: taxRegistrationType
                },
                ipAddress: req.ip || null
            });
        }
        await heldLifecycle.appendHeldOrderAudit(conn, {
            actor: req.user,
            eventType: 'held_order_created',
            heldOrderId: result.insertId,
            newVersion: 1,
            operationId: holdRequestId,
            ...(isPhoneHold ? { call_center_user_id: Number(req.user.id) } : {})
        });
        if (autoFireRound) {
            await heldLifecycle.appendHeldOrderAudit(conn, {
                actor: req.user,
                eventType: 'held_order_kitchen_fired',
                heldOrderId: result.insertId,
                newVersion: 1,
                operationId: holdRequestId,
                deltaCount: autoFireRound.count,
                kitchen_sequence: 1,
                ...(isPhoneHold ? { call_center_user_id: Number(req.user.id) } : {})
            });
            await commitAndPublishSpoolerSyncWake(conn);
        } else if (customerReceipt?.mode === 'backend') {
            await commitAndPublishSpoolerSyncWake(conn);
        } else {
            await conn.commit();
        }
        emitHeldOrdersChanged(
            req.io,
            'created',
            createdHeld,
            isPhoneHold ? { source: 'call_center' } : {}
        );
        return sendSuccess(res, {
            id: result.insertId,
            order_display_no: formatOrderNumber(createdHeld),
            customer_receipt: customerReceipt,
            reference_name: referenceName,
            version: 1,
            hold_request_id: holdRequestId,
            kitchen_fired: Boolean(autoFireRound),
            kitchen_ticket_count: autoFireRound?.count || 0,
            kitchen_dispatch_version: autoFireRound ? 1 : 0
        });
    } catch (e) {
        logger.error({ err: e }, 'POST /held_orders failed');
        if (conn) await conn.rollback().catch(() => {});
        sendError(res, e.statusCode || 500, e.statusCode ? e.message : "Operation failed. Please try again.", e.publicCode || null);
    } finally {
        if (conn) conn.release();
    }
});

// Print a saved register hold under its durable queue number, never an invoice.
router.post('/held_orders/:id/print_receipt', requireAuth, rejectCallCenterRole, async (req, res) => {
    const id = Number(req.params.id);
    const requestId = heldOperationId(req.body?.print_request_id);
    let conn;
    try {
        if (!canHoldOrders(req.user)) return sendError(res, 403, 'Forbidden: Hold order permission required.');
        if (!Number.isSafeInteger(id) || id < 1 || !requestId) return sendError(res, 400, 'Held order and print request id are required.');
        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        const [[row]] = await conn.query('SELECT * FROM held_orders WHERE id=? FOR UPDATE', [id]);
        if (!row || !isRegisterHold(row)) throw Object.assign(new Error('Held order not found.'), {statusCode:404});
        if (!userCanAccessOrderForPrint(req.user, row)) throw Object.assign(new Error('Forbidden: Receipt reprint permission required.'), {statusCode:403});
        await ensureHeldOrderNumber(conn, row);
        const receipt = await prepareHeldCustomerReceipt(conn, row, {printerId:req.body.receipt_printer_id, requestId});
        await commitAndPublishSpoolerSyncWake(conn);
        emitHeldOrdersChanged(req.io, 'updated', row);
        return sendSuccess(res, {order_display_no:formatOrderNumber(row), customer_receipt:receipt});
    } catch(error) {
        if (conn) await conn.rollback().catch(() => {});
        sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Unable to print the held order.');
    } finally { if (conn) conn.release(); }
});

// POST /api/pos/held_orders/fire_kitchen — fire held order items to kitchen printers without claiming/deleting the hold
router.post('/held_orders/fire_kitchen', requireAuth, rejectCallCenterRole, async (req, res) => {
    const id = parseInt(req.body.id, 10);
    const operationId = heldOperationId(req.body?.operation_id);
    const expectedVersion = Number(req.body?.expected_version);
    const claimToken = String(req.body?.claim_token || '');
    let conn;
    try {
        if (!canHoldOrders(req.user)) return sendError(res, 403, "Forbidden: Hold order permission required.");
        if (!id || !operationId || !Number.isInteger(expectedVersion) || expectedVersion < 1) return sendError(res, 400, "Held order ID, version, and operation id are required.", 'HELD_OPERATION_INVALID');

        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        const [[row]] = await conn.query("SELECT * FROM held_orders WHERE id = ? FOR UPDATE", [id]);
        if (!row || !isRegisterHold(row)) {
            const error = new Error('Held order not found.');
            error.statusCode = 404;
            throw error;
        }
        const activeClaim = row.claimed_by_user_id != null && row.claim_expires_at && new Date(row.claim_expires_at).getTime() > Date.now();
        if (activeClaim && !(Number(row.claimed_by_user_id) === Number(req.user.id) && heldLifecycle.verifyClaimToken(claimToken, row.claim_token_hash))) {
            throw Object.assign(new Error('Held order is being edited on another terminal.'), { statusCode: 409, publicCode: 'HELD_IN_USE' });
        }
        if (!activeClaim && Number(row.version) !== expectedVersion) {
            throw Object.assign(new Error('Held order changed. Refresh and try again.'), { statusCode: 409, publicCode: 'HELD_VERSION_CONFLICT' });
        }
        const replay = heldLifecycle.readOperationReplay(row, operationId, 'fire');
        if (replay) {
            await conn.commit();
            return sendSuccess(res, { ...replay, replay: true, kitchen_fired: true });
        }
        if (Number(row.kitchen_fired) === 1) {
            throw heldKitchenError('This held order is already fired. Use FOLLOW UP for new items.', 409, 'HELD_KITCHEN_ALREADY_FIRED');
        }

        let rawItems;
        try {
            const parsed = JSON.parse(row.cart_data);
            if (Array.isArray(parsed)) {
                rawItems = parsed;
            } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
                rawItems = parsed.items;
            } else {
                throw bundleOrderCorruptionError();
            }
        } catch (error) {
            if (error.publicCode === BUNDLE_ORDER_CORRUPT) throw error;
            throw bundleOrderCorruptionError();
        }
        assertHeldItemStructure(rawItems);
        assertNestedBundleIntegrity(rawItems);
        assertOrderItemBundleIntegrity(rawItems);
        await canonicalizeBundleCartLines(conn, rawItems);

        const normalizedItems = await normalizeKitchenTicketItems(rawItems, {
            db: conn,
            linePrefix: `held-${id}`
        });
        const assigned = assignStableHeldLineIds(normalizedItems, { heldId: id, mode: 'initial' });
        const canonicalCart = (() => {
            try {
                const parsed = JSON.parse(row.cart_data || '{}');
                return Array.isArray(parsed) ? { items: assigned.items } : { ...parsed, items: assigned.items };
            } catch (_) { return { items: assigned.items }; }
        })();
        await ensureHeldOrderNumber(conn, row);
        const round = await queueHeldKitchenRound({
            db: conn,
            io: req.io,
            heldOrder: row,
            items: assigned.items,
            operationId,
            sequence: 1,
            kind: 'initial'
        });
        const nextVersion = Number(row.version) + 1;
        const nextDispatchVersion = Number(row.kitchen_dispatch_version || 0) + 1;
        const safeResult = heldLifecycle.safeOperationResult({ id, order_display_no:formatOrderNumber(row), version: nextVersion, status: 'queued', deltaCount: round.count, queueIds: round.queued.map(job => job.id), batchId: round.batchId, kitchenDispatchVersion: nextDispatchVersion });
        const [versioned] = await conn.query(`
            UPDATE held_orders
               SET cart_data=?, kitchen_fired=1, kitchen_snapshot=?, version=?, kitchen_dispatch_version=?,
                   last_operation_id=?, last_operation_kind='fire', last_operation_result=?, updated_at=?
             WHERE id=? AND version=?
        `, [JSON.stringify(canonicalCart), JSON.stringify(round.snapshot), nextVersion, nextDispatchVersion, operationId, JSON.stringify(safeResult), new Date(), id, row.version]);
        if (Number(versioned?.affectedRows) !== 1) throw Object.assign(new Error('Held order changed. Refresh and try again.'), { statusCode: 409, publicCode: 'HELD_VERSION_CONFLICT' });
        await heldLifecycle.appendHeldOrderAudit(conn, { actor: req.user, eventType: 'held_order_kitchen_fired', heldOrderId: id, oldVersion: row.version, newVersion: nextVersion, operationId, deltaCount: round.count, kitchen_sequence: 1, ...heldSourceAudit(row) });
        await commitAndPublishSpoolerSyncWake(conn);
        emitHeldOrdersChanged(req.io, 'fired', row);
        return sendSuccess(res, { order_display_no:formatOrderNumber(row), count: round.count, version: nextVersion, kitchen_fired: true, kitchen_dispatch_version: nextDispatchVersion, message: `${round.count} kitchen ticket(s) sent.` });
    } catch (e) {
        if (conn) { try { await conn.rollback(); } catch (_) {} }
        logger.error({ err: e }, 'POST /held_orders/fire_kitchen failed');
        sendError(
            res,
            e.statusCode || 500,
            e.statusCode ? e.message : 'Operation failed. Please try again.',
            e.publicCode || null
        );
    } finally {
        if (conn) conn.release();
    }
});

// The old unscoped DELETE route could remove a row without a lease or confirmation.
router.delete('/held_orders', requireAuth, async (_req, res) => {
    return sendError(res, 410, 'The old held-order delete route is retired.', 'HELD_DELETE_ROUTE_RETIRED');
});

// GET /api/pos/order_notes
router.get('/order_notes', requireAuth, rejectCallCenterRole, async (req, res) => {
    // Normalized grant only — legacy can_view_order_history was backfilled into orders.view.
    const isAuthorized = canViewOrders(req.user);
    if (!isAuthorized) {
        return sendError(res, 403, "Forbidden: Access to order notes is restricted.");
    }

    try {
        // Fetch orders from the last 24 hours to handle shifts spanning past midnight correctly
        const [rows] = await pool.query(`
            SELECT o.invoice_id, o.order_id, o.order_seq_scope, o.created_at, o.total, o.payment_method,
                   u.name as cashier_name, o.call_center_user_id,
                   source.name as call_center_user_name,
                   ot.name as order_type_name, ot.id as order_type_id,
                   t.table_number, o.table_id, o.delivery_date,
                   o.invoice_number, o.invoice_issued_at,
                   o.subtotal, o.tax, o.discount_type, o.discount_value,
                   o.original_subtotal, o.original_tax, o.original_total, o.refund_status,
                   o.tax_inclusive_at_sale, o.receipt_tax_inclusive_at_sale, o.tax_exempt_at_sale
            FROM orders o
            LEFT JOIN users u ON o.user_id = u.id
            LEFT JOIN users source ON o.call_center_user_id = source.id
            LEFT JOIN order_types ot ON o.order_type_id = ot.id
            LEFT JOIN restaurant_tables t ON o.table_id = t.id
            WHERE o.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
               OR o.delivery_date > ${businessLocalTimestampSql('UTC_TIMESTAMP()')}
            ORDER BY o.invoice_id DESC
            LIMIT 200
        `);

        if (rows.length === 0) {
            return sendSuccess(res, { orders: [] });
        }

        const orders = rows.map(row => ({ ...row, ...buildOrderIdentity(row) }));

        // Fetch all items for these orders
        const invoiceIds = orders.map(o => o.invoice_id);
        const [items] = await pool.query(`
            SELECT oi.*, COALESCE(oi.item_name, p.name) as product_name
            FROM order_items oi
            LEFT JOIN products p ON oi.product_id = p.id
            WHERE oi.invoice_id IN (${invoiceIds.map(() => '?').join(',')})
        `, invoiceIds);

        // Group items by invoice_id
        const itemsByInvoice = {};
        for (const item of items) {
            if (!itemsByInvoice[item.invoice_id]) {
                itemsByInvoice[item.invoice_id] = [];
            }
            // Ingredient margins belong to the admin analysis, not POS history.
            const { recipe_cost_snapshot, ...publicItem } = item;
            itemsByInvoice[item.invoice_id].push(publicItem);
        }

        // Attach items and build presentation to orders
        for (const order of orders) {
            order.items = itemsByInvoice[order.invoice_id] || [];
            try {
                const resRead = buildOrderPresentationForRead({ order, items: order.items });
                if (resRead.presentation) {
                    order.receipt_display_v1 = resRead.presentation;
                } else {
                    order.receipt_display_legacy_reason = resRead.legacyReason;
                }
            } catch (error) {
                order.receipt_display_error = error.publicCode || error.code || 'RECEIPT_PRESENTATION_INVALID';
            }
        }

        return sendSuccess(res, { orders });
    } catch (e) {
        logger.error({ err: e }, 'POS /order_notes endpoint failed');
        return sendError(res, 500, "Failed to retrieve order notes.");
    }
});

module.exports = router;
