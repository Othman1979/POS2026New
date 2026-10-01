const { getConnection: getStockConnection } = require('../../services/StockReportInvalidation');
const {
    validateBundleCartLines,
    insertBundleChildren,
    insertPersistedBundleChildren,
    insertSnapshotBundleChildren
} = require('../../services/bundleOrderItems');
const { getBusinessDate, normalizeScheduledDateTime } = require('../../utils/businessDate');
const { ensurePaidInvoiceNumber } = require('../../utils/invoiceSequence');
const { buildOrderIdentity } = require('../../utils/orderIdentity');
const { reserveDailyOrderIdentity } = require('../../utils/orderSequence');
const { findOwnedCheckoutAttempt } = require('../../services/CheckoutAttemptService');
const { canonicalizeServiceCharge } = require('../../services/ServiceChargeCalculator');
const {
    getForUpdate,
    assertDraftUsableBy,
    bindDraft,
    abandonDraft,
    transition,
    consumeClaim
} = require('../../services/ServiceChargeSnapshotService');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { normalizeCartItems, stampLineTax, roundMoney, exemptUnitPrice } = require('../../services/PosCalculator');
const { emitHeldOrdersChanged } = require('../../services/HeldOrderEvents');
const cache = require('../../config/cache');
const { broadcastTableUpdates } = require('../../services/TableRealtime');
const activeCheckoutLocks = new Set();
const { prepareStockWrite, fetchCartProducts, deductStockForCart, restockOrderItems } = require('../../services/InventoryService');
const { announceStockChanged } = require('../../services/StockEventScope');
const stockSnapshots = require('../../services/StockSaleSnapshots');
const { applyDatabasePrices, hasUnfrozenPriceOverride, loadCheckoutSettings } = require('../../services/OrderPricing');
const { assignLineKey, syncOrderLines, reverseLinesUsage } = require('../../services/RecipeLedgerService');
const { captureInvoiceCosts } = require('../../services/IngredientAnalysisService');
const reportInvalidation = require('../../services/StockReportInvalidation');
const { hasDiscountsInPayload, assertNearMoney, validatePayments } = require('../../services/CheckoutValidation');
const { resolveLineTaxRate, buildSelectedModifiersSnapshot, calculateExpectedTotals } = require('../../services/PosCalculator');
const {
    TAX_REGISTRATION_TYPES,
    normalizeTaxRegistrationType,
    resolveJofotaraSaleTaxCategory
} = require('../../config/taxRegistration');
const { buildOrderPresentation, buildOrderPresentationForRead } = require('../../services/ReceiptPresentationSources');
const { allocateCents, moneyToCents, validateSplitMoneyCents } = require('../../services/SplitMoneyAllocator');
const {
    BUNDLE_ORDER_CORRUPT,
    assertHeldItemStructure,
    assertOrderItemBundleIntegrity,
    assertNestedBundleIntegrity
} = require('../../services/bundleIntegrity');
const {
    lockTableSession,
    reconcileSavedTableSettlement
} = require('../../services/TableSettlementContext');
const { appendAuditEvent, appendDiscountAuditEvents } = require('../../services/auditEvents');
const heldLifecycle = require('../../services/HeldOrderLifecycleService');
const {
    parseKitchenSnapshot,
    assignStableHeldLineIds,
    computePositiveKitchenDelta
} = require('../../services/HeldOrderKitchenDispatch');
const { expandBundlesForKitchen, filterRoutableKitchenLines, buildKitchenPrintPayloads } = require('../../services/kitchenPrintRouting');
const { normalizeKitchenTicketItems } = require('../../services/kitchenTicketItems');
const { enqueuePrintJobs } = require('../../services/printDispatch');
const { commitAndPublishSpoolerSyncWake } = require('../../services/spoolerSyncWake');
const { normalizeCustomerPhone } = require('../../services/customerPhone');
const {
    PERMISSIONS,
    userHas,
    isAdminRole: isAdminUser,
    isCallCenterRole,
    hasDiscountPermission,
    canPriceOverride,
    canApplyServiceCharge,
    canCheckoutOrder,
    canTaxExempt
} = require('../../services/PermissionService');
const {
    savedLineKey,
    buildSavedLineIndex,
    resolveCheckoutSavedLine,
    priceMapFor,
    taxOverridesFor
} = require('../orders/SavedOrderLines');
const { assertNoActiveSplitChecks, lockSplitCheckForMutation } = require('../tables/splitChecks');

async function buildDuplicateCheckoutResponse(queryable, existingOrder) {
    const [orders] = await queryable.query(
        "SELECT * FROM orders WHERE invoice_id = ? LIMIT 1",
        [existingOrder.invoice_id]
    );
    const order = orders[0] || {};
    const [items] = await queryable.query(
        "SELECT * FROM order_items WHERE invoice_id = ?",
        [existingOrder.invoice_id]
    );

    const subtotal = Number(order.subtotal) || 0;
    const discountValue = Number(order.discount_value) || 0;
    const discount = order.discount_type === 'percent'
        ? roundMoney(subtotal * discountValue / 100)
        : (order.discount_type === 'fixed' ? discountValue : 0);
    const identity = buildOrderIdentity(order);

    let receipt_display_v1 = undefined;
    let receipt_display_legacy_reason = undefined;

    try {
        const resRead = buildOrderPresentationForRead({ order, items });
        if (resRead.presentation) {
            receipt_display_v1 = resRead.presentation;
        } else {
            receipt_display_legacy_reason = resRead.legacyReason;
        }
    } catch (error) {
        if (error.publicCode === BUNDLE_ORDER_CORRUPT) throw error;
        if (error.code === 'RECEIPT_PRESENTATION_INVALID' && order.tax_inclusive_at_sale != null) {
            throw error;
        }
        logger.warn({ err: error }, 'Duplicate checkout pre-v1 presentation mismatch');
    }

    return {
        message: "Order processed (duplicate request).",
        duplicate: true,
        invoice_id: existingOrder.invoice_id,
        order_id: existingOrder.order_id,
        ...identity,
        order_taken_at: order.created_at || null,
        created_at: order.created_at || null,
        subtotal,
        tax: Number(order.tax) || 0,
        total: Number(order.total) || 0,
        discount,
        discount_type: order.discount_type || null,
        discount_value: discountValue,
        amount_tendered: Number(order.amount_tendered) || 0,
        change_due: Number(order.change_due) || 0,
        cash_amount: Number(order.cash_amount) || 0,
        card_amount: Number(order.card_amount) || 0,
        payment_method: order.payment_method || null,
        tax_registration_type_at_sale: order.tax_registration_type_at_sale || TAX_REGISTRATION_TYPES.SALES_TAX,
        tax_exempt: Number(order.tax_exempt_at_sale) === 1,
        ...(receipt_display_v1 ? { receipt_display_v1 } : {}),
        ...(receipt_display_legacy_reason ? { receipt_display_legacy_reason } : {})
    };
}

async function executeCheckout({
    user,
    input,
    io,
    ipAddress = null,
    authorizeManagerOverride,
    platformHeldOrderId = null,
    expectedPlatformOrderTypeId = null,
    heldOrderContext = null
}) {
    if (!user) {
        const error = new Error('Unauthorized: Invalid or expired session.');
        error.statusCode = 401;
        throw error;
    }
    if (isCallCenterRole(user)) {
        const error = new Error('Forbidden: Call center users cannot checkout orders.');
        error.statusCode = 403;
        throw error;
    }
    const data = input;
    if (data?.subscription_purchase != null) {
        const error = new Error('Subscriptions are no longer available.');
        error.statusCode = 410;
        error.publicCode = 'SUBSCRIPTIONS_RETIRED';
        throw error;
    }
    if (data?.payment_method === 'receivable') {
        const error = new Error('Receivable subscription checkout is no longer available.');
        error.statusCode = 410;
        error.publicCode = 'SUBSCRIPTIONS_RETIRED';
        throw error;
    }
    const taxExemptFieldPresent = Object.prototype.hasOwnProperty.call(data || {}, 'tax_exempt');
    if (taxExemptFieldPresent && typeof data.tax_exempt !== 'boolean') {
        const error = new Error('Tax exemption must be a boolean.');
        error.statusCode = 400;
        error.publicCode = 'TAX_EXEMPT_BOOLEAN_REQUIRED';
        throw error;
    }
    let taxExempt = data?.tax_exempt === true;
    const isPlatformHeldSettle = platformHeldOrderId != null;
    const isOrdinaryHeldCheckout = heldOrderContext != null && !isPlatformHeldSettle;
    if (isPlatformHeldSettle) {
        const heldId = Number(platformHeldOrderId);
        if (!Number.isSafeInteger(heldId) || heldId <= 0) {
            const error = new Error('Invalid platform held order.');
            error.statusCode = 400;
            throw error;
        }
        const expectedOrderTypeId = Number(expectedPlatformOrderTypeId);
        if (!Number.isSafeInteger(expectedOrderTypeId) || expectedOrderTypeId <= 0) {
            const error = new Error('Invalid platform order type.');
            error.statusCode = 400;
            throw error;
        }
        data.idempotency_key = `platform-held:${heldId}`;
        data.edit_invoice_id = null;
        data.table_id = null;
        data.split_check_id = null;
        data.parent_invoice_id = null;
    }
    const editInvoiceId = data.edit_invoice_id || null;
    let isDirectPlatformCheckout = false;
    const approvalManagerIds = new Map();
    const heldAuditActor = user ? { id: user.id, role: user.role } : null;
    let conn;
    let hasTransaction = false;
    let customerPhoneLockName = null;

    const releaseCustomerPhoneLock = async () => {
        if (!conn || !customerPhoneLockName) return;
        const lockName = customerPhoneLockName;
        customerPhoneLockName = null;
        try {
            await conn.query("SELECT RELEASE_LOCK(SHA2(CONCAT(DATABASE(), ':', ?), 256)) AS released", [lockName]);
        } catch (error) {
            // Never return a connection carrying a session-level lock to the pool.
            logger.error({ err: error }, 'Customer phone lock release failed; destroying checkout connection.');
            try { conn.destroy(); } catch (_) { /* connection is already unusable */ }
            conn = null;
        }
    };

    let approvedActions;
    let approvalManagerId = null;
    const applyManagerOverride = async action => {
        if (!data.manager_pin) return false;
        if (!approvedActions) {
            const result = await authorizeManagerOverride(data.manager_pin, conn);
            approvalManagerId = result?.managerId ?? null;
            approvedActions = new Set(result?.approvedActions || []);
        }
        const approved = approvedActions.has(action);
        if (approved && approvalManagerId != null) {
            approvalManagerIds.set(action, approvalManagerId);
        }
        return approved;
    };
    const managerForAction = action => approvalManagerIds.get(action) ?? null;

    if (editInvoiceId) {
        if (activeCheckoutLocks.has(editInvoiceId)) {
            const error = new Error("This order is currently being checked out by another terminal. Please refresh.");
            error.statusCode = 409;
            // The original request is still running: not a refusal of the payload.
            error.publicCode = 'CHECKOUT_IN_PROGRESS';
            throw error;
        }
        activeCheckoutLocks.add(editInvoiceId);
    }

    try {
        conn = await getStockConnection(pool);

        if (data.idempotency_key) {
            const existing = await findOwnedCheckoutAttempt(conn, {
                key: data.idempotency_key,
                userId: user.id
            });
            if (existing) {
                return await buildDuplicateCheckoutResponse(conn, existing);
            }
        }

        if (data.edit_invoice_id) {
            // JoFotara compliance: a finalized invoice is immutable. Only an as-yet-unpaid
            // table order may be edited (the table-cashout flow). No role — not even admin —
            // may edit a finalized order. Pre-flight fast-fail before opening the transaction;
            // a missing order falls through to the locked 404 check below.
            const [orderCheck] = await conn.query(
                "SELECT payment_method, table_id FROM orders WHERE invoice_id = ?",
                [data.edit_invoice_id]
            );
            if (orderCheck.length && orderCheck[0].payment_method !== 'unpaid_table') {
                const err = new Error("Forbidden: Finalized invoices cannot be edited.");
                err.statusCode = 403;
                throw err;
            }
            if (orderCheck[0]?.payment_method === 'unpaid_table' && !data.table_id) {
                const boundTableId = Number(orderCheck[0].table_id);
                if (!Number.isSafeInteger(boundTableId) || boundTableId <= 0) {
                    const err = new Error('Conflict: This table order is no longer linked to a live table.');
                    err.statusCode = 409;
                    err.publicCode = 'TABLE_SESSION_CONFLICT';
                    throw err;
                }
                // The invoice owns this binding. The transaction context locks and
                // revalidates it before any checkout mutation.
                data.table_id = boundTableId;
            }
        }

        await conn.beginTransaction();
        hasTransaction = true;

        // Holds lock their creator before the daily counter. Acquire the user FK
        // lock in that order too, rather than waiting for it at INSERT after we
        // own the counter. Shared locks allow concurrent sales by the same user.
        await conn.query('SELECT id FROM users WHERE id=? LOCK IN SHARE MODE', [user.id]);

        let heldRow = null;
        let heldPayload = null;
        if (isOrdinaryHeldCheckout) {
            const heldId = Number(heldOrderContext?.id);
            const heldVersion = Number(heldOrderContext?.expected_version ?? heldOrderContext?.version);
            const heldToken = String(heldOrderContext?.claim_token || heldOrderContext?.claimToken || '');
            if (!Number.isSafeInteger(heldId) || heldId <= 0 || !Number.isInteger(heldVersion) || heldVersion < 1 || !/^[0-9a-f]{64}$/i.test(heldToken)) {
                const error = new Error('Held order context is invalid. Refresh the held order.');
                error.statusCode = 409;
                error.publicCode = 'HELD_OPERATION_INVALID';
                throw error;
            }
            heldRow = await heldLifecycle.lockClaimedHeldOrder(conn, {
                id: heldId, userId: user.id, claimToken: heldToken, expectedVersion: heldVersion, now: new Date()
            });
            if (heldRow.parent_invoice_id != null || heldRow.table_id != null) {
                const error = new Error('This held order is not a register order.');
                error.statusCode = 404;
                error.publicCode = 'HELD_ORDER_NOT_FOUND';
                throw error;
            }
            let heldKitchenSnapshot = null;
            if (Number(heldRow.kitchen_fired) === 1) {
                heldKitchenSnapshot = parseKitchenSnapshot(heldRow.kitchen_snapshot);
                if (!heldKitchenSnapshot) {
                    const error = new Error('This held order needs a kitchen baseline confirmation before checkout.');
                    error.statusCode = 409;
                    error.publicCode = 'HELD_KITCHEN_BASELINE_UNKNOWN';
                    throw error;
                }
            }
            try {
                const parsed = typeof heldRow.cart_data === 'string' ? JSON.parse(heldRow.cart_data) : heldRow.cart_data;
                heldPayload = Array.isArray(parsed) ? { items: parsed } : parsed;
            } catch (_) {
                const error = new Error('Held order data is invalid.');
                error.statusCode = 409;
                error.publicCode = 'HELD_CART_INVALID';
                throw error;
            }
            assertHeldItemStructure(heldPayload?.items);
            assertNestedBundleIntegrity(heldPayload?.items);
            assertOrderItemBundleIntegrity(heldPayload?.items);
            if (heldKitchenSnapshot) {
                const assignedItems = assignStableHeldLineIds(heldPayload.items, {
                    heldId,
                    previousItems: heldPayload.items,
                    protectedLineIds: new Set(heldKitchenSnapshot.lines.map(line => String(line.held_line_id))),
                    mode: 'update'
                }).items;
                const routableBaseline = (await filterRoutableKitchenLines(conn, heldKitchenSnapshot.lines)).routable;
                const currentPreparationLines = (await filterRoutableKitchenLines(conn, expandBundlesForKitchen(assignedItems))).routable;
                const outstandingDelta = computePositiveKitchenDelta({
                    baseline: routableBaseline,
                    current: currentPreparationLines
                });
                if (outstandingDelta.length > 0) {
                    const error = new Error('Send the new items to the kitchen as a FOLLOW UP before checkout.');
                    error.statusCode = 409;
                    error.publicCode = 'HELD_KITCHEN_FOLLOW_UP_REQUIRED';
                    throw error;
                }
            }
            data.cart = heldPayload.items;
            data.order_type_id = heldPayload.order_type_id || data.order_type_id || null;
            data.customer_name = heldPayload.customer_name || data.customer_name || '';
            data.customer_phone = heldPayload.customer_phone || data.customer_phone || '';
            data.customer_address = heldPayload.customer_address || data.customer_address || '';
            data.delivery_date = heldPayload.delivery_date || data.delivery_date || null;
            data.order_note = heldPayload.order_note || data.order_note || null;
            data.order_discount_type = heldPayload.order_discount?.type || data.order_discount_type || null;
            data.order_discount_value = Number(heldPayload.order_discount?.value ?? data.order_discount_value) || 0;
            data.hash_number = heldPayload.hash_number || data.hash_number || null;
            data.tax_exempt = heldPayload.tax_exempt_at_hold === true || heldPayload.tax_exempt_at_hold === 1 || heldPayload.tax_exempt_at_hold === '1';
            if (heldRow.service_charge_snapshot_id) {
                data.service_charge_snapshot = {
                    id: heldRow.service_charge_snapshot_id,
                    version: null,
                    held_order_id: heldRow.id
                };
            }
            data.table_id = null;
            data.split_check_id = null;
            data.edit_invoice_id = null;
        }

        let splitHeldPayload = null;
        let settledSplitRow = null;
        let trustedSplitMoney = null;
        let splitSnapshotId = null;
        let heldParentInvoiceId = null;
        let hasTrustedSplitBundleSnapshot = false;
        let platformHeldRow = null;
        let platformHeldPayload = null;
        let platformSnapshotId = null;
        let hasTrustedSplitProvenance = false;
        let isProgressiveSplit = false;
        let remainingSplitCount = null;
        let progressiveTableContext = null;
        if (isPlatformHeldSettle) {
            const [heldRows] = await conn.query('SELECT * FROM held_orders WHERE id = ? FOR UPDATE', [platformHeldOrderId]);
            platformHeldRow = heldRows[0] || null;
            if (!platformHeldRow) {
                const existing = await findOwnedCheckoutAttempt(conn, {
                    key: data.idempotency_key,
                    userId: user.id
                });
                if (existing) {
                    await conn.rollback();
                    hasTransaction = false;
                    return await buildDuplicateCheckoutResponse(conn, existing);
                }
                const error = new Error('Platform held order is no longer available.');
                error.statusCode = 409;
                error.publicCode = 'PLATFORM_HELD_ORDER_UNAVAILABLE';
                throw error;
            }
            if (platformHeldRow.parent_invoice_id != null || platformHeldRow.table_id != null) {
                const error = new Error('Platform held order is no longer available.');
                error.statusCode = 409;
                error.publicCode = 'PLATFORM_HELD_ORDER_UNAVAILABLE';
                throw error;
            }
            if (platformHeldRow.call_center_user_id != null) {
                const error = new Error('Phone orders must be completed through the normal register workflow.');
                error.statusCode = 409;
                error.publicCode = 'CALL_CENTER_PLATFORM_SETTLEMENT_FORBIDDEN';
                throw error;
            }
            try {
                const parsed = typeof platformHeldRow.cart_data === 'string'
                    ? JSON.parse(platformHeldRow.cart_data)
                    : platformHeldRow.cart_data;
                platformHeldPayload = Array.isArray(parsed) ? { items: parsed } : parsed;
            } catch (_) {
                const error = new Error('Platform held order is invalid.');
                error.statusCode = 409;
                error.publicCode = 'PLATFORM_HELD_ORDER_INVALID';
                throw error;
            }
            assertHeldItemStructure(platformHeldPayload?.items);
            assertNestedBundleIntegrity(platformHeldPayload?.items);
            assertOrderItemBundleIntegrity(platformHeldPayload?.items);
            if (Number(platformHeldPayload.tax_context_version) !== 1 ||
                ![0, 1].includes(Number(platformHeldPayload.tax_inclusive_at_hold))) {
                const error = new Error('Platform held order tax context is invalid.');
                error.statusCode = 409;
                error.publicCode = 'PLATFORM_TAX_CONTEXT_INVALID';
                throw error;
            }
            if (Object.prototype.hasOwnProperty.call(platformHeldPayload, 'tax_exempt_at_hold') &&
                ![true, false, 0, 1, '0', '1'].includes(platformHeldPayload.tax_exempt_at_hold)) {
                const error = new Error('Platform held order tax context is invalid.');
                error.statusCode = 409;
                error.publicCode = 'PLATFORM_TAX_CONTEXT_INVALID';
                throw error;
            }
            let heldTaxRegistrationType;
            try {
                heldTaxRegistrationType = normalizeTaxRegistrationType(platformHeldPayload.tax_registration_type_at_hold);
            } catch (_) {
                const error = new Error('Platform held order tax context is invalid.');
                error.statusCode = 409;
                error.publicCode = 'PLATFORM_TAX_CONTEXT_INVALID';
                throw error;
            }
            const orderTypeId = Number(platformHeldPayload.order_type_id);
            if (!Number.isSafeInteger(orderTypeId) || orderTypeId <= 0) {
                const error = new Error('Platform held order type is invalid.');
                error.statusCode = 409;
                error.publicCode = 'PLATFORM_ORDER_TYPE_INVALID';
                throw error;
            }
            if (orderTypeId !== Number(expectedPlatformOrderTypeId)) {
                const error = new Error('Held order belongs to another platform provider.');
                error.statusCode = 409;
                error.publicCode = 'PLATFORM_ORDER_TYPE_MISMATCH';
                throw error;
            }
            const [[orderType]] = await conn.query(
                'SELECT id, is_active, is_deferred_settlement FROM order_types WHERE id = ? FOR UPDATE',
                [orderTypeId]
            );
            if (!orderType || Number(orderType.is_active) !== 1 || Number(orderType.is_deferred_settlement) !== 1) {
                const error = new Error('This held order type is not configured for platform settlement.');
                error.statusCode = 409;
                error.publicCode = 'PLATFORM_ORDER_TYPE_INVALID';
                throw error;
            }
            data.cart = platformHeldPayload.items;
            data.order_type_id = orderTypeId;
            data.customer_name = platformHeldPayload.customer_name || '';
            data.customer_phone = platformHeldPayload.customer_phone || '';
            data.customer_address = platformHeldPayload.customer_address || '';
            data.delivery_date = platformHeldPayload.delivery_date || null;
            data.order_note = platformHeldPayload.order_note || '';
            data.order_discount_type = platformHeldPayload.order_discount?.type || null;
            data.order_discount_value = Number(platformHeldPayload.order_discount?.value) || 0;
            data.hash_number = platformHeldPayload.hash_number || null;
            data.service_charge_snapshot = platformHeldPayload.service_charge_snapshot || null;
            data.payment_method = 'platform';
            data.amount_tendered = 0;
            data.cash_amount = 0;
            data.card_amount = 0;
            data.change_due = 0;
            platformSnapshotId = platformHeldRow.service_charge_snapshot_id || null;
            platformHeldPayload.tax_registration_type_at_hold = heldTaxRegistrationType;
            platformHeldPayload.tax_exempt_at_hold =
                platformHeldPayload.tax_exempt_at_hold === true ||
                platformHeldPayload.tax_exempt_at_hold === 1 ||
                platformHeldPayload.tax_exempt_at_hold === '1';
        }
        if (data.split_check_id) {
            const lockedSplit = await lockSplitCheckForMutation(conn, data.split_check_id, user);
            if (!lockedSplit) {
                throw new Error("Conflict: This split check has already been paid or modified on another terminal.");
            }
            const rows = [lockedSplit.row];
            settledSplitRow = lockedSplit.row;
            progressiveTableContext = lockedSplit.tableContext;
            isProgressiveSplit = lockedSplit.progressive;
            remainingSplitCount = lockedSplit.progressive ? lockedSplit.siblings.length - 1 : null;
            // P0-2: bind the split check to the table being settled. A split's held row records
            // the parent order it was split from (cart_data.parent_invoice_id, server-set at split
            // creation — not client-forgeable); that parent order's table must equal this request's
            // table_id. Without this, a settle could pair an unrelated split_check_id with an
            // arbitrary table_id — deleting the unrelated held row (seat data loss) and skipping the
            // named table's release (stranding it on a finalized invoice). Checked BEFORE the DELETE
            // so a mismatch mutates nothing.
            try {
                const parsed = typeof rows[0].cart_data === 'string' ? JSON.parse(rows[0].cart_data) : rows[0].cart_data;
                splitHeldPayload = Array.isArray(parsed) ? { items: parsed } : parsed;
                heldParentInvoiceId = splitHeldPayload && splitHeldPayload.parent_invoice_id != null ? splitHeldPayload.parent_invoice_id : null;
            } catch (_) { splitHeldPayload = null; }
            assertHeldItemStructure(splitHeldPayload?.items);
            assertNestedBundleIntegrity(splitHeldPayload?.items);
            assertOrderItemBundleIntegrity(splitHeldPayload?.items);
            splitSnapshotId = rows[0].service_charge_snapshot_id || null;
            if (!data.table_id || heldParentInvoiceId == null) {
                throw new Error("Conflict: This split check is not linked to the selected table.");
            }
            hasTrustedSplitProvenance = false;
            if (Number(splitHeldPayload.progressive_split_version) === 2) {
                // Only split creation/rewrite writes these relations; register hold
                // APIs cannot create or edit them. Validate the locked server row,
                // not optional audit history (which xyz intentionally suppresses).
                hasTrustedSplitProvenance = Boolean(isProgressiveSplit && progressiveTableContext &&
                    Number(rows[0].parent_invoice_id) === Number(heldParentInvoiceId) &&
                    Number(progressiveTableContext.order.invoice_id) === Number(heldParentInvoiceId) &&
                    Number(rows[0].table_id) === Number(progressiveTableContext.rootTable.id));
            } else {
                const [splitProvenanceRows] = await conn.query(
                    `SELECT new_value
                     FROM audit_events
                     WHERE event_type = 'split_check_created'
                       AND entity_type = 'held_order'
                       AND entity_id = ?
                     ORDER BY id DESC
                     LIMIT 1`,
                    [rows[0].id]
                );
                try {
                    const provenance = typeof splitProvenanceRows[0]?.new_value === 'string'
                        ? JSON.parse(splitProvenanceRows[0].new_value)
                        : splitProvenanceRows[0]?.new_value;
                    const lockedParentInvoiceId = Number(heldParentInvoiceId);
                    hasTrustedSplitProvenance = Number.isSafeInteger(lockedParentInvoiceId) &&
                        provenance?.parent_invoice_id === lockedParentInvoiceId;
                } catch (_) {
                    // Legacy checks still require their original provenance.
                }
            }
            if (!hasTrustedSplitProvenance) {
                const error = new Error('Conflict: This split check cannot be authenticated.');
                error.statusCode = 409;
                throw error;
            }
            if (Object.prototype.hasOwnProperty.call(splitHeldPayload, 'split_money_cents')) {
                try {
                    trustedSplitMoney = validateSplitMoneyCents(splitHeldPayload.split_money_cents);
                } catch (_) {
                    const error = new Error('Conflict: Split money allocation is invalid.');
                    error.statusCode = 409;
                    throw error;
                }
            }
            const [[splitParentOrder]] = await conn.query(
                "SELECT table_id, order_type_id, payment_method, tax_registration_type_at_sale, tax_exempt_at_sale FROM orders WHERE invoice_id = ?",
                [heldParentInvoiceId]
            );
            if (!splitParentOrder || String(splitParentOrder.table_id) !== String(data.table_id)) {
                throw new Error("Conflict: This split check does not belong to the selected table.");
            }
            // Split seats inherit their table's type; an unrelated register selection
            // must not move a seat into a different daily order sequence.
            data.order_type_id = splitParentOrder.order_type_id;
            splitHeldPayload.tax_registration_type_at_hold = splitParentOrder.tax_registration_type_at_sale
                || TAX_REGISTRATION_TYPES.SALES_TAX;
            splitHeldPayload.tax_exempt_at_hold = Number(splitParentOrder.tax_exempt_at_sale) === 1;
            isProgressiveSplit = Number(splitHeldPayload.progressive_split_version) === 2;
            if (isProgressiveSplit) {
                const storedRevision = Number(splitHeldPayload.split_revision || 1);
                const expectedRevision = Number(data.split_revision || 1);
                if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== storedRevision) {
                    const error = new Error('Conflict: This split check changed on another terminal. Refresh and try again.');
                    error.statusCode = 409;
                    error.publicCode = 'SPLIT_GROUP_CHANGED';
                    throw error;
                }
                if (splitParentOrder.payment_method !== 'unpaid_table' ||
                    Number(rows[0].parent_invoice_id) !== Number(heldParentInvoiceId) ||
                    Number(rows[0].table_id) !== Number(data.table_id)) {
                    const error = new Error('Conflict: This progressive split is no longer linked to its live table.');
                    error.statusCode = 409;
                    throw error;
                }
                if (!progressiveTableContext) {
                    const error = new Error('Conflict: This progressive split could not lock its live table.');
                    error.statusCode = 409;
                    throw error;
                }
            }

            const carriesSnapshotMarker = Array.isArray(splitHeldPayload?.items) &&
                splitHeldPayload.items.some(item =>
                    item?.bundle_snapshot_version === 1 && Array.isArray(item.bundleItems)
                );
            hasTrustedSplitBundleSnapshot = hasTrustedSplitProvenance && carriesSnapshotMarker;
            await conn.query("DELETE FROM held_orders WHERE id = ?", [data.split_check_id]);
        }

        let originalShiftId = null;
        let originalTotal = null;
        let originalSubtotal = null;
        let originalPaymentMethod = null;
        let isShiftClosed = false;
        let lockedOrderId = null;
        let lockedOrderScope = null;
        let boundTableSnapshotId = null;
        let taxInclusiveAtSaleFromLock = null;
        let receiptTaxInclusiveAtSaleFromLock = null;
        let taxRegistrationTypeAtSaleFromLock = null;
        let taxExemptAtSaleFromLock = null;
        let tableContext = progressiveTableContext;
        const isSavedTableCandidate = !!(
            data.edit_invoice_id && data.table_id && !data.split_check_id
        );

        // Every paid checkout takes the cashier shift lock before any table/order/item
        // lock. Register sales use the same order, preventing shift <-> order_items
        // deadlocks when a register sale races a saved-table settlement.
        let shiftId = data.shift_id || null;
        if (shiftId) {
            const [shiftRows] = await conn.query(
                'SELECT status, user_id FROM shifts WHERE id = ? FOR UPDATE',
                [shiftId]
            );
            if (shiftRows.length === 0) {
                shiftId = null;
            } else if (
                shiftRows[0].status === 'closed' ||
                String(shiftRows[0].user_id) !== String(user.id)
            ) {
                const [activeShiftRows] = await conn.query(
                    "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
                    [user.id]
                );
                shiftId = activeShiftRows.length > 0 ? activeShiftRows[0].id : null;
            }
        }
        if (!shiftId) {
            const [activeShiftRows] = await conn.query(
                "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
                [user.id]
            );
            shiftId = activeShiftRows.length > 0 ? activeShiftRows[0].id : null;
        }
        data.shift_id = shiftId;

        if (isSavedTableCandidate) {
            tableContext = await lockTableSession(conn, {
                user,
                tableId: data.table_id,
                invoiceId: data.edit_invoice_id,
                withMoney: true
            });
            data.table_id = tableContext.rootTable.id;
            await assertNoActiveSplitChecks(conn, data.edit_invoice_id);
        }

        if (data.edit_invoice_id) {
            let lockedOrder = tableContext?.order || null;
            if (!lockedOrder) {
                const [orderLock] = await conn.query(
                    "SELECT payment_method, shift_id, total, subtotal, order_id, order_seq_scope, service_charge_snapshot_id, tax_inclusive_at_sale, receipt_tax_inclusive_at_sale, tax_registration_type_at_sale, tax_exempt_at_sale FROM orders WHERE invoice_id = ? FOR UPDATE",
                    [data.edit_invoice_id]
                );
                if (!orderLock.length) {
                    const error = new Error('Order not found.');
                    error.statusCode = 404;
                    throw error;
                }
                lockedOrder = orderLock[0];
            }
            originalPaymentMethod = lockedOrder.payment_method;
            if (tableContext && data.order_type_id == null) {
                data.order_type_id = lockedOrder.order_type_id;
            }
            originalShiftId = lockedOrder.shift_id;
            originalTotal = Number(lockedOrder.total);
            originalSubtotal = Number(lockedOrder.subtotal);
            lockedOrderScope = lockedOrder.order_seq_scope;
            lockedOrderId = lockedOrder.order_id; // null for new open tables
            boundTableSnapshotId = lockedOrder.service_charge_snapshot_id || null;
            taxInclusiveAtSaleFromLock = lockedOrder.tax_inclusive_at_sale;
            receiptTaxInclusiveAtSaleFromLock = lockedOrder.receipt_tax_inclusive_at_sale;
            taxRegistrationTypeAtSaleFromLock = lockedOrder.tax_registration_type_at_sale;
            taxExemptAtSaleFromLock = lockedOrder.tax_exempt_at_sale;

            // JoFotara compliance: finalized invoices are immutable. Authoritative check
            // under the row lock — only an unpaid table order may be edited, regardless of role.
            if (originalPaymentMethod !== 'unpaid_table') {
                const err = new Error("Forbidden: Finalized invoices cannot be edited.");
                err.statusCode = 403;
                throw err;
            }

            if (originalShiftId) {
                const [shiftCheck] = await conn.query("SELECT status FROM shifts WHERE id = ?", [originalShiftId]);
                isShiftClosed = shiftCheck.length > 0 && shiftCheck[0].status === 'closed';
            }
        }

        // Table orders are created only at the table (POST /table_order, waiter-gated).
        // Checkout may SETTLE an existing unpaid table order (or a split check) but must
        // never CREATE a new order on a table — otherwise a cashier could ring up a
        // brand-new order on an empty table and skip the kitchen entirely. Admins bypass
        // (trusted/audited, and they can already create via /table_order), matching the
        // other table gates. Split-check settles legitimately carry table_id without an
        // edit_invoice_id, so they are exempt.
        const isUnpaidTableSettle = originalPaymentMethod === 'unpaid_table';
        // Only split_check_id grants the create-gate exemption — it is validated under
        // a row lock above (the held_orders row must still exist). parent_invoice_id is
        // a client-supplied hint with no server validation; trusting it would let a
        // cashier forge a "split settle" on an empty table and ring up a brand-new
        // finalized order with no kitchen ticket (kitchen-bypass).
        const isSplitSettle = !!data.split_check_id;
        // Normal register orders never accept arbitrary client-supplied lineage. Keep the
        // legacy split caller only when its parent is a real table lifecycle row. This
        // cannot bypass the create gate because only locked split_check_id sets isSplitSettle.
        let trustedParentInvoiceId = isSplitSettle ? Number(heldParentInvoiceId) : null;
        let trustedParentWaiterId = null;
        if (!isSplitSettle && data.parent_invoice_id) {
            const [[legacyParent]] = await conn.query(
                `SELECT table_id, payment_method, waiter_id
                 FROM orders
                 WHERE invoice_id = ?`,
                [data.parent_invoice_id]
            );
            const isTableLifecycleParent = legacyParent?.table_id != null &&
                ['unpaid_table', 'voided'].includes(legacyParent.payment_method);
            if (isTableLifecycleParent) {
                trustedParentInvoiceId = Number(data.parent_invoice_id);
                trustedParentWaiterId = legacyParent.waiter_id || null;
            }
        }
        // Server-authoritative split discount: re-apply the order discount recorded on the
        // held check (distributed at split time from the already-authorized parent order).
        // Never trust the checkout payload's discount fields for a split settle.
        if (isSplitSettle && splitHeldPayload && splitHeldPayload.order_discount) {
            data.order_discount_type = splitHeldPayload.order_discount.type || null;
            data.order_discount_value = Number(splitHeldPayload.order_discount.value) || 0;
        }
        if (isSplitSettle) {
            if (!splitHeldPayload || !Array.isArray(splitHeldPayload.items) || splitHeldPayload.items.length === 0) {
                throw new Error("Conflict: This split check has no payable items.");
            }
            data.cart = splitHeldPayload.items;
        }
        if (data.table_id && !isUnpaidTableSettle && !isSplitSettle && !isPlatformHeldSettle && !isAdminUser(user)) {
            const err = new Error("This table has no open order to cash out. The order must be taken at the table first.");
            err.statusCode = 403;
            throw err;
        }

        // Enforce shift check for cashier transactions (paid checkout)
        if (!shiftId && user.role !== 'admin' && user.role !== 'programmer') {
            throw new Error("An active open shift is required to checkout finalized orders.");
        }
        // This function only finalizes orders. Open table orders are created by
        // saveTableOrder, so a browser payment label must never bypass checkout auth.
        const mayCheckout = canCheckoutOrder(user, { tablePayment: isUnpaidTableSettle || isSplitSettle });
        if (!mayCheckout) {
            const err = new Error("Forbidden: You are not authorized to check out orders.");
            err.statusCode = 403;
            throw err;
        }

        // Resolve table_id to parent_table_id if it's joined and lock its persisted order.
        let tablePersistedInvoiceId = null;
        if (tableContext && !isSplitSettle) {
            tablePersistedInvoiceId = tableContext.order.invoice_id;
        } else if (data.table_id) {
            const [[tblRow]] = await conn.query(
                "SELECT parent_table_id, current_order_id FROM restaurant_tables WHERE id = ? FOR UPDATE",
                [data.table_id]
            );
            if (tblRow && tblRow.parent_table_id) {
                data.table_id = tblRow.parent_table_id;
                const [[parentTable]] = await conn.query(
                    "SELECT current_order_id FROM restaurant_tables WHERE id = ? FOR UPDATE",
                    [data.table_id]
                );
                tablePersistedInvoiceId = parentTable?.current_order_id || null;
            } else {
                tablePersistedInvoiceId = tblRow?.current_order_id || null;
            }
        }

        const checkoutSettings = await loadCheckoutSettings(conn);
        const stockEnabled = checkoutSettings.stockEnabled;
        // Saved stock can be restored into products.stock even while tracking is off.
        let savedStockRestored = false;
        // New register sales always use normal net-plus-tax accounting. The
        // setting is only a customer-copy presentation preference.
        let accountingTaxInclusive = false;
        let receiptTaxInclusiveDisplay = checkoutSettings.receiptTaxInclusiveDisplay;
        let taxRegistrationType = checkoutSettings.taxRegistrationType;

        let customer_id = null;
        let frozenBuyer = null;
        const persistCheckoutCustomer = async (captureBuyer) => {
            if (data.customer_phone) {
                const normalizedPhone = normalizeCustomerPhone(data.customer_phone);
                customerPhoneLockName = `posapp:customer:${normalizedPhone}`;
                // Match admin writes without contending with other databases on this server.
                const [[phoneLock]] = await conn.query(
                    "SELECT GET_LOCK(SHA2(CONCAT(DATABASE(), ':', ?), 256), 5) AS acquired",
                    [customerPhoneLockName]
                );
                if (Number(phoneLock?.acquired) !== 1) {
                    customerPhoneLockName = null;
                    const error = new Error('This customer is being updated by another checkout. Try again.');
                    error.statusCode = 503;
                    error.publicCode = 'CUSTOMER_PHONE_BUSY';
                    throw error;
                }
                const [customers] = await conn.query(
                    `SELECT id
                       FROM customers
                      WHERE phone_normalized = ?
                      ORDER BY id ASC
                      LIMIT 2
                      FOR UPDATE`,
                    [normalizedPhone]
                );
                if (customers.length > 1) {
                    const error = new Error('More than one customer uses this phone number. Ask a manager to correct the duplicate customer records.');
                    error.statusCode = 409;
                    error.publicCode = 'CUSTOMER_PHONE_AMBIGUOUS';
                    throw error;
                }
                if (customers.length === 1) {
                    customer_id = Number(customers[0].id);
                    await conn.query(
                        'UPDATE customers SET name = ?, address = ? WHERE id = ?',
                        [data.customer_name, data.customer_address, customer_id]
                    );
                } else {
                    const [result] = await conn.query(
                        'INSERT INTO customers (phone, name, address) VALUES (?, ?, ?)',
                        [normalizedPhone, data.customer_name, data.customer_address]
                    );
                    customer_id = Number(result.insertId);
                }
                if (captureBuyer) {
                    const [[buyer]] = await conn.query(
                        'SELECT name, phone, address FROM customers WHERE id = ? FOR UPDATE',
                        [customer_id]
                    );
                    frozenBuyer = buyer;
                }
            }
        };
        if (isOrdinaryHeldCheckout) {
            accountingTaxInclusive = Number(heldPayload?.tax_inclusive_at_hold) === 1;
            receiptTaxInclusiveDisplay = heldPayload?.receipt_tax_inclusive_at_hold != null
                ? Number(heldPayload.receipt_tax_inclusive_at_hold) === 1
                : accountingTaxInclusive;
        }
        if (isUnpaidTableSettle && taxInclusiveAtSaleFromLock != null) {
            accountingTaxInclusive = Number(taxInclusiveAtSaleFromLock) === 1;
            receiptTaxInclusiveDisplay = receiptTaxInclusiveAtSaleFromLock != null
                ? Number(receiptTaxInclusiveAtSaleFromLock) === 1
                : accountingTaxInclusive;
        }
        if (isUnpaidTableSettle) {
            taxRegistrationType = taxRegistrationTypeAtSaleFromLock == null
                ? TAX_REGISTRATION_TYPES.SALES_TAX
                : normalizeTaxRegistrationType(taxRegistrationTypeAtSaleFromLock);
            if (taxRegistrationTypeAtSaleFromLock == null) {
                await conn.query(
                    'UPDATE orders SET tax_registration_type_at_sale = ? WHERE invoice_id = ?',
                    [taxRegistrationType, data.edit_invoice_id]
                );
            }
        }
        if (isSplitSettle && splitHeldPayload?.tax_inclusive_at_sale != null) {
            accountingTaxInclusive = Number(splitHeldPayload.tax_inclusive_at_sale) === 1;
            receiptTaxInclusiveDisplay = splitHeldPayload.receipt_tax_inclusive_at_hold != null
                ? Number(splitHeldPayload.receipt_tax_inclusive_at_hold) === 1
                : accountingTaxInclusive;
        }
        if (isSplitSettle) {
            taxRegistrationType = normalizeTaxRegistrationType(
                splitHeldPayload.tax_registration_type_at_hold
            );
        }
        if (isPlatformHeldSettle) {
            accountingTaxInclusive = Number(platformHeldPayload.tax_inclusive_at_hold) === 1;
            receiptTaxInclusiveDisplay = platformHeldPayload.receipt_tax_inclusive_at_hold != null
                ? Number(platformHeldPayload.receipt_tax_inclusive_at_hold) === 1
                : accountingTaxInclusive;
            taxRegistrationType = platformHeldPayload.tax_registration_type_at_hold;
        }

        // Tax exemption is an order fact, not a client-controlled truthy flag. A
        // locked table/split/platform context is authoritative; ordinary register
        // checkouts and claimed holds must prove the dedicated permission here.
        const lockedTableTaxExempt = Number(taxExemptAtSaleFromLock) === 1;
        const heldTaxExempt = isSplitSettle
            ? splitHeldPayload?.tax_exempt_at_hold === true
            : (isPlatformHeldSettle ? platformHeldPayload?.tax_exempt_at_hold === true : false);
        const serverLockedTaxContext = isSplitSettle || isPlatformHeldSettle
            ? heldTaxExempt
            : (isUnpaidTableSettle && lockedTableTaxExempt);
        if (isSplitSettle || isPlatformHeldSettle) {
            if (taxExemptFieldPresent && data.tax_exempt !== heldTaxExempt) {
                const error = new Error('Conflict: Locked tax-exemption context changed.');
                error.statusCode = 409;
                error.publicCode = 'TAX_EXEMPT_CONTEXT_MISMATCH';
                throw error;
            }
            taxExempt = heldTaxExempt;
        } else if (isUnpaidTableSettle && !taxExemptFieldPresent) {
            taxExempt = lockedTableTaxExempt;
        }
        if (taxExempt && taxRegistrationType === TAX_REGISTRATION_TYPES.INCOME_TAX) {
            const error = new Error('Tax exemption is not available under the income-tax registration profile.');
            error.statusCode = 400;
            error.publicCode = 'TAX_EXEMPT_INCOME_TAX_UNAVAILABLE';
            throw error;
        }
        const changingLockedTableTaxContext = isUnpaidTableSettle &&
            taxExemptFieldPresent && taxExempt !== lockedTableTaxExempt;
        if ((taxExempt || changingLockedTableTaxContext) && !serverLockedTaxContext &&
            !isAdminUser(user) && !canTaxExempt(user)) {
            const error = new Error('Forbidden: You do not have permission to apply tax exemption.');
            error.statusCode = 403;
            error.publicCode = 'TAX_EXEMPT_PERMISSION_REQUIRED';
            throw error;
        }
        data.tax_exempt = taxExempt;
        const pricesAlreadyExempt = isUnpaidTableSettle && taxExempt;

        if (!data.table_id && !data.edit_invoice_id && !data.order_type_id && checkoutSettings.defaultOrderTypeId) {
            data.order_type_id = checkoutSettings.defaultOrderTypeId;
        }

        // Sanitize & Validate hash_number based on order type requirements
        let sanitizedHash = null;
        if (data.order_type_id) {
            const [otRows] = await conn.query(
                'SELECT requires_hash, is_active, is_deferred_settlement FROM order_types WHERE id = ?',
                [data.order_type_id]
            );
            const orderType = otRows[0] || null;
            const isDirectRegisterCheckout = !isPlatformHeldSettle && !isOrdinaryHeldCheckout &&
                !data.table_id && !data.edit_invoice_id && !data.split_check_id;
            if (isDirectRegisterCheckout && (!orderType || Number(orderType.is_active) !== 1)) {
                const error = new Error('The selected order type is no longer available.');
                error.statusCode = 409;
                error.publicCode = 'ORDER_TYPE_UNAVAILABLE';
                throw error;
            }
            if (isDirectRegisterCheckout && typeof data.order_type_is_deferred_settlement !== 'boolean') {
                const error = new Error('Order type context is stale. Refresh order types and try again.');
                error.statusCode = 409;
                error.publicCode = 'ORDER_TYPE_CONTEXT_REQUIRED';
                throw error;
            }
            const serverDeferredSettlement = Number(orderType?.is_deferred_settlement) === 1;
            if (isDirectRegisterCheckout && data.order_type_is_deferred_settlement !== serverDeferredSettlement) {
                const error = new Error('Order type settlement changed. Review payment and try again.');
                error.statusCode = 409;
                error.publicCode = 'ORDER_TYPE_SETTLEMENT_CHANGED';
                throw error;
            }
            isDirectPlatformCheckout = (isDirectRegisterCheckout || isOrdinaryHeldCheckout) &&
                (isOrdinaryHeldCheckout || Number(orderType?.is_active) === 1) &&
                serverDeferredSettlement;
            if (orderType?.requires_hash === 1) {
                sanitizedHash = data.hash_number ? String(data.hash_number).replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim().slice(0, 100) : '';
                if (!sanitizedHash) {
                    throw new Error("A Hash Number is required for this order type.");
                }
            }
        }

        assertNestedBundleIntegrity(data.cart);
        const submittedCartItems = normalizeCartItems(data.cart);
        let cartItems = submittedCartItems;
        let tableSettlement = null;
        if (tableContext && !isSplitSettle) {
            tableSettlement = reconcileSavedTableSettlement({
                context: tableContext,
                submittedItems: submittedCartItems
            });
            cartItems = tableSettlement.items;
            data.order_discount_type = tableSettlement.orderDiscount.type;
            data.order_discount_value = tableSettlement.orderDiscount.value;
        }
        if (!isSplitSettle) {
            for (const item of cartItems) {
                if (item) delete item.recipe_line_key;
            }
        }
        const submittedSnapshot = data.service_charge_snapshot || null;
        const isHeldSnapshotCheckout = isOrdinaryHeldCheckout && !!heldRow?.service_charge_snapshot_id;
        const isClaimedCheckout = !!submittedSnapshot?.claim_token;
        const isDirectSnapshotCheckout = !isPlatformHeldSettle && !isSplitSettle && !isUnpaidTableSettle && !isClaimedCheckout && !isHeldSnapshotCheckout;
        // A table settle whose order has no bound snapshot yet — the service charge was added at
        // the register without an intervening table save — binds the submitted draft here, exactly
        // like a direct register checkout. Without this, a fee added at settle time is rejected and
        // the cashier cannot charge the table.
        const isFreshDraftSettle = isUnpaidTableSettle && !boundTableSnapshotId;
        let serviceChargeSnapshot = null;


        const serviceChargeItem = cartItems.find(item => item.note === 'Auto-Gratuity');
        // Claimed register holds and saved table/split snapshots were already authorized
        // server-side. Settlement consumes their exact snapshot without asking the cashier
        // for permission to apply the charge again.
        const hasServerAuthorizedServiceCharge =
            isClaimedCheckout ||
            isHeldSnapshotCheckout ||
            (isUnpaidTableSettle && !!boundTableSnapshotId) ||
            (isSplitSettle && !!splitSnapshotId) ||
            (isPlatformHeldSettle && !!platformSnapshotId);
        if (serviceChargeItem && !hasServerAuthorizedServiceCharge && !canApplyServiceCharge(user)) {
            const err = new Error("Forbidden: You do not have permission to apply a service charge.");
            err.statusCode = 403;
            throw err;
        }
        if (serviceChargeItem && !isDirectSnapshotCheckout && !isClaimedCheckout &&
            !isHeldSnapshotCheckout &&
            !(isUnpaidTableSettle && (boundTableSnapshotId || submittedSnapshot?.id)) &&
            !(isSplitSettle && splitSnapshotId) &&
            !(isPlatformHeldSettle && platformSnapshotId)) {
            const error = new Error('A service charge snapshot is required.');
            error.statusCode = 400;
            throw error;
        }

        // Discount permission enforcement
        // A split settle re-applies a discount that was authorized on the parent order and
        // is read server-side from the held check (not client-supplied), so it does not
        // require a fresh discount authorization here.
        if (!isSplitSettle && !tableContext && hasDiscountsInPayload(data, cartItems)) {
            let discountAllowed = hasDiscountPermission(user);
            if (!discountAllowed && data.manager_pin) {
                discountAllowed = await applyManagerOverride(PERMISSIONS.POS_DISCOUNT);
            }
            if (!discountAllowed) {
                const err = new Error("Forbidden: Manager PIN required to apply discounts.");
                err.statusCode = 403;
                throw err;
            }
        }

        // Settle-only: cashing out a table takes payment at the saved total. The product
        // Reconciliation above is the one authority for what may settle a saved table order.
        // This block only preserves the saved rows required later to reapply their frozen prices.
        const savedRows = [];
        const resolvedSavedContext = new Map();
        if (data.edit_invoice_id && originalPaymentMethod === 'unpaid_table') {
            let savedItems = tableContext?.savedItems || null;
            if (!savedItems) {
                [savedItems] = await conn.query(
                    "SELECT id, invoice_id, parent_item_id, product_id, item_name, quantity, note, price_at_sale, price_before_tax_exemption, tax_rate, jofotara_tax_category, selected_modifiers, modifier_surcharge, modifier_tax_amount, recipe_line_key, stock_authority, stock_snapshot FROM order_items WHERE invoice_id = ?",
                    [data.edit_invoice_id]
                );
            }
            assertOrderItemBundleIntegrity(savedItems);

            for (const it of savedItems) {
                if (it.parent_item_id != null) continue;
                if (it.note === 'Auto-Gratuity') continue;
                savedRows.push(it);
            }
        }

        if (!isSplitSettle && tablePersistedInvoiceId &&
            Number(tablePersistedInvoiceId) !== Number(data.edit_invoice_id)) {
            const [persistedRows] = await conn.query(
                'SELECT id, invoice_id, parent_item_id, quantity FROM order_items WHERE invoice_id = ? FOR UPDATE',
                [tablePersistedInvoiceId]
            );
            assertOrderItemBundleIntegrity(persistedRows);
        }

        // Trusted held snapshots freeze each line to the price captured when the hold
        // was created, so a catalog change cannot rewrite the final sale.
        const heldSnapshotPayload = isPlatformHeldSettle ? platformHeldPayload : splitHeldPayload;
        const isTrustedHeldSnapshot = isPlatformHeldSettle || isSplitSettle;
        const isLegacySplit = isSplitSettle && splitHeldPayload?.tax_context_version !== 1;
        if (isTrustedHeldSnapshot && heldSnapshotPayload && Array.isArray(heldSnapshotPayload.items)) {
            let legacyParentRowsById = new Map();
            if (isLegacySplit && heldParentInvoiceId != null) {
                const [legacyParentRows] = await conn.query(
                    `SELECT id, product_id, item_name, note, tax_rate, jofotara_tax_category
                     FROM order_items
                     WHERE invoice_id = ? AND parent_item_id IS NULL`,
                    [heldParentInvoiceId]
                );
                legacyParentRowsById = new Map(legacyParentRows.map(row => [Number(row.id), row]));
            }
            for (const it of heldSnapshotPayload.items) {
                const pid = it.product_id != null ? it.product_id : (it.id != null ? it.id : null);
                const frozen = Number(it.price != null ? it.price : it.price_at_sale);
                let frozenTaxRate = it.tax_rate;
                let frozenTaxCategory = it.jofotara_tax_category;
                if (it.note !== 'Auto-Gratuity' && isLegacySplit) {
                    const parentRow = it.order_item_id != null
                        ? legacyParentRowsById.get(Number(it.order_item_id))
                        : null;
                    if (parentRow) {
                        const sameProduct = parentRow.product_id == null
                            ? pid == null
                            : Number(parentRow.product_id) === Number(pid);
                        const sameNote = (parentRow.note || '') === (it.note || '');
                        const sameName = parentRow.product_id != null ||
                            (parentRow.item_name || '') === (it.item_name || it.name || '');
                        if (!sameProduct || !sameNote || !sameName) {
                            const error = new Error('Split item identity changed. Refresh and try again.');
                            error.statusCode = 409;
                            throw error;
                        }
                        frozenTaxRate = parentRow.tax_rate;
                        frozenTaxCategory = parentRow.jofotara_tax_category;
                    } else {
                        frozenTaxRate = null;
                    }
                } else if (it.note !== 'Auto-Gratuity' &&
                    (!Number.isFinite(Number(frozenTaxRate)) || Number(frozenTaxRate) < 0 || Number(frozenTaxRate) > 100)) {
                    const error = new Error('Held order tax context is invalid. Refresh and try again.');
                    error.statusCode = 409;
                    throw error;
                }
                if (Number.isFinite(frozen)) {
                    savedRows.push({
                        id: it.order_item_id,
                        product_id: pid,
                        item_name: it.item_name || it.name || '',
                        note: it.note,
                        price_at_sale: frozen,
                        tax_rate: frozenTaxRate,
                        jofotara_tax_category: frozenTaxCategory,
                        quantity: it.qty != null ? it.qty : it.quantity,
                        selected_modifiers: it.selectedModifiers,
                        modifier_surcharge: it.modifier_surcharge,
                        modifier_tax_amount: it.modifier_tax_amount
                    });
                }
            }
        }

        const savedLineIndex = buildSavedLineIndex(savedRows);
        const savedPriceMap = priceMapFor(savedLineIndex);

        const includeCheckoutContext = !isUnpaidTableSettle && !isTrustedHeldSnapshot;
        const productMap = await fetchCartProducts(conn, cartItems, { includeCheckoutContext });

        // Pin each cart line to its frozen price. Within a product|note group that carries more
        // than one price, resolve by the stable parent line id and CONSUME that saved line's
        // quantity, so a client cannot point two lines at one cheap id (price-line swap) or borrow
        // another product's id. A line with no usable id is allowed only when its group has a
        // single frozen price; a multi-price group that cannot be resolved by id is rejected.
        if (savedPriceMap.size > 0) {
            for (const item of cartItems) {
                if (!savedPriceMap.has(savedLineKey(item))) continue; // not a frozen line (e.g. a service charge added at settle)
                const context = resolveCheckoutSavedLine(savedLineIndex, item, {
                    allowMissingTax: isLegacySplit
                });
                item.price = isUnpaidTableSettle && lockedTableTaxExempt && !taxExempt && context.priceBeforeTaxExemption != null
                    ? context.priceBeforeTaxExemption
                    : context.price;
                item.modifier_surcharge = context.modifier_surcharge ?? null;
                item.modifier_tax_amount = context.modifier_tax_amount ?? null;
                resolvedSavedContext.set(item, context);
            }
        }

        // Server-authored held snapshots preserve historical child rows even when the
        // current catalog changes. Split snapshots additionally require split provenance.
        const isServerHeldBundleSnapshot = item =>
            (isPlatformHeldSettle || hasTrustedSplitBundleSnapshot) &&
            item?.bundle_snapshot_version === 1 &&
            Array.isArray(item.bundleItems);
        const bundleDefinitions = await validateBundleCartLines(
            conn,
            cartItems.filter(item => !isServerHeldBundleSnapshot(item)),
            {
                requireBundleItems: !isTrustedHeldSnapshot && !isUnpaidTableSettle && !isClaimedCheckout,
                trustedProductMap: includeCheckoutContext ? productMap : null
            }
        );

        // Custom Item Gate - Rejects custom item creation on a fresh checkout
        const hasCustomItem = cartItems.some(item => !item.product_id && item.note !== 'Auto-Gratuity');
        if (hasCustomItem && !data.edit_invoice_id && !isUnpaidTableSettle && !isPlatformHeldSettle) {
            const err = new Error("Open item is no longer available.");
            err.statusCode = 400;
            throw err;
        }

        // Temporary Manager Access also supports a price-only edit. Verify its PIN
        // here, after the fixed permission walls and frozen-line reconciliation.
        let priceOverrideApproved = false;
        if (!isUnpaidTableSettle && !canPriceOverride(user) && data.manager_pin &&
            hasUnfrozenPriceOverride(cartItems, productMap, savedPriceMap)) {
            priceOverrideApproved = await applyManagerOverride(PERMISSIONS.POS_PRICE_OVERRIDE);
            if (!priceOverrideApproved) {
                throw Object.assign(new Error('Forbidden: Manager approval is not available for manual price changes.'), { statusCode: 403 });
            }
        }
        const priceOverrides = applyDatabasePrices(cartItems, productMap, user, isUnpaidTableSettle, savedPriceMap.size > 0 ? savedPriceMap : null, { priceOverrideApproved });
        if ((isSplitSettle && splitSnapshotId) || (isPlatformHeldSettle && platformSnapshotId)) {
            const heldSnapshotId = isPlatformHeldSettle ? platformSnapshotId : splitSnapshotId;
            const heldSnapshotOwnerId = isPlatformHeldSettle ? platformHeldOrderId : data.split_check_id;
            serviceChargeSnapshot = await getForUpdate(conn, heldSnapshotId);
            if (serviceChargeSnapshot.state !== 'held' ||
                serviceChargeSnapshot.holder_type !== 'held_order' ||
                String(serviceChargeSnapshot.holder_id) !== String(heldSnapshotOwnerId)) {
                const error = new Error('Conflict: Held service-charge snapshot changed.');
                error.statusCode = 409;
                throw error;
            }
            if (isPlatformHeldSettle && cartItems.some(item => item.note === 'Auto-Gratuity')) {
                cartItems = canonicalizeServiceCharge(cartItems, {
                    id: serviceChargeSnapshot.id,
                    percentage: serviceChargeSnapshot.percentage,
                    taxRate: serviceChargeSnapshot.tax_rate,
                    taxCategory: serviceChargeSnapshot.jofotara_tax_category
                }, {
                    repriceStaleFee: changingLockedTableTaxContext,
                    taxInclusivePricing: accountingTaxInclusive,
                    taxRegistrationType,
                    taxExempt,
                    pricesAlreadyExempt
                }).items;
            }
            if (!isPlatformHeldSettle) {
                // The allocation is server-written at split time as a plain non-negative integer.
                // Anything else (absent, null, '', negative, fractional) is corruption — fail closed
                // rather than let Number() coercion conflate it with a genuine zero or, for negative
                // values, skip both validation branches entirely.
                const allocation = splitHeldPayload.service_charge_allocation_cents;
                if (typeof allocation !== 'number' || !Number.isInteger(allocation) || allocation < 0) {
                    const error = new Error('Conflict: Split service-charge allocation missing.');
                    error.statusCode = 409;
                    throw error;
                }
                const feeLines = cartItems.filter(item => item.note === 'Auto-Gratuity');
                const validNoFee = allocation === 0 && feeLines.length === 0;
                const validFee = allocation > 0 && feeLines.length === 1 &&
                    Math.round(Number(feeLines[0].price) * 100) === allocation &&
                    Number(feeLines[0].qty) === 1 && feeLines[0].product_id == null &&
                    Number(feeLines[0].tax_rate) === Number(serviceChargeSnapshot.tax_rate) &&
                    !feeLines[0].discountType && Number(feeLines[0].discountValue || 0) === 0;
                if (!validFee && !validNoFee) {
                    const error = new Error('Conflict: Split service-charge allocation changed.');
                    error.statusCode = 409;
                    throw error;
                }
            }
        }
        if (isClaimedCheckout) {
            serviceChargeSnapshot = await getForUpdate(conn, submittedSnapshot.id);
            if (serviceChargeSnapshot.state !== 'claimed' ||
                serviceChargeSnapshot.holder_type !== 'claim' ||
                String(serviceChargeSnapshot.holder_id) !== String(user.id) ||
                Number(serviceChargeSnapshot.version) !== Number(submittedSnapshot.version)) {
                const error = new Error('Service-charge claim changed or was already consumed.');
                error.statusCode = 409;
                error.publicCode = 'SERVICE_CHARGE_SNAPSHOT_CONFLICT';
                throw error;
            }
            if (cartItems.some(item => item.note === 'Auto-Gratuity')) {
                cartItems = canonicalizeServiceCharge(cartItems, {
                    id: serviceChargeSnapshot.id,
                    percentage: serviceChargeSnapshot.percentage,
                    taxRate: serviceChargeSnapshot.tax_rate,
                    taxCategory: serviceChargeSnapshot.jofotara_tax_category
                }, { taxInclusivePricing: accountingTaxInclusive, taxRegistrationType, taxExempt, pricesAlreadyExempt }).items;
            }
        }
        if (isHeldSnapshotCheckout) {
            serviceChargeSnapshot = await getForUpdate(conn, heldRow.service_charge_snapshot_id);
            if (serviceChargeSnapshot.state !== 'held' ||
                serviceChargeSnapshot.holder_type !== 'held_order' ||
                String(serviceChargeSnapshot.holder_id) !== String(heldRow.id)) {
                const error = new Error('Conflict: Held service-charge snapshot changed.');
                error.statusCode = 409;
                error.publicCode = 'SERVICE_CHARGE_SNAPSHOT_CONFLICT';
                throw error;
            }
            if (cartItems.some(item => item.note === 'Auto-Gratuity')) {
                cartItems = canonicalizeServiceCharge(cartItems, {
                    id: serviceChargeSnapshot.id,
                    percentage: serviceChargeSnapshot.percentage,
                    taxRate: serviceChargeSnapshot.tax_rate,
                    taxCategory: serviceChargeSnapshot.jofotara_tax_category
                }, { taxInclusivePricing: accountingTaxInclusive, taxRegistrationType, taxExempt, pricesAlreadyExempt }).items;
            }
        }
        if (isUnpaidTableSettle && boundTableSnapshotId) {
            serviceChargeSnapshot = tableContext?.serviceChargeSnapshot ||
                await getForUpdate(conn, boundTableSnapshotId);
            if (serviceChargeSnapshot.state !== 'open_order' ||
                serviceChargeSnapshot.holder_type !== 'order' ||
                String(serviceChargeSnapshot.holder_id) !== String(data.edit_invoice_id) ||
                (!tableContext && (
                    submittedSnapshot?.id !== serviceChargeSnapshot.id ||
                    Number(submittedSnapshot?.version) !== Number(serviceChargeSnapshot.version)
                ))) {
                const error = new Error('Service-charge snapshot changed. Refresh and try again.');
                error.statusCode = 409;
                error.publicCode = 'SERVICE_CHARGE_SNAPSHOT_CONFLICT';
                throw error;
            }
            if (cartItems.some(item => item.note === 'Auto-Gratuity')) {
                cartItems = canonicalizeServiceCharge(cartItems, {
                    id: serviceChargeSnapshot.id,
                    percentage: serviceChargeSnapshot.percentage,
                    taxRate: serviceChargeSnapshot.tax_rate,
                    taxCategory: serviceChargeSnapshot.jofotara_tax_category
                }, { taxInclusivePricing: accountingTaxInclusive, taxRegistrationType, taxExempt, pricesAlreadyExempt }).items;
            }
        }
        if (isDirectSnapshotCheckout || isFreshDraftSettle) {
            const hasFee = cartItems.some(item => item.note === 'Auto-Gratuity');
            if (hasFee && !submittedSnapshot?.id) {
                const error = new Error('A service charge snapshot is required.');
                error.statusCode = 400;
                throw error;
            }
            if (submittedSnapshot?.id) {
                serviceChargeSnapshot = await getForUpdate(conn, submittedSnapshot.id);
                assertDraftUsableBy(serviceChargeSnapshot, user.id, submittedSnapshot.version);
                if (hasFee) {
                    cartItems = canonicalizeServiceCharge(cartItems, {
                        id: serviceChargeSnapshot.id,
                        percentage: serviceChargeSnapshot.percentage,
                        taxRate: serviceChargeSnapshot.tax_rate,
                        taxCategory: serviceChargeSnapshot.jofotara_tax_category
                    }, { taxInclusivePricing: accountingTaxInclusive, taxRegistrationType, taxExempt, pricesAlreadyExempt }).items;
                }
            }
        }

        const taxRateOverrides = taxOverridesFor(resolvedSavedContext);

        const calculatedTotals = calculateExpectedTotals(data, cartItems, productMap, accountingTaxInclusive, {
            taxRateOverrides,
            taxRegistrationType,
            taxExempt,
            pricesAlreadyExempt
        });
        if (trustedSplitMoney) {
            for (const component of ['subtotal', 'discount', 'tax', 'total']) {
                if (Math.abs(moneyToCents(calculatedTotals[component]) - trustedSplitMoney[component]) > 1) {
                    const error = new Error('Conflict: Split money allocation does not match the held items.');
                    error.statusCode = 409;
                    throw error;
                }
            }
        }
        const expectedTotals = trustedSplitMoney ? {
            ...calculatedTotals,
            subtotal: trustedSplitMoney.subtotal / 100,
            discount: trustedSplitMoney.discount / 100,
            tax: trustedSplitMoney.tax / 100,
            total: trustedSplitMoney.total / 100
        } : calculatedTotals;

        let nonExemptItems = taxExempt
            ? cartItems.map(item => {
                const sourcePrice = resolvedSavedContext.get(item)?.priceBeforeTaxExemption;
                return sourcePrice != null && item.note !== 'Auto-Gratuity'
                    ? { ...item, price: sourcePrice }
                    : { ...item };
            })
            : null;
        if (nonExemptItems?.some(item => item.note === 'Auto-Gratuity') && serviceChargeSnapshot) {
            nonExemptItems = canonicalizeServiceCharge(nonExemptItems, {
                id: serviceChargeSnapshot.id,
                percentage: serviceChargeSnapshot.percentage,
                taxRate: serviceChargeSnapshot.tax_rate,
                taxCategory: serviceChargeSnapshot.jofotara_tax_category
            }, {
                repriceStaleFee: true,
                taxInclusivePricing: accountingTaxInclusive,
                taxRegistrationType,
                taxExempt: false,
                pricesAlreadyExempt: false
            }).items;
        }
        const nonExemptTotals = taxExempt
            ? calculateExpectedTotals(data, nonExemptItems, productMap, accountingTaxInclusive, {
                taxRateOverrides,
                taxRegistrationType,
                taxExempt: false,
                pricesAlreadyExempt: false
            })
            : null;
        const persistedPriceMeta = new Map();
        if (taxExempt) {
            for (const item of cartItems) {
                const taxRate = resolveLineTaxRate(item, productMap, taxRateOverrides, taxRegistrationType);
                const savedContext = resolvedSavedContext.get(item);
                const sourcePrice = item.note === 'Auto-Gratuity'
                    ? null
                    : (pricesAlreadyExempt
                        ? (savedContext?.priceBeforeTaxExemption ?? null)
                        : Number(item.price));
                const chargedPrice = exemptUnitPrice(
                    item,
                    taxRate,
                    accountingTaxInclusive,
                    { alreadyExempt: pricesAlreadyExempt || item.note === 'Auto-Gratuity' }
                );
                persistedPriceMeta.set(item, { sourcePrice, chargedPrice });
                item.price = chargedPrice;
            }
        }

        // If the shift is closed, prevent changes to financial values (totals, subtotal, items/prices/discounts)
        if (data.edit_invoice_id && isShiftClosed) {
            const hasTotalsChanged = Math.abs(originalTotal - expectedTotals.total) > 0.001 ||
                                     Math.abs(originalSubtotal - expectedTotals.subtotal) > 0.001;

            const [originalItems] = await conn.query(
                "SELECT product_id, quantity, price_at_sale, discount_type, discount_value, item_name FROM order_items WHERE invoice_id = ?",
                [data.edit_invoice_id]
            );

            let itemsChanged = originalItems.length !== cartItems.length;
            if (!itemsChanged) {
                for (const item of cartItems) {
                    const match = originalItems.find(o =>
                        o.product_id === item.product_id &&
                        (item.product_id ? true : o.item_name === item.name) &&
                        Number(o.quantity) === Number(item.qty) &&
                        Number(o.price_at_sale) === Number(item.price) &&
                        o.discount_type === item.discountType &&
                        Number(o.discount_value) === Number(item.discountValue)
                    );
                    if (!match) {
                        itemsChanged = true;
                        break;
                    }
                }
            }
            if (itemsChanged || hasTotalsChanged) {
                const err = new Error("financial edits to orders from closed shifts are prohibited.");
                err.statusCode = 400;
                throw err;
            }
        }

        // Subtotal and Total are both server-validated anti-tamper anchors. Prices were
        // re-applied from the DB above (except table-settle frozen prices), so a deflated
        // subtotal or total is rejected.
        if (trustedSplitMoney) {
            if (moneyToCents(data.subtotal) !== trustedSplitMoney.subtotal
                || moneyToCents(data.total) !== trustedSplitMoney.total) {
                const error = new Error('Split check totals mismatch. Refresh and try again.');
                error.statusCode = 400;
                throw error;
            }
        } else if (!isPlatformHeldSettle) {
            assertNearMoney('Subtotal', data.subtotal, expectedTotals.subtotal);
            assertNearMoney('Total', data.total, expectedTotals.total);
        }

        const isPlatformPayment = isPlatformHeldSettle || isDirectPlatformCheckout;
        const payment = isPlatformPayment
            ? { paymentMethod: 'platform', amountTendered: 0, cashAmount: 0, cardAmount: 0, changeDue: 0 }
            : validatePayments(data, expectedTotals.total);

        data.subtotal = expectedTotals.subtotal;
        data.tax = expectedTotals.tax;
        data.total = expectedTotals.total;
        data.payment_method = payment.paymentMethod;
        data.amount_tendered = payment.amountTendered;
        data.change_due = payment.changeDue;
        data.cash_amount = payment.cashAmount;
        data.card_amount = payment.cardAmount;
        data.order_discount_type = expectedTotals.orderDiscount.type;
        data.order_discount_value = expectedTotals.orderDiscount.value;

        data.delivery_date = normalizeScheduledDateTime(data.delivery_date);
        const createdAt = new Date();

        await persistCheckoutCustomer(isPlatformPayment);
        if (isPlatformPayment && !frozenBuyer && [data.customer_name, data.customer_phone, data.customer_address].some(value => String(value || '').trim())) {
            frozenBuyer = {
                name: data.customer_name || null,
                phone: data.customer_phone || null,
                address: data.customer_address || null
            };
        }

        // 3. Queue Gen
        // Mint the daily display order_id from a write-based counter (race-safe
        // under REPEATABLE READ). Register, split-child, and table-settle all use
        // this one helper, shared by all cashiers and holds for the business day.
        let resetting_order_id = null;
        let order_seq_scope = null;
        const orderIdScope = {
            businessDate: getBusinessDate(createdAt),
            orderTypeId: data.order_type_id,
            separateByType: checkoutSettings.orderTypeNumbering,
        };
        if (!data.edit_invoice_id) {
            const numberedHold = heldRow || platformHeldRow;
            const number = numberedHold?.order_id != null ? numberedHold : await reserveDailyOrderIdentity(conn, orderIdScope);
            resetting_order_id = number.order_id;
            order_seq_scope = number.order_seq_scope;
        }

        // Products whose stock moved, announced after commit so tills reload only affected views.
        const stockTouchedProductIds = new Set();
        const stockTouchedItemIds = new Set();
        const restoreSavedStock = stockEnabled || savedRows.some(row => ['product', 'legacy_product'].includes(row.stock_authority));
        const stockWritePlan=restoreSavedStock?await prepareStockWrite(conn,{items:cartItems,savedItems:savedRows,recipeEnabled:checkoutSettings.recipeLedgerEnabled}):null;
        let invoice_id;

        // 4. Update OR Insert Order
        if (data.edit_invoice_id) {
            invoice_id = data.edit_invoice_id;
            // Settling an open table: mint a fresh daily order_id only if it has
            // none yet (legacy open tables keep their save-time number). Minted
            // before the invoice number to preserve global counter-lock ordering.
            if (isUnpaidTableSettle && lockedOrderId == null) {
                const number = await reserveDailyOrderIdentity(conn, orderIdScope);
                resetting_order_id = number.order_id;
                order_seq_scope = number.order_seq_scope;
            } else {
                resetting_order_id = lockedOrderId;
                order_seq_scope = lockedOrderScope || `legacy:${invoice_id}`;
            }

            // Only locked unpaid tables reach this update. Their prior voids
            // returned no money and must not mark the newly paid invoice refunded.
            await conn.query(`
                UPDATE orders
                SET order_type_id = ?, customer_id = ?, table_id = ?, subtotal = ?, tax = ?, tax_inclusive_at_sale = ?, receipt_tax_inclusive_at_sale = COALESCE(receipt_tax_inclusive_at_sale, ?), tax_registration_type_at_sale = ?, tax_exempt_at_sale = ?, total = ?,
                    payment_method = ?, amount_tendered = ?, change_due = ?, cash_amount = ?,
                    card_amount = ?, note = ?, discount_type = ?, discount_value = ?, hash_number = ?,
                    user_id = ?, shift_id = ?, void_reason = ?, order_id = ?, order_seq_scope = ?,
                    idempotency_key = ?, refund_status = 'none'
                WHERE invoice_id = ?
            `, [
                data.order_type_id || null, customer_id, data.table_id || null, data.subtotal, data.tax, accountingTaxInclusive ? 1 : 0, receiptTaxInclusiveDisplay ? 1 : 0, taxRegistrationType, taxExempt ? 1 : 0, data.total,
                data.payment_method, data.amount_tendered, data.change_due, data.cash_amount || 0,
                data.card_amount || 0, data.order_note, data.order_discount_type, data.order_discount_value, sanitizedHash,
                user.id, data.shift_id || null, data.void_reason || null, resetting_order_id, order_seq_scope,
                data.idempotency_key || null, invoice_id
            ]);

            if (restoreSavedStock) {
                savedStockRestored = await restockOrderItems(conn, invoice_id, { touchedProductIds: stockTouchedProductIds, touchedStockItemIds: stockTouchedItemIds, savedAuthorityOnly:!stockEnabled, source: { type: 'invoice_edit', id: invoice_id }, businessDate: getBusinessDate(createdAt), actorId: user.id });
            }

            await conn.query("DELETE FROM order_items WHERE invoice_id = ?", [invoice_id]);
        } else {
            // Attribute the order to the original waiter. For a split-check child the parent
            // table order carries the real waiter; preserve it instead of crediting the
            // cashier who rings up the seat. Falls back to the operator for normal orders.
            let waiterId = trustedParentWaiterId || user.id;
            if (trustedParentInvoiceId && !trustedParentWaiterId) {
                const [[parent]] = await conn.query("SELECT waiter_id FROM orders WHERE invoice_id = ?", [trustedParentInvoiceId]);
                if (parent?.waiter_id) waiterId = parent.waiter_id;
            }

            const [result] = await conn.query(`
                INSERT INTO orders (user_id, call_center_user_id, shift_id, order_id, order_seq_scope, order_type_id, customer_id, table_id, waiter_id, delivery_date, subtotal, tax, tax_inclusive_at_sale, receipt_tax_inclusive_at_sale, tax_registration_type_at_sale, tax_exempt_at_sale, total, payment_method, payment_due_on, receivable_reason, buyer_name_at_sale, buyer_phone_at_sale, buyer_address_at_sale, amount_tendered, change_due, cash_amount, card_amount, note, discount_type, discount_value, created_at, hash_number, idempotency_key, parent_invoice_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                user.id, isOrdinaryHeldCheckout ? (heldRow?.call_center_user_id || null) : null,
                data.shift_id || null, resetting_order_id, order_seq_scope, data.order_type_id || null, customer_id, data.table_id || null, waiterId, data.delivery_date || null, data.subtotal, data.tax, accountingTaxInclusive ? 1 : 0, receiptTaxInclusiveDisplay ? 1 : 0, taxRegistrationType, taxExempt ? 1 : 0, data.total, data.payment_method,
                null, null,
                frozenBuyer?.name || null, frozenBuyer?.phone || null, frozenBuyer?.address || null,
                data.amount_tendered, data.change_due, data.cash_amount || 0, data.card_amount || 0, data.order_note, data.order_discount_type, data.order_discount_value, createdAt, sanitizedHash, data.idempotency_key || null, trustedParentInvoiceId
            ]);
            invoice_id = result.insertId;
        }

        if (serviceChargeSnapshot) {
            const hasFee = cartItems.some(item => item.note === 'Auto-Gratuity');
            if ((isSplitSettle && splitSnapshotId) || (isPlatformHeldSettle && platformSnapshotId)) {
                await transition(conn, {
                    snapshotId: serviceChargeSnapshot.id,
                    version: serviceChargeSnapshot.version,
                    from: 'held',
                    to: 'finalized',
                    holderType: 'order',
                    holderId: String(invoice_id)
                });
                await conn.query('UPDATE orders SET service_charge_snapshot_id=? WHERE invoice_id=?', [serviceChargeSnapshot.id, invoice_id]);
            } else if (isClaimedCheckout) {
                await consumeClaim(conn, {
                    snapshotId: serviceChargeSnapshot.id,
                    version: submittedSnapshot.version,
                    claimToken: submittedSnapshot.claim_token,
                    userId: user.id,
                    to: hasFee ? 'finalized' : 'abandoned',
                    holderType: hasFee ? 'order' : 'none',
                    holderId: hasFee ? String(invoice_id) : null
                });
                if (hasFee) await conn.query(
                    'UPDATE orders SET service_charge_snapshot_id=? WHERE invoice_id=?',
                    [serviceChargeSnapshot.id, invoice_id]
                );
            } else if (isHeldSnapshotCheckout) {
                await transition(conn, {
                    snapshotId: serviceChargeSnapshot.id,
                    version: serviceChargeSnapshot.version,
                    from: 'held',
                    to: hasFee ? 'finalized' : 'abandoned',
                    holderType: hasFee ? 'order' : 'none',
                    holderId: hasFee ? String(invoice_id) : null
                });
                if (hasFee) await conn.query(
                    'UPDATE orders SET service_charge_snapshot_id=? WHERE invoice_id=?',
                    [serviceChargeSnapshot.id, invoice_id]
                );
            } else if (isUnpaidTableSettle && boundTableSnapshotId) {
                await transition(conn, {
                    snapshotId: serviceChargeSnapshot.id,
                    version: serviceChargeSnapshot.version,
                    from: 'open_order',
                    to: 'finalized',
                    holderType: 'order',
                    holderId: String(invoice_id)
                });
            } else if (hasFee) {
                await bindDraft(conn, {
                    snapshotId: serviceChargeSnapshot.id,
                    version: serviceChargeSnapshot.version,
                    userId: user.id,
                    state: 'finalized',
                    holderType: 'order',
                    holderId: String(invoice_id)
                });
                await conn.query(
                    'UPDATE orders SET service_charge_snapshot_id=? WHERE invoice_id=?',
                    [serviceChargeSnapshot.id, invoice_id]
                );
            } else {
                await abandonDraft(conn, {
                    snapshotId: serviceChargeSnapshot.id,
                    version: serviceChargeSnapshot.version,
                    userId: user.id
                });
            }
        }

        // 5. Insert Items & Deduct Stock
        let postedStockSnapshots = new Map();
        if (stockEnabled && !isProgressiveSplit) {
            postedStockSnapshots = await deductStockForCart(conn, cartItems, { plan:stockWritePlan, source: { type: 'invoice', id: invoice_id }, businessDate: getBusinessDate(createdAt), actorId: user.id });
        }

        const keyedLines = [];
        const keptKeys = new Set();
        let ledgerChangedIngredientIds = [];
        if (!isSplitSettle) {
            for (const item of cartItems) {
                const context = resolvedSavedContext.get(item);
                if (context?.matchedById && context.recipe_line_key) keptKeys.add(context.recipe_line_key);
            }
        }
        if (cartItems.length > 0) {
            const { discountRatio } = expectedTotals;
            const parentInsertSql = `
                INSERT INTO order_items
                    (invoice_id, product_id, item_name, quantity, price_at_sale, price_before_tax_exemption,
                     tax_rate, jofotara_tax_category, tax_amount, note, selected_modifiers, modifier_surcharge,
                     modifier_tax_amount, discount_type, discount_value, sort_order, recipe_line_key, parent_item_id, stock_authority, stock_snapshot)
                VALUES ?`;
            const pendingParentRows = [];
            let pendingParentBytes = 0;
            const flushPendingParents = async () => {
                if (pendingParentRows.length === 0) return;
                const rows = pendingParentRows.splice(0, pendingParentRows.length);
                pendingParentBytes = 0;
                await conn.query(parentInsertSql, [rows]);
            };
            const queueOrdinaryParent = async (row) => {
                const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
                if (pendingParentRows.length > 0 && (
                    pendingParentRows.length >= 50 ||
                    pendingParentBytes + rowBytes > 256 * 1024
                )) {
                    await flushPendingParents();
                }
                pendingParentRows.push(row);
                pendingParentBytes += rowBytes;
            };
            const stampedLineTaxes = cartItems.map(item => {
                const taxRate = resolveLineTaxRate(item, productMap, taxRateOverrides, taxRegistrationType);
                return {
                    taxRate,
                    taxAmount: stampLineTax(
                        item,
                        taxRate,
                        discountRatio,
                        accountingTaxInclusive,
                        { taxRegistrationType, taxExempt }
                    )
                };
            });
            const splitLineTaxCents = trustedSplitMoney
                ? allocateCents(trustedSplitMoney.tax, stampedLineTaxes.map(line => line.taxAmount))
                : null;
            let sortOrder = 0;
            for (const [itemIndex, item] of cartItems.entries()) {
                const product = item.product_id ? productMap.get(item.product_id) : null;
                const savedContext = resolvedSavedContext.get(item);
                const { taxRate } = stampedLineTaxes[itemIndex];
                const taxAmount = splitLineTaxCents
                    ? splitLineTaxCents[itemIndex] / 100
                    : stampedLineTaxes[itemIndex].taxAmount;
                const taxCategory = resolveJofotaraSaleTaxCategory(
                    savedContext
                        ? savedContext.taxCategory
                        : (item.note === 'Auto-Gratuity'
                            ? serviceChargeSnapshot?.jofotara_tax_category
                            : product?.jofotara_tax_category),
                    taxRate,
                    { taxExempt, taxRegistrationType }
                );

                const modifierSnapshot = item.note === 'Auto-Gratuity'
                    ? null
                    : (savedContext
                        ? savedContext.selectedModifiers
                        : buildSelectedModifiersSnapshot(product, item, productMap));

                const isBundle = item.is_bundle === true || item.is_bundle === 1 || Array.isArray(item.bundleItems);
                const hasPersistedBundleChildren = Array.isArray(item.persistedBundleChildren) && item.persistedBundleParent;
                const hasCatalogBundleChildren = isBundle && Array.isArray(item.bundleItems);
                const { lineKey, isNew: isNewLine } = isSplitSettle
                    ? { lineKey: item.note === 'Auto-Gratuity' ? null : (item.recipe_line_key || null), isNew: false }
                    : assignLineKey({
                        hasSavedContext: !!savedContext,
                        savedKey: savedContext?.recipe_line_key || null,
                        matchedById: !!savedContext?.matchedById,
                        enabled: checkoutSettings.recipeLedgerEnabled,
                        claimedKeys: keptKeys,
                        isService: item.note === 'Auto-Gratuity'
                    });
                if (lineKey) {
                    keyedLines.push({
                        key: lineKey,
                        product_id: item.product_id,
                        product_name: item.product_id ? (savedContext?.name || product?.name) : (item.name || null),
                        qty: item.qty,
                        isNew: isNewLine,
                        bundleItems: item.bundleItems
                    });
                    keptKeys.add(lineKey);
                }
                const parentRow = [
                    invoice_id,
                    item.product_id,
                    item.product_id ? (savedContext?.name || product.name) : (item.name || null),
                    item.qty,
                    persistedPriceMeta.get(item)?.chargedPrice ?? item.price,
                    persistedPriceMeta.get(item)?.sourcePrice ?? null,
                    taxRate,
                    taxCategory,
                    taxAmount,
                    item.note || null,
                    typeof modifierSnapshot === 'string' ? modifierSnapshot : (modifierSnapshot ? JSON.stringify(modifierSnapshot) : null),
                    item.modifier_surcharge ?? null,
                    taxRegistrationType === TAX_REGISTRATION_TYPES.INCOME_TAX
                        ? 0
                        : (item.modifier_tax_amount ?? null),
                    item.discountType || null,
                    item.discountValue || 0,
                    sortOrder,
                    lineKey,
                    null,
                    ...stockSnapshots.columns(isProgressiveSplit ? stockSnapshots.read(item)
                        : postedStockSnapshots.get(Number(item.product_id)) ?? { authority: 'none' })
                ];
                const requiresParentIdentity = hasPersistedBundleChildren || hasCatalogBundleChildren;
                let parentItemId = null;
                if (requiresParentIdentity) {
                    await flushPendingParents();
                    const [parentRes] = await conn.query(parentInsertSql, [[parentRow]]);
                    parentItemId = parentRes.insertId;
                } else {
                    await queueOrdinaryParent(parentRow);
                }
                sortOrder++;

                if (hasPersistedBundleChildren) {
                    sortOrder = await insertPersistedBundleChildren(conn, {
                        invoiceId: invoice_id,
                        parentItemId,
                        parentRow: item.persistedBundleParent,
                        childRows: item.persistedBundleChildren,
                        parentQty: item.qty,
                        startSortOrder: sortOrder
                    });
                } else if (hasCatalogBundleChildren) {
                    if (isServerHeldBundleSnapshot(item)) {
                        sortOrder = await insertSnapshotBundleChildren(conn, {
                            invoiceId: invoice_id,
                            parentItemId,
                            parentQty: item.qty,
                            snapshotSubs: item.bundleItems,
                            startSortOrder: sortOrder,
                            cashierId: user.id,
                            auditRemoved: isPlatformHeldSettle,
                        });
                    } else {
                        // insertBundleChildren: DB-driven qty/product_id/name; client trusted only
                        // for removed (boolean) and note (string) matched by product_id.
                        // Audit logged server-side for all removals regardless of client _modified.
                        sortOrder = await insertBundleChildren(conn, {
                            invoiceId: invoice_id,
                            parentItemId,
                            bundleProductId: item.product_id,
                            parentQty: item.qty,
                            clientSubs: item.bundleItems,
                            startSortOrder: sortOrder,
                            cashierId: user.id,
                            bundleDefinition: bundleDefinitions.get(Number(item.product_id)) || null,
                        });
                    }
                }
            }
            await flushPendingParents();
        }

        const ledgerRemovedKeys = savedRows
            .filter((row) => row.recipe_line_key && !keptKeys.has(row.recipe_line_key))
            .map((row) => row.recipe_line_key);

        // 6. Release Table and Cleanup Ghost Table Order. Progressive splits reach this
        // block only through their last-bucket branch; legacy detached splits remain exempt.
        let tableIdsToEmit = isProgressiveSplit ? tableContext.groupTableIds : null;
        let voidCheckoutAuditPayload = null;
        if (isProgressiveSplit && remainingSplitCount === 0) {
            const [[parentBeforeClose]] = await conn.query(
                'SELECT subtotal, tax, total, service_charge_snapshot_id FROM orders WHERE invoice_id=? FOR UPDATE',
                [heldParentInvoiceId]
            );
            await conn.query(`
                UPDATE orders
                   SET payment_method='voided',
                       original_total=total, original_subtotal=subtotal, original_tax=tax,
                       subtotal=0, tax=0, total=0,
                       cash_amount=0, card_amount=0, amount_tendered=0, change_due=0,
                       void_reason='Progressive Split Completed',
                       note=CONCAT(COALESCE(note, ''), ' [Closed by progressive split]')
                 WHERE invoice_id=? AND payment_method='unpaid_table'
            `, [heldParentInvoiceId]);
            await conn.query(
                "UPDATE restaurant_tables SET status='available', current_order_id=NULL, parent_table_id=NULL WHERE id IN (?)",
                [tableContext.groupTableIds]
            );
            if (parentBeforeClose?.service_charge_snapshot_id) {
                const parentSnapshot = await getForUpdate(conn, parentBeforeClose.service_charge_snapshot_id);
                if (parentSnapshot.state === 'split_parent') {
                    await transition(conn, {
                        snapshotId: parentSnapshot.id,
                        version: parentSnapshot.version,
                        from: 'split_parent',
                        to: 'abandoned',
                        holderType: 'none',
                        holderId: null
                    });
                }
            }
            await appendAuditEvent(conn, {
                eventType: 'split_parent_completed',
                userId: user.id,
                entityType: 'order',
                entityId: heldParentInvoiceId,
                oldValue: { subtotal: parentBeforeClose?.subtotal, tax: parentBeforeClose?.tax, total: parentBeforeClose?.total },
                newValue: { final_child_invoice_id: invoice_id },
                ipAddress
            });
        }
        if (data.table_id && !isSplitSettle) {
            const old_table_order_id = tablePersistedInvoiceId;

            let tableIdsToClear = tableContext?.groupTableIds || null;
            if (!tableIdsToClear) {
                const [childRows] = await conn.query(
                    "SELECT id FROM restaurant_tables WHERE parent_table_id = ? FOR UPDATE",
                    [data.table_id]
                );
                tableIdsToClear = [data.table_id, ...childRows.map(child => child.id)];
            }

            await conn.query("UPDATE restaurant_tables SET status = 'available', current_order_id = NULL, parent_table_id = NULL WHERE id IN (?)", [tableIdsToClear]);
            tableIdsToEmit = tableIdsToClear;

            if (old_table_order_id && old_table_order_id !== invoice_id) {
               // We must delete the old dummy table order because we are creating a fresh checkout order
                const [oldKeyed] = await conn.query(
                    `SELECT recipe_line_key, quantity
                       FROM order_items
                      WHERE invoice_id = ? AND parent_item_id IS NULL AND recipe_line_key IS NOT NULL`,
                    [old_table_order_id]
                );
                const reversed = await reverseLinesUsage(conn, {
                    lines: oldKeyed.map(row => ({ lineKey: row.recipe_line_key, qty: Number(row.quantity) })),
                    sourceType: 'void',
                    sourceId: old_table_order_id,
                    sourceLabel: `Void #${old_table_order_id}`,
                    actor: { id: user.id, name: user.name },
                    businessDate: getBusinessDate(createdAt)
                });
                ledgerChangedIngredientIds.push(...(reversed.changedIngredientIds || []));
                savedStockRestored = (await restockOrderItems(conn, old_table_order_id, { touchedProductIds: stockTouchedProductIds, touchedStockItemIds: stockTouchedItemIds, savedAuthorityOnly:!stockEnabled, source: { type: 'table_settlement', id: old_table_order_id }, businessDate: getBusinessDate(createdAt), actorId: user.id })) || savedStockRestored;
               // Snapshot original values before zeroing so void records are auditable
               const [[originalGhostVals]] = await conn.query(
                   "SELECT subtotal, tax, total FROM orders WHERE invoice_id = ?", [old_table_order_id]
               );

               await conn.query(`
                   UPDATE orders
                   SET payment_method = 'voided',
                       original_total = total, original_subtotal = subtotal, original_tax = tax,
                       subtotal = 0, tax = 0, total = 0,
                       cash_amount = 0, card_amount = 0, amount_tendered = 0, change_due = 0,
                       void_reason = 'Checkout Finalization',
                       note = CONCAT(COALESCE(note, ''), ' [Voided by Checkout ', ?, ']')
                   WHERE invoice_id = ?
               `, [invoice_id, old_table_order_id]);

               // Capture audit payload now; insert it in this same transaction after invoice
               // numbering, before commit, so audit + ghost void commit atomically.
               voidCheckoutAuditPayload = {
                   userId: user.id,
                   entityId: old_table_order_id,
                   oldValue: JSON.stringify({ total: originalGhostVals?.total, subtotal: originalGhostVals?.subtotal, tax: originalGhostVals?.tax }),
                   newValue: JSON.stringify({ replacement_invoice_id: invoice_id }),
                   ip: ipAddress
               };
            }
        }

        if (!isSplitSettle) {
            const tableNumber = tableContext?.rootTable?.table_number;
            const sourceLabel = data.table_id && tableNumber != null
                ? `Table ${tableNumber}`
                : `Order #${resetting_order_id}`;
            const synced = await syncOrderLines(conn, {
                enabled: checkoutSettings.recipeLedgerEnabled,
                sourceId: invoice_id,
                sourceLabel,
                lines: keyedLines,
                recipeContext:stockWritePlan?.recipeContext,
                removedKeys: ledgerRemovedKeys,
                actor: { id: user.id, name: user.name },
                businessDate: getBusinessDate(createdAt)
            });
            ledgerChangedIngredientIds.push(...(synced.changedIngredientIds || []));
            ledgerChangedIngredientIds = [...new Set(ledgerChangedIngredientIds.map(Number))];
        }

        if (checkoutSettings.recipeLedgerEnabled) {
            await captureInvoiceCosts(conn, invoice_id);
        }
        await reportInvalidation.invoices(conn, getBusinessDate(createdAt), [
            invoice_id,
            data.table_id && !isSplitSettle && tablePersistedInvoiceId && tablePersistedInvoiceId !== invoice_id
                ? tablePersistedInvoiceId : null
        ].filter(Boolean));
        const invoiceIdentity = await ensurePaidInvoiceNumber(conn, invoice_id, createdAt);
        await appendDiscountAuditEvents(conn, {
            userId: user.id,
            managerId: managerForAction(PERMISSIONS.POS_DISCOUNT),
            invoiceId: invoice_id,
            ipAddress,
            previousOrder: tableContext?.order || null,
            previousItems: tableContext?.savedItems || [],
            currentOrder: {
                type: expectedTotals.orderDiscount.type,
                value: expectedTotals.orderDiscount.value,
                subtotal: expectedTotals.subtotal
            },
            currentItems: cartItems.map(item => ({
                ...item,
                item_name: item.product_id
                    ? (resolvedSavedContext.get(item)?.name || productMap.get(Number(item.product_id))?.name)
                    : (item.item_name || item.name || null)
            }))
        });
        if (taxExempt) {
            const originalTotalForAudit = Number(nonExemptTotals?.total ?? expectedTotals.total);
            await appendAuditEvent(conn, {
                eventType: 'tax_exempt_checkout',
                userId: user.id,
                managerId: null,
                entityType: 'order',
                entityId: invoice_id,
                newValue: {
                    original_total: roundMoney(originalTotalForAudit),
                    exempt_total: roundMoney(expectedTotals.total),
                    tax_removed: roundMoney(Math.max(0, originalTotalForAudit - expectedTotals.total)),
                    final_tax: 0,
                    tax_inclusive_at_sale: accountingTaxInclusive ? 1 : 0,
                    tax_registration_type: taxRegistrationType
                },
                ipAddress
            });
        }
        if (voidCheckoutAuditPayload) {
            await appendAuditEvent(conn, {
                eventType: 'void_checkout',
                userId: voidCheckoutAuditPayload.userId,
                entityType: 'order',
                entityId: voidCheckoutAuditPayload.entityId,
                oldValue: voidCheckoutAuditPayload.oldValue,
                newValue: voidCheckoutAuditPayload.newValue,
                ipAddress: voidCheckoutAuditPayload.ip
            });
        }
        for (const ov of priceOverrides) {
            await appendAuditEvent(conn, {
                eventType: 'price_override',
                userId: user.id,
                managerId: managerForAction(PERMISSIONS.POS_PRICE_OVERRIDE),
                entityType: 'product',
                entityId: ov.product_id,
                oldValue: { base: ov.base },
                newValue: { override: ov.override },
                ipAddress
            });
        }
        if (isPlatformHeldSettle) {
            await appendAuditEvent(conn, {
                eventType: 'platform_held_order_settled',
                userId: user.id,
                entityType: 'order',
                entityId: invoice_id,
                newValue: {
                    held_order_id: Number(platformHeldOrderId),
                    held_by_user_id: platformHeldRow.user_id,
                    settled_by_user_id: user.id,
                    held_created_at: platformHeldRow.created_at,
                    shift_id: data.shift_id || null,
                    order_type_id: data.order_type_id,
                    invoice_id
                },
                ipAddress
            });
            const [platformRemoved] = await conn.query('DELETE FROM held_orders WHERE id = ? AND version = ?', [platformHeldOrderId, platformHeldRow.version]);
            if (Number(platformRemoved?.affectedRows) !== 1) {
                const error = new Error('Held order changed before platform settlement completed.');
                error.statusCode = 409;
                error.publicCode = 'HELD_VERSION_CONFLICT';
                throw error;
            }
        }
        if (isOrdinaryHeldCheckout && heldRow) {
            const heldId = Number(heldRow.id);
            await heldLifecycle.appendHeldOrderAudit(conn, {
                actor: heldAuditActor || { id: user.id, role: user.role },
                eventType: 'held_order_consumed',
                heldOrderId: heldId,
                oldVersion: heldRow.version,
                newVersion: heldRow.version,
                operationId: heldOrderContext.operation_id || null,
                invoice_id,
                ...(heldRow.call_center_user_id ? { call_center_user_id: Number(heldRow.call_center_user_id) } : {})
            });
            const [consumed] = await conn.query(
                'DELETE FROM held_orders WHERE id=? AND version=? AND claimed_by_user_id=?',
                [heldId, heldRow.version, user.id]
            );
            if (Number(consumed?.affectedRows) !== 1) {
                const error = new Error('Held order changed before checkout completed. Refresh and try again.');
                error.statusCode = 409;
                error.publicCode = 'HELD_VERSION_CONFLICT';
                throw error;
            }
        }
        const [[finalOrder]] = await conn.query(
            `SELECT o.*, ot.name AS order_type_name, t.table_number
               FROM orders o
               LEFT JOIN order_types ot ON ot.id = o.order_type_id
               LEFT JOIN restaurant_tables t ON t.id = o.table_id
              WHERE o.invoice_id = ?`,
            [invoice_id]
        );
        const [finalItems] = await conn.query(
            `SELECT oi.*, COALESCE(oi.item_name, p.name) AS name, p.category_id, p.is_bundle
               FROM order_items oi
               LEFT JOIN products p ON p.id = oi.product_id
              WHERE oi.invoice_id = ?`,
            [invoice_id]
        );
        const receiptPresentation = buildOrderPresentation({ order: finalOrder, items: finalItems });
        const sourceHeldOrder = heldRow || platformHeldRow;
        const kitchenAlreadyFired = Number(sourceHeldOrder?.kitchen_fired) === 1;
        const shouldQueueKitchen = !data.table_id && !isSplitSettle && !kitchenAlreadyFired;
        let kitchenTicketCount = 0;
        if (shouldQueueKitchen && finalItems.length > 0) {
            const kitchenItems = await normalizeKitchenTicketItems(finalItems, {
                db: conn,
                linePrefix: `order-${invoice_id}`,
                deriveBundleParentsFromLinks: true,
                productLookup: false
            });
            const { payloads } = await buildKitchenPrintPayloads(conn, {
                internal_invoice_id: invoice_id,
                invoice_id,
                invoice_number: invoiceIdentity.invoice_number,
                invoice_display_no: invoiceIdentity.invoice_display_no,
                order_display_no: invoiceIdentity.order_display_no,
                ticket_display_no: invoiceIdentity.ticket_display_no || invoiceIdentity.order_display_no,
                order_id: invoiceIdentity.order_display_no || invoiceIdentity.ticket_display_no || null,
                table_number: finalOrder.table_number || '',
                order_type_name: finalOrder.order_type_name || 'Standard',
                order_taken_at: finalOrder.created_at || createdAt,
                date: finalOrder.created_at || createdAt,
                hash_number: finalOrder.hash_number,
                items: kitchenItems
            });
            if (payloads.length > 0) {
                await enqueuePrintJobs(conn, payloads);
                kitchenTicketCount = payloads.length;
            }
        }

        if (kitchenTicketCount > 0) await commitAndPublishSpoolerSyncWake(conn);
        else await conn.commit();
        hasTransaction = false;
        await releaseCustomerPhoneLock();
        // Follow-up table reads use the pool; return this lease before requesting another.
        if (conn) {
            conn.release();
            conn = null;
        }

        // A sale changes only stock in the catalog: clear it when tracking is on or saved stock was restored.
        if (stockEnabled || savedStockRestored) try {
            cache.invalidateCatalogCache();
        } catch (cacheError) {
            logger.error({ err: cacheError, invoiceId: invoice_id }, 'Checkout catalog cache invalidation failed after commit.');
        }
        try {
            if (tableIdsToEmit) {
                await broadcastTableUpdates(io, tableIdsToEmit);
            }
            if (isSplitSettle || isPlatformHeldSettle || isOrdinaryHeldCheckout) {
                const settledHeld = isSplitSettle ? settledSplitRow : (isPlatformHeldSettle ? platformHeldRow : heldRow);
                emitHeldOrdersChanged(io, 'settled', settledHeld);
            }
            io.to('staff').emit('new_order', { invoice_id });
            io.to('staff').emit('shifts_changed', { shift_id: data.shift_id || null, invoice_id });
            if (stockEnabled) {
                announceStockChanged(io, {
                    productIds: [...cartItems.map(item => item.product_id), ...stockTouchedProductIds],
                    ingredientIds: ledgerChangedIngredientIds,
                    stockItemIds: [...stockTouchedItemIds],
                    logContext: { route: '/api/pos/checkout', method: 'POST', invoiceId: invoice_id }
                });
            }
            if (ledgerChangedIngredientIds.length) {
                io.to('staff').emit('ingredients_changed', { ingredientIds: ledgerChangedIngredientIds });
            }
        } catch (broadcastError) {
            logger.error({ err: broadcastError, invoiceId: invoice_id }, 'Checkout post-commit broadcast failed.');
        }
        try {
            cache.invalidateDashboardCache();
        } catch (cacheError) {
            logger.error({ err: cacheError, invoiceId: invoice_id }, 'Checkout dashboard cache invalidation failed after commit.');
        }

        return {
            message: "Order processed.",
            duplicate: false,
            invoice_id: invoice_id,
            order_id: resetting_order_id,
            ...invoiceIdentity,
            order_taken_at: createdAt,
            created_at: createdAt,
            subtotal: expectedTotals.subtotal,
            tax: expectedTotals.tax,
            total: expectedTotals.total,
            discount: expectedTotals.discount ?? 0,
            discount_type: data.order_discount_type || null,
            discount_value: Number(data.order_discount_value) || 0,
            amount_tendered: payment.amountTendered,
            change_due: payment.changeDue,
            cash_amount: payment.cashAmount,
            card_amount: payment.cardAmount,
            payment_method: data.payment_method,
            tax_registration_type_at_sale: taxRegistrationType,
            tax_exempt: taxExempt,
            kitchen_ticket_count: kitchenTicketCount,
            receipt_display_v1: receiptPresentation
        };

    } catch (e) {
        if (conn && hasTransaction) {
            try {
                await conn.rollback();
            } catch (rollbackError) {
                logger.error({ err: rollbackError }, 'Checkout rollback failed.');
                try {
                    conn.destroy();
                } catch (destroyError) {
                    logger.error({ err: destroyError }, 'Checkout connection destroy failed.');
                }
                conn = null;
                throw e;
            }
        }

        // ── Idempotency duplicate-key recovery ──────────────────────────────────
        // If the UNIQUE index on orders.idempotency_key fires (MySQL ER_DUP_ENTRY = 1062),
        // it means two concurrent requests with the same key both passed the pre-flight
        // SELECT check and one won the INSERT race. Treat this as a successful duplicate.
        if (e.code === 'ER_DUP_ENTRY' && data.idempotency_key) {
            if (conn) {
                await releaseCustomerPhoneLock();
                if (conn) {
                    conn.release();
                    conn = null;
                }
            }
            try {
                const existing = await findOwnedCheckoutAttempt(pool, {
                    key: data.idempotency_key,
                    userId: user.id
                });
                if (existing) {
                    return await buildDuplicateCheckoutResponse(pool, existing);
                }
            } catch (recoveryError) {
                if (recoveryError.statusCode) {
                    const responseError = new Error(recoveryError.message);
                    responseError.statusCode = recoveryError.statusCode;
                    throw responseError;
                }
                if (recoveryError.publicCode === BUNDLE_ORDER_CORRUPT) {
                    e = recoveryError;
                }
            }
        }
        throw e;
    } finally {
        if (editInvoiceId) {
            activeCheckoutLocks.delete(editInvoiceId);
        }
        await releaseCustomerPhoneLock();
        if (conn) conn.release();
    }
}

module.exports = { executeCheckout };
