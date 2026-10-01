import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const terminal = vi.hoisted(() => ({
    ensureSettings: vi.fn(), lastOrder: { value: null }, printReceipt: vi.fn(), dispatchToNodeSpooler: vi.fn(),
    printMethod: { value: 'backend' }, receiptTaxInclusiveDisplay: { value: false }, taxRegistrationType: { value: 'sales_tax' },
}));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => terminal }));
vi.mock('@/pos/useAuth.js', async () => {
    const { ref } = await import('vue');
    return { useAuth: () => ({ activeUser: ref({ id: 1, name: 'Cashier', role: 'cashier' }), activeShift: { value: { id: 9 } }, isTempAdmin: ref(false), activeManagerPin: ref('') }) };
});
vi.mock('@/pos/useProducts.js', () => ({ useProducts: () => ({ products: { value: [] }, settings: { value: { stock_enabled: '0', service_charge_enabled: '0' } } }) }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true, hasDirect: () => true }) }));
import { useOrderSessionStore } from './stores/orderSessionStore.js';
import { useOrderUiStore } from './stores/orderUiStore.js';

const json = body => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body, text: async () => JSON.stringify(body) });
const row = (status, current_order_id) => ({ id: 7, table_number: '7', section_name: 'Main', status, current_order_id });

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
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function startTableCheckout(checkoutReply, reloadRow = row('available', null)) {
    const store = useOrderSessionStore(), ui = useOrderUiStore();
    store.activeTable = row('occupied', 70);
    store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0, cartId: 'coffee' }];
    ui.amountTendered = 10;
    const checkout = Promise.withResolvers();
    vi.stubGlobal('fetch', vi.fn(async url => {
        if (String(url).includes('get_tables')) return json({ success: true, tables: [reloadRow], sections: [], settings: { tables_enabled: true, table_mode: 'fixed' } });
        return checkout.promise;
    }));
    const pending = store.processCheckout();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.checkoutInFlight).toBe(true);
    // The server frees the table and broadcasts before it answers; the till then re-reads the floor.
    await store.loadTableWorkspace({ force: true, skipActivation: true });
    return { store, ui, pending, respond: () => { checkout.resolve(json(checkoutReply)); return pending; } };
}

describe('own checkout echo on a table', () => {
    it('keeps the cart and table for the in-flight payment and finishes it as this till\'s sale', async () => {
        const { store, respond } = await startTableCheckout({ success: true, invoice_id: 71, order_id: 70, subtotal: 10, tax: 0, total: 10, amount_tendered: 10 });
        expect(store.activeTable?.id).toBe(7);
        expect(store.cart).toHaveLength(1);
        await respond();
        expect(window.showPosToast).not.toHaveBeenCalledWith(expect.anything(), 'warning');
        expect(store.cart).toHaveLength(0);
        expect(store.activeTable).toBeNull();
    });

    it('finishes the sale as this till sale when another till reopened the table before the response', async () => {
        const { store, respond } = await startTableCheckout(
            { success: true, invoice_id: 71, order_id: 70, subtotal: 10, tax: 0, total: 10, amount_tendered: 10 }, row('occupied', 80));
        expect(store.activeTable?.current_order_id).toBe(70);
        expect(store.cart).toHaveLength(1);
        await respond();
        expect(window.showPosToast).not.toHaveBeenCalledWith(expect.stringContaining('Previous sale completed'), 'warning');
        expect(store.cart).toHaveLength(0);
    });

    it('still drops a table vacated remotely when no checkout is running', async () => {
        const store = useOrderSessionStore();
        store.activeTable = row('occupied', 70);
        store.cart = [{ id: 1, name: 'Coffee', price: 10, qty: 1, tax_rate: 0, cartId: 'coffee' }];
        vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, tables: [row('available', null)], sections: [], settings: {} })));
        await store.loadTableWorkspace({ force: true, skipActivation: true });
        expect(store.activeTable).toBeNull();
    });
});
