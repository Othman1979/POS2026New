import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_HEARTBEAT_EVENT, ADMIN_REALTIME_EVENT } from '../../realtime.js';
import { createStockAlertsController } from '../useStockAlerts.js';

function makeDocument() {
    const target = new EventTarget();
    target.visibilityState = 'visible';
    return target;
}

function realtime(target, type, payload = {}) {
    target.dispatchEvent(new CustomEvent(ADMIN_REALTIME_EVENT, {
        detail: { type, payload }
    }));
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('stock alert reconciliation', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    function setup(fetchAlerts = vi.fn().mockResolvedValue({ success: true, lowStockItems: [] })) {
        const eventTarget = new EventTarget();
        const documentRef = makeDocument();
        const controller = createStockAlertsController({ fetchAlerts, eventTarget, documentRef });
        return { controller, eventTarget, documentRef, fetchAlerts };
    }

    it('loads once and sends nothing more while nothing changes', async () => {
        const { controller, fetchAlerts } = setup();
        await controller.start();
        expect(fetchAlerts).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(fetchAlerts).toHaveBeenCalledTimes(1);
        controller.stop();
    });

    it('refreshes on ingredient changes, which never send inventory_changed', async () => {
        const { controller, eventTarget, fetchAlerts } = setup();
        await controller.start();
        realtime(eventTarget, 'ingredients_changed', { ingredientIds: [4] });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetchAlerts).toHaveBeenCalledTimes(2);
        controller.stop();
    });

    it('filters and coalesces realtime settings and inventory signals', async () => {
        const { controller, eventTarget, fetchAlerts } = setup();
        await controller.start();

        realtime(eventTarget, 'new_order');
        realtime(eventTarget, 'settings_changed', { keys: ['admin_language'] });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetchAlerts).toHaveBeenCalledTimes(1);

        realtime(eventTarget, 'inventory_changed');
        realtime(eventTarget, 'inventory_changed');
        await vi.advanceTimersByTimeAsync(249);
        expect(fetchAlerts).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchAlerts).toHaveBeenCalledTimes(2);

        for (const keys of [undefined, [], [null], [{}], ['stock_enabled'], ['low_stock_threshold']]) {
            realtime(eventTarget, 'settings_changed', keys === undefined ? {} : { keys });
            await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(fetchAlerts).toHaveBeenCalledTimes(8);
        controller.stop();
    });

    it('reconciles reconnect, focus, and visible return without hidden reads', async () => {
        const { controller, eventTarget, documentRef, fetchAlerts } = setup();
        await controller.start();
        documentRef.visibilityState = 'hidden';
        documentRef.dispatchEvent(new Event('visibilitychange'));
        realtime(eventTarget, 'socket_reconnected');
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(fetchAlerts).toHaveBeenCalledTimes(1);

        documentRef.visibilityState = 'visible';
        documentRef.dispatchEvent(new Event('visibilitychange'));
        eventTarget.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(250);
        expect(fetchAlerts).toHaveBeenCalledTimes(2);
        controller.stop();
    });

    it('runs exactly one follow-up for a signal received in flight', async () => {
        const first = deferred();
        const fetchAlerts = vi.fn()
            .mockReturnValueOnce(first.promise)
            .mockResolvedValue({ success: true, lowStockItems: [] });
        const { controller, eventTarget } = setup(fetchAlerts);
        const start = controller.start();
        await flush();
        realtime(eventTarget, 'inventory_changed');
        realtime(eventTarget, 'inventory_changed');
        first.resolve({ success: true, lowStockItems: [] });
        await start;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetchAlerts).toHaveBeenCalledTimes(2);
        controller.stop();
    });

    it('ignores an unresolved result after stop', async () => {
        const pending = deferred();
        const fetchAlerts = vi.fn(() => pending.promise);
        const { controller } = setup(fetchAlerts);
        const start = controller.start();
        await flush();
        controller.stop();
        pending.resolve({ success: true, lowStockItems: [{ id: 7 }] });
        await start;
        expect(controller.lowStockItems.value).toEqual([]);
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(fetchAlerts).toHaveBeenCalledTimes(1);
    });

    it('bounds sustained signals to the old 30-second cadence', async () => {
        const { controller, eventTarget, fetchAlerts } = setup();
        await controller.start();
        for (let second = 0; second < 120; second += 1) {
            realtime(eventTarget, 'inventory_changed');
            await vi.advanceTimersByTimeAsync(1_000);
        }
        expect(fetchAlerts.mock.calls.length - 1).toBeLessThanOrEqual(4);
        controller.stop();
    });

    it('keeps the last good list on a failed read and recovers on the next event', async () => {
        const fetchAlerts = vi.fn()
            .mockResolvedValueOnce({ success: true, lowStockItems: [{ id: 1 }] })
            .mockRejectedValueOnce(new Error('reset'))
            .mockResolvedValue({ success: true, lowStockItems: [{ id: 2 }] });
        const { controller, eventTarget } = setup(fetchAlerts);
        await controller.start();
        realtime(eventTarget, 'inventory_changed');
        await vi.advanceTimersByTimeAsync(30_000);
        expect(controller.lowStockItems.value).toEqual([{ id: 1 }]);
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(fetchAlerts).toHaveBeenCalledTimes(2);
        realtime(eventTarget, 'inventory_changed');
        await vi.advanceTimersByTimeAsync(30_000);
        expect(controller.lowStockItems.value).toEqual([{ id: 2 }]);
        controller.stop();
    });

    it('retries a failed boot read on the next socket heartbeat, and ignores heartbeats when healthy', async () => {
        const fetchAlerts = vi.fn()
            .mockRejectedValueOnce(new Error('slow link'))
            .mockResolvedValue({ success: true, lowStockItems: [{ id: 1 }] });
        const { controller, eventTarget } = setup(fetchAlerts);
        await controller.start();
        expect(controller.lowStockItems.value).toEqual([]);

        eventTarget.dispatchEvent(new Event(ADMIN_HEARTBEAT_EVENT));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetchAlerts).toHaveBeenCalledTimes(2);
        expect(controller.lowStockItems.value).toEqual([{ id: 1 }]);

        eventTarget.dispatchEvent(new Event(ADMIN_HEARTBEAT_EVENT));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchAlerts).toHaveBeenCalledTimes(2);
        controller.stop();
    });

    it('re-reads once on the first socket connect, closing the boot gap, and not on later connects', async () => {
        const { controller, eventTarget, fetchAlerts } = setup();
        await controller.start();
        expect(fetchAlerts).toHaveBeenCalledTimes(1);

        eventTarget.dispatchEvent(new Event('socket_connect'));
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchAlerts).toHaveBeenCalledTimes(2);

        eventTarget.dispatchEvent(new Event('socket_connect'));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchAlerts).toHaveBeenCalledTimes(2);
        controller.stop();
    });
});
