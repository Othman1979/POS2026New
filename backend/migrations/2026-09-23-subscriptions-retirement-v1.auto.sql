-- 2026-09-23-subscriptions-retirement-v1
-- Requires migration: 2026-09-22-product-customer-info-v1
-- Requires checksum: e124551d700c0b76f7735f9593507df7647d5f66c36b6834b08459349705dd30
-- Stop application writers before running. Customer subscription history blocks retirement; unused plan configuration may be dropped.
SET NAMES utf8mb4;
SET @subscription_retirement_empty =
  (SELECT COUNT(*) FROM schema_migrations WHERE migration_name='2026-09-22-product-customer-info-v1' AND checksum='e124551d700c0b76f7735f9593507df7647d5f66c36b6834b08459349705dd30')=1
  AND (SELECT COUNT(*) FROM schema_migrations WHERE migration_name='2026-09-23-subscriptions-retirement-v1')=0
  AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('subscription_plans','subscription_plan_products','customer_subscriptions','customer_subscription_products','subscription_extensions','subscription_collections','subscription_redemptions','subscription_redemption_items') AND TABLE_TYPE='BASE TABLE' AND ENGINE='InnoDB')=8
  AND NOT EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IN ('subscription_plans','subscription_plan_products','customer_subscriptions','customer_subscription_products','subscription_extensions','subscription_collections','subscription_redemptions','subscription_redemption_items') AND TABLE_NAME NOT IN ('subscription_plans','subscription_plan_products','customer_subscriptions','customer_subscription_products','subscription_extensions','subscription_collections','subscription_redemptions','subscription_redemption_items'))
  AND (SELECT COUNT(*) FROM customer_subscriptions)=0
  AND (SELECT COUNT(*) FROM customer_subscription_products)=0
  AND (SELECT COUNT(*) FROM subscription_extensions)=0
  AND (SELECT COUNT(*) FROM subscription_collections)=0
  AND (SELECT COUNT(*) FROM subscription_redemptions)=0
  AND (SELECT COUNT(*) FROM subscription_redemption_items)=0;
SET @subscription_retirement_guard = IF(@subscription_retirement_empty, 'SELECT 1', 'SUBSCRIPTION_RETIREMENT_BLOCKED_NONEMPTY_DATA');
PREPARE subscription_retirement_check FROM @subscription_retirement_guard;
EXECUTE subscription_retirement_check;
DEALLOCATE PREPARE subscription_retirement_check;
DROP TABLE subscription_redemption_items;
DROP TABLE subscription_redemptions;
DROP TABLE subscription_collections;
DROP TABLE subscription_extensions;
DROP TABLE customer_subscription_products;
DROP TABLE customer_subscriptions;
DROP TABLE subscription_plan_products;
DROP TABLE subscription_plans;
DELETE FROM user_permissions WHERE perm_key IN ('pos.subscriptions','pos.subscription_credit');
DELETE FROM permissions WHERE perm_key IN ('pos.subscriptions','pos.subscription_credit');
DELETE FROM settings WHERE setting_key='subscription_receivables_enabled';
INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-23-subscriptions-retirement-v1', '2133bbc1d19f437389429029dae9909fc5cc325198c64c8e1f3873168e863ebd')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
