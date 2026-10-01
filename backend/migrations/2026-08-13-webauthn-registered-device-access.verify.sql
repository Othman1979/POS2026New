-- Read-only post-migration authority check. A result of 1 is the only valid result.
SELECT CASE WHEN
  (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN ('webauthn_credentials','webauthn_ceremonies','auth_sessions','webauthn_recovery_codes')) = 4
  AND (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
      AND COLUMN_NAME = 'webauthn_user_handle' AND DATA_TYPE = 'varbinary'
      AND CHARACTER_MAXIMUM_LENGTH = 64 AND IS_NULLABLE = 'YES') = 1
  AND (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'session_token') = 0
  AND (SELECT COUNT(*) FROM settings
    WHERE setting_key IN ('staff_device_auth_mode','webauthn_bootstrap_consumed')) = 2
  AND (SELECT checksum FROM schema_migrations
    WHERE migration_name = '2026-08-13-webauthn-registered-device-access-v1' LIMIT 1)
      = '20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09'
THEN 1 ELSE 0 END AS ok;
