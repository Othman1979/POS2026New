# Additive Schema Auto-Repair Implementation Plan

> **For agentic workers:** The main agent owns design, tests, review, corrections, Git, and deployment. The configured `luna_max` agent is the only writer for migration SQL, manifest, and cumulative fallback changes.

**Goal:** Make copied/service deployments and installer upgrades repair known missing required schema automatically before the POS listens, without deleting data or granting DDL privileges to the runtime application account.

**Architecture:** Keep `runPendingMigrations()` as the single migration seam. Append one versioned repeatable reconciliation migration that reasserts every safely additive structure required by `validateRequiredSchema()`, then let validation remain the final fail-closed authority. A missing reconciliation version runs during ordinary startup; installer repair and `service/update-pos.bat` may re-run it explicitly with a DDL-capable maintenance account. The restricted installer POS account only skips an already-ledgered reconciliation.

**Tech Stack:** Node.js CommonJS, mysql2/promise, MariaDB 10.4+/11.4 additive DDL, PowerShell/Inno Setup, Vitest.

## Global Constraints

- Migration name: `2026-08-01-additive-schema-reconciliation-v1`.
- Ledger checksum: `5c1f6f37dca58f4f292aa699394e4ad7f420ba57c7f6a1992bd4400429a27679`.
- Exact predecessor: `2026-07-31-tax-exempt-checks-v1` / `6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3`.
- Production repair SQL may create tables and add missing columns, indexes, constraints, required settings, permissions, or enum values. It may not execute `DROP`, `DELETE FROM`, `TRUNCATE`, `RENAME`, or remove/narrow existing values.
- Missing objects are repaired only from checked-in, reviewed definitions. Never generate DDL dynamically from `information_schema` or guess a column definition.
- Existing objects with conflicting definitions and invalid rows that prevent a constraint remain hard failures with actionable errors.
- Missing whole tables receive their authoritative inline foreign keys. Missing foreign keys on an already-partial table remain hard failures: MariaDB 10.4's `FOREIGN KEY IF NOT EXISTS` guards an index name rather than constraint identity, so general repeatable FK ALTERs can recreate a valid constraint and fail errno 121. The only exception is the two circular `print_templates` FKs, whose dedicated same-name indexes were verified on MariaDB and are required after the related tables exist. Do not add dynamic SQL or routines to hide other ambiguity.
- `validateRequiredSchema()` still runs after migrations and before `server.listen()`.
- Keep `posapp_runtime` restricted. Installer migrations use `posapp_maintenance` only for the one-time provisioning step.
- Never re-run repeatable DDL through the restricted POS runtime account. `includeRepeatable` is opt-in and belongs only to the maintenance CLI.
- Do not add a migration framework, controller, repository, repair dashboard, background retry loop, or automatic destructive cleanup.

---

### Task 1: Package the migration runtime in both server installers

**Files:**

- Modify: `backend/tests/unit/installerPackageContract.test.js`
- Modify: `deployment/tools/validate-payload.js`
- Modify: `scripts/build-installers.ps1`

**Interface:** The staged server must contain `backend/migrations/runPendingMigrations.js`, `auto-manifest.json`, and every manifest-listed `.auto.sql`, while historical/manual migration files remain excluded.

- [ ] Add a failing installer contract test proving the current exclusion drops the required migration runtime.
- [ ] Replace the blanket omission with an explicit runtime allowlist copied into staged `backend/migrations`.
- [ ] Make payload validation require the runner, manifest, and manifest-listed SQL files.
- [ ] Run the focused installer package tests and a `-StageOnly` build when vendor inputs are available.

### Task 2: Run installer migrations with protected maintenance credentials

**Files:**

- Create: `deployment/tools/run-pending-migrations.js`
- Modify: `backend/tests/unit/installerCli.test.js`
- Modify: `deployment/windows/Install-PosServer.ps1`
- Modify: `scripts/build-installers.ps1`
- Modify: `deployment/tools/validate-payload.js`

**Interface:** `node deployment/tools/run-pending-migrations.js --env <absolute backup.env>` loads only that protected file, creates a short-lived pool, runs the shared manifest runner with repeatable reconciliation enabled, prints migration names without secrets, closes the pool, and exits nonzero on failure.

- [ ] Write failing CLI tests for an absolute env path, missing credentials, secret-free output/errors, pool closure, and delegation to `runPendingMigrations()`.
- [ ] Implement the smallest CLI around the existing runner.
- [ ] During installer provisioning/repair, invoke it after MariaDB/bootstrap is available and before `POSApp` starts, using `backup.env`. Manual `service/update-pos.bat` invokes the same CLI with the copied deployment's DDL-capable `.env` before starting the service.
- [ ] Package and validate the CLI. Do not place maintenance credentials in `pos.env` or NSSM arguments.

### Task 3: Add the approved reconciliation migration through Luna

**Files:**

- Create: `backend/migrations/2026-08-01-additive-schema-reconciliation.sql`
- Create: `backend/migrations/2026-08-01-additive-schema-reconciliation.auto.sql`
- Modify: `backend/migrations/auto-manifest.json`
- Modify: `deployment/database/hostinger-manual-migrations.sql`
- Modify: `backend/tests/unit/automaticMigrations.test.js`
- Modify: `backend/tests/integration/automaticMigrations.test.js`

**Interface:** One ordered migration repairs safely additive drift behind `runPendingMigrations(pool, { includeRepeatable })` and records its ledger row last. Missing entries run normally; already-ledgered repeatable entries run only when the privileged CLI opts in.

- [ ] Main agent writes failing tests first: manifest order/predecessor/hash, normal/auto statement parity, fallback block parity, forbidden destructive statements, and isolated MariaDB drift repair.
- [ ] The integration test starts from a fully valid scratch schema, removes representative required objects only in that scratch database (including `chk_product_price_overrides_nonnegative`, a required column/index/foreign key, a required table, and a setting), keeps the July 31 ledger floor, runs the real manifest, then requires `validateRequiredSchema()` to pass.
- [ ] Main agent gives Luna the exact constraints and file ownership. Luna writes only the two SQL files, manifest entry, and exact fallback block; Luna does not write tests, application code, commits, or deployment actions.
- [ ] Reconciliation covers all current `REQUIRED_COUNTS` entries whose expected count is positive and can be safely restored additively. Existing-table FK gaps and entries requiring removal (`expected = 0`) remain validator-owned hard failures.
- [ ] The final statement records the exact reconciliation ledger name/checksum. The fallback copies the approved auto SQL verbatim between the project-rule markers.
- [ ] Main agent independently reviews every statement against baseline/migration authority and runs RED → GREEN focused tests.

### Task 4: Make manual service updates truthful and verify end to end

**Files:**

- Modify: `service/README.md`
- Modify: `service/update-pos.bat`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

- [ ] Replace the obsolete instruction to apply every SQL file manually: copied deployments run approved migrations automatically at startup, while the cumulative Hostinger file remains the emergency fallback.
- [ ] Document that the configured DB account must have additive DDL privileges or an installer maintenance step must run first.
- [ ] Update the architecture flow for packaged runtime migrations and maintenance-account provisioning.
- [ ] Run focused migration, schema, installer, and service-contract tests; run `npm run architecture:check`, `npm run build`, and `git diff --check`.
- [ ] Prove three states: current DB is a no-op, the drifted scratch DB repairs and validates, and an irreconcilable conflict refuses to start without deleting anything.

## Acceptance Checklist

- [ ] Copying the full project and starting through `service/` applies approved missing migrations before listening.
- [ ] Installer payload contains the runner, manifest, and every required auto SQL file.
- [ ] Installer provisioning uses protected maintenance credentials; normal POS runtime remains restricted.
- [ ] A database with the July 31 ledger but the missing price-override CHECK is repaired automatically.
- [ ] Known missing additive columns/tables/indexes/constraints/settings are repaired from reviewed definitions.
- [ ] No production repair statement deletes data or removes schema.
- [ ] Conflicting schema or invalid data fails closed with evidence.
- [ ] Manual Hostinger fallback contains the exact same approved SQL block.
