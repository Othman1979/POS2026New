// Published analysis read after a completed rebuild. Own guarded loopback DB only.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const os = require('node:os');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const generations = require('../../backend/services/StockReportGenerationService');
const worker = require('../../backend/services/StockReportWorker');
const reads = require('../../backend/services/StockReportReadService');
const baselineRevision = process.argv.find(arg=>arg.startsWith('--baseline='))?.slice(11);
let baselineReads;
if (baselineRevision) {
    if (!/^[a-f0-9]{7,40}$/.test(baselineRevision)) throw new Error('Baseline must be an exact commit hash.');
    const {execFileSync}=require('node:child_process');
    const Module=require('node:module');
    const filename=require.resolve('../../backend/services/StockReportReadService');
    const baseline=new Module(filename,module);
    baseline.filename=filename;baseline.paths=module.paths;
    baseline._compile(execFileSync('git',['show',`${baselineRevision}:backend/services/StockReportReadService.js`],{encoding:'utf8'}),filename);
    baselineReads=baseline.exports;
}
const live = require('../../backend/services/IngredientAnalysisService');
const { getBusinessDate } = require('../../backend/utils/businessDate');
let created = false;

async function bulk(sql, rows) {
    for (let n = 0; n < rows.length; n += 500) await pool.query(sql, [rows.slice(n, n + 500)]);
}

async function run() {
    const day = getBusinessDate();
    const invoices = 1000;
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; } finally { await admin.end(); }
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    await bulk(
        'INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES ?',
        Array.from({ length: invoices }, () => [1, 5, 0, 5, 'cash', `${day} 10:00:00`])
    );
    const [orders] = await pool.query('SELECT invoice_id FROM orders WHERE created_at=? ORDER BY invoice_id', [`${day} 10:00:00`]);
    await bulk(
        'INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale) VALUES ?',
        orders.map(order => [order.invoice_id, 1, 'Benchmark meal', 1, 5])
    );
    const coverage = await generations.ensureCoverage(pool, { startDate: day, endDate: day });
    const rebuilt = await worker.drain(pool);
    const period = { startDate: day, endDate: day };
    const liveReport = await live.getAnalysis(pool, period);
    if (baselineReads) {
        const {monitorEventLoopDelay}=require('node:perf_hooks');
        const runs=[];
        for(let repetition=0;repetition<3;repetition++) {
            // Alternate order to reduce warm-cache/order bias. Source data and
            // fact publications are identical for both readers; no worker runs.
            const variants=repetition%2 ? [['current',reads],['baseline',baselineReads]] : [['baseline',baselineReads],['current',reads]];
            for(const [variant,reader] of variants) {
                for(let n=0;n<25;n++) await reader.getPublishedAnalysis(pool,period);
                const lag=monitorEventLoopDelay({resolution:10});lag.enable();
                const cpu=process.cpuUsage(),times=[];
                let peakRss=process.memoryUsage().rss,bytes=0,queries=0;
                const connection={query(...args){queries++;return pool.query(...args);}};
                for(let n=0;n<1000;n++) {
                    const start=performance.now();
                    const page=await reader.getPublishedAnalysis(connection,period);
                    times.push(performance.now()-start);
                    assert.equal(page.totals.net_revenue,invoices*5);
                    assert.equal(page.freshness.state,'current');
                    bytes=Buffer.byteLength(JSON.stringify(page));
                    peakRss=Math.max(peakRss,process.memoryUsage().rss);
                }
                const used=process.cpuUsage(cpu);lag.disable();times.sort((a,b)=>a-b);
                runs.push({variant,repetition:repetition+1,samples:1000,p50_ms:times[499],p95_ms:times[949],p99_ms:times[989],
                    node_cpu_ms_per_call:(used.user+used.system)/1e6,node_peak_rss_bytes:peakRss,event_loop_p99_ms:lag.percentile(99)/1e6,
                    queries_per_call:queries/1000,response_bytes:bytes});
            }
        }
        const evidence={at:new Date().toISOString(),runtime:process.version,cpu:os.cpus()[0].model,baseline:baselineRevision,invoices,runs,
            limitations:['Published reader only, unchanged shared dependencies; not checkout or full-branch before/after.','Single-day, 1000 one-line invoices on this workstation; not million-movement, multi-day or low-end certification.','Node RSS is whole-process and shared across variants; database CPU/memory and concurrent writer pressure are not measured.']};
        fs.mkdirSync('scratch',{recursive:true});
        fs.writeFileSync('scratch/stock-report-read-comparison.json',JSON.stringify(evidence,null,2));
        console.log(JSON.stringify(evidence));
        return;
    }
    for (let n = 0; n < 25; n++) await reads.getPublishedAnalysis(pool, period);
    const times = [];
    const cpu = process.cpuUsage();
    let bytes = 0;
    let page = null;
    for (let n = 0; n < 100; n++) {
        const start = performance.now();
        page = await reads.getPublishedAnalysis(pool, period);
        times.push(performance.now() - start);
        bytes = Buffer.byteLength(JSON.stringify(page));
    }
    const used = process.cpuUsage(cpu);
    times.sort((a, b) => a - b);
    assert.equal(page.freshness.state, 'current');
    assert.equal(page.totals.net_revenue, invoices * 5);
    assert.equal(liveReport.totals.net_revenue, page.totals.net_revenue);
    assert.ok(page.meals.length <= 50);
    assert.ok(bytes < 250 * 1024);
    const evidence = {
        at: new Date().toISOString(),
        runtime: process.version,
        cpu: os.cpus()[0].model,
        invoices,
        coverage,
        rebuilt_scopes: Array.isArray(rebuilt) ? rebuilt.length : rebuilt,
        live_net_revenue: liveReport.totals.net_revenue,
        samples: 100,
        p50_ms: times[49],
        p95_ms: times[94],
        p99_ms: times[98],
        response_bytes: bytes,
        meals: page.meals.length,
        meals_has_more: page.meals_has_more,
        node_cpu_ms_per_call: (used.user + used.system) / 100 / 1000,
        limitations: [
            'Service read of already-published facts, not HTTP/authentication.',
            '1,000 one-line invoices on this workstation; not 100,000-invoice or 2-CPU/4-GiB certification.',
            'Node CPU excludes database CPU. RSS is not recorded here.',
            'Live getAnalysis is a one-shot reconciliation check, not the timed path.'
        ]
    };
    fs.mkdirSync('scratch', { recursive: true });
    fs.writeFileSync('scratch/stock-report-published-read-performance.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ p50_ms: evidence.p50_ms, p95_ms: evidence.p95_ms, response_bytes: bytes, meals: page.meals.length, freshness: page.freshness.state }));
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await pool.end();
    if (created) {
        const admin = await mysql.createConnection(options);
        try { await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
    }
});
