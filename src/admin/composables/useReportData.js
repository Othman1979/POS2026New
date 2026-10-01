import { inject, ref, computed } from 'vue';

// Normalizes the reports inject boilerplate. ReportsLayout provides 'reportData'
// as a ref; pages consume it as a null-safe computed. Call inside setup().
export function useReportData() {
    const injected = inject('reportData', ref({}));
    const data = computed(() => injected.value || {});
    const slice = (key, fallback = []) => computed(() => data.value[key] || fallback);
    return { data, slice };
}
