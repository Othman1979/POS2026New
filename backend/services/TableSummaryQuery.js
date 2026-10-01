const SPLIT_SUMMARY_JOIN = `LEFT JOIN (
    SELECT parent_invoice_id, SUM(subtotal) AS split_subtotal, COUNT(*) AS split_count
    FROM held_orders
    WHERE parent_invoice_id IS NOT NULL
    GROUP BY parent_invoice_id
) hs ON hs.parent_invoice_id = o.invoice_id`;

const SPLIT_SUMMARY_COLUMNS = `COALESCE(hs.split_subtotal, o.total) AS active_order_total,
                   COALESCE(hs.split_count, 0) AS active_split_count`;

module.exports = { SPLIT_SUMMARY_JOIN, SPLIT_SUMMARY_COLUMNS };
