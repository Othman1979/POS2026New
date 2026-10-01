import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('system settings cache', () => {
    it('shares one read across concurrent consumers and cached reads', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ success: true, store_name: 'Current' }) }));
        const { getSystemSettings } = await import('../systemSettings.js');
        const results = await Promise.all([getSystemSettings(), getSystemSettings(), getSystemSettings()]);
        expect(await getSystemSettings()).toBe(results[0]);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('keeps invalidated reads from restoring old settings or detaching the current request', async () => {
        const pending = [];
        vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => pending.push(resolve))));
        const { getSystemSettings, invalidateSystemSettings } = await import('../systemSettings.js');
        const oldRead = getSystemSettings();
        invalidateSystemSettings();
        const currentRead = getSystemSettings();
        pending[0]({ json: async () => ({ success: true, store_name: 'Old' }) });
        await Promise.resolve();
        await Promise.resolve();
        const anotherReader = getSystemSettings();
        expect(fetch).toHaveBeenCalledTimes(2);
        pending[1]({ json: async () => ({ success: true, store_name: 'Current' }) });
        const results = await Promise.all([oldRead, currentRead, anotherReader, getSystemSettings()]);
        expect(results.every(result => result.store_name === 'Current')).toBe(true);
        expect((await getSystemSettings()).store_name).toBe('Current');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('does not cache failures and lets forced reads replace the prior cache', async () => {
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce({ json: async () => ({ success: false }) })
            .mockResolvedValueOnce({ json: async () => ({ success: true, store_name: 'Old' }) })
            .mockResolvedValueOnce({ json: async () => ({ success: true, store_name: 'Current' }) }));
        const { getSystemSettings } = await import('../systemSettings.js');
        expect((await getSystemSettings()).success).toBe(false);
        expect((await getSystemSettings()).store_name).toBe('Old');
        expect((await getSystemSettings({ force: true })).store_name).toBe('Current');
        expect((await getSystemSettings()).store_name).toBe('Current');
        expect(fetch).toHaveBeenCalledTimes(3);
    });
});
