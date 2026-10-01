// Run the existing Vitest suite against a fresh local fixture, without .env or
// the development-schema pretest hook. Pass normal Vitest filters/options.
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
process.chdir(root);
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
const preload = path.join(__dirname, 'reviews', 'recipe-ledger-phase1-preload.cjs');
require(preload);
const mysql = require('mysql2/promise');
const { getTestDatabaseOptions } = require('../backend/tests/testDatabase.cjs');

async function run() {
    const { database, ...options } = getTestDatabaseOptions();
    let created = false;
    try {
        const connection = await mysql.createConnection(options);
        try {
            // No IF NOT EXISTS: a collision must never authorize dropping an existing DB.
            await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            created = true;
        } finally { await connection.end(); }
        console.log(`Isolated Vitest database: ${database}`);
        const result = spawnSync(process.execPath, [
            path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...process.argv.slice(2),
        ], {
            cwd: root,
            stdio: 'inherit',
            env: {
                ...process.env,
                NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require="${preload.replace(/\\/g, '/')}"`.trim(),
            },
        });
        if (result.error) throw result.error;
        process.exitCode = result.status ?? 1;
    } finally {
        if (created) {
            const connection = await mysql.createConnection(options);
            try { await connection.query(`DROP DATABASE \`${database}\``); }
            finally { await connection.end(); }
        }
    }
}

run().catch(error => {
    console.error('Isolated test run failed:', error.message);
    process.exitCode = 1;
});
