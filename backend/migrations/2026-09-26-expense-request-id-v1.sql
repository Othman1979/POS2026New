-- 2026-09-26-expense-request-id-v1
-- Requires migration: 2026-09-23-subscriptions-retirement-v1
-- Requires checksum: 2133bbc1d19f437389429029dae9909fc5cc325198c64c8e1f3873168e863ebd
-- Optional client request id so a retried POS expense replays instead of deducting the drawer twice.
SET NAMES utf8mb4;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS request_id varchar(64) DEFAULT NULL, ALGORITHM=INSTANT, LOCK=NONE;
ALTER TABLE expenses ADD UNIQUE KEY IF NOT EXISTS uq_expenses_request (created_by, request_id), ALGORITHM=INPLACE, LOCK=NONE;
INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-26-expense-request-id-v1', '317d8ee8d1a844e64e347ed07a3f969c69a5d75ae6f43883e841d1ef9d6f6e63')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
