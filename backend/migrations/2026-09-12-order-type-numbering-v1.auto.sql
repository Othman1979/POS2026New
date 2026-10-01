-- 2026-09-12-order-type-numbering-v1
-- Requires migration: 2026-09-09-held-order-numbers-v1
-- Requires checksum: be050ef6d757dcc9cb35d1bd40653944acc607c277ab467271690dc35f9060ad
-- Existing order IDs/scopes remain unchanged. Prefixes are frozen per business day.
CREATE TABLE IF NOT EXISTS daily_order_type_sequences (
  sequence_date DATE NOT NULL,
  order_type_id INT NOT NULL,
  prefix_ordinal INT UNSIGNED NOT NULL,
  current_value INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (sequence_date, order_type_id),
  UNIQUE KEY uq_daily_type_prefix (sequence_date, prefix_ordinal)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
INSERT IGNORE INTO settings(setting_key,setting_value) VALUES('order_type_numbering','0');
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-12-order-type-numbering-v1','91f50cc44ba575da5014fada4f152a709686b38950eead8eaf732f5a6b99d883')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
