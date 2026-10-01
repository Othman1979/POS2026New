# Spooler Professional Printing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to execute this plan.

**Goal:** Make printing traceable, recoverable, and faster-feeling on unstable customer networks without breaking Arabic output, without adding cloud polling latency, and without committing the ignored spooler source folder.

**Architecture:** Keep the existing pipeline shape: POS app -> MySQL `print_queue` -> Socket.IO push -> local Node spooler -> thermal printer. Upgrade the queue into the durable owner of print lifecycle, keep WebSocket push as the zero-latency path, add down-only polling as recovery, and add printer-status tiers where devices support them.

**Tech Stack:** Node.js backend, MySQL/MariaDB, Socket.IO, local Node spooler, Puppeteer image rendering, ESC/POS thermal printers.

---

## Global Constraints

- Arabic item/customer/report names are first-class. Do not add native ESC/POS text rendering for kitchen tickets or receipts.
- Puppeteer image rendering remains the rendering path because it preserves Arabic shaping and RTL layout.
- `pos-spooler-printer/` is intentionally git-ignored. Do not `git add -f pos-spooler-printer/`. Spooler source edits must be documented in `docs/SPOOLER-CHANGES.md` and manually deployed on print machines.
- This product is one branch, one setup, one spooler key. Do not design multi-tenant branch routing or per-branch spooler secrets.
- WebSocket remains primary. Polling is only a disconnected fallback and must sleep while Socket.IO is healthy.
- `acknowledged` means the spooler send function completed and bytes were handed to the printer or OS. It does not mean paper physically printed.
- Printer physical status belongs in `device_status`, not in the queue lifecycle state.
- Reprints create new audited queue rows. Never mutate a completed queue row back into pending.
- Existing `print_queue.created_at` is the queued timestamp. Do not add redundant `queued_at`.
- Existing staff/customer sessions must not access spooler poll or ack endpoints. Spooler endpoints authenticate with `SPOOLER_KEY`.

---

## Phase 0: Guardrails And Baseline

### Task 0.1: Start Isolated Work And Freeze Scope

**Files:**
- `docs/spooler-professional-architecture-research.md`
- `docs/SPOOLER-CHANGES.md`
- `docs/superpowers/plans/2026-07-05-spooler-professional-printing.md`

**Steps:**

1. Create branch `codex/spooler-professional-printing`.
2. Confirm `docs/spooler-professional-architecture-research.md` is tracked or staged with this plan.
3. Confirm `pos-spooler-printer/` remains ignored:

```bash
git check-ignore -v pos-spooler-printer/server.js
```

4. Add a short header to `docs/SPOOLER-CHANGES.md` explaining that the spooler has manual deploy patches in later phases.

**Acceptance Criteria:**

- Branch exists and contains only tracked docs/app files.
- `pos-spooler-printer/server.js` is not staged.
- The research doc and phased plan agree on O1 -> O2b -> O3.

---

### Task 0.2: Add Backend Timing Logs Without Payload Logging

**Files:**
- `backend/services/printDispatch.js`
- `backend/services/printQueue.js`
- `server.js`
- `backend/tests/integration/printQueue.test.js`

**Steps:**

1. Add timing marks for enqueue, claim, emit, ack receive, settle.
2. Log only safe metadata:
   - `queue_id`
   - `print_type`
   - `printer_id`
   - `state`
   - duration fields
   - attempt count
3. Do not log payload text, item names, customer names, table notes, report HTML, or receipts.
4. Add test coverage that queue settlement stores duration data without exposing payload content in returned values.

**Implementation Shape:**

```js
function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function safePrintJobLogFields(job) {
  return {
    queue_id: job.id,
    print_type: job.print_type,
    printer_id: job.printer_id,
    state: job.state || job.status,
    attempts: job.attempts
  };
}
```

**Acceptance Criteria:**

- Timings are visible in server logs for a test print.
- No payload body or Arabic item/customer/report text appears in logs.
- Tests pass.

---

## Phase 1: O1 Durable Queue Lifecycle

### Task 1.1: Expand `print_queue` Schema In Place

**Files:**
- `backend/migrations/2026-07-05-print-queue-durable-lifecycle.sql`
- `backend/tests/fixtures/seed.js`
- `backend/services/printQueue.js`
- `backend/tests/integration/printQueue.test.js`

**Steps:**

1. Add a migration that evolves `print_queue` in place.
2. Preserve existing rows.
3. Keep `created_at` as queued time.
4. Add lifecycle, identity, timing, retry, and device-status fields.
5. Update test fixture schema to match production.
6. Update `ensurePrintQueueSchema` to be compatible with the expanded schema.

**Schema Target:**

```sql
ALTER TABLE print_queue
  MODIFY status ENUM(
    'pending',
    'processing',
    'sent',
    'acknowledged',
    'failed',
    'dead_letter',
    'canceled'
  ) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(160) NULL AFTER id,
  ADD COLUMN IF NOT EXISTS payload_hash CHAR(64) NULL AFTER payload,
  ADD COLUMN IF NOT EXISTS printer_id VARCHAR(128) NULL AFTER payload_hash,
  ADD COLUMN IF NOT EXISTS print_type VARCHAR(64) NULL AFTER printer_id,
  ADD COLUMN IF NOT EXISTS spooler_id VARCHAR(128) NULL AFTER claimed_by,
  ADD COLUMN IF NOT EXISTS spooler_version VARCHAR(64) NULL AFTER spooler_id,
  ADD COLUMN IF NOT EXISTS device_status ENUM(
    'unknown',
    'ok',
    'offline',
    'paper_low',
    'paper_out',
    'cover_open',
    'jammed',
    'error'
  ) NOT NULL DEFAULT 'unknown' AFTER last_error,
  ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 5 AFTER attempts,
  ADD COLUMN IF NOT EXISTS first_attempt_at DATETIME NULL AFTER max_attempts,
  ADD COLUMN IF NOT EXISTS sent_at DATETIME NULL AFTER first_attempt_at,
  ADD COLUMN IF NOT EXISTS acknowledged_at DATETIME NULL AFTER sent_at,
  ADD COLUMN IF NOT EXISTS duration_ms INT NULL AFTER acknowledged_at,
  ADD COLUMN IF NOT EXISTS next_retry_at DATETIME NULL AFTER duration_ms,
  ADD COLUMN IF NOT EXISTS reprint_of_queue_id BIGINT NULL AFTER next_retry_at,
  ADD COLUMN IF NOT EXISTS last_seen_at DATETIME NULL AFTER reprint_of_queue_id,
  ADD UNIQUE KEY IF NOT EXISTS uq_print_queue_idempotency (idempotency_key),
  ADD KEY IF NOT EXISTS idx_print_queue_state_locked (status, locked_until),
  ADD KEY IF NOT EXISTS idx_print_queue_state_created (status, created_at),
  ADD KEY IF NOT EXISTS idx_print_queue_reprint_of (reprint_of_queue_id);
```

**Test First:**

- Add a test that inserts an old minimal row and confirms claim/settle still works after schema ensure.
- Add a test that verifies success settlement keeps the row and sets `status='acknowledged'`.

**Acceptance Criteria:**

- Existing tests that expected delete-on-success are updated to expect durable history.
- A successful print row remains queryable.
- Migration is repeatable in local dev.

---

### Task 1.2: Add Deterministic Print Job Identity

**Files:**
- `backend/services/printJobIdentity.js`
- `backend/services/printDispatch.js`
- `backend/tests/unit/printJobIdentity.test.js`
- `backend/tests/integration/printQueue.test.js`

**Steps:**

1. Create a deterministic JSON serializer for payload hashing.
2. Generate `payload_hash = sha256(stable_payload_json)`.
3. Generate `idempotency_key` before insert.
4. Require a fresh `print_batch_id` for each kitchen-fire event.
5. Do not key kitchen jobs only by held order or table.

**Identity Rules:**

```js
function buildPrintIdempotencyKey(payload, payloadHash) {
  const printerId = payload.printer_id || payload.printer_name || 'unknown-printer';
  const type = payload.print_type || 'unknown-type';

  if (type === 'kitchen') {
    const batchId = payload.data?.print_batch_id;
    if (!batchId) throw new Error('Kitchen print job missing print_batch_id');
    return `kitchen:${batchId}:${printerId}:${payloadHash}`;
  }

  if (payload.reprint_of_queue_id) {
    return `reprint:${payload.reprint_of_queue_id}:${printerId}:${payload.data?.reprint_sequence}:${payloadHash}`;
  }

  if (type === 'receipt' && payload.data?.invoice_id) {
    return `receipt:${payload.data.invoice_id}:${printerId}:original:${payloadHash}`;
  }

  if (type.endsWith('_report') || type === 'daily_report') {
    const documentId = payload.data?.audit_report_document_id || payload.data?.report_id || payloadHash;
    const copyLabel = payload.data?.copy_label || 'original';
    return `report:${type}:${documentId}:${printerId}:${copyLabel}`;
  }

  return `job:${type}:${printerId}:${payloadHash}`;
}
```

**Tests:**

- Same payload produces same hash.
- Different item quantity produces different hash.
- Same open table can produce two valid kitchen print jobs when `print_batch_id` differs.
- Duplicate same kitchen batch/printer/payload collapses to one queued row.
- Arabic strings hash deterministically.

**Acceptance Criteria:**

- Every newly inserted print job has `idempotency_key`, `payload_hash`, `print_type`, and `printer_id`.
- Kitchen duplicates within the same batch do not double-print.
- A later legitimate kitchen fire for the same table can still print.

---

### Task 1.3: Replace Delete-On-Success With Durable Settlement

**Files:**
- `backend/services/printQueue.js`
- `backend/services/printDispatch.js`
- `server.js`
- `backend/tests/integration/printQueue.test.js`

**Steps:**

1. Change `claimPrintJobs` to claim only active work:
   - `pending`
   - `failed` with retry due
   - expired `processing`
   - expired `sent`
2. Exclude terminal states:
   - `acknowledged`
   - `dead_letter`
   - `canceled`
3. When jobs are emitted to a connected spooler, mark them `sent` and set `sent_at`.
4. When spooler returns success, set:
   - `status='acknowledged'`
   - `acknowledged_at=UTC_TIMESTAMP()`
   - `duration_ms`
   - `device_status` from spooler response or `unknown`
   - `claimed_by=NULL`
   - `locked_until=NULL`
5. When spooler returns failure, set:
   - `status='failed'` when attempts remain
   - `status='dead_letter'` when attempts reach `max_attempts`
   - `last_error`
   - `next_retry_at`
   - `device_status`

**Implementation Shape:**

```js
async function settlePrintJob(db, {
  queueId,
  spoolerId,
  success,
  error,
  durationMs,
  deviceStatus = 'unknown',
  spoolerVersion = null
}) {
  // Locks row by id and claimed spooler before state transition.
}
```

**Tests:**

- Success no longer deletes the row.
- Acknowledged row cannot be reclaimed.
- Failed row retries after `next_retry_at`.
- Failed row becomes `dead_letter` after `max_attempts`.
- Wrong `spoolerId` cannot settle a claimed job.

**Acceptance Criteria:**

- Lost-ticket investigation can query historical queue rows.
- Existing print dispatch continues working over Socket.IO.
- Queue lifecycle is visible in DB without reading server logs.

---

### Task 1.4: Add Watchdog Queries And Dead-Letter Visibility

**Files:**
- `backend/services/printQueueWatchdog.js`
- `backend/services/printQueue.js`
- `server.js`
- `backend/tests/integration/printQueue.test.js`

**Steps:**

1. Add a watchdog service that summarizes:
   - stale `processing`
   - stale `sent`
   - `failed`
   - `dead_letter`
   - old `pending`
2. Run watchdog on a modest interval, such as 30 seconds.
3. Emit a log only when counts change or a threshold is crossed.
4. Add helper query for admin health UI.

**Implementation Shape:**

```js
async function getPrintQueueHealth(db) {
  const [rows] = await db.query(`
    SELECT status, COUNT(*) AS count, MIN(created_at) AS oldest_created_at
    FROM print_queue
    WHERE status IN ('pending', 'processing', 'sent', 'failed', 'dead_letter')
    GROUP BY status
  `);
  return rows;
}
```

**Tests:**

- Watchdog identifies stale sent rows.
- Watchdog does not spam identical healthy output.
- Dead-letter count is returned for UI/API.

**Acceptance Criteria:**

- Operators can identify stuck queue state without SSH log digging.
- Server logs do not create reconnect-style noise.

---

### Task 1.5: Add Audited Reprint Flow

**Files:**
- `backend/services/printReprint.js`
- `backend/routes/print.js` or the existing admin print route
- `backend/middleware/permissions.js`
- `backend/tests/integration/printReprint.test.js`

**Steps:**

1. Add a permission-gated reprint service.
2. Allow only admin/programmer or an existing explicit print-reprint permission such as `pos.reprint_receipt`.
3. Clone the original payload into a new queue row.
4. Set `reprint_of_queue_id`.
5. Generate a distinct reprint idempotency key.
6. Insert an `audit_events` row in the same transaction.
7. Dispatch the new job through the same queue path.

**Implementation Shape:**

```js
async function reprintQueueJob(db, {
  originalQueueId,
  userId,
  reason,
  printerIdOverride = null
}) {
  return db.transaction(async (tx) => {
    const original = await lockAcknowledgedPrintJob(tx, originalQueueId);
    const reprintPayload = buildReprintPayload(original.payload, {
      originalQueueId,
      printerIdOverride
    });
    const newJob = await enqueuePrintJob(tx, reprintPayload);
    await insertAuditEvent(tx, {
      action: 'print.reprint',
      original_queue_id: originalQueueId,
      new_queue_id: newJob.id,
      user_id: userId,
      reason
    });
    return newJob;
  });
}
```

**Tests:**

- Staff without permission cannot reprint.
- Authorized user can reprint acknowledged job.
- Reprint creates a new row and preserves original row.
- Audit event includes original/new queue ids and reason.
- Reprint does not reuse invoice creation logic.

**Acceptance Criteria:**

- Recovery from dumb-printer uncertainty is one audited action.
- Reprint cannot silently mutate history.

---

### Task 1.6: Manual Spooler Patch For Durable ACK And Dedup

**Tracked Files:**
- `docs/SPOOLER-CHANGES.md`

**Manual Files On Each Print Machine:**
- `pos-spooler-printer/server.js`
- `pos-spooler-printer/durable-seen-store.js`

**Steps:**

1. Document the local spooler patch in `docs/SPOOLER-CHANGES.md`.
2. Add a tiny durable seen-store keyed by `queue_id` plus `idempotency_key`.
3. Write the seen marker only after the physical send function returns success.
4. On restart, load recent seen markers before accepting jobs.
5. Include `duration_ms`, `device_status`, and `spooler_version` in `print_job_response`.
6. Keep local queue serialization unchanged.
7. Do not log payload contents.

**Manual Spooler Shape:**

```js
socket.emit('print_job_response', {
  queue_id: job.queue_id,
  idempotency_key: job.idempotency_key,
  success: true,
  error: null,
  duration_ms: Date.now() - startedAt,
  device_status: deviceStatus || 'unknown',
  spooler_version: SPOOLER_VERSION
});
```

**Durable Seen Store Rules:**

- Store only identifiers and timestamps.
- Prune entries older than 14 days on startup.
- Use atomic write to temp file then rename.
- Keep file in the spooler app data directory, not inside the public web root.

**Manual Verification:**

1. Print one kitchen ticket.
2. Restart spooler.
3. Re-send the same `queue_id`.
4. Confirm it does not physically print twice.
5. Confirm a new queue row with a new idempotency key prints.

**Acceptance Criteria:**

- Spooler restart no longer loses dedup memory.
- Backend receives timing and version data.
- `pos-spooler-printer/` remains unstaged.

---

## Phase 2: O2b WebSocket Hardening With Down-Only Poll Fallback

### Task 2.1: Add One-Active-Spooler Guard Without Reconnect Storm

**Files:**
- `server.js`
- `backend/services/spoolerRegistry.js`
- `backend/tests/integration/spoolerRegistry.test.js`
- `docs/SPOOLER-CHANGES.md`

**Manual Spooler File:**
- `pos-spooler-printer/server.js`

**Steps:**

1. Track active spooler by authenticated key and socket id.
2. Allow takeover only when the previous active socket is stale.
3. Reject a second live spooler with a clear reason.
4. Client must stop reconnecting after `spooler_rejected` or unauthorized response.
5. Add bounded reconnect backoff for normal disconnects.
6. Emit health only on state change.

**Server Shape:**

```js
function registerSpoolerConnection({ socketId, spoolerKeyHash, now }) {
  const active = getActiveSpooler(spoolerKeyHash);
  if (active && !isStale(active, now)) {
    return { accepted: false, reason: 'another_spooler_active' };
  }
  return { accepted: true };
}
```

**Manual Client Shape:**

```js
socket.on('spooler_rejected', ({ reason }) => {
  console.error(`Spooler rejected: ${reason}`);
  socket.io.opts.reconnection = false;
  socket.disconnect();
});
```

**Tests:**

- First spooler is accepted.
- Second live spooler is rejected.
- Stale active spooler can be replaced.
- Rejection message is emitted once.

**Acceptance Criteria:**

- No infinite reconnect loop.
- No Imunify360-style reconnect burst.
- Single-setup product assumption stays intact.

---

### Task 2.2: Add Reconnect Resync Over Existing Socket.IO

**Files:**
- `server.js`
- `backend/services/printDispatch.js`
- `backend/services/printQueue.js`
- `backend/tests/integration/printQueue.test.js`

**Steps:**

1. On spooler connect, immediately claim pending/retry-due jobs.
2. On spooler reconnect, also scan `sent` jobs whose lease expired.
3. Do not send `acknowledged`, `dead_letter`, or `canceled`.
4. Use the same claim and mark-sent functions as normal dispatch.

**Tests:**

- Pending jobs dispatch on connect.
- Expired sent jobs dispatch on reconnect.
- Acknowledged jobs never dispatch.

**Acceptance Criteria:**

- Short network drops recover without waiting for staff action.
- WebSocket remains the fastest path.

---

### Task 2.3: Add Down-Only HTTP Poll Fallback

**Files:**
- `server.js`
- `backend/routes/spoolerPoll.js`
- `backend/services/printQueue.js`
- `backend/tests/integration/spoolerPoll.test.js`
- `docs/SPOOLER-CHANGES.md`

**Manual Spooler File:**
- `pos-spooler-printer/server.js`

**Steps:**

1. Add `POST /api/spooler/poll` for authenticated spooler clients.
2. Authenticate with `SPOOLER_KEY` using constant-time comparison.
3. Reject browser/staff/customer sessions.
4. Rate-limit by source and key.
5. Return the same JSON print payload used by Socket.IO.
6. Add `POST /api/spooler/ack` or reuse a shared settle endpoint for poll results.
7. In the manual spooler patch, start polling only after Socket.IO has been disconnected for 5 seconds.
8. Stop polling immediately when Socket.IO reconnects.

**Poll Response Shape:**

```json
{
  "jobs": [
    {
      "queue_id": 123,
      "idempotency_key": "kitchen:batch:printer:hash",
      "print_type": "kitchen",
      "printer_id": "kitchen-1",
      "payload": {}
    }
  ],
  "next_poll_ms": 1000
}
```

**Tests:**

- Missing key returns 401.
- Wrong key returns 401.
- Staff session cannot poll.
- Valid spooler receives due jobs.
- Poll claim and WebSocket claim cannot claim the same row concurrently.
- Poll ack uses the same durable settlement as Socket.IO ack.

**Acceptance Criteria:**

- No added latency while WebSocket is healthy.
- Cloud network drops have a recovery path.
- Poll fallback cannot become a public print endpoint.

---

## Phase 3: O3 Printer Confirmation Tiers

### Task 3.1: Store Printer Capability And Device Status

**Files:**
- `backend/services/printerStatus.js`
- Existing printer settings route/model
- `backend/tests/integration/printerStatus.test.js`
- `docs/SPOOLER-CHANGES.md`

**Manual Spooler File:**
- `pos-spooler-printer/server.js`

**Steps:**

1. Add printer capability config:
   - `write_only`
   - `escpos_status`
   - `snmp_status`
2. Default unknown printers to `write_only`.
3. Store latest `device_status`, `checked_at`, and `source`.
4. Manual spooler patch reports preflight status when supported.
5. Backend stores status on queue settlement.

**Acceptance Criteria:**

- Unsupported cheap printers still print exactly as before.
- Supported printers can report paper-out/cover-open before send.
- UI/backend language distinguishes tentative send from confirmed device status.

---

### Task 3.2: Add Optional Preflight Probe Before Physical Send

**Tracked Files:**
- `docs/SPOOLER-CHANGES.md`

**Manual Spooler File:**
- `pos-spooler-printer/server.js`

**Steps:**

1. For `escpos_status` printers, run a short DLE EOT preflight before send.
2. For `snmp_status` printers, run a short SNMP probe before send.
3. Use strict timeouts so preflight cannot add long delays.
4. If status is paper-out/cover-open/offline, return failure without marking acknowledged.
5. If status is unsupported or times out, continue using write-only behavior and mark `device_status='unknown'`.

**Acceptance Criteria:**

- Capable printers catch paper-out before the job is treated as sent.
- Dumb printers are not blocked by unsupported probes.
- Staff can reprint from durable queue when the device cannot confirm.

---

## Phase 4: Operator UI And Runbook

### Task 4.1: Add Print Queue Health UI

**Files:**
- Existing admin/settings frontend files
- Backend print health route
- Frontend tests for the selected UI framework

**Steps:**

1. Add an admin/programmer-only print queue health view.
2. Show counts by state.
3. Show oldest pending/failed/dead-letter age.
4. Show active spooler status and last heartbeat.
5. Show last device status per printer.
6. Add an audited reprint action for eligible rows.
7. Do not show full receipt/report payload by default.

**Acceptance Criteria:**

- Admin can see if printing is stuck without DB access.
- Reprint is permission-gated and audited.
- Sensitive receipt/report contents are not casually exposed.

---

### Task 4.2: Write Deployment And Rollback Runbook

**Files:**
- `docs/SPOOLER-CHANGES.md`
- `docs/printing-runbook.md`

**Steps:**

1. Document DB migration order.
2. Document app deployment order.
3. Document manual spooler update steps.
4. Document test print checklist:
   - Arabic kitchen ticket
   - Arabic customer receipt
   - tall audit report
   - failed printer/offline case
   - reprint case
5. Document rollback:
   - stop app
   - revert app build
   - keep durable queue rows
   - restore previous local spooler package
6. Document what `acknowledged` means and does not mean.

**Acceptance Criteria:**

- Another agent or technician can deploy without rediscovering the architecture.
- Manual spooler patch instructions are complete enough for each print machine.
- Rollback does not require deleting print history.

---

## Recommended Execution Order

1. Phase 0: Guardrails and timing.
2. Phase 1 Tasks 1.1 through 1.4: durable lifecycle and watchdog.
3. Phase 1 Task 1.6: manual spooler ACK/dedup patch.
4. Phase 1 Task 1.5: audited reprint flow.
5. Phase 2 Tasks 2.1 and 2.2: WebSocket hardening and reconnect resync.
6. Phase 2 Task 2.3: down-only poll fallback.
7. Phase 3: printer confirmation tiers.
8. Phase 4: operator UI and runbook.

## Verification Matrix

| Scenario | Expected Result |
| --- | --- |
| Normal WebSocket print | Job goes `pending` -> `processing` -> `sent` -> `acknowledged` |
| Spooler sends success | Row remains in `print_queue` with `acknowledged_at` |
| Spooler sends failure | Row becomes `failed` or `dead_letter` |
| Spooler restarts | Durable seen-store prevents same `queue_id` double print |
| Same kitchen batch retries | Duplicate idempotency key prevents double print |
| Same table fires new items later | New `print_batch_id` allows print |
| Socket.IO disconnects | Poll fallback starts after grace window |
| Socket.IO reconnects | Poll fallback stops |
| Second spooler starts | Rejected once, then stops reconnecting |
| Staff tries poll endpoint | 401/403 |
| Admin reprints | New queue row plus audit event |
| Dumb printer paper-out | Job may be acknowledged as tentative; reprint path is available |
| Capable printer paper-out | Job fails before send with `device_status='paper_out'` |

## Notes For Implementers

- Do not optimize rendering in this plan. The owner has identified network/reliability as the likely cause, and Arabic output makes native text unsafe.
- Do not add manager PIN override. Permission checks should use existing admin/programmer or explicit permission patterns.
- Do not create invoice/order identifiers during saved/printed table printing. Print jobs reflect existing saved/printed data and must not behave like checkout.
- Keep every task shippable alone. Phase 1 is the foundation; later phases must not require rewriting Phase 1.
