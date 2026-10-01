const request=require('supertest');
const {app}=require('../../../server');
const pool=require('../../config/db');
const {seedDatabase,SEED}=require('../fixtures/seed');
const xlsx=require('xlsx');
describe('catalog import isolation',()=>{
 let cookie;
 beforeAll(async()=>{await seedDatabase();cookie=(await request(app).post('/api/auth/login').send({user_number:SEED.adminUser.user_number})).headers['set-cookie'][0]});
 afterAll(()=>pool.end());
 it('rejects malformed workbooks without acquiring a stock transaction',async()=>{
  const spy=vi.spyOn(pool,'getConnection');
  try{const response=await request(app).post('/api/admin/import/catalog').set('Cookie',cookie).attach('file',Buffer.from('broken'), 'broken.xlsx');
   expect(response.status).toBe(400);expect(spy).not.toHaveBeenCalled();
  }finally{spy.mockRestore();}
 });
 it('serializes imports before parsing and recovers after a rejected file',async()=>{
  const wb=xlsx.utils.book_new();xlsx.utils.book_append_sheet(wb,xlsx.utils.aoa_to_sheet(Array.from({length:20000},(_,i)=>['Item '+i,i])),'Unmapped');
  const bytes=xlsx.write(wb,{type:'buffer',bookType:'xlsx',compression:true});
  const calls=await Promise.all([1,2].map(()=>request(app).post('/api/admin/import/catalog').set('Cookie',cookie).attach('file',bytes,'catalog.xlsx')));
  expect(calls.map(r=>r.status).sort()).toEqual([400,409]);
  const next=await request(app).post('/api/admin/import/catalog').set('Cookie',cookie).attach('file',Buffer.from('bad'),'bad.xlsx');expect(next.status).toBe(400);
 });
 it('tells staff terminals to reload the whole catalog after a committed import',async()=>{
  const name='_import_announce_'+Date.now();
  const wb=xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb,xlsx.utils.json_to_sheet([{Name:name}]),'Categories');
  xlsx.utils.book_append_sheet(wb,xlsx.utils.aoa_to_sheet([['Name','Price']]),'Products');
  try{const response=await request(app).post('/api/admin/import/catalog').set('Cookie',cookie).attach('file',xlsx.write(wb,{type:'buffer',bookType:'xlsx'}),'catalog.xlsx');
   expect(response.body.success).toBe(true);
   expect(global.__mockTo__).toHaveBeenCalledWith('staff');
   expect(global.__mockEmit__.mock.calls.filter(([event])=>event==='inventory_changed')).toEqual([['inventory_changed']]);
  }finally{await pool.query('DELETE FROM categories WHERE name = ?',[name]);}
 });
 it('tells staff terminals the held orders were cleared after a confirmed replace import',async()=>{
  await pool.query("INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data) VALUES (?, '_replace_held_', 1, '[]')",[SEED.adminUser.id]);
  const wb=xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb,xlsx.utils.json_to_sheet([{Name:'_replace_cat_'+Date.now()}]),'Categories');
  xlsx.utils.book_append_sheet(wb,xlsx.utils.aoa_to_sheet([['Name','Price']]),'Products');
  global.__mockEmit__.mockClear();
  const response=await request(app).post('/api/admin/import/catalog').set('Cookie',cookie).field('mode','replace').field('confirm_replace','1').attach('file',xlsx.write(wb,{type:'buffer',bookType:'xlsx'}),'catalog.xlsx');
  expect(response.body.success).toBe(true);
  const [[{held}]]=await pool.query('SELECT COUNT(*) AS held FROM held_orders');expect(held).toBe(0);
  const events=global.__mockEmit__.mock.calls.map(([event])=>event);
  expect(events).toContain('inventory_changed');
  expect(global.__mockEmit__.mock.calls.filter(([event])=>event==='held_orders_changed').map(([,payload])=>payload.action)).toEqual(['cleared']);
 });
});
