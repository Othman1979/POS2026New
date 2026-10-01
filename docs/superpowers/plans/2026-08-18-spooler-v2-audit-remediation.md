# Spooler V2 Audit Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-08-18
**Status:** Proposed, NOT executed
**Branch:** `codex/spooler-v2-local-print-agent-continued`
**Fixes:** every finding in `docs/superpowers/evidence/2026-08-18-spooler-v2-adversarial-audit.md` (rev 2). Finding IDs here are that document's IDs, unchanged.
**Relationship to the design plan:** this plan does **not** modify `docs/superpowers/plans/2026-08-17-spooler-v2-local-print-agent.md` (rev 2.1). Every task below restores the implementation to something rev 2.1 already requires. Where the code contradicts rev 2.1, the code changes — not the plan.

**Goal:** close all five HIGH defects and ten MEDIUM defects found by the adversarial audit, so no V2 station can print duplicate paper, silently swallow a kitchen ticket, or strand itself, before any real station is cut over.

**Architecture of the fix:** every correction is structural and small — a state barrier in the journal, one SQL predicate, a lock moved into the process that prints, a missing lane restart, an entry-point restore. No redesign, no threshold tuning. Rev 2.1's invariants are the acceptance criteria.

**Tech Stack:** Node/Express + mysql2 (server), plain-Node agent package with `assert`-based tests run by `pos-spooler-printer/tests/run-tests.js`, Vitest for backend, C# .NET Framework 4.8 helper.

## Why V1 still exists (read before Task 2)

The plan is implemented; the **rollout has not happened**. Every customer printer machine still runs the V1 spooler today, and V2 takes a station only when someone installs it there (rev 2.1 §5.2: lab → one canary → station by station). The server must therefore speak both protocols, or every un-migrated station stops printing the day the server deploys. V1 delivery is deleted only after two stable V2 releases, in a separate reviewed change.

Consequence for this plan: **H2 and M1 are V1↔V2 interaction defects and cannot be fixed by deleting V1.** They need their guards now and keep them until V1 delivery is retired.

## Global Constraints

- One vitest process at a time (shared `posapp_test`); focused files during work, full suite exactly once at the end.
- Spooler package tests: `cd pos-spooler-printer && node tests/run-tests.js` (each `*.test.js` is a standalone node script using `assert`).
- No merge, push, deploy, production migration, or Hostinger mutation. Local commits only.
- Migration files are written only by `luna_max` per CLAUDE.md; Task 12 is a draft-stage change requiring owner approval before any `.auto.sql`/manifest/fallback touch.
- Every task adds a test that **fails before the fix** — the audit's central finding is that all five HIGHs live in coverage gaps.
- Do not renumber audit findings. If a finding turns out not to reproduce, stop and report rather than silently dropping it.

---

# Phase A — Paper safety (blocks any station cutover)

## Task 1 — H1: a canceled job must never reach paper

**Finding:** `mutate()` has no terminal-state barrier, and the workers print from stale in-memory snapshots, so `canceled → rendered → transport_started → completed` succeeds and the ticket prints after the server was told it was canceled.

**Files:**
- Modify: `pos-spooler-printer/v2/job-store.js` (`mutate`, ~178-191)
- Modify: `pos-spooler-printer/v2/printer-workers.js` (`pumpRender` ~152-165, lane loop ~80-104, `finishFailure` ~40-68)
- Test: `pos-spooler-printer/tests/v2-printer-workers.test.js`, `pos-spooler-printer/tests/v2-job-store.test.js`

**Interfaces — Produces:** `mutate()` throws `JOB_TERMINAL` for any transition out of `completed | permanent_failure | uncertain | canceled`; workers treat `JOB_TERMINAL` as drop-ownership-without-result.

- [ ] **Step 1: Write the failing store test** (append to `v2-job-store.test.js`, matching its existing style):

```js
// A terminal record must refuse further transitions.
{
    const store = openJobStore({ stateRoot: freshRoot() });
    store.accept({ queue_id: 501, idempotency_key: 'k501', payload_hash: 'a'.repeat(64), printer_id: 1, print_type: 'kitchen' });
    store.requestCancel(501);
    assert.strictEqual(store.get(501).state, 'canceled');
    assert.throws(() => store.markRendered(501, { path: 'x.bin', hash: 'h', bytes: 1 }), /JOB_TERMINAL/);
    assert.throws(() => store.markTransportStarted(501), /JOB_TERMINAL/);
    assert.throws(() => store.recordResult(501, { outcome: 'completed' }), /JOB_TERMINAL/);
    assert.strictEqual(store.get(501).state, 'canceled');
}
```

- [ ] **Step 2: Write the failing worker race test** (append to `v2-printer-workers.test.js`; the file's `fakeStore` already exposes `get`, extend it to model terminal states):

```js
// Cancel arriving while the record sits in the render/lane queue must not print.
{
    const rows = [record(10, 1, 'receipt'), record(11, 1, 'kitchen')];
    const store = fakeStore(rows);
    const gate = deferred();
    const sent = [];
    const renderer = {
        async render(job) {
            if (job.queue_id === 10) await gate.promise;
            return { path: `${job.queue_id}.bin`, hash: 'h', bytes: 1 };
        },
        health: () => ({ state: 'ready' })
    };
    const transport = { async send({ printer }) { sent.push(printer.queue_id); return { success: true }; } };
    const workers = createPrinterWorkers({ store, renderer, transportFor: () => transport });
    workers.start();
    // job 11 is owned and waiting behind job 10's render; the sync loop cancels it
    rows[1].state = 'canceled';
    gate.resolve();
    await workers.idle();
    assert.deepStrictEqual(sent, [10], 'a canceled job must never be transported');
    assert.strictEqual(store.get(11).state, 'canceled');
}
```

- [ ] **Step 3: Run both to verify they fail**

```bash
cd pos-spooler-printer && node tests/v2-job-store.test.js
```

Expected: no throw on `markRendered` → assertion failure. Then the workers test: `sent` contains `11`.

- [ ] **Step 4: Add the journal barrier** in `job-store.js`:

```js
    function mutate(queueId, operation, transform) {
        const entry = getEntry(queueId);
        if (!entry || entry.archived) throw new Error('JOB_NOT_ACTIVE');
        const previous = entry.record;
        if (TERMINAL.has(previous.state)) throw new Error('JOB_TERMINAL');
        const next = transform(previous);
        ...
```

`requestCancel` already returns early for terminal and `transport_started` records (`job-store.js:247`), so it is unaffected. `confirmResults`/archival must keep working: verify they do not route through `mutate` for terminal records — if `confirmResults` uses `mutate`, give it a dedicated internal writer that bypasses the barrier (it is the one legitimate terminal-record write).

- [ ] **Step 5: Make the workers re-read state** in `printer-workers.js` — before rendering and before sending, and treat the barrier as a drop:

```js
    function currentState(record) {
        return store.get?.(record.queue_id)?.state ?? record.state;
    }
    function abandon(record) {
        owned.delete(record.queue_id);
    }
```

In `pumpRender`, immediately after `const record = renderQueue.shift();`:

```js
                if (!RUNNABLE_STATES.has(currentState(record))) { abandon(record); continue; }
```

In the lane loop, immediately after `const record = lane.queue.shift();`:

```js
                if (!RUNNABLE_STATES.has(currentState(record))) { abandon(record); continue; }
```

with `const RUNNABLE_STATES = new Set(['queued', 'rendered', 'retry_wait']);` at module scope. In `finishFailure`, wrap the `store.recordResult`/`store.recordRetry` calls so a `JOB_TERMINAL` error abandons ownership instead of propagating into the lane IIFE (an unhandled rejection there would kill the lane).

- [ ] **Step 6: Run to green**

```bash
cd pos-spooler-printer && node tests/run-tests.js
```

- [ ] **Step 7: Commit**

```bash
git add pos-spooler-printer/v2/job-store.js pos-spooler-printer/v2/printer-workers.js pos-spooler-printer/tests/v2-job-store.test.js pos-spooler-printer/tests/v2-printer-workers.test.js
git commit -m "fix(spooler-v2): refuse transitions out of terminal job states so canceled work cannot print"
```

---

## Task 2 — H2: V1 must never reclaim a V2-owned row

**Finding:** `claimPrintJobs`'s claimable predicate reclaims expired `sent` rows with no `agent_id` condition; its only protection is the station gate, and `PUT /printers` can repoint a printer to a V1 station while a V2 agent holds the payload → both print.

**Files:**
- Modify: `backend/services/printQueue.js` (claim SELECT, 92-105)
- Test: `backend/tests/integration/spoolerV2Compatibility.test.js`

**Interfaces — Consumes:** nothing new. **Produces:** invariant "a row carrying `agent_id` is invisible to every V1 claimant, regardless of which station its printer points at".

- [ ] **Step 1: Write the failing test** (append to `spoolerV2Compatibility.test.js`):

```js
    it('never lets V1 reclaim a V2-owned sent row after its printer is repointed to a V1 station', async () => {
        await pool.query(
            'INSERT INTO spooler_agents (agent_id, spooler_id, token_hash) VALUES (?, ?, ?)',
            [AGENT, 'v2-station', hash('s')]
        );
        await pool.query(
            "INSERT INTO spooler_stations (spooler_id, delivery_protocol, v2_activated_at) VALUES ('v2-station', 'v2', UTC_TIMESTAMP())"
        );
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Repoint', 'kitchen', 'windows', 'Repoint-W', 'v2-station')"
        );
        const payload = { print_type: 'kitchen', printer_id: printer.insertId, printer_name: 'Repoint', data: {} };
        const [queue] = await pool.query(
            "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type, agent_id, claimed_by, spooler_id, locked_until) VALUES (?, 'sent', 'repoint-key', REPEAT('c', 64), ?, 'kitchen', ?, ?, 'v2-station', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND))",
            [JSON.stringify(payload), printer.insertId, AGENT, `agent:${AGENT}`]
        );

        // Admin repoints the printer at a plain V1 station while the V2 agent still holds the payload.
        await pool.query("UPDATE printers SET spooler_id = 'v1-station' WHERE id = ?", [printer.insertId]);

        const claimed = await claimPrintJobs(pool, { spoolerId: 'v1-station', claimantId: 'poll:v1-station' });
        expect(claimed.map(job => job.queue_id)).not.toContain(queue.insertId);
        const [[row]] = await pool.query('SELECT status, agent_id FROM print_queue WHERE id = ?', [queue.insertId]);
        expect(row.status).toBe('sent');
        expect(row.agent_id).toBe(AGENT);
    });
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run backend/tests/integration/spoolerV2Compatibility.test.js
```

Expected: the row IS claimed (status becomes `processing`).

- [ ] **Step 3: Add the guard** — in `printQueue.js`, add one line to the claimable predicate so it reads:

```sql
              WHERE p.spooler_id = ?
                AND q.agent_id IS NULL
                AND (
                    q.status = 'pending'
                    OR (q.status = 'failed' AND (q.next_retry_at IS NULL OR q.next_retry_at <= UTC_TIMESTAMP()))
                    OR (q.status = 'processing' AND (q.locked_until IS NULL OR q.locked_until < UTC_TIMESTAMP()))
                    OR (q.status = 'sent' AND (q.locked_until IS NULL OR q.locked_until < UTC_TIMESTAMP()))
                )
```

Safety check to perform and record in the commit message: terminal rows are unclaimable regardless of `agent_id`, and rollback/replacement already terminalize agent-owned rows before a station returns to `v1` (`spoolerAgents.js` rollback preconditions), so no legitimate V1 work carries an `agent_id`. This guard is free in normal operation and is the structural twin of the V2 claim's own `q.agent_id IS NULL` (`spoolerSync.js:206`).

- [ ] **Step 4: Run to green, plus the V1 regression neighbours**

```bash
npx vitest run backend/tests/integration/spoolerV2Compatibility.test.js backend/tests/integration/spoolerSocketTransport.test.js backend/tests/integration/spoolerPoll.test.js backend/tests/integration/spoolerV2Cutover.test.js
```

- [ ] **Step 5: Commit**

```bash
git add backend/services/printQueue.js backend/tests/integration/spoolerV2Compatibility.test.js
git commit -m "fix(spooler-v2): hide agent-owned rows from every V1 claimant"
```

---

## Task 3 — H3: the lock must live in the process that prints

**Finding:** exclusivity is a named mutex held by the **helper child**; the Node agent holds nothing. Helper crash → mutex released → a second agent can start and both print the same journal. Worse, the agent never learns: `v2-server.js`'s `onEvent` inspects only `event.event`, so every supervisor-emitted `{ type: 'fatal' | 'protocol_error' }` (including `STATE_ROOT_LOCKED`) is silently dropped.

**Files:**
- Create: `pos-spooler-printer/v2/state-root-lock.js`
- Modify: `pos-spooler-printer/v2-server.js` (startup order + `onEvent`)
- Test: `pos-spooler-printer/tests/v2-hostile-runtime.test.js`

**Interfaces — Produces:** `acquireStateRootLock({ stateRoot })` → `{ release() }` | throws `STATE_ROOT_LOCKED`. Held for process lifetime, acquired **before** identity load (rev 2.1 §2.2 startup order: lock → identity → validate → workers).

- [ ] **Step 1: Write the failing tests** (append to `v2-hostile-runtime.test.js`): (a) two sequential `acquireStateRootLock` calls on one state root — the second throws `STATE_ROOT_LOCKED`; (b) a lockfile whose recorded PID is not alive is treated as stale, removed, and acquired; (c) after `release()`, a fresh acquire succeeds; (d) a supervisor `{ type: 'fatal', code: 'STATE_ROOT_LOCKED' }` event routed through `v2-server.js`'s handler triggers agent shutdown rather than being ignored. Replace the existing regex-over-C#-source assertion (`v2-hostile-runtime.test.js:253-256`) with these behavioural ones; keep the C# mutex as defence in depth.

- [ ] **Step 2: Run to verify failure** — module does not exist.

- [ ] **Step 3: Implement `state-root-lock.js`** — `fs.openSync(lockPath, 'wx')` for atomic create; write `{ pid, started_at, boot_id }`; on `EEXIST`, read the file and probe liveness with `process.kill(pid, 0)` (ESRCH ⇒ stale ⇒ `fs.unlinkSync` and retry **once**; any other outcome ⇒ throw `STATE_ROOT_LOCKED`); a malformed/unreadable lockfile is treated as held, never as free (fail closed). `release()` unlinks only if the file still records this process's pid+boot id. Register `release` on `SIGTERM`/`SIGINT`/`exit`.

- [ ] **Step 4: Wire it into `v2-server.js`** — acquire **first**, before `startPlatformHelper` and `loadOrCreateIdentity`; release in `close()`. Then widen `onEvent` so supervisor events are handled:

```js
        onEvent: event => {
            if (event?.event === 'printer_status') { statusMonitor?.applyStatus(event.status); return; }
            if (event?.type === 'fatal') {
                console.error(event.code || 'PLATFORM_HELPER_FATAL');
                if (event.code === 'STATE_ROOT_LOCKED') close().finally(() => process.exit(73));
            }
        }
```

- [ ] **Step 5: Run to green** — `cd pos-spooler-printer && node tests/run-tests.js`

- [ ] **Step 6: Commit**

```bash
git add pos-spooler-printer/v2/state-root-lock.js pos-spooler-printer/v2-server.js pos-spooler-printer/tests/v2-hostile-runtime.test.js
git commit -m "fix(spooler-v2): hold the state-root lock in the printing process and surface helper fatals"
```

---

## Task 4 — H4: an exclusive probe must not strand the lane

**Finding:** `runExclusive`'s `finally` clears `lane.running` and calls only `notifyIdle()`; unlike `runLane`'s own `finally` it never restarts the lane, so a job enqueued during a status probe waits until an unrelated new job arrives — and `stop()`/`idle()` hang on the non-empty queue.

**Files:**
- Modify: `pos-spooler-printer/v2/printer-workers.js` (`runExclusive`, 120-130)
- Test: `pos-spooler-printer/tests/v2-printer-workers.test.js`

- [ ] **Step 1: Write the failing test** — start a `runExclusive` operation for printer 1 that resolves on a deferred; while it is in flight, drive a render to completion so the record is enqueued on printer 1's lane; resolve the probe; `await workers.idle()` and assert the job was transported. Before the fix this test times out or the transport list is empty.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Fix** — in `runExclusive`'s `finally`:

```js
        } finally {
            lane.running = false;
            if (started && lane.queue.length > 0) runLane(Number(printerId));
            notifyIdle();
        }
```

- [ ] **Step 4: Run to green** — `cd pos-spooler-printer && node tests/run-tests.js`

- [ ] **Step 5: Commit**

```bash
git add pos-spooler-printer/v2/printer-workers.js pos-spooler-printer/tests/v2-printer-workers.test.js
git commit -m "fix(spooler-v2): restart a printer lane after an exclusive status probe"
```

---

# Phase B — Availability and rollout safety

## Task 5 — H6 + F3: rollback must restore the service entry point

**Finding (H6):** `Update-Spooler.ps1 -EnableV2` flips NSSM `AppParameters` to `v2-server.js` (`:516/519`); the rollback branch (`:583-604`) restores the payload and restarts the service but never calls `Set-SpoolerApplicationScript 'server.js'`, then deletes the journal (`:601`) — the station flaps while `Repair-SpoolerStartup.ps1` reports healthy. **F3** is the same hole on the install path (`Install-Spooler.ps1:187-254`).

**Files:**
- Modify: `deployment/windows/Update-Spooler.ps1`
- Modify: `deployment/windows/Install-Spooler.ps1`
- Modify: `backend/tests/unit/installerUpdateContract.test.js`

- [ ] **Step 1: Write the failing contract tests** — replace token-presence assertions with structural ones over the script source: (a) the rollback branch (between the `$phase = 'rollback'` assignment and its `Start-Spooler`) contains a `Set-SpoolerApplicationScript` call; (b) `Remove-SpoolerTransactionJournal` does not appear before that restore within the same branch; (c) `Install-Spooler.ps1`'s catch block contains both an abort-prepare call and an entry-point restore when `$EnableV2`. These are still source assertions — say so in the test names — because a real interrupted-update gate needs a Windows host (Task 13 records it as an open physical gate).

- [ ] **Step 2: Run to verify failure** — `npx vitest run backend/tests/unit/installerUpdateContract.test.js`

- [ ] **Step 3: Fix `Update-Spooler.ps1`** — capture the pre-update script name before the `-EnableV2` flip (near `:516`), and in the rollback branch restore it **before** `Start-Spooler` (`:597`), e.g.:

```powershell
            if ($EnableV2 -and $null -ne $serviceScriptBefore) { Set-SpoolerApplicationScript $serviceScriptBefore }
```

Move `Remove-SpoolerTransactionJournal $journalPath` (`:601`) to run only after the restored service has been verified running; on verification failure, leave the journal in place so `Repair-SpoolerStartup.ps1` can act. Apply the same restore in the second rollback branch (`:605-613`).

- [ ] **Step 4: Fix `Install-Spooler.ps1`** — in the catch path, when `$EnableV2` and the service pre-existed, call the V2 abort-prepare and restore `server.js` as the entry point before restarting.

- [ ] **Step 5: Harden the health check** — `Repair-SpoolerStartup.ps1:196-202` must not report healthy on SCM `Running` alone; require the service to still be running after a short re-check so a crash-flap is visible.

- [ ] **Step 6: Run to green** — `npx vitest run backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js backend/tests/unit/spoolerPackageContract.test.js`

- [ ] **Step 7: Commit**

```bash
git add deployment/windows/Update-Spooler.ps1 deployment/windows/Install-Spooler.ps1 deployment/windows/Repair-SpoolerStartup.ps1 backend/tests/unit/installerUpdateContract.test.js
git commit -m "fix(spooler-v2): restore the V1 entry point on failed cutover and keep the recovery journal"
```

---

## Task 6 — M1 + M9: server-side ownership correctness

**M1:** `registerAgent`'s reactivation branch (`spoolerAgents.js:137-152`) flips a station to `v2` without the `in_flight > 0 → 409 station_busy` check the fresh path runs (`:159-166`), stranding any V1 row claimed after a rollback in a state no path can resolve.
**M9:** `runAgentSync`'s tail (`spoolerSync.js:230-258`) writes printer statuses and `spooler_agents.last_error` for **revoked/decommissioned** agents too, letting a stale agent overwrite the `ROLLED_BACK_TO_V1` marker that reactivation depends on.

**Files:** `backend/services/spoolerAgents.js`, `backend/services/spoolerSync.js`, `backend/tests/integration/spoolerV2Cutover.test.js`, `backend/tests/integration/spoolerV2Sync.test.js`

- [ ] **Step 1: Failing tests** — (M1) roll a station back, let V1 claim a row (`agent_id NULL`, status `processing`), `/prepare`, then re-register the rolled-back agent → expect 409 `station_busy` and the station still `transitioning`. (M9) revoke an agent with `last_error='ROLLED_BACK_TO_V1'`, sync once with `health.last_error='PRINTER_OFFLINE'` and a printer status payload → expect `last_error` unchanged, `printers.device_status` unchanged, and the response still reporting `agent_status: 'revoked'`.
- [ ] **Step 2: Run to verify both fail.**
- [ ] **Step 3: Fix M1** — perform the same `in_flight` count and 409 inside the reactivation branch, before its UPDATEs, in the same transaction.
- [ ] **Step 4: Fix M9** — gate the device-status update and the `spooler_agents` UPDATE on `['active','draining'].includes(locked.status)`; still return the response so the agent learns its status in-band (rev 2.1 requires in-band revocation, never a 4xx).
- [ ] **Step 5: Run to green** — `npx vitest run backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/spoolerV2Cutover.test.js backend/tests/integration/spoolerV2Health.test.js`
- [ ] **Step 6: Commit** — `git commit -m "fix(spooler-v2): drain-check reactivation and stop revoked agents writing station state"`

---

# Phase C — Runtime robustness

## Task 7 — M3 + M4 + M5: the sync loop must not brick itself

**Files:** `pos-spooler-printer/v2/agent-runtime.js`, `pos-spooler-printer/tests/v2-sync-runtime.test.js`

- [ ] **Step 1: Failing tests** — (M3) a sync response containing one job that throws `PAYLOAD_IDENTITY_CONFLICT` plus one valid job: the valid job is accepted, the tick completes, and the next request reports a terminal `permanent_failure` result for the offending id. (M4) sync 401 → `register()` rejects with a 502 → a later sync 401 attempts registration **again**. (M5) a response with `next_sync_ms: 3600000` schedules ≤5000 ms; `next_sync_ms: -1` schedules ≥500 ms.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Fix M3** — wrap the per-job `store.accept(job)` in `applySyncResponse` (`agent-runtime.js:94-99`) in try/catch; on `JOB_IDENTITY_INVALID`/`PAYLOAD_IDENTITY_CONFLICT`, skip the local record and queue a terminal result `{ outcome: 'permanent_failure', error_code: <that code>, failure_class: 'permanent_safe' }` for that queue_id so the server stops redelivering. Never let one job abort the tick.
- [ ] **Step 4: Fix M4** — set `registeredAttempted = false` after every successful sync; latch it only when `register()` fails with a non-retryable 4xx.
- [ ] **Step 5: Fix M5** — clamp at both schedule sites (`:130`, `:144`): `Math.min(Math.max(Number(response.next_sync_ms) || 2000, 500), 5000)`, per rev 2.1 §1.4.
- [ ] **Step 6: Run to green** — `cd pos-spooler-printer && node tests/run-tests.js`
- [ ] **Step 7: Commit** — `git commit -m "fix(spooler-v2): isolate unacceptable jobs, re-arm registration, clamp the sync hint"`

## Task 8 — M2 + M6 + M8: transport and render containment

**Files:** `pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs`, `pos-spooler-printer/v2/printer-transports.js`, `pos-spooler-printer/v2/artifact-renderer.js`, `pos-spooler-printer/v2/platform-helper.js`, tests `v2-printer-transports.test.js`, `v2-artifact-renderer.test.js`, `v2-platform-helper.test.js`

- [ ] **Step 1: Failing tests** — (M2) a fake write failure mid-document must not reach `EndDocPrinter` (assert against the helper's own operation log / a C# unit harness; if no C# test host exists, assert the source contains `AbortPrinter` on the exception path and record the gap honestly). (M6) `helper.request` rejecting `PLATFORM_HELPER_RESTARTING` before any write ⇒ classification `transient_safe` and **no** `markTransportStarted` call. (M8) a render whose `page.close()` never settles ⇒ `withDeadline` still rejects and the browser is killed.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Fix M2** — P/Invoke `AbortPrinter` and call it instead of `EndPagePrinter`/`EndDocPrinter` on the exception path (`PosSpoolerPlatform.cs:242-246`), so a partial RAW document is discarded rather than committed to the queue. **Same task, same file:** fix the short-write bug at `:229` — `WritePrinter(printer, buffer, read - offset, out written)` always passes the buffer from index 0, so a partial acceptance re-sends the leading bytes; pass a correctly offset segment (or track and copy the remaining slice).
- [ ] **Step 4: Fix M6** — in `createWindowsTransport.send` (`printer-transports.js:224-233`), check `helper.isReady?.()` **before** `markTransportStarted` and throw `classified('PLATFORM_HELPER_RESTARTING', 'transient_safe')`; keep `uncertain` only once the stdin write has been attempted.
- [ ] **Step 5: Fix M8** — in the render deadline's `onTimeout` (`artifact-renderer.js:464-466`), kill first: `discardBrowser(instance)` then best-effort `page.close()`, so a wedged CDP connection cannot block the rejection (`withDeadline` rejects only after `onTimeout` settles — `:31-33`).
- [ ] **Step 6: Rebuild the helper and run** — `pwsh scripts/build-winprint-helper.ps1` (if present) then `cd pos-spooler-printer && node tests/run-tests.js`
- [ ] **Step 7: Commit** — `git commit -m "fix(spooler-v2): abort partial Windows jobs, classify helper restarts safely, kill wedged renders"`

---

# Phase D — Honesty and hygiene

## Task 9 — M7 + M10: status must not overclaim

**Files:** `pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs`, `pos-spooler-printer/v2/printer-transports.js`, `pos-spooler-printer/v2/status-monitor.js`, `backend/routes/admin/printQueue.js`, tests `v2-printer-transports.test.js`, `v2-status-monitor.test.js`

- [ ] **Step 1: Failing tests** — (M10) a probe reply of a single `0x00` byte ⇒ `deviceStatus: 'unknown'`, `errorCode: 'STATUS_UNSUPPORTED'`, never `device_confirmed`; a reply matching the fixed-bit pattern ⇒ `ok`/`device_confirmed`; a 4-byte ASB push ⇒ `unknown`, not a permanent capability downgrade. (M7) Winspool `Status == 0` ⇒ `unknown`, never `ok`. The transports test file currently has **zero** probe tests — this is the gap that let M10 ship.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Fix M10** — in `probe` (`printer-transports.js:210-213`), require the DLE EOT n=1 fixed bits (`(value & 0x93) === 0x12`) before trusting the byte; anything else ⇒ `STATUS_UNSUPPORTED`.
- [ ] **Step 4: Fix M7** — map `Status == 0` to `unknown` in `DeviceStatus` (`PosSpoolerPlatform.cs:65-79`), and stop stamping `device_confirmed` from an os-reported source in `printer-transports.js:261`, `status-monitor.js:109`, and `backend/routes/admin/printQueue.js:173` — os-reported states get their own confidence tier, per rev 2.1 invariant 12 ("TCP port open", "Winspool accepted" and "paper printed" are different facts).
- [ ] **Step 5: Run to green** — spooler suite plus `npx vitest run backend/tests/integration/spoolerV2Health.test.js`
- [ ] **Step 6: Commit** — `git commit -m "fix(spooler-v2): stop reporting unverified printer status as device-confirmed"`

## Task 10 — C6 + C8 + C9 + C10 + P-journal + P-transport + P-helper

**Files:** `pos-spooler-printer/v2/job-store.js`, `v2-server.js`, `v2/printer-transports.js`, `v2/platform-helper.js`, matching tests

- [ ] **Step 1: Failing tests** — cleanup is invoked from the tick path; a corrupt legacy backup is quarantined rather than throwing; `health()` reports a `quarantined` count; a non-zero startup jitter is passed; `recordRetry` from `transport_started` throws; the TCP total deadline scales with `artifact.bytes`; a `printer_status` request timeout does not kill the helper.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Fixes**
  - **C6** — call `store.cleanup()` from the sync tick, throttled (e.g. once per hour of process uptime); it is currently referenced only by tests, so 14-day retention never runs in production.
  - **C8** — wrap the legacy backup read (`job-store.js:143`) in try/catch; on parse failure move the file to `quarantine/`, write the migration marker, and continue — never mint printable work from it. Also re-copy the backup if it is unreadable rather than trusting a possibly-truncated existing copy (`:138-142`).
  - **C9** — count files in `quarantine/` at open and expose `quarantined` from `health()` so a quarantined runnable job is visible in station health.
  - **C10** — pass `startupJitterMs` (e.g. up to 2000 ms) from `v2-server.js:100`, per rev 2.1 §1.4.
  - **P-journal** — reject `retry` transitions out of `transport_started` in `recordRetry` (`job-store.js:271`); invariant 6 must be enforced by the journal, not only by transport discipline.
  - **P-transport** — scale the TCP total deadline with artifact size instead of a fixed 15 s (`printer-transports.js:7`), so a ~1 MB 200-row report into a slow printer cannot become a false `uncertain` half-print. Keep connect and write-idle deadlines fixed.
  - **P-helper** — in `platform-helper.js:43-49`, kill the helper only on `print_raw` timeouts; a hung `printer_status` probe must reject without killing an in-flight print for another printer.
- [ ] **Step 4: Run to green** — `cd pos-spooler-printer && node tests/run-tests.js`
- [ ] **Step 5: Commit** — `git commit -m "fix(spooler-v2): journal retention, quarantine visibility, retry barrier, deadline and helper-kill scope"`

---

# Phase E — Test debt, migration compliance, re-audit

## Task 11 — Repair the two test regressions the audit found

- [ ] **Step 1:** `backend/tests/integration/webauthnSchemaMigration.test.js` — the fixture seeds the ledger from every manifest entry's `requires` link, and the new spooler-v2 entry `requires` webauthn, so it re-inserts the migration it means to exclude and its predecessor-enforcement guard goes inert (verified: fails in isolation). Add `ledger.delete(WEBAUTHN_NAME);` after the ledger loop (`:33-37`). Prove it by running the file alone — both tests must pass **and** the first must show the migration in `applied`.
- [ ] **Step 2:** `backend/tests/unit/spoolerReceiptDisplay.test.js` — four tests assert V1 behaviour still lives textually inside `pos-spooler-printer/server.js`; the behaviour moved into `v2/artifact-renderer.js`. Rewrite them to assert the current renderer boundary (or, better, observable rendered output). Do not copy old strings back into `server.js` to satisfy them.
- [ ] **Step 3:** Investigate the `taxExemptWorkflow` full-run failure — it **passes in isolation**, so it is order-dependent pollution, not a spooler defect. Find the polluting file (bisect by running the suite subsets that precede it) and fix the leak, or record the cause in the evidence doc if it is out of scope for this branch.
- [ ] **Step 4: Commit** — `git commit -m "test(spooler-v2): restore the migration predecessor guard and retarget stale renderer assertions"`

## Task 12 — F2: restore single-authority enum DDL (draft stage; owner approval before manifest work)

The retroactively edited `2026-08-01-additive-schema-reconciliation` files carry the enum expansion inside a **combined, unguarded** `ALTER`, and that block precedes the 08-17 block in the Hostinger fallback — so a manual emergency import performs the 7→9 change through the unguarded statement while the guarded 08-17 statement no-ops. That contradicts rev 2.1 Task 1.2 ("its own `ALTER TABLE` with explicit `ALGORITHM=INSTANT, LOCK=NONE` … must not fall back to `INPLACE` or `COPY`").

- [ ] **Step 1:** Confirm the current state yourself: diff the two 08-01 files against master, recompute their sha256, and compare the fallback block to `.auto.sql` byte for byte.
- [ ] **Step 2:** Dispatch `luna_max` to revert the 08-01 enum lists to the original seven values, leaving 2026-08-17 as the sole enum authority — **or**, if the nine-value form must remain for fresh-shape reconciliation, to isolate it into its own statement carrying `ALGORITHM=INSTANT, LOCK=NONE`.
- [ ] **Step 3:** Verify the whole chain: manifest sha256 values recomputed, predecessor linkage intact, ledger `checksum` pins unchanged, fallback parity restored, and a scratch-DB upgrade from the exact predecessor floor.
- [ ] **Step 4:** Only after explicit owner approval, let Luna update `.auto.sql`, the manifest entry, and the Hostinger fallback block. **Blocked until then.**

## Task 13 — Verification and re-audit gate

- [ ] **Step 1:** Focused suites — `npx vitest run backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/spoolerV2Compatibility.test.js backend/tests/integration/spoolerV2Cutover.test.js backend/tests/integration/spoolerV2Health.test.js backend/tests/unit/spoolerAgentAuth.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/integration/automaticMigrations.test.js backend/tests/integration/webauthnSchemaMigration.test.js`
- [ ] **Step 2:** `cd pos-spooler-printer && node tests/run-tests.js`
- [ ] **Step 3:** `npm run build`, then `npm run architecture:check` (update `docs/architecture.json` if any traced flow moved — the state-root lock is a new node in the agent startup flow).
- [ ] **Step 4:** Full suite exactly once; compare against the audit's recorded baseline (7 pre-existing failures across 3 files). Expect webauthn (2) and spoolerReceiptDisplay (4) resolved by Task 11 and no new failures.
- [ ] **Step 5:** Re-run the adversarial audit protocol from `docs/superpowers/evidence/2026-08-18-spooler-v2-adversarial-audit.md` §"The audit protocol" against the fixed branch, with each reviewer told which findings were fixed and instructed to attack the **fix** (a fix that moves a defect is not a fix). Record results as a rev 3 audit.
- [ ] **Step 6: Commit** the evidence update.

## Adversarial completion checklist

- [ ] Every audit finding ID (H1–H4, H6, M1–M10, C6/C8/C9/C10, F2, F3, P-journal/P-transport/P-helper, appendix regressions) maps to a task above; none was silently dropped or renumbered.
- [ ] Each of the five HIGHs has a test that **failed before** its fix — recorded in the commit message.
- [ ] No fix introduces a new automatic path to paper: grep that `markTransportStarted` still precedes every first byte, and that no new code retries after `transport_started`.
- [ ] The V1 claim guard does not strand legitimate V1 work: confirm no non-terminal row carries `agent_id` when a station is `v1`.
- [ ] The state-root lock cannot fail open: malformed lockfile, unreadable lockfile, and helper-absent all fail closed.
- [ ] Status honesty holds end to end: no path renders `bytes_sent`/`os_accepted` as paper printed, and no unverified probe yields `device_confirmed`.
- [ ] Physical gates remain open and declared: affected long-report printer, Windows share, direct TCP, write-only clone, paper-out model, DPAPI two-machine proof, disk-full-at-every-transition, real interrupted-update run.
- [ ] Nothing merged, pushed, deployed; no production migration; no station cut over.
