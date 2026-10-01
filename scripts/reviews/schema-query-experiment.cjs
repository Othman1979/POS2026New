const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const mysql = require('mysql2/promise');
process.env.POSAPP_REVIEW_DB = 'posapp_review_recipe_p1_' + randomBytes(6).toString('hex');
require('./recipe-ledger-phase1-preload.cjs');
const { getTestDatabaseOptions } = require('../../backend/tests/testDatabase.cjs');
const baseline = process.argv[2] || '61ab4e38';
const sqlFile = process.argv[3] || 'C:/Users/bash/Documents/New folder/fresh-database.sql';
function revisionModule(relative) {
    const filename = path.resolve(relative);
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(execFileSync('git', ['show', `${baseline}:${relative}`], { encoding: 'utf8' }), filename);
    return loaded.exports;
}
async function main() {
    fs.mkdirSync('scratch', { recursive: true });
    const { database, ...options } = getTestDatabaseOptions();
    const admin = await mysql.createConnection(options);
    let pool, created = false;
    try {
        await admin.query(`CREATE DATABASE \`${database}\``); created = true;
        pool = mysql.createPool({ ...options, database, multipleStatements: true });
        const sql = fs.readFileSync(sqlFile, 'utf8');
        if (/^\s*(?:USE\s|(?:CREATE|DROP|ALTER)\s+(?:DATABASE|USER)\b|GRANT\s)/im.test(sql)) throw new Error('Only a selected-database fresh import is supported.');
        await pool.query(sql);
        const versions = [
            { name: baseline, validator: revisionModule('backend/services/schemaValidation.js'), runner: revisionModule('backend/migrations/runPendingMigrations.js') },
            { name: 'working-checkout', validator: require('../../backend/services/schemaValidation'), runner: require('../../backend/migrations/runPendingMigrations') }
        ];
        const results = [];
        for (const version of versions) for (let pass = 0; pass < (version.name === baseline ? 1 : 3); pass++) {
            let queries = 0;
            const counted = { query(...args) { queries++; return pool.query(...args); }, async getConnection() {
                const connection = await pool.getConnection();
                return {query(...args){queries++;return connection.query(...args)},release(){connection.release()},destroy(){connection.destroy()}};
            }};
            const start = performance.now();
            const run = await version.runner.runPendingMigrations(counted);
            const migrationsMs = performance.now() - start, migrationQueries = queries;
            if (run.applied.length) throw new Error('Expected a current-schema no-op.');
            await version.validator.validateRequiredSchema(counted);
            const result = { version: version.name, pass, migrationsMs, migrationQueries, schemaMs: performance.now() - start - migrationsMs, schemaQueries: queries - migrationQueries };
            results.push(result); console.log(result);
        }
        // A missing authority index must still block startup, with the same diagnostic.
        await pool.query('ALTER TABLE stock_operations DROP INDEX uq_stock_operation_request');
        for (const version of versions) {
            let error; try { await version.validator.validateRequiredSchema(pool); } catch (caught) { error = caught; }
            if (error?.code !== 'SCHEMA_MIGRATION_REQUIRED' || !error.message.includes('stock_operation_request_key')) throw new Error('Schema drift was not rejected correctly.');
        }
        fs.writeFileSync('scratch/backend-startup-comparison.json', JSON.stringify({ baseline, node: process.version, platform: process.platform, results, missingAuthorityIndex: 'rejected by both' }, null, 2));
    } finally { if (pool) await pool.end(); if (created) await admin.query(`DROP DATABASE \`${database}\``); await admin.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
