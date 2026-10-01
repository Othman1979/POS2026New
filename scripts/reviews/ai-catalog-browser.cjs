// Built UI and real API acceptance in an owned, disposable loopback database.
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const { chromium, expect } = require('@playwright/test');
let created = false, server, io, browser;
async function run() {
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; } finally { await admin.end(); }
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    await pool.query("INSERT INTO users(id,user_number,name,role,is_active) VALUES(71,'9071','Phone desk','call_center',1)");
    ({ server, io } = require('../../server'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    fs.mkdirSync('scratch', { recursive: true });
    const evidence = [];
    for (const [language, width] of [['en', 1280], ['ar', 390]]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        await context.addInitScript(lang => localStorage.setItem('pos_admin_language', lang), language);
        const login = await context.request.post(base + '/api/auth/login', { data: { user_number: '9001' } });
        if (!login.ok()) throw new Error('Staff login failed');
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='admin_language'", [language]);
        await pool.query('UPDATE products SET customer_info=NULL WHERE id=1');
        const page = await context.newPage(), errors = [];
        page.on('pageerror', err => errors.push(err.message));
        const translations = require('../../src/shared/i18n/ar.json');
        const t = value => language === 'ar' ? translations[value] || value : value;
        await page.goto(base + '/admin/inventory');
        await page.getByRole('button', { name: t('Add Product'), exact: true }).first().click();
        const modal = page.getByRole('dialog').filter({ has: page.locator('#product-customer-info') });
        const textarea = modal.locator('#product-customer-info');
        const name = `Browser dish ${language}`;
        const text = language === 'ar' ? 'يأتي معه متبل وثومية وصوص الشمندر.' : 'Served with mutabbal and garlic sauce.';
        await modal.locator('input[required][type=text]').fill(name);
        await modal.locator('input[required][type=number]').fill('5');
        await textarea.fill(text);
        await modal.locator('button[type=submit]').click();
        await expect(modal).toBeHidden();
        await page.reload();
        const edit = async () => {
            const row = page.locator('tr:visible').filter({ hasText: name });
            if (width > 600) await row.getByRole('button', { name: t('Edit Item'), exact: true }).click();
            else await page.locator('.inventory-mobile-card:visible').filter({ hasText: name }).getByRole('button', { name: t('Edit'), exact: true }).click();
        };
        await edit();
        await expect(textarea).toHaveValue(text);
        await textarea.fill(text + ' Updated');
        await textarea.scrollIntoViewIfNeeded();
        const screenshot = `scratch/ai-catalog-${language}.png`;
        await page.screenshot({ path: screenshot, fullPage: true });
        await modal.locator('button[type=submit]').click();
        await expect(modal).toBeHidden();
        await page.reload();
        await edit();
        await expect(textarea).toHaveValue(text + ' Updated');
        await textarea.fill('');
        await modal.locator('button[type=submit]').click();
        await expect(modal).toBeHidden();
        const [[saved]] = await pool.query('SELECT customer_info,price,is_available FROM products WHERE name=?', [name]);
        if (saved.customer_info !== null || Number(saved.price) !== 5 || Number(saved.is_available) !== 1) throw new Error('Saved data mismatch');
        if (errors.length) throw new Error(errors.join('\n'));
        evidence.push({ language, width, create_reload_edit_clear: true, page_errors: errors, screenshot });
        await context.close();
    }
    fs.writeFileSync('scratch/ai-catalog-browser.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (io) await new Promise(resolve => io.close(resolve));
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await pool.end();
    if (created) { const admin = await mysql.createConnection(options); try { await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); } }
});
