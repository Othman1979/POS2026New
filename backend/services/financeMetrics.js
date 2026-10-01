const {
    REFUNDS_ROLLUP_JOIN,
    NET_TOTAL,
    NET_TAX,
    NET_CASH,
    NET_CARD,
    NET_PLATFORM,
    activeOrderDiscountApplied,
    ACTIVE_ORDER_DISCOUNT_SUMS,
    paidOrderTimeSql,
    refundItemsValueJoin,
    refundVoidValueSql,
    refundVoidSubtotalSql,
    paidOrderWhere,
} = require('./financialSql');
const {
    addBusinessDays,
    businessLocalDateSql,
    businessLocalHourSql,
    businessLocalHourSortSql,
    getBusinessDateRange,
} = require('../utils/businessDate');

const toNumber = (value) => Number(value || 0);

const moneyDelta = (current, prior) => {
    const currentValue = toNumber(current);
    const priorValue = toNumber(prior);
    return {
        amount: currentValue - priorValue,
        percent: priorValue > 0 ? ((currentValue - priorValue) / priorValue) * 100 : null
    };
};

const normalizeMetrics = (orders = {}, discounts = {}, voids = {}, refunds = {}) => {
    const salesInclTax = toNumber(orders.sales_incl_tax);
    const taxCollected = toNumber(orders.tax_collected);
    const orderCount = toNumber(orders.order_count);
    const discountsTotal = toNumber(discounts.discounts_total);
    const discountCount = toNumber(discounts.discount_count);

    return {
        total_orders: orderCount,
        order_count: orderCount,
        gross_sales: salesInclTax,
        sales_incl_tax: salesInclTax,
        subtotal_sales: toNumber(orders.net_sales_pre_tax),
        net_sales_pre_tax: toNumber(orders.net_sales_pre_tax),
        total_tax: taxCollected,
        tax_collected: taxCollected,
        cash_sales: toNumber(orders.cash_sales),
        card_sales: toNumber(orders.card_sales),
        platform_sales: toNumber(orders.platform_sales),
        avg_check: toNumber(orders.avg_check),
        discounted_orders_count: discountCount,
        discount_count: discountCount,
        total_discounts: discountsTotal,
        discounts_total: discountsTotal,
        line_discounts_total: toNumber(discounts.line_discounts_total),
        order_discounts_total: toNumber(discounts.order_discounts_total),
        avg_discount: toNumber(discounts.avg_discount),
        refund_count: toNumber(refunds.refund_count),
        refunds_total: toNumber(refunds.refunds_total),
        void_count: toNumber(voids.void_count),
        void_value: toNumber(voids.void_value),
        void_orders_count: toNumber(voids.void_count),
        void_total_sales: toNumber(voids.void_value),
        void_subtotal_sales: toNumber(voids.void_subtotal_value)
    };
};

async function getFinancialMetricsForRange(executor, range) {
    const params = [range.start, range.end];
    const [ordersRows, discountRows, voidRows, refundRows] = await Promise.all([
        executor.query(`
            SELECT
                COUNT(o.invoice_id) AS order_count,
                COALESCE(SUM(${NET_TOTAL}), 0) AS sales_incl_tax,
                COALESCE(SUM(${NET_TAX}), 0) AS tax_collected,
                COALESCE(SUM(${NET_TOTAL} - ${NET_TAX}), 0) AS net_sales_pre_tax,
                COALESCE(SUM(${NET_CASH}), 0) AS cash_sales,
                COALESCE(SUM(${NET_CARD}), 0) AS card_sales,
                COALESCE(SUM(${NET_PLATFORM}), 0) AS platform_sales,
                CASE WHEN COUNT(o.invoice_id) > 0 THEN COALESCE(SUM(${NET_TOTAL}), 0) / COUNT(o.invoice_id) ELSE 0 END AS avg_check
            FROM orders o
            ${REFUNDS_ROLLUP_JOIN}
            WHERE ${paidOrderWhere('o')}
        `, params),
        executor.query(`
            SELECT
                COALESCE(SUM(line_discount), 0) AS line_discounts_total,
                COALESCE(SUM(order_discount), 0) AS order_discounts_total,
                COALESCE(SUM(line_discount + order_discount), 0) AS discounts_total,
                COALESCE(SUM(CASE WHEN line_discount > 0 OR order_discount > 0 THEN 1 ELSE 0 END), 0) AS discount_count,
                CASE
                    WHEN SUM(CASE WHEN line_discount > 0 OR order_discount > 0 THEN 1 ELSE 0 END) > 0
                    THEN COALESCE(SUM(line_discount + order_discount), 0) / SUM(CASE WHEN line_discount > 0 OR order_discount > 0 THEN 1 ELSE 0 END)
                    ELSE 0
                END AS avg_discount
            FROM (
                SELECT
                    o.invoice_id,
                    ${activeOrderDiscountApplied('o', 'ads')} AS order_discount,
                    COALESCE(ads.line_discount_amount, 0) AS line_discount
                FROM orders o
                LEFT JOIN ${ACTIVE_ORDER_DISCOUNT_SUMS} ads ON ads.invoice_id = o.invoice_id
                WHERE ${paidOrderWhere('o')}
                GROUP BY o.invoice_id, o.subtotal, o.discount_type, o.discount_value, ads.active_subtotal_before_order_discount, ads.line_discount_amount
            ) discounted_orders
        `, params),
        executor.query(`
            SELECT
                COALESCE(SUM(void_count), 0) AS void_count,
                COALESCE(SUM(void_value), 0) AS void_value,
                COALESCE(SUM(void_subtotal_value), 0) AS void_subtotal_value
            FROM (
                SELECT
                    COUNT(*) AS void_count,
                    COALESCE(SUM(${refundVoidValueSql('r', 'o', 'riv')}), 0) AS void_value,
                    COALESCE(SUM(${refundVoidSubtotalSql('r', 'o', 'riv')}), 0) AS void_subtotal_value
                FROM refunds r
                LEFT JOIN orders o ON o.invoice_id = r.invoice_id
                ${refundItemsValueJoin('r', 'riv')}
                WHERE r.kind = 'void' AND r.created_at >= ? AND r.created_at < ?
                UNION ALL
                SELECT
                    COUNT(*) AS void_count,
                    COALESCE(SUM(COALESCE(o.original_total, o.total, 0)), 0) AS void_value,
                    COALESCE(SUM(COALESCE(o.original_subtotal, o.subtotal, 0)), 0) AS void_subtotal_value
                FROM orders o
                WHERE o.created_at >= ? AND o.created_at < ?
                  AND o.payment_method = 'voided'
                  AND NOT EXISTS (
                    SELECT 1 FROM refunds r2
                    WHERE r2.invoice_id = o.invoice_id AND r2.kind = 'void'
                  )
            ) void_events
        `, [...params, ...params]),
        executor.query(`
            SELECT
                COALESCE(SUM(CASE WHEN kind = 'refund' THEN 1 ELSE 0 END), 0) AS refund_count,
                COALESCE(SUM(CASE WHEN kind = 'refund' THEN amount_refunded ELSE 0 END), 0) AS refunds_total
            FROM refunds
            WHERE created_at >= ? AND created_at < ?
        `, params)
    ]);

    return normalizeMetrics(
        ordersRows[0][0],
        discountRows[0][0],
        voidRows[0][0],
        refundRows[0][0]
    );
}

async function getFinancialTrend(executor, startDate, endDate) {
    const range = getBusinessDateRange(startDate, endDate);
    const [orderRows] = await executor.query(`
        SELECT
            ${businessLocalDateSql(paidOrderTimeSql('o'))} AS business_date,
            COUNT(o.invoice_id) AS order_count,
            COALESCE(SUM(${NET_TOTAL}), 0) AS sales_incl_tax,
            COALESCE(SUM(${NET_TAX}), 0) AS tax_collected,
            COALESCE(SUM(${NET_TOTAL} - ${NET_TAX}), 0) AS net_sales_pre_tax
        FROM orders o
        ${REFUNDS_ROLLUP_JOIN}
        WHERE ${paidOrderWhere('o')}
        GROUP BY ${businessLocalDateSql(paidOrderTimeSql('o'))}
        ORDER BY business_date ASC
    `, [range.start, range.end]);

    const byDate = new Map(orderRows.map(row => [row.business_date, row]));
    const trend = [];
    for (let date = startDate; date <= endDate; date = addBusinessDays(date, 1)) {
        const row = byDate.get(date) || {};
        trend.push({
            business_date: date,
            order_count: toNumber(row.order_count),
            sales_incl_tax: toNumber(row.sales_incl_tax),
            net_sales_pre_tax: toNumber(row.net_sales_pre_tax),
            tax_collected: toNumber(row.tax_collected)
        });
    }
    return trend;
}

async function getHourlyFinancialsForRange(executor, range) {
    const [rows] = await executor.query(`
        SELECT
            ${businessLocalHourSql(paidOrderTimeSql('o'))} AS sales_hour,
            COUNT(o.invoice_id) AS order_count,
            COALESCE(SUM(${NET_TOTAL}), 0) AS sales_incl_tax
        FROM orders o
        ${REFUNDS_ROLLUP_JOIN}
        WHERE ${paidOrderWhere('o')}
        GROUP BY ${businessLocalHourSql(paidOrderTimeSql('o'))}
        ORDER BY ${businessLocalHourSortSql(paidOrderTimeSql('o'))} ASC, sales_hour ASC
    `, [range.start, range.end]);

    return rows.map(row => ({
        sales_hour: Number(row.sales_hour),
        order_count: Number(row.order_count || 0),
        sales_incl_tax: Number(row.sales_incl_tax || 0)
    }));
}

function withPriorDayDeltas(current, prior) {
    return {
        sales_incl_tax: moneyDelta(current.sales_incl_tax, prior.sales_incl_tax),
        net_sales_pre_tax: moneyDelta(current.net_sales_pre_tax, prior.net_sales_pre_tax),
        tax_collected: moneyDelta(current.tax_collected, prior.tax_collected),
        discounts_total: moneyDelta(current.discounts_total, prior.discounts_total)
    };
}

module.exports = {
    getFinancialMetricsForRange,
    getFinancialTrend,
    getHourlyFinancialsForRange,
    withPriorDayDeltas,
};
