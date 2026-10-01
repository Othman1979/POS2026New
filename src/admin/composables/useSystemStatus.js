import { ref, computed, onMounted, onUnmounted } from 'vue';
import { t } from '@/shared/i18n.js';

export function useSystemStatus() {
    const isSocketConnected = ref(false);
    const printerStatuses = ref([]);
    const failedPrintJobsCount = ref(0);
    const stalePrintStations = ref([]);

    const allPrintersOnline = computed(() => printerStatuses.value.length > 0 && printerStatuses.value.every(p => p.online));
    const anyPrinterOnline = computed(() => printerStatuses.value.some(p => p.online));

    const systemHealth = computed(() => {
        const socketDown = !isSocketConnected.value;
        const printersDown = printerStatuses.value.length > 0 && !anyPrinterOnline.value;
        const printersWarn = printerStatuses.value.length > 0 && !allPrintersOnline.value && anyPrinterOnline.value;
        const hasFailedJobs = failedPrintJobsCount.value > 0;
        const staleCount = stalePrintStations.value.length;

        // Console status: solid teal dot pulses only when everything is live.
        if (socketDown || printersDown || hasFailedJobs) {
            return { level: 'down', dotClass: 'console-dot-down', pulse: false, label: t('Attention') };
        }
        if (printersWarn || staleCount > 0) {
            return { level: 'warn', dotClass: 'console-dot-warn', pulse: false, label: t('Check') };
        }
        return { level: 'ok', dotClass: 'console-dot-ok', pulse: true, label: t('All systems live') };
    });

    const handleSocketConnect = () => { isSocketConnected.value = true; };
    const handleSocketDisconnect = () => { isSocketConnected.value = false; };
    const handlePrinterStatusChanged = (e) => { printerStatuses.value = e.detail || []; };
    const handleFailedPrintJobsCount = (e) => { failedPrintJobsCount.value = e.detail || 0; };
    const handleStalePrintStations = (e) => { stalePrintStations.value = e.detail?.stations || []; };

    onMounted(() => {
        window.addEventListener('socket_connect', handleSocketConnect);
        window.addEventListener('socket_disconnect', handleSocketDisconnect);
        window.addEventListener('printer_status_changed', handlePrinterStatusChanged);
        window.addEventListener('failed_print_jobs_count', handleFailedPrintJobsCount);
        window.addEventListener('stale_print_stations', handleStalePrintStations);
    });

    onUnmounted(() => {
        window.removeEventListener('socket_connect', handleSocketConnect);
        window.removeEventListener('socket_disconnect', handleSocketDisconnect);
        window.removeEventListener('printer_status_changed', handlePrinterStatusChanged);
        window.removeEventListener('failed_print_jobs_count', handleFailedPrintJobsCount);
        window.removeEventListener('stale_print_stations', handleStalePrintStations);
    });

    return { isSocketConnected, printerStatuses, failedPrintJobsCount, stalePrintStations, allPrintersOnline, anyPrinterOnline, systemHealth };
}
