const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { validateRequiredSchema } = require('../../backend/services/schemaValidation');

function requestJson(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                let parsed = body;
                try { parsed = JSON.parse(body); } catch {}
                resolve({ status: response.statusCode, body: parsed });
            });
        });
        request.once('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('HTTP verification timed out.')));
    });
}

async function verifyInstallation(options = {}) {
    const host = options.host || process.env.DB_HOST || '127.0.0.1';
    const port = Number(options.dbPort || process.env.DB_PORT || 3306);
    const database = options.database || process.env.DB_NAME || 'posapp';
    const connection = options.connection || await mysql.createConnection({ host, port, database, user: options.dbUser || process.env.DB_USER, password: options.dbPassword || process.env[['DB', 'PASSWORD'].join('_')] });
    try {
        await validateRequiredSchema(connection);
        const [[admin]] = await connection.query("SELECT COUNT(*) AS count FROM users WHERE user_number = '009384' AND role = 'admin' AND is_active = 1");
        if (Number(admin.count) !== 1) throw new Error('Expected exactly one active 009384 administrator.');
        if (options.expectFresh !== false) {
            const [[programmer]] = await connection.query("SELECT COUNT(*) AS count FROM users WHERE role = 'programmer' AND is_active = 1 AND user_number REGEXP '^[1-9][0-9]{11}$'");
            if (Number(programmer.count) !== 1) throw new Error('Expected exactly one active generated programmer.');
            for (const table of ['orders', 'products', 'customers']) {
                const [[rows]] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
                if (Number(rows.count) !== 0) throw new Error(`Fresh database is not empty: ${table}.`);
            }
        }
        const health = await requestJson(options.healthUrl || `http://127.0.0.1:${options.posPort || process.env.PORT || 3000}/health`);
        if (health.status !== 200 || health.body?.status !== 'ok' || health.body?.db !== 'connected' || !health.body?.release?.version) throw new Error('POS health verification failed.');
        if (options.expectedVersion && health.body.release.version !== options.expectedVersion) throw new Error('POS release version verification failed.');
        if (options.expectedCommit && health.body.release.commit !== options.expectedCommit) throw new Error('POS release commit verification failed.');
        if (options.expectedSchemaVersion && health.body.release.schemaVersion !== options.expectedSchemaVersion) throw new Error('POS schema release verification failed.');
        const phpMyAdmin = await requestJson(options.phpMyAdminUrl || `http://127.0.0.1:${options.phpMyAdminPort || 8081}/`);
        if (phpMyAdmin.status < 200 || phpMyAdmin.status >= 400) throw new Error('phpMyAdmin loopback verification failed.');
        const durableDirs = options.durableDirs || [process.env.POSAPP_UPLOAD_DIR, process.env.POSAPP_LOG_DIR, process.env.POSAPP_BACKUP_DIR].filter(Boolean);
        for (const directory of durableDirs) {
            if (!fs.existsSync(directory)) throw new Error(`Durable directory is missing: ${directory}`);
            fs.accessSync(directory, fs.constants.W_OK);
            const probe = path.join(directory, `.installer-probe-${process.pid}`);
            fs.writeFileSync(probe, 'ok');
            fs.unlinkSync(probe);
        }
        if (options.backupFile) {
            const compressed = fs.readFileSync(options.backupFile);
            const digest = crypto.createHash('sha256').update(compressed).digest('hex');
            zlib.gunzipSync(compressed);
            if (options.expectedBackupSha256 && digest !== options.expectedBackupSha256) throw new Error('Backup checksum verification failed.');
        }
        return { verified: true, release: health.body.release };
    } finally {
        if (!options.connection) await connection.end();
    }
}

function readConfig(configPath) {
    if (!configPath || !path.isAbsolute(configPath)) throw new Error('Config path must be absolute.');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    if (config.host && config.host !== '127.0.0.1') throw new Error('Database host must be loopback.');
    if (!config.dbPassword || String(config.dbPassword).includes('{{')) throw new Error('Missing database password.');
    if (!config.healthUrl || !config.phpMyAdminUrl || !config.backupFile || !config.expectedBackupSha256 || !config.expectedVersion || !config.expectedCommit || !config.expectedSchemaVersion) throw new Error('Verification URLs, release identity and backup evidence are required.');
    return config;
}

if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (args.length !== 2 || args[0] !== '--config') throw new Error('Usage: verify-install.js --config <absolute-json-path>');
        const config = readConfig(args[1]);
        verifyInstallation(config).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { console.error(error.message); process.exitCode = 1; });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { verifyInstallation, requestJson, readConfig };
