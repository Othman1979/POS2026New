const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { reserveDailyOrderIdentity, alphabeticPrefix } = require('../../utils/orderSequence');
const { buildOrderIdentity } = require('../../utils/orderIdentity');

describe('daily numbering per order type', () => {
    let cookie;
    beforeEach(async () => {
        await seedDatabase();
        await pool.query('UPDATE order_types SET requires_hash=0');
        await pool.query("INSERT INTO order_types(id,name) VALUES(3,'Y'),(4,'Delivery'),(5,'Takeaway')");
        cookie = (await request(app).post('/api/auth/login').send({user_number:SEED.adminUser.user_number})).headers['set-cookie'][0];
    });
    afterAll(() => pool.end());
    afterEach(() => vi.useRealTimers());
    const setting = value => request(app).post('/api/system/settings').set('Cookie',cookie).send({order_type_numbering:value});
    const reserve = async (type, day='2026-09-12', rollback=false) => {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const result = await reserveDailyOrderIdentity(conn,{businessDate:day,orderTypeId:type});
            if (rollback) await conn.rollback(); else await conn.commit();
            return result;
        } finally { await conn.rollback(); conn.release(); }
    };
    const sale = (type,extra={}) => request(app).post('/api/pos/checkout').set('Cookie',cookie).send({
        cart:[{id:SEED.product1.id,qty:1,price:5}],order_type_id:type,order_type_is_deferred_settlement:false,
        subtotal:5,tax:0.8,total:5.8,payment_method:'cash',amount_tendered:5.8,change_due:0,
        idempotency_key:randomUUID(),...extra
    });
    const hold = type => request(app).post('/api/pos/held_orders').set('Cookie',cookie).send({
        hold_request_id:randomUUID(),subtotal:5,
        cart:{order_type_id:type,items:[{id:SEED.product1.id,product_id:SEED.product1.id,name:SEED.product1.name,qty:1,price:5}]}
    });

    it('defaults off, validates the setting, and retains the shared counter', async () => {
        const settings=await request(app).get('/api/system/settings').set('Cookie',cookie);
        expect(settings.body.order_type_numbering).toBe('0');
        expect((await setting('invalid')).status).toBe(400);
        expect((await reserve(1)).order_display_no).toBe('1');
        expect((await reserve(3)).order_display_no).toBe('2');
    });
    it('assigns A through E in configured order regardless of which type is used first', async () => {
        expect((await setting('1')).status).toBe(200);
        expect((await reserve(3)).order_display_no).toBe('C-1');
        expect((await reserve(1)).order_display_no).toBe('A-1');
        expect((await reserve(2)).order_display_no).toBe('B-1');
        expect((await reserve(3)).order_display_no).toBe('C-2');
        expect((await reserve(5)).order_display_no).toBe('E-1');
        expect((await reserve(4)).order_display_no).toBe('D-1');
        expect(alphabeticPrefix(26)).toBe('Z');
        expect(alphabeticPrefix(27)).toBe('AA');
    });
    it('serializes concurrent reservations, rolls back, and resets at the business-date boundary', async () => {
        await setting('1');
        const results=await Promise.all([reserve(1),reserve(2),reserve(1),reserve(2),reserve(1)]);
        expect(results.map(r=>r.order_display_no).sort()).toEqual(['A-1','A-2','A-3','B-1','B-2']);
        expect((await reserve(1,'2026-09-12',true)).order_display_no).toBe('A-4');
        expect((await reserve(1)).order_display_no).toBe('A-4');
        expect((await reserve(1,'2026-09-13')).order_display_no).toBe('A-1');
    });
    it('cancels a Y hold without consuming another type number or reusing its issued number', async () => {
        await setting('1');
        const held=await hold(3);
        expect(held.status,JSON.stringify(held.body)).toBe(200);
        expect(held.body.order_display_no).toBe('C-1');
        const claim=await request(app).post(`/api/pos/held_orders/${held.body.id}/claim`).set('Cookie',cookie)
            .send({claim_token:'b'.repeat(64),expected_version:1});
        expect(claim.status,JSON.stringify(claim.body)).toBe(200);
        const cancel=await request(app).delete(`/api/pos/held_orders/${held.body.id}`).set('Cookie',cookie).send({
            operation_id:randomUUID(),expected_version:claim.body.claim.version,claim_token:claim.body.claim.claimToken,
            confirmed:true,reason_code:'customer_changed_mind'
        });
        expect(cancel.status,JSON.stringify(cancel.body)).toBe(200);
        expect((await sale(1)).body.order_display_no).toBe('A-1');
        expect((await hold(3)).body.order_display_no).toBe('C-2');
    });
    it('recovers a waiting allocator when the connection owning the first daily map is lost', async () => {
        await setting('1');
        const owner=await pool.getConnection();
        const waiting=await pool.getConnection();
        let ownerDestroyed=false;
        try {
            await owner.beginTransaction();
            expect((await reserveDailyOrderIdentity(owner,{businessDate:'2026-09-12',orderTypeId:3})).order_display_no).toBe('C-1');
            await waiting.beginTransaction();
            let notifyWaiting;
            const entered=new Promise(resolve=>{notifyWaiting=resolve;});
            const query=waiting.query.bind(waiting);
            const waiter={query:(sql,params)=>{const result=query(sql,params);if(sql.includes('INSERT INTO daily_sequences')) notifyWaiting();return result;}};
            const reservation=reserveDailyOrderIdentity(waiter,{businessDate:'2026-09-12',orderTypeId:3});
            await entered;
            owner.destroy();ownerDestroyed=true;
            expect((await reservation).order_display_no).toBe('C-1');
            await waiting.commit();
            expect((await reserve(1)).order_display_no).toBe('A-1');
            expect((await reserve(3)).order_display_no).toBe('C-2');
        } finally {
            if(!ownerDestroyed){await owner.rollback();owner.release();}
            await waiting.rollback();waiting.release();
        }
    });
    it('shares one type counter across simultaneous held-order creation and checkout', async () => {
        await setting('1');
        const responses=await Promise.all(Array.from({length:16},(_,index)=>index%2 ? hold(3) : sale(3)));
        expect(responses.map(row=>row.status),JSON.stringify(responses.map(row=>row.body))).toEqual(Array(16).fill(200));
        expect(responses.map(row=>row.body.order_display_no).sort()).toEqual(Array.from({length:16},(_,index)=>`C-${index+1}`).sort());
        const [[paid]]=await pool.query('SELECT COUNT(*) n,SUM(total) total FROM orders');
        expect(Number(paid.n)).toBe(8);
        expect(Number(paid.total)).toBe(46.4);
        expect((await sale(1)).body.order_display_no).toBe('A-1');
        expect((await hold(3)).body.order_display_no).toBe('C-17');
    });
    it('uses the business cutoff for real checkouts and keeps an older hold identity across it', async () => {
        const {getBusinessDate,getBusinessDayRange,addBusinessDays,parseBackendTimestamp}=require('../../utils/businessDate');
        // MySQL's authentication clock remains real. A future boundary avoids
        // manufacturing already-expired sessions when only JS Date is controlled.
        const boundary=parseBackendTimestamp(getBusinessDayRange(addBusinessDays(getBusinessDate(),2)).start).getTime();
        await setting('1');
        vi.useFakeTimers({toFake:['Date']});
        vi.setSystemTime(boundary-60000);
        cookie=(await request(app).post('/api/auth/login').send({user_number:SEED.adminUser.user_number})).headers['set-cookie'][0];
        const beforeCutoff=await sale(1);
        expect(beforeCutoff.status,JSON.stringify(beforeCutoff.body)).toBe(200);
        expect(beforeCutoff.body.order_display_no).toBe('A-1');
        const held=await hold(3);
        expect(held.body.order_display_no).toBe('C-1');
        const [[oldHold]]=await pool.query('SELECT order_seq_scope FROM held_orders WHERE id=?',[held.body.id]);
        vi.setSystemTime(boundary+60000);
        const afterCutoff=await sale(1);
        expect(afterCutoff.status,JSON.stringify(afterCutoff.body)).toBe(200);
        expect(afterCutoff.body.order_display_no).toBe('A-1');
        const newHold=await hold(3);
        expect(newHold.status,JSON.stringify(newHold.body)).toBe(200);
        expect(newHold.body.order_display_no).toBe('C-1');
        const claim=await request(app).post(`/api/pos/held_orders/${held.body.id}/claim`).set('Cookie',cookie)
            .send({claim_token:'c'.repeat(64),expected_version:1});
        expect(claim.status,JSON.stringify(claim.body)).toBe(200);
        const paid=await sale(3,{held_order_context:{id:held.body.id,claim_token:claim.body.claim.claimToken,
            expected_version:claim.body.claim.version,operation_id:randomUUID()}});
        expect(paid.status,JSON.stringify(paid.body)).toBe(200);
        const [[order]]=await pool.query('SELECT order_seq_scope FROM orders WHERE invoice_id=?',[paid.body.invoice_id]);
        expect(order.order_seq_scope).toBe(oldHold.order_seq_scope);
    });
    it('does not consume a typed number on a failed checkout and commits simultaneous retries once', async () => {
        await setting('1');
        const bad=await sale(4,{amount_tendered:0});
        expect(bad.status).toBe(400);
        const key=randomUUID();
        const responses=await Promise.all(Array.from({length:4},()=>sale(4,{idempotency_key:key})));
        expect(responses.map(r=>r.status)).toEqual([200,200,200,200]);
        expect(new Set(responses.map(r=>r.body.invoice_id)).size).toBe(1);
        expect(responses.every(r=>r.body.order_display_no==='D-1')).toBe(true);
        expect((await sale(4)).body.order_display_no).toBe('D-2');
    });
    it.each(['before', 'after'])('recovers the same typed checkout when its DB connection is destroyed %s commit', async stage => {
        await setting('1');
        const key=randomUUID();
        const originalGetConnection=pool.getConnection.bind(pool);
        let intercepted=false, commitSpy;
        const connectionSpy=vi.spyOn(pool,'getConnection').mockImplementation(async()=>{
            const conn=await originalGetConnection();
            if(!intercepted) {
                intercepted=true;
                const commit=conn.commit.bind(conn);
                commitSpy=vi.spyOn(conn,'commit').mockImplementation(async()=>{
                    if(stage==='after') await commit();
                    conn.destroy();
                    const error=new Error('Synthetic lost database connection at commit');
                    error.code='ECONNRESET';
                    throw error;
                });
            }
            return conn;
        });
        try {
            const uncertain=await sale(4,{idempotency_key:key});
            expect(uncertain.status).toBe(500);
        } finally {commitSpy?.mockRestore();connectionSpy.mockRestore();}
        const [[beforeRetry]]=await pool.query('SELECT COUNT(*) n FROM orders WHERE idempotency_key=?',[key]);
        expect(Number(beforeRetry.n)).toBe(stage==='after'?1:0);
        const recovered=await sale(4,{idempotency_key:key});
        expect(recovered.status,JSON.stringify(recovered.body)).toBe(200);
        expect(recovered.body.order_display_no).toBe('D-1');
        const replay=await sale(4,{idempotency_key:key});
        expect(replay.body.invoice_id).toBe(recovered.body.invoice_id);
        const [[saved]]=await pool.query('SELECT COUNT(*) n,SUM(total) total FROM orders WHERE idempotency_key=?',[key]);
        expect(Number(saved.n)).toBe(1);
        expect(Number(saved.total)).toBe(5.8);
        expect((await sale(4)).body.order_display_no).toBe('D-2');
    });
    it('freezes issued prefixes through catalog changes and resumes each mode without collisions', async () => {
        await setting('1');
        const original=await reserve(3);
        await pool.query('DELETE FROM order_types WHERE id=2');
        await pool.query("UPDATE order_types SET name='Renamed' WHERE id=3");
        await pool.query("INSERT INTO order_types(id,name) VALUES(6,'New')");
        expect((await reserve(3)).order_display_no).toBe('C-2');
        expect((await reserve(6)).order_display_no).toBe('F-1');
        await setting('0');
        expect((await reserve(1)).order_display_no).toBe('1');
        await setting('1');
        expect((await reserve(3)).order_display_no).toBe('C-3');
        expect(buildOrderIdentity(original).order_display_no).toBe('C-1');
        expect((await reserve(3,'2026-09-13')).order_display_no).toBe('B-1');
    });
    it('upgrades the exact predecessor and verifies a repeatable no-op without changing old order numbers', async () => {
        const fs = require('node:fs');
        const path = require('node:path');
        const crypto = require('node:crypto');
        const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
        const { validateRequiredSchema } = require('../../services/schemaValidation');
        const manifest = require('../../migrations/auto-manifest.json');
        const entry = manifest.migrations.find(migration => migration.name === '2026-09-12-order-type-numbering-v1');
        const sql = fs.readFileSync(path.join(__dirname,'../../migrations',entry.file),'utf8').replace(/\r\n/g,'\n');
        expect(entry.sha256).toBe(crypto.createHash('sha256').update(sql).digest('hex'));
        const fallback = fs.readFileSync(path.join(__dirname,'../../../deployment/database/hostinger-manual-migrations.sql'),'utf8').replace(/\r\n/g,'\n');
        expect(fallback).toContain(sql.trim());
        const original=await sale(1);
        expect(original.status,JSON.stringify(original.body)).toBe(200);
        await pool.query('DROP TABLE daily_order_type_sequences');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?',[entry.name]);
        await pool.query("DELETE FROM settings WHERE setting_key='order_type_numbering'");
        const [[previous]]=await pool.query('SELECT checksum FROM schema_migrations WHERE migration_name=?',[entry.requires.name]);
        expect(previous.checksum).toBe(entry.requires.checksum);
        const migrated=await runPendingMigrations(pool);
        expect(migrated.applied).toContain(entry.name);
        await validateRequiredSchema(pool);
        expect((await runPendingMigrations(pool)).applied).toEqual([]);
        const [[order]]=await pool.query('SELECT * FROM orders WHERE invoice_id=?',[original.body.invoice_id]);
        expect(buildOrderIdentity(order).order_display_no).toBe(original.body.order_display_no);
        expect((await request(app).get('/api/system/settings').set('Cookie',cookie)).body.order_type_numbering).toBe('0');
    });
    it('numbers a table only at settlement and preserves the prefix on later detail reads', async () => {
        await setting('1');
        const saved=await request(app).post('/api/pos/table_order').set('Cookie',cookie).send({
            table_id:1,order_type_id:2,cart:[{id:SEED.product1.id,qty:1,price:5}],subtotal:5,tax:0.8,total:5.8
        });
        expect(saved.status,JSON.stringify(saved.body)).toBe(200);
        expect.soft(saved.body.order_type_id).toBe(2);
        const loaded=await request(app).get(`/api/pos/table_order?order_id=${saved.body.invoice_id}`).set('Cookie',cookie);
        expect.soft(loaded.body.order_type_id).toBe(2);
        const floor=await request(app).get('/api/pos/get_tables').set('Cookie',cookie);
        expect.soft(floor.body.tables.find(row=>row.id===1).order_type_id).toBe(2);
        const [[draft]]=await pool.query('SELECT * FROM orders WHERE invoice_id=?',[saved.body.invoice_id]);
        expect(draft.order_id).toBeNull();
        const paid=await sale(2,{edit_invoice_id:draft.invoice_id,table_id:1});
        expect(paid.status,JSON.stringify(paid.body)).toBe(200);
        expect(paid.body.order_display_no).toBe('B-1');
        const detail=await request(app).get(`/api/admin/order_details?id=${draft.invoice_id}`).set('Cookie',cookie);
        expect(detail.status,JSON.stringify(detail.body)).toBe(200);
        expect(detail.body.order.order_display_no).toBe('B-1');
    });
    it('preserves a numbered table reference in single and batch realtime updates', async () => {
        const { broadcastTableUpdate, broadcastTableUpdates } = require('../../services/TableRealtime');
        await setting('1');
        const saved=await request(app).post('/api/pos/table_order').set('Cookie',cookie).send({
            table_id:1,order_type_id:2,cart:[{id:SEED.product1.id,qty:1,price:5}],subtotal:5,tax:0.8,total:5.8
        });
        expect(saved.status,JSON.stringify(saved.body)).toBe(200);
        // A retained numbered table uses the same public identity on refresh and sockets.
        const number=await reserve(2);
        await pool.query('UPDATE orders SET order_id=?,order_seq_scope=? WHERE invoice_id=?',
            [number.order_id,number.order_seq_scope,saved.body.invoice_id]);
        const loaded=await request(app).get(`/api/pos/table_order?order_id=${saved.body.invoice_id}`).set('Cookie',cookie);
        expect(loaded.body.order_display_no).toBe('B-1');
        const updates=[];
        const io={to:()=>({emit:(_event,payload)=>updates.push(payload.table)})};
        await broadcastTableUpdate(io,1);
        await broadcastTableUpdates(io,[1,2]);
        expect(updates.filter(row=>row.id===1).map(row=>[row.order_display_no,row.ticket_display_no]))
            .toEqual([['B-1','B-1'],['B-1','B-1']]);
        expect(updates.filter(row=>row.id===1).map(row=>row.order_type_id)).toEqual([2,2]);
        const paid=await sale(2,{table_id:1,edit_invoice_id:saved.body.invoice_id});
        expect(paid.status,JSON.stringify(paid.body)).toBe(200);
        expect(paid.body.order_display_no).toBe('B-1');
    });
    it('uses the saved table type when settlement does not repeat the type', async () => {
        await setting('1');
        const saved=await request(app).post('/api/pos/table_order').set('Cookie',cookie).send({
            table_id:1,order_type_id:4,cart:[{id:1,qty:1,price:5}],subtotal:5,tax:0.8,total:5.8
        });
        expect(saved.status,JSON.stringify(saved.body)).toBe(200);
        const paid=await sale(null,{table_id:1,edit_invoice_id:saved.body.invoice_id});
        expect(paid.status,JSON.stringify(paid.body)).toBe(200);
        expect(paid.body.order_display_no).toBe('D-1');
        const [[order]]=await pool.query('SELECT order_type_id FROM orders WHERE invoice_id=?',[paid.body.invoice_id]);
        expect(order.order_type_id).toBe(4);
    });
    it('keeps the parent type for both split seats regardless of another register selection', async () => {
        await setting('1');
        const saved=await request(app).post('/api/pos/table_order').set('Cookie',cookie).send({
            table_id:1,order_type_id:4,cart:[{id:1,qty:2,price:5}],subtotal:10,tax:1.6,total:11.6
        });
        expect(saved.status,JSON.stringify(saved.body)).toBe(200);
        const [[line]]=await pool.query('SELECT id FROM order_items WHERE invoice_id=?',[saved.body.invoice_id]);
        const items=[{id:1,qty:1,price:5,tax_rate:16,order_item_id:line.id}];
        const split=await request(app).post('/api/pos/table_splits/split').set('Cookie',cookie).send({
            tableId:1,currentOrderId:saved.body.invoice_id,
            splits:[{referenceName:'Seat one',subtotal:5.8,items},{referenceName:'Seat two',subtotal:5.8,items}]
        });
        expect(split.status,JSON.stringify(split.body)).toBe(200);
        const [seats]=await pool.query('SELECT id,cart_data FROM held_orders ORDER BY id');
        expect(seats.map(row=>JSON.parse(row.cart_data).order_type_id)).toEqual([4,4]);
        const paid=[];
        for(const [index,seat] of seats.entries()) {
            const result=await sale(index===0 ? null : 1,{table_id:1,split_check_id:seat.id,cart:items});
            expect(result.status,JSON.stringify(result.body)).toBe(200);paid.push(result.body);
        }
        expect(paid.map(r=>r.order_display_no)).toEqual(['D-1','D-2']);
        const [orders]=await pool.query('SELECT order_type_id,total FROM orders WHERE invoice_id IN (?)',[paid.map(r=>r.invoice_id)]);
        expect(orders.every(r=>r.order_type_id===4 && Number(r.total)===5.8)).toBe(true);
    });
    it('rejects invalid table types atomically and preserves the saved type when an edit omits it', async () => {
        await setting('1');
        const body={table_id:1,cart:[{id:1,qty:1,price:5}],subtotal:5,tax:0.8,total:5.8};
        for(const [type,status] of [['bad',400],[0,400],[1.5,400],[99999,409]]) {
            const result=await request(app).post('/api/pos/table_order').set('Cookie',cookie).send({...body,order_type_id:type});
            expect(result.status,JSON.stringify(result.body)).toBe(status);
        }
        const [[untouched]]=await pool.query('SELECT COUNT(*) AS n FROM orders');
        expect(Number(untouched.n)).toBe(0);
        const saved=await request(app).post('/api/pos/table_order').set('Cookie',cookie).send({...body,order_type_id:4});
        expect(saved.status,JSON.stringify(saved.body)).toBe(200);
        const edit=await request(app).post('/api/pos/table_order').set('Cookie',cookie)
            .send({...body,current_order_id:saved.body.invoice_id, expected_version: await currentTableRevision(saved.body.invoice_id)});
        expect(edit.status,JSON.stringify(edit.body)).toBe(200);
        const [[order]]=await pool.query('SELECT order_type_id,order_id FROM orders WHERE invoice_id=?',[saved.body.invoice_id]);
        expect(order).toEqual({order_type_id:4,order_id:null});
        const paid=await sale(null,{table_id:1,edit_invoice_id:saved.body.invoice_id});
        expect(paid.body.order_display_no).toBe('D-1');
    });
    it('keeps a held reference through checkout, retries, reads, search and compiled prints', async () => {
        await setting('1');
        await pool.query("INSERT INTO settings(setting_key,setting_value) VALUES('print_method','backend') ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)");
        const [kitchen]=await pool.query("INSERT INTO printers(name,role,type,windows_name,spooler_id) VALUES('Kitchen','kitchen','windows','Kitchen','type-number-test')");
        await pool.query('INSERT INTO printer_categories(printer_id,category_id) VALUES(?,?)',[kitchen.insertId,SEED.category.id]);
        await pool.query("INSERT INTO printers(name,role,type,windows_name,spooler_id) VALUES('Customer','receipt','windows','Customer','type-number-test')");
        const held=await hold(3);
        expect(held.status,JSON.stringify(held.body)).toBe(200);
        expect(held.body.order_display_no).toBe('C-1');
        const listed=await request(app).get('/api/pos/held_orders').set('Cookie',cookie);
        expect(listed.body.data.find(r=>r.id===held.body.id).order_display_no).toBe('C-1');
        const normal=await sale(1);
        expect(normal.status,JSON.stringify(normal.body)).toBe(200);
        expect(normal.body.order_display_no).toBe('A-1');
        const claim=await request(app).post(`/api/pos/held_orders/${held.body.id}/claim`).set('Cookie',cookie)
            .send({claim_token:'a'.repeat(64),expected_version:1});
        expect(claim.status,JSON.stringify(claim.body)).toBe(200);
        const extra={idempotency_key:randomUUID(),held_order_context:{id:held.body.id,claim_token:claim.body.claim.claimToken,expected_version:claim.body.claim.version,operation_id:randomUUID()}};
        const paid=await sale(3,extra), retry=await sale(3,extra);
        expect(paid.status,JSON.stringify(paid.body)).toBe(200);
        expect(retry.body.order_display_no).toBe('C-1');
        expect(paid.body.order_display_no).toBe('C-1');
        expect(Number(paid.body.invoice_number)).toBe(Number(normal.body.invoice_number)+1);
        const search=await request(app).get('/api/admin/orders?order=C-1').set('Cookie',cookie);
        expect(search.status,JSON.stringify(search.body)).toBe(200);
        expect(search.body.orders.map(r=>r.order_display_no)).toEqual(['C-1']);
        await setting('0');
        const reprint=await request(app).post('/api/print/print').set('Cookie',cookie)
            .send({print_type:'receipt',invoice_id:paid.body.invoice_id});
        expect(reprint.status,JSON.stringify(reprint.body)).toBe(200);
        expect(reprint.body.success,JSON.stringify(reprint.body)).toBe(true);
        const [jobs]=await pool.query('SELECT payload FROM print_queue');
        const payloads=jobs.map(j=>typeof j.payload==='string'?JSON.parse(j.payload):j.payload);
        expect(payloads.length).toBeGreaterThanOrEqual(2);
        const heldPayloads=payloads.filter(p=>p.data?.held_order || p.data?.held_order_receipt);
        expect(heldPayloads.length).toBeGreaterThanOrEqual(2);
        for(const p of heldPayloads) {
            expect(p.data.order_display_no).toBe('C-1');
            expect(p.data.compiled_document_v1.html).toContain('C-1');
        }
        const paidReceipt=payloads.find(p=>Number(p.data?.invoice_id)===Number(paid.body.invoice_id) && !p.data?.held_order_receipt && !p.data?.held_order);
        expect(paidReceipt.data.order_display_no).toBe('C-1');
        expect(paidReceipt.data.compiled_document_v1.html).toContain('C-1');
    });
});
