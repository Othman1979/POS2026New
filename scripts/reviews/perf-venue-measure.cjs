/*
 * Frontend runtime measurement (derived from scripts/reviews/pos-frontend-audit.cjs, which is left untouched).
 * Synthetic loopback fixture server + Chromium + CPU throttle + CDP network emulation ("venue Wi-Fi").
 *
 *   node scripts/reviews/perf-venue-measure.cjs --dist scratch/perf-hunt/dist-baseline --label baseline-br \
 *        [--compress none|gzip|br] [--net venue|none] [--cpu 4] [--runs 3] [--langs en,ar] \
 *        [--only cold,warm,interact,cart,tables,heap,admin,menu] [--profile] [--headed]
 *
 * Output: scratch/perf-hunt/results-<label>.json (ignored) (raw per run + medians) and a printed summary.
 * Read-only: no application DB, no real server. Every non-loopback request is aborted.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const os = require('node:os');
const { chromium } = require('@playwright/test');
const { Server } = require('socket.io');

const root = path.resolve(__dirname, '../..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); if (i < 0) return def; const v = argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; };
const dist = path.resolve(root, arg('dist', 'scratch/perf-hunt/dist-baseline'));
const label = String(arg('label', 'baseline'));
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid label');
const compress = String(arg('compress', 'br'));
const netMode = String(arg('net', 'venue'));
const cpu = Number(arg('cpu', 4));
const runs = Number(arg('runs', 3));
const langs = String(arg('langs', 'en,ar')).split(',');
const only = new Set(String(arg('only', 'cold,warm,interact,cart,tables,heap,admin')).split(','));
const wantProfile = Boolean(arg('profile', false));
const NET = { latency: 150, downloadThroughput: Math.round(1.6e6 / 8), uploadThroughput: Math.round(750e3 / 8) };
const outDir = path.join(root, 'scratch', 'perf-hunt');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `results-${label}.json`);

// ---------------------------------------------------------------- fixtures (same shapes as the audit script)
let lang = 'en';
const unknown = new Set();
const settings = () => ({ success: true, admin_language: lang, store_name: 'Audit fixture', tables_enabled: '1', table_mode: 'fixed', stock_enabled: '0', barcode_enabled: '0', tax_inclusive_pricing: '0', print_method: 'browser', service_charge_enabled: '0', quick_numpad_mode: '0' });
const types = [{ id: 1, name: 'Takeaway', is_active: 1 }, { id: 2, name: 'Delivery', is_active: 1 }, { id: 3, name: 'Pickup', is_active: 1 }];
const categories = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Category ${i + 1}`, parent_id: null }));
const products = Array.from({ length: 1440 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}`, price: 3, tax_rate: 0, category_id: 1 + Math.floor(i / 120), is_active: 1, is_available: 1, can_sell: 1, stock: null, is_custom: false }));
const tables = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, table_number: String(i + 1), section_id: 1, section_name: 'Main', status: i % 3 ? 'occupied' : 'available', current_order_id: i % 3 ? i + 100 : null, active_order_created_at: '2026-09-10 09:00:00', active_order_total: 30, active_order_waiter_name: 'Fixture', x: (i % 10) * 145, y: Math.floor(i / 10) * 145, width: 120, height: 120, shape: 'square' }));
const dashboard = () => ({
  success: true, business_date: '2026-09-29', as_of: '2026-09-29T14:00:00.000Z', refreshed_at: '2026-09-29T14:00:00.000Z',
  history: { eligible_days: 30, comparison_ready: true },
  headline: { sales_today: 1840.5, orders: 96, average_check: 19.17, estimated_close: 3100, expenses_today: 220, remaining_after_expenses: 1620.5 },
  comparison: { typical: { sales_today: 1600, orders: 88, average_check: 18.1 }, delta: { sales_today: { amount: 240.5, percent: 15 }, orders: { amount: 8, percent: 9 }, average_check: { amount: 1.07, percent: 5.9 } }, pace_state: 'ahead', driver: 'orders' },
  pace: { points: Array.from({ length: 96 }, (_, i) => ({ elapsed_minute: i * 15, today: i * 19, typical: i * 17 })) },
  tables: { occupied_count: 27, open_unpaid_value: 810, longest_open: { invoice_id: 5, table_number: '12', opened_at: '2026-09-29T12:00:00.000Z', elapsed_minutes: 120 } },
  attention: [], products: Array.from({ length: 8 }, (_, i) => ({ product_id: i + 1, name: `Product ${i + 1}`, net_sales: 300 - i * 20, net_units: 50 - i * 3, delta_percent: 5 })),
  payments: [{ method: 'cash', amount: 1100, share: 0.6 }, { method: 'card', amount: 740.5, share: 0.4 }],
});
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
    const rows = products.filter(x => (!cat || x.category_id === Number(cat)) && (!query || x.name.toLowerCase().includes(query.toLowerCase())));
    const offset = Number(u.searchParams.get('offset') || 0), limit = Number(u.searchParams.get('limit') || 120);
    return { success: true, catalog_generation: 'gen-1', selected_category_id: cat ? Number(cat) : null, products: rows.slice(offset, offset + limit), categories_included: !u.searchParams.has('lightweight'), categories: u.searchParams.has('lightweight') ? undefined : categories, settings: settings(), pagination: { total: rows.length, offset, limit } };
  }
  if (p === '/api/pos/get_tables') return { success: true, settings: settings(), sections: [{ id: 1, name: 'Main' }], tables };
  if (p === '/api/pos/table_splits') return { success: true, data: [] };
  if (p === '/api/pos/held_orders/summary') return { success: true, active_register_count: 0 };
  if (p === '/api/pos/held_orders') return { success: true, data: [] };
  if (p === '/api/admin/printers') return { success: true, data: [] };
  if (p === '/api/admin/dashboard') return dashboard();
  if (p === '/api/admin/alerts') return { success: true, lowStockItems: [] };
  if (p === '/api/admin/shifts') return { success: true, cashiers: [] };
  unknown.add(p); return { success: true, data: [], items: [], orders: [] };
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const encCache = new Map();
function encoded(file, kind) {
  const key = kind + '|' + file; if (encCache.has(key)) return encCache.get(key);
  const raw = fs.readFileSync(file); let body = raw;
  const compressible = /\.(js|css|html|json|svg)$/.test(file);
  if (compressible && kind === 'gzip') body = zlib.gzipSync(raw, { level: 9 });
  if (compressible && kind === 'br') body = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
  const r = { body, encoding: compressible && kind !== 'none' ? (kind === 'br' ? 'br' : 'gzip') : null }; encCache.set(key, r); return r;
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && u.pathname === '/api/pos/category-prices/resolve') {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const data = products.filter(x => (payload.product_ids || []).includes(x.id)).map(x => ({ ...x, product_id: x.id, price_override_locked: 0 }));
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, products: data }));
    }); return;
  }
  if (u.pathname === '/public_menu.json') {
    const menuCats = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `Category ${i + 1}`, parent_id: null }));
    const menuProducts = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}`, description: '', price: 3, category_id: 1 + (i % 8), image: null, is_available: 1, can_sell: 1 }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); return res.end(JSON.stringify({ success: true, store: { store_name: 'Audit fixture', admin_language: lang }, categories: menuCats, products: menuProducts }));
  }
  if (u.pathname === '/api/pos/table-draft/1') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-cache' }); return res.end(JSON.stringify({ success: true, cart: [{ product_id: 1, qty: 2, price: 3, name: 'Product 1' }, { product_id: 2, qty: 1, price: 3, name: 'Product 2' }] }));
  }
  if (u.pathname.startsWith('/api/')) {
    let body = Buffer.from(JSON.stringify(fixture(u))); const h = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-cache' };
    // API follows the same compression mode as static files (whatever layer compresses one compresses the other)
    if (compress === 'gzip' && body.length > 512) { body = zlib.gzipSync(body); h['Content-Encoding'] = 'gzip'; }
    if (compress === 'br' && body.length > 512) { body = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }); h['Content-Encoding'] = 'br'; }
    res.writeHead(200, h); return res.end(body);
  }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  const asset = u.pathname === '/' || !path.extname(u.pathname) ? (u.pathname.startsWith('/admin') ? 'admin.html' : u.pathname === '/menu' ? 'menu.html' : 'index.html') : decodeURIComponent(u.pathname.slice(1));
  const file = path.resolve(dist, asset);
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  const { body, encoding } = encoded(file, compress);
  const hashed = /\/(chunks|assets)\//.test('/' + asset) || /-[A-Za-z0-9_-]{8}\.js$/.test(asset);
  const headers = { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Length': body.length, 'Vary': 'Accept-Encoding', 'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' };
  if (encoding) headers['Content-Encoding'] = encoding;
  res.writeHead(200, headers); res.end(body);
});
const io = new Server(server, { transports: ['websocket', 'polling'] });
io.on('connection', sock => sock.on('catalog_generation', ack => { if (typeof ack === 'function') ack('gen-1'); }));

// ---------------------------------------------------------------- in-page instrumentation
const initScript = ({ language, readySel }) => {
  localStorage.setItem('pos_admin_language', language);
  sessionStorage.setItem('pos_user', JSON.stringify({ id: 1, role: 'admin', name: 'Audit' }));
  sessionStorage.setItem('pos_user_at', String(Date.now()));
  const m = window.__m = { long: [], loaf: [], events: [], fcp: null, lcp: null, ready: null, readyPainted: null, frames: null };
  const obs = (type, cb, extra = {}) => { try { new PerformanceObserver(l => l.getEntries().forEach(cb)).observe({ type, buffered: true, ...extra }); } catch (e) { /* unsupported */ } };
  obs('longtask', e => m.long.push({ start: e.startTime, duration: e.duration }));
  obs('long-animation-frame', e => m.loaf.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration, renderStart: e.renderStart, styleAndLayoutStart: e.styleAndLayoutStart, scripts: (e.scripts || []).map(s => ({ url: s.sourceURL, fn: s.sourceFunctionName, invoker: s.invoker, type: s.invokerType, duration: s.duration, forced: s.forcedStyleAndLayoutDuration })) }));
  obs('event', e => m.events.push({ name: e.name, start: e.startTime, duration: e.duration, delay: e.processingStart - e.startTime, processing: e.processingEnd - e.processingStart, id: e.interactionId }), { durationThreshold: 16 });
  obs('paint', e => { if (e.name === 'first-contentful-paint') m.fcp = e.startTime; });
  obs('largest-contentful-paint', e => { m.lcp = e.startTime; });
  if (readySel) {
    const check = () => { if (m.ready === null && document.querySelector(readySel)) { m.ready = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => { m.readyPainted = performance.now(); })); mo.disconnect(); } };
    const mo = new MutationObserver(check);
    const start = () => { mo.observe(document.documentElement, { childList: true, subtree: true }); check(); };
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  }
  // Frame sampler: only runs while a scenario asks for it (a standing rAF loop would perturb the page).
  let sampling = false, last = 0, gaps = [];
  const tick = t => { if (!sampling) return; if (last) gaps.push(t - last); last = t; requestAnimationFrame(tick); };
  window.__frames = {
    start() { gaps = []; last = 0; sampling = true; requestAnimationFrame(tick); },
    stop() { sampling = false; const g = gaps.slice(1); gaps = []; return g; },
  };
  // input timestamp of the most recent real pointerdown (hardware-ish timestamp, before any app handler)
  window.__t0 = null;
  addEventListener('pointerdown', e => { window.__t0 = e.timeStamp; }, true);
  window.__waitPaint = (cond, timeout = 20000) => new Promise((resolve, reject) => {
    const t = performance.now();
    const step = () => {
      let ok = false; try { ok = cond(); } catch (e) { ok = false; }
      if (ok) requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
      else if (performance.now() - t > timeout) reject(new Error('waitPaint timeout'));
      else requestAnimationFrame(step);
    };
    step();
  });
};

// ---------------------------------------------------------------- helpers
const median = a => { const s = a.filter(x => Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const r1 = x => x == null ? null : Math.round(x * 10) / 10;
function frameStats(gaps) {
  const dropped = gaps.reduce((s, g) => s + (g > 25 ? Math.round(g / 16.667) - 1 : 0), 0);
  return { frames: gaps.length, droppedFrames: dropped, over33ms: gaps.filter(g => g > 33).length, over50ms: gaps.filter(g => g > 50).length, maxGapMs: r1(Math.max(0, ...gaps)), p95GapMs: r1(pct(gaps, 0.95)) };
}
function taskStats(long, from = 0, to = Infinity) {
  const l = long.filter(e => e.start >= from && e.start < to);
  return { longTasks: l.length, longTaskMs: r1(l.reduce((s, e) => s + e.duration, 0)), longTaskMaxMs: r1(Math.max(0, ...l.map(e => e.duration))) };
}
function ttiApprox(long, fcp, quietMs = 2000) {
  let c = fcp || 0; for (const t of long.slice().sort((a, b) => a.start - b.start)) { if (t.start - c >= quietMs) break; c = Math.max(c, t.start + t.duration); } return c;
}
function attribution(loaf, from = 0, to = Infinity, top = 8) {
  const by = new Map(); let n = 0;
  for (const f of loaf.filter(e => e.start >= from && e.start < to)) for (const s of f.scripts) {
    n++; const key = (s.url || '(none)').replace(/^https?:\/\/[^/]+/, '') + ' ' + (s.fn || s.invoker || '');
    const v = by.get(key) || { key, ms: 0, forced: 0, n: 0 }; v.ms += s.duration; v.forced += s.forced || 0; v.n++; by.set(key, v);
  }
  return { byScript: [...by.values()].sort((a, b) => b.ms - a.ms).slice(0, top).map(v => ({ ...v, ms: r1(v.ms), forced: r1(v.forced) })),
    topFrames: loaf.filter(e => e.start >= from && e.start < to).sort((a, b) => b.duration - a.duration).slice(0, 3).map(e => ({ start: r1(e.start), duration: r1(e.duration), blocking: r1(e.blocking), styleLayoutMs: r1(e.start + e.duration - e.styleAndLayoutStart), scriptTopUrl: e.scripts.sort((a, b) => b.duration - a.duration)[0]?.url?.replace(/^https?:\/\/[^/]+/, '') })) };
}
const perfMetrics = async cdp => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

function profileTop(profile, top = 12) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n])); const self = new Map();
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + (profile.timeDeltas[i] || 0)));
  const byUrl = new Map(), byFn = new Map(); let total = 0;
  for (const [id, us] of self) {
    const n = nodes.get(id); const cf = n.callFrame; const url = (cf.url || '(native)').replace(/^https?:\/\/[^/]+/, '') || cf.functionName;
    if (cf.functionName === '(idle)') continue; total += us;
    byUrl.set(url, (byUrl.get(url) || 0) + us);
    const k = `${cf.functionName || '(anon)'} ${url}:${cf.lineNumber}`; byFn.set(k, (byFn.get(k) || 0) + us);
  }
  const fmt = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => ({ k, ms: r1(v / 1000) }));
  return { totalCpuMs: r1(total / 1000), byUrl: fmt(byUrl), byFunction: fmt(byFn) };
}

// ---------------------------------------------------------------- host contention probe (machine is shared with other agents)
const cpuTimes = () => os.cpus().reduce((a, c) => { for (const k in c.times) a.total += c.times[k]; a.idle += c.times.idle; return a; }, { total: 0, idle: 0 });
const busyPct = (a, b) => r1(100 * (1 - (b.idle - a.idle) / Math.max(1, b.total - a.total)));
function spin() { const t = process.hrtime.bigint(); let x = 0; for (let i = 0; i < 3e7; i++) x += Math.sqrt(i); return Number(process.hrtime.bigint() - t) / 1e6 + (x < 0 ? 1 : 0); }

// ---------------------------------------------------------------- one run
async function newPage(browser, origin, language, readySel, { throttleNet }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language === 'ar' ? 'ar-JO' : 'en-US', ignoreHTTPSErrors: true });
  await context.addInitScript(initScript, { language, readySel });
  const page = await context.newPage(); const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable'); await cdp.send('Performance.enable');
  const net = { requests: new Map(), bytes: 0, staticBytes: 0, apiBytes: 0, count: 0, staticCount: 0, byType: {} };
  net.wf = [];
  cdp.on('Network.requestWillBeSent', e => net.requests.set(e.requestId, { url: e.request.url, type: e.type, t: e.timestamp, init: (e.initiator && e.initiator.stack && e.initiator.stack.callFrames[0]) ? e.initiator.stack.callFrames[0].functionName + '@' + e.initiator.stack.callFrames[0].url.split('/').pop() + ':' + e.initiator.stack.callFrames[0].lineNumber : (e.initiator || {}).type }));
  cdp.on('Network.loadingFinished', e => {
    const r = net.requests.get(e.requestId); if (!r) return; const p = new URL(r.url).pathname; net.wf.push({ p: new URL(r.url).pathname + new URL(r.url).search + '  <' + r.init + '>', s: r.t, e: e.timestamp, kb: r1((e.encodedDataLength || 0) / 1024) }); const b = e.encodedDataLength || 0;
    net.bytes += b; net.count++; if (p.startsWith('/api/')) net.apiBytes += b; else if (!p.startsWith('/socket.io')) { net.staticBytes += b; net.staticCount++; }
    const k = /\.js$/.test(p) ? 'js' : /\.css$/.test(p) ? 'css' : /\.woff2?$/.test(p) ? 'font' : p.startsWith('/api/') ? 'api' : p.startsWith('/socket.io') ? 'socketio' : /\.html$|^\/$|\/pos$|\/admin/.test(p) ? 'html' : 'other';
    net.byType[k] = (net.byType[k] || 0) + b;
  });
  const setNet = async on => cdp.send('Network.emulateNetworkConditions', on ? { offline: false, latency: NET.latency, downloadThroughput: NET.downloadThroughput, uploadThroughput: NET.uploadThroughput } : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await setNet(throttleNet && netMode === 'venue');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  return { context, page, cdp, net, setNet, errors };
}
const M = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__m)));
const now = page => page.evaluate(() => performance.now());
const resetNet = net => { net.bytes = 0; net.staticBytes = 0; net.apiBytes = 0; net.count = 0; net.staticCount = 0; net.byType = {}; };
const netOut = net => ({ totalKB: r1(net.bytes / 1024), staticKB: r1(net.staticBytes / 1024), apiKB: r1(net.apiBytes / 1024), requests: net.count, staticRequests: net.staticCount, byTypeKB: Object.fromEntries(Object.entries(net.byType).map(([k, v]) => [k, r1(v / 1024)])) });
const routerGo = (page, target) => page.evaluate(t => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(t), target);
const clearCart = page => page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('orderSession').$patch({ cart: [] }));
const CART_LEN = "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('orderSession').cart.length";
const cartRows = page => page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('orderSession').cart.length);

// real click + latency until the DOM condition is painted (double rAF after the condition became true)
async function clickAndWait(page, locator, condSrc, arg) {
  await page.evaluate(() => { window.__t0 = null; });
  const painted = page.evaluate(([src, a]) => window.__waitPaint(() => new Function('a', 'return (' + src + ')')(a) && window.__t0 !== null), [condSrc, arg]).then(t => ({ t }));
  await locator.click();
  const { t } = await painted.catch(async e => { await page.screenshot({ path: path.join(outDir, 'fail.png') }); console.log('locator', await locator.evaluate(el => el.outerHTML.slice(0, 300)).catch(x => 'na')); throw new Error(e.message + ' | rows=' + await cartRows(page) + ' t0=' + await page.evaluate(() => window.__t0) + ' arg=' + arg + ' dialogs=' + await page.evaluate(() => [...document.querySelectorAll('[role=dialog],.modal-panel,.toast')].map(e => e.textContent.trim().slice(0, 80)).join('|')) + ' cart=' + await page.evaluate(() => JSON.parse(localStorage.getItem('pos_cart') || '[]').map(x => x.id + 'x' + x.qty).join(','))); });
   const t0 = await page.evaluate(() => window.__t0);
  return t - t0;
}
function interactionStats(events, from) {
  const ev = events.filter(e => e.start >= from && e.id > 0); const byId = new Map();
  for (const e of ev) byId.set(e.id, Math.max(byId.get(e.id) || 0, e.duration));
  const d = [...byId.values()];
  return { interactions: d.length, maxMs: r1(Math.max(0, ...d)), p75Ms: r1(pct(d, 0.75)), medianMs: r1(median(d)) };
}

async function pos(browser, origin, language, out) {
  const P = await newPage(browser, origin, language, '.product-card', { throttleNet: true });
  const { page, cdp, net } = P;
  let m;
  // ---- cold load (empty HTTP cache, venue network)
  if (only.has('cold')) {
    const t0 = await perfMetrics(cdp);
    if (arg('coverage', false)) { await page.coverage.startJSCoverage({ resetOnNavigation: false }); await page.coverage.startCSSCoverage({ resetOnNavigation: false }); }
    await page.goto(origin + '/pos', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.__m && window.__m.readyPainted !== null, null, { timeout: 120000, polling: 50 });
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(2600);
    if (arg('coverage', false)) { const js = await page.coverage.stopJSCoverage(), css = await page.coverage.stopCSSCoverage(); const usedJs = e => { const src = e.source || ''; const arr = new Uint8Array(src.length); for (const fn of e.functions) for (const r of fn.ranges) arr.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset); return arr.reduce((x, y) => x + y, 0); }; const f = (list, isCss) => list.map(e => { const total = isCss ? e.text.length : (e.source || '').length; const used = isCss ? e.ranges.reduce((x, r) => x + r.end - r.start, 0) : usedJs(e); return { url: e.url.replace(/^https?:[/][/][^/]+/, ''), total, used, pct: total ? Math.round(100 * used / total) : null }; }).filter(x => x.total > 2000).sort((x, y) => (y.total - y.used) - (x.total - x.used)); out.coverage = { js: f(js, false).slice(0, 12), css: f(css, true).slice(0, 6) }; }
    m = await M(page); const t1 = await perfMetrics(cdp);
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd }; });
    out.cold = {
      gridPaintedMs: r1(m.readyPainted), fcpMs: r1(m.fcp), lcpMs: r1(m.lcp), ttiApproxMs: r1(ttiApprox(m.long, m.fcp)), domContentLoadedMs: r1(nav.dcl), loadEventMs: r1(nav.load),
      ...taskStats(m.long), ...Object.fromEntries(Object.entries(netOut(net)).filter(([k]) => k !== 'byTypeKB')),
      scriptMs: r1((t1.ScriptDuration - t0.ScriptDuration) * 1000), layoutMs: r1((t1.LayoutDuration - t0.LayoutDuration) * 1000), styleMs: r1((t1.RecalcStyleDuration - t0.RecalcStyleDuration) * 1000), taskMs: r1((t1.TaskDuration - t0.TaskDuration) * 1000),
    };
    const t00 = Math.min(...net.wf.map(x => x.s)); out.waterfall = net.wf.sort((a, b) => a.s - b.s).map(x => `${String(Math.round((x.s - t00) * 1000)).padStart(5)} -> ${String(Math.round((x.e - t00) * 1000)).padStart(5)}  ${String(x.kb).padStart(6)}KB  ${x.p}`);
    out.coldDetail = { byTypeKB: netOut(net).byTypeKB, attribution: attribution(m.loaf), longTasks: m.long.map(e => ({ start: r1(e.start), duration: r1(e.duration) })).sort((a, b) => b.duration - a.duration).slice(0, 5), errors: P.errors.slice(0, 5) };
  } else {
    await page.goto(origin + '/pos'); await page.waitForFunction(() => window.__m.readyPainted !== null, null, { timeout: 120000 });
  }
  // ---- warm load (HTTP cache primed, same venue network)
  if (only.has('warm')) {
    resetNet(net); await page.goto(origin + '/pos', { waitUntil: 'commit' });
    await page.waitForFunction(() => window.__m && window.__m.readyPainted !== null, null, { timeout: 120000, polling: 50 });
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {}); await page.waitForTimeout(1500);
    const w = await M(page);
    out.warm = { gridPaintedMs: r1(w.readyPainted), fcpMs: r1(w.fcp), ...taskStats(w.long), transferKB: netOut(net).totalKB, requests: net.count };
  }
  // interactions run on the local network so they measure the UI, not the venue link
  await P.setNet(false); await page.waitForTimeout(300);
  const box = async sel => page.locator(sel);
  // ---- category switch latency (5 switches) + INP-style
  if (only.has('interact')) {
    const from = await now(page); const lat = [];
    for (const n of [2, 3, 4, 5, 6]) {
      lat.push(await clickAndWait(page, page.locator('.category-button').filter({ hasText: new RegExp(`^Category ${n}$`) }), `document.querySelector('.product-card h3')?.textContent.trim() === a`, `Product ${(n - 1) * 120 + 1}`));
      await page.waitForTimeout(150);
    }
    m = await M(page);
    out.categorySwitch = { latencyMedianMs: r1(median(lat)), latencyMaxMs: r1(Math.max(...lat)), ...interactionStats(m.events, from), ...taskStats(m.long, from) };
    // ---- add-to-cart latency
    await clearCart(page); const from2 = await now(page); const add = [];
    for (let i = 0; i < 6; i++) {
      const before = await cartRows(page);
      add.push(await clickAndWait(page, page.locator('.product-card').nth(i), `(${CART_LEN}) === a && document.querySelectorAll('.cart-items-scroll tbody > tr').length === a`, before + 1));
      await page.waitForTimeout(120); if (process.env.DBG) console.log('add', i, await cartRows(page));
    }
    m = await M(page);
    out.addToCart = { latencyMedianMs: r1(median(add)), latencyMaxMs: r1(Math.max(...add)), ...interactionStats(m.events, from2), ...taskStats(m.long, from2) };
    await clearCart(page); await page.waitForTimeout(200);
    // ---- burst of category switches (frame sampling); clicks are real mouse input at 70 ms spacing
    const boxes = []; for (let n = 1; n <= 10; n++) { const b = await page.locator('.category-button').filter({ hasText: new RegExp(`^Category ${n}$`) }).boundingBox(); if (b) boxes.push(b); }
    const from3 = await now(page); await page.evaluate(() => window.__frames.start());
    for (let i = 0; i < 24; i++) { const b = boxes[i % boxes.length]; await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(70); }
    await page.waitForTimeout(400);
    const gaps = await page.evaluate(() => window.__frames.stop()); m = await M(page);
    out.categoryBurst = { clicks: 24, ...frameStats(gaps), ...interactionStats(m.events, from3), ...taskStats(m.long, from3) };
    out.categoryBurstDetail = attribution(m.loaf, from3);
  }
  // ---- cart with 40 lines
  if (only.has('cart')) {
    await page.locator('.category-button').filter({ hasText: /^Category 1$/ }).click(); await page.waitForTimeout(300);
    await clearCart(page); const from = await now(page); const add = []; const t0 = Date.now();
    await page.evaluate(() => window.__frames.start());
    for (let i = 0; i < 40; i++) { const before = await cartRows(page); add.push(await clickAndWait(page, page.locator('.product-card').nth(i), `(${CART_LEN}) === a && document.querySelectorAll('.cart-items-scroll tbody > tr').length === a`, before + 1)); }
    const addGaps = await page.evaluate(() => window.__frames.stop()); m = await M(page);
    const rows = await cartRows(page);
    out.cart40Build = { rows, latencyFirst5MedianMs: r1(median(add.slice(0, 5))), latencyLast5MedianMs: r1(median(add.slice(-5))), latencyMaxMs: r1(Math.max(...add)), ...interactionStats(m.events, from), ...taskStats(m.long, from), wallMs: Date.now() - t0 };
    // scroll the cart with real wheel input, sampling frames
    const cb = await page.locator('.cart-items-scroll').boundingBox(); await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    const fromS = await now(page); await page.evaluate(() => window.__frames.start());
    for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, i < 15 ? 120 : -120); await page.waitForTimeout(16); }
    await page.waitForTimeout(300); const sg = await page.evaluate(() => window.__frames.stop()); m = await M(page);
    out.cart40Scroll = { ...frameStats(sg), ...taskStats(m.long, fromS) };
    // tap a row + numpad + modifier action
    const fromI = await now(page); const rowLat = []; const rowsLoc = page.locator('.cart-items-scroll tbody > tr');
    for (const idx of [5, 20, 35]) {
      rowLat.push(await clickAndWait(page, rowsLoc.nth(idx), `document.querySelector('.cart-items-scroll tbody > tr.selected, .cart-items-scroll tbody > tr[aria-selected="true"], .cart-items-scroll tbody > tr[class*="active"]') !== null || true`, null));
      await page.locator('.numpad button').filter({ hasText: /^2$/ }).click().catch(() => {}); await page.waitForTimeout(150);
    }
    m = await M(page);
    out.cart40Interact = { ...interactionStats(m.events, fromI), ...taskStats(m.long, fromI) };
    out.cart40Detail = attribution(m.loaf, from);
  }
  // ---- open tables floor with 80 tables
  if (only.has('tables')) {
    await clearCart(page); const from = await now(page); const t0 = Date.now();
    await page.evaluate(() => { window.__t0 = performance.now(); window.__frames.start(); });
    await routerGo(page, '/tables');
    const painted = await page.evaluate(() => window.__waitPaint(() => document.querySelectorAll('[data-testid="table-card"]').length >= 80, 60000));
    const t0p = await page.evaluate(() => window.__t0);
    await page.waitForLoadState('networkidle'); await page.waitForTimeout(400);
    const g = await page.evaluate(() => window.__frames.stop()); m = await M(page);
    const cards = await page.locator('[data-testid="table-card"]').count();
    out.tables80 = { cards, floorPaintedMs: r1(painted - t0p), ...frameStats(g), ...taskStats(m.long, from) };
    out.tables80Detail = attribution(m.loaf, from);
    // realtime burst: 10 table events => shared refresh
    const from2 = await now(page); await page.evaluate(() => window.__frames.start());
    for (let i = 0; i < 10; i++) io.emit('table_update', { action: 'refresh' });
    await page.waitForTimeout(1200); const g2 = await page.evaluate(() => window.__frames.stop()); m = await M(page);
    out.tablesEventBurst = { ...frameStats(g2), ...taskStats(m.long, from2) };
    await routerGo(page, '/pos'); await page.locator('.product-card').first().waitFor(); await page.waitForTimeout(500);
  }
  // ---- heap after 10 vs 100 interactions (category switch + add + clear every 10)
  if (only.has('heap')) {
    const heap = async () => { await cdp_gc(P.cdp); const h = await P.cdp.send('Runtime.getHeapUsage'); const d = await P.cdp.send('Memory.getDOMCounters'); return { usedMB: r1(h.usedSize / 1048576), nodes: d.nodes, listeners: d.jsEventListeners }; };
    const interact = async i => {
      const n = (i % 6) + 1; await page.locator('.category-button').filter({ hasText: new RegExp(`^Category ${n}$`) }).click();
      await page.locator('.product-card').first().waitFor(); await page.locator('.product-card').nth(i % 5).click();
      if (i % 10 === 9) await clearCart(page);
    };
    await page.locator('.category-button').first().waitFor(); await clearCart(page);
    const before = await heap();
    for (let i = 0; i < 10; i++) await interact(i);
    const after10 = await heap();
    for (let i = 10; i < 100; i++) await interact(i);
    const after100 = await heap();
    out.heap = { before, after10, after100, growth10to100MB: r1(after100.usedMB - after10.usedMB), nodeGrowth10to100: after100.nodes - after10.nodes, listenerGrowth10to100: after100.listeners - after10.listeners };
  }
  if (P.errors.length) out.errors = P.errors.slice(0, 5);
  await P.context.close();
}
async function cdp_gc(cdp) { await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage'); }

async function admin(browser, origin, language, out) {
  const P = await newPage(browser, origin, language, 'header button .fa-rotate', { throttleNet: true });
  const { page, cdp, net } = P; const t0 = await perfMetrics(cdp);
  await page.goto(origin + '/admin/dashboard', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__m && window.__m.readyPainted !== null, null, { timeout: 120000, polling: 50 });
  await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {}); await page.waitForTimeout(2600);
  const m = await M(page); const t1 = await perfMetrics(cdp);
  out.adminCold = { readyPaintedMs: r1(m.readyPainted), fcpMs: r1(m.fcp), lcpMs: r1(m.lcp), ttiApproxMs: r1(ttiApprox(m.long, m.fcp)), ...taskStats(m.long), ...Object.fromEntries(Object.entries(netOut(net)).filter(([k]) => k !== 'byTypeKB')), scriptMs: r1((t1.ScriptDuration - t0.ScriptDuration) * 1000), layoutMs: r1((t1.LayoutDuration - t0.LayoutDuration) * 1000), styleMs: r1((t1.RecalcStyleDuration - t0.RecalcStyleDuration) * 1000) };
  const tw = Math.min(...net.wf.map(x => x.s)); out.adminWaterfall = net.wf.sort((a, b) => a.s - b.s).map(x => `${String(Math.round((x.s - tw) * 1000)).padStart(5)} -> ${String(Math.round((x.e - tw) * 1000)).padStart(5)}  ${String(x.kb).padStart(6)}KB  ${x.p}`);
  out.adminColdDetail = { byTypeKB: netOut(net).byTypeKB, attribution: attribution(m.loaf), errors: P.errors.slice(0, 5) };
  await P.context.close();
}

// ---- customer QR menu: /menu and /menu?table=1&token=t, cold cache, venue network
async function menu(browser, origin, language, out) {
  for (const [name, query] of [['menu', ''], ['menuTable', '?table=1&token=t']]) {
    const P = await newPage(browser, origin, language, '.product-card', { throttleNet: true });
    const { page, net } = P;
    await page.goto(origin + '/menu' + query, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.__m && window.__m.readyPainted !== null, null, { timeout: 120000, polling: 50 });
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const m = await M(page);
    out[name] = { readyPaintedMs: r1(m.readyPainted), fcpMs: r1(m.fcp), lcpMs: r1(m.lcp), ...taskStats(m.long), ...netOut(net), errors: P.errors.length };
    await P.context.close();
  }
}

async function profileCold(browser, origin, language) {
  const P = await newPage(browser, origin, language, '.product-card', { throttleNet: true });
  await P.cdp.send('Profiler.enable'); await P.cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await P.cdp.send('Profiler.start');
  await P.page.goto(origin + '/pos', { waitUntil: 'commit' });
  await P.page.waitForFunction(() => window.__m && window.__m.readyPainted !== null, null, { timeout: 120000, polling: 50 });
  await P.page.waitForTimeout(1500);
  const { profile } = await P.cdp.send('Profiler.stop'); await P.context.close(); return profileTop(profile);
}

// ---------------------------------------------------------------- flatten + medians
function flat(o, p = '', acc = {}) { for (const [k, v] of Object.entries(o)) { const key = p ? p + '.' + k : k; if (typeof v === 'number') acc[key] = v; else if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, acc); } return acc; }
async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: !arg('headed', false), args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
  const result = { label, dist: path.relative(root, dist), compress, net: netMode === 'venue' ? `venue ${NET.latency}ms RTT ${(NET.downloadThroughput * 8 / 1e6).toFixed(1)}/${(NET.uploadThroughput * 8 / 1e3).toFixed(0)} Mbps/Kbps` : 'none', cpuThrottle: cpu, runs, cpuModel: os.cpus()[0].model, node: process.version, chromium: browser.version(), when: new Date().toISOString(), raw: {}, median: {} };
  try {
    for (const language of langs) {
      lang = language; result.raw[language] = [];
      for (let r = 0; r < runs; r++) {
        const out = {}; result.raw[language].push(out); const c0 = cpuTimes(); out.hostSpinMsBefore = r1(spin());
        try { if (['cold', 'warm', 'interact', 'cart', 'tables', 'heap'].some(k => only.has(k))) await pos(browser, origin, language, out); } catch (e) { out.posError = String(e.stack || e).slice(0, 600); }
        if (only.has('menu')) try { await menu(browser, origin, language, out); } catch (e) { out.menuError = String(e.stack || e).slice(0, 600); }
        if (only.has('admin')) try { await admin(browser, origin, language, out); } catch (e) { out.adminError = String(e.stack || e).slice(0, 600); }
        out.hostBusyPct = busyPct(c0, cpuTimes()); out.hostSpinMsAfter = r1(spin());
        console.log(`[${label}] ${language} run ${r + 1}/${runs} done`, out.posError || '', out.adminError || '');
        fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
      }
      const keys = new Set(result.raw[language].flatMap(o => Object.keys(flat(o))));
      result.median[language] = Object.fromEntries([...keys].map(k => [k, r1(median(result.raw[language].map(o => flat(o)[k])))]));
      if (wantProfile) { try { (result.profile ??= {})[language] = await profileCold(browser, origin, language); } catch (e) { (result.profile ??= {})[language] = String(e).slice(0, 300); } }
    }
    result.unknownEndpoints = [...unknown];
  } finally { await browser.close(); await new Promise(r => io.close(r)); server.close(); fs.writeFileSync(outFile, JSON.stringify(result, null, 1)); }
  for (const language of langs) { console.log(`\n== ${label} [${language}] medians of ${runs}`); for (const [k, v] of Object.entries(result.median[language])) console.log(`  ${k.padEnd(42)} ${v}`); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
