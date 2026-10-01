const { roundMoney } = require('./PosCalculator');
const {
    allocateRefundPayment,
    lineSubtotalAfterOrderDiscount,
    lineSubtotalBeforeOrderDiscount,
    orderDiscountApplied,
    paidOrderTimeSql,
    paidOrderRangeWhere,
    refundVoidValueSql,
} = require('./financialSql');
const {
    businessLocalDateSql,
    businessLocalElapsedMinuteSql,
} = require('../utils/businessDate');

function combineFinancialEvents(sales, refunds) {
    const sales_processed = roundMoney(Number(sales.sales_processed) || 0);
    const refunds_issued = roundMoney(Number(refunds.refunds_issued) || 0);
    const sales_collected = roundMoney(sales_processed - refunds_issued);

    const tax = roundMoney(Number(sales.tax) || 0);
    const tax_refunded = roundMoney(Number(refunds.tax_refunded) || 0);
    const tax_collected = roundMoney(tax - tax_refunded);

    const net_revenue_pre_tax = roundMoney(sales_collected - tax_collected);

    const cash = roundMoney(Number(sales.cash) || 0);
    const refund_cash = roundMoney(Number(refunds.refund_cash) || 0);
    const cash_collected = roundMoney(cash - refund_cash);

    const card = roundMoney(Number(sales.card) || 0);
    const refund_card = roundMoney(Number(refunds.refund_card) || 0);
    const card_collected = roundMoney(card - refund_card);
    const platform_sales = roundMoney((Number(sales.platform) || 0) - (Number(refunds.refund_platform) || 0));

    const service_charges_collected = roundMoney(
        (Number(sales.service_charges_collected) || 0) - (Number(refunds.service_charges_refunded) || 0)
    );

    const total_orders = Number(sales.orders) || 0;
    const average_ticket = total_orders > 0 ? roundMoney(sales_processed / total_orders) : 0;
    const refund_order_count = Number(refunds.refund_order_count) || 0;
    const refund_item_count = Number(refunds.refund_item_count) || 0;
    const void_order_count = Number(refunds.void_order_count) || 0;
    const void_item_count = Number(refunds.void_item_count) || 0;

    return {
        sales_processed,
        refunds_issued,
        sales_collected,
        net_revenue_pre_tax,
        tax_collected,
        service_charges_collected,
        cash_collected,
        card_collected,
        platform_sales,
        refund_platform: roundMoney(Number(refunds.refund_platform) || 0),
        total_orders,
        average_ticket,
        discounts_total: roundMoney(Number(sales.discounts_total) || 0),
        discounted_orders: Number(sales.discounted_orders) || 0,
        refund_count: Number(refunds.refund_count) || refund_order_count + refund_item_count,
        refund_order_count,
        refund_item_count,
        void_count: Number(refunds.void_count) || void_order_count + void_item_count,
        void_order_count,
        void_item_count,
        void_value: roundMoney(Number(refunds.void_value) || 0),
    };
}

async function getFinancialEventsForPeriod(executor, startDate, endDate) {
    const [salesRows] = await executor.query(`
        SELECT COUNT(o.invoice_id) AS orders,
               COALESCE(SUM(o.total), 0) AS sales_processed,
               COALESCE(SUM(o.tax), 0) AS tax,
               COALESCE(SUM(CASE
                 WHEN o.payment_method='cash' THEN o.total
                 WHEN o.payment_method='split' THEN COALESCE(o.cash_amount,0)
                 ELSE 0 END), 0) AS cash,
               COALESCE(SUM(CASE
                 WHEN o.payment_method='card' THEN o.total
                 WHEN o.payment_method='split' THEN COALESCE(o.card_amount,0)
                 ELSE 0 END), 0) AS card
               ,COALESCE(SUM(CASE WHEN o.payment_method='platform' THEN o.total ELSE 0 END), 0) AS platform
        FROM orders o
        WHERE ${paidOrderRangeWhere('o')}
    `, [startDate, endDate, startDate, endDate]);
    const sales = salesRows[0] || { orders: 0, sales_processed: 0, tax: 0, cash: 0, card: 0, platform: 0 };

    const [refundRows] = await executor.query(`
        SELECT r.id, r.scope, r.amount_refunded, r.tax_refunded, r.refund_method,
               o.total AS original_total, o.payment_method AS original_payment_method,
               o.cash_amount AS original_cash_amount, o.card_amount AS original_card_amount
        FROM refunds r
        JOIN orders o ON o.invoice_id=r.invoice_id
        WHERE r.kind='refund' AND r.created_at >= ? AND r.created_at < ?
    `, [startDate, endDate]);

    let refunds_issued = 0;
    let tax_refunded = 0;
    let refund_cash = 0;
    let refund_card = 0;
    let refund_platform = 0;
    let refund_count = 0;
    let refund_order_count = 0;
    let refund_item_count = 0;

    for (const refund of refundRows) {
        refunds_issued += Number(refund.amount_refunded) || 0;
        tax_refunded += Number(refund.tax_refunded) || 0;
        refund_count += 1;
        if (refund.scope === 'item') refund_item_count += 1;
        else refund_order_count += 1;
        const allocated = allocateRefundPayment(refund, {
            total: refund.original_total,
            cash_amount: refund.original_cash_amount,
            card_amount: refund.original_card_amount,
        });
        refund_cash += allocated.cash;
        refund_card += allocated.card;
        refund_platform += allocated.platform;
    }

    const [voidRows] = await executor.query(`
        SELECT r.id, r.kind, r.scope, r.subtotal_refunded, r.tax_refunded,
               o.original_total, o.total,
               (SELECT COALESCE(SUM(line_total), 0) FROM refund_items WHERE refund_id = r.id) AS item_total
        FROM refunds r
        LEFT JOIN orders o ON o.invoice_id = r.invoice_id
        WHERE r.kind = 'void' AND r.created_at >= ? AND r.created_at < ?
    `, [startDate, endDate]);

    let void_count = 0;
    let void_value = 0;
    let void_order_count = 0;
    let void_item_count = 0;
    for (const voidRow of voidRows) {
        void_count += 1;
        if (voidRow.scope === 'item') void_item_count += 1;
        else void_order_count += 1;
        let value = 0;
        if (Number(voidRow.item_total) > 0) {
            value = Number(voidRow.item_total);
        } else if ((Number(voidRow.subtotal_refunded) || 0) + (Number(voidRow.tax_refunded) || 0) > 0) {
            value = (Number(voidRow.subtotal_refunded) || 0) + (Number(voidRow.tax_refunded) || 0);
        } else {
            value = Number(voidRow.original_total) || Number(voidRow.total) || 0;
        }
        void_value += value;
    }

    const [discountsRows] = await executor.query(`
        SELECT
            COALESCE(SUM(line_discount), 0) AS line_discounts_total,
            COALESCE(SUM(order_discount), 0) AS order_discounts_total,
            COALESCE(SUM(line_discount + order_discount), 0) AS discounts_total,
            COALESCE(SUM(CASE WHEN line_discount > 0 OR order_discount > 0 THEN 1 ELSE 0 END), 0) AS discount_count
        FROM (
            SELECT
                o.invoice_id,
                ${orderDiscountApplied('o')} AS order_discount,
                COALESCE(line_discounts.line_discount_amount, 0) AS line_discount
            FROM orders o
            LEFT JOIN (
                SELECT
                    oi.invoice_id,
                    COALESCE(SUM(GREATEST(
                        0,
                        (COALESCE(oi.price_at_sale, 0) * COALESCE(oi.quantity, 0))
                          - ${lineSubtotalBeforeOrderDiscount('oi')}
                    )), 0) AS line_discount_amount
                FROM order_items oi
                JOIN orders discount_orders ON discount_orders.invoice_id = oi.invoice_id
                WHERE oi.parent_item_id IS NULL
                  AND ${paidOrderRangeWhere('discount_orders')}
                GROUP BY oi.invoice_id
            ) line_discounts ON line_discounts.invoice_id = o.invoice_id
            WHERE ${paidOrderRangeWhere('o')}
            GROUP BY o.invoice_id, o.subtotal, o.discount_type, o.discount_value, line_discounts.line_discount_amount
        ) discounted_orders
    `, [startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate]);

    const discounts_total = roundMoney(Number(discountsRows[0]?.discounts_total) || 0);
    const discounted_orders = Number(discountsRows[0]?.discount_count) || 0;

    const [scSalesRows] = await executor.query(`
        SELECT COALESCE(SUM(
            ${lineSubtotalAfterOrderDiscount('oi', 'o')} + COALESCE(oi.tax_amount, 0)
        ), 0) AS service_charges_sale
        FROM order_items oi
        JOIN orders o ON o.invoice_id = oi.invoice_id
        WHERE ${paidOrderRangeWhere('o')}
          AND oi.parent_item_id IS NULL
          AND oi.note = 'Auto-Gratuity'
    `, [startDate, endDate, startDate, endDate]);

    const [scRefundRows] = await executor.query(`
        SELECT COALESCE(SUM(ri.line_total), 0) AS service_charges_refund
        FROM refund_items ri
        JOIN refunds r ON r.id = ri.refund_id
        WHERE r.kind = 'refund' AND r.created_at >= ? AND r.created_at < ?
          AND ri.note = 'Auto-Gratuity'
    `, [startDate, endDate]);

    const service_charges_collected = roundMoney(
        (Number(scSalesRows[0]?.service_charges_sale) || 0) -
        (Number(scRefundRows[0]?.service_charges_refund) || 0)
    );

    return {
        orders: Number(sales.orders) || 0,
        sales_processed: Number(sales.sales_processed) || 0,
        tax: Number(sales.tax) || 0,
        cash: Number(sales.cash) || 0,
        card: Number(sales.card) || 0,
        platform: Number(sales.platform) || 0,
        refunds_issued,
        tax_refunded,
        refund_cash,
        refund_card,
        refund_platform,
        refund_count,
        refund_order_count,
        refund_item_count,
        void_count,
        void_order_count,
        void_item_count,
        void_value,
        discounts_total,
        discounted_orders,
        service_charges_collected,
    };
}

function emptyTimelineRow(businessDate, elapsedMinute) {
    return {
        business_date: businessDate,
        elapsed_minute: Number(elapsedMinute),
        sales_processed: 0,
        orders: 0,
        cash: 0,
        card: 0,
        platform: 0,
        refunds_issued: 0,
        tax_refunded: 0,
        refund_cash: 0,
        refund_card: 0,
        refund_platform: 0,
        refund_count: 0,
        discounts_total: 0,
        void_count: 0,
        void_value: 0,
    };
}

function timelineKey(date, minute) {
    return `${date}:${Number(minute)}`;
}

async function getFinancialEventTimeline(executor, range) {
    const paidAt = paidOrderTimeSql('o');
    const saleDate = businessLocalDateSql(paidAt);
    const saleMinute = businessLocalElapsedMinuteSql(paidAt);
    const refundDate = businessLocalDateSql('r.created_at');
    const refundMinute = businessLocalElapsedMinuteSql('r.created_at');
    const lineBeforeDiscount = lineSubtotalBeforeOrderDiscount('oi');

    const [orderResult, refundResult, voidResult] = await Promise.all([
        executor.query(`
            SELECT ${saleDate} AS business_date, ${saleMinute} AS elapsed_minute,
                   COUNT(o.invoice_id) AS orders,
                   COALESCE(SUM(o.total), 0) AS sales_processed,
                   COALESCE(SUM(CASE WHEN o.payment_method='cash' THEN o.total WHEN o.payment_method='split' THEN o.cash_amount ELSE 0 END), 0) AS cash,
                   COALESCE(SUM(CASE WHEN o.payment_method='card' THEN o.total WHEN o.payment_method='split' THEN o.card_amount ELSE 0 END), 0) AS card,
                   COALESCE(SUM(CASE WHEN o.payment_method='platform' THEN o.total ELSE 0 END), 0) AS platform,
                   COALESCE(SUM(${orderDiscountApplied('o')} + COALESCE(ld.line_discount_amount, 0)), 0) AS discounts_total
            FROM orders o
            LEFT JOIN (
                SELECT oi.invoice_id,
                       COALESCE(SUM(GREATEST(0, (oi.price_at_sale * oi.quantity) - ${lineBeforeDiscount})), 0) AS line_discount_amount
                FROM order_items oi
                JOIN orders discount_orders ON discount_orders.invoice_id=oi.invoice_id
                WHERE ${paidOrderRangeWhere('discount_orders')}
                GROUP BY oi.invoice_id
            ) ld ON ld.invoice_id = o.invoice_id
            WHERE ${paidOrderRangeWhere('o')}
            GROUP BY ${saleDate}, ${saleMinute}
        `, [
            range.start, range.end, range.start, range.end,
            range.start, range.end, range.start, range.end,
        ]),
        executor.query(`
            SELECT ${refundDate} AS business_date, ${refundMinute} AS elapsed_minute,
                   r.amount_refunded, r.tax_refunded, r.refund_method,
                   o.cash_amount, o.card_amount
            FROM refunds r
            JOIN orders o ON o.invoice_id = r.invoice_id
            WHERE r.kind='refund' AND r.created_at >= ? AND r.created_at < ?
        `, [range.start, range.end]),
        executor.query(`
            SELECT event_date AS business_date, event_minute AS elapsed_minute,
                   SUM(void_count) AS void_count, SUM(void_value) AS void_value
            FROM (
                SELECT ${refundDate} AS event_date, ${refundMinute} AS event_minute,
                       COUNT(*) AS void_count,
                       COALESCE(SUM(${refundVoidValueSql('r', 'o', 'riv')}), 0) AS void_value
                FROM refunds r
                LEFT JOIN orders o ON o.invoice_id = r.invoice_id
                LEFT JOIN (
                    SELECT ri.refund_id,
                           COALESCE(SUM(ri.line_total), 0) AS item_total,
                           COALESCE(SUM(ri.line_subtotal), 0) AS item_subtotal
                    FROM refund_items ri
                    JOIN refunds scoped_refund ON scoped_refund.id=ri.refund_id
                    WHERE scoped_refund.created_at >= ? AND scoped_refund.created_at < ?
                    GROUP BY ri.refund_id
                ) riv ON riv.refund_id=r.id
                WHERE r.kind='void' AND r.created_at >= ? AND r.created_at < ?
                GROUP BY ${refundDate}, ${refundMinute}
                UNION ALL
                SELECT ${businessLocalDateSql('o.created_at')} AS event_date,
                       ${businessLocalElapsedMinuteSql('o.created_at')} AS event_minute,
                       COUNT(*) AS void_count,
                       COALESCE(SUM(COALESCE(o.original_total, o.total, 0)), 0) AS void_value
                FROM orders o
                WHERE o.payment_method='voided' AND o.created_at >= ? AND o.created_at < ?
                  AND NOT EXISTS (SELECT 1 FROM refunds r2 WHERE r2.invoice_id=o.invoice_id AND r2.kind='void')
                GROUP BY ${businessLocalDateSql('o.created_at')}, ${businessLocalElapsedMinuteSql('o.created_at')}
            ) void_events
            GROUP BY event_date, event_minute
        `, [range.start, range.end, range.start, range.end, range.start, range.end]),
    ]);

    const rows = new Map();
    const rowFor = (date, minute) => {
        const key = timelineKey(date, minute);
        if (!rows.has(key)) rows.set(key, emptyTimelineRow(date, minute));
        return rows.get(key);
    };

    for (const row of orderResult[0]) {
        Object.assign(rowFor(row.business_date, row.elapsed_minute), {
            sales_processed: roundMoney(row.sales_processed),
            orders: Number(row.orders || 0),
            cash: roundMoney(row.cash),
            card: roundMoney(row.card),
            platform: roundMoney(row.platform),
            discounts_total: roundMoney(row.discounts_total),
        });
    }
    for (const refund of refundResult[0]) {
        const row = rowFor(refund.business_date, refund.elapsed_minute);
        const allocated = allocateRefundPayment(refund, refund);
        row.refunds_issued = roundMoney(row.refunds_issued + Number(refund.amount_refunded || 0));
        row.tax_refunded = roundMoney(row.tax_refunded + Number(refund.tax_refunded || 0));
        row.refund_cash = roundMoney(row.refund_cash + allocated.cash);
        row.refund_card = roundMoney(row.refund_card + allocated.card);
        row.refund_platform = roundMoney(row.refund_platform + allocated.platform);
        row.refund_count += 1;
    }
    for (const event of voidResult[0]) {
        const row = rowFor(event.business_date, event.elapsed_minute);
        row.void_count += Number(event.void_count || 0);
        row.void_value = roundMoney(row.void_value + Number(event.void_value || 0));
    }

    return [...rows.values()].sort((a, b) =>
        a.business_date.localeCompare(b.business_date) || a.elapsed_minute - b.elapsed_minute
    );
}

module.exports = {
    allocateRefundPayment,
    combineFinancialEvents,
    getFinancialEventsForPeriod,
    getFinancialEventTimeline,
};
