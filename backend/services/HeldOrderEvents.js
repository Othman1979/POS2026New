const HELD_ORDER_ACTIONS = Object.freeze(['created', 'updated', 'claimed', 'released', 'fired', 'settled', 'removed', 'cleared']);
const numericOrNull = value => (value == null ? null : Number(value));

// One payload shape for every held_orders_changed emitter. `row` needs id, table_id and
// parent_invoice_id (any may be null); `extra` carries producer-specific fields such as source.
function heldOrdersChangedPayload(action, row = null, extra = {}) {
    if (!HELD_ORDER_ACTIONS.includes(action)) throw new Error(`Unknown held order action: ${action}`);
    return {
        action,
        held_order_id: numericOrNull(row?.id),
        table_id: numericOrNull(row?.table_id),
        parent_invoice_id: numericOrNull(row?.parent_invoice_id),
        ...extra,
    };
}

function emitHeldOrdersChanged(io, action, row = null, extra = {}) {
    if (!io) return;
    io.to('staff').emit('held_orders_changed', heldOrdersChangedPayload(action, row, extra));
}

module.exports = { HELD_ORDER_ACTIONS, heldOrdersChangedPayload, emitHeldOrdersChanged };
