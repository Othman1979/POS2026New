import { test, expect } from '@playwright/test';

async function cleanLoginPage(browser, policy) {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  await page.route('**/api/auth/login-policy', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(policy),
  }));
  await page.goto('/login');
  return { context, page };
}

test('shows global server saturation without leaving login', async ({ browser }) => {
  const { context, page } = await cleanLoginPage(browser, { success: true, mode: 'disabled', supported: false, enforce_https: false });
  await page.route('**/api/auth/login', route => route.fulfill({
    status: 429,
    contentType: 'application/json',
    body: JSON.stringify({ success: false, code: 'SERVER_BUSY', message: 'The server is busy. Try again in a moment.' }),
  }));
  await page.keyboard.type('1234');
  await page.keyboard.press('Enter');
  await expect(page.locator('.text-error')).toContainText('The server is busy. Try again in a moment.');
  await expect(page).toHaveURL(/\/login$/);
  await context.close();
});

test('refuses plaintext when hosted HTTPS policy is enabled', async ({ browser }) => {
  const { context, page } = await cleanLoginPage(browser, { success: true, mode: 'disabled', supported: true, enforce_https: true });
  let loginRequests = 0;
  await page.route('**/api/auth/login', route => {
    loginRequests += 1;
    return route.abort();
  });
  await page.keyboard.type('1234');
  await page.keyboard.press('Enter');
  await expect(page.locator('.text-error')).toContainText('This POS must be opened over HTTPS before you can sign in.');
  expect(loginRequests).toBe(0);
  await context.close();
});
