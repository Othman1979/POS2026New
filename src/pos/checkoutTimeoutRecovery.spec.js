import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const terminal = vi.hoisted(() => ({
    ensureSettings: vi.fn(), lastOrder: { value: null }, printReceipt: vi.fn(), dispatchToNodeSpooler: vi.fn(),
    printMethod: { value: 'backend' }, receiptTaxInclusiveDisplay: { value: false }, taxRegistrationType: { value: 'sales_tax' },
}));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => terminal }));
const authState = vi.hoisted(() => ({}));
vi.mock('@/pos/useAuth.js', async () => {
    const { ref } = await import('vue');
    authState.user = ref({ id: 1, name: 'Cashier', role: 'cashier' });
    authState.isTempAdmin = ref(false);
    authState.activeManagerPin = ref('');
    return { useAuth: () => ({ activeUser: authState.user, activeShift: { value: { id: 9 } }, isTempAdmin: authState.isTempAdmin, activeManagerPin: authState.activeManagerPin }) };
});
vi.mock('@/pos/useProducts.js', () => ({ useProducts: () => ({ products: { value: [] }, settings: { value: { stock_enabled: '0', service_charge_enabled: '0' } } }) }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true, hasDirect: () => true }) }));
import { useOrderSessionStore } from './stores/orderSessionStore.js';
import { useOrderUiStore } from './stores/orderUiStore.js';

beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); setActivePinia(createPinia());
    const storage = new Map();
    vi.stubGlobal('localStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) });
    vi.stubGlobal('window', { showPosToast: vi.fn(), history: { replaceState: vi.fn() }, location: { href: '', pathname: '/pos' } });
    vi.stubGlobal('document', { documentElement: { dir: 'ltr' } });
    terminal.ensureSettings.mockResolvedValue(true);
    terminal.settingsLoaded = { value: true };
    terminal.duplicateCustomerReceipt = { value: false };
    terminal.printReceipt.mockResolvedValue(true);
    terminal.dispatchToNodeSpooler.mockResolvedValue({ success: true });
    authState.user.value = { id: 1, name: 'Cashier', role: 'cashier' };
    authState.isTempAdmin.value = false;
    authState.activeManagerPin.value = '';
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('checkout with the real HTTP transport', () => {
    it.each(['headers', 'body'])('recovers the exact payment after stalled %s without resending automatically', async stage => {
        const store = useOrderSessionStore(), ui = useOrderUiStore();
        store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0, cartId: 'coffee' }];
        ui.amountTendered = 20;
        const late = Promise.withResolvers();
        vi.stubGlobal('fetch', vi.fn(() => stage === 'headers' ? late.promise : Promise.resolve({ ok: true, json: () => late.promise })));
        const first = store.processCheckout();
        await vi.advanceTimersByTimeAsync(30000);
        expect(store.checkoutInFlight).toBe(false);
        await first;
        expect(ui.isProcessing).toBe(false);
        expect(store.pendingCheckout).toBeTruthy();
        expect(ui.checkoutError).toContain('No reply from the server yet');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(terminal.printReceipt).not.toHaveBeenCalled();
        const original = JSON.parse(fetch.mock.calls[0][1].body);
        expect(original.amount_tendered).toBe(20);
        // A late response from the timed-out operation must not finalize or print.
        const data = { success: true, invoice_id: 71, order_id: 1, order_display_no: 'A-1', subtotal: 10, tax: 0, total: 10, amount_tendered: 20, change_due: 10 };
        late.resolve(stage === 'headers' ? { ok: true, json: async () => data } : data);
        await vi.advanceTimersByTimeAsync(1);
        expect(store.pendingCheckout).toBeTruthy();
        expect(terminal.printReceipt).not.toHaveBeenCalled();
        ui.amountTendered = 999;
        fetch.mockResolvedValue({ ok: true, status: 200, json: async () => data });
        await store.processCheckout();
        expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(original);
        expect(store.pendingCheckout).toBeNull();
        expect(store.cart).toHaveLength(0);
        expect(terminal.printReceipt).toHaveBeenCalledOnce();
        expect(terminal.dispatchToNodeSpooler).not.toHaveBeenCalled();
    });

    it('does not show the no-reply panel while a normal payment is still in flight', async () => {
        const store = useOrderSessionStore(), ui = useOrderUiStore();
        store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0, cartId: 'coffee' }];
        ui.amountTendered = 20;
        const late = Promise.withResolvers();
        vi.stubGlobal('fetch', vi.fn(() => late.promise));
        const first = store.processCheckout();
        await vi.advanceTimersByTimeAsync(1000);
        expect(store.checkoutInFlight).toBe(true);
        expect(store.pendingCheckout).toBeNull();
        expect(localStorage.getItem('pos_pending_checkout:1')).toBeTruthy(); // a reload can still recover it
        late.reject(new TypeError('Failed to fetch'));
        await first;
        expect(store.pendingCheckout).toBeTruthy();
    });

    it('keeps a retry sent with full storage undiscardable for five minutes', async () => {
        const store = useOrderSessionStore(), ui = useOrderUiStore();
        store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0, cartId: 'coffee' }];
        ui.amountTendered = 20;
        vi.stubGlobal('fetch', vi.fn(url => String(url).includes('jofotara/status')
            ? Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
            : Promise.reject(new TypeError('Failed to fetch'))));
        await store.processCheckout();
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        const setItem = localStorage.setItem;
        localStorage.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
        await store.processCheckout(); // retry: send time cannot be stored
        localStorage.setItem = setItem;
        await store.probePendingCheckout(); // reloads the older stored record
        expect(store.canDiscardPendingCheckout).toBe(false);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await store.probePendingCheckout();
        expect(store.canDiscardPendingCheckout).toBe(true);
    });

    it('still sends a recovery retry when browser storage is full', async () => {
        const store = useOrderSessionStore(), ui = useOrderUiStore();
        store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0, cartId: 'coffee' }];
        ui.amountTendered = 20;
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
        await store.processCheckout();
        expect(store.pendingCheckout).toBeTruthy();
        const data = { success: true, invoice_id: 72, order_id: 2, order_display_no: 'A-2', subtotal: 10, tax: 0, total: 10, amount_tendered: 20, change_due: 10 };
        fetch.mockResolvedValue({ ok: true, status: 200, json: async () => data });
        const setItem = localStorage.setItem;
        localStorage.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
        await store.processCheckout();
        localStorage.setItem = setItem;
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(store.pendingCheckout).toBeNull();
    });

    it('sends the approving manager PIN with checkout only while temporary manager access is active', async () => {
        const checkoutBody = async () => {
            const store = useOrderSessionStore();
            store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0, cartId: 'coffee' }];
            useOrderUiStore().amountTendered = 10;
            vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, invoice_id: 71, order_id: 1, subtotal: 10, tax: 0, total: 10 }) })));
            await store.processCheckout();
            return JSON.parse(fetch.mock.calls[0][1].body);
        };
        authState.activeManagerPin.value = '4321';
        authState.isTempAdmin.value = true;
        expect((await checkoutBody()).manager_pin).toBe('4321');

        authState.isTempAdmin.value = false;
        expect(await checkoutBody()).not.toHaveProperty('manager_pin');
    });

    it('does not send a new checkout if initial settings are unavailable', async () => {
        const store = useOrderSessionStore();
        store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0 }];
        terminal.ensureSettings.mockResolvedValue(false);
        terminal.settingsLoaded.value = false;
        vi.stubGlobal('fetch', vi.fn());
        await store.processCheckout();
        expect(fetch).not.toHaveBeenCalled();
        expect(store.pendingCheckout).toBeNull();
        expect(store.cart).toHaveLength(1);
        expect(useOrderUiStore().checkoutError).toBeTruthy();
    });

    it('does not queue a second automatic receipt after an uncertain first receipt', async () => {
        const store = useOrderSessionStore();
        store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0 }];
        useOrderUiStore().amountTendered = 10;
        terminal.duplicateCustomerReceipt = { value: true };
        terminal.printReceipt.mockResolvedValue(false);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, invoice_id: 8, total: 10, tax: 0, subtotal: 10 }) }));
        await store.processCheckout();
        expect(store.cart).toHaveLength(0);
        expect(store.checkoutInFlight).toBe(false);
        expect(store.pendingCheckout).toBeNull();
        expect(terminal.dispatchToNodeSpooler).not.toHaveBeenCalled();
    });
    it('lets the next sale check out while the previous receipt print is still pending', async () => {
        const store = useOrderSessionStore();
        store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0 }];
        useOrderUiStore().amountTendered = 10;
        terminal.printReceipt.mockReturnValue(new Promise(() => {}));
        const fetchMock = vi.fn().mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ success: true, invoice_id: 9, total: 10, tax: 0, subtotal: 10 }) }));
        vi.stubGlobal('fetch', fetchMock);
        await store.processCheckout();
        expect(store.checkoutInFlight).toBe(false);
        const checkoutCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('checkout')).length;
        expect(checkoutCalls()).toBe(1);
        store.cart = [{ id: 2, name: 'Tea', price: 5, qty: 1, tax_rate: 0 }];
        useOrderUiStore().amountTendered = 5;
        await store.processCheckout();
        expect(checkoutCalls()).toBe(2);
    });
});

describe('unconfirmed checkout recovery', () => {
    const sale = { success: true, invoice_id: 71, order_id: 1, order_display_no: 'A-1', subtotal: 10, tax: 0, total: 10, amount_tendered: 10, change_due: 0 };
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    // Route by URL: the status probe answers `status()`, a checkout answers `checkout()`.
    const route = (handlers) => vi.fn(async (url) => String(url).includes('jofotara/status') ? handlers.status() : handlers.checkout());
    const calls = (part) => fetch.mock.calls.filter(([url]) => String(url).includes(part));
    const checkoutCalls = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('api/pos/checkout'));
    const leaveUnconfirmed = async (store) => {
        store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0, cartId: 'coffee' }];
        useOrderUiStore().amountTendered = 10;
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
        const attempt = store.processCheckout();
        await vi.advanceTimersByTimeAsync(30000);
        await attempt;
        expect(store.pendingCheckout).toBeTruthy();
        return JSON.parse(fetch.mock.calls[0][1].body);
    };

    it('replays the frozen sale once when the probe finds it committed, then clears', async () => {
        const store = useOrderSessionStore();
        const original = await leaveUnconfirmed(store);
        vi.stubGlobal('fetch', route({ status: () => reply(200, { success: true }), checkout: () => reply(200, sale) }));
        await store.probePendingCheckout();
        expect(JSON.parse(calls('jofotara/status')[0][1].body)).toEqual({ idempotency_key: original.idempotency_key, shift_id: original.shift_id });
        expect(checkoutCalls()).toHaveLength(1);
        expect(JSON.parse(checkoutCalls()[0][1].body)).toEqual(original);
        expect(store.pendingCheckout).toBeNull();
        expect(terminal.printReceipt).toHaveBeenCalledOnce();
        await store.probePendingCheckout();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it.each([404, 409, 500])('keeps the record and never replays on probe %s', async (status) => {
        const store = useOrderSessionStore();
        await leaveUnconfirmed(store);
        vi.stubGlobal('fetch', route({ status: () => reply(status, {}), checkout: () => reply(200, sale) }));
        await store.probePendingCheckout();
        expect(checkoutCalls()).toHaveLength(0);
        expect(store.pendingCheckout).toBeTruthy();
    });

    it('lets a second cashier sell while the first cashier keeps their unconfirmed sale', async () => {
        const store = useOrderSessionStore();
        const original = await leaveUnconfirmed(store);
        authState.user.value = { id: 2, name: 'Second', role: 'cashier' };
        await vi.advanceTimersByTimeAsync(0);
        expect(store.pendingCheckout).toBeNull();
        store.cart = [{ id: 2, name: 'Tea', price: 5, qty: 1, tax_rate: 0, cartId: 'tea' }];
        useOrderUiStore().amountTendered = 5;
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
        const second = store.processCheckout();
        await vi.advanceTimersByTimeAsync(30000);
        await second;
        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body.user_id).toBe(2);
        expect(body.idempotency_key).not.toBe(original.idempotency_key);
        authState.user.value = { id: 1, name: 'Cashier', role: 'cashier' };
        await vi.advanceTimersByTimeAsync(0);
        expect(store.pendingCheckout.frozen.payload.idempotency_key).toBe(original.idempotency_key);
    });

    it('moves a legacy record to its owner', async () => {
        localStorage.setItem('pos_pending_checkout', JSON.stringify({ draftId: 'd', frozen: { payload: { idempotency_key: 'k1', user_id: 1, shift_id: 9 }, totals: { total: 10 } } }));
        const store = useOrderSessionStore();
        expect(store.pendingCheckout.frozen.payload.idempotency_key).toBe('k1');
        expect(localStorage.getItem('pos_pending_checkout')).toBeNull();
    });

    it('sets an unreadable record aside instead of blocking every Pay', async () => {
        localStorage.setItem('pos_pending_checkout:1', '{broken');
        const store = useOrderSessionStore();
        expect(store.pendingCheckoutUnreadable).toBe(true);
        expect(store.pendingCheckout).toBeNull();
        store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0 }];
        useOrderUiStore().amountTendered = 10;
        vi.stubGlobal('fetch', vi.fn(async () => reply(200, sale)));
        await store.processCheckout();
        expect(checkoutCalls()).toHaveLength(1);
        expect(store.cart).toHaveLength(0);
        expect(localStorage.getItem('pos_pending_checkout:1')).toBeNull();
    });

    it('discards only after a 404 on a record at least five minutes old, never on 200', async () => {
        window.showPosConfirm = vi.fn(async () => true);
        const store = useOrderSessionStore();
        await leaveUnconfirmed(store);
        let status = 404;
        vi.stubGlobal('fetch', route({ status: () => reply(status, {}), checkout: () => reply(200, sale) }));
        await store.probePendingCheckout();
        expect(store.canDiscardPendingCheckout).toBe(false);
        expect(await store.discardPendingCheckout()).toBe(false);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await store.probePendingCheckout();
        expect(store.canDiscardPendingCheckout).toBe(true);
        status = 200;
        expect(await store.discardPendingCheckout()).toBe(false);
        expect(store.pendingCheckout).toBeTruthy();
        expect(checkoutCalls()).toHaveLength(0);
        expect(store.canDiscardPendingCheckout).toBe(false);
        status = 404;
        await store.probePendingCheckout();
        window.showPosConfirm.mockResolvedValueOnce(false);
        expect(await store.discardPendingCheckout()).toBe(false);
        expect(store.pendingCheckout).toBeTruthy();
        expect(await store.discardPendingCheckout()).toBe(true);
        expect(store.pendingCheckout).toBeNull();
        expect(checkoutCalls()).toHaveLength(0);
    });

    it('stops heartbeat probes once Discard is offered, while reconnect still re-checks', async () => {
        const store = useOrderSessionStore();
        await leaveUnconfirmed(store);
        vi.stubGlobal('fetch', route({ status: () => reply(404, {}), checkout: () => reply(200, sale) }));
        await store.probePendingCheckout({ heartbeat: true });
        expect(calls('jofotara/status')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await store.probePendingCheckout({ heartbeat: true });
        expect(store.canDiscardPendingCheckout).toBe(true);
        for (let beat = 0; beat < 3; beat += 1) await store.probePendingCheckout({ heartbeat: true });
        expect(calls('jofotara/status')).toHaveLength(2);
        await store.probePendingCheckout();
        expect(calls('jofotara/status')).toHaveLength(3);
    });
    it('keeps a refused retry undiscardable until five minutes after that send', async () => {
        // A refusal plus a momentary 404 does not prove an earlier timed-out request has finished.
        window.showPosConfirm = vi.fn(async () => true);
        const store = useOrderSessionStore(), ui = useOrderUiStore();
        await leaveUnconfirmed(store);
        vi.stubGlobal('fetch', route({ status: () => reply(404, {}), checkout: () => reply(422, { success: false, message: 'Item is unavailable' }) }));
        await store.processCheckout();
        expect(ui.checkoutError).toBe('Item is unavailable');
        expect(store.pendingCheckout).toBeTruthy();
        await store.probePendingCheckout();
        expect(store.canDiscardPendingCheckout).toBe(false);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await store.probePendingCheckout();
        expect(store.canDiscardPendingCheckout).toBe(true);
        expect(await store.discardPendingCheckout()).toBe(true);
        expect(store.pendingCheckout).toBeNull();
    });

    it('keeps Discard hidden when a refused retry is followed by a probe that is not 404', async () => {
        const store = useOrderSessionStore();
        await leaveUnconfirmed(store);
        vi.stubGlobal('fetch', route({ status: () => reply(409, {}), checkout: () => reply(422, { success: false, message: 'No' }) }));
        await store.processCheckout();
        expect(store.pendingCheckout).toBeTruthy();
        expect(store.canDiscardPendingCheckout).toBe(false);
    });

    it.each([
        ['a thrown network error', () => Promise.reject(new TypeError('Failed to fetch'))],
        ['a non-JSON proxy page', () => Promise.resolve({ ok: false, status: 403, json: async () => { throw new SyntaxError('Unexpected token <'); } })],
        ['an expired session', () => Promise.resolve(reply(401, { success: false, message: 'Sign in' }))],
        ['a rate limit', () => Promise.resolve(reply(429, { success: false, message: 'Slow down' }))],
    ])('leaves the outcome unknown after %s', async (_name, checkout) => {
        const store = useOrderSessionStore();
        await leaveUnconfirmed(store);
        vi.stubGlobal('fetch', route({ status: () => reply(404, {}), checkout }));
        await store.processCheckout();
        expect(calls('jofotara/status')).toHaveLength(0);
        expect(store.pendingCheckout).toBeTruthy();
        expect(store.canDiscardPendingCheckout).toBe(false);
    });
    it('closes the checkout modal after recovering a sale while a newer draft is open, keeping the draft', async () => {
        const store = useOrderSessionStore(), ui = useOrderUiStore();
        await leaveUnconfirmed(store);
        store.startNewOrder();
        store.cart = [{ id: 2, name: 'Tea', price: 5, qty: 1, tax_rate: 0, cartId: 'tea' }];
        ui.showCheckoutModal = true;
        vi.stubGlobal('fetch', route({ status: () => reply(200, { success: true }), checkout: () => reply(200, sale) }));
        await store.processCheckout();
        expect(store.pendingCheckout).toBeNull();
        expect(ui.showCheckoutModal).toBe(false);
        expect(store.cart).toHaveLength(1);
        expect(window.showPosToast).toHaveBeenCalledWith('Previous sale completed. Your current draft was kept.', 'warning');
        expect(terminal.printReceipt).toHaveBeenCalledOnce();
    });
    it('keeps Discard hidden when the refusal only says the original request is still running', async () => {
        const store = useOrderSessionStore();
        await leaveUnconfirmed(store);
        vi.stubGlobal('fetch', route({ status: () => reply(404, {}), checkout: () => reply(409, { success: false, code: 'CHECKOUT_IN_PROGRESS', message: 'busy' }) }));
        await store.processCheckout();
        expect(useOrderUiStore().checkoutError).toBe('busy');
        expect(calls('jofotara/status')).toHaveLength(0);
        expect(store.canDiscardPendingCheckout).toBe(false);
    });

    it('restarts the discard wait when a retry is sent, since that request may still commit', async () => {
        const store = useOrderSessionStore();
        await leaveUnconfirmed(store);
        vi.stubGlobal('fetch', route({ status: () => reply(404, {}), checkout: () => Promise.reject(new TypeError('Failed to fetch')) }));
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await store.probePendingCheckout();
        expect(store.canDiscardPendingCheckout).toBe(true);
        await store.processCheckout();
        expect(store.pendingCheckout).toBeTruthy();
        expect(store.canDiscardPendingCheckout).toBe(false);
        await store.probePendingCheckout();
        expect(store.canDiscardPendingCheckout).toBe(false);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await store.probePendingCheckout();
        expect(store.canDiscardPendingCheckout).toBe(true);
    });
});
