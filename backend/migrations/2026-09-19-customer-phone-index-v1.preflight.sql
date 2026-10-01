-- Read-only predecessor and object-shape check; permits an absent or exact partial migration.
SELECT CASE WHEN
  (SELECT COUNT(*) FROM schema_migrations
    WHERE migration_name='2026-09-17-print-queue-timings-v1'
      AND checksum='3bc2bd5d5fb08f32ded8952ee570408c33bb493efd97b206d8bd09d0205d687e') = 1
  AND (SELECT COUNT(*) FROM schema_migrations
    WHERE migration_name='2026-09-19-customer-phone-index-v1') IN (0,1)
  AND NOT EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE migration_name='2026-09-19-customer-phone-index-v1'
       AND checksum<>'3438435e3ac707d8a184ff84f88acd8f2a220ec8222401752466267c383d527a'
  )
  AND (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND ENGINE='InnoDB') = 1
  AND (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND COLUMN_NAME='phone'
      AND DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=20) = 1
  AND (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND COLUMN_NAME='phone_normalized') IN (0,1)
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND COLUMN_NAME='phone_normalized'
       AND NOT (
         DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=20
         AND EXTRA LIKE '%STORED GENERATED%'
         AND SHA2(LOWER(REPLACE(REPLACE(REPLACE(REPLACE(GENERATION_EXPRESSION, CHAR(96), ''), ' ', ''), CHAR(10), ''), CHAR(13), '')), 256) =
           '22746e58aecf192cac21d1da464622d07912c53aa199bccf3339ecc55614f270'
       )
  )
  AND (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND INDEX_NAME='idx_customers_phone_normalized') IN (0,2)
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND INDEX_NAME='idx_customers_phone_normalized'
       AND (NON_UNIQUE<>1 OR INDEX_TYPE<>'BTREE' OR SUB_PART IS NOT NULL
         OR NOT ((SEQ_IN_INDEX=1 AND COLUMN_NAME='phone_normalized') OR (SEQ_IN_INDEX=2 AND COLUMN_NAME='id')))
  )
THEN 1 ELSE 0 END AS ok;
