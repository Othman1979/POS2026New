const ATTACHMENT = Symbol.for('posapp.databasePoolAcquireTimeout');
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;

function attachDatabasePoolAcquireTimeout(corePool, {
    timeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
    logger
} = {}) {
    if (
        !corePool
        || typeof corePool.getConnection !== 'function'
        || typeof corePool.once !== 'function'
        || typeof corePool.removeListener !== 'function'
    ) {
        throw new Error('A callback-based mysql2 pool is required.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error('Database pool acquisition timeout must be a positive integer.');
    }
    if (corePool[ATTACHMENT]) return corePool[ATTACHMENT];

    const rawGetConnection = corePool.getConnection.bind(corePool);
    corePool.getConnection = function getConnectionWithTimeout(callback) {
        let settled = false;
        let timer;
        const finish = (error, connection) => {
            if (settled) {
                connection?.release();
                return;
            }
            settled = true;
            clearTimeout(timer);
            callback(error, connection);
        };

        const startQueueTimer = () => {
            timer = setTimeout(() => {
                if (settled) return;
                const error = new Error('Database is busy. Try again shortly.');
                error.code = 'DB_POOL_ACQUIRE_TIMEOUT';
                logger?.warn(
                    { code: error.code, timeout_ms: timeoutMs },
                    'Database pool acquisition timed out.'
                );
                finish(error);
            }, timeoutMs);
            timer.unref?.();
        };

        corePool.once('enqueue', startQueueTimer);
        try {
            rawGetConnection(finish);
        } catch (error) {
            finish(error);
        } finally {
            corePool.removeListener('enqueue', startQueueTimer);
        }
    };

    const attachment = Object.freeze({ timeoutMs });
    Object.defineProperty(corePool, ATTACHMENT, { value: attachment });
    return attachment;
}

module.exports = { attachDatabasePoolAcquireTimeout, DEFAULT_ACQUIRE_TIMEOUT_MS };
