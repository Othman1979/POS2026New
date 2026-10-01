-- 2026-09-30-printer-last-printed-v1
-- Requires migration: 2026-09-26-expense-request-id-v1
-- Requires checksum: 317d8ee8d1a844e64e347ed07a3f969c69a5d75ae6f43883e841d1ef9d6f6e63
-- When a printer last printed a job, kept on the printer so it survives the daily print_queue purge (UTC).
SET NAMES utf8mb4;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS last_printed_at datetime DEFAULT NULL, ALGORITHM=INSTANT, LOCK=NONE;
-- Seed from acknowledged rows that still exist (they are purged daily, so this scans little); rerun safe.
UPDATE printers p SET p.last_printed_at = (SELECT MAX(q.acknowledged_at) FROM print_queue q WHERE q.printer_id = p.id AND q.status = 'acknowledged') WHERE p.last_printed_at IS NULL;
INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-30-printer-last-printed-v1', 'c9bf978dcc5e00e2dd6a5f4a09de2ef26347aabeb540a7a9fcfdc9c93a51f031')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
