// Built Shifts UI -> real API -> guarded loopback DB. Never contacts a printer.
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const ar = require('../../src/shared/i18n/ar.json');
let created = false, server, io;

async function browserAcceptance(base) {
    const { chromium, expect } = require('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    const results = [];
    try {
        for (const [language, width, role] of [['en', 1280, 'admin'], ['ar', 390, 'programmer'], ['en', 390, 'programmer'], ['ar', 1280, 'admin']]) {
            const t = key => language === 'ar' ? ar[key] || key : key;
            const day = require('../../backend/utils/businessDate').getBusinessDate();
            const [insert] = await pool.query("INSERT INTO shifts (user_id,starting_cash,expected_cash,actual_cash,status,opened_at,closed_at) VALUES (2,50,80,999,'closed',?,?)", [`${day} 08:00:00`, `${day} 09:00:00`]);
            const shiftId = insert.insertId;
            await require('../../backend/tests/helpers/fixtures').insertPaidOrder(pool, { shift_id: shiftId, total: 30, cash_amount: 30 });
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            try {
                await context.addInitScript(language => localStorage.setItem('pos_admin_language', language), language);
                const login = await context.request.post(`${base}/api/auth/login`, { data: { user_number: role === 'admin' ? '9001' : '9087' } });
                expect(login.ok()).toBe(true);
                const settings = await context.request.post(`${base}/api/system/settings`, { data: { admin_language: language } });
                expect(settings.ok()).toBe(true);
                const page = await context.newPage(), errors = [], writes = [];
                page.on('pageerror', error => errors.push(error.message));
                page.on('request', request => {
                    if (request.method() === 'PUT' && request.url().includes('action=update_cash')) writes.push(request.postDataJSON());
                });
                await page.goto(`${base}/admin/shifts`);
                const row = () => page.locator(width >= 768 ? '.admin-data-grid tbody tr' : '.admin-grid-mobile-card')
                    .filter({ has: page.getByText(`#${shiftId}`, { exact: true }) });
                const open = async () => {
                    await expect(row()).toHaveCount(1);
                    await row().locator('button').last().click();
                    await expect(page.getByRole('button', { name: t('Edit Ending Cash'), exact: true })).toBeVisible();
                };
                await open();
                await page.getByRole('button', { name: t('Edit Ending Cash'), exact: true }).click();
                const ending = page.getByRole('spinbutton', { name: t('Ending Cash'), exact: true });
                const starting = page.getByRole('spinbutton', { name: t('Starting Cash'), exact: true });
                await expect(ending).toHaveValue('999');
                await expect(starting).toHaveValue('50');
                await ending.fill('');
                await expect(page.getByRole('button', { name: t('Save Changes'), exact: true })).toBeDisabled();
                await ending.fill('0');
                await expect(page.getByRole('button', { name: t('Save Changes'), exact: true })).toBeEnabled();
                await page.screenshot({ path: `scratch/shift-cash-${language}-${width}-editing.png`, fullPage: true });
                await page.getByRole('button', { name: t('Cancel'), exact: true }).click();
                expect(writes).toHaveLength(0);
                await page.getByRole('button', { name: t('Edit Ending Cash'), exact: true }).click();
                await expect(ending).toHaveValue('999');
                for (const amount of [0, 80]) {
                    await ending.fill(String(amount));
                    await page.getByRole('button', { name: t('Save Changes'), exact: true }).click();
                    await page.getByRole('button', { name: t('Confirm'), exact: true }).click();
                    await expect(page.getByRole('dialog')).toHaveCount(0);
                    const [[shift]] = await pool.query('SELECT starting_cash,expected_cash,actual_cash,status FROM shifts WHERE id=?', [shiftId]);
                    expect(Number(shift.actual_cash)).toBe(amount);
                    expect(Number(shift.starting_cash)).toBe(50);
                    expect(Number(shift.expected_cash)).toBe(80);
                    expect(shift.status).toBe('closed');
                    await open();
                    const payload = await context.request.get(`${base}/api/admin/shift-reports/${shiftId}/print-payload?type=z_report`);
                    const report = (await payload.json()).print_payload;
                    expect(Number(report.actual_cash)).toBe(amount);
                    expect(Number(report.variance)).toBe(amount - 80);
                    if (amount === 0) await page.getByRole('button', { name: t('Edit Ending Cash'), exact: true }).click();
                }
                await expect(page.getByRole('dialog').getByText(t('Perfect'), { exact: true })).toBeVisible();
                expect(writes).toEqual([{ shift_id: shiftId, actual_cash: 0 }, { shift_id: shiftId, actual_cash: 80 }]);
                const [audits] = await pool.query("SELECT old_value,new_value FROM audit_events WHERE entity_type='shift' AND entity_id=? AND event_type='shift_cash_edited' ORDER BY id", [shiftId]);
                expect(audits.map(row => JSON.parse(row.new_value))).toEqual([{ actual_cash: 0 }, { actual_cash: 80 }]);
                await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
                await page.screenshot({ path: `scratch/shift-cash-${language}-${width}-saved.png`, fullPage: true });
                expect(errors).toEqual([]);
                if (language === 'en' && width === 1280) {
                    const [active] = await pool.query("INSERT INTO shifts (user_id,starting_cash,status,opened_at) VALUES (2,50,'open',?)", [`${day} 10:00:00`]);
                    const [[activeBefore]] = await pool.query('SELECT actual_cash FROM shifts WHERE id=?', [active.insertId]);
                    await page.reload();
                    const activeRow = page.locator('.admin-data-grid tbody tr').filter({ has: page.getByText(`#${active.insertId}`, { exact: true }) });
                    await activeRow.locator('button').last().click();
                    await expect(page.getByRole('button', { name: 'Edit Starting Cash', exact: true })).toBeVisible();
                    await expect(page.getByRole('button', { name: 'Edit Ending Cash', exact: true })).toHaveCount(0);
                    await page.getByRole('button', { name: 'Edit Starting Cash', exact: true }).click();
                    await expect(page.getByRole('spinbutton', { name: 'Ending Cash', exact: true })).toHaveCount(0);
                    await page.getByRole('spinbutton', { name: 'Starting Cash', exact: true }).fill('0');
                    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
                    await expect(page.getByRole('dialog')).toHaveCount(0);
                    const [[saved]] = await pool.query('SELECT starting_cash,actual_cash,status FROM shifts WHERE id=?', [active.insertId]);
                    expect(Number(saved.starting_cash)).toBe(0);
                    expect(saved.actual_cash).toBe(activeBefore.actual_cash);
                    expect(saved.status).toBe('open');
                    expect(errors).toEqual([]);
                }
                results.push({ language, width, role, zeroSaved: true, correctedVariance: 0, audits: audits.length, writes, errors });
                console.log(`${language} ${width} ${role}: zero, correction, variance and audit passed`);
            } finally { await context.close(); }
        }
    } finally { await browser.close(); }
    fs.writeFileSync('scratch/shift-cash-browser.json', JSON.stringify(results, null, 2));
}

async function run() {
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; } finally { await admin.end(); }
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    await pool.query("INSERT INTO users (name,user_number,role,is_active) VALUES ('Correction Programmer','9087','programmer',1)");
    ({ server, io } = require('../../server'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.mkdirSync('scratch', { recursive: true });
    await browserAcceptance(`http://127.0.0.1:${server.address().port}`);
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (io) await new Promise(resolve => io.close(resolve));
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await pool.end();
    if (created) {
        const admin = await mysql.createConnection(options);
        try { await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
    }
});
