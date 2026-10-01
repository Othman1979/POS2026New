-- 2026-10-03-product-barcodes-v1
-- Requires migration: 2026-10-02-purchase-item-kind-v1
-- Requires checksum: ac2755e860ecdcc5119234c0422729b602d5f51f9e1d8bb4a8f8bb844da40e3e
-- A product keeps its main barcode in products.barcode and may hold extra barcodes in product_barcodes.
-- An extra barcode is unique across all products (the application also keeps it distinct from every main barcode),
-- and it follows its product: deleting the product deletes its extras. The barcode column uses the products
-- collation so a lookup compares and uses the index exactly like products.idx_barcode.
-- Rerun safe; it stops before changing anything when the predecessor is missing.

SET NAMES utf8mb4;

SET @pb_sql = IF(NOT (EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-02-purchase-item-kind-v1' AND checksum='ac2755e860ecdcc5119234c0422729b602d5f51f9e1d8bb4a8f8bb844da40e3e') AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-03-product-barcodes-v1' AND checksum<>'d7070c1443d96cfae4feb758650aed5e464ee1f3b39de0f457635529c893a61e')),'SELECT * FROM posapp_product_barcodes_requires_review','SELECT 1');
PREPARE pb_stmt FROM @pb_sql;
EXECUTE pb_stmt;
DEALLOCATE PREPARE pb_stmt;

CREATE TABLE IF NOT EXISTS product_barcodes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id INT NOT NULL,
  barcode VARCHAR(50) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_barcode (barcode),
  KEY idx_product_barcodes_product (product_id, id),
  CONSTRAINT fk_product_barcodes_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-10-03-product-barcodes-v1',
  'd7070c1443d96cfae4feb758650aed5e464ee1f3b39de0f457635529c893a61e'
)
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
