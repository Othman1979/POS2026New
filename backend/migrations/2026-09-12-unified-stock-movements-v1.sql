-- 2026-09-12-unified-stock-movements-v1
-- Requires migration: 2026-09-12-ingredient-state-v1
-- Requires checksum: 2cc330a0d1e14cd68ee38aa92bfb142371926b6752dd3f928c6c1aa53a42f30e
-- Stop every application writer/worker during this upgrade. Back up before DDL.
-- Original IDs are scoped by movement_type; no history is renumbered or discarded.
-- New ingredient movements can carry their physical effect on the same row.
SET @unified_movement_sql = IF(NOT (EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-12-ingredient-state-v1' AND checksum='2cc330a0d1e14cd68ee38aa92bfb142371926b6752dd3f928c6c1aa53a42f30e') AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-12-unified-stock-movements-v1' AND checksum<>'91cba75ab3e889134d546233f79ccaa6e2dc8a7d0f9cabf4dd855154736add99')),'SELECT * FROM posapp_unified_movements_requires_review','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT (EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_movements') OR EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND COLUMN_NAME='movement_type')),'SELECT * FROM posapp_unified_movements_requires_review','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_ok = 1;
SET @unified_movement_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_movements'),'SELECT NOT EXISTS(SELECT 1 FROM ingredient_movements m LEFT JOIN ingredients i ON i.id=m.ingredient_id WHERE i.id IS NULL) INTO @unified_movement_ok','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT (@unified_movement_ok=1),'SELECT * FROM posapp_unified_movements_requires_review','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SELECT GREATEST(COALESCE(MAX(AUTO_INCREMENT),1),1) INTO @unified_movement_next FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('stock_movements','ingredient_movements');
ALTER TABLE stock_movements
 ADD COLUMN IF NOT EXISTS movement_type ENUM('stock','ingredient') NOT NULL DEFAULT 'stock',
 ADD COLUMN IF NOT EXISTS ingredient_id INT NULL,
 ADD COLUMN IF NOT EXISTS kind ENUM('usage','reversal','receipt','waste','count','correction') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS qty DECIMAL(16,6) NULL,
 ADD COLUMN IF NOT EXISTS unit_cost DECIMAL(16,8) NULL,
 ADD COLUMN IF NOT EXISTS reason ENUM('spoiled','expired','dropped_or_burnt','over_prepared','staff_meal','other') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS expected_qty DECIMAL(16,6) NULL,
 ADD COLUMN IF NOT EXISTS period_usage_qty DECIMAL(16,6) NULL,
 ADD COLUMN IF NOT EXISTS line_key CHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS unit_qty DECIMAL(16,6) NULL,
 ADD COLUMN IF NOT EXISTS product_qty DECIMAL(16,6) NULL,
 ADD COLUMN IF NOT EXISTS source_type ENUM('order','redemption','refund','void','manual') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS source_id INT NULL,
 ADD COLUMN IF NOT EXISTS source_label VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS product_id INT NULL,
 ADD COLUMN IF NOT EXISTS product_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS user_id INT NULL,
 ADD COLUMN IF NOT EXISTS user_name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS occurred_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN IF NOT EXISTS note VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS client_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
 ADD COLUMN IF NOT EXISTS corrects_movement_id BIGINT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS purchase_priced TINYINT(1) NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS cost_source VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'legacy',
 MODIFY operation_id BIGINT UNSIGNED NULL,
 MODIFY line_ordinal SMALLINT UNSIGNED NULL,
 MODIFY stock_item_id BIGINT UNSIGNED NULL,
 MODIFY quantity DECIMAL(16,6) NULL,
 MODIFY unit_snapshot VARCHAR(8) NULL;
-- Physical history keeps its timestamp in stock_operations.posted_at.
UPDATE stock_movements SET occurred_at=NULL WHERE movement_type='stock';
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_stock_movement_id'),'ALTER TABLE stock_movements ADD KEY idx_stock_movement_id (id)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF((SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='PRIMARY')='id','ALTER TABLE stock_movements DROP PRIMARY KEY, ADD PRIMARY KEY (movement_type,id)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='uq_im_client_key'),'ALTER TABLE stock_movements ADD UNIQUE KEY uq_im_client_key (client_key)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='uq_im_corrects'),'ALTER TABLE stock_movements ADD UNIQUE KEY uq_im_corrects (corrects_movement_id)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_im_ingredient_kind_id'),'ALTER TABLE stock_movements ADD KEY idx_im_ingredient_kind_id (ingredient_id,kind,id)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_im_line_key'),'ALTER TABLE stock_movements ADD KEY idx_im_line_key (line_key)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_im_source'),'ALTER TABLE stock_movements ADD KEY idx_im_source (source_type,source_id)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_im_balance'),'ALTER TABLE stock_movements ADD KEY idx_im_balance (ingredient_id,id,kind,qty,corrects_movement_id,business_date)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_im_day'),'ALTER TABLE stock_movements ADD KEY idx_im_day (business_date,ingredient_id,kind,reason,id,qty,unit_cost)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND INDEX_NAME='idx_im_purchase_cost'),'ALTER TABLE stock_movements ADD KEY idx_im_purchase_cost (ingredient_id,kind,business_date,purchase_priced)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND CONSTRAINT_NAME='fk_stock_movement_ingredient'),'ALTER TABLE stock_movements ADD CONSTRAINT fk_stock_movement_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND CONSTRAINT_NAME='ck_stock_movement_identity'),'ALTER TABLE stock_movements ADD CONSTRAINT ck_stock_movement_identity CHECK ((movement_type=''stock'' AND ingredient_id IS NULL AND kind IS NULL AND qty IS NULL AND operation_id IS NOT NULL AND occurred_at IS NULL) OR (movement_type=''ingredient'' AND ingredient_id IS NOT NULL AND kind IS NOT NULL AND qty IS NOT NULL AND source_type IS NOT NULL AND occurred_at IS NOT NULL))','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND CONSTRAINT_NAME='ck_stock_movement_physical'),'ALTER TABLE stock_movements ADD CONSTRAINT ck_stock_movement_physical CHECK ((operation_id IS NULL AND stock_item_id IS NULL AND line_ordinal IS NULL AND quantity IS NULL AND unit_snapshot IS NULL AND establishes_known=0) OR (operation_id IS NOT NULL AND stock_item_id IS NOT NULL AND line_ordinal IS NOT NULL AND quantity IS NOT NULL AND unit_snapshot IS NOT NULL AND establishes_known IN (0,1)))','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND CONSTRAINT_NAME='chk_im_signs'),'ALTER TABLE stock_movements ADD CONSTRAINT chk_im_signs CHECK (kind IS NULL OR (kind IN (''usage'',''waste'') AND qty<=0) OR (kind IN (''reversal'',''receipt'',''count'') AND qty>=0) OR kind=''correction'')','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND CONSTRAINT_NAME='chk_im_reason'),'ALTER TABLE stock_movements ADD CONSTRAINT chk_im_reason CHECK (kind=''waste'' OR reason IS NULL)','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_movements'),'INSERT INTO stock_movements(movement_type,id,ingredient_id,kind,qty,unit_cost,reason,expected_qty,period_usage_qty,line_key,unit_qty,product_qty,source_type,source_id,source_label,product_id,product_name,user_id,user_name,occurred_at,note,client_key,corrects_movement_id,purchase_priced,cost_source,business_date) SELECT ''ingredient'',id,ingredient_id,kind,qty,unit_cost,reason,expected_qty,period_usage_qty,line_key,unit_qty,product_qty,source_type,source_id,source_label,product_id,product_name,user_id,user_name,occurred_at,note,client_key,corrects_movement_id,purchase_priced,cost_source,business_date FROM ingredient_movements ON DUPLICATE KEY UPDATE id=stock_movements.id','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_movements'),'SELECT NOT EXISTS(SELECT 1 FROM ingredient_movements s LEFT JOIN stock_movements t ON t.movement_type=''ingredient'' AND t.id=s.id WHERE t.id IS NULL OR NOT (BINARY t.id<=>BINARY s.id AND BINARY t.ingredient_id<=>BINARY s.ingredient_id AND BINARY t.kind<=>BINARY s.kind AND BINARY t.qty<=>BINARY s.qty AND BINARY t.unit_cost<=>BINARY s.unit_cost AND BINARY t.reason<=>BINARY s.reason AND BINARY t.expected_qty<=>BINARY s.expected_qty AND BINARY t.period_usage_qty<=>BINARY s.period_usage_qty AND BINARY t.line_key<=>BINARY s.line_key AND BINARY t.unit_qty<=>BINARY s.unit_qty AND BINARY t.product_qty<=>BINARY s.product_qty AND BINARY t.source_type<=>BINARY s.source_type AND BINARY t.source_id<=>BINARY s.source_id AND BINARY t.source_label<=>BINARY s.source_label AND BINARY t.product_id<=>BINARY s.product_id AND BINARY t.product_name<=>BINARY s.product_name AND BINARY t.user_id<=>BINARY s.user_id AND BINARY t.user_name<=>BINARY s.user_name AND BINARY t.occurred_at<=>BINARY s.occurred_at AND BINARY t.note<=>BINARY s.note AND BINARY t.client_key<=>BINARY s.client_key AND BINARY t.corrects_movement_id<=>BINARY s.corrects_movement_id AND BINARY t.purchase_priced<=>BINARY s.purchase_priced AND BINARY t.cost_source<=>BINARY s.cost_source AND BINARY t.business_date<=>BINARY s.business_date)) AND (SELECT COUNT(*) FROM ingredient_movements)=(SELECT COUNT(*) FROM stock_movements WHERE movement_type=''ingredient'') INTO @unified_movement_ok','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SET @unified_movement_sql = IF(NOT (@unified_movement_ok=1),'SELECT * FROM posapp_unified_movements_requires_review','SELECT 1');
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
SELECT GREATEST(@unified_movement_next,COALESCE(MAX(id),0)+1) INTO @unified_movement_next FROM stock_movements;
SET @unified_movement_sql = CONCAT('ALTER TABLE stock_movements AUTO_INCREMENT=',CAST(@unified_movement_next AS CHAR));
PREPARE unified_movement_stmt FROM @unified_movement_sql;
EXECUTE unified_movement_stmt;
DEALLOCATE PREPARE unified_movement_stmt;
DROP TABLE IF EXISTS ingredient_movements;
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-12-unified-stock-movements-v1','91cba75ab3e889134d546233f79ccaa6e2dc8a7d0f9cabf4dd855154736add99')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
