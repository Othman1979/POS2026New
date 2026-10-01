const { EventEmitter } = require('node:events');
const diagnosticsChannel = require('node:diagnostics_channel');
const { createDatabaseRuntime } = require('../../services/databaseRuntime');

function harness() {
    const corePool = new EventEmitter();
    const promisePool = {
        query: vi.fn(), execute: vi.fn(), getConnection: vi.fn(), end: vi.fn()
    };
    corePool.getConnection = vi.fn();
    corePool.promise = vi.fn(() => promisePool);
    const mysql = { createPool: vi.fn(() => corePool) };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { corePool, promisePool, mysql, logger };
}

function poolConnection() {
    const connection = new EventEmitter();
    connection.query = vi.fn();
    return connection;
}

function promiseConnection(ping = vi.fn().mockResolvedValue(undefined)) {
    return {
        connection: poolConnection(),
        ping,
        release: vi.fn(),
        destroy: vi.fn()
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('database runtime', () => {
    it('creates one pool and preserves the promise-pool interface', () => {
        const h = harness();
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn()
        });

        expect(h.mysql.createPool).toHaveBeenCalledOnce();
        expect(runtime.pool).toBe(h.promisePool);
        expect(runtime.snapshot()).toMatchObject({
            created: 0, acquired: 0, released: 0, enqueued: 0,
            connectionErrors: 0, idleDisconnects: 0,
            activeDisconnects: 0, probeDisconnects: 0,
            commandDisconnects: 0,
            inUse: 0, peakInUse: 0, state: 'stopped'
        });
    });

    it('records each command disconnect once without retaining diagnostic SQL or values', async () => {
        const h = harness();
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn()
        });
        const queryErrorChannel = diagnosticsChannel.channel('tracing:mysql2:query:error');
        const executeErrorChannel = diagnosticsChannel.channel('tracing:mysql2:execute:error');
        const fatalContext = {
            query: 'SELECT secret_column FROM secret_table WHERE pin = ?',
            values: ['secret-pin'],
            database: 'secret-database',
            error: Object.assign(new Error('secret-host secret-password'), {
                code: 'PROTOCOL_CONNECTION_LOST', fatal: true
            })
        };

        runtime.start();
        queryErrorChannel.publish(fatalContext);
        queryErrorChannel.publish(fatalContext);
        executeErrorChannel.publish({
            query: 'INSERT INTO secret_table VALUES (?)',
            values: ['secret-value'],
            database: 'secret-database',
            error: Object.assign(new Error('duplicate'), {
                code: 'ER_DUP_ENTRY', fatal: false
            })
        });
        executeErrorChannel.publish({
            query: 'COMMIT',
            values: [],
            database: 'secret-database',
            error: Object.assign(new Error('connection is closed'), { fatal: true })
        });

        expect(runtime.snapshot().commandDisconnects).toBe(2);
        expect(h.logger.error).toHaveBeenCalledTimes(2);
        expect(h.logger.error).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                event: 'database_command_connection_error',
                operation: 'query',
                code: 'PROTOCOL_CONNECTION_LOST',
                fatal: true
            }),
            'Database command failed because its connection was lost.'
        );
        expect(h.logger.error).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                event: 'database_command_connection_error',
                operation: 'execute',
                code: 'UNKNOWN',
                fatal: true
            }),
            'Database command failed because its connection was lost.'
        );
        const serializedLogs = JSON.stringify(h.logger.error.mock.calls);
        expect(serializedLogs).not.toContain('secret_column');
        expect(serializedLogs).not.toContain('secret-pin');
        expect(serializedLogs).not.toContain('secret-database');
        expect(serializedLogs).not.toContain('secret-host');
        expect(serializedLogs).not.toContain('secret-password');

        await runtime.stop();
        queryErrorChannel.publish({
            error: Object.assign(new Error('late reset'), { code: 'ECONNRESET', fatal: true })
        });
        expect(runtime.snapshot().commandDisconnects).toBe(2);
    });

    it('keeps command tracing active after maintenance stops until the runtime fully stops', async () => {
        const h = harness();
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn()
        });
        const queryErrorChannel = diagnosticsChannel.channel('tracing:mysql2:query:error');

        runtime.start();
        await runtime.stopMaintenance();
        queryErrorChannel.publish({
            error: Object.assign(new Error('drain reset'), {
                code: 'ECONNRESET', fatal: true
            })
        });

        expect(runtime.snapshot().commandDisconnects).toBe(1);
        expect(h.logger.error).toHaveBeenCalledOnce();

        await runtime.stop();
        queryErrorChannel.publish({
            error: Object.assign(new Error('late reset'), {
                code: 'ECONNRESET', fatal: true
            })
        });
        expect(runtime.snapshot().commandDisconnects).toBe(1);
    });

    it('contains a diagnostic logger failure instead of breaking command delivery', async () => {
        const h = harness();
        h.logger.error.mockImplementation(() => {
            throw new Error('logger unavailable');
        });
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn()
        });
        const queryErrorChannel = diagnosticsChannel.channel('tracing:mysql2:query:error');

        runtime.start();
        expect(() => queryErrorChannel.publish({
            error: Object.assign(new Error('connection closed'), { fatal: true })
        })).not.toThrow();
        expect(runtime.snapshot().commandDisconnects).toBe(1);
        await runtime.stop();
    });

    it('classifies idle and active connection errors without logging secrets', () => {
        const h = harness();
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn()
        });
        const idle = poolConnection();
        const secondIdle = poolConnection();
        const active = poolConnection();

        h.corePool.emit('connection', idle);
        h.corePool.emit('connection', secondIdle);
        h.corePool.emit('connection', active);
        h.corePool.emit('acquire', active);
        idle.emit('error', Object.assign(new Error('secret-host secret-password'), {
            code: 'ECONNRESET', fatal: true
        }));
        secondIdle.emit('error', Object.assign(new Error('secret-host secret-password'), {
            code: 'ECONNRESET', fatal: true
        }));
        active.emit('error', Object.assign(new Error('secret-host secret-password'), {
            code: 'ECONNRESET', fatal: true
        }));

        expect(runtime.snapshot()).toMatchObject({
            created: 3, connectionErrors: 3,
            idleDisconnects: 2, activeDisconnects: 1,
            inUse: 0, peakInUse: 1
        });
        expect(h.logger.warn).toHaveBeenCalledTimes(1);
        expect(h.logger.debug).toHaveBeenCalledTimes(2);
        const serializedLogs = JSON.stringify([
            ...h.logger.debug.mock.calls,
            ...h.logger.info.mock.calls,
            ...h.logger.warn.mock.calls,
            ...h.logger.error.mock.calls
        ]);
        expect(serializedLogs).not.toContain('secret-host');
        expect(serializedLogs).not.toContain('secret-password');
    });

    it('tracks balanced leases and exposes idempotent lifecycle methods', async () => {
        const h = harness();
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn()
        });
        const connection = poolConnection();

        h.corePool.emit('connection', connection);
        h.corePool.emit('acquire', connection);
        h.corePool.emit('release', connection);

        expect(runtime.start()).toBe(true);
        expect(runtime.start()).toBe(false);
        await runtime.stop();
        await runtime.stop();
        expect(runtime.snapshot()).toMatchObject({
            acquired: 1, released: 1, inUse: 0, peakInUse: 1, state: 'stopped'
        });
        expect(connection.query).toHaveBeenCalledWith("SET time_zone = '+00:00'");
    });

    it('pings one released connection only after the pool stays quiet', async () => {
        vi.useFakeTimers();
        const h = harness();
        const connection = promiseConnection();
        h.promisePool.getConnection.mockResolvedValue(connection);
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn(),
            maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 1 }
        });

        await vi.advanceTimersByTimeAsync(100);
        expect(h.promisePool.getConnection).not.toHaveBeenCalled();
        expect(runtime.start()).toBe(true);
        expect(runtime.start()).toBe(false);
        await vi.advanceTimersByTimeAsync(29);
        expect(connection.ping).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(connection.ping).toHaveBeenCalledOnce();
        expect(connection.release).toHaveBeenCalledOnce();
        expect(connection.destroy).not.toHaveBeenCalled();
        expect(h.promisePool.query).not.toHaveBeenCalled();
        expect(h.promisePool.execute).not.toHaveBeenCalled();
        expect(runtime.snapshot()).toMatchObject({
            probeAttempts: 1, probeSuccesses: 1, state: 'healthy'
        });
        await runtime.stop();
    });

    it('skips probing while business work owns a connection', async () => {
        vi.useFakeTimers();
        const h = harness();
        const businessConnection = new EventEmitter();
        const probe = promiseConnection();
        h.promisePool.getConnection.mockResolvedValue(probe);
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn(),
            maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 1 }
        });

        runtime.start();
        h.corePool.emit('acquire', businessConnection);
        await vi.advanceTimersByTimeAsync(30);
        expect(h.promisePool.getConnection).not.toHaveBeenCalled();
        h.corePool.emit('release', businessConnection);
        await vi.advanceTimersByTimeAsync(29);
        expect(h.promisePool.getConnection).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
        expect(probe.release).toHaveBeenCalledOnce();
        await runtime.stop();
    });

    it('destroys a failed probe and succeeds through one replacement probe', async () => {
        vi.useFakeTimers();
        const h = harness();
        const first = promiseConnection(vi.fn().mockRejectedValue(
            Object.assign(new Error('reset'), { code: 'ECONNRESET', fatal: true })
        ));
        const second = promiseConnection();
        h.promisePool.getConnection
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(second);
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn(),
            maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 1 }
        });

        runtime.start();
        await vi.advanceTimersByTimeAsync(31);
        expect(first.destroy).toHaveBeenCalledOnce();
        expect(first.release).not.toHaveBeenCalled();
        expect(second.release).toHaveBeenCalledOnce();
        expect(runtime.snapshot()).toMatchObject({
            probeAttempts: 2, probeFailures: 1, probeSuccesses: 1, state: 'healthy'
        });
        expect(h.logger.warn).not.toHaveBeenCalled();
        await runtime.stop();
    });

    it('logs one degraded transition after both bounded attempts fail and recovers once', async () => {
        vi.useFakeTimers();
        const h = harness();
        const failures = Array.from({ length: 4 }, () => promiseConnection(
            vi.fn().mockRejectedValue(Object.assign(new Error('reset'), {
                code: 'ECONNRESET', fatal: true
            }))
        ));
        const recovered = promiseConnection();
        for (const connection of [...failures, recovered]) {
            h.promisePool.getConnection.mockResolvedValueOnce(connection);
        }
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn(),
            maintenance: {
                quietIntervalMs: 30, pingTimeoutMs: 10,
                retryDelayMs: 1, degradedIntervalMs: 5
            }
        });

        runtime.start();
        await vi.advanceTimersByTimeAsync(31);
        expect(runtime.snapshot().state).toBe('degraded');
        expect(h.logger.warn).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(6);
        expect(runtime.snapshot().state).toBe('degraded');
        expect(h.logger.warn).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(5);
        expect(runtime.snapshot().state).toBe('healthy');
        expect(h.logger.info).toHaveBeenCalledOnce();
        expect(recovered.release).toHaveBeenCalledOnce();
        for (const failed of failures) expect(failed.destroy).toHaveBeenCalledOnce();
        await runtime.stop();
    });

    it('stop cancels future maintenance and waits for the current probe', async () => {
        vi.useFakeTimers();
        const h = harness();
        let resolvePing;
        const probe = promiseConnection(vi.fn(() => new Promise((resolve) => {
            resolvePing = resolve;
        })));
        h.promisePool.getConnection.mockResolvedValue(probe);
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn(),
            maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 1 }
        });

        runtime.start();
        await vi.advanceTimersByTimeAsync(30);
        expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
        const stopping = runtime.stop();
        resolvePing();
        await stopping;
        await vi.advanceTimersByTimeAsync(100);
        expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
        expect(runtime.snapshot().state).toBe('stopped');
    });

    it('stop during retry delay prevents a replacement acquisition', async () => {
        vi.useFakeTimers();
        const h = harness();
        const failed = promiseConnection(vi.fn().mockRejectedValue(
            Object.assign(new Error('reset'), { code: 'ECONNRESET', fatal: true })
        ));
        h.promisePool.getConnection.mockResolvedValueOnce(failed);
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn(),
            maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 20 }
        });

        runtime.start();
        await vi.advanceTimersByTimeAsync(30);
        expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
        await runtime.stop();
        await vi.advanceTimersByTimeAsync(100);
        expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
        expect(runtime.snapshot().state).toBe('stopped');
    });

    it('delays the probe by only the quiet time remaining after recent activity', async () => {
        vi.useFakeTimers();
        const h = harness();
        const businessConnection = new EventEmitter();
        const probe = promiseConnection();
        h.promisePool.getConnection.mockResolvedValue(probe);
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn(),
            maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 1 }
        });

        runtime.start();
        await vi.advanceTimersByTimeAsync(20);
        h.corePool.emit('acquire', businessConnection);
        h.corePool.emit('release', businessConnection);
        await vi.advanceTimersByTimeAsync(29);
        expect(h.promisePool.getConnection).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
        await runtime.stop();
    });

    it('destroys a timed-out probe instead of returning it to the pool', async () => {
        vi.useFakeTimers();
        const h = harness();
        const hanging = promiseConnection(vi.fn(() => new Promise(() => {})));
        h.promisePool.getConnection.mockResolvedValue(hanging);
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn(),
            maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 20 }
        });

        runtime.start();
        await vi.advanceTimersByTimeAsync(40);
        expect(hanging.destroy).toHaveBeenCalledOnce();
        expect(hanging.release).not.toHaveBeenCalled();
        expect(runtime.snapshot()).toMatchObject({ probeAttempts: 1, probeFailures: 1 });
        await runtime.stop();
    });

    it('classifies a probe socket error separately from active business work', async () => {
        vi.useFakeTimers();
        const h = harness();
        const reset = Object.assign(new Error('reset'), { code: 'ECONNRESET', fatal: true });
        const probe = promiseConnection();
        probe.ping.mockImplementation(() => {
            probe.connection.emit('error', reset);
            return Promise.reject(reset);
        });
        h.promisePool.getConnection.mockResolvedValueOnce(probe);
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn(),
            maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 20 }
        });
        h.corePool.emit('connection', probe.connection);

        runtime.start();
        await vi.advanceTimersByTimeAsync(30);
        expect(runtime.snapshot()).toMatchObject({
            probeDisconnects: 1, activeDisconnects: 0, idleDisconnects: 0
        });
        expect(h.logger.warn).not.toHaveBeenCalled();
        await runtime.stop();
    });

    it('contains an unexpected scheduler failure and recovers on the next probe', async () => {
        vi.useFakeTimers();
        const h = harness();
        const failed = [
            promiseConnection(vi.fn().mockRejectedValue(
                Object.assign(new Error('reset'), { code: 'ECONNRESET', fatal: true })
            )),
            promiseConnection(vi.fn().mockRejectedValue(
                Object.assign(new Error('reset'), { code: 'ECONNRESET', fatal: true })
            ))
        ];
        const recovered = promiseConnection();
        h.promisePool.getConnection
            .mockResolvedValueOnce(failed[0])
            .mockResolvedValueOnce(failed[1])
            .mockResolvedValueOnce(recovered);
        h.logger.warn.mockImplementationOnce(() => {
            throw Object.assign(new Error('logger failed'), { code: 'LOGGER_FAILED' });
        });
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn(),
            maintenance: {
                quietIntervalMs: 30, pingTimeoutMs: 10,
                retryDelayMs: 1, degradedIntervalMs: 5
            }
        });

        runtime.start();
        await vi.advanceTimersByTimeAsync(31);
        expect(runtime.snapshot().state).toBe('degraded');
        expect(h.logger.error).toHaveBeenCalledOnce();
        expect(h.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'database_runtime_probe_failed', code: 'LOGGER_FAILED'
            }),
            'Database connection maintenance failed unexpectedly.'
        );
        await vi.advanceTimersByTimeAsync(5);
        expect(runtime.snapshot().state).toBe('healthy');
        expect(recovered.release).toHaveBeenCalledOnce();
        await runtime.stop();
    });

    it('waits for a pending acquisition to settle without starting a shutdown retry', async () => {
        vi.useFakeTimers();
        const h = harness();
        let rejectAcquire;
        h.promisePool.getConnection.mockImplementation(() => new Promise((_, reject) => {
            rejectAcquire = reject;
        }));
        const runtime = createDatabaseRuntime({
            mysql: h.mysql, poolOptions: { connectionLimit: 10 }, logger: h.logger,
            attachAcquireTimeout: vi.fn(),
            maintenance: { quietIntervalMs: 30, pingTimeoutMs: 10, retryDelayMs: 1 }
        });

        runtime.start();
        await vi.advanceTimersByTimeAsync(30);
        const stopping = runtime.stop();
        let stopped = false;
        stopping.then(() => { stopped = true; });
        await Promise.resolve();
        expect(stopped).toBe(false);

        rejectAcquire(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }));
        await stopping;
        await vi.advanceTimersByTimeAsync(100);
        expect(h.promisePool.getConnection).toHaveBeenCalledOnce();
        expect(runtime.snapshot().state).toBe('stopped');
    });
});
