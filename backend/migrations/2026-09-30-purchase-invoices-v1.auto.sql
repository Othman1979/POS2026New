-- 2026-09-30-purchase-invoices-v1
-- Requires migration: 2026-09-30-multi-terminal-permission-v1
-- Requires checksum: 39060fd593fffd1667e754a3a7a1708ad73636faaaf00b50e86ad994bb6df893
-- Purchase invoices: suppliers, invoice headers and lines that post stock through the stock ledger.
-- The retired stock_suppliers, stock_purchase_* and stock_receipts* tables are not reused.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS purchase_suppliers (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(40) NULL,
  tax_number VARCHAR(40) NULL,
  notes VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_supplier_name (name),
  CONSTRAINT ck_purchase_supplier_active CHECK (is_active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_id INT NOT NULL,
  supplier_invoice_no VARCHAR(60) NOT NULL,
  invoice_date DATE NOT NULL,
  status ENUM('draft','posted','reversed') NOT NULL DEFAULT 'draft',
  payment_status ENUM('paid','credit') NOT NULL DEFAULT 'credit',
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
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_invoice_supplier_no (supplier_id, supplier_invoice_no),
  UNIQUE KEY uq_purchase_invoice_create_key (create_key),
  UNIQUE KEY uq_purchase_invoice_post_key (post_key),
  UNIQUE KEY uq_purchase_invoice_reverse_key (reverse_key),
  KEY idx_purchase_invoice_status_date (status, invoice_date, id),
  CONSTRAINT fk_purchase_invoice_supplier FOREIGN KEY (supplier_id) REFERENCES purchase_suppliers (id),
  CONSTRAINT ck_purchase_invoice_status CHECK (status IN ('draft','posted','reversed')),
  CONSTRAINT ck_purchase_invoice_payment CHECK (payment_status IN ('paid','credit')),
  CONSTRAINT ck_purchase_invoice_amounts CHECK (subtotal >= 0 AND tax_total >= 0 AND total >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id BIGINT UNSIGNED NOT NULL,
  line_no SMALLINT UNSIGNED NOT NULL,
  stock_item_id BIGINT UNSIGNED NOT NULL,
  qty DECIMAL(14,3) NOT NULL,
  unit_label VARCHAR(40) NOT NULL,
  unit_factor DECIMAL(16,6) NOT NULL,
  unit_price DECIMAL(14,4) NOT NULL,
  tax_rate DECIMAL(5,2) NOT NULL,
  line_subtotal DECIMAL(14,3) NOT NULL,
  line_tax DECIMAL(14,3) NOT NULL,
  line_total DECIMAL(14,3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_line_no (invoice_id, line_no),
  KEY idx_purchase_line_item (stock_item_id, invoice_id),
  CONSTRAINT fk_purchase_line_invoice FOREIGN KEY (invoice_id) REFERENCES purchase_invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_purchase_line_item FOREIGN KEY (stock_item_id) REFERENCES stock_items (id),
  CONSTRAINT ck_purchase_line_qty CHECK (qty > 0),
  CONSTRAINT ck_purchase_line_factor CHECK (unit_factor > 0),
  CONSTRAINT ck_purchase_line_price CHECK (unit_price >= 0),
  CONSTRAINT ck_purchase_line_tax CHECK (tax_rate IN (0,4,16))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-30-purchase-invoices-v1',
  'd229b196f899d443ff68488c68107943028175b3cf716a067e2d36a74406e2b9'
)
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
