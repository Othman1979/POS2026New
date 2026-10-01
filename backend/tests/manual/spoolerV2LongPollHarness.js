// Usage: node backend/tests/manual/spoolerV2LongPollHarness.js --live
// This harness touches only a disposable *_test database and loopback HTTP.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.argv.includes('--live')) {
    console.error('Refusing to run: pass --live for the disposable real-route experiment.');
    process.exit(2);
}

process.env.NODE_ENV = 'test';
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env.test'), override: true });
process.env.DB_NAME = process.env.DB_NAME || 'posapp_test';
process.env.SPOOLER_KEY = process.env.SPOOLER_KEY || `long-poll-${crypto.randomBytes(12).toString('hex')}`;
process.env.ENFORCE_HTTPS = 'false';
process.env.LOG_LEVEL = 'silent';
if (!String(process.env.DB_NAME).endsWith('_test')) throw new Error('Refusing live harness: DB_NAME must end with _test.');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const percentile = (values, q) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] : null;
};

async function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await sleep(10);
    }
    throw new Error(`Timed out waiting for ${label}.`);
}

async function postJson(base, route, headers, body, signal = null) {
    const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : {} };
}

async function main() {
    const { seedDatabase } = require('../fixtures/seed');
    await seedDatabase();

    // Instrument the actual route seam without changing production code. The router
    // destructures this wrapped export when server.js is loaded below.
    const syncService = require('../../services/spoolerSync');
    const originalRunAgentSync = syncService.runAgentSync;
    const syncCounts = { first: 0, second: 0 };
    syncService.runAgentSync = async (...args) => {
        if (args[2]?.health === null) syncCounts.second += 1;
        else syncCounts.first += 1;
        return originalRunAgentSync(...args);
    };

    const pool = require('../../config/db');
    const { server, io } = require('../../../server');
    const { spoolerSyncWakeHub, safePublishSpoolerSyncWake } = require('../../services/spoolerSyncWake');
    const { createSyncClient } = require('../../../pos-spooler-printer/v2/sync-client');
    const { createAgentRuntime } = require('../../../pos-spooler-printer/v2/agent-runtime');
    const { openJobStore } = require('../../../pos-spooler-printer/v2/job-store');
    const { createPrinterWorkers } = require('../../../pos-spooler-printer/v2/printer-workers');

    const prefix = `lp-${crypto.randomBytes(5).toString('hex')}`;
    const stateRoots = [];
    const tcp = { accepted: 0, remotePorts: new Set() };
    server.on('connection', socket => {
        tcp.accepted += 1;
        tcp.remotePorts.add(socket.remotePort);
    });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    const base = `http://127.0.0.1:${server.address().port}`;

    const agents = [];
    async function createAgent(index) {
        const agentId = crypto.randomUUID();
        const spoolerId = `${prefix}-station-${index}`;
        const secret = crypto.randomBytes(32).toString('base64url');
        const tokenHash = sha256(secret);
        const registered = await postJson(base, '/api/spooler/v2/register', { 'x-spooler-key': process.env.SPOOLER_KEY }, {
            protocol_version: 2,
            agent_id: agentId,
            spooler_id: spoolerId,
            token_hash: tokenHash,
            name: `Long poll ${index}`,
            agent_version: 'harness'
        });
        assert([200, 201].includes(registered.status), JSON.stringify(registered));
        const headers = { 'x-agent-id': agentId, 'x-agent-token': secret };
        const sync = (overrides = {}, signal = null) => postJson(base, '/api/spooler/v2/sync', headers, {
            protocol_version: 2,
            wait_ms: 1500,
            accepted: [],
            results: [],
            health: { local_queue_depth: 0, worker_active: 0 },
            capacity: 1,
            ...overrides
        }, signal);
        const agent = { agentId, spoolerId, secret, headers, sync };
        agents.push(agent);
        return agent;
    }

    async function idleCycles(group, cycles) {
        const requestsBefore = syncCounts.first;
        const started = performance.now();
        for (let cycle = 0; cycle < cycles; cycle += 1) {
            const responses = await Promise.all(group.map(agent => agent.sync()));
            for (const response of responses) {
                assert.strictEqual(response.status, 200);
                assert.strictEqual(response.body.next_sync_ms, 500);
            }
            await sleep(500);
        }
        const elapsedMs = performance.now() - started;
        return {
            cycles,
            agents: group.length,
            requests: syncCounts.first - requestsBefore,
            elapsed_ms: Math.round(elapsedMs),
            requests_per_second_per_agent: (syncCounts.first - requestsBefore) / (elapsedMs / 1000) / group.length
        };
    }

    async function committedWakeWorkload(group, eventsPerSecond, durationMs = 10000) {
        const before = { ...syncCounts };
        let requests = 0;
        let stop = false;
        let publishedEvents = 0;
        const startedAt = performance.now();
        const loops = group.map(async agent => {
            while (!stop) {
                const response = await agent.sync();
                requests += 1;
                if (!stop) await sleep(Number(response.body.next_sync_ms || 500));
            }
        });
        let publisher = Promise.resolve();
        if (eventsPerSecond > 0) {
            const intervalMs = 1000 / eventsPerSecond;
            // Deliberately avoid phase-locking the producer with the 1500 + 500 ms
            // timeout cadence. A phase-locked test proves coalescing but never proves
            // that a commit actually releases an already-held request.
            publisher = (async () => {
                await sleep(731);
                while (!stop) {
                    const cycleStartedAt = performance.now();
                    await pool.query(
                    "INSERT INTO audit_events (event_type, entity_type, new_value) VALUES ('spooler_long_poll_harness', 'spooler_harness', ?)",
                    [JSON.stringify({ prefix, at: Date.now(), events_per_second: eventsPerSecond })]
                    );
                    publishedEvents += 1;
                    safePublishSpoolerSyncWake();
                    const remaining = intervalMs - (performance.now() - cycleStartedAt);
                    if (remaining > 0) await sleep(remaining);
                }
            })();
        }
        await sleep(durationMs);
        stop = true;
        await Promise.all([publisher, ...loops]);
        const elapsedMs = performance.now() - startedAt;
        return {
            events_per_second: eventsPerSecond,
            published_events: publishedEvents,
            requested_duration_ms: durationMs,
            elapsed_ms: Math.round(elapsedMs),
            http_requests: requests,
            first_sync_transactions: syncCounts.first - before.first,
            second_sync_transactions: syncCounts.second - before.second,
            total_sync_transactions_per_second: ((syncCounts.first - before.first) + (syncCounts.second - before.second)) / (elapsedMs / 1000)
        };
    }

    async function legacyShortPollBaseline(group, durationMs = 10000) {
        const before = syncCounts.first;
        let requests = 0;
        let stop = false;
        const startedAt = performance.now();
        const loops = group.map(async agent => {
            while (!stop) {
                await agent.sync({ wait_ms: 0 });
                requests += 1;
                if (!stop) await sleep(500);
            }
        });
        await sleep(durationMs);
        stop = true;
        await Promise.all(loops);
        const elapsedMs = performance.now() - startedAt;
        return {
            elapsed_ms: Math.round(elapsedMs),
            http_requests: requests,
            first_sync_transactions: syncCounts.first - before,
            transactions_per_second: (syncCounts.first - before) / (elapsedMs / 1000)
        };
    }

    async function committedWakeLatencies(group, cycles = 20) {
        const latencies = [];
        for (let cycle = 0; cycle < cycles; cycle += 1) {
            const waits = group.map(agent => agent.sync());
            await waitFor(() => spoolerSyncWakeHub.snapshot().waiters === group.length, 3000, 'latency-probe waiters');
            await sleep(17 + ((cycle * 37) % 113));
            await pool.query(
                "INSERT INTO audit_events (event_type, entity_type, new_value) VALUES ('spooler_long_poll_harness', 'spooler_harness', ?)",
                [JSON.stringify({ prefix, cycle, probe: 'committed_wake_latency' })]
            );
            const committedAt = performance.now();
            safePublishSpoolerSyncWake();
            const responses = await Promise.all(waits);
            assert(responses.every(response => response.status === 200));
            latencies.push(performance.now() - committedAt);
            await sleep(500);
        }
        return {
            cycles,
            samples_ms: latencies.map(value => Math.round(value * 1000) / 1000),
            p50_ms: percentile(latencies, 0.50),
            p95_ms: percentile(latencies, 0.95),
            max_ms: Math.max(...latencies)
        };
    }

    async function insertJob(agent, key, printerId = null) {
        let selectedPrinterId = printerId;
        if (!selectedPrinterId) {
            const [printer] = await pool.query(
                "INSERT INTO printers (name, role, type, windows_name, spooler_id, is_active) VALUES (?, 'receipt', 'windows', ?, ?, 1)",
                [`${prefix}-${key}`, `${prefix}-${key}`, agent.spoolerId]
            );
            selectedPrinterId = printer.insertId;
        }
        const data = { print_type: 'receipt', printer_id: selectedPrinterId, data: { harness: key } };
        const serialized = JSON.stringify(data);
        const [row] = await pool.query(
            "INSERT INTO print_queue (payload, idempotency_key, payload_hash, printer_id, print_type, status) VALUES (?, ?, ?, ?, 'receipt', 'pending')",
            [serialized, `${prefix}-${key}`, sha256(serialized), selectedPrinterId]
        );
        return { queueId: row.insertId, printerId: selectedPrinterId };
    }

    try {
        const firstAgent = await createAgent(1);
        const tcpBeforeOneIdle = tcp.accepted;
        const oneIdle = await idleCycles([firstAgent], 20);
        oneIdle.accepted_tcp_connections = tcp.accepted - tcpBeforeOneIdle;
        assert(oneIdle.requests_per_second_per_agent <= 0.6, JSON.stringify(oneIdle));
        assert(oneIdle.accepted_tcp_connections <= 2, JSON.stringify(oneIdle));

        const five = [firstAgent];
        for (let i = 2; i <= 5; i += 1) five.push(await createAgent(i));
        const fiveIdle = await idleCycles(five, 20);
        assert(fiveIdle.requests_per_second_per_agent <= 0.6, JSON.stringify(fiveIdle));

        const held = five.map(agent => agent.sync());
        await waitFor(() => spoolerSyncWakeHub.snapshot().waiters === 5, 3000, 'five held waiters');
        const duringWait = pool.connectionTelemetrySnapshot();
        assert.strictEqual(duringWait.inUse, 0);
        for (let index = 0; index < 50; index += 1) safePublishSpoolerSyncWake();
        const floodResponses = await Promise.all(held);
        assert(floodResponses.every(response => response.status === 200));
        assert.strictEqual(spoolerSyncWakeHub.snapshot().waiters, 0);

        const targetWaits = five.map(agent => agent.sync());
        await waitFor(() => spoolerSyncWakeHub.snapshot().waiters === 5, 3000, 'targeted flood waiters');
        const targetJob = await insertJob(five[2], 'targeted-flood');
        safePublishSpoolerSyncWake();
        const targetResponses = await Promise.all(targetWaits);
        assert.deepStrictEqual(targetResponses[2].body.jobs.map(job => job.queue_id), [targetJob.queueId]);
        for (const [index, response] of targetResponses.entries()) {
            if (index !== 2) assert.deepStrictEqual(response.body.jobs, []);
        }

        const missedStarted = performance.now();
        const missedWait = five[3].sync();
        await waitFor(() => spoolerSyncWakeHub.snapshot().waiters === 1, 3000, 'missed-publish waiter');
        const missedJob = await insertJob(five[3], 'missed-publish');
        const missedFirst = await missedWait;
        assert.deepStrictEqual(missedFirst.body.jobs, []);
        await sleep(Number(missedFirst.body.next_sync_ms || 500));
        const missedSecond = await five[3].sync({ wait_ms: 0 });
        const missedLatency = performance.now() - missedStarted;
        assert.deepStrictEqual(missedSecond.body.jobs.map(job => job.queue_id), [missedJob.queueId]);
        assert(missedLatency <= 2250, `missed publish latency ${missedLatency}ms`);

        const abortController = new AbortController();
        const aborted = five[4].sync({}, abortController.signal).catch(error => error);
        await waitFor(() => spoolerSyncWakeHub.snapshot().waiters === 1, 3000, 'abort waiter');
        abortController.abort();
        await aborted;
        await waitFor(() => spoolerSyncWakeHub.snapshot().waiters === 0, 1000, 'abort cleanup');

        const workloadAgents = [];
        for (let i = 10; i <= 14; i += 1) workloadAgents.push(await createAgent(i));
        const baselineAgents = [];
        for (let i = 20; i <= 24; i += 1) baselineAgents.push(await createAgent(i));
        const legacyBaseline = await legacyShortPollBaseline(baselineAgents);
        assert(legacyBaseline.transactions_per_second >= 8, JSON.stringify(legacyBaseline));

        const wakeLatency = await committedWakeLatencies(workloadAgents);
        assert(wakeLatency.p95_ms < 500, JSON.stringify(wakeLatency));
        const workloads = [];
        for (const rate of [0, 0.5, 1, 2]) workloads.push(await committedWakeWorkload(workloadAgents, rate));
        assert(workloads[0].total_sync_transactions_per_second <= 2.5, JSON.stringify(workloads[0]));
        assert(workloads[1].total_sync_transactions_per_second < 10, JSON.stringify(workloads[1]));
        assert(workloads[2].total_sync_transactions_per_second < 10, JSON.stringify(workloads[2]));
        assert(workloads[1].second_sync_transactions > 0, JSON.stringify(workloads[1]));

        const sustainedBefore = { ...syncCounts };
        await committedWakeWorkload(workloadAgents, 4, 10000);
        const sustained = {
            first: syncCounts.first - sustainedBefore.first,
            second: syncCounts.second - sustainedBefore.second
        };
        assert(sustained.first / 10 / workloadAgents.length <= 2.05);

        const rateAgent = await createAgent(99);
        let peakInUse = 0;
        let peakEnqueued = pool.connectionTelemetrySnapshot().enqueued;
        const sampler = setInterval(() => {
            const snapshot = pool.connectionTelemetrySnapshot();
            peakInUse = Math.max(peakInUse, snapshot.inUse);
            peakEnqueued = Math.max(peakEnqueued, snapshot.enqueued);
        }, 2);
        const storm = await Promise.all(Array.from({ length: 81 }, () => rateAgent.sync()));
        clearInterval(sampler);
        assert(storm.every(response => response.status === 200));
        assert(storm.some(response => response.body.throttled === true));
        assert.strictEqual(spoolerSyncWakeHub.snapshot().waiters, 0);

        // Compose the shipped client/runtime/journal/workers around one real route job.
        const runtimeAgent = await createAgent(100);
        const runtimePrinter = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id, is_active) VALUES (?, 'receipt', 'windows', ?, ?, 1)",
            [`${prefix}-runtime`, `${prefix}-runtime`, runtimeAgent.spoolerId]
        ).then(([row]) => row.insertId);
        const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-long-poll-'));
        stateRoots.push(stateRoot);
        const store = openJobStore({ stateRoot });
        const transportStarts = [];
        const renderer = {
            async render(record) {
                const content = Buffer.from(`artifact-${record.queue_id}`);
                const artifactPath = path.join(store.artifactsDirectory, `${record.queue_id}.bin`);
                fs.writeFileSync(artifactPath, content);
                return { path: artifactPath, hash: sha256(content), bytes: content.length };
            },
            health: () => ({ state: 'ready' })
        };
        let runtime;
        const workers = createPrinterWorkers({
            store,
            renderer,
            transportFor: () => ({
                async send({ markTransportStarted }) {
                    await markTransportStarted();
                    transportStarts.push(performance.now());
                    return { success: true, confidence: 'simulated', durationMs: 1 };
                }
            }),
            onResultReady: () => runtime?.wake()
        });
        const syncClient = createSyncClient({
            baseUrl: base,
            agentId: runtimeAgent.agentId,
            secret: Buffer.from(runtimeAgent.secret, 'base64url'),
            bootstrapKey: process.env.SPOOLER_KEY,
            spoolerId: runtimeAgent.spoolerId,
            spoolerName: 'Long poll runtime',
            agentVersion: 'harness'
        });
        runtime = createAgentRuntime({ store, syncClient, worker: workers, maxLocalJobs: 5, startupJitterMs: 0 });
        runtime.start();
        const journalLatencies = [];
        const transportLatencies = [];
        const runtimeJobs = [];
        for (let cycle = 0; cycle < 20; cycle += 1) {
            await waitFor(() => spoolerSyncWakeHub.snapshot().waiters >= 1, 3000, 'runtime held sync');
            const committedAt = performance.now();
            const runtimeJob = await insertJob(runtimeAgent, `runtime-${cycle}`, runtimePrinter);
            runtimeJobs.push(runtimeJob.queueId);
            safePublishSpoolerSyncWake();
            const journalAt = await waitFor(() => store.get(runtimeJob.queueId) && performance.now(), 1000, 'runtime journal acceptance');
            await waitFor(() => transportStarts.length === cycle + 1, 1500, 'runtime transport start');
            await waitFor(async () => {
                const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [runtimeJob.queueId]);
                return row?.status === 'acknowledged';
            }, 4000, 'runtime server settlement');
            journalLatencies.push(journalAt - committedAt);
            transportLatencies.push(transportStarts[cycle] - committedAt);
        }
        await runtime.stop();
        for (const queueId of runtimeJobs) assert.strictEqual(store.get(queueId).state, 'completed');
        assert.strictEqual(transportStarts.length, runtimeJobs.length);
        const runtimeMetrics = {
            samples: runtimeJobs.length,
            committed_to_journal_p50_ms: percentile(journalLatencies, 0.50),
            committed_to_journal_p95_ms: percentile(journalLatencies, 0.95),
            committed_to_journal_max_ms: Math.max(...journalLatencies),
            committed_to_transport_start_p50_ms: percentile(transportLatencies, 0.50),
            committed_to_transport_start_p95_ms: percentile(transportLatencies, 0.95),
            committed_to_transport_start_max_ms: Math.max(...transportLatencies),
            local_acceptances: store.unconfirmedAccepted().length,
            transport_starts: transportStarts.length,
            result_outbox_after_settlement: store.outbox().length
        };
        assert(runtimeMetrics.committed_to_journal_p95_ms < 500, JSON.stringify(runtimeMetrics));
        assert(runtimeMetrics.committed_to_transport_start_p95_ms < 1000, JSON.stringify(runtimeMetrics));

        const shutdownWaits = workloadAgents.map(agent => agent.sync());
        await waitFor(() => spoolerSyncWakeHub.snapshot().waiters === 5, 3000, 'shutdown waiters');
        spoolerSyncWakeHub.close();
        await Promise.all(shutdownWaits);
        assert.strictEqual(spoolerSyncWakeHub.snapshot().waiters, 0);

        const report = {
            suite: 'spooler-v2-commit-aware-long-poll',
            commit: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8' }).trim(),
            machine: { platform: process.platform, arch: process.arch, node: process.version },
            one_idle: oneIdle,
            five_idle: fiveIdle,
            wait_pool: duringWait,
            flood: { publishes: 50, responses: floodResponses.length, waiters_after: 0 },
            targeted_queue_id: targetJob.queueId,
            missed_publish_ms: Math.round(missedLatency),
            legacy_short_poll_baseline: legacyBaseline,
            committed_wake_latency: wakeLatency,
            workloads,
            sustained_publish: sustained,
            rate_storm: { requests: storm.length, throttled: storm.filter(row => row.body.throttled).length, peak_in_use: peakInUse, peak_enqueued: peakEnqueued },
            runtime: runtimeMetrics,
            tcp: { accepted_connections: tcp.accepted, remote_ports: [...tcp.remotePorts] },
            final_pool: pool.connectionTelemetrySnapshot(),
            waiters_after_shutdown: spoolerSyncWakeHub.snapshot().waiters
        };
        console.log(JSON.stringify(report, null, 2));
    } finally {
        try { spoolerSyncWakeHub.close(); } catch (_) {}
        try { io.close(); } catch (_) {}
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await pool.query("DELETE FROM print_queue WHERE idempotency_key LIKE ?", [`${prefix}-%`]).catch(() => {});
        await pool.query("DELETE FROM printers WHERE spooler_id LIKE ?", [`${prefix}-%`]).catch(() => {});
        await pool.query("DELETE FROM spooler_agents WHERE spooler_id LIKE ?", [`${prefix}-%`]).catch(() => {});
        await pool.query("DELETE FROM spooler_stations WHERE spooler_id LIKE ?", [`${prefix}-%`]).catch(() => {});
        await pool.query("DELETE FROM audit_events WHERE event_type = 'spooler_long_poll_harness'").catch(() => {});
        await pool.end();
        for (const stateRoot of stateRoots) fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

main().then(() => leave(0), error => {
    console.error(error.stack || error);
    leave(1);
});

// server.js owns a watchdog interval that is intentionally not exported. Flush and
// exit explicitly, matching the existing mixed-jobs harness limitation.
function leave(code) {
    process.stdout.write('', () => process.exit(code));
}
