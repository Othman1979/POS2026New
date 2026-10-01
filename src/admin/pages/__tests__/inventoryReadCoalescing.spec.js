import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';

const hooks = vi.hoisted(() => ({ activated: [], deactivated: [], unmounted: [] }));
const settings = vi.hoisted(() => ({ stock_enabled: '1' }));
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }),
    onMounted: vi.fn(), onActivated: fn => hooks.activated.push(fn),
    onDeactivated: fn => hooks.deactivated.push(fn), onUnmounted: fn => hooks.unmounted.push(fn) }));
const nav = vi.hoisted(() => ({ query: {}, replace: null }));
vi.mock('vue-router', () => ({ useRoute: () => ({ get query() { return nav.query; } }), useRouter: () => ({ replace: (...args) => nav.replace(...args) }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('@/shared/systemSettings.js', () => ({ getSystemSettings: async () => ({ success: true, ...settings }) }));
vi.mock('../../components/ImportModal.vue', () => ({ default: {} }));
vi.mock('../../components/ProductModal.vue', () => ({ default: {} }));
vi.mock('../../components/CategoryModal.vue', () => ({ default: {} }));
vi.mock('../../components/CategoryPriceListModal.vue', () => ({ default: {} }));
vi.mock('../../components/CategoryCopyModal.vue', () => ({ default: {} }));
vi.mock('../../components/BatchProductWorkspace.vue', () => ({ default: {} }));
import Inventory from '../Inventory.vue';

let scope, page, pending, hold, productVersion, categoryVersion;
const flush = async () => { for (let i = 0; i < 8; i++) await nextTick(); };
const calls = prefix => fetch.mock.calls.filter(([url]) => String(url).startsWith(prefix));
const signal = () => window.dispatchEvent(new CustomEvent('inventory_changed'));
function release() { const batch = pending.splice(0); batch.forEach(resolve => resolve()); }

beforeEach(() => {
    Object.values(hooks).forEach(list => { list.length = 0; });
    settings.stock_enabled = '1';
    delete settings.recipe_ledger_enabled;
    nav.query = {}; nav.replace = vi.fn();
    pending = []; hold = false; productVersion = 1; categoryVersion = 1;
    vi.stubGlobal('window', Object.assign(new EventTarget(), { showAdminToast: vi.fn(), showAdminAlert: vi.fn() }));
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    vi.stubGlobal('fetch', vi.fn((url) => {
        const data = String(url).includes('categories')
            ? { success: true, categories: [{ id: categoryVersion, name: `Category ${categoryVersion}` }] }
            : { success: true, products: [{ id: productVersion, name: `Product ${productVersion}` }], pagination: { total: 100, total_pages: 9 } };
        // Deliberately ignore abort to test generation ownership independently of transport.
        return hold ? new Promise(resolve => pending.push(() => resolve({ json: async () => data }))) : Promise.resolve({ json: async () => data });
    }));
    scope = effectScope(); page = scope.run(() => Inventory.setup());
    hooks.activated.forEach(fn => fn());
});
afterEach(() => { hold = false; hooks.unmounted.forEach(fn => fn()); release(); scope.stop(); vi.unstubAllGlobals(); });

describe('Inventory read coalescing and category freshness', () => {
    it.each(['purchases', 'counts'])('opens the %s tab requested by the route and clears the request', async tab => {
        nav.query = { tab };
        hooks.activated.forEach(fn => fn());
        await flush();
        expect(page.activeTab.value).toBe(tab);
        expect(nav.replace).toHaveBeenCalledWith({ name: 'inventory' });
    });
    it.each([['purchases', 'products'], ['counts', 'counts']])('with only the recipe ledger on, a requested %s tab ends on %s', async (tab, expected) => {
        settings.stock_enabled = '0'; settings.recipe_ledger_enabled = '1';
        nav.query = { tab };
        hooks.activated.forEach(fn => fn());
        await vi.waitFor(() => expect(page.recipeLedgerEnabled.value).toBe(true));
        await flush();
        expect(page.stockEnabled.value).toBe(false);
        expect(page.activeTab.value).toBe(expected);
    });
    it('ignores a tab request for any other tab', async () => {
        nav.query = { tab: 'categories' };
        hooks.activated.forEach(fn => fn());
        await flush();
        expect(page.activeTab.value).toBe('products');
    });
    it('reuses categories for product paging but refreshes them for explicit refresh and activation', async () => {
        await page.fetchInventory();
        page.nextPage(); await flush();
        expect(calls('api/admin/products?')).toHaveLength(2);
        expect(calls('api/admin/categories')).toHaveLength(1);
        categoryVersion = 2; await page.fetchInventory();
        expect(page.categories.value[0].id).toBe(2);
        hooks.deactivated.forEach(fn => fn()); categoryVersion = 3;
        hooks.activated.forEach(fn => fn()); await flush();
        expect(page.categories.value[0].id).toBe(3);
    });

    it('collapses a same-tick burst and performs one fresh trailing read for changes during it', async () => {
        await page.fetchInventory(); fetch.mockClear(); hold = true;
        for (let i = 0; i < 10; i++) signal(); await flush();
        expect(calls('api/admin/products?')).toHaveLength(1);
        expect(calls('api/admin/categories')).toHaveLength(1);
        productVersion = 2; categoryVersion = 2;
        for (let i = 0; i < 10; i++) signal();
        release(); await flush();
        expect(calls('api/admin/products?')).toHaveLength(2);
        expect(calls('api/admin/categories')).toHaveLength(2);
        release(); await flush();
        expect(page.products.value[0].id).toBe(2);
        expect(page.categories.value[0].id).toBe(2);
    });

    it('preserves category invalidation when a newer user filter supersedes a full refresh', async () => {
        await page.fetchInventory(); hold = true;
        categoryVersion = 2; const older = page.fetchInventory();
        const oldBatch = pending.splice(0);
        categoryVersion = 3; productVersion = 3; page.statusFilter.value = 'active'; await flush();
        release(); await flush(); oldBatch.forEach(fn => fn()); await older; await flush();
        expect(page.categories.value[0].id).toBe(3);
        expect(page.products.value[0].id).toBe(3);
    });

    it('reconciles a settings event before painting products from an obsolete stock filter', async () => {
        fetch.mockImplementation((url) => {
            const value = String(url);
            if (value.includes('categories')) {
                return Promise.resolve({ json: async () => ({ success: true, categories: [] }) });
            }
            const params = new URL(value, 'http://pos.test').searchParams;
            const products = params.has('stock_status') ? [{ id: 10 }] : [{ id: 1 }, { id: 2 }];
            return Promise.resolve({ json: async () => ({
                success: true,
                products,
                pagination: { total: products.length, total_pages: 1 }
            }) });
        });
        await page.fetchInventory();
        page.stockFilter.value = 'low';
        await flush();
        expect(page.stockFilter.value).toBe('low');
        expect(page.products.value).toEqual([{ id: 10 }]);

        settings.stock_enabled = '0';
        window.dispatchEvent(new CustomEvent('settings_changed'));
        await vi.waitFor(() => expect(page.products.value).toEqual([{ id: 1 }, { id: 2 }]));

        expect(page.stockEnabled.value).toBe(false);
        expect(page.activeTab.value).toBe('products');
        expect(page.stockFilter.value).toBe('all');
        const productRequests = calls('api/admin/products?');
        expect(new URL(productRequests.at(-2)[0], 'http://pos.test').searchParams.get('stock_status')).toBe('low');
        expect(new URL(productRequests.at(-1)[0], 'http://pos.test').searchParams.has('stock_status')).toBe(false);
    });

    it('cancels hidden-page reads and ignores late responses and queued signals', async () => {
        await page.fetchInventory(); hold = true; productVersion = 2;
        const late = page.fetchInventory(); signal();
        const activeOptions = calls('api/admin/products?').at(-1)[1];
        hooks.deactivated.forEach(fn => fn());
        expect(activeOptions?.signal?.aborted).toBe(true);
        release(); await late; await flush();
        expect(page.products.value[0].id).toBe(1);
        expect(page.isLoading.value).toBe(false);
        expect(calls('api/admin/products?')).toHaveLength(2);
    });
});
