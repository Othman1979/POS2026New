-- 2026-09-08-stock-ingredient-cutover-v1
-- Requires migration: 2026-09-08-stock-availability-policy-v1
-- Requires checksum: 161a876cdeb6ee9b5ce72e1637cfbcaf25d64aa4a20787789abcb116048f8c88
-- Durable ingredient authority cutover and source identity provenance.
-- Provenance is keyed by operation line and source identity, not reconstructed movement IDs.
CREATE TABLE IF NOT EXISTS stock_ingredient_links (
 ingredient_id INT NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 operation_id BIGINT UNSIGNED NOT NULL,
 movement_watermark BIGINT UNSIGNED NOT NULL,
 count_id BIGINT UNSIGNED DEFAULT NULL,
 observation_token CHAR(64) NOT NULL,
 quantity DECIMAL(16,6) DEFAULT NULL,
 quantity_known TINYINT NOT NULL,
 request_key VARCHAR(80) NOT NULL,
 activated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY (ingredient_id),
 UNIQUE KEY uq_stock_ingredient_item (stock_item_id),
 UNIQUE KEY uq_stock_ingredient_request (request_key),
 KEY idx_stock_ingredient_operation (operation_id),
 CONSTRAINT fk_stock_ingredient_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT fk_stock_ingredient_operation FOREIGN KEY (operation_id) REFERENCES stock_operations(id),
 CONSTRAINT ck_stock_ingredient_known CHECK (quantity_known IN (0,1)),
 CONSTRAINT ck_stock_ingredient_quantity CHECK ((quantity_known=0 AND quantity IS NULL) OR (quantity_known=1 AND quantity IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_operation_sources (
 operation_id BIGINT UNSIGNED NOT NULL,
 line_ordinal SMALLINT UNSIGNED NOT NULL,
 source_kind VARCHAR(32) NOT NULL,
 source_type VARCHAR(32) DEFAULT NULL,
 source_id BIGINT DEFAULT NULL,
 source_line VARCHAR(100) DEFAULT NULL,
 ingredient_id INT DEFAULT NULL,
 PRIMARY KEY (operation_id,line_ordinal),
 KEY idx_stock_source_ingredient (ingredient_id,source_type,source_id),
 KEY idx_stock_source_document (source_type,source_id),
 CONSTRAINT fk_stock_source_operation FOREIGN KEY (operation_id) REFERENCES stock_operations(id),
 CONSTRAINT ck_stock_source_kind CHECK (source_kind IN ('ingredient_cutover','ingredient_usage','ingredient_manual','ingredient_correction'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-ingredient-cutover-v1','a6fc46b77ffc44f827b94d1d1ef063deb570e3eb83152347a88f0de759621a5a')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
