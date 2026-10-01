import { fetchJson } from './http.js';

const DB_NAME = 'posapp-browser-device';
const STORE_NAME = 'keys';
const KEY_NAME = 'origin-key-v1';
const PENDING_APPROVAL_STORAGE_KEY = 'pos_browser_approval_request_id';
const TERMINAL_APPROVAL_CODES = new Set([
    'BROWSER_DEVICE_REQUEST_INVALID',
    'BROWSER_DEVICE_KEY_MISSING',
    'WEBAUTHN_CEREMONY_EXPIRED',
    'WEBAUTHN_CEREMONY_INVALID',
    'WEBAUTHN_CEREMONY_REPLAYED',
]);

function jsonOptions() {
    return { headers: { 'Content-Type': 'application/json' } };
}

function apiError(data, fallback) {
    if (data?.success) return null;
    return Object.assign(new Error(data?.message || fallback), { code: data?.code || 'BROWSER_DEVICE_FAILED' });
}

function toBase64Url(value) {
    const bytes = new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createIndexedDbStore(indexedDb = globalThis.indexedDB) {
    function open() {
        return new Promise((resolve, reject) => {
            const request = indexedDb.open(DB_NAME, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Browser key storage is unavailable.'));
        });
    }
    async function transact(mode, operation) {
        const db = await open();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, mode);
                const request = operation(tx.objectStore(STORE_NAME));
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(request.error || new Error('Browser key storage failed.'));
                tx.onabort = () => reject(tx.error || new Error('Browser key storage failed.'));
            });
        } finally { db.close(); }
    }
    return {
        get: () => transact('readonly', (store) => store.get(KEY_NAME)),
        set: (value) => transact('readwrite', (store) => store.put(value, KEY_NAME)),
    };
}

function missingKeyError() {
    return Object.assign(new Error('This browser is not registered for this user.'), { code: 'BROWSER_DEVICE_KEY_MISSING' });
}

function storageUnavailableError() {
    return Object.assign(new Error('This browser cannot store a registered-device key.'), { code: 'BROWSER_DEVICE_UNSUPPORTED' });
}

export function createBrowserDeviceClient({ cryptoApi, keyStore, fetchJsonImpl = fetchJson } = {}) {
    async function readKeyPair() {
        let pair;
        try { pair = await keyStore.get(); } catch { throw storageUnavailableError(); }
        return pair?.privateKey && pair?.publicKey ? pair : null;
    }

    async function exportPublicKey(pair) {
        let jwk;
        try { jwk = await cryptoApi.subtle.exportKey('jwk', pair.publicKey); } catch { throw storageUnavailableError(); }
        return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    }

    async function getExistingBrowserPublicKey() {
        const pair = await readKeyPair();
        if (!pair) throw missingKeyError();
        return exportPublicKey(pair);
    }

    async function getOrCreateBrowserPublicKey() {
        let pair = await readKeyPair();
        if (!pair) {
            try { pair = await cryptoApi.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']); }
            catch { throw storageUnavailableError(); }
            try { await keyStore.set(pair); } catch { throw storageUnavailableError(); }
        }
        return exportPublicKey(pair);
    }

    async function signBrowserDeviceMessage(message, { create = false } = {}) {
        let pair = await readKeyPair();
        if (!pair && create) {
            await getOrCreateBrowserPublicKey();
            pair = await readKeyPair();
        }
        if (!pair) throw missingKeyError();
        const signature = await cryptoApi.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(String(message || '')));
        return toBase64Url(signature);
    }

    async function requestProofOptions(path, body, fallback) {
        const data = await fetchJsonImpl(path, { method: 'POST', ...jsonOptions(), body: JSON.stringify(body) });
        const error = apiError(data, fallback);
        if (error) throw error;
        return data;
    }

    async function authenticateRegisteredDevice(userNumber) {
        const options = await requestProofOptions('api/auth/webauthn/login/options', { user_number: String(userNumber || '') }, 'Unable to start device verification.');
        const signature = await signBrowserDeviceMessage(options.message);
        return fetchJsonImpl('api/auth/webauthn/login/verify', { method: 'POST', ...jsonOptions(), body: JSON.stringify({ ceremony_id: options.ceremony_id, signature }) });
    }

    async function getEnrollmentOptions(enrollmentCode) {
        return requestProofOptions('api/auth/webauthn/enroll/options', { enrollment_code: String(enrollmentCode || '') }, 'Enrollment code is invalid or expired.');
    }

    async function completeEnrollment(enrollmentCode, options) {
        const publicKey = await getOrCreateBrowserPublicKey();
        const signature = await signBrowserDeviceMessage(options.message);
        return fetchJsonImpl('api/auth/webauthn/enroll/verify', {
            method: 'POST', ...jsonOptions(),
            body: JSON.stringify({ ceremony_id: options.ceremony_id, enrollment_code: enrollmentCode, public_key: publicKey, signature }),
        });
    }

    async function requestBrowserApproval(deviceLabel) {
        const publicKey = await getOrCreateBrowserPublicKey();
        const options = await requestProofOptions('api/auth/webauthn/device-request/options', { device_label: String(deviceLabel || ''), public_key: publicKey }, 'Unable to request browser approval.');
        const signature = await signBrowserDeviceMessage(options.message);
        return fetchJsonImpl('api/auth/webauthn/device-request/submit', {
            method: 'POST', ...jsonOptions(),
            body: JSON.stringify({ request_id: options.request_id, public_key: publicKey, signature }),
        });
    }

    async function cancelBrowserApproval(requestId) {
        return requestProofOptions('api/auth/webauthn/device-request/cancel', { request_id: String(requestId || '') }, 'Unable to cancel browser approval.');
    }

    async function completeApprovedBrowserRequest(requestId) {
        const status = await requestProofOptions('api/auth/webauthn/device-request/status', { request_id: String(requestId || '') }, 'Unable to check browser approval.');
        if (status.state !== 'approved') return status;
        const publicKey = await getExistingBrowserPublicKey();
        const signature = await signBrowserDeviceMessage(status.message);
        return fetchJsonImpl('api/auth/webauthn/device-request/complete', {
            method: 'POST', ...jsonOptions(),
            body: JSON.stringify({ request_id: requestId, public_key: publicKey, signature }),
        });
    }

    async function beginStepUp() {
        const options = await requestProofOptions('api/auth/webauthn/step-up/options', {}, 'Unable to start device verification.');
        const signature = await signBrowserDeviceMessage(options.message);
        return fetchJsonImpl('api/auth/webauthn/step-up/verify', { method: 'POST', ...jsonOptions(), body: JSON.stringify({ ceremony_id: options.ceremony_id, signature }) });
    }

    async function bootstrapRegisteredDevice({ secret, deviceLabel }) {
        const options = await requestProofOptions('api/admin/device-access/bootstrap/options', { bootstrap_secret: secret, device_label: deviceLabel }, 'Bootstrap is unavailable.');
        const publicKey = await getOrCreateBrowserPublicKey();
        const signature = await signBrowserDeviceMessage(options.message);
        return fetchJsonImpl('api/admin/device-access/bootstrap/verify', {
            method: 'POST', ...jsonOptions(),
            body: JSON.stringify({ ceremony_id: options.ceremony_id, bootstrap_secret: secret, public_key: publicKey, signature }),
        });
    }

    return { getOrCreateBrowserPublicKey, signBrowserDeviceMessage, authenticateRegisteredDevice, getEnrollmentOptions, completeEnrollment, requestBrowserApproval, completeApprovedBrowserRequest, cancelBrowserApproval, beginStepUp, bootstrapRegisteredDevice };
}

export function isBrowserDeviceSupported() {
    return typeof globalThis.crypto?.subtle !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
}

export function browserDeviceLabel(navigatorLike = globalThis.navigator) {
    const ua = String(navigatorLike?.userAgent || '');
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const platform = String(navigatorLike?.userAgentData?.platform || (/Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone/iPad' : /Mac/i.test(ua) ? 'macOS' : navigatorLike?.platform || 'device'));
    return `${browser} on ${platform}`.slice(0, 100);
}

function runtimeClient() {
    if (!isBrowserDeviceSupported()) throw Object.assign(new Error('This browser cannot store a registered-device key.'), { code: 'BROWSER_DEVICE_UNSUPPORTED' });
    return createBrowserDeviceClient({ cryptoApi: globalThis.crypto, keyStore: createIndexedDbStore() });
}

export const getLoginPolicy = () => fetchJson('api/auth/login-policy');
export const authenticateRegisteredDevice = (...args) => runtimeClient().authenticateRegisteredDevice(...args);
export const getEnrollmentOptions = (...args) => runtimeClient().getEnrollmentOptions(...args);
export const completeEnrollment = (...args) => runtimeClient().completeEnrollment(...args);
export const requestBrowserApproval = (...args) => runtimeClient().requestBrowserApproval(...args);
export const completeApprovedBrowserRequest = (...args) => runtimeClient().completeApprovedBrowserRequest(...args);
export const cancelBrowserApproval = (...args) => runtimeClient().cancelBrowserApproval(...args);
export const beginStepUp = (...args) => runtimeClient().beginStepUp(...args);
export const bootstrapRegisteredDevice = (...args) => runtimeClient().bootstrapRegisteredDevice(...args);

export async function settlePendingBrowserApproval({ storage = globalThis.sessionStorage, complete = completeApprovedBrowserRequest } = {}) {
    const requestId = storage?.getItem(PENDING_APPROVAL_STORAGE_KEY);
    if (!requestId) return { success: true, state: 'none' };
    const result = await complete(requestId);
    if ((result?.success && result?.user) || TERMINAL_APPROVAL_CODES.has(result?.code)) {
        storage.removeItem(PENDING_APPROVAL_STORAGE_KEY);
    }
    return result;
}

// The pending approval settles on events only: once at boot, on focus/online, on socket
// reconnect and on the server's device_request_changed push. No timer, no poll.
let pendingCheck = null;
let wakeTarget = null;
let wakeOptions = {};
const onWake = () => { void checkPendingBrowserApproval(wakeOptions); };

function detachWakeListeners() {
    wakeTarget?.removeEventListener('focus', onWake);
    wakeTarget?.removeEventListener('online', onWake);
    wakeTarget = null;
}

export function checkPendingBrowserApproval({ storage = globalThis.sessionStorage, complete } = {}) {
    if (!storage?.getItem(PENDING_APPROVAL_STORAGE_KEY)) { detachWakeListeners(); return Promise.resolve(); }
    pendingCheck ||= settlePendingBrowserApproval({ storage, ...(complete ? { complete } : {}) })
        // A transport error keeps the request: it is still pending on the server.
        .catch((error) => { if (TERMINAL_APPROVAL_CODES.has(error?.code)) storage.removeItem(PENDING_APPROVAL_STORAGE_KEY); })
        .finally(() => {
            pendingCheck = null;
            if (!storage.getItem(PENDING_APPROVAL_STORAGE_KEY)) detachWakeListeners();
        });
    return pendingCheck;
}

export function startPendingBrowserApprovalMonitor({ storage = globalThis.sessionStorage, target = globalThis.window, complete } = {}) {
    if (!storage?.getItem(PENDING_APPROVAL_STORAGE_KEY)) return;
    wakeOptions = { storage, complete };
    if (!wakeTarget && target) {
        wakeTarget = target;
        target.addEventListener('focus', onWake);
        target.addEventListener('online', onWake);
    }
    void checkPendingBrowserApproval(wakeOptions);
}
export const isTerminalApprovalCode = (code) => TERMINAL_APPROVAL_CODES.has(code);
export { apiError };
