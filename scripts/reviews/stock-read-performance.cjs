// Bounded stock page benchmark in a newly created, disposable loopback DB.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
process.env.POSAPP_REVIEW_DB=`posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql=require('mysql2/promise');
const {database,...options}=require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool=require('../../backend/config/db');
const reads=require('../../backend/services/StockReadService');
let created=false;
async function run(){
    const admin=await mysql.createConnection(options);
    try{await admin.query(`CREATE DATABASE \`${database}\``);created=true;}finally{await admin.end();}
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    for(let start=0;start<10000;start+=500){
        await pool.query('INSERT INTO stock_items(name,measure,base_unit,tracking_state,is_active) VALUES ?',
            [Array.from({length:500},(_,n)=>[`Stock ${String(start+n).padStart(5,'0')}`,'count','unit','active',start+n>=9000?0:1])]);
    }
    await pool.query("INSERT INTO stock_balances(stock_item_id,quantity,quantity_known) SELECT id,12.345678,1 FROM stock_items");
    await pool.query("UPDATE stock_items SET barcode=CONCAT('BC',LPAD(id,8,'0'))");
    await pool.query(`UPDATE stock_items s LEFT JOIN (
            SELECT stock_item_id, MIN(quantity_known) AS quantity_known, MIN(quantity) AS min_qty
            FROM stock_balances GROUP BY stock_item_id
        ) b ON b.stock_item_id=s.id
        SET s.attention=CASE
            WHEN s.is_active=0 OR s.tracking_state<>'active' THEN 'inactive'
            WHEN b.stock_item_id IS NULL OR b.quantity_known=0 THEN 'unknown'
            WHEN b.min_qty<0 THEN 'negative'
            ELSE 'ok' END`);
    const [[barcodeRow]]=await pool.query("SELECT barcode FROM stock_items WHERE name='Stock 00050' LIMIT 1");
    const first=await reads.list(pool,{q:'Stock 080',limit:'50'});
    const workloads=[{}, {q:'Stock 080'}, {q:'Stock 080',cursor:first.next_cursor}, {status:'inactive'},
        {status:'all',kind:'all'}, {q:barcodeRow.barcode}, {attention:'ok'}];
    const results=[];
    for(const query of workloads){
        const statements=[];
        await reads.list({query(sql,args){statements.push({sql,args});return pool.query(sql,args);}},query);
        const plans=[];
        for(const statement of statements) plans.push((await pool.query('EXPLAIN '+statement.sql,statement.args))[0]);
        for(let n=0;n<25;n++) await reads.list(pool,query);
        const times=[],cpu=process.cpuUsage(),rss=process.memoryUsage().rss;
        let bytes=0;
        for(let n=0;n<1000;n++){
            const start=performance.now(),page=await reads.list(pool,query);
            times.push(performance.now()-start);bytes=Buffer.byteLength(JSON.stringify(page));
            assert(page.items.length<=50);assert(bytes<100*1024);
        }
        const used=process.cpuUsage(cpu);times.sort((a,b)=>a-b);
        results.push({query,samples:1000,p50_ms:times[499],p95_ms:times[949],p99_ms:times[989],response_bytes:bytes,
            node_cpu_ms_per_call:(used.user+used.system)/1000/1000,node_rss_before_mib:rss/2**20,node_rss_after_mib:process.memoryUsage().rss/2**20,plans});
    }
    const evidence={at:new Date().toISOString(),runtime:process.version,cpu:require('node:os').cpus()[0].model,items:10000,balances:10000,
        limitations:['Service queries, not HTTP/authentication.','No movement history is read or seeded in this workload except the attention backfill.','Workstation measurements do not certify the 2-CPU/4-GiB deployment gate.','Node CPU excludes DB cost. RSS endpoints include fixture retention; not peak or incremental memory.','Sparse-location and high-lot workloads remain unverified; EXPLAIN plans document this workload only.'],results};
    fs.mkdirSync('scratch',{recursive:true});fs.writeFileSync('scratch/stock-read-performance.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(results.map(({plans,...result})=>result)));
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    await pool.end();if(created){const admin=await mysql.createConnection(options);try{await admin.query(`DROP DATABASE \`${database}\``);}finally{await admin.end();}}
});
