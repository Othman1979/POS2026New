# Call Center Phone-Order Workflow Implementation Plan

> **For custom agent `luna_max`:** Execute this plan task-by-task, in order, with mandatory RED -> GREEN TDD and Ponytail at full intensity. Do not use subagents. Do not commit, merge, push, rebuild installers, or apply migrations to a live restaurant database. After each GREEN task, stop and hand the exact diff/test evidence to the main agent. Stop immediately on any prerequisite, authorization, migration, audit, or regression failure.

**Execution branch gate:** Start from a clean `master` containing prerequisite commit `d591e915` and create/switch to `codex/call-center-held-orders` before writing a test. Never execute this plan directly on `master`. Stop if the prerequisite commit is not an ancestor, the working tree is dirty for unrelated reasons, or the manifest gate below no longer matches.

**Hard prerequisite:** Fully execute and independently approve `docs/superpowers/plans/2026-08-10-held-order-lifecycle-hardening.md` first. This plan must reuse its non-destructive claim, same-row save, explicit cancel, checkout consume, kitchen baseline, FOLLOW UP, and held-audit interfaces. Do not recreate any of those mechanisms in call-center code.

**Approved cancellation design:** `docs/superpowers/specs/2026-08-10-call-center-order-cancellation-design.md`.

**Goal:** Add a fixed `call_center` role that takes phone orders in the existing POS without a shift or payment authority, sends new calls as held orders, and can safely recall an existing phone order when the customer calls again. The worker may add/increase preparation items and explicitly send only those additions as a kitchen **FOLLOW UP**. Cashiers receive clear realtime visibility and remain the only users who finalize payment.

**Architecture:** This is a role-specific mode of the existing POS, not a second application or order model. Call center is an order source/channel; the existing order type remains fulfillment. Catalog, pricing, modifiers, customer lookup, cart, draft persistence, order types, held lifecycle, kitchen routing, print templates, Socket.IO, checkout, and Held Orders remain their current owners. No new business table, controller, repository, background worker, permission key, payment method, shift type, or fake checkout is introduced.

**Stack:** Vue 3, Pinia, Express, MariaDB/MySQL2, Socket.IO, Vitest, Supertest, Playwright, existing spooler pipeline.

## Global constraints

- Execute Tasks 1–4 strictly in order. A later task may consume only interfaces that the main agent reviewed and committed from earlier tasks and the committed lifecycle prerequisite.
- For every task: Luna writes the listed failing tests, captures RED, implements only listed scope, runs focused GREEN, inspects the complete diff, runs `git diff --check`, and stops. The main agent independently reviews/corrects/tests the slice, commits only that task with its exact message, confirms a clean tree, then authorizes the next task.
- `call_center` remains a fixed zero-permission role. Narrow role-aware endpoints are explicit exceptions, not grants.
- Never let call center checkout, touch shifts/payments/drawers/JoFotara, initial-fire kitchen, modify server-owned financial state, or access general held orders.
- Restore, save, release, FOLLOW UP, and cancellation must reuse the lifecycle service, claim/version/operation contract, trusted kitchen snapshot, queue, and held audit helper. Do not duplicate them in a call-center service.
- A call-center socket is authenticated but joins neither `staff` nor any `section:*` room. It receives no printer/table/shift/subscription/JoFotara/admin realtime payload. Do not rely on absent frontend listeners as a security wall.
- Reuse the single existing `held_orders_changed` Socket.IO event. A phone creation enriches that one event; it does not emit a second notification event.
- Preserve normal cashier, waiter, table, split, platform, subscription, refund, print, and checkout behavior.
- Do not add a business table, permission key, supervisor role, points system, new print route, or cancellation audit dashboard.

---

## Product evidence

Oracle Simphony separates **order channel** (where the order entered, including Phone in) from **order type** (where/how it is fulfilled). Oracle also treats recalled checks as the same open check and permits preparation in later rounds. Toast similarly keeps guest/employee/fulfillment/payment concerns separate and adds later selections to the existing check; after the original fire, later additions are sent as a new kitchen ticket. Sources: [Oracle order channels and types](https://docs.oracle.com/en/industries/food-beverage/simphony-essentials/sslcg/c_order_management.htm), [Oracle order channels](https://docs.oracle.com/en/industries/food-beverage/simphony/simcg/c_order_channels.htm), [Oracle open-check handling](https://docs.oracle.com/en/industries/food-beverage/simphony/sipou/c_checks_order_handling_open_checks_ug.htm), [Toast order model](https://doc.toasttab.com/doc/platformguide/platformOrdersOverview.html), [Toast adding to an existing check](https://doc.toasttab.com/doc/devguide/apiAddingItemsToACheck.html).

The owned interpretation is deliberately small:

- phone origin is source metadata, not an order type or payment method;
- the call-center worker creates or edits a normal held row;
- any worker answering the next call may recall that phone-source row through a narrow phone search;
- later preparation additions use the prerequisite's delta-only FOLLOW UP;
- payment, shift, stock deduction, receipt, and optional automatic JoFotara happen only when a cashier performs normal checkout.

---

## Approved product contract

### Fixed role with no configurable permissions

- `call_center` is a fixed role, not a permission template.
- It always has zero effective `user_permissions` and `allowed_sections=NULL`, even if stale rows or serialized grants exist.
- The Admin Users page hides permission and section editors for this role. Selecting it clears cashier defaults, grants, and sections.
- No permission key is created for call center.
- The role may use only narrow role-aware capabilities required for phone intake: authenticated catalog/modifiers/customer lookup, safe order types, create phone hold, exact-phone match, claim/update/release/cancel an existing phone-source hold, and FOLLOW UP for a previously fired phone-source hold.
- It can never checkout, open/close/read a shift, use a drawer, settle a platform, create an initial kitchen fire, print receipts/reports, manage general held orders, use tables/splits, override a manager, apply discounts/price override/tax exemption/service charge, sell/refund subscriptions, refund/void financial orders, reach admin APIs, or invoke JoFotara. Its only kitchen actions are server-derived FOLLOW UP and whole-order `cancel` for an exact phone-source hold it currently claims.
- Backend role walls are authoritative. Hidden buttons are not security.

### New phone order

1. Login routes the worker to the existing `/pos` route.
2. No shift lookup or opening modal runs. A theme-aware **New Phone Order** intake blocks the catalog.
3. The worker enters a canonical 6–20 digit phone number, a trimmed 1–100 character customer name, and one trimmed 1–500 character address. Existing customer lookup may fill name/address. Scheduled date/time is optional but, when supplied, must be valid.
4. Phone, name, and address are required before **Start Order**. **Logout** is the only escape before starting.
5. Starting unlocks the existing catalog. A compact strip shows customer identity with Edit and Cancel Call.
6. Products, quantities, modifiers, item notes, and the existing order note are allowed. Every financial/manager/table/subscription action remains absent.
7. The cart action becomes **Send Order** and works without a shift.
8. The existing checkout modal enters a call-center finalization state containing customer summary/editing, non-platform order types, order summary, and **Send as Held**. It has no payment/tender/checkout/receipt/JoFotara controls.
9. The server validates and stores a normal register held row with source set from the authenticated user. It does not fire kitchen, create an order, touch stock, or require a shift.
10. The existing 20-active-holds-per-user cap applies only to a new phone hold. Same-row continue/save never consumes another slot. A full queue returns `409 CALL_CENTER_HOLD_LIMIT_REACHED` with natural guidance to ask a cashier to clear completed holds, and preserves the draft.
11. The server ignores/rejects a client-authored reference and always serializes a phone hold as `Phone #<held id>`; customer identity remains in its owned fields, not in Socket.IO.
12. Success clears the entire phone draft and reopens intake. Failure preserves it.

### Returning customer: continue an existing phone order

1. After a valid phone number is entered, the intake offers **Find active phone orders**.
2. The backend searches only active register rows whose dedicated phone source is non-null, uses `JSON_VALID` before reading canonical `cart_data.customer_phone`, and returns at most 10 metadata matches. It does not return every hold or full carts. Phone search is a POST body with `Cache-Control: no-store`; raw phone values never enter URLs, access logs, structured logs, sockets, or audit.
3. A match shows reference, customer name, scheduled time, item count, kitchen/follow-up state, original call-center worker, and whether another terminal is editing it. If multiple active orders share the phone, the worker chooses explicitly; nothing is auto-merged.
4. **Continue order** claims the same held ID through the prerequisite lease and resends the normalized phone as proof of the selected exact-phone match before full cart/PII is returned. Any call-center worker may continue a phone-source hold; a regular non-phone hold, table/split row, platform/deferred row, or Y-only special row is never eligible. Normal cashier claim requests remain unchanged.
5. The full cart is returned only after claim succeeds. The original `call_center_user_id` remains unchanged; the audit captures the current editing worker.
6. Before the first kitchen fire, the worker may edit the order normally and choose **Save changes**. This updates the same row and releases the claim. It never fires kitchen.
   - If a cashier previously attached a server-authoritative discount, tax-exempt state, or service-charge snapshot to that same phone hold, call center may preserve it unchanged while adding products; it may not create, remove, or alter that financial state.
7. After the first kitchen fire:
   - existing sent product/modifier/note/bundle identities are read-only;
   - the worker may add new lines or increase sent quantities;
   - reductions/removals/changes to individual sent work are rejected with clear guidance to ask a cashier to void the item; whole-order cancellation remains a separate fixed-reason action;
   - **Save & send FOLLOW UP** uses the prerequisite server delta and prints only new/increased preparation quantities;
   - metadata-only changes with no kitchen delta may use **Save changes** without printing;
   - a call-center PATCH containing a positive kitchen delta reuses stable `HELD_KITCHEN_FOLLOW_UP_REQUIRED` guidance; additions are persisted only by the explicit FOLLOW UP operation, never silently by ordinary save.
8. **Cancel edits** releases the lease and returns to intake; it never deletes the held row.
   - If the 10-minute lease expires while the same worker still has the draft, **Reconnect to order** reclaims the same held ID with a fresh token and current expected version. A changed version fails closed, preserves the local draft, and refreshes the exact-phone matches; no keepalive or new endpoint is added.
9. **Cancel order** is a separate destructive action. Any call-center worker may cancel the exact phone-source row they successfully claimed, even when another worker created it. It requires an approved fixed reason code and explicit confirmation; source identity cannot be supplied by the browser.
10. An unfired cancellation creates no kitchen job. A fired cancellation reuses the prerequisite's trusted `cancel` ticket, containing the complete sent baseline—including prior FOLLOW UP quantities—and excluding unsent additions, then deletes only after queue/audit/service-charge work commits.
11. FOLLOW UP or cancellation success keeps the original source immutable, audits the current worker unless `xyz=1`, clears the local draft, and returns to intake. Failure preserves the row, draft, and actionable recovery state.
12. Cancellation cannot replay from the deleted held row after a successful response is lost. After an ambiguous network failure, rerun exact-phone matching: if that held ID is absent, treat cancellation as committed and clear local state; if present, preserve/retry the same operation. Test fired, unfired, and `xyz=1` outcomes and do not claim the DELETE endpoint itself can replay after deletion.

The narrow server interface should reuse the prerequisite resource shapes:

- `POST /api/pos/held_orders` with `{ hold_request_id, cart:{ items, customer_phone, customer_name, customer_address, delivery_date, order_note, order_type_id, ...allowed canonical cart fields }, subtotal }` for a new call-center hold. The server derives source/reference and rejects privileged fields; it does not accept a call-center-authored `reference_name`, source, lifecycle state, or financial authority.
- `POST /api/pos/held_orders/phone-matches` with `{ phone }` — call-center-only bounded metadata, `no-store`; no full cart.
- `POST /api/pos/customer_lookup` with `{ phone }` — shared POST-body lookup using the same normalizer/redaction owner. The legacy GET may delegate temporarily for normal-client compatibility, but the call-center workflow never puts phone data in a URL.
- `POST /api/pos/held_orders/:id/claim` with `{ claim_token, expected_version, phone }` for call center — the only canonical claim route. The server normalizes `phone`, compares it with the locked row, then returns the prerequisite safe cart/lease projection. Normal cashier claims keep the existing `{ claim_token, expected_version }` shape. The retired body-ID route `POST /api/pos/held_orders/claim` returns `410 HELD_CLAIM_ROUTE_RETIRED` and is never reimplemented.
- `PATCH /api/pos/held_orders/:id` with `{ operation_id, claim_token, expected_version, cart:{ items, customer_phone, customer_name, customer_address, delivery_date, order_note, order_type_id, ...existing canonical cart fields } }` — the exact prerequisite same-row versioned save/replay shape. Do not invent parallel top-level `customer` or `order_type_id` fields.
- `POST /api/pos/held_orders/:id/follow-up` with `{ operation_id, claim_token, expected_version, cart }` — server-derived exact positive delta only; may release on success.
- `POST /api/pos/held_orders/:id/release` with the prerequisite operation envelope — cancel edits/leave without deletion.
- `POST /api/pos/held_orders/:id/baseline-confirm` — always 403 for call center; legacy/unknown fired baselines require a cashier.
- `DELETE /api/pos/held_orders/:id` with `{ operation_id, claim_token, expected_version, reason_code, confirmed:true }` — allowed only for a currently claimed phone-source register row. Reason is one of `customer_changed_mind`, `duplicate_order`, `entered_in_error`, or `other_customer_request`; fired rows use the trusted cancellation ticket before deletion. A canonical request against a non-phone or otherwise unauthorized row returns 403. The retired unscoped body/query-ID delete route always returns `410 HELD_DELETE_ROUTE_RETIRED`.

Do not add a parallel `/call-center/orders` resource that duplicates held lifecycle logic.

### Cashier workflow and notification

- Cashier POS shells with `pos.hold_orders` call a minimal `GET /api/pos/held_orders/summary` returning only `{ active_register_count }` and show the authoritative count as a badge on **Held**; zero is hidden. Call center receives 403 and never calls it. Do not fetch full held carts merely to count them.
- A newly created phone hold emits the existing `held_orders_changed` event exactly once after commit with PII-free payload `{ action:'created', source:'call_center', held_order_id }`. Eligible cashier shells dedupe by held ID/action, show one toast, and refresh the count once across reconnect/focus.
- A call-center update/FOLLOW UP emits a generic changed event and refreshes counts/cards without pretending it is a second new order.
- A call-center cancellation emits one PII-free changed event after commit. Eligible cashier shells refresh once; no duplicate creation toast is shown.
- Held Orders adds an independent source filter: **All orders** / **Phone orders** for Suspended and History.
- Active Suspended cards/details show a compact source mark, original worker, latest follow-up sequence/kitchen state, and active-claim indicator. Paid History shows source/original worker only; FOLLOW UP/claim state is not persisted on `orders`, and this plan does not add duplicate history columns. The filter never changes order-type lanes.
- A cashier restores the same row using the prerequisite lifecycle, may fire the initial kitchen ticket, send later FOLLOW UP, re-save, explicitly cancel, or complete normal checkout according to existing permissions.
- Successful cashier checkout is an ordinary sale: shift/payment/stock/customer receipt/optional auto-JoFotara work as they already do. `orders.user_id` is the cashier and `orders.call_center_user_id` is the original phone source.
- Phone-source rows cannot enter platform bulk settlement or be changed into a deferred/platform type. If a cashier intentionally restores the ticket and pays it normally, it is a normal register sale as already approved.

### Data ownership

- `held_orders.id` and lifecycle version/token are the edit authority from the prerequisite plan.
- `held_orders.user_id` remains the original held-row creator and does not change when another worker/cashier edits the same row.
- `held_orders.call_center_user_id` is set only by the backend from `req.user.id` on initial call-center creation and never changes afterward.
- The prerequisite held safe projection is extended with `call_center_user_id` only. Claim-token hashes and other lifecycle secrets remain excluded from every board/search/archive/socket response.
- `orders.user_id` remains the cashier who finalized the sale.
- `orders.call_center_user_id` is copied from the locked held row during checkout; the browser never supplies it.
- Source columns are nullable `INT`, indexed, and reference `users.id` with `ON DELETE RESTRICT`. Existing rows remain `NULL`.
- Later role change/deactivation does not erase source history. Source preservation checks the FK/held row, not whether the user still currently has role `call_center`.
- The application already deactivates users rather than hard-deleting them; deactivation/role change preserves source history and atomically releases any live held claim with a version bump before session invalidation. The FK remains `RESTRICT` defense against direct database deletion. Do not invent a hard-delete API or null historical attribution.
- Phone matching remains a bounded server scan of active source-marked register holds and canonical JSON. Do not add a duplicated phone index column until measured active-hold volume proves it necessary.
- Fresh schema table count remains 48.

### Auditing

- Reuse the held-specific audit helper from the prerequisite.
- New creation, claim/restore, update, FOLLOW UP, release, cancel, and final consume are audited for ordinary actors. Cancellation records immutable original source and the current cancelling worker as separate identities.
- By explicit product rule, held lifecycle events are not written for `admin`/`programmer` actors, and `users.xyz=1` remains suppressed by the existing audit helper.
- Original phone source and current actor are separate fields in audit metadata. Never store phone/address/full cart/token/hash/PIN in the event.
- Audit is useful operational history; it is not the claim/source authority.

---

## Non-goals

- No phone-system/CTI integration, caller ID hardware, delivery dispatch, drivers, routing, maps, or address-book redesign.
- No separate call-center app, order table, permission catalog, payment method, or shift.
- No general Held Orders/history page for call-center users; recall occurs only through exact phone intake search.
- No initial kitchen fire by call center.
- No negative FOLLOW UP or partial sent-line void editor. Call center may cancel only the complete exact phone-source held order through the trusted cancellation contract.
- No cryptographic proof that a customer placed the call. Exact-phone search limits data exposure and the held audit provides staff accountability; no match-token table or phone-system integration is added.
- No platform/deferred phone-order settlement.
- No automatic JoFotara from phone hold or FOLLOW UP. Only later normal cashier checkout follows ordinary JoFotara rules.
- No redesign of the normal cashier checkout/Held Orders beyond phone-source additions.
- No installer rebuild, live migration, merge, or push during implementation.

---

## Migration authority and dependency gate

Do not start this plan until `2026-08-10-held-order-lifecycle-v1` from the prerequisite is committed, reviewed, and is the exact final entry in `backend/migrations/auto-manifest.json` with target checksum `af0234c8bce485927d509691f5b7a1445ce4e6ff6352b46822175b0165956160` and normalized SQL SHA-256 `a5ecfe94d542e5672dbc95d10877b38ceb75f10987e5e97c1720728e440b2185`.

At execution time:

1. Read the final lifecycle migration name, target checksum, and normalized SQL hash from the manifest.
2. Use that exact name/checksum as this migration's predecessor.
3. Stop if another migration has been appended in between; rebase the plan's chain rather than guessing.

Repository migration approval is a mandatory stop inside Task 1:

1. Luna writes the normal evidence migration and its RED tests only.
2. Luna stops and reports the exact SQL, predecessor, checksum proposal, and preservation evidence to the main agent.
3. The main agent independently reviews it and obtains explicit approval.
4. Only after that approval may Luna write `.auto.sql`, manifest, fallback, baseline/fixture/bootstrap/schema-validation/installer authority and run scratch upgrades. Luna then stops; the main agent reviews and commits Task 1.

Do not package an unapproved evidence migration into the automatic chain.

Proposed migration name: `2026-08-10-call-center-held-orders-v1`.

The migration must:

- append `call_center` to the existing `users.role` enum without reordering earlier values;
- add `held_orders.call_center_user_id INT NULL` plus index and `ON DELETE RESTRICT` FK;
- add `orders.call_center_user_id INT NULL` plus index and `ON DELETE RESTRICT` FK;
- preserve every user, grant, held row, order, item, shift, refund, print, subscription, audit, and migration row;
- leave existing source values `NULL`;
- write the normal evidence `.sql`, approved Hostinger-safe `.auto.sql`, ordered manifest entry, verbatim fallback block, and ledger insert last;
- update baseline/hash manifest, fixture, bootstrap ledger, schema validation, installer contracts, and architecture map;
- prove exact-predecessor upgrade, partial-additive retry, rerun/no-op, fallback parity, and row preservation on a scratch database.

---

## Task 1: Add fixed-role and source authority

**Main-agent commit:** `feat: add fixed call center role authority`

### Files

- Create `backend/migrations/2026-08-10-call-center-held-orders.sql`
- Create `backend/migrations/2026-08-10-call-center-held-orders.auto.sql`
- Modify `backend/migrations/auto-manifest.json`
- Modify `deployment/database/hostinger-manual-migrations.sql`
- Modify `deployment/database/baseline.sql`
- Modify `deployment/database/manifest.json`
- Modify `deployment/tools/bootstrap-database.js`
- Modify `backend/tests/fixtures/seed.js`
- Modify `backend/services/schemaValidation.js`
- Modify `backend/services/PermissionService.js`
- Modify `backend/middleware/auth.js`
- Modify `backend/services/ManagerOverrideService.js`
- Modify `backend/modules/checkout/executeCheckout.js`
- Modify `backend/routes/admin/users.js`
- Modify `backend/routes/admin.js`
- Modify `backend/routes/auth.js`
- Modify `backend/routes/admin/shifts.js`
- Modify `backend/routes/pos/checkout.js`
- Modify `backend/routes/pos/orders.js` in Task 1 only for the explicit platform/general-held hard wall; Task 2 owns phone operations
- Modify `backend/routes/pos/catalog.js` in Task 1 only to remove server-only settings from the browser catalog; Task 2 owns phone lookup/type filtering
- Modify `backend/routes/system.js`
- Modify authenticated mutation routes in `backend/routes/pos/tables.js`, `backend/routes/pos/serviceCharges.js`, `backend/routes/pos/subscriptions.js`, `backend/routes/pos/refunds.js`, `backend/routes/pos/expenses.js`, and `backend/routes/print.js` only where the fixed role requires an explicit wall
- Modify `server.js`
- Modify `src/pos/useSocket.js`
- Modify `src/admin/pages/Users.vue`
- Modify `src/pos/usePermissions.js`
- Modify `src/shared/i18n/runtime.js`
- Modify `src/shared/i18n/ar.json`
- Modify `backend/tests/unit/permissionService.unit.test.js`
- Modify `backend/tests/unit/automaticMigrations.test.js`
- Modify `backend/tests/unit/schemaAuthority.test.js`
- Modify `backend/tests/integration/automaticMigrations.test.js`
- Modify `backend/tests/integration/installerBaseline.test.js`
- Modify `backend/tests/integration/users.test.js`
- Modify `backend/tests/integration/auth.test.js`
- Modify `backend/tests/integration/adminRouting.test.js`
- Modify `backend/tests/integration/permissions.test.js`
- Modify `backend/tests/integration/shift.test.js`
- Modify `backend/tests/integration/checkout.test.js`
- Modify `backend/tests/integration/jofotara.test.js`
- Modify `backend/tests/integration/expenses.test.js`
- Modify `backend/tests/integration/print.authz.test.js`
- Modify `backend/tests/integration/serviceChargeSnapshots.test.js`
- Modify `backend/tests/integration/tables.test.js`
- Create `backend/tests/integration/systemSettingsRole.test.js`
- Modify `backend/tests/integration/bundle.catalog.test.js`
- Create `backend/tests/integration/socketRoleIsolation.test.js` using the installed `socket.io-client` against an ephemeral test listener
- Create `src/pos/__tests__/useSocketRoleBoundary.spec.js`
- Modify `src/admin/pages/__tests__/usersPage.quality.spec.js`
- Modify `src/admin/pages/__tests__/usersPage.bugfix.spec.js`
- Regenerate architecture only after GREEN

### RED tests first

- Migration tests require the exact lifecycle predecessor and all source/enum authority surfaces.
- User API accepts `call_center`, persists no grants/sections, rejects non-empty grant/section payloads, and clears stale rows when converting an existing user.
- Login, `/me`, token/cache rehydration, and admin user projection return `permissions:[]`, `allowed_sections:null` despite directly inserted stale grants/sections.
- A cashier with an open shift cannot be converted to call center until an admin closes it. Role conversion and every shift-open path lock the same user row in a consistent order, so concurrent requests cannot produce a call-center user with a live shift. Admin can remediate historical open shifts but cannot open a new one for call center.
- Shift action=check/open/close/zreport/update_cash, eligible cashiers, manager override route/service, drawer (`/log_drawer_pop`), `/checkout/jofotara`, `/checkout/jofotara/status`, expenses, print/printer discovery, table order read/write/delete, join/transfer/disjoin/split, service-charge, subscriptions, refunds/voids, platform settlement, and checkout all reject call center even with stale grants and a valid manager PIN.
- `GET /api/system/settings` returns only a deliberately minimal call-center presentation projection; it exposes no receipt/spooler/table/service-charge/fiscal/admin configuration. Normal-role response remains unchanged.
- Catalog returns only an explicit client-safe settings allowlist proven from current POS consumers before caching. No browser role receives JoFotara secrets/client IDs/tax identifiers, spooler/receipt infrastructure, or unrelated server-only settings; normal cashier/table catalog behavior remains unchanged.
- Call-center sockets join neither `staff` nor `section:*`, cannot request a section join, and receive no printer status, failed print count, table draft/update, shift, subscription, JoFotara, or admin operational events.
- On a shared browser, entering call-center mode clears module-scoped printer statuses/failed counts left by the prior cashier and `useSocket` cannot emit `join-section` for that role.
- Role change/deactivation while that user owns an active held lease releases the claim and bumps version atomically before session invalidation; the stale terminal cannot save afterward.
- Role change/deactivation also disconnects every live Socket.IO connection whose authenticated `socket.user.id` matches that user. A previously connected cashier socket cannot remain in `staff` after becoming call center; reconnect uses the new role and joins no privileged room.
- A direct `executeCheckout()` call rejects call center before transaction/stock/payment/audit work, including `unpaid_table`.
- Public QR table-draft read remains public and unchanged.
- Admin Users desktop/mobile role option/filter/badge/label exist; permission/section editors disappear; natural label is `Call Center` / `مركز الاتصال`.

### Implementation

1. Add `isCallCenterRole(user)` and make permission hydration/evaluation return empty/false before reading stale grants. Admin/programmer bypass remains unchanged.
2. Add a small authenticated `rejectCallCenterRole` middleware for the exact privileged entry points: standalone manager override and every auth shift action; admin printer exception and shift target/open; checkout, JoFotara submit/status, and drawer log; authenticated table/order/QR-delete/join/transfer/disjoin/split routes after the deliberately public QR read; service charge, subscriptions, refunds/voids, expenses, print, and platform settlement. Keep the direct module guard in `executeCheckout`.
3. Make role + grant/section replacement atomic. For call center, force sections null, delete grants, and release any lifecycle claim with version bump; invalidate sessions and disconnect matching live sockets after commit.
4. Reject conversion to call center while an open shift exists, with an admin-remediation message. Use the same locked user row in conversion and shift-open transactions. Exclude the role from shift targets/lists while preserving historical shift reports.
5. Harden standalone manager override and the authenticated printer exception explicitly; do not rely on hidden UI. Give call center a minimal safe `/api/system/settings` projection sufficient to render intake, and test every omitted infrastructure/fiscal key.
6. Replace the catalog's all-settings response with a strict public POS allowlist derived from current frontend consumers before building/caching the payload. Add negative fiscal/secret/infrastructure tests and positive normal POS compatibility tests.
7. In Socket.IO authentication, keep normal staff behavior unchanged but do not join call center to `staff` or `section:*`; ignore/reject its `join-section` events. No new room or event framework is required.
8. Implement the complete source migration chain only after the approval checkpoint above. Do not create a permission row or table.

### Focused GREEN verification

```powershell
npx vitest run backend/tests/unit/permissionService.unit.test.js backend/tests/unit/automaticMigrations.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/integration/automaticMigrations.test.js backend/tests/integration/installerBaseline.test.js backend/tests/integration/users.test.js backend/tests/integration/auth.test.js backend/tests/integration/adminRouting.test.js backend/tests/integration/permissions.test.js backend/tests/integration/shift.test.js backend/tests/integration/checkout.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/expenses.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/systemSettingsRole.test.js backend/tests/integration/socketRoleIsolation.test.js backend/tests/integration/tables.test.js backend/tests/integration/bundle.catalog.test.js src/pos/__tests__/useSocketRoleBoundary.spec.js src/admin/pages/__tests__/usersPage.quality.spec.js src/admin/pages/__tests__/usersPage.bugfix.spec.js
npm run architecture:check
git diff --check
```

Luna stops here. The main agent reviews for any permission key, checkout/shift bypass, broad route denial affecting normal roles, or stale-session leak, reruns verification, and commits only Task 1 before authorizing Task 2.

---

## Task 2: Add server-authoritative phone create, recall, and update

**Main-agent commit:** `feat: add call center phone order contract`

### Files

- Modify `backend/routes/pos/orders.js`
- Modify `backend/routes/pos/catalog.js`
- Create `backend/services/customerPhone.js` as the single small phone-normalization/redaction owner used by both routes
- Create `backend/tests/unit/customerPhone.test.js`
- Modify `backend/services/HeldOrderLifecycleService.js`
- Modify `backend/tests/unit/heldOrderLifecycleService.test.js`
- Modify `backend/modules/checkout/executeCheckout.js` only to copy source from the locked held row
- Modify `backend/routes/admin/auditReports.js` to preserve source through Y archive/restore and clear lifecycle claims per prerequisite
- Modify `backend/tests/integration/heldOrders.test.js`
- Modify `backend/tests/integration/heldOrders.fireKitchen.test.js`
- Modify `backend/tests/integration/checkout.test.js`
- Modify `backend/tests/integration/platformHeldSettlement.test.js`
- Modify `backend/tests/integration/yHeldItemsReport.test.js`
- Modify `backend/tests/integration/bundle.catalog.test.js`
- Modify `backend/tests/integration/users.test.js`

### RED tests first

- Call center creates a phone hold without permission/shift, with required normalized phone/name/address, non-empty cart, active non-deferred order type, and persisted draft idempotency. Formatting variants normalize predictably; invalid/oversized phone input fails before query/insert.
- On initial creation, missing identity/cart/type and every nonzero financial authority field is rejected before insert/snapshot/print. Cover top-level and nested payment/tender/checkout/manager/tax-exempt/service-charge/order-discount/line-discount/manual-price fields and forged Auto-Gratuity lines.
- On continued-order save, a server-bound discount, tax-exempt state, or service-charge snapshot may pass through only unchanged from the locked row. Any introduction, removal, or mutation is rejected; the server remains responsible for recalculation after added quantities.
- Initial source always equals authenticated call-center user. Client-supplied source is ignored/rejected. Ordinary cashier initial holds stay null.
- The 21st new phone hold returns a stable queue-full conflict with no insert/audit/socket side effect; continued same-row save remains allowed and does not inflate the count.
- Exact-phone search returns at most 10 metadata results for source-marked register holds only; it uses `JSON_VALID`, excludes ordinary, platform/deferred, table/split, and Y special rows, and does not return full cart/token/PII beyond the entered customer's match.
- Phone search uses a POST body and `no-store`; error/access/structured logging redacts phone in this route and the existing catalog customer lookup.
- Shared customer lookup accepts POST `{phone}` for the call-center client and compares canonical digits against formatted legacy customer values without rewriting customer rows. Zero matches returns no fill; multiple normalized legacy matches return a stable ambiguity response instead of guessing. No customer-table migration or duplicate phone column is introduced.
- Task 2 preserves Task 1's catalog settings allowlist while adding phone lookup/type filtering; no branch rebuilds a role-specific cache containing server-only settings.
- Call center may claim/update/release/FOLLOW-UP/cancel only a phone-source register row. It cannot list/summary/general-search/initial-fire/settle other held rows.
- A call-center claim includes the normalized phone selected by search and matches it against the locked row before returning the full safe cart; guessed ID/version input cannot reveal another customer's cart. Normal cashier claims remain unchanged.
- The prerequisite safe projection adds `call_center_user_id` only and still excludes claim hashes/lifecycle secrets. Baseline-confirm remains cashier-only.
- Any call-center worker can continue an eligible phone row; original source remains unchanged and current actor is audited. Same `operation_id` save/follow-up/release retries replay once rather than creating duplicate audit/version/queue work.
- Unfired continued order saves the same ID and releases. Fired continued order may add/increase and invoke FOLLOW UP, but cannot initial-fire or reduce/change individual sent work. Whole-order cancellation follows the approved reason/confirmation contract.
- Fired call-center PATCH is metadata-only: any positive kitchen delta reuses `HELD_KITCHEN_FOLLOW_UP_REQUIRED`; FOLLOW UP remains the only operation that persists/prints positive additions, and zero-delta FOLLOW UP remains rejected.
- No call-center hold/update creates order, stock change, payment, shift, receipt, initial kitchen ticket, JoFotara document, or service-charge snapshot.
- Order types returned to call center exclude deferred/platform types and the configured Y-report order type; normal roles receive unchanged data. Role-scoped cache authority is still enforced on the frontend later.
- Source-marked rows are rejected by platform bulk settlement/conversion.
- Cashier checkout copies source from the locked held row to `orders.call_center_user_id`; browser source input is ignored. `orders.user_id` remains cashier.
- Y archive/restore preserves phone source and resets claim fields/version safely.
- User deactivation/role change preserves historical source and releases any active claim; direct database hard delete remains restricted by FK.
- Any call-center worker can cancel a phone order created by another worker. The original source column remains unchanged; `held_order_canceled` records the cancelling actor unless their `xyz=1` suppresses held audits.
- Unfired cancellation queues nothing. Fired cancellation queues one trusted `cancel` document per original printer route with the cumulative sent baseline, excludes unsent additions, and reuses the prerequisite deterministic `held-{heldId}-cancel-{operationId}-{sentSnapshotHash}` batch identity; it then abandons the service-charge snapshot, audits when enabled, and deletes in one transaction.
- Missing/unknown reason, missing confirmation, stale claim/version, malformed or unknown kitchen baseline, missing original route, queue failure, or audit/database failure preserves the held row and returns a stable actionable error.
- Ambiguous cancellation response loss is reconciled through exact-phone matching rather than a false promise that a deleted held row can replay DELETE.
- Cancellation accepts the four fixed reason codes only; free text, phone/customer fields, client-authored source, and client-authored kitchen/printer payload are rejected before mutation.

### Implementation

1. Add a narrow `canCreatePhoneHold`/role predicate; do not make `canHoldOrders()` true for call center.
2. In initial phone hold, reuse all current product, price, bundle, modifier, tax, totals, and hold-idempotency logic from the prerequisite. Reject privileged fields before service-charge/snapshot work. On an existing claimed phone hold, preserve only the locked row's unchanged server-owned financial context so a prior cashier adjustment does not make the order impossible to continue.
3. Set source from the authenticated role only. Never accept source from request/cart/localStorage.
4. Always generate the display reference after insert as `Phone #<held id>` and reject/ignore a call-center-authored reference. Keep customer identity out of the reference and socket payload.
5. Add one pure `normalizeCustomerPhone` helper: remove presentation separators, retain a canonical digit string without guessing country-code equivalence, enforce 6–20 digits, and return only a redacted suffix for logs. Reuse it in call-center create/search and customer lookup; compare normalized legacy customer values read-only and fail ambiguous duplicates instead of rewriting them. Do not duplicate regexes.
6. Add one POST-body exact-phone metadata query against active source-marked register holds. Use `JSON_VALID`, cap results at 10, set `Cache-Control: no-store`, and require that same normalized phone on a call-center claim before returning full cart. Do not add a second hold repository or phone index column.
7. Preserve Task 1's safe catalog settings allowlist while adding the POST customer lookup and role-safe order-type filtering.
8. Extend prerequisite claim/update/release/follow-up/cancel authorization with a call-center branch limited to a currently claimed source-marked register row. Extend the central safe projection with source ID only. Reuse the existing DELETE handler and lifecycle cancellation transaction; do not create a call-center cancellation route/service. Initial kitchen fire and baseline-confirm remain forbidden.
9. Keep original source immutable. Later worker/cashier identity lives in audit, not by overwriting source/user ownership.
10. Filter deferred/platform types and the configured Y-report order type on the server, then revalidate on every create/update.
11. Derive source during final checkout from the locked row, then delete only through prerequisite consume.
12. Preserve source in Y archive/restore and user history while resetting lifecycle secrets/replay state exactly as the prerequisite requires.
13. Accept only fixed reason codes and an explicit confirmation flag for cancellation. Derive source, cancelling actor, cumulative sent snapshot, original routes, ticket payload, audit fields, and service-charge transition on the server. After an ambiguous client response, reconcile by exact-phone presence/absence.

### Focused GREEN verification

```powershell
npx vitest run backend/tests/unit/customerPhone.test.js backend/tests/unit/permissionService.unit.test.js backend/tests/unit/heldOrderLifecycleService.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/heldOrders.fireKitchen.test.js backend/tests/integration/checkout.test.js backend/tests/integration/platformHeldSettlement.test.js backend/tests/integration/yHeldItemsReport.test.js backend/tests/integration/bundle.catalog.test.js backend/tests/integration/users.test.js
git diff --check
```

Luna stops here. The main agent reviews for duplicated canonicalization, client-authored source/order type, full-hold data exposure, PII in sockets/logs, or any initial kitchen/payment side effect, reruns verification, and commits only Task 2 before authorizing Task 3.

---

## Task 3: Add the call-center POS intake and continued-order UX

**Main-agent commit:** `feat: add call center POS workflow`

### Files

- Modify `src/pos/stores/orderSession/orderSessionPersistence.js`
- Modify `src/pos/stores/orderSessionStore.js`
- Modify `src/pos/stores/orderSession/checkoutFlow.js`
- Modify `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify `src/pos/stores/orderSession/orderSessionApi.js`
- Modify `src/pos/useAuth.js`
- Modify `src/pos/useIdleTracker.js`
- Modify `src/shared/authInterceptor.js`
- Modify `src/components/PosTerminal.vue`
- Modify `src/components/pos/PosCatalogWorkspace.vue`
- Modify `src/components/pos/PosCartWorkspace.vue`
- Modify `src/components/pos/CheckoutModal.vue`
- Modify `src/router.js`
- Modify `src/pos.css`
- Modify `src/shared/i18n/ar.json`
- Create one focused component contract `src/components/pos/__tests__/callCenterWorkflow.spec.js`
- Modify `backend/tests/unit/orderSessionPersistence.test.js`
- Modify `backend/tests/unit/orderSessionStore.test.js`
- Modify `backend/tests/unit/orderSessionBoundaries.test.js`
- Modify `backend/tests/unit/checkoutFlow.test.js`
- Modify `src/components/__tests__/posTerminalOwnership.spec.js`
- Modify `src/components/pos/__tests__/checkoutSplitPayment.spec.js`
- Modify `src/shared/__tests__/i18nCatalog.spec.js`
- Create `src/shared/__tests__/authInterceptor.spec.js`
- Modify `src/admin/pages/__tests__/usersPage.quality.spec.js`

### RED tests first

- Call-center login on a shared terminal clears/ignores cashier/table/subscription/edit drafts, discount, tax exemption, service-charge snapshot, active table, held handoff, and legacy shift before generic restore runs.
- A started empty-cart phone draft persists; unstarted partially typed intake does not. User-ID mismatch/corruption clears draft.
- No shift lookup/open modal, idle shift keepalive, printer discovery, held summary/list, table, subscription, report, or platform fetch runs for call center. Idle keepalive uses `/api/auth/me` or skips the shift route.
- Intake requires phone/name/address, sends customer lookup and held matching in POST bodies, preserves deliberate manual fields on lookup miss/change, and offers bounded existing-order matches without putting the number in browser/network URLs.
- Continue order uses the prerequisite held ID/token/version context. **Cancel edits** releases without deletion. **Cancel order** opens a separate fixed-reason confirmation and invokes the lifecycle DELETE contract.
- Existing unfired action reads Save changes. A fired order shows both **Save changes** and **Save & send FOLLOW UP**; metadata-only save succeeds, while a positive-delta save receives `HELD_KITCHEN_FOLLOW_UP_REQUIRED` and directs the worker to the explicit FOLLOW UP action. Sent-line reductions/changes show cashier guidance.
- The pure call-center command policy exposes safe order types and Send as Held only and has no mapping to `processCheckout()`; actual Enter/hidden-handler runtime behavior is a Task 4 browser assertion.
- All tables/table-splits/history/setup/report/shift/discount/price/tax/service/subscription/manager/print controls are absent even with stale grants/state. Direct `/tables`, `/table-splits`, and `/order-notes` return to `/pos`.
- After hold/FOLLOW-UP/cancellation success, logout, session expiry, or operational reset, no source/customer/cart/claim/type survives into the next phone order. The shared 401 interceptor invokes the canonical POS-session cleanup before redirect. Ordinary network failure preserves current work; ambiguous cancellation failure reconciles by exact-phone presence/absence.
- An expired 10-minute claim offers **Reconnect to order** using a fresh token against the same held ID/current version. A version conflict preserves the draft and refreshes matches; it never overwrites the row.
- Order-type cache is role-scoped or invalidated on role change so cashier platform types never appear to a later call-center session.
- Task 3 Vitest proves pure store/API/session policy and source ownership only. It does not claim to mount Vue or prove computed layout in the Node test environment; light/graphite, RTL/LTR, 1024x768, mobile, request timing, keyboard, and hidden-handler behavior are proved by Task 4 Playwright.

### Implementation

1. Extend the existing versioned order context with call-center intake mode and the prerequisite held lease context. Do not create another localStorage namespace/store.
2. Authenticate role before any generic draft/shift restore. Call center restores only its matching phone context and starts with `activeShift=null`.
3. Reuse existing customer fields, lookup, keypad, catalog, modifiers, item notes, order note, order types, totals, and checkout modal. Add role-specific states rather than a second modal stack.
4. Add a compact phone-match result state to intake. Claim only after explicit Continue selection and pass the normalized searched phone with the claim. Reuse a single client claim-token generator/persistence path for initial claim and reconnect; do not duplicate token logic in components.
5. Use prerequisite save/release/follow-up/cancel APIs and labels based on server kitchen state/delta. Do not calculate source or kitchen delta in Vue.
6. Keep **Cancel edits** as release-only. Add **Cancel order** only in an actively restored phone-source context; require one fixed natural-language reason and explicit confirmation, and leave all kitchen/audit payload construction to the server. On an ambiguous response, rerun exact-phone matching before deciding whether to clear or preserve the draft.
7. Skip shift/report/printer/table/subscription initialization and make router/usePermissions fail closed before stale grant evaluation.
8. Scope or invalidate the existing order-type cache on role change. After phone success, do not apply a configured deferred default.
9. Add concise natural translations: Call Center / مركز الاتصال, New Phone Order / طلب هاتفي جديد, Start Order / بدء الطلب, Send Order / إرسال الطلب, Send as Held / حفظ كطلب معلّق, Find active phone orders / البحث عن طلب هاتفي قائم, Phone orders / الطلبات الهاتفية, Continue order / متابعة الطلب, Save changes / حفظ التعديلات, Save & send FOLLOW UP / حفظ وإرسال إضافة للمطبخ, Cancel Call / إلغاء المكالمة, Cancel edits / إلغاء التعديلات, Cancel order / إلغاء الطلب, Order cancelled / تم إلغاء الطلب, New phone order received / وصل طلب هاتفي جديد, Original call-center worker / مُنشئ الطلب الهاتفي, Another employee is editing this order / موظف آخر يعدّل هذا الطلب الآن, Editing session expired / انتهت مهلة التعديل, Reconnect to order / إعادة فتح الطلب, and natural queue-full/cashier-guidance messages, plus the four fixed cancellation-reason labels exactly as defined in the approved design.

### Focused GREEN verification

```powershell
npx vitest run backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderSessionBoundaries.test.js backend/tests/unit/checkoutFlow.test.js src/components/__tests__/posTerminalOwnership.spec.js src/components/pos/__tests__/callCenterWorkflow.spec.js src/components/pos/__tests__/checkoutSplitPayment.spec.js src/shared/__tests__/authInterceptor.spec.js src/shared/__tests__/i18nCatalog.spec.js src/admin/pages/__tests__/usersPage.quality.spec.js
npm run build:admin
git diff --check
```

Luna stops here. The main agent inspects all new-order/role-change/refresh/logout boundaries and both themes, confirms normal cashier, waiter, table, split, subscription, platform, and checkout UI remain unchanged, reruns verification, and commits only Task 3 before authorizing Task 4.

---

## Task 4: Surface phone orders and prove the real workflow

**Main-agent commit:** `feat: surface call center held orders`

### Files

- Modify `backend/routes/pos/orders.js` for the count-only summary and source joins only
- Modify `backend/tests/integration/heldOrders.test.js`
- Modify `src/components/OrderNotes.vue`
- Modify `src/components/OrderNoteCard.vue`
- Modify `src/components/PosTerminal.vue`
- Modify `src/components/pos/PosCartWorkspace.vue`
- Modify `src/pos/stores/orderSession/orderSessionApi.js`
- Modify `src/utils/orderNotesBoard.js` only if one pure source-filter helper is genuinely clearer
- Modify `src/utils/orderNotesBoard.spec.js`
- Modify `src/components/__tests__/posTerminalOwnership.spec.js`
- Modify `src/components/__tests__/tableFloorPlanDesignContract.spec.js`
- Modify `src/components/pos/__tests__/callCenterWorkflow.spec.js`
- Modify `src/shared/__tests__/i18nCatalog.spec.js`
- Modify `tests/e2e/global.setup.js`
- Modify `playwright.config.mjs`
- Create `tests/e2e/specs/call-center.holds.spec.js`
- Regenerate `docs/architecture.json` and `docs/architecture.html`

### RED tests first

- Active and history projections join original call-center source separately from creator/cashier.
- Source filter works independently of order type in Suspended and History.
- Active cards/details show source worker, kitchen/follow-up state, and active claim only for phone rows; paid History shows source/original worker without invented lifecycle state.
- `GET /api/pos/held_orders/summary` returns only `{active_register_count}` to eligible cashier/admin roles. Zero badge is hidden; call center receives 403 and never requests the summary or general board.
- One enriched `held_orders_changed` phone-created event yields one toast and one refresh. Generic updates refresh without duplicate “new phone order” toast. Listener lifecycle is idempotent across keep-alive/reconnect/focus.
- Socket payload has no phone/name/address/cart.
- A call-center socket is absent from `staff`/`section:*` and receives no printer/table/shift/subscription/JoFotara/admin operational event; eligible cashier sockets still receive unchanged normal events.
- In the real checkout modal, Enter and every hidden/shared click handler issue no checkout, payment, drawer, receipt, or JoFotara request in call-center mode.

### Required real browser workflow

1. Create a call-center user in Admin Users; verify no permissions/sections and no shift eligibility.
2. Login call center on a shared browser containing stale cashier grants, draft, active table, and shift; land on clean intake with no shift modal.
3. Create a new phone hold with customer, schedule, modifiers, item note, and order note. Verify no order/stock/payment/kitchen/receipt/JoFotara side effects.
4. While the call-center final modal is open, press Enter and probe every shared/hidden completion action; assert zero checkout/payment/drawer/receipt/JoFotara requests and no order creation.
5. A cashier context receives one toast and Held badge; Phone orders filter shows source worker.
6. Fire the original ticket as cashier, then release the row.
7. In call-center intake, search the same phone, continue the exact held ID, add a new product and increase another, then Save & send FOLLOW UP.
8. Inspect backend queue/compiled document: only positive delta lines appear, heading is visible, sequence is correct, source remains original, and audit actor is the second worker.
9. Retry after simulated response loss; no duplicate queue or follow-up sequence appears.
10. Attempt a sent-line reduction/change; receive cashier guidance and preserve the row. Cancel edits; row remains. Reopen, save metadata only, and prove no kitchen ticket.
11. Let the lease expire, reconnect the same held ID, and continue. Then force a version conflict and prove the local draft survives while the authoritative match refreshes.
12. Worker B restores an unfired phone hold created by Worker A, chooses a fixed reason, confirms cancellation, and returns to clean intake. No kitchen job exists; audit shows Worker A as source and Worker B as actor.
13. Lose the successful cancellation response. Exact-phone reconciliation sees the held ID absent and clears the draft without a duplicate DELETE/audit; repeat for fired cancellation and `xyz=1`.
14. Repeat cancellation with Worker B set to `xyz=1`; deletion succeeds and no held cancellation audit is written.
15. Fire another phone hold, add one unsent item, then cancel it from call center. Queue inspection shows `إلغاء الطلب / ORDER CANCELLED` on each original route with the complete sent baseline—including prior FOLLOW UP quantities—and excludes the unsent item.
16. Force missing reason, stale claim, malformed baseline, missing route, and queue failure; each preserves the restored row and draft.
17. Cashier restores a separate phone row and completes normal cash checkout. Held row disappears only after commit; `orders.user_id` is cashier and `orders.call_center_user_id` is original source. Force checkout failure first and prove recovery.
18. Direct call-center checkout, `/checkout/jofotara`, JoFotara status, shift, manager, drawer, expenses, arbitrary print/printer, table/split, subscription/refund, platform, canonical delete of a non-phone/general held row, and admin probes remain 403. The separately retired unscoped held claim/delete shapes return their specified 410 codes for every role.
19. Verify ordinary held orders, table holds, platform holds, normal checkout, item void tickets, and normal kitchen tickets are unchanged.
20. At 1024x768/mobile in light and graphite, intake, match list, continued-order state, customer strip, FOLLOW UP/cancellation actions, reason confirmation, toast, badge, filter, and cards have readable computed colors and no overflow/clipping.

### Final verification

```powershell
npx vitest run --reporter=dot backend/tests/unit/customerPhone.test.js backend/tests/unit/permissionService.unit.test.js backend/tests/unit/automaticMigrations.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/integration/automaticMigrations.test.js backend/tests/integration/installerBaseline.test.js backend/tests/integration/users.test.js backend/tests/integration/auth.test.js backend/tests/integration/adminRouting.test.js backend/tests/integration/permissions.test.js backend/tests/integration/shift.test.js backend/tests/integration/expenses.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/systemSettingsRole.test.js backend/tests/integration/socketRoleIsolation.test.js backend/tests/integration/tables.test.js backend/tests/integration/bundle.catalog.test.js src/pos/__tests__/useSocketRoleBoundary.spec.js
npx vitest run --reporter=dot backend/tests/unit/heldOrderLifecycleService.test.js backend/tests/unit/heldOrderKitchenDispatch.test.js backend/tests/unit/kitchenPrintRouting.test.js backend/tests/unit/kitchenTicketItems.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/printJobIdentity.test.js backend/tests/unit/printDocumentModel.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/heldOrders.fireKitchen.test.js backend/tests/integration/checkout.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/platformHeldSettlement.test.js backend/tests/integration/yHeldItemsReport.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/tableOrderPostCommit.test.js
npx vitest run --reporter=dot backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderSessionBoundaries.test.js backend/tests/unit/checkoutFlow.test.js src/admin/pages/__tests__/usersPage.quality.spec.js src/admin/pages/__tests__/usersPage.bugfix.spec.js src/components/__tests__/posTerminalOwnership.spec.js src/components/__tests__/tableFloorPlanDesignContract.spec.js src/components/pos/__tests__/callCenterWorkflow.spec.js src/components/pos/__tests__/checkoutSplitPayment.spec.js src/utils/orderNotesBoard.spec.js src/shared/__tests__/authInterceptor.spec.js src/shared/__tests__/i18nCatalog.spec.js
npx playwright test tests/e2e/specs/call-center.holds.spec.js --project=call-center-tests
npx playwright test tests/e2e/specs/held-order-lifecycle.spec.js --project=held-order-lifecycle-tests
npm --prefix pos-spooler-printer test
npm run architecture:check
npm run build:admin
git diff --check
git status --short
```

Luna stops after reporting the complete Task 4 diff and final evidence. The main agent must not merely infer from passing tests: inspect the final manifest chain/fallback parity, schema table count 48, zero call-center grants/sections, route hard walls, source derivation, claim/version use, same-row identity, audit suppression, socket PII/isolation, deterministic FOLLOW UP queue identity, both themes, and all normal cashier paths. Only then may the main agent commit Task 4. Do not merge or push without a later explicit user request.

---

## Final adversarial attack results

This revision removes the earlier plan's destructive-claim/localStorage source handoff. Source is now server-authored on a durable row, and recall/update/follow-up reuse the prerequisite lifecycle.

Rejected designs:

- **Give call center `pos.hold_orders`:** rejected because it exposes general list/claim/fire/delete/platform powers.
- **Create a call-center app/table/API stack:** rejected as duplicate catalog/pricing/cart/held ownership.
- **Fake payment or zero-value checkout:** rejected because call center collects no money and must not pollute shifts/reports/JoFotara.
- **Use order type to mean phone:** rejected because source channel and fulfillment are separate.
- **Delete on recall and carry source in localStorage:** rejected because it loses server recovery and lets browser state masquerade as authority.
- **Let call center browse every hold:** rejected; exact-phone metadata search is sufficient and reduces PII exposure.
- **Overwrite original source when another worker helps:** rejected; audit captures the current actor while source remains the first phone origin.
- **Require the source user's current role forever:** rejected because deactivation/role change must not invalidate historical attribution.
- **Let call center initial-fire or edit individual sent work:** rejected; its narrow whole-order cancellation is a separate trusted action with fixed reason, audit attribution, and cancellation ticket.
- **Calculate FOLLOW UP in Vue:** rejected; only server baseline/canonical cart can prevent duplicates and forged deltas.
- **Add a phone index before evidence:** rejected; bounded active source-marked JSON search is adequate for current restaurant scale and easier to own.
- **Rely only on hidden UI:** rejected; direct route/module tests pin every fixed-role wall.

This revision is execution-ready only after re-reading the committed prerequisite manifest entry at handoff and passing the repository's explicit migration-approval checkpoint. It incorporates the final destructive-restore, replay/reconciliation, legacy-baseline, explicit-FOLLOW-UP, PII, direct-route, Y-archive, socket-isolation, catalog-secret, and printer-ownership attacks. The plan itself performs no call-center implementation, migration, live database mutation, printer job, installer build, merge, or push.
