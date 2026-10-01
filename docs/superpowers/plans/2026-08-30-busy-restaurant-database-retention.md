# Successful Print Queue Purge Implementation Plan

> **For agentic workers:** Execute task by task on ordinary branch `codex/successful-print-queue-purge`; never create a worktree. Use RED/GREEN and one commit per task. Do not deploy, merge, push, bump a release, or widen cleanup beyond this plan.

**Goal:** Treat `print_queue` as a transient delivery outbox and automatically hard-delete successfully printed jobs from completed business days.

**Architecture:** Keep a queue row while delivery is unresolved. After the configured business-day boundary, hard-delete only `acknowledged` rows whose creation and acknowledgement both precede the current business day. Add no archive, compression, tombstone, history table, permanent print ledger, session cleanup, or schema migration.

**Tech Stack:** Node.js 22, Express 5, mysql2 3, MariaDB/InnoDB, Vitest 4, and the existing business-date utilities.

## Global Constraints

- The only routine deletion target is `print_queue.status='acknowledged'`.
- Never delete `pending`, `processing`, `sent`, `local_accepted`, `cancel_requested`, `failed`, `dead_letter`, or `canceled` rows.
- `acknowledged_at` is the terminal clock. `created_at` is only an additional safe/index-friendly bound; never delete by creation time alone.
- Deletion is permanent. Old queue-based reprint, diagnostics, exact payload recovery, and print-layer idempotency are intentionally gone after purge.
- Do not touch orders, order items, subscriptions, audit events, audit reports, refunds, expenses, JoFotara documents, auth sessions, or any other business data.
- Keep protocol version 2. Add no V3 name, broker, Redis, WebSocket print path, worker process, environment variable, setting, or admin UI.
- Reuse `idx_print_queue_state_created(status,created_at)`. A day-bounded table does not justify another index or migration.
- Purge in 500-row statements, never overlap runs, start after readiness, and stop before closing the pool.
- Emit one aggregate log per completed purge cycle and one warning per failed cycle; never log individual jobs or payloads.

## Verified Decisions

1. The server inserts one row per physical print intent; spooler sync updates it. Polls do not insert rows.
2. If an authenticated agent submits a terminal result for an absent queue ID, there is no server row left to mutate. The server may confirm that missing ID so the agent clears its local outbox. An existing row owned by another agent must remain unconfirmed.
3. Subscription reversal must stop reading old queue payloads. It will rebuild its void ticket from canonical redemption items, the subscription/customer snapshot, and current kitchen routing.
4. When a reprint succeeds, its dead-letter parent represents a fulfilled print intent and becomes `acknowledged`; both rows then become ordinary purge candidates. A failed reprint never resolves its parent.
5. Confirmed print-template proof survives through `print_template_revision_tests` (`queue_id` is `ON DELETE SET NULL`). An unconfirmed test expires at rollover. Publishing is not gated by that queue history.
6. Audit reports retain their own canonical payload and print result in `audit_report_documents`.
7. After purge, the same historical print idempotency key can create a new row. This finite delivery-window guarantee is explicitly accepted; canonical business transaction idempotency remains unchanged.

## Measured Query Evidence

On the current local MariaDB schema, the exact candidate `SELECT` for this plan reports `type=range`, `key=idx_print_queue_state_created`, and `Extra=Using where`; it does not filesort. That is why the safe additional `created_at < cutoff` predicate is retained and no seventh queue index is added. The real-DB test must repeat `EXPLAIN` after implementation rather than trusting this one local measurement.

## Non-goals

- No print history, archive, tombstone, compressed payload, or historical print screen.
- No unlimited direct queue reprint.
- No cleanup of failed work or any non-print table.
- No `OPTIMIZE TABLE`, partition, cron/Task Scheduler job, database event, or second process.

---

### Task 1: Make settled queue rows disposable

**Files:**
- Modify: `backend/services/spoolerSync.js`
- Test: `backend/tests/integration/spoolerV2Sync.test.js`
- Test: `backend/tests/integration/printReprint.test.js`

**Produces:** Missing terminal results are confirmable without trusting a foreign existing row; missing acceptance-only records remain blocked; successful reprints close their original intent.

- [ ] **Step 1: Add RED missing-result and foreign-owner sync tests**

Use the existing registration/claim helpers in `spoolerV2Sync.test.js` to prove:

```js
expect((await sync(agent, {
  results: [{ queue_id: deletedId, outcome: 'completed' }], capacity: 0
})).body).toMatchObject({
  confirmed_results: [deletedId]
});
```

For an existing row assigned to `otherAgent`, `confirmed_results` must remain empty. Add a separate missing-row request containing only `accepted`; `confirmed_accepted` must remain empty. This is load-bearing: a missing acceptance-only row might represent unrelated database loss, so the server must not authorize that untracked job to continue. A terminal result is different because the physical attempt has already ended, and confirming it only removes local journal state.

- [ ] **Step 2: Prove RED**

```powershell
npx vitest run backend/tests/integration/spoolerV2Sync.test.js -t "retired|another agent" --no-file-parallelism
```

Expected: the retired terminal-result case fails because absent rows are ignored; foreign ownership and missing acceptance-only records remain protected.

- [ ] **Step 3: Distinguish a missing terminal result from a foreign existing row**

Read by queue ID without filtering the owner:

```js
const [[row]] = await conn.query(
  'SELECT status, agent_id, payload, reprint_of_queue_id FROM print_queue WHERE id=?',
  [queueId]
);
if (!row) {
  response.confirmedResults.push(queueId);
  continue;
}
if (row.agent_id !== locked.agent_id) continue;
```

Apply this only in the `results` loop. Leave the accepted-loop missing-row behavior unchanged. For existing matching rows, preserve every current hash, status, cancellation, settlement, and audit-report rule. Never treat a hash mismatch or foreign row as retired. `confirmResults()` archives the whole terminal local record, so a separate missing-row acceptance confirmation is unnecessary.

- [ ] **Step 4: Resolve the parent only after a successful reprint**

After a child actually moves to `acknowledged`, use its `reprint_of_queue_id` inside the same transaction:

```sql
UPDATE print_queue
   SET status='acknowledged',
       acknowledged_at=COALESCE(acknowledged_at,UTC_TIMESTAMP()),
       locked_until=NULL,
       next_retry_at=NULL,
       last_seen_at=UTC_TIMESTAMP()
 WHERE id=? AND status='dead_letter'
```

Do nothing to the parent for `dead_letter`, `canceled`, or any non-success child outcome.

- [ ] **Step 5: Add reprint assertions and run GREEN**

Assert a dead-letter parent becomes acknowledged only when its reprint succeeds and `getFailedPrintJobsCount()` stays resolved. Preserve a case where a failed reprint leaves the parent dead-lettered.

```powershell
npx vitest run backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/printReprint.test.js --no-file-parallelism
```

- [ ] **Step 6: Commit**

```powershell
git add backend/services/spoolerSync.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/printReprint.test.js
git commit -m "fix(printing): make settled queue rows disposable"
```

---

### Task 2: Remove subscription reversal's queue-history dependency

**Files:**
- Modify: `backend/routes/admin/subscriptions.js`
- Modify: `backend/routes/pos/subscriptions.js`
- Modify: `backend/services/SubscriptionService.js`
- Test: `backend/tests/integration/subscriptionManagement.test.js`

**Produces:** Subscription void tickets are generated without reading `print_queue.payload`.

- [ ] **Step 1: Add a RED reversal-after-purge test**

Create a redemption through the existing fixture, acknowledge and delete its kitchen queue rows, then reverse it. Assert HTTP 200 and at least one new payload matching:

```js
expect(payload.data.print_batch_id).toBe(`subscription-redemption-void-${redemptionId}`);
expect(payload.data.subscription_redemption.is_void).toBe(true);
```

- [ ] **Step 2: Prove RED**

```powershell
npx vitest run backend/tests/integration/subscriptionManagement.test.js -t "after.*queue.*purge" --no-file-parallelism
```

Expected: 409, because the route currently requires the original queue payload.

- [ ] **Step 3: Rebuild from canonical rows and current routing**

In `backend/routes/admin/subscriptions.js`:

- import `buildKitchenPrintPayloads` from `../../services/kitchenPrintRouting`;
- move the existing one-line `redemptionReference(subscriptionId, redemptionId)` helper from `backend/routes/pos/subscriptions.js` into `backend/services/SubscriptionService.js`, export it, and import the same helper in both routes; do not duplicate its `S<subscription>-<padded-redemption>` format;
- retain the object returned by the existing locked `loadSubscriptionSummary()` call;
- remove the `SELECT payload FROM print_queue` block;
- query `subscription_redemption_items` joined to `products` for `category_id`;
- parse nullable `selected_modifiers` and `bundle_items` as arrays;
- build before restoring stock or updating the redemption:

```js
const kitchenItems = items.map(item => ({
  id: Number(item.id), product_id: Number(item.product_id),
  name: item.name, qty: Number(item.qty), note: item.note || null,
  category_id: Number(item.category_id),
  selectedModifiers: parseArray(item.selected_modifiers),
  bundleItems: parseArray(item.bundle_items)
}));

const { payloads: voidPayloads } = await buildKitchenPrintPayloads(conn, {
  print_batch_id: `subscription-redemption-void-${redemptionId}`,
  date: new Date().toISOString(), void_ticket: true,
  order_type_name: 'Subscription Meal', table_number: '', items: kitchenItems,
  subscription_redemption: {
    reference: redemptionReference(subscriptionId, redemptionId),
    customer_name: subscription.customer.name,
    customer_phone: subscription.customer.phone,
    is_void: true
  }
});
if (!voidPayloads.length) {
  throw routeError('The subscription meal no longer has a kitchen printer route.', 409);
}
```

Enqueue `voidPayloads`. A routing failure must roll back before stock or subscription state changes.

- [ ] **Step 4: Run focused GREEN tests**

```powershell
npx vitest run backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/subscriptionRedemptions.test.js --no-file-parallelism
```

- [ ] **Step 5: Commit**

```powershell
git add backend/routes/admin/subscriptions.js backend/routes/pos/subscriptions.js backend/services/SubscriptionService.js backend/tests/integration/subscriptionManagement.test.js
git commit -m "refactor(subscriptions): rebuild void tickets without queue history"
```

---

### Task 3: Add the bounded business-day purge

**Files:**
- Create: `backend/services/printQueuePurge.js`
- Create: `backend/tests/unit/printQueuePurge.test.js`
- Create: `backend/tests/integration/printQueuePurge.test.js`

**Produces:** `createPrintQueuePurge({ db, logger, now, setTimeoutFn, clearTimeoutFn })` exposing `start()`, `stop()`, and `runBatch()`. `now` defaults to `() => new Date()` and test doubles must also return a `Date`.

- [ ] **Step 1: Write RED unit tests for the exact SQL and scheduler**

Assert `runBatch()` issues only:

```sql
DELETE FROM print_queue
 WHERE status='acknowledged'
   AND created_at < ?
   AND acknowledged_at IS NOT NULL
   AND acknowledged_at < ?
 ORDER BY created_at,id
 LIMIT 500
```

Both parameters equal `getBusinessDayRange(getBusinessDate(now())).start`.

Also assert: `start()` does not query inline; a 500-row batch schedules another batch; a partial batch schedules after the next business boundary; two starts cannot overlap; failure warns once and retries after five minutes; `stop()` clears the timer and awaits in-flight work.

- [ ] **Step 2: Write the real-MariaDB RED cases**

Insert one row per queue status plus:

- old-created / old-acknowledged success;
- old-created / current-day-acknowledged success;
- current-day success;
- acknowledged row with null `acknowledged_at`.

Assert only the first row is removed. Insert 501 eligible rows and prove 500 then 1 then 0 deletions. Reinsert a deleted idempotency key and prove a fresh pending row is allowed; this pins the intentionally finite print-layer deduplication window.

Run `EXPLAIN` on the equivalent candidate `SELECT id ... ORDER BY created_at,id LIMIT 500` and assert `key === 'idx_print_queue_state_created'` and `Extra` does not contain `filesort`. If MariaDB does not choose that index on the populated fixture, stop and report the plan contradiction instead of adding an index ad hoc.

- [ ] **Step 3: Prove RED**

```powershell
npx vitest run backend/tests/unit/printQueuePurge.test.js backend/tests/integration/printQueuePurge.test.js --no-file-parallelism
```

- [ ] **Step 4: Implement the small service**

Rules:

- first catch-up batch 60 seconds after `start()`;
- exactly 500 deletions schedules another batch after two seconds;
- fewer than 500 schedules 60 seconds after the next configured business-day boundary;
- errors are non-fatal and retry after five minutes;
- only one timer and one in-flight promise;
- `stop()` prevents rescheduling and returns the current in-flight promise;
- log one cycle total only when at least one row was deleted.

Do not open an explicit transaction: each bounded `DELETE` is one atomic statement. Do not add an index; the safe `created_at` bound uses the existing `(status,created_at)` index while `acknowledged_at` prevents late-settlement deletion.

Calculate the next boundary without local-time parsing ambiguity:

```js
const current = now();
const nextBusinessDate = addBusinessDays(getBusinessDate(current), 1);
const nextStartSql = getBusinessDayRange(nextBusinessDate).start;
const nextStartMs = Date.parse(`${nextStartSql.replace(' ', 'T')}Z`);
const delayMs = Math.max(1000, nextStartMs - current.getTime() + 60_000);
```

The 60-second startup catch-up means downtime at the boundary cannot permanently miss a purge. If the returned timer supports `unref()`, call it so maintenance alone never keeps Node alive.

- [ ] **Step 5: Run GREEN**

```powershell
npx vitest run backend/tests/unit/printQueuePurge.test.js backend/tests/integration/printQueuePurge.test.js --no-file-parallelism
```

- [ ] **Step 6: Commit**

```powershell
git add backend/services/printQueuePurge.js backend/tests/unit/printQueuePurge.test.js backend/tests/integration/printQueuePurge.test.js
git commit -m "feat(printing): purge successful jobs by business day"
```

---

### Task 4: Wire lifecycle and architecture truth

**Files:**
- Modify: `server.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

**Produces:** Purge starts after schema readiness and stops before pool shutdown.

- [ ] **Step 1: Wire one server-owned instance**

```js
const printQueuePurge = createPrintQueuePurge({ db, logger });
```

Call `start()` inside `onServerStarted()`. During graceful shutdown, call `stop()` before pool closure and await it with existing database maintenance. Never purge synchronously inside `startServer()`.

- [ ] **Step 2: Update architecture truth**

Record that:

- `print_queue` is durable unresolved-delivery state, not permanent print history;
- successful prior-business-day rows are hard-deleted;
- queue reprint and print-layer idempotency expire with the row;
- an authenticated missing terminal result is confirmable, but a missing acceptance-only record and an existing foreign-owned row are not;
- subscription reversal rebuilds from canonical redemption items and current routes;
- failed/nonterminal states are never purged.

Remove or rewrite invariants claiming queue identities and payloads live forever.

```powershell
npm run architecture
npm run architecture:check
```

- [ ] **Step 3: Run the focused closure suite**

```powershell
npx vitest run backend/tests/unit/printQueuePurge.test.js backend/tests/integration/printQueuePurge.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/printReprint.test.js backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/subscriptionRedemptions.test.js --no-file-parallelism
npm run architecture:check
```

- [ ] **Step 4: Reject accidental scope growth**

The final tracked diff must not introduce any of:

```text
payload_archive
payload_retired
COMPRESS(
UNCOMPRESS(
auth_sessions
OPTIMIZE TABLE
CREATE TABLE print_queue_history
```

- [ ] **Step 5: Commit**

```powershell
git add server.js docs/architecture.json docs/architecture.html
git commit -m "docs(printing): define the transient queue lifecycle"
```

## Definition of Done

1. Only old `acknowledged` rows are hard-deleted.
2. No archive, tombstone, compressed payload, history table, or permanent print ledger exists.
3. Lost settlement responses followed by purge cannot strand the agent outbox.
4. Missing acceptance-only records and existing foreign-owned rows remain protected.
5. Successful reprints resolve their parent; unsuccessful reprints do not.
6. Subscription reversal works after original acknowledged kitchen rows are gone.
7. Audit reports and confirmed template-test proof remain in their canonical tables.
8. Every non-success queue state remains untouched.
9. Purge is business-day-aware, bounded, non-overlapping, non-fatal, delayed, and shutdown-safe.
10. Loss of old queue reprint, diagnostics, payload recovery, and print-layer deduplication is explicit and tested.

## Execution Handoff

Execute inline, task by task, on `codex/successful-print-queue-purge`. Review each diff and focused test result before continuing. Do not create a worktree, deploy, merge, or push.
