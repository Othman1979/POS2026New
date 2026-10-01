const quantity = require('../../services/stockQuantity');
const { calculateExpectedTotals } = require('../../services/PosCalculator');
const { TAX_REGISTRATION_TYPES } = require('../../config/taxRegistration');
const { moneyToCents } = require('../../services/SplitMoneyAllocator');
const { SERVICE_NOTE } = require('../../services/ServiceChargeCalculator');

const conflict = (message, publicCode = 'TABLE_ITEM_TRANSFER_CONFLICT', statusCode = 409) => {
    throw Object.assign(new Error(message), { statusCode, publicCode });
};

function normalizeSelection(items) {
    if (!Array.isArray(items) || !items.length || items.length > 1000) conflict('Select the items to move.', undefined, 400);
    const ids = new Set();
    return items.map(item => {
        const id = item?.order_item_id;
        let units;
        try { units = quantity.parse(item?.quantity); } catch { conflict('Enter a valid quantity with at most six decimal places.', undefined, 400); }
        if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id) || units <= 0n || units > 999999999999n) {
            conflict('Invalid item selection or quantity.', undefined, 400);
        }
        ids.add(id);
        return { order_item_id: id, quantity: quantity.format(units) };
    }).sort((a, b) => a.order_item_id - b.order_item_id);
}

function splitTransferredLines(rows, selection) {
    const selected = new Map(selection.map(item => [item.order_item_id, quantity.parse(item.quantity)]));
    const parents = new Map(rows.filter(row => row.parent_item_id == null).map(row => [Number(row.id), row]));
    for (const [id, units] of selected) {
        const row = parents.get(id);
        if (!row || row.note === SERVICE_NOTE || units > quantity.parse(row.quantity)) conflict('The selected items changed. Reopen the bill and try again.');
    }
    const remaining = [], moved = [];
    for (const row of rows) {
        const parentId = Number(row.parent_item_id ?? row.id), units = selected.get(parentId);
        if (!units) { remaining.push({ ...row }); continue; }
        const parent = parents.get(parentId), original = quantity.parse(parent.quantity), total = quantity.parse(row.quantity);
        const part = row.parent_item_id == null ? units : (total * units + original / 2n) / original;
        const rest = total - part;
        if (part <= 0n || (units < original && rest <= 0n)) conflict('That quantity is too small to preserve the saved bundle components.');
        moved.push({ ...row, quantity: quantity.format(part), partial: units < original });
        if (rest > 0n) remaining.push({ ...row, quantity: quantity.format(rest) });
    }
    const wholeBill = !remaining.some(row => row.parent_item_id == null && row.note !== SERVICE_NOTE);
    return { remaining: wholeBill ? [] : remaining, moved, wholeBill };
}

const cartLine = row => ({
    product_id: row.product_id, price: Number(row.price_at_sale), qty: Number(row.quantity),
    tax_rate: Number(row.tax_rate), jofotara_tax_category: row.jofotara_tax_category, note: row.note,
    discountType: row.discount_type, discountValue: Number(row.discount_value || 0),
    modifier_surcharge: row.modifier_surcharge == null ? null : Number(row.modifier_surcharge),
    modifier_tax_amount: row.modifier_tax_amount == null ? null : Number(row.modifier_tax_amount)
});
const taxOptions = order => ({
    taxRegistrationType: order.tax_registration_type_at_sale ?? TAX_REGISTRATION_TYPES.SALES_TAX,
    taxExempt: Number(order.tax_exempt_at_sale) === 1,
    pricesAlreadyExempt: Number(order.tax_exempt_at_sale) === 1
});
const money = order => ({ subtotal: Number(order?.subtotal || 0), tax: Number(order?.tax || 0), total: Number(order?.total || 0) });
function calculateSavedMoney(order, rows) {
    if (!rows.length) return money(null);
    return money(calculateExpectedTotals({ order_discount_type: order.discount_type, order_discount_value: order.discount_value },
        rows.map(cartLine), new Map(), Number(order.tax_inclusive_at_sale) === 1, taxOptions(order)));
}

function assertCompatibleBills(source, target) {
    if (Number(source.discount_value) > 0 || Number(target?.discount_value) > 0) {
        conflict('Orders with an order-level discount cannot be combined. Keep these bills separate.', 'ORDER_DISCOUNT_MERGE_CONFLICT');
    }
    if (!target) return;
    if ((Number(source.tax_exempt_at_sale) === 1) !== (Number(target.tax_exempt_at_sale) === 1)) {
        conflict('These bills have different tax exemptions. Keep their items separate.', 'TAX_EXEMPT_CONTEXT_MISMATCH');
    }
    if (taxOptions(source).taxRegistrationType !== taxOptions(target).taxRegistrationType) {
        conflict('These bills have different tax registrations. Keep their items separate.', 'TAX_REGISTRATION_CONTEXT_MISMATCH');
    }
    if ((Number(source.tax_inclusive_at_sale) === 1) !== (Number(target.tax_inclusive_at_sale) === 1)) {
        conflict('These bills use different tax accounting. Keep their items separate.', 'TAX_ACCOUNTING_CONTEXT_MISMATCH');
    }
}

function assertMoneyConserved(sourceBefore, targetBefore, sourceAfter, targetAfter) {
    // Each still-open bill rounds its own net/tax components. Regrouping can
    // shift a cent between those components while preserving the saved rates
    // and customer charges. The combined payable amount must remain exact.
    if (moneyToCents(sourceBefore.total) + moneyToCents(targetBefore.total) !== moneyToCents(sourceAfter.total) + moneyToCents(targetAfter.total)) {
        conflict('This transfer would change the saved bill totals. Keep these items on their current bill.', 'TABLE_MONEY_CONSERVATION_CONFLICT');
    }
}

module.exports = { conflict, normalizeSelection, splitTransferredLines, cartLine, taxOptions, money, calculateSavedMoney, assertCompatibleBills, assertMoneyConserved };
