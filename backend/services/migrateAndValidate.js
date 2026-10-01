'use strict';

const { runPendingMigrations } = require('../migrations/runPendingMigrations');
const { validateRequiredSchema } = require('./schemaValidation');
const { repairMissingConstraints } = require('./constraintRepair');

// The one startup/update schema sequence, shared by server startup and the privileged
// updater CLI so both heal the same way:
// 1. pending migrations; if a preflight rejects a schema that lost its constraints (an old or
//    imported database), restore them from the fresh schema and retry;
// 2. the required-schema check; on drift, the repeatable additive reconciliation;
// 3. if the check still fails, restore lost constraints once more and check again.
async function migrateAndValidate(db, {
    logger,
    runMigrations = runPendingMigrations,
    validateSchema = validateRequiredSchema,
    repairConstraints = repairMissingConstraints
} = {}) {
    let result;
    for (let attempt = 0; ; attempt += 1) {
        try {
            result = await runMigrations(db);
            break;
        } catch (error) {
            if (error.code !== 'MIGRATION_PREFLIGHT_REJECTED' || attempt >= 3) throw error;
            const repair = await repairConstraints(db, { logger });
            if (!repair.changed) throw error;
        }
    }
    try {
        await validateSchema(db);
        return result;
    } catch (error) {
        if (error.code !== 'SCHEMA_MIGRATION_REQUIRED') throw error;
        logger?.warn({ err: error }, 'Managed schema drift detected. Running additive reconciliation once.');
    }
    const reconciliation = await runMigrations(db, { includeRepeatable: true });
    const applied = [...result.applied, ...reconciliation.applied];
    const appliedNames = new Set(applied);
    result = {
        applied,
        skipped: [...new Set([...result.skipped, ...reconciliation.skipped])].filter(name => !appliedNames.has(name))
    };
    try {
        await validateSchema(db);
    } catch (error) {
        if (error.code !== 'SCHEMA_MIGRATION_REQUIRED') throw error;
        const repair = await repairConstraints(db, { logger });
        if (!repair.changed) throw error;
        await validateSchema(db);
    }
    return result;
}

module.exports = { migrateAndValidate };
