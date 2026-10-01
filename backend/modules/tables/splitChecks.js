const { getConnection: getStockConnection } = require('../../services/StockReportInvalidation');
const { reconstructBundleSubs } = require('../../services/bundleOrderItems');
const { assertNestedBundleIntegrity } = require('../../services/bundleIntegrity');
const { buildOrderIdentity } = require('../../utils/orderIdentity');
const { appendAuditEvent, appendAuditEvents } = require('../../services/auditEvents');
const { allocateServiceChargeCents } = require('../../services/ServiceChargeCalculator');
const {
    allocateCents,
    allocateSplitMoneyCents,
    validateSplitMoneyCents,
    moneyToCents
} = require('../../services/SplitMoneyAllocator');
const { conflict, createChildHeldSnapshot, getForUpdate, transition } = require('../../services/ServiceChargeSnapshotService');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { emitHeldOrdersChanged } = require('../../services/HeldOrderEvents');
const { invalidateCatalogCache, invalidateDashboardCache } = require('../../config/cache');
const { normalizeCartItems, calculateExpectedTotals } = require('../../services/PosCalculator');
const { isAdminRole: isAdminUser, canOverrideTables, assertTableSectionAccess } = require('../../services/PermissionService');
const { lockTableSession, assertNoActiveSplitChecks } = require('../../services/TableSettlementContext');
const { fetchCartProducts } = require('../../services/InventoryService');
const { loadCheckoutSettings } = require('../../services/OrderPricing');
const { getSettings } = require('../../config/settingsHelper');
const { broadcastTableUpdates } = require('../../services/TableRealtime');
const { TAX_REGISTRATION_TYPES, normalizeTaxRegistrationType } = require('../../config/taxRegistration');

async function broadcastSplitChanges(io, tableIds, heldEvents) {
    if (!io) return;
    try {
        for (const event of heldEvents) emitHeldOrdersChanged(io, event.action, event.row, event.extra);
    } catch (error) {
        logger.error({ err: error, tableIds }, 'Split list notification failed after commit.');
    }
    await broadcastTableUpdates(io, tableIds);
}

async function lockSplitCheckForMutation(conn, id, user) {
    const [probeRows] = await conn.query(
        `SELECT id, reference_name, subtotal, cart_data, service_charge_snapshot_id,
                parent_invoice_id, table_id
           FROM held_orders WHERE id=?`,
        [id]
    );
    if (!probeRows.length) return null;
    let payload = null;
    try { payload = JSON.parse(probeRows[0].cart_data || '{}'); } catch (_) { /* legacy */ }
    const progressive = Number(payload?.progressive_split_version) === 2 &&
        Number.isSafeInteger(Number(probeRows[0].parent_invoice_id)) &&
        Number.isSafeInteger(Number(probeRows[0].table_id));
    if (!progressive) {
        // Legacy checks can outlive their parent bill. Resolve the persisted
        // seat (or parent seat) and authorize it before locking/deleting a check.
        const [tables] = await conn.query(
            `SELECT t.id, t.section_id FROM restaurant_tables t
              WHERE t.id = COALESCE(?, (SELECT table_id FROM orders WHERE invoice_id=?))
              ORDER BY t.id FOR UPDATE`,
            [probeRows[0].table_id, probeRows[0].parent_invoice_id]
        );
        assertTableSectionAccess(user, tables);
        const [lockedRows] = await conn.query(
            `SELECT id, reference_name, subtotal, cart_data, service_charge_snapshot_id,
                    parent_invoice_id, table_id
               FROM held_orders WHERE id=? FOR UPDATE`,
            [id]
        );
        if (lockedRows.length && (lockedRows[0].table_id !== probeRows[0].table_id
            || lockedRows[0].parent_invoice_id !== probeRows[0].parent_invoice_id)) {
            throw Object.assign(new Error('The split table changed. Refresh and try again.'), { statusCode: 409, publicCode: 'TABLE_SESSION_CONFLICT' });
        }
        return lockedRows.length ? { row: lockedRows[0], progressive: false, siblings: lockedRows, tableContext: null } : null;
    }
    const tableContext = await lockTableSession(conn, {
        user,
        tableId: probeRows[0].table_id,
        invoiceId: probeRows[0].parent_invoice_id,
        withMoney: false
    });
    const [siblings] = await conn.query(
        `SELECT id, reference_name, subtotal, cart_data, service_charge_snapshot_id,
                parent_invoice_id, table_id
           FROM held_orders WHERE parent_invoice_id=? ORDER BY id FOR UPDATE`,
        [probeRows[0].parent_invoice_id]
    );
    const row = siblings.find(sibling => Number(sibling.id) === Number(id));
    return row ? { row, progressive: true, siblings, tableContext } : null;
}

const parseSplitPayload = (row) => {
    try {
        const parsed = JSON.parse(row.cart_data || '{}');
        return Array.isArray(parsed) ? { items: parsed } : parsed;
    } catch (_) {
        return null;
    }
};

const splitLineKey = (item) => {
    const orderItemId = Number(item?.order_item_id);
    if (Number.isSafeInteger(orderItemId) && orderItemId > 0) return `order:${orderItemId}`;
    return JSON.stringify([
        item?.product_id ?? item?.id ?? null,
        item?.name ?? item?.item_name ?? '',
        item?.note ?? '',
        item?.price ?? item?.price_at_sale ?? null,
        item?.tax_rate ?? null,
        item?.jofotara_tax_category ?? null,
        item?.modifier_surcharge ?? null,
        item?.modifier_tax_amount ?? null,
        item?.selectedModifiers ?? item?.selected_modifiers ?? null,
        item?.bundleItems ?? null
    ]);
};

const quantityMicros = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const micros = Math.round(numeric * 1_000_000);
    return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
};

async function rewriteUnpaidSplitChecks({ user, splitId, expectedChecks, splits, io = null, ipAddress = null }) {
    let conn;
    let hasTransaction = false;
    try {
        if (!Number.isSafeInteger(Number(splitId)) || Number(splitId) <= 0
            || !Array.isArray(expectedChecks) || !expectedChecks.length
            || !Array.isArray(splits) || !splits.length) {
            const error = new Error('Invalid split group edit payload.');
            error.statusCode = 400;
            throw error;
        }
        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        hasTransaction = true;
        const locked = await lockSplitCheckForMutation(conn, Number(splitId), user);
        if (!locked) {
            const error = new Error('Split check not found or already paid.');
            error.statusCode = 404;
            throw error;
        }
        if (!locked.progressive) {
            const error = new Error('Legacy split checks cannot be edited. Cancel and split the table again.');
            error.statusCode = 409;
            error.publicCode = 'SPLIT_EDIT_UNSUPPORTED';
            throw error;
        }

        const expected = new Map(expectedChecks.map(check => [Number(check.id), Number(check.revision)]));
        const current = locked.siblings.map(row => ({ row, payload: parseSplitPayload(row) }));
        const revisionsMatch = expected.size === current.length && current.every(({ row, payload }) => (
            expected.get(Number(row.id)) === Number(payload?.split_revision || 1)
        ));
        if (!revisionsMatch) {
            const error = new Error('Split checks changed on another terminal. Refresh and try again.');
            error.statusCode = 409;
            error.publicCode = 'SPLIT_GROUP_CHANGED';
            throw error;
        }
        if (current.some(({ payload }) => !payload || Number(payload.progressive_split_version) !== 2)) {
            const error = new Error('Split group data is invalid.');
            error.statusCode = 409;
            error.publicCode = 'SPLIT_GROUP_INVALID';
            throw error;
        }

        const submittedIds = splits.filter(split => split.id != null).map(split => Number(split.id));
        const currentIds = new Set(current.map(({ row }) => Number(row.id)));
        if (new Set(submittedIds).size !== submittedIds.length || submittedIds.some(id => !currentIds.has(id))) {
            const error = new Error('Split group contains an unknown or duplicate check.');
            error.statusCode = 409;
            error.publicCode = 'SPLIT_GROUP_CHANGED';
            throw error;
        }
        if (splits.filter(split => split.split_role === 'remainder').length > 1) {
            const error = new Error('A split group can contain only one Remaining Check.');
            error.statusCode = 400;
            throw error;
        }

        const sourceLines = new Map();
        let serviceChargeCents = 0;
        let feeTemplate = null;
        const sourceMoney = { subtotal: 0, discount: 0, tax: 0, total: 0 };
        for (const { payload } of current) {
            const allocation = validateSplitMoneyCents(payload.split_money_cents);
            for (const component of Object.keys(sourceMoney)) sourceMoney[component] += allocation[component];
            const heldFeeCents = Number(payload.service_charge_allocation_cents || 0);
            if (!Number.isSafeInteger(heldFeeCents) || heldFeeCents < 0) {
                throw Object.assign(new Error('Split service-charge allocation is invalid.'), { statusCode: 409, publicCode: 'SPLIT_GROUP_INVALID' });
            }
            serviceChargeCents += heldFeeCents;
            for (const item of payload.items || []) {
                if (item.note === 'Auto-Gratuity') {
                    if (!feeTemplate) feeTemplate = { ...item };
                    continue;
                }
                const micros = quantityMicros(item.qty ?? item.quantity);
                if (!micros) throw Object.assign(new Error('Split group contains an invalid quantity.'), { statusCode: 409, publicCode: 'SPLIT_GROUP_INVALID' });
                const key = splitLineKey(item);
                const entry = sourceLines.get(key) || { template: { ...item }, micros: 0 };
                entry.micros += micros;
                sourceLines.set(key, entry);
            }
        }

        const submittedTotals = new Map();
        const targets = splits.map((split, index) => {
            if (!Array.isArray(split.items) || split.items.length === 0) {
                const error = new Error('Every split check must contain at least one item.');
                error.statusCode = 400;
                throw error;
            }
            const items = split.items.filter(item => item.note !== 'Auto-Gratuity').map((item, itemIndex) => {
                const key = splitLineKey(item);
                const source = sourceLines.get(key);
                const micros = quantityMicros(item.qty ?? item.quantity);
                if (!source || !micros) {
                    const error = new Error('Split items changed or do not belong to this unpaid group.');
                    error.statusCode = 409;
                    error.publicCode = 'SPLIT_ITEMS_MISMATCH';
                    throw error;
                }
                submittedTotals.set(key, (submittedTotals.get(key) || 0) + micros);
                return { ...source.template, qty: micros / 1_000_000, cartId: item.cartId || `SPLIT_EDIT_${index}_${itemIndex}` };
            });
            if (!items.length) {
                const error = new Error('Every split check must contain at least one non-fee item.');
                error.statusCode = 400;
                throw error;
            }
            return { ...split, split_role: split.split_role === 'remainder' ? 'remainder' : 'check', items };
        });
        const conserved = sourceLines.size === submittedTotals.size && [...sourceLines].every(([key, value]) => submittedTotals.get(key) === value.micros);
        if (!conserved) {
            const error = new Error('Split item quantities must exactly conserve the unpaid checks.');
            error.statusCode = 409;
            error.publicCode = 'SPLIT_ITEMS_MISMATCH';
            throw error;
        }

        let parentServiceSnapshot = null;
        const parentSnapshotId = locked.tableContext.order.service_charge_snapshot_id;
        if (parentSnapshotId) {
            parentServiceSnapshot = await getForUpdate(conn, parentSnapshotId);
            if (parentServiceSnapshot.state !== 'split_parent'
                || parentServiceSnapshot.holder_type !== 'order'
                || String(parentServiceSnapshot.holder_id) !== String(locked.row.parent_invoice_id)) {
                throw conflict('Service-charge snapshot changed. Refresh and try again.');
            }
        }
        if ((serviceChargeCents > 0 || feeTemplate) && !parentServiceSnapshot) {
            throw conflict('Service-charge snapshot is missing. Refresh and try again.');
        }

        const weights = targets.map(target => target.items.reduce((sum, item) => (
            sum + Math.max(0, Number(item.price ?? item.price_at_sale) || 0) * Number(item.qty)
        ), 0));
        if (weights.every(weight => weight <= 0) && Object.values(sourceMoney).some(value => value > 0)) {
            const error = new Error('Split group money cannot be allocated without a positive item value.');
            error.statusCode = 400;
            throw error;
        }
        const allocations = allocateSplitMoneyCents({
            subtotal: sourceMoney.subtotal / 100,
            tax: sourceMoney.tax / 100,
            total: sourceMoney.total / 100
        }, weights.map(weight => ({ subtotal: weight, discount: weight, tax: weight, total: weight })));
        const feeAllocations = serviceChargeCents > 0 ? allocateCents(serviceChargeCents, weights) : weights.map(() => 0);
        const percentDiscount = current.map(({ payload }) => payload.order_discount)
            .find(value => value?.type === 'percent');
        const basePayload = current[0].payload;
        const retainedById = new Map(current.map(value => [Number(value.row.id), value]));
        const resultingIds = [];
        const heldEvents = [];
        const heldEvent = (action, heldId) => ({ action, row: { id: heldId, parent_invoice_id: locked.row.parent_invoice_id, table_id: locked.row.table_id } });

        let nextCheckNumber = 2;
        for (let index = 0; index < targets.length; index++) {
            const target = targets[index];
            const existing = target.id != null ? retainedById.get(Number(target.id)) : null;
            const feeCents = feeAllocations[index];
            const items = feeCents > 0 && feeTemplate
                ? [...target.items, { ...feeTemplate, price: feeCents / 100, qty: 1, cartId: `FEE_SPLIT_EDIT_${index}` }]
                : target.items;
            const revision = existing ? Number(existing.payload.split_revision || 1) + 1 : 1;
            const allocation = allocations[index];
            const payload = {
                ...basePayload,
                items,
                split_role: target.split_role,
                split_revision: revision,
                split_money_cents: allocation,
                service_charge_allocation_cents: feeCents,
                order_discount: percentDiscount
                    ? { type: 'percent', value: Number(percentDiscount.value) || 0 }
                    : allocation.discount > 0 ? { type: 'fixed', value: allocation.discount / 100 } : null
            };
            const label = target.split_role === 'remainder' ? 'Remaining Check' : `Check ${nextCheckNumber++}`;
            const referenceName = `Table ${locked.tableContext.rootTable.table_number} - ${label}`;
            let heldId;
            if (existing) {
                heldId = Number(existing.row.id);
                await conn.query(
                    'UPDATE held_orders SET reference_name=?, cart_data=?, subtotal=? WHERE id=?',
                    [referenceName, JSON.stringify(payload), allocation.total / 100, heldId]
                );
                retainedById.delete(heldId);
                heldEvents.push(heldEvent('updated', heldId));
            } else {
                const [inserted] = await conn.query(
                    `INSERT INTO held_orders
                        (user_id, reference_name, cart_data, subtotal, service_charge_snapshot_id, parent_invoice_id, table_id)
                     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
                    [user.id, referenceName, JSON.stringify(payload), allocation.total / 100, locked.row.parent_invoice_id, locked.row.table_id]
                );
                heldId = Number(inserted.insertId);
                if (parentServiceSnapshot) {
                    const child = await createChildHeldSnapshot(conn, {
                        parentSnapshot: parentServiceSnapshot,
                        heldOrderId: heldId,
                        userId: user.id
                    });
                    await conn.query('UPDATE held_orders SET service_charge_snapshot_id=? WHERE id=?', [child.id, heldId]);
                }
                await appendAuditEvent(conn, {
                    eventType: 'split_check_created', userId: user.id, entityType: 'held_order', entityId: heldId,
                    newValue: { parent_invoice_id: Number(locked.row.parent_invoice_id), bundle_snapshot_version: 1 }, ipAddress
                });
                heldEvents.push(heldEvent('created', heldId));
            }
            resultingIds.push(heldId);
        }

        for (const { row } of retainedById.values()) {
            if (row.service_charge_snapshot_id) {
                const snapshot = await getForUpdate(conn, row.service_charge_snapshot_id);
                if (snapshot.state === 'held') await transition(conn, {
                    snapshotId: snapshot.id, version: snapshot.version, from: 'held', to: 'abandoned', holderType: 'none', holderId: null
                });
            }
            await conn.query('DELETE FROM held_orders WHERE id=?', [row.id]);
            heldEvents.push(heldEvent('removed', row.id));
        }
        await appendAuditEvent(conn, {
            eventType: 'split_group_rebalanced', userId: user.id, entityType: 'order', entityId: Number(locked.row.parent_invoice_id),
            oldValue: { split_ids: current.map(({ row }) => Number(row.id)) },
            newValue: { split_ids: resultingIds, table_id: Number(locked.row.table_id) }, ipAddress
        });
        await conn.commit();
        hasTransaction = false;
        conn.release();
        conn = null;
        await broadcastSplitChanges(io, locked.tableContext.groupTableIds, heldEvents);
        return { message: 'Unpaid split checks updated.', split_ids: resultingIds };
    } catch (error) {
        if (hasTransaction && conn) await conn.rollback().catch(() => {});
        logger.error({ err: error, splitId }, 'Atomic split group rewrite failed.');
        throw error;
    } finally {
        if (conn) conn.release();
    }
}

async function discardSplitCheck({ user, id, io = null, ipAddress = null }) {
    let conn;
    let hasTransaction = false;
    try {
        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        hasTransaction = true;

        const locked = await lockSplitCheckForMutation(conn, id, user);
        if (!locked) {
            const error = new Error('Split check not found.');
            error.statusCode = 404;
            throw error;
        }

        const heldRow = locked.row;
        if (heldRow.parent_invoice_id == null || heldRow.table_id == null) {
            const error = new Error('Forbidden: Only table splits can be deleted via this endpoint.');
            error.statusCode = 403;
            throw error;
        }

        const isProgressive = locked.progressive;

        if (isProgressive) {
            const tableContext = locked.tableContext;
            const [[paid]] = await conn.query(
                `SELECT COUNT(*) count FROM orders
                  WHERE parent_invoice_id=? AND payment_method IN ('cash','card','split')`,
                [heldRow.parent_invoice_id]
            );
            if (Number(paid.count) > 0) {
                const error = new Error('Paid split checks cannot be cancelled or returned to the parent order.');
                error.statusCode = 409;
                error.publicCode = 'SPLIT_ALREADY_PAID';
                throw error;
            }
            const siblings = locked.siblings;
            for (const sibling of siblings) {
                if (!sibling.service_charge_snapshot_id) continue;
                const snapshot = await getForUpdate(conn, sibling.service_charge_snapshot_id);
                if (snapshot.state === 'held') {
                    await transition(conn, {
                        snapshotId: snapshot.id,
                        version: snapshot.version,
                        from: 'held',
                        to: 'abandoned',
                        holderType: 'none',
                        holderId: null
                    });
                }
            }
            const [[parent]] = await conn.query(
                'SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=? FOR UPDATE',
                [heldRow.parent_invoice_id]
            );
            if (parent?.service_charge_snapshot_id) {
                const snapshot = await getForUpdate(conn, parent.service_charge_snapshot_id);
                if (snapshot.state === 'split_parent') {
                    await transition(conn, {
                        snapshotId: snapshot.id,
                        version: snapshot.version,
                        from: 'split_parent',
                        to: 'open_order',
                        holderType: 'order',
                        holderId: String(heldRow.parent_invoice_id)
                    });
                }
            }
            await conn.query('DELETE FROM held_orders WHERE parent_invoice_id=?', [heldRow.parent_invoice_id]);
            await appendAuditEvent(conn, {
                eventType: 'split_group_cancelled',
                userId: user.id,
                entityType: 'order',
                entityId: heldRow.parent_invoice_id,
                oldValue: { split_ids: siblings.map(sibling => sibling.id) },
                newValue: { table_id: heldRow.table_id },
                ipAddress: ipAddress || null
            });
            await conn.commit();
            hasTransaction = false;
            conn.release();
            conn = null;
            await broadcastSplitChanges(io, tableContext.groupTableIds, siblings.map(sibling => ({
                action: 'removed',
                row: { id: sibling.id, parent_invoice_id: heldRow.parent_invoice_id, table_id: heldRow.table_id }
            })));
            return {
                message: 'Split cancelled. The original table order is ready to edit or split again.',
                parent_invoice_id: Number(heldRow.parent_invoice_id),
                table_id: Number(tableContext.rootTable.id)
            };
        }

        const [deleted] = await conn.query("DELETE FROM held_orders WHERE id=?", [id]);
        if (Number(deleted.affectedRows) !== 1) {
            const error = new Error('Split check changed while it was being discarded.');
            error.statusCode = 409;
            error.publicCode = 'TABLE_SESSION_CONFLICT';
            throw error;
        }

        // A discarded split is served food (parent already voided + stock returned at
        // split time). Record actor + seat + amount in the same transaction as deletion.
        let itemCount = 0;
        try {
            const parsed = JSON.parse(heldRow.cart_data || '{}');
            itemCount = Array.isArray(parsed)
                ? parsed.length
                : (Array.isArray(parsed.items) ? parsed.items.length : 0);
        } catch (e) { /* leave itemCount = 0 */ }
        await appendAuditEvent(conn, {
            eventType: 'discard_split_check',
            userId: user.id,
            entityType: 'held_order',
            entityId: id,
            oldValue: { reference_name: heldRow.reference_name, amount: Number(heldRow.subtotal), item_count: itemCount },
            ipAddress: ipAddress || null
        });
        await conn.commit();
        hasTransaction = false;
        return { message: "Split check deleted successfully." };
    } catch (error) {
        if (hasTransaction && conn) await conn.rollback().catch(() => {});
        logger.error({ err: error, splitId: id }, 'POS DELETE /table_splits failed');
        throw error;
    } finally {
        if (conn) conn.release();
    }
}

async function createSplitChecks({ user, tableId, currentOrderId, splits, io, ipAddress = null }) {
    let conn;
    let hasTransaction = false;
    try {
        for (const seat of splits) {
            assertNestedBundleIntegrity(seat.items);
        }
        conn = await getStockConnection(pool);
        await conn.beginTransaction();
        hasTransaction = true;
        const tableContext = await lockTableSession(conn, {
            user,
            tableId,
            invoiceId: currentOrderId,
            withMoney: true
        });
        const { receiptTaxInclusiveDisplay } = await loadCheckoutSettings(conn);

        const isTableSplit = !!(tableId && currentOrderId);
        let tableIdsToBroadcast = [];
        let parentInvoiceId = null;
        let parentOrderId = null;
        let parentIdentity = buildOrderIdentity({});
        let normalizedSplits = [];
        let parentServiceSnapshot = null;
        let allocatedServiceChargeCents = [];
        let serverSeatDiscounts = [];
        let splitMoneyCents = [];
        let parentTaxInclusive = null;
        let parentReceiptTaxInclusive = null;
        let parentTaxExempt = false;
        let parentTaxRegistrationType = null;

        // 1. Split the server-locked table settlement context.
        if (isTableSplit) {
            await assertNoActiveSplitChecks(conn, currentOrderId);
            // A child request resolves to its root; every sibling is already locked.
            const table = tableContext.rootTable;
            if (table.status === 'printed' && !isAdminUser(user)) {
                throw new Error('Forbidden: Only an admin or programmer can split a printed table.');
            }

            const parentOrder = {
                ...tableContext.order,
                table_number: tableContext.rootTable.table_number
            };

            parentInvoiceId = parentOrder.invoice_id;
            parentOrderId = parentOrder.order_id;
            parentIdentity = buildOrderIdentity(parentOrder);
            const allParentOrderItems = tableContext.savedItems;
            parentTaxInclusive = parentOrder.tax_inclusive_at_sale;
            parentReceiptTaxInclusive = parentOrder.receipt_tax_inclusive_at_sale;
            parentTaxExempt = Number(parentOrder.tax_exempt_at_sale) === 1;
            parentTaxRegistrationType = parentOrder.tax_registration_type_at_sale == null
                ? TAX_REGISTRATION_TYPES.SALES_TAX
                : normalizeTaxRegistrationType(parentOrder.tax_registration_type_at_sale);
            if (parentOrder.tax_registration_type_at_sale == null) {
                await conn.query(
                    'UPDATE orders SET version=COALESCE(version, 1)+1, tax_registration_type_at_sale=? WHERE invoice_id=?',
                    [parentTaxRegistrationType, parentInvoiceId]
                );
            }
            if (parentTaxInclusive == null) {
                const legacySetting = await getSettings(conn, ['tax_inclusive_pricing']);
                parentTaxInclusive = legacySetting.tax_inclusive_pricing === '1' ? 1 : 0;
                await conn.query("UPDATE orders SET version=COALESCE(version, 1)+1, tax_inclusive_at_sale = ? WHERE invoice_id = ?", [parentTaxInclusive, parentInvoiceId]);
            }
            if (parentReceiptTaxInclusive == null) parentReceiptTaxInclusive = parentTaxInclusive;
            parentServiceSnapshot = tableContext.serviceChargeSnapshot;

            // Ownership check: verify waiter owns the order
            if (parentOrder.waiter_id && String(parentOrder.waiter_id) !== String(user.id)) {
                if (!canOverrideTables(user)) {
                    throw new Error("Forbidden: Splitting another waiter's table requires override permission.");
                }
            }

            // Reconcile submitted seat money against the parent order before voiding
            // the live table. seat.subtotal is the guest's payable total (after tax, in
            // the parent order's frozen tax_inclusive_at_sale mode), so the seats must sum to the
            // parent's payable total. Checkout still re-derives final charges server-side.
            const parentTotal = Number(parentOrder.total) || 0;
            const seatSumCents = splits.reduce((sum, sPart) => sum + moneyToCents(Number(sPart.subtotal) || 0), 0);
            if (Math.abs(seatSumCents - moneyToCents(parentTotal)) > 2) {
                const error = new Error("Split reconciliation mismatch. Please refresh totals and try again.");
                error.statusCode = 400;
                throw error;
            }

            const itemKey = (productId, itemName, note) =>
                `${productId != null ? productId : 'custom:' + (itemName || '')}|${note || ''}`;

            normalizedSplits = splits.map((seat) => ({
                seat,
                normalizedItems: Array.isArray(seat.items) && seat.items.length > 0
                    ? normalizeCartItems(seat.items).filter(item => item.note !== 'Auto-Gratuity')
                    : []
            }));
            // Every submitted seat must carry at least one item. An item-less seat with a
            // declared subtotal would pad the reconciliation sum without ever being validated
            // or persisted (S1 money-loss hole). The client never produces one.
            if (normalizedSplits.some(({ normalizedItems }) => normalizedItems.length === 0)) {
                throw new Error("Split seat mismatch: every seat must contain at least one item.");
            }
            // Split totals need base-product tax rows. Note selections are frozen later
            // from their locked parent records and must not be re-canonicalized here.
            const splitProductMap = await fetchCartProducts(
                conn,
                normalizedSplits.flatMap(({ normalizedItems }) => normalizedItems),
                { includeNoteProducts: false }
            );
            const parentItems = allParentOrderItems.filter(item => item.parent_item_id == null);
            const parentItemsById = new Map(parentItems.map(item => [Number(item.id), item]));
            const persistedBundleChildrenByParentId = new Map();
            for (const item of allParentOrderItems) {
                if (item.parent_item_id == null) continue;
                const parentId = Number(item.parent_item_id);
                const children = persistedBundleChildrenByParentId.get(parentId) || [];
                children.push(item);
                persistedBundleChildrenByParentId.set(parentId, children);
            }
            const parentQtyByKey = new Map();
            const parentContextsByKey = new Map();
            const parentByLineId = new Map();
            const parentSurchargesByGroup = new Map();
            const surchargeKey = (value) => value == null ? 'NULL' : String(Number(value));
            const modifierSnapshotKey = (value) => value == null
                ? 'NULL'
                : (typeof value === 'string' ? value : JSON.stringify(value));
            const parseModifierSnapshot = (value) => {
                if (Array.isArray(value)) return value;
                if (typeof value !== 'string' || !value) return null;
                try {
                    const parsed = JSON.parse(value);
                    return Array.isArray(parsed) ? parsed : null;
                } catch (_) {
                    return null;
                }
            };
            let parentFee = 0;
            for (const item of parentItems) {
                if (item.note === 'Auto-Gratuity') {
                    parentFee += Number(item.price_at_sale) * Number(item.quantity);
                    continue;
                }
                const key = itemKey(item.product_id, item.item_name, item.note);
                parentQtyByKey.set(key, (parentQtyByKey.get(key) || 0) + Number(item.quantity));
                if (!parentContextsByKey.has(key)) parentContextsByKey.set(key, new Map());
                const surcharge = item.modifier_surcharge != null ? Number(item.modifier_surcharge) : null;
                const modifierTax = item.modifier_tax_amount != null ? Number(item.modifier_tax_amount) : null;
                const sourcePrice = item.price_before_tax_exemption != null
                    ? Number(item.price_before_tax_exemption)
                    : Number(item.price_at_sale);
                parentContextsByKey.get(key).set(
                    `${Number(item.price_at_sale)}|${sourcePrice}|${Number(item.tax_rate)}|${item.jofotara_tax_category}|${surchargeKey(surcharge)}|${surchargeKey(modifierTax)}|${modifierSnapshotKey(item.selected_modifiers)}|${item.stock_authority}|${JSON.stringify(item.stock_snapshot)}`,
                    {
                        price: parentTaxExempt ? sourcePrice : Number(item.price_at_sale),
                        tax: Number(item.tax_rate),
                        taxCategory: item.jofotara_tax_category,
                        surcharge,
                        modifierTax,
                        priceBeforeTaxExemption: parentTaxExempt ? sourcePrice : null,
                        selectedModifiers: item.selected_modifiers ?? null,
                        stock_authority: item.stock_authority || 'legacy',
                        stock_snapshot: item.stock_snapshot ?? null
                    }
                );
                parentByLineId.set(Number(item.id), {
                    product_id: item.product_id,
                    name: item.item_name || '',
                    note: item.note || '',
                    price: parentTaxExempt ? sourcePrice : Number(item.price_at_sale),
                    tax: Number(item.tax_rate),
                    taxCategory: item.jofotara_tax_category,
                    surcharge,
                    modifierTax,
                    priceBeforeTaxExemption: parentTaxExempt ? sourcePrice : null,
                    selectedModifiers: item.selected_modifiers ?? null,
                    recipe_line_key: item.recipe_line_key || null,
                    stock_authority: item.stock_authority || 'legacy',
                    stock_snapshot: item.stock_snapshot ?? null
                });
                if (!parentSurchargesByGroup.has(key)) parentSurchargesByGroup.set(key, new Set());
                parentSurchargesByGroup.get(key).add(surcharge);
            }

            const splitQtyByKey = new Map();
            const splitTaxRateOverrides = new Map();
            for (const { normalizedItems } of normalizedSplits) {
                for (const item of normalizedItems) {
                    const key = itemKey(item.product_id, item.item_name || item.name, item.note);
                    splitQtyByKey.set(key, (splitQtyByKey.get(key) || 0) + Number(item.qty));
                }
            }

            let itemsConserved = parentQtyByKey.size === splitQtyByKey.size;
            if (itemsConserved) {
                for (const [key, parentQty] of parentQtyByKey.entries()) {
                    if (Math.abs(parentQty - (splitQtyByKey.get(key) || 0)) > 0.0001) {
                        itemsConserved = false;
                        break;
                    }
                }
            }
            if (!itemsConserved) {
                throw new Error("Split items mismatch. Please refresh the table order and try again.");
            }

            // Pin each seat line to the price/tax captured on the parent order. A seat may not
            // be charged less (or more) than the saved table order for the same item; only the
            // distribution across seats is the caller's choice. Mirrors checkout.js frozen-price
            // settle. Closes S1 (underpricing) + F2 (per-seat prices unpinned).
            //
            // Prefer the stable parent line id (order_item_id, which the recall payload carries)
            // so two lines that share product+note but differ in price — a manager override, or a
            // menu-price change between two adds — each pin to their OWN parent price (P1). Fall
            // back to the product|note key when no id is supplied (legacy/synthetic callers). A
            // non-null order_item_id that is foreign to this order, or points at a different
            // product, is rejected as tampering.
            for (const { normalizedItems } of normalizedSplits) {
                for (const item of normalizedItems) {
                    const lineId = item.order_item_id != null ? Number(item.order_item_id) : null;
                    if (lineId != null) {
                        const parentLine = parentByLineId.get(lineId);
                        const sameProduct = parentLine && (parentLine.product_id == null
                            ? item.product_id == null
                            : Number(parentLine.product_id) === Number(item.product_id));
                        const sameNote = parentLine && parentLine.note === (item.note || '');
                        const sameName = parentLine && (parentLine.product_id != null || parentLine.name === (item.item_name || item.name || ''));
                        if (!parentLine || !sameProduct || !sameNote || !sameName) {
                            throw new Error("Split items mismatch. Please refresh the table order and try again.");
                        }
                        item.price = parentLine.price;
                        item.tax_rate = parentLine.tax;
                        item.jofotara_tax_category = parentLine.taxCategory;
                        item.modifier_surcharge = parentLine.surcharge;
                        item.modifier_tax_amount = parentLine.modifierTax;
                        item.selectedModifiers = parseModifierSnapshot(parentLine.selectedModifiers);
                        item.recipe_line_key = parentLine.recipe_line_key || null;
                        item.stock_authority = parentLine.stock_authority;
                        item.stock_snapshot = parentLine.stock_snapshot;
                        splitTaxRateOverrides.set(item, parentLine.tax);
                    } else {
                        delete item.recipe_line_key;
                        item.stock_authority = 'legacy';
                        item.stock_snapshot = null;
                        const key = itemKey(item.product_id, item.item_name || item.name, item.note);
                        const groupSurcharges = parentSurchargesByGroup.get(key);
                        if (groupSurcharges && groupSurcharges.size > 1) {
                            throw new Error("Split items mismatch. Please refresh the table order and try again.");
                        }
                        const contexts = parentContextsByKey.get(key);
                        if (contexts?.size === 1) {
                            const context = [...contexts.values()][0];
                            item.price = context.price;
                            item.tax_rate = context.tax;
                            item.jofotara_tax_category = context.taxCategory;
                            item.modifier_surcharge = context.surcharge;
                            item.modifier_tax_amount = context.modifierTax;
                            item.selectedModifiers = parseModifierSnapshot(context.selectedModifiers);
                            item.stock_authority = context.stock_authority;
                            item.stock_snapshot = context.stock_snapshot;
                            splitTaxRateOverrides.set(item, context.tax);
                        } else if (contexts?.size > 1) {
                            throw new Error("Split items mismatch. Please refresh the table order and try again.");
                        }
                    }
                }
            }

            // Product totals alone cannot conserve two separately frozen lines.
            // Validate each identified parent, then allocate its six-place units
            // exactly so three rounded thirds cannot strand a ledger remainder.
            const splitItemsByLineId = new Map();
            const fallbackGroups = new Set();
            for (const { normalizedItems } of normalizedSplits) {
                for (const item of normalizedItems) {
                    if (item.order_item_id == null) {
                        fallbackGroups.add(itemKey(item.product_id, item.item_name || item.name, item.note));
                        continue;
                    }
                    const id = Number(item.order_item_id);
                    if (!splitItemsByLineId.has(id)) splitItemsByLineId.set(id, []);
                    splitItemsByLineId.get(id).push(item);
                }
            }
            for (const parent of parentItems) {
                if (parent.note === 'Auto-Gratuity') continue;
                const items = splitItemsByLineId.get(Number(parent.id)) || [];
                const submittedQty = items.reduce((sum, item) => sum + Number(item.qty), 0);
                const parentQty = Number(parent.quantity);
                const hasFallback = fallbackGroups.has(itemKey(parent.product_id, parent.item_name, parent.note));
                if (submittedQty > parentQty + 0.0001 || (!hasFallback && Math.abs(submittedQty - parentQty) > 0.0001)) {
                    throw new Error('Split items mismatch. Please refresh the table order and try again.');
                }
                if (!items.length) continue;
                const target = quantityMicros(hasFallback ? submittedQty : parentQty);
                const quantities = allocateCents(target, items.map(item => Number(item.qty)));
                if (quantities.some(qty => qty <= 0)) {
                    throw new Error('Split quantities must be at least one millionth of a unit.');
                }
                items.forEach((item, index) => { item.qty = quantities[index] / 1_000_000; });
            }

            // Allocate only after every seat's goods have been pinned to the locked parent
            // order. The persisted parent fee remains the target, so this changes neither the
            // total fee nor split-settle's exact-allocation invariant.
            if (parentServiceSnapshot) {
                allocatedServiceChargeCents = allocateServiceChargeCents(
                    normalizedSplits.map(({ normalizedItems }) => ({ items: normalizedItems })),
                    parentFee,
                    parentServiceSnapshot.percentage,
                    {
                        taxInclusivePricing: !!parentTaxInclusive,
                        taxRegistrationType: parentTaxRegistrationType,
                        taxExempt: parentTaxExempt
                    }
                );
                normalizedSplits.forEach(({ normalizedItems }, index) => {
                    const cents = allocatedServiceChargeCents[index];
                    if (cents > 0) normalizedItems.push({
                        id: `FEE_SPLIT_${index}`,
                        product_id: null,
                        name: `${Number(parentServiceSnapshot.percentage)}% Service Charge`,
                        price: cents / 100,
                        qty: 1,
                        tax_rate: Number(parentServiceSnapshot.tax_rate),
                        jofotara_tax_category: parentServiceSnapshot.jofotara_tax_category,
                        note: 'Auto-Gratuity',
                        discountType: null,
                        discountValue: 0
                    });
                });
            }

            // A split seat tied to a locked parent bundle carries the parent order's
            // persisted children, never the nested payload sent by the client. Only
            // an explicit parent row id can opt into this historical path: do not
            // infer bundle children for a top-level line that has none.
            for (const { normalizedItems } of normalizedSplits) {
                for (const item of normalizedItems) {
                    // This version is a server capability, never a client field.
                    // Add it back below only when a locked parent supplies children.
                    delete item.bundle_snapshot_version;
                    const parentItemId = item.order_item_id != null ? Number(item.order_item_id) : null;
                    const persistedParent = parentItemId != null ? parentItemsById.get(parentItemId) : null;
                    const persistedChildren = persistedParent
                        ? persistedBundleChildrenByParentId.get(parentItemId)
                        : null;
                    if (!persistedChildren?.length) continue;

                    item.is_bundle = true;
                    item.bundleItems = await reconstructBundleSubs(conn, persistedParent, persistedChildren);
                    item.bundle_snapshot_version = 1;
                }
            }

            const parentDiscountType = parentOrder.discount_type || null;
            const parentDiscountValue = Number(parentOrder.discount_value) || 0;
            const rawSeatSubtotals = normalizedSplits.map(({ normalizedItems }) =>
                calculateExpectedTotals(
                    {},
                    normalizedItems,
                    splitProductMap,
                    parentTaxInclusive != null ? Number(parentTaxInclusive) === 1 : false,
                    {
                        taxRateOverrides: splitTaxRateOverrides,
                        taxRegistrationType: parentTaxRegistrationType,
                        taxExempt: parentTaxExempt
                    }
                ).subtotal
            );
            const parentSubtotalCents = moneyToCents(parentOrder.subtotal);
            const parentTotalCents = moneyToCents(parentOrder.total);
            let parentDiscountCents = 0;
            if (parentDiscountType === 'fixed') {
                parentDiscountCents = Math.min(parentSubtotalCents, moneyToCents(parentDiscountValue));
            } else if (parentDiscountType === 'percent') {
                parentDiscountCents = moneyToCents(
                    (parentSubtotalCents / 100) * (Math.min(100, parentDiscountValue) / 100)
                );
            }
            const canonicalParentTaxCents = parentTotalCents - parentSubtotalCents + parentDiscountCents;
            const storedParentTaxCents = moneyToCents(parentOrder.tax);
            if (canonicalParentTaxCents < 0 || Math.abs(canonicalParentTaxCents - storedParentTaxCents) > 1) {
                const error = new Error('Split parent totals do not reconcile. Refresh the table order and try again.');
                error.statusCode = 400;
                throw error;
            }
            const allocatedSeatSubtotalCents = allocateCents(parentSubtotalCents, rawSeatSubtotals);
            const fixedDiscountCents = parentDiscountCents > 0
                ? allocateCents(parentDiscountCents, rawSeatSubtotals, allocatedSeatSubtotalCents)
                : rawSeatSubtotals.map(() => 0);
            serverSeatDiscounts = rawSeatSubtotals.map((_, index) => {
                if (!parentDiscountType || parentDiscountCents === 0) return null;
                if (parentDiscountType === 'percent') {
                    return { type: 'percent', value: Math.min(100, parentDiscountValue) };
                }
                return { type: 'fixed', value: fixedDiscountCents[index] / 100 };
            });

            const serverSeatTotals = [];
            for (let index = 0; index < normalizedSplits.length; index++) {
                const { normalizedItems } = normalizedSplits[index];
                const seatDiscount = serverSeatDiscounts[index] || {};
                const seatTotals = calculateExpectedTotals(
                    {
                        order_discount_type: seatDiscount.type || null,
                        order_discount_value: Number(seatDiscount.value) || 0
                    },
                    normalizedItems,
                    splitProductMap,
                    // Seat totals belong to the parent's frozen lifecycle, not the
                    // current global setting (which may have flipped since save).
                    parentTaxInclusive != null ? Number(parentTaxInclusive) === 1 : false,
                    {
                        taxRateOverrides: splitTaxRateOverrides,
                        taxRegistrationType: parentTaxRegistrationType,
                        taxExempt: parentTaxExempt
                    }
                );

                if (!parentServiceSnapshot && normalizedItems.some(item => item.note === 'Auto-Gratuity')) {
                    const error = new Error('A service charge snapshot is required.');
                    error.statusCode = 400;
                    throw error;
                }

                serverSeatTotals.push({
                    subtotal: seatTotals.subtotal,
                    discount: seatTotals.discount,
                    tax: seatTotals.tax,
                    total: seatTotals.total
                });
            }

            splitMoneyCents = allocateSplitMoneyCents({
                subtotal: Number(parentOrder.subtotal),
                tax: canonicalParentTaxCents / 100,
                total: Number(parentOrder.total)
            }, serverSeatTotals);
            if (splitMoneyCents.length !== normalizedSplits.length) {
                throw new Error('Split money allocation count mismatch.');
            }
            normalizedSplits.forEach(({ seat }, index) => {
                const submitted = Number(seat.subtotal);
                const allocation = splitMoneyCents[index];
                const submittedCents = Number.isFinite(submitted) ? moneyToCents(submitted) : null;
                // One cent of slack: the POS and the server can round a service-charge or
                // percent-discount share differently while both conserve the parent total.
                if (submittedCents == null || Math.abs(submittedCents - allocation.total) > 1) {
                    const error = new Error("Split seat subtotal mismatch. Please refresh totals and try again.");
                    error.statusCode = 400;
                    throw error;
                }
            });

            // The parent remains the live table/inventory authority until the final
            // bucket settles. Split confirmation creates payable views only.
            tableIdsToBroadcast = tableContext.groupTableIds;
        }

        // 2. Insert each seat split into held_orders
        const splitAuditEvents = [];
        const heldEvents = [];
        for (let splitIndex = 0; splitIndex < normalizedSplits.length; splitIndex++) {
            const { seat, normalizedItems } = normalizedSplits[splitIndex];
            if (normalizedItems.length === 0) continue;

            const cartPayload = {
                // Persist the server-pinned/validated items, NOT the raw client seat.items —
                // otherwise split settle freezes a forged price from this blob (checkout.js).
                items: normalizedItems,
                order_discount: serverSeatDiscounts[splitIndex],
                split_money_cents: splitMoneyCents[splitIndex],
                parent_invoice_id: parentInvoiceId,
                parent_order_id: parentOrderId,
                order_type_id: tableContext?.order?.order_type_id ?? null,
                parent_invoice_number: parentIdentity.invoice_number,
                parent_invoice_display_no: parentIdentity.invoice_display_no,
                parent_order_display_no: parentIdentity.order_display_no,
                parent_ticket_display_no: parentIdentity.ticket_display_no,
                parent_table_display_no: parentIdentity.table_display_no,
                service_charge_allocation_cents: allocatedServiceChargeCents[splitIndex] ?? 0,
                is_split: true,
                tax_inclusive_at_sale: parentTaxInclusive != null ? (Number(parentTaxInclusive) === 1 ? 1 : 0) : 0,
                receipt_tax_inclusive_at_hold: parentReceiptTaxInclusive != null
                    ? (Number(parentReceiptTaxInclusive) === 1 ? 1 : 0)
                    : (receiptTaxInclusiveDisplay ? 1 : 0),
                tax_exempt_at_hold: parentTaxExempt,
                tax_registration_type_at_hold: parentTaxRegistrationType,
                tax_context_version: 1,
                progressive_split_version: 2,
                split_role: seat.split_role === 'remainder' ? 'remainder' : 'check',
                split_revision: 1
            };

            const [heldResult] = await conn.query(
                `INSERT INTO held_orders
                    (user_id, reference_name, cart_data, subtotal, service_charge_snapshot_id, parent_invoice_id, table_id)
                 VALUES (?, ?, ?, ?, NULL, ?, ?)`,
                [user.id, seat.referenceName, JSON.stringify(cartPayload), splitMoneyCents[splitIndex].total / 100, parentInvoiceId, tableContext.rootTable.id]
            );
            // This durable, transaction-bound event is the server provenance for
            // bundle_snapshot_version. checkout.js accepts the historical child
            // snapshot only when this exact held row has this exact parent invoice.
            splitAuditEvents.push({
                eventType: 'split_check_created',
                entityType: 'held_order',
                entityId: heldResult.insertId,
                newValue: { parent_invoice_id: parentInvoiceId, bundle_snapshot_version: 1 }
            });
            heldEvents.push({ action: 'created', row: { id: heldResult.insertId, parent_invoice_id: parentInvoiceId, table_id: tableContext.rootTable.id } });
            if (parentServiceSnapshot) {
                const child = await createChildHeldSnapshot(conn, {
                    parentSnapshot: parentServiceSnapshot,
                    heldOrderId: heldResult.insertId,
                    userId: user.id
                });
                await conn.query('UPDATE held_orders SET service_charge_snapshot_id=? WHERE id=?', [child.id, heldResult.insertId]);
            }
        }

        if (parentServiceSnapshot) {
            await transition(conn, {
                snapshotId: parentServiceSnapshot.id,
                version: parentServiceSnapshot.version,
                from: 'open_order',
                to: 'split_parent',
                holderType: 'order',
                holderId: String(parentInvoiceId)
            });
        }

        splitAuditEvents.push({
            eventType: 'split_check_opened',
            entityType: 'order',
            entityId: parentInvoiceId,
            newValue: { split_count: normalizedSplits.length, table_id: tableContext.rootTable.id }
        });
        await appendAuditEvents(conn, splitAuditEvents, { userId: user.id, ipAddress: ipAddress || null });
        await conn.commit();

        // 3. Emit socket updates and return success
        hasTransaction = false;
        conn.release();
        conn = null;
        await broadcastSplitChanges(io, tableIdsToBroadcast, heldEvents);
        invalidateCatalogCache();
        invalidateDashboardCache();

        return { message: "Bill split successfully." };
    } catch (error) {
        if (conn && hasTransaction) {
            try {
                await conn.rollback();
            } catch (rollbackError) {
                logger.error({ err: rollbackError }, 'Bill split rollback failed.');
            }
        }
        logger.error({ err: error, tableId, currentOrderId }, 'Atomic bill split failed.');
        throw error;
    } finally {
        if (conn) conn.release();
    }
}

module.exports = { assertNoActiveSplitChecks, lockSplitCheckForMutation, discardSplitCheck, createSplitChecks, rewriteUnpaidSplitChecks };
