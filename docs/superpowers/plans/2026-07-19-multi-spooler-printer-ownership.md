# Multi-Spooler Printer Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every receipt and kitchen job to exactly one configured print station without public-IP matching, while making duplicate kitchen output fail closed under retries, reconnects, and common configuration mistakes.

**Architecture:** A printer row owns a stable `spooler_id` such as `primary` or `terminal-b`; a temporary Socket.IO ID or HTTP poll claimant may process only jobs whose `printer_id` belongs to that stable owner. Every queued payload carries the numeric logical printer ID, while the existing idempotency key and spooler's durable journal suppress repeated delivery. Existing installations migrate to `primary`; additional installations must use a unique `SPOOLER_ID`.

**Tech Stack:** Node.js/CommonJS, Express, Socket.IO, Vue 3, MySQL/MariaDB 10.4, Vitest, Supertest.

## Global Constraints

- Do not use client/public IP addresses for receipt-printer selection or spooler routing.
- Do not broadcast print jobs to every spooler.
- One active physical endpoint per printer role; the same device may intentionally have one receipt row and one kitchen row.
- Different kitchen printers mapped to the same product are intentional destinations, not duplicates.
- Existing single-spooler installations remain assigned to stable station ID `primary`.
- No new runtime dependency and no unrelated printer UI redesign.
- A cashier with multiple receipt printers must select one locally; the server may auto-select only when exactly one active receipt printer exists.

---

### Task 1: Guarded ownership schema

**Files:**
- Create: `backend/migrations/2026-07-19-multi-spooler-printer-ownership.sql`
- Create: `backend/migrations/2026-07-19-multi-spooler-printer-ownership-verify.sql`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `backend/services/schemaValidation.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`

**Interfaces:**
- Produces `printers.spooler_id VARCHAR(96) NOT NULL DEFAULT 'primary'`.
- Produces numeric nullable `print_queue.printer_id` and `idx_print_queue_owner_claim (printer_id, status, locked_until, id)`.
- Produces a generated active physical endpoint key and unique constraint so two active rows with the same role cannot target the same physical endpoint.

- [x] **Step 1: Write failing schema authority assertions**

```js
expect(summary.printer_owner_columns).toBe(2);
expect(summary.print_queue_printer_type).toBe(1);
expect(summary.printer_owner_indexes).toBe(2);
```

- [x] **Step 2: Run the focused schema test and confirm it fails because ownership fields are absent**

Run: `npx vitest run backend/tests/unit/schemaAuthority.test.js`

- [x] **Step 3: Add a guarded MariaDB migration**

```sql
ALTER TABLE printers
  ADD COLUMN spooler_id varchar(96) NOT NULL DEFAULT 'primary' AFTER assigned_ips,
  ADD COLUMN active_endpoint_key varchar(255)
    AS (CASE
      WHEN is_active = 1 AND type = 'network' THEN CONCAT(role, ':network:', LOWER(TRIM(network_ip)), ':', COALESCE(NULLIF(TRIM(network_port), ''), '9100'))
      WHEN is_active = 1 AND type = 'windows' THEN CONCAT(role, ':windows:', LOWER(TRIM(spooler_id)), ':', LOWER(TRIM(windows_name)))
      ELSE NULL
    END) PERSISTENT,
  ADD KEY idx_printers_spooler (spooler_id, is_active, id),
  ADD UNIQUE KEY uq_printers_active_endpoint (active_endpoint_key);
```

Before changing `print_queue.printer_id`, normalize legacy names/IPs to matching printer IDs and set unmatched historical values to `NULL`; the original payload remains durable history.

- [x] **Step 4: Update the authoritative fixture and startup schema validation**
- [x] **Step 5: Apply the migration to development and test databases, run its verifier, then rerun the schema test**

---

### Task 2: Owner-filtered claims and multi-spooler registry

**Files:**
- Modify: `backend/services/printQueue.js`
- Modify: `backend/services/spoolerRegistry.js`
- Modify: `backend/tests/integration/printQueue.test.js`
- Modify: `backend/tests/integration/spoolerPoll.test.js`
- Modify: `backend/tests/unit/spoolerRegistry.test.js`

**Interfaces:**
- `claimPrintJobs(db, { spoolerId, claimantId, limit, leaseSeconds })`
- `markPrintJobsSent(db, jobs, { claimantId })`
- `settlePrintJob(db, { queueId, claimantId, spoolerId, ...result })`
- Registry methods use `{ spoolerId, socketId }` and expose `get(spoolerId)` plus `list()`.

- [x] **Step 1: Write failing tests proving station A cannot claim station B jobs**

```js
const a = await claimPrintJobs(pool, { spoolerId: 'station-a', claimantId: 'socket-a' });
const b = await claimPrintJobs(pool, { spoolerId: 'station-b', claimantId: 'socket-b' });
expect(a.map(job => job.printer_id)).toEqual([printerA]);
expect(b.map(job => job.printer_id)).toEqual([printerB]);
```

- [x] **Step 2: Confirm the tests fail because the current claim query ignores printer ownership**
- [x] **Step 3: Join `print_queue` to active `printers` in the locked claim query and separate stable owner from temporary claimant**
- [x] **Step 4: Replace the single active registry slot with a map keyed by stable spooler ID; reject a second live socket for the same ID but accept different IDs**
- [x] **Step 5: Rerun the focused queue, poll, and registry tests**

---

### Task 3: Targeted socket, poll, retry, and status delivery

**Files:**
- Modify: `server.js`
- Modify: `backend/routes/spooler.js`
- Modify: `backend/services/printDispatch.js`
- Modify: `backend/routes/admin/printQueue.js`
- Modify: `backend/tests/integration/spoolerPoll.test.js`
- Modify: `backend/tests/unit/spoolerRegistry.test.js`

**Interfaces:**
- Socket handshake supplies `spooler_id` and optional `spooler_name`.
- Each accepted socket joins `spoolers` and `spooler:<stable-id>` rooms.
- HTTP fallback uses the same stable owner and a claimant named `poll:<stable-id>`.
- `dispatchClaimedPrintJobs(io, limit)` iterates connected spoolers but emits only each owner's claimed rows.

- [x] **Step 1: Add failing tests for unique stable registration and owner-filtered HTTP polling**
- [x] **Step 2: Validate stable IDs with `^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$` in socket and HTTP paths**
- [x] **Step 3: Route connection delivery, immediate dispatch, periodic retry, acknowledgements, and disconnect handling through stable owner plus temporary claimant**
- [x] **Step 4: Send printer-status queries only to the printer's owner and expose all connected stations in print-queue health**
- [x] **Step 5: Rerun focused server and poll tests**

---

### Task 4: Logical printer identity and no-IP receipt selection

**Files:**
- Modify: `backend/services/printDispatch.js`
- Modify: `backend/services/printJobIdentity.js`
- Modify: `backend/routes/print.js`
- Modify: `backend/services/printReprint.js`
- Modify: `backend/tests/unit/printJobIdentity.test.js`
- Modify: `backend/tests/unit/print.unit.test.js`
- Modify: `backend/tests/integration/printReprint.test.js`

**Interfaces:**
- Every new payload has top-level numeric `printer_id`.
- `resolveReceiptPrinter({ printerId })` accepts an explicit active receipt printer, auto-selects the sole active receipt printer, and rejects ambiguous or invalid selection.
- `printKitchenOrder` derives a stable original batch from its order identity when a caller does not supply one; it never generates a random fallback.

- [x] **Step 1: Write failing tests for numeric printer identity, ambiguous receipt selection, and stable kitchen retry identity**
- [x] **Step 2: Confirm the existing IP-first and random-batch behavior fails those tests**
- [x] **Step 3: Add numeric `printer_id` to receipt and kitchen payload builders and make it the identity source**
- [x] **Step 4: Remove `clientIp`/`assigned_ips` routing and fail closed when multiple receipt printers exist without a valid local choice**
- [x] **Step 5: Preserve printer ownership across explicit audited reprints and rerun focused print tests**

---

### Task 5: Spooler duplicate journal and settings wiring

**Files:**
- Modify: `pos-spooler-printer/server.js`
- Create: `spooler-shared/durable-seen-store.cjs`
- Create: `backend/tests/unit/spoolerDurableSeenStore.test.js`
- Modify: `backend/services/printQueue.js`
- Modify: `backend/services/printReprint.js`
- Modify: `backend/routes/admin/printers.js`
- Modify: `backend/tests/integration/printersValidation.test.js`
- Modify: `src/admin/pages/Settings.vue`
- Modify: `src/components/pos/TerminalSettingsModal.vue`
- Modify: `assets/js/composables/useTerminal.js`
- Modify: `assets/js/admin/i18n.js`
- Modify: `docs/printing-runbook.md`

**Interfaces:**
- Spooler socket auth includes `SPOOLER_ID`; default station ID is `primary`.
- Durable records distinguish `printing` from `completed`.
- A recovered kitchen job left in `printing` is reported as uncertain and dead-lettered for an explicit audited reprint rather than automatically printed twice.
- Printer editor sends `spooler_id` and no longer exposes assigned terminal IPs.

- [x] **Step 1: Write failing durable-journal and duplicate-endpoint validation tests**
- [x] **Step 2: Persist `printing` before physical output and `completed` immediately after a successful send; keep completed redelivery as success-without-print**
- [x] **Step 3: Dead-letter uncertain recovered kitchen attempts and allow the existing audited reprint action to create a new explicit job**
- [x] **Step 4: Validate printer owner/endpoint in the admin route and translate duplicate-key failures to HTTP 409**
- [x] **Step 5: Replace IP assignment controls with a print-station selector, show each printer's station, and remove terminal IP copy from the POS modal**
- [x] **Step 6: Document `primary` plus unique secondary `SPOOLER_ID` installation and rerun spooler, API, Vue, and build checks**

---

## Adversarial Review — Attempts to Break the Plan

1. **Two socket spoolers use the same ID:** registry rejects the second live connection; it cannot enter the owner room or claim.
2. **Socket and HTTP fallback overlap briefly:** transactional claims use different claimant IDs, so one row can be leased only once; both still filter to the same stable owner.
3. **Station B asks for station A's job:** the claim query joins through `printers.spooler_id`, so B receives no row even after A's lease expires.
4. **A category matches the same printer through parent and child:** the existing `tickets[printer.id]` map remains the single job boundary.
5. **Two database rows point to the same active physical endpoint:** the generated unique key rejects the second row, including concurrent requests.
6. **The same item intentionally routes to grill and expo:** different printer IDs produce one job per destination, which remains valid.
7. **A kitchen HTTP request is retried:** stable batch + printer ID + payload hash returns the existing queue row.
8. **A table receives new items later:** the table workflow keeps its explicit unique batch for the new-item delta, so the new ticket is not collapsed into the earlier one.
9. **A spooler prints but its ACK is lost:** completed journal causes redelivery to ACK without printing.
10. **The process dies between starting and recording completion:** a recovered kitchen attempt becomes dead-letter/manual review, avoiding an automatic duplicate at the cost of an explicit operator decision.
11. **A receipt terminal has no local choice:** one configured receipt printer remains automatic; two or more fail clearly instead of falling back to another cashier's printer.
12. **A printer is reassigned while jobs are pending:** owner filtering follows the current printer assignment; leases already held remain with their claimant until ACK/expiry, preventing concurrent execution.
13. **An old queue row stored a printer name rather than ID:** migration maps known values and nulls unmatched historical rows; only new numeric identities are claimable.
14. **A secondary spooler is installed without changing `SPOOLER_ID`:** it is rejected as duplicate `primary`, which is safer than silently sharing work.

The review removed two unsafe ideas: guessing owners from hostnames/IP reachability, and broadcasting jobs with client-side filtering. Ownership is explicit and server-enforced.

