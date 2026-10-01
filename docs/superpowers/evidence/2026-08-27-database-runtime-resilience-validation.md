# Database Runtime Resilience Validation Evidence

## Scope and fixed point

- Branch: `codex/database-runtime-resilience`
- Task 2 base commit used by this validation: `2fbe08b5 fix(database): manage idle connection lifecycle`
- Task 3 changed files at the focused gate:
  - `backend/tests/integration/databaseRuntime.test.js`
  - `docs/architecture.json`
  - `docs/architecture.html`
  - this evidence file, written after the test gate
- No production deployment, Hostinger restart, production database access, installer build, merge, or push was performed.

## Focused automated gate

Command:

```powershell
npx vitest run backend/tests/unit/databasePoolOptions.test.js backend/tests/unit/databaseRuntime.test.js backend/tests/unit/databasePoolAcquireTimeout.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/unit/installerConfig.test.js backend/tests/integration/databaseRuntime.test.js backend/tests/integration/databasePoolAcquireTimeout.test.js
npm run architecture:check
git diff --check
```

Fresh result before this evidence file was written:

- Vitest: 7 files passed, 105 tests passed, 0 failed.
- Architecture: 218 nodes, 60 flows, 442 steps, 2 documented defects, 160 distinct files; check passed.
- Diff check: passed.
- Local database: MariaDB `10.4.32-MariaDB`.

## Idle-policy experiment

The disposable experiment used the same reduced timing shape as the committed integration test: `connectionLimit=3`, `maxIdle=2`, `idleTimeout=700ms`, and a 250ms quiet ping.

- With the keeper: 5/5 trials converged to exactly one open connection in 1049-1056ms, with four successful probes and zero connection errors in every trial.
- Without the keeper: 3/3 control trials reached zero open connections after 1600ms.

This proves locally that native mysql2 cleanup retires burst capacity while the bounded keeper, rather than cleanup alone, preserves one warm connection.

## Connection attack experiments

All SQL was read-only except connection-local `KILL CONNECTION` used to simulate socket loss. No application table was created, changed, or deleted.

### Repeated burst and quiet convergence

- Workload: ten rounds of ten concurrent `SELECT SLEEP(0.02)` calls, then one normal query after quiet convergence.
- Peak checked-out connections: 10.
- Enqueued acquisitions: 0.
- Final acquisition/release balance: 0.
- Open connections before the final query: 1.
- Successful maintenance probes: 6.
- Connection errors / active disconnect events / warnings / errors: all 0.
- Final query returned 11.
- Total measured time: 2046ms.

### Deliberate saturation

- Workload: six concurrent reads against `connectionLimit=2`.
- Peak checked-out connections: 2.
- Queue events: 4.
- Final acquisition/release balance: 0.
- Connection errors: 0.

Mysql2 hands a released connection directly to queued callbacks without emitting another acquire/release event, so these counters describe physical pool leases, not the number of completed SQL operations. `enqueued` is the direct saturation signal.

### Idle socket reset

- An idle pooled connection was terminated from a second local connection.
- `idleDisconnects` advanced to 1; `activeDisconnects` stayed 0.
- No warning/error log was emitted.
- Mysql2 created a replacement and the next query returned 13.

### Active command reset

- A connection running `SELECT SLEEP(2)` was terminated from a second local connection.
- The original command rejected with `PROTOCOL_CONNECTION_LOST` and completed successfully zero times.
- The runtime performed zero maintenance probes and therefore did not retry the business SQL.
- The next independent query returned 17 through mysql2 replacement behavior.
- Mysql2 delivered the active failure to the query promise rather than the connection object's `error` event, so the original runtime left `activeDisconnects` at 0. This exposed a command-level observability gap; the 2026-08-28 addendum below records its closure without wrapping or retrying business SQL.

This boundary is intentional: wrapping every Promise-pool and transaction method solely to duplicate command errors would increase money-path risk. Runtime disconnect counters classify emitted socket errors; canary review must also inspect request-level database failures.

### Shutdown during a hung handshake

- A local TCP server accepted a connection but sent no MySQL handshake.
- Runtime connect timeout: 500ms; proportional watchdog acceptance bound: 750ms.
- `stop()` waited for the owned acquisition and returned after 499ms.
- Probe attempts: 1; replacement attempts: 0; final state: `stopped`.

This scaled experiment validates the production relation of the fixed 15-second process watchdog to the existing 10-second connection handshake.

## Local latency measurements

- First connection plus query: 16.165ms.
- Twenty warm queries: 0.330ms average, 0.747ms maximum.

These are local development-machine measurements only. They are not Hostinger or venue latency claims.

## Production canary acceptance gates

A separately authorized deployment must verify all of the following before calling the production issue resolved:

- `enqueued` remains zero during ordinary venue work.
- `acquired - released` returns to zero physical leases after requests settle.
- `activeDisconnects` remains zero for unsolicited active socket events.
- Request-level database failures on checkout and other business routes remain zero; this complements the socket-event counter.
- Idle disconnect and created-connection rates fall substantially from the observed baseline of roughly 255/hour.
- Checkout response latency does not regress.
- PID and process uptime are tracked separately; database improvement is not claimed to resolve Hostinger platform restarts.
- `/health` and `/api/health` continue returning their existing database-ready contracts.

## Explicit limits

- No Hostinger deployment or production canary was performed.
- The implementation does not retry business SQL, transactions, checkout, settlement, print-queue writes, or migrations.
- A real MySQL service restart or Hostinger Node-process restart remains an external failure class; this work improves pool lifecycle and visibility without pretending to prevent platform restarts.

## 2026-08-28 command-disconnect observability addendum

Review of the original active-reset boundary found that route logging was not a complete authority: some route catches return a generic 500 without logging the underlying database error. The runtime now subscribes during its active lifecycle to mysql2 3.20.0's documented `mysql2:query` and `mysql2:execute` tracing error channels.

The handler:

- increments a separate `commandDisconnects` counter only for fatal or recognized transport failures;
- counts one trace context once even if Node publishes more than one error event for it;
- logs only the fixed operation kind, code, fatal flag, PID, and uptime;
- never reads, retains, or logs the tracing context's SQL, bound values, database, server address, or user;
- contains logger failures so diagnostics cannot interfere with the command's existing rejection path;
- stops maintenance when shutdown begins, retains command tracing through the HTTP drain, unsubscribes before pool shutdown, and never retries the failed command.

Focused real-MariaDB evidence terminated a connection while `SELECT SLEEP(2)` was active. The promise rejected once with `PROTOCOL_CONNECTION_LOST`, `commandDisconnects` advanced once, `activeDisconnects` remained zero, no maintenance probe ran, and the next independent query returned 17 through normal pool replacement. Unit evidence also covers duplicate trace publication, a fatal error with no code, non-fatal `ER_DUP_ENTRY`, query and execute channels, tracing retained after maintenance stops and removed only by the full runtime stop, logger failure containment, and secret-bearing diagnostic contexts.

A disposable local timing probe alternated five runs of 1,000 `SELECT 1` calls with and without the tracing subscriber. Median time was 0.0788 ms/query without the subscriber and 0.0798 ms/query with it, a measured 1.2% delta on this development machine only.

Fresh verification after implementation:

- Focused database gate: 7 files passed, 109 tests passed, 0 failed.
- Architecture check: 218 nodes, 60 flows, 442 steps, 2 documented defects, 160 distinct files; passed.
- Ten-round real-MariaDB attack loop: five active `query()` commands and five active `execute()` commands were killed; all ten rejected once, all ten produced exactly one command-disconnect count, every next query returned 17, and no stopped runtime retained a tracing subscription.
