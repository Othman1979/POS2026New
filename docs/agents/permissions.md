# Maintaining permissions

The permission lifecycle is: define the action, install its catalog entry, assign grants and scope, hydrate the authenticated employee, enforce the action against persisted state, then audit and invalidate access when it changes. A checkbox or database row alone does not implement permission enforcement.

## Owners

| Concern | Maintained source |
| --- | --- |
| Keys, bilingual labels/descriptions/examples, groups, assignable roles and preset defaults | `backend/config/permissionCatalog.json` |
| Known-key checks, role behavior, composed action requirements, section interpretation, supported approval surfaces | `backend/config/permissionPolicy.cjs` |
| Catalog SQL for fresh installation and migration generation | `backend/config/permissionCatalog.js` |
| Database-backed grants/catalog and route-facing permission predicates | `backend/services/PermissionService.js` |
| User writes, grant differences, session revocation and security audit | `backend/routes/admin/users.js` |
| Safe public user profile and stale-edit fingerprint | `backend/services/userAccessProfile.js` |
| Presets, scope selection, effective-access preview and conflict/recovery UI | `src/admin/pages/Users.vue`, `src/admin/components/UserPermissions.vue` |
| Temporary action approval | `backend/services/ManagerOverrideService.js`, checkout/table transaction modules, `src/pos/useAuth.js` |

The browser imports the pure CommonJS policy through `@posapp/permission-policy`. Keep it free of database, filesystem, HTTP, timers and session dependencies. Decisions are synchronous and add no queries. Vite must retain its linked-CommonJS development and production configuration.

## Existing business rules

Administrators/programmers have full access to known actions. Unknown keys/actions fail closed for every role. Call-center users have a fixed role with no table or cashier grants. Waiters intrinsically have `tables.access`; a stored checkbox does not remove that role behavior.

| Workflow | Required action grants |
| --- | --- |
| Cashier first table save | `tables.access` and `tables.save` |
| Waiter first table save | Intrinsic table entry and `waiter.edit_locked` |
| Later saved-table edits | `waiter.edit_locked`; other employees' orders retain their existing ownership/override checks |
| Remove unsaved draft items | Local draft operation; no saved-item void grant |
| Cancel saved items before guest bill print | `pos.void_item` |
| Cancel saved items after guest bill print | `pos.void_item` and `pos.void_printed_item` |
| Move the whole table | `waiter.transfer_table` |
| Move selected saved items | `waiter.transfer_table` and `waiter.edit_locked` |
| Counter payment | `pos.checkout` |
| Saved table or validated split payment | `pos.checkout`, or `waiter.checkout` for an actual waiter |
| Issue subscription credit | `pos.subscriptions` plus `pos.subscription_credit`, with the credit action eligible for explicit manager approval |

Kitchen printing alone does not set the guest-bill printed void restriction. These grant rules do not replace table entry, assigned sections, current persisted order state, paid-order immutability, ownership checks, revision checks, idempotency, row locks or financial/stock validation. Do not invent a blanket ownership policy: existing table actions intentionally have different ownership rules.

`users.table_access_scope` is explicit: `all`, `selected`, or `none`. Only `selected` reads the positive IDs in `allowed_sections`. Missing/unknown scope fails closed; an empty selected list grants nothing. Admin/programmer and call-center role behavior remains fixed. The scope migration translates historical blank/CSV behavior once, preserving existing access. It does not reinterpret later choices when a role changes. API updates require an explicit scope; legacy create clients retain their previous role defaults.

Cashier presets use the installation's `default_cashier` flags. The waiter preset uses code-owned `default_waiter` values, initially only saved-table editing. Selecting a preset replaces selected grants. Changing an existing operational role retains applicable custom grants and explicit scope for review. Scope and action grants are separate choices.

## Adding or changing an action

1. Define what is being authorized, including draft/saved/printed/paid state, role applicability, dependencies and ownership/section rules. Choose a stable key; renaming a key requires an explicit grant migration.
2. Add or update its catalog metadata, including both languages, a concrete example, role list, group and deliberate preset defaults. Leave new sensitive actions out of defaults unless product behavior requires them. Constants derive from keys; do not maintain a second constants list.
3. Add a composed rule in the shared policy if the action requires more than its own key. Set the catalog row's `action` and optional `action_context` when the editor must explain those dependencies. A simple action can use its permission key directly.
4. Bind the decision to the actual server mutation/read and the relevant frontend control. The server determines trusted state from locked persisted rows; never trust a client `saved`, `printed`, `tablePayment` or permission flag. Reuse the existing transaction services and authorization hydration instead of adding per-row queries or another cache.
5. Follow [database-migrations.md](database-migrations.md). Generate catalog upsert SQL using `permissionCatalogSql()`, place it in a new paired normal/automatic migration, chain the manifest/checksums, copy the exact automatic block into the manual fallback, and advance schema authority. Keep shipped migrations immutable. Existing staff grants, `default_cashier` and `overridable` installation choices survive catalog repair. Fresh bootstrap and isolated fixtures already call the same catalog SQL builder.
6. Add behavioral allow/deny tests at the API boundary and test dependencies, applicable roles, forged inputs, state transitions and denied-operation side effects. Cover fresh install/upgrade and real UI behavior when the editor or flow changes. The policy metadata contract catches missing examples/roles and unknown declared actions; it cannot prove a new endpoint was wired.

Descriptions/examples are served from code metadata. Database-backed flags remain authoritative for installation defaults and enabled approval fields. Adding a database row outside this process does not create an implemented permission.

## Editing employees safely

GET returns `edit_version`, a fingerprint of persisted profile fields and sorted stored grants. The PIN hash participates internally but is never exposed or audited. PUT locks the profile and grant rows, checks the version, writes only grant differences, audits changed access and revokes sessions atomically. Post-commit cache invalidation and socket disconnection are required. All real login, registered-browser and durable-session hydration paths carry the explicit scope.

The editor preserves a stale draft on 409 and requires an explicit reload. A lost save reply is uncertain: block another save, read the server and show the saved user before retrying. Do not claim success optimistically or switch a failed create into edit mode without the server identity/version. Login PINs remain strings so leading zeros survive.

## Manager approval

`authorizeManagerOverride({ user, managerPin, actions, executor, ... })` returns only `{ managerId, approvedActions }`. Supported actions are `pos.discount`, `pos.price_override`, `pos.subscription_credit`, `table.join` and `table.disjoin`. Arbitrary catalog `overridable` flags cannot create another approval surface.

Checkout requests its three supported adjustment fields only after an actual override is needed, intersects them with current enabled/overridable catalog rows on its existing connection, and reuses that proof within this invocation. Each gate checks its own key. The pricing helper receives only `priceOverrideApproved`; the employee object is never elevated. Join/separate request only their own action and keep the employee's section restrictions.

Checkout authority itself, tax exemption and service charge are not PIN-overridable. The temporary browser control enables only currently supported discount/price fields for five minutes; it does not provide report/admin access. Every checkout re-verifies the PIN, and no PIN is persisted in pending-checkout storage. PIN audit events describe verification outcomes; committed operation audits describe applied actions and manager identity. Preserve existing xyz audit/history rules.

## Verification and resource boundaries

Use the guarded commands in [verification.md](verification.md), never a customer database. Run database suites and browser fixtures serially. Focused checks include `permissionPolicy`, `usersAccessLifecycle`, `userAccessLifecycle`, `tableScopeLifecycle`, `cashierTableSavePermission`, `checkoutPermissionScope`, `tableAccess`, `managerOverrideCheckout`, `subscriptionPurchase`, migration/installer/schema checks, and auth/session revocation tests.

Build before `node scripts/reviews/permissions-browser.cjs`. It checks English desktop/Arabic mobile through user creation, presets, explicit scope, stale edits, lost committed replies, first save/later edit, table settlement, temporary discount approval and shift reconciliation. Run `permission-policy-browser.cjs` for actual Vite development interop. Run `permissions-resources.cjs <baseline-revision>` alone for the bounded first-save query/row/lease comparison; it shares current dependencies and is not a full historical server or customer latency benchmark.
