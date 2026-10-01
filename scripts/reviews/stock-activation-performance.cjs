// One-time activation and preflight costs; never uses the application's DB.
const fs = require('node:fs');
const { randomBytes, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const service = require('../../backend/services/StockActivationService');
let created = false;
async function measure(label, samples, action) {
    for (let i = 0; i < 5; i++) await action();
    const times = [], cpu = process.cpuUsage(), rss = process.memoryUsage().rss;
    for (let i = 0; i < samples; i++) {
        const start = performance.now(); await action(); times.push(performance.now() - start);
    }
    const used = process.cpuUsage(cpu); times.sort((a,b) => a-b);
    return { label, samples, p50_ms: times[Math.ceil(samples*.5)-1], p95_ms: times[Math.ceil(samples*.95)-1],
        node_cpu_ms_per_call: (used.user+used.system)/1000/samples,
        node_rss_before_mib: rss/2**20, node_rss_after_mib: process.memoryUsage().rss/2**20 };
}
async function run() {
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; } finally { await admin.end(); }
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
    await pool.query('UPDATE products SET stock=10 WHERE id=1');
    const results = [];
    for (const holds of [0, 100, 1000, 10000]) {
        await pool.query('DELETE FROM held_orders');
        // The worst case scans every hold: target product is absent. Each hold
        // contains 20 realistic line objects, rather than a tiny synthetic ID.
        const cart = JSON.stringify({ items: Array.from({length:20}, (_,i) => ({ id: i+100, name:`Held product ${i}`, qty:2, price:3.5, tax_rate:16, modifiers:[] })) });
        for (let i=0; i<holds; i+=500) {
            await pool.query('INSERT INTO held_orders(user_id,reference_name,cart_data) VALUES ?',
                [Array.from({length:Math.min(500,holds-i)}, (_,j) => [1,`Hold ${i+j}`,cart])]);
        }
        results.push({ holds, bytes_per_cart: Buffer.byteLength(cart), ...await measure('preflight, absent target', holds===10000 ? 25 : 100, async()=>{
            const state = await service.inspect(pool,1); assert.equal(state.can_activate,true);
        }) });
    }
    await pool.query('DELETE FROM held_orders');
    const products = Array.from({length:105},(_,i)=>[`Activation ${i}`,1,10]);
    const [inserted] = await pool.query('INSERT INTO products(name,price,stock) VALUES ?', [products]);
    let id = inserted.insertId;
    results.push(await measure('activation, committed known balance',100,async()=>{
        const conn = await pool.getConnection();
        try {
            await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await conn.beginTransaction();
            const result=await service.activate(conn,id++,{expected_stock_version:'0',request_key:randomUUID()},1,'127.0.0.1');
            assert.equal(result.stock,'10.000000'); await conn.commit();
        } catch(error) { await conn.rollback(); throw error; } finally { conn.release(); }
    }));
    const [[count]] = await pool.query('SELECT COUNT(*) AS n FROM stock_movements'); assert.equal(count.n,105);
    const evidence = { at:new Date().toISOString(),runtime:process.version,cpu:require('node:os').cpus()[0].model,
        limitations:['One-time activation service, not checkout or HTTP.','Workstation, not constrained low-end hardware.','Node CPU excludes database work; RSS endpoints include fixture retention and are not peak or incremental memory.','Large held-order backlog deliberately measured; current preflight has a JSON scan.'],results };
    fs.mkdirSync('scratch',{recursive:true}); fs.writeFileSync('scratch/stock-activation-performance.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    await pool.end();
    if(created) {const admin=await mysql.createConnection(options);try{await admin.query(`DROP DATABASE \`${database}\``);}finally{await admin.end();}}
});
