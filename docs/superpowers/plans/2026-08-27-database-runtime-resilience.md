# Database Runtime Resilience Implementation Plan

> **For agentic workers:** Use the `executing-plans` skill when available, then implement this plan task-by-task. A differently named or unavailable skill alias is not a blocker because every required command and assertion is written below. Steps use checkbox (`- [ ]`) syntax for tracking. Work in the existing feature branch checkout; do not create an isolated worktree.

**Goal:** Replace unmanaged idle MySQL sockets and cumulative warning spam with one lifecycle-owned database runtime that preserves the existing Promise-pool interface, keeps one quiet connection warm, retires burst connections deliberately, and distinguishes harmless idle disconnects from errors affecting active work.

**Architecture:** Add one deep `DatabaseRuntime` module behind the existing `backend/config/db.js` seam. All routes, services, migrations, reports, checkout transactions, tests, and spooler sync code continue receiving the same mysql2 Promise pool; only `server.js` starts and stops the runtime's background maintenance. MySQL2 remains responsible for removing fatal sockets and creating replacements, while the runtime owns idle policy, one bounded protocol ping, state-aware telemetry, and timer lifecycle.

**Tech Stack:** Node.js 20+, CommonJS, mysql2 3.20, MariaDB/MySQL, Express 5, Vitest 4, Pino, existing architecture generator.

**Execution branch:** `codex/database-runtime-resilience` in the ordinary repository checkout. Continue from the plan commit; do not create a second branch or worktree.

## Global Constraints

- Preserve `require('../config/db')` as the mysql2 Promise-pool interface. Existing callers must retain `query`, `execute`, `getConnection`, `end`, pool events, and the non-enumerable `connectionTelemetrySnapshot()` function.
- Keep exactly one application `mysql.createPool()` call. Do not add a second pool, driver, proxy, ORM, cache, queue, worker, dependency, schema migration, or environment variable.
- Keep `connectionLimit=10` and `queueLimit=50` as current defaults. `DB_CONNECTION_LIMIT` and `DB_QUEUE_LIMIT` remain the only pool-size overrides.
- Set default `maxIdle=2`, `idleTimeout=45000`, and `gracefulEnd=true`. For `connectionLimit=2`, use `maxIdle=1`; for `connectionLimit=1`, use `maxIdle=1` and rely on the keeper because mysql2 intentionally disables its idle cleanup when `maxIdle === connectionLimit`.
- Raise the existing graceful-shutdown watchdog from 10 seconds to the fixed constant `GRACEFUL_SHUTDOWN_TIMEOUT_MS=15000`. This gives the existing 10-second connection handshake a five-second cleanup margin without adding a new timer or environment variable.
- Maintain one warm connection, not ten. A burst may still use all `connectionLimit` connections; `maxIdle` limits only released connections.
- Run the runtime's quiet probe only after migrations and schema validation mark startup ready. Setting `maxIdle < connectionLimit` makes mysql2 start its own driver cleanup timer at pool construction; that timer is expected, is not a protocol probe, and is stopped by the existing `pool.end()` lifecycle. Imports must never call `DatabaseRuntime.start()` implicitly.
- Use `PromisePool#getConnection()`, then `PromisePoolConnection#ping()`, then `release()`. mysql2's Promise pool has no direct `ping()` method.
- Never retry `query`, `execute`, a transaction, checkout, settlement, print-queue mutation, migration, or any other business SQL inside the runtime.
- A failed probe may destroy its probe connection and perform one replacement probe. It must never reconstruct the pool or loop without a bound.
- Preserve `/health` and `/api/health` response/status semantics. Installers, updates, repair tasks, server detection, and spooler provisioning require `status=ok` and `db=connected`; process-liveness redesign is outside this plan.
- Preserve `SET time_zone = '+00:00'` for each new connection.
- Do not log database host, name, username, password, SQL, query values, restaurant data, request data, or connection objects.
- Do not modify checkout idempotency, transaction boundaries, schema validation, startup migration authority, Socket.IO, spooler protocol, printer behavior, installers, version authorities, or Hostinger configuration.
- Use focused tests only while implementing Tasks 1 and 2. Task 3 runs the complete database-runtime-focused command once; do not run the whole repository suite unless a focused failure proves broader impact.
- Do not deploy, restart Hostinger, rebuild installers, push, merge, or modify a live database under this plan.

## Verified Evidence and Design Decisions

- `backend/config/databasePoolOptions.js` currently returns `maxIdle: connectionLimit`. mysql2 3.20 starts its cleanup timer only when `maxIdle < connectionLimit`; a local constructor probe measured the current cleaner as disabled.
- A process probe against the installed mysql2 3.20.0 confirmed that enabling native idle cleanup keeps Node alive until `pool.end()` (or explicit process exit). The production server already closes the pool on startup failure and graceful shutdown; the new real-pool test must also close its own pool in `finally`. This is a deliberate driver lifecycle cost, not an invisible runtime timer.
- `databasePoolAcquireTimeout.js` starts its 10-second timeout only after mysql2 emits `enqueue`; a newly-created connection remains bounded by the existing `connectTimeout=10000`. Shutdown therefore needs more than 10 seconds when it waits for an already-started maintenance acquisition. Once `stop()` sets `started=false`, a late acquisition is destroyed before ping or retry, so the 15-second watchdog covers the actual worst case without a second acquisition watchdog.
- The four standalone production importers outside routes/services (`run_migration.js`, `migrate_add_tax_rate.js`, `benchmark-table-settlement.js`, and `reconciliation-scan.js`) already terminate through `pool.end()` or explicit `process.exit()`. No standalone command needs a new shutdown path for the native cleanup timer.
- A local three-connection experiment left all three current-policy connections idle indefinitely. The proposed cleanup policy reduced the same burst to one warm connection when paired with the keeper.
- A fresh pre-implementation experiment using the exact proposed integration policy (`connectionLimit=3`, `maxIdle=2`, `idleTimeout=700`, 250 ms probe) converged to exactly one warm connection in all five runs (1049-1056 ms), with four successful pings and zero connection errors per run. The same policy without the keeper reached zero open connections in all three control runs after 1600 ms. This proves both that the 1600 ms test deadline is viable locally and that the keeper, not native cleanup alone, preserves the warm socket.
- A disposable scaled lifecycle experiment forced one scheduler exception and one acquisition that settled near the connection-timeout boundary. The scheduler moved `healthy -> degraded -> healthy` with zero unhandled rejections, while shutdown waited 94 ms and completed below the proportionally equivalent 150 ms watchdog. This validates the corrected control flow, not production timing.
- A controlled local `KILL CONNECTION` experiment showed mysql2 removed the fatal socket and the next query succeeded on a new connection ID in 1.37 ms. Therefore this plan does not implement a redundant reconnect engine.
- Local measurements were 126.30 ms for first acquisition, 1.39 ms for a query on the connection, and 0.27 ms for protocol `PING`. These numbers are local evidence only, but they establish that a quiet ping is cheaper than forcing the next cashier request to create the first connection.
- The production sample had `created=765`, `connectionErrors=764`, `acquired=26951`, `released=26951`, `enqueued=0`, and about three hours of uptime. It rules out a connection leak and saturation but does not prove whether every error happened idle; Task 1 adds that missing classification.
- Existing spooler-sync evidence measured peak DB use of one connection at five agents, two at ten agents, and ten only at the artificial 50-agent tier. `maxIdle=2` preserves venue-realistic short-burst headroom without keeping the entire ten-connection ceiling idle.
- Hostinger documents both idle closure and MySQL service restart as causes of lost connections, and separately documents a 20-new-connections-per-second account limit. One background replacement attempt per application is bounded below that rate for the current fleet; it is not permission to retry business SQL.
- `39` application-runtime files, two standalone scripts, and `98` test files reference `config/db`. The compatibility seam is mandatory; rewriting callers would create risk without adding capability.

## File Structure

- Create `backend/services/databaseRuntime.js`: the deep module. It creates the single pool, attaches the existing queued-acquisition timeout, initializes UTC sessions, tracks leases/errors, owns quiet probing, and exposes `{ pool, start, stop, snapshot }`.
- Modify `backend/config/databasePoolOptions.js`: add the tested idle policy using the existing connection limit.
- Modify `backend/config/db.js`: retain environment loading and production credential validation, construct one runtime, export `runtime.pool`, and attach non-enumerable runtime compatibility properties.
- Delete `backend/services/databasePoolTelemetry.js`: its shallow event listeners move into the runtime so one module owns connection state and logging.
- Create `backend/tests/unit/databaseRuntime.test.js`: fake-pool/fake-clock tests through the runtime interface.
- Modify `backend/tests/unit/databasePoolOptions.test.js`: pin the default and small-limit idle policies.
- Delete `backend/tests/unit/databasePoolTelemetry.test.js`: replaced by runtime-interface tests rather than layering tests beneath the new seam.
- Modify `server.js`: start maintenance only after schema readiness and stop it before ending the pool. Preserve both health route contracts.
- Create `backend/tests/integration/databaseRuntime.test.js`: real-MariaDB burst/quiet behavior and normal query continuity.
- Modify `backend/tests/unit/schemaAuthority.test.js`: pin runtime ordering and unchanged startup gate/health behavior.
- Modify `backend/tests/unit/installerConfig.test.js`: include the new runtime source in the installed-server configuration ownership check.
- Modify `docs/architecture.json` and regenerate `docs/architecture.html`: replace the old pool/telemetry description, trace maintenance start/stop, and correct the stale boot-order statement without changing source boot order.
- Create `docs/superpowers/evidence/2026-08-27-database-runtime-resilience-validation.md`: record fresh focused commands and results only; no production claim.

---

### Task 1: Establish the DatabaseRuntime Seam and Truthful Telemetry

**Files:**
- Create: `backend/services/databaseRuntime.js`
- Modify: `backend/config/db.js`
- Delete: `backend/services/databasePoolTelemetry.js`
- Create: `backend/tests/unit/databaseRuntime.test.js`
- Delete: `backend/tests/unit/databasePoolTelemetry.test.js`
- Modify: `backend/tests/unit/installerConfig.test.js`

**Interfaces:**
- Consumes: `mysql.createPool(poolOptions)`, `attachDatabasePoolAcquireTimeout(corePool, { logger })`, and a Pino-compatible logger.
- Produces: `createDatabaseRuntime({ mysql, poolOptions, logger, maintenance? }): DatabaseRuntime`.
- `DatabaseRuntime` is `{ pool, start(): boolean, stop(): Promise<void>, snapshot(): Readonly<DatabaseRuntimeSnapshot> }`.
- `DatabaseRuntimeSnapshot` preserves `{ created, acquired, released, enqueued, connectionErrors }` and adds `{ idleDisconnects, activeDisconnects, probeDisconnects, probeAttempts, probeSuccesses, probeFailures, inUse, peakInUse, openConnections, state, lastSuccessAt, lastFailureAt }`. Probe classification is exact after `PromisePool#getConnection()` resolves and the runtime marks the connection. Mysql2 emits `acquire` before that promise resolves, so an error in that tiny public-API handoff window is conservatively visible as active rather than silently hidden; do not reach into mysql2 internals to eliminate an observability-only race.
- The Task 1 `start()` and `stop()` are idempotent lifecycle methods with no scheduled probe yet. Task 2 adds maintenance behind the same interface.

- [ ] **Step 1: Write RED tests for the runtime interface and classification**

Create `backend/tests/unit/databaseRuntime.test.js` with an `EventEmitter` core-pool harness. Include these exact observable cases:

```js
const { EventEmitter } = require('node:events');
const { createDatabaseRuntime } = require('../../services/databaseRuntime');

function harness() {
    const corePool = new EventEmitter();
    const promisePool = {
        query: vi.fn(), execute: vi.fn(), getConnection: vi.fn(), end: vi.fn()
    };
    corePool.getConnection = vi.fn();
    corePool.promise = vi.fn(() => promisePool);
    const mysql = { createPool: vi.fn(() => corePool) };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { corePool, promisePool, mysql, logger };
}

function poolConnection() {
    const connection = new EventEmitter();
    connection.query = vi.fn();
    return connection;
}

describe('database runtime', () => {
    it('creates one pool and preserves the promise-pool interface', () => {
        const h = harness();
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn()
        });

        expect(h.mysql.createPool).toHaveBeenCalledOnce();
        expect(runtime.pool).toBe(h.promisePool);
        expect(runtime.snapshot()).toMatchObject({
            created: 0, acquired: 0, released: 0, enqueued: 0,
            connectionErrors: 0, idleDisconnects: 0,
            activeDisconnects: 0, probeDisconnects: 0,
            inUse: 0, peakInUse: 0, state: 'stopped'
        });
    });

    it('classifies idle and active connection errors without logging secrets', () => {
        const h = harness();
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn()
        });
        const idle = poolConnection();
        const secondIdle = poolConnection();
        const active = poolConnection();

        h.corePool.emit('connection', idle);
        h.corePool.emit('connection', secondIdle);
        h.corePool.emit('connection', active);
        h.corePool.emit('acquire', active);
        idle.emit('error', Object.assign(new Error('secret-host secret-password'), {
            code: 'ECONNRESET', fatal: true
        }));
        secondIdle.emit('error', Object.assign(new Error('secret-host secret-password'), {
            code: 'ECONNRESET', fatal: true
        }));
        active.emit('error', Object.assign(new Error('secret-host secret-password'), {
            code: 'ECONNRESET', fatal: true
        }));

        expect(runtime.snapshot()).toMatchObject({
            created: 3, connectionErrors: 3,
            idleDisconnects: 2, activeDisconnects: 1,
            inUse: 0, peakInUse: 1
        });
        expect(h.logger.warn).toHaveBeenCalledTimes(1);
        expect(h.logger.debug).toHaveBeenCalledTimes(2);
        const serializedLogs = JSON.stringify([
            ...h.logger.debug.mock.calls,
            ...h.logger.info.mock.calls,
            ...h.logger.warn.mock.calls,
            ...h.logger.error.mock.calls
        ]);
        expect(serializedLogs).not.toContain('secret-host');
        expect(serializedLogs).not.toContain('secret-password');
    });

    it('tracks balanced leases and exposes idempotent lifecycle methods', async () => {
        const h = harness();
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn()
        });
        const connection = poolConnection();

        h.corePool.emit('connection', connection);
        h.corePool.emit('acquire', connection);
        h.corePool.emit('release', connection);

        expect(runtime.start()).toBe(true);
        expect(runtime.start()).toBe(false);
        await runtime.stop();
        await runtime.stop();
        expect(runtime.snapshot()).toMatchObject({
            acquired: 1, released: 1, inUse: 0, peakInUse: 1, state: 'stopped'
        });
        expect(connection.query).toHaveBeenCalledWith("SET time_zone = '+00:00'");
    });
});
```

- [ ] **Step 2: Run the Task 1 tests RED**

Run:

```powershell
npx vitest run backend/tests/unit/databaseRuntime.test.js backend/tests/unit/databasePoolTelemetry.test.js
```

Expected: FAIL because `databaseRuntime.js` does not exist and the old telemetry tests still describe cumulative threshold warnings.

- [ ] **Step 3: Implement the runtime seam without maintenance behavior**

Create `backend/services/databaseRuntime.js` around this exact state and interface:

```js
const { attachDatabasePoolAcquireTimeout } = require('./databasePoolAcquireTimeout');

function createDatabaseRuntime({
    mysql,
    poolOptions,
    logger,
    attachAcquireTimeout = attachDatabasePoolAcquireTimeout,
    maintenance = {}
}) {
    const corePool = mysql.createPool(poolOptions);
    attachAcquireTimeout(corePool, { logger });
    const pool = corePool.promise();
    const leased = new Set();
    const probeConnections = new Set();
    const openConnections = new Set();
    const counters = {
        created: 0,
        acquired: 0,
        released: 0,
        enqueued: 0,
        connectionErrors: 0,
        idleDisconnects: 0,
        activeDisconnects: 0,
        probeDisconnects: 0,
        probeAttempts: 0,
        probeSuccesses: 0,
        probeFailures: 0,
        peakInUse: 0
    };
    let started = false;
    let state = 'stopped';
    let lastSuccessAt = null;
    let lastFailureAt = null;

    const snapshot = () => Object.freeze({
        ...counters,
        inUse: leased.size,
        openConnections: openConnections.size,
        state,
        lastSuccessAt,
        lastFailureAt
    });

    corePool.on('connection', (connection) => {
        counters.created += 1;
        openConnections.add(connection);
        let removed = false;
        const markRemoved = () => {
            if (removed) return;
            removed = true;
            openConnections.delete(connection);
            leased.delete(connection);
            probeConnections.delete(connection);
        };
        connection.once('end', markRemoved);
        connection.on('error', (error) => {
            counters.connectionErrors += 1;
            const code = String(error?.code || 'UNKNOWN');
            const fatal = Boolean(error?.fatal);
            if (probeConnections.has(connection)) {
                counters.probeDisconnects += 1;
            } else if (leased.has(connection)) {
                counters.activeDisconnects += 1;
                logger?.warn({
                    event: 'database_active_connection_error', code, fatal,
                    pid: process.pid, uptime_seconds: Math.floor(process.uptime())
                }, 'Active database connection failed.');
            } else {
                counters.idleDisconnects += 1;
                logger?.debug?.({
                    event: 'database_idle_connection_closed', code, fatal,
                    pid: process.pid, uptime_seconds: Math.floor(process.uptime())
                }, 'Idle database connection closed.');
            }
            markRemoved();
        });
        connection.query("SET time_zone = '+00:00'");
    });
    corePool.on('acquire', (connection) => {
        counters.acquired += 1;
        leased.add(connection);
        counters.peakInUse = Math.max(counters.peakInUse, leased.size);
    });
    corePool.on('release', (connection) => {
        counters.released += 1;
        leased.delete(connection);
    });
    corePool.on('enqueue', () => { counters.enqueued += 1; });

    const start = () => {
        if (started) return false;
        started = true;
        state = 'healthy';
        lastSuccessAt = new Date().toISOString();
        return true;
    };
    const stop = async () => {
        if (!started && state === 'stopped') return;
        started = false;
        state = 'stopped';
    };

    return Object.freeze({ pool, start, stop, snapshot });
}

module.exports = { createDatabaseRuntime };
```

Task 1 must not add a timer or query retry. Keep `maintenance` accepted for Task 2 dependency injection without exposing its members in the public interface.

Modify `backend/config/db.js` so it remains the only environment/credential adapter:

```js
const mysql = require('mysql2');
const logger = require('./logger');
const { buildDatabasePoolOptions } = require('./databasePoolOptions');
const { createDatabaseRuntime } = require('../services/databaseRuntime');

// Preserve the existing dotenv loading and production credential validation verbatim.

const databaseRuntime = createDatabaseRuntime({
    mysql,
    poolOptions: buildDatabasePoolOptions(process.env),
    logger
});
const pool = databaseRuntime.pool;

Object.defineProperties(pool, {
    databaseRuntime: { enumerable: false, value: databaseRuntime },
    connectionTelemetrySnapshot: { enumerable: false, value: databaseRuntime.snapshot }
});

module.exports = pool;
```

Remove the old telemetry import, attachment, and duplicate UTC connection listener from `db.js`; delete `databasePoolTelemetry.js` and its old test only after the runtime tests cover its compatibility counters and secret-redaction contract.

Modify `installerConfig.test.js` line 12 to read the new runtime authority as well:

```js
const source = read('backend/config/db.js')
    + read('backend/config/databasePoolOptions.js')
    + read('backend/services/databaseRuntime.js');

expect(source).toContain(
    'connectionTelemetrySnapshot: { enumerable: false, value: databaseRuntime.snapshot }'
);
expect(source).toContain(
    'databaseRuntime: { enumerable: false, value: databaseRuntime }'
);
```

These two assertions are the focused compatibility guard for direct consumers such as `loginRateLimitIdentity.test.js`; do not add that 35-second route file to this refactor's gate merely to re-prove the same property.

- [ ] **Step 4: Run Task 1 GREEN verification**

Run:

```powershell
npx vitest run backend/tests/unit/databaseRuntime.test.js backend/tests/unit/databasePoolAcquireTimeout.test.js backend/tests/unit/installerConfig.test.js
```

Expected: all selected files pass; no timer is left open.

- [ ] **Step 5: Review the Task 1 diff against invariants**

Run:

```powershell
rg -n "createPool\(" backend server.js -g "*.js" -g "!backend/tests/**"
rg -n "databasePoolTelemetry" backend server.js -g "*.js" -g "!backend/tests/**"
git diff --check
```

Expected:
- One production `createPool()` remains in `databaseRuntime.js`; test-local pools are allowed.
- No production reference to the deleted telemetry module remains.
- Diff check is clean.

- [ ] **Step 6: Commit Task 1**

```powershell
git add backend/config/db.js backend/services/databaseRuntime.js backend/services/databasePoolTelemetry.js backend/tests/unit/databaseRuntime.test.js backend/tests/unit/databasePoolTelemetry.test.js backend/tests/unit/installerConfig.test.js
git commit -m "refactor(database): centralize pool lifecycle"
```

---

### Task 2: Add Bounded Idle Cleanup and One Quiet Warm Connection

**Files:**
- Modify: `backend/config/databasePoolOptions.js`
- Modify: `backend/services/databaseRuntime.js`
- Modify: `backend/tests/unit/databasePoolOptions.test.js`
- Modify: `backend/tests/unit/databaseRuntime.test.js`
- Modify: `server.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`

**Interfaces:**
- Consumes: Task 1 `DatabaseRuntime` and unchanged Promise pool.
- Produces: the same `{ pool, start, stop, snapshot }` interface with non-overlapping quiet maintenance.
- Internal defaults: `quietIntervalMs=30000`, `pingTimeoutMs=3000`, `retryDelayMs=500`, `degradedIntervalMs=5000`.
- `start()` schedules maintenance and returns `true` once; `stop()` cancels its timer, waits for the in-flight probe to settle, and returns without ending the pool.

- [ ] **Step 1: Write RED option-policy tests**

Change `backend/tests/unit/databasePoolOptions.test.js` expectations to:

```js
expect(buildDatabasePoolOptions(credentials)).toMatchObject({
    host: '127.0.0.1', port: 3306,
    connectionLimit: 10, maxIdle: 2, idleTimeout: 45000,
    gracefulEnd: true, queueLimit: 50,
    enableKeepAlive: true, keepAliveInitialDelay: 0,
    connectTimeout: 10000
});

expect(buildDatabasePoolOptions({
    ...credentials, DB_CONNECTION_LIMIT: '5', DB_QUEUE_LIMIT: '0'
})).toMatchObject({ connectionLimit: 5, maxIdle: 2, queueLimit: 50 });

expect(buildDatabasePoolOptions({
    ...credentials, DB_CONNECTION_LIMIT: '2'
})).toMatchObject({ connectionLimit: 2, maxIdle: 1 });

expect(buildDatabasePoolOptions({
    ...credentials, DB_CONNECTION_LIMIT: '1'
})).toMatchObject({ connectionLimit: 1, maxIdle: 1 });
```

- [ ] **Step 2: Write RED fake-clock maintenance tests**

Extend `databaseRuntime.test.js` with fake timers and promise connections shaped as `{ connection: coreConnection, ping, release, destroy }`. Pin all of these behaviors:

```js
function promiseConnection(ping = vi.fn().mockResolvedValue(undefined)) {
    return {
        connection: poolConnection(),
        ping,
        release: vi.fn(),
        destroy: vi.fn()
    };
}

afterEach(() => {
    vi.useRealTimers();
});

it('pings one released connection only after the pool stays quiet', async () => {
    vi.useFakeTimers();
    const h = harness();
    const connection = promiseConnection();
    h.promisePool.getConnection.mockResolvedValue(connection);
    const runtime = createDatabaseRuntime({
        mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
        attachAcquireTimeout: vi.fn(),
        maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 1 }
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(h.promisePool.getConnection).not.toHaveBeenCalled();
    expect(runtime.start()).toBe(true);
    expect(runtime.start()).toBe(false);
    await vi.advanceTimersByTimeAsync(29);
    expect(connection.ping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.ping).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.destroy).not.toHaveBeenCalled();
    expect(h.promisePool.query).not.toHaveBeenCalled();
    expect(h.promisePool.execute).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({ probeAttempts: 1, probeSuccesses: 1, state: 'healthy' });
    await runtime.stop();
});

it('skips probing while business work owns a connection', async () => {
    vi.useFakeTimers();
    const h = harness();
    const businessConnection = new EventEmitter();
    const probe = promiseConnection();
    h.promisePool.getConnection.mockResolvedValue(probe);
    const runtime = createDatabaseRuntime({
        mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
        attachAcquireTimeout: vi.fn(),
        maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 1 }
    });

    runtime.start();
    h.corePool.emit('acquire', businessConnection);
    await vi.advanceTimersByTimeAsync(30);
    expect(h.promisePool.getConnection).not.toHaveBeenCalled();
    h.corePool.emit('release', businessConnection);
    await vi.advanceTimersByTimeAsync(29);
    expect(h.promisePool.getConnection).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
    expect(probe.release).toHaveBeenCalledOnce();
    await runtime.stop();
});

it('destroys a failed probe and succeeds through one replacement probe', async () => {
    vi.useFakeTimers();
    const h = harness();
    const first = promiseConnection(vi.fn().mockRejectedValue(
        Object.assign(new Error('reset'), { code: 'ECONNRESET', fatal: true })
    ));
    const second = promiseConnection();
    h.promisePool.getConnection
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
    const runtime = createDatabaseRuntime({
        mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
        attachAcquireTimeout: vi.fn(),
        maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 1 }
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(first.release).not.toHaveBeenCalled();
    expect(second.release).toHaveBeenCalledOnce();
    expect(runtime.snapshot()).toMatchObject({
        probeAttempts: 2, probeFailures: 1, probeSuccesses: 1, state: 'healthy'
    });
    expect(h.logger.warn).not.toHaveBeenCalled();
    await runtime.stop();
});

it('logs one degraded transition after both bounded attempts fail and recovers once', async () => {
    vi.useFakeTimers();
    const h = harness();
    const failures = Array.from({ length: 4 }, () => promiseConnection(
        vi.fn().mockRejectedValue(Object.assign(new Error('reset'), {
            code: 'ECONNRESET', fatal: true
        }))
    ));
    const recovered = promiseConnection();
    for (const connection of [...failures, recovered]) {
        h.promisePool.getConnection.mockResolvedValueOnce(connection);
    }
    const runtime = createDatabaseRuntime({
        mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
        attachAcquireTimeout: vi.fn(),
        maintenance: {
            quietIntervalMs: 30, pingTimeoutMs: 10,
            retryDelayMs: 1, degradedIntervalMs: 5
        }
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(31);
    expect(runtime.snapshot().state).toBe('degraded');
    expect(h.logger.warn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6);
    expect(runtime.snapshot().state).toBe('degraded');
    expect(h.logger.warn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5);
    expect(runtime.snapshot().state).toBe('healthy');
    expect(h.logger.info).toHaveBeenCalledOnce();
    expect(recovered.release).toHaveBeenCalledOnce();
    for (const failed of failures) expect(failed.destroy).toHaveBeenCalledOnce();
    await runtime.stop();
});

it('stop cancels future maintenance and waits for the current probe', async () => {
    vi.useFakeTimers();
    const h = harness();
    let resolvePing;
    const probe = promiseConnection(vi.fn(() => new Promise((resolve) => {
        resolvePing = resolve;
    })));
    h.promisePool.getConnection.mockResolvedValue(probe);
    const runtime = createDatabaseRuntime({
        mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
        attachAcquireTimeout: vi.fn(),
        maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 1 }
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(30);
    expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
    const stopping = runtime.stop();
    resolvePing();
    await stopping;
    await vi.advanceTimersByTimeAsync(100);
    expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
    expect(runtime.snapshot().state).toBe('stopped');
});

it('stop during retry delay prevents a replacement acquisition', async () => {
    vi.useFakeTimers();
    const h = harness();
    const failed = promiseConnection(vi.fn().mockRejectedValue(
        Object.assign(new Error('reset'), { code: 'ECONNRESET', fatal: true })
    ));
    h.promisePool.getConnection.mockResolvedValueOnce(failed);
    const runtime = createDatabaseRuntime({
        mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
        attachAcquireTimeout: vi.fn(),
        maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 20 }
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(30);
    expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
    await runtime.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
    expect(runtime.snapshot().state).toBe('stopped');
});

it('delays the probe by only the quiet time remaining after recent activity', async () => {
    vi.useFakeTimers();
    const h = harness();
    const businessConnection = new EventEmitter();
    const probe = promiseConnection();
    h.promisePool.getConnection.mockResolvedValue(probe);
    const runtime = createDatabaseRuntime({
        mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
        attachAcquireTimeout: vi.fn(),
        maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 1 }
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(20);
    h.corePool.emit('acquire', businessConnection);
    h.corePool.emit('release', businessConnection);
    await vi.advanceTimersByTimeAsync(29);
    expect(h.promisePool.getConnection).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
    await runtime.stop();
});

it('destroys a timed-out probe instead of returning it to the pool', async () => {
    vi.useFakeTimers();
    const h = harness();
    const hanging = promiseConnection(vi.fn(() => new Promise(() => {})));
    h.promisePool.getConnection.mockResolvedValue(hanging);
    const runtime = createDatabaseRuntime({
        mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
        attachAcquireTimeout: vi.fn(),
        maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 20 }
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(40);
    expect(hanging.destroy).toHaveBeenCalledOnce();
    expect(hanging.release).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toMatchObject({ probeAttempts: 1, probeFailures: 1 });
    await runtime.stop();
});

it('classifies a probe socket error separately from active business work', async () => {
    vi.useFakeTimers();
    const h = harness();
    const reset = Object.assign(new Error('reset'), { code: 'ECONNRESET', fatal: true });
    const probe = promiseConnection();
    probe.ping.mockImplementation(() => {
        probe.connection.emit('error', reset);
        return Promise.reject(reset);
    });
    h.corePool.emit('connection', probe.connection);
    h.promisePool.getConnection.mockResolvedValueOnce(probe);
    const runtime = createDatabaseRuntime({
        mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
        attachAcquireTimeout: vi.fn(),
        maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 20 }
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(30);
    expect(runtime.snapshot()).toMatchObject({
        probeDisconnects: 1, activeDisconnects: 0, idleDisconnects: 0
    });
    expect(h.logger.warn).not.toHaveBeenCalled();
    await runtime.stop();
});

it('contains an unexpected scheduler failure and recovers on the next probe', async () => {
    vi.useFakeTimers();
    const h = harness();
    const failed = [
        promiseConnection(vi.fn().mockRejectedValue(
            Object.assign(new Error('reset'), { code: 'ECONNRESET', fatal: true })
        )),
        promiseConnection(vi.fn().mockRejectedValue(
            Object.assign(new Error('reset'), { code: 'ECONNRESET', fatal: true })
        ))
    ];
    const recovered = promiseConnection();
    h.promisePool.getConnection
        .mockResolvedValueOnce(failed[0])
        .mockResolvedValueOnce(failed[1])
        .mockResolvedValueOnce(recovered);
    h.logger.warn.mockImplementationOnce(() => {
        throw Object.assign(new Error('logger failed'), { code: 'LOGGER_FAILED' });
    });
    const runtime = createDatabaseRuntime({
        mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
        attachAcquireTimeout: vi.fn(),
        maintenance: {
            quietIntervalMs: 30, pingTimeoutMs: 10,
            retryDelayMs: 1, degradedIntervalMs: 5
        }
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(31);
    expect(runtime.snapshot().state).toBe('degraded');
    expect(h.logger.error).toHaveBeenCalledOnce();
    expect(h.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
            event: 'database_runtime_probe_failed', code: 'LOGGER_FAILED'
        }),
        'Database connection maintenance failed unexpectedly.'
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(runtime.snapshot().state).toBe('healthy');
    expect(recovered.release).toHaveBeenCalledOnce();
    await runtime.stop();
});

it('waits for a pending acquisition to settle without starting a shutdown retry', async () => {
    vi.useFakeTimers();
    const h = harness();
    let rejectAcquire;
    h.promisePool.getConnection.mockImplementation(() => new Promise((_, reject) => {
        rejectAcquire = reject;
    }));
    const runtime = createDatabaseRuntime({
        mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
        attachAcquireTimeout: vi.fn(),
        maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 1 }
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(30);
    const stopping = runtime.stop();
    let stopped = false;
    stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    rejectAcquire(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }));
    await stopping;
    await vi.advanceTimersByTimeAsync(100);
    expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
    expect(runtime.snapshot().state).toBe('stopped');
});
```

- [ ] **Step 3: Run Task 2 tests RED**

Run:

```powershell
npx vitest run backend/tests/unit/databasePoolOptions.test.js backend/tests/unit/databaseRuntime.test.js backend/tests/unit/schemaAuthority.test.js
```

Expected: option tests fail on `maxIdle`, and maintenance tests fail because Task 1 has no scheduler.

- [ ] **Step 4: Implement the idle policy**

In `databasePoolOptions.js`, calculate idle capacity without adding environment settings:

```js
const maxIdle = connectionLimit === 1 ? 1 : Math.min(2, connectionLimit - 1);

return {
    // existing credentials and timezone fields unchanged
    waitForConnections: true,
    connectionLimit,
    maxIdle,
    idleTimeout: 45_000,
    gracefulEnd: true,
    queueLimit: configuredQueue === 0 ? 50 : configuredQueue,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: 10_000
};
```

Do not change `requiredInteger` or add a `DB_MAX_IDLE`/heartbeat variable.

- [ ] **Step 5: Implement one non-overlapping quiet probe inside DatabaseRuntime**

Add private runtime state only; do not add methods to the public interface:

```js
const quietIntervalMs = maintenance.quietIntervalMs ?? 30_000;
const pingTimeoutMs = maintenance.pingTimeoutMs ?? 3_000;
const retryDelayMs = maintenance.retryDelayMs ?? 500;
const degradedIntervalMs = maintenance.degradedIntervalMs ?? 5_000;
const setTimeoutFn = maintenance.setTimeoutFn ?? setTimeout;
const clearTimeoutFn = maintenance.clearTimeoutFn ?? clearTimeout;
const now = maintenance.now ?? Date.now;

let timer = null;
let retryTimer = null;
let resolveRetry = null;
let inFlightProbe = null;
let lastActivityAt = now();
```

Update the Task 1 listeners so `lastActivityAt = now()` is the first statement in both the pool `acquire` and `release` handlers. Implement these private operations; do not replace them with a recurring `setInterval`:

```js
const markUnexpectedProbeFailure = (error) => {
    lastFailureAt = new Date(now()).toISOString();
    const shouldLog = state !== 'degraded';
    state = 'degraded';
    if (!shouldLog) return;
    try {
        logger?.error?.({
            event: 'database_runtime_probe_failed',
            code: String(error?.code || 'UNKNOWN')
        }, 'Database connection maintenance failed unexpectedly.');
    } catch (_) {
        // A diagnostic failure must not become an unhandled rejection.
    }
};

const schedule = (delayMs) => {
    if (!started || timer) return;
    timer = setTimeoutFn(() => {
        timer = null;
        inFlightProbe = runProbe()
            .catch(markUnexpectedProbeFailure)
            .finally(() => {
                inFlightProbe = null;
                if (started) {
                    schedule(state === 'degraded' ? degradedIntervalMs : quietIntervalMs);
                }
            });
    }, delayMs);
    timer.unref?.();
};

const waitForRetry = () => new Promise((resolve) => {
    resolveRetry = resolve;
    retryTimer = setTimeoutFn(() => {
        retryTimer = null;
        resolveRetry = null;
        resolve(true);
    }, retryDelayMs);
    retryTimer.unref?.();
});

const cancelRetry = () => {
    if (retryTimer) clearTimeoutFn(retryTimer);
    retryTimer = null;
    const resolve = resolveRetry;
    resolveRetry = null;
    resolve?.(false);
};

const pingOne = async () => {
    let connection;
    let deadline;
    let released = false;
    try {
        counters.probeAttempts += 1;
        connection = await pool.getConnection();
        if (!started) {
            connection.destroy();
            return null;
        }
        // mysql2 emits acquire before this promise resolves. From this point
        // forward probe errors are exact; the earlier handoff remains
        // conservatively visible as active without using private driver state.
        probeConnections.add(connection.connection);
        await Promise.race([
            connection.ping(),
            new Promise((_, reject) => {
                deadline = setTimeoutFn(() => {
                    const error = new Error('Database warm-connection ping timed out.');
                    error.code = 'DB_WARM_PING_TIMEOUT';
                    reject(error);
                }, pingTimeoutMs);
                deadline.unref?.();
            })
        ]);
        if (!started) {
            connection.destroy();
            return null;
        }
        counters.probeSuccesses += 1;
        connection.release();
        released = true;
        return true;
    } catch (error) {
        connection?.destroy();
        if (!started) return null;
        counters.probeFailures += 1;
        return false;
    } finally {
        if (deadline) clearTimeoutFn(deadline);
        // Failed/destroyed connections keep the marker until their end/error
        // listener removes it, so a late socket error cannot be mislabeled active.
        if (released && connection?.connection) {
            probeConnections.delete(connection.connection);
        }
    }
};

const runProbe = async () => {
    if (!started) return;
    if (leased.size > 0) return;

    const targetIntervalMs = state === 'degraded'
        ? degradedIntervalMs
        : quietIntervalMs;
    const remainingQuietMs = targetIntervalMs - (now() - lastActivityAt);
    if (remainingQuietMs > 0) {
        schedule(remainingQuietMs);
        return;
    }

    let succeeded = await pingOne();
    if (succeeded === null) return;
    if (!succeeded) {
        const retryAllowed = await waitForRetry();
        if (!retryAllowed || !started) return;
        succeeded = await pingOne();
        if (succeeded === null) return;
    }

    if (succeeded) {
        const recovered = state === 'degraded';
        state = 'healthy';
        lastSuccessAt = new Date(now()).toISOString();
        if (recovered) {
            logger?.info?.({
                event: 'database_runtime_recovered',
                probeAttempts: counters.probeAttempts,
                probeFailures: counters.probeFailures
            }, 'Database connection maintenance recovered.');
        }
        return;
    }

    lastFailureAt = new Date(now()).toISOString();
    if (state !== 'degraded') {
        logger?.warn?.({
            event: 'database_runtime_degraded',
            probeAttempts: counters.probeAttempts,
            probeFailures: counters.probeFailures
        }, 'Database connection maintenance is degraded.');
    }
    state = 'degraded';
};
```

Replace Task 1's lifecycle methods with:

```js
const start = () => {
    if (started) return false;
    started = true;
    state = 'healthy';
    lastSuccessAt = new Date(now()).toISOString();
    lastActivityAt = now();
    schedule(quietIntervalMs);
    return true;
};

const stop = async () => {
    if (!started && state === 'stopped') return;
    started = false;
    state = 'stopped';
    if (timer) clearTimeoutFn(timer);
    timer = null;
    cancelRetry();
    if (inFlightProbe) await inFlightProbe;
};
```

The queued-acquisition wrapper bounds only enqueued waiters; mysql2's existing `connectTimeout=10000` bounds a newly-created socket. `pingTimeoutMs` bounds a probe after acquisition. `stop()` waits for the actual probe to settle rather than racing `pool.end()` against an owned connection. The `started` checks after each awaited acquisition/ping destroy a late connection and prevent ping, retry, state transition, or rescheduling during shutdown. `server.js` receives a 15-second watchdog below so the 10-second acquisition bound retains cleanup margin.

Do not call `pool.query('SELECT 1')` from the keeper. Do not touch internal mysql2 queues such as `_freeConnections` in production code.

- [ ] **Step 6: Wire maintenance to server readiness and shutdown**

In `startServer()`, start maintenance only after both migration passes and `validateRequiredSchema(db)` succeed:

```js
startupStatus = 'ready';
db.databaseRuntime.start();
onServerStarted();
```

Immediately above `gracefulShutdown()`, define the fixed watchdog and replace the existing literal 10-second delay with it:

```js
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 15_000;

function gracefulShutdown(signal) {
    // existing receipt log unchanged
    const forceExitTimeout = setTimeout(() => {
        logger.error('Graceful shutdown timed out. Forcing process exit...');
        process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    // remainder below
}
```

Do not add an environment setting or a second maintenance watchdog. Fifteen seconds is deliberately above the existing 10-second connection handshake and the 3-second post-acquisition ping; after `stop()` flips `started=false`, those phases cannot chain into a retry.

At the start of `gracefulShutdown()`, after the existing receipt log and before closing Socket.IO, begin stopping maintenance so no new probe can start during HTTP drain:

```js
const databaseRuntimeStop = pool.databaseRuntime.stop();
```

Inside the existing `server.close()` database-cleanup `try`, settle that same promise immediately before the existing `pool.end()`. A maintenance-stop defect must be logged without error text or configuration, but must not prevent the pool itself from closing:

```js
try {
    await databaseRuntimeStop;
} catch (error) {
    logger.error({
        event: 'database_runtime_stop_failed',
        code: String(error?.code || 'UNKNOWN')
    }, 'Database connection maintenance did not stop cleanly.');
}
await pool.end();
```

If startup validation fails, the runtime was never started; the existing `db.end()` path remains valid. Do not alter the relative order of `listenForStartup`, migrations, validation, `startupStatus`, Socket.IO shutdown, HTTP shutdown, pool shutdown, or health responses.

Update `schemaAuthority.test.js` with source-order assertions:

```js
const readyIndex = server.indexOf("startupStatus = 'ready'");
const runtimeStartIndex = server.indexOf('db.databaseRuntime.start()');
const runtimeStopIndex = server.indexOf('pool.databaseRuntime.stop()');
const socketCloseIndex = server.indexOf('io.close()');
const runtimeStopAwaitIndex = server.indexOf('await databaseRuntimeStop');
const poolEndIndex = server.indexOf('pool.end()');

expect(runtimeStartIndex).toBeGreaterThan(readyIndex);
expect(runtimeStopIndex).toBeGreaterThan(-1);
expect(socketCloseIndex).toBeGreaterThan(runtimeStopIndex);
expect(runtimeStopAwaitIndex).toBeGreaterThan(socketCloseIndex);
expect(poolEndIndex).toBeGreaterThan(runtimeStopAwaitIndex);
expect(server).toContain('const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 15_000;');
expect(server).toContain('}, GRACEFUL_SHUTDOWN_TIMEOUT_MS);');
expect(server).toContain("db: 'connected'");
expect(server).toContain("status: 'ok'");
```

- [ ] **Step 7: Run Task 2 GREEN verification**

Run:

```powershell
npx vitest run backend/tests/unit/databasePoolOptions.test.js backend/tests/unit/databaseRuntime.test.js backend/tests/unit/databasePoolAcquireTimeout.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/unit/installerConfig.test.js
```

Expected: all selected files pass, fake timers leave no pending probe, and existing acquisition-timeout behavior remains green.

- [ ] **Step 8: Attack Task 2 before committing**

Confirm the named tests above and the Task 1 classification test directly cover these hostile checks; do not substitute manual reasoning for a missing assertion:

- `connectionLimit=1` does not produce `maxIdle=0`.
- One failed ping cannot return its connection to the pool.
- A timed-out ping destroys its connection.
- A probe error is counted as `probeDisconnects`, not `activeDisconnects`.
- A business connection error remains a warning.
- Repeated idle errors do not warn.
- Repeated degraded probes log one warning until recovery.
- An exception escaping normal probe logic is contained, marks the runtime degraded, logs only a redacted code once, and the following probe can recover; it never reaches the process-level `unhandledRejection` handler.
- `stop()` during retry delay prevents the replacement acquisition.
- `stop()` during a pending connection acquisition waits for that bounded acquisition and prevents ping/retry afterward.
- The fixed 15-second process watchdog remains above the existing 10-second connection handshake bound.
- Pool activity shortly before the timer delays the probe only for the remaining quiet interval.
- The keeper never calls `query` or `execute`.
- `start()` twice creates one scheduler.

Then run:

```powershell
git diff --check
```

- [ ] **Step 9: Commit Task 2**

```powershell
git add backend/config/databasePoolOptions.js backend/services/databaseRuntime.js backend/tests/unit/databasePoolOptions.test.js backend/tests/unit/databaseRuntime.test.js backend/tests/unit/schemaAuthority.test.js server.js
git commit -m "fix(database): manage idle connection lifecycle"
```

---

### Task 3: Verify Real-Pool Behavior and Record the Architecture Contract

**Files:**
- Create: `backend/tests/integration/databaseRuntime.test.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`
- Create: `docs/superpowers/evidence/2026-08-27-database-runtime-resilience-validation.md`

**Interfaces:**
- Consumes: completed Task 2 runtime.
- Produces: real-MariaDB proof of burst cleanup and continued query service, plus an updated architecture map.
- Does not produce a production deployment, production measurement, or canary approval.

- [ ] **Step 1: Write the real-pool integration test**

Create `backend/tests/integration/databaseRuntime.test.js`. Use `.env.test` through the existing test environment, create and close only its own pool, and do not create/drop/mutate application tables:

```js
const mysql = require('mysql2');
const { buildDatabasePoolOptions } = require('../../config/databasePoolOptions');
const { createDatabaseRuntime } = require('../../services/databaseRuntime');

async function waitUntil(predicate, timeoutMs = 1600) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Database runtime did not reach the expected quiet state.');
}

describe('database runtime integration', () => {
    it('retires burst connections, keeps one warm, and still serves SQL', async () => {
        const logger = {
            debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()
        };
        const runtime = createDatabaseRuntime({
            mysql,
            poolOptions: {
                ...buildDatabasePoolOptions(process.env),
                connectionLimit: 3,
                maxIdle: 2,
                idleTimeout: 700,
                gracefulEnd: true
            },
            logger,
            maintenance: {
                quietIntervalMs: 250,
                pingTimeoutMs: 100,
                retryDelayMs: 25,
                degradedIntervalMs: 100
            }
        });

        try {
            const burst = await Promise.all([
                runtime.pool.query('SELECT SLEEP(0.08) AS slept'),
                runtime.pool.query('SELECT SLEEP(0.08) AS slept'),
                runtime.pool.query('SELECT SLEEP(0.08) AS slept')
            ]);
            for (const [rows] of burst) {
                expect(Number(rows[0].slept)).toBe(0);
            }
            expect(runtime.snapshot().peakInUse).toBeGreaterThanOrEqual(2);

            runtime.start();
            await waitUntil(() => {
                const snapshot = runtime.snapshot();
                return snapshot.openConnections === 1 && snapshot.probeSuccesses >= 1;
            });

            expect(runtime.snapshot()).toMatchObject({
                inUse: 0,
                enqueued: 0,
                connectionErrors: 0,
                activeDisconnects: 0,
                state: 'healthy'
            });
            expect(runtime.snapshot().openConnections).toBe(1);
            expect(logger.warn).not.toHaveBeenCalled();
            expect(logger.error).not.toHaveBeenCalled();
            const [rows] = await runtime.pool.query('SELECT 7 AS ok');
            expect(Number(rows[0].ok)).toBe(7);
        } finally {
            await runtime.stop();
            await runtime.pool.end();
        }
    });
});
```

This deliberately tests the production policy shape (`maxIdle=2`) rather than the easier `maxIdle=1` case. Do not use `KILL`, global variables, schema DDL, or private mysql2 fields in the committed integration test.

- [ ] **Step 2: Run the integration test and existing acquisition test**

Run:

```powershell
npx vitest run backend/tests/integration/databaseRuntime.test.js backend/tests/integration/databasePoolAcquireTimeout.test.js
```

Expected: both files pass against local MariaDB; no handle remains open.

- [ ] **Step 3: Update architecture authority**

Update `docs/architecture.json` by stable IDs, not array indices:

- Retain `core-db` for the compatibility adapter and replace that node with this exact ownership:

```json
{
  "id": "core-db",
  "layer": "service",
  "label": "Database singleton adapter",
  "sub": "Loads database environment authority, refuses incomplete production credentials, constructs one DatabaseRuntime, and exports its unchanged mysql2 Promise-pool interface plus non-enumerable runtime and telemetry compatibility properties",
  "file": "backend/config/db.js"
}
```

- Insert this new node beside `core-db`; do not repoint `core-db` away from the file callers actually import:

```json
{
  "id": "core-database-runtime",
  "layer": "service",
  "label": "DatabaseRuntime",
  "sub": "Owns the single mysql2 pool, connection ceiling and idle capacity, UTC initialization, queued-acquisition timeout, one quiet bounded protocol ping, classified telemetry, and start/stop lifecycle without retrying business SQL",
  "file": "backend/services/databaseRuntime.js"
}
```

- Replace `inf-schema-gate.sub` with: `startServer() binds the port in starting state, then awaits automatic migrations and validateRequiredSchema before opening application traffic; validation throws SCHEMA_MIGRATION_REQUIRED`.
- In `flow-cold-boot`, keep steps 1-9 unchanged except step 2's label becomes: `backend/config/db loads the environment, constructs one DatabaseRuntime and exports its Promise pool; maintenance is not started by import`. Replace the old steps 10-11 with these exact steps:

```json
{
  "n": 10,
  "from": "inf-schema-gate",
  "to": "core-server",
  "label": "After validation succeeds, startupStatus becomes ready and application traffic may proceed",
  "file": "server.js"
},
{
  "n": 11,
  "from": "core-server",
  "to": "core-database-runtime",
  "label": "Only after startup is ready, server.js starts quiet database maintenance",
  "file": "server.js"
},
{
  "n": 12,
  "from": "core-server",
  "to": "inf-boot-jobs",
  "label": "onServerStarted fires static-menu generation, JoFotara polling and cleanup jobs",
  "file": "server.js"
}
```

- Add this exact flow object; there is no existing graceful-shutdown flow to update:

```json
{
  "id": "flow-graceful-shutdown",
  "label": "Graceful POS server shutdown",
  "actor": "actor-technician",
  "summary": "A process shutdown signal stops new database maintenance, drains network work, waits for the owned probe, then closes the single pool within a fixed 15-second watchdog.",
  "steps": [
    {
      "n": 1,
      "from": "actor-technician",
      "to": "core-server",
      "label": "SIGINT, SIGTERM, PM2 shutdown or a fatal process handler starts the fixed 15-second shutdown watchdog and begins DatabaseRuntime.stop()",
      "file": "server.js"
    },
    {
      "n": 2,
      "from": "core-server",
      "to": "core-socket",
      "label": "Socket.IO closes and the HTTP server drains in-flight requests",
      "file": "server.js"
    },
    {
      "n": 3,
      "from": "core-server",
      "to": "core-database-runtime",
      "label": "After HTTP drain, shutdown awaits the already-started runtime stop promise",
      "file": "server.js"
    },
    {
      "n": 4,
      "from": "core-server",
      "to": "core-db",
      "label": "Only after runtime maintenance settles, pool.end() drains and closes the single Promise pool",
      "file": "server.js"
    }
  ]
}
```

- Keep `inf-static-serving` and its `/health` plus `/api/health` database-readiness description unchanged.
- Remove the exact stale invariant `The POS server process never calls server.listen() before validateRequiredSchema(db) resolves successfully.` Add these exact invariants:
  - `The server may bind its port while startup status is starting, but all non-health HTTP requests and Socket.IO application work remain gated until migrations and validateRequiredSchema succeed.`
  - `DatabaseRuntime maintenance starts only after startup status is ready, stops before pool.end(), never retries business SQL, and owns at most one background probe.`

Regenerate and check:

```powershell
npm run architecture
npm run architecture:check
```

Expected: both commands exit zero and `docs/architecture.html` matches the JSON authority.

- [ ] **Step 4: Run the one focused final gate**

Run exactly:

```powershell
npx vitest run backend/tests/unit/databasePoolOptions.test.js backend/tests/unit/databaseRuntime.test.js backend/tests/unit/databasePoolAcquireTimeout.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/unit/installerConfig.test.js backend/tests/integration/databaseRuntime.test.js backend/tests/integration/databasePoolAcquireTimeout.test.js
npm run architecture:check
git diff --check
```

Expected: every selected test passes, architecture check exits zero, and diff check is clean. If a failure is outside this file list, stop and report it rather than expanding into the full suite automatically.

- [ ] **Step 5: Write the validation evidence**

Create `docs/superpowers/evidence/2026-08-27-database-runtime-resilience-validation.md` containing:

- Branch, the Task 2 base commit, and the runtime/architecture changed-file list used by the final gate. Do not claim the not-yet-created Task 3 commit hash tested itself.
- Exact focused commands and pass counts.
- Real-MariaDB version used locally.
- Before/after idle-cleaner experiment result.
- Measured local first-acquire/query/ping timings, explicitly labeled non-production.
- Explicit statement that no Hostinger deployment or production canary was performed.
- Production canary acceptance gates:
  - `enqueued` remains zero during ordinary venue work.
  - `acquired - released` returns to zero active leases after requests settle.
  - `activeDisconnects` remains zero.
  - Idle disconnect and created-connection rates fall substantially from the observed baseline of roughly 255/hour.
  - Checkout response latency does not regress.
  - PID and process uptime are tracked separately; database improvement is not claimed to resolve platform restarts.

- [ ] **Step 6: Commit Task 3**

After writing the evidence file, recheck the generated architecture and the complete diff without rerunning the tests:

```powershell
npm run architecture:check
git diff --check
git status --short
```

Expected: architecture and diff checks exit zero, and status lists only the four Task 3 files declared above. Then commit:

```powershell
git add backend/tests/integration/databaseRuntime.test.js docs/architecture.json docs/architecture.html docs/superpowers/evidence/2026-08-27-database-runtime-resilience-validation.md
git commit -m "test(database): verify runtime resilience"
```

## End-to-End Attack Checklist

Before declaring implementation complete, verify each statement directly against the final source and fresh outputs:

- [ ] `rg -n "createPool\(" backend server.js -g "*.js" -g "!backend/tests/**"` shows one production pool constructor.
- [ ] All existing `config/db` callers still receive the Promise pool; no route imports `databaseRuntime.js` directly.
- [ ] `pool.ping()` is never called; the keeper acquires a Promise connection and calls `connection.ping()`.
- [ ] Maintenance starts only after migrations and schema validation succeed.
- [ ] Tests and CLI migration imports do not start maintenance.
- [ ] Shutdown stops/settles the probe before ending the pool.
- [ ] Shutdown invokes `DatabaseRuntime.stop()`, explicitly awaits that same promise before `pool.end()`, and keeps the fixed watchdog at 15 seconds versus the 10-second handshake bound.
- [ ] An unexpected maintenance exception is caught at the scheduler boundary, exposes only a redacted code, leaves no unhandled rejection, and permits a later recovery probe.
- [ ] The keeper does not retry queries or transactions.
- [ ] `maxIdle` never exceeds `connectionLimit`, never becomes negative, and remains one when the connection limit is one.
- [ ] At most one probe and one bounded replacement attempt can exist.
- [ ] Idle resets do not emit warning spam; active resets remain immediately visible.
- [ ] Snapshot and logs contain no credentials, SQL, query values, or customer data.
- [ ] `/health` and `/api/health` still prove database readiness and keep their response fields.
- [ ] Installer/update/repair/spooler health consumers require no changes.
- [ ] Architecture JSON describes actual boot order rather than the stale pre-listen invariant.
- [ ] Architecture retains `core-db` as the imported singleton adapter, adds `core-database-runtime`, and includes the exact `flow-graceful-shutdown` lifecycle.
- [ ] No schema, dependency, version, installer, spooler, Hostinger environment, deployment, merge, or push change appears in the diff.

## Definition of Done

- Three task commits exist in order and contain only the declared scope.
- The focused tests pass against the final runtime code; after the evidence file is written, architecture and diff checks pass against the exact tree Task 3 commits.
- The working tree is clean except for explicitly pre-existing user files.
- Automated evidence proves local driver/runtime behavior; it does not claim a production fix before a separately authorized Hostinger canary.
- A real MySQL service restart or Hostinger Node-process restart remains an acknowledged external failure class rather than being hidden by retries or mislabeled as solved.
