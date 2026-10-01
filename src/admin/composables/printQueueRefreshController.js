import { ADMIN_REALTIME_EVENT } from '../realtime.js';

// Events make the view faster; the 30 s fallback below keeps it correct for transitions that
// announce nothing (a station first becoming active, health-only changes, automatic drains).
const SIGNAL_EVENTS = new Set([
    'print_queue_updated',
    'stale_print_stations',
    'failed_print_jobs_count',
    'socket_reconnected'
]);

export function createPrintQueueRefreshController({
    load,
    eventTarget = window,
    documentRef = document,
    fallbackMs = 30 * 1000,
    signalMinMs = 5 * 1000,
    debounceMs = 250
} = {}) {
    if (typeof load !== 'function') throw new TypeError('Print queue refresh requires load().');
    let started = false;
    let active = false;
    let inFlight = null;
    let immediatePending = false;
    let signalDirty = false;
    let lastReadStartedAt = Number.NEGATIVE_INFINITY;
    let fallbackTimer = null;
    let signalTimer = null;

    const visible = () => documentRef.visibilityState !== 'hidden';
    const clearFallback = () => {
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        fallbackTimer = null;
    };
    const clearSignalTimer = () => {
        if (signalTimer !== null) clearTimeout(signalTimer);
        signalTimer = null;
    };
    const scheduleFallback = () => {
        clearFallback();
        if (!started || !active || !visible()) return;
        fallbackTimer = setTimeout(() => {
            fallbackTimer = null;
            void refreshNow();
        }, fallbackMs);
    };
    const waitForCurrent = async () => {
        try { await inFlight; } catch (_) {}
        return false;
    };
    const scheduleSignalRead = () => {
        if (!started || !active || !visible() || !signalDirty || inFlight) return;
        clearFallback();
        if (signalTimer !== null) return;
        const sinceLastStart = performance.now() - lastReadStartedAt;
        const delay = Math.max(debounceMs, signalMinMs - sinceLastStart, 0);
        signalTimer = setTimeout(() => {
            signalTimer = null;
            if (!started || !active || !visible() || !signalDirty) return;
            signalDirty = false;
            void refreshNow();
        }, delay);
    };
    async function refreshNow({ force = false } = {}) {
        if (!started || (!force && (!active || !visible()))) return false;
        clearFallback();
        if (inFlight) {
            const current = inFlight;
            if (force) {
                try { await current; } catch (_) {}
                return refreshNow({ force: true });
            }
            immediatePending = true;
            return waitForCurrent();
        }
        clearSignalTimer();
        signalDirty = false;
        immediatePending = false;
        lastReadStartedAt = performance.now();
        const request = Promise.resolve().then(load);
        inFlight = request;
        let success = false;
        try {
            await request;
            success = true;
        } catch (_) {
            // Keep the last good diagnostic snapshot; recovery stays bounded.
        } finally {
            if (inFlight === request) inFlight = null;
            if (started) {
                if (active && visible() && immediatePending) {
                    immediatePending = false;
                    signalDirty = false;
                    void refreshNow();
                } else if (active && visible() && signalDirty) {
                    scheduleSignalRead();
                } else {
                    immediatePending = false;
                    scheduleFallback();
                }
            }
        }
        return success;
    }
    const signal = () => {
        if (!started || !visible()) return;
        signalDirty = true;
        if (!active) return;
        clearFallback();
        if (inFlight) return;
        scheduleSignalRead();
    };
    const handleRealtime = event => {
        if (SIGNAL_EVENTS.has(event.detail?.type)) signal();
    };
    const handleVisibility = () => {
        if (!visible()) {
            clearFallback();
            clearSignalTimer();
            return;
        }
        signal();
    };
    const handleFocus = () => signal();
    const start = () => {
        if (started) return;
        started = true;
        eventTarget.addEventListener(ADMIN_REALTIME_EVENT, handleRealtime);
        eventTarget.addEventListener('focus', handleFocus);
        documentRef.addEventListener('visibilitychange', handleVisibility);
    };
    const setActive = (value, { reconcile = true } = {}) => {
        const next = Boolean(value);
        if (active === next) return Promise.resolve(false);
        active = next;
        clearFallback();
        clearSignalTimer();
        immediatePending = false;
        if (!active) {
            signalDirty = false;
            return Promise.resolve(false);
        }
        if (!reconcile) return Promise.resolve(false);
        if (inFlight) {
            immediatePending = true;
            return waitForCurrent();
        }
        return refreshNow();
    };
    const stop = () => {
        started = false;
        active = false;
        immediatePending = false;
        signalDirty = false;
        clearFallback();
        clearSignalTimer();
        eventTarget.removeEventListener(ADMIN_REALTIME_EVENT, handleRealtime);
        eventTarget.removeEventListener('focus', handleFocus);
        documentRef.removeEventListener('visibilitychange', handleVisibility);
    };
    return { start, stop, setActive, refreshNow };
}
