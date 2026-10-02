'use strict';

// The one place that decides which items a stock document (purchase invoice, stock count) can hold.
//
// What a document may hold depends on its use (`use` option, 'count' unless said otherwise):
//   count                stock-tracked products and active ingredients, together on one sheet
//   product_purchase     products only, including products whose stock is unlimited (NULL): receiving
//                        one starts tracking it, so stock becomes the received quantity
//   ingredient_purchase  active ingredients only
// The item rules behind those uses, with no per-item "enable stock movements" step:
//   product, simple stock   no product_stock_links row; a count needs products.stock to be a number
//                           (NULL means "unlimited", so it is not tracked), a purchase accepts NULL too
//   product, linked stock   exactly one link, qty_per_sale 1, to an active stock item that no other
//                           product shares (its own pack sale products aside) and that is not an ingredient's own item
//   ingredient              active, whether or not it was ever activated in the stock ledger
// Bundles, products with recipe lines, note categories, composite and shared links are never eligible.
// Products need settings.stock_enabled = '1'; ingredients need settings.recipe_ledger_enabled = '1'.
//
// An item is named by item_key: 'product:<id>' or 'ingredient:<id>'. A key of the other kind than the
// use allows is simply not eligible.

const { loadLinks } = require('./StockProductAdapter');
const stockQuantity = require('./stockQuantity');
const { OWNER_IDS_SQL } = require('./productBarcodes');

const MAX_KEYS = 1000;
const OTHER_LABEL = 'Other items';
const INGREDIENTS_LABEL = 'Ingredients';
const KEY_PATTERN = /^(product|ingredient):([1-9]\d{0,9})$/;

class StockDocumentError extends Error {
    constructor(statusCode, code, message) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}
const fail = (statusCode, code, message) => { throw new StockDocumentError(statusCode, code, message); };

const formatKey = (kind, id) => `${kind}:${id}`;

// { kind, id } for a well-formed key, else null.
function parseKey(key) {
    const match = typeof key === 'string' ? KEY_PATTERN.exec(key) : null;
    return match ? { kind: match[1], id: Number(match[2]) } : null;
}

const likeEscape = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);
const compareId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

const INGREDIENT_BASE_UNIT_SQL = "CASE i.measure WHEN 'weight' THEN 'g' WHEN 'volume' THEN 'ml' ELSE 'unit' END";
const BASE_UNIT = { weight: 'g', volume: 'ml', count: 'unit' };

// Products table aliased p, categories aliased c (LEFT JOIN).
// A pack sale product (product_packs.sale_product_id) moves its base product's stock item; it is never an item itself.
const PRODUCT_BASE = `p.is_active = 1 AND p.is_bundle = 0 AND COALESCE(c.is_notes, 0) = 0
    AND NOT EXISTS (SELECT 1 FROM product_recipe_lines r WHERE r.product_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM product_packs sp WHERE sp.sale_product_id = p.id)`;
const NO_STOCK_LINK = 'NOT EXISTS (SELECT 1 FROM product_stock_links l WHERE l.product_id = p.id)';
const ONE_TO_ONE_LINK = `(1 = (SELECT COUNT(*) FROM product_stock_links l WHERE l.product_id = p.id)
          AND EXISTS (SELECT 1 FROM product_stock_links l JOIN stock_items si ON si.id = l.stock_item_id
                       WHERE l.product_id = p.id AND l.qty_per_sale = 1 AND si.is_active = 1
                         AND si.tracking_state = 'active' AND si.legacy_ingredient_id IS NULL
                         AND NOT EXISTS (SELECT 1 FROM product_stock_links o WHERE o.stock_item_id = l.stock_item_id AND o.product_id <> p.id
                                          AND NOT EXISTS (SELECT 1 FROM product_packs op WHERE op.product_id = p.id AND op.sale_product_id = o.product_id))))`;
// Tracked products: what counts and the Stock levels page work on.
const PRODUCT_ELIGIBLE = `${PRODUCT_BASE}
    AND ((p.stock IS NOT NULL AND ${NO_STOCK_LINK}) OR ${ONE_TO_ONE_LINK})`;
// Products a purchase can receive: the tracked ones plus simple products whose stock is unlimited (NULL).
const PRODUCT_PURCHASE_ELIGIBLE = `${PRODUCT_BASE}
    AND (${NO_STOCK_LINK} OR ${ONE_TO_ONE_LINK})`;

// products: the SQL deciding which products the use accepts (null = none); ingredients: whether it takes them.
const USES = {
    count: { products: PRODUCT_ELIGIBLE, ingredients: true },
    product_purchase: { products: PRODUCT_PURCHASE_ELIGIBLE, ingredients: false },
    ingredient_purchase: { products: null, ingredients: true },
};

async function readFlags(db) {
    const [rows] = await db.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('stock_enabled', 'recipe_ledger_enabled')");
    const values = new Map(rows.map((row) => [row.setting_key, row.setting_value]));
    return { products: values.get('stock_enabled') === '1', ingredients: values.get('recipe_ledger_enabled') === '1' };
}

// What `use` can hold right now: the product SQL (null when no products qualify) and whether ingredients do,
// after the settings switches.
async function readScope(db, use) {
    const scope = USES[use];
    if (!scope) throw new TypeError(`Unknown stock document use: ${use}`);
    const flags = await readFlags(db);
    return { productSql: flags.products ? scope.products : null, ingredients: flags.ingredients && scope.ingredients };
}

function splitKeys(itemKeys) {
    if (!Array.isArray(itemKeys) || itemKeys.length > MAX_KEYS) fail(400, 'PURCHASE_ITEM_INVALID', `A document holds at most ${MAX_KEYS} items.`);
    const productIds = [];
    const ingredientIds = [];
    for (const key of new Set(itemKeys)) {
        const parsed = parseKey(key);
        if (!parsed) fail(400, 'PURCHASE_ITEM_INVALID', 'An item is invalid.');
        (parsed.kind === 'product' ? productIds : ingredientIds).push(parsed.id);
    }
    return { productIds, ingredientIds };
}

// ---------- search ----------

// starts_tracking: receiving this item makes its unlimited stock (NULL) a counted quantity.
// A barcode (the `barcode` option, or the whole search text) matches a product's main or an extra barcode exactly;
// matched_barcode is the one that matched (null when the product matched by name or the item is an ingredient).
async function searchItems(db, { q, categoryId, barcode, limit, use = 'count' }) {
    const scope = await readScope(db, use);
    const term = (q || '').trim().slice(0, 100);
    const code = (barcode || '').trim().slice(0, 50);
    const out = [];
    if (scope.productSql) {
        const conditions = [scope.productSql];
        const params = [];
        let rank = '2';
        const rankParams = [];
        let matched = 'NULL';
        const matchedParams = [];
        const matchedSql = 'CASE WHEN p.barcode = ? THEN p.barcode ELSE (SELECT x.barcode FROM product_barcodes x WHERE x.product_id = p.id AND x.barcode = ? LIMIT 1) END';
        if (code) {
            conditions.push(`p.id IN (${OWNER_IDS_SQL})`);
            params.push(code, code);
            matched = matchedSql;
            matchedParams.push(code, code);
        } else if (term) {
            conditions.push(`(p.name LIKE ? OR p.id IN (${OWNER_IDS_SQL}))`);
            params.push(`%${likeEscape(term)}%`, term, term);
            rank = `CASE WHEN p.id IN (${OWNER_IDS_SQL}) THEN 0 WHEN p.name LIKE ? THEN 1 ELSE 2 END`;
            rankParams.push(term, term, `${likeEscape(term)}%`);
            matched = matchedSql;
            matchedParams.push(term, term);
        }
        if (categoryId) {
            conditions.push('p.category_id = ?');
            params.push(categoryId);
        }
        const [rows] = await db.query(
            `SELECT p.id, p.name, p.barcode, p.category_id, c.name AS category_name, p.stock IS NULL AS unlimited,
                    EXISTS (SELECT 1 FROM product_stock_links l WHERE l.product_id = p.id) AS linked, ${rank} AS item_rank,
                    ${matched} AS matched_barcode
               FROM products p LEFT JOIN categories c ON c.id = p.category_id
              WHERE ${conditions.join(' AND ')}
              ORDER BY item_rank, p.name, p.id LIMIT ?`, [...rankParams, ...matchedParams, ...params, limit]);
        for (const row of rows) {
            const linked = Number(row.linked) === 1;
            out.push({
                item_key: formatKey('product', row.id), kind: 'product', product_id: Number(row.id), ingredient_id: null,
                name: row.name, measure: 'count', base_unit: 'unit',
                category_id: row.category_id == null ? null : Number(row.category_id), category_name: row.category_name ?? null,
                barcode: row.barcode ?? null, matched_barcode: row.matched_barcode ?? null, pack_name: null, pack_size: null,
                mode: linked ? 'ledger' : 'simple', starts_tracking: !linked && Number(row.unlimited) === 1, rank: Number(row.item_rank),
            });
        }
    }
    // Ingredients have no barcode and no menu category.
    if (scope.ingredients && !code && !categoryId) {
        const conditions = ['i.is_active = 1'];
        const params = [];
        let rank = '2';
        const rankParams = [];
        if (term) {
            conditions.push('i.name LIKE ?');
            params.push(`%${likeEscape(term)}%`);
            rank = 'CASE WHEN i.name LIKE ? THEN 1 ELSE 2 END';
            rankParams.push(`${likeEscape(term)}%`);
        }
        const [rows] = await db.query(
            `SELECT i.id, i.name, i.measure, ${INGREDIENT_BASE_UNIT_SQL} AS base_unit, i.display_unit, i.pack_name, i.pack_size, ${rank} AS item_rank
               FROM ingredients i WHERE ${conditions.join(' AND ')}
              ORDER BY item_rank, i.name, i.id LIMIT ?`, [...rankParams, ...params, limit]);
        for (const row of rows) {
            out.push({
                item_key: formatKey('ingredient', row.id), kind: 'ingredient', product_id: null, ingredient_id: Number(row.id),
                name: row.name, measure: row.measure, base_unit: row.base_unit, display_unit: row.display_unit,
                category_id: null, category_name: null, barcode: null, matched_barcode: null,
                pack_name: row.pack_name ?? null, pack_size: row.pack_size == null ? null : Number(row.pack_size),
                mode: 'ledger', starts_tracking: false, rank: Number(row.item_rank),
            });
        }
    }
    out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || (a.kind === b.kind ? 0 : a.kind === 'product' ? -1 : 1));
    return out.slice(0, limit).map(({ rank, ...item }) => item);
}

// Count groups: one per menu category with eligible products, plus all ingredients.
// A purchase only filters by category, so the "other" group is a count-sheet concept.
async function listGroups(db, { use = 'count' } = {}) {
    const scope = await readScope(db, use);
    const groups = [];
    if (scope.productSql) {
        const [rows] = await db.query(
            `SELECT c.id, c.name, COUNT(*) AS item_count
               FROM products p JOIN categories c ON c.id = p.category_id
              WHERE ${scope.productSql}
              GROUP BY c.id, c.name ORDER BY c.name, c.id LIMIT 300`);
        for (const row of rows) {
            groups.push({ group_key: `category:${row.id}`, kind: 'category', category_id: Number(row.id), label: row.name, item_count: Number(row.item_count) });
        }
    }
    if (scope.productSql && use === 'count') {
        // Eligible products with no menu category still need counting; they form one group of their own.
        const [[row]] = await db.query(
            `SELECT COUNT(*) AS item_count FROM products p LEFT JOIN categories c ON c.id = p.category_id
              WHERE p.category_id IS NULL AND ${scope.productSql}`);
        if (Number(row.item_count) > 0) groups.push({ group_key: 'other', kind: 'other', category_id: null, label: OTHER_LABEL, item_count: Number(row.item_count) });
    }
    if (scope.ingredients) {
        const [[row]] = await db.query('SELECT COUNT(*) AS item_count FROM ingredients WHERE is_active = 1');
        if (Number(row.item_count) > 0) groups.push({ group_key: 'ingredients', kind: 'ingredients', category_id: null, label: INGREDIENTS_LABEL, item_count: Number(row.item_count) });
    }
    return groups;
}

// Which of these keys are eligible right now (a plain read, no locks).
async function eligibleKeys(db, itemKeys, { use = 'count' } = {}) {
    const { productIds, ingredientIds } = splitKeys(itemKeys);
    const scope = await readScope(db, use);
    const found = new Set();
    if (productIds.length && scope.productSql) {
        const [rows] = await db.query(
            `SELECT p.id FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id IN (?) AND ${scope.productSql}`, [productIds]);
        for (const row of rows) found.add(formatKey('product', row.id));
    }
    if (ingredientIds.length && scope.ingredients) {
        const [rows] = await db.query('SELECT id FROM ingredients WHERE id IN (?) AND is_active = 1', [ingredientIds]);
        for (const row of rows) found.add(formatKey('ingredient', row.id));
    }
    return found;
}

// ---------- shared helpers for documents that list items ----------

// An item is named 'product:<id>' or 'ingredient:<id>'; lines store the two ids in separate columns.
const itemKeySql = (alias) => `CASE WHEN ${alias}.product_id IS NOT NULL THEN CONCAT('product:', ${alias}.product_id)
    ELSE CONCAT('ingredient:', ${alias}.ingredient_id) END`;

// WHERE fragment matching lines of these item keys through the two item indexes.
function itemFilter(alias, itemKeys) {
    const productIds = [];
    const ingredientIds = [];
    for (const key of itemKeys) {
        const parsed = parseKey(key);
        if (parsed) (parsed.kind === 'product' ? productIds : ingredientIds).push(parsed.id);
    }
    return {
        sql: `(${alias}.product_id IN (?) OR ${alias}.ingredient_id IN (?))`,
        params: [productIds.length ? productIds : [0], ingredientIds.length ? ingredientIds : [0]],
    };
}

// Buying and counting units per item: a product's own packs (product_packs) first, then recent units from
// the latest 500 posted invoices only, three per item, cut in SQL, so an autocomplete never grows with the
// whole purchase history (no calendar dependence).
// Returns Map item_key -> [{ label, factor }], own packs in their order, then most recent first.
async function recentPacks(db, itemKeys) {
    const recent = new Map();
    if (!itemKeys.length) return recent;
    const { productIds } = splitKeys(itemKeys);
    const own = new Map();
    if (productIds.length) {
        const [packRows] = await db.query(
            'SELECT product_id, label, CAST(factor AS CHAR) AS factor FROM product_packs WHERE product_id IN (?) ORDER BY product_id, sort_order, id',
            [productIds]);
        for (const row of packRows) {
            const key = formatKey('product', row.product_id);
            if (!own.has(key)) own.set(key, []);
            own.get(key).push({ label: row.label, factor: Number(row.factor) });
        }
    }
    const filter = itemFilter('l', itemKeys);
    const [unitRows] = await db.query(
        `SELECT item_key, unit_label, unit_factor FROM (
            SELECT ${itemKeySql('l')} AS item_key, l.unit_label, l.unit_factor,
                   ROW_NUMBER() OVER (PARTITION BY ${itemKeySql('l')} ORDER BY MAX(d.id) DESC) AS rn
              FROM stock_document_lines l JOIN stock_documents d ON d.id = l.document_id
             WHERE ${filter.sql} AND d.doc_type = 'purchase' AND d.status = 'posted'
               AND d.id >= (SELECT COALESCE(MIN(id), 0) FROM (SELECT id FROM stock_documents WHERE doc_type = 'purchase' AND status = 'posted' ORDER BY id DESC LIMIT 500) latest)
             GROUP BY item_key, l.unit_label, l.unit_factor) recent
          WHERE rn <= 3
          ORDER BY item_key, rn`, filter.params);
    for (const row of unitRows) {
        if (!recent.has(row.item_key)) recent.set(row.item_key, []);
        if (recent.get(row.item_key).length < 3) recent.get(row.item_key).push({ label: row.unit_label, factor: Number(row.unit_factor) });
    }
    for (const [key, packs] of own) {
        const history = (recent.get(key) || []).filter((unit) => !packs.some((pack) =>
            pack.label.toLowerCase() === String(unit.label).toLowerCase() && pack.factor === unit.factor));
        recent.set(key, [...packs, ...history]);
    }
    return recent;
}

// Every eligible item of the chosen count groups ('all', or group keys: 'category:<id>', 'other',
// 'ingredients'), ordered by group then name. Returns at most `limit` + 1 rows so the caller can tell
// that the cap was passed. Two bounded queries, no per-item work.
async function listItemsForGroups(db, groups, limit) {
    const flags = await readFlags(db);
    const all = groups === 'all';
    const categoryIds = all ? [] : groups.map((key) => /^category:([1-9]\d{0,9})$/.exec(key)).filter(Boolean).map((match) => Number(match[1]));
    const wantOther = all || groups.includes('other');
    const wantIngredients = all || groups.includes('ingredients');
    const out = [];
    if (flags.products && (all || categoryIds.length || wantOther)) {
        const selection = [];
        const params = [];
        if (!all) {
            if (categoryIds.length) { selection.push('p.category_id IN (?)'); params.push(categoryIds); }
            if (wantOther) selection.push('p.category_id IS NULL');
        }
        const [rows] = await db.query(
            `SELECT p.id, p.name, p.category_id, c.name AS category_name
               FROM products p LEFT JOIN categories c ON c.id = p.category_id
              WHERE ${PRODUCT_ELIGIBLE}${selection.length ? ` AND (${selection.join(' OR ')})` : ''}
              ORDER BY (p.category_id IS NULL), c.name, p.category_id, p.name, p.id LIMIT ?`, [...params, limit + 1]);
        for (const row of rows) {
            out.push({
                item_key: formatKey('product', row.id), kind: 'product', product_id: Number(row.id), ingredient_id: null, name: row.name,
                group_key: row.category_id == null ? 'other' : `category:${row.category_id}`,
                group_label: row.category_id == null ? OTHER_LABEL : row.category_name,
                base_unit: 'unit', display_unit: 'unit',
            });
        }
    }
    if (flags.ingredients && wantIngredients && out.length <= limit) {
        const [rows] = await db.query(
            `SELECT i.id, i.name, ${INGREDIENT_BASE_UNIT_SQL} AS base_unit, i.display_unit
               FROM ingredients i WHERE i.is_active = 1 ORDER BY i.name, i.id LIMIT ?`, [limit + 1 - out.length]);
        for (const row of rows) {
            out.push({
                item_key: formatKey('ingredient', row.id), kind: 'ingredient', product_id: null, ingredient_id: Number(row.id), name: row.name,
                group_key: 'ingredients', group_label: INGREDIENTS_LABEL, base_unit: row.base_unit, display_unit: row.display_unit,
            });
        }
    }
    return out;
}

// The CURRENT running quantity of each item, without locks: Map item_key -> { quantity, known }.
// quantity is the raw running amount (string, 6 dp) or null when none exists; known says whether the balance
// has been established by a count. An unknown balance still moves with usage, so callers that measure a
// change must use the raw quantity and only report it as "on hand" when known.
// Same sources as resolveForUpdate: products.stock for a simple product, the stock balance for a linked one,
// the working quantity for an ingredient.
async function readQuantities(db, itemKeys) {
    const { productIds, ingredientIds } = splitKeys(itemKeys);
    const out = new Map();
    if (productIds.length) {
        const [rows] = await db.query(
            `SELECT p.id, p.stock, l.stock_item_id, CAST(b.quantity AS CHAR) AS quantity, b.quantity_known
               FROM products p LEFT JOIN product_stock_links l ON l.product_id = p.id
               LEFT JOIN stock_balances b ON b.stock_item_id = l.stock_item_id
              WHERE p.id IN (?)`, [productIds]);
        for (const row of rows) {
            let value = { quantity: null, known: false };
            if (row.stock_item_id != null) value = { quantity: row.quantity ?? null, known: Number(row.quantity_known) === 1 };
            else if (row.stock != null) value = { quantity: stockQuantity.format(stockQuantity.parse(row.stock)), known: true };
            out.set(formatKey('product', row.id), value);
        }
    }
    if (ingredientIds.length) {
        const [rows] = await db.query(
            'SELECT id, CAST(working_quantity AS CHAR) AS working_quantity, working_quantity_known FROM ingredients WHERE id IN (?)', [ingredientIds]);
        for (const row of rows) out.set(formatKey('ingredient', row.id), { quantity: row.working_quantity ?? null, known: Number(row.working_quantity_known) === 1 });
    }
    return out;
}

// ---------- locking ----------

const unsupported = (name) => fail(409, 'PURCHASE_ITEM_UNSUPPORTED', `${name} is part of a stock composition. Adjust its physical items instead.`);

// Validates eligibility and locks every row the stock writers will touch, in the sale path's order
// (products, product_stock_links, ingredients, stock_items, stock_balances; each sorted by id), with
// IN lists and no per-row queries. The caller owns the transaction.
//
// Returns { items, productRows, links }:
//   items        Map item_key -> { item_key, kind, mode ('simple' | 'ledger'), name, product_id, ingredient_id,
//                stock_item_id (linked product or activated ingredient, else null), base_unit,
//                quantity (string, 6 dp, or null when unknown), quantity_known, stock_version (products) }
//                quantity is the CURRENT amount: products.stock for a simple product, stock_balances.quantity
//                for a linked product, ingredients.working_quantity for an ingredient.
//   productRows  locked product rows {id, name, stock, stock_version}, for StockProductAdapter
//   links        locked product_stock_links rows of those products, for StockProductAdapter
// { reversal: true } is for undoing a posted document: the same locks in the same order, but the settings and
// eligibility rules for NEW documents are skipped (an item archived or untracked since posting must still be
// reversible); composite and shared links are still refused. The default stays strict.
// `use` names the rules a new document is held to ('count' unless it is a purchase of one kind).
async function resolveForUpdate(conn, itemKeys, { reversal = false, use = 'count' } = {}) {
    const { productIds: rawProducts, ingredientIds: rawIngredients } = splitKeys(itemKeys);
    const productIds = rawProducts.sort((a, b) => a - b);
    const ingredientIds = rawIngredients.sort((a, b) => a - b);
    const flags = await readFlags(conn);
    if (!reversal && ((productIds.length && !flags.products) || (ingredientIds.length && !flags.ingredients))) {
        fail(409, 'PURCHASE_ITEM_INVALID', 'Stock tracking is turned off for an item on this document.');
    }
    const items = new Map();
    let productRows = [];
    let links = [];
    const linksByProduct = new Map();
    if (productIds.length) {
        [productRows] = await conn.query(
            'SELECT id, name, stock, CAST(stock_version AS CHAR) AS stock_version FROM products WHERE id IN (?) ORDER BY id FOR UPDATE', [productIds]);
        if (productRows.length !== productIds.length) fail(409, 'PURCHASE_ITEM_INVALID', 'A product on this document no longer exists.');
        links = await loadLinks(conn, productIds);
        for (const link of links) {
            const id = Number(link.product_id);
            linksByProduct.set(id, [...(linksByProduct.get(id) || []), link]);
        }
        for (const row of productRows) {
            const own = linksByProduct.get(Number(row.id)) || [];
            if (own.length && (own.length !== 1 || own[0].qty_per_sale !== '1.000000')) unsupported(row.name);
        }
    }
    let ingredientRows = [];
    if (ingredientIds.length) {
        [ingredientRows] = await conn.query(
            `SELECT id, name, measure, is_active, CAST(stock_item_id AS CHAR) AS stock_item_id,
                    CAST(working_quantity AS CHAR) AS working_quantity, working_quantity_known
               FROM ingredients WHERE id IN (?) ORDER BY id FOR UPDATE`, [ingredientIds]);
        if (ingredientRows.length !== ingredientIds.length) fail(409, 'PURCHASE_ITEM_INVALID', 'An ingredient on this document no longer exists.');
    }
    const itemIds = [...new Set([
        ...links.map((link) => link.stock_item_id),
        ...ingredientRows.filter((row) => row.stock_item_id != null).map((row) => row.stock_item_id),
    ])].sort(compareId);
    let balances = new Map();
    if (itemIds.length) {
        await conn.query('SELECT id FROM stock_items WHERE id IN (?) ORDER BY id FOR UPDATE', [itemIds]);
        const linkedItemIds = [...new Set(links.map((link) => link.stock_item_id))];
        if (linkedItemIds.length) {
            const [shared] = await conn.query(
                `SELECT l.stock_item_id FROM product_stock_links l WHERE l.stock_item_id IN (?)
                    AND NOT EXISTS (SELECT 1 FROM product_packs sp WHERE sp.sale_product_id = l.product_id)
                  GROUP BY l.stock_item_id HAVING COUNT(*) > 1`, [linkedItemIds]);
            if (shared.length) fail(409, 'PURCHASE_ITEM_UNSUPPORTED', 'An item on this document is shared by several products. Adjust its physical items instead.');
        }
        const [rows] = await conn.query(
            `SELECT CAST(stock_item_id AS CHAR) AS stock_item_id, CAST(quantity AS CHAR) AS quantity, quantity_known
               FROM stock_balances WHERE stock_item_id IN (?) ORDER BY stock_item_id FOR UPDATE`, [itemIds]);
        balances = new Map(rows.map((row) => [row.stock_item_id, row]));
    }
    // The same rules the search applies, now under the locks; anything left over is simply not eligible.
    const eligible = reversal ? new Set(itemKeys) : await eligibleKeys(conn, itemKeys, { use });
    for (const id of productIds) {
        const key = formatKey('product', id);
        const row = productRows.find((candidate) => Number(candidate.id) === id);
        if (!eligible.has(key)) fail(409, 'PURCHASE_ITEM_INVALID', `${row.name} can no longer be used on a stock document.`);
        const own = linksByProduct.get(id) || [];
        const balance = own.length ? balances.get(own[0].stock_item_id) : null;
        const known = own.length ? Boolean(balance && Number(balance.quantity_known) === 1) : row.stock != null;
        items.set(key, {
            item_key: key, kind: 'product', mode: own.length ? 'ledger' : 'simple', name: row.name,
            product_id: id, ingredient_id: null, stock_item_id: own.length ? own[0].stock_item_id : null, base_unit: 'unit',
            quantity: known ? (own.length ? balance.quantity : stockQuantity.format(stockQuantity.parse(row.stock))) : null,
            raw_quantity: own.length ? (balance ? balance.quantity : null) : (row.stock != null ? stockQuantity.format(stockQuantity.parse(row.stock)) : null),
            quantity_known: known, stock_version: row.stock_version,
        });
    }
    for (const row of ingredientRows) {
        const key = formatKey('ingredient', row.id);
        if (!eligible.has(key)) fail(409, 'PURCHASE_ITEM_INVALID', `${row.name} can no longer be used on a stock document.`);
        const known = Number(row.working_quantity_known) === 1;
        items.set(key, {
            item_key: key, kind: 'ingredient', mode: 'ledger', name: row.name, product_id: null, ingredient_id: Number(row.id),
            stock_item_id: row.stock_item_id, base_unit: BASE_UNIT[row.measure],
            quantity: known ? row.working_quantity : null, raw_quantity: row.working_quantity ?? null, quantity_known: known, stock_version: null,
        });
    }
    return { items, productRows, links };
}

module.exports = {
    StockDocumentError, MAX_KEYS, OTHER_LABEL, INGREDIENTS_LABEL, formatKey, parseKey, searchItems, listGroups, eligibleKeys,
    resolveForUpdate, likeEscape, itemKeySql, itemFilter, recentPacks, listItemsForGroups, readQuantities,
    readFlags, PRODUCT_ELIGIBLE, PRODUCT_PURCHASE_ELIGIBLE, INGREDIENT_BASE_UNIT_SQL,
};
