const { getBusinessDate } = require('../utils/businessDate');
const { reserveDailyOrderIdentity } = require('../utils/orderSequence');

// Caller owns the transaction and held row lock. Checkout carries these fields
// into the paid order; retries and reprints must never advance the counter.
async function ensureHeldOrderNumber(db, heldOrder, { separateByType } = {}) {
    if (heldOrder.order_id != null) return heldOrder;
    const payload = typeof heldOrder.cart_data === 'string' ? JSON.parse(heldOrder.cart_data) : heldOrder.cart_data;
    const identity = await reserveDailyOrderIdentity(db, {
        businessDate: getBusinessDate(), orderTypeId: payload?.order_type_id, separateByType
    });
    const orderId = identity.order_id;
    const scopeKey = identity.order_seq_scope;
    await db.query('UPDATE held_orders SET order_id=?,order_seq_scope=? WHERE id=?', [orderId, scopeKey, heldOrder.id]);
    heldOrder.order_id = orderId;
    heldOrder.order_seq_scope = scopeKey;
    return heldOrder;
}

module.exports = { ensureHeldOrderNumber };
