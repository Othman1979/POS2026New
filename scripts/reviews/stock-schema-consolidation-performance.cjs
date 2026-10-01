// Run alone. Each implementation uses its matching schema in a generated loopback DB.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const baseline = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11);
if (!baseline || !/^[a-f0-9]{40}$/.test(baseline)) throw new Error('Pass the exact pre-consolidation commit as --baseline=<40 hex>.');
const historical = new Map();
function loadHistorical(name) {
    if (historical.has(name)) return historical.get(name).exports;
    const filename = path.resolve(`backend/services/${name}.js`);
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    historical.set(name, loaded);
    loaded.require = request => ['StockIngredientAdapter', 'StockLedgerService'].some(n => request === `./${n}`)
        ? loadHistorical(request.slice(2)) : Module.prototype.require.call(loaded, request);
    loaded._compile(execFileSync('git', ['show', `${baseline}:backend/services/${name}.js`], { encoding: 'utf8' }), filename);
    return loaded.exports;
}
async function transaction(action) {
    const conn = await pool.getConnection();
    let queries = 0;
    try {
        await conn.beginTransaction();
        const value = await action({ query: (...args) => { queries++; return conn.query(...args); } });
        await conn.commit();
        return { value, queries };
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
}
async function measure(name, action) {
    const times = [], queries = new Set();
    for (let i = 0; i < 10; i++) await action();
    for (let i = 0; i < 100; i++) {
        const start = performance.now();
        queries.add((await action()).queries);
        times.push(performance.now() - start);
    }
    times.sort((a,b) => a-b);
    return { name, samples:100, queries:[...queries], p50_ms:times[49], p95_ms:times[94] };
}
async function runVariant(label) {
    const old = label === 'baseline';
    await require('../../backend/tests/fixtures/seed').seedDatabase({ legacyStockSchema: old });
    const ledger = old ? loadHistorical('StockLedgerService') : require('../../backend/services/StockLedgerService');
    const recipe = old ? loadHistorical('RecipeLedgerService') : require('../../backend/services/RecipeLedgerService');
    await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ?", [Array.from({length:100}, (_,i) => [`Benchmark ${i}`,'count','unit','active'])]);
    const [items] = await pool.query('SELECT id FROM stock_items ORDER BY id');
    let keys = items.map(row => ({stock_item_id:row.id}));
    if (old) {
        await pool.query("INSERT INTO stock_lots(stock_item_id,lot_code,is_default) VALUES ?", [items.map(row => [row.id,'default',1])]);
        const [lots] = await pool.query('SELECT id,stock_item_id FROM stock_lots ORDER BY stock_item_id');
        const [[location]] = await pool.query("SELECT id FROM stock_locations WHERE code='default'");
        keys = lots.map(row => ({stock_item_id:row.stock_item_id,location_id:location.id,lot_id:row.id}));
    }
    const day = '2026-09-12';
    await transaction(conn => ledger.post(conn, {kind:'opening',request_key:randomUUID(),business_date:day,
        lines:keys.map(key => ({...key,quantity:'1000',expected_version:'0'}))}, 1));
    await pool.query('INSERT INTO ingredients(name,measure,display_unit) VALUES ?', [Array.from({length:100}, (_,i) => [`Benchmark ingredient ${i}`,'count','unit'])]);
    const [ingredients] = await pool.query('SELECT id FROM ingredients ORDER BY id');
    const entries = ingredients.map(row => ({ingredient_id:row.id,qty:0,unit:'unit'}));
    const batch = (kind,qty) => transaction(conn => recipe.recordStockBatch(conn, {kind,entries:entries.map(row => ({...row,qty})),clientKey:randomUUID(),actor:{id:1},businessDate:day}));
    await batch('count',0);
    const results = [];
    results.push(await measure('100 physical items issued atomically', () => transaction(conn => ledger.post(conn,
        {kind:'issue',request_key:randomUUID(),business_date:day,lines:keys.map(key => ({...key,quantity:'-1'}))},1))));
    results.push(await measure('100 ingredient receipt lines atomically', () => batch('receipt',1)));
    results.push(await measure('50 ingredient picker rows', () => transaction(conn => recipe.listIngredientPage(conn,{view:'picker'}))));
    const [[physical]] = await pool.query('SELECT MIN(quantity) min_qty,MAX(quantity) max_qty FROM stock_balances');
    assert.equal(Number(physical.min_qty),890); assert.equal(Number(physical.max_qty),890);
    const [[working]] = await pool.query(old ? 'SELECT MIN(quantity) min_qty,MAX(quantity) max_qty FROM ingredient_working_balances'
        : 'SELECT MIN(working_quantity) min_qty,MAX(working_quantity) max_qty FROM ingredients');
    assert.equal(Number(working.min_qty),110); assert.equal(Number(working.max_qty),110);
    return { label, results, balances_verified:true };
}
let created = false;
(async () => {
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; }
    finally { await admin.end(); }
    const results = [];
    // Reverse the second pair to expose simple warm-up/order bias.
    for (const label of ['baseline','current','current','baseline']) results.push(await runVariant(label));
    const evidence = {baseline,runtime:process.version,cpu:require('node:os').cpus()[0].model,results,
        limitations:['Service transactions on loopback MariaDB, not full HTTP checkout or Hostinger.','Shared workstation timings; query counts and verified balances are stronger evidence than latency differences.','Historical adapters/ledger/recipe source uses matching old schema; unchanged report dependencies use current code.']};
    fs.writeFileSync('scratch/stock-schema-consolidation-performance.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));
})().catch(error => { console.error(error); process.exitCode=1; }).finally(async () => {
    await pool.end();
    if (created) { const admin=await mysql.createConnection(options); try { await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); } }
});
