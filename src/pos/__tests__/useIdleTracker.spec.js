import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../posSessionStorage.js', () => ({ clearPosOrderSessionStorage: vi.fn() }));

function fakeDocument() {
    const body = { children: [], appendChild(el) { this.children.push(el); }, removeChild(el) { this.children = this.children.filter(c => c !== el); } };
    return {
        body,
        createElement: () => ({ id: '', innerHTML: '' }),
        getElementById: () => null,
    };
}

describe('idle tracker', () => {
    let tracker;
    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { href: '/' } }));
        vi.stubGlobal('document', fakeDocument());
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        vi.stubGlobal('localStorage', { removeItem() {} });
        vi.stubGlobal('sessionStorage', { removeItem() {} });
        tracker = await import('../useIdleTracker.js');
        tracker.startIdleTracker({ id: 1 });
    });
    afterEach(() => {
        tracker.stopIdleTracker();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    const move = () => window.dispatchEvent(new Event('mousemove'));

    it('does not re-arm timers on each activity event', () => {
        const set = vi.spyOn(globalThis, 'setTimeout');
        const clear = vi.spyOn(globalThis, 'clearTimeout');
        for (let i = 0; i < 1000; i += 1) move();
        expect(set).not.toHaveBeenCalled();
        expect(clear).not.toHaveBeenCalled();
    });

    it('keeps an active user signed in and warns only after real idleness', async () => {
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
        move();
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
        expect(document.body.children).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
        expect(document.body.children).toHaveLength(1);
        expect(window.location.href).toBe('/');
    });

    it('dismisses the warning on activity and does not log out', async () => {
        await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
        expect(document.body.children).toHaveLength(1);
        move();
        expect(document.body.children).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(window.location.href).toBe('/');
    });

    it('logs out after the full idle window', async () => {
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 10);
        expect(window.location.href).toBe('/login?reason=expired');
    });
});
