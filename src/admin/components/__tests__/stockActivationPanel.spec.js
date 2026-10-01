import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { effectScope, reactive, nextTick } from 'vue';
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }) }));
vi.mock('@/shared/http.js', () => ({ fetchJsonResponse: vi.fn() }));
import Component from '../StockActivationPanel.vue';
import { fetchJsonResponse } from '@/shared/http.js';

const ready = { success: true, active: false, can_activate: true, stock: '10.000000', stock_version: '4', quantity_known: true, blockers: [] };
const active = { ...ready, active: true, can_activate: false, stock_version: '5', stock_item_id: '7' };
const response = (data, status = 200) => ({ response: { ok: status < 400, status }, data });
const flush = async () => { await Promise.resolve(); await nextTick(); };
let scopes, props, state, emit, storage;
function mount(id = 1) {
    const scope = effectScope(); scopes.push(scope);
    props = reactive({ productId: id, stockDirty: false }); emit = vi.fn();
    state = scope.run(() => Component.setup(props, { expose() {}, emit }));
    return scope;
}
beforeEach(() => {
    scopes = []; storage = new Map(); fetchJsonResponse.mockReset();
    vi.stubGlobal('sessionStorage', {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key)
    });
    fetchJsonResponse.mockResolvedValue(response(ready));
});
afterEach(() => { scopes.forEach(scope => scope.stop()); vi.unstubAllGlobals(); });

describe('stock activation recovery', () => {
    it('reuses the durable intent after a lost response and reopening an already active product', async () => {
        const first = mount(); await flush();
        fetchJsonResponse.mockRejectedValueOnce(new TypeError('Connection lost'));
        await state.activate();
        const original = fetchJsonResponse.mock.calls[1][1].body;
        expect(storage.size).toBe(1);
        expect(emit).not.toHaveBeenCalledWith('activated', expect.anything());
        first.stop();
        fetchJsonResponse.mockResolvedValueOnce(response(active));
        mount(); await flush();
        expect(state.state.value.active).toBe(true);
        expect(state.pending.value).toEqual(JSON.parse(original));
        fetchJsonResponse.mockResolvedValueOnce(response({ ...active, replayed: true }));
        await state.activate();
        expect(fetchJsonResponse.mock.calls[3][1].body).toBe(original);
        expect(storage.size).toBe(0);
        expect(emit).toHaveBeenCalledWith('activated', expect.objectContaining({ active: true }));
    });
    it('blocks a fresh activation with unresolved orders or an unsaved stock edit', async () => {
        fetchJsonResponse.mockResolvedValueOnce(response({ ...ready, can_activate: false, blockers: [{ code: 'held_order', message: 'Held order' }] }));
        mount(); await flush(); await state.activate();
        expect(fetchJsonResponse).toHaveBeenCalledTimes(1);
        await state.loadState(); props.stockDirty = true; await state.activate();
        expect(fetchJsonResponse).toHaveBeenCalledTimes(2);
        expect(storage.size).toBe(0);
    });
    it('refreshes the observation after a definite conflict and uses a fresh request key', async () => {
        mount(); await flush();
        fetchJsonResponse.mockResolvedValueOnce(response({ success: false, message: 'Stock changed' }, 409));
        fetchJsonResponse.mockResolvedValueOnce(response({ ...ready, stock_version: '6' }));
        await state.activate();
        const original = JSON.parse(fetchJsonResponse.mock.calls[1][1].body);
        expect(storage.size).toBe(0);
        expect(state.state.value.stock_version).toBe('6');
        fetchJsonResponse.mockResolvedValueOnce(response(active));
        await state.activate();
        const retry = JSON.parse(fetchJsonResponse.mock.calls[3][1].body);
        expect(retry.expected_stock_version).toBe('6');
        expect(retry.request_key).not.toBe(original.request_key);
    });
    it('ignores late preflight results from a different product', async () => {
        let resolveFirst;
        fetchJsonResponse.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
        mount(); props.productId = 2; await flush();
        resolveFirst(response({ ...active, product_id: 1 })); await flush();
        expect(state.state.value.active).toBe(false);
        expect(emit).not.toHaveBeenCalledWith('state', expect.objectContaining({ product_id: 1 }));
    });
    it('sends one request while saving and retains its key for server errors', async () => {
        mount(); await flush();
        let resolveSave;
        fetchJsonResponse.mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; }));
        const save = state.activate(); await state.activate();
        expect(fetchJsonResponse).toHaveBeenCalledTimes(2);
        resolveSave(response({ success: false }, 500)); await save;
        expect(storage.size).toBe(1);
        expect(state.pending.value).not.toBeNull();
        expect(emit).toHaveBeenLastCalledWith('busy', false);
    });
});
