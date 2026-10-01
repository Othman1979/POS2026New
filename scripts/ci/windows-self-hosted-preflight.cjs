const os = require('node:os');
const mysql = require('mysql2/promise');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ALLOWED_DATABASES = new Set(['posapp_test']);

async function verifyWindowsSelfHostedRunner(env = process.env, dependencies = {}) {
    const platform = dependencies.platform || process.platform;
    if (platform !== 'win32') throw new Error(`Windows self-hosted runner required; received ${platform}.`);
    const host = String(env.DB_HOST || '127.0.0.1');
    const database = String(env.DB_NAME || '');
    const port = Number(env.DB_PORT || 3306);
    if (!LOOPBACK_HOSTS.has(host)) throw new Error('Release gate database must be loopback-only.');
    if (!ALLOWED_DATABASES.has(database)) throw new Error(`Refusing release gate database: ${database || '[missing]'}.`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Release gate database port is invalid.');

    const createConnection = dependencies.createConnection || mysql.createConnection;
    const connection = await createConnection({
        host,
        port,
        user: env.DB_USER || 'root',
        password: env.DB_PASSWORD || '',
        connectTimeout: 5_000,
    });
    try {
        const [[server]] = await connection.query('SELECT VERSION() AS version, @@port AS port');
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        return { platform, database, version: String(server.version), port: Number(server.port), host: os.hostname() };
    } finally {
        await connection.end();
    }
}

if (require.main === module) {
    verifyWindowsSelfHostedRunner().then(result => {
        console.log(`Windows runner ready: MariaDB ${result.version} on loopback port ${result.port}; database ${result.database}.`);
    }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { verifyWindowsSelfHostedRunner };
