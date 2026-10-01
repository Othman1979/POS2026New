-- Read-only retirement guard. Customer subscription history blocks retirement; unused plan configuration may be dropped.
SELECT CASE WHEN
  (SELECT COUNT(*) FROM schema_migrations WHERE migration_name='2026-09-22-product-customer-info-v1' AND checksum='e124551d700c0b76f7735f9593507df7647d5f66c36b6834b08459349705dd30')=1
  AND (SELECT COUNT(*) FROM schema_migrations WHERE migration_name='2026-09-23-subscriptions-retirement-v1')=0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('subscription_plans','subscription_plan_products','customer_subscriptions','customer_subscription_products','subscription_extensions','subscription_collections','subscription_redemptions','subscription_redemption_items') AND TABLE_TYPE='BASE TABLE' AND ENGINE='InnoDB')=8
  AND NOT EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IN ('subscription_plans','subscription_plan_products','customer_subscriptions','customer_subscription_products','subscription_extensions','subscription_collections','subscription_redemptions','subscription_redemption_items') AND TABLE_NAME NOT IN ('subscription_plans','subscription_plan_products','customer_subscriptions','customer_subscription_products','subscription_extensions','subscription_collections','subscription_redemptions','subscription_redemption_items'))
  AND (SELECT COUNT(*) FROM customer_subscriptions)=0
  AND (SELECT COUNT(*) FROM customer_subscription_products)=0
  AND (SELECT COUNT(*) FROM subscription_extensions)=0
  AND (SELECT COUNT(*) FROM subscription_collections)=0
  AND (SELECT COUNT(*) FROM subscription_redemptions)=0
  AND (SELECT COUNT(*) FROM subscription_redemption_items)=0
THEN 1 ELSE 0 END AS ok;
