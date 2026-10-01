# Background Runtime Read Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `executing-plans` and execute this plan task by task on an ordinary `codex/` feature branch. Do not create an isolated worktree. Use RED/GREEN and one commit per task. Do not deploy, merge, push, bump a release, alter a migration, or enter the auth/session, WebAuthn, service-charge, Y-archive, checkout, order-item, or table-transaction refactors.

**Goal:** Reduce recurring database reads from the server print watchdog and JoFotara recovery runner without weakening print-station recovery, fiscal submission recovery, graceful shutdown, or the existing maximum work cadence.

**Architecture:** Keep two dedicated deep modules because the jobs have different correctness rules. The print watchdog becomes event-first, rate-bounded to its existing 30-second maximum cadence, and retains a five-minute recovery sweep. The JoFotara runner keeps its one-minute full recovery cadence only while automatic submission is active; while inactive it runs only the stale-submission safety update every five minutes. No generic scheduler or shared background-job framework is introduced.

**Tech Stack:** Node.js 22 production floor, CommonJS, Express 5, Socket.IO 4, mysql2 3, MariaDB/InnoDB, Vitest 4.

## Global Constraints

- Preserve the print queue's durable database authority, V2 sync/claim/accept/settle protocol, long-poll wake generation, idempotency keys, queue status meanings, reprint ancestry, audit status updates, and browser diagnostics endpoint.
- A print watchdog wake is a hint. Its queries remain authoritative, wakes may coalesce, and a five-minute sweep must repair any missed signal.
- Event traffic must never make the print watchdog start more often than the current 30-second interval. After at least 30 seconds of quiet, the first durable queue signal should start one inspection after a 25 ms coalescing window.
- A failed print inspection retries after 30 seconds. A successful quiet inspection rearms one five-minute recovery timer.
- The print runner must be single-flight. A signal received during inspection produces at most one trailing inspection, still subject to the 30-second start bound.
- Do not make print completion, checkout, cancellation, reprint, or agent sync wait for the watchdog queries. `wake()` is synchronous, process-local, and non-throwing.
- Preserve JoFotara's two-minute `submitting` uncertainty threshold, two-minute pending-document recovery age, 30-second provider timeout, automatic cutoff, source eligibility, unique document ownership, and existing one-minute recovery cadence while automation is active.
- Do not wake JoFotara immediately when checkout creates a pending document. It is deliberately ineligible for background recovery for two minutes; an immediate wake would spend queries and find no candidate. The active one-minute cadence remains the simple, safe owner of that delayed eligibility.
- When automatic JoFotara submission is inactive, retain one stale-only `UPDATE` every five minutes. This protects interrupted manual submissions without paying for the settings and candidate reads every minute.
- Accept the bounded inactive-mode trade-off explicitly: an abnormally interrupted manual `submitting` row can remain visible for roughly two to seven minutes instead of roughly two to three minutes. Ordinary provider calls still have their existing 30-second deadline and settle normally; a process restart still performs an immediate full pass. Do not present the five-minute fallback as zero-latency recovery.
- Enabling or disabling automation through the supported admin settings route must notify staff browsers and reconfigure the runner only after the settings transaction commits. A newer committed configuration must win over an older in-flight run.
- Direct SQL edits to JoFotara settings are not a supported hot-reload interface. They take effect on the next process start or full pass; runtime enable/disable must use the existing admin route. Do not add a settings poll merely to support out-of-band database edits.
- Runner failures are non-fatal. They log once per failed execution and retain bounded recovery; they never crash startup or change an already-committed business response.
- Both runners must expose idempotent `start()` and asynchronous `stop()`. `stop()` clears timers, unsubscribes listeners, and awaits work already in flight before the MySQL pool closes.
- Do not add a dependency, environment variable, database table, index, migration, broker, worker thread, Redis client, cron package, generic scheduler, or new protocol/version name.
- Run only the focused tests named below, `npm run architecture:check`, and the two local query-count probes. Do not run the entire repository suite for this plan.

## Evidence Verified Against Current Source

1. `server.js` currently runs the print watchdog with an unconditional `setInterval(..., 30000)`. Each tick calls `getPrintQueueHealth(db)` and `getStalePrintStations(db)`, which are one SQL command each. A local `.env.test` MariaDB probe measured exactly two commands.
2. The current print cost is therefore 2 commands × 2,880 ticks/day = **5,760 top-level database commands/day per deployment**, even when the queue is quiet.
3. `backend/services/spoolerSyncWake.js` already publishes only after durable autocommit insertion or `conn.commit()` for normal queue creation, cancellation, reprint, subscription print work, order print work, and agent replacement. It is the existing process-local post-commit seam; the watchdog should subscribe to it rather than duplicate every producer call site.
4. Agent settlement is a separate committed transaction inside `runAgentSync`. `backend/routes/spoolerV2.js` receives `result.queueStateChanged` after that commit and before its response-abort guard. It needs one explicit watchdog wake because settlement does not publish the spooler delivery wake.
5. An agent that reconnects with queued or owned work returns `jobs`, confirmed accepts, or cancellation work from the committed sync. Those result fields should also wake the rate-bounded watchdog so a previously stale station clears promptly. Heartbeat-only syncs must not wake it.
6. Claim-only and accept-only status movement changes diagnostic grouping but not the existence of unresolved work. The activity wake above plus the five-minute sweep is sufficient; the active Print Queue admin tab continues to query its authoritative endpoint every 30 seconds.
7. `processJofotaraOperations()` currently runs immediately at server start and every 60 seconds. When automation is disabled, `processOperationsOnce()` still runs `markStaleSubmissionsUnknown()` and reads three settings. A local MariaDB probe measured exactly two commands per disabled tick: one stale `UPDATE`, one settings `SELECT`.
8. The disabled JoFotara cost is therefore 2 commands × 1,440 ticks/day = **2,880 commands/day**. The planned inactive mode performs only the stale `UPDATE` every five minutes: 288 commands/day, a 90% steady-state reduction while retaining the safety repair.
9. The stale update is still required. Manual invoice and credit-note submission set a row to `submitting` before the external request. Normal requests have a 30-second provider deadline and settle the row; process interruption is the exceptional path. Startup still runs a full pass immediately, while the five-minute inactive sweep protects a process that stays alive with abnormal stuck work.
10. `backend/routes/admin/jofotara.js` is the only production writer of `jofotara_enabled` and `jofotara_auto_submit`. It already computes `isAutomatic` inside the locked settings transaction, so it can safely notify the runner after `commit()` without rereading settings.
11. JoFotara automatic candidates are deliberately at least two minutes old. Checkout calls `prepareCheckoutInvoiceIfAutomatic()` after payment commit and can create a fresh pending document, but waking the recovery runner then cannot submit it. This plan deliberately rejects that false optimization.
12. `processJofotaraOperations()` already coalesces overlapping service calls through `operationsRun`. The current server `setInterval` can nevertheless attach multiple completion handlers and emit duplicate browser events when a run lasts longer than a minute. The owned runner removes that timer overlap and emits only when `attempted > 0` or `stale > 0`.
13. `gracefulShutdown()` currently awaits database maintenance and print-queue purge before `pool.end()`, but it owns no handles for the watchdog or JoFotara intervals. Both new runner stops must join that same drain.
14. Baseline focused verification on 2026-08-30 passed: `printQueueWatchdog.test.js`, `spoolerWakeCommitBoundaries.test.js`, and `jofotara.test.js` — **3 files, 57 tests, 57 passed**.
15. A disposable fake-clock state-machine experiment passed the planned cadence assertions: print wakes were capped at 30 seconds with a 300-second quiet sweep; JoFotara used 60-second full runs while active and 300-second stale-only runs while inactive. No production file was changed by the experiment.
16. A local MariaDB `EXPLAIN UPDATE` for `markStaleSubmissionsUnknown()` reports `possible_keys: null` and scans the primary index. The local table has only one row, so that is not sufficient evidence for a production index migration. This plan reduces how often the inactive scan runs but deliberately leaves SQL and indexes unchanged; production cardinality and rows-examined evidence must precede any separate `(status, last_attempt_at)` index decision.
17. The final plan-code check parsed all 21 JavaScript snippets successfully. Disposable execution of the exact two runner implementation blocks passed startup, quiet cadence, burst coalescing, active/inactive transition, disable-during-full-run, enable-during-stale-run, retry, and shutdown cases. These were plan-only experiments; no application file was created or modified.

## Expected Steady-State Delta

| Runner state | Current | Planned | Bound |
|---|---:|---:|---:|
| Quiet print watchdog | 5,760 DB commands/day | 576 DB commands/day | 90% fewer; durable events may add bounded inspections |
| Busy print watchdog | 5,760 DB commands/day | At most 5,760 DB commands/day | Never worse than the old cadence |
| JoFotara automation inactive | 2,880 DB commands/day | 288 stale-only commands/day | 90% fewer |
| JoFotara automation active | Existing 60-second full recovery | Same 60-second full recovery | No fiscal recovery slowdown |

These are deterministic scheduling bounds, not production traffic claims. Startup adds one immediate run per runner. Print events add inspections only within the old 30-second ceiling. JoFotara provider work adds its existing document and submission queries only when eligible work exists.

---

### Task 1: Make the print watchdog event-first and rate-bounded

**Files:**
- Modify: `backend/services/spoolerSyncWake.js`
- Create: `backend/services/printQueueWatchdogRunner.js`
- Modify: `backend/routes/spoolerV2.js`
- Modify: `server.js`
- Modify: `backend/tests/unit/spoolerSyncWake.test.js`
- Create: `backend/tests/unit/printQueueWatchdogRunner.test.js`
- Modify: `backend/tests/integration/spoolerV2Sync.test.js`
- Modify: `backend/tests/unit/spoolerV2OnlyContract.test.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

**Interfaces:**
- `createSpoolerSyncWakeHub(...).subscribe(listener) -> unsubscribe()` registers a synchronous process-local observer without changing generation or agent waiter behavior.
- `createPrintQueueWatchdogRunner({ db, logger, emitStale, wakeHub, ...clockOverrides }) -> { start, wake, stop }` owns inspection cadence and lifecycle.
- `start() -> Promise<boolean | undefined>` performs one immediate inspection and is idempotent.
- `wake() -> boolean` marks the runner dirty and never performs database work inline.
- `stop() -> Promise<void>` unsubscribes, clears timers, and drains the current inspection.
- `server.js` stores the runner as `app.set('printQueueWatchdog', printQueueWatchdog)` so committed V2 sync activity can signal it without importing `server.js` or creating a global dependency cycle.

- [ ] **Step 1: Add RED tests for wake-hub subscribers**

Extend `backend/tests/unit/spoolerSyncWake.test.js` with these cases:

```js
it('notifies subscribers after advancing the generation without changing waiter behavior', async () => {
    const errors = [];
    const hub = createSpoolerSyncWakeHub({
        ...fakeClock(),
        onSubscriberError: error => errors.push(error)
    });
    const listener = vi.fn();
    const unsubscribe = hub.subscribe(listener);
    const waiting = hub.waitForChange('agent-a', hub.generation(), { timeoutMs: 100 });

    expect(hub.publish()).toBe(1);
    await expect(waiting).resolves.toBe('changed');
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(1);
    expect(errors).toEqual([]);

    unsubscribe();
    unsubscribe();
    hub.publish();
    expect(listener).toHaveBeenCalledOnce();
});

it('isolates a broken subscriber from agent wakes and later subscribers', async () => {
    const errors = [];
    const hub = createSpoolerSyncWakeHub({
        ...fakeClock(),
        onSubscriberError: error => errors.push(error)
    });
    const healthy = vi.fn();
    hub.subscribe(() => { throw new Error('observer failed'); });
    hub.subscribe(healthy);
    const waiting = hub.waitForChange('agent-a', hub.generation(), { timeoutMs: 100 });

    expect(() => hub.publish()).not.toThrow();
    await expect(waiting).resolves.toBe('changed');
    expect(healthy).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
});

it('keeps publish non-throwing when the subscriber error reporter also fails', async () => {
    const hub = createSpoolerSyncWakeHub({
        ...fakeClock(),
        onSubscriberError() { throw new Error('logger failed'); }
    });
    const healthy = vi.fn();
    hub.subscribe(() => { throw new Error('observer failed'); });
    hub.subscribe(healthy);
    const waiting = hub.waitForChange('agent-a', hub.generation(), { timeoutMs: 100 });

    expect(() => hub.publish()).not.toThrow();
    await expect(waiting).resolves.toBe('changed');
    expect(healthy).toHaveBeenCalledOnce();
});

it('clears subscribers on close and rejects later subscriptions', () => {
    const hub = createSpoolerSyncWakeHub(fakeClock());
    const listener = vi.fn();
    hub.subscribe(listener);
    hub.close();
    const unsubscribe = hub.subscribe(listener);
    hub.publish();
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the wake-hub RED test**

```powershell
npx vitest run backend/tests/unit/spoolerSyncWake.test.js --no-file-parallelism
```

Expected: the new tests fail because `subscribe` and `onSubscriberError` do not exist. Existing generation, waiter, timeout, abort, and close tests remain green.

- [ ] **Step 3: Add the minimal subscriber seam**

In `backend/services/spoolerSyncWake.js`, extend `createSpoolerSyncWakeHub` without changing `snapshot()`:

```js
function createSpoolerSyncWakeHub({
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onSubscriberError = () => {}
} = {}) {
    let currentGeneration = 0;
    let closed = false;
    const waiters = new Map();
    const subscribers = new Set();

    function subscribe(listener) {
        if (closed || typeof listener !== 'function') return () => {};
        subscribers.add(listener);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            subscribers.delete(listener);
        };
    }

    function publish() {
        if (closed) return currentGeneration;
        currentGeneration += 1;
        for (const entry of [...waiters.values()]) entry.finish('changed');
        for (const listener of [...subscribers]) {
            try { listener(currentGeneration); }
            catch (error) {
                try { onSubscriberError(error); }
                catch {}
            }
        }
        return currentGeneration;
    }

    function close() {
        if (closed) return;
        closed = true;
        for (const entry of [...waiters.values()]) entry.finish('closed');
        subscribers.clear();
    }

    return { generation, waitForChange, subscribe, publish, close, snapshot };
}
```

Construct the production singleton with a non-throwing error logger:

```js
const spoolerSyncWakeHub = createSpoolerSyncWakeHub({
    onSubscriberError(error) {
        logger.error({ err: error }, 'Spooler sync wake subscriber failed.');
    }
});
```

Do not add subscribers to `snapshot()`; existing exact snapshot assertions and the manual long-poll harness intentionally describe agent waiters only.

- [ ] **Step 4: Add RED tests for the dedicated print runner**

Create `backend/tests/unit/printQueueWatchdogRunner.test.js`. Use the same fake-clock shape already used by `printQueuePurge.test.js`: timer objects expose `{ due, callback, unref }`, `advance(ms)` fires due timers in due-time order, and a deferred promise controls in-flight inspection.

The tests must prove all of these behaviors:

```js
it('runs immediately, then uses a five-minute quiet recovery sweep', async () => {
    const subject = makeSubject();
    await subject.runner.start();
    expect(subject.db.query).toHaveBeenCalledTimes(2);
    expect(subject.clock.nextDelay()).toBe(300_000);
    await subject.clock.advance(299_999);
    expect(subject.db.query).toHaveBeenCalledTimes(2);
    await subject.clock.advance(1);
    expect(subject.db.query).toHaveBeenCalledTimes(4);
});

it('coalesces a burst and never starts faster than the old thirty-second cadence', async () => {
    const subject = makeSubject();
    await subject.runner.start();
    await subject.clock.advance(10_000);
    for (let index = 0; index < 100; index += 1) subject.publish();
    expect(subject.clock.nextDueAt()).toBe(30_000);
    await subject.clock.advance(20_000);
    expect(subject.inspectStarts).toEqual([0, 30_000]);
});

it('keeps one trailing dirty inspection when a signal arrives in flight', async () => {
    const pending = deferred();
    const subject = makeSubject({ firstQuery: pending.promise });
    const starting = subject.runner.start();
    subject.publish();
    subject.publish();
    pending.resolve([[]]);
    await starting;
    expect(subject.clock.nextDueAt()).toBe(30_000);
    await subject.clock.advance(30_000);
    expect(subject.inspectStarts).toEqual([0, 30_000]);
});

it('retries a failed inspection after thirty seconds', async () => {
    const subject = makeSubject({ firstQuery: Promise.reject(new Error('database unavailable')) });
    await subject.runner.start();
    expect(subject.logger.error).toHaveBeenCalledOnce();
    expect(subject.clock.nextDelay()).toBe(30_000);
});

it('unsubscribes, clears timers, and awaits an inspection already in flight', async () => {
    const pending = deferred();
    const subject = makeSubject({ firstQuery: pending.promise });
    const starting = subject.runner.start();
    let stopSettled = false;
    const stopping = subject.runner.stop();
    void stopping.then(() => { stopSettled = true; });
    expect(subject.unsubscribe).toHaveBeenCalledOnce();
    expect(subject.clock.timerCount()).toBe(0);
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    pending.resolve([[]]);
    await starting;
    await stopping;
    expect(stopSettled).toBe(true);
    expect(subject.clock.timerCount()).toBe(0);
});
```

The fixture must return a successful row array for both authoritative queries after any injected first result. Assert emitted stale payloads contain only station identifiers/counts and that no print payload is exposed.

- [ ] **Step 5: Run the print-runner RED test**

```powershell
npx vitest run backend/tests/unit/printQueueWatchdogRunner.test.js --no-file-parallelism
```

Expected: FAIL because `backend/services/printQueueWatchdogRunner.js` does not exist.

- [ ] **Step 6: Implement the dedicated print runner**

Create `backend/services/printQueueWatchdogRunner.js` with this complete implementation:

```js
const {
    createPrintQueueHealthLogger,
    createStalePrintStationsBroadcaster,
    getPrintQueueHealth,
    getStalePrintStations
} = require('./printQueueWatchdog');

const RECOVERY_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const MIN_RUN_MS = 30 * 1000;
const DEBOUNCE_MS = 25;

function createPrintQueueWatchdogRunner({
    db,
    logger,
    emitStale,
    wakeHub,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    recoveryMs = RECOVERY_MS,
    retryMs = RETRY_MS,
    minRunMs = MIN_RUN_MS,
    debounceMs = DEBOUNCE_MS
}) {
    const logHealthChange = createPrintQueueHealthLogger(logger);
    const broadcastStaleIfChanged = createStalePrintStationsBroadcaster(emitStale);
    let started = false;
    let timer = null;
    let timerDueAt = Infinity;
    let inFlight = null;
    let dirty = false;
    let lastStartedAt = -Infinity;
    let unsubscribe = null;

    function clearTimer() {
        if (timer === null) return;
        clearTimeoutFn(timer);
        timer = null;
        timerDueAt = Infinity;
    }

    function scheduleAt(dueAt) {
        if (!started || (timer !== null && timerDueAt <= dueAt)) return;
        clearTimer();
        timerDueAt = dueAt;
        timer = setTimeoutFn(() => {
            timer = null;
            timerDueAt = Infinity;
            return run();
        }, Math.max(0, dueAt - now()));
        timer?.unref?.();
    }

    function scheduleDirty() {
        scheduleAt(Math.max(now() + debounceMs, lastStartedAt + minRunMs));
    }

    async function inspect() {
        const health = await getPrintQueueHealth(db);
        logHealthChange(health);
        const stations = await getStalePrintStations(db);
        broadcastStaleIfChanged(stations);
    }

    async function run() {
        if (!started || inFlight) return inFlight;
        clearTimer();
        dirty = false;
        lastStartedAt = now();
        const request = inspect();
        inFlight = request;
        let success = false;
        try {
            await request;
            success = true;
        } catch (error) {
            logger.error({ err: error }, 'Print queue watchdog encountered an error.');
        } finally {
            if (inFlight === request) inFlight = null;
            if (started) {
                if (dirty) scheduleDirty();
                else scheduleAt(now() + (success ? recoveryMs : retryMs));
            }
        }
        return success;
    }

    function wake() {
        if (!started) return false;
        dirty = true;
        if (!inFlight) scheduleDirty();
        return true;
    }

    function start() {
        if (started) return inFlight || Promise.resolve(undefined);
        started = true;
        unsubscribe = wakeHub?.subscribe?.(wake) || null;
        return run();
    }

    async function stop() {
        if (!started && !inFlight) return;
        started = false;
        dirty = false;
        clearTimer();
        unsubscribe?.();
        unsubscribe = null;
        if (inFlight) await inFlight.catch(() => {});
    }

    return { start, wake, stop };
}

module.exports = { createPrintQueueWatchdogRunner };
```

Do not expose timing configuration through environment variables. Constructor overrides exist only for deterministic tests.

- [ ] **Step 7: Wire committed queue activity, startup, and shutdown**

In `server.js`:

1. Import `createPrintQueueWatchdogRunner`.
2. Keep `getFailedPrintJobsCount` and `getStalePrintStations` imports for socket bootstrap; remove the inline health logger/broadcaster/interval ownership.
3. After Socket.IO exists, create and register the runner:

```js
const printQueueWatchdog = createPrintQueueWatchdogRunner({
    db,
    logger,
    wakeHub: spoolerSyncWakeHub,
    emitStale: payload => io.to('staff').emit('stale_print_stations', payload)
});
app.set('printQueueWatchdog', printQueueWatchdog);
```

4. In `onServerStarted()`, replace the old 30-second interval with:

```js
void printQueueWatchdog.start();
```

5. At the beginning of `gracefulShutdown()`, capture:

```js
const printQueueWatchdogStop = printQueueWatchdog.stop();
```

6. Await it with existing maintenance work before the pool closes:

```js
await Promise.all([
    databaseMaintenanceStop,
    printQueuePurgeStop,
    printQueueWatchdogStop
]);
```

In `backend/routes/spoolerV2.js`, immediately after `const result = outcome.result`, calculate committed activity without treating heartbeat-only sync as a signal:

```js
const queueActivity = result.queueStateChanged
    || result.jobs.length > 0
    || result.cancelRequested.length > 0
    || result.confirmedAccepted.length > 0;
if (queueActivity) req.app.get('printQueueWatchdog')?.wake();
```

This line must remain before `if (outcome.aborted || res.writableEnded) return;`. `runAgentSync` has already committed, so response loss cannot suppress the process-local signal. Do not add database reads to this route.

- [ ] **Step 8: Add committed-activity and shutdown wiring assertions**

In `backend/tests/integration/spoolerV2Sync.test.js`, temporarily replace the app setting with `{ wake: vi.fn() }` and prove:

- a committed terminal result wakes once;
- committed returned job activity wakes once;
- a heartbeat-only sync wakes zero times;
- replay of an already-terminal result wakes zero times;
- restore the original app setting in `finally`.

In `backend/tests/unit/spoolerV2OnlyContract.test.js`, assert the server:

```js
expect(serverSource).toContain("app.set('printQueueWatchdog', printQueueWatchdog)");
expect(serverSource).toContain('void printQueueWatchdog.start()');
expect(shutdown.indexOf('printQueueWatchdog.stop()')).toBeGreaterThan(-1);
expect(shutdown.indexOf('printQueueWatchdog.stop()')).toBeLessThan(shutdown.indexOf('pool.end()'));
expect(serverSource).not.toMatch(/setInterval\(async \(\) => \{\s*try \{\s*const health = await getPrintQueueHealth/s);
```

- [ ] **Step 9: Run Task 1 GREEN tests**

```powershell
npx vitest run backend/tests/unit/spoolerSyncWake.test.js backend/tests/unit/printQueueWatchdog.test.js backend/tests/unit/printQueueWatchdogRunner.test.js backend/tests/unit/spoolerWakeCommitBoundaries.test.js backend/tests/unit/spoolerV2OnlyContract.test.js backend/tests/integration/spoolerV2Sync.test.js --no-file-parallelism
```

Expected: all selected tests pass with no open timer or database handle.

- [ ] **Step 10: Update architecture and commit Task 1**

Update `docs/architecture.json`:

- update stable node `inf-boot-jobs` to replace the unconditional 30-second print interval with the event-first, 30-second-rate-bounded runner and five-minute sweep;
- update stable node `prn-queue-watchdog` and stable flow `flow-spooler-v2-admin-health` to name the spooler wake subscription, committed sync activity wake, authoritative two-query inspection, missed-signal recovery, and shutdown drain;
- state explicitly that heartbeat-only sync does not wake the watchdog and the active Print Queue browser fallback remains 30 seconds;
- do not change the spooler protocol, delivery, claim, or settlement flow.

```powershell
npm run architecture
npm run architecture:check
git add backend/services/spoolerSyncWake.js backend/services/printQueueWatchdogRunner.js backend/routes/spoolerV2.js server.js backend/tests/unit/spoolerSyncWake.test.js backend/tests/unit/printQueueWatchdogRunner.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/unit/spoolerV2OnlyContract.test.js docs/architecture.json docs/architecture.html
git commit -m "perf(printing): wake the queue watchdog on durable activity"
```

---

### Task 2: Make JoFotara recovery mode-aware without weakening stale submission repair

**Files:**
- Modify: `backend/services/JofotaraService.js`
- Create: `backend/services/JofotaraOperationsRunner.js`
- Modify: `backend/routes/admin/jofotara.js`
- Modify: `server.js`
- Create: `backend/tests/unit/jofotaraOperationsRunner.test.js`
- Modify: `backend/tests/integration/jofotara.test.js`
- Modify: `backend/tests/unit/spoolerV2OnlyContract.test.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

**Interfaces:**
- `processJofotaraOperations()` adds internal result field `automatic_enabled: boolean`; existing counters remain unchanged.
- `createJofotaraOperationsRunner({ processOperations, recoverStale, publish, logger, ...clockOverrides }) -> { start, configure, stop }` owns full versus stale-only cadence.
- `start() -> Promise<object | undefined>` performs one immediate full pass and is idempotent.
- `configure(automaticEnabled) -> Promise<object | undefined>` applies a committed settings state; enablement starts a full pass, disablement cancels the full timer and schedules stale-only recovery.
- `stop() -> Promise<void>` clears timers and awaits current work.
- The server stores the runner as `app.set('jofotaraOperationsRunner', jofotaraOperationsRunner)` for the supported settings writer.
- The settings writer emits `jofotara_operations_changed` to staff only after commit so other open admin clients reload the committed mode even when the runner has no fiscal work to publish.

- [ ] **Step 1: Add RED service-result and settings-notification tests**

Extend `backend/tests/integration/jofotara.test.js`:

```js
it('reports whether the automatic recovery cadence is active', async () => {
    await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key IN ('jofotara_enabled','jofotara_auto_submit')");
    await expect(processJofotaraOperations()).resolves.toMatchObject({
        automatic_enabled: false,
        attempted: 0,
        stale: 0
    });

    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key IN ('jofotara_enabled','jofotara_auto_submit')");
    await pool.query("UPDATE settings SET setting_value=DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') WHERE setting_key='jofotara_auto_submit_since'");
    await expect(processJofotaraOperations()).resolves.toMatchObject({ automatic_enabled: true });
});

it('reconfigures the owned runner only after a successful settings commit', async () => {
    const original = app.get('jofotaraOperationsRunner');
    const configure = vi.fn();
    app.set('jofotaraOperationsRunner', { configure });
    try {
        await request(app).put('/api/admin/jofotara/settings')
            .set('Cookie', adminCookie)
            .send({
                enabled: true,
                auto_submit: true,
                profiles: {
                    sales_tax: {
                        client_id: 'client',
                        secret_key: 'secret',
                        income_source_sequence: '123',
                        seller_tax_number: '987654321',
                        seller_registered_name: 'Test Seller'
                    }
                }
            })
            .expect(200);
        expect(configure).toHaveBeenCalledOnce();
        expect(configure).toHaveBeenCalledWith(true);

        configure.mockClear();
        await request(app).put('/api/admin/jofotara/settings')
            .set('Cookie', adminCookie)
            .send({ tax_registration_type: 'other' })
            .expect(400);
        expect(configure).not.toHaveBeenCalled();

        configure.mockClear();
        await request(app).put('/api/admin/jofotara/settings')
            .set('Cookie', adminCookie)
            .send({ enabled: false, auto_submit: false })
            .expect(200);
        expect(configure).toHaveBeenCalledWith(false);
    } finally {
        app.set('jofotaraOperationsRunner', original);
    }
});
```

The rejected request above is deliberately made after a successful enablement. It proves a validation failure neither changes the runner mode nor reuses the previous successful configuration call. Keep the runner swap inside `try/finally` so the shared integration app is restored even if an assertion fails.

- [ ] **Step 2: Run the service/route RED tests**

```powershell
npx vitest run backend/tests/integration/jofotara.test.js --no-file-parallelism
```

Expected: the result-field test fails because `automatic_enabled` is absent; the route test fails because no runner is configured.

- [ ] **Step 3: Expose the mode in the existing operation result**

In `backend/services/JofotaraService.js`, compute the mode once after loading settings:

```js
const automaticEnabled = settings.jofotara_enabled === '1'
    && settings.jofotara_auto_submit === '1'
    && Boolean(settings.jofotara_auto_submit_since);
```

Return it in both branches:

```js
if (!automaticEnabled) {
    return {
        automatic_enabled: false,
        attempted: 0,
        accepted: 0,
        rejected: 0,
        unknown: 0,
        failed: 0,
        stale
    };
}

const result = {
    automatic_enabled: true,
    attempted: 0,
    accepted: 0,
    rejected: 0,
    unknown: 0,
    failed: 0,
    stale
};
```

Do not reorder `markStaleSubmissionsUnknown()` and the settings read inside the full pass. Full startup/active behavior stays identical; only the runner decides when a full pass is required.

- [ ] **Step 4: Add RED tests for the mode-aware runner**

Create `backend/tests/unit/jofotaraOperationsRunner.test.js` with a fake clock and deferred promises. Cover these exact cases:

```js
it('runs one full pass at startup and only stale recovery every five minutes while inactive', async () => {
    const subject = makeSubject({ automaticEnabled: false });
    await subject.runner.start();
    expect(subject.processOperations).toHaveBeenCalledOnce();
    expect(subject.clock.nextDelay()).toBe(300_000);
    await subject.clock.advance(60_000);
    expect(subject.processOperations).toHaveBeenCalledOnce();
    await subject.clock.advance(240_000);
    expect(subject.recoverStale).toHaveBeenCalledOnce();
});

it('keeps the existing sixty-second full cadence while active', async () => {
    const subject = makeSubject({ automaticEnabled: true });
    await subject.runner.start();
    expect(subject.clock.nextDelay()).toBe(60_000);
    await subject.clock.advance(60_000);
    expect(subject.processOperations).toHaveBeenCalledTimes(2);
});

it('enables immediately and disables without an extra full run', async () => {
    const subject = makeSubject({ automaticEnabled: false });
    await subject.runner.start();
    subject.setAutomaticEnabled(true);
    await subject.runner.configure(true);
    expect(subject.processOperations).toHaveBeenCalledTimes(2);
    await subject.runner.configure(false);
    await subject.clock.advance(60_000);
    expect(subject.processOperations).toHaveBeenCalledTimes(2);
    expect(subject.clock.nextDelay()).toBe(240_000);
});

it('does not let an older active result override a committed disable', async () => {
    const pending = deferred();
    const subject = makeSubject({ processResult: pending.promise });
    const starting = subject.runner.start();
    const configured = subject.runner.configure(false);
    pending.resolve(activeResult());
    await starting;
    await configured;
    expect(subject.clock.nextDelay()).toBe(300_000);
});

it('queues one full follow-up when enablement occurs during stale work', async () => {
    const pending = deferred();
    const subject = makeSubject({ automaticEnabled: false, staleResult: pending.promise });
    await subject.runner.start();
    const staleRun = subject.clock.advance(300_000);
    subject.setAutomaticEnabled(true);
    void subject.runner.configure(true);
    pending.resolve(0);
    await staleRun;
    await subject.flush();
    expect(subject.processOperations).toHaveBeenCalledTimes(2);
});

it('emits only when fiscal state changed', async () => {
    const subject = makeSubject({ automaticEnabled: true });
    await subject.runner.start();
    expect(subject.publish).not.toHaveBeenCalled();
    subject.setNextResult({ ...activeResult(), attempted: 1, accepted: 1 });
    await subject.clock.advance(60_000);
    expect(subject.publish).toHaveBeenCalledOnce();
    subject.setAutomaticEnabled(false);
    await subject.runner.configure(false);
    subject.setNextStale(2);
    await subject.clock.advance(300_000);
    expect(subject.publish).toHaveBeenCalledTimes(2);
});

it('retries a failed startup in one minute and stop drains without rescheduling', async () => {
    const pending = deferred();
    const subject = makeSubject({ processResult: pending.promise });
    const starting = subject.runner.start();
    const stopping = subject.runner.stop();
    pending.reject(new Error('database unavailable'));
    await starting;
    await stopping;
    expect(subject.clock.timerCount()).toBe(0);
    expect(subject.logger.warn).toHaveBeenCalledOnce();
});
```

The fixture must allow the automatic flag to change independently of a previously created result so the configuration-race tests are real rather than fixed-object assertions.

- [ ] **Step 5: Run the JoFotara runner RED test**

```powershell
npx vitest run backend/tests/unit/jofotaraOperationsRunner.test.js --no-file-parallelism
```

Expected: FAIL because `backend/services/JofotaraOperationsRunner.js` does not exist.

- [ ] **Step 6: Implement the mode-aware JoFotara runner**

Create `backend/services/JofotaraOperationsRunner.js`:

```js
const ACTIVE_INTERVAL_MS = 60 * 1000;
const INACTIVE_STALE_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 1000;

function createJofotaraOperationsRunner({
    processOperations,
    recoverStale,
    publish,
    logger,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    activeIntervalMs = ACTIVE_INTERVAL_MS,
    inactiveStaleIntervalMs = INACTIVE_STALE_INTERVAL_MS,
    retryIntervalMs = RETRY_INTERVAL_MS
}) {
    let started = false;
    let mode = 'unknown';
    let timer = null;
    let inFlight = null;
    let configRevision = 0;
    let fullPending = false;

    function clearTimer() {
        if (timer === null) return;
        clearTimeoutFn(timer);
        timer = null;
    }

    function schedule(kind, delay) {
        if (!started) return;
        clearTimer();
        timer = setTimeoutFn(() => {
            timer = null;
            return kind === 'full' ? runFull() : runStaleOnly();
        }, delay);
        timer?.unref?.();
    }

    function safePublish(result) {
        if (Number(result?.attempted || 0) === 0 && Number(result?.stale || 0) === 0) return;
        try { publish(result); }
        catch (error) { logger.warn({ err: error }, 'Failed to publish JoFotara operations change.'); }
    }

    function scheduleForMode() {
        if (mode === 'active') schedule('full', activeIntervalMs);
        else schedule('stale', inactiveStaleIntervalMs);
    }

    async function runFull() {
        if (!started) return undefined;
        if (inFlight) {
            fullPending = true;
            return inFlight;
        }
        clearTimer();
        const revisionAtStart = configRevision;
        const request = Promise.resolve().then(processOperations);
        inFlight = request;
        let result;
        let success = false;
        try {
            result = await request;
            success = true;
            if (revisionAtStart === configRevision) {
                mode = result?.automatic_enabled === true ? 'active' : 'inactive';
            }
            safePublish(result);
        } catch (error) {
            logger.warn({ err: error }, 'JoFotara operations check failed (non-fatal).');
        } finally {
            if (inFlight === request) inFlight = null;
        }
        if (!started) return result;
        if (fullPending && mode === 'active') {
            fullPending = false;
            void runFull();
        } else if (!success && mode !== 'inactive') {
            schedule('full', retryIntervalMs);
        } else {
            fullPending = false;
            scheduleForMode();
        }
        return result;
    }

    async function runStaleOnly() {
        if (!started) return undefined;
        if (inFlight) return inFlight;
        clearTimer();
        const request = Promise.resolve().then(recoverStale);
        inFlight = request;
        let stale = 0;
        let success = false;
        try {
            stale = Number(await request) || 0;
            success = true;
            safePublish({
                automatic_enabled: false,
                attempted: 0,
                accepted: 0,
                rejected: 0,
                unknown: 0,
                failed: 0,
                stale
            });
        } catch (error) {
            logger.warn({ err: error }, 'JoFotara stale submission check failed (non-fatal).');
        } finally {
            if (inFlight === request) inFlight = null;
        }
        if (!started) return stale;
        if (fullPending && mode === 'active') {
            fullPending = false;
            void runFull();
        } else {
            schedule('stale', success ? inactiveStaleIntervalMs : retryIntervalMs);
        }
        return stale;
    }

    function start() {
        if (started) return inFlight || Promise.resolve(undefined);
        started = true;
        return runFull();
    }

    function configure(automaticEnabled) {
        configRevision += 1;
        mode = automaticEnabled ? 'active' : 'inactive';
        clearTimer();
        if (!started) return Promise.resolve(undefined);
        if (!automaticEnabled) {
            fullPending = false;
            if (!inFlight) schedule('stale', inactiveStaleIntervalMs);
            return inFlight || Promise.resolve(undefined);
        }
        if (inFlight) {
            fullPending = true;
            return inFlight;
        }
        return runFull();
    }

    async function stop() {
        if (!started && !inFlight) return;
        started = false;
        fullPending = false;
        clearTimer();
        if (inFlight) await inFlight.catch(() => {});
    }

    return { start, configure, stop };
}

module.exports = { createJofotaraOperationsRunner };
```

Do not share the print runner's rate-bound state machine. JoFotara has a mode transition, a stale-only operation, and a fiscal age gate; forcing both jobs behind one interface would make the interface shallower and the tests harder to reason about.

- [ ] **Step 7: Wire supported settings, server startup, and shutdown**

In `server.js`, import `markStaleSubmissionsUnknown` with `processJofotaraOperations`, create the runner after Socket.IO exists, and register it:

```js
const jofotaraOperationsRunner = createJofotaraOperationsRunner({
    processOperations: () => processJofotaraOperations(),
    recoverStale: () => markStaleSubmissionsUnknown(),
    publish: result => io.to('staff').emit('jofotara_operations_changed', result),
    logger
});
app.set('jofotaraOperationsRunner', jofotaraOperationsRunner);
```

Replace the inline `processJofotara` function and `setInterval` in `onServerStarted()` with:

```js
void jofotaraOperationsRunner.start();
```

At graceful shutdown start, capture:

```js
const jofotaraOperationsRunnerStop = jofotaraOperationsRunner.stop();
```

Await it in the same `Promise.all` as database maintenance, print purge, and print watchdog before `pool.end()`.

In `backend/routes/admin/jofotara.js`, immediately after `await conn.commit()` and before the success response, emit the committed mode to staff and reconfigure the runner in separate non-fatal guards:

```js
try {
    req.app.get('io')?.to('staff').emit('jofotara_operations_changed', {
        configuration_changed: true,
        automatic_enabled: isAutomatic
    });
} catch (error) {
    logAdminRouteError(req, error);
}
try {
    const configured = req.app.get('jofotaraOperationsRunner')?.configure(isAutomatic);
    void Promise.resolve(configured).catch(error => logAdminRouteError(req, error));
} catch (error) {
    logAdminRouteError(req, error);
}
```

The call is after commit and intentionally not awaited. A runner failure cannot turn a committed settings save into a 500. Validation, cutoff creation, and database commit remain authoritative. Do not notify the runner from checkout; the two-minute recovery age makes that wake premature.

- [ ] **Step 8: Add lifecycle wiring assertions**

Extend `backend/tests/unit/spoolerV2OnlyContract.test.js` or create `backend/tests/unit/backgroundRunnerWiring.test.js` with these source contracts:

```js
expect(serverSource).toContain("app.set('jofotaraOperationsRunner', jofotaraOperationsRunner)");
expect(serverSource).toContain('void jofotaraOperationsRunner.start()');
expect(shutdown.indexOf('jofotaraOperationsRunner.stop()')).toBeGreaterThan(-1);
expect(shutdown.indexOf('jofotaraOperationsRunner.stop()')).toBeLessThan(shutdown.indexOf('pool.end()'));
expect(serverSource).not.toContain('setInterval(processJofotara, 60 * 1000)');
expect(checkoutSource).not.toContain("get('jofotaraOperationsRunner')");
```

The last assertion is load-bearing: a future change must not reintroduce one useless recovery wake per checkout.

- [ ] **Step 9: Run Task 2 GREEN tests**

```powershell
npx vitest run backend/tests/unit/jofotaraOperationsRunner.test.js backend/tests/unit/jofotaraClient.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/checkoutPostCommit.test.js backend/tests/unit/spoolerV2OnlyContract.test.js --no-file-parallelism
```

Expected: all selected tests pass. Existing automatic recovery, exclusion, cutoff, concurrency, uncertain-result, and two-minute-age cases remain unchanged.

- [ ] **Step 10: Update architecture and commit Task 2**

Update `docs/architecture.json`:

- update `inf-boot-jobs` to name the owned JoFotara runner, one-minute active full mode, five-minute inactive stale-only mode, post-commit settings notification/reconfiguration, changed-only fiscal publication, and graceful drain;
- update stable node `rep-jofotara-svc` and stable flow `flow-jofotara-retry` to keep the two-minute age gate and state that checkout does not wake the background recovery runner;
- record that inactive mode does not query settings or candidates repeatedly, while a startup full pass and supported settings changes restore the active mode;
- do not change fiscal document ownership, XML construction, provider submission, audit, or operator retry flows.

```powershell
npm run architecture
npm run architecture:check
git add backend/services/JofotaraService.js backend/services/JofotaraOperationsRunner.js backend/routes/admin/jofotara.js server.js backend/tests/unit/jofotaraOperationsRunner.test.js backend/tests/integration/jofotara.test.js backend/tests/unit/spoolerV2OnlyContract.test.js docs/architecture.json docs/architecture.html
git commit -m "perf(jofotara): idle the automatic recovery runner safely"
```

---

## Final Focused Verification

- [ ] Run the combined touched suite once, serially:

```powershell
npx vitest run backend/tests/unit/spoolerSyncWake.test.js backend/tests/unit/printQueueWatchdog.test.js backend/tests/unit/printQueueWatchdogRunner.test.js backend/tests/unit/spoolerWakeCommitBoundaries.test.js backend/tests/unit/jofotaraOperationsRunner.test.js backend/tests/unit/jofotaraClient.test.js backend/tests/unit/spoolerV2OnlyContract.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/checkoutPostCommit.test.js --no-file-parallelism
npm run architecture:check
```

- [ ] Re-run the local query-count probes against `.env.test` MariaDB:

1. One print inspection must execute exactly two top-level commands.
2. One inactive full JoFotara pass must execute exactly two commands and return `automatic_enabled:false`.
3. One inactive stale-only runner tick must execute exactly one command and no settings/candidate `SELECT`.

- [ ] Run fake-clock behavior for 24 simulated hours without sleeping:

| Case | Required result |
|---|---|
| Quiet print runner | 1 startup inspection + 288 recovery inspections; 578 DB commands including startup |
| Print signals every 500 ms | no overlap; no more than 1 inspection start per 30 seconds; one trailing dirty run |
| Print DB failure | retry after 30 seconds; success returns to five-minute cadence |
| Inactive JoFotara | 1 startup full pass + 288 stale-only passes; no minute-level settings/candidate scan |
| Active JoFotara | one full pass per 60 seconds, unchanged from current behavior |
| Disable during full run | old result cannot rearm active mode |
| Enable during stale run | exactly one full follow-up after stale work settles |
| Shutdown during either query | timer removed; stop waits; no query begins after pool drain starts |

- [ ] Confirm Git scope:

```powershell
git status --short
git diff --check HEAD~2..HEAD
git log -2 --oneline
git diff --name-only HEAD~2..HEAD
```

Expected: exactly two implementation commits. No migration, schema, release, installer, checkout, table, order-item, auth/session, WebAuthn, service-charge, Y-report, provider endpoint, or spooler protocol file changed.

## Adversarial Completion Gate

Before claiming completion, point every case below to an exact passing test:

1. A hundred queue publishes in one tick produce one watchdog inspection, not one hundred.
2. Continuous V2 job traffic never exceeds the previous 30-second watchdog start cadence.
3. A publish between inspection completion and timer registration is not lost.
4. A publish during an inspection yields exactly one trailing run.
5. A broken wake subscriber cannot block agent long-poll waiters or a committed print transaction.
6. A terminal agent result commits and its HTTP client disconnects: the watchdog is still woken before the response-abort return.
7. Heartbeat-only agent sync produces no watchdog wake.
8. A station recorded stale with queued work reconnects and receives work: returned activity wakes the watchdog so stale state clears promptly.
9. A station goes stale with no further event: the five-minute sweep eventually broadcasts it.
10. Active Print Queue UI remains authoritative on its existing 30-second visible-tab fallback; no server event becomes a correctness dependency.
11. Inactive JoFotara performs no recurring settings or candidate read at one minute.
12. Inactive JoFotara still converts a stale `submitting` row to `unknown` through the five-minute safety sweep.
13. JoFotara startup during a transient database failure retries after one minute rather than stopping permanently.
14. Automatic enablement commits, then starts one full pass; rollback or validation failure starts none.
15. Automatic disablement during an in-flight active run cannot be overwritten by that run's older `automatic_enabled:true` result.
16. Enabling during a stale-only run produces one full follow-up and never overlaps the stale query.
17. A fresh pending checkout document remains untouched until the existing two-minute recovery age; no checkout wake was added.
18. No-op JoFotara recovery emits no browser event; an attempted or stale-state change emits one.
19. Provider timeout, uncertain outcome, rejected outcome, unique document ownership, source exclusions, and automatic cutoff tests remain green.
20. Graceful shutdown starts both runner stops before closing the pool and waits for both in-flight promises.

If satisfying any case requires a generic scheduler, a new table, a database event, a shorter safety interval, a checkout wait, a provider retry, or a spooler protocol change, stop. That is scope drift, not completion of this plan.

## Explicitly Deferred

- HTTP/Socket.IO durable-session validation coalescing.
- WebAuthn ceremony drain capacity and `auth_sessions` retention/index work.
- Service-charge snapshot and Y-archive maintenance extraction.
- Shared order-item writer and table transactional refactor.
- CORS default behavior and print-template source-of-truth work.
- A JoFotara `(status, last_attempt_at)` index was originally deferred because local `EXPLAIN` identified it as a candidate without enough production-scale evidence.

None of these belong in the two commits above.

## Owner-approved extension — JoFotara stale-submission index

The owner explicitly approved closing the deferred index after Tasks 1 and 2. This is a third, isolated commit; it must not be folded into either runtime-runner commit.

- Add exactly `idx_jofotara_status_attempt (status, last_attempt_at)` to support the stale `submitting` recovery predicate.
- Successor: `2026-08-23-audit-browser-preview-v1` with checksum `e76a5c6a6ff9e831d6c5e5f5d907ba01732f5cd6446b231cc732b9e7728198af`.
- Migration: `2026-08-30-jofotara-stale-submission-index-v1`, checksum generated from that exact name.
- Use one additive `ADD INDEX IF NOT EXISTS ... ALGORITHM=INPLACE, LOCK=NONE` statement. Never fall back to COPY.
- Preflight must be read-only and accept the named index only when absent or exactly `(status, last_attempt_at)` in that order; a conflicting same-name index fails closed.
- Follow the repository migration workflow: Luna writes the normal/auto/preflight SQL, ordered manifest entry, and verbatim Hostinger fallback block; the main agent independently verifies and owns baseline, fixture, bootstrap, schema validation, tests, evidence, and commit.
- Update the fresh baseline hash and require both the new ledger row and exact index shape at startup.
- Prove on disposable MariaDB data that the unindexed stale update scans broadly while the indexed form selects the composite key, and verify first apply, reapply/no-op, current-baseline no-op, manifest order/hash, and fallback parity.
