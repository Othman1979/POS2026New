const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openJobStore } = require('../v2/job-store');

function root() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-jobs-'));
}

(() => {
    const stateRoot = root();
    let writes = 0;
    const options = { stateRoot, beforeRename: operation => { if (operation === 'agent_status') writes++; } };
    try {
        let store = openJobStore(options);
        for (let i = 0; i < 100; i++) store.setAgentStatus('active');
        assert.strictEqual(writes, 1);
        store = openJobStore(options);
        store.setAgentStatus('active');
        assert.strictEqual(writes, 1, 'restart must reuse the durable status');
        store.setAgentStatus('revoked');
        assert.strictEqual(writes, 2);
        assert.strictEqual(store.agentStatus(), 'revoked');
        fs.unlinkSync(path.join(stateRoot, 'agent-runtime.json'));
        store.setAgentStatus('revoked');
        assert.strictEqual(writes, 3, 'missing status must be restored');
    } finally { fs.rmSync(stateRoot, { recursive: true, force: true }); }
})();

function job(id = 41) {
    return {
        queue_id: id,
        idempotency_key: `job-${id}`,
        payload_hash: 'a'.repeat(64),
        printer_id: 7,
        print_type: 'kitchen',
        data: { order: id }
    };
}

// A temporary Windows file lock must retry only the durable write. The job
// remains completed after restart, so transport never becomes runnable again.
for (const code of ['EPERM', 'EBUSY', 'EACCES', 'EIO']) {
    const stateRoot = root();
    const rename = fs.renameSync;
    try {
        const store = openJobStore({ stateRoot });
        store.accept(job(91));
        store.markRendered(91, { path: 'fixture.bin', hash: 'c'.repeat(64), bytes: 1 });
        store.markTransportStarted(91);
        const directory = path.join(stateRoot, 'jobs', 'active');
        const file = path.join(directory, fs.readdirSync(directory)[0]);
        const original = fs.readFileSync(file, 'utf8');
        let attempts = 0;
        fs.renameSync = (from, to) => {
            if (to === file && ++attempts <= 2) throw Object.assign(new Error('Fixture file lock'), { code });
            return rename(from, to);
        };
        if (code === 'EIO') {
            assert.throws(() => store.recordResult(91, { outcome: 'completed' }), error => error.code === code);
            assert.strictEqual(attempts, 1, 'non-lock failures must propagate immediately');
            assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
        } else {
            store.recordResult(91, { outcome: 'completed' });
            assert.strictEqual(attempts, 3);
            fs.renameSync = rename;
            const reopened = openJobStore({ stateRoot });
            assert.strictEqual(reopened.get(91).state, 'completed');
            assert.strictEqual(reopened.runnable().length, 0);
        }
        assert(!fs.readdirSync(directory).some(name => name.endsWith('.tmp')));
    } finally { fs.renameSync = rename; fs.rmSync(stateRoot, { recursive: true, force: true }); }
}

(() => {
    const stateRoot = root();
    const rename = fs.renameSync;
    try {
        const store = openJobStore({ stateRoot });
        store.accept(job(92));
        const directory = path.join(stateRoot, 'jobs', 'active');
        const file = path.join(directory, fs.readdirSync(directory)[0]);
        const original = fs.readFileSync(file, 'utf8');
        let attempts = 0;
        fs.renameSync = () => { attempts++; throw Object.assign(new Error('Persistent fixture lock'), { code: 'EPERM' }); };
        assert.throws(() => store.markTransportStarted(92), error => error.code === 'EPERM');
        assert.strictEqual(attempts, 4, 'file-lock retries must be bounded');
        assert.strictEqual(fs.readFileSync(file, 'utf8'), original, 'never unlink the previous durable record');
        assert(!fs.readdirSync(directory).some(name => name.endsWith('.tmp')));
    } finally { fs.renameSync = rename; fs.rmSync(stateRoot, { recursive: true, force: true }); }
})();

(() => {
    const stateRoot = root();
    let store = openJobStore({ stateRoot });
    assert.strictEqual(store.accept(job()).state, 'queued');
    assert.strictEqual(store.accept(job()).state, 'queued');
    assert.throws(() => store.accept({ ...job(), payload_hash: 'b'.repeat(64) }), /PAYLOAD_IDENTITY_CONFLICT/);
    assert.deepStrictEqual(store.unconfirmedAccepted(), [{ queue_id: 41, payload_hash: 'a'.repeat(64) }]);
    store.markRendered(41, { path: path.join(stateRoot, 'artifacts', '41.bin'), hash: 'c'.repeat(64), bytes: 100 });
    store.markTransportStarted(41);
    store = openJobStore({ stateRoot });
    assert.strictEqual(store.get(41).state, 'uncertain');
    assert.strictEqual(store.runnable().length, 0);
    assert.strictEqual(store.outbox()[0].outcome, 'uncertain');
    store.confirmResults([41]);
    assert.strictEqual(store.outbox().length, 0);
    assert.strictEqual(store.get(41).state, 'uncertain');

    assert.strictEqual(store.requestCancel(77).state, 'canceled');
    assert.strictEqual(store.requestCancel(77).state, 'canceled');
    assert(store.outbox().some(result => result.queue_id === 77 && result.outcome === 'canceled'));
    assert.strictEqual(store.accept(job(78)).state, 'queued');
    assert.strictEqual(store.requestCancel(78).state, 'canceled');
    assert.throws(() => store.markRendered(78, { path: 'x.bin', hash: 'h', bytes: 1 }), /JOB_NOT_RUNNABLE/);
    assert.throws(() => store.markTransportStarted(78), /JOB_TERMINAL/);
    assert.throws(() => store.recordResult(78, { outcome: 'completed' }), /JOB_TERMINAL/);
    assert.throws(() => store.recordRetry(78, { attempts: 1 }), /JOB_TERMINAL/);
    store.confirmResults([78]);
    const orphanArtifact = { path: path.join(stateRoot, 'artifacts', '78.bin'), hash: 'd'.repeat(64), bytes: 1 };
    store.retainArtifactForCleanup(78, orphanArtifact);
    store = openJobStore({ stateRoot });
    assert.deepStrictEqual(store.get(78).artifact, orphanArtifact);
    assert.strictEqual(store.get(78).state, 'canceled');
    assert.strictEqual(store.accept(job(79)).state, 'queued');
    store.markRendered(79, { path: 'x.bin', hash: 'h', bytes: 1 });
    store.markTransportStarted(79);
    assert.throws(() => store.recordRetry(79, { attempts: 1 }), /JOB_TRANSPORT_STARTED/);
    assert.strictEqual(store.runnable().length, 0);
    const startedArtifact = store.get(79).artifact;
    store.revertTransportStarted(79);
    assert.strictEqual(store.get(79).state, 'rendered');
    assert.deepStrictEqual(store.get(79).artifact, startedArtifact);
    store.recordRetry(79, { attempts: 1 });
    assert.strictEqual(store.get(79).state, 'retry_wait');
    assert.deepStrictEqual(store.get(79).artifact, startedArtifact);
    assert.throws(() => store.revertTransportStarted(79), /JOB_NOT_TRANSPORT_STARTED/);

    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(() => {
    const stateRoot = root();
    let failOperation = 'accept';
    let store = openJobStore({
        stateRoot,
        beforeRename: operation => {
            if (operation === failOperation) throw new Error(`FAIL_${operation}`);
        }
    });
    assert.throws(() => store.accept(job(51)), /FAIL_accept/);
    assert.strictEqual(store.get(51), null);
    failOperation = null;
    store.accept(job(51));
    // Rendering is bookkeeping a restart redoes, so it is not written and cannot fail a write.
    failOperation = 'rendered';
    store.markRendered(51, { path: 'x', hash: 'c'.repeat(64), bytes: 2 });
    assert.strictEqual(store.get(51).state, 'rendered');
    assert.strictEqual(openJobStore({ stateRoot }).get(51).state, 'queued', 'a restart before the transport marker renders again');
    failOperation = 'transport_started';
    assert.throws(() => store.markTransportStarted(51), /FAIL_transport_started/);
    assert.strictEqual(openJobStore({ stateRoot }).get(51).state, 'queued');
    failOperation = null;
    store.markTransportStarted(51);
    failOperation = 'result';
    assert.throws(() => store.recordResult(51, { outcome: 'uncertain' }), /FAIL_result/);
    failOperation = null;
    store = openJobStore({
        stateRoot,
        beforeRename: operation => {
            if (operation === failOperation) throw new Error(`FAIL_${operation}`);
        }
    });
    assert.strictEqual(store.get(51).state, 'uncertain');
    failOperation = 'result_confirmation';
    assert.throws(() => store.confirmResults([51]), /FAIL_result_confirmation/);
    assert.strictEqual(openJobStore({ stateRoot }).outbox()[0].outcome, 'uncertain');
    assert(!fs.readdirSync(path.join(stateRoot, 'jobs', 'active')).some(name => name.endsWith('.tmp')));
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(() => {
    const stateRoot = root();
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const store = openJobStore({ stateRoot, now: () => now });
    store.accept(job(61));
    store.recordResult(61, { outcome: 'completed' });
    store.confirmResults([61]);
    now += 2 * 24 * 60 * 60 * 1000;
    store.cleanup();
    assert(store.get(61));
    now += 2 * 24 * 60 * 60 * 1000;
    store.cleanup();
    assert.strictEqual(store.get(61), null);
    store.accept(job(62));
    now += 30 * 24 * 60 * 60 * 1000;
    store.cleanup();
    assert(store.get(62));
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(() => {
    const stateRoot = root();
    const store = openJobStore({ stateRoot });
    store.accept(job(301));
    store.markRendered(301, { path: path.join(stateRoot, 'artifacts', '301.bin'), hash: 'e'.repeat(64), bytes: 1 });
    store.markTransportStarted(301);
    const started = { ...store.get(301) };
    assert.throws(
        () => store.markRendered(301, { path: 'nope.bin', hash: 'f'.repeat(64), bytes: 2 }),
        error => error.code === 'JOB_NOT_RUNNABLE' || /JOB_NOT_RUNNABLE/.test(error.message)
    );
    assert.strictEqual(store.get(301).state, started.state);
    assert.deepStrictEqual(store.get(301).artifact, started.artifact);
    store.recordResult(301, { outcome: 'completed' });
    const completed = { ...store.get(301) };
    assert.throws(
        () => store.markRendered(301, { path: 'nope.bin', hash: 'f'.repeat(64), bytes: 2 }),
        error => error.code === 'JOB_NOT_RUNNABLE' || /JOB_NOT_RUNNABLE/.test(error.message)
    );
    assert.strictEqual(store.get(301).state, completed.state);
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(() => {
    const stateRoot = root();
    const now = Date.now();
    const store = openJobStore({ stateRoot, now: () => now });
    const artifacts = path.join(stateRoot, 'artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    const referenced = path.join(artifacts, 'kept.bin');
    const oldOrphan = path.join(artifacts, 'old.bin');
    const recentOrphan = path.join(artifacts, 'recent.bin');
    fs.writeFileSync(referenced, 'keep');
    fs.writeFileSync(oldOrphan, 'old');
    fs.writeFileSync(recentOrphan, 'new');
    fs.utimesSync(oldOrphan, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));
    fs.utimesSync(recentOrphan, new Date(now - 10 * 60 * 1000), new Date(now - 10 * 60 * 1000));
    store.accept(job(302));
    store.markRendered(302, { path: referenced, hash: 'a'.repeat(64), bytes: 4 });
    store.cleanup();
    assert(fs.existsSync(referenced), 'referenced artifacts must remain');
    assert(fs.existsSync(recentOrphan), 'recent unreferenced artifacts must remain during the grace period');
    assert(!fs.existsSync(oldOrphan), 'unreferenced artifacts older than one hour must be removed');
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(() => {
    const stateRoot = root();
    const store = openJobStore({ stateRoot });
    store.accept(job(80));
    assert.throws(() => store.revertTransportStarted(80), /JOB_NOT_TRANSPORT_STARTED/);
    store.markRendered(80, { path: 'x.bin', hash: 'h', bytes: 1 });
    assert.throws(() => store.revertTransportStarted(80), /JOB_NOT_TRANSPORT_STARTED/);
    store.recordResult(80, { outcome: 'completed' });
    assert.throws(() => store.revertTransportStarted(80), /JOB_NOT_TRANSPORT_STARTED/);
    store.accept(job(81));
    store.requestCancel(81);
    assert.throws(() => store.revertTransportStarted(81), /JOB_NOT_TRANSPORT_STARTED/);
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

assert.throws(() => openJobStore({ stateRoot: 'relative-state' }), /SPOOLER_STATE_DIR_INVALID/);

for (const failedWrite of ['writeFileSync', 'fsyncSync']) {
    const stateRoot = root();
    const original = fs[failedWrite];
    try {
        const store = openJobStore({ stateRoot });
        store.accept(job(401));
        fs[failedWrite] = descriptor => {
            if (failedWrite === 'writeFileSync') fs.writeSync(descriptor, 'partial record');
            throw Object.assign(new Error('simulated full journal disk'), { code: 'ENOSPC' });
        };
        for (let attempt = 0; attempt < 3; attempt++) {
            assert.throws(() => store.markTransportStarted(401), error => error.code === 'ENOSPC');
        }
        fs[failedWrite] = original;
        assert.strictEqual(store.get(401).state, 'queued');
        assert.deepStrictEqual(
            fs.readdirSync(path.join(stateRoot, 'jobs', 'active')).filter(name => name.endsWith('.tmp')),
            [],
            `${failedWrite} failure must remove its temporary file before the next retry`
        );
        assert.strictEqual(openJobStore({ stateRoot }).get(401).state, 'queued');
        store.markTransportStarted(401);
        assert.strictEqual(store.get(401).state, 'transport_started');
    } finally {
        fs[failedWrite] = original;
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

const noncanonicalRoot = root();
assert.throws(() => openJobStore({ stateRoot: `${noncanonicalRoot}${path.sep}` }), /SPOOLER_STATE_DIR_INVALID/);
fs.rmSync(noncanonicalRoot, { recursive: true, force: true });
console.log('v2-job-store tests passed');
