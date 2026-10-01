const mysql = require('mysql2');
const { buildDatabasePoolOptions } = require('../../config/databasePoolOptions');
const { createDatabaseRuntime } = require('../../services/databaseRuntime');

async function waitUntil(predicate, timeoutMs = 1600) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Database runtime did not reach the expected quiet state.');
}

describe('database runtime integration', () => {
    it('retires burst connections, keeps one warm, and still serves SQL', async () => {
        const logger = {
            debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()
        };
        const runtime = createDatabaseRuntime({
            mysql,
            poolOptions: {
                ...buildDatabasePoolOptions(process.env),
                connectionLimit: 3,
                maxIdle: 2,
                idleTimeout: 700,
                gracefulEnd: true
            },
            logger,
            maintenance: {
                quietIntervalMs: 250,
                pingTimeoutMs: 100,
                retryDelayMs: 25,
                degradedIntervalMs: 100
            }
        });

        try {
            const burst = await Promise.all([
                runtime.pool.query('SELECT SLEEP(0.08) AS slept'),
                runtime.pool.query('SELECT SLEEP(0.08) AS slept'),
                runtime.pool.query('SELECT SLEEP(0.08) AS slept')
            ]);
            for (const [rows] of burst) {
                expect(Number(rows[0].slept)).toBe(0);
            }
            expect(runtime.snapshot().peakInUse).toBeGreaterThanOrEqual(2);

            runtime.start();
            await waitUntil(() => {
                const snapshot = runtime.snapshot();
                return snapshot.openConnections === 1 && snapshot.probeSuccesses >= 1;
            });

            expect(runtime.snapshot()).toMatchObject({
                inUse: 0,
                enqueued: 0,
                connectionErrors: 0,
                activeDisconnects: 0,
                state: 'healthy'
            });
            expect(runtime.snapshot().openConnections).toBe(1);
            expect(logger.warn).not.toHaveBeenCalled();
            expect(logger.error).not.toHaveBeenCalled();
            const [rows] = await runtime.pool.query('SELECT 7 AS ok');
            expect(Number(rows[0].ok)).toBe(7);
        } finally {
            await runtime.stop();
            await runtime.pool.end();
        }
    });

    it('observes a killed active command without retrying it and serves the next query', async () => {
        const logger = {
            debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()
        };
        const poolOptions = {
            ...buildDatabasePoolOptions(process.env),
            connectionLimit: 2,
            maxIdle: 1,
            idleTimeout: 700,
            gracefulEnd: true
        };
        const runtime = createDatabaseRuntime({
            mysql,
            poolOptions,
            logger,
            maintenance: {
                quietIntervalMs: 10_000,
                pingTimeoutMs: 100,
                retryDelayMs: 25,
                degradedIntervalMs: 100
            }
        });
        let victim;
        let killer;

        try {
            runtime.start();
            victim = await runtime.pool.getConnection();
            killer = mysql.createConnection(poolOptions).promise();
            const pending = victim.query('SELECT SLEEP(2) AS slept').then(
                () => ({ code: null, succeeded: true }),
                (error) => ({ code: error.code || null, succeeded: false })
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            await killer.query(`KILL CONNECTION ${Number(victim.threadId)}`);

            const failed = await pending;
            await waitUntil(() => runtime.snapshot().commandDisconnects === 1);
            expect(failed).toEqual({ code: 'PROTOCOL_CONNECTION_LOST', succeeded: false });
            expect(runtime.snapshot()).toMatchObject({
                commandDisconnects: 1,
                activeDisconnects: 0,
                probeAttempts: 0
            });
            expect(logger.error).toHaveBeenCalledOnce();
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    event: 'database_command_connection_error',
                    operation: 'query',
                    code: 'PROTOCOL_CONNECTION_LOST',
                    fatal: true
                }),
                'Database command failed because its connection was lost.'
            );
            const serializedLogs = JSON.stringify(logger.error.mock.calls);
            expect(serializedLogs).not.toContain('SLEEP');
            if (poolOptions.database) expect(serializedLogs).not.toContain(poolOptions.database);
            if (poolOptions.password) expect(serializedLogs).not.toContain(poolOptions.password);

            const [rows] = await runtime.pool.query('SELECT 17 AS ok');
            expect(Number(rows[0].ok)).toBe(17);
        } finally {
            victim?.destroy();
            try { await killer?.end(); } catch (_) {}
            await runtime.stop();
            await runtime.pool.end();
        }
    });
});
