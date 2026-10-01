-- Hostinger-safe automatic form of 2026-08-10-legacy-permission-column-retirement-v1.
-- Remove only proven-unused users columns; all user and canonical grant rows remain.

SET NAMES utf8mb4;

ALTER TABLE users DROP COLUMN IF EXISTS can_view_orders;
ALTER TABLE users DROP COLUMN IF EXISTS canholdorders;
ALTER TABLE users DROP COLUMN IF EXISTS can_update_table;
ALTER TABLE users DROP COLUMN IF EXISTS can_apply_discount;
ALTER TABLE users DROP COLUMN IF EXISTS can_void_items;
ALTER TABLE users DROP COLUMN IF EXISTS can_open_register;
ALTER TABLE users DROP COLUMN IF EXISTS can_checkout_tables;
ALTER TABLE users DROP COLUMN IF EXISTS bypass_existing_tables;
ALTER TABLE users DROP COLUMN IF EXISTS bypass_printed_tables;
ALTER TABLE users DROP COLUMN IF EXISTS can_view_order_history;
ALTER TABLE users DROP COLUMN IF EXISTS can_transfer_table;
ALTER TABLE users DROP COLUMN IF EXISTS can_join_tables;
ALTER TABLE users DROP COLUMN IF EXISTS can_split_bills;
ALTER TABLE users DROP COLUMN IF EXISTS waiter_split_bill;
ALTER TABLE users DROP COLUMN IF EXISTS can_print_check;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-10-legacy-permission-column-retirement-v1',
  'd3bf428849b637d8efd463cc3a7ad0db920dee08ecb676d1d44099b335ecb550'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
