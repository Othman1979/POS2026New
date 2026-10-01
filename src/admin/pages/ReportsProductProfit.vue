<script setup>
import { computed, inject, ref } from 'vue';
import { useDailyReportPage } from '../composables/useDailyReportPage.js';
import { formatReportMoney, formatReportNumber } from '../utils/reportFormatting.js';
import { currentLanguage, t } from '@/shared/i18n.js';
import { buildProductProfitPrintHtml } from './productProfitPrint.js';

const period = inject('dailyReportPeriod');
const { data, loading, error, reload } = useDailyReportPage('product-profit', period);
const search = ref('');

const products = computed(() => {
    const needle = search.value.trim().toLowerCase();
    const rows = data.value?.products || [];
    return needle ? rows.filter(row => `${row.item_name} ${row.category_name || ''}`.toLowerCase().includes(needle)) : rows;
});

const money = (value) => (value === null || value === undefined ? '—' : formatReportMoney(value));
const percent = (value) => (value === null || value === undefined ? '—' : `${formatReportNumber(value)}%`);
const sourceLabel = { purchase_average: 'Purchase average', product_cost: 'Product cost price', unknown: 'No cost' };

const exporting = ref('');
const fileName = (ext) => {
    const range = data.value?.period;
    const dates = range?.start_date === range?.end_date ? range?.start_date : `${range?.start_date}_${range?.end_date}`;
    return `product-profit_${dates}.${ext}`;
};

async function exportExcel() {
    if (!data.value || exporting.value) return;
    exporting.value = 'excel';
    try {
        const XLSX = await import('xlsx');
        const header = ['Product', 'Category', 'Sold', 'Returned', 'Net qty', 'Net sales before tax',
            'Average unit cost', 'Cost source', 'Cost of goods sold', 'Profit', 'Margin %'].map(label => t(label));
        const rows = products.value.map(row => [
            row.item_name, row.category_name || '', row.sold_qty, row.returned_qty, row.net_qty, row.net_sales,
            row.unit_cost, t(sourceLabel[row.cost_source]), row.cost, row.profit, row.margin_pct,
        ]);
        const totals = data.value.totals;
        const period = data.value.period;
        const sheet = XLSX.utils.aoa_to_sheet([
            [t('Product profit')],
            [`${period.start_date} → ${period.end_date}`],
            [],
            header,
            ...rows,
            [],
            [t('Total'), '', '', '', '', totals.net_sales, '', '', totals.known_cost, totals.profit, totals.margin_pct],
        ]);
        sheet['!cols'] = [28, 18, 9, 9, 9, 16, 14, 16, 16, 12, 10].map(wch => ({ wch }));
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheet, 'Profit');
        if (currentLanguage.value === 'ar') workbook.Workbook = { Views: [{ RTL: true }] };
        XLSX.writeFile(workbook, fileName('xlsx'));
    } catch (err) {
        console.error('Excel export failed', err);
        window.showAdminToast?.(t('Export failed'), 'error');
    } finally {
        exporting.value = '';
    }
}

function printPdf() {
    if (!data.value) return;
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;inset-inline-start:-9999px';
    frame.srcdoc = buildProductProfitPrintHtml({
        report: data.value,
        products: products.value,
        t,
        rtl: currentLanguage.value === 'ar',
        money,
        number: formatReportNumber,
        percent,
        sourceLabel,
    });
    frame.onload = () => {
        const view = frame.contentWindow;
        view.addEventListener('afterprint', () => frame.remove(), { once: true });
        view.focus();
        view.print();
    };
    document.body.appendChild(frame);
}
</script>

<template>
    <div v-if="loading && !data" class="report-state" aria-live="polite"><p>{{ $t('Loading report...') }}</p></div>
    <div v-else-if="error && !data" class="report-state">
        <div>
            <p class="font-semibold text-rose-700">{{ $t(error) }}</p>
            <button class="mt-4" @click="reload">{{ $t('Retry') }}</button>
        </div>
    </div>
    <div v-else-if="data" class="report-page profit-page">
        <div v-if="error" role="alert" class="report-error"><span>{{ $t(error) }}</span><button @click="reload">{{ $t('Retry') }}</button></div>

        <div class="profit-actions">
            <button type="button" class="profit-action" :disabled="!!exporting" @click="exportExcel">
                <i :class="exporting === 'excel' ? 'fa-solid fa-circle-notch fa-spin' : 'fa-solid fa-file-excel'" aria-hidden="true"></i>
                <span>{{ $t('Export to Excel') }}</span>
            </button>
            <button type="button" class="profit-action" @click="printPdf">
                <i class="fa-solid fa-file-pdf" aria-hidden="true"></i>
                <span>{{ $t('Print PDF') }}</span>
            </button>
        </div>

        <section class="profit-totals">
            <div class="profit-totals__primary">
                <span class="report-metric-label">{{ $t('Gross profit') }}</span>
                <strong class="tabular-nums" :class="{ 'is-loss': data.totals.profit < 0 }">{{ money(data.totals.profit) }}</strong>
                <small>{{ $t('Margin') }} {{ percent(data.totals.margin_pct) }}</small>
            </div>
            <div><span class="report-metric-label">{{ $t('Net sales before tax') }}</span><strong class="tabular-nums">{{ money(data.totals.net_sales) }}</strong></div>
            <div><span class="report-metric-label">{{ $t('Cost of goods sold') }}</span><strong class="tabular-nums">{{ money(data.totals.known_cost) }}</strong></div>
        </section>

        <div class="profit-definition">
            <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
            <span>{{ $t('Profit = net sales before tax − sold quantity × weighted average purchase cost. The average uses all posted purchase invoices up to the end of the period.') }}</span>
        </div>
        <div v-if="data.totals.missing_cost" class="profit-warning" role="status">
            {{ $t('Products without a purchase invoice or cost price are excluded from profit:') }} <strong class="tabular-nums" data-no-i18n>{{ data.totals.missing_cost }}</strong>
        </div>

        <section class="report-section">
            <header class="report-section__header">
                <h2 class="report-section__title">{{ $t('Profit by product') }}</h2>
                <input v-model="search" type="search" class="profit-search" :placeholder="$t('Search products')" />
            </header>
            <div class="profit-table-wrap">
                <table class="profit-table">
                    <thead>
                        <tr>
                            <th>{{ $t('Product') }}</th>
                            <th class="text-center">{{ $t('Net qty') }}</th>
                            <th class="text-end">{{ $t('Net sales before tax') }}</th>
                            <th class="text-end">{{ $t('Average unit cost') }}</th>
                            <th class="text-end">{{ $t('Cost of goods sold') }}</th>
                            <th class="text-end">{{ $t('Profit') }}</th>
                            <th class="text-end">{{ $t('Margin') }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-if="!products.length"><td colspan="7" class="profit-table__empty">{{ $t('No sales in this period.') }}</td></tr>
                        <tr v-for="row in products" :key="row.product_id">
                            <td><strong data-no-i18n>{{ row.item_name }}</strong><small v-if="row.category_name" data-no-i18n>{{ row.category_name }}</small></td>
                            <td class="text-center tabular-nums">{{ formatReportNumber(row.net_qty) }}<small v-if="row.returned_qty > 0" class="text-rose-700">−{{ formatReportNumber(row.returned_qty) }} {{ $t('Returned') }}</small></td>
                            <td class="text-end tabular-nums">{{ money(row.net_sales) }}</td>
                            <td class="text-end tabular-nums">{{ row.unit_cost === null ? '—' : formatReportNumber(row.unit_cost, { maximumFractionDigits: 4 }) }}<small>{{ $t(sourceLabel[row.cost_source]) }}</small></td>
                            <td class="text-end tabular-nums">{{ money(row.cost) }}</td>
                            <td class="text-end tabular-nums font-bold" :class="{ 'is-loss': row.profit < 0 }">{{ money(row.profit) }}</td>
                            <td class="text-end tabular-nums" :class="{ 'is-loss': row.margin_pct < 0 }">{{ percent(row.margin_pct) }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>
    </div>
</template>

<style scoped>
.profit-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
.profit-action { display: inline-flex; align-items: center; gap: 0.45rem; border: 1px solid #d4d4d8; border-radius: 8px; background: #fff; padding: 0.5rem 0.85rem; color: #27272a; font-size: 0.75rem; font-weight: 700; }
.profit-action:hover:not(:disabled) { background: #fafafa; }
.profit-action:disabled { opacity: 0.6; cursor: wait; }
.profit-action .fa-file-excel { color: #15803d; }
.profit-action .fa-file-pdf { color: #be123c; }
.profit-totals { display: grid; grid-template-columns: minmax(0, 1.65fr) repeat(2, minmax(12rem, 0.7fr)); overflow: hidden; border: 1px solid #d4d4d8; border-radius: 12px; background: #fff; }
.profit-totals > div { display: flex; min-height: 7.8rem; flex-direction: column; justify-content: center; padding: 1.4rem; }
.profit-totals > div + div { border-inline-start: 1px solid #e4e4e7; }
.profit-totals__primary { background: #fafafa; }
.profit-totals strong { margin-top: 0.55rem; color: #27272a; font-size: 1.45rem; font-weight: 750; }
.profit-totals__primary strong { font-size: clamp(2.2rem, 4vw, 3.6rem); letter-spacing: -0.045em; }
.profit-totals small { margin-top: 0.3rem; color: #71717a; font-size: 0.75rem; }
.profit-definition { display: flex; align-items: center; gap: 0.55rem; border-inline-start: 2px solid #24405e; padding: 0.25rem 0.75rem; color: #71717a; font-size: 0.7rem; line-height: 1.5; }
.profit-definition i { color: #24405e; }
.profit-warning { border-radius: 8px; background: #fffbeb; color: #92400e; padding: 0.6rem 0.85rem; font-size: 0.75rem; }
.profit-search { width: min(16rem, 100%); border: 1px solid #d4d4d8; border-radius: 8px; padding: 0.45rem 0.7rem; font-size: 0.75rem; }
.profit-table-wrap { overflow-x: auto; }
.profit-table { width: 100%; min-width: 52rem; border-collapse: collapse; color: #3f3f46; font-size: 0.74rem; }
.profit-table th { padding: 0.7rem 0.85rem; color: #71717a; background: #fafafa; font-size: 0.65rem; font-weight: 750; text-align: start; }
.profit-table th.text-end { text-align: end; }
.profit-table th.text-center { text-align: center; }
.profit-table td { padding: 0.75rem 0.85rem; vertical-align: top; }
.profit-table td small { display: block; color: #71717a; font-size: 0.65rem; }
.profit-table tbody tr { border-top: 1px solid #f0f0f1; }
.profit-table tbody tr:hover { background: #fafafa; }
.profit-table__empty { height: 8rem; color: #71717a; text-align: center; }
.is-loss { color: #be123c; }
@media (max-width: 760px) {
    .profit-totals { grid-template-columns: 1fr; }
    .profit-totals > div + div { border-inline-start: 0; border-top: 1px solid #e4e4e7; }
}
</style>
