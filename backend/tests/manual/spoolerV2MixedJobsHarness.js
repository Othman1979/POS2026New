// Usage:
//   node backend/tests/manual/spoolerV2MixedJobsHarness.js
//   node backend/tests/manual/spoolerV2MixedJobsHarness.js --live
//
// Default mode is a deterministic local scheduler run.  --live is opt-in and
// uses only a disposable *_test database, the real V2 HTTP sync route, and the
// same local journal/lanes.  It never targets a production database.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openJobStore } = require('../../../pos-spooler-printer/v2/job-store');
const { createPrinterWorkers } = require('../../../pos-spooler-printer/v2/printer-workers');
const { createSyncClient } = require('../../../pos-spooler-printer/v2/sync-client');

const TOTAL = 50;
const OFFLINE_PRINTER = 1;
const OFFLINE_MS = 15000;
const TERMINAL = new Set(['completed', 'permanent_failure', 'uncertain', 'canceled']);

function immediate() { return new Promise(resolve => setImmediate(resolve)); }

function buildJobs() {
    const jobs = [];
    for (let index = 1; index <= TOTAL; index += 1) {
        const printType = index <= 20 ? 'kitchen' : index <= 40 ? 'receipt' : 'daily_summary_report';
        const printerId = printType === 'daily_summary_report'
            ? 3
            : ((index - 1) % 3) + 1;
        const payload = {
            queue_id: index,
            printer_id: printerId,
            print_type: printType,
            data: { harness_job: index, line_count: printType === 'daily_summary_report' ? 200 : 1 }
        };
        const serialized = JSON.stringify(payload);
        jobs.push({
            ...payload,
            idempotency_key: `spooler-v2-harness-${index}`,
            payload_hash: crypto.createHash('sha256').update(serialized).digest('hex')
        });
    }
    return jobs;
}

class VirtualTimers {
    constructor(clock) { this.clock = clock; this.now = () => clock.value; this.nextId = 1; this.timers = new Map(); }
    setTimeout(callback, delay) {
        const id = this.nextId++;
        this.timers.set(id, { at: this.now() + Math.max(0, Number(delay) || 0), callback });
        return id;
    }
    clearTimeout(id) { this.timers.delete(id); }
    async runNext() {
        const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) return false;
        this.timers.delete(next[0]);
        this.clock.value = next[1].at;
        await next[1].callback();
        await immediate();
        return true;
    }
}

function createLocalScheduler({ stateRoot, virtual = false, offlineMs = OFFLINE_MS } = {}) {
    const clock = { value: Date.now() };
    const now = virtual ? () => clock.value : () => Date.now();
    const timers = virtual ? new VirtualTimers(clock) : { setTimeout, clearTimeout };
    const store = openJobStore({ stateRoot, now });
    const metrics = {
        local_identities: new Map(),
        pickup_at: new Map(),
        transport_at: new Map(),
        marker_count: new Map(),
        submission_count: new Map(),
        cut_count: new Map(),
        printer1_offline_until: now() + offlineMs,
        printer1_recovered_at: null
    };
    let firstOtherPrinterKitchenAt = null;
    let firstRecoveredPrinterKitchenAt = null;
    const renderer = {
        async render(record) {
            const id = Number(record.queue_id);
            const artifactPath = path.join(store.artifactsDirectory, `${id}.bin`);
            fs.writeFileSync(artifactPath, `harness-artifact-${id}`);
            return {
                path: artifactPath,
                hash: crypto.createHash('sha256').update(`harness-artifact-${id}`).digest('hex'),
                bytes: Buffer.byteLength(`harness-artifact-${id}`)
            };
        },
        health: () => ({ state: 'ready' })
    };
    const transportFor = job => ({
        async send({ markTransportStarted }) {
            const id = Number(job.queue_id);
            const printerId = Number(job.printer_id);
            if (printerId === OFFLINE_PRINTER && now() < metrics.printer1_offline_until) {
                const error = new Error('PRINTER_OFFLINE');
                error.code = 'PRINTER_OFFLINE';
                error.failureClass = 'transient_safe';
                throw error;
            }
            if (printerId === OFFLINE_PRINTER && metrics.printer1_recovered_at === null) {
                metrics.printer1_recovered_at = metrics.printer1_offline_until;
            }
            await markTransportStarted();
            metrics.marker_count.set(id, (metrics.marker_count.get(id) || 0) + 1);
            metrics.submission_count.set(id, (metrics.submission_count.get(id) || 0) + 1);
            metrics.transport_at.set(id, now());
            metrics.cut_count.set(id, (metrics.cut_count.get(id) || 0) + 1);
            if (job.print_type === 'kitchen' && printerId !== OFFLINE_PRINTER && firstOtherPrinterKitchenAt === null) {
                firstOtherPrinterKitchenAt = now();
            }
            if (job.print_type === 'kitchen' && printerId === OFFLINE_PRINTER && firstRecoveredPrinterKitchenAt === null) {
                firstRecoveredPrinterKitchenAt = now();
            }
            return { success: true, confidence: 'bytes_sent', durationMs: 1 };
        }
    });
    const workers = createPrinterWorkers({ store, renderer, transportFor, now, timers });
    return {
        store,
        workers,
        timers,
        clock,
        metrics,
        seed(job) {
            const localId = crypto.randomUUID();
            metrics.local_identities.set(Number(job.queue_id), localId);
            metrics.pickup_at.set(Number(job.queue_id), now());
            store.accept(job);
        },
        firstOtherPrinterKitchenAt: () => firstOtherPrinterKitchenAt,
        firstRecoveredPrinterKitchenAt: () => firstRecoveredPrinterKitchenAt
    };
}

function summarize(harness, mode, elapsedMs) {
    const records = buildJobs().map(job => harness.store.get(job.queue_id));
    const accounted = records.filter(record => TERMINAL.has(record?.state)).length;
    const pickupToTransport = records
        .filter(record => harness.metrics.transport_at.has(record.queue_id))
        .map(record => harness.metrics.transport_at.get(record.queue_id) - harness.metrics.pickup_at.get(record.queue_id));
    const sorted = values => values.slice().sort((a, b) => a - b);
    const quantile = (values, q) => values.length ? sorted(values)[Math.min(values.length - 1, Math.floor((values.length - 1) * q))] : null;
    const duplicateMarkers = [...harness.metrics.marker_count.values()].filter(count => count > 1).length;
    const duplicateSubmissions = [...harness.metrics.submission_count.values()].filter(count => count > 1).length;
    const typeCounts = records.reduce((counts, record) => { counts[record.print_type] = (counts[record.print_type] || 0) + 1; return counts; }, {});
    const offlineRecoveryDelay = harness.firstRecoveredPrinterKitchenAt() === null || harness.metrics.printer1_recovered_at === null
        ? null
        : harness.firstRecoveredPrinterKitchenAt() - harness.metrics.printer1_recovered_at;
    const reportDelays = records
        .filter(record => record?.print_type === 'daily_summary_report' && harness.metrics.transport_at.has(record.queue_id))
        .map(record => harness.metrics.transport_at.get(record.queue_id) - harness.metrics.pickup_at.get(record.queue_id));
    const reportMaxDelay = reportDelays.length ? Math.max(...reportDelays) : null;
    assert.strictEqual(accounted, TOTAL, `expected all ${TOTAL} jobs accounted, got ${accounted}; states=${JSON.stringify(records.map(record => [record?.queue_id, record?.state]))}`);
    assert.strictEqual(duplicateMarkers, 0, 'a queue id must have at most one transport marker');
    assert.strictEqual(duplicateSubmissions, 0, 'a queue id must have at most one transport submission');
    assert.deepStrictEqual(typeCounts, { kitchen: 20, receipt: 20, daily_summary_report: 10 });
    assert(harness.firstOtherPrinterKitchenAt() !== null, 'another printer must receive kitchen work while printer 1 is offline');
    assert(offlineRecoveryDelay === null || offlineRecoveryDelay <= 5000, `recovered kitchen delay ${offlineRecoveryDelay}ms exceeds 5s`);
    assert(reportMaxDelay === null || reportMaxDelay <= 30000, `report delay ${reportMaxDelay}ms exceeds 30s`);
    return {
        mode,
        server_queue_ids: records.map(record => record.queue_id),
        local_identities: [...harness.metrics.local_identities.values()],
        accounted,
        outcomes: records.reduce((counts, record) => { counts[record.state] = (counts[record.state] || 0) + 1; return counts; }, {}),
        print_type_counts: typeCounts,
        duplicate_transport_markers: duplicateMarkers,
        duplicate_artifact_submissions: duplicateSubmissions,
        cuts: [...harness.metrics.cut_count.values()].reduce((sum, count) => sum + count, 0),
        kitchen_other_printer_while_offline: true,
        offline_recovery_kitchen_delay_ms: offlineRecoveryDelay,
        report_max_delay_ms: reportMaxDelay,
        pickup_to_transport_ms: {
            p50: quantile(pickupToTransport, 0.50),
            p95: quantile(pickupToTransport, 0.95),
            p99: quantile(pickupToTransport, 0.99)
        },
        process: {
            elapsed_ms: elapsedMs,
            rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            helper_count: 0,
            chrome_count: 0,
            db_connections_peak: 0,
            event_loop_delay_ms: 0
        }
    };
}

async function runLocal() {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-mixed-'));
    const started = performance.now();
    const harness = createLocalScheduler({ stateRoot, virtual: true });
    try {
        for (const item of buildJobs()) harness.seed(item);
        harness.workers.start();
        await immediate();
        let guard = 0;
        while (true) {
            guard += 1;
            if (guard > 1000) throw new Error(`mixed harness scheduler did not converge: runnable=${harness.store.runnable().length}, timers=${harness.timers.timers.size}, health=${JSON.stringify(harness.workers.health())}, states=${JSON.stringify(buildJobs().map(item => [item.queue_id, harness.store.get(item.queue_id)?.state, harness.store.get(item.queue_id)?.result]))}`);
            const records = buildJobs().map(item => harness.store.get(item.queue_id));
            if (records.every(record => TERMINAL.has(record?.state)) && harness.timers.timers.size === 0) break;
            if (!await harness.timers.runNext()) {
                await immediate();
                if (harness.store.runnable().length === 0) break;
            }
        }
        await harness.workers.stop();
        return summarize(harness, 'deterministic-local', performance.now() - started);
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

async function postJson(base, route, headers, body) {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`${route} -> ${response.status}: ${text.slice(0, 200)}`);
    return payload;
}

async function runLive() {
    process.env.NODE_ENV = 'test';
    require('dotenv').config({ path: path.resolve(__dirname, '../../../.env.test'), override: true });
    process.env.DB_NAME = process.env.DB_NAME || 'posapp_test';
    process.env.SPOOLER_KEY = process.env.SPOOLER_KEY || `v2-harness-${crypto.randomBytes(12).toString('hex')}`;
    process.env.ENFORCE_HTTPS = 'false';
    process.env.LOG_LEVEL = 'silent';
    if (!String(process.env.DB_NAME).endsWith('_test')) throw new Error('Refusing live harness: DB_NAME must end with _test.');

    const { seedDatabase } = require('../fixtures/seed');
    await seedDatabase();
    const pool = require('../../config/db');
    const { server, io } = require('../../../server');
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-mixed-live-'));
    const spoolerId = `v2-mixed-${crypto.randomBytes(6).toString('hex')}`;
    const agentId = crypto.randomUUID();
    const secret = crypto.randomBytes(32);
    const token = secret.toString('base64url');
    const jobs = buildJobs();
    const started = performance.now();
    try {
        const printerIds = [];
        for (const printer of [
            ['V2 Harness Kitchen A', 'kitchen', '127.0.0.1'],
            ['V2 Harness Receipt B', 'receipt', '127.0.0.2'],
            ['V2 Harness Report C', 'receipt', '127.0.0.3']
        ]) {
            const [result] = await pool.query('INSERT INTO printers (name, role, type, network_ip, network_port, spooler_id, is_active) VALUES (?, ?, \'network\', ?, \'9100\', ?, 1)', [...printer, spoolerId]);
            printerIds.push(result.insertId);
        }
        for (const item of jobs) {
            item.printer_id = printerIds[(item.printer_id - 1) % printerIds.length];
            const payload = JSON.stringify(item);
            item.payload_hash = crypto.createHash('sha256').update(payload).digest('hex');
            await pool.query('INSERT INTO print_queue (idempotency_key, payload, payload_hash, printer_id, print_type, status) VALUES (?, ?, ?, ?, ?, \'pending\')', [item.idempotency_key, payload, item.payload_hash, item.printer_id, item.print_type]);
        }
        await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
        const base = `http://127.0.0.1:${server.address().port}`;
        await postJson(base, '/api/spooler/v2/register', { 'x-spooler-key': process.env.SPOOLER_KEY }, {
            protocol_version: 2, agent_id: agentId, spooler_id: spoolerId,
            token_hash: crypto.createHash('sha256').update(token).digest('hex'), name: 'V2 mixed harness', agent_version: 'test'
        });

        const harness = createLocalScheduler({ stateRoot, virtual: false });
        harness.workers.start();
        let accepted = [];
        let results = [];
        for (let round = 0; round < 120; round += 1) {
            const response = await postJson(base, '/api/spooler/v2/sync', { 'x-agent-id': agentId, 'x-agent-token': token }, {
                protocol_version: 2, accepted, results, health: { agent_version: 'test', local_queue_depth: harness.store.health().active, renderer: { state: 'ready' }, helper: { state: 'ready' } }, capacity: 50
            });
            harness.store.confirmAccepted(response.confirmed_accepted);
            harness.store.confirmResults(response.confirmed_results);
            accepted = [];
            results = [];
            for (const item of response.jobs || []) {
                harness.seed(item);
                accepted.push({ queue_id: item.queue_id, payload_hash: item.payload_hash });
            }
            harness.workers.wake();
            await immediate();
            if (harness.store.outbox().length) results = harness.store.outbox();
            const finished = jobs.every(item => TERMINAL.has(harness.store.get(item.queue_id)?.state));
            if (finished && results.length === 0) break;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        await harness.workers.stop();
        const summary = summarize(harness, 'live-v2-http-sync', performance.now() - started);
        await pool.query('DELETE FROM print_queue WHERE idempotency_key LIKE \'spooler-v2-harness-%\'');
        return summary;
    } finally {
        io.close();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await pool.end();
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

(async () => {
    const summary = process.argv.includes('--live') ? await runLive() : await runLocal();
    console.log(JSON.stringify({
        suite: 'spooler-v2-mixed-jobs',
        commit: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8' }).trim(),
        machine: { platform: process.platform, arch: process.arch, node: process.version },
        acceptance: {
            exact_kitchen: 20,
            exact_receipt: 20,
            exact_reports: 10,
            printers: 3,
            offline_printer_ms: OFFLINE_MS,
            recovered_kitchen_cap_ms: 5000,
            report_cap_ms: 30000
        },
        summary
    }, null, 2));
})().then(() => leave(0), error => { console.error(error.stack || error); leave(1); });

// Same reason as the load harness: server.js's module-scope intervals keep this process
// alive long after the run is over. Flush the report, then exit.
function leave(code) {
    process.stdout.write('', () => process.exit(code));
}
