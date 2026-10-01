const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const {randomUUID}=require('node:crypto');
const L=require('../../services/RecipeLedgerService');
const ledger=require('../../services/StockLedgerService');
const facts=require('../../services/StockReportFactService');
const generations=require('../../services/StockReportGenerationService');
const worker=require('../../services/StockReportWorker');
const {getConnection}=require('../../services/StockReportInvalidation');

describe('Bounded published daily working lists',()=>{
 beforeEach(seedDatabase);afterAll(()=>pool.end());
 const day='2026-09-08';
 async function tx(work){const c=await getConnection(pool);try{await c.beginTransaction();const result=await work(c);await c.commit();return result;}catch(e){await c.rollback();throw e;}finally{c.release();}}
 async function publish(){while(!(await generations.ensureCoverage(pool)).complete){}await worker.drain(pool,{limit:256,waitFor:async()=>{}});}
 test('keeps live balances and publishes daily movements without scanning source history on a page read',async()=>{
  const [created]=await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Daily stock','weight','g',0.01)");const id=created.insertId;
  const post=(kind,qty)=>tx(c=>L.recordManualMovement(c,{ingredientId:id,kind,qty,unit:'g',reason:kind==='waste'?'spoiled':undefined,clientKey:randomUUID(),actor:{id:1},businessDate:day}));
  await post('count',100);await post('receipt',20);await post('waste',5);
  const waiting=await L.listIngredientPage(pool,{businessDate:day});
  expect(waiting.items[0].expected_remaining).toBe(115);expect(waiting.items[0].today.received).toBeNull();expect(waiting.daily_freshness.state).toBe('rebuilding');
  await publish();
  const guard={query(sql,...args){if(/FROM\s+(ingredient_movements|stock_movements)\b/i.test(sql))throw new Error('Page scanned live history');return pool.query(sql,...args);}};
  const page=await L.listIngredientPage(guard,{businessDate:day});
  expect(page.daily_freshness.state).toBe('current');expect(page.items[0].today).toMatchObject({opening:100,received:20,waste:5,waste_cost:0.05});
  await post('receipt',7);
  const stale=await L.listIngredientPage(guard,{businessDate:day});expect(stale.items[0].expected_remaining).toBe(122);expect(stale.items[0].today.received).toBe(20);expect(stale.daily_freshness.state).toBe('stale');
  await publish();expect((await L.listIngredientPage(guard,{businessDate:day})).items[0].today.received).toBe(27);
 });
 test('combines historical warehouse provenance and new item-only movements in a bounded read',async()=>{
  const [item]=await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Historical identity','count','unit','active')");
  const opening=await tx(c=>ledger.post(c,{kind:'opening',request_key:randomUUID(),business_date:day,lines:[{stock_item_id:item.insertId,quantity:'5',expected_version:'0'}]},1));
  // Emulate the retained provenance of a pre-migration movement.
  await pool.query('UPDATE stock_movements SET location_id=7,lot_id=9 WHERE operation_id=?',[opening.operation_id]);
  await tx(c=>ledger.post(c,{kind:'receipt',request_key:randomUUID(),business_date:day,lines:[{stock_item_id:item.insertId,quantity:'10'}]},1));
  await publish();
  let queries=0;const guard={query(sql,...args){queries++;if(/\bstock_movements\b/.test(sql))throw new Error('Live stock scan');return pool.query(sql,...args);}};
  const daily=await facts.readDaily(guard,{day,ids:[String(item.insertId)],kind:'stock',locationId:'7'});
  expect(queries).toBe(1);expect(Number(daily.rows[0].incoming)).toBe(5);
 });
});
