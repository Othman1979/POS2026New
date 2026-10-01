# Deployment Runbook - Modifier Stable IDs

## Overview
This runbook guides the safe deployment of the stable modifier IDs implementation for the POS system.

## Pre-deployment Requirements
- No new modifier renames or updates should be made in the Admin panel while this migration is pending.
- Ensure no active cashier shifts are in a state of checkout transactions during the brief server restart window.
- Take a restorable database backup that includes at least `products`, `orders`, `order_items`, `held_orders`, and schema. The product backup is required because the backfill rewrites `products.modifiers` into the canonical id-bearing shape.

## Deploy Order
1. Run the migration script on the production database while the old application code is still serving traffic:
   ```bash
   MODIFIER_IDS_MIGRATION_CONFIRM=apply-modifier-ids node backend/migrations/apply-modifier-stable-ids.js
   ```
   **Important:** If the script exits nonzero or reports skipped products, stop. Do not deploy or restart the new application code. Some valid products may already have been updated; repair the listed invalid product definitions, then rerun the migration until it exits successfully with `0 skipped`.
2. Deploy the backend code and built frontend files (`dist/`) together. Do not run a mixed old-frontend/new-backend or new-frontend/old-backend window longer than the deployment copy itself; stale frontend payloads are tolerated server-side, but the stable-id UI should ship with the API that persists it.
3. Restart the POS Express server only after the migration has succeeded and the backend/frontend files are in place.

## Verification Checklist
- Run migrations and confirm the schema contains `selected_modifiers` on `order_items` table.
- Verify checkout succeeds for products with and without modifiers.
- Verify claiming held orders with modifiers preserves modifiers and applies correct surcharges.
- Verify table saves, table settles, splits, and merges work correctly for items with selected modifiers.
- Verify no modifier renames are performed until pre-migration open tables, held orders, and split checks have either been finalized or re-saved after the deployment.

## Accepted Limitations
- Merge quantity-collapse keeps the target row's existing `selected_modifiers` snapshot. If the target was a pre-deployment NULL row and the source carried a snapshot, the collapsed row can remain NULL. Money and receipt text are unchanged.
- `selectedModifiers` sanitization caps persisted selections at 50 entries. This is intentionally conservative; raise it only if a real product needs more than 50 selected options on one line.
- The raw SQL migration uses MariaDB `ADD COLUMN IF NOT EXISTS`. This venue runs MariaDB, and the JS migration guard checks `information_schema` before executing the DDL.

## Rollback Plan
1. Stop the POS server.
2. Restore the previous stable backend and frontend code versions.
3. If the product modifier backfill must be undone, restore the `products` table from the pre-deployment backup. Keep the nullable `order_items.selected_modifiers` column in place; old code ignores it and dropping it can destroy useful snapshots from already-settled orders.
4. Restart the POS server.

## Modifier Surcharge Untaxed Rollout Extension

### Deploy Order & Migration
1. Run the surcharge column migration script AFTER the stable-ids migration and BEFORE deploying this code:
   ```bash
   MODIFIER_SURCHARGE_MIGRATION_CONFIRM=apply-modifier-surcharge node backend/migrations/apply-modifier-surcharge-untaxed.js
   ```
   **Important:** Running this DDL first is mandatory because the new backend code naming `modifier_surcharge` in INSERT statements will break checkouts immediately if the DB column is missing.
2. Before deployment, have every cashier finish, hold, or explicitly discard live register carts containing modifiers. Browser carts are local-only and cannot be centrally migrated.
3. Deploy backend (BE) and frontend (FE) files together in the same deployment window.
4. If a pre-deploy local modifier cart was missed, the updated POS clears that cart and asks the cashier to re-add its items. It never silently re-prices browser data or reaches checkout with stale tax.

### Post-deployment Expected Behavior
- **Exclusive-mode Tax Reduction:** Expect total tax and Z-report tax figures to drop from deploy time for new orders containing modifiers (since modifier surcharges are now untaxed flat add-ons).
- **No Backfill:** Historical rows are never backfilled; their old tax calculations remain stored in the DB.
- **Open Tables & Split Checks:** Active floor table orders and unpaid splits saved pre-deploy will continue to settle at their OLD (surcharge-taxed) totals. This is correct and intentional behavior to ensure previously calculated totals match checkout.
- **Register Holds:** Unpaid holds parked pre-deploy will trigger a "totals changed" warning when claimed and will settle at the NEW (surcharge-reduced) total. This occurs because register holds always re-fold and re-calculate prices at checkout.
- **No Spooler Deploy:** The print spooler process does not require any code updates or deployment for this change.
