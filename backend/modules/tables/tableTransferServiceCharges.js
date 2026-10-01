const { SERVICE_NOTE, serviceChargeFee, canonicalName } = require('../../services/ServiceChargeCalculator');
const { createChildOpenSnapshot, touchOpenOrder, abandonOpenOrder } = require('../../services/ServiceChargeSnapshotService');
const { conflict, cartLine, taxOptions } = require('./tableItemTransferMath');

const feeRows = rows => rows.filter(row => row.note === SERVICE_NOTE);
const profile = snapshot => snapshot ? JSON.stringify([Number(snapshot.percentage), Number(snapshot.tax_rate), snapshot.jofotara_tax_category]) : null;
function adjustedFee(order, goods, snapshot, template) {
    if (!snapshot) return null;
    return { ...template, product_id: null, parent_item_id: null, note: SERVICE_NOTE,
        item_name: canonicalName(snapshot.percentage), quantity: '1.000000', discount_type: null, discount_value: 0,
        price_at_sale: serviceChargeFee(goods.map(cartLine), snapshot.percentage, {
            taxInclusivePricing: Number(order.tax_inclusive_at_sale) === 1, ...taxOptions(order)
        }), tax_rate: Number(snapshot.tax_rate), jofotara_tax_category: snapshot.jofotara_tax_category };
}

async function planServiceCharges(conn, context, lines) {
    const { sourceOrder, targetOrder, sourceItems, targetItems } = context;
    const ids = [...new Set([sourceOrder.service_charge_snapshot_id, targetOrder?.service_charge_snapshot_id].filter(Boolean))].sort();
    const [snapshots] = ids.length ? await conn.query('SELECT * FROM service_charge_snapshots WHERE id IN (?) ORDER BY id FOR UPDATE', [ids]) : [[]];
    const bound = (order, rows) => {
        const fees = feeRows(rows);
        const snapshot = snapshots.find(s => s.id === order?.service_charge_snapshot_id) || null;
        if (order?.service_charge_snapshot_id) {
            if (!snapshot || fees.length !== 1 || snapshot.state !== 'open_order' || snapshot.holder_type !== 'order'
                || String(snapshot.holder_id) !== String(order.invoice_id)) conflict('Service-charge snapshot changed. Refresh and try again.', 'SERVICE_CHARGE_SNAPSHOT_CONFLICT');
        } else if (fees.length) conflict('The saved service charge has no valid owner. Review this bill.', 'SERVICE_CHARGE_SNAPSHOT_CONFLICT');
        return snapshot;
    };
    const sourceSnapshot = bound(sourceOrder, sourceItems), targetSnapshot = targetOrder ? bound(targetOrder, targetItems) : null;
    if (targetOrder && profile(sourceSnapshot) !== profile(targetSnapshot)) {
        conflict('These bills have different service charges. Keep their items separate.', 'SERVICE_CHARGE_TRANSFER_CONFLICT');
    }
    const remainingGoods = lines.remaining.filter(row => row.note !== SERVICE_NOTE);
    const targetGoods = [...targetItems.filter(row => row.note !== SERVICE_NOTE), ...lines.moved];
    const sourceFee = lines.wholeBill ? null : adjustedFee(sourceOrder, remainingGoods, sourceSnapshot, feeRows(sourceItems)[0]);
    const targetFee = adjustedFee(targetOrder || sourceOrder, targetGoods, targetOrder ? targetSnapshot : sourceSnapshot,
        targetOrder ? feeRows(targetItems)[0] : { ...feeRows(sourceItems)[0], id: null });
    return { sourceSnapshot, targetSnapshot, sourceFee, targetFee,
        sourceRows: sourceFee ? [...remainingGoods, sourceFee] : remainingGoods,
        targetRows: targetFee ? [...targetGoods, targetFee] : targetGoods };
}

async function persistServiceCharges(conn, { plan, context, targetInvoiceId, wholeBill, userId, insertItems, nextSortOrder }) {
    for (const [fee, invoiceId] of [[plan.sourceFee, context.sourceOrder.invoice_id], [plan.targetFee, targetInvoiceId]]) {
        if (!fee) continue;
        if (fee.id) {
            await conn.query('UPDATE order_items SET item_name=?,quantity=1,price_at_sale=?,tax_rate=?,jofotara_tax_category=? WHERE id=? AND invoice_id=?',
                [fee.item_name, fee.price_at_sale, fee.tax_rate, fee.jofotara_tax_category, fee.id, invoiceId]);
        } else {
            await insertItems(conn, [{ ...fee, invoice_id: invoiceId, sort_order: nextSortOrder,
                recipe_line_key: null, recipe_cost_snapshot: null, stock_authority: 'none', stock_snapshot: null }]);
        }
    }
    if (plan.sourceSnapshot) {
        const source = { snapshotId: plan.sourceSnapshot.id, version: Number(plan.sourceSnapshot.version), orderId: context.sourceOrder.invoice_id };
        if (wholeBill) await abandonOpenOrder(conn, source);
        else await touchOpenOrder(conn, source);
        if (!context.targetOrder) {
            const target = await createChildOpenSnapshot(conn, { parentSnapshot: plan.sourceSnapshot, orderId: targetInvoiceId, userId });
            await conn.query('UPDATE orders SET service_charge_snapshot_id=? WHERE invoice_id=?', [target.id, targetInvoiceId]);
        }
    }
    if (plan.targetSnapshot) await touchOpenOrder(conn, { snapshotId: plan.targetSnapshot.id, version: Number(plan.targetSnapshot.version), orderId: targetInvoiceId });
}

module.exports = { planServiceCharges, persistServiceCharges };
