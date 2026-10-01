'use strict';

const { createHash } = require('node:crypto');
const items = require('./StockDocumentItems');
const { OWNER_IDS_SQL } = require('./productBarcodes');

const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CURSOR_ERROR = 'The stock page cursor does not match these filters. Start from the first page.';

function normalize(query) {
    if (Object.keys(query).some(key => !['cursor', 'limit', 'q', 'kind', 'attention'].includes(key))) {
        throw invalid('Unsupported stock filter.');
    }
    for (const value of Object.values(query)) if (typeof value !== 'string') throw invalid('Invalid stock filter.');
    const limit = query.limit == null ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('A stock page contains 1 to 100 items.');
    const q = (query.q || '').trim();
    if ([...q].length > 100) throw invalid('Stock search is too long.');
    const kind = query.kind || 'all';
    if (!['product', 'ingredient', 'all'].includes(kind)) throw invalid('Invalid stock filter.');
    const attention = query.attention || null;
    if (attention != null && !['ok', 'unknown', 'negative', 'low'].includes(attention)) throw invalid('Invalid stock filter.');
    const fingerprint = hash({ q, kind, attention });
    let after;
    if (query.cursor) {
        try {
            if (query.cursor.length > 1400 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
            after = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
            if (after.v !== 2 || after.filter !== fingerprint || typeof after.name !== 'string' || [...after.name].length > 100 ||
                !['product', 'ingredient'].includes(after.kind) || typeof after.id !== 'string' || !/^[1-9]\d{0,18}$/.test(after.id)) throw new Error();
        } catch { throw invalid(CURSOR_ERROR); }
    }
    return { limit, q, kind, attention, fingerprint, after };
}

// SQL decimals (16,6 for products, 28,6 for ingredients) as a plain 6-decimal string, no float, no range limit.
const sixDecimals = text => {
    const [whole, fraction = ''] = String(text).split('.');
    return `${whole}.${fraction.padEnd(6, '0')}`;
};

const likePrefix = q => q.replace(/[=%_]/g, char => '=' + char) + '%';

// Ordering is (name, kind, id), so on equal names an ingredient comes before a product.
function productBranch(filter, threshold) {
    const qty = 'CASE WHEN l.stock_item_id IS NULL THEN p.stock ELSE b.quantity END';
    const known = 'CASE WHEN l.stock_item_id IS NULL THEN 1 ELSE COALESCE(b.quantity_known, 0) END';
    const attention = `CASE WHEN ${known} = 0 THEN 'unknown' WHEN ${qty} <= 0 THEN 'negative'
        WHEN ${qty} <= ${threshold} THEN 'low' ELSE 'ok' END`;
    const where = [items.PRODUCT_ELIGIBLE], args = [];
    if (filter.attention) { where.push(`${attention} = ?`); args.push(filter.attention); }
    if (filter.q) { where.push(`(p.name LIKE ? ESCAPE '=' OR p.id IN (${OWNER_IDS_SQL}))`); args.push(likePrefix(filter.q), filter.q, filter.q); }
    if (filter.after) {
        const { name, kind, id } = filter.after;
        where.push(kind === 'ingredient' ? 'p.name >= ?' : '(p.name > ? OR (p.name = ? AND p.id > ?))');
        args.push(...(kind === 'ingredient' ? [name] : [name, name, id]));
    }
    return {
        args: [...args, filter.limit + 1],
        sql: `(SELECT p.name, 'product' AS kind, p.id, c.name AS group_label, 'unit' AS base_unit, 'unit' AS display_unit,
                p.barcode, CAST(${qty} AS CHAR) AS quantity, ${known} AS quantity_known, ${attention} AS attention
            FROM products p LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN product_stock_links l ON l.product_id = p.id LEFT JOIN stock_balances b ON b.stock_item_id = l.stock_item_id
            WHERE ${where.join(' AND ')} ORDER BY p.name, p.id LIMIT ?)`,
    };
}

function ingredientBranch(filter) {
    const qty = 'i.working_quantity', known = 'i.working_quantity_known';
    const attention = `CASE WHEN ${known} = 0 THEN 'unknown' WHEN ${qty} <= 0 THEN 'negative'
        WHEN i.par_qty IS NOT NULL AND ${qty} < i.par_qty THEN 'low' ELSE 'ok' END`;
    const where = ['i.is_active = 1'], args = [];
    if (filter.attention) { where.push(`${attention} = ?`); args.push(filter.attention); }
    if (filter.q) { where.push("i.name LIKE ? ESCAPE '='"); args.push(likePrefix(filter.q)); }
    if (filter.after) {
        const { name, kind, id } = filter.after;
        where.push(kind === 'product' ? 'i.name > ?' : '(i.name > ? OR (i.name = ? AND i.id > ?))');
        args.push(...(kind === 'product' ? [name] : [name, name, id]));
    }
    return {
        args: [items.INGREDIENTS_LABEL, ...args, filter.limit + 1],
        sql: `(SELECT i.name, 'ingredient' AS kind, i.id, ? AS group_label, ${items.INGREDIENT_BASE_UNIT_SQL} AS base_unit,
                i.display_unit, NULL AS barcode, CAST(${qty} AS CHAR) AS quantity, ${known} AS quantity_known, ${attention} AS attention
            FROM ingredients i WHERE ${where.join(' AND ')} ORDER BY i.name, i.id LIMIT ?)`,
    };
}

// Every stock-tracked item (see StockDocumentItems): one settings read for the flags, then one UNION
// page query with a LIMIT per branch. Quantity and attention come from the same rows, so nothing is
// hydrated per item, there is no COUNT(*), and no movement history is read.
async function list(conn, query = {}) {
    const filter = normalize(query);
    const flags = await items.readFlags(conn);
    const branches = [];
    if (flags.products && filter.kind !== 'ingredient') {
        const [[setting]] = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'low_stock_threshold'");
        const threshold = Number(setting?.setting_value);
        branches.push(productBranch(filter, Number.isFinite(threshold) && threshold >= 0 ? threshold : 3));
    }
    if (flags.ingredients && filter.kind !== 'product') branches.push(ingredientBranch(filter));
    let rows = [];
    if (branches.length) {
        [rows] = await conn.query(`${branches.map(branch => branch.sql).join(' UNION ALL ')}
            ORDER BY name, kind, id LIMIT ?`, [...branches.flatMap(branch => branch.args), filter.limit + 1]);
    }
    const more = rows.length > filter.limit, page = rows.slice(0, filter.limit);
    const out = page.map(row => {
        const known = Number(row.quantity_known) === 1;
        return {
            id: `${row.kind}:${row.id}`, item_key: `${row.kind}:${row.id}`, kind: row.kind, name: row.name,
            group_label: row.group_label ?? items.OTHER_LABEL, base_unit: row.base_unit, display_unit: row.display_unit,
            barcode: row.barcode ?? null, quantity_known: known,
            quantity: known && row.quantity != null ? sixDecimals(row.quantity) : null,
            attention: row.attention,
        };
    });
    const last = page.at(-1);
    return {
        items: out,
        next_cursor: more ? Buffer.from(JSON.stringify({ v: 2, filter: filter.fingerprint, name: last.name, kind: last.kind, id: String(last.id) })).toString('base64url') : null,
        limit: filter.limit, has_more: more,
    };
}

module.exports = { list };
