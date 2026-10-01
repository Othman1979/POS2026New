-- 2026-08-10-held-order-lifecycle-v1
-- Add durable, server-owned lifecycle state to the existing held_orders authority.

SET NAMES utf8mb4;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS version INT UNSIGNED NOT NULL DEFAULT 1;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS hold_request_id VARCHAR(64) NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS claimed_by_user_id INT NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS claim_token_hash CHAR(64) NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS claim_expires_at DATETIME NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS kitchen_snapshot LONGTEXT NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS kitchen_dispatch_version INT UNSIGNED NOT NULL DEFAULT 0;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS last_operation_id VARCHAR(64) NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS last_operation_kind VARCHAR(32) NULL;

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS last_operation_result LONGTEXT NULL;

ALTER TABLE held_orders
  ADD UNIQUE INDEX IF NOT EXISTS uq_held_orders_user_request (user_id, hold_request_id);

ALTER TABLE held_orders
  ADD INDEX IF NOT EXISTS idx_held_orders_claim_owner (claimed_by_user_id);

ALTER TABLE held_orders
  ADD CONSTRAINT fk_held_orders_claim_user FOREIGN KEY IF NOT EXISTS (claimed_by_user_id)
    REFERENCES users (id) ON DELETE RESTRICT;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-10-held-order-lifecycle-v1',
  'af0234c8bce485927d509691f5b7a1445ce4e6ff6352b46822175b0165956160'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
