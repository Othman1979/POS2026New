const { createPrintQueueWatchdogRunner } = require('../../services/printQueueWatchdogRunner');
const { resetLatestFailedPrintJobsCount } = require('../../services/printQueueWatchdog');

beforeEach(() => resetLatestFailedPrintJobsCount());

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
        now: () => nowMs,
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
        }
    };
}

function makeSubject({ firstHealth = null, firstStale = null, onFailedCount } = {}) {
    const clock = fakeClock();
    const logger = { warn: vi.fn(), error: vi.fn() };
    const emitted = [];
    const inspectStarts = [];
    let healthCalls = 0;
    let staleCalls = 0;
    let listener = null;
    const agents = { rows: [] };
    const liveness = vi.fn();
    const unsubscribe = vi.fn(() => { listener = null; });
    const db = {
        query: vi.fn(async (sql) => {
            if (String(sql).includes('GROUP BY status')) {
                inspectStarts.push(clock.now());
                healthCalls += 1;
                if (healthCalls === 1 && firstHealth) return firstHealth;
                return [[]];
            }
            if (String(sql).includes('FROM spooler_agents')) return [agents.rows];
            if (String(sql).includes('FROM print_queue') && String(sql).includes('COUNT(*)') && !String(sql).includes('GROUP BY')) return [[{ count: 4 }]];
            if (String(sql).includes('GROUP BY p.spooler_id')) {
                staleCalls += 1;
                if (staleCalls === 1 && firstStale) return firstStale;
            }
            return [[]];
        })
    };
    const runner = createPrintQueueWatchdogRunner({
        db,
        logger,
        emitStale: payload => emitted.push(payload),
        emitLiveness: liveness,
        onFailedCount,
        wakeHub: {
            subscribe(callback) {
                listener = callback;
                return unsubscribe;
            }
        },
        now: clock.now,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn
    });
    return {
        agents,
        liveness,
        clock,
        db,
        emitted,
        inspectStarts,
        logger,
        publish: () => listener?.(),
        runner,
        unsubscribe
    };
}

describe('print queue watchdog runner', () => {
    it('runs immediately and then uses the five-minute quiet recovery sweep', async () => {
        const subject = makeSubject();
        await subject.runner.start();
        expect(subject.inspectStarts).toEqual([0]);
        expect(subject.db.query).toHaveBeenCalledTimes(3);
        expect(subject.clock.nextDelay()).toBe(300_000);

        await subject.clock.advance(300_000);
        expect(subject.inspectStarts).toEqual([0, 300_000]);
        expect(subject.db.query).toHaveBeenCalledTimes(6);
    });

    it('keeps a quiet twenty-four hours observable with about ninety percent fewer reads', async () => {
        const subject = makeSubject();
        await subject.runner.start();
        await subject.clock.advance(24 * 60 * 60 * 1000);

        expect(subject.inspectStarts).toHaveLength(289);
        expect(subject.db.query).toHaveBeenCalledTimes(867);
    });

    it('inspects promptly when durable work arrives after a quiet period', async () => {
        const subject = makeSubject();
        await subject.runner.start();
        await subject.clock.advance(120_000);

        subject.publish();
        expect(subject.clock.nextDelay()).toBe(25);
        await subject.clock.advance(25);
        expect(subject.inspectStarts).toEqual([0, 120_025]);
    });

    it('announces an idle station crossing offline on the recovery sweep, and coming back on wake', async () => {
        const subject = makeSubject();
        subject.agents.rows = [{ spooler_id: 'bar', age_seconds: 10 }];
        await subject.runner.start();
        expect(subject.liveness).not.toHaveBeenCalled(); // the first pass is only the baseline
        // Healthy stations never pull the full inspection forward: the next pass is the five-minute sweep.
        expect(subject.clock.nextDelay()).toBe(300_000);

        subject.agents.rows = [{ spooler_id: 'bar', age_seconds: 31 }];
        await subject.clock.advance(300_000);
        expect(subject.liveness).toHaveBeenCalledTimes(1);

        await subject.clock.advance(300_000);
        expect(subject.liveness).toHaveBeenCalledTimes(1); // still offline: no repeat

        subject.agents.rows = [{ spooler_id: 'bar', age_seconds: 2 }];
        subject.publish(); // the station's first sync back wakes the watchdog
        await subject.clock.advance(30_000);
        expect(subject.liveness).toHaveBeenCalledTimes(2);
    });

    it('hands the failed count to onFailedCount when it changes', async () => {
        const onFailedCount = vi.fn();
        const subject = makeSubject({ onFailedCount });
        await subject.runner.start();
        expect(onFailedCount).toHaveBeenCalledWith(4);
        await subject.clock.advance(300_000);
        expect(onFailedCount).toHaveBeenCalledTimes(1);
    });

    it('preserves the existing normalized health and stale-station values', async () => {
        const loggerRows = [{ status: 'failed', count: '2', oldest_created_at: '2026-08-30 10:00:00' }];
        const staleRows = [{ spooler_id: 'kitchen-a', last_sync_at: null, queued: '3' }];
        const subject = makeSubject({ firstHealth: [loggerRows], firstStale: [staleRows] });

        await subject.runner.start();

        expect(subject.logger.warn).toHaveBeenCalledWith({
            print_queue: [{ status: 'failed', count: 2, oldest_created_at: '2026-08-30 10:00:00' }]
        }, 'Print queue health changed.');
        expect(subject.emitted).toEqual([{
            stations: [{ spooler_id: 'kitchen-a', last_sync_at: null, queued: 3 }]
        }]);
    });

    it('coalesces a burst and never starts more often than every thirty seconds', async () => {
        const subject = makeSubject();
        await subject.runner.start();
        for (let index = 0; index < 100; index += 1) subject.publish();
        expect(subject.clock.nextDelay()).toBe(30_000);
        await subject.clock.advance(29_999);
        expect(subject.inspectStarts).toEqual([0]);
        await subject.clock.advance(1);
        expect(subject.inspectStarts).toEqual([0, 30_000]);
    });

    it('runs one bounded trailing inspection after a signal during inspection', async () => {
        const pending = deferred();
        const subject = makeSubject({ firstHealth: pending.promise });
        const starting = subject.runner.start();
        subject.publish();
        subject.publish();
        pending.resolve([[]]);
        await starting;
        expect(subject.clock.nextDelay()).toBe(30_000);
        await subject.clock.advance(30_000);
        expect(subject.inspectStarts).toEqual([0, 30_000]);
    });

    it('retries a failed inspection after thirty seconds', async () => {
        const subject = makeSubject({ firstHealth: Promise.reject(new Error('database unavailable')) });
        await subject.runner.start();
        expect(subject.logger.error).toHaveBeenCalledOnce();
        expect(subject.clock.nextDelay()).toBe(30_000);
    });

    it('unsubscribes, clears timers, and waits for an inspection already in flight', async () => {
        const pending = deferred();
        const subject = makeSubject({ firstHealth: pending.promise });
        const starting = subject.runner.start();
        let stopSettled = false;
        const stopping = subject.runner.stop();
        void stopping.then(() => { stopSettled = true; });

        expect(subject.unsubscribe).toHaveBeenCalledOnce();
        expect(subject.clock.timerCount()).toBe(0);
        await Promise.resolve();
        expect(stopSettled).toBe(false);
        pending.resolve([[]]);
        await starting;
        await stopping;
        expect(stopSettled).toBe(true);
        expect(subject.clock.timerCount()).toBe(0);
    });

    it('contains an in-flight database failure while stopping', async () => {
        const pending = deferred();
        const subject = makeSubject({ firstHealth: pending.promise });
        const starting = subject.runner.start();
        const stopping = subject.runner.stop();
        pending.reject(new Error('database unavailable'));

        await expect(starting).resolves.toBe(false);
        await expect(stopping).resolves.toBeUndefined();
        expect(subject.logger.error).toHaveBeenCalledOnce();
        expect(subject.clock.timerCount()).toBe(0);
    });
});

describe('refreshStale', () => {
    it('recomputes and broadcasts the stale stations now without waiting for a wake or start', async () => {
        const rows = [{ spooler_id: 'kitchen', last_sync_at: null, queued: 2 }];
        const db = { query: vi.fn(async sql => [/spooler_agents/.test(String(sql)) ? rows : []]) };
        const emitStale = vi.fn();
        const runner = createPrintQueueWatchdogRunner({ db, logger: { warn() {}, error() {} }, emitStale });
        await runner.refreshStale();
        expect(emitStale).toHaveBeenCalledTimes(1);
        expect(emitStale.mock.calls[0][0].stations.map(s => s.spooler_id)).toEqual(['kitchen']);
        rows.length = 0; // the reset emptied the queue
        await runner.refreshStale();
        expect(emitStale.mock.calls[1][0]).toEqual({ stations: [] });
    });

    it('drops a stale read that started before the reset refresh and lands after it', async () => {
        const rows = [{ spooler_id: 'kitchen', last_sync_at: null, queued: 2 }];
        const releases = [];
        const db = { query: vi.fn(sql => {
            if (!/spooler_agents/.test(String(sql))) return Promise.resolve([[]]);
            const snapshot = rows.map(r => ({ ...r }));
            return new Promise(resolve => releases.push(() => resolve([snapshot])));
        }) };
        const emitStale = vi.fn();
        const runner = createPrintQueueWatchdogRunner({ db, logger: { warn() {}, error() {} }, emitStale });
        const oldRead = runner.refreshStale(); // started before the reset
        await new Promise(resolve => setImmediate(resolve));
        rows.length = 0;
        const freshRead = runner.refreshStale();
        await new Promise(resolve => setImmediate(resolve));
        releases[1](); await freshRead;
        releases[0](); await oldRead;
        expect(emitStale).toHaveBeenCalledTimes(1);
        expect(emitStale.mock.calls[0][0]).toEqual({ stations: [] });
    });
});
