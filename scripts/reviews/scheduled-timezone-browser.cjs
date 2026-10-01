// Real checkout UI against a disposable, loopback-only database.
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
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const { chromium, expect } = require('@playwright/test');
    browser = await chromium.launch({ headless: true });
    const evidence = [];
    for (const timezoneId of ['Asia/Amman', 'UTC', 'America/New_York']) {
        const context = await browser.newContext({ timezoneId, viewport: { width: 1440, height: 1000 } });
        await context.addInitScript(() => localStorage.setItem('pos_admin_language', 'en'));
        const login = await context.request.post(base + '/api/auth/login', { data: { user_number: SEED.adminUser.user_number } });
        if (!login.ok()) throw new Error(await login.text());
        const [[existing]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.adminUser.id]);
        if (!existing) await context.request.post(base + '/api/auth/shifts?action=open', { data: { user_id: SEED.adminUser.id, starting_cash: 0 } });
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.adminUser.id]);
        const key = randomUUID();
        const sale = await context.request.post(base + '/api/pos/checkout', { data: {
            cart: [{ id: SEED.product1.id, qty: 1, price: 5 }], shift_id: shift.id,
            subtotal: 5, tax: 0.8, total: 5.8, payment_method: 'cash', amount_tendered: 6,
            change_due: 0.2, idempotency_key: key, delivery_date: '2026-09-09T18:30'
        } });
        if (!sale.ok()) throw new Error(await sale.text());
        const [[order]] = await pool.query('SELECT invoice_id,delivery_date FROM orders WHERE idempotency_key=?', [key]);
        expect(order.delivery_date).toBe('2026-09-09 18:30:00');
        const page = await context.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${base}/pos?edit_invoice=${order.invoice_id}`);
        await page.waitForLoadState('networkidle');
        await page.locator('.cart-final-action.bg-primary').click();
        if (!await page.locator('#checkout-order-date').isVisible()) await page.locator('.checkout-customer.customer-button').click();
        await expect(page.locator('#checkout-order-date')).toHaveValue('2026-09-09T18:30');
        await expect(page.locator('#checkout-order-date')).toBeVisible();
        await page.waitForFunction(() => {
            const panel = document.querySelector('.checkout-customer-panel');
            return panel && getComputedStyle(panel).opacity === '1' && !panel.classList.contains('checkout-panel-enter-active');
        });
        const screenshot = `scratch/timezone-checkout-${process.env.TZ.replaceAll('/', '-')}-${timezoneId.replaceAll('/', '-')}.png`;
        await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
        expect(errors).toEqual([]);
        evidence.push({ serverTimezone: process.env.TZ, browserTimezone: timezoneId, stored: order.delivery_date, checkout: await page.locator('#checkout-order-date').inputValue(), pageErrors: errors, screenshot });
        await context.close();
    }
    fs.writeFileSync(`scratch/timezone-browser-${process.env.TZ.replaceAll('/', '-')}.json`, JSON.stringify(evidence, null, 2));
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
