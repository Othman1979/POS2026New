-- Read-only preflight. Require blocking_findings = 0 before applying the paired migration.

SET @database_selected := IF(DATABASE() IS NULL, 1, 0);
SET @required_tables := 5 - (
  SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE()
     AND TABLE_NAME IN ('orders','customer_subscriptions','shifts','users','permissions')
);
SET @migration_applied := (
  SELECT COUNT(*) FROM schema_migrations
   WHERE migration_name='2026-07-29-subscription-receivables-v1'
     AND checksum='b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da'
);
SET @unowned_receivable_artifacts := IF(@migration_applied=1, 0, (
  SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='subscription_collections'
) + (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders'
     AND COLUMN_NAME IN ('payment_due_on','receivable_reason','buyer_name_at_sale','buyer_phone_at_sale','buyer_address_at_sale')
));

SELECT @database_selected AS database_selected,
       @required_tables AS required_tables,
       @unowned_receivable_artifacts AS unowned_receivable_artifacts,
       @database_selected + @required_tables + @unowned_receivable_artifacts AS blocking_findings;
