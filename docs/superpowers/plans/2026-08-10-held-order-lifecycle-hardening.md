# Held-Order Lifecycle Hardening Implementation Plan

> **For Luna:** Execute this plan task-by-task, in order, with mandatory RED -> GREEN TDD and Ponytail at full intensity. Do not merge, push, rebuild installers, or apply migrations to a live restaurant database. Commit each task separately using its exact commit message and stop on any predecessor, transaction, print-idempotency, or regression failure.

**Approved cancellation design:** `docs/superpowers/specs/2026-08-10-call-center-order-cancellation-design.md`. This prerequisite owns the generic atomic cancellation and trusted kitchen-ticket mechanism. The dependent call-center plan adds only its narrow role authorization and UI.

**Goal:** Make an ordinary register held order a durable open order: recalling it must never delete it; only a committed final checkout, an explicit confirmed cancellation, or the existing transactional Y-report archive may remove the row. Add safe multi-terminal editing, same-row saves, delta-only kitchen follow-ups, and held-lifecycle audit events without creating another order table or a second printing stack.

**Architecture:** `held_orders` remains the only active register-hold authority. A short server-owned lease prevents two terminals from editing the same row, a monotonically increasing version prevents stale saves, and the existing checkout transaction consumes the row only after the sale commits. Existing pricing, bundle, modifier, service-charge, kitchen-routing, print-queue, template, audit, and draft-persistence owners are reused. No controller, repository, background worker, claims table, kitchen-round table, or generic workflow framework is added.

**Stack:** Vue 3, Pinia, Express, MariaDB/MySQL2, Socket.IO, Vitest, Supertest, Playwright, existing print template engine and spooler.

## Global constraints

- Execute Tasks 1–4 strictly in order. A later task may consume only committed interfaces from earlier tasks.
- For every task: write the listed failing tests, run them and capture the intended RED, implement only the listed scope, run the focused GREEN command, inspect the complete task diff, run `git diff --check`, then commit the exact task message.
- Preserve normal cashier, table, split, platform, subscription, service-charge, receipt, JoFotara, and existing kitchen normal/void behavior.
- Do not create a second order authority, cancellation service stack, controller/repository layer, background worker, business table, print route, or retry daemon.
- Never trust browser source identity, kitchen baseline, printer routing, claim authority, version, or cancellation payload.
- Never delete an ordinary held row on restore, save, release, failed checkout, failed cancellation, or failed print-queue insertion.
- Do not proceed to the call-center plan until this plan is committed, independently reviewed, and its migration is the exact manifest tip.

---

## Why this prerequisite is required

The current ordinary restore path is destructive:

- `POST /api/pos/held_orders/claim` locks the row and then deletes it before the cashier reaches checkout.
- A lost response, browser crash, validation failure, declined checkout, or missing shift after that commit leaves no server-held order to recover.
- Re-holding always inserts a new row, so a lost save response can create duplicates and the held identity changes.
- A restored order is remembered only by its human reference string; no held ID, version, lease, or server kitchen baseline survives.
- `kitchen_fired` is only a boolean. After an original kitchen fire, later additions are either skipped or risk reprinting the whole cart.
- Held kitchen queue insertion currently uses the global pool while the held row is changed on another connection, so queue and row state can diverge.
- Restore, save, fire, cancel, and consume have no complete held-lifecycle audit trail.

These are correctness gaps in the current held-order foundation, not call-center-specific behavior. The call-center plan at `docs/superpowers/plans/2026-08-10-call-center-held-orders.md` must not execute until this plan is complete.

---

## External product evidence and owned interpretation

Oracle Simphony treats a guest check as an open check that can remain open while the operator sends preparation work in service rounds. **Send and Stay** sends the current round, keeps the check open, and allows more items to be added and sent later. Previously sent items are treated as an earlier round rather than recreated as a new check. Oracle also exposes held checks through pick-up lists and applies role-controlled ownership/transfer behavior. Sources: [Oracle open-check order handling](https://docs.oracle.com/en/industries/food-beverage/simphony/sipou/c_checks_order_handling_open_checks_ug.htm), [Oracle Send and Stay](https://docs.oracle.com/cd/F32325_01/doc.192/f32329/t_checks_send_mi_kds_check_open_ug.htm), [Oracle check transfers](https://docs.oracle.com/en/industries/food-beverage/simphony/sipou/c_checks_transfers.htm), [Oracle Pick Up Check](https://docs.oracle.com/en/industries/food-beverage/simphony-essentials/simsl/t_check_func_pick_up_check.htm).

Toast likewise supports adding selections to an existing check, requires unique selection identifiers to prevent duplicate additions, and sends additions made after the original fire on a new kitchen ticket. Toast's server item firing model distinguishes held items, previously sent items, and newly added items; it does not consolidate multiple preparation rounds into one pretend-original ticket. Sources: [Toast add items to an existing check](https://doc.toasttab.com/doc/devguide/apiAddingItemsToACheck.html), [Toast add-items API](https://doc.toasttab.com/openapi/orders/operation/ordersOrderGuidChecksCheckGuidSelectionsPost/), [Toast server item firing](https://support.toasttab.com/en/article/Using-Server-Item-Firing?lang=en_US), [Toast multi-round kitchen tickets](https://support.toasttab.com/en/article/Reprint-a-Kitchen-Ticket-With-All-Items-Sent-at-Different-Times), [Toast void behavior](https://support.toasttab.com/en/article/Voiding-Items-Payments-and-Checks).

The implementation should copy these operational ideas, not their internal architecture:

- one durable open/held identity;
- one active editor at a time;
- server-visible rounds/baselines;
- only newly added or increased preparation quantities on a follow-up ticket;
- sent-line reductions require an explicit cancellation/void path, never a negative FOLLOW UP;
- failed/uncertain physical prints remain visible for human resolution and are never silently retried.

---

## Approved lifecycle contract

### One held row, one identity

- Initial hold creation inserts one `held_orders` row and returns its numeric ID, reference, version, and current kitchen state.
- A caller-generated UUID `hold_request_id`, persisted with the draft, makes initial creation idempotent within the authenticated creator. Retrying the same committed request with the same canonical payload returns the same row rather than inserting a duplicate; reusing it with different content returns `HELD_OPERATION_CONFLICT`.
- Recall/restore never deletes the row.
- Saving a recalled order updates that same ID using an expected version; it never creates a replacement row.
- Every mutating request after creation carries a draft-persisted UUID `operation_id`. The row stores only the last successful operation ID, kind, and a small non-PII result envelope. If a response is lost, the same operation replays that result without changing the version, queue, or audit twice; an old operation arriving after a later mutation receives a stable conflict.
- A human reference is display text only. It is never the identity, scope key, concurrency key, or source authority.

### One active editor lease

- The client creates one cryptographically random opaque claim token before requesting a claim and persists it in the existing order-context record.
- The database stores only its SHA-256 hash, the claimant user ID, expiry, and current version. Never log, audit, or return the stored hash.
- Claim uses `SELECT ... FOR UPDATE`:
  - an available or expired row can be claimed;
  - the same user and token retry is idempotent;
  - another unexpired claimant receives a stable 409 with non-PII claimant metadata;
  - a stale version receives a stable conflict and current metadata for refresh.
- Use one code-owned ten-minute lease measured from database UTC and return its absolute expiry. No setting, heartbeat worker, cleanup job, or claims table is introduced. Successful save/follow-up renews or releases it; a crash becomes recoverable after expiry. Tests inject time rather than sleeping.
- Fire, update, cancel, checkout, platform settlement, and Y archive must respect an active lease. A different terminal cannot mutate or fire a row being edited.

### Exact operation envelope

- The only canonical claim API is `POST /api/pos/held_orders/:id/claim` with `{ claim_token, expected_version }`. It returns a safe held projection containing `id`, reference, version, claim expiry, kitchen state, canonical cart, and warnings. It never returns `claim_token_hash`, last-operation JSON, full user records, or another terminal's token. The old `POST /api/pos/held_orders/claim` body-ID shape must return `410 HELD_CLAIM_ROUTE_RETIRED`; it may not delegate to the former destructive behavior.
- Save, release, cancel, initial fire, baseline acknowledgement, and FOLLOW UP accept `{ operation_id, claim_token, expected_version, ...actionFields }`. IDs are validated UUIDs with stable size limits.
- Cancellation accepts exactly `{ operation_id, claim_token, expected_version, reason_code, confirmed: true }`. `reason_code` must be one of `customer_changed_mind`, `duplicate_order`, `entered_in_error`, or `other_customer_request`; unknown codes, free text, and missing confirmation fail before queue/audit/delete work.
- A board-level initial fire may operate on an unclaimed row using `operation_id + expected_version`; it locks the row and rejects an unexpired claim owned by anyone. If the row is already claimed by the same terminal, token validation is required.
- Board-level cancellation first acquires a claim, then uses the same confirmed canonical `DELETE /api/pos/held_orders/:id` contract as a restored cart. The legacy unscoped `DELETE /api/pos/held_orders` body/query-ID shape must return `410 HELD_DELETE_ROUTE_RETIRED` for every authenticated role; a canonical delete against a row outside the actor's authority returns `403`. No compatibility adapter may bypass token, version, and confirmation.
- Public errors are stable codes (`HELD_IN_USE`, `HELD_VERSION_CONFLICT`, `HELD_OPERATION_CONFLICT`, `HELD_KITCHEN_BASELINE_UNKNOWN`, `HELD_KITCHEN_FOLLOW_UP_REQUIRED`, `HELD_KITCHEN_ROUTE_MISSING`) with non-PII refresh metadata.

### Save, leave, clear, and checkout

- **Save for later** canonicalizes and updates the same row, increments version, then releases the claim.
- Closing the page, logout, or abandoning the edit performs a best-effort release. Failure leaves the row safe; expiry is the fallback.
- Generic local cart clear while a held order is active must show an explicit confirmation. It may not silently detach the local cart from the server row.
- Confirmed cancellation locks the row and validates the claim, role authority, ownership, reason code, confirmation flag, expected version, and operation ID before deletion. In this prerequisite, cashier/manager authorization is implemented. The dependent plan extends the same endpoint—without duplicating it—to an exact claimed phone-source row handled by `call_center`.
- If nothing was sent to the kitchen, cancellation deletes after audit in the same transaction.
- If preparation was already sent, cancellation is an explicit POSApp policy: it requires an approved fixed reason code and the caller's scoped cancellation authority; queues a trusted `cancel` kitchen ticket for the complete sent baseline; audits it; and deletes in the same database transaction. It never accepts free text or customer PII in the cancellation action. This is not presented as Oracle's cancellation policy.
- `cancel` renders `إلغاء الطلب / ORDER CANCELLED`, contains original fire plus every successfully queued FOLLOW UP quantity, excludes unsent additions, and routes each portion to its original snapshot printer ID. Its deterministic batch identity is `held-{heldId}-cancel-{operationId}-{sentSnapshotHash}`; the queue identity additionally uses the stable original printer ID and canonical payload hash. The same cancellation operation therefore cannot create a second kitchen job after response loss or printer-metadata changes. It is whole-order cancellation, not a negative FOLLOW UP or item void.
- Checkout sends `held_order_id`, claim token, and expected held version. `executeCheckout()` locks and validates the held row before financial side effects, derives server-owned held metadata, and deletes the row only after the order, items, stock, payment, service-charge transition, source metadata, audit, and durable print-queue work commit.
- Any checkout rollback leaves the held row and claim recoverable. Existing checkout idempotency remains the only sale-idempotency authority.

### Service-charge ownership

- Recall no longer transitions a held `service_charge_snapshot` into a browser claim. It remains `state='held'`, `holder_type='held_order'`, and bound to the same held ID while editing.
- Same-row save keeps or atomically replaces/abandons the bound snapshot using the existing service-charge state machine.
- Checkout transitions the bound held snapshot directly to `finalized`/`order` in the same sale transaction.
- Cancel transitions it to `abandoned` before the held row is deleted.
- Browser crash recovery never depends on the old seven-day orphaned-claim cleanup.

### Server-owned kitchen rounds

- Every logical persisted held line receives a server-authored stable `held_line_id` inside canonical `cart_data`. Existing IDs are immutable; new lines receive new IDs. Bundle child preparation identities derive deterministically from the parent held line and server bundle snapshot.
- The client may not introduce, replace, or reuse a known ID for a different product/modifier/note signature.
- `kitchen_snapshot` stores the last successfully queued, server-canonical preparation baseline, immutable preparation signatures, and the stable printer IDs/routes that accepted each batch. It contains no price/payment/customer authority. Malformed/incoherent JSON, missing line IDs, or missing route evidence fails closed for manual review.
- `kitchen_dispatch_version` starts at zero and increments only when an initial or follow-up kitchen batch is durably queued.
- Initial fire sends the complete current preparation set, then stores the matching baseline.
- After the first fire:
  - new lines and positive quantity increases are eligible for FOLLOW UP; an increase from quantity 3 to 5 renders and queues delta quantity 2, never absolute quantity 5;
  - unchanged lines are omitted;
  - removed/decreased sent lines, product changes, modifier changes, note changes, and bundle-content changes are rejected from the ordinary save/follow-up path and directed to an explicit void/cancel workflow;
  - unsent lines may still be edited or removed before they enter a baseline.
- A legacy row with `kitchen_fired=1` and no trusted snapshot is `baseline_unknown`. FOLLOW UP, fired cancellation, and checkout are blocked rather than guessing what was printed. An authorized cashier/manager may inspect the kitchen copy and explicitly **Confirm current items were already sent**, providing an approved reason; this records the current canonical cart/routing as baseline without printing, increments version, and writes `held_order_kitchen_baseline_confirmed`. No automatic migration or lazy read may silently mark current items as sent.

### FOLLOW UP printing

- The action is explicit: **Save & send FOLLOW UP**. A plain save does not print.
- The server, never the browser, calculates the positive delta from persisted baseline to submitted canonical cart.
- It uses existing bundle normalization, category/printer routing, `enqueuePrintJobs`, print document compilation, template revisions, and spooler delivery.
- Add `follow_up` as a real trusted kitchen ticket type. A trusted `meta.followUpSequence` flows through document model, template validation/defaults/editor/compiler, compiled artifact, and spooler fallback. Built-in and custom template variants render a visible bilingual heading such as `إضافة على الطلب / FOLLOW UP` and the sequence. Do not smuggle this through order type or a user-editable title, and never let a compiler failure downgrade it to a normal kitchen heading.
- The batch identity is deterministic from held ID, next kitchen sequence, stable created time, canonical delta, and a delta hash. No request-time timestamp or random UUID may enter the semantic payload.
- Queue insertion and held baseline/version update use the same database connection/transaction: build payloads with the transaction connection, insert queue rows with `enqueuePrintJobs(conn, ...)`, update baseline/version, audit, commit, then call `dispatchClaimedPrintJobs` after commit.
- If any item is unrouted, or zero kitchen payloads are produced, the entire operation fails before the baseline advances. Mixed routed/unrouted carts may not be marked fully sent.
- Before rebuilding routes or touching queue rows, a response-loss retry resolves from the row's matching last-operation envelope. Printer metadata changes cannot change a committed retry into a second payload. A pre-existing queue key without matching held operation state is a manual-reconciliation conflict, not fresh success; a `failed`, `dead_letter`, or uncertain row is never treated as a newly accepted batch.
- A spooler job left uncertain after physical processing starts remains dead-letter/manual-review. Never auto-retry it.
- Final checkout of a previously fired held order must server-check for unsent positive delta. If any exists, checkout returns `HELD_KITCHEN_FOLLOW_UP_REQUIRED` and preserves the row; the cashier explicitly uses **Save & send FOLLOW UP**, then retries checkout. Checkout never silently prints additions, skips them, or prints the whole original cart.

### Auditing

- Use one small held-specific audit helper, not repeated route conditions.
- For held lifecycle events, `admin` and `programmer` actors are intentionally excluded. `appendAuditEvent` continues to suppress any actor whose `users.xyz=1`. Do not change global audit semantics for unrelated features.
- For every other actor, write inside the same mutation transaction:
  - `held_order_created`
  - `held_order_claimed`
  - `held_order_released`
  - `held_order_updated`
  - `held_order_kitchen_fired`
  - `held_order_kitchen_baseline_confirmed`
  - `held_order_follow_up_queued`
  - `held_order_canceled`
  - `held_order_consumed`
- Capture the authenticated operator ID and original role before any manager-override callback can temporarily mutate `req.user.role`; override authorization must not suppress the cashier's held audit.
- Audit values contain held ID, actor, old/new versions, non-secret operation ID, kitchen sequence, delta counts, an approved cancellation reason code, immutable phone source when present, and resulting invoice ID when consumed. They must not contain free-text cancellation notes, claim token/hash, customer name/phone/address, full cart JSON, manager PIN, or printer payload.
- Audit remains evidence, not lifecycle authority.

### Explicit exceptions

- Progressive split held rows are not register holds and stay on their existing split-check contract.
- Platform bulk settlement keeps its current finalization model but must reject an actively claimed register row and still delete only after its checkout transaction commits.
- The Y-held report remains an explicitly destructive administrative archive: archive insert and row delete stay atomic. In this prerequisite it archives safe version/kitchen state only, never claim owner/token/hash/expiry or last-operation replay data. It rejects unexpired claims and restores as unclaimed with a bumped version and reset request/operation replay fields. The dependent call-center migration later adds source preservation to the same staged contract.
- Table orders continue to use the table-order workflow. This plan does not merge held orders and table orders.

---

## Non-goals

- No call-center role or UI; that is the dependent plan.
- No new business/history/claims/kitchen-round table.
- No rewrite of checkout, Held Orders, table service, platform reconciliation, or print queue.
- No negative-quantity FOLLOW UP ticket.
- No automatic retry of physically uncertain kitchen jobs.
- No full sent-item void editor for arbitrary line reductions. This plan supports whole-held-order cancellation through the trusted `cancel` ticket; finer sent-line changes remain a later phase.
- No indexed phone-search column until real active-hold volume proves JSON lookup inadequate.
- No installer rebuild, live migration, merge, or push during execution.

---

## Migration authority

At plan-writing time the exact final manifest entry is:

- Name: `2026-08-10-order-reference-index-authority-v1`
- Checksum: `8e24a2088f8bf6aa0078954a6db5c4e4adb0140a69a523339b5ae20ebc0c951d`
- Normalized SQL SHA-256: `10f23e55be389cae905aeb270e5453d655cd634fc264084ac6f91abc6042f726`

Immediately before execution, re-read `backend/migrations/auto-manifest.json`. Stop if this is no longer the last entry and update the predecessor before writing SQL.

Proposed migration name: `2026-08-10-held-order-lifecycle-v1`.

The approved migration adds only these nullable/additive lifecycle fields to `held_orders`:

- `version INT UNSIGNED NOT NULL DEFAULT 1`
- `hold_request_id VARCHAR(64) NULL` with one unique composite index on `(user_id, hold_request_id)`
- `claimed_by_user_id INT NULL` with index and `ON DELETE RESTRICT` FK to `users.id`
- `claim_token_hash CHAR(64) NULL`
- `claim_expires_at DATETIME NULL`
- `updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`
- `kitchen_snapshot LONGTEXT NULL`
- `kitchen_dispatch_version INT UNSIGNED NOT NULL DEFAULT 0`
- `last_operation_id VARCHAR(64) NULL`
- `last_operation_kind VARCHAR(32) NULL`
- `last_operation_result LONGTEXT NULL`

Do not add a duplicated state enum: row presence is active, and non-null unexpired claim fields are the only claimed state. Add validation for coherent claim fields in application/schema checks; do not rely on a fragile cross-column database CHECK for time-dependent expiry.

Migration execution must include the normal evidence `.sql`, approved Hostinger-safe `.auto.sql`, exact ordered manifest entry with predecessor/checksum/hash, verbatim cumulative fallback block, ledger insert last, baseline/manifest hash, fixture, bootstrap ledger, schema validation, installer contracts, exact-predecessor scratch upgrade, partial-additive retry, rerun/no-op, and preservation of every existing row. No live database application is authorized by this plan.

---

## Task 1: Add the held lifecycle authority and migration

**Commit:** `feat: add durable held order lifecycle authority`

### Files

- Create `backend/migrations/2026-08-10-held-order-lifecycle.sql`
- Create `backend/migrations/2026-08-10-held-order-lifecycle.auto.sql`
- Modify `backend/migrations/auto-manifest.json`
- Modify `deployment/database/hostinger-manual-migrations.sql`
- Modify `deployment/database/baseline.sql`
- Modify `deployment/database/manifest.json`
- Modify `deployment/tools/bootstrap-database.js`
- Modify `backend/tests/fixtures/seed.js`
- Modify `backend/services/schemaValidation.js`
- Create `backend/services/HeldOrderLifecycleService.js`
- Modify `backend/services/ServiceChargeSnapshotService.js` only for direct held -> finalized/abandoned ownership and same-row save support
- Modify `backend/tests/unit/automaticMigrations.test.js`
- Modify `backend/tests/unit/schemaAuthority.test.js`
- Modify `backend/tests/integration/automaticMigrations.test.js`
- Modify `backend/tests/integration/installerBaseline.test.js`
- Create `backend/tests/unit/heldOrderLifecycleService.test.js`

### RED tests first

- Manifest/authority tests require the new final entry, exact predecessor, normalized SQL hash, fallback parity, baseline hash, all fields/indexes/FK, bootstrap/fixture ledger, and schema validation.
- Scratch migration starts at the exact predecessor with legacy unfired/fired/service-charge/Y/platform/split held rows, applies additively, preserves every row/JSON/snapshot, and initializes versions/dispatch versions while leaving fired rows without trusted history in `baseline_unknown` rather than pretending to know what printed.
- Pre-create each column/index/FK in separate partial-state fixtures; rerun succeeds and the final ledger insert remains last.
- Lifecycle unit tests cover constant-time token validation, same-token claim retry, competing claimant 409, database-UTC lease expiry/takeover, version conflict, last-operation replay for save/release/follow-up, and token/hash/last-operation omission from safe projections and audits.
- Service-charge tests prove recall leaves a held snapshot bound to the same held row; save, checkout, and cancel use legal transitions without an orphan browser claim.

### Implementation

1. Add a deep, transaction-oriented `HeldOrderLifecycleService` that owns row locking, claim token hashing/verification, expiry decisions, version CAS, release, and terminal consume/cancel predicates. It accepts an existing executor/connection; it never opens its own transaction and never owns HTTP translation.
2. Keep pricing/cart canonicalization in the existing order route/module owners. The service returns locked row metadata and narrow mutation results, not a dependency bag.
3. Add `appendHeldOrderAudit(conn, { actor, ...event })` beside the lifecycle service or audit service. It returns early for `isAdminRole(actor)` and delegates `xyz` suppression to `appendAuditEvent`.
4. Add only the approved columns. Store hashes only; keep last-operation results to small safe metadata, never cart/PII/token data. Replace every `SELECT h.*`/`SELECT *` response path with an explicit safe projection before the secret column exists. `ON DELETE RESTRICT` keeps an active claim coherent; role change/deactivation atomically releases active claims with a version bump before session invalidation so rows are not stranded.
5. Keep service-charge snapshots bound to the durable held row while editing. Add only the transitions/helpers required by same-row save, finalize, and abandon.
6. Complete every migration authority surface and scratch test before moving to Task 2.

### Focused GREEN verification

```powershell
npx vitest run backend/tests/unit/automaticMigrations.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/unit/heldOrderLifecycleService.test.js backend/tests/unit/serviceChargeSnapshotService.test.js backend/tests/integration/automaticMigrations.test.js backend/tests/integration/installerBaseline.test.js
git diff --check
```

Review the complete task diff. Confirm no business table, background worker, route behavior, live migration, or unrelated schema change. Commit only Task 1.

---

## Task 2: Replace destructive restore with same-row editing and transactional consume

**Commit:** `fix: preserve held orders through restore and checkout`

### Files

- Modify `backend/routes/pos/orders.js`
- Modify `backend/modules/checkout/executeCheckout.js`
- Modify `backend/routes/pos/checkout.js` only for held-context shape/error translation
- Modify `backend/routes/admin/auditReports.js`
- Modify `backend/routes/admin/users.js` only to release active held claims before role change/deactivation and session invalidation
- Modify `src/components/OrderNotes.vue`
- Modify `src/components/OrderNoteCard.vue` only for claim state/explicit remove controls
- Modify `src/pos/stores/orderSession/orderSessionPersistence.js`
- Modify `src/pos/stores/orderSessionStore.js`
- Modify `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify `src/pos/stores/orderSession/checkoutFlow.js`
- Modify `src/pos/stores/orderSession/orderSessionApi.js`
- Modify `backend/tests/unit/heldOrderLifecycleService.test.js`
- Modify `backend/tests/unit/orderSessionPersistence.test.js`
- Modify `backend/tests/unit/orderSessionStore.test.js`
- Modify `backend/tests/unit/orderSessionBoundaries.test.js`
- Modify `backend/tests/unit/checkoutFlow.test.js`
- Modify `backend/tests/integration/heldOrders.test.js`
- Modify `backend/tests/integration/checkout.test.js`
- Modify `backend/tests/integration/serviceChargeSnapshots.test.js`
- Modify `backend/tests/integration/auditReports.test.js`
- Modify `backend/tests/integration/users.test.js`
- Do not create a second held-order store

### RED tests first

- Rewrite the current destructive-claim tests: claim keeps the row, marks one lease winner, returns canonical cart/ID/version/expiry, and a concurrent terminal receives 409.
- A lost claim response followed by the same token recovers the same claim and row. Expiry permits a later claimant. No raw token/hash or last-operation envelope appears in list/socket/archive/log/audit responses; only the calling terminal retains its original opaque token.
- Claim persists any server re-pricing/tax/modifier canonicalization to the same row under a version increment; it does not alter the kitchen baseline.
- Initial hold response loss + same creator, `hold_request_id`, and canonical payload returns the same row. A different payload with the same creator/key conflicts, and another creator may safely use the same opaque key. Concurrent cap checks lock the stable owner `users` row before count+insert so two transactions cannot cross the existing limit.
- Save/release use the same ID, version, token, and `operation_id`; a committed response-loss retry returns the stored safe result without another insert, version bump, release, or audit. Version/operation conflict preserves both server row and client draft.
- Save/release, navigation release, and claim expiry preserve the row. No path uses reference text as identity.
- Explicit clear requires confirmation and valid authorization/claim. Unfired cancellation removes once; response-loss retry is harmless. A different terminal cannot clear an active claim.
- Cancellation rejects missing/unknown reason codes, `confirmed !== true`, free-text/customer fields, client-authored source, and client-authored kitchen/printer payload before any queue, service-charge, audit, or delete mutation.
- Checkout failure at validation, shift, payment, service-charge, stock, or any injected pre-commit point leaves the row. Successful checkout writes one order, consumes the held snapshot, audits `held_order_consumed`, and deletes the row in the same transaction. Existing checkout idempotency recovers a lost success response.
- Generic cart clear during a restored hold opens the held cancellation confirmation instead of silently clearing local state.
- Admin/programmer and xyz=1 actors produce no held lifecycle audit events; ordinary cashier actors do.
- Y archive rejects an unexpired claim, restores lifecycle fields unclaimed with version bumped, and keeps split/platform/Y behavior otherwise unchanged.
- User role change/deactivation atomically releases an owned active claim with version bump before invalidating the session; the stale terminal then receives a version/claim conflict.
- A fired legacy row without trusted snapshot blocks follow-up/cancel/checkout. Explicit baseline confirmation is permissioned, reasoned, audited once, and never prints.
- Initial fire from the board locks/version-checks an unclaimed row or validates the same terminal's claim; it rejects another active claimant. The old unscoped DELETE path cannot remove a row.

### Implementation

1. Add canonical `POST /held_orders/:id/claim` as lock/lease-and-return and retire the former `POST /held_orders/claim` body-ID route with stable 410. Keep all current bundle/product/tax/modifier repricing and pricing-context warnings, but persist the canonical result on the same row.
2. Add versioned update/release/cancel operations under the existing `/held_orders` resource using the exact common operation envelope. Use `PATCH /held_orders/:id`, `POST /held_orders/:id/release`, and `DELETE /held_orders/:id`; return stable 410 from the legacy unscoped body/query-ID delete shape, while canonical authorization failures remain 403, rather than preserving a security bypass.
3. Make initial hold creation idempotent with the draft-owned `hold_request_id`; lock the stable owner user row, then perform cap check and insert in one transaction.
4. Replace `restoredHeldReference` as scope authority with one backward-compatible held context `{ id, reference, version, claimToken, claimExpiresAt, kitchenFired, kitchenDispatchVersion }` inside the existing order-context persistence. Reference remains display text.
5. On re-hold/save, update the same row and release the lease. Network failure keeps local context. Logout/navigation calls release best-effort and clears only after local policy is satisfied.
6. Make explicit held cancellation the only local-clear path for a restored order. Require confirmation; keep the cart if the server rejects or the network fails.
7. Pass held context into ordinary checkout. `executeCheckout` locks/validates it before side effects, derives its server-owned metadata, and consumes it only after successful commit. Do not treat browser cart/source metadata as held authority.
8. Preserve the service-charge row as held ownership throughout recall/save. Remove the old service-charge browser-claim handoff from this path.
9. Harden delete and fire races with row locks, affected-row checks, claim ownership, operation replay, and same-transaction audits. Board fire may lock an available row directly; board cancellation must claim it first.
10. Keep Y-report delete/archive as the documented administrative exception; restore every lifecycle field but clear claimant/token/expiry and bump version.
11. In the existing user mutation transaction, release active claims with version bump before role change/deactivation, then invalidate the old session after commit.

### Focused GREEN verification

```powershell
npx vitest run backend/tests/unit/heldOrderLifecycleService.test.js backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderSessionBoundaries.test.js backend/tests/unit/checkoutFlow.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/checkout.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/auditReports.test.js backend/tests/integration/users.test.js
git diff --check
```

Inspect response-loss, rollback, and shared-terminal paths manually in the diff. Confirm no ordinary restore deletes or inserts a replacement row. Commit only Task 2.

---

## Task 3: Add server-canonical kitchen rounds and FOLLOW UP tickets

**Commit:** `feat: add held order kitchen follow ups`

### Files

- Modify `backend/services/HeldOrderKitchenDispatch.js`
- Modify `backend/services/kitchenTicketItems.js`
- Modify `backend/services/kitchenPrintRouting.js` only to expose existing routed/unrouted results cleanly
- Modify `backend/services/printDispatch.js` only to reuse connection-owned enqueue + post-commit dispatch
- Modify `backend/services/printDocumentModel.js`
- Modify `backend/services/printTemplateEngine.js`
- Modify `backend/services/printTemplateDefaults.js`
- Modify `backend/services/printDocumentCompiler.js`
- Modify `backend/services/printJobIdentity.js` only if a focused test proves the existing key cannot express the deterministic batch
- Modify `backend/routes/pos/orders.js`
- Modify `backend/modules/checkout/executeCheckout.js`
- Modify `pos-spooler-printer/renderDocument.js`
- Modify `src/admin/components/PrintTemplateEditor.vue` to expose the trusted heading variant and sequence binding
- Modify `src/components/OrderNotes.vue`
- Modify `src/pos/stores/orderSessionStore.js`
- Modify `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify `backend/tests/unit/heldOrderKitchenDispatch.test.js`
- Modify `backend/tests/unit/kitchenPrintRouting.test.js`
- Modify `backend/tests/unit/kitchenTicketItems.test.js`
- Modify `backend/tests/unit/printDispatchOwnership.test.js`
- Modify `backend/tests/unit/SavedOrderLines.test.js`
- Modify `backend/tests/unit/helpers.test.js`
- Modify `backend/tests/unit/printJobIdentity.test.js`
- Modify `backend/tests/unit/printDocumentModel.test.js`
- Modify `backend/tests/unit/printTemplateEngine.test.js`
- Modify `backend/tests/unit/printTemplateParity.test.js`
- Modify `backend/tests/unit/printDocumentCompiler.test.js`
- Modify `backend/tests/unit/printGoldens.test.js` and its owned golden fixtures
- Modify `backend/tests/unit/spoolerPackageContract.test.js`
- Modify `backend/tests/integration/heldOrders.fireKitchen.test.js`
- Modify `backend/tests/integration/bundle.heldOrders.fire.test.js`
- Modify `backend/tests/integration/heldOrders.test.js`
- Modify `backend/tests/integration/checkout.test.js`
- Modify `backend/tests/integration/tableOrderPostCommit.test.js`
- Modify `backend/tests/integration/tables.test.js`

### RED tests first

- Initial fire assigns/persists stable server line IDs, routes every preparation line, queues inside the held transaction, records baseline/sequence/version, audits, and only then dispatches after commit.
- Mixed routed/unrouted and all-unrouted carts return a stable 422; no queue row, baseline, fired flag, dispatch version, or audit event advances.
- Existing fired legacy rows remain blocked with `baseline_unknown` until authorized explicit baseline confirmation; confirmation prints nothing and records exactly one version/audit mutation.
- Delta tests cover new line, quantity increase rendered as the exact positive delta (3 -> 5 prints 2), unchanged line, duplicate product with distinct held line IDs, Arabic/multiline notes, modifiers, bundles, and reordered client arrays.
- Sent-line removal/decrease/product/modifier/note/bundle mutation fails with a stable conflict; an unsent line may be edited/removed.
- FOLLOW UP contains delta only, visible bilingual heading and sequence, original held identity/order type, stable created time, no customer PII, and no original unchanged lines.
- Same `operation_id` follow-up retry replays before routing and produces the same semantic result/idempotency rows without another audit/version/baseline increment, even if printer metadata changes afterward. A changed delta produces the next sequence.
- Queue insert failure rolls back baseline/audit. Row update failure rolls back queue inserts. Post-commit dispatch failure leaves durable pending/failed queue state and does not roll back the held order. Connection-ownership tests prove held routing/enqueue never falls back to the global pool.
- Spooler crash after physical-processing start remains uncertain/dead-letter and is not silently auto-retried. A duplicate queue row in failed/dead-letter/uncertain state cannot advance baseline as fresh success.
- Fired-order checkout with outstanding positive delta returns `HELD_KITCHEN_FOLLOW_UP_REQUIRED`; after explicit follow-up it consumes without reprinting original lines.
- Fired whole-order cancel requires a fixed reason code + scoped cancellation authority, targets every original snapshot printer ID, includes the cumulative sent baseline (original fire plus FOLLOW UP quantities), excludes unsent additions, and uses `held-{heldId}-cancel-{operationId}-{sentSnapshotHash}` as the deterministic batch identity before it audits and deletes atomically. Retrying the same operation after response loss cannot add another queue row even if printer metadata changed. Missing/deleted original route fails closed for manual review; it never silently reroutes or drops a cancellation. Unfired cancel does not print.
- Custom print-template revisions can set the trusted `follow_up` and `cancel` headings/sequence fields; built-in previews/goldens, compiler failure, and legacy spooler fallback keep the visible `FOLLOW UP` and `إلغاء الطلب / ORDER CANCELLED` identities.
- Invalid snapshot JSON, missing stable line/signature data, inconsistent sequence/version, and mixed routed/unrouted items fail closed without queue/baseline/audit mutation.

### Implementation

1. Extend `HeldOrderKitchenDispatch` into the single held-round owner. Add small pure helpers for stable line identities, immutable preparation signatures, exact positive delta quantities, explicit legacy-baseline acknowledgement, and deterministic batch construction. Do not reuse `SavedOrderLines.getNewItems` blindly because its key omits modifiers.
2. Canonical ordering of delta lines and a persisted created time must feed the payload hash. Request time and client array order must not.
3. Replace the injected `printKitchenOrder`/global-pool boundary for held rounds. Build routing with the transaction connection and call `enqueuePrintJobs(conn, payloads)` before updating the held baseline. Only newly inserted/accepted pending queue rows may advance it. After commit, call `dispatchClaimedPrintJobs`; do not use `enqueueAndProcessJobs` on the global pool inside the held transaction.
4. Fail the whole initial/follow-up operation when `unroutedItems` is non-empty. Surface a human route/printer message without leaking raw device internals.
5. Add trusted `follow_up` and `cancel` types plus `meta.followUpSequence` to document model, template validation/default variants/editor binding, compiler/goldens, and `pos-spooler-printer/renderDocument.js`. Compiler fallback must preserve the FOLLOW UP heading/sequence and ORDER CANCELLED heading or fail before enqueue. Preserve normal, item-void, subscription, and subscription-void output exactly.
6. Add **Save** and **Save & send FOLLOW UP** only when applicable. Follow-up success updates the same row; failure preserves the edited cart and claim.
7. At checkout, detect outstanding positive delta and return the explicit follow-up-required conflict before financial side effects. After the operator explicitly queues the delta, checkout may consume. Durable queue acceptance is sufficient; do not make the customer wait for physical printer acknowledgement.
8. For confirmed whole-order cancellation after fire, reuse routing, document compilation, queue insertion, and spooler delivery but produce the distinct trusted `cancel` ticket from the cumulative sent snapshot. Never encode cancellation as an item void or negative FOLLOW UP quantities.

### Focused GREEN verification

```powershell
npx vitest run backend/tests/unit/heldOrderKitchenDispatch.test.js backend/tests/unit/kitchenPrintRouting.test.js backend/tests/unit/kitchenTicketItems.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/SavedOrderLines.test.js backend/tests/unit/helpers.test.js backend/tests/unit/printJobIdentity.test.js backend/tests/unit/printDocumentModel.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/printTemplateParity.test.js backend/tests/unit/printDocumentCompiler.test.js backend/tests/unit/printGoldens.test.js backend/tests/unit/spoolerPackageContract.test.js backend/tests/integration/heldOrders.fireKitchen.test.js backend/tests/integration/bundle.heldOrders.fire.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tableOrderPostCommit.test.js backend/tests/integration/tables.test.js
npm --prefix pos-spooler-printer test
npm run build:admin
git diff --check
```

Review for duplicate routing/rendering, random semantic fields, global-pool writes inside the transaction, silent unrouted items, and client-authored line identity. Commit only Task 3.

---

## Task 4: Close audit, recovery, UI, and real-workflow gaps

**Commit:** `test: prove held order lifecycle recovery`

### Files

- Modify `backend/tests/integration/heldOrders.test.js`
- Modify `backend/tests/integration/heldOrders.fireKitchen.test.js`
- Modify `backend/tests/integration/checkout.test.js`
- Modify `backend/tests/integration/auditReports.test.js`
- Modify `src/components/OrderNotes.vue` and existing styles only for final claim/cancel/follow-up states
- Modify `src/shared/i18n/ar.json`
- Modify `tests/e2e/global.setup.js`
- Modify `playwright.config.mjs`
- Create `tests/e2e/specs/held-order-lifecycle.spec.js`
- Regenerate `docs/architecture.json` and `docs/architecture.html`

### Required real browser workflow

Playwright must exercise the real server and scratch database, not mocked `fetch`:

1. Cashier creates one hold; a forced lost response retry returns the same ID.
2. Terminal A claims it; Terminal B sees it as in use and cannot claim, fire, update, or clear it.
3. Refresh Terminal A and recover the same held ID/version/token context; the row still exists.
4. Edit and Save for later; the same row/reference remains and becomes available.
5. Simulate a lost save/release response and retry the identical `operation_id`; observe the same result with one version change and one audit event.
6. Claim again, clear local cart, decline cancellation, and prove both cart and row remain.
7. Claim again, force checkout validation failure, and prove the row remains recoverable.
8. Load a legacy fired/no-snapshot row; follow-up/checkout remain blocked until explicit authorized baseline confirmation, which audits once and prints nothing.
9. Initial kitchen fire prints the full baseline once. Add a new item and increase another; FOLLOW UP preview/queue contains only those delta quantities and the visible heading/sequence.
10. Retry the follow-up after a simulated response loss and printer metadata change; no duplicate queue row, audit, version, or baseline increment appears.
11. Try checkout before sending an outstanding delta; it blocks with the explicit FOLLOW UP action. Send it, then continue.
12. Try to remove/change a sent line; receive the explicit void/cancel guidance and no silent kitchen mutation.
13. Complete checkout; the held row disappears only after the order commits, and no unchanged original kitchen line is reprinted.
14. Explicitly cancel an unfired hold; ordinary actor audit exists. Repeat as admin/programmer and xyz=1; held audit is absent by contract. A cashier using manager override still records the cashier actor.
15. Explicitly cancel a fired hold with an approved reason; one `إلغاء الطلب / ORDER CANCELLED` ticket per original route contains all sent quantities and excludes unsent additions, then the row is removed atomically. Missing original routing blocks for manual review.
16. At 1024x768 and mobile width, light and graphite show usable claimed-by-other, restore, save, follow-up, baseline-review, clear-confirmation, and conflict states without clipped actions or hardcoded white surfaces.

### Final verification

```powershell
npx vitest run backend/tests/unit/automaticMigrations.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/unit/heldOrderLifecycleService.test.js backend/tests/unit/serviceChargeSnapshotService.test.js backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderSessionBoundaries.test.js backend/tests/unit/checkoutFlow.test.js backend/tests/unit/heldOrderKitchenDispatch.test.js backend/tests/unit/kitchenPrintRouting.test.js backend/tests/unit/kitchenTicketItems.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/SavedOrderLines.test.js backend/tests/unit/helpers.test.js backend/tests/unit/printJobIdentity.test.js backend/tests/unit/printDocumentModel.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/printTemplateParity.test.js backend/tests/unit/printDocumentCompiler.test.js backend/tests/unit/printGoldens.test.js backend/tests/unit/spoolerPackageContract.test.js backend/tests/integration/automaticMigrations.test.js backend/tests/integration/installerBaseline.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/heldOrders.fireKitchen.test.js backend/tests/integration/bundle.heldOrders.fire.test.js backend/tests/integration/checkout.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/auditReports.test.js backend/tests/integration/tableOrderPostCommit.test.js backend/tests/integration/tables.test.js
npx playwright test tests/e2e/specs/held-order-lifecycle.spec.js --project=held-order-lifecycle-tests
npm --prefix pos-spooler-printer test
npm run architecture:check
npm run build:admin
git diff --check
git status --short
```

Also inspect directly:

- migration predecessor/checksum/hash, fallback parity, ledger-last ordering, and table count still 48;
- no `DELETE FROM held_orders` occurs in ordinary claim/save/release;
- every terminal delete is either successful checkout, confirmed cancel, platform finalization, split finalization, or the documented Y archive;
- every mutation locks one row and checks token/version/affected rows;
- no token/hash/customer PII/full cart enters audits, sockets, or generic logs;
- all queue writes honor print idempotency and append-only history;
- the original normal/void/subscription kitchen goldens remain unchanged and new cancel goldens are explicit;
- normal cashier, platform, split, table, service-charge, receipt, and JoFotara workflows remain intact.

Commit only after the real browser test and independent review are clean.

---

## Adversarial attack results

This plan was attacked against the current destructive claim route, same-row absence, service-charge claim state, localStorage scope, checkout idempotency, kitchen routing, print queue identity, custom template variants, spooler uncertain-state policy, Y archive, platform settlement, split checks, audit suppression, and multi-terminal races.

Rejected designs:

- **Keep destructive claim and add more local backup:** rejected because a browser cannot restore a deleted server row or its held service-charge ownership.
- **Copy the row into a new claims/history table:** rejected as another order authority and unnecessary for a short lease.
- **Use the reference name as identity:** rejected because it is mutable, non-unique presentation text.
- **Use only `kitchen_fired`:** rejected because one bit cannot distinguish original lines from later additions.
- **Trust client `cartId` for delta:** rejected because it is client-authored and can be reused or changed.
- **Reuse table `getNewItems` unchanged:** rejected because its identity omits modifiers and table batches are random, which is unsafe for retryable FOLLOW UP.
- **Queue through the global pool then update held state:** rejected because print and baseline can commit independently.
- **Print the full order with a FOLLOW UP heading:** rejected because the kitchen cannot distinguish new work and may prepare items twice.
- **Automatically retry uncertain physical kitchen output:** rejected by the append-only/dead-letter print invariant.
- **Reuse the item-void heading for whole-order cancellation:** rejected because the kitchen must distinguish one removed line from stopping the complete order; the same print pipeline carries a trusted `cancel` type instead.
- **Add a heartbeat/background lease reaper:** rejected; claim expiry and operation-time locks are enough.
- **Put lifecycle authority in audit events:** rejected because xyz suppression is intentional and audits are not complete.
- **Delete/recreate on re-hold:** rejected because identity, source, version, kitchen baseline, and response-loss safety would reset.

The final attack added mutation replay state, exact API envelopes, safe legacy fired-row reconciliation, explicit pre-checkout FOLLOW UP, secret-safe Y archive/projections, original-operator auditing, connection-owned enqueue, trusted compiler/spooler fallback, original-route cancellation, malformed-snapshot handling, and the missing regression suites. The plan is ready for later execution. No code, migration, database row, or printer state has been changed by writing it.
