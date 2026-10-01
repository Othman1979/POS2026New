-- 2026-09-05-recipe-ledger-v1
-- Requires migration: 2026-09-03-y-order-type-setting-v1
-- Requires checksum: 4ce5988110e392f84d029cdd280c90d21eef1cd0d2c86d556bc7df5ac93df4c3
-- Optional ingredient recipe ledger: usage, reversals, receipts, waste, counts, and corrections.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS ingredients (
  id int(11) NOT NULL AUTO_INCREMENT,
  name varchar(100) NOT NULL,
  measure enum('weight','volume','count') NOT NULL,
  display_unit enum('g','kg','ml','l','unit') NOT NULL,
  unit_cost decimal(16,8) DEFAULT NULL,
  par_qty decimal(16,6) DEFAULT NULL,
  pack_name varchar(40) DEFAULT NULL,
  pack_size decimal(16,6) DEFAULT NULL,
  is_active tinyint(1) NOT NULL DEFAULT 1,
  created_at datetime NOT NULL DEFAULT current_timestamp(),
  updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ingredients_name (name),
  CONSTRAINT chk_ingredients_unit CHECK (
    (measure='weight' AND display_unit IN ('g','kg')) OR
    (measure='volume' AND display_unit IN ('ml','l')) OR
    (measure='count'  AND display_unit='unit')),
  CONSTRAINT chk_ingredients_pack CHECK (
    (pack_name IS NULL AND pack_size IS NULL) OR
    (pack_name IS NOT NULL AND pack_size > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS product_recipe_lines (
  id int(11) NOT NULL AUTO_INCREMENT,
  product_id int(11) NOT NULL,
  ingredient_id int(11) NOT NULL,
  qty_per_unit decimal(16,6) NOT NULL,
  sort_order int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_recipe_lines (product_id, ingredient_id),
  KEY idx_prl_ingredient (ingredient_id),
  CONSTRAINT fk_prl_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_prl_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients (id),
  CONSTRAINT chk_prl_qty CHECK (qty_per_unit > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ingredient_movements (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  ingredient_id int(11) NOT NULL,
  kind enum('usage','reversal','receipt','waste','count','correction') NOT NULL,
  qty decimal(16,6) NOT NULL,
  unit_cost decimal(16,8) DEFAULT NULL,
  reason enum('spoiled','expired','dropped_or_burnt','over_prepared','staff_meal','other') DEFAULT NULL,
  expected_qty decimal(16,6) DEFAULT NULL,
  period_usage_qty decimal(16,6) DEFAULT NULL,
  line_key char(32) DEFAULT NULL,
  unit_qty decimal(16,6) DEFAULT NULL,
  product_qty decimal(16,6) DEFAULT NULL,
  source_type enum('order','redemption','refund','void','manual') NOT NULL,
  source_id int(11) DEFAULT NULL,
  source_label varchar(64) DEFAULT NULL,
  product_id int(11) DEFAULT NULL,
  product_name varchar(255) DEFAULT NULL,
  user_id int(11) DEFAULT NULL,
  user_name varchar(100) DEFAULT NULL,
  business_date date NOT NULL,
  occurred_at datetime NOT NULL DEFAULT current_timestamp(),
  note varchar(255) DEFAULT NULL,
  client_key varchar(64) DEFAULT NULL,
  corrects_movement_id bigint(20) unsigned DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_im_client_key (client_key),
  UNIQUE KEY uq_im_corrects (corrects_movement_id),
  KEY idx_im_ingredient_id (ingredient_id, id),
  KEY idx_im_ingredient_kind_id (ingredient_id, kind, id),
  KEY idx_im_date_ingredient (business_date, ingredient_id),
  KEY idx_im_line_key (line_key),
  KEY idx_im_source (source_type, source_id),
  CONSTRAINT fk_im_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients (id),
  CONSTRAINT chk_im_signs CHECK (
    (kind IN ('usage','waste') AND qty <= 0) OR
    (kind IN ('reversal','receipt') AND qty >= 0) OR
    (kind = 'count' AND qty >= 0) OR
    kind = 'correction'),
  CONSTRAINT chk_im_reason CHECK (kind = 'waste' OR reason IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS recipe_line_key char(32) DEFAULT NULL,
  ALGORITHM=INSTANT, LOCK=NONE;

ALTER TABLE order_items
  ADD KEY IF NOT EXISTS idx_order_items_recipe_line_key (recipe_line_key),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE subscription_redemption_items
  ADD COLUMN IF NOT EXISTS recipe_line_key char(32) DEFAULT NULL,
  ALGORITHM=INSTANT, LOCK=NONE;

ALTER TABLE subscription_redemption_items
  ADD KEY IF NOT EXISTS idx_sri_recipe_line_key (recipe_line_key),
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT IGNORE INTO settings (setting_key, setting_value)
VALUES ('recipe_ledger_enabled', '0');

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-05-recipe-ledger-v1',
  '9f9112ea304b683bc33d5710595ff13157f25c87f12b7acbc74c7e299169eecb'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
