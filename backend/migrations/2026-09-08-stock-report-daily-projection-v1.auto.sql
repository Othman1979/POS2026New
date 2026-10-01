-- 2026-09-08-stock-report-daily-projection-v1
-- Requires migration: 2026-09-08-ingredient-working-balances-v1
-- Requires checksum: bccb2b82db00b7ce16af34d3adb3f0dd8feedeb9f85beeb9eae956d2ff30fd84
CREATE TABLE IF NOT EXISTS stock_report_daily (
 build_id BIGINT UNSIGNED NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 ingredient_id INT NOT NULL DEFAULT 0,
 location_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 incoming DECIMAL(28,6) NOT NULL DEFAULT 0,
 outgoing DECIMAL(28,6) NOT NULL DEFAULT 0,
 received DECIMAL(28,6) NOT NULL DEFAULT 0,
 used DECIMAL(28,6) NOT NULL DEFAULT 0,
 waste DECIMAL(28,6) NOT NULL DEFAULT 0,
 corrections DECIMAL(28,6) NOT NULL DEFAULT 0,
 used_cost DECIMAL(40,16) NOT NULL DEFAULT 0,
 waste_cost DECIMAL(40,16) NOT NULL DEFAULT 0,
 opening_id BIGINT UNSIGNED DEFAULT NULL,
 PRIMARY KEY(build_id,stock_item_id,ingredient_id,location_id),
 KEY idx_stock_daily_ingredient(build_id,ingredient_id,stock_item_id),
 CONSTRAINT fk_stock_daily_build FOREIGN KEY(build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL WHERE id=1
 AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-daily-projection-v1');
UPDATE stock_report_dirty SET generation=generation+1,pending=1,dirty_at=NOW(6),
 active_build_id=NULL,published_build_id=NULL,published_generation=NULL,as_of=NULL,lease_owner=NULL,lease_until=NULL
 WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-daily-projection-v1');
UPDATE stock_report_builds SET state=IF(state='building','abandoned','obsolete') WHERE state IN ('building','published')
 AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-daily-projection-v1');
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-daily-projection-v1','eff1f4f5ec030b5fff7f637aae7daf5a9b671cdb21dd99d7423e559887314a67')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
