// Isolated journal working-set measurement. No server, database or printer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const sourcePath = path.join(repo, 'pos-spooler-printer/v2/job-store.js');
const arg = (key, fallback) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;

function sample() {
    assert(global.gc, 'Run with --expose-gc');
    const count = Number(arg('archives', '1000'));
    const payloadBytes = Number(arg('payload-bytes', '8192'));
    assert(Number.isInteger(count) && count >= 0 && count <= 50000);
    assert(Number.isInteger(payloadBytes) && payloadBytes >= 0 && payloadBytes <= 1048576);
    const revision = arg('baseline', '');
    const source = revision ? execFileSync('git', ['show', `${revision}:pos-spooler-printer/v2/job-store.js`], { cwd: repo, encoding: 'utf8' }) : fs.readFileSync(sourcePath, 'utf8');
    const loaded = new Module(sourcePath, module);
    loaded.filename = sourcePath;
    loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
    loaded._compile(source, sourcePath);
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-journal-measure-'));
    try {
        const date = new Date().toISOString();
        for (const kind of ['active', 'archive']) fs.mkdirSync(path.join(stateRoot, 'jobs', kind), { recursive: true });
        for (let id = 1; id <= count + 10; id++) {
            const archived = id <= count;
            fs.writeFileSync(path.join(stateRoot, 'jobs', archived ? 'archive' : 'active', `${id}.json`), JSON.stringify({
                version: 1, queue_id: id, idempotency_key: `fixture-${id}`, payload_hash: 'a'.repeat(64),
                printer_id: 1, print_type: 'receipt', state: archived ? 'completed' : 'queued',
                accepted_confirmed: archived, created_at: date, updated_at: date,
                job: { printer_type: 'network', network_ip: '127.0.0.1', network_port: 9100, data: { payload: `${id}:${'x'.repeat(payloadBytes)}` } },
                result: archived ? { outcome: 'completed', queue_id: id } : null
            }));
        }
        global.gc();
        const before = process.memoryUsage().heapUsed;
        const started = performance.now();
        const store = loaded.exports.openJobStore({ stateRoot });
        const openMs = performance.now() - started;
        global.gc();
        const retainedHeapMiB = (process.memoryUsage().heapUsed - before) / 1048576;
        const cycle = () => {
            store.health(); store.runnable();
            for (let n = 0; n < 3; n++) { store.unconfirmedAccepted(); store.outbox(); }
        };
        for (let i = 0; i < 50; i++) cycle();
        const samples = [];
        for (let i = 0; i < 300; i++) {
            const start = performance.now(); cycle(); samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        assert.equal(store.health().active, 10);
        assert.equal(store.runnable().length, 10);
        assert.equal(store.outbox().length, 0);
        if (count) assert.equal(store.get(1).payload_hash, 'a'.repeat(64));
        return { revision: revision || 'working-tree', archives: count, active: 10, payload_bytes: payloadBytes,
            open_ms: openMs, retained_heap_mib: retainedHeapMiB, read_cycle_median_ms: samples[150], read_cycle_p95_ms: samples[285] };
    } finally {
        // Only the exact fresh OS temp directory allocated above.
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

if (process.argv.includes('--sample')) {
    console.log(JSON.stringify(sample()));
} else {
    const baseline = arg('baseline', '');
    assert(baseline, 'Supply --baseline=<pre-change commit>');
    const results = [];
    for (let round = 0; round < 3; round++) {
        for (const count of [0, 1000, 10000]) {
            for (const revision of (round % 2 ? ['', baseline] : [baseline, ''])) {
                const args = ['--expose-gc', __filename, '--sample', `--archives=${count}`];
                if (revision) args.push(`--baseline=${revision}`);
                results.push({ round: round + 1, ...JSON.parse(execFileSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: 120000 })) });
            }
        }
    }
    console.log(JSON.stringify({ note: 'Synthetic 8 KiB archived payloads plus ten active jobs. Separate processes; forced GC. Local CPU/filesystem timings, not customer print latency.', results }, null, 2));
}
