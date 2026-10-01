-- Read-only authority and index-shape check; also run before manual application.
SELECT CASE WHEN
  (SELECT COUNT(*) FROM schema_migrations
    WHERE migration_name='2026-09-12-unified-stock-movements-v1'
      AND checksum='91cba75ab3e889134d546233f79ccaa6e2dc8a7d0f9cabf4dd855154736add99') = 1
  AND (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders' AND ENGINE='InnoDB') = 1
  AND (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders' AND COLUMN_NAME IN ('created_at','id')) = 2
  AND (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders' AND INDEX_NAME='idx_held_orders_created_id') IN (0,2)
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders' AND INDEX_NAME='idx_held_orders_created_id'
      AND (NON_UNIQUE<>1 OR INDEX_TYPE<>'BTREE' OR SUB_PART IS NOT NULL
        OR NOT ((SEQ_IN_INDEX=1 AND COLUMN_NAME='created_at') OR (SEQ_IN_INDEX=2 AND COLUMN_NAME='id')))
  )
THEN 1 ELSE 0 END AS ok;
