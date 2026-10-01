-- 2026-09-09-held-order-numbers-v1
-- Requires migration: 2026-09-08-procurement-request-integrity-v1
-- Requires checksum: 257ea0670b30d1755b7d67246355593c49abf93ac15543a83aa98a7153bd157f
-- Existing holds remain unnumbered until their next explicit print/fire action.
ALTER TABLE held_orders ADD COLUMN IF NOT EXISTS order_id INT DEFAULT NULL;
ALTER TABLE held_orders ADD COLUMN IF NOT EXISTS order_seq_scope VARCHAR(40) DEFAULT NULL;
ALTER TABLE held_orders ADD UNIQUE KEY IF NOT EXISTS uq_held_order_sequence (order_seq_scope, order_id);
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-09-held-order-numbers-v1','be050ef6d757dcc9cb35d1bd40653944acc607c277ab467271690dc35f9060ad')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
