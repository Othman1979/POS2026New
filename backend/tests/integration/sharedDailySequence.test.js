const request = require('supertest');
const {randomUUID} = require('node:crypto');
const {app} = require('../../../server');
const pool = require('../../config/db');
const {seedDatabase, SEED} = require('../fixtures/seed');
const {getBusinessDate} = require('../../utils/businessDate');

describe('shared daily numbering across cashier workflows', () => {
    let admin, cashier;
    const login = async user => (await request(app).post('/api/auth/login').send({user_number:user.user_number})).headers['set-cookie'][0];
    const open = async (cookie, user) => {
        const result = await request(app).post('/api/auth/shifts?action=open').set('Cookie',cookie).send({user_id:user.id,starting_cash:0});
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'",[user.id]);
        return shift.id;
    };
    const sale = (cookie, shift_id) => request(app).post('/api/pos/checkout').set('Cookie',cookie).send({
        cart:[{id:SEED.product1.id,qty:1,price:5}], shift_id,
        subtotal:5,tax:0.8,total:5.8,payment_method:'cash',amount_tendered:5.8,change_due:0,idempotency_key:randomUUID()
    });
    const hold = cookie => request(app).post('/api/pos/held_orders').set('Cookie',cookie).send({
        hold_request_id:randomUUID(),subtotal:5,
        cart:{items:[{id:SEED.product1.id,product_id:SEED.product1.id,name:SEED.product1.name,qty:1,price:5}]}
    });
    beforeEach(async () => {
        await seedDatabase();
        await pool.query("INSERT INTO settings(setting_key,setting_value) VALUES('shared_order_sequence','0'),('print_method','browser') ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)");
        admin=await login(SEED.adminUser); cashier=await login(SEED.cashierUser);
    });
    afterEach(()=>vi.restoreAllMocks());
    afterAll(()=>pool.end());

    it.each([1,2,3])('serializes mixed holds and sales across two active cashier shifts (round %s)', async () => {
        const a=await open(admin,SEED.adminUser), b=await open(cashier,SEED.cashierUser);
        const day=getBusinessDate();
        await pool.query('INSERT INTO daily_sequences(sequence_date,current_value) VALUES(?,70)',[day]);
        const errors=vi.spyOn(require('../../config/logger'),'error');
        const replies=await Promise.all([sale(admin,a),sale(cashier,b),hold(admin),hold(cashier)]);
        for(const reply of replies) expect(reply.status,JSON.stringify({body:reply.body, errors:errors.mock.calls.map(args=>args.map(arg=>arg?.err ? {code:arg.err.code,message:arg.err.message}:arg))})).toBe(200);
        const [identities]=await pool.query('SELECT order_id,order_seq_scope FROM orders UNION ALL SELECT order_id,order_seq_scope FROM held_orders');
        expect(identities.map(row=>row.order_id).sort((a,b)=>a-b)).toEqual([71,72,73,74]);
        expect(identities.every(row=>row.order_seq_scope===`date:${day}`)).toBe(true);
        const [shifts]=await pool.query('SELECT last_order_seq FROM shifts');
        expect(shifts.every(row=>row.last_order_seq===0)).toBe(true);
        const [[invoices]]=await pool.query('SELECT COUNT(DISTINCT invoice_number) count FROM orders');
        expect(Number(invoices.count)).toBe(2);
    });

    it('closing and opening a cashier shift continues the daily number and invoice sequence', async () => {
        const firstShift=await open(cashier,SEED.cashierUser);
        const first=await sale(cashier,firstShift);
        expect(first.status,JSON.stringify(first.body)).toBe(200);
        const closed=await request(app).put('/api/auth/shifts?action=close').set('Cookie',admin).send({shift_id:firstShift,actual_cash:5.8});
        expect(closed.status,JSON.stringify(closed.body)).toBe(200);
        cashier=await login(SEED.cashierUser);
        const secondShift=await open(cashier,SEED.cashierUser);
        expect(secondShift).not.toBe(firstShift);
        const second=await sale(cashier,secondShift);
        expect(second.status,JSON.stringify(second.body)).toBe(200);
        const [orders]=await pool.query('SELECT order_id,order_seq_scope,invoice_number,shift_id FROM orders ORDER BY invoice_id');
        expect(orders.map(row=>row.order_id)).toEqual([1,2]);
        expect(orders[1].order_seq_scope).toBe(orders[0].order_seq_scope);
        expect(Number(orders[1].invoice_number)).toBe(Number(orders[0].invoice_number)+1);
        expect(orders.map(row=>row.shift_id)).toEqual([firstShift,secondShift]);
    });

    it('stale settings clients cannot change numbering policy through the settings API', async () => {
        await pool.query("DELETE FROM settings WHERE setting_key='shared_order_sequence'");
        const saved=await request(app).post('/api/system/settings').set('Cookie',admin).send({shared_order_sequence:'0'});
        expect(saved.status,JSON.stringify(saved.body)).toBe(200);
        const settings=await request(app).get('/api/system/settings').set('Cookie',admin);
        expect(settings.status).toBe(200);
        expect(settings.body).not.toHaveProperty('shared_order_sequence');
        const [rows]=await pool.query("SELECT setting_value FROM settings WHERE setting_key='shared_order_sequence'");
        expect(rows).toHaveLength(0);
        const first=await hold(admin);
        expect(first.status,JSON.stringify(first.body)).toBe(200);
        const shift=await open(cashier,SEED.cashierUser);
        const second=await sale(cashier,shift);
        expect(second.status,JSON.stringify(second.body)).toBe(200);
        expect(Number(first.body.order_display_no)).toBe(1);
        expect(second.body.order_id).toBe(2);
    });
});
