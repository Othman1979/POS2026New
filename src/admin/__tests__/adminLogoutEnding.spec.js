import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSessionEnding, setSessionEnding } from '@/pos/sessionEnding.js';

// No DOM here: run the composable's mount hook straight away.
vi.mock('vue', async (importOriginal) => ({ ...(await importOriginal()), onMounted: fn => fn(), onUnmounted: () => {} }));
const { useAdminSession } = await import('../composables/useAdminSession.js');

afterEach(() => {
    setSessionEnding(false);
    vi.unstubAllGlobals();
});

function stubWindow() {
    const listeners = {};
    vi.stubGlobal('window', {
        location: { href: '' },
        addEventListener: (type, fn) => { listeners[type] = fn; },
        removeEventListener: () => {},
    });
    return listeners;
}

describe('admin logout', () => {
    it('marks the session ending and clears the active user before the logout request is sent', async () => {
        let atRequest;
        const localStorage = { removeItem: vi.fn() };
        vi.stubGlobal('fetch', vi.fn(async () => {
            atRequest = {
                ending: isSessionEnding(),
                activeUserCleared: localStorage.removeItem.mock.calls.some(([key]) => key === 'pos_active_user_id'),
            };
            return {};
        }));
        vi.stubGlobal('sessionStorage', { removeItem: vi.fn(), getItem: vi.fn() });
        vi.stubGlobal('localStorage', localStorage);
        stubWindow();
        await useAdminSession().logout('expired');
        expect(atRequest).toEqual({ ending: true, activeUserCleared: true });
    });

    it('a sibling tab stands down when another tab clears the active user', async () => {
        vi.stubGlobal('sessionStorage', { removeItem: vi.fn(), getItem: vi.fn(() => JSON.stringify({ id: 7 })) });
        vi.stubGlobal('localStorage', { removeItem: vi.fn() });
        const listeners = stubWindow();
        useAdminSession();
        await listeners.storage({ key: 'pos_active_user_id', newValue: null });
        expect(isSessionEnding()).toBe(true);
        expect(window.location.href).toBe('/login');
    });
});

describe('admin socket auth error', () => {
    it('cleans up locally without sending another logout request', async () => {
        const fetch = vi.fn(async () => ({}));
        vi.stubGlobal('fetch', fetch);
        vi.stubGlobal('sessionStorage', { removeItem: vi.fn(), getItem: vi.fn() });
        vi.stubGlobal('localStorage', { removeItem: vi.fn() });
        const listeners = stubWindow();
        useAdminSession();
        await listeners.socket_auth_error({ detail: 'Unauthorized: revoked' });
        expect(fetch).not.toHaveBeenCalled();
        expect(window.location.href).toBe('/login?reason=expired');
    });
});
