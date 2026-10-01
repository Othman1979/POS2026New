import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDashboardDataController, useDashboardData } from '../useDashboardData.ts';

function makeDocument() {
    const target = new EventTarget();
    target.visibilityState = 'visible';
    return target;
}

function success(marker) {
    return { ok: true, json: async () => ({ success: true, marker }) };
}

function realtime(target, type, payload = {}) {
    target.dispatchEvent(new CustomEvent('admin:realtime', { detail: { type, payload } }));
}

function deferred() {
    let resolve;
    const promise = new Promise(res => { resolve = res; });
    return { promise, resolve };
}

describe('dashboard data controller', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('retains last good payload when silent refresh fails', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ success: true, headline: { sales_today: 10 } }),
            })
            .mockResolvedValueOnce({
                ok: false,
                json: async () => ({ message: 'offline' }),
            });
        const controller = createDashboardDataController({
            fetchImpl,
            eventTarget: new EventTarget(),
            documentRef: makeDocument(),
        });

        await controller.load();
        await controller.load({ silent: true });

        expect(controller.data.value.headline.sales_today).toBe(10);
        expect(controller.staleError.value).toBe('offline');
    });

    it('reconciles every five minutes only while active and visible', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true }),
        });
        const documentRef = makeDocument();
        const controller = createDashboardDataController({
            fetchImpl,
            eventTarget: new EventTarget(),
            documentRef,
        });

        controller.activate();
        await vi.advanceTimersByTimeAsync(299999);
        expect(fetchImpl).toHaveBeenCalledTimes(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        documentRef.visibilityState = 'hidden';
        documentRef.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(600000);
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        controller.deactivate();
        await vi.advanceTimersByTimeAsync(120000);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('debounces realtime events and removes listener on deactivation', async () => {
        const target = new EventTarget();
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true }),
        });
        const controller = createDashboardDataController({
            fetchImpl,
            eventTarget: target,
            documentRef: makeDocument(),
        });

        controller.activate();
        const event = new CustomEvent('admin:realtime', { detail: { type: 'table_update' } });
        target.dispatchEvent(event);
        target.dispatchEvent(event);
        await vi.advanceTimersByTimeAsync(400);
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        controller.deactivate();
        target.dispatchEvent(event);
        await vi.advanceTimersByTimeAsync(400);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('prevents older responses from overwriting newer data', async () => {
        let resolveFirst;
        const first = new Promise(resolve => {
            resolveFirst = resolve;
        });
        const fetchImpl = vi.fn()
            .mockReturnValueOnce(first)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ success: true, marker: 2 }),
            });
        const controller = createDashboardDataController({
            fetchImpl,
            eventTarget: new EventTarget(),
            documentRef: makeDocument(),
        });

        const oldLoad = controller.load();
        await controller.load();
        resolveFirst({ ok: true, json: async () => ({ success: true, marker: 1 }) });
        await oldLoad;

        expect(controller.data.value.marker).toBe(2);
    });

    it('filters settings, reconnect, expenses, focus, and visibility signals', async () => {
        const target = new EventTarget();
        const documentRef = makeDocument();
        const fetchImpl = vi.fn().mockResolvedValue(success(1));
        const controller = createDashboardDataController({ fetchImpl, eventTarget: target, documentRef });
        controller.activate();

        realtime(target, 'settings_changed', { keys: ['admin_language'] });
        realtime(target, 'printer_status_changed');
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchImpl).not.toHaveBeenCalled();

        for (const payload of [
            {}, { keys: [] }, { keys: [null] }, { keys: [{}] },
            { keys: ['tables_enabled'] }, { keys: ['stock_enabled'] },
            { keys: ['low_stock_threshold'] }
        ]) {
            realtime(target, 'settings_changed', payload);
            await vi.advanceTimersByTimeAsync(60000);
        }
        realtime(target, 'expenses_changed');
        await vi.advanceTimersByTimeAsync(60000);
        realtime(target, 'socket_reconnected');
        await vi.advanceTimersByTimeAsync(60000);
        expect(fetchImpl).toHaveBeenCalledTimes(9);

        documentRef.visibilityState = 'hidden';
        documentRef.dispatchEvent(new Event('visibilitychange'));
        target.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(600000);
        expect(fetchImpl).toHaveBeenCalledTimes(9);

        documentRef.visibilityState = 'visible';
        documentRef.dispatchEvent(new Event('visibilitychange'));
        target.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(60000);
        expect(fetchImpl).toHaveBeenCalledTimes(10);
        controller.deactivate();
    });

    it('coalesces storms and runs one trailing refresh after an in-flight read', async () => {
        const target = new EventTarget();
        const documentRef = makeDocument();
        const pending = deferred();
        const fetchImpl = vi.fn()
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValue(success(2));
        const controller = createDashboardDataController({ fetchImpl, eventTarget: target, documentRef });
        controller.activate();
        const current = controller.load();
        realtime(target, 'new_order');
        realtime(target, 'inventory_changed');
        realtime(target, 'table_update');
        pending.resolve(success(1));
        await current;
        await vi.advanceTimersByTimeAsync(60000);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        controller.deactivate();
    });

    it('keeps one trailing reconciliation when a signal lands during fallback', async () => {
        const target = new EventTarget();
        const pending = deferred();
        const fetchImpl = vi.fn()
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValue(success(2));
        const controller = createDashboardDataController({
            fetchImpl,
            eventTarget: target,
            documentRef: makeDocument(),
        });
        controller.activate();
        await vi.advanceTimersByTimeAsync(300000);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        realtime(target, 'new_order');
        pending.resolve(success(1));
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(60000);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        controller.deactivate();
    });

    it('resets the old fallback when a signal arrives at 299.9 seconds', async () => {
        const target = new EventTarget();
        const fetchImpl = vi.fn().mockResolvedValue(success(1));
        const controller = createDashboardDataController({
            fetchImpl,
            eventTarget: target,
            documentRef: makeDocument(),
        });
        controller.activate();
        await vi.advanceTimersByTimeAsync(299900);
        realtime(target, 'new_order');
        await vi.advanceTimersByTimeAsync(400);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(100);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        controller.deactivate();
    });

    it('bounds sustained signals to one automatic start per minute', async () => {
        const target = new EventTarget();
        const fetchImpl = vi.fn().mockResolvedValue(success(1));
        const controller = createDashboardDataController({ fetchImpl, eventTarget: target, documentRef: makeDocument() });
        controller.activate();
        await controller.load();
        for (let second = 0; second < 600; second += 1) {
            realtime(target, 'new_order');
            await vi.advanceTimersByTimeAsync(1000);
        }
        expect(fetchImpl.mock.calls.length - 1).toBeLessThanOrEqual(10);
        controller.deactivate();
    });

    it('retries failures after one minute then returns to five-minute fallback', async () => {
        const fetchImpl = vi.fn()
            .mockRejectedValueOnce(new Error('reset'))
            .mockRejectedValueOnce(new Error('reset again'))
            .mockResolvedValue(success(3));
        const controller = createDashboardDataController({
            fetchImpl,
            eventTarget: new EventTarget(),
            documentRef: makeDocument(),
        });
        controller.activate();
        await controller.load();
        await vi.advanceTimersByTimeAsync(60000);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(60000);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(299999);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        controller.deactivate();
    });

    it('reconciles after KeepAlive reactivation and removes all listeners on deactivation', async () => {
        const target = new EventTarget();
        const documentRef = makeDocument();
        const fetchImpl = vi.fn().mockResolvedValue(success(1));
        const controller = createDashboardDataController({ fetchImpl, eventTarget: target, documentRef });
        controller.activate();
        controller.deactivate();
        controller.activate({ reconcile: true });
        await vi.advanceTimersByTimeAsync(400);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        controller.deactivate();
        realtime(target, 'new_order');
        target.dispatchEvent(new Event('focus'));
        documentRef.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(600000);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('activates listeners before the composable starts its initial load', async () => {
        const hooks = { mounted: [], activated: [], deactivated: [], unmounted: [] };
        const actualVue = await vi.importActual('vue');
        vi.resetModules();
        vi.doMock('vue', () => ({
            ...actualVue,
            onMounted: callback => hooks.mounted.push(callback),
            onActivated: callback => hooks.activated.push(callback),
            onDeactivated: callback => hooks.deactivated.push(callback),
            onUnmounted: callback => hooks.unmounted.push(callback),
        }));
        const browser = new EventTarget();
        browser.fetch = vi.fn().mockResolvedValue(success(1));
        const addListener = vi.spyOn(browser, 'addEventListener');
        const documentRef = makeDocument();
        vi.stubGlobal('window', browser);
        vi.stubGlobal('document', documentRef);

        try {
            const module = await import('../useDashboardData.ts');
            module.useDashboardData();
            expect(hooks.mounted).toHaveLength(1);
            expect(hooks.activated).toHaveLength(1);

            hooks.activated[0]();
            hooks.mounted[0]();
            await Promise.resolve();

            expect(browser.fetch).toHaveBeenCalledTimes(1);
            expect(addListener.mock.invocationCallOrder[0])
                .toBeLessThan(browser.fetch.mock.invocationCallOrder[0]);
        } finally {
            vi.unstubAllGlobals();
            vi.doUnmock('vue');
            vi.resetModules();
        }
    });
});
