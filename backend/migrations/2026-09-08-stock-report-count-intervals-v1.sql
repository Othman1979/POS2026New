-- 2026-09-08-stock-report-count-intervals-v1
-- Requires migration: 2026-09-08-stock-report-backfill-v1
-- Requires checksum: 7c7eebb53d2edfc67603cbf1acb12a14c1b240608228df3c6b53d08a1df30cc4
CREATE TABLE IF NOT EXISTS stock_report_counts (
 build_id BIGINT UNSIGNED NOT NULL,
 ingredient_id INT NOT NULL,
 count_id BIGINT UNSIGNED NOT NULL,
 previous_count_id BIGINT UNSIGNED NOT NULL,
 count_at DATETIME NOT NULL,
 count_qty DECIMAL(28,6) NOT NULL,
 received DECIMAL(28,6) NOT NULL DEFAULT 0,
 theoretical DECIMAL(28,6) NOT NULL DEFAULT 0,
 waste DECIMAL(28,6) NOT NULL DEFAULT 0,
 PRIMARY KEY(build_id,ingredient_id,count_id),
 KEY idx_stock_report_count_interval(ingredient_id,count_id,build_id),
 CONSTRAINT fk_stock_report_count_build FOREIGN KEY(build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_report_count_corrections (
 build_id BIGINT UNSIGNED NOT NULL,
 ingredient_id INT NOT NULL,
 count_id BIGINT UNSIGNED NOT NULL,
 original_id BIGINT UNSIGNED NOT NULL,
 kind VARCHAR(8) NOT NULL,
 qty DECIMAL(28,6) NOT NULL,
 PRIMARY KEY(build_id,ingredient_id,count_id,original_id),
 KEY idx_stock_report_count_correction(ingredient_id,count_id,original_id,build_id),
 CONSTRAINT fk_stock_report_count_correction_build FOREIGN KEY(build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL WHERE id=1
 AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-count-intervals-v1');
UPDATE stock_report_dirty SET generation=generation+1,pending=1,dirty_at=NOW(6),
 active_build_id=NULL,published_build_id=NULL,published_generation=NULL,as_of=NULL,lease_owner=NULL,lease_until=NULL
 WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-count-intervals-v1');
UPDATE stock_report_builds SET state=IF(state='building','abandoned','obsolete') WHERE state IN ('building','published')
 AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-count-intervals-v1');
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-count-intervals-v1','6279aa3e466c57d56ad077c67728e68f39e3369a9d61fffa232ba7eb701d61c4')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
