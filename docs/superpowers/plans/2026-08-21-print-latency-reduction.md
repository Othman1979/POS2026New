# Print Latency Reduction Implementation Plan — rev 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution status — 2026-08-22.** Tasks 1–5 are implemented on
> `codex/print-latency-task1` and Task 6's automated gates are green. The unchecked
> boxes below are the plan as written, kept verbatim so the review can compare intent
> against what landed; they are **not** a progress indicator.
>
> | Task | Implementation | Review follow-up |
> | --- | --- | --- |
> | 1 — scheduler safe to wake | `30ef9678` | `580625ef` |
> | 2 — decouple scheduling domains | `648ca1c9` | `c0fd3d8d` |
> | 3 — artifact metadata on settle | `e052d8eb` | `968c50ab` |
> | 4 — result-ready wake | `98bd3cbc` | `e79f3393` |
> | 5 — 500 ms cadence | `2bec2fe5` | — |
> | 6 — measure, map, evidence | `01954a07`, `1d8d1a95` | — |
>
> **Still open, and reachable only on venue hardware:** the 20 warm latency samples,
> the cold-start sample, the shared-printer contention sample, physical
> receipt/kitchen correctness, and the staged rollout in Task 6 Step 6. Automated
> readiness is green; the product latency target is not yet measured.
> Evidence: [`2026-08-22-print-latency-measurement.md`](../evidence/2026-08-22-print-latency-measurement.md).

**Goal:** Remove the scheduling dead time in the print path so a warm, uncontended
receipt reaches paper in a median well under one second, and a finished print settles
on the server in one round trip instead of one full sync cadence — without changing
how work is owned, leased, or settled.

**Architecture:** Six tasks in a forced order. The first two are pure hardening of the
agent's schedulers and carry no latency benefit of their own: they exist because the
latency changes are not safe on top of the current schedulers. Only then does the plan
add artifact instrumentation, the result-ready wake, and the faster cadence, and
finish by measuring what it actually bought.

**Tech Stack:** Node 22 (server + agent), MariaDB 10.4, vitest for the backend, the
spooler package's own plain-node runner.

## Global Constraints

- **No schema change.** Every column this plan writes already exists and is already
  validated server-side. If a task appears to need a migration, stop — it has drifted
  from the plan.
- **No new network channel.** No Socket.IO to agents, no long-poll, no inbound port on
  a till.
- **Sol's seven invariants hold unchanged.** See the compliance table. Any diff that
  weakens one is a defect, not a trade-off.
- Backend tests are **vitest**, not jest. **One vitest process at a time** — the suite
  shares `posapp_test`.
- The spooler package has its own runner. Each spooler test file is standalone and is
  spawned by `tests/run-tests.js` with no arguments, so a focused run is
  `node tests/<file>.test.js` from `pos-spooler-printer/`, and the whole spooler suite
  is `node tests/run-tests.js`.
- **The repository's full gate is `npm run test:unit`, not `npm test`.** Root
  `npm test` is aliased to `npm run build:admin` and runs no tests at all. Using it as
  a final gate produces a false green.
- English is the i18n identity fallback; only `src/shared/i18n/ar.json` gets new rows.
  This plan adds no user-facing strings.
- No push, no merge, no deploy, no production migration until the whole plan is
  reviewed.

---

## What changed in rev 2, and why the order changed

Rev 1 proposed three tasks: artifact metadata, a result-ready wake, and a 500 ms
cadence. An adversarial review
(`docs/superpowers/evidence/2026-08-22-print-latency-reduction-plan-adversarial-review.md`)
raised 33 findings. Every High and Critical was re-verified against source for this
rev and confirmed. The disposition of all 33 is tabulated at the end.

The review's central point is correct, and is why this is a reordering rather than a
patch: **rev 1's two latency changes are unsafe on the current schedulers.**

- `runtime.wake()` is `schedule(0)`, and `schedule` arms a timer that calls `tick()`
  without checking whether a tick is already in the air. Today nothing calls `wake()`,
  so this is latent. Rev 1's Task 2 would have been its first caller and would have
  produced overlapping authenticated syncs — duplicate outbox bodies, overlapping
  same-agent transactions, and a `stop()` that awaits only the newer one. Rev 1's "the
  race, and why it is already safe" section was wrong: it described the pending-timer
  overwrite and missed that a `setTimeout(…, 0)` fires long before an HTTP round trip
  returns.
- `schedule()` also clears the outage-backoff timer, so a result-ready wake during a
  server outage cancels containment and produces an immediate failed request per
  finished lane.
- `agent-runtime.js:174` calls `worker.wake()` on **every** successful sync, and
  `server.js:123` fans that into `statusMonitor.wake()` **and** a full clear of the
  workers' `deferredUntilWake` set. So the sync cadence silently drives physical
  printer probing and the retry pace for store failures. Quadrupling the cadence
  quadruples both.

Rev 2 therefore fixes the schedulers first, in two tasks that change no user-visible
behaviour, and only then applies the latency changes.

**Two corrections to the review itself.** Neither changes a verdict.

- P-M2 and P-M10 cite `scripts/spoolerV2MixedJobsHarness.js`. The file is at
  `backend/tests/manual/spoolerV2MixedJobsHarness.js`.
- P-C1's required correction asks for status polling to be made single-flight *and*
  decoupled. Only the decoupling is needed. `poll()` re-arms its own timer from its own
  tail (`status-monitor.js:67`), so it is serial by construction; overlap is reachable
  **only** through `wake()`. Task 2 deletes `wake()` from the monitor, which removes
  the reachability rather than guarding it. An in-flight guard as well would be dead
  code.

**One hazard neither the plan nor the review caught: rollout order.** Task 5 is
server-only and reaches the whole fleet on each agent's next sync. Tasks 1–4 are
agent-side and reach a till only when that till is updated. If the server ships the
500 ms cadence before the fleet has Tasks 1 and 2, every un-updated till gets 4×
printer probing and 4× store-failure retry with none of the fixes. The rollout
sequence in Task 6 is therefore load-bearing, and is the reason the cadence is behind
an environment variable rather than a constant.

---

## Measured baseline (2026-08-21), with its limits stated

| Stage | Value | How obtained | Confidence |
| --- | --- | --- | --- |
| Backend compile + enqueue | 1–8 ms | timed `prepareQueuedPrintPayload`, 5 runs | measured, ms |
| **Agent poll wait** | **0–2000 ms, mean ~1000** | `V2_NEXT_SYNC_MS = 2000` | derived from the constant |
| Render (Chrome → raster) | ~185 ms steady; 1461 ms cold | timed `renderer.render`, 5 runs on queue row 19 | measured, ms |
| Physical print | ~430 ms | 759 px @ 203 dpi = 95 mm ÷ 200–230 mm/s rated | **calculated, not measured** |
| `accepted_at → acknowledged_at` | 2 s on most rows, 3 s on at least one | `print_queue` rows 12–19 | **whole-second columns — see below** |
| `duration_ms`, receipt alone | 443, 471, 472 ms | rows 13–15 | measured, ms |
| `duration_ms`, contending | 1266, 1293 ms | rows 17, 19 — receipt + kitchen ticket to one Windows device | measured, ms |
| Sync-shaped DB transaction | median 1.02 ms, max 2.25 ms | 10 runs against `posapp` | measured, ms |
| Local pool | `DB_CONNECTION_LIMIT=50` | `.env` | **not representative — templates ship 10** |

**Two limits on this table, both of which rev 1 papered over.**

1. `print_queue.created_at` is `timestamp` and `sent_at`, `accepted_at`,
   `acknowledged_at` are `datetime`, all without fractional seconds
   (`deployment/database/baseline.sql:731,742,743,749`). A "2 s" reading is anywhere in
   a 2 s bucket. These columns **cannot** prove a sub-second improvement, and rev 1's
   "exactly 2000 ms" claim was over-precise. Task 6 measures with an in-process
   millisecond clock instead. No migration is needed for that.
2. `deployment/templates/pos.env.template:12` and
   `deployment/templates/hostinger.env.template:9` both ship `DB_CONNECTION_LIMIT=10`.
   The local 50 proves nothing about a venue. The arithmetic is still comfortable —
   5 agents × 2 syncs/s × ~3 ms of connection occupancy is ~3 % of one connection out
   of ten — but Task 6 confirms it at 10 rather than asserting it from a 50.

**Interpretation.** Roughly half the wall time is the agent asleep. Render and physical
print are near their floors. The settle lag happens after paper and costs nothing
perceptually, but it makes the queue, the failed-jobs badge and failure surfacing stale
by up to a full cadence.

**Goal, stated honestly.** Rev 1 said "well under 1 s" unconditionally, which its own
figures contradict. The target is:

| Case | Target | Note |
| --- | --- | --- |
| Warm, uncontended receipt, enqueue → paper, P50 | **< 1000 ms** | the product goal |
| Warm, uncontended, P95 | < 1400 ms | render and device variance dominate |
| First receipt after an agent restart | ~2.1 s, unchanged | cold Chromium is ~1461 ms and this plan does not touch it |
| Receipt contending with a kitchen ticket on one Windows device | ~1.7 s, unchanged | `duration_ms` alone is 1266–1293 ms; that is the shared-printer configuration, not code |

## Invariant compliance

| # | Invariant | T1 | T2 | T3 | T4 | T5 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Printing is pull-only over `/api/spooler/v2` | unchanged | unchanged | unchanged | unchanged | unchanged — no channel added; only the interval advertised on the existing route moves |
| 2 | One active/draining agent per station, DB-enforced | unchanged | unchanged | unchanged | unchanged | unchanged |
| 3 | Agent-owned work is never automatically reassigned | unchanged — claim still requires `agent_id IS NULL` | unchanged | unchanged | unchanged | unchanged |
| 4 | Anything that may have reached paper is never auto-reprinted | unchanged — settle mapping untouched | unchanged | unchanged | unchanged | unchanged |
| 5 | Failed/uncertain work requires audited human recovery | unchanged | unchanged | unchanged | unchanged | unchanged |
| 6 | Independent serial lanes; Chromium globally one page | unchanged | **strengthened** — status probes stop taking the print lane on every sync | unchanged | unchanged — see the corrected note in Task 4; the wake reaches the renderer only through the pump every cadence tick already ran | unchanged |
| 7 | Stale-station handling is visibility-only | unchanged | unchanged | unchanged | unchanged | unchanged — stale threshold is 120 s, decoupled |

No task writes to `print_queue.agent_id`, `print_queue.status`, or
`spooler_agents.status`.

## Task order and dependency

```
T1 scheduler safe to wake ──┐
T2 decouple domains ────────┼──> T4 result-ready wake ──┐
T3 artifact metadata ───────┘                           ├──> T6 measure + roll out
                            T2 ──> T5 500 ms cadence ───┘
```

T1 and T2 are prerequisites and carry no latency win of their own. T3 is independent.
**T4 must not land before T1. T5 must not land before T2.**

---

### Task 1: Make the sync scheduler safe to wake

**Why first:** the runtime's `wake()` is currently unreachable — `grep -rn "\.wake()"`
across `pos-spooler-printer/` finds only `workers.wake()` and `statusMonitor.wake()`.
Task 4 makes it reachable. On today's scheduler that produces overlapping authenticated
syncs and cancels outage backoff. This task makes `wake()` safe before anything calls
it, and bounds the pre-existing urgent spin so Task 5 can raise the rate-limit ceiling
without loosening containment.

**Nothing here changes behaviour for a healthy agent talking to a healthy server.** It
changes what happens when a wake races a sync, when a wake lands during an outage, and
when the server stops confirming.

**Files:**
- Modify: `pos-spooler-printer/v2/agent-runtime.js:16-41,158,179-183,200-203,223-225`
- Test: `pos-spooler-printer/tests/v2-sync-runtime.test.js`

**Interfaces:**
- Produces: `runtime.wake()` with a single-flight, backoff-aware contract — at most one
  sync in flight, wakes coalesce into one prompt follow-up, and a wake never shortens
  an active failure backoff.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

This suite is plain `node` with `require('assert')`. It already provides `FakeClock`
(recording every delay in `clock.delays`, firing timers via `await clock.runNext()`), a
`worker()` fake, a `response(overrides)` builder, and `temporaryRoot()`. Each block is a
bare async IIFE. First add a small helper beside `temporaryRoot()`:

```js
function deferredPromise() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}
```

Then append four blocks:

```js
(async () => {
    // A wake during an in-flight sync must not start a second one. Two concurrent
    // ticks send the same outbox twice and overlap the same agent's transaction.
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const release = deferredPromise();
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async () => {
                calls += 1;
                concurrent += 1;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                if (calls === 1) await release.promise;
                concurrent -= 1;
                return response();
            }
        },
        worker: worker(),
        clock
    });
    runtime.start();
    const firstTick = clock.runNext();
    await new Promise(resolve => setImmediate(resolve));
    runtime.wake();
    runtime.wake();
    runtime.wake();
    release.resolve();
    await firstTick;
    assert.strictEqual(maxConcurrent, 1, 'at most one sync may be in flight');
    assert.strictEqual(calls, 1, 'wakes during a sync must not add sync calls');
    assert.strictEqual(clock.delays.at(-1), 0, 'coalesced wakes must yield one prompt follow-up');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // A finished print does not justify hammering a server that is already failing.
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    let calls = 0;
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async () => { calls += 1; throw new Error('ECONNREFUSED'); } },
        worker: worker(),
        clock,
        random: () => 0
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(clock.delays.at(-1), 2000, 'a failed sync must back off');
    runtime.wake();
    runtime.wake();
    assert.strictEqual(clock.delays.at(-1), 2000, 'a wake must not shorten an active backoff');
    assert.strictEqual(calls, 1, 'a wake during backoff must not issue a request');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // An urgent sync that moved nothing is a loop, not progress. Pace it.
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    store.accept({
        queue_id: 210,
        idempotency_key: 'nonprogress-210',
        payload_hash: 'e'.repeat(64),
        printer_id: 1,
        print_type: 'kitchen'
    });
    const clock = new FakeClock();
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async () => response({ next_sync_ms: 4000 }) },
        worker: worker(),
        clock
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(clock.delays.at(-1), 4000, 'urgent work the server never confirms must not spin at 0');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // The legitimate fast path stays fast: new jobs arrived, so the loop is moving.
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async () => response({
                next_sync_ms: 4000,
                jobs: [{
                    queue_id: 211,
                    idempotency_key: 'progress-211',
                    payload_hash: 'f'.repeat(64),
                    printer_id: 1,
                    print_type: 'kitchen'
                }]
            })
        },
        worker: worker(),
        clock
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(clock.delays.at(-1), 0, 'a sync that durably accepted new work must stay immediate');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
```

The fourth block's `jobs` entry uses the same shape as the existing `queued` fixture at
`v2-sync-runtime.test.js:126-132`, which `store.accept` already accepts. That existing
block also asserts `clock.delays.at(-1) === 0` at `:144` after receiving a job, and it
keeps passing under the new gate: a durably accepted job **is** progress.

Every IIFE needs its own `.catch` that sets `process.exitCode` — that is this file's
convention for all 14 of its existing blocks. Without it a rejection in one block is
reported against a later block, or silently passes.

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/v2-sync-runtime.test.js` from `pos-spooler-printer/`
Expected: FAIL on the first block with `maxConcurrent === 2` — this reproduces the
review's runtime experiment — and FAIL on the third block with a delay of `0`.

- [ ] **Step 3: Make the scheduler single-flight and backoff-aware**

In `agent-runtime.js`, add two state variables beside the existing ones at `:16-27`:

```js
    let pendingWake = false;
    let backoffUntil = 0;
```

Replace `schedule` at `:33-41`:

```js
    function schedule(delay) {
        if (stopped) return;
        if (timer !== null) clock.clearTimeout(timer);
        timer = clock.setTimeout(async () => {
            timer = null;
            // Single-flight. setTimeout(0) fires long before an HTTP round trip
            // returns, so without this a wake starts a second tick alongside the
            // first: the same outbox is sent twice, two transactions overlap on one
            // agent's rows, and stop() ends up awaiting only the newer one.
            if (inFlight) { pendingWake = true; return; }
            inFlight = tick();
            try {
                await inFlight;
            } finally {
                inFlight = null;
                if (pendingWake) {
                    pendingWake = false;
                    // Never shorten containment - same rule as wake().
                    if (now() >= backoffUntil) schedule(0);
                }
            }
        }, delay);
    }
```

Replace `wake` at `:223-225`:

```js
    function wake() {
        if (stopped) return;
        // Coalesce into the sync already in the air rather than racing it.
        if (inFlight) { pendingWake = true; return; }
        // A finished print is not a reason to cancel outage backoff. The result is
        // durable in the outbox; the backed-off tick will ship it. Dropping the wake
        // loses nothing and keeps a failing server from being hit once per lane.
        if (now() < backoffUntil) return;
        schedule(0);
    }
```

On the success path at `:158`, clear the deadline alongside the counter:

```js
            consecutiveFailures = 0;
            backoffUntil = 0;
```

In the catch at `:200-203`, record the deadline the delay establishes:

```js
            const base = BACKOFF_MS[Math.min(consecutiveFailures, BACKOFF_MS.length - 1)];
            const delay = base + Math.floor(base * 0.25 * random());
            consecutiveFailures += 1;
            backoffUntil = now() + delay;
            schedule(delay);
```

Leave the `unauthorized_agent` re-register branch's `schedule(0)` alone — it runs
before `backoffUntil` is set and is a deliberate immediate retry after a successful
re-registration.

- [ ] **Step 4: Bound the urgent spin**

Replace the urgent scheduling at `:179-183`:

```js
            const urgent = accepted.length > 0
                || store.unconfirmedAccepted().length > 0
                || store.outbox().length > 0
                || (response.jobs || []).length > 0;
            // Urgency alone does not justify a 0ms reschedule. If the server confirmed
            // nothing, we accepted nothing and nothing was cancelled, the next sync
            // carries an identical body - that is a loop, and today only the rate
            // limiter stops it. Note `accepted` excludes jobs the store rejected, so a
            // permanently unacceptable job cannot masquerade as progress either.
            // Falling back to the normal cadence costs a genuinely stuck accept one
            // cadence of latency and nothing else.
            const progressed = accepted.length > 0
                || (response.confirmed_accepted || []).length > 0
                || (response.confirmed_results || []).length > 0
                || (response.cancel_requested || []).length > 0;
            schedule(urgent && progressed ? 0 : syncDelay(response.next_sync_ms, 2000));
```

- [ ] **Step 5: Update the one existing test this deliberately contradicts**

`tests/v2-sync-runtime.test.js:383` asserts *"non-throttled durable accepts must keep
immediate sync"* using a pre-seeded unconfirmed accept and a response that confirms
nothing. That is exactly the no-progress shape, and the assertion encodes the spin as a
contract. Changing it is the point of Step 4, not collateral damage.

Delete that block. The two new blocks from Step 1 replace it and are strictly more
specific: one pins that unconfirmed work paces instead of spinning, the other that a
sync which durably accepted new work stays immediate. Say in the commit message that
the old assertion was removed on purpose.

Leave `:359` alone — throttled responses must still schedule exactly `next_sync_ms`,
and Task 5 depends on that.

- [ ] **Step 6: Run and watch them pass**

Run: `node tests/v2-sync-runtime.test.js`
Expected: PASS.

Then the whole spooler suite once, because `schedule` is shared by every runtime test:

Run: `node tests/run-tests.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add pos-spooler-printer/v2/agent-runtime.js pos-spooler-printer/tests/v2-sync-runtime.test.js
git commit -m "fix(spooler): make the sync scheduler single-flight, backoff-aware and spin-bounded"
```

---

### Task 2: Stop the sync tick from driving printer probes and store-failure retries

**Why:** `agent-runtime.js:174` calls `worker.wake()` after every successful sync.
`server.js:120-123` composes that as `workers.wake(); statusMonitor.wake();`, and
`printer-workers.js:320-324` clears the **entire** `deferredUntilWake` set on every
wake. So today the sync cadence is also the printer-probe cadence and the store-failure
retry cadence. At 2000 ms that coincidentally matches the monitor's own
`intervalMs = 2000`, which is why nobody noticed. At 500 ms it becomes 4× on both.

The probe path matters because `status-monitor.js:54` takes the printer lane through
`runExclusive`, the same lane `printer-workers.js:221` uses for print work, so a slow or
offline TCP probe can delay an arriving receipt. Windows printers take the `watch` path
instead, which only re-runs when the set of Windows printers changes, so a Windows-only
venue sees the retry effect but not the lane contention. Both are real; neither should
be a function of the sync cadence.

**Files:**
- Modify: `pos-spooler-printer/server.js:120-123`
- Modify: `pos-spooler-printer/v2/status-monitor.js:82-87,115`
- Modify: `pos-spooler-printer/v2/printer-workers.js:31,149-153,237,317,320-324`
- Test: `pos-spooler-printer/tests/v2-printer-workers.test.js`

**Interfaces:**
- Produces: `createPrinterWorkers(...)` gains no new option; its deferred set becomes
  deadline-based internally. `createStatusMonitor(...)` no longer returns `wake`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

`tests/v2-printer-workers.test.js` supplies `fakeStore(records)`, `record(id, printerId,
printType)` and `deferred()`. `fakeStore` writes the settle payload onto `row.result`.

`createPrinterWorkers` already destructures `now = () => Date.now()`
(`printer-workers.js:21`). Use that for the deadline — do not introduce a second clock.

```js
(async () => {
    // A store failure must be paced by its own deadline, not by the sync tick. A full
    // disk should not be retried four times faster because the fleet's sync cadence
    // changed.
    const rows = [record(45, 1, 'receipt')];
    const store = fakeStore(rows);
    let recordAttempts = 0;
    store.recordResult = () => {
        recordAttempts += 1;
        const error = new Error('ENOSPC');
        error.code = 'ENOSPC';
        throw error;
    };
    let clockValue = 1000;
    const workers = createPrinterWorkers({
        store,
        renderer: {
            render: async () => {
                const error = new Error('RENDER_OUTCOME_UNKNOWN');
                error.failureClass = 'uncertain';
                throw error;
            },
            health: () => ({ state: 'ready' })
        },
        transportFor: () => ({ async send() { return { success: true, durationMs: 5 }; } }),
        now: () => clockValue
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(recordAttempts, 1, 'the outcome must be attempted once');

    workers.wake();
    await workers.idle();
    assert.strictEqual(recordAttempts, 1, 'a wake before the deadline must not retry the store write');

    clockValue += 5000;
    workers.wake();
    await workers.idle();
    assert.strictEqual(recordAttempts, 2, 'a wake after the deadline must retry the store write');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });
```

**Why the failure is injected at the render stage, not the transport stage.** The
deferred record has to remain *collectable* for the deadline to be observable, and
`fakeStore.runnable()` only returns `queued`, `rendered` and `retry_wait`. A transport
-stage store failure happens after `markTransportStarted`, which parks the row in
`transport_started` — permanently outside `runnable()`, so the third assertion could
never pass no matter how the deadline behaved. Failing in the renderer keeps the row
`queued`. The path is exact: `render` throws → `pumpRender` catch at `:282` →
`finishFailure(record, error, 'render')` → the `uncertain` branch at `:110` calls
`store.recordResult`, which throws → re-thrown at `:141` because it is not
`JOB_TERMINAL` → caught at `:285` → `releaseAfterStoreFailure`. `failureClass:
'uncertain'` is load-bearing: without it the error falls to `scheduleRetry`, which calls
`store.recordRetry` instead and never reaches the deferred path at all.

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/v2-printer-workers.test.js` from `pos-spooler-printer/`
Expected: FAIL on the middle assertion — the wake clears the whole deferred set, so the
store write is retried immediately.

- [ ] **Step 3: Give the deferred set its own deadline**

In `printer-workers.js`, replace the `Set` at `:31`:

```js
    // queue_id -> earliest retry time. A deadline, not a flag: the retry pace for a
    // failing disk must not depend on how often the agent syncs.
    const deferredUntil = new Map();
    const STORE_FAILURE_RETRY_MS = 2000;
```

`releaseAfterStoreFailure` at `:149-153`:

```js
    function releaseAfterStoreFailure(record, storeError, stage) {
        owned.delete(record.queue_id);
        deferredUntil.set(record.queue_id, now() + STORE_FAILURE_RETRY_MS);
        console.error(`print job ${record.queue_id}: could not record the ${stage} outcome, deferring the retry`, storeError);
    }
```

`collect()` at `:237`, replacing the `deferredUntilWake.has(...)` skip:

```js
            const notBefore = deferredUntil.get(record.queue_id);
            if (notBefore !== undefined) {
                if (now() < notBefore) continue;
                deferredUntil.delete(record.queue_id);
            }
```

`wake()` at `:320-324` — delete the `deferredUntilWake.clear()` line and the comment
above it that explains it, keeping the pump:

```js
    function wake() {
        if (started && !pumpScheduled) {
            pumpScheduled = true;
            queueMicrotask(() => pumpRender().catch(err => console.error(err)));
        }
    }
```

`stop()` at `:317` — keep the clear, renamed to `deferredUntil.clear();`.

**No timer is needed for the deadline.** `wake()` still schedules a pump and the pump
calls `collect()`, so a record whose deadline has passed is picked up by the first wake
after it. Syncs happen at least every 5 s, so the effective retry pace is the deadline,
bounded above by one cadence.

- [ ] **Step 4: Run and watch it pass**

Run: `node tests/v2-printer-workers.test.js`
Expected: PASS.

- [ ] **Step 5: Unwire the status monitor from the sync tick**

`pos-spooler-printer/server.js:120-123`:

```js
        const worker = {
            start() { workers.start(); statusMonitor.start(); },
            stop() { statusMonitor.stop(); return workers.stop(); },
            // Print work only. A sync tick is not news about a printer's physical
            // state, and the monitor already runs its own 2s loop. Coupling them made
            // every sync fire a probe onto the same lane print jobs use.
            wake() { workers.wake(); },
```

Then delete `wake` from `status-monitor.js:82-87` and from its returned object at
`:115`. Confirm with:

```bash
grep -rn "statusMonitor.wake\|monitor.wake" pos-spooler-printer --include=*.js
```

That must come back empty — `server.js:123` is its only caller and no test uses it.
Deleting it also removes the monitor's overlapping-poll hazard rather than guarding it.

- [ ] **Step 6: Run the whole spooler suite**

Run: `node tests/run-tests.js` from `pos-spooler-printer/`
Expected: PASS, 23/23 files. If `v2-status-monitor.test.js` fails, a test is exercising
the deleted `wake` — check before deleting the assertion; the grep in Step 5 says there
is none.

- [ ] **Step 7: Commit**

```bash
git add pos-spooler-printer/server.js pos-spooler-printer/v2/status-monitor.js pos-spooler-printer/v2/printer-workers.js pos-spooler-printer/tests/v2-printer-workers.test.js
git commit -m "fix(spooler): decouple printer probing and store-failure retries from the sync cadence"
```

---

### Task 3: Report artifact size on settle

**This task reduces no latency.** It is an observability prerequisite: it makes the
difference between "this receipt was slow" and "this receipt was 95 mm of paper on a
contended device" checkable instead of guessed, which is what Task 6 needs to interpret
its own numbers. Do not credit it as a latency win in the commit message.

**Files:**
- Modify: `pos-spooler-printer/v2/printer-workers.js:192-197`
- Test: `pos-spooler-printer/tests/v2-printer-workers.test.js`
- Test: `backend/tests/integration/spoolerV2Sync.test.js`

**Interfaces:**
- Consumes: `record.artifact` from `renderer.render()` —
  `{ path, hash, bytes, width, height, render_ms, raster_ms }`.
- Produces: two extra keys on the result object that `store.outbox()` already forwards
  verbatim.

**No server change is required.** `backend/services/spoolerSync.js:146-149` already
validates and stores both: `artifact_hash` must match `/^[0-9a-f]{64}$/`, and
`artifact_bytes` must be an integer in `[0, 16777216]`. Anything else becomes `NULL`.

**What these two fields do and do not mean.** `artifact_bytes` is the size of the
rendered raster — a proxy for paper length, not a measure of time. `duration_ms` is
transport-dependent: on the Windows helper path it includes the drain poll, and on the
TCP path (`printer-transports.js:179-196`) it can complete once bytes are written while
the device's real state is still unknown. Read them together with `confidence`, and
never quote `duration_ms` alone as physical print time.

- [ ] **Step 1: Write the failing test**

Append to `tests/v2-printer-workers.test.js`:

```js
(async () => {
    const rows = [record(41, 1, 'receipt')];
    const store = fakeStore(rows);
    const artifact = { path: '41.bin', hash: 'b'.repeat(64), bytes: 54684, width: 576, height: 759 };
    const workers = createPrinterWorkers({
        store,
        renderer: { render: async () => artifact, health: () => ({ state: 'ready' }) },
        transportFor: () => ({
            async send() {
                return { success: true, durationMs: 443, deviceStatus: 'drained', confidence: 'spooler_drained' };
            }
        })
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(rows[0].result.artifact_bytes, 54684, 'settle must carry the artifact size');
    assert.strictEqual(rows[0].result.artifact_hash, 'b'.repeat(64), 'settle must carry the artifact hash');
    assert.strictEqual(rows[0].result.duration_ms, 443, 'device time must be unchanged');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/v2-printer-workers.test.js`
Expected: FAIL — `result.artifact_bytes` is `undefined`.

- [ ] **Step 3: Add the two fields**

At `printer-workers.js:192`:

```js
                    store.recordResult(record.queue_id, {
                        outcome: 'completed',
                        device_status: result.deviceStatus || 'unknown',
                        confidence: result.confidence || 'unknown',
                        duration_ms: result.durationMs,
                        // The server already validates and stores both
                        // (spoolerSync.js:146). Sending them turns "why was this
                        // receipt slow" from guesswork into arithmetic: bytes gives
                        // paper length, duration_ms plus confidence gives device time.
                        artifact_bytes: record.artifact?.bytes,
                        artifact_hash: record.artifact?.hash
                    });
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node tests/v2-printer-workers.test.js`, then `node tests/run-tests.js`
Expected: PASS.

**Deliberately not done:** the four failure paths also settle, and the server writes
`artifact_bytes` on every outcome, so they *could* carry it too. They are left alone
because a render failure has no artifact at all and the value on a dead-lettered job is
marginal. Dead-lettered rows keep `artifact_bytes NULL`; that is expected, not a bug.

- [ ] **Step 5: Pin the invalid-input path server-side**

`backend/tests/integration/spoolerV2Sync.test.js:157-183` **already** settles a valid
`artifact_hash`/`artifact_bytes` pair and asserts persistence. Do not duplicate it. The
untested half is the rejection path, which is the entire reason no migration is needed.

Add one test to the `describe('spooler V2 sync lifecycle')` block at `:137`, beside the
existing one, using the file's real helpers — `register(agentId, spoolerId, secret)`,
`sync(agentId, secret, body)` and `insertJob(spoolerId, key)`, CommonJS, no `syncAs`. It
must claim and accept a **fresh** job: settling an already-terminal row leaves the
columns untouched and would pass for the wrong reason.

```js
    it('stores null rather than failing the sync when artifact metadata is malformed', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-bad-artifact');

        const first = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: queueId, payload_hash: first.body.jobs[0].payload_hash }]
        });
        const settled = await sync(AGENT_A, SECRET_A, {
            results: [{
                queue_id: queueId,
                outcome: 'completed',
                device_status: 'ok',
                duration_ms: 90,
                artifact_hash: 'not-a-hash',
                artifact_bytes: 'not-a-number'
            }]
        });

        expect(settled.body.confirmed_results).toEqual([queueId]);
        const [[row]] = await pool.query(
            'SELECT status, artifact_hash, artifact_bytes FROM print_queue WHERE id = ?',
            [queueId]
        );
        expect(row.status).toBe('acknowledged');
        expect(row.artifact_hash).toBeNull();
        expect(row.artifact_bytes).toBeNull();
    });
```

Run: `npx vitest run backend/tests/integration/spoolerV2Sync.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pos-spooler-printer/v2/printer-workers.js pos-spooler-printer/tests/v2-printer-workers.test.js backend/tests/integration/spoolerV2Sync.test.js
git commit -m "feat(spooler): report artifact size on settle so print time is explainable"
```

---

### Task 4: Wake the sync loop when a result is ready

**Requires Task 1.** Do not start this until Task 1 is merged and green.

**Why:** the measured `accepted_at → acknowledged_at` gap is a whole sync cadence on
every row, because nothing tells the sync loop a result exists. The `urgent` branch that
would ship it immediately already exists (`agent-runtime.js:179-183`) — it is simply
never re-evaluated between scheduled ticks. `runtime.wake()` is already exported and
already does the right thing; nothing calls it.

**This does not make paper appear sooner.** It makes the queue, the failed-jobs badge
and failure surfacing honest in near-real time.

**Files:**
- Modify: `pos-spooler-printer/v2/printer-workers.js` (add `onResultReady`, call it
  after each recorded result)
- Modify: `pos-spooler-printer/server.js:115` (late-bind to `runtime.wake()`)
- Test: `pos-spooler-printer/tests/v2-printer-workers.test.js`
- Test: `pos-spooler-printer/tests/v2-sync-runtime.test.js`

**Interfaces:**
- Produces: `createPrinterWorkers({ ..., onResultReady })`, defaulting to a no-op so
  every existing caller and test is unaffected.
- Consumes: `runtime.wake()` as hardened in Task 1 — single-flight, backoff-aware, safe
  after shutdown.

- [ ] **Step 1: Write the failing tests**

Three blocks. They cover a success, a settled failure, and a throwing hook.

```js
(async () => {
    const rows = [record(42, 1, 'receipt')];
    const store = fakeStore(rows);
    let wakes = 0;
    const workers = createPrinterWorkers({
        store,
        renderer: { render: async () => ({ path: '42.bin', hash: 'c'.repeat(64), bytes: 10 }), health: () => ({ state: 'ready' }) },
        transportFor: () => ({ async send() { return { success: true, durationMs: 5 }; } }),
        onResultReady: () => { wakes += 1; }
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(wakes, 1, 'one recorded result must produce exactly one wake');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // A failing job settles too, so it must also wake the loop - otherwise a
    // dead-lettered receipt stays invisible for a full cadence and the badge lies.
    const rows = [record(43, 1, 'receipt')];
    const store = fakeStore(rows);
    let wakes = 0;
    const workers = createPrinterWorkers({
        store,
        renderer: { render: async () => ({ path: '43.bin', hash: 'd'.repeat(64), bytes: 10 }), health: () => ({ state: 'ready' }) },
        transportFor: () => ({
            async send() {
                const error = new Error('WINspool_DRAIN_UNKNOWN');
                error.code = 'WINspool_DRAIN_UNKNOWN';
                error.failureClass = 'uncertain';
                throw error;
            }
        }),
        onResultReady: () => { wakes += 1; }
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(rows[0].state, 'uncertain', 'uncertain must still dead-letter, not retry');
    assert.strictEqual(wakes, 1, 'a settled failure must wake the loop too');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // The hook must never be able to fail a print.
    const rows = [record(44, 1, 'receipt')];
    const store = fakeStore(rows);
    const workers = createPrinterWorkers({
        store,
        renderer: { render: async () => ({ path: '44.bin', hash: 'e'.repeat(64), bytes: 10 }), health: () => ({ state: 'ready' }) },
        transportFor: () => ({ async send() { return { success: true, durationMs: 5 }; } }),
        onResultReady: () => { throw new Error('hook exploded'); }
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(rows[0].state, 'completed', 'a throwing hook must not change the print outcome');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });
```

**On invariant 6 — corrected 2026-08-22 during review of `98bd3cbc`.** These tests stub
the renderer, so they exercise `pumpRender`'s re-entry guard, **not** the `enqueue`
serialization in `artifact-renderer.js` that actually bounds Chromium to one page. Do
not claim they protect invariant 6.

An earlier revision of this note claimed the hook "never enters the render path". That
is wrong, and the call chain says so: `runtime.wake()` → `schedule(0)` → `tick()` →
`startWorkers()` (`agent-runtime.js:211`) → `worker.wake()` → the `server.js` facade →
`workers.wake()` → `pumpRender()`. A result-ready wake **does** reach the renderer.

It is still safe, for a different and checkable reason: this is not a *new* path into
the renderer, only an earlier one. Every cadence tick already ran exactly this pump via
`startWorkers()`. What bounds Chromium is unchanged — `pumpRender`'s `rendering` and
`pumpScheduled` guards, and `enqueue`'s single serial chain in `artifact-renderer.js` —
and Task 1's single-flight coalescing bounds how often the pump can be triggered no
matter how many results land at once. Verify by reading that chain, not by asserting on
a stub.

- [ ] **Step 2: Run and watch all three fail**

Run: `node tests/v2-printer-workers.test.js` from `pos-spooler-printer/`
Expected: FAIL — `onResultReady` is not a recognised option, so `wakes` stays 0 in the
first two blocks. The third block passes trivially before the change; it becomes
meaningful only after Step 3.

- [ ] **Step 3: Add the hook**

Add `onResultReady = () => {}` to the `createPrinterWorkers` signature, then define one
helper:

```js
    // Edge-triggered: fires once per recorded result, never on a bare loop pass. The
    // sync loop already has an `urgent` branch that ships the outbox immediately; it
    // just never re-evaluates between scheduled ticks. Waking it here is the whole fix.
    // Never throw from here - a telemetry hook must not be able to fail a print.
    function announceResult() {
        try { onResultReady(); } catch (error) { console.error('result-ready hook failed', error); }
    }
```

There are **five** `store.recordResult(...)` sites, not three. Call `announceResult()`
immediately after each, still inside the enclosing `try`, so a store failure skips the
wake rather than announcing a result that was never recorded:

| line | path | outcome |
| --- | --- | --- |
| 77 | `scheduleRetry` | `permanent_failure` / `RETRY_LIMIT_EXHAUSTED` |
| 111 | `finishFailure` | `uncertain` |
| 118 | `finishFailure` | `permanent_safe` |
| 130 | `finishFailure` | `transport_started` → `uncertain` |
| 192 | `runLane` | `completed` |

Do **not** call it in `releaseAfterStoreFailure` — no result was recorded there, and
waking re-enters the record that Task 2's deadline deliberately parked.

Do **not** call it after `store.recordRetry(...)` — a scheduled retry is not a result,
and waking on it would sync once per attempt across a 60-attempt receipt.

- [ ] **Step 4: Run and watch them pass**

Run: `node tests/v2-printer-workers.test.js`
Expected: PASS.

- [ ] **Step 5: Wire it in the agent, late-bound, and pin the seam**

`runtime` is constructed after `workers`, so capture it by reference. At
`pos-spooler-printer/server.js:115`:

```js
        let runtime = null;
        const workers = createPrinterWorkers({
            store,
            renderer,
            transportFor,
            onResultReady: () => runtime?.wake()
        });
```

If `runtime` is already declared in an enclosing scope, assign to that binding instead
of shadowing it — a shadowed `runtime` leaves the hook permanently null and every test
in this task still passes.

The three unit tests above can all pass with the production wiring absent, so add a
structural assertion. `backend/tests/unit/spoolerV2OnlyContract.test.js` is the
repository's precedent for source-scanning contract tests; this one belongs in the
spooler suite. Create `pos-spooler-printer/tests/v2-composition-contract.test.js`:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// A source scan, not an execution test: server.js boots a whole agent. It pins the two
// seams the unit tests cannot see, both of which are silently satisfiable by a stub.
assert.match(source, /onResultReady:\s*\(\)\s*=>\s*runtime\?\.wake\(\)/,
    'the result-ready hook must be wired to the runtime wake in production');
assert.doesNotMatch(source, /wake\(\)\s*\{\s*workers\.wake\(\);\s*statusMonitor\.wake\(\)/,
    'the sync tick must not wake the status monitor');
```

- [ ] **Step 6: Prove it against the real runtime**

Add to `tests/v2-sync-runtime.test.js`: build a runtime with `FakeClock`, let the first
tick settle to the normal cadence, then call `runtime.wake()` and assert
`clock.delays.at(-1)` is `0` while the sync-call count is unchanged until the timer
fires. Reuse the `worker()` and `response()` helpers.

Run: `node tests/run-tests.js` from `pos-spooler-printer/`
Expected: PASS, 24/24 files.

**The mid-flight race, and why it is safe — do not break this.** A wake that lands
during a sync is coalesced by Task 1 into a single follow-up. Independently of that,
the tick's own `urgent` check re-reads `store.outbox()` and `store.unconfirmedAccepted()`
**at response time**, not from the snapshot `body()` took when the request was sent, so
a result recorded mid-flight is seen by the very tick it raced. If anyone later
"optimises" `urgent` to reuse the `body()` snapshot, this task regresses to the full
cadence intermittently. Treat that line as load-bearing.

- [ ] **Step 7: Commit**

```bash
git add pos-spooler-printer/v2/printer-workers.js pos-spooler-printer/server.js pos-spooler-printer/tests/
git commit -m "fix(spooler): settle a finished print on the next tick, not a cadence later"
```

---

### Task 5: Advertise 500 ms, with headroom, a throttle floor and an idle cadence

**Requires Task 2.** Do not start this until Task 2 is merged and green, and read the
rollout order in Task 6 before deploying it.

**Why:** `V2_NEXT_SYNC_MS = 2000` is the single largest term in the measured budget.
`syncDelay` on the agent already clamps to `[500, 5000]` (`agent-runtime.js:29`), so
**500 ms needs no agent change** — the server just advertises it.

**This task must not be split.** Lowering the cadence alone is a defect: it spends
rate-limit budget that bursts need, and the punishment for running out is worse than the
problem being solved.

**The arithmetic that forces the other changes:**

- Limit today: `SYNC_MAX = 40` per `SYNC_WINDOW_MS = 10000` — four syncs per second per
  agent.
- At 2000 ms, steady state costs 5 of 40 per window. At 500 ms it costs **20 of 40**.
- Each job costs roughly two extra `urgent` syncs (confirm the accept, ship the result),
  and Task 4 makes the second one prompt rather than lazy.
- So at 500 ms the headroom is about **ten jobs per ten seconds**. Three or four orders
  in a rush, each with a receipt and one or two kitchen tickets, reaches that.
- The penalty for reaching it is `next_sync_ms: 5000` (`spoolerV2.js:56`) — **ten times
  the new cadence, and worse than doing nothing.**

**Deployment reach — verified, not assumed.** Every V2 agent honours the server's hint.
The clamp to `[500, 5000]` arrived in `084db483` (spooler 1.2.8); before that the agent
used `schedule(Number(response.next_sync_ms) || 2000)` — the hint was honoured
*unclamped*. Two consequences: the latency win reaches even un-updated tills, and the
server-side clamp is load-bearing for pre-1.2.8 agents that have no clamp of their own.
Never advertise a value below 500. Proven empirically against the real runtime with a
stub clock: advertising 2000 schedules 2000, 500 schedules 500, 100 schedules 500
(floor), 9999 schedules 5000 (ceiling).

**Files:**
- Modify: `backend/services/spoolerSync.js:2,69-79,294`
- Modify: `backend/routes/spoolerV2.js:9,29-30,56,146`
- Modify: `deployment/templates/pos.env.template`,
  `deployment/templates/hostinger.env.template`, `.env.example`
- Test: `backend/tests/integration/spoolerV2Sync.test.js`
- Test: `backend/tests/unit/installerConfig.test.js`

- [ ] **Step 1: Write the failing tests**

This file is CommonJS and its helpers are `register(agentId, spoolerId, secret)` and
`sync(agentId, secret, body)`. There is no `syncAs` and no `agent` variable. The
limiter's state lives in process memory (`spoolerV2.js:28`) and is **not** reset by
database cleanup or by `beforeEach`, so it accumulates per agent id across the whole
file. `AGENT_A` is already used by 47 sync calls here; an assertion on `next_sync_ms`
under that identity would read the throttled reply instead of the cadence if the window
happened not to have rolled. Give this test its own identity.

Add beside the other identities at the top of the file:

```js
const AGENT_CADENCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01';
```

and the test inside the `describe('spooler V2 sync lifecycle')` block at `:137`:

```js
    it('advertises the fast cadence to a healthy agent', async () => {
        await register(AGENT_CADENCE, 'station-1', 'cadence-secret');
        const response = await sync(AGENT_CADENCE, 'cadence-secret');
        expect(response.body.throttled).toBeUndefined();
        expect(response.body.next_sync_ms).toBe(500);
    });
```

The policy constants get a deterministic unit test rather than a timing-dependent one.
Create `backend/tests/unit/spoolerSyncCadence.test.js`:

```js
const { SYNC_MAX, SYNC_WINDOW_MS, V2_THROTTLE_SYNC_MS } = require('../../routes/spoolerV2');
const { V2_NEXT_SYNC_MS } = require('../../services/spoolerSync');

describe('spooler v2 sync cadence policy', () => {
    it('advertises a cadence the agent clamp will honour', () => {
        expect(V2_NEXT_SYNC_MS).toBeGreaterThanOrEqual(500);
        expect(V2_NEXT_SYNC_MS).toBeLessThanOrEqual(5000);
    });

    it('leaves burst headroom above steady-state cost', () => {
        // Steady state is one sync per cadence per window. The remainder is what a rush
        // of urgent accept/settle syncs has to fit into; require at least 3x.
        const steadyState = SYNC_WINDOW_MS / V2_NEXT_SYNC_MS;
        expect(SYNC_MAX).toBeGreaterThanOrEqual(steadyState * 4);
    });

    it('never answers "too fast" with "faster than your configured cadence"', () => {
        expect(V2_THROTTLE_SYNC_MS).toBeGreaterThanOrEqual(V2_NEXT_SYNC_MS);
    });
});
```

Deriving the headroom from `SYNC_WINDOW_MS / V2_NEXT_SYNC_MS` is the point: a copied
literal passes while the real ceiling drifts, and this assertion re-tightens
automatically if anyone lowers the cadence again.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run backend/tests/integration/spoolerV2Sync.test.js backend/tests/unit/spoolerSyncCadence.test.js`
Expected: FAIL — `next_sync_ms` is 2000, the constants are not exported, `SYNC_MAX` is
40 and the throttle reply is a literal 5000.

- [ ] **Step 3: Make the cadence configurable, with an idle tier**

`backend/services/spoolerSync.js:2`:

```js
// Advertised to every agent on every sync. Agents clamp to [500, 5000]
// (agent-runtime.js:29), but pre-1.2.8 agents honour the hint unclamped, so this clamp
// is load-bearing: never advertise below 500. Env-overridable because this is a
// fleet-wide latency knob - a bad value has to be revertible by editing .env and
// restarting, not by shipping a release.
const V2_NEXT_SYNC_MS = Math.min(Math.max(Number(process.env.SPOOLER_SYNC_INTERVAL_MS) || 500, 500), 5000);
// A revoked or decommissioned agent cannot claim work. Fast cadence buys it nothing and
// costs a DB-authenticated round trip twice a second, forever.
const V2_IDLE_SYNC_MS = 5000;
const WORKING_AGENT_STATUSES = new Set(['active', 'draining']);
```

At `:77`, inside the response object built after `locked` is read:

```js
            nextSyncMs: WORKING_AGENT_STATUSES.has(locked.status) ? V2_NEXT_SYNC_MS : V2_IDLE_SYNC_MS,
```

Add `V2_NEXT_SYNC_MS` and `V2_IDLE_SYNC_MS` to the `module.exports` at `:294`.

- [ ] **Step 4: Raise the ceiling and floor the penalty**

`backend/routes/spoolerV2.js`, importing the cadence at `:9`:

```js
const { runAgentSync, V2_NEXT_SYNC_MS } = require('../services/spoolerSync');
```

At `:29-30`:

```js
const SYNC_WINDOW_MS = 10000;
// 500ms steady state spends 20 of these; the rest is burst headroom for the urgent
// accept/settle syncs a rush generates. See the plan's arithmetic.
const SYNC_MAX = 80;
// Throttling is a brake, not a punishment - and it must never tell an agent to go
// faster than the cadence the operator configured, which a fixed 2000 would do if
// someone rolled SPOOLER_SYNC_INTERVAL_MS back to 5000.
const V2_THROTTLE_SYNC_MS = Math.max(2000, V2_NEXT_SYNC_MS);
```

Replace the literal `next_sync_ms: 5000` at `:56` with `next_sync_ms: V2_THROTTLE_SYNC_MS`,
and add `SYNC_MAX`, `SYNC_WINDOW_MS` and `V2_THROTTLE_SYNC_MS` to the `module.exports`
at `:146`.

- [ ] **Step 5: Update the existing throttle test in the same commit**

`it('throttles an authenticated runaway agent in-band')` at
`spoolerV2Sync.test.js:309-320` loops 41 times and asserts `next_sync_ms: 5000`. Both
numbers are the contract being deliberately changed. Drive the loop from the exported
constant rather than a new literal, and assert the exported reply value:

```js
        for (let i = 0; i < SYNC_MAX + 1; i += 1) response = await sync(AGENT_RATE, 'rate-secret');
```

with the expectation becoming `next_sync_ms: V2_THROTTLE_SYNC_MS`. Import both from
`../../routes/spoolerV2` at the top of the file.

**Known fragility, now bounded.** This test drives the limiter with real requests inside
a real 10 s window, so it only passes if `SYNC_MAX + 1` round trips finish inside 10 s.
At ~10 ms per request that is ~0.8 s for 81, and 41 already works this way. Driving the
loop from the constant means it cannot silently drift out of step with the ceiling, but
it also means the margin shrinks if the ceiling rises again. **If `SYNC_MAX` is ever
raised above 100, stop scaling this loop and make `SYNC_WINDOW_MS`/`SYNC_MAX` injectable
instead.** The unit test from Step 1 is the deterministic guard on the policy; this one
is the behavioural guard on the wiring.

- [ ] **Step 6: Document the knob where operators will find it**

Add to `deployment/templates/pos.env.template`, `deployment/templates/hostinger.env.template`
and `.env.example`:

```
# Sync cadence advertised to print agents, in ms. Clamped to [500, 5000]; 500 is the
# fastest agents will honour. Raise it to cut sync traffic at the cost of print latency.
SPOOLER_SYNC_INTERVAL_MS=500
```

`backend/tests/unit/installerConfig.test.js:40` already reads `pos.env.template`. Add an
assertion there that the key is present, so the knob cannot be silently dropped from the
template that operators actually receive.

- [ ] **Step 7: Run and watch them pass**

Run: `npx vitest run backend/tests/integration/spoolerV2Sync.test.js backend/tests/unit/spoolerSyncCadence.test.js backend/tests/unit/installerConfig.test.js`
Expected: PASS.

- [ ] **Step 8: Confirm the agent-side contract still holds**

`pos-spooler-printer/tests/v2-sync-runtime.test.js:359` asserts that throttled responses
schedule exactly `next_sync_ms`. That behaviour is unchanged and must still pass — it is
what makes the softer penalty take effect.

Run: `node tests/run-tests.js` from `pos-spooler-printer/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/services/spoolerSync.js backend/routes/spoolerV2.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/unit/spoolerSyncCadence.test.js backend/tests/unit/installerConfig.test.js deployment/templates/pos.env.template deployment/templates/hostinger.env.template .env.example
git commit -m "perf(spooler): advertise a 500ms sync cadence with matching burst headroom"
```

---

### Task 6: Measure honestly, update the map, then roll out

**Requires Tasks 1–5.** This is the acceptance gate, and it is the only place any
latency claim may be made.

**Files:**
- Create: `docs/superpowers/evidence/2026-08-2X-print-latency-measurement.md`
- Modify: `docs/architecture.json`, then regenerate `docs/architecture.html`

- [ ] **Step 1: Run the repository gates, once**

```bash
npx vitest run backend/tests/integration/spoolerV2Sync.test.js backend/tests/unit/spoolerSyncCadence.test.js backend/tests/unit/printQueueWatchdog.test.js backend/tests/unit/spoolerV2OnlyContract.test.js
```

```bash
npm run build
```

Then, exactly once, with no other vitest process running:

```bash
npm run test:unit
```

and

```bash
node tests/run-tests.js
```

from `pos-spooler-printer/`. Record the counts. `npm run test:unit` is the real gate —
its `pretest:unit` hook runs the schema-drift validator, which `npm test` does not.

- [ ] **Step 2: Measure the two intervals that actually moved**

The DB timestamps are whole-second and cannot show this (see the baseline section), and
`accepted_at → acknowledged_at` is the wrong interval anyway: it contains render and
physical transport, so it can never approach zero. Measure in-process instead.

Write a throwaway script under the scratchpad — not in the repo — that, with the real
agent running and the printer connected:

1. records `Date.now()`, inserts one receipt row into `print_queue`;
2. polls `SELECT status FROM print_queue WHERE id = ?` every 10 ms, stamping
   `Date.now()` at each transition through `sent`, `local_accepted`, `acknowledged`;
3. reads back `duration_ms`, `artifact_bytes` and `confidence`.

That yields, at 10 ms resolution and with no schema change:

| Interval | What it proves | Expected after |
| --- | --- | --- |
| enqueue → `sent` | the polling win (Task 5) | mean ~1000 ms → ~250 ms |
| `sent` → `local_accepted` | one agent round trip | roughly unchanged |
| `local_accepted` → `acknowledged` | the settle win (Task 4) | a full cadence → render + transport + one round trip, ~650 ms warm |
| `duration_ms` | the device, which this plan does not touch | unchanged |

Run it **20 times warm and uncontended** and report P50 and P95, not a single receipt —
`duration_ms` alone already varies 443–472 ms on identical work, so one sample proves
nothing. Then run it once cold (immediately after an agent restart) and once while a
kitchen ticket is printing, and report those separately against the goal table rather
than folding them into the median.

Scope every artifact assertion to rows settled by the updated agent during this run.
Historical rows and rows settled by older agents legitimately have `artifact_bytes NULL`.

- [ ] **Step 3: Confirm the cadence at the supported pool size, not the local one**

The templates ship `DB_CONNECTION_LIMIT=10`; local `.env` has 50, so the local run
proves nothing about a venue. On a scratch database with the limit set to 10, drive five
concurrent agent identities at the 500 ms cadence for 60 s and assert:

- no response carries `throttled: true`;
- ordinary routes stay responsive throughout;
- the connection-acquisition wait stays flat.

The arithmetic says this is comfortable — 5 agents × 2 syncs/s × ~3 ms of connection
occupancy is about 3 % of one connection out of ten — so this step is confirmation, not
discovery. If it is not comfortable, raise `SPOOLER_SYNC_INTERVAL_MS` rather than
shipping and hoping.

Then run the existing mixed-traffic harness once,
`backend/tests/manual/spoolerV2MixedJobsHarness.js`, and confirm no duplicate settlement
and no lane starvation. **Declared scope limit:** that harness hardcodes its own cadence
and does not drive `createAgentRuntime`, so it does not exercise the wake, backoff or
probe paths this plan changed. Those are covered by the unit tests in Tasks 1, 2 and 4.
Rewriting the harness onto the real runtime is worthwhile and is deliberately not in
this plan.

- [ ] **Step 4: Update the architecture map**

Two traced flows change and the map is the project's source of truth for them.

- `flow-spooler-v2-local-runtime` — step 6 currently describes replay under "2s, 5s,
  then 10s bounded outage backoff; throttled responses honor next_sync_ms". Extend it to
  record that the loop is single-flight, that a result-ready wake coalesces into an
  in-flight sync and never shortens backoff, and that an urgent reschedule requires
  durable progress. Add an edge from `prn-v2-printer-workers` to `prn-v2-agent-runtime`
  for the result-ready wake.
- `flow-spooler-v2-render-schedule` — record that status probing runs on its own
  cadence and no longer shares the sync tick, and that store-failure retries are paced
  by their own deadline.

Then:

```bash
npm run architecture && npm run architecture:check
```

Never hand-edit `docs/architecture.html`; it is generated.

- [ ] **Step 5: Write the evidence document and commit**

Record the measured table, the pool run, the suite counts, and the spooler package
version the agent tasks land in. Then commit the map and the evidence together.

```bash
git add docs/architecture.json docs/architecture.html docs/superpowers/evidence/
git commit -m "docs(spooler): record the print latency measurement and update the architecture map"
```

- [ ] **Step 6: Roll out in this order — the order is the safety property**

Tasks 1–4 are agent-side and reach a till only when that till is updated. Task 5 is
server-side and reaches the whole fleet on each agent's next sync. **A server at 500 ms
in front of un-updated agents gives those tills 4× printer probing and 4× store-failure
retry with none of the fixes.** So:

1. Build installers from a clean tree. Tasks 1–4 change only files already on the
   installer's core allowlist and add no dependency, so `POSAPP-Spooler-Update.exe`
   (Core mode) is sufficient — confirm `requiredRuntime.id` is unchanged before
   assuming that, and fall back to the Runtime-Update if it moved.
2. Deploy the server **with `SPOOLER_SYNC_INTERVAL_MS=2000` in the venue `.env`.** This
   is a no-op cadence change and keeps un-updated tills exactly as they are today.
3. Update one till. Confirm it comes back Online in Admin → Settings → Print queue with
   `station_protocol = v2` and a fresh `last_sync_at`, then print a receipt and a
   kitchen ticket on real paper before touching the next till.
4. Update the remaining tills.
5. Only then set `SPOOLER_SYNC_INTERVAL_MS=500` and restart the server. Watch the agent
   logs for `throttled` for one service period.

Rollback at any point is an `.env` edit and a server restart, not a release.

**A physical canary is not optional.** Every test in this plan stubs either the renderer
or the transport. Nothing in the suite proves paper came out. One receipt and one kitchen
ticket on real hardware per venue, before the venue opens.

---

## Findings ledger — the review's 33, and what rev 2 did with each

| # | Finding | Disposition |
| --- | --- | --- |
| S-H1 | Task 2 creates overlapping authenticated syncs | **Confirmed.** Fixed in Task 1 Step 3 (single-flight + coalesced wake). Rev 1's "already safe" section was wrong and is deleted. |
| S-H2 | Task 3's integration tests are not executable | **Confirmed.** `syncAs`/`agent` do not exist; the file is CommonJS. All backend tests rewritten on `register(...)`/`sync(...)`. Limiter state is process-memory and accumulates per agent id across the file, so the throttle test keeps `AGENT_RATE` and the new cadence test gets its own `AGENT_CADENCE` rather than borrowing `AGENT_A`, which already carries 47 sync calls. |
| S-H3 | Acceptance timings are not observable from `print_queue` | **Confirmed.** All four columns are whole-second. Baseline table re-labelled; Task 6 Step 2 measures in-process at 10 ms. |
| S-H4 | Unconditional subsecond goal conflicts with the plan's own floors | **Confirmed.** Replaced with a four-row goal table separating warm P50, warm P95, cold start and contention. |
| S-M1 | Rollback env var undocumented | **Confirmed.** Task 5 Step 6 adds it to both templates and `.env.example`, with an assertion in `installerConfig.test.js`. |
| S-M2 | Plan wrongly declares no architecture-map change | **Confirmed.** Task 6 Step 4 updates both affected flows and regenerates. |
| S-M3 | RED/GREEN cycles run the whole spooler suite | **Confirmed.** Each spooler test file is standalone, so focused runs are `node tests/<file>.test.js`; the full runner is reserved for task-end and the final gate. |
| S-M4 | "Full suite exactly once" names no executable command | **Confirmed, and worse than reported.** Root `npm test` is `npm run build:admin` — it runs no tests. The gate is `npm run test:unit`, now stated in Global Constraints and Task 6 Step 1. |
| S-M5 | Limiter assertion does not protect the chosen headroom | **Confirmed.** Replaced with a deterministic unit test deriving headroom from `SYNC_WINDOW_MS / V2_NEXT_SYNC_MS`, so it re-tightens if the cadence drops again. |
| S-M6 | Load validation uses the wrong pool and one agent | **Confirmed.** Templates ship 10, local `.env` has 50. Task 6 Step 3 runs 5 agents at limit 10. |
| S-M7 | A calculated printer speed is labelled as measured | **Confirmed.** Baseline table now carries a confidence column; 430 ms is marked calculated. |
| S-L1 | Task 1 duplicates an existing artifact test | **Confirmed.** `spoolerV2Sync.test.js:157-183` already covers the valid path. Task 3 Step 5 now adds only the rejection case. |
| S-L2 | Task 2's expected-failure prose is stale | **Confirmed.** "Both" → three blocks; the `wakes.length` reference is gone; the third block's pre-change behaviour is stated. |
| S-L3 | "Every acknowledged row" is too broad | **Confirmed.** Task 6 Step 2 scopes the assertion to rows settled by the updated agent during the run. |
| P-C1 | 500 ms cadence accelerates physical printer probes | **Confirmed; correction narrowed.** Task 2 Step 5 unwires the monitor from the sync tick. The requested in-flight guard is **not** added: `poll()` re-arms from its own tail and overlap was reachable only via `wake()`, which is deleted. |
| P-H1 | Result wakes cancel deliberate outage backoff | **Confirmed.** Task 1 Step 3 adds `backoffUntil`; `wake()` drops rather than defers, because the backed-off tick ships the durable outbox anyway. |
| P-H2 | `accepted → acknowledged under 100 ms` measures the wrong interval | **Confirmed.** It contains render and transport and can never approach zero. Task 6 Step 2 measures the four intervals separately with realistic expectations. |
| P-H3 | Goal and acceptance matrix omit known slow paths | **Confirmed in part.** Cold start, contention, and mixed traffic are now separate rows and separate runs. Celeron-class hardware evidence is **not** produced — it is a deployment canary in Step 6, not a code gate, because no such machine is available here. Stated rather than silently skipped. |
| P-H4 | Fourfold traffic not proven against the supported pool | **Confirmed.** Task 6 Step 3, at limit 10 with five agents. |
| P-M1 | 500 ms syncs shorten deferred store-failure retries | **Confirmed.** Task 2 Step 3 replaces the clear-on-wake `Set` with a deadline `Map`. |
| P-M2 | Existing harness bypasses the changed runtime | **Confirmed; scope declined.** Path corrected to `backend/tests/manual/`. It is run once as-is; the limitation is stated in Task 6 Step 3 rather than the harness being rewritten in this plan. |
| P-M3 | Rate-limit tests neither pin 80 nor prove multi-agent behaviour | **Confirmed.** Deterministic policy unit test plus a behavioural test driven from the exported constant, with an explicit "if `SYNC_MAX` exceeds 100, make the window injectable" trigger. |
| P-M4 | Release and installation handoff absent | **Confirmed.** Task 6 Step 6, including the runtime-attestation check and the physical canary. |
| P-M5 | Artifact bytes and `duration_ms` do not universally mean print time | **Confirmed.** Task 3 now states what each field means per transport and requires reading `confidence` alongside. |
| P-M6 | Planned tests pass while production wiring is missing | **Confirmed.** Task 4 Step 5 adds a source-scan composition contract test, plus a warning about shadowing `runtime`. |
| P-M7 | Inactive agents inherit the 500 ms cadence | **Confirmed.** Task 5 Step 3 adds `V2_IDLE_SYNC_MS = 5000` gated on `locked.status`. |
| P-M8 | Fixed throttle can override the rollback knob upward | **Confirmed.** `V2_THROTTLE_SYNC_MS = Math.max(2000, V2_NEXT_SYNC_MS)`, asserted in the policy unit test. |
| P-M9 | Raising the ceiling loosens containment without bounding the spin | **Confirmed; fixed more strongly than requested.** Rather than capping consecutive urgent loops, Task 1 Step 4 requires *durable progress* for a 0 ms reschedule. A server that stops confirming drops to the normal cadence on the first non-confirming response, so the limiter is no longer the containment. |
| P-M10 | Final verification omits the mixed harness | **Confirmed.** Added to Task 6 Step 3 with its coverage limit stated. |
| P-L1 | Baseline timing claims contain inaccuracies | **Confirmed.** "Exactly 2000 ms" corrected; the 3 s row is recorded; calculated values are labelled. |
| P-L2 | Task 1 observability is not a latency reduction | **Confirmed.** Task 3 now opens by saying so, and the commit message does not claim otherwise. |
| P-L3 | Invalid-artifact evidence must use a newly claimed job | **Confirmed.** Task 3 Step 5 claims and accepts a fresh job first. |
| P-L4 | `duration_ms unchanged` requires a statistical baseline | **Confirmed.** Task 6 Step 2 requires 20 warm samples with P50/P95. |

## Out of scope, and why

- **Socket doorbell to agents.** Architecturally sound if it only carries "sync now" and
  never work — it violates none of the seven invariants, and `runtime.wake()` now has a
  safe contract to receive it. Deferred because it reintroduces the component behind a
  real production incident (Imunify360 banned the venue IP over reconnect-burst volume),
  and Tasks 4 and 5 should be measured first. If they land the warm median under a
  second, the doorbell may never be worth the risk.
- **Long-polling the sync route.** Same benefit with no new channel and fewer requests
  than today, but it holds connections open — the behaviour that drew attention last
  time. Revisit only if Task 5 proves insufficient.
- **`render_ms` per job.** Computed at `artifact-renderer.js:481` and discarded. There is
  no column, and the obvious home — `health_summary` — is `varchar(255)` whose worst case
  is already ~215 chars with no final length guard. Adding fields there risks truncated,
  unparseable JSON in the admin. Not worth it when `artifact_bytes` plus `duration_ms`
  and `confidence` already explain device time, and render is a stable ~185 ms.
- **Rewriting the mixed-jobs harness onto the real runtime.** Worthwhile — it would catch
  exactly the class of coupling this rev had to fix — but it is a project of its own and
  the coupling is covered here by targeted unit tests.
- **Receipt height and print density.** Every 25 mm trimmed saves ~110 ms of physical
  print, and lower density raises head speed on most thermal units. Both real, both
  product and hardware decisions rather than code.
- **The shared Windows printer.** `printers` rows 1 and 2 both resolve to
  `XP-80C (Copy 1)`, which is what makes a receipt wait behind a kitchen ticket. That is
  configuration, not code, and may be intentional for a single-printer venue.
