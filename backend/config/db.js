const mysql = require('mysql2');
const logger = require('./logger');
const { buildDatabasePoolOptions } = require('./databasePoolOptions');
const { createDatabaseRuntime } = require('../services/databaseRuntime');

if (process.env.NODE_ENV === 'test') {
    require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.test'), override: true });
} else {
    require('dotenv').config();
}

if (process.env.NODE_ENV === 'production') {
    const missing = ['DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter((key) => !String(process.env[key] || '').trim());
    if (missing.length) throw new Error(`Missing production database configuration: ${missing.join(', ')}`);
}

const databaseRuntime = createDatabaseRuntime({
    mysql,
    poolOptions: buildDatabasePoolOptions(process.env),
    logger
});
const pool = databaseRuntime.pool;

Object.defineProperties(pool, {
    databaseRuntime: { enumerable: false, value: databaseRuntime },
    connectionTelemetrySnapshot: { enumerable: false, value: databaseRuntime.snapshot }
});

module.exports = pool;
