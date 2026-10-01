# Revenue Centers Implementation Plan

> **For the inline executor:** REQUIRED SKILLS: `ponytail`, `executing-plans`, `test-driven-development`, `mysql`, `express-rest-api`, `vue`, `security-review`, `jofotara-invoice-integration`, and `verification-before-completion`. Work inline on `codex/revenue-centers`; do not spawn subagents, do not use brainstorming, do not merge, and do not touch unrelated untracked files.

**Goal:** Add seven-or-more revenue centers to one local POS server/database so each selling user sees and sells only the catalog, tables, subscriptions, and operational data of an authorized center, while administrators can view a reconciled all-centers dashboard and the whole installation continues to act as one legal JoFotara seller.

**Architecture:** This is revenue-center partitioning inside one restaurant installation, not SaaS multi-tenancy. A trusted request scope is resolved from the authenticated user plus `X-Revenue-Center-Id`; the header selects an authorized scope but never grants access. Nine tables own `revenue_center_id` directly. All other records derive their center through an immutable owner. One cart/order/table check belongs to exactly one center. Global legal, customer, printer, template, and configuration owners remain global unless this plan explicitly says otherwise.

**Tech Stack:** Vue 3, Pinia, Express 5, Socket.IO, mysql2, MariaDB/InnoDB, Vitest, Supertest, Playwright, the existing local print spooler, and the existing guarded SQL migration/schema-authority system.

## Executor Control Prompt

Use this prompt before every implementation task:

```text
Execute only Task N from docs/superpowers/plans/2026-07-30-revenue-centers.md on branch codex/revenue-centers. Work inline and do not spawn subagents. Read Global Constraints, the ownership matrix, and the entire task before editing. First trace every read, write, cache, restore, realtime, print, refund, and report path named by the task. For every resource answer: where does its revenue center originate, can it be client-forged, is ownership direct or derived, what happens for absent/all/foreign/inactive scope, and can cached or persisted state cross scopes? Write the stated failing tests first, run RED, implement the smallest explicit fix, run the focused GREEN checks, inspect every SQL statement changed, inspect git diff, commit only the task files, and stop. Never solve scoping with a generic repository, global mutable backend state, client body fields, duplicated revenue_center_id columns, permissive fallbacks, or per-center copies of legal configuration. If evidence contradicts the plan, stop and report it instead of improvising.
```

## Evidence and Locked Decisions

The repository currently has no branch/store/location/tenant column. Catalog, tables, shifts, orders, holds, subscriptions, reports, caches, QR drafts, and print reconstruction all assume one restaurant. The highest-risk bypasses are not the visible catalog query; they are ID-based product lookup, held-check restore, service-charge claims, table relationships, subscription redemptions, print-by-invoice, admin caches, and client-persisted carts.

The term **revenue center** matches the operational unit used by established restaurant POS products: an outlet inside one location used for access, configuration, reporting, and accounting. Oracle documents this model as an outlet within a location and separately supports assigning users access to locations/revenue centers. The security design follows OWASP's multi-tenant guidance that scope must come from authenticated authorization, be included in queries and cache keys, and never be trusted merely because a client supplied an identifier.

References:

- [Oracle Simphony revenue centers](https://docs.oracle.com/en/industries/food-beverage/simphony/19.8/simcg/c_revenue_centers.htm)
- [Oracle Simphony user access to locations and revenue centers](https://docs.oracle.com/en/industries/food-beverage/simphony-essentials/sslcg/t_people_mgmt_grant_access_pos_operations.htm)
- [OWASP Multi-Tenant Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)

Locked decisions:

1. One local server and one MariaDB database serve all centers.
2. One cart, held check, table order, split check, checkout, subscription purchase, or redemption belongs to one center. Mixed-center checks are rejected, not split silently.
3. Users and revenue centers are many-to-many. Admin/programmer roles may inspect all active and historical centers; other roles are fail-closed to explicit assignments.
4. A user has at most one open shift across all centers. The open shift's center is authoritative and cannot be switched until the shift and pending order/table state are resolved.
5. Product, category, section, plan, and historical transaction ownership is immutable. Moving live catalog data between centers means copying it as new rows, then optionally deactivating the source rows.
6. Customers remain global. A customer's subscriptions are center-owned through their plan.
7. Store settings, tax registration, order types, expense categories, printers, print templates, JoFotara credentials, JoFotara seller identity, and the public invoice sequence remain global.
8. JoFotara invoice/credit-note XML continues to use one global legal seller and one global invoice sequence. Revenue-center name is operational metadata only and must not alter the seller block or sequence.
9. Existing data is backfilled into one `MAIN` center. The migration does not guess historical center attribution. Existing mixed history, if any, requires an explicit external mapping exercise and is outside this implementation.
10. Do not add database-per-center, a generic tenant framework, repositories, query builders, per-center Socket.IO rooms, per-center print templates, per-center printer rows, or one API file per page.

## Intended Result

After implementation:

1. An administrator creates revenue centers such as Grill, Bakery, Coffee, and Desserts.
2. Existing category trees can be copied into a target center through the current category-copy workflow. Copied products receive new IDs, blank SKU/barcode, reset stock as today, and no accidental cross-center bundle or printer link.
3. The Users page assigns one or more centers to each cashier/waiter and only sections inside those centers.
4. A one-center user enters the POS without an extra prompt. A multi-center user selects a center. An existing open shift automatically restores and locks the correct center.
5. The POS catalog, barcode lookup, held orders, table floor, subscriptions, and checkout all operate only in that center. Manipulating an ID or header cannot cross the boundary.
6. Every saved order, shift, expense, hold, service-charge snapshot, and plan has durable center attribution. Refunds, item rows, collections, redemptions, QR drafts, and JoFotara documents derive it from their authoritative owner.
7. Admin `All centers` shows consolidated totals plus a center comparison. The consolidated numbers equal the sum of the center rows under the same financial rules. Selecting one center filters operational pages without changing global settings.
8. Customer and kitchen spooler payloads can bind `meta.revenueCenterName`; active templates remain valid because the binding is optional.
9. JoFotara operations show the originating center for diagnosis but submission still uses one seller profile, one legal number stream, and unchanged XML semantics.

## Ownership Matrix

### Direct center ownership

These tables receive `revenue_center_id INT NOT NULL` and a foreign key to `revenue_centers(id)`:

| Table | Why direct ownership is required |
|---|---|
| `categories` | The visible navigation tree is center-specific. |
| `products` | Category can be null; stock, availability, barcode, and SKU still need a center. |
| `sections` | Tables derive their center from a stable floor section. |
| `shifts` | A shift fixes the selling context before any order exists. |
| `expenses` | Outside expenses have no shift, so they cannot always derive ownership. |
| `orders` | Historical revenue attribution must survive later catalog/user changes. |
| `held_orders` | A hold exists before checkout and can be restored independently. |
| `service_charge_snapshots` | A draft exists before an order/hold and has token-based transitions. |
| `subscription_plans` | Manual subscriptions may have no purchase order; eligibility begins at the plan. |

### Derived center ownership

Do not duplicate `revenue_center_id` onto these tables:

| Table/domain | Derivation |
|---|---|
| `restaurant_tables`, `qr_table_drafts` | table -> section -> revenue center |
| `order_items`, `refunds`, `refund_items`, `jofotara_documents` | child -> order -> revenue center |
| `customer_subscriptions`, collections, extensions, redemptions, redemption items | subscription -> plan -> revenue center |
| `product_bundle_items`, `product_price_overrides`, `price_history` | related product/category owners; writes enforce parity |
| `subscription_plan_products`, `customer_subscription_products` | plan/subscription owner; writes enforce parity |
| `printer_categories` | mapped category owner; printer remains global |
| `audit_events` | event payload/entity identifies the center; the ledger remains global |
| `master_held`, `audit_report_documents` | one global legal/official document stream |

### Intentionally global

`settings`, `customers`, `order_types`, `expense_categories`, `printers`, `print_queue`, `print_templates`, `print_template_revisions`, `invoice_sequences`, `daily_sequences`, JoFotara settings, and permission definitions remain global.

## Request-Scope Contract

Use exactly one header: `X-Revenue-Center-Id`.

| Surface | Missing header | Numeric header | `all` |
|---|---|---|---|
| POS API, cashier/waiter/table manager | Auto-select only when exactly one active center is authorized; otherwise `409 REVENUE_CENTER_REQUIRED` | Validate active membership; attach `{ mode: 'single', id, center }` | Reject |
| POS API, admin/programmer | Auto-select only when exactly one active center exists; otherwise require a numeric selection | Validate active center | Reject |
| Admin API, admin/programmer | Default to authorized `all` for backward compatibility | Validate center and attach single scope | Attach `{ mode: 'all', id: null }` |
| Admin exception used by non-admin POS (`printers`, order detail) | Same as POS | Same as POS | Reject |
| Login/logout/system settings/public QR bootstrap | Ignore the header | Ignore the header | Ignore the header |

Rules:

- The server loads authorized centers from the database/session identity. The header is only a selector.
- Resource-by-ID reads include the derived/direct center in the query or perform a locked ownership assertion before mutation.
- `all` is a read/report scope. New center-owned resources require a concrete center. Existing-resource admin actions derive the center from the locked row.
- Missing scope never means unfiltered for a non-admin user with multiple authorized centers.
- Backend services receive an explicit `revenueCenterId`; they do not read browser state or a process-global current center.

## Global Constraints

- Work on `codex/revenue-centers`; preserve unrelated untracked files and the current master history.
- Do not execute the migration against the live development/restaurant database while implementing. Use `posapp_test` and a restored disposable database clone.
- Do not deploy any intermediate task. Old code cannot safely insert into the final no-default center columns, so deployment requires a maintenance window and an application/database backup.
- Every task is red -> minimal implementation -> green -> focused commit.
- Center-owned columns are `NOT NULL` and have no default. An overlooked insert must fail rather than silently land in `MAIN`.
- Historical rows remain immutable. Reports scope by `orders.revenue_center_id`, never by a product's current center.
- Keep one global JoFotara profile and invoice sequence. No JoFotara XML field is changed merely to carry the operational center.
- Keep printers global. Category mappings may span centers; a filtered editor must never erase mappings it did not load.
- Keep print templates global. Add an optional binding; do not clone templates per center or force the binding into active revisions.
- Keep global Socket.IO staff fanout initially. Endpoints remain authoritative; events may include `revenue_center_id` so clients can ignore irrelevant refreshes.
- Do not mass-refactor `Inventory.vue`, `PosTerminal.vue`, the order-session store, reports, or route files. Change only ownership and context seams required by this feature.
- Do not redesign browser printing, build an installer upgrader, add licensing, or add terminal/payment-provider integration.
- Do not add a hard delete for revenue centers. Deactivation preserves history.

---

### Task 1: Add the Authoritative Schema and Safe Default-Center Migration

**Files:**

- Create: `backend/migrations/2026-07-30-revenue-centers-preflight.sql`
- Create: `backend/migrations/2026-07-30-revenue-centers.sql`
- Create: `backend/migrations/2026-07-30-revenue-centers-verify.sql`
- Modify: `deployment/database/baseline.sql`
- Modify: `deployment/database/manifest.json`
- Modify: `deployment/tools/bootstrap-database.js`
- Modify: `deployment/tools/verify-install.js`
- Modify: `backend/services/schemaValidation.js`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `backend/tests/helpers/fixtures.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`
- Modify: `backend/tests/integration/installerBaseline.test.js`
- Create: `backend/tests/integration/revenueCenters.schema.test.js`
- Modify: direct SQL fixture inserts listed in Appendix A

**Schema interfaces:**

```sql
CREATE TABLE revenue_centers (
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
);

CREATE TABLE user_revenue_centers (
  user_id INT NOT NULL,
  revenue_center_id INT NOT NULL,
  PRIMARY KEY (user_id, revenue_center_id),
  KEY idx_user_revenue_centers_center (revenue_center_id, user_id),
  CONSTRAINT fk_user_revenue_centers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_revenue_centers_center FOREIGN KEY (revenue_center_id) REFERENCES revenue_centers(id) ON DELETE RESTRICT
);
```

Add direct ownership to the nine tables in the ownership matrix. Replace the global barcode/SKU unique indexes with `(revenue_center_id, barcode)` and `(revenue_center_id, sku)` so separate outlets may reuse identifiers while duplicates inside one center still fail.

Add `UNIQUE (revenue_center_id, name)` to `sections`. The preflight must report existing duplicate section names instead of silently renaming them. Category parent/root and product category composite foreign keys use `ON DELETE RESTRICT`; the existing application already detaches/soft-deactivates catalog rows, and a direct DBA hard delete should fail rather than corrupt ownership.

Add database parity where both sides already own a center:

- unique reference keys `(id, revenue_center_id)` on `categories`, `products`, `shifts`, and `service_charge_snapshots`, plus `(invoice_id, revenue_center_id)` on `orders`;
- composite category parent/root foreign keys;
- composite product -> category foreign key;
- composite order -> shift and order -> service-charge-snapshot foreign keys;
- composite expense -> shift foreign key;
- composite held-order -> parent-order and held-order -> service-charge-snapshot foreign keys;
- composite subscription-plan -> sale-product foreign key.

Application validation remains responsible for join tables whose ownership is derived (`product_bundle_items`, overrides, eligible subscription products). Product/category/plan ownership becomes immutable, so a validated relation cannot drift later.

- [ ] **Step 1: Write RED schema-authority and executable integrity tests**

Test that:

- both new tables, all nine columns, foreign keys, composite keys, and indexes exist exactly;
- no center-owned column has a default;
- duplicate barcode/SKU succeeds across two centers but fails within one center;
- cross-center category parent, product category, order shift, order snapshot, expense shift, held parent/snapshot, and plan sale product fail at the database boundary;
- `MAIN` and user assignments exist in the seeded fixture;
- the fresh installer creates one center and maps `009384` after creating the administrator.

Run:

```powershell
npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/integration/revenueCenters.schema.test.js backend/tests/integration/installerBaseline.test.js
```

Expected RED: missing revenue-center tables/columns and bootstrap seed.

- [ ] **Step 2: Write guarded preflight/apply/verify SQL**

The migration must be rerunnable after partial DDL because MariaDB DDL auto-commits:

1. Acquire the same style of advisory migration lock used by recent guarded migrations.
2. Create the two tables only when absent and verify compatible definitions when present.
3. Insert one active `MAIN` row; name it from non-empty global `store_name`, otherwise `Main Restaurant`.
4. Add the nine columns nullable and without defaults.
5. Backfill every row to `MAIN` and map every existing user to `MAIN`.
6. Detect nulls/orphans before changing columns to `NOT NULL`.
7. Discover and drop superseded single-column foreign keys through `information_schema`; do not assume deployment-specific constraint names.
8. Add the exact direct/composite constraints and scoped uniqueness.
9. Insert the migration ledger fingerprint only after every check succeeds.
10. Verify zero null owners, zero cross-center relations, exact constraints/index order, one active `MAIN`, and user coverage.

The preflight must be read-only and the verifier must end with `blocking_findings = 0` or fail. Do not infer multiple historical centers.

- [ ] **Step 3: Update fresh schema authority and fixture inserts**

Update the canonical baseline, bootstrap seed order, manifest SHA-256, startup schema fingerprint, installer verification, and every direct SQL fixture insert. Do not add `DEFAULT 1` as a test shortcut.

- [ ] **Step 4: Run GREEN and migration rehearsal**

```powershell
npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/integration/revenueCenters.schema.test.js backend/tests/integration/installerBaseline.test.js
npm run test:installer
node scripts/validate-schema-drift.js
```

Then restore a disposable copy of a current single-center database under a non-production name and run, in order, preflight -> apply -> verify. Confirm row counts and financial totals before/after are identical. Never point this rehearsal at the live `posapp` database.

- [ ] **Step 5: Commit**

```text
feat(db): add authoritative revenue center ownership
```

---

### Task 2: Establish Trusted Scope, Admin CRUD, User Assignments, and Browser Context

**Files:**

- Create: `backend/middleware/revenueCenter.js`
- Create: `backend/routes/admin/revenueCenters.js`
- Modify: `backend/routes/admin.js`
- Modify: `backend/routes/pos.js`
- Modify: `backend/routes/pos/tables.js` (move the public draft GET before the scoped POS middleware)
- Modify: all `backend/routes/pos/*.js` files to remove now-redundant route-level `requireAuth`
- Modify: `backend/routes/auth.js`
- Modify: `backend/middleware/auth.js`
- Modify: `backend/routes/admin/users.js`
- Create: `src/shared/revenueCenterContext.js`
- Create: `src/shared/revenueCenterContext.spec.js`
- Create: `src/components/RevenueCenterGate.vue`
- Modify: `src/shared/authInterceptor.js`
- Modify: `src/components/Login.vue`
- Modify: `src/App.vue`
- Modify: `src/router.js`
- Modify: `src/pos/useAuth.js`
- Modify: `src/admin/App.vue`
- Modify: `src/admin/components/AdminHeader.vue`
- Modify: `src/admin/composables/useAdminSession.js`
- Modify: `src/admin/pages/Users.vue`
- Modify: `src/admin/pages/Settings.vue`
- Create: `src/admin/components/RevenueCenterSettings.vue`
- Modify: `src/shared/i18n.js`
- Create: `backend/tests/integration/revenueCenterAccess.test.js`
- Modify: `backend/tests/integration/permissions.test.js`
- Modify: `src/utils/useAuthHydration.spec.js`

**Backend interface:**

`backend/middleware/revenueCenter.js` owns only the access seam:

```js
loadAccessibleRevenueCenters(executor, user)
resolveRevenueCenterScope(req, { surface: 'pos' | 'admin' })
requireRevenueCenter(req, res, next)
resolveAdminRevenueCenter(req, res, next)
requireConcreteRevenueCenter(req, res, next)
```

Attach one object only:

```js
req.revenueCenter = { mode: 'single', id: 4, center: { id: 4, code: 'GRILL', name: 'Grill' } };
// or, for authorized admin reads:
req.revenueCenter = { mode: 'all', id: null, center: null };
```

Do not expose a generic SQL scope builder. Each domain query remains explicit.

**Frontend interface:**

`src/shared/revenueCenterContext.js` owns two per-tab scopes:

- `pos_active_revenue_center_id`: numeric only;
- `admin_revenue_center_scope`: numeric or `all`.

It exports reactive available centers, getters/setters, hydration from `/auth/login` and `/auth/me`, scope reset, and `getRequestRevenueCenterScope()` based on the current app surface. `authInterceptor.js` clones `Headers` correctly for string URLs and `Request` objects, attaches the header only to internal authenticated APIs, and preserves caller-supplied headers.

- [ ] **Step 1: Write RED authorization/context tests**

Cover absent/single/multiple/numeric/foreign/inactive/`all` for both surfaces; confirm a client body `revenue_center_id` is ignored; confirm an assignment change invalidates the user's server session; confirm Request/Headers interception; confirm POS and admin scope keys do not overwrite one another.

```powershell
npx vitest run backend/tests/integration/revenueCenterAccess.test.js backend/tests/integration/permissions.test.js src/shared/revenueCenterContext.spec.js src/utils/useAuthHydration.spec.js
```

Expected RED: no access tables in auth payload, no middleware, no header injection.

- [ ] **Step 2: Centralize POS auth/scope without breaking the public QR bootstrap**

Register the token-verified public `GET /api/pos/table-draft/:tableId` before the parent POS auth/scope middleware. Then apply `requireAuth` and `requireRevenueCenter` once in `backend/routes/pos.js`, leaving route-specific permission middleware in subrouters. Remove duplicate subroute auth only after route-coverage tests prove no endpoint became public.

- [ ] **Step 3: Return and restore authorized centers**

Login and `/auth/me` return `revenue_centers` plus the open shift's center. Rules:

- one accessible center: auto-select;
- multiple and open shift: select/lock the shift center;
- multiple and no shift: show a center gate before POS/table data loads;
- admin dashboard: default to `all`;
- admin entering POS: require a numeric center;
- no accessible center for non-admin: deny POS access with a clear message.

Use the existing full-reload logout invariant and clear both session scopes on logout/expiry.

- [ ] **Step 4: Make user/center/section mutations atomic**

Refactor the existing user POST/PUT transaction so the user row, permission grants, center grants, and sanitized `allowed_sections` commit or roll back together. A selected section must belong to an assigned center. Admin/programmer role bypass remains explicit; waiters with no sections remain fail-closed; other roles with blank sections see all sections only inside the active center.

Reject removing the center of a user's open shift. A role change from admin/programmer to a selling role requires at least one active center assignment. Preserve immediate access revocation for other resources and invalidate the user's existing cached session entry.

Extend the verified-user token cache with the authorized center list on cache fill/login pre-warm. User assignment changes evict that user's cache entry; revenue-center create/activate/deactivate changes clear only the in-memory verified-user cache so valid cookies reload fresh access without logging everyone out. Do not add a database lookup to every scoped request and do not leave deactivated-center access cached.

- [ ] **Step 5: Add minimal center management UI**

Add a focused Settings panel for create, rename/reorder, activate, and safe deactivate. Code is uppercase and immutable after create. Do not hard-delete. Block deactivation of the final active center or a center with an open shift, open/printed table, unresolved hold/split, live service-charge state, or active subscription. Paid history and inactive catalog rows do not block deactivation.

Add center assignment and center-grouped section assignment to Users. Add a compact selector to `AdminHeader`; add the POS selector to the existing user sidebar/table header and use `RevenueCenterGate` as the safety fallback.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npx vitest run backend/tests/integration/revenueCenterAccess.test.js backend/tests/integration/permissions.test.js src/shared/revenueCenterContext.spec.js src/utils/useAuthHydration.spec.js
npm run build
```

```text
feat(auth): establish trusted revenue center context
```

---

### Task 3: Isolate Catalog, Inventory, Caches, Printer Mappings, and QR Menu

**Files:**

- Modify: `backend/routes/pos/catalog.js`
- Modify: `backend/routes/admin/products.js`
- Modify: `backend/routes/admin/categoryPriceLists.js`
- Modify: `backend/routes/admin/bundle-items.js`
- Modify: `backend/routes/admin/import.js`
- Modify: `backend/routes/admin/printers.js`
- Modify: `backend/services/categoryPriceLists.js`
- Modify: `backend/services/bundleIntegrity.js`
- Modify: `backend/config/cache.js`
- Modify: `backend/config/menuCache.js`
- Create: `backend/services/QrTableDraftService.js`
- Modify: `backend/routes/pos.js`
- Modify: `backend/routes/pos/tables.js`
- Modify: `server.js`
- Modify: `src/pos/useProducts.js`
- Modify: `src/pos/useProductsRequests.spec.js`
- Modify: `src/admin/pages/Inventory.vue`
- Modify: `src/admin/components/ProductModal.vue`
- Modify: `src/admin/components/CategoryModal.vue`
- Modify: `src/admin/components/CategoryCopyModal.vue`
- Modify: `src/admin/components/BatchProductWorkspace.vue`
- Modify: `src/admin/components/ImportModal.vue`
- Modify: `src/admin/components/CategoryPriceListModal.vue`
- Modify: `src/admin/pages/Settings.vue`
- Modify: `src/menu/MenuApp.vue`
- Create: `backend/tests/integration/revenueCenterCatalog.test.js`
- Create: `backend/tests/integration/revenueCenterQrMenu.test.js`
- Modify: existing catalog/bundle/category-copy/price-list/product tests

- [ ] **Step 1: Write hostile RED catalog tests**

Create two centers with the same barcode/SKU and differently priced products. Assert:

- list, pagination, search, barcode lookup, price resolution, availability update, category CRUD, batch create/import, bundles, and price lists never read/write the other center;
- category parent/root, bundle child, price override, and subscription-sale product cannot cross centers;
- the catalog cache for A cannot satisfy B, including equal query strings and ETags;
- admin `all` inventory is read-only and labels every row; creates/imports require a concrete center;
- printer mappings from B survive saving A's routing;
- public table QR receives only its table center and forged B product IDs are rejected/canonicalized.

```powershell
npx vitest run backend/tests/integration/revenueCenterCatalog.test.js backend/tests/integration/revenueCenterQrMenu.test.js backend/tests/integration/products.test.js backend/tests/integration/categoryCopy.test.js backend/tests/integration/categoryPriceLists.test.js backend/tests/integration/bundle.catalog.test.js src/pos/useProductsRequests.spec.js
```

Expected RED: global queries/cache and unvalidated QR cart.

- [ ] **Step 2: Scope catalog and inventory explicitly**

Every catalog query includes `revenue_center_id`. Product/category create stamps `req.revenueCenter.id`; updates/deletes load by `(id, center)`; admin all inventory may read across centers but cannot create/import until a concrete center is selected. Return `revenue_center_id`, `revenue_center_name`, and center labels only where the UI needs disambiguation.

Make product/category/plan center immutable. Do not add a move endpoint.

- [ ] **Step 3: Extend the existing category-tree copy for rollout**

Add `target_revenue_center_id` to the existing copy modal/route. Same-center copy preserves current behavior. Cross-center copy:

- locks and validates source/target centers and target parent;
- creates new categories/products in the target center;
- keeps barcode/SKU blank and current stock reset behavior;
- rejects a bundle whose component is outside the copied subtree rather than linking it across centers;
- does not copy printer-category mappings across centers;
- does not copy subscription plans;
- records both center IDs in `audit_events`.

This is the supported rollout path for splitting today's catalog without rewriting historical order/product links.

- [ ] **Step 4: Partition caches and QR drafts**

Change the single catalog cache into a small `Map` keyed by center plus the existing sales context. Keep global invalidation initially; correctness matters more than micro-optimized invalidation. Add center/all to dashboard cache later in Task 8.

Generate one static public menu payload containing active centers and center-tagged catalog slices. For a table URL, fetch/verify table metadata first, select its derived center, then render only that slice. A generic menu without a table may show an active-center chooser.

`QrTableDraftService` is the single shared owner used by the HTTP route and Socket.IO. Socket authentication joins table -> section, stores `socket.revenueCenterId`, canonicalizes `product_id`, name, price, sellability, and quantity from that center, and never persists arbitrary client price/name. Keep the existing table token gate.

- [ ] **Step 5: Preserve global printer mappings safely**

Printers remain global. The Settings printer editor must load all category mappings grouped by center (explicit admin `all` request), or update only a clearly selected center slice. Use the former unless code evidence makes it impractical. Never issue the current global `DELETE FROM printer_categories WHERE printer_id=?` after presenting only a filtered category list.

- [ ] **Step 6: Reset/race-proof frontend catalog state**

Include center ID in the `useProducts` request identity. On POS-center change, invalidate in-flight requests, clear categories/products/folder selections, and load the new center. A slow A response must not overwrite B.

- [ ] **Step 7: Run GREEN and commit**

```powershell
npx vitest run backend/tests/integration/revenueCenterCatalog.test.js backend/tests/integration/revenueCenterQrMenu.test.js backend/tests/integration/products.test.js backend/tests/integration/categoryCopy.test.js backend/tests/integration/categoryPriceLists.test.js backend/tests/integration/bundle.catalog.test.js src/pos/useProductsRequests.spec.js
npm run build
```

```text
feat(catalog): isolate revenue center inventory and menu data
```

---

### Task 4: Bind Shifts, Expenses, Service Charges, Holds, and Checkout

**Files:**

- Modify: `backend/routes/auth.js`
- Modify: `backend/routes/pos/checkout.js`
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/services/InventoryService.js`
- Modify: `backend/services/CheckoutAttemptService.js`
- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/services/HeldOrderKitchenDispatch.js`
- Modify: `backend/routes/pos/serviceCharges.js`
- Modify: `backend/services/ServiceChargeSnapshotService.js`
- Modify: `backend/routes/pos/expenses.js`
- Modify: `backend/routes/admin/expenses.js`
- Modify: `backend/services/expenseService.js`
- Modify: `src/pos/useAuth.js`
- Modify: `src/pos/stores/orderSession/orderSessionPersistence.js`
- Modify: `src/pos/posSessionStorage.js`
- Modify: `src/pos/stores/orderSessionStore.js`
- Modify: `src/pos/stores/orderSession/orderSessionApi.js`
- Modify: `src/components/PosTerminal.vue`
- Create: `backend/tests/integration/revenueCenterCheckout.test.js`
- Modify: checkout/held/service-charge/shift/expense tests
- Modify: order-session persistence/unit tests

- [ ] **Step 1: Write RED transaction-boundary tests**

Test:

- a shift opens in the selected authorized center and a second center cannot open until it closes;
- check/restore returns the open shift center and overrides stale browser selection;
- product IDs, barcode results, bundle components, price roots, table IDs, held IDs, parent orders, service-charge snapshot IDs/tokens, and subscription-plan IDs from B cannot enter an A checkout;
- an admin sale without a shift still records a concrete center;
- an idempotency retry in the original center returns the original order; the same key under another center returns a conflict, never that order;
- outside and drawer expenses are attributed correctly and drawer expense center equals shift center;
- held create/list/claim/fire/delete/restore is center-scoped;
- every service-charge state transition and child snapshot preserves center;
- stale localStorage from A is cleared before B restores a cart/table/hold/checkout-attempt.

```powershell
npx vitest run backend/tests/integration/revenueCenterCheckout.test.js backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/heldOrders.fireKitchen.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/shift.test.js backend/tests/integration/expenses.test.js backend/tests/unit/serviceChargeSnapshotService.test.js backend/tests/unit/orderSessionStore.test.js
```

Expected RED: transaction services accept only IDs and global persisted cart keys.

- [ ] **Step 2: Make shift center authoritative**

Shift open stamps the selected center after membership validation. Shift check/close/X/Z loads center. Preserve one open shift per user across all centers. Non-admin users cannot change center while a shift is open. Existing shift math remains keyed by `shift_id`; direct center predicates are defense-in-depth and report support.

- [ ] **Step 3: Thread one explicit center through checkout**

Add `revenueCenterId` to `executeCheckout` and the few cohesive services it calls. Do not copy center into the request body. Lock/filter every authoritative resource, insert `orders.revenue_center_id`, preserve it on edits/splits, and never update it later. `InventoryService.fetchCartProducts` and stock deduction require center.

Post-commit events include the center ID where known; global staff fanout remains.

- [ ] **Step 4: Stamp holds, snapshots, and expenses before they have an order**

Insert direct center at creation. All subsequent token/holder/resource transitions use `(id, revenue_center_id)`. `cleanupExpiredDrafts` may remain a global maintenance query because it deletes only terminally safe rows.

- [ ] **Step 5: Add one POS-order storage owner marker**

Add `pos_order_revenue_center_id` to the existing persistence module. Before any order snapshot restore, compare it with the numeric POS center. On absent/mismatch, call the existing complete POS order-session cleanup, then write the new marker. Do not namespace every key or create seven stores.

Block deliberate center switching while cart, active table, hold handoff, checkout attempt, service-charge snapshot, or open shift exists. Logout still performs the existing full cleanup/reload.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npx vitest run backend/tests/integration/revenueCenterCheckout.test.js backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/heldOrders.fireKitchen.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/shift.test.js backend/tests/integration/expenses.test.js backend/tests/unit/serviceChargeSnapshotService.test.js backend/tests/unit/orderSessionStore.test.js
npm run build
```

```text
feat(checkout): bind selling transactions to revenue centers
```

---

### Task 5: Isolate Tables, Dynamic Sections, Relationships, and Progressive Splits

**Files:**

- Modify: `backend/routes/pos/tables.js`
- Modify: `backend/modules/tables/saveTableOrder.js`
- Modify: `backend/modules/tables/markTablePrinted.js`
- Modify: `backend/modules/tables/tableRelationships.js`
- Modify: `backend/modules/tables/splitChecks.js`
- Modify: `backend/services/TableSettlementContext.js`
- Modify: `backend/services/TableRealtime.js`
- Modify: `src/components/TableFloorPlan.vue`
- Modify: `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify: `src/pos/stores/orderSession/tableSession.js`
- Create: `backend/tests/integration/revenueCenterTables.test.js`
- Modify: tables/bundle-table/settlement/relationship/split tests and wiring tests

- [ ] **Step 1: Write RED table attack tests**

Test that A cannot list, load, save, print-mark, clear a QR draft, settle, transfer, swap, join, disjoin, merge, split, restore a split, or void a B table/order. Include a forged `table_id`, `section_id`, `parent_invoice_id`, and held split ID. Confirm a dynamic `Dynamic` section/table is created independently per center and duplicate table numbers in different centers are allowed.

```powershell
npx vitest run backend/tests/integration/revenueCenterTables.test.js backend/tests/integration/tables.test.js backend/tests/integration/bundle.tables.test.js backend/tests/integration/tableSettlementContext.test.js backend/tests/unit/tableOrderModuleWiring.test.js backend/tests/unit/tableRelationshipModuleWiring.test.js backend/tests/unit/splitCheckModuleWiring.test.js
```

Expected RED: tables are global through sections and relationship modules accept unscoped IDs.

- [ ] **Step 2: Scope floor reads through sections**

Filter sections by center first, then intersect `allowed_sections`. Blank remains fail-closed for waiters and means all sections in the active center for permitted non-waiters. Every returned table/order carries a center ID for client guards and event filtering.

- [ ] **Step 3: Pass center through cohesive table modules**

`saveTableOrder`, `TableSettlementContext`, `markTablePrinted`, relationships, and progressive splits receive explicit center. Lock all involved tables/orders/holds and assert the same center before any mutation. Cross-center relationships are always rejected; there is no manager override.

Dynamic mode queries/creates `Dynamic` by `(revenue_center_id, name)`, not name alone. New open table orders and split holds inherit that center.

- [ ] **Step 4: Keep realtime simple and safe**

Continue using staff and section rooms. Include `revenue_center_id` in table/held/split events; clients ignore irrelevant payloads or perform a scoped refetch. Do not introduce center rooms in this phase.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx vitest run backend/tests/integration/revenueCenterTables.test.js backend/tests/integration/tables.test.js backend/tests/integration/bundle.tables.test.js backend/tests/integration/tableSettlementContext.test.js backend/tests/unit/tableOrderModuleWiring.test.js backend/tests/unit/tableRelationshipModuleWiring.test.js backend/tests/unit/splitCheckModuleWiring.test.js
npm run build
```

```text
feat(tables): enforce revenue center table boundaries
```

---

### Task 6: Bind Subscription Plans, Purchases, Credits, Collections, and Redemptions

**Files:**

- Modify: `backend/routes/admin/subscriptions.js`
- Modify: `backend/routes/pos/subscriptions.js`
- Modify: `backend/services/SubscriptionService.js`
- Modify: `backend/services/subscriptionMetrics.js`
- Modify: `backend/services/productSalesMetrics.js`
- Modify: `src/admin/pages/Subscriptions.vue`
- Modify: `src/admin/components/SubscriptionPlanModal.vue`
- Modify: `src/admin/components/SubscriptionAssignmentModal.vue`
- Modify: `src/admin/components/SubscriptionDetailDrawer.vue`
- Modify: `src/components/pos/SubscriptionModal.vue`
- Create: `backend/tests/integration/revenueCenterSubscriptions.test.js`
- Modify: subscription plan/purchase/management/collection/redemption tests

- [ ] **Step 1: Write RED subscription isolation tests**

Cover:

- plans list/create/update/deactivate and sale/eligible products;
- admin manual subscriptions without a shift;
- cashier purchase, receivable purchase, later collection/reversal, full refund/cancel;
- customer lookup returning only subscriptions redeemable in the active center while the customer identity remains global;
- one/multiple meal redemption, additional reason, stock deduction/restoration, idempotency, and kitchen void;
- shift center must equal plan/subscription center for purchase, collection, refund, and redemption;
- admin `all` may read/act on an existing subscription but cannot create a plan/manual subscription without a concrete selected center.

```powershell
npx vitest run backend/tests/integration/revenueCenterSubscriptions.test.js backend/tests/integration/subscriptionPlans.test.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/subscriptionCollections.test.js backend/tests/integration/subscriptionRedemptions.test.js
```

Expected RED: plans/products/subscription actions are globally addressable.

- [ ] **Step 2: Treat plan center as subscription source of truth**

Stamp plan center at creation. Enforce sale product and every eligible product in the same center. Plan center is immutable. Customer subscriptions, customer product snapshots, collections, extensions, redemptions, and redemption items derive through the locked subscription/plan. Do not add redundant center columns.

- [ ] **Step 3: Scope UI and financial metrics**

The admin All view labels center and disables new-plan/manual-assignment until a concrete center is selected. Existing-subscription actions derive ownership safely. POS lookup/redeem shows only the active center. Product-sales and subscription metrics accept optional admin scope without changing current money rules.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npx vitest run backend/tests/integration/revenueCenterSubscriptions.test.js backend/tests/integration/subscriptionPlans.test.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/subscriptionCollections.test.js backend/tests/integration/subscriptionRedemptions.test.js
npm run build
```

```text
feat(subscriptions): isolate plans and redemptions by revenue center
```

---

### Task 7: Protect Refunds and Spooler Printing While Keeping JoFotara Global

**Files:**

- Modify: `backend/routes/pos/refunds.js`
- Modify: `backend/services/RefundService.js`
- Modify: `backend/modules/refunds/voidOpenTableOrder.js`
- Modify: `backend/routes/print.js`
- Modify: `backend/services/ReceiptPresentationSources.js`
- Modify: `backend/services/printDocumentModel.js`
- Modify: `backend/services/printTemplateEngine.js`
- Modify: `backend/services/printTemplateDefaults.js` (fixtures/binding list only; do not rewrite active defaults)
- Modify: `backend/services/JofotaraService.js`
- Modify: `backend/routes/admin/jofotara.js`
- Modify: `src/admin/pages/JofotaraOperations.vue`
- Create: `backend/tests/integration/revenueCenterRefundPrint.test.js`
- Modify: refund, print-authz, print-unit, template-engine, and JoFotara tests
- Modify: spooler shared/unit tests only if the optional model binding reaches them; do not change transport/protocol

- [ ] **Step 1: Write RED IDOR/money/identity tests**

Assert:

- A cannot refund/void/reprint B by invoice/refund/table/held ID even with valid POS permissions;
- stock restoration affects only products belonging to the original order center;
- paid receipt, held/split receipt, guest check, kitchen ticket, void ticket, and subscription ticket reconstruct center from authoritative data;
- guest-check product IDs are revalidated/canonicalized in the selected center before money presentation;
- `meta.revenueCenterName` is sanitized and available to receipt/kitchen templates but optional;
- two accepted invoices from different centers use the same global seller settings and monotonic global invoice sequence;
- JoFotara XML seller/profile/number semantics are byte-for-byte unchanged apart from fixture IDs/dates;
- operations rows show their derived center, while pending/retry automation still processes all centers globally.

```powershell
npx vitest run backend/tests/integration/revenueCenterRefundPrint.test.js backend/tests/integration/refunds.test.js backend/tests/integration/print.authz.test.js backend/tests/unit/print.unit.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/integration/jofotara.test.js
```

Expected RED: order/refund print paths authorize roles/ownership but not revenue center; template model lacks the binding.

- [ ] **Step 2: Derive refund center only from the order**

Join/lock the order, assert scope, and reuse its center throughout refund allocation, shift validation, kitchen void, and stock restoration. Do not add a center column to refunds or refund items.

- [ ] **Step 3: Rebuild spooler documents with center metadata**

Every persisted print path obtains center from held/order/table/plan; never trust a client center/name. Add sanitized `meta.revenueCenterName` to receipt and kitchen document models and the template binding whitelist/fixtures. Existing active revisions remain valid and unchanged; the administrator may add the field in the builder later.

Reports, X/Z, category items, and Y held are not added to the receipt builder and remain on their existing spooler paths.

- [ ] **Step 4: Preserve one JoFotara seller**

Join center only to label operations/read models. Do not add per-center settings, credentials, source sequences, document counters, XML supplier fields, submission queues, or retry policies. Auto-submit remains global so a selected admin filter cannot hide unresolved legal work.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx vitest run backend/tests/integration/revenueCenterRefundPrint.test.js backend/tests/integration/refunds.test.js backend/tests/integration/print.authz.test.js backend/tests/unit/print.unit.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/integration/jofotara.test.js
npm run build
```

```text
feat(finance): protect refunds and printing across revenue centers
```

---

### Task 8: Add Reconciled Admin All-Centers Operations and Reporting

**Files:**

- Modify: `backend/routes/admin/dashboard.js`
- Modify: `backend/services/dashboardDataBuilder.js`
- Modify: `backend/services/dashboardAnalytics.js`
- Modify: `backend/config/cache.js`
- Modify: `backend/routes/admin/orders.js`
- Modify: `backend/routes/admin/shifts.js`
- Modify: `backend/routes/admin/reports.js`
- Modify: `backend/services/dailyReportBuilder.js`
- Modify: `backend/services/dailyReportDimensions.js`
- Modify: `backend/services/dailySalesDetailsBuilder.js`
- Modify: `backend/services/dailyRefundReportBuilder.js`
- Modify: `backend/services/dailyExpenseReportBuilder.js`
- Modify: `backend/services/financeMetrics.js`
- Modify: `backend/services/financialEventMetrics.js`
- Modify: `backend/services/productSalesMetrics.js`
- Modify: `backend/services/subscriptionMetrics.js`
- Modify: `backend/services/expenseService.js` and metric helpers only where scope belongs
- Modify: `backend/services/categoryItemsReportBuilder.js`
- Modify: `backend/services/yHeldItemsReportBuilder.js` only to label rows; keep Y generation global
- Modify: `src/admin/pages/Dashboard.vue`
- Create: `src/admin/components/dashboard/DashboardRevenueCenters.vue`
- Modify: `src/admin/components/dashboard/DashboardAttention.vue`
- Modify: `src/admin/components/dashboard/DashboardProducts.vue`
- Modify: `src/admin/components/dashboard/DashboardTablesNow.vue`
- Modify: `src/admin/composables/useDashboardData.ts`
- Modify: `src/admin/pages/dashboard/dashboardTypes.ts`
- Modify: `src/admin/utils/dashboardPresentation.ts`
- Modify: `src/admin/pages/Orders.vue`
- Modify: `src/admin/pages/Shifts.vue`
- Modify: `src/components/pos/ShiftReportModal.vue`
- Modify: `src/admin/pages/dailyReportPayloads.js`
- Modify: `src/admin/pages/ReportsSummary.vue`
- Modify: `src/admin/pages/ReportsSalesDetails.vue`
- Modify: `src/admin/pages/ReportsRefunds.vue`
- Modify: `src/admin/pages/ReportsExpenses.vue`
- Modify: `src/admin/components/ReportsLayout.vue`
- Modify: `src/admin/pages/TableMapEditor.vue`
- Modify: `src/admin/composables/useInventoryActivity.js`
- Modify: `src/admin/pages/WaiterPerformance.vue`
- Modify: `src/shared/i18n.js`
- Create: `backend/tests/integration/revenueCenterReports.test.js`
- Modify: dashboard/daily-report/order-stats/category/Y-held tests and frontend dashboard tests

- [ ] **Step 1: Write RED reconciliation tests**

Seed two centers with paid sales, split tender, receivables/collections, discounts, tax, service charge, partial refund, void, drawer/outside expense, subscriptions, low stock, sold out, open shifts, and tables. Assert:

- each single-center dashboard/report contains only its rows;
- all-centers financial totals equal the sum of center totals under identical business-date rules;
- the all-centers average ticket is recomputed from consolidated net revenue/order count and is not the sum or simple mean of center averages;
- refund, expense, subscription collection, and waiter attribution follows the original order/shift/plan center;
- same product names do not collapse across centers;
- dashboard cache keys distinguish `all`, A, and B;
- all-center product attention and center rows include center identity;
- official Z remains one global immutable audit snapshot; X/Z by shift naturally identifies one center;
- Y held remains one global archive/restore operation and labels center instead of filtering destructively.

```powershell
npx vitest run backend/tests/integration/revenueCenterReports.test.js backend/tests/integration/dashboard.test.js backend/tests/integration/dashboardDataBuilder.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/dailyReportsSalesDetails.test.js backend/tests/integration/dailyReportsExpenses.test.js backend/tests/integration/reportsRefunds.test.js backend/tests/integration/auditReports.test.js backend/tests/integration/yHeldItemsReport.test.js src/admin/utils/__tests__/dashboardPresentation.spec.js src/admin/pages/__tests__/dashboardLocalization.spec.js
```

Expected RED: global builders/caches have no scope or center grouping.

- [ ] **Step 2: Extend builders with one optional authorized scope**

Use signatures such as:

```js
buildDashboardData(executor, { now, revenueCenterId = null })
buildDailyReport(executor, { period, revenueCenterId = null })
```

`null` means authorized admin all only. Add explicit predicates/parameters; do not concatenate an arbitrary client value and do not build a generic scoped-query abstraction.

For the All dashboard, add grouped queries rather than calling the entire dashboard builder once per center. Return a `revenue_centers` comparison with net revenue, order count, refunds, expenses, average ticket, sold-out/low-stock count, open shifts, and active tables. The consolidated existing cards remain.

- [ ] **Step 3: Make page scope behavior explicit**

- Dashboard, Orders, Shifts, subscriptions, daily reports, waiter performance, and operational category reports support All or one center.
- Inventory All is a labeled read-only overview; select a center for create/import/category-tree changes.
- Table Map requires a concrete center.
- Settings, Users, Revenue Centers, printers, print templates, JoFotara settings/operations, customers, permissions, and official audit/Y generation remain global.
- Cached `<keep-alive>` pages watch the reactive admin scope and refetch; stale A data must clear before B/all renders.

The comparison component lets an admin click a center to set the global admin filter and drill into Orders or Inventory. Keep the current visual system; this is not a dashboard redesign.

- [ ] **Step 4: Verify query plans**

Run `EXPLAIN` on representative catalog, center/date orders, dashboard, held, shift, expense, and plan queries with realistic fixture counts. Add only indexes demonstrated necessary. At minimum evaluate:

- categories `(revenue_center_id, parent_id, is_active, id)`;
- products `(revenue_center_id, is_active, category_id, id)` and center stock alert;
- orders `(revenue_center_id, invoice_issued_at, invoice_id)` and center created-time access;
- shifts `(revenue_center_id, status, opened_at, id)`;
- expenses `(revenue_center_id, created_at, status, id)`;
- held orders `(revenue_center_id, created_at, id)`;
- plans `(revenue_center_id, is_active, id)`.

Do not delete old indexes in this feature unless `EXPLAIN` and duplicate-index analysis prove exact redundancy.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx vitest run backend/tests/integration/revenueCenterReports.test.js backend/tests/integration/dashboard.test.js backend/tests/integration/dashboardDataBuilder.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/dailyReportsSalesDetails.test.js backend/tests/integration/dailyReportsExpenses.test.js backend/tests/integration/reportsRefunds.test.js backend/tests/integration/auditReports.test.js backend/tests/integration/yHeldItemsReport.test.js src/admin/utils/__tests__/dashboardPresentation.spec.js src/admin/pages/__tests__/dashboardLocalization.spec.js
npm run build
```

```text
feat(admin): add reconciled revenue center operations
```

---

### Task 9: Attack the Complete Boundary, Update Architecture, and Prepare Rollout

**Files:**

- Modify: `docs/architecture.json`
- Regenerate: architecture outputs produced by `npm run architecture`
- Create: `docs/REVENUE-CENTERS-ROLLOUT.md`
- Create: `tests/e2e/specs/revenue-centers.spec.js`
- Modify: relevant test files only for real defects found by the attack; do not broaden architecture
- Review, expected no modification unless a failing isolation test proves otherwise: `backend/routes/admin/audit.js`, `backend/routes/admin/auditReports.js`, `backend/routes/admin/customers.js`, `backend/services/auditReportBuilder.js`, `backend/services/bundleOrderItems.js`, `backend/services/CashValidation.js`, `backend/services/expenseMetrics.js`, `backend/services/kitchenPrintRouting.js`, `backend/services/kitchenTicketItems.js`, `backend/services/OrderPricing.js`, `backend/services/PermissionService.js`, `backend/services/PosCalculator.js`, and `backend/services/shiftMetrics.js`

- [ ] **Step 1: Run the ownership audit prompt**

For every SQL occurrence of the nine directly-owned tables and every ID-based endpoint, classify it as global maintenance, authorized all, single-center predicate, or safe derivation. Search at minimum:

```powershell
rg -n --glob '!node_modules/**' --glob '!dist/**' "FROM (products|categories|sections|restaurant_tables|shifts|expenses|orders|held_orders|service_charge_snapshots|subscription_plans)|JOIN (products|categories|sections|restaurant_tables|shifts|expenses|orders|held_orders|service_charge_snapshots|subscription_plans)|UPDATE (products|categories|sections|restaurant_tables|shifts|expenses|orders|held_orders|service_charge_snapshots|subscription_plans)|INSERT INTO (products|categories|sections|shifts|expenses|orders|held_orders|service_charge_snapshots|subscription_plans)" backend server.js
rg -n --glob '!node_modules/**' "localStorage|sessionStorage|catalogPayload|dashboardAnalyticsCache|public_menu|emit\(|on\(" src backend server.js
```

No unexplained match remains. Do not mechanically add predicates to legal/global maintenance queries.

- [ ] **Step 2: Run adversarial browser workflows**

Use two users, two centers, two tabs, and direct API tampering:

1. Cashier A sees only A; Cashier B sees only B.
2. Same barcode in A/B resolves to each center's product/price.
3. Change the header/body/URL IDs to B while logged into A; expect 403/404/409 and zero writes.
4. Begin A cart/hold/table/snapshot, attempt switch to B, reload, log out/in, and race slow catalog responses.
5. Create/settle/split/transfer/merge/void tables and verify no cross-center option appears or succeeds.
6. Purchase/redeem/refund subscriptions and restore stock in the original center.
7. Print receipt, guest check, kitchen, void, and subscription ticket; confirm center binding and unchanged totals/JoFotara QR behavior.
8. Admin All total equals A+B and every drill-down retains scope.
9. Deactivate/reassign a center/user during an active session; session fails closed or is invalidated.

Add Playwright coverage for the stable critical paths; do not automate fragile visual details.

- [ ] **Step 3: Update architecture authority**

Add revenue-center context and ownership edges to login, shift, checkout, held order, table, split, subscription, refund, print, JoFotara, dashboard, reports, public QR, and installer/bootstrap flows. Run:

```powershell
npm run architecture
npm run architecture:check
```

- [ ] **Step 4: Write the deployment/rollback runbook**

Document:

1. Stop POS writes/services.
2. Take and checksum application plus MariaDB backup.
3. Restore backup to a disposable clone; run preflight/apply/verify and reconcile row/financial counts.
4. Apply migration in the restaurant maintenance window.
5. Deploy new app and start; schema authority must fail closed on mismatch.
6. Create centers, copy catalog trees, configure printer mappings, create sections/tables, assign users, and run acceptance.
7. Rollback means restoring both prior app and database backup; old code must not run against the final no-default schema.

State clearly that all pre-existing history is `MAIN`; copied catalog affects future operations only.

- [ ] **Step 5: Run final verification**

Run focused tests first, then the full suite once:

```powershell
node scripts/validate-schema-drift.js
npx vitest run backend/tests/integration/revenueCenters.schema.test.js backend/tests/integration/revenueCenterAccess.test.js backend/tests/integration/revenueCenterCatalog.test.js backend/tests/integration/revenueCenterQrMenu.test.js backend/tests/integration/revenueCenterCheckout.test.js backend/tests/integration/revenueCenterTables.test.js backend/tests/integration/revenueCenterSubscriptions.test.js backend/tests/integration/revenueCenterRefundPrint.test.js backend/tests/integration/revenueCenterReports.test.js
npx vitest run
npm run build
npm run architecture:check
npm run test:installer
npx playwright test tests/e2e/specs/revenue-centers.spec.js
```

Review `git diff --check`, run `git status --short`, confirm only intended files, and do not merge.

- [ ] **Step 6: Commit**

```text
test(revenue-centers): verify isolation and rollout readiness
```

## Plan Attack Checklist

The executor may claim completion only when every answer is evidenced by a test or inspected query:

- Can a user with one center omit the header safely? Yes, only because the server finds exactly one authorized active center.
- Can a multi-center user omit or forge the header? No; required/forbidden responses are explicit.
- Can admin `all` accidentally create an unowned product/section/plan/expense? No; concrete context is required.
- Can a direct product/barcode/category/hold/table/subscription/refund/print ID cross centers? No.
- Can an A response arrive after switching to B and repaint A? No; request identity includes center.
- Can localStorage restore A into B? No; one owner marker clears all order-session residue first.
- Can a service-charge claim/token cross centers? No; snapshot owns center from draft creation.
- Can a split/merge/transfer create mixed centers? No; every participant is locked and compared.
- Can category copy create a cross-center external bundle link? No; cross-center copy rejects it.
- Can saving a printer while viewing A erase B mappings? No.
- Can a QR customer inject a product/price from B? No; the server canonicalizes against the table center.
- Can a subscription plan/eligible meal/sale product/shift disagree? No.
- Can a refund restore stock in the selected center instead of the original order center? No; it derives from the order.
- Can printed totals or JoFotara seller identity depend on the selected admin filter? No.
- Can JoFotara issue duplicate/per-center invoice numbers? No; one global sequence remains.
- Can all-center totals differ from summed centers because of refund/expense/subscription date rules? Reconciliation tests must prove no.
- Can center deactivation strand live shifts/tables/holds/snapshots/subscriptions? It is blocked.
- Can formal Z/Y operations become partial because an admin filter is selected? No; they remain explicitly global.
- Can an old server write after the migration? No; rollout stops services and rollback restores database plus app.

## Appendix A: Direct Fixture Inserts That Must Be Updated

The no-default schema intentionally makes forgotten inserts fail. At planning time, direct fixture SQL exists in:

```text
backend/tests/fixtures/seed.js
backend/tests/helpers/fixtures.js
backend/tests/integration/adminOrdersStats.test.js
backend/tests/integration/adminRouting.test.js
backend/tests/integration/auditReports.test.js
backend/tests/integration/bundle.catalog.test.js
backend/tests/integration/bundle.heldOrders.fire.test.js
backend/tests/integration/bundle.tables.test.js
backend/tests/integration/bundleIntegrityMigration.test.js
backend/tests/integration/categoryCopy.test.js
backend/tests/integration/categoryItemsReport.test.js
backend/tests/integration/categoryPriceLists.test.js
backend/tests/integration/checkout.test.js
backend/tests/integration/dailyReportsAdversarial.test.js
backend/tests/integration/dailyReportsExpenses.test.js
backend/tests/integration/dailyReportsSummary.test.js
backend/tests/integration/dashboard.test.js
backend/tests/integration/dashboardDataBuilder.test.js
backend/tests/integration/expenses.test.js
backend/tests/integration/heldOrders.test.js
backend/tests/integration/jofotara.test.js
backend/tests/integration/openTableNumbers.test.js
backend/tests/integration/permissions.test.js
backend/tests/integration/print.authz.test.js
backend/tests/integration/printShiftReport.test.js
backend/tests/integration/productSalesMetrics.test.js
backend/tests/integration/reconciliationScan.test.js
backend/tests/integration/refunds.test.js
backend/tests/integration/reports.test.js
backend/tests/integration/reportsRefunds.test.js
backend/tests/integration/shift.test.js
backend/tests/integration/subscriptionCollections.test.js
backend/tests/integration/subscriptionManagement.test.js
backend/tests/integration/tables.test.js
backend/tests/integration/tableSettlementContext.test.js
backend/tests/integration/yHeldItemsReport.test.js
backend/tests/unit/expenseMetrics.test.js
backend/tests/unit/invoiceSequence.test.js
backend/tests/unit/orderSequence.test.js
backend/tests/unit/splitCheckModuleWiring.test.js
backend/tests/unit/tableOrderModuleWiring.test.js
```

Re-run the `rg` audit after implementation; this list is evidence from the current tree, not permission to ignore new matches.

## Honest Risk Assessment

This is a large but coherent refactor because revenue attribution touches every selling boundary. The chosen design avoids the much larger cost of generic multi-tenancy and avoids duplicating center columns through every child table. The most dangerous work is the schema cutover and overlooked ID-based queries, not the selector UI.

Expected result if the plan is executed exactly: strong future editability and operational isolation, approximately **9/10 foundation quality** for this requirement. It is not 10/10 because one local database/server is intentionally a shared failure domain, global Socket.IO fanout is intentionally retained, and old mixed historical data cannot be truthfully reclassified without external business knowledge. Those are explicit product choices, not hidden defects.
