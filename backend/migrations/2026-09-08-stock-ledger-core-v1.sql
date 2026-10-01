-- Requires migration: 2026-09-08-stock-adjustments-v1
-- Requires checksum: 24dc1b1c7b16edb759bfdd7bcb0a67fdd7c13f2a75bd8388e98f4cb6a6a528cc
-- Stock identity and append-only quantity ledger.
-- This evidence migration is not an authority cutover. No legacy rows are mapped.
-- Quantity writers are integrated or reject linked product edits; item activation remains unavailable pending frozen authority and preflight.
CREATE TABLE IF NOT EXISTS stock_items (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 name VARCHAR(100) NOT NULL,
 measure VARCHAR(12) NOT NULL,
 base_unit VARCHAR(8) NOT NULL,
 legacy_product_id INT DEFAULT NULL,
 legacy_ingredient_id INT DEFAULT NULL,
 tracking_state VARCHAR(16) NOT NULL DEFAULT 'draft',
 lot_required TINYINT NOT NULL DEFAULT 0,
 is_active TINYINT NOT NULL DEFAULT 1,
 UNIQUE KEY uq_stock_item_product (legacy_product_id),
 UNIQUE KEY uq_stock_item_ingredient (legacy_ingredient_id),
 KEY idx_stock_item_name (name,id),
 CONSTRAINT ck_stock_item_source CHECK (legacy_product_id IS NULL OR legacy_ingredient_id IS NULL),
 CONSTRAINT ck_stock_item_measure CHECK ((measure='weight' AND base_unit='g') OR (measure='volume' AND base_unit='ml') OR (measure='count' AND base_unit='unit')),
 CONSTRAINT ck_stock_item_state CHECK (tracking_state IN ('draft','active')),
 CONSTRAINT ck_stock_item_flags CHECK (lot_required IN (0,1) AND is_active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_locations (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 code VARCHAR(32) NOT NULL,
 name VARCHAR(100) NOT NULL,
 is_active TINYINT NOT NULL DEFAULT 1,
 UNIQUE KEY uq_stock_location_code (code),
 CONSTRAINT ck_stock_location_active CHECK (is_active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO stock_locations (code,name) VALUES ('default','المخزن الرئيسي'),('in_transit','قيد النقل')
ON DUPLICATE KEY UPDATE code=VALUES(code);
CREATE TABLE IF NOT EXISTS stock_lots (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 lot_code VARCHAR(100) NOT NULL,
 expiry_date DATE DEFAULT NULL,
 state VARCHAR(16) NOT NULL DEFAULT 'eligible',
 is_default TINYINT NOT NULL DEFAULT 0,
 UNIQUE KEY uq_stock_lot_code (stock_item_id,lot_code),
 UNIQUE KEY uq_stock_lot_item (id,stock_item_id),
 KEY idx_stock_lot_pick (stock_item_id,state,expiry_date,id),
 CONSTRAINT fk_stock_lot_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT ck_stock_lot_state CHECK (state IN ('eligible','quarantine')),
 CONSTRAINT ck_stock_default_lot CHECK ((is_default=1 AND lot_code='default') OR (is_default=0 AND lot_code<>'default'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_balances (
 stock_item_id BIGINT UNSIGNED NOT NULL,
 location_id BIGINT UNSIGNED NOT NULL,
 lot_id BIGINT UNSIGNED NOT NULL,
 quantity DECIMAL(16,6) NOT NULL DEFAULT 0,
 quantity_known TINYINT NOT NULL DEFAULT 0,
 version BIGINT UNSIGNED NOT NULL DEFAULT 0,
 last_operation_id BIGINT UNSIGNED DEFAULT NULL,
 PRIMARY KEY (stock_item_id,location_id,lot_id),
 KEY idx_stock_balance_location (location_id,stock_item_id,lot_id),
 CONSTRAINT fk_stock_balance_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT fk_stock_balance_location FOREIGN KEY (location_id) REFERENCES stock_locations(id),
 CONSTRAINT fk_stock_balance_lot FOREIGN KEY (lot_id,stock_item_id) REFERENCES stock_lots(id,stock_item_id),
 CONSTRAINT ck_stock_balance_known CHECK (quantity_known IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE stock_operations
 ADD COLUMN IF NOT EXISTS state VARCHAR(16) NOT NULL DEFAULT 'posted',
 ADD COLUMN IF NOT EXISTS business_date DATE DEFAULT NULL,
 ADD COLUMN IF NOT EXISTS original_operation_id BIGINT UNSIGNED DEFAULT NULL;
CREATE TABLE IF NOT EXISTS stock_movements (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 operation_id BIGINT UNSIGNED NOT NULL,
 line_ordinal SMALLINT UNSIGNED NOT NULL,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 location_id BIGINT UNSIGNED NOT NULL,
 lot_id BIGINT UNSIGNED NOT NULL,
 quantity DECIMAL(16,6) NOT NULL,
 establishes_known TINYINT NOT NULL DEFAULT 0,
 unit_snapshot VARCHAR(8) NOT NULL,
 source_line VARCHAR(100) DEFAULT NULL,
 business_date DATE NOT NULL,
 UNIQUE KEY uq_stock_movement_operation (operation_id,line_ordinal),
 KEY idx_stock_movement_history (stock_item_id,location_id,lot_id,id),
 KEY idx_stock_movement_day (business_date,id),
 CONSTRAINT fk_stock_movement_operation FOREIGN KEY (operation_id) REFERENCES stock_operations(id),
 CONSTRAINT fk_stock_movement_balance FOREIGN KEY (stock_item_id,location_id,lot_id) REFERENCES stock_balances(stock_item_id,location_id,lot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS product_stock_links (
 product_id INT NOT NULL PRIMARY KEY,
 stock_item_id BIGINT UNSIGNED NOT NULL,
 qty_per_sale DECIMAL(16,6) NOT NULL,
 policy_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
 CONSTRAINT fk_product_stock_item FOREIGN KEY (stock_item_id) REFERENCES stock_items(id),
 CONSTRAINT ck_product_stock_qty CHECK (qty_per_sale > 0),
 CONSTRAINT fk_product_stock_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-ledger-core-v1','39f4cfdf202f95c4568e9592aa07cd80fd587ea658b0665a92a7ba9e2f5b56a4')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
