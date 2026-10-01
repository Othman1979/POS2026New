# Database Authority Foreign-Key Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `test-driven-development` and execute this single task without expanding its scope.

**Goal:** Restore the nine canonical foreign keys that exist in the fresh baseline but are missing from upgraded/imported databases, and make server startup reject future loss or rule drift for those exact relationships.

**Architecture:** Add one repeatable, additive migration containing only the nine baseline foreign keys and its ledger write. Reuse the existing automatic manifest, Hostinger fallback, bootstrap ledger, fixture ledger, and `schemaValidation.js`; do not add a migration framework, generic schema model, or new service. The migration remains retry-safe after partial DDL application because every constraint uses `IF NOT EXISTS`, no rows are changed, and the ledger is written last.

**Tech Stack:** MariaDB 10.4, MySQL2, Node.js, Vitest.

## Global Constraints

- Scope is only the nine foreign keys already defined by `deployment/database/baseline.sql`.
- Preserve the baseline constraint names, columns, referenced columns, and delete rules exactly.
- Do not add broader `orders` history foreign keys; their deletion policy needs a separate decision.
- Do not modify large frontend files, `src/i18n.js`, dependency versions, kitchen routing, shift workflows, or the generic migration runner.
- Existing rows must never be updated, deleted, backfilled, or normalized by this migration.
- Automatic SQL, normal SQL, and the Hostinger fallback block must remain text-identical after newline normalization.
- The migration must be repeatable and additive so a ledger-complete database with later constraint drift repairs itself.
- Follow strict RED -> GREEN TDD and commit only after focused tests and a production build pass.

---

### Task 1: Restore and enforce the baseline foreign-key authority

**Files:**
- Create: `backend/migrations/2026-08-09-baseline-foreign-key-authority.sql`
- Create: `backend/migrations/2026-08-09-baseline-foreign-key-authority.auto.sql`
- Modify: `backend/migrations/auto-manifest.json`
- Modify: `deployment/database/hostinger-manual-migrations.sql`
- Modify: `backend/services/schemaValidation.js`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `deployment/tools/bootstrap-database.js`
- Modify: `backend/tests/unit/automaticMigrations.test.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`
- Modify: `backend/tests/integration/automaticMigrations.test.js`
- Modify: `backend/tests/integration/installerBaseline.test.js`

**Interfaces:**
- Migration name: `2026-08-09-baseline-foreign-key-authority-v1`
- Ledger checksum: `8f6e50495f7f7781507e692ac959beedaf622b5978bc6e9e2ac8d711282cd937`
- Predecessor: `2026-08-09-imported-schema-drift-repair-v1`
- Predecessor checksum: `0464357684022fb8dd6e8187adef527293296127b4233c0d4871d2f030713f73`
- Validator summary key: `baseline_authority_foreign_keys`
- Expected validator count: `9`

- [ ] **Step 1: Write the failing migration-chain and parity tests**

Extend `backend/tests/unit/automaticMigrations.test.js` so the ordered manifest ends with the new migration, requires the imported-schema repair, is `repeatable: true`, and ships normal/automatic/fallback SQL with exact text parity. Assert the SQL contains exactly these constraint definitions:

```text
fk_uperm_user: user_permissions(user_id) -> users(id), CASCADE
fk_uperm_perm: user_permissions(perm_key) -> permissions(perm_key), CASCADE
fk_parent_table: restaurant_tables(parent_table_id) -> restaurant_tables(id), SET NULL
restaurant_tables_ibfk_1: restaurant_tables(section_id) -> sections(id), RESTRICT
shifts_ibfk_1: shifts(user_id) -> users(id), RESTRICT
order_items_ibfk_1: order_items(invoice_id) -> orders(invoice_id), CASCADE
order_items_ibfk_2: order_items(product_id) -> products(id), RESTRICT
fk_refund_items_refund: refund_items(refund_id) -> refunds(id), CASCADE
qr_table_drafts_ibfk_1: qr_table_drafts(table_id) -> restaurant_tables(id), CASCADE
```

Also assert the migration contains no standalone business-row `DELETE` or `UPDATE`, and no `DROP`, `TRUNCATE`, `RENAME`, stored procedure, trigger, or delimiter statement. The required `ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name)` ledger clause is allowed.

- [ ] **Step 2: Write the failing schema-authority tests**

Update `backend/tests/unit/schemaAuthority.test.js` so the valid summary includes `baseline_authority_foreign_keys: 9`. Add a focused failure case with the value set to `8` and assert startup reports `baseline_authority_foreign_keys`. Change the required migration name/checksum in the test to the new migration.

Update `backend/tests/integration/installerBaseline.test.js` to require the new ledger row in the bootstrap output while retaining the predecessor row.

- [ ] **Step 3: Write the failing live-MariaDB repair test**

In `backend/tests/integration/automaticMigrations.test.js`, create the isolated scratch database from the canonical baseline, drop the nine named foreign keys with `FOREIGN_KEY_CHECKS=0`, restore checks, and insert every manifest ledger row except the new migration. Run `runPendingMigrations()` and assert:

1. The new migration is the only applied migration.
2. All nine constraints exist with their exact child/parent columns and delete rules.
3. `validateRequiredSchema()` succeeds.
4. A second run skips the nonrepeatable chain and does not duplicate constraints.
5. Running with `includeRepeatable: true` remains idempotent and leaves exactly nine matching relationships.

The scratch database name guard and final cleanup must remain identical to the existing automatic-migration integration tests.

- [ ] **Step 4: Run the new tests and capture RED**

Run:

```powershell
npx vitest run backend/tests/unit/automaticMigrations.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/integration/automaticMigrations.test.js backend/tests/integration/installerBaseline.test.js --reporter=dot
```

Expected: failures specifically identify the missing manifest entry, missing `baseline_authority_foreign_keys` validation, missing migration files/fallback block, or missing repair behavior. Test setup/import errors do not count as RED.

- [ ] **Step 5: Add the minimal repeatable migration**

Create both SQL files with identical content after newline normalization:

```sql
-- Hostinger-safe automatic form of 2026-08-09-baseline-foreign-key-authority-v1.
-- Existing rows are preserved. Any orphaned reference fails the affected FK add;
-- every earlier add is idempotent, so the next run safely resumes after correction.

SET NAMES utf8mb4;

ALTER TABLE user_permissions
  ADD CONSTRAINT fk_uperm_user FOREIGN KEY IF NOT EXISTS (user_id)
    REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE user_permissions
  ADD CONSTRAINT fk_uperm_perm FOREIGN KEY IF NOT EXISTS (perm_key)
    REFERENCES permissions(perm_key) ON DELETE CASCADE;

ALTER TABLE restaurant_tables
  ADD CONSTRAINT fk_parent_table FOREIGN KEY IF NOT EXISTS (parent_table_id)
    REFERENCES restaurant_tables(id) ON DELETE SET NULL;

ALTER TABLE restaurant_tables
  ADD CONSTRAINT restaurant_tables_ibfk_1 FOREIGN KEY IF NOT EXISTS (section_id)
    REFERENCES sections(id) ON DELETE RESTRICT;

ALTER TABLE shifts
  ADD CONSTRAINT shifts_ibfk_1 FOREIGN KEY IF NOT EXISTS (user_id)
    REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_ibfk_1 FOREIGN KEY IF NOT EXISTS (invoice_id)
    REFERENCES orders(invoice_id) ON DELETE CASCADE;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_ibfk_2 FOREIGN KEY IF NOT EXISTS (product_id)
    REFERENCES products(id) ON DELETE RESTRICT;

ALTER TABLE refund_items
  ADD CONSTRAINT fk_refund_items_refund FOREIGN KEY IF NOT EXISTS (refund_id)
    REFERENCES refunds(id) ON DELETE CASCADE;

ALTER TABLE qr_table_drafts
  ADD CONSTRAINT qr_table_drafts_ibfk_1 FOREIGN KEY IF NOT EXISTS (table_id)
    REFERENCES restaurant_tables(id) ON DELETE CASCADE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-09-baseline-foreign-key-authority-v1',
  '8f6e50495f7f7781507e692ac959beedaf622b5978bc6e9e2ac8d711282cd937'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
```

Append the automatic file to `auto-manifest.json`, compute its normalized SHA-256 using the same BOM/CRLF normalization as `runPendingMigrations.js`, and add the exact automatic SQL between matching BEGIN/END markers in `hostinger-manual-migrations.sql`.

- [ ] **Step 6: Make startup validate the exact nine relationships**

In `schemaValidation.js`:

1. Change `MIGRATION_NAME` and `MIGRATION_CHECKSUM` to the new values.
2. Add `baseline_authority_foreign_keys: 9` to `REQUIRED_COUNTS`.
3. Add one `information_schema.KEY_COLUMN_USAGE` plus `REFERENTIAL_CONSTRAINTS` subquery that counts only the nine exact name/table/column/reference/delete-rule combinations listed above.

Do not count foreign keys only by name. A wrong parent column or wrong delete rule must produce a count below nine.

- [ ] **Step 7: Wire fresh-install and test ledgers**

Append the new name/checksum row after the imported-schema repair in:

- `backend/tests/fixtures/seed.js`
- `deployment/tools/bootstrap-database.js`

Do not alter `deployment/database/baseline.sql`; it already contains the canonical nine relationships and changing it would unnecessarily change the installer baseline hash.

- [ ] **Step 8: Run GREEN verification**

Run:

```powershell
npx vitest run backend/tests/unit/automaticMigrations.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/integration/automaticMigrations.test.js backend/tests/integration/installerBaseline.test.js --reporter=dot
node scripts/validate-schema-drift.js
npm run build
git diff --check
```

Expected: every command exits `0`; the focused test command reports zero failed tests; the schema drift script reports zero drift; the production build succeeds; diff check is clean.

- [ ] **Step 9: Self-review and commit**

Review the complete diff against the nine-entry list. Confirm no application route, frontend, generic runner, package file, baseline SQL, or unrelated migration was changed. Commit as:

```powershell
git add backend/migrations/2026-08-09-baseline-foreign-key-authority.sql backend/migrations/2026-08-09-baseline-foreign-key-authority.auto.sql backend/migrations/auto-manifest.json deployment/database/hostinger-manual-migrations.sql backend/services/schemaValidation.js backend/tests/fixtures/seed.js deployment/tools/bootstrap-database.js backend/tests/unit/automaticMigrations.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/integration/automaticMigrations.test.js backend/tests/integration/installerBaseline.test.js docs/superpowers/plans/2026-08-09-database-authority-foreign-key-repair.md
git commit -m "fix: enforce baseline foreign key authority"
```
