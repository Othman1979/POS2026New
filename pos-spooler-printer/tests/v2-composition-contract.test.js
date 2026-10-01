const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openJobStore } = require('../v2/job-store');
const { createPrinterWorkers } = require('../v2/printer-workers');
const { createAgentRuntime } = require('../v2/agent-runtime');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// server.js boots a whole Windows agent, so pin the two production seams that worker
// and runtime unit tests cannot see without duplicating the composition root.
assert.match(source, /onResultReady:\s*\(\)\s*=>\s*runtime\?\.wake\(\)/,
    'the result-ready hook must be wired to the runtime wake in production');
assert.strictEqual((source.match(/\b(?:const|let|var)\s+runtime\b/g) || []).length, 1,
    'the result-ready callback and runtime construction must share one late-bound runtime variable');
assert.doesNotMatch(source, /status-monitor|statusMonitor|\.probe\(|\.watch\(/,
    'the spooler must not probe printer status: health comes from finished jobs');

class FakeClock {
    constructor() { this.nextId = 1; this.timers = new Map(); this.delays = []; }
    setTimeout(callback, delay) { const id = this.nextId++; this.delays.push(delay); this.timers.set(id, callback); return id; }
    clearTimeout(id) { this.timers.delete(id); }
    async runNext() {
        const entry = this.timers.entries().next().value;
        assert(entry, 'expected a scheduled runtime tick');
        this.timers.delete(entry[0]);
        await entry[1]();
        await drain();
    }
}

async function drain() {
    for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function reply(overrides = {}) {
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

// The store, the workers and the runtime wired the way server.js wires them. The
// transport is held open on purpose so the print finishes in the *idle gap*, after the
// tick that would otherwise have carried the result. Without that gate the result lands
// inside the same tick drain and the assertion passes whether or not the hook exists -
// a vacuous test that looks exactly like this one.
async function composedAgent({ wired }) {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-composed-'));
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    const digest = crypto.createHash('sha256').update('composed').digest('hex');
    let runtime = null;
    let releaseTransport;
    const printing = new Promise(resolve => { releaseTransport = resolve; });

    const workers = createPrinterWorkers({
        store,
        renderer: {
            async render(job) {
                return { path: path.join(stateRoot, 'artifacts', `${job.queue_id}.bin`), hash: digest, bytes: 54684 };
            },
            health: () => ({ state: 'ready' })
        },
        transportFor: () => ({
            async send({ markTransportStarted }) {
                await markTransportStarted();
                await printing;
                return { success: true, durationMs: 443, deviceStatus: 'drained', confidence: 'spooler_drained' };
            }
        }),
        onResultReady: wired ? () => runtime?.wake() : undefined
    });

    const job = { queue_id: 600, idempotency_key: 'composed-600', payload_hash: 'a'.repeat(64), printer_id: 1, print_type: 'receipt' };
    const carried = [];
    let served = false;
    runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async body => {
                carried.push((body.results || []).map(result => result.queue_id));
                if (!served) {
                    served = true;
                    return reply({ jobs: [job] });
                }
                return reply({
                    confirmed_accepted: (body.accepted || []).map(accepted => accepted.queue_id),
                    confirmed_results: (body.results || []).map(result => result.queue_id)
                });
            }
        },
        worker: {
            start() { workers.start(); },
            stop() { return workers.stop(); },
            wake() { workers.wake(); },
            health() { return workers.health(); }
        },
        clock
    });

    runtime.start();
    for (let i = 0; i < 8 && clock.delays.at(-1) !== 2000; i += 1) await clock.runNext();
    assert.strictEqual(clock.delays.at(-1), 2000, 'the runtime must reach its idle cadence with the print still in flight');
    assert.deepStrictEqual(carried.at(-1), [], 'no result can have been carried yet - the printer has not finished');

    releaseTransport();
    await drain();
    const armedByTheFinishedPrint = clock.delays.at(-1);

    await clock.runNext();
    const settled = carried.at(-1);

    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
    return { armedByTheFinishedPrint, settled };
}

(async () => {
    const wired = await composedAgent({ wired: true });
    assert.strictEqual(wired.armedByTheFinishedPrint, 0,
        'a finished print must arm an immediate tick, not wait out the cadence');
    assert.deepStrictEqual(wired.settled, [600], 'that tick must carry the result');

    const unwired = await composedAgent({ wired: false });
    assert.strictEqual(unwired.armedByTheFinishedPrint, 2000,
        'without the hook the same print leaves the runtime on its cadence - this is the delay Task 4 removes');
    assert.deepStrictEqual(unwired.settled, [600], 'the cadence tick eventually carries it either way');
})().catch(error => { console.error(error); process.exitCode = 1; });

// The sync asserts above throw on failure, but the composed block reports by setting
// process.exitCode, so the success line has to wait for the final exit code.
process.on('exit', code => {
    if (code === 0) console.log('v2-composition-contract tests passed');
});
