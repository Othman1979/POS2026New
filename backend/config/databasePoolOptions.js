function requiredInteger(name, raw, fallback, { min = 1, max = 100000 } = {}) {
    const value = raw === undefined || raw === null || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`Invalid database configuration: ${name} must be an integer from ${min} to ${max}.`);
    }
    return value;
}

function buildDatabasePoolOptions(env = process.env) {
    const connectionLimit = requiredInteger(
        'DB_CONNECTION_LIMIT',
        env.DB_CONNECTION_LIMIT || env.DB_POOL_MAX,
        10,
        { max: 100 }
    );
    const configuredQueue = requiredInteger(
        'DB_QUEUE_LIMIT',
        env.DB_QUEUE_LIMIT,
        50,
        { min: 0, max: 10000 }
    );
    const maxIdle = connectionLimit === 1 ? 1 : Math.min(2, connectionLimit - 1);

    return {
        host: env.DB_HOST || '127.0.0.1',
        user: env.DB_USER || 'root',
        password: env.DB_PASSWORD || '',
        database: env.DB_NAME || 'posapp',
        port: requiredInteger('DB_PORT', env.DB_PORT, 3306, { max: 65535 }),
        timezone: 'Z',
        // Consumers parse stored JSON explicitly; keep that contract when mysql2
        // recognizes MariaDB JSON through extended column metadata.
        jsonStrings: true,
        // Appointments are venue wall-clock values, not UTC event timestamps.
        // Leave created_at and other event fields on mysql2's normal UTC path.
        typeCast(field, next) {
            if (field.name === 'delivery_date' && field.type === 'DATETIME') return field.string();
            return next();
        },
        waitForConnections: true,
        connectionLimit,
        maxIdle,
        idleTimeout: 45_000,
        gracefulEnd: true,
        queueLimit: configuredQueue === 0 ? 50 : configuredQueue,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        connectTimeout: 10000
    };
}

module.exports = { buildDatabasePoolOptions, requiredInteger };
