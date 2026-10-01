-- Read-only preflight for 2026-08-10-legacy-permission-column-retirement-v1.
SELECT COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'users'
  AND COLUMN_NAME IN (
    'can_view_orders','canholdorders','can_update_table','can_apply_discount','can_void_items',
    'can_open_register','can_checkout_tables','bypass_existing_tables','bypass_printed_tables',
    'can_view_order_history','can_transfer_table','can_join_tables','can_split_bills',
    'waiter_split_bill','can_print_check'
  )
ORDER BY COLUMN_NAME;

SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('permissions','user_permissions')
ORDER BY TABLE_NAME;
