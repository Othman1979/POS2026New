const { createJofotaraOperationsRunner } = require('../../services/JofotaraOperationsRunner');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function fakeClock() {
    let nowMs = 0;
    let nextId = 1;
    const timers = new Map();
    return {
        setTimeoutFn(callback, delay) {
            const id = nextId++;
            timers.set(id, { callback, dueAt: nowMs + Math.max(0, Number(delay) || 0) });
            return id;
        },
        clearTimeoutFn(id) {
            timers.delete(id);
        },
        nextDelay() {
            if (timers.size === 0) return Infinity;
            return Math.min(...[...timers.values()].map(timer => timer.dueAt)) - nowMs;
        },
        timerCount: () => timers.size,
        async advance(ms) {
            const target = nowMs + ms;
            while (true) {
                const next = [...timers.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
                if (!next || next[1].dueAt > target) break;
                timers.delete(next[0]);
                nowMs = next[1].dueAt;
                await next[1].callback();
            }
            nowMs = target;
        },
        fireNext() {
            const next = [...timers.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
            if (!next) return Promise.resolve(undefined);
            timers.delete(next[0]);
            nowMs = next[1].dueAt;
            return next[1].callback();
        }
    };
}

function operationResult(automaticEnabled, changes = {}) {
    return {
        automatic_enabled: automaticEnabled,
        attempted: 0,
        accepted: 0,
        rejected: 0,
        unknown: 0,
        failed: 0,
        stale: 0,
        ...changes
    };
}

function makeSubject({ automaticEnabled = false, processResult = null, staleResult = null } = {}) {
    const clock = fakeClock();
    const logger = { warn: vi.fn() };
    const publish = vi.fn();
    let active = automaticEnabled;
    let nextProcessResult = processResult;
    let nextStaleResult = staleResult;
    const processOperations = vi.fn(async () => {
        if (nextProcessResult) {
            const result = nextProcessResult;
            nextProcessResult = null;
            return result;
        }
        return operationResult(active);
    });
    const recoverStale = vi.fn(async () => {
        if (nextStaleResult) {
            const result = nextStaleResult;
            nextStaleResult = null;
            return result;
        }
        return 0;
    });
    const runner = createJofotaraOperationsRunner({
        processOperations,
        recoverStale,
        publish,
        logger,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn
    });
    return {
        clock,
        logger,
        processOperations,
        publish,
        recoverStale,
        runner,
        setAutomaticEnabled(value) { active = value; },
        setNextResult(value) { nextProcessResult = Promise.resolve(value); },
        setNextStale(value) { nextStaleResult = Promise.resolve(value); }
    };
}

describe('JoFotara operations runner', () => {
    it('runs one full pass at startup and only stale recovery every five minutes while inactive', async () => {
        const subject = makeSubject();
        await subject.runner.start();
        expect(subject.processOperations).toHaveBeenCalledOnce();
        expect(subject.clock.nextDelay()).toBe(300_000);
        await subject.clock.advance(60_000);
        expect(subject.processOperations).toHaveBeenCalledOnce();
        await subject.clock.advance(240_000);
        expect(subject.recoverStale).toHaveBeenCalledOnce();
    });

    it('keeps inactive stale repair across a quiet twenty-four hours without full polling', async () => {
        const subject = makeSubject();
        await subject.runner.start();
        await subject.clock.advance(24 * 60 * 60 * 1000);

        expect(subject.processOperations).toHaveBeenCalledOnce();
        expect(subject.recoverStale).toHaveBeenCalledTimes(288);
    });

    it('keeps the existing sixty-second full cadence while active', async () => {
        const subject = makeSubject({ automaticEnabled: true });
        await subject.runner.start();
        expect(subject.clock.nextDelay()).toBe(60_000);
        await subject.clock.advance(60_000);
        expect(subject.processOperations).toHaveBeenCalledTimes(2);
    });

    it('enables immediately and disables without an extra full run', async () => {
        const subject = makeSubject();
        await subject.runner.start();
        subject.setAutomaticEnabled(true);
        await subject.runner.configure(true);
        expect(subject.processOperations).toHaveBeenCalledTimes(2);
        await subject.runner.configure(false);
        await subject.clock.advance(60_000);
        expect(subject.processOperations).toHaveBeenCalledTimes(2);
        expect(subject.clock.nextDelay()).toBe(240_000);
    });

    it('does not let an older active result override a committed disable', async () => {
        const pending = deferred();
        const subject = makeSubject({ processResult: pending.promise });
        const starting = subject.runner.start();
        const configured = subject.runner.configure(false);
        pending.resolve(operationResult(true));
        await Promise.all([starting, configured]);
        expect(subject.clock.nextDelay()).toBe(300_000);
    });

    it('does not expose a rejected in-flight pass through concurrent configuration', async () => {
        const pending = deferred();
        const subject = makeSubject({ processResult: pending.promise });
        const starting = subject.runner.start();
        const configured = subject.runner.configure(false);
        pending.reject(new Error('database unavailable'));
        await expect(starting).resolves.toBeUndefined();
        await expect(configured).resolves.toBeUndefined();
        expect(subject.logger.warn).toHaveBeenCalledOnce();
        expect(subject.clock.nextDelay()).toBe(300_000);
    });

    it('queues one full follow-up when enablement occurs during stale work', async () => {
        const pending = deferred();
        const subject = makeSubject({ staleResult: pending.promise });
        await subject.runner.start();
        const staleRun = subject.clock.fireNext();
        await Promise.resolve();
        subject.setAutomaticEnabled(true);
        const configured = subject.runner.configure(true);
        pending.resolve(0);
        await Promise.all([staleRun, configured]);
        for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
        expect(subject.processOperations).toHaveBeenCalledTimes(2);
        expect(subject.clock.nextDelay()).toBe(60_000);
    });

    it('publishes only when fiscal state changed', async () => {
        const subject = makeSubject({ automaticEnabled: true });
        await subject.runner.start();
        expect(subject.publish).not.toHaveBeenCalled();
        const changedResult = operationResult(true, {
            attempted: 5,
            accepted: 1,
            rejected: 1,
            unknown: 1,
            failed: 2,
            stale: 3
        });
        subject.setNextResult(changedResult);
        await subject.clock.advance(60_000);
        expect(subject.publish).toHaveBeenCalledOnce();
        expect(subject.publish).toHaveBeenNthCalledWith(1, changedResult);
        subject.setAutomaticEnabled(false);
        await subject.runner.configure(false);
        subject.setNextStale(2);
        await subject.clock.advance(300_000);
        expect(subject.publish).toHaveBeenCalledTimes(2);
        expect(subject.publish).toHaveBeenNthCalledWith(2, operationResult(false, { stale: 2 }));
    });

    it('retries a failed startup in one minute and stop drains without rescheduling', async () => {
        const pending = deferred();
        const subject = makeSubject({ processResult: pending.promise });
        const starting = subject.runner.start();
        const stopping = subject.runner.stop();
        pending.reject(new Error('database unavailable'));
        await expect(starting).resolves.toBeUndefined();
        await expect(stopping).resolves.toBeUndefined();
        expect(subject.clock.timerCount()).toBe(0);
        expect(subject.logger.warn).toHaveBeenCalledOnce();
    });
});
