'use strict';

// Stock effects of a stock document. The caller owns the transaction and has already locked every
// row through StockDocumentItems.resolveForUpdate (`locked`); nothing here takes a new lock.
//
// A received line goes through the service that owns its kind, so balances, costs, report dirtying
// and product projections stay exactly what the rest of the system expects:
//   linked product      StockProductAdapter.journalProductDeltas (the sale path's own primitive)
//   ingredient          RecipeLedgerService.recordStockBatch / correctManualMovement
//   simple product      products.stock += qty, stock_version += 1, one stock_operations row per document;
//                       an unlimited product (stock NULL) starts tracking: its stock becomes the received quantity
//
// A count sets the balance to an absolute quantity (the counted amount adjusted for what happened since it
// was counted; see StockCountService) through the same owners: the ledger for a linked product (mirrored onto
// products.stock), one UPDATE for simple stock, recordStockBatch for ingredients.

const { createHash } = require('node:crypto');
const { journalProductDeltas } = require('./StockProductAdapter');
const ledger = require('./StockLedgerService');
const recipes = require('./RecipeLedgerService');
const stockQuantity = require('./stockQuantity');
const { StockDocumentError } = require('./StockDocumentItems');

const STOCK_COUNT_SOURCE_LABEL = 'Stock count';
const MAX_STOCK = 9999999999999999n; // products.stock is DECIMAL(16,6).

const fail = (statusCode, code, message) => { throw new StockDocumentError(statusCode, code, message); };
const isDuplicate = (error) => error.code === 'ER_DUP_ENTRY';

function linesOf(lines, locked, mode, kind) {
    return lines
        .map((line) => ({ line, item: locked.items.get(line.item_key) }))
        .filter(({ item }) => item && item.kind === kind && (mode == null || item.mode === mode));
}

// One statement for every simple product of the document: stock = stock + delta, version bumped.
// An unlimited product (stock NULL) starts from zero, so receiving it makes stock the received quantity.
async function moveSimpleProducts(conn, entries, sign) {
    const [updated] = await conn.query(
        `UPDATE products SET stock = COALESCE(stock, 0) + CASE id ${entries.map(() => 'WHEN ? THEN CAST(? AS DECIMAL(16,6))').join(' ')} END, stock_version = stock_version + 1
          WHERE id IN (?)`,
        [...entries.flatMap(({ line, item }) => [item.product_id, sign < 0 ? `-${line.base_qty}` : line.base_qty]),
            entries.map(({ item }) => item.product_id)]);
    if (updated.affectedRows !== entries.length) fail(409, 'PURCHASE_ITEM_INVALID', 'Product stock changed while posting. Nothing was posted; try again.');
}

// Before/after for each simple product, computed from the locked rows (scaled BigInt, 6 dp).
// before is null for an unlimited product (stock NULL); after is null when a reversal returns it to unlimited.
function simpleRows(entries, sign) {
    return entries.map(({ line, item }) => {
        const before = item.quantity == null ? null : stockQuantity.parse(item.quantity);
        const delta = stockQuantity.parse(line.base_qty);
        return { product_id: item.product_id, name: item.name, qty: line.base_qty, before, after: (before ?? 0n) + (sign < 0 ? -delta : delta) };
    });
}

const formatOrNull = (units) => (units == null ? null : stockQuantity.format(units));
const simpleResult = (rows) => rows.map((row) => ({
    product_id: row.product_id, qty: row.qty, before: formatOrNull(row.before), after: formatOrNull(row.after),
}));

// One stock_operations row for the whole document; its request key comes from the document's own key.
async function journalSimple(conn, { kind, requestKey, actor, documentId, rows }) {
    const products = simpleResult(rows);
    const hash = createHash('sha256').update(JSON.stringify([documentId, kind, products])).digest('hex');
    try {
        const [operation] = await conn.query(
            'INSERT INTO stock_operations (request_key, payload_hash, kind, actor_id, legacy_product_id, result_json) VALUES (?, ?, ?, ?, NULL, ?)',
            [requestKey, hash, kind, actor.id, JSON.stringify({ document_id: String(documentId), products })]);
        return operation.insertId;
    } catch (error) {
        if (isDuplicate(error)) fail(409, 'PURCHASE_INVOICE_KEY_REUSED', 'This request key belongs to a different invoice.');
        throw error;
    }
}

// Puts simple products back to unlimited (stock NULL), version bumped.
async function clearSimpleProducts(conn, entries) {
    const [updated] = await conn.query(
        'UPDATE products SET stock = NULL, stock_version = stock_version + 1 WHERE id IN (?)', [entries.map(({ item }) => item.product_id)]);
    if (updated.affectedRows !== entries.length) fail(409, 'PURCHASE_ITEM_INVALID', 'Product stock changed while posting. Nothing was posted; try again.');
}

// Absolute version of moveSimpleProducts: stock = the given quantity, version bumped.
async function setSimpleProducts(conn, entries) {
    const [updated] = await conn.query(
        `UPDATE products SET stock = CASE id ${entries.map(() => 'WHEN ? THEN CAST(? AS DECIMAL(16,6))').join(' ')} END, stock_version = stock_version + 1
          WHERE id IN (?)`,
        [...entries.flatMap(({ line, item }) => [item.product_id, line.base_qty]), entries.map(({ item }) => item.product_id)]);
    if (updated.affectedRows !== entries.length) fail(409, 'STOCK_COUNT_BUSY', 'Product stock changed while posting. Nothing was posted; try again.');
}

const CHUNK = 100; // the ledger and the ingredient batch both take at most 100 lines

// lines: [{ item_key, base_qty }] where base_qty is the NEW absolute balance in base units (string, 6 dp, never negative).
async function count(conn, { documentId, lines, locked, actor, businessDate, postKey }) {
    const result = { business_date: businessDate, product_operation_ids: [], simple_operation_id: null, simple_products: [], ingredient_movements: [] };
    const linked = linesOf(lines, locked, 'ledger', 'product').sort((a, b) => a.item.product_id - b.item.product_id);
    if (linked.length) {
        // The stock items and balances are locked already; the versions read here are the ones the ledger will see.
        const [versionRows] = await conn.query(
            'SELECT CAST(stock_item_id AS CHAR) AS stock_item_id, CAST(version AS CHAR) AS version FROM stock_balances WHERE stock_item_id IN (?)',
            [linked.map(({ item }) => item.stock_item_id)]);
        const versions = new Map(versionRows.map((row) => [row.stock_item_id, row.version]));
        const after = new Map();
        for (let offset = 0; offset < linked.length; offset += CHUNK) {
            const chunk = linked.slice(offset, offset + CHUNK);
            const posted = await ledger.post(conn, {
                kind: 'count', request_key: `stockcount-${documentId}-linked-${offset / CHUNK}`, business_date: businessDate,
                lines: chunk.map(({ line, item }) => ({
                    stock_item_id: item.stock_item_id, quantity: line.base_qty, expected_version: versions.get(item.stock_item_id) ?? '0',
                    source_line: `stock_count:${documentId}:product:${item.product_id}`,
                })),
            }, actor.id);
            for (const row of posted.lines) after.set(row.stock_item_id, row.quantity);
            result.product_operation_ids.push(posted.operation_id);
        }
        // Mirror the ledger balance onto the linked products.
        const [mirrored] = await conn.query(
            `UPDATE products SET stock = CASE id ${linked.map(() => 'WHEN ? THEN CAST(? AS DECIMAL(16,6))').join(' ')} END, stock_version = stock_version + 1
              WHERE id IN (?)`,
            [...linked.flatMap(({ item }) => [item.product_id, after.get(item.stock_item_id)]), linked.map(({ item }) => item.product_id)]);
        if (mirrored.affectedRows !== linked.length) fail(409, 'STOCK_COUNT_BUSY', 'Product stock changed while posting. Nothing was posted; try again.');
    }
    const simple = linesOf(lines, locked, 'simple', 'product').sort((a, b) => a.item.product_id - b.item.product_id);
    if (simple.length) {
        const rows = simple.map(({ line, item }) => ({
            product_id: item.product_id, name: item.name, qty: line.base_qty, before: stockQuantity.parse(item.quantity), after: stockQuantity.parse(line.base_qty),
        }));
        if (rows.some((row) => row.after > MAX_STOCK)) fail(400, 'STOCK_COUNT_INVALID', 'Stock exceeds the supported quantity.');
        await setSimpleProducts(conn, simple);
        result.simple_operation_id = await journalSimple(conn, { kind: 'count', requestKey: `sdoc-${postKey}`, actor, documentId, rows });
        result.simple_products = simpleResult(rows);
    }
    const ingredients = linesOf(lines, locked, null, 'ingredient').sort((a, b) => a.item.ingredient_id - b.item.ingredient_id);
    for (let offset = 0; offset < ingredients.length; offset += CHUNK) {
        const batch = await recipes.recordStockBatch(conn, {
            kind: 'count', clientKey: `scount-${documentId}-i${offset / CHUNK}`, actor, businessDate,
            source: { label: STOCK_COUNT_SOURCE_LABEL, id: Number(documentId) },
            entries: ingredients.slice(offset, offset + CHUNK).map(({ line, item }) => ({ ingredient_id: item.ingredient_id, qty: line.base_qty, unit: item.base_unit })),
        });
        result.ingredient_movements.push(...batch.movements.map((row) => ({ ingredient_id: Number(row.ingredient_id), movement_id: Number(row.id) })));
    }
    return result;
}

// lines: [{ item_key, base_qty (string, 6 dp), cost (string per base unit, or null) }]
// postKey: the document's post key; the simple-stock journal row is keyed from it, so a retry replays.
async function receive(conn, { documentId, lines, locked, actor, businessDate, postKey }) {
    const result = {
        business_date: businessDate, product_operation_ids: [], simple_operation_id: null, simple_products: [], ingredient_movements: [],
    };
    const linked = linesOf(lines, locked, 'ledger', 'product');
    if (linked.length) {
        const ids = new Set(linked.map(({ item }) => item.product_id));
        const posted = await journalProductDeltas(conn, {
            before: locked.productRows.filter((row) => ids.has(Number(row.id))),
            deltas: new Map(linked.map(({ line, item }) => [item.product_id, line.base_qty])), kind: 'receipt',
            source: { type: 'purchase_invoice', id: String(documentId) }, businessDate, actorId: actor.id,
            resolvedLinks: locked.links.filter((link) => ids.has(Number(link.product_id))),
        });
        result.product_operation_ids = posted.operation_ids;
        // Which stock record each product was received into, so a reversal can prove it is undoing the same one.
        result.linked_items = linked.map(({ item }) => ({ product_id: item.product_id, stock_item_id: item.stock_item_id }));
    }
    const simple = linesOf(lines, locked, 'simple', 'product').sort((a, b) => a.item.product_id - b.item.product_id);
    if (simple.length) {
        const rows = simpleRows(simple, 1);
        if (rows.some((row) => row.after > MAX_STOCK)) fail(400, 'PURCHASE_STOCK_TOO_LARGE', 'Stock exceeds the supported quantity.');
        await moveSimpleProducts(conn, simple, 1);
        result.simple_operation_id = await journalSimple(conn, {
            kind: 'receipt', requestKey: `sdoc-${postKey}`, actor, documentId, rows,
        });
        // The version each product has right after this posting (the rows are locked and the statement adds exactly 1),
        // so a reversal can tell whether anything touched its stock since.
        result.simple_products = simpleResult(rows).map((row, index) => ({
            ...row, stock_version_after: String(BigInt(simple[index].item.stock_version) + 1n),
        }));
    }
    const ingredients = linesOf(lines, locked, null, 'ingredient');
    if (ingredients.length) {
        const batch = await recipes.recordStockBatch(conn, {
            kind: 'receipt', clientKey: `pinv-${documentId}-post`, actor, businessDate,
            source: { label: recipes.PURCHASE_SOURCE_LABEL, id: Number(documentId) },
            entries: ingredients.map(({ line, item }) => ({
                ingredient_id: item.ingredient_id, qty: line.base_qty, unit: item.base_unit,
                ...(line.cost == null ? {} : { unit_cost: line.cost }),
            })),
        });
        result.ingredient_movements = batch.movements.map((row) => ({ ingredient_id: Number(row.ingredient_id), movement_id: Number(row.id) }));
    }
    return result;
}

// posted: the document's saved stock_result (ingredient receipts are undone by correcting their movements).
async function reverseReceive(conn, { documentId, lines, locked, posted, actor, businessDate, reverseKey }) {
    const result = { business_date: businessDate, product_operation_ids: [], simple_operation_id: null, simple_products: [], ingredient_corrections: [] };
    const linked = linesOf(lines, locked, 'ledger', 'product');
    // Older documents carry no record of the stock item; they skip this check.
    const recorded = new Map((posted?.linked_items || []).map((row) => [row.product_id, String(row.stock_item_id)]));
    const moved = linked.find(({ item }) => recorded.has(item.product_id) && recorded.get(item.product_id) !== String(item.stock_item_id));
    if (moved) fail(409, 'PURCHASE_INVOICE_REVERSE_BLOCKED', "This item's stock record changed after the invoice was posted. Correct it with a stock count instead.");
    if (linked.length) {
        const ids = new Set(linked.map(({ item }) => item.product_id));
        const out = await journalProductDeltas(conn, {
            before: locked.productRows.filter((row) => ids.has(Number(row.id))),
            deltas: new Map(linked.map(({ line, item }) => [item.product_id, `-${line.base_qty}`])), kind: 'issue',
            source: { type: 'purchase_invoice_reverse', id: String(documentId) }, businessDate, actorId: actor.id,
            resolvedLinks: locked.links.filter((link) => ids.has(Number(link.product_id))),
        });
        result.product_operation_ids = out.operation_ids;
    }
    const allSimple = linesOf(lines, locked, 'simple', 'product').sort((a, b) => a.item.product_id - b.item.product_id);
    // A receipt that started tracking an unlimited product (it recorded before: null) goes back to unlimited when
    // nothing has touched that product's stock since: its version is still the one the posting left. Documents
    // without the recorded version, and products changed since, reverse by subtracting like any other.
    const startedAt = new Map((posted?.simple_products || [])
        .filter((row) => row.before === null && row.stock_version_after != null)
        .map((row) => [Number(row.product_id), String(row.stock_version_after)]));
    const untrack = allSimple.filter(({ item }) => item.quantity_known && startedAt.get(item.product_id) === String(item.stock_version));
    const rest = allSimple.filter((entry) => !untrack.includes(entry));
    // Stock tracking switched off (or the product made unlimited) since posting leaves products.stock NULL:
    // there is nothing to subtract, so the line is skipped and the document still reverses.
    const simple = rest.filter(({ item }) => item.quantity_known);
    const skipped = rest.filter(({ item }) => !item.quantity_known).map(({ item }) => ({ item_key: item.item_key, reason: 'untracked' }));
    if (skipped.length) result.skipped = skipped;
    if (simple.length || untrack.length) {
        const rows = simpleRows(simple, -1);
        const short = rows.find((row) => row.after < 0n);
        if (short) fail(409, 'PURCHASE_INVOICE_REVERSE_BLOCKED', `${short.name} was already sold or used, so reversing would take its stock below zero.`);
        if (simple.length) await moveSimpleProducts(conn, simple, -1);
        if (untrack.length) await clearSimpleProducts(conn, untrack);
        rows.push(...untrack.map(({ line, item }) => ({
            product_id: item.product_id, name: item.name, qty: line.base_qty, before: stockQuantity.parse(item.quantity), after: null,
        })));
        rows.sort((a, b) => a.product_id - b.product_id);
        result.simple_operation_id = await journalSimple(conn, {
            kind: 'issue', requestKey: `sdoc-r-${reverseKey}`, actor, documentId, rows,
        });
        result.simple_products = simpleResult(rows);
    }
    for (const movement of [...(posted?.ingredient_movements || [])].sort((a, b) => a.ingredient_id - b.ingredient_id)) {
        const corrected = await recipes.correctManualMovement(conn, {
            movementId: movement.movement_id, note: `Purchase invoice ${documentId} reversed`,
            clientKey: `pinv-${documentId}-rev-${movement.ingredient_id}`, actor, businessDate, allowPurchase: true,
        });
        result.ingredient_corrections.push({ ingredient_id: movement.ingredient_id, movement_id: Number(corrected.movement.id) });
    }
    return result;
}

// What the announce step needs after commit: tills reload the products named, and ingredient screens refresh.
function eventScope(locked) {
    const items = [...locked.items.values()];
    return {
        productIds: items.filter((item) => item.kind === 'product').map((item) => item.product_id),
        ingredientIds: items.filter((item) => item.kind === 'ingredient').map((item) => item.ingredient_id),
        stockItemIds: items.filter((item) => item.stock_item_id != null).map((item) => item.stock_item_id),
        hasProducts: items.some((item) => item.kind === 'product'),
        hasIngredients: items.some((item) => item.kind === 'ingredient'),
    };
}

module.exports = { receive, reverseReceive, count, eventScope, STOCK_COUNT_SOURCE_LABEL };
