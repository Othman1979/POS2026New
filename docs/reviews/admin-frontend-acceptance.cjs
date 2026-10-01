// Called by AUDIT_VERIFY=1. All writes and print destinations are HTTP/UI doubles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { createHash } = require('node:crypto');
const { expect } = require('@playwright/test');

module.exports = async ({ page, context, origin, lang, width, go, run, spreadsheet, out, products, uploadReceipts }) => {
  const checks = run.acceptance = [];
  const originTime = await page.evaluate(() => performance.timeOrigin);
  const t = key => lang === 'ar' ? require('../../src/shared/i18n/ar.json')[key] || key : key;
  const step = label => { checks.push(label); console.log(lang, width, 'verified:', label); };
  const table = width >= 1024 ? 'tbody tr' : '.admin-grid-mobile-card';
  const endInspection = async () => {
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(page.locator('[role="dialog"] button').filter({ hasText: t('Start Import') })).toBeEnabled();
  };
  const openImport = async () => {
    await page.locator('.inventory-page-actions button[aria-haspopup="menu"]').click();
    await page.locator('.inventory-actions-menu [role="menuitem"]').nth(1).click();
    await page.locator('input[type="file"]').waitFor({ state: 'attached' });
  };
  const fileInput = () => page.locator('input[type="file"]');
  const submit = () => page.locator('[role="dialog"] button').filter({ hasText: t('Start Import') });

  assert.equal(run.steps.find(s => s.label === 'inventory-10-events').requests.length, 2);
  assert.equal(run.steps.find(s => s.label === 'jofotara-10-events').requests.length, 1);
  assert.equal(run.steps.find(s => s.label === 'inventory-search').requests.length, 1);
  assert(!run.steps.find(s => s.label === 'inventory-12').resources.some(r => /xlsx|catalogWorkbook/.test(r.name)));
  step('bounded event/search reads and no workbook dependency on Inventory entry');

  await page.locator('.inventory-search-field input').fill('Product 19');
  await page.waitForTimeout(500);
  await go('orders', table);
  await page.locator('.orders-workspace input[type="search"]').fill('INV-7');
  await page.waitForTimeout(450);
  await go('dashboard', 'canvas');
  await go('orders', table);
  await expect(page.locator('.orders-workspace input[type="search"]')).toHaveValue('INV-7');
  await go('inventory', '.inventory-search-field input');
  await expect(page.locator('.inventory-search-field input')).toHaveValue('Product 19');
  await expect(page.locator('.inventory-pagination select')).toHaveValue('96');
  assert.equal(await page.evaluate(() => performance.timeOrigin), originTime);
  assert.equal(run.requests.filter(r => r.url === '/api/config/business').length, 1);
  step('Orders/Inventory filters and page size survive route visits without document reload');

  await page.locator('.inventory-search-field input').fill('');
  await page.waitForTimeout(500);
  let version = 1, calls = 0, releaseFirst;
  const firstStarted = new Promise(resolve => { releaseFirst = { started: resolve }; });
  const firstGate = new Promise(resolve => { releaseFirst.release = resolve; });
  const productRoute = async route => {
    const snapshot = version; calls++;
    if (calls === 1) { releaseFirst.started(); await firstGate; }
    await route.fulfill({ json: { success: true, products: [{ ...products[0], name: `Fresh version ${snapshot}` }], pagination: { total: 1, total_pages: 1 } } }).catch(() => {});
  };
  await page.route('**/api/admin/products?*', productRoute);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('inventory_changed')));
  await firstStarted;
  version = 2;
  await page.evaluate(() => { for (let i = 0; i < 10; i++) window.dispatchEvent(new CustomEvent('inventory_changed')); });
  releaseFirst.release();
  await expect(page.locator('main :text-is("Fresh version 2"):visible')).toHaveCount(1);
  assert.equal(calls, 2);
  version = 3;
  await go('dashboard', 'canvas'); await go('inventory', '.inventory-search-field input');
  await expect(page.locator('main :text-is("Fresh version 3"):visible')).toHaveCount(1);
  await page.unroute('**/api/admin/products?*', productRoute);
  step('events arriving during a held read and cached-page return both show the newest data');

  let badgeVersion = 1, badgeCalls = 0, badgeStarted, releaseBadge;
  const badgeGate = new Promise(resolve => { releaseBadge = resolve; });
  const badgeStart = new Promise(resolve => { badgeStarted = resolve; });
  const badgeRoute = async route => {
    const snapshot = badgeVersion; badgeCalls++;
    if (badgeCalls === 1) { badgeStarted(); await badgeGate; }
    await route.fulfill({ json: { success: true, total: snapshot } });
  };
  await page.route('**/api/admin/jofotara/operations/count', badgeRoute);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('jofotara_operations_changed')));
  await badgeStart; badgeVersion = 2;
  await page.evaluate(() => { for (let i = 0; i < 10; i++) window.dispatchEvent(new CustomEvent('jofotara_operations_changed')); });
  releaseBadge();
  await expect(page.locator('a[href="/admin/jofotara"] .nav-badge')).toHaveText('2');
  assert.equal(badgeCalls, 2);
  await page.unroute('**/api/admin/jofotara/operations/count', badgeRoute);
  step('badge displays the final count after events during a pending read');

  await go('reports-sales', '.sales-table tbody tr');
  await expect(page.locator('.sales-table tbody tr')).toHaveCount(50);
  await page.locator('.sales-pagination button').last().click();
  await expect(page.locator('.sales-table tbody tr').first()).toContainText('Product 51');
  await page.locator('.sales-pagination button').last().evaluate(el => { for (let i = 0; i < 50; i++) el.click(); });
  await expect(page.locator('.sales-table tbody tr').first()).toContainText('Product 1951');
  await expect(page.locator('.sales-pagination button').last()).toBeDisabled();
  await page.locator('.sales-search input').fill('Product 199');
  await expect(page.locator('.sales-table tbody tr')).toHaveCount(11);
  await expect(page.locator('.sales-table tbody tr').first()).toContainText('Product 199');
  await page.locator('.sales-search input').fill('no-such-product');
  await expect(page.locator('.sales-table__empty')).toBeVisible();
  await page.locator('.sales-search input').fill('Product 199');
  step('report first/last pages, filter reset, and zero-result behavior');

  await context.route('**/print-receipt?*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>
    const params = new URL(location.href).searchParams;
    const nonce = params.get('admin_report'), layout = params.get('layout');
    addEventListener('message', e => { if(e.origin === location.origin) window.received = e.data; });
    opener.postMessage({ type:'POS_ADMIN_PRINT_READY', nonce, layout }, location.origin);
  </script>` }));
  const popupPromise = page.waitForEvent('popup');
  await page.locator('.report-print-menu__trigger').click();
  await page.locator('.report-print-menu__list [role="menuitem"]').nth(1).click();
  const popup = await popupPromise;
  await popup.waitForFunction(() => window.received?.type === 'POS_ADMIN_PRINT_PAYLOAD');
  const printed = await popup.evaluate(() => window.received);
  assert.equal(printed.payload.data.products.length, 2000);
  assert.equal(printed.payload.data.totals.sales_collected, 133000);
  assert.equal(printed.payload.direction, lang === 'ar' ? 'rtl' : 'ltr');
  await popup.close();
  step('real print sender preserves all 2,000 products and totals while screen is filtered');

  await go('inventory', '.inventory-search-field input');
  await openImport();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: t('Download Template'), exact: true }).click();
  const download = await downloadPromise;
  const templatePath = path.join(out, `${lang}-${width}-template.xlsx`);
  await download.saveAs(templatePath);
  const template = XLSX.readFile(templatePath);
  assert.deepEqual(template.SheetNames, ['Categories', 'Products']);
  const rows = XLSX.utils.sheet_to_json(template.Sheets.Products, { header: 1 });
  assert.equal(rows[1][0], 'Hummus Plain'); assert.equal(rows[1][2], 2.25);
  await fileInput().setInputFiles(templatePath); await endInspection();
  await expect(page.locator('[role="dialog"] select')).toHaveCount(0);
  step('actual worker-generated template downloads and reopens with original values');

  await page.getByRole('button', { name: t('Remove File'), exact: true }).click();
  await fileInput().setInputFiles(spreadsheet);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(1);
  await expect(submit()).toBeDisabled();
  await page.getByRole('button', { name: t('Remove File'), exact: true }).click();
  await expect(fileInput()).toHaveValue('');
  await expect(submit()).toBeDisabled();
  await expect.poll(() => page.workers().length).toBe(0);
  await fileInput().setInputFiles(spreadsheet);
  await fileInput().setInputFiles(templatePath); await endInspection();
  await expect(page.getByText(path.basename(templatePath), { exact: true })).toBeVisible();
  await expect(page.locator('[role="dialog"] select')).toHaveCount(0);
  await expect.poll(() => page.workers().length).toBe(0);
  step('pending import cannot submit; clear/replacement terminate workers and latest file wins');

  let imported;
  const hash = buffer => createHash('sha256').update(buffer).digest('hex');
  await page.locator('input[type="radio"][value="replace"]').check();
  await expect(submit()).toBeDisabled();
  await page.locator('[role="dialog"] input[type="checkbox"]').check();
  await expect(submit()).toBeEnabled();
  await submit().click();
  await expect(page.getByText(t('Import Completed Successfully'), { exact: true })).toBeVisible();
  imported = uploadReceipts.at(-1);
  assert.equal(imported.mode, 'replace'); assert.equal(imported.confirm, '1'); assert.equal(imported.mapping, null);
  assert.equal(hash(imported.file), hash(fs.readFileSync(templatePath)));
  await page.keyboard.press('Escape');
  step('replacement confirmation and original uploaded File bytes preserved through a synthetic POST');

  await openImport(); await fileInput().setInputFiles(spreadsheet); await endInspection();
  await expect(page.locator('[role="dialog"] select')).toHaveCount(4);
  assert.deepEqual(await page.locator('[role="dialog"] select').evaluateAll(els => els.map(el => Number(el.value))), [0, 1, 12, 15]);
  await submit().click(); await expect(page.getByText(t('Import Completed Successfully'), { exact: true })).toBeVisible();
  imported = uploadReceipts.at(-1);
  assert.equal(imported.mode, 'append'); assert.deepEqual(JSON.parse(imported.mapping), { name: 0, price: 1, category: 12, tax: 15 });
  assert.equal(hash(imported.file), hash(fs.readFileSync(spreadsheet))); await page.keyboard.press('Escape');
  step('legacy mapping and original upload bytes preserved through a synthetic POST');

  await openImport();
  await fileInput().setInputFiles({ name: 'invalid.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK\x03\x04invalid') });
  await expect(page.getByText(t('The spreadsheet could not be read.'), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: t('OK'), exact: true }).click();
  await expect.poll(() => page.workers().length).toBe(0);
  await page.keyboard.press('Escape');
  await openImport(); await fileInput().setInputFiles(spreadsheet);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect.poll(() => page.workers().length).toBe(0);
  assert.equal(await page.evaluate(() => performance.timeOrigin), originTime);
  assert.equal(await page.evaluate(() => document.documentElement.dir), lang === 'ar' ? 'rtl' : 'ltr');
  await page.screenshot({ path: path.join(out, `${lang}-${width}-accepted.png`) });
  step('invalid workbook recovery, close-during-inspection cleanup, and stable RTL/session');
};
