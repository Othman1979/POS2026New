-- 2026-09-08-stock-item-projections-v1
-- Requires migration: 2026-09-08-stock-ingredient-cutover-v1
-- Requires checksum: a6fc46b77ffc44f827b94d1d1ef063deb570e3eb83152347a88f0de759621a5a
-- Bounded stock pages project barcode, attention and daily movement identity.
ALTER TABLE stock_items
 ADD COLUMN IF NOT EXISTS barcode VARCHAR(50) NULL,
 ADD COLUMN IF NOT EXISTS attention VARCHAR(12) NOT NULL DEFAULT 'unknown';
ALTER TABLE stock_items ADD UNIQUE INDEX IF NOT EXISTS uq_stock_item_barcode (barcode);
ALTER TABLE stock_items ADD INDEX IF NOT EXISTS idx_stock_item_attention (attention,name,id);
ALTER TABLE stock_items ADD CONSTRAINT IF NOT EXISTS ck_stock_item_attention
 CHECK (attention IN ('ok','unknown','negative','inactive'));
ALTER TABLE stock_movements ADD INDEX IF NOT EXISTS idx_stock_movement_item_day (stock_item_id,business_date,id);
UPDATE stock_items s
 LEFT JOIN (
  SELECT stock_item_id, MIN(quantity_known) AS quantity_known, MIN(quantity) AS min_qty
  FROM stock_balances GROUP BY stock_item_id
 ) b ON b.stock_item_id=s.id
 SET s.attention=CASE
  WHEN s.is_active=0 OR s.tracking_state<>'active' THEN 'inactive'
  WHEN b.stock_item_id IS NULL OR b.quantity_known=0 THEN 'unknown'
  WHEN b.min_qty<0 THEN 'negative'
  ELSE 'ok' END;
UPDATE stock_items s
 INNER JOIN products p ON p.id=s.legacy_product_id
 SET s.barcode=NULLIF(TRIM(p.barcode),'')
 WHERE s.barcode IS NULL AND p.barcode IS NOT NULL AND TRIM(p.barcode)<>'';
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-item-projections-v1','6d81e9659ccd1da36f4067f8791d60c0311d48ec94249745a4164617a2d34f9b')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
