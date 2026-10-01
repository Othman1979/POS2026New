import { fetchJson } from '@/shared/http.js';
import { ref, watch, onMounted, onUnmounted } from 'vue';

export function useDailyReportPage(endpoint, period) {
    const data = ref(null);
    const loading = ref(false);
    const error = ref(null);
    let abortController = null;
    let lastRequestTime = 0;

    const fetchData = async () => {
        if (abortController) {
            abortController.abort();
        }
        abortController = new AbortController();
        const { signal } = abortController;
        loading.value = true;
        error.value = null;

        const requestTime = Date.now();
        lastRequestTime = requestTime;

        try {
            const json = await fetchJson(`api/admin/reports/${endpoint}?start_date=${period.startDate.value}&end_date=${period.endDate.value}`, { signal });
            if (requestTime === lastRequestTime) {
                if (json.success) {
                    data.value = json;
                } else {
                    error.value = json.message || 'Failed to fetch report';
                }
            }
        } catch (err) {
            if (err.name !== 'AbortError' && requestTime === lastRequestTime) {
                error.value = err.message || 'Network error';
            }
        } finally {
            if (requestTime === lastRequestTime) {
                loading.value = false;
            }
        }
    };

    watch([period.startDate, period.endDate], () => {
        fetchData();
    });

    onMounted(() => {
        fetchData();
    });

    onUnmounted(() => {
        if (abortController) {
            abortController.abort();
        }
    });

    return {
        data,
        loading,
        error,
        reload: fetchData
    };
}
