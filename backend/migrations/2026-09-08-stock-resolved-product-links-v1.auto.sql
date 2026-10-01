-- 2026-09-08-stock-resolved-product-links-v1
-- Requires migration: 2026-09-08-stock-report-ingredient-rebuild-v1
-- Requires checksum: 73cfeb1ec68ec93d958e216c939924627b916264a82da1879f1069c30363a329
-- One product may resolve to multiple physical stocks; stocks may be shared.
-- Existing 1:1 rows and immutable sale snapshots are preserved.
ALTER TABLE product_stock_links DROP PRIMARY KEY, ADD PRIMARY KEY (product_id,stock_item_id);
ALTER TABLE product_stock_links ADD INDEX IF NOT EXISTS idx_product_stock_physical (stock_item_id,product_id);
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-resolved-product-links-v1','c00a02a6fda76f018ad8287a9d4a0355564d93a8430f0eb1a0d496dd45ffe301')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
