// Opt-in planning benchmark. Creates and drops only its own guarded loopback DB.
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { getTestDatabaseOptions } = require('../../backend/tests/testDatabase.cjs');
const { database, ...options } = getTestDatabaseOptions();
const L = require('../../backend/services/RecipeLedgerService');
const A = require('../../backend/services/IngredientAnalysisService');
const I = require('../../backend/services/InventoryService');
const pool = require('../../backend/config/db');
const evidence = { at: new Date().toISOString(), runtime: process.version,
  hardware: { cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, memory_gib: os.totalmem()/2**30 },
  limitations: ['Local shared MySQL server; no server CPU or process memory attribution.',
    'Service calls exclude HTTP, browser, network, printing and full checkout.',
    'Warm sequential timings; 12 samples make p95 effectively the maximum. No p99 claim.',
    'RSS is the benchmark Node process including retained fixture/driver memory; not production incremental memory.',
    'ID-limited balance query is a read-only prototype using existing indexes; it does not include daily summary fields.'], workloads: [] };
let created = false;
async function bulk(sql, rows) {
  for (let n=0;n<rows.length;n+=1000) await pool.query(sql,[rows.slice(n,n+1000)]);
}
async function measure(name, fn, check) {
  await fn(pool); // warmup
  let queries=0, rss=process.memoryUsage().rss, maxHeap=process.memoryUsage().heapUsed;
  const meter={query:(...args)=>{queries++;return pool.query(...args);}};
  const times=[]; const cpu=process.cpuUsage(); let bytes=0;
  const timer=setInterval(()=>{rss=Math.max(rss,process.memoryUsage().rss);maxHeap=Math.max(maxHeap,process.memoryUsage().heapUsed);},10);
  try {
    for(let n=0;n<12;n++) {const start=performance.now();const result=await fn(meter);times.push(performance.now()-start);check?.(result);bytes=Buffer.byteLength(JSON.stringify(result instanceof Map ? [...result] : result));}
  } finally {clearInterval(timer);}
  const used=process.cpuUsage(cpu); times.sort((a,b)=>a-b);
  return {name,samples:times.length,p50_ms:times[5],p95_ms:times[11],mean_ms:times.reduce((a,b)=>a+b,0)/12,
    node_cpu_ms_per_call:(used.user+used.system)/12000,queries_per_call:queries/12,response_bytes:bytes,
    sampled_node_rss_mib:rss/2**20,sampled_node_heap_mib:maxHeap/2**20};
}
async function run() {
  const admin=await mysql.createConnection(options);
  try {await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;} finally{await admin.end();}
  await require('../../backend/tests/fixtures/seed').seedDatabase();
  const [[version]]=await pool.query('SELECT VERSION() version');evidence.database_version=version.version;
  // Deterministic interleaving reproduces the stale absolute-write semantics.
  await pool.query('UPDATE products SET stock=10 WHERE id=1');
  const [[seen]]=await pool.query('SELECT stock FROM products WHERE id=1');
  const tx=await pool.getConnection();
  try {await tx.beginTransaction();await I.deductStockForCart(tx,[{product_id:1,qty:1}]);await tx.commit();} finally{tx.release();}
  await pool.query('UPDATE products SET stock=? WHERE id=1',[Number(seen.stock)+5]);
  const [[lost]]=await pool.query('SELECT stock FROM products WHERE id=1');assert.equal(Number(lost.stock),15);
  await pool.query('UPDATE products SET stock=9 WHERE id=1');
  await pool.query('UPDATE products SET stock=stock+5 WHERE id=1');
  const [[atomic]]=await pool.query('SELECT stock FROM products WHERE id=1');assert.equal(Number(atomic.stock),14);
  evidence.stale_replenishment={observed:Number(lost.stock),correct:Number(atomic.stock),expected:14,note:'Existing stock service plus SQL matching product PUT semantics; atomic SQL is a prototype, not a shipped endpoint.'};
  let ingredientCount=0,invoiceCount=0;
  for(const size of [100,1000,10000]) {
    const newItems=Array.from({length:size-ingredientCount},(_,n)=>[`Bench ingredient ${String(ingredientCount+n).padStart(5,'0')}`,'weight','kg',0.004,10000]);
    await bulk('INSERT INTO ingredients(name,measure,display_unit,unit_cost,par_qty) VALUES ?',newItems);
    const [ingredients]=await pool.query("SELECT id,unit_cost FROM ingredients WHERE name LIKE 'Bench ingredient %' ORDER BY id");
    const fresh=ingredients.slice(ingredientCount);
    await bulk('INSERT INTO ingredient_movements(ingredient_id,kind,qty,unit_cost,source_type,business_date) VALUES ?',fresh.map(i=>[i.id,'count',100000,0.004,'manual','2026-09-07']));
    for(let n=0;n<20;n++) await bulk('INSERT INTO ingredient_movements(ingredient_id,kind,qty,unit_cost,purchase_priced,source_type,business_date) VALUES ?',fresh.map(i=>[i.id,n%2?'usage':'receipt',n%2?-100:1000,0.004,n%2?0:1,'manual','2026-09-07']));
    const targetInvoices=size*10;
    await bulk('INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES ?',Array.from({length:targetInvoices-invoiceCount},()=>[1,5,0,5,'cash','2026-09-07 10:00:00']));
    const [unfilled]=await pool.query("SELECT invoice_id FROM orders o WHERE created_at='2026-09-07 10:00:00' AND NOT EXISTS(SELECT 1 FROM order_items i WHERE i.invoice_id=o.invoice_id)");
    await bulk('INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,recipe_cost_snapshot) VALUES ?',unfilled.map((o,n)=>{
      const id=ingredients[n%ingredients.length].id;
      return [o.invoice_id,1,'Benchmark meal',1,5,JSON.stringify([{ingredient_id:id,name:'Benchmark ingredient',display_unit:'kg',qty_per_portion:100,cost_per_portion:0.4,complete:true}])];
    }));
    ingredientCount=size;invoiceCount=targetInvoices;
    const results=[];
    results.push(await measure('all ingredient summaries',c=>L.getIngredientSummaries(c,{businessDate:'2026-09-07'}),r=>{assert.equal(r.length,size);assert.equal(r[0].expected_remaining,109000);}));
    results.push(await measure('50 ingredient balances by IDs',async c=>{const ids=ingredients.slice(0,50).map(i=>i.id);const [rows]=await c.query(`SELECT i.id,i.name,c.qty+COALESCE((SELECT SUM(m.qty) FROM ingredient_movements m FORCE INDEX(idx_im_balance) WHERE m.ingredient_id=i.id AND m.id>c.id),0) expected_remaining FROM ingredients i LEFT JOIN ingredient_movements c ON c.id=(SELECT id FROM ingredient_movements FORCE INDEX(idx_im_ingredient_kind_id) WHERE ingredient_id=i.id AND kind='count' ORDER BY id DESC LIMIT 1) WHERE i.id IN (${ids.map(()=>'?')}) ORDER BY i.id`,ids);return rows.map(r=>({...r,expected_remaining:Number(r.expected_remaining)}));},r=>{assert.equal(r.length,50);assert.equal(r[0].expected_remaining,109000);}));
    results.push(await measure('purchase costs for 20 ingredients',c=>L.resolveIngredientCosts(c,ingredients.slice(0,20),'2026-09-07'),r=>assert.equal(r.size,20)));
    results.push(await measure('whole-period sales analysis',c=>A.getAnalysis(c,{startDate:'2026-09-07',endDate:'2026-09-07'}),r=>{assert.equal(r.totals.net_revenue,targetInvoices*5);assert.ok(Math.abs(r.totals.known_cost-targetInvoices*0.4)<0.01);}));
    evidence.workloads.push({ingredients:size,movements:size*21,invoices:targetInvoices,results});
    fs.mkdirSync('scratch',{recursive:true});fs.writeFileSync('scratch/inventory-advancement-benchmark.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence.workloads.at(-1)));
  }
  const [[storage]]=await pool.query('SELECT SUM(data_length) data_bytes,SUM(index_length) index_bytes FROM information_schema.tables WHERE table_schema=?',[database]);
  evidence.fixture_storage=storage;
  fs.writeFileSync('scratch/inventory-advancement-benchmark.json',JSON.stringify(evidence,null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  await pool.end();
  if(created){const c=await mysql.createConnection(options);try{await c.query(`DROP DATABASE \`${database}\``);}finally{await c.end();}}
});
