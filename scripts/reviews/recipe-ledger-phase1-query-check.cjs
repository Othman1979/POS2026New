const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const name = process.env.POSAPP_REVIEW_DB;
assert.match(name || '', /^posapp_review_recipe_p1_[a-f0-9]{12}$/);
assert.equal(process.env.DB_NAME, name);
async function main() {
    const admin=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD});
    await admin.query('CREATE DATABASE '+name+' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
    await admin.end();
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    const pool=require('../../backend/config/db');
    const L=require('../../backend/services/RecipeLedgerService');
    try {
        const [insert]=await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Query check','weight','g')");
        const id=insert.insertId;
        const values=Array.from({length:20000},(_,i)=>[id,i===0?'count':'usage',i===0?100000:-1,'manual','2026-09-01']);
        for(let i=0;i<values.length;i+=500)await pool.query('INSERT INTO ingredient_movements(ingredient_id,kind,qty,source_type,business_date) VALUES ?',[values.slice(i,i+500)]);
        await pool.query("INSERT INTO ingredient_movements(ingredient_id,kind,qty,source_type,business_date) VALUES (?,'count',100,'manual','2026-09-06'),(?,'receipt',10,'manual','2026-09-06')",[id,id]);
        const counts=[];
        const start=performance.now();
        const history=await L.listMovements({query:async(...a)=>{
            const result=await pool.query(...a);counts.push(result[0].length);return result;
        }},{ingredientId:id,limit:2});
        const elapsed=performance.now()-start;
        assert.deepEqual(history.rows.map(r=>r.running_balance),[110,100]);
        assert(counts.reduce((a,b)=>a+b,0)<=10);
        let statement;
        const summaries=await L.getIngredientSummaries({query:async(...a)=>{statement=a;return pool.query(...a);}},{businessDate:'2026-09-06'});
        assert.equal(summaries[0].expected_remaining,110);
        const [explain]=await pool.query('EXPLAIN '+statement[0],statement[1]);
        const [[analyze]]=await pool.query('ANALYZE FORMAT=JSON '+statement[0],statement[1]);
        const result={
            sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
            database:name, history:{queryRows:counts,totalFetched:counts.reduce((a,b)=>a+b,0),elapsedMs:+elapsed.toFixed(2)},
            summaryExpected:summaries[0].expected_remaining,explain,analyze:JSON.parse(analyze.ANALYZE),
        };
        fs.writeFileSync(path.join(__dirname,'recipe-ledger-phase1-query-results.json'),JSON.stringify(result,null,2)+'\n');
        console.log(JSON.stringify({history:result.history,explain,analyze:result.analyze}));
    } finally {await pool.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
