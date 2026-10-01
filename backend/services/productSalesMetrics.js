const { roundMoney } = require('./PosCalculator');
const {
    lineSubtotalAfterOrderDiscount,
    paidOrderTimeSql,
    paidOrderRangeWhere,
} = require('./financialSql');
const { businessLocalDateSql, businessLocalElapsedMinuteSql } = require('../utils/businessDate');

async function getProductSalesByBusinessDate(executor, range) {
    const paidAt = paidOrderTimeSql('o');
    const saleDate = businessLocalDateSql(paidAt);
    const saleMinute = businessLocalElapsedMinuteSql(paidAt);
    const refundDate = businessLocalDateSql('r.created_at');
    const refundMinute = businessLocalElapsedMinuteSql('r.created_at');
    const saleItemName = "CONVERT(COALESCE(oi.item_name, p.name, 'Custom Item') USING utf8mb4) COLLATE utf8mb4_unicode_ci";
    const refundItemName = "CONVERT(COALESCE(ri.item_name, source_oi.item_name, p.name, 'Custom Item') USING utf8mb4) COLLATE utf8mb4_unicode_ci";
    const [rows] = await executor.query(`
        SELECT business_date, elapsed_minute, product_id, item_name, category_id,
               SUM(sold_qty) AS sold_qty, SUM(returned_qty) AS returned_qty,
               SUM(sold_amount) AS sold_amount, SUM(returned_amount) AS returned_amount
        FROM (
            SELECT ${saleDate} AS business_date, ${saleMinute} AS elapsed_minute,
                   oi.product_id, ${saleItemName} AS item_name, p.category_id,
                   SUM(oi.quantity) AS sold_qty, 0 AS returned_qty,
                   SUM(${lineSubtotalAfterOrderDiscount('oi', 'o')} + COALESCE(oi.tax_amount, 0)) AS sold_amount,
                   0 AS returned_amount
            FROM order_items oi
            JOIN orders o ON o.invoice_id=oi.invoice_id
            LEFT JOIN products p ON p.id=oi.product_id
            WHERE ${paidOrderRangeWhere('o')}
              AND oi.parent_item_id IS NULL AND COALESCE(oi.note,'') <> 'Auto-Gratuity'
            GROUP BY ${saleDate}, ${saleMinute}, oi.product_id, ${saleItemName}, p.category_id
            UNION ALL
            SELECT ${refundDate} AS business_date, ${refundMinute} AS elapsed_minute,
                   COALESCE(ri.product_id, source_oi.product_id),
                   ${refundItemName}, p.category_id,
                   0, SUM(ri.quantity), 0, SUM(ri.line_total)
            FROM refund_items ri
            JOIN refunds r ON r.id=ri.refund_id
            JOIN order_items source_oi ON source_oi.id=ri.order_item_id
            LEFT JOIN products p ON p.id=COALESCE(ri.product_id, source_oi.product_id)
            WHERE r.kind='refund' AND r.created_at >= ? AND r.created_at < ?
              AND source_oi.parent_item_id IS NULL AND COALESCE(ri.note,'') <> 'Auto-Gratuity'
            GROUP BY ${refundDate}, ${refundMinute}, COALESCE(ri.product_id, source_oi.product_id),
                     ${refundItemName}, p.category_id
        ) events
        GROUP BY business_date, elapsed_minute, product_id, item_name, category_id
    `, [
        range.start, range.end, range.start, range.end,
        range.start, range.end,
    ]);

    return rows.map(row => ({
        business_date: row.business_date,
        elapsed_minute: Number(row.elapsed_minute),
        product_id: row.product_id,
        item_name: row.item_name,
        category_id: row.category_id,
        sold_qty: Number(row.sold_qty || 0),
        returned_qty: Number(row.returned_qty || 0),
        sold_amount: roundMoney(row.sold_amount),
        returned_amount: roundMoney(row.returned_amount),
        net_units: Number(row.sold_qty || 0) - Number(row.returned_qty || 0),
        net_sales: roundMoney(Number(row.sold_amount || 0) - Number(row.returned_amount || 0)),
    }));
}

async function getProductSalesForPeriod(executor, period) {
    const rows = await getProductSalesByBusinessDate(executor, {
        start: period.business_start_at,
        end: period.business_end_at,
    });
    const grouped = new Map();

    for (const row of rows) {
        const key = `${row.product_id ?? 'custom'}:${row.item_name}:${row.category_id ?? 'none'}`;
        if (!grouped.has(key)) {
            grouped.set(key, {
                product_id: row.product_id,
                item_name: row.item_name,
                category_id: row.category_id,
                sold_qty: 0,
                returned_qty: 0,
                sold_amount: 0,
                returned_amount: 0,
            });
        }
        const target = grouped.get(key);
        target.sold_qty += row.sold_qty;
        target.returned_qty += row.returned_qty;
        target.sold_amount += row.sold_amount;
        target.returned_amount += row.returned_amount;
    }

    return [...grouped.values()].map(row => ({
        ...row,
        sold_amount: roundMoney(row.sold_amount),
        returned_amount: roundMoney(row.returned_amount),
        net_units: row.sold_qty - row.returned_qty,
        net_sales: roundMoney(row.sold_amount - row.returned_amount),
    }));
}

module.exports = {
    getProductSalesByBusinessDate,
    getProductSalesForPeriod,
};
