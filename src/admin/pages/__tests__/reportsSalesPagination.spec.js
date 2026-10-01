import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

const testState = vi.hoisted(() => ({
    data: null,
    loading: null,
    error: null,
    reload: vi.fn(),
    period: null,
    registerPrint: vi.fn()
}));

vi.mock('vue', async importOriginal => ({
    ...await importOriginal(),
    useSSRContext: () => ({ modules: new Set() }),
    inject: key => key === 'dailyReportPeriod' ? testState.period : testState.registerPrint,
    onMounted: callback => callback(),
    onUnmounted: vi.fn()
}));
vi.mock('../../composables/useDailyReportPage.js', () => ({
    useDailyReportPage: () => ({
        data: testState.data,
        loading: testState.loading,
        error: testState.error,
        reload: testState.reload
    })
}));
vi.mock('@/shared/i18n.js', () => ({ currentLanguage: ref('en') }));

import ReportsSalesDetails from '../ReportsSalesDetails.vue';

function product(id, overrides = {}) {
    return {
        product_id: id,
        item_name: `Product ${String(id).padStart(3, '0')}`,
        category_path: id % 2 ? 'Food' : 'Drinks',
        sold_qty: 1,
        returned_qty: 0,
        net_sales: id,
        ...overrides
    };
}

function report(products) {
    return {
        success: true,
        period: { start_date: '2026-09-01', end_date: '2026-09-10' },
        totals: { sales_collected: 999, menu_sales: 999, service_charges_collected: 0 },
        products,
        categories: [],
        order_types: [],
        cashiers: [],
        waiters: [],
        tables: [],
        tables_enabled: false
    };
}

function mountPage(products = []) {
    testState.data = ref(report(products));
    testState.loading = ref(false);
    testState.error = ref(null);
    testState.period = { startDate: ref('2026-09-01'), endDate: ref('2026-09-10') };
    const scope = effectScope();
    const page = scope.run(() => ReportsSalesDetails.setup());
    return { page, scope };
}

beforeEach(() => {
    testState.registerPrint.mockReset();
    testState.reload.mockReset();
});

describe('Sales Breakdown product pagination', () => {
    it('shows at most 50 products and safely reaches the first and last pages', () => {
        const { page, scope } = mountPage(Array.from({ length: 105 }, (_, index) => product(index + 1)));

        expect(page.currentPage.value).toBe(1);
        expect(page.totalPages.value).toBe(3);
        expect(page.paginatedProducts.value.map(row => row.product_id)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
        page.previousPage();
        expect(page.currentPage.value).toBe(1);

        page.nextPage();
        page.nextPage();
        page.nextPage();
        expect(page.currentPage.value).toBe(3);
        expect(page.paginatedProducts.value.map(row => row.product_id)).toEqual([101, 102, 103, 104, 105]);

        scope.stop();
    });

    it('filters the full dataset, resets the page, and handles zero matches', async () => {
        const products = Array.from({ length: 105 }, (_, index) => product(index + 1));
        products[99] = product(100, { item_name: 'Needle Product', category_path: 'Special' });
        const { page, scope } = mountPage(products);
        page.currentPage.value = 3;

        page.searchQuery.value = 'needle';
        await nextTick();
        expect(page.currentPage.value).toBe(1);
        expect(page.filteredProducts.value.map(row => row.product_id)).toEqual([100]);
        expect(page.paginatedProducts.value.map(row => row.product_id)).toEqual([100]);

        page.searchQuery.value = 'missing';
        await nextTick();
        expect(page.totalPages.value).toBe(0);
        expect(page.currentPage.value).toBe(1);
        expect(page.paginatedProducts.value).toEqual([]);

        page.searchQuery.value = '';
        await nextTick();
        page.currentPage.value = 2;
        page.selectedCategory.value = 'Special';
        await nextTick();
        expect(page.currentPage.value).toBe(1);
        expect(page.paginatedProducts.value.map(row => row.product_id)).toEqual([100]);

        scope.stop();
    });

    it('clamps a stale page when report data shrinks and resets for a new period', async () => {
        const { page, scope } = mountPage(Array.from({ length: 105 }, (_, index) => product(index + 1)));
        page.currentPage.value = 3;

        testState.data.value = report(Array.from({ length: 60 }, (_, index) => product(index + 1)));
        await nextTick();
        expect(page.currentPage.value).toBe(2);
        expect(page.paginatedProducts.value).toHaveLength(10);

        testState.period.startDate.value = '2026-09-02';
        await nextTick();
        expect(page.currentPage.value).toBe(1);

        scope.stop();
    });

    it('keeps the registered print payload complete after filtering and paging', async () => {
        const products = Array.from({ length: 105 }, (_, index) => product(index + 1));
        const { page, scope } = mountPage(products);
        const printProvider = testState.registerPrint.mock.calls.at(-1)[0];

        page.currentPage.value = 3;
        page.selectedCategory.value = 'Food';
        await nextTick();
        const payload = await printProvider();

        expect(page.paginatedProducts.value.length).toBeLessThanOrEqual(50);
        expect(payload.products).toHaveLength(105);
        expect(payload.totals).toEqual(testState.data.value.totals);

        scope.stop();
    });
});
