-- Read-only post-import verification. Require blocking_findings = 0.

SET @ps_subscription_tables := 7 - (
    SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (
      'subscription_plans', 'subscription_plan_products', 'customer_subscriptions',
      'customer_subscription_products', 'subscription_extensions',
      'subscription_redemptions', 'subscription_redemption_items'
    )
);
SET @ps_subscription_permission := 1 - (
    SELECT COUNT(*) FROM permissions WHERE perm_key='pos.subscriptions' AND implemented=1
);
SET @ps_subscription_columns := 53 - (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND (
      (TABLE_NAME='subscription_plans' AND COLUMN_NAME IN ('id','sale_product_id','included_credits','duration_days','is_active','created_by','created_at','updated_at')) OR
      (TABLE_NAME='subscription_plan_products' AND COLUMN_NAME IN ('plan_id','product_id')) OR
      (TABLE_NAME='customer_subscriptions' AND COLUMN_NAME IN ('id','customer_id','plan_id','purchase_invoice_id','starts_on','ends_on','total_credits','status','cancelled_at','cancelled_by','cancellation_reason','created_at')) OR
      (TABLE_NAME='customer_subscription_products' AND COLUMN_NAME IN ('subscription_id','product_id')) OR
      (TABLE_NAME='subscription_extensions' AND COLUMN_NAME IN ('id','subscription_id','old_ends_on','new_ends_on','reason','extended_by','created_at')) OR
      (TABLE_NAME='subscription_redemptions' AND COLUMN_NAME IN ('id','subscription_id','redeemed_by','shift_id','business_date','additional_meal_reason','stock_deducted','status','reversed_at','reversed_by','reversal_reason','idempotency_key','created_at')) OR
      (TABLE_NAME='subscription_redemption_items' AND COLUMN_NAME IN ('id','redemption_id','product_id','item_name','quantity','note','selected_modifiers','bundle_items','sort_order'))
    )
);
SET @ps_subscription_primary_keys := 7 - (
    SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='PRIMARY KEY'
      AND TABLE_NAME IN (
        'subscription_plans', 'subscription_plan_products', 'customer_subscriptions',
        'customer_subscription_products', 'subscription_extensions',
        'subscription_redemptions', 'subscription_redemption_items'
      )
);
SET @ps_subscription_indexes := 13 - (
    SELECT COUNT(*) FROM (
      SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND INDEX_NAME IN (
        'uq_subscription_plans_sale_product','idx_subscription_plans_active',
        'idx_subscription_plan_products_product','uq_customer_subscriptions_invoice',
        'idx_customer_subscriptions_customer_state','idx_customer_subscriptions_state_end',
        'idx_subscription_extensions_subscription','uq_subscription_redemptions_idempotency',
        'idx_subscription_redemptions_balance','idx_subscription_redemptions_business_date',
        'idx_subscription_redemptions_shift','idx_subscription_redemption_items_redemption',
        'idx_subscription_redemption_items_product'
      ) GROUP BY INDEX_NAME
    ) required_subscription_indexes
);
SET @ps_subscription_ledger := 1 - (
    SELECT COUNT(*) FROM schema_migrations
    WHERE migration_name='2026-07-22-customer-meal-subscriptions-v1'
      AND checksum='dab2c93b0761f3c3793bb53e0b4314b8beb15f51f72a07c6b65b1dd82424d754'
);
SET @ps_subscription_foreign_keys := 18 - (
    SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME IN (
      'fk_subscription_plans_sale_product', 'fk_subscription_plans_created_by',
      'fk_subscription_plan_products_plan', 'fk_subscription_plan_products_product',
      'fk_customer_subscriptions_customer', 'fk_customer_subscriptions_plan',
      'fk_customer_subscriptions_invoice', 'fk_customer_subscriptions_cancelled_by',
      'fk_customer_subscription_products_subscription', 'fk_customer_subscription_products_product',
      'fk_subscription_extensions_subscription', 'fk_subscription_extensions_extended_by',
      'fk_subscription_redemptions_subscription', 'fk_subscription_redemptions_redeemed_by',
      'fk_subscription_redemptions_shift', 'fk_subscription_redemptions_reversed_by',
      'fk_subscription_redemption_items_redemption', 'fk_subscription_redemption_items_product'
    )
);
SET @ps_subscription_checks := 13 - (
    SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='CHECK' AND CONSTRAINT_NAME IN (
      'chk_subscription_plans_credits', 'chk_subscription_plans_duration', 'chk_subscription_plans_active',
      'chk_customer_subscriptions_dates', 'chk_customer_subscriptions_credits', 'chk_customer_subscriptions_status',
      'chk_subscription_extensions_dates', 'chk_subscription_extensions_reason',
      'chk_subscription_redemptions_status', 'chk_subscription_redemptions_stock',
      'chk_subscription_redemption_items_quantity', 'chk_subscription_redemption_items_modifiers_json',
      'chk_subscription_redemption_items_bundle_json'
    )
);

SELECT 'subscription_tables' AS check_name, @ps_subscription_tables AS missing_count, @ps_subscription_tables AS blocking_findings
UNION ALL SELECT 'subscription_columns', @ps_subscription_columns, @ps_subscription_columns
UNION ALL SELECT 'subscription_primary_keys', @ps_subscription_primary_keys, @ps_subscription_primary_keys
UNION ALL SELECT 'subscription_indexes', @ps_subscription_indexes, @ps_subscription_indexes
UNION ALL SELECT 'subscription_permission', @ps_subscription_permission, @ps_subscription_permission
UNION ALL SELECT 'subscription_foreign_keys', @ps_subscription_foreign_keys, @ps_subscription_foreign_keys
UNION ALL SELECT 'subscription_checks', @ps_subscription_checks, @ps_subscription_checks
UNION ALL SELECT 'migration_ledger', @ps_subscription_ledger, @ps_subscription_ledger;

SELECT (
  @ps_subscription_tables + @ps_subscription_columns + @ps_subscription_primary_keys +
  @ps_subscription_indexes + @ps_subscription_permission + @ps_subscription_foreign_keys +
  @ps_subscription_checks + @ps_subscription_ledger
) AS blocking_findings;
