# Operational reset correction

Scope: current source on `codex/operational-reset-corrections`; no customer database reset, upload, or deployment. Test database: local `posapp_test`, distinct from `posapp`.

## Reproduced and corrected

- `backend/services/operationalDataReset.js`: clearing `expenses.shift_id` violates `chk_expenses_drawer_shift` for drawer expenses. Outside expenses previously survived reset. Delete operational expenses, preserving expense categories; disclose this in Settings in English and Arabic.
- Clearing `subscription_collections.reverses_collection_id` violates `chk_subscription_collections_reversal_shape`. Delete reversals before collections.
- Clearing `platform_remittances.reverses_remittance_id` violates `chk_platform_remittances_reversal_shape`. Delete allocation/adjustment children, then reversals, then settlements.
- `backend/routes/admin/maintenance.js`: deleting subscription plans can change POS catalog visibility (`backend/routes/pos/catalog.js`). Invalidate catalog cache and emit the existing `inventory_changed` signal after commit, alongside the existing dashboard invalidation.

The first focused run produced three real MariaDB constraint errors (errno 4025) and one surviving-expense assertion failure. No foreign-key or CHECK enforcement is disabled by the fix. No schema change is needed.

## Current schema and migration disposition

Reviewed `deployment/database/baseline.sql`, the automatic migration manifest and its table additions, the recent migrations through `2026-09-03-y-order-type-setting-v1`, and reset callers.

| Data | Reset disposition |
| --- | --- |
| Orders, items, bundle modifications, refunds and refund items | Already deleted in dependency order |
| Held orders, QR drafts, Y recovery payloads | Already deleted; current Y archive/restore uses `master_held`, not the obsolete `y_held_report_archives` test cleanup name |
| Service-charge snapshots and their parent links | Already cleared; remaining self-link nullable update has no conflicting shape CHECK |
| Shifts and expenses | Shifts already deleted; expenses now deleted too |
| Subscription instances, plans, allocations, extensions, redemptions and collections | Already covered; collection reversal ordering corrected |
| Platform remittances, lines and adjustments | Already covered; reversal ordering corrected |
| JoFotara documents | Already deleted; latest recovery index adds no separate data store |
| X/Z documents including browser print status | Already deleted from `audit_report_documents`; browser-preview migration adds no new table |
| Print queue and invoice/daily sequences | Already deleted. Do not reset AUTO_INCREMENT: queue IDs must not collide with existing agent journals |
| Spooler agents/stations, printers, published templates | Preserve installation identity and configuration; do not recreate the customer's agent-binding problem |
| Users, permissions, auth sessions, WebAuthn credentials/recovery/ceremonies | Preserve security/access state; these are not sales records |
| Settings, including `y_order_type_id` | Preserve restaurant configuration; latest Y migration seeds a setting, not a new operational table |
| Product price locks, fractional stock, catalog price configuration/history | Preserve product/catalog state; reset is not inventory reconstruction |
| Customers, expense categories, order types, sections/table definitions | Preserve setup; table occupancy is cleared |
| Schema migration ledger | Preserve; never cause already-applied migrations to rerun as a fresh installation |
| Audit events | Preserve existing audit trail and append the reset event; existing xyz suppression still applies |

## Verification boundary

`backend/tests/integration/maintenanceReset.test.js` covers authorization, each reproduced data-dependent failure, outside/zero expenses, recovery snapshots, queue-ID monotonicity, retained setup and identity, cache invalidation, and a late injected audit failure proving rollback without a success notification. `src/admin/__tests__/settingsOperationalReset.spec.js` retains its existing password/UI wiring check.

The operation still requires idle terminals and reloading them afterward, as the UI already states. It is not a remote cancellation of work already accepted by a physical spooler, nor a coordinator for concurrent checkout/JoFotara activity. No production reset or physical-printer behavior was tested. The deployment ZIP created earlier predates this fix and must not be described as containing it.
