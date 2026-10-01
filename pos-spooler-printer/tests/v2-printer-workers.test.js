const assert = require('assert');
const { createPrinterWorkers } = require('../v2/printer-workers');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fakeStore(records) {
    const rows = new Map(records.map(record => [record.queue_id, record]));
    const terminal = new Set(['completed', 'permanent_failure', 'uncertain', 'canceled']);
    const active = id => {
        const row = rows.get(id);
        if (terminal.has(row.state)) throw new Error('JOB_TERMINAL');
        return row;
    };
    return {
        runnable: () => [...rows.values()].filter(row => ['queued', 'rendered', 'retry_wait'].includes(row.state)),
        markRendered(id, artifact) { const row = active(id); row.state = 'rendered'; row.artifact = artifact; return row; },
        retainArtifactForCleanup(id, artifact) {
            const row = rows.get(id);
            if (!row || !terminal.has(row.state)) throw new Error('JOB_NOT_TERMINAL');
            row.artifact = artifact;
            return row;
        },
        markTransportStarted(id) { active(id).state = 'transport_started'; },
        recordResult(id, result) { const row = active(id); row.state = result.outcome; row.result = result; },
        recordRetry(id, result) {
            const row = active(id);
            if (row.state === 'transport_started') {
                const error = new Error('JOB_TRANSPORT_STARTED');
                error.code = 'JOB_TRANSPORT_STARTED';
                throw error;
            }
            row.state = 'retry_wait';
            row.result = result;
        },
        revertTransportStarted(id) {
            const row = rows.get(id);
            if (!row || row.state !== 'transport_started') {
                const error = new Error('JOB_NOT_TRANSPORT_STARTED');
                error.code = 'JOB_NOT_TRANSPORT_STARTED';
                throw error;
            }
            row.state = 'rendered';
            return row;
        },
        get: id => rows.get(id)
    };
}

function record(id, printerId, printType = 'receipt') {
    return {
        queue_id: id,
        printer_id: printerId,
        print_type: printType,
        state: 'queued',
        created_at: `2026-08-17T00:00:${String(id).padStart(2, '0')}.000Z`,
        job: { queue_id: id, printer_id: printerId, print_type: printType, data: {} }
    };
}

(async () => {
    const row = record(990, 1, 'kitchen');
    row.state = 'rendered';
    row.artifact = { path: 'missing.bin', hash: 'a', bytes: 1 };
    const store = fakeStore([row]);
    let retry, clock = Date.now(), renders = 0, sends = 0;
    const workers = createPrinterWorkers({ store, now: () => clock,
        timers: { setTimeout(fn, ms) { retry = () => { clock += ms; fn(); }; return 1; }, clearTimeout() {} },
        renderer: { async render() { renders++; return { path: 'rebuilt.bin', hash: 'b', bytes: 1 }; } },
        transportFor: () => ({ async send({ artifact, markTransportStarted }) {
            sends++;
            if (artifact.path === 'missing.bin') throw Object.assign(new Error('missing'), { code: 'ARTIFACT_READ_FAILED', failureClass: 'transient_safe' });
            markTransportStarted(); return { success: true };
        } })
    });
    workers.start(); await workers.idle();
    assert.strictEqual(renders, 0);
    retry(); await workers.idle(); await workers.stop();
    assert.strictEqual(renders, 1, 'unreadable artifact must be rebuilt on retry');
    assert.strictEqual(sends, 2);
    assert.strictEqual(row.state, 'completed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const rows = [
        record(1, 1, 'daily_summary_report'),
        record(2, 1, 'receipt'),
        record(3, 2, 'kitchen'),
        record(4, 2, 'cash_drawer')
    ];
    const store = fakeStore(rows);
    const firstRender = deferred();
    const renderOrder = [];
    const renderer = {
        async render(job) {
            renderOrder.push(job.queue_id);
            if (job.queue_id === 1) await firstRender.promise;
            return { path: `${job.queue_id}.bin`, hash: String(job.queue_id), bytes: 1 };
        },
        health: () => ({ state: 'ready' })
    };
    const transports = new Map();
    const activeByPrinter = new Map();
    let differentPrintersOverlapped = false;
    function transportFor(job) {
        return {
            async send({ markTransportStarted }) {
                const printerId = job.printer_id;
                const active = activeByPrinter.get(printerId) || 0;
                assert.strictEqual(active, 0, 'one printer lane must never overlap itself');
                activeByPrinter.set(printerId, 1);
                if ([...activeByPrinter.values()].filter(Boolean).length > 1) differentPrintersOverlapped = true;
                markTransportStarted();
                const gate = deferred();
                transports.set(job.queue_id, gate);
                await gate.promise;
                activeByPrinter.set(printerId, 0);
                return { success: true, confidence: 'bytes_sent' };
            }
        };
    }
    const workers = createPrinterWorkers({ store, renderer, transportFor });
    workers.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(renderOrder[0], 3, 'kitchen must overtake reports that have not started rendering');
    await new Promise(resolve => setImmediate(resolve));
    transports.get(3).resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(renderOrder.slice(0, 4), [3, 2, 4, 1]);
    firstRender.resolve();
    await new Promise(resolve => setImmediate(resolve));
    transports.get(2).resolve();
    await new Promise(resolve => setImmediate(resolve));
    transports.get(4).resolve();
    await new Promise(resolve => setImmediate(resolve));
    transports.get(1).resolve();
    await workers.idle();
    assert(differentPrintersOverlapped, 'different printer lanes should transport concurrently');
    assert(rows.every(row => row.state === 'completed'));
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const rows = Array.from({ length: 50 }, (_, index) => record(index + 10, index % 5, index % 3 === 0 ? 'kitchen' : 'receipt'));
    const store = fakeStore(rows);
    const seen = new Set();
    const laneActive = new Map();
    const workers = createPrinterWorkers({
        store,
        renderer: {
            async render(job) {
                assert(!seen.has(job.queue_id));
                seen.add(job.queue_id);
                return { path: `${job.queue_id}.bin`, hash: 'a', bytes: 1 };
            },
            health: () => ({ state: 'ready' })
        },
        transportFor: job => ({
            async send({ markTransportStarted }) {
                assert.strictEqual(laneActive.get(job.printer_id) || 0, 0);
                laneActive.set(job.printer_id, 1);
                markTransportStarted();
                await new Promise(resolve => setImmediate(resolve));
                laneActive.set(job.printer_id, 0);
                return { success: true, confidence: 'bytes_sent' };
            }
        })
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(seen.size, 50);
    assert(rows.every(row => row.state === 'completed'));
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const rows = [record(71, 7, 'kitchen')];
    const store = fakeStore(rows);
    const renderGate = deferred();
    const renderStarted = deferred();
    const workers = createPrinterWorkers({
        store,
        renderer: {
            async render(job) {
                renderStarted.resolve();
                await renderGate.promise;
                return { path: `${job.queue_id}.bin`, hash: 'h', bytes: 1 };
            },
            health: () => ({ state: 'ready' })
        },
        transportFor: () => ({ async send() { throw new Error('canceled job must not print'); } }),
        removeArtifact: () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); }
    });
    workers.start();
    await renderStarted.promise;
    rows[0].state = 'canceled';
    rows[0].result = { outcome: 'canceled' };
    renderGate.resolve();
    await workers.idle();
    assert.strictEqual(store.get(71).artifact.path, '71.bin', 'failed canceled-artifact deletion must remain durably discoverable');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const rows = [record(70, 7, 'kitchen')];
    const store = fakeStore(rows);
    const renderGate = deferred();
    const renderStarted = deferred();
    const sent = [];
    const removedArtifacts = [];
    const workers = createPrinterWorkers({
        store,
        renderer: {
            async render(job) {
                renderStarted.resolve();
                await renderGate.promise;
                return { path: `${job.queue_id}.bin`, hash: 'h', bytes: 1 };
            },
            health: () => ({ state: 'ready' })
        },
        transportFor: () => ({
            async send({ printer }) {
                sent.push(printer.queue_id);
                return { success: true };
            }
        }),
        removeArtifact: artifactPath => removedArtifacts.push(artifactPath)
    });
    workers.start();
    await renderStarted.promise;
    rows[0].state = 'canceled';
    rows[0].result = { outcome: 'canceled' };
    renderGate.resolve();
    await workers.idle();
    assert.deepStrictEqual(sent, [], 'a job canceled during render must never be transported');
    assert.deepStrictEqual(removedArtifacts, ['70.bin'], 'a canceled render must not leave an untracked artifact');
    assert.strictEqual(store.get(70).state, 'canceled');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const activeJob = record(99, 9, 'receipt');
    activeJob.state = 'rendered';
    const store = fakeStore([activeJob]);
    assert.throws(
        () => store.retainArtifactForCleanup(99, { path: '99.bin' }),
        /JOB_NOT_TERMINAL/
    );
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const rows = [record(120, 12, 'kitchen'), record(121, 12, 'receipt')];
    const store = fakeStore(rows);
    const active = { count: 0, max: 0 };
    const order = [];
    const firstSend = deferred();
    const workers = createPrinterWorkers({
        store,
        renderer: {
            async render(job) { return { path: `${job.queue_id}.bin`, hash: 'h', bytes: 1 }; },
            health: () => ({ state: 'ready' })
        },
        transportFor: () => ({
            async send({ printer, markTransportStarted }) {
                active.count += 1;
                active.max = Math.max(active.max, active.count);
                order.push(printer.queue_id);
                await markTransportStarted();
                if (printer.queue_id === 120) await firstSend.promise;
                active.count -= 1;
                return { success: true, confidence: 'bytes_sent' };
            }
        })
    });
    workers.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(active.max, 1, 'two jobs for one printer must stay serial on the worker lane');
    firstSend.resolve();
    await workers.idle();
    assert.deepStrictEqual(order, [120, 121]);
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// A kitchen ticket that becomes ready while receipts already wait on the same printer goes
// next, not last; the job already on the wire is never interrupted.
(async () => {
    const rows = [record(201, 20, 'receipt'), record(202, 20, 'receipt'), record(203, 20, 'receipt'), record(204, 20, 'kitchen')];
    rows[3].state = 'blocked';
    const store = fakeStore(rows);
    const gate = deferred();
    const firstOnWire = deferred();
    const sent = [];
    const workers = createPrinterWorkers({
        store,
        renderer: { async render(job) { return { path: `${job.queue_id}.bin`, hash: 'h', bytes: 1 }; }, health: () => ({ state: 'ready' }) },
        transportFor: () => ({
            async send({ printer, markTransportStarted }) {
                sent.push(printer.queue_id);
                if (printer.queue_id === 201) { firstOnWire.resolve(); await gate.promise; }
                await markTransportStarted();
                return { success: true };
            }
        })
    });
    workers.start();
    await firstOnWire.promise;
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); // 202 and 203 now wait in the lane
    rows[3].state = 'queued';
    workers.wake();
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(sent, [201], 'nothing preempts the job on the wire');
    gate.resolve();
    await workers.idle();
    assert.deepStrictEqual(sent, [201, 204, 202, 203], 'kitchen goes ahead of receipts already queued on the shared printer');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
    const queued = record(110, 11, 'kitchen');
    const store = fakeStore([queued]);
    let nowMs = 0;
    const timers = {
        ids: new Map(),
        nextId: 1,
        setTimeout(callback, delay) {
            const id = this.nextId++;
            this.ids.set(id, { callback, at: nowMs + Number(delay) });
            return id;
        },
        clearTimeout(id) { this.ids.delete(id); },
        async flushDue() {
            for (const [id, timer] of [...this.ids]) {
                if (timer.at <= nowMs) {
                    this.ids.delete(id);
                    await timer.callback();
                }
            }
        }
    };
    let sends = 0;
    const workers = createPrinterWorkers({
        store,
        now: () => nowMs,
        timers,
        renderer: {
            async render(job) { return { path: `${job.queue_id}.bin`, hash: 'h', bytes: 1 }; },
            health: () => ({ state: 'ready' })
        },
        transportFor: () => ({
            async send({ markTransportStarted }) {
                sends += 1;
                if (sends === 1) {
                    const error = new Error('PRINTER_UNAVAILABLE');
                    error.code = 'PRINTER_UNAVAILABLE';
                    error.failureClass = 'transient_safe';
                    throw error;
                }
                await markTransportStarted();
                return { success: true, confidence: 'bytes_sent' };
            }
        })
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(sends, 1);
    assert.strictEqual(store.get(110).state, 'retry_wait');
    await workers.stop();
    workers.start();
    workers.wake();
    nowMs = 1000;
    await timers.flushDue();
    workers.wake();
    await workers.idle();
    assert(sends > 1, 'a retry_wait job must send again after stop/start once its retry time arrives');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// A renderer crash carries no `code`. It must not be reported as a printer fault:
// that sends the reader to the printer while the real message is discarded.
(async () => {
    const rows = [record(200, 1, 'receipt')];
    const store = fakeStore(rows);
    const timers = {
        setTimeout: () => Symbol('timer'),
        clearTimeout: () => {}
    };
    const workers = createPrinterWorkers({
        store,
        timers,
        renderer: {
            async render() { throw new Error('Could not find Chrome (ver. 146.0.7680.76)'); },
            health: () => ({ state: 'ready' })
        },
        transportFor: () => ({ async send() { throw new Error('the printer must never be reached'); } })
    });
    workers.start();
    await workers.idle();
    const result = store.get(200).result;
    assert.strictEqual(store.get(200).state, 'retry_wait');
    assert.strictEqual(result.error_code, 'RENDER_FAILED', 'a render crash must not be labelled a printer fault');
    assert.strictEqual(result.failure_stage, 'render');
    assert.match(result.error_message, /Could not find Chrome/, 'the real failure text must survive');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// A store write failure on the transport path must not kill the process, and the
// record must come back once the store recovers.
(async () => {
    let failures = 0;
    let nowMs = 1000;
    const rejections = [];
    const onRejection = (err) => rejections.push(err);
    process.on('unhandledRejection', onRejection);
    const rows = [record(300, 1, 'receipt')];
    const store = fakeStore(rows);
    const originalRecordRetry = store.recordRetry;
    store.recordRetry = (...args) => {
        if (failures++ === 0) { const e = new Error('ENOSPC: no space'); e.code = 'ENOSPC'; throw e; }
        return originalRecordRetry(...args);
    };
    // Capture retry timers rather than firing them. A stub that calls back synchronously
    // runs scheduleRetry's callback before its `const timer` is bound, and the resulting
    // ReferenceError would stand in for the store failure this case is actually about.
    const armedRetries = [];
    const workers = createPrinterWorkers({
        store,
        now: () => nowMs,
        timers: { setTimeout: (fn) => { armedRetries.push(fn); return Symbol('t'); }, clearTimeout: () => {} },
        renderer: { async render() { return { path: 'x.bin', hash: 'h', bytes: 1 }; }, health: () => ({ state: 'ready' }) },
        transportFor: () => ({ async send() { const e = new Error('conn refused'); e.code = 'PRINTER_UNAVAILABLE'; throw e; } })
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(failures, 1, 'the first retry write was attempted');
    assert.strictEqual(armedRetries.length, 0, 'the failed write never got as far as arming a retry timer');
    workers.wake();
    await workers.idle();
    assert.strictEqual(failures, 1, 'a wake before the store-failure deadline must not retry the write');
    nowMs += 2000;
    workers.wake();
    await workers.idle();
    await new Promise(r => setImmediate(r));
    process.removeListener('unhandledRejection', onRejection);
    assert.strictEqual(rejections.length, 0, 'a store write failure must never escape as an unhandled rejection');
    assert.strictEqual(failures, 2, 'the guard released the record, so the next wake re-picked it');
    assert.strictEqual(armedRetries.length, 1, 'the recovered write armed its retry timer normally');
    assert.strictEqual(store.get(300).state, 'retry_wait');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// Same guard on the render side. pumpRender calls collect() every iteration, so a
// released record that is still runnable would be re-collected immediately: one render
// per wake is the property that keeps that from becoming an unbounded microtask spin
// (which starves timers and sync entirely, and leaves a live process NSSM never restarts).
(async () => {
    let renderCalls = 0;
    let nowMs = 1000;
    let macrotaskRan = false;
    const rejections = [];
    const onRejection = (err) => rejections.push(err);
    process.on('unhandledRejection', onRejection);
    setTimeout(() => { macrotaskRan = true; }, 1);
    const rows = [record(301, 1, 'receipt')];
    const store = fakeStore(rows);
    store.recordRetry = () => { const e = new Error('EACCES: journal locked'); e.code = 'EACCES'; throw e; };
    const workers = createPrinterWorkers({
        store,
        now: () => nowMs,
        timers: { setTimeout: () => Symbol('t'), clearTimeout: () => {} },
        renderer: { async render() { renderCalls++; throw new Error('chrome is gone'); }, health: () => ({ state: 'ready' }) },
        transportFor: () => ({ async send() { throw new Error('the transport must never be reached'); } })
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(renderCalls, 1, 'one render attempt per wake — releasing must not re-collect inside the same pump');
    await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(macrotaskRan, true, 'the event loop still runs timers; the render loop did not starve it');
    workers.wake();
    await workers.idle();
    assert.strictEqual(renderCalls, 1, 'a wake before the store-failure deadline must not re-render');
    nowMs += 2000;
    workers.wake();
    await workers.idle();
    assert.strictEqual(renderCalls, 2, 'the first wake after the deadline retries it exactly once more');
    assert.strictEqual(store.get(301).state, 'queued', 'the record stays runnable rather than stranded');
    await new Promise(r => setImmediate(r));
    process.removeListener('unhandledRejection', onRejection);
    assert.strictEqual(rejections.length, 0, 'a store failure on the render path must not escape either');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// Recording an uncertain render outcome can fail independently of rendering itself.
// Its retry deadline must not be shortened by a faster sync cadence.
(async () => {
    const rows = [record(302, 1, 'receipt')];
    const store = fakeStore(rows);
    let recordAttempts = 0;
    store.recordResult = () => {
        recordAttempts += 1;
        const error = new Error('ENOSPC');
        error.code = 'ENOSPC';
        throw error;
    };
    let nowMs = 1000;
    const workers = createPrinterWorkers({
        store,
        now: () => nowMs,
        renderer: {
            async render() {
                const error = new Error('RENDER_OUTCOME_UNKNOWN');
                error.failureClass = 'uncertain';
                throw error;
            },
            health: () => ({ state: 'ready' })
        },
        transportFor: () => ({ async send() { return { success: true, durationMs: 5 }; } })
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(recordAttempts, 1, 'the outcome must be attempted once');
    workers.wake();
    await workers.idle();
    assert.strictEqual(recordAttempts, 1, 'a wake before the deadline must not retry the store write');
    nowMs += 2000;
    workers.wake();
    await workers.idle();
    assert.strictEqual(recordAttempts, 2, 'a wake after the deadline must retry the store write');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// After the transport marker, a failed journal write may only retry persistence.
// It must never resend bytes, and transport_started must not remain stranded forever.
(async () => {
    const rows = [record(303, 1, 'receipt')];
    const store = fakeStore(rows);
    const recordResult = store.recordResult;
    let recordAttempts = 0;
    store.recordResult = (...args) => {
        recordAttempts += 1;
        if (recordAttempts <= 2) {
            const error = new Error('ENOSPC');
            error.code = 'ENOSPC';
            throw error;
        }
        return recordResult(...args);
    };
    let nowMs = 1000;
    let sends = 0;
    const workers = createPrinterWorkers({
        store,
        now: () => nowMs,
        renderer: {
            async render(job) { return { path: `${job.queue_id}.bin`, hash: 'h', bytes: 1 }; },
            health: () => ({ state: 'ready' })
        },
        transportFor: () => ({
            async send({ markTransportStarted }) {
                sends += 1;
                await markTransportStarted();
                return { success: true, durationMs: 5 };
            }
        })
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(recordAttempts, 2, 'completion and uncertain persistence must both be attempted');
    assert.strictEqual(store.get(303).state, 'transport_started');
    workers.wake();
    await workers.idle();
    assert.strictEqual(recordAttempts, 2, 'a wake before the deadline must not retry persistence');
    nowMs += 2000;
    workers.wake();
    await workers.idle();
    assert.strictEqual(recordAttempts, 3, 'the uncertain outcome must be persisted after the deadline');
    assert.strictEqual(sends, 1, 'post-marker recovery must never resend the print job');
    assert.strictEqual(store.get(303).state, 'uncertain');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// A store error is not a transport verdict. Past the transport marker the deferred
// retry may only persist a terminal outcome - never revert the marker and resend,
// which would reprint a job that may already have reached paper.
(async () => {
    const rows = [record(304, 1, 'receipt')];
    const store = fakeStore(rows);
    const recordResult = store.recordResult;
    let recordAttempts = 0;
    store.recordResult = (...args) => {
        recordAttempts += 1;
        if (recordAttempts <= 2) {
            const error = new Error('ENOSPC');
            error.code = 'ENOSPC';
            // The second attempt is the one the recovery captures and replays. preByte
            // is transport-only; a store error must never carry reprint authority.
            if (recordAttempts === 2) error.preByte = true;
            throw error;
        }
        return recordResult(...args);
    };
    let nowMs = 1000;
    let sends = 0;
    const armedRetries = [];
    const workers = createPrinterWorkers({
        store,
        now: () => nowMs,
        timers: { setTimeout: (fn) => { armedRetries.push(fn); return Symbol('t'); }, clearTimeout: () => {} },
        renderer: {
            async render(job) { return { path: `${job.queue_id}.bin`, hash: 'h', bytes: 1 }; },
            health: () => ({ state: 'ready' })
        },
        transportFor: () => ({
            async send({ markTransportStarted }) {
                sends += 1;
                await markTransportStarted();
                return { success: true, durationMs: 5 };
            }
        })
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(store.get(304).state, 'transport_started');
    nowMs += 2000;
    workers.wake();
    await workers.idle();
    assert.strictEqual(store.get(304).state, 'uncertain', 'the deferred retry must settle uncertain, not revert the transport marker');
    assert.strictEqual(armedRetries.length, 0, 'post-marker recovery must never arm a reprint retry');
    nowMs += 10000;
    for (const fire of armedRetries) fire();
    await workers.idle();
    assert.strictEqual(sends, 1, 'a job past the transport marker must never be resent');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// Pre-byte Winspool failure: revert transport_started → rendered, then retry.
// A later send must succeed, and the artifact from the first render must stay.
(async () => {
    const rows = [record(400, 1, 'receipt')];
    const store = fakeStore(rows);
    let nowMs = 0;
    const armedRetries = [];
    let sends = 0;
    let resultWakes = 0;
    let renders = 0;
    const workers = createPrinterWorkers({
        store,
        now: () => nowMs,
        timers: {
            setTimeout: (fn, delay) => { armedRetries.push({ fn, delay }); return Symbol('t'); },
            clearTimeout: () => {}
        },
        renderer: { async render(job) { renders++; return { path: `${job.queue_id}.bin`, hash: 'h', bytes: 1 }; }, health: () => ({ state: 'ready' }) },
        transportFor: () => ({
            async send({ markTransportStarted }) {
                sends += 1;
                await markTransportStarted();
                if (sends === 1) {
                    const error = new Error('WINspool_OPEN_FAILED');
                    error.code = 'WINspool_OPEN_FAILED';
                    error.failureClass = 'transient_safe';
                    error.preByte = true;
                    throw error;
                }
                return { success: true, confidence: 'os_accepted' };
            }
        }),
        onResultReady: () => { resultWakes += 1; }
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(sends, 1);
    assert.strictEqual(store.get(400).state, 'retry_wait');
    assert.strictEqual(store.get(400).artifact.path, '400.bin', 'the artifact is retained across the revert');
    assert.strictEqual(armedRetries.length, 1, 'the pre-byte failure armed a retry timer');
    assert.strictEqual(resultWakes, 0, 'a scheduled retry is not a terminal result and must not wake sync');
    nowMs += Number(armedRetries[0].delay);
    armedRetries[0].fn();
    await workers.idle();
    assert.strictEqual(sends, 2);
    assert.strictEqual(store.get(400).state, 'completed');
    assert.strictEqual(renders, 1, 'pre-byte retry must not rerender');
    assert.strictEqual(resultWakes, 1, 'the eventual durable result wakes sync exactly once');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// Attempt 60 of a receipt job is a dead letter, not another delay.
(async () => {
    const queued = record(401, 1, 'receipt');
    queued.result = { attempts: 59 };
    const store = fakeStore([queued]);
    const armedRetries = [];
    const workers = createPrinterWorkers({
        store,
        timers: { setTimeout: (fn) => { armedRetries.push(fn); return Symbol('t'); }, clearTimeout: () => {} },
        renderer: { async render(job) { return { path: `${job.queue_id}.bin`, hash: 'h', bytes: 1 }; }, health: () => ({ state: 'ready' }) },
        transportFor: () => ({
            async send() {
                const error = new Error('conn refused');
                error.code = 'PRINTER_UNAVAILABLE';
                error.failureClass = 'transient_safe';
                throw error;
            }
        })
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(store.get(401).state, 'permanent_failure');
    assert.strictEqual(store.get(401).result.error_code, 'RETRY_LIMIT_EXHAUSTED');
    assert.strictEqual(store.get(401).result.failure_stage, 'transport');
    assert.strictEqual(armedRetries.length, 0, 'the cap must not arm another retry timer');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// Completed results carry the immutable artifact identity and size used for
// diagnostics. The transport marker remains part of the real completion path.
(async () => {
    const rows = [record(41, 1, 'receipt')];
    let nowMs = 1_000;
    rows[0].accepted_local_at = new Date(nowMs).toISOString();
    const store = fakeStore(rows);
    const artifact = {
        path: '41.bin', hash: 'b'.repeat(64), bytes: 54684, width: 576, height: 759,
        render_ms: 25, renderer: 'typst'
    };
    const workers = createPrinterWorkers({
        store,
        now: () => nowMs,
        renderer: { render: async () => { nowMs += 25; return artifact; }, health: () => ({ state: 'ready' }) },
        transportFor: () => ({
            async send({ markTransportStarted }) {
                await markTransportStarted();
                nowMs += 75;
                return {
                    success: true,
                    durationMs: 75,
                    deviceStatus: 'drained',
                    confidence: 'spooler_drained',
                    transportMode: 'notification'
                };
            }
        })
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(rows[0].result.artifact_bytes, 54684, 'settle must carry the artifact size');
    assert.strictEqual(rows[0].result.artifact_hash, 'b'.repeat(64), 'settle must carry the artifact hash');
    assert.strictEqual(rows[0].result.duration_ms, 75, 'transport duration forwarding must be unchanged');
    assert.strictEqual(rows[0].result.render_duration_ms, 25);
    assert.strictEqual(rows[0].result.local_duration_ms, 100);
    assert.strictEqual(rows[0].result.renderer, 'typst');
    assert.strictEqual(rows[0].result.transport_mode, 'notification');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// transient_safe without preByte after bytes may have started is uncertain, never a retry.
(async () => {
    const rows = [record(402, 1, 'receipt')];
    const store = fakeStore(rows);
    const armedRetries = [];
    const workers = createPrinterWorkers({
        store,
        timers: { setTimeout: (fn) => { armedRetries.push(fn); return Symbol('t'); }, clearTimeout: () => {} },
        renderer: { async render(job) { return { path: `${job.queue_id}.bin`, hash: 'h', bytes: 1 }; }, health: () => ({ state: 'ready' }) },
        transportFor: () => ({
            async send({ markTransportStarted }) {
                await markTransportStarted();
                const error = new Error('conn refused');
                error.code = 'PRINTER_UNAVAILABLE';
                error.failureClass = 'transient_safe';
                throw error;
            }
        })
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(store.get(402).state, 'uncertain');
    assert.strictEqual(store.get(402).result.outcome, 'uncertain');
    assert.strictEqual(armedRetries.length, 0, 'an unmarked transport_started failure must not retry');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// A durable terminal result is new sync work. Announce it exactly once, after the
// real transport marker and result write have both succeeded.
(async () => {
    const rows = [record(42, 1, 'receipt')];
    const store = fakeStore(rows);
    let wakes = 0;
    const workers = createPrinterWorkers({
        store,
        renderer: { render: async () => ({ path: '42.bin', hash: 'c'.repeat(64), bytes: 10 }), health: () => ({ state: 'ready' }) },
        transportFor: () => ({
            async send({ markTransportStarted }) {
                await markTransportStarted();
                return { success: true, durationMs: 5 };
            }
        }),
        onResultReady: () => { wakes += 1; }
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(rows[0].state, 'completed');
    assert.strictEqual(wakes, 1, 'one recorded result must produce exactly one wake');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// Failed prints also become durable sync work; otherwise the failed-jobs badge lies
// until the ordinary cadence fires.
(async () => {
    const rows = [record(43, 1, 'receipt')];
    const store = fakeStore(rows);
    let wakes = 0;
    const workers = createPrinterWorkers({
        store,
        renderer: { render: async () => ({ path: '43.bin', hash: 'd'.repeat(64), bytes: 10 }), health: () => ({ state: 'ready' }) },
        transportFor: () => ({
            async send({ markTransportStarted }) {
                await markTransportStarted();
                const error = new Error('WINspool_DRAIN_UNKNOWN');
                error.code = 'WINspool_DRAIN_UNKNOWN';
                error.failureClass = 'uncertain';
                throw error;
            }
        }),
        onResultReady: () => { wakes += 1; }
    });
    workers.start();
    await workers.idle();
    assert.strictEqual(rows[0].state, 'uncertain', 'uncertain must still dead-letter, not retry');
    assert.strictEqual(wakes, 1, 'a settled failure must wake the loop too');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// Result notification is advisory. Neither a synchronous throw nor an asynchronous
// rejection may turn a successful physical print into a failed process or outcome.
(async () => {
    const rows = [record(44, 1, 'receipt'), record(45, 1, 'receipt')];
    const store = fakeStore(rows);
    let hookCalls = 0;
    const workers = createPrinterWorkers({
        store,
        renderer: { render: async job => ({ path: `${job.queue_id}.bin`, hash: 'e'.repeat(64), bytes: 10 }), health: () => ({ state: 'ready' }) },
        transportFor: () => ({
            async send({ markTransportStarted }) {
                await markTransportStarted();
                return { success: true, durationMs: 5 };
            }
        }),
        onResultReady: () => {
            hookCalls += 1;
            if (hookCalls === 1) throw new Error('hook exploded');
            return Promise.reject(new Error('hook rejected'));
        }
    });
    workers.start();
    await workers.idle();
    await new Promise(resolve => setImmediate(resolve));
    assert(rows.every(row => row.state === 'completed'), 'a broken hook must not change print outcomes');
    assert.strictEqual(hookCalls, 2, 'each durable result still announces once');
    await workers.stop();
})().catch(error => { console.error(error); process.exitCode = 1; });

// A good send whose journal write then fails is a store problem, not a printer fault:
// the printer must not be reported as errored.
(async () => {
    const rows = [record(401, 7, 'receipt')];
    const store = fakeStore(rows);
    store.recordResult = () => { const error = new Error('ENOSPC'); error.code = 'ENOSPC'; throw error; };
    const workers = createPrinterWorkers({
        store,
        renderer: { async render() { return {}; }, health: () => ({ state: 'ready' }) },
        transportFor: () => ({ async send() { return { success: true, durationMs: 5 }; } })
    });
    workers.start();
    await workers.idle();
    const errored = workers.health().printers.some(printer => printer.device_status === 'error');
    await workers.stop();
    assert(!errored, 'a store failure after a successful send must not mark the printer as errored');

    const failing = createPrinterWorkers({
        store: fakeStore([record(402, 8, 'receipt')]),
        renderer: { async render() { return {}; }, health: () => ({ state: 'ready' }) },
        transportFor: () => ({ async send() { const error = new Error('down'); error.failureClass = 'permanent_safe'; throw error; } })
    });
    failing.start();
    await failing.idle();
    assert(failing.health().printers.some(printer => printer.device_status === 'error'), 'a transport error still marks the printer');
    await failing.stop();

    // Failing to read or verify the artifact before any byte is sent says nothing about the printer.
    for (const [id, code, failureClass] of [
        [410, 'ARTIFACT_READ_FAILED', 'transient_safe'], [411, 'ARTIFACT_READ_TIMEOUT', 'transient_safe'],
        [412, 'ARTIFACT_HASH_MISMATCH', 'permanent_safe'], [413, 'ARTIFACT_SIZE_MISMATCH', 'permanent_safe'],
        [414, 'ARTIFACT_INVALID', 'permanent_safe']
    ]) {
        const pre = createPrinterWorkers({
            store: fakeStore([record(id, 9, 'receipt')]),
            renderer: { async render() { return {}; }, health: () => ({ state: 'ready' }) },
            transportFor: () => ({ async send() { const error = new Error(code); error.code = code; error.failureClass = failureClass; throw error; } })
        });
        pre.start();
        await pre.idle();
        assert(!pre.health().printers.some(printer => printer.device_status === 'error'), `${code} must not mark the printer as errored`);
        await pre.stop();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

// Blocks in this file report failures by setting process.exitCode rather than by
// crashing. setImmediate is too early to see that - it fires while every block is
// still suspended on its first await - so the success line hangs off process exit,
// which runs once the loop has drained and the exit code is final.
process.on('exit', code => {
    if (code === 0) console.log('v2-printer-workers tests passed');
});
