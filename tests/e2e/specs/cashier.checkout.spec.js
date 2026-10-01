import { test, expect } from '@playwright/test';
import { SEED } from '../../../backend/tests/fixtures/seed.js';
import { reseedDatabase } from '../reseed.js';
import pool from '../../../backend/config/db.js';
import { POS_ORDER_SESSION_KEYS } from '../../../src/pos/stores/orderSession/orderSessionPersistence.js';
import { writeFile } from 'node:fs/promises';

const CASHIER_STATE = 'playwright/.auth/cashier.json';

// Login is single-session, so a new cashier login revokes the session that
// cashier.json holds. Tests that need a fresh session (new permissions, or a
// shift close that revoked it) log in here and hand the new cookie back to the
// shared file, without this test's localStorage, so later contexts stay valid.
async function loginCashierAgain(page) {
  const login = await page.request.post('/api/auth/login', {
    data: { user_number: SEED.cashierUser.user_number }
  });
  expect(login.ok()).toBe(true);
  const { cookies } = await page.context().storageState();
  await writeFile(CASHIER_STATE, JSON.stringify({ cookies, origins: [] }, null, 2));
}

test.describe('Cashier POS Checkout Workflows', () => {
  // No page fixture here: reseedDatabase() rewrites cashier.json, and the page
  // is created afterwards from that fresh file, so no second login is needed.
  test.beforeEach(async () => {
    await reseedDatabase();
  });

  test('should open shift, add items to cart, and checkout successfully via Cash', async ({ page }) => {
    // 1. Navigate to POS (auth cookies are preloaded from cashier.json)
    await page.goto('/pos');

    // Wait for connecting loader to disappear
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });

    // 2. Verify shift open card/input is visible
    const startingCashInput = page.locator('input[placeholder="0.00"]');
    await expect(startingCashInput).toBeVisible();

    // Fill in starting float
    await startingCashInput.fill('50.00');

    // Click "Start Shift"
    await page.getByRole('button', { name: /Start Shift/i }).click();

    // Verify shift open prompt disappears and POS terminal loads
    await expect(startingCashInput).toBeHidden();

    // 3. Add item to cart
    // Click category "All" (or wait for products to load)
    await page.waitForSelector('.product-card, .btn-3d');
    
    // Select the "Test Burger" card
    const burgerCard = page.locator('.btn-3d', { hasText: 'Test Burger' }).first();
    await expect(burgerCard).toBeVisible();
    await burgerCard.click();

    // 4. Verify cart has item and correct totals
    const cartRow = page.locator('.divide-y tr', { hasText: 'Test Burger' }).first();
    await expect(cartRow).toBeVisible();

    // 5. Open checkout payment modal
    await page.getByRole('button', { name: /Pay/i }).click();
    
    const paymentModal = page.locator('text=Complete Payment');
    await expect(paymentModal).toBeVisible();

    // 6. Complete cash checkout
    // Select payment method "Cash"
    await page.getByRole('button', { name: /CASH/i }).click();

    // Enter cash amount tendered (10.00 JD)
    const cashInput = page.getByRole('textbox', { name: 'Amount Tendered' });
    await cashInput.fill('10.00');

    // Click Confirm Payment / Checkout
    const payBtn = page.getByRole('button', { name: /CONFIRM PAYMENT/i });
    const checkoutResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/pos/checkout') &&
      response.request().method() === 'POST'
    ));
    await payBtn.click();
    const checkoutResponse = await checkoutResponsePromise;
    expect(checkoutResponse.ok()).toBe(true);
    const checkoutBody = await checkoutResponse.json();
    expect(checkoutBody.success).toBe(true);

    // Confirm the authoritative sale completed and the working order reset.
    await expect(paymentModal).toBeHidden();
    await expect(page.getByText('Empty Order', { exact: true })).toBeVisible();
    const [[savedOrder]] = await pool.query('SELECT COUNT(*) AS count FROM orders WHERE invoice_id=?', [checkoutBody.invoice_id]);
    expect(Number(savedOrder.count)).toBe(1);
  });

  test('keeps tax accounting while freezing inclusive customer-copy data on a touch POS', async ({ page, browser }) => {
    await page.setViewportSize({ width: 1024, height: 768 });

    // Change the setting through the real admin screen, then use a separate
    // cashier browser context for the sale. This catches both the persisted
    // preference and the POS checkout boundary without sharing session state.
    const setReceiptMode = async (enabled) => {
      const adminContext = await browser.newContext({ storageState: 'playwright/.auth/admin.json' });
      try {
        const adminPage = await adminContext.newPage();
        await adminPage.goto('/admin/settings');
        const receiptSetting = adminPage
          .locator('label')
          .filter({ hasText: 'Tax-inclusive customer receipts' })
          .locator('input[type="checkbox"]');
        await expect(receiptSetting).toBeVisible();
        if ((await receiptSetting.isChecked()) !== enabled) {
          if (enabled) await receiptSetting.check();
          else await receiptSetting.uncheck();
        }
        const saveResponsePromise = adminPage.waitForResponse((response) => (
          response.url().includes('/api/system/settings') &&
          response.request().method() === 'POST'
        ));
        await adminPage.getByRole('button', { name: 'Save settings', exact: true }).first().click();
        const saveResponse = await saveResponsePromise;
        expect(saveResponse.ok()).toBe(true);
      } finally {
        await adminContext.close();
      }
    };

    await setReceiptMode(true);

    // Exercise the graphite branch at the same touch-sized viewport. The
    // setting is presentation-only, so the cart still shows its accounting
    // total and the server response is the authoritative receipt assertion.
    await pool.query(
      "INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.discount')",
      [SEED.cashierUser.id]
    );
    // A new session picks up the permission granted above.
    await loginCashierAgain(page);
    await page.addInitScript(() => {
      if (!localStorage.getItem('pos_theme')) localStorage.setItem('pos_theme', 'light');
    });
    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    const startingCashInput = page.locator('input[placeholder="0.00"]');
    await startingCashInput.fill('50.00');
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await expect(startingCashInput).toBeHidden();
    await expect(page.locator('.pos-polish')).not.toHaveClass(/pos-theme-dark/);

    await page.locator('.btn-3d', { hasText: 'Test Burger' }).first().click();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Order Discount', exact: true }).click();
    const discountModal = page.locator('div.fixed.inset-0').filter({ hasText: 'Order Discount' }).last();
    await discountModal.locator('input[type="number"]').fill('10');
    await discountModal.getByRole('button', { name: 'Save', exact: true }).click();

    const cartSummary = page.locator('.cart-summary');
    await expect(cartSummary).toContainText('5.22 JD');

    await page.getByRole('button', { name: /Pay/i }).click();
    const paymentModal = page.getByRole('dialog', { name: 'Complete Payment' });
    await paymentModal.getByRole('button', { name: /CASH/i }).click();
    await paymentModal.getByRole('textbox', { name: 'Amount Tendered' }).fill('5.22');

    const checkoutResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/pos/checkout') &&
      response.request().method() === 'POST'
    ));
    await paymentModal.getByRole('button', { name: /CONFIRM PAYMENT/i }).click();
    const checkoutResponse = await checkoutResponsePromise;
    expect(checkoutResponse.ok()).toBe(true);
    const checkoutBody = await checkoutResponse.json();
    expect(checkoutBody.receipt_display_v1).toMatchObject({
      taxMode: 'inclusive',
      summary: { taxAmount: 0, total: 5.22, orderDiscountAmount: 0.58 }
    });
    expect(checkoutBody.receipt_display_v1.rows[0]).toMatchObject({
      unitPrice: 5.8,
      extendedPrice: 5.8
    });

    const [[order]] = await pool.query(
      'SELECT tax, total, tax_inclusive_at_sale, receipt_tax_inclusive_at_sale FROM orders WHERE invoice_id = ?',
      [checkoutBody.invoice_id]
    );
    expect(Number(order.tax)).toBeCloseTo(0.72, 6);
    expect(Number(order.total)).toBeCloseTo(5.22, 6);
    expect(Number(order.tax_inclusive_at_sale)).toBe(0);
    expect(Number(order.receipt_tax_inclusive_at_sale)).toBe(1);
    await expect(paymentModal).toBeHidden();

    // Toggle the second supported POS presentation and verify the same sale
    // flow can continue without changing the server-owned accounting mode.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('button.drawer-theme-toggle').click();
    await expect(page.locator('.pos-polish')).toHaveClass(/pos-theme-dark/);

    // Turn the preference off in Admin Settings and create a second invoice.
    // The first response above remains inclusive, while this new sale must use
    // the newly selected exclusive customer copy.
    await setReceiptMode(false);
    await page.reload();
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    await expect(page.locator('.pos-polish')).toHaveClass(/pos-theme-dark/);
    await page.locator('.btn-3d', { hasText: 'Test Burger' }).first().click();
    await page.getByRole('button', { name: /Pay/i }).click();
    const secondPaymentModal = page.getByRole('dialog', { name: 'Complete Payment' });
    await secondPaymentModal.getByRole('button', { name: /CASH/i }).click();
    await secondPaymentModal.getByRole('textbox', { name: 'Amount Tendered' }).fill('5.80');
    const secondCheckoutResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/pos/checkout') &&
      response.request().method() === 'POST'
    ));
    await secondPaymentModal.getByRole('button', { name: /CONFIRM PAYMENT/i }).click();
    const secondCheckoutBody = await (await secondCheckoutResponsePromise).json();
    expect(secondCheckoutBody.receipt_display_v1).toMatchObject({
      taxMode: 'exclusive',
      summary: { taxAmount: 0.8, subtotal: 5, total: 5.8 }
    });
  });

  test('preserves unfinished order context across checkout close and refresh', async ({ page }) => {
    await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='default_order_type_id'", [SEED.orderType.id]);
    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    const startingCashInput = page.locator('input[placeholder="0.00"]');
    await startingCashInput.fill('50.00');
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await expect(startingCashInput).toBeHidden();

    await page.locator('.btn-3d', { hasText: 'Test Burger' }).first().click();
    await page.getByRole('button', { name: /Pay/i }).click();
    let checkout = page.getByRole('dialog', { name: 'Complete Payment' });
    await expect(checkout.getByRole('button', { name: 'Dine In' })).toHaveAttribute('aria-pressed', 'true');

    await checkout.getByRole('button', { name: 'Hash Required Type' }).click();
    await checkout.getByLabel('Hash Number').fill('HASH-REFRESH');
    await checkout.getByRole('button', { name: 'Customer' }).click();
    await checkout.getByLabel('Mobile No.').fill('0790000000');
    await checkout.getByLabel('Name').fill('Refresh Customer');
    await checkout.getByLabel('Address').fill('Amman');
    await checkout.getByLabel('Scheduled Date & Time').fill('2099-08-01T12:30');
    await checkout.locator('button.checkout-close').click();

    await page.reload();
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    await page.getByRole('button', { name: /Pay/i }).click();
    checkout = page.getByRole('dialog', { name: 'Complete Payment' });
    await expect(checkout.getByRole('button', { name: 'Hash Required Type' })).toHaveAttribute('aria-pressed', 'true');
    await expect(checkout.getByLabel('Hash Number')).toHaveValue('HASH-REFRESH');
    await checkout.getByRole('button', { name: 'Customer' }).click();
    await expect(checkout.getByLabel('Name')).toHaveValue('Refresh Customer');
    await expect(checkout.getByLabel('Address')).toHaveValue('Amman');
    await expect(checkout.getByLabel('Scheduled Date & Time')).toHaveValue('2099-08-01T12:30');

    await checkout.getByRole('button', { name: 'CARD' }).click();
    await checkout.locator('button.checkout-close').click();
    await page.reload();
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    await page.getByRole('button', { name: /Pay/i }).click();
    checkout = page.getByRole('dialog', { name: 'Complete Payment' });
    await expect(checkout.getByRole('button', { name: 'CASH' })).toHaveAttribute('aria-pressed', 'true');
    await expect(checkout.getByRole('button', { name: 'CARD' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('clears POS draft storage after a successful shift turnover', async ({ page }) => {
    await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='default_order_type_id'", [SEED.orderType.id]);
    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });

    const startingCashInput = page.locator('input[placeholder="0.00"]');
    await startingCashInput.fill('50.00');
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await expect(startingCashInput).toBeHidden();

    await page.locator('.btn-3d', { hasText: 'Test Burger' }).first().click();
    await page.getByRole('button', { name: /Pay/i }).click();
    const checkout = page.getByRole('dialog', { name: 'Complete Payment' });
    await checkout.getByRole('button', { name: 'Hash Required Type' }).click();
    await checkout.getByLabel('Hash Number').fill('HASH-SHIFT');
    await checkout.getByRole('button', { name: 'Customer' }).click();
    await checkout.getByLabel('Mobile No.').fill('0790000000');
    await checkout.getByLabel('Name').fill('Shift Customer');
    await checkout.getByLabel('Address').fill('Amman');
    await checkout.getByLabel('Scheduled Date & Time').fill('2099-08-01T12:30');
    await checkout.locator('button.checkout-close').click();

    const draftKeys = await page.evaluate((keys) => keys.filter((key) => localStorage.getItem(key) !== null), POS_ORDER_SESSION_KEYS);
    expect(draftKeys).toContain('pos_cart');
    expect(draftKeys).toContain('pos_order_context');

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Close Shift', exact: true }).click();
    const closeModal = page.locator('.modal-panel').filter({ hasText: 'Count your drawer' });
    await expect(closeModal).toBeVisible();
    await closeModal.locator('input[type="number"]').fill('50.00');

    const reload = page.waitForURL(/\/login(?:\?reason=expired)?$/);
    await closeModal.getByRole('button', { name: 'Close Shift', exact: true }).click();
    await reload;

    const remainingKeys = await page.evaluate((keys) => keys.filter((key) => localStorage.getItem(key) !== null), POS_ORDER_SESSION_KEYS);
    expect(remainingKeys).toEqual([]);

    // Closing your own shift revokes the auth token by design; use the existing
    // login endpoint before opening the next shift in this same turnover proof.
    await loginCashierAgain(page);
    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });

    const newShiftCashInput = page.locator('input[placeholder="0.00"]');
    await newShiftCashInput.fill('50.00');
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await expect(newShiftCashInput).toBeHidden();
    await expect(page.getByText('Empty Order', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pay', exact: true })).toBeDisabled();
  });

  test('keeps catalog tiles compact and readable on a POS touch display', async ({ page, browser }) => {
    const arabicProductName = 'كباب لحمة حلبي';
    const longArabicCategoryName = 'المعجنات والمناقيش والوجبات الخاصة';
    // Catalog edits go through a separate admin context from the fresh
    // admin.json, so neither shared session is replaced by a new login.
    const adminContext = await browser.newContext({ storageState: 'playwright/.auth/admin.json' });
    try {
      for (const data of [
        { id: SEED.product1.id, name: arabicProductName, background_color: '#ff0000' },
        { id: SEED.product2.id, background_color: '#10233b' },
      ]) {
        const response = await adminContext.request.put('/api/admin/products', { data });
        expect(response.ok()).toBe(true);
      }
      const categoryResponse = await adminContext.request.put('/api/admin/categories', {
        data: { id: SEED.category.id, name: longArabicCategoryName, parent_id: null }
      });
      expect(categoryResponse.ok()).toBe(true);
    } finally {
      await adminContext.close();
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    const startingCashInput = page.locator('input[placeholder="0.00"]');
    await startingCashInput.fill('50.00');
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await expect(startingCashInput).toBeHidden();

    const categorySidebar = page.locator('.category-sidebar');
    const categoryRail = page.locator('.category-rail-scroll');
    const categoryButton = page.locator('.category-button').first();
    const categoryLabel = categoryButton.locator('.category-button-label');
    const productStage = page.locator('.product-stage');
    const productCard = page.locator('.product-card').first();
    await expect(productCard).toBeVisible();

    await expect(categorySidebar).toHaveCSS('width', '160px');
    await expect(categorySidebar).toHaveCSS('flex-direction', 'column');
    await expect(categoryRail).toHaveCSS('padding-inline-start', '1px');
    await expect(categoryButton).toHaveCSS('min-height', '44px');
    await expect(categoryButton).toHaveCSS('padding-inline-start', '8px');
    await expect(categoryButton).toHaveCSS('padding-inline-end', '8px');
    await expect(categoryLabel).toHaveCSS('-webkit-line-clamp', '2');
    await expect(categoryLabel).toHaveCSS('white-space', 'normal');
    await expect(productStage).toHaveCSS('padding-top', '1px');
    const longCategoryLabel = page.locator('.category-button-label', { hasText: longArabicCategoryName });
    expect(await longCategoryLabel.evaluate(element => {
      const styles = getComputedStyle(element);
      return element.clientHeight <= parseFloat(styles.lineHeight) * 2 + 1 && element.scrollWidth <= element.clientWidth + 1;
    })).toBe(true);

    const metrics = await productCard.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const styles = getComputedStyle(element);
      return {
        height: bounds.height,
        width: bounds.width,
        boxShadow: styles.boxShadow,
      };
    });

    expect(metrics.height).toBe(96);
    expect(metrics.width).toBeGreaterThanOrEqual(110);
    expect(metrics.boxShadow).not.toBe('none');
    await expect(productStage).toHaveCSS('background-color', 'rgb(215, 220, 226)');
    const activeCategory = page.locator('.category-button.is-active').first();
    expect(await activeCategory.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
    await activeCategory.hover();
    await page.mouse.down();
    await expect(activeCategory).toHaveCSS('box-shadow', 'rgb(23, 47, 76) 0px -1px 0px 0px inset');
    await page.mouse.up();

    const redProductCard = page.locator('.product-card', { hasText: arabicProductName }).first();
    await expect(redProductCard.locator('h3')).toHaveClass(/(?:^|\s)text-white(?:\s|$)/);
    await expect(redProductCard.locator('h3')).toHaveClass(/product-card-name--arabic/);
    await expect(redProductCard.locator('h3')).toHaveCSS('font-size', '14px');
    await expect(redProductCard.locator('p').last()).toHaveClass(/(?:^|\s)text-white(?:\s|$)/);
    expect(await redProductCard.locator('h3').evaluate(element => getComputedStyle(element).textShadow)).not.toBe('none');
    const productArabicType = await redProductCard.locator('h3').evaluate(element => {
      const styles = getComputedStyle(element);
      return {
        fontFamily: styles.fontFamily,
        fontSize: parseFloat(styles.fontSize),
        lineHeight: parseFloat(styles.lineHeight),
        paddingInlineStart: parseFloat(styles.paddingInlineStart),
        paddingInlineEnd: parseFloat(styles.paddingInlineEnd),
      };
    });
    expect(productArabicType.fontFamily).toContain('IBM Plex Sans Arabic');
    expect(productArabicType.lineHeight).toBeGreaterThanOrEqual(productArabicType.fontSize * 1.5);
    expect(productArabicType.paddingInlineStart).toBeGreaterThanOrEqual(4);
    expect(productArabicType.paddingInlineEnd).toBeGreaterThanOrEqual(4);

    const darkProductCard = page.locator('.product-card', { hasText: 'Test Drink' }).first();
    await expect(darkProductCard.locator('h3')).toHaveClass(/(?:^|\s)text-white(?:\s|$)/);
    await expect(darkProductCard.locator('p').last()).toHaveClass(/(?:^|\s)text-white(?:\s|$)/);
    expect(await darkProductCard.locator('h3').evaluate(element => getComputedStyle(element).textShadow)).not.toBe('none');

    await redProductCard.click();
    const cartRow = page.locator('tbody tr', { hasText: arabicProductName }).first();
    await expect(cartRow).toBeVisible();
    await cartRow.click();
    await expect(cartRow).toHaveClass(/cart-row--selected/);
    await expect(cartRow).toHaveCSS('background-color', 'rgb(201, 215, 230)');
    await expect(cartRow).toHaveCSS('outline-style', 'none');
    expect(await cartRow.locator('td').first().evaluate(element => getComputedStyle(element).boxShadow)).toContain('inset');
    expect(await cartRow.locator('.font-arabic').first().evaluate(element => getComputedStyle(element).fontFamily)).toBe(productArabicType.fontFamily);

    await page.setViewportSize({ width: 1024, height: 768 });
    const compactMetrics = await productCard.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { height: bounds.height, width: bounds.width };
    });
    expect(compactMetrics.height).toBe(96);
    expect(compactMetrics.width).toBeGreaterThanOrEqual(110);

    await page.setViewportSize({ width: 1000, height: 768 });
    expect(await categorySidebar.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(500);
    await expect(categorySidebar).toHaveCSS('flex-direction', 'row');
    expect(await productStage.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });

  test('keeps constrained POS carts usable without shrinking the numpad', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    const startingCashInput = page.locator('input[placeholder="0.00"]');
    await startingCashInput.fill('50.00');
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await expect(startingCashInput).toBeHidden();

    const cartItems = page.locator('.cart-items-scroll');
    const cartNavigation = page.locator('.cart-navigation');
    const cartControls = page.locator('.cart-control-panel');
    const numpad = page.locator('.numpad');
    const numpadKey = numpad.locator('button').first();
    const productCard = page.locator('.product-card').first();

    await expect(productCard).toBeVisible();
    const productShadowColor = await productCard.evaluate(element => getComputedStyle(element).getPropertyValue('--shadow-color').trim());
    const numpadShadowColor = await numpadKey.evaluate(element => getComputedStyle(element).getPropertyValue('--shadow-color').trim());
    expect(numpadShadowColor).toBe(productShadowColor);

    const desktopItemsHeight = await cartItems.evaluate(element => element.getBoundingClientRect().height);
    const desktopNavigationHeight = await cartNavigation.evaluate(element => element.getBoundingClientRect().height);
    const desktopKeyHeight = await numpadKey.evaluate(element => element.getBoundingClientRect().height);
    expect(desktopKeyHeight).toBeGreaterThanOrEqual(38);

    await page.setViewportSize({ width: 1024, height: 768 });
    const compactItemsHeight = await cartItems.evaluate(element => element.getBoundingClientRect().height);
    expect(compactItemsHeight).toBeGreaterThanOrEqual(desktopItemsHeight);
    expect(await cartNavigation.evaluate(element => element.getBoundingClientRect().height)).toBe(desktopNavigationHeight);
    expect(await numpadKey.evaluate(element => element.getBoundingClientRect().height)).toBe(desktopKeyHeight);
    expect(await cartControls.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await cartNavigation.evaluate(element => element.getBoundingClientRect().height)).toBe(desktopNavigationHeight);
    expect(await cartItems.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

    await page.setViewportSize({ width: 1366, height: 768 });
    expect(await cartNavigation.evaluate(element => element.getBoundingClientRect().height)).toBe(desktopNavigationHeight);
  });

  test('loads expense categories when the expense dialog is mounted on demand', async ({ page }) => {
    await pool.query(
      "INSERT INTO expense_categories (name, is_active, created_by) VALUES ('POS Supplies', 1, ?)",
      [SEED.adminUser.id]
    );
    await pool.query(
      "INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.expenses')",
      [SEED.cashierUser.id]
    );
    // A new session picks up the permission granted above.
    await loginCashierAgain(page);

    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    const startingCash = page.locator('input[placeholder="0.00"]');
    await startingCash.fill('50.00');
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await expect(startingCash).toBeHidden();

    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Record expense', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Record expense' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('option', { name: 'POS Supplies' })).toHaveCount(1);
  });

  test('closes platform holds without requiring kitchen printing and reports receipt print failures on mobile', async ({ page }) => {
    await pool.query(
      "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Talabat', 1, 1)"
    );
    await pool.query(
      "INSERT INTO shifts (user_id, status, starting_cash, opened_at) VALUES (?, 'open', 0, NOW())",
      [SEED.cashierUser.id]
    );
    // A new session sees the shift opened directly in the database above.
    await loginCashierAgain(page);
    const cart = JSON.stringify({
      order_type_id: 3,
      order_discount: { type: null, value: 0 },
      tax_context_version: 1,
      tax_inclusive_at_hold: 0,
      tax_registration_type_at_hold: 'sales_tax',
      items: [{
        id: SEED.product1.id,
        product_id: SEED.product1.id,
        name: SEED.product1.name,
        qty: 1,
        price: 5,
        tax_rate: 16,
        selectedModifiers: []
      }]
    });
    const [fired] = await pool.query(
      "INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal, kitchen_fired) VALUES (?, 'Talabat fired', ?, 5, 1)",
      [SEED.cashierUser.id, cart]
    );
    const [unfired] = await pool.query(
      "INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal, kitchen_fired) VALUES (?, 'Talabat pending', ?, 5, 0)",
      [SEED.cashierUser.id, cart]
    );

    await page.addInitScript(() => localStorage.setItem('pos_receipt_printer_id', '1'));
    await page.route('**/api/print/print', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, message: 'Printer offline' })
    }));
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/order-notes');

    const desktopAction = page.locator('.notes-platform-close', { hasText: 'Close & print' });
    await expect(desktopAction).toBeVisible();
    await expect(desktopAction).toContainText('2 · 11.60 JD');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: /Talabat/ }).click();
    const mobileAction = page.locator('.notes-platform-mobile');
    await expect(mobileAction).toContainText('2 orders');
    await expect(mobileAction).toContainText('11.60 JD');
    await mobileAction.getByRole('button', { name: 'Close & print' }).click();

    await expect(page.getByText(/Talabat: 2 orders · 11\.60 JD/)).toBeVisible();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText(/2 receipts failed to print/)).toBeVisible();

    const [[sale]] = await pool.query("SELECT COUNT(*) AS count FROM orders WHERE payment_method='platform'");
    const [[firedRemaining]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE id=?', [fired.insertId]);
    const [[unfiredRemaining]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE id=?', [unfired.insertId]);
    expect(Number(sale.count)).toBe(2);
    expect(Number(firedRemaining.count)).toBe(0);
    expect(Number(unfiredRemaining.count)).toBe(0);
  });

  test('[priced note] survives refresh and checkout', async ({ page }) => {
    const [notesCategory] = await pool.query(
      "INSERT INTO categories (name, is_notes, is_active) VALUES ('Paid test notes', 1, 1)"
    );
    const [noteProduct] = await pool.query(
      "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, is_active, is_bundle) VALUES (?, 'Two slices', 0.20, 0, 'O', 1, 0)",
      [notesCategory.insertId]
    );
    await pool.query(
      "UPDATE products SET price=2.70, tax_rate=0, jofotara_tax_category='O' WHERE id=?",
      [SEED.product1.id]
    );
    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    const startingCash = page.locator('input[placeholder="0.00"]');
    await startingCash.fill('50.00');
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await expect(startingCash).toBeHidden();

    const burger = page.locator('.product-card', { hasText: 'Test Burger' }).first();
    await burger.click();
    const cartRow = page.locator('tbody tr', { hasText: 'Test Burger' }).first();
    await cartRow.click();
    await page.locator('.numpad').getByRole('button', { name: '3', exact: true }).click();

    const search = page.getByPlaceholder('Search items...');
    await search.fill('Two slices');
    await page.locator('.product-card', { hasText: 'Two slices' }).click();
    await expect(cartRow).toContainText('Two slices (+0.20)');
    await expect(cartRow).toContainText('3');
    await expect(cartRow).toContainText('8.70');
    await expect(page.locator('.cart-summary')).toContainText('8.70');

    await page.reload();
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    const restoredRow = page.locator('tbody tr', { hasText: 'Test Burger' }).first();
    await expect(restoredRow).toContainText('Two slices (+0.20)');
    await expect(restoredRow).toContainText('8.70');
    await expect(page.locator('.cart-summary')).toContainText('8.70');

    await page.getByRole('button', { name: /Pay/i }).click();
    const payment = page.getByRole('dialog', { name: 'Complete Payment' });
    await payment.getByRole('button', { name: /CASH/i }).click();
    await payment.getByRole('textbox', { name: 'Amount Tendered' }).fill('8.70');
    const responsePromise = page.waitForResponse(response =>
      response.url().includes('/api/pos/checkout') && response.request().method() === 'POST'
    );
    await payment.getByRole('button', { name: /CONFIRM PAYMENT/i }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect((await response.json()).total).toBe(8.70);
    expect(noteProduct.insertId).toBeGreaterThan(0);
  });
});
