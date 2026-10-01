<template>
    <div v-if="loading && !hasLoaded" class="report-state" aria-live="polite">
        <div>
            <div class="report-state__skeleton" aria-hidden="true"><span></span><span></span><span></span></div>
            <p>{{ $t('Loading report...') }}</p>
        </div>
    </div>

    <div v-else-if="error && !hasLoaded" class="report-state">
        <div>
            <p class="font-semibold text-rose-700">{{ $t(error) }}</p>
            <button @click="fetchRefundReport" class="mt-4 rounded-lg bg-teal-700 px-4 py-2 text-xs font-bold text-white hover:bg-teal-800">
                {{ $t('Retry') }}
            </button>
        </div>
    </div>

    <div v-else class="report-page">
        <div v-if="error" role="alert" class="report-error">
            <span>{{ $t(error) }}</span>
            <button @click="fetchRefundReport">{{ $t('Retry') }}</button>
        </div>

        <section class="refund-spotlight" :aria-label="$t('Refunds & Voids')">
            <div class="refund-spotlight__primary">
                <span class="report-metric-label">{{ $t('Refunds Issued') }}</span>
                <strong class="font-display tabular-nums">-{{ formatMoney(summary.refund_total) }}</strong>
                <small>{{ formatNumber(summary.refund_count) }} {{ $t('Refund Events') }}</small>
            </div>
            <div>
                <span class="report-metric-label">{{ $t('Refund Rate') }}</span>
                <strong class="tabular-nums">{{ summary.refund_rate !== null ? formatPercent(summary.refund_rate) : '-' }}</strong>
                <small v-if="summary.refund_rate === null">{{ $t('No sales processed in this period') }}</small>
            </div>
            <div>
                <span class="report-metric-label">{{ $t('Sales Processed') }}</span>
                <strong class="tabular-nums">{{ formatMoney(summary.sales_processed) }}</strong>
            </div>
            <div>
                <span class="report-metric-label">{{ $t('Voided item value: no money returned') }}</span>
                <strong class="tabular-nums">{{ formatMoney(summary.void_value) }}</strong>
                <small>{{ formatNumber(summary.void_count) }} {{ $t('Void Events') }}</small>
            </div>
        </section>

        <section class="refund-method-strip" :aria-label="$t('Refund Methods')">
            <div><span>{{ $t('Cash Refunds') }}</span><strong>{{ formatMoney(summary.refund_cash) }}</strong></div>
            <div><span>{{ $t('Card Refunds') }}</span><strong>{{ formatMoney(summary.refund_card) }}</strong></div>
            <div><span>{{ $t('Refund Events') }}</span><strong>{{ formatNumber(summary.refund_count) }}</strong></div>
            <div><span>{{ $t('Void Events') }}</span><strong>{{ formatNumber(summary.void_count) }}</strong></div>
        </section>

        <div v-if="byStaff.length || topReasons.length" class="refund-insights-grid">
            <section v-if="byStaff.length" class="report-section refund-staff">
                <header class="report-section__header">
                    <div>
                        <h2 class="report-section__title">{{ $t('Staff Activity') }}</h2>
                        <span class="report-section__hint">{{ $t('Refund and void activity by staff member') }}</span>
                    </div>
                </header>
                <div class="refund-table-wrap">
                    <table class="refund-table refund-table--staff">
                        <thead>
                            <tr>
                                <th>{{ $t('Staff Member') }}</th>
                                <th class="text-end">{{ $t('Refund Value') }}</th>
                                <th class="text-center">{{ $t('Refund Count') }}</th>
                                <th class="text-end">{{ $t('Void Value') }}</th>
                                <th class="text-center">{{ $t('Void Count') }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="staff in byStaff" :key="staff.user_id">
                                <td><strong data-no-i18n>{{ staff.name }}</strong></td>
                                <td class="text-end tabular-nums" :class="staff.refund_value > 0 ? 'text-rose-700 font-bold' : 'text-muted-foreground'">{{ staff.refund_value > 0 ? formatMoney(staff.refund_value) : '-' }}</td>
                                <td class="text-center tabular-nums">{{ formatNumber(staff.refund_count) }}</td>
                                <td class="text-end tabular-nums">{{ staff.void_value > 0 ? formatMoney(staff.void_value) : '-' }}</td>
                                <td class="text-center tabular-nums">{{ formatNumber(staff.void_count) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <section v-if="topReasons.length" class="report-section refund-reasons">
                <header class="report-section__header">
                    <h2 class="report-section__title">{{ $t('Top Reasons') }}</h2>
                </header>
                <ol>
                    <li v-for="(reason, index) in topReasons" :key="reason.reason">
                        <span class="refund-reasons__index tabular-nums">0{{ index + 1 }}</span>
                        <div><strong>{{ $t(reason.reason) }}</strong><small>{{ formatNumber(reason.count) }} {{ $t('events') }}</small></div>
                        <span class="tabular-nums">{{ formatMoney(reason.value) }}</span>
                    </li>
                </ol>
            </section>
        </div>

        <section class="report-section refund-log">
            <header class="report-section__header refund-log__heading">
                <div>
                    <h2 class="report-section__title">{{ $t('Refund & Void Events') }}</h2>
                    <span class="report-section__hint">{{ $t('Select an event to inspect returned items') }}</span>
                </div>
                <span>{{ formatNumber(totalCount) }} {{ $t('events') }}</span>
            </header>

            <div class="refund-filters">
                <label class="refund-search">
                    <span class="sr-only">{{ $t('Search by table, invoice number, or reason') }}</span>
                    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                    <input v-model="searchQuery" type="search" :placeholder="$t('Search by table, invoice number, or reason')" />
                </label>
                <label>
                    <span class="sr-only">{{ $t('All Kinds') }}</span>
                    <select v-model="filterKind">
                        <option value="">{{ $t('All Kinds') }}</option>
                        <option value="refund">{{ $t('Refund') }}</option>
                        <option value="void">{{ $t('Void') }}</option>
                    </select>
                </label>
                <label>
                    <span class="sr-only">{{ $t('All Methods') }}</span>
                    <select v-model="filterMethod">
                        <option value="">{{ $t('All Methods') }}</option>
                        <option value="cash">{{ $t('Cash') }}</option>
                        <option value="card">{{ $t('Card') }}</option>
                        <option value="split">{{ $t('Split') }}</option>
                    </select>
                </label>
            </div>

            <div class="refund-table-wrap refund-log__table-wrap">
                <div v-if="loading && logRows.length" class="refund-log__loading" :aria-label="$t('Refreshing report')">
                    <i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>
                </div>
                <table class="refund-table refund-table--log">
                    <thead>
                        <tr>
                            <th>{{ $t('Occurred At') }}</th>
                            <th>{{ $t('Reference') }}</th>
                            <th class="text-center">{{ $t('Kind') }}</th>
                            <th>{{ $t('Method') }}</th>
                            <th class="text-end">{{ $t('Value') }}</th>
                            <th>{{ $t('Cashier') }}</th>
                            <th>{{ $t('Reason') }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-if="logRows.length === 0">
                            <td colspan="7" class="refund-table__empty">{{ $t('No events match the selected filters.') }}</td>
                        </tr>
                        <template v-for="row in logRows" :key="row.refund_id">
                            <tr class="refund-event-row" @click="toggleRow(row.refund_id)"
                                @keydown.enter.prevent="toggleRow(row.refund_id)"
                                @keydown.space.prevent="toggleRow(row.refund_id)"
                                tabindex="0" role="button" :aria-expanded="expandedRefundId === row.refund_id">
                                <td class="tabular-nums" data-no-i18n>{{ row.occurred_at_local }}</td>
                                <td>
                                    <span class="refund-order-number">
                                        <i class="fa-solid" :class="expandedRefundId === row.refund_id ? 'fa-chevron-down' : (isRtl ? 'fa-chevron-left' : 'fa-chevron-right')"></i>
                                        <strong data-no-i18n>{{ eventIdentity(row) }}</strong>
                                    </span>
                                </td>
                                <td class="text-center"><span class="refund-kind" :class="`refund-kind--${row.kind}`">{{ $t(row.kind) }}</span></td>
                                <td>{{ row.refund_method ? $t(row.refund_method) : '-' }}</td>
                                <td class="text-end font-bold tabular-nums" :class="row.kind === 'refund' ? 'text-rose-700' : 'text-zinc-700'">
                                    {{ row.kind === 'refund' ? '-' : '' }}{{ formatMoney(row.event_value) }}
                                </td>
                                <td data-no-i18n>{{ row.cashier_name }}</td>
                                <td><span class="refund-reason" :title="$t(row.reason || '-')">{{ $t(row.reason || '-') }}</span></td>
                            </tr>

                            <tr v-if="expandedRefundId === row.refund_id" class="refund-details-row">
                                <td colspan="7">
                                    <div class="refund-details">
                                        <div class="refund-details__header">
                                            <div>
                                                <h3>{{ $t(row.kind === 'void' ? 'Items' : 'Returned Items') }}</h3>
                                                <p>{{ $t('Method') }}: <strong>{{ row.refund_method ? $t(row.refund_method) : '-' }}</strong></p>
                                            </div>
                                            <router-link v-if="row.invoice_id" :to="{ name: 'orders', query: { invoice: row.invoice_display_no || undefined, open_invoice_id: row.invoice_id } }">
                                                <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>
                                                <span>{{ $t('Open original order') }}</span>
                                            </router-link>
                                        </div>

                                        <div v-if="isRowDetailsLoading(row.refund_id)" class="refund-details__state">
                                            <i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i>
                                            <span>{{ $t('Loading item details...') }}</span>
                                        </div>
                                        <div v-else-if="getRowDetailsError(row.refund_id)" class="refund-details__state refund-details__state--error">
                                            <span>{{ $t(getRowDetailsError(row.refund_id)) }}</span>
                                            <button type="button" @click.stop="retryRowDetails(row.refund_id)">{{ $t('Retry') }}</button>
                                        </div>
                                        <div v-else-if="!getRowItems(row.refund_id).length" class="refund-details__state">
                                            {{ $t('Whole-order cancellation (no item-level logs).') }}
                                        </div>
                                        <div v-else class="refund-items">
                                            <div v-for="item in getRowItems(row.refund_id)" :key="item.order_item_id">
                                                <div>
                                                    <strong data-no-i18n>{{ item.item_name }}</strong>
                                                    <small class="tabular-nums">{{ $t('Unit price') }}: {{ formatMoney(item.unit_price) }}</small>
                                                </div>
                                                <span class="tabular-nums">× {{ formatNumber(item.quantity) }}</span>
                                                <strong class="tabular-nums">{{ formatMoney(item.line_total) }}</strong>
                                            </div>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        </template>
                    </tbody>
                </table>
            </div>

            <footer v-if="totalPages > 1" class="refund-pagination">
                <span>
                    {{ $t('Showing') }} {{ formatNumber((currentPage - 1) * limit + 1) }} {{ $t('to') }}
                    {{ formatNumber(Math.min(currentPage * limit, totalCount)) }} {{ $t('of') }}
                    {{ formatNumber(totalCount) }} {{ $t('events') }}
                </span>
                <div>
                    <button @click="prevPage" :disabled="currentPage <= 1">{{ $t('Previous') }}</button>
                    <span class="tabular-nums">{{ formatNumber(currentPage) }} / {{ formatNumber(totalPages) }}</span>
                    <button @click="nextPage" :disabled="currentPage >= totalPages">{{ $t('Next') }}</button>
                </div>
            </footer>
        </section>
    </div>
</template>

<script>
import { fetchJsonResponse } from '@/shared/http.js';
import { inject, ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { buildDailyRefundPrintPayload } from './dailyReportPayloads.js';
import { currentLanguage, t } from '@/shared/i18n.js';
import { formatReportMoney, formatReportNumber, formatReportPercent } from '../utils/reportFormatting.js';

export default {
    name: 'ReportsRefunds',
    setup() {
        const period = inject('dailyReportPeriod');
        const registerDailyReportPrint = inject('registerDailyReportPrint');
        const isRtl = computed(() => currentLanguage.value === 'ar');
        const eventIdentity = (row) => {
            if (row.kind === 'void' && row.table_number !== null && row.table_number !== undefined && row.table_number !== '') {
                return t('Table {table}').replace('{table}', String(row.table_number));
            }
            return `#${row.invoice_display_no || row.invoice_id || '-'}`;
        };

        const summary = ref({
            sales_processed: 0,
            refund_total: 0,
            refund_rate: 0,
            refund_cash: 0,
            refund_card: 0,
            refund_count: 0,
            void_count: 0,
            void_value: 0
        });
        const byStaff = ref([]);
        const topReasons = ref([]);
        const logRows = ref([]);
        const totalCount = ref(0);
        const currentPage = ref(1);
        const totalPages = ref(1);
        const limit = ref(50);
        const loading = ref(false);
        const hasLoaded = ref(false);
        const error = ref(null);
        const filterKind = ref('');
        const filterMethod = ref('');
        const searchQuery = ref('');

        let reportController = null;
        let reportRequestId = 0;
        const fetchRefundReport = async () => {
            reportController?.abort();
            reportController = new AbortController();
            const requestId = ++reportRequestId;
            loading.value = true;
            error.value = null;
            try {
                const params = new URLSearchParams({
                    start_date: period.startDate.value,
                    end_date: period.endDate.value,
                    page: String(currentPage.value),
                    limit: String(limit.value)
                });
                if (filterKind.value) params.set('kind', filterKind.value);
                if (filterMethod.value) params.set('method', filterMethod.value);
                if (searchQuery.value.trim()) params.set('q', searchQuery.value.trim());

                const { response, data: responseData } = await fetchJsonResponse(`api/admin/reports/refunds?${params.toString()}`, { signal: reportController.signal });
                if (requestId !== reportRequestId) return;
                if (response.ok && responseData.success) {
                    summary.value = responseData.summary;
                    byStaff.value = responseData.by_staff || [];
                    topReasons.value = responseData.top_reasons || [];
                    logRows.value = responseData.log?.rows || [];
                    totalCount.value = responseData.log?.pagination?.total || 0;
                    totalPages.value = responseData.log?.pagination?.total_pages || 1;
                } else {
                    throw new Error(responseData.message || 'Failed to fetch refunds report');
                }
            } catch (requestError) {
                if (requestError.name !== 'AbortError' && requestId === reportRequestId) {
                    error.value = requestError.message || 'Network error';
                }
            } finally {
                if (requestId === reportRequestId) {
                    loading.value = false;
                    hasLoaded.value = true;
                }
            }
        };

        const expandedRefundId = ref(null);
        const itemsCache = ref(new Map());
        const detailsState = ref(new Map());
        const detailControllers = new Map();
        const updateDetailsState = (refundId, state) => {
            const next = new Map(detailsState.value);
            next.set(refundId, state);
            detailsState.value = next;
        };
        const loadRowDetails = async (refundId) => {
            detailControllers.get(refundId)?.abort();
            const controller = new AbortController();
            detailControllers.set(refundId, controller);
            updateDetailsState(refundId, { loading: true, error: null });
            try {
                const { response, data: responseData } = await fetchJsonResponse(`api/admin/reports/refunds/${refundId}/items`, { signal: controller.signal });
                if (!response.ok || !responseData.success || !Array.isArray(responseData.items)) {
                    throw new Error(responseData.message || 'Failed to load item details.');
                }
                const nextCache = new Map(itemsCache.value);
                nextCache.set(refundId, responseData.items);
                itemsCache.value = nextCache;
                updateDetailsState(refundId, { loading: false, error: null });
            } catch (requestError) {
                if (requestError.name !== 'AbortError') {
                    updateDetailsState(refundId, { loading: false, error: requestError.message || 'Failed to load item details.' });
                }
            } finally {
                if (detailControllers.get(refundId) === controller) detailControllers.delete(refundId);
            }
        };
        const toggleRow = async (refundId) => {
            if (expandedRefundId.value === refundId) {
                expandedRefundId.value = null;
                return;
            }
            expandedRefundId.value = refundId;
            if (!itemsCache.value.has(refundId)) await loadRowDetails(refundId);
        };
        const getRowItems = (refundId) => itemsCache.value.get(refundId) || [];
        const isRowDetailsLoading = (refundId) => detailsState.value.get(refundId)?.loading === true;
        const getRowDetailsError = (refundId) => detailsState.value.get(refundId)?.error || '';
        const retryRowDetails = (refundId) => loadRowDetails(refundId);

        const registerProvider = () => {
            if (registerDailyReportPrint) {
                registerDailyReportPrint(async () => {
                    const params = new URLSearchParams({
                        start_date: period.startDate.value,
                        end_date: period.endDate.value
                    });
                    const { response, data: responseData } = await fetchJsonResponse(`api/admin/reports/refunds/print-data?${params.toString()}`);
                    if (!response.ok || !responseData.success) {
                        throw new Error(responseData.message || 'Failed to prepare the refund report.');
                    }
                    return buildDailyRefundPrintPayload(responseData);
                });
            }
        };

        onMounted(() => {
            fetchRefundReport();
            registerProvider();
        });
        watch([period.startDate, period.endDate], () => {
            currentPage.value = 1;
            fetchRefundReport();
            registerProvider();
        });
        watch([filterKind, filterMethod], () => {
            currentPage.value = 1;
            fetchRefundReport();
        });

        let debounceTimer = null;
        watch(searchQuery, () => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                currentPage.value = 1;
                fetchRefundReport();
            }, 300);
        });
        onUnmounted(() => {
            reportController?.abort();
            for (const controller of detailControllers.values()) controller.abort();
            if (debounceTimer) clearTimeout(debounceTimer);
            registerDailyReportPrint?.(null);
        });

        const nextPage = () => {
            if (currentPage.value < totalPages.value) {
                currentPage.value++;
                fetchRefundReport();
            }
        };
        const prevPage = () => {
            if (currentPage.value > 1) {
                currentPage.value--;
                fetchRefundReport();
            }
        };

        return {
            period,
            summary,
            byStaff,
            topReasons,
            logRows,
            totalCount,
            currentPage,
            totalPages,
            limit,
            loading,
            hasLoaded,
            error,
            filterKind,
            filterMethod,
            searchQuery,
            expandedRefundId,
            detailsState,
            fetchRefundReport,
            toggleRow,
            getRowItems,
            isRowDetailsLoading,
            getRowDetailsError,
            retryRowDetails,
            formatMoney: formatReportMoney,
            formatNumber: formatReportNumber,
            formatPercent: formatReportPercent,
            nextPage,
            prevPage,
            isRtl,
            eventIdentity
        };
    }
};
</script>

<style scoped>
.refund-spotlight {
    display: grid;
    grid-template-columns: minmax(18rem, 1.45fr) repeat(3, minmax(11rem, 0.75fr));
    overflow: hidden;
    border: 1px solid #d4d4d8;
    border-radius: 12px;
    background: #fff;
}

.refund-spotlight > div {
    display: flex;
    min-height: 8.6rem;
    flex-direction: column;
    justify-content: center;
    padding: 1.25rem;
}

.refund-spotlight > div + div {
    border-inline-start: 1px solid #e4e4e7;
}

.refund-spotlight__primary {
    background: #fff7f7;
}

.refund-spotlight strong {
    margin-top: 0.5rem;
    color: #27272a;
    font-size: 1.25rem;
    font-weight: 750;
}

.refund-spotlight__primary strong {
    color: #9f1239;
    font-size: clamp(2.1rem, 4vw, 3.45rem);
    letter-spacing: -0.045em;
}

:global(html[dir="rtl"]) .refund-spotlight__primary strong {
    letter-spacing: 0;
}

.refund-spotlight small {
    margin-top: 0.45rem;
    color: #71717a;
    font-size: 0.66rem;
    line-height: 1.4;
}

.refund-method-strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    overflow: hidden;
    border: 1px solid #e4e4e7;
    border-radius: 10px;
    background: #fafafa;
}

.refund-method-strip > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    min-height: 3.4rem;
    padding: 0.7rem 1rem;
}

.refund-method-strip > div + div {
    border-inline-start: 1px solid #e4e4e7;
}

.refund-method-strip span {
    color: #71717a;
    font-size: 0.68rem;
}

.refund-method-strip strong {
    color: #3f3f46;
    font-size: 0.74rem;
    font-variant-numeric: tabular-nums;
}

.refund-insights-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(16rem, 0.5fr);
    align-items: start;
    gap: 1.25rem;
}

.refund-table-wrap {
    overflow-x: auto;
}

.refund-table {
    width: 100%;
    border-collapse: collapse;
    color: #3f3f46;
    font-size: 0.71rem;
    text-align: start;
}

.refund-table--staff {
    min-width: 42rem;
}

.refund-table--log {
    min-width: 64rem;
}

.refund-table th {
    padding: 0.7rem 0.85rem;
    color: #71717a;
    background: #fafafa;
    font-size: 0.63rem;
    font-weight: 750;
    text-align: start;
}

.refund-table td {
    padding: 0.75rem 0.85rem;
}

.refund-table tbody tr {
    border-top: 1px solid #f0f0f1;
}

.refund-table tbody tr:not(.refund-details-row):hover {
    background: #fafafa;
}

.refund-table__empty {
    height: 9rem;
    color: #71717a;
    text-align: center;
}

.refund-reasons ol {
    list-style: none;
}

.refund-reasons li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.85rem 1rem;
}

.refund-reasons li + li {
    border-top: 1px solid #f0f0f1;
}

.refund-reasons__index {
    color: #747481;
    font-family: var(--font-display);
    font-size: 0.62rem;
    font-weight: 700;
}

.refund-reasons strong,
.refund-reasons small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.refund-reasons strong {
    color: #3f3f46;
    font-size: 0.73rem;
}

.refund-reasons small {
    margin-top: 0.15rem;
    color: #747481;
    font-size: 0.62rem;
}

.refund-reasons li > span:last-child {
    color: #27272a;
    font-size: 0.72rem;
    font-weight: 750;
}

.refund-log__heading > span {
    color: #24405e;
    font-size: 0.68rem;
    font-weight: 750;
}

.refund-filters {
    display: grid;
    grid-template-columns: minmax(0, 1fr) repeat(2, minmax(8.5rem, 0.2fr));
    gap: 0.65rem;
    border-bottom: 1px solid #e4e4e7;
    padding: 0.75rem;
}

.refund-search {
    position: relative;
}

.refund-search i {
    position: absolute;
    inset-inline-start: 0.75rem;
    top: 50%;
    color: #747481;
    font-size: 0.68rem;
    transform: translateY(-50%);
}

.refund-filters input,
.refund-filters select {
    width: 100%;
    min-height: 2.35rem;
    border: 1px solid #d4d4d8;
    border-radius: 8px;
    color: #3f3f46;
    background: #fafafa;
    font-size: 0.72rem;
    outline: none;
}

.refund-filters input {
    padding-inline: 2.15rem 0.75rem;
}

.refund-filters select {
    padding-inline: 0.7rem;
}

.refund-filters input:focus,
.refund-filters select:focus {
    border-color: #3a5c85;
    box-shadow: 0 0 0 3px rgba(58, 92, 133, 0.12);
    background: #fff;
}

.refund-log__table-wrap {
    position: relative;
}

.refund-log__loading {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: grid;
    place-items: center;
    color: #24405e;
    background: rgba(255, 255, 255, 0.72);
}

.refund-event-row {
    cursor: pointer;
}

.refund-event-row:focus-visible {
    outline: 2px solid #3a5c85;
    outline-offset: -2px;
}

.refund-order-number {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
}

.refund-order-number i {
    width: 0.65rem;
    color: #747481;
    font-size: 0.56rem;
}

.refund-kind {
    display: inline-flex;
    border: 1px solid #d4d4d8;
    border-radius: 999px;
    padding: 0.22rem 0.5rem;
    color: #52525b;
    background: #f4f4f5;
    font-size: 0.6rem;
    font-weight: 750;
}

.refund-kind--refund {
    border-color: #fecdd3;
    color: #9f1239;
    background: #fff1f2;
}

.refund-reason {
    display: block;
    max-width: 11rem;
    overflow: hidden;
    color: #71717a;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.refund-details-row > td {
    padding: 0;
    background: #fafafa;
}

.refund-details {
    padding: 1rem 1.5rem 1.25rem;
}

.refund-details__header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.8rem;
}

.refund-details__header h3 {
    color: #27272a;
    font-size: 0.76rem;
    font-weight: 750;
}

.refund-details__header p {
    margin-top: 0.2rem;
    color: #71717a;
    font-size: 0.65rem;
}

.refund-details__header a {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: #24405e;
    font-size: 0.68rem;
    font-weight: 750;
}

.refund-details__header a:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
}

.refund-details__state {
    display: flex;
    min-height: 4rem;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border: 1px dashed #d4d4d8;
    border-radius: 8px;
    color: #71717a;
    font-size: 0.7rem;
    background: #fff;
}

.refund-details__state--error {
    border-color: #fecdd3;
    color: #9f1239;
    background: #fff1f2;
}

.refund-details__state button {
    font-weight: 750;
    text-decoration: underline;
    text-underline-offset: 3px;
}

.refund-items {
    overflow: hidden;
    border: 1px solid #e4e4e7;
    border-radius: 8px;
    background: #fff;
}

.refund-items > div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 1rem;
    padding: 0.7rem 0.85rem;
}

.refund-items > div + div {
    border-top: 1px solid #f0f0f1;
}

.refund-items strong,
.refund-items small {
    display: block;
}

.refund-items strong {
    color: #27272a;
    font-size: 0.7rem;
}

.refund-items small,
.refund-items span {
    margin-top: 0.15rem;
    color: #71717a;
    font-size: 0.64rem;
}

.refund-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border-top: 1px solid #e4e4e7;
    padding: 0.75rem 1rem;
    color: #71717a;
    background: #fafafa;
    font-size: 0.68rem;
}

.refund-pagination > div {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.refund-pagination button {
    min-height: 2rem;
    border: 1px solid #d4d4d8;
    border-radius: 8px;
    padding: 0.35rem 0.7rem;
    color: #3f3f46;
    background: #fff;
    font-weight: 700;
}

.refund-pagination button:hover:not(:disabled) {
    background: #f4f4f5;
}

.refund-pagination button:disabled {
    color: #747481;
    cursor: not-allowed;
}

/* Account for the fixed admin sidebar so every staff value remains visible on
   common 1280px laptops without asking the owner to scroll a small table. */
@media (max-width: 1380px) {
    .refund-spotlight {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .refund-spotlight__primary {
        grid-column: 1 / -1;
    }

    .refund-spotlight > div:nth-child(2) {
        border-inline-start: 0;
    }

    .refund-spotlight > div:not(:first-child) {
        border-top: 1px solid #e4e4e7;
    }

    .refund-insights-grid {
        grid-template-columns: 1fr;
    }
}

@media (max-width: 760px) {
    .refund-spotlight,
    .refund-method-strip,
    .refund-filters {
        grid-template-columns: 1fr;
    }

    .refund-spotlight__primary {
        grid-column: auto;
    }

    .refund-spotlight > div + div,
    .refund-method-strip > div + div {
        border-top: 1px solid #e4e4e7;
        border-inline-start: 0;
    }

    .refund-method-strip > div {
        min-height: 3rem;
    }

    .refund-details__header,
    .refund-pagination {
        align-items: start;
        flex-direction: column;
    }
}
</style>
