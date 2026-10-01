const BACKOFF_MS = [2000, 5000, 10000];
const ACTIVE_STATUSES = new Set(['active', 'draining']);
const PAUSED_STATUSES = new Set(['revoked', 'decommissioned']);
const RESERVED_KITCHEN_JOBS = 5;
// Registration attempts for a replacement identity in one mismatch episode.
const MAX_ROTATION_ATTEMPTS = 5;
// After an episode ends on transient failures (station busy, server down), wait this
// long, then try again with a fresh set of attempts.
const ROTATION_COOLDOWN_MS = 5 * 60 * 1000;

function createAgentRuntime({
    store,
    syncClient: initialSyncClient,
    prepareIdentity = null,
    // A replacement identity left on disk by a previous run: { syncClient, commit, discard }.
    pendingCandidate = null,
    worker,
    clock = { setTimeout, clearTimeout },
    maxLocalJobs = 50,
    startupJitterMs = 0,
    agentVersion = null,
    agentName = null,
    now = () => Date.now(),
    random = Math.random,
    log = console.error
}) {
    let stopped = true;
    let timer = null;
    let inFlight = null;
    let currentAttemptController = null;
    let pendingWake = false;
    // True while the request in the air may be held by the server (nothing to report). A wake
    // ends such a request early so a finished job is reported at once, not after the hold.
    let holdableInFlight = false;
    let wakeAborted = false;
    let backoffUntil = 0;
    let registeredAttempted = false;
    let consecutiveFailures = 0;
    let workersStarted = false;
    let currentStatus = store.agentStatus?.() || 'starting';
    const lastPrinterFacts = new Map();
    let pendingPrinterFacts = [];
    const rejectedJobs = [];
    let lastCleanupAt = -Infinity;
    let cleanupError = null;
    let syncClient = initialSyncClient;
    // One identity rotation per station-mismatch episode; a good sync ends the episode.
    let rotatedThisEpisode = false;
    let rotation = null;
    let blockedLoggedCount = null;
    // When an episode ended on transient failures, the time a new one may begin.
    let rotationRearmAt = null;
    // What the admin page should promise: 'healing' (the agent will retry by itself) or
    // 'blocked' (a person must act). Sent only while a mismatch episode is running.
    let mismatchState = null;
    // A candidate from a previous run is tried first; the old identity is the fallback.
    let tentative = pendingCandidate;
    const savedSyncClient = initialSyncClient;
    if (tentative) syncClient = tentative.syncClient;

    function syncDelay(value, fallback) {
        return Math.min(Math.max(Number(value) || fallback, 500), 5000);
    }

    function schedule(delay) {
        if (stopped) return;
        if (timer !== null) clock.clearTimeout(timer);
        timer = clock.setTimeout(async () => {
            timer = null;
            // Single-flight. A zero-delay timer fires long before an HTTP round trip
            // returns, so without this a wake starts a second tick alongside the first:
            // the same outbox is sent twice, two transactions overlap on one agent's
            // rows, and stop() ends up awaiting only the newer one.
            if (inFlight) {
                pendingWake = true;
                return;
            }
            inFlight = tick();
            try {
                await inFlight;
            } finally {
                inFlight = null;
                if (pendingWake) {
                    pendingWake = false;
                    // Never shorten containment - same rule as wake().
                    if (now() >= backoffUntil) schedule(0);
                }
            }
        }, delay);
    }

    function storeHealth() {
        const local = store.health();
        const workerHealth = worker.health?.() || {};
        return {
            ...workerHealth,
            ...local,
            worker_active: Number(workerHealth.active || 0),
            rejected_jobs: [...rejectedJobs],
            cleanup_error: cleanupError
        };
    }

    function printerDelta(printers) {
        if (!Array.isArray(printers)) return [];
        const delta = [];
        pendingPrinterFacts = [];
        for (const printer of printers.slice(0, 64)) {
            const id = Number(printer?.printer_id ?? printer?.id);
            if (!Number.isInteger(id) || id < 1) continue;
            const fact = {
                printer_id: id,
                device_status: printer.device_status || 'unknown',
                status_source: printer.status_source || 'agent'
            };
            const signature = JSON.stringify(fact);
            if (lastPrinterFacts.get(id) !== signature) {
                delta.push(fact);
                pendingPrinterFacts.push({ id, signature });
            }
        }
        return delta;
    }

    function commitPrinterFacts() {
        for (const { id, signature } of pendingPrinterFacts) lastPrinterFacts.set(id, signature);
        pendingPrinterFacts = [];
    }

    function body() {
        const health = storeHealth();
        const active = Math.max(0, Number(health.active || 0));
        const nonKitchenActive = Math.max(0, Number(health.non_kitchen_active ?? active));
        const kitchenReserve = Math.min(RESERVED_KITCHEN_JOBS, maxLocalJobs);
        const totalCapacity = Math.max(0, maxLocalJobs - active);
        const generalCapacity = Math.min(
            totalCapacity,
            Math.max(0, maxLocalJobs - kitchenReserve - nonKitchenActive)
        );
        const accepting = currentStatus !== 'draining' && !PAUSED_STATUSES.has(currentStatus);
        const drainComplete = currentStatus === 'draining'
            && store.runnable().length === 0
            && store.outbox().length === 0
            && Number(health.active || 0) === 0
            && Number(health.worker_active || 0) === 0;
        return {
            protocol_version: 2,
            accepted: store.unconfirmedAccepted(),
            results: store.outbox(),
            health: {
                ...health,
                agent_version: agentVersion || null,
                agent_name: agentName || null,
                local_queue_depth: Number.isInteger(Number(health.active)) ? Number(health.active) : null,
                printers: printerDelta(health.printers),
                drain_complete: drainComplete
            },
            // Reserve part of the same bounded journal for urgent kitchen work.
            // Old servers keep using `capacity`; updated servers may use the
            // additive kitchen allowance without increasing maxLocalJobs.
            capacity: accepting ? generalCapacity : 0,
            kitchen_capacity: accepting ? totalCapacity : 0,
            ...(mismatchState ? { mismatch_state: mismatchState } : {})
        };
    }

    function applySyncResponse(response) {
        // Apply authoritative conflicts before starting/restarting durable local
        // work. Throttle/older-server responses that omit the field cannot clear it.
        if (Array.isArray(response.blocked_printer_ids)) worker.setBlockedPrinters?.(response.blocked_printer_ids);
        // `progressed` is measured as durable local movement, not from response fields.
        // A response can echo work back without anything advancing - a re-sent job we
        // already hold, a cancel for something already terminal - and treating that as
        // urgency is the loop the rate limiter used to have to absorb.
        const unconfirmedBefore = store.unconfirmedAccepted().length;
        const outboxBefore = store.outbox().length;
        store.confirmAccepted(response.confirmed_accepted || []);
        store.confirmResults(response.confirmed_results || []);
        let progressed = store.unconfirmedAccepted().length < unconfirmedBefore
            || store.outbox().length < outboxBefore;
        for (const queueId of response.cancel_requested || []) {
            const beforeState = store.get(queueId)?.state || null;
            const canceled = store.requestCancel(queueId);
            if (canceled?.state !== beforeState) progressed = true;
        }
        const accepted = [];
        for (const job of response.jobs || []) {
            let record;
            const existing = store.get(job?.queue_id);
            try {
                record = store.accept(job);
            } catch (error) {
                const code = error?.code || error?.message;
                if (!['JOB_IDENTITY_INVALID', 'PAYLOAD_IDENTITY_CONFLICT'].includes(code)) throw error;
                rejectedJobs.push({ queue_id: Number(job?.queue_id) || null, error_code: code });
                if (rejectedJobs.length > 16) rejectedJobs.shift();
                continue;
            }
            if (record.state !== 'canceled') {
                accepted.push({ queue_id: record.queue_id, payload_hash: record.payload_hash });
                // Only a job we did not already hold is progress. `accept` is idempotent
                // and returns the existing record on a replay, so without this guard a
                // server that keeps re-sending the same unaccepted row spins at 0ms.
                if (!existing) progressed = true;
            }
        }
        return { accepted, progressed };
    }

    function startWorkers() {
        if (workersStarted) {
            worker.wake?.();
            return;
        }
        worker.start?.();
        workersStarted = true;
    }

    async function stopWorkers() {
        if (!workersStarted) return;
        await worker.stop?.();
        workersStarted = false;
    }

    // Work this agent identity still owes the server or the printers: accepted but
    // unconfirmed jobs, unsent results, and anything queued, rendered, printing or
    // waiting to retry. Rotating the identity with any of it pending would orphan it.
    function unfinishedWork() {
        return Math.max(
            Number(store.health().active) || 0,
            store.unconfirmedAccepted().length,
            store.outbox().length,
            store.runnable().length,
            Number(worker.health?.().active) || 0
        );
    }

    async function refuseStationMismatch() {
        if (currentStatus !== 'registration_failed') log('STATION_MISMATCH');
        currentStatus = 'registration_failed';
        store.setAgentStatus?.(currentStatus);
        await stopWorkers();
        schedule(10000);
    }

    function discardRotation() {
        const staged = rotation;
        rotation = null;
        try { staged?.candidate?.discard?.(); } catch { /* the temp file is swept on next start */ }
    }

    // Worth another attempt on a later tick: the server said "not now" (un-owned
    // in-flight work is still settling), is failing, or could not be reached.
    // Everything else (invalid_identity, station_occupied, a refused bootstrap key)
    // needs a person to change something.
    function retryableRegistration(error) {
        if (!error?.status) return true;
        return error.status >= 500 || error.status === 429
            || (error.status === 409 && error.code === 'station_busy');
    }

    // The saved identity is bound to another station on the server. When nothing is
    // unfinished on either side, a fresh identity registers under the configured
    // station (same bootstrap-key check as a new install) and replaces agent.json only
    // after the server accepts it. Returns true when it has already rescheduled; false
    // lets the caller's normal backoff continue.
    async function handleStationMismatch(attemptController, mismatchError) {
        if (!prepareIdentity) {
            mismatchState = 'blocked';
            await refuseStationMismatch();
            return true;
        }
        if (rotatedThisEpisode) {
            // An episode that ended on transient failures starts again after a cool-down.
            // A permanent refusal (or a rotated identity that mismatches too) never does.
            if (rotationRearmAt === null || now() < rotationRearmAt) {
                await refuseStationMismatch();
                return true;
            }
            rotatedThisEpisode = false;
            rotationRearmAt = null;
        }
        // The server counts rows it still holds for this identity (a lost sync response
        // can leave claimed work the journal never saw). A body without the count comes
        // from an older server, so the answer is unknown and the safe answer is to wait.
        const reported = mismatchError?.response?.server_unfinished;
        const serverUnfinished = Number.isInteger(reported) && reported >= 0 ? reported : null;
        const localUnfinished = unfinishedWork();
        if (localUnfinished > 0 || serverUnfinished !== 0) {
            discardRotation();
            mismatchState = 'blocked';
            await refuseStationMismatch();
            const summary = `local=${localUnfinished} server=${serverUnfinished ?? 'unknown'}`;
            if (blockedLoggedCount !== summary) {
                blockedLoggedCount = summary;
                log(`STATION_MISMATCH_BLOCKED ${summary}`);
            }
            return true;
        }
        mismatchState = 'healing';
        try {
            await stopWorkers();
            // Staging counts as an attempt too, so a helper that is briefly unavailable
            // is retried inside the same bounded episode.
            if (!rotation) rotation = { candidate: null, attempts: 0 };
            rotation.attempts += 1;
            if (!rotation.candidate) rotation.candidate = await prepareIdentity();
            await rotation.candidate.syncClient.register({ signal: attemptController.signal });
        } catch (healError) {
            if (stopped) return true;
            log(`STATION_MISMATCH_HEAL_FAILED ${healError?.code || healError?.message || 'error'}`);
            // Nothing staged yet: only a failure marked transient_safe (the platform helper
            // restarting, busy or timing out) is worth another try; anything else is permanent.
            const transient = Boolean(rotation) && (rotation.candidate
                ? retryableRegistration(healError)
                : healError?.failureClass === 'transient_safe');
            if (transient && rotation.attempts < MAX_ROTATION_ATTEMPTS) return false;
            discardRotation();
            rotatedThisEpisode = true;
            rotationRearmAt = transient ? now() + ROTATION_COOLDOWN_MS : null;
            mismatchState = transient ? 'healing' : 'blocked';
            await refuseStationMismatch();
            return true;
        }
        // Accepted: the server holds this identity, so it is the one to use from here on,
        // even if promoting it on disk fails (it stays on disk as a candidate and the
        // next start finishes the job).
        const accepted = rotation.candidate;
        rotation = null;
        rotatedThisEpisode = true;
        syncClient = accepted.syncClient;
        try {
            await accepted.commit();
        } catch (commitError) {
            tentative = accepted;
            log(`STATION_IDENTITY_PROMOTION_DEFERRED ${commitError?.code || commitError?.message || 'error'}`);
        }
        if (stopped) return true;
        log('STATION_MISMATCH_HEALED');
        currentStatus = 'starting';
        store.setAgentStatus?.(currentStatus);
        schedule(0);
        return true;
    }

    async function tick() {
        if (stopped) return;
        const attemptController = new AbortController();
        currentAttemptController = attemptController;
        try {
            if (now() - lastCleanupAt >= 60 * 60 * 1000) {
                lastCleanupAt = now();
                try {
                    store.cleanup?.();
                    cleanupError = null;
                } catch {
                    cleanupError = 'JOURNAL_CLEANUP_FAILED';
                }
            }
            const requestBody = body();
            holdableInFlight = requestBody.accepted.length === 0 && requestBody.results.length === 0;
            wakeAborted = false;
            let response;
            try {
                response = await syncClient.sync(requestBody, { signal: attemptController.signal });
            } catch (error) {
                // A wake that ended the held request is not a failure: no backoff, the
                // coalesced wake starts the next sync with the new outbox right away.
                if (wakeAborted && !stopped) return;
                throw error;
            } finally {
                holdableInFlight = false;
            }
            if (stopped) return;
            registeredAttempted = false;
            rotatedThisEpisode = false;
            rotationRearmAt = null;
            mismatchState = null;
            blockedLoggedCount = null;
            if (rotation) discardRotation();
            if (tentative) {
                // The server accepted the candidate: promote it to agent.json.
                const promoting = tentative;
                tentative = null;
                try {
                    await promoting.commit();
                    log('STATION_IDENTITY_CANDIDATE_PROMOTED');
                } catch (promoteError) {
                    log(`STATION_IDENTITY_PROMOTION_DEFERRED ${promoteError?.code || promoteError?.message || 'error'}`);
                }
            }
            commitPrinterFacts();
            consecutiveFailures = 0;
            backoffUntil = 0;
            currentStatus = response.agent_status || 'active';
            store.setAgentStatus?.(currentStatus);
            const { accepted, progressed } = applySyncResponse(response);

            if (PAUSED_STATUSES.has(currentStatus)) {
                await stopWorkers();
                schedule(syncDelay(response.next_sync_ms, 5000));
                return;
            }
            if (!ACTIVE_STATUSES.has(currentStatus)) {
                await stopWorkers();
                schedule(5000);
                return;
            }

            startWorkers();
            if (response.throttled === true) {
                schedule(syncDelay(response.next_sync_ms, 5000));
                return;
            }
            const urgent = accepted.length > 0
                || store.unconfirmedAccepted().length > 0
                || store.outbox().length > 0
                || (response.jobs || []).length > 0;
            // Urgency alone does not justify a 0ms reschedule. If nothing advanced, the
            // next sync carries an identical body; pacing it costs a genuinely stuck
            // accept one cadence of latency and nothing else.
            // `held`: the server kept an idle request open and found nothing, so poll again now.
            schedule(urgent && progressed || response.held === true ? 0 : syncDelay(response.next_sync_ms, 2000));
        } catch (error) {
            if (tentative && ((error.status === 401 && error.code === 'unauthorized_agent')
                || (error.status === 409 && error.code === 'station_mismatch'))) {
                // The server does not know the leftover candidate (or it belongs to another
                // station): drop it and carry on with the saved identity.
                const rejected = tentative;
                tentative = null;
                syncClient = savedSyncClient;
                try { rejected.discard?.(); } catch { /* swept on next start */ }
                if (stopped) return;
                schedule(0);
                return;
            }
            if (error.status === 409 && error.code === 'station_mismatch') {
                if (await handleStationMismatch(attemptController, error)) return;
            }
            if (error.status === 401 && error.code === 'unauthorized_agent' && !registeredAttempted) {
                registeredAttempted = true;
                try {
                    await syncClient.register({ signal: attemptController.signal });
                    if (stopped) return;
                    schedule(0);
                    return;
                } catch (registerError) {
                    if (registerError.status === 409 && registerError.code === 'station_mismatch'
                        && await handleStationMismatch(attemptController, registerError)) return;
                    if (stopped) return;
                    if (registerError.status && registerError.status < 500) {
                        currentStatus = 'registration_failed';
                        store.setAgentStatus?.(currentStatus);
                    } else {
                        registeredAttempted = false;
                    }
                }
            }
            if (stopped) return;
            const base = BACKOFF_MS[Math.min(consecutiveFailures, BACKOFF_MS.length - 1)];
            const delay = base + Math.floor(base * 0.25 * random());
            consecutiveFailures += 1;
            backoffUntil = now() + delay;
            schedule(delay);
        } finally {
            if (currentAttemptController === attemptController) currentAttemptController = null;
        }
    }

    function start() {
        if (!stopped) return;
        stopped = false;
        if (tentative && unfinishedWork() > 0) {
            // Work already sits in the journal; never move it to another identity.
            const dropped = tentative;
            tentative = null;
            syncClient = savedSyncClient;
            try { dropped.discard?.(); } catch { /* swept on next start */ }
        }
        schedule(startupJitterMs);
    }

    async function stop() {
        stopped = true;
        if (timer !== null) {
            clock.clearTimeout(timer);
            timer = null;
        }
        currentAttemptController?.abort(new DOMException('The agent is stopping', 'AbortError'));
        if (inFlight) await inFlight;
        // A staged candidate stays on disk: the server may already hold it, and the next
        // start decides (promote it, or drop it if the server never heard of it).
        rotation = null;
        await stopWorkers();
    }

    function wake() {
        if (stopped) return;
        // Coalesce into the sync already in the air rather than racing it.
        if (inFlight) {
            pendingWake = true;
            if (holdableInFlight && currentAttemptController) {
                wakeAborted = true;
                currentAttemptController.abort(new DOMException('Woken by local work', 'AbortError'));
            }
            return;
        }
        // A finished print is not a reason to cancel outage backoff. The result is
        // durable in the outbox and the backed-off tick will ship it, so dropping the
        // wake loses nothing and keeps a failing server from being hit once per lane.
        if (now() < backoffUntil) return;
        schedule(0);
    }

    function health() {
        return {
            status: currentStatus,
            workers_started: workersStarted,
            consecutive_failures: consecutiveFailures,
            ...storeHealth()
        };
    }

    return { start, stop, wake, health };
}

module.exports = { createAgentRuntime };
