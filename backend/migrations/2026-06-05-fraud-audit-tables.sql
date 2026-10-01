-- Migration: Fraud Remediation — Audit Tables & Void Integrity Columns
-- Date: 2026-06-05
-- Description:
--   1. Adds original_total/subtotal/tax columns to orders so voided records
--      preserve their financial value for audit reconstruction.
--   2. Creates audit_events table: durable, queryable log for security events
--      (void_order, drawer_pop, pin_override_failed/success/locked, price_changed,
--       shift_close_blocked). Survives log rotation.
--   3. Creates price_history table: append-only log of product price mutations.

-- ─── 1. Preserve original void values on orders ──────────────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS original_total    DECIMAL(10,3) DEFAULT NULL COMMENT 'Pre-void total — preserved for audit',
  ADD COLUMN IF NOT EXISTS original_subtotal DECIMAL(10,3) DEFAULT NULL COMMENT 'Pre-void subtotal — preserved for audit',
  ADD COLUMN IF NOT EXISTS original_tax      DECIMAL(10,3) DEFAULT NULL COMMENT 'Pre-void tax — preserved for audit';

-- ─── 2. Audit events table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type  VARCHAR(64)     NOT NULL                   COMMENT 'void_order | drawer_pop | pin_override_failed | pin_override_success | pin_override_locked | price_changed | shift_close_blocked',
  user_id     INT UNSIGNED    DEFAULT NULL               COMMENT 'The cashier/waiter performing the action',
  manager_id  INT UNSIGNED    DEFAULT NULL               COMMENT 'The manager who authorised the action (if applicable)',
  entity_type VARCHAR(32)     DEFAULT NULL               COMMENT 'order | product | shift | table',
  entity_id   BIGINT          DEFAULT NULL               COMMENT 'The invoice_id / product_id / shift_id etc.',
  old_value   TEXT            DEFAULT NULL               COMMENT 'JSON blob of prior state (e.g. old price, old total)',
  new_value   TEXT            DEFAULT NULL               COMMENT 'JSON blob of new state or reason',
  ip_address  VARCHAR(64)     DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_audit_event_type  (event_type),
  INDEX idx_audit_user_id     (user_id),
  INDEX idx_audit_created_at  (created_at),
  INDEX idx_audit_entity      (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 3. Price history table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_history (
  id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  product_id  INT UNSIGNED    NOT NULL,
  old_price   DECIMAL(10,3)   NOT NULL,
  new_price   DECIMAL(10,3)   NOT NULL,
  changed_by  INT UNSIGNED    NOT NULL               COMMENT 'users.id of the admin who changed the price',
  changed_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_price_history_product    (product_id),
  INDEX idx_price_history_changed_at (changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
