-- Waiter permission system: adds the 5 waiter-specific catalog keys and backfills
-- per-user grants from the legacy waiter boolean columns. Cashier/shared keys are
-- untouched. Apply through a utf8mb4 client (apply-waiter-permissions.js or
-- mysql --default-character-set=utf8mb4) so the Arabic text is not mangled.
SET NAMES utf8mb4;

INSERT INTO permissions
  (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable) VALUES
('waiter.edit_locked',     'Edit Saved Order',      'تعديل طلب محفوظ',   'Edit or add to an order after it has been saved/sent.', 'تعديل أو الإضافة إلى طلب بعد حفظه/إرساله.', 'waiter', 200, 1, 0, 0),
('waiter.override_tables', "Override Others' Tables",'تجاوز طاولات الآخرين','Act on a table owned by another waiter.',              'العمل على طاولة يملكها نادل آخر.',         'waiter', 210, 1, 0, 0),
('waiter.checkout',        'Checkout Table',        'دفع الطاولة',        'Settle and take payment for a table order.',           'تسوية واستلام دفع طلب الطاولة.',           'waiter', 220, 1, 0, 0),
('waiter.transfer_table',  'Transfer Table',        'نقل الطاولة',        'Move an order from one table to another.',             'نقل الطلب من طاولة إلى أخرى.',             'waiter', 230, 1, 0, 0),
('waiter.merge_tables',    'Merge Tables',          'دمج الطاولات',       'Join or merge tables together.',                       'ضم أو دمج الطاولات معاً.',                 'waiter', 240, 1, 0, 0)
ON DUPLICATE KEY UPDATE label=VALUES(label), label_ar=VALUES(label_ar), description=VALUES(description), description_ar=VALUES(description_ar), category=VALUES(category), sort_order=VALUES(sort_order);

-- Backfill grants from legacy columns for active waiters (preserve current access).
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'waiter.edit_locked'     FROM users WHERE is_active=1 AND role='waiter' AND can_update_table = 1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'waiter.override_tables' FROM users WHERE is_active=1 AND role='waiter' AND bypass_existing_tables = 1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'waiter.transfer_table'  FROM users WHERE is_active=1 AND role='waiter' AND can_transfer_table = 1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'waiter.merge_tables'    FROM users WHERE is_active=1 AND role='waiter' AND can_join_tables = 1;
-- Shared keys backfilled for waiters from their legacy columns.
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.void_printed_item'  FROM users WHERE is_active=1 AND role='waiter' AND bypass_printed_tables = 1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.split_checks'       FROM users WHERE is_active=1 AND role='waiter' AND (waiter_split_bill = 1 OR can_split_bills = 1);
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'orders.view'            FROM users WHERE is_active=1 AND role='waiter' AND can_view_order_history = 1;
-- NOTE: waiter.checkout has no legacy equivalent and is intentionally NOT backfilled (default off).
