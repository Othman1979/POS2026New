-- 2026-09-08-stock-report-facts-v1
-- Requires migration: 2026-09-08-stock-report-generations-v1
-- Requires checksum: 724f2c5c996734c9a86f373d82a988468c77c2764a9f681e41de91739542e510
-- Derived staging only. Published generation pointers control visibility.
-- The bounded invoice-line reader names this existing composite index.
-- Ensure older installations with an equivalent differently named index work.
ALTER TABLE order_items ADD INDEX IF NOT EXISTS idx_order_items_parent_invoice (parent_item_id,invoice_id);
CREATE TABLE IF NOT EXISTS stock_report_meals (
 build_id BIGINT UNSIGNED NOT NULL,
 product_id INT NOT NULL,
 name VARCHAR(255) DEFAULT NULL,
 sold DECIMAL(28,6) NOT NULL DEFAULT 0,
 refunded DECIMAL(28,6) NOT NULL DEFAULT 0,
 net_revenue_cents BIGINT NOT NULL DEFAULT 0,
 known_cost DECIMAL(40,16) NOT NULL DEFAULT 0,
 incomplete_lines BIGINT UNSIGNED NOT NULL DEFAULT 0,
 legacy_lines BIGINT UNSIGNED NOT NULL DEFAULT 0,
 unallocated_records BIGINT UNSIGNED NOT NULL DEFAULT 0,
 unallocated_revenue_cents BIGINT NOT NULL DEFAULT 0,
 excluded_revenue_cents BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY (build_id,product_id),
 CONSTRAINT fk_stock_report_meal_build FOREIGN KEY (build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_report_ingredients (
 build_id BIGINT UNSIGNED NOT NULL,
 product_id INT NOT NULL,
 ingredient_id INT NOT NULL,
 name VARCHAR(255) NOT NULL,
 display_unit VARCHAR(8) NOT NULL,
 qty DECIMAL(40,16) NOT NULL DEFAULT 0,
 known_cost DECIMAL(40,16) NOT NULL DEFAULT 0,
 incomplete TINYINT(1) NOT NULL DEFAULT 0,
 PRIMARY KEY (build_id,product_id,ingredient_id),
 KEY idx_stock_report_ingredient (build_id,ingredient_id,product_id),
 CONSTRAINT fk_stock_report_ingredient_build FOREIGN KEY (build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_report_events (
 build_id BIGINT UNSIGNED NOT NULL,
 kind VARCHAR(8) NOT NULL,
 source_id BIGINT UNSIGNED NOT NULL,
 source_line_id BIGINT UNSIGNED NOT NULL,
 invoice_id INT NOT NULL,
 product_id INT NOT NULL,
 event_at DATETIME NOT NULL,
 quantity DECIMAL(28,6) NOT NULL,
 net_revenue_cents BIGINT NOT NULL,
 known_cost DECIMAL(40,16) NOT NULL,
 incomplete TINYINT(1) NOT NULL,
 PRIMARY KEY (build_id,kind,source_id,source_line_id),
 KEY idx_stock_report_product_event (build_id,product_id,event_at,source_line_id),
 CONSTRAINT fk_stock_report_event_build FOREIGN KEY (build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE,
 CONSTRAINT chk_stock_report_event_kind CHECK (kind IN ('sale','refund'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_report_operations (
 build_id BIGINT UNSIGNED NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 ingredient_id INT NOT NULL DEFAULT 0,
 kind VARCHAR(24) NOT NULL,
 source_type VARCHAR(24) NOT NULL,
 qty DECIMAL(28,6) NOT NULL DEFAULT 0,
 known_cost DECIMAL(40,16) NOT NULL DEFAULT 0,
 uncosted_qty DECIMAL(28,6) NOT NULL DEFAULT 0,
 movement_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
 PRIMARY KEY (build_id,stock_item_id,ingredient_id,kind,source_type),
 CONSTRAINT fk_stock_report_operation_build FOREIGN KEY (build_id) REFERENCES stock_report_builds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Revoke metadata-only publications when typed facts are installed.
-- Guard the one-time invalidation when the cumulative manual SQL is rerun.
UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL
 WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-facts-v1');
UPDATE stock_report_dirty SET generation=generation+1,pending=1,dirty_at=NOW(6),
 active_build_id=NULL,published_build_id=NULL,published_generation=NULL,as_of=NULL,lease_owner=NULL,lease_until=NULL
 WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-facts-v1');
UPDATE stock_report_builds SET state=CASE WHEN state='published' THEN 'obsolete' ELSE 'abandoned' END
 WHERE state IN ('building','published') AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-facts-v1');
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-facts-v1','c4797f565bb206d531d832e567328842dad770a2efcc5ed55959dc317f41e8eb')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
