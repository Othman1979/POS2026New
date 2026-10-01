// Opt-in, loopback-only comparison of the report's sparse invoice-line lookup.
const fs=require('node:fs'),{randomBytes}=require('node:crypto'),assert=require('node:assert/strict');
process.env.POSAPP_REVIEW_DB=`posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql=require('mysql2/promise');
const {database,...options}=require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool=require('../../backend/config/db');
const {scopeFor}=require('../../backend/services/StockReportGenerationService');
let created=false;
async function run(){
    const admin=await mysql.createConnection(options);
    try{await admin.query(`CREATE DATABASE \`${database}\``);created=true;}finally{await admin.end();}
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    const invoiceIds=[];
    const snapshot=JSON.stringify([{ingredient_id:1,name:'Chicken',display_unit:'g',qty_per_portion:100,cost_per_portion:0.4,complete:true}]);
    for(let start=0;start<100000;start+=250){
        const [insert]=await pool.query('INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES ?',
            [Array.from({length:250},()=>[1,8,0,7.01,'cash','2026-09-07 10:00:00'])]);
        const lines=[];
        for(let n=0;n<250;n++){
            const id=insert.insertId+n;if(scopeFor('invoice',id)===0)invoiceIds.push(id);
            for(const [product,qty,price]of [[1,1,1],[2,0.5,2],[1,2,3]])lines.push([id,product,'Meal',qty,price,snapshot]);
        }
        await pool.query('INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,recipe_cost_snapshot) VALUES ?',[lines]);
    }
    const results=[];
    for(const hint of ['', 'FORCE INDEX (idx_order_items_invoice)', 'FORCE INDEX (idx_order_items_parent_invoice)']){
        const times=[],plans=[];let sourceRows=0;const cpu=process.cpuUsage();
        for(const offset of [0,750,1500,2250,3000]){
            const ids=invoiceIds.slice(offset,offset+16);
            const sql=`SELECT * FROM order_items ${hint} WHERE invoice_id IN (${ids.map(()=>'?').join(',')}) AND parent_item_id IS NULL ORDER BY invoice_id,id`;
            plans.push({offset,explain:(await pool.query('EXPLAIN '+sql,ids))[0],actual:(await pool.query('ANALYZE FORMAT=JSON '+sql,ids))[0]});
            let expected;
            for(let repeat=0;repeat<20;repeat++){
                const started=performance.now();const [rows]=await pool.query(sql,ids);times.push(performance.now()-started);
                assert.equal(rows.length,48);sourceRows+=rows.length;
                const identities=rows.map(row=>row.id);if(expected)assert.deepEqual(identities,expected);else expected=identities;
            }
        }
        times.sort((a,b)=>a-b);const used=process.cpuUsage(cpu);
        results.push({hint:hint||'optimizer',samples:times.length,p50_ms:times[Math.floor(times.length*.5)],p95_ms:times[Math.floor(times.length*.95)],max_ms:times.at(-1),node_cpu_ms:(used.user+used.system)/1000,sourceRows,plans});
    }
    const evidence={at:new Date().toISOString(),runtime:process.version,invoices:100000,lines:300000,results,
        limitations:['Single workstation; Node CPU excludes database CPU.','Warm sparse lookup only; not complete worker, concurrent load or low-end certification.']};
    fs.mkdirSync('scratch',{recursive:true});fs.writeFileSync('scratch/stock-report-line-query.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(results.map(({plans,...summary})=>summary),null,2));
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    await pool.end();if(created){const admin=await mysql.createConnection(options);try{await admin.query(`DROP DATABASE \`${database}\``);}finally{await admin.end();}}
});
