import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, reactive } from 'vue';
import { EventEmitter } from 'node:events';
const hooks = vi.hoisted(() => ({ mounted: [], activated: [], deactivated: [], unmounted: [] }));
const mocks = vi.hoisted(() => ({ table: null, socket: { value: null }, generation: { value: 0 }, actor: null, push: vi.fn(), route: null, loadRoute: vi.fn(async () => ({})) }));
vi.mock('vue', async original => ({
  ...await original(), useSSRContext: () => ({ modules: new Set() }),
  onMounted: callback => hooks.mounted.push(callback), onActivated: callback => hooks.activated.push(callback),
  onDeactivated: callback => hooks.deactivated.push(callback), onUnmounted: callback => hooks.unmounted.push(callback),
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push, resolve: path => ({ matched: [{ components: { default: () => mocks.loadRoute(path) } }] }) }), useRoute: () => mocks.route }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, setLanguage: vi.fn() }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/pos/useAuth.js', () => ({ useAuth: () => ({ activeUser: mocks.actor }) }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => mocks.table }));
vi.mock('@/pos/useSocket.js', () => ({ useSocket: () => ({ socket: mocks.socket, connectionGeneration: mocks.generation, initSocket: () => mocks.socket.value }) }));
vi.mock('@/pos/useIdleTracker.js', () => ({ startIdleTracker: vi.fn(), stopIdleTracker: vi.fn() }));
vi.mock('@/pos/useCart.js', () => ({ useCart: () => ({}) }));
vi.mock('@/pos/useTerminal.js', () => ({ useTerminal: () => ({}) }));
import Floor from '../TableFloorPlan.vue';
import Splits from '../TableSplits.vue';
import { createTableOrderWorkflow } from '@/pos/stores/orderSession/tableOrderWorkflow.js';
import * as orderSessionApi from '@/pos/stores/orderSession/orderSessionApi.js';
let scope;
beforeEach(() => {
  scope = effectScope(); vi.useFakeTimers();
  for (const list of Object.values(hooks)) list.length = 0;
  mocks.socket.value = new EventEmitter(); mocks.socket.value.io = new EventEmitter(); mocks.actor = ref({ id: 1 }); mocks.generation.value = 0;
  mocks.route = reactive({ query: {} }); mocks.push.mockClear(); mocks.loadRoute.mockClear();
  mocks.table = {
    tableSettings: ref({ tables_enabled: true }), tableSections: ref([]), restaurantTables: ref([]),
    activeMode: ref(null), activeModeSourceTable: ref(null), joinSelectedChildIds: ref([]),
    tableSplitsList: ref([]), canSplitBillPermission: ref(true), tableWorkspaceLoaded: ref(true), tableWorkspaceLoadFailed: ref(false), isTableWorkspaceLoading: ref(false), dismissActiveQrDraft: vi.fn(),
    loadTableWorkspace: vi.fn(async () => {}), fetchTableSplits: vi.fn(async () => true),
    pendingTableAction: ref(null), reconcileTableAction: vi.fn(async () => ({ success: false, pending: false })),
    retryTableAction: vi.fn(), captureTableActionSource: table => table,
    loadActiveTableOrder: vi.fn(async () => {}),
    transferTableOrder: vi.fn(async () => ({ success: true, message: 'Moved' })),
  };
  vi.stubGlobal('window', new EventTarget());
  window.showPosAlert = vi.fn(async () => {});
  vi.stubGlobal('document', { getElementById: () => null });
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('sessionStorage', { getItem: () => '{"id":1,"role":"admin"}' });
});
afterEach(() => { hooks.unmounted.forEach(fn => fn()); scope.stop(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function mountFloor() {
  const page = scope.run(() => Floor.setup({}, { expose: () => {} }));
  hooks.mounted.forEach(fn => fn()); hooks.activated.forEach(fn => fn());
  await vi.advanceTimersByTimeAsync(0);
  return page;
}

describe('floor and split board read lifecycle', () => {
  it('selects an occupied independent table for seating without opening or changing its bill', async () => {
    const page = await mountFloor();
    mocks.table.activeMode.value = 'join';
    mocks.table.activeModeSourceTable.value = { id: 1, current_order_id: 101, status: 'occupied' };
    await page.handleTableClick({ id: 2, current_order_id: 202, status: 'occupied' });
    expect(mocks.table.joinSelectedChildIds.value).toEqual([2]);
    expect(mocks.table.loadActiveTableOrder).not.toHaveBeenCalled();
    await page.handleTableClick({ id: 2, current_order_id: 202, status: 'occupied' });
    expect(mocks.table.joinSelectedChildIds.value).toEqual([]);
  });

  it.each(['source', 'target', 'member'])('rejects printed seating %s without selecting a target', async printed => {
    const page = await mountFloor();
    window.showPosToast = vi.fn();
    mocks.table.activeMode.value = 'join';
    mocks.table.activeModeSourceTable.value = { id: 1, status: printed === 'source' ? 'printed' : 'occupied' };
    mocks.table.restaurantTables.value = [{ id: 3, seating_parent_id: 2, status: printed === 'member' ? 'printed' : 'occupied' }];
    await page.handleTableClick({ id: 2, current_order_id: 202, status: printed === 'target' ? 'printed' : 'occupied' });
    expect(mocks.table.joinSelectedChildIds.value).toEqual([]);
    expect(window.showPosToast).toHaveBeenCalledWith('Tables with a printed bill cannot be joined.', 'warning');
  });

  it('refuses an occupied transfer target instead of offering to swap or merge bills', async () => {
    const page = await mountFloor();
    window.showPosToast = vi.fn();
    mocks.table.activeMode.value = 'transfer';
    mocks.table.activeModeSourceTable.value = { id: 1, current_order_id: 101, status: 'occupied' };
    await page.handleTableClick({ id: 2, current_order_id: 202, status: 'occupied' });
    expect(mocks.table.transferTableOrder).not.toHaveBeenCalled();
    expect(mocks.table.activeMode.value).toBe('transfer');
    expect(window.showPosToast).toHaveBeenCalledWith('Target table is occupied. Choose an available table.', 'warning');
  });

  // The real store workflow and API client run down to fetch: the removed manager-PIN
  // contract must not reappear in the request body or as a PIN prompt on a 4xx reply.
  async function transferThroughWorkflow(reply) {
    const storage = new Map();
    vi.stubGlobal('localStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
      get length() { return storage.size; }, key: index => [...storage.keys()][index] });
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || 'GET', body: options.body });
      const body = String(url).includes('tables/transfer') ? reply(JSON.parse(options.body)) : { status: 200, data: { success: true, tables: [] } };
      return { ok: body.status < 400, status: body.status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body.data, text: async () => JSON.stringify(body.data) };
    }));
    const workflow = createTableOrderWorkflow({ api: orderSessionApi, ui: reactive({ resetTransient: vi.fn(), activeModeSourceTable: mocks.table.activeModeSourceTable, tableActionError: '' }),
      readOrderDraft: () => ({ cart: ref([]), originalSavedItems: ref([]), orderNote: ref(''), orderDiscount: ref(null) }), clearOrderDraft: vi.fn(), can: () => true, getActor: () => ({ user: { id: 1 } }) });
    workflow.restaurantTables.value = [{ id: 1, current_order_id: 101, status: 'occupied' }, { id: 3, current_order_id: null, status: 'available' }];
    Object.assign(mocks.table, { restaurantTables: workflow.restaurantTables, transferTableOrder: workflow.transferTableOrder });
    const page = await mountFloor();
    window.showPosToast = vi.fn();
    mocks.table.activeMode.value = 'transfer';
    mocks.table.activeModeSourceTable.value = workflow.captureTableActionSource(workflow.restaurantTables.value[0]);
    await page.handleTableClick(workflow.restaurantTables.value[1]);
    await vi.advanceTimersByTimeAsync(0);
    const posted = requests.filter(request => request.url.includes('tables/transfer') && request.method === 'POST');
    expect(posted).toHaveLength(1);
    return { page, body: JSON.parse(posted[0].body) };
  }

  it('transfers to a free table without a manager PIN and leaves transfer mode', async () => {
    const { body } = await transferThroughWorkflow(payload => ({ status: 200, data: { success: true, operation_id: payload.operation_id, message: 'Moved' } }));
    expect(body).toMatchObject({ sourceTableId: 1, targetTableId: 3, action: 'transfer' });
    expect(body).not.toHaveProperty('managerPin');
    expect(mocks.table.activeMode.value).toBeNull();
    expect(mocks.table.activeModeSourceTable.value).toBeNull();
    expect(window.showPosToast).toHaveBeenCalledWith('Moved', 'success');
    expect(window.showPosAlert).not.toHaveBeenCalled();
  });

  it('shows a PIN_REQUIRED transfer rejection as an alert, never as a manager PIN prompt', async () => {
    const { page, body } = await transferThroughWorkflow(() => ({ status: 403, data: { success: false, code: 'PIN_REQUIRED', message: 'Manager PIN required' } }));
    expect(body).not.toHaveProperty('managerPin');
    expect(page.showPinModal.value).toBe(false);
    expect(window.showPosAlert).toHaveBeenCalledWith('Manager PIN required');
  });

  it('opens an independent seating child by its own bill identity', async () => {
    const page = await mountFloor();
    const table = { id: 2, seating_parent_id: 1, parent_table_id: null, current_order_id: 202 };
    await page.openTable(table);
    expect(mocks.table.loadActiveTableOrder).toHaveBeenCalledWith(table);
  });

  it.each([null, 77])('opens split bill 101 directly from parent/child %s without replacing the draft', async parentId => {
    const page = await mountFloor();
    await page.openTable({ id: 1, parent_table_id: parentId, current_order_id: 101, active_split_count: 2 });
    expect(mocks.table.loadActiveTableOrder).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith({ path: '/table-splits', query: { parent_invoice_id: '101' } });
  });

  it('recovers a stale zero-count floor from the structured split-parent rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.table.loadActiveTableOrder.mockRejectedValue(Object.assign(new Error('Split now open'), { code: 'SPLIT_CHECKS_OPEN' }));
    const page = await mountFloor();
    await page.openTable({ id: 1, current_order_id: 101, active_split_count: 0 });
    expect(mocks.push).toHaveBeenCalledWith({ path: '/table-splits', query: { parent_invoice_id: '101' } });
    expect(window.showPosAlert).not.toHaveBeenCalled();
  });

  it('refreshes the requested bill on query changes and discards a previous preview', async () => {
    mocks.route.query = { parent_invoice_id: '101' };
    const page = scope.run(() => Splits.setup()); hooks.mounted.forEach(fn => fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.table.fetchTableSplits).toHaveBeenLastCalledWith({ parentInvoiceId: '101' });
    page.openPreview({ id: 1 });
    mocks.route.query = { parent_invoice_id: '202' };
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.table.fetchTableSplits).toHaveBeenLastCalledWith({ parentInvoiceId: '202' });
    expect(page.showPreviewModal.value).toBe(false);
    mocks.route.query = {};
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.table.fetchTableSplits).toHaveBeenLastCalledWith({ parentInvoiceId: null });
  });

  it('groups by server invoice/table identity despite identical names and conflicting cart metadata', () => {
    mocks.table.tableSplitsList.value = [
      { id: 1, table_id: 11, parent_invoice_id: 101, reference_name: 'Table 1 - Seat 1', cart_data: '{"parent_invoice_id":999,"items":[]}' },
      { id: 2, table_id: 22, parent_invoice_id: 202, reference_name: 'Table 1 - Seat 2', cart_data: '{"parent_invoice_id":999,"items":[]}' },
      { id: 3, table_id: 33, reference_name: 'Table 1 - Seat 3', cart_data: '[]' },
      { id: 4, table_id: 44, reference_name: 'Table 1 - Seat 4', cart_data: '[]' },
    ];
    const page = scope.run(() => Splits.setup());
    expect(page.groupedTables.value.map(group => group.key)).toEqual(['invoice:101', 'invoice:202', 'table:33', 'table:44']);
  });

  it('loads the first floor snapshot once and re-reads on return only when something changed while away', async () => {
    mocks.table.restaurantTables.value = [{ id: 3, status: 'available', qr_draft_count: 0 }];
    await mountFloor();
    expect(mocks.table.loadTableWorkspace).toHaveBeenCalledTimes(1);
    const returnToFloor = async (whileAway = () => {}) => {
      mocks.table.loadTableWorkspace.mockClear();
      hooks.deactivated.forEach(fn => fn());
      whileAway();
      hooks.activated.forEach(fn => fn());
      await vi.advanceTimersByTimeAsync(300);
      return mocks.table.loadTableWorkspace.mock.calls;
    };
    // Nothing happened (or only row patches the store applies in place): no read.
    expect(await returnToFloor()).toEqual([]);
    expect(await returnToFloor(() => {
      mocks.socket.value.emit('table_update', { action: 'update_single_table', table: { id: 3, status: 'occupied' } });
      mocks.socket.value.emit('table_draft_changed', { tableId: 3, itemCount: 2 });
      mocks.socket.value.emit('held_orders_changed', { action: 'created', held_order_id: 5, table_id: null, parent_invoice_id: null });
    })).toEqual([]);
    expect(mocks.table.restaurantTables.value[0]).toMatchObject({ status: 'occupied', qr_draft_count: 2 });
    // A structural event, a table-bound held event or a reconnect while away: one read.
    expect(await returnToFloor(() => mocks.socket.value.emit('table_update', { action: 'refresh_tables' })))
      .toEqual([[{ force: true, skipActivation: true }]]);
    expect(await returnToFloor(() => mocks.socket.value.emit('held_orders_changed', { action: 'cleared' })))
      .toEqual([[{ force: true, skipActivation: true }]]);
    expect(await returnToFloor(() => { mocks.generation.value += 1; }))
      .toEqual([[{ force: true, skipActivation: true }]]);
    // A refresh queued but cancelled by leaving is not lost.
    mocks.socket.value.emit('table_update', {});
    expect(await returnToFloor()).toEqual([[{ force: true, skipActivation: true }]]);
    // A failed snapshot is retried on return.
    mocks.table.tableWorkspaceLoadFailed.value = true;
    expect(await returnToFloor()).toEqual([[{ force: true, skipActivation: true }]]);
  });

  it('coalesces ten floor notifications and cancels queued reads when hidden', async () => {
    await mountFloor(); mocks.table.loadTableWorkspace.mockClear();
    for (let i = 0; i < 10; i++) {
      mocks.socket.value.emit('held_orders_changed');
      mocks.socket.value.emit('table_update', {});
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.table.loadTableWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.table.loadTableWorkspace).toHaveBeenLastCalledWith({ force: true, skipActivation: true });
    expect(mocks.table.fetchTableSplits).not.toHaveBeenCalled();
    mocks.socket.value.emit('held_orders_changed');
    mocks.socket.value.emit('table_update', {});
    hooks.deactivated.forEach(fn => fn());
    mocks.table.fetchTableSplits.mockClear(); mocks.table.loadTableWorkspace.mockClear();
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.table.fetchTableSplits).not.toHaveBeenCalled();
    expect(mocks.table.loadTableWorkspace).not.toHaveBeenCalled();
  });

  it('ignores register-hold events and still reloads for table, split and cleared held events', async () => {
    await mountFloor(); mocks.table.loadTableWorkspace.mockClear();
    for (const action of ['created', 'claimed', 'updated', 'released', 'fired', 'settled', 'removed']) {
      mocks.socket.value.emit('held_orders_changed', { action, held_order_id: 5, table_id: null, parent_invoice_id: null });
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.table.loadTableWorkspace).not.toHaveBeenCalled();
    for (const payload of [{ action: 'updated', held_order_id: 5, table_id: 3, parent_invoice_id: null },
      { action: 'settled', held_order_id: 5, table_id: null, parent_invoice_id: 101 }, { action: 'cleared' }, { source: 'call_center' }]) {
      mocks.socket.value.emit('held_orders_changed', payload);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(mocks.table.loadTableWorkspace).toHaveBeenCalledTimes(4);
  });

  it('uses server counts and bill identity for aliases and repeated table numbers', async () => {
    mocks.table.restaurantTables.value = [
      { id: 1, section_id: 1, table_number: '1', current_order_id: 101, active_split_count: '4' },
      { id: 2, section_id: 1, table_number: '2', parent_table_id: 1, current_order_id: '101', active_split_count: 4 },
      { id: 3, section_id: 2, table_number: '1', current_order_id: 202, active_split_count: 2 },
      // Only this accessible alias is in the snapshot; its parent is outside the actor's sections.
      { id: 4, section_id: 1, table_number: '4', parent_table_id: 99, current_order_id: 303, active_split_count: 3 },
      { id: 5, section_id: 1, table_number: '5', current_order_id: null, active_split_count: 0 },
    ];
    // Stale board details, including another section, must never determine floor counts.
    mocks.table.tableSplitsList.value = [{ id: 9, reference_name: 'Table 1 - Seat 1', parent_invoice_id: 999 }];
    const page = await mountFloor();
    expect(mocks.table.restaurantTables.value.map(row => page.getTableSplitsCount(row))).toEqual([4, 4, 2, 3, 0]);
    expect(page.totalTableSplits.value).toBe(9);
    expect(mocks.table.fetchTableSplits).not.toHaveBeenCalled();
    mocks.socket.value.emit('table_update', { action: 'update_single_table', table: { id: 3, active_split_count: 1 } });
    expect(page.getTableSplitsCount(mocks.table.restaurantTables.value[2])).toBe(1);
    expect(page.totalTableSplits.value).toBe(8);
    expect(mocks.table.loadTableWorkspace).toHaveBeenCalledTimes(1);
  });

  it('refreshes floor counts on reconnect without reading split details, and stops on exit', async () => {
    await mountFloor(); mocks.table.loadTableWorkspace.mockClear();
    window.dispatchEvent(new Event('socket_reconnected'));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.table.loadTableWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.table.loadTableWorkspace).toHaveBeenLastCalledWith({ force: true, skipActivation: true });
    expect(mocks.table.fetchTableSplits).not.toHaveBeenCalled();
    hooks.deactivated.forEach(fn => fn()); mocks.table.loadTableWorkspace.mockClear();
    window.dispatchEvent(new Event('socket_reconnected'));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.table.loadTableWorkspace).not.toHaveBeenCalled();
  });

  it('runs the minute clock only while an occupied table is visible, and stops it when hidden', async () => {
    const page = await mountFloor();
    const timers = () => vi.getTimerCount();
    const idle = timers();
    page.activeSection.value = 1;
    mocks.table.restaurantTables.value = [{ id: 1, section_id: 1, status: 'available' }];
    expect(timers()).toBe(idle);
    mocks.table.restaurantTables.value = [{ id: 1, section_id: 1, current_order_id: 5, active_order_created_at: '2026-01-01 10:00:00' }];
    expect(timers()).toBe(idle + 1);
    await vi.advanceTimersByTimeAsync(60000 - (Date.now() % 60000));
    expect(page.nowTime.value % 60000).toBe(0);
    expect(timers()).toBe(idle + 1);
    const visibleTime = page.nowTime.value;
    hooks.deactivated.forEach(fn => fn());
    expect(timers()).toBe(idle);
    await vi.advanceTimersByTimeAsync(120000);
    expect(page.nowTime.value).toBe(visibleTime);
    hooks.activated.forEach(fn => fn());
    expect(page.nowTime.value).toBe(Date.now());
    mocks.table.restaurantTables.value = [];
    expect(timers()).toBe(idle);
  });

  it('does not start a split read after leaving during floor loading', async () => {
    let finish;
    mocks.table.loadTableWorkspace.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await mountFloor();
    hooks.deactivated.forEach(fn => fn());
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.table.fetchTableSplits).not.toHaveBeenCalled();
  });

  it('refreshes the split board on reconnect and removes that listener on exit', async () => {
    scope.run(() => Splits.setup()); hooks.mounted.forEach(fn => fn());
    await vi.advanceTimersByTimeAsync(0); mocks.table.fetchTableSplits.mockClear();
    window.dispatchEvent(new Event('socket_reconnected'));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.table.fetchTableSplits).toHaveBeenCalledTimes(1);
    hooks.unmounted.forEach(fn => fn()); mocks.table.fetchTableSplits.mockClear();
    window.dispatchEvent(new Event('socket_reconnected'));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.table.fetchTableSplits).not.toHaveBeenCalled();
  });

  it('keeps split loading active until the newest caller finishes', async () => {
    const pending = [];
    mocks.table.fetchTableSplits.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const page = scope.run(() => Splits.setup());
    const first = page.refreshSplits(); const second = page.refreshSplits();
    pending[0](true); await first;
    expect(page.isLoading.value).toBe(true);
    pending[1](true); await second;
    expect(page.isLoading.value).toBe(false);
  });

  it('shows the skeleton until the first floor read settles, not just until activation', async () => {
    let finish;
    mocks.table.tableWorkspaceLoaded.value = false;
    mocks.table.loadTableWorkspace.mockImplementation(() => { mocks.table.isTableWorkspaceLoading.value = true; return new Promise(resolve => { finish = () => { mocks.table.isTableWorkspaceLoading.value = false; mocks.table.tableWorkspaceLoaded.value = true; resolve(); }; }); });
    const page = await mountFloor();
    expect(page.showSkeleton.value).toBe(true);
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(page.showSkeleton.value).toBe(false);
  });

  it('a failed first floor read retries on the heartbeat and focus only while failed and visible', async () => {
    mocks.table.tableWorkspaceLoaded.value = false;
    mocks.table.loadTableWorkspace.mockImplementation(async () => { mocks.table.tableWorkspaceLoadFailed.value = true; });
    await mountFloor(); mocks.table.loadTableWorkspace.mockClear();
    mocks.socket.value.io.emit('ping'); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.table.loadTableWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.table.loadTableWorkspace).toHaveBeenLastCalledWith({ force: true, skipActivation: true });
    mocks.table.loadTableWorkspace.mockImplementation(async () => { mocks.table.tableWorkspaceLoadFailed.value = false; });
    window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.table.loadTableWorkspace).toHaveBeenCalledTimes(2);
    mocks.socket.value.io.emit('ping'); window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.table.loadTableWorkspace).toHaveBeenCalledTimes(2);
    mocks.table.tableWorkspaceLoadFailed.value = true;
    hooks.deactivated.forEach(fn => fn());
    mocks.socket.value.io.emit('ping'); window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.table.loadTableWorkspace).toHaveBeenCalledTimes(2);
  });

  it('keeps the floor mounted while a table opens and blocks a second open', async () => {
    let finish;
    mocks.table.loadActiveTableOrder.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const page = await mountFloor();
    const opening = page.handleTableClick({ id: 5 });
    expect(page.showSkeleton.value).toBe(false);
    expect(page.pendingTableIds.value).toEqual([5]);
    await page.handleTableClick({ id: 6 });
    expect(mocks.table.loadActiveTableOrder).toHaveBeenCalledTimes(1);
    finish(); await opening;
    expect(page.pendingTableIds.value).toEqual([]);
  });

  it('warms the POS chunk at idle after the first floor snapshot, and not after a failed one', async () => {
    const idle = [];
    window.requestIdleCallback = fn => idle.push(fn);
    await mountFloor();
    expect(mocks.loadRoute).not.toHaveBeenCalled();
    idle.forEach(fn => fn());
    expect(mocks.loadRoute).toHaveBeenCalledWith('/pos');
    hooks.unmounted.forEach(fn => fn()); for (const list of Object.values(hooks)) list.length = 0;
    idle.length = 0; mocks.loadRoute.mockClear();
    mocks.table.loadTableWorkspace.mockRejectedValue(new Error('offline'));
    window.showPosToast = vi.fn();
    await mountFloor();
    idle.forEach(fn => fn());
    expect(mocks.loadRoute).not.toHaveBeenCalled();
  });

  it('keeps the table pending until POS navigation settles and frees the floor when it fails', async () => {
    let failNavigation;
    mocks.push.mockImplementation(() => new Promise((_, reject) => { failNavigation = reject; }));
    const page = await mountFloor();
    const opening = page.handleTableClick({ id: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(page.pendingTableIds.value).toEqual([5]);
    failNavigation(new Error('Failed to fetch dynamically imported module'));
    await opening;
    expect(page.pendingTableIds.value).toEqual([]);
    expect(window.showPosAlert).not.toHaveBeenCalled();
  });

  it('checks an unconfirmed transfer read-only on the heartbeat and on reconnect', async () => {
    mocks.table.pendingTableAction.value = { type: 'transfer' };
    await mountFloor(); mocks.table.reconcileTableAction.mockClear();
    mocks.socket.value.io.emit('ping'); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.table.reconcileTableAction).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('socket_reconnected')); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.table.reconcileTableAction).toHaveBeenCalledTimes(2);
    expect(mocks.table.retryTableAction).not.toHaveBeenCalled();
    mocks.table.pendingTableAction.value = null;
    mocks.socket.value.io.emit('ping'); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.table.reconcileTableAction).toHaveBeenCalledTimes(2);
  });
  it('moves focus into the action sheet and the manager PIN dialog, closes each on Escape and restores focus', async () => {
    const doc = new EventTarget();
    const focusable = name => ({ name, isConnected: true, getClientRects: () => [{}], matches: () => false, closest: () => null, focus() { doc.activeElement = this; } });
    const trigger = focusable('trigger');
    doc.activeElement = trigger; doc.getElementById = () => null;
    vi.stubGlobal('document', doc);
    const panel = name => {
      const initial = focusable(`${name} initial`);
      return Object.assign(focusable(name), { initial, querySelector: () => initial, querySelectorAll: () => [initial], contains: node => node === initial });
    };
    const page = await mountFloor();
    for (const [open, dialog] of [[page.showActionSheet, page.actionSheetDialog], [page.showPinModal, page.pinDialog]]) {
      const shown = panel(open === page.showPinModal ? 'pin' : 'actions');
      dialog.value = shown;
      open.value = true;
      await vi.advanceTimersByTimeAsync(0);
      expect(doc.activeElement).toBe(shown.initial);
      doc.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(open.value).toBe(false);
      expect(doc.activeElement).toBe(trigger);
    }
  });
});

describe('floor freshness', () => {
  it('a row update that lands during a full load wins over the older list', async () => {
    const replies = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      const gate = Promise.withResolvers(); replies.push(gate);
      const tables = await gate.promise;
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ success: true, tables, sections: [], settings: {} }), text: async () => '' };
    }));
    const workflow = createTableOrderWorkflow({ api: orderSessionApi, ui: reactive({ resetTransient: vi.fn(), tableActionError: '' }),
      readOrderDraft: () => ({ cart: ref([]), originalSavedItems: ref([]), orderNote: ref(''), orderDiscount: ref(null) }), clearOrderDraft: vi.fn(), can: () => true, getActor: () => ({ user: { id: 1 } }) });
    workflow.restaurantTables.value = [{ id: 7, status: 'occupied', current_order_id: 70 }];
    Object.assign(mocks.table, { restaurantTables: workflow.restaurantTables, isTableWorkspaceLoading: workflow.isTableWorkspaceLoading, loadTableWorkspace: workflow.loadTableWorkspace });
    await mountFloor();
    expect(replies).toHaveLength(1); // the mount read is in flight with the old row
    mocks.socket.value.emit('table_update', { action: 'update_single_table', table: { id: 7, status: 'available', current_order_id: null } });
    replies[0].resolve([{ id: 7, status: 'occupied', current_order_id: 70 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(replies).toHaveLength(2); // one follow-up read
    replies[1].resolve([{ id: 7, status: 'available', current_order_id: null }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(workflow.restaurantTables.value[0].status).toBe('available');
    expect(replies).toHaveLength(2);
  });

  it('reloads the floor once when a tables setting changes, and ignores unrelated keys', async () => {
    await mountFloor();
    mocks.table.loadTableWorkspace.mockClear();
    mocks.socket.value.emit('settings_changed', { keys: ['store_name'] });
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.table.loadTableWorkspace).not.toHaveBeenCalled();
    mocks.socket.value.emit('settings_changed', { keys: ['table_mode'] });
    mocks.socket.value.emit('settings_changed', { keys: ['tables_enabled'] });
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.table.loadTableWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.table.loadTableWorkspace).toHaveBeenCalledWith({ force: true, skipActivation: true });
    hooks.unmounted.forEach(fn => fn());
    expect(mocks.socket.value.listenerCount('settings_changed')).toBe(0);
  });
});
