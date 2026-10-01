const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const { seedDatabase } = require('../../backend/tests/fixtures/seed');
const file = 'backend/modules/tables/saveTableOrder.js';
const revision = process.argv[2] || '38d24ecd48c625a6a607de9df668909c568aa138';
const source = execFileSync('git',['show',`${revision}:${file}`],{encoding:'utf8'});
const baseline = new Module(path.resolve(file),module);
baseline.filename=path.resolve(file);baseline.paths=Module._nodeModulePaths(path.dirname(baseline.filename));baseline._compile(source,baseline.filename);
const current = require('../../backend/modules/tables/saveTableOrder');
const results={database,revision,runs:[]};let created=false;
const scenarios = [
    { name: 'admin-first-save', user: { id: 1, role: 'admin' } },
    { name: 'cashier-first-save', user: { id: 2, role: 'cashier', permissions: ['tables.access', 'tables.save'], table_access_scope: 'selected', allowed_sections: '1' } },
];
async function measure(label,writer,scenario) {
    await seedDatabase();
    const original=pool.getConnection;
    let queries=0,returnedRows=0,leases=0,active=0,maxActive=0;
    pool.getConnection=async function(...args){
        const conn=await original.apply(this,args);leases++;active++;maxActive=Math.max(maxActive,active);
        const query=conn.query, release=conn.release;
        conn.query=async function(...args){const result=await query.apply(this,args);queries++;if(Array.isArray(result[0]))returnedRows+=result[0].length;return result;};
        conn.release=function(...args){conn.query=query;conn.release=release;active--;return release.apply(this,args);};
        return conn;
    };
    const start=performance.now();
    try {
        const saved=await writer.saveTableOrder({user:scenario.user,input:{table_id:1,cart:[{id:2,name:'Test Drink',qty:1,price:2}],subtotal:2,tax:0,total:2},io:null,printKitchenOrder:async()=>{}});
        assert(saved.invoice_id);
    }finally{pool.getConnection=original;}
    results.runs.push({label,scenario:scenario.name,queries,returnedRows,leases,maxActive,remainingLeases:active,elapsedMs:Math.round((performance.now()-start)*100)/100});
    assert.equal(active,0);
}
(async()=>{
    const owner=await mysql.createConnection(options);
    try{await owner.query(`CREATE DATABASE \`${database}\``);created=true;}finally{await owner.end();}
    for(const scenario of scenarios) {
        for(let i=0;i<3;i++){await measure('before',baseline.exports,scenario);await measure('after',current,scenario);}
        const before=results.runs.filter(row=>row.label==='before' && row.scenario===scenario.name),after=results.runs.filter(row=>row.label==='after' && row.scenario===scenario.name);
        for(let i=0;i<3;i++)for(const metric of ['queries','returnedRows','leases','maxActive','remainingLeases'])assert.equal(after[i][metric],before[i][metric],`${scenario.name}: ${metric}`);
    }
    results.complete=true;
})().catch(error=>{results.error=error.stack;process.exitCode=1;}).finally(async()=>{
    await pool.end();
    if(created){const owner=await mysql.createConnection(options);try{await owner.query(`DROP DATABASE \`${database}\``);results.removed=true;}finally{await owner.end();}}
    fs.mkdirSync('scratch/permissions-resources',{recursive:true});fs.writeFileSync('scratch/permissions-resources/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
});
