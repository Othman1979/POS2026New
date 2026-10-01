// Real built UI/API and durable queue acceptance on a generated loopback DB.
// Native window.print is a counted double; no agent or physical printer is used.
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${randomBytes(6).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');
const mysql = require('mysql2/promise');
const { database, ...options } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const fixtures = require('../../backend/tests/helpers/fixtures');
const ar = require('../../src/shared/i18n/ar.json');
let created = false, server, io;

async function acceptance(base, printerIds, shiftId) {
    const { chromium, expect } = require('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    const results = [];
    const day = require('../../backend/utils/businessDate').getBusinessDate();
    const jobs = async () => (await pool.query('SELECT payload FROM print_queue ORDER BY id'))[0].map(row => JSON.parse(row.payload));
    const seedY = async () => {
        const cart = { order_type_id: 1, items: [{ id: 1, name: 'Aggregated Y item', category_id: 1, qty: 2, price: 5, tax_rate: 0 }] };
        await pool.query('INSERT INTO held_orders (user_id,reference_name,cart_data,subtotal,created_at) VALUES (2,?,?,10,?)', ['RECEIPT-DETAIL-MUST-NOT-PRINT', JSON.stringify(cart), `${day} 08:00:00`]);
    };
    try {
        for (const [language, width, saved] of [['en', 1280, String(printerIds[1])], ['ar', 390, 'deleted-printer']]) {
            const t = key => language === 'ar' ? ar[key] || key : key;
            const context = await browser.newContext({ viewport: { width, height: 1000 } });
            const errors = [], checks = [];
            context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
            try {
                await context.addInitScript(({ language, saved }) => {
                    if (location.protocol === 'http:') {
                        localStorage.setItem('pos_admin_language', language);
                        localStorage.setItem('pos_receipt_printer_id', saved);
                    }
                    window.__printCalls = 0;
                    window.print = () => { window.__printCalls += 1; };
                }, { language, saved });
                expect((await context.request.post(`${base}/api/auth/login`, { data: { user_number: '9001' } })).ok()).toBe(true);
                expect((await context.request.post(`${base}/api/system/settings`, { data: { admin_language: language } })).ok()).toBe(true);
                const page = await context.newPage();
                await page.goto(`${base}/admin/shifts`);
                const menuFor = label => typeof label === 'number' ? page.locator('.report-print-menu').nth(label) : page.locator('.report-print-menu').filter({ has: page.getByRole('button', { name: t(label), exact: true }) });
                async function print(label, layout, isY = false) {
                    const before = (await jobs()).length;
                    const pagesBefore = context.pages().length;
                    await menuFor(label).locator('.report-print-menu__trigger').click();
                    const popupPromise = layout === 'a4' ? context.waitForEvent('page') : null;
                    await page.getByRole('menuitem').filter({ hasText: t(layout === 'a4' ? 'Detailed A4' : 'Thermal (80mm)') }).click();
                    if (isY) await page.getByRole('button', { name: t('Confirm'), exact: true }).click();
                    if (layout === 'thermal') {
                        await expect.poll(async () => (await jobs()).length).toBe(before + 1);
                        expect(context.pages()).toHaveLength(pagesBefore);
                        const job = (await jobs()).at(-1);
                        expect(job.printer_id).toBe(language === 'en' ? printerIds[1] : printerIds[0]);
                        if (job.print_type === 'y_held_items_report') {
                            expect(job.data.orders).toBeUndefined();
                            expect(job.data.summary.total).toBe(10);
                            expect(job.data.items[0].qty_sold).toBe(2);
                            fs.writeFileSync(`scratch/shifts-print-y-${language}-job.json`, JSON.stringify(job, null, 2));
                        }
                        checks.push({ label, layout, type: job.print_type, printer: job.printer_id });
                    } else {
                        const popup = await popupPromise;
                        await expect.poll(() => popup.evaluate(() => window.__printCalls)).toBe(1);
                        await expect(popup.locator('.a4-report').first()).toBeVisible();
                        if (label === 'Y' || label === 'Reopen last Y') {
                            const text = await popup.locator('body').innerText();
                            expect(text).toContain('Aggregated Y item');
                            expect(text).not.toContain('RECEIPT-DETAIL-MUST-NOT-PRINT');
                            expect(text).not.toContain('تفاصيل الطلبات');
                            if (label === 'Y') await popup.screenshot({ path: `scratch/shifts-print-y-${language}-a4.png`, fullPage: true });
                        }
                        expect((await jobs()).length).toBe(before);
                        checks.push({ label, layout, nativePreviewPrintCalls: 1 });
                        await popup.close();
                    }
                    await expect(menuFor(label).locator('.report-print-menu__trigger')).toBeEnabled();
                }
                for (const layout of ['thermal', 'a4']) {
                    await print('Print X Report', layout);
                    await print(1, layout); // Z label becomes its persisted reprint serial.
                    await print('Items Report', layout);
                    await seedY();
                    await print('Y', layout, true);
                    await print('Reopen last Y', layout);
                    await page.getByText(t('Period'), { exact: true }).click();
                    await print('Print Period Report', layout);
                    await page.getByText(t('Period'), { exact: true }).click();
                    const row = page.locator(width >= 768 ? '.admin-data-grid tbody tr' : '.admin-grid-mobile-card').filter({ has: page.getByText(`#${shiftId}`, { exact: true }) });
                    await row.locator('button').last().click();
                    await print('Print Z-Report (Final)', layout);
                    await page.getByRole('dialog').getByRole('button', { name: t('Close'), exact: true }).click();
                }
                if (process.env.SHIFT_REPORT_HOSTILE === '1') {
                    const select = async (label, layout) => {
                        await menuFor(label).locator('.report-print-menu__trigger').click();
                        await page.getByRole('menuitem').filter({ hasText: t(layout === 'a4' ? 'Detailed A4' : 'Thermal (80mm)') }).click();
                    };
                    const held = async () => (await pool.query('SELECT id,cart_data FROM held_orders ORDER BY id'))[0];
                    const archives = async () => (await pool.query('SELECT id FROM master_held ORDER BY id'))[0];
                    // The server commits successfully, but the browser receives either
                    // a reset or a truncated JSON body. This is not a pre-request failure.
                    for (const failure of ['reset-after-commit', 'truncated-body-after-commit']) {
                        await seedY();
                        const before = (await jobs()).length, archivesBefore = (await archives()).length;
                        const pagesBefore = context.pages().length;
                        let requests = 0;
                        const routePattern = '**/api/admin/audit-reports/print-y';
                        const loseResponse = async route => {
                            requests += 1;
                            const response = await route.fetch({ maxRetries: 0 });
                            expect(response.ok()).toBe(true);
                            expect((await response.json()).print_queued).toBe(true);
                            if (failure === 'reset-after-commit') await route.abort('connectionreset');
                            else await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,' });
                        };
                        await page.route(routePattern, loseResponse);
                        try {
                            await select('Y', 'thermal');
                            await page.getByRole('button', { name: t('Confirm'), exact: true }).click();
                            await expect(page.getByText(t('The print result could not be confirmed. It may already be queued. Check Printing before retrying.'), { exact: true })).toBeVisible();
                            await page.getByRole('button', { name: t('OK'), exact: true }).click();
                            await expect(menuFor('Reopen last Y').locator('.report-print-menu__trigger')).toBeEnabled();
                            expect(requests).toBe(1);
                            expect(context.pages()).toHaveLength(pagesBefore);
                            expect((await jobs()).length).toBe(before + 1);
                            expect((await archives()).length).toBe(archivesBefore + 1);
                            expect(await held()).toHaveLength(0);
                        } finally { await page.unroute(routePattern, loseResponse); }
                        // Only an explicit archive reprint may create the second job,
                        // and it must preserve any new held order created meanwhile.
                        const original = (await jobs()).at(-1).data;
                        await seedY();
                        const newHolds = await held();
                        await print('Reopen last Y', 'thermal');
                        expect((await jobs()).at(-1).data).toEqual(original);
                        expect(await held()).toEqual(newHolds);
                        await pool.query('DELETE FROM held_orders WHERE id IN (?)', [newHolds.map(row => row.id)]);
                        checks.push({ failure, requests, committedJobs: 1, automaticReprints: 0, recoveryVisible: true, manualReprintPreservedNewHolds: true });
                    }
                    // Hold the real preview navigation before its ready handshake,
                    // change the page's date, then allow it to request the report.
                    let releasePreview, previewIntercepted;
                    const intercepted = new Promise(resolve => { previewIntercepted = resolve; });
                    const holdPreview = async route => {
                        previewIntercepted();
                        await new Promise(resolve => { releasePreview = resolve; });
                        await route.continue();
                    };
                    await context.route('**/print-receipt?**', holdPreview);
                    try {
                        const popupPromise = context.waitForEvent('page');
                        await select('Items Report', 'a4');
                        await intercepted;
                        const otherDay = '2026-07-01';
                        await page.getByLabel(t('Start'), { exact: true }).fill(otherDay);
                        const bodyPromise = page.waitForRequest(request => request.url().endsWith('/api/admin/audit-reports/print-items'));
                        releasePreview();
                        const body = (await bodyPromise).postDataJSON();
                        expect(body.business_date).toBe(day);
                        const popup = await popupPromise;
                        await expect.poll(() => popup.evaluate(() => window.__printCalls)).toBe(1);
                        await popup.close();
                        await page.getByLabel(t('Start'), { exact: true }).fill(day);
                        checks.push({ delayedA4Preview: true, clickedDate: day, changedDate: otherDay, printedDate: body.business_date });
                    } finally { releasePreview?.(); await context.unroute('**/print-receipt?**', holdPreview); }
                }
                const openShift = await fixtures.insertShift(pool, { opened_at: `${day} 11:00:00` });
                await page.reload();
                const activeRow = page.locator(width >= 768 ? '.admin-data-grid tbody tr' : '.admin-grid-mobile-card').filter({ has: page.getByText(`#${openShift}`, { exact: true }) });
                await activeRow.locator('button').last().click();
                await print('Print X-Report (Audit)', 'thermal');
                await print('Print X-Report (Audit)', 'a4');
                await pool.query("UPDATE shifts SET status='closed',closed_at=? WHERE id=?", [`${day} 12:00:00`, openShift]);
                expect(errors).toEqual([]);
                results.push({ language, width, savedPrinter: saved, checks, errors });
                console.log(`${language} ${width}: ${checks.length} dropdown prints passed`);
            } finally { await context.close(); }
        }
    } finally { await browser.close(); }
    fs.writeFileSync('scratch/shifts-print-browser.json', JSON.stringify(results, null, 2));
}

async function run() {
    const admin = await mysql.createConnection(options);
    try { await admin.query(`CREATE DATABASE \`${database}\``); created = true; } finally { await admin.end(); }
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='y_order_type_id'");
    const printers = [await fixtures.seedReceiptPrinter(pool), await fixtures.seedReceiptPrinter(pool, { name: 'Saved report printer', windows_name: 'Fixture-Saved-Printer' })];
    const day = require('../../backend/utils/businessDate').getBusinessDate();
    const shiftId = await fixtures.insertShift(pool, { status: 'closed', actual_cash: 50, opened_at: `${day} 08:00:00`, closed_at: `${day} 09:00:00` });
    ({ server, io } = require('../../server'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.mkdirSync('scratch', { recursive: true });
    await acceptance(`http://127.0.0.1:${server.address().port}`, printers, shiftId);
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
