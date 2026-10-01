import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, reactive, nextTick } from 'vue';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn(), fetchJsonResponse: vi.fn() }));
import Component from '../ProductModal.vue';
import { fetchJson } from '@/shared/http.js';
let scope, props, state, emit;
beforeEach(async () => {
    vi.stubGlobal('window', { showAdminToast: vi.fn(), showAdminAlert: vi.fn() });
    fetchJson.mockReset(); fetchJson.mockResolvedValue({ success: true });
    props = reactive({ show: false, product: { id: 1, name: 'Water', stock: '10.000000', stock_version: '4', price: 2, is_active: 1 }, initialTab: 'general' });
    scope = effectScope(); emit = vi.fn();
    state = scope.run(() => Component.setup(props, { emit }));
    props.show = true; await nextTick();
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });
describe('product editing after stock activation', () => {
    it('preserves unsaved catalog edits while making tracked quantity read-only in the save payload', async () => {
        state.productForm.value.name = 'Cold water';
        state.onStockState({ active: true, stock: '8.000000', stock_version: '5' });
        await state.saveProduct();
        const body = JSON.parse(fetchJson.mock.calls[0][1].body);
        expect(body.name).toBe('Cold water');
        expect(body).not.toHaveProperty('stock');
        expect(state.productForm.value.expected_stock_version).toBe('5');
    });
    it('keeps the modal stable during activation and rejects switching to a competing recipe authority', async () => {
        state.stockActivationBusy.value = true;
        await state.requestClose(); await state.saveProduct(); await state.selectTab('modifiers'); state.emitOpenStock();
        expect(emit).not.toHaveBeenCalled(); expect(fetchJson).not.toHaveBeenCalled();
        expect(state.productModalTab.value).toBe('general');
        state.stockActivationBusy.value = false;
        state.onStockState({ active: true, stock: null, stock_version: '5' });
        await state.selectTab('recipe'); expect(state.productModalTab.value).toBe('general');
        state.emitOpenStock(); expect(emit).toHaveBeenCalledWith('open-stock', 1);
    });
    it('detects an unsaved quantity change without treating an unknown balance as zero', () => {
        expect(state.stockDirty.value).toBe(false);
        state.productForm.value.stock = '0'; expect(state.stockDirty.value).toBe(true);
        state.onStockState({ active: true, stock: null, stock_version: '5' });
        expect(state.productForm.value.stock).toBe('');
        expect(state.stockDirty.value).toBe(false);
    });
});
