-- 2026-09-08-stock-adjustments-v1
-- Requires migration: 2026-09-07-ingredient-analysis-v1
-- Requires checksum: e83dc402889a86726e63c672f4d2c9e8a67aa8c24180ac13cf6b9d16f440ac60
-- Legacy product authority remains active; no history is inferred or backfilled.
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_version BIGINT UNSIGNED NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS stock_operations (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 request_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 kind VARCHAR(24) NOT NULL,
 actor_id INT DEFAULT NULL,
 legacy_product_id INT DEFAULT NULL,
 result_json JSON DEFAULT NULL,
 posted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 UNIQUE KEY uq_stock_operation_request (request_key),
 KEY idx_stock_operation_product (legacy_product_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO schema_migrations (migration_name,checksum) VALUES ('2026-09-08-stock-adjustments-v1','24dc1b1c7b16edb759bfdd7bcb0a67fdd7c13f2a75bd8388e98f4cb6a6a528cc')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
