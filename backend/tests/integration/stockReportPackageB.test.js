const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const generations = require('../../services/StockReportGenerationService');
const invalidation = require('../../services/StockReportInvalidation');
const ledger = require('../../services/StockLedgerService');
const L = require('../../services/RecipeLedgerService');
const reads = require('../../services/StockReportReadService');
const worker = require('../../services/StockReportWorker');
const { getBusinessDate } = require('../../utils/businessDate');

describe('Stock report package B invalidation and published reads', () => {
    const day = getBusinessDate();
    let adminCookie;
    let cashierCookie;
    let cashierShiftId;
    beforeEach(async () => {
        await seedDatabase();
        adminCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        cashierCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
        const shift = await request(app).post('/api/auth/shifts?action=open').set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 50 });
        expect(shift.statusCode).toBe(200);
        const [shifts] = await pool.query('SELECT id FROM shifts WHERE user_id=? AND status=\'open\' LIMIT 1', [SEED.cashierUser.id]);
        cashierShiftId = shifts[0].id;
    });
    afterAll(() => pool.end());
    async function tx(work) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const value = await work(conn);
            await conn.commit();
            return value;
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally { conn.release(); }
    }
    async function paidSale(amount, at = `${day} 10:00:00`) {
        const [order] = await pool.query(
            "INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES (1,?,0,?,'cash',?)",
            [amount, amount, at]
        );
        await pool.query(
            "INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale) VALUES (?,?,?,?,?)",
            [order.insertId, SEED.product1.id, 'Meal', 1, amount]
        );
        return order.insertId;
    }
    function daysAgo(base, offset) {
        const [year, month, date] = base.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, date - offset)).toISOString().slice(0, 10);
    }
    async function dirty(scopeDay = day) {
        return generations.status(pool, { startDate: scopeDay, endDate: scopeDay });
    }
    async function publishPeriod(startDate = day, endDate = startDate) {
        await generations.ensureCoverage(pool, { startDate, endDate });
        await worker.drain(pool);
    }

    test('review: default startup coverage includes historical source days', async () => {
        const old = daysAgo(day, 40);
        await paidSale(5, `${old} 10:00:00`);
        await generations.ensureCoverage(pool);
        expect(await dirty(old)).toHaveLength(32);
    });

    test('publication identity changes when a non-maximum partition is republished', async () => {
        await paidSale(7);
        await publishPeriod();
        await pool.query('UPDATE stock_report_dirty SET published_generation=100 WHERE day=? AND scope_id=0',[day]);
        const before=await reads.getPublishedAnalysis(pool,{startDate:day,endDate:day});
        await tx(conn=>generations.markDirty(conn,[{day,scope_id:1}]));
        await worker.drain(pool);
        const after=await reads.getPublishedAnalysis(pool,{startDate:day,endDate:day});
        expect(after.totals).toEqual(before.totals);
        expect(after.freshness.generation).not.toBe(before.freshness.generation);
        expect(after.freshness.generation).toMatch(/^[a-f0-9]{64}$/);
    });

    test('HTTP report pages reach every meal, search beyond the first page and reject mixed publications', async () => {
        await paidSale(7);
        await publishPeriod();
        const [[build]]=await pool.query('SELECT published_build_id id FROM stock_report_dirty WHERE day=? AND scope_id=0',[day]);
        await pool.query('INSERT INTO stock_report_meals(build_id,product_id,name,sold,net_revenue_cents) VALUES ?',
            [Array.from({length:105},(_,n)=>[build.id,n+100,`Page meal ${n}`,1,100])]);
        const get=(extra={})=>request(app).get('/api/admin/ingredients/analysis').set('Cookie',adminCookie)
            .query({from:day,to:day,view:'meal',...extra});
        const first=await get();
        expect(first.status).toBe(200);
        expect(first.body.meals).toHaveLength(50);
        expect(first.body.next_cursor).toBeTruthy();
        const ids=first.body.meals.map(row=>row.product_id);
        let cursor=first.body.next_cursor;
        for(let page=0;cursor && page<5;page++) {
            const next=await get({cursor});
            expect(next.status).toBe(200);
            ids.push(...next.body.meals.map(row=>row.product_id));cursor=next.body.next_cursor;
        }
        expect(cursor).toBeNull();
        expect(ids).toHaveLength(106);
        expect(new Set(ids).size).toBe(106);
        const searched=await get({q:'Page meal 104'});
        expect(searched.body.meals.map(row=>row.product_id)).toEqual([204]);
        expect(searched.body.totals).toEqual(first.body.totals);
        expect((await get({cursor:first.body.next_cursor,q:'different'})).status).toBe(400);
        await tx(conn=>generations.markDirty(conn,[{day,scope_id:2}]));
        await worker.drain(pool);
        expect((await get({cursor:first.body.next_cursor})).status).toBe(409);
    });

    test('drilldowns page associations, recipe parts and tied events without truncation or duplicates', async () => {
        await paidSale(7);await publishPeriod();
        const [[build]]=await pool.query('SELECT published_build_id id FROM stock_report_dirty WHERE day=? AND scope_id=0',[day]);
        await pool.query('INSERT INTO stock_report_meals(build_id,product_id,name,sold) VALUES ?',
            [Array.from({length:60},(_,n)=>[build.id,n+100,`Meal ${n}`,1])]);
        await pool.query('INSERT INTO stock_report_ingredients(build_id,product_id,ingredient_id,name,display_unit,qty) VALUES ?',
            [Array.from({length:60},(_,n)=>[build.id,n+100,999,'Shared','g',1])]);
        await pool.query('INSERT INTO stock_report_ingredients(build_id,product_id,ingredient_id,name,display_unit,qty) VALUES ?',
            [Array.from({length:60},(_,n)=>[build.id,159,n+100,`Ingredient ${n}`,'g',1])]);
        await pool.query('INSERT INTO stock_report_events(build_id,kind,source_id,source_line_id,invoice_id,product_id,event_at,quantity,net_revenue_cents,known_cost,incomplete) VALUES ?',
            [Array.from({length:105},(_,n)=>[build.id,n%2?'sale':'refund',n+100,1,1,159,`${day} 11:00:00`,1,0,0,0])]);
        const get=(extra={})=>request(app).get('/api/admin/ingredients/analysis').set('Cookie',adminCookie)
            .query({from:day,to:day,view:'meal',...extra});
        const associated=await get({ingredient_id:999});
        expect(associated.body.meals).toHaveLength(50);
        const rest=await get({ingredient_id:999,cursor:associated.body.next_cursor});
        expect(rest.body.meals).toHaveLength(10);
        expect(rest.body.next_cursor).toBeNull();
        const detail=await get({product_id:159});
        expect(detail.body.meals[0].product_id).toBe(159);
        expect(detail.body.meals[0].ingredients).toHaveLength(50);
        expect(detail.body.parts_next_cursor).toBeTruthy();
        const parts=await get({product_id:159,parts_cursor:detail.body.parts_next_cursor});
        expect(parts.body.meals[0].ingredients).toHaveLength(11);
        expect(parts.body.parts_next_cursor).toBeNull();
        const eventIds=detail.body.events.map(row=>row.id);
        let cursor=detail.body.events_next_cursor;
        for(let page=0;cursor&&page<5;page++){
            const next=await get({product_id:159,event_cursor:cursor});
            expect(next.status,JSON.stringify(next.body)).toBe(200);
            eventIds.push(...next.body.events.map(row=>row.id));cursor=next.body.events_next_cursor;
        }
        expect(cursor).toBeNull();expect(eventIds).toHaveLength(105);expect(new Set(eventIds).size).toBe(105);
        expect((await get({product_id:158,event_cursor:detail.body.events_next_cursor})).status).toBe(400);
    });

    test('upgrade withdraws old facts, supersedes an in-flight worker, rebuilds and is a no-op on retry', async () => {
        const fs=require('node:fs'),path=require('node:path');
        const {runPendingMigrations,splitMysqlScript}=require('../../migrations/runPendingMigrations');
        const entry=require('../../migrations/auto-manifest.json').migrations.find(row=>row.name==='2026-09-08-stock-report-ingredient-rebuild-v1');
        expect(entry).toBeDefined();
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?',[entry.name]);
        const sql=fs.readFileSync(path.join(__dirname,'../../migrations',entry.file),'utf8').replace(/\r\n/g,'\n');
        const fallback=fs.readFileSync(path.join(__dirname,'../../../deployment/database/hostinger-manual-migrations.sql'),'utf8').replace(/\r\n/g,'\n');
        expect(fallback).toContain(`-- BEGIN AUTO MIGRATION: ${entry.name} | ${entry.checksum}\n${sql}-- END AUTO MIGRATION: ${entry.name} | ${entry.checksum}`);
        await paidSale(7);
        await publishPeriod();
        await tx(conn=>generations.markDirty(conn,[{day,scope_id:1}]));
        const oldClaim=await generations.claim(pool);
        expect(oldClaim).not.toBeNull();
        const scratchRoot=path.resolve(__dirname,'../../../scratch');
        fs.mkdirSync(scratchRoot,{recursive:true});
        const directory=fs.mkdtempSync(path.join(scratchRoot,'report-upgrade-'));
        try {
            fs.copyFileSync(path.join(__dirname,'../../migrations',entry.file),path.join(directory,entry.file));
            const manifestPath=path.join(directory,'manifest.json');
            fs.writeFileSync(manifestPath,JSON.stringify({migrations:[entry]}));
            expect((await runPendingMigrations(pool,{manifestPath})).applied).toEqual([entry.name]);
            expect(await generations.publish(pool,oldClaim)).toBe(false);
            const report=await reads.getPublishedAnalysis(pool,{startDate:day,endDate:day});
            expect(report.freshness.state).toBe('rebuilding');
            expect(report.totals).toBeNull();
            await worker.drain(pool);
            const rebuilt=await reads.getPublishedAnalysis(pool,{startDate:day,endDate:day});
            expect(rebuilt.totals.net_revenue).toBe(7);
            expect(rebuilt.freshness.state).toBe('current');
            expect((await runPendingMigrations(pool,{manifestPath})).skipped).toEqual([entry.name]);
            // The cumulative manual fallback must also be safe when re-imported.
            for(const statement of splitMysqlScript(sql)) await pool.query(statement);
            expect((await reads.getPublishedAnalysis(pool,{startDate:day,endDate:day})).freshness).toEqual(rebuilt.freshness);
        } finally {
            const root=path.resolve(__dirname,'../../../scratch')+path.sep;
            if(!path.resolve(directory).startsWith(root))throw new Error('Invalid fixture directory');
            fs.rmSync(directory,{recursive:true,force:true});
        }
    // A full migration upgrade: allow for a machine busy with parallel shards.
    }, 120000);

    test('review: historical unavailable reports do not masquerade as current zero and freshness uses the oldest partition', async () => {
        const old = daysAgo(day,40);
        await paidSale(7,`${old} 10:00:00`);
        const missing=await reads.getPublishedAnalysis(pool,{startDate:old,endDate:old});
        expect(missing.totals).toBeNull();
        expect(missing.freshness.state).toBe('unavailable');
        await publishPeriod(old);
        await pool.query("UPDATE stock_report_dirty SET as_of='2026-09-08 01:00:00' WHERE day=?",[old]);
        await pool.query("UPDATE stock_report_dirty SET as_of='2026-09-08 02:00:00' WHERE day=? AND scope_id=0",[old]);
        const report=await reads.getPublishedAnalysis(pool,{startDate:old,endDate:old});
        expect(report.totals.net_revenue).toBe(7);
        const [[expected]]=await pool.query('SELECT MIN(as_of) as_of FROM stock_report_dirty WHERE day=?',[old]);
        expect(report.freshness.as_of).toEqual(expected.as_of);
    });

    test('review: activated ingredient usage remains in operational ingredient facts with its cost', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key IN ('stock_enabled','recipe_ledger_enabled')");
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Review chicken','weight','g',0.5)");
        const preview = await request(app).get(`/api/admin/stock/ingredients/${ingredient.insertId}/activation`).set('Cookie',adminCookie);
        const activated = await request(app).post(`/api/admin/stock/ingredients/${ingredient.insertId}/activate`).set('Cookie',adminCookie)
            .send({observation_token:preview.body.observation_token,request_key:randomUUID()});
        expect(activated.status,JSON.stringify(activated.body)).toBe(200);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,10)',[1,ingredient.insertId]);
        await tx(conn=>L.syncOrderLines(conn,{sourceId:9001,actor:{id:1,name:'Review'},businessDate:day,removedKeys:[],
            lines:[{key:L.newLineKey(),product_id:1,qty:1,isNew:true}]}));
        const rows=[];
        for(let scope=0;scope<32;scope++) await require('../../services/StockReportFactService').stream(pool,{day,scope_id:scope},async row=>{if(row.table==='operations')rows.push(row.values);});
        const usage=rows.filter(row=>Number(row[1])===ingredient.insertId && row[2]==='usage');
        expect(usage).toHaveLength(1);
        expect(Number(usage[0][4])).toBe(-10);
        expect(Number(usage[0][5])).toBe(-5);
        expect(rows.filter(row=>row[3]==='stock')).toHaveLength(0);
    });

    test('checkout-equivalent invoice marks stay after stock locks and roll back with the source', async () => {
        await tx(async conn => {
            await invalidation.invoices(conn, day, [1]);
            throw Object.assign(new Error('rollback'), { statusCode: 409 });
        }).catch(error => { if (error.message !== 'rollback') throw error; });
        expect(await dirty()).toEqual([]);
        await tx(conn => invalidation.invoices(conn, day, [1]));
        const rows = await dirty();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ pending: true, day });
    });

    test('non-invoice physical rows dirty every partition for that day', async () => {
        await tx(conn => invalidation.fromMovements(conn, [
            { source_type: 'void', source_id: 9, business_date: day }
        ]));
        expect(await dirty()).toHaveLength(32);
        expect((await dirty()).every(row => row.pending)).toBe(true);
    });

    test('refunds map onto the original invoice partition, not the refund id', async () => {
        const [order] = await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES (1,1,0,1,'cash',?)", [`${day} 10:00:00`]);
        const [refund] = await pool.query(
            "INSERT INTO refunds(kind,invoice_id,scope,subtotal_refunded,tax_refunded,amount_refunded,refund_method,reason,user_id) VALUES ('refund',?,'order',1,0,1,'cash','test',1)",
            [order.insertId]
        );
        await tx(conn => invalidation.fromMovements(conn, [
            { source_type: 'refund', source_id: refund.insertId, business_date: day }
        ]));
        const rows = await dirty();
        expect(rows).toHaveLength(1);
        expect(rows[0].scope_id).toBe(generations.scopeFor('invoice', order.insertId));
        expect(rows[0].scope_id).not.toBe(generations.scopeFor('operation', refund.insertId));
    });

    test('ledger posts mark the operation partition and unlinked recipe rows do not invent consecutive movement ids', async () => {
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Packaged','count','unit','active')");

        const posted = await tx(conn => ledger.post(conn, {
            kind: 'receipt', request_key: randomUUID().replace(/-/g, '').slice(0, 32), business_date: day,
            lines: [{ stock_item_id: String(item.insertId), quantity: '2' }]
        }, 1));
        expect((await dirty()).some(row => row.scope_id === generations.scopeFor('operation', posted.operation_id))).toBe(true);
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Loose flour','weight','g')");
        await tx(conn => L.recordManualMovement(conn, {
            ingredientId: ingredient.insertId, kind: 'receipt', qty: 1, unit: 'kg', clientKey: 'pkg-b-unlinked',
            businessDate: day, actor: { id: 1 }
        }));
        expect(await dirty()).toHaveLength(32);
    });

    test('old-date edits dirty the movement day rather than today', async () => {
        const past = daysAgo(day, 3);
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Aged stock','weight','g')");
        await tx(conn => L.recordManualMovement(conn, {
            ingredientId: ingredient.insertId, kind: 'receipt', qty: 2, unit: 'kg', clientKey: 'pkg-b-old-date',
            businessDate: past, actor: { id: 1 }
        }));
        expect(await dirty(day)).toEqual([]);
        expect(await dirty(past)).toHaveLength(32);
    });

    test('uninitialized source days are not published as clean zero', async () => {
        await paidSale(5);
        const unpublished = await reads.getPublishedAnalysis(pool, { startDate: day, endDate: day });
        expect(unpublished.freshness.state).toBe('unavailable');
        expect(unpublished.totals).toBeNull();
        const covered = await generations.ensureCoverage(pool, { startDate: day, endDate: day });
        expect(covered.inserted).toBe(32);
        const rebuilding = await reads.getPublishedAnalysis(pool, { startDate: day, endDate: day });
        expect(rebuilding.freshness.state).toBe('rebuilding');
        expect(rebuilding.totals).toBeNull();
        await worker.drain(pool);
        const published = await reads.getPublishedAnalysis(pool, { startDate: day, endDate: day });
        expect(published.freshness.state).toBe('current');
        expect(published.freshness.source).toBe('published');
        expect(published.totals.net_revenue).toBe(5);
        expect(published.meals_has_more).toBe(false);
    });

    test('a single published partition is stale until the remaining scopes exist', async () => {
        const invoiceId = await paidSale(8);
        await tx(conn => invalidation.invoices(conn, day, [invoiceId]));
        await worker.drain(pool);
        const partial = await reads.getPublishedAnalysis(pool, { startDate: day, endDate: day });
        expect(partial.freshness.state).toBe('stale');
        expect(partial.totals.net_revenue).toBe(8);
        await publishPeriod();
        const complete = await reads.getPublishedAnalysis(pool, { startDate: day, endDate: day });
        expect(complete.freshness.state).toBe('current');
        expect(complete.totals.net_revenue).toBe(8);
        const [[scopes]] = await pool.query('SELECT COUNT(*) c FROM stock_report_dirty WHERE day=?', [day]);
        expect(Number(scopes.c)).toBe(32);
    });

    test('price-only corrections dirty the invoice partition without changing quantity', async () => {
        const [order] = await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES (1,8,0,8,'cash',?)", [`${day} 10:00:00`]);
        await pool.query("INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale) VALUES (?,?,?,?,?)",
            [order.insertId, SEED.product1.id, 'Meal', 1, 8]);
        await publishPeriod();
        await tx(async conn => {
            await conn.query('UPDATE orders SET total=11,subtotal=11 WHERE invoice_id=?', [order.insertId]);
            await invalidation.invoices(conn, day, [order.insertId]);
        });
        const stale = await reads.getPublishedAnalysis(pool, { startDate: day, endDate: day });
        expect(stale.freshness.state).toBe('stale');
        expect(stale.totals.net_revenue).toBe(8);
        await worker.drain(pool);
        const current = await reads.getPublishedAnalysis(pool, { startDate: day, endDate: day });
        expect(current.freshness.state).toBe('current');
        expect(current.totals.net_revenue).toBe(11);
    });

    test('a later lower invoice id is included after its own dirty rebuild', async () => {
        await pool.query("INSERT INTO orders(invoice_id,user_id,subtotal,tax,total,payment_method,created_at) VALUES (9001,1,6,0,6,'cash',?)", [`${day} 11:00:00`]);
        await pool.query("INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale) VALUES (9001,?, 'Meal',1,6)", [SEED.product1.id]);
        await tx(conn => invalidation.invoices(conn, day, [9001]));
        await worker.drain(pool);
        const highFirst = await reads.getPublishedAnalysis(pool, { startDate: day, endDate: day });
        expect(highFirst.totals.net_revenue).toBe(6);
        await pool.query("INSERT INTO orders(invoice_id,user_id,subtotal,tax,total,payment_method,created_at) VALUES (8001,1,4,0,4,'cash',?)", [`${day} 10:00:00`]);
        await pool.query("INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale) VALUES (8001,?, 'Meal',1,4)", [SEED.product1.id]);
        await tx(conn => invalidation.invoices(conn, day, [8001]));
        await worker.drain(pool);
        const published = await reads.getPublishedAnalysis(pool, { startDate: day, endDate: day });
        expect(published.totals.net_revenue).toBe(10);
    });

    test('ensureCoverage resumes bounded durable pages and does not rescan completed history', async () => {
        for (let offset = 0; offset < 10; offset++) {
            const past = daysAgo(day, offset);
            await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES (1,1,0,1,'cash',?)", [`${past} 10:00:00`]);
        }
        const first = await generations.ensureCoverage(pool, { startDate: daysAgo(day, 20), endDate: day });
        expect(first.days.length).toBeLessThanOrEqual(8);
        expect(first.inserted).toBe(first.days.length * 32);
        const filled = await generations.ensureCoverage(pool);
        expect(filled.examined).toBeLessThanOrEqual(512);
        expect(filled.complete).toBe(true);
        expect(new Set([...first.days,...filled.days]).size).toBe(10);
        const [[scopes]] = await pool.query('SELECT COUNT(*) c FROM stock_report_dirty');
        expect(Number(scopes.c)).toBe(320);
        const idle=await generations.ensureCoverage(pool);
        expect(idle.examined).toBe(0);
        expect(idle.days).toEqual([]);
    });

    test('a paid checkout dirties its invoice and publishes matching live totals', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'");
        const checkout = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }],
            shift_id: cashierShiftId,
            payment_method: 'cash',
            cash_amount: 5.8,
            amount_tendered: 5.8,
            change_due: 0,
            subtotal: 5,
            tax: 0.8,
            total: 5.8,
            idempotency_key: 'pkg-b-checkout'
        });
        expect(checkout.statusCode, JSON.stringify(checkout.body)).toBe(200);
        const invoiceId = checkout.body.invoice_id;
        const rows = await dirty();
        expect(rows.some(row => row.scope_id === generations.scopeFor('invoice', invoiceId) && row.pending)).toBe(true);
        await publishPeriod();
        const published = await request(app).get('/api/admin/ingredients/analysis').query({ from: day, to: day }).set('Cookie', adminCookie);
        expect(published.statusCode).toBe(200);
        expect(published.body.freshness.state).toBe('current');
        expect(published.body.totals.net_revenue).toBe(5);
        expect(published.body.meals.length).toBeLessThanOrEqual(50);
    });
    test('HTTP price-only editing of a historical paid invoice is rejected without corrupting published facts',async()=>{
        const payload={cart:[{id:SEED.product1.id,qty:1,price:5}],shift_id:cashierShiftId,subtotal:5,tax:0.8,total:5.8,
            payment_method:'cash',amount_tendered:6,change_due:0.2,idempotency_key:randomUUID()};
        const sale=await request(app).post('/api/pos/checkout').set('Cookie',cashierCookie).send(payload);
        expect(sale.status,JSON.stringify(sale.body)).toBe(200);
        const old=daysAgo(day,40),invoiceId=sale.body.invoice_id;
        await pool.query('UPDATE orders SET created_at=?,invoice_issued_at=? WHERE invoice_id=?',[old+' 10:00:00',old+' 10:00:00',invoiceId]);
        await publishPeriod(old);
        const before=await reads.getPublishedAnalysis(pool,{startDate:old,endDate:old});expect(before.totals.net_revenue).toBe(5);
        const edited=await request(app).post('/api/pos/checkout').set('Cookie',adminCookie).send({...payload,
            edit_invoice_id:invoiceId,edit_order_id:sale.body.order_id,idempotency_key:randomUUID(),cart:[{id:SEED.product1.id,qty:1,price:6}],subtotal:6,tax:0.96,total:6.96,amount_tendered:7,change_due:0.04});
        expect(edited.status,JSON.stringify(edited.body)).toBe(403);
        const current=await reads.getPublishedAnalysis(pool,{startDate:old,endDate:old});expect(current.totals.net_revenue).toBe(5);
        expect(current.freshness).toEqual(before.freshness);
    });

});
