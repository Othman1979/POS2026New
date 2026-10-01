import { test, expect, request as requestFactory } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pool from '../../../backend/config/db.js';
import { SEED } from '../../../backend/tests/fixtures/seed.js';
import { reseedDatabase } from '../reseed.js';

const baseURL = 'http://localhost:3001';
const cart = [{
  id: SEED.product1.id,
  product_id: SEED.product1.id,
  name: SEED.product1.name,
  qty: 1,
  price: SEED.product1.price,
  tax_rate: SEED.product1.tax_rate,
  category_id: SEED.category.id,
}];

const registerContext = {
  version: 2,
  scope: { kind: 'register', id: null },
  selectedOrderType: null,
  hashNumber: '',
  customerPhone: '',
  customerName: '',
  customerAddress: '',
  orderDate: '',
  restoredHeldReference: '',
  taxRegistrationType: null,
  subscriptionPurchase: null,
};

const pathOf = value => new URL(value).pathname;
const yieldTwoFrames = page => page.evaluate(() => new Promise(resolve => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
}));

function seedRegisterCart(page) {
  return page.addInitScript(({ savedCart, context }) => {
    localStorage.setItem('pos_cart', JSON.stringify(savedCart));
    localStorage.setItem('pos_order_context', JSON.stringify(context));
  }, { savedCart: cart, context: registerContext });
}

async function gateInitialShiftCheck(page) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let seen;
  const ready = new Promise(resolve => { seen = resolve; });
  await page.route(url => (
    url.pathname.endsWith('/api/auth/shifts')
    && url.searchParams.get('action') === 'check'
  ), async route => {
    const response = await route.fetch();
    seen();
    await gate;
    await route.fulfill({ response });
  });
  return { ready, release };
}

async function forwardSocketAfterOptionalFailure(page, { failFirst = false } = {}) {
  let attempt = 0;
  let handshakeSeen;
  const handshakeReady = new Promise(resolve => { handshakeSeen = resolve; });
  let generationAnswered;
  const generationAnswer = new Promise(resolve => { generationAnswered = resolve; });
  await page.routeWebSocket(/\/socket\.io\//, async socket => {
    attempt += 1;
    const dropThisConnection = failFirst && attempt === 1;
    const server = socket.connectToServer();
    let generationAskId = null;
    socket.onMessage(message => {
      const ask = typeof message === 'string' && message.match(/^42(\d+)\["catalog_generation"/);
      if (ask) generationAskId = ask[1];
      server.send(message);
    });
    server.onMessage(message => {
      socket.send(message);
      if (generationAskId !== null && typeof message === 'string' && message.startsWith(`43${generationAskId}[`)) generationAnswered();
      if (typeof message !== 'string' || !message.startsWith('40')) return;
      if (dropThisConnection) {
        void socket.close({ code: 1011, reason: 'initial connection failure test' });
      } else {
        handshakeSeen();
      }
    });
  });
  return { handshakeReady, generationAnswer, attempts: () => attempt };
}

// The Arabic dictionary is fetched as a hashed JSON asset (formerly a JS chunk).
const AR_DICTIONARY = /\/(?:assets|chunks)\/ar-[^/]+\.(?:json|js)(?:\?|$)/;

test.describe.serial('POS catalog refresh lifecycle', () => {
  let adminApi;
  let productBefore;
  let previousStockSetting;
  let auditFloor;
  let stockInvoiceId;
  let outsideInvoiceId;
  let adminShiftId;
  let tillShiftId;
  let navigationCategoryId;
  let navigationChildCategoryId;
  let navigationProductId;

  // Earlier specs (cashier.checkout) leave a cashier shift open and their own
  // sessions behind; start from the seeded state so this spec passes in any order.
  test.beforeAll(async () => {
    await reseedDatabase();
  });

  test.beforeEach(async () => {
    // Reuse the saved admin session: login is single-session, so a fresh
    // login here would revoke playwright/.auth/admin.json for later specs.
    adminApi = await requestFactory.newContext({ baseURL, storageState: 'playwright/.auth/admin.json' });
    [[productBefore]] = await pool.query(
      'SELECT is_available, background_color, stock FROM products WHERE id=?',
      [SEED.product1.id],
    );
    const [[stockSetting]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled'");
    previousStockSetting = stockSetting.setting_value;
    const [[audit]] = await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM audit_events');
    auditFloor = Number(audit.id);
    stockInvoiceId = null;
    outsideInvoiceId = null;
    adminShiftId = null;
    tillShiftId = null;
    navigationCategoryId = null;
    navigationChildCategoryId = null;
    navigationProductId = null;
  });

  test.afterEach(async () => {
    if (navigationProductId) {
      await adminApi.delete('/api/admin/products', { data: { id: navigationProductId } });
    }
    if (navigationChildCategoryId) {
      await adminApi.delete('/api/admin/categories', { data: { id: navigationChildCategoryId } });
    }
    if (navigationCategoryId) {
      await adminApi.delete('/api/admin/categories', { data: { id: navigationCategoryId } });
    }
    if (outsideInvoiceId) {
      await pool.query('DELETE FROM print_queue WHERE payload LIKE ?', [`%"invoice_id":${outsideInvoiceId}%`]);
      await pool.query("DELETE FROM audit_events WHERE entity_type='order' AND entity_id=?", [outsideInvoiceId]);
      await pool.query('DELETE FROM orders WHERE invoice_id=?', [outsideInvoiceId]);
    }
    if (stockInvoiceId) {
      await pool.query('DELETE FROM print_queue WHERE payload LIKE ?', [`%"invoice_id":${stockInvoiceId}%`]);
      await pool.query("DELETE FROM audit_events WHERE entity_type='order' AND entity_id=?", [stockInvoiceId]);
      await pool.query('DELETE FROM orders WHERE invoice_id=?', [stockInvoiceId]);
    }
    if (adminShiftId) await pool.query('DELETE FROM shifts WHERE id=?', [adminShiftId]);
    if (tillShiftId) await pool.query('DELETE FROM shifts WHERE id=?', [tillShiftId]);
    await pool.query(
      'UPDATE products SET is_available=?, background_color=?, stock=? WHERE id=?',
      [productBefore.is_available, productBefore.background_color, productBefore.stock, SEED.product1.id],
    );
    await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='stock_enabled'", [previousStockSetting]);
    await pool.query(
      "DELETE FROM audit_events WHERE id > ? AND entity_type='product' AND entity_id=?",
      [auditFloor, SEED.product1.id],
    );
    if (navigationProductId) {
      await pool.query("DELETE FROM audit_events WHERE id > ? AND entity_type='product' AND entity_id=?", [auditFloor, navigationProductId]);
      await pool.query('DELETE FROM products WHERE id=?', [navigationProductId]);
    }
    if (navigationChildCategoryId) {
      await pool.query("DELETE FROM audit_events WHERE id > ? AND entity_type='category' AND entity_id=?", [auditFloor, navigationChildCategoryId]);
      await pool.query('DELETE FROM categories WHERE id=?', [navigationChildCategoryId]);
    }
    if (navigationCategoryId) {
      await pool.query("DELETE FROM audit_events WHERE id > ? AND entity_type='category' AND entity_id=?", [auditFloor, navigationCategoryId]);
      await pool.query('DELETE FROM categories WHERE id=?', [navigationCategoryId]);
    }
    await adminApi.dispose();
  });

  test('paints the static startup shell before the lazy register chunk arrives', async ({ page }) => {
    let releaseChunk;
    let markChunkRequested;
    const chunkRequested = new Promise(resolve => { markChunkRequested = resolve; });
    const chunkGate = new Promise(resolve => { releaseChunk = resolve; });
    await page.route(/\/chunks\/PosTerminal-[^/]+\.js$/, async route => {
      const response = await route.fetch();
      markChunkRequested();
      await chunkGate;
      await route.fulfill({ response });
    });
    // Optional dialogs stay off the startup path but are warmed at idle once the
    // terminal is up, so record when it mounts.
    await page.addInitScript(() => {
      new MutationObserver((_, observer) => {
        if (!document.querySelector('#pos-terminal-app')) return;
        window.__terminalMountedAt = performance.now();
        observer.disconnect();
      }).observe(document, { childList: true, subtree: true });
    });

    const navigation = page.goto('/pos');
    await chunkRequested;
    const shell = page.locator('#pos-boot-shell');
    await expect(shell).toBeVisible();

    releaseChunk();
    await navigation;
    await expect(shell).toHaveCount(0);
    await expect(page.locator('#pos-terminal-app')).toBeVisible();
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });

    const { mountedAt, startupResources } = await page.evaluate(() => ({
      mountedAt: window.__terminalMountedAt,
      startupResources: performance.getEntriesByType('resource').map(entry => ({ name: entry.name, startTime: entry.startTime })),
    }));
    expect(mountedAt).toBeGreaterThan(0);
    const fetchedBeforeMount = pattern => startupResources.some(entry => pattern.test(entry.name) && entry.startTime < mountedAt);
    expect(startupResources.some(entry => AR_DICTIONARY.test(entry.name))).toBe(false);
    expect(fetchedBeforeMount(/TerminalSettingsModal-/)).toBe(false);
    expect(fetchedBeforeMount(/ExpenseModal-/)).toBe(false);

    const startingCash = page.locator('input[placeholder="0.00"]');
    await startingCash.fill('50.00');
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await expect(startingCash).toBeHidden();
    const [[openedShift]] = await pool.query(
      'SELECT id FROM shifts WHERE user_id=? AND status=\'open\' ORDER BY id DESC LIMIT 1',
      [SEED.cashierUser.id],
    );
    adminShiftId = Number(openedShift.id);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Terminal Setup', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Terminal Setup', exact: true })).toBeVisible();
    const settingsResources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    expect(settingsResources.some(name => /TerminalSettingsModal-/.test(name))).toBe(true);
  });

  test('loads the Arabic catalog before mounting an Arabic POS', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pos_admin_language', 'ar'));
    await page.route('**/api/system/settings', async route => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, admin_language: 'ar' } });
    });

    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByPlaceholder('ابحث عن الأصناف...')).toBeVisible();
    const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    expect(resources.some(name => AR_DICTIONARY.test(name))).toBe(true);
  });

  test('loads Arabic translations before a receipt preview can print', async ({ page }) => {
    await page.addInitScript(() => {
      window.__printCalls = 0;
      window.print = () => { window.__printCalls += 1; };
      localStorage.setItem('pos_admin_language', 'ar');
      localStorage.setItem('pos_print_payload', JSON.stringify({
        language: 'ar',
        type: 'z_report',
        data: {
          shift_id: 77,
          cashier_name: 'Fixture Cashier',
          storeInfo: { store_name: 'Fixture Store' },
          gross_sales: 0,
          cash_sales: 0,
          card_sales: 0,
          starting_cash: 0,
          expected_cash: 0,
        },
      }));
    });

    await page.goto('/print_receipt.html');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByText('Fixture Store', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
    const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    expect(resources.some(name => AR_DICTIONARY.test(name))).toBe(true);
  });

  test('reopens recent categories without another catalog request or loading state', async ({ page }) => {
    const suffix = randomUUID().slice(0, 8);
    const categoryName = `Navigation ${suffix}`;
    const childCategoryName = `Navigation child ${suffix}`;
    const productName = `Cached item ${suffix}`;
    const category = await adminApi.post('/api/admin/categories', {
      data: { name: categoryName, parent_id: null, is_notes: false },
    });
    expect(category.ok()).toBe(true);
    navigationCategoryId = Number((await category.json()).id);

    const childCategory = await adminApi.post('/api/admin/categories', {
      data: { name: childCategoryName, parent_id: navigationCategoryId, is_notes: false },
    });
    expect(childCategory.ok()).toBe(true);
    navigationChildCategoryId = Number((await childCategory.json()).id);

    const product = await adminApi.post('/api/admin/products', {
      data: {
        name: productName,
        category_id: navigationChildCategoryId,
        price: 2,
        tax_rate: 0,
        jofotara_tax_category: 'O',
      },
    });
    expect(product.ok()).toBe(true);
    navigationProductId = Number((await product.json()).id);

    let navigationCategoryRequests = 0;
    let navigationChildRequests = 0;
    let releaseFirstCategoryResponse;
    let markFirstCategoryRequest;
    let heldFirstCategoryRequest = false;
    const firstCategoryRequest = new Promise(resolve => { markFirstCategoryRequest = resolve; });
    const firstCategoryResponseGate = new Promise(resolve => { releaseFirstCategoryResponse = resolve; });
    await page.route('**/api/pos/products?**', async route => {
      const url = new URL(route.request().url());
      const isFirstTargetCategory = !heldFirstCategoryRequest
        && url.searchParams.get('category_id') === String(navigationCategoryId);
      if (!isFirstTargetCategory) {
        await route.continue();
        return;
      }
      heldFirstCategoryRequest = true;
      const response = await route.fetch();
      markFirstCategoryRequest();
      await firstCategoryResponseGate;
      await route.fulfill({ response });
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/pos/products' && url.searchParams.get('category_id') === String(navigationCategoryId)) {
        navigationCategoryRequests += 1;
      }
      if (url.pathname === '/api/pos/products' && url.searchParams.get('subcategory_id') === String(navigationChildCategoryId)) {
        navigationChildRequests += 1;
      }
    });

    const initialShiftCheck = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/auth/shifts' && url.searchParams.get('action') === 'check';
    });
    await page.goto('/pos');
    await initialShiftCheck;
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    const startingCash = page.locator('input[placeholder="0.00"]');
    if (await startingCash.isVisible()) {
      await startingCash.fill('50');
      await page.getByRole('button', { name: /Start Shift/i }).click();
      await expect(startingCash).toBeHidden();
      const [[openedShift]] = await pool.query(
        "SELECT id FROM shifts WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1",
        [SEED.cashierUser.id],
      );
      adminShiftId = Number(openedShift?.id) || null;
    }
    const stage = page.locator('main.product-stage');
    const newCategory = page.getByRole('button', { name: categoryName, exact: true });

    await page.evaluate(() => {
      window.__catalogBusyPaint = new Promise(resolve => {
        document.addEventListener('click', () => {
          const startedAt = performance.now();
          const observeFrame = () => {
            const stage = document.querySelector('main.product-stage');
            if (stage?.getAttribute('aria-busy') === 'true') {
              requestAnimationFrame(() => resolve(performance.now() - startedAt));
              return;
            }
            requestAnimationFrame(observeFrame);
          };
          observeFrame();
        }, { capture: true, once: true });
      });
    });
    await newCategory.click();
    await firstCategoryRequest;
    // A hard miss shows only the thin loading bar: nothing that looks like a product.
    await expect(stage.locator('.catalog-refresh-indicator')).toBeVisible();
    await expect(stage.locator('.product-card')).toHaveCount(0);
    const loadingPaintMs = await page.evaluate(() => window.__catalogBusyPaint);
    console.log(`Catalog hard-miss loading paint: ${loadingPaintMs.toFixed(2)} ms`);
    const rtlIndicatorContained = await stage.locator('.catalog-refresh-indicator').evaluate(bar => {
      document.documentElement.dir = 'rtl';
      const stageRect = document.querySelector('main.product-stage').getBoundingClientRect();
      const rect = bar.getBoundingClientRect();
      return rect.width > 0 && rect.left >= stageRect.left && rect.right <= stageRect.right;
    });
    expect(rtlIndicatorContained).toBe(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await stage.locator('.catalog-refresh-indicator').evaluate(bar => getComputedStyle(bar, '::after').animationName)).toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
    releaseFirstCategoryResponse();
    await expect(page.locator('.product-card', { hasText: productName })).toBeVisible();
    const firstVisitRequests = navigationCategoryRequests;
    expect(firstVisitRequests).toBe(1);

    await page.getByRole('button', { name: childCategoryName, exact: true }).click();
    await expect(page.locator('.product-card', { hasText: productName })).toBeVisible();
    await expect(stage).toHaveAttribute('aria-busy', 'false');
    expect(navigationChildRequests).toBe(0);

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const seedCategory = page.getByRole('button', { name: SEED.category.name, exact: true });

    await seedCategory.click();
    await expect(page.locator('.product-card', { hasText: SEED.product1.name }).first()).toBeVisible();
    await expect(stage).toHaveAttribute('aria-busy', 'false');

    await newCategory.click();
    await expect(page.locator('.product-card', { hasText: productName })).toBeVisible();
    await expect(stage).toHaveAttribute('aria-busy', 'false');
    await yieldTwoFrames(page);
    expect(navigationCategoryRequests).toBe(firstVisitRequests);
    expect(navigationChildRequests).toBe(0);
  });

  test('uses one initial snapshot and sends nothing extra on disconnected focus', async ({ page }) => {
    await seedRegisterCart(page);
    await page.routeWebSocket(/\/socket\.io\//, socket => socket.close({ code: 1001, reason: 'offline acceptance case' }));

    const requests = [];
    page.on('request', request => {
      const path = pathOf(request.url());
      if (path === '/api/pos/products' || path === '/api/pos/category-prices/resolve') {
        requests.push(`${request.method()} ${path}`);
      }
    });
    const initialCatalog = page.waitForResponse(response => response.request().method() === 'GET' && pathOf(response.url()) === '/api/pos/products');
    const initialResolver = page.waitForResponse(response => response.request().method() === 'POST' && pathOf(response.url()) === '/api/pos/category-prices/resolve');
    await page.goto('/pos');
    await Promise.all([initialCatalog, initialResolver].map(async pending => (await pending).finished()));
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    await yieldTwoFrames(page);
    expect(requests.filter(value => value === 'GET /api/pos/products')).toHaveLength(1);
    expect(requests.filter(value => value === 'POST /api/pos/category-prices/resolve')).toHaveLength(1);

    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await yieldTwoFrames(page);
    expect(requests.filter(value => value === 'GET /api/pos/products')).toHaveLength(1);
    expect(requests.filter(value => value === 'POST /api/pos/category-prices/resolve')).toHaveLength(1);
  });

  test('keeps reconnect metadata and reconciles availability response ordering', async ({ page }) => {
    // Settle the first-connect generation check before changing the catalog. A
    // slow first connection (a loaded full run) otherwise asks after the category
    // below bumps the generation, and its recovery read replaces the held
    // reconnect read mid-test, reading the unavailable state and dropping the
    // pending availability overlay, so no final reconciliation read happens.
    let generationAskId = null;
    // The category below is a change the terminal missed while offline: drop its
    // broad inventory notice so only the reconnect read can recover it. A
    // delivered notice starts its own full read that races the held one.
    let dropCatalogNotices = false;
    let generationAnswered;
    const generationAnswer = new Promise(resolve => { generationAnswered = resolve; });
    await page.routeWebSocket(/\/socket\.io\//, socket => {
      const server = socket.connectToServer();
      socket.onMessage(message => {
        const ask = typeof message === 'string' && message.match(/^42(\d+)\["catalog_generation"/);
        if (ask) generationAskId = ask[1];
        server.send(message);
      });
      server.onMessage(message => {
        if (dropCatalogNotices && typeof message === 'string' && message.includes('"inventory_changed"')) return;
        socket.send(message);
        if (generationAskId !== null && typeof message === 'string' && message.startsWith(`43${generationAskId}[`)) generationAnswered();
      });
    });
    const initialCatalogReads = [];
    page.on('request', request => {
      if (request.method() === 'GET' && pathOf(request.url()) === '/api/pos/products') initialCatalogReads.push(request.url());
    });

    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    await generationAnswer;
    await yieldTwoFrames(page);
    // Nothing changed between the boot snapshot and the connect, so the check
    // must not have started a recovery read that could still be in flight.
    expect(initialCatalogReads).toHaveLength(1);
    const productCard = page.locator('.product-card').filter({ hasText: SEED.product1.name }).first();
    await expect(productCard).toBeVisible();

    dropCatalogNotices = true;
    const recoveryCategoryName = `Reconnect recovery ${randomUUID().slice(0, 8)}`;
    const category = await adminApi.post('/api/admin/categories', {
      data: { name: recoveryCategoryName, parent_id: null, is_notes: false },
    });
    expect(category.ok()).toBe(true);
    navigationCategoryId = Number((await category.json()).id);

    let releaseCatalog;
    let markCatalogCaptured;
    let capturedPayload;
    let heldReconnectCatalog = false;
    let reconciliationCatalogReads = 0;
    const catalogCaptured = new Promise(resolve => { markCatalogCaptured = resolve; });
    const catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
    await page.route('**/api/pos/products?**', async route => {
      if (heldReconnectCatalog) {
        reconciliationCatalogReads += 1;
        await route.continue();
        return;
      }
      heldReconnectCatalog = true;
      const headers = { ...route.request().headers() };
      delete headers['if-none-match'];
      const response = await route.fetch({ headers });
      const body = await response.body();
      capturedPayload = JSON.parse(body.toString('utf8'));
      markCatalogCaptured();
      await catalogGate;
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        body,
      });
    });

    const reconnectResponse = page.waitForResponse(response => (
      response.request().method() === 'GET' && pathOf(response.url()) === '/api/pos/products'
    ));
    await page.evaluate(() => window.dispatchEvent(new Event('socket_reconnected')));
    await catalogCaptured;
    dropCatalogNotices = false;
    expect(capturedPayload.categories.some(categoryRow => categoryRow.id === navigationCategoryId)).toBe(true);

    const nextAvailability = Number(productBefore.is_available) !== 1;
    const availability = await adminApi.patch(`/api/pos/products/${SEED.product1.id}/availability`, {
      data: { is_available: nextAvailability },
    });
    expect(availability.ok()).toBe(true);
    if (nextAvailability) await expect(productCard).not.toHaveClass(/product-card--sold-out/);
    else await expect(productCard).toHaveClass(/product-card--sold-out/);

    // Model a newer authoritative database state whose notification was missed.
    // The already-delivered socket event is now older than both the database and
    // the held reconnect response, so a final read must win over arrival order.
    await pool.query('UPDATE products SET is_available=? WHERE id=?', [
      Number(productBefore.is_available),
      SEED.product1.id,
    ]);

    releaseCatalog();
    await (await reconnectResponse).finished();
    await expect.poll(() => reconciliationCatalogReads).toBe(1);
    await expect(page.getByRole('button', { name: recoveryCategoryName, exact: true })).toBeVisible();
    if (Number(productBefore.is_available) === 1) await expect(productCard).not.toHaveClass(/product-card--sold-out/);
    else await expect(productCard).toHaveClass(/product-card--sold-out/);
  });

  test('checks the catalog generation when the first socket connection lands during the initial resolver', async ({ page }) => {
    await seedRegisterCart(page);

    let releaseSocket;
    const socketGate = new Promise(resolve => { releaseSocket = resolve; });
    let socketRouteSeen;
    const socketRouteReady = new Promise(resolve => { socketRouteSeen = resolve; });
    let socketHandshakeSeen;
    const socketHandshakeReady = new Promise(resolve => { socketHandshakeSeen = resolve; });
    let generationAskId = null;
    let generationAnswered;
    const generationAnswer = new Promise(resolve => { generationAnswered = resolve; });
    await page.routeWebSocket(/\/socket\.io\//, async socket => {
      socketRouteSeen();
      await socketGate;
      const server = socket.connectToServer();
      socket.onMessage(message => {
        const ask = typeof message === 'string' && message.match(/^42(\d+)\["catalog_generation"/);
        if (ask) generationAskId = ask[1];
        server.send(message);
      });
      server.onMessage(message => {
        socket.send(message);
        if (typeof message === 'string' && message.startsWith('40')) socketHandshakeSeen();
        if (generationAskId !== null && typeof message === 'string' && message.startsWith(`43${generationAskId}[`)) generationAnswered();
      });
    });

    let releaseInitialResolver;
    const resolverGate = new Promise(resolve => { releaseInitialResolver = resolve; });
    let initialResolverSeen;
    const initialResolverReady = new Promise(resolve => { initialResolverSeen = resolve; });
    let heldInitialResolver = false;
    await page.route('**/api/pos/category-prices/resolve', async route => {
      if (heldInitialResolver) {
        await route.continue();
        return;
      }
      heldInitialResolver = true;
      const response = await route.fetch();
      initialResolverSeen();
      await resolverGate;
      await route.fulfill({ response });
    });

    const requests = [];
    page.on('request', request => {
      const path = pathOf(request.url());
      if (path === '/api/pos/products' || path === '/api/pos/category-prices/resolve') {
        requests.push(`${request.method()} ${path}`);
      }
    });

    const navigation = page.goto('/pos');
    await Promise.all([socketRouteReady, initialResolverReady]);
    releaseSocket();
    await socketHandshakeReady;
    await yieldTwoFrames(page);
    releaseInitialResolver();
    await navigation;
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });

    // The connect is reconciled once the snapshot completes: the server's generation
    // answer equals the snapshot's (nothing changed in the gap), so no second read.
    // A moved or missing generation reads again (posBootCatalogOrder.spec.js).
    await generationAnswer;
    await yieldTwoFrames(page);
    await page.waitForTimeout(300);
    expect(requests.filter(value => value === 'GET /api/pos/products')).toHaveLength(1);
    expect(requests.filter(value => value === 'POST /api/pos/category-prices/resolve')).toHaveLength(1);
  });

  test('lets the initial snapshot own recovery when the first connection drops before bootstrap', async ({ page }) => {
    await seedRegisterCart(page);
    const shiftGate = await gateInitialShiftCheck(page);
    const socket = await forwardSocketAfterOptionalFailure(page, { failFirst: true });
    const requests = [];
    let settingsReads = 0;
    page.on('request', request => {
      const path = pathOf(request.url());
      if (path === '/api/pos/products' || path === '/api/pos/category-prices/resolve') {
        requests.push(`${request.method()} ${path}`);
      }
      if (request.method() === 'GET' && path === '/api/system/settings') settingsReads += 1;
    });

    const navigation = page.goto('/pos');
    await Promise.all([shiftGate.ready, socket.handshakeReady]);
    await yieldTwoFrames(page);
    expect(socket.attempts()).toBeGreaterThanOrEqual(2);
    // Only the early boot read, which starts before the shift check; the
    // reconnect must not abort it with a second read.
    expect(requests).toEqual(['GET /api/pos/products']);
    const settingsReadsDuringBoot = settingsReads;

    shiftGate.release();
    await navigation;
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    await expect.poll(() => requests.filter(value => value === 'POST /api/pos/category-prices/resolve').length).toBe(1);
    // The rest of the reconnect recovery runs once boot completes: settings (which
    // loaded before the drop) are read again, the catalog is not.
    await expect.poll(() => settingsReads).toBe(settingsReadsDuringBoot + 1);
    await yieldTwoFrames(page);
    await page.waitForTimeout(300);
    expect(requests.filter(value => value === 'GET /api/pos/products')).toHaveLength(1);
    expect(requests.filter(value => value === 'POST /api/pos/category-prices/resolve')).toHaveLength(1);
    expect(settingsReads).toBe(settingsReadsDuringBoot + 1);
  });

  test('keeps connected focus and targeted changes cheap while refreshing broad and stock changes correctly', async ({ page }) => {
    // A second category the till can open, holding a product no cart line uses.
    const suffix = randomUUID().slice(0, 8);
    const outsideCategoryName = `Outside ${suffix}`;
    const outsideCategory = await adminApi.post('/api/admin/categories', {
      data: { name: outsideCategoryName, parent_id: null, is_notes: false },
    });
    expect(outsideCategory.ok()).toBe(true);
    navigationCategoryId = Number((await outsideCategory.json()).id);
    const outsideProduct = await adminApi.post('/api/admin/products', {
      data: { name: `Outside item ${suffix}`, category_id: navigationCategoryId, price: 2, tax_rate: 0, jofotara_tax_category: 'O' },
    });
    expect(outsideProduct.ok()).toBe(true);
    navigationProductId = Number((await outsideProduct.json()).id);
    await pool.query('UPDATE products SET stock=10 WHERE id=?', [navigationProductId]);

    await seedRegisterCart(page);
    const shiftGate = await gateInitialShiftCheck(page);
    const socket = await forwardSocketAfterOptionalFailure(page);
    const requests = [];
    page.on('request', request => {
      const path = pathOf(request.url());
      if (path === '/api/pos/products' || path === '/api/pos/category-prices/resolve') {
        requests.push(`${request.method()} ${path}`);
      }
    });
    const navigation = page.goto('/pos');
    await Promise.all([shiftGate.ready, socket.handshakeReady]);
    shiftGate.release();
    await navigation;
    const productCard = page.locator('.product-card').filter({ hasText: SEED.product1.name }).first();
    await expect(productCard).toBeVisible();
    // The till needs an open shift to be clickable (a reseed leaves none).
    const startingCash = page.locator('input[placeholder="0.00"]');
    if (await startingCash.isVisible()) {
      await startingCash.fill('50');
      await page.getByRole('button', { name: /Start Shift/i }).click();
      await expect(startingCash).toBeHidden();
      const [[tillShift]] = await pool.query(
        "SELECT id FROM shifts WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1",
        [SEED.cashierUser.id],
      );
      tillShiftId = Number(tillShift?.id) || null;
    }
    // Settle the first-connect generation check before changing the catalog:
    // the terminal asks only after its first snapshot, so an ask that lands
    // after the availability bump below sees a newer generation and reads the
    // catalog once more.
    await socket.generationAnswer;
    await yieldTwoFrames(page);

    const count = value => requests.filter(entry => entry === value).length;
    const beforeAvailability = {
      catalog: count('GET /api/pos/products'),
      resolver: count('POST /api/pos/category-prices/resolve'),
    };
    const nextAvailability = Number(productBefore.is_available) !== 1;
    const availability = await adminApi.patch(`/api/pos/products/${SEED.product1.id}/availability`, {
      data: { is_available: nextAvailability },
    });
    expect(availability.ok()).toBe(true);
    if (nextAvailability) await expect(productCard).not.toHaveClass(/product-card--sold-out/);
    else await expect(productCard).toHaveClass(/product-card--sold-out/);
    expect(count('GET /api/pos/products')).toBe(beforeAvailability.catalog);
    expect(count('POST /api/pos/category-prices/resolve')).toBe(beforeAvailability.resolver);

    const restoreAvailability = await adminApi.patch(`/api/pos/products/${SEED.product1.id}/availability`, {
      data: { is_available: Number(productBefore.is_available) === 1 },
    });
    expect(restoreAvailability.ok()).toBe(true);
    if (Number(productBefore.is_available) === 1) await expect(productCard).not.toHaveClass(/product-card--sold-out/);
    else await expect(productCard).toHaveClass(/product-card--sold-out/);

    const baseline = {
      catalog: count('GET /api/pos/products'),
      resolver: count('POST /api/pos/category-prices/resolve'),
    };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await yieldTwoFrames(page);
    expect(count('GET /api/pos/products')).toBe(baseline.catalog);
    expect(count('POST /api/pos/category-prices/resolve')).toBe(baseline.resolver);

    const reconnectCatalog = page.waitForResponse(response => response.request().method() === 'GET' && pathOf(response.url()) === '/api/pos/products');
    const reconnectResolver = page.waitForResponse(response => response.request().method() === 'POST' && pathOf(response.url()) === '/api/pos/category-prices/resolve');
    await page.evaluate(() => window.dispatchEvent(new Event('socket_reconnected')));
    await Promise.all([reconnectCatalog, reconnectResolver].map(async pending => (await pending).finished()));
    expect(count('GET /api/pos/products')).toBe(baseline.catalog + 1);
    expect(count('POST /api/pos/category-prices/resolve')).toBe(baseline.resolver + 1);

    const legacyCatalog = page.waitForResponse(response => response.request().method() === 'GET' && pathOf(response.url()) === '/api/pos/products');
    const legacyResolver = page.waitForResponse(response => response.request().method() === 'POST' && pathOf(response.url()) === '/api/pos/category-prices/resolve');
    const legacyMutation = await adminApi.put('/api/admin/products', {
      data: { id: SEED.product1.id, background_color: productBefore.background_color },
    });
    expect(legacyMutation.ok()).toBe(true);
    await Promise.all([legacyCatalog, legacyResolver].map(async pending => (await pending).finished()));
    expect(count('GET /api/pos/products')).toBe(baseline.catalog + 2);
    expect(count('POST /api/pos/category-prices/resolve')).toBe(baseline.resolver + 2);

    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
    await pool.query("UPDATE shifts SET status='closed', closed_at=NOW() WHERE user_id=? AND status='open'", [SEED.adminUser.id]);
    const shift = await adminApi.post('/api/auth/shifts?action=open', {
      data: { user_id: SEED.adminUser.id, starting_cash: 0 },
    });
    const shiftData = await shift.json();
    expect(shift.ok(), JSON.stringify(shiftData)).toBe(true);
    adminShiftId = Number(shiftData.shift_id);
    const stockCatalog = page.waitForResponse(response => response.request().method() === 'GET' && pathOf(response.url()) === '/api/pos/products');
    const stockResolverBefore = count('POST /api/pos/category-prices/resolve');
    const checkout = await adminApi.post('/api/pos/checkout', {
      data: {
        cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
        subtotal: 5,
        tax: 0.8,
        total: 5.8,
        shift_id: adminShiftId,
        payment_method: 'cash',
        amount_tendered: 10,
        change_due: 4.2,
        idempotency_key: `e2e-stock-scope-${randomUUID()}`,
      },
    });
    const checkoutData = await checkout.json();
    expect(checkout.ok(), JSON.stringify(checkoutData)).toBe(true);
    stockInvoiceId = Number(checkoutData.invoice_id);
    await (await stockCatalog).finished();
    await yieldTwoFrames(page);
    expect(count('GET /api/pos/products')).toBe(baseline.catalog + 3);
    expect(count('POST /api/pos/category-prices/resolve')).toBe(stockResolverBefore);

    // Open the outside category once so the till caches it, then return.
    const outsideCategoryTab = page.getByRole('button', { name: outsideCategoryName, exact: true });
    const firstOutsideRead = page.waitForResponse(response => response.request().method() === 'GET' && pathOf(response.url()) === '/api/pos/products');
    await outsideCategoryTab.click();
    await (await firstOutsideRead).finished();
    await page.getByRole('button', { name: SEED.category.name, exact: true }).click();
    await expect(productCard).toBeVisible();
    await yieldTwoFrames(page);
    const beforeOutsideSale = count('GET /api/pos/products');
    expect(beforeOutsideSale).toBe(baseline.catalog + 4);

    // A sale of a product outside the loaded category reads nothing on this till.
    const outsideCheckout = await adminApi.post('/api/pos/checkout', {
      data: {
        cart: [{ id: navigationProductId, qty: 1, price: 2 }],
        subtotal: 2, tax: 0, total: 2, shift_id: adminShiftId, payment_method: 'cash',
        amount_tendered: 2, change_due: 0, idempotency_key: `e2e-stock-outside-${randomUUID()}`,
      },
    });
    const outsideData = await outsideCheckout.json();
    expect(outsideCheckout.ok(), JSON.stringify(outsideData)).toBe(true);
    outsideInvoiceId = Number(outsideData.invoice_id);
    await page.waitForTimeout(600);
    await yieldTwoFrames(page);
    expect(count('GET /api/pos/products')).toBe(beforeOutsideSale);

    // Opening that category revalidates its cached rows exactly once.
    const revalidation = page.waitForResponse(response => response.request().method() === 'GET' && pathOf(response.url()) === '/api/pos/products');
    await outsideCategoryTab.click();
    await (await revalidation).finished();
    await yieldTwoFrames(page);
    expect(count('GET /api/pos/products')).toBe(beforeOutsideSale + 1);
  });
});
