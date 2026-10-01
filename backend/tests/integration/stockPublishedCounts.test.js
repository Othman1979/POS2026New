const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const {randomUUID}=require('node:crypto');
const L=require('../../services/RecipeLedgerService');
const {getConnection}=require('../../services/StockReportInvalidation');
const generations=require('../../services/StockReportGenerationService');
const worker=require('../../services/StockReportWorker');
const reads=require('../../services/StockReportReadService');

describe('Published count interval parity',()=>{
    beforeEach(seedDatabase);afterAll(()=>pool.end());
    async function tx(work){const conn=await getConnection(pool);try{await conn.beginTransaction();const result=await work(conn);await conn.commit();return result;}catch(e){await conn.rollback();throw e;}finally{conn.release();}}
    test('matches the reference over backdated intermediate counts and corrections across opening boundaries',async()=>{
        const [created]=await pool.query("INSERT INTO ingredients(name,measure,display_unit,is_active) VALUES ('Count parity','weight','g',1)");
        const id=created.insertId,day='2026-09-08',outside='2026-09-01',actor={id:1,name:'Admin'};
        async function post(kind,qty,businessDate=day){return tx(conn=>L.recordManualMovement(conn,{ingredientId:id,kind,qty,unit:'g',reason:kind==='waste'?'spoiled':undefined,clientKey:randomUUID(),actor,businessDate}));}
        const before=await post('receipt',30,outside);
        await post('count',100);
        const receipt=await post('receipt',20);
        const waste=await post('waste',5);
        await post('count',105,outside); // deliberately outside the selected period
        await tx(conn=>L.correctManualMovement(conn,{movementId:before.movement.id,correctedQty:35,unit:'g',note:'before opening',clientKey:randomUUID(),actor,businessDate:day}));
        await tx(conn=>L.correctManualMovement(conn,{movementId:receipt.movement.id,correctedQty:25,unit:'g',note:'inside opening',clientKey:randomUUID(),actor,businessDate:day}));
        await tx(conn=>L.correctManualMovement(conn,{movementId:waste.movement.id,correctedQty:3,unit:'g',note:'waste adjustment',clientKey:randomUUID(),actor,businessDate:day}));
        await post('count',90);
        await generations.ensureCoverage(pool);await worker.drain(pool,{limit:256,waitFor:async()=>{}});
        const published=await reads.getPublishedAnalysis(pool,{startDate:day,endDate:day,view:'counts'});
        expect(published.comparisons).toHaveLength(1);
        const row=published.comparisons[0];expect(row.complete).toBe(true);
        expect({received:Number(row.received),theoretical:Number(row.theoretical),waste:Number(row.waste),actual_usage:Number(row.actual_usage),unexplained:Number(row.unexplained)}).toEqual({received:25,theoretical:0,waste:3,actual_usage:35,unexplained:32});
        expect(Number(row.received)).toBe(25);expect(Number(row.waste)).toBe(3);expect(row.actual_usage).toBe(35);
        // An unpublished dependency outside the selected dates must not become zero.
        const [[dependency]]=await pool.query(`SELECT c.build_id FROM stock_report_counts c JOIN stock_report_dirty d ON d.published_build_id=c.build_id WHERE d.day=? AND c.previous_count_id>0`,[outside]);
        await pool.query('UPDATE stock_report_dirty SET published_build_id=NULL,pending=1 WHERE published_build_id=?',[dependency.build_id]);
        const incomplete=await reads.getPublishedAnalysis(pool,{startDate:day,endDate:day,view:'counts'});
        expect(incomplete.comparisons[0]).toMatchObject({complete:false,actual_usage:null,unexplained:null});
        expect(incomplete.freshness.state).toBe('stale');
        await worker.drain(pool,{waitFor:async()=>{}});
        // No movement query is allowed in the published reader.
        const sourceGuard={query(sql,...args){if(/\bstock_movements\b/.test(sql))throw new Error('Live history read');return pool.query(sql,...args);}};
        const restored=await reads.getPublishedAnalysis(sourceGuard,{startDate:day,endDate:day,view:'counts'});
        expect(restored.comparisons[0].actual_usage).toBe(35);
    });
});
