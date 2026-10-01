// Real built UI/API acceptance. Creates and removes only its own loopback fixture.
const fs=require('node:fs'),{randomBytes}=require('node:crypto');
process.env.POSAPP_REVIEW_DB=`posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql=require('mysql2/promise');
const {database,...options}=require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool=require('../../backend/config/db');
let created=false,server,io;
async function browserAcceptance(base){
    const {chromium,expect}=require('@playwright/test');
    const browser=await chromium.launch({headless:true});
    const evidence=[];
    try{
        for(const [language,width] of [['en',1280],['ar',390]]){
            const context=await browser.newContext({viewport:{width,height:900}});
            await context.addInitScript(language=>localStorage.setItem('pos_admin_language',language),language);
            const login=await context.request.post(base+'/api/auth/login',{data:{user_number:'9001'}});
            if(!login.ok())throw new Error(await login.text());
            const settings=await context.request.post(base+'/api/system/settings',{data:{admin_language:language}});
            if(!settings.ok())throw new Error(await settings.text());
            const page=await context.newPage(),errors=[];
            page.on('pageerror',error=>errors.push(error.message));
            await page.goto(base+'/admin/reports-ingredients');await page.waitForLoadState('networkidle');
            const workspace=page.locator('.analysis-workspace');await expect(workspace).toBeVisible();
            const rows=workspace.locator('.meal-table tbody tr');await expect(rows).toHaveCount(50);
            const controls=await workspace.locator('button').allTextContents();
            const seen=await rows.locator('th').allTextContents();
            const nav=workspace.locator('nav.pagination').first();
            await nav.locator('button').last().click();await expect(nav.locator('span')).toHaveText('2');
            await expect(rows).toHaveCount(50);seen.push(...await rows.locator('th').allTextContents());
            await nav.locator('button').last().click();await expect(nav.locator('span')).toHaveText('3');
            await expect(rows).toHaveCount(5);seen.push(...await rows.locator('th').allTextContents());
            if(new Set(seen).size!==105)throw new Error('Pagination omitted or duplicated meals');
            await workspace.locator('.analysis-views input').fill('Browser meal 104');
            await expect(rows).toHaveCount(1);await expect(rows.first().locator('th')).toHaveText('Browser meal 104');
            await rows.first().locator('button').click();await expect(workspace.locator('.calculation h3')).toHaveText('Browser meal 104');
            await expect(workspace.locator('.source-event')).toHaveCount(1);
            const screenshot=`scratch/stock-report-pagination-${language}-${width}.png`;
            await page.screenshot({path:screenshot,fullPage:true});
            await expect(page.locator('html')).toHaveAttribute('dir',language==='ar'?'rtl':'ltr');
            if(!await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1))throw new Error('Document overflows horizontally');
            if(errors.length)throw new Error(errors.join('\n'));
            evidence.push({language,width,unique_meals:new Set(seen).size,searched_last_meal:true,real_event_drilldown:true,page_errors:errors,controls,screenshot});
            await context.close();
        }
    }finally{await browser.close();}
    fs.writeFileSync('scratch/stock-report-pagination-browser.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));
}
async function run(){
    const admin=await mysql.createConnection(options);
    try{await admin.query(`CREATE DATABASE \`${database}\``);created=true;}finally{await admin.end();}
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key IN ('stock_enabled','recipe_ledger_enabled')");
    const day=require('../../backend/utils/businessDate').getBusinessDate();
    const [order]=await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES (1,105,0,105,'cash',?)",[`${day} 10:00:00`]);
    await pool.query('INSERT INTO products(id,name,price,category_id) VALUES ?',[Array.from({length:105},(_,n)=>[100+n,`Browser meal ${String(n).padStart(3,'0')}`,1,1])]);
    await pool.query('INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale) VALUES ?',[Array.from({length:105},(_,n)=>[order.insertId,100+n,`Browser meal ${String(n).padStart(3,'0')}`,1,1])]);
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
