// Scanner key events through the built POS, API and real isolated database.
const fs = require('node:fs');
const { randomBytes, randomUUID } = require('node:crypto');
process.env.TZ = process.env.POSAPP_REVIEW_TIMEZONE || 'UTC';
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
let created = false, server, io, browser;

async function run() {
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; }
    finally { await admin.end(); }
    const { seedDatabase, SEED } = require('../../backend/tests/fixtures/seed');
    await seedDatabase();
    ({ server, io } = require('../../server'));
    require('../../backend/config/logger').level = 'error';
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const { chromium, expect } = require('@playwright/test');
    browser = await chromium.launch({ headless: true });
    await pool.query("INSERT INTO settings(setting_key,setting_value) VALUES('store_name','Corner Cafe'),('barcode_enabled','1'),('print_method','backend') ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)");
    const [kitchen]=await pool.query("INSERT INTO printers(name,role,type,windows_name,spooler_id) VALUES('Hold Kitchen','kitchen','windows','Kitchen','held-browser')");
    const [receipt]=await pool.query("INSERT INTO printers(name,role,type,windows_name,spooler_id) VALUES('Hold Customer','receipt','windows','Receipt','held-browser')");
    await pool.query('INSERT INTO printer_categories(printer_id,category_id) VALUES(?,?)',[kitchen.insertId,SEED.category.id]);
    await pool.query("UPDATE products SET barcode='991122',name='Held test meal',price=5,tax_rate=0,jofotara_tax_category='Z' WHERE id=?",[SEED.product1.id]);
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(id=>localStorage.setItem('pos_receipt_printer_id',String(id)),receipt.insertId);
    const login=await context.request.post(base+'/api/auth/login',{data:{user_number:SEED.adminUser.user_number}});
    expect(login.ok()).toBe(true);
    await context.request.post(base+'/api/auth/shifts?action=open',{data:{user_id:SEED.adminUser.id,starting_cash:0}});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/pos');await page.waitForLoadState('networkidle');
    await page.locator('.catalog-barcode input').fill('991122');await page.locator('.catalog-barcode input').press('Enter');
    await expect(page.locator('.cart-panel')).toContainText('Held test meal');
    await page.locator('.cart-final-action.bg-primary').click();
    await page.evaluate(()=>{window.showPosPrompt=async()=> 'Private customer reference';});
    const holdResponse=page.waitForResponse(r=>r.url().endsWith('/api/pos/held_orders')&&r.request().method()==='POST');
    await page.locator('.checkout-hold').click();
    const held=await(await holdResponse).json();expect(held.success,JSON.stringify(held)).toBe(true);expect(held.order_display_no).toBe('1');
    const [firstJobs]=await pool.query('SELECT print_type,payload FROM print_queue ORDER BY id');
    expect(firstJobs.map(j=>j.print_type).sort()).toEqual(['kitchen','receipt']);
    const printed=JSON.parse(firstJobs.find(j=>j.print_type==='receipt').payload).data;
    expect(printed.compiled_document_v1.html).not.toMatch(/Invoice:|Ticket:|GUEST CHECK|Private customer reference|Payment/);
    await page.goto(base+'/order-notes');await page.waitForLoadState('networkidle');
    // Item names live in the preview, so identify the board card by its saved reference.
    const heldCard=page.locator('.note-card').filter({hasText:'Private customer reference'});
    await expect(heldCard).toHaveCount(1);
    await expect(heldCard.locator('.note-card__identity')).toContainText('Order #1');
    const totalBox=await heldCard.locator('.note-card__total').boundingBox();
    const actionBox=await heldCard.locator('.note-card__actions').boundingBox();
    expect(totalBox.y+totalBox.height<=actionBox.y || totalBox.x+totalBox.width<=actionBox.x).toBe(true);

    const reprintResponse=page.waitForResponse(r=>r.url().endsWith(`/held_orders/${held.id}/print_receipt`));
    await heldCard.locator('.note-card__action--reprint').click();
    expect((await(await reprintResponse).json()).order_display_no).toBe('1');
    await page.screenshot({path:'scratch/held-number-board.png',fullPage:true});
    for (let cycle = 0; cycle < 2; cycle++) {
        await heldCard.locator('.note-card__action--restore').click();
        await page.waitForURL('**/pos');
        await expect(page.locator('.cart-panel')).toContainText('Held test meal');
        await page.locator('.cart-final-action.bg-primary').click();
        const savedResponse = page.waitForResponse(r => r.url().endsWith(`/api/pos/held_orders/${held.id}`) && r.request().method() === 'PATCH');
        await page.locator('.checkout-hold').click();
        const saved = await (await savedResponse).json();
        expect(saved.success, JSON.stringify(saved)).toBe(true);
        expect(saved.order_display_no).toBe('1');
        expect(saved.customer_receipt).toBeNull();
        const [[counts]] = await pool.query("SELECT COUNT(*) count FROM print_queue WHERE print_type='kitchen'");
        expect(Number(counts.count)).toBe(1);
        await page.goto(base+'/order-notes'); await page.waitForLoadState('networkidle');
        await expect(heldCard.locator('.note-card__identity')).toContainText('Order #1');
    }
    await heldCard.locator('.note-card__action--restore').click();
    await page.waitForURL('**/pos');await expect(page.locator('.cart-panel')).toContainText('Held test meal');
    await page.locator('.cart-final-action.bg-primary').click();
    const paidResponse=page.waitForResponse(r=>r.url().endsWith('/api/pos/checkout')&&r.request().method()==='POST');
    await page.locator('.checkout-confirm').click();
    const paid=await(await paidResponse).json();expect(paid.success,JSON.stringify(paid)).toBe(true);
    const [[order]]=await pool.query('SELECT order_id,invoice_number FROM orders ORDER BY invoice_id DESC LIMIT 1');expect(order.order_id).toBe(1);expect(order.invoice_number).not.toBeNull();
    const [[kitchenCount]]=await pool.query("SELECT COUNT(*) count FROM print_queue WHERE print_type='kitchen'");expect(Number(kitchenCount.count)).toBe(1);
    expect(errors).toEqual([]);
    const artifactPage=await context.newPage();await artifactPage.setContent(`<style>${printed.compiled_document_v1.css}</style>${printed.compiled_document_v1.html}`);
    await artifactPage.screenshot({path:'scratch/held-number-receipt.png',fullPage:true});
    fs.writeFileSync('scratch/held-number-browser.json',JSON.stringify({heldNumber:held.order_display_no,automaticJobs:firstJobs.map(j=>j.print_type),paidOrderNumber:order.order_id,invoiceCreated:order.invoice_number!=null,errors},null,2));
    // Verify the browser-mode automatic path invokes printing on the canonical iframe.
    await pool.query("UPDATE settings SET setting_value='browser' WHERE setting_key='print_method'");
    const browserContext=await browser.newContext({viewport:{width:1280,height:900}});
    await browserContext.addInitScript(()=>{
        window.print=()=>{window.parent.postMessage({receiptText:document.body.innerText},'*');window.dispatchEvent(new Event('afterprint'));};
        window.addEventListener('message',event=>{if(event.data?.receiptText)window.printedReceiptText=event.data.receiptText;});
    });
    await browserContext.request.post(base+'/api/auth/login',{data:{user_number:SEED.adminUser.user_number}});
    const browserPage=await browserContext.newPage();await browserPage.goto(base+'/pos');await browserPage.waitForLoadState('networkidle');
    await browserPage.locator('.catalog-barcode input').fill('991122');await browserPage.locator('.catalog-barcode input').press('Enter');
    await expect(browserPage.locator('.cart-panel')).toContainText('Held test meal');
    await browserPage.locator('.cart-final-action.bg-primary').click();
    await browserPage.evaluate(()=>{window.showPosPrompt=async()=> 'Browser hold';});
    const browserHoldResponse=browserPage.waitForResponse(r=>r.url().endsWith('/api/pos/held_orders')&&r.request().method()==='POST');
    await browserPage.locator('.checkout-hold').click();
    const browserHeld=await(await browserHoldResponse).json();expect(browserHeld.customer_receipt.mode).toBe('browser');
    await browserPage.waitForFunction(()=>window.printedReceiptText?.includes('Order:'));
    expect(await browserPage.evaluate(()=>window.printedReceiptText)).not.toMatch(/Invoice:|Ticket:|GUEST CHECK|Browser hold|Payment/);
    await browserContext.close();
    console.log('PASS: browser hold, automatic kitchen/customer jobs, held-card reprint, restore and checkout retain number 1.');
    await context.close();
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (io) await new Promise(resolve => io.close(resolve));
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await pool.end();
    if (created) {
        const admin = await mysql.createConnection(options);
        try { await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
    }
});
