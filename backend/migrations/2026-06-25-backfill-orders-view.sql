-- Completes the orders.view normalization. The cashier model migration backfilled
-- orders.view from the legacy `can_view_orders` column; the waiter migration backfilled
-- it from `can_view_order_history` for waiters only. This closes the remaining gap:
-- grant orders.view to every active non-admin user who still holds the live legacy
-- `can_view_order_history` flag, so the backend can drop its legacy fallback without
-- orphaning anyone. Idempotent (INSERT IGNORE). No Arabic text, but applied through the
-- node applier for parity with the other permission migrations.
SET NAMES utf8mb4;

INSERT IGNORE INTO user_permissions (user_id, perm_key)
  SELECT id, 'orders.view'
  FROM users
  WHERE is_active = 1
    AND role NOT IN ('admin', 'programmer')
    AND can_view_order_history = 1;
