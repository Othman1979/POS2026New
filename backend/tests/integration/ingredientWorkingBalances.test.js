const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const {randomUUID}=require('node:crypto');
const L=require('../../services/RecipeLedgerService');
const {getConnection}=require('../../services/StockReportInvalidation');

describe('Ingredient working projections and complete filters',()=>{
 beforeEach(seedDatabase);afterAll(()=>pool.end());
 async function tx(work){const conn=await getConnection(pool);try{await conn.beginTransaction();const result=await work(conn);await conn.commit();return result;}catch(e){await conn.rollback();throw e;}finally{conn.release();}}
 async function post(id,kind,qty){return tx(conn=>L.recordManualMovement(conn,{ingredientId:id,kind,qty,unit:'g',clientKey:randomUUID(),actor:{id:1,name:'Admin'},businessDate:'2026-09-08'}));}
 test('finds shortages after the first identity page and binds cursors to every filter',async()=>{
  await pool.query('INSERT INTO ingredients(name,measure,display_unit,par_qty,is_active) VALUES ?',[Array.from({length:110},(_,i)=>['Ingredient '+String(i).padStart(3,'0'),'weight','g',10,1])]);
  const [items]=await pool.query('SELECT id FROM ingredients ORDER BY id');
  for(const item of items)await post(item.id,'count',20);
  await post(items[99].id,'count',3);await post(items[105].id,'count',4);
  const first=await L.listIngredientPage(pool,{limit:50});expect(first.items.map(r=>r.id)).not.toContain(items[99].id);
  const low=await L.listIngredientPage(pool,{attention:'attention',limit:1});
  expect(low.items[0].id).toBe(items[99].id);expect(low.next_cursor).toBeTruthy();
  const next=await L.listIngredientPage(pool,{attention:'attention',limit:1,cursor:low.next_cursor});expect(next.items[0].id).toBe(items[105].id);expect(next.has_more).toBe(false);
  await expect(L.listIngredientPage(pool,{attention:'all',cursor:low.next_cursor})).rejects.toMatchObject({statusCode:400});
  expect(low.freshness.state).toBe('current');
 });
 test('retains physical count boundaries across old-source corrections and rollback',async()=>{
  const [ingredient]=await pool.query("INSERT INTO ingredients(name,measure,display_unit,is_active) VALUES ('Projection parity','weight','g',1)");const id=ingredient.insertId;
  const original=await post(id,'receipt',30);await post(id,'count',100);const received=await post(id,'receipt',20);
  await tx(conn=>L.correctManualMovement(conn,{movementId:original.movement.id,correctedQty:35,unit:'g',note:'old receipt',clientKey:randomUUID(),actor:{id:1},businessDate:'2026-09-01'}));
  expect((await L.getIngredientSummaries(pool,{ids:[id]}))[0].expected_remaining).toBe(120);
  await tx(conn=>L.correctManualMovement(conn,{movementId:received.movement.id,correctedQty:25,unit:'g',note:'current receipt',clientKey:randomUUID(),actor:{id:1},businessDate:'2026-09-08'}));
  await expect(tx(async conn=>{await L.recordManualMovement(conn,{ingredientId:id,kind:'count',qty:5,unit:'g',clientKey:randomUUID(),actor:{id:1},businessDate:'2026-09-08'});throw new Error('rollback');})).rejects.toThrow('rollback');
  expect((await L.getIngredientSummaries(pool,{ids:[id]}))[0].expected_remaining).toBe(125);
 });
 test('backfills at most sixteen identities and resumes without repeating completed balances',async()=>{
  await pool.query('INSERT INTO ingredients(name,measure,display_unit,is_active) VALUES ?',[Array.from({length:20},(_,i)=>['Historical '+i,'weight','g',1])]);
  const [items]=await pool.query('SELECT id FROM ingredients ORDER BY id');
  await pool.query("INSERT INTO stock_movements(movement_type,ingredient_id,kind,qty,source_type,business_date) VALUES ?",[(items.map(i=>[i.id,'count',25,'manual','2026-01-01'])).map(row => ['ingredient', ...row])]);
  const first=await L.backfillWorkingBalances(pool);expect(first).toMatchObject({complete:false,rows:16});
  const next=await L.backfillWorkingBalances(pool,{afterId:first.after_id});expect(next).toMatchObject({complete:true,rows:4});
  expect(await L.backfillWorkingBalances(pool,{afterId:next.after_id})).toEqual({complete:true,rows:0,after_id:next.after_id});
  const page=await L.listIngredientPage(pool,{limit:50});expect(page.items.every(row=>row.expected_remaining===25)).toBe(true);
 });
});
