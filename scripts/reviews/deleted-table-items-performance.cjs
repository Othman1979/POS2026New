// Compare the pre-change void writer and current writer on identical generated
// fixture schemas. Reports local query/row/latency evidence, not customer speed.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const { seedDatabase } = require('../../backend/tests/fixtures/seed');
const revision = process.argv[2] || '6a5bc3bf2c2531a579508012e3cde477814661e5';
const xyz = process.env.TABLE_VOID_XYZ === '1';
const baselineArchives = process.env.VOID_BASELINE_ARCHIVE === '1';
const relativeFile = 'backend/modules/refunds/voidOpenTableOrder.js';
const filename = path.resolve(relativeFile);
const baselineModule = new Module(filename, module);
baselineModule.filename = filename;
baselineModule.paths = Module._nodeModulePaths(path.dirname(filename));
baselineModule._compile(execFileSync('git', ['show', `${revision}:${relativeFile}`], { encoding: 'utf8' }), filename);
const writers = { before: baselineModule.exports.voidOpenTableOrder, after: require(filename).voidOpenTableOrder };
const output = { database, revision, xyz, baselineArchives, runs: [] };
let created = false;

async function run() {
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; }
    finally { await admin.end(); }
    for (const itemCount of [1, 20, 201]) {
        for (let round = 0; round < 3; round++) {
            for (const variant of round % 2 ? ['after', 'before'] : ['before', 'after']) {
                await seedDatabase();
                await pool.query('UPDATE users SET xyz=? WHERE id=1', [xyz ? 1 : 0]);
                const [order] = await pool.query(`INSERT INTO orders(user_id,table_id,subtotal,tax,total,payment_method)
                    VALUES(1,1,?,0,?,'unpaid_table')`, [itemCount * 2, itemCount * 2]);
                await pool.query(`INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,tax_rate,tax_amount)
                    VALUES ?`, [Array.from({ length: itemCount }, (_, i) => [order.insertId, 2, `Saved drink ${i}`, 1, 2, 0, 0])]);
                await pool.query("UPDATE restaurant_tables SET status='occupied',current_order_id=? WHERE id=1", [order.insertId]);
                const original = pool.getConnection.bind(pool);
                let queryCount = 0, rowsReturned = 0, archiveInserts = 0, policyReads = 0, leased = 0;
                pool.getConnection = async () => {
                    const conn = await original(), query = conn.query, release = conn.release;
                    leased++;
                    conn.query = async function(sql, params) {
                        queryCount++;
                        if (String(sql).includes('INSERT INTO deleted')) archiveInserts++;
                        if (String(sql).includes('SELECT COALESCE(MAX(xyz)')) policyReads++;
                        const result = await query.call(this, sql, params);
                        if (Array.isArray(result[0])) rowsReturned += result[0].length;
                        return result;
                    };
                    conn.release = function() { leased--; conn.query = query; conn.release = release; return release.call(this); };
                    return conn;
                };
                const start = performance.now();
                try {
                    await writers[variant]({ user: { id: 1, name: 'Fixture admin', role: 'admin' }, invoiceId: order.insertId, expectedVersion: 1,
                        printKitchenOrder: async () => assert.equal(leased, 0) });
                } finally { pool.getConnection = original; }
                const milliseconds = performance.now() - start;
                assert.equal(leased, 0);
                const [archives] = await pool.query('SELECT * FROM deleted');
                const [orders] = await pool.query('SELECT * FROM orders');
                const recordsHistory = variant === 'before' ? baselineArchives : !xyz;
                assert.equal(archives.length, recordsHistory ? itemCount : 0);
                assert.equal(orders.length, variant === 'before' && !baselineArchives ? 1 : 0);
                assert.equal(policyReads, 1);
                if (variant === 'after') assert.equal(archiveInserts, xyz ? 0 : Math.ceil(itemCount / 200));
                output.runs.push({ variant, itemCount, round, queryCount, rowsReturned, archiveInserts, policyReads, milliseconds });
            }
        }
    }
    output.complete = true;
}
run().catch(error => { output.error = error.stack; console.error(error); process.exitCode = 1; }).finally(async () => {
    await pool.end();
    if (created) {
        const admin = await mysql.createConnection(options);
        try { await admin.query(`DROP DATABASE \`${database}\``); output.removed = true; }
        finally { await admin.end(); }
    }
    fs.mkdirSync('scratch', { recursive: true });
    fs.writeFileSync(process.env.VOID_PERFORMANCE_OUTPUT || (baselineArchives ? `scratch/table-void-xyz-${xyz ? 1 : 0}-performance.json` : 'scratch/deleted-table-items-performance.json'), JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output, null, 2));
});
