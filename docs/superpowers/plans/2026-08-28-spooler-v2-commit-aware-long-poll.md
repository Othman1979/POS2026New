# Spooler V2 Commit-Aware Long-Poll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Work in the ordinary checkout on a `codex/` feature branch, never an isolated worktree. Stop after each task commit if a RED/GREEN result differs from this plan.

**Goal:** Deliver newly committed print work to an idle V2 station promptly without restoring printer Socket.IO, weakening the durable queue, or keeping the current 500 ms database polling load.

**Architecture:** Keep `POST /api/spooler/v2/sync` and `protocol_version: 2` as the only authenticated claim, acceptance, cancellation, and settlement channel. The updated V2 agent opts into a bounded idle wait on that same request. The server first completes the normal sync transaction and releases its MySQL connection; only an empty, idle response may then wait for an in-process, payload-free generation signal. A post-commit signal makes the route run the authoritative sync transaction once more and return the normal response. A timeout or missed signal returns the original response, after which the existing cadence reopens `/sync`. The database remains the source of truth; the signal is only a latency hint.

**Tech Stack:** the spooler's currently supported Node.js 20/22 HTTP/fetch/AbortController surface, Express 5, mysql2 3, Vitest 4, the existing V2 durable agent and local journal. No new package, broker, schema, migration, environment variable, Socket.IO client, SSE endpoint, WebSocket endpoint, `/v3` route, V3 directory, or protocol-version change.

## Current-source fixed point

This plan was written from a clean `master` at `087eb2483bc06734cc4685fed86c16f355bb6209`. The executor must re-read every named source seam on the actual starting branch; do not reset to this hash and do not treat line numbers as authority if the source moved.

Verified current facts:

- The deployable V2 spooler has only `register`, `status` (installer), and `sync` HTTP calls. `pos-spooler-printer/v2/sync-client.js` uses bounded built-in `fetch`; `pos-spooler-printer/package.json` has no `socket.io-client`.
- `pos-spooler-printer/package.json` advertises `^20.0.0 || ^22.0.0`. `AbortSignal.any()` is therefore not a safe implementation primitive: Node documents it as added in 20.3.0. Compose caller cancellation with the timeout using APIs already available at the advertised Node 20.0 floor instead of raising the runtime floor in this feature.
- `server.js` Socket.IO authentication has customer and staff-browser branches only. There is no agent room, agent socket, or socket claim/settlement path.
- Four contracts deliberately pin that absence: `backend/tests/unit/spoolerV2OnlyContract.test.js`, `backend/tests/unit/spoolerPackageContract.test.js`, `pos-spooler-printer/tests/external-config.test.js`, and `pos-spooler-printer/tests/v2-hostile-runtime.test.js`.
- `runAgentSync()` owns every server-side V2 transition in one transaction: agent/station lock, accept, result settlement, cancellation replay, claim, health write, commit, then printer-health publication.
- The agent already has one in-flight sync, durable accepted/result outboxes, wake coalescing, and 2/5/10-second outage backoff. A wake never bypasses that backoff.
- The current healthy hint is 500 ms and the agent clamps it to 500–5000 ms. The sync HTTP deadline is 10 seconds. Station reachability allows 30 seconds. Server graceful shutdown allows 15 seconds.
- Production has exactly two `print_queue` INSERT implementations: `backend/services/printDispatch.js` and the audited transaction in `backend/services/printReprint.js`.
- `enqueuePrintJobs(executor, ...)` intentionally accepts either the pool or a caller-owned transaction connection. Publishing inside it would expose uncommitted work and is forbidden.
- The repository's PM2 declaration uses one fork (`ecosystem.config.js`); the live Hostinger process topology was not independently inspected while planning. The signal is advisory even under one process because restart or a commit-to-publish crash can miss it, and the fallback also preserves correctness if production ever runs more than one process.

Focused baseline at the fixed point:

```text
npx vitest run backend/tests/unit/spoolerV2OnlyContract.test.js backend/tests/unit/spoolerSyncCadence.test.js backend/tests/unit/printDispatchOwnership.test.js
3 files, 17 tests passed

node pos-spooler-printer/tests/v2-sync-runtime.test.js
passed
```

## Why not restore Socket.IO

Socket.IO would be an optional notification channel, not a correctness solution. Its official delivery contract is at-most-once by default; the server does not buffer an event for a disconnected client, and additional guarantees must be built by the application. Its connection-recovery documentation also says recovery can fail and the client still needs state synchronization. We already have the required durable synchronization in `/sync`.

Restoring Socket.IO would therefore add:

- a new spooler dependency and lockfile/runtime-transition payload;
- a third authentication identity in `server.js`, station rooms, revocation/disconnect lifecycle, and new secrets-at-handshake tests;
- a second network state machine that must still fall back to `/sync`;
- multi-process adapter/sticky-routing questions;
- no removal of the durable queue or replay logic.

The selected design uses the existing request, existing headers, existing 10-second client deadline, and existing claim transaction. Official references:

- [Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/)
- [Socket.IO connection state recovery](https://socket.io/docs/v4/connection-state-recovery/)
- [Node.js 22 HTTP lifecycle](https://nodejs.org/download/release/latest-jod/docs/api/http.html)
- [Node.js 22 AbortSignal and fetch](https://nodejs.org/download/release/latest-jod/docs/api/globals.html)

## Framework and transport decision after re-review

Do not introduce Fastify for this change. Fastify's official synthetic benchmark shows lower framework overhead than Express, but also warns that real workloads must be measured. The current steady 500 ms polling cadence is about ten requests/second across five agents, versus tens of thousands of requests/second in the framework benchmark; each sync also performs authentication and a transactional MySQL reconciliation, so swapping the router does not remove the dominant work. Real backlog progress may intentionally run faster than that steady cadence until the existing rate policy intervenes. Running Fastify beside Express would add a second listener/process lifecycle, while migrating the existing middleware requires Fastify compatibility plugins or a broader rewrite. Hostinger supports both frameworks, but support is not evidence that a migration makes this route cheaper.

Do not add SSE or WebSocket as a wake-only side channel. Either would recreate the V1 shape: a separately authenticated connection with its own reconnect, duplicate-connection, shutdown, proxy, and stale-session lifecycle, while `/sync` would still be required for durable claim and settlement. Streaming partial responses also depends more heavily on intermediary behavior. RFC 6202 describes bounded long polling as the HTTP mechanism that reduces empty polling while retaining complete responses, recommends explicit timeouts and suppressed caching, and notes that proxies generally handle complete long-poll responses more predictably than streamed chunks.

The selected transport is therefore the existing authenticated V2 POST used as a bounded long poll. The agent already permits only one in-flight sync, so the RFC's POST-pipelining hazard is not present in the intended runtime. Node's built-in `fetch` is backed by Undici; retain it and measure local connection reuse rather than adding a custom dispatcher, forcing a `Connection` header, or adding an HTTP library without evidence.

References:

- [Fastify official benchmarks](https://fastify.dev/benchmarks/)
- [Fastify middleware compatibility](https://fastify.dev/docs/latest/Reference/Middleware/)
- [RFC 6202: HTTP long polling and streaming](https://www.rfc-editor.org/info/rfc6202/)
- [Node.js fetch/Undici implementation](https://nodejs.org/docs/latest/api/globals.html#fetch)
- [Hostinger-supported Node frameworks](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/)

## Load-bearing invariants

1. `/api/spooler/v2/sync` remains the only job/cancel/accept/result wire. No print payload or queue identity is pushed through another channel.
2. A wake is process-local, payload-free, duplicable, missable, and never evidence that a job exists.
3. Every wake caused by a transaction happens only after its commit succeeds. Rollback and commit failure publish nothing.
4. The generic `enqueuePrintJobs(executor, ...)` never publishes because it cannot know whether its executor is transactional.
5. The route captures the wake generation before the first sync transaction. This closes the commit-between-query-and-wait race in the same process.
6. No MySQL connection, row lock, or transaction is retained while the HTTP request waits.
7. Only a capability-opted-in, authenticated, active/draining, truly idle agent with positive claim capacity may wait. Accepts, results, zero capacity, local work, health warnings, jobs, cancellations, status changes, and queue-state changes return immediately.
8. The maximum hold is a code constant of 1500 ms. There is no deployment variable to misconfigure.
9. After any held response the server advertises a fixed 500 ms follow-up, so a missed signal or a wake that arrives without enough second-pass budget is normally recovered within about 2 seconds even if `SPOOLER_SYNC_INTERVAL_MS` was configured higher. Correctness never depends on that latency estimate.
10. One pending waiter is allowed per authenticated agent **per Node process**. A newer request reaching that process supersedes the older waiter. Timeout, response close, client abort, supersession, and server shutdown all remove it. With `N` Node workers the honest single-flight agent still owns one request, but the hostile upper bound is `N` waiters for that identity; the in-memory rate limit likewise scales by `N`.
11. A follow-up authoritative sync does not ingest the same health snapshot twice or overwrite stored health with empty/default values.
12. The in-process publisher is best-effort after durability. Its failure is logged without turning an already-committed business request into a 500.
13. Existing-V2-agent/updated-server and updated-V2-agent/existing-server combinations retain short polling. Long-poll activates only when the same V2 request explicitly includes the bounded capability.
14. The agent's worker, journal, renderer, transport marker, printer lanes, retry/uncertainty rules, and status monitor are unchanged.
15. Socket.IO remains browser/customer infrastructure. The V2-only tests continue to forbid an agent Socket.IO client and any socket job/ack/settlement events.
16. Agent shutdown aborts the held HTTP request and re-checks `stopped` before applying any response. A job returned while shutdown is in progress must never be accepted locally or start a printer worker.
17. This is an in-place V2 capability update. `protocol_version` remains `2`; no `v3` route/module/directory, second service, sidecar, or differently named spooler generation is introduced.
18. A waiter is never connection ownership or authentication state. Its existence cannot reject a reconnect or produce an “already connected” response; a newer authenticated request merely supersedes the older waiter on that Node process, while the durable agent/station records remain authoritative.

## Protocol and timing decision

The updated V2 agent sends `wait_ms: 1500` in the existing sync JSON body. The server accepts integers from 0 through 1500 and treats missing, non-finite, negative, or otherwise invalid values as zero. The value is only a same-protocol capability/request; the server owns the maximum.

Pin four exported server constants: `V2_SYNC_WAIT_MAX_MS = 1500`, `V2_POST_HOLD_SYNC_MS = 500`, `V2_SYNC_RESPONSE_BUDGET_MS = 9000`, and `V2_SECOND_SYNC_RESERVE_MS = 2000`. The lifecycle middleware records `performance.now()` before authentication. After the first sync, the actual hold is `Math.min(validWaitMs, V2_SYNC_WAIT_MAX_MS, Math.max(0, V2_SYNC_RESPONSE_BUDGET_MS - V2_SECOND_SYNC_RESERVE_MS - elapsedMs))`. If that value is not positive, return the first response without holding. After a wake, recompute the remaining response budget; run the second sync only when at least `V2_SECOND_SYNC_RESERVE_MS` remains, otherwise return the first response with the fixed 500 ms follow-up. The reserve is an admission bound, not a mysql2 cancellation mechanism: an unusually slow transaction can still outlive it, but long-polling cannot deliberately spend the transaction's allowance before starting it. The 9-second response budget also leaves one second before the agent's fixed 10-second transport deadline for serialization, network delivery, and ordinary scheduling.

The server may wait only when all of these are true:

- `accepted` and `results` submitted by the agent are empty;
- `health.local_queue_depth === 0` and `health.worker_active === 0`;
- the sanitized claim `capacity` is greater than zero;
- the first result is `active` or `draining`;
- `confirmedAccepted`, `confirmedResults`, `cancelRequested`, `healthWarnings`, and `jobs` are empty;
- `queueStateChanged === false`.

The first transaction still writes the submitted health and `last_sync_at`. If signaled, the second transaction receives `health: null`, the original capacity, and empty accepted/results. `runAgentSync()` must interpret `health: null` as “do not ingest or rewrite health” while still performing status, replay, cancel, and claim work. Any response that actually entered the wait advertises `V2_POST_HOLD_SYNC_MS = 500`, whether it ended by signal, timeout, supersession, or shutdown release.

The 500 ms value schedules the **next network sync**; it is not a delay before printing a returned job. The current `agent-runtime.js` applies returned jobs to the durable journal and starts/wakes workers before it schedules the next request. Preserve that ordering and measure it in Task 4.

Pre-implementation timing budget from the checked-in constants plus a timer-only local probe (not route evidence and not a Hostinger benchmark):

```json
{
  "local_signal_response_ms": 108,
  "idle_hold_timeout_ms": 1516,
  "agent_http_deadline_ms": 10000,
  "missed_signal_cycle_ms": 2016,
  "current_idle_requests_per_minute_per_agent": 120,
  "proposed_idle_requests_per_minute_per_agent": 30
}
```

The budget projects a 75% idle-request reduction and an approximately 0–2 second fallback. That saving is an **idle-load** claim, not an unconditional busy-load claim. The global payload-free wake deliberately favors correctness and simplicity for one-to-five agents: a committed event can cause each currently waiting agent to run one second authoritative transaction. With five continuously idle agents, the old baseline is about 10 sync transactions/second and the proposed idle baseline about 2.5/second. Ignoring coalescing, the conservative break-even is therefore roughly 1.5 committed wake events/second (`2.5 + 5 × events_per_second = 10`). Task 4 must measure 0, 0.5, 1, and 2 committed events/second, count first and second sync transactions separately, and replace these projections with reproducible real-route results before the branch is accepted. It does not promise printer paper latency; rendering and physical transport remain separate measured stages.

## Compatibility matrix

| Server code | V2 agent code | Behavior |
|---|---|---|
| Existing | Existing | Current 500 ms sync polling |
| Updated | Existing | Missing `wait_ms`; current polling remains |
| Existing | Updated | Unknown JSON field is ignored; current polling remains |
| Updated | Updated | One idle V2 `/sync` is held up to 1500 ms and released by a committed wake |

The server can deploy first. The spooler change is an application/core update only: it changes no dependency, browser cache, helper, environment, or durable state. Version bump, installer build, deployment, and customer rollout are release-owner actions after this implementation is reviewed.

## Commit-aware publication map

| Durable change | Current ownership seam | Required publication seam |
|---|---|---|
| Receipt/report/expense jobs | pool/autocommit through `backend/services/printDispatch.js` | use a clearly named autocommit wrapper that publishes after `enqueuePrintJobs()` resolves |
| `POST /api/print/print` | `backend/routes/print.js` enqueue | wrapper returns, then safe publish |
| Kitchen print helper | `backend/routes/print.js` enqueue, possibly several sequential inserts | wrapper publishes once after the successful batch; a partial batch failure relies on fallback |
| Template test print | `backend/routes/admin/printTemplates.js` enqueue | wrapper returns, then safe publish |
| POS subscription redemption | enqueue on route transaction, commit in `backend/routes/pos/subscriptions.js` | publish only after that commit |
| Admin subscription reversal | enqueue on route transaction, commit in `backend/routes/admin/subscriptions.js` | publish only after that commit |
| Held-order follow-up | queue on caller transaction, commit in `backend/routes/pos/orders.js` | publish only after follow-up commit |
| Held-order cancellation ticket | queue on caller transaction, commit in `backend/routes/pos/orders.js` | publish only after cancellation commit |
| Initial held-order fire | queue on caller transaction, commit in `backend/routes/pos/orders.js` | publish only after fire commit |
| Audited queue reprint | own transaction in `backend/services/printReprint.js` | publish only after reprint/audit commit |
| Active/local cancellation | own transaction in `backend/routes/admin/printQueue.js` | publish only after `cancel_requested` commits; an immediately canceled pending row needs no agent wake |
| Drain/replacement | own transactions in `backend/services/spoolerAgents.js` | publish after commit so an idle updated V2 agent promptly observes draining/revoked status; an existing V2 agent observes it on its unchanged poll |

Printer reassignment, a retry becoming due, a process-local signal missed during restart, and a partially committed multi-printer batch remain covered by the bounded sync fallback. Do not add database triggers, Redis, an outbox table, or routing queries merely to target a five-agent wake.

---

## Task 1: Add the bounded wake primitive and explicit agent capability

**Files:**

- Create: `backend/services/spoolerSyncWake.js`
- Create: `backend/tests/unit/spoolerSyncWake.test.js`
- Modify: `pos-spooler-printer/v2/sync-client.js`
- Modify: `pos-spooler-printer/v2/agent-runtime.js`
- Modify: `pos-spooler-printer/http-client.js`
- Modify: `pos-spooler-printer/tests/v2-agent-connect.test.js`
- Modify: `pos-spooler-printer/tests/v2-sync-runtime.test.js`
- Modify: `pos-spooler-printer/tests/http-client.test.js`

### Step 1.1 — RED: specify the wake hub

Write unit tests for a factory-created hub, not the production singleton. Require:

- `generation()` returns the current generation;
- `publish()` advances it and releases every current waiter with `changed`;
- a waiter created after a publish with an older generation resolves immediately (the lost-wakeup race);
- one agent has at most one waiter; a replacement resolves the old one with `superseded`;
- timeout resolves `timeout` and removes the waiter;
- abort resolves `aborted` and removes the waiter;
- `close()` resolves all waiters with `closed`, prevents new waits, and is idempotent;
- an old waiter cleanup cannot delete a newer waiter for the same agent;
- `snapshot()` exposes only counts/generation/closed for tests and diagnostics, never agent IDs, secrets, or payloads.

Run:

```powershell
npx vitest run backend/tests/unit/spoolerSyncWake.test.js
```

Expected RED: module not found.

### Step 1.2 — GREEN: implement a small in-memory generation hub

Implement `createSpoolerSyncWakeHub({ setTimeoutFn, clearTimeoutFn })` plus one production singleton. The waiter map is keyed by authenticated `agent_id`; each entry owns its timer, optional one-shot abort listener, and identity-checked cleanup. Do not retain `req`, `res`, job data, station data, or credentials.

Export a `safePublishSpoolerSyncWake()` wrapper that cannot throw into a committed caller. Log the first unexpected publisher error per process, then suppress repeats; do not log on ordinary publish, timeout, abort, or supersession.

Do not add station targeting. With the supported one-to-five-agent venue, a global generation is smaller and safer; station filtering remains inside the authoritative SQL claim.

### Step 1.3 — RED: pin caller-owned cancellation and the shutdown race

Before lengthening the request, add focused tests that reproduce the current shutdown hazard:

- `fetchWithTimeout()` combines its 10-second deadline with an optional caller signal; either one aborts the same fetch, and the helper removes its own timer/listener in `finally`;
- `createSyncClient().sync(body, { signal })` and the registration retry pass that signal through without putting it in JSON or headers;
- `runtime.stop()` aborts the current sync immediately rather than waiting for the held request;
- if a fake sync implementation ignores abort and resolves a job after `stop()` was requested, the runtime does not call `store.accept()`, start/wake workers, or schedule another tick;
- repeated ordinary network failures/early connection closes preserve the existing 2/5/10-second backoff, never invoke registration unless the server explicitly returned the existing 401 unauthorized response, and never create overlapping syncs;
- a normal non-shutdown response still follows the existing acceptance, worker, and cadence path.

The shutdown test must expose the old behavior (`worker.start()` after `stop()` was requested), not merely assert that an AbortController exists.

Run:

```powershell
node pos-spooler-printer/tests/http-client.test.js
node pos-spooler-printer/tests/v2-sync-runtime.test.js
```

Expected RED: the caller signal is ignored and the late response can still start work.

### Step 1.4 — GREEN: opt in and make the held request stoppable

Add a fixed `V2_SYNC_WAIT_MS = 1500` in `pos-spooler-printer/v2/sync-client.js`, exported for its direct tests. Append `wait_ms: V2_SYNC_WAIT_MS` after spreading the runtime body, so callers cannot override it.

Extend `fetchWithTimeout()` with one helper-owned AbortController, one timeout, and at most one `{ once: true }` listener on the optional caller signal. Caller abort forwards its original reason; timeout aborts with the existing `TimeoutError` shape. Clear the timeout and remove the helper-owned caller listener in `finally`, including when `fetchFn` throws synchronously. Do **not** use `AbortSignal.any()` or change `package.json` engines: the package advertises Node 20.0 support and Node added that method only in 20.3. Let `sync()` and `register()` accept an optional `{ signal }` transport option and pass it only to `fetchWithTimeout()`.

In `agent-runtime.js`, own one AbortController for the complete sync/register attempt. Create it at tick start, store it as the current attempt by identity, pass the signal to both `sync()` and any same-attempt `register()`, and clear it in `finally` only if it is still that tick's controller. `stop()` sets `stopped`, clears the timer, aborts the current controller, and then awaits the in-flight tick as today. Immediately after every awaited network response, return without applying it when `stopped` is true. Treat the stop-owned abort as normal shutdown: no registration retry, backoff mutation, job acceptance, worker start, or new schedule. Keep the post-response `stopped` guard even though production fetch honors abort; it is the safety barrier for a transport that resolves concurrently or ignores cancellation.

Extend `v2-agent-connect.test.js` to prove both pre-registration and authenticated sync requests:

- remain POSTs to the same endpoint;
- keep raw credentials in headers only;
- keep registration payload-compatible and free of `wait_ms`;
- include `wait_ms: 1500` and the bound `spooler_id` on authenticated sync;
- contain no socket, URL credential, or new auth field.

Extend `http-client.test.js` to assert `V2_SYNC_WAIT_MS < timeoutMs` and retain the 10-second abort deadline.

Add focused timeout-helper cases for caller-already-aborted, caller abort during fetch, timeout, synchronous fetch failure, and normal completion. In every path assert that the timer/listener is gone; this is the resource-leak guard for a service that runs continuously on tills. Add a runtime identity case proving a completed tick cannot clear or abort a later attempt controller.

Run:

```powershell
node pos-spooler-printer/tests/v2-agent-connect.test.js
node pos-spooler-printer/tests/http-client.test.js
node pos-spooler-printer/tests/v2-sync-runtime.test.js
npx vitest run backend/tests/unit/spoolerSyncWake.test.js
```

Expected GREEN: all named tests pass.

### Step 1.5 — Commit

```powershell
git add backend/services/spoolerSyncWake.js backend/tests/unit/spoolerSyncWake.test.js pos-spooler-printer/v2/sync-client.js pos-spooler-printer/v2/agent-runtime.js pos-spooler-printer/http-client.js pos-spooler-printer/tests/v2-agent-connect.test.js pos-spooler-printer/tests/v2-sync-runtime.test.js pos-spooler-printer/tests/http-client.test.js
git commit -m "feat(spooler-v2): add bounded sync wake capability"
```

---

## Task 2: Hold only an idle authoritative sync, outside MySQL

**Files:**

- Modify: `backend/routes/spoolerV2.js`
- Modify: `backend/services/spoolerSync.js`
- Modify: `backend/tests/integration/spoolerV2Sync.test.js`
- Create: `backend/tests/unit/spoolerLongPollOrchestration.test.js`
- Modify: `backend/tests/unit/spoolerSyncCadence.test.js`
- Modify: `backend/tests/unit/spoolerV2OnlyContract.test.js`
- Modify: `server.js`

### Step 2.1 — RED: pin negotiation and idle-only behavior

Keep the existing integration `sync()` helper non-waiting by default (`wait_ms: 0`) so unrelated lifecycle cases stay fast. Add focused cases that prove:

1. no `wait_ms` returns promptly and preserves the old-agent behavior;
2. `wait_ms` is clamped to `0..1500`; invalid/negative values do not wait;
3. an opted-in idle request remains open briefly;
4. a same-process `publish()` releases it, reruns authoritative sync, and returns a job committed after the first transaction;
5. accepts, results, zero capacity, local work, worker activity, a returned job/cancel, warnings, and a non-working status never enter the wait;
6. a signal for another station can wake the request but cannot cross station ownership;
7. timeout returns the original response content with `next_sync_ms` overwritten by the fixed 500 ms post-hold recovery cadence, even when the ordinary environment cadence is higher;
8. a row inserted without publishing is claimed by the next cadence request, proving missed-wake recovery;
9. a client abort leaves zero waiters; a superseding request resolves the old waiter and leaves exactly the newer waiter until it completes or aborts;
10. a second sync with `health: null` does not overwrite agent name, queue depth, health summary, printer status, or last error from the first sync;
11. the failed-print staff count lookup is best-effort after settlement and cannot turn a committed result into a 500.
12. a first sync that consumes all but the second-pass reserve does not wait, and an event-loop delay that consumes the reserve after a wake returns the original response without running the second sync.
13. every sync response, including auth/rate-limit errors and held responses, carries `Cache-Control: no-store` so intermediaries cannot reuse agent-specific results.

Also pin the lost-wakeup boundary without timing guesses. Extract the route's two-pass orchestration into a small named function whose production defaults are `runAgentSync` and the production wake hub. In a unit test, inject a first `syncFn` call that publishes immediately before it resolves. Assert that the generation captured before that call makes the orchestration run the second authoritative sync immediately, with no timer advance. This test must fail if generation capture moves after the first sync.

Add two request-lifecycle cases: abort while the first sync is still running, and abort after the wake resolves but before the second sync begins. Neither may register/retain a waiter, run an additional sync, or write a response. mysql2 cannot cancel a transaction already executing: if the first sync commits a same-agent claim before observing the abort, assert that the next authenticated request replays that exact row to the same agent without another attempt or cross-agent reassignment. The abort-after-wake case must prevent the second sync from starting. Add a source-order assertion that the sync request timestamp/no-store middleware is registered before the general JSON body parser, so body upload/parsing time cannot be omitted from the 9-second budget.

Use real MySQL for claim/commit behavior. Use the wake factory/singleton inspection only to know when the HTTP request entered the wait; do not add sleeps that guess at transaction timing.

### Step 2.2 — GREEN: orchestrate two short sync transactions around the wait

In `server.js`, register a narrowly matched middleware for `POST /api/spooler/v2/sync` before the general JSON/form parsers. Match the same canonical path Express accepts under the repository's default case-insensitive, non-strict routing, by lowercasing and normalizing trailing slashes for comparison only; never rewrite `req.url`. It records `performance.now()` on the request and sets `Cache-Control: no-store`; it does not parse, authenticate, rate-limit, or rewrite the URL. Test `/sync`, `/sync/`, a mixed-case alias, and an unrelated route that must remain untouched.

In `backend/routes/spoolerV2.js`:

1. add a first route middleware, before database authentication, that adopts the server-recorded start (falling back to `performance.now()` only in isolated router tests) and owns one AbortController; response finish/close and request abort perform identity-safe cleanup, and an already-aborted request never enters the handler;
2. authenticate, bind station, and rate-limit exactly as today;
3. validate protocol and capture `const since = wakeHub.generation()` before the first sync;
4. run the existing sync with submitted accepted/results/health/capacity;
5. return without waiting or writing if the route-owned lifecycle signal is already aborted; otherwise return immediately unless the explicit capability and every idle predicate are satisfied;
6. compute the hold from a fixed server request budget below the client's 10-second deadline after deducting the 2-second second-sync reserve: `min(requestedWait, 1500, remainingResponseBudget - 2000)`. If no positive budget remains, return the first result immediately;
7. await the hub outside all database work for only that remaining hold;
8. after the wait, re-check the route-owned lifecycle signal and the 2-second reserve; only `changed` with the reserve intact may run `runAgentSync()` again, with empty accepted/results, `health: null`, and the original capacity. A changed generation with insufficient reserve returns the first result at the fixed 500 ms cadence;
9. after the second sync, re-check the route-owned lifecycle signal before writing. An abort during an already-running MySQL transaction cannot cancel mysql2 work, but its durable claim remains same-agent replayable and no dead response is written;
10. on timeout/supersede/close, return the first result with `nextSyncMs = V2_POST_HOLD_SYNC_MS`; on client abort, return without writing;
11. always detach route-owned listeners in `finally` while the lifecycle middleware retains only its finish/close cleanup;
12. serialize exactly the existing response fields—no new job envelope and no wake metadata.

Name and export the orchestration function for focused tests, as this route already exports its auth/rate helpers. Keep Express objects out of it: pass only the authenticated agent, sanitized body, abort signal, elapsed-budget function, `syncFn`, and hub. Do not introduce a general workflow framework.

Do not use `Promise.race` without cleanup. Do not store Express objects in the hub. Do not hold the first connection while waiting.

In `backend/services/spoolerSync.js`, make health ingestion conditional on `health !== null`. The claim/status transaction still runs. Result settlement continues to use submitted health on the first pass; the second pass never carries results.

Wrap the existing failed-count query/emission in a best-effort `try/catch` after the sync commit. A staff-notification failure must be logged and must not change the agent response. Do not add a second query timeout mechanism in this task.

### Step 2.3 — Prove no database lease survives the wait

In the opted-in integration test, wait until the hub reports one waiter, then compare `pool.connectionTelemetrySnapshot()`:

- `inUse === 0` while the HTTP response is held;
- `enqueued` does not increase during the wait;
- all acquisitions used by the first/second transactions are eventually released.

The test must fail if the implementation places `waitForChange()` inside `runAgentSync()` or before `conn.release()`.

### Step 2.4 — Wire graceful shutdown

At the start of network shutdown in `server.js`, call the production wake hub's `close()` before both `io.close()` and `server.close()`. This releases held responses before either server lifecycle can wait on the shared HTTP listener. Add a source/behavior assertion for that ordering.

Do not touch browser Socket.IO shutdown ordering except to insert the wake-hub close before the HTTP server close.

### Step 2.5 — Update cadence contracts

Retain all prohibitions on agent Socket.IO, V1 routes/events, and fire-and-forget job delivery. Add assertions that:

- the only agent delivery endpoint remains `/api/spooler/v2/sync`;
- `protocol_version` remains `2`, and deployable spooler/server sources contain no `/v3` route, `v3/` runtime directory, or printer-delivery protocol fork;
- waiter presence never creates a connection registry, disconnect handler, `spooler_id_already_connected` response, or other reconnect rejection; same-agent supersession remains a successful bounded HTTP lifecycle;
- every sync outcome is explicitly `Cache-Control: no-store`;
- the wait is bounded below the 10-second client timeout and 15-second shutdown timeout;
- the hold calculation always deducts `V2_SECOND_SYNC_RESERVE_MS`, and both the 9-second response budget and 2-second reserve remain below the fixed 10-second client deadline;
- the rate limiter still allows the busy 500 ms path plus current urgent-result headroom;
- `V2_POST_HOLD_SYNC_MS` is exactly 500 and the idle wait cannot advertise a faster follow-up.

Run:

```powershell
npx vitest run backend/tests/integration/spoolerV2Sync.test.js backend/tests/unit/spoolerLongPollOrchestration.test.js backend/tests/unit/spoolerSyncCadence.test.js backend/tests/unit/spoolerV2OnlyContract.test.js backend/tests/unit/spoolerSyncWake.test.js
```

Expected GREEN: all named cases pass, including the real-MySQL no-lease assertion.

### Step 2.6 — Commit

```powershell
git add backend/routes/spoolerV2.js backend/services/spoolerSync.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/unit/spoolerLongPollOrchestration.test.js backend/tests/unit/spoolerSyncCadence.test.js backend/tests/unit/spoolerV2OnlyContract.test.js server.js
git commit -m "feat(spooler-v2): wake idle sync after committed work"
```

---

## Task 3: Publish every relevant state change after durability

**Files:**

- Modify: `backend/services/spoolerSyncWake.js`
- Modify: `backend/services/printDispatch.js`
- Modify: `backend/routes/print.js`
- Modify: `backend/routes/admin/printTemplates.js`
- Modify: `backend/routes/pos/subscriptions.js`
- Modify: `backend/routes/admin/subscriptions.js`
- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/services/printReprint.js`
- Modify: `backend/routes/admin/printQueue.js`
- Modify: `backend/services/spoolerAgents.js`
- Modify: `backend/tests/unit/printDispatchOwnership.test.js`
- Create: `backend/tests/unit/spoolerWakeCommitBoundaries.test.js`
- Modify: `backend/tests/integration/printQueueCancellation.test.js`
- Modify: `backend/tests/integration/printReprint.test.js`
- Modify: `backend/tests/integration/spoolerV2Sync.test.js`
- Modify: `backend/tests/integration/socketRoleIsolation.test.js`

### Step 3.1 — RED: protect executor ownership

Extend `printDispatchOwnership.test.js` and the new commit-boundary contract to prove:

- `enqueuePrintJobs(transactionConnection, ...)` performs no publication;
- a named `enqueueCommittedPrintJobs(payloads, options)` uses the module pool and publishes exactly once after a successful autocommit batch;
- a complete enqueue failure publishes nothing;
- if a later insert in a multi-row autocommit batch fails, the wrapper may publish nothing and the already-committed row is recovered by the cadence fallback;
- an idempotent duplicate may publish again, but cannot duplicate a row or physical claim;
- commit happens before publish on every transaction-owned seam in the publication map;
- rollback/commit rejection publishes nothing;
- safe-publisher failure after commit does not change the successful domain response.

Do not assert fragile call indices. Match the durable statement and explicit commit/publish ordering.

### Step 3.2 — GREEN: separate autocommit enqueue from transactional enqueue

Keep `enqueuePrintJobs(executor, payloads, options)` unchanged in ownership and free of notification side effects.

Add `enqueueCommittedPrintJobs(payloads, options)` in `backend/services/printDispatch.js`:

- it calls `enqueuePrintJobs(pool, ...)`;
- after the promise resolves with at least one queued row, it calls the safe payload-free publisher once; an empty batch publishes nothing;
- it returns the original queued result unchanged.

Use the wrapper at all direct pool/autocommit sites:

- receipt/report route;
- kitchen helper;
- print-template test;
- `dispatchReceiptPrint()` used by expense print paths.

Remove the stale “socket delivery” comment in `backend/routes/print.js`. Do not change print compilation, routing, idempotency, or payload shape.

### Step 3.3 — GREEN: publish after caller-owned commits

Add and unit-test `commitAndPublishSpoolerSyncWake(conn)`: it awaits `conn.commit()` and only then invokes the exception-contained publisher. Use it only at the transaction owners in the publication map. Never use it in `HeldOrderKitchenDispatch`, because that service does not own the production commit.

For admin cancellation:

- publish to the sync wake hub only when the committed outcome is `cancel_requested`;
- keep the browser event staff-only (`req.io?.to('staff')`), never global customer delivery;
- emit that post-commit browser update best-effort as well, so a Socket.IO/mock failure cannot turn the committed cancellation into a 500;
- do not treat the browser event as an agent signal.

For drain and forced replacement, publish after the service-owned commit. A revoked agent remains able to authenticate the next `/sync` and receive `agent_status: revoked`, which is the current HTTP lifecycle; do not create socket disconnect logic.

For reprint, publish after its insert and audit commit. Publisher failure must not roll back or hide the successfully created reprint.

### Step 3.4 — Verify representative real routes

Add/extend focused integration cases:

- a waiting station receives a newly committed ordinary print through the second authoritative sync;
- transaction rollback produces no row and no wake;
- `cancel_requested` releases an idle waiter with the cancellation ID; pending-to-canceled does not need a wake;
- reprint commit releases the waiter and returns only the reprint row;
- drain releases the waiter and returns `draining`; forced replacement releases it and returns `revoked` without reassigning uncertain work;
- customer sockets do not receive `print_queue_updated`, while staff sockets may.

For subscription and held-order paths, use their existing integration suites for money/domain correctness and the static commit-boundary contract for exact notification placement. The route files are edited, so these existing suites are mandatory; do not replace them with static source scanning and do not duplicate their fixtures merely to observe an empty signal.

Run only concerned files:

```powershell
npx vitest run backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/spoolerWakeCommitBoundaries.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/printQueueCancellation.test.js backend/tests/integration/printReprint.test.js backend/tests/integration/socketRoleIsolation.test.js backend/tests/unit/heldOrderKitchenDispatch.test.js backend/tests/integration/subscriptionRedemptions.test.js backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/heldOrders.fireKitchen.test.js
```

### Step 3.5 — Commit

```powershell
git add backend/services/spoolerSyncWake.js backend/services/printDispatch.js backend/routes/print.js backend/routes/admin/printTemplates.js backend/routes/pos/subscriptions.js backend/routes/admin/subscriptions.js backend/routes/pos/orders.js backend/services/printReprint.js backend/routes/admin/printQueue.js backend/services/spoolerAgents.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/spoolerWakeCommitBoundaries.test.js backend/tests/integration/printQueueCancellation.test.js backend/tests/integration/printReprint.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/socketRoleIsolation.test.js
git commit -m "feat(spooler-v2): publish print wakes after commit"
```

---

## Task 4: Adversarial load proof, architecture truth, and release handoff

**Files:**

- Create: `backend/tests/manual/spoolerV2LongPollHarness.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`
- Create: `docs/superpowers/evidence/2026-08-28-spooler-v2-long-poll-validation.md`
- Add: `docs/superpowers/plans/2026-08-28-spooler-v2-commit-aware-long-poll.md`

### Step 4.1 — Run the controlled one/five-agent experiment

Create a repeatable `backend/tests/manual/spoolerV2LongPollHarness.js`, following the safety pattern in `spoolerV2MixedJobsHarness.js`: `--live` is required for the real route, the script refuses any database name not ending in `_test`, listens only on `127.0.0.1`, creates disposable agents/printers/jobs, and cleans its rows. Close the wake hub, Socket.IO server, HTTP server, pool, journal, worker timers, and temporary state owned by the harness. Because importing the current `server.js` also starts its unexported 30-second watchdog interval, finish with the existing harness's explicit stdout-flushing `process.exit()` pattern and record that limitation; do not falsely claim that module-owned interval was canceled.

The one-agent scenario must compose the real `createAgentRuntime`, `createSyncClient`, `openJobStore`, and `createPrinterWorkers` with a synthetic renderer and transport (no Chrome, Windows helper, LAN socket, or physical printer). Let the runtime enter a held `/sync`, commit and publish one job, and prove exactly one durable local acceptance, transport marker, simulated send, result outbox entry, and server settlement. The five-agent load cases may use direct protocol clients. This is the end-to-end proof that the new held response actually reaches the journal/workers; timer-only hub tests are not a substitute.

Run it against the real Express route and test MySQL, not a timer-only model:

```powershell
node backend/tests/manual/spoolerV2LongPollHarness.js --live
node backend/tests/manual/spoolerV2MixedJobsHarness.js --live
```

The new harness owns the one/five-agent wait, publish-flood, missed-signal, abort, shutdown, pool-telemetry, and one-job full-runtime composition cases. Its synthetic renderer/transport should be the minimum needed for that one job. The existing mixed-jobs harness owns the 50-job kitchen/receipt/report lane and transport matrix; do not copy that larger simulation into the new file.

Record raw measurements for:

- one idle agent across at least 20 timeout cycles;
- five idle agents across at least 20 timeout cycles each;
- 50 rapid payload-free publishes while all five agents are waiting;
- a sustained publish stream for at least 10 seconds, faster than the agent's 500 ms minimum scheduling cadence;
- controlled committed-wake workloads at 0, 0.5, 1, and 2 events/second with five agents, recording HTTP requests plus first-pass and second-pass sync transactions separately;
- `SYNC_MAX + 1` concurrent authenticated sync requests for one agent, so one request crosses the existing per-process rate policy;
- one targeted queue insert during the flood;
- one direct committed insert with its publish deliberately omitted;
- one client abort and one hub shutdown;
- one busy agent with durable local work/results.

Acceptance bounds:

- maximum one waiter per agent per Node process and five total in the one-process five-agent harness;
- zero database connections in use during the wait window;
- no pool enqueue increase caused by held requests;
- at 0 events/second, five agents remain at or below 2.5 first-pass sync transactions/second after warm-up; at 0.5 and 1 committed event/second, total first-plus-second sync transactions remain below the old 10/second five-agent steady-poll baseline; record the 2 events/second result as the explicit busy-load trade-off rather than hiding it;
- local committed wake reaches the follow-up sync with p95 below 500 ms on the test host;
- in the composed runtime case, committed-job-to-local-journal p95 is below 500 ms and committed-job-to-simulated-transport-start p95 is below 1000 ms on the test host;
- missed publish is claimed within 2250 ms on the test host;
- idle request rate is at most 0.6 requests/second/agent after warm-up;
- the one-agent 20-cycle run reuses HTTP connections (record accepted TCP connection count and remote ports; more than two connections is a failed resource gate requiring investigation, not permission to add a custom dispatcher immediately);
- a payload-free publish flood cannot create concurrent syncs for one honest agent or drive its **HTTP request** rate above the existing two-request/second 500 ms scheduling ceiling; second-pass transaction counts are reported separately;
- real queued work preserves the existing progress-sensitive fast path: a response carrying newly accepted durable work reaches the journal/workers before any next-sync delay, and the runtime may schedule its next request immediately while durable accept/result progress continues. Do not impose the empty-wake two-request/second ceiling on backlog draining;
- the same-agent request storm settles to one waiter in the one-process harness, releases every pool lease, and the request crossing `SYNC_MAX` receives the existing successful `throttled: true` response without entering `runAgentSync()`; record peak pool `inUse`/`enqueued` rather than claiming the authentication/transaction storm does not exist;
- no cross-station claim, duplicate queue transition, duplicate local acceptance, or duplicate result settlement;
- all waiters are gone after abort/shutdown.

These are server/protocol acceptance numbers, not guarantees that a physical printer finishes within them.

If any bound fails, stop Task 4 and return to the task that owns the defect with a new RED case. Do not patch production behavior ad hoc from the documentation task.

### Step 4.2 — Re-run the hostile protocol matrix

Explicitly attack:

- publish before wait registration;
- publish between first sync commit and wait registration;
- duplicate/late publish;
- commit failure;
- process-local missed publish;
- same agent issuing two waits;
- invalid/oversized `wait_ms`;
- request disconnect during wait;
- request abort during authentication/first sync, including same-agent replay if that transaction committed, and abort after signal-before-second-sync;
- server shutdown during wait;
- agent shutdown while a wait is held, including a fake transport that resolves a job after ignoring abort;
- health mutation on the second sync;
- local result becoming ready while the HTTP request is held;
- printer/status probe activity while idle;
- active/draining/revoked/decommissioned transitions;
- 50-job mixed kitchen/receipt/report backlog with capacity and station ownership unchanged.

Before release, inspect the actual target's Node/PM2 worker count rather than inferring it from this repository. Record `N`, the honest-agent expectation (one single-flight request), and hostile bounds (`N` waiters per compromised agent identity and `N × SYNC_MAX` requests per rate window). One process is the supported rollout topology for this phase. If the target runs more than one worker, correctness still falls back to the database, but rollout is blocked until the owner either accepts those multiplied resource bounds or supplies a shared limiter/wake design in a separate plan.

Local success does not prove Hostinger's reverse proxy will preserve a held response. Before any customer rollout, run an owner-approved staging soak through the real HTTPS domain for at least 100 idle hold cycles and a committed test job. Record early disconnects, response latency, agent backoff, TCP connection reuse as observable from the client, authentication/status responses, and exactly-once local acceptance. Any repeated early proxy close, overlapping agent request, station-mismatch/auth churn, or failure to receive the committed job blocks rollout. This is a release gate, not authorization for Task 4 to deploy or modify Hostinger.

The expected answer to every signal-loss case is “the next authenticated HTTP sync reconciles the durable database,” never “the signal is retried as a job.”

### Step 4.3 — Correct the architecture map

Update `docs/architecture.json` and regenerate HTML:

- correct `actor-spooler`, which falsely says the agent uses Socket.IO and a pre-shared key;
- correct the route wording that calls raw-secret hash authentication “HMAC”;
- correct the top-level invariant that still says “print Socket.IO connection”;
- add the bounded in-process wake hub as a load-bearing service node;
- update `flow-spooler-v2-delivery` to show immediate sync transaction → idle wait outside MySQL → optional second sync;
- keep the stable historical id `flow-checkout-receipt-socket`, but change its label/summary/steps so no text implies socket delivery;
- update the local runtime flow to describe explicit `wait_ms`, one HTTP in-flight request, 500 ms recovery cadence, and unchanged durable journal/outbox;
- update the print-dispatch node that still says only “next authenticated sync” so it names post-commit wake plus durable fallback;
- update the reprint flow so its audit commit precedes the advisory wake and `/sync` remains authoritative;
- record shutdown releasing waiters before HTTP close;
- record the compatibility matrix and the lack of a runtime dependency transition;
- preserve all V2 durability, uncertainty, lane, and physical-printer invariants;
- update manual meta counts if a node is added.

Run:

```powershell
npm run architecture
npm run architecture:check
```

Expected: generated HTML matches JSON; no new broken reference. Existing unrelated orphan warnings must be recorded, not silently attributed to this work.

### Step 4.4 — Focused final verification

Run once:

```powershell
npx vitest run backend/tests/unit/spoolerSyncWake.test.js backend/tests/unit/spoolerLongPollOrchestration.test.js backend/tests/unit/spoolerSyncCadence.test.js backend/tests/unit/spoolerV2OnlyContract.test.js backend/tests/unit/spoolerPackageContract.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/spoolerWakeCommitBoundaries.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/printQueueCancellation.test.js backend/tests/integration/printReprint.test.js backend/tests/integration/socketRoleIsolation.test.js backend/tests/integration/subscriptionRedemptions.test.js backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/heldOrders.fireKitchen.test.js
npm --prefix pos-spooler-printer test
node backend/tests/manual/spoolerV2LongPollHarness.js --live
node backend/tests/manual/spoolerV2MixedJobsHarness.js --live
npm run architecture:check
git diff --check
git status --short
```

Do not run the full repository suite, build installers, bump versions, merge, push, deploy, or touch Hostinger under this plan.

Write the validation report with:

- branch/HEAD and exact commands;
- raw timing/load/telemetry results;
- compatibility matrix actually exercised;
- every commit-aware producer checked;
- any unverified physical/Hostinger gate stated plainly;
- the observed target worker count, or an explicit statement that deployment remains blocked until it is checked;
- any pre-existing failure separated from new failures.

### Step 4.5 — Commit

```powershell
git add backend/tests/manual/spoolerV2LongPollHarness.js docs/architecture.json docs/architecture.html docs/superpowers/evidence/2026-08-28-spooler-v2-long-poll-validation.md docs/superpowers/plans/2026-08-28-spooler-v2-commit-aware-long-poll.md
git commit -m "test(spooler-v2): verify commit-aware long polling"
```

---

## Adversarial completion checklist

The branch is not complete unless every item is demonstrated:

- [ ] V2 spooler still has zero Socket.IO/EventSource/server-WebSocket delivery code and zero new runtime dependency.
- [ ] `/sync` remains the only claim/accept/cancel/result authority.
- [ ] Existing V2 agents receive immediate responses; updated V2 agents opt in explicitly without a protocol-version change.
- [ ] The change remains V2 in names and wire protocol; no V3 route, folder, package, service, or protocol number exists.
- [ ] The generation is captured before the first sync and detects publish-before-wait.
- [ ] No DB connection is held during the wait.
- [ ] No response with submitted results/accepts, local work, warning, job, cancel, or status change is delayed.
- [ ] Zero-capacity agents do not occupy a waiter that cannot claim work.
- [ ] Health is written once and is not erased by the follow-up sync.
- [ ] Every queue producer in the publication map is accounted for at its actual commit owner.
- [ ] Rollback and commit failure publish nothing.
- [ ] Post-commit publisher failure cannot change the business response.
- [ ] Cancel, drain, replacement, and reprint wake the required agent path.
- [ ] Customer sockets no longer receive the admin queue event.
- [ ] Same-agent waiter count is bounded to one per Node process and cleanup is identity-safe; the actual rollout worker count and multiplied hostile bound are recorded.
- [ ] A reconnect/overlap never fails because a waiter exists; no agent connection registry or “already connected” response has been introduced.
- [ ] Client abort and graceful shutdown leave no waiter/timer/listener.
- [ ] Agent shutdown aborts the held fetch, and even an abort-ignoring late response cannot accept a job or start a worker.
- [ ] Same-process signal is prompt; cross-process/missed signal remains correct within bounded fallback.
- [ ] Normal committed work reaches the local journal within 500 ms p95 and simulated transport start within 1000 ms p95 on the test host; payload-free signals respect the old 500 ms request ceiling while real backlog progress retains the existing immediate follow-up path.
- [ ] The measured 0/0.5/1-event-per-second five-agent workloads reduce total sync transactions below the old steady-poll baseline; the 2-event-per-second trade-off is recorded honestly.
- [ ] Busy-agent result reporting and outage backoff are unchanged.
- [ ] The 50-job mixed backlog preserves capacity, ownership, idempotency, local durable acceptance, serial printer lanes, and uncertain-outcome rules.
- [ ] A real updated-V2-agent held sync composes through sync client → runtime → journal → worker → simulated transport → result settlement exactly once.
- [ ] Architecture text contains no claim that V2 delivery uses Socket.IO or HMAC.
- [ ] No migration, schema, env, installer, dependency, deployment, merge, or push occurred.
- [ ] Customer rollout remains blocked until the real Hostinger HTTPS staging soak passes 100 held cycles and one committed-job delivery without reconnect/auth/duplicate-acceptance symptoms.

## Explicitly deferred, not forgotten

- Guaranteed low-latency wake across multiple Node processes would require a shared broker/adapter or durable outbox. The repository declares one PM2 fork and the expected venue has one-to-five agents, but the actual rollout topology remains a Task 4 deployment gate; a broker would still not replace HTTP reconciliation.
- The operational reset's interaction with work already durable on an agent is a separate existing safety question; this transport change neither worsens nor claims to solve it.
- Failed-print badge refresh gaps after unrelated operational reset paths are separate admin-observability work. The sync response itself must merely stop failing because a post-commit badge lookup failed.
- Physical printer, renderer, TCP/Winspool, cash-drawer, and report-encoding behavior are unchanged and require their existing hardware gates.
