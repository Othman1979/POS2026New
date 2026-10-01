const { randomUUID } = require('node:crypto');
const { getConnection: getStockConnection } = require('../../services/StockReportInvalidation');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { getSettings } = require('../../config/settingsHelper');
const cache = require('../../config/cache');
const { roundMoney, calculateLineSubtotal } = require('../../services/PosCalculator');
const { broadcastTableUpdates } = require('../../services/TableRealtime');
const { insertPersistedBundleChildren } = require('../../services/bundleOrderItems');
const { assertOrderItemBundleIntegrity } = require('../../services/bundleIntegrity');
const { normalizeKitchenTicketItems } = require('../../services/kitchenTicketItems');
const {
    SERVICE_NOTE,
    serviceChargeFee,
    canonicalName
} = require('../../services/ServiceChargeCalculator');
const {
    conflict,
    getForUpdate,
    touchOpenOrder,
    abandonOpenOrder
} = require('../../services/ServiceChargeSnapshotService');
const { lockTableSession } = require('../../services/TableSettlementContext');
const { appendAuditEvent, isAuditDisabled } = require('../../services/auditEvents');
const { getBusinessDate } = require('../../utils/businessDate');
const { reverseLinesUsage } = require('../../services/RecipeLedgerService');
const { prepareStockWrite, restoreStockForCart } = require('../../services/InventoryService');
const { announceStockChanged } = require('../../services/StockEventScope');
const { syncOrderRefundStatus } = require('../../services/RefundService');
const { recomputeOrderTotals } = require('../../services/OrderPricing');
const { assertCanVoidSavedUnits } = require('../../services/PermissionService');
const {
    TAX_REGISTRATION_TYPES,
    normalizeTaxRegistrationType
} = require('../../config/taxRegistration');

function fail(statusCode, message, publicCode = null) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (publicCode) error.publicCode = publicCode;
    throw error;
}

const toMoneyCents = amount => Math.max(0, Math.round(roundMoney(Number(amount) || 0) * 100));

function allocateMoneyAcrossRows(rows, field, targetAmount) {
    if (!rows.length) return;
    const targetCents = toMoneyCents(targetAmount);
    const sourceCents = rows.map(row => toMoneyCents(row[field]));
    const sourceTotal = sourceCents.reduce((sum, cents) => sum + cents, 0);
    let remaining = targetCents;

    rows.forEach((row, index) => {
        const cents = index === rows.length - 1
            ? remaining
            : Math.min(
                remaining,
                Math.max(0, sourceTotal > 0
                    ? Math.round((sourceCents[index] * targetCents) / sourceTotal)
                    : 0)
            );
        remaining -= cents;
        row[field] = roundMoney(cents / 100);
    });
}

async function lockBoundServiceChargeSnapshot(conn, order, lockedSnapshot = null) {
    if (!order.service_charge_snapshot_id) return null;
    const snapshot = lockedSnapshot || await getForUpdate(conn, order.service_charge_snapshot_id);
    const ownedByOrder = snapshot.holder_type === 'order'
        && String(snapshot.holder_id) === String(order.invoice_id);
    if (!ownedByOrder || (snapshot.state !== 'open_order' && snapshot.state !== 'split_parent')) {
        throw conflict('Service-charge snapshot changed. Refresh and try again.');
    }
    return snapshot;
}

async function abandonBoundOpenOrderSnapshot(conn, order, lockedSnapshot = null) {
    const snapshot = await lockBoundServiceChargeSnapshot(conn, order, lockedSnapshot);
    if (!snapshot || snapshot.state === 'split_parent') return;
    await abandonOpenOrder(conn, {
        snapshotId: snapshot.id,
        version: snapshot.version,
        orderId: order.invoice_id
    });
}

async function repriceBoundServiceCharge(conn, order, lockedSnapshot = null) {
    const snapshot = await lockBoundServiceChargeSnapshot(conn, order, lockedSnapshot);
    if (!snapshot) return;
    if (snapshot.state !== 'open_order') {
        throw conflict('Service-charge snapshot changed. Refresh and try again.');
    }

    const [goods] = await conn.query(
        `SELECT quantity, price_at_sale, discount_type, discount_value, note,
                tax_rate, modifier_surcharge, modifier_tax_amount
           FROM order_items
          WHERE invoice_id = ?
            AND parent_item_id IS NULL
            AND (note IS NULL OR note <> ?)`,
        [order.invoice_id, SERVICE_NOTE]
    );
    const nextFee = serviceChargeFee(goods.map(item => ({
        qty: Number(item.quantity),
        price: Number(item.price_at_sale),
        discountType: item.discount_type,
        discountValue: Number(item.discount_value || 0),
        note: item.note,
        tax_rate: Number(item.tax_rate || 0),
        modifier_surcharge: item.modifier_surcharge,
        modifier_tax_amount: item.modifier_tax_amount
    })), Number(snapshot.percentage), {
        taxInclusivePricing: Number(order.tax_inclusive_at_sale) === 1,
        taxExempt: Number(order.tax_exempt_at_sale) === 1,
        pricesAlreadyExempt: Number(order.tax_exempt_at_sale) === 1
    });

    if (nextFee <= 0) {
        await conn.query(
            'DELETE FROM order_items WHERE invoice_id = ? AND note = ?',
            [order.invoice_id, SERVICE_NOTE]
        );
        await abandonOpenOrder(conn, {
            snapshotId: snapshot.id,
            version: snapshot.version,
            orderId: order.invoice_id
        });
        await conn.query(
            'UPDATE orders SET service_charge_snapshot_id = NULL WHERE invoice_id = ?',
            [order.invoice_id]
        );
        return;
    }

    const [feeRows] = await conn.query(
        'SELECT id FROM order_items WHERE invoice_id = ? AND note = ? ORDER BY id',
        [order.invoice_id, SERVICE_NOTE]
    );
    if (feeRows.length !== 1) {
        throw conflict('Service-charge line changed. Refresh and try again.');
    }
    await conn.query(
        `UPDATE order_items
            SET product_id = NULL, item_name = ?, quantity = 1, price_at_sale = ?,
                tax_rate = ?, jofotara_tax_category = ?, tax_amount = 0,
                discount_type = NULL, discount_value = 0,
                note = ?
          WHERE id = ?`,
        [canonicalName(snapshot.percentage), nextFee, snapshot.tax_rate,
            snapshot.jofotara_tax_category, SERVICE_NOTE, feeRows[0].id]
    );
    await touchOpenOrder(conn, {
        snapshotId: snapshot.id,
        version: snapshot.version,
        orderId: order.invoice_id
    });
}

async function archiveCancelledItems(conn, { refundId, invoiceId, rows, quantities }) {
    // Keep the original saved row intact. quantity is the cancelled portion;
    // item_snapshot.quantity/tax_amount describe the source before cancellation.
    let values = [], bytes = 0;
    const flush = async () => {
        if (!values.length) return;
        await conn.query(`INSERT INTO deleted
            (refund_id,source_invoice_id,source_order_item_id,source_parent_item_id,
             product_id,item_name,quantity,item_snapshot) VALUES ?`, [values]);
        values = []; bytes = 0;
    };
    for (const row of rows) {
        const value = [refundId, invoiceId, row.id, row.parent_item_id,
            row.product_id, row.item_name, quantities.get(Number(row.id)), JSON.stringify(row)];
        const rowBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
        if (values.length >= 200 || (values.length && bytes + rowBytes > 256 * 1024)) await flush();
        values.push(value); bytes += rowBytes;
    }
    await flush();
}

async function removeNeverIssuedOrder(conn, invoiceId) {
    // The bill is already locked. Retain issued identities and financial/split
    // anchors, including malformed historical tenders or actual refund records.
    const [[eligible]] = await conn.query(`SELECT o.invoice_id FROM orders o
        WHERE o.invoice_id=? AND o.payment_method='voided'
          AND o.order_id IS NULL AND o.invoice_number IS NULL AND o.invoice_issued_at IS NULL
          AND o.parent_invoice_id IS NULL AND o.idempotency_key IS NULL
          AND COALESCE(o.cash_amount,0)=0 AND COALESCE(o.card_amount,0)=0
          AND COALESCE(o.amount_tendered,0)=0
          AND NOT EXISTS (SELECT 1 FROM orders child WHERE child.parent_invoice_id=o.invoice_id)
          AND NOT EXISTS (SELECT 1 FROM held_orders h WHERE h.parent_invoice_id=o.invoice_id)
          AND NOT EXISTS (SELECT 1 FROM jofotara_documents j WHERE j.order_invoice_id=o.invoice_id)
          AND NOT EXISTS (SELECT 1 FROM platform_remittance_lines p WHERE p.invoice_id=o.invoice_id)
          AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.invoice_id=o.invoice_id AND r.kind='refund')`, [invoiceId]);
    if (!eligible) return false;
    // Detach only non-cash history before the existing order cascade removes
    // live items. Archive source IDs still trace every cancellation to this bill.
    await conn.query("UPDATE refunds SET invoice_id=NULL WHERE invoice_id=? AND kind='void'", [invoiceId]);
    await conn.query('DELETE FROM orders WHERE invoice_id=?', [invoiceId]);
    return true;
}

async function runPostCommitEffects({
    io,
    printKitchenOrder,
    invoiceId,
    refundId,
    voidBatchId,
    order,
    lockedTable,
    voidKitchenRows,
    clearedTableIds,
    stockEnabled,
    stockProductIds = [],
    stockItemIds = [],
    ledgerChangedIngredientIds = []
}) {
    if (voidKitchenRows.length > 0) {
        try {
            const kitchenItems = await normalizeKitchenTicketItems(voidKitchenRows, {
                db: pool,
                linePrefix: `table-void-${voidBatchId}`,
                deriveBundleParentsFromLinks: true
            });
            if (kitchenItems.length > 0) {
                await printKitchenOrder(io, {
                    print_batch_id: `table-void-${voidBatchId}`,
                    void_ticket: true,
                    internal_invoice_id: invoiceId,
                    invoice_id: null,
                    invoice_number: null,
                    invoice_display_no: null,
                    order_display_no: null,
                    ticket_display_no: null,
                    order_id: null,
                    table_number: String(lockedTable.table_number),
                    order_type_name: 'Table',
                    order_taken_at: voidKitchenRows[0].created_at || null,
                    date: voidKitchenRows[0].created_at || null,
                    items: kitchenItems
                });
            }
        } catch (error) {
            logger.error({
                err: error,
                invoiceId,
                refundId,
                tableId: order.table_id
            }, 'Kitchen void ticket failed after table void commit.');
        }
    }

    if (stockEnabled) {
        try {
            cache.invalidateCatalogCache();
        } catch (error) {
            logger.error({ err: error, invoiceId, refundId }, 'Table void catalog cache invalidation failed.');
        }
    }
    try {
        if (io) {
            await broadcastTableUpdates(io, clearedTableIds);
            io.to('staff').emit('shifts_changed', {
                shift_id: order.shift_id || null,
                invoice_id: invoiceId
            });
            if (stockEnabled) announceStockChanged(io, { productIds: stockProductIds, ingredientIds: ledgerChangedIngredientIds, stockItemIds, logContext: { route: '/api/pos/refunds', method: 'POST', invoiceId } });
            if (ledgerChangedIngredientIds.length) {
                io.to('staff').emit('ingredients_changed', { ingredientIds: ledgerChangedIngredientIds });
            }
        }
    } catch (error) {
        logger.error({ err: error, invoiceId, refundId }, 'Table void post-commit notification failed.');
    }
    if (!io) {
        try {
            cache.invalidateDashboardCache();
        } catch (error) {
            logger.error({ err: error, invoiceId, refundId }, 'Table void dashboard cache invalidation failed.');
        }
    }
}

async function voidOpenTableOrder({
    user,
    invoiceId,
    items = null,
    expectedVersion = null,
    io = null,
    ipAddress = null,
    printKitchenOrder
}) {
    let conn;
    let hasTransaction = false;
    try {
        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        hasTransaction = true;

        const [[orderProbe]] = await conn.query(
            'SELECT payment_method, table_id FROM orders WHERE invoice_id=? LIMIT 1',
            [invoiceId]
        );
        let tableContext = null;
        let order = null;
        if (orderProbe?.payment_method === 'unpaid_table') {
            tableContext = await lockTableSession(conn, {
                user,
                tableId: orderProbe.table_id,
                invoiceId,
                expectedVersion,
                withMoney: true,
                requireUnsplit: true
            });
            order = tableContext.order;
        } else {
            [[order]] = await conn.query(
                `SELECT invoice_id, table_id, payment_method, refund_status, shift_id,
                        discount_type, discount_value, subtotal, total,
                        tax_inclusive_at_sale, tax_exempt_at_sale, tax_registration_type_at_sale, service_charge_snapshot_id
                   FROM orders WHERE invoice_id = ? FOR UPDATE`,
                [invoiceId]
            );
        }

        if (!order) fail(404, 'Order not found.');
        order.refund_status = await syncOrderRefundStatus(conn, order);
        const taxRegistrationType = order.tax_registration_type_at_sale == null
            ? TAX_REGISTRATION_TYPES.SALES_TAX
            : normalizeTaxRegistrationType(order.tax_registration_type_at_sale);
        if (order.tax_registration_type_at_sale == null) {
            await conn.query(
                'UPDATE orders SET tax_registration_type_at_sale=? WHERE invoice_id=?',
                [taxRegistrationType, invoiceId]
            );
        }
        if (order.payment_method === 'voided') fail(400, 'Order is already voided.');
        if (order.refund_status === 'full') fail(400, 'Order is already fully refunded.');
        if (order.payment_method !== 'unpaid_table') {
            fail(409, 'Table was just checked out — reopen it as a paid order to issue a refund.');
        }

        const lockedTable = tableContext.rootTable;
        assertCanVoidSavedUnits(user, { isPrinted: lockedTable.status === 'printed' });
        const reason = items ? 'Item removed from table' : 'Table cleared';

        let allOrderItems = tableContext.savedItems;
        assertOrderItemBundleIntegrity(allOrderItems);
        const missingNameProductIds = [...new Set(
            allOrderItems
                .filter(item => item.item_name == null && item.product_id != null)
                .map(item => Number(item.product_id))
        )];
        if (missingNameProductIds.length > 0) {
            const [products] = await conn.query(
                `SELECT id, name
                   FROM products
                  WHERE id IN (${missingNameProductIds.map(() => '?').join(',')})`,
                missingNameProductIds
            );
            const productNames = new Map(products.map(product => [Number(product.id), product.name]));
            allOrderItems = allOrderItems.map(item => ({
                ...item,
                item_name: item.item_name ?? productNames.get(Number(item.product_id)) ?? null
            }));
        }

        const parentOrderItems = allOrderItems.filter(item => item.parent_item_id == null);
        const serviceChargeItemIds = new Set(
            parentOrderItems
                .filter(item => item.note === SERVICE_NOTE)
                .map(item => Number(item.id))
        );
        const orderItems = parentOrderItems.filter(item => item.note !== SERVICE_NOTE);
        if (orderItems.length === 0) fail(400, 'Order has no refundable items.');

        const byId = new Map(orderItems.map(item => [Number(item.id), item]));
        let lines;
        if (items) {
            lines = items.map(selected => {
                if (serviceChargeItemIds.has(Number(selected.order_item_id))) {
                    fail(400, 'Service charge is not a voidable item.');
                }
                const item = byId.get(Number(selected.order_item_id));
                if (!item) fail(400, 'Item does not belong to this order.');
                const qty = Number(selected.qty);
                if (!Number.isFinite(qty) || Number(qty.toFixed(6)) !== qty) {
                    fail(400, 'Void quantity must use at most six decimal places.');
                }
                if (!(qty > 0) || qty > Number(item.quantity) + 1e-9) {
                    fail(400, 'Requested refund quantity exceeds the refundable amount.');
                }
                return { it: item, qty };
            });
        } else {
            lines = orderItems
                .map(item => ({ it: item, qty: Number(item.quantity) }))
                .filter(line => line.qty > 1e-9);
            if (lines.length === 0) fail(400, 'Nothing left to refund.');
        }

        const childrenByParent = new Map();
        for (const item of allOrderItems) {
            if (item.parent_item_id == null) continue;
            const parentId = Number(item.parent_item_id);
            if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
            childrenByParent.get(parentId).push(item);
        }
        const voidKitchenRows = lines.flatMap(({ it, qty }) => {
            const parentQty = Number(it.quantity);
            const fraction = parentQty > 0 ? qty / parentQty : 0;
            const parent = { ...it, quantity: qty, qty };
            const children = (childrenByParent.get(Number(it.id)) || []).map(child => {
                const childQty = Number(child.quantity) * fraction;
                return {
                    ...child,
                    quantity: childQty,
                    qty: childQty,
                    created_at: child.created_at || it.created_at
                };
            });
            return [parent, ...children];
        });

        const voidedByItem = new Map(lines.map(line => [Number(line.it.id), line.qty]));
        const emptiesOrder = orderItems.every(item => (
            Number(item.quantity) - (voidedByItem.get(Number(item.id)) || 0) <= 1e-9
        ));

        const orderSubtotal = Number(order.subtotal) || 0;
        let discountedSubtotal = orderSubtotal;
        if (order.discount_type === 'fixed') {
            discountedSubtotal -= Number(order.discount_value) || 0;
        } else if (order.discount_type === 'percent') {
            discountedSubtotal -= discountedSubtotal * ((Number(order.discount_value) || 0) / 100);
        }
        discountedSubtotal = Math.max(0, discountedSubtotal);
        const discountRatio = orderSubtotal > 0 ? discountedSubtotal / orderSubtotal : 1;

        let subtotalVoided = 0;
        let taxVoided = 0;
        const computed = lines.map(({ it, qty }) => {
            const fullQty = Number(it.quantity) || 1;
            const lineNetFull = calculateLineSubtotal({
                price: Number(it.price_at_sale),
                qty: fullQty,
                discountType: it.discount_type || null,
                discountValue: Number(it.discount_value) || 0,
                modifier_surcharge: it.modifier_surcharge,
                modifier_tax_amount: it.modifier_tax_amount
            }, Number(it.tax_rate || 0), Number(order.tax_inclusive_at_sale) === 1, {
                taxRegistrationType,
                taxExempt: Number(order.tax_exempt_at_sale) === 1,
                pricesAlreadyExempt: Number(order.tax_exempt_at_sale) === 1
            }) * discountRatio;
            const fraction = qty / fullQty;
            const lineSubtotal = roundMoney(lineNetFull * fraction);
            const lineTax = roundMoney(Number(it.tax_amount) * fraction);
            subtotalVoided += lineSubtotal;
            taxVoided += lineTax;
            return {
                order_item_id: it.id,
                product_id: it.product_id,
                stock_authority: it.stock_authority,
                stock_snapshot: it.stock_snapshot,
                item_name: it.item_name,
                note: it.note,
                quantity: qty,
                unit_price: Number(it.price_at_sale),
                line_subtotal: lineSubtotal,
                line_tax: lineTax,
                line_total: roundMoney(lineSubtotal + lineTax)
            };
        });
        subtotalVoided = roundMoney(subtotalVoided);
        taxVoided = roundMoney(taxVoided);

        const preClampSubtotal = subtotalVoided;
        if (subtotalVoided > roundMoney(discountedSubtotal)) {
            subtotalVoided = roundMoney(discountedSubtotal);
        }
        if (computed.length && subtotalVoided < preClampSubtotal - 1e-9) {
            allocateMoneyAcrossRows(computed, 'line_subtotal', subtotalVoided);
        }
        computed.forEach(line => {
            line.line_total = roundMoney(line.line_subtotal + line.line_tax);
        });

        const checkoutSettings = await getSettings(conn, ['stock_enabled']);
        const stockEnabled = checkoutSettings.stock_enabled === '1' || computed.some(line => ['product', 'legacy_product'].includes(line.stock_authority));

        const scope = emptiesOrder ? 'order' : 'item';
        // xyz suppresses history only for this unpaid-table operation. It does
        // not grant void permission and never changes paid-refund bookkeeping.
        const auditDisabled = await isAuditDisabled(conn, user.id);
        let refundId = null;
        if (!auditDisabled) {
            const [refundInsert] = await conn.query(
                `INSERT INTO refunds
                   (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded,
                    refund_method, reason, restocked, user_id, shift_id, table_id, table_number, ip_address)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                ['void', invoiceId, scope, subtotalVoided, taxVoided, 0, null, reason,
                 stockEnabled ? 1 : 0, user.id, order.shift_id, order.table_id,
                 lockedTable.table_number == null ? null : String(lockedTable.table_number), ipAddress]
            );
            refundId = refundInsert.insertId;
            const archivedQuantities = new Map();
            for (const { it, qty } of lines) {
                archivedQuantities.set(Number(it.id), qty);
                for (const child of childrenByParent.get(Number(it.id)) || []) {
                    // Match the six-decimal remaining child written by the existing
                    // bundle writer. A sub-precision cancellation may remove zero
                    // stored child units; retain its snapshot without inventing units.
                    const remaining = Number(((Number(child.quantity) / Number(it.quantity)) * (Number(it.quantity) - qty)).toFixed(6));
                    archivedQuantities.set(Number(child.id), Number((Number(child.quantity) - remaining).toFixed(6)));
                }
            }
            if (emptiesOrder) {
                for (const row of parentOrderItems.filter(item => item.note === SERVICE_NOTE)) {
                    archivedQuantities.set(Number(row.id), Number(row.quantity));
                }
            }
            await archiveCancelledItems(conn, {
                refundId, invoiceId,
                rows: allOrderItems.filter(row => archivedQuantities.has(Number(row.id))),
                quantities: archivedQuantities
            });
        }
        // Product stock operations and kitchen jobs require a distinct identity
        // even when no refund/history row exists. Ingredient reversals can use a
        // null source_id and retain their existing locked recipe-line identity.
        const voidBatchId = refundId == null ? randomUUID() : String(refundId);
        const stockItemIds = new Set();
        if(stockEnabled)await prepareStockWrite(conn,{savedItems:lines.map(({it})=>it)});
        if (stockEnabled) await restoreStockForCart(conn, computed, { touchedStockItemIds: stockItemIds, savedAuthorityOnly:checkoutSettings.stock_enabled !== '1', source: { type: 'void', id: voidBatchId }, businessDate: getBusinessDate(), actorId: user.id });

        const refundItemRows = (auditDisabled ? [] : computed).map(line => [
            refundId, line.order_item_id, line.product_id, line.item_name, line.note,
            line.quantity, line.unit_price, line.line_subtotal, line.line_tax, line.line_total
        ]);
        if (refundItemRows.length) {
            await conn.query(
                `INSERT INTO refund_items
                   (refund_id, order_item_id, product_id, item_name, note, quantity,
                    unit_price, line_subtotal, line_tax, line_total)
                 VALUES ?`,
                [refundItemRows]
            );
        }

        const reversed = await reverseLinesUsage(conn, {
            lines: lines.map(({ it, qty }) => ({ lineKey: it.recipe_line_key, qty })),
            sourceType: 'void',
            sourceId: refundId,
            sourceLabel: refundId == null ? null : `Void #${refundId}`,
            actor: { id: user.id, name: user.name },
            businessDate: getBusinessDate()
        });
        const ledgerChangedIngredientIds = reversed.changedIngredientIds;

        let clearedTableIds = [];
        let tableFreed = false;
        if (emptiesOrder) {
            await abandonBoundOpenOrderSnapshot(conn, order, tableContext.serviceChargeSnapshot);
            await conn.query(
                `UPDATE orders
                    SET payment_method='voided',
                        original_total=total, original_subtotal=subtotal, original_tax=tax,
                        void_reason=?
                  WHERE invoice_id=?`,
                [reason || 'مرتجع', invoiceId]
            );
            order.payment_method = 'voided';
            if (order.table_id) {
                clearedTableIds = tableContext.groupTableIds;
                await conn.query(
                    "UPDATE restaurant_tables SET status='available', current_order_id=NULL, parent_table_id=NULL WHERE id IN (?)",
                    [clearedTableIds]
                );
                tableFreed = true;
            }
        } else {
            const [bundleRows] = await conn.query(
                'SELECT DISTINCT parent_item_id FROM order_items WHERE invoice_id = ? AND parent_item_id IS NOT NULL',
                [invoiceId]
            );
            const bundleParentIds = new Set(bundleRows.map(row => Number(row.parent_item_id)));
            for (const { it, qty } of lines) {
                const newQty = Number(it.quantity) - qty;
                const isBundleParent = bundleParentIds.has(Number(it.id));
                if (newQty <= 1e-9) {
                    if (isBundleParent) {
                        await conn.query('DELETE FROM order_items WHERE parent_item_id = ?', [it.id]);
                    }
                    await conn.query('DELETE FROM order_items WHERE id = ?', [it.id]);
                } else if (isBundleParent) {
                    const [childRows] = await conn.query(
                        'SELECT * FROM order_items WHERE parent_item_id = ?',
                        [it.id]
                    );
                    await conn.query('DELETE FROM order_items WHERE parent_item_id = ?', [it.id]);
                    await conn.query('UPDATE order_items SET quantity = ? WHERE id = ?', [newQty, it.id]);
                    await insertPersistedBundleChildren(conn, {
                        invoiceId,
                        parentItemId: Number(it.id),
                        parentRow: {
                            id: it.id,
                            invoice_id: invoiceId,
                            parent_item_id: null,
                            quantity: Number(it.quantity)
                        },
                        childRows,
                        parentQty: newQty,
                        startSortOrder: Number(it.sort_order || 0) + 1
                    });
                } else {
                    await conn.query('UPDATE order_items SET quantity = ? WHERE id = ?', [newQty, it.id]);
                }
            }
            await repriceBoundServiceCharge(conn, order, tableContext.serviceChargeSnapshot);
            await recomputeOrderTotals(conn, invoiceId);
            if (order.table_id) clearedTableIds = tableContext.groupTableIds;
        }
        const refundStatus = await syncOrderRefundStatus(conn, order);

        await appendAuditEvent(conn, {
            eventType: 'void_order',
            userId: user.id,
            entityType: 'order',
            entityId: invoiceId,
            oldValue: { payment_method: order.payment_method },
            newValue: { refund_id: refundId, kind: 'void', amount_refunded: 0, reason },
            ipAddress
        }, { auditDisabled });

        if (emptiesOrder) await removeNeverIssuedOrder(conn, invoiceId);

        await conn.commit();
        hasTransaction = false;
        conn.release();
        conn = null;

        await runPostCommitEffects({
            io,
            printKitchenOrder,
            invoiceId,
            refundId,
            voidBatchId,
            order,
            lockedTable,
            voidKitchenRows,
            clearedTableIds,
            stockEnabled,
            stockProductIds: computed.map(line => line.product_id),
            stockItemIds: [...stockItemIds],
            ledgerChangedIngredientIds: [...new Set(ledgerChangedIngredientIds.map(Number))]
        });

        return {
            refund_id: refundId,
            kind: 'void',
            scope,
            refund_status: refundStatus,
            amount_refunded: 0,
            table_freed: tableFreed
        };
    } catch (error) {
        if (hasTransaction && conn) await conn.rollback().catch(() => {});
        throw error;
    } finally {
        if (conn) conn.release();
    }
}

module.exports = { voidOpenTableOrder };
