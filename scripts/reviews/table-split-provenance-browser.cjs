// Real split creation, rewrite and settlement using the built UI and an owned fixture.
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
const output = 'scratch/table-split-provenance-browser';
const out = { database, runs: [], pageErrors: [] };
let created = false, server, io, browser;
const rows = async (sql, params = []) => (await pool.query(sql, params))[0];
async function run() {
    fs.mkdirSync(output, { recursive: true });
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; } finally { await admin.end(); }
    await seedDatabase();
    ({ server, io } = require('../../server'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    for (const [language, width] of [['en', 1440], ['ar', 390]]) for (const fee of [false, true]) {
        await seedDatabase();
        const label = `${language}-${width}-fee-${fee ? 1 : 0}`;
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        await context.addInitScript(language => {
            localStorage.setItem('pos_language', language); localStorage.setItem('pos_admin_language', language);
            window.print = () => {};
        }, language);
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on('pageerror', error => out.pageErrors.push(error.message));
        const ar = require('../../src/shared/i18n/ar.json'), t = key => language === 'ar' ? ar[key] || key : key;
        const post = async (path, data) => {
            const response = await context.request.post(origin + path, { data });
            assert(response.ok(), `${path}: ${await response.text()}`); return response.json();
        };
        const openCart = async () => {
            await page.locator('.cart-panel').waitFor({ state: 'attached' });
            if (width < 1024 && !await page.locator('.cart-panel').evaluate(el => el.classList.contains('translate-x-0')))
                await page.locator('button').filter({ hasText: /View Order|عرض الطلب/ }).last().click();
        };
        const pay = async (card = page) => {
            await card.getByRole('button', { name: t('Pay'), exact: true }).first().click(); await page.waitForURL(origin + '/pos');
            await openCart();
            await page.getByRole('button', { name: t('Pay'), exact: true }).and(page.locator('.cart-final-action')).click();
            const dialog = page.getByRole('dialog', { name: t('Complete Payment') });
            await dialog.getByRole('button', { name: new RegExp(t('Card'), 'i') }).first().click();
            const response = page.waitForResponse(r => r.url().endsWith('/api/pos/checkout') && r.request().method() === 'POST');
            await dialog.getByRole('button', { name: new RegExp(t('CONFIRM PAYMENT'), 'i') }).click();
            const paid = await response; assert(paid.ok(), await paid.text()); await expect(dialog).toBeHidden();
        };
        const modal = page.locator('.split-check-dialog'), source = modal.locator('.split-source-pane');
        const moveOne = async () => {
            if (width < 768) await modal.locator('.split-mobile-switch button').first().click();
            await source.locator('.item-quantity input').first().fill('1');
            await source.locator('.split-line-main').first().click();
        };
        try {
            await pool.query('UPDATE users SET xyz=1 WHERE id=1');
            await post('/api/auth/login', { user_number: '9001' });
            await post('/api/auth/shifts?action=open', { user_id: 1, starting_cash: 50 });
            await post('/api/system/settings', { admin_language: language, stock_enabled: '1', recipe_ledger_enabled: '1', print_method: 'browser',
                service_charge_enabled: fee ? '1' : '0', auto_apply_service_charge: '1', service_charge_percentage: '10', service_charge_tax_rate: '0' });
            await pool.query('UPDATE products SET stock=100 WHERE id=2');
            const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost,is_active) VALUES('Split provenance browser','count','unit',1,1)");
            await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) VALUES(2,?,1,0)', [ingredient.insertId]);
            const saved = await post('/api/pos/table_order', { table_id: 1, cart: [{ id: 2, name: 'Test Drink', qty: 3, price: 2 }], subtotal: 6, tax: 0, total: 6 });
            await page.goto(origin + '/tables');
            await page.locator('[data-table-number="1"][data-testid="table-card"]').click(); await page.waitForURL(origin + '/pos');
            await openCart(); await page.getByRole('button', { name: t('Split'), exact: true }).click(); await expect(modal).toBeVisible();
            await moveOne();
            await modal.getByRole('button', { name: t('Finalize Splits'), exact: true }).click(); await page.waitForURL(/\/table-splits/);
            assert.equal((await rows('SELECT * FROM held_orders')).length, 2);
            assert.equal((await rows("SELECT * FROM audit_events WHERE event_type='split_check_created'")).length, 0);
            // Pay the named check, retaining the two-item remainder for a later rewrite.
            const check = page.locator('div.p-3.cursor-pointer').filter({ has: page.getByRole('heading', { name: `${t('Bill Check')} 2`, exact: true }) });
            const firstPayload = JSON.parse((await rows("SELECT cart_data FROM held_orders WHERE JSON_UNQUOTE(JSON_EXTRACT(cart_data,'$.split_role'))='check'"))[0].cart_data);
            assert.equal(firstPayload.items.filter(item => item.note !== 'Auto-Gratuity')[0].qty, 1);
            await pay(check);
            const paidBefore = await rows("SELECT * FROM orders WHERE parent_invoice_id=? AND payment_method='card'", [saved.invoice_id]);
            assert.equal(paidBefore.length, 1); assert.equal(Number(paidBefore[0].total), fee ? 2.2 : 2);
            await page.goto(origin + '/table-splits'); await page.getByRole('button', { name: t('Edit'), exact: true }).click();
            await page.waitForURL(origin + '/pos'); await expect(modal).toBeVisible();
            await modal.getByRole('button', { name: t('Add Check'), exact: true }).click(); await moveOne();
            await modal.getByRole('button', { name: t('Save Changes'), exact: true }).click(); await page.waitForURL(/\/table-splits/);
            await expect(modal).toBeHidden();
            assert.deepEqual(await rows("SELECT * FROM orders WHERE parent_invoice_id=? AND payment_method='card'", [saved.invoice_id]), paidBefore);
            assert.equal((await rows('SELECT * FROM held_orders')).length, 2);
            await page.screenshot({ path: `${output}/${label}-rewritten.png`, fullPage: true });
            await pay(); await page.goto(origin + '/table-splits'); await page.reload(); await pay();
            const children = await rows("SELECT total FROM orders WHERE parent_invoice_id=? AND payment_method='card'", [saved.invoice_id]);
            assert.equal(children.length, 3);
            assert.equal(Math.round(children.reduce((sum, row) => sum + Number(row.total), 0) * 100), fee ? 660 : 600);
            assert.equal((await rows('SELECT * FROM held_orders')).length, 0);
            assert.equal((await rows('SELECT status FROM restaurant_tables WHERE id=1'))[0].status, 'available');
            assert.equal(Number((await rows('SELECT stock FROM products WHERE id=2'))[0].stock), 97);
            assert.equal(Number((await rows("SELECT SUM(qty) qty FROM stock_movements WHERE movement_type='ingredient'"))[0].qty), -3);
            for (const table of ['deleted', 'refunds', 'refund_items', 'audit_events']) assert.equal((await rows(`SELECT * FROM ${table}`)).length, 0);
            out.runs.push({ language, width, fee, xyz: 1, paidChecks: 3, paidTotal: fee ? 6.6 : 6, stock: 97, recipeConsumption: 3 });
            console.log(`${label}: xyz split, pay, add check, pay both, no history; stock correct`);
        } catch (error) {
            await page.screenshot({ path: `${output}/${label}-failure.png`, fullPage: true }).catch(() => {});
            fs.writeFileSync(`${output}/${label}-failure.txt`, await page.locator('body').innerText().catch(() => '')); throw error;
        } finally { await context.close(); }
    }
    assert.deepEqual(out.pageErrors, []); out.complete = true;
}
run().catch(error => { out.error = error.stack; console.error(error); process.exitCode = 1; }).finally(async () => {
    await browser?.close(); if (io) await new Promise(resolve => io.close(resolve)); if (server?.listening) await new Promise(resolve => server.close(resolve));
    await pool.end();
    if (created) { const admin = await mysql.createConnection(options); try { await admin.query(`DROP DATABASE \`${database}\``); out.removed = true; } finally { await admin.end(); } }
    fs.writeFileSync(`${output}/results.json`, JSON.stringify(out, null, 2));
});
