-- Read-only verification. Require blocking_findings = 0.

SET @receivable_order_columns := 5 - (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders'
     AND COLUMN_NAME IN ('payment_due_on','receivable_reason','buyer_name_at_sale','buyer_phone_at_sale','buyer_address_at_sale')
);
SET @receivable_payment_method := 1 - (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='payment_method'
     AND COLUMN_TYPE="enum('cash','card','split','receivable','unpaid_table','voided')"
);
SET @receivable_order_index := 1 - (
  SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders'
     AND INDEX_NAME='idx_orders_receivable_due'
);
SET @receivable_order_check := 1 - (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='orders'
     AND CONSTRAINT_NAME='chk_orders_receivable_terms' AND CONSTRAINT_TYPE='CHECK'
);
SET @subscription_collection_table := 1 - (
  SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='subscription_collections' AND ENGINE='InnoDB'
);
SET @subscription_collection_columns := 14 - (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='subscription_collections'
     AND COLUMN_NAME IN ('id','subscription_id','shift_id','received_by','kind','cash_amount','card_amount','amount_tendered','change_due','business_date','reverses_collection_id','reason','idempotency_key','created_at')
);
SET @subscription_collection_foreign_keys := 4 - (
  SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
   WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='subscription_collections'
     AND CONSTRAINT_NAME IN ('fk_subscription_collections_subscription','fk_subscription_collections_shift','fk_subscription_collections_user','fk_subscription_collections_reversal')
);
SET @subscription_collection_checks := 2 - (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='subscription_collections'
     AND CONSTRAINT_NAME IN ('chk_subscription_collections_amount','chk_subscription_collections_reversal_shape')
     AND CONSTRAINT_TYPE='CHECK'
);
SET @subscription_receivable_setting := 1 - (
  SELECT COUNT(*) FROM settings
   WHERE setting_key='subscription_receivables_enabled' AND setting_value IN ('0','1')
);
SET @subscription_credit_permission := 1 - (
  SELECT COUNT(*) FROM permissions
   WHERE perm_key='pos.subscription_credit' AND implemented=1 AND default_cashier=0 AND overridable=1
);
SET @subscription_receivable_ledger := 1 - (
  SELECT COUNT(*) FROM schema_migrations
   WHERE migration_name='2026-07-29-subscription-receivables-v1'
     AND checksum='b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da'
);

SELECT @receivable_order_columns AS receivable_order_columns,
       @receivable_payment_method AS receivable_payment_method,
       @receivable_order_index AS receivable_order_index,
       @receivable_order_check AS receivable_order_check,
       @subscription_collection_table AS subscription_collection_table,
       @subscription_collection_columns AS subscription_collection_columns,
       @subscription_collection_foreign_keys AS subscription_collection_foreign_keys,
       @subscription_collection_checks AS subscription_collection_checks,
       @subscription_receivable_setting AS subscription_receivable_setting,
       @subscription_credit_permission AS subscription_credit_permission,
       @subscription_receivable_ledger AS subscription_receivable_ledger,
       @receivable_order_columns + @receivable_payment_method + @receivable_order_index
         + @receivable_order_check + @subscription_collection_table + @subscription_collection_columns
         + @subscription_collection_foreign_keys + @subscription_collection_checks
         + @subscription_receivable_setting + @subscription_credit_permission
         + @subscription_receivable_ledger AS blocking_findings;
