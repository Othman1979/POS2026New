const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openJobStore } = require('../v2/job-store');

// The journal keeps the one thing that stops a duplicate print: a durable accept, transport
// marker and result. Everything else is cheap, and a settled job shrinks to its identity.

const hash = 'a'.repeat(64);
const job = (id, extra = {}) => ({ queue_id: id, idempotency_key: `light-${id}`, payload_hash: hash,
    printer_id: 5, printer_type: 'network', network_ip: '127.0.0.1', network_port: 9100, print_type: 'receipt',
    data: { items: Array.from({ length: 30 }, (_, index) => ({ name: `صنف ${index}`, quantity: 1, price: 1.5 })) }, ...extra });

function fixture(test) {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-light-store-'));
    try { test(stateRoot); } finally { fs.rmSync(stateRoot, { recursive: true, force: true }); }
}
const dir = (root, kind) => path.join(root, 'jobs', kind);
const files = (root, kind) => fs.readdirSync(dir(root, kind)).filter(name => name.endsWith('.json'));
function artifactFor(store, id) {
    const artifact = { path: path.join(store.artifactsDirectory, `${id}.bin`), hash: 'f'.repeat(64), bytes: 4 };
    fs.writeFileSync(artifact.path, 'test');
    return artifact;
}

// Which writes are synced: only the records that guard a duplicate.
fixture(root => {
    const writes = [];
    let syncs = 0;
    const realFsync = fs.fsyncSync;
    fs.fsyncSync = descriptor => { syncs++; return realFsync(descriptor); };
    try {
        const store = openJobStore({ stateRoot: root, beforeRename: operation => { writes.push([operation, syncs]); syncs = 0; } });
        const artifact = artifactFor(store, 1);
        store.accept(job(1));
        store.confirmAccepted([1]);
        store.markRendered(1, artifact);
        store.markTransportStarted(1);
        store.markTransportSent(1);
        store.recordResult(1, { outcome: 'completed' });
        store.confirmResults([1]);
        assert.deepEqual(writes, [
            ['accept', 1], ['transport_started', 1], ['transport_sent', 1], ['result', 1],
            ['result_confirmation', 0], ['archive_metadata', 0]
        ], 'accept, transport marker and result are synced; accept confirmation, render and archive are not');
    } finally { fs.fsyncSync = realFsync; }
});

// Restarting where an unsynced step was lost never prints twice and never loses the job.
fixture(root => {
    const store = openJobStore({ stateRoot: root });
    store.accept(job(1)); store.confirmAccepted([1]);
    store.markRendered(1, artifactFor(store, 1));
    // Power lost here: only the synced accept is on disk.
    const restarted = openJobStore({ stateRoot: root });
    assert.equal(restarted.get(1).state, 'queued', 'renders again');
    assert.deepEqual(restarted.unconfirmedAccepted().map(row => row.queue_id), [1], 'announces the accept again; the server confirms again');
    assert.deepEqual(restarted.runnable().map(row => row.queue_id), [1]);
    // Past the transport marker the restart must hold, whatever was not written before it.
    restarted.markRendered(1, artifactFor(restarted, 1));
    restarted.markTransportStarted(1);
    const afterMarker = openJobStore({ stateRoot: root });
    assert.equal(afterMarker.get(1).state, 'uncertain');
    assert.equal(afterMarker.get(1).result.error_code, 'AGENT_RESTART_AFTER_TRANSPORT');
    assert.equal(afterMarker.runnable().length, 0, 'never resent');
    assert(afterMarker.endpointHold(job(1)), 'and the endpoint stays held');
    assert.deepEqual(afterMarker.outbox().map(row => row.queue_id), [1]);
});

// A confirmed job is kept as identity only, and its artifact goes with it (except uncertain).
fixture(root => {
    const store = openJobStore({ stateRoot: root });
    const artifacts = {};
    for (const [id, outcome] of [[1, 'completed'], [2, 'canceled'], [3, 'permanent_failure'], [4, 'uncertain']]) {
        store.accept(job(id));
        if (id === 2) { store.requestCancel(id); } else {
            store.markRendered(id, artifacts[id] = artifactFor(store, id));
            store.markTransportStarted(id);
            store.recordResult(id, { outcome, error_code: id === 3 ? 'PRINTER_CONFIG_INVALID' : null });
        }
        if (id === 2) fs.writeFileSync((artifacts[id] = artifactFor(store, id)).path, 'test');
        store.confirmResults([id]);
    }
    for (const id of [1, 3]) {
        const saved = JSON.parse(fs.readFileSync(path.join(dir(root, 'archive'), files(root, 'archive').find(name => name.startsWith(`${id}-`)))));
        assert.deepEqual(Object.keys(saved).sort(), ['accepted_confirmed', 'artifact', 'compact', 'created_at', 'idempotency_key', 'job', 'payload_hash',
            'print_type', 'printer_id', 'queue_id', 'result', 'state', 'updated_at', 'version'].sort());
        assert.equal(saved.job, null);
        assert.equal(saved.artifact, null);
        assert(!JSON.stringify(saved).includes('صنف'));
    }
    assert(!fs.existsSync(artifacts[1].path) && !fs.existsSync(artifacts[3].path), 'printed and failed artifacts are removed');
    assert(fs.existsSync(artifacts[4].path), 'an uncertain artifact is kept');
    assert.equal(store.get(4).job.data.items.length, 30, 'and so is its full record');
    assert.deepEqual(store.endpointHold(job(4)).queue_ids, [4]);
    // Replays are still recognised after a restart, from the compact records alone.
    const restarted = openJobStore({ stateRoot: root });
    for (const id of [1, 2, 3]) {
        assert.equal(restarted.accept(job(id)).state, { 1: 'completed', 2: 'canceled', 3: 'permanent_failure' }[id]);
        assert.throws(() => restarted.accept(job(id, { payload_hash: 'b'.repeat(64) })), /PAYLOAD_IDENTITY_CONFLICT/);
    }
    assert.equal(restarted.runnable().length, 0);
});

// Archives written by earlier versions (pretty-printed, whole payload) still load, are
// recognised, shrink once, and expire on the shorter retention.
fixture(root => {
    let now = Date.parse('2026-09-10T00:00:00Z');
    fs.mkdirSync(dir(root, 'archive'), { recursive: true });
    const legacy = (id, state, updatedAt, extra = {}) => {
        const created = new Date(updatedAt).toISOString();
        fs.writeFileSync(path.join(dir(root, 'archive'), `${id}-legacy.json`), `${JSON.stringify({
            version: 1, queue_id: id, idempotency_key: `light-${id}`, payload_hash: hash, printer_id: 5, print_type: 'receipt',
            state, job: job(id), artifact: null, result: { queue_id: id, outcome: state === 'completed' ? 'completed' : 'uncertain', error_code: null },
            accepted_confirmed: true, accepted_local_at: created, created_at: created, updated_at: created, ...extra
        }, null, 2)}\n`);
    };
    legacy(1, 'completed', now - 86400000);                     // inside retention
    legacy(2, 'completed', now - 10 * 86400000);                // past the new retention
    legacy(3, 'uncertain', now - 10 * 86400000);                // old, but its endpoint is still held
    legacy(4, 'uncertain', now - 86400000, { endpoint_recovered_at: new Date(now).toISOString() });
    const before = fs.statSync(path.join(dir(root, 'archive'), '1-legacy.json')).size;
    const store = openJobStore({ stateRoot: root, now: () => now });
    assert.equal(store.accept(job(1)).state, 'completed', 'a legacy archive still dedups');
    assert.throws(() => store.accept(job(1, { payload_hash: 'b'.repeat(64) })), /PAYLOAD_IDENTITY_CONFLICT/);
    assert.equal(store.get(2), null, 'an expired legacy archive is dropped on start');
    assert(!fs.existsSync(path.join(dir(root, 'archive'), '2-legacy.json')));
    assert.equal(store.get(3).state, 'uncertain');
    assert.equal(store.get(3).job.data.items.length, 30, 'a held uncertain record keeps its payload');
    assert.deepEqual(store.endpointHold(job(3)).queue_ids, [3]);
    assert.equal(store.get(4).state, 'uncertain');
    assert.equal(store.endpointHold(job(4)).queue_ids.includes(4), false, 'a recovered endpoint is not held');
    const after = fs.statSync(path.join(dir(root, 'archive'), '1-legacy.json')).size;
    assert(after < before / 5, `a legacy archive shrinks once (${before} -> ${after} bytes)`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir(root, 'archive'), '1-legacy.json'), 'utf8')).job, null);
    assert.equal(store.runnable().length, 0);
    assert.equal(store.health().active, 0);
});

console.log('v2-job-store-lightweight tests passed');
