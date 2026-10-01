import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@vue/compiler-sfc';
import { parse as parseScript } from '@babel/parser';
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref, watch } from 'vue';
import { cartDisagreesWithCatalogRows, collectCartCatalogProductIds } from '@/pos/categoryPriceSync.js';

// Run the real PosTerminal recovery code with its network consumers replaced.
const source = parse(readFileSync(resolve('src/components/PosTerminal.vue'), 'utf8')).descriptor.scriptSetup.content;
const wanted = ['priceRefreshRequestId', 'cartPricesStale', 'cartPriceContextKey', 'refreshCartCatalogPrices',
    'heldSummaryFailed', 'heldSummaryRequest', 'heldSummarySeq', 'fetchHeldOrderSummary', 'retryFailedReads', 'handleWindowFocus'];
const body = parseScript(source, { sourceType: 'module' }).program.body
    .filter(node => node.declarations?.some(d => wanted.includes(d.id.name)))
    .map(node => source.slice(node.start, node.end)).join('\n');
const deps = ['isActive', 'products', 'tables', 'canLoadTableWorkspace', 'salesContext', 'activeTable', 'cartItems',
    'collectCartCatalogProductIds', 'chunkProductIds', 'requestedIdsCoverCurrentDraft', 'syncCategoryPrices',
    'schedulePriceRefreshRetry', 't', 'canObserveHeldOrders', 'cart', 'activeHeldCount', 'terminal', 'retryFailedShiftCheck', 'socket',
    'refreshCatalogAndCart', 'reconcileOpeningShiftReference', 'dismissActiveQrDraft'];
const build = new Function(...deps, `${body}\nreturn { refreshCartCatalogPrices, fetchHeldOrderSummary, retryFailedReads, handleWindowFocus };`);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function harness() {
    const ok = products => ({ response: { ok: true }, data: { success: true, products } });
    const d = {
        isActive: { value: true },
        products: { retryFailedCatalog: vi.fn(), resolveCategoryPrices: vi.fn() },
        tables: { tableWorkspaceLoadFailed: { value: false }, isTableWorkspaceLoading: { value: false }, loadTableWorkspace: vi.fn() },
        canLoadTableWorkspace: () => true,
        salesContext: { value: 'register' },
        activeTable: { value: null },
        dismissActiveQrDraft: vi.fn(),
        cartItems: { value: [{ product_id: 7, price: 1 }] },
        collectCartCatalogProductIds: items => items.map(item => item.product_id),
        chunkProductIds: ids => [ids],
        requestedIdsCoverCurrentDraft: () => true,
        syncCategoryPrices: vi.fn((items, rows) => { for (const row of rows) items.find(i => i.product_id === row.id).price = row.price; return { repairedNoteSelections: 0 }; }),
        schedulePriceRefreshRetry: vi.fn(),
        t: key => key,
        canObserveHeldOrders: () => true,
        cart: { getHeldOrdersSummary: vi.fn(), probePendingCheckout: vi.fn() },
        activeHeldCount: { value: 0 },
        terminal: { retryFailedSettings: vi.fn(), loadSettings: vi.fn() },
        retryFailedShiftCheck: vi.fn(),
        socket: { value: { connected: true } },
        refreshCatalogAndCart: vi.fn(),
        reconcileOpeningShiftReference: vi.fn(),
    };
    return { d, ok, fns: build(...deps.map(name => d[name])) };
}

describe('PosTerminal failed-read recovery', () => {
    it('sends no request on a heartbeat while every read is healthy', async () => {
        const { d, ok, fns } = harness();
        d.products.resolveCategoryPrices.mockResolvedValue(ok([{ id: 7, price: 2 }]));
        d.cart.getHeldOrdersSummary.mockResolvedValue({ response: { ok: true }, data: { success: true, active_register_count: 1 } });
        await fns.refreshCartCatalogPrices();
        await fns.fetchHeldOrderSummary();
        d.products.resolveCategoryPrices.mockClear();
        d.cart.getHeldOrdersSummary.mockClear();
        fns.retryFailedReads();
        await flush();
        expect(d.products.resolveCategoryPrices).not.toHaveBeenCalled();
        expect(d.cart.getHeldOrdersSummary).not.toHaveBeenCalled();
        expect(d.tables.loadTableWorkspace).not.toHaveBeenCalled();
        expect(d.products.retryFailedCatalog).toHaveBeenCalledOnce(); // itself a no-op while healthy
    });

    it('updates a stale cart price on the next heartbeat after the refresh failed', async () => {
        const { d, ok, fns } = harness();
        d.products.resolveCategoryPrices.mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(ok([{ id: 7, price: 2 }]));
        await fns.refreshCartCatalogPrices();
        expect(d.cartItems.value[0].price).toBe(1);
        fns.retryFailedReads();
        await flush();
        expect(d.cartItems.value[0].price).toBe(2);
        fns.retryFailedReads();
        await flush();
        expect(d.products.resolveCategoryPrices).toHaveBeenCalledTimes(2);
    });

    it('drops a stale-price failure without a request once the context changes or the cart empties', async () => {
        const { d, fns } = harness();
        d.products.resolveCategoryPrices.mockRejectedValue(new TypeError('Failed to fetch'));
        await fns.refreshCartCatalogPrices();
        d.activeTable.value = { id: 3 };
        fns.retryFailedReads();
        fns.retryFailedReads();
        await flush();
        expect(d.products.resolveCategoryPrices).toHaveBeenCalledOnce();
        // The heartbeat also retries an unconfirmed QR draft dismiss (a no-op while none is pending).
        expect(d.dismissActiveQrDraft).toHaveBeenCalledWith(3, { retryImported: true });

        d.activeTable.value = null;
        await fns.refreshCartCatalogPrices();
        d.cartItems.value = [];
        await fns.refreshCartCatalogPrices();
        fns.retryFailedReads();
        await flush();
        expect(d.products.resolveCategoryPrices).toHaveBeenCalledTimes(2);
    });

    it('retries a failed held summary and table workspace on the heartbeat, only while active', async () => {
        const { d, fns } = harness();
        d.cart.getHeldOrdersSummary.mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValue({ response: { ok: true }, data: { success: true, active_register_count: 3 } });
        await fns.fetchHeldOrderSummary();
        d.tables.tableWorkspaceLoadFailed.value = true;
        d.isActive.value = false;
        fns.retryFailedReads();
        await flush();
        expect(d.cart.getHeldOrdersSummary).toHaveBeenCalledOnce();
        expect(d.products.retryFailedCatalog).not.toHaveBeenCalled();
        d.isActive.value = true;
        fns.retryFailedReads();
        await flush();
        expect(d.activeHeldCount.value).toBe(3);
        expect(d.tables.loadTableWorkspace).toHaveBeenCalledWith({ force: true });
    });

    it('coalesces concurrent held-summary reads', async () => {
        const { d, fns } = harness();
        d.cart.getHeldOrdersSummary.mockResolvedValue({ response: { ok: true }, data: { success: true, active_register_count: 1 } });
        await Promise.all([fns.fetchHeldOrderSummary(), fns.fetchHeldOrderSummary()]);
        expect(d.cart.getHeldOrdersSummary).toHaveBeenCalledOnce();
    });

    it('sends no request on window focus while the socket is connected and nothing failed', async () => {
        const { d, fns } = harness();
        await fns.handleWindowFocus();
        await flush();
        expect(d.cart.getHeldOrdersSummary).not.toHaveBeenCalled();
        expect(d.reconcileOpeningShiftReference).not.toHaveBeenCalled();
        expect(d.refreshCatalogAndCart).not.toHaveBeenCalled();
    });

    it('sends none of the settings, catalog, order-type, held or shift reads on focus while the socket is down', async () => {
        const { d, fns } = harness();
        d.socket.value.connected = false;
        d.cart.fetchOrderTypes = vi.fn();
        await fns.handleWindowFocus();
        await flush();
        expect(d.terminal.loadSettings).not.toHaveBeenCalled();
        expect(d.refreshCatalogAndCart).not.toHaveBeenCalled();
        expect(d.cart.fetchOrderTypes).not.toHaveBeenCalled();
        expect(d.reconcileOpeningShiftReference).not.toHaveBeenCalled();
        expect(d.cart.getHeldOrdersSummary).not.toHaveBeenCalled();
    });

    it('still retries a held-summary read that failed when the window regains focus', async () => {
        const { d, fns } = harness();
        d.socket.value.connected = false;
        d.cart.getHeldOrdersSummary.mockResolvedValueOnce({ response: { ok: false }, data: {} })
            .mockResolvedValueOnce({ response: { ok: true }, data: { success: true, active_register_count: 3 } });
        await fns.fetchHeldOrderSummary();
        await fns.handleWindowFocus();
        await flush();
        expect(d.cart.getHeldOrdersSummary).toHaveBeenCalledTimes(2);
        expect(d.activeHeldCount.value).toBe(3);
    });

    it('lets only the newest held-summary response write the badge', async () => {
        const { d, fns } = harness();
        let resolveOld;
        d.cart.getHeldOrdersSummary
            .mockReturnValueOnce(new Promise(r => { resolveOld = r; }))
            .mockResolvedValueOnce({ response: { ok: true }, data: { success: true, active_register_count: 2 } });
        const old = fns.fetchHeldOrderSummary();
        await fns.fetchHeldOrderSummary({ fresh: true });
        resolveOld({ response: { ok: true }, data: { success: true, active_register_count: 1 } });
        await old;
        expect(d.activeHeldCount.value).toBe(2);
    });
});

// Run the real catalog-revalidation watcher against a cart and fresh rows.
const revalidationWatcher = parseScript(source, { sourceType: 'module' }).program.body
    .filter(node => node.type === 'ExpressionStatement' && node.expression.callee?.name === 'watch'
        && source.slice(node.expression.arguments[0].start, node.expression.arguments[0].end) === 'products.catalogRevalidations')
    .map(node => source.slice(node.start, node.end)).join('\n');
const watcherDeps = ['watch', 'isActive', 'products', 'rawProducts', 'cartItems', 'syncCartAvailabilityFromCatalog',
    'refreshCartCatalogPrices', 'cartDisagreesWithCatalogRows', 'collectCartCatalogProductIds'];
const mountWatcher = new Function(...watcherDeps, revalidationWatcher);

describe('PosTerminal catalog revalidation', () => {
    async function revalidate(line, extraRows = [], otherLines = []) {
        const d = {
            watch,
            isActive: ref(true),
            products: { catalogRevalidations: ref(0) },
            rawProducts: ref([{ id: 7, price: 2, tax_rate: 16 }, ...extraRows]),
            cartItems: ref([{ product_id: 7, price: 2, tax_rate: 16, ...line }, ...otherLines]),
            syncCartAvailabilityFromCatalog: vi.fn(),
            refreshCartCatalogPrices: vi.fn(),
            cartDisagreesWithCatalogRows,
            collectCartCatalogProductIds,
        };
        expect(revalidationWatcher).toContain('watch(products.catalogRevalidations');
        mountWatcher(...watcherDeps.map(name => d[name]));
        d.products.catalogRevalidations.value += 1;
        await nextTick();
        expect(d.syncCartAvailabilityFromCatalog).toHaveBeenCalledOnce();
        return d.refreshCartCatalogPrices.mock.calls.length;
    }

    it('sends no price request when the fresh rows confirm the cart', async () => {
        expect(await revalidate({ price: 2.5, modifier_surcharge: 0.5 })).toBe(0);
    });

    it('re-resolves prices when a line was added at a stale base price', async () => {
        expect(await revalidate({ price: 1.5, modifier_surcharge: 0.5 })).toBe(1);
    });

    it('re-resolves prices only when a priced note changes price or name', async () => {
        const line = { price: 3.16, modifier_surcharge: 1.16,
            selectedModifiers: [{ noteProductId: 9, group: 'Extra cheese', option: 'Extra cheese', price: 1.16 }] };
        const note = (price, name = 'Extra cheese') => ({ id: 9, name, price, tax_rate: 16, category_is_notes: 1, category_is_active: 1 });
        expect(await revalidate(line, [note(1)])).toBe(0);
        expect(await revalidate(line, [note(1.5)])).toBe(1);
        expect(await revalidate(line, [note(1, 'Double cheese')])).toBe(1);
    });

    it('re-resolves prices when a cart line has no fresh row to confirm it', async () => {
        // Added from another category whose revalidation was cut short.
        expect(await revalidate({}, [], [{ product_id: 8, price: 2 }])).toBe(1);
    });

    it('leaves a manager-priced line alone even when the catalog price differs', async () => {
        expect(await revalidate({ price: 9, manual_price_override: true })).toBe(0);
    });
});
