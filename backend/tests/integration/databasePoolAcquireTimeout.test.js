const mysql = require('mysql2');
const { buildDatabasePoolOptions } = require('../../config/databasePoolOptions');
const { attachDatabasePoolAcquireTimeout } = require('../../services/databasePoolAcquireTimeout');

describe('database pool acquire timeout integration', () => {
    it('bounds queued acquisition, releases late delivery, and leaves running SQL alone', async () => {
        const corePool = mysql.createPool({
            ...buildDatabasePoolOptions(process.env),
            connectionLimit: 1,
            maxIdle: 1,
            queueLimit: 2
        });
        attachDatabasePoolAcquireTimeout(corePool, {
            timeoutMs: 40,
            logger: { warn: vi.fn() }
        });
        const testPool = corePool.promise();
        let held;

        try {
            const [slowRows] = await testPool.query('SELECT SLEEP(0.08) AS slept');
            expect(Number(slowRows[0].slept)).toBe(0);

            held = await testPool.getConnection();
            await expect(testPool.execute('SELECT 1'))
                .rejects.toMatchObject({ code: 'DB_POOL_ACQUIRE_TIMEOUT' });

            held.release();
            held = null;
            const [nextRows] = await testPool.query('SELECT 7 AS ok');
            expect(Number(nextRows[0].ok)).toBe(7);
        } finally {
            held?.release();
            await testPool.end();
        }
    });
});
