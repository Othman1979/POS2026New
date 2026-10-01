-- POST-DEPLOY VERIFICATION for the client database named `posapp`.
-- Every missing_count/finding_count must be 0.
SET NAMES utf8mb4;
USE `posapp`;

SELECT DATABASE() AS selected_database, VERSION() AS database_version;

SELECT 'required_columns' AS check_name, 7-COUNT(*) AS missing_count
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA='posapp' AND (
  (TABLE_NAME='orders' AND COLUMN_NAME IN ('tax_inclusive_at_sale','service_charge_snapshot_id')) OR
  (TABLE_NAME='held_orders' AND COLUMN_NAME='service_charge_snapshot_id') OR
  (TABLE_NAME='order_items' AND COLUMN_NAME IN ('selected_modifiers','modifier_surcharge','created_at')) OR
  (TABLE_NAME='refunds' AND COLUMN_NAME='table_number')
)
UNION ALL
SELECT 'service_charge_snapshots_table', 1-COUNT(*)
FROM information_schema.TABLES
WHERE TABLE_SCHEMA='posapp' AND TABLE_NAME='service_charge_snapshots'
UNION ALL
SELECT 'service_charge_foreign_keys', 2-COUNT(*)
FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA='posapp' AND CONSTRAINT_TYPE='FOREIGN KEY'
  AND CONSTRAINT_NAME IN ('fk_orders_service_charge_snapshot','fk_held_service_charge_snapshot')
UNION ALL
SELECT 'auto_service_charge_setting', 1-COUNT(*)
FROM `posapp`.`settings` WHERE setting_key='auto_apply_service_charge'
UNION ALL
SELECT 'null_order_item_created_at', COUNT(*)
FROM `posapp`.`order_items` WHERE created_at IS NULL
UNION ALL
SELECT 'obsolete_tax_permission', COUNT(*)
FROM `posapp`.`permissions` WHERE perm_key='pos.tax_exempt'
UNION ALL
SELECT 'obsolete_tax_grants', COUNT(*)
FROM `posapp`.`user_permissions` WHERE perm_key='pos.tax_exempt';

SELECT 'bundle_unique_index' AS check_name, 1-COUNT(*) AS missing_count
FROM (
  SELECT INDEX_NAME FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA='posapp' AND TABLE_NAME='order_items'
  GROUP BY INDEX_NAME,NON_UNIQUE
  HAVING NON_UNIQUE=0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='id,invoice_id'
) x
UNION ALL
SELECT 'bundle_child_index',1-COUNT(*) FROM (
  SELECT INDEX_NAME FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA='posapp' AND TABLE_NAME='order_items'
  GROUP BY INDEX_NAME
  HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='parent_item_id,invoice_id'
) x
UNION ALL
SELECT 'positive_quantity_check',1-COUNT(*)
FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA='posapp' AND TABLE_NAME='order_items'
  AND CONSTRAINT_NAME='chk_order_items_quantity_positive' AND CONSTRAINT_TYPE='CHECK';

SELECT 'modifier_rows_without_stable_ids' AS check_name, COUNT(*) AS finding_count
FROM `posapp`.`products`
WHERE modifiers IS NOT NULL AND TRIM(modifiers)<>''
  AND JSON_VALID(modifiers)=1
  AND modifiers NOT REGEXP '"id"[[:space:]]*:';

SELECT 'Verification complete: every count above must be 0.' AS result;
