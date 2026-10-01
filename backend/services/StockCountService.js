'use strict';

// Stock counts (جرد): a stock_documents row with doc_type 'count' and one line per item on the sheet.
//
// The rule that keeps a count honest while the venue keeps selling: when a quantity is saved the line
// records expected_qty, the item's CURRENT quantity at that moment. Posting runs under the stock locks
// and sets each balance to  counted + (current now - expected),  so everything that happened after the
// person counted still applies. Variance is  counted - expected.  When the balance was unknown at
// counting time (expected_qty NULL) the balance becomes the counted quantity and there is no variance.
// A result below zero posts 0 and is flagged `clamped` in stock_result.
//
// The count is blind while it is a draft: expected_qty (and anything derived from it) is only sent by the
// review endpoint and on a posted count.
//
// Which items may be counted is StockDocumentItems' decision; the stock effects are StockDocumentPosting.count.
// Lock order is the sale path's (see StockDocumentItems.resolveForUpdate), taken after the document row,
// all in one short transaction with a short lock wait.

const { createHash } = require('node:crypto');
const { getConnection: getStockConnection } = require('./StockReportInvalidation');
const { appendAuditEvent } = require('./auditEvents');
const items = require('./StockDocumentItems');
const posting = require('./StockDocumentPosting');
const { getBusinessDate } = require('../utils/businessDate');

const MAX_SAVE_LINES = 100;
const LOCK_WAIT_SECONDS = 3;
const INSERT_CHUNK = 250;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_VALUE = 99999999999999n; // DECIMAL(14,3) in 1e-3 units
const abs = (n) => (n < 0n ? -n : n);
const tooLarge = () => fail(400, 'STOCK_COUNT_VALUE_TOO_LARGE', 'A difference value is too large to record. Check the quantities and unit costs.');
const MAX_STOCK = 9999999999999999n; // DECIMAL(16,6) in 1e-6 units, the same cap the stock writers use
const DISPLAY_FACTOR = { g: 1, kg: 1000, ml: 1, l: 1000, unit: 1 };

const CountError = items.StockDocumentError;
const fail = (statusCode, code, message, data) => {
    const error = new CountError(statusCode, code, message);
    if (data) error.data = data;
    throw error;
};

// ---------- exact decimals (scaled BigInt, never float) ----------

const pow10 = (n) => 10n ** BigInt(n);
const divRound = (numerator, denominator) => (numerator + denominator / 2n) / denominator;
// Half away from zero, so a shortage and the same surplus round to mirrored values.
const roundDiv = (numerator, denominator) => (numerator < 0n ? -divRound(-numerator, denominator) : divRound(numerator, denominator));

function format(units, scale) {
    const negative = units < 0n;
    const text = (negative ? -units : units).toString().padStart(scale + 1, '0');
    return `${negative ? '-' : ''}${scale ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text}`;
}

// A decimal read back from the database (or a number from a driver) as a scaled BigInt.
function scaled(value, scale) {
    const text = String(value).trim();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new TypeError(`Invalid decimal ${text}`);
    const fraction = (match[3] || '').slice(0, scale).padEnd(scale, '0');
    const units = BigInt(match[2]) * pow10(scale) + BigInt(fraction || '0');
    return match[1] ? -units : units;
}

// Trailing zeros off, but never fewer than `min` decimals ("12.000000" -> "12.000").
function trim(value, min = 0) {
    const text = String(value);
    if (!text.includes('.')) return min ? `${text}.${'0'.repeat(min)}` : text;
    const [whole, fraction] = text.split('.');
    let kept = fraction.replace(/0+$/, '');
    if (kept.length < min) kept = kept.padEnd(min, '0');
    return kept ? `${whole}.${kept}` : whole;
}

// Input: a plain non-negative number with at most `scale` decimals.
function parseInput(value, scale, { code, label, max, positive = false }) {
    if (typeof value !== 'string' && typeof value !== 'number') fail(400, code, `${label} is required.`);
    const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(String(value).trim());
    if (!match) fail(400, code, `${label} must be a plain number.`);
    if ((match[2] || '').length > scale) fail(400, code, `${label} allows at most ${scale} decimal places.`);
    const units = scaled(`${match[1]}.${match[2] || '0'}`, scale);
    if (positive && units <= 0n) fail(400, code, `${label} must be greater than zero.`);
    if (units > BigInt(max) * pow10(scale)) fail(400, code, `${label} is too large.`);
    return units;
}

// qty (1e-3) x factor (1e-6) -> base units (1e-6), half up.
const baseQuantity = (qty, factor) => divRound(qty * factor, 1000n);

// ---------- input ----------

function requestKey(value, label) {
    if (typeof value !== 'string' || !KEY_PATTERN.test(value)) fail(400, 'STOCK_COUNT_INVALID', `${label} must be 8 to 64 letters, digits, dash or underscore.`);
    return value;
}

function text(value, max, label) {
    const out = value == null ? '' : String(value).trim();
    if ([...out].length > max) fail(400, 'STOCK_COUNT_INVALID', `${label} must be at most ${max} characters.`);
    return out || null;
}

function exactDate(value) {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) fail(400, 'STOCK_COUNT_INVALID', 'Count date must be YYYY-MM-DD.');
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(400, 'STOCK_COUNT_INVALID', 'Count date is not a real date.');
    return value;
}

// A count's movements are stamped with the business date it posts on, so its date is that day: optional,
// and when given it must be today's business date. Posting sets doc_date again in case the day turned over.
function countDate(value) {
    const today = getBusinessDate();
    if (value == null || value === '') return today;
    if (exactDate(value) !== today) fail(400, 'STOCK_COUNT_INVALID', 'A stock count is dated today.');
    return today;
}

function normalizeCreate(body) {
    const groupKey = /^(category:[1-9]\d{0,9}|ingredients|other)$/;
    let groups;
    if (Array.isArray(body.groups) && body.groups.length === 1 && body.groups[0] === 'all') groups = 'all';
    else if (Array.isArray(body.groups) && body.groups.length >= 1 && body.groups.length <= 300 && body.groups.every((key) => typeof key === 'string' && groupKey.test(key))) {
        groups = [...new Set(body.groups)].sort();
    } else fail(400, 'STOCK_COUNT_INVALID', 'Choose the groups to count.');
    const input = {
        reference: text(body.reference, 60, 'Reference'),
        count_date: countDate(body.count_date),
        groups,
        request_key: requestKey(body.request_key, 'request_key'),
    };
    return input;
}

function positiveId(value, label) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0 || String(value).trim() === '') fail(400, 'STOCK_COUNT_LINES_INVALID', `${label} is invalid.`);
    return id;
}

// ---------- units ----------

function unitOptions(row, recent) {
    const out = [];
    const add = (label, factor) => {
        const normalized = trim(factor);
        if (!label || out.some((known) => known.label.toLowerCase() === String(label).toLowerCase() && scaled(known.factor, 6) === scaled(normalized, 6))) return;
        out.push({ label: String(label), factor: normalized });
    };
    add(row.base_unit, '1');
    if (row.ingredient_id != null) {
        if (row.display_unit && row.display_unit !== row.base_unit) add(row.display_unit, String(DISPLAY_FACTOR[row.display_unit] ?? 1));
        if (row.pack_name && Number(row.pack_size) > 0) add(row.pack_name, String(row.pack_size));
    }
    for (const pack of recent.get(row.item_key) || []) add(pack.label, String(pack.factor));
    // The unit already saved on the line stays selectable even if it dropped out of the recent packs.
    add(row.unit_label, String(row.unit_factor));
    return out;
}

const defaultUnit = (row) => (row.kind === 'ingredient'
    ? { label: row.display_unit, factor: String(DISPLAY_FACTOR[row.display_unit] ?? 1) }
    : { label: 'unit', factor: '1' });

// ---------- reading ----------

const BASE_UNIT_SQL = "CASE WHEN l.product_id IS NOT NULL THEN 'unit' ELSE CASE i.measure WHEN 'weight' THEN 'g' WHEN 'volume' THEN 'ml' ELSE 'unit' END END";
const LINE_SELECT = `SELECT l.id, l.line_no, l.product_id, l.ingredient_id, ${items.itemKeySql('l')} AS item_key,
           CAST(l.qty AS CHAR) AS qty, l.unit_label, CAST(l.unit_factor AS CHAR) AS unit_factor,
           CAST(l.unit_price AS CHAR) AS unit_price, CAST(l.line_total AS CHAR) AS line_total, CAST(l.expected_qty AS CHAR) AS expected_qty,
           l.counted_at, u.name AS counted_by_name, COALESCE(p.name, i.name) AS name, ${BASE_UNIT_SQL} AS base_unit,
           CASE WHEN l.product_id IS NULL THEN 'ingredients' WHEN p.category_id IS NULL THEN 'other' ELSE CONCAT('category:', p.category_id) END AS group_key,
           CASE WHEN l.product_id IS NULL THEN '${items.INGREDIENTS_LABEL}' WHEN p.category_id IS NULL THEN '${items.OTHER_LABEL}' ELSE c.name END AS group_label,
           i.display_unit, i.pack_name, CAST(i.pack_size AS CHAR) AS pack_size,
           CAST(p.cost_price AS CHAR) AS product_cost, CAST(i.unit_cost AS CHAR) AS ingredient_cost
      FROM stock_document_lines l
      LEFT JOIN products p ON p.id = l.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN ingredients i ON i.id = l.ingredient_id
      LEFT JOIN users u ON u.id = l.counted_by`;

const HEADER_SELECT = `SELECT d.id, d.reference, DATE_FORMAT(d.doc_date, '%Y-%m-%d') AS count_date, d.status, d.post_key, d.total,
           d.posted_at, cu.name AS created_by_name, pu.name AS posted_by_name
      FROM stock_documents d
      LEFT JOIN users cu ON cu.id = d.created_by
      LEFT JOIN users pu ON pu.id = d.posted_by`;

// Quantity, expected, variance and money of one line (BigInt, or null when not knowable).
// A posted count reads the cost and value it stored; a draft values the variance at the current cost.
// `known` is whether the item's balance is established now: an unknown balance is never reported as "expected".
function figures(row, posted, known = true) {
    const counted = row.qty == null ? null : baseQuantity(scaled(row.qty, 3), scaled(row.unit_factor, 6));
    const expected = row.qty == null || row.expected_qty == null || !known ? null : scaled(row.expected_qty, 6);
    const variance = counted != null && expected != null ? counted - expected : null;
    let cost = null; // per base unit, 8 decimals
    if (posted) {
        if (row.unit_price != null) cost = scaled(row.unit_price, 4) * 10000n;
    } else if (row.ingredient_id != null) {
        if (row.ingredient_cost != null) cost = scaled(row.ingredient_cost, 8);
    } else if (row.product_cost != null && scaled(row.product_cost, 2) > 0n) {
        // products.cost_price defaults to 0, so zero means "not entered", not "free".
        cost = scaled(row.product_cost, 2) * 1000000n;
    }
    let value = null;
    if (variance != null && cost != null) value = posted ? scaled(row.line_total, 3) : roundDiv(variance * cost, 10n ** 11n);
    return { counted, expected, variance, cost, value };
}

function shapeLine(row, recent, { posted }) {
    const line = {
        id: Number(row.id),
        line_no: Number(row.line_no),
        item_key: row.item_key,
        name: row.name,
        group_key: row.group_key,
        group_label: row.group_label,
        base_unit: row.base_unit,
        qty: row.qty,
        unit_label: row.unit_label,
        unit_factor: trim(row.unit_factor),
        unit_options: unitOptions(row, recent),
        counted_at: row.counted_at,
        counted_by_name: row.counted_by_name,
    };
    if (posted) {
        const f = figures(row, true);
        line.expected_qty = f.expected == null ? null : trim(format(f.expected, 6), 3);
        line.counted_base_qty = f.counted == null ? null : trim(format(f.counted, 6), 3);
        line.variance_qty = f.variance == null ? null : trim(format(f.variance, 6), 3);
        line.unit_cost = f.cost == null ? null : trim(format(f.cost, 8), 3);
        line.variance_value = f.value == null ? null : format(f.value, 3);
    }
    return line;
}

async function loadLines(db, documentId, { ids = null, posted }) {
    const [rows] = await db.query(
        `${LINE_SELECT} WHERE l.document_id = ?${ids ? ' AND l.id IN (?)' : ''} ORDER BY l.line_no`, ids ? [documentId, ids] : [documentId]);
    const recent = await items.recentPacks(db, rows.map((row) => row.item_key));
    return { rows, lines: rows.map((row) => shapeLine(row, recent, { posted })) };
}

async function loadCount(db, id) {
    const [[header]] = await db.query(`${HEADER_SELECT} WHERE d.id = ? AND d.doc_type = 'count'`, [id]);
    if (!header) return null;
    const posted = header.status === 'posted';
    const { lines } = await loadLines(db, id, { posted });
    return {
        id: Number(header.id), reference: header.reference, count_date: header.count_date, status: header.status,
        line_count: lines.length, counted_count: lines.filter((line) => line.qty != null).length,
        created_by_name: header.created_by_name, posted_at: header.posted_at, posted_by_name: header.posted_by_name,
        lines,
    };
}

async function getCount(pool, id) {
    const count = await loadCount(pool, id);
    if (!count) fail(404, 'STOCK_COUNT_NOT_FOUND', 'Stock count not found.');
    return count;
}

async function listCounts(pool, { status, beforeId, limit }) {
    // There is at most one draft and it is always the newest count, so id order is also "draft first".
    const where = ["d.doc_type = 'count'"];
    const params = [];
    if (status) { where.push('d.status = ?'); params.push(status); }
    if (beforeId) { where.push('d.id < ?'); params.push(beforeId); }
    const [rows] = await pool.query(
        `SELECT d.id, d.reference, DATE_FORMAT(d.doc_date, '%Y-%m-%d') AS count_date, d.status, CAST(d.total AS CHAR) AS total, d.posted_at,
                cu.name AS created_by_name,
                (SELECT COUNT(*) FROM stock_document_lines l WHERE l.document_id = d.id) AS line_count,
                (SELECT COUNT(l.qty) FROM stock_document_lines l WHERE l.document_id = d.id) AS counted_count
           FROM stock_documents d LEFT JOIN users cu ON cu.id = d.created_by
          WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT ?`, [...params, limit + 1]);
    const more = rows.length > limit;
    const slice = rows.slice(0, limit);
    return {
        data: slice.map((row) => ({
            id: Number(row.id), reference: row.reference, count_date: row.count_date, status: row.status,
            line_count: Number(row.line_count), counted_count: Number(row.counted_count),
            variance_value: row.status === 'posted' ? trim(row.total, 3) : null,
            created_by_name: row.created_by_name, posted_at: row.posted_at,
        })),
        next_before_id: more ? Number(slice[slice.length - 1].id) : null,
    };
}

async function listGroups(pool) {
    return (await items.listGroups(pool)).map((group) => ({ key: group.group_key, label: group.label, item_count: group.item_count }));
}

async function searchItems(pool, { q, limit }) {
    const found = await items.searchItems(pool, { q, limit });
    if (!found.length) return [];
    const recent = await items.recentPacks(pool, found.map((row) => row.item_key));
    return found.map((row) => {
        const group = row.kind === 'ingredient'
            ? { key: 'ingredients', label: items.INGREDIENTS_LABEL }
            : row.category_id == null ? { key: 'other', label: items.OTHER_LABEL } : { key: `category:${row.category_id}`, label: row.category_name };
        return {
            item_key: row.item_key, name: row.name, group_key: group.key, group_label: group.label, base_unit: row.base_unit,
            unit_options: unitOptions({
                item_key: row.item_key, base_unit: row.base_unit, ingredient_id: row.ingredient_id, display_unit: row.display_unit,
                pack_name: row.pack_name, pack_size: row.pack_size,
            }, recent),
        };
    });
}

// ---------- transactions ----------

// readCommitted: every statement sees what is committed at that moment, so a baseline read cannot miss a sale
// that committed while the transaction was already open.
async function withTransaction(pool, work, { readCommitted = false } = {}) {
    const conn = await pool.getConnection();
    try {
        if (readCommitted) await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
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

// The header row is the lock every change to a count takes first, so a line save, an added line, a
// delete and the post are serialized, and a finished or posting count is refused.
async function lockDraft(conn, id) {
    const [[row]] = await conn.query("SELECT id, status, post_key FROM stock_documents WHERE id = ? AND doc_type = 'count' FOR UPDATE", [id]);
    if (!row) fail(404, 'STOCK_COUNT_NOT_FOUND', 'Stock count not found.');
    if (row.status !== 'draft' || row.post_key != null) fail(409, 'STOCK_COUNT_NOT_DRAFT', 'This stock count was already posted and cannot be changed.');
    return row;
}

const openCountId = async (db) => {
    const [[open]] = await db.query("SELECT id FROM stock_documents WHERE doc_type = 'count' AND status = 'draft' LIMIT 1");
    return open ? Number(open.id) : null;
};

async function alreadyOpen(db) {
    const openId = await openCountId(db);
    return fail(409, 'STOCK_COUNT_ALREADY_OPEN', 'A stock count is already open. Finish or delete it before starting another.', { open_id: openId });
}

// ---------- create ----------

// stock_result is JSON; the driver may hand it back parsed or as text.
const savedResult = (row) => (typeof row.stock_result === 'string' ? JSON.parse(row.stock_result) : row.stock_result) || {};

async function createCount(pool, body, actor) {
    const input = normalizeCreate(body);
    const replay = async (db) => {
        const [[existing]] = await db.query('SELECT id, doc_type, reference, stock_result FROM stock_documents WHERE create_key = ?', [input.request_key]);
        if (!existing) return null;
        if (existing.doc_type !== 'count' || existing.reference !== input.reference
            || JSON.stringify(savedResult(existing).create_groups) !== JSON.stringify(input.groups)) {
            fail(409, 'STOCK_COUNT_KEY_REUSED', 'This request key belongs to a different stock count.');
        }
        return { count: await loadCount(db, existing.id), replay: true };
    };
    const earlier = await replay(pool);
    if (earlier) return earlier;
    if (await openCountId(pool)) await alreadyOpen(pool);
    const found = await items.listItemsForGroups(pool, input.groups, items.MAX_KEYS);
    if (found.length > items.MAX_KEYS) {
        fail(400, 'STOCK_COUNT_INVALID', `A count holds at most ${items.MAX_KEYS} items. Pick fewer groups and count them separately.`);
    }
    if (!found.length) fail(400, 'STOCK_COUNT_INVALID', 'There is nothing to count in the chosen groups.');
    try {
        const id = await withTransaction(pool, async (conn) => {
            const [inserted] = await conn.query(
                "INSERT INTO stock_documents (doc_type, reference, doc_date, create_key, stock_result, created_by) VALUES ('count', ?, ?, ?, ?, ?)",
                [input.reference, input.count_date, input.request_key, JSON.stringify({ create_groups: input.groups }), actor.id]);
            const rows = found.map((item, index) => {
                const unit = defaultUnit(item);
                return [inserted.insertId, index + 1, item.product_id, item.ingredient_id, unit.label, unit.factor];
            });
            for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
                await conn.query(
                    'INSERT INTO stock_document_lines (document_id, line_no, product_id, ingredient_id, unit_label, unit_factor) VALUES ?',
                    [rows.slice(offset, offset + INSERT_CHUNK)]);
            }
            return inserted.insertId;
        });
        return { count: await loadCount(pool, id), replay: false };
    } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        if (String(error.message).includes('uq_stock_document_open_count')) return alreadyOpen(pool);
        const raced = await replay(pool);
        if (raced) return raced;
        throw error;
    }
}

// ---------- saving quantities ----------

function normalizeSave(body) {
    const code = 'STOCK_COUNT_LINES_INVALID';
    const input = body.lines;
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_SAVE_LINES) fail(400, code, `Send between 1 and ${MAX_SAVE_LINES} lines.`);
    const seen = new Set();
    return input.map((raw, index) => {
        const at = `Line ${index + 1}`;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, code, `${at} is invalid.`);
        const id = positiveId(raw.id, `${at} id`);
        if (seen.has(id)) fail(400, code, `${at}: the same line can appear only once.`);
        seen.add(id);
        let qty = null;
        if (raw.qty != null && raw.qty !== '') qty = parseInput(raw.qty, 3, { code, label: `${at} quantity`, max: 9999999 });
        if (typeof raw.unit_label !== 'string' || !raw.unit_label.trim() || raw.unit_label.length > 40) fail(400, code, `${at}: unit is invalid.`);
        const factor = parseInput(raw.unit_factor, 6, { code, label: `${at} unit factor`, max: 9999999, positive: true });
        if (qty != null && baseQuantity(qty, factor) > MAX_STOCK) fail(400, code, `${at}: quantity is too large.`);
        return { id, qty, unit_label: raw.unit_label, factor };
    });
}

const caseOf = (changed, pick) => {
    const arms = changed.map((entry) => {
        const arm = pick(entry);
        return { sql: `WHEN ? THEN ${arm.sql}`, params: [entry.id, ...(arm.params || [])] };
    });
    return { sql: `CASE id ${arms.map((arm) => arm.sql).join(' ')} END`, params: arms.flatMap((arm) => arm.params) };
};

async function saveLines(pool, id, body, actor) {
    const input = normalizeSave(body);
    const ids = input.map((line) => line.id);
    const result = await withTransaction(pool, async (conn) => {
        await lockDraft(conn, id);
        const [stored] = await conn.query(
            `SELECT l.id, l.product_id, l.ingredient_id, ${items.itemKeySql('l')} AS item_key, CAST(l.qty AS CHAR) AS qty,
                    l.unit_label, CAST(l.unit_factor AS CHAR) AS unit_factor, ${BASE_UNIT_SQL} AS base_unit,
                    i.display_unit, i.pack_name, CAST(i.pack_size AS CHAR) AS pack_size
               FROM stock_document_lines l LEFT JOIN ingredients i ON i.id = l.ingredient_id
              WHERE l.document_id = ? AND l.id IN (?)`, [id, ids]);
        if (stored.length !== ids.length) fail(400, 'STOCK_COUNT_LINES_INVALID', 'A line does not belong to this count.');
        const byId = new Map(stored.map((row) => [Number(row.id), row]));
        const recent = await items.recentPacks(conn, stored.map((row) => row.item_key));
        const changed = [];
        for (const line of input) {
            const row = byId.get(line.id);
            const option = unitOptions(row, recent).find((candidate) => candidate.label === line.unit_label && scaled(candidate.factor, 6) === line.factor);
            if (!option) fail(400, 'STOCK_COUNT_LINES_INVALID', `${row.item_key}: the unit is not one of this item's units.`);
            const qtyText = line.qty == null ? null : format(line.qty, 3);
            const sameQty = qtyText === row.qty;
            const sameUnit = row.unit_label === option.label && scaled(row.unit_factor, 6) === line.factor;
            // Saving the same quantity and unit again (a retry after a lost reply) changes nothing.
            if (sameQty && sameUnit) continue;
            changed.push({ id: line.id, item_key: row.item_key, qty: qtyText, unit_label: option.label, unit_factor: format(line.factor, 6) });
        }
        if (changed.length) {
            // The balance each new count is measured against: read now, so a sale made after this moment still applies at post.
            const counting = changed.filter((entry) => entry.qty != null);
            const current = counting.length ? await items.readQuantities(conn, counting.map((entry) => entry.item_key)) : new Map();
            for (const entry of changed) entry.expected = entry.qty == null ? null : (current.get(entry.item_key)?.quantity ?? null);
            const qty = caseOf(changed, (entry) => (entry.qty == null ? { sql: 'NULL' } : { sql: 'CAST(? AS DECIMAL(14,3))', params: [entry.qty] }));
            const label = caseOf(changed, (entry) => ({ sql: '?', params: [entry.unit_label] }));
            const factor = caseOf(changed, (entry) => ({ sql: 'CAST(? AS DECIMAL(16,6))', params: [entry.unit_factor] }));
            const expected = caseOf(changed, (entry) => (entry.expected == null ? { sql: 'NULL' } : { sql: 'CAST(? AS DECIMAL(16,6))', params: [entry.expected] }));
            const by = caseOf(changed, (entry) => (entry.qty == null ? { sql: 'NULL' } : { sql: '?', params: [actor.id] }));
            const at = caseOf(changed, (entry) => ({ sql: entry.qty == null ? 'NULL' : 'NOW()' }));
            await conn.query(
                `UPDATE stock_document_lines SET qty = ${qty.sql}, unit_label = ${label.sql}, unit_factor = ${factor.sql},
                        expected_qty = ${expected.sql}, counted_by = ${by.sql}, counted_at = ${at.sql}
                  WHERE document_id = ? AND id IN (?)`,
                [...qty.params, ...label.params, ...factor.params, ...expected.params, ...by.params, ...at.params, id, changed.map((entry) => entry.id)]);
        }
        const { lines } = await loadLines(conn, id, { ids, posted: false });
        const [[{ counted }]] = await conn.query('SELECT COUNT(qty) AS counted FROM stock_document_lines WHERE document_id = ?', [id]);
        return { lines, counted_count: Number(counted) };
    }, { readCommitted: true });
    return result;
}

async function addLine(pool, id, body) {
    const key = body && typeof body.item_key === 'string' ? body.item_key : null;
    const parsed = items.parseKey(key);
    if (!parsed) fail(400, 'STOCK_COUNT_LINES_INVALID', 'The item is invalid.');
    const eligible = await items.eligibleKeys(pool, [key]);
    if (!eligible.has(key)) fail(400, 'STOCK_COUNT_LINES_INVALID', 'This item cannot be counted.');
    return withTransaction(pool, async (conn) => {
        await lockDraft(conn, id);
        const column = parsed.kind === 'product' ? 'product_id' : 'ingredient_id';
        const [[existing]] = await conn.query(`SELECT id FROM stock_document_lines WHERE document_id = ? AND ${column} = ?`, [id, parsed.id]);
        if (existing) {
            const { lines } = await loadLines(conn, id, { ids: [existing.id], posted: false });
            return { line: lines[0], existing: true };
        }
        const [[size]] = await conn.query('SELECT COUNT(*) AS total, COALESCE(MAX(line_no), 0) AS last_no FROM stock_document_lines WHERE document_id = ?', [id]);
        if (Number(size.total) >= items.MAX_KEYS) fail(400, 'STOCK_COUNT_INVALID', `A count holds at most ${items.MAX_KEYS} items.`);
        let unit = { label: 'unit', factor: '1' };
        if (parsed.kind === 'ingredient') {
            const [[ingredient]] = await conn.query('SELECT display_unit FROM ingredients WHERE id = ?', [parsed.id]);
            unit = defaultUnit({ kind: 'ingredient', display_unit: ingredient.display_unit });
        }
        const [inserted] = await conn.query(
            'INSERT INTO stock_document_lines (document_id, line_no, product_id, ingredient_id, unit_label, unit_factor) VALUES (?, ?, ?, ?, ?, ?)',
            [id, Number(size.last_no) + 1, parsed.kind === 'product' ? parsed.id : null, parsed.kind === 'ingredient' ? parsed.id : null, unit.label, unit.factor]);
        const { lines } = await loadLines(conn, id, { ids: [inserted.insertId], posted: false });
        return { line: lines[0], existing: false };
    });
}

async function deleteCount(pool, id, actor, ipAddress) {
    await withTransaction(pool, async (conn) => {
        await lockDraft(conn, id);
        await conn.query('DELETE FROM stock_documents WHERE id = ?', [id]);
        await appendAuditEvent(conn, {
            eventType: 'stock_count_deleted', userId: actor.id, entityType: 'stock_count', entityId: id,
            oldValue: { status: 'draft' }, ipAddress: ipAddress || null,
        });
    });
    return { deleted: true };
}

// ---------- review ----------

async function review(pool, id) {
    const [[header]] = await pool.query(`${HEADER_SELECT} WHERE d.id = ? AND d.doc_type = 'count'`, [id]);
    if (!header) fail(404, 'STOCK_COUNT_NOT_FOUND', 'Stock count not found.');
    const posted = header.status === 'posted';
    const [rows] = await pool.query(`${LINE_SELECT} WHERE l.document_id = ? ORDER BY l.line_no`, [id]);
    const countedKeys = rows.filter((row) => row.qty != null).map((row) => row.item_key);
    const running = posted || !countedKeys.length ? new Map() : await items.readQuantities(pool, countedKeys);
    const counted = [];
    const uncounted = [];
    let shortage = 0n;
    let surplus = 0n;
    for (const row of rows) {
        const f = figures(row, posted, posted || row.qty == null || Boolean(running.get(row.item_key)?.known));
        const line = {
            id: Number(row.id), item_key: row.item_key, name: row.name, group_label: row.group_label, base_unit: row.base_unit,
            counted_base_qty: f.counted == null ? null : trim(format(f.counted, 6), 3),
            expected_qty: f.expected == null ? null : trim(format(f.expected, 6), 3),
            variance_qty: f.variance == null ? null : trim(format(f.variance, 6), 3),
            unit_cost: f.cost == null ? null : trim(format(f.cost, 8), 3),
            variance_value: f.value == null ? null : format(f.value, 3),
        };
        if (row.qty == null) { uncounted.push(line); continue; }
        counted.push({ line, magnitude: f.value == null ? null : (f.value < 0n ? -f.value : f.value) });
        if (f.value != null) { if (f.value < 0n) shortage += f.value; else surplus += f.value; }
    }
    counted.sort((a, b) => {
        if (a.magnitude == null || b.magnitude == null) return a.magnitude == null && b.magnitude == null ? 0 : a.magnitude == null ? 1 : -1;
        return a.magnitude === b.magnitude ? 0 : a.magnitude > b.magnitude ? -1 : 1;
    });
    return {
        lines: [...counted.map((entry) => entry.line), ...uncounted],
        totals: {
            counted_count: counted.length, uncounted_count: uncounted.length,
            shortage_value: format(shortage, 3), surplus_value: format(surplus, 3), net_value: format(shortage + surplus, 3),
        },
    };
}

// ---------- posting ----------

// One connection with a short lock wait: a posting gives up rather than make a sale wait.
async function withPostingConnection(pool, work) {
    const conn = await getStockConnection(pool);
    let restore = false;
    try {
        await conn.query('SET @stock_count_previous_lock_wait = @@SESSION.innodb_lock_wait_timeout, SESSION innodb_lock_wait_timeout = ?', [LOCK_WAIT_SECONDS]);
        restore = true;
        await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await conn.beginTransaction();
        try {
            const result = await work(conn);
            await conn.commit();
            // How long the product and ingredient rows stayed locked: first lock to commit.
            if (result && result.lockedAt) { result.timing = { locks_held_ms: Date.now() - result.lockedAt }; delete result.lockedAt; }
            return result;
        } catch (error) {
            await conn.rollback().catch(() => {});
            if (error.code === 'ER_LOCK_WAIT_TIMEOUT' || error.code === 'ER_LOCK_DEADLOCK') {
                fail(409, 'STOCK_COUNT_BUSY', 'Stock is busy right now. Nothing was posted; try again.');
            }
            throw error;
        }
    } finally {
        if (restore) {
            try { await conn.query('SET SESSION innodb_lock_wait_timeout = @stock_count_previous_lock_wait'); }
            catch { conn.destroy(); }
        }
        conn.release();
    }
}

// An ingredient count recorded somewhere else (the ingredient movement count) after its line was counted here
// resets the balance this sheet measured against: adding the movement since would apply that correction twice.
// The person counts the ingredient again instead. Products have no other count writer: only stock count
// documents write product counts, and those are excluded by design. Bounded IN-list read, under the stock locks.
async function refuseRecounted(conn, rows) {
    const counted = rows.filter((row) => row.ingredient_id != null);
    if (!counted.length) return;
    const since = new Date(Math.min(...counted.map((row) => new Date(row.counted_at).getTime())));
    const [latest] = await conn.query(
        `SELECT ingredient_id AS id, MAX(occurred_at) AS at FROM stock_movements
          WHERE movement_type = 'ingredient' AND kind = 'count' AND ingredient_id IN (?) AND occurred_at >= ?
            AND (source_label IS NULL OR source_label <> ?) GROUP BY ingredient_id`,
        [counted.map((row) => row.ingredient_id), since, posting.STOCK_COUNT_SOURCE_LABEL]);
    const at = new Map(latest.map((entry) => [String(entry.id), new Date(entry.at).getTime()]));
    for (const row of counted) {
        const seen = at.get(String(row.ingredient_id));
        if (seen != null && seen >= new Date(row.counted_at).getTime()) {
            fail(409, 'STOCK_COUNT_RECOUNT_NEEDED', `${row.name} was counted somewhere else after it was counted here. Enter its quantity again.`);
        }
    }
}

async function postCount(pool, { id, body, actor, ipAddress }) {
    const key = requestKey(body.request_key, 'request_key');
    const replayed = async (db) => ({ count: await loadCount(db, id), replay: true, scope: null });
    const [[header]] = await pool.query("SELECT status, post_key FROM stock_documents WHERE id = ? AND doc_type = 'count'", [id]);
    if (!header) fail(404, 'STOCK_COUNT_NOT_FOUND', 'Stock count not found.');
    if (header.status === 'posted' && header.post_key === key) return replayed(pool);
    if (header.status !== 'draft') fail(409, 'STOCK_COUNT_NOT_DRAFT', 'This stock count was already posted and cannot be changed.');
    const businessDate = getBusinessDate();
    return withPostingConnection(pool, async (conn) => {
        const [[locked]] = await conn.query("SELECT id, status, post_key, stock_result FROM stock_documents WHERE id = ? AND doc_type = 'count' FOR UPDATE", [id]);
        if (!locked) fail(404, 'STOCK_COUNT_NOT_FOUND', 'Stock count not found.');
        if (locked.status === 'posted' && locked.post_key === key) return replayed(conn);
        if (locked.status !== 'draft') fail(409, 'STOCK_COUNT_NOT_DRAFT', 'This stock count was already posted and cannot be changed.');
        // Freeze first: a line save or delete waiting on the header now sees a count that is posting.
        try {
            await conn.query('UPDATE stock_documents SET post_key = ? WHERE id = ?', [key, id]);
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') fail(409, 'STOCK_COUNT_KEY_REUSED', 'This request key belongs to a different stock count.');
            throw error;
        }
        const [rows] = await conn.query(`${LINE_SELECT} WHERE l.document_id = ? AND l.qty IS NOT NULL ORDER BY l.line_no`, [id]);
        if (!rows.length) fail(400, 'STOCK_COUNT_EMPTY', 'Nothing has been counted yet. Count at least one item before posting.');
        const lockedAt = Date.now();
        let held;
        try {
            held = await items.resolveForUpdate(conn, rows.map((row) => row.item_key));
        } catch (error) {
            if (error instanceof CountError && /^PURCHASE_ITEM_(INVALID|UNSUPPORTED)$/.test(error.code)) {
                fail(409, 'STOCK_COUNT_ITEM_UNSUPPORTED', `${error.message} Clear its quantity to skip it.`);
            }
            throw error;
        }
        await refuseRecounted(conn, rows);
        const plan = [];
        const detail = [];
        let net = 0n;
        for (const row of rows) {
            const item = held.items.get(row.item_key);
            // expected_qty is the raw running quantity at counting time, known or not; what moved since still applies.
            const f = figures(row, false, Boolean(item.quantity_known));
            const current = item.raw_quantity == null ? null : scaled(item.raw_quantity, 6);
            const was = row.expected_qty == null ? null : scaled(row.expected_qty, 6);
            let adjusted = f.counted;
            if (was != null && current != null) adjusted = f.counted + (current - was);
            const clamped = adjusted < 0n;
            if (clamped) adjusted = 0n;
            if (adjusted > MAX_STOCK) fail(400, 'STOCK_COUNT_INVALID', `${row.name}: the resulting stock is too large.`);
            if (f.value != null) {
                net += f.value;
                if (abs(f.value) > MAX_VALUE) tooLarge();
            }
            plan.push({ id: Number(row.id), row, figures: f, line: { item_key: row.item_key, base_qty: format(adjusted, 6) } });
            detail.push({
                item_key: row.item_key, counted: format(f.counted, 6), expected: was == null ? null : format(was, 6), reported_expected: f.expected == null ? null : format(f.expected, 6),
                current: current == null ? null : format(current, 6), adjusted: format(adjusted, 6), ...(clamped ? { clamped: true } : {}),
            });
        }
        if (abs(net) > MAX_VALUE) tooLarge();
        const stockResult = await posting.count(conn, { documentId: id, lines: plan.map((entry) => entry.line), locked: held, actor, businessDate, postKey: key });
        // Cost snapshot (per base unit, 4 decimals) and the money value of each variance.
        const price = caseOf(plan, (entry) => (entry.figures.cost == null ? { sql: 'NULL' } : { sql: 'CAST(? AS DECIMAL(14,4))', params: [format(divRound(entry.figures.cost, 10000n), 4)] }));
        const reported = caseOf(plan, (entry) => (entry.figures.expected == null ? { sql: 'NULL' } : { sql: 'CAST(? AS DECIMAL(16,6))', params: [format(entry.figures.expected, 6)] }));
        const total = caseOf(plan, (entry) => ({ sql: 'CAST(? AS DECIMAL(14,3))', params: [entry.figures.value == null ? '0.000' : format(entry.figures.value, 3)] }));
        await conn.query(
            `UPDATE stock_document_lines SET unit_price = ${price.sql}, line_total = ${total.sql}, expected_qty = ${reported.sql} WHERE document_id = ? AND id IN (?)`,
            [...price.params, ...total.params, ...reported.params, id, plan.map((entry) => entry.id)]);
        await conn.query(
            `UPDATE stock_documents SET status = 'posted', posted_by = ?, posted_at = CURRENT_TIMESTAMP, doc_date = ?, total = ?, stock_result = ?, version = version + 1 WHERE id = ?`,
            [actor.id, businessDate, format(net, 3), JSON.stringify({ create_groups: savedResult(locked).create_groups, ...stockResult, lines: detail, net_value: format(net, 3) }), id]);
        await appendAuditEvent(conn, {
            eventType: 'stock_count_posted', userId: actor.id, entityType: 'stock_count', entityId: id,
            newValue: { counted_lines: plan.length, net_value: format(net, 3), clamped_lines: detail.filter((line) => line.clamped).length, request_key: key },
            ipAddress: ipAddress || null,
        });
        return { count: await loadCount(conn, id), replay: false, scope: posting.eventScope(held), lockedAt };
    });
}

module.exports = {
    CountError, listCounts, listGroups, searchItems, createCount, getCount, saveLines, addLine, deleteCount, review, postCount,
};
