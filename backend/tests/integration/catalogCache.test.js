const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const {seedDatabase, SEED} = require('../fixtures/seed');
const cache = require('../../config/cache');

describe('catalog cache request identity and invalidation', () => {
 let cookie;
 beforeAll(async()=>{await seedDatabase();cookie=(await request(app).post('/api/auth/login').send({user_number:SEED.adminUser.user_number})).headers['set-cookie'][0];});
 afterAll(()=>pool.end());
 it('honors different page sizes and conditional requests after priming the default page',async()=>{
  cache.invalidateCatalogCache();
   const normal=await request(app).get('/api/pos/products').set('Cookie',cookie);
   expect(normal.status).toBe(200);
   expect(normal.headers.etag).toMatch(/^"[a-f0-9]{32}"$/);
   expect(normal.headers['cache-control']).toContain('private');
   expect(normal.headers['cache-control']).toContain('no-cache');
  for(const limit of [1,300]){
   const page=await request(app).get('/api/pos/products').query({limit}).set('Cookie',cookie).set('If-None-Match',normal.headers.etag);
   expect(page.status).toBe(200);expect(page.body.pagination.limit).toBe(limit);expect(page.body.products.length).toBeLessThanOrEqual(limit);
  }
   const unchanged=await request(app).get('/api/pos/products').set('Cookie',cookie).set('If-None-Match',normal.headers.etag);
   expect(unchanged.status).toBe(304);
   expect(unchanged.headers.etag).toBe(normal.headers.etag);
   expect(unchanged.headers['cache-control']).toBe(normal.headers['cache-control']);
   expect(unchanged.text).toBe('');
  });
  it('keeps filtered validators private and scoped to their exact URL',async()=>{
   const first=await request(app).get('/api/pos/products').query({category_id:1,lightweight:1}).set('Cookie',cookie);
   expect(first.status).toBe(200);
   expect(first.headers.etag).toMatch(/^"[a-f0-9]{32}"$/);
   expect(first.headers['cache-control']).toContain('private');
   const unchanged=await request(app).get('/api/pos/products').query({category_id:1,lightweight:1}).set('Cookie',cookie).set('If-None-Match',first.headers.etag);
   expect(unchanged.status).toBe(304);
   expect(unchanged.headers.etag).toBe(first.headers.etag);
   const otherUrl=await request(app).get('/api/pos/products').query({category_id:2,lightweight:1}).set('Cookie',cookie).set('If-None-Match',first.headers.etag);
   expect(otherUrl.status).toBe(200);
  });
  it('does not expose a conditional catalog response without authentication',async()=>{
   cache.invalidateCatalogCache();
   const primed=await request(app).get('/api/pos/products').set('Cookie',cookie);
   const unauthorized=await request(app).get('/api/pos/products').set('If-None-Match',primed.headers.etag);
   expect(unauthorized.status).toBe(401);
  });
 it('shares one database build across simultaneous cold canonical requests',async()=>{
  const originalQuery=pool.query.bind(pool);
  let queryCount=0;
  const spy=vi.spyOn(pool,'query').mockImplementation(async(...args)=>{
   queryCount+=1;
   return originalQuery(...args);
  });
  try{
   cache.invalidateCatalogCache();
   const single=await request(app).get('/api/pos/products').set('Cookie',cookie);
   expect(single.status).toBe(200);
   const singleBuildQueries=queryCount;
   expect(singleBuildQueries).toBeGreaterThan(0);

   cache.invalidateCatalogCache();
   queryCount=0;
   const concurrent=await Promise.all(Array.from({length:8},()=>request(app).get('/api/pos/products').set('Cookie',cookie)));
   expect(concurrent.every(response=>response.status===200)).toBe(true);
   expect(concurrent.every(response=>response.headers.etag===concurrent[0].headers.etag)).toBe(true);
   expect(concurrent.every(response=>JSON.stringify(response.body)===JSON.stringify(concurrent[0].body))).toBe(true);
   expect(queryCount).toBe(singleBuildQueries);
  }finally{spy.mockRestore();}
 });
 it('allows a clean retry after the shared catalog build fails',async()=>{
  cache.invalidateCatalogCache();
  const originalQuery=pool.query.bind(pool);
  let failOnce=true;
  const spy=vi.spyOn(pool,'query').mockImplementation(async(sql,args)=>{
   if(failOnce&&String(sql).includes('SELECT c.*')){
    failOnce=false;
    throw new Error('catalog build failure');
   }
   return originalQuery(sql,args);
  });
  try{
   const failed=await request(app).get('/api/pos/products').set('Cookie',cookie);
   expect(failed.status).toBe(500);
   expect(cache.getCachedCatalog()).toBeNull();
   const recovered=await request(app).get('/api/pos/products').set('Cookie',cookie);
   expect(recovered.status).toBe(200);
   expect(recovered.body.products.length).toBeGreaterThan(0);
  }finally{spy.mockRestore();}
 });
 it('rebuilds an in-flight read when a product update commits before it can respond',async()=>{
  cache.invalidateCatalogCache();
  const originalQuery=pool.query.bind(pool);let observed,release;
  const readStarted=new Promise(resolve=>{observed=resolve});
  const resume=new Promise(resolve=>{release=resolve});
  let intercepted=false;
  const spy=vi.spyOn(pool,'query').mockImplementation(async(sql,args)=>{
   const result=await originalQuery(sql,args);
   if(!intercepted&&String(sql).includes('SELECT p.id, p.category_id, p.barcode')){
    intercepted=true;observed(result[0]);await resume;
   }
   return result;
  });
  let pending,joined;
  try{
   pending=request(app).get('/api/pos/products').set('Cookie',cookie).then(response=>response);
   const rows=await readStarted;const product=rows.find(row=>!row.is_bundle);expect(product).toBeDefined();
   joined=request(app).get('/api/pos/products').set('Cookie',cookie).then(response=>response);
   await new Promise(resolve=>setImmediate(resolve));
   await originalQuery('UPDATE products SET name=? WHERE id=?',['Changed during catalog read',product.id]);
   cache.invalidateCatalogCache();release();
   const responses=await Promise.all([pending,joined]);
   expect(responses.every(response=>response.status===200)).toBe(true);
   expect(responses.every(response=>response.body.products.find(p=>p.id===product.id).name==='Changed during catalog read')).toBe(true);
   expect(cache.getCachedCatalog().products.find(p=>p.id===product.id).name).toBe('Changed during catalog read');
  }finally{release();if(pending)await pending;if(joined)await joined;spy.mockRestore();}
 });
 it('skips linked stock projection only while stock tracking is disabled',async()=>{
  const [[product]]=await pool.query('SELECT id,stock FROM products WHERE is_bundle=0 ORDER BY id LIMIT 1');
  const [created]=await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES (?,'count','unit','active')",[`Catalog stock ${Date.now()}`]);
  const stockItemId=created.insertId;
  try{
   await pool.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known) VALUES (?,5,1)',[stockItemId]);
   await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)',[product.id,stockItemId]);
   await pool.query('UPDATE products SET stock=99 WHERE id=?',[product.id]);

   await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='stock_enabled'");
   cache.invalidateCatalogCache();
   const disabled=await request(app).get('/api/pos/products').set('Cookie',cookie);
   expect(disabled.status).toBe(200);
   expect(Number(disabled.body.products.find(row=>row.id===product.id).stock)).toBe(99);

   await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
   cache.invalidateCatalogCache();
   const enabled=await request(app).get('/api/pos/products').set('Cookie',cookie);
   expect(enabled.status).toBe(200);
   expect(Number(enabled.body.products.find(row=>row.id===product.id).stock)).toBe(5);
  }finally{
   await pool.query('DELETE FROM product_stock_links WHERE product_id=? AND stock_item_id=?',[product.id,stockItemId]);
   await pool.query('DELETE FROM stock_balances WHERE stock_item_id=?',[stockItemId]);
   await pool.query('DELETE FROM stock_items WHERE id=?',[stockItemId]);
   await pool.query('UPDATE products SET stock=? WHERE id=?',[product.stock,product.id]);
   await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='stock_enabled'");
   cache.invalidateCatalogCache();
  }
 });
 it('lightweight reads use the real stock setting with a cold root cache',async()=>{
  const [[product]]=await pool.query('SELECT id,stock,category_id FROM products WHERE is_bundle=0 AND category_id IS NOT NULL ORDER BY id LIMIT 1');
  const [created]=await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES (?,'count','unit','active')",[`Light stock ${Date.now()}`]);
  const stockItemId=created.insertId;
  try{
   await pool.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known) VALUES (?,5,1)',[stockItemId]);
   await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (?,?,1)',[product.id,stockItemId]);
   await pool.query('UPDATE products SET stock=99 WHERE id=?',[product.id]);
   await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='stock_enabled'");
   cache.invalidateCatalogCache();
   const res=await request(app).get('/api/pos/products').query({category_id:product.category_id,lightweight:1}).set('Cookie',cookie);
   expect(res.status).toBe(200);
   expect(Number(res.body.products.find(row=>row.id===product.id).stock)).toBe(99);
  }finally{
   await pool.query('DELETE FROM product_stock_links WHERE product_id=? AND stock_item_id=?',[product.id,stockItemId]);
   await pool.query('DELETE FROM stock_balances WHERE stock_item_id=?',[stockItemId]);
   await pool.query('DELETE FROM stock_items WHERE id=?',[stockItemId]);
   await pool.query('UPDATE products SET stock=? WHERE id=?',[product.stock,product.id]);
   cache.invalidateCatalogCache();
  }
 });
});
