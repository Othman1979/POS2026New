-- Read-only verification. Require blocking_findings = 0.

SET @manual_subscription_columns := 3 - (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_subscriptions' AND (
     (COLUMN_NAME='purchase_invoice_id' AND IS_NULLABLE='YES')
     OR COLUMN_NAME IN ('created_by','manual_reason')
   )
);
SET @manual_subscription_foreign_key := 1 - (
  SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
   WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='customer_subscriptions'
     AND CONSTRAINT_NAME='fk_customer_subscriptions_created_by'
     AND COLUMN_NAME='created_by' AND REFERENCED_TABLE_NAME='users'
);
SET @manual_subscription_check := 1 - (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='customer_subscriptions'
     AND CONSTRAINT_NAME='chk_customer_subscriptions_origin' AND CONSTRAINT_TYPE='CHECK'
);
SET @invalid_subscription_origins := (
  SELECT COUNT(*) FROM customer_subscriptions
   WHERE (purchase_invoice_id IS NULL AND (manual_reason IS NULL OR CHAR_LENGTH(TRIM(manual_reason))=0))
      OR (purchase_invoice_id IS NOT NULL AND manual_reason IS NOT NULL)
);
SET @manual_subscription_ledger := 1 - (
  SELECT COUNT(*) FROM schema_migrations
   WHERE migration_name='2026-07-23-admin-manual-subscriptions-v1'
     AND checksum='bfae412c0de61b04d05591a4089054e8a88bbc65433ac816a0cfd64243c904bf'
);

SELECT @manual_subscription_columns AS manual_subscription_columns,
       @manual_subscription_foreign_key AS manual_subscription_foreign_key,
       @manual_subscription_check AS manual_subscription_check,
       @invalid_subscription_origins AS invalid_subscription_origins,
       @manual_subscription_ledger AS manual_subscription_ledger,
       @manual_subscription_columns + @manual_subscription_foreign_key + @manual_subscription_check
         + @invalid_subscription_origins + @manual_subscription_ledger AS blocking_findings;
