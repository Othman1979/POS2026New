-- 2026-10-04-packaging-units-v1
-- Requires migration: 2026-10-03-product-barcodes-v1
-- Requires checksum: d7070c1443d96cfae4feb758650aed5e464ee1f3b39de0f457635529c893a61e
-- Packaging units. A product keeps one stock balance in its base unit; product_packs names the packs it is bought
-- or counted in (a carton of 12, a sack of 10 kg) with how many base units each holds. A pack sold at the register
-- has its own sale product (sale_product_id: its price and barcode) linked to the same stock item. A purchase line may carry
-- free bonus quantity in base units (bonus_qty) that is received with the line without changing what was paid.
-- A category may be kept off the POS product grid (hide_in_pos) while its products still sell by barcode.
-- Rerun safe; it stops before changing anything when the predecessor is missing.

SET NAMES utf8mb4;

SET @pu_sql = IF(NOT (EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-03-product-barcodes-v1' AND checksum='d7070c1443d96cfae4feb758650aed5e464ee1f3b39de0f457635529c893a61e') AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-04-packaging-units-v1' AND checksum<>'bac6fdbf2e9f5b3d8321c0d61c0bfdf58670dd8659e18a1e5673cc8ccaecdae6')),'SELECT * FROM posapp_packaging_units_requires_review','SELECT 1');
PREPARE pu_stmt FROM @pu_sql;
EXECUTE pu_stmt;
DEALLOCATE PREPARE pu_stmt;

ALTER TABLE categories ADD COLUMN IF NOT EXISTS hide_in_pos TINYINT(1) NOT NULL DEFAULT 0 AFTER is_notes;

ALTER TABLE stock_document_lines ADD COLUMN IF NOT EXISTS bonus_qty DECIMAL(16,6) NOT NULL DEFAULT 0 AFTER qty;

ALTER TABLE stock_document_lines
  DROP CONSTRAINT IF EXISTS ck_stock_document_line_bonus,
  ADD CONSTRAINT ck_stock_document_line_bonus CHECK (bonus_qty >= 0);

CREATE TABLE IF NOT EXISTS product_packs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id INT NOT NULL,
  label VARCHAR(40) NOT NULL,
  factor DECIMAL(16,6) NOT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  sale_product_id INT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_pack_label (product_id, label),
  UNIQUE KEY uq_product_pack_sale_product (sale_product_id),
  CONSTRAINT fk_product_packs_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_product_packs_sale_product FOREIGN KEY (sale_product_id) REFERENCES products (id) ON DELETE SET NULL,
  CONSTRAINT ck_product_pack_factor CHECK (factor > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-10-04-packaging-units-v1',
  'bac6fdbf2e9f5b3d8321c0d61c0bfdf58670dd8659e18a1e5673cc8ccaecdae6'
)
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
