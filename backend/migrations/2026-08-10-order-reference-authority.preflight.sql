-- Read-only preflight for 2026-08-10-order-reference-authority-v1.
SELECT 'waiter_orphans' AS check_name, COUNT(*) AS orphan_count
FROM orders o LEFT JOIN users u ON u.id=o.waiter_id
WHERE o.waiter_id IS NOT NULL AND u.id IS NULL;
SELECT 'order_type_orphans' AS check_name, COUNT(*) AS orphan_count
FROM orders o LEFT JOIN order_types ot ON ot.id=o.order_type_id
WHERE o.order_type_id IS NOT NULL AND ot.id IS NULL;
SELECT 'customer_orphans' AS check_name, COUNT(*) AS orphan_count
FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
WHERE o.customer_id IS NOT NULL AND c.id IS NULL;
SELECT 'table_orphans' AS check_name, COUNT(*) AS orphan_count
FROM orders o LEFT JOIN restaurant_tables t ON t.id=o.table_id
WHERE o.table_id IS NOT NULL AND t.id IS NULL;
