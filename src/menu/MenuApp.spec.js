import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';

const mounted = [];
vi.mock('vue', async original => ({
    ...await original(),
    onMounted: cb => { mounted.push(cb); },
    onUnmounted: () => {},
    useSSRContext: () => ({ modules: new Set() })
}));
vi.mock('@/shared/http.js', () => ({ fetchJson: vi.fn() }));
vi.mock('@/shared/i18n.js', () => ({ setLanguage: vi.fn(async () => true) }));
vi.mock('@/shared/socketRefusalRetry.js', () => ({
    SOCKET_CLIENT_OPTIONS: {},
    applyReconnectPolicy: vi.fn(),
    createRefusalRetry: () => ({ connected() {}, refused() {}, cancel() {} })
}));
const { toDataURL } = vi.hoisted(() => ({ toDataURL: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toDataURL } }));
const { ioMock } = vi.hoisted(() => ({ ioMock: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: ioMock }));

import Component from './MenuApp.vue';
import { fetchJson } from '@/shared/http.js';

const menu = { success: true, store: {}, categories: [{ id: 1, name: 'Food' }], products: [{ id: 5, name: 'Burger', price: 4, image: 'b.png' }] };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) { await Promise.resolve(); await nextTick(); } };
let scope, state, socket, order;

function boot(search = '') {
    vi.stubGlobal('window', {
        location: { search, href: 'https://x.test/menu.html' + search },
        addEventListener() {}, removeEventListener() {}
    });
    vi.stubGlobal('localStorage', { getItem: () => null });
    scope = effectScope();
    state = scope.run(() => Component.setup());
    mounted.forEach(cb => cb());
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

beforeEach(() => {
    mounted.length = 0; order = [];
    socket = { on() {}, emit: vi.fn(), disconnect() {} };
    ioMock.mockReset();
    ioMock.mockImplementation(() => { order.push('socket'); return socket; });
    fetchJson.mockReset(); toDataURL.mockReset();
    toDataURL.mockResolvedValue('data:image/png;base64,QR');
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { scope?.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('customer menu critical path', () => {
    it('drops the skeleton as soon as the menu data resolves, with no timer', async () => {
        vi.useFakeTimers();
        try {
            fetchJson.mockResolvedValue(menu);
            boot();
            await flush();
            expect(state.isLoading.value).toBe(false);
            expect(state.products.value).toHaveLength(1);
        } finally { vi.useRealTimers(); }
    });

    it('reads the table draft only after the menu data, so the snapshot is fresh', async () => {
        const menuReq = deferred();
        fetchJson.mockImplementation(url => url === 'public_menu.json' ? menuReq.promise : Promise.resolve({ success: true, cart: [] }));
        boot('?table=7&token=abc');
        await flush();
        expect(fetchJson.mock.calls.map(c => c[0])).toEqual(['public_menu.json']);
        menuReq.resolve(menu);
        await flush();
        expect(fetchJson.mock.calls.map(c => c[0])).toEqual(['public_menu.json', '/api/pos/table-draft/7?token=abc']);
        expect(state.isLoading.value).toBe(false);
    });

    it('applies draft lines with fallbacks without echoing the snapshot back; later edits sync', async () => {
        fetchJson.mockImplementation(url => url === 'public_menu.json' ? Promise.resolve(menu)
            : Promise.resolve({ success: true, cart: [{ product_id: 5, qty: 2 }, { product_id: 5, name: 'Named', price: 9, qty: 1 }] }));
        vi.useFakeTimers();
        try {
            boot('?table=7&token=abc');
            await flush();
            expect(order).toEqual(['socket']);
            expect(state.cart.value).toEqual([
                { id: 5, name: 'Burger', price: 4, qty: 2, image: 'b.png' },
                { id: 5, name: 'Named', price: 9, qty: 1, image: 'b.png' }
            ]);
            vi.advanceTimersByTime(600);
            // The server already holds this draft; a stale snapshot must not overwrite newer edits.
            expect(socket.emit).not.toHaveBeenCalled();
            state.cart.value[0].qty = 3;
            await flush();
            vi.advanceTimersByTime(600);
            expect(socket.emit).toHaveBeenCalledWith('customer_cart_updated', expect.objectContaining({
                tableId: 7,
                cart: [
                    { product_id: 5, qty: 3, price: 4, name: 'Burger' },
                    { product_id: 5, qty: 1, price: 9, name: 'Named' }
                ]
            }));
        } finally { vi.useRealTimers(); }
    });

    it('still renders the menu when the draft read fails', async () => {
        fetchJson.mockImplementation(url => url === 'public_menu.json' ? Promise.resolve(menu) : Promise.reject(new TypeError('offline')));
        boot('?table=7&token=abc');
        await flush();
        expect(state.isLoading.value).toBe(false);
        expect(state.products.value).toHaveLength(1);
        expect(state.cart.value).toEqual([]);
    });
});

describe('share QR', () => {
    it('is not built on mount', async () => {
        fetchJson.mockResolvedValue(menu);
        boot();
        await flush();
        expect(toDataURL).not.toHaveBeenCalled();
        expect(state.menuQrUrl.value).toBe('');
    });

    it('is built once when the dialog opens', async () => {
        fetchJson.mockResolvedValue(menu);
        boot();
        await flush();
        state.showQrModal.value = true;
        await flush();
        state.showQrModal.value = false; await flush();
        state.showQrModal.value = true; await flush();
        expect(toDataURL).toHaveBeenCalledTimes(1);
        expect(state.menuQrUrl.value).toBe('data:image/png;base64,QR');
    });

    it('sends a pending cart edit, then reloads once when a deployment replaced the QR chunk', async () => {
        fetchJson.mockImplementation(url => Promise.resolve(url === 'public_menu.json' ? menu : { success: true, cart: [] }));
        toDataURL.mockRejectedValue(new TypeError('Failed to fetch dynamically imported module: /chunks/browser-old.js'));
        const store = new Map();
        boot('?table=7&token=abc');
        const reload = vi.fn(() => expect(socket.emit).toHaveBeenCalledWith('customer_cart_updated', expect.objectContaining({ tableId: 7 })));
        window.location.reload = reload;
        vi.stubGlobal('navigator', { onLine: true });
        vi.stubGlobal('sessionStorage', { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) });
        await flush();
        state.cart.value.push({ id: 5, name: 'Burger', price: 4, qty: 1 });
        await flush();
        expect(socket.emit).not.toHaveBeenCalled(); // still inside the 500 ms debounce
        state.showQrModal.value = true;
        await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
        expect(reload.mock.results[0].type).toBe('return');
        state.showQrModal.value = false; await flush();
        state.showQrModal.value = true;
        await vi.waitFor(() => expect(console.error).toHaveBeenCalledTimes(2));
        expect(reload).toHaveBeenCalledTimes(1); // not again within a minute
    });

    it('keeps the spinner state when generation fails', async () => {
        fetchJson.mockResolvedValue(menu);
        toDataURL.mockRejectedValue(new Error('boom'));
        boot();
        await flush();
        state.showQrModal.value = true;
        await flush();
        expect(state.menuQrUrl.value).toBe('');
        expect(state.showQrModal.value).toBe(true);
    });
});
