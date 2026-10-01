-- 2026-09-14-deleted-table-items-v1
-- Requires migration: 2026-09-13-table-seating-v1
-- Requires checksum: 78f8798435bc6e44e45aeb1642189f42a9d562edb268354868b6d3e5a7674ab1
-- Future cancellations only. No existing order, item or refund data is changed.
SET NAMES utf8mb4;

ALTER TABLE refunds MODIFY COLUMN invoice_id INT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS deleted (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  refund_id INT NOT NULL,
  source_invoice_id INT NOT NULL,
  source_order_item_id INT NOT NULL,
  source_parent_item_id INT DEFAULT NULL,
  product_id INT DEFAULT NULL,
  item_name VARCHAR(255) DEFAULT NULL,
  quantity DECIMAL(12,6) NOT NULL,
  item_snapshot JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uq_deleted_event_item (refund_id,source_order_item_id),
  KEY idx_deleted_source_invoice (source_invoice_id),
  CONSTRAINT fk_deleted_refund FOREIGN KEY (refund_id) REFERENCES refunds (id) ON DELETE CASCADE,
  CONSTRAINT chk_deleted_quantity CHECK (quantity > 0 OR (quantity = 0 AND source_parent_item_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-14-deleted-table-items-v1', 'b207a4706801a2ba9c933d898af7722858de031005d00d1ca8490851a09d6b4e')
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
