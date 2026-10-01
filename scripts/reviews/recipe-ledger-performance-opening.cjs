// Reuse only the scratch DB created by recipe-ledger-performance-review.cjs.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const file = path.join(__dirname,process.env.POSAPP_PERFORMANCE_OUTPUT || 'recipe-ledger-performance-results.json');
const results = JSON.parse(fs.readFileSync(file,'utf8'));
assert.match(process.env.POSAPP_REVIEW_DB || '',/^posapp_review_recipe_p1_[a-f0-9]{12}$/);
assert.equal(process.env.DB_NAME,results.database);
const pool = require('../../backend/config/db');
const L = require('../../backend/services/RecipeLedgerService');
(async () => {
    const [ingredients] = await pool.query("SELECT id FROM ingredients WHERE name LIKE 'Scale %' ORDER BY id");
    results.openingCounts=[];
    try {
        for (const count of [1,10,100]) {
            const conn=await pool.getConnection();
            const commands=[];
            await conn.beginTransaction();
            const start=performance.now();
            try {
                const result=await L.recordOpeningCounts({query:async(sql,...args)=>{
                    commands.push(String(sql).replace(/\s+/g,' ').trim()); return conn.query(sql,...args);
                }},{entries:ingredients.slice(0,count).map(row=>({ingredientId:row.id,qty:9000,unit:'g'})),
                    clientKey:require('crypto').randomUUID(),businessDate:'2026-09-06'});
                assert.equal(result.movements.length,count);
                results.openingCounts.push({ingredients:count,serviceQueries:commands.length,ms:+(performance.now()-start).toFixed(2),sql:commands});
            } finally {await conn.rollback();conn.release();}
        }
    } finally {await pool.end();}
    fs.writeFileSync(file,JSON.stringify(results,null,2)+'\n');
    console.log(JSON.stringify(results.openingCounts.map(({sql,...rest})=>rest)));
})().catch(error=>{console.error(error);process.exitCode=1;});
