import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';

const mounted = [];
vi.mock('vue', async original => ({ ...await original(), useSSRContext: () => ({ modules: new Set() }), onMounted: fn => mounted.push(fn), onUnmounted: () => {} }));
vi.mock('vue-router', () => ({ useRouter: () => ({}) }));
vi.mock('@/shared/i18n.js', () => ({ t: s => s, setLanguage: vi.fn(async () => {}) }));
vi.mock('@/pos/posSessionStorage.js', () => ({ clearPosOrderSessionStorage: () => {} }));
vi.mock('@/shared/browserDeviceClient.js', () => ({
    authenticateRegisteredDevice: vi.fn(), browserDeviceLabel: () => 'x', cancelBrowserApproval: vi.fn(),
    completeApprovedBrowserRequest: vi.fn(), getLoginPolicy: vi.fn(), isBrowserDeviceSupported: () => true,
    requestBrowserApproval: vi.fn(), isTerminalApprovalCode: c => c === 'WEBAUTHN_CEREMONY_EXPIRED',
}));

const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
const json = data => ({ ok: true, status: 200, json: async () => data });
const flush = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); await nextTick(); } };
let scope, state, calls, location;

async function mountLogin(route, { policy, awaitMount = true } = {}) {
    vi.resetModules(); mounted.length = 0;
    calls = []; location = { protocol: 'http:', search: '', pathname: '/login', href: '' };
    vi.stubGlobal('window', { location, addEventListener() {}, removeEventListener() {}, setInterval() {}, clearInterval() {} });
    vi.stubGlobal('sessionStorage', store()); vi.stubGlobal('localStorage', store());
    vi.stubGlobal('fetch', vi.fn((url, opts) => { calls.push(String(url)); return route(String(url), opts); }));
    const client = await import('@/shared/browserDeviceClient.js');
    client.getLoginPolicy.mockImplementation(() => { calls.push('policy'); return policy ? policy() : Promise.resolve({ success: true, mode: 'disabled' }); });
    const { default: Login } = await import('../Login.vue');
    scope = effectScope();
    state = scope.run(() => Login.setup({}, { expose() {} }));
    const mounting = Promise.all(mounted.map(fn => fn()));
    if (awaitMount) await mounting;
    return client;
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { scope?.stop(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('login submit', () => {
    it('a policy read that stalls without failing does not hold the submit', async () => {
        vi.useFakeTimers();
        let policyReads = 0;
        await mountLogin(url => url.includes('auth/login')
            ? Promise.resolve(json({ success: true, user: { id: 1, role: 'cashier' } }))
            : Promise.resolve(json({ success: true, admin_language: 'en' })),
        { awaitMount: false, policy: () => (++policyReads === 1 ? new Promise(() => {}) : Promise.resolve({ success: true, mode: 'disabled' })) });
        state.userNumber.value = '1234';
        const first = state.login();
        await vi.advanceTimersByTimeAsync(8000);
        await first;
        expect(state.isLoading.value).toBe(false);
        expect(state.errorMessage.value).toBe('Network error connecting to server.');
        await state.login();
        expect(policyReads).toBe(2);
        expect(calls.filter(c => c.includes('auth/login'))).toHaveLength(1);
        expect(location.href).toBe('/pos');
    });

    it('reads policy and preferences once per page and double Enter sends one login POST', async () => {
        let release;
        await mountLogin(url => url.includes('auth/login')
            ? new Promise(r => { release = () => r(json({ success: true, user: { id: 1, role: 'cashier' } })); })
            : Promise.resolve(json({ success: true, admin_language: 'en' })));
        state.userNumber.value = '1234';
        state.handleKeyDown({ key: 'Enter' });
        state.handleKeyDown({ key: 'Enter' });
        await flush(); release(); await flush();
        expect(calls.filter(c => c.includes('auth/login'))).toHaveLength(1);
        expect(calls.filter(c => c === 'policy')).toHaveLength(1);
        expect(calls.filter(c => c.includes('public_preferences'))).toHaveLength(1);
        expect(location.href).toBe('/pos');
    });

    it('a stalled login POST ends the spinner so the cashier can retry', async () => {
        await mountLogin((url, opts) => url.includes('auth/login')
            ? new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)))
            : Promise.resolve(json({ success: true })));
        vi.useFakeTimers();
        state.userNumber.value = '1234';
        const pending = state.login();
        await vi.advanceTimersByTimeAsync(20000);
        await pending;
        expect(state.isLoading.value).toBe(false);
        expect(state.errorMessage.value).toBe('Network error connecting to server.');
    });

    it('a stalled browser-approval suggestion does not hold the login', async () => {
        const client = await mountLogin(url => Promise.resolve(json(url.includes('auth/login')
            ? { success: true, device_registration_suggested: true, user: { id: 1, role: 'cashier' } }
            : { success: true })));
        client.requestBrowserApproval.mockImplementation(() => new Promise(() => {}));
        vi.useFakeTimers();
        state.userNumber.value = '1234';
        const pending = state.login();
        await vi.advanceTimersByTimeAsync(20000);
        await pending;
        expect(location.href).toBe('/pos');
    });

    it('a transient error keeps the approval wait; a terminal code ends it; checks are slow and bounded', async () => {
        vi.useFakeTimers();
        const prefs = () => Promise.resolve(json({ success: true, admin_language: 'en' }));
        vi.stubGlobal('sessionStorage', store());
        const client = await mountLogin(prefs, { awaitMount: false });
        sessionStorage.setItem('pos_browser_approval_request_id', 'req-1');
        client.completeApprovedBrowserRequest.mockRejectedValue(new TypeError('Failed to fetch'));
        await Promise.all(mounted.map(fn => fn()));
        await flush();
        expect(client.completeApprovedBrowserRequest).toHaveBeenCalledTimes(1);
        expect(state.approvalRequestId.value).toBe('req-1');
        expect(sessionStorage.getItem('pos_browser_approval_request_id')).toBe('req-1');
        await vi.advanceTimersByTimeAsync(60000);
        const afterMinute = client.completeApprovedBrowserRequest.mock.calls.length;
        expect(afterMinute).toBeGreaterThan(1);
        expect(afterMinute).toBeLessThanOrEqual(5);
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(client.completeApprovedBrowserRequest.mock.calls.length).toBeLessThanOrEqual(45);
        expect(vi.getTimerCount()).toBe(0);
        client.completeApprovedBrowserRequest.mockRejectedValue(Object.assign(new Error('Expired'), { code: 'WEBAUTHN_CEREMONY_EXPIRED' }));
        await state.checkApproval();
        expect(state.approvalRequestId.value).toBe('');
        expect(sessionStorage.getItem('pos_browser_approval_request_id')).toBeNull();
    });
});
