-- 2026-09-08-stock-report-backfill-v1
-- Requires migration: 2026-09-08-stock-resolved-product-links-v1
-- Requires checksum: c00a02a6fda76f018ad8287a9d4a0355564d93a8430f0eb1a0d496dd45ffe301
-- Durable bounded source discovery. New writers enqueue their scopes in-source.
CREATE TABLE IF NOT EXISTS stock_report_backfill (
 source VARCHAR(24) NOT NULL PRIMARY KEY,
 last_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 complete TINYINT(1) NOT NULL DEFAULT 0,
 CONSTRAINT ck_stock_report_backfill_source CHECK (source IN ('orders','refunds','ingredient_movements','stock_operations'))
) ENGINE=InnoDB;
INSERT IGNORE INTO stock_report_backfill(source) VALUES ('orders'),('refunds'),('ingredient_movements'),('stock_operations');
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-backfill-v1','7c7eebb53d2edfc67603cbf1acb12a14c1b240608228df3c6b53d08a1df30cc4')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
