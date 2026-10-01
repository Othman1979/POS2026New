-- Read-only authority and compatible partial-install checks. No business writes.
SELECT CASE WHEN
  (SELECT COUNT(*) FROM schema_migrations WHERE migration_name='2026-09-13-paid-split-parent-index-v1' AND checksum='ea1306e908192591951672a4dc91197877f7d707522193ac63802364d3a94136')=1
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='restaurant_tables' AND ENGINE='InnoDB')=1
  AND NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='restaurant_tables' AND COLUMN_NAME='seating_parent_id'
    AND (DATA_TYPE<>'int' OR COLUMN_TYPE LIKE '%unsigned%' OR IS_NULLABLE<>'YES'))
  AND (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='restaurant_tables' AND INDEX_NAME='idx_tables_seating_parent') IN (0,1)
  AND NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='restaurant_tables' AND INDEX_NAME='idx_tables_seating_parent'
    AND (COLUMN_NAME<>'seating_parent_id' OR NON_UNIQUE<>1 OR SUB_PART IS NOT NULL OR INDEX_TYPE<>'BTREE'))
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
    WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.TABLE_NAME='restaurant_tables' AND k.CONSTRAINT_NAME='fk_tables_seating_parent'
      AND (k.COLUMN_NAME<>'seating_parent_id' OR k.REFERENCED_TABLE_NAME<>'restaurant_tables' OR k.REFERENCED_COLUMN_NAME<>'id' OR r.DELETE_RULE<>'SET NULL')
  )
  AND NOT EXISTS (SELECT 1 FROM restaurant_tables child LEFT JOIN restaurant_tables parent ON parent.id=child.parent_table_id
    WHERE child.parent_table_id IS NOT NULL AND (parent.id IS NULL OR parent.id=child.id OR parent.parent_table_id IS NOT NULL))
THEN 1 ELSE 0 END AS ok;
