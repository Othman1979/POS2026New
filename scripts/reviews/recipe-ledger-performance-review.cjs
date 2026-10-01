// Review-only measurements. Run with the Phase 1 scratch database preload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const request = require('supertest');
const { performance } = require('node:perf_hooks');
const name = process.env.POSAPP_REVIEW_DB;
assert.match(name || '', /^posapp_review_recipe_p1_[a-f0-9]{12}$/);
assert.equal(process.env.DB_NAME, name);
const normalize = sql => String(sql).replace(/\s+/g, ' ').trim();
const results = { database: name, scenarios: [], reads: [], contention: [] };
let pool, L, app, SEED, cookie, shiftId;

async function capture(operation) {
    const commands = [], originalGet = pool.getConnection, originalQuery = pool.query;
    let leases = 0, released = 0;
    const add = (kind, sql, result, elapsed) => commands.push({ kind, sql: normalize(sql), rows: Array.isArray(result?.[0]) ? result[0].length : null, ms: +elapsed.toFixed(3) });
    pool.query = async function(sql, ...args) {
        const start = performance.now();
        const result = await originalQuery.call(this, sql, ...args);
        add('pool', sql, result, performance.now() - start);
        return result;
    };
    pool.getConnection = async function(...args) {
        const conn = await originalGet.apply(this, args); leases++;
        const old = Object.fromEntries(['query','beginTransaction','commit','rollback','release'].map(k => [k,conn[k]]));
        conn.query = async function(sql, ...args) {
            const start = performance.now();
            const result = await old.query.call(this, sql, ...args);
            add('connection', sql, result, performance.now()-start);
            return result;
        };
        for (const method of ['beginTransaction','commit','rollback']) conn[method] = async function(...args) {
            const start = performance.now();
            const result = await old[method].apply(this,args);
            add('transaction',method,null,performance.now()-start);
            return result;
        };
        conn.release = function() { Object.assign(conn,old); released++; return old.release.call(this); };
        return conn;
    };
    const start = performance.now();
    try {
        const value = await operation();
        return { value, ms: +(performance.now()-start).toFixed(3), commands, leases, released };
    } finally { pool.getConnection=originalGet; pool.query=originalQuery; }
}
const api = async (method,url,body) => {
    const response=await request(app)[method](url).set('Cookie',cookie).send(body);
    assert.equal(response.statusCode,200,`${url}: ${response.statusCode} ${response.text}`);
    return response.body;
};
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)];
async function scenario(label, operation, count=8) {
    await operation(); // Warm application/DB paths outside measurement.
    const runs=[];
    for(let i=0;i<count;i++) runs.push(await capture(operation));
    const first=runs[0];
    const result={ label, samples:count, medianMs:percentile(runs.map(r=>r.ms),.5),p95Ms:percentile(runs.map(r=>r.ms),.95),
        commands: [...new Set(runs.map(r=>r.commands.length))], leased:first.leases,released:first.released,
        sql:first.commands, returnedRows:first.commands.reduce((n,c)=>n+(c.rows||0),0)};
    results.scenarios.push(result);
    console.log(JSON.stringify({label,commands:result.commands,medianMs:result.medianMs,p95Ms:result.p95Ms,leased:result.leased,released:result.released}));
    return first.value;
}
const cart=n=>Array.from({length:n},(_,i)=>({id:SEED.product1.id,qty:1,price:5,note:`line ${i}`}));
const checkout=lines=>api('post','/api/pos/checkout',{cart:lines,shift_id:shiftId,subtotal:lines.length*5,tax:lines.length*.8,total:lines.length*5.8,payment_method:'cash',amount_tendered:lines.length*5.8,change_due:0,idempotency_key:require('crypto').randomUUID()});

async function inspectRead(label, operation) {
    let statements=[];
    const conn={query:async(...args)=>{statements.push(args);return pool.query(...args);}};
    await operation(conn);
    const times=[];
    for(let i=0;i<5;i++) {const start=performance.now();await operation(pool);times.push(performance.now()-start);}
    const plans=[];
    for(const [sql,params] of statements) {
        const [explain]=await pool.query('EXPLAIN '+sql,params);
        const [[analyze]]=await pool.query('ANALYZE FORMAT=JSON '+sql,params);
        plans.push({sql:normalize(sql),explain,analyze:JSON.parse(analyze.ANALYZE)});
    }
    const result={label,queries:statements.length,medianMs:+percentile(times,.5).toFixed(3),plans};
    results.reads.push(result);
    console.log(JSON.stringify({label,queries:result.queries,medianMs:result.medianMs}));
}

async function main() {
    const bootstrap=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD});
    await bootstrap.query('CREATE DATABASE '+name+' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
    const [[runtime]]=await bootstrap.query('SELECT VERSION() version, @@tx_isolation isolation_level'); results.runtime=runtime;
    await bootstrap.end();
    const fixture=require('../../backend/tests/fixtures/seed');
    await fixture.seedDatabase(); SEED=fixture.SEED;
    pool=require('../../backend/config/db'); L=require('../../backend/services/RecipeLedgerService'); app=require('../../server').app;
    try {
        const login=await request(app).post('/api/auth/login').send({user_number:SEED.adminUser.user_number});
        cookie=login.headers['set-cookie'][0];
        await api('post','/api/auth/shifts?action=open',{user_id:SEED.adminUser.id,starting_cash:0});
        const [[shift]]=await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'",[SEED.adminUser.id]);shiftId=shift.id;
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key IN ('stock_enabled','recipe_ledger_enabled')");
        await scenario('disabled / checkout 1 line',()=>checkout(cart(1)));
        await scenario('disabled / checkout 10 lines',()=>checkout(cart(10)));
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'");
        await scenario('enabled, no recipe / checkout 1 line',()=>checkout(cart(1)));
        await scenario('enabled, no recipe / checkout 10 lines',()=>checkout(cart(10)));
        const [ingredient]=await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Performance chicken','weight','g',0.0045),('Unrelated ingredient','weight','g',0.001)");
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,200)',[SEED.product1.id,ingredient.insertId]);
        await scenario('enabled, recipe / checkout 1 line',()=>checkout(cart(1)));
        await scenario('enabled, recipe / checkout 10 lines',()=>checkout(cart(10)));
        let tableInvoice=null, tableVersion=null;
        const save=async () => {
            const result=await api('post','/api/pos/table_order',{table_id:SEED.table2.id,current_order_id:tableInvoice,expected_version:tableVersion,cart:cart(1),subtotal:5,tax:.8,total:5.8});
            tableInvoice=result.invoice_id;
            tableVersion=result.version;
            return result;
        };
        await save();
        await scenario('enabled, recipe / unchanged table save',save);
        // Non-recipe saved lines still have keys, but no movement rows.
        const emptyKey=L.newLineKey();
        const conn=await pool.getConnection(), other=await pool.getConnection();
        try {
            await conn.beginTransaction();
            await L.syncOrderLines(conn, {sourceId:1,lines:[{key:emptyKey,product_id:SEED.product2.id,qty:1,isNew:true}],removedKeys:[],businessDate:'2026-09-06'});
            await conn.commit();
            await conn.beginTransaction();
            const trace=[];
            await L.syncOrderLines({query:async(...args)=>{trace.push(normalize(args[0]));return conn.query(...args);}},
                {sourceId:1,lines:[{key:emptyKey,product_id:SEED.product2.id,qty:1,isNew:false}],removedKeys:[],businessDate:'2026-09-06'});
            await other.query('SET SESSION innodb_lock_wait_timeout=1');
            await other.beginTransaction();
            let blocked=false;
            const start=performance.now();
            try { await other.query('SELECT id FROM ingredients WHERE id=? FOR UPDATE',[ingredient.insertId+1]); }
            catch(error) { assert.equal(error.code,'ER_LOCK_WAIT_TIMEOUT');blocked=true; }
            results.contention.push({case:'unchanged saved empty recipe blocks an unrelated ingredient',blocked,waitMs:+(performance.now()-start).toFixed(2),sql:trace});
            console.log(JSON.stringify(results.contention.at(-1)));
        } finally {await conn.rollback();await other.rollback();conn.release();other.release();}
        // Append 100k movements over 100 ingredients, all after an old Count.
        const [masters]=await pool.query('INSERT INTO ingredients(name,measure,display_unit) VALUES ?',
            [Array.from({length:100},(_,i)=>[`Scale ${i}`,'weight','g'])]);
        const day='2026-09-06';
        for(let i=0;i<100;i++) {
            const id=masters.insertId+i;
            await pool.query('INSERT INTO ingredient_movements(ingredient_id,kind,qty,source_type,business_date) VALUES ?',
                [Array.from({length:1001},(_,j)=>[id,j===0?'count':'usage',j===0?10000:-1,'manual',j===0?'2026-08-01':day])]);
        }
        await inspectRead('100 ingredients / 100k movements / stale Counts / summary',conn=>L.getIngredientSummaries(conn,{businessDate:day}));
        await inspectRead('100 ingredients / 100k movements / portions',conn=>L.getPortionsReport(conn));
        await inspectRead('100 ingredients / 100k movements / one product portions',conn=>L.getPortionsReport(conn,{productId:SEED.product1.id}));
        await scenario('100 ingredients / 100k movements / recipe picker options',()=>api('get','/api/admin/ingredients/options'),3);
        // The read suite also records the full daily-report command/row count.
        await scenario('100 ingredients / 100k movements / daily report',()=>api('get','/api/admin/reports/ingredients?date='+day),3);
        await pool.query("UPDATE ingredient_movements SET business_date='2026-08-02' WHERE ingredient_id>=? AND ingredient_id<? AND kind='usage'",[masters.insertId,masters.insertId+100]);
        // Keep ten usage rows per ingredient on the selected day (1,000 total).
        await pool.query(`UPDATE ingredient_movements m JOIN (
            SELECT ingredient_id,MAX(id) last_id FROM ingredient_movements
             WHERE ingredient_id>=? AND ingredient_id<? GROUP BY ingredient_id
        ) last ON last.ingredient_id=m.ingredient_id
        SET m.business_date=? WHERE m.id>last.last_id-10`,[masters.insertId,masters.insertId+100,day]);
        await inspectRead('100 ingredients / 100k history / 1k today / stale Counts / summary',conn=>L.getIngredientSummaries(conn,{businessDate:day}));
        await pool.query('INSERT INTO ingredient_movements(ingredient_id,kind,qty,source_type,business_date) VALUES ?',
            [Array.from({length:100},(_,i)=>[masters.insertId+i,'count',9000,'manual',day])]);
        await inspectRead('100 ingredients / 100k history / 1k today / recent Counts / summary',conn=>L.getIngredientSummaries(conn,{businessDate:day}));
        await inspectRead('100 ingredients / 100k old-day movements / quiet next-day summary',conn=>L.getIngredientSummaries(conn,{businessDate:'2026-09-07'}));
        await inspectRead('history 50 rows / 1000 movements',conn=>L.listMovements(conn,{ingredientId:masters.insertId,limit:50}));
    } finally {await pool.end();}
    fs.writeFileSync(path.join(__dirname,process.env.POSAPP_PERFORMANCE_OUTPUT || 'recipe-ledger-performance-results.json'),JSON.stringify(results,null,2)+'\n');
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
