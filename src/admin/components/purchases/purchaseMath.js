// Pure helpers for the purchase-invoice editor. The server recomputes every amount;
// these mirror its rule so the screen shows the same numbers it will store:
// each line is rounded to 3 decimals and the invoice sums the rounded lines.

export const TAX_RATES = [0, 4, 16];
export const PRICE_CHANGE_THRESHOLD = 0.1;
export const PAPER_TOTAL_TOLERANCE = 0.005;
export const MAX_LINES = 100;
// Cell order inside a row; Enter walks this left to right.
export const CELLS = ['item', 'qty', 'unit', 'price', 'tax'];

export const round3 = (value) => {
    const parsed = Number(value);
    return Math.round(((Number.isFinite(parsed) ? parsed : 0) + Number.EPSILON) * 1000) / 1000;
};

// Empty string / null / NaN mean "not entered"; a real 0 is a value.
export const toNumber = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

// Exact decimal arithmetic in scaled integers, the same rule as the server
// (PurchaseInvoiceService lineSubtotal/lineTax): quantity in thousandths, price in
// ten-thousandths, money in fils, half-up. Binary floats would show 2.010 x 0.9500 as 1.909.
function scaled(value, scale) {
    const parsed = toNumber(value);
    if (parsed === null) return null;
    const [whole, frac = ''] = parsed.toFixed(Math.min(scale + 2, 20)).replace('-', '').split('.');
    const digits = BigInt(whole + frac.slice(0, scale).padEnd(scale, '0'));
    const rest = frac.slice(scale);
    const rounded = rest && Number(rest[0]) >= 5 ? digits + 1n : digits;
    return parsed < 0 ? -rounded : rounded;
}
const halfUp = (numerator, denominator) => (numerator + denominator / 2n) / denominator;
const fils = (units) => Number(units) / 1000;

function lineFils(row) {
    const qty = scaled(row?.qty, 3);
    const price = scaled(row?.unit_price, 4);
    if (qty === null || price === null || qty <= 0n || price < 0n) return { subtotal: 0n, tax: 0n };
    const rate = BigInt(Math.round(Number(row.tax_rate) || 0));
    const subtotal = halfUp(qty * price, 10000n);
    return { subtotal, tax: halfUp(subtotal * rate, 100n) };
}

export function lineAmounts(row) {
    const { subtotal, tax } = lineFils(row);
    return { subtotal: fils(subtotal), tax: fils(tax), total: fils(subtotal + tax) };
}

export function invoiceTotals(rows) {
    let subtotal = 0n;
    let tax = 0n;
    for (const row of rows || []) {
        const amounts = lineFils(row);
        subtotal += amounts.subtotal;
        tax += amounts.tax;
    }
    return { subtotal: fils(subtotal), tax: fils(tax), total: fils(subtotal + tax) };
}

export function paperTotalState(paperTotal, total) {
    const paper = toNumber(paperTotal);
    if (paper === null) return 'none';
    return Math.abs(paper - total) <= PAPER_TOTAL_TOLERANCE ? 'match' : 'mismatch';
}

// A row counts toward the invoice only when it has an item and a positive quantity.
export const isEntered = (row) => {
    const qty = toNumber(row?.qty);
    return Boolean(row?.item) && qty !== null && qty > 0;
};

export const isBlankRow = (row) => !row?.item && (row?.qty === '' || row?.qty == null);

let rowCounter = 0;
export function newRow(seed = {}) {
    rowCounter += 1;
    return {
        key: `r${rowCounter}`,
        item: null,
        qty: '',
        unit_label: '',
        unit_factor: 1,
        unit_price: '',
        tax_rate: 0,
        ref_price: null,
        ref_factor: null,
        price_touched: false,
        ...seed,
    };
}

// Prefill a row from a catalog item: last unit/price/tax for this supplier (or any). A first purchase
// defaults to the item's buying pack (e.g. kilo, box) rather than the gram/ml base unit.
export function applyItem(row, item, { qty } = {}) {
    const packs = Array.isArray(item.packs) && item.packs.length ? item.packs : [{ label: item.base_unit || 'unit', factor: 1 }];
    const last = item.last || null;
    const lastPack = last ? packs.find(p => p.label === last.unit_label && Number(p.factor) === Number(last.unit_factor)) : null;
    const firstPurchasePack = packs.find(p => Number(p.factor) > 1) || packs[0];
    const pack = lastPack || (last ? { label: last.unit_label, factor: Number(last.unit_factor) } : firstPurchasePack);
    row.item = { ...item, packs: lastPack || !last ? packs : [pack, ...packs] };
    row.unit_label = pack.label;
    row.unit_factor = Number(pack.factor);
    row.unit_price = last ? Number(last.unit_price) : '';
    row.tax_rate = last && TAX_RATES.includes(Number(last.tax_rate)) ? Number(last.tax_rate) : 0;
    row.ref_price = last ? Number(last.unit_price) : null;
    row.ref_factor = last ? Number(last.unit_factor) : null;
    row.price_touched = false;
    if (qty !== undefined) row.qty = qty;
    return row;
}

// Packs are identified by label AND factor: "box x 12" and "box x 24" can share a label.
export const packKey = (pack) => `${pack.label}|${Number(pack.factor)}`;

export function selectUnit(row, key) {
    const pack = row.item?.packs?.find(p => packKey(p) === key);
    if (!pack) return row;
    row.unit_label = pack.label;
    row.unit_factor = Number(pack.factor);
    if (!row.price_touched) {
        const sameUnit = row.ref_price !== null && Number(row.ref_factor) === row.unit_factor;
        row.unit_price = sameUnit ? row.ref_price : '';
    }
    return row;
}

export function findRowByItem(rows, itemKey) {
    return rows.findIndex(row => row.item && row.item.item_key === itemKey);
}

// Barcode add-or-increment: an item already on the invoice gains +1 quantity instead of a
// second row (the server rejects the same item twice). Returns where the quantity went.
export function addOrIncrement(rows, item, { increment = 1, targetIndex = -1 } = {}) {
    const existing = findRowByItem(rows, item.item_key);
    if (existing >= 0) {
        const current = toNumber(rows[existing].qty) || 0;
        rows[existing].qty = round3(current + increment);
        return { index: existing, added: false };
    }
    const useTarget = targetIndex >= 0 && isBlankRow(rows[targetIndex]);
    const row = useTarget ? rows[targetIndex] : newRow();
    applyItem(row, item, { qty: increment });
    if (useTarget) return { index: targetIndex, added: true };
    rows.push(row);
    return { index: rows.length - 1, added: true };
}

// Price changed by more than 10% against the last price for the same buying unit.
export function priceChange(row) {
    const price = toNumber(row?.unit_price);
    const ref = toNumber(row?.ref_price);
    if (price === null || ref === null || ref <= 0) return null;
    if (Number(row.ref_factor) !== Number(row.unit_factor)) return null;
    const ratio = (price - ref) / ref;
    if (Math.abs(ratio) <= PRICE_CHANGE_THRESHOLD + 1e-9) return null;
    return { direction: ratio > 0 ? 'up' : 'down', percent: Math.round(Math.abs(ratio) * 100), ref };
}

// Purchase history for one line, with every price expressed in the line's buying unit. Any rise
// above the latest posted price, from any supplier, is reported; it never blocks the invoice.
export function purchaseInsight(row, insight) {
    if (!row?.item || !insight) return null;
    const factor = Number(row.unit_factor) > 0 ? Number(row.unit_factor) : 1;
    const inUnit = (base) => (base === null || base === undefined ? null : Number((Number(base) * factor).toFixed(6)));
    const last = insight.last ? { ...insight.last, price: inUnit(insight.last.base_price) } : null;
    const sameAsLast = insight.supplier_last && last
        && insight.supplier_last.invoice_date === last.invoice_date && insight.supplier_last.supplier_id === last.supplier_id;
    const supplierLast = insight.supplier_last && !sameAsLast ? { ...insight.supplier_last, price: inUnit(insight.supplier_last.base_price) } : null;
    const price = toNumber(row.unit_price);
    let increase = null;
    if (price !== null && last && price - last.price > 0.0005) {
        increase = {
            amount: Number((price - last.price).toFixed(6)),
            percent: last.price > 0 ? Math.round(((price - last.price) / last.price) * 1000) / 10 : null,
        };
    }
    return {
        last,
        lastFromSupplier: Boolean(sameAsLast),
        supplierLast,
        average: inUnit(insight.average_base_price),
        onHand: insight.on_hand ?? null,
        increase,
    };
}

// Enter walks item -> qty -> unit -> price -> tax, then opens a new row. A row
// without an item cannot be left by Enter.
export function nextCell(rows, rowIndex, cell) {
    const col = CELLS.indexOf(cell);
    const row = rows[rowIndex];
    if (!row) return { row: Math.max(rows.length - 1, 0), cell: 'item', createRow: rows.length === 0 };
    if (!row.item) return { row: rowIndex, cell: 'item', createRow: false };
    if (col < CELLS.length - 1) return { row: rowIndex, cell: CELLS[col + 1], createRow: false };
    if (rowIndex < rows.length - 1) return { row: rowIndex + 1, cell: 'item', createRow: false };
    return { row: rows.length, cell: 'item', createRow: true };
}

// Lines sent to the server: only rows with an item and a positive quantity (empty
// "Add category" rows are never sent). Returns { lines, problems }.
export function buildLines(rows) {
    const lines = [];
    const problems = [];
    for (const row of rows || []) {
        if (!row.item) continue;
        const qty = toNumber(row.qty);
        if (qty === null || qty === 0) continue;
        const price = toNumber(row.unit_price);
        if (qty < 0) problems.push({ key: row.key, reason: 'qty' });
        else if (price === null || price < 0) problems.push({ key: row.key, reason: 'price' });
        else if (!(Number(row.unit_factor) > 0) || !row.unit_label) problems.push({ key: row.key, reason: 'unit' });
        else lines.push({
            item_key: row.item.item_key,
            qty,
            unit_label: row.unit_label,
            unit_factor: Number(row.unit_factor),
            unit_price: price,
            tax_rate: Number(row.tax_rate) || 0,
        });
    }
    return { lines, problems };
}

// Rows from a server invoice line (GET /invoices/:id or /invoices/last).
// `repeated` rows (Repeat last invoice) carry the old price as a suggestion, not as typed input, so a
// unit change clears it; rows of a loaded draft keep what the operator saved.
export function rowFromLine(line, { keepQty = true, repeated = false } = {}) {
    const packs = [{ label: line.unit_label, factor: Number(line.unit_factor) }];
    if (Number(line.unit_factor) !== 1 && line.base_unit) packs.push({ label: line.base_unit, factor: 1 });
    const hasRef = line.last_unit_price_before !== null && line.last_unit_price_before !== undefined;
    // The previous price only compares when it was for the same buying unit.
    const refFactor = hasRef && line.last_unit_factor_before != null ? Number(line.last_unit_factor_before) : null;
    return newRow({
        item: { item_key: line.item_key, name: line.name, base_unit: line.base_unit, packs, last: null, starts_tracking: Boolean(line.starts_tracking) },
        qty: keepQty ? Number(line.qty) : '',
        unit_label: line.unit_label,
        unit_factor: Number(line.unit_factor),
        unit_price: Number(line.unit_price),
        tax_rate: Number(line.tax_rate) || 0,
        ref_price: hasRef ? Number(line.last_unit_price_before) : null,
        ref_factor: refFactor,
        price_touched: !repeated,
    });
}

// Merge incoming rows (repeat-last, add-category) into the editor: blank rows go, items
// already on the invoice are kept as they are, the 100-line cap holds, and one blank
// row stays at the end for the next entry.
export function mergeRows(rows, incoming) {
    const kept = (rows || []).filter(row => !isBlankRow(row));
    let skipped = 0;
    for (const row of incoming || []) {
        if (findRowByItem(kept, row.item.item_key) >= 0 || kept.length >= MAX_LINES) { skipped += 1; continue; }
        kept.push(row);
    }
    return { rows: [...kept, newRow()], skipped };
}

// Compare a server invoice with what the editor would send (used to recognise a save
// whose reply was lost). Numbers are normalised; line order is the server's line_no.
// A lost save is only recognised as ours when the whole draft matches: header fields and lines.
export function sameDraft(server, body) {
    const text = (value) => String(value ?? '').trim();
    const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
    return Number(server?.supplier_id) === Number(body.supplier_id)
        && text(server.supplier_invoice_no) === text(body.supplier_invoice_no)
        && String(server.invoice_date || '').slice(0, 10) === String(body.invoice_date || '').slice(0, 10)
        && server.payment_status === body.payment_status
        && num(server.paper_total) === num(body.paper_total)
        && text(server.notes) === text(body.notes)
        && sameLines(server.lines, body.lines);
}

export function sameLines(serverLines, lines) {
    const norm = (l) => [String(l.item_key), Number(l.qty), String(l.unit_label), Number(l.unit_factor), Number(l.unit_price), Number(l.tax_rate)].join('|');
    const a = (serverLines || []).map(norm);
    const b = (lines || []).map(norm);
    return a.length === b.length && a.every((value, index) => value === b[index]);
}
