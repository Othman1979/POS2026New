import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, effectScope, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('vue', async importOriginal => ({
    ...await importOriginal(),
    useSSRContext: () => ({ modules: new Set() }),
    onMounted: vi.fn(), onActivated: vi.fn(), onDeactivated: vi.fn(), onUnmounted: vi.fn()
}));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('../../components/ImportModal.vue', () => ({ default: {} }));
vi.mock('../../components/ProductModal.vue', () => ({ default: {} }));
vi.mock('../../components/CategoryModal.vue', () => ({ default: {} }));
vi.mock('../../components/CategoryPriceListModal.vue', () => ({ default: {} }));
vi.mock('../../components/CategoryCopyModal.vue', () => ({ default: {} }));
vi.mock('../../components/BatchProductWorkspace.vue', () => ({ default: {} }));
import Inventory from '../Inventory.vue';
import { invalidateSystemSettings } from '@/shared/systemSettings.js';

let scope;
beforeEach(() => {
    scope = effectScope(); invalidateSystemSettings();
    const storage = new Map();
    vi.stubGlobal('sessionStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) });
    vi.stubGlobal('window', { showAdminToast: vi.fn(), showAdminAlert: vi.fn() });
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });

describe('Inventory settings reconciliation', () => {
    it.each(['products', 'purchases', 'counts', 'stock-items'])('removes obsolete stock filtering from %s when stock management is disabled', async tab => {
        let stockEnabled = '1';
        vi.stubGlobal('fetch', vi.fn(async url => ({ json: async () => {
            if (url === 'api/system/settings') return { success: true, stock_enabled: stockEnabled };
            if (url === 'api/admin/categories') return { success: true, categories: [] };
            const params = new URL(url, 'http://pos.test').searchParams;
            return { success: true, products: params.has('stock_status') ? [{ id: 1 }] : [{ id: 1 }, { id: 2 }] };
        } })));
        const page = scope.run(() => Inventory.setup());
        await page.fetchInventory();
        page.activeTab.value = tab;
        page.stockFilter.value = 'low';
        await nextTick();
        await page.fetchInventory();
        await vi.waitFor(() => expect(page.products.value).toHaveLength(1));

        stockEnabled = '0';
        invalidateSystemSettings();
        await page.fetchInventory();
        await vi.waitFor(() => expect(page.products.value).toHaveLength(2));
        expect(page.activeTab.value).toBe('products');
        expect(page.stockEnabled.value).toBe(false);
        expect(page.stockFilter.value).toBe('all');
        expect(page.hasActiveFilters.value).toBe(false);
        const requests = fetch.mock.calls.filter(([url]) => String(url).startsWith('api/admin/products?'));
        expect(new URL(requests.at(-1)[0], 'http://pos.test').searchParams.has('stock_status')).toBe(false);
    });
    it.each(['counts', 'stock-items'])('keeps the %s tab when only the recipe ledger is enabled', async tab => {
        vi.stubGlobal('fetch', vi.fn(async url => ({ json: async () => {
            if (url === 'api/system/settings') return { success: true, stock_enabled: '0', recipe_ledger_enabled: '1' };
            if (url === 'api/admin/categories') return { success: true, categories: [] };
            return { success: true, products: [{ id: 1 }] };
        } })));
        const page = scope.run(() => Inventory.setup());
        await page.fetchInventory();
        page.activeTab.value = tab;
        await nextTick();
        await page.fetchInventory();
        expect(page.stockTabsEnabled.value).toBe(true);
        expect(page.activeTab.value).toBe(tab);
    });
});

describe('Inventory purchase invoices need product stock', () => {
    const settingsFetch = (settings) => vi.stubGlobal('fetch', vi.fn(async url => ({ json: async () => {
        if (url === 'api/system/settings') return { success: true, ...settings };
        if (url === 'api/admin/categories') return { success: true, categories: [] };
        return { success: true, products: [{ id: 1 }] };
    } })));
    // The real toolbar around the loaded settings (the SSR build shows what the page offers, not clicks).
    const toolbar = async (settings) => {
        settingsFetch(settings);
        const page = scope.run(() => Inventory.setup());
        await page.fetchInventory();
        const app = createSSRApp({ ...Inventory, setup: () => page });
        app.config.globalProperties.$t = key => key;
        return renderToString(app);
    };

    it('drops the purchases tab and button when only the recipe ledger is on, but keeps stock levels and counts', async () => {
        settingsFetch({ stock_enabled: '0', recipe_ledger_enabled: '1' });
        const page = scope.run(() => Inventory.setup());
        await page.fetchInventory();
        page.activeTab.value = 'purchases';
        await nextTick();
        await page.fetchInventory();
        await vi.waitFor(() => expect(page.activeTab.value).toBe('products'));

        const html = await toolbar({ stock_enabled: '0', recipe_ledger_enabled: '1' });
        expect(html).toContain('Stock counts');
        expect(html).toContain('Stock levels');
        expect(html).not.toContain('Purchase invoices');
    });

    it('keeps a purchase invoice or count with unsaved work open when settings turn its tab off', async () => {
        settingsFetch({ stock_enabled: '0', recipe_ledger_enabled: '0' });
        const page = scope.run(() => Inventory.setup());
        await page.fetchInventory();
        for (const [tab, holder] of [['purchases', page.purchasesTab], ['counts', page.countsTab]]) {
            page.activeTab.value = tab;
            holder.value = { unsaved: true, confirmDiscard: vi.fn() };
            await nextTick();
            await page.fetchInventory();
            expect(page.activeTab.value).toBe(tab);
            holder.value = { unsaved: false, confirmDiscard: vi.fn() };
            await page.fetchInventory();
            await vi.waitFor(() => expect(page.activeTab.value).toBe('products'));
        }
    });

    it('offers the purchases tab when product stock is on', async () => {
        const html = await toolbar({ stock_enabled: '1' });
        expect(html).toContain('Purchase invoices');
        expect(html).toContain('Stock counts');
    });
});
