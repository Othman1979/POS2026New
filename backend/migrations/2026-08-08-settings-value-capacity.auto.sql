-- Hostinger-safe automatic form of 2026-08-08-settings-value-capacity-v1.
-- Widen settings values in place; existing rows are preserved and setting_value is not indexed.
-- Preconditions, checksum conflicts, file integrity, and serialization are enforced by runPendingMigrations.js.

SET NAMES utf8mb4;

ALTER TABLE settings
  MODIFY COLUMN setting_value TEXT NOT NULL;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-08-settings-value-capacity-v1',
  'ff924b0bcdddcf8e6516dca12c8a89bd0e1dc811dafe8e1e91d71d99f3e91cff'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
