import { test, expect } from '@playwright/test';
import { SEED } from '../../../backend/tests/fixtures/seed.js';
import { reseedDatabase } from '../reseed.js';

const tableCard = (page, tableNumber) => page.locator(
  `[data-testid="table-card"][data-table-number="${tableNumber}"]`
);

test.describe('Waiter Table Workflows', () => {
  test.beforeEach(async ({ page }) => {
    // Reset test database to clean seed state before each run
    await reseedDatabase();
    const login = await page.request.post('/api/auth/login', {
      data: { user_number: SEED.waiterUser.user_number }
    });
    expect(login.ok()).toBe(true);
  });

  test('should open table, add items, and save as unpaid table order', async ({ page }) => {
    // 1. Navigate to Tables floor plan (session is preloaded via waiter.json)
    await page.goto('/tables');

    // Verify Table 1 card is visible
    const tableT1 = tableCard(page, '1');
    await expect(tableT1).toBeVisible();

    // 2. Click Table 1 to enter the active cart POS context
    await tableT1.click();

    // Verify redirection to POS page
    await page.waitForURL(/\/pos/);

    // Verify the compact table-session control owns Table 1.
    const tableSession = page.locator('.catalog-table-session');
    await expect(tableSession).toHaveAttribute('aria-label', /Table 1/i);
    await expect(tableSession).toContainText('#1');

    // 3. Add item to cart
    await page.waitForSelector('.product-card, .btn-3d');
    const burgerCard = page.locator('.btn-3d', { hasText: 'Test Burger' }).first();
    await expect(burgerCard).toBeVisible();
    await burgerCard.click();

    // Verify item is added to the cart
    const cartRow = page.locator('.divide-y tr', { hasText: 'Test Burger' }).first();
    await expect(cartRow).toBeVisible();

    // 4. Save Order (Hold Table Order)
    await page.getByRole('button', { name: /Save Table/i }).click();

    // Verify redirect back to /tables floor plan
    await page.waitForURL(/\/tables/);

    // 5. Verify Table 1 exposes its saved state semantically
    await expect(tableCard(page, '1')).toHaveAttribute('data-table-status', 'occupied');
  });

  test('opens table actions without entering the table', async ({ page }) => {
    await page.goto('/tables');
    const table = tableCard(page, '1');
    await expect(table).toBeVisible();

    await table.getByRole('button', { name: 'Table options 1' }).click();

    await expect(page).toHaveURL(/\/tables$/);
    await expect(page.getByRole('dialog', { name: 'Table 1' })).toBeVisible();
    await page.getByRole('button', { name: 'Open Cart' }).click();
    await expect(page).toHaveURL(/\/pos$/);
  });

  test('uses one navigation menu at a 1024px POS width', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/tables');

    await expect(page.getByTestId('tables-wide-actions')).toBeHidden();
    await page.getByTestId('tables-navigation-menu').click();
    await expect(page.getByRole('menu', { name: 'Navigation menu' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Logout' })).toBeVisible();
  });
});
