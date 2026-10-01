import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pool from '../../../backend/config/db.js';
import { SEED } from '../../../backend/tests/fixtures/seed.js';

const baseURL = 'http://localhost:3001';
const setupPhonePin = '9088';
const secondPhonePin = '9089';
const customerPhone = '0798800880';
let sourceUserId;
let intakeActorUserId;
let secondWorkerId;
let heldOrderId;
let kitchenPrinterId;
let intakeHeldOrderId;

const relevantAuthorityPath = (url) => /\/api\/(?:pos\/(?:checkout|log_drawer_pop)|print\/print|admin\/jofotara)/.test(url);

async function waitForPos(page) {
  await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
}

async function completeIntake(page, { phone = customerPhone, name = 'Phone Customer', address = 'Amman 7th Circle' } = {}) {
  const intake = page.getByRole('dialog', { name: 'New Phone Order' });
  await expect(intake).toBeVisible();
  await intake.getByLabel('Mobile No.').fill(phone);
  await intake.getByLabel('Name').fill(name);
  await intake.getByLabel('Address').fill(address);
  await intake.getByLabel('Scheduled Date & Time').fill('2099-08-12T18:30');
  await intake.getByRole('button', { name: 'Start Order' }).click();
  await expect(intake).toBeHidden();
}

async function findPhoneOrder(page, id) {
  const intake = page.getByRole('dialog', { name: 'New Phone Order' });
  await intake.getByLabel('Mobile No.').fill(customerPhone);
  await intake.getByRole('button', { name: 'Find active phone orders' }).click();
  const match = intake.getByRole('button').filter({ hasText: `Phone #${id}` });
  await expect(match).toBeVisible();
  return match;
}

async function findAndContinue(page, id) {
  const match = await findPhoneOrder(page, id);
  await match.click();
  await expect(page.getByRole('dialog', { name: 'New Phone Order' })).toBeHidden();
}

async function loginAs(page, userNumber) {
  const response = await page.request.post('/api/auth/login', { data: { user_number: userNumber } });
  expect(response.ok(), await response.text()).toBe(true);
}

async function expireClaimForBrowser(page, id, { bumpVersion = false } = {}) {
  await pool.query(
    `UPDATE held_orders
        SET claim_expires_at=DATE_SUB(NOW(), INTERVAL 1 MINUTE)
            ${bumpVersion ? ', version=version+1' : ''}
      WHERE id=?`,
    [id],
  );
  await page.evaluate(() => {
    const context = JSON.parse(localStorage.getItem('pos_order_context') || 'null');
    if (!context?.heldOrder) throw new Error('Expected persisted held-order context');
    context.heldOrder.claimExpiresAt = '2000-01-01T00:00:00.000Z';
    localStorage.setItem('pos_order_context', JSON.stringify(context));
  });
  await page.reload();
  await waitForPos(page);
}

async function expectInsideViewport(locator, width, height) {
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    return box ? box.x : Number.NEGATIVE_INFINITY;
  }, { timeout: 2000 }).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    return box ? box.y : Number.NEGATIVE_INFINITY;
  }, { timeout: 2000 }).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    return box ? box.x + box.width : Number.POSITIVE_INFINITY;
  }, { timeout: 2000 }).toBeLessThanOrEqual(width);
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    return box ? box.y + box.height : Number.POSITIVE_INFINITY;
  }, { timeout: 2000 }).toBeLessThanOrEqual(height);
}

async function expectProductQuantity(page, productName, expectedQuantity) {
  await expect.poll(async () => page.locator('.cart-items-scroll tbody tr')
    .filter({ hasText: productName })
    .evaluateAll(rows => rows.reduce((total, row) => {
      const quantity = Number(row.querySelectorAll('td')[1]?.textContent?.trim());
      return total + (Number.isFinite(quantity) ? quantity : 0);
    }, 0)), { timeout: 5000 }).toBe(expectedQuantity);
}

test.describe.serial('Call-center held-order workflow', () => {
  test.beforeAll(async () => {
    [[{ id: sourceUserId }]] = await pool.query('SELECT id FROM users WHERE user_number=?', [setupPhonePin]);
    if (process.env.ORDER_INTAKE_E2E === '1') {
      [[{ id: intakeActorUserId }]] = await pool.query("SELECT id FROM users WHERE user_number='9070'");
    }
    await pool.query('DELETE FROM users WHERE user_number=?', [secondPhonePin]);
    const [printer] = await pool.query(
      "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('E2E Phone Kitchen', 'kitchen', 'windows', 'E2E Phone Kitchen', 'e2e-phone')"
    );
    kitchenPrinterId = printer.insertId;
    await pool.query('INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)', [kitchenPrinterId, SEED.category.id]);
  });

  test.afterAll(async () => {
    if (heldOrderId) {
      await pool.query("DELETE FROM audit_events WHERE entity_type='held_order' AND entity_id=?", [heldOrderId]);
      await pool.query('DELETE FROM held_orders WHERE id=?', [heldOrderId]);
    }
    if (intakeHeldOrderId) {
      await pool.query("DELETE FROM audit_events WHERE entity_type='held_order' AND entity_id=?", [intakeHeldOrderId]);
      await pool.query('DELETE FROM held_orders WHERE id=?', [intakeHeldOrderId]);
    }
    await pool.query("DELETE FROM print_queue WHERE payload LIKE '%\"spooler_id\":\"e2e-phone\"%'");
    if (kitchenPrinterId) {
      await pool.query('DELETE FROM printer_categories WHERE printer_id=?', [kitchenPrinterId]);
      await pool.query('DELETE FROM printers WHERE id=?', [kitchenPrinterId]);
    }
    await pool.query('DELETE FROM users WHERE user_number=?', [secondPhonePin]);
    if (process.env.ORDER_INTAKE_E2E === '1') {
      await pool.query("DELETE FROM users WHERE user_number='9070'");
    }
    await pool.query('DELETE FROM shifts WHERE user_id=?', [SEED.cashierUser.id]);
  });

  test('creates the fixed role in Admin and clears stale cashier state on a touch terminal', async ({ browser, page }) => {
    const admin = await browser.newContext({ baseURL, storageState: 'playwright/.auth/admin.json' });
    const adminPage = await admin.newPage();
    await adminPage.goto('/admin/users');
    await adminPage.getByRole('button', { name: 'Add User' }).click();
    const dialog = adminPage.getByRole('dialog', { name: 'Add New User' });
    await dialog.locator('input').nth(0).fill('E2E Second Phone Desk');
    await dialog.locator('input').nth(1).fill(secondPhonePin);
    await dialog.getByLabel('Role').selectOption('call_center');
    await expect(dialog.getByText('Permissions')).toHaveCount(0);
    await expect(dialog.getByText('Which dining sections this user can serve.')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await admin.close();

    [[{ id: secondWorkerId }]] = await pool.query('SELECT id FROM users WHERE user_number=?', [secondPhonePin]);
    const [[fixedRole]] = await pool.query(
      `SELECT u.role, u.allowed_sections, COUNT(up.user_id) AS grants,
              (SELECT COUNT(*) FROM shifts s WHERE s.user_id=u.id) AS shifts
         FROM users u LEFT JOIN user_permissions up ON up.user_id=u.id
        WHERE u.id=? GROUP BY u.id`,
      [secondWorkerId]
    );
    expect(fixedRole).toMatchObject({ role: 'call_center', allowed_sections: null, grants: 0, shifts: 0 });

    const shiftRequests = [];
    page.on('request', request => {
      if (request.url().includes('/api/auth/shifts')) shiftRequests.push(request.url());
    });
    await page.addInitScript(() => {
      localStorage.setItem('pos_cart', JSON.stringify([{ id: 999, name: 'Stale cashier item', qty: 4 }]));
      localStorage.setItem('pos_active_table', JSON.stringify({ id: 1, table_number: 1, current_order_id: 99 }));
      localStorage.setItem('pos_order_discount', JSON.stringify({ type: 'percent', value: 50 }));
      localStorage.setItem('pos_order_context', JSON.stringify({ version: 2, scope: { kind: 'table', id: '1', orderId: '99', splitCheckId: null, tableNumber: '1' } }));
      localStorage.setItem('pos_theme', 'dark');
    });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/pos');
    await waitForPos(page);
    const intake = page.getByRole('dialog', { name: 'New Phone Order' });
    await expect(intake).toBeVisible();
    await expect(page.locator('.shift-opening-overlay')).toHaveCount(0);
    expect(shiftRequests).toEqual([]);
    const cleanState = await page.evaluate(() => ({
      cart: JSON.parse(localStorage.getItem('pos_cart') || '[]'),
      table: localStorage.getItem('pos_active_table'),
      discount: JSON.parse(localStorage.getItem('pos_order_discount') || 'null'),
      context: localStorage.getItem('pos_order_context'),
    }));
    expect(cleanState).toMatchObject({ cart: [], table: null, context: null });
    expect(Number(cleanState.discount?.value || 0)).toBe(0);
    await expect(page.locator('.pos-polish.pos-theme-dark')).toBeVisible();
    const darkBounds = await intake.boundingBox();
    expect(darkBounds.width).toBeLessThanOrEqual(1024);
    expect(darkBounds.height).toBeLessThanOrEqual(768);

    const lightContext = await browser.newContext({ baseURL, storageState: 'playwright/.auth/call-center.json' });
    const lightPage = await lightContext.newPage();
    await lightPage.setViewportSize({ width: 390, height: 844 });
    await lightPage.goto('/pos');
    await waitForPos(lightPage);
    await expect(lightPage.locator('.pos-polish.pos-theme-dark')).toHaveCount(0);
    const mobileBounds = await lightPage.getByRole('dialog', { name: 'New Phone Order' }).boundingBox();
    expect(mobileBounds.width).toBeLessThanOrEqual(390);
    expect(mobileBounds.height).toBeLessThanOrEqual(844);
    await lightContext.close();

    await page.goto('/tables');
    await expect(page).toHaveURL(/\/pos$/);
    expect((await page.request.get('/api/auth/shifts?action=check')).status()).toBe(403);
    expect((await page.request.get('/api/pos/held_orders/summary')).status()).toBe(403);
    expect((await page.request.get('/api/admin/printers')).status()).toBe(403);
    expect((await page.request.post('/api/pos/checkout', { data: {} })).status()).toBe(403);
  });

  test('takes an external hold from quote through cashier checkout without duplicate kitchen printing', async ({ browser, request }) => {
    test.skip(process.env.ORDER_INTAKE_E2E !== '1', 'Order-intake E2E credentials are opt-in.');
    const apiKey = process.env.ORDER_INTAKE_API_KEY;
    expect(apiKey).toBeTruthy();
    const headers = { Authorization: `Bearer ${apiKey}` };
    const draft = {
      external_request_id: `e2e-intake-${randomUUID()}`,
      order_type_id: SEED.orderType.id,
      customer: { name: 'External Phone Customer', phone: '0797700770', address: 'Amman intake test' },
      items: [{ product_id: SEED.product1.id, quantity: 1 }],
      order_note: 'External intake browser verification',
    };
    const [[ordersBefore]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
    const [[printsBefore]] = await pool.query('SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id FROM print_queue');
    const quoted = await request.post('/api/order-intake/v1/quotes', { headers, data: draft });
    expect(quoted.ok(), await quoted.text()).toBe(true);
    const quoteBody = await quoted.json();
    const created = await request.post('/api/order-intake/v1/held-orders', {
      headers,
      data: { draft, quote_token: quoteBody.quote_token, confirmed: true },
    });
    expect(created.ok(), await created.text()).toBe(true);
    intakeHeldOrderId = Number((await created.json()).held_order.id);

    const [[held]] = await pool.query(
      'SELECT user_id, call_center_user_id, version, kitchen_fired, order_id, cart_data FROM held_orders WHERE id=?',
      [intakeHeldOrderId],
    );
    expect(held).toMatchObject({
      user_id: intakeActorUserId,
      call_center_user_id: intakeActorUserId,
      kitchen_fired: 0,
      order_id: null,
    });
    expect(JSON.parse(held.cart_data)._order_intake).toMatchObject({ dispatch_policy: 'hold_only' });
    const [[ordersAfter]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
    const [[printsAfter]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
    expect(Number(ordersAfter.count)).toBe(Number(ordersBefore.count));
    expect(Number(printsAfter.count)).toBe(Number(printsBefore.count));

    const cashier = await browser.newContext({ baseURL, storageState: 'playwright/.auth/cashier.json' });
    await cashier.request.post('/api/auth/shifts?action=open', {
      data: { user_id: SEED.cashierUser.id, starting_cash: 0 },
    });
    const cashierPage = await cashier.newPage();
    await cashierPage.goto('/pos');
    await waitForPos(cashierPage);
    await cashierPage.getByRole('button', { name: /Held/ }).click();
    await cashierPage.getByRole('button', { name: 'Phone orders' }).click();
    const card = cashierPage.locator('.note-card').filter({ hasText: `Suspended #${intakeHeldOrderId}` });
    await expect(card).toContainText('External Phone Customer');
    await expect(card).toContainText('Not sent');
    await expect(card).toContainText('E2E Order Intake');

    const fired = await cashier.request.post('/api/pos/held_orders/fire_kitchen', {
      data: {
        id: intakeHeldOrderId,
        operation_id: `e2e-intake-fire-${randomUUID()}`,
        expected_version: Number(held.version),
      },
    });
    expect(fired.ok(), await fired.text()).toBe(true);
    const [[firedHeld]] = await pool.query('SELECT kitchen_fired FROM held_orders WHERE id=?', [intakeHeldOrderId]);
    const [machineKitchenJobs] = await pool.query(
      'SELECT id FROM print_queue WHERE idempotency_key LIKE ?',
      [`kitchen:held-${intakeHeldOrderId}-%`],
    );
    expect(Number(firedHeld.kitchen_fired)).toBe(1);
    expect(machineKitchenJobs.length).toBeGreaterThan(0);

    await cashierPage.reload();
    await waitForPos(cashierPage);
    await expect(cashierPage).toHaveURL(/\/order-notes$/);
    await cashierPage.getByRole('button', { name: 'Phone orders' }).click();
    const currentCard = cashierPage.locator('.note-card').filter({ hasText: 'External Phone Customer' });
    await expect(currentCard).toContainText('Kitchen sent');
    await currentCard.getByRole('button', { name: 'Restore' }).click();
    await expect(cashierPage).toHaveURL(/\/pos$/);
    await expectProductQuantity(cashierPage, SEED.product1.name, 1);

    await cashierPage.getByRole('button', { name: /Pay/i }).click();
    const payment = cashierPage.getByRole('dialog', { name: 'Complete Payment' });
    await payment.getByRole('button', { name: /CASH/i }).click();
    await payment.getByRole('textbox', { name: 'Amount Tendered' }).fill(String(quoteBody.total));
    const checkoutResponsePromise = cashierPage.waitForResponse(response => (
      response.url().includes('/api/pos/checkout') && response.request().method() === 'POST'
    ));
    await payment.getByRole('button', { name: /CONFIRM PAYMENT/i }).click();
    const checkoutResponse = await checkoutResponsePromise;
    expect(checkoutResponse.ok(), await checkoutResponse.text()).toBe(true);
    const checkoutBody = await checkoutResponse.json();
    const [[sale]] = await pool.query(
      'SELECT user_id, call_center_user_id FROM orders WHERE invoice_id=?',
      [checkoutBody.invoice_id],
    );
    expect(sale).toMatchObject({ user_id: SEED.cashierUser.id, call_center_user_id: intakeActorUserId });
    const [[remainingHeld]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE id=?', [intakeHeldOrderId]);
    const [[requestLedger]] = await pool.query(
      'SELECT COUNT(*) AS count, MAX(held_order_id) AS held_order_id FROM order_intake_requests WHERE client_id=? AND external_request_id=?',
      [process.env.ORDER_INTAKE_CLIENT_ID, draft.external_request_id],
    );
    expect(Number(remainingHeld.count)).toBe(0);
    expect(Number(requestLedger.count)).toBe(1);
    expect(Number(requestLedger.held_order_id)).toBe(intakeHeldOrderId);
    const [kitchenJobsAfterCheckout] = await pool.query(
      'SELECT id FROM print_queue WHERE idempotency_key LIKE ?',
      [`kitchen:held-${intakeHeldOrderId}-%`],
    );
    expect(kitchenJobsAfterCheckout).toHaveLength(machineKitchenJobs.length);

    const replayed = await request.post('/api/order-intake/v1/held-orders', {
      headers,
      data: { draft, quote_token: quoteBody.quote_token, confirmed: true },
    });
    expect(replayed.ok(), await replayed.text()).toBe(true);
    expect((await replayed.json()).held_order).toMatchObject({ id: intakeHeldOrderId, replay: true, active: false });
    const reconciled = await request.get(
      `/api/order-intake/v1/requests/${encodeURIComponent(draft.external_request_id)}`,
      { headers },
    );
    expect(reconciled.ok(), await reconciled.text()).toBe(true);
    expect((await reconciled.json()).request).toMatchObject({ id: intakeHeldOrderId, replay: true, active: false });
    const [[recreated]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE id=?', [intakeHeldOrderId]);
    expect(Number(recreated.count)).toBe(0);
    await pool.query('DELETE FROM print_queue WHERE id>?', [Number(printsBefore.max_id)]);
    await pool.query('DELETE FROM orders WHERE invoice_id=?', [checkoutBody.invoice_id]);
    await cashier.close();

    await pool.query('DELETE FROM print_queue WHERE idempotency_key LIKE ?', [`kitchen:held-${intakeHeldOrderId}-%`]);
    await pool.query("DELETE FROM audit_events WHERE entity_type='held_order' AND entity_id=?", [intakeHeldOrderId]);
    intakeHeldOrderId = null;
  });

  test('sends a phone hold without checkout side effects and notifies the cashier once', async ({ browser, page }) => {
    await pool.query('DELETE FROM shifts WHERE user_id=?', [SEED.cashierUser.id]);
    const cashier = await browser.newContext({ baseURL, storageState: 'playwright/.auth/cashier.json' });
    const opened = await cashier.request.post('/api/auth/shifts?action=open', {
      data: { user_id: SEED.cashierUser.id, starting_cash: 0 },
    });
    expect(opened.ok()).toBe(true);
    const cashierPage = await cashier.newPage();
    await cashierPage.goto('/pos');
    await waitForPos(cashierPage);

    const authorityRequests = [];
    page.on('request', request => {
      if (relevantAuthorityPath(request.url())) authorityRequests.push(request.url());
    });
    await page.goto('/pos');
    await waitForPos(page);
    await completeIntake(page);
    await page.locator('.product-card', { hasText: SEED.product1.name }).first().click();
    await page.getByRole('button', { name: 'Send Order', exact: true }).click();
    const sendDialog = page.getByRole('dialog', { name: 'Send Order' });
    await expect(sendDialog).toBeVisible();
    await expect(sendDialog.locator('.checkout-methods')).toHaveCount(0);
    const dineIn = sendDialog.getByRole('button', { name: SEED.orderType.name });
    if (await dineIn.getAttribute('aria-pressed') !== 'true') await dineIn.click();
    const [[ordersBefore]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await expect(sendDialog).toBeVisible();
    await expect(dineIn).toHaveAttribute('aria-pressed', 'true');
    expect(authorityRequests).toEqual([]);

    await sendDialog.getByRole('button', { name: 'Send as Held' }).click();
    await expect(page.getByRole('dialog', { name: 'New Phone Order' })).toBeVisible();
    const [[held]] = await pool.query(
      'SELECT id, user_id, call_center_user_id, version, kitchen_fired, cart_data FROM held_orders WHERE call_center_user_id=? ORDER BY id DESC LIMIT 1',
      [sourceUserId]
    );
    heldOrderId = Number(held.id);
    expect(held).toMatchObject({ user_id: sourceUserId, call_center_user_id: sourceUserId, version: 1, kitchen_fired: 0 });
    expect(JSON.parse(held.cart_data)).toMatchObject({
      customer_phone: customerPhone,
      customer_name: 'Phone Customer',
      customer_address: 'Amman 7th Circle',
      order_type_id: SEED.orderType.id,
    });
    const [[ordersAfter]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
    expect(Number(ordersAfter.count)).toBe(Number(ordersBefore.count));
    expect(authorityRequests).toEqual([]);

    await expect(cashierPage.getByText('New phone order received', { exact: true })).toBeVisible();
    await expect(cashierPage.locator('.held-count-badge')).toHaveText('1');
    let reconnectSummaries = 0;
    cashierPage.on('request', request => {
      if (request.url().endsWith('/api/pos/held_orders/summary')) reconnectSummaries += 1;
    });
    await cashierPage.evaluate(() => window.dispatchEvent(new Event('socket_reconnected')));
    await expect.poll(() => reconnectSummaries).toBeGreaterThan(0);
    await cashierPage.getByRole('button', { name: /Held/ }).click();
    await expect(cashierPage).toHaveURL(/\/order-notes$/);
    await cashierPage.getByRole('button', { name: 'Phone orders' }).click();
    const card = cashierPage.locator('.note-card').filter({ hasText: `Suspended #${heldOrderId}` });
    await expect(card).toBeVisible();
    await expect(card).toContainText('E2E Phone Desk');
    await expect(card).toContainText('Not sent');
    const summariesBeforeReturn = reconnectSummaries;
    await cashierPage.getByRole('button', { name: 'Back' }).click();
    await expect(cashierPage).toHaveURL(/\/pos$/);
    // Since 5fe93a76 a clean keep-alive return re-reads nothing: no held event
    // and no reconnect happened while POS was inactive, so the badge the socket
    // already delivered stays authoritative without another summary request.
    await expect(cashierPage.locator('.held-count-badge')).toHaveText('1');
    // An SPA return never resets networkidle, so give a late read real time to show.
    await cashierPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await cashierPage.waitForTimeout(500);
    expect(reconnectSummaries).toBe(summariesBeforeReturn);
    await cashier.close();
  });

  test('keeps mobile call-center context visible while another worker observes the lease', async ({ browser }) => {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await loginAs(page, secondPhonePin);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/pos');
    await waitForPos(page);

    const match = await findPhoneOrder(page, heldOrderId);
    await expect(match).toContainText('E2E Phone Desk');
    await expect(match).toContainText('Not sent');
    await expectInsideViewport(match, 390, 844);
    await match.click();
    await expect(page.getByRole('dialog', { name: 'New Phone Order' })).toBeHidden();
    await page.getByRole('button', { name: /View Order/i }).click();

    const identity = page.locator('.call-center-cart-identity');
    await expect(identity).toContainText('Phone Customer');
    await expect(identity).toContainText(customerPhone);
    await expect(identity).toContainText('Edit');
    await expect(identity).toContainText('Cancel edits');
    await expectInsideViewport(identity, 390, 844);

    const observer = await browser.newContext({ baseURL, storageState: 'playwright/.auth/call-center.json' });
    const observerPage = await observer.newPage();
    await observerPage.setViewportSize({ width: 1024, height: 768 });
    await observerPage.goto('/pos');
    await waitForPos(observerPage);
    const observerMatch = await findPhoneOrder(observerPage, heldOrderId);
    await expect(observerMatch).toContainText('Being edited');
    await expect(observerMatch).toContainText('E2E Second Phone Desk');
    await observer.close();

    await identity.getByRole('button', { name: 'Edit', exact: true }).click();
    const sendDialog = page.getByRole('dialog', { name: 'Send Order' });
    await expect(sendDialog).toBeVisible();
    await expect(sendDialog.getByLabel('Mobile No.')).toBeVisible();
    await sendDialog.getByRole('button', { name: 'Customer', exact: true }).click();
    await sendDialog.locator('.checkout-close').click();

    await page.getByRole('button', { name: 'Send Order', exact: true }).click();
    await expect(sendDialog).toBeVisible();
    await sendDialog.getByRole('button', { name: 'Cancel order', exact: true }).click();
    const cancelContext = sendDialog.locator('.call-center-cancel-context');
    await expect(cancelContext).toContainText(`Phone #${heldOrderId}`);
    await expect(cancelContext).toContainText('1 items');
    await expect(cancelContext).toContainText('Not sent');
    await expectInsideViewport(cancelContext, 390, 844);
    await sendDialog.locator('.checkout-close').click();

    await identity.getByRole('button', { name: 'Cancel edits', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New Phone Order' })).toBeVisible();
    await context.close();
  });

  test('reconnects an expired graphite draft and preserves it on a version conflict', async ({ browser }) => {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await loginAs(page, secondPhonePin);
    await page.addInitScript(() => localStorage.setItem('pos_theme', 'dark'));
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/pos');
    await waitForPos(page);

    await findAndContinue(page, heldOrderId);
    const identity = page.locator('.call-center-cart-identity');
    await expect(identity).toBeVisible();
    await page.locator('.product-card', { hasText: SEED.product1.name }).first().click();
    await expireClaimForBrowser(page, heldOrderId);

    await page.getByRole('button', { name: 'Send Order', exact: true }).click();
    const sendDialog = page.getByRole('dialog', { name: 'Send Order' });
    await sendDialog.getByRole('button', { name: 'Reconnect to order', exact: true }).click();
    await expect(sendDialog.getByRole('button', { name: 'Reconnect to order', exact: true })).toHaveCount(0);
    await expectProductQuantity(page, SEED.product1.name, 2);
    await sendDialog.locator('.checkout-close').click();

    await expireClaimForBrowser(page, heldOrderId, { bumpVersion: true });
    await page.getByRole('button', { name: 'Send Order', exact: true }).click();
    await page.getByRole('dialog', { name: 'Send Order' })
      .getByRole('button', { name: 'Reconnect to order', exact: true }).click();
    await expect(page.getByText('This phone order changed on the server. Your draft is preserved.', { exact: true })).toBeVisible();
    await expectProductQuantity(page, SEED.product1.name, 2);

    await expect(page.locator('.pos-polish.pos-theme-dark')).toBeVisible();
    await expectInsideViewport(page.getByRole('dialog', { name: 'Send Order' }), 1024, 768);
    await page.getByRole('dialog', { name: 'Send Order' }).locator('.checkout-close').click();
    await context.close();
  });

  test('keeps the original source when another worker sends a delta and cancels the order', async ({ browser }) => {
    const cashier = await browser.newContext({ baseURL, storageState: 'playwright/.auth/cashier.json' });
    const [[beforeFire]] = await pool.query('SELECT version FROM held_orders WHERE id=?', [heldOrderId]);
    const fired = await cashier.request.post('/api/pos/held_orders/fire_kitchen', {
      data: { id: heldOrderId, operation_id: `fire-${randomUUID()}`, expected_version: Number(beforeFire.version) },
    });
    expect(fired.ok(), JSON.stringify(await fired.json().catch(() => ({})))).toBe(true);
    await cashier.close();

    const second = await browser.newContext({ baseURL });
    const login = await second.request.post('/api/auth/login', { data: { user_number: secondPhonePin } });
    expect(login.ok()).toBe(true);
    const page = await second.newPage();
    await page.goto('/pos');
    await waitForPos(page);
    const fireMatch = await findPhoneOrder(page, heldOrderId);
    await expect(fireMatch).toContainText('Kitchen sent');
    await expect(fireMatch).toContainText('E2E Phone Desk');
    await fireMatch.click();
    await expect(page.getByRole('dialog', { name: 'New Phone Order' })).toBeHidden();
    await page.locator('.product-card', { hasText: SEED.product1.name }).first().click();
    await page.getByRole('button', { name: 'Send Order', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Send Order' });
    await dialog.getByRole('button', { name: 'Save & send FOLLOW UP' }).click();
    await expect(page.getByRole('dialog', { name: 'New Phone Order' })).toBeVisible();

    const [[afterFollowUp]] = await pool.query(
      'SELECT call_center_user_id, version, kitchen_dispatch_version FROM held_orders WHERE id=?',
      [heldOrderId]
    );
    expect(afterFollowUp.call_center_user_id).toBe(sourceUserId);
    expect(Number(afterFollowUp.kitchen_dispatch_version)).toBe(2);
    const [heldKitchenJobs] = await pool.query(
      'SELECT payload FROM print_queue WHERE idempotency_key LIKE ? ORDER BY id',
      [`kitchen:held-${heldOrderId}-%`]
    );
    const followUpJobs = heldKitchenJobs
      .map(row => JSON.parse(row.payload))
      .filter(payload => payload.data.follow_up === true);
    expect(followUpJobs).toHaveLength(1);
    const followUpData = followUpJobs[0].data;
    expect(followUpData.follow_up_sequence).toBe(2);
    expect(followUpData.items).toHaveLength(1);
    expect(Number(followUpData.items[0].qty)).toBe(1);
    const [[followUpAudit]] = await pool.query(
      "SELECT user_id, new_value FROM audit_events WHERE entity_type='held_order' AND entity_id=? AND event_type='held_order_follow_up_queued' ORDER BY id DESC LIMIT 1",
      [heldOrderId]
    );
    expect(followUpAudit.user_id).toBe(secondWorkerId);
    expect(JSON.parse(followUpAudit.new_value).call_center_user_id).toBe(sourceUserId);

    const followUpMatch = await findPhoneOrder(page, heldOrderId);
    await expect(followUpMatch).toContainText('Kitchen sent');
    await expect(followUpMatch).toContainText('FOLLOW UP #1');
    await expect(followUpMatch).toContainText('E2E Phone Desk');
    await followUpMatch.click();
    await expect(page.getByRole('dialog', { name: 'New Phone Order' })).toBeHidden();
    await page.getByRole('button', { name: 'Send Order', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Send Order' });
    await dialog.getByRole('button', { name: 'Cancel order' }).click();
    await dialog.getByLabel('Cancellation reason').selectOption('customer_changed_mind');
    await page.route(`**/api/pos/held_orders/${heldOrderId}`, async route => {
      if (route.request().method() !== 'DELETE') return route.continue();
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      await route.abort('failed');
    }, { times: 1 });
    await dialog.getByRole('button', { name: 'Confirm cancellation' }).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New Phone Order' })).toBeVisible();

    const [[remaining]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE id=?', [heldOrderId]);
    expect(Number(remaining.count)).toBe(0);
    const [[cancelAudit]] = await pool.query(
      "SELECT user_id, old_value, new_value FROM audit_events WHERE entity_type='held_order' AND entity_id=? AND event_type='held_order_canceled' ORDER BY id DESC LIMIT 1",
      [heldOrderId]
    );
    expect(cancelAudit.user_id).toBe(secondWorkerId);
    expect(JSON.parse(cancelAudit.new_value)).toMatchObject({ call_center_user_id: sourceUserId, reason_code: 'customer_changed_mind' });
    const [heldKitchenJobsAfterCancel] = await pool.query(
      'SELECT payload FROM print_queue WHERE idempotency_key LIKE ? ORDER BY id',
      [`kitchen:held-${heldOrderId}-%`]
    );
    const cancelJobs = heldKitchenJobsAfterCancel
      .map(row => JSON.parse(row.payload))
      .filter(payload => payload.data.cancel_ticket === true);
    expect(cancelJobs).toHaveLength(1);
    const cancelItems = cancelJobs[0].data.items;
    const canceledBurgerQty = cancelItems
      .filter(item => Number(item.product_id) === Number(SEED.product1.id))
      .reduce((sum, item) => sum + Number(item.qty || 0), 0);
    expect(canceledBurgerQty).toBe(2);
    await second.close();
  });
});
