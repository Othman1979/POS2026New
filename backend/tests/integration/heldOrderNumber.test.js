const request = require('supertest');
const {randomUUID} = require('node:crypto');
const {app} = require('../../../server');
const pool = require('../../config/db');
const {seedDatabase,SEED} = require('../fixtures/seed');
const {getBuiltinTemplate} = require('../../services/printTemplateDefaults');
const {createHash} = require('node:crypto');

describe('numbered held orders', () => {
    let cookie;
    beforeEach(async () => {
        await seedDatabase();
        await pool.query("INSERT INTO settings(setting_key,setting_value) VALUES('shared_order_sequence','1'),('print_method','backend'),('store_name','Test Restaurant') ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)");
        const [kitchen]=await pool.query("INSERT INTO printers(name,role,type,windows_name,spooler_id) VALUES('Kitchen','kitchen','windows','Kitchen','held-number-test')");
        await pool.query('INSERT INTO printer_categories(printer_id,category_id) VALUES(?,?)',[kitchen.insertId,SEED.category.id]);
        await pool.query("INSERT INTO printers(name,role,type,windows_name,spooler_id) VALUES('Customer','receipt','windows','Customer','held-number-test')");
        const login=await request(app).post('/api/auth/login').send({user_number:SEED.adminUser.user_number});
        cookie=login.headers['set-cookie'][0];
    });
    afterAll(()=>pool.end());
    const input=(extra={})=>({hold_request_id:randomUUID(),reference_name:'Private reference',subtotal:5,
        cart:{items:[{id:SEED.product1.id,product_id:SEED.product1.id,name:SEED.product1.name,qty:1,price:5}],...extra}});
    const hold=data=>request(app).post('/api/pos/held_orders').set('Cookie',cookie).send(data);

    it.each(['0', '1'])('reuses the checkout settings snapshot when numbering an immediate hold (mode %s)', async mode => {
        await pool.query("INSERT INTO settings(setting_key,setting_value) VALUES('order_type_numbering',?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)", [mode]);
        const queries = [];
        const querySpies = [];
        const getConnection = pool.getConnection.bind(pool);
        const connectionSpy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
            const conn = await getConnection();
            const query = conn.query.bind(conn);
            querySpies.push(vi.spyOn(conn, 'query').mockImplementation((sql, args) => {
                queries.push(String(sql));
                return query(sql, args);
            }));
            return conn;
        });
        try {
            const created = await hold(input());
            expect(created.status).toBe(200);
            expect(created.body.order_display_no).toMatch(mode === '1' ? /^[A-Z]+-1$/ : /^1$/);
            expect(queries.filter(sql => /SELECT setting_value FROM settings WHERE setting_key='order_type_numbering'/.test(sql))).toHaveLength(0);
        } finally {
            for (const spy of querySpies.reverse()) spy.mockRestore();
            connectionSpy.mockRestore();
        }
    });

    it('numbers an immediate hold and queues customer and kitchen copies without creating an invoice', async () => {
        const result=await hold(input());
        expect(result.status).toBe(200);
        expect(result.body.order_display_no).toBe('1');
        const listed=await request(app).get('/api/pos/held_orders').set('Cookie',cookie);
        expect(listed.body.data.find(row=>row.id===result.body.id).order_id).toBe(1);
        const [jobs]=await pool.query('SELECT print_type,payload FROM print_queue ORDER BY id');
        expect(jobs.map(j=>j.print_type).sort()).toEqual(['kitchen','receipt']);
        for(const job of jobs){
            const payload=typeof job.payload==='string'?JSON.parse(job.payload):job.payload;
            expect(payload.data.order_display_no).toBe('1');
            expect(payload.data.invoice_display_no).toBeNull();
            expect(payload.data.ticket_display_no).toBeNull();
            expect(payload.data.reference_name).toBeUndefined();
            if (job.print_type === 'kitchen') {
                expect(payload.data.compiled_document_v1.html).toContain('Order:');
                expect(payload.data.compiled_document_v1.html).not.toMatch(/Ticket:|Invoice:/);
            }
        }
        const [[orders]]=await pool.query('SELECT COUNT(*) count FROM orders');
        expect(Number(orders.count)).toBe(0);
    });
    it('replays the original hold without consuming a number or duplicating print jobs', async () => {
        const data=input();
        const first=await hold(data),retry=await hold(data),second=await hold(input());
        expect(retry.body.id).toBe(first.body.id);
        expect(retry.body.order_display_no).toBe('1');
        expect(second.body.order_display_no).toBe('2');
        const [[jobs]]=await pool.query('SELECT COUNT(*) count FROM print_queue');
        expect(Number(jobs.count)).toBe(4);
    });
    it('leaves future scheduled holds unnumbered and unprinted until explicitly sent', async () => {
        const result=await hold(input({delivery_date:'2099-09-09T18:30'}));
        expect(result.status).toBe(200);
        expect(result.body.order_display_no).toBeNull();
        const [[jobs]]=await pool.query('SELECT COUNT(*) count FROM print_queue');
        expect(Number(jobs.count)).toBe(0);
        const immediate=await hold(input());
        expect(immediate.body.order_display_no).toBe('1');
    });
    const printHold=(id,print_request_id=randomUUID(),extra={})=>request(app).post(`/api/pos/held_orders/${id}/print_receipt`).set('Cookie',cookie).send({print_request_id,...extra});
    const checkout=(extra={})=>request(app).post('/api/pos/checkout').set('Cookie',cookie).send({
        cart:[{id:SEED.product1.id,qty:1,price:5,tax_rate:16}],shift_id:null,
        subtotal:5,tax:0.8,total:5.8,payment_method:'cash',amount_tendered:5.8,change_due:0,
        idempotency_key:randomUUID(),...extra
    });
    it('shares the counter with checkout and retains the held number when paid and retried', async()=>{
        const held=await hold(input());
        const normal=await checkout();
        expect(normal.status,JSON.stringify(normal.body)).toBe(200);
        const claim=await request(app).post(`/api/pos/held_orders/${held.body.id}/claim`).set('Cookie',cookie)
            .send({claim_token:'a'.repeat(64),expected_version:1});
        expect(claim.status,JSON.stringify(claim.body)).toBe(200);
        const extra={held_order_context:{id:held.body.id,claim_token:claim.body.claim.claimToken,
            expected_version:claim.body.claim.version,operation_id:randomUUID()},idempotency_key:randomUUID()};
        const paid=await checkout(extra),retry=await checkout(extra),next=await checkout();
        expect(paid.status,JSON.stringify(paid.body)).toBe(200);
        expect(retry.status,JSON.stringify(retry.body)).toBe(200);
        expect(next.status,JSON.stringify(next.body)).toBe(200);
        const [orders]=await pool.query('SELECT order_id,order_seq_scope,invoice_number FROM orders ORDER BY invoice_id');
        expect(orders.map(row=>row.order_id)).toEqual([2,1,3]);
        expect(orders.every(row=>row.invoice_number!=null)).toBe(true);
        expect((await printHold(held.body.id)).status).toBe(404);
    });
    it('manual prints and simultaneous retries keep one number and one job per request',async()=>{
        const held=await hold(input({delivery_date:'2099-09-09T18:30'}));
        const key=randomUUID();
        const replies=await Promise.all([printHold(held.body.id,key),printHold(held.body.id,key)]);
        for(const reply of replies){expect(reply.status,JSON.stringify(reply.body)).toBe(200);expect(reply.body.order_display_no).toBe('1');}
        const second=await printHold(held.body.id);
        expect(second.body.order_display_no).toBe('1');
        const [[jobs]]=await pool.query("SELECT COUNT(*) count FROM print_queue WHERE print_type='receipt'");
        expect(Number(jobs.count)).toBe(2);
        expect((await hold(input())).body.order_display_no).toBe('2');
    });
    it('rolls back a first number when manual printer selection fails',async()=>{
        const held=await hold(input({delivery_date:'2099-09-09T18:30'}));
        expect((await printHold(held.body.id,randomUUID(),{receipt_printer_id:99999})).status).toBe(409);
        const [[row]]=await pool.query('SELECT order_id FROM held_orders WHERE id=?',[held.body.id]);
        expect(row.order_id).toBeNull();
        expect((await hold(input())).body.order_display_no).toBe('1');
    });
    it('keeps the hold and reports a missing automatic receipt printer',async()=>{
        await pool.query("DELETE FROM printers WHERE role='receipt'");
        const held=await hold(input());
        expect(held.status,JSON.stringify(held.body)).toBe(200);
        expect(held.body.customer_receipt.mode).toBe('unavailable');
        expect(held.body.order_display_no).toBe('1');
        expect((await printHold(held.body.id)).status).toBe(409);
    });
    it('renders an unpaid browser receipt with only its order number',async()=>{
        await pool.query("UPDATE settings SET setting_value='browser' WHERE setting_key='print_method'");
        const held=await hold(input());
        expect(held.status,JSON.stringify(held.body)).toBe(200);
        const receipt=held.body.customer_receipt;
        expect(receipt.mode).toBe('browser');
        expect(receipt.data.provisional).toBe(true);
        const html=receipt.data.compiled_document_v1.html;
        expect(html).toContain('Order:');
        expect(html).not.toMatch(/GUEST CHECK|Invoice:|Ticket:|Private reference|Payment|Tendered|Change/);
        expect(html).toContain(SEED.product1.name);
        expect(receipt.data.receipt_display_v1.summary.total).toBe(5.8);
        expect((await printHold(held.body.id)).body.order_display_no).toBe('1');
    });
    it('serializes simultaneous new holds without duplicate daily numbers',async()=>{
        const replies=await Promise.all(Array.from({length:5},()=>hold(input())));
        for(const reply of replies)expect(reply.status,JSON.stringify(reply.body)).toBe(200);
        expect(replies.map(reply=>Number(reply.body.order_display_no)).sort()).toEqual([1,2,3,4,5]);
    });
    it('ignores forged print identities and rejects anonymous print requests',async()=>{
        const held=await hold(input());
        const printed=await printHold(held.body.id,randomUUID(),{order_id:999,invoice_id:999,reference_name:'Forged'});
        expect(printed.body.order_display_no).toBe('1');
        expect((await request(app).post(`/api/pos/held_orders/${held.body.id}/print_receipt`).send({print_request_id:randomUUID()})).status).toBe(401);
    });

    it('numbers a scheduled hold on first kitchen fire and reuses it for its customer receipt',async()=>{
        const held=await hold(input({delivery_date:'2099-09-09T18:30'}));
        const fired=await request(app).post('/api/pos/held_orders/fire_kitchen').set('Cookie',cookie)
            .send({id:held.body.id,expected_version:1,operation_id:randomUUID()});
        expect(fired.status,JSON.stringify(fired.body)).toBe(200);
        expect((await printHold(held.body.id)).body.order_display_no).toBe('1');
        expect((await hold(input())).body.order_display_no).toBe('2');
    });
    it('prints both copies when a scheduled hold becomes immediate, without duplicating a save retry',async()=>{
        const held=await hold(input({delivery_date:'2099-09-09T18:30'}));
        const claim=await request(app).post(`/api/pos/held_orders/${held.body.id}/claim`).set('Cookie',cookie)
            .send({claim_token:'c'.repeat(64),expected_version:1});
        const payload={cart:{...JSON.parse(claim.body.order.cart_data),delivery_date:null},subtotal:5,
            expected_version:claim.body.claim.version,claim_token:claim.body.claim.claimToken,operation_id:randomUUID()};
        const saved=await request(app).patch(`/api/pos/held_orders/${held.body.id}`).set('Cookie',cookie).send(payload);
        expect(saved.status,JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.order_display_no).toBe('1');
        expect(saved.body.customer_receipt.mode).toBe('backend');
        const retry=await request(app).patch(`/api/pos/held_orders/${held.body.id}`).set('Cookie',cookie).send(payload);
        expect(retry.status,JSON.stringify(retry.body)).toBe(200);
        const [[jobs]]=await pool.query('SELECT COUNT(*) count FROM print_queue');expect(Number(jobs.count)).toBe(2);
    });
    it.each(['date:2026-01-01','shift:555'])('retains historical number and scope %s through checkout',async(scope)=>{
        const held=await hold(input());
        await pool.query('UPDATE held_orders SET order_id=55,order_seq_scope=? WHERE id=?',[scope,held.body.id]);
        const claim=await request(app).post(`/api/pos/held_orders/${held.body.id}/claim`).set('Cookie',cookie)
            .send({claim_token:'d'.repeat(64),expected_version:1});
        const paid=await checkout({held_order_context:{id:held.body.id,claim_token:claim.body.claim.claimToken,
            expected_version:claim.body.claim.version,operation_id:randomUUID()}});
        expect(paid.status,JSON.stringify(paid.body)).toBe(200);
        const [[order]]=await pool.query('SELECT order_id,order_seq_scope FROM orders');
        expect(order).toMatchObject({order_id:55,order_seq_scope:scope});
        expect((await hold(input())).body.order_display_no).toBe('2');
    });
    it('ignores a stale disabled setting and shares the daily counter with cashier checkout',async()=>{
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='shared_order_sequence'");
        const login=await request(app).post('/api/auth/login').send({user_number:SEED.cashierUser.user_number});cookie=login.headers['set-cookie'][0];
        const opened=await request(app).post('/api/auth/shifts?action=open').set('Cookie',cookie).send({user_id:SEED.cashierUser.id,starting_cash:0});
        expect(opened.status,JSON.stringify(opened.body)).toBe(200);
        const [[shift]]=await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'",[SEED.cashierUser.id]);
        const held=await hold({...input(),shift_id:shift.id});expect(held.body.order_display_no).toBe('1');
        const paid=await checkout({shift_id:shift.id});expect(paid.status,JSON.stringify(paid.body)).toBe(200);
        const [[order]]=await pool.query('SELECT order_id,order_seq_scope FROM orders');
        expect(order).toMatchObject({order_id:2,order_seq_scope:`date:${require('../../utils/businessDate').getBusinessDate()}`});
    });
    it.each([null, '0', '1'])('shares shiftless holds and cashier sales with obsolete setting %s', async (value) => {
        await pool.query("DELETE FROM settings WHERE setting_key='shared_order_sequence'");
        if(value !== null) await pool.query("INSERT INTO settings(setting_key,setting_value) VALUES('shared_order_sequence',?)", [value]);
        const held = await hold(input());
        expect(held.status,JSON.stringify(held.body)).toBe(200);
        expect(held.body.order_display_no).toBe('1');
        const login = await request(app).post('/api/auth/login').send({user_number:SEED.cashierUser.user_number});
        cookie = login.headers['set-cookie'][0];
        await request(app).post('/api/auth/shifts?action=open').set('Cookie',cookie)
            .send({user_id:SEED.cashierUser.id,starting_cash:0});
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'",[SEED.cashierUser.id]);
        const paid = await checkout({shift_id:shift.id});
        expect(paid.status,JSON.stringify(paid.body)).toBe(200);
        const [[order]] = await pool.query('SELECT order_id,order_seq_scope FROM orders');
        const [[heldRow]] = await pool.query('SELECT order_seq_scope FROM held_orders WHERE id=?',[held.body.id]);
        expect(order.order_id).toBe(2);
        expect(order.order_seq_scope).toBe(heldRow.order_seq_scope);
        const ownerLogin=await request(app).post('/api/auth/login').send({user_number:SEED.adminUser.user_number});
        cookie=ownerLogin.headers['set-cookie'][0];
        expect((await printHold(held.body.id)).body.order_display_no).toBe('1');
    });

    it.each(['backend','browser'])('denies another cashier receipt access before numbering in %s mode', async mode => {
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='print_method'",[mode]);
        const held=await hold(input({delivery_date:'2099-09-09T18:30'}));
        const login=await request(app).post('/api/auth/login').send({user_number:SEED.cashierUser.user_number});
        cookie=login.headers['set-cookie'][0];
        const denied=await printHold(held.body.id);
        expect(denied.status,JSON.stringify(denied.body)).toBe(403);
        const [[row]]=await pool.query('SELECT order_id FROM held_orders WHERE id=?',[held.body.id]);
        expect(row.order_id).toBeNull();
        const [[count]]=await pool.query('SELECT COUNT(*) count FROM print_queue');
        expect(Number(count.count)).toBe(0);
        const owned=await hold(input());
        expect(owned.status,JSON.stringify(owned.body)).toBe(200);
        expect((await printHold(owned.body.id)).status).toBe(200);
        await pool.query("INSERT INTO user_permissions(user_id,perm_key) VALUES(?,'pos.reprint_receipt')",[SEED.cashierUser.id]);
        const refreshed=await request(app).post('/api/auth/login').send({user_number:SEED.cashierUser.user_number});
        cookie=refreshed.headers['set-cookie'][0];
        const allowed=await printHold(held.body.id);
        expect(allowed.status,JSON.stringify(allowed.body)).toBe(200);
        expect(allowed.body.order_display_no).toBe('2');
    });

    it.each(['browser','backend'])('recovers a lost unschedule response without duplicate jobs in %s mode', async mode => {
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='print_method'",[mode]);
        const held=await hold(input({delivery_date:'2099-09-09T18:30'}));
        const claim=await request(app).post(`/api/pos/held_orders/${held.body.id}/claim`).set('Cookie',cookie)
            .send({claim_token:'e'.repeat(64),expected_version:1});
        const payload={cart:{...JSON.parse(claim.body.order.cart_data),delivery_date:null},subtotal:5,
            expected_version:claim.body.claim.version,claim_token:claim.body.claim.claimToken,operation_id:randomUUID()};
        const save=()=>request(app).patch(`/api/pos/held_orders/${held.body.id}`).set('Cookie',cookie).send(payload);
        const original=await save();expect(original.status,JSON.stringify(original.body)).toBe(200);
        const [[before]]=await pool.query('SELECT COUNT(*) count FROM print_queue');
        const retry=await save();expect(retry.status,JSON.stringify(retry.body)).toBe(200);
        expect(retry.body.replay).toBe(true);
        expect(retry.body.order_display_no).toBe('1');
        if(mode==='browser') {
            expect(retry.body.customer_receipt?.mode).toBe('browser');
            expect(retry.body.customer_receipt.data.compiled_document_v1.html).toBe(original.body.customer_receipt.data.compiled_document_v1.html);
        } else expect(retry.body.customer_receipt).toBeNull();
        const [[after]]=await pool.query('SELECT COUNT(*) count FROM print_queue');
        expect(after).toEqual(before);
        // Retrying a later unchanged save must not introduce a new customer copy.
        const unchanged=await restoreAndSave(held.body.id);
        expect(unchanged.body.customer_receipt).toBeNull();
        expect((await hold(input())).body.order_display_no).toBe('2');
    });

    async function restoreAndSave(id, edit = cart => cart) {
        const [[row]] = await pool.query('SELECT version FROM held_orders WHERE id=?', [id]);
        const claim = await request(app).post(`/api/pos/held_orders/${id}/claim`).set('Cookie', cookie)
            .send({ claim_token: randomUUID().replaceAll('-', '').repeat(2), expected_version: row.version });
        expect(claim.status, JSON.stringify(claim.body)).toBe(200);
        const cart = edit(JSON.parse(claim.body.order.cart_data));
        const payload = { cart, subtotal: 5, expected_version: claim.body.claim.version,
            claim_token: claim.body.claim.claimToken, operation_id: randomUUID() };
        const save = () => request(app).patch(`/api/pos/held_orders/${id}`).set('Cookie', cookie).send(payload);
        const saved = await save();
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const replay = await save();
        expect(replay.status, JSON.stringify(replay.body)).toBe(200);
        expect(replay.body.order_display_no).toBe(saved.body.order_display_no);
        if(saved.body.customer_receipt == null) expect(replay.body.customer_receipt).toBeNull();
        return saved;
    }
    async function kitchenJobs() {
        const [rows] = await pool.query("SELECT payload FROM print_queue WHERE print_type='kitchen' ORDER BY id");
        return rows.map(row => JSON.parse(row.payload).data);
    }
    async function useCustomReceipt() {
        const definition = getBuiltinTemplate('receipt');
        const identity = definition.bands.find(b => b.id === 'meta').nodes.find(n => n.id === 'identity-date-row');
        identity.nodes = identity.nodes.filter(n => n.id !== 'held-order-display');
        identity.nodes.find(n => n.id === 'guest-check').visibleWhen = {path:'meta.provisional',op:'eq',value:true};
        definition.bands[0].nodes[0].label.en = 'Restaurant signature';
        // A held condition on an unrelated node must not control identity behavior.
        definition.bands[0].nodes.push({id:'held-spacer',type:'spacer',size:4,visibleWhen:{path:'meta.heldOrderReceipt',op:'eq',value:true}});
        const json = JSON.stringify(definition);
        const [[template]] = await pool.query("SELECT id FROM print_templates WHERE document_type='receipt'");
        const [revision] = await pool.query('INSERT INTO print_template_revisions(template_id,revision_no,schema_version,definition_json,definition_hash) VALUES(?,1,1,?,?)',
            [template.id,json,createHash('sha256').update(json).digest('hex')]);
        await pool.query('UPDATE print_templates SET active_revision_id=? WHERE id=?',[revision.insertId,template.id]);
        return revision.insertId;
    }
    it.each(['backend','browser'])('preserves the restaurant template and number through %s printing and replay', async mode => {
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='print_method'",[mode]);
        const revision = await useCustomReceipt();
        const data = input();
        const held = await hold(data);
        expect(held.status,JSON.stringify(held.body)).toBe(200);
        const retry = await hold(data);
        expect(retry.status,JSON.stringify(retry.body)).toBe(200);
        let artifact;
        if (mode === 'browser') {
            artifact = retry.body.customer_receipt.data.compiled_document_v1;
            expect(retry.body.order_display_no).toBe('1');
        } else {
            const [[job]] = await pool.query("SELECT payload FROM print_queue WHERE print_type='receipt'");
            artifact = JSON.parse(job.payload).data.compiled_document_v1;
        }
        expect(artifact.templateRevisionId).toBe(`revision:${revision}`);
        expect(artifact.html).toContain('Restaurant signature');
        expect(artifact.html).toContain('Order: 1');
        expect(artifact.html).not.toMatch(/GUEST CHECK|Invoice:|Ticket:|Payment|Tendered|Private reference/);
        expect((await printHold(held.body.id)).body.order_display_no).toBe('1');
        await restoreAndSave(held.body.id);
        expect(await kitchenJobs()).toHaveLength(1);
    });
    it.each(['backend','browser'])('does not auto-print a second customer copy after a scheduled %s print then unschedule', async mode => {
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='print_method'",[mode]);
        const held = await hold(input({delivery_date:'2099-09-09T18:30'}));
        expect((await printHold(held.body.id)).body.order_display_no).toBe('1');
        const saved = await restoreAndSave(held.body.id, cart => ({...cart,delivery_date:null}));
        expect(saved.body.customer_receipt).toBeNull();
        expect(saved.body.order_display_no).toBe('1');
        expect(await kitchenJobs()).toHaveLength(1);
        const [[jobs]] = await pool.query("SELECT COUNT(*) count FROM print_queue WHERE print_type='receipt'");
        expect(Number(jobs.count)).toBe(mode === 'backend' ? 1 : 0);
    });
    it('restores, reprints and re-holds repeatedly without advancing its number or reprinting unchanged kitchen work', async () => {
        const held = await hold(input());
        for (let cycle = 0; cycle < 3; cycle++) {
            expect((await printHold(held.body.id)).body.order_display_no).toBe('1');
            const saved = await restoreAndSave(held.body.id);
            expect(saved.body.order_display_no).toBe('1');
            expect(saved.body.customer_receipt).toBeNull();
            expect(await kitchenJobs()).toHaveLength(1);
        }
        const [[receipts]] = await pool.query("SELECT COUNT(*) count FROM print_queue WHERE print_type='receipt'");
        expect(Number(receipts.count)).toBe(4); // Initial automatic copy plus three deliberate reprints.
        expect((await hold(input())).body.order_display_no).toBe('2');
    });
    it('re-holding sends only added quantities and preparation corrections, once per saved change', async () => {
        const held = await hold(input());
        await restoreAndSave(held.body.id, cart => ({ ...cart, items: cart.items.map(item => ({ ...item, qty: 3 })) }));
        let jobs = await kitchenJobs();
        expect(jobs).toHaveLength(2);
        expect(jobs[1].items.map(item => Number(item.qty))).toEqual([2]);
        expect(jobs[1].follow_up).toBe(true);
        await restoreAndSave(held.body.id, cart => ({ ...cart, items: cart.items.map(item => ({ ...item, qty: 2 })) }));
        jobs = await kitchenJobs();
        expect(jobs).toHaveLength(3);
        expect(jobs[2].void_ticket).toBe(true);
        expect(jobs[2].items.map(item => Number(item.qty))).toEqual([1]);
        await restoreAndSave(held.body.id, cart => ({ ...cart, items: cart.items.map(item => ({ ...item, note: 'No onion' })) }));
        jobs = await kitchenJobs();
        expect(jobs).toHaveLength(5);
        expect(jobs[3].void_ticket).toBe(true);
        expect(jobs[4].follow_up).toBe(true);
        expect(jobs[4].items[0].note).toContain('No onion');
        await restoreAndSave(held.body.id);
        expect(await kitchenJobs()).toHaveLength(5);
        expect(jobs.every(job => job.order_display_no === '1')).toBe(true);
        for (const job of jobs) {
            expect(job.compiled_document_v1.html).toContain('Order:');
            expect(job.compiled_document_v1.html).not.toMatch(/Ticket:|Invoice:/);
        }
        const [[row]] = await pool.query('SELECT version FROM held_orders WHERE id=?',[held.body.id]);
        const claim = await request(app).post(`/api/pos/held_orders/${held.body.id}/claim`).set('Cookie',cookie)
            .send({claim_token:'b'.repeat(64),expected_version:row.version});
        const paid = await checkout({subtotal:10,tax:1.6,total:11.6,amount_tendered:11.6,
            held_order_context:{id:held.body.id,claim_token:claim.body.claim.claimToken,
                expected_version:claim.body.claim.version,operation_id:randomUUID()}});
        expect(paid.status,JSON.stringify(paid.body)).toBe(200);
        const [[order]] = await pool.query('SELECT order_id FROM orders'); expect(order.order_id).toBe(1);
        expect(await kitchenJobs()).toHaveLength(5);
        expect((await hold(input())).body.order_display_no).toBe('2');
    });
    it('removing a previously sent item cancels only that item on its original kitchen route', async () => {
        const data = input();
        data.cart.items.push({ id: SEED.product2.id, product_id: SEED.product2.id, qty: 1, price: 5 });
        const held = await hold(data);
        expect(held.status, JSON.stringify(held.body)).toBe(200);
        await restoreAndSave(held.body.id, cart => ({ ...cart, items: cart.items.slice(0, 1) }));
        const jobs = await kitchenJobs();
        expect(jobs).toHaveLength(2);
        expect(jobs[1].void_ticket).toBe(true);
        expect(jobs[1].items).toHaveLength(1);
        expect(Number(jobs[1].items[0].product_id)).toBe(SEED.product2.id);
        await restoreAndSave(held.body.id);
        expect(await kitchenJobs()).toHaveLength(2);
    });
    it('does not turn fractional arithmetic into another kitchen correction', async () => {
        const data = input(); data.cart.items[0].qty = 0.1;
        const held = await hold(data);
        await restoreAndSave(held.body.id, cart => ({...cart,items:cart.items.map(item => ({...item,qty:0.3}))}));
        await restoreAndSave(held.body.id);
        await restoreAndSave(held.body.id);
        const jobs = await kitchenJobs();
        expect(jobs).toHaveLength(2);
        expect(Number(jobs[1].items[0].qty)).toBe(0.2);
    });
    it('rolls back a changed hold when its configured station is disabled but permits an unchanged re-hold', async () => {
        const held = await hold(input());
        await pool.query("UPDATE printers SET is_active=0 WHERE role='kitchen'");
        await restoreAndSave(held.body.id);
        const [[row]] = await pool.query('SELECT * FROM held_orders WHERE id=?',[held.body.id]);
        const claim = await request(app).post(`/api/pos/held_orders/${held.body.id}/claim`).set('Cookie',cookie)
            .send({claim_token:'f'.repeat(64),expected_version:row.version});
        const cart = JSON.parse(claim.body.order.cart_data); cart.items[0].qty = 2;
        const saved = await request(app).patch(`/api/pos/held_orders/${held.body.id}`).set('Cookie',cookie)
            .send({cart,subtotal:10,operation_id:randomUUID(),claim_token:claim.body.claim.claimToken,expected_version:claim.body.claim.version});
        expect(saved.status,JSON.stringify(saved.body)).toBe(409);
        expect(saved.body.code).toBe('HELD_KITCHEN_ROUTE_MISSING');
        const [[after]] = await pool.query('SELECT order_id,cart_data FROM held_orders WHERE id=?',[held.body.id]);
        expect(after.order_id).toBe(1);
        expect(JSON.parse(after.cart_data).items[0].qty).toBe(1);
        expect(await kitchenJobs()).toHaveLength(1);
    });
    it('fails a configured disabled kitchen before creating a partial held order or taking a number', async () => {
        await pool.query("UPDATE printers SET is_active=0 WHERE role='kitchen'");
        const failed = await hold(input());
        expect(failed.status,JSON.stringify(failed.body)).toBe(409);
        const [[jobs]] = await pool.query('SELECT COUNT(*) count FROM print_queue');
        expect(Number(jobs.count)).toBe(0);
        await pool.query("UPDATE printers SET is_active=1 WHERE role='kitchen'");
        expect((await hold(input())).body.order_display_no).toBe('1');
    });
    it('rolls back an increase when changing stations would mix route ownership for one sent line', async () => {
        const held = await hold(input());
        await pool.query('DELETE FROM printer_categories');
        const [printer] = await pool.query("INSERT INTO printers(name,role,type,windows_name,spooler_id) VALUES('Replacement','kitchen','windows','Replacement','held-number-test')");
        await pool.query('INSERT INTO printer_categories(printer_id,category_id) VALUES(?,?)',[printer.insertId,SEED.category.id]);
        const claim = await request(app).post(`/api/pos/held_orders/${held.body.id}/claim`).set('Cookie',cookie)
            .send({claim_token:'e'.repeat(64),expected_version:held.body.version});
        const cart = JSON.parse(claim.body.order.cart_data); cart.items[0].qty = 2;
        const saved = await request(app).patch(`/api/pos/held_orders/${held.body.id}`).set('Cookie',cookie)
            .send({cart,subtotal:10,operation_id:randomUUID(),claim_token:claim.body.claim.claimToken,expected_version:claim.body.claim.version});
        expect(saved.status,JSON.stringify(saved.body)).toBe(409);
        expect(saved.body.code).toBe('HELD_KITCHEN_ROUTE_CHANGED');
        const [[row]] = await pool.query('SELECT order_id,cart_data FROM held_orders WHERE id=?',[held.body.id]);
        expect(row.order_id).toBe(1); expect(JSON.parse(row.cart_data).items[0].qty).toBe(1);
        expect(await kitchenJobs()).toHaveLength(1);
    });
    it('fails an invalid active held receipt instead of replacing the restaurant layout or queuing half the order', async () => {
        const revision = await useCustomReceipt();
        await pool.query("UPDATE print_template_revisions SET definition_json='{}' WHERE id=?",[revision]);
        const failed = await hold(input());
        expect(failed.status,JSON.stringify(failed.body)).toBe(409);
        const [[jobs]] = await pool.query('SELECT COUNT(*) count FROM print_queue');
        const [[holds]] = await pool.query('SELECT COUNT(*) count FROM held_orders');
        expect(Number(jobs.count)).toBe(0); expect(Number(holds.count)).toBe(0);
    });

    it('supports the existing receipt print API without exposing a held reference',async()=>{
        const held=await hold(input());
        const response=await request(app).post('/api/print/print').set('Cookie',cookie)
            .send({print_type:'receipt',payment_method:'held',invoice_id:held.body.id,print_request_id:randomUUID()});
        expect(response.status,JSON.stringify(response.body)).toBe(200);
        expect(response.body.success,JSON.stringify(response.body)).toBe(true);
        expect(response.body.order_display_no).toBe('1');
        const [[job]]=await pool.query("SELECT payload FROM print_queue WHERE print_type='receipt' ORDER BY id DESC LIMIT 1");
        expect(JSON.parse(job.payload).data.compiled_document_v1.html).not.toMatch(/Private reference|Invoice:|Ticket:|GUEST CHECK|Payment/);
    });

});
