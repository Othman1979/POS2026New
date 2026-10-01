// Real built UI/API acceptance. Creates and removes only its own loopback fixture.
const fs=require('node:fs'),{randomBytes}=require('node:crypto');
process.env.POSAPP_REVIEW_DB=`posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql=require('mysql2/promise');
const {database,...options}=require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool=require('../../backend/config/db');
let created=false,server,io;
async function browserAcceptance(base){
 const {chromium,expect}=require('@playwright/test'),browser=await chromium.launch({headless:true});const evidence=[];
 try{for(const [language,width] of [['en',1280],['ar',390]]){
 const context=await browser.newContext({viewport:{width,height:900}});
  const translations=JSON.parse(fs.readFileSync('src/shared/i18n/ar.json','utf8'));
  const t=key=>language==='ar'?(translations[key]||key):key;
  await context.addInitScript(lang=>localStorage.setItem('pos_admin_language',lang),language);
  const login=await context.request.post(base+'/api/auth/login',{data:{user_number:'9001'}});if(!login.ok())throw new Error(await login.text());
  const settings=await context.request.post(base+'/api/system/settings',{data:{admin_language:language}});if(!settings.ok())throw new Error(await settings.text());
  if(language==='en'){
   const inspected=await context.request.get(base+'/api/admin/stock/products/1/activation');const preview=await inspected.json();
   const activated=await context.request.post(base+'/api/admin/stock/products/1/activate',{data:{expected_stock_version:preview.stock_version,request_key:randomBytes(16).toString('hex')}});if(!activated.ok())throw new Error(await activated.text());
  }
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/admin/ingredients');await page.waitForLoadState('networkidle');
  const ledger=page.locator('.ingredients-page');await expect(ledger.locator('.ingredient-table tbody tr')).toHaveCount(10);
  // No matching list rows must not disable receiving an ingredient elsewhere.
  await ledger.locator('.ledger-search input').fill('No matching ingredient');await expect(ledger.locator('.ingredient-table tbody tr')).toHaveCount(1);
  await ledger.locator('.stock-action').nth(0).click();
  const form=page.locator('.batch-form');await expect(form).toBeVisible();
  await expect(form.locator('.ingredient-picker button')).toHaveCount(20);
  await form.getByRole('button',{name:t('Load more'),exact:true}).click();
  await expect(form.locator('.ingredient-picker button')).toHaveCount(40);
  await expect(form.locator('.ingredient-picker')).toContainText('Material 000');
  await expect(form.locator('.ingredient-picker')).toContainText('Material 039');
  await form.locator('input[type=search]').fill('Material 109');
  await form.locator('.ingredient-picker button').filter({hasText:'Material 109'}).click();
  await form.locator('.batch-row input[type=number]').first().fill('2');
  await form.locator('button[type=submit]').click();await expect(form).toBeHidden();
  const [[actual]]=await pool.query("SELECT i.working_quantity AS quantity,b.quantity AS physical_quantity FROM ingredients i JOIN stock_balances b ON b.stock_item_id=i.stock_item_id WHERE i.name='Material 109'");
  if(Number(actual.quantity)!==(language==='en'?102:104))throw new Error('Delivery did not update remote ingredient exactly once');
  if(Number(actual.physical_quantity)!==Number(actual.quantity))throw new Error('Delivery did not update activated physical stock exactly once');
  await ledger.locator('.ledger-search input').fill('Material 109');await expect(ledger.locator('.ingredient-table tbody tr')).toHaveCount(1);
  await expect(ledger.locator('.ingredient-table tbody')).toContainText('Material 109');
  await ledger.locator('.stock-action').nth(2).click();
  const waste=page.locator('.waste-picker');
  await expect(waste.locator('button').filter({hasText:'Material'})).toHaveCount(20);
  await waste.getByRole('button',{name:t('Load more'),exact:true}).click();
  await expect(waste.locator('button').filter({hasText:'Material'})).toHaveCount(40);
  await expect(waste).toContainText('Material 000');await expect(waste).toContainText('Material 039');
  await page.getByRole('dialog').getByRole('button',{name:t('Close'),exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('dir',language==='ar'?'rtl':'ltr');
  if(!await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1))throw new Error('Horizontal document overflow');
  const screenshot=`scratch/stock-working-list-${language}-${width}.png`;await page.screenshot({path:screenshot,fullPage:true});
  await page.goto(base+'/admin/inventory');await page.waitForLoadState('networkidle');
  await page.getByRole('button',{name:language==='ar'?translations['Stock levels']:'Stock levels',exact:true}).click();
  const stock=page.locator('.stock-working');await expect(stock).toBeVisible();
  await expect(stock.locator('tbody tr')).toHaveCount(1);
  await expect(stock.locator('thead th')).toHaveCount(3);
  await expect(stock.locator('select')).toHaveCount(2);
  const clippedControls=await stock.evaluate(root=>{
   const frame=root.getBoundingClientRect();
   return [...root.querySelectorAll('.working-heading,.working-filters label,.working-filters input,.working-filters select,.working-footer')]
    .filter(node=>{const box=node.getBoundingClientRect();return box.left<frame.left-1||box.right>frame.right+1;})
    .map(node=>({tag:node.tagName,class:node.className,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right,frameLeft:frame.left,frameRight:frame.right}));
  });
  if(clippedControls.length)throw new Error('Clipped stock controls: '+JSON.stringify(clippedControls));
  await expect(page.locator('[href*=receiving]')).toHaveCount(0);
  if(!await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1))throw new Error('Stock document overflow');
  const stockScreenshot=`scratch/stock-simplified-${language}-${width}.png`;await page.screenshot({path:stockScreenshot,fullPage:true});
  const paused=await context.request.post(base+'/api/system/settings',{data:{stock_enabled:'0'}});if(!paused.ok())throw new Error(await paused.text());
  await page.evaluate(()=>window.dispatchEvent(new Event('settings_changed')));await expect(stock).toBeHidden();
  const resumed=await context.request.post(base+'/api/system/settings',{data:{stock_enabled:'1'}});if(!resumed.ok())throw new Error(await resumed.text());
  // Existing inactive products can retain recipes that contain archived ingredients.
  await pool.query('DELETE FROM product_recipe_lines WHERE product_id=2');
  await pool.query("INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) SELECT 2,id,10,IF(is_active=1,0,1) FROM ingredients WHERE name IN ('Material 000','Archived ingredient')");
  await page.goto(base+'/admin/ingredients');await page.waitForLoadState('networkidle');
  await page.getByRole('button',{name:t('Product recipes'),exact:true}).click();
  await page.locator('.recipe-products li').filter({hasText:'Test Drink'}).getByRole('button').click();
  const recipe=page.locator('.recipe-editor');await expect(recipe.locator('tbody tr')).toHaveCount(2);
  await recipe.locator('tbody tr').filter({hasText:'Material 000'}).locator('input').first().fill('15');
  await expect(recipe.getByRole('button',{name:t('Save recipe'),exact:true})).toBeDisabled();
  const before=await (await context.request.get(base+'/api/admin/products/2/recipe')).json();
  if(before.lines.length!==2)throw new Error('Opening recipe silently removed archived ingredient');
  await recipe.locator('tbody tr').filter({hasText:'Archived ingredient'}).getByRole('button',{name:t('Remove'),exact:true}).click();
  await recipe.getByRole('button',{name:t('Save recipe'),exact:true}).click();
  await expect(recipe.locator('tbody tr')).toHaveCount(1);await expect(recipe.getByRole('button',{name:t('Save recipe'),exact:true})).toBeDisabled();
  const after=await (await context.request.get(base+'/api/admin/products/2/recipe')).json();
  if(after.lines.length!==1||after.lines[0].qty!==15)throw new Error('Explicit recipe edit did not persist');
  const recipeScreenshot=`scratch/stock-recipe-review-${language}-${width}.png`;await page.screenshot({path:recipeScreenshot,fullPage:true});
  if(!await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1))throw new Error('Recipe document overflow');
  if(errors.length)throw new Error(errors.join('\n'));evidence.push({language,width,remote_receiving:true,picker_pages_retained:true,waste_pages_retained:true,stock_disable_exits_ledger:true,inactive_recipe_explicit_removal:true,filtered_list_does_not_disable_operation:true,quantity:Number(actual.quantity),page_errors:errors,screenshot,stockScreenshot,recipeScreenshot,stock_columns:3,stock_filters:2});
  await context.close();
 }}finally{await browser.close();}
 fs.writeFileSync('scratch/stock-working-list-browser.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}
async function run(){
    const admin=await mysql.createConnection(options);
    try{await admin.query(`CREATE DATABASE \`${database}\``);created=true;}finally{await admin.end();}
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key IN ('stock_enabled','recipe_ledger_enabled')");
    const day=require('../../backend/utils/businessDate').getBusinessDate();
    await pool.query('INSERT INTO ingredients(name,measure,display_unit) VALUES ?',[Array.from({length:110},(_,i)=>['Material '+String(i).padStart(3,'0'),'weight','g'])]);
    await pool.query("INSERT INTO ingredients(name,measure,display_unit,is_active) VALUES ('Archived ingredient','weight','g',0)");
    await pool.query('UPDATE products SET is_active=0 WHERE id=2');
    const [ingredients]=await pool.query('SELECT id FROM ingredients WHERE is_active=1 ORDER BY id');
    const conn=await require('../../backend/services/StockReportInvalidation').getConnection(pool);
    try{await conn.beginTransaction();await require('../../backend/services/RecipeLedgerService').recordOpeningCounts(conn,{entries:ingredients.map(row=>({ingredientId:row.id,qty:100,unit:'g'})),clientKey:randomBytes(16).toString('hex'),businessDate:day,actor:{id:1}});await conn.commit();}
    catch(e){await conn.rollback();throw e;}finally{conn.release();}
    const activation=require('../../backend/services/StockActivationService');
    const preview=await activation.inspectIngredient(pool,ingredients.at(-1).id);
    const cutover=await require('../../backend/services/StockReportInvalidation').getConnection(pool);
    try {
        await cutover.beginTransaction();
        await activation.activateIngredient(cutover,ingredients.at(-1).id,{observation_token:preview.observation_token,request_key:randomBytes(16).toString('hex')},1);
        await cutover.commit();
    } catch(error) {await cutover.rollback();throw error;} finally {cutover.release();}
    await require('../../backend/services/StockReportGenerationService').ensureCoverage(pool,{startDate:day,endDate:day});
    await require('../../backend/services/StockReportWorker').drain(pool);
    ({server,io}=require('../../server'));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    fs.mkdirSync('scratch',{recursive:true});
    await browserAcceptance(`http://127.0.0.1:${server.address().port}`);
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    if(io)await new Promise(resolve=>io.close(resolve));
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    await pool.end();
    if(created){const admin=await mysql.createConnection(options);try{await admin.query(`DROP DATABASE \`${database}\``);}finally{await admin.end();}}
});
