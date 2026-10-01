<template>
    <div v-if="loading && !data" class="report-state" aria-live="polite">
        <div>
            <div class="report-state__skeleton" aria-hidden="true"><span></span><span></span><span></span></div>
            <p>{{ $t('Loading report...') }}</p>
        </div>
    </div>

    <div v-else-if="error && !data" class="report-state">
        <div>
            <p class="font-semibold text-rose-700">{{ $t(error) }}</p>
            <button @click="reload" class="mt-4 rounded-lg bg-teal-700 px-4 py-2 text-xs font-bold text-white hover:bg-teal-800">
                {{ $t('Retry') }}
            </button>
        </div>
    </div>

    <div v-else-if="reportData" class="report-page">
        <div v-if="error" role="alert" class="report-error">
            <span>{{ $t(error) }}</span>
            <button @click="reload">{{ $t('Retry') }}</button>
        </div>

        <div class="summary-context">
            <div>
                <h2 class="font-display">{{ $t('Business Day Summary') }}</h2>
                <p class="tabular-nums" dir="ltr">{{ windowLabel }}</p>
            </div>
            <span v-if="isCurrentBusinessDay" class="summary-live-state">
                {{ $t('Current business day: In progress') }}
            </span>
        </div>

        <section class="report-section summary-sales-story" :aria-label="$t('Sales Story')">
            <header class="report-section__header summary-story__header">
                <div>
                    <h3 class="report-section__title">{{ $t('Sales Story') }}</h3>
                    <span class="report-section__hint">{{ $t('From completed sales to the amount remaining after expenses') }}</span>
                </div>
                <dl class="summary-story__quick-facts">
                    <div><dt>{{ $t('Orders') }}</dt><dd>{{ formatNumber(reportData.summary.total_orders) }}</dd></div>
                    <div><dt>{{ $t('Average Ticket') }}</dt><dd>{{ formatMoney(reportData.summary.average_ticket) }}</dd></div>
                </dl>
            </header>

            <div class="summary-story__layout">
                <ol class="summary-story__ledger">
                    <li class="summary-story__row summary-story__row--source">
                        <span class="summary-story__sign" aria-hidden="true">•</span>
                        <div class="summary-story__copy">
                            <strong>{{ $t('Total Sales') }}</strong>
                            <small>{{ $t('Completed invoices after discounts, including tax') }}</small>
                        </div>
                        <strong class="summary-story__value">{{ formatMoney(reportData.summary.sales_processed) }}</strong>
                    </li>

                    <li class="summary-story__row summary-story__row--deduction">
                        <span class="summary-story__sign" aria-hidden="true">−</span>
                        <div class="summary-story__copy">
                            <strong>{{ $t('Returns Deducted') }}</strong>
                            <small>
                                {{ formatNumber(reportData.summary.refund_count) }} {{ $t('Refund Events') }} ·
                                {{ formatNumber(reportData.summary.refund_order_count) }} {{ $t('Whole-order returns') }} ·
                                {{ formatNumber(reportData.summary.refund_item_count) }} {{ $t('Selected-item returns') }}
                            </small>
                            <router-link :to="{ name: 'reports-refunds' }">{{ $t('Open refund log') }}</router-link>
                        </div>
                        <strong class="summary-story__value">{{ formatDeduction(reportData.summary.refunds_issued) }}</strong>
                    </li>

                    <li class="summary-story__row summary-story__row--subtotal">
                        <span class="summary-story__sign" aria-hidden="true">=</span>
                        <div class="summary-story__copy">
                            <strong>{{ $t('Net Sales After Returns') }}</strong>
                            <small v-if="Number(reportData.summary.sales_collected) < 0" class="summary-negative">
                                {{ $t('Refunds exceeded sales processed in this period.') }}
                            </small>
                            <small v-else class="summary-comparison">
                                <span v-if="reportData.comparison?.sales_collected?.percent !== null"
                                      :class="reportData.comparison?.sales_collected?.amount >= 0 ? 'text-teal-700' : 'text-rose-700'">
                                    {{ reportData.comparison?.sales_collected?.percent >= 0 ? '+' : '' }}{{ formatPercent(reportData.comparison?.sales_collected?.percent) }}
                                </span>
                                {{ reportData.comparison?.sales_collected?.percent !== null ? $t('compared to same period last week') : $t('No comparable sales last week') }}
                            </small>
                        </div>
                        <strong class="summary-story__value">{{ formatMoney(reportData.summary.sales_collected) }}</strong>
                    </li>

                    <li class="summary-story__row summary-story__row--deduction">
                        <span class="summary-story__sign" aria-hidden="true">−</span>
                        <div class="summary-story__copy">
                            <strong>{{ $t('Recorded Expenses') }}</strong>
                            <small>
                                {{ formatNumber(reportData.summary.expense_count) }} {{ $t('expense entries') }} ·
                                {{ $t('Cash drawer') }} {{ formatMoney(reportData.summary.drawer_expenses_total) }} ·
                                {{ $t('Outside POS') }} {{ formatMoney(reportData.summary.outside_expenses_total) }}
                            </small>
                            <router-link :to="{ name: 'reports-expenses' }">{{ $t('View expenses') }}</router-link>
                        </div>
                        <strong class="summary-story__value">{{ formatDeduction(reportData.summary.expenses_total) }}</strong>
                    </li>

                    <li class="summary-story__row summary-story__row--final">
                        <span class="summary-story__sign" aria-hidden="true">=</span>
                        <div class="summary-story__copy">
                            <strong>{{ $t('Sales Remaining After Expenses') }}</strong>
                            <small>{{ $t('Operating remainder; this is not a profit figure') }}</small>
                        </div>
                        <strong class="summary-story__value">{{ formatMoney(reportData.summary.remaining_after_expenses) }}</strong>
                    </li>
                </ol>

                <aside class="summary-story__context" :aria-label="$t('Amounts already reflected in the sales story')">
                    <header>
                        <h4>{{ $t('Already Reflected Above') }}</h4>
                        <p>{{ $t('These amounts explain the result and must not be subtracted again') }}</p>
                    </header>
                    <dl>
                        <div>
                            <dt>{{ $t('Sales Before Tax') }}<small>{{ $t('Tax removed for reference') }}</small></dt>
                            <dd>{{ formatMoney(reportData.summary.net_revenue_pre_tax) }}</dd>
                        </div>
                        <div>
                            <dt>{{ $t('Tax Included') }}<small>{{ $t('Already included in total sales') }}</small></dt>
                            <dd>{{ formatMoney(reportData.summary.tax_collected) }}</dd>
                        </div>
                        <div>
                            <dt>
                                {{ $t('Discounts Given') }}
                                <small>{{ formatNumber(reportData.summary.discounted_orders) }} {{ $t('discounted orders') }} · {{ $t('Already included in total sales') }}</small>
                                <router-link :to="{ name: 'orders', query: { discounted: '1', start_date: period.startDate.value, end_date: period.endDate.value } }">
                                    {{ $t('View discounted orders') }}
                                </router-link>
                            </dt>
                            <dd>{{ formatMoney(reportData.summary.discounts_total) }}</dd>
                        </div>
                        <div>
                            <dt>
                                {{ $t('Voided Before Payment') }}
                                <small>
                                    {{ formatNumber(reportData.summary.void_order_count) }} {{ $t('Whole-order voids') }} ·
                                    {{ formatNumber(reportData.summary.void_item_count) }} {{ $t('Partial item voids') }} ·
                                    {{ $t('Not collected as sales') }}
                                </small>
                            </dt>
                            <dd>{{ formatMoney(reportData.summary.void_value) }}</dd>
                        </div>
                        <div v-if="reportData.summary.service_charges_collected > 0">
                            <dt>{{ $t('Service Charges Included') }}<small>{{ $t('Already included in total sales') }}</small></dt>
                            <dd>{{ formatMoney(reportData.summary.service_charges_collected) }}</dd>
                        </div>
                    </dl>
                </aside>
            </div>
        </section>


        <div class="summary-ledger-grid">
            <section class="report-section">
                <header class="report-section__header">
                    <h3 class="report-section__title">{{ $t('Sales and Collections by Payment Method') }}</h3>
                    <span class="report-section__hint">{{ $t('Cash, card and platform sales are shown separately') }}</span>
                </header>
                <dl class="summary-ledger">
                    <div v-for="pay in reportData.payments" :key="pay.key">
                        <dt>{{ pay.key === 'platform' ? $t('Platform Sales (not collected)') : $t(pay.key) }}</dt>
                        <dd>{{ formatMoney(pay.amount) }}</dd>
                    </div>
                </dl>
            </section>

            <section v-if="reportData.platform_reconciliation" class="report-section">
                <header class="report-section__header">
                    <h3 class="report-section__title">{{ $t('Platform Payouts') }}</h3>
                    <router-link :to="{ name: 'platform-remittances' }" class="summary-section-link">{{ $t('Open reconciliation') }}</router-link>
                </header>
                <dl class="summary-ledger">
                    <div><dt>{{ $t('Invoice Allocations') }}</dt><dd>{{ formatMoney(reportData.platform_reconciliation.invoice_allocations) }}</dd></div>
                    <div><dt>{{ $t('Provider Credits Applied') }}</dt><dd>{{ formatMoney(reportData.platform_reconciliation.provider_credits_applied) }}</dd></div>
                    <div><dt>{{ $t('Deductions') }}</dt><dd class="text-rose-700">{{ formatDeduction(reportData.platform_reconciliation.deductions) }}</dd></div>
                    <div><dt>{{ $t('Additions') }}</dt><dd>{{ formatMoney(reportData.platform_reconciliation.additions) }}</dd></div>
                    <div class="summary-ledger__total"><dt>{{ $t('Net Received') }}<small>{{ $t('Net of reversals') }}</small></dt><dd>{{ formatMoney(reportData.platform_reconciliation.net_received) }}</dd></div>
                    <div><dt>{{ $t('Settlement count') }} / {{ $t('Reversal count') }}</dt><dd class="tabular-nums">{{ reportData.platform_reconciliation.settlement_count || 0 }} / {{ reportData.platform_reconciliation.reversal_count || 0 }}</dd></div>
                </dl>
            </section>
        </div>

        <div class="summary-analysis-grid">
            <section class="report-section summary-hourly">
                <header class="report-section__header">
                    <h3 class="report-section__title">{{ $t('Hourly Sales Profile') }}</h3>
                    <span class="report-section__hint">{{ $t('Sales processed by hour. Refunds are shown separately.') }}</span>
                </header>
                <div class="summary-hourly__chart">
                    <div v-for="hour in reportData.hourly_sales" :key="hour.hour" class="summary-hourly__bar">
                        <div class="summary-hourly__track">
                            <span :style="{ height: getHourHeight(hour.sales_processed) }"></span>
                            <div class="summary-hourly__tooltip tabular-nums">
                                {{ formatMoney(hour.sales_processed) }} · {{ formatNumber(hour.orders) }} {{ $t('orders') }}
                            </div>
                        </div>
                        <small class="tabular-nums">{{ String(hour.hour).padStart(2, '0') }}</small>
                    </div>
                </div>
                <div class="sr-only">
                    <span>{{ $t('Hourly sales breakdown') }}:</span>
                    <span v-for="hour in reportData.hourly_sales" :key="`sr-${hour.hour}`">
                        {{ $t('Hour') }} {{ hour.hour }}: {{ formatMoney(hour.sales_processed) }}, {{ formatNumber(hour.orders) }} {{ $t('orders') }}.
                    </span>
                </div>
            </section>

            <section v-if="reportData.order_types?.length" class="report-section">
                <header class="report-section__header">
                    <h3 class="report-section__title">{{ $t('Sales by Order Type') }}</h3>
                </header>
                <dl class="summary-ledger summary-ledger--compact">
                    <div v-for="orderType in reportData.order_types" :key="orderType.order_type_id">
                        <dt>
                            <span data-no-i18n>{{ orderType.name }}</span>
                            <small>{{ formatNumber(orderType.orders) }} {{ $t('orders') }}</small>
                        </dt>
                        <dd>{{ formatMoney(orderType.net_sales) }}</dd>
                    </div>
                </dl>
            </section>
        </div>

        <section class="report-section">
            <header class="report-section__header">
                <h3 class="report-section__title">{{ $t('Cash Drawer Status') }}</h3>
                <router-link :to="{ name: 'shifts' }" class="summary-section-link">{{ $t('View Shifts') }}</router-link>
            </header>
            <div class="summary-cash">
                <div class="summary-cash__state">
                    <span :class="getCashStateClass(reportData.cash_status.state)">{{
                        reportData.cash_status.state === 'no_shifts' && reportData.cash_status.closed_outside_window > 0
                            ? $t('No shifts settled in this report window')
                            : $t(reportData.cash_status.state)
                    }}</span>
                    <p>
                        {{ formatNumber(reportData.cash_status.closed_shifts) }} {{ $t('closed shifts') }} ·
                        {{ formatNumber(reportData.cash_status.open_shifts) }} {{ $t('active open shifts') }} ·
                        {{ formatNumber(reportData.cash_status.uncounted_shifts) }} {{ $t('uncounted shifts') }}
                    </p>
                    <p v-if="reportData.cash_status.closed_outside_window > 0">
                        {{ $t('Shifts settled on another business day') }}:
                        <span class="tabular-nums" data-no-i18n>{{ formatNumber(reportData.cash_status.closed_outside_window) }}</span>
                    </p>
                </div>
                <dl v-if="reportData.cash_status.closed_shifts > 0 && reportData.cash_status.net_variance !== null && reportData.cash_status.net_variance !== undefined">
                    <div><dt>{{ $t('Shortage Total') }}</dt><dd>{{ formatMoney(reportData.cash_status.shortage_total) }}</dd></div>
                    <div><dt>{{ $t('Overage Total') }}</dt><dd>{{ formatMoney(reportData.cash_status.overage_total) }}</dd></div>
                    <div>
                        <dt>{{ $t('Net Shift Variance') }}</dt>
                        <dd :class="reportData.cash_status.net_variance === 0 ? 'text-teal-700' : 'text-rose-700'">
                            {{ reportData.cash_status.net_variance >= 0 ? '+' : '' }}{{ formatMoney(reportData.cash_status.net_variance) }}
                        </dd>
                    </div>
                </dl>
                <p v-else-if="reportData.cash_status.state === 'in_progress'">{{ $t('Reconciliation in progress') }}</p>
            </div>
        </section>
    </div>
</template>

<script>
import { inject, computed, watch, onMounted, onUnmounted } from 'vue';
import { useDailyReportPage } from '../composables/useDailyReportPage.js';
import { buildDailySummaryPrintPayload } from './dailyReportPayloads.js';
import { currentBusinessDate, businessDayWindowLabel } from '../../utils/businessDate.js';
import { formatReportMoney, formatReportNumber, formatReportPercent } from '../utils/reportFormatting.js';

export default {
    name: 'ReportsSummary',
    setup() {
        const period = inject('dailyReportPeriod');
        const registerDailyReportPrint = inject('registerDailyReportPrint');
        const { data, loading, error, reload } = useDailyReportPage('summary', period);
        const reportData = computed(() => data.value);

        const isCurrentBusinessDay = computed(() => {
            const today = currentBusinessDate();
            return period.startDate.value <= today && today <= period.endDate.value;
        });
        const windowLabel = computed(() => businessDayWindowLabel(period.startDate.value, period.endDate.value));

        const registerProvider = () => {
            if (registerDailyReportPrint) {
                registerDailyReportPrint(data.value ? async () => buildDailySummaryPrintPayload(data.value) : null);
            }
        };

        onMounted(registerProvider);
        watch(data, registerProvider);
        onUnmounted(() => registerDailyReportPrint?.(null));

        const getHourHeight = (value) => {
            if (!data.value?.hourly_sales?.length) return '0%';
            const maxValue = Math.max(...data.value.hourly_sales.map((hour) => Number(hour.sales_processed) || 0));
            if (maxValue <= 0) return '0%';
            return `${((Number(value) || 0) / maxValue) * 100}%`;
        };

        const getCashStateClass = (state) => {
            if (state === 'balanced') return 'summary-state summary-state--balanced';
            if (state === 'review') return 'summary-state summary-state--review';
            if (state === 'in_progress') return 'summary-state summary-state--progress';
            return 'summary-state';
        };
        const formatDeduction = (value) => {
            const amount = Number(value) || 0;
            return formatReportMoney(amount > 0 ? -amount : 0);
        };

        return {
            period,
            data,
            loading,
            error,
            reload,
            reportData,
            isCurrentBusinessDay,
            windowLabel,
            formatMoney: formatReportMoney,
            formatDeduction,
            formatNumber: formatReportNumber,
            formatPercent: formatReportPercent,
            getHourHeight,
            getCashStateClass
        };
    }
};
</script>

<style scoped>
.summary-context {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 1rem;
}

.summary-context h2 {
    color: #27272a;
    font-size: 1.1rem;
    font-weight: 700;
    letter-spacing: -0.02em;
}

.summary-context p {
    margin-top: 0.3rem;
    color: #71717a;
    font-size: 0.72rem;
    unicode-bidi: isolate;
}

.summary-live-state,
.summary-state {
    display: inline-flex;
    width: fit-content;
    border: 1px solid #fde68a;
    border-radius: 999px;
    padding: 0.3rem 0.6rem;
    color: #92400e;
    background: #fffbeb;
    font-size: 0.68rem;
    font-weight: 750;
}

.summary-sales-story {
    overflow: hidden;
    border-color: #cbd5e1;
}

.summary-story__header {
    align-items: center;
    border-bottom: 1px solid #e2e8f0;
    background: #f8fafc;
}

.summary-story__quick-facts {
    display: flex;
    gap: 1.5rem;
}

.summary-story__quick-facts div {
    min-width: 6rem;
}

.summary-story__quick-facts dt {
    color: #64748b;
    font-size: 0.65rem;
    font-weight: 700;
}

.summary-story__quick-facts dd {
    margin-top: 0.2rem;
    color: #1e293b;
    font-family: var(--font-display);
    font-size: 1rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
}

.summary-story__layout {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(19rem, 0.65fr);
}

.summary-story__ledger {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
}

.summary-story__row {
    display: grid;
    grid-template-columns: 2.3rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.85rem;
    min-height: 5rem;
    padding: 0.9rem 1.25rem;
}

.summary-story__row + .summary-story__row {
    border-top: 1px solid #eef2f7;
}

.summary-story__sign {
    display: grid;
    width: 1.8rem;
    height: 1.8rem;
    place-items: center;
    border: 1px solid #cbd5e1;
    border-radius: 999px;
    color: #475569;
    background: #fff;
    font-size: 0.95rem;
    font-weight: 800;
}

.summary-story__copy {
    min-width: 0;
}

.summary-story__copy > strong,
.summary-story__copy small,
.summary-story__copy a {
    display: block;
}

.summary-story__copy > strong {
    color: #334155;
    font-size: 0.82rem;
    font-weight: 800;
}

.summary-story__copy small {
    margin-top: 0.25rem;
    color: #64748b;
    font-size: 0.66rem;
    line-height: 1.5;
}

.summary-story__copy a,
.summary-story__context a {
    display: block;
    width: fit-content;
    margin-top: 0.3rem;
    color: #24405e;
    font-size: 0.66rem;
    font-weight: 750;
}

.summary-story__copy a:hover,
.summary-story__context a:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
}

.summary-story__value {
    color: #1e293b;
    font-family: var(--font-display);
    font-size: 1rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    unicode-bidi: isolate;
}

.summary-story__row--deduction .summary-story__value {
    color: #be123c;
}

.summary-story__row--subtotal {
    background: #f8fafc;
}

.summary-story__row--subtotal .summary-story__sign {
    border-color: #9eb0c7;
    color: #1d3450;
    background: #eef2f7;
}

.summary-story__row--final {
    background: #1d3450;
}

.summary-story__row--final .summary-story__sign {
    border-color: rgba(255, 255, 255, 0.35);
    color: #fff;
    background: rgba(255, 255, 255, 0.08);
}

.summary-story__row--final .summary-story__copy > strong,
.summary-story__row--final .summary-story__copy small,
.summary-story__row--final .summary-story__value {
    color: #fff;
}

.summary-story__row--final .summary-story__copy small {
    opacity: 0.78;
}

.summary-story__context {
    border-inline-start: 1px solid #e2e8f0;
    background: #fcfcfd;
}

.summary-story__context > header {
    border-bottom: 1px solid #eef2f7;
    padding: 1rem 1.1rem;
}

.summary-story__context h4 {
    color: #334155;
    font-size: 0.76rem;
    font-weight: 800;
}

.summary-story__context header p {
    margin-top: 0.25rem;
    color: #64748b;
    font-size: 0.64rem;
    line-height: 1.45;
}

.summary-story__context dl > div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.75rem;
    padding: 0.85rem 1.1rem;
}

.summary-story__context dl > div + div {
    border-top: 1px solid #eef2f7;
}

.summary-story__context dt {
    color: #475569;
    font-size: 0.72rem;
    font-weight: 750;
}

.summary-story__context dt small {
    display: block;
    margin-top: 0.2rem;
    color: #64748b;
    font-size: 0.61rem;
    font-weight: 600;
    line-height: 1.45;
}

.summary-story__context dd {
    color: #334155;
    font-size: 0.78rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    unicode-bidi: isolate;
}

.summary-comparison,
.summary-negative {
    color: #71717a;
    font-size: 0.74rem;
}

.summary-comparison span {
    margin-inline-end: 0.35rem;
    font-weight: 800;
}

.summary-negative {
    color: #be123c;
    font-weight: 700;
}

.summary-ledger-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
    gap: 1.25rem;
}

.summary-analysis-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(18rem, 0.55fr);
    gap: 1.25rem;
}

.summary-ledger {
    display: grid;
}

.summary-ledger > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: 3.2rem;
    padding: 0.75rem 1rem;
}

.summary-ledger > div + div {
    border-top: 1px solid #f0f0f1;
}

.summary-ledger dt {
    color: #71717a;
    font-size: 0.78rem;
}

.summary-ledger dt small {
    display: block;
    margin-top: 0.15rem;
    color: #747481;
    font-size: 0.66rem;
}

.summary-ledger dd {
    color: #27272a;
    font-size: 0.82rem;
    font-weight: 750;
    font-variant-numeric: tabular-nums;
}

.summary-ledger__total {
    background: #eef2f7;
}

.summary-ledger__total dt,
.summary-ledger__total dd {
    color: #1d3450;
    font-weight: 800;
}

.summary-hourly__chart {
    display: flex;
    height: 11rem;
    align-items: end;
    gap: 0.35rem;
    overflow-x: auto;
    padding: 1.25rem 1rem 1rem;
}

.summary-hourly__bar {
    display: flex;
    min-width: 1.65rem;
    flex: 1;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
}

.summary-hourly__track {
    position: relative;
    display: flex;
    width: 100%;
    height: 8rem;
    align-items: end;
    border-bottom: 1px solid #e4e4e7;
}

.summary-hourly__track > span {
    width: 100%;
    min-height: 2px;
    border-radius: 4px 4px 0 0;
    background: #24405e;
    opacity: 0.78;
    transition: opacity 160ms ease;
}

.summary-hourly__track:hover > span {
    opacity: 1;
}

.summary-hourly__tooltip {
    position: absolute;
    inset-inline-start: 50%;
    bottom: calc(100% + 0.4rem);
    z-index: 2;
    display: none;
    width: max-content;
    transform: translateX(-50%);
    border-radius: 6px;
    padding: 0.3rem 0.45rem;
    color: #fff;
    background: #27272a;
    font-size: 0.62rem;
}

.summary-hourly__track:hover .summary-hourly__tooltip {
    display: block;
}

.summary-hourly__bar small {
    color: #747481;
    font-size: 0.58rem;
}

.summary-section-link {
    color: #24405e;
    font-size: 0.7rem;
    font-weight: 700;
}

.summary-section-link:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
}

.summary-cash {
    padding: 1rem;
}

.summary-cash__state {
    display: flex;
    align-items: center;
    gap: 0.65rem;
}

.summary-cash__state p {
    color: #71717a;
    font-size: 0.7rem;
}

.summary-state--balanced {
    border-color: #bcc9dc;
    color: #1d3450;
    background: #eef2f7;
}

.summary-state--review {
    border-color: #fecdd3;
    color: #9f1239;
    background: #fff1f2;
}

.summary-state--progress {
    border-color: #fde68a;
    color: #92400e;
    background: #fffbeb;
}

.summary-cash dl {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
    margin-top: 1rem;
    border-top: 1px solid #e4e4e7;
    padding-top: 1rem;
}

.summary-cash dt {
    color: #71717a;
    font-size: 0.67rem;
}

.summary-cash dd {
    margin-top: 0.25rem;
    color: #27272a;
    font-size: 0.82rem;
    font-weight: 750;
    font-variant-numeric: tabular-nums;
}

@media (max-width: 1050px) {
    .summary-analysis-grid,
    .summary-ledger-grid {
        grid-template-columns: 1fr;
    }

    .summary-story__layout {
        grid-template-columns: 1fr;
    }

    .summary-story__context {
        border-top: 1px solid #e2e8f0;
        border-inline-start: 0;
    }
}

@media (max-width: 680px) {
    .summary-context {
        align-items: start;
        flex-direction: column;
    }

    .summary-story__header {
        align-items: start;
        flex-direction: column;
    }

    .summary-story__quick-facts {
        width: 100%;
    }

    .summary-story__quick-facts div {
        min-width: 0;
        flex: 1;
    }

    .summary-story__row {
        grid-template-columns: 2rem minmax(0, 1fr);
        gap: 0.65rem;
        padding: 0.85rem 0.9rem;
    }

    .summary-story__value {
        grid-column: 2;
        font-size: 0.92rem;
    }

    .summary-cash dl {
        grid-template-columns: 1fr;
    }

}

@media (prefers-reduced-motion: reduce) {
    .summary-hourly__track > span {
        transition: none;
    }
}
</style>
