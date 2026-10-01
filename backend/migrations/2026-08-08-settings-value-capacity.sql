-- Widen settings values without rewriting the existing settings rows.
-- setting_key remains the only indexed column; setting_value is intentionally not indexed.

SET NAMES utf8mb4;

ALTER TABLE settings
  MODIFY COLUMN setting_value TEXT NOT NULL;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-08-settings-value-capacity-v1',
  'ff924b0bcdddcf8e6516dca12c8a89bd0e1dc811dafe8e1e91d71d99f3e91cff'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
