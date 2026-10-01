const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { runPendingMigrations } = require('../../backend/migrations/runPendingMigrations');
const { validateRequiredSchema } = require('../../backend/services/schemaValidation');
const { repairMissingConstraints } = require('../../backend/services/constraintRepair');
const { migrateAndValidate } = require('../../backend/services/migrateAndValidate');

function environmentPath(argv) {
    const index = argv.indexOf('--env');
    const value = index >= 0 ? argv[index + 1] : null;
    if (!value || !path.isAbsolute(value)) {
        throw new Error('Usage: run-pending-migrations.js --env <absolute-path>');
    }
    return value;
}

async function runPendingMigrationsCli(argv, dependencies = {}) {
    const envPath = environmentPath(argv);
    if (!fs.existsSync(envPath)) throw new Error('Maintenance environment file is missing');
    const values = dotenv.parse(fs.readFileSync(envPath));
    const required = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
    if (required.some((key) => !Object.prototype.hasOwnProperty.call(values, key))
        || ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER'].some((key) => !values[key])) {
        throw new Error('Maintenance database configuration is incomplete');
    }
    const port = Number(values.DB_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Maintenance database port is invalid');

    const createPool = dependencies.createPool || mysql.createPool;
    const runMigrations = dependencies.runMigrations || runPendingMigrations;
    const validateSchema = dependencies.validateSchema || validateRequiredSchema;
    const repairConstraints = dependencies.repairConstraints || repairMissingConstraints;
    const write = dependencies.write || ((message) => process.stdout.write(message));
    const pool = createPool({
        host: values.DB_HOST,
        port,
        database: values.DB_NAME,
        user: values.DB_USER,
        password: values.DB_PASSWORD,
        waitForConnections: true,
        connectionLimit: 1,
        decimalNumbers: true,
    });

    try {
        // Same sequence as server startup, run here with the maintenance account (DDL rights).
        // The venue updater has no pino logger: print restored and blocked constraints so the
        // operator sees which rows must be fixed.
        const logger = {
            warn: (details, message) => write(`${message} ${JSON.stringify(details.changes || [])}
`),
            error: (details, message) => write(`${message} ${JSON.stringify(details.blocked || [])}
`)
        };
        const result = await migrateAndValidate(pool, { runMigrations, validateSchema, repairConstraints, logger });
        write(`Database migrations applied: ${result.applied.join(', ') || 'none'}\n`);
        write(`Database migrations already current: ${result.skipped.join(', ') || 'none'}\n`);
        return result;
    } finally {
        await pool.end();
    }
}

module.exports = { runPendingMigrationsCli };

if (require.main === module) {
    runPendingMigrationsCli(process.argv.slice(2)).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
