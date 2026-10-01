const fs = require('node:fs');
const mysql = require('mysql2');
const { bootstrapDatabase, readVerifiedBaseline } = require('./bootstrap-database');
const { splitMysqlScript } = require('../../backend/migrations/runPendingMigrations');

function initialUserSeed(sql) {
    const statements = splitMysqlScript(sql).filter(statement => /^INSERT INTO users\s*\(/i.test(statement));
    if (statements.length !== 1) throw new Error('Expected one existing initial-user seed statement.');
    // Only the managed two-row seed is carried forward, never arbitrary old SQL.
    const quoted = "'(?:[^'\\\\]|\\\\.|'')*'";
    const columns = 'user_number,\\s*name,\\s*role,\\s*admin_pin,\\s*is_active,\\s*xyz(?:,\\s*table_access_scope)?';
    const row = `\\(\\s*'\\d+'\\s*,\\s*${quoted}\\s*,\\s*'(?:admin|programmer)'\\s*,\\s*(?:NULL|${quoted})\\s*,\\s*[01]\\s*,\\s*[01](?:\\s*,\\s*'all')?\\s*\\)`;
    if (!new RegExp(`^INSERT INTO users\\s*\\(${columns}\\)\\s+VALUES\\s+${row}\\s*,\\s*${row}$`, 'i').test(statements[0])) {
        throw new Error('Initial-user seed differs from the managed format; preserve and review it before rebuilding.');
    }
    return `${statements[0]};`;
}

async function generateFreshDatabaseSql(existingSql) {
    const seed = initialUserSeed(existingSql);
    const { baseline } = readVerifiedBaseline();
    const statements = ["SET time_zone = '+00:00';"];
    let seeded = false;
    await bootstrapDatabase({
        database: 'posapp_export', appPassword: 'export-only', maintenancePassword: 'export-only', adminPassword: 'export-only',
        programmerUserNumber: '123456789012',
        executor: {
            async query(sql, params) {
                const text = String(sql).trim();
                if (/^SELECT COUNT\(\*\) AS count FROM users$/i.test(text)) return [[{ count: 0 }]];
                if (/^(?:CREATE DATABASE|USE\s|CREATE USER|ALTER USER|GRANT\s|FLUSH PRIVILEGES)/i.test(text)) return [[]];
                if (/^INSERT INTO users\b/i.test(text)) {
                    statements.push(seed);
                    // Older kits predate explicit table scope. These two privileged users already have all-table authority.
                    if (!/table_access_scope/i.test(seed)) statements.push("UPDATE users SET table_access_scope='all' WHERE role IN ('admin','programmer');");
                    seeded = true;
                } else {
                    if (sql !== baseline && !/^INSERT(?: IGNORE)? INTO (?:settings|permissions|order_types|invoice_sequences|schema_migrations|stock_report_backfill|print_templates)\b/i.test(text)) {
                        throw new Error('Unrecognized bootstrap statement; review the fresh SQL exporter.');
                    }
                    statements.push(`${mysql.format(text, params).replace(/;$/, '')};`);
                }
                return [[]];
            }
        },
        validate: async () => {} // The caller must import and validate the resulting SQL before publishing it.
    });
    if (!seeded) throw new Error('Bootstrap did not write initial users.');
    statements.push('SET FOREIGN_KEY_CHECKS = 1;');
    return `${statements.join('\n\n')}\n`;
}

if (require.main === module) {
    const [previous, output] = process.argv.slice(2);
    if (!previous || !output) throw new Error('Usage: export-fresh-database.js <previous-sql> <candidate-sql>');
    generateFreshDatabaseSql(fs.readFileSync(previous, 'utf8')).then(sql => fs.writeFileSync(output, sql, 'utf8'))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { generateFreshDatabaseSql, initialUserSeed };
