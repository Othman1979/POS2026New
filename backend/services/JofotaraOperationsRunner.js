const ACTIVE_INTERVAL_MS = 60 * 1000;
const INACTIVE_STALE_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 1000;

function createJofotaraOperationsRunner({
    processOperations,
    recoverStale,
    publish,
    logger,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    activeIntervalMs = ACTIVE_INTERVAL_MS,
    inactiveStaleIntervalMs = INACTIVE_STALE_INTERVAL_MS,
    retryIntervalMs = RETRY_INTERVAL_MS
}) {
    let started = false;
    let mode = 'unknown';
    let timer = null;
    let inFlight = null;
    let configRevision = 0;
    let fullPending = false;

    function clearTimer() {
        if (timer === null) return;
        clearTimeoutFn(timer);
        timer = null;
    }

    function schedule(kind, delay) {
        if (!started) return;
        clearTimer();
        timer = setTimeoutFn(() => {
            timer = null;
            return kind === 'full' ? runFull() : runStaleOnly();
        }, delay);
        timer?.unref?.();
    }

    function safePublish(result) {
        if (Number(result?.attempted || 0) === 0 && Number(result?.stale || 0) === 0) return;
        try {
            publish(result);
        } catch (error) {
            logger.warn({ err: error }, 'Failed to publish JoFotara operations change.');
        }
    }

    function scheduleForMode() {
        if (mode === 'active') schedule('full', activeIntervalMs);
        else schedule('stale', inactiveStaleIntervalMs);
    }

    function observeInFlight() {
        return inFlight ? inFlight.catch(() => undefined) : Promise.resolve(undefined);
    }

    async function runFull() {
        if (!started) return undefined;
        if (inFlight) {
            fullPending = true;
            return observeInFlight();
        }
        clearTimer();
        const revisionAtStart = configRevision;
        const request = Promise.resolve().then(processOperations);
        inFlight = request;
        let result;
        let success = false;
        try {
            result = await request;
            success = true;
            if (revisionAtStart === configRevision) {
                mode = result?.automatic_enabled === true ? 'active' : 'inactive';
            }
            safePublish(result);
        } catch (error) {
            logger.warn({ err: error }, 'JoFotara operations check failed (non-fatal).');
        } finally {
            if (inFlight === request) inFlight = null;
        }
        if (!started) return result;
        if (fullPending && mode === 'active') {
            fullPending = false;
            void runFull();
        } else if (!success && mode !== 'inactive') {
            schedule('full', retryIntervalMs);
        } else {
            fullPending = false;
            scheduleForMode();
        }
        return result;
    }

    async function runStaleOnly() {
        if (!started) return undefined;
        if (inFlight) return observeInFlight();
        clearTimer();
        const request = Promise.resolve().then(recoverStale);
        inFlight = request;
        let stale = 0;
        let success = false;
        try {
            stale = Number(await request) || 0;
            success = true;
            safePublish({
                automatic_enabled: false,
                attempted: 0,
                accepted: 0,
                rejected: 0,
                unknown: 0,
                failed: 0,
                stale
            });
        } catch (error) {
            logger.warn({ err: error }, 'JoFotara stale submission check failed (non-fatal).');
        } finally {
            if (inFlight === request) inFlight = null;
        }
        if (!started) return stale;
        if (fullPending && mode === 'active') {
            fullPending = false;
            void runFull();
        } else {
            schedule('stale', success ? inactiveStaleIntervalMs : retryIntervalMs);
        }
        return stale;
    }

    function start() {
        if (started) return inFlight || Promise.resolve(undefined);
        started = true;
        return runFull();
    }

    function configure(automaticEnabled) {
        configRevision += 1;
        mode = automaticEnabled ? 'active' : 'inactive';
        clearTimer();
        if (!started) return Promise.resolve(undefined);
        if (!automaticEnabled) {
            fullPending = false;
            if (!inFlight) schedule('stale', inactiveStaleIntervalMs);
            return observeInFlight();
        }
        if (inFlight) {
            fullPending = true;
            return observeInFlight();
        }
        return runFull();
    }

    async function stop() {
        if (!started && !inFlight) return;
        started = false;
        fullPending = false;
        clearTimer();
        if (inFlight) await inFlight.catch(() => {});
    }

    return { start, configure, stop };
}

module.exports = { createJofotaraOperationsRunner };
