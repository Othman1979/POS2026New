-- 2026-08-23-audit-browser-preview-v1
-- Requires migration: 2026-08-17-spooler-v2-agents-v1
-- Requires checksum: e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985
-- Requires normalized SQL SHA-256: 27d3cf2d886dd7161eda08755a398154469567be0008287a3d2aa862439ae1c4
-- Record that an immutable audit report payload is ready for browser printing.

SET NAMES utf8mb4;

ALTER TABLE audit_report_documents
  MODIFY COLUMN last_print_status ENUM('queued','printed','failed','browser_ready') NOT NULL DEFAULT 'queued',
  ALGORITHM=INSTANT, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-23-audit-browser-preview-v1',
  'e76a5c6a6ff9e831d6c5e5f5d907ba01732f5cd6446b231cc732b9e7728198af'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
