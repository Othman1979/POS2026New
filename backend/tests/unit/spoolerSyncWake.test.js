const { createSpoolerSyncWakeHub } = require('../../services/spoolerSyncWake');

function fakeClock() {
    let nextId = 1;
    const timers = new Map();
    return {
        timers,
        setTimeoutFn(callback) {
            const id = nextId++;
            timers.set(id, callback);
            return id;
        },
        clearTimeoutFn(id) {
            timers.delete(id);
        },
        fire(id) {
            const callback = timers.get(id);
            timers.delete(id);
            callback?.();
        }
    };
}

describe('spooler sync wake hub', () => {
    it('publishes a generation and releases all current waiters', async () => {
        const clock = fakeClock();
        const hub = createSpoolerSyncWakeHub(clock);
        const since = hub.generation();
        const first = hub.waitForChange('agent-a', since, { timeoutMs: 100 });
        const second = hub.waitForChange('agent-b', since, { timeoutMs: 100 });

        expect(hub.snapshot()).toEqual({ generation: 0, waiters: 2, closed: false });
        expect(hub.publish()).toBe(1);
        await expect(first).resolves.toBe('changed');
        await expect(second).resolves.toBe('changed');
        expect(hub.snapshot()).toEqual({ generation: 1, waiters: 0, closed: false });
        expect(clock.timers.size).toBe(0);
    });

    it('detects a publish that happened before waiter registration', async () => {
        const hub = createSpoolerSyncWakeHub(fakeClock());
        const since = hub.generation();
        hub.publish();
        await expect(hub.waitForChange('agent-a', since, { timeoutMs: 100 })).resolves.toBe('changed');
        expect(hub.snapshot().waiters).toBe(0);
    });

    it('supersedes only the older waiter for the same agent', async () => {
        const hub = createSpoolerSyncWakeHub(fakeClock());
        const since = hub.generation();
        const older = hub.waitForChange('agent-a', since, { timeoutMs: 100 });
        const newer = hub.waitForChange('agent-a', since, { timeoutMs: 100 });

        await expect(older).resolves.toBe('superseded');
        expect(hub.snapshot().waiters).toBe(1);
        hub.publish();
        await expect(newer).resolves.toBe('changed');
        expect(hub.snapshot().waiters).toBe(0);
    });

    it('times out and removes the waiter', async () => {
        const clock = fakeClock();
        const hub = createSpoolerSyncWakeHub(clock);
        const waiting = hub.waitForChange('agent-a', hub.generation(), { timeoutMs: 100 });
        clock.fire([...clock.timers.keys()][0]);
        await expect(waiting).resolves.toBe('timeout');
        expect(hub.snapshot().waiters).toBe(0);
    });

    it('aborts and removes the waiter listener', async () => {
        const hub = createSpoolerSyncWakeHub(fakeClock());
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const waiting = hub.waitForChange('agent-a', hub.generation(), {
            timeoutMs: 100,
            signal: controller.signal
        });

        controller.abort();
        await expect(waiting).resolves.toBe('aborted');
        expect(remove).toHaveBeenCalled();
        expect(hub.snapshot().waiters).toBe(0);
    });

    it('closes idempotently and refuses new waiters', async () => {
        const hub = createSpoolerSyncWakeHub(fakeClock());
        const waiting = hub.waitForChange('agent-a', hub.generation(), { timeoutMs: 100 });
        hub.close();
        hub.close();
        await expect(waiting).resolves.toBe('closed');
        await expect(hub.waitForChange('agent-b', hub.generation(), { timeoutMs: 100 })).resolves.toBe('closed');
        expect(hub.snapshot()).toEqual({ generation: 0, waiters: 0, closed: true });
    });

    it('does not let old cleanup remove a replacement waiter', async () => {
        const hub = createSpoolerSyncWakeHub(fakeClock());
        const controller = new AbortController();
        const since = hub.generation();
        const older = hub.waitForChange('agent-a', since, { timeoutMs: 100, signal: controller.signal });
        const newer = hub.waitForChange('agent-a', since, { timeoutMs: 100 });
        controller.abort();

        await expect(older).resolves.toBe('superseded');
        expect(hub.snapshot().waiters).toBe(1);
        hub.publish();
        await expect(newer).resolves.toBe('changed');
    });

    it('notifies subscribers after advancing the generation without changing waiter behavior', async () => {
        const errors = [];
        const hub = createSpoolerSyncWakeHub({
            ...fakeClock(),
            onSubscriberError: error => errors.push(error)
        });
        const listener = vi.fn();
        const unsubscribe = hub.subscribe(listener);
        const waiting = hub.waitForChange('agent-a', hub.generation(), { timeoutMs: 100 });

        expect(hub.publish()).toBe(1);
        await expect(waiting).resolves.toBe('changed');
        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith(1);
        expect(errors).toEqual([]);

        unsubscribe();
        unsubscribe();
        hub.publish();
        expect(listener).toHaveBeenCalledOnce();
    });

    it('isolates subscriber and subscriber-error-handler failures from waiters', async () => {
        const hub = createSpoolerSyncWakeHub({
            ...fakeClock(),
            onSubscriberError() { throw new Error('logger failed'); }
        });
        const healthy = vi.fn();
        hub.subscribe(() => { throw new Error('observer failed'); });
        hub.subscribe(healthy);
        const waiting = hub.waitForChange('agent-a', hub.generation(), { timeoutMs: 100 });

        expect(() => hub.publish()).not.toThrow();
        await expect(waiting).resolves.toBe('changed');
        expect(healthy).toHaveBeenCalledOnce();
    });

    it('clears subscribers on close and refuses later subscriptions', () => {
        const hub = createSpoolerSyncWakeHub(fakeClock());
        const listener = vi.fn();
        hub.subscribe(listener);
        hub.close();
        const unsubscribe = hub.subscribe(listener);
        hub.publish();
        unsubscribe();
        expect(listener).not.toHaveBeenCalled();
    });
});
