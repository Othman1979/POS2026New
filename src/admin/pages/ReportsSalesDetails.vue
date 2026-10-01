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

        <div v-if="!hasReportActivity" class="sales-empty">
            <i class="fa-solid fa-chart-column" aria-hidden="true"></i>
            <h2>{{ $t('No sales activity') }}</h2>
            <p>{{ $t('No sales or returns in this period.') }}</p>
        </div>

        <template v-else>
            <section class="sales-totals" :aria-label="$t('Sales Breakdown')">
                <div class="sales-totals__primary">
                    <span class="report-metric-label">{{ $t('Net Sales') }}</span>
                    <strong class="font-display tabular-nums">{{ formatMoney(reportData.totals.sales_collected) }}</strong>
                </div>
                <div>
                    <span class="report-metric-label">{{ $t('Menu Sales') }}</span>
                    <strong class="tabular-nums">{{ formatMoney(reportData.totals.menu_sales) }}</strong>
                </div>
                <div v-if="Number(reportData.totals.service_charges_collected) !== 0">
                    <span class="report-metric-label">{{ $t('Service Charges') }}</span>
                    <strong class="tabular-nums">{{ formatMoney(reportData.totals.service_charges_collected) }}</strong>
                </div>
            </section>

            <div class="sales-definition">
                <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
                <span>{{ $t('Amounts include tax. Returns are counted when issued. Service charges are shown separately.') }}</span>
            </div>

            <div class="sales-main-grid">
                <section class="report-section sales-categories">
                    <header class="report-section__header">
                        <h2 class="report-section__title">{{ $t('Sales by Category') }}</h2>
                        <span class="report-section__hint">{{ $t('Select a category to show its groups') }}</span>
                    </header>
                    <div v-if="!reportData.categories?.length" class="sales-section-empty">
                        {{ $t('No category activity in this period.') }}
                    </div>
                    <div v-else class="sales-category-list">
                        <div v-for="category in reportData.categories" :key="category.category_id || 'uncategorized'" class="sales-category">
                            <button type="button" class="sales-category__row"
                                    :class="{ 'sales-category__row--expandable': category.subcategories?.length }"
                                    :disabled="!category.subcategories?.length"
                                    :aria-expanded="category.subcategories?.length ? isCategoryExpanded(category.category_id) : undefined"
                                    :aria-label="$t('Toggle category')"
                                    @click="category.subcategories?.length && toggleCategory(category.category_id)">
                                <span class="sales-category__identity">
                                    <i v-if="category.subcategories?.length" class="fa-solid"
                                       :class="isCategoryExpanded(category.category_id) ? 'fa-chevron-down' : (isRtl ? 'fa-chevron-left' : 'fa-chevron-right')"></i>
                                    <i v-else class="fa-solid fa-minus" aria-hidden="true"></i>
                                    <strong v-if="category.category_id" data-no-i18n>{{ category.name }}</strong>
                                    <strong v-else>{{ $t('Uncategorized') }}</strong>
                                </span>
                                <span class="sales-category__numbers">
                                    <small>{{ formatNumber(category.sold_qty) }} {{ $t('Qty') }}</small>
                                    <strong>{{ formatMoney(category.net_sales) }}</strong>
                                </span>
                            </button>
                            <transition name="category-expand">
                                <div v-if="isCategoryExpanded(category.category_id) && category.subcategories?.length" class="sales-subcategories">
                                    <div v-for="subcategory in category.subcategories" :key="subcategory.category_id">
                                        <span data-no-i18n>{{ subcategory.name }}</span>
                                        <small>{{ formatNumber(subcategory.sold_qty) }} {{ $t('Qty') }}</small>
                                        <strong>{{ formatMoney(subcategory.net_sales) }}</strong>
                                    </div>
                                </div>
                            </transition>
                        </div>
                    </div>
                </section>

                <section class="report-section sales-products">
                    <header class="report-section__header sales-products__header">
                        <div>
                            <h2 class="report-section__title">{{ $t('Product Activity') }}</h2>
                            <span class="report-section__hint">{{ $t('Sold and returned quantities with net sales') }}</span>
                        </div>
                        <span class="sales-products__count">{{ formatNumber(filteredProducts.length) }} {{ $t('products') }}</span>
                    </header>

                    <div class="sales-filters">
                        <label class="sales-search">
                            <span class="sr-only">{{ $t('Filter products by name') }}</span>
                            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                            <input v-model="searchQuery" type="search" :placeholder="$t('Filter products by name')" />
                        </label>
                        <label>
                            <span class="sr-only">{{ $t('All Categories') }}</span>
                            <select v-model="selectedCategory">
                                <option value="">{{ $t('All Categories') }}</option>
                                <option v-for="category in allCategoryOptions" :key="category" :value="category">{{ category }}</option>
                            </select>
                        </label>
                    </div>

                    <div class="sales-table-wrap">
                        <table class="sales-table">
                            <thead>
                                <tr>
                                    <th>{{ $t('Product') }}</th>
                                    <th>{{ $t('Category') }}</th>
                                    <th class="text-center">{{ $t('Sold') }}</th>
                                    <th class="text-center">{{ $t('Returned') }}</th>
                                    <th class="text-end">{{ $t('Net Sales') }}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-if="filteredProducts.length === 0">
                                    <td colspan="5" class="sales-table__empty">{{ $t('No matching products found.') }}</td>
                                </tr>
                                <tr v-for="product in paginatedProducts" :key="product.product_id || product.item_name">
                                    <td><strong data-no-i18n>{{ product.item_name }}</strong></td>
                                    <td><small data-no-i18n>{{ product.category_path }}</small></td>
                                    <td class="text-center tabular-nums">{{ formatNumber(product.sold_qty) }}</td>
                                    <td class="text-center tabular-nums" :class="product.returned_qty > 0 ? 'text-rose-700 font-bold' : 'text-muted-foreground'">
                                        {{ product.returned_qty > 0 ? formatNumber(product.returned_qty) : '-' }}
                                    </td>
                                    <td class="text-end font-bold tabular-nums">{{ formatMoney(product.net_sales) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <nav v-if="totalPages > 1" class="sales-pagination" :aria-label="$t('Products')">
                        <button type="button" :disabled="currentPage <= 1" :aria-label="$t('Previous')" @click="previousPage">
                            <i :class="['fa-solid', isRtl ? 'fa-chevron-right' : 'fa-chevron-left']" aria-hidden="true"></i>
                        </button>
                        <span>
                            {{ $t('Page') }}
                            <strong class="tabular-nums" data-no-i18n>{{ formatNumber(currentPage) }}</strong>
                            /
                            <span class="tabular-nums" data-no-i18n>{{ formatNumber(totalPages) }}</span>
                        </span>
                        <button type="button" :disabled="currentPage >= totalPages" :aria-label="$t('Next')" @click="nextPage">
                            <i :class="['fa-solid', isRtl ? 'fa-chevron-left' : 'fa-chevron-right']" aria-hidden="true"></i>
                        </button>
                    </nav>
                </section>
            </div>

            <section class="sales-dimensions" :aria-label="$t('Operational Breakdown')">
                <div class="sales-dimension">
                    <header><h2>{{ $t('Order Types') }}</h2></header>
                    <div v-if="!reportData.order_types?.length" class="sales-section-empty">{{ $t('No order type activity.') }}</div>
                    <dl v-else>
                        <div v-for="orderType in reportData.order_types" :key="orderType.id">
                            <dt><strong data-no-i18n>{{ orderType.name }}</strong><small>{{ formatNumber(orderType.orders) }} {{ $t('orders') }}</small></dt>
                            <dd>{{ formatMoney(orderType.net_sales) }}</dd>
                        </div>
                    </dl>
                </div>

                <div class="sales-dimension">
                    <header><h2>{{ $t('Cashiers') }}</h2></header>
                    <div v-if="!reportData.cashiers?.length" class="sales-section-empty">{{ $t('No cashier activity.') }}</div>
                    <dl v-else>
                        <div v-for="cashier in reportData.cashiers" :key="cashier.id">
                            <dt><strong data-no-i18n>{{ cashier.name }}</strong><small>{{ formatNumber(cashier.orders) }} {{ $t('orders') }}</small></dt>
                            <dd>{{ formatMoney(cashier.net_sales) }}</dd>
                        </div>
                    </dl>
                </div>

                <div v-if="reportData.tables_enabled && reportData.waiters?.length" class="sales-dimension">
                    <header><h2>{{ $t('Waiters') }}</h2></header>
                    <dl>
                        <div v-for="waiter in reportData.waiters" :key="waiter.id">
                            <dt><strong data-no-i18n>{{ waiter.name }}</strong><small>{{ formatNumber(waiter.orders) }} {{ $t('orders') }}</small></dt>
                            <dd>{{ formatMoney(waiter.net_sales) }}</dd>
                        </div>
                    </dl>
                </div>

                <div v-if="reportData.tables_enabled && reportData.tables?.length" class="sales-dimension">
                    <header><h2>{{ $t('Tables') }}</h2></header>
                    <dl>
                        <div v-for="table in reportData.tables" :key="table.id">
                            <dt><strong>{{ $t('Table') }} {{ table.table_number }}</strong><small data-no-i18n>{{ table.section_name }}</small></dt>
                            <dd>{{ formatMoney(table.net_sales) }}</dd>
                        </div>
                    </dl>
                </div>
            </section>
        </template>
    </div>
</template>

<script>
import { inject, ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useDailyReportPage } from '../composables/useDailyReportPage.js';
import { buildDailySalesPrintPayload } from './dailyReportPayloads.js';
import { currentLanguage } from '@/shared/i18n.js';
import { formatReportMoney, formatReportNumber } from '../utils/reportFormatting.js';

export default {
    name: 'ReportsSalesDetails',
    setup() {
        const period = inject('dailyReportPeriod');
        const registerDailyReportPrint = inject('registerDailyReportPrint');
        const { data, loading, error, reload } = useDailyReportPage('sales-details', period);
        const reportData = computed(() => data.value);
        const hasReportActivity = computed(() => {
            const report = reportData.value;
            if (!report) return false;
            return (report.products?.length || 0) > 0 ||
                (report.categories?.length || 0) > 0 ||
                Math.abs(Number(report.totals?.sales_collected) || 0) > 0;
        });
        const isRtl = computed(() => currentLanguage.value === 'ar');
        const expandedCategories = ref(new Set());

        const toggleCategory = (categoryId) => {
            const next = new Set(expandedCategories.value);
            if (next.has(categoryId)) next.delete(categoryId);
            else next.add(categoryId);
            expandedCategories.value = next;
        };
        const isCategoryExpanded = (categoryId) => expandedCategories.value.has(categoryId);

        const searchQuery = ref('');
        const selectedCategory = ref('');
        const pageSize = 50;
        const currentPage = ref(1);
        const filteredProducts = computed(() => {
            let list = reportData.value?.products || [];
            const query = searchQuery.value.toLowerCase().trim();
            if (query) list = list.filter((product) => product.item_name.toLowerCase().includes(query));
            if (selectedCategory.value) {
                list = list.filter((product) => product.category_path?.includes(selectedCategory.value));
            }
            return list;
        });
        const totalPages = computed(() => Math.ceil(filteredProducts.value.length / pageSize));
        const paginatedProducts = computed(() => {
            const start = (currentPage.value - 1) * pageSize;
            return filteredProducts.value.slice(start, start + pageSize);
        });
        const clampCurrentPage = () => {
            currentPage.value = Math.min(currentPage.value, Math.max(totalPages.value, 1));
        };
        const previousPage = () => {
            currentPage.value = Math.max(1, currentPage.value - 1);
        };
        const nextPage = () => {
            currentPage.value = Math.min(Math.max(totalPages.value, 1), currentPage.value + 1);
        };
        watch([searchQuery, selectedCategory], () => {
            currentPage.value = 1;
        });
        watch(() => reportData.value?.products, clampCurrentPage);
        watch([period.startDate, period.endDate], () => {
            currentPage.value = 1;
        });
        const allCategoryOptions = computed(() => {
            const categories = new Set();
            for (const product of reportData.value?.products || []) {
                const topCategory = product.category_path?.split(' › ')[0];
                if (topCategory) categories.add(topCategory);
            }
            return Array.from(categories).sort();
        });

        const registerProvider = () => {
            if (registerDailyReportPrint) {
                registerDailyReportPrint(data.value ? async () => buildDailySalesPrintPayload(data.value) : null);
            }
        };
        onMounted(registerProvider);
        watch(data, registerProvider);
        onUnmounted(() => registerDailyReportPrint?.(null));

        return {
            period,
            data,
            loading,
            error,
            reload,
            reportData,
            hasReportActivity,
            isRtl,
            toggleCategory,
            isCategoryExpanded,
            searchQuery,
            selectedCategory,
            filteredProducts,
            paginatedProducts,
            currentPage,
            totalPages,
            previousPage,
            nextPage,
            allCategoryOptions,
            formatMoney: formatReportMoney,
            formatNumber: formatReportNumber
        };
    }
};
</script>

<style scoped>
.sales-empty {
    display: grid;
    min-height: 24rem;
    place-items: center;
    align-content: center;
    color: #71717a;
    text-align: center;
}

.sales-empty i {
    margin-bottom: 1rem;
    color: #24405e;
    font-size: 1.5rem;
}

.sales-empty h2 {
    color: #27272a;
    font-family: var(--font-display);
    font-size: 1.2rem;
    font-weight: 700;
}

.sales-empty p {
    margin-top: 0.35rem;
    font-size: 0.78rem;
}

.sales-totals {
    display: grid;
    grid-template-columns: minmax(0, 1.65fr) repeat(2, minmax(12rem, 0.7fr));
    overflow: hidden;
    border: 1px solid #d4d4d8;
    border-radius: 12px;
    background: #fff;
}

.sales-totals > div {
    display: flex;
    min-height: 7.8rem;
    flex-direction: column;
    justify-content: center;
    padding: 1.4rem;
}

.sales-totals > div + div {
    border-inline-start: 1px solid #e4e4e7;
}

.sales-totals__primary {
    background: #fafafa;
}

.sales-totals strong {
    margin-top: 0.55rem;
    color: #27272a;
    font-size: 1.45rem;
    font-weight: 750;
}

.sales-totals__primary strong {
    font-size: clamp(2.2rem, 4vw, 3.6rem);
    letter-spacing: -0.045em;
}

.sales-definition {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    border-inline-start: 2px solid #24405e;
    padding: 0.25rem 0.75rem;
    color: #71717a;
    font-size: 0.7rem;
    line-height: 1.5;
}

.sales-definition i {
    color: #24405e;
}

.sales-main-grid {
    display: grid;
    grid-template-columns: minmax(17rem, 0.7fr) minmax(0, 1.3fr);
    align-items: start;
    gap: 1.25rem;
}

.sales-section-empty {
    padding: 2rem 1rem;
    color: #71717a;
    font-size: 0.76rem;
    text-align: center;
}

.sales-category + .sales-category {
    border-top: 1px solid #f0f0f1;
}

.sales-category__row {
    display: flex;
    width: 100%;
    min-height: 3.75rem;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.8rem 1rem;
    color: #27272a;
    background: #fff;
    text-align: start;
}

.sales-category__row--expandable:hover {
    background: #fafafa;
}

.sales-category__row:disabled {
    cursor: default;
}

.sales-category__identity {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.6rem;
}

.sales-category__identity i {
    width: 0.7rem;
    color: #747481;
    font-size: 0.58rem;
}

.sales-category__identity strong {
    overflow: hidden;
    font-size: 0.78rem;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.sales-category__numbers {
    flex: none;
    text-align: end;
}

.sales-category__numbers small,
.sales-category__numbers strong {
    display: block;
}

.sales-category__numbers small {
    color: #747481;
    font-size: 0.62rem;
}

.sales-category__numbers strong {
    margin-top: 0.15rem;
    font-size: 0.76rem;
    font-variant-numeric: tabular-nums;
}

.sales-subcategories {
    border-top: 1px solid #e4e4e7;
    padding-block: 0.35rem;
    padding-inline: 2rem 0.7rem;
    background: #fafafa;
}

:global(html[dir="rtl"]) .sales-totals__primary strong {
    letter-spacing: 0;
}

.sales-subcategories > div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 0.8rem;
    padding: 0.55rem 0.35rem;
    color: #71717a;
    font-size: 0.69rem;
}

.sales-subcategories > div + div {
    border-top: 1px solid #e4e4e7;
}

.sales-subcategories strong {
    color: #3f3f46;
    font-variant-numeric: tabular-nums;
}

.sales-products__header > div {
    min-width: 0;
}

.sales-products__count {
    flex: none;
    color: #24405e;
    font-size: 0.68rem;
    font-weight: 750;
}

.sales-filters {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(10rem, 0.35fr);
    gap: 0.65rem;
    border-bottom: 1px solid #e4e4e7;
    padding: 0.75rem;
    background: #fff;
}

.sales-search {
    position: relative;
}

.sales-search i {
    position: absolute;
    inset-inline-start: 0.75rem;
    top: 50%;
    color: #747481;
    font-size: 0.68rem;
    transform: translateY(-50%);
}

.sales-filters input,
.sales-filters select {
    width: 100%;
    min-height: 2.35rem;
    border: 1px solid #d4d4d8;
    border-radius: 8px;
    color: #3f3f46;
    background: #fafafa;
    font-size: 0.72rem;
    outline: none;
}

.sales-filters input {
    padding-inline: 2.15rem 0.75rem;
}

.sales-filters select {
    padding-inline: 0.7rem;
}

.sales-filters input:focus,
.sales-filters select:focus {
    border-color: #3a5c85;
    box-shadow: 0 0 0 3px rgba(58, 92, 133, 0.12);
    background: #fff;
}

.sales-table-wrap {
    overflow-x: auto;
}

.sales-table {
    width: 100%;
    min-width: 42rem;
    border-collapse: collapse;
    color: #3f3f46;
    font-size: 0.74rem;
    text-align: start;
}

.sales-table th {
    padding: 0.7rem 0.85rem;
    color: #71717a;
    background: #fafafa;
    font-size: 0.65rem;
    font-weight: 750;
    text-align: start;
}

.sales-table td {
    padding: 0.75rem 0.85rem;
}

.sales-table tbody tr {
    border-top: 1px solid #f0f0f1;
}

.sales-table tbody tr:hover {
    background: #fafafa;
}

.sales-table td small {
    color: #71717a;
}

.sales-table__empty {
    height: 8rem;
    color: #71717a;
    text-align: center;
}

.sales-pagination {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.75rem;
    border-top: 1px solid #e4e4e7;
    padding: 0.75rem;
    color: #71717a;
    background: #fff;
    font-size: 0.7rem;
}

.sales-pagination button {
    display: grid;
    width: 2rem;
    height: 2rem;
    place-items: center;
    border: 1px solid #d4d4d8;
    border-radius: 8px;
    color: #3f3f46;
    background: #fff;
}

.sales-pagination button:hover:not(:disabled) {
    border-color: #3a5c85;
    color: #24405e;
}

.sales-pagination button:focus-visible {
    outline: 3px solid rgba(58, 92, 133, 0.2);
    outline-offset: 2px;
}

.sales-pagination button:disabled {
    cursor: default;
    opacity: 0.4;
}

.sales-dimensions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    overflow: hidden;
    border: 1px solid #e4e4e7;
    border-radius: 12px;
    background: #fff;
}

.sales-dimension:nth-child(even) {
    border-inline-start: 1px solid #e4e4e7;
}

.sales-dimension:nth-child(n + 3) {
    border-top: 1px solid #e4e4e7;
}

.sales-dimension header {
    border-bottom: 1px solid #e4e4e7;
    padding: 0.75rem 1rem;
    background: #fafafa;
}

.sales-dimension h2 {
    color: #27272a;
    font-size: 0.78rem;
    font-weight: 750;
}

.sales-dimension dl > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
}

.sales-dimension dl > div + div {
    border-top: 1px solid #f0f0f1;
}

.sales-dimension dt strong,
.sales-dimension dt small {
    display: block;
}

.sales-dimension dt strong {
    color: #3f3f46;
    font-size: 0.75rem;
}

.sales-dimension dt small {
    margin-top: 0.15rem;
    color: #747481;
    font-size: 0.64rem;
}

.sales-dimension dd {
    color: #27272a;
    font-size: 0.76rem;
    font-weight: 750;
    font-variant-numeric: tabular-nums;
}

.category-expand-enter-active,
.category-expand-leave-active {
    transition: opacity 160ms ease, transform 160ms ease;
}

.category-expand-enter-from,
.category-expand-leave-to {
    opacity: 0;
    transform: translateY(-3px);
}

/* The fixed admin sidebar leaves less room than the viewport suggests. Stack
   before either ledger has to hide a financial column behind horizontal scroll. */
@media (max-width: 1380px) {
    .sales-main-grid {
        grid-template-columns: 1fr;
    }
}

@media (max-width: 760px) {
    .sales-totals {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .sales-totals__primary {
        grid-column: 1 / -1;
    }

    .sales-totals > div + div {
        border-top: 1px solid #e4e4e7;
    }

    .sales-totals > div:nth-child(2) {
        border-inline-start: 0;
    }

    .sales-filters,
    .sales-dimensions {
        grid-template-columns: 1fr;
    }

    .sales-dimension:nth-child(even) {
        border-inline-start: 0;
    }

    .sales-dimension + .sales-dimension {
        border-top: 1px solid #e4e4e7;
    }
}

@media (prefers-reduced-motion: reduce) {
    .category-expand-enter-active,
    .category-expand-leave-active {
        transition: none;
    }
}
</style>
