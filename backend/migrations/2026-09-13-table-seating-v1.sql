-- 2026-09-13-table-seating-v1
-- Requires migration: 2026-09-13-paid-split-parent-index-v1
-- Requires checksum: ea1306e908192591951672a4dc91197877f7d707522193ac63802364d3a94136
-- Seating is independent from the legacy shared-bill parent_table_id relationship.
-- Read the matching preflight before manual application. No bill/item writes.
SET NAMES utf8mb4;

ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS seating_parent_id INT DEFAULT NULL,
  ADD INDEX IF NOT EXISTS idx_tables_seating_parent (seating_parent_id);

ALTER TABLE restaurant_tables
  ADD CONSTRAINT fk_tables_seating_parent FOREIGN KEY IF NOT EXISTS (seating_parent_id)
  REFERENCES restaurant_tables (id) ON DELETE SET NULL;

-- An interrupted application may resume the backfill. Once the ledger exists,
-- raw replay must not restore seating links the operator has since separated.
UPDATE restaurant_tables
   SET seating_parent_id=parent_table_id
 WHERE seating_parent_id IS NULL AND parent_table_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-13-table-seating-v1');

-- Empty groups have no issued bill identity to preserve. Their next orders are
-- independent; existing occupied/printed aliases retain parent_table_id.
UPDATE restaurant_tables
   SET parent_table_id=NULL
 WHERE current_order_id IS NULL AND parent_table_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-13-table-seating-v1');

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-13-table-seating-v1', '78f8798435bc6e44e45aeb1642189f42a9d562edb268354868b6d3e5a7674ab1')
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
