const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openJobStore } = require('../v2/job-store');
const { createSyncClient } = require('../v2/sync-client');
const { createAgentRuntime } = require('../v2/agent-runtime');

function temporaryRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-runtime-'));
}

function deferredPromise() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

class FakeClock {
    constructor() {
        this.nextId = 1;
        this.timers = new Map();
        this.delays = [];
    }
    setTimeout(callback, delay) {
        const id = this.nextId++;
        this.delays.push(delay);
        this.timers.set(id, callback);
        return id;
    }
    clearTimeout(id) { this.timers.delete(id); }
    async runNext() {
        const entry = this.timers.entries().next().value;
        assert(entry, 'expected a scheduled runtime tick');
        this.timers.delete(entry[0]);
        await entry[1]();
        await new Promise(resolve => setImmediate(resolve));
    }
}

function worker() {
    return {
        starts: 0,
        stops: 0,
        wakes: 0,
        start() { this.starts += 1; },
        stop() { this.stops += 1; },
        wake() { this.wakes += 1; },
        health() { return { active: 0 }; }
    };
}

function response(overrides = {}) {
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

(async () => {
    const requests = [];
    const secret = crypto.randomBytes(32);
    const client = createSyncClient({
        baseUrl: 'https://pos.example.test',
        agentId: '11111111-1111-4111-8111-111111111111',
        secret,
        bootstrapKey: 'bootstrap',
        spoolerId: 'primary',
        spoolerName: 'Front Till',
        agentVersion: '2.0.0',
        fetchFn: async (url, options) => {
            requests.push({ url, options, body: JSON.parse(options.body) });
            return new Response(JSON.stringify(response()), { status: 200, headers: { 'content-type': 'application/json' } });
        }
    });
    await client.register();
    await client.sync({ protocol_version: 2, accepted: [], results: [], health: {}, capacity: 1 });
    assert.strictEqual(requests[0].options.headers['x-spooler-key'], 'bootstrap');
    assert.strictEqual(requests[0].body.token_hash, crypto.createHash('sha256').update(secret.toString('base64url')).digest('hex'));
    assert.strictEqual(requests[0].body.name, 'Front Till');
    assert.strictEqual(requests[1].options.headers['x-agent-token'], secret.toString('base64url'));
    assert.strictEqual(requests[1].body.spooler_id, 'primary');
    assert(!requests[0].options.body.includes(secret.toString('hex')));
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    const printWorker = worker();
    let syncCalls = 0;
    let registerCalls = 0;
    const client = {
        sync: async () => {
            syncCalls += 1;
            if (syncCalls === 1) {
                const error = new Error('unauthorized_agent');
                error.code = 'unauthorized_agent';
                error.status = 401;
                throw error;
            }
            return response();
        },
        register: async () => {
            registerCalls += 1;
            throw new Error('lost registration response');
        }
    };
    const runtime = createAgentRuntime({ store, syncClient: client, worker: printWorker, clock, random: () => 0 });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(printWorker.starts, 0);
    assert.strictEqual(registerCalls, 1);
    assert.strictEqual(clock.delays.at(-1), 2000);
    await clock.runNext();
    assert.strictEqual(printWorker.starts, 1);
    assert.strictEqual(registerCalls, 1);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    for (let id = 1; id <= 45; id += 1) {
        store.accept({
            queue_id: 3000 + id,
            idempotency_key: `reserved-receipt-${id}`,
            payload_hash: 'd'.repeat(64),
            printer_id: 1,
            print_type: 'receipt'
        });
    }
    const clock = new FakeClock();
    let seen;
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async body => { seen = body; return response(); } },
        worker: worker(),
        clock
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(seen.capacity, 0, 'ordinary work must stop before consuming the kitchen reserve');
    assert.strictEqual(seen.kitchen_capacity, 5, 'five bounded slots must remain available for kitchen work');
    assert.strictEqual(seen.health.non_kitchen_active, 45);
    assert.strictEqual(seen.health.kitchen_active, 0);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    const printWorker = worker();
    const bodies = [];
    const queued = {
        queue_id: 81,
        idempotency_key: 'job-81',
        payload_hash: 'a'.repeat(64),
        printer_id: 4,
        print_type: 'kitchen'
    };
    const replies = [response({ jobs: [queued] }), response({ confirmed_accepted: [81] })];
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async body => { bodies.push(body); return replies.shift() || response(); } },
        worker: printWorker,
        clock,
        agentName: 'Front Till'
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(store.get(81).state, 'queued');
    assert.strictEqual(bodies[0].health.agent_name, 'Front Till');
    assert.strictEqual(printWorker.starts, 1);
    assert.strictEqual(clock.delays.at(-1), 0);
    await clock.runNext();
    assert.deepStrictEqual(bodies[1].accepted, [{ queue_id: 81, payload_hash: 'a'.repeat(64) }]);
    assert.deepStrictEqual(store.unconfirmedAccepted(), []);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    let store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    const printWorker = worker();
    const bodies = [];
    const replies = [response({ agent_status: 'draining' }), response({ agent_status: 'revoked' })];
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async body => { bodies.push(body); return replies.shift() || response({ agent_status: 'revoked' }); } },
        worker: printWorker,
        clock
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(printWorker.starts, 1);
    await clock.runNext();
    assert.strictEqual(bodies[1].capacity, 0);
    assert.strictEqual(bodies[1].health.drain_complete, true);
    assert.strictEqual(printWorker.stops, 1);
    assert.strictEqual(store.agentStatus(), 'revoked');
    await runtime.stop();

    store = openJobStore({ stateRoot });
    const offlineWorker = worker();
    const offlineClock = new FakeClock();
    const offline = createAgentRuntime({
        store,
        syncClient: { sync: async () => { throw new Error('offline'); } },
        worker: offlineWorker,
        clock: offlineClock
    });
    offline.start();
    await offlineClock.runNext();
    assert.strictEqual(offlineWorker.starts, 0);
    await offline.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    const printWorker = worker();
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async () => { throw new Error('offline'); } },
        worker: printWorker,
        clock,
        random: () => 0
    });
    runtime.start();
    await clock.runNext();
    await clock.runNext();
    await clock.runNext();
    await clock.runNext();
    assert.deepStrictEqual(clock.delays.slice(0, 5), [0, 2000, 5000, 10000, 10000]);
    assert.strictEqual(printWorker.starts, 0);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    const printWorker = worker();
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async () => { throw new Error('offline'); } },
        worker: printWorker,
        clock,
        random: () => 1
    });
    runtime.start();
    await clock.runNext();
    await clock.runNext();
    await clock.runNext();
    await clock.runNext();
    assert.deepStrictEqual(clock.delays.slice(0, 5), [0, 2500, 6250, 12500, 12500]);
    assert.strictEqual(printWorker.starts, 0);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    let cleanups = 0;
    store.cleanup = () => { cleanups += 1; };
    const clock = new FakeClock();
    const runtime = createAgentRuntime({ store, syncClient: { sync: async () => response() }, worker: worker(), clock });
    runtime.start();
    await clock.runNext();
    await clock.runNext();
    assert.strictEqual(cleanups, 1, 'journal cleanup should run from the tick path and be throttled');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    store.cleanup = () => { throw Object.assign(new Error('locked artifact'), { code: 'EPERM' }); };
    let syncCalls = 0;
    const clock = new FakeClock();
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async () => { syncCalls += 1; return response(); } },
        worker: worker(),
        clock
    });
    runtime.start();
    await clock.runNext();
    await clock.runNext();
    assert.strictEqual(syncCalls, 2, 'cleanup failure must not block delivery synchronization');
    assert.strictEqual(runtime.health().cleanup_error, 'JOURNAL_CLEANUP_FAILED');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    store.accept({ queue_id: 90, idempotency_key: 'canonical', payload_hash: 'a'.repeat(64), printer_id: 1, print_type: 'kitchen' });
    const clock = new FakeClock();
    const valid = { queue_id: 91, idempotency_key: 'valid', payload_hash: 'b'.repeat(64), printer_id: 1, print_type: 'kitchen' };
    const conflict = { queue_id: 90, idempotency_key: 'hostile', payload_hash: 'c'.repeat(64), printer_id: 1, print_type: 'kitchen' };
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async () => response({ jobs: [conflict, valid] }) },
        worker: worker(),
        clock
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(store.get(90).idempotency_key, 'canonical');
    assert.strictEqual(store.get(91).state, 'queued');
    assert.deepStrictEqual(runtime.health().rejected_jobs, [{ queue_id: 90, error_code: 'PAYLOAD_IDENTITY_CONFLICT' }]);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    let registrations = 0;
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async () => { const error = new Error('unauthorized_agent'); error.code = 'unauthorized_agent'; error.status = 401; throw error; },
            register: async () => { registrations += 1; const error = new Error('gateway'); error.status = 502; throw error; }
        },
        worker: worker(),
        clock
    });
    runtime.start();
    await clock.runNext();
    await clock.runNext();
    assert.strictEqual(registrations, 2);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    let reply = response({ next_sync_ms: 3600000 });
    const runtime = createAgentRuntime({ store, syncClient: { sync: async () => reply }, worker: worker(), clock });
    runtime.start();
    await clock.runNext();
    assert(clock.delays.at(-1) <= 5000);
    reply = response({ next_sync_ms: -1 });
    await clock.runNext();
    assert(clock.delays.at(-1) >= 500);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    store.accept({
        queue_id: 201,
        idempotency_key: 'throttle-201',
        payload_hash: 'a'.repeat(64),
        printer_id: 1,
        print_type: 'kitchen'
    });
    const clock = new FakeClock();
    let calls = 0;
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async () => {
                calls += 1;
                return response({ throttled: true, next_sync_ms: 5000 });
            }
        },
        worker: worker(),
        clock
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(calls, 1);
    assert.strictEqual(clock.delays.at(-1), 5000, 'throttled responses must schedule exactly next_sync_ms');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    store.accept({
        queue_id: 203,
        idempotency_key: 'health-203',
        payload_hash: 'c'.repeat(64),
        printer_id: 1,
        print_type: 'kitchen'
    });
    store.accept({
        queue_id: 204,
        idempotency_key: 'health-204',
        payload_hash: 'd'.repeat(64),
        printer_id: 1,
        print_type: 'kitchen'
    });
    store.setAgentStatus('draining');
    const clock = new FakeClock();
    let seen;
    const printWorker = worker();
    printWorker.health = () => ({ active: 1, render_queue: 3 });
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async body => {
                seen = body;
                return response({ agent_status: 'draining' });
            }
        },
        worker: printWorker,
        clock
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(seen.health.local_queue_depth, 2, 'local_queue_depth must be journal depth');
    assert.strictEqual(seen.health.worker_active, 1, 'worker concurrency must be reported separately');
    assert.strictEqual(seen.health.drain_complete, false, 'drain cannot complete while workers or journal remain active');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    store.setAgentStatus('draining');
    const clock = new FakeClock();
    let seen;
    const printWorker = worker();
    printWorker.health = () => ({ active: 0 });
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async body => {
                seen = body;
                return response({ agent_status: 'draining' });
            }
        },
        worker: printWorker,
        clock
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(seen.health.local_queue_depth, 0);
    assert.strictEqual(seen.health.worker_active, 0);
    assert.strictEqual(seen.health.drain_complete, true);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})();

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const release = deferredPromise();
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async () => {
                calls += 1;
                concurrent += 1;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                if (calls === 1) await release.promise;
                concurrent -= 1;
                return response();
            }
        },
        worker: worker(),
        clock
    });
    runtime.start();
    const firstTick = clock.runNext();
    await new Promise(resolve => setImmediate(resolve));
    runtime.wake();
    runtime.wake();
    runtime.wake();
    // The broken scheduler arms a second tick here; fire it while the first
    // request is deliberately held so this test measures real concurrency.
    if (clock.timers.size > 0) await clock.runNext();
    release.resolve();
    await firstTick;
    assert.strictEqual(maxConcurrent, 1, 'at most one sync may be in flight');
    assert.strictEqual(calls, 1, 'wakes during a sync must not add sync calls');
    assert.strictEqual(clock.delays.at(-1), 0, 'coalesced wakes must yield one prompt follow-up');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    let calls = 0;
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async () => { calls += 1; throw new Error('ECONNREFUSED'); } },
        worker: worker(),
        clock,
        random: () => 0
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(clock.delays.at(-1), 2000, 'a failed sync must back off');
    runtime.wake();
    runtime.wake();
    assert.strictEqual(clock.delays.at(-1), 2000, 'a wake must not shorten an active backoff');
    assert.strictEqual(calls, 1, 'a wake during backoff must not issue a request');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // The server stopped confirming. The accept is durable, the next body will be
    // identical, and nothing moved - that is a loop, not urgency. This is the primary
    // spin the progress gate exists to stop; the replay case below is the other half.
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    store.accept({
        queue_id: 212,
        idempotency_key: 'unconfirmed-212',
        payload_hash: 'a'.repeat(64),
        printer_id: 1,
        print_type: 'kitchen'
    });
    const clock = new FakeClock();
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async () => response({ next_sync_ms: 4000 }) },
        worker: worker(),
        clock
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(clock.delays.at(-1), 4000, 'an accept the server never confirms must not spin at 0');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const replayed = {
        queue_id: 210,
        idempotency_key: 'replay-210',
        payload_hash: 'e'.repeat(64),
        printer_id: 1,
        print_type: 'kitchen'
    };
    store.accept(replayed);
    const clock = new FakeClock();
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async () => response({ next_sync_ms: 4000, jobs: [replayed] }) },
        worker: worker(),
        clock
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(clock.delays.at(-1), 4000, 'an idempotent job replay is not durable progress and must not spin at 0');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async () => response({
                next_sync_ms: 4000,
                jobs: [{
                    queue_id: 211,
                    idempotency_key: 'progress-211',
                    payload_hash: 'f'.repeat(64),
                    printer_id: 1,
                    print_type: 'kitchen'
                }]
            })
        },
        worker: worker(),
        clock
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(clock.delays.at(-1), 0, 'a sync that durably accepted new work must stay immediate');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

// A newly recorded result must be able to replace the idle cadence with one prompt
// tick, without issuing a request synchronously from the worker callback.
(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    let calls = 0;
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async () => { calls += 1; return response(); } },
        worker: worker(),
        clock
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(clock.delays.at(-1), 2000, 'an idle runtime returns to its normal cadence');
    runtime.wake();
    assert.strictEqual(clock.delays.at(-1), 0, 'a result-ready wake must schedule the next tick immediately');
    assert.strictEqual(calls, 1, 'wake must not run sync inline');
    await clock.runNext();
    assert.strictEqual(calls, 2, 'the scheduled prompt tick performs the sync');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

// The workers put artifact metadata on the result; this pins that it survives the
// journal and reaches the wire in the exact shape the server keeps. Without it, a
// whitelist added to recordResult or outbox would silently drop the fields while the
// worker unit test and the server integration test both still passed.
(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const digest = crypto.createHash('sha256').update('artifact-213').digest('hex');
    store.accept({
        queue_id: 213,
        idempotency_key: 'artifact-213',
        payload_hash: 'b'.repeat(64),
        printer_id: 1,
        print_type: 'receipt'
    });
    store.recordResult(213, {
        outcome: 'completed',
        device_status: 'drained',
        confidence: 'spooler_drained',
        duration_ms: 443,
        artifact_bytes: 54684,
        artifact_hash: digest
    });
    const clock = new FakeClock();
    let sent = null;
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async body => { sent = body; return response(); } },
        worker: worker(),
        clock
    });
    runtime.start();
    await clock.runNext();
    const wire = sent.results.find(result => result.queue_id === 213);
    assert.strictEqual(wire.artifact_bytes, 54684, 'the artifact size must reach the sync body');
    assert.strictEqual(wire.artifact_hash, digest, 'the artifact hash must reach the sync body');
    // The server keeps artifact_hash only on /^[0-9a-f]{64}$/ and artifact_bytes only as
    // an integer in [0, 16MiB] (spoolerSync.js:146); anything else is silently nulled.
    // Assert the wire value in the shape that actually survives, not just that it moved.
    assert.match(String(wire.artifact_hash), /^[0-9a-f]{64}$/, 'the hash must be in the form the server keeps');
    assert(Number.isInteger(wire.artifact_bytes) && wire.artifact_bytes >= 0 && wire.artifact_bytes <= 16 * 1024 * 1024,
        'the size must be in the range the server keeps');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    const printWorker = worker();
    const logs = [];
    let calls = 0;
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async () => {
                calls += 1;
                if (calls === 1) return response();
                const error = new Error('station_mismatch');
                error.code = 'station_mismatch';
                error.status = 409;
                throw error;
            }
        },
        worker: printWorker,
        clock,
        log: message => logs.push(message)
    });
    runtime.start();
    await clock.runNext();
    assert.strictEqual(printWorker.starts, 1);
    await clock.runNext();
    assert.strictEqual(printWorker.stops, 1, 'station mismatch must stop a previously active worker');
    assert.strictEqual(store.agentStatus(), 'registration_failed');
    assert.deepStrictEqual(logs, ['STATION_MISMATCH']);
    assert.strictEqual(clock.delays.at(-1), 10000);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

// A held HTTP response that resolves after stop() must never enter the durable
// journal or wake a printer worker, even when the transport ignores cancellation.
(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    const printWorker = worker();
    const held = deferredPromise();
    let transportOptions = null;
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async (_body, options) => {
                transportOptions = options;
                return held.promise;
            }
        },
        worker: printWorker,
        clock
    });
    runtime.start();
    const tick = clock.runNext();
    await new Promise(resolve => setImmediate(resolve));
    const stopping = runtime.stop();
    held.resolve(response({ jobs: [{
        queue_id: 991,
        idempotency_key: 'late-after-stop',
        payload_hash: 'f'.repeat(64),
        printer_id: 1,
        print_type: 'kitchen'
    }] }));
    await tick;
    await stopping;

    assert(transportOptions?.signal, 'the runtime must pass a caller-owned signal to sync');
    assert.strictEqual(transportOptions.signal.aborted, true, 'stop must abort the active HTTP attempt');
    assert.strictEqual(store.get(991), null, 'a late response must not enter the journal after stop');
    assert.strictEqual(printWorker.starts, 0, 'a late response must not start the printer worker');
    assert.strictEqual(clock.timers.size, 0, 'shutdown must not schedule another tick');
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    const signals = [];
    let active = 0;
    let peakActive = 0;
    let registerCalls = 0;
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async (_body, options) => {
                signals.push(options.signal);
                active += 1;
                peakActive = Math.max(peakActive, active);
                active -= 1;
                throw new Error('connection closed');
            },
            register: async () => { registerCalls += 1; }
        },
        worker: worker(),
        clock,
        random: () => 0
    });

    runtime.start();
    await clock.runNext();
    await clock.runNext();
    assert.deepStrictEqual(clock.delays.slice(-2), [2000, 5000], 'ordinary network failures retain 2/5 second backoff');
    assert.strictEqual(registerCalls, 0, 'network failures must not trigger agent registration');
    assert.strictEqual(peakActive, 1, 'network failures must not create overlapping syncs');
    assert.notStrictEqual(signals[0], signals[1], 'each tick must own a distinct abort signal');
    await runtime.stop();
    assert(signals.every(signal => !signal.aborted), 'completed attempt controllers must not be aborted by a later stop');
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const stateRoot = temporaryRoot();
    const clock = new FakeClock();
    const events = [];
    const printWorker = { ...worker(), setBlockedPrinters(ids) { events.push(['blocked', ids]); }, start() { events.push(['start']); } };
    const replies = [response({ blocked_printer_ids: [4] }), response(), response({ blocked_printer_ids: [] })];
    const runtime = createAgentRuntime({ store: openJobStore({ stateRoot }), clock, worker: printWorker,
        syncClient: { sync: async () => replies.shift() } });
    try {
        runtime.start(); await clock.runNext();
        assert.deepStrictEqual(events, [['blocked', [4]], ['start']], 'server conflict must precede local worker startup');
        await clock.runNext();
        assert.strictEqual(events.length, 2, 'omitted conflict field must not clear the last authoritative block');
        await clock.runNext();
        assert.deepStrictEqual(events.at(-1), ['blocked', []]);
    } finally {
        await runtime.stop();
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

// STATION_MISMATCH self-heal: the saved identity is bound to another station on the
// server. When nothing is unfinished locally or on the server, the agent registers a
// fresh identity and adopts it (replaces agent.json) only after the server accepts it;
// otherwise it stays stopped and loses nothing.
function stationMismatchError(serverUnfinished) {
    const error = new Error('station_mismatch');
    error.code = 'station_mismatch';
    error.status = 409;
    error.response = serverUnfinished === undefined
        ? { success: false, code: 'station_mismatch' }
        : { success: false, code: 'station_mismatch', server_unfinished: serverUnfinished };
    return error;
}

function registrationError(status, code) {
    return Object.assign(new Error(code), { code, status });
}

// `serverUnfinished` is the count the old identity's 409 carries, one entry per old
// sync (the last repeats); `registerResults` is one entry per registration attempt
// (an Error to throw, or null to succeed; success once exhausted).
function mismatchHarness({ preload = () => {}, serverUnfinished = [0], registerResults = [], prepareResults = [], freshSyncMismatch = false } = {}) {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    preload(store);
    const clock = new FakeClock();
    const printWorker = worker();
    const logs = [];
    const events = [];
    const calls = { oldSync: 0, prepared: 0, registers: 0, commits: 0, discards: 0, freshSync: 0 };
    const bodies = [];
    const time = { t: 1_000_000 };
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: async body => {
                bodies.push(body);
                const count = serverUnfinished[Math.min(calls.oldSync, serverUnfinished.length - 1)];
                calls.oldSync += 1;
                throw stationMismatchError(count);
            },
            register: async () => { throw new Error('old client must not register'); }
        },
        prepareIdentity: async () => {
            calls.prepared += 1;
            const stagingFailure = prepareResults.shift();
            if (stagingFailure) throw stagingFailure;
            return {
                syncClient: {
                    register: async () => {
                        calls.registers += 1;
                        events.push('register');
                        const outcome = registerResults.shift();
                        if (outcome) throw outcome;
                        return { success: true };
                    },
                    sync: async () => {
                        calls.freshSync += 1;
                        if (freshSyncMismatch) throw stationMismatchError(0);
                        return response();
                    }
                },
                commit: async () => { calls.commits += 1; events.push('commit'); },
                discard: () => { calls.discards += 1; }
            };
        },
        worker: printWorker,
        clock,
        now: () => time.t,
        log: message => logs.push(message)
    });
    return { stateRoot, store, clock, printWorker, logs, events, calls, runtime, bodies, time };
}

async function ticks(clock, count) {
    for (let i = 0; i < count; i += 1) await clock.runNext();
}

const UNFINISHED_JOB = { queue_id: 41, idempotency_key: 'k41', payload_hash: 'a'.repeat(64), printer_id: 1, print_type: 'receipt' };

(async () => {
    const { stateRoot, store, clock, printWorker, logs, events, calls, runtime } = mismatchHarness();
    runtime.start();
    await ticks(clock, 1);
    assert.strictEqual(calls.prepared, 1, 'nothing unfinished anywhere: a replacement identity is prepared');
    assert.deepStrictEqual(events, ['register', 'commit'], 'agent.json is replaced only after the server accepts');
    assert.deepStrictEqual(logs, ['STATION_MISMATCH_HEALED']);
    await ticks(clock, 1);
    assert.strictEqual(calls.freshSync, 1, 'the next sync uses the fresh identity');
    assert.strictEqual(calls.oldSync, 1, 'the old identity is never used again');
    assert.strictEqual(printWorker.starts, 1, 'workers start without a restart');
    assert.strictEqual(store.agentStatus(), 'active');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const { stateRoot, clock, printWorker, logs, calls, runtime } = mismatchHarness({ preload: store => store.accept(UNFINISHED_JOB) });
    runtime.start();
    await ticks(clock, 2);
    assert.strictEqual(calls.prepared, 0, 'unfinished local work must never be orphaned by a new identity');
    assert.strictEqual(calls.oldSync, 2);
    assert.strictEqual(printWorker.starts, 0);
    assert.deepStrictEqual(logs, ['STATION_MISMATCH', 'STATION_MISMATCH_BLOCKED local=1 server=0'], 'blocked is logged once, not every 10 s');
    assert.strictEqual(clock.delays.at(-1), 10000);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // A finished-but-unconfirmed result is unfinished work too.
    const { stateRoot, clock, calls, runtime, logs } = mismatchHarness({
        preload: store => {
            store.accept(UNFINISHED_JOB);
            store.confirmAccepted([41]);
            store.recordResult(41, { outcome: 'completed' });
        }
    });
    runtime.start();
    await ticks(clock, 1);
    assert.strictEqual(calls.prepared, 0);
    assert(logs.includes('STATION_MISMATCH_BLOCKED local=1 server=0'));
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // The journal is empty but the server still holds claimed rows for the old identity
    // (a lost sync response). Replacing the identity would orphan them.
    const { stateRoot, clock, calls, runtime, logs } = mismatchHarness({ serverUnfinished: [2] });
    runtime.start();
    await ticks(clock, 2);
    assert.strictEqual(calls.prepared, 0, 'server-owned unfinished work blocks the rotation');
    assert.strictEqual(calls.commits, 0);
    assert.deepStrictEqual(logs, ['STATION_MISMATCH', 'STATION_MISMATCH_BLOCKED local=0 server=2']);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // An older server omits the count: unknown is not zero, so do not rotate.
    const { stateRoot, clock, calls, runtime, logs } = mismatchHarness({ serverUnfinished: [undefined] });
    runtime.start();
    await ticks(clock, 2);
    assert.strictEqual(calls.prepared, 0, 'an unknown server count must not rotate');
    assert.deepStrictEqual(logs, ['STATION_MISMATCH', 'STATION_MISMATCH_BLOCKED local=0 server=unknown']);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // Blocked while the server still holds work, then heals once it has settled.
    const { stateRoot, clock, calls, runtime, logs, printWorker } = mismatchHarness({ serverUnfinished: [1, 0] });
    runtime.start();
    await ticks(clock, 1);
    assert.strictEqual(calls.prepared, 0);
    await ticks(clock, 2);
    assert.strictEqual(calls.commits, 1);
    assert(logs.includes('STATION_MISMATCH_HEALED'));
    assert.strictEqual(printWorker.starts, 1);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const { stateRoot, clock, logs, calls, runtime } = mismatchHarness({ freshSyncMismatch: true });
    runtime.start();
    await ticks(clock, 5);
    assert.strictEqual(calls.prepared, 1, 'a rotated identity that also mismatches must not rotate again');
    assert.strictEqual(clock.delays.at(-1), 10000, 'falls back to the 10 s retry');
    assert.strictEqual(logs.filter(message => message === 'STATION_MISMATCH_HEALED').length, 1);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // A permanent refusal keeps the old identity: nothing was committed, the old
    // credentials stay in use, and there is no loop.
    const { stateRoot, store, clock, printWorker, logs, calls, runtime } = mismatchHarness({
        registerResults: [registrationError(400, 'invalid_identity')]
    });
    runtime.start();
    await ticks(clock, 1);
    assert.strictEqual(calls.commits, 0, 'a refused registration must not replace the saved identity');
    assert.strictEqual(calls.discards, 1);
    assert(logs.some(message => message.startsWith('STATION_MISMATCH_HEAL_FAILED')));
    assert.strictEqual(store.agentStatus(), 'registration_failed');
    await ticks(clock, 3);
    assert.strictEqual(calls.registers, 1, 'no retry after a permanent refusal');
    assert.strictEqual(calls.prepared, 1);
    assert.strictEqual(calls.oldSync, 4, 'the old credentials are still the ones in use');
    assert.strictEqual(printWorker.starts, 0);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // station_busy is transient: retry on a later tick with the same staged identity.
    const { stateRoot, store, clock, printWorker, logs, events, calls, runtime } = mismatchHarness({
        registerResults: [registrationError(409, 'station_busy')]
    });
    runtime.start();
    await ticks(clock, 1);
    assert.strictEqual(calls.commits, 0, 'nothing is adopted while registration is refused');
    assert.strictEqual(calls.discards, 0, 'the staged identity is kept for the retry');
    assert(clock.delays.at(-1) >= 2000 && clock.delays.at(-1) <= 2500, 'retry rides the existing backoff');
    await ticks(clock, 2);
    assert.strictEqual(calls.prepared, 1, 'one staged identity across the retry');
    assert.strictEqual(calls.registers, 2);
    assert.deepStrictEqual(events, ['register', 'register', 'commit']);
    assert.strictEqual(calls.freshSync, 1);
    assert.strictEqual(printWorker.starts, 1, 'registered and printing with no restart');
    assert.strictEqual(store.agentStatus(), 'active');
    assert.strictEqual(logs.filter(message => message === 'STATION_MISMATCH_HEALED').length, 1);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // A registration that stays busy is retried a bounded number of times, then stops.
    const busy = () => registrationError(409, 'station_busy');
    const { stateRoot, clock, calls, runtime } = mismatchHarness({ registerResults: Array.from({ length: 50 }, busy) });
    runtime.start();
    await ticks(clock, 30);
    assert.strictEqual(calls.registers, 5, 'bounded attempts, not an endless loop');
    assert.strictEqual(calls.commits, 0);
    assert.strictEqual(calls.discards, 1);
    assert.strictEqual(calls.prepared, 1);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // Busy for the whole capped episode: stopped, then a cool-down later a new episode
    // starts and the registration goes through, with no restart and no tight loop.
    const busy = () => registrationError(409, 'station_busy');
    const { stateRoot, store, clock, printWorker, logs, calls, runtime, time } = mismatchHarness({
        registerResults: Array.from({ length: 5 }, busy)
    });
    runtime.start();
    await ticks(clock, 12);
    assert.strictEqual(calls.registers, 5, 'the first episode is capped');
    assert.strictEqual(calls.commits, 0);
    time.t += 60 * 1000;
    await ticks(clock, 3);
    assert.strictEqual(calls.registers, 5, 'no attempts inside the cool-down');
    time.t += 5 * 60 * 1000;
    await ticks(clock, 3);
    assert.strictEqual(calls.registers, 6, 'a new episode starts after the cool-down');
    assert.strictEqual(calls.commits, 1);
    assert.strictEqual(calls.prepared, 2, 'a fresh staged identity for the new episode');
    assert(logs.includes('STATION_MISMATCH_HEALED'));
    assert(calls.freshSync >= 1, 'the fresh identity is the one syncing');
    const oldSyncsAtHeal = calls.oldSync;
    await ticks(clock, 2);
    assert.strictEqual(calls.oldSync, oldSyncsAtHeal, 'the old identity stopped being used after the heal');
    assert.strictEqual(printWorker.starts, 1, 'registered and printing with no restart');
    assert.strictEqual(store.agentStatus(), 'active');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // A permanent refusal is never re-armed by waiting.
    const { stateRoot, clock, calls, runtime, time } = mismatchHarness({
        registerResults: [registrationError(409, 'station_occupied')]
    });
    runtime.start();
    await ticks(clock, 2);
    time.t += 60 * 60 * 1000;
    await ticks(clock, 3);
    assert.strictEqual(calls.registers, 1, 'station_occupied needs a person, not a timer');
    assert.strictEqual(calls.prepared, 1);
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // What the agent tells the admin page about itself rides on the sync it already sends.
    const busy = () => registrationError(409, 'station_busy');
    const healing = mismatchHarness({ registerResults: [busy()] });
    healing.runtime.start();
    await ticks(healing.clock, 2);
    assert.strictEqual(healing.bodies[0].mismatch_state, undefined, 'a healthy or first request carries nothing extra');
    assert.strictEqual(healing.bodies[1].mismatch_state, 'healing', 'a retrying agent says it is healing');
    await healing.runtime.stop();
    fs.rmSync(healing.stateRoot, { recursive: true, force: true });

    const blocked = mismatchHarness({ serverUnfinished: [3] });
    blocked.runtime.start();
    await ticks(blocked.clock, 2);
    assert.strictEqual(blocked.bodies[1].mismatch_state, 'blocked', 'a blocked agent says so');
    await blocked.runtime.stop();
    fs.rmSync(blocked.stateRoot, { recursive: true, force: true });

    const refused = mismatchHarness({ registerResults: [registrationError(400, 'invalid_identity')] });
    refused.runtime.start();
    await ticks(refused.clock, 2);
    assert.strictEqual(refused.bodies[1].mismatch_state, 'blocked', 'a permanently refused agent says blocked');
    await refused.runtime.stop();
    fs.rmSync(refused.stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // The crash the durable candidate exists for: the server accepted the replacement
    // identity but the machine died before promoting it. A restart finishes the job,
    // or drops a candidate the server never heard of.
    const { loadOrCreateIdentity, stageReplacementIdentity, loadCandidateIdentity } = require('../v2/agent-identity');
    const protector = {
        protect: async value => Buffer.from(value).toString('base64'),
        unprotect: async value => Buffer.from(value, 'base64')
    };
    for (const serverKnowsCandidate of [true, false]) {
        const stateRoot = temporaryRoot();
        const store = openJobStore({ stateRoot });
        const original = await loadOrCreateIdentity({ stateRoot, protector });
        const agentFile = path.join(stateRoot, 'agent.json');
        const candidateFile = path.join(stateRoot, 'agent.candidate.json');
        const before = fs.readFileSync(agentFile);

        let staged = null;
        const firstClock = new FakeClock();
        const first = createAgentRuntime({
            store,
            syncClient: { sync: async () => { throw stationMismatchError(0); } },
            prepareIdentity: async () => {
                staged = await stageReplacementIdentity({
                    stateRoot, protector, beforeRename: async () => { throw new Error('SIMULATED_CRASH'); }
                });
                assert(fs.existsSync(candidateFile), 'the candidate is durable before the server is asked');
                return {
                    syncClient: { register: async () => ({ success: true }), sync: async () => response() },
                    commit: () => staged.commit(),
                    discard: () => staged.discard()
                };
            },
            worker: worker(),
            clock: firstClock,
            log: () => {}
        });
        first.start();
        await firstClock.runNext();
        await first.stop();
        assert(before.equals(fs.readFileSync(agentFile)), 'agent.json is untouched by the crash');
        assert(fs.existsSync(candidateFile), 'the candidate survives the crash');

        // Restart. The routine start-up sweep must not delete the candidate.
        assert.strictEqual((await loadOrCreateIdentity({ stateRoot, protector })).agentId, original.agentId);
        const leftover = await loadCandidateIdentity({ stateRoot, protector });
        assert.strictEqual(leftover.agentId, staged.agentId);

        const syncedAs = [];
        const secondClock = new FakeClock();
        const second = createAgentRuntime({
            store,
            syncClient: { sync: async () => { syncedAs.push('saved'); throw stationMismatchError(0); } },
            pendingCandidate: {
                syncClient: {
                    sync: async () => {
                        syncedAs.push('candidate');
                        if (serverKnowsCandidate) return response();
                        throw registrationError(401, 'unauthorized_agent');
                    }
                },
                commit: () => leftover.commit(),
                discard: () => leftover.discard()
            },
            worker: worker(),
            clock: secondClock,
            log: () => {}
        });
        second.start();
        await secondClock.runNext();
        if (serverKnowsCandidate) {
            assert.deepStrictEqual(syncedAs, ['candidate'], 'the leftover candidate is tried first');
            assert.strictEqual(JSON.parse(fs.readFileSync(agentFile, 'utf8')).agent_id, staged.agentId, 'and promoted once the server accepts it');
            assert(!fs.existsSync(candidateFile));
        } else {
            await secondClock.runNext();
            assert.deepStrictEqual(syncedAs.slice(0, 2), ['candidate', 'saved'], 'a candidate the server does not know is dropped');
            assert(!fs.existsSync(candidateFile));
            assert(before.equals(fs.readFileSync(agentFile)), 'the saved identity is unchanged');
        }
        await second.stop();
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // The real identity file: a refused registration leaves agent.json byte-identical
    // and leaves no temp file; an accepted one replaces it.
    const { loadOrCreateIdentity, stageReplacementIdentity } = require('../v2/agent-identity');
    const protector = {
        protect: async value => Buffer.from(value).toString('base64'),
        unprotect: async value => Buffer.from(value, 'base64')
    };
    for (const outcome of ['refused', 'accepted']) {
        const stateRoot = temporaryRoot();
        const store = openJobStore({ stateRoot });
        const original = await loadOrCreateIdentity({ stateRoot, protector });
        const agentFile = path.join(stateRoot, 'agent.json');
        const before = fs.readFileSync(agentFile);
        const clock = new FakeClock();
        const registeredAs = [];
        const oldSyncs = [];
        const runtime = createAgentRuntime({
            store,
            syncClient: { sync: async () => { oldSyncs.push(original.agentId); throw stationMismatchError(0); } },
            prepareIdentity: async () => {
                const staged = await stageReplacementIdentity({ stateRoot, protector });
                return {
                    syncClient: {
                        register: async () => {
                            registeredAs.push(staged.agentId);
                            if (outcome === 'refused') throw registrationError(400, 'invalid_identity');
                            return { success: true };
                        },
                        sync: async () => response()
                    },
                    commit: () => staged.commit(),
                    discard: () => staged.discard()
                };
            },
            worker: worker(),
            clock,
            log: () => {}
        });
        runtime.start();
        await clock.runNext();
        assert.strictEqual(registeredAs.length, 1);
        const after = fs.readFileSync(agentFile);
        if (outcome === 'refused') {
            assert(before.equals(after), 'a refused registration leaves agent.json byte-identical');
            assert.strictEqual((await loadOrCreateIdentity({ stateRoot, protector })).agentId, original.agentId);
            await clock.runNext();
            assert.deepStrictEqual(oldSyncs, [original.agentId, original.agentId], 'the old credentials are still used');
        } else {
            assert.strictEqual((await loadOrCreateIdentity({ stateRoot, protector })).agentId, registeredAs[0], 'the accepted identity is what a restart loads');
            assert.notStrictEqual(registeredAs[0], original.agentId);
        }
        assert(!fs.readdirSync(stateRoot).some(name => name.startsWith('agent.json.') && name.endsWith('.tmp')));
        await runtime.stop();
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

// Blocks in this file report failures by setting process.exitCode rather than by
// crashing. setImmediate is too early to see that - it fires while every block is
// still suspended on its first await - so the success line hangs off process exit,
// which runs once the loop has drained and the exit code is final.
process.on('exit', code => {
    if (code === 0) console.log('v2-sync-runtime tests passed');
});

(async () => {
    // Staging the replacement identity fails because the platform helper is briefly
    // unavailable: retried inside the same bounded episode, then healed, with no restart.
    const helperBusy = () => Object.assign(new Error('PLATFORM_HELPER_BUSY'), { code: 'PLATFORM_HELPER_BUSY', failureClass: 'transient_safe' });
    const { stateRoot, clock, logs, calls, runtime } = mismatchHarness({ prepareResults: [helperBusy(), helperBusy()] });
    runtime.start();
    await ticks(clock, 8);
    assert.strictEqual(calls.prepared, 3, 'staging is retried after a transient helper failure');
    assert.strictEqual(calls.commits, 1);
    assert(logs.includes('STATION_MISMATCH_HEALED'));
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    // A helper that never comes back stops after the bounded attempts, then a cool-down
    // later a new episode tries again; a permanent staging failure never re-arms.
    const helperBusy = () => Object.assign(new Error('PLATFORM_HELPER_TIMEOUT'), { code: 'PLATFORM_HELPER_TIMEOUT', failureClass: 'transient_safe' });
    const transientRun = mismatchHarness({ prepareResults: Array.from({ length: 5 }, helperBusy) });
    transientRun.runtime.start();
    await ticks(transientRun.clock, 12);
    assert.strictEqual(transientRun.calls.prepared, 5, 'bounded staging attempts');
    transientRun.time.t += 6 * 60 * 1000;
    await ticks(transientRun.clock, 4);
    assert.strictEqual(transientRun.calls.commits, 1, 'a new episode after the cool-down heals');
    await transientRun.runtime.stop();
    fs.rmSync(transientRun.stateRoot, { recursive: true, force: true });

    const permanentRun = mismatchHarness({ prepareResults: [Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })] });
    permanentRun.runtime.start();
    await ticks(permanentRun.clock, 4);
    permanentRun.time.t += 6 * 60 * 1000;
    await ticks(permanentRun.clock, 4);
    assert.strictEqual(permanentRun.calls.prepared, 1, 'a permanent staging failure is not retried');
    assert.strictEqual(permanentRun.calls.commits, 0);
    await permanentRun.runtime.stop();
    fs.rmSync(permanentRun.stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

// A wake while the server holds an idle sync ends that request at once (not after the hold),
// is not a failure (no backoff), and the next sync carries the new result.
(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    const clock = new FakeClock();
    const bodies = [];
    let heldAborted = 0;
    const runtime = createAgentRuntime({
        store,
        syncClient: {
            sync: (body, { signal }) => {
                bodies.push(body);
                if (bodies.length === 1) {
                    return new Promise((_resolve, reject) => {
                        signal.addEventListener('abort', () => { heldAborted += 1; reject(signal.reason); }, { once: true });
                    });
                }
                return Promise.resolve(response());
            }
        },
        worker: worker(),
        clock
    });
    runtime.start();
    const held = clock.runNext();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(bodies.length, 1);
    assert.strictEqual(bodies[0].results.length, 0, 'the held request carried nothing');
    store.accept({ queue_id: 301, idempotency_key: 'wake-301', payload_hash: 'c'.repeat(64), printer_id: 1, print_type: 'receipt' });
    store.recordResult(301, { outcome: 'completed', device_status: 'drained', confidence: 'spooler_drained', duration_ms: 5 });
    runtime.wake();
    await held;
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(heldAborted, 1, 'a wake must end the held request');
    assert.strictEqual(runtime.health().consecutive_failures, 0, 'a wake-abort is not a failure');
    assert.strictEqual(clock.delays.at(-1), 0, 'the follow-up sync is immediate, with no backoff');
    await clock.runNext();
    assert.strictEqual(bodies.length, 2);
    assert(bodies[1].results.some(result => result.queue_id === 301), 'the next sync carries the finished job');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });

// A request that already carries results is never aborted by a wake, and a `held` answer
// (an idle hold that found nothing) re-polls immediately.
(async () => {
    const stateRoot = temporaryRoot();
    const store = openJobStore({ stateRoot });
    store.accept({ queue_id: 302, idempotency_key: 'wake-302', payload_hash: 'd'.repeat(64), printer_id: 1, print_type: 'receipt' });
    store.recordResult(302, { outcome: 'completed', device_status: 'drained', confidence: 'spooler_drained', duration_ms: 5 });
    const clock = new FakeClock();
    const gate = deferredPromise();
    let signalRef = null;
    let calls = 0;
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: (_body, { signal }) => { calls += 1; signalRef = signal; return calls === 1 ? gate.promise : Promise.resolve(response({ held: true })); } },
        worker: worker(),
        clock
    });
    runtime.start();
    const first = clock.runNext();
    await new Promise(resolve => setImmediate(resolve));
    runtime.wake();
    assert.strictEqual(signalRef.aborted, false, 'a request carrying results must not be aborted');
    gate.resolve(response({ confirmed_results: [302] }));
    await first;
    await clock.runNext();
    assert.strictEqual(calls, 2);
    assert.strictEqual(clock.delays.at(-1), 0, 'a held-and-empty answer re-polls without a gap');
    await runtime.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
