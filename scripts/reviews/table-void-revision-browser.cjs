// Stale confirmation and lost committed replies, using the built POS and one owned fixture.
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
const output = 'scratch/table-void-revision-browser';
const out = { database, runs: [], pageErrors: [] };
let created = false, server, io, browser;
const rows = async (sql, params = []) => (await pool.query(sql, params))[0];
const snapshot = async () => {
    const state = {};
    for (const table of ['orders', 'order_items', 'restaurant_tables', 'held_orders', 'products', 'stock_movements',
        'recipe_ledger_lines', 'service_charge_snapshots', 'refunds', 'refund_items', 'deleted', 'audit_events', 'print_queue'])
        state[table] = await rows(`SELECT * FROM ${table} ORDER BY 1`);
    return state;
};
async function run() {
    fs.mkdirSync(output, { recursive: true });
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; } finally { await admin.end(); }
    await seedDatabase(); ({ server, io } = require('../../server'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    for (const [language, width, xyz] of [['en', 1440, 0], ['ar', 390, 1]]) for (const fee of [false, true]) {
        await seedDatabase();
        const label = `${language}-${width}-fee-${fee ? 1 : 0}`, context = await browser.newContext({ viewport: { width, height: 900 } });
        await context.addInitScript(language => { localStorage.setItem('pos_language', language); localStorage.setItem('pos_admin_language', language); window.print = () => {}; }, language);
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on('pageerror', error => out.pageErrors.push(error.message));
        const ar = require('../../src/shared/i18n/ar.json'), t = key => language === 'ar' ? ar[key] || key : key;
        const post = async (path, data) => {
            const res = await context.request.post(origin + '/api/' + path, { data });
            assert(res.ok(), `${path}: ${await res.text()}`); return res.json();
        };
        const load = async id => {
            const res = await context.request.get(`${origin}/api/pos/table_order?order_id=${id}`); assert(res.ok(), await res.text()); return res.json();
        };
        const open = async () => {
            await page.goto(origin + '/tables'); await page.locator('[data-table-number="1"][data-testid="table-card"]').click(); await page.waitForURL(origin + '/pos');
            await page.locator('.cart-panel').waitFor({ state: 'attached' });
            if (width < 1024 && !await page.locator('.cart-panel').evaluate(el => el.classList.contains('translate-x-0')))
                await page.locator('button').filter({ hasText: /View Order|عرض الطلب/ }).last().click();
        };
        const item = name => page.locator('.cart-panel .cart-item-name').filter({ hasText: name });
        const voidReply = () => page.waitForResponse(r => r.url().endsWith('/api/pos/refunds') && r.request().method() === 'POST');
        const clear = async () => {
            await page.getByRole('button', { name: t('Clear'), exact: true }).click();
            await page.getByRole('button', { name: t('Confirm'), exact: true }).click();
        };
        try {
            await pool.query('UPDATE users SET xyz=? WHERE id=1', [xyz]);
            await post('auth/login', { user_number: '9001' });
            await post('auth/shifts?action=open', { user_id: 1, starting_cash: 50 });
            await post('system/settings', { admin_language: language, stock_enabled: '1', recipe_ledger_enabled: '1', print_method: 'browser',
                service_charge_enabled: fee ? '1' : '0', auto_apply_service_charge: '1', service_charge_percentage: '10', service_charge_tax_rate: '0' });
            await pool.query('UPDATE products SET stock=100 WHERE id IN (1,2)');
            const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost,is_active) VALUES('Void revision browser','count','unit',1,1)");
            await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) VALUES(2,?,1,0)', [ingredient.insertId]);
            const saved = await post('pos/table_order', { table_id: 1, cart: [{ id: 2, name: 'Test Drink', qty: 2, price: 2 }], subtotal: 4, tax: 0, total: 4 });
            if (language === 'ar') await post('pos/table_order', { action: 'mark_printed', table_id: 1, expected_invoice_id: saved.invoice_id });
            const original = await load(saved.invoice_id);
            await open(); await expect(item('Test Drink')).toBeVisible();
            await page.getByRole('button', { name: t('Clear'), exact: true }).click();
            await expect(page.getByRole('button', { name: t('Confirm'), exact: true })).toBeVisible();
            await post('pos/table_order', { table_id: 1, current_order_id: saved.invoice_id, expected_version: original.version,
                service_charge_snapshot: original.service_charge_snapshot,
                cart: [...original.cart, { id: 1, name: 'Test Burger', qty: 1, price: 5, tax_rate: 16 }], subtotal: 9, tax: 0.8, total: 9.8 });
            const afterAdd = await snapshot(), staleReply = voidReply();
            await page.getByRole('button', { name: t('Confirm'), exact: true }).click();
            const stale = await staleReply, staleBody = await stale.json();
            assert.equal(stale.status(), 409); assert.equal(staleBody.code, 'TABLE_ORDER_VERSION_CONFLICT');
            assert.equal(stale.request().postDataJSON().expected_version, original.version);
            assert.deepEqual(await snapshot(), afterAdd);
            await expect(page.getByText(t(staleBody.message), { exact: true }).last()).toBeVisible();
            await expect(page.getByText(t(staleBody.message), { exact: true }).last().locator('..')).toHaveCSS('opacity', '1');
            await expect(item('Test Drink')).toBeVisible(); await expect(item('Test Burger')).toHaveCount(0);
            await page.screenshot({ path: `${output}/${label}-stale.png`, fullPage: true, animations: 'disabled' });
            await open(); await expect(item('Test Burger')).toBeVisible();
            // Let Remove commit, then lose only its response. The old draft must stay recoverable.
            let removedBody;
            await page.route('**/api/pos/refunds', async route => {
                const res = await route.fetch(); assert(res.ok(), await res.text()); removedBody = route.request().postDataJSON();
                await route.abort('connectionreset');
            }, { times: 1 });
            await item('Test Burger').click();
            await page.getByRole('button', { name: t('Remove'), exact: true }).and(page.locator('.cart-item-action')).click();
            const uncertain = t('Could not confirm whether the void was saved. Reopen the table to review it before trying again.');
            await expect(page.getByText(uncertain, { exact: true }).last()).toBeVisible();
            await expect(item('Test Burger')).toBeVisible();
            const afterLost = await snapshot();
            assert.equal((await load(saved.invoice_id)).cart.filter(row => row.id === 1).length, 0);
            const retryReply = voidReply();
            await page.getByRole('button', { name: t('Remove'), exact: true }).and(page.locator('.cart-item-action')).click();
            const retry = await retryReply; assert.equal(retry.status(), 409);
            assert.deepEqual(retry.request().postDataJSON(), removedBody); assert.deepEqual(await snapshot(), afterLost);
            await expect(page.getByText(t(staleBody.message), { exact: true }).last().locator('..')).toHaveCSS('opacity', '1');
            await page.screenshot({ path: `${output}/${label}-retry.png`, fullPage: true, animations: 'disabled' });
            await open(); await expect(item('Test Burger')).toHaveCount(0); await expect(item('Test Drink')).toBeVisible();
            const finalReply = voidReply(); await clear(); const final = await finalReply;
            assert(final.ok(), await final.text());
            assert.equal((await rows('SELECT * FROM orders WHERE invoice_id=?', [saved.invoice_id])).length, 0);
            assert.equal((await rows('SELECT status FROM restaurant_tables WHERE id=1'))[0].status, 'available');
            assert((await rows('SELECT stock FROM products WHERE id IN (1,2)')).every(row => Number(row.stock) === 100));
            assert.equal(Number((await rows("SELECT SUM(qty) qty FROM stock_movements WHERE movement_type='ingredient'"))[0].qty), 0);
            assert.equal((await rows("SELECT * FROM refunds WHERE kind='refund'")).length, 0);
            if (xyz) for (const table of ['deleted', 'refunds', 'refund_items', 'audit_events']) assert.equal((await rows(`SELECT * FROM ${table}`)).length, 0);
            else {
                assert.equal((await rows("SELECT * FROM refunds WHERE kind='void'")).length, 2);
                assert((await rows('SELECT amount_refunded,refund_method FROM refunds')).every(row => Number(row.amount_refunded) === 0 && row.refund_method === null));
            }
            out.runs.push({ language, width, fee, xyz, staleClear: 409, committedRemoveReplyLost: true, duplicateRemove: 409, reopenedClear: 200, stock: 100 });
            console.log(`${label}: stale Clear blocked, lost Remove committed once, reopen/Clear succeeds`);
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
