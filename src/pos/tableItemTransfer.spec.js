import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createTableOrderWorkflow } from './stores/orderSession/tableOrderWorkflow.js';
import { previewTableItemTransfer } from './stores/orderSession/orderSessionApi.js';
import { quantityText, quantityUnits, validQuantity } from '@/utils/itemQuantity.js';
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
let storage;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
    get length() { return storage.size; }, key: index => [...storage.keys()][index] });
  vi.stubGlobal('window', {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function harness() {
  const draft = Object.fromEntries(['cart', 'selectedCartIndex', 'orderNote', 'orderDiscount', 'editingInvoiceId', 'editingOrderId', 'originalSavedItems', 'selectedOrderType',
    'customerPhone', 'customerName', 'customerAddress', 'orderDate', 'hashNumber', 'serviceChargeSnapshot', 'activeOrderTaxInclusive', 'activeOrderReceiptTaxInclusive',
    'activeOrderTaxRegistrationType', 'autoServiceChargeRemoved', 'isTaxExempt'].map(key => [key, ref(null)]));
  draft.cart.value = []; draft.originalSavedItems.value = [];
  const api = { getTableOrder: vi.fn(async () => ({ response: { ok: true }, data: { success: true, version: 1, cart: [{ order_item_id: 12, qty: 3 }] } })),
    getTables: vi.fn(async () => ({ data: { success: true, tables: [{ id: 1, current_order_id: null, status: 'available' }, { id: 2, current_order_id: 22, status: 'occupied' }] } })),
    previewTableItemTransfer: vi.fn(async () => ({ response: { ok: true }, data: { success: true, source_version: 1, target_version: 4 } })) };
  const clearOrderDraft = vi.fn(() => { draft.cart.value = []; });
  const workflow = createTableOrderWorkflow({ api, ui: { resetTransient: vi.fn() }, readOrderDraft: () => draft, clearOrderDraft,
    can: () => true, getActor: () => ({ user: { id: 1 } }) });
  workflow.restaurantTables.value = [{ id: 1, current_order_id: 11, status: 'occupied' }, { id: 2, current_order_id: 22, status: 'occupied' }];
  const source = workflow.captureTableActionSource(workflow.restaurantTables.value[0]), target = workflow.restaurantTables.value[1];
  workflow.loadTableOrder(source, [{ id: 2, qty: 3, price: 2 }]); clearOrderDraft.mockClear();
  const quote = () => workflow.previewTableItems(source, target, { version: 1 }, [{ order_item_id: 12, quantity: '1' }]);
  return { workflow, draft, api, clearOrderDraft, source, quote };
}
describe('saved table item transfer client ownership', () => {
  it.each(['cart', 'note', 'discount'])('refuses an unsaved %s without sending a preview or losing edits', async change => {
    const { workflow, draft, api, source, quote } = harness();
    if (change === 'cart') draft.cart.value[0].qty++;
    if (change === 'note') draft.orderNote.value = 'No onions';
    if (change === 'discount') draft.orderDiscount.value = { type: 'fixed', value: 1 };
    const before = JSON.stringify(draft.cart.value);
    await expect(workflow.getTableItemsForTransfer(source)).rejects.toThrow('unsaved');
    await expect(quote()).rejects.toThrow('unsaved');
    expect(api.previewTableItemTransfer).not.toHaveBeenCalled(); expect(api.getTableOrder).not.toHaveBeenCalled();
    expect(JSON.stringify(draft.cart.value)).toBe(before);
  });
  it.each([false, true])('reconciles a lost reply once and preserves edits made during it (%s)', async changed => {
    const { workflow, draft, api, quote, clearOrderDraft } = harness(); const reviewed = await quote();
    api.transferTable = vi.fn(async payload => {
      expect([...storage.values()].some(value => JSON.parse(value).operation_id === payload.operation_id)).toBe(true);
      if (changed) draft.cart.value[0].qty = 9;
      throw new Error('Lost committed response');
    });
    api.getTableAction = vi.fn(async operationId => ({ response: { ok: true }, data: { committed: true, result: { operation_id: operationId, source_invoice_id: 11, target_invoice_id: 22 } } }));
    const a = workflow.moveTableItems(reviewed), b = workflow.moveTableItems(reviewed);
    expect((await a).success).toBe(true); await b;
    expect(api.transferTable).toHaveBeenCalledTimes(1);
    expect(workflow.pendingTableAction.value).toBeNull();
    if (changed) { expect(draft.cart.value[0].qty).toBe(9); expect(workflow.activeTable.value.current_order_id).toBe(11); expect(clearOrderDraft).not.toHaveBeenCalled(); }
    else { expect(workflow.activeTable.value).toBeNull(); expect(clearOrderDraft).toHaveBeenCalled(); }
  });
  it.each(['headers', 'body'])('bounds preview %s and releases the abort resources', async stage => {
    vi.useFakeTimers(); let signal;
    vi.stubGlobal('fetch', vi.fn((url, options) => { signal = options.signal; return stage === 'headers' ? new Promise(() => {}) : Promise.resolve({ json: () => new Promise(() => {}) }); }));
    const pending = expect(previewTableItemTransfer({})).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15000); await pending;
    expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves six-decimal quantities and rejects overflow or hidden rounding', () => {
    for (const value of ['0', '1', '10', '0.000001', '999999.999999']) expect(quantityText(quantityUnits(value))).toBe(value);
    expect(validQuantity('0.333333', 1)).toBe(true); expect(validQuantity('0.0000001', 1)).toBe(false);
    expect(validQuantity('', 1)).toBe(false); expect(validQuantity('1.1', 1)).toBe(false); expect(validQuantity('1000000', '1000000')).toBe(false);
  });
});
