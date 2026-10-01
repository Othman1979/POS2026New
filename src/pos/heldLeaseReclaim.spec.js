import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const terminal = vi.hoisted(() => ({
    ensureSettings: vi.fn(), lastOrder: { value: null }, printReceipt: vi.fn(), dispatchToNodeSpooler: vi.fn(),
    printMethod: { value: 'browser' }, receiptTaxInclusiveDisplay: { value: false }, taxRegistrationType: { value: 'sales_tax' },
}));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => terminal }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => ({ activeUser: { value: { id: 1, name: 'Cashier', role: 'cashier' } }, activeShift: { value: { id: 9 } }, isTempAdmin: { value: false } }) }));
vi.mock('@/pos/useProducts.js', () => ({ useProducts: () => ({ products: { value: [] }, settings: { value: { stock_enabled: '0', service_charge_enabled: '0' } } }) }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true, hasDirect: () => true }) }));
import { useOrderSessionStore } from './stores/orderSessionStore.js';
import { useOrderUiStore } from './stores/orderUiStore.js';

const TOKEN = 'a'.repeat(64);
const reply = (status, body) => Promise.resolve({ ok: status < 400, status, json: async () => body });
const claimRequired = () => reply(409, { success: false, code: 'HELD_CLAIM_REQUIRED', message: 'Held order claim is missing or expired.' });
const claimOk = () => reply(200, { success: true, order: { id: 5 }, claim: { version: 3, claimToken: TOKEN, claimExpiresAt: null } });
const urls = () => fetch.mock.calls.map(([url, init]) => `${init?.method || 'GET'} ${String(url).replace(/^.*api\//, '')}`);
const body = i => JSON.parse(fetch.mock.calls[i][1].body);

const restoredRegisterHold = () => {
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0, cartId: 'c1' }];
    store.restoredHeldReference = 'Tab 1';
    store.restoredHeldOrder = { id: 5, version: 2, claimToken: TOKEN, kitchenFired: false, kitchenDispatchVersion: 0 };
    useOrderUiStore().amountTendered = 10;
    return store;
};

beforeEach(() => {
    vi.clearAllMocks(); setActivePinia(createPinia());
    const storage = new Map();
    vi.stubGlobal('localStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) });
    vi.stubGlobal('window', { showPosToast: vi.fn(), showPosAlert: vi.fn(async () => {}), history: { replaceState: vi.fn() }, location: { href: '', pathname: '/pos' } });
    vi.stubGlobal('document', { documentElement: { dir: 'ltr' } });
    terminal.ensureSettings.mockResolvedValue(true);
    terminal.settingsLoaded = { value: true };
    terminal.duplicateCustomerReceipt = { value: false };
    terminal.printReceipt.mockResolvedValue(true);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a restored register hold whose claim lease lapsed', () => {
    it('pays after exactly one transparent re-claim and one retry with a fresh key', async () => {
        const store = restoredRegisterHold();
        const sale = { success: true, invoice_id: 7, order_id: 1, order_display_no: 'A-1', subtotal: 10, tax: 0, total: 10, amount_tendered: 10, change_due: 0 };
        vi.stubGlobal('fetch', vi.fn()
            .mockImplementationOnce(claimRequired)
            .mockImplementationOnce(claimOk)
            .mockImplementationOnce(() => reply(200, sale)));
        await store.processCheckout();
        expect(urls()).toEqual(['POST pos/checkout', 'POST pos/held_orders/5/claim', 'POST pos/checkout']);
        expect(body(1)).toMatchObject({ claim_token: TOKEN, expected_version: 2 });
        expect(body(2).held_order_context).toMatchObject({ expected_version: 3, claim_token: TOKEN });
        expect(body(2).idempotency_key).not.toBe(body(0).idempotency_key);
        expect(store.cart).toHaveLength(0);
        expect(store.pendingCheckout).toBeNull();
    });

    it('saves after exactly one re-claim and one retry of the same cart', async () => {
        const store = restoredRegisterHold();
        vi.stubGlobal('fetch', vi.fn()
            .mockImplementationOnce(claimRequired)
            .mockImplementationOnce(claimOk)
            .mockImplementationOnce(() => reply(200, { success: true })));
        expect(await store.holdCurrentOrder()).toBe(true);
        expect(urls()).toEqual(['PATCH pos/held_orders/5', 'POST pos/held_orders/5/claim', 'PATCH pos/held_orders/5']);
        expect(body(2)).toMatchObject({ expected_version: 3, claim_token: TOKEN, cart: body(0).cart });
        expect(body(2).operation_id).not.toBe(body(0).operation_id);
        expect(window.showPosAlert).not.toHaveBeenCalled();
    });

    it.each(['HELD_IN_USE', 'HELD_VERSION_CONFLICT'])('keeps the cart and shows the %s conflict without retrying', async code => {
        const store = restoredRegisterHold();
        vi.stubGlobal('fetch', vi.fn()
            .mockImplementationOnce(claimRequired)
            .mockImplementationOnce(() => reply(409, { success: false, code, message: 'raw server text' })));
        await store.processCheckout();
        expect(urls()).toEqual(['POST pos/checkout', 'POST pos/held_orders/5/claim']);
        expect(store.cart).toHaveLength(1);
        expect(store.pendingCheckout).toBeNull();
        expect(useOrderUiStore().checkoutError).not.toBe('raw server text');
        expect(useOrderUiStore().checkoutError).toBeTruthy();
    });
});
