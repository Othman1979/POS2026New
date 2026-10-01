-- 2026-09-30-multi-terminal-permission-v1
-- Requires migration: 2026-09-30-printer-last-printed-v1
-- Requires checksum: c9bf978dcc5e00e2dd6a5f4a09de2ef26347aabeb540a7a9fcfdc9c93a51f031
-- Install the auth.multi_terminal permission; preserve grants and installation defaults.

SET NAMES utf8mb4;

INSERT INTO permissions (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
VALUES
('auth.multi_terminal', 'Stay signed in on several terminals', 'البقاء مسجلاً على أكثر من جهاز', 'Signing in on another terminal does not sign this employee out of the first one. Both terminals sell into the same shift.', 'تسجيل الدخول من جهاز آخر لا يُخرج الموظف من الجهاز الأول. يبيع الجهازان ضمن الوردية نفسها.', 'auth', 300, 1, 0, 0)
ON DUPLICATE KEY UPDATE
  label=VALUES(label),
  label_ar=VALUES(label_ar),
  description=VALUES(description),
  description_ar=VALUES(description_ar),
  category=VALUES(category),
  sort_order=VALUES(sort_order),
  implemented=VALUES(implemented);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-30-multi-terminal-permission-v1',
  '39060fd593fffd1667e754a3a7a1708ad73636faaaf00b50e86ad994bb6df893'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
