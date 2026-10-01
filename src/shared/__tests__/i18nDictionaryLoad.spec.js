import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Arabic dictionary is a fetched asset with a deadline, so a download that stalls
// on a bad link fails and a later retry (boot deferral, socket heartbeat) starts afresh.
describe('Arabic dictionary loading', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('gives up on a stalled download and starts a fresh one on the next attempt', async () => {
        const fetch = vi.fn((_url, { signal }) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
        }));
        vi.stubGlobal('fetch', fetch);
        const { prepareLanguage } = await import('../i18n/runtime.js');

        const first = prepareLanguage('ar');
        await vi.advanceTimersByTimeAsync(8000);
        expect(await first).toBe(false);

        fetch.mockImplementation(async () => ({ ok: true, json: async () => ({ Hello: 'مرحبا' }) }));
        expect(await prepareLanguage('ar')).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
