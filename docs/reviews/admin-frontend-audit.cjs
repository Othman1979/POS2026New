/* Audit harness: built admin only, synthetic HTTP, no application server or DB. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const os = require('node:os');
const { chromium } = require('@playwright/test');
const { Server } = require('socket.io');
const XLSX = require('xlsx');
const root = path.resolve(__dirname, '../..');
const outputLabel = process.env.AUDIT_LABEL || 'audit';
if (!/^[a-z0-9-]+$/.test(outputLabel)) throw new Error('AUDIT_LABEL must be a simple filename slug');
const out = path.join(root, `scratch/admin-frontend-${outputLabel}`);
const verify = process.env.AUDIT_VERIFY === '1';
fs.mkdirSync(out, { recursive: true });
const rounds = Number(process.env.AUDIT_ROUNDS || 3);
const cpuRate = Number(process.env.AUDIT_CPU || 4);
const products = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, product_id: i + 1, name: `Product ${i + 1}`, item_name: `Product ${i + 1}`, category_id: 1 + i % 40, category_name: `Category ${1 + i % 40}`, category_path: `Category ${1 + i % 40}`, price: 3.5, tax_rate: 0, stock: 50, is_active: 1, sold_qty: 20, returned_qty: 1, net_sales: 66.5 }));
const categories = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `Category ${i + 1}`, parent_id: null, is_active: 1 }));
const dashboard = { success: true, business_date: '2026-09-10', as_of: '2026-09-10T10:00:00Z', refreshed_at: '2026-09-10T10:00:00Z', history: { eligible_days: 0, comparison_ready: false }, headline: { sales_today: 350, orders: 100, average_check: 3.5, estimated_close: null, expenses_today: 20, remaining_after_expenses: 330 }, comparison: { typical: null, delta: null, pace_state: 'unavailable', driver: 'none' }, pace: { points: Array.from({ length: 25 }, (_, i) => ({ elapsed_minute: i * 30, today: i * 14, typical: null })) }, tables: null, attention: [], products: products.slice(0, 5).map(p => ({ ...p, net_units: 19, delta_percent: null })), payments: [{ method: 'cash', amount: 350, share: 1 }] };
const orders = Array.from({ length: 50 }, (_, i) => ({ invoice_id: i + 1, invoice_number: `INV-${i + 1}`, order_id: i + 1, total: 3.5, grand_total: 3.5, status: 'paid', payment_method: 'cash', cashier_name: 'Fixture', customer_name: 'Fixture', order_type: 'takeaway', created_at: '2026-09-10 10:00:00', paid_at: '2026-09-10 10:00:00', items_count: 1 }));
const unknown = [];
const uploadReceipts = [];
let lang = 'en';
let salesCount = 100;
function fixture(url) {
  const p = url.pathname;
  if (p === '/api/config/business') return { success: true, business_sql_offset: '+03:00', business_day_start_hour: 6 };
  if (p === '/api/auth/me') return { success: true, user: { id: 1, role: 'admin', name: 'Audit' } };
  if (p === '/api/system/settings') return { success: true, admin_language: lang, stock_enabled: '1', tables_enabled: '0', recipe_ledger_enabled: '0', jofotara_enabled: '1', low_stock_threshold: 3 };
  if (p === '/api/system/public_preferences') return { success: true };
  if (p === '/api/admin/dashboard') return dashboard;
  if (p === '/api/admin/alerts') return { success: true, lowStockItems: [] };
  if (p === '/api/admin/jofotara/operations/count') return { success: true, total: 0 };
  if (p === '/api/admin/jofotara/operations') return { success: true, enabled: true, summary: { total: 0 }, operations: [] };
  if (p === '/api/admin/jofotara/settings') return { success: true, settings: { enabled: false } };
  if (p === '/api/admin/shifts') return { success: true, cashiers: [] };
  if (p === '/api/admin/categories') return { success: true, categories };
  if (p === '/api/admin/products') {
    const limit = Number(url.searchParams.get('limit') || 12), page = Number(url.searchParams.get('page') || 1);
    const rows = products.filter(p => p.name.toLowerCase().includes((url.searchParams.get('search') || '').toLowerCase()));
    return { success: true, products: rows.slice((page - 1) * limit, page * limit), pagination: { total: rows.length, total_pages: Math.ceil(rows.length / limit) }, stats: { active_products: 2000, low_stock: 0 } };
  }
  if (p === '/api/admin/orders') return { success: true, orders, pagination: { total: 2000, total_pages: 40 } };
  if (p === '/api/admin/customers') return { success: true, customers: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `Customer ${i + 1}`, phone: '', address: '' })), pagination: { total: 2000, total_pages: 40 } };
  if (p === '/api/admin/reports/sales-details') return { success: true, period: { start_date: '2026-09-10', end_date: '2026-09-10' }, totals: { sales_collected: salesCount * 66.5, menu_sales: salesCount * 66.5, service_charges_collected: 0 }, categories: [], products: products.slice(0, salesCount), order_types: [], cashiers: [], waiters: [], tables: [], tables_enabled: false };
  unknown.push(p); return { success: false, message: `Unmapped audit endpoint ${p}` };
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (verify && req.method === 'POST' && u.pathname === '/api/admin/import/catalog') {
    // Receive the actual multipart stream: DevTools request bodies omit uploaded file bytes.
    const chunks = []; let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
    req.on('end', async () => {
      try {
        const form = await new Request('http://127.0.0.1/api/admin/import/catalog', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }).formData();
        uploadReceipts.push({ mode: form.get('mode'), mapping: form.get('mapping'), confirm: form.get('confirm_replace'), file: Buffer.from(await form.get('file').arrayBuffer()) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, summary: { products_imported: 1, products_skipped: 0, categories_imported: 0, categories_skipped: 0 }, errors: [] }));
      } catch (error) { unknown.push(`fixture upload: ${error.message}`); res.writeHead(400); res.end(); }
    });
    return;
  }
  if (req.method !== 'GET') { unknown.push(`${req.method} ${u.pathname}`); res.writeHead(405); return res.end(); }
  let body, type;
  if (u.pathname.startsWith('/api/')) { body = Buffer.from(JSON.stringify(fixture(u))); type = 'application/json'; }
  else {
    const rel = u.pathname.startsWith('/admin') && !u.pathname.endsWith('.js') ? 'admin.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, 'dist', rel);
    if (!file.startsWith(path.join(root, 'dist') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    body = fs.readFileSync(file); type = types[path.extname(file)] || 'application/octet-stream';
  }
  const gzip = /gzip/.test(req.headers['accept-encoding'] || '') && /text|json/.test(type);
  if (gzip) body = zlib.gzipSync(body);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', ...(verify ? { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self'; object-src 'none'; base-uri 'self'" } : {}), ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(body);
});
const io = new Server(server); // only a local transport, no business events or backend imports
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(Array.from({ length: 20000 }, (_, r) => Array.from({ length: 16 }, (_, c) => c === 1 ? 3.5 : `row${r}col${c}`))), 'Legacy');
const spreadsheet = path.join(out, 'synthetic-20000x16.xlsx');
XLSX.writeFile(workbook, spreadsheet, { compression: true });
async function main() {
 await new Promise(r => server.listen(0, '127.0.0.1', r));
 const origin = `http://127.0.0.1:${server.address().port}`;
 const browser = await chromium.launch({ headless: true });
 const result = { revision: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), node: process.version, chromium: browser.version(), cpu: os.cpus()[0].model, cpuRate, rounds, spreadsheetBytes: fs.statSync(spreadsheet).size, runs: [], unknown };
 try {
 const cases = verify ? [['en', 1440, 900], ['en', 390, 844], ['ar', 1440, 900], ['ar', 390, 844]] : [['en', 1440, 900], ['ar', 390, 844]];
 for (const [language, width, height] of cases) for (let round = 0; round < rounds; round++) {
  lang = language;
  salesCount = 100;
  const context = await browser.newContext({ viewport: { width, height }, locale: lang === 'en' ? 'en-US' : 'ar-JO' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(language => {
    localStorage.setItem('pos_admin_language', language);
    sessionStorage.setItem('pos_user', JSON.stringify({ id: 1, role: 'admin', name: 'Audit' }));
    sessionStorage.setItem('pos_user_at', String(Date.now()));
    window.__long = [];
    new PerformanceObserver(list => window.__long.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
  }, lang);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  await cdp.send('Performance.enable');
  const run = { lang, width, round, steps: [], errors: [], requests: [] }; result.runs.push(run);
  const tableSelector = width >= 1024 ? 'tbody tr' : '.admin-grid-mobile-card';
  page.on('pageerror', e => run.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') run.errors.push(m.text()); });
  page.on('request', r => { if (r.url().includes('/api/')) run.requests.push({ url: new URL(r.url()).pathname + new URL(r.url()).search, at: Date.now() }); });
  async function snapshot(label, start, before, reqStart) {
    await page.waitForTimeout(250);
    const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const dom = await page.evaluate(s => ({ nodes: document.querySelectorAll('*').length, rows: document.querySelectorAll('tbody tr').length, visibleRows: [...document.querySelectorAll('tbody tr')].filter(n => n.getClientRects().length).length, longTasks: window.__long.filter(e => e.start >= s), resources: performance.getEntriesByType('resource').filter(e => e.startTime >= s).map(e => ({ name: new URL(e.name).pathname, encoded: e.encodedBodySize, decoded: e.decodedBodySize, transfer: e.transferSize })), dir: document.documentElement.dir, overflow: document.documentElement.scrollWidth > innerWidth }), start);
    const step = { label, elapsedMs: await page.evaluate(s => performance.now() - s, start), taskMs: (metrics.TaskDuration - (before.TaskDuration || 0)) * 1000, ...dom, requests: run.requests.slice(reqStart).map(r => r.url) };
    run.steps.push(step); console.log(lang, round, label, Math.round(step.taskMs), 'task ms', step.rows, 'rows');
    return step;
  }
  async function action(label, fn) {
    const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const start = await page.evaluate(() => performance.now()), reqStart = run.requests.length;
    await fn(); return snapshot(label, start, before, reqStart);
  }
  async function go(name, selector) {
    await page.locator(`a[href='/admin/${name}']`).first().evaluate(el => el.click());
    await page.waitForURL(`**/admin/${name}`);
    if (name === 'customers') await page.locator('main :text-is("Customer 1"):visible').first().waitFor();
    if (name === 'orders') await page.locator('.orders-workspace').waitFor();
    await page.locator(selector).first().waitFor({ state: 'visible' });
  }
  await page.goto(origin + '/admin/dashboard');
  await page.locator('canvas').waitFor(); await page.waitForLoadState('networkidle');
  await snapshot('cold-dashboard', 0, {}, 0);
  run.coldHeap = await heap('cold-dashboard');
  await page.screenshot({ path: path.join(out, `${lang}-${round}-dashboard.png`) });
  await action('orders-50', () => go('orders', tableSelector));
  await action('inventory-12', () => go('inventory', '.inventory-search-field input'));
  await action('inventory-search', async () => { await page.locator('.inventory-search-field input').fill('Product 1'); await page.waitForTimeout(700); });
  await action('inventory-96', async () => { await page.locator('.inventory-search-field input').fill(''); await page.waitForTimeout(500); await page.locator('.inventory-pagination select').selectOption('96'); await page.waitForTimeout(500); });
  await action('customers-50', () => go('customers', tableSelector));
  await action('sales-100', () => go('reports-sales', '.sales-table tbody tr'));
  await go('customers', tableSelector);
  salesCount = 2000;
  await action('sales-2000', () => go('reports-sales', '.sales-table tbody tr'));
  await page.screenshot({ path: path.join(out, `${lang}-${round}-sales.png`) });
  run.salesInputs = await page.locator('main input').evaluateAll(els => els.map(e => ({ placeholder: e.placeholder, type: e.type })));
  await action('sales-filter', async () => { await page.locator('.sales-product-filters input, .sales-toolbar input, input[type="search"]').first().fill('Product 199'); });
  await action('return-dashboard', () => go('dashboard', 'canvas'));
  async function heap(label) { await cdp.send('HeapProfiler.collectGarbage'); return { label, ...await cdp.send('Runtime.getHeapUsage'), ...await cdp.send('Memory.getDOMCounters') }; }
  run.heap = [await heap('warm')];
  if (round === 0 && !verify) await action('dashboard-idle-10s', () => page.waitForTimeout(10000));
  for (let cycle = 0; cycle < (verify ? 1 : 5); cycle++) {
    await go('orders', tableSelector);
    await go('inventory', '.inventory-search-field input');
    await go('reports-sales', '.sales-table tbody tr');
    await go('dashboard', 'canvas'); await page.waitForTimeout(300);
    run.heap.push(await heap(`cycle-${cycle + 1}`));
  }
  await go('inventory', '.inventory-search-field input'); await page.waitForTimeout(500);
  run.inventoryButtons = await page.locator('main button').evaluateAll(els => els.map(e => ({ text: e.textContent.trim(), title: e.title, aria: e.getAttribute('aria-label') })));
  await page.screenshot({ path: path.join(out, `${lang}-${round}-inventory.png`) });
  await page.locator('.inventory-page-actions button[aria-haspopup="menu"]').click();
  await page.locator('.inventory-actions-menu [role="menuitem"]').nth(1).click();
  await page.locator('input[type="file"]').waitFor({ state: 'attached' });
  await action('inspect-xlsx-20000x16', async () => {
    await page.locator('input[type="file"]').setInputFiles(spreadsheet);
    await page.getByText('synthetic-20000x16.xlsx', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  });
  await page.screenshot({ path: path.join(out, `${lang}-${round}-import.png`) });
  await page.keyboard.press('Escape');
  await action('inventory-10-events', async () => {
    await page.evaluate(() => { for (let i = 0; i < 10; i++) window.dispatchEvent(new CustomEvent('inventory_changed', { detail: {} })); });
    await page.waitForTimeout(500);
  });
  await action('jofotara-10-events', async () => {
    await page.evaluate(() => { for (let i = 0; i < 10; i++) window.dispatchEvent(new CustomEvent('jofotara_operations_changed', { detail: {} })); });
    await page.waitForTimeout(500);
  });
  if (verify) await require('./admin-frontend-acceptance.cjs')({ page, context, origin, lang, width, go, run, spreadsheet, out, products, uploadReceipts });
  await context.close();
 }
 if (unknown.length || result.runs.some(run => run.errors.length)) throw new Error('Fixture or browser errors: inspect results JSON before using measurements.');
 } finally {
  fs.writeFileSync(path.join(out, `results-cpu${cpuRate}.json`), JSON.stringify(result, null, 2));
  await browser.close(); await new Promise(r => io.close(r)); server.close();
 }
}
main().catch(e => { console.error(e); process.exitCode = 1; server.close(); io.close(); });
