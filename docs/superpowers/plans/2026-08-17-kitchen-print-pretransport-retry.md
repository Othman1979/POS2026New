# Kitchen Print Pre-Transport Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically retry kitchen tickets within seconds when rendering or printer connection fails before any bytes can reach the printer, while preserving the hard no-duplicate rule once transport may have started.

**Architecture:** Keep `print_queue` as the only retry authority. The spooler moves its durable `printing` marker to the transport boundary and reports pre-transport failures as safe; the existing backend `failed` state, attempt counter, and `next_retry_at` perform bounded retries. Connected sockets receive a one-second failure-driven wake-up, while the existing REST poller, reconnect claim, and 30-second processor remain recovery fallbacks.

**Tech Stack:** Node.js 22/CommonJS, Express, Socket.IO, MySQL/MariaDB, Node `net` and `child_process`, Vitest, existing standalone spooler test runner.

## Global Constraints

- Do not add a database migration, table, queue, dependency, environment variable, background worker, or installer change.
- Do not change `spooler.env`, `pos.env`, printer assignments, customer data, or production rows.
- Do not automatically retry a kitchen ticket after TCP `socket.write` begins or after the Windows `exec` call is invoked. A child can execute before JavaScript observes its `spawn` event, so `spawn` is too late for duplicate-safe ownership.
- Keep durable seen-store recovery: `printing` means uncertain/manual review; `completed` means acknowledge redelivery without another physical print.
- Reuse `print_queue.status`, `attempts`, `max_attempts`, `next_retry_at`, leases, Socket.IO delivery, and HTTP polling.
- Kitchen safe failures retry after exactly 1 second; non-kitchen retry timing remains 10 seconds.
- Keep the existing default of five total attempts. Do not add exponential backoff for this bounded local-printer path.
- Reject invalid network printer IP addresses at the admin API and again inside the spooler. Use Node's built-in `net.isIP`; do not add a validation package.
- Preserve ordinary cashier checkout behavior. No new modal, blocking checkout wait, or cashier decision is introduced.
- Do not manually bump versions, build installers, deploy, push, or update a customer machine during implementation.
- Preserve all unrelated working-tree files and changes.

---

## Evidence and decisions

### Customer evidence

The customer-provided dead-letter export was read only and is not copied into this repository. Its payload data is intentionally omitted here.

- 20/20 exported rows were kitchen jobs in `dead_letter`.
- 20/20 had `attempts = 1` despite `max_attempts = 5`.
- 20/20 were claimed within 0–1 second; average claim delay was 0.3 seconds.
- 20/20 had `sent_at`; 0/20 had `acknowledged_at`; 0/20 had `next_retry_at`.
- 17/20 failed with a TCP connection timeout to the same local network-printer endpoint.
- 3/20 failed DNS/address resolution for an impossible IPv4 address.
- The failed rows came from spooler versions 1.2.1 and 1.2.3.

This rules out missing route creation, POS-to-server traffic, queue claiming, and server-to-spooler delivery for these rows. It proves the failure occurred before the spooler established printer transport.

### Source evidence

- `pos-spooler-printer/server.js:358-362` currently calls `seenStore.begin(job)` before `addToPrintQueue`, rendering, or TCP connection.
- `pos-spooler-printer/server.js:887-895` times out while connecting before the `connect` callback that calls `socket.write`.
- `backend/services/printQueue.js:192-217` forces every `uncertain` failure to `dead_letter`, bypassing its retry delay and five-attempt budget.
- `backend/services/printQueue.js:2` gives ordinary safe failures a 10-second delay, while `server.js:576-588` only performs the connected-socket fallback scan every 30 seconds.
- `backend/routes/admin/printers.js:104-160` validates only that `network_ip` is non-empty, allowing impossible addresses to persist.

### Platform evidence

- Node documents that the TCP `connect` callback is the `connect` event listener and runs only after the connection is established; connection problems emit `error` instead: <https://nodejs.org/api/net.html#socketconnectoptions-connectlistener>.
- Node documents that a child process emits `spawn` only after successful process creation and before other child-process events: <https://nodejs.org/api/child_process.html#event-spawn>. Because the child already exists at that point, this plan does not use `spawn` as a pre-transport boundary.

### Chosen timing

A failed TCP attempt already consumes up to three seconds. A one-second retry delay makes the second attempt begin about four to five seconds after the original attempt began. Five continuously timed-out attempts remain bounded to roughly twenty seconds plus rendering, while later queued work can run between attempts.

### Verified pre-change baseline

On 2026-08-17, before implementation:

- `npm --prefix pos-spooler-printer test` passed the complete tracked spooler suite.
- The seven focused backend files named in Task 3 passed: 7 files, 35 tests.

These results are the GREEN baseline. The new RED tests must fail for the missing behavior, not because the branch was already broken.

---

## File map

- Modify `pos-spooler-printer/server.js`: move durable kitchen attempt ownership to the actual network/Windows transport boundary and reject invalid network IPs before rendering.
- Create `pos-spooler-printer/tests/transport-boundary.test.js`: prove pre-transport retry safety and post-start duplicate protection through the real spooler entry point.
- Modify `backend/services/printQueue.js`: retain 10-second non-kitchen retries, add one-second kitchen safe retries, and keep terminal/uncertain failures non-retryable.
- Modify `server.js`: schedule a one-second connected-socket queue wake after a successfully persisted safe NACK.
- Modify `backend/tests/integration/printQueue.test.js`: prove kitchen/non-kitchen retry timing and terminal failure behavior.
- Modify `backend/tests/integration/spoolerSocketTransport.test.js`: prove a safe NACK redelivers the same row within seconds; the queue lifecycle suite remains the uncertainty/no-retry authority.
- Modify `backend/tests/integration/spoolerPoll.test.js`: prove HTTP fallback can reclaim the same safe-failed kitchen row after the one-second durable delay.
- Modify `backend/routes/admin/printers.js`: trim and validate network IPs with `net.isIP` on POST and PUT.
- Modify `backend/tests/integration/printersValidation.test.js`: reject impossible addresses and accept a valid network endpoint.
- Modify `src/admin/pages/Settings.vue`: translate printer-save API errors before showing them.
- Modify `src/shared/i18n/ar.json`: add the printer IP validation message.
- Modify `docs/architecture.json`: document the corrected transport boundary and safe retry path.
- Regenerate `docs/architecture.html` with `npm run architecture`; never edit it directly.

---

### Task 1: Put the durable kitchen marker on the real transport boundary

**Files:**
- Create: `pos-spooler-printer/tests/transport-boundary.test.js`
- Modify: `pos-spooler-printer/server.js:317-405, 549-907`
- Modify: `pos-spooler-printer/tests/payload-integrity.test.js` and `pos-spooler-printer/tests/spooler-report-rendering.test.js`: keep their mocked `net` modules compatible with the built-in `isIP` API.

**Interfaces:**
- `normalizePrinterTarget(job) -> job` trims a network IP, rejects it when invalid, and returns the exact job object used by preflight and transport.
- `processPrintJob(job, onTransportStart = () => {}) -> Promise<void>` invokes `onTransportStart` once immediately before TCP `socket.write`, or immediately before invoking the Windows copy command where JavaScript cannot observe an earlier safe child-process boundary.
- `addToPrintQueue(job, onTransportStart) -> Promise<void>` carries the callback through the existing serial local queue.
- `processIncomingPrintJob(job, respond) -> Promise<void>` reports `uncertain: true` only when a kitchen transport-start callback ran.
- Invalid network endpoints throw an error whose message begins `PRINTER_CONFIG_INVALID:` before rendering or transport.

- [ ] **Step 1: Write the failing transport-boundary test**

Create `pos-spooler-printer/tests/transport-boundary.test.js`. Use `Module._load` like the existing standalone spooler tests, but give the mock TCP socket explicit modes: `timeout-before-connect`, `error-before-connect`, `write-error`, and `success`. Set a temporary `SPOOLER_STATE_DIR` so the real `DurableSeenStore` can be inspected without touching machine state.

The test harness must expose `runKitchenAttempt(transportMode, overrides = {})`, returning `{ response, writes, seenState, additionalWrites, connectedHosts }`. `transportMode` controls the mocked `net.Socket`, render page, or Windows `exec` child. `timeout-before-connect` and `error-before-connect` must never invoke the TCP connect callback; `write-error` and `success` must invoke it, record the host passed to `connect`, and count `socket.write` calls. `render-error` must let the startup warm-up complete and then fail the job render. `windows-temp-file-error` must fail only the generated print-job file write before `exec`. The Windows mock must count `exec` invocations: `windows-spawn-error` invokes its callback with a process-creation error, while `windows-after-spawn-error` invokes it with a later copy error. Both are uncertain because the duplicate-safe marker is written before calling `exec`. `overrides.seenStoreWriteError` must fail only the seen-store atomic rename and prove that the network callback rejects without reaching `socket.write` or crashing the process. When `overrides.redeliver === true`, the harness must call the same exported `processIncomingPrintJob` twice before restoring it and report writes added by the second delivery. It must execute these assertions:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

// The harness must mock puppeteer/canvas/escpos/socket.io-client exactly enough
// to run the real processIncomingPrintJob. Its mock net.Socket behavior is
// selected by transportMode and it counts write calls.

const timeoutResult = await runKitchenAttempt('timeout-before-connect');
assert.strictEqual(timeoutResult.response.success, false);
assert.strictEqual(timeoutResult.response.uncertain, false);
assert.match(timeoutResult.response.error, /TCP connection timeout/);
assert.strictEqual(timeoutResult.writes, 0);
assert.strictEqual(timeoutResult.seenState, null);

const connectErrorResult = await runKitchenAttempt('error-before-connect');
assert.strictEqual(connectErrorResult.response.uncertain, false);
assert.strictEqual(connectErrorResult.writes, 0);
assert.strictEqual(connectErrorResult.seenState, null);

const renderFailureResult = await runKitchenAttempt('render-error');
assert.strictEqual(renderFailureResult.response.uncertain, false);
assert.strictEqual(renderFailureResult.writes, 0);
assert.strictEqual(renderFailureResult.seenState, null);

const windowsTempFileFailure = await runKitchenAttempt('windows-temp-file-error', {
    printer_type: 'windows', printer_name: 'Kitchen-Test', network_ip: null
});
assert.strictEqual(windowsTempFileFailure.response.uncertain, false);
assert.strictEqual(windowsTempFileFailure.seenState, null);

const invalidAddressResult = await runKitchenAttempt('success', {
    network_ip: '192.168.1.300', status_capability: 'escpos_status'
});
assert.strictEqual(invalidAddressResult.response.uncertain, false);
assert.match(invalidAddressResult.response.error, /^PRINTER_CONFIG_INVALID:/);
assert.strictEqual(invalidAddressResult.writes, 0);
assert.strictEqual(invalidAddressResult.seenState, null);

const normalizedAddressResult = await runKitchenAttempt('success', { network_ip: ' 192.168.1.105 ' });
assert.deepStrictEqual(normalizedAddressResult.connectedHosts, ['192.168.1.105']);

const writeFailureResult = await runKitchenAttempt('write-error');
assert.strictEqual(writeFailureResult.response.success, false);
assert.strictEqual(writeFailureResult.response.uncertain, true);
assert.strictEqual(writeFailureResult.writes, 1);
assert.strictEqual(writeFailureResult.seenState, 'printing');

const markerWriteFailure = await runKitchenAttempt('success', { seenStoreWriteError: true });
assert.strictEqual(markerWriteFailure.response.success, false);
assert.strictEqual(markerWriteFailure.response.uncertain, true);
assert.strictEqual(markerWriteFailure.writes, 0);

const windowsSpawnFailure = await runKitchenAttempt('windows-spawn-error', {
    printer_type: 'windows', printer_name: 'Kitchen-Test', network_ip: null
});
assert.strictEqual(windowsSpawnFailure.response.uncertain, true);
assert.strictEqual(windowsSpawnFailure.seenState, 'printing');

const windowsPostSpawnFailure = await runKitchenAttempt('windows-after-spawn-error', {
    printer_type: 'windows', printer_name: 'Kitchen-Test', network_ip: null
});
assert.strictEqual(windowsPostSpawnFailure.response.uncertain, true);
assert.strictEqual(windowsPostSpawnFailure.seenState, 'printing');

const successResult = await runKitchenAttempt('success', { redeliver: true });
assert.strictEqual(successResult.response.success, true);
assert.strictEqual(successResult.writes, 1);
assert.strictEqual(successResult.seenState, 'completed');
assert.strictEqual(successResult.additionalWrites, 0);

console.log('transport-boundary tests passed');
```

The harness must restore `Module._load`, `setInterval`, console methods, `SPOOLER_STATE_DIR`, and the `require` cache in `finally`, and remove only its `fs.mkdtempSync(path.join(os.tmpdir(), 'pos-spooler-transport-'))` directory.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
node pos-spooler-printer/tests/transport-boundary.test.js
```

Expected: FAIL because a timeout before `connect` currently reports `uncertain: true` and persists seen state `printing`.

- [ ] **Step 3: Move the marker through the serial queue**

Replace the early `kitchenAttemptStarted` block in `processIncomingPrintJob` with a callback-owned flag:

```js
let deviceStatus = 'unknown';
let kitchenTransportStarted = false;
let responsePayload = null;
const markTransportStarted = () => {
    if (job?.print_type !== 'kitchen' || !job?.queue_id || kitchenTransportStarted) return;
    kitchenTransportStarted = true;
    seenStore.begin(job);
};

try {
    const printableJob = normalizePrinterTarget(job);
    const preflight = await preflightPrinter(printableJob);
    deviceStatus = preflight.deviceStatus || 'unknown';
    if (!preflight.ok) {
        const err = new Error(preflight.error || 'Printer preflight failed.');
        err.deviceStatus = deviceStatus;
        throw err;
    }

    await addToPrintQueue(printableJob, markTransportStarted);
    console.log(`Print job completed: ${job.print_type} -> ${printableJob.printer_name || printableJob.network_ip}`);
    if (job.queue_id) {
        registerCompletedPrint(job);
        responsePayload = { success: true, durationMs: Date.now() - startedAt, deviceStatus };
    }
} catch (err) {
    console.error('Print job failed:', err.message);
    if (job.queue_id) {
        responsePayload = {
            success: false,
            uncertain: kitchenTransportStarted,
            error: err.message,
            durationMs: Date.now() - startedAt,
            deviceStatus: err.deviceStatus || deviceStatus || 'error'
        };
    }
}
```

Carry the callback without adding another queue:

```js
async function addToPrintQueue(job, onTransportStart) {
    return new Promise((resolve, reject) => {
        localPrintQueue.push({ job, onTransportStart, resolve, reject });
        processNextQueueJob();
    });
}

async function processNextQueueJob() {
    if (isProcessingLocalQueue || localPrintQueue.length === 0) return;
    isProcessingLocalQueue = true;

    const { job, onTransportStart, resolve, reject } = localPrintQueue.shift();
    try {
        await processPrintJob(job, onTransportStart);
        resolve();
    } catch (err) {
        reject(err);
    } finally {
        isProcessingLocalQueue = false;
        processNextQueueJob();
    }
}
```

- [ ] **Step 4: Validate network IP before preflight and invoke the boundary at transport**

Add one reusable validation helper near `preflightPrinter`; do not duplicate the predicate:

```js
function normalizePrinterTarget(job = {}) {
    if (job.printer_type !== 'network') return job;
    const networkIp = String(job.network_ip || '').trim();
    if (net.isIP(networkIp) === 0) {
        throw new Error('PRINTER_CONFIG_INVALID: Invalid network printer IP address.');
    }
    return { ...job, network_ip: networkIp };
}
```

Inside the main `try` in `processIncomingPrintJob`, after payload-integrity and seen-store duplicate/uncertainty checks, assign `const printableJob = normalizePrinterTarget(job)` immediately before preflight. Pass `printableJob` to `preflightPrinter` and `addToPrintQueue`; keep the original `job` for seen-store keys and the response. This makes invalid configuration terminal even when `status_capability` would otherwise attempt a network preflight first, preserves the normal NACK path, and ensures an old whitespace-padded address is connected using its trimmed value.

Change the signature:

```js
async function processPrintJob(job, onTransportStart = () => {}) {
```

Move job destructuring to the top of `processPrintJob`, call the same helper before awaiting `startupWarmupBarrier` or `getBrowserInstance`, then continue with the existing render path:

```js
job = normalizePrinterTarget(job);
const { printer_name, printer_type, network_ip, network_port, print_type, data } = job;
await startupWarmupBarrier;
const browser = await getBrowserInstance();
```

For network printers, invoke the callback only after TCP `connect` and immediately before `write`:

```js
client.connect(network_port || 9100, network_ip, () => {
    try {
        onTransportStart();
    } catch (error) {
        client.destroy();
        reject(error);
        return;
    }
    client.write(device.buffer, () => { client.destroy(); resolve(); });
});
```

For Windows printers, persist the marker immediately before invoking `exec`. This intentionally treats process-creation failure as uncertain: marking at the later `spawn` event would create a crash window after the child begins executing but before durable ownership exists.

```js
onTransportStart();
exec(`copy /B "${tmpFile}" "\\\\127.0.0.1\\${printer_name}"`, (err) => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    if (err) reject(err); else resolve();
});
```

Set `kitchenTransportStarted = true` before the durable `seenStore.begin` write so a marker-write failure is conservatively reported as uncertain. Catch the network callback error as shown; no EventEmitter callback may crash the service. For network printing, do not move `onTransportStart` before `client.connect`; for Windows printing, do not move it before rendering or temporary-file creation, and do not move it after `exec` invocation.

- [ ] **Step 5: Run GREEN and the complete spooler suite**

Run:

```powershell
node pos-spooler-printer/tests/transport-boundary.test.js
npm --prefix pos-spooler-printer test
```

Expected: both commands PASS. The new test must prove zero writes and `uncertain: false` for connection timeout, connection error, invalid IP, render failure, and Windows temp-file failure; it must prove the trimmed address is used, post-write and Windows-command failures are uncertain, a seen-store write error does not crash the process, and successful redelivery produces no second write.

- [ ] **Step 6: Commit Task 1**

```powershell
git add pos-spooler-printer/server.js pos-spooler-printer/tests/transport-boundary.test.js pos-spooler-printer/tests/payload-integrity.test.js pos-spooler-printer/tests/spooler-report-rendering.test.js
git commit -m "fix(spooler): retry pre-transport kitchen failures safely"
```

---

### Task 2: Wake the durable kitchen retry in one second and block invalid configuration

**Files:**
- Modify: `backend/services/printQueue.js:1-226`
- Modify: `server.js:39, 276-362`
- Modify: `backend/tests/integration/printQueue.test.js:129-206`
- Modify: `backend/tests/integration/spoolerSocketTransport.test.js`
- Modify: `backend/tests/integration/spoolerPoll.test.js`
- Modify: `backend/routes/admin/printers.js:1-8, 104-174`
- Modify: `backend/tests/integration/printersValidation.test.js`
- Modify: `src/admin/pages/Settings.vue:1221-1235`
- Modify: `src/shared/i18n/ar.json`

**Interfaces:**
- Export `KITCHEN_SAFE_RETRY_DELAY_SECONDS = 1` from `backend/services/printQueue.js`.
- Export `isNonRetryablePrintError(error) -> boolean`; payload-integrity and invalid-printer-configuration failures remain terminal.
- `settlePrintJob` stores safe kitchen failures as `failed` with `next_retry_at = UTC_TIMESTAMP() + 1 second`.
- `settlePrintJob` keeps receipts and reports on the existing 10-second delay.
- A socket safe NACK schedules one failure-driven `processPendingQueue(socket)` call after one second; it does not create recurring idle polling.
- Admin POST/PUT accepts only trimmed IPv4 or IPv6 values for `type === 'network'`.

- [ ] **Step 1: Extend queue lifecycle tests and verify RED**

Add a test to `backend/tests/integration/printQueue.test.js` that claims two rows, settles both with `success: false, uncertain: false`, and evaluates database-side due time:

```js
it('retries safe kitchen failures after one second without changing receipt retry timing', async () => {
    const printerA = await createPrinter('station-a');
    const kitchenId = await enqueue({ print_type: 'kitchen', data: { print_batch_id: 'safe-retry' } }, printerA);
    const receiptId = await enqueue({ print_type: 'receipt', data: { total: 2 } }, printerA);
    const jobs = await claimPrintJobs(pool, { spoolerId: 'station-a', claimantId: 'socket-a', limit: 10 });
    await markPrintJobsSent(pool, jobs, { claimantId: 'socket-a' });

    for (const queueId of [kitchenId, receiptId]) {
        await settlePrintJob(pool, {
            queueId,
            spoolerId: 'station-a',
            claimantId: 'socket-a',
            success: false,
            uncertain: false,
            error: 'TCP connection timeout before write'
        });
    }

    const [rows] = await pool.query(`
        SELECT id, status, attempts,
               TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), next_retry_at) AS retry_in_seconds
          FROM print_queue
         WHERE id IN (?, ?)
         ORDER BY id
    `, [kitchenId, receiptId]);

    const kitchen = rows.find(row => row.id === kitchenId);
    const receipt = rows.find(row => row.id === receiptId);
    expect(kitchen.status).toBe('failed');
    expect(Number(kitchen.attempts)).toBe(1);
    expect(Number(kitchen.retry_in_seconds)).toBeGreaterThanOrEqual(0);
    expect(Number(kitchen.retry_in_seconds)).toBeLessThanOrEqual(1);
    expect(Number(receipt.retry_in_seconds)).toBeGreaterThanOrEqual(9);
    expect(Number(receipt.retry_in_seconds)).toBeLessThanOrEqual(10);
});
```

Keep the existing uncertain-kitchen and payload-integrity tests unchanged; they must continue to require immediate dead-letter and `next_retry_at IS NULL`.

Add the matching permanent-configuration assertion:

```js
it('dead-letters invalid printer configuration after the first claimed attempt', async () => {
    const printerA = await createPrinter('station-a');
    const id = await enqueue({ print_type: 'kitchen', data: { print_batch_id: 'invalid-printer-config' } }, printerA);
    const jobs = await claimPrintJobs(pool, { spoolerId: 'station-a', claimantId: 'socket-a', limit: 10 });
    await markPrintJobsSent(pool, jobs, { claimantId: 'socket-a' });

    await settlePrintJob(pool, {
        queueId: id,
        spoolerId: 'station-a',
        claimantId: 'socket-a',
        success: false,
        uncertain: false,
        error: 'PRINTER_CONFIG_INVALID: Invalid network printer IP address.'
    });

    const [[row]] = await pool.query('SELECT status, attempts, next_retry_at FROM print_queue WHERE id = ?', [id]);
    expect(row.status).toBe('dead_letter');
    expect(Number(row.attempts)).toBe(1);
    expect(row.next_retry_at).toBeNull();
});
```

Run:

```powershell
npx vitest run backend/tests/integration/printQueue.test.js --reporter=dot
```

Expected: FAIL because kitchen currently receives the same 10-second delay as receipts.

- [ ] **Step 2: Add the kitchen-specific delay without changing schema or callers**

At the top of `backend/services/printQueue.js`:

```js
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_RETRY_DELAY_SECONDS = 10;
const KITCHEN_SAFE_RETRY_DELAY_SECONDS = 1;
```

Generalize the existing payload-integrity terminal check without adding a response protocol:

```js
function isNonRetryablePrintError(error) {
    const message = String(error || '');
    return message.startsWith('PAYLOAD_INTEGRITY_MISMATCH:') ||
        message.startsWith('PRINTER_CONFIG_INVALID:');
}
```

Replace the existing settlement SELECT with the same predicate and this authoritative projection:

```js
const [[job]] = await db.query(
    'SELECT payload, print_type, status, attempts, max_attempts FROM print_queue WHERE id = ? AND claimed_by = ? AND spooler_id = ?',
    [queueId, claimantId, spoolerId]
);
```

After parsing `payload` and before building the failed-row update, calculate from the queue column rather than client JSON:

```js
const nextRetryDelaySeconds = job.print_type === 'kitchen'
    ? KITCHEN_SAFE_RETRY_DELAY_SECONDS
    : retryDelaySeconds;
```

Bind `nextRetryDelaySeconds` instead of `retryDelaySeconds` to the existing `DATE_ADD` expression. Replace `integrityMismatch` in the `nextStatus` expression with `isNonRetryablePrintError(error)`. Export the constant and helper:

```js
module.exports = {
    KITCHEN_SAFE_RETRY_DELAY_SECONDS,
    isNonRetryablePrintError,
    claimPrintJobs,
    markPrintJobsSent,
    settlePrintJob
};
```

Do not change `max_attempts`, lease semantics, terminal states, integrity handling, or the `uncertain` branch.

- [ ] **Step 3: Write the socket redelivery test and verify RED**

First make the server lifecycle independent of test order. Start it once in `beforeAll`, set `baseUrl` there, and remove the listen block from the existing first test:

```js
beforeAll(async () => {
    if (!server.listening) {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    }
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
```

Keep the existing `afterAll` shutdown. Then add a second test to `backend/tests/integration/spoolerSocketTransport.test.js`. It must:

1. create one active kitchen printer and one pending kitchen row;
2. connect a spooler socket and capture the first `print_job`;
3. emit `print_job_response` with `success: false`, `uncertain: false`, and a pre-write TCP timeout error;
4. capture the second `print_job` and require the same queue ID within 3 seconds;
5. assert the row has `attempts = 2` and is `sent` on the second delivery;
6. acknowledge the second attempt successfully and require `acknowledged`.

The core timing assertion must be:

```js
const retryJobs = await Promise.race([
    retryDelivery,
    wait(3000).then(() => { throw new Error('Safe kitchen retry was not delivered within three seconds.'); })
]);
expect(retryJobs.map(job => job.queue_id)).toContain(queue.insertId);
```

Run:

```powershell
npx vitest run backend/tests/integration/spoolerSocketTransport.test.js --reporter=dot
```

Expected: FAIL because the only connected-socket retry scan currently runs every 30 seconds.

- [ ] **Step 3a: Write the HTTP poll redelivery test and verify RED**

Add `const wait = ms => new Promise(resolve => setTimeout(resolve, ms));` to `backend/tests/integration/spoolerPoll.test.js`, then add:

```js
it('reclaims a safe-failed kitchen row after the one-second retry delay', async () => {
    const queueId = await enqueuePending();
    const firstPoll = await request(app)
        .post('/api/spooler/poll')
        .set('x-spooler-key', 'test-spooler-key')
        .send({ spooler_id: 'poller-a' });
    expect(firstPoll.body.jobs.map(job => job.queue_id)).toContain(queueId);

    const failedAck = await request(app)
        .post('/api/spooler/ack')
        .set('x-spooler-key', 'test-spooler-key')
        .send({
            spooler_id: 'poller-a', queue_id: queueId, success: false,
            uncertain: false, error: 'TCP connection timeout before write'
        });
    expect(failedAck.statusCode).toBe(200);

    await wait(1100);
    const retryPoll = await request(app)
        .post('/api/spooler/poll')
        .set('x-spooler-key', 'test-spooler-key')
        .send({ spooler_id: 'poller-a' });
    expect(retryPoll.body.jobs.map(job => job.queue_id)).toContain(queueId);

    const [[retried]] = await pool.query('SELECT status, attempts FROM print_queue WHERE id = ?', [queueId]);
    expect(retried.status).toBe('sent');
    expect(Number(retried.attempts)).toBe(2);
});
```

Run:

```powershell
npx vitest run backend/tests/integration/spoolerPoll.test.js --reporter=dot
```

Expected: FAIL because the safe kitchen row is currently not due until ten seconds after settlement.

- [ ] **Step 4: Schedule one failure-driven connected-socket wake-up**

Import the shared delay in `server.js`:

```js
const {
    KITCHEN_SAFE_RETRY_DELAY_SECONDS,
    isNonRetryablePrintError,
    claimPrintJobs,
    markPrintJobsSent,
    settlePrintJob
} = require('./backend/services/printQueue');
```

Immediately after `processPendingQueue`, add the non-recurring helper:

```js
function scheduleSafePrintRetry(socket) {
    const timer = setTimeout(() => {
        if (socket.connected) processPendingQueue(socket);
    }, KITCHEN_SAFE_RETRY_DELAY_SECONDS * 1000);
    timer.unref?.();
}
```

In `print_job_response`, only after `settlePrintJob` returned `true`, schedule a wake for a safe failure:

```js
if (!settled) {
    logger.warn({ socketId: socket.id, queue_id }, 'Ignored print job response from non-claiming spooler or missing queue row.');
} else if (success === false && uncertain !== true && !isNonRetryablePrintError(error)) {
    scheduleSafePrintRetry(socket);
}
```

One timer per persisted safe failure is intentional: failures are exceptional, the query is one-shot, `claimPrintJobs` serializes claims with `FOR UPDATE`, and this avoids a second resident scheduler. If the server or socket disappears, the durable row remains recoverable by reconnect, REST polling, or the existing 30-second fallback.

- [ ] **Step 5: Write invalid endpoint API tests and verify RED**

Add to `backend/tests/integration/printersValidation.test.js`:

```js
it('rejects impossible network printer addresses on create and update', async () => {
    const invalidCreate = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({
        name: 'Invalid kitchen', role: 'kitchen', type: 'network',
        network_ip: '192.168.1.300', network_port: 9100, spooler_id: 'primary'
    });
    expect(invalidCreate.statusCode).toBe(400);
    expect(invalidCreate.body.message).toBe('Invalid network printer IP address.');

    const validCreate = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({
        name: 'Valid kitchen', role: 'kitchen', type: 'network',
        network_ip: ' 192.168.1.105 ', network_port: 9100, spooler_id: 'primary'
    });
    expect(validCreate.statusCode).toBe(200);

    const [[printer]] = await pool.query("SELECT id, network_ip FROM printers WHERE name = 'Valid kitchen'");
    expect(printer.network_ip).toBe('192.168.1.105');

    const invalidUpdate = await request(app).put('/api/admin/printers').set('Cookie', adminCookie).send({
        id: printer.id, name: 'Valid kitchen', role: 'kitchen', type: 'network',
        network_ip: '192.168.1.300', network_port: 9100, spooler_id: 'primary'
    });
    expect(invalidUpdate.statusCode).toBe(400);
    expect(invalidUpdate.body.message).toBe('Invalid network printer IP address.');
});
```

Run:

```powershell
npx vitest run backend/tests/integration/printersValidation.test.js --reporter=dot
```

Expected: FAIL because the route currently accepts every non-empty string.

- [ ] **Step 6: Validate and normalize the admin endpoint**

At the top of `backend/routes/admin/printers.js`:

```js
const net = require('net');
```

In both POST and PUT paths, immediately after type validation, normalize once and reject invalid values:

```js
const networkIp = req.body.type === 'network'
    ? String(req.body.network_ip || '').trim()
    : null;
if (req.body.type === 'network') {
    if (!networkIp) return sendError(res, 400, 'Network IP is required.');
    if (net.isIP(networkIp) === 0) return sendError(res, 400, 'Invalid network printer IP address.');
    const port = Number(req.body.network_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return sendError(res, 400, 'Invalid network port.');
}
```

Bind `networkIp` instead of `req.body.network_ip` in both INSERT and UPDATE. Do not add hostname support: the existing UI and data model explicitly require an IP address.

In `Settings.vue`, translate API messages at the existing save boundary:

```js
await window.showAdminAlert(t(data.message || 'Failed to save settings.'));
```

Add this exact English key to `src/shared/i18n/ar.json` with a natural Arabic value reviewed in the same diff:

```json
"Invalid network printer IP address.": "عنوان IP الخاص بطابعة الشبكة غير صالح."
```

- [ ] **Step 7: Run Task 2 GREEN checks**

Run:

```powershell
npx vitest run backend/tests/integration/printQueue.test.js backend/tests/integration/spoolerSocketTransport.test.js backend/tests/integration/spoolerPoll.test.js backend/tests/integration/printersValidation.test.js backend/tests/integration/printReprint.test.js backend/tests/unit/printDispatchOwnership.test.js --reporter=dot
npm run build:admin
```

Expected: all selected tests PASS and the admin build completes successfully.

- [ ] **Step 8: Commit Task 2**

```powershell
git add backend/services/printQueue.js server.js backend/tests/integration/printQueue.test.js backend/tests/integration/spoolerSocketTransport.test.js backend/tests/integration/spoolerPoll.test.js backend/routes/admin/printers.js backend/tests/integration/printersValidation.test.js src/admin/pages/Settings.vue src/shared/i18n/ar.json
git commit -m "fix(printing): retry safe kitchen failures promptly"
```

---

### Task 3: Update the verified architecture and run the hostile-path gate

**Files:**
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

**Interfaces:**
- Architecture states that `seenStore.begin` occurs immediately before TCP write, or before Windows copy-process invocation because the child may execute before JavaScript observes `spawn`.
- Safe kitchen failures use `failed`, one-second `next_retry_at`, and bounded attempts.
- Post-start kitchen failures remain uncertain and terminal.

- [ ] **Step 1: Correct architecture invariants and flows**

In `docs/architecture.json`, update the two kitchen uncertainty invariants to this meaning:

```json
"Kitchen work is marked printing at the duplicate-safe transport boundary: immediately before TCP socket.write or before invoking the Windows copy process; validation, rendering and TCP-connect failures remain safe to retry.",
"A kitchen job whose transport may have started is forced to dead_letter and never auto-retried; only pre-transport failures use the bounded failed/next_retry_at path."
```

The architecture graph has no node named `flow-print-queue`; update the actual print flows `flow-checkout-receipt-socket` and `flow-poll-fallback`. Their spooler step must state that payload verification, validation and rendering happen before transport ownership, and their settlement/poll steps must state that safe kitchen failures receive one-second durable retry timing plus a connected-socket or next-poll wake-up.

Replace the `flow-kitchen-station-routing` seen-store step label with:

```json
"After validation and rendering, seenStore.begin(job) marks a kitchen job printing immediately before TCP socket.write or Windows copy-process invocation; TCP connection failures before socket.write remain retryable"
```

Update `flow-spooler-restart-dedupe` to retain the same restart behavior but describe the narrower meaning of `printing`: TCP write or Windows copy may have started.

Update all touched `file:line` locations after implementation by locating the named symbols; do not preserve stale line numbers.

- [ ] **Step 2: Regenerate and validate architecture**

Run:

```powershell
npm run architecture
npm run architecture:check
```

Expected: generated HTML changes only as a consequence of the JSON and the architecture check passes.

- [ ] **Step 3: Run the complete focused verification gate**

Run:

```powershell
npm --prefix pos-spooler-printer test
npx vitest run backend/tests/integration/printQueue.test.js backend/tests/integration/spoolerSocketTransport.test.js backend/tests/integration/spoolerPoll.test.js backend/tests/integration/printersValidation.test.js backend/tests/integration/printReprint.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/printQueueWatchdog.test.js --reporter=dot
npm run build:admin
npm run architecture:check
git diff --check
git status --short
```

Expected:

- all spooler tests pass;
- all selected backend tests pass;
- admin build passes;
- architecture check passes;
- `git diff --check` produces no output;
- status contains only this task's intended files plus the user's pre-existing unrelated files.

- [ ] **Step 4: Execute the hostile-scenario checklist**

Review test evidence and code against every row below. Do not waive a row based only on inspection when a named automated test exists.

| Scenario | Required result | Proof |
|---|---|---|
| Browser/render failure before printer transport | `failed`, retryable, no seen record | `transport-boundary.test.js` |
| TCP DNS/error/timeout before `connect` | `failed`, retryable, zero writes | `transport-boundary.test.js` |
| Invalid configured IP | rejected on POST/PUT and by spooler before render | printer validation + transport tests |
| TCP connects, then write errors | uncertain and dead-lettered, never auto-retried | transport + queue tests |
| Windows render or temp-file creation fails before `exec` | safe failure, no seen record | transport test failing before command invocation |
| Windows `exec` cannot spawn or later copy fails | uncertain and dead-lettered | transport tests proving marker exists before command invocation |
| Spooler crashes after transport marker | persisted `printing`; redelivery refuses physical retry | existing durable-seen-store tests |
| Print succeeds but ACK is lost | persisted `completed`; redelivery ACKs without a second write | transport-boundary test |
| Safe socket failure | same queue row delivered again within 3 seconds | socket transport integration test |
| Socket disconnects before timer | row stays durable; reconnect/poll/30-second fallback can claim it | existing poll/reconnect lifecycle tests |
| Server restarts before timer | row stays `failed`; startup/connect/periodic claim remains valid | print queue claim tests |
| Five safe failures | fifth settlement becomes `dead_letter` | existing max-attempt integration test |
| Multiple printers/stations | ownership join remains unchanged | `printDispatchOwnership.test.js` |
| Receipt/report safe failure | existing 10-second retry timing unchanged | new queue timing test |
| Old spooler with new server | old uncertain NACK still dead-letters; no duplicate regression | protocol compatibility inspection |
| New spooler with old server | safe NACK uses old durable retry path, only slower | protocol compatibility inspection |

If any row fails, correct only the responsible task and rerun that task's RED/GREEN command before repeating the final gate.

- [ ] **Step 5: Commit Task 3**

```powershell
git add docs/architecture.json docs/architecture.html
git commit -m "docs: record safe kitchen print retry boundary"
```

---

## Explicit exclusions

- Do not auto-retry after bytes may have reached a kitchen printer.
- Do not wait for printing inside checkout or block the cashier until paper appears.
- Do not add SNMP, printer-specific status protocols, ping checks, or network monitoring.
- Do not change the three-second TCP connection timeout in this fix; the evidence concerns classification and retry, not a measured need for a longer socket timeout.
- Do not repair customer printer IPs through a migration or silently rewrite existing rows.
- Do not redesign cashier/admin print alerts, dead-letter recovery UI, kitchen routing, or browser-to-server checkout dispatch in this plan.
- Do not change Windows print-command timeout behavior; that is a separate unevidenced failure mode for this incident.

## Completion criteria

The implementation is complete only when a network timeout before TCP connection produces a safe NACK, the same durable kitchen row is delivered again within three seconds of that NACK, successful redelivery prints exactly once, post-write failure remains terminal, invalid IP configuration is blocked, and every focused verification command passes.
