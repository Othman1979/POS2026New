import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';

vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: vi.fn(), onUnmounted: vi.fn() }));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn() }));
import List from '../StockWorkingList.vue';
import { fetchJson } from '@/shared/http.js';

let scope, state;
const page = (items, extra = {}) => ({ success: true, items, next_cursor: extra.next_cursor || null });

beforeEach(() => {
    fetchJson.mockReset();
    scope = effectScope();
    state = scope.run(() => List.setup({}, { expose: () => {} }));
});
afterEach(() => {
    scope.stop();
    vi.clearAllTimers();
});

describe('bounded stock working list', () => {
    it('loads the first page with barcode and attention', async () => {
        fetchJson.mockResolvedValue(page([{
            id: '1', name: 'Flour', barcode: '123', attention: 'unknown', quantity_known: false, quantity: null
        }]));
        await state.load(true);
        expect(fetchJson).toHaveBeenCalledWith('api/admin/stock/items?limit=50&kind=all');
        expect(state.items.value[0].barcode).toBe('123');
        expect(state.unitLabel('g')).toBe('Grams');
        expect(state.formatQuantity('9999999999.999999')).toBe('9999999999.999999');
        expect(state.formatQuantity('10.000000')).toBe('10');
        expect(state.formatQuantity('-2.500000')).toBe('-2.5');
        expect(state.formatQuantity('100.000000')).toBe('100');
        expect(state.items.value[0].attention).toBe('unknown');
        expect(state.attentionLabel('unknown')).toBe('Not counted yet');
        expect(state.attentionLabel('low')).toBe('Low');
        expect(state.attentionLabel('negative')).toBe('Out or below zero');
    });

    it('debounces barcode search and pages with the same filter identity', async () => {
        vi.useFakeTimers();
        fetchJson.mockResolvedValue(page([{ id: '1', name: 'Flour', barcode: 'ABC-1', attention: 'ok', quantity_known: true, quantity: '2.000000' }], { next_cursor: 'cursor-1' }));
        await state.load(true);
        state.search.value = 'ABC';
        await nextTick();
        await vi.advanceTimersByTimeAsync(299);
        expect(fetchJson).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchJson).toHaveBeenCalledWith('api/admin/stock/items?limit=50&kind=all&q=ABC');
        fetchJson.mockResolvedValue(page([{ id: '2', name: 'Yeast', barcode: 'ABC-2', attention: 'ok', quantity_known: true, quantity: '1.000000' }]));
        await state.loadMore();
        expect(fetchJson.mock.calls.at(-1)[0]).toBe('api/admin/stock/items?limit=50&kind=all&q=ABC&cursor=cursor-1');
        expect(state.items.value.map(item => item.id)).toEqual(['1', '2']);
        vi.useRealTimers();
    });

    it('keeps a venue category named like a dictionary key untranslated', async () => {
        const { createSSRApp } = await import('vue');
        const { renderToString } = await import('vue/server-renderer');
        const rows = [
            { item_key: 'product:1', kind: 'product', name: 'Cola', group_label: 'Products', attention: 'ok', quantity_known: true, quantity: '1.000000', base_unit: 'unit' },
            { item_key: 'ingredient:2', kind: 'ingredient', name: 'Flour', group_label: 'Ingredients', attention: 'ok', quantity_known: true, quantity: '1.000000', base_unit: 'g' },
            { item_key: 'product:3', kind: 'product', name: 'Gum', group_label: 'Other items', attention: 'ok', quantity_known: true, quantity: '1.000000', base_unit: 'unit' },
        ];
        const app = createSSRApp({
            ...List,
            setup(props, ctx) { const bindings = List.setup(props, ctx); bindings.items.value = rows; return bindings; },
        });
        app.config.globalProperties.$t = key => `AR(${key})`;
        const html = await renderToString(app);
        const small = [...html.matchAll(/<small[^>]*>([^<]*)<\/small>/g)].map(match => match[1]);
        expect(small).toEqual(['Products', 'AR(Ingredients)', 'AR(Other items)']);
    });
});
