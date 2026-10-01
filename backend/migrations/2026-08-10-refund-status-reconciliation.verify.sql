-- Rows returned here are cache mismatches that require investigation.
SELECT o.invoice_id,
       o.refund_status AS cached_status,
       CASE
           WHEN COALESCE(evidence.refund_count, 0)=0 THEN 'none'
           WHEN o.payment_method='voided' AND COALESCE(evidence.void_count, 0)>0 THEN 'full'
           WHEN o.payment_method='unpaid_table' AND COALESCE(evidence.void_count, 0)>0 THEN 'partial'
           WHEN COALESCE(coverage.parent_count, 0)>0
                AND coverage.fully_covered_count=coverage.parent_count
                AND COALESCE(evidence.refunded_amount, 0) + 1e-9 >= COALESCE(o.total, 0) THEN 'full'
           ELSE 'partial'
       END AS expected_status
  FROM orders o
  LEFT JOIN (
      SELECT invoice_id,
             COUNT(*) AS refund_count,
             SUM(CASE WHEN kind='void' THEN 1 ELSE 0 END) AS void_count,
             COALESCE(SUM(amount_refunded), 0) AS refunded_amount
        FROM refunds
       GROUP BY invoice_id
  ) evidence ON evidence.invoice_id=o.invoice_id
  LEFT JOIN (
      SELECT oi.invoice_id,
             COUNT(*) AS parent_count,
             SUM(CASE
                     WHEN COALESCE(ri.refunded_qty, 0) + 1e-9 >= oi.quantity THEN 1
                     ELSE 0
                 END) AS fully_covered_count
        FROM order_items oi
        LEFT JOIN (
            SELECT ri.order_item_id, SUM(ri.quantity) AS refunded_qty
              FROM refund_items ri
              JOIN refunds r ON r.id=ri.refund_id
             WHERE r.kind='refund'
             GROUP BY ri.order_item_id
        ) ri ON ri.order_item_id=oi.id
       WHERE oi.parent_item_id IS NULL
       GROUP BY oi.invoice_id
  ) coverage ON coverage.invoice_id=o.invoice_id
 WHERE o.refund_status <> CASE
     WHEN COALESCE(evidence.refund_count, 0)=0 THEN 'none'
     WHEN o.payment_method='voided' AND COALESCE(evidence.void_count, 0)>0 THEN 'full'
     WHEN o.payment_method='unpaid_table' AND COALESCE(evidence.void_count, 0)>0 THEN 'partial'
          WHEN COALESCE(coverage.parent_count, 0)>0
               AND coverage.fully_covered_count=coverage.parent_count
               AND COALESCE(evidence.refunded_amount, 0) + 1e-9 >= COALESCE(o.total, 0) THEN 'full'
     ELSE 'partial'
 END;
