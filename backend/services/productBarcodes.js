'use strict';

// Extra barcodes of a product. A product keeps its main barcode in products.barcode (every existing reader keeps
// working) and may hold up to MAX_EXTRA_BARCODES more in product_barcodes. Every code, main or extra, is trimmed,
// 1..50 characters and unique across all products. products.idx_barcode and product_barcodes.uq_product_barcode
// each keep their own table unique; this module keeps the two tables distinct from each other.
//
// Wherever a code is matched exactly, the match is main OR extra, resolved through the two unique indexes
// (OWNER_IDS_SQL); never an OR between a products.barcode test and a subquery, which would defeat them.

const MAX_BARCODE_LENGTH = 50;
const MAX_EXTRA_BARCODES = 20;

const barcodeError = (statusCode, publicCode, message) => Object.assign(new Error(message), { statusCode, publicCode });
const invalid = (message) => barcodeError(400, 'PRODUCT_BARCODE_INVALID', message);

// The id list of the products holding one exact code, as main or extra, for `p.id IN (${OWNER_IDS_SQL})`. Two
// placeholders: the code twice. Each part is an uncorrelated scalar subquery on a unique key, so the server
// reads it once, as a constant, and `p` is reached by its primary key. (`p.id IN (SELECT ... UNION ALL SELECT ...)`
// is planned as a per-row dependent subquery that walks the whole products index.)
const OWNER_IDS_SQL = '(SELECT id FROM products WHERE barcode = ?), (SELECT product_id FROM product_barcodes WHERE barcode = ?)';
// The product holding one exact code as an extra, for `p.id = ${EXTRA_OWNER_IDS_SQL}`. One placeholder.
const EXTRA_OWNER_IDS_SQL = '(SELECT product_id FROM product_barcodes WHERE barcode = ?)';

function checkedCode(value) {
    const code = String(value).trim();
    if ([...code].length > MAX_BARCODE_LENGTH) throw invalid(`A barcode cannot exceed ${MAX_BARCODE_LENGTH} characters.`);
    return code;
}

// The main barcode of a request body: undefined when not sent, null when cleared, else the trimmed code.
function normalizeMainBarcode(value) {
    if (value === undefined) return undefined;
    if (!value) return null;
    return checkedCode(value) || null;
}

// extra_barcodes of a request body: undefined when not sent (unchanged), else a list of trimmed, non-empty codes.
function normalizeExtraBarcodes(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw invalid('Extra barcodes must be a list.');
    const codes = [];
    for (const item of value) {
        if (typeof item !== 'string') throw invalid('Each extra barcode must be text.');
        const code = checkedCode(item);
        if (code) codes.push(code);
    }
    if (codes.length > MAX_EXTRA_BARCODES) throw invalid(`A product can have at most ${MAX_EXTRA_BARCODES} extra barcodes.`);
    return codes;
}

// One product may not hold the same code twice (main repeated as an extra, or an extra repeated), ignoring case.
function assertDistinct(main, extras) {
    const seen = new Set();
    for (const code of [main, ...extras]) {
        if (!code) continue;
        const key = code.toLowerCase();
        if (seen.has(key)) throw invalid(`Barcode ${code} is repeated on this product.`);
        seen.add(key);
    }
}

// 409 when another product (not productId; 0 for a new one) holds any of these codes as its main or an extra.
async function assertFree(db, productId, codes) {
    if (!codes.length) return;
    const [rows] = await db.query(
        `SELECT h.barcode, p.name
           FROM (SELECT id AS product_id, barcode FROM products WHERE barcode IN (?) AND id <> ?
                 UNION ALL
                 SELECT product_id, barcode FROM product_barcodes WHERE barcode IN (?) AND product_id <> ?) h
           JOIN products p ON p.id = h.product_id`,
        [codes, productId, codes, productId]);
    if (!rows.length) return;
    // Name the first submitted code that is taken.
    for (const code of codes) {
        const hit = rows.find((row) => String(row.barcode).toLowerCase() === code.toLowerCase());
        if (hit) throw barcodeError(409, 'PRODUCT_BARCODE_TAKEN', `Barcode ${code} is already used by ${hit.name}.`);
    }
    throw barcodeError(409, 'PRODUCT_BARCODE_TAKEN', `Barcode ${rows[0].barcode} is already used by ${rows[0].name}.`);
}

// The submitted codes (exactly as given) that a product already holds as its main or an extra barcode.
// SQL decides in the barcode columns' collation, so a case or accent variant counts as the same code, and only
// the submitted codes are read (in chunks), never a whole table.
const TAKEN_CHUNK = 500;
async function takenCodes(db, codes) {
    const unique = [...new Set(codes.filter(Boolean))];
    const taken = new Set();
    for (let offset = 0; offset < unique.length; offset += TAKEN_CHUNK) {
        const chunk = unique.slice(offset, offset + TAKEN_CHUNK);
        const [rows] = await db.query(
            `SELECT s.code FROM (${chunk.map(() => 'SELECT ? AS code').join(' UNION ALL ')}) s
              WHERE EXISTS (SELECT 1 FROM products p WHERE p.barcode = s.code COLLATE utf8mb4_general_ci)
                 OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.barcode = s.code COLLATE utf8mb4_general_ci)`,
            chunk);
        for (const row of rows) taken.add(row.code);
    }
    return taken;
}

// A race that still reaches either unique key is the same 409.
function asBarcodeConflict(error) {
    if (error?.code === 'ER_DUP_ENTRY' && /idx_barcode|uq_product_barcode/.test(String(error.sqlMessage || error.message))) {
        return barcodeError(409, 'PRODUCT_BARCODE_TAKEN', 'That barcode is already used by another product.');
    }
    return error;
}

// Map product id -> extra barcodes in the order they were entered: one bounded IN query for the whole list.
async function loadExtras(db, productIds) {
    const byProduct = new Map();
    if (!productIds.length) return byProduct;
    const [rows] = await db.query(
        'SELECT product_id, barcode FROM product_barcodes WHERE product_id IN (?) ORDER BY product_id, id', [productIds]);
    for (const row of rows) {
        const id = Number(row.product_id);
        if (!byProduct.has(id)) byProduct.set(id, []);
        byProduct.get(id).push(row.barcode);
    }
    return byProduct;
}

// Adds extra_barcodes to every product row of a list.
async function attachExtras(db, products) {
    const byProduct = await loadExtras(db, products.map((product) => Number(product.id)));
    for (const product of products) product.extra_barcodes = byProduct.get(Number(product.id)) || [];
    return products;
}

// Replaces the extras of a product (the caller's transaction holds the product row).
async function replaceExtras(conn, productId, codes) {
    await conn.query('DELETE FROM product_barcodes WHERE product_id = ?', [productId]);
    if (codes.length) {
        await conn.query('INSERT INTO product_barcodes (product_id, barcode) VALUES ?', [codes.map((code) => [productId, code])]);
    }
}

module.exports = {
    MAX_BARCODE_LENGTH, MAX_EXTRA_BARCODES, OWNER_IDS_SQL, EXTRA_OWNER_IDS_SQL,
    normalizeMainBarcode, normalizeExtraBarcodes, assertDistinct, assertFree, asBarcodeConflict,
    loadExtras, attachExtras, replaceExtras, takenCodes,
};
