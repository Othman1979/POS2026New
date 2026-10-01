-- 2026-09-12-ingredient-state-v1
-- Requires migration: 2026-09-12-stock-item-identity-v1
-- Requires checksum: 045d0475fd16715e4eafb913a6f7fe839ed7fb7920e2a8d478b86878172de24b
-- Consolidate one-to-one ingredient state. Both movement ledgers remain unchanged.
-- Startup owns the migration lock; run the manual fallback with application writers stopped.
SET @ingredient_state_ok = 1;
SET @ingredient_state_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_ingredient_links'),'SELECT @ingredient_state_ok AND NOT EXISTS(SELECT 1 FROM stock_ingredient_links s LEFT JOIN ingredients i ON i.id=s.ingredient_id WHERE i.id IS NULL) INTO @ingredient_state_ok','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_working_balances'),'SELECT @ingredient_state_ok AND NOT EXISTS(SELECT 1 FROM ingredient_working_balances s LEFT JOIN ingredients i ON i.id=s.ingredient_id WHERE i.id IS NULL) INTO @ingredient_state_ok','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(@ingredient_state_ok=1,'SELECT 1','SELECT * FROM posapp_ingredient_state_requires_review');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
ALTER TABLE ingredients
 ADD COLUMN IF NOT EXISTS stock_item_id BIGINT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS stock_activation_operation_id BIGINT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS stock_movement_watermark BIGINT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS stock_activation_count_id BIGINT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS stock_observation_token CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
 ADD COLUMN IF NOT EXISTS stock_activation_quantity DECIMAL(16,6) NULL,
 ADD COLUMN IF NOT EXISTS stock_activation_quantity_known TINYINT NULL,
 ADD COLUMN IF NOT EXISTS stock_activation_request_key VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
 ADD COLUMN IF NOT EXISTS stock_activated_at DATETIME(6) NULL,
 ADD COLUMN IF NOT EXISTS working_quantity DECIMAL(28,6) NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS working_quantity_known TINYINT(1) NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS working_last_count_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS working_period_usage DECIMAL(28,6) NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS working_variance_qty DECIMAL(28,6) NULL,
 ADD COLUMN IF NOT EXISTS working_initialized TINYINT(1) NOT NULL DEFAULT 0;
SET @ingredient_state_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_ingredient_links'),'UPDATE ingredients i JOIN stock_ingredient_links s ON s.ingredient_id=i.id SET i.stock_item_id=s.stock_item_id,i.stock_activation_operation_id=s.operation_id,i.stock_movement_watermark=s.movement_watermark,i.stock_activation_count_id=s.count_id,i.stock_observation_token=s.observation_token,i.stock_activation_quantity=s.quantity,i.stock_activation_quantity_known=s.quantity_known,i.stock_activation_request_key=s.request_key,i.stock_activated_at=s.activated_at,i.updated_at=i.updated_at','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_ingredient_links'),'SELECT @ingredient_state_ok AND NOT EXISTS(SELECT 1 FROM stock_ingredient_links s LEFT JOIN ingredients i ON i.id=s.ingredient_id WHERE i.id IS NULL OR NOT (i.stock_item_id<=>s.stock_item_id AND i.stock_activation_operation_id<=>s.operation_id AND i.stock_movement_watermark<=>s.movement_watermark AND i.stock_activation_count_id<=>s.count_id AND i.stock_observation_token<=>s.observation_token AND i.stock_activation_quantity<=>s.quantity AND i.stock_activation_quantity_known<=>s.quantity_known AND i.stock_activation_request_key<=>s.request_key AND i.stock_activated_at<=>s.activated_at)) INTO @ingredient_state_ok','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_working_balances'),'UPDATE ingredients i JOIN ingredient_working_balances s ON s.ingredient_id=i.id SET i.working_quantity=s.quantity,i.working_quantity_known=s.quantity_known,i.working_last_count_id=s.last_count_id,i.working_period_usage=s.period_usage,i.working_variance_qty=s.variance_qty,i.working_initialized=s.initialized,i.updated_at=i.updated_at','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_working_balances'),'SELECT @ingredient_state_ok AND NOT EXISTS(SELECT 1 FROM ingredient_working_balances s LEFT JOIN ingredients i ON i.id=s.ingredient_id WHERE i.id IS NULL OR NOT (i.working_quantity<=>s.quantity AND i.working_quantity_known<=>s.quantity_known AND i.working_last_count_id<=>s.last_count_id AND i.working_period_usage<=>s.period_usage AND i.working_variance_qty<=>s.variance_qty AND i.working_initialized<=>s.initialized)) INTO @ingredient_state_ok','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(@ingredient_state_ok=1,'SELECT 1','SELECT * FROM posapp_ingredient_state_copy_mismatch');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND INDEX_NAME='uq_stock_ingredient_item'),'ALTER TABLE ingredients ADD UNIQUE KEY uq_stock_ingredient_item (stock_item_id)','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND INDEX_NAME='uq_stock_ingredient_request'),'ALTER TABLE ingredients ADD UNIQUE KEY uq_stock_ingredient_request (stock_activation_request_key)','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND INDEX_NAME='idx_stock_ingredient_operation'),'ALTER TABLE ingredients ADD KEY idx_stock_ingredient_operation (stock_activation_operation_id)','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND INDEX_NAME='idx_ingredient_working_init'),'ALTER TABLE ingredients ADD KEY idx_ingredient_working_init (working_initialized,id)','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND CONSTRAINT_NAME='fk_ingredient_stock_item'),'ALTER TABLE ingredients ADD CONSTRAINT fk_ingredient_stock_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id)','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND CONSTRAINT_NAME='fk_ingredient_stock_operation'),'ALTER TABLE ingredients ADD CONSTRAINT fk_ingredient_stock_operation FOREIGN KEY (stock_activation_operation_id) REFERENCES stock_operations(id)','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND CONSTRAINT_NAME='ck_ingredient_stock_link'),'ALTER TABLE ingredients ADD CONSTRAINT ck_ingredient_stock_link CHECK (
 (stock_item_id IS NULL AND stock_activation_operation_id IS NULL AND stock_movement_watermark IS NULL
  AND stock_activation_count_id IS NULL AND stock_observation_token IS NULL AND stock_activation_quantity IS NULL
  AND stock_activation_quantity_known IS NULL AND stock_activation_request_key IS NULL AND stock_activated_at IS NULL)
 OR (stock_item_id IS NOT NULL AND stock_activation_operation_id IS NOT NULL AND stock_movement_watermark IS NOT NULL
  AND stock_observation_token IS NOT NULL AND stock_activation_request_key IS NOT NULL AND stock_activated_at IS NOT NULL
  AND stock_activation_quantity_known IS NOT NULL AND stock_activation_quantity_known IN (0,1)
  AND ((stock_activation_quantity_known=0 AND stock_activation_quantity IS NULL) OR (stock_activation_quantity_known=1 AND stock_activation_quantity IS NOT NULL))))','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
SET @ingredient_state_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND CONSTRAINT_NAME='ck_ingredient_working_state'),'ALTER TABLE ingredients ADD CONSTRAINT ck_ingredient_working_state CHECK (working_quantity_known IN (0,1) AND working_initialized IN (0,1))','SELECT 1');
PREPARE ingredient_state_stmt FROM @ingredient_state_sql;
EXECUTE ingredient_state_stmt;
DEALLOCATE PREPARE ingredient_state_stmt;
DROP TABLE IF EXISTS stock_ingredient_links;
DROP TABLE IF EXISTS ingredient_working_balances;
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-12-ingredient-state-v1','2cc330a0d1e14cd68ee38aa92bfb142371926b6752dd3f928c6c1aa53a42f30e')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
