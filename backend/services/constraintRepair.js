'use strict';

// Restores foreign keys and CHECK rules that an old or imported database lost. Export/import
// tools can drop every constraint while schema_migrations still says the migrations ran, so
// preflights and the startup schema check refuse the database. This only ADDS what the fresh
// schema defines; the ALTER itself validates existing rows in one pass, and a key or rule that
// rows break is reported, never forced. It runs only after a preflight or the schema check has
// already refused to start.
const manifest = require('./schemaConstraintManifest.json');

const GENERAL = 'utf8mb4_general_ci';
// Known collation drift from older installs: linked text columns must share a collation, and
// the startup check requires these tables in utf8mb4_general_ci.
const CONVERT_TABLES = ['service_charge_snapshots', 'print_templates', 'print_template_revisions', 'print_template_revision_tests'];
const ALIGN_COLUMNS = [
    { table: 'orders', column: 'service_charge_snapshot_id', definition: 'char(36) DEFAULT NULL' },
    { table: 'held_orders', column: 'service_charge_snapshot_id', definition: 'char(36) DEFAULT NULL' }
];
// MariaDB errors meaning "existing rows break this key/rule" or "a later migration adds this column".
const ROWS_BREAK_FOREIGN_KEY = new Set([1452, 1216]);
const ROWS_BREAK_CHECK = new Set([4025, 3819]);
const MISSING_COLUMN = new Set([1054, 1146]);

const id = name => `\`${name}\``;

async function schemaSnapshot(db) {
    const [columns] = await db.query(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLLATION_NAME AS collation
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`
    );
    const [constraints] = await db.query(
        `SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS name
           FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE IN ('FOREIGN KEY', 'CHECK')`
    );
    const [tables] = await db.query(
        `SELECT TABLE_NAME AS t, TABLE_COLLATION AS collation
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
    );
    return {
        columns: new Map(columns.map(row => [`${row.t}.${row.c}`, row.collation])),
        constraints: new Set(constraints.map(row => `${row.t}.${row.name}`)),
        tables: new Map(tables.map(row => [row.t, row.collation]))
    };
}

async function alignCollations(db, snapshot, changes, blocked, dropped) {
    const leftUnchanged = new Set();
    for (const table of CONVERT_TABLES) {
        const collation = snapshot.tables.get(table);
        if (!collation) continue;
        // Drift can sit on the table default or on single columns (the template JSON is binary by design).
        const driftedColumn = [...snapshot.columns].some(([key, value]) => key.startsWith(`${table}.`)
            && value && value !== GENERAL && key !== 'print_template_revisions.definition_json');
        if (collation === GENERAL && !driftedColumn) continue;
        if (!await dropTextForeignKeys(db, [table], null, blocked, dropped)) {
            leftUnchanged.add(table);
            continue;
        }
        await db.query(`ALTER TABLE ${id(table)} CONVERT TO CHARACTER SET utf8mb4 COLLATE ${GENERAL}`);
        changes.push(`collation ${table}`);
    }
    // CONVERT also rewrites the template JSON; it keeps the binary collation of a fresh install.
    const templateJson = (await schemaSnapshot(db)).columns.get('print_template_revisions.definition_json');
    if (templateJson && templateJson !== 'utf8mb4_bin') {
        await db.query('ALTER TABLE `print_template_revisions` MODIFY `definition_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL');
        changes.push('collation print_template_revisions.definition_json');
    }
    // The snapshot-id columns reference service_charge_snapshots.id: if the parent stayed on its old
    // collation, converting them would leave keys that can no longer be re-added.
    if (leftUnchanged.has('service_charge_snapshots')) return;
    for (const { table, column, definition } of ALIGN_COLUMNS) {
        const collation = snapshot.columns.get(`${table}.${column}`);
        if (!collation || collation === GENERAL) continue;
        if (!await dropTextForeignKeys(db, [table], column, blocked, dropped)) continue;
        await db.query(`ALTER TABLE ${id(table)} MODIFY ${id(column)} ${definition.replace(/^(\w+\(\d+\))/, `$1 CHARACTER SET utf8mb4 COLLATE ${GENERAL}`)}`);
        changes.push(`collation ${table}.${column}`);
    }
}

// MariaDB will not change the collation of a text column a foreign key uses. Such keys (only
// ones the fresh schema defines) are dropped here and re-added by the foreign-key step below.
// A key is dropped only if no row breaks it (bounded probe), so it can be re-added; otherwise the
// column is left alone and reported. Returns false when the alignment must be skipped.
const MANIFEST_FOREIGN_KEYS = new Map(manifest.foreignKeys.map(fk => [fk.name, fk]));
async function hasBrokenRow(db, fk) {
    const join = fk.columns.map((column, index) => `p.${id(fk.referencedColumns[index])} = c.${id(column)}`).join(' AND ');
    const present = fk.columns.map(column => `c.${id(column)} IS NOT NULL`).join(' AND ');
    const [rows] = await db.query(`SELECT 1 FROM ${id(fk.table)} c LEFT JOIN ${id(fk.references)} p ON ${join} WHERE ${present} AND p.${id(fk.referencedColumns[0])} IS NULL LIMIT 1`);
    return rows.length > 0;
}
async function dropTextForeignKeys(db, tables, onlyColumn, blocked, dropped) {
    const [rows] = await db.query(
        `SELECT DISTINCT k.TABLE_NAME AS t, k.CONSTRAINT_NAME AS name
           FROM information_schema.KEY_COLUMN_USAGE k
           JOIN information_schema.COLUMNS c
             ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME
          WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
            AND c.COLLATION_NAME IS NOT NULL
            AND (k.TABLE_NAME IN (?) OR k.REFERENCED_TABLE_NAME IN (?))
            AND (? IS NULL OR k.COLUMN_NAME = ? OR k.REFERENCED_COLUMN_NAME = ?)`,
        [tables, tables, onlyColumn, onlyColumn, onlyColumn]
    );
    const keys = rows.map(row => MANIFEST_FOREIGN_KEYS.get(row.name)).filter(Boolean);
    for (const fk of keys) {
        if (await hasBrokenRow(db, fk)) {
            blocked.push({ constraint: fk.name, table: fk.table, problem: `rows point to a missing ${fk.references} row; collation left unchanged` });
            return false;
        }
    }
    for (const fk of keys) {
        await db.query(`ALTER TABLE ${id(fk.table)} DROP FOREIGN KEY ${id(fk.name)}`);
        dropped.add(fk.name);
    }
    return true;
}

const addForeignKeySql = fk => `ALTER TABLE ${id(fk.table)} ADD CONSTRAINT ${id(fk.name)} FOREIGN KEY (${fk.columns.map(id).join(', ')}) REFERENCES ${id(fk.references)} (${fk.referencedColumns.map(id).join(', ')})${fk.actions ? ` ${fk.actions}` : ''}`;

async function restoreDropped(db, dropped) {
    const lost = [];
    for (const name of dropped) {
        try {
            await db.query(addForeignKeySql(MANIFEST_FOREIGN_KEYS.get(name)));
            dropped.delete(name);
        } catch (_) {
            lost.push(name);
        }
    }
    return lost;
}

async function repairMissingConstraints(pool, { logger } = {}) {
    // One connection, so the session setting below applies to every statement it covers.
    const db = typeof pool.getConnection === 'function' ? await pool.getConnection() : pool;
    try {
        return await repair(db, logger);
    } finally {
        if (db !== pool) db.release();
    }
}

async function repair(db, logger) {
    const changes = [];
    const blocked = [];
    const dropped = new Set();
    try {
        return await repairSteps(db, logger, changes, blocked, dropped);
    } catch (error) {
        // Whatever failed, put back every key dropped for a collation change before reporting it.
        const lost = await restoreDropped(db, dropped);
        if (lost.length) error.message = `${error.message} Foreign keys that could not be restored: ${lost.join(', ')}.`;
        throw error;
    }
}

async function repairSteps(db, logger, changes, blocked, dropped) {
    // An existing foreign key on a drifted column blocks a collation change. Only the collation
    // step runs without key checks; it changes how ids compare, never the stored values.
    await db.query('SET SESSION FOREIGN_KEY_CHECKS = 0');
    try {
        await alignCollations(db, await schemaSnapshot(db), changes, blocked, dropped);
    } finally {
        await db.query('SET SESSION FOREIGN_KEY_CHECKS = 1');
    }
    const snapshot = await schemaSnapshot(db);
    const hasColumns = (table, columns) => columns.every(column => snapshot.columns.has(`${table}.${column}`));

    for (const fk of manifest.foreignKeys) {
        if (snapshot.constraints.has(`${fk.table}.${fk.name}`)) continue;
        // A table or column a later migration creates is left to that migration.
        if (!hasColumns(fk.table, fk.columns) || !hasColumns(fk.references, fk.referencedColumns)) continue;
        try {
            await db.query(addForeignKeySql(fk));
        } catch (error) {
            if (!ROWS_BREAK_FOREIGN_KEY.has(error.errno)) throw error;
            blocked.push({ constraint: fk.name, table: fk.table, problem: `rows point to a missing ${fk.references} row` });
            continue;
        }
        changes.push(`${dropped.delete(fk.name) ? 're-created' : 'foreign key'} ${fk.name}`);
    }

    for (const check of manifest.checks) {
        if (snapshot.constraints.has(`${check.table}.${check.name}`) || !snapshot.tables.has(check.table)) continue;
        try {
            await db.query(`ALTER TABLE ${id(check.table)} ADD CONSTRAINT ${id(check.name)} CHECK (${check.expression})`);
        } catch (error) {
            if (MISSING_COLUMN.has(error.errno)) continue; // a later migration adds the column
            if (!ROWS_BREAK_CHECK.has(error.errno)) throw error;
            blocked.push({ constraint: check.name, table: check.table, problem: 'rows break the rule' });
            continue;
        }
        changes.push(`check ${check.name}`);
    }

    // Fail closed: a key dropped only to change a collation must be back before startup continues.
    if (dropped.size) {
        throw Object.assign(new Error(`Constraint repair could not re-add foreign keys it dropped: ${[...dropped].join(', ')}.`), { code: 'SCHEMA_MIGRATION_REQUIRED' });
    }
    if (changes.length) logger?.warn({ restored: changes.length, changes }, 'Restored missing schema constraints from the fresh schema.');
    if (blocked.length) logger?.error({ blocked }, 'Some schema constraints cannot be restored until these rows are fixed.');
    return { changed: changes.length > 0, changes, blocked };
}

module.exports = { repairMissingConstraints };
