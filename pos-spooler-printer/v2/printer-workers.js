function priority(record) {
    const job = record.job || record;
    if (job.print_type === 'kitchen' || job.data?.void_ticket || job.data?.follow_up_ticket) return 0;
    return ['receipt', 'cash_drawer'].includes(job.print_type) ? 1 : 2;
}

const PRE_TRANSPORT_ARTIFACT_CODES = new Set(['ARTIFACT_INVALID', 'ARTIFACT_READ_FAILED', 'ARTIFACT_READ_TIMEOUT', 'ARTIFACT_HASH_MISMATCH', 'ARTIFACT_SIZE_MISMATCH']);

function compareJobs(left, right) {
    return priority(left) - priority(right)
        || Date.parse(left.created_at) - Date.parse(right.created_at)
        || left.queue_id - right.queue_id;
}

const RUNNABLE_STATES = new Set(['queued', 'rendered', 'retry_wait']);
const MAX_TIMING_MS = 7 * 24 * 60 * 60 * 1000;

const fs = require('fs');
const { printerEndpoint } = require('./printer-endpoint');

function createPrinterWorkers({
    store,
    renderer,
    transportFor,
    now = () => Date.now(),
    timers = { setTimeout, clearTimeout },
    removeArtifact = artifactPath => fs.rmSync(artifactPath, { force: true }),
    onResultReady = () => {}
}) {
    const owned = new Set();
    // Records released because a store write failed while recording their outcome,
    // each held until its own retry deadline. The deadline is doing two jobs: pumpRender
    // calls collect() on every loop iteration, so a record with no deadline renders the
    // same doomed job forever in microtasks and starves the event loop — no timers, no
    // sync, and a live process NSSM will never restart — and pacing it here rather than
    // on the sync tick keeps the retry rate independent of the fleet's sync cadence.
    const deferredUntil = new Map();
    const STORE_FAILURE_RETRY_MS = 2000;
    const renderQueue = [];
    const lanes = new Map();
    let blockedPrinters = new Set();
    const retryTimers = new Set();
    // Per printer, how its latest finished job ended ('ok' or 'error'). Nothing asks the
    // printer: the lanes already hold the outcome, so this costs nothing between jobs.
    // In memory only: the server keeps the last value it was told.
    const printerOutcomes = new Map();
    const MAX_PRINTER_OUTCOMES = 64;
    const idleWaiters = new Set();
    let started = false;
    let rendering = false;
    let renderingPrinterId = null;
    let pumpScheduled = false;

    function isIdle() {
        return !pumpScheduled
            && !rendering
            && renderQueue.length === 0
            && [...lanes.values()].every(lane => !lane.running && lane.queue.length === 0);
    }

    function notifyIdle() {
        if (!isIdle()) return;
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
    }

    function retryDelays(record) {
        return priority(record) <= 1 ? [1000, 2000, 5000] : [2000, 5000, 10000, 30000];
    }

    function maxAttemptsFor(record) {
        return priority(record) <= 1 ? 60 : 20;
    }

    // A codeless error must not be reported as a printer fault. Renderer crashes
    // (a missing browser, a dead page) carry no `code`, and labelling them
    // PRINTER_UNAVAILABLE sends the next reader to the printer while the real
    // message is discarded. Name the stage that actually failed and keep the text.
    function defaultCodeFor(stage) {
        return stage === 'render' ? 'RENDER_FAILED' : 'PRINTER_UNAVAILABLE';
    }

    function errorMessage(error) {
        const message = String(error?.message || '').trim();
        return message ? message.slice(0, 500) : null;
    }

    function boundedTiming(value) {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || number > MAX_TIMING_MS) return null;
        return Math.round(number);
    }

    function elapsedFrom(timestamp) {
        const startedAt = Date.parse(timestamp);
        return Number.isFinite(startedAt) ? boundedTiming(now() - startedAt) : null;
    }

    // Edge-triggered: a durable terminal result is new sync work. Notification is
    // advisory, so a broken callback must never alter the physical print outcome.
    function announceResult() {
        try {
            const pending = onResultReady();
            if (pending) Promise.resolve(pending).catch(error => console.error('result-ready hook failed', error));
        } catch (error) {
            console.error('result-ready hook failed', error);
        }
    }

    function scheduleRetry(record, error, stage) {
        const attempts = Number(record.result?.attempts || 0) + 1;
        if (attempts >= maxAttemptsFor(record)) {
            store.recordResult(record.queue_id, {
                outcome: 'permanent_failure',
                error_code: 'RETRY_LIMIT_EXHAUSTED',
                error_message: errorMessage(error),
                failure_stage: stage
            });
            announceResult();
            owned.delete(record.queue_id);
            return;
        }
        const delays = retryDelays(record);
        const delay = delays[Math.min(attempts - 1, delays.length - 1)];
        store.recordRetry(record.queue_id, {
            attempts,
            next_retry_at: new Date(now() + delay).toISOString(),
            error_code: error.code || defaultCodeFor(stage),
            error_message: errorMessage(error),
            failure_stage: stage,
            failure_class: 'transient_safe'
        });
        const timer = timers.setTimeout(() => {
            retryTimers.delete(timer);
            owned.delete(record.queue_id);
            wake();
        }, delay);
        retryTimers.add(timer);
    }

    function noteOutcome(record, deviceStatus) {
        const id = Number((record.job || record).printer_id);
        if (!Number.isInteger(id) || id < 1) return;
        if (!printerOutcomes.has(id) && printerOutcomes.size >= MAX_PRINTER_OUTCOMES) return;
        printerOutcomes.set(id, deviceStatus);
    }

    function finishFailure(record, error, stage = 'transport', printerFault = true) {
        if (error?.code === 'JOB_TERMINAL' || error?.message === 'JOB_TERMINAL') {
            owned.delete(record.queue_id);
            return;
        }
        // A render failure or a store failure after a good send is not the printer's fault.
        // Nor is a failure to read or verify the artifact before any byte goes to the printer.
        if (stage === 'transport' && printerFault && !PRE_TRANSPORT_ARTIFACT_CODES.has(error?.code)) noteOutcome(record, 'error');
        try {
            if (error.failureClass === 'uncertain') {
                // streamIntact: every byte was handed over before the failure, so the
                // physical outcome is unknown but the printer's parser is not mid-raster.
                store.recordResult(record.queue_id, {
                    outcome: 'uncertain',
                    error_code: error.code || 'TRANSPORT_OUTCOME_UNKNOWN',
                    error_message: errorMessage(error),
                    failure_stage: stage
                }, { hold: error.streamIntact !== true });
                announceResult();
            } else if (error.failureClass === 'permanent_safe') {
                store.recordResult(record.queue_id, {
                    outcome: 'permanent_failure',
                    error_code: error.code || 'PRINT_PERMANENT_FAILURE',
                    error_message: errorMessage(error),
                    failure_stage: stage
                });
                announceResult();
            } else if (currentRecord(record).state === 'transport_started') {
                if (error.preByte === true) {
                    store.revertTransportStarted(record.queue_id);
                    scheduleRetry(record, error, stage);
                    return;
                }
                store.recordResult(record.queue_id, {
                    outcome: 'uncertain',
                    error_code: error.code || defaultCodeFor(stage),
                    error_message: errorMessage(error),
                    failure_stage: stage
                });
                announceResult();
            } else {
                scheduleRetry(record, error, stage);
                return;
            }
        } catch (storeError) {
            if (storeError?.code !== 'JOB_TERMINAL' && storeError?.message !== 'JOB_TERMINAL') throw storeError;
        }
        owned.delete(record.queue_id);
    }

    // The store could not record this outcome (ENOSPC, an AV lock, a locked journal).
    // Release the record so it is not stranded for the process lifetime, but keep an
    // independent deadline so frequent sync wakes cannot turn it into a retry spin.
    function releaseAfterStoreFailure(record, storeError, stage) {
        owned.delete(record.queue_id);
        deferredUntil.set(record.queue_id, {
            notBefore: now() + STORE_FAILURE_RETRY_MS,
            record,
            storeError,
            stage
        });
        console.error(`print job ${record.queue_id}: could not record the ${stage} outcome, deferring the retry`, storeError);
    }

    // Past the transport marker the outcome is uncertain by definition, whatever the
    // store failed on. Keep the store error's code and text for diagnosis but pin the
    // classification, so the deferred retry can only ever persist a terminal outcome.
    function uncertainOutcome(storeError) {
        const error = new Error(storeError?.message || 'STORE_OUTCOME_DEFERRED');
        error.code = storeError?.code || 'STORE_OUTCOME_DEFERRED';
        error.failureClass = 'uncertain';
        return error;
    }

    function currentRecord(record) {
        return store.get(record.queue_id) || record;
    }

    function abandon(record) {
        owned.delete(record.queue_id);
    }

    function endpointFor(record) {
        const job = record.job || record;
        const key = printerEndpoint(job);
        return key;
    }

    function laneFor(endpoint) {
        if (!lanes.has(endpoint)) lanes.set(endpoint, { queue: [], running: false });
        return lanes.get(endpoint);
    }

    function runLane(printerId) {
        const lane = laneFor(printerId);
        if (!started || lane.running || lane.queue.length === 0) return;
        lane.running = true;
        (async () => {
            while (started && lane.queue.length > 0) {
                const record = lane.queue.shift();
                if (!RUNNABLE_STATES.has(currentRecord(record).state)) {
                    abandon(record);
                    continue;
                }
                const job = record.job || record;
                if (blockedPrinters.has(Number(job.printer_id)) || store.endpointHold?.(job)) {
                    abandon(record);
                    continue;
                }
                let sent = false;
                try {
                    const result = await transportFor(job).send({
                        printer: job,
                        artifact: record.artifact,
                        markTransportStarted: () => store.markTransportStarted(record.queue_id),
                        markTransportSent: details => store.markTransportSent?.(record.queue_id, details)
                    });
                    if (!result?.success) {
                        const error = new Error(result?.error_code || 'PRINT_FAILED');
                        error.code = result?.error_code;
                        error.failureClass = result?.failure_class || 'transient_safe';
                        throw error;
                    }
                    sent = true;
                    store.recordResult(record.queue_id, {
                        outcome: 'completed',
                        error_code: result.warningCode || null,
                        windows_job_id: result.windowsJobId ?? null,
                        transport_endpoint: endpointFor(record),
                        device_status: result.deviceStatus || 'unknown',
                        confidence: result.confidence || 'unknown',
                        duration_ms: result.durationMs,
                        render_duration_ms: boundedTiming(record.artifact?.render_ms),
                        local_duration_ms: elapsedFrom(record.accepted_local_at),
                        renderer: ['typst', 'raw'].includes(record.artifact?.renderer)
                            ? record.artifact.renderer
                            : null,
                        transport_mode: ['tcp', 'notification', 'poll', 'poll_fallback'].includes(result.transportMode)
                            ? result.transportMode
                            : null,
                        // The server already validates and stores both, and nulls
                        // anything malformed (spoolerSync.js:146). Duration is transport
                        // time, not queue/render time or physical paper completion.
                        artifact_bytes: record.artifact?.bytes,
                        artifact_hash: record.artifact?.hash
                    });
                    noteOutcome(record, 'ok');
                    announceResult();
                    owned.delete(record.queue_id);
                } catch (error) {
                    try {
                        finishFailure(record, error, 'transport', !sent);
                    } catch (storeError) {
                        releaseAfterStoreFailure(record, storeError, 'transport');
                    }
                }
            }
        })().finally(() => {
            lane.running = false;
            if (started && lane.queue.length > 0) runLane(printerId);
            wake(); // A completed marker may have released work held in the journal.
            notifyIdle();
        }).catch(err => console.error(err));
    }

    function enqueueLane(record) {
        const printerId = endpointFor(record);
        const lane = laneFor(printerId);
        // Same order as the render queue, so a kitchen ticket is not stuck behind receipts
        // already waiting on a shared printer. The job on the wire is never interrupted.
        const at = lane.queue.findIndex(queued => compareJobs(record, queued) < 0);
        if (at === -1) lane.queue.push(record); else lane.queue.splice(at, 0, record);
        runLane(printerId);
    }

    function collect() {
        const currentTime = now();
        for (const [queueId, deferred] of deferredUntil) {
            if (currentTime < deferred.notBefore) continue;
            const state = store.get(queueId)?.state;
            if (state === 'transport_started') {
                try {
                    // Classify here rather than replaying the captured error: it is a
                    // *store* error, and finishFailure branches on transport semantics.
                    // A store error carrying preByte would revert the marker and retry,
                    // reprinting a job that may already have reached paper.
                    finishFailure(deferred.record, uncertainOutcome(deferred.storeError), deferred.stage);
                    deferredUntil.delete(queueId);
                } catch (storeError) {
                    releaseAfterStoreFailure(deferred.record, storeError, deferred.stage);
                }
                continue;
            }
            deferredUntil.delete(queueId);
        }
        for (const record of store.runnable()) {
            if (owned.has(record.queue_id)) continue;
            if (deferredUntil.has(record.queue_id)) continue;
            if (blockedPrinters.has(Number(record.printer_id ?? record.job?.printer_id))) continue;
            if (store.endpointHold?.(record.job || record)) continue;
            if (record.state === 'retry_wait' && Date.parse(record.result?.next_retry_at) > currentTime) continue;
            owned.add(record.queue_id);
            renderQueue.push(record);
        }
        renderQueue.sort(compareJobs);
        if (renderingPrinterId !== null) {
            // An immutable artifact needs no browser time. Let another printer send
            // it now, without passing earlier work awaiting rendering on that lane.
            const renderBlocked = new Set([renderingPrinterId]);
            for (let index = 0; index < renderQueue.length;) {
                const record = renderQueue[index];
                const printerId = endpointFor(record);
                if (!record.artifact || record.result?.error_code === 'ARTIFACT_READ_FAILED') renderBlocked.add(printerId);
                if (renderBlocked.has(printerId)) { index++; continue; }
                renderQueue.splice(index, 1);
                enqueueLane(record);
            }
        }
    }

    async function pumpRender() {
        pumpScheduled = false;
        if (!started) return;
        collect();
        if (rendering) return;
        if (renderQueue.length === 0) {
            notifyIdle();
            return;
        }
        rendering = true;
        try {
            while (started && renderQueue.length > 0) {
                const record = renderQueue.shift();
                if (!RUNNABLE_STATES.has(currentRecord(record).state)) {
                    abandon(record);
                    continue;
                }
                renderingPrinterId = endpointFor(record);
                try {
                    if (!record.artifact || record.result?.error_code === 'ARTIFACT_READ_FAILED') {
                        const artifact = await renderer.render(record.job || record);
                        if (!RUNNABLE_STATES.has(currentRecord(record).state)) {
                            try {
                                if (artifact?.path) removeArtifact(artifact.path);
                            } catch {
                                store.retainArtifactForCleanup?.(record.queue_id, artifact);
                            }
                            abandon(record);
                            continue;
                        }
                        store.markRendered(record.queue_id, artifact);
                        record.artifact = artifact;
                        record.state = 'rendered';
                    }
                    if (!started) {
                        owned.delete(record.queue_id);
                        break;
                    }
                    enqueueLane(record);
                } catch (error) {
                    try {
                        finishFailure(record, error, 'render');
                    } catch (storeError) {
                        releaseAfterStoreFailure(record, storeError, 'render');
                    }
                } finally {
                    renderingPrinterId = null;
                }
                collect();
            }
        } finally {
            rendering = false;
            if (started && renderQueue.length > 0) pumpRender().catch(err => console.error(err));
            notifyIdle();
        }
    }

    function start() {
        if (started) return;
        started = true;
        wake();
        // One-shot: the renderer starts its compiler now so the first ticket does not wait for
        // it. It never rejects into the workers; a failed warm-up costs nothing but the head start.
        try { Promise.resolve(renderer.warm?.()).catch(() => {}); } catch { /* the first job reports it */ }
    }

    async function stop() {
        started = false;
        pumpScheduled = false;
        for (const record of renderQueue) owned.delete(record.queue_id);
        renderQueue.length = 0;
        for (const lane of lanes.values()) {
            for (const record of lane.queue) owned.delete(record.queue_id);
            lane.queue.length = 0;
        }
        for (const timer of retryTimers) timers.clearTimeout(timer);
        retryTimers.clear();
        if (!isIdle()) await new Promise(resolve => idleWaiters.add(resolve));
        owned.clear();
        deferredUntil.clear();
    }

    function wake() {
        if (started && !pumpScheduled) {
            pumpScheduled = true;
            queueMicrotask(() => pumpRender().catch(err => console.error(err)));
        }
    }

    function idle() {
        return isIdle() ? Promise.resolve() : new Promise(resolve => idleWaiters.add(resolve));
    }

    function health() {
        return {
            active: (rendering ? 1 : 0) + [...lanes.values()].filter(lane => lane.running).length,
            render_queue: renderQueue.length,
            printer_queues: Object.fromEntries([...lanes].map(([id, lane]) => [id, lane.queue.length + (lane.running ? 1 : 0)])),
            printers: [...printerOutcomes].map(([printerId, deviceStatus]) => ({ printer_id: printerId, device_status: deviceStatus })),
            renderer: renderer.health?.() || { state: 'unknown' }
        };
    }

    function setBlockedPrinters(ids) {
        blockedPrinters = new Set(ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0));
        wake();
    }

    return { start, stop, wake, idle, health, setBlockedPrinters };
}

module.exports = { createPrinterWorkers, priority, compareJobs };
