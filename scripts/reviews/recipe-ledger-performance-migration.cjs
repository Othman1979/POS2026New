const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const mysql = require('mysql2/promise');
const root = path.resolve(__dirname, '../..');
const database = process.env.POSAPP_REVIEW_DB;
assert.match(database || '', /^posapp_review_recipe_p1_[a-f0-9]{12}$/);
assert.equal(database, process.env.DB_NAME);
const targetName = '2026-09-06-recipe-ledger-performance-v1';
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'backend/migrations/auto-manifest.json'), 'utf8'));
const entry = manifest.migrations.at(-1);
assert.equal(entry.name, targetName);
const results = { database, predecessorCommit: 'dfb5262d' };
async function main() {
    const admin = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
    await admin.query('CREATE DATABASE ' + database + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
    const [[runtime]] = await admin.query('SELECT VERSION() version'); results.runtime = runtime;
    await admin.end();
    // The exact fixture from the measured predecessor, with no guessed schema edits.
    const filename = path.join(root, 'backend/tests/fixtures/seed.js');
    const prior = execFileSync('git', ['show', 'dfb5262d:backend/tests/fixtures/seed.js'], { cwd: root, encoding: 'utf8' });
    const fixture = new Module(filename, module);
    fixture.filename = filename; fixture.paths = Module._nodeModulePaths(path.dirname(filename)); fixture._compile(prior, filename);
    await fixture.exports.seedDatabase();
    const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database, connectionLimit: 1 });
    const { runPendingMigrations, splitMysqlScript } = require('../../backend/migrations/runPendingMigrations');
    try {
        const [[predecessor]] = await pool.query('SELECT checksum FROM schema_migrations WHERE migration_name=?', [entry.requires.name]);
        assert.equal(predecessor.checksum, entry.requires.checksum);
        const [existingTables] = await pool.query("SHOW TABLES LIKE 'recipe_ledger_lines'"); assert.equal(existingTables.length, 0);
        await pool.query('INSERT INTO ingredients(name,measure,display_unit) VALUES ?', [Array.from({ length: 500 }, (_, i) => ['Migration ingredient ' + i, 'count', 'unit'])]);
        const [ingredients] = await pool.query('SELECT id FROM ingredients ORDER BY id');
        const usageKey = 'a'.repeat(32), reversedKey = 'b'.repeat(32), wideKey = 'c'.repeat(32), emptyKey = 'e'.repeat(32);
        const values = [
            [ingredients[0].id, 'usage', -2, usageKey, 2],
            [ingredients[0].id, 'usage', -1, reversedKey, 1],
            [ingredients[0].id, 'reversal', 1, reversedKey, -1],
            ...ingredients.map(row => [row.id, 'usage', -1, wideKey, 1]),
        ].map(row => [...row, 1, 0.0045, 'order', '2026-09-06']);
        await pool.query('INSERT INTO ingredient_movements(ingredient_id,kind,qty,line_key,product_qty,unit_qty,unit_cost,source_type,business_date) VALUES ?', [values]);
        const [order] = await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method) VALUES (1,0,0,0,'cash')");
        await pool.query('INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,recipe_line_key) VALUES ?', [[
            [order.insertId, 1, 'Empty legacy', 1, 0, emptyKey],
            [order.insertId, 1, 'Composed legacy', 2, 0, usageKey],
        ]]);
        const [before] = await pool.query('SELECT * FROM ingredient_movements ORDER BY id');
        await pool.query('SET SESSION group_concat_max_len=32');
        results.upgrade = await runPendingMigrations(pool);
        assert.deepEqual(results.upgrade.applied, [targetName]);
        const [[concatLimit]] = await pool.query('SELECT @@SESSION.group_concat_max_len n'); assert.equal(Number(concatLimit.n), 32);
        const [registry] = await pool.query('SELECT * FROM recipe_ledger_lines ORDER BY line_key');
        const recorded = Object.fromEntries(registry.map(row => [row.line_key, JSON.parse(row.ingredient_ids)]));
        assert.deepEqual(recorded[emptyKey], []);
        assert.deepEqual(recorded[usageKey], [ingredients[0].id]);
        assert.deepEqual(recorded[reversedKey], [ingredients[0].id]);
        assert.deepEqual(recorded[wideKey], ingredients.map(row => row.id));
        const [after] = await pool.query('SELECT * FROM ingredient_movements ORDER BY id'); assert.deepEqual(after, before);
        results.backfill = { frozenEmpty: true, composed: true, fullyReversed: true, removedLine: true, wideComposition: ingredients.length, movementRowsUnchanged: before.length };
        results.noop = await runPendingMigrations(pool); assert.deepEqual(results.noop.applied, []);
        const sql = fs.readFileSync(path.join(root, 'backend/migrations', entry.file), 'utf8');
        for (const statement of splitMysqlScript(sql)) await pool.query(statement);
        const [repeated] = await pool.query('SELECT * FROM recipe_ledger_lines ORDER BY line_key'); assert.deepEqual(repeated, registry);
        results.directRepeat = 'unchanged';
        const fallback = fs.readFileSync(path.join(root, 'deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        assert.ok(fallback.includes(`-- BEGIN AUTO MIGRATION: ${entry.name} | ${entry.checksum}\n${sql.replace(/\r\n/g, '\n')}-- END AUTO MIGRATION: ${entry.name} | ${entry.checksum}`));
        assert.equal(fs.readFileSync(path.join(root, 'backend/migrations', targetName + '.sql'), 'utf8'), sql);
        results.fallbackParity = 'exact';
        const temp = fs.mkdtempSync(path.join(__dirname, 'performance-migration-'));
        const manifestPath = path.join(temp, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [entry] }));
        fs.writeFileSync(path.join(temp, entry.file), sql);
        try {
            await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [entry.requires.name]);
            await assert.rejects(runPendingMigrations(pool, { manifestPath }), /requires .*exact checksum/);
            await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)', [entry.requires.name, entry.requires.checksum]);
            await pool.query('UPDATE schema_migrations SET checksum=? WHERE migration_name=?', ['0'.repeat(64), targetName]);
            await assert.rejects(runPendingMigrations(pool, { manifestPath }), /checksum conflict/);
            await pool.query('UPDATE schema_migrations SET checksum=? WHERE migration_name=?', [entry.checksum, targetName]);
        } finally { fs.unlinkSync(manifestPath); fs.unlinkSync(path.join(temp, entry.file)); fs.rmdirSync(temp); }
        results.failClosed = ['missing predecessor', 'conflicting checksum'];
        const L = require('../../backend/services/RecipeLedgerService');
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const empty = await L.syncOrderLines(conn, { enabled: true, lines: [{ key: emptyKey, product_id: 1, isNew: false, qty: 2 }], businessDate: '2026-09-06' });
            assert.equal(empty.written, 0);
            const refund = await L.reverseLineUsage(conn, { lineKey: usageKey, qty: 2, sourceType: 'refund', businessDate: '2026-09-06' });
            assert.equal(refund.written, 1);
            const [[net]] = await conn.query('SELECT SUM(qty) qty,SUM(qty*unit_cost) cost FROM ingredient_movements WHERE line_key=?', [usageKey]);
            assert.equal(Number(net.qty), 0); assert.equal(Number(net.cost), 0);
            results.upgradedLineOperations = 'empty edit and full refund passed';
        } finally { await conn.rollback(); conn.release(); }
        results.status = 'PASS';
    } finally { await pool.end(); await require('../../backend/config/db').end(); }
    fs.writeFileSync(path.join(__dirname, 'recipe-ledger-performance-migration.json'), JSON.stringify(results, null, 2)+'\n');
    console.log(JSON.stringify(results));
}
main().catch(error => { console.error(error.stack); process.exitCode=1; });
