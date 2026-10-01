# Service-charge snapshot rollout

This migration is a controlled cutoff. Do not run it while any fee-bearing unpaid table or held order exists, and never use the test rehearsal commands against production.

## Preflight

1. Disable new service-charge application operationally.
2. Confirm the target database explicitly and take a restorable backup of the `orders`, `order_items`, `held_orders`, and `settings` tables plus the database schema.
3. Run both cutoff queries against the target database:

```sql
SELECT COUNT(DISTINCT o.invoice_id) AS open_fee_orders
FROM orders o
JOIN order_items oi ON oi.invoice_id = o.invoice_id
WHERE o.payment_method = 'unpaid_table'
  AND oi.note = 'Auto-Gratuity';

SELECT COUNT(*) AS held_fee_orders
FROM held_orders
WHERE cart_data LIKE '%Auto-Gratuity%';
```

Stop if either count is nonzero. Finalize, void, or deliberately remove those operational orders before retrying; do not bypass the applicator's cutoff.

## Apply

From the application root, set the real target name in both variables and run the guarded applicator:

```powershell
$env:DB_NAME='<target_database>'
$env:SERVICE_CHARGE_MIGRATION_CONFIRM='<target_database>'
node backend/migrations/apply-service-charge-snapshots.js
```

Deploy the backend first, then the frontend. Keep service-charge application disabled until verification completes.

## Verify

Verify the snapshot table, foreign-key columns, indexes, and initial absence of draft rows:

```sql
SHOW CREATE TABLE service_charge_snapshots;
SHOW COLUMNS FROM orders LIKE 'service_charge_snapshot_id';
SHOW COLUMNS FROM held_orders LIKE 'service_charge_snapshot_id';
SHOW INDEX FROM orders WHERE Key_name = 'idx_orders_service_charge_snapshot';
SHOW INDEX FROM held_orders WHERE Key_name = 'idx_held_orders_service_charge_snapshot';
SELECT COUNT(*) AS draft_snapshots FROM service_charge_snapshots WHERE state = 'draft';
```

The columns and indexes must exist and `draft_snapshots` must be zero before traffic resumes. Create one controlled test order and verify its snapshot rates, canonical fee and fee tax, hold/restore behavior, and final checkout transition. Re-enable service-charge application only after all checks pass.

## Test-database rehearsal

Use a freshly seeded test database and explicit test credentials:

```powershell
$env:NODE_ENV='test'
$env:DB_NAME='posapp_test'
$env:SERVICE_CHARGE_MIGRATION_CONFIRM='posapp_test'
node backend/migrations/apply-service-charge-snapshots.js
```

Reset the fixture database, insert one held order whose `cart_data` contains `Auto-Gratuity`, and rerun the command. It must exit nonzero with the operational-cutoff error before applying DDL. Reset the test database afterward.

## Rollback and recovery

Disable new service-charge application first. If no snapshot has ever been created, restore the pre-migration backup under normal maintenance controls. Once any snapshot exists, do not drop the table, columns, indexes, or foreign keys: doing so destroys the rate authority for bound orders. Keep a compatible backend deployed until every bound held/open order has finalized or been deliberately abandoned. Roll back application code only to a version that can preserve and consume the snapshot bindings.
