'use strict';

const BUNDLE_ORDER_CORRUPT = 'BUNDLE_ORDER_CORRUPT';
const BUNDLE_ORDER_CORRUPT_MESSAGE = 'Order bundle data is inconsistent. Manager repair required.';

function bundleOrderCorruptionError() {
    const error = new Error(BUNDLE_ORDER_CORRUPT_MESSAGE);
    error.statusCode = 409;
    error.publicCode = BUNDLE_ORDER_CORRUPT;
    return error;
}

function fail(reason, context) {
    const error = bundleOrderCorruptionError();
    error.integrityReason = reason;
    error.integrityContext = context;
    throw error;
}

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const rowId = row => row?.id ?? row?.cartId ?? null;

function assertHeldItemStructure(items) {
    if (!Array.isArray(items)) throw bundleOrderCorruptionError();
    for (const item of items) {
        if (item === null || typeof item !== 'object') throw bundleOrderCorruptionError();
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) throw bundleOrderCorruptionError();
        if (Object.prototype.hasOwnProperty.call(item, 'bundleItems') && !Array.isArray(item.bundleItems)) {
            throw bundleOrderCorruptionError();
        }
    }
    return items;
}

function assertOrderItemBundleIntegrity(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const byId = new Map();
    for (const row of list) {
        const id = Number(row?.id);
        if (Number.isInteger(id) && id > 0) byId.set(id, row);
    }

    for (const child of list) {
        if (child?.parent_item_id == null) continue;
        const parentId = Number(child.parent_item_id);
        const parent = byId.get(parentId);
        const context = { childId: rowId(child), parentId: child.parent_item_id };
        if (!parent) fail('missing_same_invoice_parent', context);
        if (child.invoice_id != null && parent.invoice_id != null &&
            String(child.invoice_id) !== String(parent.invoice_id)) {
            fail('cross_invoice_parent', {
                ...context,
                childInvoiceId: child.invoice_id,
                parentInvoiceId: parent.invoice_id
            });
        }
        if (parent.parent_item_id != null) fail('nested_parent', context);
        if (!positive(parent.quantity ?? parent.qty)) fail('non_positive_parent_quantity', context);
        if (!positive(child.quantity ?? child.qty)) fail('non_positive_child_quantity', context);
    }
    return rows;
}

function assertNestedBundleIntegrity(items) {
    const list = Array.isArray(items) ? items : [];
    for (let itemIndex = 0; itemIndex < list.length; itemIndex++) {
        const item = list[itemIndex];
        if (!Array.isArray(item?.bundleItems)) continue;
        const context = { itemIndex, parentId: rowId(item) };
        if (!positive(item.qty ?? item.quantity)) fail('non_positive_parent_quantity', context);
        for (let childIndex = 0; childIndex < item.bundleItems.length; childIndex++) {
            const child = item.bundleItems[childIndex];
            if (child?.removed === true) continue;
            if (!positive(child?.qty ?? child?.quantity)) {
                fail('non_positive_child_quantity', {
                    ...context,
                    childIndex,
                    childId: child?.product_id ?? child?.id ?? null
                });
            }
        }
    }
    return items;
}

module.exports = {
    BUNDLE_ORDER_CORRUPT,
    BUNDLE_ORDER_CORRUPT_MESSAGE,
    bundleOrderCorruptionError,
    assertHeldItemStructure,
    assertOrderItemBundleIntegrity,
    assertNestedBundleIntegrity
};
