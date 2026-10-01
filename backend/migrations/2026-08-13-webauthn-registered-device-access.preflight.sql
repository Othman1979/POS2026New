-- Read-only gate for the registered-device migration.
-- Accept only the exact legacy predecessor shape or the exact current baseline shape.
SELECT
  CASE
    WHEN predecessor_checksum = 'eeefbd8ab9baed40052468558f88ad84851c8ad6f99630cd7c145902d9cdcc76'
     AND (
       (target_table_count = 0 AND webauthn_handle_count = 0 AND legacy_session_count = 1)
       OR
       (target_table_count = 4 AND webauthn_handle_count = 1 AND legacy_session_count = 0
        AND credential_column_count = 20 AND ceremony_column_count = 16
        AND session_column_count = 11 AND recovery_column_count = 8)
     )
    THEN 1 ELSE 0
  END AS ok
FROM (
  SELECT
    (SELECT checksum FROM schema_migrations
      WHERE migration_name = '2026-08-13-split-quantity-precision-v1' LIMIT 1) AS predecessor_checksum,
    (SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('webauthn_credentials','webauthn_ceremonies','auth_sessions','webauthn_recovery_codes')) AS target_table_count,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
        AND COLUMN_NAME = 'webauthn_user_handle' AND DATA_TYPE = 'varbinary'
        AND CHARACTER_MAXIMUM_LENGTH = 64 AND IS_NULLABLE = 'YES') AS webauthn_handle_count,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
        AND COLUMN_NAME = 'session_token' AND DATA_TYPE = 'varchar'
        AND CHARACTER_MAXIMUM_LENGTH = 128 AND IS_NULLABLE = 'YES') AS legacy_session_count,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webauthn_credentials') AS credential_column_count,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webauthn_ceremonies') AS ceremony_column_count,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auth_sessions') AS session_column_count,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webauthn_recovery_codes') AS recovery_column_count
) AS authority;
