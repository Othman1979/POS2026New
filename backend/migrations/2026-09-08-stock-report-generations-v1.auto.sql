-- 2026-09-08-stock-report-generations-v1
-- Requires migration: 2026-09-08-stock-read-index-v1
-- Requires checksum: 318b60dd24d5961d50e51da89994895022e1bae1f7c24fe2d4ed9a6f954ce081
-- Publication metadata only. No source rows are inferred or activated.
CREATE TABLE IF NOT EXISTS stock_report_builds (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 day DATE NOT NULL,
 scope_id TINYINT UNSIGNED NOT NULL,
 generation BIGINT UNSIGNED NOT NULL,
 state VARCHAR(16) NOT NULL DEFAULT 'building',
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 KEY idx_stock_report_build_cleanup (state,id),
 CONSTRAINT chk_stock_report_build_scope CHECK (scope_id<32),
 CONSTRAINT chk_stock_report_build_state CHECK (state IN ('building','published','abandoned','obsolete'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_report_dirty (
 day DATE NOT NULL,
 scope_id TINYINT UNSIGNED NOT NULL,
 generation BIGINT UNSIGNED NOT NULL DEFAULT 1,
 pending TINYINT(1) NOT NULL DEFAULT 1,
 dirty_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 lease_owner CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
 lease_until DATETIME(6) DEFAULT NULL,
 active_build_id BIGINT UNSIGNED DEFAULT NULL,
 published_build_id BIGINT UNSIGNED DEFAULT NULL,
 published_generation BIGINT UNSIGNED DEFAULT NULL,
 as_of DATETIME(6) DEFAULT NULL,
 PRIMARY KEY (day,scope_id),
 KEY idx_stock_report_pending (pending,dirty_at,day,scope_id),
 CONSTRAINT fk_stock_report_active_build FOREIGN KEY (active_build_id) REFERENCES stock_report_builds(id),
 CONSTRAINT fk_stock_report_published_build FOREIGN KEY (published_build_id) REFERENCES stock_report_builds(id),
 CONSTRAINT chk_stock_report_dirty_scope CHECK (scope_id<32),
 CONSTRAINT chk_stock_report_pending CHECK (pending IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_report_worker (
 id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
 lease_owner CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
 lease_until DATETIME(6) DEFAULT NULL,
 CONSTRAINT chk_stock_report_worker_singleton CHECK (id=1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-generations-v1','724f2c5c996734c9a86f373d82a988468c77c2764a9f681e41de91739542e510')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
