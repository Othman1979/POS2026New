import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: vi.fn(), onUnmounted: vi.fn() }));
vi.mock('vue-router', () => ({ onBeforeRouteLeave: vi.fn() }));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn() }));
vi.mock('../ProductRecipeEditor.vue', () => ({ default: {} }));
import Workspace from '../IngredientRecipes.vue';
import { fetchJson } from '@/shared/http.js';
import { onBeforeRouteLeave } from 'vue-router';

let scope, state, emit;
beforeEach(() => {
    scope = effectScope();
    emit = vi.fn();
    fetchJson.mockReset();
    state = scope.run(() => Workspace.setup({}, { expose: () => {}, emit }));
});
afterEach(() => scope.stop());

describe('ingredient recipe workspace', () => {
    it('uses paginated server search and ignores a superseded response', async () => {
        let finishOld;
        fetchJson.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
        const old = state.search(1);
        state.query.value = 'chicken & rice';
        fetchJson.mockResolvedValueOnce({ success: true, products: [{ id: 2, name: 'Chicken' }], pagination: { total_pages: 3 } });
        await state.search(2);
        finishOld({ success: true, products: [{ id: 1 }] });
        await old;
        expect(state.products.value).toEqual([{ id: 2, name: 'Chicken' }]);
        expect(state.page.value).toBe(2);
        expect(state.pages.value).toBe(3);
        const params = new URL(fetchJson.mock.calls[1][0], 'http://localhost/').searchParams;
        expect(params.get('search')).toBe('chicken & rice');
        expect(params.get('limit')).toBe('12');
    });
    it('keeps the current product when unsaved-change dismissal is cancelled', async () => {
        state.selected.value = { id: 2 };
        const requestClose = vi.fn().mockResolvedValue(false);
        state.editor.value = { requestClose };
        await state.changeProduct();
        await state.close();
        expect(state.selected.value).toEqual({ id: 2 });
        expect(emit).not.toHaveBeenCalled();
        expect(await onBeforeRouteLeave.mock.calls.at(-1)[0]()).toBe(false);
        requestClose.mockResolvedValue(true);
        await state.close();
        expect(emit).toHaveBeenCalledWith('close');
    });
    it('shows a failed search without retaining misleading previous results', async () => {
        state.products.value = [{ id: 1 }];
        fetchJson.mockRejectedValueOnce(new Error('Connection lost'));
        await state.search(1);
        expect(state.products.value).toEqual([]);
        expect(state.error.value).toBe('Connection lost');
        expect(state.loading.value).toBe(false);
    });
});
