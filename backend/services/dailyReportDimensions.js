const { roundMoney } = require('./PosCalculator');

async function buildOrderTypeBreakdown(executor, period) {
    const [rows] = await executor.query(`
        SELECT
            events.order_type_id,
            events.name,
            SUM(events.orders) AS orders,
            SUM(events.sold_amount) AS sold_amount,
            SUM(events.returned_amount) AS returned_amount
        FROM (
            SELECT
                o.order_type_id,
                COALESCE(ot.name, 'Other') AS name,
                COUNT(o.invoice_id) AS orders,
                COALESCE(SUM(o.total), 0) AS sold_amount,
                0 AS returned_amount
            FROM orders o
            LEFT JOIN order_types ot ON ot.id = o.order_type_id
            WHERE COALESCE(o.invoice_issued_at, o.created_at) >= ?
              AND COALESCE(o.invoice_issued_at, o.created_at) < ?
              AND o.payment_method NOT IN ('unpaid_table', 'voided')
            GROUP BY o.order_type_id, COALESCE(ot.name, 'Other')

            UNION ALL

            SELECT
                o.order_type_id,
                COALESCE(ot.name, 'Other') AS name,
                0 AS orders,
                0 AS sold_amount,
                COALESCE(SUM(r.amount_refunded), 0) AS returned_amount
            FROM refunds r
            JOIN orders o ON o.invoice_id = r.invoice_id
            LEFT JOIN order_types ot ON ot.id = o.order_type_id
            WHERE r.kind = 'refund'
              AND r.created_at >= ?
              AND r.created_at < ?
            GROUP BY o.order_type_id, COALESCE(ot.name, 'Other')
        ) events
        GROUP BY events.order_type_id, events.name
        ORDER BY (SUM(events.sold_amount) - SUM(events.returned_amount)) DESC, events.name ASC
    `, [
        period.business_start_at,
        period.business_end_at,
        period.business_start_at,
        period.business_end_at,
    ]);

    return rows.map(row => {
        const soldAmount = roundMoney(Number(row.sold_amount) || 0);
        const returnedAmount = roundMoney(Number(row.returned_amount) || 0);
        return {
            id: row.order_type_id,
            order_type_id: row.order_type_id,
            name: row.name || 'Other',
            orders: Number(row.orders) || 0,
            sold_amount: soldAmount,
            returned_amount: returnedAmount,
            net_sales: roundMoney(soldAmount - returnedAmount),
        };
    });
}

module.exports = { buildOrderTypeBreakdown };
