// backend/tests/unit/tableSession.logic.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const lsStore = {};
const mockLocalStorage = {
  get length() { return Object.keys(lsStore).length; },
  key: index => Object.keys(lsStore)[index] ?? null,
  getItem: vi.fn(k => lsStore[k] ?? null),
  setItem: vi.fn((k, v) => { lsStore[k] = String(v); }),
  removeItem: vi.fn(k => { delete lsStore[k]; }),
  clear: vi.fn(() => { for (const k in lsStore) delete lsStore[k]; }),
};
global.window = { localStorage: mockLocalStorage, showPosToast: vi.fn(), location: { href: '' }, history: { replaceState: vi.fn() } };
global.localStorage = mockLocalStorage;
global.document = { documentElement: { dir: 'ltr' } };

vi.mock('@/shared/i18n.js', () => ({ t: (k) => k }));
vi.mock('@/pos/useAuth.js', () => ({
  useAuth: () => ({ activeUser: { value: {
    id: 1,
    role: 'cashier',
    permissions: ['tables.access', 'tables.save', 'waiter.edit_locked'],
    table_access_scope: 'all'
  } }, activeShift: { value: { id: 9 } }, isTempAdmin: { value: false }, showOverrideModal: { value: false } })
}));
vi.mock('@/pos/useTerminal.js', () => ({
  useTerminal: () => ({ lastOrder: { value: null }, printReceipt: vi.fn(), taxInclusivePricing: { value: false }, receiptTaxInclusiveDisplay: { value: false } })
}));

const mockProductsState = vi.hoisted(() => ({
  settings: { value: { stock_enabled: '0' } }
}));

vi.mock('@/pos/useProducts.js', () => ({
  useProducts: () => mockProductsState
}));
vi.mock('@/pos/usePermissions.js', () => ({
  usePermissions: () => ({ can: () => true })
}));

import { useOrderSessionStore } from '@/pos/stores/orderSessionStore.js';
import { useOrderUiStore } from '@/pos/stores/orderUiStore.js';
import * as tableApi from '@/pos/stores/orderSession/orderSessionApi.js';

describe('table transfer intent and uncertain response recovery', () => {
  let store, ui;
  const source = { id: 1, table_number: '1', current_order_id: 99, parent_table_id: null, status: 'occupied' };
  const target = { id: 2, table_number: '2', current_order_id: null, parent_table_id: null, status: 'available' };
  beforeEach(() => {
    setActivePinia(createPinia()); mockLocalStorage.clear(); vi.restoreAllMocks();
    store = useOrderSessionStore(); ui = useOrderUiStore();
    store.restaurantTables = [{ ...source }, { ...target }];
    ui.activeModeSourceTable = { ...source, expected_group: [{ id: 1, current_order_id: 99, status: 'occupied', parent_table_id: null }] };
    vi.spyOn(tableApi, 'getTables').mockResolvedValue({ data: { success: true, tables: [source, target], sections: [], settings: {} } });
  });
  it('keeps the selected source identity when live floor rows are replaced', async () => {
    store.restaurantTables[0].current_order_id = 100;
    const write = vi.spyOn(tableApi, 'transferTable').mockResolvedValue({ response: { ok: false, status: 409 }, data: { code: 'TABLE_ACTION_CONFLICT' } });
    const result = await store.transferTableOrder(1, 2, 'transfer');
    expect(write.mock.calls[0][0]).toMatchObject({
      operation_id: expect.any(String), expected_tables: [
        { id: 1, current_order_id: 99, status: 'occupied', parent_table_id: null },
        { id: 2, current_order_id: null, status: 'available', parent_table_id: null }
      ]
    });
    expect(result).toMatchObject({ success: false, conflict: true });
    expect(store.pendingTableAction).toBeNull();
  });
  it('reconciles a lost committed reply without issuing a second write or clearing a cart draft', async () => {
    store.cart = [{ id: 2, qty: 3, price: 2 }]; store.orderNote = 'local draft';
    const write = vi.spyOn(tableApi, 'transferTable').mockRejectedValue(new Error('Network failed'));
    vi.spyOn(tableApi, 'getTableAction').mockImplementation(async id => ({ response: { ok: true }, data: { committed: true, result: { operation_id: id, message: 'Tables action processed successfully.' } } }));
    expect((await store.transferTableOrder(1, 2, 'transfer')).success).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(store.pendingTableAction).toBeNull();
    expect(store.cart[0].qty).toBe(3); expect(store.orderNote).toBe('local draft');
  });
  it('persists uncertainty through reload and checks status before retrying the exact original request', async () => {
    const write = vi.spyOn(tableApi, 'transferTable').mockRejectedValue(new Error('Network failed'));
    const read = vi.spyOn(tableApi, 'getTableAction').mockRejectedValue(new Error('Offline'));
    expect((await store.transferTableOrder(1, 2, 'transfer')).uncertain).toBe(true);
    const original = JSON.parse(JSON.stringify(write.mock.calls[0][0]));
    setActivePinia(createPinia());
    const restored = useOrderSessionStore();
    read.mockResolvedValue({ response: { ok: true }, data: { committed: false } });
    await restored.reconcileTableAction();
    expect(write).toHaveBeenCalledTimes(1);
    expect(restored.pendingTableAction).toEqual(original);
    write.mockResolvedValue({ response: { ok: true }, data: { success: true, operation_id: original.operation_id } });
    expect((await restored.retryTableAction()).success).toBe(true);
    expect(write.mock.calls[1][0]).toEqual(original);
    expect(read.mock.invocationCallOrder.at(-1)).toBeLessThan(write.mock.invocationCallOrder.at(-1));
    expect(restored.pendingTableAction).toBeNull();
  });
  it('blocks a new transfer and repeated clicks while the first request is pending', async () => {
    let complete;
    const write = vi.spyOn(tableApi, 'transferTable').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const first = store.transferTableOrder(1, 2, 'transfer');
    await Promise.resolve();
    await store.transferTableOrder(1, 2, 'transfer');
    await store.transferTableOrder(1, 3, 'transfer');
    expect(write).toHaveBeenCalledTimes(1);
    complete({ response: { ok: true }, data: { success: true, operation_id: write.mock.calls[0][0].operation_id } });
    await first;
  });
  it('does not send a request if durable browser persistence fails', async () => {
    const write = vi.spyOn(tableApi, 'transferTable').mockResolvedValue({ response: { ok: true }, data: { success: true } });
    mockLocalStorage.setItem.mockImplementationOnce(() => { throw new Error('Storage unavailable'); });
    expect((await store.transferTableOrder(1, 2, 'transfer')).success).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it('does not accept an incomplete successful body as proof that its own operation committed', async () => {
    vi.spyOn(tableApi, 'transferTable').mockResolvedValue({ response: { ok: true }, data: { success: true } });
    vi.spyOn(tableApi, 'getTableAction').mockResolvedValue({ response: { ok: true }, data: { committed: true, result: { operation_id: 'some-other-operation' } } });
    expect((await store.transferTableOrder(1, 2, 'transfer')).uncertain).toBe(true);
    expect(store.pendingTableAction).not.toBeNull();
  });
  it('recovers separate durable records without erasing another tab\'s pending transfer', async () => {
    const a = { operation_id: 'first-table-action', action: 'transfer', sourceTableId: 1, targetTableId: 2 };
    const b = { ...a, operation_id: 'second-table-action', sourceTableId: 3, targetTableId: 4 };
    localStorage.setItem(`pos_table_action_1:${a.operation_id}`, JSON.stringify(a));
    localStorage.setItem(`pos_table_action_1:${b.operation_id}`, JSON.stringify(b));
    vi.spyOn(tableApi, 'getTableAction').mockImplementation(async id => ({ response: { ok: true }, data: { committed: true, result: { operation_id: id } } }));
    expect((await store.reconcileTableAction()).success).toBe(true);
    expect(localStorage.getItem(`pos_table_action_1:${b.operation_id}`)).toBe(JSON.stringify(b));
    expect(store.pendingTableAction).toEqual(b);
    expect((await store.reconcileTableAction()).success).toBe(true);
    expect(store.pendingTableAction).toBeNull();
  });
});

describe('table save revision and draft recovery', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockLocalStorage.clear();
    vi.restoreAllMocks();
    mockProductsState.settings.value = { stock_enabled: '0' };
    vi.spyOn(tableApi, 'getTableDraft').mockResolvedValue({ data: { success: true, cart: [] } });
  });

  it('sends the loaded revision, keeps the entire draft after conflict and retries only with a reviewed reload', async () => {
    const store = useOrderSessionStore();
    const ui = useOrderUiStore();
    const table = { id: 1, table_number: '1', current_order_id: 99, status: 'occupied' };
    const cart = [{ id: 2, cartId: 'db_1', order_item_id: 1, name: 'Drink', qty: 2, price: 2, tax_rate: 0 }];
    const read = vi.spyOn(tableApi, 'getTableOrder').mockResolvedValue({ data: {
      success: true, invoice_id: 99, version: 4, cart, order_discount_type: null, order_discount_value: 0
    } });
    await store.loadActiveTableOrder(table);
    store.cart[0].qty = 3;
    store.orderNote = 'Keep this local note';
    store.orderDiscount = { type: 'percent', value: 10 };
    const before = JSON.parse(JSON.stringify({ cart: store.cart, discount: store.orderDiscount, note: store.orderNote }));
    const save = vi.spyOn(tableApi, 'saveTableOrder').mockResolvedValue({ response: { status: 409 }, data: {
      success: false, code: 'TABLE_ORDER_VERSION_CONFLICT', message: 'The table order changed. Reopen it to review the latest bill before saving.'
    } });
    expect(await store.updateActiveTableOrder()).toBe(false);
    expect({ cart: store.cart, discount: store.orderDiscount, note: store.orderNote }).toEqual(before);
    expect(ui.isProcessing).toBe(false);
    // Save failures have their own notice that background loads cannot clear.
    expect(ui.tableSaveError).toContain('Reopen');
    expect(window.showPosToast).toHaveBeenCalledWith(ui.tableSaveError, 'warning');
    expect(read).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].expected_version).toBe(4);
    expect(store.activeTable.version).toBe(4);
    expect(JSON.parse(lsStore.pos_active_table).version).toBe(4);
    expect(await store.updateActiveTableOrder()).toBe(false);
    expect(save.mock.calls[1][0].expected_version).toBe(4);

    read.mockResolvedValue({ data: { success: true, invoice_id: 99, version: 5, cart, order_discount_type: 'fixed', order_discount_value: 1 } });
    await store.loadActiveTableOrder(table);
    expect(store.orderDiscount).toEqual({ type: 'fixed', value: 1 });
    expect(store.activeTable.version).toBe(5);
    // Keep the focused test off unrelated floor requests after the save.
    save.mockImplementation(async payload => {
      expect(payload.expected_version).toBe(5);
      expect(payload.order_discount_value).toBe(1);
      store.clearActiveTableSession();
      return { response: { status: 200 }, data: { success: true, invoice_id: 99, version: 6 } };
    });
    await store.updateActiveTableOrder();
  });

  it('retains the submitted revision and draft when the committed reply is lost', async () => {
    const store = useOrderSessionStore();
    store.loadTableOrder({ id: 1, table_number: '1', current_order_id: 99, version: 7 }, [{ id: 2, qty: 2, price: 2 }]);
    const before = JSON.stringify(store.cart);
    const save = vi.spyOn(tableApi, 'saveTableOrder').mockRejectedValue(new Error('Response lost'));
    expect(await store.updateActiveTableOrder()).toBe(false);
    expect(JSON.stringify(store.cart)).toBe(before);
    expect(store.activeTable.version).toBe(7);
    expect(save.mock.calls[0][0].expected_version).toBe(7);
  });
});

describe('table-session primitives', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    for (const k in lsStore) delete lsStore[k];
    mockProductsState.settings.value = { stock_enabled: '0' };
    vi.restoreAllMocks();
  });

  it('invalidateTableSession clears the QR draft and bumps the token', () => {
    const s = useOrderSessionStore();
    s.activeQrDraft = [{ product_id: 1, qty: 2 }];
    const before = s.tableSessionSeq;
    s.invalidateTableSession();
    expect(s.activeQrDraft).toBeNull();
    expect(s.tableSessionSeq).toBe(before + 1);
  });

  it('loadActiveTableDraft sets the draft when the response is current', async () => {
    const s = useOrderSessionStore();
    global.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, cart: [{ product_id: 5, qty: 3 }] }) });
    await s.loadActiveTableDraft(7);
    expect(s.activeQrDraft).toEqual([{ product_id: 5, qty: 3 }]);
  });

  it('loadActiveTableDraft drops a stale response if the session changed mid-flight', async () => {
    const s = useOrderSessionStore();
    let resolveFetch;
    global.fetch = vi.fn().mockReturnValue(new Promise(res => { resolveFetch = res; }));
    const p = s.loadActiveTableDraft(7);          // captures current seq, then awaits
    s.invalidateTableSession();                    // session switched while in flight
    resolveFetch({ json: () => Promise.resolve({ success: true, cart: [{ product_id: 5, qty: 3 }] }) });
    await p;
    expect(s.activeQrDraft).toBeNull();            // stale paint dropped
  });

  it('split prefill invalidates an in-flight parent-table draft with the same table id', async () => {
    const s = useOrderSessionStore();
    s.activeTable = { id: 7, table_number: 'A7', current_order_id: 70 };
    let resolveFetch;
    global.fetch = vi.fn().mockReturnValue(new Promise(resolve => { resolveFetch = resolve; }));

    const pendingDraft = s.loadActiveTableDraft(7);
    lsStore.pos_table_prefill = JSON.stringify({
      id: 7,
      table_number: 'A7-1',
      is_split: true,
      split_check_id: 3,
    });
    await s.activateTableFromStorage('pos_table_prefill');
    resolveFetch({ json: () => Promise.resolve({ success: true, cart: [{ product_id: 5, qty: 3 }] }) });
    await pendingDraft;

    expect(s.activeTable).toMatchObject({ id: 7, is_split: true, split_check_id: 3 });
    expect(s.activeQrDraft).toBeNull();
  });

  it('normalizes split identity fields on every active-table entry path', async () => {
    const s = useOrderSessionStore();
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, cart: [] }),
    });

    await s.loadActiveTableOrder({
      id: 7,
      table_number: 'A7-1',
      status: 'occupied',
      is_split: true,
      parent_invoice_id: 70,
      parent_order_id: 71,
      split_check_id: 3,
    }, { clearEmpty: false });

    expect(s.activeTable).toMatchObject({
      id: 7,
      is_split: true,
      parent_invoice_id: 70,
      parent_order_id: 71,
      split_check_id: 3,
    });
  });

  it('imports QR draft items through the canonical cart-line path', async () => {
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, name: 'Burger', price: 5, qty: 1, tax_rate: 8, note: '', discountType: null, discountValue: 0 }];
    s.activeQrDraft = [
      { product_id: 1, qty: 2 },
      { product_id: 2, qty: 1 }
    ];

    const result = await s.importQrDraftItems([
      { id: 1, name: 'Burger', price: 5, tax_rate: 8, stock: 10 },
      { id: 2, name: 'Tea', price: 2, tax_rate: 0, stock: 10 }
    ]);

    expect(result.success).toBe(true);
    expect(s.cart).toHaveLength(2);
    expect(s.cart.find(item => item.id === 1).qty).toBe(3);
    const tea = s.cart.find(item => item.id === 2);
    expect(tea).toMatchObject({
      name: 'Tea',
      price: 2,
      qty: 1,
      tax_rate: 0,
      note: '',
      discountType: null,
      discountValue: 0
    });
    expect(tea.cartId).toBeTruthy();
  });

  it('blocks QR import before mutating cart when stock would be exceeded', async () => {
    mockProductsState.settings.value = { stock_enabled: '1' };
    global.window.showPosAlert = vi.fn();
    const s = useOrderSessionStore();
    s.cart = [{ id: 1, name: 'Burger', price: 5, qty: 1, tax_rate: 8 }];
    s.activeQrDraft = [{ product_id: 1, qty: 2 }];

    const result = await s.importQrDraftItems([
      { id: 1, name: 'Burger', price: 5, tax_rate: 8, stock: 2 }
    ]);

    expect(result.success).toBe(false);
    expect(s.cart).toHaveLength(1);
    expect(s.cart[0].qty).toBe(1);
    expect(s.activeQrDraft).toEqual([{ product_id: 1, qty: 2 }]);
    expect(global.window.showPosAlert).toHaveBeenCalled();
  });
});

describe('QR draft import resolves every line and removes exactly what it imported', () => {
  const HASH = 'a'.repeat(64);
  const burger = { id: 1, name: 'Burger', price: 5, tax_rate: 8, stock: 10, can_sell: 1 };
  const tea = { id: 2, name: 'Tea', price: 2, tax_rate: 0, stock: 10, can_sell: 1 };
  let s;
  const loadDraft = async (cart, hash = HASH) => {
    vi.spyOn(tableApi, 'getTableDraft').mockResolvedValue({ data: { success: true, cart, draft_hash: hash } });
    await s.loadActiveTableDraft(5);
  };
  beforeEach(() => {
    setActivePinia(createPinia()); mockLocalStorage.clear(); vi.restoreAllMocks();
    global.window.showPosAlert = vi.fn(); global.window.showPosToast = vi.fn();
    s = useOrderSessionStore();
    s.activeTable = { id: 5, table_number: '5' };
  });

  it('imports a draft spanning two categories with one exact-id read and dismisses that draft', async () => {
    await loadDraft([{ product_id: 1, qty: 1, name: 'Burger' }, { product_id: 2, qty: 2, name: 'Tea' }]);
    const lookup = vi.spyOn(tableApi, 'getProductsByIds').mockResolvedValue({ response: { ok: true }, data: { success: true, products: [tea] } });
    const dismiss = vi.spyOn(tableApi, 'dismissTableDraft').mockResolvedValue({ response: { ok: true }, data: { success: true } });

    const result = await s.importQrDraftItems([burger]);

    expect(result).toMatchObject({ success: true, imported: 2, dismissed: 'ok' });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0]).toEqual(['2']);
    expect(s.cart.map(item => [item.id, item.qty])).toEqual([[1, 1], [2, 2]]);
    expect(dismiss).toHaveBeenCalledWith(5, HASH);
    expect(s.activeQrDraft).toBeNull();
  });

  it('imports nothing and keeps the draft when a line cannot be resolved', async () => {
    const draft = [{ product_id: 1, qty: 1, name: 'Burger' }, { product_id: 9, qty: 1, name: 'Gone Soup' }];
    await loadDraft(draft);
    vi.spyOn(tableApi, 'getProductsByIds').mockResolvedValue({ response: { ok: true }, data: { success: true, products: [] } });
    const dismiss = vi.spyOn(tableApi, 'dismissTableDraft');

    const result = await s.importQrDraftItems([burger]);

    expect(result).toMatchObject({ success: false, reason: 'unresolved' });
    expect(s.cart).toEqual([]);
    expect(s.activeQrDraft).toEqual(draft);
    expect(dismiss).not.toHaveBeenCalled();
    expect(global.window.showPosAlert.mock.calls[0][0]).toContain('Gone Soup');
  });

  it('never re-offers the same draft after its delete failed, and retries the conditional delete', async () => {
    const draft = [{ product_id: 1, qty: 1, name: 'Burger' }];
    await loadDraft(draft);
    const dismiss = vi.spyOn(tableApi, 'dismissTableDraft').mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const result = await s.importQrDraftItems([burger]);
    expect(result).toMatchObject({ success: true, dismissed: 'failed' });
    expect(s.activeQrDraft).toBeNull();

    dismiss.mockResolvedValue({ response: { ok: true }, data: { success: true } });
    await loadDraft(draft); // reconnect/activation reload of the same stored draft
    expect(s.activeQrDraft).toBeNull();
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledTimes(2));
    expect(dismiss).toHaveBeenLastCalledWith(5, HASH);
    await Promise.resolve();
    expect(await s.dismissActiveQrDraft(5, { retryImported: true })).toBeNull(); // healthy: no request
    expect(dismiss).toHaveBeenCalledTimes(2);
    expect(s.cart[0].qty).toBe(1);
  });

  it('does not re-offer the imported draft when the table save reloads the session', async () => {
    const draft = [{ product_id: 1, qty: 1, name: 'Burger' }];
    await loadDraft(draft);
    const dismiss = vi.spyOn(tableApi, 'dismissTableDraft').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await s.importQrDraftItems([burger])).toMatchObject({ success: true, dismissed: 'failed' });

    dismiss.mockResolvedValue({ response: { ok: true }, data: { success: true } });
    vi.spyOn(tableApi, 'saveTableOrder').mockResolvedValue({ response: { ok: true, status: 200 }, data: { success: true, invoice_id: 88, version: 2 } });
    vi.spyOn(tableApi, 'getTableOrder').mockRejectedValue(new TypeError('Failed to fetch'));
    vi.spyOn(tableApi, 'getTables').mockResolvedValue({ response: { ok: true }, data: { success: true, tables: [], sections: [] } });
    const draftRead = vi.spyOn(tableApi, 'getTableDraft').mockResolvedValue({ data: { success: true, cart: draft, draft_hash: HASH } });
    draftRead.mockClear();

    expect(await s.updateActiveTableOrder({ skipAutoServiceChargeEnsure: true, silent: true })).toBe(true);
    expect(draftRead).not.toHaveBeenCalled(); // a save never changes the QR draft
    expect(s.activeQrDraft).toBeNull();
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledTimes(2));
    expect(dismiss).toHaveBeenLastCalledWith(5, HASH);
  });

  it('never re-offers a saved import on a later visit to the same order, but offers it once the order changed', async () => {
    const draft = [{ product_id: 1, qty: 1, name: 'Burger' }];
    await loadDraft(draft);
    const dismiss = vi.spyOn(tableApi, 'dismissTableDraft').mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await s.importQrDraftItems([burger])).toMatchObject({ success: true, dismissed: 'failed' });
    vi.spyOn(tableApi, 'saveTableOrder').mockResolvedValue({ response: { ok: true, status: 200 }, data: { success: true, invoice_id: 88, version: 2 } });

    // The waiter saves and leaves for the floor; the delete still fails and the visit ends.
    expect(await s.updateActiveTableOrder({ skipAutoServiceChargeEnsure: true, silent: true, leaving: true })).toBe(true);
    s.clearActiveTableSession({ clearCart: true });

    // A later visit to the same order: the saved lines are not offered again, and
    // the delete is retried (still failing here, so it stays pending).
    s.activeTable = { id: 5, table_number: '5', current_order_id: 88 };
    const before = dismiss.mock.calls.length;
    await loadDraft(draft);
    expect(s.activeQrDraft).toBeNull();
    await vi.waitFor(() => expect(dismiss.mock.calls.length).toBeGreaterThan(before));
    expect(dismiss).toHaveBeenLastCalledWith(5, HASH);

    // After that order is paid, a new order on the table sees its draft normally.
    s.activeTable = { id: 5, table_number: '5', current_order_id: 99 };
    await loadDraft(draft);
    expect(s.activeQrDraft).toEqual(draft);
  });

  it('keeps a draft the customer changed after the import and warns instead of deleting', async () => {
    await loadDraft([{ product_id: 1, qty: 1, name: 'Burger' }]);
    vi.spyOn(tableApi, 'dismissTableDraft').mockResolvedValue({ response: { ok: false, status: 409 }, data: { success: false, code: 'DRAFT_CHANGED' } });
    const result = await s.importQrDraftItems([burger]);
    expect(result.dismissed).toBe('changed');
    expect(global.window.showPosAlert).toHaveBeenCalledTimes(1);
  });
});

describe('restoreTableSplit reset wall', () => {
  beforeEach(() => { setActivePinia(createPinia()); for (const k in lsStore) delete lsStore[k]; });

  it('clears stale order metadata and QR draft before applying the split', async () => {
    const s = useOrderSessionStore();
    // Stale residue from a previous order.
    s.orderDiscount = { type: 'percent', value: 50 };
    s.orderNote = 'previous note';
    s.activeQrDraft = [{ product_id: 1, qty: 1 }];
    s.restaurantTables = [];

    const restored = await s.restoreTableSplit({
      id: 77,
      table_id: 5,
      reference_name: 'Table 5 - Seat 1',
      items: [{ product_id: 3, product_name: 'Split item', price_at_sale: 4, quantity: 2 }],
      parent_invoice_id: 500,
      parent_order_id: 50,
    }, {});

    expect(restored).toBe(true);
    expect(s.orderDiscount).toEqual({ type: 'percent', value: 0 });
    expect(s.orderNote).toBe('');
    expect(s.activeQrDraft).toBeNull();
    expect(s.activeTable.is_split).toBe(true);
    expect(s.activeTable.split_check_id).toBe(77);
    expect(s.cart.map(i => i.name)).toEqual(['Split item']);
    expect(s.cart[0].qty).toBe(2);
  });
});

describe('loadActiveTableOrder cross-table race', () => {
  beforeEach(() => { setActivePinia(createPinia()); for (const k in lsStore) delete lsStore[k]; });

  it('a late Table-1 order response does not overwrite the Table-2 session', async () => {
    const s = useOrderSessionStore();
    s.restaurantTables = [
      { id: 1, table_number: '1', status: 'occupied', current_order_id: 101 },
      { id: 2, table_number: '2', status: 'occupied', current_order_id: 202 },
    ];

    // Per-order deferred fetch responses keyed by order_id in the URL.
    const deferred = {};
    global.fetch = vi.fn((url) => {
      if (url.includes('table-draft')) return Promise.resolve({ json: () => Promise.resolve({ success: true, cart: [] }) });
      const m = url.match(/order_id=(\d+)/);
      const id = m ? m[1] : '0';
      return new Promise(res => { deferred[id] = res; });
    });

    const p1 = s.loadActiveTableOrder({ id: 1, table_number: '1', status: 'occupied', current_order_id: 101 });
    // Switch after Table 1's order read actually starts. Switching during its QR
    // draft read legitimately skips that now-obsolete order request entirely.
    await vi.waitFor(() => expect(deferred['101']).toBeTypeOf('function'));
    const p2 = s.loadActiveTableOrder({ id: 2, table_number: '2', status: 'occupied', current_order_id: 202 });

    await vi.waitFor(() => expect(deferred['202']).toBeTypeOf('function'));

    // Table 2 resolves first (operator is now on Table 2).
    deferred['202']({ json: () => Promise.resolve({ success: true, cart: [{ id: 9, name: 'T2 item', price: 5, qty: 1 }], invoice_id: 202, order_id: 22 }) });
    await p2;
    // Table 1's response arrives LATE.
    deferred['101']({ json: () => Promise.resolve({ success: true, cart: [{ id: 1, name: 'T1 item', price: 9, qty: 1 }], invoice_id: 101, order_id: 11 }) });
    await p1;

    expect(String(s.activeTable.id)).toBe('2');
    expect(s.cart.map(i => i.name)).toEqual(['T2 item']); // T1 did NOT paint over T2
  });

  it('captures same-table checkout context before clearing and reapplies it after the server load', async () => {
    const s = useOrderSessionStore();
    localStorage.setItem('pos_active_table', JSON.stringify({ id: 7, table_number: '7', status: 'occupied', current_order_id: 707 }));
    localStorage.setItem('pos_order_context', JSON.stringify({
      version: 2,
      scope: { kind: 'table', id: '7', orderId: '707', splitCheckId: null, tableNumber: '7' },
      selectedOrderType: 4,
      hashNumber: 'TABLE-HASH',
      customerPhone: '0790000000',
      customerName: 'Table Guest',
      customerAddress: 'Amman',
      orderDate: '2026-08-01T12:30',
      restoredHeldReference: '',
      taxRegistrationType: 'income_tax',
      subscriptionPurchase: null,
    }));
    global.fetch = vi.fn((url) => {
      if (url.includes('table-draft')) return Promise.resolve({ json: () => Promise.resolve({ success: false }) });
      return Promise.resolve({
        json: () => Promise.resolve({
          success: true,
          cart: [{ id: 70, name: 'Server item', price: 5, qty: 1, tax_rate: 8 }],
          invoice_id: 707,
          order_id: 77,
          discount_type: 'percent',
          discount_value: 0,
          tax_registration_type_at_sale: 'sales_tax',
          tax_exempt_at_sale: 0,
        })
      });
    });

    await s.loadActiveTableOrder({ id: 7, table_number: '7', status: 'occupied', current_order_id: 707 });

    expect(s.cart.map(item => item.name)).toEqual(['Server item']);
    expect(s.selectedOrderType).toBe(4);
    expect(s.hashNumber).toBe('TABLE-HASH');
    expect(s.customerName).toBe('Table Guest');
    expect(s.customerPhone).toBe('0790000000');
    expect(s.orderDate).toBe('2026-08-01T12:30');
    expect(s.taxRegistrationType).toBe('sales_tax');
    expect(s.isTaxExempt).toBe(false);
  });

  it('does not leak checkout context when the same table has a different active order', async () => {
    const s = useOrderSessionStore();
    localStorage.setItem('pos_cart', JSON.stringify([{ id: 1, name: 'Old item', price: 3, qty: 1 }]));
    localStorage.setItem('pos_active_table', JSON.stringify({ id: 7, table_number: '7', current_order_id: 707 }));
    localStorage.setItem('pos_order_context', JSON.stringify({
      version: 2,
      scope: { kind: 'table', id: '7', orderId: '707', splitCheckId: null, tableNumber: '7' },
      selectedOrderType: 4,
      hashNumber: 'OLD-HASH',
      customerPhone: '0790000000',
      customerName: 'Old Guest',
      customerAddress: 'Old Address',
      orderDate: '2026-08-01T12:30',
      restoredHeldReference: '',
      taxRegistrationType: null,
      subscriptionPurchase: null,
    }));
    global.fetch = vi.fn((url) => {
      if (url.includes('table-draft')) return Promise.resolve({ json: () => Promise.resolve({ success: false }) });
      return Promise.resolve({
        json: () => Promise.resolve({
          success: true,
          cart: [{ id: 80, name: 'New order item', price: 8, qty: 1, tax_rate: 8 }],
          invoice_id: 808,
          order_id: 88,
          discount_type: 'percent',
          discount_value: 0,
        })
      });
    });

    await s.loadActiveTableOrder({ id: 7, table_number: '7', status: 'occupied', current_order_id: 808 });

    expect(s.cart.map(item => item.name)).toEqual(['New order item']);
    expect(s.selectedOrderType).toBe('');
    expect(s.hashNumber).toBe('');
    expect(s.customerPhone).toBe('');
    expect(s.customerName).toBe('');
    expect(s.customerAddress).toBe('');
    expect(s.orderDate).toBe('');
  });

  it('recovers a matching unsaved fixed-table draft without marking its rows saved', async () => {
    const s = useOrderSessionStore();
    const localCart = [{ id: 1, name: 'Unsaved item', price: 5, qty: 2, originalQty: 0, tax_rate: 8 }];
    localStorage.setItem('pos_cart', JSON.stringify(localCart));
    localStorage.setItem('pos_order_note', 'Local note');
    localStorage.setItem('pos_order_discount', JSON.stringify({ type: 'fixed', value: 1 }));
    localStorage.setItem('pos_service_charge_snapshot', JSON.stringify({ id: 9, percentage: 10, taxRate: 8, version: 1 }));
    localStorage.setItem('pos_tax_exempt', 'true');
    localStorage.setItem('pos_order_context', JSON.stringify({
      version: 2,
      scope: { kind: 'table', id: '7', orderId: null, splitCheckId: null, tableNumber: '7' },
      selectedOrderType: 4,
      hashNumber: 'FIXED-HASH',
      customerPhone: '0790000000',
      customerName: 'Fixed Guest',
      customerAddress: 'Amman',
      orderDate: '2026-08-01T12:30',
      restoredHeldReference: '',
      taxRegistrationType: null,
      subscriptionPurchase: null,
    }));
    global.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: false }) });

    await s.loadActiveTableOrder({ id: 7, table_number: '7', status: 'available', current_order_id: null });

    expect(s.cart).toEqual(localCart);
    expect(s.cart[0].originalQty).toBe(0);
    expect(s.originalSavedItems).toEqual([]);
    expect(s.orderNote).toBe('Local note');
    expect(s.orderDiscount).toEqual({ type: 'fixed', value: 1 });
    expect(s.serviceChargeSnapshot).toEqual({ id: 9, percentage: 10, taxRate: 8, version: 1 });
    expect(s.isTaxExempt).toBe(true);
    expect(s.customerName).toBe('Fixed Guest');
  });

  it('recovers only the matching unsaved dynamic-table draft', async () => {
    const seedDynamicDraft = () => {
      localStorage.setItem('pos_cart', JSON.stringify([{ id: 1, name: 'Dynamic item', price: 5, qty: 1 }]));
      localStorage.setItem('pos_order_context', JSON.stringify({
        version: 2,
        scope: { kind: 'table', id: null, orderId: null, splitCheckId: null, tableNumber: '41' },
        selectedOrderType: null,
        hashNumber: '',
        customerPhone: '',
        customerName: 'Dynamic Guest',
        customerAddress: '',
        orderDate: '',
        restoredHeldReference: '',
        taxRegistrationType: null,
        subscriptionPurchase: null,
      }));
    };

    const matching = useOrderSessionStore();
    matching.tableSettings = { tables_enabled: true, table_mode: 'dynamic' };
    seedDynamicDraft();
    await matching.loadActiveTableOrder({ id: null, table_number: '41', section_name: 'Dynamic', status: 'available' });
    expect(matching.cart.map(item => item.name)).toEqual(['Dynamic item']);
    expect(matching.customerName).toBe('Dynamic Guest');

    setActivePinia(createPinia());
    const different = useOrderSessionStore();
    different.tableSettings = { tables_enabled: true, table_mode: 'dynamic' };
    seedDynamicDraft();
    await different.loadActiveTableOrder({ id: null, table_number: '42', section_name: 'Dynamic', status: 'available' });
    expect(different.cart).toEqual([]);
    expect(different.customerName).toBe('');
  });
});

describe('loadActiveTableOrder failure cleanup', () => {
  beforeEach(() => { setActivePinia(createPinia()); for (const k in lsStore) delete lsStore[k]; });

  it('clears the previous cart/session when an occupied table fails to load', async () => {
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, table_number: '1', status: 'occupied', current_order_id: 101 };
    s.cart = [{ id: 5, name: 'Old table item', price: 4, qty: 1 }];
    localStorage.setItem('pos_active_table', JSON.stringify(s.activeTable));
    localStorage.setItem('pos_cart', JSON.stringify(s.cart));
    localStorage.setItem('pos_order_context', JSON.stringify({
      version: 2,
      scope: { kind: 'table', id: '2', orderId: '202', splitCheckId: null, tableNumber: '2' },
      selectedOrderType: 4,
      subscriptionPurchase: null,
    }));

    global.fetch = vi.fn((url) => {
      if (String(url).includes('table-draft')) {
        return Promise.resolve({ json: () => Promise.resolve({ success: false }) });
      }
      return Promise.resolve({
        json: () => Promise.resolve({ success: false, message: 'table order disappeared' })
      });
    });

    await expect(s.loadActiveTableOrder({
      id: 2,
      table_number: '2',
      status: 'occupied',
      current_order_id: 202,
    })).rejects.toThrow(/table order disappeared/i);

    expect(s.activeTable).toBeNull();
    expect(s.cart).toEqual([]);
    expect(localStorage.getItem('pos_active_table')).toBeNull();
    expect(localStorage.getItem('pos_cart')).toBeNull();
    expect(localStorage.getItem('pos_order_context')).toBeNull();
  });
});

describe('loadTableWorkspace dead-table cleanup', () => {
  beforeEach(() => { setActivePinia(createPinia()); for (const k in lsStore) delete lsStore[k]; });

  it('clears cart storage when the active table was remotely vacated', async () => {
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, table_number: '1', status: 'occupied', current_order_id: 101 };
    s.cart = [{ id: 5, name: 'Old table item', price: 4, qty: 1 }];
    localStorage.setItem('pos_active_table', JSON.stringify(s.activeTable));
    localStorage.setItem('pos_cart', JSON.stringify(s.cart));

    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        settings: { tables_enabled: true, table_mode: 'fixed' },
        sections: [],
        tables: [{ id: 1, table_number: '1', status: 'available', current_order_id: null }],
      }),
    });

    await s.loadTableWorkspace({ force: true, skipActivation: true });

    expect(s.activeTable).toBeNull();
    expect(s.cart).toEqual([]);
    expect(localStorage.getItem('pos_active_table')).toBeNull();
    expect(localStorage.getItem('pos_cart')).toBeNull();
  });

  it('clears cart storage when the active table is no longer visible to this user', async () => {
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, table_number: '1', status: 'occupied', current_order_id: 101 };
    s.cart = [{ id: 5, name: 'Old table item', price: 4, qty: 1 }];
    localStorage.setItem('pos_active_table', JSON.stringify(s.activeTable));
    localStorage.setItem('pos_cart', JSON.stringify(s.cart));

    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        settings: { tables_enabled: true, table_mode: 'fixed' },
        sections: [],
        tables: [{ id: 2, table_number: '2', status: 'available', current_order_id: null }],
      }),
    });

    await s.loadTableWorkspace({ force: true, skipActivation: true });

    expect(s.activeTable).toBeNull();
    expect(s.cart).toEqual([]);
    expect(localStorage.getItem('pos_active_table')).toBeNull();
    expect(localStorage.getItem('pos_cart')).toBeNull();
  });

  it('does not clear split-check cart when refreshing real table workspace', async () => {
    const s = useOrderSessionStore();
    s.activeTable = { id: 77, table_number: 'Split 1', is_split: true };
    s.cart = [{ id: 5, name: 'Split item', price: 4, qty: 1 }];

    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        settings: { tables_enabled: true, table_mode: 'fixed' },
        sections: [],
        tables: [],
      }),
    });

    await s.loadTableWorkspace({ force: true, skipActivation: true });

    expect(s.activeTable.is_split).toBe(true);
    expect(s.cart.map(i => i.name)).toEqual(['Split item']);
  });
});

describe('updateActiveTableOrder seq-token guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    for (const k in lsStore) delete lsStore[k];
  });

  it('updateActiveTableOrder does not resurrect a left table session', async () => {
    const store = useOrderSessionStore();
    store.activeTable = { id: 7, table_number: '3', status: 'available', current_order_id: null };
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 2, tax_rate: 8 }];

    let resolveFetch;
    global.fetch = vi.fn().mockReturnValue(new Promise(res => { resolveFetch = res; }));

    const p = store.updateActiveTableOrder();

    store.clearActiveTableSession();

    resolveFetch({
      json: () => Promise.resolve({
        success: true,
        table_id: 7,
        table_number: '3',
        invoice_id: 99
      })
    });

    await p;

    expect(store.activeTable).toBeNull();
  });

  it('updateActiveTableOrder does not overwrite a newly switched table session', async () => {
    const store = useOrderSessionStore();
    store.activeTable = { id: 7, table_number: '3', status: 'available', current_order_id: null };
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 2, tax_rate: 8 }];

    let resolveFetch;
    global.fetch = vi.fn().mockReturnValue(new Promise(res => { resolveFetch = res; }));

    const p = store.updateActiveTableOrder();

    // switch to table 8
    store.activeTable = { id: 8, table_number: '4', status: 'available', current_order_id: null };
    store.tableSessionSeq++; // manually simulate sequence bump

    resolveFetch({
      json: () => Promise.resolve({
        success: true,
        table_id: 7,
        table_number: '3',
        invoice_id: 99
      })
    });

    await p;

    // activeTable should remain table 8
    expect(store.activeTable.id).toBe(8);
  });

  it('releases the processing state when a posted save becomes stale', async () => {
    const store = useOrderSessionStore();
    const ui = useOrderUiStore();
    store.activeTable = { id: 7, table_number: '3', status: 'available', current_order_id: null };
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 2, tax_rate: 8 }];

    let resolveFetch;
    global.fetch = vi.fn().mockReturnValue(new Promise(resolve => { resolveFetch = resolve; }));
    const saving = store.updateActiveTableOrder();
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledOnce());
    expect(ui.isProcessing).toBe(true);

    store.clearActiveTableSession();
    resolveFetch({ json: () => Promise.resolve({ success: true, table_id: 7, invoice_id: 99 }) });

    await expect(saving).resolves.toBe(false);
    expect(ui.isProcessing).toBe(false);
  });
});
