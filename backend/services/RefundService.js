'use strict';

const { roundMoney, calculateLineSubtotal } = require('./PosCalculator');
const { getSettings } = require('../config/settingsHelper');
const { assertOrderItemBundleIntegrity } = require('./bundleIntegrity');
const { appendAuditEvent } = require('./auditEvents');
const { getBusinessDate } = require('../utils/businessDate');
const { reverseLinesUsage } = require('./RecipeLedgerService');
const reportInvalidation = require('./StockReportInvalidation');
const { prepareStockWrite, restoreStockForCart } = require('./InventoryService');
const {
    TAX_REGISTRATION_TYPES,
    normalizeTaxRegistrationType
} = require('../config/taxRegistration');

function refundError(message, statusCode = 400, publicCode = null) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.publicCode = publicCode;
    return error;
}

async function syncOrderRefundStatus(conn, orderOrInvoiceId) {
    let order = orderOrInvoiceId && typeof orderOrInvoiceId === 'object'
        ? orderOrInvoiceId
        : null;
    if (!order) {
        const [[loadedOrder]] = await conn.query(
            'SELECT invoice_id, payment_method, refund_status, total FROM orders WHERE invoice_id=? LIMIT 1',
            [orderOrInvoiceId]
        );
        order = loadedOrder;
    }
    if (!order) throw refundError('Order not found.', 404);

    const [[evidence]] = await conn.query(
        `SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN 1 ELSE 0 END), 0) AS refund_count,
                COALESCE(SUM(CASE WHEN kind='void' THEN 1 ELSE 0 END), 0) AS void_count,
                COALESCE(SUM(CASE WHEN kind='refund' THEN amount_refunded ELSE 0 END), 0) AS refunded_amount
           FROM refunds
          WHERE invoice_id=?`,
        [order.invoice_id]
    );
    const refundCount = Number(evidence?.refund_count || 0);
    const voidCount = Number(evidence?.void_count || 0);
    const refundedAmount = Number(evidence?.refunded_amount || 0);
    let nextStatus = 'none';

    if (order.payment_method === 'voided' && voidCount > 0) {
        nextStatus = 'full';
    } else if (order.payment_method === 'unpaid_table' && voidCount > 0) {
        nextStatus = 'partial';
    } else if (refundCount > 0) {
        const [[coverage]] = await conn.query(
            `SELECT COUNT(*) AS parent_count,
                    COALESCE(SUM(
                        CASE WHEN COALESCE(ri.refunded_qty, 0) + 1e-9 >= oi.quantity
                             THEN 1 ELSE 0 END
                    ), 0) AS fully_covered_count
               FROM order_items oi
          LEFT JOIN (
                SELECT ri.order_item_id, SUM(ri.quantity) AS refunded_qty
                  FROM refund_items ri
                  JOIN refunds r ON r.id=ri.refund_id
                 WHERE r.invoice_id=? AND r.kind='refund'
                 GROUP BY ri.order_item_id
            ) ri ON ri.order_item_id=oi.id
              WHERE oi.invoice_id=? AND oi.parent_item_id IS NULL`,
            [order.invoice_id, order.invoice_id]
        );
        nextStatus = Number(coverage?.parent_count || 0) > 0 &&
            Number(coverage?.fully_covered_count || 0) === Number(coverage?.parent_count || 0) &&
            refundedAmount + 1e-9 >= Number(order.total || 0)
            ? 'full'
            : 'partial';
    }

    if (order.refund_status !== nextStatus) {
        await conn.query(
            'UPDATE orders SET refund_status=? WHERE invoice_id=?',
            [nextStatus, order.invoice_id]
        );
    }
    return nextStatus;
}

const toMoneyCents = amount => Math.max(0, Math.round(roundMoney(Number(amount) || 0) * 100));

function allocateMoneyAcrossRows(rows, field, targetAmount) {
    if (!rows.length) return;
    const targetCents = toMoneyCents(targetAmount);
    const sourceCents = rows.map(row => toMoneyCents(row[field]));
    const sourceTotal = sourceCents.reduce((sum, cents) => sum + cents, 0);
    let remaining = targetCents;

    rows.forEach((row, index) => {
        const cents = index === rows.length - 1
            ? remaining
            : Math.min(remaining, Math.max(0, sourceTotal > 0
                ? Math.round((sourceCents[index] * targetCents) / sourceTotal)
                : 0));
        remaining -= cents;
        row[field] = roundMoney(cents / 100);
    });
}

async function refundPaidOrder(conn, {
    invoiceId,
    items = null,
    refundMethod = null,
    reason = null,
    actorId,
    ipAddress = null,
    managedSubscriptionId = null,
    managedRefundAmount = null,
    refundShiftId = undefined
}) {
    if (managedSubscriptionId != null || managedRefundAmount != null) {
        throw refundError('Subscriptions are no longer available.', 410, 'SUBSCRIPTIONS_RETIRED');
    }
    const [[order]] = await conn.query(
        `SELECT invoice_id, table_id, payment_method, refund_status, shift_id,
                discount_type, discount_value, subtotal, tax, total, parent_invoice_id,
                tax_inclusive_at_sale, tax_exempt_at_sale, tax_registration_type_at_sale
           FROM orders
          WHERE invoice_id=?
          FOR UPDATE`,
        [invoiceId]
    );
    if (!order) throw refundError('Order not found.', 404);
    order.refund_status = await syncOrderRefundStatus(conn, order);

    if (order.payment_method === 'unpaid_table') {
        throw refundError('This order is still open and unpaid — cancel its items as a void, not a refund.', 409);
    }
    if (order.payment_method === 'voided') throw refundError('Order is already voided.');
    if (order.refund_status === 'full') throw refundError('Order is already fully refunded.');
    if (order.payment_method === 'platform') refundMethod = 'platform';
    else if (!['cash', 'card', 'split'].includes(refundMethod)) {
        throw refundError('A valid refund method is required.');
    }

    const taxRegistrationType = order.tax_registration_type_at_sale == null
        ? TAX_REGISTRATION_TYPES.SALES_TAX
        : normalizeTaxRegistrationType(order.tax_registration_type_at_sale);
    if (order.tax_registration_type_at_sale == null) {
        await conn.query(
            'UPDATE orders SET tax_registration_type_at_sale=? WHERE invoice_id=?',
            [taxRegistrationType, invoiceId]
        );
    }
    const taxExempt = Number(order.tax_exempt_at_sale) === 1;

    let [allOrderItems] = await conn.query(
        `SELECT id, invoice_id, parent_item_id, product_id, item_name, note,
                quantity, price_at_sale, tax_rate, tax_amount,
                modifier_surcharge, modifier_tax_amount,
                discount_type, discount_value, sort_order, recipe_line_key, stock_authority, stock_snapshot
           FROM order_items
          WHERE invoice_id=?
          ORDER BY sort_order, id
          FOR UPDATE`,
        [invoiceId]
    );
    assertOrderItemBundleIntegrity(allOrderItems);
    const missingNames = [...new Set(allOrderItems
        .filter(item => item.item_name == null && item.product_id != null)
        .map(item => Number(item.product_id)))];
    if (missingNames.length) {
        const [products] = await conn.query('SELECT id, name FROM products WHERE id IN (?)', [missingNames]);
        const names = new Map(products.map(product => [Number(product.id), product.name]));
        allOrderItems = allOrderItems.map(item => ({
            ...item,
            item_name: item.item_name ?? names.get(Number(item.product_id)) ?? null
        }));
    }
    const orderItems = allOrderItems.filter(item => item.parent_item_id == null);
    if (!orderItems.length) throw refundError('Order has no refundable items.');

    const [priorRows] = await conn.query(
        `SELECT ri.order_item_id, COALESCE(SUM(ri.quantity),0) AS qty
           FROM refund_items ri
           JOIN refunds r ON r.id=ri.refund_id
          WHERE r.invoice_id=? AND r.kind='refund'
          GROUP BY ri.order_item_id`,
        [invoiceId]
    );
    const priorByItem = new Map(priorRows.map(row => [Number(row.order_item_id), Number(row.qty)]));
    const [[priorMoney]] = await conn.query(
        `SELECT COALESCE(SUM(subtotal_refunded),0) AS subtotal,
                COALESCE(SUM(amount_refunded),0) AS amount,
                COUNT(*) AS count
           FROM refunds
          WHERE invoice_id=? AND kind='refund'`,
        [invoiceId]
    );
    const byId = new Map(orderItems.map(item => [Number(item.id), item]));
    const remainingOf = item => Number(item.quantity) - (priorByItem.get(Number(item.id)) || 0);
    let lines;
    if (Array.isArray(items)) {
        if (!items.length) throw refundError('No items selected to refund.');
        const seen = new Set();
        lines = items.map(selection => {
            const orderItemId = Number(selection.order_item_id);
            if (!Number.isInteger(orderItemId) || seen.has(orderItemId)) {
                throw refundError(seen.has(orderItemId)
                    ? 'Each order item may only be selected once.'
                    : 'Item does not belong to this order.');
            }
            seen.add(orderItemId);
            const item = byId.get(orderItemId);
            if (!item) throw refundError('Item does not belong to this order.');
            const quantity = Number(selection.qty);
            if (!(quantity > 0) || quantity > remainingOf(item) + 1e-9) {
                throw refundError('Requested refund quantity exceeds the refundable amount.');
            }
            return { item, quantity };
        });
    } else {
        lines = orderItems
            .map(item => ({ item, quantity: remainingOf(item) }))
            .filter(line => line.quantity > 1e-9);
        if (!lines.length) throw refundError('Nothing left to refund.');
    }

    const orderSubtotal = Number(order.subtotal) || 0;
    let discountedSubtotal = orderSubtotal;
    if (order.parent_invoice_id != null) {
        discountedSubtotal = roundMoney(Number(order.total || 0) - Number(order.tax || 0));
    } else {
        if (order.discount_type === 'fixed') discountedSubtotal -= Number(order.discount_value) || 0;
        if (order.discount_type === 'percent') discountedSubtotal -= discountedSubtotal * ((Number(order.discount_value) || 0) / 100);
    }
    discountedSubtotal = Math.max(0, discountedSubtotal);
    const discountRatio = orderSubtotal > 0 ? discountedSubtotal / orderSubtotal : 1;

    let subtotalRefunded = 0;
    let taxRefunded = 0;
    const computed = lines.map(({ item, quantity }) => {
        const fullQuantity = Number(item.quantity) || 1;
        const fraction = quantity / fullQuantity;
        const lineSubtotal = roundMoney(calculateLineSubtotal({
            price: Number(item.price_at_sale),
            qty: fullQuantity,
            discountType: item.discount_type || null,
            discountValue: Number(item.discount_value) || 0,
            modifier_surcharge: item.modifier_surcharge,
            modifier_tax_amount: item.modifier_tax_amount
        }, Number(item.tax_rate || 0), Number(order.tax_inclusive_at_sale) === 1, {
            taxRegistrationType,
            taxExempt,
            pricesAlreadyExempt: taxExempt
        }) * discountRatio * fraction);
        const lineTax = roundMoney(Number(item.tax_amount || 0) * fraction);
        subtotalRefunded += lineSubtotal;
        taxRefunded += lineTax;
        return {
            order_item_id: item.id,
            product_id: item.product_id,
            stock_authority: item.stock_authority,
            stock_snapshot: item.stock_snapshot,
            item_name: item.item_name,
            note: item.note,
            quantity,
            unit_price: Number(item.price_at_sale),
            line_subtotal: lineSubtotal,
            line_tax: lineTax,
            line_total: roundMoney(lineSubtotal + lineTax)
        };
    });

    subtotalRefunded = roundMoney(subtotalRefunded);
    taxRefunded = roundMoney(taxRefunded);
    const remainingSubtotal = roundMoney(Math.max(0, roundMoney(discountedSubtotal) - Number(priorMoney.subtotal || 0)));
    const remainingTotal = roundMoney(Math.max(0, Number(order.total || 0) - Number(priorMoney.amount || 0)));
    const beforeSubtotalClamp = subtotalRefunded;
    if (subtotalRefunded > remainingSubtotal) subtotalRefunded = remainingSubtotal;
    if (subtotalRefunded < beforeSubtotalClamp - 1e-9) {
        allocateMoneyAcrossRows(computed, 'line_subtotal', subtotalRefunded);
    }

    let amountRefunded = roundMoney(subtotalRefunded + taxRefunded);
    if (amountRefunded > remainingTotal) amountRefunded = remainingTotal;
    const unclampedAmount = roundMoney(subtotalRefunded + taxRefunded);
    if (amountRefunded < unclampedAmount - 1e-9) {
        if (amountRefunded < subtotalRefunded - 1e-9) {
            subtotalRefunded = amountRefunded;
            taxRefunded = 0;
            allocateMoneyAcrossRows(computed, 'line_subtotal', subtotalRefunded);
            allocateMoneyAcrossRows(computed, 'line_tax', 0);
        } else {
            taxRefunded = roundMoney(amountRefunded - subtotalRefunded);
            allocateMoneyAcrossRows(computed, 'line_tax', taxRefunded);
        }
    }
    computed.forEach(line => {
        line.line_total = roundMoney(line.line_subtotal + line.line_tax);
    });

    const settings = await getSettings(conn, ['stock_enabled']);
    // A new untracked sale has authority=none. Historical tracked returns must
    // still use their saved source even when tracking is currently paused.
    const stockEnabled = settings.stock_enabled === '1' || computed.some(line =>
        ['product', 'legacy_product'].includes(line.stock_authority));

    const scope = Array.isArray(items) ? 'item' : 'order';
    const owningShiftId = refundShiftId === undefined ? order.shift_id : refundShiftId;
    const [insert] = await conn.query(
        `INSERT INTO refunds
            (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded,
             refund_method, reason, restocked, user_id, shift_id, table_id, ip_address)
         VALUES ('refund', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [invoiceId, scope, subtotalRefunded, taxRefunded, amountRefunded,
            refundMethod, reason, stockEnabled ? 1 : 0, actorId, owningShiftId,
            order.table_id, ipAddress]
    );
    if(stockEnabled)await prepareStockWrite(conn,{savedItems:lines.map(({item})=>item)});
    const stockItemIds = new Set();
    if (stockEnabled) await restoreStockForCart(conn, computed, { touchedStockItemIds: stockItemIds, savedAuthorityOnly:settings.stock_enabled !== '1', source: { type: 'refund', id: insert.insertId }, businessDate: getBusinessDate(), actorId });
    for (const line of computed) {
        await conn.query(
            `INSERT INTO refund_items
                (refund_id, order_item_id, product_id, item_name, note, quantity,
                 unit_price, line_subtotal, line_tax, line_total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [insert.insertId, line.order_item_id, line.product_id, line.item_name,
                line.note, line.quantity, line.unit_price, line.line_subtotal,
                line.line_tax, line.line_total]
        );
    }

    const reversed = await reverseLinesUsage(conn, {
        lines: lines.map(({ item, quantity }) => ({ lineKey: item.recipe_line_key, qty: quantity })),
        sourceType: 'refund',
        sourceId: insert.insertId,
        sourceLabel: `Refund #${insert.insertId}`,
        actor: { id: actorId },
        businessDate: getBusinessDate()
    });
    const ledgerChangedIngredientIds = reversed.changedIngredientIds;

    await reportInvalidation.invoices(conn, getBusinessDate(), [invoiceId]);

    const refundStatus = await syncOrderRefundStatus(conn, order);

    await appendAuditEvent(conn, {
        eventType: 'refund',
        userId: actorId,
        entityType: 'order',
        entityId: invoiceId,
        oldValue: { payment_method: order.payment_method },
        newValue: {
            refund_id: insert.insertId,
            kind: 'refund',
            amount_refunded: amountRefunded,
            reason
        },
        ipAddress
    });

    return {
        refund_id: Number(insert.insertId),
        kind: 'refund',
        scope,
        refund_status: refundStatus,
        amount_refunded: amountRefunded,
        stock_enabled: stockEnabled,
        shift_id: owningShiftId,
        ledger_changed_ingredient_ids: [...new Set(ledgerChangedIngredientIds.map(Number))],
        stock_product_ids: computed.map(line => line.product_id),
        stock_item_ids: [...stockItemIds]
    };
}

module.exports = { refundPaidOrder, refundError, syncOrderRefundStatus };
