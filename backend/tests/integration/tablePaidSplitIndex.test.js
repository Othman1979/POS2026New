const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { validateRequiredSchema } = require('../../services/schemaValidation');
const request = require('supertest');
const { app } = require('../../../server');
beforeEach(() => seedDatabase());
afterAll(() => pool.end());

describe('paid split count index authority', () => {
    it('provides a covering parent-leading index for paid children', async () => {
        const [rows] = await pool.query(`SELECT COLUMN_NAME, NON_UNIQUE, SUB_PART, INDEX_TYPE
            FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
            AND TABLE_NAME='orders' AND INDEX_NAME='idx_orders_parent_payment' ORDER BY SEQ_IN_INDEX`);
        expect(rows).toEqual(['parent_invoice_id', 'payment_method'].map(COLUMN_NAME => ({
            COLUMN_NAME, NON_UNIQUE: 1, SUB_PART: null, INDEX_TYPE: 'BTREE'
        })));
    });

    it('rejects startup when the paid-child index is missing despite the ledger', async () => {
        await pool.query('ALTER TABLE orders DROP INDEX IF EXISTS idx_orders_parent_payment');
        await expect(validateRequiredSchema(pool)).rejects.toThrow('paid_split_parent_index');
    });

    it.each(['payment_method,parent_invoice_id', 'parent_invoice_id', 'parent_invoice_id,payment_method,invoice_id'])('rejects startup with the wrong index shape: %s', async columns => {
        await pool.query('ALTER TABLE orders DROP INDEX idx_orders_parent_payment');
        await pool.query(`ALTER TABLE orders ADD INDEX idx_orders_parent_payment (${columns})`);
        await expect(validateRequiredSchema(pool)).rejects.toThrow('paid_split_parent_index');
    });
});

describe('paid split counts and settlement protections', () => {
    const login = async number => (await request(app).post('/api/auth/login').send({user_number:number})).headers['set-cookie'][0];
    const snapshot = async () => {
        const data = {};
        for (const table of ['orders','order_items','held_orders','restaurant_tables','products','stock_movements','audit_events']) {
            data[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY 1`))[0];
        }
        return data;
    };
    it('counts mixed paid methods by parent, preserves presentations and filters restricted sections', async () => {
        await pool.query("INSERT INTO sections(id,name) VALUES(2,'Hidden')");
        await pool.query('UPDATE restaurant_tables SET section_id=2 WHERE id=2');
        const parents=[];
        for (const tableId of [1,2]) {
            const [parent]=await pool.query("INSERT INTO orders(user_id,table_id,subtotal,tax,total,payment_method) VALUES(1,?,4,0,4,'unpaid_table')",[tableId]);
            parents.push(parent.insertId);
            for (const method of ['cash','card','split','unpaid_table','voided','platform','receivable']) {
                if (tableId===2 && ['card','split'].includes(method)) continue;
                await pool.query(`INSERT INTO orders(user_id,subtotal,tax,total,parent_invoice_id,payment_method,payment_due_on,receivable_reason,buyer_name_at_sale)
                    VALUES(1,1,0,1,?,?,?,?,?)`,[parent.insertId,method,method==='receivable'?'2026-10-01':null,method==='receivable'?'Fixture':null,method==='receivable'?'Fixture buyer':null]);
            }
            const cart=JSON.stringify({items:[{id:2,product_id:2,name:'Drink',qty:1,price:2,tax_rate:0}],parent_invoice_id:parent.insertId,table_id:tableId,tax_inclusive_at_sale:0,receipt_tax_inclusive_at_sale:0});
            await pool.query('INSERT INTO held_orders(user_id,reference_name,subtotal,cart_data,parent_invoice_id,table_id) VALUES ?',
                [Array.from({length:2},(_,i)=>[1,`Seat ${i+1}`,2,cart,parent.insertId,tableId])]);
        }
        const cart='{"items":[{"id":2,"product_id":2,"name":"Drink","qty":1,"price":2,"tax_rate":0}],"tax_inclusive_at_sale":0}';
        // A table-linked legacy check has no parent. A register hold is not a split.
        await pool.query('INSERT INTO held_orders(user_id,reference_name,subtotal,cart_data,table_id) VALUES(1,?,2,?,1),(1,?,2,?,NULL)',['Legacy',cart,'Register',cart]);
        await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method) VALUES(1,5,0,5,'cash')");
        const admin=await login('9001'), waiter=await login('9003');
        const before=await snapshot();
        for (const [cookie,count] of [[admin,5],[waiter,3]]) {
            const response=await request(app).get('/api/pos/table_splits').set('Cookie',cookie);
            expect(response.statusCode).toBe(200);
            expect(response.body.data).toHaveLength(count);
            for (const row of response.body.data) {
                expect(Number(row.paid_split_count)).toBe(row.parent_invoice_id==null?0:row.parent_invoice_id===parents[0]?3:1);
                expect(row.receipt_display_v1).toBeTruthy();
                expect(row.receipt_display_error).toBeNull();
                expect(JSON.parse(row.cart_data).items[0].qty).toBe(1);
                if (cookie===waiter) expect(row.table_id).toBe(1);
            }
        }
        expect(await snapshot()).toEqual(before);
    });

    it.each(['cash','card','split'])('keeps a %s paid child protected from split cancellation', async method => {
        const cookie=await login('9001');
        const cart=[{id:2,qty:2,price:2,tax_rate:0}];
        const saved=await request(app).post('/api/pos/table_order').set('Cookie',cookie).send({table_id:1,cart,subtotal:4,tax:0,total:4});
        expect(saved.statusCode).toBe(200);
        const parent=saved.body.invoice_id;
        const split=await request(app).post('/api/pos/table_splits/split').set('Cookie',cookie).send({tableId:1,currentOrderId:parent,
            splits:[1,2].map(seat=>({referenceName:`Seat ${seat}`,subtotal:2,items:[{...cart[0],qty:1}]}))});
        expect(split.statusCode,JSON.stringify(split.body)).toBe(200);
        await pool.query('INSERT INTO orders(user_id,subtotal,tax,total,payment_method,parent_invoice_id) VALUES(1,2,0,2,?,?)',[method,parent]);
        const [held]=await pool.query('SELECT id FROM held_orders WHERE parent_invoice_id=?',[parent]);
        const before=await snapshot();
        const response=await request(app).delete(`/api/pos/table_splits?id=${held[0].id}`).set('Cookie',cookie);
        expect(response.statusCode,JSON.stringify(response.body)).toBe(409);
        expect(JSON.stringify(response.body)).toContain('SPLIT_ALREADY_PAID');
        expect(await snapshot()).toEqual(before);
    });
});
