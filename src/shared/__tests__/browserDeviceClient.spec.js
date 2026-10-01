import { describe, expect, it, vi } from 'vitest';
import { createBrowserDeviceClient } from '../browserDeviceClient.js';
import * as browserDeviceModule from '../browserDeviceClient.js';

function createHarness() {
    const stored = new Map();
    const publicKey = { type: 'public' };
    const privateKey = { type: 'private', extractable: false };
    const cryptoApi = {
        subtle: {
            generateKey: vi.fn(async () => ({ publicKey, privateKey })),
            exportKey: vi.fn(async (_format, key) => {
                if (key !== publicKey) throw new Error('private export attempted');
                return { kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' };
            }),
            sign: vi.fn(async () => new Uint8Array(64).fill(7).buffer),
        },
    };
    const keyStore = {
        get: vi.fn(async () => stored.get('key') || null),
        set: vi.fn(async (value) => stored.set('key', value)),
    };
    const fetchJsonImpl = vi.fn();
    return { client: createBrowserDeviceClient({ cryptoApi, keyStore, fetchJsonImpl }), cryptoApi, keyStore, fetchJsonImpl, stored };
}

describe('silent browser-device client', () => {
    it('keeps a detected browser pending until approval and clears it after binding', async () => {
        expect(browserDeviceModule.settlePendingBrowserApproval).toBeTypeOf('function');
        if (typeof browserDeviceModule.settlePendingBrowserApproval !== 'function') return;
        const stored = new Map([['pos_browser_approval_request_id', 'request-1']]);
        const storage = {
            getItem: (key) => stored.get(key) || null,
            setItem: (key, value) => stored.set(key, value),
            removeItem: (key) => stored.delete(key),
        };
        const complete = vi.fn()
            .mockResolvedValueOnce({ success: true, state: 'pending' })
            .mockResolvedValueOnce({ success: true, user: { id: 2 } });

        await browserDeviceModule.settlePendingBrowserApproval({ storage, complete });
        expect(storage.getItem('pos_browser_approval_request_id')).toBe('request-1');
        await browserDeviceModule.settlePendingBrowserApproval({ storage, complete });
        expect(storage.getItem('pos_browser_approval_request_id')).toBeNull();
    });

    it('stops retrying a browser request the server has declared invalid', async () => {
        expect(browserDeviceModule.settlePendingBrowserApproval).toBeTypeOf('function');
        if (typeof browserDeviceModule.settlePendingBrowserApproval !== 'function') return;
        const stored = new Map([['pos_browser_approval_request_id', 'expired-request']]);
        const storage = {
            getItem: (key) => stored.get(key) || null,
            removeItem: (key) => stored.delete(key),
        };

        await browserDeviceModule.settlePendingBrowserApproval({
            storage,
            complete: async () => ({ success: false, code: 'BROWSER_DEVICE_REQUEST_INVALID' }),
        });

        expect(storage.getItem('pos_browser_approval_request_id')).toBeNull();
    });
    it('creates one non-exportable browser key and reuses it', async () => {
        const { client, cryptoApi, keyStore } = createHarness();
        const first = await client.getOrCreateBrowserPublicKey();
        const second = await client.getOrCreateBrowserPublicKey();

        expect(first).toEqual({ kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' });
        expect(second).toEqual(first);
        expect(cryptoApi.subtle.generateKey).toHaveBeenCalledWith({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        expect(cryptoApi.subtle.generateKey).toHaveBeenCalledTimes(1);
        expect(cryptoApi.subtle.exportKey).toHaveBeenCalledTimes(2);
        expect(keyStore.set).toHaveBeenCalledWith(expect.objectContaining({ privateKey: expect.anything(), publicKey: expect.anything() }));
    });

    it('signs the exact server login message and sends no public key during authentication', async () => {
        const { client, fetchJsonImpl, cryptoApi } = createHarness();
        await client.getOrCreateBrowserPublicKey();
        fetchJsonImpl
            .mockResolvedValueOnce({ success: true, ceremony_id: 'c1', message: 'exact-message' })
            .mockResolvedValueOnce({ success: true, user: { id: 1 } });

        const result = await client.authenticateRegisteredDevice('0012');

        expect(result.success).toBe(true);
        expect(cryptoApi.subtle.sign).toHaveBeenCalledWith({ name: 'ECDSA', hash: 'SHA-256' }, expect.anything(), new TextEncoder().encode('exact-message'));
        expect(JSON.parse(fetchJsonImpl.mock.calls[0][1].body)).toEqual({ user_number: '0012' });
        expect(JSON.parse(fetchJsonImpl.mock.calls[1][1].body)).toEqual({ ceremony_id: 'c1', signature: expect.any(String) });
    });

    it('registers only the public JWK and a proof from the private browser key', async () => {
        const { client, fetchJsonImpl } = createHarness();
        fetchJsonImpl
            .mockResolvedValueOnce({ success: true, ceremony_id: 'c2', message: 'enrollment-message', user: { name: 'Cashier' } })
            .mockResolvedValueOnce({ success: true });

        const options = await client.getEnrollmentOptions('one-use');
        const result = await client.completeEnrollment('one-use', options);

        expect(result.success).toBe(true);
        expect(JSON.parse(fetchJsonImpl.mock.calls[1][1].body)).toEqual({
            ceremony_id: 'c2',
            enrollment_code: 'one-use',
            public_key: { kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' },
            signature: expect.any(String),
        });
    });

    it('fails closed when a previously registered browser key is missing', async () => {
        const { client, fetchJsonImpl } = createHarness();
        fetchJsonImpl.mockResolvedValueOnce({ success: true, ceremony_id: 'c1', message: 'exact-message' });
        await expect(client.authenticateRegisteredDevice('12')).rejects.toMatchObject({ code: 'BROWSER_DEVICE_KEY_MISSING' });
        expect(fetchJsonImpl).toHaveBeenCalledTimes(1);
    });

    it('reports unavailable browser storage with a stable actionable code', async () => {
        const { client, keyStore } = createHarness();
        keyStore.get.mockRejectedValueOnce(new Error('private mode denied IndexedDB'));

        await expect(client.getOrCreateBrowserPublicKey()).rejects.toMatchObject({
            code: 'BROWSER_DEVICE_UNSUPPORTED',
            message: 'This browser cannot store a registered-device key.',
        });
    });

    it('requests administrator approval and completes only after approval', async () => {
        const { client, fetchJsonImpl } = createHarness();
        fetchJsonImpl
            .mockResolvedValueOnce({ success: true, request_id: 'request-1', message: 'request-proof' })
            .mockResolvedValueOnce({ success: true, request_id: 'request-1', state: 'pending' })
            .mockResolvedValueOnce({ success: true, state: 'approved', message: 'approval-proof' })
            .mockResolvedValueOnce({ success: true, user: { id: 2, role: 'cashier' } });

        const pending = await client.requestBrowserApproval('Chrome on Windows');
        const completed = await client.completeApprovedBrowserRequest(pending.request_id);

        expect(pending.state).toBe('pending');
        expect(completed.success).toBe(true);
        expect(JSON.parse(fetchJsonImpl.mock.calls[0][1].body)).toEqual({
            device_label: 'Chrome on Windows',
            public_key: { kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' },
        });
        expect(JSON.parse(fetchJsonImpl.mock.calls[1][1].body)).toMatchObject({
            request_id: 'request-1',
            public_key: { kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' },
        });
        expect(JSON.parse(fetchJsonImpl.mock.calls[2][1].body)).toEqual({ request_id: 'request-1' });
        expect(JSON.parse(fetchJsonImpl.mock.calls[3][1].body)).toMatchObject({
            request_id: 'request-1',
            public_key: { kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' },
        });
    });

    it('cancels the exact waiting browser request', async () => {
        const { client, fetchJsonImpl } = createHarness();
        fetchJsonImpl.mockResolvedValueOnce({ success: true });

        await expect(client.cancelBrowserApproval('request-1')).resolves.toMatchObject({ success: true });
        expect(fetchJsonImpl).toHaveBeenCalledWith('api/auth/webauthn/device-request/cancel', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ request_id: 'request-1' }),
        }));
    });

    it('does not create a replacement key after an approved browser key is deleted', async () => {
        const { client, fetchJsonImpl, stored, cryptoApi } = createHarness();
        fetchJsonImpl
            .mockResolvedValueOnce({ success: true, request_id: 'request-1', message: 'request-proof' })
            .mockResolvedValueOnce({ success: true, request_id: 'request-1', state: 'pending' })
            .mockResolvedValueOnce({ success: true, state: 'approved', message: 'approval-proof' });

        await client.requestBrowserApproval('Chrome on Windows');
        stored.clear();

        await expect(client.completeApprovedBrowserRequest('request-1')).rejects.toMatchObject({ code: 'BROWSER_DEVICE_KEY_MISSING' });
        expect(cryptoApi.subtle.generateKey).toHaveBeenCalledTimes(1);
        expect(fetchJsonImpl).toHaveBeenCalledTimes(3);
    });
});

describe('pending browser-approval monitor (event-driven)', () => {
    const KEY = 'pos_browser_approval_request_id';
    const memoryStorage = (value) => {
        const stored = new Map(value ? [[KEY, value]] : []);
        return { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v), removeItem: (k) => stored.delete(k) };
    };
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    it('checks once, arms no timer, and checks again only on an event', async () => {
        vi.resetModules();
        const mod = await import('../browserDeviceClient.js');
        vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
        try {
            const storage = memoryStorage('request-1');
            const target = new EventTarget();
            const complete = vi.fn(async () => ({ success: true, state: 'pending' }));
            mod.startPendingBrowserApprovalMonitor({ storage, target, complete });
            await flush();
            expect(complete).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(60000);
            expect(complete).toHaveBeenCalledTimes(1);
            target.dispatchEvent(new Event('focus'));
            await flush();
            expect(complete).toHaveBeenCalledTimes(2);
            complete.mockResolvedValueOnce({ success: true, user: { id: 1 } });
            await mod.checkPendingBrowserApproval({ storage, complete });
            expect(storage.getItem(KEY)).toBeNull();
            target.dispatchEvent(new Event('online'));
            await flush();
            expect(complete).toHaveBeenCalledTimes(3);
        } finally { vi.useRealTimers(); }
    });

    it('keeps the pending request through a network error', async () => {
        vi.resetModules();
        const mod = await import('../browserDeviceClient.js');
        const storage = memoryStorage('request-2');
        const complete = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        await mod.checkPendingBrowserApproval({ storage, complete });
        expect(storage.getItem(KEY)).toBe('request-2');
        complete.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'WEBAUTHN_CEREMONY_EXPIRED' }));
        await mod.checkPendingBrowserApproval({ storage, complete });
        expect(storage.getItem(KEY)).toBeNull();
    });
});
