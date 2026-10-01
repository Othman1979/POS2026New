const { calculateLineTotal, roundMoney } = require('./PosCalculator');

function serializeAuditValue(value) {
    if (value == null || typeof value === 'string') return value;
    return JSON.stringify(value);
}

function discountRecord(type, value, amount) {
    const numericValue = Number(value) || 0;
    if (!['fixed', 'percent'].includes(type) || numericValue <= 0) return null;
    return { type, value: numericValue, amount: roundMoney(amount) };
}

function orderDiscountRecord(source = {}) {
    const type = source.discount_type ?? source.type ?? null;
    const value = Number(source.discount_value ?? source.value) || 0;
    const subtotal = Number(source.subtotal) || 0;
    const amount = type === 'fixed'
        ? Math.min(subtotal, value)
        : (type === 'percent' ? subtotal * value / 100 : 0);
    return discountRecord(type, value, amount);
}

function lineDiscountRecord(item = {}) {
    const type = item.discount_type ?? item.discountType ?? null;
    const value = Number(item.discount_value ?? item.discountValue) || 0;
    const price = Number(item.price_at_sale ?? item.price) || 0;
    const qty = Number(item.quantity ?? item.qty) || 0;
    const amount = price * qty - calculateLineTotal({
        price,
        qty,
        discountType: type,
        discountValue: value
    });
    return discountRecord(type, value, amount);
}

function sameDiscount(left, right) {
    if (!left || !right) return left === right;
    return left.type === right.type && left.value === right.value && left.amount === right.amount;
}

function lineKey(item = {}) {
    const productId = item.product_id ?? null;
    const name = item.item_name ?? item.name ?? '';
    return `${productId == null ? `custom:${name}` : `product:${Number(productId)}`}|${item.note || ''}`;
}

function lineAuditValue(item, discount, lineIndex, saved = false) {
    return {
        line: {
            line_index: lineIndex,
            order_item_id: saved
                ? (Number(item.id) || null)
                : (Number(item.order_item_id) || null),
            product_id: item.product_id == null ? null : Number(item.product_id),
            item_name: item.item_name ?? item.name ?? null,
            note: item.note || '',
            quantity: Number(item.quantity ?? item.qty) || 0,
            unit_price: Number(item.price_at_sale ?? item.price) || 0
        },
        discount
    };
}

async function appendDiscountAuditEvents(executor, {
    userId,
    managerId = null,
    invoiceId,
    ipAddress = null,
    previousOrder = null,
    previousItems = [],
    currentOrder,
    currentItems = []
}) {
    const events = [];
    const oldOrderDiscount = previousOrder ? orderDiscountRecord(previousOrder) : null;
    const newOrderDiscount = orderDiscountRecord(currentOrder);
    if (!sameDiscount(oldOrderDiscount, newOrderDiscount)) {
        events.push({
            eventType: 'order_discount_changed',
            entityType: 'order',
            entityId: invoiceId,
            oldValue: oldOrderDiscount,
            newValue: newOrderDiscount
        });
    }

    const savedParents = previousItems.filter(item => item.parent_item_id == null && item.note !== 'Auto-Gratuity');
    const savedById = new Map(savedParents.map(item => [Number(item.id), item]));
    const savedByKey = new Map();
    for (const item of savedParents) {
        const key = lineKey(item);
        const group = savedByKey.get(key) || [];
        group.push(item);
        savedByKey.set(key, group);
    }

    for (const [lineIndex, item] of currentItems.entries()) {
        if (item.note === 'Auto-Gratuity') continue;
        const exact = item.order_item_id != null ? savedById.get(Number(item.order_item_id)) : null;
        const candidates = savedByKey.get(lineKey(item)) || [];
        const previous = exact || (candidates.length === 1 ? candidates[0] : null);
        const oldDiscount = previous ? lineDiscountRecord(previous) : null;
        const newDiscount = lineDiscountRecord(item);
        if (sameDiscount(oldDiscount, newDiscount)) continue;

        events.push({
            eventType: 'line_discount_changed',
            entityType: 'order',
            entityId: invoiceId,
            oldValue: previous ? lineAuditValue(previous, oldDiscount, lineIndex, true) : null,
            newValue: lineAuditValue(item, newDiscount, lineIndex)
        });
    }

    return appendAuditEvents(executor, events, { userId, managerId, ipAddress });
}

async function isAuditDisabled(executor, userId, managerId = null) {
    if (!userId && !managerId) return false;
    const [[result]] = await executor.query(
        'SELECT COALESCE(MAX(xyz), 0) AS disabled FROM users WHERE id IN (?, ?)',
        [userId || 0, managerId || 0]
    );
    return Number(result?.disabled) === 1;
}

function insertAuditEvent(executor, {
    eventType,
    userId = null,
    managerId = null,
    entityType = null,
    entityId = null,
    oldValue = null,
    newValue = null,
    ipAddress = null
}) {
    return executor.query(
        `INSERT INTO audit_events
         (event_type, user_id, manager_id, entity_type, entity_id, old_value, new_value, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            eventType,
            userId,
            managerId,
            entityType,
            entityId,
            serializeAuditValue(oldValue),
            serializeAuditValue(newValue),
            ipAddress
        ]
    );
}

async function appendAuditEvent(executor, event, { auditDisabled } = {}) {
    // Only reuse a policy read by this caller in the same transaction.
    // Ordinary callers still resolve the current actor/authorizer policy here.
    if (auditDisabled ?? await isAuditDisabled(executor, event.userId, event.managerId)) return;
    return insertAuditEvent(executor, event);
}

// One actor/authorizer and one caller-owned transaction; no policy survives the batch.
async function appendAuditEvents(executor, events, { userId = null, managerId = null, ipAddress = null }) {
    if (!events.length || await isAuditDisabled(executor, userId, managerId)) return;
    let rows = [];
    let bytes = 0;
    const flush = async () => {
        if (!rows.length) return;
        await executor.query(`INSERT INTO audit_events
            (event_type, user_id, manager_id, entity_type, entity_id, old_value, new_value, ip_address)
            VALUES ?`, [rows]);
        rows = [];
        bytes = 0;
    };
    for (const event of events) {
        const row = [event.eventType, userId, managerId, event.entityType ?? null,
            event.entityId ?? null, serializeAuditValue(event.oldValue ?? null),
            serializeAuditValue(event.newValue ?? null), ipAddress];
        const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
        // Same bounded row/byte policy as checkout's parent-item writes.
        if (rows.length && (rows.length >= 50 || bytes + rowBytes > 256 * 1024)) await flush();
        rows.push(row);
        bytes += rowBytes;
    }
    await flush();
}

// Security-shaped events retain their entity default, but the global xyz flag
// suppresses every audit event created for that actor or authorizer.
async function appendSecurityAuditEvent(executor, {
    eventType,
    userId = null,
    managerId = null,
    entityType = 'security',
    entityId = null,
    oldValue = null,
    newValue = null,
    ipAddress = null
}) {
    return appendAuditEvent(executor, {
        eventType,
        userId,
        managerId,
        entityType,
        entityId,
        oldValue,
        newValue,
        ipAddress
    });
}

module.exports = { appendAuditEvent, appendAuditEvents, appendSecurityAuditEvent, appendDiscountAuditEvents, isAuditDisabled };
