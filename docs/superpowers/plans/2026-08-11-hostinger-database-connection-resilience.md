# Hostinger Database Connection Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `ER_USER_LIMIT_REACHED` on Hostinger without delaying or duplicating printing, while retaining a safe HTTP recovery path when Socket.IO cannot connect.

**Architecture:** Use Hostinger's local MySQL path and one bounded reusable mysql2 pool. Preserve WebSocket as the spooler's first transport, add Socket.IO's supported HTTP-polling fallback, and keep the custom `/api/spooler/poll` route only as an adaptive last-resort transport driven by server-provided delays. Add process-local connection telemetry so future connection churn is visible without exposing credentials or customer data.

**Tech Stack:** Node.js 20, Express 5, mysql2 3.20, Socket.IO 4.8, Vitest 4, Node `assert`, Hostinger managed Node.js/MySQL.

## Global Constraints

- Do not add database tables, migrations, queues, workers, Redis, process managers, or new dependencies.
- Do not change print queue ownership, idempotency keys, acknowledgement states, dead-letter rules, station ownership, or physical-print retry semantics.
- Socket-connected print delivery remains immediate. Socket.IO HTTP long-polling is a connected transport and must also receive pushed jobs immediately; it is not the custom periodic fallback.
- The custom HTTP fallback remains available, but only while Socket.IO is disconnected. It must never overlap itself, spin every second while idle, or continue after a successful Socket.IO connection.
- Preserve WebSocket-first connection behavior with `transports: ['websocket', 'polling']`, `tryAllTransports: true`, and a 5-second connection-attempt timeout. Do not switch healthy clients to polling-first. The first custom REST recovery probe occurs 1 second after Socket.IO reports a failed/disconnected attempt; only subsequent empty REST responses wait 5 seconds.
- A fallback request containing jobs may run again after 1 second. An empty response uses the server's `next_poll_ms` with a 3–30 second clamp. Failures back off 5, 10, 20, then 30 seconds plus bounded jitter.
- Authentication failures (`401` or `403`) permanently disable fallback until process restart. `429`, `5xx`, timeouts, and network failures back off and retry.
- Every fallback HTTP request has a 10-second abort timeout. A late response from an obsolete scheduler generation must not re-arm polling.
- The app keeps one shared mysql2 pool. Production defaults are `connectionLimit=10`, `maxIdle=10`, `queueLimit=50`, keep-alive enabled, and a 10-second connect timeout. Explicit valid environment overrides remain supported.
- The operator-approved Hostinger environment must use the explicit IPv4 loopback `DB_HOST=127.0.0.1`, `DB_CONNECTION_LIMIT=10`, and `DB_QUEUE_LIMIT=50`. `localhost` previously failed on this deployment, so it is not an approved fallback. Environment changes are never applied by the implementation agent; hand the exact non-secret delta to the user for hPanel entry.
- The credentials pasted into the conversation are treated as exposed. Rotation is an operational follow-up and must be coordinated so the server and installed spooler receive matching replacements; never rotate during implementation tests.
- `/health` and `/api/health` retain their current database-readiness contracts because installers and update verification depend on `db=connected`.
- All behavior changes are test-first. Do not deploy, restart Hostinger, rebuild installers, rotate secrets, or push unless separately authorized.
- Delivery identity is part of correctness: bump the server source authorities from `1.0.3` to `1.0.4` and the spooler source authorities from `1.2.3` to `1.2.4`. Do not compile installers in this plan. An installed 1.2.3 spooler will retain the old one-second fallback until the separately authorized 1.2.4 updater is built and installed.

## Evidence and decisions

- Hostinger's generic guide specifies a local loopback connection and documents `localhost`: <https://www.hostinger.com/support/connecting-a-hostinger-mysql-database-to-a-node-js-application/>. This deployment has stronger observed evidence: the hostname form failed, so the approved equivalent is explicit IPv4 loopback `127.0.0.1`.
- Hostinger's exact error guide says to replace a remote hosting address with a local connection and notes that killing processes is only temporary: <https://www.hostinger.com/support/4274567-how-to-fix-the-max_connections_per_hour-mysql-error-at-hostinger/>. The user, not the agent, owns the corresponding hPanel environment change.
- MySQL counts new sessions per account for `MAX_CONNECTIONS_PER_HOUR`; it is not a query count or a simultaneous-connection count: <https://dev.mysql.com/doc/refman/9.7/en/user-resources.html>.
- mysql2 pools are lazy and reuse existing connections. Its documented pool options include `connectionLimit`, `maxIdle`, `idleTimeout`, `queueLimit`, and TCP keep-alive: <https://sidorares.github.io/node-mysql2/docs>.
- Socket.IO supports both WebSocket and HTTP long-polling, and v4.8 supports trying all configured transports. The current spooler enables WebSocket only; the reviewed design keeps WebSocket first and adds polling second instead of changing the healthy path: <https://socket.io/docs/v4/client-options/#transports>.
- Current custom fallback runs every second but ignores the route's `next_poll_ms`. It therefore performs up to 3,600 DB-backed poll requests per disconnected spooler per hour.
- The updater refuses same-version/different-commit payloads as `blocked_version_collision`. The current release authorities are server `1.0.3` and spooler `1.2.3`, so source-only changes without version bumps would be operationally undeliverable to already-installed clients.
- Runtime source audit found one application pool (`backend/config/db.js`). Other `createConnection`/`createPool` calls belong to explicit installer, migration, validation, or test processes rather than request/print timers. The periodic print processors query through the shared pool; they are query sources, not independent connection factories.

## File structure

- Create `backend/config/databasePoolOptions.js`: pure environment-to-mysql2 option normalization; no connections and no logging.
- Modify `backend/config/db.js`: create the existing singleton pool from normalized options and attach safe process-local telemetry.
- Create `backend/services/databasePoolTelemetry.js`: observe pool lifecycle events and expose counters/log thresholds without secrets.
- Create `deployment/templates/hostinger.env.template`: secret-free authority for future Hostinger restaurant deployments.
- Create `backend/tests/unit/databasePoolOptions.test.js`: option validation and finite-queue tests.
- Create `backend/tests/unit/databasePoolTelemetry.test.js`: connection churn and redacted logging tests.
- Create `pos-spooler-printer/poll-fallback.js`: the small adaptive scheduler; it owns timers/backoff only, not printing or queue state.
- Modify `pos-spooler-printer/server.js`: allow Socket.IO's normal transports and delegate custom fallback scheduling.
- Create `pos-spooler-printer/tests/poll-fallback.test.js`: deterministic fake-clock scheduler tests.
- Modify `pos-spooler-printer/tests/run-tests.js`: no logic change expected; its file discovery automatically includes the new test.
- Modify `backend/routes/spooler.js`: return authoritative bounded delay and optional retry guidance; keep claim/ack behavior unchanged.
- Modify `backend/tests/integration/spoolerPoll.test.js`: pin idle/busy response timing and durable lifecycle behavior.
- Create `backend/tests/integration/spoolerSocketTransport.test.js`: prove HTTP-polling Socket.IO push is immediate and duplicate-safe.
- Modify `backend/tests/unit/spoolerPackageContract.test.js`: require the new scheduler/test in the tracked spooler package.
- Modify `package.json`, `package-lock.json`, and `deployment/server/POSAPP-Server.iss`: bump the server delivery identity to `1.0.4` without building artifacts.
- Modify `pos-spooler-printer/package.json`, `pos-spooler-printer/package-lock.json`, and `deployment/spooler/POSAPP-Spooler.iss`: bump the spooler delivery identity to `1.2.4` so installed 1.2.3 clients can actually receive the scheduler fix.
- Modify `docs/architecture.json` and regenerate `docs/architecture.html`: record local Hostinger DB configuration, adaptive fallback, and telemetry.

---

### Task 1: Make database pool configuration safe and observable

**Files:**
- Create: `backend/config/databasePoolOptions.js`
- Create: `backend/services/databasePoolTelemetry.js`
- Modify: `backend/config/db.js`
- Create: `deployment/templates/hostinger.env.template`
- Create: `backend/tests/unit/databasePoolOptions.test.js`
- Create: `backend/tests/unit/databasePoolTelemetry.test.js`

**Interfaces:**
- Produces: `buildDatabasePoolOptions(env): mysql2.PoolOptions`.
- Produces: `attachDatabasePoolTelemetry(pool, { logger, warningThreshold }): { snapshot(): PoolTelemetrySnapshot }`.
- `PoolTelemetrySnapshot` is `{ created, acquired, released, enqueued, connectionErrors }`; it never contains host, user, password, database, SQL, or request data.
- Preserves: `require('../config/db')` continues returning the mysql2 promise pool used throughout the app.

- [ ] **Step 1: Write failing option tests**

Create `backend/tests/unit/databasePoolOptions.test.js`:

```js
const { buildDatabasePoolOptions } = require('../../config/databasePoolOptions');

describe('database pool options', () => {
    const credentials = {
        DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_USER: 'app',
        DB_PASSWORD: 'secret', DB_NAME: 'pos'
    };

    it('uses a bounded reusable production pool', () => {
        expect(buildDatabasePoolOptions(credentials)).toMatchObject({
            host: '127.0.0.1', port: 3306, connectionLimit: 10, maxIdle: 10,
            queueLimit: 50, enableKeepAlive: true, keepAliveInitialDelay: 0,
            connectTimeout: 10000
        });
    });

    it('honors small valid overrides without allowing an unbounded queue', () => {
        expect(buildDatabasePoolOptions({
            ...credentials, DB_CONNECTION_LIMIT: '5', DB_QUEUE_LIMIT: '0'
        })).toMatchObject({ connectionLimit: 5, maxIdle: 5, queueLimit: 50 });
    });

    it.each([
        ['DB_CONNECTION_LIMIT', 'abc'], ['DB_CONNECTION_LIMIT', '0'],
        ['DB_QUEUE_LIMIT', '-1'], ['DB_PORT', 'invalid']
    ])('fails closed for invalid %s=%s', (key, value) => {
        expect(() => buildDatabasePoolOptions({ ...credentials, [key]: value }))
            .toThrow(/Invalid database configuration/);
    });
});
```

- [ ] **Step 2: Write failing telemetry tests**

Create `backend/tests/unit/databasePoolTelemetry.test.js` with an `EventEmitter` fake pool. Assert one `connection` increments `created`, repeated `acquire`/`release` do not increment it, a connection `error` increments only `connectionErrors`, warning threshold logs exactly once per threshold crossing, and serialized log arguments do not contain the supplied fake password/host/database strings.

- [ ] **Step 3: Run RED tests**

Run:

```powershell
npx vitest run backend/tests/unit/databasePoolOptions.test.js backend/tests/unit/databasePoolTelemetry.test.js
```

Expected: FAIL because both modules are absent.

- [ ] **Step 4: Implement pure option normalization**

Create `backend/config/databasePoolOptions.js` with explicit integer parsing:

```js
function requiredInteger(name, raw, fallback, { min = 1, max = 100000 } = {}) {
    const value = raw === undefined || raw === null || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`Invalid database configuration: ${name} must be an integer from ${min} to ${max}.`);
    }
    return value;
}

function buildDatabasePoolOptions(env = process.env) {
    const connectionLimit = requiredInteger('DB_CONNECTION_LIMIT', env.DB_CONNECTION_LIMIT || env.DB_POOL_MAX, 10, { max: 100 });
    const configuredQueue = requiredInteger('DB_QUEUE_LIMIT', env.DB_QUEUE_LIMIT, 50, { min: 0, max: 10000 });
    return {
        host: env.DB_HOST || '127.0.0.1',
        user: env.DB_USER || 'root',
        password: env.DB_PASSWORD || '',
        database: env.DB_NAME || 'posapp',
        port: requiredInteger('DB_PORT', env.DB_PORT, 3306, { max: 65535 }),
        timezone: 'Z',
        waitForConnections: true,
        connectionLimit,
        maxIdle: connectionLimit,
        queueLimit: configuredQueue === 0 ? 50 : configuredQueue,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        connectTimeout: 10000
    };
}

module.exports = { buildDatabasePoolOptions, requiredInteger };
```

Do not add Hostinger-specific hostname rewriting in application code. `127.0.0.1` is an operator-owned deployment value; external MySQL remains a valid supported topology elsewhere.

- [ ] **Step 5: Implement safe telemetry and wire the singleton pool**

Create `backend/services/databasePoolTelemetry.js`. Count pool events, attach one `error` listener to each newly-created connection, log only `{ event, created, acquired, released, enqueued, connectionErrors, pid, uptime_seconds }`, and warn at 25 then every additional 25 created connections. Return immutable snapshots.

Use this implementation shape so attaching twice cannot double-count:

```js
const TELEMETRY = Symbol.for('posapp.databasePoolTelemetry');

function attachDatabasePoolTelemetry(pool, { logger, warningThreshold = 25 } = {}) {
    if (pool[TELEMETRY]) return pool[TELEMETRY];
    const counters = { created: 0, acquired: 0, released: 0, enqueued: 0, connectionErrors: 0 };
    let warnedBucket = 0;
    const snapshot = () => Object.freeze({ ...counters });
    const context = (event, extra = {}) => ({
        event, ...snapshot(), pid: process.pid,
        uptime_seconds: Math.floor(process.uptime()), ...extra
    });

    pool.on('connection', (connection) => {
        counters.created += 1;
        const bucket = Math.floor(counters.created / warningThreshold);
        if (bucket > warnedBucket) {
            warnedBucket = bucket;
            logger?.warn(context('database_pool_connection_churn'), 'Database pool created many connections in one process lifetime.');
        }
        connection.on('error', (error) => {
            counters.connectionErrors += 1;
            logger?.warn(context('database_pool_connection_error', {
                code: String(error?.code || 'UNKNOWN'), fatal: Boolean(error?.fatal)
            }), 'Database pool connection error.');
        });
    });
    pool.on('acquire', () => { counters.acquired += 1; });
    pool.on('release', () => { counters.released += 1; });
    pool.on('enqueue', () => { counters.enqueued += 1; });

    const telemetry = Object.freeze({ snapshot });
    Object.defineProperty(pool, TELEMETRY, { value: telemetry });
    return telemetry;
}

module.exports = { attachDatabasePoolTelemetry };
```

Modify `backend/config/db.js` to call `mysql.createPool(buildDatabasePoolOptions(process.env))`, preserve the UTC session initialization, and attach telemetry with the existing logger. Export the same pool object; attach only a non-enumerable `connectionTelemetrySnapshot` function so existing imports remain unchanged.

- [ ] **Step 6: Add safe environment authorities**

Create `deployment/templates/hostinger.env.template` containing names/placeholders only:

```dotenv
NODE_ENV=production
PORT=3100
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME={{DB_NAME}}
DB_USER={{DB_USER}}
DB_PASSWORD={{DB_PASSWORD}}
DB_CONNECTION_LIMIT=10
DB_QUEUE_LIMIT=50
ENFORCE_HTTPS=true
FORM_BODY_LIMIT=1mb
JSON_BODY_LIMIT=2mb
LOG_LEVEL=info
SESSION_IDLE_TIMEOUT_MS=1800000
SPOOLER_KEY={{SPOOLER_KEY}}
```

No real domain, username, password, or key may appear in the template.

- [ ] **Step 7: Run GREEN tests and hygiene checks**

Run:

```powershell
npx vitest run backend/tests/unit/databasePoolOptions.test.js backend/tests/unit/databasePoolTelemetry.test.js backend/tests/unit/pendingMigrationCli.test.js
git diff --check
```

Expected: all pass; no secret values appear in `git diff` or `git grep`.

- [ ] **Step 8: Commit Task 1**

```powershell
git add deployment/templates/hostinger.env.template backend/config/databasePoolOptions.js backend/config/db.js backend/services/databasePoolTelemetry.js backend/tests/unit/databasePoolOptions.test.js backend/tests/unit/databasePoolTelemetry.test.js
git commit -m "fix: bound hosted database connections"
```

---

### Task 2: Replace one-second spooler fallback with an adaptive scheduler

**Files:**
- Create: `pos-spooler-printer/poll-fallback.js`
- Create: `pos-spooler-printer/tests/poll-fallback.test.js`
- Modify: `pos-spooler-printer/server.js`
- Modify: `pos-spooler-printer/tests/external-config.test.js`
- Modify: `backend/tests/unit/spoolerPackageContract.test.js`
- Modify: `pos-spooler-printer/package.json`
- Modify: `pos-spooler-printer/package-lock.json`
- Modify: `deployment/spooler/POSAPP-Spooler.iss`

**Interfaces:**
- Produces: `createPollFallbackScheduler({ poll, isSocketConnected, setTimeoutFn, clearTimeoutFn, random, onError }): { start(), stop(), disable(), snapshot() }`.
- `poll({ signal })` resolves `{ jobsCount, nextPollMs }` or rejects with an error carrying optional `status`. The scheduler owns and aborts the request signal.
- Scheduler owns timing only. `processIncomingPrintJob`, HTTP ACK, `DurableSeenStore`, and print queue state remain in `server.js`.

- [ ] **Step 1: Write deterministic RED scheduler tests**

Create `pos-spooler-printer/tests/poll-fallback.test.js` using Node `assert` and a fake timer queue. Cover all of these cases:

1. `start()` schedules one 1000 ms recovery timer and repeated `start()` does not duplicate it.
2. Empty success respects server `nextPollMs=5000`.
3. A response with jobs schedules 1000 ms.
4. Server delays below 3000 or above 30000 are clamped.
5. Failures schedule 5, 10, 20, and 30 seconds before jitter; success resets the failure count.
6. `401` and `403` disable permanently; `429` and `503` back off.
7. `stop()` prevents a late in-flight result from scheduling another timer by changing the scheduler generation.
8. `isSocketConnected() === true` stops fallback immediately.
9. Only one `poll()` may be in flight.
10. `snapshot()` contains state/counters only and no key or URL.

- [ ] **Step 2: Run the spooler RED test**

```powershell
node pos-spooler-printer/tests/poll-fallback.test.js
```

Expected: FAIL because `poll-fallback.js` does not exist.

- [ ] **Step 3: Implement the scheduler**

Implement the interface above in `pos-spooler-printer/poll-fallback.js`. Use recursive `setTimeout`, not `setInterval`. Clamp server delays, use `Math.min(30000, 5000 * (2 ** failureCount))`, apply at most ±10% jitter, and guard every completion with the captured generation. `disable()` calls `stop()` and prevents future `start()` calls.

Use one generation and one abort controller as the concurrency authority:

```js
const MIN_IDLE_MS = 3000;
const MAX_DELAY_MS = 30000;
const BUSY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 10000;

function clampDelay(value, fallback = 5000) {
    const parsed = Number(value);
    return Math.max(MIN_IDLE_MS, Math.min(MAX_DELAY_MS,
        Number.isFinite(parsed) ? parsed : fallback));
}

function createPollFallbackScheduler({
    poll, isSocketConnected, setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout, random = Math.random,
    onError = () => {}, graceMs = 1000
}) {
    let timer = null;
    let controller = null;
    let active = false;
    let disabled = false;
    let generation = 0;
    let consecutiveErrors = 0;
    let requests = 0;

    const clearScheduled = () => {
        if (timer) clearTimeoutFn(timer);
        timer = null;
    };

    const schedule = (delay, currentGeneration) => {
        if (!active || disabled || currentGeneration !== generation) return;
        clearScheduled();
        timer = setTimeoutFn(() => tick(currentGeneration), delay);
    };

    const stop = () => {
        active = false;
        generation += 1;
        clearScheduled();
        controller?.abort();
        controller = null;
    };

    const disable = () => {
        disabled = true;
        stop();
    };

    const tick = async (currentGeneration) => {
        timer = null;
        if (!active || disabled || currentGeneration !== generation) return;
        if (isSocketConnected()) return stop();
        controller = new AbortController();
        const requestController = controller;
        const requestTimeout = setTimeoutFn(() => requestController.abort(), REQUEST_TIMEOUT_MS);
        requests += 1;
        try {
            const result = await poll({ signal: requestController.signal });
            if (!active || currentGeneration !== generation) return;
            consecutiveErrors = 0;
            schedule(Number(result?.jobsCount) > 0 ? BUSY_DELAY_MS : clampDelay(result?.nextPollMs), currentGeneration);
        } catch (error) {
            if (!active || currentGeneration !== generation) return;
            if (error?.status === 401 || error?.status === 403) return disable();
            consecutiveErrors += 1;
            const base = Math.min(MAX_DELAY_MS, 5000 * (2 ** (consecutiveErrors - 1)));
            const jittered = Math.round(base * (0.9 + (random() * 0.2)));
            onError(error, { consecutiveErrors, nextPollMs: jittered });
            schedule(jittered, currentGeneration);
        } finally {
            clearTimeoutFn(requestTimeout);
            if (controller === requestController) controller = null;
        }
    };

    const start = () => {
        if (disabled || active || isSocketConnected()) return false;
        active = true;
        generation += 1;
        const initialDelay = Math.max(0, Math.min(5000, Number(graceMs) || 1000));
        schedule(initialDelay, generation);
        return true;
    };

    return Object.freeze({
        start, stop, disable,
        snapshot: () => Object.freeze({ active, disabled, consecutiveErrors, requests, scheduled: Boolean(timer) })
    });
}

module.exports = { createPollFallbackScheduler, clampDelay };
```

During implementation, keep `tick` declared before any timer can call it (a function declaration is acceptable). Tests must prove aborting an obsolete generation cannot schedule again.

- [ ] **Step 4: Enable Socket.IO's supported transport fallback**

In `pos-spooler-printer/server.js`, replace the WebSocket-only option with:

```js
transports: ['websocket', 'polling'],
tryAllTransports: true,
timeout: 5000,
```

Keep the existing authentication, reconnection, backoff, and extra headers. This preserves the currently healthy WebSocket-first path and permits Socket.IO polling when WebSocket is blocked. HTTP polling may require sticky routing on multi-instance servers; if Hostinger does not provide affinity, the connection must fail into the same adaptive REST fallback rather than disabling printing.

Wrap the custom fetch in a 10-second `AbortController`. Convert the HTTP result into `{ jobsCount: jobs.length, nextPollMs: payload.next_poll_ms }`, preserve 401/403 fail-closed behavior, and delegate scheduling to the new module. On `connect`, stop the scheduler. On `disconnect` or non-authentication `connect_error`, start it. On `spooler_rejected`, disable it.

Do not change `processIncomingPrintJob` or acknowledgement payloads.

- [ ] **Step 5: Strengthen package contracts**

Update `backend/tests/unit/spoolerPackageContract.test.js` to require tracked files `poll-fallback.js` and `tests/poll-fallback.test.js`.

Update `pos-spooler-printer/tests/external-config.test.js` to assert:

```js
assert(source.includes("transports: ['websocket', 'polling']"));
assert(source.includes('tryAllTransports: true'));
assert(source.includes('timeout: 5000'));
assert(source.includes('createPollFallbackScheduler'));
assert(source.includes('AbortController'));
assert(!source.includes('setInterval(runPollFallbackOnce, 1000)'));
```

Update the spooler package contract to expect version `1.2.4`. Set that exact version in both the package manifest and its lockfile, and update the `.iss` fallback `AppVersion` to `1.2.4`. This is required because `InstallerUpdateState.ps1` rejects same-version/different-commit updates. Do not edit generated update payloads and do not run the installer build here.

- [ ] **Step 6: Run GREEN spooler tests**

```powershell
node pos-spooler-printer/tests/poll-fallback.test.js
npm --prefix pos-spooler-printer test
npx vitest run backend/tests/unit/spoolerPackageContract.test.js
```

Expected: all pass; existing durable seen-store, payload integrity, rendering, and printer tests remain green.

- [ ] **Step 7: Commit Task 2**

```powershell
git add pos-spooler-printer/poll-fallback.js pos-spooler-printer/server.js pos-spooler-printer/tests/poll-fallback.test.js pos-spooler-printer/tests/external-config.test.js pos-spooler-printer/package.json pos-spooler-printer/package-lock.json deployment/spooler/POSAPP-Spooler.iss backend/tests/unit/spoolerPackageContract.test.js
git commit -m "fix: back off disconnected spooler polling"
```

---

### Task 3: Prove fallback timing and immediate Socket.IO polling delivery

**Files:**
- Modify: `backend/routes/spooler.js`
- Modify: `backend/tests/integration/spoolerPoll.test.js`
- Create: `backend/tests/integration/spoolerSocketTransport.test.js`

**Interfaces:**
- `/api/spooler/poll` continues returning `{ success, jobs, next_poll_ms }`.
- Busy response: `next_poll_ms=1000`; idle response: `next_poll_ms=5000`.
- Socket.IO polling transport uses the existing spooler authentication and existing `print_job` event; no parallel queue lifecycle is introduced.

- [ ] **Step 1: Write RED HTTP timing assertions**

Extend `backend/tests/integration/spoolerPoll.test.js` with an empty-queue request asserting exactly `next_poll_ms === 5000`, and change the pending-job assertion to exactly `1000`. Add a retry assertion proving a second poll cannot reclaim a job already marked `sent` by the first poll.

- [ ] **Step 2: Write a RED Socket.IO polling integration test**

Create `backend/tests/integration/spoolerSocketTransport.test.js`:

- Seed the DB and a printer owned by `polling-spooler`.
- Insert one pending queue job before connecting.
- Start the existing HTTP/Socket.IO server on an ephemeral port.
- Connect `socket.io-client` with `transports: ['polling']`, valid spooler auth, and reconnection disabled.
- Race receipt of `print_job` against a 2-second timeout. The event must arrive without waiting for the 5-second custom fallback interval.
- Emit a successful `print_job_response` and assert the row becomes `acknowledged`.
- Disconnect and reconnect the same spooler; assert the acknowledged job is not emitted again during a 250 ms observation window.
- Close the client, Socket.IO server, HTTP server, and DB pool in `finally`/`afterAll` so the test cannot hang.

- [ ] **Step 3: Run RED integration tests**

```powershell
npx vitest run backend/tests/integration/spoolerPoll.test.js backend/tests/integration/spoolerSocketTransport.test.js
```

Expected: idle-delay assertion fails at 3000 and the new transport test identifies any polling/auth/lifecycle incompatibility.

- [ ] **Step 4: Implement authoritative server delay**

In `backend/routes/spooler.js`, change only:

```js
next_poll_ms: jobs.length > 0 ? 1000 : 5000
```

Do not change the current rate limit, authentication, claimant ID, transaction, `markPrintJobsSent`, or ACK behavior.

- [ ] **Step 5: Run GREEN integration and print queue tests**

```powershell
npx vitest run backend/tests/integration/spoolerPoll.test.js backend/tests/integration/spoolerSocketTransport.test.js backend/tests/integration/printQueue.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/spoolerRegistry.test.js
```

Expected: all pass. Socket.IO polling delivery completes inside the 2-second ceiling, proving there is no 5-second print delay on the connected fallback transport.

- [ ] **Step 6: Commit Task 3**

```powershell
git add backend/routes/spooler.js backend/tests/integration/spoolerPoll.test.js backend/tests/integration/spoolerSocketTransport.test.js
git commit -m "test: prove resilient spooler delivery"
```

---

### Task 4: Document the runtime flow and perform adversarial verification

**Files:**
- Modify: `docs/architecture.json`
- Generate: `docs/architecture.html`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `deployment/server/POSAPP-Server.iss`
- Modify: `backend/tests/unit/installerPackageContract.test.js`
- Modify: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**
- Architecture continues to state that Socket and HTTP fallback share `claimPrintJobs`, `markPrintJobsSent`, and `settlePrintJob`.
- Add the distinction between Socket.IO's connected HTTP-polling transport and the custom disconnected REST fallback.
- Add the singleton-pool telemetry and operator-approved Hostinger `127.0.0.1` deployment invariant without naming a real account or domain.

- [ ] **Step 1: Update architecture evidence**

Update the MySQL pool node, health endpoint description, spooler handshake flow, and HTTP fallback flow. Record these invariants:

- This Hostinger topology uses explicit IPv4 loopback `127.0.0.1`; remote hosts remain supported for external DB deployments, and the application never rewrites the operator's value.
- One singleton pool is reused; created-connection telemetry is process-local and redacted.
- WebSocket remains first. Socket.IO polling is connected push delivery and does not wait for custom fallback timers.
- The REST fallback is adaptive, single-flight, timeout-bounded, generation-safe, and shares the durable queue state machine.

- [ ] **Step 2: Bump and pin the server delivery identity**

Write a RED contract assertion that the root package and server installer fallback version are both `1.0.4`, while the spooler package and installer remain `1.2.4`. Update only the source authorities:

- `package.json` and the two root entries in `package-lock.json`: `1.0.4`.
- `deployment/server/POSAPP-Server.iss` fallback `AppVersion`: `1.0.4`.
- Existing updater/package contracts: assert server `1.0.4`, spooler `1.2.4`, and preserve `blocked_version_collision` behavior.

Do not run `npm run build:installers`; the separate operator handoff owns compilation after source approval.

- [ ] **Step 3: Regenerate and validate architecture**

```powershell
npm run architecture
npm run architecture:check
```

Expected: generated HTML matches JSON and all referenced file/line targets are valid.

- [ ] **Step 4: Verify release and updater contracts without building installers**

```powershell
npx vitest run backend/tests/unit/spoolerPackageContract.test.js backend/tests/unit/installerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js
```

Expected: all pass; `blocked_version_collision` remains enforced, and the two new source version identities are internally consistent.

- [ ] **Step 5: Run the focused regression matrix once**

```powershell
npx vitest run backend/tests/unit/databasePoolOptions.test.js backend/tests/unit/databasePoolTelemetry.test.js backend/tests/unit/pendingMigrationCli.test.js backend/tests/unit/spoolerPackageContract.test.js backend/tests/unit/installerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/printQueueWatchdog.test.js backend/tests/unit/spoolerRegistry.test.js backend/tests/integration/spoolerPoll.test.js backend/tests/integration/spoolerSocketTransport.test.js backend/tests/integration/printQueue.test.js backend/tests/integration/printQueueHealthApi.test.js
npm --prefix pos-spooler-printer test
npm run build
npm run architecture:check
git diff --check
```

Expected: all focused tests pass, spooler package tests pass, production build passes, architecture passes, and diff hygiene is clean. Do not rerun the whole repository suite unless these focused tests expose a shared regression.

- [ ] **Step 6: Perform manual adversarial probes without production mutation**

Using a local test server and fake printer/spooler only, verify:

1. WebSocket available: job event is immediate and REST fallback performs zero calls.
2. WebSocket blocked but Socket.IO polling allowed: job event remains immediate and REST fallback performs zero calls.
3. All Socket.IO transports blocked: REST calls occur after grace, idle at 5 seconds, and never overlap.
4. REST fetch hangs: abort at 10 seconds, then back off; scheduler remains live.
5. Server returns 429/500: no spin loop; recovery resets backoff.
6. Server returns 401/403: polling stops until service restart.
7. Socket connects while REST request is in flight: late REST response cannot re-arm the timer or duplicate a print.
8. Spooler restarts after `seenStore.begin`: uncertain kitchen job remains dead-letter/manual, unchanged from current safety policy.
9. Pool performs 1,000 sequential `SELECT 1` operations against a local scratch DB: created-connection telemetry stays bounded by the configured pool and does not grow per query.
10. Simulated 20 concurrent DB tasks with pool limit 10: no more than 10 connections are created; the finite queue drains, and overload fails rather than growing without bound.

- [ ] **Step 7: Scan for scope drift and secret leakage**

```powershell
git diff --stat HEAD~4..HEAD
git diff --check HEAD~4..HEAD
git grep -n -E "auth-db[0-9]+\.hstgr\.io|u[0-9]+_hashemi|DB_PASSWORD=.+|SPOOLER_KEY=.+" -- ':!*.example' ':!*.template'
```

Expected: only the files listed in this plan changed; the secret scan returns no newly tracked secret. Inspect the entire four-commit diff for changes to queue state, printer routing, payload identity, checkout, JoFotara, migrations, or database schema; there must be none.

- [ ] **Step 8: Commit Task 4**

```powershell
git add package.json package-lock.json deployment/server/POSAPP-Server.iss backend/tests/unit/installerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js docs/architecture.json docs/architecture.html
git commit -m "chore: prepare resilient runtime release"
```

---

## Hostinger canary and operational handoff — separate authorization required

Do not perform this section merely by executing the source plan. It mutates the named production deployment and secrets.

1. The implementation agent gives the user this exact non-secret hPanel delta and performs no environment mutation: `DB_HOST: <current remote value> -> 127.0.0.1`, `DB_QUEUE_LIMIT: 0 -> 50`, `DB_CONNECTION_LIMIT: keep 10`.
2. The user applies the delta and restarts/redeploys the application once. Do not repeatedly restart while diagnosing an hourly connection limit.
3. Verify `/api/health` reports `UP` and `database=CONNECTED`. This configuration-only repair does not require waiting for the source implementation.
4. After the source commits are separately approved, deploy server `1.0.4`; verify `/api/health` and the release identity again.
5. Separately build the spooler updater from the approved commit and install version `1.2.4` on the client. Do not judge adaptive fallback behavior while self-status still reports `1.2.3`.
6. Connect one real 1.2.4 spooler and verify its server self-status reports connected. Print one receipt and one kitchen ticket, then verify both queue rows acknowledge once.
7. Observe runtime logs for at least 15 minutes. `database_pool_connection_created` must remain low and stable rather than climbing with queries.
8. Temporarily interrupt the spooler's WebSocket path only if a controlled method exists. Confirm Socket.IO polling remains connected or REST fallback backs off; do not disrupt restaurant service for this test.
9. Keep the previous deployment archive and old non-secret environment shape available for rollback. If `127.0.0.1` cannot connect, the user decides whether to restore the prior host; the agent only reports the exact failure and evidence. Do not try `localhost` automatically.
10. After stability is proven, rotate the exposed database password through Hostinger and update the app atomically. Rotate the exposed spooler key only in a coordinated maintenance window that updates the server and every installed spooler; mismatched keys intentionally stop printing.

## Plan self-review and break analysis

The following initially attractive changes are explicitly rejected:

- **Raising Hostinger limits:** masks churn and does not correct the remote same-account database path.
- **Removing the REST fallback:** creates a printing outage when both Socket.IO transports are unavailable.
- **Polling every 30 seconds:** protects the DB but creates unacceptable kitchen delay. Connected Socket.IO polling gives immediate push; disconnected REST is 5 seconds idle and 1 second only after actual work.
- **Changing `/health` to process-only:** breaks installer/updater readiness verification.
- **Setting `maxIdle` below `connectionLimit`:** deliberately retires connections and can increase hourly handshakes; keep the small pool reusable.
- **Blindly retrying database connection errors:** can create a reconnect storm. mysql2 owns pool reconnection; application background work merely backs off.
- **A second print queue or spooler state machine:** risks duplicate physical output and contradicts the durable queue invariant.
- **Logging connection configuration:** could expose database usernames/hosts/secrets. Telemetry contains counters and error codes only.
- **Hardcoding or rewriting the database host in application code:** breaks legitimate external deployments. The operator-owned Hostinger environment uses `127.0.0.1`; the application consumes it unchanged.
- **Trusting arbitrary `next_poll_ms`:** a malformed server response could create a spin or long outage; the client clamps it.
- **Using `setInterval` for async polling:** enables overlap when a request hangs; recursive timeout plus abort and generation checks closes that race.
- **Stopping fallback on any error:** transient 429/5xx/network failures must recover; only authentication failures stop permanently.
- **Rotating the spooler key during code rollout:** would disconnect installed spoolers until every machine is updated. Rotate separately and deliberately.

No remaining requirement is left without a task. No database migration, business-table change, checkout change, or print-payload change is required.
