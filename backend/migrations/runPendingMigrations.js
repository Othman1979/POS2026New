const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MANIFEST_PATH = path.join(__dirname, 'auto-manifest.json');
const SUBSCRIPTION_RETIREMENT_NAME = '2026-09-23-subscriptions-retirement-v1';
const PRE_RETIREMENT_REPEATABLES = new Set([
    '2026-08-01-additive-schema-reconciliation-v1',
    '2026-08-09-imported-schema-drift-repair-v1',
    '2026-08-09-baseline-foreign-key-authority-v1'
]);
const LOCK_NAME = 'posapp_schema_migrations';
const LOCK_TIMEOUT_SECONDS = 60;
const SHA256 = /^[a-f0-9]{64}$/;
const SQL_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/;

function splitMysqlScript(sql) {
    const source = String(sql).replace(/^\uFEFF/, '');
    if (/\b(?:DELIMITER|PROCEDURE|TRIGGER|DEFINER)\b/i.test(source)) {
        throw new Error('Automatic migration SQL must use the Hostinger-safe statement format.');
    }
    let buffer = [];
    const statements = [];

    for (const rawLine of source.split(/\r?\n/)) {
        buffer.push(rawLine);
        const pending = buffer.join('\n').trim();
        if (!pending.endsWith(';')) continue;

        const statement = pending.slice(0, -1).trim();
        if (statement) statements.push(statement);
        buffer = [];
    }

    if (buffer.join('\n').trim()) throw new Error('Invalid migration SQL: unterminated statement.');
    return statements;
}

function assertAdditiveStatements(statements, migrationName) {
    for (const statement of statements) {
        let inspected = statement.trimStart();
        while (inspected.startsWith('--') || inspected.startsWith('#') || inspected.startsWith('/*')) {
            if (inspected.startsWith('/*')) {
                const end = inspected.indexOf('*/');
                inspected = end < 0 ? '' : inspected.slice(end + 2).trimStart();
            } else {
                const end = inspected.indexOf('\n');
                inspected = end < 0 ? '' : inspected.slice(end + 1).trimStart();
            }
        }
        const constraintDrop = inspected.match(
            /^ALTER\s+TABLE\s+[`A-Za-z0-9_]+\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+([`A-Za-z0-9_]+)\s*,\s*ADD\s+CONSTRAINT\s+([`A-Za-z0-9_]+)\s+CHECK\b[\s\S]*$/i
        );
        const allowedConstraintDrop = Boolean(
            constraintDrop
            && constraintDrop[1].replace(/`/g, '').toLowerCase() === constraintDrop[2].replace(/`/g, '').toLowerCase()
            && !/\b(?:DROP|RENAME|DELETE|TRUNCATE|REPLACE)\b/i.test(inspected.slice(inspected.search(/\bCHECK\b/i)))
        );
        if (/^(?:DROP|DELETE|TRUNCATE|RENAME|REPLACE)\b/i.test(inspected)
            || (/^ALTER\s+TABLE\b/i.test(inspected) && /\b(?:DROP|RENAME)\b/i.test(inspected) && !allowedConstraintDrop)) {
            throw new Error(`Repeatable migration ${migrationName} must contain additive statements only.`);
        }
    }
}

function readManifest(manifestPath) {
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        throw new Error(`Invalid automatic migration manifest: ${error.message}`);
    }
    if (!Array.isArray(manifest.migrations)) throw new Error('Invalid automatic migration manifest: migrations must be an array.');

    const directory = path.dirname(manifestPath);
    const names = new Set();
    return manifest.migrations.map((migration) => {
        if (!migration || typeof migration !== 'object') throw new Error('Invalid automatic migration entry.');
        if (!migration.name || names.has(migration.name)) throw new Error(`Invalid or duplicate migration name: ${migration.name || '<empty>'}.`);
        names.add(migration.name);
        if (!SHA256.test(migration.checksum || '')) throw new Error(`Invalid ledger checksum for migration ${migration.name}.`);
        if (!SHA256.test(migration.sha256 || '')) throw new Error(`Invalid file hash for migration ${migration.name}.`);
        if (!SQL_FILE.test(migration.file || '')) throw new Error(`Invalid migration file name for ${migration.name}.`);
        if (migration.preflight !== undefined) {
            if (!SQL_FILE.test(migration.preflight || '') || !SHA256.test(migration.preflightSha256 || '')) {
                throw new Error(`Invalid preflight contract for migration ${migration.name}.`);
            }
        }
        if (!migration.requires?.name || !SHA256.test(migration.requires?.checksum || '')) {
            throw new Error(`Invalid predecessor for migration ${migration.name}.`);
        }
        if (migration.repeatable !== undefined && typeof migration.repeatable !== 'boolean') {
            throw new Error(`Invalid repeatable flag for migration ${migration.name}.`);
        }

        const sqlPath = path.join(directory, migration.file);
        const sql = fs.readFileSync(sqlPath, 'utf8');
        const normalizedSql = sql.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        const actualHash = crypto.createHash('sha256').update(normalizedSql, 'utf8').digest('hex');
        if (actualHash !== migration.sha256) throw new Error(`Migration file hash conflict for ${migration.name}.`);
        let preflightSql = null;
        if (migration.preflight) {
            preflightSql = fs.readFileSync(path.join(directory, migration.preflight), 'utf8');
            const normalizedPreflight = preflightSql.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
            const actualPreflightHash = crypto.createHash('sha256').update(normalizedPreflight, 'utf8').digest('hex');
            if (actualPreflightHash !== migration.preflightSha256) {
                throw new Error(`Migration preflight hash conflict for ${migration.name}.`);
            }
        }
        return { ...migration, sql, preflightSql };
    });
}

async function ledgerChecksum(connection, name) {
    try {
        const [rows] = await connection.query(
            'SELECT checksum FROM schema_migrations WHERE migration_name=? LIMIT 1',
            [name]
        );
        return rows[0]?.checksum || null;
    } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') {
            throw new Error('Automatic migrations require the managed schema baseline with schema_migrations.');
        }
        throw error;
    }
}

async function runPendingMigrations(pool, { manifestPath = DEFAULT_MANIFEST_PATH, includeRepeatable = false } = {}) {
    const migrations = readManifest(path.resolve(manifestPath));
    if (migrations.length === 0) return { applied: [], skipped: [] };

    const connection = await pool.getConnection();
    let lockAcquired = false;
    let connectionReusable = true;
    let failure = null;
    const result = { applied: [], skipped: [] };

    try {
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
        if (Number(lock?.acquired) !== 1) throw new Error('Could not acquire the POS database migration lock.');
        lockAcquired = true;

        let ledger;
        try {
            const names = [...new Set(migrations.flatMap(m => [m.name, m.requires.name]))];
            const [rows] = await connection.query('SELECT migration_name, checksum FROM schema_migrations WHERE migration_name IN (?)', [names]);
            ledger = new Map(rows.map(row => [row.migration_name, row.checksum]));
        } catch (error) {
            if (error.code === 'ER_NO_SUCH_TABLE') throw new Error('Automatic migrations require the managed schema baseline with schema_migrations.');
            throw error;
        }
        for (const migration of migrations) {
            const currentChecksum = ledger.get(migration.name);
            if (currentChecksum) {
                if (currentChecksum !== migration.checksum) throw new Error(`Migration checksum conflict for ${migration.name}.`);
            }

            const predecessorChecksum = ledger.get(migration.requires.name);
            if (predecessorChecksum !== migration.requires.checksum) {
                throw new Error(
                    `Migration ${migration.name} requires ${migration.requires.name} with its exact checksum before automatic upgrade.`
                );
            }

            if (ledger.has(SUBSCRIPTION_RETIREMENT_NAME) && PRE_RETIREMENT_REPEATABLES.has(migration.name) && !currentChecksum) {
                throw new Error(`Retired historical migration ledger entry is missing: ${migration.name}.`);
            }

            // These historical repair scripts recreate/alter retired subscription tables.
            if (currentChecksum && (!migration.repeatable || !includeRepeatable ||
                (ledger.has(SUBSCRIPTION_RETIREMENT_NAME) && PRE_RETIREMENT_REPEATABLES.has(migration.name)))) {
                result.skipped.push(migration.name);
                continue;
            }

            if (migration.preflightSql) {
                const preflightStatements = splitMysqlScript(migration.preflightSql);
                if (preflightStatements.length !== 1 || !/^\s*(?:--[^\n]*\n\s*)*SELECT\b/i.test(preflightStatements[0])) {
                    throw new Error(`Migration preflight ${migration.name} must contain exactly one read-only SELECT.`);
                }
                const [rows] = await connection.query(preflightStatements[0]);
                if (!Array.isArray(rows) || Number(rows[0]?.ok) !== 1) {
                    throw Object.assign(new Error(`Migration ${migration.name} preflight rejected the current schema.`), { code: 'MIGRATION_PREFLIGHT_REJECTED' });
                }
            }

            const statements = splitMysqlScript(migration.sql);
            if (migration.repeatable) assertAdditiveStatements(statements, migration.name);
            for (let index = 0; index < statements.length; index += 1) {
                try {
                    await connection.query(statements[index]);
                } catch (error) {
                    const reason = error.code || error.errno || 'database error';
                    throw new Error(
                        `Automatic migration ${migration.name} failed at statement ${index + 1}/${statements.length} (${reason}).`
                    );
                }
            }

            const appliedChecksum = await ledgerChecksum(connection, migration.name);
            if (appliedChecksum !== migration.checksum) {
                throw new Error(`Migration ${migration.name} did not record its expected schema_migrations checksum.`);
            }
            ledger.set(migration.name, appliedChecksum);
            result.applied.push(migration.name);
        }
    } catch (error) {
        failure = error;
    } finally {
        if (lockAcquired) {
            try {
                const [[released]] = await connection.query('SELECT RELEASE_LOCK(?) AS released', [LOCK_NAME]);
                if (Number(released?.released) !== 1) throw new Error('MySQL did not confirm lock release.');
            } catch (error) {
                connectionReusable = false;
                connection.destroy();
                if (!failure) failure = new Error(`Failed to release the POS database migration lock: ${error.message}`);
            }
        }
        if (connectionReusable) connection.release();
    }

    if (failure) throw failure;
    return result;
}

module.exports = { runPendingMigrations, splitMysqlScript };
