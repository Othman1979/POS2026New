-- 2026-09-13-table-action-recovery-v1
-- Requires migration: 2026-09-12-held-report-date-index-v1
-- Requires checksum: 46e59d46adeee1ecd3dd569e42af670da9f3f36500daed5a8aa6f00b18789034
-- Durable table-action results survive bill deletion, settlement and later moves.
-- No foreign keys: deleting a bill/user/table must not enable replay of an old action.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS table_action_operations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  action VARCHAR(16) NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json LONGTEXT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_table_action_operation (operation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-13-table-action-recovery-v1', '00d70c67196cead73af1f41767ecac4157373047f4289a02d9c27cac2d0c2d92')
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
