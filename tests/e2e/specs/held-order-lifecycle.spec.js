import { test, expect, request as requestFactory } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import pool from '../../../backend/config/db.js';
import { SEED } from '../../../backend/tests/fixtures/seed.js';

const baseURL = 'http://localhost:3001';
const createdHeldIds = new Set();
let kitchenPrinterId = null;

const token = () => randomBytes(32).toString('hex');
const operation = (prefix) => `${prefix}-${randomUUID()}`;
const holdRequestId = () => `e2e-${randomUUID()}`;
const cartFor = (qty = 1) => ({
  items: [{
    id: SEED.product1.id,
    product_id: SEED.product1.id,
    name: SEED.product1.name,
    qty,
    price: SEED.product1.price,
    tax_rate: SEED.product1.tax_rate,
    category_id: SEED.category.id,
  }],
});

async function json(response) {
  return response.json().catch(() => ({}));
}

async function createHold(api, reference, cart = cartFor(), requestId = holdRequestId()) {
  const response = await api.post('/api/pos/held_orders', {
    data: {
      hold_request_id: requestId,
      reference_name: reference,
      cart,
      subtotal: SEED.product1.price * Number(cart.items[0]?.qty || 1),
    },
  });
  const data = await json(response);
  expect(response.ok(), JSON.stringify(data)).toBe(true);
  createdHeldIds.add(Number(data.id));
  return data;
}

// beforeEach removes the cashier's shift, so the opening overlay always
// appears once the shift check settles. Waiting for it (instead of a one-shot
// isVisible probe that can run before the check finishes) keeps it from
// intercepting the next click.
async function openShift(page) {
  const startingCash = page.locator('.shift-opening-overlay input[placeholder="0.00"]');
  await expect(startingCash).toBeVisible();
  await startingCash.fill('0');
  await page.getByRole('button', { name: /Start Shift/i }).click();
  await expect(page.locator('.shift-opening-overlay')).toBeHidden();
}

async function claimHold(api, id, claimToken = token(), expectedVersion = 1) {
  const response = await api.post(`/api/pos/held_orders/${id}/claim`, {
    data: { claim_token: claimToken, expected_version: expectedVersion },
  });
  const data = await json(response);
  expect(response.ok(), JSON.stringify(data)).toBe(true);
  return {
    response,
    data,
    token: claimToken,
    version: Number(data.claim?.version || data.order?.version),
    cart: JSON.parse(data.order.cart_data || '{}'),
  };
}

test.describe.serial('Held-order lifecycle recovery', () => {
  test.beforeAll(async () => {
    const [printer] = await pool.query(
      "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('E2E Held Kitchen', 'kitchen', 'windows', 'E2E Held Kitchen', 'e2e-held')"
    );
    kitchenPrinterId = printer.insertId;
    await pool.query('INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)', [kitchenPrinterId, SEED.category.id]);
  });

  test.beforeEach(async () => {
    await pool.query('DELETE FROM shifts WHERE user_id=?', [SEED.cashierUser.id]);
  });

  test.afterEach(async () => {
    const ids = [...createdHeldIds].filter(Number.isSafeInteger);
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      await pool.query(`DELETE FROM audit_events WHERE entity_type='held_order' AND entity_id IN (${marks})`, ids);
      await pool.query(`DELETE FROM print_queue WHERE payload LIKE ?`, [`%"order_id":${ids[0]}%`]);
      await pool.query(`DELETE FROM held_orders WHERE id IN (${marks})`, ids);
    }
    createdHeldIds.clear();
    await pool.query('DELETE FROM shifts WHERE user_id=?', [SEED.cashierUser.id]);
  });

  test.afterAll(async () => {
    if (!kitchenPrinterId) return;
    await pool.query('DELETE FROM printer_categories WHERE printer_id=?', [kitchenPrinterId]);
    await pool.query('DELETE FROM printers WHERE id=?', [kitchenPrinterId]);
  });

  test('replays a lost create response and restores the same row through a browser refresh', async ({ page }) => {
    const reference = `E2E refresh ${Date.now()}`;
    const requestId = holdRequestId();
    const first = await createHold(page.request, reference, cartFor(), requestId);
    const retry = await createHold(page.request, reference, cartFor(), requestId);
    expect(retry).toMatchObject({ id: first.id, version: 1, replay: true });

    // Exercise the real cached-terminal path: POS mounts once, is deactivated
    // through its Held button, then is reactivated by Restore.
    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    await openShift(page);
    await page.locator('button.cart-nav-action').filter({ hasText: 'Held' }).click();
    await expect(page).toHaveURL(/\/order-notes(?:\?.*)?$/);
    const card = page.locator('.note-card').filter({ hasText: reference });
    await expect(card).toBeVisible();

    const restoreRequests = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/pos/products' || path === '/api/pos/category-prices/resolve' || path.endsWith('/claim')) {
        restoreRequests.push(`${request.method()} ${path}`);
      }
    });
    const claimResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/pos/held_orders/${first.id}/claim`
    ));
    await card.getByRole('button', { name: 'Restore' }).click();
    await expect(page).toHaveURL(/\/pos(?:\?.*)?$/);
    const claimResponse = await claimResponsePromise;
    await claimResponse.finished();
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    await expect.poll(() => page.evaluate(() => {
      const raw = localStorage.getItem('pos_order_context');
      return raw ? JSON.parse(raw)?.heldOrder?.id || null : null;
    })).toBe(first.id);
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    // Since 5fe93a76 a clean keep-alive return issues no catalog read: nothing
    // dirtied the catalog while POS was inactive, and the claim returns the
    // server-canonical cart, so restoring costs exactly one claim.
    expect(restoreRequests.filter(request => request === 'GET /api/pos/products')).toHaveLength(0);
    expect(restoreRequests.filter(request => request.endsWith('/claim'))).toHaveLength(1);
    expect(restoreRequests.filter(request => request === 'POST /api/pos/category-prices/resolve')).toHaveLength(0);

    const contextAfterRestore = await page.evaluate((id) => {
      const raw = localStorage.getItem('pos_order_context');
      const context = raw ? JSON.parse(raw) : null;
      return {
        id: context?.heldOrder?.id,
        scope: context?.scope?.kind,
        cart: JSON.parse(localStorage.getItem('pos_cart') || '[]'),
        matches: Number(context?.heldOrder?.id) === Number(id),
      };
    }, first.id);
    expect(contextAfterRestore).toMatchObject({ id: first.id, scope: 'held', matches: true });
    expect(contextAfterRestore.cart).toHaveLength(1);

    await page.reload();
    await expect.poll(() => page.evaluate(() => {
      const raw = localStorage.getItem('pos_order_context');
      return raw ? JSON.parse(raw)?.heldOrder?.id || null : null;
    })).toBe(first.id);

    const [[row]] = await pool.query(
      'SELECT id, version, claimed_by_user_id, claim_token_hash FROM held_orders WHERE id=?',
      [first.id]
    );
    // Claiming also persists the server-canonical cart, so the durable row
    // advances once for the lease and once for canonicalization.
    expect(row).toMatchObject({ id: first.id, version: 3, claimed_by_user_id: SEED.cashierUser.id });
    expect(row.claim_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('re-resolves a local fallback when a successful claim omits its authoritative cart', async ({ page }) => {
    const reference = `E2E fallback ${Date.now()}`;
    const created = await createHold(page.request, reference);

    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    await openShift(page);
    await page.locator('button.cart-nav-action').filter({ hasText: 'Held' }).click();
    const card = page.locator('.note-card').filter({ hasText: reference });
    await expect(card).toBeVisible();

    await page.route(`**/api/pos/held_orders/${created.id}/claim`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      delete body.order.cart_data;
      await route.fulfill({ response, json: body });
    });
    const resolverRequests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/pos/category-prices/resolve') {
        resolverRequests.push(request.url());
      }
    });

    // The held cart and the POS catalog snapshot both carry the seed price;
    // raise the durable catalog price so only a real re-resolve can show it.
    const currentPrice = SEED.product1.price + 1.5;
    await pool.query('UPDATE products SET price=? WHERE id=?', [currentPrice, SEED.product1.id]);
    try {
      const resolveResponse = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/pos/category-prices/resolve'
      ));
      await card.getByRole('button', { name: 'Restore' }).click();
      await expect(page).toHaveURL(/\/pos(?:\?.*)?$/);
      await (await resolveResponse).finished();

      // Tax-exclusive pricing: the line's net cell shows unit price x qty (1).
      const line = page.locator('tr').filter({ has: page.locator('.cart-item-name', { hasText: SEED.product1.name }) });
      await expect(line).toHaveCount(1);
      await expect(line.locator('td').nth(2)).toHaveText(currentPrice.toFixed(2));

      // Settle before counting so a duplicate resolve started after the first
      // one landed would still be caught.
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      await page.waitForTimeout(300);
      expect(resolverRequests).toHaveLength(1);
    } finally {
      await pool.query('UPDATE products SET price=? WHERE id=?', [SEED.product1.price, SEED.product1.id]);
    }
  });

  test('keeps held-claim canonicalization while reconciling a delayed first connection', async ({ page }) => {
    const heldCart = cartFor();
    const created = await createHold(page.request, `E2E delayed held socket ${Date.now()}`, heldCart);
    const claimToken = token();
    await page.addInitScript(({ id, expectedVersion, tokenValue, cartData }) => {
      localStorage.setItem('pos_restore_held_order', JSON.stringify({
        heldOrderId: id,
        expectedVersion,
        claimToken: tokenValue,
        cartData,
      }));
    }, {
      id: Number(created.id),
      expectedVersion: 1,
      tokenValue: claimToken,
      cartData: JSON.stringify(heldCart),
    });

    let releaseSocket;
    const socketGate = new Promise(resolve => { releaseSocket = resolve; });
    let socketHandshakeSeen;
    const socketHandshakeReady = new Promise(resolve => { socketHandshakeSeen = resolve; });
    let generationAskId = null;
    let generationAnswered;
    const generationAnswer = new Promise(resolve => { generationAnswered = resolve; });
    await page.routeWebSocket(/\/socket\.io\//, async socket => {
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

    let releaseInitialCatalog;
    const catalogGate = new Promise(resolve => { releaseInitialCatalog = resolve; });
    let initialCatalogSeen;
    const initialCatalogReady = new Promise(resolve => { initialCatalogSeen = resolve; });
    let heldInitialCatalog = false;
    await page.route(url => url.pathname === '/api/pos/products', async route => {
      if (heldInitialCatalog) {
        await route.continue();
        return;
      }
      heldInitialCatalog = true;
      const response = await route.fetch();
      initialCatalogSeen();
      await catalogGate;
      await route.fulfill({ response });
    });

    const requests = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/pos/products' || path === '/api/pos/category-prices/resolve' || path.endsWith(`/held_orders/${created.id}/claim`)) {
        requests.push(`${request.method()} ${path}`);
      }
    });

    const navigation = page.goto('/pos');
    await initialCatalogReady;
    releaseSocket();
    await socketHandshakeReady;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    releaseInitialCatalog();
    await navigation;
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });

    // Since 9dd8b293 the first connect asks the socket for catalog_generation
    // and skips the re-read when it equals the boot snapshot's; nothing changed
    // the catalog here, so the delayed connection reconciles without a second read.
    // Settle on the generation answer first: a redundant read would start right
    // after it, so counting before it lands could not catch one.
    await generationAnswer;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(300);
    expect(requests.filter(value => value === 'GET /api/pos/products')).toHaveLength(1);
    expect(requests.filter(value => value === 'POST /api/pos/category-prices/resolve')).toHaveLength(1);
    expect(requests.filter(value => value.endsWith(`/held_orders/${created.id}/claim`))).toHaveLength(1);
  });

  test('enforces one terminal lease while the other terminal cannot fire, save, or clear', async ({ page }) => {
    const created = await createHold(page.request, `E2E conflict ${Date.now()}`);
    const first = await claimHold(page.request, created.id);
    const terminalB = await requestFactory.newContext({ baseURL });
    try {
      const login = await terminalB.post('/api/auth/login', { data: { user_number: SEED.waiterUser.user_number } });
      expect(login.ok()).toBe(true);

      const secondClaim = await terminalB.post(`/api/pos/held_orders/${created.id}/claim`, {
        data: { claim_token: token(), expected_version: first.version },
      });
      expect(secondClaim.status()).toBe(409);
      expect((await json(secondClaim)).code).toBe('HELD_IN_USE');

      const fire = await terminalB.post('/api/pos/held_orders/fire_kitchen', {
        data: { id: created.id, operation_id: operation('fire-b'), expected_version: first.version },
      });
      expect(fire.status()).toBe(409);
      expect((await json(fire)).code).toBe('HELD_IN_USE');

      const save = await terminalB.patch(`/api/pos/held_orders/${created.id}`, {
        data: {
          operation_id: operation('save-b'),
          claim_token: token(),
          expected_version: first.version,
          cart: first.cart,
        },
      });
      expect(save.status()).toBe(409);

      const clear = await terminalB.delete(`/api/pos/held_orders/${created.id}`, {
        data: {
          operation_id: operation('clear-b'),
          claim_token: token(),
          expected_version: first.version,
          confirmed: true,
          reason_code: 'customer_changed_mind',
        },
      });
      expect(clear.status()).toBe(409);

      const [[row]] = await pool.query('SELECT id, claimed_by_user_id FROM held_orders WHERE id=?', [created.id]);
      expect(row).toMatchObject({ id: created.id, claimed_by_user_id: SEED.cashierUser.id });
    } finally {
      await terminalB.dispose();
    }
  });

  test('replays the same save operation once and keeps checkout validation failures recoverable', async ({ page }) => {
    const created = await createHold(page.request, `E2E save ${Date.now()}`);
    const first = await claimHold(page.request, created.id);
    const savePayload = {
      operation_id: operation('save-replay'),
      claim_token: first.token,
      expected_version: first.version,
      cart: first.cart,
    };
    const saved = await page.request.patch(`/api/pos/held_orders/${created.id}`, { data: savePayload });
    const savedData = await json(saved);
    expect(saved.ok(), JSON.stringify(savedData)).toBe(true);
    const replay = await page.request.patch(`/api/pos/held_orders/${created.id}`, { data: savePayload });
    const replayData = await json(replay);
    expect(replay.ok(), JSON.stringify(replayData)).toBe(true);
    expect(replayData).toMatchObject({ id: created.id, version: savedData.version, replay: true });

    const [[audit]] = await pool.query(
      "SELECT COUNT(*) AS count FROM audit_events WHERE entity_type='held_order' AND entity_id=? AND event_type='held_order_updated'",
      [created.id]
    );
    expect(Number(audit.count)).toBe(1);

    const claimedAgain = await claimHold(page.request, created.id, token(), Number(savedData.version));
    const shift = await page.request.post('/api/auth/shifts?action=open', {
      data: { user_id: SEED.cashierUser.id, starting_cash: 50 },
    });
    const shiftData = await json(shift);
    expect(shift.ok(), JSON.stringify(shiftData)).toBe(true);
    const checkout = await page.request.post('/api/pos/checkout', {
      data: {
        cart: claimedAgain.cart.items,
        held_order_context: {
          id: created.id,
          claim_token: claimedAgain.token,
          expected_version: claimedAgain.version,
          operation_id: operation('checkout-failure'),
        },
        shift_id: shiftData.shift_id,
        subtotal: 5,
        tax: 0,
        total: 1,
        payment_method: 'cash',
        amount_tendered: 1,
        change_due: 0,
        idempotency_key: `e2e-checkout-failure-${created.id}`,
      },
    });
    expect(checkout.status()).toBeGreaterThanOrEqual(400);

    const [[row]] = await pool.query('SELECT id, claimed_by_user_id, claim_token_hash FROM held_orders WHERE id=?', [created.id]);
    expect(row).toMatchObject({ id: created.id, claimed_by_user_id: SEED.cashierUser.id });
    expect(row.claim_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('requires explicit baseline review for legacy fired rows and renders the review state', async ({ page }) => {
    const reference = `E2E legacy ${Date.now()}`;
    const [inserted] = await pool.query(
      `INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal, kitchen_fired)
       VALUES (?, ?, ?, 5, 1)`,
      [SEED.cashierUser.id, reference, JSON.stringify(cartFor())]
    );
    const id = inserted.insertId;
    createdHeldIds.add(id);

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/order-notes');
    await page.evaluate(() => localStorage.setItem('pos_theme', 'dark'));
    await page.reload();
    const card = page.locator('.note-card').filter({ hasText: reference });
    await expect(card).toBeVisible();
    await expect(card.locator('.note-card__baseline')).toBeVisible();
    await expect(page.locator('.order-notes-page.pos-theme-dark')).toBeVisible();

    const claimed = await claimHold(page.request, id, token());
    const blocked = await page.request.post(`/api/pos/held_orders/${id}/follow-up`, {
      data: {
        operation_id: operation('legacy-follow-up'),
        claim_token: claimed.token,
        expected_version: claimed.version,
        cart: claimed.cart,
      },
    });
    expect(blocked.status()).toBe(409);
    expect((await json(blocked)).code).toBe('HELD_KITCHEN_BASELINE_UNKNOWN');

    const confirmed = await page.request.post(`/api/pos/held_orders/${id}/baseline-confirm`, {
      data: {
        operation_id: operation('legacy-baseline'),
        claim_token: claimed.token,
        expected_version: claimed.version,
        confirmed: true,
        reason_code: 'manual_review',
        cart: claimed.cart,
      },
    });
    const confirmedData = await json(confirmed);
    expect(confirmed.ok(), JSON.stringify(confirmedData)).toBe(true);
    expect(confirmedData).toMatchObject({ id, printed: false, replay: false });
    const [[row]] = await pool.query('SELECT kitchen_snapshot, claimed_by_user_id FROM held_orders WHERE id=?', [id]);
    expect(JSON.parse(row.kitchen_snapshot)).toMatchObject({ held_id: id, baseline_unknown: false });
    expect(row.claimed_by_user_id).toBeNull();
  });

  test('queues only a deterministic FOLLOW UP delta and one cancellation ticket', async ({ page }) => {
    // Since 802da770 a hold without a delivery_date fires its first kitchen
    // round at creation, so the row is already fired; firing again would 409.
    const created = await createHold(page.request, `E2E rounds ${Date.now()}`);
    expect(created).toMatchObject({ kitchen_fired: true, kitchen_dispatch_version: 1 });
    const [[createdRow]] = await pool.query(
      'SELECT version, kitchen_fired, kitchen_dispatch_version FROM held_orders WHERE id=?',
      [created.id]
    );
    expect(createdRow).toMatchObject({ kitchen_fired: 1, kitchen_dispatch_version: 1 });

    const claimed = await claimHold(page.request, created.id, token(), Number(createdRow.version));
    const followUpCart = JSON.parse(JSON.stringify(claimed.cart));
    followUpCart.items[0].qty = 2;
    const followUpPayload = {
      operation_id: operation('follow-up'),
      claim_token: claimed.token,
      expected_version: claimed.version,
      cart: followUpCart,
    };
    const followUp = await page.request.post(`/api/pos/held_orders/${created.id}/follow-up`, { data: followUpPayload });
    const followUpData = await json(followUp);
    expect(followUp.ok(), JSON.stringify(followUpData)).toBe(true);
    expect(followUpData).toMatchObject({ id: created.id, status: 'queued', followUpSequence: 2 });

    await pool.query('UPDATE printers SET name=? WHERE id=?', ['E2E Held Kitchen Renamed', kitchenPrinterId]);
    const replay = await page.request.post(`/api/pos/held_orders/${created.id}/follow-up`, { data: followUpPayload });
    const replayData = await json(replay);
    expect(replay.ok(), JSON.stringify(replayData)).toBe(true);
    expect(replayData).toMatchObject({ id: created.id, replay: true, version: followUpData.version });

    const [followUpJobs] = await pool.query(
      "SELECT payload FROM print_queue WHERE idempotency_key LIKE ? ORDER BY id",
      [`kitchen:${followUpData.batchId}:%`]
    );
    expect(followUpJobs).toHaveLength(1);
    const followUpPayloadData = JSON.parse(followUpJobs[0].payload).data;
    expect(followUpPayloadData).toMatchObject({ follow_up: true, follow_up_sequence: 2 });
    expect(followUpPayloadData.items).toHaveLength(1);
    expect(Number(followUpPayloadData.items[0].qty)).toBe(1);

    const claimedForCancel = await claimHold(page.request, created.id, token(), Number(followUpData.version));
    const canceled = await page.request.delete(`/api/pos/held_orders/${created.id}`, {
      data: {
        operation_id: operation('cancel-fired'),
        claim_token: claimedForCancel.token,
        expected_version: claimedForCancel.version,
        confirmed: true,
        reason_code: 'customer_changed_mind',
      },
    });
    const canceledData = await json(canceled);
    expect(canceled.ok(), JSON.stringify(canceledData)).toBe(true);
    expect(canceledData).toMatchObject({ id: created.id, canceled: true, cancellation_ticket_count: 1 });

    const [cancelJobs] = await pool.query(
      "SELECT payload FROM print_queue WHERE idempotency_key LIKE ?",
      [`kitchen:${canceledData.cancellation_batch_id}:%`]
    );
    expect(cancelJobs).toHaveLength(1);
    const cancelPayload = JSON.parse(cancelJobs[0].payload).data;
    expect(cancelPayload).toMatchObject({ cancel_ticket: true, follow_up: false });
    expect(Number(cancelPayload.items[0].qty)).toBe(2);
    const [[row]] = await pool.query('SELECT id FROM held_orders WHERE id=?', [created.id]);
    expect(row).toBeUndefined();
  });
});
