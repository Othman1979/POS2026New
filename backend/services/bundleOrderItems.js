// backend/services/bundleOrderItems.js
// Secure, DB-driven bundle child-row helpers.
// Used by checkout (Task 9) and table-order path (Task 11).
// NEVER trusts client for child qty, product_id, or name.
// Only allowed client inputs per sub-item: removed (boolean), note (string).

'use strict';

const { assertOrderItemBundleIntegrity } = require('./bundleIntegrity');

async function insertBundleChildRows(conn, sql, rows) {
    const pendingRows = [];
    let pendingBytes = 0;
    const flush = async () => {
        if (pendingRows.length === 0) return;
        const rowsToInsert = pendingRows.splice(0, pendingRows.length);
        pendingBytes = 0;
        await conn.query(sql, [rowsToInsert]);
    };

    for (const row of rows) {
        const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
        if (pendingRows.length > 0 && (
            pendingRows.length >= 50 ||
            pendingBytes + rowBytes > 256 * 1024
        )) {
            await flush();
        }
        pendingRows.push(row);
        pendingBytes += rowBytes;
    }
    await flush();
}

/**
 * Validate all bundle cart lines against the DB.
 * Throws Error(.statusCode=400, message="Invalid bundle contents.") on any forge.
 *
 * Checks:
 *  (a) Each nested bundle parent product_id resolves to a product with is_bundle=1.
 *  (b) Every client sub-item (including removed ones) has a non-null product_id
 *      that is a declared member of that bundle in product_bundle_items.
 *  (c) Fresh-admission callers may require every catalog bundle to carry a
 *      nested bundleItems array; persisted historical paths deliberately do not.
 *
 * @param {import('mysql2/promise').Connection} conn  - mysql2 connection (inside transaction)
 * @param {Array} bundleCartLines  - cart items carrying nested bundleItems
 * @param {object} options
 * @param {boolean} options.requireBundleItems - require arrays for catalog bundles
 * @param {Map<number, object>|null} options.trustedProductMap - checkout admission rows
 * @returns {Promise<Map<number, Array>>} authoritative member rows by bundle id
 */
async function validateBundleCartLines(conn, bundleCartLines, {
    requireBundleItems = false,
    trustedProductMap = null
} = {}) {
    const lines = Array.isArray(bundleCartLines) ? bundleCartLines : [];
    const nestedLines = lines.filter(line => Array.isArray(line?.bundleItems));
    const catalogLines = requireBundleItems ? lines : nestedLines;
    const productIds = new Set();

    for (const line of catalogLines) {
        const hasBundleItems = Array.isArray(line?.bundleItems);
        if (line?.product_id == null) {
            if (hasBundleItems) throw invalidBundleContents();
            continue;
        }
        const productId = Number(line.product_id);
        if (!Number.isInteger(productId) || productId <= 0) {
            if (hasBundleItems) throw invalidBundleContents();
            continue;
        }
        productIds.add(productId);
    }

    if (productIds.size === 0) return new Map();
    let productsById;
    if (trustedProductMap) {
        productsById = new Map();
        for (const productId of productIds) {
            const product = trustedProductMap.get(productId);
            if (!product) throw invalidBundleContents();
            productsById.set(productId, product);
        }
    } else {
        const [productRows] = await conn.query(
            'SELECT id, is_bundle FROM products WHERE id IN (?)',
            [[...productIds]]
        );
        productsById = new Map(productRows.map(row => [Number(row.id), row]));
    }
    const nestedBundleIds = new Set();

    for (const line of catalogLines) {
        const hasBundleItems = Array.isArray(line?.bundleItems);
        if (line?.product_id == null) continue;
        const productId = Number(line.product_id);
        if (!Number.isInteger(productId) || productId <= 0) continue;
        const product = productsById.get(productId);
        if (hasBundleItems) {
            if (!product || Number(product.is_bundle) !== 1) throw invalidBundleContents();
            nestedBundleIds.add(productId);
        } else if (requireBundleItems && Number(product?.is_bundle) === 1) {
            throw invalidBundleContents();
        }
    }

    if (nestedBundleIds.size === 0) return new Map();
    const [memberRows] = await conn.query(
        `SELECT pbi.bundle_id, pbi.product_id, pbi.qty, p.name, p.category_id, pbi.sort_order
           FROM product_bundle_items pbi
           JOIN products p ON p.id = pbi.product_id
          WHERE pbi.bundle_id IN (?)
          ORDER BY pbi.bundle_id, pbi.sort_order`,
        [[...nestedBundleIds]]
    );
    const membersByBundleId = new Map();
    for (const row of memberRows) {
        const bundleId = Number(row.bundle_id);
        if (!membersByBundleId.has(bundleId)) membersByBundleId.set(bundleId, []);
        membersByBundleId.get(bundleId).push(row);
    }

    for (const line of nestedLines) {
        const validMemberIds = new Set((membersByBundleId.get(Number(line.product_id)) || [])
            .map(member => Number(member.product_id)));
        for (const sub of line.bundleItems) {
            const productId = Number(sub?.product_id);
            if (!Number.isInteger(productId) || !validMemberIds.has(productId)) throw invalidBundleContents();
        }
    }
    return membersByBundleId;
}

/**
 * Insert DB-driven child order_items for one bundle parent line, plus audit rows for removals.
 *
 * Security contract:
 *  - Child product_id, qty, name all come from product_bundle_items JOIN products (DB source of truth).
 *  - Client sub-items are used ONLY for: removed (boolean), note (string), matched by product_id.
 *  - A removed DB member is skipped (no child row) and always audited in bundle_modifications,
 *    regardless of client _modified flag.
 *
 * @param {import('mysql2/promise').Connection} conn
 * @param {object} opts
 * @param {number}  opts.invoiceId         - orders.id for the checkout
 * @param {number}  opts.parentItemId      - insertId of the parent order_items row
 * @param {number}  opts.bundleProductId   - product_id of the bundle (FK into product_bundle_items.bundle_id)
 * @param {number}  opts.parentQty         - quantity of the parent line (multiplied with each member's DB qty)
 * @param {Array}   opts.clientSubs        - item.bundleItems from client (trusted only for .removed / .note)
 * @param {number}  opts.startSortOrder    - current sort_order counter; incremented per inserted child
 * @param {number}  opts.cashierId         - api_user.id — written to bundle_modifications for audit
 * @returns {Promise<number>} nextSortOrder (startSortOrder + number of child rows inserted)
 */
async function insertBundleChildren(conn, {
    invoiceId,
    parentItemId,
    bundleProductId,
    parentQty,
    clientSubs,
    startSortOrder,
    cashierId,
    bundleDefinition = null,
}) {
    // Fetch authoritative DB members: qty and name come from DB, never from client.
    const dbMembers = Array.isArray(bundleDefinition)
        ? bundleDefinition
        : (await conn.query(
            `SELECT pbi.product_id, pbi.qty, p.name
             FROM product_bundle_items pbi
             JOIN products p ON p.id = pbi.product_id
             WHERE pbi.bundle_id = ?
             ORDER BY pbi.sort_order`,
            [bundleProductId]
        ))[0];

    // Build map: product_id → client sub-item (for removed/note lookup only).
    const clientSubMap = new Map();
    for (const sub of (clientSubs || [])) {
        if (sub.product_id != null) {
            clientSubMap.set(sub.product_id, sub);
        }
    }

    let sortOrder = startSortOrder;
    const childRows = [];
    const childInsertSql = `
        INSERT INTO order_items
            (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount,
             note, discount_type, discount_value, sort_order, parent_item_id)
        VALUES ?`;
    const flushChildren = async () => {
        if (childRows.length === 0) return;
        await insertBundleChildRows(conn, childInsertSql, childRows);
        childRows.length = 0;
    };

    for (const member of dbMembers) {
        const clientSub = clientSubMap.get(member.product_id);
        const isRemoved = clientSub != null && clientSub.removed === true;

        if (isRemoved) {
            // Server-derived audit: log removal regardless of client _modified flag.
            // product_name taken from DB JOIN, not client.
            await flushChildren();
            await conn.query(
                "INSERT INTO bundle_modifications (order_id, cashier_id, product_name, action) VALUES (?, ?, ?, 'removed')",
                [invoiceId, cashierId, member.name]
            );
            // No child row for removed member; do not advance sortOrder.
            continue;
        }

        const childQty = Number(member.qty) * Number(parentQty);
        const childNote = clientSub ? (clientSub.note || null) : null;

        childRows.push([
            invoiceId,
            member.product_id,
            member.name,
            childQty,
            0,
            0,
            0,
            childNote,
            null,
            0,
            sortOrder,
            parentItemId
        ]);
        sortOrder++;
    }

    await flushChildren();

    return sortOrder;
}

function orderedPersistedChildren(childRows) {
    return [...(childRows || [])].sort((left, right) =>
        Number(left.sort_order || 0) - Number(right.sort_order || 0) || Number(left.id || 0) - Number(right.id || 0)
    );
}

function invalidBundleContents() {
    const err = new Error('Invalid bundle contents.');
    err.statusCode = 400;
    return err;
}

/**
 * Replace nested bundle payloads with their DB definition.
 * Client may only preserve a declared member's removed flag and note.
 */
async function canonicalizeBundleCartLines(conn, cartLines, { validatedMembersByBundleId = null } = {}) {
    const nestedLines = (cartLines || []).filter(line => Array.isArray(line?.bundleItems));
    if (!nestedLines.length) return cartLines;
    for (const line of nestedLines) {
        const productId = Number(line.product_id);
        if (!Number.isSafeInteger(productId) || productId <= 0) throw invalidBundleContents();
    }
    const bundleIds = [...new Set(nestedLines.map(line => Number(line.product_id)))];
    let productsById = null;
    let membersByBundleId = validatedMembersByBundleId;
    if (!membersByBundleId) {
        const [bundleRows] = await conn.query(
            'SELECT id, is_bundle FROM products WHERE id IN (?)',
            [bundleIds]
        );
        productsById = new Map(bundleRows.map(row => [Number(row.id), row]));
        const [memberRows] = await conn.query(
            `SELECT pbi.bundle_id, pbi.product_id, pbi.qty, p.name, p.category_id
             FROM product_bundle_items pbi
             JOIN products p ON p.id = pbi.product_id
             WHERE pbi.bundle_id IN (?)
             ORDER BY pbi.bundle_id, pbi.sort_order`,
            [bundleIds]
        );
        membersByBundleId = new Map();
        for (const row of memberRows) {
            const bundleId = Number(row.bundle_id);
            if (!membersByBundleId.has(bundleId)) membersByBundleId.set(bundleId, []);
            membersByBundleId.get(bundleId).push(row);
        }
    }

    for (const line of nestedLines) {
        const bundleId = Number(line.product_id);
        if (!Number.isSafeInteger(bundleId) || bundleId <= 0
            || (productsById && Number(productsById.get(bundleId)?.is_bundle) !== 1)) {
            throw invalidBundleContents();
        }
        const dbMembers = membersByBundleId.get(bundleId) || [];
        const validMemberIds = new Set(dbMembers.map(member => Number(member.product_id)));
        const clientByProductId = new Map();
        for (const sub of line.bundleItems) {
            const productId = Number(sub?.product_id);
            if (!Number.isInteger(productId) || !validMemberIds.has(productId)) {
                throw invalidBundleContents();
            }
            clientByProductId.set(productId, sub);
        }

        line.is_bundle = true;
        line.bundleItems = dbMembers.map(member => {
            const clientSub = clientByProductId.get(Number(member.product_id));
            return {
                product_id: member.product_id,
                name: member.name,
                category_id: member.category_id,
                qty: Number(member.qty),
                note: typeof clientSub?.note === 'string' ? clientSub.note : null,
                removed: clientSub?.removed === true
            };
        });
    }
    return cartLines;
}

async function reconstructBundleSubs(_conn, parentRow, childRows) {
    const children = orderedPersistedChildren(childRows);
    assertOrderItemBundleIntegrity([parentRow, ...children]);
    return children.map(child => ({
        product_id: child.product_id,
        name: child.item_name ?? child.name ?? null,
        qty: Number(child.quantity) / Number(parentRow.quantity),
        note: child.note ?? null,
        removed: false
    }));
}

async function insertPersistedBundleChildren(conn, {
    invoiceId,
    parentItemId,
    parentRow,
    childRows,
    parentQty,
    startSortOrder,
}) {
    const children = orderedPersistedChildren(childRows);
    assertOrderItemBundleIntegrity([parentRow, ...children]);

    let sortOrder = startSortOrder;
    const insertRows = [];
    for (const child of children) {
        const quantity = (Number(child.quantity) / Number(parentRow.quantity)) * Number(parentQty);
        insertRows.push([
            invoiceId,
            child.product_id,
            child.item_name ?? child.name ?? null,
            quantity,
            child.price_at_sale,
            child.tax_rate,
            child.tax_amount,
            child.note ?? null,
            child.selected_modifiers ?? null,
            child.modifier_surcharge ?? null,
            child.modifier_tax_amount ?? null,
            child.discount_type ?? null,
            child.discount_value ?? 0,
            sortOrder,
            parentItemId
        ]);
        sortOrder++;
    }
    await insertBundleChildRows(conn, `
        INSERT INTO order_items
            (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount,
             note, selected_modifiers, modifier_surcharge, modifier_tax_amount, discount_type, discount_value, sort_order, parent_item_id)
        VALUES ?`, insertRows);
    return sortOrder;
}

/**
 * Insert the child rows captured in a server-authored historical snapshot.
 *
 * Unlike insertBundleChildren, this deliberately does not read the current
 * product_bundle_items definition. The snapshot contains per-parent-unit
 * quantities and can optionally retain removed-child audit records.
 */
async function insertSnapshotBundleChildren(conn, {
    invoiceId,
    parentItemId,
    parentQty,
    snapshotSubs,
    startSortOrder,
    cashierId = null,
    auditRemoved = false,
}) {
    let sortOrder = startSortOrder;
    const insertRows = [];
    const childInsertSql = `
        INSERT INTO order_items
            (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount,
             note, discount_type, discount_value, sort_order, parent_item_id)
        VALUES ?`;
    const flushChildren = async () => {
        if (insertRows.length === 0) return;
        await insertBundleChildRows(conn, childInsertSql, insertRows);
        insertRows.length = 0;
    };
    for (const child of snapshotSubs) {
        if (child.removed === true) {
            if (auditRemoved) {
                await flushChildren();
                await conn.query(
                    "INSERT INTO bundle_modifications (order_id, cashier_id, product_name, action) VALUES (?, ?, ?, 'removed')",
                    [invoiceId, cashierId, child.name ?? null]
                );
            }
            continue;
        }
        const quantity = Number(child.qty) * Number(parentQty);
        insertRows.push([
            invoiceId,
            child.product_id,
            child.name ?? null,
            quantity,
            0,
            0,
            0,
            child.note ?? null,
            null,
            0,
            sortOrder,
            parentItemId
        ]);
        sortOrder++;
    }
    await flushChildren();
    return sortOrder;
}

module.exports = {
    validateBundleCartLines,
    canonicalizeBundleCartLines,
    insertBundleChildren,
    reconstructBundleSubs,
    insertPersistedBundleChildren,
    insertSnapshotBundleChildren
};
