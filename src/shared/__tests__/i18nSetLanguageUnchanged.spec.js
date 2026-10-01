import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A floor refresh or settings re-read re-applies the stored language; when it has
// not changed, the page must not be walked again or told the language changed.
describe('setLanguage with an unchanged language', () => {
    let store;
    let frames;
    beforeEach(() => {
        vi.resetModules();
        store = {};
        vi.stubGlobal('localStorage', { getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = value; } });
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ Hello: 'مرحبا' }) })));
        vi.stubGlobal('window', Object.assign(new EventTarget(), {}));
        vi.stubGlobal('document', {
            documentElement: { lang: '', dir: '' },
            body: null,
            createElement: () => ({ setAttribute() {} }),
            createTreeWalker: () => ({ nextNode: () => null }),
            querySelector: () => null,
        });
        vi.stubGlobal('Node', { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9 });
        frames = [];
        vi.stubGlobal('requestAnimationFrame', callback => frames.push(callback));
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('queues one root translation and one change event for two identical calls', async () => {
        const { setLanguage } = await import('../i18n/runtime.js');
        const changed = vi.fn();
        window.addEventListener('admin-language-changed', changed);
        expect(await setLanguage('ar', { persist: false })).toBe(true);
        expect(frames).toHaveLength(1);
        frames.splice(0).forEach(run => run());
        expect(await setLanguage('ar')).toBe(true);
        expect(frames).toHaveLength(0);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(store.pos_admin_language).toBe('ar');
    });
});
