-- Public invoice numbers are customer-facing paid invoice identities.
-- orders.invoice_id remains the internal AUTO_INCREMENT primary key.

CREATE TABLE IF NOT EXISTS invoice_sequences (
  sequence_name VARCHAR(64) NOT NULL,
  current_value INT NOT NULL DEFAULT 0,
  PRIMARY KEY (sequence_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS invoice_number INT NULL AFTER order_id,
  ADD COLUMN IF NOT EXISTS invoice_issued_at DATETIME NULL AFTER invoice_number,
  ADD UNIQUE KEY IF NOT EXISTS uq_orders_invoice_number (invoice_number),
  ADD KEY IF NOT EXISTS idx_orders_invoice_issued_at (invoice_issued_at);

-- Preserve old visible paid invoice identity. Before this migration,
-- paid receipts/admin screens displayed INV-{invoice_id}.
UPDATE orders
SET invoice_number = invoice_id,
    invoice_issued_at = COALESCE(invoice_issued_at, created_at)
WHERE invoice_number IS NULL
  AND payment_method IN ('cash', 'card', 'split');

-- Initialize the global sequence to at least the historical maximum.
INSERT INTO invoice_sequences (sequence_name, current_value)
SELECT 'global_invoice', COALESCE(MAX(invoice_number), 0)
FROM orders
ON DUPLICATE KEY UPDATE
  current_value = GREATEST(current_value, VALUES(current_value));
