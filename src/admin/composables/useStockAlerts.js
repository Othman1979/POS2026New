import { fetchJson } from '@/shared/http.js';
import { onUnmounted, ref } from 'vue';
import { ADMIN_HEARTBEAT_EVENT, ADMIN_REALTIME_EVENT } from '../realtime.js';

const STOCK_SETTING_KEYS = new Set(['stock_enabled', 'low_stock_threshold']);
// Every write that can move a low-stock row emits one of these: sales, refunds and stock
// adjustments send inventory_changed; ingredient movements and recipe edits send ingredients_changed.
const STOCK_SIGNAL_TYPES = new Set(['inventory_changed', 'ingredients_changed', 'socket_reconnected']);

export function createStockAlertsController({
    fetchAlerts = () => fetchJson('api/admin/alerts'),
    eventTarget = window,
    documentRef = document,
    signalMinMs = 30 * 1000,
    debounceMs = 250
} = {}) {
    const lowStockItems = ref([]);
    let started = false;
    let generation = 0;
    let inFlight = null;
    let signalDirty = false;
    let lastReadStartedAt = Number.NEGATIVE_INFINITY;
    let signalTimer = null;
    let lastReadFailed = false;

    const visible = () => documentRef.visibilityState !== 'hidden';
    const clearSignalTimer = () => {
        if (signalTimer !== null) clearTimeout(signalTimer);
        signalTimer = null;
    };

    const scheduleSignalRead = () => {
        if (!started || !visible() || !signalDirty || inFlight || signalTimer !== null) return;
        const sinceLastStart = performance.now() - lastReadStartedAt;
        const delay = Math.max(debounceMs, signalMinMs - sinceLastStart, 0);
        signalTimer = setTimeout(() => {
            signalTimer = null;
            if (!started || !visible() || !signalDirty) return;
            signalDirty = false;
            void refreshNow();
        }, delay);
    };

    async function refreshNow() {
        if (!started || !visible()) return false;
        if (inFlight) {
            signalDirty = true;
            try { await inFlight; } catch (_) {}
            return false;
        }

        clearSignalTimer();
        signalDirty = false;
        lastReadStartedAt = performance.now();
        const requestGeneration = generation;
        const request = Promise.resolve().then(fetchAlerts);
        inFlight = request;
        let success = false;
        try {
            const data = await request;
            if (started && requestGeneration === generation && data?.success) {
                lowStockItems.value = data.lowStockItems || [];
                success = true;
            }
        } catch (_) {
            // Keep the last good list; the next socket heartbeat, event, focus or reconnect reads again.
        } finally {
            lastReadFailed = !success;
            if (inFlight === request) inFlight = null;
            if (!started) {
                signalDirty = false;
            } else if (signalDirty && visible()) {
                scheduleSignalRead();
            }
        }
        return success;
    }

    function requestRefresh() {
        if (!started || !visible()) return;
        signalDirty = true;
        if (!inFlight) scheduleSignalRead();
    }

    function handleRealtime(event) {
        const detail = event.detail;
        if (STOCK_SIGNAL_TYPES.has(detail?.type)) {
            requestRefresh();
            return;
        }
        if (detail?.type !== 'settings_changed') return;
        const keys = detail.payload?.keys;
        const validKeys = Array.isArray(keys)
            && keys.length > 0
            && keys.every(key => typeof key === 'string');
        if (!validKeys || keys.some(key => STOCK_SETTING_KEYS.has(key))) {
            requestRefresh();
        }
    }

    const handleFocus = () => requestRefresh();
    // A healthy client sends nothing; after a failed read the next heartbeat retries once.
    const handleHeartbeat = () => {
        if (lastReadFailed) requestRefresh();
    };
    // The boot read can go out before the socket has joined the staff room, so a change in that
    // window would never arrive as an event. The first connect re-reads once to close it.
    const handleFirstConnect = () => {
        eventTarget.removeEventListener('socket_connect', handleFirstConnect);
        void refreshNow();
    };
    const handleVisibility = () => {
        if (!visible()) {
            clearSignalTimer();
            return;
        }
        requestRefresh();
    };

    function start() {
        if (started) return Promise.resolve(false);
        started = true;
        generation += 1;
        eventTarget.addEventListener(ADMIN_REALTIME_EVENT, handleRealtime);
        eventTarget.addEventListener('focus', handleFocus);
        eventTarget.addEventListener(ADMIN_HEARTBEAT_EVENT, handleHeartbeat);
        eventTarget.addEventListener('socket_connect', handleFirstConnect);
        documentRef.addEventListener('visibilitychange', handleVisibility);
        return refreshNow();
    }

    function stop() {
        if (!started) return;
        started = false;
        generation += 1;
        signalDirty = false;
        clearSignalTimer();
        eventTarget.removeEventListener(ADMIN_REALTIME_EVENT, handleRealtime);
        eventTarget.removeEventListener('focus', handleFocus);
        eventTarget.removeEventListener(ADMIN_HEARTBEAT_EVENT, handleHeartbeat);
        eventTarget.removeEventListener('socket_connect', handleFirstConnect);
        documentRef.removeEventListener('visibilitychange', handleVisibility);
    }

    return { lowStockItems, start, stop, refreshNow };
}

export function useStockAlerts() {
    const controller = createStockAlertsController();
    onUnmounted(controller.stop);
    return {
        lowStockItems: controller.lowStockItems,
        start: controller.start
    };
}
