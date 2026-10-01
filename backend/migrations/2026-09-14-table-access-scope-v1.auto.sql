-- 2026-09-14-table-access-scope-v1
-- Requires migration: 2026-09-14-permission-catalog-v1
-- Requires checksum: 4776f118d24edefde22d81c73fac61ba77485106107fef027d09dc8536ac0883
-- Preserve existing effective section access, then make future choices explicit.
SET NAMES utf8mb4;

-- Nullable until backfill so an interrupted DDL/backfill can resume safely.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS table_access_scope ENUM('all','selected','none') DEFAULT NULL AFTER allowed_sections;

UPDATE users
   SET table_access_scope = CASE
     WHEN role IN ('admin','programmer') THEN 'all'
     WHEN role='call_center' THEN 'none'
     WHEN TRIM(COALESCE(allowed_sections,''))<>'' THEN 'selected'
     WHEN role='waiter' THEN 'none'
     ELSE 'all'
   END
 WHERE table_access_scope IS NULL;

-- Direct SQL-created staff default to no sections unless explicitly assigned.
ALTER TABLE users
  MODIFY COLUMN table_access_scope ENUM('all','selected','none') NOT NULL DEFAULT 'selected';

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-14-table-access-scope-v1', 'd468f12404cd2dfbb870f0476e5e791895837bd4924c82a6fdb111fb7d3bc919')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
