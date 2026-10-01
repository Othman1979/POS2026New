# Revenue Centers Implementation Plan (Renewed 2026-08-17, rev 2 — industry-informed)

> **For agentic workers:** REQUIRED SKILLS: `ponytail`, `executing-plans`, `test-driven-development`, `mysql`, `express-rest-api`, `vue`, `security-review`, `jofotara-invoice-integration`, and `verification-before-completion`. Work inline on `codex/revenue-centers-2`; do not use brainstorming; do not merge or push. The ONLY delegation allowed is migration-file writing to custom agent `luna_max` per the project migration workflow in `CLAUDE.md` — Luna never decides scope, approves, merges, pushes, or touches a production database. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partition one POS installation into administrator-defined revenue centers (Grill, Bakery, Coffee, …) — each with its own catalog, sections/tables, printers, shifts, sales, holds, and subscriptions — where selling staff are restricted to their assigned centers, one admin account sees and reconciles everything, single-center restaurants notice nothing, and the installation remains one legal JoFotara seller with one global invoice sequence.

**Architecture:** Operational revenue-center partitioning in the Oracle Simphony / Agilysys mold (outlet as the transactional unit; one staff identity with per-outlet membership rows), not the Toast/Square "reporting tag" model — because catalog, printing, and staff isolation are hard requirements here. A trusted request scope is resolved from the authenticated durable session plus the `X-Revenue-Center-Id` header; the header selects among server-authorized centers and never grants access. **Ten** tables own `revenue_center_id` directly; every other record derives its center through an immutable owner; legal, customer, template, remittance, and configuration records stay global. There is no feature toggle: the center row exists from day one (fresh installs seed `MAIN`), and all center UI chrome appears only when a second active center exists.

**Tech Stack:** Vue 3, Pinia, Express 5, Socket.IO, mysql2, MariaDB/InnoDB, Vitest, Supertest, the tracked print spooler, and the automatic manifest-chained migration system (`backend/migrations/auto-manifest.json` + `runPendingMigrations.js`).

**Supersedes:** `docs/superpowers/plans/2026-07-30-revenue-centers.md` (deferred) and rev 1 of this file. Rev 2 changes versus rev 1: printers become the tenth directly-owned table (they were global), `printer_categories` gains DB-enforced same-center parity, progressive disclosure replaces any notion of a toggle, center lifecycle gains a safe create/deactivate/delete contract, and every rev-1 "known risk" is now a numbered task step with a test.

## Industry Evidence (researched 2026-08-17)

Three research passes over Oracle MICROS Simphony, Toast, and the wider field (Square for Restaurants, Lightspeed K-Series, TouchBistro, Clover, Agilysys InfoGenesis, USALI/USAR accounting guidance) inform this revision:

| Pattern | Source | Adopted here |
|---|---|---|
| One employee identity + a thin per-RVC "operator record" granting sign-in; managers get more rows, never more accounts | Simphony Employee Maintenance / Operator Records (docs.oracle.com `c_employees_sys_emp_maint_table_view_operator_records`) | `user_revenue_centers` join table; admin/programmer bypass membership entirely |
| Order devices (kitchen/receipt routing) are RVC-level; hospitality systems partition printing per outlet by design (Agilysys "Kitchen Printer Group" per Profit Center) | Simphony Order Devices config; Agilysys InfoGenesis product/training docs | Printers directly own a center (Decision 19). Simphony's finer split — property-level printer *hardware* referenced by per-RVC *order devices*, allowing two RVCs to share one physical printer — is the documented upgrade path if sharing is ever needed; today's requirement is explicit non-sharing, and `printers.active_endpoint_key` (unique) already enforces one row per physical endpoint |
| The outlet object stays real internally for single-outlet properties, but is not surfaced as a decision point to staff; restaurant-first systems keep the concept invisible until configured | Simphony single-RVC guidance; Toast "No Revenue Center" default; Square/Clover/Lightspeed zero-config behavior | Progressive disclosure (Decision 20): MAIN always exists as a real FK target; zero center chrome until a second active center exists; no toggle |
| Reassignment/attribution is non-retroactive; history keeps the label it was written with | Toast revenue-center reassignment docs | Immutable historical attribution; reports scope by `orders.revenue_center_id` |
| Outlet deactivation is a soft flag, never a hard delete once history exists; deletions blocked by transactional references | Simphony employee/discount soft-delete pattern; Toast integration-anchored centers "cannot be deleted" | Lifecycle contract (Decision 21): deactivate with blocking-reasons; hard delete only for never-used centers |
| Per-RVC check numbering with legal/fiscal numbering handled separately per jurisdiction | Simphony RVC Parameters guest-check ranges | Order numbers stay shift-scoped (`orders.order_seq_scope`), the legal `invoice_number` stays one global stream — already the correct shape |
| Consolidated totals are a rollup of the outlet grain; an explicit "unattributed" bucket keeps reconciliation honest where attribution is impossible | Toast Z-report per-revenue-center totals + "No Revenue Center" bucket; Simphony R&A property rollups | All-centers reports sum center rows; platform-remittance provider-level adjustments are the one legitimately unattributable bucket and are labeled as such (Decision 12) |
| Tax application per-RVC exists in Simphony (bar inclusive vs restaurant add-on) | Simphony Tax Parameters | **Deliberately not adopted** — Jordan/JoFotara legal config stays global; a per-center tax mode would fragment the legal seller. Recorded as a divergence, not an omission |

The wider-field survey found no restaurant-first vendor offering hard operational isolation inside one location — where isolation exists it comes from the hospitality-native systems. That is the tier this plan implements, at this codebase's scale.

## Locked Decisions

Decisions 1-10 of the 2026-07-30 plan are re-affirmed: one server/database; one center per cart/hold/table check/checkout/purchase/redemption with mixed-center rejection; many-to-many user↔center with fail-closed non-admin access; one open shift per user across all centers, shift center authoritative; immutable ownership with copy-not-move catalog rollout; global customers; global settings/tax/order types/expense categories/templates/JoFotara/invoice sequences; unchanged JoFotara seller block and sequence; MAIN backfill without guessing history; no database-per-center, tenant framework, repositories, per-center Socket.IO rooms, or per-center templates. (The 2026-07-30 "printers stay global" clause is REVOKED by Decision 19.)

11. **Call-center users are center-assigned like any selling role.** A phone hold stamps `held_orders.revenue_center_id` at creation from the call-center user's resolved scope (auto-select when exactly one authorized active center; otherwise the header must select one). Claiming, restoring, editing, and settling a phone hold require membership in the hold's center. `orders.call_center_user_id` attribution is unchanged.
12. **Platform remittances stay global.** One legal entity receives one provider payout that may cover invoices from several centers. `platform_remittances` and `platform_remittance_adjustments` get no center column. Per-center payout attribution derives from `platform_remittance_lines → orders.revenue_center_id` for reporting only; remittance-level adjustments (commission, fees) are provider-level and reported as an explicit unattributed bucket in center-scoped views. Record/reverse remains an admin all-scope operation. Invariant 42 unchanged.
13. **Device access, WebAuthn, and durable sessions stay global.** The authorized-center list rides the existing `tokenCache` entry (loaded in `verifyToken`'s DB fill and `preWarmToken`). Assignment changes call `invalidateUserSessions(userId)` — the durable session survives; scope reloads next request; a now-unauthorized selected center fails the header check with 403 and the client re-selects. Center CRUD clears the whole token cache and refreshes the in-process center registry.
14. **Hidden programmer = programmer role = admin-equivalent center access.** One account sees all centers; `user_revenue_centers` is never consulted for admin/programmer. There are no per-center admin accounts, ever.
15. **Splits inherit their parent's center.** `createSplitChecks` stamps split holds from the parent order's center; `rewriteUnpaidSplitChecks`, `discardSplitCheck`, and split settle assert equality under the existing locks. No cross-center split.
16. **X/Z/Y and official audit documents stay global legal streams.** A shift's X/Z is inherently single-center via the shift's center. The global Z gains a labeled per-center totals breakdown (the Toast Z pattern) — labeling, never filtering. Y-held archive/restore remains one global transaction that labels centers.
17. **Subscription money follows the plan's center.** Purchase, receivable collection, reversal, refund, and redemption all require the acting shift's center to equal the plan's center. Collections derive center through subscription→plan; no new columns.
18. **The migration follows the automatic-migration workflow.** Luna writes the files; the chain entry requires the exact `2026-08-13-webauthn-registered-device-access-v1` predecessor; the server applies it at boot after a packaged update; Hostinger installs use the cumulative manual fallback. Old binaries against the migrated schema fail closed at the first center-owned INSERT — designed behavior; rollback restores app payload plus database backup.
19. **Printers are center-owned and never shared (NEW — revokes "printers global").** `printers` is the tenth directly-owned table. Each physical printer belongs to exactly one center; `printers.active_endpoint_key` (existing generated UNIQUE column) already guarantees one row per physical endpoint, so non-sharing is DB-enforced for free. `printer_categories` gains a `revenue_center_id` column with composite FKs to BOTH `printers(id, revenue_center_id)` and `categories(id, revenue_center_id)` — a cross-center kitchen mapping becomes unrepresentable, which structurally eliminates the "editor erases mappings it didn't load" defect class. POS receipt resolution, kitchen routing, and printer status are center-scoped; admin X/Z/Y legal documents keep free printer choice. Spoolers remain center-agnostic transport: a spooler machine claims by `spooler_id` exactly as today and may serve printers of several centers; print-job payloads carry `meta.revenue_center_id`/`meta.revenueCenterName` so the spooler and templates can display provenance. `print_queue` stays global (center derives via `printer_id`). If a future venue genuinely must share one physical printer between centers, the upgrade path is Simphony's hardware/order-device split — do not build it now.
20. **Progressive disclosure instead of a toggle (NEW).** There is no revenue-centers on/off setting. Fresh installs seed one active MAIN center and map the seeded admin + programmer; the migration backfills everything to MAIN. While exactly one active center exists: every scope resolution auto-selects it (all roles), user create/update auto-grants it, and the frontend renders zero center chrome — no POS selector, no gate, no admin header scope control, no center columns/filters. Creating the second active center is the single act that reveals the UI. Deactivating back down to one active center hides it again. Tests must cover both directions.
21. **Dynamic center lifecycle with a safe create/deactivate/delete contract (NEW).** Create: name+code, active immediately, empty; the Settings panel surfaces next steps (copy catalog subtree, create sections, assign printers, assign users). Deactivate: blocked while the center has an open shift, open/printed table, unresolved hold/split, live service-charge snapshot, or active subscription — reported as an explicit blocking-reasons list; paid history and inactive catalog never block; reactivation is always allowed. Hard DELETE: permitted only when the center owns zero rows across all ten owned tables (a center created by mistake); user assignments are removed with it; any owned row at all → deactivate is the only path. Historical reports keep deactivated centers visible and labeled.
22. **Only non-admin roles are center-restricted.** Restricted: `cashier`, `waiter`, `table_manager`, `call_center` (and any future selling role by default). Unrestricted: `admin`, `programmer`. Reports, dashboards, and admin pages are center-selectable from one admin account.

## Ownership Matrix

### Direct center ownership

Ten tables receive `revenue_center_id INT NOT NULL` (no default) plus a foreign key to `revenue_centers(id)`:

| Table | Why direct ownership is required (2026-08-17 evidence) |
|---|---|
| `categories` | Center-specific navigation tree; price-list roots are categories (baseline.sql:192-203). |
| `products` | `category_id` nullable; barcode/SKU/stock/availability need a center without a category (baseline.sql:204-235). |
| `sections` | Bare `(id, name)` today (baseline.sql:265-269); tables derive center via section. |
| `shifts` | Fixes the selling context before any order exists (baseline.sql:287-305). |
| `expenses` | `chk_expenses_drawer_shift` proves outside expenses have `shift_id NULL` — no derivation path (baseline.sql:342). |
| `orders` | Historical revenue attribution must survive catalog/user changes; every child derives from it. |
| `held_orders` | Exists before checkout; phone holds exist before any shift; splits restore independently. |
| `service_charge_snapshots` | Draft state precedes any hold/order; token transitions (baseline.sql:121-143). |
| `subscription_plans` | Manual subscriptions have no purchase order (`chk_customer_subscriptions_origin`, baseline.sql:841); composite-FK parity with the sale product's center. |
| `printers` (NEW) | Decision 19. Kitchen and receipt hardware is physically per-center; `active_endpoint_key` UNIQUE enforces non-sharing; routing/status/resolution become center-scoped. |

### Derived center ownership (no new columns except the `printer_categories` parity column)

| Table/domain | Derivation |
|---|---|
| `restaurant_tables`, `qr_table_drafts` | table → section → center |
| `order_items`, `refunds`, `refund_items`, `jofotara_documents`, `bundle_modifications` | child → order → center |
| `print_queue` | job → printer → center (labeling/health only; lifecycle stays global) |
| `platform_remittance_lines` | line → invoice → center (report attribution only; Decision 12) |
| `customer_subscriptions`, `subscription_collections`, `subscription_extensions`, `subscription_redemptions`, `subscription_redemption_items`, `customer_subscription_products` | subscription → plan → center |
| `subscription_plan_products` | plan owner; writes enforce product/plan center parity |
| `product_bundle_items`, `product_price_overrides`, `price_history` | related product/category owners; writes enforce parity |
| `printer_categories` | carries `revenue_center_id` purely as a parity column with composite FKs to printers AND categories — not independent ownership; both parents must share the center |
| `audit_events` | event payload/entity identifies the center; ledger global |

### Intentionally global

`settings`, `schema_migrations`, `users` (identity; access lives in `user_revenue_centers`), `permissions`, `user_permissions`, `auth_sessions`, `webauthn_credentials`, `webauthn_ceremonies`, `webauthn_recovery_codes`, `customers`, `order_types`, `expense_categories`, `print_queue`, `print_templates`, `print_template_revisions`, `print_template_revision_tests`, `invoice_sequences`, `daily_sequences`, `audit_report_documents`, `master_held`, `platform_remittances`, `platform_remittance_adjustments`, and all JoFotara settings.

## Request-Scope Contract

Exactly one header: `X-Revenue-Center-Id`.

| Surface | Missing header | Numeric header | `all` |
|---|---|---|---|
| POS API — cashier/waiter/table_manager | Auto-select only when exactly one active center is authorized; otherwise `409 REVENUE_CENTER_REQUIRED` | Validate active membership; attach `{ mode: 'single', id, center }` | Reject |
| POS API — call_center (phone-hold endpoints only) | Same auto-select rule against the call-center user's assignments | Validate active membership | Reject |
| POS API — admin/programmer | Auto-select only when exactly one active center exists; otherwise require numeric | Validate active center exists | Reject |
| Admin API — admin/programmer | Default to authorized `all` | Validate center; attach single scope | Attach `{ mode: 'all', id: null }` |
| Admin exceptions used by POS roles (`requireAdminUnlessExceptions`, admin.js:17) | Same as POS | Same as POS | Reject |
| Login/logout/`/auth/me`/system settings/WebAuthn/device access/public QR bootstrap/spooler | Ignore | Ignore | Ignore |

Rules:

- Authorized centers come from `user_revenue_centers` via the `tokenCache` entry; the header only selects. Client body/query `revenue_center_id` values are ignored everywhere.
- Resource-by-ID reads include the direct/derived center in the query or perform a locked ownership assertion before mutation.
- `all` is a read/report scope; creating center-owned resources requires a concrete center; admin actions on existing rows derive the center from the locked row.
- Backend services receive an explicit `revenueCenterId` parameter; none reads a process-global "current center".
- Center metadata (id/code/name/is_active) lives in one in-process registry map owned by the middleware module, loaded at boot and refreshed by the admin CRUD route — no per-request DB lookup.
- **Single-active-center fast path (Decision 20):** when the registry holds exactly one active center, every surface auto-selects it and no 409 is ever produced — the pre-centers behavior, byte for byte.

## Global Constraints

- Branch `codex/revenue-centers-2`; do not merge, push, deploy, or run anything against a live/production database. Rehearse migrations only on `posapp_test` or a restored disposable clone.
- Vitest via `npx vitest run` — exactly one process at a time (shared `posapp_test`). Focused files during implementation; the full suite exactly once before completion, diffed against a recorded pre-branch baseline (known pre-existing failures are being fixed on a parallel branch — record and diff, do not chase).
- Migration files are written by `luna_max` under the CLAUDE.md workflow: draft = dated evidence migration (+ preflight/verify); **`.auto.sql`, the `auto-manifest.json` entry, and the `hostinger-manual-migrations.sql` fallback block only after explicit user approval.** The main agent independently verifies Luna's output and owns baseline.sql, bootstrap, schemaValidation, fixtures, tests, and commits.
- Center-owned columns are `NOT NULL` with no default. An overlooked insert must fail, never silently land in MAIN.
- Historical rows are immutable; reports scope by `orders.revenue_center_id`, never by a product's current center.
- One global JoFotara profile, seller block, and invoice sequence; no XML change for the operational center. One global public `invoice_number` stream (invariant 26).
- Print templates, print queue, and the spooler protocol stay global/unchanged; printers are center-owned per Decision 19.
- Keep global `staff` fanout plus existing `section:<id>` rooms; events gain `revenue_center_id` payload fields; no center rooms.
- No feature toggle, no `revenue_centers_enabled` setting, no env var — Decision 20 is structural.
- Do not mass-refactor `Inventory.vue`, `PosTerminal.vue`, the order-session store, reports, or route files; change only ownership and context seams.
- After Task 9, `docs/architecture.json` updated and `npm run architecture` re-run in the same commit.

---

### Task 1: Authoritative Schema via the Automatic Migration Chain

**Files:**

- Create (Luna, draft stage): `backend/migrations/2026-08-17-revenue-centers.sql` (evidence migration), `backend/migrations/2026-08-17-revenue-centers.preflight.sql`, `backend/migrations/2026-08-17-revenue-centers.verify.sql`
- Create (Luna, ONLY after explicit user approval): `backend/migrations/2026-08-17-revenue-centers.auto.sql`; one ordered entry in `backend/migrations/auto-manifest.json`; the identical approved block appended to `deployment/database/hostinger-manual-migrations.sql`
- Modify: `deployment/database/baseline.sql`, `deployment/tools/bootstrap-database.js`, `deployment/tools/verify-install.js`
- Modify: `backend/services/schemaValidation.js`
- Modify: `backend/tests/fixtures/seed.js`, `backend/tests/helpers/fixtures.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`, `backend/tests/integration/installerBaseline.test.js`, `backend/tests/unit/automaticMigrations.test.js`
- Create: `backend/tests/integration/revenueCenters.schema.test.js`
- Modify: every direct SQL fixture insert surfaced by the Step 1 audit

**Schema interfaces (the contract Luna implements):**

```sql
CREATE TABLE IF NOT EXISTS revenue_centers (
  id INT NOT NULL AUTO_INCREMENT,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(100) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_revenue_centers_code (code),
  KEY idx_revenue_centers_active_sort (is_active, sort_order, id),
  CONSTRAINT chk_revenue_centers_active CHECK (is_active IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS user_revenue_centers (
  user_id INT NOT NULL,
  revenue_center_id INT NOT NULL,
  PRIMARY KEY (user_id, revenue_center_id),
  KEY idx_user_revenue_centers_center (revenue_center_id, user_id),
  CONSTRAINT fk_user_revenue_centers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_revenue_centers_center FOREIGN KEY (revenue_center_id) REFERENCES revenue_centers(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
```

Then, in order, inside one `.auto.sql` (every statement Hostinger-safe and rerunnable — `ADD COLUMN IF NOT EXISTS`, `ADD INDEX IF NOT EXISTS`, `ADD CONSTRAINT ... IF NOT EXISTS`, `DROP INDEX IF EXISTS`, backfills guarded by `WHERE ... IS NULL` / `WHERE NOT EXISTS`, matching `2026-08-10-call-center-held-orders.auto.sql`):

1. Create the two tables.
2. Seed one active `MAIN` center, name from non-empty global `store_name` else `Main Restaurant`, guarded by `WHERE NOT EXISTS (SELECT 1 FROM revenue_centers)`.
3. `ADD COLUMN IF NOT EXISTS revenue_center_id INT NULL` on the **ten** owned tables (nine from the matrix + `printers`) and on `printer_categories`.
4. Backfill every NULL to the MAIN id (including `printer_categories.revenue_center_id` from its printer's center); map every existing user via `INSERT IGNORE INTO user_revenue_centers SELECT id, (SELECT MIN(id) FROM revenue_centers) FROM users`.
5. `MODIFY revenue_center_id INT NOT NULL` on all eleven columns (ten owners + the parity column).
6. Reference keys for parity: `UNIQUE (id, revenue_center_id)` on `categories`, `products`, `shifts`, `service_charge_snapshots`, `printers`; `UNIQUE (invoice_id, revenue_center_id)` on `orders`.
7. Composite parity FKs (all `IF NOT EXISTS`): categories `(parent_id, revenue_center_id)` and `(price_list_root_id, revenue_center_id)` → categories `(id, revenue_center_id)`; products `(category_id, revenue_center_id)` → categories; orders `(shift_id, revenue_center_id)` → shifts and `(service_charge_snapshot_id, revenue_center_id)` → service_charge_snapshots; expenses `(shift_id, revenue_center_id)` → shifts; held_orders `(parent_invoice_id, revenue_center_id)` → orders and `(service_charge_snapshot_id, revenue_center_id)` → service_charge_snapshots; subscription_plans `(sale_product_id, revenue_center_id)` → products; **printer_categories `(printer_id, revenue_center_id)` → printers `(id, revenue_center_id)` AND `(category_id, revenue_center_id)` → categories `(id, revenue_center_id)`** — a cross-center kitchen mapping becomes unrepresentable at the database. (`held_orders.table_id` parity stays app-enforced: a table's center is derived via section.)
8. Scoped identifiers: `DROP INDEX IF EXISTS idx_barcode` / `DROP INDEX IF EXISTS sku` on products; `ADD UNIQUE INDEX IF NOT EXISTS uq_products_center_barcode (revenue_center_id, barcode)` and `uq_products_center_sku (revenue_center_id, sku)`; `ADD UNIQUE INDEX IF NOT EXISTS uq_sections_center_name (revenue_center_id, name)` on sections. `printers.active_endpoint_key` UNIQUE is intentionally NOT scoped — one physical endpoint stays one printer row installation-wide (Decision 19's non-sharing guarantee).
9. Drop superseded single-column keys only where a composite replaces them and `information_schema` confirms the name; keep `products_ibfk_1`.
10. Final statement: the ledger `INSERT INTO schema_migrations ... ON DUPLICATE KEY UPDATE` with this migration's checksum.

Manifest entry contract: name `2026-08-17-revenue-centers-v1`; `requires` = `2026-08-13-webauthn-registered-device-access-v1` / `20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09`; not repeatable; **preflight** = exactly one read-only SELECT returning `ok=1` only when (a) `sections` has no duplicate names (they all land in MAIN and would collide under `uq_sections_center_name`), and (b) `printer_categories` has no orphan rows pointing at missing printers/categories (the new FKs would fail on them).

- [ ] **Step 1: Audit direct fixture inserts (evidence, not assumption)** — the 2026-07-30 Appendix A is stale; regenerate:

```powershell
rg -n --glob '!node_modules/**' --glob '!dist/**' "INSERT INTO (products|categories|sections|shifts|expenses|orders|held_orders|service_charge_snapshots|subscription_plans|printers|printer_categories)\b" backend server.js tests
```

Every test match gets `revenue_center_id` in Step 4; every production match must appear in a later task's diff. Record the list in the commit body.

- [ ] **Step 2: Write RED schema-authority and integrity tests** — both tables; all ten columns NOT NULL without default; the parity keys and composite FKs including both `printer_categories` FKs; a cross-center printer↔category mapping rejected by the DB; duplicate barcode succeeds across centers and fails within one; one active MAIN with full user coverage in fixtures; fresh bootstrap maps admin `009384` and the programmer; **repeatable-resurrection guard**: assert (by reading the files) that no `repeatable: true` migration in `auto-manifest.json` contains `idx_barcode`, ` sku `, or `uq_sections_center_name` — this pins the risk that a future edit to the repeatable reconciliation migrations resurrects the dropped global uniques at boot.

```powershell
npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/integration/revenueCenters.schema.test.js backend/tests/integration/installerBaseline.test.js
```

- [ ] **Step 3: Luna writes the draft evidence migration; verify independently** — draft stage only (no `.auto.sql`/manifest/fallback). Read every statement; confirm Hostinger-safe format and rerunnability after simulated partial DDL; confirm the verify script ends `blocking_findings = 0`.
- [ ] **Step 4: Update schema authority, baseline, bootstrap, fixtures** — `baseline.sql` (fresh == migrated, proven by information_schema comparison in the schema test), `bootstrap-database.js` (seed MAIN, map both seeded users), `verify-install.js`, `schemaValidation.js` (`MIGRATION_NAME`/`MIGRATION_CHECKSUM` → new tip; new `REQUIRED_COUNTS`: revenue_center_tables: 2, revenue_center_columns: 11, revenue_center_reference_keys: 6, revenue_center_scoped_uniques: 3, printer_category_parity_fks: 2 — follow the file's counting-query style), plus all Step 1 fixtures.
- [ ] **Step 5: GREEN + chain rehearsal**

```powershell
node scripts/validate-schema-drift.js
npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/integration/revenueCenters.schema.test.js backend/tests/integration/installerBaseline.test.js backend/tests/unit/automaticMigrations.test.js
npm run test:installer
```

Restore a disposable clone at exactly the webauthn ledger floor; run preflight → apply → verify; run apply a second time to prove rerunnability; confirm row counts and financial totals unchanged.

- [ ] **Step 6: Request approval, then finalize** — after explicit user approval only: Luna writes `.auto.sql` (the exact approved SQL), the manifest entry, and the fallback block; main agent verifies manifest order/hashes, byte-for-byte fallback parity, `automaticMigrations.test.js` green, and a scratch-DB `runPendingMigrations` pass from the floor.
- [ ] **Step 7: Commit**

```text
feat(db): add authoritative revenue center ownership
```

---

### Task 2: Trusted Scope, Session Integration, Center Lifecycle, and Progressive Disclosure

**Files:**

- Create: `backend/middleware/revenueCenter.js`
- Create: `backend/routes/admin/revenueCenters.js`
- Modify: `backend/routes/admin.js`, `backend/routes/pos.js`, `backend/middleware/auth.js`, `backend/routes/auth.js`, `backend/routes/admin/users.js`
- Create: `src/shared/revenueCenterContext.js` + `src/shared/revenueCenterContext.spec.js`
- Create: `src/components/RevenueCenterGate.vue`
- Modify: `src/shared/authInterceptor.js`, `src/components/Login.vue`, `src/App.vue`, `src/router.js`, `src/pos/useAuth.js`
- Modify: `src/admin/App.vue`, `src/admin/components/AdminHeader.vue`, `src/admin/composables/useAdminSession.js`, `src/admin/pages/Users.vue`, `src/admin/pages/Settings.vue`
- Create: `src/admin/components/settings/RevenueCenterSettings.vue` (sibling of `DeviceAccessSettings.vue`)
- Modify: `src/shared/i18n.js` (Arabic keys only)
- Create: `backend/tests/integration/revenueCenterAccess.test.js`
- Modify: `backend/tests/integration/permissions.test.js`, `backend/tests/integration/callCenterRoleWalls.test.js`

**Backend interface** (`backend/middleware/revenueCenter.js` — no SQL scope builder):

```js
loadCenterRegistry(executor)                    // boot + CRUD refresh of the in-process id→{code,name,is_active} map
resolveRevenueCenterScope(req, { surface })     // 'pos' | 'admin' per the contract table, incl. the single-active-center fast path
requireRevenueCenter(req, res, next)            // POS surfaces incl. call_center phone-hold routes
resolveAdminRevenueCenter(req, res, next)
requireConcreteRevenueCenter(req, res, next)
```

**Cache integration:** `tokenCache` entries gain `user.revenue_center_ids` (loaded alongside `PermissionService.loadUserPermissions` at auth.js:177, pre-warmed at login); `normalizeSessionUser` (auth.js:20) preserves `revenue_center_ids` for call_center while stripping permissions/sections; new `invalidateAllTokens()` export for center CRUD; existing `invalidateUserSessions` covers assignment edits.

**Frontend interface** (`src/shared/revenueCenterContext.js`): per-tab `pos_active_revenue_center_id` (numeric) and `admin_revenue_center_scope` (numeric | 'all'); reactive available centers from `/auth/login` + `/auth/me`; `getRequestRevenueCenterScope()` by surface; a derived `multiCenter` boolean (2+ active centers) that ALL center chrome binds to; header attachment via `authInterceptor.js` for internal authenticated APIs only.

- [ ] **Step 1: RED access + disclosure tests** — the full contract matrix per surface; client body `revenue_center_id` ignored; assignment change → 403 on the removed center without logout; center CRUD → no stale cache authorization; POS/admin storage keys independent; header interception for string URLs and `Request` objects; **progressive disclosure both directions**: with one active center every role auto-selects with zero 409s and `/auth/me` marks `multi_center: false`; creating a second active center flips it; deactivating back flips it again; **auto-grant**: while exactly one active center exists, user create/update grants it implicitly.

```powershell
npx vitest run backend/tests/integration/revenueCenterAccess.test.js backend/tests/integration/permissions.test.js backend/tests/integration/callCenterRoleWalls.test.js src/shared/revenueCenterContext.spec.js
```

- [ ] **Step 2: Implement middleware + session/cache integration**; route-order test proves the public QR draft GET, spooler, and system routes stay outside the scope middleware.
- [ ] **Step 3: Login/me payloads + selection rules** — one active center: silent auto-select; open shift: lock the shift's center (field lands in Task 4; assertion staged as `todo` until then); multiple without shift: `RevenueCenterGate`; admin defaults `all`; non-admin with zero centers denied with a clear message.
- [ ] **Step 4: Center lifecycle endpoints (Decision 21)** — create (code uppercase immutable, active, empty, returns a next-steps checklist payload); rename/reorder; deactivate with the explicit blocking-reasons list (open shift / open or printed table / unresolved hold or split / live snapshot / active subscription — one query, each reason named); reactivate; hard DELETE only when zero owned rows across all ten tables (assignments removed with it), else 409 listing what exists. Every lifecycle mutation refreshes the registry, clears the token cache, and writes `audit_events`.
- [ ] **Step 5: Atomic user mutations** — user row + permission grants + center grants + sanitized `allowed_sections` in one transaction; sections must belong to an assigned center (tightened in Task 5); reject removing the center of a user's open shift; selling-role demotion from admin/programmer requires ≥1 active center; single-active-center auto-grant per Decision 20.
- [ ] **Step 6: UI with progressive disclosure** — `RevenueCenterSettings.vue` (the only place centers are visible at count 1 — it is where the second center is born); everything else (POS selector, gate, AdminHeader scope, Users center pickers, center columns) renders only when `multiCenter` is true.
- [ ] **Step 7: GREEN + build + commit**

```powershell
npx vitest run backend/tests/integration/revenueCenterAccess.test.js backend/tests/integration/permissions.test.js backend/tests/integration/callCenterRoleWalls.test.js src/shared/revenueCenterContext.spec.js
npm run build
```

```text
feat(auth): establish trusted revenue center context
```

---

### Task 3: Catalog, Inventory, Caches, and QR Menu

**Files:**

- Modify: `backend/routes/pos/catalog.js` (products :47, product_lookup :288, category-prices/resolve :345)
- Modify: `backend/routes/admin/products.js`, `backend/routes/admin/categoryPriceLists.js`, `backend/routes/admin/bundle-items.js`, `backend/routes/admin/import.js`
- Modify: `backend/services/categoryPriceLists.js`, `backend/services/bundleIntegrity.js`
- Modify: `backend/config/cache.js` (catalog slot → Map keyed `${centerId}:${salesContext}` with per-key ETags)
- Modify: `backend/config/menuCache.js` (static menu → per-active-center slices)
- Modify: `server.js` (QR socket: canonicalize drafts against the table's derived center)
- Modify: `src/pos/useProducts.js` (+ request spec), `src/admin/pages/Inventory.vue`, `ProductModal.vue`, `CategoryModal.vue`, `CategoryCopyModal.vue`, `BatchProductWorkspace.vue`, `ImportModal.vue`, `CategoryPriceListModal.vue`, `src/menu/MenuApp.vue`
- Create: `backend/tests/integration/revenueCenterCatalog.test.js`, `backend/tests/integration/revenueCenterQrMenu.test.js`
- Modify: existing catalog/bundle/category-copy/price-list tests

- [ ] **Step 1: Hostile RED tests.** Two centers, same barcode/SKU, different prices: list/pagination/search/barcode/price-resolve/availability/category CRUD/batch/import/bundles/price lists never cross; parent/root/bundle/override/sale-product cross-center writes rejected; **cache poisoning pinned**: the catalog cache for A cannot satisfy B even with equal query strings and ETags (RED is guaranteed by today's single `catalogPayload` slot at cache.js:1-17); admin `all` inventory read-only labeled, create/import require concrete center; `admin/import.js` operates only inside its selected center — including its `printer_categories` handling, which after Task 1's parity FKs cannot write cross-center rows and must scope its delete to the selected center's mappings (the unconditional `DELETE FROM printer_categories` at import.js:126 is retired); public table QR gets only its table's center slice; forged foreign product IDs in a QR draft rejected/canonicalized; **single-center invisibility**: with one active center every catalog response is byte-identical to pre-centers behavior (no center labels/fields leak into POS payloads).
- [ ] **Step 2: Scope every catalog query** with explicit `revenue_center_id` predicates; create stamps `req.revenueCenter.id`; update/delete loads `(id, center)`; product/category center immutable.
- [ ] **Step 3: Category-tree copy as the rollout path** — `target_revenue_center_id` on the existing copy modal/route; cross-center copy creates new rows, blanks barcode/SKU, resets stock, rejects out-of-subtree bundle components, copies neither printer mappings nor plans, audits both centers.
- [ ] **Step 4: Partition caches and the static menu** — the Map keyed cache; `generateStaticMenu` per-center slices; table URL resolves table → section → center; generic menu without a table shows an active-center chooser only when 2+ active centers exist.
- [ ] **Step 5: Frontend race-proofing** — `useProducts` request identity includes center; switch invalidates in-flight responses and clears state; slow A response cannot repaint B.
- [ ] **Step 6: GREEN + build + commit**

```powershell
npx vitest run backend/tests/integration/revenueCenterCatalog.test.js backend/tests/integration/revenueCenterQrMenu.test.js backend/tests/integration/products.test.js backend/tests/integration/categoryCopy.test.js backend/tests/integration/categoryPriceLists.test.js backend/tests/integration/bundle.catalog.test.js src/pos/useProductsRequests.spec.js
npm run build
```

```text
feat(catalog): isolate revenue center inventory and menu data
```

---

### Task 4: Shifts, Expenses, Service Charges, Holds (incl. Call-Center), and Checkout

**Files:**

- Modify: `backend/routes/auth.js`, `backend/routes/pos/checkout.js`, `backend/modules/checkout/executeCheckout.js`, `backend/services/InventoryService.js`, `backend/services/CheckoutAttemptService.js`
- Modify: `backend/routes/pos/orders.js`, `backend/services/HeldOrderLifecycleService.js`, `backend/services/HeldOrderKitchenDispatch.js`
- Modify: `backend/routes/pos/serviceCharges.js`, `backend/services/ServiceChargeSnapshotService.js`
- Modify: `backend/routes/pos/expenses.js`, `backend/routes/admin/expenses.js`, `backend/services/expenseService.js`
- Modify: `src/pos/useAuth.js`, `src/pos/stores/orderSession/orderSessionPersistence.js`, `src/pos/posSessionStorage.js`, `src/pos/stores/orderSessionStore.js`, `src/pos/stores/orderSession/orderSessionApi.js`, `src/components/PosTerminal.vue`
- Create: `backend/tests/integration/revenueCenterCheckout.test.js`
- Modify: checkout/held/service-charge/shift/expense/call-center tests

Rules:

- **Shift center authoritative:** open stamps the validated selected center; one open shift per user across all centers; non-admin cannot switch centers while a shift, cart, active table, hold handoff, checkout attempt, or live snapshot exists; check/restore overrides stale browser selection.
- **`executeCheckout(conn, { ..., revenueCenterId })`** threaded explicitly; every authoritative resource (products, barcode results, bundle components, price roots, tables, held ids, parent orders, snapshot ids/tokens, plan ids) loaded/locked WITH the center predicate; `orders.revenue_center_id` inserted once, never updated; idempotency retry in the original center returns the original order, the same key under another center returns a conflict.
- **Phone holds (Decision 11):** call_center hold creation resolves and stamps the caller's center; list/claim/lock/settle assert membership in the hold's center; the financial-authority walls (orders.js:92-201) untouched.
- **Snapshots and expenses stamp center at creation**; drawer expense center equals the shift's center (DB parity FK backs this); outside expenses require a concrete center; snapshot children/transitions preserve the parent's center.
- **One POS-storage owner marker:** `pos_order_revenue_center_id` in `orderSessionPersistence`; restore compares with the active center; absent/mismatch → existing full cleanup, then write the marker.

- [ ] **Step 1: RED transaction-boundary tests** — all rules; an admin sale without a shift records a concrete center; foreign-center IDs of every resource type rejected at checkout; stale localStorage from A cleared before B restores; phone hold in A unclaimable by a B-only cashier; **single-center invisibility**: with one active center, checkout request/response payloads and hold flows are unchanged from today.

```powershell
npx vitest run backend/tests/integration/revenueCenterCheckout.test.js backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/heldOrders.fireKitchen.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/shift.test.js backend/tests/integration/expenses.test.js backend/tests/integration/callCenterRoleWalls.test.js backend/tests/unit/serviceChargeSnapshotService.test.js backend/tests/unit/orderSessionStore.test.js
```

- [ ] **Step 2: Implement** shift binding, checkout threading, hold/snapshot/expense stamping, storage marker.
- [ ] **Step 3: GREEN + build + commit**

```text
feat(checkout): bind selling transactions to revenue centers
```

---

### Task 5: Tables, Sections, Relationships, and Progressive Splits

**Files:**

- Modify: `backend/routes/pos/tables.js`, `backend/modules/tables/saveTableOrder.js`, `backend/modules/tables/markTablePrinted.js`, `backend/modules/tables/tableRelationships.js`, `backend/modules/tables/splitChecks.js`
- Modify: `backend/services/TableSettlementContext.js`, `backend/services/TableRealtime.js`
- Modify: `src/components/TableFloorPlan.vue`, `src/pos/stores/orderSession/tableOrderWorkflow.js`, `src/pos/stores/orderSession/tableSession.js`
- Modify: `src/admin/pages/TableMapEditor.vue` (concrete center required; hidden behind `multiCenter` chrome rule)
- Create: `backend/tests/integration/revenueCenterTables.test.js`
- Modify: tables/bundle-table/settlement/relationship/split tests and module-wiring tests

Rules: floor reads filter sections by center then intersect `allowed_sections` (blank stays fail-closed for waiters; means all sections in the active center for permitted non-waiters); `saveTableOrder`/`TableSettlementContext`/`markTablePrinted`/relationships/splits receive explicit center and lock+compare every participant; splits inherit the parent order's center (Decision 15) through create/edit/rewrite/discard/restore/settle with the invariant-28 money contract unchanged; Dynamic section resolved by `(revenue_center_id, name)`; realtime events carry `revenue_center_id`.

- [ ] **Step 1: RED attack tests** — forged `table_id`/`section_id`/`parent_invoice_id`/split-hold IDs across centers on every operation; per-center Dynamic sections; split edit in A by a B-only user rejected; duplicate table numbers across centers allowed.

```powershell
npx vitest run backend/tests/integration/revenueCenterTables.test.js backend/tests/integration/tables.test.js backend/tests/integration/bundle.tables.test.js backend/tests/integration/tableSettlementContext.test.js backend/tests/unit/tableOrderModuleWiring.test.js backend/tests/unit/tableRelationshipModuleWiring.test.js backend/tests/unit/splitCheckModuleWiring.test.js
```

- [ ] **Step 2: Implement + GREEN + build + commit**

```text
feat(tables): enforce revenue center table boundaries
```

---

### Task 6: Subscriptions — Plans, Purchases, Receivables, Collections, Redemptions

**Files:**

- Modify: `backend/routes/admin/subscriptions.js`, `backend/routes/pos/subscriptions.js`, `backend/services/SubscriptionService.js`, `backend/services/subscriptionMetrics.js`, `backend/services/productSalesMetrics.js`
- Modify: `src/admin/pages/Subscriptions.vue`, `SubscriptionPlanModal.vue`, `SubscriptionAssignmentModal.vue`, `SubscriptionDetailDrawer.vue`, `src/components/pos/SubscriptionModal.vue`
- Create: `backend/tests/integration/revenueCenterSubscriptions.test.js`
- Modify: subscription plan/purchase/management/collection/redemption tests

Rules (Decision 17): plan center stamped at creation, immutable, sale product + every eligible product share it (composite FK + app validation for `subscription_plan_products`); purchase/collection/reversal/refund/redemption require shift center == plan center; POS lookup returns only the active center's redeemable subscriptions while the customer stays global; admin `all` reads/acts on existing subscriptions but needs a concrete center to create; redemption idempotency (invariant 34) and stock movements stay in the plan's center.

- [ ] **Step 1: RED isolation tests:**

```powershell
npx vitest run backend/tests/integration/revenueCenterSubscriptions.test.js backend/tests/integration/subscriptionPlans.test.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/subscriptionCollections.test.js backend/tests/integration/subscriptionRedemptions.test.js
```

- [ ] **Step 2: Implement + GREEN + build + commit**

```text
feat(subscriptions): isolate plans and redemptions by revenue center
```

---

### Task 7: Center-Owned Printing, Refunds, JoFotara (Global), and Platform Remittances

**Files:**

- Modify: `backend/routes/admin/printers.js` (CRUD stamps center; mapping editor edits one printer's own-center categories; :167/:185 unfiltered mapping DELETEs retired by construction)
- Modify: `backend/services/printDispatch.js` (`resolveReceiptPrinter({ printerId, revenueCenterId })` — printDispatch.js:105; `dispatchReceiptPrint` threads it)
- Modify: `backend/services/kitchenPrintRouting.js` (:56 — printer join gains `p.revenue_center_id = ?`; mapping parity is already DB-guaranteed)
- Modify: `backend/services/HeldOrderKitchenDispatch.js` (:410 printer query scoped to the hold's center)
- Modify: `backend/routes/print.js` (:458 receipt path passes the session/shift center; :1190 reprint scoped by the order's center)
- Modify: `backend/services/printerStatus.js`, `backend/routes/admin/printTemplates.js` (:198 printer pickers labeled/grouped by center), `backend/services/printTemplateManager.js` (test prints: admin free choice, validated active)
- Modify: `backend/services/expensePrint.js` (resolve within the expense's center)
- Modify: `backend/routes/admin/auditReports.js` (X/Z/Y: explicit admin printer choice preserved — legal documents may print on any center's receipt printer)
- Modify: `backend/services/printDocumentModel.js`, `backend/services/printTemplateEngine.js`, `backend/services/printTemplateDefaults.js` (optional sanitized `meta.revenue_center_id` + `meta.revenueCenterName` bindings; active revisions stay valid)
- Modify: `backend/routes/pos/refunds.js`, `backend/services/RefundService.js`, `backend/modules/refunds/voidOpenTableOrder.js`
- Modify: `backend/services/JofotaraService.js`, `backend/routes/admin/jofotara.js`, `src/admin/pages/JofotaraOperations.vue`
- Modify: `backend/routes/admin/platformRemittances.js`, `backend/services/PlatformRemittanceService.js` (row labels via invoice join), `src/admin/pages/PlatformRemittances.vue`
- Modify: `src/admin/pages/Settings.vue` printers panel (grouped by center when `multiCenter`)
- Create: `backend/tests/integration/revenueCenterRefundPrint.test.js`
- Modify: refund, print-authz, print-unit, template-engine, JoFotara, platform tests; spooler tests only if the optional meta binding reaches them (no transport/protocol change)

Rules:

- **Printers (Decision 19):** every POS-side printer resolution is center-scoped — receipts by the shift/session center, kitchen tickets by the order's center, expense slips by the expense's center. Each center typically configures its own single receipt printer, which makes the existing "Select a receipt printer" 409 (printDispatch.js:100-102) rarer, not more common. Spooler protocol untouched: jobs already carry the physical target; payloads additionally carry `meta.revenue_center_id`/`meta.revenueCenterName`; a spooler machine may serve printers of several centers (`printers.spooler_id` semantics unchanged); the spooler health/failed-jobs counters stay global while the admin print-queue view labels each job's center via its printer.
- **Refund center derives only from the order** — join/lock, assert scope, reuse through allocation, shift validation, kitchen void, stock restoration; no columns on refunds/refund_items.
- **JoFotara stays one seller** — center labels operations rows only; auto-submit/retry global; XML byte-identical.
- **Platform remittances (Decision 12)** — receivable/candidate rows labeled with their invoice's center; allocation not center-restricted; range totals gain optional per-center breakdown via lines; adjustments labeled provider-level/unattributed.

- [ ] **Step 1: RED IDOR/money/identity tests** — A cannot refund/void/reprint B by any ID with valid permissions; a B-center kitchen ticket can never land on an A-center printer even with a forged category mapping attempt (DB parity makes the mapping itself impossible — assert the constraint fires); receipt resolution ignores another center's printers; stock restores only in the origin center; reconstructed documents derive center authoritatively; `meta.revenueCenterName` optional and sanitized; two accepted invoices from different centers share the seller block and one monotonic sequence; X/Z/Y admin printing keeps free printer choice; remittance allocation across centers balances and reversal signs unchanged; **single-center invisibility**: with one active center, printer setup, receipt selection, and all print payloads behave exactly as today.

```powershell
npx vitest run backend/tests/integration/revenueCenterRefundPrint.test.js backend/tests/integration/refunds.test.js backend/tests/integration/print.authz.test.js backend/tests/unit/print.unit.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/kitchenPrintRouting.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/platformHeldSettlement.test.js
```

- [ ] **Step 2: Implement + GREEN + build + commit**

```text
feat(printing): bind printers and refunds to revenue centers
```

---

### Task 8: Reconciled Admin Operations and Reporting

**Files:**

- Modify: `backend/routes/admin/dashboard.js`, `backend/services/dashboardDataBuilder.js`, `backend/services/dashboardAnalytics.js`, `backend/config/cache.js` (dashboard key includes scope)
- Modify: `backend/routes/admin/orders.js`, `backend/routes/admin/shifts.js`, `backend/routes/admin/reports.js`
- Modify: `backend/services/dailyReportBuilder.js`, `dailyReportDimensions.js`, `dailySalesDetailsBuilder.js`, `dailyRefundReportBuilder.js`, `dailyExpenseReportBuilder.js`, `financeMetrics.js`, `financialEventMetrics.js`, `productSalesMetrics.js`, `subscriptionMetrics.js`, `categoryItemsReportBuilder.js`, `yHeldItemsReportBuilder.js` (label only), `backend/services/auditReportBuilder.js` (global Z gains labeled per-center totals rows — Decision 16)
- Modify: `src/admin/pages/Dashboard.vue` + dashboard components/composables/types, `Orders.vue`, `Shifts.vue`, `ReportsSummary.vue`, `ReportsSalesDetails.vue`, `ReportsRefunds.vue`, `ReportsExpenses.vue`, `ReportsLayout.vue`, `WaiterPerformance.vue`, `src/shared/i18n.js`
- Create: `src/admin/components/dashboard/DashboardRevenueCenters.vue`
- Create: `backend/tests/integration/revenueCenterReports.test.js`

Builder signature pattern (optional authorized scope, `null` = admin all):

```js
buildDashboardData(executor, { now, revenueCenterId = null })
buildDailyReport(executor, { period, revenueCenterId = null })
```

Rules: single-center pages contain only their rows; all-centers totals equal the sum of center totals under identical 06:00 business-day rules (invariant 32); all-centers average ticket recomputed from consolidated figures; attribution follows the original order/shift/plan center; same product names never collapse across centers; dashboard cache keys distinguish `all`/A/B; platform payout per Decision 12; global Z adds labeled per-center net-sales rows without changing its totals or serial semantics; `<keep-alive>` pages watch the reactive scope and clear stale data; center columns/selectors render only when `multiCenter` (Decision 20).

- [ ] **Step 1: RED reconciliation tests** — two centers seeded with paid sales, split tender, receivables + collections, discounts, a tax-exempt sale, service charge, partial refund, void, drawer/outside expenses, subscriptions, platform orders + one cross-center remittance, low stock, open shifts, tables; assert every rule including `sum(center rows) + unattributed provider adjustments == all-centers payout` and the Z breakdown rows summing to the unchanged Z total; **single-center invisibility**: with one active center, dashboards/reports render without center chrome and totals match pre-centers snapshots.

```powershell
npx vitest run backend/tests/integration/revenueCenterReports.test.js backend/tests/integration/dashboard.test.js backend/tests/integration/dashboardDataBuilder.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/dailyReportsSalesDetails.test.js backend/tests/integration/dailyReportsExpenses.test.js backend/tests/integration/reportsRefunds.test.js backend/tests/integration/auditReports.test.js backend/tests/integration/yHeldItemsReport.test.js
```

- [ ] **Step 2: Implement** with explicit predicates and grouped queries for the All comparison; no generic scoped-query abstraction.
- [ ] **Step 3: Verify query plans** — `EXPLAIN` representative center+date queries with realistic fixture counts; candidates: categories `(revenue_center_id, parent_id, is_active, id)`, products `(revenue_center_id, is_active, category_id, id)`, orders `(revenue_center_id, invoice_issued_at, invoice_id)` and `(revenue_center_id, created_at)`, shifts `(revenue_center_id, status, opened_at, id)`, expenses `(revenue_center_id, created_at, status, id)`, held_orders `(revenue_center_id, created_at, id)`, plans `(revenue_center_id, is_active, id)`. Adopted indexes go through the Luna amendment path before approval, or a follow-up migration — never hand-applied.
- [ ] **Step 4: GREEN + build + commit**

```text
feat(admin): add reconciled revenue center operations
```

---

### Task 9: Boundary Attack, Architecture Authority, and Rollout Runbook

**Files:**

- Modify: `docs/architecture.json` (+ regenerate via `npm run architecture`)
- Create: `docs/superpowers/runbooks/2026-08-17-revenue-centers-rollout.md`
- Modify: only files with real defects found by the attack

- [ ] **Step 1: Ownership audit sweep** — classify every SQL occurrence of the ten owned tables and every ID-based endpoint as global-maintenance / authorized-all / single-center predicate / safe derivation; zero unexplained matches:

```powershell
rg -n --glob '!node_modules/**' --glob '!dist/**' "FROM (products|categories|sections|restaurant_tables|shifts|expenses|orders|held_orders|service_charge_snapshots|subscription_plans|printers)\b|JOIN (products|categories|sections|restaurant_tables|shifts|expenses|orders|held_orders|service_charge_snapshots|subscription_plans|printers)\b|UPDATE (products|categories|sections|restaurant_tables|shifts|expenses|orders|held_orders|service_charge_snapshots|subscription_plans|printers)\b|INSERT INTO (products|categories|sections|shifts|expenses|orders|held_orders|service_charge_snapshots|subscription_plans|printers|printer_categories)\b" backend server.js
rg -n --glob '!node_modules/**' "localStorage|sessionStorage|catalogPayload|dashboardAnalyticsCache|generateStaticMenu|emit\(" src backend server.js
```

- [ ] **Step 2: Adversarial browser workflows** (two users, two centers, two tabs, API tampering): cross-center visibility; same-barcode resolution; forgery → 403/404/409 with zero writes; mid-flow center switch + reload + logout/login + slow-response races; table ops; phone-hold create-in-A/claim-from-B; subscription flows with origin-center stock; **kitchen ticket from center A printing only on A's printers while B's spooler machine (if shared) still transports it correctly**; receipt/guest/kitchen/void/subscription prints with unchanged totals and JoFotara QR; admin All == A+B with drill-down scope retention; center deactivate/reactivate mid-session fails closed; **the full single→multi→single disclosure cycle**: start with MAIN only (no chrome), create GRILL (chrome appears, existing flows in MAIN unaffected), deactivate GRILL (chrome disappears, MAIN behaves as before).
- [ ] **Step 3: Architecture authority** — add center context/ownership edges to login, shift, checkout, held/phone order, table, split, subscription, refund, print (incl. printer ownership), JoFotara, remittance, dashboard, reports, public QR, and installer/bootstrap flows; add invariants (trusted scope selector; one center per transaction; printers center-owned and endpoint-unique; global seller/sequence; remittances global with line-derived attribution; progressive disclosure). Run `npm run architecture` + `npm run architecture:check`.
- [ ] **Step 4: Rollout runbook** —
  1. Checksummed application + MariaDB backup.
  2. Clone rehearsal: install the new package (or `deployment/tools/run-pending-migrations.js`), confirm preflight/apply/verify and unchanged row/financial totals.
  3. Windows sites: packaged update stops the service, replaces the payload, server applies `2026-08-17-revenue-centers-v1` at boot before listening (server.js:848-855); schema authority fails closed on mismatch.
  4. Hostinger sites: deploy the build, apply the new fallback block via phpMyAdmin in manifest order.
  5. Post-upgrade the restaurant is single-center MAIN with zero visible change. Creating additional centers is a normal in-app admin action whenever the restaurant is ready — copy catalog subtrees, create sections, create/assign that center's printers, assign users.
  6. Rollback = restore BOTH the prior app payload and the database backup. An old binary against the migrated schema boots but fails closed on every center-owned insert — never run it as a partial rollback.
  7. All pre-existing history is MAIN; copied catalog affects future operations only.
- [ ] **Step 5: Final verification**

```powershell
node scripts/validate-schema-drift.js
npx vitest run backend/tests/integration/revenueCenters.schema.test.js backend/tests/integration/revenueCenterAccess.test.js backend/tests/integration/revenueCenterCatalog.test.js backend/tests/integration/revenueCenterQrMenu.test.js backend/tests/integration/revenueCenterCheckout.test.js backend/tests/integration/revenueCenterTables.test.js backend/tests/integration/revenueCenterSubscriptions.test.js backend/tests/integration/revenueCenterRefundPrint.test.js backend/tests/integration/revenueCenterReports.test.js
npx vitest run
npm run build
npm run architecture:check
npm run test:installer
```

Diff the full suite against the recorded pre-branch baseline: zero NEW failures. `git diff --check`, `git status --short`, only intended files. Do not merge.

- [ ] **Step 6: Commit**

```text
test(revenue-centers): verify isolation and rollout readiness
```

## Risk Register — every risk owned by a task step

| Risk | Fixed by | Proof |
|---|---|---|
| Repeatable boot migrations resurrect dropped global barcode/SKU/section uniques | Task 1 Step 2 guard test reading `auto-manifest.json` repeatable files | Test fails if any repeatable file ever mentions the superseded index names |
| Boot-time migration failure blocks startup | Task 1 preflight (duplicate sections, orphan mappings) + rerunnable statements + double-apply rehearsal (Step 5) | Preflight rejects bad data before DDL; second apply proves rerunnability |
| Cross-center kitchen mapping / "editor erases mappings it didn't load" (printers.js:167/185, import.js:126) | Task 1 Step 7 parity FKs make the row unrepresentable; Task 3 Step 1 + Task 7 retire the unfiltered DELETEs | DB constraint test + import/editor tests |
| Single-slot caches (catalog, dashboard, static menu) leak across centers | Task 3 Step 4 (catalog/menu), Task 8 (dashboard key) | RED cache-poisoning tests incl. equal query strings and ETags |
| Token cache authorizes stale assignments or deactivated centers | Task 2 Steps 1/4/5 eviction paths (user edit, center CRUD, shift close, credential revocation) | Access tests assert 403 after each eviction trigger |
| Old binary writes after migration | NOT NULL no-default columns (Task 1) + runbook rule 6 | Schema test asserts no defaults; runbook forbids partial rollback |
| Multi-center chrome burdens single-center restaurants | Decision 20 + invisibility assertions in Tasks 2/3/4/7/8 and the disclosure cycle in Task 9 Step 2 | Byte-identical single-center behavior is tested, not assumed |
| Center deleted/deactivated out from under live operations | Decision 21 blocking-reasons + zero-history delete rule (Task 2 Step 4) | Lifecycle tests cover every blocking reason and the 409 list |
| Platform payouts unattributable per center | Decision 12 explicit unattributed bucket | Task 8 reconciliation equation includes the bucket |

## Plan Attack Checklist

Completion requires an evidenced yes/no for every line (test or inspected query):

- Single-center user omits the header safely only because the server finds exactly one authorized active center; with one active center NO surface ever returns `REVENUE_CENTER_REQUIRED`.
- Multi-center user omitting/forging the header gets the explicit 409/403 on POS and on the admin exceptions used by POS roles.
- Admin `all` can never create an unowned product/section/plan/expense/printer/manual subscription.
- No direct product/barcode/category/hold/table/subscription/refund/print/snapshot/printer ID crosses centers.
- A phone hold created in A cannot be listed, claimed, edited, or settled by a B-only cashier.
- A late A response cannot repaint B; localStorage cannot restore A into B.
- Service-charge claims/tokens cannot cross centers; splits can never mix centers through any operation.
- Category copy cannot create a cross-center bundle/printer/plan link.
- A kitchen ticket for center A can never print on center B's printer; the printer↔category mapping is DB-constrained to one center; no mapping editor or import path can erase another center's mappings.
- A QR customer cannot inject a product/price from another center; the static menu slice matches the table's derived center.
- Plan/sale-product/eligible-product/shift centers can never disagree; collections and redemptions enforce shift==plan center.
- A refund restores stock only in the original order's center.
- Printed totals, JoFotara seller identity, and the invoice sequence are independent of any scope; no per-center invoice numbers.
- A platform remittance balances across centers; per-center rows + the unattributed bucket reconcile to the global view; reversal signs unchanged.
- All-centers totals equal summed center totals under the same 06:00 rules; the global Z's per-center rows sum to its unchanged total.
- Center create/deactivate/reactivate/delete honors Decision 21 exactly; deactivation is blocked by each live-state reason with a named 409; delete works only on never-used centers.
- One admin/programmer account operates and reports across all centers; no per-center admin accounts exist anywhere.
- Token-cache entries never authorize a removed assignment or deactivated center after eviction.
- The migration chain applies from the exact webauthn floor, is rerunnable, has manifest/fallback parity, and the repeatable-resurrection guard test is green.
- An old server binary against the migrated database cannot write a center-owned row.
- The single→multi→single disclosure cycle shows and hides all center chrome with zero behavior change at count 1.

## What Survived, What Changed (summary for review)

**Survived from 2026-07-30:** derivation-over-duplication; the request-scope contract; header-as-selector-never-authority; MAIN backfill; immutable ownership + copy rollout; global legal/customer/template layer; scoped barcode/SKU/sections uniqueness; reconciled all-centers reporting; attack-test posture. Industry research independently confirmed the join-table membership model (Simphony operator records), soft-deactivate lifecycle, per-outlet transactional grain with rollup reporting, and keep-the-row-real single-outlet handling.

**Changed in rev 2 (user direction + research):** printers moved from global to the tenth directly-owned table with DB-enforced non-sharing and same-center mappings (Agilysys per-outlet printing pattern; Simphony's hardware/order-device split recorded as the sharing upgrade path); progressive disclosure replaces any toggle (Toast/Square invisibility + Simphony's real-but-hidden object); the center lifecycle got a create/deactivate/delete contract (Simphony soft-delete pattern + never-used hard delete); the global Z gained labeled per-center rows (Toast Z pattern); every rev-1 risk moved into the Risk Register with an owning task step and a test. Deliberate divergences from the industry: no per-center tax modes (Jordan legal stays global) and no shared physical printers (explicit requirement; endpoint uniqueness enforces it).

## Honest Risk Assessment

The dangerous work remains the schema cutover and overlooked ID-based queries, not the UI. Everything previously listed as a "known risk" now has an owning task and a failing-first test (see Risk Register). What remains genuinely open: (a) execution scale — ten owned tables touched by most selling paths means a long branch; the per-task RED/GREEN gates and the pre-branch baseline diff are the containment; (b) one database/server stays a shared failure domain by decision; (c) historical attribution beyond MAIN stays out of scope by decision. Foundation quality if executed exactly: the operational-isolation tier of the hospitality-native systems, at this codebase's size, without their configuration bureaucracy.
