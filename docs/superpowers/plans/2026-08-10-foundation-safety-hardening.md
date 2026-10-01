# Foundation Safety Hardening Implementation Plan

> Execution owner: Luna (`luna_max`) implements each task in order on `codex/dependency-security-hardening`. The primary agent reviews and verifies every task before authorizing the next. No merge, push, installer rebuild, or production database application is in scope.

## Goal

Close four verified foundation gaps without restructuring large files or creating new frameworks:

1. make automatic migrations fail closed on a broken ledger chain and avoid unnecessary repeatable repairs;
2. preserve historical order references at both route and database levels;
3. remove the 15 unused legacy permission columns after canonical permission ownership is proven;
4. make `refunds`/`refund_items` the single authority for `orders.refund_status`, while keeping the latter as a synchronized query cache.

## Interrupted execution state — preserve and verify

Task 1 was interrupted on 2026-08-10 after Luna implemented it and reported green verification, but before any commit was created. The branch remains `codex/dependency-security-hardening` at committed HEAD `d1267b43`; the Task 1 work is an uncommitted working-tree diff.

Current intended Task 1 changes:

- `backend/migrations/runPendingMigrations.js`
- `deployment/tools/run-pending-migrations.js`
- `backend/tests/unit/automaticMigrations.test.js`
- `backend/tests/unit/pendingMigrationCli.test.js`
- `backend/tests/integration/automaticMigrations.test.js`
- `docs/architecture.json`
- generated `docs/architecture.html`
- this untracked plan file

Reported evidence from the interrupted executor (not a substitute for the next executor's own verification):

- RED: five focused failures reproduced the missing/wrong-predecessor skip and unconditional repeatable-CLI behavior.
- GREEN: focused runner/CLI tests `40/40`; automatic migration integration `5/5`; installer/update contracts `51/51`; schema-authority tests `54/54`; architecture check passed.

The next executor must begin by inspecting this diff against Task 1. Preserve correct work, fix any finding, rerun the stated tests, include this plan, and create the Task 1 commit. Do not reset, discard, or duplicate the existing implementation merely because it is uncommitted.

## Evidence and constraints

- MariaDB DDL auto-commits. Multi-statement schema migrations cannot be honestly rolled back as a unit. Safety therefore comes from exact predecessor checks, one retry-safe operation per statement, a ledger write last, and scratch-database rerun tests.
- `runPendingMigrations()` currently skips a ledgered migration before validating that migration's predecessor. The maintenance CLI also forces all repeatable repairs on every installer/update run, while server startup already reruns them only after schema validation reports drift.
- The current database has zero orphaned `orders.waiter_id`, `order_type_id`, `customer_id`, and `table_id` references, but the database does not enforce those relationships. The order-type route only protects platform history, and table deletion only protects active table state.
- All 15 legacy `users.can_*`/`bypass_*`/`waiter_split_bill` columns still exist. Runtime authorization is already owned by `permissions`, `user_permissions`, and `PermissionService`; the legacy fields have no runtime database reads. Keep `allowed_sections`, `xyz`, identity, role, session, and PIN fields.
- The current database has no refund-status mismatch, but both paid refunds and open-table voids independently write `orders.refund_status`, and early guards trust that cache. Canonical refund evidence already lives in `refunds` and `refund_items`.
- Keep the existing 48-table model. Do not split large files, redesign routes, introduce repositories/controllers, add a migration-failure table, or add a background reconciliation system.

## Task 1 — Migration ledger and repair safety

**Files**

- Modify `backend/migrations/runPendingMigrations.js`.
- Modify `deployment/tools/run-pending-migrations.js`.
- Modify `backend/tests/unit/automaticMigrations.test.js`.
- Modify `backend/tests/unit/pendingMigrationCli.test.js`.
- Modify `docs/architecture.json`, then regenerate `docs/architecture.html` with `npm run architecture` if the traced deployment flow changes.

**TDD red cases**

1. A migration whose own ledger row is valid must still fail before executing SQL when its declared predecessor row is missing.
2. The same case must fail when the predecessor checksum is wrong.
3. The maintenance CLI must first run ordinary pending migrations and validate the schema.
4. With a valid schema, it must not run repeatable repairs.
5. On `SCHEMA_MIGRATION_REQUIRED`, it must run repeatables exactly once and validate again.
6. Any other validation error must propagate without a repair attempt.

**Implementation**

- Move exact predecessor validation before the existing "already applied" skip path for every manifest entry.
- Preserve checksum-conflict behavior, advisory locking, statement-number diagnostics, hash verification, and ledger-write verification.
- Make the maintenance CLI mirror server startup: ordinary migration pass, `validateRequiredSchema`, conditional repeatable pass only for managed schema drift, then revalidation.
- Reuse `validateRequiredSchema`; do not create another migration orchestrator or a new flag/configuration surface.
- Do not claim transactional DDL or add rollback code that MariaDB cannot honor.

**Verification**

- Focused unit tests for the runner and CLI.
- Existing automatic migration integration tests.
- Installer/update contract tests that exercise the maintenance CLI invocation.
- `npm run architecture:check` after regenerating the map.

**Commit**: `fix: harden migration ledger and repair flow`

## Task 2 — Historical order reference authority

**Migration name**: `2026-08-10-order-reference-authority-v1`

**Database contract**

- Add these nullable, history-preserving relationships with `ON DELETE RESTRICT`:
  - `orders.waiter_id -> users.id`
  - `orders.order_type_id -> order_types.id`
  - `orders.customer_id -> customers.id`
  - `orders.table_id -> restaurant_tables.id`
- Before adding each constraint, set only already-invalid dangling values to `NULL`. Do not delete orders or referenced business rows.
- Use one retry-safe `ALTER` per constraint and record the migration ledger row last.
- Add a preflight report for orphan counts and a verify script for exact constraint/delete-rule shapes.

**Application policy**

- Keep user deletion as the existing soft deactivation.
- Keep customer deletion blocked when any order references the customer.
- Block order-type deletion when **any** order or platform remittance references it; unused order types remain deletable.
- Block table deletion when any historical order references it, in addition to existing active/joined-table checks; unused available tables remain deletable.
- Return clear `409` errors and stable public codes for the two new route-level history conflicts.

**Files**

- Add normal, preflight, verify, and approved `.auto.sql` migration files.
- Update `backend/migrations/auto-manifest.json` and append the exact `.auto.sql` block to `deployment/database/hostinger-manual-migrations.sql`.
- Update `deployment/database/baseline.sql`, `backend/tests/fixtures/seed.js`, `deployment/tools/bootstrap-database.js`, and `backend/services/schemaValidation.js`.
- Modify `backend/routes/admin/printers.js` and `backend/routes/pos/tables.js`.
- Extend the existing automatic migration, schema-authority, installer-baseline, order-type, and table route tests. Do not create a new test harness.
- Update the architecture map only if the ownership/invariant representation needs it.

**TDD and verification**

- Route tests first: referenced order type/table returns `409`; unused entity still deletes.
- Scratch DB starts at the exact predecessor ledger, deliberately includes orphan values, runs the migration, verifies only those values become `NULL`, verifies all four FKs and `RESTRICT`, then reruns as a no-op.
- Verify manifest hash/order, fallback parity, baseline/fixture/bootstrap/schema-validation authority, and current-database no-op behavior.

**Commit**: `fix: preserve historical order references`

## Task 3 — Retire legacy permission columns

**Migration name**: `2026-08-10-legacy-permission-column-retirement-v1`

**Scope**

- Drop only these proven-unused columns from `users`:
  - `can_view_orders`, `canholdorders`, `can_update_table`, `can_apply_discount`, `can_void_items`;
  - `can_open_register`, `can_checkout_tables`, `bypass_existing_tables`, `bypass_printed_tables`;
  - `can_view_order_history`, `can_transfer_table`, `can_join_tables`, `can_split_bills`, `waiter_split_bill`, `can_print_check`.
- Preserve `allowed_sections`, `xyz`, identity, role, active/session, and PIN columns.
- Do not change permission catalog rows or user grants. Canonical authorization remains `PermissionService` over `permissions` and `user_permissions`.
- Keep historical pre-floor migration files unchanged as evidence; they are not current execution sources.

**Files**

- Add normal, preflight, verify, and approved `.auto.sql` migration files.
- Update the ordered auto manifest and exact fallback block.
- Remove the 15 columns from baseline and fixture schemas and from bootstrap/fixture inserts.
- Update schema validation to require the canonical permission tables and require the retired columns to be absent.
- Extend permission service/integration, automatic migration, schema-authority, and installer-baseline tests.
- Update the architecture permission invariant if it still describes dual ownership.

**TDD and verification**

- Before implementation, pin cashier grant behavior, admin/programmer bypass, grant replacement, and denial without a grant.
- Scratch DB at the exact predecessor: seed representative users and canonical grants, migrate, prove users/grants unchanged, prove only the 15 columns disappeared, and rerun safely.
- Run the complete permission-focused suites and installer/bootstrap contracts.

**Commit**: `refactor: retire legacy permission columns`

## Task 4 — Refund ledger authority and cache reconciliation

**Migration name**: `2026-08-10-refund-status-reconciliation-v1`

**Ownership**

- `refunds` and `refund_items` are canonical financial/refund evidence.
- `orders.refund_status` remains a denormalized `none|partial|full` cache for filters, receipts, and reports.
- Put derivation/synchronization in the existing `RefundService` owner; do not create a new repository/controller or generic reconciliation framework.

**Runtime behavior**

- Add a small exported helper in `backend/services/RefundService.js` that derives status from the order plus canonical refund/refund-item rows and updates the cache only when different.
- Derivation rules:
  - no refund ledger rows -> `none`;
  - an actually voided order with void evidence -> `full`;
  - an open-table order with partial void evidence -> `partial`;
  - a paid order is `full` only when canonical refunded quantities cover every refundable parent item; otherwise `partial`.
- In both `refundPaidOrder` and `voidOpenTableOrder`, synchronize under the existing transaction/row lock before trusting the "already fully refunded" guard, and synchronize again after inserting ledger rows and applying order-item changes.
- Remove the two independent status calculations/updates. Preserve refund amounts, stock restoration, audit writes, JoFotara return handling, kitchen void tickets, subscription-managed partial refunds, and transaction order.

**One-time reconciliation**

- Add a one-shot, Hostinger-safe migration that recalculates existing `orders.refund_status` from canonical ledger evidence without changing refund rows or financial amounts.
- The SQL derivation must match the runtime helper and be tested with none, paid partial, paid full, open-table partial void, full void, and deliberately stale cache fixtures.
- Record the ledger row last; add normal/verify/approved auto files, manifest/fallback parity, fixture/bootstrap ledger authority, and latest schema requirement.

**Tests**

- Add RED tests showing a stale `full` cache with no canonical refund no longer blocks a valid refund, and a stale `none` cache is corrected from canonical full/partial evidence.
- Cover paid full/partial, managed subscription partial, open-table partial/full void, and rerun/no-op migration behavior using existing refund/table suites.
- Confirm admin refund filters and receipt status consumers continue receiving the same cached enum.

**Commit**: `fix: reconcile refund status from ledger`

## Final owner review

After all four commits, the primary agent will:

1. inspect each commit against its task and reject scope drift;
2. independently verify normal/auto/fallback SQL parity, manifest predecessor/checksum/hash order, ledger-last behavior, scratch upgrade/rerun behavior, and current-database no-op;
3. run the focused migration, installer/update, permission, order-type/table, refund/subscription, schema-authority, and architecture tests;
4. run `node scripts/validate-schema-drift.js`, `npm run architecture:check`, `npm run build`, and `git diff --check`;
5. report exact commits, tests, remaining risks, and repository state without merging or pushing.
