-- Required for kitchen void tickets: preserve when each table item was ordered.
-- Safe to re-run: only rows without a timestamp are backfilled.
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS created_at DATETIME NULL DEFAULT NULL;

UPDATE order_items oi
LEFT JOIN orders o ON o.invoice_id = oi.invoice_id
SET oi.created_at = COALESCE(o.created_at, CURRENT_TIMESTAMP)
WHERE oi.created_at IS NULL;

ALTER TABLE order_items
  MODIFY COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
