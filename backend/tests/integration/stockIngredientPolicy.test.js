const {randomUUID}=require('node:crypto');
const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const ledger=require('../../services/StockLedgerService');

describe('Estimated ingredient quantity authority',()=>{
    let key;
    beforeAll(()=>seedDatabase());
    beforeEach(async()=>{
        const [item]=await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state,availability_policy) VALUES ('Chicken','weight','g','active','estimate')");

        key={stock_item_id:item.insertId,};
    });
    afterAll(()=>pool.end());
    const intent=(kind,quantity,version)=>({kind,request_key:randomUUID(),business_date:'2026-09-08',lines:[{...key,quantity,expected_version:version}]});
    async function post(input){
        for(let attempt=0;;attempt++){
            const conn=await pool.getConnection();
            try{await conn.beginTransaction();const result=await ledger.post(conn,input,1);await conn.commit();return result;}
            catch(error){await conn.rollback();if(error.code!=='ER_LOCK_DEADLOCK'||attempt===2)throw error;}
            finally{conn.release();}
        }
    }
    async function balance(){return (await pool.query('SELECT CAST(quantity AS CHAR) quantity,quantity_known,CAST(version AS CHAR) version FROM stock_balances WHERE stock_item_id=?',[key.stock_item_id]))[0][0];}
    test('usage and receipts keep an uncounted ingredient unknown until an observed count',async()=>{
        await post(intent('issue','-125.5'));
        await post(intent('receipt','1000'));
        expect(await balance()).toMatchObject({quantity:'874.500000',quantity_known:0,version:'2'});
        const count=intent('count','1200','2');
        await post(count);await post(count);
        expect(await balance()).toMatchObject({quantity:'1200.000000',quantity_known:1,version:'3'});
        const [[journal]]=await pool.query('SELECT CAST(SUM(quantity) AS CHAR) quantity FROM stock_movements WHERE stock_item_id=?',[key.stock_item_id]);
        expect(journal.quantity).toBe('1200.000000');
    });
    test('known estimates may become negative without weakening observed-count conflicts',async()=>{
        await post(intent('opening','10','0'));
        await post(intent('issue','-12'));
        expect(await balance()).toMatchObject({quantity:'-2.000000',quantity_known:1,version:'2'});
        await expect(post(intent('count','5','1'))).rejects.toMatchObject({statusCode:409});
        await expect(post(intent('count','-1','2'))).rejects.toMatchObject({statusCode:400});
        await post(intent('receipt','5'));
        expect((await balance()).quantity).toBe('3.000000');
    });
    test('concurrent usage adds exact deltas and cannot establish a fictional count',async()=>{
        await Promise.all([post(intent('issue','-0.1')),post(intent('issue','-0.2'))]);
        expect(await balance()).toMatchObject({quantity:'-0.300000',quantity_known:0,version:'2'});
    });
    test('a negative legacy estimate can open only under the estimate policy, never as a physical count',async()=>{
        await pool.query("UPDATE stock_items SET availability_policy='strict' WHERE id=?",[key.stock_item_id]);
        await expect(post(intent('opening','-2','0'))).rejects.toMatchObject({statusCode:400});
        await pool.query("UPDATE stock_items SET availability_policy='estimate' WHERE id=?",[key.stock_item_id]);
        await post(intent('opening','-2','0'));
        expect(await balance()).toMatchObject({quantity:'-2.000000',quantity_known:1,version:'1'});
        await expect(post(intent('count','-2','1'))).rejects.toMatchObject({statusCode:400});
    });
    test('estimate policy cannot be forged through input or bypass the stored strict policy',async()=>{
        await expect(pool.query("UPDATE stock_items SET availability_policy='invalid' WHERE id=?",[key.stock_item_id])).rejects.toThrow('ck_stock_item_availability');
        await pool.query("UPDATE stock_items SET availability_policy='strict' WHERE id=?",[key.stock_item_id]);
        await expect(post({...intent('issue','-1'),availability_policy:'estimate'})).rejects.toMatchObject({statusCode:409});
    });
});
