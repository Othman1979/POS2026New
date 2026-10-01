import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import * as api from './stores/orderSession/orderSessionApi.js';

const auth = { activeUser: ref({ id: 7, role: 'admin', permissions: [] }), activeShift: ref(null), isTempAdmin: ref(false) };
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('./useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('./useTerminal.js', () => ({ useTerminal: () => ({ lastOrder: ref(null), taxInclusivePricing: ref(false) }) }));
vi.mock('./useProducts.js', () => ({ useProducts: () => ({ products: ref([]), settings: ref({}) }) }));
const { useOrderSessionStore } = await import('./stores/orderSessionStore.js');
const { useOrderUiStore } = await import('./stores/orderUiStore.js');

const stalled = () => vi.fn(() => new Promise(() => {}));
const item = { id: 1, product_id: 1, name: 'Tea', price: 1, quantity: 1 };

beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const store = new Map();
    vi.stubGlobal('localStorage', {
        length: 0, key: () => null,
        getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k),
    });
    vi.stubGlobal('window', {
        showPosAlert: vi.fn(async () => {}), showPosToast: vi.fn(), showPosPrompt: vi.fn(async () => 'Ref'),
        location: { pathname: '/pos' }, history: { replaceState: vi.fn() },
    });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('a stalled table save releases the register after 15 s with the uncertain message and keeps the cart', async () => {
    vi.stubGlobal('fetch', stalled());
    const session = useOrderSessionStore();
    const ui = useOrderUiStore();
    session.activeTable = { id: 1, table_number: '1', current_order_id: 88, version: 3 };
    session.cart = [item];
    const save = session.updateActiveTableOrder({ skipAutoServiceChargeEnsure: true });
    await vi.advanceTimersByTimeAsync(15000);
    expect(await save).toBe(false);
    expect(ui.isProcessing).toBe(false);
    expect(ui.tableSaveError).toBe('Could not confirm the table save. Reopen the table to review it before saving again.');
    expect(session.cart).toHaveLength(1);
    // A background floor load or a split-board failure never clears the save notice.
    vi.stubGlobal('fetch', vi.fn(async url => ({ ok: !String(url).includes('split'), json: async () => (
        String(url).includes('split') ? { success: false } : { success: true, tables: [{ id: 1, table_number: '1', status: 'occupied', current_order_id: 88, version: 3 }], sections: [], settings: { tables_enabled: true } }) })));
    await session.loadTableWorkspace({ force: true, skipActivation: true });
    await session.fetchTableSplits();
    expect(ui.tableSaveError).toBe('Could not confirm the table save. Reopen the table to review it before saving again.');
    expect(ui.tableActionError).toBe('');
});

it('a stalled hold releases the checkout, says the hold is unconfirmed, and the retry reuses the hold request id', async () => {
    vi.stubGlobal('fetch', stalled());
    const session = useOrderSessionStore();
    const ui = useOrderUiStore();
    session.cart = [item];
    const hold = session.holdCurrentOrder();
    await vi.advanceTimersByTimeAsync(15000);
    expect(await hold).toBe(false);
    expect(ui.isHolding).toBe(false);
    expect(window.showPosAlert).toHaveBeenCalledWith('Could not confirm the hold. Retry to finish the same hold.');
    expect(session.cart).toHaveLength(1);
    const retry = session.holdCurrentOrder();
    await vi.advanceTimersByTimeAsync(15000);
    await retry;
    const ids = fetch.mock.calls.map(([, o]) => JSON.parse(o.body).hold_request_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
});

it.each([
    ['createServiceChargeSnapshot', () => api.createServiceChargeSnapshot({})],
    ['abandonServiceChargeSnapshot', () => api.abandonServiceChargeSnapshot({ id: 1, version: 1 })],
    ['dismissTableDraft', () => api.dismissTableDraft(1)],
    ['saveTableOrder', () => api.saveTableOrder({})],
    ['markTablePrinted', () => api.markTablePrinted({ tableId: 1, invoiceId: 2 })],
    ['holdOrder', () => api.holdOrder({})],
    ['getHeldOrders', () => api.getHeldOrders()],
    ['claimHeldOrder', () => api.claimHeldOrder({ id: 1 })],
    ['updateHeldOrder', () => api.updateHeldOrder(1, {})],
    ['followUpHeldOrder', () => api.followUpHeldOrder(1, {})],
    ['confirmHeldKitchenBaseline', () => api.confirmHeldKitchenBaseline(1, {})],
    ['releaseHeldOrder', () => api.releaseHeldOrder(1, {})],
    ['cancelHeldOrder', () => api.cancelHeldOrder(1, {})],
    ['getOrderDetails', () => api.getOrderDetails(1)],
    ['getCustomerByPhone', () => api.getCustomerByPhone('0790000000')],
    ['getCustomerByPhone private', () => api.getCustomerByPhone('0790000000', { privateBody: true })],
    ['findPhoneHeldOrders', () => api.findPhoneHeldOrders('0790000000')],
    ['getJofotaraCheckoutStatus', () => api.getJofotaraCheckoutStatus({})],
    ['logDrawerPop', () => api.logDrawerPop({})],
])('%s rejects with a TimeoutError after 15 s on a stalled link', async (_, call) => {
    vi.stubGlobal('fetch', stalled());
    const settled = call().then(() => 'resolved', e => e.name);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await settled).toBe('TimeoutError');
});

it('a stalled drawer pop says the command is unconfirmed and never retries it', async () => {
    auth.activeUser.value = { id: 7, role: 'cashier', permissions: [] };
    vi.stubGlobal('fetch', stalled());
    const session = useOrderSessionStore();
    const pop = session.openCashDrawer(1);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pop).toBe(false);
    expect(window.showPosAlert).toHaveBeenCalledWith('Drawer command not confirmed.');
    expect(fetch).toHaveBeenCalledTimes(1);
    auth.activeUser.value = { id: 7, role: 'admin', permissions: [] };
});
