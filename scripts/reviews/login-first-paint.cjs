// Verify the production build through the real static routes without a database.
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('@playwright/test');
const { app, io } = require('../../server');
const db = require('../../backend/config/db');

async function runCase(browser, origin, { language, width, height }) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(savedLanguage => {
    localStorage.setItem('pos_admin_language', savedLanguage);
    // Seed once: the dead-session redirect reloads /login and must not re-stale it.
    if (sessionStorage.getItem('fixture_seeded')) return;
    sessionStorage.setItem('fixture_seeded', '1');
    sessionStorage.setItem('pos_user', JSON.stringify({ id: 9, role: 'cashier', name: 'Stale fixture' }));
    sessionStorage.setItem('pos_user_at', String(Date.now() - 31 * 60 * 1000));
  }, language);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  let releaseScripts;
  const scriptsReady = new Promise(resolve => { releaseScripts = resolve; });
  let authRoute;
  let authRequested;
  const authStarted = new Promise(resolve => { authRequested = resolve; });
  await page.route('**/*.js', async route => { await scriptsReady; await route.continue(); });
  await page.route('**/api/auth/me', route => { authRoute = route; authRequested(); });
  await page.route('**/api/config/business', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ success: true, business_sql_offset: '+03:00', business_day_start_hour: 6 })
  }));
  await page.route('**/api/auth/login-policy', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ success: true, mode: 'disabled', supported: false, enforce_https: false })
  }));
  await page.route('**/api/system/public_preferences', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ success: true })
  }));

  try {
    const response = await page.goto(origin + '/login', { waitUntil: 'commit' });
    assert.equal(response.status(), 200);
    await page.locator('#login-boot-shell').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pos-boot-shell').count(), 0, 'POS shell flashed before JavaScript loaded');
    assert.match(await response.text(), /id="login-boot-shell"/);
    assert.doesNotMatch(await response.text(), /id="pos-boot-shell"/);

    releaseScripts();
    await authStarted;
    await page.waitForFunction(() => Boolean(document.querySelector('#app')?.__vue_app__));
    await page.locator('#login-boot-shell').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pos-boot-shell').count(), 0, 'POS shell flashed while login auth was pending');
    assert.equal(await page.locator('#login-app').count(), 0, 'Login should wait for the pending stale-session check');

    await authRoute.fulfill({
      status: 401, contentType: 'application/json', body: JSON.stringify({ success: false, code: 'SESSION_INVALID' })
    });
    await page.locator('#login-app').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pos-boot-shell').count(), 0);
    assert.deepEqual(pageErrors, []);
    console.log(`PASS login first paint and pending-auth fallback: ${language} ${width}x${height}`);
  } finally {
    releaseScripts();
    if (authRoute) await authRoute.fulfill({ contentType: 'application/json', body: '{"success":false}' }).catch(() => {});
    await context.close();
  }
}

async function run() {
  const listener = http.createServer(app);
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const settings of [
      { language: 'en', width: 1440, height: 900 },
      { language: 'ar', width: 390, height: 844 },
    ]) await runCase(browser, origin, settings);

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('**/*.js', route => route.abort());
    await page.goto(origin + '/device-enrollment', { waitUntil: 'commit' });
    await page.locator('#login-boot-shell').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pos-boot-shell').count(), 0);
    await page.goto(origin + '/pos', { waitUntil: 'commit' });
    await page.locator('#pos-boot-shell').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#login-boot-shell').count(), 0);
    await context.close();
    console.log('PASS device enrollment uses neutral shell; register retains POS shell.');
  } finally {
    await browser.close();
    await new Promise(resolve => listener.close(resolve));
    await new Promise(resolve => io.close(resolve));
    await db.end();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
