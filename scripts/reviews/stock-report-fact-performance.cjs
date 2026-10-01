// Opt-in scratch fixture. Default duty limiting remains enabled during rebuilds.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{execFileSync}=require('node:child_process');
const {randomBytes,createHash}=require('node:crypto'),assert=require('node:assert/strict');
const implementation={revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),baseline_revision:'1f67284f',
    source_hashes:Object.fromEntries(['backend/services/IngredientAnalysisService.js','backend/services/StockReportFactService.js','backend/services/StockReportGenerationService.js','backend/services/StockReportWorker.js',__filename]
        .map(file=>[path.relative(process.cwd(),path.resolve(file)).replaceAll('\\','/'),createHash('sha256').update(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n')).digest('hex')]))};
process.env.POSAPP_REVIEW_DB=`posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql=require('mysql2/promise');
const {database,...options}=require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool=require('../../backend/config/db'),analysis=require('../../backend/services/IngredientAnalysisService');
const generations=require('../../backend/services/StockReportGenerationService'),worker=require('../../backend/services/StockReportWorker');
const count=Number(process.env.STOCK_REPORT_INVOICES||1000);
if(!Number.isInteger(count)||count<1||count>100000)throw new Error('Expected 1..100000 fixture invoices');
const partitions=Number(process.env.STOCK_REPORT_PARTITIONS||32);
if(!Number.isInteger(partitions)||partitions<1||partitions>32)throw new Error('Expected 1..32 fixture partitions');
const filename=path.resolve('backend/services/IngredientAnalysisService.js');
const baseline=new Module(filename,module);baseline.filename=filename;baseline.paths=Module._nodeModulePaths(path.dirname(filename));
baseline._compile(execFileSync('git',['show','1f67284f:backend/services/IngredientAnalysisService.js'],{encoding:'utf8'}),filename);
let created=false;
async function run(){
    const admin=await mysql.createConnection(options);try{await admin.query(`CREATE DATABASE \`${database}\``);created=true;}finally{await admin.end();}
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    const [ingredient]=await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Chicken','weight','g')");
    const snapshot=JSON.stringify([{ingredient_id:ingredient.insertId,name:'Chicken',display_unit:'g',qty_per_portion:100,cost_per_portion:0.4,complete:true}]);
    let refundCount=0,includedInvoices=0,includedRefunds=0;
    for(let start=0;start<count;start+=250){
        const size=Math.min(250,count-start);
        const [insert]=await pool.query('INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES ?',
            [Array.from({length:size},()=>[1,8,0,7.01,'cash','2026-09-07 10:00:00'])]);
        const rows=[];
        for(let n=0;n<size;n++)if(generations.scopeFor('invoice',insert.insertId+n)<partitions)includedInvoices++;
        for(let n=0;n<size;n++)for(const [product,qty,price] of [[1,1,1],[2,0.5,2],[1,2,3]])rows.push([insert.insertId+n,product,'Meal',qty,price,snapshot,(start+n)%10===0?'[{"name":"extra"}]':null]);
        await pool.query('INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,recipe_cost_snapshot,selected_modifiers) VALUES ?',[rows]);
        const [lines]=await pool.query('SELECT invoice_id,MIN(id) id FROM order_items WHERE invoice_id BETWEEN ? AND ? GROUP BY invoice_id',[insert.insertId,insert.insertId+size-1]);
        for(const line of lines.filter((_,n)=>(start+n)%10===0)){
            const [refund]=await pool.query("INSERT INTO refunds(kind,invoice_id,scope,subtotal_refunded,tax_refunded,amount_refunded,refund_method,user_id,created_at) VALUES ('refund',?,'item',0.88,0,0.88,'cash',1,'2026-09-08 10:00:00')",[line.invoice_id]);
            await pool.query("INSERT INTO refund_items(refund_id,order_item_id,product_id,item_name,quantity,unit_price,line_subtotal,line_tax,line_total) VALUES (?,?,1,'Meal',1,1,1,0,1)",[refund.insertId,line.id]);refundCount++;
            if(generations.scopeFor('invoice',line.invoice_id)<partitions)includedRefunds++;
        }
        if((start+size)%10000===0)console.log(JSON.stringify({seeded_invoices:start+size,of:count}));
    }
    const period={startDate:'2026-09-07',endDate:'2026-09-08'};
    const references=[];let reference;
    for(const [label,service] of [['before',baseline.exports],['current',analysis]]){
        let queries=0;const cpu=process.cpuUsage(),start=performance.now();
        const result=await service.getAnalysis({query(...args){queries++;return pool.query(...args);}},period);
        const used=process.cpuUsage(cpu);references.push({label,elapsed_ms:performance.now()-start,node_cpu_ms:(used.user+used.system)/1000,queries,totals:result.totals});
        reference=result;assert.equal(result.totals.net_revenue,Math.round((count*7.01-refundCount*0.88)*100)/100);
        console.log(JSON.stringify({reference:label,elapsed_ms:references.at(-1).elapsed_ms}));
    }
    // The older reference has a measured sub-micro-unit floating sum drift.
    // Compare other coverage/revenue fields exactly and assert the corrected
    // current cost against this fixture's independently worked total.
    assert.deepEqual({...references[0].totals,known_cost:null},{...references[1].totals,known_cost:null});
    assert.equal(reference.totals.known_cost,(count*14-refundCount*4)/10);
    await generations.markDirty(pool,['2026-09-07','2026-09-08'].flatMap(day=>Array.from({length:partitions},(_,scope_id)=>({day,scope_id}))));
    let queries=0,peakRss=process.memoryUsage().rss,peakHeap=process.memoryUsage().heapUsed,maxSourceRows=0,maxSourceBytes=0;
    const statements=new Map(),queryTimings={};
    async function timed(query,sql,args){
        const group=/INSERT INTO stock_report_/.test(sql)?'fact_write':/SELECT o\.\*/.test(sql)?'sales_source':/SELECT r\.\*/.test(sql)?'refund_source':/FROM order_items/.test(sql)?'invoice_lines':'other';
        const metric=queryTimings[group]||(queryTimings[group]={count:0,total_ms:0,max_ms:0});
        const started=performance.now();
        try{return await query(sql,args);}finally{const elapsed=performance.now()-started;metric.count++;metric.total_ms+=elapsed;metric.max_ms=Math.max(metric.max_ms,elapsed);}
    }
    const measured={async getConnection(){
        const conn=await pool.getConnection();
        return {beginTransaction:()=>conn.beginTransaction(),commit:()=>conn.commit(),rollback:()=>conn.rollback(),release:()=>conn.release(),
            query:(sql,args)=>timed((...values)=>conn.query(...values),sql,args)};
    },async query(sql,args){
        queries++;const result=await timed((...values)=>pool.query(...values),sql,args);
        if(/SELECT o\.\*|SELECT r\.\*|SELECT \* FROM order_items/.test(sql)){
            maxSourceRows=Math.max(maxSourceRows,result[0].length);maxSourceBytes=Math.max(maxSourceBytes,Buffer.byteLength(JSON.stringify(result[0])));
        }
        const key=/SELECT o\.\*/.test(sql)?'sales':/SELECT r\.\*/.test(sql)?'refunds':/SELECT \* FROM order_items/.test(sql)?'invoice_lines':sql.includes("WHERE m.movement_type='ingredient' AND m.business_date")?'ingredients':sql.includes('FROM stock_movements m JOIN stock_operations')?'stock':null;
        if(key&&!statements.has(key))statements.set(key,{sql,args});return result;
    }};
    const builds=[],cpu=process.cpuUsage(),started=performance.now();
    while(true){
        const result=await worker.runOne(measured,{waitFor:async ms=>{
            peakRss=Math.max(peakRss,process.memoryUsage().rss);peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);
            await new Promise(resolve=>setTimeout(resolve,ms));
        }});
        if(result.status==='idle')break;assert.equal(result.status,'published');builds.push(result);
        if(builds.length%4===0)console.log(JSON.stringify({completed_partitions:builds.length,of:partitions*2}));
    }
    const used=process.cpuUsage(cpu),elapsed=performance.now()-started;
    const [[totals]]=await pool.query(`SELECT SUM(m.net_revenue_cents) cents,SUM(m.known_cost) cost,SUM(m.sold) sold,SUM(m.refunded) refunded,
        SUM(m.incomplete_lines) incomplete FROM stock_report_dirty d JOIN stock_report_meals m ON m.build_id=d.published_build_id WHERE d.day BETWEEN ? AND ?`,[period.startDate,period.endDate]);
    const expected={cents:includedInvoices*701-includedRefunds*88,cost:(includedInvoices*14-includedRefunds*4)/10};
    assert.equal(Number(totals.cents),expected.cents);
    const costDifference=Number(totals.cost)-(partitions===32?reference.totals.known_cost:expected.cost);
    assert.equal(costDifference,0);
    const plans={};for(const [key,statement]of statements)plans[key]=(await pool.query('EXPLAIN '+statement.sql,statement.args))[0];
    const [[server]]=await pool.query('SELECT VERSION() version');
    const os=require('node:os');
    const evidence={at:new Date().toISOString(),implementation,runtime:process.version,cpu:os.cpus()[0].model,logical_cpus:os.cpus().length,system_memory_gib:os.totalmem()/2**30,database_version:server.version,invoices:count,invoice_lines:count*3,refunds:refundCount,partitions,includedInvoices,includedRefunds,expected,
        references,rebuild:{elapsed_ms:elapsed,node_cpu_ms:(used.user+used.system)/1000,source_and_metadata_pool_queries:queries,max_source_rows:maxSourceRows,max_source_payload_bytes:maxSourceBytes,
            sampled_peak_rss_mib:peakRss/2**20,sampled_peak_heap_mib:peakHeap/2**20,builds,totals,cost_difference_from_reference:costDifference,query_timings:queryTimings},plans,
        limitations:['One workstation run, not latency percentiles or 2-CPU/4-GiB certification.','Source writers are not wired; fixture marks all scopes explicitly.','Two business days; no million-movement, split or concurrent-writer dataset.','Node CPU excludes DB; memory samples include fixture retention and miss between-yield peaks.','Query count excludes metadata/fact transactions that acquire a connection directly.','Financial source retains up to 16 invoices; unusually large invoices still need measurement.']};
    fs.mkdirSync('scratch',{recursive:true});fs.writeFileSync(`scratch/stock-report-facts-${count}${partitions===32?'':`-${partitions}-partitions`}.json`,JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({invoices:count,elapsed_ms:elapsed,costDifference,max_work_ms:Math.max(...builds.map(b=>b.max_work_ms)),queries,maxSourceRows,maxSourceBytes}));
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    await pool.end();if(created){const admin=await mysql.createConnection(options);try{await admin.query(`DROP DATABASE \`${database}\``);}finally{await admin.end();}}
});
