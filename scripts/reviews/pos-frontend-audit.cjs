/* Audit only: production frontend, loopback synthetic reads, no application DB/server. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
const { Server } = require('socket.io');
const root = path.resolve(__dirname, '../..');
const cpu = Number(process.env.AUDIT_CPU || 4);
const rounds = Number(process.env.AUDIT_ROUNDS || 1);
const label = process.env.AUDIT_LABEL || 'baseline';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid label');
const out = path.join(root, 'scratch', `pos-frontend-${label}`);
fs.mkdirSync(out, { recursive: true });
let lang = 'en', heldCount = 30, latency = 0, historyFailure = false, heldFailure = false, heldPlan = [];
let stalledReadPath = null;
const unknown = [], rejectedWrites = [], serverRequests = [];
const settings = () => ({ success: true, admin_language: lang, store_name: 'Audit fixture', tables_enabled: process.env.AUDIT_TABLES_ENABLED === '0' ? '0' : '1', table_mode: 'fixed', stock_enabled: '0', barcode_enabled: '0', tax_inclusive_pricing: '0', print_method: 'browser', service_charge_enabled: '0', quick_numpad_mode: '0' });
const types = [{ id: 1, name: 'Takeaway', is_active: 1 }, { id: 2, name: 'Delivery', is_active: 1 }, { id: 3, name: 'Pickup', is_active: 1 }];
const categories = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Category ${i + 1}`, parent_id: null }));
const products = Array.from({ length: 1440 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}`, price: 3, tax_rate: 0, category_id: 1 + Math.floor(i / 120), is_active: 1, is_available: 1, can_sell: 1, stock: null, is_custom: false }));
const tables = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, table_number: String(i + 1), section_id: 1, section_name: 'Main', status: i % 3 ? 'occupied' : 'available', current_order_id: i % 3 ? i + 100 : null, active_order_created_at: '2026-09-10 09:00:00', active_order_total: 30, active_order_waiter_name: 'Fixture', x: (i % 10) * 145, y: Math.floor(i / 10) * 145, width: 120, height: 120, shape: 'square' }));
const held = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, order_id: i + 1000, created_at: '2026-09-10 09:00:00', reference_name: `Ticket ${i + 1}`, cashier_name: 'Fixture', version: 1, kitchen_fired: 0, cart_data: JSON.stringify({ order_type_id: 1 + i % 3, customer_name: `Fixture ${i + 1}`, items: Array.from({ length: 5 }, (_, j) => ({ id: j + 1, name: `Product ${j + 1}`, qty: 1, price: 3, tax_rate: 0, note: 'No salt' })) }) }));
const history = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, invoice_id: i + 1, invoice_number: `INV-${i + 1}`, order_id: i + 1, total: 15, grand_total: 15, payment_method: 'cash', cashier_name: 'Fixture', order_type_name: types[i % 3].name, created_at: '2026-09-10 09:00:00', paid_at: '2026-09-10 09:00:00', items: [{ id: 1, product_name: 'Product 1', quantity: 5, price_at_sale: 3, note: 'No salt' }] }));
function fixture(u) {
  const p = u.pathname;
  if (p === '/api/config/business') return { success: true, business_sql_offset: '+03:00', business_day_start_hour: 6 };
  if (p === '/api/auth/me') return { success: true, user: { id: 1, role: 'admin', name: 'Audit' } };
  if (p === '/api/system/settings') return settings();
  if (p === '/api/system/public_preferences') return { success: true };
  if (p === '/api/auth/shifts') return { success: true, data: { id: 1, user_id: 1, status: 'open', opening_cash: 0 } };
  if (p === '/api/pos/order_types') return { success: true, data: types };
  if (p === '/api/pos/products') {
    const cat = u.searchParams.get('category_id') || (!u.searchParams.has('category_id') && !u.searchParams.has('lightweight') && !u.searchParams.has('search') ? '1' : null), query = u.searchParams.get('search');
    const rows = products.filter(p => (!cat || p.category_id === Number(cat)) && (!query || p.name.toLowerCase().includes(query.toLowerCase())));
    const offset = Number(u.searchParams.get('offset') || 0), limit = Number(u.searchParams.get('limit') || 120);
    return { success: true, selected_category_id: cat ? Number(cat) : null, products: rows.slice(offset, offset + limit), categories_included: !u.searchParams.has('lightweight'), categories: u.searchParams.has('lightweight') ? undefined : categories, settings: settings(), pagination: { total: rows.length, offset, limit } };
  }
  if (p === '/api/pos/get_tables') return { success: true, settings: settings(), sections: [{ id: 1, name: 'Main' }], tables };
  if (p === '/api/pos/table_splits') return { success: true, data: [] };
  if (p === '/api/pos/held_orders/summary') return { success: true, active_register_count: heldCount };
  if (p === '/api/pos/held_orders') return heldFailure ? { success: false, message: 'Synthetic held failure' } : { success: true, data: held(heldCount) };
  if (p === '/api/pos/order_notes') return historyFailure ? { success: false, message: 'Synthetic history failure' } : { success: true, orders: history };
  if (p === '/api/admin/printers') return { success: true, data: [] };
  if (p === '/api/admin/orders') return { success: true, orders: history.slice(0, 50), pagination: { total: 200, total_pages: 4 } };
  if (p === '/api/admin/order_details') return { success: true, order: history[0], items: history[0].items };
  if (p === '/api/admin/shifts') return { success: true, cashiers: [] };
  if (p === '/api/admin/alerts') return { success: true, lowStockItems: [] };
  if (p === '/api/admin/jofotara/operations') return { success: true, enabled: false, summary: { total: 0 }, operations: [] };
  if (p === '/api/admin/jofotara/settings') return { success: true, settings: { enabled: false } };
  unknown.push(p); return { success: false, message: `Unmapped audit endpoint ${p}` };
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && u.pathname === '/api/pos/category-prices/resolve') {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const data = products.filter(p => (payload.product_ids || []).includes(p.id)).map(p => ({ ...p, product_id: p.id, price_override_locked: 0 }));
      serverRequests.push({ path: u.pathname, method: 'POST', readOnly: true, started: Date.now(), finished: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, products: data }));
    }); return;
  }
  if (req.method !== 'GET') { rejectedWrites.push({ method: req.method, path: u.pathname }); res.writeHead(405); return res.end('Audit is read-only'); }
  if (u.pathname.startsWith('/api/')) {
    const item = { path: u.pathname + u.search, started: Date.now() }; serverRequests.push(item);
    if (u.pathname === stalledReadPath) {
      item.stalledBody = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"success":');
      res.on('close', () => { item.closed = Date.now(); });
      return;
    }
    const plan = u.pathname === '/api/pos/held_orders' ? heldPlan.shift() : null;
    const data = plan ? { success: true, data: held(plan.count) } : fixture(u);
    const delay = plan?.delay ?? latency;
    let status = (u.pathname === '/api/pos/order_notes' && historyFailure) || (u.pathname === '/api/pos/held_orders' && heldFailure) ? 500 : 200;
    let body = JSON.stringify(data);
    const headers = { 'Content-Type': 'application/json' };
    if (u.pathname === '/api/pos/products' && status === 200) {
      const etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;
      item.ifNoneMatch = req.headers['if-none-match'] || null;
      item.etag = etag;
      headers['Cache-Control'] = 'private, no-cache';
      headers.ETag = etag;
      if (item.ifNoneMatch === etag) {
        status = 304;
        body = '';
      }
    }
    item.status = status;
    setTimeout(() => { item.finished = Date.now(); res.writeHead(status, headers); res.end(body); }, delay);
    return;
  }
  const asset = u.pathname === '/' || !path.extname(u.pathname) ? (u.pathname.startsWith('/admin') ? 'admin.html' : 'index.html') : decodeURIComponent(u.pathname.slice(1));
  const candidates = [[path.resolve(root, 'dist', asset), path.join(root, 'dist')], [path.resolve(root, asset), path.join(root, 'assets')]];
  const file = candidates.find(([f, base]) => f.startsWith(base + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile())?.[0];
  if (!file) { res.writeHead(404); return res.end(); }
  const body = zlib.gzipSync(fs.readFileSync(file));
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' }); res.end(body);
});
const io = new Server(server, { transports: ['websocket', 'polling'] });
async function run() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const result = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), cpuRate: cpu, rounds, cpu: os.cpus()[0].model, node: process.version, chromium: browser.version(), runs: [], unknown, rejectedWrites, serverRequests };
  try {
    const cases = process.env.AUDIT_SMOKE
      ? [['en', 1440, 900]]
      : process.env.AUDIT_LARGE_CART_ONLY === '1'
        ? [['en', 1440, 900], ['ar', 390, 844]]
        : [['en', 1440, 900], ['ar', 1440, 900], ['en', 390, 844], ['ar', 390, 844]];
    for (const [language, width, height] of cases) for (let round = 0; round < rounds; round++) {
      lang = language; heldCount = 30; latency = 0; historyFailure = false; heldPlan = [];
      const context = await browser.newContext({ viewport: { width, height }, locale: language === 'ar' ? 'ar-JO' : 'en-US' });
      if (process.env.AUDIT_VERIFY_ETAG !== '1') {
        await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
      }
      await context.addInitScript(language => {
        localStorage.setItem('pos_admin_language', language); sessionStorage.setItem('pos_user', JSON.stringify({ id: 1, role: 'admin', name: 'Audit' })); sessionStorage.setItem('pos_user_at', String(Date.now()));
        window.__long = []; new PerformanceObserver(l => window.__long.push(...l.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
      }, language);
      const page = await context.newPage(); const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu }); await cdp.send('Performance.enable');
      const rec = { lang, width, round, steps: [], errors: [] }; result.runs.push(rec);
      page.on('pageerror', e => rec.errors.push({ type: 'pageerror', text: e.stack }));
      page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') rec.errors.push({ type: m.type(), text: m.text() }); });
      const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      const go = async target => {
        await page.evaluate(p => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(p), target);
        await page.waitForURL(origin + target);
        const selectors = { '/pos': '.product-stage', '/order-notes': '.order-notes-page', '/tables': '.tables-page' };
        await page.locator(selectors[target]).waitFor();
        for (const [route, selector] of Object.entries(selectors)) if (route !== target) await page.locator(selector).waitFor({ state: 'detached' });
        if (target === '/order-notes') await page.locator('.note-card').first().waitFor();
        await page.waitForLoadState('networkidle');
      };
      async function step(name, fn, cold = false) {
        const before = await metrics(); const start = cold ? 0 : await page.evaluate(() => performance.now()); const reqStart = serverRequests.length;
        const wallStart = Date.now(); await fn(); await page.waitForTimeout(250);
        const after = await metrics();
        const state = await page.evaluate(async ({ start, verifyIcons }) => {
          if (verifyIcons) await document.fonts.ready;
          const visibleIcons = verifyIcons
            ? [...document.querySelectorAll('[class*="fa-"]')]
              .filter(element => element.getClientRects().length > 0 && [...element.classList].some(name => /^fa-(?:solid|regular|brands)$/.test(name)))
              .map(element => ({
                classes: [...element.classList].filter(name => name.startsWith('fa-')),
                content: getComputedStyle(element, '::before').content,
                family: getComputedStyle(element, '::before').fontFamily,
              }))
            : [];
          return {
            elements: document.querySelectorAll('*').length,
            productCards: document.querySelectorAll('.product-card').length,
            noteCards: document.querySelectorAll('.note-card').length,
            tableCards: document.querySelectorAll('[data-testid="table-card"]').length,
            longTasks: window.__long.filter(e => e.start >= start),
            resources: performance.getEntriesByType('resource').filter(e => e.startTime >= start).map(e => ({ path: new URL(e.name).pathname, encoded: e.encodedBodySize, decoded: e.decodedBodySize })),
            iconAudit: verifyIcons ? {
              visible: visibleIcons,
              fontChecks: {
                solid: visibleIcons.some(icon => icon.classes.includes('fa-solid')) ? document.fonts.check('900 16px "Font Awesome 7 Free"') : null,
                regular: visibleIcons.some(icon => icon.classes.includes('fa-regular')) ? document.fonts.check('400 16px "Font Awesome 7 Free"') : null,
                brands: visibleIcons.some(icon => icon.classes.includes('fa-brands')) ? document.fonts.check('400 16px "Font Awesome 7 Brands"') : null,
              },
            } : null,
            dir: document.documentElement.dir,
          };
        }, { start, verifyIcons: process.env.AUDIT_VERIFY_ICONS === '1' });
        if (process.env.AUDIT_VERIFY_ICONS === '1') {
          const missing = state.iconAudit.visible.filter(icon => ['none', 'normal', '""'].includes(icon.content) || !/Font Awesome/.test(icon.family));
          assert.deepEqual(missing, [], `${name} has visible Font Awesome classes without rendered glyphs`);
          assert.ok(Object.values(state.iconAudit.fontChecks).every(value => value !== false), `${name} did not load every visible Font Awesome style`);
        }
        rec.steps.push({ name, wallMs: Date.now() - wallStart, taskMs: (after.TaskDuration - (before.TaskDuration || 0)) * 1000, requests: serverRequests.slice(reqStart).map(r => ({ ...r })), ...state });
        console.log(language, width, round, name, Math.round(rec.steps.at(-1).taskMs), 'task ms');
      }
      if (process.env.AUDIT_RENDER_ONLY) {
        heldCount = 200;
        await step('held-200-cold', async () => { await page.goto(origin + '/order-notes'); await page.waitForFunction(() => document.querySelectorAll('.note-card').length === 200); await page.waitForLoadState('networkidle'); }, true);
        for (let sample = 0; sample < 5; sample++) await step('held-200-refresh', async () => {
          const reply = page.waitForResponse(r => new URL(r.url()).pathname === '/api/pos/held_orders');
          io.emit('held_orders_changed', {}); await reply; await page.waitForLoadState('networkidle');
        });
        await step('history-200', async () => { await page.locator('.notes-mode button').last().click(); await page.waitForFunction(() => document.querySelectorAll('.note-card').length === 200 && document.querySelector('.notes-mode button:last-child').getAttribute('aria-pressed') === 'true'); await page.waitForLoadState('networkidle'); });
        await context.close();
        fs.writeFileSync(path.join(out, `results-cpu${cpu}.json`), JSON.stringify(result, null, 2));
        continue;
      }
      if (!process.env.AUDIT_ORDERS_ONLY) {
      await step('cold-pos', async () => { await page.goto(origin + '/pos'); await page.locator('.product-card').first().waitFor(); await page.waitForLoadState('networkidle'); }, true);
      if (process.env.AUDIT_VERIFY_I18N_TRANSITIONS === '1') {
        await page.evaluate(() => {
          const root = document.querySelector('#app');
          const probe = document.createElement('span');
          probe.id = 'i18n-audit-probe';
          probe.textContent = 'Orders';
          probe.title = 'Orders';
          probe.setAttribute('aria-label', 'Orders');
          const input = document.createElement('input');
          input.placeholder = 'Orders';
          probe.append(input);
          const dynamic = document.createElement('span');
          dynamic.id = 'i18n-audit-dynamic';
          dynamic.textContent = 'Cashier: Maya';
          const skipped = document.createElement('span');
          skipped.id = 'i18n-audit-skipped';
          skipped.setAttribute('data-no-i18n', '');
          skipped.textContent = 'Orders';
          root.append(probe, dynamic, skipped);
          window.__i18nAuditProbe = probe;
        });
        const setPageLanguage = language => page.evaluate(next => document.querySelector('#app').__vue_app__.config.globalProperties.$setLanguage(next), language);
        const assertTranslated = () => page.waitForFunction(() => {
          const probe = document.querySelector('#i18n-audit-probe');
          return document.documentElement.dir === 'rtl'
            && probe?.firstChild?.nodeValue === 'الطلبات'
            && probe?.title === 'الطلبات'
            && probe?.getAttribute('aria-label') === 'الطلبات'
            && probe?.querySelector('input')?.placeholder === 'الطلبات'
            && document.querySelector('#i18n-audit-dynamic')?.textContent === 'الكاشير: Maya'
            && document.querySelector('#i18n-audit-skipped')?.textContent === 'Orders';
        });
        const assertEnglish = () => page.waitForFunction(() => {
          const probe = document.querySelector('#i18n-audit-probe');
          return document.documentElement.dir === 'ltr'
            && probe?.firstChild?.nodeValue === 'Orders'
            && probe?.title === 'Orders'
            && probe?.getAttribute('aria-label') === 'Orders'
            && probe?.querySelector('input')?.placeholder === 'Orders'
            && document.querySelector('#i18n-audit-dynamic')?.textContent === 'Cashier: Maya';
        });
        await setPageLanguage('ar');
        await assertTranslated();
        if (process.env.AUDIT_VERIFY_I18N_BURST === '1') {
          await page.evaluate(() => {
            const held = [];
            const original = window.requestAnimationFrame;
            window.requestAnimationFrame = callback => { held.push(callback); return held.length; };
            window.__i18nAuditHeldFrames = { held, original };
            const fragment = document.createDocumentFragment();
            for (let index = 0; index < 300; index++) {
              const row = document.createElement('span');
              row.className = 'i18n-audit-burst';
              row.textContent = 'Orders';
              fragment.append(row);
            }
            document.querySelector('#app').append(fragment);
          });
          await page.waitForFunction(() => window.__i18nAuditHeldFrames?.held.length > 0);
          await page.evaluate(() => {
            const { held, original } = window.__i18nAuditHeldFrames;
            window.requestAnimationFrame = original;
            for (const callback of held) callback(performance.now());
          });
          await page.waitForFunction(() => {
            const rows = [...document.querySelectorAll('.i18n-audit-burst')];
            return rows.length === 300 && rows.every(row => row.textContent === 'الطلبات');
          });
          await page.locator('.i18n-audit-burst').evaluateAll(rows => rows.forEach(row => row.remove()));
          rec.i18nBurst = { passed: true };
        }
        await page.evaluate(() => window.__i18nAuditProbe.remove());
        await setPageLanguage('en');
        // Finish the root reversion while the Arabic probe is still detached.
        // Reinsertion must be recovered by the observer, not the root pass.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.evaluate(() => window.__i18nAuditProbe.firstChild.nodeValue), 'الطلبات');
        await page.evaluate(() => document.querySelector('#app').append(window.__i18nAuditProbe));
        await assertEnglish();
        await page.evaluate(async () => {
          const setLanguage = document.querySelector('#app').__vue_app__.config.globalProperties.$setLanguage;
          await Promise.all([setLanguage('ar'), setLanguage('en')]);
        });
        await assertEnglish();
        await setPageLanguage(language);
        if (language === 'ar') await assertTranslated();
        else await assertEnglish();
        await page.evaluate(() => {
          window.__i18nAuditProbe.remove();
          document.querySelector('#i18n-audit-dynamic').remove();
          document.querySelector('#i18n-audit-skipped').remove();
          delete window.__i18nAuditProbe;
        });
        rec.i18nTransitions = { passed: true };
      }
      if (process.env.AUDIT_LARGE_CART_ONLY === '1') {
        const requestedLines = Math.min(100, Math.max(1, Number(process.env.AUDIT_CART_LINES || 100)));
        const interactionErrorStart = rec.errors.length;
        const addBefore = await metrics();
        const addStarted = Date.now();
        await page.evaluate(async (lineCount) => {
          const cards = [...document.querySelectorAll('.product-card')].slice(0, lineCount);
          if (cards.length !== lineCount) throw new Error(`Expected ${lineCount} product cards, found ${cards.length}`);
          for (const card of cards) {
            card.click();
            await new Promise(resolve => requestAnimationFrame(() => resolve()));
          }
        }, requestedLines);
        await page.waitForFunction(
          expected => document.querySelectorAll('.cart-items-scroll tbody > tr').length === expected,
          requestedLines,
        );
        await page.waitForTimeout(250);
        const addAfter = await metrics();
        const addWallMs = Date.now() - addStarted;
        const quantityLookup = await page.evaluate(() => {
          const session = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('orderSession');
          const cart = session.cart;
          const productIds = Array.from({ length: 120 }, (_, index) => String(index + 1));
          const legacyLookup = productId => cart
            .filter(item => String(item.id) === String(productId) && !item.is_custom)
            .reduce((sum, item) => sum + parseFloat(item.qty), 0);
          const measure = lookup => {
            let checksum = 0;
            const started = performance.now();
            for (let iteration = 0; iteration < 250; iteration += 1) {
              for (const productId of productIds) checksum += lookup(productId);
            }
            return { durationMs: performance.now() - started, checksum };
          };
          legacyLookup('1');
          session.getQtyInCart('1');
          const legacy = measure(legacyLookup);
          const indexed = measure(productId => session.getQtyInCart(productId));
          return { legacy, indexed };
        });
        assert.equal(quantityLookup.indexed.checksum, quantityLookup.legacy.checksum, 'Indexed cart quantities changed lookup results');

        if (width < 1024) {
          await page.locator('button').filter({ hasText: /View Order|عرض الطلب/ }).last().click();
        }
        const cartRows = page.locator('.cart-items-scroll tbody > tr');
        const targetIndex = Math.floor(requestedLines / 2);
        const interactionBefore = await metrics();
        const interactionStarted = Date.now();
        await cartRows.nth(targetIndex).click();
        await page.locator('.numpad button').filter({ hasText: /^2$/ }).click();
        await page.locator('.cart-item-actions button').first().click();
        await page.locator('.modal-panel textarea').fill('Large cart note / ملاحظة طلب كبير');
        await page.locator('.modal-actions button').last().click();
        await page.locator('.modal-panel textarea').waitFor({ state: 'detached' });
        await page.locator('.cart-items-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
        await page.waitForTimeout(100);
        const targetRowText = await cartRows.nth(targetIndex).innerText();
        await page.locator('button.cart-final-action').filter({ hasText: /Pay|دفع|الدفع/ }).last().click();
        await page.locator('.checkout-dialog').waitFor();
        const checkoutRowCount = await page.locator('.checkout-items-list .checkout-item, .checkout-items tbody tr').count();
        await page.locator('.checkout-close').click();
        await page.locator('.checkout-dialog').waitFor({ state: 'detached' });
        const interactionAfter = await metrics();

        rec.largeCart = {
          requestedLines,
          renderedRows: await cartRows.count(),
          addWallMs,
          addTaskMs: (addAfter.TaskDuration - (addBefore.TaskDuration || 0)) * 1000,
          interactionWallMs: Date.now() - interactionStarted,
          interactionTaskMs: (interactionAfter.TaskDuration - (interactionBefore.TaskDuration || 0)) * 1000,
          targetRowText,
          checkoutRowCount,
          persistedCartBytes: await page.evaluate(() => (localStorage.getItem('pos_cart') || '').length),
          quantityLookup,
          errors: rec.errors.slice(interactionErrorStart),
        };
        assert.equal(rec.largeCart.renderedRows, requestedLines, 'Large cart lost or duplicated rows');
        assert.match(targetRowText, /Large cart note/);
        assert.match(targetRowText, /\b2\b/);
        assert.deepEqual(rec.largeCart.errors, [], 'Large-cart interactions produced browser errors or warnings');
        await page.screenshot({ path: path.join(out, `${language}-${width}-${round}-large-cart.png`), fullPage: true });
        await context.close();
        fs.writeFileSync(path.join(out, `results-cpu${cpu}.json`), JSON.stringify(result, null, 2));
        continue;
      }
      if (process.env.AUDIT_VERIFY_ETAG === '1') {
        const reconnectReads = [];
        for (let reconnect = 0; reconnect < 2; reconnect += 1) {
          const requestStart = serverRequests.length;
          await page.evaluate(() => window.dispatchEvent(new Event('socket_reconnected')));
          const deadline = Date.now() + 5_000;
          let catalogRead;
          while (Date.now() < deadline) {
            catalogRead = serverRequests.slice(requestStart).find(request => request.path.startsWith('/api/pos/products?') && request.finished);
            if (catalogRead) break;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          assert.ok(catalogRead, `Reconnect ${reconnect + 1} did not refresh the catalog`);
          reconnectReads.push({ ...catalogRead });
          await page.waitForTimeout(350);
        }
        assert.ok(reconnectReads.some(read => read.ifNoneMatch && read.ifNoneMatch === read.etag && read.status === 304), 'Reconnect did not reuse a matching catalog validator');
        assert.ok(await page.locator('.product-card').count() > 0, 'Revalidated catalog lost its cached response body');
        rec.catalogRevalidation = reconnectReads;
      }
      if (process.env.AUDIT_VERIFY_DISABLED_TABLES === '1') {
        const initialTableReads = serverRequests.filter(request => request.path.startsWith('/api/pos/get_tables')).length;
        const recoveryStart = serverRequests.length;
        await page.evaluate(() => window.dispatchEvent(new Event('socket_reconnected')));
        await page.waitForTimeout(500);
        io.emit('table_update', { action: 'refresh' });
        await page.waitForTimeout(500);
        const recoveryReads = serverRequests.slice(recoveryStart);
        assert.equal(initialTableReads, 0, 'Disabled tables loaded during register bootstrap');
        assert.equal(recoveryReads.filter(request => request.path.startsWith('/api/pos/get_tables')).length, 0, 'Disabled tables loaded during reconnect or a broad table event');
        assert.ok(recoveryReads.some(request => request.path.startsWith('/api/pos/products?')), 'Reconnect did not refresh the active register catalog');
        assert.ok(await page.locator('.product-card').count() > 0, 'Disabled-table recovery disrupted the register catalog');
        rec.disabledTableRecovery = { initialTableReads, recoveryReads };
        await context.close();
        fs.writeFileSync(path.join(out, `results-cpu${cpu}.json`), JSON.stringify(result, null, 2));
        continue;
      }
      rec.initialButtons = await page.locator('button').evaluateAll(es => es.filter(e => e.getClientRects().length).map(e => ({ text: e.textContent.trim(), aria: e.getAttribute('aria-label') })));
      await step('category-switch', async () => { await page.locator('.category-button').filter({ hasText: /^Category 2$/ }).click(); await page.locator('.product-card').filter({ hasText: 'Product 121' }).waitFor(); });
      await step('add-item', async () => { await page.locator('.product-card').first().click(); });
      if (process.env.AUDIT_VERIFY_DIALOGS === '1') {
        const trigger = page.locator('.category-button').first();
        await trigger.focus();
        await page.evaluate(() => {
          window.__dialogResult = 'pending';
          window.showPosConfirm('Focus lifecycle confirmation', 'Focus confirmation')
            .then(value => { window.__dialogResult = value; });
        });
        const confirmDialog = page.locator('[aria-labelledby="pos-confirm-title"]');
        await confirmDialog.waitFor();
        assert.equal(await confirmDialog.locator('[data-dialog-initial-focus]').evaluate(element => element === document.activeElement), true, 'Confirm must focus its safe default action');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await confirmDialog.locator('button').last().evaluate(element => element === document.activeElement), true, 'Shift+Tab must wrap to the last action');
        await page.keyboard.press('Tab');
        assert.equal(await confirmDialog.locator('button').first().evaluate(element => element === document.activeElement), true, 'Tab must wrap to the first action');
        await page.keyboard.press('Escape');
        await confirmDialog.waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => window.__dialogResult), false, 'Escape must resolve confirm as cancelled');
        assert.equal(await trigger.evaluate(element => element === document.activeElement), true, 'Confirm must restore its trigger focus');

        await trigger.focus();
        await page.evaluate(() => {
          window.__dialogResult = 'pending';
          window.showPosPrompt('Focus prompt', '', 'Type here', 'Focus prompt')
            .then(value => { window.__dialogResult = value; });
        });
        const promptDialog = page.locator('[aria-labelledby="pos-prompt-title"]');
        await promptDialog.waitFor();
        const promptInput = promptDialog.locator('input');
        assert.equal(await promptInput.evaluate(element => element === document.activeElement), true, 'Prompt must focus its input');
        await promptInput.fill('typed value');
        await promptInput.press('Enter');
        await promptDialog.waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => window.__dialogResult), 'typed value', 'Enter must submit the prompt value');
        assert.equal(await trigger.evaluate(element => element === document.activeElement), true, 'Prompt must restore its trigger focus');

        await page.evaluate(() => {
          window.__replacedDialog = 'pending';
          window.showPosAlert('This alert will be replaced', 'Replace alert')
            .then(() => { window.__replacedDialog = 'resolved'; });
          window.showPosPrompt('Replacement prompt', '', 'Type here', 'Replacement prompt');
        });
        await promptDialog.waitFor();
        assert.equal(await page.locator('[role="dialog"][aria-modal="true"]').count(), 1, 'Global dialog APIs must keep only one dialog active');
        assert.equal(await page.evaluate(() => window.__replacedDialog), 'resolved', 'Replacing a global dialog must settle its pending caller');
        await page.keyboard.press('Escape');
        await promptDialog.waitFor({ state: 'detached' });

        if (width < 1024) await page.locator('button').filter({ hasText: /View Order|عرض الطلب/ }).last().click();
        const payButton = page.locator('button.cart-final-action').filter({ hasText: /Pay|دفع|الدفع/ }).last();
        await payButton.focus();
        await payButton.click();
        const checkoutDialog = page.locator('.checkout-dialog');
        await checkoutDialog.waitFor();
        assert.equal(await checkoutDialog.evaluate(element => element.contains(document.activeElement)), true, 'Checkout must receive focus when opened');
        await checkoutDialog.locator('.checkout-customer').click();
        await checkoutDialog.locator('.checkout-phone-keypad-toggle').click();
        const phoneKeypad = checkoutDialog.locator('.checkout-phone-keypad-sheet');
        await phoneKeypad.waitFor();
        assert.equal(await phoneKeypad.evaluate(element => element === document.activeElement), true, 'Phone keypad must receive focus when opened');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await phoneKeypad.locator('button').last().evaluate(element => element === document.activeElement), true, 'Phone keypad Shift+Tab must wrap to its last action');
        assert.equal(await page.evaluate(() => document.activeElement?.closest('[inert]') === null), true, 'Phone keypad focus must not enter inert checkout controls');
        await page.keyboard.press('Tab');
        assert.equal(await phoneKeypad.locator('button').first().evaluate(element => element === document.activeElement), true, 'Phone keypad Tab must wrap to its first action');
        await page.keyboard.press('Escape');
        await phoneKeypad.waitFor({ state: 'detached' });
        assert.equal(await checkoutDialog.locator('.checkout-phone-keypad-toggle').evaluate(element => element === document.activeElement), true, 'Phone keypad must restore its trigger focus');
        await page.evaluate(() => {
          window.__dialogResult = 'pending';
          window.showPosConfirm('Nested confirmation', 'Nested confirmation')
            .then(value => { window.__dialogResult = value; });
        });
        await confirmDialog.waitFor();
        await page.keyboard.press('Escape');
        await confirmDialog.waitFor({ state: 'detached' });
        assert.equal(await checkoutDialog.isVisible(), true, 'Escape must close only the topmost dialog');
        assert.equal(await checkoutDialog.evaluate(element => element.contains(document.activeElement)), true, 'Nested dialog must restore focus inside checkout');
        await page.evaluate(() => {
          document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('orderUi').isProcessing = true;
        });
        await page.keyboard.press('Escape');
        assert.equal(await checkoutDialog.isVisible(), true, 'Processing checkout must ignore Escape');
        assert.equal(await checkoutDialog.locator('.checkout-close').isDisabled(), true, 'Processing checkout must disable its close action');
        await page.evaluate(() => {
          document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('orderUi').isProcessing = false;
        });
        await page.keyboard.press('Escape');
        await checkoutDialog.waitFor({ state: 'detached' });
        assert.equal(await payButton.evaluate(element => element === document.activeElement), true, 'Checkout must restore the payment trigger focus');
        if (width < 1024) await page.locator('.cart-nav-close').click();
        rec.dialogAcceptance = { confirm: true, prompt: true, nested: true, checkout: true, phoneKeypad: true };
      }
      if (process.env.AUDIT_VERIFY_ICONS === '1') {
        if (width < 1024) await page.locator('button').filter({ hasText: /View Order|عرض الطلب/ }).last().click();
        await step('checkout-icons', async () => {
          await page.locator('button.cart-final-action').filter({ hasText: /Pay|دفع|الدفع/ }).last().click();
          await page.locator('.checkout-dialog').waitFor();
        });
        await page.locator('.checkout-close').click();
        if (width < 1024) await page.locator('.cart-nav-close').click();
      }
      await step('item-note-save', async () => {
        if (width < 1024) await page.locator('button').filter({ hasText: /View Order|عرض الطلب/ }).last().click();
        await page.locator('.cart-panel tbody tr').first().click();
        await page.locator('.cart-item-action').first().click();
        await page.locator('textarea').fill('No salt / بدون ملح');
        await page.locator('.modal-footer .modal-action--primary').click();
        if (width < 1024) await page.locator('.cart-nav-close').click();
      });
      rec.cartBeforeNotes = await page.evaluate(() => localStorage.getItem('pos_cart'));
      assert.equal(JSON.parse(rec.cartBeforeNotes)[0].note, 'No salt / بدون ملح');
      if (process.env.AUDIT_STRESS && width === 1440 && language === 'en') {
        for (const size of [30, 150]) {
          await page.evaluate(({ products, size }) => {
            const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('orderSession');
            store.$patch({ cart: products.slice(120, 120 + size).map((p, i) => ({ ...p, qty: 1, cartId: `stress-${i}`, note: '', discountType: null, discountValue: 0 })) });
          }, { products, size });
          await page.waitForTimeout(350);
          await step(`add-item-${size}-cart-lines`, () => page.locator('.product-card').first().click());
        }
        await page.evaluate(raw => {
          const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('orderSession');
          store.$patch({ cart: JSON.parse(raw) });
        }, rec.cartBeforeNotes);
        await page.waitForTimeout(300);
      }
      await step('notes-30', async () => { await go('/order-notes'); await page.locator('.note-card').first().waitFor(); await page.waitForLoadState('networkidle'); });
      await step('history-200', async () => { await page.locator('.notes-mode button').nth(1).click(); await page.waitForFunction(() => document.querySelectorAll('.note-card').length === 200); });
      await page.locator('.notes-mode button').first().click();
      await step('notes-event-burst', async () => { for (let i = 0; i < 10; i++) io.emit('held_orders_changed', {}); await page.waitForTimeout(650); });
      await step('tables-80', async () => { await go('/tables'); await page.locator('[data-testid="table-card"]').first().waitFor(); await page.waitForLoadState('networkidle'); });
      if (process.env.AUDIT_VERIFY_FLOOR) assert.equal(rec.steps.at(-1).requests.filter(r => r.path === '/api/pos/table_splits').length, 0, 'Floor entry must use table counts without split details');
      await step('tables-held-event-burst', async () => { for (let i = 0; i < 10; i++) io.emit('held_orders_changed', {}); await page.waitForTimeout(650); });
      if (process.env.AUDIT_VERIFY_SPLITS) assert.ok(rec.steps.at(-1).requests.filter(r => r.path === '/api/pos/table_splits').length <= 2, 'Split notifications must share reads');
      if (process.env.AUDIT_VERIFY_FLOOR) {
        assert.equal(rec.steps.at(-1).requests.filter(r => r.path === '/api/pos/table_splits').length, 0, 'Floor notifications must not read split details');
        assert.equal(rec.steps.at(-1).requests.filter(r => r.path.startsWith('/api/pos/get_tables')).length, 1, 'Ten floor notifications must share one count refresh');
      }
      latency = Number(process.env.AUDIT_RETURN_LATENCY_MS || 0);
      await step('return-pos', async () => {
        await go('/pos');
        await page.locator('.product-card').first().waitFor();
        await page.waitForLoadState('networkidle');
        if (latency) await page.waitForTimeout(1_000);
      });
      latency = 0;
      rec.cartAfterNotes = await page.evaluate(() => localStorage.getItem('pos_cart'));
      const cartMeaning = raw => JSON.parse(raw).map(({ id, cartId, qty, price, tax_rate, note, discountType, discountValue }) => ({ id, cartId, qty, price, tax_rate, note, discountType, discountValue }));
      assert.deepEqual(cartMeaning(rec.cartAfterNotes), cartMeaning(rec.cartBeforeNotes));
      heldCount = 200;
      await step('held-200', async () => { await go('/order-notes'); await page.waitForFunction(() => document.querySelectorAll('.note-card').length === 200); await page.waitForLoadState('networkidle'); });
      await step('held-search', async () => { if (width < 768) await page.locator('.notes-mobile-search-trigger').click(); await page.locator('.notes-search input:visible').first().fill('Ticket 199'); });
      await page.locator('.notes-search input:visible').first().fill('');
      await page.screenshot({ path: path.join(out, `${language}-${width}-${round}-held.png`), fullPage: true });
      await cdp.send('HeapProfiler.collectGarbage'); rec.heapBeforeCycles = { ...await cdp.send('Runtime.getHeapUsage'), ...await cdp.send('Memory.getDOMCounters') };
      rec.cycleHeaps = [];
      for (let cycle = 0; cycle < Number(process.env.AUDIT_CYCLES || 3); cycle++) {
        await go('/pos'); await page.waitForLoadState('networkidle'); await go('/order-notes'); await page.locator('.note-card').first().waitFor(); await page.waitForLoadState('networkidle');
        if (process.env.AUDIT_DIAGNOSTICS) { await cdp.send('HeapProfiler.collectGarbage'); rec.cycleHeaps.push({ cycle: cycle + 1, ...await cdp.send('Runtime.getHeapUsage'), ...await cdp.send('Memory.getDOMCounters') }); }
      }
      await cdp.send('HeapProfiler.collectGarbage'); rec.heapAfterCycles = { ...await cdp.send('Runtime.getHeapUsage'), ...await cdp.send('Memory.getDOMCounters') };
      if (round === 0 && width === 1440 && language === 'en') {
        heldPlan = [{ count: 30, delay: 1200 }, { count: 31, delay: 10 }];
        const firstHeldRead = page.waitForRequest(r => new URL(r.url()).pathname === '/api/pos/held_orders');
        io.emit('held_orders_changed', {}); await firstHeldRead;
        io.emit('held_orders_changed', {});
        await page.waitForTimeout(600); const newerCount = await page.locator('.note-card').count();
        await page.waitForFunction(() => document.querySelectorAll('.note-card').length === 31, null, { timeout: 10000 });
        rec.staleHeldResponse = { newerCount, finalCount: await page.locator('.note-card').count() };
        if (process.env.AUDIT_VERIFY_NOTES) assert.equal(rec.staleHeldResponse.finalCount, 31, 'Final held snapshot must be fresh');
        heldCount = 32; const reconnectStart = serverRequests.length;
        const reconnected = new Promise(resolve => io.once('connection', resolve));
        for (const s of io.sockets.sockets.values()) s.conn.close();
        await reconnected;
        const reconnectStarted = Date.now();
        await page.waitForTimeout(700);
        const heldReadsSince = start => serverRequests.slice(start)
          .filter(request => request.path.startsWith('/api/pos/held_orders'))
          .map(request => ({ path: request.path, started: request.started, finished: request.finished ?? null }));
        rec.notesReconnectCheckpoint = {
          cards: await page.locator('.note-card').count(),
          loading: (await page.locator('.notes-loading').count()) > 0,
          heldReads: heldReadsSince(reconnectStart),
          readPending: heldReadsSince(reconnectStart).some(request => request.finished === null),
          visibility: await page.evaluate(() => document.visibilityState),
        };
        if (process.env.AUDIT_VERIFY_NOTES) await page.waitForFunction(() => document.querySelectorAll('.note-card').length === 32, null, { timeout: 5000 });
        rec.notesReconnectElapsedMs = Date.now() - reconnectStarted;
        rec.notesReconnect = { expectedCount: 32, actualCount: await page.locator('.note-card').count(), requests: serverRequests.slice(reconnectStart) };
        if (process.env.AUDIT_VERIFY_NOTES) assert.equal(rec.notesReconnect.actualCount, 32, 'Reconnect must refresh the held board');
        await go('/pos'); await page.waitForLoadState('networkidle'); latency = 150; heldCount = 30;
        await step('notes-150ms-per-get', async () => { await go('/order-notes'); await page.locator('.note-card').first().waitFor(); }); latency = 0;
        if (process.env.AUDIT_VERIFY_VISIBLE) {
          const reads = rec.steps.at(-1).requests;
          assert.equal(reads.filter(r => r.path.startsWith('/api/pos/order_notes')).length, 0, 'Hidden history must not load');
          // The board reuses the terminal settings already loaded on /pos (no own settings read).
          assert.equal(reads.filter(r => r.path === '/api/system/settings').length, 0, 'Held board must reuse the terminal settings');
          const ownReads = reads.filter(r => ['/api/pos/order_types', '/api/pos/held_orders'].includes(r.path));
          assert.equal(ownReads.length, 2);
          assert.ok(Math.max(...ownReads.map(r => r.started)) < Math.min(...ownReads.map(r => r.finished)), 'Metadata and visible list must overlap');
        }
        await go('/pos'); await page.waitForLoadState('networkidle'); historyFailure = true;
        await step('notes-history-http500', async () => { await go('/order-notes'); await page.locator('.note-card').first().waitFor(); await page.waitForLoadState('networkidle'); });
        if (process.env.AUDIT_VERIFY_VISIBLE) {
          assert.equal(await page.locator('.notes-load-error').count(), 0, 'Hidden History failures must not affect held tickets');
          await page.locator('.notes-mode button').last().click();
          await page.locator('.notes-load-error').waitFor();
          assert.equal(await page.locator('.notes-empty').count(), 0, 'Failed History is not an empty list');
          historyFailure = false;
          await page.locator('.notes-load-error button').click();
          await page.waitForFunction(() => document.querySelectorAll('.note-card').length === 200);
          assert.equal(await page.locator('.notes-load-error').count(), 0);
        }
        rec.historyFailure = { alert: await page.locator('.notes-load-error').count(), cards: await page.locator('.note-card').count() }; historyFailure = false;
        if (process.env.AUDIT_DIAGNOSTICS) {
          await go('/pos'); heldFailure = true;
          const heldFailureResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/pos/held_orders' && r.status() === 500);
          await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/order-notes'));
          await heldFailureResponse; await page.locator('.order-notes-page').waitFor(); await page.locator('.notes-loading').waitFor({ state: 'detached' }); await page.waitForLoadState('networkidle');
          rec.heldHttpFailure = { alert: await page.locator('.notes-load-error').count(), cards: await page.locator('.note-card').count(), text: await page.locator('.order-notes-page').innerText() }; heldFailure = false;
          if (process.env.AUDIT_VERIFY_NOTES) {
            assert.equal(rec.heldHttpFailure.alert, 1, 'Failed held read must show Retry');
            assert.equal(await page.locator('.notes-empty').count(), 0, 'Failure is not an empty board');
            await page.locator('.notes-load-error button').click();
            await page.locator('.note-card').first().waitFor();
            assert.equal(await page.locator('.notes-load-error').count(), 0, 'Successful Retry clears the error');
          }
          await go('/pos'); latency = 300;
          await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/order-notes'));
          await page.locator('.order-notes-page').waitFor();
          await go('/pos'); await page.waitForTimeout(1600); latency = 0;
          const inactiveStart = serverRequests.length;
          io.emit('held_orders_changed', {}); await page.waitForTimeout(800);
          rec.notesLateMount = { currentPath: new URL(page.url()).pathname, requests: serverRequests.slice(inactiveStart) };
          if (process.env.AUDIT_VERIFY_NOTES) assert.equal(rec.notesLateMount.requests.filter(r => /^\/api\/pos\/(order_notes|held_orders)(\?|$)/.test(r.path)).length, 0, 'Disposed board must not make requests');
        }
      }
      }
      if (process.env.AUDIT_VERIFY_TIMEOUTS && !process.env.AUDIT_ORDERS_ONLY) {
        stalledReadPath = '/api/pos/get_tables';
        await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/tables'));
        await page.waitForURL(origin + '/tables');
        await page.waitForFunction(() => {
          const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
          return !stores.get('orderSession').isTableWorkspaceLoading && !!stores.get('orderUi').tableActionError;
        }, null, { timeout: 19000 });
        stalledReadPath = null;
        await page.evaluate(() => window.dispatchEvent(new Event('socket_reconnected')));
        await page.waitForFunction(() => {
          const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
          return !stores.get('orderSession').isTableWorkspaceLoading && !stores.get('orderUi').tableActionError;
        });
        rec.floorBodyTimeoutRecovered = true;
        await go('/pos');
        stalledReadPath = '/api/pos/held_orders';
        await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/order-notes'));
        await page.locator('.notes-load-error').waitFor({ timeout: 19000 });
        assert.equal(await page.locator('.notes-empty').count(), 0);
        stalledReadPath = null;
        await page.locator('.notes-load-error button').click();
        await page.locator('.note-card').first().waitFor();
        rec.heldBodyTimeoutRecovered = true;
        stalledReadPath = '/api/pos/table_splits';
        await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/table-splits'));
        await page.waitForURL(origin + '/table-splits');
        await page.getByText('Split checks could not be loaded', { exact: true }).waitFor({ timeout: 19000 });
        stalledReadPath = null;
        await page.locator('header button').filter({ has: page.locator('.fa-rotate') }).click();
        await page.getByText('No Unpaid Splits!', { exact: true }).waitFor();
        rec.splitsBodyTimeoutRecovered = true;
      }
      await step('admin-orders-cold', async () => { await page.goto(origin + '/admin/orders'); await page.locator('.orders-workspace').waitFor(); await page.waitForLoadState('networkidle'); }, true);
      if (process.env.AUDIT_VERIFY_I18N_TRANSITIONS === '1') {
        await page.evaluate(() => {
          const probe = document.createElement('span');
          probe.id = 'i18n-admin-probe';
          probe.textContent = 'Orders';
          probe.title = 'Orders';
          document.querySelector('#admin-app').append(probe);
        });
        const setAdminLanguage = next => page.evaluate(language => document.querySelector('#admin-app').__vue_app__.config.globalProperties.$setLanguage(language), next);
        await setAdminLanguage('ar');
        await page.waitForFunction(() => document.documentElement.dir === 'rtl'
          && document.querySelector('#i18n-admin-probe')?.textContent === 'الطلبات'
          && document.querySelector('#i18n-admin-probe')?.title === 'الطلبات');
        await setAdminLanguage('en');
        await page.waitForFunction(() => document.documentElement.dir === 'ltr'
          && document.querySelector('#i18n-admin-probe')?.textContent === 'Orders'
          && document.querySelector('#i18n-admin-probe')?.title === 'Orders');
        await setAdminLanguage(language);
        await page.waitForFunction(expected => document.documentElement.dir === (expected === 'ar' ? 'rtl' : 'ltr'), language);
        await page.evaluate(() => document.querySelector('#i18n-admin-probe').remove());
        rec.i18nTransitions ??= {};
        rec.i18nTransitions.admin = true;
      }
      const adminErrorStart = rec.errors.length;
      if (process.env.AUDIT_VERIFY_TIMEOUTS) {
        stalledReadPath = '/api/admin/order_details';
        await page.locator(width >= 1024 ? '.orders-workspace tbody tr' : '.orders-workspace .admin-grid-mobile-card').first().click();
        await page.getByRole('dialog').getByRole('alert').waitFor({ timeout: 19000 });
        assert.equal(await page.getByRole('dialog').locator('aside').count(), 0);
        stalledReadPath = null;
        await page.getByRole('dialog').getByRole('alert').getByRole('button').click();
        await page.getByRole('dialog').locator('aside').waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        rec.ordersBodyTimeoutRecovered = true;
      }
      if (process.env.AUDIT_VERIFY_ORDERS) {
        const row = page.locator(width >= 1024 ? '.orders-workspace tbody tr' : '.orders-workspace .admin-grid-mobile-card').first();
        latency = 700;
        await row.click();
        const dialog = page.getByRole('dialog');
        await dialog.locator('[aria-live="polite"]').waitFor();
        assert.equal(await dialog.locator('aside').count(), 0, 'No totals/actions before details arrive');
        await dialog.locator('header button').click();
        await dialog.waitFor({ state: 'detached' });
        await page.waitForTimeout(750);
        assert.equal(await dialog.count(), 0, 'Late result must not reopen details');
        latency = 0;
        await page.route('**/api/admin/order_details?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Layout validation failed' }) }));
        await row.click();
        await dialog.getByRole('alert').waitFor();
        assert.equal(await dialog.locator('aside').count(), 0, 'No invoice actions after failed load');
        await page.unroute('**/api/admin/order_details?*');
        await dialog.getByRole('alert').getByRole('button').click();
        await dialog.locator('aside').waitFor();
        assert.equal(await dialog.getByRole('alert').count(), 0, 'Retry clears the failure');
        await page.screenshot({ path: path.join(out, `${language}-${width}-${round}-order-details.png`) });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        rec.ordersDetailAcceptance = { loading: true, closeDuringRead: true, failedLoad: true, retry: true };
      }
      await step('admin-orders-detail', async () => { await page.locator(width >= 1024 ? '.orders-workspace tbody tr' : '.orders-workspace .admin-grid-mobile-card').first().click(); await page.waitForLoadState('networkidle'); });
      await page.keyboard.press('Escape');
      await step('admin-orders-date-page-realtime', async () => {
        await page.locator('.orders-workspace input[type="date"]').first().fill('2026-09-09');
        await page.waitForLoadState('networkidle');
        await page.locator('.orders-workspace button').filter({ has: page.locator(language === 'ar' ? '.fa-chevron-left' : '.fa-chevron-right') }).last().click();
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('admin:realtime', { detail: { type: 'socket_reconnected' } })));
        await page.waitForLoadState('networkidle');
      });
      rec.adminInteractionErrors = rec.errors.slice(adminErrorStart);
      if (process.env.AUDIT_VERIFY_ORDERS) assert.deepEqual(rec.adminInteractionErrors, [], 'Orders interactions must not throw');
      rec.ordersButtons = await page.locator('.orders-workspace button').evaluateAll(es => es.filter(e => e.getClientRects().length).map(e => ({ text: e.textContent.trim(), aria: e.getAttribute('aria-label'), title: e.title })));
      await page.screenshot({ path: path.join(out, `${language}-${width}-${round}-orders.png`), fullPage: true });
      if (process.env.AUDIT_VERIFY_I18N_ENTRYPOINTS === '1') {
        await page.route('**/public_menu.json', route => route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, store: { name: 'Audit fixture', admin_language: language }, categories: [], products: [] })
        }));
        for (const [entry, selector] of [['/menu.html', '#menu-app'], ['/print_receipt.html', '#printApp']]) {
          await page.goto(origin + entry);
          await page.waitForFunction(root => Boolean(document.querySelector(root)?.__vue_app__), selector);
          await page.evaluate(root => {
            const probe = document.createElement('span');
            probe.id = 'i18n-entrypoint-probe';
            probe.textContent = 'Orders';
            document.querySelector(root).append(probe);
          }, selector);
          const setEntryLanguage = next => page.evaluate(({ root, language: nextLanguage }) =>
            document.querySelector(root).__vue_app__.config.globalProperties.$setLanguage(nextLanguage), { root: selector, language: next });
          await setEntryLanguage('ar');
          await page.waitForFunction(() => document.documentElement.dir === 'rtl'
            && document.querySelector('#i18n-entrypoint-probe')?.textContent === 'الطلبات');
          await setEntryLanguage('en');
          await page.waitForFunction(() => document.documentElement.dir === 'ltr'
            && document.querySelector('#i18n-entrypoint-probe')?.textContent === 'Orders');
          rec.i18nTransitions ??= {};
          rec.i18nTransitions[entry === '/menu.html' ? 'menu' : 'receipt'] = true;
        }
      }
      await context.close();
      fs.writeFileSync(path.join(out, `results-cpu${cpu}.json`), JSON.stringify(result, null, 2));
    }
    assert.equal(unknown.length, 0, `Unmapped endpoints: ${unknown.join(', ')}`);
    assert.equal(rejectedWrites.length, 0, 'Unexpected write attempted');
  } finally { await browser.close(); await new Promise(r => io.close(r)); server.close(); fs.writeFileSync(path.join(out, `results-cpu${cpu}.json`), JSON.stringify(result, null, 2)); }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
