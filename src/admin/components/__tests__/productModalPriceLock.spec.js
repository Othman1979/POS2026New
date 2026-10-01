import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, reactive, nextTick } from 'vue';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn(), fetchJsonResponse: vi.fn() }));
import Component from '../ProductModal.vue';
import { fetchJson } from '@/shared/http.js';
let scope, props, state;
beforeEach(async () => {
    vi.stubGlobal('window', { showAdminToast: vi.fn(), showAdminAlert: vi.fn() });
    fetchJson.mockReset(); fetchJson.mockResolvedValue({ success: true });
    props = reactive({ show: false, product: { id: 1, name: 'Water', price: 2, is_active: 1, price_override_locked: '1' }, initialTab: 'general' });
    scope = effectScope();
    state = scope.run(() => Component.setup(props, { emit: vi.fn() }));
    props.show = true; await nextTick();
});
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); });
describe('product price-override lock in the product editor', () => {
    it('keeps a stored lock when another field of the product is edited', async () => {
        state.productForm.value.name = 'Cold water';
        await state.saveProduct();
        expect(fetchJson).toHaveBeenCalledOnce();
        const body = JSON.parse(fetchJson.mock.calls[0][1].body);
        expect(body.name).toBe('Cold water');
        expect(body.price_override_locked).toBe(1);
    });
});
