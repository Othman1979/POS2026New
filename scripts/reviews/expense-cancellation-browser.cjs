// Built admin UI -> real API -> generated loopback DB. Prints stay in the DB queue.
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const ar = require('../../src/shared/i18n/ar.json');
const { chromium, expect } = require('@playwright/test');
let created = false, server, io;

async function seedCases(categoryId, label) {
    const entries = [];
    for (const [kind, amount, source, status] of [
        ['closed', 5.25, 'drawer', 'closed'], ['open', 5.25, 'drawer', 'open'],
        ['outside', 2.5, 'outside', null], ['lost-response', 2, 'drawer', 'closed'],
        ['failed-refresh', 1.25, 'outside', null], ['today', 0, 'outside', null],
    ]) {
        let shiftId = null;
        if (status) {
            const [shift] = await pool.query(
                'INSERT INTO shifts (user_id,starting_cash,expected_cash,actual_cash,status,opened_at,closed_at) VALUES (2,50,?,?,?,?,?)',
                [status === 'closed' ? 50 - amount : null, status === 'closed' ? 50 - amount : null, status,
                    '2026-07-18 07:00:00', status === 'closed' ? '2026-07-18 12:00:00' : null]
            );
            shiftId = shift.insertId;
        }
        const note = `${label} ${kind}`;
        const [expense] = await pool.query(
            'INSERT INTO expenses (category_id,amount,source,shift_id,created_by,created_at,note) VALUES (?,?,?,?,2,?,?)',
            [categoryId, amount, source, shiftId, kind === 'today' ? new Date() : '2026-07-18 08:00:00', note]
        );
        const [[original]] = await pool.query('SELECT * FROM expenses WHERE id=?', [expense.insertId]);
        const [[shift]] = shiftId ? await pool.query('SELECT * FROM shifts WHERE id=?', [shiftId]) : [[null]];
        entries.push({ ...original, kind, original, shift });
    }
    return entries;
}

async function acceptance(base, categoryId, printerId) {
    const browser = await chromium.launch({ headless: true });
    const results = [];
    try {
        for (const [language, width, role] of [['en', 1280, 'admin'], ['ar', 390, 'programmer'], ['en', 390, 'programmer'], ['ar', 1280, 'admin']]) {
            const t = key => language === 'ar' ? ar[key] || key : key;
            const entries = await seedCases(categoryId, `${language}-${width}`);
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            const errors = [], writes = [], timings = [];
            try {
                await context.addInitScript(({ language, printerId }) => {
                    localStorage.setItem('pos_admin_language', language);
                    localStorage.setItem('pos_receipt_printer_id', String(printerId));
                }, { language, printerId });
                expect((await context.request.post(`${base}/api/auth/login`, { data: { user_number: role === 'admin' ? '9001' : '9087' } })).ok()).toBe(true);
                expect((await context.request.post(`${base}/api/system/settings`, { data: { admin_language: language } })).ok()).toBe(true);
                const page = await context.newPage();
                page.on('pageerror', error => errors.push(error.message));
                page.on('request', request => {
                    if (request.method() === 'POST' && /\/expenses\/\d+\/cancel$/.test(request.url())) writes.push(request.url());
                });
                await page.goto(`${base}/admin/reports-expenses`);
                await expect(page.locator('.expenses-page')).toBeVisible();
                const row = entry => page.locator('.expense-log tbody tr').filter({ hasText: entry.note });
                const cancel = entry => row(entry).locator('.expense-cancel');
                const accept = entry => page.once('dialog', async dialog => {
                    expect(dialog.message()).toContain(t('Cancel this expense?'));
                    if (entry.source === 'drawer') expect(dialog.message()).toContain(t('For a closed shift, expected cash increases by this amount. Counted cash stays unchanged.'));
                    await dialog.accept();
                });
                const today = entries.find(entry => entry.kind === 'today');
                await expect(cancel(today)).toBeVisible();
                accept(today); await cancel(today).click();
                await expect(row(today)).toHaveClass('is-canceled');
                await page.getByRole('button', { name: t('Custom period'), exact: true }).click();
                const dates = page.locator('.report-period-panel input[type=date]');
                await dates.nth(0).fill('2026-07-18'); await dates.nth(1).fill('2026-07-19');
                await page.getByRole('button', { name: t('Apply period'), exact: true }).click();
                await expect(cancel(entries[0])).toBeVisible();
                await expect(page.getByRole('button', { name: t('Add expense'), exact: true })).toBeDisabled();
                page.once('dialog', dialog => dialog.dismiss());
                await cancel(entries[0]).click();
                expect(writes).toHaveLength(1);
                await expect(cancel(entries[0])).toBeEnabled();
                await page.screenshot({ path: `scratch/expense-cancel-${language}-${width}-before.png`, fullPage: true });

                for (const entry of entries.filter(entry => entry.kind !== 'today')) {
                    const target = `**/api/admin/expenses/${entry.id}/cancel`;
                    const reportUrl = '**/api/admin/reports/expenses?*';
                    let release, committed;
                    if (entry.kind === 'open') {
                        const gate = new Promise(resolve => { release = resolve; });
                        const saved = new Promise(resolve => { committed = resolve; });
                        await page.route(target, async route => {
                            const response = await route.fetch(); committed(); await gate; await route.fulfill({ response });
                        });
                        accept(entry); await cancel(entry).click(); await saved;
                        await expect(cancel(entry)).toBeDisabled();
                        for (const button of await page.locator('.expense-cancel').all()) await expect(button).toBeDisabled();
                        expect(writes.filter(url => url.endsWith(`/expenses/${entry.id}/cancel`))).toHaveLength(1);
                        release();
                    } else {
                        if (entry.kind === 'lost-response') {
                            await page.route(target, async route => { const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort('failed'); });
                        } else if (entry.kind === 'failed-refresh') {
                            await page.route(reportUrl, route => route.abort('failed'));
                        }
                        accept(entry);
                        const start = performance.now();
                        await cancel(entry).click();
                        await expect(row(entry)).toHaveClass('is-canceled');
                        timings.push({ kind: entry.kind, clickToConfirmedRowMs: Number((performance.now() - start).toFixed(1)) });
                    }
                    await expect(row(entry)).toHaveClass('is-canceled');
                    await expect(cancel(entry)).toHaveCount(0);
                    expect(writes.filter(url => url.endsWith(`/expenses/${entry.id}/cancel`))).toHaveLength(1);
                    const [[stored]] = await pool.query('SELECT * FROM expenses WHERE id=?', [entry.id]);
                    expect(stored).toEqual({ ...entry.original, status: 'canceled', canceled_by: expect.any(Number), canceled_at: expect.anything() });
                    if (entry.shift) {
                        const [[shift]] = await pool.query('SELECT * FROM shifts WHERE id=?', [entry.shift_id]);
                        expect(shift).toEqual(entry.shift.status === 'closed' ? { ...entry.shift, expected_cash: '50.00' } : entry.shift);
                    }
                    if (['lost-response', 'failed-refresh'].includes(entry.kind)) {
                        await expect(page.locator('.report-error')).toBeVisible();
                        await page.unroute(target); await page.unroute(reportUrl);
                        await page.reload();
                        await expect(row(entry)).toHaveClass('is-canceled');
                    } else if (entry.kind === 'open') await page.unroute(target);
                }
                const report = await context.request.get(`${base}/api/admin/reports/expenses?start_date=2026-07-18&end_date=2026-07-19`);
                expect((await report.json()).summary).toEqual({ total: 0, drawer: 0, outside: 0, count: 0 });
                const [jobs] = await pool.query("SELECT payload FROM print_queue WHERE print_type='expense_cancel_slip'");
                const ownJobs = jobs.map(job => JSON.parse(job.payload).data).filter(job => entries.some(entry => entry.id === job.id));
                expect(ownJobs).toHaveLength(3);
                expect(ownJobs.every(job => job.status === 'canceled' && job.canceled_by_name && job.canceled_at)).toBe(true);
                await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
                expect(errors).toEqual([]);
                await page.screenshot({ path: `scratch/expense-cancel-${language}-${width}-after.png`, fullPage: true });
                results.push({ language, width, role, cancellations: writes.length, queuedSlips: ownJobs.length, timings, errors });
                console.log(`${language} ${width} ${role}: current/range, open/closed, declined, pending, lost response and failed refresh passed`);
            } finally { await context.close(); }
        }
    } finally { await browser.close(); fs.writeFileSync('scratch/expense-cancel-browser.json', JSON.stringify(results, null, 2)); }
}

async function run() {
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; } finally { await admin.end(); }
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    await pool.query("INSERT INTO users (name,user_number,role,is_active) VALUES ('Expense Programmer','9087','programmer',1)");
    const [category] = await pool.query("INSERT INTO expense_categories (name,created_by) VALUES ('Supplies / مستلزمات',1)");
    const [printer] = await pool.query("INSERT INTO printers (name,role,type,windows_name,is_active) VALUES ('Receipt','receipt','windows','Fixture printer',1)");
    ({ server, io } = require('../../server'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.mkdirSync('scratch', { recursive: true });
    await acceptance(`http://127.0.0.1:${server.address().port}`, category.insertId, printer.insertId);
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
