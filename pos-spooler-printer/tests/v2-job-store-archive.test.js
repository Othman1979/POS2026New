const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { openJobStore } = require('../v2/job-store');
const { printerEndpoint } = require('../v2/printer-endpoint');

const job = id => ({ queue_id: id, idempotency_key: `archive-${id}`, payload_hash: 'a'.repeat(64),
    printer_id: 5, printer_type: 'network', network_ip: '127.0.0.1', network_port: 9100,
    print_type: 'kitchen', data: { order_note: 'بدون ملح', items: [{ name: 'كيلو كباب', quantity: 1 }] } });
const archiveFile = (root, id) => {
    const dir = path.join(root, 'jobs', 'archive');
    return path.join(dir, fs.readdirSync(dir).find(name => name.startsWith(`${id}-`)));
};
function fixture(test) {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-archive-test-'));
    try { test(stateRoot); } finally { fs.rmSync(stateRoot, { recursive: true, force: true }); }
}

fixture(stateRoot => {
    let store = openJobStore({ stateRoot });
    store.accept(job(1)); store.confirmAccepted([1]);
    store.recordResult(1, { outcome: 'completed' }); store.confirmResults([1]);
    for (let pass = 0; pass < 2; pass++) {
        const file = archiveFile(stateRoot, 1);
        const saved = JSON.parse(fs.readFileSync(file));
        assert.equal(saved.compact, 1);
        assert.equal(saved.job, null, 'a confirmed job keeps its identity, not its payload');
        assert.equal(saved.idempotency_key, 'archive-1');
        assert.equal(saved.payload_hash, 'a'.repeat(64));
        assert.equal(saved.state, 'completed');
        assert(!fs.readFileSync(file, 'utf8').includes('كيلو'), 'the payload must not be on disk any more');
        assert.deepEqual(store.get(1), saved);
        assert.deepEqual(store.accept(job(1)), saved, 'identical server replay stays terminal');
        assert.deepEqual(store.requestCancel(1), saved);
        assert.throws(() => store.accept({ ...job(1), payload_hash: 'b'.repeat(64) }), /PAYLOAD_IDENTITY_CONFLICT/);
        assert.equal(store.runnable().length, 0);
        assert.equal(store.health().active, 0);
        assert.deepEqual(store.outbox(), []);
        assert.deepEqual(store.unconfirmedAccepted(), []);
        store = openJobStore({ stateRoot });
    }
    store.accept(job(2));
    assert.deepEqual(store.runnable().map(row => row.queue_id), [2]);
    assert.equal(store.health().active, 1);
});

fixture(stateRoot => {
    let now = Date.parse('2026-09-01T00:00:00Z');
    let fail = '';
    const options = { stateRoot, now: () => now, beforeRename: operation => { if (operation === fail) throw new Error(`FAIL_${operation}`); } };
    let store = openJobStore(options);
    store.accept(job(3)); store.requestCancel(3); store.confirmResults([3]);
    const artifact = { path: path.join(store.artifactsDirectory, 'late.bin'), hash: 'f'.repeat(64), bytes: 4 };
    fs.writeFileSync(artifact.path, 'test');
    const original = fs.readFileSync(archiveFile(stateRoot, 3), 'utf8');
    fail = 'orphan_artifact';
    assert.throws(() => store.retainArtifactForCleanup(3, artifact), /FAIL_orphan_artifact/);
    assert.equal(fs.readFileSync(archiveFile(stateRoot, 3), 'utf8'), original);
    assert.equal(store.get(3).payload_hash, 'a'.repeat(64));
    fail = '';
    assert.deepEqual(store.retainArtifactForCleanup(3, artifact).artifact, artifact);
    store = openJobStore(options);
    assert.deepEqual(store.get(3).artifact, artifact);
    now += 2 * 86400000; store.cleanup();
    assert(fs.existsSync(artifact.path));
    now += 2 * 86400000; store.cleanup();
    assert(!fs.existsSync(artifact.path));
    assert.equal(store.get(3), null);
});

fixture(stateRoot => {
    let now = Date.parse('2026-09-01T00:00:00Z');
    let fail = '';
    const options = { stateRoot, now: () => now, beforeRename: operation => { if (operation === fail) throw new Error(`FAIL_${operation}`); } };
    let store = openJobStore(options);
    store.accept(job(4)); store.markTransportStarted(4);
    store.recordResult(4, { outcome: 'uncertain', error_code: 'PARTIAL_WRITE' }); store.confirmResults([4]);
    now += 30 * 86400000;
    store = openJobStore(options); store.cleanup();
    assert.deepEqual(store.endpointHold(job(4)).queue_ids, [4]);
    assert.deepEqual(store.get(4).job, job(4));
    fail = 'endpoint_recovery';
    assert.throws(() => store.recoverEndpoint(printerEndpoint(job(4)), [4]), /FAIL_endpoint_recovery/);
    assert(store.endpointHold(job(4)));
    fail = '';
    store.recoverEndpoint(printerEndpoint(job(4)), [4]);
    assert.equal(store.endpointHold(job(4)), null);
    assert.deepEqual(store.get(4).job, job(4));
    now -= 29 * 86400000; // a recovered record then ages out like any settled job
    store = openJobStore(options);
    assert.equal(store.endpointHold(job(4)), null);
    assert.equal(store.get(4).state, 'uncertain', 'recovery must not replay a ticket');
    assert.equal(store.runnable().length, 0);
});

fixture(stateRoot => {
    const store = openJobStore({ stateRoot, beforeRename: operation => { if (operation === 'archive_metadata') throw new Error('FAIL_archive_metadata'); } });
    store.accept(job(5)); store.recordResult(5, { outcome: 'completed' });
    assert.throws(() => store.confirmResults([5]), /FAIL_archive_metadata/);
    for (const check of [store, openJobStore({ stateRoot })]) {
        assert.equal(check.health().active, 1, 'a failed archive write leaves the job where it was');
        assert.deepEqual(check.outbox().map(row => row.queue_id), [5], 'and its result is still owed to the server');
        assert.equal(check.runnable().length, 0);
        assert.equal(check.accept(job(5)).state, 'completed');
    }
    const retry = openJobStore({ stateRoot });
    retry.confirmResults([5]);
    assert.equal(retry.health().active, 0);
    assert.equal(openJobStore({ stateRoot }).get(5).state, 'completed');
});

fixture(stateRoot => {
    const store = openJobStore({ stateRoot });
    store.accept(job(6)); store.recordResult(6, { outcome: 'completed' }); store.confirmResults([6]);
    const file = archiveFile(stateRoot, 6);
    const saved = fs.readFileSync(file, 'utf8');
    const read = fs.readFileSync;
    let archiveReads = 0;
    try {
        fs.readFileSync = (target, ...args) => {
            if (String(target) === file) archiveReads++;
            return read(target, ...args);
        };
        for (let i = 0; i < 20; i++) {
            store.health(); store.runnable(); store.unconfirmedAccepted(); store.outbox();
        }
        assert.equal(archiveReads, 0, 'routine reads must not fetch archived records');
        assert.equal(store.get(6).payload_hash, 'a'.repeat(64));
        assert.equal(archiveReads, 1, 'the archived record is loaded on demand');
    } finally { fs.readFileSync = read; }
    for (const corrupt of ['{truncated', JSON.stringify({ ...JSON.parse(saved), payload_hash: 'b'.repeat(64) })]) {
        fs.writeFileSync(file, corrupt);
        assert.throws(() => store.get(6));
        assert.throws(() => store.accept(job(6)), 'unreadable archive must never become a new print');
        assert.equal(store.runnable().length, 0);
        assert.equal(store.health().active, 0);
    }
    fs.writeFileSync(file, saved);
    assert.equal(store.get(6).state, 'completed');
    // A duplicate stale active file must not override an acknowledged archive.
    fs.writeFileSync(path.join(stateRoot, 'jobs', 'active', path.basename(file)), JSON.stringify({ ...JSON.parse(saved), state: 'queued', result: null }));
    const reopened = openJobStore({ stateRoot });
    assert.equal(reopened.runnable().length, 0);
    assert.equal(reopened.health().active, 0);
    assert.equal(reopened.get(6).state, 'completed');
});

const measurement = JSON.parse(execFileSync(process.execPath, ['--expose-gc',
    path.resolve(__dirname, '../../scripts/reviews/spooler-journal-performance.cjs'), '--sample', '--archives=1000', '--payload-bytes=16384'],
    { encoding: 'utf8', timeout: 60000 }));
console.log('archive working set:', JSON.stringify(measurement));
assert(measurement.retained_heap_mib < 6, `Acknowledged payloads retained ${measurement.retained_heap_mib.toFixed(2)} MiB for 1000 archived jobs`);
console.log('v2-job-store-archive tests passed');
