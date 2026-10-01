const { withUserEditVersion } = require('../helpers/adminUsers');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');

describe('cashier first-save and saved-order permissions', () => {
    let adminCookie, cashierCookie, cashierId;
    const firstSave = { table_id: 1, cart: [{ id: 2, name: 'Test Drink', qty: 1, price: 2 }], subtotal: 2, tax: 0, total: 2 };
    const login = async number => {
        const result = await request(app).post('/api/auth/login').send({ user_number: number });
        expect(result.status).toBe(200);
        return result.headers['set-cookie'][0];
    };
    const state = async () => {
        const result = {};
        for(const table of ['orders','order_items','restaurant_tables','products','refunds','refund_items','deleted','stock_movements','recipe_ledger_lines'])
            result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY 1`))[0];
        return result;
    };
    const createCashier = async permissions => {
        const response = await request(app).post('/api/admin/users').set('Cookie',adminCookie)
            .send({name:'Cashier serving tables',user_number:'5566',role:'cashier',permissions,allowed_sections:'1'});
        expect(response.status).toBe(200);
        cashierId=response.body.id;
        cashierCookie=await login('5566');
    };
    const save = (payload=firstSave,cookie=cashierCookie) => request(app).post('/api/pos/table_order').set('Cookie',cookie).send(payload);
    beforeEach(async () => { await seedDatabase(); adminCookie=await login('9001'); });
    afterAll(() => pool.end());

    it.each([[],['tables.access'],['tables.save'],['tables.access','waiter.edit_locked']].map(permissions=>[permissions]))('rejects the first save without both cashier grants: %j',async permissions=>{
        await createCashier(permissions);
        const before=await state();
        const response=await save({...firstSave,require_update_permission:false});
        expect(response.status).toBe(403);
        expect(await state()).toEqual(before);
    });

    it.each([false,true])('allows the first save but rejects later edits and voids, printed=%s',async printed=>{
        await createCashier(['tables.access','tables.save']);
        const saved=await save();
        expect(saved.status,saved.text).toBe(200);
        const invoiceId=saved.body.invoice_id;
        const [[order]]=await pool.query('SELECT order_id,invoice_number,waiter_id,version FROM orders WHERE invoice_id=?',[invoiceId]);
        expect(order).toMatchObject({order_id:null,invoice_number:null,waiter_id:cashierId});
        if(printed) expect((await save({action:'mark_printed',table_id:1,expected_invoice_id:invoiceId},adminCookie)).status).toBe(200);
        const before=await state();
        const edit={...firstSave,current_order_id:invoiceId,expected_version:order.version,require_update_permission:false,cart:[{...firstSave.cart[0],qty:2,originalQty:1}],subtotal:4,total:4};
        expect((await save(edit)).status).toBe(403);
        expect((await request(app).post('/api/pos/refunds').set('Cookie',cashierCookie).send({intent:'void',invoice_id:invoiceId,expected_version:order.version})).status).toBe(403);
        expect(await state()).toEqual(before);
        // Update through the real admin endpoint; revocation of the old session is part of the flow.
        const updated=await request(app).put('/api/admin/users').set('Cookie',adminCookie).send(await withUserEditVersion(app, adminCookie, {id:cashierId,name:'Cashier serving tables',user_number:'5566',role:'cashier',permissions:['tables.access','tables.save','waiter.edit_locked'],allowed_sections:'1'}));
        expect(updated.status,updated.text).toBe(200);
        expect((await save(edit)).status).toBe(401);
        cashierCookie=await login('5566');
        const resaved=await save(edit);
        expect(resaved.status,resaved.text).toBe(200);
        const [[item]]=await pool.query('SELECT quantity FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',[invoiceId]);
        expect(Number(item.quantity)).toBe(2);
    });

    it('keeps other staff ownership and assigned sections enforced',async()=>{
        await createCashier(['tables.access','tables.save','waiter.edit_locked']);
        const saved=await save(firstSave,adminCookie);
        expect(saved.status,saved.text).toBe(200);
        const before=await state();
        expect((await save({...firstSave,current_order_id:saved.body.invoice_id,expected_version:1})).status).toBe(403);
        const [section] = await pool.query("INSERT INTO sections(name) VALUES('Private section')");
        await pool.query('UPDATE restaurant_tables SET section_id=? WHERE id=2',[section.insertId]);
        const sectionState=await state();
        expect((await save({...firstSave,table_id:2})).status).toBe(403);
        expect(await state()).toEqual(sectionState);
        expect(sectionState.orders).toEqual(before.orders);
    });
});
