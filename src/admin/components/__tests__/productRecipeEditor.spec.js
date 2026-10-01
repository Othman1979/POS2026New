import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onUnmounted: vi.fn() }));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn() }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
import Editor from '../ProductRecipeEditor.vue';
import { fetchJson } from '@/shared/http.js';

let scope;
let persisted;
let state;
beforeEach(async () => {
    scope = effectScope();
    persisted = [];
    fetchJson.mockReset();
    fetchJson.mockImplementation(async (url, options) => {
        if (url.endsWith('/options')) return { success: true, ingredients: [{ id: 7, name: 'Chicken', measure: 'weight', display_unit: 'kg', is_active: true }] };
        if (url.includes('/portions')) return { success: true, portions: [] };
        if (options?.method === 'PUT') { persisted = JSON.parse(options.body).lines; return { success: true }; }
        return { success: true, lines: persisted.map(line => ({ ...line, name: 'Chicken', measure: 'weight' })), price: 3 };
    });
    state = scope.run(() => Editor.setup({ productId: 12, price: 3, isBundle: false }, { expose: () => {} }));
    await vi.waitFor(() => expect(state.loaded.value).toBe(true));
    vi.stubGlobal('window', { showAdminConfirm: vi.fn() });
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });

describe('product recipe editing', () => {
    it('keeps inactive recipe lines until the operator explicitly removes them', async () => {
        persisted = [
            { ingredient_id: 7, qty: 100, unit: 'g', is_active: true },
            { ingredient_id: 8, qty: 20, unit: 'g', is_active: false }
        ];
        await state.load();
        expect(state.lines.value.map(line => line.ingredient_id)).toEqual([7, 8]);
        state.lines.value[0].qty = 150;
        await state.save();
        expect(fetchJson.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
        expect(persisted).toHaveLength(2);
        state.lines.value.splice(1, 1);
        await state.save();
        expect(persisted).toEqual([{ ingredient_id: 7, qty: 150, unit: 'g' }]);
    });
    it('converts a served portion to stock demand once and preserves its yield when changing units', async () => {
        state.pickerId.value=7;state.addLine();const line=state.lines.value[0];
        line.qty=0.1;line.yield_pct=80;
        expect(state.stockQuantity(line)).toBe(0.125);
        state.changeLineUnit(line,'g');expect(state.stockQuantity(line)).toBe(125);
        expect(state.serializeLines()).toEqual([{ingredient_id:7,qty:100,unit:'g',yield_pct:80}]);
        line.yield_pct=0;await state.save();expect(fetchJson.mock.calls.some(([,options])=>options?.method==='PUT')).toBe(false);
    });
    it('converts units without changing consumption and previews portions without changing the recipe', () => {
        state.pickerId.value = 7; state.addLine();
        const line = state.lines.value[0]; line.qty = 0.15;
        state.changeLineUnit(line, 'g');
        expect(line.qty).toBe(150);
        state.previewPortions.value = 4;
        expect(state.previewQuantity(line.qty)).toBe('600');
        expect(state.serializeLines()).toEqual([{ ingredient_id: 7, qty: 150, unit: 'g' }]);
        state.changeLineUnit(line, 'ml');
        expect(line.unit).toBe('g');
        state.changeLineUnit(line, 'kg');
        expect(line.qty).toBe(0.15);
    });
    it('adds a newly created ingredient while preserving existing recipe drafts', () => {
        state.pickerId.value = 7; state.addLine(); state.lines.value[0].qty = 0.15;
        state.ingredientSearch.value = 'missing';
        state.ingredientCreated({ id: 8, name: 'Oil', measure: 'volume', display_unit: 'l', is_active: true });
        expect(state.lines.value).toMatchObject([{ ingredient_id: 7, qty: 0.15 }, { ingredient_id: 8, qty: '', unit: 'l' }]);
        expect(state.availableIngredients.value).toEqual([]);
        expect(persisted).toEqual([]);
    });
    it('rejects blank quantities and persists a valid quantity with its selected unit', async () => {
        state.pickerId.value = 7;
        state.addLine();
        await state.save();
        expect(state.error.value).toBe('Recipe quantity must be greater than zero.');
        expect(fetchJson.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
        state.lines.value[0].qty = 150;
        state.lines.value[0].unit = 'g';
        await state.save();
        expect(persisted).toEqual([{ ingredient_id: 7, qty: 150, unit: 'g' }]);
        expect(state.hasChanges.value).toBe(false);
        expect(state.saved.value).toBe(true);
    });
    it('retains unsaved work when discard is cancelled and restores saved lines when confirmed', async () => {
        state.pickerId.value = 7;
        state.addLine();
        window.showAdminConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        expect(await state.requestClose()).toBe(false);
        expect(state.lines.value).toHaveLength(1);
        expect(await state.requestClose()).toBe(true);
        expect(state.lines.value).toHaveLength(0);
    });
    it('keeps edited quantities after a failed save without claiming success', async () => {
        state.pickerId.value = 7;
        state.addLine();
        state.lines.value[0].qty = 0.15;
        fetchJson.mockRejectedValueOnce(new Error('Connection lost'));
        await state.save();
        expect(state.error.value).toBe('Connection lost');
        expect(state.lines.value[0].qty).toBe(0.15);
        expect(state.hasChanges.value).toBe(true);
        expect(state.saved.value).toBe(false);
    });
});
