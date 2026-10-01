import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, effectScope } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: vi.fn(), onActivated: vi.fn(), onDeactivated: vi.fn(), onBeforeUnmount: vi.fn() }));
vi.mock('vue-router', () => ({ onBeforeRouteLeave: vi.fn() }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: { value: 'en' } }));
vi.mock('@/utils/businessDate.js', () => ({ currentBusinessDate: () => '2026-10-01' }));
vi.mock('../purchases/purchasesApi.js', () => ({
    describeError: error => error.message,
    purchasesApi: {
        listSuppliers: vi.fn(), listInvoices: vi.fn(), listCategories: vi.fn(), searchItems: vi.fn(), lastInvoice: vi.fn(), getInvoice: vi.fn(),
    },
}));
import Tab from '../purchases/PurchaseInvoicesTab.vue';
import { purchasesApi } from '../purchases/purchasesApi.js';

let scope;
beforeEach(() => {
    Object.values(purchasesApi).forEach(fn => fn.mockReset());
    purchasesApi.listSuppliers.mockResolvedValue([]);
    purchasesApi.listInvoices.mockResolvedValue({ invoices: [], nextBeforeId: null, nextBeforeGroup: null });
    scope = effectScope();
});
afterEach(() => scope.stop());

describe('purchase invoices tab kind', () => {
    it.each(['product', 'ingredient'])('lists only %s invoices, on the first read, after a filter change and when paging', async kind => {
        const tab = scope.run(() => Tab.setup({ itemKind: kind }, { expose: () => {} }));
        await tab.loadInvoices(true);
        tab.filters.status = 'draft';
        await tab.loadInvoices(true);
        tab.nextBeforeId.value = 12;
        await tab.loadInvoices(false);
        const calls = purchasesApi.listInvoices.mock.calls.map(([params]) => params);
        expect(calls).toHaveLength(3);
        expect(calls.every(params => params.kind === kind)).toBe(true);
        expect(calls[1]).toMatchObject({ status: 'draft' });
        expect(calls[2]).toMatchObject({ beforeId: 12 });
    });
});

describe('purchase invoices tab hands its kind to the editor', () => {
    const render = async (itemKind) => {
        const app = createSSRApp(Tab, { itemKind });
        app.config.globalProperties.$t = key => key;
        return renderToString(app);
    };

    it('offers the category picker on the product tab only', async () => {
        expect(await render('product')).toContain('Add category');
        expect(await render('ingredient')).not.toContain('Add category');
    });
});

describe('purchase invoices tab open work', () => {
    it('reports an unsaved invoice and a save or post in flight, so a settings change keeps the tab open', () => {
        let exposed;
        const tab = scope.run(() => Tab.setup({ itemKind: 'product' }, { expose: value => { exposed = value; } }));
        expect(exposed.unsaved.value).toBe(false);
        tab.editorRef.value = { unsaved: false, busy: true };
        expect(exposed.unsaved.value).toBe(true);
        tab.editorRef.value = { unsaved: true, busy: false };
        expect(exposed.unsaved.value).toBe(true);
        tab.editorRef.value = { unsaved: false, busy: false };
        expect(exposed.unsaved.value).toBe(false);
    });
});
