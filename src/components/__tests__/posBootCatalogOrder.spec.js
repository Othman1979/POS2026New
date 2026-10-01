import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@vue/compiler-sfc';
import { parse as parseScript } from '@babel/parser';
import { describe, expect, it, vi } from 'vitest';
import { planActivationCartRefresh } from '@/pos/activationCartRefresh.js';

// Runs the real onMounted / onActivated / first-connect code of PosTerminal with
// every dependency replaced, to count catalog reads and their order.
const source = parse(readFileSync(resolve('src/components/PosTerminal.vue'), 'utf8')).descriptor.scriptSetup.content;
const body = parseScript(source, { sourceType: 'module' }).program.body;
const text = n => source.slice(n.start, n.end);
const hookArg = name => text(body.find(n => n.expression?.callee?.name === name).expression.arguments[0]);
const decl = name => { const n = body.find(x => x.declarations?.some(d => d.id.name === name)); return n ? text(n) : ''; };

// Unknown names resolve to inert callable stubs; globals stay globals.
const stub = () => new Proxy(function () {}, {
    get: (t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : stub()),
    apply: () => undefined,
});
const loose = o => new Proxy(o, { get: (t, k) => (k in t || typeof k === 'symbol' ? t[k] : stub()) });
const scopeOf = d => new Proxy(d, {
    has: () => true,
    get: (t, k) => {
        if (k === Symbol.unscopables) return undefined;
        if (k in t) return t[k];
        if (k in globalThis) return globalThis[k];
        return (t[k] = stub());
    },
    set: (t, k, v) => { t[k] = v; return true; },
});
// extra adds more real declarations (e.g. the cart-price refresh and its retry).
const compile = (extra = '') => new Function('scope', `with (scope) {
let initialCatalogSnapshotStarted = false; let initialCatalogSnapshotComplete = false;
let hasSeenSocketConnect = false; let initialRecoveryRefreshStarted = false;
let initialConnectReconcilePending = false; let hasSeenInitialActivation = false;
let bootReconnectRecoveryPending = false;
${decl('onSocketConnect')}
${decl('reconcileInitialSnapshot')}
${decl('isCatalogGenerationCurrent')}
${decl('refreshCatalogUnlessCurrent')}
${decl('handleSocketReconnected')}
${decl('recoverAfterReconnect')}
${decl('bindCatalogSocketListeners')}
${extra}
return { mount: ${hookArg('onMounted')}, activate: ${hookArg('onActivated')}, onSocketConnect, handleSocketReconnected${extra ? ', retryFailedReads' : ''} };
}`);
const build = compile();
const buildWithPrices = compile(`let priceRefreshRequestId = 0; let priceRefreshRetryQueued = false; let cartPricesStale = null;
${decl('schedulePriceRefreshRetry')}
${decl('cartPriceContextKey')}
${decl('refreshCartCatalogPrices')}
${decl('retryFailedReads')}`);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness({ role = 'cashier', table = null, handoff = null, generation = 'b:1', serverGeneration = 'b:1', realPrices = false } = {}) {
    const pendingSettings = [];
    const context = { value: 'register' };
    const catalogGeneration = { value: null };
    const emitWithAck = vi.fn(async () => serverGeneration);
    const handlers = {};
    const socket = { connected: false, on: (e, fn) => { handlers[e] = fn; }, off: (e, fn) => { if (handlers[e] === fn) delete handlers[e]; },
        io: { on: () => {}, off: () => {} }, timeout: () => ({ emitWithAck }) };
    const d = {
        sessionStorage: { getItem: () => JSON.stringify({ id: 1, role }) },
        localStorage: {},
        window: { location: { search: '' }, addEventListener: vi.fn() },
        document: { addEventListener: vi.fn() },
        auth: { activeUser: { value: null }, checkActiveShift: vi.fn(async () => {}) },
        activeTable: { value: table },
        hasStoredTableSession: () => !!table,
        readHeldOrderHandoff: () => handoff,
        salesContext: context,
        setSalesContext: vi.fn(c => { context.value = c; }),
        terminal: { loadSettings: vi.fn(() => new Promise(r => { pendingSettings.push(r); })) },
        products: loose({
            catalogGeneration,
            catalogLoadError: { value: '' },
            fetchData: vi.fn(async () => { catalogGeneration.value = generation; }),
        }),
        checkAndRestoreHeldOrder: vi.fn(async () => 'none'),
        router: { push: vi.fn() },
        cart: loose({ consumeServerCanonicalRestore: () => false, consumeRestoreSource: () => null, fetchOrderTypes: vi.fn(), checkoutInFlight: { value: false } }),
        fetchHeldOrderSummary: vi.fn(async () => {}),
        syncCartAvailabilityFromCatalog: vi.fn(),
        refreshCartCatalogPrices: vi.fn(async () => {}),
        canLoadTableWorkspace: () => false,
        refreshTracker: { activate: () => ({}) },
        planActivationCartRefresh,
        initSocket: () => socket,
    };
    d.refreshCatalogAndCart = vi.fn(async () => { await d.products.fetchData({ forceFull: true }); });
    const hooks = (realPrices ? buildWithPrices : build)(scopeOf(d));
    return { d, hooks, emitWithAck, handlers, settle: v => pendingSettings.splice(0).forEach(r => r(v)) };
}

describe('PosTerminal boot catalog order', () => {
    it('starts the register catalog read before settings resolve, and re-syncs the cart after', async () => {
        const { d, hooks, settle } = harness();
        const done = hooks.mount();
        await flush();
        expect(d.products.fetchData).toHaveBeenCalledOnce();
        expect(d.refreshCartCatalogPrices).not.toHaveBeenCalled();
        settle(true);
        await done;
        expect(d.products.fetchData).toHaveBeenCalledOnce();
        expect(d.checkAndRestoreHeldOrder).toHaveBeenCalled();
        expect(d.syncCartAvailabilityFromCatalog).toHaveBeenCalled();
        expect(d.refreshCartCatalogPrices).toHaveBeenCalledWith({ refreshPrices: true });
    });

    it('does not read the catalog for a waiter without a table (redirects to /tables)', async () => {
        const { d, hooks, settle } = harness({ role: 'waiter' });
        const done = hooks.mount();
        settle(true);
        await done;
        expect(d.router.push).toHaveBeenCalledWith('/tables');
        expect(d.products.fetchData).not.toHaveBeenCalled();
    });

    it('keeps a held handoff ordered behind its restore', async () => {
        const { d, hooks, settle } = harness({ handoff: { heldOrderId: 1 } });
        const done = hooks.mount();
        await flush();
        expect(d.products.fetchData).not.toHaveBeenCalled();
        settle(true);
        await done;
        expect(d.products.fetchData).toHaveBeenCalledOnce();
    });

    it('a first mount into a table reads the catalog once, not once per lifecycle hook', async () => {
        const { d, hooks, settle } = harness({ role: 'waiter', table: { id: 4 } });
        const done = hooks.mount();
        await hooks.activate();
        settle(true);
        await done;
        await flush();
        expect(d.products.fetchData).toHaveBeenCalledOnce();
        expect(d.salesContext.value).toBe('table');
    });

    it('a first connect during the snapshot skips the second read when the catalog generation is equal', async () => {
        const { d, hooks, settle, emitWithAck } = harness();
        const done = hooks.mount();
        await flush();
        hooks.onSocketConnect();
        settle(true);
        await done;
        expect(emitWithAck).toHaveBeenCalledWith('catalog_generation');
        expect(d.products.fetchData).toHaveBeenCalledOnce();
    });

    it('reads again when the generation moved in the gap', async () => {
        const { d, hooks, settle } = harness({ serverGeneration: 'b:2' });
        const done = hooks.mount();
        await flush();
        hooks.onSocketConnect();
        settle(true);
        await done;
        expect(d.products.fetchData).toHaveBeenCalledTimes(2);
    });

    it('binds the real connect listener before the boot snapshot, so a connect in that window reconciles', async () => {
        const h = harness({ serverGeneration: 'b:2' });
        let connectBoundAtSnapshot = false;
        const read = h.d.products.fetchData.getMockImplementation();
        h.d.products.fetchData.mockImplementation(async (...args) => { connectBoundAtSnapshot ||= !!h.handlers.connect; return read(...args); });
        const done = h.hooks.mount();
        await flush();
        expect(connectBoundAtSnapshot).toBe(true);
        h.handlers.connect();
        h.settle(true);
        await done;
        expect(h.emitWithAck).toHaveBeenCalledWith('catalog_generation');
        expect(h.d.products.fetchData).toHaveBeenCalledTimes(2);
    });

    // Boot's settings read, then (after boot) the deferred recovery's forced one.
    const bootWithReconnect = async (options) => {
        const h = harness(options);
        const done = h.hooks.mount();
        await flush();
        h.hooks.onSocketConnect();
        const reconnect = h.hooks.handleSocketReconnected();
        await flush();
        const forcedDuringBoot = h.d.terminal.loadSettings.mock.calls.some(([arg]) => arg?.force);
        h.settle(true);
        for (let i = 0; i < 200 && h.d.terminal.loadSettings.mock.calls.length < 2; i++) await Promise.resolve();
        h.settle(true);
        await done;
        await reconnect;
        await flush();
        return { ...h, forcedDuringBoot };
    };

    it('a reconnect while the boot snapshot loads leaves the catalog to one generation check', async () => {
        const { d, emitWithAck } = await bootWithReconnect();
        expect(d.refreshCatalogAndCart).not.toHaveBeenCalled();
        expect(d.products.fetchData).toHaveBeenCalledOnce();
        expect(emitWithAck).toHaveBeenCalledWith('catalog_generation');
    });

    it('still refreshes settings, order types and held orders after boot when the drop hit during boot', async () => {
        const { d, forcedDuringBoot } = await bootWithReconnect();
        expect(forcedDuringBoot).toBe(false);
        expect(d.terminal.loadSettings).toHaveBeenLastCalledWith({ force: true });
        expect(d.cart.fetchOrderTypes).toHaveBeenCalledWith({ force: true });
        expect(d.fetchHeldOrderSummary).toHaveBeenCalledWith({ fresh: true });
    });

    it('keeps a boot-time reconnect recovery for the next activation when the terminal was parked', async () => {
        const h = harness();
        h.d.isActive = { value: true };
        // Deactivation recorded the already-bumped generation: the tracker sees nothing.
        h.d.refreshTracker = { activate: () => ({ recovery: false, catalog: false, stock: false, catalogIds: [], settings: false, held: false, shift: false, tables: false }) };
        const done = h.hooks.mount();
        await h.hooks.activate();
        await flush();
        h.hooks.onSocketConnect();
        const reconnect = h.hooks.handleSocketReconnected();
        h.d.isActive.value = false;
        h.settle(true);
        await done;
        await reconnect;
        await flush();
        expect(h.d.terminal.loadSettings).not.toHaveBeenCalledWith({ force: true });

        const back = h.hooks.activate();
        await flush();
        expect(h.d.terminal.loadSettings).toHaveBeenLastCalledWith({ force: true });
        h.settle(true);
        await back;
        await flush();
        expect(h.d.cart.fetchOrderTypes).toHaveBeenCalledWith({ force: true });
        expect(h.d.fetchHeldOrderSummary).toHaveBeenCalledWith({ fresh: true });
        expect(h.d.refreshCatalogAndCart).not.toHaveBeenCalled();
    });

    it('reads again after a boot-time reconnect when the generation moved during the drop', async () => {
        const { d } = await bootWithReconnect({ serverGeneration: 'b:2' });
        expect(d.products.fetchData).toHaveBeenCalledTimes(2);
    });

    it('reads again when the server gives no generation (older server)', async () => {
        const { d, hooks, settle } = harness({ generation: null });
        const done = hooks.mount();
        await flush();
        hooks.onSocketConnect();
        settle(true);
        await done;
        expect(d.products.fetchData).toHaveBeenCalledTimes(2);
    });
});

describe('PosTerminal recovery reads the catalog only when the server token moved', () => {
    const booted = async options => {
        const h = harness(options);
        h.d.isActive = { value: true };
        const done = h.hooks.mount();
        await flush();
        h.settle(true);
        await done;
        await h.hooks.activate(); // initial KeepAlive activation: mount owns it
        h.d.products.fetchData.mockClear();
        h.d.refreshCatalogAndCart.mockClear();
        h.emitWithAck.mockClear();
        return h;
    };
    const reconnect = async h => {
        const run = h.hooks.handleSocketReconnected();
        await flush();
        h.settle(true);
        await run;
        await flush();
    };
    const reactivate = async (h, refresh) => {
        h.d.refreshTracker = { activate: () => refresh };
        await h.hooks.activate();
        await flush();
    };
    const RECOVERY = { recovery: true, catalog: true, stock: false, catalogIds: [], settings: false, held: false, shift: false, tables: false };

    it('a reconnect with a matching token reads no catalog but still refreshes the rest', async () => {
        const h = await booted();
        await reconnect(h);
        expect(h.emitWithAck).toHaveBeenCalledWith('catalog_generation');
        expect(h.d.products.fetchData).not.toHaveBeenCalled();
        expect(h.d.refreshCatalogAndCart).not.toHaveBeenCalled();
        expect(h.d.fetchHeldOrderSummary).toHaveBeenCalledWith({ fresh: true });
        expect(h.d.cart.fetchOrderTypes).toHaveBeenCalledWith({ force: true });
    });

    it('a reconnect with a moved token reads the catalog once', async () => {
        const h = await booted({ serverGeneration: 'b:2' });
        await reconnect(h);
        expect(h.d.refreshCatalogAndCart).toHaveBeenCalledOnce();
    });

    it('a reconnect whose token check times out reads the catalog once', async () => {
        const h = await booted();
        h.emitWithAck.mockRejectedValue(new Error('timeout'));
        await reconnect(h);
        expect(h.d.refreshCatalogAndCart).toHaveBeenCalledOnce();
    });

    it('a recovering reactivation with a matching token reads no catalog', async () => {
        const h = await booted();
        await reactivate(h, RECOVERY);
        expect(h.emitWithAck).toHaveBeenCalledWith('catalog_generation');
        expect(h.d.refreshCatalogAndCart).not.toHaveBeenCalled();
        expect(h.d.products.fetchData).not.toHaveBeenCalled();
    });

    it('a recovering reactivation that also switches context reads the catalog even when the token matches', async () => {
        const h = await booted();
        h.d.activeTable.value = { id: 4 }; // register -> table: the new context may have no saved rows
        await reactivate(h, RECOVERY);
        expect(h.d.refreshCatalogAndCart).toHaveBeenCalledOnce();
    });

    it('a matching token still re-syncs availability, and re-prices once for a local-fallback restore', async () => {
        const h = await booted();
        h.d.syncCartAvailabilityFromCatalog.mockClear();
        h.d.refreshCartCatalogPrices.mockClear();
        h.d.checkAndRestoreHeldOrder = vi.fn(async () => 'local-held-order');
        await reactivate(h, RECOVERY);
        expect(h.d.refreshCatalogAndCart).not.toHaveBeenCalled();
        expect(h.d.syncCartAvailabilityFromCatalog).toHaveBeenCalled();
        expect(h.d.refreshCartCatalogPrices).toHaveBeenCalledTimes(1);
        expect(h.d.refreshCartCatalogPrices).toHaveBeenCalledWith({ refreshPrices: true });
    });

    it('a matching token still reads the catalog when the local catalog read is in a failed state', async () => {
        const h = await booted();
        h.d.products.catalogLoadError.value = 'Unable to load products.';
        await reconnect(h);
        expect(h.d.refreshCatalogAndCart).toHaveBeenCalledOnce();
    });

    it('a matching token retries a cart whose reprice failed before the drop, with one price request', async () => {
        const h = await booted();
        h.d.refreshCartCatalogPrices.mockClear();
        h.d.cartPriceContextKey = () => 'register:';
        h.d.cartPricesStale = { key: 'register:', refreshPrices: true };
        await reconnect(h);
        expect(h.d.refreshCatalogAndCart).not.toHaveBeenCalled();
        expect(h.d.refreshCartCatalogPrices).toHaveBeenCalledTimes(1);
        expect(h.d.refreshCartCatalogPrices).toHaveBeenCalledWith({ refreshPrices: true });
    });

    it('a matching token without a local restore sends no price request', async () => {
        const h = await booted();
        h.d.refreshCartCatalogPrices.mockClear();
        await reactivate(h, RECOVERY);
        expect(h.d.refreshCartCatalogPrices).not.toHaveBeenCalled();
    });

    it('a recovering reactivation with a moved token or a timeout reads once', async () => {
        const moved = await booted({ serverGeneration: 'b:2' });
        await reactivate(moved, RECOVERY);
        expect(moved.d.refreshCatalogAndCart).toHaveBeenCalledOnce();
        const timedOut = await booted();
        timedOut.emitWithAck.mockRejectedValue(new Error('timeout'));
        await reactivate(timedOut, RECOVERY);
        expect(timedOut.d.refreshCatalogAndCart).toHaveBeenCalledOnce();
    });
});

describe('PosTerminal held-order summary events', () => {
    const run = new Function('scope', `with (scope) {
let seenPhoneHoldEvents = new Set(); let heldSummaryRefreshTimer = null;
${decl('canObserveHeldOrders')}
${decl('onHeldOrdersChanged')}
return onHeldOrdersChanged;
}`);
    const setup = () => {
        vi.useFakeTimers();
        const fetchHeldOrderSummary = vi.fn();
        const handler = run(scopeOf({
            auth: { activeUser: { value: { role: 'cashier' } } }, can: () => true, t: x => x,
            window: { showPosToast: vi.fn() }, fetchHeldOrderSummary,
        }));
        return { handler, fetchHeldOrderSummary };
    };
    const summaryReads = async ({ fetchHeldOrderSummary }) => { await vi.advanceTimersByTimeAsync(500); return fetchHeldOrderSummary.mock.calls.length; };

    it('table and split hold events never reload the summary', async () => {
        const h = setup();
        h.handler({ action: 'updated', held_order_id: 1, table_id: 4, parent_invoice_id: null });
        h.handler({ action: 'created', held_order_id: 2, table_id: 4, parent_invoice_id: 90 });
        h.handler({ action: 'removed', held_order_id: 3, table_id: null, parent_invoice_id: 90 });
        expect(await summaryReads(h)).toBe(0);
        vi.useRealTimers();
    });

    it('a register hold event reloads the summary once, even in a burst', async () => {
        const h = setup();
        h.handler({ action: 'created', held_order_id: 5, table_id: null, parent_invoice_id: null });
        h.handler({ action: 'updated', held_order_id: 5, table_id: null, parent_invoice_id: null });
        expect(await summaryReads(h)).toBe(1);
        vi.useRealTimers();
    });

    it('an event with no row (cleared) still reloads the summary', async () => {
        const h = setup();
        h.handler({ action: 'cleared', held_order_id: null, table_id: null, parent_invoice_id: null });
        expect(await summaryReads(h)).toBe(1);
        vi.useRealTimers();
    });
});

describe('PosTerminal reactivation after a held-order restore', () => {
    const CLEAN = { recovery: false, catalog: false, stock: false, catalogIds: [], settings: false, held: false, shift: false, tables: false };
    const reactivate = async ({ outcome = 'none', source = null, stock = false } = {}) => {
        const h = harness();
        h.d.isActive = { value: true };
        h.d.refreshTracker = { activate: () => ({ ...CLEAN, stock }) };
        h.d.onInventoryChanged = vi.fn(async () => {});
        h.d.stockRefresh = { noteNamed: vi.fn(), noteUnscoped: vi.fn() };
        const done = h.hooks.mount();
        await flush();
        h.settle(true);
        await done;
        await h.hooks.activate(); // initial KeepAlive activation: mount owns it
        h.d.refreshCartCatalogPrices.mockClear();
        h.d.refreshCatalogAndCart.mockClear();
        h.d.products.fetchData.mockClear();
        h.d.checkAndRestoreHeldOrder = vi.fn(async () => outcome);
        h.d.cart.consumeRestoreSource = () => source;
        await h.hooks.activate();
        await flush();
        return h.d;
    };
    const requests = d => d.refreshCartCatalogPrices.mock.calls.length + d.refreshCatalogAndCart.mock.calls.length
        + d.products.fetchData.mock.calls.length + d.onInventoryChanged.mock.calls.length + d.stockRefresh.noteUnscoped.mock.calls.length;

    it('re-resolves prices once for a local-fallback restore on reactivation with a clean catalog', async () => {
        const d = await reactivate({ outcome: 'local-held-order' });
        expect(d.refreshCartCatalogPrices).toHaveBeenCalledTimes(1);
        expect(d.refreshCartCatalogPrices).toHaveBeenCalledWith({ refreshPrices: true });
        expect(requests(d)).toBe(1);
    });

    it('re-resolves prices once after an Order Notes restore from the backup cart', async () => {
        const d = await reactivate({ source: 'local' });
        expect(d.refreshCartCatalogPrices).toHaveBeenCalledTimes(1);
        expect(d.refreshCartCatalogPrices).toHaveBeenCalledWith({ refreshPrices: true });
        expect(requests(d)).toBe(1);
    });

    it('does not re-resolve prices after a server-canonical restore', async () => {
        expect(requests(await reactivate({ outcome: 'server-canonical-held' }))).toBe(0);
        expect(requests(await reactivate({ source: 'server' }))).toBe(0);
    });

    it('sends nothing on a clean return with no restore', async () => {
        expect(requests(await reactivate())).toBe(0);
    });

    it('a stock change that arrived while parked stales every cached scope through the stock refresh on reactivation', async () => {
        const d = await reactivate({ stock: true });
        expect(d.stockRefresh.noteUnscoped).toHaveBeenCalledOnce();
        expect(d.stockRefresh.noteNamed).not.toHaveBeenCalled();
    });

    it('re-reads settings on reactivation when they changed while the terminal was parked', async () => {
        const h = harness();
        h.d.isActive = { value: true };
        h.d.refreshTracker = { activate: () => ({ ...CLEAN, settings: true }) };
        const done = h.hooks.mount();
        await flush();
        h.settle(true);
        await done;
        await h.hooks.activate(); // initial KeepAlive activation: mount owns it
        h.d.terminal.loadSettings.mockClear();
        const back = h.hooks.activate();
        await flush();
        expect(h.d.terminal.loadSettings.mock.calls).toEqual([[{ force: true }]]);
        h.settle(true);
        await back;
    });
});

describe('PosTerminal boot after a server-canonical held restore', () => {
    // Real cart-price refresh and retry; the first price read fails.
    const bootRestored = async ({ outcome = 'none', beforeMount = false }) => {
        const h = harness({ realPrices: true });
        Object.assign(h.d, {
            isActive: { value: true },
            cartItems: { value: [] },
            collectCartCatalogProductIds: () => [7],
            chunkProductIds: ids => [ids],
            requestedIdsCoverCurrentDraft: () => true,
            syncCategoryPrices: vi.fn(() => ({ repairedNoteSelections: 0 })),
            checkAndRestoreHeldOrder: vi.fn(async () => outcome),
        });
        h.d.cart.consumeServerCanonicalRestore = () => beforeMount;
        h.d.products.resolveCategoryPrices = vi.fn()
            .mockResolvedValueOnce({ response: { ok: false }, data: {} })
            .mockResolvedValue({ response: { ok: true }, data: { success: true, products: [{ id: 7 }] } });
        const done = h.hooks.mount();
        await flush();
        h.settle(true);
        await done;
        expect(h.d.syncCategoryPrices).not.toHaveBeenCalled();
        h.hooks.retryFailedReads();
        await flush();
        return h.d;
    };

    it.each([
        ['restored during mount', { outcome: 'server-canonical-held' }],
        ['restored before mount', { beforeMount: true }],
    ])('keeps held prices on the boot refresh and its retry (%s)', async (_, options) => {
        const d = await bootRestored(options);
        expect(d.products.fetchData).toHaveBeenCalledOnce();
        expect(d.products.resolveCategoryPrices).toHaveBeenCalledTimes(2);
        expect(d.syncCategoryPrices).toHaveBeenCalledOnce();
        expect(d.syncCategoryPrices.mock.calls[0][2]).toEqual({ refreshPrices: false });
    });
});
