// Real built admin/POS, HTTP authorization and database state in an owned loopback fixture.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { chromium, expect } = require('@playwright/test');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const { seedDatabase } = require('../../backend/tests/fixtures/seed');
const baseline = process.env.PERMISSIONS_UI_BASELINE === '1';
const output = `scratch/permissions-browser${baseline ? '-before' : ''}`;
const results = { database, runs: [], pageErrors: [] };
let created = false, server, io, browser;
process.on('exit', code => {
    if (!results.removed && created) {
        results.incompleteExit = code;
        fs.writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
    }
});
async function run() {
    fs.mkdirSync(output, { recursive: true });
    const owner = await mysql.createConnection(options);
    try { await owner.query(`CREATE DATABASE \`${database}\``); created = true; } finally { await owner.end(); }
    console.log(`Permissions browser fixture: ${database}`);
    fs.writeFileSync(`${output}/results.json`,JSON.stringify(results,null,2));
    await seedDatabase(); ({ server, io } = require('../../server'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    for (const [language, width] of [['en',1440],['ar',390]]) {
        await seedDatabase();
        const context=await browser.newContext({viewport:{width,height:1000}});
        await context.addInitScript(language=>{localStorage.setItem('pos_language',language);localStorage.setItem('pos_admin_language',language);window.print=()=>{};},language);
        const page=await context.newPage(); page.setDefaultTimeout(12000);
        let catalogRequests=0;
        page.on('request',request=>{if(request.url().endsWith('/api/admin/permissions'))catalogRequests++;});
        page.on('pageerror', error=>results.pageErrors.push(error.message));
        const ar=require('../../src/shared/i18n/ar.json');
        const t=key=>language==='ar' ? ar[key] || key : key;
        try {
            const login=await context.request.post(origin+'/api/auth/login',{data:{user_number:'9001'}});
            assert(login.ok(),await login.text());
            const settings=await context.request.post(origin+'/api/system/settings',{data:{admin_language:language,print_method:'browser'}});
            assert(settings.ok(),await settings.text());
            if(!baseline) await page.route('**/api/admin/permissions',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false})}),{times:1});
            await page.goto(origin+'/admin/users');
            await page.getByRole('button',{name:t('Add User'),exact:true}).click();
            await page.getByPlaceholder(t('Employee name')).fill('Cashier serving tables');
            if(!baseline) {
                await expect(page.getByRole('dialog').getByRole('button',{name:t('Save'),exact:true})).toBeDisabled();
                await page.getByRole('button',{name:t('Retry'),exact:true}).click();
                await expect(page.locator('.permission-editor')).toBeVisible();
                const grant=key=>page.locator(`[data-permission="${key}"] input[type="checkbox"]`);
                await page.getByLabel(t('Role'),{exact:true}).selectOption('waiter');
                await expect(grant('tables.access')).toBeChecked();
                await expect(grant('tables.access')).toBeDisabled();
                await expect(grant('waiter.edit_locked')).toBeChecked();
                await expect(grant('pos.checkout')).not.toBeChecked();
                await expect(page.locator('#user-table-scope')).toHaveValue('none');
                await expect(page.locator('[data-testid="permission-preview"]').getByText(t('Allowed'),{exact:true})).toHaveCount(0);
                await page.getByLabel(t('Role'),{exact:true}).selectOption('cashier');
                await grant('tables.save').check();
                await expect(page.locator('[data-permission="tables.save"]').getByRole('status')).toBeVisible();
                await grant('tables.access').check();
                await expect(page.locator('[data-permission="tables.save"]').getByRole('status')).toHaveCount(0);
                await expect(grant('waiter.edit_locked')).not.toBeChecked();
                const search=page.getByRole('searchbox',{name:t('Find a permission')});
                await search.fill(language==='ar'?'إرجاع':'refund');
                await expect(page.locator('[data-permission="pos.refund"]')).toBeVisible();
                await expect(page.locator('[data-permission="tables.save"]')).toHaveCount(0);
                await search.fill('zzzz-no-permission');
                await expect(page.getByText(t('No permissions match. Try another action or clear the search.'))).toBeVisible();
                await search.fill('');
                await expect(grant('tables.save')).toBeChecked();
                await page.locator('#user-permission-preset').selectOption('cashier_tables');
                await expect(grant('tables.access')).toBeChecked();
                await expect(grant('tables.save')).toBeChecked();
                await expect(grant('waiter.edit_locked')).not.toBeChecked();
                await page.locator('#user-table-scope').selectOption('selected');
                await expect(page.getByRole('dialog').getByRole('button',{name:t('Save'),exact:true})).toBeDisabled();
                await page.getByRole('dialog').locator('button[aria-pressed]').first().click();
                await expect(page.getByRole('dialog').getByRole('button',{name:t('Save'),exact:true})).toBeEnabled();
                assert.equal(catalogRequests,2,'searching and selecting permissions must not refetch the catalog');
                await page.getByLabel(t('PIN code'),{exact:true}).fill('5566');
            }
            await expect(page.getByText('Enter tables',{exact:true}).or(page.getByText('دخول الطاولات',{exact:true}))).toBeVisible();
            await page.locator('[role="dialog"] .overflow-y-auto').evaluate(el=>{el.scrollTop=0;});
            const layout=await page.getByRole('dialog').evaluate(dialog=>{
                const box=el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width};};
                return {dialog:box(dialog),title:box(dialog.querySelector('#userModalTitle')),scroll:box(dialog.querySelector('.overflow-y-auto')),footer:box(dialog.lastElementChild),overflow:dialog.scrollWidth>dialog.clientWidth};
            });
            assert(layout.title.top>=layout.dialog.top && layout.footer.bottom<=layout.dialog.bottom+1,JSON.stringify(layout));
            assert(layout.scroll.bottom<=layout.footer.top+1 && !layout.overflow,JSON.stringify(layout));
            await page.screenshot({path:`${output}/${language}-${width}-create.png`,fullPage:true,animations:'disabled'});
            if(!baseline) {
                const [response]=await Promise.all([
                    page.waitForResponse(r=>r.url().endsWith('/api/admin/users') && r.request().method()==='POST'),
                    page.getByRole('dialog').getByRole('button',{name:t('Save'),exact:true}).click(),
                ]);
                assert(response.ok(),await response.text());
                const {id}=await response.json();
                console.log(`${language}: created cashier ${id}`);
                const [[staff]]=await pool.query('SELECT role,allowed_sections,table_access_scope FROM users WHERE id=?',[id]);
                assert.equal(staff.role,'cashier');
                assert.equal(staff.table_access_scope,'selected');
                assert.equal(staff.allowed_sections,'1');
                const [grants]=await pool.query('SELECT perm_key FROM user_permissions WHERE user_id=?',[id]);
                assert.deepEqual(grants.map(row=>row.perm_key).sort(),['pos.checkout','pos.hold_orders','shift.open','shift.close','tables.access','tables.save'].sort());
                const cashier=await browser.newContext({viewport:{width,height:1000}});
                await cashier.addInitScript(language=>{localStorage.setItem('pos_language',language);localStorage.setItem('pos_admin_language',language);window.print=()=>{};},language);
                const till=await cashier.newPage();till.setDefaultTimeout(12000);
                till.on('pageerror',error=>results.pageErrors.push(error.message));
                const cashierLogin=async()=>{const res=await cashier.request.post(origin+'/api/auth/login',{data:{user_number:'5566'}});assert(res.ok(),await res.text());};
                const openTable=async()=>{
                    await till.goto(origin+'/tables');
                    await till.locator('[data-table-number="1"][data-testid="table-card"]').click();
                    await till.waitForURL(origin+'/pos');
                };
                const showCart=async()=>{
                    if(width<1024 && !await till.locator('.cart-panel').evaluate(el=>el.classList.contains('translate-x-0')))
                        await till.getByRole('button').filter({hasText:/View Order|عرض الطلب/}).last().click();
                };
                try {
                    await cashierLogin();
                    const shift=await cashier.request.post(origin+'/api/auth/shifts?action=open',{data:{user_id:id,starting_cash:50}});
                    assert(shift.ok(),await shift.text());
                    await openTable();
                    await till.locator('.product-card').filter({hasText:'Test Drink'}).click();
                    await showCart();
                    const [saved]=await Promise.all([
                        till.waitForResponse(r=>r.url().endsWith('/api/pos/table_order') && r.request().method()==='POST'),
                        till.getByRole('button',{name:t('Save Table'),exact:true}).click(),
                    ]);
                    assert(saved.ok(),await saved.text());
                    const savedBody=await saved.json();
                    console.log(`${language}: first saved invoice ${savedBody.invoice_id}`);
                    await expect(till.getByText(t('Editing this order requires Edit saved orders permission.'),{exact:true})).toBeVisible();
                    await expect(till.getByRole('button',{name:t('No Update Access'),exact:true})).toBeDisabled();
                    const [[first]]=await pool.query('SELECT invoice_number,order_id,version FROM orders WHERE invoice_id=?',[savedBody.invoice_id]);
                    assert.equal(first.invoice_number,null);assert.equal(first.order_id,null);
                    await showCart();
                    await till.screenshot({path:`${output}/${language}-${width}-first-saved.png`,fullPage:true,animations:'disabled'});
                    const current=await cashier.request.get(origin+`/api/pos/table_order?order_id=${savedBody.invoice_id}`);
                    const detail=await current.json();
                    const blocked=await cashier.request.post(origin+'/api/pos/table_order',{data:{table_id:1,current_order_id:savedBody.invoice_id,expected_version:detail.version,cart:detail.cart,subtotal:2,tax:0,total:2,require_update_permission:false}});
                    assert.equal(blocked.status(),403);
                    // Reopen the user through the visible editor, keep existing grants, enable later edits.
                    await page.getByPlaceholder(t('Search name, role or PIN')).fill('Cashier serving tables');
                    await page.getByRole('button',{name:t('Edit'),exact:true}).filter({visible:true}).click();
                    const edit=page.locator('[data-permission="waiter.edit_locked"] input');
                    await expect(edit).not.toBeChecked();await edit.check();
                    // Another administrator revokes checkout while this form is open.
                    const userList=await (await context.request.get(origin+'/api/admin/users')).json();
                    const latest=userList.users.find(user=>user.id===id);
                    const revoke=await context.request.put(origin+'/api/admin/users',{data:{...latest,permissions:latest.permissions.filter(key=>key!=='pos.checkout')}});
                    assert(revoke.ok(),await revoke.text());
                    const [conflicted]=await Promise.all([
                        page.waitForResponse(r=>r.url().endsWith('/api/admin/users') && r.request().method()==='PUT'),
                        page.getByRole('dialog').getByRole('button',{name:t('Save'),exact:true}).click(),
                    ]);
                    assert.equal(conflicted.status(),409);
                    await expect(page.getByRole('dialog').getByRole('button',{name:t('Save'),exact:true})).toBeDisabled();
                    const [afterConflict]=await pool.query("SELECT perm_key FROM user_permissions WHERE user_id=? AND perm_key IN ('pos.checkout','waiter.edit_locked')",[id]);
                    assert.deepEqual(afterConflict,[]);
                    await page.getByRole('button',{name:t('Load saved version'),exact:true}).click();
                    await expect(edit).not.toBeChecked();
                    const checkoutGrant=page.locator('[data-permission="pos.checkout"] input');
                    await expect(checkoutGrant).not.toBeChecked();
                    await page.locator('summary').filter({hasText:t('Sales and receipts')}).click();
                    await checkoutGrant.check();await edit.check();
                    const [updated]=await Promise.all([
                        page.waitForResponse(r=>r.url().endsWith('/api/admin/users') && r.request().method()==='PUT'),
                        page.getByRole('dialog').getByRole('button',{name:t('Save'),exact:true}).click(),
                    ]);
                    assert(updated.ok(),await updated.text());
                    console.log(`${language}: edit grant saved`);
                    // Use the visible login flow to refresh the browser's cached user grants too.
                    if(width<1024) await till.locator('.cart-nav-close').click();
                    await till.locator('.pos-user-trigger').click();
                    await till.getByRole('button',{name:t('Logout'),exact:true}).click();
                    await till.locator('#login-app').waitFor();
                    await till.keyboard.type('5566');
                    await till.getByRole('button',{name:t('Login'),exact:true}).click();
                    await till.waitForURL(origin+'/pos');
                    console.log(`${language}: cashier logged in again`);
                    const printed=await context.request.post(origin+'/api/pos/table_order',{data:{action:'mark_printed',table_id:1,expected_invoice_id:savedBody.invoice_id}});
                    assert(printed.ok(),await printed.text());
                    await openTable();
                    await till.locator('.product-card').filter({hasText:'Test Drink'}).click();
                    await showCart();
                    await expect(till.getByRole('button',{name:t('Save Table'),exact:true})).toBeEnabled();
                    const [edited]=await Promise.all([
                        till.waitForResponse(r=>r.url().endsWith('/api/pos/table_order') && r.request().method()==='POST'),
                        till.getByRole('button',{name:t('Save Table'),exact:true}).click(),
                    ]);
                    assert(edited.ok(),await edited.text());
                    console.log(`${language}: printed order updated`);
                    const [[item]]=await pool.query('SELECT SUM(quantity) quantity FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',[savedBody.invoice_id]);
                    assert.equal(Number(item.quantity),2);
                    await showCart();
                    await till.screenshot({path:`${output}/${language}-${width}-edit-saved.png`,fullPage:true,animations:'disabled'});
                    const pay=till.getByRole('button',{name:t('Pay'),exact:true}).and(till.locator('.cart-final-action'));
                    await expect(pay).toBeEnabled();await pay.click();
                    const payment=till.getByRole('dialog',{name:t('Complete Payment')});
                    await payment.getByRole('button',{name:new RegExp(t('Cash'),'i')}).first().click();
                    await payment.getByRole('textbox',{name:t('Amount Tendered')}).fill('4');
                    const [paid]=await Promise.all([
                        till.waitForResponse(r=>r.url().endsWith('/api/pos/checkout') && r.request().method()==='POST'),
                        payment.getByRole('button',{name:new RegExp(t('CONFIRM PAYMENT'),'i')}).click(),
                    ]);
                    assert(paid.ok(),await paid.text());await expect(payment).toBeHidden();
                    const [[sale]]=await pool.query('SELECT payment_method,total FROM orders WHERE invoice_id=?',[savedBody.invoice_id]);
                    assert.equal(sale.payment_method,'cash');assert.equal(Number(sale.total),4);
                    const [[table]]=await pool.query('SELECT status,current_order_id FROM restaurant_tables WHERE id=1');
                    assert.deepEqual(table,{status:'available',current_order_id:null});
                    const [[openShift]]=await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'",[id]);
                    const close=await cashier.request.put(origin+'/api/auth/shifts?action=close',{data:{shift_id:openShift.id,actual_cash:54}});
                    assert(close.ok(),await close.text());assert.equal(Number((await close.json()).expected_cash),54);
                    // A separate shift verifies temporary checkout approval through the real UI.
                    await cashierLogin();
                    const approvalShift=await cashier.request.post(origin+'/api/auth/shifts?action=open',{data:{user_id:id,starting_cash:50}});
                    assert(approvalShift.ok(),await approvalShift.text());
                    await till.goto(origin+'/pos');
                    await till.locator('.product-card').filter({hasText:'Test Drink'}).click();
                    await showCart();
                    await till.getByRole('button',{name:t('More'),exact:true}).click();
                    await expect(till.getByRole('button',{name:t('Order Discount'),exact:true})).toHaveCount(0);
                    await till.getByRole('button',{name:t('Approve checkout changes'),exact:true}).click();
                    const approvalModal=till.locator('.modal-panel').filter({has:till.getByRole('heading',{name:t('Approve checkout changes'),exact:true})});
                    await approvalModal.locator('input[type="password"]').fill('1234');
                    const [approved]=await Promise.all([
                        till.waitForResponse(r=>r.url().endsWith('/api/auth/manager_override')),
                        approvalModal.getByRole('button',{name:t('Unlock'),exact:true}).click(),
                    ]);
                    assert(approved.ok(),await approved.text());
                    assert.deepEqual((await approved.json()).permissions.sort(),['pos.discount','pos.price_override']);
                    await expect(approvalModal).toBeHidden();
                    await till.getByRole('button',{name:t('More'),exact:true}).click();
                    await expect(till.getByRole('button',{name:t('Checkout approval active'),exact:true})).toBeVisible();
                    await till.getByRole('button',{name:t('Order Discount'),exact:true}).click();
                    const discountModal=till.locator('.modal-panel').filter({has:till.getByRole('heading',{name:t('Order Discount'),exact:true})});
                    await discountModal.getByRole('button',{name:t('Percentage (%)'),exact:true}).click();
                    await discountModal.locator('input[type="number"]').fill('10');
                    await discountModal.getByRole('button',{name:t('Save'),exact:true}).click();
                    await pay.click();
                    await payment.getByRole('button',{name:new RegExp(t('Cash'),'i')}).first().click();
                    await payment.getByRole('textbox',{name:t('Amount Tendered')}).fill('2');
                    const [discounted]=await Promise.all([
                        till.waitForResponse(r=>r.url().endsWith('/api/pos/checkout') && r.request().method()==='POST'),
                        payment.getByRole('button',{name:new RegExp(t('CONFIRM PAYMENT'),'i')}).click(),
                    ]);
                    assert(discounted.ok(),await discounted.text());
                    await expect(payment).toBeHidden();
                    const discountInvoice=(await discounted.json()).invoice_id;
                    const [[discountSale]]=await pool.query('SELECT user_id,total,discount_value FROM orders WHERE invoice_id=?',[discountInvoice]);
                    assert.equal(discountSale.user_id,id);assert.equal(Number(discountSale.total),1.8);assert.equal(Number(discountSale.discount_value),10);
                    if(width<1024 && await till.locator('.cart-panel').evaluate(el=>el.classList.contains('translate-x-0'))) await till.locator('.cart-nav-close').click();
                    await till.locator('.pos-user-trigger').click();
                    await expect(till.getByRole('button',{name:t('X-Report'),exact:true})).toHaveCount(0);
                    await expect(till.getByRole('button',{name:t('Close Shift'),exact:true})).toBeVisible();
                    await expect(till.locator('[class*="slide-sidebar-"][class*="-enter-active"]')).toHaveCount(0);
                    await till.screenshot({path:`${output}/${language}-${width}-approval-role.png`,fullPage:true,animations:'disabled'});
                    const [[approvalOpen]]=await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'",[id]);
                    const approvalClose=await cashier.request.put(origin+'/api/auth/shifts?action=close',{data:{shift_id:approvalOpen.id,actual_cash:51.8}});
                    assert(approvalClose.ok(),await approvalClose.text());assert.equal(Number((await approvalClose.json()).expected_cash),51.8);
                    // Role-specific editor must explain automatic access and fixed roles.
                    await page.getByRole('button',{name:t('Edit'),exact:true}).filter({visible:true}).click();
                    await page.getByLabel(t('Role'),{exact:true}).selectOption('waiter');
                    await expect(page.locator('[data-permission="tables.access"] input')).toBeChecked();
                    await expect(page.locator('[data-permission="tables.access"] input')).toBeDisabled();
                    await expect(page.locator('[data-permission="tables.save"]')).toHaveCount(0);
                    await page.getByLabel(t('Role'),{exact:true}).selectOption('admin');
                    await expect(page.locator('.permission-editor')).toHaveCount(0);
                    await expect(page.getByText(t('Administrators have full access. Individual permission switches do not restrict this role.'))).toBeVisible();
                    await page.getByLabel(t('Role'),{exact:true}).selectOption('call_center');
                    await expect(page.locator('.permission-editor')).toHaveCount(0);
                    await expect(page.getByText(t('Call center users can prepare and send orders. They cannot take payment or access tables.'))).toBeVisible();
                    await page.getByRole('dialog').getByRole('button',{name:t('Cancel'),exact:true}).click();
                    await page.getByRole('button',{name:t('Add User'),exact:true}).click();
                    await page.getByPlaceholder(t('Employee name')).fill('Lost reply waiter');
                    await page.getByLabel(t('PIN code'),{exact:true}).fill('6677');
                    await page.getByLabel(t('Role'),{exact:true}).selectOption('waiter');
                    let committedId, createRequests=0;
                    const loseReply=async route=>{
                        if(route.request().method()!=='POST') return route.continue();
                        createRequests++;
                        const response=await route.fetch();
                        assert(response.ok(),await response.text());
                        committedId=(await response.json()).id;
                        await route.abort('failed');
                    };
                    await page.route('**/api/admin/users',loseReply);
                    await page.getByRole('dialog').getByRole('button',{name:t('Save'),exact:true}).click();
                    await expect(page.getByRole('button',{name:t('Check saved user'),exact:true})).toBeVisible();
                    await expect(page.getByRole('dialog').getByRole('button',{name:t('Save'),exact:true})).toBeDisabled();
                    await page.getByRole('button',{name:t('Check saved user'),exact:true}).click();
                    await expect(page.getByRole('heading',{name:t('Edit User'),exact:true})).toBeVisible();
                    assert.equal(createRequests,1);
                    const [[lostCount]]=await pool.query("SELECT COUNT(*) AS count FROM users WHERE user_number='6677' AND id=?",[committedId]);
                    assert.equal(lostCount.count,1);
                    const [waiterGrants]=await pool.query('SELECT perm_key FROM user_permissions WHERE user_id=?',[committedId]);
                    assert.deepEqual(waiterGrants.map(row=>row.perm_key),['waiter.edit_locked']);
                    await page.unroute('**/api/admin/users',loseReply);
                    await page.locator('[role="dialog"] .overflow-y-auto').evaluate(el=>{el.scrollTop=0;});
                    await page.screenshot({path:`${output}/${language}-${width}-waiter-preview.png`,fullPage:true,animations:'disabled'});
                    await page.getByRole('dialog').getByRole('button',{name:t('Cancel'),exact:true}).click();
                    results.runs.push({language,width,createUser:true,searchPreservesGrants:true,catalogRequests,catalogFailureRetry:true,staleEditRejected:409,explicitConflictReload:true,firstSave:200,laterEditDenied:403,editAfterGrantAndPrint:200,quantity:2,checkout:4,expectedClosingCash:54,roleStates:true,explicitSections:true,presets:true,lostCreateReplyRecovered:true,approvedDiscountCheckout:1.8,approvalShiftClosingCash:51.8,approvalKeepsCashierRole:true});
                } catch(error) {
                    await till.screenshot({path:`${output}/${language}-${width}-pos-failure.png`,fullPage:true}).catch(()=>{});
                    fs.writeFileSync(`${output}/${language}-${width}-pos-failure.txt`,await till.locator('body').innerText().catch(()=>''));
                    throw error;
                } finally {await cashier.close();}
            }
            else results.runs.push({language,width,baseline});
        } catch(error) {
            await page.screenshot({path:`${output}/${language}-${width}-failure.png`,fullPage:true}).catch(()=>{});
            fs.writeFileSync(`${output}/${language}-${width}-failure.txt`,await page.locator('body').innerText().catch(()=>''));
            throw error;
        } finally { await context.close(); }
    }
    assert.deepEqual(results.pageErrors,[]); results.complete=true;
}
run().catch(error=>{results.error=error.stack;console.error(error);process.exitCode=1;}).finally(async()=>{
    await browser?.close();
    if(io)await new Promise(resolve=>io.close(resolve));
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    await pool.end();
    if(created){const owner=await mysql.createConnection(options);try{await owner.query(`DROP DATABASE \`${database}\``);results.removed=true;}finally{await owner.end();}}
    fs.writeFileSync(`${output}/results.json`,JSON.stringify(results,null,2));
});
