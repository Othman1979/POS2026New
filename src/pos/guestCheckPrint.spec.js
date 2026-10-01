import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => ({
    auth: { activeUser: { value: { id: 1, name: 'Cashier', role: 'cashier', permissions: [] } }, activeShift: { value: { id: 9 } }, isTempAdmin: { value: false } },
    terminal: { lastOrder: { value: null }, printReceipt: vi.fn(), printMethod: { value: 'backend' }, taxInclusivePricing: { value: false }, receiptTaxInclusiveDisplay: { value: false }, taxRegistrationType: { value: 'sales_tax' } },
}));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => mocks.terminal }));
vi.mock('@/pos/useProducts.js', () => ({ useProducts: () => ({ products: { value: [] }, settings: { value: { stock_enabled: '0', service_charge_enabled: '0' } } }) }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true, hasDirect: () => true }) }));

import { useOrderSessionStore } from './stores/orderSessionStore.js';
import { useOrderUiStore } from './stores/orderUiStore.js';

const line = { id: 1, name: 'Tea', price: 2, qty: 1, tax_rate: 0, cartId: 'l1', discountValue: 0 };
beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    vi.stubGlobal('window', { showPosToast: vi.fn(), history: { replaceState: vi.fn() }, location: { href: '', pathname: '/pos' } });
    mocks.terminal.lastOrder.value = null;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('guest check printing', () => {
    it('prints once per tap burst, closes More Actions first and restores the last order with no timers', async () => {
        const store = useOrderSessionStore();
        const ui = useOrderUiStore();
        store.cart = [line];
        ui.showMoreActionsModal = true;
        const sale = { invoice_id: 44 };
        mocks.terminal.lastOrder.value = sale;
        const print = Promise.withResolvers();
        mocks.terminal.printReceipt.mockReturnValue(print.promise);
        const first = store.printGuestCheck();
        const second = store.printGuestCheck();
        expect(ui.showMoreActionsModal).toBe(false);
        expect(store.guestCheckInFlight).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.terminal.printReceipt).toHaveBeenCalledOnce();
        expect(mocks.terminal.lastOrder.value.guest_check).toBe(true);
        expect(await second).toBe(false);
        print.resolve(true);
        expect(await first).toBe(true);
        expect(mocks.terminal.lastOrder.value).toBe(sale);
        expect(store.guestCheckInFlight).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(mocks.terminal.printReceipt).toHaveBeenCalledOnce();
    });

    it('focuses the hash field on the next render instead of a timer', async () => {
        const focus = vi.fn();
        vi.stubGlobal('document', { getElementById: () => ({ focus }), documentElement: { dir: 'ltr' } });
        const store = useOrderSessionStore();
        store.handleOrderTypeSelection({ id: 3, requires_hash: 1 });
        await nextTick();
        expect(focus).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
});
