import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_REALTIME_EVENT } from '../../realtime.js';
import { createPrintQueueRefreshController } from '../printQueueRefreshController.js';

function makeDocument() {
    const target = new EventTarget();
    target.visibilityState = 'visible';
    return target;
}

function realtime(target, type) {
    target.dispatchEvent(new CustomEvent(ADMIN_REALTIME_EVENT, { detail: { type, payload: {} } }));
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('print queue refresh controller', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    function setup(load = vi.fn().mockResolvedValue(undefined)) {
        const eventTarget = new EventTarget();
        const documentRef = makeDocument();
        const controller = createPrintQueueRefreshController({ load, eventTarget, documentRef });
        controller.start();
        return { controller, eventTarget, documentRef, load };
    }

    it('loads on tab entry and reconciles every 30 seconds while active', async () => {
        const { controller, load } = setup();
        await controller.setActive(true);
        expect(load).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(29999);
        expect(load).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(load).toHaveBeenCalledTimes(2);
        controller.stop();
    });

    it('does no fallback work while inactive or hidden', async () => {
        const { controller, documentRef, load } = setup();
        await vi.advanceTimersByTimeAsync(60000);
        expect(load).not.toHaveBeenCalled();
        await controller.setActive(true);
        documentRef.visibilityState = 'hidden';
        documentRef.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(60000);
        expect(load).toHaveBeenCalledTimes(1);
        controller.stop();
    });

    it('filters, coalesces, and recovers from aggregate signals', async () => {
        const { controller, eventTarget, documentRef, load } = setup();
        await controller.setActive(true);
        realtime(eventTarget, 'printer_status_changed');
        realtime(eventTarget, 'new_order');
        await vi.advanceTimersByTimeAsync(5000);
        expect(load).toHaveBeenCalledTimes(1);

        realtime(eventTarget, 'print_queue_updated');
        realtime(eventTarget, 'stale_print_stations');
        await vi.advanceTimersByTimeAsync(5000);
        expect(load).toHaveBeenCalledTimes(2);
        realtime(eventTarget, 'socket_reconnected');
        await vi.advanceTimersByTimeAsync(5000);
        expect(load).toHaveBeenCalledTimes(3);

        documentRef.visibilityState = 'hidden';
        documentRef.dispatchEvent(new Event('visibilitychange'));
        documentRef.visibilityState = 'visible';
        documentRef.dispatchEvent(new Event('visibilitychange'));
        eventTarget.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(5000);
        expect(load).toHaveBeenCalledTimes(4);
        controller.stop();
    });

    it('runs one trailing load for a signal received during an unresolved load', async () => {
        const pending = deferred();
        const load = vi.fn()
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValue(undefined);
        const { controller, eventTarget } = setup(load);
        const activation = controller.setActive(true);
        await Promise.resolve();
        realtime(eventTarget, 'print_queue_updated');
        realtime(eventTarget, 'print_queue_updated');
        pending.resolve();
        await activation;
        await vi.advanceTimersByTimeAsync(5000);
        expect(load).toHaveBeenCalledTimes(2);
        controller.stop();
    });

    it('replaces the old fallback deadline with one signaled read', async () => {
        const { controller, eventTarget, load } = setup();
        await controller.setActive(true);
        await vi.advanceTimersByTimeAsync(29900);
        realtime(eventTarget, 'print_queue_updated');
        await vi.advanceTimersByTimeAsync(250);
        expect(load).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(100);
        expect(load).toHaveBeenCalledTimes(2);
        controller.stop();
    });

    it('forces a fresh serialized read while inactive and spans the new request', async () => {
        const first = deferred();
        const second = deferred();
        const load = vi.fn()
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);
        const { controller } = setup(load);
        const oldRead = controller.refreshNow({ force: true });
        await Promise.resolve();
        const forced = controller.refreshNow({ force: true });
        let forcedSettled = false;
        void forced.then(() => { forcedSettled = true; });
        first.resolve();
        await oldRead;
        await Promise.resolve();
        expect(load).toHaveBeenCalledTimes(2);
        expect(forcedSettled).toBe(false);
        second.resolve();
        await forced;
        expect(forcedSettled).toBe(true);
        await vi.advanceTimersByTimeAsync(60000);
        expect(load).toHaveBeenCalledTimes(2);
        controller.stop();
    });

    it('uses one bootstrap read for initial activation but reconciles later activation', async () => {
        const first = deferred();
        const load = vi.fn()
            .mockReturnValueOnce(first.promise)
            .mockResolvedValue(undefined);
        const { controller, eventTarget } = setup(load);
        const bootstrap = controller.refreshNow({ force: true });
        void controller.setActive(true, { reconcile: false });
        realtime(eventTarget, 'print_queue_updated');
        first.resolve();
        await bootstrap;
        await vi.advanceTimersByTimeAsync(5000);
        expect(load).toHaveBeenCalledTimes(2);

        await controller.setActive(false);
        const older = controller.refreshNow({ force: true });
        await Promise.resolve();
        void controller.setActive(true);
        await older;
        await vi.advanceTimersByTimeAsync(5000);
        expect(load.mock.calls.length).toBeGreaterThanOrEqual(4);
        controller.stop();
    });

    it('absorbs failures and rearms the active fallback', async () => {
        const load = vi.fn()
            .mockRejectedValueOnce(new Error('reset'))
            .mockResolvedValue(undefined);
        const { controller } = setup(load);
        await expect(controller.setActive(true)).resolves.toBe(false);
        await vi.advanceTimersByTimeAsync(30000);
        expect(load).toHaveBeenCalledTimes(2);
        controller.stop();
    });

    it('stops listeners and prevents unresolved work from rescheduling', async () => {
        const pending = deferred();
        const load = vi.fn(() => pending.promise);
        const { controller, eventTarget, documentRef } = setup(load);
        void controller.setActive(true);
        await Promise.resolve();
        controller.stop();
        realtime(eventTarget, 'print_queue_updated');
        eventTarget.dispatchEvent(new Event('focus'));
        documentRef.dispatchEvent(new Event('visibilitychange'));
        pending.resolve();
        await vi.advanceTimersByTimeAsync(60000);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('caps a 500ms settlement storm at one automatic read per five seconds', async () => {
        const { controller, eventTarget, load } = setup();
        await controller.setActive(true);
        for (let tick = 0; tick < 120; tick += 1) {
            realtime(eventTarget, 'print_queue_updated');
            await vi.advanceTimersByTimeAsync(500);
        }
        expect(load.mock.calls.length - 1).toBeLessThanOrEqual(12);
        controller.stop();
    });
});
