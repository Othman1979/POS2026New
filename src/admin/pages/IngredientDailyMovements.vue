<template>
    <div class="report-page ingredients-report">
        <div v-if="error" class="report-error" role="alert">
            <span>{{ $t(error) }}</span>
            <button @click="reload">{{ $t('Retry') }}</button>
        </div>

        <div class="ingredients-report__toolbar print:hidden">
            <div class="stock-views" role="group" :aria-label="$t('Stock detail view')"><button type="button" :aria-pressed="stockView === 'balances'" @click="stockView='balances'">{{ $t('Ingredient balances') }}</button><button type="button" :aria-pressed="stockView === 'waste'" @click="stockView='waste'">{{ $t('Waste by reason') }}</button></div>
            <ReportPrintMenu :label="$t('Print daily movements')" :disabled="!printProvider" :busy="isPrinting" @select="printDaily" />
        </div>

        <p v-if="loading" role="status">{{ $t('Loading report...') }}</p>
        <template v-if="reportData">
        <section class="ingredients-report__metrics">
            <div>
                <span>{{ $t('Cost of ingredients used') }}</span>
                <strong data-no-i18n>{{ formatReportMoney(totals.used_cost) }}</strong>
            </div>
            <div>
                <span>{{ $t('Waste cost') }}</span>
                <strong data-no-i18n>{{ formatReportMoney(totals.waste_cost) }}</strong>
            </div>
            <div>
                <span>{{ $t('Ingredient cost %') }}</span>
                <strong data-no-i18n>{{ foodCostLabel }}</strong>
            </div>
            <div>
                <span>{{ $t('Below minimum stock') }}</span>
                <strong data-no-i18n>{{ totals.below_par_count }}</strong>
            </div>
        </section>

        <section v-if="stockView === 'balances'" class="report-section">
            <header class="report-section__header">
                <h2 class="report-section__title">{{ $t('Ingredients') }}</h2>
            </header>
            <div v-if="!reportData.ingredients.length" class="ingredients-report__empty">{{ $t('No ingredients.') }}</div>
            <div v-else class="ingredients-report__table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>{{ $t('Name') }}</th>
                            <th>{{ $t('Unit') }}</th>
                            <th class="logical-text-start">{{ $t('Opening stock') }}</th>
                            <th class="logical-text-start">{{ $t('Received') }}</th>
                            <th class="logical-text-start">{{ $t('Used quantity') }}</th>
                            <th class="logical-text-start">{{ $t('Waste') }}</th>
                            <th class="logical-text-start">{{ $t('Closing stock') }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="row in reportData.ingredients" :key="row.id" :class="{ 'is-below-par': row.below_par }">
                            <td><strong data-no-i18n>{{ row.name }}</strong></td>
                            <td data-no-i18n>{{ row.display_unit }}</td>
                            <td class="logical-text-start"><bdi dir="ltr" data-no-i18n>{{ formatQty(row.opening, row.display_unit) }}</bdi></td>
                            <td class="logical-text-start"><bdi dir="ltr" data-no-i18n>{{ formatQty(row.received, row.display_unit) }}</bdi></td>
                            <td class="logical-text-start"><bdi dir="ltr" data-no-i18n>{{ formatQty(row.used, row.display_unit) }}</bdi></td>
                            <td class="logical-text-start"><bdi dir="ltr" data-no-i18n>{{ formatQty(row.waste, row.display_unit) }}</bdi></td>
                            <td class="logical-text-start"><bdi dir="ltr" data-no-i18n>{{ formatQty(row.closing_expected, row.display_unit) }}</bdi></td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>

        <section v-else class="report-section">
            <div v-if="!wasteReasons.length" class="ingredients-report__empty">{{ $t('No waste recorded.') }}</div>
            <div v-else class="ingredients-report__table-wrap"><table><thead><tr><th>{{ $t('Ingredient') }}</th><th>{{ $t('Reason') }}</th><th class="logical-text-start">{{ $t('Quantity') }}</th></tr></thead><tbody><tr v-for="item in wasteReasons" :key="item.key"><th scope="row" data-no-i18n>{{ item.name }}</th><td>{{ $t(reasonLabel(item.reason)) }}</td><td class="logical-text-start"><bdi dir="ltr" data-no-i18n>{{ formatQty(item.qty,item.unit) }} {{ item.unit }}</bdi></td></tr></tbody></table></div>
        </section>
        </template>
    </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { fetchJson } from '@/shared/http.js';
import { formatReportMoney, formatReportPercent } from '../utils/reportFormatting.js';
import { buildDailyIngredientsPrintPayload } from './dailyReportPayloads.js';

import ReportPrintMenu from '../components/ReportPrintMenu.vue';
import { useBrowserReportPrint } from '../composables/useBrowserReportPrint.js';
import { fromBaseQty as fromBase } from '@/shared/ingredientUnits.js';
const REASON_LABELS = {
    spoiled: 'Spoiled',
    expired: 'Expired',
    dropped_or_burnt: 'Dropped or burnt',
    over_prepared: 'Over-prepared',
    staff_meal: 'Staff meal',
    other: 'Other',
};

const props = defineProps({ date: { type: String, required: true } });
const selectedDate = computed(() => props.date);
const printProvider = ref(null);
const registerDailyReportPrint = provider => { printProvider.value = provider; };
const { printReport, isPrinting } = useBrowserReportPrint();
const printDaily = layout => printProvider.value ? printReport(layout, printProvider.value) : false;
const stockView = ref('balances');
const data = ref(null);
const loading = ref(false);
const error = ref(null);
let abortController = null;
let lastRequestTime = 0;
let loadedDate = null;

const reportData = computed(() => data.value);
const totals = computed(() => data.value?.totals || {
    used_cost: 0,
    waste_cost: 0,
    sales_total: null,
    food_cost_pct: null,
    below_par_count: 0,
});
const foodCostLabel = computed(() => {
    const pct = totals.value.food_cost_pct;
    return pct == null ? '—' : formatReportPercent(Number(pct) * 100);
});
const wasteReasons = computed(() => {
    const items = [];
    for (const row of data.value?.ingredients || []) {
        for (const [reason, qty] of Object.entries(row.waste_by_reason || {})) {
            items.push({
                key: `${row.id}-${reason}`,
                name: row.name,
                reason,
                qty,
                unit: row.display_unit,
            });
        }
    }
    return items;
});

function formatQty(qty, unit) {
    const value = fromBase(qty, unit);
    return value == null ? '—' : String(value);
}

function reasonLabel(reason) {
    return REASON_LABELS[reason] || reason;
}

async function reload() {
    if (abortController) abortController.abort();
    abortController = new AbortController();
    const { signal } = abortController;
    const requestTime = ++lastRequestTime;
    const date = selectedDate.value;
    loading.value = true;
    error.value = null;
    data.value = null;
    registerDailyReportPrint?.(null);
    try {
        const json = await fetchJson(`api/admin/reports/ingredients?date=${date}`, { signal });
        if (requestTime !== lastRequestTime) return;
        if (json.success) { loadedDate = date; data.value = json; }
        else error.value = json.message || 'Failed to fetch report';
    } catch (caught) {
        if (caught.name !== 'AbortError' && requestTime === lastRequestTime) {
            error.value = caught.message || 'Network error';
        }
    } finally {
        if (requestTime === lastRequestTime) loading.value = false;
    }
}

function registerProvider() {
    const ready = data.value && !loading.value && !error.value && loadedDate === selectedDate.value;
    registerDailyReportPrint?.(ready ? async () => {
        if (!data.value || loading.value || error.value || loadedDate !== selectedDate.value) throw new Error('Report is not ready.');
        return buildDailyIngredientsPrintPayload(data.value);
    } : null);
}

onMounted(() => {
    reload();
    registerProvider();
});
watch(() => selectedDate.value, reload);
watch([data, loading, error], registerProvider);
onUnmounted(() => {
    lastRequestTime++;
    abortController?.abort();
    registerDailyReportPrint?.(null);
});
</script>

<style scoped>
.ingredients-report { display: grid; gap: 1rem; }
.ingredients-report__toolbar { display: flex; align-items: end; gap: 1rem; flex-wrap: wrap; border: 1px solid #d4d4d8; border-radius: 10px; padding: .75rem 1rem; background: #fafafa; }
.ingredients-report__toolbar label { display: grid; gap: .3rem; }
.ingredients-report__toolbar span { color: #71717a; font-size: .72rem; font-weight: 700; }
.ingredients-report__toolbar input { min-height: 2.65rem; border: 1px solid #d4d4d8; border-radius: 8px; padding: .45rem .7rem; }
.ingredients-report__metrics { display: grid; grid-template-columns: repeat(4, 1fr); overflow: hidden; border: 1px solid #d4d4d8; border-radius: 12px; background: #fff; }
.ingredients-report__metrics > div { display: flex; min-height: 6.5rem; flex-direction: column; justify-content: center; border-inline-start: 1px solid #e4e4e7; padding: 1.1rem; }
.ingredients-report__metrics > div:first-child { border-inline-start: 0; background: #fafafa; }
.ingredients-report__metrics span { color: #71717a; font-size: .72rem; font-weight: 700; }
.ingredients-report__metrics strong { margin-top: .45rem; color: #27272a; font-size: 1.35rem; }
.ingredients-report__table-wrap { overflow-x: auto; }
.ingredients-report table { width: 100%; min-width: 40rem; border-collapse: collapse; }
.ingredients-report th, .ingredients-report td { border-bottom: 1px solid #e4e4e7; padding: .7rem .75rem; font-size: .7rem; text-align: start; }
.ingredients-report th { color: #71717a; background: #fafafa; font-weight: 750; }
.ingredients-report tr.is-below-par td { color: #b45309; }
.ingredients-report__empty { padding: 2rem; color: #71717a; font-size: .78rem; text-align: center; }
.ingredients-report__reasons { padding: .35rem 1rem 1rem; }
.ingredients-report__reasons > div { display: flex; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #f4f4f5; padding: .75rem 0; }
@media (max-width: 800px) {
    .ingredients-report__metrics { grid-template-columns: 1fr 1fr; }
    .ingredients-report__metrics > div { border-top: 1px solid #e4e4e7; }
    .ingredients-report__metrics > div:nth-child(odd) { border-inline-start: 0; }
}
.stock-views { display: flex; gap: 4px; margin-inline-end: auto; flex-wrap: wrap; }
.stock-views button { min-height: 40px; padding: 6px 12px; border-radius: 6px; color: #536371; }
.stock-views button[aria-pressed="true"] { background: #24405e; color: #fff; }
.stock-views button:focus-visible { outline: 2px solid #315d86; outline-offset: 2px; }
</style>
