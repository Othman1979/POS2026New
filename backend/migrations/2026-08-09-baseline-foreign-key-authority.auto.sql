-- Hostinger-safe automatic form of 2026-08-09-baseline-foreign-key-authority-v1.
-- Existing rows are preserved. Any orphaned reference fails the affected FK add;
-- every earlier add is idempotent, so the next run safely resumes after correction.

SET NAMES utf8mb4;

ALTER TABLE user_permissions
  ADD CONSTRAINT fk_uperm_user FOREIGN KEY IF NOT EXISTS (user_id)
    REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE user_permissions
  ADD CONSTRAINT fk_uperm_perm FOREIGN KEY IF NOT EXISTS (perm_key)
    REFERENCES permissions(perm_key) ON DELETE CASCADE;

ALTER TABLE restaurant_tables
  ADD CONSTRAINT fk_parent_table FOREIGN KEY IF NOT EXISTS (parent_table_id)
    REFERENCES restaurant_tables(id) ON DELETE SET NULL;

ALTER TABLE restaurant_tables
  ADD CONSTRAINT restaurant_tables_ibfk_1 FOREIGN KEY IF NOT EXISTS (section_id)
    REFERENCES sections(id) ON DELETE RESTRICT;

ALTER TABLE shifts
  ADD CONSTRAINT shifts_ibfk_1 FOREIGN KEY IF NOT EXISTS (user_id)
    REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_ibfk_1 FOREIGN KEY IF NOT EXISTS (invoice_id)
    REFERENCES orders(invoice_id) ON DELETE CASCADE;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_ibfk_2 FOREIGN KEY IF NOT EXISTS (product_id)
    REFERENCES products(id) ON DELETE RESTRICT;

ALTER TABLE refund_items
  ADD CONSTRAINT fk_refund_items_refund FOREIGN KEY IF NOT EXISTS (refund_id)
    REFERENCES refunds(id) ON DELETE CASCADE;

ALTER TABLE qr_table_drafts
  ADD CONSTRAINT qr_table_drafts_ibfk_1 FOREIGN KEY IF NOT EXISTS (table_id)
    REFERENCES restaurant_tables(id) ON DELETE CASCADE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-09-baseline-foreign-key-authority-v1',
  '8f6e50495f7f7781507e692ac959beedaf622b5978bc6e9e2ac8d711282cd937'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
