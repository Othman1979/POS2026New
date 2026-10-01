-- 2026-10-01-stock-documents-v1
-- Requires migration: 2026-10-01-retire-purchasing-tables-v1
-- Requires checksum: 1acb658d7fbe0b41efbb60b9d5c67f715b970e63a051e88263b43440f7c8372b
-- Moves purchase invoices into the shared stock_documents / stock_document_lines tables, keeping every id
-- (invoice id = document id, line id = line id) so stock movements and saved stock results still point at them.
-- A line whose stock item is neither a product nor an ingredient stops the upgrade before anything changes.
-- The old purchase_invoices and purchase_invoice_lines tables are dropped only after the copy is verified.

SET NAMES utf8mb4;

SET @sd_sql = IF(NOT (EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-01-retire-purchasing-tables-v1' AND checksum='1acb658d7fbe0b41efbb60b9d5c67f715b970e63a051e88263b43440f7c8372b') AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name='2026-10-01-stock-documents-v1' AND checksum<>'81f157ded498bf0f84f3083ebdf00aad3cb3f03a33c186264e7a9ac7b9bf94a0')),'SELECT * FROM posapp_stock_documents_requires_review','SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_ok = 1;
SET @sd_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoice_lines' AND TABLE_TYPE='BASE TABLE'), 'SELECT NOT EXISTS(SELECT 1 FROM purchase_invoice_lines l LEFT JOIN stock_items s ON s.id = l.stock_item_id LEFT JOIN products p ON p.id = s.legacy_product_id LEFT JOIN ingredients g ON g.id = s.legacy_ingredient_id WHERE s.id IS NULL OR (s.legacy_product_id IS NULL AND s.legacy_ingredient_id IS NULL) OR (s.legacy_product_id IS NOT NULL AND s.legacy_ingredient_id IS NOT NULL) OR (s.legacy_product_id IS NOT NULL AND p.id IS NULL) OR (s.legacy_ingredient_id IS NOT NULL AND g.id IS NULL)) INTO @sd_ok', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_sql = IF(NOT (@sd_ok=1), 'SELECT * FROM posapp_stock_documents_requires_review', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;

CREATE TABLE IF NOT EXISTS stock_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_type ENUM('purchase','count') NOT NULL,
  status ENUM('draft','posted','reversed') NOT NULL DEFAULT 'draft',
  supplier_id INT NULL,
  reference VARCHAR(60) NULL,
  doc_date DATE NOT NULL,
  payment_status ENUM('paid','credit') NULL,
  subtotal DECIMAL(14,3) NOT NULL DEFAULT 0,
  tax_total DECIMAL(14,3) NOT NULL DEFAULT 0,
  total DECIMAL(14,3) NOT NULL DEFAULT 0,
  paper_total DECIMAL(14,3) NULL,
  notes VARCHAR(255) NULL,
  cost_includes_tax TINYINT(1) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  create_key VARCHAR(64) NULL,
  post_key VARCHAR(64) NULL,
  reverse_key VARCHAR(64) NULL,
  stock_result JSON NULL,
  created_by INT NULL,
  posted_by INT NULL,
  reversed_by INT NULL,
  posted_at DATETIME NULL,
  reversed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  open_count TINYINT GENERATED ALWAYS AS (IF(doc_type = 'count' AND status = 'draft', 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stock_document_supplier_reference (supplier_id, reference),
  UNIQUE KEY uq_stock_document_create_key (create_key),
  UNIQUE KEY uq_stock_document_post_key (post_key),
  UNIQUE KEY uq_stock_document_reverse_key (reverse_key),
  UNIQUE KEY uq_stock_document_open_count (open_count),
  KEY idx_stock_document_type_status_date (doc_type, status, doc_date, id),
  CONSTRAINT fk_stock_document_supplier FOREIGN KEY (supplier_id) REFERENCES purchase_suppliers (id),
  CONSTRAINT ck_stock_document_shape CHECK (
    (doc_type = 'purchase' AND supplier_id IS NOT NULL AND reference IS NOT NULL AND payment_status IS NOT NULL
      AND subtotal >= 0 AND tax_total >= 0 AND total >= 0)
    OR (doc_type = 'count' AND supplier_id IS NULL AND payment_status IS NULL AND status IN ('draft','posted')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_document_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id BIGINT UNSIGNED NOT NULL,
  line_no SMALLINT UNSIGNED NOT NULL,
  product_id INT NULL,
  ingredient_id INT NULL,
  qty DECIMAL(14,3) NULL,
  unit_label VARCHAR(40) NOT NULL,
  unit_factor DECIMAL(16,6) NOT NULL,
  unit_price DECIMAL(14,4) NULL,
  tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  line_subtotal DECIMAL(14,3) NOT NULL DEFAULT 0,
  line_tax DECIMAL(14,3) NOT NULL DEFAULT 0,
  line_total DECIMAL(14,3) NOT NULL DEFAULT 0,
  expected_qty DECIMAL(16,6) NULL,
  counted_by INT NULL,
  counted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stock_document_line_no (document_id, line_no),
  UNIQUE KEY uq_stock_document_line_product (document_id, product_id),
  UNIQUE KEY uq_stock_document_line_ingredient (document_id, ingredient_id),
  KEY idx_stock_document_line_product (product_id, document_id),
  KEY idx_stock_document_line_ingredient (ingredient_id, document_id),
  CONSTRAINT fk_stock_document_line_document FOREIGN KEY (document_id) REFERENCES stock_documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_stock_document_line_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_stock_document_line_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients (id),
  CONSTRAINT ck_stock_document_line_item CHECK (
    (product_id IS NOT NULL AND ingredient_id IS NULL) OR (product_id IS NULL AND ingredient_id IS NOT NULL)),
  CONSTRAINT ck_stock_document_line_qty CHECK (qty IS NULL OR qty >= 0),
  CONSTRAINT ck_stock_document_line_factor CHECK (unit_factor > 0),
  CONSTRAINT ck_stock_document_line_price CHECK (unit_price IS NULL OR unit_price >= 0),
  CONSTRAINT ck_stock_document_line_tax CHECK (tax_rate IN (0,4,16))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @sd_ok = 1;
SET @sd_sql = IF((EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoices' AND TABLE_TYPE='BASE TABLE') AND EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoice_lines' AND TABLE_TYPE='BASE TABLE')), 'INSERT INTO stock_documents (id, doc_type, status, supplier_id, reference, doc_date, payment_status, subtotal, tax_total, total, paper_total, notes, cost_includes_tax, version, create_key, post_key, reverse_key, stock_result, created_by, posted_by, reversed_by, posted_at, reversed_at, created_at, updated_at) SELECT i.id, ''purchase'', i.status, i.supplier_id, i.supplier_invoice_no, i.invoice_date, i.payment_status, i.subtotal, i.tax_total, i.total, i.paper_total, i.notes, i.cost_includes_tax, i.version, i.create_key, i.post_key, i.reverse_key, i.stock_result, i.created_by, i.posted_by, i.reversed_by, i.posted_at, i.reversed_at, i.created_at, i.updated_at FROM purchase_invoices i WHERE NOT EXISTS (SELECT 1 FROM stock_documents d WHERE d.id = i.id)', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_sql = IF((EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoices' AND TABLE_TYPE='BASE TABLE') AND EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoice_lines' AND TABLE_TYPE='BASE TABLE')), 'INSERT INTO stock_document_lines (id, document_id, line_no, product_id, ingredient_id, qty, unit_label, unit_factor, unit_price, tax_rate, line_subtotal, line_tax, line_total) SELECT l.id, l.invoice_id, l.line_no, s.legacy_product_id, s.legacy_ingredient_id, l.qty, l.unit_label, l.unit_factor, l.unit_price, l.tax_rate, l.line_subtotal, l.line_tax, l.line_total FROM purchase_invoice_lines l JOIN stock_items s ON s.id = l.stock_item_id WHERE NOT EXISTS (SELECT 1 FROM stock_document_lines d WHERE d.id = l.id)', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_sql = IF((EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoices' AND TABLE_TYPE='BASE TABLE') AND EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoice_lines' AND TABLE_TYPE='BASE TABLE')), 'SELECT (SELECT COUNT(*) FROM purchase_invoices) = (SELECT COUNT(*) FROM stock_documents WHERE doc_type = ''purchase'') AND (SELECT COUNT(*) FROM purchase_invoice_lines) = (SELECT COUNT(*) FROM stock_document_lines l JOIN stock_documents d ON d.id = l.document_id WHERE d.doc_type = ''purchase'') INTO @sd_ok', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_sql = IF(NOT (@sd_ok=1), 'SELECT * FROM posapp_stock_documents_requires_review', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoice_lines' AND TABLE_TYPE='BASE TABLE') AND @sd_ok=1, 'DROP TABLE purchase_invoice_lines', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;
SET @sd_sql = IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_invoices' AND TABLE_TYPE='BASE TABLE') AND @sd_ok=1, 'DROP TABLE purchase_invoices', 'SELECT 1');
PREPARE sd_stmt FROM @sd_sql;
EXECUTE sd_stmt;
DEALLOCATE PREPARE sd_stmt;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-10-01-stock-documents-v1',
  '81f157ded498bf0f84f3083ebdf00aad3cb3f03a33c186264e7a9ac7b9bf94a0'
)
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
