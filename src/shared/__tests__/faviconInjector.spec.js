import { afterEach, describe, it, expect, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('store favicon', () => {
    it('shares one preferences read and keeps a stable icon URL the browser can revalidate', async () => {
        vi.resetModules();
        const link = { href: '' };
        vi.stubGlobal('document', { querySelector: () => link, head: { appendChild() {} } });
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, store_icon: '/uploads/store_icon.png' }) }));
        vi.stubGlobal('fetch', fetchMock);
        const { injectStoreFavicon, getPublicPreferences } = await import('../faviconInjector.js');
        await Promise.all([getPublicPreferences(), injectStoreFavicon()]);
        const first = link.href;
        await injectStoreFavicon();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(first).toBe('/uploads/store_icon.png');
        expect(link.href).toBe(first);
    });
});
