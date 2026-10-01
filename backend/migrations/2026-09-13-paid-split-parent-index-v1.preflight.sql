-- Read-only authority and exact index-shape check; also run before manual application.
SELECT CASE WHEN
  (SELECT COUNT(*) FROM schema_migrations
    WHERE migration_name='2026-09-13-table-action-recovery-v1'
      AND checksum='00d70c67196cead73af1f41767ecac4157373047f4289a02d9c27cac2d0c2d92') = 1
  AND (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND ENGINE='InnoDB') = 1
  AND (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME IN ('parent_invoice_id','payment_method')) = 2
  AND (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND INDEX_NAME='idx_orders_parent_payment') IN (0,2)
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND INDEX_NAME='idx_orders_parent_payment'
      AND (NON_UNIQUE<>1 OR INDEX_TYPE<>'BTREE' OR SUB_PART IS NOT NULL
        OR NOT ((SEQ_IN_INDEX=1 AND COLUMN_NAME='parent_invoice_id') OR (SEQ_IN_INDEX=2 AND COLUMN_NAME='payment_method')))
  )
THEN 1 ELSE 0 END AS ok;
