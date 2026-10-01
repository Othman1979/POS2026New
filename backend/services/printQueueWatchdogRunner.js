const {
    createPrintQueueHealthLogger,
    createStalePrintStationsBroadcaster,
    createStationLivenessBroadcaster,
    getStationLiveness,
    refreshFailedPrintJobsCount,
    getPrintQueueHealth,
    getStalePrintStations
} = require('./printQueueWatchdog');

const RECOVERY_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const MIN_RUN_MS = 30 * 1000;
const DEBOUNCE_MS = 25;

function createPrintQueueWatchdogRunner({
    db,
    logger,
    emitStale,
    emitLiveness,
    onFailedCount,
    wakeHub,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    recoveryMs = RECOVERY_MS,
    retryMs = RETRY_MS,
    minRunMs = MIN_RUN_MS,
    debounceMs = DEBOUNCE_MS
}) {
    const logHealthChange = createPrintQueueHealthLogger(logger);
    const broadcastStaleIfChanged = createStalePrintStationsBroadcaster(emitStale);
    const broadcastLivenessIfChanged = createStationLivenessBroadcaster(() => emitLiveness?.());
    let started = false;
    let timer = null;
    let timerDueAt = Infinity;
    let inFlight = null;
    let dirty = false;
    let lastStartedAt = -Infinity;
    let unsubscribe = null;

    function clearTimer() {
        if (timer === null) return;
        clearTimeoutFn(timer);
        timer = null;
        timerDueAt = Infinity;
    }

    function scheduleAt(dueAt) {
        if (!started || (timer !== null && timerDueAt <= dueAt)) return;
        clearTimer();
        timerDueAt = dueAt;
        timer = setTimeoutFn(() => {
            timer = null;
            timerDueAt = Infinity;
            return run();
        }, Math.max(0, dueAt - now()));
        timer?.unref?.();
    }

    function scheduleDirty() {
        scheduleAt(Math.max(now() + debounceMs, lastStartedAt + minRunMs));
    }

    // A read that started before the last applied one is dropped, so a slow pre-reset read
    // cannot bring back an old station list.
    let staleStarted = 0;
    let staleApplied = 0;
    async function readStale() {
        const seq = ++staleStarted;
        const stations = await getStalePrintStations(db);
        if (seq < staleApplied) return;
        staleApplied = seq;
        broadcastStaleIfChanged(stations);
    }

    async function inspect() {
        const health = await getPrintQueueHealth(db);
        logHealthChange(health);
        await readStale();
        const liveness = await getStationLiveness(db);
        broadcastLivenessIfChanged(liveness.offline);
        if (onFailedCount) await refreshFailedPrintJobsCount(db, onFailedCount);
    }

    // Recompute the stale-station list now and broadcast it if it changed. For callers that just
    // emptied print_queue (operational reset) and cannot wait for the rate-limited wake().
    async function refreshStale() {
        await readStale();
    }

    async function run() {
        if (!started || inFlight) return inFlight;
        clearTimer();
        dirty = false;
        lastStartedAt = now();
        const request = inspect();
        inFlight = request;
        let success = false;
        try {
            await request;
            success = true;
        } catch (error) {
            logger.error({ err: error }, 'Print queue watchdog encountered an error.');
        } finally {
            if (inFlight === request) inFlight = null;
            if (started) {
                if (dirty) scheduleDirty();
                else if (!success) scheduleAt(now() + retryMs);
                // One server-side pass when the soonest online station would go stale.
                else scheduleAt(now() + recoveryMs);
            }
        }
        return success;
    }

    function wake() {
        if (!started) return false;
        dirty = true;
        if (!inFlight) scheduleDirty();
        return true;
    }

    function start() {
        if (started) return inFlight || Promise.resolve(undefined);
        started = true;
        unsubscribe = wakeHub?.subscribe?.(wake) || null;
        return run();
    }

    async function stop() {
        if (!started && !inFlight) return;
        started = false;
        dirty = false;
        clearTimer();
        unsubscribe?.();
        unsubscribe = null;
        if (inFlight) await inFlight.catch(() => {});
    }

    return { start, wake, stop, refreshStale };
}

module.exports = { createPrintQueueWatchdogRunner };
