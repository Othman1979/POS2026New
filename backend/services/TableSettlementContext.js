'use strict';

const { assertOrderItemBundleIntegrity } = require('./bundleIntegrity');
const {
    getForUpdate,
    conflict: serviceChargeConflict
} = require('./ServiceChargeSnapshotService');
const { SERVICE_NOTE } = require('./ServiceChargeCalculator');
const { assertTableSectionAccess, getTableSectionIds } = require('./PermissionService');

// Read-only print/legacy references can name a child or its historical parent.
// Unrestricted staff need no extra lookup; scoped readers load the group once.
async function assertTableReadAccess(executor, user, { tableId, invoiceId }) {
    if (getTableSectionIds(user) === null) return;
    const [tables] = await executor.query(
        `SELECT t.id, t.section_id FROM restaurant_tables seat
           JOIN restaurant_tables t ON t.id=seat.id OR t.id=seat.parent_table_id
                OR t.parent_table_id=COALESCE(seat.parent_table_id,seat.id)
          WHERE seat.id=COALESCE(?, (SELECT table_id FROM orders WHERE invoice_id=?))`,
        [tableId ?? null, invoiceId ?? null]
    );
    assertTableSectionAccess(user, tables);
}

function conflict(message = 'Table session changed. Refresh and try again.') {
    const error = new Error(message);
    error.statusCode = 409;
    error.publicCode = 'TABLE_SESSION_CONFLICT';
    return error;
}

// Call after locking the owning table/order. A current read is required: an
// earlier identity probe may have established a snapshot before a split committed.
async function assertNoActiveSplitChecks(conn, invoiceIds) {
    const ids = [...new Set((Array.isArray(invoiceIds) ? invoiceIds : [invoiceIds])
        .map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length) return;
    const [rows] = await conn.query(
        'SELECT parent_invoice_id FROM held_orders WHERE parent_invoice_id IN (?) LIMIT 1 FOR UPDATE',
        [ids]
    );
    if (rows.length) {
        const error = conflict('This table has unpaid split checks. Pay or cancel them from the Table Splits Board.');
        error.publicCode = 'SPLIT_CHECKS_OPEN';
        throw error;
    }
}

async function lockTableSession(conn, { user, tableId, invoiceId, withMoney = true, expectedVersion, requireUnsplit = false }) {
    const requestedTableId = Number(tableId);
    const expectedInvoiceId = Number(invoiceId);
    if (
        !Number.isSafeInteger(requestedTableId) || requestedTableId <= 0 ||
        !Number.isSafeInteger(expectedInvoiceId) || expectedInvoiceId <= 0
    ) {
        throw conflict();
    }

    const [[probe]] = await conn.query(
        'SELECT id, parent_table_id FROM restaurant_tables WHERE id=? LIMIT 1',
        [requestedTableId]
    );
    if (!probe) {
        throw conflict('Table was not found. Refresh and try again.');
    }

    const rootId = Number(probe.parent_table_id || probe.id);
    const [groupTables] = await conn.query(
        `SELECT id, section_id, table_number, status, current_order_id, parent_table_id
           FROM restaurant_tables
          WHERE id=? OR parent_table_id=?
          ORDER BY id
          FOR UPDATE`,
        [rootId, rootId]
    );
    assertTableSectionAccess(user, groupTables);
    const rootTable = groupTables.find(row => Number(row.id) === rootId);
    const requestedTable = groupTables.find(row => Number(row.id) === requestedTableId);
    const validStatuses = new Set(['occupied', 'printed']);
    const groupInvoiceMatches = groupTables.every(
        row => Number(row.current_order_id) === expectedInvoiceId
    );
    const groupShapeMatches = groupTables.every(row => (
        Number(row.id) === rootId || Number(row.parent_table_id) === rootId
    ));
    const groupStatusMatches = groupTables.every(row => (
        validStatuses.has(row.status) && row.status === rootTable?.status
    ));

    if (
        !rootTable || rootTable.parent_table_id != null || !requestedTable ||
        !groupShapeMatches || !groupInvoiceMatches || !groupStatusMatches
    ) {
        throw conflict();
    }

    const [[order]] = await conn.query(
        `SELECT invoice_id, version, order_id, order_seq_scope, order_type_id, shift_id, user_id, waiter_id, table_id,
                payment_method, subtotal, tax, total, discount_type, discount_value,
                refund_status, service_charge_snapshot_id, tax_inclusive_at_sale, receipt_tax_inclusive_at_sale,
                tax_exempt_at_sale,
                tax_registration_type_at_sale,
                invoice_number, invoice_issued_at, created_at
           FROM orders
          WHERE invoice_id=?
          FOR UPDATE`,
        [expectedInvoiceId]
    );
    if (!order) {
        throw conflict();
    }
    if (order.payment_method !== 'unpaid_table') {
        throw conflict(
            'This table order is finalized and cannot be changed from the floor plan. Refresh and try again.'
        );
    }
    if (Number(order.table_id) !== rootId) throw conflict();

    // Table edits supply this option (null when missing). Check the locked bill
    // before loading its lines or touching stock/service-charge state. Settlement
    // and other callers retain their existing identity and money checks.
    if (expectedVersion !== undefined && (
        !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
        expectedVersion !== Number(order.version ?? 1)
    )) {
        const error = conflict('The table order changed. Reopen it to review the latest bill before making changes.');
        error.publicCode = 'TABLE_ORDER_VERSION_CONFLICT';
        throw error;
    }

    if (requireUnsplit) {
        await assertNoActiveSplitChecks(conn, expectedInvoiceId);
        const [paidChildren] = await conn.query(
            "SELECT invoice_id FROM orders WHERE parent_invoice_id=? AND payment_method NOT IN ('unpaid_table','voided') LIMIT 1 FOR UPDATE",
            [expectedInvoiceId]
        );
        if (paidChildren.length) {
            const error = conflict('This table has paid split checks. Open the Table Splits Board to manage its remaining checks.');
            error.publicCode = 'SPLIT_ALREADY_PAID';
            throw error;
        }
    }

    let savedItems = [];
    let serviceChargeSnapshot = null;
    if (withMoney) {
        [savedItems] = await conn.query(
            `SELECT id, invoice_id, parent_item_id, product_id, item_name, quantity,
                    price_at_sale, price_before_tax_exemption, tax_rate, jofotara_tax_category, tax_amount, note, selected_modifiers,
                    modifier_surcharge, modifier_tax_amount, discount_type, discount_value, sort_order,
                    created_at, recipe_line_key, stock_authority, stock_snapshot
               FROM order_items
              WHERE invoice_id=?
              ORDER BY sort_order, id
              FOR UPDATE`,
            [expectedInvoiceId]
        );
        assertOrderItemBundleIntegrity(savedItems);

        if (order.service_charge_snapshot_id) {
            serviceChargeSnapshot = await getForUpdate(
                conn,
                order.service_charge_snapshot_id
            );
            if (
                serviceChargeSnapshot.state !== 'open_order' ||
                serviceChargeSnapshot.holder_type !== 'order' ||
                String(serviceChargeSnapshot.holder_id) !== String(expectedInvoiceId)
            ) {
                throw serviceChargeConflict(
                    'Service-charge snapshot changed. Refresh and try again.'
                );
            }
        }
    }

    return {
        requestedTableId,
        rootTable,
        groupTables,
        groupTableIds: groupTables.map(row => Number(row.id)),
        order,
        savedItems,
        serviceChargeSnapshot
    };
}

const identityKey = ({ product_id, item_name, name, note }) => (
    product_id == null
        ? `custom:${item_name || name || ''}|${note || ''}`
        : `product:${Number(product_id)}|${note || ''}`
);

function changedItems() {
    const error = new Error(
        'Items cannot be changed while cashing out. Edit the order on the floor plan first.'
    );
    error.statusCode = 403;
    return error;
}

function reconcileSavedTableSettlement({ context, submittedItems }) {
    if (!context || !Array.isArray(context.savedItems) || !Array.isArray(submittedItems)) {
        throw changedItems();
    }

    const parents = context.savedItems.filter(row => row.parent_item_id == null);
    const savedGoods = parents.filter(row => row.note !== SERVICE_NOTE);
    const submittedGoods = submittedItems.filter(row => row.note !== SERVICE_NOTE);
    const savedParentsById = new Map(
        savedGoods.map(row => [Number(row.id), row])
    );
    const savedQty = new Map();
    const submittedQty = new Map();
    const submittedIds = new Set();

    for (const row of savedGoods) {
        const key = identityKey(row);
        // Match persisted six-decimal quantities without floating-point addition
        // making equivalent grouped lines (for example 0.1 + 0.2 and 0.3) differ.
        savedQty.set(key, (savedQty.get(key) || 0) + Math.round(Number(row.quantity) * 1_000_000));
    }
    for (const row of submittedGoods) {
        if (row.order_item_id != null) {
            const submittedId = Number(row.order_item_id);
            if (submittedIds.has(submittedId)) {
                throw conflict('Saved item identity changed. Refresh the order and try again.');
            }
            submittedIds.add(submittedId);
            const savedRow = savedParentsById.get(submittedId);
            if (!savedRow || identityKey(savedRow) !== identityKey(row)) {
                throw conflict('Saved item identity changed. Refresh the order and try again.');
            }
        }
        const key = identityKey(row);
        submittedQty.set(key, (submittedQty.get(key) || 0) + Math.round(Number(row.qty) * 1_000_000));
    }

    if (
        savedQty.size !== submittedQty.size ||
        [...savedQty].some(([key, qty]) => submittedQty.get(key) !== qty)
    ) {
        throw changedItems();
    }

    const feeRows = parents.filter(row => row.note === SERVICE_NOTE);
    const submittedFeeRows = submittedItems.filter(row => row.note === SERVICE_NOTE);
    const hasBoundServiceCharge = !!context.serviceChargeSnapshot;
    if (
        (hasBoundServiceCharge && feeRows.length !== 1) ||
        (!hasBoundServiceCharge && feeRows.length > 0) ||
        (!hasBoundServiceCharge && submittedFeeRows.length > 1)
    ) {
        throw conflict('Service-charge line changed. Refresh and try again.');
    }

    const childrenByParent = new Map();
    for (const row of context.savedItems) {
        if (row.parent_item_id == null) continue;
        const parentId = Number(row.parent_item_id);
        if (!childrenByParent.has(parentId)) {
            childrenByParent.set(parentId, []);
        }
        childrenByParent.get(parentId).push(row);
    }

    const toCheckoutItem = row => {
        const children = childrenByParent.get(Number(row.id)) || [];
        return {
            product_id: row.product_id,
            name: row.item_name,
            qty: Number(row.quantity),
            // Table settlement already marks this locked order as pricesAlreadyExempt.
            // Keep the charged price here; the frozen raw source is carried separately
            // by SavedOrderLines for audit/persistence metadata.
            price: Number(row.price_at_sale),
            tax_rate: Number(row.tax_rate),
            note: row.note || '',
            selectedModifiers: row.selected_modifiers,
            modifier_surcharge: row.modifier_surcharge == null
                ? null
                : Number(row.modifier_surcharge),
            modifier_tax_amount: row.modifier_tax_amount == null
                ? null
                : Number(row.modifier_tax_amount),
            discountType: row.discount_type || null,
            discountValue: Number(row.discount_value || 0),
            order_item_id: Number(row.id),
            ...(children.length ? {
                is_bundle: true,
                persistedBundleParent: row,
                persistedBundleChildren: children
            } : {})
        };
    };

    return {
        items: [
            ...savedGoods.map(toCheckoutItem),
            ...(hasBoundServiceCharge
                ? feeRows.map(toCheckoutItem)
                : submittedFeeRows)
        ],
        orderDiscount: {
            type: context.order.discount_type || null,
            value: Number(context.order.discount_value || 0)
        },
        hasBoundServiceCharge
    };
}

module.exports = {
    assertTableReadAccess,
    assertNoActiveSplitChecks,
    lockTableSession,
    reconcileSavedTableSettlement
};
