import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, effectScope } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('../purchases/purchasesApi.js', () => ({
    describeError: error => error.message,
    purchasesApi: { searchItems: vi.fn() },
}));
import Combobox from '../purchases/PurchaseItemCombobox.vue';
import { purchasesApi } from '../purchases/purchasesApi.js';

const cola = { item_key: 'product:1', name: 'Cola', base_unit: 'unit', barcode: '111', starts_tracking: true };
const tea = { item_key: 'product:2', name: 'Tea', base_unit: 'unit', barcode: null, starts_tracking: false };

let scope;
beforeEach(() => { purchasesApi.searchItems.mockReset(); scope = effectScope(); });
afterEach(() => scope.stop());

const makeCombobox = (itemKind) => scope.run(() => Combobox.setup({ itemKind, item: null, rowIndex: 0, supplierId: 7 }, { expose: () => {}, emit: () => {} }));

// The real template with the dropdown open on the given results.
async function renderOpen(itemKind, results) {
    const app = createSSRApp({
        ...Combobox,
        setup(props, ctx) { const bindings = Combobox.setup(props, ctx); bindings.results.value = results; bindings.open.value = true; return bindings; },
    }, { itemKind, rowIndex: 0 });
    app.config.globalProperties.$t = key => key;
    return renderToString(app);
}
const optionOf = (html, name) => html.split('<li').find(part => part.includes(`>${name}<`)) || '';

describe('purchase item search', () => {
    it.each(['product', 'ingredient'])('searches %s items only, by name and by barcode', async kind => {
        purchasesApi.searchItems.mockResolvedValue([]);
        const combobox = makeCombobox(kind);
        combobox.text.value = 'mil';
        await combobox.search('mil');
        combobox.text.value = '6281';
        await combobox.submitTyped();
        const calls = purchasesApi.searchItems.mock.calls.map(([params]) => params);
        expect(calls.length).toBe(3);
        expect(calls.every(params => params.kind === kind && params.supplierId === 7)).toBe(true);
        expect(calls.map(params => params.barcode ?? params.q)).toEqual(['mil', '6281', '6281']);
    });
});

describe('choosing a search result', () => {
    const emitted = [];
    const pick = (typed, entry) => {
        emitted.length = 0;
        const combobox = scope.run(() => Combobox.setup({ itemKind: 'product', item: null, rowIndex: 0, supplierId: 7 }, { expose: () => {}, emit: (...args) => emitted.push(args) }));
        combobox.text.value = typed;
        combobox.choose(entry);
        return combobox;
    };
    const withExtra = { ...cola, matched_barcode: '999' };

    it('treats a result found by an extra barcode as a scan', () => {
        const combobox = pick('999', withExtra);
        expect(emitted).toEqual([['scan', withExtra]]);
        expect(combobox.text.value).toBe('');
    });

    it('treats a result found by the main barcode as a scan', () => {
        pick('111', { ...cola, matched_barcode: '111' });
        expect(emitted.map(([name]) => name)).toEqual(['scan']);
    });

    it('still scans when an older response carries no matched barcode', () => {
        pick('111', cola);
        expect(emitted.map(([name]) => name)).toEqual(['scan']);
    });

    it('compares ignoring letter case, as the database does', () => {
        pick('ab-1', { ...cola, barcode: 'AB-1', matched_barcode: 'AB-1' });
        expect(emitted.map(([name]) => name)).toEqual(['scan']);
    });

    it('picks, not scans, a result found by name', () => {
        const combobox = pick('col', { ...cola, matched_barcode: null });
        expect(emitted).toEqual([['pick', { ...cola, matched_barcode: null }]]);
        expect(combobox.text.value).toBe('Cola');
    });

    it('picks when the typed text has moved on from the matched barcode', () => {
        pick('9999', withExtra);
        expect(emitted.map(([name]) => name)).toEqual(['pick']);
    });

    it('shows the barcode that matched next to the item', async () => {
        const html = await renderOpen('product', [withExtra, tea]);
        expect(optionOf(html, 'Cola')).toContain('999');
        expect(optionOf(html, 'Cola')).not.toContain('111');
    });
});

describe('starts-tracking tag in the item results', () => {
    it('marks only the items whose stock starts being tracked', async () => {
        const html = await renderOpen('product', [cola, tea]);
        expect(html.match(/class="pi-track"/g)).toHaveLength(1);
        expect(optionOf(html, 'Cola')).toContain('Starts stock tracking');
        expect(optionOf(html, 'Cola')).toContain('Stock is unlimited now. Receiving it starts counting its stock.');
        expect(optionOf(html, 'Tea')).not.toContain('Starts stock tracking');
    });

    it('shows no tag when no result starts tracking', async () => {
        expect(await renderOpen('ingredient', [tea])).not.toContain('pi-track');
    });
});
