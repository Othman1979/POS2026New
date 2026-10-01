const pool = require('../../config/db');
const { getConnection } = require('../../services/StockReportInvalidation');
const { evaluateAction, canOverrideTables, assertTableSectionAccess } = require('../../services/PermissionService');
const { assertOrderItemBundleIntegrity } = require('../../services/bundleIntegrity');
const { recomputeOrderTotals } = require('../../services/OrderPricing');
const { appendAuditEvent } = require('../../services/auditEvents');
const { broadcastTableUpdates } = require('../../services/TableRealtime');
const { transferLineUsage } = require('../../services/RecipeLedgerService');
const { getBusinessDate } = require('../../utils/businessDate');
const { planServiceCharges, persistServiceCharges } = require('./tableTransferServiceCharges');
const { assertNoActiveSplitChecks } = require('./splitChecks');
const { validOperationId, normalizeExpectedTables, groupState, claimTableAction } = require('./tableActionIdentity');
const { conflict, normalizeSelection, splitTransferredLines, money, calculateSavedMoney, assertCompatibleBills, assertMoneyConserved } = require('./tableItemTransferMath');

const ITEM_COLUMNS = ['invoice_id', 'product_id', 'item_name', 'quantity', 'price_at_sale', 'price_before_tax_exemption',
    'tax_rate', 'jofotara_tax_category', 'tax_amount', 'note', 'discount_type', 'discount_value', 'sort_order', 'parent_item_id',
    'selected_modifiers', 'modifier_surcharge', 'modifier_tax_amount', 'created_at', 'recipe_line_key', 'recipe_cost_snapshot', 'stock_authority', 'stock_snapshot'];
const insertItems = (conn, rows) => conn.query(`INSERT INTO order_items (${ITEM_COLUMNS.join(',')}) VALUES ?`,
    [rows.map(row => ITEM_COLUMNS.map(column => row[column] ?? null))]);
const assertVersion = (order, version) => {
    if (!Number.isSafeInteger(version) || version < 1 || version !== Number(order.version || 1)) {
        conflict('The table order changed. Reopen it to review the latest bill before moving items.', 'TABLE_ORDER_VERSION_CONFLICT');
    }
};

async function lockBills(conn, user, sourceId, targetId, expectedTables, { sourceVersion, targetVersion, preview }) {
    const ids = [sourceId, targetId].sort((a, b) => a - b);
    const [tables] = await conn.query(`SELECT id,section_id,table_number,parent_table_id,current_order_id,status
        FROM restaurant_tables WHERE id IN (?) OR parent_table_id IN (?) ORDER BY id FOR UPDATE`, [ids, ids]);
    assertTableSectionAccess(user, tables);
    if (JSON.stringify(groupState(tables)) !== JSON.stringify(expectedTables)) conflict('The selected tables changed. Review the floor plan before trying again.', 'TABLE_ACTION_CONFLICT');
    const source = tables.find(t => Number(t.id) === sourceId), target = tables.find(t => Number(t.id) === targetId);
    if (!source || !target || source.parent_table_id || target.parent_table_id || !source.current_order_id
        || source.current_order_id === target.current_order_id) conflict('Select two different bills using their owning tables.', 'TABLE_ACTION_CONFLICT');
    if (tables.some(t => t.status === 'printed')) conflict('Items cannot be moved from or to a printed bill.', 'TABLE_CHECK_PRINTED');
    const members = root => tables.filter(t => Number(t.id) === Number(root.id) || Number(t.parent_table_id) === Number(root.id));
    for (const root of [source, target]) {
        if (root.status !== (root.current_order_id ? 'occupied' : 'available') || members(root).some(t => t.current_order_id !== root.current_order_id || t.status !== root.status)) {
            conflict('A shared bill changed. Reopen it before moving items.', 'TABLE_ACTION_CONFLICT');
        }
    }
    const invoiceIds = [source.current_order_id, target.current_order_id].filter(Boolean).sort((a, b) => a - b);
    const [orders] = await conn.query('SELECT * FROM orders WHERE invoice_id IN (?) ORDER BY invoice_id FOR UPDATE', [invoiceIds]);
    if (orders.length !== invoiceIds.length || orders.some(o => o.payment_method !== 'unpaid_table' || o.parent_invoice_id != null)) conflict('Only open table bills can receive or transfer items.');
    for (const order of orders) {
        const table = order.invoice_id === source.current_order_id ? source : target;
        if (Number(order.table_id) !== Number(table.id)) conflict('The bill moved to another table.', 'TABLE_ACTION_CONFLICT');
        if (order.waiter_id && Number(order.waiter_id) !== Number(user.id) && !canOverrideTables(user)) {
            conflict('Moving items on another waiter’s bill requires table override permission.', undefined, 403);
        }
    }
    const sourceOrder = orders.find(o => o.invoice_id === source.current_order_id);
    const targetOrder = orders.find(o => o.invoice_id === target.current_order_id);
    assertVersion(sourceOrder, sourceVersion);
    if (!preview) {
        if (targetOrder) assertVersion(targetOrder, targetVersion);
        else if (targetVersion !== null) conflict('The destination changed.', 'TABLE_ORDER_VERSION_CONFLICT');
    }
    await assertNoActiveSplitChecks(conn, invoiceIds);
    const [paidChildren] = await conn.query("SELECT parent_invoice_id FROM orders WHERE parent_invoice_id IN (?) AND payment_method NOT IN ('unpaid_table','voided') LIMIT 1", [invoiceIds]);
    if (paidChildren.length) conflict('A bill with paid split checks cannot transfer items.', 'SPLIT_ALREADY_PAID');
    const [items] = await conn.query('SELECT * FROM order_items WHERE invoice_id IN (?) ORDER BY invoice_id,sort_order,id FOR UPDATE', [invoiceIds]);
    const sourceItems = items.filter(row => row.invoice_id === source.current_order_id), targetItems = items.filter(row => row.invoice_id === target.current_order_id);
    assertOrderItemBundleIntegrity(sourceItems); assertOrderItemBundleIntegrity(targetItems);
    return { tables, source, target, sourceTables: members(source), targetTables: members(target),
        sourceOrder, targetOrder, sourceItems, targetItems };
}

async function moveRows(conn, { moved, remaining, targetInvoiceId, targetItems }) {
    let sortOrder = Math.max(-1, ...targetItems.map(row => Number(row.sort_order || 0))) + 1;
    const children = new Map();
    for (const row of moved) if (row.parent_item_id != null) {
        const list = children.get(Number(row.parent_item_id)) || []; list.push(row); children.set(Number(row.parent_item_id), list);
    }
    const updates = [], inserts = [], deletes = [], relocated = [];
    const remainingById = new Map(remaining.map(row => [Number(row.id), row]));
    for (const parent of moved.filter(row => row.parent_item_id == null)) {
        const bundle = children.get(Number(parent.id)) || [];
        const row = { ...parent, invoice_id: targetInvoiceId, parent_item_id: null, sort_order: sortOrder++ };
        if (!parent.partial && !bundle.length) relocated.push({ id: parent.id, sort_order: row.sort_order });
        else if (!bundle.length) inserts.push(row);
        else {
            const [result] = await insertItems(conn, [row]);
            await insertItems(conn, bundle.map(child => ({ ...child, invoice_id: targetInvoiceId, parent_item_id: result.insertId, sort_order: sortOrder++ })));
        }
        if (!parent.partial && bundle.length) deletes.push(parent.id);
    }
    for (const row of moved) if (row.partial) {
        const left = remainingById.get(Number(row.id));
        updates.push({ id: row.id, quantity: left.quantity });
    }
    for (let offset = 0; offset < relocated.length; offset += 200) {
        const batch = relocated.slice(offset, offset + 200);
        await conn.query(`UPDATE order_items SET invoice_id=?, sort_order=CASE id ${batch.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE id IN (?)`,
            [targetInvoiceId, ...batch.flatMap(row => [row.id, row.sort_order]), batch.map(row => row.id)]);
    }
    for (let offset = 0; offset < updates.length; offset += 200) {
        const batch = updates.slice(offset, offset + 200);
        await conn.query(`UPDATE order_items SET quantity=CASE id ${batch.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE id IN (?)`,
            [...batch.flatMap(row => [row.id, row.quantity]), batch.map(row => row.id)]);
    }
    for (let offset = 0; offset < inserts.length; offset += 200) await insertItems(conn, inserts.slice(offset, offset + 200));
    if (deletes.length) await conn.query('DELETE FROM order_items WHERE id IN (?)', [deletes]);
    return sortOrder;
}

async function transferTableItems({ user, input, preview = false, io, ipAddress = null }) {
    if (!evaluateAction(user, 'table.transfer_items').allowed) conflict('Moving items requires table transfer and saved-order edit permissions.', undefined, 403);
    if (input.action !== 'move_items') conflict('Invalid item transfer action.', undefined, 400);
    const sourceId = Number(input.sourceTableId), targetId = Number(input.targetTableId);
    if (![sourceId, targetId].every(id => Number.isSafeInteger(id) && id > 0) || sourceId === targetId) conflict('Select different source and destination tables.', undefined, 400);
    const selection = normalizeSelection(input.items), expectedTables = normalizeExpectedTables(input.expected_tables);
    if (!expectedTables) conflict('The selected tables changed. Review the floor plan before trying again.', 'TABLE_ACTION_CONFLICT');
    if (!preview && !validOperationId(input.operation_id)) conflict('A valid table action key is required.', 'TABLE_ACTION_KEY_REQUIRED', 400);
    let conn = await getConnection(pool);
    try {
        await conn.beginTransaction();
        if (!preview) {
            const receipt = await claimTableAction(conn, { operationId: input.operation_id, userId: user.id, sourceId, targetId,
                action: 'move_items', expectedTables, itemTransfer: { items: selection, sourceVersion: input.source_version, targetVersion: input.target_version } });
            if (receipt.conflict) conflict('This table action key belongs to a different request.', 'TABLE_ACTION_KEY_CONFLICT');
            if (receipt.result) { await conn.rollback(); return receipt.result; }
        }
        const context = await lockBills(conn, user, sourceId, targetId, expectedTables, {
            sourceVersion: input.source_version, targetVersion: input.target_version, preview
        });
        const { sourceOrder, targetOrder, sourceItems, targetItems } = context;
        const lines = splitTransferredLines(sourceItems, selection);
        const wholeMove = lines.wholeBill && !targetOrder;
        let servicePlan = null;
        if (!wholeMove) {
            assertCompatibleBills(sourceOrder, targetOrder);
            servicePlan = await planServiceCharges(conn, context, lines);
        }
        const sourceBefore = money(sourceOrder), targetBefore = money(targetOrder);
        const sourceAfter = wholeMove ? money(null) : calculateSavedMoney(sourceOrder, servicePlan.sourceRows);
        const targetAfter = wholeMove ? sourceBefore : calculateSavedMoney(targetOrder || sourceOrder, servicePlan.targetRows);
        assertMoneyConserved(sourceBefore, targetBefore, sourceAfter, targetAfter);
        const result = { source_version: Number(sourceOrder.version || 1), target_version: targetOrder ? Number(targetOrder.version || 1) : null,
            source: { table_id: sourceId, table_number: context.source.table_number, before: sourceBefore, after: sourceAfter },
            target: { table_id: targetId, table_number: context.target.table_number, before: targetBefore, after: targetAfter } };
        if (preview) { await conn.rollback(); return result; }
        // A fully moved bundle is recreated under the destination's composite FK.
        // Keep its original saved shape and recipe keys even if the source closes.
        const transferredSnapshot = lines.moved.map(row => Object.fromEntries(['id', 'parent_item_id', 'product_id', 'item_name', 'quantity',
            'price_at_sale', 'tax_rate', 'discount_type', 'discount_value', 'note', 'selected_modifiers', 'recipe_line_key', 'stock_authority', 'stock_snapshot']
            .map(key => [key, row[key] ?? null])));
        let targetInvoiceId = targetOrder?.invoice_id;
        if (wholeMove) {
            targetInvoiceId = sourceOrder.invoice_id;
            await conn.query('UPDATE orders SET table_id=? WHERE invoice_id=?', [targetId, targetInvoiceId]);
        } else {
            if (!targetInvoiceId) {
                const [created] = await conn.query(`INSERT INTO orders(user_id,waiter_id,shift_id,table_id,order_type_id,subtotal,tax,total,payment_method,
                    tax_inclusive_at_sale,receipt_tax_inclusive_at_sale,tax_registration_type_at_sale,tax_exempt_at_sale)
                    VALUES(?,?,?,?,?,0,0,0,'unpaid_table',?,?,?,?)`, [user.id, sourceOrder.waiter_id, sourceOrder.shift_id, targetId,
                    sourceOrder.order_type_id, sourceOrder.tax_inclusive_at_sale, sourceOrder.receipt_tax_inclusive_at_sale,
                    sourceOrder.tax_registration_type_at_sale, sourceOrder.tax_exempt_at_sale]);
                targetInvoiceId = created.insertId;
            }
            const originals = new Map(sourceItems.map(row => [Number(row.id), row]));
            const partialPreparations = lines.moved.filter(row => row.parent_item_id == null && row.partial && row.recipe_line_key)
                .map(row => ({ ...row, original_quantity: originals.get(Number(row.id)).quantity }));
            const movedKeys = await transferLineUsage(conn, { lines: partialPreparations,
                sourceId: sourceOrder.invoice_id, targetId: targetInvoiceId,
                sourceLabel: `Table ${context.source.table_number}: items moved out`,
                targetLabel: `Table ${context.target.table_number}: items moved in`, actor: user, businessDate: getBusinessDate() });
            for (const row of lines.moved) if (movedKeys.has(Number(row.id))) row.recipe_line_key = movedKeys.get(Number(row.id));
            const nextSortOrder = await moveRows(conn, { ...lines, targetInvoiceId, targetItems });
            await persistServiceCharges(conn, { plan: servicePlan, context, targetInvoiceId, wholeBill: lines.wholeBill, userId: user.id, insertItems, nextSortOrder });
            await recomputeOrderTotals(conn, targetInvoiceId, { preserveSavedTax: true });
            if (lines.wholeBill) await conn.query('DELETE FROM orders WHERE invoice_id=?', [sourceOrder.invoice_id]);
            else await recomputeOrderTotals(conn, sourceOrder.invoice_id, { preserveSavedTax: true });
        }
        if (lines.wholeBill) await conn.query("UPDATE restaurant_tables SET current_order_id=NULL,status='available',parent_table_id=NULL WHERE id IN (?)", [context.sourceTables.map(t => t.id)]);
        await conn.query("UPDATE restaurant_tables SET current_order_id=?,status='occupied' WHERE id IN (?)", [targetInvoiceId, context.targetTables.map(t => t.id)]);
        await appendAuditEvent(conn, { eventType: 'table_item_transfer', userId: user.id, entityType: 'order', entityId: sourceOrder.invoice_id,
            oldValue: { source_table_id: sourceId, target_table_id: targetId, source: sourceBefore, target: targetBefore, items: selection, saved_lines: transferredSnapshot },
            newValue: { target_invoice_id: targetInvoiceId, source: sourceAfter, target: targetAfter }, ipAddress });
        Object.assign(result, { operation_id: input.operation_id, source_invoice_id: sourceOrder.invoice_id, target_invoice_id: targetInvoiceId,
            whole_bill_moved: wholeMove, source_released: lines.wholeBill, message: 'Items moved successfully.' });
        await conn.query('UPDATE table_action_operations SET result_json=? WHERE operation_id=?', [JSON.stringify(result), input.operation_id]);
        await conn.commit(); conn.release(); conn = null;
        if (io) await broadcastTableUpdates(io, context.tables.map(table => table.id));
        return result;
    } catch (error) { if (conn) await conn.rollback(); throw error; }
    finally { if (conn) conn.release(); }
}

module.exports = { transferTableItems };
