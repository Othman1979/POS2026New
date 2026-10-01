# POS Cart Constrained-Screen Density Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover enough vertical cart-list space for approximately one additional item on 1024×768 and 1280×800 POS hardware without shrinking the numpad or changing cart behavior.

**Architecture:** Preserve `PosCartWorkspace.vue`'s existing flex ownership and add only semantic styling hooks to the existing cart regions. Apply compact chrome through a CSS media query limited to 1024–1280px widths and heights up to 800px; apply the product-matched numpad surface treatment globally because it resolves the cart's visual inconsistency at every desktop size.

**Tech Stack:** Vue 3 SFC template, existing Tailwind utility output, scoped rules in `src/pos.css`, Playwright E2E.

## Global Constraints

- Keep all numpad key dimensions, labels, handlers, disabled states, and four-column geometry unchanged.
- Keep Note, More, and Remove permanently visible and unchanged in function.
- Do not change cart width, mobile behavior below 1024px, or desktop density at 1366px and wider.
- Do not add JavaScript viewport logic, a density setting, a component, a dependency, or a reusable abstraction.
- Do not change cart state, calculations, permissions, events, translations, or checkout data flow.
- Verify both Arabic-safe overflow and the constrained screen sizes `1024×768` and `1280×800`.

---

## File Structure

- Modify `src/components/pos/PosCartWorkspace.vue`: add stable semantic classes to the existing cart item viewport, table header, and summary container; do not restructure the template.
- Modify `src/pos.css`: add product-matched numpad styling and one constrained-POS media query.
- Modify `tests/e2e/specs/cashier.checkout.spec.js`: exercise computed layout at constrained and ordinary desktop viewports.

### Task 1: Reclaim constrained cart height and align numpad tactility

**Files:**
- Modify: `tests/e2e/specs/cashier.checkout.spec.js`
- Modify: `src/components/pos/PosCartWorkspace.vue:3-285`
- Modify: `src/pos.css:545-619`

**Interfaces:**
- Consumes: existing `.cart-panel`, `.cart-navigation`, `.cart-item-actions`, `.cart-control-panel`, `.numpad`, and `.product-card` visual contracts.
- Produces: `.cart-items-scroll`, `.cart-table-header`, and `.cart-summary` styling hooks; no JavaScript interface.

- [ ] **Step 1: Write the failing browser test**

Add a focused test to `tests/e2e/specs/cashier.checkout.spec.js` that opens a shift, measures the existing desktop layout at 1366×768, then checks the intended constrained layout at 1024×768 and 1280×800:

```js
  test('gives constrained POS carts another row without shrinking the numpad', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/pos');
    await page.waitForSelector('text=Connecting to Ledger...', { state: 'hidden' });
    const startingCashInput = page.locator('input[placeholder="0.00"]');
    await startingCashInput.fill('50.00');
    await page.getByRole('button', { name: /Start Shift/i }).click();
    await expect(startingCashInput).toBeHidden();

    const cartItems = page.locator('.cart-items-scroll');
    const cartNavigation = page.locator('.cart-navigation');
    const cartHeader = page.locator('.cart-table-header th').first();
    const cartActions = page.locator('.cart-item-actions');
    const cartControls = page.locator('.cart-control-panel');
    const numpad = page.locator('.numpad');
    const numpadKey = numpad.locator('button').first();
    const cartSummary = page.locator('.cart-summary');

    const desktopItemsHeight = await cartItems.evaluate(element => element.getBoundingClientRect().height);
    const desktopKeyHeight = await numpadKey.evaluate(element => element.getBoundingClientRect().height);

    await page.setViewportSize({ width: 1024, height: 768 });
    const compactItemsHeight = await cartItems.evaluate(element => element.getBoundingClientRect().height);
    expect(compactItemsHeight).toBeGreaterThanOrEqual(desktopItemsHeight + 30);
    await expect(cartNavigation).toHaveCSS('height', '36px');
    await expect(cartHeader).toHaveCSS('padding-top', '3px');
    await expect(cartActions).toHaveCSS('padding-top', '2px');
    await expect(cartControls).toHaveCSS('padding-top', '4px');
    await expect(numpad).toHaveCSS('padding-top', '2px');
    await expect(cartSummary).toHaveCSS('padding-top', '6px');
    expect(await numpadKey.evaluate(element => element.getBoundingClientRect().height)).toBe(desktopKeyHeight);
    await expect(numpadKey).toHaveCSS('border-radius', '8px');
    expect(await numpadKey.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(cartNavigation).toHaveCSS('height', '36px');
    await expect(cartControls).toHaveCSS('padding-top', '4px');
    expect(await cartItems.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

    await page.setViewportSize({ width: 1366, height: 768 });
    await expect(cartNavigation).toHaveCSS('height', '44px');
    await expect(cartControls).toHaveCSS('padding-top', '7px');
  });
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx playwright test tests/e2e/specs/cashier.checkout.spec.js --grep "gives constrained POS carts" --reporter=line
```

Expected: FAIL because `.cart-items-scroll`, `.cart-table-header`, and `.cart-summary` are not yet present and the constrained chrome values are not active.

- [ ] **Step 3: Add semantic hooks without restructuring the template**

In `src/components/pos/PosCartWorkspace.vue`, change only the three existing class attributes:

```vue
<div class="cart-items-scroll flex-1 overflow-y-auto premium-scroll bg-surface" ...>
```

```vue
<thead class="cart-table-header bg-surface-container-lowest sticky top-0 z-10 shadow-sm border-b border-outline-variant/30">
```

```vue
<div class="cart-summary flex-1 flex flex-col justify-between bg-surface-container-low p-2.5 rounded-xl border border-outline-variant/30 font-sans">
```

- [ ] **Step 4: Add the minimal visual and constrained-density CSS**

In `src/pos.css`, extend the existing cart rules with:

```css
.pos-polish .numpad > button {
  border-radius: 0.5rem !important;
  box-shadow:
    0 3px 0 var(--shadow-color, #6f7d8e),
    0 6px 8px -6px rgb(17 24 39 / 45%) !important;
}

.pos-polish .numpad > button:active:not(:disabled) {
  transform: translateY(3px) !important;
  box-shadow: none !important;
}

.pos-polish .cart-summary {
  border-radius: 0.5rem !important;
}

@media (min-width: 64rem) and (max-width: 80rem) and (max-height: 50rem) {
  .pos-polish .cart-navigation {
    height: 2.25rem !important;
    padding-inline: 0.375rem !important;
  }

  .pos-polish .cart-table-header th {
    padding-block: 0.1875rem !important;
  }

  .pos-polish .cart-item-actions {
    padding-block: 0.125rem !important;
  }

  .pos-polish .cart-control-panel {
    padding: 0.25rem !important;
    gap: 0.25rem !important;
  }

  .pos-polish .numpad {
    padding: 0.125rem !important;
  }

  .pos-polish .cart-summary {
    padding: 0.375rem !important;
  }
}
```

Do not modify `.numpad > button` height or padding, `.cart-item-action`, cart state, or handlers.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```powershell
npx playwright test tests/e2e/specs/cashier.checkout.spec.js --grep "gives constrained POS carts" --reporter=line
```

Expected: PASS with one test passed and no browser errors.

- [ ] **Step 6: Verify the nearby POS layout contracts**

Run:

```powershell
npx playwright test tests/e2e/specs/cashier.checkout.spec.js --grep "catalog tiles compact|gives constrained POS carts" --reporter=line
npx vitest run src/components/__tests__/posTerminalOwnership.spec.js --reporter=dot
```

Expected: both Playwright tests pass and all POS ownership tests pass.

- [ ] **Step 7: Run layout and source hygiene checks**

Run:

```powershell
node C:\Users\bash\.agents\skills\impeccable\scripts\detect.mjs --json --scope layout src/components/pos/PosCartWorkspace.vue src/pos.css
rg -n "(?:gap|p[trblxy]?|m[trblxy]?|z)-\[" src/components/pos/PosCartWorkspace.vue src/pos.css
git diff --check
```

Expected: detector returns `[]`, grep finds no new arbitrary Tailwind spacing or z-index utility, and `git diff --check` exits successfully.

- [ ] **Step 8: Commit the isolated implementation**

```powershell
git add -- src/components/pos/PosCartWorkspace.vue src/pos.css tests/e2e/specs/cashier.checkout.spec.js docs/superpowers/plans/2026-07-30-pos-cart-constrained-screen-density.md
git commit -m "Polish constrained POS cart density"
```
