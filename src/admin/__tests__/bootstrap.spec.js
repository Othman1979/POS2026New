import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
    const deferred = () => {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        return { promise, resolve };
    };
    return { app: deferred(), i18n: deferred(), config: deferred(), calls: [] };
});

vi.mock('vue', () => ({
    createApp: vi.fn(() => {
        h.calls.push('createApp');
        return { config: {}, use: vi.fn(), mount: vi.fn(() => h.calls.push('mount')) };
    })
}));
vi.mock('vue-router', () => ({ isNavigationFailure: () => false }));
vi.mock('../router.js', () => ({ createAdminRouter: () => ({ isReady: async () => {} }) }));
vi.mock('../pageRegistry.js', () => ({
    initialPage: () => 'dashboard',
    preloadPage: vi.fn(() => h.calls.push('preloadPage'))
}));
vi.mock('../App.vue', () => h.app.promise.then(() => ({ default: {} })));
vi.mock('@/shared/i18n.js', () => h.i18n.promise.then(() => ({
    currentLanguage: { value: 'en' },
    prepareLanguage: async () => true,
    setLanguage: async () => {},
    createPosI18n: () => ({ install() {} })
})));
vi.mock('../../utils/businessDate.js', () => ({
    loadBusinessConfig: vi.fn(() => { h.calls.push('loadBusinessConfig'); return h.config.promise; })
}));
vi.mock('@/shared/authInterceptor.js', () => ({}));
vi.mock('@/shared/faviconInjector.js', () => ({ injectStoreFavicon: vi.fn() }));
vi.mock('@/shared/browserDeviceClient.js', () => ({ startPendingBrowserApprovalMonitor: vi.fn() }));

vi.stubGlobal('localStorage', { getItem: () => null });
vi.stubGlobal('document', { documentElement: {}, getElementById: () => null });
vi.stubGlobal('window', { location: { pathname: '/admin' }, dispatchEvent: () => {} });

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('admin boot', () => {
    it('starts every load at once and mounts only after language and config are ready', async () => {
        await import('../bootstrap.js');
        await flush();
        // All three loads are in flight while the App chunk is still pending.
        expect(h.calls).toEqual(['preloadPage', 'loadBusinessConfig']);

        h.app.resolve();
        h.i18n.resolve();
        await flush();
        expect(h.calls).not.toContain('createApp');

        h.config.resolve();
        await flush();
        expect(h.calls).toEqual(['preloadPage', 'loadBusinessConfig', 'createApp', 'mount']);
    });
});
