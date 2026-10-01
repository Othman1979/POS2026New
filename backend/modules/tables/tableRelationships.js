const { insertPersistedBundleChildren } = require('../../services/bundleOrderItems');
const stockSnapshots = require('../../services/StockSaleSnapshots');
const { assertOrderItemBundleIntegrity } = require('../../services/bundleIntegrity');
const { appendAuditEvent } = require('../../services/auditEvents');
const { serviceChargeFee, canonicalName } = require('../../services/ServiceChargeCalculator');
const { getForUpdate, touchOpenOrder, rehomeOpenOrder, abandonOpenOrder } = require('../../services/ServiceChargeSnapshotService');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { canOverrideTables, canTransferTable, canMergeTables, assertTableSectionAccess } = require('../../services/PermissionService');
const { recomputeOrderTotals } = require('../../services/OrderPricing');
const { broadcastTableUpdates } = require('../../services/TableRealtime');
const { authorizeManagerOverride } = require('../../services/ManagerOverrideService');
const { assertNoActiveSplitChecks } = require('./splitChecks');
const { TAX_REGISTRATION_TYPES } = require('../../config/taxRegistration');
const { validOperationId, groupState, normalizeExpectedTables, claimTableAction } = require('./tableActionIdentity');

const failure = (status, message, code = null) => ({ error: true, status, message, code });

// Persisted values already share the database's numeric representation. Text and
// snapshots compare exactly: a case-insensitive SQL collation is not line identity.
const mergeLineKey = row => JSON.stringify([
    row.product_id, row.item_name, row.price_at_sale, row.price_before_tax_exemption ?? null,
    row.note, row.discount_type, row.discount_value, row.tax_rate, row.jofotara_tax_category,
    row.selected_modifiers, row.modifier_surcharge, row.modifier_tax_amount,
    row.recipe_line_key || null, row.recipe_cost_snapshot ?? null,
    row.stock_authority ?? 'legacy', row.stock_snapshot ?? null
]);

const assertOpenTableOrder = async (conn, invoiceId, label = 'table order') => {
    if (!invoiceId) return null;
    const [[order]] = await conn.execute(
        "SELECT invoice_id, payment_method, waiter_id FROM orders WHERE invoice_id = ? FOR UPDATE",
        [invoiceId]
    );
    if (!order) {
        const error = new Error(`Conflict: This ${label} no longer exists. Please refresh the floor plan.`);
        error.statusCode = 409;
        throw error;
    }
    if (order.payment_method !== 'unpaid_table') {
        const error = new Error(`Conflict: This ${label} is finalized and cannot be changed from the floor plan. Please refresh the floor plan.`);
        error.statusCode = 409;
        throw error;
    }
    return order;
};

async function processTableAction({ user, sourceId, targetId, action, operationId, expectedTables: expectedInput, io, ipAddress = null }) {
    // Structural moves require a real action-specific grant, including replays.
    const hasPermission = action === 'merge' ? canMergeTables(user) : canTransferTable(user);
    if (!hasPermission) return failure(403, `${action === 'merge' ? 'Merge tables' : 'Transfer table'} permission required.`);
    if (!validOperationId(operationId)) return failure(400, 'A valid table action key is required.', 'TABLE_ACTION_KEY_REQUIRED');
    const expectedTables = normalizeExpectedTables(expectedInput);
    if (!expectedTables) return failure(409, 'The selected tables changed. Review the floor plan before trying again.', 'TABLE_ACTION_CONFLICT');
    let conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const operation = await claimTableAction(conn, { operationId, userId: user.id, sourceId, targetId, action, expectedTables });
        if (operation.conflict || operation.result) {
            await conn.rollback();
            return operation.conflict
                ? failure(409, 'This table action key belongs to a different request.', 'TABLE_ACTION_KEY_CONFLICT')
                : operation.result;
        }
        let mergeAuditSnapshot = null;

        // Lock both complete table groups in one global ID order. Settlement paths use
        // this same group-first order, so transfer/swap cannot hold a root while waiting
        // on a child already held by checkout, split, print, or void.
        const orderedRootIds = [sourceId, targetId].sort((a, b) => a - b);
        const [lockedTables] = await conn.execute(
            `SELECT id, section_id, table_number, current_order_id, status, parent_table_id
               FROM restaurant_tables
              WHERE id IN (?, ?) OR parent_table_id IN (?, ?)
              ORDER BY id
              FOR UPDATE`,
            [...orderedRootIds, ...orderedRootIds]
        );
        assertTableSectionAccess(user, lockedTables);
        const tableById = new Map(lockedTables.map(table => [Number(table.id), table]));
        const sourceTable = tableById.get(sourceId);
        const targetTable = tableById.get(targetId);
        if (!sourceTable || !targetTable) {
            await conn.rollback();
            return failure(404, "Table not found.");
        }

        if (JSON.stringify(groupState(lockedTables)) !== JSON.stringify(expectedTables)) {
            await conn.rollback();
            return failure(409, 'The selected tables changed. Review the floor plan before trying again.', 'TABLE_ACTION_CONFLICT');
        }

        if (sourceTable.parent_table_id != null || targetTable.parent_table_id != null) {
            await conn.rollback();
            return failure(409,
                'Joined child tables must be managed through their parent table.',
                'TABLE_SESSION_CONFLICT'
            );
        }

        const liveStatuses = new Set(['occupied', 'printed']);
        const groupMatchesRoot = root => lockedTables
            .filter(row => (
                Number(row.id) === Number(root.id) ||
                Number(row.parent_table_id) === Number(root.id)
            ))
            .every(row => (
                String(row.current_order_id ?? '') === String(root.current_order_id ?? '') &&
                row.status === root.status
            ));
        const rootStateIsValid = root => root.current_order_id
            ? liveStatuses.has(root.status)
            : root.status === 'available';
        if (
            !groupMatchesRoot(sourceTable) || !rootStateIsValid(sourceTable) ||
            !groupMatchesRoot(targetTable) || !rootStateIsValid(targetTable)
        ) {
            await conn.rollback();
            return failure(409,
                'A joined table group changed. Refresh the floor plan and try again.',
                'TABLE_SESSION_CONFLICT'
            );
        }

        if (!sourceTable.current_order_id) {
            await conn.rollback();
            return failure(400, "Source table is not occupied.");
        }
        await assertOpenTableOrder(conn, sourceTable.current_order_id, 'source table order');
        if (targetTable.current_order_id) {
            await assertOpenTableOrder(conn, targetTable.current_order_id, 'target table order');
        }
        await assertNoActiveSplitChecks(conn, [sourceTable.current_order_id, targetTable.current_order_id]);

        if (action === 'transfer') {
            // Standard Transfer: verify target is empty
            if (targetTable.current_order_id) {
                await conn.rollback();
                return failure(409, "Target table is occupied.", 'TARGET_OCCUPIED');
            }

            // Move the order
            await conn.execute(
                'UPDATE restaurant_tables SET current_order_id = ?, status = ? WHERE id = ?',
                [sourceTable.current_order_id, sourceTable.status, targetId]
            );
            await conn.execute("UPDATE restaurant_tables SET current_order_id = NULL, status = 'available' WHERE id = ?", [sourceId]);

            // Update child tables joined to target/source
            await conn.execute(
                'UPDATE restaurant_tables SET current_order_id = ?, status = ? WHERE parent_table_id = ?',
                [sourceTable.current_order_id, sourceTable.status, targetId]
            );
            await conn.execute("UPDATE restaurant_tables SET current_order_id = NULL, parent_table_id = NULL, status = 'available' WHERE parent_table_id = ?", [sourceId]);

            // Update order table reference
            await conn.execute("UPDATE orders SET table_id = ? WHERE invoice_id = ?", [targetId, sourceTable.current_order_id]);

        } else if (action === 'swap') {
            // Swap: both must have orders
            if (!targetTable.current_order_id) {
                await conn.rollback();
                return failure(400, "Target table is not occupied for swap.");
            }

            // Swap order IDs in tables
            await conn.execute("UPDATE restaurant_tables SET current_order_id = ? WHERE id = ?", [targetTable.current_order_id, sourceId]);
            await conn.execute("UPDATE restaurant_tables SET current_order_id = ? WHERE id = ?", [sourceTable.current_order_id, targetId]);

            // Swap table status if they differ (e.g. occupied vs printed)
            await conn.execute("UPDATE restaurant_tables SET status = ? WHERE id = ?", [targetTable.status, sourceId]);
            await conn.execute("UPDATE restaurant_tables SET status = ? WHERE id = ?", [sourceTable.status, targetId]);

            // Update child tables joined to target/source
            await conn.execute(
                'UPDATE restaurant_tables SET current_order_id = ?, status = ? WHERE parent_table_id = ?',
                [targetTable.current_order_id, targetTable.status, sourceId]
            );
            await conn.execute(
                'UPDATE restaurant_tables SET current_order_id = ?, status = ? WHERE parent_table_id = ?',
                [sourceTable.current_order_id, sourceTable.status, targetId]
            );

            // Update table references inside orders
            await conn.execute("UPDATE orders SET table_id = ? WHERE invoice_id = ?", [sourceId, targetTable.current_order_id]);
            await conn.execute("UPDATE orders SET table_id = ? WHERE invoice_id = ?", [targetId, sourceTable.current_order_id]);

        } else if (action === 'merge') {
            // Merge: target must have an order
            if (!targetTable.current_order_id) {
                await conn.rollback();
                return failure(400, "Target table is not occupied for merge.");
            }

            // Check waiter ownership for merge
            const [[sourceOrder]] = await conn.execute("SELECT waiter_id, discount_value, service_charge_snapshot_id, tax_inclusive_at_sale, receipt_tax_inclusive_at_sale, tax_registration_type_at_sale, tax_exempt_at_sale FROM orders WHERE invoice_id = ?", [sourceTable.current_order_id]);
            const [[targetOrder]] = await conn.execute("SELECT waiter_id, discount_value, service_charge_snapshot_id, tax_inclusive_at_sale, receipt_tax_inclusive_at_sale, tax_registration_type_at_sale, tax_exempt_at_sale FROM orders WHERE invoice_id = ?", [targetTable.current_order_id]);
            if (Number(sourceOrder?.tax_exempt_at_sale) !== Number(targetOrder?.tax_exempt_at_sale)) {
                await conn.rollback();
                return failure(409,
                    'Tax-exempt and taxable table orders cannot be merged. Set both orders to the same tax context first.',
                    'TAX_EXEMPT_CONTEXT_MISMATCH'
                );
            }
            if ((sourceOrder.tax_registration_type_at_sale ?? TAX_REGISTRATION_TYPES.SALES_TAX)
                !== (targetOrder.tax_registration_type_at_sale ?? TAX_REGISTRATION_TYPES.SALES_TAX)) {
                await conn.rollback();
                return failure(409,
                    'Orders with different tax registrations cannot be combined. Keep these bills separate.',
                    'TAX_REGISTRATION_CONTEXT_MISMATCH'
                );
            }
            // Match saved-table accounting: a missing legacy flag means normal
            // accounting. Receipt display preferences do not convert saved prices.
            if ((Number(sourceOrder.tax_inclusive_at_sale) === 1) !== (Number(targetOrder.tax_inclusive_at_sale) === 1)) {
                await conn.rollback();
                return failure(409,
                    'Orders with different tax accounting cannot be combined. Keep these bills separate.',
                    'TAX_ACCOUNTING_CONTEXT_MISMATCH'
                );
            }
            // Lock both bound snapshots for the whole merge. getForUpdate on a snapshot
            // that vanished throws 409 EXPIRED and rolls the merge back untouched.
            const sourceSnapshot = sourceOrder?.service_charge_snapshot_id
                ? await getForUpdate(conn, sourceOrder.service_charge_snapshot_id) : null;
            const targetSnapshot = targetOrder?.service_charge_snapshot_id
                ? await getForUpdate(conn, targetOrder.service_charge_snapshot_id) : null;
            // The snapshot that owns the merged order's fee. The holder-aware CAS calls
            // below validate ownership before commit; any mismatch rolls back all copies.
            // Target wins when both exist.
            const survivingSnapshot = targetSnapshot || sourceSnapshot;

            const isSourceOwner = !sourceOrder || !sourceOrder.waiter_id || sourceOrder.waiter_id === user.id;
            const isTargetOwner = !targetOrder || !targetOrder.waiter_id || targetOrder.waiter_id === user.id;

            if (!isSourceOwner || !isTargetOwner) {
                // tables.access cashiers lack waiter.override_tables and are rejected here automatically.
                if (!canOverrideTables(user)) {
                    await conn.rollback();
                    return failure(403, "Forbidden: Merging tables belonging to another waiter requires table override permission.");
                }
            }

            // Both orders remain locked by assertOpenTableOrder. A single order-wide
            // rule cannot retain two bill scopes: a source discount would disappear,
            // and a target percentage would extend to the source's food. Keep both
            // bills intact until combining supports an explicit discount allocation.
            if (Number(sourceOrder.discount_value) > 0 || Number(targetOrder.discount_value) > 0) {
                await conn.rollback();
                return failure(409,
                    'Orders with an order-level discount cannot be combined. Keep these bills separate.',
                    'ORDER_DISCOUNT_MERGE_CONFLICT'
                );
            }

            // Move all items from source order to target order
            const [sourceItems] = await conn.execute(
                "SELECT * FROM order_items WHERE invoice_id = ? FOR UPDATE",
                [sourceTable.current_order_id]
            );
            const [targetItems] = await conn.execute(
                "SELECT * FROM order_items WHERE invoice_id = ? FOR UPDATE",
                [targetTable.current_order_id]
            );
            assertOrderItemBundleIntegrity(sourceItems);
            assertOrderItemBundleIntegrity(targetItems);

            // A bundle parent is any source row referenced by another row's parent_item_id.
            // Child rows (parent_item_id set) are not merged on their own; they are
            // re-minted under their freshly inserted parent so the parent/child link and
            // the zero-price structure survive the move (a naive qty-merge would orphan
            // them and corrupt routing/receipt). Bundles never quantity-merge.
            const sourceChildren = new Map();
            for (const row of sourceItems) {
                if (row.parent_item_id == null) continue;
                if (!sourceChildren.has(row.parent_item_id)) sourceChildren.set(row.parent_item_id, []);
                sourceChildren.get(row.parent_item_id).push(row);
            }
            const targetBundleParents = new Set(targetItems.filter(row => row.parent_item_id != null).map(row => row.parent_item_id));
            const matchingLines = new Map();
            for (const row of targetItems) {
                if (row.parent_item_id != null || targetBundleParents.has(row.id)) continue;
                const key = mergeLineKey(row);
                if (!matchingLines.has(key)) matchingLines.set(key, row);
            }

            // One fee, never doubled: skip the source's Auto-Gratuity row when the target
            // already carries its own, or when no snapshot survives to make it settleable.
            const existingTargetFee = targetItems.find(item => item.note === 'Auto-Gratuity') || null;

            for (const item of sourceItems) {
                if (item.note === 'Auto-Gratuity' && (existingTargetFee || !survivingSnapshot)) continue;

                // Skip child rows here; they are handled when their parent is processed.
                if (item.parent_item_id != null) continue;
                const stockColumns = stockSnapshots.columns(stockSnapshots.read(item));

                const isBundleParent = sourceChildren.has(item.id);
                if (isBundleParent) {
                    // Insert a fresh parent row (parent_item_id NULL) on the target order,
                    // copying the parent's priced/tax columns faithfully, then re-mint
                    // DB-driven children. Skip the find-existing-and-increment branch.
                    const [parentRes] = await conn.execute(
                        "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, price_before_tax_exemption, tax_rate, jofotara_tax_category, tax_amount, note, selected_modifiers, modifier_surcharge, modifier_tax_amount, discount_type, discount_value, sort_order, recipe_line_key, recipe_cost_snapshot, parent_item_id, stock_authority, stock_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
                        [targetTable.current_order_id, item.product_id, item.item_name, item.quantity, item.price_at_sale, item.price_before_tax_exemption ?? null, item.tax_rate || 0.00, item.jofotara_tax_category, item.tax_amount || 0, item.note, item.selected_modifiers, item.modifier_surcharge, item.modifier_tax_amount, item.discount_type, item.discount_value, item.sort_order, item.recipe_line_key || null, item.recipe_cost_snapshot ?? null, ...stockColumns]
                    );

                    // Persisted children define historical bundle structure. Catalog
                    // membership is only authoritative while creating a new bundle line.
                    const childRows = sourceChildren.get(item.id);
                    await insertPersistedBundleChildren(conn, {
                        invoiceId: targetTable.current_order_id,
                        parentItemId: parentRes.insertId,
                        parentRow: item,
                        childRows,
                        parentQty: item.quantity,
                        startSortOrder: Number(item.sort_order) + 1,
                    });
                    continue;
                }

                const key = mergeLineKey(item);
                const existingItem = matchingLines.get(key);
                if (existingItem) {
                    await conn.execute(
                        "UPDATE order_items SET quantity = quantity + ? WHERE id = ?",
                        [item.quantity, existingItem.id]
                    );
                } else {
                    const [inserted] = await conn.execute(
                        "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, price_before_tax_exemption, tax_rate, jofotara_tax_category, tax_amount, note, selected_modifiers, modifier_surcharge, modifier_tax_amount, discount_type, discount_value, sort_order, recipe_line_key, recipe_cost_snapshot, stock_authority, stock_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        [targetTable.current_order_id, item.product_id, item.item_name, item.quantity, item.price_at_sale, item.price_before_tax_exemption ?? null, item.tax_rate || 0.00, item.jofotara_tax_category, item.tax_amount || 0, item.note, item.selected_modifiers, item.modifier_surcharge, item.modifier_tax_amount, item.discount_type, item.discount_value, item.sort_order, item.recipe_line_key || null, item.recipe_cost_snapshot ?? null, ...stockColumns]
                    );
                    matchingLines.set(key, { id: inserted.insertId });
                }
            }

            // Snapshot disposition: target-bound survives and is version-bumped;
            // source-only re-homes; both-bound abandons the source. Every primitive
            // includes state, holder, order ID, and version in its CAS predicate.
            let rehomedSnapshotId = null;
            let abandonedSnapshotId = null;
            if (sourceSnapshot && targetSnapshot) {
                await abandonOpenOrder(conn, {
                    snapshotId: sourceSnapshot.id,
                    version: sourceSnapshot.version,
                    orderId: sourceTable.current_order_id
                });
                abandonedSnapshotId = sourceSnapshot.id;
            } else if (sourceSnapshot) {
                await rehomeOpenOrder(conn, {
                    snapshotId: sourceSnapshot.id,
                    version: sourceSnapshot.version,
                    fromOrderId: sourceTable.current_order_id,
                    toOrderId: targetTable.current_order_id
                });
                await conn.execute(
                    "UPDATE orders SET service_charge_snapshot_id = ? WHERE invoice_id = ?",
                    [sourceSnapshot.id, targetTable.current_order_id]
                );
                rehomedSnapshotId = sourceSnapshot.id;
            }

            // A target-owned snapshot must change version when the merged cart changes.
            // This is both an ownership check and the stale-client invalidation token.
            if (targetSnapshot) {
                await touchOpenOrder(conn, {
                    snapshotId: targetSnapshot.id,
                    version: targetSnapshot.version,
                    orderId: targetTable.current_order_id
                });
            }

            // Reconcile the persisted fee shape. A merge is a recovery boundary: when a
            // snapshot survives, keep the lowest-ID fee row and delete extras; without a
            // snapshot, remove every fee row rather than preserve an unsettleable order.
            const [mergedFeeRows] = await conn.execute(
                "SELECT id FROM order_items WHERE invoice_id = ? AND note = 'Auto-Gratuity' ORDER BY id FOR UPDATE",
                [targetTable.current_order_id]
            );
            if (!survivingSnapshot) {
                if (mergedFeeRows.length > 0) {
                    await conn.execute(
                        "DELETE FROM order_items WHERE invoice_id = ? AND note = 'Auto-Gratuity'",
                        [targetTable.current_order_id]
                    );
                }
            } else if (mergedFeeRows.length > 0) {
                const keepFeeId = mergedFeeRows[0].id;
                await conn.execute(
                    "DELETE FROM order_items WHERE invoice_id = ? AND note = 'Auto-Gratuity' AND id <> ?",
                    [targetTable.current_order_id, keepFeeId]
                );
                const [goods] = await conn.execute(
                    "SELECT quantity, price_at_sale, discount_type, discount_value, note, tax_rate, modifier_surcharge, modifier_tax_amount FROM order_items WHERE invoice_id = ?",
                    [targetTable.current_order_id]
                );
                const fee = serviceChargeFee(goods.map(row => ({
                    price: Number(row.price_at_sale),
                    qty: Number(row.quantity),
                    discountType: row.discount_type,
                    discountValue: Number(row.discount_value || 0),
                    note: row.note,
                    tax_rate: Number(row.tax_rate || 0),
                    modifier_surcharge: row.modifier_surcharge,
                    modifier_tax_amount: row.modifier_tax_amount
                })), survivingSnapshot.percentage, {
                    taxInclusivePricing: Number(targetOrder.tax_inclusive_at_sale) === 1,
                    receiptTaxInclusiveDisplay: targetOrder.receipt_tax_inclusive_at_sale != null
                        ? Number(targetOrder.receipt_tax_inclusive_at_sale) === 1
                        : Number(targetOrder.tax_inclusive_at_sale) === 1,
                    taxExempt: Number(targetOrder.tax_exempt_at_sale) === 1,
                    pricesAlreadyExempt: Number(targetOrder.tax_exempt_at_sale) === 1
                });
                if (fee > 0) {
                    await conn.execute(`
                        UPDATE order_items
                           SET product_id=NULL,
                               item_name=?, quantity=1, price_at_sale=?,
                               tax_rate=?, jofotara_tax_category=?, note='Auto-Gratuity',
                               discount_type=NULL, discount_value=0,
                               parent_item_id=NULL
                         WHERE id=?
                    `, [
                        canonicalName(survivingSnapshot.percentage),
                        fee,
                        Number(survivingSnapshot.tax_rate),
                        survivingSnapshot.jofotara_tax_category,
                        keepFeeId
                    ]);
                } else {
                    await conn.execute("DELETE FROM order_items WHERE id = ?", [keepFeeId]);
                }
            }

            // Snapshot the source order BEFORE it is destroyed, for a durable merge audit trail.
            const [[sourceOrderForAudit]] = await conn.execute(
                "SELECT subtotal, tax, total, waiter_id FROM orders WHERE invoice_id = ?",
                [sourceTable.current_order_id]
            );
            mergeAuditSnapshot = {
                sourceInvoiceId: sourceTable.current_order_id,
                items: sourceItems.map(i => ({
                    product_id: i.product_id,
                    item_name: i.item_name,
                    quantity: i.quantity,
                    price_at_sale: i.price_at_sale,
                    tax_amount: i.tax_amount,
                })),
                subtotal: sourceOrderForAudit?.subtotal ?? null,
                tax: sourceOrderForAudit?.tax ?? null,
                total: sourceOrderForAudit?.total ?? null,
                waiter_id: sourceOrderForAudit?.waiter_id ?? null,
                targetInvoiceId: targetTable.current_order_id,
                sourceId: Number(sourceId),
                targetId: Number(targetId),
                serviceCharge: {
                    kept: targetSnapshot?.id ?? null,
                    rehomed: rehomedSnapshotId,
                    abandoned: abandonedSnapshotId
                },
            };

            // Void/Delete source order items and source order
            await conn.execute("DELETE FROM order_items WHERE invoice_id = ?", [sourceTable.current_order_id]);
            await conn.execute("DELETE FROM orders WHERE invoice_id = ?", [sourceTable.current_order_id]);

            // Recompute the target order from order_items and restamp per-line tax.
            await recomputeOrderTotals(conn, targetTable.current_order_id, { preserveSavedTax: true });

            // Reset source table and child tables linked to it
            await conn.execute("UPDATE restaurant_tables SET current_order_id = NULL, status = 'available' WHERE id = ?", [sourceId]);
            await conn.execute("UPDATE restaurant_tables SET current_order_id = NULL, parent_table_id = NULL, status = 'available' WHERE parent_table_id = ?", [sourceId]);
        }

        // Add log
        const logDetails = `Table action: ${action} - source Table ID ${sourceId} (Table ${sourceTable.table_number}), target Table ID ${targetId} (Table ${targetTable.table_number})`;
        logger.info({ userId: user.id, action: 'table_transfer', details: logDetails }, 'Table action audit log.');

        // Durable merge audit; same transaction as the source-order delete.
        if (mergeAuditSnapshot) {
            await appendAuditEvent(conn, {
                eventType: 'table_merge',
                userId: user.id,
                entityType: 'order',
                entityId: mergeAuditSnapshot.sourceInvoiceId,
                oldValue: {
                        items: mergeAuditSnapshot.items,
                        subtotal: mergeAuditSnapshot.subtotal,
                        tax: mergeAuditSnapshot.tax,
                        total: mergeAuditSnapshot.total,
                        waiter_id: mergeAuditSnapshot.waiter_id,
                },
                newValue: {
                        target_invoice_id: mergeAuditSnapshot.targetInvoiceId,
                        source_table_id: mergeAuditSnapshot.sourceId,
                        target_table_id: mergeAuditSnapshot.targetId,
                        service_charge: mergeAuditSnapshot.serviceCharge,
                },
                ipAddress: ipAddress || null
            });
        }

        const result = {
            message: 'Tables action processed successfully.', operation_id: operationId, action,
            source_table_id: sourceId, target_table_id: targetId,
            source_invoice_id: sourceTable.current_order_id, target_invoice_id: targetTable.current_order_id
        };
        await conn.execute('UPDATE table_action_operations SET result_json=? WHERE operation_id=?', [JSON.stringify(result), operationId]);
        await conn.commit();
        conn.release();
        conn = null;

        if (io) {
            // The locked groups include every moved or released child. Reuse that
            // identity set so a follow-up lookup cannot fail a committed action.
            await broadcastTableUpdates(io, lockedTables.map(row => row.id));
        }

        return result;
    } catch (err) {
        if (conn) await conn.rollback();
        logger.error({ err }, 'Tables action transaction failed');
        throw err;
    } finally {
        if (conn) conn.release();
    }
}


async function joinTables({ user, parentId, childIds, requestedIds, managerPin, io, ipAddress = null, route }) {
    let conn;
    try {
        // 1. Permission check
        const hasPermission = canMergeTables(user);

        if (!hasPermission) {
            if (!managerPin) {
                return failure(403, "Manager authorization required.", 'PIN_REQUIRED');
            }
            try {
                const approval = await authorizeManagerOverride({
                    user: user,
                    managerPin,
                    actions: ['table.join'],
                    ipAddress: ipAddress,
                    route: route
                });
                if (!approval.approvedActions.includes('table.join')) return failure(403, 'Manager authorization required.');
                // The PIN grants this action; it does not replace the actor section scope.
            } catch (pinErr) {
                return failure(pinErr.statusCode || 403, pinErr.message);
            }
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();
        // 2. Lock the complete requested shape in deterministic table-ID order.
        const placeholders = requestedIds.map(() => '?').join(',');
        const [lockedTables] = await conn.execute(
            `SELECT t.id, t.section_id, t.table_number, t.current_order_id, t.status, t.seating_parent_id
               FROM restaurant_tables t
              WHERE t.id IN (${placeholders}) OR t.seating_parent_id IN (${placeholders})
              ORDER BY t.id
              FOR UPDATE`,
            [...requestedIds, ...requestedIds]
        );
        const tableById = new Map(lockedTables.map(table => [Number(table.id), table]));
        if (requestedIds.some(id => !tableById.has(id))) {
            await conn.rollback();
            return failure(404, "Table not found.");
        }

        assertTableSectionAccess(user, lockedTables);
        const parentTable = tableById.get(parentId);
        if (lockedTables.some(table => table.status === 'printed')) {
            await conn.rollback();
            return failure(409, 'Tables with a printed bill cannot be joined.', 'TABLE_CHECK_PRINTED');
        }
        if (parentTable.seating_parent_id != null) {
            await conn.rollback();
            return failure(409,
                'A joined child cannot become a parent table.',
                'TABLE_SESSION_CONFLICT'
            );
        }

        // Existing seating groups can be flattened into this group. Bills, saved
        // split checks and legacy shared-bill aliases keep their own identities.
        for (const childId of childIds) {
            const childTable = tableById.get(childId);
            const alreadyInThisGroup = Number(childTable.seating_parent_id) === parentId;
            if (childTable.seating_parent_id != null && !alreadyInThisGroup) {
                await conn.rollback();
                return failure(409,
                    `Table ${childTable.table_number} already belongs to another table group.`,
                    'TABLE_SESSION_CONFLICT'
                );
            }
        }

        const members = lockedTables.filter(table => Number(table.id) !== parentId);
        await conn.execute(
            `UPDATE restaurant_tables
                SET seating_parent_id = ?
              WHERE id IN (${members.map(() => '?').join(',')})`,
            [parentId, ...members.map(table => table.id)]
        );
        await appendAuditEvent(conn, {
            eventType: 'table_join', userId: user.id, entityType: 'table', entityId: parentId,
            oldValue: { children: members },
            newValue: { parent_table_id: parentId, joined_ids: members.map(table => table.id) },
            ipAddress: ipAddress || null
        });

        await conn.commit();
        conn.release();
        conn = null;

        if (io) {
            await broadcastTableUpdates(io, lockedTables.map(table => table.id));
        }

        return { message: "Tables joined successfully." };
    } catch (err) {
        if (conn) await conn.rollback();
        logger.error({ err }, 'Tables join transaction failed');
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

async function disjoinTables({ user, normalizedTableIds, managerPin, io, ipAddress = null, route }) {
    let conn;
    try {
        // 1. Permission check
        const hasPermission = canMergeTables(user);

        if (!hasPermission) {
            if (!managerPin) {
                return failure(403, "Manager authorization required.", 'PIN_REQUIRED');
            }
            try {
                const approval = await authorizeManagerOverride({
                    user: user,
                    managerPin,
                    actions: ['table.disjoin'],
                    ipAddress: ipAddress,
                    route: route
                });
                if (!approval.approvedActions.includes('table.disjoin')) return failure(403, 'Manager authorization required.');
                // The PIN grants this action; it does not replace the actor section scope.
            } catch (pinErr) {
                return failure(pinErr.statusCode || 403, pinErr.message);
            }
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();
        // Discover the parents without acquiring child locks first. Lock both
        // sides together in the same global ID order used by other table actions.
        const placeholders = normalizedTableIds.map(() => '?').join(',');
        const [probes] = await conn.execute(
            `SELECT id, seating_parent_id FROM restaurant_tables WHERE id IN (${placeholders})`,
            normalizedTableIds
        );
        const lockIds = [...new Set([...normalizedTableIds, ...probes.map(row => row.seating_parent_id).filter(Boolean)])].sort((a, b) => a - b);
        const [lockedTables] = await conn.execute(
            `SELECT id, section_id, seating_parent_id, current_order_id, status FROM restaurant_tables
              WHERE id IN (${lockIds.map(() => '?').join(',')}) OR seating_parent_id IN (${lockIds.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`,
            [...lockIds, ...lockIds]
        );
        assertTableSectionAccess(user, lockedTables);
        const tableById = new Map(lockedTables.map(table => [Number(table.id), table]));
        const probeById = new Map(probes.map(table => [Number(table.id), table]));
        const disjoinedChildren = [];
        for (const tableId of normalizedTableIds) {
            const childRow = tableById.get(tableId);
            if (!childRow) {
                await conn.rollback();
                return failure(404, "Seat not found.");
            }
            if (childRow.seating_parent_id == null) {
                await conn.rollback();
                return failure(400, "Selected seat is not a joined child and cannot be separated.");
            }
            const parentRow = tableById.get(Number(childRow.seating_parent_id));
            if (childRow.seating_parent_id !== probeById.get(tableId)?.seating_parent_id
                || !parentRow || parentRow.seating_parent_id != null) {
                await conn.rollback();
                return failure(409, 'The joined group changed. Refresh and try again.', 'TABLE_SESSION_CONFLICT');
            }
            disjoinedChildren.push({
                id: childRow.id,
                seating_parent_id: childRow.seating_parent_id,
                current_order_id: childRow.current_order_id,
                status: childRow.status,
            });
        }

        const parentTableId = disjoinedChildren[0].seating_parent_id;
        if (disjoinedChildren.some(child => child.seating_parent_id !== parentTableId)) {
            await conn.rollback();
            return failure(400, "Selected seats must belong to the same joined table group.");
        }
        await conn.query('UPDATE restaurant_tables SET seating_parent_id=NULL WHERE id IN (?)', [normalizedTableIds]);

        // Separating physical seats never releases a bill or changes its owner.
        if (disjoinedChildren.length > 0) {
            await appendAuditEvent(conn, {
                eventType: 'table_disjoin',
                userId: user.id,
                entityType: 'table',
                entityId: parentTableId,
                oldValue: { children: disjoinedChildren },
                newValue: { separated_ids: disjoinedChildren.map(c => c.id) },
                ipAddress: ipAddress || null
            });
        }

        await conn.commit();
        conn.release();
        conn = null;

        if (io) {
            await broadcastTableUpdates(io, [parentTableId, ...normalizedTableIds]);
        }

        return { message: "Tables separated successfully." };
    } catch (err) {
        if (conn) await conn.rollback();
        logger.error({ err }, 'Tables disjoin transaction failed');
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

module.exports = { processTableAction, joinTables, disjoinTables };
