const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { openJobStore } = require('../v2/job-store');
const { createPrinterWorkers } = require('../v2/printer-workers');
const { createWindowsTransport } = require('../v2/printer-transports');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { startPlatformHelper } = require('../v2/platform-helper');
const { createRawArtifactRenderer } = require('../v2/raw-artifact-renderer');
const { createSyncClient } = require('../v2/sync-client');
const { createAgentRuntime } = require('../v2/agent-runtime');

test('old Node runtimes fail clearly before rendering dependencies or configuration are loaded', () => {
    const { spawnSync } = require('node:child_process');
    for (const version of ['20.20.0', '22.11.0']) {
        const result = spawnSync(process.execPath, ['-e',
            `Object.defineProperty(process.versions, 'node', {value:${JSON.stringify(version)}}); require(${JSON.stringify(path.resolve(__dirname, '../server.js'))});`
        ], { encoding: 'utf8', windowsHide: true });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /requires Node\.js 22\.12 or newer/);
        assert.doesNotMatch(result.stdout, /dotenv/);
    }
});

test('invalid sync envelopes are rejected before any acknowledgement can be applied', async () => {
    for (const payload of [null, [], {}, { success: false, agent_status: 'active', jobs: [] },
        { agent_status: 'active', jobs: {} }, { agent_status: 'active', jobs: [], confirmed_results: '1' }]) {
        const client = createSyncClient({ baseUrl: 'https://invalid.example', agentId: 'test', secret: Buffer.alloc(32),
            fetchFn: async () => new Response(JSON.stringify(payload), { status: 200 }) });
        await assert.rejects(client.sync({}), error => error.code === 'SPOOLER_RESPONSE_INVALID');
    }
});

test('a malformed HTTP 200 response cannot reactivate a paused spooler', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-sync-response-audit-'));
    const store = openJobStore({ stateRoot: root });
    store.setAgentStatus('revoked');
    let next;
    let starts = 0;
    const runtime = createAgentRuntime({ store, random: () => 0,
        clock: { setTimeout(callback) { next = callback; return 1; }, clearTimeout() {} },
        worker: { start() { starts++; }, stop() {}, health: () => ({ active: 0 }) },
        syncClient: createSyncClient({ baseUrl: 'https://invalid.example', agentId: 'test', secret: Buffer.alloc(32),
            fetchFn: async () => new Response('<html>proxy maintenance</html>', { status: 200 }) })
    });
    try {
        runtime.start(); await next();
        assert.equal(starts, 0);
        assert.equal(store.agentStatus(), 'revoked');
        assert.equal(runtime.health().consecutive_failures, 1);
    } finally {
        await runtime.stop(); fs.rmSync(root, { recursive: true, force: true });
    }
});

test('short file writes cannot publish a truncated cash-drawer artifact', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-short-write-audit-'));
    const renderer = createRawArtifactRenderer({ stateRoot: root });
    const original = fs.writeSync;
    try {
        fs.writeSync = (fd, buffer, offset = 0, length = buffer.length - offset, position = null) =>
            original(fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
        const artifact = await renderer.render({ queue_id: 7, print_type: 'cash_drawer' });
        const bytes = fs.readFileSync(artifact.path);
        assert.deepEqual(bytes, Buffer.from([0x1b, 0x70, 0, 0x19, 0xfa]));
        assert.equal(bytes.length, artifact.bytes);
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), artifact.hash);
    } finally {
        fs.writeSync = original;
        await renderer.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a ready artifact on another printer progresses during rendering without bypassing its own pending work', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-ready-lane-audit-'));
    const store = openJobStore({ stateRoot: root });
    let releaseReport;
    const report = new Promise(resolve => { releaseReport = resolve; });
    let renderStarted;
    const rendering = new Promise(resolve => { renderStarted = resolve; });
    const sent = [];
    const add = (id, printerId, type = 'receipt') => store.accept({ queue_id: id, printer_id: printerId,
        print_type: type, idempotency_key: `ready-${id}`, payload_hash: 'b'.repeat(64), data: {} });
    const artifact = { path: 'fake-artifact.bin', hash: 'a'.repeat(64), bytes: 1 };
    add(1, 1, 'daily_sales_report');
    const workers = createPrinterWorkers({ store,
        renderer: { async render(job) { if (job.queue_id === 1) { renderStarted(); await report; } return artifact; } },
        transportFor: job => ({ async send({ markTransportStarted }) {
            markTransportStarted(); sent.push(job.queue_id); return { success: true };
        } })
    });
    try {
        workers.start(); await rendering;
        add(2, 2, 'kitchen'); store.markRendered(2, artifact);
        add(3, 1); store.markRendered(3, artifact);
        add(4, 3); add(5, 3); store.markRendered(5, artifact);
        workers.wake();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(sent, [2], 'only the independent ready lane can bypass the active render');
        releaseReport(); await workers.idle();
        assert(sent.indexOf(1) < sent.indexOf(3));
        assert(sent.indexOf(4) < sent.indexOf(5));
        assert.equal(new Set(sent).size, 5);
    } finally {
        releaseReport(); await workers.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a silent helper startup fails within its deadline and leaves no restart loop', async () => {
    let child;
    let spawns = 0;
    function spawnFn() {
        spawns++;
        child = new EventEmitter();
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => { child.killed = true; child.emit('exit', 1, null); };
        child.stdin.on('finish', () => child.kill());
        return child;
    }
    let guard;
    const started = startPlatformHelper({ executable: 'fake', stateRoot: 'unused', spawnFn,
        restartOnExit: true, restartDelayMs: 5, requestTimeoutMs: 30 });
    try {
        await assert.rejects(Promise.race([
            started,
            new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('TEST_HELPER_START_HUNG')), 250); })
        ]), error => error.code === 'PLATFORM_HELPER_START_TIMEOUT');
        assert.equal(child.killed, true);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(spawns, 1, 'failed startup must not leave an unowned helper respawning');
    } finally {
        clearTimeout(guard);
        child.stdout.write('{"type":"ready"}\n');
        const helper = await started.catch(() => null);
        await helper?.close();
    }
});

test('Windows drain failure never resends submitted bytes, including after restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-drain-audit-'));
    let workers;
    try {
        const store = openJobStore({ stateRoot: root });
        const bytes = Buffer.from('submitted receipt bytes');
        const artifact = { path: path.join(store.artifactsDirectory, 'test.bin'), bytes: bytes.length,
            hash: crypto.createHash('sha256').update(bytes).digest('hex') };
        fs.writeFileSync(artifact.path, bytes);
        let submissions = 0;
        const transport = createWindowsTransport({ helper: {
            isReady: () => true,
            async request(command, payload, options) {
                assert.equal(command, 'print_raw');
                await options.beforeWrite();
                assert.deepEqual(fs.readFileSync(payload.artifact_path), bytes);
                submissions++;
                throw Object.assign(new Error('drain did not complete'), { code: 'WINspool_JOB_STUCK' });
            }
        } });
        store.accept({ queue_id: 1, idempotency_key: 'drain-audit', payload_hash: 'a'.repeat(64),
            print_type: 'receipt', printer_id: 1, printer_name: 'Test-Printer', printer_type: 'windows', data: {} });
        const options = { renderer: { render: async () => artifact }, transportFor: () => transport };
        workers = createPrinterWorkers({ store, ...options });
        workers.start(); await workers.idle();
        assert.equal(store.get(1).state, 'uncertain');
        assert.equal(store.outbox()[0].error_code, 'WINspool_JOB_STUCK');
        workers.wake(); await workers.idle(); await workers.stop();
        const reopened = openJobStore({ stateRoot: root });
        workers = createPrinterWorkers({ store: reopened, ...options });
        workers.start(); await workers.idle();
        assert.equal(submissions, 1);
        assert.equal(reopened.get(1).state, 'uncertain');
    } finally {
        await workers?.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
