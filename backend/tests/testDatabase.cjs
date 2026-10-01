const { requiredInteger } = require('../config/databasePoolOptions');

// The fixture recreates tables. Validate its destination before opening a connection.
function getTestDatabaseOptions(env = process.env) {
    const database = env.DB_NAME || 'posapp_test';
    const host = env.DB_HOST || '127.0.0.1';
    if (database !== 'posapp_test' && !/^posapp_review_recipe_p1_[a-f0-9]{12}$/.test(database)) {
        throw new Error('Refusing test database: use posapp_test or a generated isolated review database.');
    }
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
        throw new Error('Refusing test database: DB_HOST must be loopback.');
    }
    return {
        host,
        port: requiredInteger('DB_PORT', env.DB_PORT, 3306, { max: 65535 }),
        user: env.DB_USER || 'root',
        password: env.DB_PASSWORD || '',
        database,
    };
}

module.exports = { getTestDatabaseOptions };
