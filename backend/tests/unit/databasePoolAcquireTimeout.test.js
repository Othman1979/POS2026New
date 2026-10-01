const { EventEmitter } = require('node:events');
const { attachDatabasePoolAcquireTimeout } = require('../../services/databasePoolAcquireTimeout');

describe('database pool acquire timeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const harness = () => {
        let pending;
        let enqueueNext = false;
        const corePool = new EventEmitter();
        const rawGetConnection = vi.fn(callback => {
            pending = callback;
            if (enqueueNext) {
                enqueueNext = false;
                corePool.emit('enqueue');
            }
        });
        corePool.getConnection = rawGetConnection;
        const logger = { warn: vi.fn() };
        return {
            corePool,
            logger,
            rawGetConnection,
            queueNext: () => { enqueueNext = true; },
            deliver: (...args) => pending(...args)
        };
    };

    it('passes through an acquisition completed before the deadline', () => {
        const h = harness();
        const callback = vi.fn();
        const connection = { release: vi.fn() };
        attachDatabasePoolAcquireTimeout(h.corePool, { timeoutMs: 50, logger: h.logger });

        h.corePool.getConnection(callback);
        h.deliver(null, connection);
        vi.advanceTimersByTime(100);

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith(null, connection);
        expect(connection.release).not.toHaveBeenCalled();
        expect(h.logger.warn).not.toHaveBeenCalled();
    });

    it('times out once and releases a connection delivered later', () => {
        const h = harness();
        const callback = vi.fn();
        const connection = { release: vi.fn() };
        attachDatabasePoolAcquireTimeout(h.corePool, { timeoutMs: 50, logger: h.logger });

        h.queueNext();
        h.corePool.getConnection(callback);
        vi.advanceTimersByTime(50);

        expect(callback).toHaveBeenCalledOnce();
        expect(callback.mock.calls[0][0]).toMatchObject({ code: 'DB_POOL_ACQUIRE_TIMEOUT' });
        expect(callback.mock.calls[0][1]).toBeUndefined();
        expect(h.logger.warn).toHaveBeenCalledWith(
            { code: 'DB_POOL_ACQUIRE_TIMEOUT', timeout_ms: 50 },
            'Database pool acquisition timed out.'
        );

        h.deliver(null, connection);
        expect(callback).toHaveBeenCalledOnce();
        expect(connection.release).toHaveBeenCalledOnce();
    });

    it('does not relabel a slow connection handshake and attaches only once', () => {
        const h = harness();
        const callback = vi.fn();
        const first = attachDatabasePoolAcquireTimeout(h.corePool, { timeoutMs: 50, logger: h.logger });
        const second = attachDatabasePoolAcquireTimeout(h.corePool, { timeoutMs: 50, logger: h.logger });
        const connectionError = Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });

        h.corePool.getConnection(callback);
        vi.advanceTimersByTime(100);

        expect(callback).not.toHaveBeenCalled();
        expect(h.logger.warn).not.toHaveBeenCalled();

        h.deliver(connectionError);

        expect(second).toBe(first);
        expect(h.rawGetConnection).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith(connectionError, undefined);
        expect(h.logger.warn).not.toHaveBeenCalled();
    });
});
