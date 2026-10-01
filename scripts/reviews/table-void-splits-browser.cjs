// Real built POS and API against one owned loopback fixture; no customer DB/printer.
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
const output = 'scratch/table-void-splits-browser';
const out = { database, runs: [], pageErrors: [] };
let created = false, server, io, browser;
const rows = async (sql, params = []) => (await pool.query(sql, params))[0];
const snapshot = async () => {
    const state = {};
    for (const table of ['orders', 'order_items', 'restaurant_tables', 'held_orders', 'products',
        'stock_movements', 'recipe_ledger_lines', 'service_charge_snapshots', 'refunds', 'refund_items', 'deleted', 'audit_events', 'print_queue']) {
        state[table] = await rows(`SELECT * FROM ${table} ORDER BY 1`);
    }
    return state;
};
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
        await context.addInitScript(language => { localStorage.setItem('pos_language', language); localStorage.setItem('pos_admin_language', language); }, language);
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        page.on('pageerror', error => out.pageErrors.push(error.message));
        const ar = require('../../src/shared/i18n/ar.json'), t = key => language === 'ar' ? ar[key] || key : key;
        const post = async (path, data) => {
            const response = await context.request.post(origin + path, { data });
            assert(response.ok(), `${path}: ${await response.text()}`); return response.json();
        };
        try {
            await post('/api/auth/login', { user_number: '9001' });
            await post('/api/auth/shifts?action=open', { user_id: 1, starting_cash: 50 });
            const shiftId = (await rows("SELECT id FROM shifts WHERE user_id=1 AND status='open'"))[0].id;
            await post('/api/system/settings', { admin_language: language, stock_enabled: '1', recipe_ledger_enabled: '1',
                service_charge_enabled: fee ? '1' : '0', auto_apply_service_charge: '1', service_charge_percentage: '10', service_charge_tax_rate: '0' });
            await pool.query('UPDATE products SET stock=100 WHERE id=2');
            const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost,is_active) VALUES('Browser recipe','count','unit',1,1)");
            await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) VALUES(2,?,1,0)', [ingredient.insertId]);
            const saved = await post('/api/pos/table_order', { table_id: 1, shift_id: shiftId,
                cart: [{ id: 2, name: 'Test Drink', qty: 2, price: 2 }], subtotal: 4, tax: 0, total: 4 });
            if (language === 'ar') await post('/api/pos/table_order', { action: 'mark_printed', table_id: 1, expected_invoice_id: saved.invoice_id });
            await page.goto(origin + '/tables');
            await page.locator('[data-table-number="1"][data-testid="table-card"]').click(); await page.waitForURL(origin + '/pos');
            if (width < 1024) await page.locator('button').filter({ hasText: /View Order|عرض الطلب/ }).last().click();
            await expect(page.locator('.cart-panel .cart-item-name').filter({ hasText: 'Test Drink' })).toBeVisible();
            await page.getByRole('button', { name: t('Clear'), exact: true }).click();
            await expect(page.getByRole('button', { name: t('Confirm'), exact: true })).toBeVisible();
            // Another terminal creates and partially settles the split while the old dialog stays open.
            const total = fee ? 4.4 : 4;
            await post('/api/pos/table_splits/split', { tableId: 1, currentOrderId: saved.invoice_id,
                splits: [1, 2].map(index => ({ referenceName: `Table 1 - Check ${index}`, subtotal: total / 2,
                    items: [{ id: 2, name: 'Test Drink', qty: 1, price: 2, tax_rate: 0 }] })) });
            const held = await rows('SELECT * FROM held_orders ORDER BY id'), payload = JSON.parse(held[0].cart_data), money = payload.split_money_cents;
            await post('/api/pos/checkout', { cart: payload.items, shift_id: shiftId, table_id: 1, split_check_id: held[0].id,
                subtotal: money.subtotal / 100, tax: money.tax / 100, total: money.total / 100,
                payment_method: 'cash', amount_tendered: money.total / 100, change_due: 0 });
            const xyz = language === 'ar' ? 1 : 0;
            await pool.query('UPDATE users SET xyz=? WHERE id=1', [xyz]);
            const before = await snapshot();
            const blocked = page.waitForResponse(response => response.url().endsWith('/api/pos/refunds') && response.request().method() === 'POST');
            await page.getByRole('button', { name: t('Confirm'), exact: true }).click();
            const response = await blocked, body = await response.json();
            assert.equal(response.status(), 409); assert.equal(body.code, 'SPLIT_CHECKS_OPEN');
            assert.deepEqual(await snapshot(), before);
            await expect(page.getByText(body.message, { exact: true }).last()).toBeVisible();
            await expect(page.locator('.cart-panel .cart-item-name').filter({ hasText: 'Test Drink' })).toBeVisible();
            await page.screenshot({ path: `${output}/${label}-blocked.png`, fullPage: true });
            // Recover through the real board and pay the remaining check normally.
            await page.goto(origin + '/table-splits');
            await page.getByRole('button', { name: t('Pay'), exact: true }).first().click(); await page.waitForURL(origin + '/pos');
            if (width < 1024) await page.locator('button').filter({ hasText: /View Order|عرض الطلب/ }).last().click();
            await page.getByRole('button', { name: t('Pay'), exact: true }).and(page.locator('.cart-final-action')).click();
            const modal = page.getByRole('dialog', { name: t('Complete Payment') });
            await modal.getByRole('button', { name: new RegExp(t('Cash'), 'i') }).first().click();
            await modal.getByRole('textbox', { name: t('Amount Tendered') }).fill(String(total / 2));
            const paid = page.waitForResponse(response => response.url().endsWith('/api/pos/checkout') && response.request().method() === 'POST');
            await modal.getByRole('button', { name: new RegExp(t('CONFIRM PAYMENT'), 'i') }).click();
            const paidResponse = await paid; assert(paidResponse.ok(), JSON.stringify(await paidResponse.json()));
            await expect(modal).toBeHidden();
            assert.equal((await rows('SELECT * FROM held_orders')).length, 0);
            assert.equal((await rows('SELECT status FROM restaurant_tables WHERE id=1'))[0].status, 'available');
            assert.equal(Number((await rows('SELECT stock FROM products WHERE id=2'))[0].stock), 98);
            assert.equal(Number((await rows("SELECT SUM(qty) qty FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=?", [ingredient.insertId]))[0].qty), -2);
            const children = await rows("SELECT total FROM orders WHERE parent_invoice_id=? AND payment_method='cash'", [saved.invoice_id]);
            assert.equal(children.length, 2); assert.equal(children.reduce((sum, row) => sum + Number(row.total), 0), total);
            for (const table of ['deleted', 'refunds', 'refund_items']) assert.equal((await rows(`SELECT * FROM ${table}`)).length, 0);
            out.runs.push({ language, width, fee, xyz, blockedCode: body.code, paidChecks: children.length, paidTotal: total, stock: 98, recipeConsumption: 2 });
            console.log(`${label}: stale Clear blocked without writes; remaining check paid`);
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
