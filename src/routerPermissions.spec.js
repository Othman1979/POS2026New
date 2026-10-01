import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ guard: null, onError: null, router: null, user: null, routes: [] }));
vi.mock('vue-router', () => ({
    createWebHistory: () => ({}),
    createRouter: options => {
        state.routes = options.routes;
        state.router = {
            beforeEach: guard => { state.guard = guard; },
            onError: handler => { state.onError = handler; },
            currentRoute: { value: { matched: [] } },
        };
        return state.router;
    },
}));
vi.mock('@/shared/i18n.js', () => ({ t: key => key }));
vi.mock('./components/Login.vue', () => ({ default: {} }));
vi.mock('./components/PosTerminal.vue', () => ({ default: {} }));
vi.mock('./components/TableFloorPlan.vue', () => ({ default: {} }));
beforeAll(async () => { await import('./router.js'); });
beforeEach(() => {
    const session = new Map([['pos_user_at', String(Date.now())]]);
    state.session = session;
    vi.stubGlobal('sessionStorage', {
        getItem: key => key === 'pos_user' ? (state.user ? JSON.stringify(state.user) : null) : (session.get(key) ?? null),
        setItem: (key, value) => session.set(key, String(value)),
        removeItem: key => { if (key === 'pos_user') state.user = null; session.delete(key); },
    });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    vi.stubGlobal('window', { location: { reload: vi.fn(), href: '/pos' }, showPosToast: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
    state.router.currentRoute.value.matched = [];
});
afterEach(() => vi.unstubAllGlobals());

it('keeps the two large operational screens out of the shared startup chunk', () => {
    const pos = state.routes.find(route => route.path === '/pos');
    const tables = state.routes.find(route => route.path === '/tables');
    expect(typeof pos?.component).toBe('function');
    expect(typeof tables?.component).toBe('function');
});

it('keeps the mounted order screen intact when a deployment chunk is unavailable', () => {
    state.router.currentRoute.value.matched = [{}];
    state.onError(new Error('Failed to fetch dynamically imported module'));
    expect(window.showPosToast).toHaveBeenCalledOnce();
    expect(window.location.reload).not.toHaveBeenCalled();
});

it('reloads at most once when a cold boot cannot load its route chunk', () => {
    state.onError(new Error('Failed to fetch dynamically imported module'));
    state.onError(new Error('Failed to fetch dynamically imported module'));
    expect(window.location.reload).toHaveBeenCalledOnce();
});

// Node's navigator has no onLine; define it per test.
const setOnLine = (value) => Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => value });
const clearOnLine = () => { delete globalThis.navigator.onLine; };

it.each([
    [false, 'Connection problem. Check the connection and try again.'],
    [true, 'Could not load this screen. Check the connection, or refresh when the current order is complete.'],
])('names a failed screen chunk honestly (online: %s)', (online, message) => {
    setOnLine(online);
    try {
        state.router.currentRoute.value.matched = [{}];
        state.onError(new Error('Failed to fetch dynamically imported module'));
        expect(window.showPosToast).toHaveBeenCalledWith(message, 'warning');
    } finally { clearOnLine(); }
});

it('treats a failed CSS preload as a chunk failure', () => {
    state.onError(new Error('Unable to preload CSS for /chunks/PosTerminal-x.css'));
    expect(window.location.reload).toHaveBeenCalledOnce();
});

it('retries a repeated cold-boot chunk failure when the connection returns instead of stranding the boot', () => {
    const listeners = new Map();
    window.addEventListener = vi.fn((type, fn) => listeners.set(type, fn));
    state.session.set('pos_chunk_reload_attempted_at', String(Date.now()));
    state.onError(new Error('Failed to fetch dynamically imported module'));
    expect(window.location.reload).not.toHaveBeenCalled();
    listeners.get('online')();
    expect(window.location.reload).toHaveBeenCalledOnce();
});

it('never reloads a failed cold boot into the browser offline page on a tap while offline', () => {
    const listeners = new Map();
    window.addEventListener = vi.fn((type, fn) => listeners.set(type, fn));
    window.removeEventListener = vi.fn();
    setOnLine(false);
    try {
        state.session.set('pos_chunk_reload_attempted_at', String(Date.now()));
        state.onError(new Error('Failed to fetch dynamically imported module'));
        listeners.get('pointerdown')();
        expect(window.location.reload).not.toHaveBeenCalled();
        setOnLine(true);
        listeners.get('online')();
        expect(window.location.reload).toHaveBeenCalledOnce();
    } finally { clearOnLine(); }
});

it.each([
    ['waiter', [], undefined],
    ['cashier', [], '/pos'],
    ['cashier', ['tables.access'], undefined],
    ['call_center', ['tables.access'], '/pos'],
    ['unknown-role', ['tables.access'], '/pos'],
    ['admin', [], undefined],
])('routes %s table entry through the shared role and grant policy', async (role, permissions, expected) => {
    state.user = { id: 7, role, permissions };
    expect(await state.guard({ path: '/tables', meta: { requiresAuth: true } })).toBe(expected);
});

it.each([
    ['/table-splits', ['pos.split_checks']],
    ['/order-notes', ['pos.hold_orders', 'orders.view']],
])('sends call-center users from %s back to the POS even when granted it', async (path, permissions) => {
    state.user = { id: 20, role: 'call_center', permissions };
    expect(await state.guard({ path, meta: { requiresAuth: true } })).toBe('/pos');
});

it('exports the same loader functions the routes use for boot-time warming', async () => {
    const mod = await import('./router.js');
    const pos = state.routes.find(route => route.path === '/pos');
    const tables = state.routes.find(route => route.path === '/tables');
    expect(pos.component).toBe(mod.loadPosTerminal);
    expect(tables.component).toBe(mod.loadTableFloorPlan);
});

async function bootAt(pathname) {
    const boot = {
        mount: vi.fn(),
        loadBusinessConfig: vi.fn(async () => {}),
        loadPosTerminal: vi.fn(async () => {}),
        loadTableFloorPlan: vi.fn(async () => {}),
    };
    const app = { config: {}, use: () => app, mount: boot.mount };
    vi.resetModules();
    const mocks = {
        '@/shared/authInterceptor.js': () => ({}),
        vue: () => ({ createApp: () => app }),
        pinia: () => ({ createPinia: () => ({}) }),
        './App.vue': () => ({ default: {} }),
        './router.js': () => ({ default: {}, loadPosTerminal: boot.loadPosTerminal, loadTableFloorPlan: boot.loadTableFloorPlan }),
        '@/shared/i18n.js': () => ({
            createPosI18n: () => ({}), currentLanguage: { value: 'en' },
            prepareLanguage: async () => true, setLanguage: vi.fn(), deferLanguage: vi.fn(),
        }),
        '@/shared/faviconInjector.js': () => ({ injectStoreFavicon: vi.fn() }),
        '@/shared/browserDeviceClient.js': () => ({ startPendingBrowserApprovalMonitor: vi.fn() }),
        './utils/businessDate.js': () => ({ loadBusinessConfig: boot.loadBusinessConfig }),
    };
    for (const [id, factory] of Object.entries(mocks)) vi.doMock(id, factory);
    vi.stubGlobal('window', { location: { pathname } });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', { documentElement: {} });
    try {
        await import('./main.js');
        await vi.waitFor(() => expect(boot.mount).toHaveBeenCalledWith('#app'));
    } finally {
        Object.keys(mocks).forEach(id => vi.doUnmock(id));
        vi.resetModules();
    }
    return boot;
}

it.each([
    ['/login', 0, 0, 0],
    ['/device-enrollment', 0, 0, 0],
    ['/pos', 1, 1, 0],
    ['/tables/4', 1, 0, 1],
])('on %s boot reads the business config %i time(s) and warms the POS chunk %i and tables chunk %i time(s)', async (pathname, configReads, posWarm, tablesWarm) => {
    const boot = await bootAt(pathname);
    expect(boot.loadBusinessConfig).toHaveBeenCalledTimes(configReads);
    expect(boot.loadPosTerminal).toHaveBeenCalledTimes(posWarm);
    expect(boot.loadTableFloorPlan).toHaveBeenCalledTimes(tablesWarm);
});

const jsonResponse = (status, body) => ({ status, ok: status < 400, json: async () => body });
const stale = () => state.session.set('pos_user_at', String(Date.now() - 31 * 60 * 1000));
const posRoute = { path: '/pos', fullPath: '/pos', meta: { requiresAuth: true } };

it('keeps a stale cashier signed in when the session check answers 503', async () => {
    state.user = { id: 7, role: 'cashier', permissions: [] };
    stale();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, { success: false, code: 'SESSION_CHECK_UNAVAILABLE' })));
    expect(await state.guard(posRoute)).toBeUndefined();
    await new Promise(r => setTimeout(r, 0));
    expect(state.user).not.toBeNull();
    expect(window.location.href).toBe('/pos');
});

it('does not hold a stale navigation on a pending session check', async () => {
    state.user = { id: 7, role: 'cashier', permissions: [] };
    stale();
    let release;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(r => { release = r; })));
    const result = await Promise.race([state.guard(posRoute), new Promise(r => setTimeout(() => r('blocked'), 50))]);
    release(jsonResponse(503, { success: false }));
    await new Promise(r => setTimeout(r, 0));
    expect(result).toBeUndefined();
});

it('retries a cold session restore after a network error instead of opening login', async () => {
    vi.useFakeTimers();
    try {
        state.user = null;
        const fetch = vi.fn()
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValue(jsonResponse(200, { success: true, user: { id: 7, role: 'cashier', permissions: [] } }));
        vi.stubGlobal('fetch', fetch);
        const pending = state.guard(posRoute);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await pending).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(window.location.href).toBe('/pos');
    } finally { vi.useRealTimers(); }
});

it('retries a cold restore on a tap once the quick retries are used up, without a timer', async () => {
    vi.useFakeTimers();
    try {
        state.user = null;
        const listeners = new Map();
        window.addEventListener = vi.fn((type, fn) => listeners.set(type, fn));
        window.removeEventListener = vi.fn(type => listeners.delete(type));
        const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
        vi.stubGlobal('fetch', fetch);
        const pending = state.guard(posRoute);
        await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
        expect(fetch).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(60000);
        expect(fetch).toHaveBeenCalledTimes(4);
        fetch.mockResolvedValue(jsonResponse(200, { success: true, user: { id: 7, role: 'cashier', permissions: [] } }));
        listeners.get('pointerdown')();
        expect(await pending).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(5);
    } finally { vi.useRealTimers(); }
});

it('sends a cold terminal to login when the server rejects the session', async () => {
    state.user = null;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { success: false, code: 'SESSION_REQUIRED' })));
    expect(await state.guard(posRoute)).toBe(false);
    expect(window.location.href).toBe('/login');
});
