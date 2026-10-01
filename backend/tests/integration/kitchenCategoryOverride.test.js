const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { buildKitchenPrintPayloads, filterRoutableKitchenLines } = require('../../services/kitchenPrintRouting');
const { printKitchenOrder } = require('../../routes/print');

describe('kitchen subcategory routing authority', () => {
    let a, b;
    const special = { id: 101, name: 'B special', category_id: 12, qty: 1 };
    const sibling = { id: 102, name: 'B regular', category_id: 13, qty: 1 };
    const primary = payload => payload.data.items.filter(item => !item._isOther).map(item => item.id);
    beforeAll(async () => {
        await seedDatabase();
        await pool.query("INSERT INTO categories(id,name,parent_id,is_active) VALUES(10,'A',NULL,1),(11,'B',NULL,1),(12,'B special',11,1),(13,'B regular',11,1)");
        const [pa] = await pool.query("INSERT INTO printers(name,role,type,windows_name,spooler_id,is_active) VALUES('A','kitchen','windows','A','routing-test',1)");
        const [pb] = await pool.query("INSERT INTO printers(name,role,type,windows_name,spooler_id,is_active) VALUES('B','kitchen','windows','B','routing-test',1)");
        a = pa.insertId; b = pb.insertId;
    });
    beforeEach(async () => {
        await pool.query('DELETE FROM printer_categories');
        await pool.query('UPDATE printers SET is_active=1 WHERE id IN (?,?)', [a,b]);
        await pool.query('INSERT INTO printer_categories(printer_id,category_id) VALUES (?,10),(?,12),(?,11)',[a,a,b]);
        await pool.query('DELETE FROM print_queue');
    });
    afterAll(() => pool.end());

    it.each([{}, {follow_up:true}, {cancel_ticket:true}, {void_ticket:true}])('overrides the parent for ticket flags %j and keeps sibling fallback', async flags => {
        const {payloads} = await buildKitchenPrintPayloads(pool,{print_batch_id:'override',items:[special,sibling],...flags});
        expect(primary(payloads.find(p=>p.printer_id===a))).toEqual([101]);
        expect(primary(payloads.find(p=>p.printer_id===b))).toEqual([102]);
        if (Object.keys(flags).length) expect(payloads.every(p=>p.data.items.every(i=>!i._isOther))).toBe(true);
    });
    it('sends an explicitly shared subcategory to both selected printers once each', async () => {
        await pool.query('INSERT INTO printer_categories(printer_id,category_id) VALUES (?,12)',[b]);
        const {payloads}=await buildKitchenPrintPayloads(pool,{print_batch_id:'shared',items:[special]});
        expect(payloads.map(p=>p.printer_id).sort()).toEqual([a,b].sort());
        expect(payloads.every(p=>primary(p).length===1)).toBe(true);
    });
    it('inherits the parent when no explicit subcategory mapping exists', async () => {
        await pool.query('DELETE FROM printer_categories WHERE category_id=12');
        const {payloads}=await buildKitchenPrintPayloads(pool,{print_batch_id:'fallback',items:[special]});
        expect(payloads.map(p=>p.printer_id)).toEqual([b]);
    });
    it('does not silently send work to the parent when its explicit station is disabled', async () => {
        await pool.query('UPDATE printers SET is_active=0 WHERE id=?',[a]);
        const {payloads,unroutedItems}=await buildKitchenPrintPayloads(pool,{print_batch_id:'disabled',items:[special,sibling]});
        expect(payloads.map(p=>p.printer_id)).toEqual([b]);
        expect(primary(payloads[0])).toEqual([102]);
        expect(unroutedItems.map(i=>i.id)).toEqual([101]);
        const filtered=await filterRoutableKitchenLines(pool,[special,sibling]);
        expect(filtered.unrouted.map(i=>i.id)).toEqual([101]);
    });
    it('persists only the override station for a subcategory-only kitchen job', async () => {
        expect(await printKitchenOrder(null,{print_batch_id:'queue-override',items:[special]})).toBe(1);
        const [rows]=await pool.query('SELECT printer_id,payload FROM print_queue');
        expect(rows.map(r=>r.printer_id)).toEqual([a]);
        const payload=typeof rows[0].payload==='string'?JSON.parse(rows[0].payload):rows[0].payload;
        expect(primary(payload)).toEqual([101]);
    });
    it('routes bundle children independently through override and parent fallback', async () => {
        const {payloads}=await buildKitchenPrintPayloads(pool,{print_batch_id:'bundle-override',items:[{
            id:200,name:'Mixed meal',qty:2,bundleItems:[
                {product_id:101,name:'B special',category_id:12,qty:1},
                {product_id:102,name:'B regular',category_id:13,qty:1}
            ]
        }]});
        for (const [printerId,productId] of [[a,101],[b,102]]) {
            const items=payloads.find(p=>p.printer_id===printerId).data.items.filter(i=>!i._isOther);
            expect(items).toHaveLength(1);
            expect(items[0]).toMatchObject({product_id:productId,qty:2});
        }
    });
    it('keeps remaining explicit stations when one is disabled, without adding parent stations', async () => {
        await pool.query('INSERT INTO printer_categories(printer_id,category_id) VALUES (?,12)',[b]);
        await pool.query('UPDATE printers SET is_active=0 WHERE id=?',[a]);
        const {payloads}=await buildKitchenPrintPayloads(pool,{print_batch_id:'remaining',items:[special]});
        expect(payloads.map(p=>p.printer_id)).toEqual([b]);
        expect(primary(payloads[0])).toEqual([101]);
    });
    it('uses two batched reads for both one line and 100 lines', async () => {
        for (const size of [1,100]) {
            const db={query:vi.fn((...args)=>pool.query(...args))};
            const {payloads}=await buildKitchenPrintPayloads(db,{print_batch_id:`batch-${size}`,items:Array.from({length:size},(_,i)=>({...special,id:1000+i}))});
            expect(db.query).toHaveBeenCalledTimes(2);
            expect(payloads).toHaveLength(1);
            expect(primary(payloads[0])).toHaveLength(size);
        }
    });
});
