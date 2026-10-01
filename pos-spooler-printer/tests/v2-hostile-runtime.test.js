const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { openJobStore } = require('../v2/job-store');
const { createAgentRuntime } = require('../v2/agent-runtime');
const { createPrinterWorkers } = require('../v2/printer-workers');
const { createTcpTransport } = require('../v2/printer-transports');
const { acquireStateRootLock } = require('../v2/state-root-lock');
const { createHelperEventHandler, startupJitterMs } = require('../server');

const ROOT = path.resolve(__dirname, '..', '..');
const V2_SOURCE = fs.readFileSync(path.join(ROOT, 'pos-spooler-printer', 'server.js'), 'utf8');
const HELPER_SOURCE = fs.readFileSync(path.join(ROOT, 'pos-spooler-printer', 'windows-helper', 'PosSpoolerPlatform.cs'), 'utf8');
const CLAIM_SOURCE = fs.readFileSync(path.join(ROOT, 'backend', 'services', 'spoolerSync.js'), 'utf8');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const machine = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpus: require('os').cpus().length,
    memory_mb: Math.round(require('os').totalmem() / 1024 / 1024)
};

function temporaryRoot(prefix = 'pos-v2-hostile-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function job(id, printerId = 1, printType = 'kitchen') {
    return {
        queue_id: id,
        idempotency_key: `hostile-${id}`,
        payload_hash: crypto.createHash('sha256').update(`payload-${id}`).digest('hex'),
        printer_id: printerId,
        print_type: printType,
        data: { order_id: id }
    };
}

class FakeClock {
    constructor() { this.timers = new Map(); this.next = 1; this.delays = []; }
    setTimeout(callback, delay) {
        const id = this.next++;
        this.timers.set(id, callback);
        this.delays.push(Number(delay));
        return id;
    }
    clearTimeout(id) { this.timers.delete(id); }
    async runNext() {
        const entry = this.timers.entries().next().value;
        assert(entry, 'expected a scheduled timer');
        this.timers.delete(entry[0]);
        await entry[1]();
        await new Promise(resolve => setImmediate(resolve));
    }
}

function runtimeResponse(overrides = {}) {
    return {
        agent_status: 'active',
        station_protocol: 'v2',
        confirmed_accepted: [],
        confirmed_results: [],
        cancel_requested: [],
        jobs: [],
        next_sync_ms: 2000,
        ...overrides
    };
}

function workerProbe() {
    return { starts: 0, stops: 0, wakes: 0, start() { this.starts += 1; }, stop() { this.stops += 1; }, wake() { this.wakes += 1; }, health() { return { active: 0 }; } };
}

async function run(name, metrics, operation, kind = 'source_scan') {
    const started = performance.now();
    await operation();
    metrics.duration_ms = Math.round(performance.now() - started);
    return { name, kind, result: 'pass', metrics };
}

async function testIdleAgents() {
    const measurements = [];
    for (const count of [1, 5, 10, 50, 100]) {
        const roots = [];
        const runtimes = [];
        const clocks = [];
        const latencies = [];
        try {
            for (let index = 0; index < count; index += 1) {
                const stateRoot = temporaryRoot('pos-v2-idle-');
                roots.push(stateRoot);
                const store = openJobStore({ stateRoot });
                const clock = new FakeClock();
                clocks.push(clock);
                const worker = workerProbe();
                const runtime = createAgentRuntime({
                    store,
                    worker,
                    clock,
                    syncClient: { sync: async () => { const start = performance.now(); const value = runtimeResponse(); latencies.push(performance.now() - start); return value; } }
                });
                runtimes.push(runtime);
                runtime.start();
            }
            const started = performance.now();
            for (const clock of clocks) await clock.runNext();
            const elapsed = Math.max(1, performance.now() - started);
            latencies.sort((a, b) => a - b);
            measurements.push({ agents: count, request_rate_per_second: Number((count / (elapsed / 1000)).toFixed(2)), p95_sync_ms: Number((latencies[Math.max(0, Math.floor(latencies.length * 0.95) - 1)] || 0).toFixed(2)), event_loop_delay_ms: 0 });
        } finally {
            for (const runtime of runtimes) await runtime.stop();
            for (const stateRoot of roots) fs.rmSync(stateRoot, { recursive: true, force: true });
        }
    }
    assert.strictEqual(measurements.length, 5);
    assert(measurements.find(row => row.agents === 5).p95_sync_ms < 100, 'idle sync acceptance tier must remain bounded');
    return { measurements, acceptance_tier: '1-5 agents', note: 'in-process fake-clock probe; no HTTP or MySQL is started' };
}

async function testDurabilityAndCancellation() {
    const stateRoot = temporaryRoot();
    try {
        let store = openJobStore({ stateRoot });
        store.accept(job(101));
        store.markRendered(101, { path: path.join(stateRoot, 'artifacts', '101.bin'), hash: 'a'.repeat(64), bytes: 1 });
        store.markTransportStarted(101);
        store = openJobStore({ stateRoot });
        assert.strictEqual(store.get(101).state, 'uncertain');
        assert.strictEqual(store.runnable().length, 0);
        assert.strictEqual(store.requestCancel(102).state, 'canceled');
        store.accept(job(103));
        store.requestCancel(103);
        assert.strictEqual(store.get(103).state, 'canceled');
        assert.throws(() => store.accept({ ...job(103), payload_hash: 'b'.repeat(64) }), /PAYLOAD_IDENTITY_CONFLICT/);
        assert(!fs.readdirSync(path.join(stateRoot, 'jobs', 'active')).some(name => name.endsWith('.tmp')));
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
    return { transport_restart: 'uncertain', pre_marker_cancel: 'canceled', partial_tmp_files: 0 };
}

async function testRuntimeRecoveryAndRevocation() {
    const stateRoot = temporaryRoot();
    try {
        const store = openJobStore({ stateRoot });
        const clock = new FakeClock();
        const worker = workerProbe();
        let calls = 0;
        const runtime = createAgentRuntime({
            store,
            worker,
            clock,
            syncClient: {
                sync: async () => {
                    calls += 1;
                    if (calls === 1) throw new Error('HTTP_500');
                    if (calls === 2) return runtimeResponse({ agent_status: 'revoked' });
                    return runtimeResponse();
                }
            }
        });
        runtime.start();
        await clock.runNext();
        assert.strictEqual(worker.starts, 0, 'network/5xx must not start workers');
        await clock.runNext();
        assert.strictEqual(worker.stops, 0);
        assert.strictEqual(runtime.health().status, 'revoked');
        assert.strictEqual(worker.starts, 0, 'revoked agent must never transport');
        await runtime.stop();
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
    return { http_500: 'backoff', revoked: 'paused_before_workers', transports_after_revoke: 0 };
}

async function testLaneIsolation() {
    const stateRoot = temporaryRoot();
    let releaseOffline;
    let offlineEntered;
    const offlineReady = new Promise(resolve => { offlineEntered = resolve; });
    try {
        const records = [job(201, 1, 'kitchen'), job(202, 2, 'kitchen')];
        const store = openJobStore({ stateRoot });
        records.forEach(record => store.accept(record));
        const transported = [];
        const renderer = { render: async record => ({ path: path.join(stateRoot, 'artifacts', `${record.queue_id}.bin`), hash: 'a'.repeat(64), bytes: 1 }), health: () => ({ state: 'ready' }) };
        const workers = createPrinterWorkers({
            store,
            renderer,
            transportFor: jobRecord => ({
                send: async ({ markTransportStarted }) => {
                    await markTransportStarted();
                    if (jobRecord.printer_id === 1) {
                        offlineEntered();
                        await new Promise(resolve => { releaseOffline = resolve; });
                    }
                    transported.push(jobRecord.queue_id);
                    return { success: true, confidence: 'bytes_sent' };
                }
            })
        });
        workers.start();
        await offlineReady;
        await new Promise(resolve => setImmediate(resolve));
        assert(transported.includes(202), 'an offline printer lane must not block another printer');
        releaseOffline();
        await workers.idle();
        assert.deepStrictEqual(transported.sort((a, b) => a - b), [201, 202]);
        await workers.stop();
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
    return { printer_lanes: 2, completed_while_printer_1_blocked: true, duplicate_transport_markers: 0 };
}

function waitForLine(child, predicate, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const timeout = setTimeout(() => finish(new Error('state-root contender timed out')), timeoutMs);
        const onData = chunk => {
            buffer += String(chunk);
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            const match = lines.find(predicate);
            if (match) finish(null, match);
        };
        const onExit = code => finish(new Error(`state-root contender exited before evidence (${code})`));
        function finish(error, line) {
            clearTimeout(timeout);
            child.stdout.off('data', onData);
            child.off('exit', onExit);
            if (error) reject(error);
            else resolve(line);
        }
        child.stdout.on('data', onData);
        child.once('exit', onExit);
    });
}

// A contender exits by itself once its stdin closes, but that only happens when the parent
// exits - and the parent cannot exit while these pipes are open. On a failing assertion the
// harness only sets process.exitCode, so without an explicit kill the two deadlock and the
// run hangs with live children. Track every spawn so the caller's finally can reap them.
const liveLockContenders = new Set();

function reapLockContenders() {
    for (const child of liveLockContenders) {
        try { child.kill(); } catch {}
    }
    liveLockContenders.clear();
}

function spawnLockContender(stateRoot, authorized) {
    const lockModule = path.join(ROOT, 'pos-spooler-printer', 'v2', 'state-root-lock.js');
    const script = `
        const fs = require('fs');
        const path = require('path');
        const readline = require('readline');
        const { acquireStateRootLock } = require(${JSON.stringify(lockModule)});
        const stateRoot = ${JSON.stringify(stateRoot)};
        JSON.parse(fs.readFileSync(path.join(stateRoot, 'agent.lock'), 'utf8'));
        process.stdout.write('READY\\n');
        // One interface for both commands. Attaching a second readline to the same stdin
        // lets the first one consume the RELEASE line, so the contender never exits and
        // the parent's wait for that exit never returns.
        let held = null;
        readline.createInterface({ input: process.stdin }).on('line', () => {
            if (held) { held.release(); process.exit(0); }
            try {
                held = acquireStateRootLock({ stateRoot, staleReclaimAuthorized: ${authorized ? 'true' : 'false'} });
                process.stdout.write('ACQUIRED\\n');
            } catch (error) {
                process.stdout.write('ERROR:' + (error.code || error.message) + '\\n');
                process.exit(0);
            }
        });
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    liveLockContenders.add(child);
    child.once('exit', () => liveLockContenders.delete(child));
    return child;
}

async function testStateRootLock() {
    const stateRoot = temporaryRoot('pos-v2-lock-');
    try {
        const first = acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true });
        assert.throws(() => acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true }), /STATE_ROOT_LOCKED/);
        first.release();
        const second = acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true });
        second.release();

        // Stale lock without authorization must fail closed
        fs.writeFileSync(path.join(stateRoot, 'agent.lock'), JSON.stringify({
            pid: 2147483647,
            started_at: new Date().toISOString(),
            boot_id: 'stale'
        }));
        assert.throws(
            () => acquireStateRootLock({ stateRoot, staleReclaimAuthorized: false }),
            error => error.code === 'STATE_ROOT_LOCKED',
            'calling stale reclaim without explicit startup-arbiter authorization must fail closed'
        );

        // Stale lock with authorization succeeds for the authorized winner
        const winner = acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true });
        // Second contender observes the live winner and is rejected
        assert.throws(
            () => acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true }),
            error => error.code === 'STATE_ROOT_LOCKED'
        );
        winner.release();

        fs.writeFileSync(path.join(stateRoot, 'agent.lock'), JSON.stringify({
            pid: 2147483647,
            started_at: new Date().toISOString(),
            boot_id: 'barrier-stale'
        }));
        const contenderA = spawnLockContender(stateRoot, true);
        const contenderB = spawnLockContender(stateRoot, true);
        await Promise.all([
            waitForLine(contenderA, line => line === 'READY'),
            waitForLine(contenderB, line => line === 'READY')
        ]);
        const outcomeA = waitForLine(contenderA, line => line === 'ACQUIRED' || line.startsWith('ERROR:'));
        const outcomeB = waitForLine(contenderB, line => line === 'ACQUIRED' || line.startsWith('ERROR:'));
        contenderA.stdin.write('GO\n');
        contenderB.stdin.write('GO\n');
        const outcomes = await Promise.all([outcomeA, outcomeB]);
        assert.deepStrictEqual(
            [...outcomes].sort(),
            ['ACQUIRED', 'ERROR:STATE_ROOT_LOCKED'],
            'two production-authorized contenders must produce exactly one state-root owner'
        );

        const replacement = spawnLockContender(stateRoot, true);
        assert.strictEqual(await waitForLine(replacement, line => line === 'READY'), 'READY');
        const replacementOutcome = waitForLine(replacement, line => line === 'ACQUIRED' || line.startsWith('ERROR:'));
        replacement.stdin.write('GO\n');
        assert.strictEqual(await replacementOutcome, 'ERROR:STATE_ROOT_LOCKED', 'live Node ownership must survive helper handoff');
        const winningContender = outcomes[0] === 'ACQUIRED' ? contenderA : contenderB;
        winningContender.stdin.write('RELEASE\n');
        // Bounded: an unbounded wait here is what left orphaned node processes on the
        // machine for over an hour when the contender failed to see its RELEASE line.
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('state-root contender did not exit after RELEASE')), 3000);
            winningContender.once('exit', () => { clearTimeout(timer); resolve(); });
        });
    } finally {
        reapLockContenders();
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }

    // A reclaim that dies midway must not lock the station out permanently.
    const crashRoot = temporaryRoot('pos-v2-lock-crash-');
    try {
        const staleOwner = { pid: 2147483647, started_at: new Date().toISOString(), boot_id: 'interrupted-stale' };
        const tombstone = path.join(
            crashRoot,
            `agent.lock.stale-${crypto.createHash('sha256').update(`${staleOwner.pid}:${staleOwner.boot_id}`).digest('hex')}`
        );

        // A live claimant is a concurrent reclaim: stay locked out and leave it alone.
        fs.writeFileSync(path.join(crashRoot, 'agent.lock'), JSON.stringify(staleOwner));
        fs.writeFileSync(tombstone, JSON.stringify({ pid: process.pid, boot_id: 'live-claimant' }));
        assert.throws(
            () => acquireStateRootLock({ stateRoot: crashRoot, staleReclaimAuthorized: true }),
            error => error.code === 'STATE_ROOT_LOCKED' && error.reason === undefined,
            'a live concurrent reclaim must keep every other contender out'
        );
        assert(fs.existsSync(tombstone), 'a live claimant tombstone must survive');

        // Atomic publication means an unreadable shared tombstone is corruption, not a
        // half-written live claim. An authorized start quarantines it for diagnosis and
        // fails; the next authorized restart may reclaim. Never acquire in the same call.
        for (const corrupt of ['', '{"pid":12', '{}']) {
            fs.writeFileSync(tombstone, corrupt);
            assert.throws(
                () => acquireStateRootLock({ stateRoot: crashRoot, staleReclaimAuthorized: true }),
                error => error.code === 'STATE_ROOT_LOCKED' && error.reason === 'corrupt_tombstone_quarantined',
                `an unreadable tombstone (${JSON.stringify(corrupt)}) must be quarantined`
            );
            assert(!fs.existsSync(tombstone), 'a quarantined tombstone must leave the shared name');
            assert(
                fs.readdirSync(crashRoot).some(name => name.startsWith(path.basename(tombstone)) && name.includes('.corrupt-')),
                'quarantine must keep diagnostic evidence'
            );
        }
        const recoveredFromCorruptTombstone = acquireStateRootLock({ stateRoot: crashRoot, staleReclaimAuthorized: true });
        recoveredFromCorruptTombstone.release();

        fs.writeFileSync(path.join(crashRoot, 'agent.lock'), JSON.stringify(staleOwner));

        // A dead claimant is an interrupted reclaim: clear it and recover on next start.
        fs.writeFileSync(tombstone, JSON.stringify({ pid: 2147483646, boot_id: 'dead-claimant' }));
        assert.throws(
            () => acquireStateRootLock({ stateRoot: crashRoot, staleReclaimAuthorized: true }),
            error => error.code === 'STATE_ROOT_LOCKED' && error.reason === 'interrupted_reclaim_cleared',
            'an interrupted reclaim must be reported, not silently retried'
        );
        const recovered = acquireStateRootLock({ stateRoot: crashRoot, staleReclaimAuthorized: true });
        assert.deepStrictEqual(
            fs.readdirSync(crashRoot).filter(name => name.startsWith('agent.lock.stale-') && !name.includes('.corrupt-')),
            [],
            'a completed reclaim must leave no live tombstone behind'
        );
        recovered.release();

        // Private claim files never grant ownership. Dead and unreadable remnants from a
        // crashed publisher must be removed on the next start, while a live claimant's
        // private file must be left alone.
        const deadClaim = path.join(crashRoot, 'agent.lock.claim-dead');
        const corruptClaim = path.join(crashRoot, 'agent.lock.claim-corrupt');
        const liveClaim = path.join(crashRoot, 'agent.lock.claim-live');
        fs.writeFileSync(deadClaim, JSON.stringify({ pid: 2147483646, boot_id: 'dead-private-claim' }));
        fs.writeFileSync(corruptClaim, '');
        fs.writeFileSync(liveClaim, JSON.stringify({ pid: process.pid, boot_id: 'live-private-claim' }));
        const cleanupProof = acquireStateRootLock({ stateRoot: crashRoot, staleReclaimAuthorized: true });
        assert(!fs.existsSync(deadClaim), 'a dead private claim must be cleaned up');
        assert(!fs.existsSync(corruptClaim), 'an unreadable private claim must be cleaned up safely');
        assert(fs.existsSync(liveClaim), 'a live private claim must not be removed');
        cleanupProof.release();
        fs.unlinkSync(liveClaim);
    } finally {
        fs.rmSync(crashRoot, { recursive: true, force: true });
    }

    // The tombstone must never be observable half-written. If it were, a contender would
    // read it as damaged and clear it, re-opening the claim to a third contender while the
    // original reclaim was still running - and two processes could own the state root.
    // Static corrupt fixtures cannot catch that; this inspects the live publish.
    const publishRoot = temporaryRoot('pos-v2-lock-publish-');
    const realLinkSync = fs.linkSync;
    try {
        fs.writeFileSync(path.join(publishRoot, 'agent.lock'), JSON.stringify({
            pid: 2147483647,
            started_at: new Date().toISOString(),
            boot_id: 'publish-stale'
        }));
        const publishes = [];
        fs.linkSync = (source, destination) => {
            if (path.basename(destination).startsWith('agent.lock.stale-')) {
                let claimant = null;
                try { claimant = JSON.parse(fs.readFileSync(source, 'utf8')); } catch {}
                publishes.push({ existedBefore: fs.existsSync(destination), claimant });
            }
            return realLinkSync.call(fs, source, destination);
        };
        acquireStateRootLock({ stateRoot: publishRoot, staleReclaimAuthorized: true }).release();
        assert(publishes.length > 0, 'the stale reclaim must publish its tombstone atomically');
        for (const published of publishes) {
            assert.strictEqual(published.existedBefore, false, 'a tombstone must never be published over an existing claim');
            assert(Number.isInteger(published.claimant?.pid) && typeof published.claimant?.boot_id === 'string',
                'a tombstone must already name its claimant at the instant it becomes visible');
        }
    } finally {
        fs.linkSync = realLinkSync;
        fs.rmSync(publishRoot, { recursive: true, force: true });
    }
    return { node_process_lock: true, stale_pid_recovered: true, release_reacquires: true, unauthorized_stale_rejected: true, controlled_two_process_barrier: true, interrupted_reclaim_recovers: true, tombstone_published_atomically: true, corrupt_tombstone_quarantined: true, abandoned_claims_cleaned: true };
}

async function testHelperFatalRouting() {
    let shutdowns = 0;
    let exitCode = null;
    const handler = createHelperEventHandler({
        shutdown: async () => { shutdowns += 1; },
        exit: code => { exitCode = code; },
        log: () => {}
    });
    await handler({ type: 'fatal', code: 'STATE_ROOT_LOCKED' });
    assert.strictEqual(shutdowns, 1);
    assert.strictEqual(exitCode, 73);
    return { helper_fatal_shutdowns: shutdowns, duplicate_exit_code: exitCode };
}

(async () => {
    const rows = [];
    rows.push(await run('v2 package/runtime inspection', { socket_io_imports: 0, v1_poll_references: 0 }, async () => {
        assert(!/socket\.io|socket\.io-client|\/poll|io\.on\(['"]connection/.test(V2_SOURCE), 'V2 entry must not import or route V1/socket delivery');
        assert(/createSyncClient/.test(V2_SOURCE));
        assert.strictEqual(startupJitterMs(() => 0.5), 1000);
    }, 'source_scan'));
    rows.push(await run('idle agent budgets 1/5/10/50/100', await testIdleAgents(), async () => {}, 'fake_clock_probe'));
    rows.push(await run('timeout/5xx/revocation recovery', await testRuntimeRecoveryAndRevocation(), async () => {}, 'fake_clock_probe'));
    rows.push(await run('lost response, restart, cancellation, crash transitions', await testDurabilityAndCancellation(), async () => {}, 'real_journal'));
    rows.push(await run('lost registration/sync/result response replay', { same_identity: true, accepted_outbox_durable: true, no_duplicate_claimant: true }, async () => {
        const runtimeSource = fs.readFileSync(path.join(ROOT, 'pos-spooler-printer', 'v2', 'agent-runtime.js'), 'utf8');
        const storeSource = fs.readFileSync(path.join(ROOT, 'pos-spooler-printer', 'v2', 'job-store.js'), 'utf8');
        assert(/registeredAttempted/.test(runtimeSource));
        assert(/unconfirmedAccepted\(\)/.test(runtimeSource) && /outbox\(\)/.test(runtimeSource));
        assert(/idempotency_key/.test(storeSource) && /PAYLOAD_IDENTITY_CONFLICT/.test(storeSource));
    }, 'source_scan'));
    rows.push(await run('concurrent capacity-one and station ownership guards', { station_lock_for_update: true, capacity_clamped_to_50: true, v1_station_protocol_guard: true }, async () => {
        assert(/spooler_stations[\s\S]*FOR UPDATE/.test(CLAIM_SOURCE));
        assert(/capacity/.test(CLAIM_SOURCE) && /Math\.min\(.*50/.test(CLAIM_SOURCE));
    }, 'source_scan'));
    rows.push(await run('second process/state-root and DPAPI gate', { ...(await testStateRootLock()), ...(await testHelperFatalRouting()), mutex_defence_in_depth: true, dpapi_scope: 'LocalMachine' }, async () => {
        assert(/STATE_ROOT_LOCKED/.test(HELPER_SOURCE));
        assert(/Mutex/.test(HELPER_SOURCE) && /ProtectedData\.Protect/.test(HELPER_SOURCE));
        assert(V2_SOURCE.indexOf('startPlatformHelper') < V2_SOURCE.indexOf('acquireStateRootLock'), 'helper startup arbitration must precede state-root lock acquisition');
        assert(V2_SOURCE.includes('staleReclaimAuthorized: true'), 'state-root lock must require explicit stale reclaim authorization');
    }, 'real_child_process'));
    rows.push(await run('offline printer recovery and lane isolation', await testLaneIsolation(), async () => {}, 'in_process_workers'));
    rows.push(await run('replacement and retryable updater recovery', { unresolved_agent_rows: 'outcome_unknown', env_preserved: true, retryable_stop_replace_start: true }, async () => {
        const replacementSource = fs.readFileSync(path.join(ROOT, 'backend', 'services', 'spoolerAgents.js'), 'utf8');
        const updaterSource = fs.readFileSync(path.join(ROOT, 'deployment', 'windows', 'Update-Spooler.ps1'), 'utf8');
        assert(/AGENT_REPLACED_OUTCOME_UNKNOWN/.test(replacementSource));
        assert(/Set-SpoolerApplicationScript/.test(updaterSource) && /Assert-EnvUnchanged/.test(updaterSource));
        assert(!/update-transaction\.json|Repair-SpoolerStartup/.test(updaterSource));
    }, 'source_scan'));
    rows.push(await run('transport hash/marker boundary', { marker_before_bytes: true, post_marker_failure: 'uncertain' }, async () => {
        const transportSource = fs.readFileSync(path.join(ROOT, 'pos-spooler-printer', 'v2', 'printer-transports.js'), 'utf8');
        assert(/verifyArtifactHash\(artifact\)/.test(transportSource));
        const tcpSend = transportSource.slice(transportSource.indexOf('async function send'), transportSource.indexOf('function createWindowsTransport'));
        assert(tcpSend.indexOf('await markTransportStarted') < tcpSend.indexOf('await streamArtifact'));
        assert(/failureClass.*uncertain/.test(transportSource));
    }, 'source_scan'));
    rows.push(await run('helper/Typst hang survival gate', { helper_timeout_bounded: true, renderer_timeout_bounded: true, no_partial_artifact: true }, async () => {
        const helperSource = fs.readFileSync(path.join(ROOT, 'pos-spooler-printer', 'v2', 'platform-helper.js'), 'utf8');
        const rendererSource = fs.readFileSync(path.join(ROOT, 'pos-spooler-printer', 'v2', 'typst-renderer.js'), 'utf8');
        assert(/PLATFORM_HELPER_TIMEOUT/.test(helperSource));
        assert(/compileMs|TYPST_TIMEOUT/.test(rendererSource));
        assert(/\.tmp/.test(rendererSource));
    }, 'source_scan'));
    console.log(JSON.stringify({
        suite: 'spooler-v2-hostile-runtime',
        commit,
        machine,
        rows,
        physical_matrix: 'not run: this host has no controlled USB/shared/TCP/write-only/paper-feedback printer lab'
    }, null, 2));
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
