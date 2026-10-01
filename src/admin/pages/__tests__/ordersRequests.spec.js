import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, effectScope, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';

const lifecycle = vi.hoisted(() => ({ activated: [], deactivated: [], unmounted: [] }));
const settings = vi.hoisted(() => ({ tables_enabled: '1' }));
vi.mock('vue', async importOriginal => ({
    ...await importOriginal(),
    useSSRContext: () => ({ modules: new Set() }),
    onMounted: vi.fn(),
    onActivated: callback => lifecycle.activated.push(callback),
    onDeactivated: callback => lifecycle.deactivated.push(callback),
    onUnmounted: callback => lifecycle.unmounted.push(callback)
}));
vi.mock('vue-router', () => ({ useRouter: () => ({}), useRoute: () => ({ query: {} }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('@/shared/receiptPrint.js', () => ({ buildReceiptPayload: vi.fn(), printJob: vi.fn() }));
vi.mock('@/shared/systemSettings.js', () => ({ getSystemSettings: async () => ({ success: true, ...settings }) }));
vi.mock('../../components/A4Receipt.vue', () => ({ default: {} }));
vi.mock('../../components/DeliveryInvoice.vue', () => ({ default: {} }));
vi.mock('../../components/OrdersSummaryPanel.vue', () => ({ default: {} }));
import Orders from '../Orders.vue';

let scope;
beforeEach(() => {
    lifecycle.deactivated.length = 0;
    lifecycle.unmounted.length = 0;
    lifecycle.activated.length = 0;
    settings.tables_enabled = '1';
    scope = effectScope();
    vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
    lifecycle.unmounted.forEach(callback => callback());
    scope.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

function snapshot(id) {
    return { json: async () => ({
        success: true,
        orders: [{ invoice_id: id }],
        pagination: { total_pages: id, total: id },
        stats: { total_revenue: id }
    }) };
}

describe('Order History request ownership', () => {
    it.each([
        ['admin', [], true],
        ['cashier', [], false],
        ['cashier', ['pos.refund'], true],
        ['call_center', ['pos.refund'], false],
    ])('applies shared refund authority for %s', (role, permissions, allowed) => {
        vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify({ id: 7, role, permissions }) });
        const page = scope.run(() => Orders.setup());
        expect(page.canRefund.value).toBe(allowed);
    });

    it('shows Retry when the detail response body never finishes', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) })));
        const page = scope.run(() => Orders.setup());
        page.viewOrder(8);
        await vi.advanceTimersByTimeAsync(15000);
        expect(page.isModalLoading.value).toBe(false);
        expect(page.detailError.value).not.toBe('');
        expect(page.selectedOrder.value).toBeNull();
    });

    function detail(id, overrides = {}, ok = true) {
        return { ok, json: async () => ({ success: true, order: { invoice_id: id, total: id }, items: [], ...overrides }) };
    }

    it('keeps the detail summary absent until a real invoice arrives', async () => {
        let finish;
        vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
        const page = scope.run(() => Orders.setup());
        const read = page.viewOrder(21);
        expect(page.isModalLoading.value).toBe(true);
        expect(page.selectedOrder.value).toBeNull();
        expect(page.orderDetailTotals.value).toBeNull();
        finish(detail(21));
        await read;
        expect(page.orderDetailTotals.value.invoiceTotal).toBe(21);
        expect(page.isModalLoading.value).toBe(false);
    });

    it('clears a previous invoice and ignores older detail successes and failures', async () => {
        const pending = [];
        vi.stubGlobal('fetch', vi.fn((url, options) => new Promise((resolve, reject) => pending.push({ resolve, reject, options }))));
        const page = scope.run(() => Orders.setup());
        const initial = page.viewOrder(1);
        pending[0].resolve(detail(1));
        await initial;
        const older = page.viewOrder(2);
        expect(page.selectedOrder.value).toBeNull();
        const newer = page.viewOrder(3);
        expect(pending[1].options?.signal.aborted).toBe(true);
        pending[2].resolve(detail(3));
        await newer;
        pending[1].resolve(detail(2));
        await older;
        expect(page.selectedOrder.value.invoice_id).toBe(3);
        const failed = page.viewOrder(4);
        const last = page.viewOrder(5);
        pending[4].resolve(detail(5));
        await last;
        pending[3].reject(new Error('Late failure'));
        await failed;
        expect(page.selectedOrder.value.invoice_id).toBe(5);
        expect(page.showModal.value).toBe(true);
        expect(page.detailError.value).toBe('');
    });

    it.each(['close', 'deactivate', 'unmount'])('invalidates pending detail work on %s', async action => {
        let finish;
        let signal;
        vi.stubGlobal('fetch', vi.fn((url, options) => new Promise(resolve => { finish = resolve; signal = options?.signal; })));
        const page = scope.run(() => Orders.setup());
        const read = page.viewOrder(7);
        if (action === 'close') page.showModal.value = false;
        else lifecycle[action === 'deactivate' ? 'deactivated' : 'unmounted'].forEach(callback => callback());
        await nextTick();
        expect(signal?.aborted).toBe(true);
        finish(detail(7));
        await read;
        expect(page.selectedOrder.value).toBeNull();
        expect(page.showModal.value).toBe(false);
        expect(page.isModalLoading.value).toBe(false);
    });

    it.each([
        ['HTTP failure', () => detail(8, {}, false)],
        ['receipt validation failure', () => detail(8, { success: false, publicCode: 'RECEIPT_PRESENTATION_INVALID', message: 'Layout validation failed' })],
        ['missing invoice', () => detail(8, { order: null })],
        ['wrong invoice', () => detail(9)],
    ])('shows a retryable error without invoice actions after %s', async (label, response) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(detail(8)));
        const page = scope.run(() => Orders.setup());
        await page.viewOrder(8);
        expect(page.selectedOrder.value).toBeNull();
        expect(page.orderDetailTotals.value).toBeNull();
        expect(page.detailError.value).not.toBe('');
        expect(page.showModal.value).toBe(true);
        await page.viewOrder(8);
        expect(page.selectedOrder.value.invoice_id).toBe(8);
        expect(page.detailError.value).toBe('');
    });

    it('clears the selected table source when tables are disabled remotely', async () => {
        vi.stubGlobal('fetch', vi.fn(async url => String(url).includes('jofotara/settings')
            ? { json: async () => ({ success: true, settings: { enabled: false } }) }
            : snapshot(1)));
        const page = scope.run(() => Orders.setup());
        lifecycle.activated.forEach(callback => callback());
        page.setOrderSource('tables');
        page.currentPage.value = 3;
        settings.tables_enabled = '0';
        window.dispatchEvent(new CustomEvent('admin:realtime', { detail: { type: 'settings_changed' } }));
        await vi.waitFor(() => expect(page.orderSource.value).toBe('register'));
        expect(page.tablesEnabled.value).toBe(false);
        expect(page.currentPage.value).toBe(1);
        const requests = fetch.mock.calls.filter(([url]) => String(url).startsWith('api/admin/orders?'));
        expect(new URL(requests.at(-1)[0], 'http://pos.test').searchParams.get('filter_type')).toBe('register');
    });

    it('keeps the newest page, stats and loading state when older requests complete out of order', async () => {
        const pending = [];
        vi.stubGlobal('fetch', vi.fn((url, options) => new Promise(resolve => pending.push({ resolve, options }))));
        const page = scope.run(() => Orders.setup());
        const first = page.fetchOrders();
        page.currentPage.value = 2;
        const second = page.fetchOrders();
        expect(pending[0].options?.signal.aborted).toBe(true);
        pending[0].resolve(snapshot(1));
        await first;
        expect(page.isLoading.value).toBe(true);
        pending[1].resolve(snapshot(2));
        await second;
        expect(page.orders.value).toEqual([{ invoice_id: 2 }]);
        expect(page.totalRecords.value).toBe(2);
        expect(page.stats.value.total_revenue).toBe(2);
        expect(page.isLoading.value).toBe(false);

        const older = page.fetchOrders();
        const newer = page.fetchOrders({ silent: true });
        pending[3].resolve(snapshot(4));
        await newer;
        pending[2].resolve(snapshot(3));
        await older;
        expect(page.orders.value).toEqual([{ invoice_id: 4 }]);
        expect(page.isLoading.value).toBe(false);
    });

    it('fetches one snapshot for a quick date selection and one for a manual date change', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(snapshot(1)));
        const page = scope.run(() => Orders.setup());
        page.setDateRange('yesterday');
        await nextTick();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(page.activeQuickDateFilter.value).toBe('yesterday');
        page.startDate.value = '2026-01-01';
        await nextTick();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(page.activeQuickDateFilter.value).toBe(null);
    });

    it('cancels a hidden page read so it cannot repaint cached state', async () => {
        let resolve;
        vi.stubGlobal('fetch', vi.fn(() => new Promise(done => { resolve = done; })));
        const page = scope.run(() => Orders.setup());
        const pending = page.fetchOrders();
        lifecycle.deactivated.forEach(callback => callback());
        resolve(snapshot(99));
        await pending;
        expect(page.orders.value).toEqual([]);
        expect(page.isLoading.value).toBe(false);
    });
});

describe('Order History JoFotara actions', () => {
    const cash = { payment_method: 'cash', invoice_number: 'INV-12', jofotara_status: null };
    const platform = { payment_method: 'platform', invoice_number: 'INV-13', jofotara_status: null };

    it('offers direct submission for standard sales and only a view for accepted platform sales', () => {
        const page = scope.run(() => Orders.setup());
        expect(page.canShowJofotaraInvoiceAction(cash)).toBe(true);
        expect(page.isJofotaraEligible(cash)).toBe(true);
        expect(page.canShowJofotaraInvoiceAction(platform)).toBe(false);
        expect(page.isJofotaraEligible(platform)).toBe(false);
        expect(page.canShowJofotaraInvoiceAction({ ...platform, jofotara_status: 'accepted' })).toBe(true);
        expect(page.jofotaraInvoiceAction({ ...platform, jofotara_status: 'accepted' })).toBe('View QR');
    });

    async function renderSavedRefund(order, refundStatus) {
        const app = createSSRApp({
            ...Orders,
            setup(props, context) {
                const page = Orders.setup(props, context);
                page.jofotaraCurrentOrder.value = order;
                page.jofotaraState.value = { invoice: { status: 'accepted' }, returns: [{ id: 1, amount_refunded: 2, reason: 'Wrong item', document: refundStatus ? { status: refundStatus } : null }] };
                page.showJofotaraModal.value = true;
                return page;
            }
        });
        app.config.globalProperties.$t = key => key;
        const html = await renderToString(app);
        const start = html.indexOf('Saved refunds');
        expect(start, 'saved refunds section rendered').toBeGreaterThan(-1);
        return html.slice(start, html.indexOf('</section>', start)).replace(/<!--[\s\S]*?-->/g, '').replace(/<(\/?\w+)[^>]*>/g, '<$1>');
    }

    it('offers Send return on a saved refund of a standard sale', async () => {
        expect(await renderSavedRefund(cash, null)).toContain('<button>Send return</button>');
    });

    it('never offers Send return on a platform sale refund that is not accepted yet', async () => {
        const html = await renderSavedRefund(platform, null);
        expect(html).not.toContain('Send return');
        expect(html).toContain('Waiting for original');
    });
});
