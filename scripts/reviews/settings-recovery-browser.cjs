/* Review only: the production POS build against loopback synthetic reads and a
   real Socket.IO server. No application DB, server, printer or customer data.
   Checks that the terminal recovers by itself from failed settings reads and
   from a socket connection the server refuses while it restarts. Build first. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
const { Server } = require('socket.io');

const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'scratch', 'settings-recovery-browser');
fs.mkdirSync(out, { recursive: true });

let lang = 'en';
let settingsPlan = []; // one entry per settings read: 'fail' or 'session'
let settingsDown = false;
let refuseSockets = 0;
const reads = [], refusals = [], connections = [], writes = [];
const settings = () => ({ success: true, admin_language: lang, store_name: 'Recovery fixture', tables_enabled: '0', stock_enabled: '0', barcode_enabled: '0', tax_inclusive_pricing: '0', print_method: 'browser', service_charge_enabled: '0', quick_numpad_mode: '0' });
const categories = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, name: `Category ${i + 1}`, parent_id: null }));
const products = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}`, price: 3, tax_rate: 0, category_id: 1 + (i % 4), is_active: 1, is_available: 1, can_sell: 1, stock: null, is_custom: false }));
function fixture(u) {
  const p = u.pathname;
  if (p === '/api/config/business') return { success: true, business_sql_offset: '+03:00', business_day_start_hour: 6 };
  if (p === '/api/auth/me') return { success: true, user: { id: 1, role: 'admin', name: 'Recovery' } };
  if (p === '/api/system/public_preferences') return { success: true };
  if (p === '/api/auth/shifts') return { success: true, data: { id: 1, user_id: 1, status: 'open', opening_cash: 0 } };
  if (p === '/api/pos/order_types') return { success: true, data: [{ id: 1, name: 'Takeaway', is_active: 1 }] };
  if (p === '/api/pos/products') {
    const cat = Number(u.searchParams.get('category_id') || 1);
    const rows = products.filter(item => item.category_id === cat);
    return { success: true, selected_category_id: cat, products: rows, categories_included: !u.searchParams.has('lightweight'), categories: u.searchParams.has('lightweight') ? undefined : categories, settings: settings(), pagination: { total: rows.length, offset: 0, limit: 120 } };
  }
  if (p === '/api/pos/held_orders/summary') return { success: true, active_register_count: 0 };
  if (p === '/api/admin/printers') return { success: true, data: [] };
  return { success: false, message: `Unmapped review endpoint ${p}` };
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET') { writes.push(`${req.method} ${u.pathname}`); res.writeHead(405); return res.end(); }
  if (u.pathname === '/api/system/settings') {
    const mode = settingsPlan.shift() || (settingsDown ? 'fail' : 'ok');
    reads.push({ at: Date.now(), mode });
    if (mode === 'fail') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"success":false,"message":"Synthetic failure"}'); }
    if (mode === 'session') {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
      return res.end('{"success":false,"code":"SESSION_CHECK_UNAVAILABLE"}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(settings()));
  }
  if (u.pathname.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(fixture(u))); }
  const asset = u.pathname === '/' || !path.extname(u.pathname) ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
  const file = [path.resolve(root, 'dist', asset), path.resolve(root, asset)].find(f => (f.startsWith(path.join(root, 'dist') + path.sep) || f.startsWith(path.join(root, 'assets') + path.sep)) && fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
  res.end(zlib.gzipSync(fs.readFileSync(file)));
});
// Production heartbeats every 25 s; 2 s keeps the heartbeat-driven cases short.
const io = new Server(server, { transports: ['websocket', 'polling'], pingInterval: 2000, pingTimeout: 5000 });
let heartbeats = 0;
io.on('connection', socket => socket.conn.on('packetCreate', packet => { if (packet.type === 'ping') heartbeats += 1; }));
io.use((socket, next) => {
  if (refuseSockets > 0) { refuseSockets -= 1; refusals.push(Date.now()); return next(new Error('Server is starting.')); }
  return next();
});
io.on('connection', () => connections.push(Date.now()));

const waitFor = async (what, done, ms) => {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
};

async function run() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const result = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), chromium: browser.version(), cases: [] };
  try {
    for (const [language, width, height] of [['en', 1440, 900], ['ar', 390, 844]]) {
      lang = language; settingsPlan = []; settingsDown = false; refuseSockets = 0;
      const notice = language === 'ar' ? 'تعذّر تحديث الإعدادات' : 'Settings could not be refreshed';
      const context = await browser.newContext({ viewport: { width, height }, locale: language === 'ar' ? 'ar-JO' : 'en-US' });
      await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
      await context.addInitScript(({ language, notice }) => {
        localStorage.setItem('pos_admin_language', language);
        sessionStorage.setItem('pos_user', JSON.stringify({ id: 1, role: 'admin', name: 'Recovery' }));
        sessionStorage.setItem('pos_user_at', String(Date.now()));
        window.__notice = [];
        let shown = false;
        new MutationObserver(() => {
          const now = [...document.querySelectorAll('[role="alert"]')].some(el => el.textContent.includes(notice));
          if (now !== shown) { shown = now; window.__notice.push({ shown, at: Date.now() }); }
        }).observe(document, { childList: true, subtree: true, characterData: true });
      }, { language, notice });
      const page = await context.newPage();
      const rec = { language, width, errors: [], scenarios: {} };
      result.cases.push(rec);
      page.on('pageerror', e => rec.errors.push(e.message));
      const connectionsBefore = connections.length;
      await page.goto(origin + '/pos');
      await page.locator('.product-stage').waitFor();
      await waitFor('the first socket connection', () => connections.length > connectionsBefore, 10000);
      await page.waitForTimeout(500);
      const noticeLog = () => page.evaluate(() => window.__notice);
      const clearNoticeLog = () => page.evaluate(() => { window.__notice = []; });

      const only = process.env.SETTINGS_RECOVERY_ONLY; // e.g. "restart" to compare one scenario across builds
      if (!only || only === 'quiet') {
      // 0. A healthy terminal sends no settings request, whatever the heartbeat.
      const start = reads.length, beats = heartbeats;
      await page.waitForTimeout(10000);
      rec.scenarios.quiet = { heartbeats: heartbeats - beats, settingsReads: reads.length - start };
      assert.ok(rec.scenarios.quiet.heartbeats >= 4, 'quiet: the server heartbeat did not run');
      assert.equal(rec.scenarios.quiet.settingsReads, 0, 'quiet: a healthy terminal polled settings');
      }
      if (!only || only === 'blip') {
      // 1. A blip the first automatic retry recovers is never shown.
      await clearNoticeLog();
      const start = reads.length, at = Date.now();
      settingsPlan = ['fail']; // Chrome silently retries a GET reset on a reused connection
      io.emit('settings_changed', { keys: ['store_name'] });
      await waitFor('the automatic retry', () => reads.length >= start + 2, 6000);
      await page.waitForTimeout(500);
      const blip = reads.slice(start);
      rec.scenarios.blip = { reads: blip.map(r => ({ mode: r.mode, afterMs: r.at - at })), notice: await noticeLog() };
      assert.deepEqual(blip.map(r => r.mode), ['fail', 'ok'], 'blip: one failed read, then one recovered read');
      assert.ok(blip[1].at - blip[0].at >= 1900, 'blip: the retry waited its backoff');
      assert.deepEqual(rec.scenarios.blip.notice, [], 'blip: the notice was shown for a recovered blip');

      }
      if (!only || only === 'outage') {
      // 2. A persistent outage shows the notice, which clears by itself on recovery.
      await clearNoticeLog();
      const start = reads.length, at = Date.now();
      settingsDown = true;
      io.emit('settings_changed', { keys: ['store_name'] });
      await page.locator('[role="alert"]', { hasText: notice }).waitFor({ timeout: 8000 });
      const shownAfter = Date.now() - at;
      settingsDown = false;
      await page.locator('[role="alert"]', { hasText: notice }).waitFor({ state: 'detached', timeout: 12000 });
      rec.scenarios.outage = { shownAfterMs: shownAfter, clearedAfterRecoveryMs: Date.now() - at - shownAfter, reads: reads.slice(start).map(r => r.mode) };
      assert.equal(reads.slice(start).at(-1).mode, 'ok', 'outage: recovered without Retry');

      }
      if (!only || only === 'long') {
      // 2b. A long outage: three quick retries, then the heartbeat brings it back.
      const start = reads.length;
      settingsDown = true;
      io.emit('settings_changed', { keys: ['store_name'] });
      await waitFor('the three quick retries', () => reads.length >= start + 4, 25000);
      const lastQuick = reads.at(-1).at;
      settingsDown = false;
      const recoveredAt = Date.now();
      await page.locator('[role="alert"]', { hasText: notice }).waitFor({ state: 'detached', timeout: 6000 });
      const quick = reads.slice(start, start + 4);
      rec.scenarios.longOutage = {
        quickRetryGapsMs: quick.slice(1).map((r, i) => r.at - quick[i].at),
        recoveredByHeartbeatMs: Date.now() - recoveredAt,
        readsAfterQuickRetries: reads.slice(start + 4).map(r => ({ mode: r.mode, afterLastQuickMs: r.at - lastQuick })),
      };
      assert.equal(reads.at(-1).mode, 'ok', 'long outage: did not recover');
      }
      if (!only || only === 'session') {
      // 3. A failed session check (503) is not a logout.
      const start = reads.length;
      settingsPlan = ['session', 'session'];
      io.emit('settings_changed', { keys: ['store_name'] });
      await waitFor('recovery after the session-check failures', () => reads.slice(start).some(r => r.mode === 'ok'), 12000);
      await page.waitForTimeout(300);
      rec.scenarios.sessionCheck = { url: new URL(page.url()).pathname, stillSignedIn: await page.evaluate(() => !!sessionStorage.getItem('pos_user')), reads: reads.slice(start).map(r => r.mode) };
      assert.equal(rec.scenarios.sessionCheck.url, '/pos', 'session check: the cashier was sent away from the POS');
      assert.ok(rec.scenarios.sessionCheck.stillSignedIn, 'session check: the cashier was signed out');

      }
      if (!only || only === 'restart') {
      // 4. A restart that refuses the first reconnects: realtime returns by itself.
      const conns = connections.length, refused = refusals.length;
      const start = reads.length;
      refuseSockets = 2;
      const restartedAt = Date.now();
      for (const socket of io.of('/').sockets.values()) socket.conn.close(); // transport close, as in a restart
      await waitFor('the socket to reconnect after two refusals', () => connections.length > conns, 20000);
      const reconnectedAfter = Date.now() - restartedAt;
      await waitFor('the recovery refresh after reconnecting', () => reads.slice(start).some(r => r.at >= connections.at(-1)), 5000);
      const beforeEvent = reads.length;
      io.emit('settings_changed', { keys: ['store_name'] });
      await waitFor('a realtime event over the recovered socket', () => reads.length > beforeEvent, 5000);
      rec.scenarios.restart = { refusals: refusals.length - refused, reconnectedAfterMs: reconnectedAfter };
      assert.equal(rec.scenarios.restart.refusals, 2, 'restart: the server refused two handshakes');
      }

      await page.screenshot({ path: path.join(out, `${language}-${width}.png`) });
      assert.deepEqual(rec.errors, [], 'page errors');
      await context.close();
    }
    assert.deepEqual(writes, [], 'the review must not write');
    result.passed = true;
  } finally {
    await browser.close();
    io.close();
    server.close();
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result.cases.map(c => ({ language: c.language, width: c.width, ...c.scenarios })), null, 2));
}

run().catch(error => { console.error(error); process.exitCode = 1; });
