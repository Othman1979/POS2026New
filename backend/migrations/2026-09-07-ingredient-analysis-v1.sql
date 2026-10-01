-- 2026-09-07-ingredient-analysis-v1
-- Requires migration: 2026-09-06-recipe-ledger-performance-v1
-- Requires checksum: f58a8a615d01ee8dddc91665a1d45120f5c565ede0d992b61c3760be0c27b95c
-- Existing recipe quantities remain stock quantities; legacy prices have unknown provenance.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS recipe_cost_snapshot JSON DEFAULT NULL;
ALTER TABLE product_recipe_lines ADD COLUMN IF NOT EXISTS yield_pct decimal(10,4) NOT NULL DEFAULT 100;
ALTER TABLE ingredient_movements
 ADD COLUMN IF NOT EXISTS purchase_priced tinyint(1) NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS cost_source varchar(24) NOT NULL DEFAULT 'legacy',
 MODIFY COLUMN note varchar(500) DEFAULT NULL,
 ADD KEY IF NOT EXISTS idx_im_purchase_cost (ingredient_id,kind,business_date,purchase_priced);
INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-07-ingredient-analysis-v1', 'e83dc402889a86726e63c672f4d2c9e8a67aa8c24180ac13cf6b9d16f440ac60')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
