# JoFotara Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe JoFotara operations queue, opt-in automatic submission for newly finalized local documents, stale-attempt recovery, and visible admin alerts without changing checkout availability or duplicating the existing integration boundary.

**Architecture:** Extend `JofotaraService` as the single owner of JoFotara state and discovery. A bounded server timer derives work from committed `orders`/`refunds`, while existing submit functions retain all locking, snapshot, XML, credential, and idempotency rules. One credential-free admin endpoint powers a dedicated responsive page and sidebar badge.

**Tech Stack:** Node.js/CommonJS, Express 5, mysql2/InnoDB, Vue 3, native `fetch`, Socket.IO, Vitest/Supertest, existing JoFotara services.

## Global Constraints

- Never resubmit `accepted` or `unknown` documents.
- Never treat timeout, abort, connection failure, non-JSON response, or interrupted `submitting` state as a rejection.
- Automatic processing may submit only never-attempted sources created at or after the explicit enable cutoff.
- `rejected` remains a manual retry using the existing frozen UUID/XML/ICV.
- No JoFotara call inside checkout/refund transactions or their HTTP response path.
- Return no credentials, XML, legal snapshots, full raw responses, or secret-bearing errors from operations APIs.
- Add no dependency, generic job framework, connector abstraction, repository, new queue table, or frontend store.
- Existing manual submit, XML preview, receipt QR, tax profiles, and credit-note behavior remain compatible.
- Use parameterized SQL and retain the existing admin/programmer authorization wall.

---

## File Map

| File | Responsibility |
|---|---|
| `backend/migrations/2026-07-24-jofotara-operations.sql` | Seed automation settings and record the migration |
| `backend/migrations/2026-07-24-jofotara-operations-verify.sql` | Verify settings and migration checksum |
| `backend/tests/fixtures/seed.js` | Mirror automation settings in the test database |
| `backend/services/schemaValidation.js` | Require the new migration/settings at startup |
| `backend/services/JofotaraService.js` | Credential-free operations reads, stale watchdog, bounded automatic processor |
| `backend/routes/admin/jofotara.js` | Settings toggle, operations reads, manual processor trigger, realtime notification |
| `server.js` | Start one non-overlapping JoFotara operations cycle after server startup |
| `src/admin/pages/JofotaraOperations.vue` | Unified unresolved queue and manual source actions |
| `src/admin/pageRegistry.js` | Lazy-load the operations page |
| `src/admin/components/Sidebar.vue` | JoFotara navigation and unresolved badge |
| `src/admin/App.vue` | Page title |
| `src/admin/realtime.js` | Bridge the JoFotara status event |
| `src/admin/pages/Settings.vue` | Explicit automatic-submission toggle and warning copy |
| `src/shared/i18n.js` | English/Arabic operations copy |
| `backend/tests/integration/jofotara.test.js` | State, discovery, worker, auth, and redaction behavior |
| `backend/tests/unit/jofotaraClient.test.js` | Lock ambiguity classification against retry assumptions |
| `backend/tests/unit/schemaAuthority.test.js` | Migration/settings/startup authority |
| `src/admin/pages/__tests__/jofotaraOperationsPage.spec.js` | Page registration, actions, status guards, responsiveness, and alert wiring |

### Task 1: Make automation settings authoritative

**Interfaces:**
- Consumes: existing `settings` and `schema_migrations` tables.
- Produces: `jofotara_auto_submit='0|1'` and `jofotara_auto_submit_since=''|DATETIME`.

- [ ] **Step 1: Write schema-authority assertions**

Add failing assertions to `backend/tests/unit/schemaAuthority.test.js` requiring migration name `2026-07-24-jofotara-operations-v1`, checksum `3106a8e43bc3ad579e57e0a50e0bc7ac7e48f0cca6b9851fedd272c845ebc36e`, both setting keys, and a matching verifier.

- [ ] **Step 2: Run the schema test RED**

Run: `npx vitest run backend/tests/unit/schemaAuthority.test.js`

Expected: failure because the migration and new startup authority do not exist.

- [ ] **Step 3: Add migration, verifier, seed, and startup authority**

The migration must upsert only missing defaults, never overwrite an existing operator choice:

```sql
INSERT INTO settings (setting_key, setting_value) VALUES
  ('jofotara_auto_submit', '0'),
  ('jofotara_auto_submit_since', '')
ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key);
```

Record the exact migration name/checksum. Update `MIGRATION_NAME`, `MIGRATION_CHECKSUM`, the required settings query/count, and the test seed.

- [ ] **Step 4: Run the schema test GREEN**

Run: `npx vitest run backend/tests/unit/schemaAuthority.test.js`

Expected: all schema-authority tests pass.

### Task 2: Define the safe operations read model and stale watchdog

**Interfaces:**
- Produces: `getJofotaraOperations({ limit = 50 })`.
- Produces: `markInterruptedJofotaraSubmissionsUnknown({ io }) -> number`.
- Operations items expose source/document identity, kind, status, attempts, safe error, and timestamps only.

- [ ] **Step 1: Write integration tests RED**

Add tests proving:

- the summary counts missing invoices, missing eligible credit notes, pending, submitting, rejected, and unknown;
- the item list returns at most the validated limit and excludes accepted rows;
- XML, legal snapshots, raw responses, credential values, and secret setting keys never appear;
- a `submitting` row older than two minutes becomes `unknown` once, receives the fixed review message, and emits one staff event;
- recent `submitting`, accepted, rejected, pending, and unknown rows are otherwise unchanged.

Run: `npx vitest run backend/tests/integration/jofotara.test.js`

Expected: failures because the operations functions and endpoint are absent.

- [ ] **Step 2: Implement minimal service functions**

Extend `JofotaraService.js`; do not create another service. Use grouped counts and bounded indexed reads. `publicState`/the operations mapper must omit `request_xml`, `legal_snapshot_json`, `response_body`, and all settings.

The stale update must be one parameterized/bounded database statement selecting `status='submitting' AND last_attempt_at < NOW() - INTERVAL 2 MINUTE`, change only those rows to `unknown`, and audit/emit only the affected count/IDs without payload data.

- [ ] **Step 3: Run focused tests GREEN**

Run: `npx vitest run backend/tests/integration/jofotara.test.js`

Expected: operations and all existing JoFotara integration tests pass.

### Task 3: Add bounded opt-in automatic submission

**Interfaces:**
- Produces: `processAutomaticJofotara({ io, fetchImpl, limit = 5 })`.
- Returns `{ stale_marked, invoices_attempted, credit_notes_attempted, accepted, rejected, unknown, skipped }`.
- Reuses `submitSalesInvoice` and `submitCreditNote`; it never constructs XML or updates final status itself.

- [ ] **Step 1: Write worker tests RED**

Prove:

- disabled integration/automation performs no discovery or HTTP call;
- enabling automation sets `jofotara_auto_submit_since` to database time and never selects older sources;
- a newly finalized paid invoice is submitted after local commit and an eligible refund waits until its original invoice is accepted;
- at most five total sources are attempted per cycle in deterministic source-time/ID order;
- two overlapping processor calls share one in-process run while database uniqueness/locks remain the cross-caller guard;
- accepted, rejected, unknown, any `attempt_count>0`, and any non-null `last_attempt_at` source is never selected automatically;
- network ambiguity becomes `unknown` once and is not selected on the next cycle;
- explicit rejection is persisted but not automatically retried;
- automatic audit events use `user_id=NULL` and contain no credential or XML material.

Run: `npx vitest run backend/tests/integration/jofotara.test.js`

Expected: worker tests fail for the missing processor.

- [ ] **Step 2: Implement the narrow processor**

Use a module-local promise only to prevent overlapping timers in this single-process deployment. Mark it with the ceiling: database uniqueness and `FOR UPDATE` remain authoritative if another caller/process exists.

Load both automation settings first. Select only sources with `created_at >= auto_submit_since`, no existing ledger row, and a fully configured frozen tax profile. Run the stale watchdog regardless of the automation toggle. Catch/log each source error without aborting later sources; never log config objects or request payloads.

- [ ] **Step 3: Run worker/integration tests GREEN**

Run: `npx vitest run backend/tests/integration/jofotara.test.js backend/tests/unit/jofotaraClient.test.js`

Expected: all tests pass and ambiguity remains `unknown`.

### Task 4: Add secure routes, timer, and realtime refresh

**Interfaces:**
- `GET /api/admin/jofotara/operations?limit=50`
- `POST /api/admin/jofotara/operations/process`
- Socket event: `jofotara_operations_changed` with counts/identifiers only.

- [ ] **Step 1: Write route/auth tests RED**

Prove unauthenticated/non-admin access is rejected by the existing router wall, invalid limits are bounded, the processor endpoint does nothing when automation is disabled, and manual invoice/refund submission emits the same safe refresh event.

- [ ] **Step 2: Implement route and lifecycle wiring**

Extend the existing admin route. When `auto_submit` changes from false to true, persist the cutoff using database `NOW()`; disabling retains the old cutoff but the next re-enable replaces it. Do not accept `auto_submit_since` from the browser.

In `server.js`, start one immediate cycle inside `onServerStarted` and one 60-second interval. Do not run the timer when `server.js` is imported by tests. Add one admin realtime bridge handler.

- [ ] **Step 3: Run focused tests GREEN**

Run: `npx vitest run backend/tests/integration/jofotara.test.js backend/tests/unit/schemaAuthority.test.js`

Expected: routes, settings transitions, realtime, and existing behavior pass.

### Task 5: Add the responsive operations workspace and alert

**Interfaces:**
- Page name: `jofotara`.
- Consumes the operations endpoint and existing source submit endpoints.
- Sidebar badge displays `summary.unresolved_count` only while JoFotara is enabled.

- [ ] **Step 1: Write frontend boundary test RED**

Create `src/admin/pages/__tests__/jofotaraOperationsPage.spec.js` requiring:

- one lazy page registration, sidebar entry/badge, App title, and realtime event;
- compact summary cards for not submitted, rejected, unknown, and in progress;
- status and kind filters plus refresh;
- desktop table and mobile card layout;
- Send/Retry only for `not_submitted|pending|rejected`;
- no submit action for `submitting|unknown|accepted`;
- unknown copy explicitly instructing government-side review;
- source navigation through `open_invoice_id`;
- automatic-submission toggle copy warning that only new documents after enabling are processed.

Run: `npx vitest run src/admin/pages/__tests__/jofotaraOperationsPage.spec.js`

Expected: failure because the page is absent.

- [ ] **Step 2: Implement the smallest page and badge**

Create one Vue page with no composable/store. Use native `fetch`, an AbortController for list refresh, existing admin confirmation/alert globals, and the current admin grid/card CSS conventions. Poll the sidebar summary every 60 seconds and refresh immediately on `jofotara_operations_changed`; clear timers/listeners on unmount.

Extend Settings with one checkbox only. Do not expose or edit the cutoff.

- [ ] **Step 3: Run frontend tests and build GREEN**

Run:

```powershell
npx vitest run src/admin/pages/__tests__/jofotaraOperationsPage.spec.js
npm test
```

Expected: frontend boundary tests and production build pass.

### Task 6: Adversarial verification and cleanup

- [ ] Run JoFotara, schema, admin routing, receipt/print, checkout, refund, subscription, and realtime tests.
- [ ] Apply the migration to development and test databases; run the verifier and `node scripts/validate-schema-drift.js`.
- [ ] Search for every mutation of `jofotara_documents.status`; prove accepted/unknown automatic transitions do not exist.
- [ ] Search responses/logs/events for Client-Id, Secret-Key, XML, snapshots, and raw responses.
- [ ] Simulate processor overlap, stale submitting, explicit rejection, timeout, missing credentials, disabled automation, cutoff, and server restart.
- [ ] Review the diff with ponytail: remove duplicate state maps/queries, speculative resolution actions, generic job abstractions, unnecessary files, and frontend state owners.
- [ ] Run `git diff --check`, focused suites, full unit suite, and a fresh production build.
- [ ] Commit the verified implementation as `feat(jofotara): add safe operations workflow`.

## Plan attack result

- Historical auto-submission is prevented by an operator-created cutoff.
- Checkout/refund transactions remain untouched; the worker reads only committed documents.
- There is no blind retry class: only never-attempted sources are automatic.
- Stale `submitting` becomes `unknown`, not `rejected`.
- Existing submit functions remain the sole legal snapshot/HTTP/state-transition path.
- No new queue table is needed because `orders`, `refunds`, and the unique JoFotara ledger already provide durable discovery and idempotency.
- A dedicated page is justified because invoices and credit notes cross the Orders/Subscriptions surfaces; no frontend store/composable is justified.
