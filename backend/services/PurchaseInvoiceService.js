'use strict';

// Purchase invoices: suppliers, drafts, and the post / reverse of stock.
//
// An invoice is a stock_documents row (doc_type 'purchase') with stock_document_lines; stock counts
// share the same two tables. An invoice holds products or ingredients, never both: its item_kind says
// which, is chosen when it is created and never changes. Which items a line may name is decided by
// StockDocumentItems for that kind, and the stock effects live in StockDocumentPosting, which goes
// through the service that already owns each kind of stock (see its header). Lock order matches the
// sale path: document row, then products, product_stock_links, ingredients, stock_items, stock_balances
// (each sorted by id), all before the first stock write, in one short transaction with a short lock wait.

const { getConnection: getStockConnection } = require('./StockReportInvalidation');
const { appendAuditEvent } = require('./auditEvents');
const items = require('./StockDocumentItems');
const posting = require('./StockDocumentPosting');
const { taxRegistrationTypeFromSettings } = require('../config/taxRegistration');
const { getBusinessDate } = require('../utils/businessDate');

const MAX_LINES = 200;
const LOCK_WAIT_SECONDS = 3;
const TAX_RATES = [0, 4, 16];
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const PurchaseError = items.StockDocumentError;
const fail = (statusCode, code, message) => { throw new PurchaseError(statusCode, code, message); };

// ---------- exact decimal helpers (BigInt, no float money) ----------

const pow10 = (n) => 10n ** BigInt(n);

// Non-negative decimal with at most `scale` fraction digits, as a scaled BigInt.
function parseDecimal(value, scale, { code, label, max, positive = false }) {
    if (typeof value !== 'string' && typeof value !== 'number') fail(400, code, `${label} is required.`);
    const text = String(value).trim();
    const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(text);
    if (!match) fail(400, code, `${label} must be a plain number.`);
    const fraction = match[2] || '';
    if (fraction.length > scale) fail(400, code, `${label} allows at most ${scale} decimal places.`);
    const units = BigInt(match[1]) * pow10(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
    if (positive && units <= 0n) fail(400, code, `${label} must be greater than zero.`);
    if (units > BigInt(max) * pow10(scale)) fail(400, code, `${label} is too large.`);
    return units;
}

function format(units, scale) {
    const text = units.toString().padStart(scale + 1, '0');
    return scale ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text;
}

const divRound = (numerator, denominator) => (numerator + denominator / 2n) / denominator;

// qty (1e-3) x price (1e-4) -> JD (1e-3), half up.
const lineSubtotal = (qty, price) => divRound(qty * price, 10000n);
// milli-JD x whole percent, half up.
const lineTax = (subtotal, rate) => divRound(subtotal * BigInt(rate), 100n);
// qty (1e-3) x factor (1e-6) -> base units (1e-6), half up.
const baseQuantity = (qty, factor) => divRound(qty * factor, 1000n);

// ---------- input normalization ----------

function text(value, max, { code, label, required = false }) {
    const out = value == null ? '' : String(value).trim();
    if (required && !out) fail(400, code, `${label} is required.`);
    if ([...out].length > max) fail(400, code, `${label} must be at most ${max} characters.`);
    return out || null;
}

function positiveId(value, code, label) {
    const out = Number(value);
    if (!Number.isSafeInteger(out) || out <= 0 || String(value).trim() === '') fail(400, code, `${label} is invalid.`);
    return out;
}

function exactDate(value, code, label) {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) fail(400, code, `${label} must be YYYY-MM-DD.`);
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(400, code, `${label} is not a real date.`);
    return value;
}

// 'product' or 'ingredient': what the invoice holds. The item rules for it are StockDocumentItems' use '<kind>_purchase'.
function purchaseKind(value) {
    if (value !== 'product' && value !== 'ingredient') fail(400, 'PURCHASE_REQUEST_INVALID', 'kind is invalid.');
    return value;
}

const useOf = (kind) => `${kind}_purchase`;

function requestKey(value, label) {
    if (typeof value !== 'string' || !KEY_PATTERN.test(value)) fail(400, 'PURCHASE_REQUEST_INVALID', `${label} must be 8 to 64 letters, digits, dash or underscore.`);
    return value;
}

function expectedVersion(value) {
    const out = Number(value);
    if (!Number.isSafeInteger(out) || out <= 0) fail(400, 'PURCHASE_REQUEST_INVALID', 'expected_version is required.');
    return out;
}

function normalizeLines(input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_LINES) {
        fail(400, 'PURCHASE_INVOICE_LINES_INVALID', `An invoice needs between 1 and ${MAX_LINES} lines.`);
    }
    const seen = new Set();
    return input.map((raw, index) => {
        const code = 'PURCHASE_INVOICE_LINES_INVALID';
        const at = `Line ${index + 1}`;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, code, `${at} is invalid.`);
        const item = items.parseKey(raw.item_key);
        if (!item) fail(400, code, `${at}: stock item is invalid.`);
        if (seen.has(raw.item_key)) fail(400, code, `${at}: the same item can appear only once per invoice.`);
        seen.add(raw.item_key);
        const qty = parseDecimal(raw.qty, 3, { code, label: `${at} quantity`, max: 9999999, positive: true });
        const factor = parseDecimal(raw.unit_factor, 6, { code, label: `${at} unit factor`, max: 9999999, positive: true });
        const price = parseDecimal(raw.unit_price, 4, { code, label: `${at} unit price`, max: 9999999 });
        const rate = Number(raw.tax_rate);
        if (raw.tax_rate == null || String(raw.tax_rate).trim() === '' || !TAX_RATES.includes(rate)) {
            fail(400, code, `${at}: tax rate must be 0, 4 or 16.`);
        }
        const unitLabel = text(raw.unit_label, 40, { code, label: `${at} unit`, required: true });
        // Free goods on the line, in base units: received with it without changing what was paid.
        const bonus = raw.bonus_qty == null || String(raw.bonus_qty).trim() === ''
            ? 0n : parseDecimal(raw.bonus_qty, 3, { code, label: `${at} bonus`, max: 9999999 });
        if (baseQuantity(qty, factor) <= 0n) fail(400, code, `${at}: quantity is too small for its unit.`);
        if (baseQuantity(qty, factor) + bonus * 1000n > 9999999999999999n) fail(400, code, `${at}: quantity is too large.`);
        const subtotal = lineSubtotal(qty, price);
        const tax = lineTax(subtotal, rate);
        return {
            line_no: index + 1,
            item_key: raw.item_key,
            product_id: item.kind === 'product' ? item.id : null,
            ingredient_id: item.kind === 'ingredient' ? item.id : null,
            qty: format(qty, 3),
            bonus_qty: format(bonus, 3),
            unit_label: unitLabel,
            unit_factor: format(factor, 6),
            unit_price: format(price, 4),
            tax_rate: rate,
            line_subtotal: format(subtotal, 3),
            line_tax: format(tax, 3),
            line_total: format(subtotal + tax, 3),
            _subtotal: subtotal,
            _tax: tax,
        };
    });
}

function normalizeHeader(body) {
    const code = 'PURCHASE_INVOICE_INVALID';
    const payment = body.payment_status == null ? 'credit' : body.payment_status;
    if (!['paid', 'credit'].includes(payment)) fail(400, code, 'payment_status must be paid or credit.');
    const header = {
        supplier_id: positiveId(body.supplier_id, code, 'Supplier'),
        supplier_invoice_no: text(body.supplier_invoice_no, 60, { code, label: 'Supplier invoice number', required: true }),
        invoice_date: exactDate(body.invoice_date, code, 'Invoice date'),
        payment_status: payment,
        paper_total: body.paper_total == null || body.paper_total === ''
            ? null : format(parseDecimal(body.paper_total, 3, { code, label: 'Total on paper', max: 99999999999 }), 3),
        notes: text(body.notes, 255, { code, label: 'Notes' }),
    };
    const lines = normalizeLines(body.lines);
    const subtotal = lines.reduce((sum, line) => sum + line._subtotal, 0n);
    const tax = lines.reduce((sum, line) => sum + line._tax, 0n);
    if (subtotal + tax > 99999999999999n) fail(400, 'PURCHASE_INVOICE_LINES_INVALID', 'The invoice total is too large.');
    return { ...header, lines, subtotal: format(subtotal, 3), tax_total: format(tax, 3), total: format(subtotal + tax, 3) };
}

// ---------- shaping ----------

const money = (value) => (value == null ? null : Number(value));

// The previous posted price for this item from this supplier, with the buying unit it was for.
const lastFields = (last) => ({
    last_unit_price_before: last ? Number(last.unit_price) : null,
    last_unit_factor_before: last ? Number(last.unit_factor) : null,
    last_unit_label_before: last ? last.unit_label : null,
});

function shapeLine(row, lastBefore) {
    return {
        line_no: Number(row.line_no),
        item_key: row.item_key,
        kind: row.product_id != null ? 'product' : 'ingredient',
        product_id: row.product_id == null ? null : Number(row.product_id),
        ingredient_id: row.ingredient_id == null ? null : Number(row.ingredient_id),
        name: row.name,
        base_unit: row.base_unit,
        qty: Number(row.qty),
        bonus_qty: Number(row.bonus_qty || 0),
        unit_label: row.unit_label,
        unit_factor: Number(row.unit_factor),
        unit_price: Number(row.unit_price),
        tax_rate: Number(row.tax_rate),
        line_subtotal: Number(row.line_subtotal),
        line_tax: Number(row.line_tax),
        line_total: Number(row.line_total),
        // Receiving this product now would start tracking it (its stock is unlimited today).
        starts_tracking: Number(row.starts_tracking) === 1,
        ...lastFields(lastBefore.get(row.item_key)),
    };
}

function shapeHeader(row) {
    return {
        id: Number(row.id),
        item_kind: row.item_kind,
        supplier_id: Number(row.supplier_id),
        supplier_name: row.supplier_name,
        supplier_invoice_no: row.supplier_invoice_no,
        invoice_date: row.invoice_day,
        status: row.status,
        payment_status: row.payment_status,
        subtotal: money(row.subtotal),
        tax_total: money(row.tax_total),
        total: money(row.total),
        paper_total: money(row.paper_total),
        notes: row.notes,
        cost_includes_tax: row.cost_includes_tax == null ? null : Number(row.cost_includes_tax) === 1,
        version: Number(row.version),
        created_at: row.created_at,
        updated_at: row.updated_at,
        posted_at: row.posted_at,
        reversed_at: row.reversed_at,
    };
}

const { itemKeySql, itemFilter } = items;

// The most recent posted price per item from one supplier, strictly before
// `before` when given (an invoice already posted), else the latest overall.
async function previousPrices(db, { supplierId, itemKeys, before }) {
    if (!itemKeys.length) return new Map();
    const filter = itemFilter('l', itemKeys);
    const params = [...filter.params, supplierId];
    let bound = '';
    if (before) {
        bound = 'AND (d.doc_date < ? OR (d.doc_date = ? AND d.id < ?))';
        params.push(before.date, before.date, before.id);
    }
    const [rows] = await db.query(
        `SELECT item_key, unit_price, unit_factor, unit_label FROM (
            SELECT ${itemKeySql('l')} AS item_key, l.unit_price, l.unit_factor, l.unit_label,
                   ROW_NUMBER() OVER (PARTITION BY ${itemKeySql('l')} ORDER BY d.doc_date DESC, d.id DESC) AS rn
              FROM stock_document_lines l
              JOIN stock_documents d ON d.id = l.document_id
             WHERE ${filter.sql} AND d.doc_type = 'purchase' AND d.status = 'posted' AND d.supplier_id = ? ${bound}) ranked
          WHERE rn = 1`, params);
    return new Map(rows.map((row) => [row.item_key, row]));
}

// Header fields keep the names the screens already use (supplier_invoice_no, invoice_date).
const HEADER_SELECT = `SELECT d.id, d.item_kind, d.supplier_id, d.reference AS supplier_invoice_no, DATE_FORMAT(d.doc_date, '%Y-%m-%d') AS invoice_day,
           d.status, d.payment_status, d.subtotal, d.tax_total, d.total, d.paper_total, d.notes, d.cost_includes_tax, d.version,
           d.post_key, d.reverse_key, d.created_at, d.updated_at, d.posted_at, d.reversed_at, s.name AS supplier_name
    FROM stock_documents d JOIN purchase_suppliers s ON s.id = d.supplier_id`;

const LINE_SELECT = `SELECT l.*, ${itemKeySql('l')} AS item_key, COALESCE(p.name, i.name) AS name,
           (p.id IS NOT NULL AND p.stock IS NULL AND NOT EXISTS (SELECT 1 FROM product_stock_links k WHERE k.product_id = p.id)) AS starts_tracking,
           CASE WHEN l.product_id IS NOT NULL THEN 'unit'
                ELSE CASE i.measure WHEN 'weight' THEN 'g' WHEN 'volume' THEN 'ml' ELSE 'unit' END END AS base_unit
    FROM stock_document_lines l
    LEFT JOIN products p ON p.id = l.product_id
    LEFT JOIN ingredients i ON i.id = l.ingredient_id`;

async function loadInvoice(db, id) {
    const [[header]] = await db.query(`${HEADER_SELECT} WHERE d.id = ? AND d.doc_type = 'purchase'`, [id]);
    if (!header) return null;
    const [lines] = await db.query(`${LINE_SELECT} WHERE l.document_id = ? ORDER BY l.line_no`, [id]);
    const before = header.status === 'draft' ? null : { date: header.invoice_day, id: header.id };
    const last = await previousPrices(db, { supplierId: header.supplier_id, itemKeys: lines.map((row) => row.item_key), before });
    return { ...shapeHeader(header), lines: lines.map((row) => shapeLine(row, last)) };
}

// ---------- suppliers ----------

const SUPPLIER_COLUMNS = 'id, name, phone, tax_number, notes, is_active';
const shapeSupplier = (row) => ({ ...row, id: Number(row.id), is_active: Number(row.is_active) === 1 });

function supplierFields(body) {
    const code = 'PURCHASE_SUPPLIER_INVALID';
    return {
        name: text(body.name, 120, { code, label: 'Supplier name', required: true }),
        phone: text(body.phone, 40, { code, label: 'Phone' }),
        tax_number: text(body.tax_number, 40, { code, label: 'Tax number' }),
        notes: text(body.notes, 255, { code, label: 'Notes' }),
    };
}

const duplicateSupplier = () => fail(409, 'PURCHASE_SUPPLIER_DUPLICATE', 'A supplier with this name already exists.');

async function listSuppliers(pool, { activeOnly }) {
    const [rows] = await pool.query(
        `SELECT ${SUPPLIER_COLUMNS} FROM purchase_suppliers ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY name, id LIMIT 500`);
    return rows.map(shapeSupplier);
}

async function createSupplier(pool, body) {
    const fields = supplierFields(body);
    try {
        const [result] = await pool.query(
            'INSERT INTO purchase_suppliers (name, phone, tax_number, notes) VALUES (?, ?, ?, ?)',
            [fields.name, fields.phone, fields.tax_number, fields.notes]);
        const [[row]] = await pool.query(`SELECT ${SUPPLIER_COLUMNS} FROM purchase_suppliers WHERE id = ?`, [result.insertId]);
        return shapeSupplier(row);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') duplicateSupplier();
        throw error;
    }
}

async function updateSupplier(pool, id, body) {
    const fields = supplierFields(body);
    const active = body.is_active == null ? null : ([true, 1, '1'].includes(body.is_active) ? 1 : ([false, 0, '0'].includes(body.is_active) ? 0 : fail(400, 'PURCHASE_SUPPLIER_INVALID', 'is_active is invalid.')));
    try {
        const [result] = await pool.query(
            'UPDATE purchase_suppliers SET name = ?, phone = ?, tax_number = ?, notes = ?, is_active = COALESCE(?, is_active) WHERE id = ?',
            [fields.name, fields.phone, fields.tax_number, fields.notes, active, id]);
        if (!result.affectedRows) {
            const [[exists]] = await pool.query('SELECT id FROM purchase_suppliers WHERE id = ?', [id]);
            if (!exists) fail(404, 'PURCHASE_SUPPLIER_NOT_FOUND', 'Supplier not found.');
        }
        const [[row]] = await pool.query(`SELECT ${SUPPLIER_COLUMNS} FROM purchase_suppliers WHERE id = ?`, [id]);
        return shapeSupplier(row);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') duplicateSupplier();
        throw error;
    }
}

// ---------- item search ----------

const likeEscape = items.likeEscape;

async function searchItems(pool, { q, supplierId, categoryId, barcode, limit, kind }) {
    const found = await items.searchItems(pool, { q, categoryId, barcode, limit, use: useOf(kind) });
    if (!found.length) return [];
    const keys = found.map((row) => row.item_key);
    const filter = itemFilter('l', keys);
    const lastParams = [...filter.params];
    if (supplierId) lastParams.push(supplierId);
    const [lastRows] = await pool.query(
        `SELECT item_key, unit_label, unit_factor, unit_price, tax_rate, invoice_day FROM (
            SELECT ${itemKeySql('l')} AS item_key, l.unit_label, l.unit_factor, l.unit_price, l.tax_rate,
                   DATE_FORMAT(d.doc_date, '%Y-%m-%d') AS invoice_day,
                   ROW_NUMBER() OVER (PARTITION BY ${itemKeySql('l')} ORDER BY d.doc_date DESC, d.id DESC) AS rn
              FROM stock_document_lines l
              JOIN stock_documents d ON d.id = l.document_id
             WHERE ${filter.sql} AND d.doc_type = 'purchase' AND d.status = 'posted' ${supplierId ? 'AND d.supplier_id = ?' : ''}) ranked
          WHERE rn = 1`, lastParams);
    const recent = await items.recentPacks(pool, keys);
    const last = new Map(lastRows.map((row) => [row.item_key, {
        unit_label: row.unit_label, unit_factor: Number(row.unit_factor), unit_price: Number(row.unit_price),
        tax_rate: Number(row.tax_rate), invoice_date: row.invoice_day,
    }]));
    return found.map((row) => {
        const packs = [{ label: row.base_unit, factor: 1 }];
        if (row.pack_name && Number(row.pack_size) > 0) packs.push({ label: row.pack_name, factor: Number(row.pack_size) });
        for (const pack of recent.get(row.item_key) || []) {
            if (!packs.some((known) => known.label.toLowerCase() === pack.label.toLowerCase() && known.factor === pack.factor)) packs.push(pack);
        }
        return {
            item_key: row.item_key,
            name: row.name,
            kind: row.kind,
            measure: row.measure,
            base_unit: row.base_unit,
            category_id: row.category_id,
            category_name: row.category_name,
            barcode: row.barcode,
            matched_barcode: row.matched_barcode,
            starts_tracking: row.starts_tracking,
            packs,
            last: last.get(row.item_key) ?? null,
        };
    });
}

// Purchase history for the lines being entered, from posted invoices only: the latest price from any
// supplier, the latest from `supplierId`, the quantity-weighted average price before tax, and the
// current quantity. Prices are per base unit so lines bought in different packs compare directly.
async function itemInsights(pool, { kind, itemKeys, supplierId }) {
    const keys = [...new Set(itemKeys)].filter((key) => items.parseKey(key)?.kind === kind).slice(0, MAX_LINES);
    if (!keys.length) return [];
    const filter = itemFilter('l', keys);
    const latest = async (bySupplier) => {
        const params = bySupplier ? [...filter.params, supplierId] : filter.params;
        const [rows] = await pool.query(
            `SELECT item_key, unit_price, unit_factor, unit_label, invoice_day, supplier_id, supplier_name, reference FROM (
                SELECT ${itemKeySql('l')} AS item_key, l.unit_price, l.unit_factor, l.unit_label,
                       DATE_FORMAT(d.doc_date, '%Y-%m-%d') AS invoice_day, d.supplier_id, s.name AS supplier_name, d.reference,
                       ROW_NUMBER() OVER (PARTITION BY ${itemKeySql('l')} ORDER BY d.doc_date DESC, d.id DESC) AS rn
                  FROM stock_document_lines l
                  JOIN stock_documents d ON d.id = l.document_id
                  JOIN purchase_suppliers s ON s.id = d.supplier_id
                 WHERE ${filter.sql} AND d.doc_type = 'purchase' AND d.status = 'posted'
                   AND l.unit_price IS NOT NULL AND l.unit_factor > 0 ${bySupplier ? 'AND d.supplier_id = ?' : ''}) ranked
              WHERE rn = 1`, params);
        return new Map(rows.map((row) => [row.item_key, {
            unit_price: Number(row.unit_price),
            unit_factor: Number(row.unit_factor),
            unit_label: row.unit_label,
            base_price: Number(row.unit_price) / Number(row.unit_factor),
            invoice_date: row.invoice_day,
            supplier_id: Number(row.supplier_id),
            supplier_name: row.supplier_name,
            reference: row.reference,
        }]));
    };
    const [anySupplier, sameSupplier, [averages], quantities] = await Promise.all([
        latest(false),
        supplierId ? latest(true) : new Map(),
        pool.query(
            `SELECT ${itemKeySql('l')} AS item_key, SUM(l.line_subtotal) AS amount, SUM(l.qty * l.unit_factor + l.bonus_qty) AS base_qty
               FROM stock_document_lines l
               JOIN stock_documents d ON d.id = l.document_id
              WHERE ${filter.sql} AND d.doc_type = 'purchase' AND d.status = 'posted' AND l.unit_price IS NOT NULL AND l.qty > 0
              GROUP BY ${itemKeySql('l')}`, filter.params),
        items.readQuantities(pool, keys),
    ]);
    const average = new Map(averages.filter((row) => Number(row.base_qty) > 0)
        .map((row) => [row.item_key, Number(row.amount) / Number(row.base_qty)]));
    return keys.map((key) => {
        const quantity = quantities.get(key);
        return {
            item_key: key,
            last: anySupplier.get(key) ?? null,
            supplier_last: sameSupplier.get(key) ?? null,
            average_base_price: average.get(key) ?? null,
            on_hand: quantity?.known && quantity.quantity != null ? Number(quantity.quantity) : null,
        };
    });
}

// Categories of the products a purchase can receive (not the count sheet's tracked-product rule).
async function listCategories(pool) {
    const groups = await items.listGroups(pool, { use: 'product_purchase' });
    return groups.filter((group) => group.kind === 'category')
        .map((group) => ({ id: group.category_id, name: group.label, item_count: group.item_count }));
}

// ---------- invoice list ----------

async function listInvoices(pool, { kind, status, supplierId, q, beforeId, beforeGroup, limit }) {
    const where = ["d.doc_type = 'purchase'", 'd.item_kind = ?'];
    const params = [kind];
    if (supplierId) { where.push('d.supplier_id = ?'); params.push(supplierId); }
    const term = (q || '').trim().slice(0, 100);
    if (term) {
        where.push('(d.reference LIKE ? OR s.name LIKE ?)');
        params.push(`%${likeEscape(term)}%`, `%${likeEscape(term)}%`);
    }
    const select = `SELECT d.id, d.item_kind, d.supplier_id, s.name AS supplier_name, d.reference AS supplier_invoice_no,
            DATE_FORMAT(d.doc_date, '%Y-%m-%d') AS invoice_day, d.status, d.payment_status, d.total, d.updated_at,
            (SELECT COUNT(*) FROM stock_document_lines l WHERE l.document_id = d.id) AS line_count
       FROM stock_documents d JOIN purchase_suppliers s ON s.id = d.supplier_id`;
    const page = async (extra, extraParams, take) => {
        const conditions = [...where, ...extra];
        const [rows] = await pool.query(
            `${select} WHERE ${conditions.join(' AND ')} ORDER BY d.id DESC LIMIT ?`,
            [...params, ...extraParams, take]);
        return rows;
    };
    let rows;
    if (status) {
        rows = await page(['d.status = ?', ...(beforeId ? ['d.id < ?'] : [])], [status, ...(beforeId ? [beforeId] : [])], limit + 1);
    } else {
        // Drafts first, then everything else, each newest first. The cursor names the group it was
        // taken from; a draft posted after the page loaded must not skip the older drafts after it.
        let cursorIsDraft = true;
        if (beforeId && beforeGroup) {
            cursorIsDraft = beforeGroup === 'draft';
        } else if (beforeId) {
            const [[cursor]] = await pool.query("SELECT status FROM stock_documents WHERE id = ? AND doc_type = 'purchase'", [beforeId]);
            cursorIsDraft = !cursor || cursor.status === 'draft';
        }
        rows = [];
        if (cursorIsDraft) {
            rows = await page(["d.status = 'draft'", ...(beforeId ? ['d.id < ?'] : [])], beforeId ? [beforeId] : [], limit + 1);
        }
        if (rows.length < limit + 1) {
            const rest = await page(["d.status <> 'draft'", ...(beforeId && !cursorIsDraft ? ['d.id < ?'] : [])],
                beforeId && !cursorIsDraft ? [beforeId] : [], limit + 1 - rows.length);
            rows = rows.concat(rest);
        }
    }
    const more = rows.length > limit;
    const slice = rows.slice(0, limit);
    return {
        data: slice.map((row) => ({
            id: Number(row.id), item_kind: row.item_kind, supplier_id: Number(row.supplier_id), supplier_name: row.supplier_name,
            supplier_invoice_no: row.supplier_invoice_no, invoice_date: row.invoice_day, status: row.status,
            payment_status: row.payment_status, total: money(row.total), line_count: Number(row.line_count), updated_at: row.updated_at,
        })),
        next_before_id: more ? Number(slice[slice.length - 1].id) : null,
        next_before_group: more && !status ? (slice[slice.length - 1].status === 'draft' ? 'draft' : 'other') : null,
    };
}

async function lastInvoiceForSupplier(pool, supplierId, kind) {
    const [[last]] = await pool.query(
        `SELECT id, reference AS supplier_invoice_no, DATE_FORMAT(doc_date, '%Y-%m-%d') AS invoice_day FROM stock_documents
          WHERE doc_type = 'purchase' AND item_kind = ? AND supplier_id = ? AND status = 'posted' ORDER BY doc_date DESC, id DESC LIMIT 1`, [kind, supplierId]);
    if (!last) return null;
    // Only lines of the requested kind: an invoice from before the split may hold both, and repeating it must
    // give an invoice this side can save.
    const [lines] = await pool.query(
        `${LINE_SELECT} WHERE l.document_id = ? AND l.${kind === 'ingredient' ? 'ingredient_id' : 'product_id'} IS NOT NULL ORDER BY l.line_no`, [last.id]);
    // The price on this invoice is the baseline the repeated invoice is compared with.
    const own = new Map(lines.map((row) => [row.item_key, row]));
    return {
        invoice: { id: Number(last.id), supplier_invoice_no: last.supplier_invoice_no, invoice_date: last.invoice_day },
        lines: lines.map((row) => shapeLine(row, own)),
    };
}

// ---------- draft writes ----------

async function withTransaction(pool, work) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const result = await work(conn);
        await conn.commit();
        return result;
    } catch (error) {
        await conn.rollback().catch(() => {});
        throw error;
    } finally {
        conn.release();
    }
}

// Reads that can be done before BEGIN: the supplier must exist and be active, and every item must be
// eligible for this kind of invoice (an item of the other kind is simply not found).
async function checkReferences(pool, { supplierId, lines, kind, currentSupplierId = null }) {
    const [[supplier]] = await pool.query('SELECT id, is_active FROM purchase_suppliers WHERE id = ?', [supplierId]);
    if (!supplier || (!Number(supplier.is_active) && supplierId !== currentSupplierId)) {
        fail(400, 'PURCHASE_INVOICE_INVALID', 'Choose an active supplier.');
    }
    const found = await items.eligibleKeys(pool, lines.map((line) => line.item_key), { use: useOf(kind) });
    const missing = lines.find((line) => !found.has(line.item_key));
    if (missing) fail(400, 'PURCHASE_ITEM_INVALID', `Line ${missing.line_no}: the item is missing or not active.`);
}

const insertLines = (conn, invoiceId, lines) => conn.query(
    `INSERT INTO stock_document_lines
        (document_id, line_no, product_id, ingredient_id, qty, bonus_qty, unit_label, unit_factor, unit_price, tax_rate, line_subtotal, line_tax, line_total) VALUES ?`,
    [lines.map((line) => [invoiceId, line.line_no, line.product_id, line.ingredient_id, line.qty, line.bonus_qty, line.unit_label, line.unit_factor,
        line.unit_price, line.tax_rate, line.line_subtotal, line.line_tax, line.line_total])]);

function duplicateInvoice() {
    fail(409, 'PURCHASE_INVOICE_DUPLICATE', 'This supplier invoice number is already entered.');
}

async function createDraft(pool, body, actor) {
    const clientKey = requestKey(body.client_key, 'client_key');
    const kind = purchaseKind(body.kind);
    const header = normalizeHeader(body);
    const replay = async (db) => {
        const [[existing]] = await db.query('SELECT id, doc_type, item_kind, supplier_id, reference FROM stock_documents WHERE create_key = ?', [clientKey]);
        if (!existing) return null;
        if (existing.doc_type !== 'purchase' || existing.item_kind !== kind || Number(existing.supplier_id) !== header.supplier_id
            || existing.reference !== header.supplier_invoice_no) {
            fail(409, 'PURCHASE_INVOICE_KEY_REUSED', 'This request key belongs to a different invoice.');
        }
        return { invoice: await loadInvoice(db, existing.id), replay: true };
    };
    const earlier = await replay(pool);
    if (earlier) return earlier;
    await checkReferences(pool, { supplierId: header.supplier_id, lines: header.lines, kind });
    try {
        const id = await withTransaction(pool, async (conn) => {
            const [inserted] = await conn.query(
                `INSERT INTO stock_documents (doc_type, item_kind, supplier_id, reference, doc_date, payment_status, subtotal, tax_total, total,
                        paper_total, notes, create_key, created_by) VALUES ('purchase', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [kind, header.supplier_id, header.supplier_invoice_no, header.invoice_date, header.payment_status, header.subtotal,
                    header.tax_total, header.total, header.paper_total, header.notes, clientKey, actor.id]);
            await insertLines(conn, inserted.insertId, header.lines);
            return inserted.insertId;
        });
        return { invoice: await loadInvoice(pool, id), replay: false };
    } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        // A concurrent retry with the same key won the insert; anything else is the paper invoice entered twice.
        const raced = await replay(pool);
        if (raced) return raced;
        return duplicateInvoice();
    }
}

async function lockDraft(conn, id, version) {
    const [[row]] = await conn.query("SELECT id, status, version, supplier_id FROM stock_documents WHERE id = ? AND doc_type = 'purchase' FOR UPDATE", [id]);
    if (!row) fail(404, 'PURCHASE_INVOICE_NOT_FOUND', 'Purchase invoice not found.');
    if (row.status !== 'draft') fail(409, 'PURCHASE_INVOICE_NOT_DRAFT', 'Only a draft invoice can be changed.');
    if (Number(row.version) !== version) fail(409, 'PURCHASE_INVOICE_STALE', 'This invoice was changed elsewhere. Reload it.');
    return row;
}

async function updateDraft(pool, id, body) {
    const version = expectedVersion(body.expected_version);
    const header = normalizeHeader(body);
    // The invoice keeps the kind it was created with; a kind in the body is ignored.
    const [[current]] = await pool.query("SELECT supplier_id, item_kind FROM stock_documents WHERE id = ? AND doc_type = 'purchase'", [id]);
    if (!current) fail(404, 'PURCHASE_INVOICE_NOT_FOUND', 'Purchase invoice not found.');
    await checkReferences(pool, { supplierId: header.supplier_id, lines: header.lines, kind: current.item_kind, currentSupplierId: Number(current.supplier_id) });
    try {
        await withTransaction(pool, async (conn) => {
            await lockDraft(conn, id, version);
            await conn.query(
                `UPDATE stock_documents SET supplier_id = ?, reference = ?, doc_date = ?, payment_status = ?, subtotal = ?,
                        tax_total = ?, total = ?, paper_total = ?, notes = ?, version = version + 1 WHERE id = ?`,
                [header.supplier_id, header.supplier_invoice_no, header.invoice_date, header.payment_status, header.subtotal,
                    header.tax_total, header.total, header.paper_total, header.notes, id]);
            await conn.query('DELETE FROM stock_document_lines WHERE document_id = ?', [id]);
            await insertLines(conn, id, header.lines);
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') duplicateInvoice();
        throw error;
    }
    return loadInvoice(pool, id);
}

async function deleteDraft(pool, id, body, actor, ipAddress) {
    const version = expectedVersion(body.expected_version);
    await withTransaction(pool, async (conn) => {
        const row = await lockDraft(conn, id, version);
        await conn.query('DELETE FROM stock_documents WHERE id = ?', [id]);
        await appendAuditEvent(conn, {
            eventType: 'purchase_invoice_deleted', userId: actor.id, entityType: 'purchase_invoice', entityId: id,
            oldValue: { supplier_id: Number(row.supplier_id), status: 'draft' }, ipAddress: ipAddress || null,
        });
    });
    return { id };
}

async function getInvoice(pool, id) {
    const invoice = await loadInvoice(pool, id);
    if (!invoice) fail(404, 'PURCHASE_INVOICE_NOT_FOUND', 'Purchase invoice not found.');
    return invoice;
}

// ---------- posting ----------

// One connection with a short lock wait: a posting gives up rather than make a sale wait.
async function withPostingConnection(pool, work) {
    const conn = await getStockConnection(pool);
    let restore = false;
    try {
        await conn.query('SET @purchase_previous_lock_wait = @@SESSION.innodb_lock_wait_timeout, SESSION innodb_lock_wait_timeout = ?', [LOCK_WAIT_SECONDS]);
        restore = true;
        await conn.beginTransaction();
        try {
            const result = await work(conn);
            await conn.commit();
            return result;
        } catch (error) {
            await conn.rollback().catch(() => {});
            if (error.code === 'ER_LOCK_WAIT_TIMEOUT' || error.code === 'ER_LOCK_DEADLOCK') {
                fail(409, 'PURCHASE_INVOICE_BUSY', 'Stock is busy right now. Nothing was posted; try again.');
            }
            throw error;
        }
    } finally {
        if (restore) {
            try { await conn.query('SET SESSION innodb_lock_wait_timeout = @purchase_previous_lock_wait'); }
            catch { conn.destroy(); }
        }
        conn.release();
    }
}

async function readPostingSource(pool, id) {
    const [[header]] = await pool.query(`${HEADER_SELECT} WHERE d.id = ? AND d.doc_type = 'purchase'`, [id]);
    if (!header) fail(404, 'PURCHASE_INVOICE_NOT_FOUND', 'Purchase invoice not found.');
    const [lines] = await pool.query(
        `SELECT l.line_no, ${itemKeySql('l')} AS item_key, l.qty, CAST(l.bonus_qty AS CHAR) AS bonus_qty, l.unit_factor, l.line_subtotal, l.line_total
           FROM stock_document_lines l WHERE l.document_id = ? ORDER BY l.line_no`, [id]);
    return { header, lines };
}

// Base quantities (bought plus bonus) and cost per base unit for each line, exactly.
function planLines(lines, costIncludesTax) {
    return lines.map((line) => {
        const qty = parseDecimal(line.qty, 3, { code: 'PURCHASE_INVOICE_LINES_INVALID', label: 'Quantity', max: 9999999, positive: true });
        const factor = parseDecimal(line.unit_factor, 6, { code: 'PURCHASE_INVOICE_LINES_INVALID', label: 'Unit factor', max: 9999999, positive: true });
        const bonus = parseDecimal(line.bonus_qty ?? '0', 6, { code: 'PURCHASE_INVOICE_LINES_INVALID', label: 'Bonus', max: 9999999999 });
        const base = baseQuantity(qty, factor) + bonus;
        const amount = parseDecimal(costIncludesTax ? line.line_total : line.line_subtotal, 3, { code: 'PURCHASE_INVOICE_LINES_INVALID', label: 'Amount', max: 99999999999 });
        // Zero-priced goods carry no price: they must not drag the purchase-average estimate to zero.
        const cost = amount === 0n ? null : format(divRound(amount * 1000n * pow10(8), base), 8);
        return { line_no: Number(line.line_no), item_key: line.item_key, base_qty: format(base, 6), cost };
    });
}

async function postInvoice(pool, { id, body, actor, ipAddress }) {
    const version = expectedVersion(body.expected_version);
    const key = requestKey(body.request_key, 'request_key');
    const source = await readPostingSource(pool, id);
    const replayed = async (db) => ({ invoice: await loadInvoice(db, id), replay: true, scope: null });
    if (['posted', 'reversed'].includes(source.header.status) && source.header.post_key === key) return replayed(pool);
    if (source.header.status !== 'draft') fail(409, 'PURCHASE_INVOICE_NOT_DRAFT', 'Only a draft invoice can be posted.');
    if (Number(source.header.version) !== version) fail(409, 'PURCHASE_INVOICE_STALE', 'This invoice was changed elsewhere. Reload it.');
    const [[setting]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'tax_registration_type'");
    const costIncludesTax = taxRegistrationTypeFromSettings({ tax_registration_type: setting?.setting_value }) !== 'sales_tax';
    const plan = planLines(source.lines, costIncludesTax);
    const businessDate = getBusinessDate();
    return withPostingConnection(pool, async (conn) => {
        const [[locked]] = await conn.query("SELECT id, status, version, post_key FROM stock_documents WHERE id = ? AND doc_type = 'purchase' FOR UPDATE", [id]);
        if (['posted', 'reversed'].includes(locked.status) && locked.post_key === key) return replayed(conn);
        if (locked.status !== 'draft') fail(409, 'PURCHASE_INVOICE_NOT_DRAFT', 'Only a draft invoice can be posted.');
        if (Number(locked.version) !== version) fail(409, 'PURCHASE_INVOICE_STALE', 'This invoice was changed elsewhere. Reload it.');
        const held = await items.resolveForUpdate(conn, plan.map((line) => line.item_key), { use: useOf(source.header.item_kind) });
        const stockResult = await posting.receive(conn, { documentId: id, lines: plan, locked: held, actor, businessDate, postKey: key });
        try {
            await conn.query(
                `UPDATE stock_documents SET status = 'posted', posted_by = ?, posted_at = CURRENT_TIMESTAMP, cost_includes_tax = ?,
                        post_key = ?, stock_result = ?, version = version + 1 WHERE id = ?`,
                [actor.id, costIncludesTax ? 1 : 0, key, JSON.stringify(stockResult), id]);
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') fail(409, 'PURCHASE_INVOICE_KEY_REUSED', 'This request key belongs to a different invoice.');
            throw error;
        }
        await appendAuditEvent(conn, {
            eventType: 'purchase_invoice_posted', userId: actor.id, entityType: 'purchase_invoice', entityId: id,
            newValue: { supplier_id: Number(source.header.supplier_id), supplier_invoice_no: source.header.supplier_invoice_no,
                total: money(source.header.total), lines: plan.length, cost_includes_tax: costIncludesTax, request_key: key },
            ipAddress: ipAddress || null,
        });
        return { invoice: await loadInvoice(conn, id), replay: false, scope: posting.eventScope(held) };
    });
}

async function reverseInvoice(pool, { id, body, actor, ipAddress }) {
    const key = requestKey(body.request_key, 'request_key');
    const source = await readPostingSource(pool, id);
    const replayed = async (db) => ({ invoice: await loadInvoice(db, id), replay: true, scope: null });
    if (source.header.status === 'reversed' && source.header.reverse_key === key) return replayed(pool);
    if (source.header.status !== 'posted') fail(409, 'PURCHASE_INVOICE_NOT_POSTED', 'Only a posted invoice can be reversed, once.');
    const plan = planLines(source.lines, Number(source.header.cost_includes_tax) === 1);
    const businessDate = getBusinessDate();
    return withPostingConnection(pool, async (conn) => {
        const [[locked]] = await conn.query("SELECT id, status, reverse_key, stock_result FROM stock_documents WHERE id = ? AND doc_type = 'purchase' FOR UPDATE", [id]);
        if (locked.status === 'reversed' && locked.reverse_key === key) return replayed(conn);
        if (locked.status !== 'posted') fail(409, 'PURCHASE_INVOICE_NOT_POSTED', 'Only a posted invoice can be reversed, once.');
        const posted = typeof locked.stock_result === 'string' ? JSON.parse(locked.stock_result) : locked.stock_result;
        const held = await items.resolveForUpdate(conn, plan.map((line) => line.item_key), { reversal: true });
        let reversal;
        try {
            reversal = await posting.reverseReceive(conn, { documentId: id, lines: plan, locked: held, posted, actor, businessDate, reverseKey: key });
        } catch (error) {
            // A strict stock item cannot go below what is on hand; the ledger says so with a 409.
            if (error.statusCode === 409 && !error.code) fail(409, 'PURCHASE_INVOICE_REVERSE_BLOCKED', error.message);
            throw error;
        }
        try {
            await conn.query(
                `UPDATE stock_documents SET status = 'reversed', reversed_by = ?, reversed_at = CURRENT_TIMESTAMP, reverse_key = ?,
                        stock_result = ?, version = version + 1 WHERE id = ?`,
                [actor.id, key, JSON.stringify({ ...posted, reversal }), id]);
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') fail(409, 'PURCHASE_INVOICE_KEY_REUSED', 'This request key belongs to a different invoice.');
            throw error;
        }
        await appendAuditEvent(conn, {
            eventType: 'purchase_invoice_reversed', userId: actor.id, entityType: 'purchase_invoice', entityId: id,
            newValue: { supplier_id: Number(source.header.supplier_id), supplier_invoice_no: source.header.supplier_invoice_no,
                total: money(source.header.total), request_key: key },
            ipAddress: ipAddress || null,
        });
        return { invoice: await loadInvoice(conn, id), replay: false, scope: posting.eventScope(held) };
    });
}

module.exports = {
    PurchaseError, purchaseKind, listSuppliers, createSupplier, updateSupplier, searchItems, itemInsights, listCategories, listInvoices,
    lastInvoiceForSupplier, getInvoice, createDraft, updateDraft, deleteDraft, postInvoice, reverseInvoice,
    // exported for tests
    lineSubtotal, lineTax, baseQuantity,
};
