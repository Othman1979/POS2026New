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
    const evidence = [];
    await pool.query("INSERT INTO settings(setting_key,setting_value) VALUES('barcode_enabled','1') ON DUPLICATE KEY UPDATE setting_value='1'");
    for (const [code, price, qty, total] of [
        ['0100000014523', 11, 1.32, 14.52],
        ['100000014523', 11, 1.32, 14.52],
        ['0100000040591', 11, 3.69, 40.59],
        ['100000040591', 11, 3.69, 40.59],
        ['0100000054369', 12, 4.53, 54.36],
        ['100000054369', 12, 4.53, 54.36]
    ]) {
        await pool.query("UPDATE products SET barcode='100000',name='Scale item',price=?,tax_rate=0,jofotara_tax_category='Z' WHERE id=?", [price, SEED.product1.id]);
        require('../../backend/config/cache').invalidateCatalogCache();
        const context = await browser.newContext({viewport:{width:1440,height:1000}});
        const login = await context.request.post(base+'/api/auth/login',{data:{user_number:SEED.adminUser.user_number}});
        if (!login.ok()) throw new Error(await login.text());
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.adminUser.id]);
        if (!shift) {
            const opened = await context.request.post(base+'/api/auth/shifts?action=open', {data:{user_id:SEED.adminUser.id,starting_cash:0}});
            if (!opened.ok()) throw new Error(await opened.text());
        }
        const page = await context.newPage();
        await page.goto(base+'/pos'); await page.waitForLoadState('networkidle');
        const responsePromise = page.waitForResponse(r=>r.url().includes('/api/pos/product_lookup?'));
        await page.locator('.catalog-barcode input').focus();
        await page.keyboard.type(code, {delay:10}); await page.keyboard.press('Enter');
        const lookup = await (await responsePromise).json();
        expect(lookup.product?.barcode, code + ': ' + JSON.stringify(lookup)).toBe('100000');
        expect(lookup.scale_total_cents).toBe(Math.round(total*100));
        await expect(page.locator('.cart-panel')).toContainText('Scale item');
        const cart = await page.locator('.cart-panel').innerText();
        expect(cart).toContain(String(qty));
        expect(cart).toContain(total.toFixed(2));
        await page.locator('.cart-final-action.bg-primary').click();
        const paidResponse = page.waitForResponse(r=>r.url().includes('/api/pos/checkout') && r.request().method()==='POST');
        await page.locator('.checkout-confirm').click();
        const paid = await (await paidResponse).json();
        expect(paid.success,JSON.stringify(paid)).toBe(true);
        const [[stored]] = await pool.query('SELECT o.total, oi.quantity, oi.product_id FROM orders o JOIN order_items oi ON oi.invoice_id=o.invoice_id ORDER BY o.invoice_id DESC LIMIT 1');
        expect(Number(stored.total)).toBe(total);
        expect(Number(stored.quantity)).toBe(qty);
        expect(stored.product_id).toBe(SEED.product1.id);
        evidence.push({code,price,qty,total,lookupProduct:lookup.product.barcode,storedQuantity:Number(stored.quantity),storedTotal:Number(stored.total)});
        await context.close();
    }
    fs.writeFileSync('scratch/scale-browser.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));
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
