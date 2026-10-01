const { getConnection: getStockConnection } = require('../../services/StockReportInvalidation');
const {
    validateBundleCartLines,
    insertBundleChildren,
    reconstructBundleSubs,
    insertPersistedBundleChildren
} = require('../../services/bundleOrderItems');
const { assertNestedBundleIntegrity } = require('../../services/bundleIntegrity');
const { buildOrderIdentity } = require('../../utils/orderIdentity');
const { normalizeKitchenTicketItems } = require('../../services/kitchenTicketItems');
const { commitAndPublishSpoolerSyncWake } = require('../../services/spoolerSyncWake');
const { appendAuditEvent, appendDiscountAuditEvents } = require('../../services/auditEvents');
const { SERVICE_NOTE, canonicalizeServiceCharge, serviceChargeFee, canonicalName } = require('../../services/ServiceChargeCalculator');
const { createDraft, getForUpdate, assertDraftUsableBy, bindDraft, touchOpenOrder, abandonOpenOrder } = require('../../services/ServiceChargeSnapshotService');
const { getBusinessDate } = require('../../utils/businessDate');
const { prepareStockWrite, fetchCartProducts, deductStockForCart, restockOrderItems } = require('../../services/InventoryService');
const { announceStockChanged } = require('../../services/StockEventScope');
const stockSnapshots = require('../../services/StockSaleSnapshots');
const { applyDatabasePrices, loadCheckoutSettings } = require('../../services/OrderPricing');
const { assignLineKey, syncOrderLines } = require('../../services/RecipeLedgerService');
const { hasDiscountsInPayload, assertNearMoney } = require('../../services/CheckoutValidation');
const { broadcastTableUpdates } = require('../../services/TableRealtime');
const { assertNoActiveSplitChecks } = require('./splitChecks');
const pool = require('../../config/db');
const crypto = require('crypto');
const logger = require('../../config/logger');
const cache = require('../../config/cache');
const { invalidateDashboardCache } = cache;
const { normalizeCartItems, stampLineTax } = require('../../services/PosCalculator');
const {
    isAdminRole: isAdminUser,
    hasDiscountPermission,
    canOverrideTables,
    canEditLocked,
    canCreateTableOrder,
    canApplyServiceCharge,
    canTaxExempt,
    canAccessTables,
    assertTableSectionAccess
} = require('../../services/PermissionService');
const { lockTableSession } = require('../../services/TableSettlementContext');
const { resolveLineTaxRate, buildSelectedModifiersSnapshot, calculateExpectedTotals, exemptUnitPrice } = require('../../services/PosCalculator');
const { hasVoidsOrReductions, getNewItems } = require('../orders/SavedOrderLines');
const {
    TAX_REGISTRATION_TYPES,
    normalizeTaxRegistrationType,
    resolveJofotaraSaleTaxCategory
} = require('../../config/taxRegistration');
const {
    savedLineKey,
    buildSavedLineIndex,
    resolveTableSavedLine,
    priceMapFor,
    taxOverridesFor
} = require('../orders/SavedOrderLines');

async function saveTableOrder({
    user,
    input,
    io,
    auditManagerId = null,
    ipAddress = null,
    printKitchenOrder
}) {
    if (!canAccessTables(user)) throw Object.assign(new Error('Forbidden: Tables access permission required.'), { statusCode: 403 });
    const data = input;
let conn;
let hasTransaction = false;
let dynamicCartPreflighted = false;
try {
    conn = await getStockConnection(pool);
    await conn.beginTransaction();
    hasTransaction = true;

    // Resolve Table ID & Order ID first
    let tableId = data.table_id || null;
    let resolvedTable = null;

    if (!tableId && data.table_number) {
        const preflightNewDynamicTableCart = async () => {
            if (!Array.isArray(data.cart) || data.cart.length === 0) return;
            assertNestedBundleIntegrity(data.cart);
            await validateBundleCartLines(conn, normalizeCartItems(data.cart), { requireBundleItems: true });
            dynamicCartPreflighted = true;
        };
        const [[modeRow]] = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'table_mode' LIMIT 1");
        const tableMode = modeRow?.setting_value || 'fixed';

        if (tableMode !== 'dynamic') {
            throw new Error('A floor table must be selected before sending this order.');
        }

        const rawTableNumber = String(data.table_number).trim();
        if (!rawTableNumber) {
            throw new Error('Table number is required.');
        }
        if (!/^\d+$/.test(rawTableNumber)) {
            throw new Error('Enter a valid table number.');
        }
        const dynamicTableNumber = Number(rawTableNumber);

        const [sectionRows] = await conn.query("SELECT id FROM sections WHERE name = 'Dynamic' LIMIT 1 FOR UPDATE");
        let dynamicSectionId = sectionRows[0]?.id || null;

        if (!dynamicSectionId) {
            await preflightNewDynamicTableCart();
            const [sectionInsert] = await conn.query("INSERT INTO sections (name) VALUES ('Dynamic')");
            dynamicSectionId = sectionInsert.insertId;
        }

        assertTableSectionAccess(user, [{ section_id: dynamicSectionId }]);

        // The Dynamic section lock above serializes lookup/create. Existing
        // orders must let lockTableSession acquire the whole group in ID order.
        const [dynamicRows] = await conn.query(`
            SELECT id, section_id, table_number, status, current_order_id, parent_table_id
            FROM restaurant_tables
            WHERE section_id = ? AND table_number = ?
            LIMIT 1
        `, [dynamicSectionId, dynamicTableNumber]);

        if (dynamicRows.length) {
            resolvedTable = dynamicRows[0];
            tableId = resolvedTable.id;
        } else {
            if (!dynamicCartPreflighted) await preflightNewDynamicTableCart();
            const secureToken = crypto.randomBytes(16).toString('hex');
            const [tableInsert] = await conn.query(`
                INSERT INTO restaurant_tables (section_id, table_number, status, x_pos, y_pos, qr_code_token)
                VALUES (?, ?, 'available', 40, 40, ?)
            `, [dynamicSectionId, dynamicTableNumber, secureToken]);

            tableId = tableInsert.insertId;
            resolvedTable = {
                id: tableId,
                section_id: dynamicSectionId,
                table_number: dynamicTableNumber,
                status: 'available',
                current_order_id: null,
                parent_table_id: null,
                qr_code_token: secureToken
            };
        }
    }

    if (!tableId) {
        throw new Error('Table selection is required.');
    }

    if (!resolvedTable) {
        const [tableRows] = await conn.query(`
            SELECT id, section_id, table_number, status, current_order_id, parent_table_id
            FROM restaurant_tables
            WHERE id = ?
            LIMIT 1
        `, [tableId]);

        if (!tableRows.length) {
            throw new Error('Selected table was not found.');
        }

        resolvedTable = tableRows[0];
    }

    assertTableSectionAccess(user, [resolvedTable]);

    // If this is a child table in a joint group, redirect to the parent table
    if (resolvedTable && resolvedTable.parent_table_id) {
        tableId = resolvedTable.parent_table_id;
        const [parentRows] = await conn.query(`
            SELECT id, section_id, table_number, status, current_order_id, parent_table_id
            FROM restaurant_tables
            WHERE id = ?
            LIMIT 1
        `, [tableId]);
        if (!parentRows.length) {
            throw new Error('Parent table was not found.');
        }
        resolvedTable = parentRows[0];
    }

    data.table_id = tableId;
    
    let order_id = data.current_order_id || null;
    let postedStockSnapshots = new Map();
    if (!order_id && resolvedTable.current_order_id) {
        throw new Error("Conflict: This table is already occupied. Please refresh the floor plan.");
    }
    if (order_id && String(order_id) !== String(resolvedTable.current_order_id)) {
        throw new Error("Conflict: The table order has changed. Please refresh the floor plan.");
    }
    if (!order_id) {
        order_id = resolvedTable.current_order_id || null;
    }

    let tableContext = null;
    let lockedTableIds = [];
    let savedItems = [];
    if (order_id) {
        tableContext = await lockTableSession(conn, {
            user,
            tableId,
            invoiceId: order_id,
            expectedVersion: data.expected_version ?? null,
            withMoney: true
        });
        tableId = Number(tableContext.rootTable.id);
        data.table_id = tableId;
        resolvedTable = tableContext.rootTable;
        lockedTableIds = tableContext.groupTableIds;
        savedItems = tableContext.savedItems;
        await assertNoActiveSplitChecks(conn, order_id);
    } else {
        const [lockedTables] = await conn.query(
            `SELECT id, section_id, table_number, status, current_order_id, parent_table_id
               FROM restaurant_tables
              WHERE id=? OR parent_table_id=?
              ORDER BY id
              FOR UPDATE`,
            [tableId, tableId]
        );
        assertTableSectionAccess(user, lockedTables);
        const lockedRoot = lockedTables.find(row => Number(row.id) === Number(tableId));
        if (!lockedRoot || lockedRoot.parent_table_id != null || lockedTables.some(row => row.current_order_id != null)) {
            const error = new Error('Conflict: The table order has changed. Please refresh the floor plan.');
            error.statusCode = 409;
            throw error;
        }
        resolvedTable = lockedRoot;
        lockedTableIds = lockedTables.map(row => Number(row.id));
    }

    const settingsBundle = await loadCheckoutSettings(conn);
    let orderTypeId = tableContext?.order?.order_type_id ?? null;
    if (data.order_type_id != null && data.order_type_id !== '') {
        const requestedType = Number(data.order_type_id);
        if (!Number.isSafeInteger(requestedType) || requestedType <= 0) {
            throw Object.assign(new Error('Invalid order type.'), { statusCode: 400 });
        }
        if (requestedType !== orderTypeId) {
            const [[type]] = await conn.query('SELECT id FROM order_types WHERE id=? AND is_active=1', [requestedType]);
            if (!type) throw Object.assign(new Error('The selected order type is no longer available.'), { statusCode: 409 });
        }
        orderTypeId = requestedType;
    }
    const stockEnabled = settingsBundle.stockEnabled;
    // New table orders always use normal sale accounting. The setting only
    // freezes the customer-copy presentation mode.
    let taxInclusivePricing = false;
    let receiptTaxInclusiveDisplay = settingsBundle.receiptTaxInclusiveDisplay;
    let taxRegistrationType = settingsBundle.taxRegistrationType;
    const automaticTableChargeEnabled = settingsBundle.tablesEnabled
        && settingsBundle.serviceChargeEnabledSetting
        && settingsBundle.autoApplyServiceCharge;
    const automaticRemovalRequested = data.auto_service_charge_removed === true
        || data.auto_service_charge_removed === '1';
    if (automaticRemovalRequested && !isAdminUser(user)) {
        throw new Error('Forbidden: Only an admin or programmer can remove the automatic service charge.');
    }

    let existingTableTaxInclusive = null;
    let existingTableReceiptTaxInclusive = null;
    let existingTableTaxExempt = false;
    if (tableContext) {
        existingTableTaxInclusive = tableContext.order.tax_inclusive_at_sale;
        existingTableReceiptTaxInclusive = tableContext.order.receipt_tax_inclusive_at_sale;
        existingTableTaxExempt = Number(tableContext.order.tax_exempt_at_sale) === 1;
        if (existingTableTaxInclusive != null) {
            taxInclusivePricing = Number(existingTableTaxInclusive) === 1;
            receiptTaxInclusiveDisplay = existingTableReceiptTaxInclusive != null
                ? Number(existingTableReceiptTaxInclusive) === 1
                : taxInclusivePricing;
        }
        taxRegistrationType = tableContext.order.tax_registration_type_at_sale == null
            ? TAX_REGISTRATION_TYPES.SALES_TAX
            : normalizeTaxRegistrationType(tableContext.order.tax_registration_type_at_sale);
        if (tableContext.order.tax_registration_type_at_sale == null) {
            await conn.query(
                'UPDATE orders SET tax_registration_type_at_sale=? WHERE invoice_id=?',
                [taxRegistrationType, order_id]
            );
        }
    }

    const taxExemptFieldPresent = Object.prototype.hasOwnProperty.call(data || {}, 'tax_exempt');
    if (taxExemptFieldPresent && typeof data.tax_exempt !== 'boolean') {
        const error = new Error('tax_exempt must be a boolean.');
        error.statusCode = 400;
        error.publicCode = 'TAX_EXEMPT_BOOLEAN_REQUIRED';
        throw error;
    }
    const taxExempt = tableContext
        ? (taxExemptFieldPresent ? data.tax_exempt : existingTableTaxExempt)
        : data.tax_exempt === true;
    const taxExemptTransition = tableContext && taxExempt !== existingTableTaxExempt;
    if (taxExempt && !canTaxExempt(user) && (!tableContext || !existingTableTaxExempt || taxExemptTransition)) {
        const error = new Error('Forbidden: Tax-exempt sales permission is required.');
        error.statusCode = 403;
        error.publicCode = 'TAX_EXEMPT_PERMISSION_REQUIRED';
        throw error;
    }
    if (taxExempt && taxRegistrationType === TAX_REGISTRATION_TYPES.INCOME_TAX) {
        const error = new Error('Tax-exempt sales are not available under income-tax registration.');
        error.statusCode = 400;
        error.publicCode = 'TAX_EXEMPT_INCOME_TAX_UNAVAILABLE';
        throw error;
    }
    data.tax_exempt = taxExempt;

    // 1. Handle Empty Cart (Table Release / Void)
    if (!data.cart || data.cart.length === 0) {
        if (order_id) {
            const error = new Error('Saved items must be removed with the Remove action.');
            error.statusCode = 409;
            throw error;
        }
        if (!canCreateTableOrder(user)) {
            const error = new Error('You do not have permission to update table orders.');
            error.statusCode = 403;
            throw error;
        }

        const tableIdsToClear = lockedTableIds;

        await conn.query("UPDATE restaurant_tables SET status = 'available', current_order_id = NULL, parent_table_id = NULL WHERE id IN (?)", [tableIdsToClear]);
        await conn.commit();
        hasTransaction = false;
        conn.release();
        conn = null;

        if (io) await broadcastTableUpdates(io, tableIdsToClear);
        invalidateDashboardCache();
        return { message: "Table cleared.", order_id: null, table_id: tableId };
    }

    // 2. Normalize and validate cart items
    assertNestedBundleIntegrity(data.cart);
    let cartItems = normalizeCartItems(data.cart);
    const submittedSnapshot = data.service_charge_snapshot || null;
    let serviceChargeSnapshot = null;
    let nextSnapshotVersion = null;
    let isNewSnapshotBind = false;
    let snapshotBoundThisRequest = false;
    let autoServiceChargeApplied = false;
    let serviceChargePriceRepriced = false;

    // Discount permission enforcement
    if (hasDiscountsInPayload(data, cartItems)) {
        if (!hasDiscountPermission(user)) {
            throw new Error('Forbidden: You do not have permission to apply discounts.');
        }
    }

    const productMap = await fetchCartProducts(conn, cartItems);

    // The canonical saved-line index owns financial context resolution. The route
    // keeps raw rows only for table-specific bundle reconstruction/persistence.
    const savedLineIndex = buildSavedLineIndex(savedItems);
    const savedPriceMap = priceMapFor(savedLineIndex);
    const savedRowsById = new Map();
    const resolvedSavedContexts = new Map();
    const savedBundleChildrenByParentId = new Map();

    for (const it of savedItems) {
        if (it.parent_item_id != null) {
            const parentId = Number(it.parent_item_id);
            const children = savedBundleChildrenByParentId.get(parentId) || [];
            children.push(it);
            savedBundleChildrenByParentId.set(parentId, children);
        }
        savedRowsById.set(Number(it.id), it);
    }

    for (const item of cartItems) {
        const savedParent = item.order_item_id != null
            ? savedRowsById.get(Number(item.order_item_id))
            : null;
        if (!savedParent) continue;

        const persistedChildren = savedBundleChildrenByParentId.get(Number(savedParent.id));
        if (persistedChildren?.length) {
            item.bundleItems = await reconstructBundleSubs(conn, savedParent, persistedChildren);
        }
    }

    // Persisted bundle parents retain their historical children. Only lines with
    // no exact saved parent receive strict fresh-catalog admission; an exact
    // saved non-bundle still validates any client-supplied nested array.
    const newBundleCartLines = dynamicCartPreflighted ? [] : cartItems.filter(item => {
        const lineId = item.order_item_id != null ? Number(item.order_item_id) : null;
        const savedParent = lineId != null ? savedRowsById.get(lineId) : null;
        const persistedChildren = lineId != null
            ? savedBundleChildrenByParentId.get(lineId)
            : null;
        const isExactSavedParent = savedParent &&
            (savedParent.product_id == null
                ? item.product_id == null
                : Number(savedParent.product_id) === Number(item.product_id)) &&
            (savedParent.note || '') === (item.note || '') &&
            (savedParent.product_id != null ||
                (savedParent.item_name || '') === (item.item_name || item.name || ''));
        return (!isExactSavedParent || Array.isArray(item.bundleItems)) &&
            !(persistedChildren?.length && isExactSavedParent);
    });
    await validateBundleCartLines(conn, newBundleCartLines, { requireBundleItems: true });

    if (savedPriceMap.size > 0) {
        // A new line can share a product/note with several saved lines. Once all
        // matching saved rows are explicitly present, there is no fallback identity
        // to resolve for that new line, regardless of its position in the cart.
        const submittedSavedIds = new Set(cartItems.filter(item => item.order_item_id != null)
            .map(item => Number(item.order_item_id)));
        const unidentifiedSavedKeys = new Set(savedItems.filter(item => !submittedSavedIds.has(Number(item.id)))
            .map(savedLineKey));
        for (const item of cartItems) {
            const key = savedLineKey(item);
            const lineId = item.order_item_id != null ? Number(item.order_item_id) : null;
            const context = lineId != null || unidentifiedSavedKeys.has(key)
                ? resolveTableSavedLine(savedLineIndex, item)
                : null;
            if (lineId != null && !context) {
                const error = new Error('Saved item context is stale or ambiguous. Refresh the order and try again.');
                error.statusCode = 409;
                throw error;
            }
            if (context) {
                item.modifier_surcharge = context.modifier_surcharge ?? null;
                item.modifier_tax_amount = context.modifier_tax_amount ?? null;
                resolvedSavedContexts.set(item, context);
            }
            if (savedPriceMap.has(key)) {
                item.price = !taxExempt && context?.priceBeforeTaxExemption != null
                    ? context.priceBeforeTaxExemption
                    : savedPriceMap.get(key);
            }
        }
    }

    // Custom Item Gate - Rejects custom item creation on a fresh table order
    const hasCustomItem = cartItems.some(item => !item.product_id && item.note !== 'Auto-Gratuity');
    if (hasCustomItem) {
        if (!order_id) {
            const err = new Error("Open item is no longer available.");
            err.statusCode = 400;
            throw err;
        }
        const savedCustomKeys = new Set(
            savedItems
                .filter(it => !it.product_id)
                .map(it => `${it.item_name || ''}|${it.note || ''}`)
        );
        for (const item of cartItems) {
            if (!item.product_id && item.note !== 'Auto-Gratuity') {
                const key = `${item.name || item.item_name || ''}|${item.note || ''}`;
                if (!savedCustomKeys.has(key)) {
                    const err = new Error("Open item is no longer available.");
                    err.statusCode = 400;
                    throw err;
                }
            }
        }
    }

    // Apply database product prices to prevent price manipulation tampering
    const priceOverrides = applyDatabasePrices(cartItems, productMap, user, false, savedPriceMap);
    const taxRateOverrides = taxOverridesFor(resolvedSavedContexts);

    // Convert every newly-added line to the frozen exempt price before service-charge
    // canonicalization. Saved lines already carry their charged price; their raw source
    // remains in price_before_tax_exemption for audit/replay.
    const sourcePriceByItem = new Map();
    for (const item of cartItems) {
        if (item.note === SERVICE_NOTE) continue;
        const savedContext = resolvedSavedContexts.get(item);
        sourcePriceByItem.set(item, savedContext?.priceBeforeTaxExemption ?? Number(item.price));
        if (taxExempt && !savedContext) {
            const taxRate = resolveLineTaxRate(item, productMap, taxRateOverrides, taxRegistrationType);
            item.price = exemptUnitPrice(item, taxRate, taxInclusivePricing);
        }
    }

    let hasServiceCharge = cartItems.some(item => item.note === 'Auto-Gratuity');
    if (!order_id && automaticTableChargeEnabled && !automaticRemovalRequested && !hasServiceCharge) {
        const fee = serviceChargeFee(cartItems, settingsBundle.serviceChargePct, {
            taxInclusivePricing,
            taxRegistrationType,
            taxExempt,
            pricesAlreadyExempt: taxExempt
        });
        if (fee > 0) {
            const draft = await createDraft(conn, {
                userId: user.id,
                percentage: settingsBundle.serviceChargePct,
                taxRate: settingsBundle.serviceChargeTax,
                taxCategory: settingsBundle.serviceChargeTaxCategory
            });
            serviceChargeSnapshot = await getForUpdate(conn, draft.id);
            cartItems.push({
                id: `FEE_AUTO_${Date.now()}`,
                product_id: null,
                name: canonicalName(settingsBundle.serviceChargePct),
                price: fee,
                qty: 1,
                tax_rate: settingsBundle.serviceChargeTax,
                jofotara_tax_category: settingsBundle.serviceChargeTaxCategory,
                note: 'Auto-Gratuity',
                discountType: null,
                discountValue: 0
            });
            hasServiceCharge = true;
            isNewSnapshotBind = true;
            autoServiceChargeApplied = true;
        }
    }

    if (order_id) {
        const boundOrder = tableContext.order;
        if (boundOrder?.service_charge_snapshot_id) {
            serviceChargeSnapshot = tableContext.serviceChargeSnapshot;
            if (submittedSnapshot?.id !== serviceChargeSnapshot.id ||
                Number(submittedSnapshot?.version) !== Number(serviceChargeSnapshot.version)) {
                const error = new Error('Service-charge snapshot changed. Refresh and try again.');
                error.statusCode = 409;
                error.publicCode = 'SERVICE_CHARGE_SNAPSHOT_CONFLICT';
                throw error;
            }
            if (!hasServiceCharge) {
                if (!isAdminUser(user)) {
                    const error = new Error('The service charge cannot be removed from this table.');
                    error.statusCode = 403;
                    throw error;
                }
                if (automaticRemovalRequested) {
                    await abandonOpenOrder(conn, {
                        snapshotId: serviceChargeSnapshot.id,
                        version: serviceChargeSnapshot.version,
                        orderId: order_id
                    });
                    await conn.query(
                        'UPDATE orders SET service_charge_snapshot_id=NULL WHERE invoice_id=?',
                        [order_id]
                    );
                    serviceChargeSnapshot = null;
                }
            }
        } else if (hasServiceCharge) {
            if (!canApplyServiceCharge(user)) {
                throw new Error('Forbidden: You do not have permission to apply a service charge.');
            }
            if (!submittedSnapshot?.id) {
                const error = new Error('A service charge snapshot is required.');
                error.statusCode = 400;
                throw error;
            }
            serviceChargeSnapshot = await getForUpdate(conn, submittedSnapshot.id);
            assertDraftUsableBy(serviceChargeSnapshot, user.id, submittedSnapshot.version);
            nextSnapshotVersion = await bindDraft(conn, {
                snapshotId: serviceChargeSnapshot.id,
                version: serviceChargeSnapshot.version,
                userId: user.id,
                state: 'open_order',
                holderType: 'order',
                holderId: String(order_id)
            });
            await conn.query(
                'UPDATE orders SET service_charge_snapshot_id=? WHERE invoice_id=?',
                [serviceChargeSnapshot.id, order_id]
            );
            snapshotBoundThisRequest = true;
        }
    } else if (hasServiceCharge) {
        if (!canApplyServiceCharge(user) && !automaticTableChargeEnabled) {
            throw new Error('Forbidden: You do not have permission to apply a service charge.');
        }
        if (!serviceChargeSnapshot && !submittedSnapshot?.id) {
            const error = new Error('A service charge snapshot is required.');
            error.statusCode = 400;
            throw error;
        }
        if (!serviceChargeSnapshot) {
            serviceChargeSnapshot = await getForUpdate(conn, submittedSnapshot.id);
            assertDraftUsableBy(serviceChargeSnapshot, user.id, submittedSnapshot.version);
            isNewSnapshotBind = true;
        }
    }
    if (hasServiceCharge && serviceChargeSnapshot) {
        const canonicalCharge = canonicalizeServiceCharge(cartItems, {
            id: serviceChargeSnapshot.id,
            percentage: serviceChargeSnapshot.percentage,
            taxRate: serviceChargeSnapshot.tax_rate,
            taxCategory: serviceChargeSnapshot.jofotara_tax_category
        }, { repriceStaleFee: true, taxInclusivePricing, taxRegistrationType, taxExempt, pricesAlreadyExempt: taxExempt });
        cartItems = canonicalCharge.items;
        serviceChargePriceRepriced = canonicalCharge.priceRepriced;
        cartItems = [
            ...cartItems.filter(item => item.note !== 'Auto-Gratuity'),
            ...cartItems.filter(item => item.note === 'Auto-Gratuity')
        ];
    }

    // 3. Compute expected totals for the new cart items
    const expectedTotals = calculateExpectedTotals(data, cartItems, productMap, taxInclusivePricing, {
        taxRateOverrides,
        taxRegistrationType,
        taxExempt,
        pricesAlreadyExempt: taxExempt
    });

    // Subtotal is the security anchor. Tax + total are server-authoritative
    // (overridden just below), so they are not asserted against the client —
    // this is also what unblocks item-level voids when product tax has drifted.
    if (!autoServiceChargeApplied && !serviceChargePriceRepriced) {
        assertNearMoney('Subtotal', data.subtotal, expectedTotals.subtotal);
    }

    // Override client inputs with server-recalculated verified values
    data.subtotal = expectedTotals.subtotal;
    data.tax = expectedTotals.tax;
    data.total = expectedTotals.total;

    if (order_id) {
        const waiterId = tableContext.order.waiter_id;
        const isOwner = !waiterId || waiterId === user.id;
        // Non-owner acting on someone else's table needs the override key.
        if (!isOwner && !canOverrideTables(user)) {
            throw new Error('Forbidden: This table belongs to another waiter. Override permission required.');
        }
        // Saved rows require locked-table edit rights from either the owner or an overrider.
        if (savedItems.length > 0) {
            const mayEdit = isOwner
                ? canEditLocked(user)
                : (canOverrideTables(user) && canEditLocked(user));
            if (!mayEdit) {
                throw new Error('Forbidden: This order is saved and locked. Edit permission required.');
            }
        }
    }

    let existingItemsForPrint = [];
    let originalShiftId = data.shift_id || null;
    if (order_id) {
        // The context already locked the saved rows. Catalog names are only a fallback.
        const missingNameIds = [...new Set(
            savedItems.filter(row => row.item_name == null && row.product_id != null)
                .map(row => row.product_id)
        )];
        let catalogNameById = new Map();
        if (missingNameIds.length > 0) {
            const [prodRows] = await conn.query(
                `SELECT id, name FROM products WHERE id IN (${missingNameIds.map(() => '?').join(',')})`,
                missingNameIds
            );
            catalogNameById = new Map(prodRows.map(p => [p.id, p.name]));
        }
        existingItemsForPrint = savedItems.map(row => ({
            ...row,
            item_name: row.item_name != null
                ? row.item_name
                : (row.product_id != null ? (catalogNameById.get(row.product_id) ?? null) : null)
        }));
        // If admin is updating (no shift) preserve original order's shift_id
        if (!data.shift_id && tableContext.order.shift_id) {
            originalShiftId = tableContext.order.shift_id;
        }
    }

    // Persisted business units may only leave an open table through /refunds.
    // Keep automatic service-charge removal separate from product voids.
    if (order_id && existingItemsForPrint.length > 0) {
        const savedBusinessParents = existingItemsForPrint.filter(
            item => item.parent_item_id == null && item.note !== SERVICE_NOTE
        );
        const submittedBusinessItems = cartItems.filter(item => item.note !== SERVICE_NOTE);
        if (hasVoidsOrReductions(submittedBusinessItems, savedBusinessParents)) {
            const error = new Error('Saved items must be removed with the Remove action.');
            error.statusCode = 409;
            throw error;
        }
    }

    const ensureCanUpdateTable = async () => {
        if (!canEditLocked(user)) {
            const err = new Error('You do not have permission to update table orders.');
            err.statusCode = 403;
            throw err;
        }
    };

    // Products whose stock moved, announced after commit so tills reload only affected views.
    const stockTouchedProductIds = new Set();
    const stockTouchedItemIds = new Set();
    const restoreSavedStock = stockEnabled || savedItems.some(row => ['product', 'legacy_product'].includes(row.stock_authority));
    const stockWritePlan=restoreSavedStock?await prepareStockWrite(conn,{items:cartItems,savedItems:savedItems.filter(row=>row.parent_item_id==null),recipeEnabled:settingsBundle.recipeLedgerEnabled}):null;
    if (order_id) {
        await ensureCanUpdateTable();
        await conn.query("UPDATE orders SET version=COALESCE(version, 1)+1, subtotal=?, tax=?, tax_inclusive_at_sale=?, receipt_tax_inclusive_at_sale=COALESCE(receipt_tax_inclusive_at_sale, ?), tax_registration_type_at_sale=?, tax_exempt_at_sale=?, total=?, discount_type=?, discount_value=?, user_id=?, shift_id=?, order_type_id=? WHERE invoice_id=?", [expectedTotals.subtotal, expectedTotals.tax, taxInclusivePricing ? 1 : 0, receiptTaxInclusiveDisplay ? 1 : 0, taxRegistrationType, taxExempt ? 1 : 0, expectedTotals.total, data.order_discount_type || null, Number(data.order_discount_value) || 0, user.id, originalShiftId, orderTypeId, order_id]);

        if (restoreSavedStock) {
            await restockOrderItems(conn, order_id, { touchedProductIds: stockTouchedProductIds, touchedStockItemIds: stockTouchedItemIds, savedAuthorityOnly:!stockEnabled, source: { type: 'table_edit', id: order_id }, businessDate: getBusinessDate(), actorId: user.id });
            if (stockEnabled) postedStockSnapshots = await deductStockForCart(conn, cartItems, { plan:stockWritePlan, source: { type: 'table_order', id: order_id }, businessDate: getBusinessDate(), actorId: user.id });
        }

        await conn.query("DELETE FROM order_items WHERE invoice_id=?", [order_id]);
    }

    if (!order_id) {
        // First-save authority is separate from editing an existing saved order.
        // Decide from the locked table state, never the client's permission flag.
        if (!canCreateTableOrder(user)) {
            throw Object.assign(new Error('Forbidden: Save table orders permission required.'), { statusCode: 403 });
        }

        // order_id (daily display number) is assigned at checkout, not at save.
        // Open tables are identified by their table number; they consume no
        // sequence so voiding an unpaid table cannot gap the daily numbering.
        const [result] = await conn.query(`
            INSERT INTO orders (user_id, shift_id, table_id, waiter_id, subtotal, tax, tax_inclusive_at_sale, receipt_tax_inclusive_at_sale, tax_registration_type_at_sale, tax_exempt_at_sale, total, payment_method, order_id, discount_type, discount_value, order_type_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid_table', NULL, ?, ?, ?)
        `, [user.id, data.shift_id || null, data.table_id, user.id, expectedTotals.subtotal, expectedTotals.tax, 0, receiptTaxInclusiveDisplay ? 1 : 0, taxRegistrationType, taxExempt ? 1 : 0, expectedTotals.total, data.order_discount_type || null, Number(data.order_discount_value) || 0, orderTypeId]);

        order_id = result.insertId;

        if (isNewSnapshotBind) {
            nextSnapshotVersion = await bindDraft(conn, {
                snapshotId: serviceChargeSnapshot.id,
                version: serviceChargeSnapshot.version,
                userId: user.id,
                state: 'open_order',
                holderType: 'order',
                holderId: String(order_id)
            });
            await conn.query(
                'UPDATE orders SET service_charge_snapshot_id=? WHERE invoice_id=?',
                [serviceChargeSnapshot.id, order_id]
            );
        }

        if (stockEnabled) {
            postedStockSnapshots = await deductStockForCart(conn, cartItems, { plan:stockWritePlan, source: { type: 'table_order', id: order_id }, businessDate: getBusinessDate(), actorId: user.id });
        }
    }

    if (serviceChargeSnapshot && !isNewSnapshotBind && !snapshotBoundThisRequest) {
        nextSnapshotVersion = await touchOpenOrder(conn, {
            snapshotId: serviceChargeSnapshot.id,
            version: submittedSnapshot.version,
            orderId: order_id
        });
    }

    const tableIdsToUpdate = lockedTableIds;
    await conn.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id IN (?)", [order_id, tableIdsToUpdate]);

    const keyedLines = [];
    const keptKeys = new Set();
    for (const item of cartItems) {
        const context = resolvedSavedContexts.get(item);
        if (context?.matchedById && context.recipe_line_key) keptKeys.add(context.recipe_line_key);
    }
    if (cartItems.length > 0) {
        // Insert each cart line as its own parent row (so we capture the parent
        // insertId), then mint DB-driven children for bundle lines. sort_order is
        // a running counter so parent+children stay contiguous. Per-line tax_amount
        // is prorated by expectedTotals.discountRatio so SUM(tax_amount)==orders.tax.
        let sortOrder = 0;
        for (const item of cartItems) {
            const product = item.product_id ? productMap.get(item.product_id) : null;
            const taxRate = resolveLineTaxRate(item, productMap, taxRateOverrides, taxRegistrationType);
            const taxAmount = stampLineTax(
                item,
                taxRate,
                expectedTotals.discountRatio,
                taxInclusivePricing,
                { taxRegistrationType, taxExempt }
            );
            const savedContext = resolvedSavedContexts.get(item);
            const taxCategory = resolveJofotaraSaleTaxCategory(
                savedContext
                    ? savedContext.taxCategory
                    : (item.note === SERVICE_NOTE
                        ? serviceChargeSnapshot?.jofotara_tax_category
                        : product?.jofotara_tax_category),
                taxRate,
                { taxExempt, taxRegistrationType }
            );

            const priceBeforeTaxExemption = taxExempt && item.note !== SERVICE_NOTE
                ? sourcePriceByItem.get(item) ?? null
                : null;

            const modifierSnapshot = item.note === 'Auto-Gratuity'
                ? null
                : (resolvedSavedContexts.has(item)
                    ? resolvedSavedContexts.get(item).selectedModifiers
                    : buildSelectedModifiersSnapshot(product, item, productMap));

            const { lineKey, isNew: isNewLine } = assignLineKey({
                hasSavedContext: !!savedContext,
                savedKey: savedContext?.recipe_line_key || null,
                matchedById: !!savedContext?.matchedById,
                enabled: settingsBundle.recipeLedgerEnabled,
                claimedKeys: keptKeys,
                isService: item.note === SERVICE_NOTE
            });
            if (lineKey) {
                keyedLines.push({
                    key: lineKey,
                    product_id: item.product_id,
                    product_name: item.product_id ? product.name : (item.name || null),
                    qty: item.qty,
                    isNew: isNewLine,
                    bundleItems: item.bundleItems
                });
                keptKeys.add(lineKey);
            }

            // Parent row (bundle parent OR normal/custom line) — parent_item_id = NULL.
            const [parentRes] = await conn.query(
                "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, price_before_tax_exemption, tax_rate, jofotara_tax_category, tax_amount, note, selected_modifiers, modifier_surcharge, modifier_tax_amount, discount_type, discount_value, sort_order, recipe_line_key, parent_item_id, stock_authority, stock_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
                [
                    order_id,
                    item.product_id,
                    item.product_id ? product.name : (item.name || null),
                    item.qty,
                    item.price,
                    priceBeforeTaxExemption,
                    taxRate,
                    taxCategory,
                    taxAmount,
                    item.note || null,
                    typeof modifierSnapshot === 'string'
                        ? modifierSnapshot
                        : (modifierSnapshot ? JSON.stringify(modifierSnapshot) : null),
                    item.modifier_surcharge ?? null,
                    taxRegistrationType === TAX_REGISTRATION_TYPES.INCOME_TAX
                        ? 0
                        : (item.modifier_tax_amount ?? null),
                    item.discountType || null,
                    item.discountValue || 0,
                    sortOrder,
                    lineKey,
                    ...stockSnapshots.columns(postedStockSnapshots.get(Number(item.product_id)) ?? { authority: 'none' })
                ]
            );
            sortOrder++;

            const savedParent = item.order_item_id != null
                ? savedRowsById.get(Number(item.order_item_id))
                : null;
            const persistedChildren = savedParent
                ? savedBundleChildrenByParentId.get(Number(savedParent.id))
                : null;
            if (persistedChildren?.length) {
                sortOrder = await insertPersistedBundleChildren(conn, {
                    invoiceId: order_id,
                    parentItemId: parentRes.insertId,
                    parentRow: savedParent,
                    childRows: persistedChildren,
                    parentQty: item.qty,
                    startSortOrder: sortOrder,
                });
            } else if (!savedParent && Array.isArray(item.bundleItems)) {
                // DB-driven child rows (price/tax 0; qty = DB member qty × parentQty).
                // Client trusted only for removed (boolean) / note (string), matched
                // by product_id. Removals audited server-side in bundle_modifications.
                sortOrder = await insertBundleChildren(conn, {
                    invoiceId: order_id,
                    parentItemId: parentRes.insertId,
                    bundleProductId: item.product_id,
                    parentQty: item.qty,
                    clientSubs: item.bundleItems,
                    startSortOrder: sortOrder,
                    cashierId: user.id,
                });
            }
        }
    }

    const removedKeys = savedItems
        .filter((row) => row.parent_item_id == null && row.recipe_line_key && !keptKeys.has(row.recipe_line_key))
        .map((row) => row.recipe_line_key);
    let ledgerChangedIngredientIds = [];
    if (settingsBundle.recipeLedgerEnabled) {
        const ledger = await syncOrderLines(conn, {
            enabled: settingsBundle.recipeLedgerEnabled,
            sourceId: order_id,
            sourceLabel: `Table ${resolvedTable.table_number}`,
            lines: keyedLines,
            recipeContext:stockWritePlan?.recipeContext,
            removedKeys,
            actor: { id: user.id, name: user.name },
            businessDate: getBusinessDate()
        });
        ledgerChangedIngredientIds = ledger.changedIngredientIds || [];
    }

    await appendDiscountAuditEvents(conn, {
        userId: user.id,
        managerId: auditManagerId || null,
        invoiceId: order_id,
        ipAddress: ipAddress || null,
        previousOrder: tableContext?.order || null,
        previousItems: savedItems,
        currentOrder: {
            type: expectedTotals.orderDiscount.type,
            value: expectedTotals.orderDiscount.value,
            subtotal: expectedTotals.subtotal
        },
        currentItems: cartItems.map(item => ({
            ...item,
            item_name: item.product_id
                ? productMap.get(Number(item.product_id))?.name
                : (item.item_name || item.name || null)
        }))
    });

    for (const ov of priceOverrides) {
        await appendAuditEvent(conn, {
            eventType: 'price_override',
            userId: user.id,
            entityType: 'product',
            entityId: ov.product_id,
            oldValue: { base: ov.base },
            newValue: { override: ov.override },
            ipAddress: ipAddress || null
        });
    }
    if (taxExemptTransition || (!tableContext && taxExempt)) {
        await appendAuditEvent(conn, {
            eventType: 'tax_exempt_table_changed',
            userId: user.id,
            entityType: 'order',
            entityId: order_id,
            oldValue: { tax_exempt_at_sale: existingTableTaxExempt },
            newValue: { tax_exempt_at_sale: taxExempt },
            ipAddress: ipAddress || null
        });
    }
    const [[identityRow]] = await conn.query(
        `SELECT o.invoice_id, o.version, o.order_id, o.order_seq_scope, o.invoice_number, o.invoice_issued_at, o.created_at, o.payment_method, o.waiter_id, t.table_number
         FROM orders o
         LEFT JOIN restaurant_tables t ON o.table_id = t.id
         WHERE o.invoice_id = ?`,
        [order_id]
    );
    const saveIdentity = buildOrderIdentity(identityRow || {});
    let kitchenTicketCount = 0;
    // Kitchen admission is part of the table-save transaction. A successful save
    // therefore always has its routable preparation work in the durable outbox.
    const newItemsToPrint = getNewItems(cartItems, existingItemsForPrint);
    if (newItemsToPrint.length > 0) {
        const itemsWithDetails = (await normalizeKitchenTicketItems(newItemsToPrint, {
            db: conn,
            linePrefix: `table-${order_id}`
        })).filter(item => {
            if (Array.isArray(item.bundleItems)) return true;
            return item.product_id !== null
                && productMap.has(Number(item.product_id))
                && item.category_id !== null;
        });

        if (itemsWithDetails.length > 0) {
            kitchenTicketCount = await printKitchenOrder(io, {
                print_batch_id: `table-${order_id}-v${Number(identityRow?.version ?? 1)}`,
                internal_invoice_id: order_id,
                invoice_id: order_id,
                invoice_number: null,
                invoice_display_no: null,
                order_display_no: saveIdentity.order_display_no,
                ticket_display_no: saveIdentity.ticket_display_no || saveIdentity.order_display_no,
                order_id: saveIdentity.ticket_display_no || saveIdentity.order_display_no || null,
                table_number: resolvedTable?.table_number || data.table_number || '',
                order_type_name: 'Table',
                order_taken_at: identityRow?.created_at || null,
                date: identityRow?.created_at || null,
                items: itemsWithDetails
            }, { executor: conn, publish: false });
        }
    }

    if (kitchenTicketCount > 0) await commitAndPublishSpoolerSyncWake(conn);
    else await conn.commit();
    hasTransaction = false;
    conn.release();
    conn = null;

    // A save changes only stock in the catalog: clear it when tracking is on or saved stock was restored.
    if (restoreSavedStock) try {
        cache.invalidateCatalogCache();
    } catch (error) {
        logger.error({ err: error, invoiceId: order_id, tableId: data.table_id }, 'Table order catalog cache invalidation failed after commit.');
    }
    if (io) {
        await broadcastTableUpdates(io, tableIdsToUpdate);
        if (stockEnabled) {
            announceStockChanged(io, {
                productIds: [...cartItems.map(item => item.product_id), ...stockTouchedProductIds],
                ingredientIds: ledgerChangedIngredientIds,
                stockItemIds: [...stockTouchedItemIds],
                logContext: { route: '/api/pos/table_order', method: 'POST', invoiceId: order_id, tableId: data.table_id }
            });
        }
        if (ledgerChangedIngredientIds.length) {
            try {
                io.to('staff').emit('ingredients_changed', { ingredientIds: ledgerChangedIngredientIds });
            } catch (broadcastErr) {
                logger.error({
                    err: broadcastErr,
                    route: '/api/pos/table_order',
                    method: 'POST',
                    invoiceId: order_id,
                    tableId: data.table_id
                }, 'Ingredients broadcast failed after table order commit.');
            }
        }
    }
    invalidateDashboardCache();

    return {
        message: "Table order updated.",
        version: Number(identityRow.version ?? 1),
        invoice_id: order_id,
        order_id,
        order_type_id: orderTypeId,
        table_id: data.table_id,
        table_number: resolvedTable?.table_number || data.table_number || '',
        waiter_id: identityRow?.waiter_id ?? null,
        kitchen_ticket_count: kitchenTicketCount,
        auto_service_charge_applied: autoServiceChargeApplied,
        tax_exempt_at_sale: taxExempt,
        service_charge_snapshot: serviceChargeSnapshot ? {
            id: serviceChargeSnapshot.id,
            percentage: Number(serviceChargeSnapshot.percentage),
            taxRate: Number(serviceChargeSnapshot.tax_rate),
            taxCategory: serviceChargeSnapshot.jofotara_tax_category,
            version: nextSnapshotVersion ?? Number(serviceChargeSnapshot.version)
        } : null,
        ...saveIdentity
    };
    } catch (e) {
        if (conn && hasTransaction) {
            try {
                await conn.rollback();
            } catch (rollbackErr) {
                logger.error({
                    err: rollbackErr,
                    route: '/api/pos/table_order',
                    method: 'POST',
                    userId: user?.id,
                    role: user?.role,
                    tableId: data.table_id,
                    currentOrderId: data.current_order_id || null
                }, 'Table order rollback failed.');
            }
        }
        throw e;
    } finally {
        if (conn) conn.release();
    }
}

module.exports = { saveTableOrder };
