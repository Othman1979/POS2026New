// Real built POS -> API -> generated loopback DB. No customer DB or physical printer.
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const { seedDatabase } = require('../../backend/tests/fixtures/seed');
const suppressHistory = process.env.TABLE_VOID_XYZ === '1';
const out = { database, suppressHistory, runs: [], errors: [] };
const output = `scratch/deleted-table-items-browser${suppressHistory ? '-xyz' : ''}`;
let created = false, server, io, browser;

async function run() {
    fs.mkdirSync(output, { recursive: true });
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; }
    finally { await admin.end(); }
    await seedDatabase();
    ({ server, io } = require('../../server'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    for (const [language, width] of [['en', 1440], ['ar', 390], ['en', 390], ['ar', 1440]]) {
        await seedDatabase();
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const ar = require('../../src/shared/i18n/ar.json');
        const t = key => language === 'ar' ? ar[key] || key : key;
        const post = async (path, data) => {
            const response = await context.request.post(origin + path, { data });
            assert(response.ok(), `${path}: ${await response.text()}`);
            return response.json();
        };
        const page = await context.newPage();
        page.on('pageerror', error => out.errors.push(error.message));
        page.setDefaultTimeout(10000);
        const showCart = async () => {
            if (width < 1024 && !await page.locator('.cart-panel').evaluate(el => el.classList.contains('translate-x-0'))) {
                await page.locator('button').filter({ hasText: /View Order|عرض الطلب/ }).last().click();
            }
        };
        try {
            await post('/api/auth/login', { user_number: '9001' });
            await post('/api/auth/shifts?action=open', { user_id: 1, starting_cash: 50 });
            const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=1 AND status='open'");
            await post('/api/system/settings', { admin_language: language, stock_enabled: '1' });
            await pool.query('UPDATE users SET xyz=? WHERE id=1', [suppressHistory ? 1 : 0]);
            await pool.query('UPDATE products SET stock=100 WHERE id IN (1,2)');
            await page.goto(origin + '/tables');
            await page.locator('[data-table-number="1"][data-testid="table-card"]').click();
            await page.waitForURL(origin + '/pos');
            await page.locator('.product-card').filter({ hasText: 'Test Burger' }).first().click();
            await page.locator('.product-card').filter({ hasText: 'Test Drink' }).first().click();
            await showCart();
            const saved = page.waitForResponse(response => response.url().includes('/api/pos/table_order') && response.request().method() === 'POST');
            await page.getByRole('button', { name: t('Save Table'), exact: true }).click();
            assert((await saved).ok());
            const [[order]] = await pool.query("SELECT * FROM orders WHERE table_id=1 AND payment_method='unpaid_table'");
            assert.equal(order.order_id, null);
            assert.equal(order.invoice_number, null);
            // Exercise the real printed-state API before cancellation in Arabic.
            if (language === 'ar') await post('/api/pos/table_order', { action: 'mark_printed', table_id: 1, expected_invoice_id: order.invoice_id });
            await page.goto(origin + '/tables');
            await page.locator('[data-table-number="1"][data-testid="table-card"]').click();
            await page.waitForURL(origin + '/pos');
            await showCart();
            await page.locator('.cart-panel tbody tr').filter({ hasText: 'Test Drink' }).click();
            const removed = page.waitForResponse(response => response.url().endsWith('/api/pos/refunds'));
            await page.getByRole('button', { name: t('Remove'), exact: true }).click();
            assert((await removed).ok());
            await expect(page.locator('.cart-panel .cart-item-name').filter({ hasText: 'Test Drink' })).toHaveCount(0);
            await expect(page.getByRole('button', { name: t('Clear'), exact: true })).toBeEnabled();
            await showCart();
            assert.equal((await pool.query('SELECT * FROM deleted'))[0].length, suppressHistory ? 0 : 1);
            assert.equal((await pool.query('SELECT * FROM orders'))[0].length, 1);
            await page.getByRole('button', { name: t('Clear'), exact: true }).click();
            await page.getByRole('button', { name: t('Cancel'), exact: true }).click();
            assert.equal((await pool.query('SELECT * FROM deleted'))[0].length, suppressHistory ? 0 : 1);
            const loseReply = language === 'en' && width === 390;
            let committedReplyLost = false;
            if (loseReply) {
                await page.route('**/api/pos/refunds', async route => {
                    const response = await route.fetch();
                    assert(response.ok());
                    committedReplyLost = true;
                    await route.abort('failed');
                }, { times: 1 });
            }
            await page.getByRole('button', { name: t('Clear'), exact: true }).click();
            await page.getByRole('button', { name: t('Confirm'), exact: true }).click();
            await expect.poll(async () => (await pool.query('SELECT * FROM orders WHERE invoice_id=?', [order.invoice_id]))[0].length).toBe(0);
            if (loseReply) await expect.poll(() => committedReplyLost).toBe(true);
            assert.equal((await pool.query('SELECT * FROM order_items'))[0].length, 0);
            const [archive] = await pool.query('SELECT * FROM deleted ORDER BY id');
            assert.equal(archive.length, suppressHistory ? 0 : 2);
            assert.deepEqual(archive.map(row => Number(row.quantity)), suppressHistory ? [] : [1, 1]);
            assert.equal((await pool.query('SELECT * FROM refunds'))[0].length, suppressHistory ? 0 : 2);
            assert.equal((await pool.query('SELECT * FROM refund_items'))[0].length, suppressHistory ? 0 : 2);
            assert.equal((await pool.query("SELECT * FROM audit_events WHERE event_type='void_order'"))[0].length, suppressHistory ? 0 : 2);
            assert((await pool.query('SELECT * FROM refunds'))[0].every(row => row.kind === 'void' && row.invoice_id === null && Number(row.amount_refunded) === 0));
            assert((await pool.query('SELECT stock FROM products WHERE id IN (1,2)'))[0].every(row => Number(row.stock) === 100));
            const stale = await context.request.post(origin + '/api/pos/refunds', { data: { invoice_id: order.invoice_id, intent: 'void' } });
            assert.equal(stale.status(), 404);
            // A paid refund keeps its invoice and returns real cash normally.
            const sale = await post('/api/pos/checkout', { cart: [{ id: 2, qty: 1, price: 2 }], shift_id: shift.id,
                subtotal: 2, tax: 0, total: 2, payment_method: 'cash', amount_tendered: 2, change_due: 0 });
            await post('/api/pos/refunds', { invoice_id: sale.invoice_id, intent: 'refund', refund_method: 'cash', reason: 'Fixture return' });
            assert.equal((await pool.query('SELECT * FROM orders WHERE invoice_id=?', [sale.invoice_id]))[0].length, 1);
            const day = require('../../backend/utils/businessDate').getBusinessDate();
            const report = await context.request.get(`${origin}/api/admin/reports/refunds?start_date=${day}&end_date=${day}`);
            assert(report.ok());
            const summary = (await report.json()).summary;
            assert.equal(summary.void_count, suppressHistory ? 0 : 2);
            assert.equal(summary.void_value, suppressHistory ? 0 : 7.8);
            assert.equal(summary.refund_count, 1);
            assert.equal(summary.refund_cash, 2);
            await page.goto(origin + '/admin/reports-refunds');
            await expect(page.locator('.refund-event-row')).toHaveCount(suppressHistory ? 1 : 3);
            const voidRows = page.locator('.refund-event-row').filter({ has: page.locator('.refund-kind--void') });
            if (suppressHistory) await expect(voidRows).toHaveCount(0);
            else {
                await voidRows.first().click();
                await expect(page.locator('.refund-details .refund-items')).toBeVisible();
                await expect(page.getByRole('link', { name: t('Open original order'), exact: true })).toHaveCount(0);
            }
            await expect(page.getByText(t('Voided item value: no money returned'), { exact: true })).toBeVisible();
            await page.waitForLoadState('networkidle');
            await page.screenshot({ path: `${output}/${language}-${width}.png`, fullPage: true, animations: 'disabled' });
            await page.locator('.refund-event-row').filter({ has: page.locator('.refund-kind--refund') }).first().click();
            await expect(page.getByRole('link', { name: t('Open original order'), exact: true })).toBeVisible();
            const closed = await context.request.put(origin + '/api/auth/shifts?action=close', { data: { shift_id: shift.id, actual_cash: 50 } });
            assert(closed.ok(), await closed.text());
            assert.equal(Number((await closed.json()).expected_cash), 50);
            out.runs.push({ language, width, printed: language === 'ar', committedReplyLost, archiveRows: archive.length,
                voidEvents: suppressHistory ? 0 : 2, realRefunds: 1, expectedCash: 50, stockRestored: true });
            console.log(`${language} ${width}: Save, Remove, Clear/Cancel, archive, reports and cash passed`);
        } catch (error) {
            await page.screenshot({ path: `${output}/failure-${language}-${width}.png`, fullPage: true }).catch(() => {});
            fs.writeFileSync(`${output}/failure-${language}-${width}.txt`, await page.locator('body').innerText().catch(() => ''));
            throw error;
        } finally { await context.close(); }
    }
    assert.deepEqual(out.errors, []);
    out.complete = true;
}
run().catch(error => { out.error = error.stack; console.error(error); process.exitCode = 1; }).finally(async () => {
    await browser?.close();
    if (io) await new Promise(resolve => io.close(resolve));
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await pool.end();
    if (created) {
        const admin = await mysql.createConnection(options);
        try { await admin.query(`DROP DATABASE \`${database}\``); out.removed = true; }
        finally { await admin.end(); }
    }
    fs.writeFileSync(`${output}/results.json`, JSON.stringify(out, null, 2));
});
