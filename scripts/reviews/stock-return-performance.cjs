// Opt-in comparison of the old refund stock loop and the shared batch adapter.
// Creates and removes only its own guarded loopback fixture.
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const { restoreStockForCart } = require('../../backend/services/InventoryService');
let created = false;
async function oldReturn(conn, lines) {
    for (const line of lines) {
        if (line.product_id) await conn.query(
            'UPDATE products SET stock_version=stock_version+1, stock=stock+? WHERE id=? AND stock IS NOT NULL',
            [line.quantity, line.product_id]);
    }
}
async function measure(action, lines) {
    const elapsed = [];
    let queryCount = 0;
    const cpu = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;
    for (let index = 0; index < 1025; index++) {
        const start = performance.now();
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await action({ query: (...args) => { if (index >= 25) queryCount++; return conn.query(...args); } }, lines);
            await conn.commit();
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
        if (index >= 25) elapsed.push(performance.now() - start);
    }
    const used = process.cpuUsage(cpu);
    elapsed.sort((a, b) => a - b);
    return { samples: elapsed.length, p50_ms: elapsed[499], p95_ms: elapsed[949], p99_ms: elapsed[989],
        stock_queries_per_operation: queryCount / elapsed.length,
        node_cpu_ms_per_operation_including_warmup: (used.user + used.system) / 1000 / 1025,
        rss_before_mib: rssBefore / 2 ** 20, rss_after_mib: process.memoryUsage().rss / 2 ** 20 };
}
async function main() {
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; }
    finally { await admin.end(); }
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    const lines = [];
    for (let index = 0; index < 10; index++) {
        const [row] = await pool.query("INSERT INTO products(name,price,stock) VALUES ('Return benchmark',1,10)");
        lines.push({ product_id: row.insertId, quantity: 0.125 });
    }
    const results = [];
    for (let round = 0; round < 3; round++) {
        const phases = [['before', oldReturn], ['after', restoreStockForCart]];
        if (round % 2) phases.reverse();
        for (const [phase, action] of phases) results.push({ round: round + 1, phase, ...await measure(action, lines) });
    }
    const [rows] = await pool.query('SELECT stock FROM products WHERE id IN (?)', [lines.map(line => line.product_id)]);
    assert.equal(rows.length, 10);
    for (const row of rows) assert.equal(Number(row.stock), 10 + 6 * 1025 * 0.125);
    const evidence = { at: new Date().toISOString(), runtime: process.version,
        cpu: require('node:os').cpus()[0].model, lines: lines.length,
        limitations: ['Stock-return transaction only, not full refund HTTP latency.',
            'Shared workstation; database CPU/RAM and low-end hardware unmeasured.',
            'RSS endpoints include retained fixtures and are not peak or incremental memory.'], results };
    fs.mkdirSync('scratch', { recursive: true });
    fs.writeFileSync('scratch/stock-return-performance.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await pool.end();
    if (created) {
        const admin = await mysql.createConnection(options);
        try { await admin.query(`DROP DATABASE \`${database}\``); }
        finally { await admin.end(); }
    }
});
