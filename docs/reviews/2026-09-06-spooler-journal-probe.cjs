// Synthetic retained history; temporary local journal only, no network or printing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { openJobStore } = require('../../pos-spooler-printer/v2/job-store');

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-journal-audit-'));
const archive = path.join(stateRoot, 'jobs', 'archive');
const archivedCount = 14000;
const activeCount = 10;
const iterations = 500;
const timestamp = new Date().toISOString();
function job(id) {
    return { queue_id: id, idempotency_key: `synthetic-${id}`, payload_hash: 'a'.repeat(64), printer_id: 1, print_type: 'kitchen', data: { text: 'synthetic-only' } };
}

try {
    fs.mkdirSync(archive, { recursive: true });
    for (let id = 1; id <= archivedCount; id++) {
        fs.writeFileSync(path.join(archive, `${id}.json`), JSON.stringify({
            version: 1, ...job(id), job: job(id), state: 'completed', artifact: null,
            result: { queue_id: id, outcome: 'completed' }, accepted_confirmed: true,
            created_at: timestamp, updated_at: timestamp
        }));
    }
    const openedAt = performance.now();
    const store = openJobStore({ stateRoot });
    const openMs = performance.now() - openedAt;
    for (let id = archivedCount + 1; id <= archivedCount + activeCount; id++) store.accept(job(id));
    const sample = () => {
        // Operations reached in an ordinary active runtime sync, plus worker collection.
        store.health();
        store.outbox();
        store.unconfirmedAccepted();
        store.unconfirmedAccepted();
        store.outbox();
        store.unconfirmedAccepted();
        store.outbox();
        store.runnable();
    };
    for (let i = 0; i < 20; i++) sample();
    const samples = [];
    for (let run = 0; run < 3; run++) {
        const start = performance.now();
        for (let i = 0; i < iterations; i++) sample();
        samples.push(Number(((performance.now() - start) / iterations).toFixed(3)));
    }
    assert.strictEqual(store.health().active, activeCount);
    assert.strictEqual(store.runnable().length, activeCount);
    assert.strictEqual(store.unconfirmedAccepted().length, activeCount);
    assert.strictEqual(store.outbox().length, 0);
    assert.strictEqual(store.accept(job(1)).state, 'completed');
    assert.throws(() => store.accept({ ...job(1), payload_hash: 'b'.repeat(64) }), /PAYLOAD_IDENTITY_CONFLICT/);
    console.log(JSON.stringify({ runtime: process.version, archivedCount, activeCount, iterations, openMs: Math.round(openMs), hotSampleMs: samples }));
} finally {
    // stateRoot is an absolute mkdtemp directory created above for this probe only.
    fs.rmSync(stateRoot, { recursive: true, force: true });
}
