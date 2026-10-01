<template>
    <div class="daily-reports-workspace text-foreground font-sans">
        <header class="report-command print:hidden">
            <div class="report-command__identity">
                <p class="report-command__kicker">{{ $t('Daily operating report') }}</p>
                <h1 class="report-command__title font-display">{{ $t(activeReport.label) }}</h1>
                <p class="report-command__description">{{ $t(activeReport.description) }}</p>
            </div>

            <div class="report-command__controls">
                <div class="report-period" aria-live="polite">
                    <span class="report-period__label">{{ $t('Business day') }}</span>
                    <strong class="report-period__value tabular-nums" dir="ltr">{{ selectedWindowLabel }}</strong>
                    <span v-if="startDate !== endDate" class="report-period__count">
                        {{ selectedDayCount }} {{ $t('days') }}
                    </span>
                </div>

                <div class="report-actions">
                    <div class="report-day-nav" role="group" :aria-label="$t('Business day navigation')">
                        <button type="button" @click="moveDay(-1)" :aria-label="$t('Previous business day')">
                            <i :class="['fa-solid', isRtl ? 'fa-chevron-right' : 'fa-chevron-left']"></i>
                            <span>{{ $t('Previous') }}</span>
                        </button>
                        <button type="button" @click="selectToday" :disabled="isToday">
                            {{ $t('Today') }}
                        </button>
                        <button type="button" @click="moveDay(1)" :disabled="!canMoveNext" :aria-label="$t('Next business day')">
                            <span>{{ $t('Next') }}</span>
                            <i :class="['fa-solid', isRtl ? 'fa-chevron-left' : 'fa-chevron-right']"></i>
                        </button>
                    </div>

                    <button type="button" @click="toggleCustomPeriod" :aria-expanded="customPeriodOpen"
                            class="report-action-button report-action-button--secondary">
                        <i class="fa-regular fa-calendar"></i>
                        <span>{{ $t('Custom period') }}</span>
                    </button>

                    <ReportPrintMenu v-if="!['reports-ingredients', 'reports-product-profit'].includes(activePage)"
                        :label="$t('Print')"
                        :disabled="!reportSupported"
                        :busy="isPrinting"
                        variant="report-action-button--primary"
                        @select="printReportLayout"
                    />
                </div>
            </div>
        </header>

        <transition name="period-panel">
            <form v-if="customPeriodOpen" @submit.prevent="applyCustomPeriod" class="report-period-panel print:hidden">
                <div>
                    <h2>{{ $t('Choose a report period') }}</h2>
                    <p>{{ $t('Use business dates. The current business day is selected by default.') }}</p>
                </div>
                <label>
                    <span>{{ $t('Start') }}</span>
                    <input v-model="draftStartDate" :max="today" type="date" />
                </label>
                <label>
                    <span>{{ $t('End') }}</span>
                    <input v-model="draftEndDate" :min="draftStartDate" :max="today" type="date" />
                </label>
                <button type="submit">{{ $t('Apply period') }}</button>
                <p v-if="periodError" role="alert" class="report-period-panel__error">{{ $t(periodError) }}</p>
            </form>
        </transition>


        <main class="report-sheet">
            <router-view v-slot="{ Component, route: childRoute }">
                <transition name="reports-page">
                    <component :is="Component" :key="childRoute.name" />
                </transition>
            </router-view>
        </main>
    </div>
</template>

<script>
import { currentLanguage } from '@/shared/i18n.js';
import { useRoute } from 'vue-router';
import { ref, computed, provide, onMounted, onScopeDispose } from 'vue';
import { addBusinessDateDays, businessDayWindowLabel, currentBusinessDate, parseScheduledTimestamp, getBusinessDayStartHour } from '../../utils/businessDate.js';
import { useBrowserReportPrint } from '../composables/useBrowserReportPrint.js';
import { reportPages } from '../reportPages.js';
import ReportPrintMenu from './ReportPrintMenu.vue';

const MAX_PERIOD_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
    if (!DATE_ONLY.test(String(value || ''))) return false;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function daySpan(start, end) {
    return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

export default {
    components: { ReportPrintMenu },
    setup() {
        const route = useRoute();
        const activePage = computed(() => route.name);
        const activeReport = computed(() => reportPages.find((tab) => tab.value === activePage.value) || reportPages[0]);
        const isRtl = computed(() => currentLanguage.value === 'ar');

        const today = ref(currentBusinessDate());

        const storedStart = sessionStorage.getItem('pos_reports_start_date');
        const storedEnd = sessionStorage.getItem('pos_reports_end_date');
        const storedIsValid = validDate(storedStart) && validDate(storedEnd) &&
            storedStart <= storedEnd && storedEnd <= today.value && daySpan(storedStart, storedEnd) <= MAX_PERIOD_DAYS;
        const startDate = ref(storedIsValid ? storedStart : today.value);
        const endDate = ref(storedIsValid ? storedEnd : today.value);
        const draftStartDate = ref(startDate.value);
        const draftEndDate = ref(endDate.value);
        const customPeriodOpen = ref(false);
        const periodError = ref('');

        const persistPeriod = (start, end) => {
            startDate.value = start;
            endDate.value = end;
            sessionStorage.setItem('pos_reports_start_date', start);
            sessionStorage.setItem('pos_reports_end_date', end);
            draftStartDate.value = start;
            draftEndDate.value = end;
            periodError.value = '';
        };
        const moveDay = (direction) => {
            const anchor = direction < 0 ? startDate.value : endDate.value;
            const target = addBusinessDateDays(anchor, direction);
            if (target > today.value) return;
            persistPeriod(target, target);
        };
        const selectToday = () => persistPeriod(today.value, today.value);
        const toggleCustomPeriod = () => {
            customPeriodOpen.value = !customPeriodOpen.value;
            periodError.value = '';
        };
        const applyCustomPeriod = () => {
            const start = draftStartDate.value;
            const end = draftEndDate.value;
            if (!validDate(start) || !validDate(end)) periodError.value = 'Choose valid start and end dates.';
            else if (end < start) periodError.value = 'End date must not be before start date.';
            else if (end > today.value) periodError.value = 'Reports cannot include a future business day.';
            else if (daySpan(start, end) > MAX_PERIOD_DAYS) periodError.value = 'Report range cannot exceed 366 days.';
            else {
                persistPeriod(start, end);
                customPeriodOpen.value = false;
            }
        };

        let rolloverTimer;
        const refreshBusinessDate = () => {
            clearTimeout(rolloverTimer);
            const previous = today.value;
            today.value = currentBusinessDate();
            if (previous !== today.value && !customPeriodOpen.value && startDate.value === previous && endDate.value === previous) {
                persistPeriod(today.value, today.value);
            }
            const next = parseScheduledTimestamp(`${addBusinessDateDays(today.value, 1)}T${String(getBusinessDayStartHour()).padStart(2, '0')}:00`);
            rolloverTimer = setTimeout(refreshBusinessDate, Math.max(1000, next.getTime() - Date.now()));
        };
        onMounted(() => {
            refreshBusinessDate();
            globalThis.window?.addEventListener('focus', refreshBusinessDate);
        });
        onScopeDispose(() => {
            clearTimeout(rolloverTimer);
            globalThis.window?.removeEventListener('focus', refreshBusinessDate);
        });

        provide('dailyReportPeriod', { startDate, endDate, setPeriod: persistPeriod });
        const printProvider = ref(null);
        const registerDailyReportPrint = (provider) => { printProvider.value = provider; };
        provide('registerDailyReportPrint', registerDailyReportPrint);
        const reportSupported = computed(() => Boolean(printProvider.value));
        const { printReport, isPrinting } = useBrowserReportPrint();
        const printReportLayout = (layout) => printProvider.value
            ? printReport(layout, printProvider.value)
            : false;

        return {
            activeReport,
            activePage,
            isRtl,
            today,
            startDate,
            endDate,
            draftStartDate,
            draftEndDate,
            customPeriodOpen,
            periodError,
            selectedWindowLabel: computed(() => businessDayWindowLabel(startDate.value, endDate.value)),
            selectedDayCount: computed(() => daySpan(startDate.value, endDate.value)),
            isToday: computed(() => startDate.value === today.value && endDate.value === today.value),
            canMoveNext: computed(() => endDate.value < today.value),
            reportSupported,
            isPrinting,
            moveDay,
            selectToday,
            toggleCustomPeriod,
            applyCustomPeriod,
            printReportLayout
        };
    }
};
</script>

<style scoped>
.daily-reports-workspace {
    /* Full width, like every other admin page. This was capped at 1480px and
       centred, which left a margin on wide screens that no other page has. */
    width: 100%;
    padding-bottom: 2.5rem;
}

.report-command {
    display: grid;
    grid-template-columns: minmax(16rem, 0.8fr) minmax(34rem, 1.2fr);
    align-items: end;
    gap: 2rem;
    margin-bottom: 1rem;
}

.report-command__kicker {
    margin-bottom: 0.35rem;
    color: #24405e;
    font-size: 0.75rem;
    font-weight: 750;
}

.report-command__title {
    color: #18181b;
    font-size: clamp(1.65rem, 2.3vw, 2.25rem);
    font-weight: 700;
    line-height: 1.08;
    letter-spacing: -0.035em;
}

.report-command__description {
    max-width: 42rem;
    margin-top: 0.55rem;
    color: #71717a;
    font-size: 0.84rem;
    line-height: 1.5;
}

.report-command__controls {
    display: grid;
    gap: 0.7rem;
    justify-items: end;
}

.report-period {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.55rem;
    min-width: 0;
    color: #71717a;
    font-size: 0.72rem;
}

.report-period__label {
    font-weight: 650;
}

.report-period__value {
    overflow: hidden;
    color: #27272a;
    font-weight: 650;
    text-overflow: ellipsis;
    unicode-bidi: isolate;
    white-space: nowrap;
}

.report-period__count {
    border-inline-start: 1px solid #d4d4d8;
    padding-inline-start: 0.55rem;
    color: #24405e;
    font-weight: 750;
}

.report-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
}

.report-day-nav {
    display: inline-grid;
    grid-template-columns: repeat(3, auto);
    overflow: hidden;
    border: 1px solid #d4d4d8;
    border-radius: 8px;
    background: #fff;
}

.report-day-nav button,
.report-action-button {
    min-height: 2.35rem;
    border: 0;
    font-size: 0.75rem;
    font-weight: 700;
    transition: background-color 160ms ease, color 160ms ease, transform 160ms ease;
}

.report-day-nav button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.55rem 0.75rem;
    color: #3f3f46;
    background: #fff;
}

.report-day-nav button + button {
    border-inline-start: 1px solid #e4e4e7;
}

.report-day-nav button:hover:not(:disabled),
.report-action-button--secondary:hover {
    background: #f4f4f5;
}

.report-day-nav button:disabled,
.report-action-button:disabled {
    color: #747481;
    cursor: not-allowed;
}

.report-day-nav button:active:not(:disabled),
.report-action-button:active:not(:disabled),
.report-tab:active {
    transform: scale(0.98);
}

.report-action-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    border-radius: 8px;
    padding: 0.55rem 0.9rem;
}

.report-action-button--secondary {
    border: 1px solid #d4d4d8;
    color: #3f3f46;
    background: #fff;
}

.report-action-button--primary {
    border: 1px solid #24405e;
    color: #fff;
    background: #24405e;
}

.report-action-button--primary:hover:not(:disabled) {
    background: #1d3450;
}

.report-day-nav button:focus-visible,
.report-action-button:focus-visible,
.report-period-panel input:focus-visible,
.report-period-panel button:focus-visible {
    outline: 2px solid #3a5c85;
    outline-offset: 2px;
}

.report-period-panel {
    display: grid;
    grid-template-columns: minmax(15rem, 1fr) repeat(2, minmax(9rem, auto)) auto;
    align-items: end;
    gap: 1rem;
    margin-bottom: 1rem;
    border: 1px solid #d4d4d8;
    border-radius: 12px;
    padding: 1rem;
    background: #fff;
}

.report-period-panel h2 {
    color: #27272a;
    font-size: 0.88rem;
    font-weight: 750;
}

.report-period-panel p,
.report-period-panel label span {
    color: #71717a;
    font-size: 0.72rem;
}

.report-period-panel label span {
    display: block;
    margin-bottom: 0.35rem;
    font-weight: 700;
}

.report-period-panel input {
    width: 100%;
    min-height: 2.35rem;
    border: 1px solid #d4d4d8;
    border-radius: 8px;
    padding-inline: 0.7rem;
    color: #27272a;
    background: #fafafa;
    font-size: 0.75rem;
}

.report-period-panel button {
    min-height: 2.35rem;
    border: 1px solid #27272a;
    border-radius: 8px;
    padding: 0.55rem 1rem;
    color: #fff;
    background: #27272a;
    font-size: 0.75rem;
    font-weight: 700;
}

.report-period-panel__error {
    grid-column: 2 / -1;
    color: #be123c !important;
    font-weight: 700;
}

.report-sheet {
    position: relative;
    z-index: 0;
    min-height: 32rem;
    margin-top: 0;
    border: 1px solid #d4d4d8;
    border-radius: 14px;
    padding: clamp(1rem, 2.2vw, 1.75rem);
    background: #fff;
}

.report-sheet :deep(.report-page) {
    display: grid;
    gap: 1.25rem;
}

.report-sheet :deep(.report-section) {
    overflow: hidden;
    border: 1px solid #e4e4e7;
    border-radius: 12px;
    background: #fff;
}

.report-sheet :deep(.report-section__header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: 3.15rem;
    border-bottom: 1px solid #e4e4e7;
    padding: 0.8rem 1rem;
    background: #fafafa;
}

.report-sheet :deep(.report-section__title) {
    color: #27272a;
    font-size: 0.82rem;
    font-weight: 750;
}

.report-sheet :deep(.report-section__hint) {
    color: #71717a;
    font-size: 0.7rem;
}

.report-sheet :deep(.report-metric-label) {
    color: #71717a;
    font-size: 0.74rem;
    font-weight: 650;
}

.report-sheet :deep(.report-state) {
    display: grid;
    min-height: 22rem;
    place-items: center;
    border: 1px solid #e4e4e7;
    border-radius: 12px;
    padding: 2rem;
    color: #71717a;
    background: #fafafa;
    text-align: center;
}

.report-sheet :deep(.report-state__skeleton) {
    display: grid;
    grid-template-columns: 1.4fr 0.8fr 0.8fr;
    gap: 0.65rem;
    width: min(100%, 34rem);
    margin-bottom: 1rem;
}

.report-sheet :deep(.report-state__skeleton span) {
    height: 4rem;
    border-radius: 8px;
    background: #e4e4e7;
}

.report-sheet :deep(.report-state__skeleton span:first-child) {
    background: #d4d4d8;
}

.report-sheet :deep(.report-error) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border: 1px solid #fecdd3;
    border-radius: 10px;
    padding: 0.8rem 1rem;
    color: #9f1239;
    background: #fff1f2;
    font-size: 0.78rem;
}

.report-sheet :deep(.report-error button) {
    flex: none;
    font-weight: 750;
    text-decoration: underline;
    text-underline-offset: 3px;
}

.reports-page-enter-active,
.period-panel-enter-active,
.period-panel-leave-active {
    transition: opacity 180ms cubic-bezier(0.16, 1, 0.3, 1), transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
}

.reports-page-enter-from,
.period-panel-enter-from {
    opacity: 0;
    transform: translateY(6px);
}

.period-panel-leave-to {
    opacity: 0;
    transform: translateY(-4px);
}

.reports-page-leave-active {
    display: none;
}

:global(html[dir="rtl"] .report-command__title) {
    letter-spacing: 0;
}



@media (max-width: 1100px) {
    .report-command {
        grid-template-columns: 1fr;
        gap: 1rem;
    }

    .report-command__controls,
    .report-period {
        justify-items: start;
        justify-content: flex-start;
    }

    .report-actions {
        justify-content: flex-start;
    }
}

@media (max-width: 760px) {
    .report-command__title {
        font-size: 1.65rem;
    }

    .report-period {
        display: grid;
        grid-template-columns: auto 1fr;
        width: 100%;
    }

    .report-period__value {
        white-space: normal;
    }

    .report-period__count {
        grid-column: 1 / -1;
        border-inline-start: 0;
        padding-inline-start: 0;
    }

    .report-actions,
    .report-action-button {
        width: 100%;
    }

    .report-day-nav {
        width: 100%;
        grid-template-columns: repeat(3, 1fr);
    }

    .report-action-button {
        flex: 1 1 10rem;
    }

    .report-period-panel {
        grid-template-columns: 1fr;
    }

    .report-period-panel__error {
        grid-column: auto;
    }



    .report-sheet {
        padding: 0.85rem;
    }
}

@media (prefers-reduced-motion: reduce) {
    .report-day-nav button,
    .report-action-button,
    .reports-page-enter-active,
    .reports-page-leave-active,
    .period-panel-enter-active,
    .period-panel-leave-active {
        transition: none;
    }
}
</style>
