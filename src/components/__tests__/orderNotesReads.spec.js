import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, nextTick } from 'vue';
import { EventEmitter } from 'node:events';

const lifecycle = vi.hoisted(() => ({ mounted: [], unmounted: [] }));
const access = vi.hoisted(() => ({ held: true, history: true }));
const connection = vi.hoisted(() => ({ socket: { value: null } }));
vi.mock('vue', async original => ({
  ...await original(), useSSRContext: () => ({ modules: new Set() }),
  onMounted: callback => lifecycle.mounted.push(callback),
  onUnmounted: callback => lifecycle.unmounted.push(callback),
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('@/pos/usePermissions.js', () => ({ usePermissions: () => ({ can: permission => permission === 'pos.hold_orders' ? access.held : access.history }) }));
vi.mock('@/pos/useSocket.js', () => ({ useSocket: () => ({ ...connection, initSocket: () => connection.socket.value }) }));
const cart = vi.hoisted(() => {
  const state = { source: null };
  return {
    restoreHeldOrder: () => {},
    markServerCanonicalRestore: () => { state.source = 'server'; },
    markLocalFallbackRestore: () => { state.source = 'local'; },
    consumeRestoreSource: () => { const source = state.source; state.source = null; return source; },
  };
});
vi.mock('@/pos/useCart.js', () => ({ useCart: () => cart }));
vi.mock('@/pos/useTables.js', () => ({ useTables: () => ({ clearActiveTableSession: () => {} }) }));
const terminal = vi.hoisted(() => ({ ensureSettings: null, loadSettings: null }));
vi.mock('@/pos/useTerminal.js', async () => {
  const { ref } = await vi.importActual('vue');
  return { useTerminal: () => ({ storeName: ref('Fixture'), storeAddress: ref(''), storePhone: ref(''), ensureSettings: (...a) => terminal.ensureSettings(...a), loadSettings: (...a) => terminal.loadSettings(...a) }) };
});
vi.mock('../OrderNoteCard.vue', () => ({ default: {} }));
import OrderNotes from '../OrderNotes.vue';
import { planActivationCartRefresh } from '@/pos/activationCartRefresh.js';

let scope;
const response = (data, ok = true) => ({ ok, json: async () => data });
const held = id => response({ success: true, data: [{ id, cart_data: '{}' }] });
function mountSetup() { return scope.run(() => OrderNotes.setup({}, { expose: () => {} })); }
function defaults(url) {
  if (String(url).includes('settings')) return response({ success: true, store_name: 'Fixture' });
  if (String(url).includes('order_types')) return response({ success: true, data: [] });
  if (String(url).includes('order_notes')) return response({ success: true, orders: [{ invoice_id: 2 }] });
  return held(1);
}
beforeEach(() => {
  scope = effectScope();
  lifecycle.mounted.length = 0; lifecycle.unmounted.length = 0;
  access.held = true; access.history = true;
  connection.socket.value = new EventEmitter();
  const win = new EventTarget();
  win.matchMedia = () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('window', win);
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('fetch', vi.fn(async url => defaults(url)));
  terminal.ensureSettings = vi.fn(async () => true);
  terminal.loadSettings = vi.fn(async () => true);
});
afterEach(() => {
  lifecycle.unmounted.forEach(callback => callback());
  scope.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe('held and history board read ownership', () => {
  it('releases a stalled body and lets the queued refresh recover', async () => {
    vi.useFakeTimers(); access.history = false;
    fetch.mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) }).mockResolvedValueOnce(held(21));
    const page = mountSetup();
    page.fetchOrders(); page.fetchOrders();
    await vi.advanceTimersByTimeAsync(15000);
    expect(page.isLoading.value).toBe(false);
    expect(page.heldOrdersList.value.map(order => order.id)).toEqual([21]);
    expect(page.loadError.value).toBe('');
  });

  it('updates held card quantities, notes, totals and claim state from each replacement snapshot', async () => {
    access.history = false;
    const page = mountSetup();
    const snapshot = (qty, version) => response({ success: true, data: [Object.freeze({
      id: 1, version, claim_owner_name: `Owner ${version}`,
      cart_data: JSON.stringify({ items: [{ id: 4, name: 'Meal', qty, price: 3, note: `Note ${version}` }] }),
    })] });
    fetch.mockResolvedValueOnce(snapshot(1, 1)).mockResolvedValueOnce(snapshot(2, 2));
    await page.fetchOrders();
    expect(page.processedHeldOrders.value[0].total).toBe(3);
    await page.fetchOrders();
    expect(page.processedHeldOrders.value[0]).toMatchObject({ total: 6, items: [{ quantity: 2, note: 'Note 2' }], raw_held_data: { version: 2, claim_owner_name: 'Owner 2' } });
  });

  it('loads only the visible tab and starts independent metadata/list reads together', async () => {
    const pending = [];
    fetch.mockImplementation(url => new Promise(resolve => pending.push({ url, resolve })));
    const page = mountSetup();
    const startup = lifecycle.mounted[0]();
    expect(pending.map(item => item.url).sort()).toEqual(['api/pos/order_types', 'api/pos/held_orders'].sort());
    for (const item of pending) item.resolve(defaults(item.url));
    await startup;
    fetch.mockImplementation(async url => defaults(url)); fetch.mockClear();
    page.showHistory.value = true;
    await vi.waitFor(() => expect(page.orders.value).toHaveLength(1));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['api/pos/order_notes?limit=200']);
    page.showHistory.value = false;
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1][0]).toBe('api/pos/held_orders');
  });

  it('switches tabs immediately and ignores a delayed previous tab and its queued refresh', async () => {
    const pending = [];
    fetch.mockImplementation((url, options) => new Promise(resolve => pending.push({ url, options, resolve })));
    const page = mountSetup();
    const old = page.fetchOrders();
    const queued = page.fetchOrders();
    page.showHistory.value = true;
    await nextTick();
    expect(pending).toHaveLength(2);
    expect(pending[0].options.signal.aborted).toBe(true);
    expect(pending[1].url).toContain('order_notes');
    pending[1].resolve(defaults(pending[1].url));
    await vi.waitFor(() => expect(page.isLoading.value).toBe(false));
    pending[0].resolve(response({ success: false }, false));
    await Promise.all([old, queued]);
    expect(page.loadError.value).toBe('');
    expect(page.orders.value[0].invoice_id).toBe(2);
    expect(pending).toHaveLength(2);
  });

  it('refreshes metadata on settings changes and rejects late obsolete metadata', async () => {
    const page = mountSetup();
    await lifecycle.mounted[0]();
    const pending = [];
    fetch.mockImplementation(url => new Promise(resolve => pending.push({ url, resolve })));
    connection.socket.value.emit('settings_changed', { keys: ['store_name', 'order_types'] });
    connection.socket.value.emit('settings_changed', { keys: ['store_name', 'order_types'] });
    expect(terminal.loadSettings).toHaveBeenCalledWith({ force: true });
    expect(pending).toHaveLength(2);
    pending[1].resolve(response({ success: true, data: [{ id: 1, name: 'New type' }] }));
    await vi.waitFor(() => expect(page.orderTypesList.value[0]?.name).toBe('New type'));
    pending[0].resolve(response({ success: true, data: [{ id: 1, name: 'Old type' }] }));
    await nextTick(); await Promise.resolve();
    expect(page.orderTypesList.value[0].name).toBe('New type');
  });

  it('shows the held board while store settings are still loading', async () => {
    terminal.ensureSettings = vi.fn(() => new Promise(() => {}));
    access.history = false;
    const page = mountSetup();
    await lifecycle.mounted[0]();
    expect(page.metadataLoading.value).toBe(false);
    expect(page.heldOrdersList.value).toHaveLength(1);
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain('api/system/settings');
  });

  it('coalesces concurrent refreshes and waits for the final snapshot', async () => {
    access.history = false;
    const pending = [];
    fetch.mockImplementation((url, options) => new Promise(resolve => pending.push({ resolve, options })));
    const page = mountSetup();
    const first = page.fetchOrders();
    const joined = page.fetchOrders();
    for (let i = 0; i < 10; i++) page.fetchOrders();
    expect(fetch).toHaveBeenCalledTimes(1);
    pending[0].resolve(held(30));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(page.isLoading.value).toBe(true);
    pending[1].resolve(held(31));
    await Promise.all([first, joined]);
    expect(page.heldOrdersList.value.map(order => order.id)).toEqual([31]);
    expect(page.isLoading.value).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('publishes progress and releases the first caller even if more events keep arriving', async () => {
    access.history = false;
    const pending = [];
    fetch.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const page = mountSetup();
    let firstFinished = false;
    const first = page.fetchOrders().then(() => { firstFinished = true; });
    const next = page.fetchOrders();
    pending[0](held(11));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(page.heldOrdersList.value.map(order => order.id)).toEqual([11]);
    expect(firstFinished).toBe(true);
    const later = page.fetchOrders();
    pending[1](held(12));
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(page.heldOrdersList.value.map(order => order.id)).toEqual([12]);
    pending[2](held(13));
    await Promise.all([first, next, later]);
  });

  it.each(['http', 'success', 'shape'])('keeps the last held snapshot and reports %s failure', async kind => {
    access.history = false;
    const page = mountSetup();
    await page.fetchOrders();
    fetch.mockResolvedValueOnce(kind === 'shape' ? response({ success: true, data: null }) : response({ success: kind === 'http', data: [] }, kind !== 'http'));
    await page.fetchOrders();
    expect(page.loadError.value).not.toBe('');
    expect(page.heldOrdersList.value.map(order => order.id)).toEqual([1]);
    await page.fetchOrders();
    expect(page.loadError.value).toBe('');
  });

  it('reports history failures instead of treating them as an empty list', async () => {
    access.held = false;
    fetch.mockResolvedValue(response({ success: false }, false));
    const page = mountSetup();
    await page.fetchOrders();
    expect(page.loadError.value).not.toBe('');
    expect(page.isLoading.value).toBe(false);
  });

  it('refreshes after an event during the initial held snapshot and releases failed reads', async () => {
    access.history = false;
    const pending = [];
    fetch.mockImplementation(url => String(url).includes('held_orders')
      ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(defaults(url)));
    const page = mountSetup();
    const startup = lifecycle.mounted[0]();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    connection.socket.value.emit('held_orders_changed');
    pending[0](response({ success: false }, false));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1](held(12));
    await startup;
    await vi.waitFor(() => expect(page.heldOrdersList.value.map(order => order.id)).toEqual([12]));
    expect(page.loadError.value).toBe('');
  });

  it.each([[true, false], [false, true], [false, false]])('requests only permitted lists (held=%s, history=%s)', async (canHeld, canHistory) => {
    access.held = canHeld; access.history = canHistory;
    const page = mountSetup();
    await page.fetchOrders();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('held_orders'))).toBe(canHeld);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('order_notes'))).toBe(canHistory);
    expect(page.isLoading.value).toBe(false);
    fetch.mockClear();
    page.showHistory.value = !page.showHistory.value;
    await nextTick();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('subscribes before startup reads and refreshes after a reconnect', async () => {
    vi.useFakeTimers();
    const page = mountSetup();
    const startup = lifecycle.mounted[0]();
    expect(connection.socket.value.listenerCount('held_orders_changed')).toBe(1);
    await startup;
    fetch.mockClear();
    window.dispatchEvent(new Event('socket_reconnected'));
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('held_orders'))).toBe(true);
    expect(page.loadError.value).toBe('');
  });

  it('the held view ignores table_update and new_order; history still refreshes on them', async () => {
    vi.useFakeTimers();
    const page = mountSetup();
    await lifecycle.mounted[0]();
    fetch.mockClear();
    for (let i = 0; i < 10; i++) {
      connection.socket.value.emit('table_update', { action: 'update_single_table', table: { id: 1 } });
      connection.socket.value.emit('new_order', {});
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch).not.toHaveBeenCalled();
    page.showHistory.value = true;
    await vi.advanceTimersByTimeAsync(0);
    fetch.mockClear();
    connection.socket.value.emit('new_order', {});
    connection.socket.value.emit('table_update', {});
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('order_notes'))).toHaveLength(1);
  });

  it('does not resume reads or add listeners after leaving during startup', async () => {
    let finish;
    fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mountSetup();
    const startup = lifecycle.mounted[0]();
    lifecycle.unmounted.forEach(callback => callback());
    const countAtLeave = fetch.mock.calls.length;
    finish(response({ success: true }));
    await startup;
    expect(fetch).toHaveBeenCalledTimes(countAtLeave);
    expect(connection.socket.value.listenerCount('held_orders_changed')).toBe(0);
    window.dispatchEvent(new Event('socket_reconnected'));
    await nextTick();
    expect(fetch).toHaveBeenCalledTimes(countAtLeave);
  });

  describe('targeted held_orders_changed payloads', () => {
    const row = (id, qty = 1, extra = {}) => ({ id, created_at: `2024-01-0${id} 10:00:00`, cart_data: JSON.stringify({ items: [{ id: 9, name: 'Meal', qty, price: 5 }] }), ...extra });
    const single = (data, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: async () => data });
    const listUrls = () => fetch.mock.calls.map(([url]) => String(url)).filter(url => url === 'api/pos/held_orders');
    const singleUrls = () => fetch.mock.calls.map(([url]) => String(url)).filter(url => /held_orders\/\d+$/.test(url));
    async function board(rows, { history = false } = {}) {
      vi.useFakeTimers(); access.history = history;
      fetch.mockImplementation(async url => String(url) === 'api/pos/held_orders'
        ? response({ success: true, data: rows }) : defaults(url));
      const page = mountSetup();
      await lifecycle.mounted[0]();
      expect(page.heldOrdersList.value.map(order => order.id)).toEqual(rows.map(order => order.id));
      fetch.mockClear();
      return page;
    }

    it('removes a settled or removed ticket locally without any request', async () => {
      const page = await board([row(3), row(2), row(1)]);
      connection.socket.value.emit('held_orders_changed', { action: 'removed', held_order_id: 2, table_id: null, parent_invoice_id: null });
      expect(page.heldOrdersList.value.map(order => order.id)).toEqual([3, 1]);
      connection.socket.value.emit('held_orders_changed', { action: 'settled', held_order_id: '3', table_id: null, parent_invoice_id: null });
      expect(page.heldOrdersList.value.map(order => order.id)).toEqual([1]);
      connection.socket.value.emit('held_orders_changed', { action: 'removed', held_order_id: 77, table_id: null, parent_invoice_id: null });
      await vi.advanceTimersByTimeAsync(1000);
      expect(page.heldOrdersList.value.map(order => order.id)).toEqual([1]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('reads only the changed ticket and replaces the card in place', async () => {
      const page = await board([row(2), row(1)]);
      expect(page.processedHeldOrders.value[1].total).toBe(5);
      fetch.mockImplementation(async url => String(url) === 'api/pos/held_orders/1'
        ? single({ success: true, data: row(1, 4, { claim_owner_name: 'Sam' }) }) : defaults(url));
      connection.socket.value.emit('held_orders_changed', { action: 'updated', held_order_id: 1, table_id: null, parent_invoice_id: null });
      await vi.waitFor(() => expect(page.processedHeldOrders.value[1].total).toBe(20));
      expect(page.processedHeldOrders.value[1]).toMatchObject({ id: 1, items: [{ quantity: 4 }], raw_held_data: { claim_owner_name: 'Sam' } });
      expect(page.heldOrdersList.value.map(order => order.id)).toEqual([2, 1]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(singleUrls()).toEqual(['api/pos/held_orders/1']);
      expect(listUrls()).toEqual([]);
    });

    it('inserts a newly created ticket and the board keeps its time order', async () => {
      const page = await board([row(3), row(1)]);
      fetch.mockImplementation(async url => String(url) === 'api/pos/held_orders/2'
        ? single({ success: true, data: row(2) }) : defaults(url));
      connection.socket.value.emit('held_orders_changed', { action: 'created', held_order_id: 2, table_id: null, parent_invoice_id: null });
      await vi.waitFor(() => expect(page.heldOrdersList.value.map(order => order.id)).toEqual([3, 1, 2]));
      expect(page.phoneCards.value.map(order => order.id)).toEqual([1, 2, 3]);
      fetch.mockImplementation(async url => String(url) === 'api/pos/held_orders/5'
        ? single({ success: true, data: row(5) }) : defaults(url));
      connection.socket.value.emit('held_orders_changed', { action: 'fired', held_order_id: 5, table_id: null, parent_invoice_id: null });
      await vi.waitFor(() => expect(page.heldOrdersList.value.map(order => order.id)).toEqual([3, 1, 2, 5]));
      expect(page.phoneCards.value.map(order => order.id)).toEqual([1, 2, 3, 5]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(listUrls()).toEqual([]);
    });

    it('drops the ticket when the single read reports 404', async () => {
      const page = await board([row(2), row(1)]);
      fetch.mockImplementation(async url => String(url) === 'api/pos/held_orders/2'
        ? single({ success: false }, false, 404) : defaults(url));
      connection.socket.value.emit('held_orders_changed', { action: 'claimed', held_order_id: 2, table_id: null, parent_invoice_id: null });
      await vi.waitFor(() => expect(page.heldOrdersList.value.map(order => order.id)).toEqual([1]));
      await vi.advanceTimersByTimeAsync(1000);
      expect(listUrls()).toEqual([]);
      expect(page.loadError.value).toBe('');
    });

    it.each(['500', 'non-json'])('falls back to one debounced list read when the single read fails (%s)', async kind => {
      const page = await board([row(1)]);
      fetch.mockImplementation(async url => {
        if (String(url) === 'api/pos/held_orders/1') {
          return kind === '500' ? single({ success: false }, false, 500) : { ok: false, status: 405, json: async () => { throw new SyntaxError('html'); } };
        }
        if (String(url) === 'api/pos/held_orders') return response({ success: true, data: [row(1, 7)] });
        return defaults(url);
      });
      connection.socket.value.emit('held_orders_changed', { action: 'updated', held_order_id: 1, table_id: null, parent_invoice_id: null });
      await vi.waitFor(() => expect(singleUrls()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(249);
      expect(listUrls()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(page.processedHeldOrders.value[0].total).toBe(35));
      await vi.advanceTimersByTimeAsync(1000);
      expect(listUrls()).toEqual(['api/pos/held_orders']);
    });

    it.each([undefined, { source: 'call_center' }, { action: 'cleared', held_order_id: null }, { action: 'updated', held_order_id: 'abc' }, { action: 'exploded', held_order_id: 1 }])(
      'coalesces a payload without a targeted action into one list read (%o)', async payload => {
        const page = await board([row(1)]);
        fetch.mockImplementation(async url => String(url) === 'api/pos/held_orders'
          ? response({ success: true, data: [row(4)] }) : defaults(url));
        connection.socket.value.emit('held_orders_changed', payload);
        connection.socket.value.emit('held_orders_changed', payload);
        expect(fetch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(250);
        await vi.waitFor(() => expect(page.heldOrdersList.value.map(order => order.id)).toEqual([4]));
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['api/pos/held_orders']);
      });

    it('lets a pending list read win over a targeted event and reconciles with one queued read', async () => {
      const page = await board([row(1)]);
      const pending = [];
      fetch.mockImplementation(url => new Promise(resolve => pending.push({ url: String(url), resolve })));
      const read = page.fetchOrders();
      expect(pending.map(item => item.url)).toEqual(['api/pos/held_orders']);
      connection.socket.value.emit('held_orders_changed', { action: 'updated', held_order_id: 1, table_id: null, parent_invoice_id: null });
      connection.socket.value.emit('held_orders_changed', { action: 'removed', held_order_id: 1, table_id: null, parent_invoice_id: null });
      expect(pending).toHaveLength(1);
      expect(page.heldOrdersList.value.map(order => order.id)).toEqual([1]);
      pending[0].resolve(response({ success: true, data: [row(1, 2)] }));
      await read;
      expect(page.processedHeldOrders.value[0].total).toBe(10);
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(pending[1].url).toBe('api/pos/held_orders');
      pending[1].resolve(response({ success: true, data: [] }));
      await vi.waitFor(() => expect(page.heldOrdersList.value).toEqual([]));
      await vi.advanceTimersByTimeAsync(1000);
      expect(pending).toHaveLength(2);
    });

    it('does not patch a stale single row over a snapshot that landed while it was in flight', async () => {
      const page = await board([row(1)]);
      const pending = [];
      fetch.mockImplementation(url => new Promise(resolve => pending.push({ url: String(url), resolve })));
      connection.socket.value.emit('held_orders_changed', { action: 'updated', held_order_id: 1, table_id: null, parent_invoice_id: null });
      expect(pending.map(item => item.url)).toEqual(['api/pos/held_orders/1']);
      const read = page.fetchOrders();
      pending[1].resolve(response({ success: true, data: [row(1, 3)] }));
      await read;
      pending[0].resolve(single({ success: true, data: row(1, 2) }));
      await vi.advanceTimersByTimeAsync(249);
      expect(page.processedHeldOrders.value[0].total).toBe(15);
      expect(pending).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(pending).toHaveLength(3));
      expect(pending[2].url).toBe('api/pos/held_orders');
      pending[2].resolve(response({ success: true, data: [row(1, 3)] }));
    });

    it('ignores a late single row after switching to history', async () => {
      const page = await board([row(1)], { history: true });
      const pending = [];
      fetch.mockImplementation(url => new Promise(resolve => pending.push({ url: String(url), resolve })));
      connection.socket.value.emit('held_orders_changed', { action: 'updated', held_order_id: 1, table_id: null, parent_invoice_id: null });
      page.showHistory.value = true;
      await nextTick();
      pending[0].resolve(single({ success: true, data: row(1, 9) }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(page.processedHeldOrders.value[0].total).toBe(5);
      expect(pending.map(item => item.url)).toEqual(['api/pos/held_orders/1', 'api/pos/order_notes?limit=200']);
      pending[1].resolve(defaults(pending[1].url));
    });
  });

  it('aborts a disposed board read and ignores its late completion', async () => {
    access.history = false;
    let finish;
    let signal;
    fetch.mockImplementation((url, options) => new Promise(resolve => { finish = resolve; signal = options?.signal; }));
    const page = mountSetup();
    const read = page.fetchOrders();
    lifecycle.unmounted.forEach(callback => callback());
    expect(signal?.aborted).toBe(true);
    finish(held(99));
    await read;
    expect(page.heldOrdersList.value).toEqual([]);
  });
});

describe('board self-recovery and held claims', () => {
  const store = () => {
    const map = new Map();
    return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
  };
  const heldRow = (extra = {}) => ({ id: 7, version: 1, cart_data: '{"items":[]}', ...extra });

  it('a failed board read retries on the socket heartbeat and not while healthy', async () => {
    access.history = false;
    connection.socket.value.io = new EventEmitter();
    const page = mountSetup();
    fetch.mockImplementation(async url => (String(url).includes('held_orders') ? response({ success: false }, false) : defaults(url)));
    await lifecycle.mounted[0]();
    expect(page.loadError.value).not.toBe('');
    fetch.mockImplementation(async url => defaults(url)); fetch.mockClear();
    connection.socket.value.io.emit('ping');
    await vi.waitFor(() => expect(page.loadError.value).toBe(''));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['api/pos/held_orders']);
    fetch.mockClear();
    connection.socket.value.io.emit('ping');
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    lifecycle.unmounted.forEach(callback => callback()); lifecycle.unmounted.length = 0;
    fetch.mockImplementation(async () => { throw new TypeError('x'); });
    page.loadError.value = 'x';
    fetch.mockClear();
    connection.socket.value.io.emit('ping');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a failed order types read retries on focus', async () => {
    access.history = false;
    const page = mountSetup();
    fetch.mockImplementation(async url => { if (String(url).includes('order_types')) throw new TypeError('offline'); return defaults(url); });
    await lifecycle.mounted[0]();
    fetch.mockImplementation(async url => (String(url).includes('order_types') ? response({ success: true, data: [{ id: 3, name: 'Dine' }] }) : defaults(url)));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(page.orderTypesList.value).toHaveLength(1));
  });

  it('second restore after a network error reuses the first claim token, one claim at a time', async () => {
    access.history = false;
    vi.stubGlobal('localStorage', store());
    window.showPosAlert = vi.fn(async () => {});
    const page = mountSetup();
    const bodies = [];
    let fail;
    fetch.mockImplementation((url, options) => {
      if (String(url).includes('/claim')) { bodies.push(JSON.parse(options.body)); return new Promise((_, reject) => { fail = reject; }); }
      return defaults(url);
    });
    const order = { id: 7, isHeld: true, raw_held_data: heldRow() };
    const first = page.restoreHeldOrder(order);
    page.restoreHeldOrder(order);
    await Promise.resolve();
    expect(bodies).toHaveLength(1);
    fail(new TypeError('Failed to fetch'));
    await first;
    expect(page.resumableHeldOrderId.value).toBe(7);
    const second = page.restoreHeldOrder(order);
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    fail(new TypeError('Failed to fetch'));
    await second;
    expect(bodies[1].claim_token).toBe(bodies[0].claim_token);
  });

  it('claim badge clears at claim_expires_at without a refetch', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    access.history = false;
    const page = mountSetup();
    fetch.mockImplementation(async url => (String(url).includes('held_orders')
      ? response({ success: true, data: [heldRow({ claimed_by_user_id: 2, claim_expires_at: new Date(1_060_000).toISOString() })] })
      : defaults(url)));
    await page.fetchOrders();
    const active = scope.run(() => computed(() => page.heldClaimIsActive(page.processedHeldOrders.value[0])));
    expect(active.value).toBe(true);
    fetch.mockClear();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(active.value).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('fire to kitchen', () => {
    const fireCalls = () => fetch.mock.calls.filter(([url]) => String(url).includes('fire_kitchen'));
    const listReads = () => fetch.mock.calls.filter(([url]) => url === 'api/pos/held_orders');
    beforeEach(() => { access.history = false; vi.stubGlobal('localStorage', store()); window.showPosToast = vi.fn(); });

    it('a second ticket fires immediately after the first completes, with no list read', async () => {
      const page = mountSetup();
      fetch.mockImplementation(async url => (String(url).includes('fire_kitchen') ? response({ success: true, count: 1 }) : defaults(url)));
      await page.fireToKitchen({ id: 7, isHeld: true, raw_held_data: heldRow() });
      await page.fireToKitchen({ id: 8, isHeld: true, raw_held_data: heldRow() });
      expect(fireCalls()).toHaveLength(2);
      expect(listReads()).toHaveLength(0);
    });

    it('the same ticket cannot double-send while in flight; others stay tappable', async () => {
      const page = mountSetup();
      const pending = [];
      fetch.mockImplementation(url => (String(url).includes('fire_kitchen') ? new Promise(resolve => pending.push(resolve)) : defaults(url)));
      const order = { id: 7, isHeld: true, raw_held_data: heldRow() };
      const first = page.fireToKitchen(order);
      page.fireToKitchen(order);
      const other = page.fireToKitchen({ id: 8, isHeld: true, raw_held_data: heldRow() });
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(page.kitchenFiring(7)).toBe(true);
      pending.forEach(resolve => resolve(response({ success: true, count: 1 })));
      await Promise.all([first, other]);
      expect(page.kitchenFiring(7)).toBe(false);
      expect(fireCalls()).toHaveLength(2);
    });

    it('a failed fire re-reads the board', async () => {
      const page = mountSetup();
      fetch.mockImplementation(async url => (String(url).includes('fire_kitchen') ? response({ success: false, message: 'x' }, false) : defaults(url)));
      await page.fireToKitchen({ id: 7, isHeld: true, raw_held_data: heldRow() });
      expect(listReads()).toHaveLength(1);
    });
  });
});

describe('receipt print deadlines', () => {
  const memoryStorage = entries => ({ getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), removeItem: key => entries.delete(key) });
  const posts = url => fetch.mock.calls.filter(([resource, options]) => String(resource).includes(url) && options?.method === 'POST');

  it('bounds a held-ticket print, words it as unconfirmed and replays the same request id on a manual retry', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', memoryStorage(new Map()));
    window.showPosAlert = vi.fn(async () => {});
    fetch.mockImplementation(async (url, options) => options?.method === 'POST' ? new Promise(() => {}) : defaults(url));
    const page = mountSetup();
    const first = page.reprintDirect({ id: 7, isHeld: true });
    await vi.advanceTimersByTimeAsync(15000);
    expect(await first).toBe(false);
    expect(window.showPosAlert).toHaveBeenCalledWith('Printing was not confirmed. Check Printing before retrying.');
    expect(posts('print_receipt')).toHaveLength(1);
    const second = page.reprintDirect({ id: 7, isHeld: true });
    await vi.advanceTimersByTimeAsync(15000); await second;
    const ids = posts('print_receipt').map(([, options]) => JSON.parse(options.body).print_request_id);
    expect(ids[1]).toBe(ids[0]);
  });

  it('bounds an invoice reprint dispatch and words it as unconfirmed', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: key => key === 'pos_receipt_printer_id' ? '3' : null });
    window.showPosAlert = vi.fn(async () => {});
    fetch.mockImplementation(async (url, options) => options?.method === 'POST' ? new Promise(() => {}) : defaults(url));
    const page = mountSetup();
    const pending = page.reprintDirect({ invoice_id: 9 });
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toBe(false);
    expect(window.showPosAlert).toHaveBeenCalledWith('Printing was not confirmed. Check Printing before retrying.');
    expect(posts('api/print/print')).toHaveLength(1);
  });
});

describe('held board mutations have deadlines', () => {
  const memoryStorage = entries => ({ getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), removeItem: key => entries.delete(key) });
  const calls = (match, method) => fetch.mock.calls.filter(([url, options]) => String(url).includes(match) && options?.method === method);

  it('a lost settle-platform answer is unconfirmed, re-reads the board and is not retried', async () => {
    vi.useFakeTimers(); access.history = false;
    window.showPosConfirm = vi.fn(async () => true);
    window.showPosAlert = vi.fn(async () => {});
    fetch.mockImplementation(async (url, options) => {
      if (options?.method === 'POST') return new Promise(() => {});
      if (String(url).includes('order_types')) return response({ success: true, data: [{ id: 5, name: 'Talabat', is_deferred_settlement: 1 }] });
      if (String(url).includes('held_orders')) return response({ success: true, data: [{ id: 3, cart_data: JSON.stringify({ order_type_id: 5, items: [] }) }] });
      return defaults(url);
    });
    const page = mountSetup();
    await lifecycle.mounted[0]();
    fetch.mockClear();
    const settle = page.settlePlatformLane('Talabat');
    await vi.advanceTimersByTimeAsync(15000); await settle;
    expect(calls('settle-platform', 'POST')).toHaveLength(1);
    expect(fetch.mock.calls.map(([url]) => url)).toContain('api/pos/held_orders');
    expect(window.showPosAlert).toHaveBeenCalledWith('Closing platform orders was not confirmed. Check the board before retrying.');
    expect(page.platformSettlementTypeId.value).toBe(null);
  });

  it('a stalled held cancel is bounded, worded as unconfirmed and keeps its operation id', async () => {
    vi.useFakeTimers(); access.history = false;
    const entries = new Map();
    vi.stubGlobal('localStorage', memoryStorage(entries));
    window.showPosConfirm = vi.fn(async () => true);
    window.showPosAlert = vi.fn(async () => {});
    fetch.mockImplementation(async (url, options) => {
      if (String(url).endsWith('/claim')) return response({ success: true, claim: { version: 2 } });
      if (options?.method === 'DELETE' || options?.method === 'POST') return new Promise(() => {});
      return defaults(url);
    });
    const page = mountSetup();
    const order = { id: 3, isHeld: true, raw_held_data: { version: 1 } };
    const first = page.cancelHeldOrder(order);
    await vi.advanceTimersByTimeAsync(30000); await first;
    expect(window.showPosAlert).toHaveBeenCalledWith('Cancelling the suspended ticket was not confirmed. Check the board before retrying.');
    const second = page.cancelHeldOrder(order);
    await vi.advanceTimersByTimeAsync(30000); await second;
    const ids = calls('held_orders/3', 'DELETE').map(([, options]) => JSON.parse(options.body).operation_id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });
});

describe('held ticket restore', () => {
  const heldCard = { id: 5, isHeld: true, raw_held_data: { id: 5, version: 1, kitchen_fired: 1, cart_data: '{"items":[]}' } };
  function restoreWith(reply) {
    const store = new Map();
    vi.stubGlobal('localStorage', { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) });
    window.showPosAlert = vi.fn(async () => {});
    cart.restoreHeldOrder = vi.fn();
    fetch.mockImplementation(async url => String(url).includes('/claim') ? { ok: true, status: 200, json: async () => reply } : defaults(url));
    return mountSetup().restoreHeldOrder(heldCard);
  }
  const claim = { version: 2, claimToken: 'a'.repeat(64) };

  it('marks the kitchen baseline unknown only when the server says it is not known', async () => {
    await restoreWith({ success: true, order: { id: 5, kitchen_fired: 1, kitchen_baseline_known: false, cart_data: '{"items":[]}' }, claim });
    expect(cart.restoreHeldOrder.mock.calls[0][0].held_order_context.baselineUnknown).toBe(true);
    await restoreWith({ success: true, order: { id: 5, kitchen_fired: 1, kitchen_baseline_known: true, cart_data: '{"items":[]}' }, claim });
    expect(cart.restoreHeldOrder.mock.calls[0][0].held_order_context.baselineUnknown).toBe(false);
  });

  it('hands the restore source to the activation planner: server cart_data is priced, a backup-cart restore is re-priced once', async () => {
    await restoreWith({ success: true, order: { id: 5, kitchen_fired: 0, cart_data: '{"items":[]}' }, claim });
    const serverSource = cart.consumeRestoreSource();
    expect(serverSource).toBe('server');
    expect(planActivationCartRefresh({ restoreSource: serverSource })).toMatchObject({ repriceCart: false, refreshCartPrices: false });
    await restoreWith({ success: true, order: { id: 5, kitchen_fired: 0 }, claim });
    const localSource = cart.consumeRestoreSource();
    expect(localSource).toBe('local');
    expect(planActivationCartRefresh({ restoreSource: localSource })).toMatchObject({ repriceCart: true });
  });

  it('treats a claim success without the order as a failure instead of restoring the stale card', async () => {
    await restoreWith({ success: true, claim });
    expect(cart.restoreHeldOrder).not.toHaveBeenCalled();
    expect(window.showPosAlert).toHaveBeenCalled();
  });
});
