import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { EventEmitter } from 'node:events';

const lifecycle = vi.hoisted(() => ({ mounted: [], unmounted: [] }));
const connection = vi.hoisted(() => ({ socket: { value: null } }));
const route = vi.hoisted(() => ({ query: {} }));
const store = vi.hoisted(() => ({ tableSplitsList: null, fetchTableSplits: null }));
vi.mock('vue', async original => ({
  ...await original(), useSSRContext: () => ({ modules: new Set() }),
  onMounted: callback => lifecycle.mounted.push(callback),
  onUnmounted: callback => lifecycle.unmounted.push(callback),
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }), useRoute: () => route }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/useSocket.js', () => ({ useSocket: () => ({ ...connection, initSocket: () => connection.socket.value }) }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => ({ isProcessing: { value: false }, isHolding: { value: false } }) }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => ({ storeName: { value: 'S' }, storeAddress: { value: '' }, storePhone: { value: '' } }) }));
vi.mock('@/pos/usePosDialogFocus.js', () => ({ usePosDialogFocus: () => {} }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => ({
  tableSplitsList: store.tableSplitsList, tableSplitsError: { value: '' }, fetchTableSplits: store.fetchTableSplits,
  restoreTableSplit: vi.fn(), cancelSplitGroup: vi.fn(), editSplitGroup: vi.fn(),
}) }));
import TableSplits from '../../TableSplits.vue';

let scope;
const split = (id, parent) => ({ id, parent_invoice_id: parent, total: 10, cart_data: '{}' });
function mountBoard(rows, parentInvoiceId = null) {
  route.query = parentInvoiceId === null ? {} : { parent_invoice_id: parentInvoiceId };
  store.tableSplitsList = ref(rows);
  store.fetchTableSplits = vi.fn(async () => true);
  const page = scope.run(() => TableSplits.setup());
  lifecycle.mounted.forEach(callback => callback());
  expect(store.fetchTableSplits).toHaveBeenCalledTimes(1);
  store.fetchTableSplits.mockClear();
  return page;
}
const emit = payload => connection.socket.value.emit('held_orders_changed', payload);

beforeEach(() => {
  vi.useFakeTimers();
  scope = effectScope();
  lifecycle.mounted.length = 0; lifecycle.unmounted.length = 0;
  connection.socket.value = new EventEmitter();
  const win = new EventTarget();
  vi.stubGlobal('window', win);
  vi.stubGlobal('localStorage', { getItem: () => null });
});
afterEach(() => {
  lifecycle.unmounted.forEach(callback => callback());
  scope.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe('split board held_orders_changed handling', () => {
  it('drops a removed check that is on the board without a request', async () => {
    mountBoard([split(1, 101), split(2, 101)], '101');
    emit({ action: 'removed', held_order_id: 2, table_id: 5, parent_invoice_id: 101 });
    expect(store.tableSplitsList.value.map(row => row.id)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.fetchTableSplits).not.toHaveBeenCalled();
  });

  it('refetches the scope when a listed check settles, so paid counts stay current', async () => {
    mountBoard([split(1, 101), split(2, 101)], '101');
    emit({ action: 'settled', held_order_id: 2, table_id: 5, parent_invoice_id: 101 });
    await vi.advanceTimersByTimeAsync(250);
    expect(store.fetchTableSplits).toHaveBeenCalledTimes(1);
    expect(store.fetchTableSplits).toHaveBeenCalledWith({ parentInvoiceId: '101' });
  });

  it('ignores register holds, sales and single-table updates for unlisted bills', async () => {
    for (const scoped of ['101', null]) {
      mountBoard([split(1, 101)], scoped);
      for (let i = 0; i < 10; i++) {
        emit({ action: 'created', held_order_id: 4, table_id: null, parent_invoice_id: null });
        connection.socket.value.emit('new_order', { invoice_id: 9 });
        connection.socket.value.emit('table_update', { action: 'update_single_table', table: { id: 7, current_order_id: 555 } });
      }
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.fetchTableSplits).not.toHaveBeenCalled();
      lifecycle.unmounted.forEach(callback => callback()); lifecycle.unmounted.length = 0; lifecycle.mounted.length = 0;
    }
  });

  it('refreshes for a listed parent table update, a bulk table update and a reconnect', async () => {
    mountBoard([split(1, 101)], '101');
    connection.socket.value.emit('table_update', { action: 'update_single_table', table: { id: 7, current_order_id: 101 } });
    await vi.advanceTimersByTimeAsync(250);
    connection.socket.value.emit('table_update', {});
    await vi.advanceTimersByTimeAsync(250);
    window.dispatchEvent(new Event('socket_reconnected'));
    await vi.advanceTimersByTimeAsync(250);
    expect(store.fetchTableSplits).toHaveBeenCalledTimes(3);
  });

  it('refreshes when a removed check is not on the board', async () => {
    mountBoard([split(1, 101)], '101');
    emit({ action: 'removed', held_order_id: 9, table_id: 5, parent_invoice_id: 101 });
    expect(store.tableSplitsList.value.map(row => row.id)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(250);
    expect(store.fetchTableSplits).toHaveBeenCalledTimes(1);
    expect(store.fetchTableSplits).toHaveBeenCalledWith({ parentInvoiceId: '101' });
  });

  it("ignores another bill's events entirely while scoped to one parent invoice", async () => {
    mountBoard([split(1, 101)], '101');
    emit({ action: 'updated', held_order_id: 7, table_id: 6, parent_invoice_id: 202 });
    emit({ action: 'removed', held_order_id: 1, table_id: 6, parent_invoice_id: 202 });
    emit({ action: 'cleared', held_order_id: null, table_id: null, parent_invoice_id: '303' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.fetchTableSplits).not.toHaveBeenCalled();
    expect(store.tableSplitsList.value.map(row => row.id)).toEqual([1]);
  });

  it('still refreshes the all-splits board for any parent invoice', async () => {
    mountBoard([split(1, 101), split(3, 202)], null);
    emit({ action: 'updated', held_order_id: 7, table_id: 6, parent_invoice_id: 202 });
    await vi.advanceTimersByTimeAsync(250);
    expect(store.fetchTableSplits).toHaveBeenCalledTimes(1);
    emit({ action: 'settled', held_order_id: 3, table_id: 6, parent_invoice_id: 202 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.fetchTableSplits).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, { source: 'call_center' }, { action: 'updated', held_order_id: 1, parent_invoice_id: 101 }, { action: 'created', held_order_id: 4, table_id: 5 }])(
    'coalesces other payloads into the existing debounced refresh (%o)', async payload => {
      mountBoard([split(1, 101)], '101');
      emit(payload); emit(payload);
      expect(store.fetchTableSplits).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(store.fetchTableSplits).toHaveBeenCalledTimes(1);
      expect(store.tableSplitsList.value.map(row => row.id)).toEqual([1]);
    });

  it('stops reacting after leaving the board', async () => {
    mountBoard([split(1, 101)], '101');
    lifecycle.unmounted.forEach(callback => callback());
    lifecycle.unmounted.length = 0;
    expect(connection.socket.value.listenerCount('held_orders_changed')).toBe(0);
    emit({ action: 'removed', held_order_id: 1, parent_invoice_id: 101 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.tableSplitsList.value.map(row => row.id)).toEqual([1]);
    expect(store.fetchTableSplits).not.toHaveBeenCalled();
  });
});

describe('split board self-recovery', () => {
  it('a failed board read retries on the socket heartbeat and not while healthy', async () => {
    connection.socket.value.io = new EventEmitter();
    route.query = {};
    store.tableSplitsList = ref([]);
    store.fetchTableSplits = vi.fn(async () => false);
    scope.run(() => TableSplits.setup());
    lifecycle.mounted.forEach(callback => callback());
    await vi.advanceTimersByTimeAsync(0);
    store.fetchTableSplits.mockReset().mockResolvedValue(true);
    connection.socket.value.io.emit('ping');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.fetchTableSplits).toHaveBeenCalledTimes(1);
    connection.socket.value.io.emit('ping');
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.fetchTableSplits).toHaveBeenCalledTimes(1);
  });
});
