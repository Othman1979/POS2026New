import { ref, shallowRef } from 'vue';
import { io } from 'socket.io-client';
import { useAuth } from './useAuth.js';
import { isSessionEnding } from './sessionEnding.js';
import { checkPendingBrowserApproval } from '@/shared/browserDeviceClient.js';
import { SOCKET_CLIENT_OPTIONS, applyReconnectPolicy, createRefusalRetry } from '@/shared/socketRefusalRetry.js';
import { retryFailedBusinessConfig } from '@/utils/businessDate.js';
import { retryDeferredLanguage } from '@/shared/i18n/runtime.js';

// The socket object is never deeply reactive: only its identity and the flags around it are watched.
const socket = shallowRef(null);
const isSocketConnected = ref(false);
const connectionGeneration = ref(0);
const printerStatuses = ref([]);
const failedPrintJobsCount = ref(0);
let refusalRetry = null;

export function useSocket() {
    const isCallCenter = () => useAuth().activeUser?.value?.role === 'call_center';

    const initSocket = () => {
        if (socket.value) {
            return socket.value;
        }

        const s = io({ ...SOCKET_CLIENT_OPTIONS, withCredentials: true });
        socket.value = s;
        isSocketConnected.value = s.connected;
        let needsRecoveryRefresh = false;
        const retry = createRefusalRetry(s);
        refusalRetry = retry;
        applyReconnectPolicy(s);
        // Boot reads that failed or timed out re-run once the server is provably
        // reachable (connect / heartbeat); no request while they are fine.
        const recoverBootReads = () => { retryFailedBusinessConfig(); retryDeferredLanguage(); };
        s.on('connect', recoverBootReads);
        s.io.on('ping', recoverBootReads);

        s.on('connect', () => {
            retry.connected();
            connectionGeneration.value += 1;
            isSocketConnected.value = true;
            if (needsRecoveryRefresh) {
                needsRecoveryRefresh = false;
                window.dispatchEvent(new CustomEvent('socket_reconnected'));
                void checkPendingBrowserApproval();
            }
        });

        s.on('disconnect', (reason) => {
            isSocketConnected.value = false;
            needsRecoveryRefresh = true;
            // socket.io never reconnects a server-forced disconnect (session revoked or swapped,
            // e.g. a completed device approval). One handshake either succeeds with the current
            // cookie or is refused with "Unauthorized:", which logs out below.
            if (!isSessionEnding()) retry.serverDisconnected(reason);
        });

        s.on('device_request_changed', () => { void checkPendingBrowserApproval(); });

        s.on('connect_error', async (err) => {
            needsRecoveryRefresh = true;
            if (err.message && err.message.startsWith('Unauthorized:')) {
                s.disconnect();
                if (isSessionEnding()) return; // our own logout is already navigating
                const { logout } = useAuth();
                await logout('expired');
                return;
            }
            retry.refused();
        });

        if (isCallCenter()) {
            printerStatuses.value = [];
            failedPrintJobsCount.value = 0;
        }

        s.on('printer_status_changed', (statuses) => {
            if (isCallCenter()) return;
            printerStatuses.value = statuses;
        });

        s.on('failed_print_jobs_count', (count) => {
            if (isCallCenter()) return;
            failedPrintJobsCount.value = count;
        });

        return s;
    };

    const disconnectSocket = () => {
        refusalRetry?.cancel();
        refusalRetry = null;
        if (socket.value) {
            socket.value.disconnect();
            socket.value = null;
            isSocketConnected.value = false;
        }
    };

    return {
        socket,
        isSocketConnected,
        connectionGeneration,
        printerStatuses,
        failedPrintJobsCount,
        initSocket,
        disconnectSocket
    };
}
