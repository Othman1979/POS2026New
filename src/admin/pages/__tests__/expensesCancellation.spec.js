import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSSRApp, effectScope, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';

const state = vi.hoisted(() => ({ data: null, loading: null, error: null, reload: vi.fn(), request: vi.fn(), unmount: [] }));
vi.mock('vue', async original => ({
    ...await original(),
    inject: key => key === 'dailyReportPeriod' ? { startDate: ref('2026-07-18'), endDate: ref('2026-07-19') } : vi.fn(),
    onMounted: vi.fn(), onUnmounted: fn => state.unmount.push(fn),
    useSSRContext: () => ({ modules: new Set() }),
}));
vi.mock('../../composables/useDailyReportPage.js', () => ({ useDailyReportPage: () => state }));
vi.mock('@/shared/http.js', () => ({ fetchJsonResponse: (...args) => state.request(...args), fetchJsonResponseWithTimeout: (...args) => state.request(...args) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: ref('en') }));
import ReportsExpenses from '../ReportsExpenses.vue';

let scope;
let page;
let expense;
beforeEach(() => {
    expense = { id: 7, category_name: 'Supplies', amount: 5.25, source: 'drawer', shift_id: 3, status: 'active', created_at: '2026-07-18 08:00:00', created_by_name: 'Cashier' };
    state.data = ref({ summary: { total: 5.25, count: 1, drawer: 5.25, outside: 0 }, by_category: [], categories: [], open_shifts: [], entries: [expense], is_current_business_day: false });
    state.loading = ref(false); state.error = ref(null);
    state.reload.mockReset().mockResolvedValue(); state.request.mockReset(); state.unmount = [];
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null) });
    scope = effectScope(); page = scope.run(() => ReportsExpenses.setup({}, { expose: vi.fn() }));
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });

it('shows cancellation for active historical entries in a range, but not canceled entries', async () => {
    const render = () => {
        const app = createSSRApp(ReportsExpenses);
        app.config.globalProperties.$t = key => key;
        return renderToString(app);
    };
    const html = await render();
    expect(html).toContain('class="expense-cancel"');
    state.data.value.entries[0].status = 'canceled';
    expect(await render()).not.toContain('class="expense-cancel"');
});

it('sends one cancellation and refresh across repeated clicks', async () => {
    let finish;
    state.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = page.cancelExpense(expense);
    const second = page.cancelExpense(expense);
    expect(state.request).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    finish({ response: { ok: true }, data: { success: true, expense: { ...expense, status: 'canceled' }, print_queued: true } });
    await Promise.all([first, second]);
    expect(state.reload).toHaveBeenCalledTimes(1);
});

it('keeps a confirmed cancellation visible if refreshing totals fails', async () => {
    state.request.mockResolvedValue({ response: { ok: true }, data: { success: true, expense: { ...expense, status: 'canceled', canceled_by_name: 'Admin' }, print_queued: false } });
    state.reload.mockImplementation(async () => { state.error.value = 'Network error'; });
    await page.cancelExpense(expense);
    expect(state.data.value.entries[0].status).toBe('canceled');
    expect(page.actionError.value).toBe('Expense canceled, but it could not be sent to the printer.');
});

it('refreshes after an uncertain response without retrying the cancellation', async () => {
    state.request.mockRejectedValue(new Error('Connection lost'));
    state.reload.mockImplementation(async () => { state.data.value.entries[0].status = 'canceled'; });
    await page.cancelExpense(expense);
    expect(state.request).toHaveBeenCalledTimes(1);
    expect(state.reload).toHaveBeenCalledTimes(1);
    expect(state.data.value.entries[0].status).toBe('canceled');
});

it('unlocks other cancellations once the write finishes even if the report refresh stalls', async () => {
    state.request.mockResolvedValue({ response: { ok: true }, data: { success: true, expense: { ...expense, status: 'canceled' }, print_queued: true } });
    let finish;
    state.reload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = page.cancelExpense(expense);
    try {
        await vi.waitFor(() => expect(page.cancellingId.value).toBeNull(), { timeout: 100 });
        expect(state.data.value.entries[0].status).toBe('canceled');
    } finally { finish?.(); await pending; }
});

it('does not send a cancellation after confirmation is declined', async () => {
    window.confirm.mockReturnValue(false);
    await page.cancelExpense(expense);
    expect(state.request).not.toHaveBeenCalled();
});

it('stops waiting when leaving the page and does not reload the unmounted report', async () => {
    let signal;
    state.request.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
        signal = options.signal;
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = page.cancelExpense(expense);
    expect(signal).toBeDefined();
    state.unmount.forEach(fn => fn());
    await pending;
    expect(signal.aborted).toBe(true);
    expect(state.reload).not.toHaveBeenCalled();
});
