-- 2026-08-30-jofotara-stale-submission-index-v1
-- Requires migration: 2026-08-23-audit-browser-preview-v1
-- Requires checksum: e76a5c6a6ff9e831d6c5e5f5d907ba01732f5cd6446b231cc732b9e7728198af
-- Add the covering index used by stale-submission recovery without changing rows.

SET NAMES utf8mb4;

ALTER TABLE jofotara_documents
  ADD INDEX IF NOT EXISTS idx_jofotara_status_attempt (status, last_attempt_at),
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-30-jofotara-stale-submission-index-v1',
  '5c2daeb9a9f20a82a35503906ea8d99303922fea7cd7596186ad6041ae1d56ed'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
