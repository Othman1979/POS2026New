import { test, expect } from '@playwright/test';
import { reseedDatabase } from '../reseed.js';
import pool from '../../../backend/config/db.js';

// Real browser, real server and DB: does "Check last payment" recover a
// checkout whose reply was lost? Each scenario logs what the cashier sees
// (lines starting "OBSERVED") so the run doubles as evidence.
const log = (name, data) => console.log(`OBSERVED ${name} ${JSON.stringify(data)}`);

async function draftAndPay(page) {
  await page.goto('/pos');
  await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
  const float = page.locator('input[placeholder="0.00"]');
  await float.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  if (await float.isVisible().catch(() => false)) {
    await float.fill('50.00');
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await expect(float).toBeHidden();
  }
  await page.waitForSelector('.product-card, .btn-3d');
  await page.locator('.btn-3d', { hasText: 'Test Burger' }).first().click();
  await page.locator('.btn-3d', { hasText: 'Test Drink' }).first().click();
  await expect(page.locator('.divide-y tr', { hasText: 'Test Drink' }).first()).toBeVisible();
  await page.getByRole('button', { name: /Pay/i }).click();
  await expect(page.locator('text=Complete Payment')).toBeVisible();
  await page.getByRole('button', { name: /CASH/i }).click();
  // Tender the exact total shown in the dialog (fallback 7.80 = 5.00 + 16% + 2.00).
  const tender = page.getByRole('textbox', { name: 'Amount Tendered' });
  const shown = await page.locator('.checkout-layout').first().innerText();
  const m = shown.match(/(?:Total|TOTAL)[^\d]*(\d+\.\d{2})/);
  await tender.fill(m ? m[1] : '7.80');
}

const rows = /Test Burger|Test Drink/;
const cartCount = (page) => page.locator('.divide-y tr', { hasText: rows }).count();
const modalText = async (page) => (await page.locator('.modal-body').first().innerText({ timeout: 500 }).catch(() => '')).replace(/\s+/g, ' ');
const banner = (page) => page.getByText('The last payment needs checking.').isVisible().catch(() => false);
const records = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pos_pending_checkout')).length);
const ordersFor = async (key) => Number((await pool.query('SELECT COUNT(*) AS c FROM orders WHERE idempotency_key=?', [key]))[0][0].c);
const retryButton = (page) => page.getByRole('button', { name: 'Check last payment' });

async function runScenario(page, { name, mode, reload, beforeRetry }) {
  const keys = [];
  const printReqs = [];
  const probes = [];
  page.on('response', (r) => { if (r.url().includes('/checkout/jofotara/status')) probes.push(r.status()); });
  page.on('request', (r) => {
    if (/print|spool/i.test(r.url()) && r.method() !== 'GET') printReqs.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  // window.print() blocks a headless renderer; count calls instead (browser print path).
  await page.addInitScript(() => {
    window.__printCalls = Number(sessionStorage.getItem('__printCalls') || 0);
    window.print = () => { window.__printCalls += 1; sessionStorage.setItem('__printCalls', String(window.__printCalls)); };
  });
  let intercept = true;
  await page.route('**/api/pos/checkout', async (route) => {
    if (!intercept) return route.continue();
    keys.push(route.request().postDataJSON()?.idempotency_key);
    if (mode === 'A') { await route.fetch(); return route.abort('failed'); }
    if (mode === 'B') return route.abort('failed');
    return route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad Gateway (proxy)</body></html>' });
  });

  await draftAndPay(page);
  await page.getByRole('button', { name: /CONFIRM PAYMENT/i }).click();
  await expect(retryButton(page).first()).toBeVisible();
  // The record is saved before the request settles; wait until the failure is final.
  await expect(page.locator('.modal-body').getByRole('button', { name: 'Check last payment' })).toBeEnabled();
  const key = keys[0];
  const failure = { dialog: await modalText(page), cartRows: await cartCount(page), banner: await banner(page), records: await records(page) };
  const ordersAfterFailure = await ordersFor(key);

  let afterReload = null;
  if (reload) {
    const post = []; const cons = [];
    page.on('request', (r) => { if (r.url().includes('/api/pos/checkout') && r.method() === 'POST') post.push(Date.now()); });
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) cons.push(m.text().slice(0, 200)); });
    intercept = false; // the network is back after the reload
    await page.reload();
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    await page.waitForTimeout(4000); // let the reconnect/activation probe run
    afterReload = {
      cartRows: await cartCount(page),
      banner: await banner(page),
      emptyOrder: await page.getByText('Empty Order', { exact: true }).isVisible().catch(() => false),
      records: await records(page),
      ordersByKey: await ordersFor(key),
      checkoutPostsAfterReload: post.length, consoleAfterReload: cons,
    };
  }

  intercept = false;
  const probesBeforeRetry = [...probes];
  let extra = null;
  if (beforeRetry) extra = await beforeRetry(page);
  if (!(await retryButton(page).first().isVisible().catch(() => false))) {
    // The probe already recovered it.
    log(name, { failure, ordersAfterFailure, afterReload, auto: true, printReqs, probesBeforeRetry });
    return { key, failure, afterReload, auto: true };
  }
  if (!(await page.locator('text=get a reply from the server').isVisible().catch(() => false))) {
    await retryButton(page).first().click();
  }
  const linesShown = (await page.locator('[data-testid=pending-lines]').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const respPromise = page.waitForResponse((r) => r.url().includes('/api/pos/checkout') && r.request().method() === 'POST').catch(() => null);
  await page.locator('.modal-body').getByRole('button', { name: 'Check last payment' }).click();
  const resp = await respPromise;
  const body = resp ? await resp.json().catch(() => null) : null;
  await page.waitForTimeout(1500);
  const retry = {
    status: resp?.status(), success: body?.success, invoice: body?.invoice_id,
    dialog: await modalText(page),
    linesShown,
    discardVisible: await page.getByRole('button', { name: 'Discard: this sale was not saved' }).isVisible().catch(() => false),
    modalOpen: await page.locator('text=Complete Payment').isVisible().catch(() => false),
    cartRows: await cartCount(page),
    emptyOrder: await page.getByText('Empty Order', { exact: true }).isVisible().catch(() => false),
    banner: await banner(page),
    records: await records(page),
    ordersByKey: await ordersFor(key),
    printReqs,
    windowPrintCalls: await page.evaluate(() => window.__printCalls).catch(() => null),
  };
  log(name, { failure, ordersAfterFailure, afterReload, extra, probesBeforeRetry, retry, toasts: await page.locator('[role=status], [role=alert], .toast').allInnerTexts().catch(() => []) });
  return { key, failure, afterReload, extra, retry };
}

test.describe('Checkout lost-response recovery', () => {
  test.setTimeout(90000);
  test.beforeEach(async () => { await reseedDatabase(); });

  test('A: committed, reply lost -> retry replays the sale, no duplicate', async ({ page }) => {
    const r = await runScenario(page, { name: 'A', mode: 'A' });
    expect(r.failure.cartRows).toBeGreaterThan(0);
    expect(r.retry.ordersByKey).toBe(1);
    expect(r.retry.banner).toBe(false);
    expect(r.retry.cartRows).toBe(0);
  });

  test('B: not committed -> retry commits once', async ({ page }) => {
    const r = await runScenario(page, { name: 'B', mode: 'B' });
    expect(r.retry.ordersByKey).toBe(1);
    expect(r.retry.banner).toBe(false);
    expect(r.retry.cartRows).toBe(0);
  });

  test('C: proxy HTML 502 -> retry commits once', async ({ page }) => {
    const r = await runScenario(page, { name: 'C', mode: 'C' });
    expect(r.retry.ordersByKey).toBe(1);
    expect(r.retry.banner).toBe(false);
    expect(r.retry.cartRows).toBe(0);
  });

  test('A2: committed, reply lost, reload, then retry', async ({ page }) => {
    const r = await runScenario(page, { name: 'A2', mode: 'A', reload: true });
    expect(r.retry?.ordersByKey ?? r.afterReload.ordersByKey).toBe(1);
    expect(r.retry?.cartRows ?? r.afterReload.cartRows).toBe(0);
  });

  test('B2: not committed, reload, then retry', async ({ page }) => {
    const r = await runScenario(page, { name: 'B2', mode: 'B', reload: true });
    expect(r.retry.ordersByKey).toBe(1);
    expect(r.retry.cartRows).toBe(0);
  });

  test('F: reply lost (committed), shift closed from another session, then retry replays the sale', async ({ page }) => {
    const r = await runScenario(page, {
      name: 'F', mode: 'A',
      beforeRetry: async () => { await pool.query("UPDATE shifts SET status='closed', closed_at=NOW()"); return { shiftClosed: true }; },
    });
    expect(r.retry.ordersByKey).toBe(1);
  });

  test('G: not committed, shift closed from another session, then retry is refused with a clear message', async ({ page }) => {
    const r = await runScenario(page, {
      name: 'G', mode: 'B',
      beforeRetry: async () => { await pool.query("UPDATE shifts SET status='closed', closed_at=NOW()"); return { shiftClosed: true }; },
    });
    expect(r.retry.ordersByKey).toBe(0);
    // A refusal: the server's message is shown and the record is kept. Discard waits five
    // minutes from this send, because a refusal does not prove earlier requests finished.
    expect(r.retry.status).toBeLessThan(500);
    expect(r.retry.success).toBe(false);
    expect(r.retry.dialog).toMatch(/shift/i);
    expect(r.retry.records).toBe(1);
    expect(r.retry.discardVisible).toBe(false);
  });

  test('D: reply lost, cashier closes dialog and clears the cart, then retries from the banner', async ({ page }) => {
    const r = await runScenario(page, {
      name: 'D', mode: 'A',
      beforeRetry: async (p) => {
        await p.getByRole('button', { name: 'Close' }).first().click();
        const clear = p.getByRole('button', { name: /^Clear$/ });
        const clearEnabled = await clear.isEnabled().catch(() => false);
        if (clearEnabled) { await clear.click(); await p.getByRole('button', { name: /Clear|Confirm|Yes/i }).last().click().catch(() => {}); }
        await p.waitForTimeout(500);
        return { clearEnabled, cartRowsAfterClear: await cartCount(p), bannerAfterClear: await banner(p) };
      },
    });
    // The path under test is "cart already cleared": prove the clear happened.
    expect(r.extra.clearEnabled).toBe(true);
    expect(r.extra.cartRowsAfterClear).toBe(0);
    expect(r.retry.ordersByKey).toBe(1);
    expect(r.retry.banner).toBe(false);
    expect(r.retry.linesShown).toMatch(/Test Burger.*1.*Test Drink.*1/);
    expect(r.retry.modalOpen).toBe(false);
  });

  test('E: reply lost, cashier starts a newer draft, then retries: no double sale, newer draft kept', async ({ page }) => {
    const r = await runScenario(page, {
      name: 'E', mode: 'A',
      beforeRetry: async (p) => {
        await p.getByRole('button', { name: 'Close' }).first().click();
        const clear = p.getByRole('button', { name: /^Clear$/ });
        if (await clear.isEnabled().catch(() => false)) { await clear.click(); await p.getByRole('button', { name: /Clear|Confirm|Yes/i }).last().click().catch(() => {}); }
        await p.locator('.btn-3d', { hasText: 'Test Drink' }).first().click();
        return { cartRowsNewDraft: await cartCount(p) };
      },
    });
    expect(r.retry.ordersByKey).toBe(1);
    expect(r.retry.banner).toBe(false);
    expect(r.retry.linesShown).toMatch(/Test Burger.*1.*Test Drink.*1/);
    expect(r.retry.modalOpen).toBe(false);
    expect(r.retry.cartRows).toBeGreaterThan(0);
  });
});
