const { getBusinessDate, getBusinessDayRange, addBusinessDays } = require('../../utils/businessDate');
const { createPrintQueuePurge } = require('../../services/printQueuePurge');

function fakeClock() {
    let nextId = 1;
    const timers = new Map();
    return {
        timers,
        setTimeoutFn(callback, delay) {
            const timer = { id: nextId++, callback, delay, unref: vi.fn() };
            timers.set(timer.id, timer);
            return timer;
        },
        clearTimeoutFn(timer) {
            timers.delete(timer.id);
        },
        async fire(timer = [...timers.values()][0]) {
            timers.delete(timer.id);
            await timer.callback();
        }
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function makeSubject({ affectedRows = 0, query, now = new Date('2026-08-30T10:00:00.000Z') } = {}) {
    const clock = fakeClock();
    const db = { query: query || vi.fn(async sql => (
        sql.includes('SELECT parent.id') ? [[]] : [{ affectedRows }]
    )) };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const purge = createPrintQueuePurge({
        db,
        logger,
        now: () => now,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn
    });
    return { purge, db, logger, clock, now };
}

describe('print queue purge', () => {
    it('deletes only acknowledged rows settled before the current business day in bounded batches', async () => {
        const { purge, db, now } = makeSubject({ affectedRows: 12 });
        await expect(purge.runBatch()).resolves.toBe(12);

        const cutoff = getBusinessDayRange(getBusinessDate(now)).start;
        expect(db.query).toHaveBeenCalledWith(
            expect.stringMatching(
                /DELETE FROM print_queue\s+WHERE status='acknowledged'\s+AND created_at < \?\s+AND acknowledged_at IS NOT NULL\s+AND acknowledged_at < \?\s+ORDER BY created_at,id\s+LIMIT 500/
            ),
            [cutoff, cutoff]
        );
    });

    it('keeps rows inside the checkout-print grace just after the business-day cutoff', async () => {
        const dayStart = getBusinessDayRange(getBusinessDate(new Date('2026-08-30T10:00:00.000Z'))).start;
        const now = new Date(new Date(`${dayStart.replace(' ', 'T')}Z`).getTime() + 2 * 60 * 1000);
        const { purge, db } = makeSubject({ now });
        await purge.runBatch();

        // A receipt acknowledged a minute before the cutoff still dedups a replay of its checkout id.
        const graceEdge = new Date(now.getTime() - 15 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        expect(db.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM print_queue'), [graceEdge, graceEdge]);
    });

    it('starts asynchronously and drains full batches before scheduling the next business boundary', async () => {
        const deletions = [500, 25];
        const query = vi.fn(async sql => (
            sql.includes('SELECT parent.id')
                ? [[]]
                : [{ affectedRows: deletions.shift() }]
        ));
        const { purge, logger, clock, now } = makeSubject({ query });

        purge.start();
        purge.start();
        expect(query).not.toHaveBeenCalled();
        expect([...clock.timers.values()]).toHaveLength(1);
        expect([...clock.timers.values()][0]).toMatchObject({ delay: 60_000 });
        expect([...clock.timers.values()][0].unref).toHaveBeenCalledOnce();

        await clock.fire();
        expect([...clock.timers.values()][0]).toMatchObject({ delay: 2_000 });
        await clock.fire();

        const nextDate = addBusinessDays(getBusinessDate(now), 1);
        const nextStart = getBusinessDayRange(nextDate).start;
        const expectedDelay = Math.max(1000, Date.parse(`${nextStart.replace(' ', 'T')}Z`) - now.getTime() + 60_000);
        expect([...clock.timers.values()][0]).toMatchObject({ delay: expectedDelay });
        expect(logger.info).toHaveBeenCalledOnce();
        expect(logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ deleted: 525 }),
            'Acknowledged print queue purge completed.'
        );
        await purge.stop();
    });

    it('warns once and retries five minutes after a failed batch', async () => {
        const error = new Error('database unavailable');
        const { purge, logger, clock } = makeSubject({ query: vi.fn().mockRejectedValue(error) });
        purge.start();

        await clock.fire();

        expect(logger.warn).toHaveBeenCalledOnce();
        expect(logger.warn).toHaveBeenCalledWith({ err: error }, 'Acknowledged print queue purge failed.');
        expect([...clock.timers.values()][0]).toMatchObject({ delay: 300_000 });
        await purge.stop();
    });

    it('stop clears the timer and awaits work already in flight without rescheduling', async () => {
        const pending = deferred();
        const query = vi.fn()
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValueOnce([{ affectedRows: 1 }]);
        const { purge, clock } = makeSubject({ query });
        purge.start();
        const running = clock.fire();
        const stopping = purge.stop();
        let stopped = false;
        stopping.then(() => { stopped = true; });
        await Promise.resolve();
        expect(stopped).toBe(false);

        pending.resolve([[]]);
        await running;
        await stopping;
        expect(clock.timers.size).toBe(0);
    });

    it('reconciles a bounded parent set without deleting reprint links in the same batch', async () => {
        const query = vi.fn()
            .mockResolvedValueOnce([[{ id: 7 }, { id: 7 }, { id: 8 }]])
            .mockResolvedValueOnce([{ affectedRows: 2 }]);
        const { purge } = makeSubject({ query });

        await expect(purge.runBatch()).resolves.toBe(0);
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls[0][0]).toMatch(/child\.reprint_of_queue_id = parent\.id[\s\S]+parent\.status = 'dead_letter'[\s\S]+child\.status = 'acknowledged'[\s\S]+LIMIT 500/);
        expect(query.mock.calls[1]).toEqual([
            expect.stringMatching(/UPDATE print_queue[\s\S]+WHERE id IN \(\?\) AND status = 'dead_letter'/),
            [[7, 8]]
        ]);
        expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM print_queue'))).toBe(false);
    });

    it('defers deletion when another process wins the same parent reconciliation', async () => {
        const query = vi.fn()
            .mockResolvedValueOnce([[{ id: 7 }]])
            .mockResolvedValueOnce([{ affectedRows: 0 }]);
        const { purge } = makeSubject({ query });

        await expect(purge.runBatch()).resolves.toBe(0);
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM print_queue'))).toBe(false);
    });

    it('continues promptly after reconciliation before returning to the business-day boundary', async () => {
        const query = vi.fn()
            .mockResolvedValueOnce([[{ id: 7 }]])
            .mockResolvedValueOnce([{ affectedRows: 1 }])
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([{ affectedRows: 0 }]);
        const { purge, clock } = makeSubject({ query });

        purge.start();
        await clock.fire();
        expect([...clock.timers.values()][0]).toMatchObject({ delay: 2_000 });

        await clock.fire();
        expect([...clock.timers.values()][0].delay).toBeGreaterThan(2_000);
        await purge.stop();
    });

    it('stop clears a pending startup timer', async () => {
        const { purge, db, clock } = makeSubject();
        purge.start();
        await purge.stop();
        expect(clock.timers.size).toBe(0);
        expect(db.query).not.toHaveBeenCalled();
    });
});
