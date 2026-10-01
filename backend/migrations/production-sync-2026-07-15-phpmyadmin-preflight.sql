-- READ-ONLY PREFLIGHT. Safe to run in phpMyAdmin.
-- Select the client database before importing this file.
-- Do not import the apply file unless the final blocking_findings value is 0.

SET NAMES utf8mb4;

SELECT DATABASE() AS selected_database, VERSION() AS database_version;

SELECT 'missing_required_tables' AS check_name, COUNT(*) AS findings
FROM (
  SELECT 'orders' table_name UNION ALL SELECT 'order_items' UNION ALL
  SELECT 'held_orders' UNION ALL SELECT 'refunds' UNION ALL
  SELECT 'settings' UNION ALL SELECT 'permissions' UNION ALL
  SELECT 'user_permissions' UNION ALL SELECT 'products' UNION ALL
  SELECT 'users' UNION ALL SELECT 'product_bundle_items'
) required
LEFT JOIN information_schema.TABLES t
  ON t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = required.table_name
WHERE t.TABLE_NAME IS NULL;

SELECT 'open_table_service_charges' AS check_name, COUNT(DISTINCT o.invoice_id) AS findings
FROM orders o
JOIN order_items oi ON oi.invoice_id = o.invoice_id
WHERE o.payment_method = 'unpaid_table' AND oi.note = 'Auto-Gratuity'
UNION ALL
SELECT 'held_service_charges', COUNT(*)
FROM held_orders
WHERE cart_data LIKE '%Auto-Gratuity%'
UNION ALL
SELECT 'non_positive_order_item_quantity', COUNT(*)
FROM order_items WHERE NOT (quantity > 0)
UNION ALL
SELECT 'missing_bundle_parent', COUNT(*)
FROM order_items c
LEFT JOIN order_items p ON p.id = c.parent_item_id
WHERE c.parent_item_id IS NOT NULL AND p.id IS NULL
UNION ALL
SELECT 'cross_invoice_bundle_parent', COUNT(*)
FROM order_items c
JOIN order_items p ON p.id = c.parent_item_id
WHERE c.invoice_id <> p.invoice_id
UNION ALL
SELECT 'nested_bundle_parent', COUNT(*)
FROM order_items c
JOIN order_items p ON p.id = c.parent_item_id
WHERE p.parent_item_id IS NOT NULL
UNION ALL
SELECT 'non_positive_bundle_catalog_quantity', COUNT(*)
FROM product_bundle_items WHERE NOT (qty > 0)
UNION ALL
SELECT 'invalid_held_order_json', COUNT(*)
FROM held_orders
WHERE JSON_VALID(cart_data) = 0
   OR CASE WHEN JSON_VALID(cart_data) = 1
           THEN JSON_TYPE(JSON_EXTRACT(cart_data, '$')) NOT IN ('ARRAY', 'OBJECT')
           ELSE FALSE END
   OR CASE WHEN JSON_VALID(cart_data) = 1 AND JSON_TYPE(JSON_EXTRACT(cart_data, '$')) = 'OBJECT'
           THEN JSON_TYPE(JSON_EXTRACT(cart_data, '$.items')) <> 'ARRAY'
           ELSE FALSE END
UNION ALL
SELECT 'invalid_product_modifier_json', COUNT(*)
FROM products
WHERE modifiers IS NOT NULL AND TRIM(modifiers) <> ''
  AND (JSON_VALID(modifiers) = 0
       OR CASE WHEN JSON_VALID(modifiers) = 1
               THEN JSON_TYPE(JSON_EXTRACT(modifiers, '$')) <> 'ARRAY'
               ELSE FALSE END)
UNION ALL
SELECT 'too_many_product_modifier_groups', COUNT(*)
FROM products
WHERE modifiers IS NOT NULL AND TRIM(modifiers) <> ''
  AND JSON_VALID(modifiers) = 1
  AND JSON_TYPE(JSON_EXTRACT(modifiers, '$')) = 'ARRAY'
  AND JSON_LENGTH(modifiers) > 50;

-- These detail rows must also be empty.
SELECT 'bundle_integrity_detail' AS result_type, reason, invoice_id, row_id, parent_id
FROM (
  SELECT 'non_positive_quantity' reason, oi.invoice_id, oi.id row_id, oi.parent_item_id parent_id
  FROM order_items oi WHERE NOT (oi.quantity > 0)
  UNION ALL
  SELECT 'missing_same_invoice_parent', c.invoice_id, c.id, c.parent_item_id
  FROM order_items c LEFT JOIN order_items p ON p.id = c.parent_item_id
  WHERE c.parent_item_id IS NOT NULL AND p.id IS NULL
  UNION ALL
  SELECT 'cross_invoice_parent', c.invoice_id, c.id, c.parent_item_id
  FROM order_items c JOIN order_items p ON p.id = c.parent_item_id
  WHERE c.invoice_id <> p.invoice_id
  UNION ALL
  SELECT 'nested_parent', c.invoice_id, c.id, c.parent_item_id
  FROM order_items c JOIN order_items p ON p.id = c.parent_item_id
  WHERE p.parent_item_id IS NOT NULL
) findings
ORDER BY invoice_id, row_id, reason;

SELECT
  (
    (SELECT COUNT(*) FROM (
      SELECT 'orders' table_name UNION ALL SELECT 'order_items' UNION ALL
      SELECT 'held_orders' UNION ALL SELECT 'refunds' UNION ALL
      SELECT 'settings' UNION ALL SELECT 'permissions' UNION ALL
      SELECT 'user_permissions' UNION ALL SELECT 'products' UNION ALL
      SELECT 'users' UNION ALL SELECT 'product_bundle_items'
    ) required LEFT JOIN information_schema.TABLES t
      ON t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = required.table_name
    WHERE t.TABLE_NAME IS NULL)
    + (SELECT COUNT(DISTINCT o.invoice_id) FROM orders o JOIN order_items oi ON oi.invoice_id=o.invoice_id
       WHERE o.payment_method='unpaid_table' AND oi.note='Auto-Gratuity')
    + (SELECT COUNT(*) FROM held_orders WHERE cart_data LIKE '%Auto-Gratuity%')
    + (SELECT COUNT(*) FROM order_items WHERE NOT (quantity > 0))
    + (SELECT COUNT(*) FROM order_items c LEFT JOIN order_items p ON p.id=c.parent_item_id
       WHERE c.parent_item_id IS NOT NULL AND p.id IS NULL)
    + (SELECT COUNT(*) FROM order_items c JOIN order_items p ON p.id=c.parent_item_id
       WHERE c.invoice_id <> p.invoice_id)
    + (SELECT COUNT(*) FROM order_items c JOIN order_items p ON p.id=c.parent_item_id
       WHERE p.parent_item_id IS NOT NULL)
    + (SELECT COUNT(*) FROM product_bundle_items WHERE NOT (qty > 0))
    + (SELECT COUNT(*) FROM held_orders
       WHERE JSON_VALID(cart_data)=0
          OR CASE WHEN JSON_VALID(cart_data)=1 THEN JSON_TYPE(JSON_EXTRACT(cart_data,'$')) NOT IN ('ARRAY','OBJECT') ELSE FALSE END
          OR CASE WHEN JSON_VALID(cart_data)=1 AND JSON_TYPE(JSON_EXTRACT(cart_data,'$'))='OBJECT'
                  THEN JSON_TYPE(JSON_EXTRACT(cart_data,'$.items')) <> 'ARRAY' ELSE FALSE END)
    + (SELECT COUNT(*) FROM products
       WHERE modifiers IS NOT NULL AND TRIM(modifiers) <> ''
         AND (JSON_VALID(modifiers)=0
              OR CASE WHEN JSON_VALID(modifiers)=1 THEN JSON_TYPE(JSON_EXTRACT(modifiers,'$')) <> 'ARRAY' ELSE FALSE END))
    + (SELECT COUNT(*) FROM products
       WHERE modifiers IS NOT NULL AND TRIM(modifiers) <> ''
         AND JSON_VALID(modifiers)=1
         AND JSON_TYPE(JSON_EXTRACT(modifiers,'$'))='ARRAY'
         AND JSON_LENGTH(modifiers)>50)
  ) AS blocking_findings,
  'Must be 0 before applying' AS required_result;
