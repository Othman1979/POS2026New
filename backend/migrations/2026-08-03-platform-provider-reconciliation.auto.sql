-- Hostinger-safe automatic form of 2026-08-03-platform-provider-reconciliation-v1.
-- Preconditions, checksum conflicts, file integrity, and serialization are enforced by runPendingMigrations.js.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS platform_remittances (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  order_type_id int(11) NOT NULL,
  provider_name_at_entry varchar(100) NOT NULL,
  kind enum('settlement','reversal') NOT NULL DEFAULT 'settlement',
  statement_start_date date DEFAULT NULL,
  statement_end_date date DEFAULT NULL,
  settled_on date NOT NULL,
  reference varchar(120) DEFAULT NULL,
  net_received decimal(10,2) NOT NULL,
  reverses_remittance_id bigint unsigned DEFAULT NULL,
  reason varchar(255) DEFAULT NULL,
  recorded_by int(11) NOT NULL,
  idempotency_key varchar(80) NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_remittances_idempotency (idempotency_key),
  UNIQUE KEY uq_platform_remittances_reversal (reverses_remittance_id),
  KEY idx_platform_remittances_provider_date (order_type_id,settled_on,id),
  KEY idx_platform_remittances_date_kind (settled_on,kind,id),
  CONSTRAINT fk_platform_remittances_user FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_platform_remittances_reversal FOREIGN KEY (reverses_remittance_id) REFERENCES platform_remittances(id) ON DELETE RESTRICT,
  CONSTRAINT chk_platform_remittances_net CHECK (net_received >= 0),
  CONSTRAINT chk_platform_remittances_statement_dates CHECK ((statement_start_date IS NULL AND statement_end_date IS NULL) OR (statement_start_date IS NOT NULL AND statement_end_date IS NOT NULL AND statement_start_date <= statement_end_date)),
  CONSTRAINT chk_platform_remittances_reversal_shape CHECK ((kind='settlement' AND reverses_remittance_id IS NULL AND reason IS NULL) OR (kind='reversal' AND reverses_remittance_id IS NOT NULL AND char_length(trim(reason)) > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS platform_remittance_lines (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  remittance_id bigint unsigned NOT NULL,
  invoice_id int(11) NOT NULL,
  allocated_amount decimal(10,2) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_remittance_lines_invoice (remittance_id,invoice_id),
  KEY idx_platform_remittance_lines_invoice (invoice_id,remittance_id),
  CONSTRAINT fk_platform_remittance_lines_remittance FOREIGN KEY (remittance_id) REFERENCES platform_remittances(id) ON DELETE RESTRICT,
  CONSTRAINT fk_platform_remittance_lines_order FOREIGN KEY (invoice_id) REFERENCES orders(invoice_id) ON DELETE RESTRICT,
  CONSTRAINT chk_platform_remittance_lines_amount CHECK (allocated_amount <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS platform_remittance_adjustments (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  remittance_id bigint unsigned NOT NULL,
  direction enum('deduction','addition') NOT NULL,
  category enum('commission','service_fee','marketing_fee','penalty','withholding_tax','reimbursement','incentive','correction','other') NOT NULL,
  amount decimal(10,2) NOT NULL,
  note varchar(255) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_platform_remittance_adjustments_remittance (remittance_id,id),
  CONSTRAINT fk_platform_remittance_adjustments_remittance FOREIGN KEY (remittance_id) REFERENCES platform_remittances(id) ON DELETE RESTRICT,
  CONSTRAINT chk_platform_remittance_adjustments_amount CHECK (amount > 0),
  CONSTRAINT chk_platform_remittance_adjustments_shape CHECK ((category IN ('commission','service_fee','marketing_fee','penalty','withholding_tax') AND direction='deduction') OR (category IN ('reimbursement','incentive') AND direction='addition') OR (category IN ('correction','other') AND char_length(trim(note)) > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE orders
  ADD INDEX IF NOT EXISTS idx_orders_platform_provider (payment_method,order_type_id,invoice_id);

INSERT INTO schema_migrations (migration_name,checksum)
VALUES ('2026-08-03-platform-provider-reconciliation-v1','21d0fb62426802c01d26b36de0a54055f32c747ed918468a0dde6deaf02df999');
