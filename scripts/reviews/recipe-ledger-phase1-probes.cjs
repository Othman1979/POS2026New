// Adversarial review only. All database changes are restricted by the preload
// to a newly created, dedicated scratch database. Does not patch application code.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '../..');
const name = process.env.POSAPP_REVIEW_DB;
assert.match(name || '', /^posapp_review_recipe_p1_[a-f0-9]{12}$/);
assert.equal(process.env.DB_NAME, name);
const results = [];
let pool;
let io;
const uid = () => crypto.randomBytes(12).toString('hex');
const actor = { id: 1, name: 'Phase 1 reviewer fixture' };
const businessDate = '2026-09-06';
async function test(name, fn) {
    const evidence = {};
    try {
        await fn(evidence);
        results.push({ name, status: 'PASS', evidence });
    } catch (error) {
        results.push({ name, status: 'FAIL', evidence, error: error.message });
    }
    console.log(JSON.stringify(results.at(-1)));
}
async function tx(fn) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
}
async function main() {
    const admin = await mysql.createConnection({
        host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD
    });
    // Deliberately no IF NOT EXISTS: never adopt a preexisting database.
    await admin.query('CREATE DATABASE ' + name + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
    const [[engine]] = await admin.query('SELECT VERSION() AS version, @@tx_isolation AS isolation');
    await admin.end();
    const { seedDatabase } = require('../../backend/tests/fixtures/seed');
    await seedDatabase();
    pool = require('../../backend/config/db');
    const [[target]] = await pool.query('SELECT DATABASE() AS name');
    assert.equal(target.name, name);
    const L = require('../../backend/services/RecipeLedgerService');
    const request = require('supertest');
    const server = require('../../server');
    io = server.io;
    const app = server.app;
    const login = await request(app).post('/api/auth/login').send({ user_number: '9001' });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0];
    const http = (method, url, body) => request(app)[method](url).set('Cookie', cookie).send(body);
    async function ingredient(extra = {}) {
        const response = await http('post', '/api/admin/ingredients', {
            name: 'Review ' + uid(), measure: 'weight', display_unit: 'g', ...extra
        });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return response.body.ingredient.id;
    }
    const manual = (id, data) => http('post', '/api/admin/ingredients/' + id + '/movements', data);
    const rowArgs = (id, kind, qty, clientKey = uid()) => ({
        ingredientId: id, kind, qty, unit: 'g', clientKey, actor, businessDate
    });
    await test('Task 4: uncounted history stays unknown', async e => {
        const id = await ingredient();
        assert.equal((await manual(id, { kind: 'receipt', qty: 10, unit: 'g', client_key: uid() })).status, 200);
        const summary = (await http('get', '/api/admin/ingredients')).body.ingredients.find(i => i.id === id);
        const history = (await http('get', '/api/admin/ingredients/' + id + '/movements')).body.rows;
        e.summary_expected = summary.expected_remaining;
        e.history_running_balance = history[0].running_balance;
        assert.equal(summary.expected_remaining, null);
        assert.equal(history[0].running_balance, null);
    });
    await test('Task 4: first Count has no invented expected quantity or variance', async e => {
        const id = await ingredient();
        await manual(id, { kind: 'receipt', qty: 10, unit: 'g', client_key: uid() });
        const response = await manual(id, { kind: 'count', qty: 100, unit: 'g', client_key: uid() });
        assert.equal(response.status, 200);
        const [[stored]] = await pool.query('SELECT expected_qty,period_usage_qty FROM ingredient_movements WHERE id=?', [response.body.movement.id]);
        e.stored = stored;
        e.last_count = (await http('get', '/api/admin/ingredients')).body.ingredients.find(i => i.id === id).last_count;
        assert.equal(stored.expected_qty, null);
        assert.equal(e.last_count.variance_qty, null);
    });
    await test('Task 4: opening replay rejects changed quantity and does not return false success', async e => {
        const id = await ingredient();
        const key = uid();
        const post = qty => http('post', '/api/admin/ingredients/opening', {
            entries: [{ ingredient_id: id, qty, unit: 'g' }], client_key: key
        });
        const first = await post(100);
        const same = await post(100);
        const different = await post(250);
        e.responses = [first, same, different].map(r => ({ status: r.status, replay: r.body.replay, qty: r.body.movements?.[0]?.qty }));
        const [[stored]] = await pool.query('SELECT COUNT(*) AS rows_written, MAX(qty) AS qty FROM ingredient_movements WHERE ingredient_id=?',[id]);
        e.stored = stored;
        assert.equal(first.status, 200);
        assert.equal(same.body.replay, true);
        assert.equal(different.status, 409);
    });
    await test('Task 4: supported 64-character opening key works for multiple ingredients', async e => {
        const ids = [await ingredient(), await ingredient()];
        const response = await http('post', '/api/admin/ingredients/opening', {
            entries: ids.map(id => ({ ingredient_id: id, qty: 100, unit: 'g' })),
            client_key: 'a'.repeat(64)
        });
        e.response = { status: response.status, body: response.body };
        const [[stored]] = await pool.query('SELECT COUNT(*) AS rows_written FROM ingredient_movements WHERE ingredient_id IN (?,?)',ids);
        e.stored = stored;
        assert.equal(response.status, 200);
        assert.equal(Number(stored.rows_written), 2);
    });
    await test('Task 4: Count observes the receipt committed before its ingredient lock is acquired', async e => {
        const id = await ingredient();
        await tx(c => L.recordManualMovement(c, rowArgs(id, 'count', 100)));
        const writer = await pool.getConnection();
        const counter = await pool.getConnection();
        let observedFind;
        const sawFind = new Promise(resolve => { observedFind = resolve; });
        const originalQuery = counter.query.bind(counter);
        const wrapped = { query: async (...args) => {
            const result = await originalQuery(...args);
            if (String(args[0]).includes('WHERE client_key=? LIMIT 1')) observedFind();
            return result;
        }};
        try {
            await writer.beginTransaction();
            await L.recordManualMovement(writer, rowArgs(id, 'receipt', 10));
            await counter.beginTransaction();
            const counting = L.recordManualMovement(wrapped, rowArgs(id, 'count', 110));
            await sawFind;
            await writer.commit();
            const count = await counting;
            await counter.commit();
            const [rows] = await pool.query('SELECT id,kind,qty,expected_qty FROM ingredient_movements WHERE ingredient_id=? ORDER BY id',[id]);
            e.rows = rows;
            e.count_expected = count.movement.expected_qty;
            e.summary = (await L.getIngredientSummaries(pool, { businessDate })).find(i => i.id === id).last_count;
            assert.equal(Number(count.movement.expected_qty), 110);
        } finally {
            await writer.rollback(); await counter.rollback();
            writer.release(); counter.release();
        }
    });
    await test('Task 4: concurrent identical receipt retry succeeds as replay', async e => {
        const id = await ingredient();
        const args = rowArgs(id, 'receipt', 10);
        const first = await pool.getConnection(), second = await pool.getConnection();
        let observedFind;
        const sawFind = new Promise(resolve => { observedFind = resolve; });
        const query = second.query.bind(second);
        const wrapped = { query: async (...a) => {
            const result = await query(...a);
            if (String(a[0]).includes('WHERE client_key=? LIMIT 1')) observedFind();
            return result;
        }};
        try {
            await first.beginTransaction(); await second.beginTransaction();
            await L.recordManualMovement(first,args);
            const retry = L.recordManualMovement(wrapped,args).then(
                result => ({ replay: result.replay }),
                error => ({ error: error.code, statusCode: error.statusCode })
            );
            await sawFind; await first.commit();
            e.retry = await retry;
            await second.rollback();
            const [[stored]] = await pool.query('SELECT COUNT(*) AS n,SUM(qty) AS qty FROM ingredient_movements WHERE ingredient_id=?',[id]);
            e.stored = stored;
            assert.equal(e.retry.replay, true);
        } finally { await first.rollback(); await second.rollback(); first.release(); second.release(); }
    });
    await test('Task 4 HTTP: two simultaneous identical receipt submissions return success/replay', async e => {
        const id=await ingredient(),key=uid();
        const getConnection=pool.getConnection;
        let reached=0,releaseGate;
        const gate=new Promise(resolve=>{releaseGate=resolve;});
        pool.getConnection=async function(...args) {
            const conn=await getConnection.apply(pool,args);
            const query=conn.query,release=conn.release;
            conn.query=async function(...queryArgs) {
                const response=await query.apply(conn,queryArgs);
                if(String(queryArgs[0]).includes('WHERE client_key=? LIMIT 1') && queryArgs[1]?.[0]===key) {
                    reached++;
                    if(reached===2)releaseGate();
                    await gate;
                }
                return response;
            };
            conn.release=function() {conn.query=query;conn.release=release;return release.call(conn);};
            return conn;
        };
        try {
            const responses=await Promise.all([0,1].map(()=>manual(id,{kind:'receipt',qty:10,unit:'g',client_key:key})));
            e.responses=responses.map(r=>({status:r.status,body:r.body}));
            assert.equal(reached,2);
            const [[stored]]=await pool.query('SELECT COUNT(*) n,SUM(qty) qty FROM ingredient_movements WHERE ingredient_id=?',[id]);e.stored=stored;
            assert(responses.every(r=>r.status===200),'Identical retry is returned as an HTTP error');
            assert.equal(responses.filter(r=>r.body.replay===true).length,1);
        } finally {pool.getConnection=getConnection;}
    });
    await test('Task 4: summary Count and tail belong to one consistent read', async e => {
        const id=await ingredient();
        await tx(c=>L.recordManualMovement(c,rowArgs(id,'count',100)));
        let inserted=false;
        const wrapped={query:async(...args)=>{
            const result=await pool.query(...args);
            const sql=String(args[0]);
            if(!inserted && sql.includes('MAX(id) AS id') && sql.includes("WHERE kind='count'")) {
                inserted=true;
                await tx(c=>L.recordManualMovement(c,rowArgs(id,'count',200)));
                await tx(c=>L.recordManualMovement(c,rowArgs(id,'receipt',10)));
            }
            return result;
        }};
        const mixed=(await L.getIngredientSummaries(wrapped,{businessDate})).find(i=>i.id===id);
        const fresh=(await L.getIngredientSummaries(pool,{businessDate})).find(i=>i.id===id);
        e.interleaved_remaining=mixed.expected_remaining;e.fresh_remaining=fresh.expected_remaining;
        e.valid_committed_balances=[100,200,210];
        assert(e.valid_committed_balances.includes(mixed.expected_remaining),'Summary returned a balance that never existed');
    });
    await test('Tasks 3-4: partial refunds restore every ingredient exactly at six-place precision', async e => {
        const tiny = await ingredient(), normal = await ingredient();
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'");
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (1,?,0.000001),(1,?,1)',[tiny,normal]);
        const key = L.newLineKey();
        await tx(c => L.syncOrderLines(c, { sourceId: 9901, lines: [{key,product_id:1,qty:1,isNew:true}], actor,businessDate }));
        for (const qty of [0.333333,0.333333,0.333334]) {
            await tx(c => L.reverseLineUsage(c, {lineKey:key,qty,sourceType:'refund',sourceId:9902,actor,businessDate}));
        }
        const [net] = await pool.query('SELECT ingredient_id,SUM(qty) net,SUM(product_qty) remaining_product_qty FROM ingredient_movements WHERE line_key=? GROUP BY ingredient_id ORDER BY ingredient_id',[key]);
        e.net = net;
        assert(net.every(r => Number(r.net) === 0), 'Full item quantity refunded but ingredient usage remains');
    });
    await test('Tasks 3-4 HTTP: checkout then three fractional refunds restores every component', async e => {
        const sale = await http('post','/api/pos/checkout',{
            cart:[{id:1,qty:1,price:5}],subtotal:5,tax:0.8,total:5.8,
            payment_method:'cash',amount_tendered:5.8,change_due:0,idempotency_key:uid()
        });
        e.sale = { status:sale.status, invoice_id:sale.body.invoice_id };
        assert.equal(sale.status,200,JSON.stringify(sale.body));
        const [[line]]=await pool.query('SELECT id,recipe_line_key FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',[sale.body.invoice_id]);
        const statuses=[];
        for(const qty of [0.333333,0.333333,0.333334]) {
            const refund=await http('post','/api/pos/refunds',{
                invoice_id:sale.body.invoice_id,intent:'refund',refund_method:'cash',
                items:[{order_item_id:line.id,qty}]
            });
            statuses.push({qty,status:refund.status,body:refund.body});
        }
        e.refunds=statuses;
        const [net]=await pool.query('SELECT ingredient_id,SUM(qty) net,SUM(product_qty) remaining_product_qty FROM ingredient_movements WHERE line_key=? GROUP BY ingredient_id ORDER BY ingredient_id',[line.recipe_line_key]);
        const [[returned]]=await pool.query('SELECT SUM(quantity) qty FROM refund_items WHERE order_item_id=?',[line.id]);
        const [[order]]=await pool.query('SELECT refund_status FROM orders WHERE invoice_id=?',[sale.body.invoice_id]);
        e.net=net;e.refunded_quantity=returned.qty;e.order=order;
        assert(statuses.every(r=>r.status===200),'All refund requests must be accepted for the reproduction');
        assert.equal(Number(returned.qty),1);
        assert(net.every(r=>Number(r.net)===0),'Paid order fully refunded but ingredient usage remains');
    });
    await test('Task 3: portions arithmetic does not lose a whole portion to binary rounding', async e => {
        e.result = L.portionsPossible([{ingredient_id:1,qty_per_unit:0.1}],new Map([[1,0.3]]));
        assert.equal(e.result.portions,3);
    });
    await test('Task 3 HTTP: 0.3 g available at 0.1 g per meal yields three portions', async e => {
        const id=await ingredient();
        const recipe=await http('put','/api/admin/products/2/recipe',{lines:[{ingredient_id:id,qty:0.1,unit:'g'}]});
        assert.equal(recipe.status,200,JSON.stringify(recipe.body));
        assert.equal((await manual(id,{kind:'count',qty:0.3,unit:'g',client_key:uid()})).status,200);
        const response=await http('get','/api/admin/ingredients/portions');
        e.response=response.body.portions.find(p=>p.product_id===2);
        assert.equal(response.status,200);
        assert.equal(e.response.portions_possible,3);
    });
    await test('Task 1 HTTP: duplicate product rows preserve stock through save, re-save and settle', async e => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query('UPDATE products SET stock=10 WHERE id=2');
        const cart=[{id:2,qty:1,price:2,note:'first'},{id:2,qty:2,price:2,note:'second'}];
        const totals={subtotal:6,tax:0,total:6};
        const first=await http('post','/api/pos/table_order',{table_id:1,cart,...totals});
        assert.equal(first.status,200,JSON.stringify(first.body));
        const invoice=first.body.order_id||first.body.invoice_id;
        const stock=async()=>Number((await pool.query('SELECT stock FROM products WHERE id=2'))[0][0].stock);
        const values=[await stock()];
        const lines=async()=> (await pool.query('SELECT id,note FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',[invoice]))[0];
        let saved=await lines();
        const resave=await http('post','/api/pos/table_order',{table_id:1,current_order_id:invoice,expected_version:first.body.version,...totals,
            cart:cart.map(l=>({...l,order_item_id:saved.find(r=>r.note===l.note).id}))});
        assert.equal(resave.status,200,JSON.stringify(resave.body));values.push(await stock());
        saved=await lines();
        const settled=await http('post','/api/pos/checkout',{table_id:1,edit_invoice_id:invoice,...totals,
            cart:cart.map(l=>({...l,order_item_id:saved.find(r=>r.note===l.note).id})),
            payment_method:'cash',amount_tendered:6,change_due:0,idempotency_key:uid()});
        assert.equal(settled.status,200,JSON.stringify(settled.body));values.push(await stock());
        e.stock=values;e.statuses=[first.status,resave.status,settled.status];
        assert.deepEqual(values,[7,7,7]);
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='stock_enabled'");
    });
    await test('Task 4: explicit gram/kg form units survive preference edit and Count accepts zero', async e => {
        const id = await ingredient({display_unit:'kg'});
        assert.equal((await http('put','/api/admin/ingredients/'+id,{display_unit:'g'})).status,200);
        const receipt=await manual(id,{kind:'receipt',qty:2,unit:'kg',client_key:uid()});
        const count=await manual(id,{kind:'count',qty:0,unit:'g',client_key:uid()});
        e.qty = receipt.body.movement.qty;
        e.count = count.body.movement.qty;
        assert.equal(Number(e.qty),2000); assert.equal(Number(e.count),0);
    });
    await test('Task 4: correction after a later Count preserves the counted balance', async e => {
        const id = await ingredient();
        const receipt=await manual(id,{kind:'receipt',qty:10,unit:'g',client_key:uid()});
        await manual(id,{kind:'count',qty:100,unit:'g',client_key:uid()});
        const correction=await http('post','/api/admin/ingredient-movements/'+receipt.body.movement.id+'/correct',{note:'review',client_key:uid()});
        e.status=correction.status;
        e.expected=(await http('get','/api/admin/ingredients')).body.ingredients.find(i=>i.id===id).expected_remaining;
        assert.equal(e.status,200);assert.equal(e.expected,100);
    });
    await test('Task 4: filtered history includes earlier usage and resets at a Count', async e => {
        const id=await ingredient();
        const insert=async(kind,qty,date)=>pool.query('INSERT INTO ingredient_movements(ingredient_id,kind,qty,source_type,business_date) VALUES (?,?,?,?,?)',[id,kind,qty,'manual',date]);
        await insert('count',100,'2026-09-04');
        await insert('usage',-10,'2026-09-05');
        await insert('usage',-5,'2026-09-06');
        await insert('count',200,'2026-09-06');
        await insert('usage',-2,'2026-09-06');
        const response=await http('get','/api/admin/ingredients/'+id+'/movements?from=2026-09-06&limit=2');
        const second=await http('get','/api/admin/ingredients/'+id+'/movements?from=2026-09-06&limit=2&before_id='+response.body.rows[1].id);
        e.first_page=response.body.rows.map(r=>r.running_balance);
        e.second_page=second.body.rows.map(r=>r.running_balance);
        assert.deepEqual(e.first_page,[198,200]);assert.deepEqual(e.second_page,[85]);
    });
    await test('Task 4 measurement: history pagination query volume and summary EXPLAIN', async e => {
        const id=await ingredient();
        const values=Array.from({length:20000},(_,i)=>[id,i===0?'count':'usage',i===0?100000:-1,'manual','2026-09-04']);
        for(let i=0;i<values.length;i+=500)await pool.query('INSERT INTO ingredient_movements(ingredient_id,kind,qty,source_type,business_date) VALUES ?',[values.slice(i,i+500)]);
        const reads=[];
        const wrapped={query:async(...args)=>{
            const result=await pool.query(...args);
            if(Array.isArray(result[0]))reads.push(result[0].length);
            return result;
        }};
        const start=performance.now();
        const page=await L.listMovements(wrapped,{ingredientId:id,limit:2});
        e.page_rows=page.rows.length;e.query_row_counts=reads;e.elapsed_ms=+(performance.now()-start).toFixed(2);
        const plans=[];
        await L.getIngredientSummaries({query:async(...args)=>{
            if(String(args[0]).includes('MAX(id)')) {
                const [plan]=await pool.query('EXPLAIN '+args[0],args[1]);plans.push(plan);
            }
            return pool.query(...args);
        }},{businessDate});
        e.summary_plans=plans;
        assert.equal(page.rows.length,2);
    });
    const output = { head:'d6cc1ab2', database:name, engine, results };
    fs.writeFileSync(path.join(__dirname,'recipe-ledger-phase1-results.json'),JSON.stringify(output,null,2)+'\n');
    console.log(JSON.stringify({ pass:results.filter(r=>r.status==='PASS').length, fail:results.filter(r=>r.status==='FAIL').length }));
}
main().catch(error => { console.error(error.stack); process.exitCode=1; })
    .finally(async () => { if(pool)await pool.end(); if(io)io.close(); });
