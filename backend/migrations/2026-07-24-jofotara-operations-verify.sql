SET @jofotara_operations_settings := 2 - (
  SELECT COUNT(*) FROM settings
   WHERE (setting_key='jofotara_auto_submit' AND setting_value IN ('0','1'))
      OR (setting_key='jofotara_auto_submit_since')
);
SET @jofotara_operations_ledger := 1 - (
  SELECT COUNT(*) FROM schema_migrations
   WHERE migration_name='2026-07-24-jofotara-operations-v1'
     AND checksum='3106a8e43bc3ad579e57e0a50e0bc7ac7e48f0cca6b9851fedd272c845ebc36e'
);

SELECT 'jofotara_operations_settings' check_name, @jofotara_operations_settings blocking_findings
UNION ALL SELECT 'jofotara_operations_ledger', @jofotara_operations_ledger;
SELECT @jofotara_operations_settings + @jofotara_operations_ledger AS blocking_findings;
