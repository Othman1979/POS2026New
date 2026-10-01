// Synthetic source-transaction overhead. Does not certify checkout/report speed.
const fs=require('node:fs'),{randomBytes}=require('node:crypto');
process.env.POSAPP_REVIEW_DB=`posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql=require('mysql2/promise');
const {database,...options}=require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool=require('../../backend/config/db');
const reports=require('../../backend/services/StockReportGenerationService');
let created=false,serial=0;
async function source(mark,hot){
    const id=String(++serial),conn=await pool.getConnection(),start=performance.now();
    try{
        await conn.beginTransaction();
        await conn.query("INSERT INTO stock_operations(request_key,payload_hash,kind) VALUES (?,REPEAT('a',64),'receipt')",[`probe-${id}`]);
        if(mark) await reports.markDirty(conn,[{day:'2026-09-08',scope_id:hot?0:reports.scopeFor('invoice',id)}]);
        await conn.commit();
        return performance.now()-start;
    }catch(error){await conn.rollback();throw error;}finally{conn.release();}
}
async function run(){
    const admin=await mysql.createConnection(options);
    try{await admin.query(`CREATE DATABASE \`${database}\``);created=true;}finally{await admin.end();}
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    const results=[];
    for(let round=1;round<=3;round++){
        // Alternate order to reduce one-direction warmup bias.
        const variants=round%2?[false,true]:[true,false];
        for(const concurrency of [1,10]) for(const mark of variants){
            for(let n=0;n<25;n++) await source(mark,false);
            const cpu=process.cpuUsage(),start=performance.now(),samples=[];
            await Promise.all(Array.from({length:concurrency},async()=>{
                for(let n=0;n<1000/concurrency;n++) samples.push(await source(mark,false));
            }));
            const elapsed=performance.now()-start,used=process.cpuUsage(cpu);samples.sort((a,b)=>a-b);
            results.push({round,concurrency,mark,samples:samples.length,p50_ms:samples[499],p95_ms:samples[949],p99_ms:samples[989],
                transactions_per_second:1000/(elapsed/1000),node_cpu_ms_per_transaction:(used.user+used.system)/1e6});
        }
    }
    const cpu=process.cpuUsage(),start=performance.now(),hot=[];
    await Promise.all(Array.from({length:10},async()=>{for(let n=0;n<100;n++)hot.push(await source(true,true));}));
    const used=process.cpuUsage(cpu);hot.sort((a,b)=>a-b);
    results.push({round:'hot-partition',concurrency:10,mark:true,samples:1000,p50_ms:hot[499],p95_ms:hot[949],p99_ms:hot[989],
        transactions_per_second:1000/((performance.now()-start)/1000),node_cpu_ms_per_transaction:(used.user+used.system)/1e6});
    const evidence={at:new Date().toISOString(),runtime:process.version,cpu:require('node:os').cpus()[0].model,
        limitations:['Synthetic operation INSERT/COMMIT plus optional dirty marker, not actual checkout.','Latency begins after pool acquisition.','No facts or report worker workload.','Node CPU excludes database resources; no memory saving claim.','Workstation, not 2-CPU/4-GiB certification.'],results};
    fs.mkdirSync('scratch',{recursive:true});fs.writeFileSync('scratch/stock-report-generation-performance.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(results));
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    await pool.end();if(created){const admin=await mysql.createConnection(options);try{await admin.query(`DROP DATABASE \`${database}\``);}finally{await admin.end();}}
});
