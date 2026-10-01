import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = path.resolve(process.cwd());
const login = fs.readFileSync(path.join(ROOT, 'src/components/Login.vue'), 'utf8');
const client = fs.readFileSync(path.join(ROOT, 'src/shared/browserDeviceClient.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const adminBootstrap = fs.readFileSync(path.join(ROOT, 'src/admin/bootstrap.js'), 'utf8');
const arabic = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/shared/i18n/ar.json'), 'utf8'));

describe('login registered-browser wiring', () => {
    it('accepts the fresh twelve-digit programmer number from the numeric keypad', () => {
        expect(login).toContain('userNumber.value.length < 12');
    });

    it('tries PIN login first so programmer can pass, then verifies registered browsers when required', () => {
        const loginFlow = login.slice(login.indexOf('const login = async'), login.indexOf('const handleKeyDown'));
        expect(login).toContain('authenticateRegisteredDevice(userNumber.value)');
        expect(login).toContain("api/auth/login");
        expect(client).toContain("api/auth/webauthn/login/options");
        expect(client).toContain("api/auth/webauthn/login/verify");
        expect(loginFlow).toMatch(/DEVICE_AUTH_REQUIRED[\s\S]*authenticateRegisteredDevice/);
        expect(loginFlow.indexOf("api/auth/login")).toBeLessThan(loginFlow.indexOf('authenticateRegisteredDevice(userNumber.value)'));
        expect(loginFlow).not.toContain("if (authMode.value === 'enforced')");
    });

    it('describes enforcement as per-user and serves desktop enrollment as a real SPA route', () => {
        expect(login).toContain('Only users with a registered browser need device verification.');
        expect(login).not.toContain('Verify this registered device to continue.');
        expect(server).toContain("app.get('/device-enrollment', sendDistFile('login.html'))");
    });

    it('turns the first staged PIN login into an administrator approval request', () => {
        expect(login).toContain('requestBrowserApproval');
        expect(login).toContain('completeApprovedBrowserRequest');
        expect(login).toContain('cancelBrowserApproval');
        expect(login).toContain('approvalRequestId');
        expect(login).toContain('pos_browser_approval_request_id');
        expect(login).toContain('data.device_registration_required === true');
        expect(login).not.toContain("data.user?.device_auth_mode === 'staged'");
        expect(login).toContain('Waiting for administrator approval');
        expect(client).toContain('api/auth/webauthn/device-request/options');
        expect(client).toContain('api/auth/webauthn/device-request/status');
        expect(client).toContain('api/auth/webauthn/device-request/complete');
    });

    it('detects an enforced PIN-only browser without blocking the successful login', () => {
        const loginFlow = login.slice(login.indexOf('const login = async'), login.indexOf('const handleKeyDown'));
        expect(loginFlow).toContain('data.device_registration_suggested === true');
        expect(loginFlow).toMatch(/device_registration_suggested[\s\S]*requestBrowserApproval[\s\S]*finishLogin/);
        expect(loginFlow).toContain('preservePendingApproval = true');
        expect(loginFlow).toContain('finishLogin(data, { preservePendingApproval })');
        expect(main).toContain('startPendingBrowserApprovalMonitor()');
        expect(adminBootstrap).toContain('startPendingBrowserApprovalMonitor()');
    });

    it('fails clearly when device access is not ready without exposing device recovery', () => {
        expect(login).toContain("policy?.supported === false");
        expect(login).toContain('WEBAUTHN_CONFIG_INVALID');
        expect(login).not.toContain('/device-recovery');
        expect(login).not.toContain('Lost registered device?');
    });

    it('handles server saturation and refuses ambiguous plaintext before submitting login', () => {
        const loginFlow = login.slice(login.indexOf('const login = async'), login.indexOf('const handleKeyDown'));
        expect((loginFlow.match(/SERVER_BUSY/g) || [])).toHaveLength(2);
        const guard = "policy?.enforce_https === true && window.location.protocol !== 'https:'";
        expect(loginFlow).toContain(guard);
        expect(loginFlow.indexOf(guard)).toBeLessThan(loginFlow.indexOf("api/auth/login"));
        expect(loginFlow).not.toContain('window.location.href');
    });

    it('translates the failed-login lockout shown on Arabic terminals', () => {
        expect(arabic['Too many login attempts. Try again shortly.']).toBe('محاولات دخول كثيرة. حاول مرة أخرى بعد قليل.');
    });
});

describe('registered-browser key storage', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    function webStorage() {
        return { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    }

    // Minimal in-memory IndexedDB covering the calls the runtime key store makes.
    function fakeIndexedDb() {
        const stores = new Map();
        const request = (run) => {
            const req = {};
            queueMicrotask(() => { req.result = run(); req.onsuccess?.(); });
            return req;
        };
        return {
            stores,
            open: vi.fn(() => {
                const req = {};
                queueMicrotask(() => {
                    req.result = {
                        createObjectStore: (name) => stores.set(name, new Map()),
                        transaction: (name) => {
                            const store = stores.get(name);
                            return { objectStore: () => ({
                                get: (key) => request(() => store.get(key)),
                                put: (value, key) => request(() => { store.set(key, value); return key; }),
                            }) };
                        },
                        close: () => {},
                    };
                    if (!stores.size) req.onupgradeneeded?.();
                    req.onsuccess?.();
                });
                return req;
            }),
        };
    }

    it('keeps the registered-device key pair in IndexedDB and never in web storage', async () => {
        const local = webStorage();
        const session = webStorage();
        const idb = fakeIndexedDb();
        vi.stubGlobal('localStorage', local);
        vi.stubGlobal('sessionStorage', session);
        vi.stubGlobal('indexedDB', idb);
        vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, request_id: 'r1', message: 'm' }) })));
        const { requestBrowserApproval } = await import('../../shared/browserDeviceClient.js');

        await requestBrowserApproval('Till 1');

        const saved = idb.stores.get('keys')?.get('origin-key-v1');
        expect(saved?.privateKey).toBeInstanceOf(CryptoKey);
        expect(saved.privateKey.extractable).toBe(false);
        expect(local.setItem).not.toHaveBeenCalled();
        expect(session.setItem).not.toHaveBeenCalled();
    });
});
