// Built POS -> Remove -> pay -> History filters -> partial/full cash refunds.
const fs = require('node:fs'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { chromium, expect } = require('@playwright/test');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db'), { seedDatabase } = require('../../backend/tests/fixtures/seed');
const output = 'scratch/table-paid-refund-status-browser', out = { database, runs: [], pageErrors: [] };
let created = false, server, io, browser;
const rows = async (sql, params = []) => (await pool.query(sql, params))[0];
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
        const post = async (path, data) => { const res = await context.request.post(origin + '/api/' + path, { data }); assert(res.ok(), `${path}: ${await res.text()}`); return res.json(); };
        const response = path => page.waitForResponse(r => r.url().endsWith('/api/' + path) && r.request().method() === 'POST');
        const historyRows = page.locator(width < 768 ? '.orders-workspace article.admin-grid-mobile-card' : '.orders-workspace tbody tr[tabindex="0"]');
        const filter = async (status, count) => {
            await page.getByRole('button', { name: new RegExp(t('Filters')) }).click();
            const reply = page.waitForResponse(r => r.url().includes('/api/admin/orders?') && new URL(r.url()).searchParams.get('refund_status') === status);
            await page.getByRole('button', { name: t({ none: 'Not refunded', partial: 'Partial refund', full: 'Full refund' }[status]), exact: true }).click();
            assert((await reply).ok()); await page.keyboard.press('Escape'); await expect(historyRows).toHaveCount(count);
        };
        const refund = async partial => {
            if (width < 768) await historyRows.click();
            else await historyRows.getByRole('button', { name: t('More'), exact: true }).click();
            await page.getByRole('button', { name: t('Refund'), exact: true }).click();
            const dialog = page.getByRole('dialog', { name: t('Refund'), exact: true });
            await expect(dialog).toBeVisible();
            await dialog.locator('select').selectOption('cash');
            await expect(dialog.getByRole('button', { name: t('Deselect All'), exact: true })).toBeVisible();
            if (partial) {
                await dialog.getByRole('button', { name: t('Deselect All'), exact: true }).click();
                const drink = dialog.locator('div.flex.items-center.justify-between').filter({ has: page.getByText('Test Drink', { exact: true }) });
                await drink.locator('button').filter({ has: page.locator('i.fa-plus') }).click();
            }
            const reply = response('pos/refunds');
            await dialog.getByRole('button', { name: t('Confirm Refund'), exact: true }).click();
            const res = await reply; assert(res.ok(), await res.text()); const body = await res.json();
            await page.getByRole('button', { name: t('OK'), exact: true }).click();
            await expect(dialog).toBeHidden();
            if (width < 768) await page.keyboard.press('Escape');
            return body;
        };
        try {
            await pool.query('UPDATE users SET xyz=? WHERE id=1', [xyz]);
            await post('auth/login', { user_number: '9001' }); await post('auth/shifts?action=open', { user_id: 1, starting_cash: 50 });
            const shiftId = (await rows("SELECT id FROM shifts WHERE status='open'"))[0].id;
            await post('system/settings', { admin_language: language, stock_enabled: '1', recipe_ledger_enabled: '1', print_method: 'browser',
                service_charge_enabled: fee ? '1' : '0', auto_apply_service_charge: '1', service_charge_percentage: '10', service_charge_tax_rate: '0' });
            await pool.query('UPDATE products SET stock=100 WHERE id IN (1,2)');
            const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost,is_active) VALUES('Paid refund browser','count','unit',1,1)");
            await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,sort_order) VALUES(2,?,1,0)', [ingredient.insertId]);
            const saved = await post('pos/table_order', { table_id: 1, shift_id: shiftId,
                cart: [{ id: 2, name: 'Test Drink', qty: 2, price: 2 }, { id: 1, name: 'Test Burger', qty: 1, price: 5, tax_rate: 16 }], subtotal: 9, tax: 0.8, total: 9.8 });
            await page.goto(origin + '/tables'); await page.locator('[data-table-number="1"][data-testid="table-card"]').click(); await page.waitForURL(origin + '/pos');
            if (width < 1024) await page.locator('button').filter({ hasText: /View Order|عرض الطلب/ }).last().click();
            await page.locator('.cart-item-name').filter({ hasText: 'Test Burger' }).click();
            const cancelled = response('pos/refunds');
            await page.getByRole('button', { name: t('Remove'), exact: true }).and(page.locator('.cart-item-action')).click();
            assert((await cancelled).ok()); await expect(page.locator('.cart-item-name').filter({ hasText: 'Test Burger' })).toHaveCount(0);
            const payButton = page.getByRole('button', { name: t('Pay'), exact: true }).and(page.locator('.cart-final-action'));
            await expect(payButton).toBeEnabled();
            if (width < 1024 && !await page.locator('.cart-panel').evaluate(el => el.classList.contains('translate-x-0')))
                await page.locator('button').filter({ hasText: /View Order|عرض الطلب/ }).last().click();
            await payButton.click();
            const payment = page.getByRole('dialog', { name: t('Complete Payment') });
            await payment.getByRole('button', { name: new RegExp(t('Cash'), 'i') }).first().click();
            await payment.getByRole('textbox', { name: t('Amount Tendered') }).fill(fee ? '4.4' : '4');
            const paid = response('pos/checkout'); await payment.getByRole('button', { name: new RegExp(t('CONFIRM PAYMENT'), 'i') }).click();
            const paidReply = await paid; assert(paidReply.ok(), await paidReply.text()); await expect(payment).toBeHidden();
            assert.equal((await rows('SELECT refund_status FROM orders WHERE invoice_id=?', [saved.invoice_id]))[0].refund_status, 'none');
            await page.goto(origin + '/admin/orders'); await page.getByRole('button', { name: t('Tables'), exact: true }).click();
            await expect(historyRows).toHaveCount(1);
            await expect(historyRows.getByText(t('Partial refund'), { exact: true })).toHaveCount(0);
            await filter('none', 1); await filter('partial', 0); await filter('none', 1);
            await page.screenshot({ path: `${output}/${label}-not-refunded.png`, fullPage: true, animations: 'disabled' });
            const first = await refund(true);
            assert.equal(Number(first.amount_refunded), 2); assert.equal(first.refund_status, 'partial');
            await expect(historyRows).toHaveCount(0); await filter('partial', 1);
            await expect(historyRows.getByText(t('Partial refund'), { exact: true })).toBeVisible();
            const last = await refund(false);
            assert.equal(Number(last.amount_refunded), fee ? 2.4 : 2); assert.equal(last.refund_status, 'full');
            await expect(historyRows).toHaveCount(0); await filter('full', 1);
            const badge = historyRows.getByText(t('Full refund'), { exact: true }); await badge.scrollIntoViewIfNeeded(); await expect(badge).toBeVisible();
            await page.screenshot({ path: `${output}/${label}-full-refund.png`, fullPage: true, animations: 'disabled' });
            assert((await rows('SELECT stock FROM products WHERE id IN (1,2)')).every(row => Number(row.stock) === 100));
            assert.equal(Number((await rows("SELECT SUM(qty) qty FROM stock_movements WHERE movement_type='ingredient'"))[0].qty), 0);
            const events = await rows('SELECT kind,amount_refunded FROM refunds');
            assert.equal(events.filter(row => row.kind === 'void').length, xyz ? 0 : 1);
            assert.equal(events.filter(row => row.kind === 'refund').length, 2);
            assert.equal(Math.round(events.filter(row => row.kind === 'refund').reduce((sum, row) => sum + Number(row.amount_refunded), 0) * 100), fee ? 440 : 400);
            const closed = await context.request.put(origin + '/api/auth/shifts?action=close', { data: { shift_id: shiftId, actual_cash: 50 } });
            assert(closed.ok(), await closed.text()); assert.equal(Number((await closed.json()).expected_cash), 50);
            out.runs.push({ language, width, fee, xyz, statuses: ['none', 'partial', 'full'], refundedCash: fee ? 4.4 : 4, expectedClosingCash: 50 });
            console.log(`${label}: real Remove/pay/history/partial/full refund; cash, stock and recipes balance`);
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
