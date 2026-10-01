-- Read-only predecessor and object-shape check; permits an absent or exact table.
SELECT CASE WHEN
  (SELECT COUNT(*) FROM schema_migrations
    WHERE migration_name='2026-09-19-customer-phone-index-v1'
      AND checksum='3438435e3ac707d8a184ff84f88acd8f2a220ec8222401752466267c383d527a') = 1
  AND (SELECT COUNT(*) FROM schema_migrations
    WHERE migration_name='2026-09-20-order-intake-requests-v1') IN (0,1)
  AND NOT EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE migration_name='2026-09-20-order-intake-requests-v1'
       AND checksum<>'8c7d856018e4f9871947c2a4cca25a27b8e5397ed276b647f66e88b9798d77ab'
  )
  AND (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests') IN (0,1)
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests' AND ENGINE<>'InnoDB'
  )
  AND (
    (SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests') = 0
    OR (
      (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests') = 6
      AND (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests'
          AND ((COLUMN_NAME='client_id' AND DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=40 AND IS_NULLABLE='NO' AND COLLATION_NAME='ascii_bin')
            OR (COLUMN_NAME='external_request_id' AND DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=128 AND IS_NULLABLE='NO' AND COLLATION_NAME='ascii_bin')
            OR (COLUMN_NAME='request_hash' AND DATA_TYPE='char' AND CHARACTER_MAXIMUM_LENGTH=64 AND IS_NULLABLE='NO' AND COLLATION_NAME='ascii_bin')
            OR (COLUMN_NAME='held_order_id' AND DATA_TYPE='int' AND IS_NULLABLE='NO')
            OR (COLUMN_NAME='result_json' AND DATA_TYPE='longtext' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_bin')
            OR (COLUMN_NAME='created_at' AND DATA_TYPE='datetime' AND IS_NULLABLE='NO'))) = 6
      AND (SELECT COUNT(*) FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests' AND INDEX_NAME='PRIMARY') = 2
      AND (SELECT COUNT(*) FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests' AND INDEX_NAME='PRIMARY'
          AND NON_UNIQUE=0 AND INDEX_TYPE='BTREE' AND SUB_PART IS NULL
          AND ((SEQ_IN_INDEX=1 AND COLUMN_NAME='client_id') OR (SEQ_IN_INDEX=2 AND COLUMN_NAME='external_request_id'))) = 2
      AND (SELECT COUNT(*) FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests'
          AND INDEX_NAME='idx_order_intake_held_order') = 1
      AND (SELECT COUNT(*) FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests'
          AND INDEX_NAME='idx_order_intake_held_order' AND SEQ_IN_INDEX=1 AND COLUMN_NAME='held_order_id'
          AND NON_UNIQUE=1 AND INDEX_TYPE='BTREE' AND SUB_PART IS NULL) = 1
      AND (SELECT COUNT(*) FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests'
          AND INDEX_NAME='idx_order_intake_created_at') = 1
      AND (SELECT COUNT(*) FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests'
          AND INDEX_NAME='idx_order_intake_created_at' AND SEQ_IN_INDEX=1 AND COLUMN_NAME='created_at'
          AND NON_UNIQUE=1 AND INDEX_TYPE='BTREE' AND SUB_PART IS NULL) = 1
      AND (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests'
          AND CONSTRAINT_NAME='chk_order_intake_result_json' AND CONSTRAINT_TYPE='CHECK') = 1
    )
  )
THEN 1 ELSE 0 END AS ok;
