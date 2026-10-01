// Browser contract check against real components, stores, HTTP helpers and the
// POS handoff handler. Auth/catalog and HTTP responses are controlled fixtures;
// this does not contact a database, printer, payment provider or JoFotara.
const path = require('node:path');
const fs = require('node:fs');
const { chromium, expect } = require('@playwright/test');
const { parse: parseSfc } = require('@vue/compiler-sfc');
const { parse: parseScript } = require('@babel/parser');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const { createServer } = await import('vite');
  const vue = (await import('@vitejs/plugin-vue')).default;
  // Execute the production handler without copying its implementation or
  // mounting the unrelated scanner/socket/shift bootstrap of the full terminal.
  const source = parseSfc(fs.readFileSync(path.join(root, 'src/components/PosTerminal.vue'), 'utf8')).descriptor.scriptSetup.content;
  const declaration = parseScript(source, { sourceType: 'module' }).program.body
    .flatMap(node => node.declarations || []).find(node => node.id.name === 'checkAndRestoreHeldOrder');
  if (!declaration) throw new Error('POS handoff handler was not found');
  const handoffHandler = source.slice(declaration.init.start, declaration.init.end);
  const stubs = {
    useAuth: `import { ref } from 'vue';
      const state = { activeUser: ref({id:1,name:'Cashier',role:'cashier'}), activeShift: ref({id:9}), isTempAdmin: ref(false) };
      export const useAuth = () => state;`,
    usePermissions: `export const usePermissions = () => ({ can: () => true, hasDirect: () => true });`,
    useProducts: `import { ref } from 'vue';
      const state = { products: ref([]), settings: ref({stock_enabled:'0',tables_enabled:'1',service_charge_enabled:'0'}) };
      export const useProducts = () => state;`,
  };
  const boot = `
    import { createApp, nextTick, h, Fragment } from 'vue';
    import { createPinia } from 'pinia';
    import { routerKey } from 'vue-router';
    import Checkout from '/src/components/pos/CheckoutModal.vue';
    import Receipt from '/src/components/pos/ReceiptPreviewModal.vue';
    import { useOrderSessionStore } from '/src/pos/stores/orderSessionStore.js';
    import { useOrderUiStore } from '/src/pos/stores/orderUiStore.js';
    import { useCart } from '/src/pos/useCart.js';
    import { useTables } from '/src/pos/useTables.js';
    import { useTerminal } from '/src/pos/useTerminal.js';
    import { initBusinessConfig } from '/src/utils/businessDate.js';
    import { readHeldOrderHandoff, storeHeldOrderHandoff, readActiveTableSession,
      hasPendingTableSession as hasStoredTableSession, clearHeldOrderHandoff,
      clearTablePrefill } from '/src/pos/posSessionStorage.js';
    const t = text => text;
    window.toasts = []; window.uiErrors = []; window.confirmAnswer = true;
    window.showPosToast = (m,k) => window.toasts.push({m,k});
    window.showPosAlert = async m => window.toasts.push({m,k:'alert'});
    window.showPosConfirm = async () => window.confirmAnswer;
    window.print = () => {};
    initBusinessConfig({ business_sql_offset: '+03:00' });
    const app = createApp({render: () => h(Fragment,null,[h(Checkout),h(Receipt)])});
    app.use(createPinia()); app.provide(routerKey,{push(){}});
    app.config.globalProperties.$t = t;
    app.config.errorHandler = e => window.uiErrors.push(e.message);
    const s = useOrderSessionStore(), u = useOrderUiStore(), terminal = useTerminal();
    const cart = useCart(), {activeTable, clearActiveTableSession} = useTables();
    const isProcessing = cart.isProcessing;
    const restoreHandoff = ${handoffHandler};
    await terminal.loadSettings();
    window.audit = {s,u,terminal,nextTick,restoreHandoff,storeHeldOrderHandoff,readHeldOrderHandoff};
    s.cart = [{id:1,name:'Coffee',qty:1,price:5,tax_rate:0}];
    s.orderTypes = [{id:3,name:'Platform',is_deferred_settlement:1},{id:4,name:'Hash pickup',requires_hash:1}];
    s.selectedOrderType = '3'; s.openCheckoutModal(); app.mount('#app');
  `;
  const server = await createServer({
    configFile: false, envFile: false, root,
    optimizeDeps: { noDiscovery: true, include: ['vue', 'pinia', 'vue-router', '@posapp/permission-policy'] },
    resolve: { alias: {
      '@': path.join(root, 'src'),
      '@posapp/permission-policy': path.join(root, 'backend/config/permissionPolicy.cjs')
    } },
    plugins: [{
      name: 'checkout-review-fixtures', enforce: 'pre',
      resolveId(id) {
        const name = Object.keys(stubs).find(key => id.replace(/\\/g, '/').endsWith('/' + key + '.js'));
        if (name) return '\0review:' + name;
        if (id === '/review-entry.js') return '\0review:entry';
      },
      load(id) {
        if (id === '\0review:entry') return boot;
        if (id.startsWith('\0review:')) return stubs[id.slice(8)];
      },
      configureServer(s) {
        s.middlewares.use('/__checkout_review', async (_req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(await s.transformIndexHtml('/__checkout_review', '<div id="app"></div><script type="module" src="/review-entry.js"></script>'));
        });
      },
    }, vue()],
    server: { host: '127.0.0.1', port: 0 },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [], requests = [], checks = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/system/settings', r => r.fulfill({ json: { success: true, print_method: 'backend' } }));
    await page.route('**/api/print/print', r => r.fulfill({ status: 503, json: {success:false,message:'Controlled printer outage'} }));
    let invalidReceipt = false, loseResponse = false;
    await page.route('**/api/pos/checkout', async route => {
      const body = route.request().postDataJSON(); requests.push(body);
      if (loseResponse) { loseResponse = false; return route.abort('failed'); }
      await route.fulfill({ json: {
        success: true, invoice_id: 901 + requests.length, order_id: requests.length,
        subtotal: 5, tax: 0, total: 5, discount: 0, payment_method: body.payment_method,
        created_at: '2026-09-10 10:00:00', ...(invalidReceipt ? {receipt_display_v1:{rows:[]}} : {}),
      } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__checkout_review`);
    const platform = page.getByRole('button', {name:'Platform',exact:true}).first();
    await expect(platform).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', {name:'Hash pickup'}).click();
    await expect(page.locator('#checkout-hash')).toBeFocused();
    await platform.click(); await page.locator('.checkout-confirm').click();
    await expect.poll(() => requests.length).toBe(1);
    await expect.poll(() => page.evaluate(() => audit.s.cart.length)).toBe(0);
    await expect.poll(() => page.evaluate(() => toasts.some(t => t.k === 'warning' && t.m.includes('Transaction saved')))).toBe(true);
    await expect.poll(() => page.evaluate(() => toasts.some(t => t.k === 'success'
      && t.m.includes('Platform sale recorded') && t.m.includes('No payment was collected.')))).toBe(true);
    checks.push('mixed-id highlight', 'hash focus', 'platform checkout', 'saved-transaction print warning');

    invalidReceipt = true;
    await page.evaluate(() => { audit.s.startNewOrder(); audit.s.cart = [{id:1,name:'Coffee',qty:1,price:5,tax_rate:0}]; audit.s.openCheckoutModal(); });
    await page.locator('.checkout-confirm').click();
    await expect.poll(() => requests.length).toBe(2);
    await expect.poll(() => page.evaluate(() => audit.s.cart.length)).toBe(0);
    await expect.poll(() => page.evaluate(() => toasts.some(t => t.m.includes('Receipt could not be displayed')))).toBe(true);
    checks.push('invalid-receipt finalization');

    invalidReceipt = false; loseResponse = true;
    await page.evaluate(() => { audit.s.startNewOrder(); audit.s.cart = [{id:1,name:'Coffee',qty:1,price:5,tax_rate:0}]; audit.s.openCheckoutModal(); audit.u.amountTendered = 20; });
    await page.locator('.checkout-confirm').click();
    await expect(page.getByRole('button', {name:'Check last payment'})).toBeEnabled();
    await page.evaluate(() => { audit.u.closeCheckoutModal(); audit.s.startNewOrder(); audit.s.openCheckoutModal(); });
    await page.getByRole('button', {name:'Check last payment'}).click();
    await expect.poll(() => requests.length).toBe(4);
    await expect.poll(() => page.evaluate(() => audit.s.pendingCheckout)).toBeNull();
    expect(requests[3]).toEqual(requests[2]);
    checks.push('lost response retains original tender and key', 'recovery with empty register draft');

    let claimMode = 'fail', releaseClaim, claims = 0;
    await page.route('**/api/pos/held_orders/*/claim', async route => {
      claims += 1;
      if (claimMode === 'fail') return route.abort('failed');
      if (claimMode === 'delay') await new Promise(resolve => { releaseClaim = resolve; });
      await route.fulfill({json:{success:true,order:{id:17,version:2,reference_name:'Held',cart_data:{items:[{id:8,name:'Held coffee',qty:1,price:4,tax_rate:0}]}},claim:{version:2,claimToken:'a'.repeat(64)}}});
    });
    await page.evaluate(() => { audit.s.startNewOrder(); audit.storeHeldOrderHandoff({heldOrderId:17,claimToken:'a'.repeat(64),expectedVersion:1}); });
    expect(await page.evaluate(() => audit.restoreHandoff())).toBe('failed-held-order');
    await page.evaluate(() => { audit.s.cart = [{id:2,name:'New draft',qty:1,price:6,tax_rate:0}]; window.confirmAnswer = false; });
    expect(await page.evaluate(() => audit.restoreHandoff())).toBe('deferred-held-order');
    expect(claims).toBe(1);
    claimMode = 'delay'; await page.evaluate(() => { window.confirmAnswer = true; });
    const restoring = page.evaluate(() => audit.restoreHandoff());
    await expect.poll(() => claims).toBe(2);
    await page.evaluate(() => { audit.s.cart[0].qty = 2; });
    releaseClaim();
    expect(await restoring).toBe('deferred-held-order');
    expect(await page.evaluate(() => audit.s.cart[0].qty)).toBe(2);
    claimMode = 'ok';
    expect(await page.evaluate(() => audit.restoreHandoff())).toBe('server-canonical-held');
    expect(await page.evaluate(() => audit.s.cart[0].name)).toBe('Held coffee');
    expect(await page.evaluate(() => audit.readHeldOrderHandoff(localStorage))).toBeNull();
    checks.push('failed handoff preserves envelope', 'declined replacement preserves draft', 'late claim cannot replace changed draft', 'confirmed handoff restores canonical held order');

    expect(await page.evaluate(() => uiErrors)).toEqual([]); expect(errors).toEqual([]);
    checks.push('no Vue/page errors');
    const result = {passed:true,checkoutRequests:requests.length,heldClaims:claims,checks};
    fs.mkdirSync(path.join(root, 'scratch'), {recursive:true});
    fs.writeFileSync(path.join(root, 'scratch/checkout-ui-browser-results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
