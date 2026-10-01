// Category recovery acceptance. Set CATEGORY_REVIEW_MODE=baseline only when
// characterizing the unfixed source; preserved before results are in docs/reviews.
// Real POS catalog component, composable, auth interceptor, and cart stores;
// controlled loopback HTTP only. No database, checkout, printer or customer session.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const baseline = process.env.CATEGORY_REVIEW_MODE === 'baseline';
  const out = path.join(root, 'scratch', baseline ? 'pos-category-stall' : 'pos-category-recovery');
  fs.mkdirSync(out, { recursive: true });
  const { createServer } = await import('vite');
  const vue = (await import('@vitejs/plugin-vue')).default;
  const tailwind = (await import('@tailwindcss/vite')).default;
  const boot = `
    import '/src/shared/authInterceptor.js';
    import '/src/pos.css';
    import { createApp, h } from 'vue';
    import { createPinia } from 'pinia';
    import { routerKey } from 'vue-router';
    import Catalog from '/src/components/pos/PosCatalogWorkspace.vue';
    import { createPosI18n } from '/src/shared/i18n.js';
    import { useProducts } from '/src/pos/useProducts.js';
    import { useOrderSessionStore } from '/src/pos/stores/orderSessionStore.js';
    const app = createApp({render: () => h(Catalog)});
    app.use(createPinia()); app.provide(routerKey,{push(){}});
    app.use(createPosI18n({rootSelector:'#app',titleKey:'POS System',rtlBodyClass:'pos-rtl'}));
    window.uiErrors = []; window.toasts = [];
    app.config.errorHandler = e => window.uiErrors.push(e.message);
    window.showPosToast = (message, kind) => window.toasts.push({message,kind});
    window.showPosAlert = async message => window.toasts.push({message});
    window.showPosConfirm = async () => false;
    window.catalog = useProducts(); window.order = useOrderSessionStore();
    app.mount('#app'); await window.catalog.fetchData({forceFull:true});
    window.ready = true;
  `;
  const server = await createServer({
    configFile: false, envFile: false, root,
    optimizeDeps: { noDiscovery: true, include: ['vue', 'pinia', 'vue-router', 'socket.io-client', '@posapp/permission-policy'] },
    resolve: { alias: {
      '@': path.join(root, 'src'),
      '@posapp/permission-policy': path.join(root, 'backend/config/permissionPolicy.cjs'),
    } },
    plugins: [{
      name: 'pos-category-diagnostic',
      resolveId(id) { if (id === '/category-review-entry.js') return '\0category-review'; },
      load(id) { if (id === '\0category-review') return boot; },
      configureServer(s) {
        // Native HTTP headers arrive while the JSON body never finishes. This
        // exercises the real fetch/response.json AbortSignal, not a Promise mock.
        s.middlewares.use('/__stalled_catalog_body', (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.write('{"success":true,');
        });
        s.middlewares.use('/__category_review', async (_req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(await s.transformIndexHtml('/__category_review', '<style>html,body,#app{height:100%;margin:0}</style><div id="app" class="pos-polish"></div><script type="module" src="/category-review-entry.js"></script>'));
        });
      },
    }, tailwind(), vue()],
    server: { host: '127.0.0.1', port: 0 },
  });
  const categories = [
    { id: 1, name: 'Food', parent_id: null, is_active: 1 },
    { id: 2, name: 'Drinks', parent_id: null, is_active: 1 },
    { id: 3, name: 'Dessert', parent_id: null, is_active: 1 },
  ];
  const productNames = ['Food item', 'Drinks item', 'Dessert item'];
  const payload = category => ({
    success: true, categories, categories_included: true, selected_category_id: category,
    products: [{ id: category * 10, category_id: category, name: productNames[category - 1], price: 2, tax_rate: 0, is_available: 1, can_sell: 1, stock: 50 }],
    settings: { stock_enabled: '0', tables_enabled: '0' }, pagination: { total: 1, limit: 120, offset: 0 },
  });
  const result = {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    expectedBehavior: baseline ? 'baseline defect' : 'fixed recovery',
    sourceSha256: Object.fromEntries(['src/pos/useProducts.js', 'src/components/pos/PosCatalogWorkspace.vue'].map(file => [file,
      require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')])),
    cases: [],
  };
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
    for (const [lang, width, height] of baseline ? [['en',1280,800],['ar',1280,800]] : [['en',1280,800],['ar',1280,800],['en',390,844],['ar',390,844]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      await context.addInitScript(language => {
        localStorage.setItem('pos_admin_language', language);
        sessionStorage.setItem('pos_user', JSON.stringify({id:1,name:'Fixture',role:'admin'}));
      }, lang);
      const page = await context.newPage();
      const errors = [], requests = [], pending = [], observations = [], abortedRequests = [];
      let mode = 'normal';
      page.on('pageerror', error => errors.push(error.message));
      page.on('requestfailed', request => { if (request.url().includes('/api/pos/products')) abortedRequests.push({url:request.url(),error:request.failure()?.errorText}); });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        assert.equal(request.method(), 'GET', 'Diagnostic must not perform business writes');
        assert.equal(url.pathname, '/api/pos/products', 'Unmapped API request');
        requests.push({ url: url.pathname + url.search, mode });
        assert.equal(url.searchParams.get('search'), null, 'Reported reproduction has empty search');
        const category = Number(url.searchParams.get('category_id') || 1);
        if (mode === 'hold') { pending.push({ route, category }); return; }
        if (mode === 'body-stall') return route.continue({url:origin + '/__stalled_catalog_body'});
        if (mode === 'html-once') {
          mode = 'normal';
          return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Transient proxy page</title>'});
        }
        if (mode === 'network-failure') return route.abort('internetdisconnected');
        if (mode === 'server-error') return route.fulfill({status:503,json:{success:false,message:'Controlled server outage'}});
        return route.fulfill({ json: payload(category) });
      });
      await page.goto(origin + '/__category_review');
      await page.waitForFunction(() => window.ready === true);
      const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
      const select = name => page.locator('#categories-sidebar button').filter({hasText: new RegExp(`^${name}$`)}).click();
      const item = () => page.locator('.product-card h3');
      const errorBanner = () => page.locator('.catalog-load-error');
      const invalidateSnapshots = () => page.evaluate(() => catalog.invalidateCatalogSnapshots?.());
      const retry = async expectedItem => {
        mode = 'normal'; await page.locator('.catalog-retry').click();
        await expect(item()).toHaveText(expectedItem); await expect(errorBanner()).toHaveCount(0);
      };
      const read = async label => {
        const state = await page.evaluate(() => ({
          active: catalog.activeCategory.value,
          highlighted: document.querySelector('#categories-sidebar .is-active')?.textContent.trim(),
          displayed: [...document.querySelectorAll('.product-card h3')].map(el => el.textContent.trim()),
          loading: catalog.isCatalogLoading.value,
          error: catalog.catalogLoadError.value,
          search: catalog.searchQuery.value,
          stageText: document.querySelector('.product-stage').innerText,
          loadingFeedbackVisible: !!document.querySelector('.product-stage [role="status"]'),
        }));
        observations.push({ label, ...state });
        return state;
      };
      await expect(item()).toHaveText('Food item');
      await select('Drinks'); await expect(item()).toHaveText('Drinks item');
      await select('Dessert'); await expect(item()).toHaveText('Dessert item');
      await select('Food'); await expect(item()).toHaveText('Food item');
      await read('healthy responses switch products correctly');
      if (!baseline) {
        await page.evaluate(() => {
          order.cart = [{id:777,name:'Existing cart line',qty:2,price:3,tax_rate:0}];
          window.previousCard = document.querySelector('.product-card');
        });
      }

      await invalidateSnapshots();
      mode = 'hold'; await select('Drinks');
      await expect.poll(() => pending.length).toBe(1);
      const delayed = await read(baseline ? 'new category pending while old products stay visible' : 'new category pending with loading feedback and no previous-category cards');
      assert.equal(delayed.highlighted, 'Drinks'); assert.deepEqual(delayed.displayed, baseline ? ['Food item'] : []);
      assert.equal(delayed.loading, true); assert.equal(delayed.loadingFeedbackVisible, !baseline);
      if (!baseline) {
        await page.evaluate(() => window.previousCard.click());
        assert.deepEqual(await page.evaluate(() => order.cart.map(item => item.name)), ['Existing cart line']);
        await expect(page.locator('.product-stage [role="status"]')).toBeVisible();
      }
      await page.waitForTimeout(220); // Let the existing category highlight transition settle for the screenshot.
      await page.screenshot({path:path.join(out,`${lang}-${width}-pending.png`)});

      await select('Dessert'); await expect.poll(() => pending.length).toBe(2);
      await pending[1].route.fulfill({json:payload(3)}); await expect(item()).toHaveText('Dessert item');
      await pending[0].route.fulfill({json:payload(2)}).catch(() => {}); // Superseded request is now aborted.
      await page.waitForTimeout(100); await expect(item()).toHaveText('Dessert item');
      pending.length = 0;
      await read('out-of-order old response is correctly ignored');

      await invalidateSnapshots();
      mode = 'network-failure'; await select('Drinks');
      await expect.poll(() => page.evaluate(() => catalog.isCatalogLoading.value)).toBe(false);
      const failed = await read(baseline ? 'failed request silently leaves wrong-category products' : 'failed selection hides stale cards and offers visible retry');
      assert.equal(failed.highlighted,'Drinks'); assert.deepEqual(failed.displayed,baseline ? ['Dessert item'] : []);
      assert.equal(failed.error,'Unable to load products.');
      if (baseline) {
        assert(!failed.stageText.includes('Unable to load products.'));
        await page.locator('.product-card').click();
        assert.deepEqual(await page.evaluate(() => order.cart.map(item => item.name)), ['Dessert item']);
      } else {
        await expect(errorBanner()).toBeVisible(); await expect(page.locator('.catalog-retry')).toBeEnabled();
        await expect(page.locator('.product-card')).toHaveCount(0);
        assert.deepEqual(await page.evaluate(() => order.cart.map(item => item.name)), ['Existing cart line']);
      }
      observations.push({label:baseline ? 'stale product remains clickable and is added to the isolated local cart' : 'stale DOM click cannot add an item and the existing cart is preserved'});
      await page.screenshot({path:path.join(out,`${lang}-${width}-network-failure.png`)});
      await invalidateSnapshots();
      mode = 'server-error'; await select('Food');
      await expect.poll(() => page.evaluate(() => catalog.isCatalogLoading.value)).toBe(false);
      const serverError = await read(baseline ? 'server 503 produces the same visible mismatch' : 'server 503 exposes retry without stale cards');
      assert.equal(serverError.highlighted,'Food'); assert.deepEqual(serverError.displayed,baseline ? ['Dessert item'] : []);
      if (!baseline) await retry('Food item');

      if (!baseline) {
        await invalidateSnapshots();
        const requestCountBeforeHtml = requests.length;
        mode = 'html-once'; await select('Drinks'); await expect(item()).toHaveText('Drinks item');
        assert.equal(requests.length - requestCountBeforeHtml, 2);
        await expect(errorBanner()).toHaveCount(0);
        await read('transient HTML response retries once and recovers without a reload');
      }
      mode = 'normal'; await select('Drinks'); await expect(item()).toHaveText('Drinks item');
      await read('successful retry recovers without reloading the page');
      await invalidateSnapshots();
      mode = 'hold'; await select('Food'); await expect.poll(() => pending.length).toBe(1);
      await page.waitForTimeout(3000);
      const held = await read(baseline ? 'held transport keeps loading without a visible loading state' : 'held transport displays loading and hides old-category cards');
      assert.equal(held.loading,true); assert.equal(held.loadingFeedbackVisible,!baseline);
      assert.equal(held.error,''); assert.deepEqual(held.displayed,baseline ? ['Drinks item'] : []);
      if (!baseline && width === 1280) {
        await expect(errorBanner()).toBeVisible({timeout:18000});
        assert.equal(await page.evaluate(() => catalog.isCatalogLoading.value),false);
        assert.match(await page.evaluate(() => catalog.catalogLoadError.value),/too long/i);
        await read('stalled headers reach the deadline and expose a retry');
        await pending[0].route.fulfill({json:payload(1)}).catch(() => {});
        await expect(page.locator('.product-card')).toHaveCount(0);
        await retry('Food item');
        await invalidateSnapshots();
        mode = 'body-stall'; await select('Drinks');
        await expect(page.locator('.product-stage [role="status"]')).toBeVisible();
        await expect(errorBanner()).toBeVisible({timeout:18000});
        assert.equal(await page.evaluate(() => catalog.isCatalogLoading.value),false);
        assert.match(await page.evaluate(() => catalog.catalogLoadError.value),/too long/i);
        await read('native HTTP body stall is aborted by the whole-read deadline');
        await retry('Drinks item');
      } else {
        await pending[0].route.fulfill({json:payload(1)}); await expect(item()).toHaveText('Food item');
      }
      if (!baseline) {
        mode = 'server-error';
        await page.evaluate(() => catalog.fetchData({forceFull:true}));
        await expect(errorBanner()).toBeVisible();
        await expect(item()).toHaveCount(1);
        await read('same-category background failure retains usable matching rows and visible retry');
        await retry(width === 1280 ? 'Drinks item' : 'Food item');
        assert.deepEqual(await page.evaluate(() => order.cart.map(item => item.name)), ['Existing cart line']);
        await page.locator('.product-card').click();
        assert.deepEqual(await page.evaluate(() => order.cart.map(item => item.name)), ['Existing cart line', width === 1280 ? 'Drinks item' : 'Food item']);
        observations.push({label:'recovered visible product can be added normally without changing the existing cart line'});
        await page.screenshot({path:path.join(out,`${lang}-${width}-recovered.png`)});
      }
      assert.equal(await page.evaluate(() => performance.timeOrigin),documentTimeOrigin);
      assert.deepEqual(errors,[]); assert.deepEqual(await page.evaluate(() => uiErrors),[]);
      result.cases.push({lang, width, observations, requests, abortedRequests, errors});
      console.log(`${lang} ${width}: ${baseline ? 'baseline mismatch reproduced' : 'category error, retry, cancellation, cart preservation and recovery passed'}`);
      await context.close();
    }
  } finally {
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2)+'\n');
    await browser?.close(); await server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
