const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const {createStockReportWorkerRunner}=require('../../services/StockReportWorkerRunner');
const ledger=require('../../services/RecipeLedgerService');
describe('stock worker completed backfill',()=>{
 beforeAll(()=>seedDatabase());afterAll(()=>pool.end());
 it('skips completed balance work but detects new and missing older projections on the next poll',async()=>{
  await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
  let next;const backfillBalances=vi.fn((p,afterId)=>ledger.backfillWorkingBalances(p,{afterId}));
  const runner=createStockReportWorkerRunner({pool,logger:{warn(){}},backfillBalances,runOne:async()=>({status:'idle'}),setTimeoutFn:(fn)=>{next=fn;return{unref(){}}},clearTimeoutFn(){}});
  try{
   let result=await runner.start();for(let i=0;result.status==='backfill'&&i<20;i++)result=await next();
   expect(result.status).toBe('idle');const done=backfillBalances.mock.calls.length;
   await next();await next();expect(backfillBalances).toHaveBeenCalledTimes(done);
   const [inserted]=await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('New idle ingredient','weight','g')");
   await next();
   let [[row]]=await pool.query('SELECT working_initialized AS initialized FROM ingredients WHERE id=?',[inserted.insertId]);expect(Number(row.initialized)).toBe(1);
   await pool.query('UPDATE ingredients SET working_initialized=0 WHERE id=?',[inserted.insertId]);
   await next();
   [[row]]=await pool.query('SELECT working_initialized AS initialized FROM ingredients WHERE id=?',[inserted.insertId]);expect(Number(row.initialized)).toBe(1);
  }finally{await runner.stop()}
 });
});
