import { invalidateSystemSettings } from '@/shared/systemSettings.js';
import { io } from 'socket.io-client';
import { SOCKET_CLIENT_OPTIONS, applyReconnectPolicy, createRefusalRetry } from '@/shared/socketRefusalRetry.js';
import { retryFailedBusinessConfig } from '@/utils/businessDate.js';
import { isSessionEnding } from '@/pos/sessionEnding.js';

export const ADMIN_REALTIME_EVENT = 'admin:realtime';
export const ADMIN_HEARTBEAT_EVENT = 'admin:socket-heartbeat';

export function emitAdminRealtime(type, payload = {}, eventTarget = window) {
    if (type === 'settings_changed' || type === 'socket_reconnected') {
        invalidateSystemSettings();
    }
    eventTarget.dispatchEvent(new CustomEvent(ADMIN_REALTIME_EVENT, {
        detail: { type, payload }
    }));
    eventTarget.dispatchEvent(new CustomEvent(type, { detail: payload }));
}

const FORWARDED_EVENTS = [
    'inventory_changed', 'new_order', 'shifts_changed', 'table_update',
    'expenses_changed', 'settings_changed', 'printer_status_changed',
    'failed_print_jobs_count', 'stale_print_stations',
    'print_queue_updated', 'jofotara_operations_changed', 'ingredients_changed', 'device_access_changed'
];

export function createAdminRealtimeBridge({
    ioFactory = io,
    eventTarget = window
} = {}) {
    const socket = ioFactory({ ...SOCKET_CLIENT_OPTIONS, withCredentials: true });
    let needsRecoveryRefresh = false;
    let stopped = false;
    const refusalRetry = createRefusalRetry(socket);
    applyReconnectPolicy(socket);
    // A business-config read that failed or timed out at boot re-runs once the
    // server is provably reachable (connect / heartbeat); no request while fine.
    // The heartbeat is also the retry tick for admin reads that failed (stock alerts).
    const onHeartbeat = () => {
        retryFailedBusinessConfig();
        eventTarget.dispatchEvent(new CustomEvent(ADMIN_HEARTBEAT_EVENT));
    };
    socket.io?.on('ping', onHeartbeat);

    socket.on('connect', () => {
        refusalRetry.connected();
        retryFailedBusinessConfig();
        eventTarget.dispatchEvent(new CustomEvent('socket_connect'));
        if (needsRecoveryRefresh) {
            needsRecoveryRefresh = false;
            emitAdminRealtime('socket_reconnected', {}, eventTarget);
        }
    });
    socket.on('disconnect', reason => {
        needsRecoveryRefresh = true;
        // Our own logout makes the server drop this socket; reconnecting into it would only be refused.
        if (!isSessionEnding()) refusalRetry.serverDisconnected(reason);
        eventTarget.dispatchEvent(new CustomEvent('socket_disconnect'));
    });
    socket.on('connect_error', error => {
        if (error?.message?.startsWith('Unauthorized:')) {
            socket.disconnect();
            if (isSessionEnding()) return; // logout is already navigating
            eventTarget.dispatchEvent(new CustomEvent('socket_auth_error', {
                detail: error.message
            }));
            return;
        }
        needsRecoveryRefresh = true;
        refusalRetry.refused();
    });
    for (const type of FORWARDED_EVENTS) {
        socket.on(type, payload => emitAdminRealtime(type, payload, eventTarget));
    }
    return () => {
        if (stopped) return;
        stopped = true;
        refusalRetry.cancel();
        socket.io?.off('ping', onHeartbeat);
        socket.disconnect();
    };
}
