-- Read-only preflight for the spooler V2 queue migration.
-- Accept the exact legacy predecessor shape or the already-shaped fresh baseline.

SELECT CASE WHEN (
  predecessor_checksum = '20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09'
  AND status_type IN (
    'enum(''pending'',''processing'',''sent'',''acknowledged'',''failed'',''dead_letter'',''canceled'')',
    'enum(''pending'',''processing'',''sent'',''acknowledged'',''failed'',''dead_letter'',''canceled'',''local_accepted'',''cancel_requested'')'
  )
)
THEN 1 ELSE 0 END AS ok
FROM (
  SELECT
    (SELECT checksum FROM schema_migrations
      WHERE migration_name = '2026-08-13-webauthn-registered-device-access-v1' LIMIT 1) AS predecessor_checksum,
    (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'print_queue'
        AND COLUMN_NAME = 'status' LIMIT 1) AS status_type
) AS authority;
