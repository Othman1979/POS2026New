import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, reactive, nextTick } from 'vue';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onUnmounted: vi.fn() }));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn(), fetchJsonResponse: vi.fn() }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
import Setup from '../IngredientFormModal.vue';
import History from '../IngredientHistoryDrawer.vue';
import { fetchJson, fetchJsonResponse } from '@/shared/http.js';
let scope;
beforeEach(() => {
    scope = effectScope(); vi.clearAllMocks();
    vi.stubGlobal('window', { showAdminConfirm: vi.fn() });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn(), activeElement: null });
    fetchJson.mockResolvedValue({ success: true, rows: [] });
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });
function setup(Component, props) {
    const emit = vi.fn();
    const state = scope.run(() => Component.setup(props, { expose: () => {}, emit }));
    return { state, emit };
}
describe('ingredient setup', () => {
    it('converts cost and packaging along with the stock unit and guards dimensional changes', async () => {
        const props = reactive({ show: false, ingredient: null });
        const { state } = setup(Setup, props); props.show = true; await nextTick();
        Object.assign(state.form.value, { name: 'Flour', unit_cost: '4', par_qty: '2', pack_size: '10', pack_name: 'bag' });
        await state.chooseUnit({ target: { value: 'g' } });
        expect(state.form.value).toMatchObject({ unit_cost: '0.004', par_qty: '2000', pack_size: '10000' });
        window.showAdminConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const event = { target: { value: 'l' } }; await state.chooseUnit(event);
        expect(event.target.value).toBe('g');
        await state.chooseUnit({ target: { value: 'l' } });
        expect(state.form.value).toMatchObject({ measure: 'volume', display_unit: 'l', unit_cost: '', pack_name: '', pack_size: '' });
    });
    it('requires complete packaging, preserves cancelled drafts and returns the created ingredient', async () => {
        const props = reactive({ show: false, ingredient: null });
        const { state, emit } = setup(Setup, props); props.show = true; await nextTick();
        Object.assign(state.form.value, { name: 'Flour', pack_name: 'bag' });
        await state.save(); expect(fetchJson).not.toHaveBeenCalled();
        window.showAdminConfirm.mockResolvedValue(false); await state.close(); expect(emit).not.toHaveBeenCalled();
        state.form.value.pack_size = 10;
        const ingredient = { id: 7, name: 'Flour', display_unit: 'kg', is_active: true };
        fetchJson.mockResolvedValue({ success: true, ingredient }); await state.save();
        expect(emit).toHaveBeenCalledWith('saved', ingredient);
        expect(JSON.parse(fetchJson.mock.calls[0][1].body)).toMatchObject({ pack_size: 10, pack_unit: 'kg' });
    });
    it('blocks save and close while quantity-ledger activation is in progress', async () => {
        const props = reactive({ show: true, ingredient: { id: 7, name: 'Flour', measure: 'weight', display_unit: 'kg', is_active: true } });
        const { state, emit } = setup(Setup, props);
        state.activating.value = true;
        await state.save();
        await state.close();
        expect(fetchJson).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
    });
});
describe('history corrections', () => {
    it('retries an uncertain correction with the same key and payload and refreshes after confirmation', async () => {
        const { state, emit } = setup(History, { show: true, ingredient: { id: 7, display_unit: 'kg' } });
        state.startCorrection({ id: 14, kind: 'receipt', qty: 5000 });
        state.correctionQty.value = 3; state.correctionNote.value = 'Wrong quantity';
        expect(state.correctionDelta.value).toBe('-2 kg');
        fetchJsonResponse.mockRejectedValueOnce(new Error('Connection lost'));
        await state.saveCorrection(); expect(state.correctionUncertain.value).toBe(true);
        expect(emit).not.toHaveBeenCalled();
        fetchJsonResponse.mockResolvedValueOnce({ response: { ok: true, status: 200 }, data: { success: true, replay: true } });
        await state.saveCorrection();
        expect(fetchJsonResponse.mock.calls[1]).toEqual(fetchJsonResponse.mock.calls[0]);
        expect(emit).toHaveBeenCalledWith('changed'); expect(state.correctionTarget.value).toBeNull();
    });
    it('requires a reason, guards discarded drafts and prevents correcting an already corrected entry', async () => {
        const { state } = setup(History, { show: true, ingredient: { id: 7, display_unit: 'kg' } });
        expect(state.canCorrect({ id: 1, kind: 'receipt', corrected_by_id: 99 })).toBe(false);
        expect(state.canCorrect({ id: 2, kind: 'count' })).toBe(false);
        state.startCorrection({ id: 3, kind: 'waste', qty: -2000 }); state.correctionQty.value = 0;
        expect(state.correctionDelta.value).toBe('2 kg');
        await state.saveCorrection(); expect(fetchJsonResponse).not.toHaveBeenCalled();
        window.showAdminConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        expect(await state.closeCorrection()).toBe(false); expect(state.correctionTarget.value.id).toBe(3);
        expect(await state.closeCorrection()).toBe(true); expect(state.correctionTarget.value).toBeNull();
    });
});
