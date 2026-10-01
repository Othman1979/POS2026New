# Automatic Table Service Charge Implementation Plan

> **For Codex:** Execute this plan inline with the `executing-plans` skill. Keep the feature limited to the setting, table cart behavior, and server enforcement described here.

**Goal:** When enabled, new table orders automatically receive the configured service charge, show it last in the cart, and allow only an admin or programmer to remove it. Register orders and existing open table orders keep their current behavior.

**Architecture:** Reuse the existing service-charge snapshot and calculator. Add one key/value setting, let a new table cart request a frozen snapshot, and make the table-save route canonicalize or supply the fee from server settings. Do not add audit events, removal reasons, or order columns.

**Tech Stack:** Vue 3/Pinia, Express, MySQL, Vitest/Supertest.

---

### Task 1: Add and expose the setting

**Files:**
- Create: `backend/migrations/2026-07-14-auto-apply-service-charge.sql`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `backend/tests/integration/settingsValidation.test.js`
- Modify: `backend/routes/system.js`
- Modify: `src/admin/pages/Settings.vue`
- Modify: `assets/js/admin/i18n.js`

1. Add failing settings API tests for the default/value validation and persistence of `auto_apply_service_charge`.
2. Run `npx --no-install vitest run backend/tests/integration/settingsValidation.test.js` and confirm the new tests fail.
3. Add the default-off migration, fixture row, GET default, POST validation, and allow-list entry.
4. Add a nested Settings toggle visible only while tables and service charge are enabled; save it as off whenever either parent feature is off.
5. Add natural English and Arabic labels.
6. Re-run the focused settings test and confirm it passes.

### Task 2: Make the table cart automatic and clear

**Files:**
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `src/components/PosTerminal.vue`
- Modify: `assets/js/admin/i18n.js`

1. Add failing store tests proving a new table auto-adds one frozen fee, products remain before the fee, existing tables are unchanged, and only admin/programmer removal is accepted.
2. Run `npx --no-install vitest run backend/tests/unit/orderSessionStore.test.js` and confirm the new tests fail.
3. Refactor snapshot creation into one internal helper used by manual and automatic flows.
4. Trigger automatic creation only for a new active table when all three settings are enabled. Keep the fee last and reset the one-session removal flag with the order state.
5. Add the admin/programmer remove action. For an already-saved table, save the removal immediately and restore the local fee if that save fails.
6. Render the fee as a dedicated final cart row, with a small remove action only for admin/programmer. Keep the existing manual register action unchanged.
7. Re-run the focused store test and confirm it passes.

### Task 3: Enforce the same rule on the backend

**Files:**
- Modify: `backend/tests/integration/serviceChargeSnapshots.test.js`
- Modify: `backend/routes/pos/serviceCharges.js`
- Modify: `backend/routes/pos/helpers.js`
- Modify: `backend/routes/pos/tables.js`

1. Add failing integration tests for automatic table snapshot creation without the manual permission, server-side fallback on a new table, unchanged existing tables, waiter removal rejection, and admin removal persistence.
2. Run `npx --no-install vitest run backend/tests/integration/serviceChargeSnapshots.test.js` and confirm the new tests fail.
3. Permit automatic snapshot creation only when the request names a real table and tables, service charge, and automatic table charge are enabled.
4. On a new table save, use the current configured percentage and tax, create/bind a snapshot when the client omitted it, and canonicalize the fee. Do not auto-add to an existing open order.
5. Permit an existing bound table charge to survive waiter updates. Permit removal only for admin/programmer, abandon the bound snapshot, and clear the order link.
6. Return the frozen snapshot and whether the backend supplied the fee so the cart can reconcile.
7. Re-run the focused integration test and confirm it passes.

### Task 4: Verify and commit the feature branch

**Files:** all changed files.

1. Run the focused suite:
   `npx --no-install vitest run backend/tests/integration/settingsValidation.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/integration/tables.test.js`
2. Run `npm run build` (or the repository's applicable admin/POS build scripts if split).
3. Run `git diff --check` and inspect the final diff for unrelated changes.
4. Commit the reviewed implementation on `codex/auto-table-service-charge` with a focused feature commit.
