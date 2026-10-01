import { test, expect } from '@playwright/test';
import { SEED } from '../../../backend/tests/fixtures/seed.js';
import { reseedDatabase, resetServerCaches } from '../reseed.js';
import pool from '../../../backend/config/db.js';

const tableCard = (page, tableNumber) => page.locator(
  `[data-testid="table-card"][data-table-number="${tableNumber}"]`
);

test.describe('Split Check Workspace', () => {
  let taxInclusiveBefore;

  test.beforeEach(async () => {
    await reseedDatabase();
    const [[setting]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='tax_inclusive_pricing'");
    taxInclusiveBefore = setting?.setting_value ?? '0';
  });

  // Leave no admin shift or tax-inclusive 4.75 product behind for later specs.
  // Later specs do not reseed: restore what these tests change, close (not delete:
  // paid orders reference it) the admin shift, and drop the server's cached catalog.
  test.afterEach(async () => {
    await pool.query('UPDATE products SET price=?, tax_rate=? WHERE id=?', [
      SEED.product1.price, SEED.product1.tax_rate, SEED.product1.id,
    ]);
    await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='tax_inclusive_pricing'", [taxInclusiveBefore]);
    await pool.query("UPDATE shifts SET status='closed', closed_at=NOW() WHERE user_id=? AND status='open'", [SEED.adminUser.id]);
    await resetServerCaches();
  });

  test('stays clear and usable from a 320px phone to desktop', async ({ page }) => {
    await page.goto('/tables');
    await tableCard(page, '1').click();
    await page.waitForURL(/\/pos/);
    await page.getByRole('button', { name: /Start Shift/i }).click();

    const burger = page.locator('.btn-3d', { hasText: 'Test Burger' }).first();
    await burger.click();
    await page.getByRole('button', { name: /Save Table/i }).click();
    const splitButton = page.getByRole('button', { name: 'Split', exact: true });
    await expect(splitButton).toBeEnabled();
    await splitButton.click();

    const dialog = page.getByRole('dialog', { name: 'Split Check' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Move only what should be paid separately. Everything else stays here.');
    await expect(dialog.locator('.split-source-pane')).toContainText('5.80 JD');
    await expect(dialog).not.toContainText('Division Console');

    await dialog.getByRole('button', { name: 'Add Check' }).click();
    const seatThree = dialog.getByRole('button', { name: /^Bill Check 3 / });
    await expect(seatThree).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove Check Bill Check 3', exact: true }).click();
    await expect(seatThree).toHaveCount(0);

    // Fractions live behind the "Advanced fractions" disclosure since 6a5bc3bf.
    await dialog.locator('.split-source-pane .split-advanced summary').first().click();
    await dialog.getByRole('button', { name: 'Split item 1/2', exact: true }).click();
    const splitLines = dialog.locator('.split-source-pane .split-line');
    await expect(splitLines).toHaveCount(2);
    await expect(splitLines.first()).toContainText('2.90 JD');
    await expect(splitLines.first()).toContainText('Original price 5.80 JD');

    await page.setViewportSize({ width: 320, height: 568 });
    await expect.poll(async () => Math.round((await dialog.boundingBox()).width)).toBe(320);
    await expect.poll(async () => Math.round((await dialog.boundingBox()).height)).toBe(568);

    const source = dialog.locator('.split-source-pane');
    const destinations = dialog.locator('.split-seat-list');
    const finalize = dialog.getByRole('button', { name: 'Finalize Splits' });
    await expect(finalize).toBeDisabled();
    await source.getByRole('button', { name: /Test Burger/ }).first().click();
    await expect(dialog.locator('.split-seat-heading')).toContainText('2.90 JD');
    await destinations.getByRole('button', { name: /^Bill Check 2 / }).click();
    await source.getByRole('button', { name: /Test Burger/ }).first().click();
    await expect(finalize).toBeEnabled();

    await dialog.locator('.split-mobile-switch button').nth(1).click();
    const activeSeat = dialog.locator('.split-seat-pane');
    await expect(activeSeat).toContainText('Test Burger');
    // The seat line now sits beside its quantity stepper; click the line itself.
    await activeSeat.locator('.split-seat-line', { hasText: 'Test Burger' }).click();
    await expect(finalize).toBeDisabled();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(dialog.locator('.split-source-pane')).toBeVisible();
    await expect(dialog.locator('.split-seat-pane')).toBeVisible();
  });

  test('settles both halves of an odd-cent 5.51 check without losing a cent', async ({ page }) => {
    await pool.query('UPDATE products SET price=4.75, tax_rate=16 WHERE id=?', [SEED.product1.id]);
    // Since a8a49c82 the tax_inclusive_pricing setting only changes the receipt;
    // table sales always add tax, so 4.75 + 16% = 5.51, which halves to 2.76 + 2.75.
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='tax_inclusive_pricing'");
    await resetServerCaches();

    await page.goto('/tables');
    await tableCard(page, '1').click();
    await page.waitForURL(/\/pos/);
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await page.locator('.btn-3d', { hasText: 'Test Burger' }).first().click();
    await page.getByRole('button', { name: /Save Table/i }).click();
    await page.getByRole('button', { name: 'Split', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Split Check' });
    // Fractions live behind the "Advanced fractions" disclosure since 6a5bc3bf.
    await dialog.locator('.split-source-pane .split-advanced summary').first().click();
    await dialog.getByRole('button', { name: 'Split item 1/2', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 568 });

    const source = dialog.locator('.split-source-pane');
    // Since 4d9cbbb9 the unmoved remainder stays on the original check, so
    // Bill Check 2 is the only destination: move one half there, keep the other.
    await dialog.locator('.split-seat-list').getByRole('button', { name: /^Bill Check 2 / }).click();
    await source.getByRole('button', { name: /Test Burger/ }).first().click();

    const moved = dialog.locator('.split-seat-option');
    await expect(moved).toHaveCount(1);
    await expect(moved).toContainText(/2\.7[56] JD/);
    const movedCents = Math.round(Number((await moved.innerText()).match(/(2\.7[56]) JD/)[1]) * 100);
    await expect(source).toContainText(`${((551 - movedCents) / 100).toFixed(2)} JD`);
    await dialog.locator('.split-mobile-switch button').nth(1).click();
    await expect(dialog.locator('.split-seat-pane')).toContainText(/2\.7[56] JD/);
    await dialog.getByRole('button', { name: 'Finalize Splits' }).click();
    // Finalizing opens the splits board directly (tableOrderWorkflow confirmSplit).
    await page.waitForURL(/\/table-splits$/);

    // Locate each check by its heading: the line amount is the unrounded half (2.76)
    // on both cards, and the card whose total rounds to 2.75 shows the cent as a
    // Rounding line, like its receipt, so its lines add up to its total.
    for (const [name, total, rounding] of [['Remaining Check', '2.76', null], ['Bill Check 2', '2.75', '-0.01 JD']]) {
      await page.goto('/table-splits');
      const check = page.getByRole('heading', { name, exact: true })
        .locator('xpath=ancestor::div[.//button[normalize-space()="Pay"]][1]');
      await expect(check).toBeVisible();
      await expect(check.getByText(`${total} JD`, { exact: true }).first()).toBeVisible();
      if (rounding) await expect(check.getByText('Rounding').locator('..')).toContainText(rounding);
      else await expect(check.getByText('Rounding')).toHaveCount(0);
      await check.getByRole('button', { name: 'Pay', exact: true }).click();
      await page.waitForURL(/\/pos$/);
      await expect(page.getByRole('heading', { name: 'Table Splits Board' })).toBeHidden();
      const restoredTable = await page.evaluate(() => JSON.parse(localStorage.getItem('pos_active_table')));
      expect(restoredTable.split_money_cents.total).toBe(Math.round(Number(total) * 100));

      await page.getByRole('button', { name: 'Pay', exact: true }).click();
      const checkout = page.getByRole('dialog', { name: 'Complete Payment' });
      await expect(checkout.getByRole('textbox', { name: 'Amount Tendered' })).toHaveValue(total);
      await expect(checkout.getByRole('button', { name: /CONFIRM PAYMENT/i })).toContainText(`${total} JD`);
      await checkout.getByRole('button', { name: /CONFIRM PAYMENT/i }).click();
      await page.waitForURL(/\/tables$/);
    }

    const [children] = await pool.query(
      'SELECT total FROM orders WHERE parent_invoice_id IS NOT NULL ORDER BY invoice_id'
    );
    expect(children.map(row => Math.round(Number(row.total) * 100))).toEqual([276, 275]);
    expect(children.reduce((sum, row) => sum + Math.round(Number(row.total) * 100), 0)).toBe(551);
  });
});
