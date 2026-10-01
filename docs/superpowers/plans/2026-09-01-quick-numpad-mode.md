# Quick Numpad Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task in the current checkout. Do not create an isolated worktree or another feature branch.

**Goal:** Add a persistent `Quick numpad mode` setting that replaces the Qty/Discount/Price keys with a one-shot `×` amount-to-quantity gesture while preserving canonical product prices.

**Architecture:** Persist only the global feature flag in the existing `settings` key/value table. Keep the armed amount exclusively in the transient Pinia UI store, consume it on the next catalog product click, and derive a six-decimal quantity from the product's current canonical gross unit price. Reconcile the durable setting on initial load, settings events, POS reactivation, socket recovery, and disconnected focus; never persist the armed amount in local/session storage, held-order payloads, or cart snapshots.

**Tech Stack:** Vue 3, Pinia, Express 5, MySQL settings key/value table, Socket.IO settings notification, Vitest, Supertest.

## Global Constraints

- Work on the existing `codex/shift-audit-per-cashier` branch; do not create another branch or worktree.
- The setting key is exactly `quick_numpad_mode`, with stored values only `'0'` or `'1'` and default `'0'`.
- The English label is `Quick numpad mode`; the Arabic label is `وضع لوحة الأرقام السريعة`.
- Setting OFF preserves the current numpad and every existing Qty, Discount, and Price behavior unchanged.
- Setting ON removes the Qty, item-discount, and Price mode keys and shows one tall `×` key in their column.
- Ordinary number entry remains quantity entry. `amount → × → next catalog product` is the only quick-amount sequence.
- `×` never changes `price`, never writes `manual_price_override`, never bypasses canonical checkout pricing, and does not require `pos.price_override`.
- Quantity is `roundSix(target amount / current canonical gross base-unit amount)`, matching the existing `DECIMAL(12,6)` order-item contract. Use the effective catalog price and current tax/exemption context; modifiers remain separate additions and do not change the base quantity calculation.
- `×` is unavailable while a cart row is selected. It never reinterprets an already-edited cart row.
- The armed amount is one-shot and transient. It must clear after any catalog product attempt (success or failure), note-product click, barcode add, C, DEL/numeric editing after arming, modifier cancellation or completion, hold, checkout, new order, cart/table/held restore, POS deactivation/reactivation, setting-mode change, and browser refresh.
- A settings read failure keeps the last successfully applied mode. Out-of-order settings responses cannot overwrite a newer response.
- Do not add a schema column or migration. The existing settings table accepts the new whitelisted key.
- Do not refactor unrelated numpad, pricing, checkout, modifier, socket, or settings code.
- Run only the focused tests named by this plan plus `npm run architecture:check`; do not run the full suite.

---

## Evidence and decisions fixed before execution

- `backend/routes/system.js` already performs a batched upsert and emits `settings_changed`; adding a whitelisted key is sufficient for durable persistence.
- `src/pos/useTerminal.js` already owns runtime feature settings, but `loadSettings()` has no request-generation guard and POS recovery handlers do not consistently reload it. That is the stale-response boundary to fix.
- `src/pos/stores/orderUiStore.js` is explicitly transient and `resetTransient()` is already called by new-order, held-order, table, and checkout cleanup paths. It is the correct owner for an armed amount.
- `src/pos/stores/orderSessionStore.js:addToCart()` already converts pending number input into quantity and already performs stock validation before modifier selection. Compute quick quantity from the base product before that validation so stock semantics remain unchanged.
- The existing Price mode already proves the money rule: `getItemTotalGross({ ...item, qty: 1 })` derives tax-inclusive unit money and quantity is rounded to six decimals without changing `price`.
- `src/components/pos/PosCatalogWorkspace.vue` is the only ordinary catalog-card entry point. Barcode and note-product paths must explicitly cancel, not consume, an armed quick amount.
- Baseline evidence passed before writing this plan: four focused tests covering fractional quantity, requested amount, tax-inclusive quantity, and terminal settings (`4 passed`, `207 skipped`).

---

### Task 1: Persist and administer the Quick numpad mode flag

**Files:**
- Modify: `backend/routes/system.js:45-91, 95-211`
- Modify: `backend/tests/integration/settingsValidation.test.js`
- Modify: `src/admin/pages/Settings.vue:130-220, 904-940, 1082-1110, 1167-1195`
- Create: `src/admin/pages/__tests__/settingsQuickNumpad.spec.js`
- Modify: `src/shared/i18n/ar.json`

**Interfaces:**
- Produces: `GET /api/system/settings.quick_numpad_mode: '0' | '1'` for ordinary POS staff.
- Consumes: `POST /api/system/settings` body `{ quick_numpad_mode: '0' | '1' }`.
- Emits: existing `settings_changed` payload with `keys: ['quick_numpad_mode']` when that is the changed field.

- [ ] **Step 1: Add RED integration coverage for default, round-trip persistence, event key, and invalid values**

Add to `backend/tests/integration/settingsValidation.test.js`:

```js
it('defaults and persists quick numpad mode as a strict boolean setting', async () => {
    await pool.query("DELETE FROM settings WHERE setting_key='quick_numpad_mode'");
    try {
        const initial = await request(app)
            .get('/api/system/settings')
            .set('Cookie', adminCookie);
        expect(initial.statusCode).toBe(200);
        expect(initial.body.quick_numpad_mode).toBe('0');

        const enabled = await post({ quick_numpad_mode: '1' });
        expect(enabled.statusCode).toBe(200);
        expect(global.__mockEmit__).toHaveBeenCalledWith(
            'settings_changed',
            { keys: ['quick_numpad_mode'] }
        );
        const [[saved]] = await pool.query(
            "SELECT setting_value FROM settings WHERE setting_key='quick_numpad_mode'"
        );
        expect(saved.setting_value).toBe('1');

        const current = await request(app)
            .get('/api/system/settings')
            .set('Cookie', adminCookie);
        expect(current.body.quick_numpad_mode).toBe('1');

        expect((await post({ quick_numpad_mode: '0' })).statusCode).toBe(200);
    } finally {
        await pool.query("DELETE FROM settings WHERE setting_key='quick_numpad_mode'");
    }
});

it('rejects malformed quick numpad mode values', async () => {
    expect((await post({ quick_numpad_mode: 'yes' })).statusCode).toBe(400);
    expect((await post({ quick_numpad_mode: true })).statusCode).toBe(400);
    expect((await post({ quick_numpad_mode: 1 })).statusCode).toBe(400);
});
```

- [ ] **Step 2: Run the new route tests and confirm RED**

Run:

```powershell
npx vitest run backend/tests/integration/settingsValidation.test.js -t "quick numpad"
```

Expected: FAIL because `quick_numpad_mode` is absent from the response/allowlist and malformed values are not rejected.

- [ ] **Step 3: Add the strict server setting contract**

In the ordinary-staff response from `GET /api/system/settings`, add:

```js
quick_numpad_mode: settingsData['quick_numpad_mode'] ?? '0',
```

Before the generic validation block in `POST /api/system/settings`, add:

```js
if (data.quick_numpad_mode !== undefined && !['0', '1'].includes(data.quick_numpad_mode)) {
    return sendError(res, 400, 'Invalid quick numpad mode value.');
}
```

Append `'quick_numpad_mode'` to `allowed_keys`. Do not expose it in the deliberately restricted call-center settings projection; this mode is for the cashier/register surface.

- [ ] **Step 4: Add the admin setting UI contract test**

Create `src/admin/pages/__tests__/settingsQuickNumpad.spec.js`:

```js
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const settings = readFileSync(resolve(process.cwd(), 'src/admin/pages/Settings.vue'), 'utf8');
const arabic = JSON.parse(readFileSync(resolve(process.cwd(), 'src/shared/i18n/ar.json'), 'utf8'));

describe('Quick numpad settings wiring', () => {
    it('loads, displays, and saves the persisted toggle', () => {
        expect(settings).toContain('v-model="quickNumpadMode"');
        expect(settings).toContain("quickNumpadMode.value = dataSet.quick_numpad_mode === '1'");
        expect(settings).toContain("quick_numpad_mode: quickNumpadMode.value ? '1' : '0'");
    });

    it('uses deliberate English and Arabic copy', () => {
        expect(settings).toContain("$t('Quick numpad mode')");
        expect(arabic['Quick numpad mode']).toBe('وضع لوحة الأرقام السريعة');
        expect(arabic['Enter an amount, press ×, then choose a product to calculate its quantity.'])
            .toBe('أدخل المبلغ، ثم اضغط × واختر الصنف ليحسب النظام كميته.');
    });
});
```

- [ ] **Step 5: Run the UI contract test and confirm RED**

Run:

```powershell
npx vitest run src/admin/pages/__tests__/settingsQuickNumpad.spec.js
```

Expected: FAIL because the ref, toggle, payload field, and translations do not exist.

- [ ] **Step 6: Add the minimal General-tab toggle and natural Arabic copy**

In `Settings.vue` setup state:

```js
const quickNumpadMode = ref(false);
```

Load it with:

```js
quickNumpadMode.value = dataSet.quick_numpad_mode === '1';
```

Save it with:

```js
quick_numpad_mode: quickNumpadMode.value ? '1' : '0',
```

Add one existing-style toggle card under **POS options**:

```vue
<label :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors', quickNumpadMode ? 'bg-teal-50/60 border-teal-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
  <div class="flex items-center gap-3">
    <i class="fa-solid fa-calculator text-lg text-muted-foreground"></i>
    <div>
      <span class="text-xs font-semibold block text-foreground">{{ $t('Quick numpad mode') }}</span>
      <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Enter an amount, press ×, then choose a product to calculate its quantity.') }}</span>
    </div>
  </div>
  <input type="checkbox" v-model="quickNumpadMode" class="accent-teal-600 w-4 h-4">
</label>
```

Return `quickNumpadMode` from `setup()`. Add the two exact Arabic translations asserted above.

- [ ] **Step 7: Run Task 1 focused tests GREEN**

Run:

```powershell
npx vitest run backend/tests/integration/settingsValidation.test.js -t "quick numpad"
npx vitest run src/admin/pages/__tests__/settingsQuickNumpad.spec.js
```

Expected: both commands PASS.

- [ ] **Step 8: Review Task 1 before committing**

Verify from source and test output:

- absent row reads as `'0'`;
- only string `'0'`/`'1'` persists;
- partial settings saves do not overwrite the key;
- save still uses the existing batched upsert, invalidations, and `settings_changed` emission;
- no migration or seed edit was added.

- [ ] **Step 9: Commit Task 1**

```powershell
git add backend/routes/system.js backend/tests/integration/settingsValidation.test.js src/admin/pages/Settings.vue src/admin/pages/__tests__/settingsQuickNumpad.spec.js src/shared/i18n/ar.json
git commit -m "feat(settings): add quick numpad mode"
```

---

### Task 2: Make the saved mode converge without stale responses

**Files:**
- Modify: `src/pos/useTerminal.js:7-31, 48-82, 269-278`
- Modify: `backend/tests/unit/useTerminal.test.js`
- Modify: `src/components/PosTerminal.vue:905-915, 1151-1172, 1176-1210`
- Modify: `src/components/__tests__/posTerminalOwnership.spec.js`

**Interfaces:**
- Produces: `useTerminal().quickNumpadMode: Ref<boolean>`.
- Produces: `loadSettings(): Promise<boolean>` where only the latest-started successful request mutates refs.
- Consumes: `GET /api/system/settings.quick_numpad_mode`.

- [ ] **Step 1: Add RED tests for persistence, failure retention, and last-request-wins behavior**

Extend `backend/tests/unit/useTerminal.test.js`:

```js
it('loads and retains the persistent quick numpad setting', async () => {
    global.fetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ success: true, quick_numpad_mode: '1' })
    });
    const terminal = useTerminal();

    await expect(terminal.loadSettings()).resolves.toBe(true);
    expect(terminal.quickNumpadMode.value).toBe(true);

    global.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(terminal.loadSettings()).resolves.toBe(false);
    expect(terminal.quickNumpadMode.value).toBe(true);
});

it('does not let an older settings response overwrite the newest request', async () => {
    const terminal = useTerminal();
    let resolveOld;
    let resolveNew;
    global.fetch = vi.fn()
        .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
        .mockReturnValueOnce(new Promise(resolve => { resolveNew = resolve; }));

    const oldRequest = terminal.loadSettings();
    const newRequest = terminal.loadSettings();
    resolveNew({ json: () => Promise.resolve({ success: true, quick_numpad_mode: '1' }) });
    await newRequest;
    resolveOld({ json: () => Promise.resolve({ success: true, quick_numpad_mode: '0' }) });
    await oldRequest;

    expect(terminal.quickNumpadMode.value).toBe(true);
});
```

Reset `terminal.quickNumpadMode.value = false` in the existing `beforeEach()` because `useTerminal` uses module-scope singleton refs.

- [ ] **Step 2: Run terminal tests and confirm RED**

```powershell
npx vitest run backend/tests/unit/useTerminal.test.js -t "quick numpad|older settings response"
```

Expected: FAIL because the ref, return contract, and generation guard do not exist.

- [ ] **Step 3: Implement newest-successful-settings authority**

In `src/pos/useTerminal.js`, add module state:

```js
const quickNumpadMode = ref(false);
let settingsRequestId = 0;
```

Change `loadSettings()` so it captures `const requestId = ++settingsRequestId`, returns `false` on failed/non-success responses, and checks `requestId === settingsRequestId` immediately before assigning any setting ref. A newer failed request still supersedes every older in-flight request; retain the last value that was successfully applied before those requests began. On the winning successful response assign:

```js
quickNumpadMode.value = data.quick_numpad_mode === '1';
```

Return `true` only after the winning response is applied. A stale response returns `false` and must not log a false operational error. Export `quickNumpadMode` in the existing return object.

- [ ] **Step 4: Add RED source-contract assertions for all recovery boundaries**

Extend `src/components/__tests__/posTerminalOwnership.spec.js` with assertions over the named handlers:

```js
it('reconciles terminal settings after every event-loss boundary', () => {
    const reconnect = source.slice(
        source.indexOf('const handleSocketReconnected'),
        source.indexOf('const handleWindowFocus')
    );
    const focus = source.slice(
        source.indexOf('const handleWindowFocus'),
        source.indexOf('let hasSeenInitialActivation')
    );
    const activation = source.slice(
        source.indexOf('onActivated(async () =>'),
        source.indexOf('onDeactivated(() =>')
    );

    expect(reconnect).toContain('await terminal.loadSettings()');
    expect(focus).toMatch(/socket\.value\?\.connected !== true[\s\S]*await terminal\.loadSettings\(\)/);
    expect(activation).toMatch(/shouldRefreshCatalog[\s\S]*await terminal\.loadSettings\(\)/);
});
```

- [ ] **Step 5: Run the source-contract test and confirm RED**

```powershell
npx vitest run src/components/__tests__/posTerminalOwnership.spec.js -t "event-loss boundary"
```

Expected: FAIL because recovery currently refreshes catalog/order data but not terminal settings.

- [ ] **Step 6: Reconcile on activation, reconnect, and disconnected focus**

Make these narrow changes in `PosTerminal.vue`:

```js
const handleSocketReconnected = async () => {
  if (!initialCatalogSnapshotStarted) return;
  initialRecoveryRefreshStarted = true;
  await terminal.loadSettings();
  await refreshCatalogAndCart();
  // existing work remains unchanged
};
```

Inside the disconnected branch of `handleWindowFocus()` add `await terminal.loadSettings()` before catalog reconciliation. Inside `onActivated()`, call it only when `shouldRefreshCatalog` is true so initial mount retains its existing single bootstrap load:

```js
if (shouldRefreshCatalog) await terminal.loadSettings();
```

Keep `onSettingsChanged()` calling `terminal.loadSettings()`; the generation guard now makes overlapping events safe. Change the existing mount-time `terminal.loadSettings()` call to `await terminal.loadSettings()` so catalog interaction does not start before the initial mode read has settled.

- [ ] **Step 7: Run Task 2 focused tests GREEN**

```powershell
npx vitest run backend/tests/unit/useTerminal.test.js -t "quick numpad|older settings response"
npx vitest run src/components/__tests__/posTerminalOwnership.spec.js -t "event-loss boundary"
```

Expected: both commands PASS.

- [ ] **Step 8: Break Task 2 before committing**

Use deferred promises in the test to prove all four orders:

- old OFF resolves after new ON;
- old ON resolves after new OFF;
- newest request fails after an older success (keep the last previously applied value, do not apply the older in-flight response);
- a later successful request after failure updates normally.

Do not add polling, localStorage, or a second settings cache.

- [ ] **Step 9: Commit Task 2**

```powershell
git add src/pos/useTerminal.js backend/tests/unit/useTerminal.test.js src/components/PosTerminal.vue src/components/__tests__/posTerminalOwnership.spec.js
git commit -m "fix(pos): reconcile quick numpad settings"
```

---

### Task 3: Implement one-shot amount-to-quantity semantics

**Files:**
- Modify: `src/pos/stores/orderUiStore.js:20-70, 90-175`
- Modify: `src/pos/stores/orderSessionStore.js:1775-1875, 1957-2030`
- Modify: `src/pos/stores/orderSession/tableOrderWorkflow.js:804-895`
- Modify: `src/pos/useCart.js:60-145`
- Modify: `backend/tests/unit/orderSessionStore.test.js`

**Interfaces:**
- Produces: `orderUi.quickTargetAmount: Ref<number | null>`.
- Produces: `armQuickAmount(): boolean`, `cancelQuickAmount(): void` from the session store/facade.
- Extends: `addToCart(product, { source?: string, useQuickAmount?: boolean })`.
- Invariant: consuming/cancelling quick input never mutates the product unit price.

- [ ] **Step 1: Add RED unit tests for the exact quick-amount contract**

Add a `describe('useOrderSessionStore — quick numpad mode', ...)` block to `backend/tests/unit/orderSessionStore.test.js` covering these exact cases:

```js
it('arms only a positive amount for the next product and not a selected row', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.numpadInput = '6';
    expect(s.armQuickAmount()).toBe(true);
    expect(ui.quickTargetAmount).toBe(6);

    s.cart = [{ id: 1, price: 10, qty: 1 }];
    s.selectedCartIndex = 0;
    ui.numpadInput = '8';
    expect(s.armQuickAmount()).toBe(false);
    expect(ui.quickTargetAmount).toBe(null);
});

it('turns gross target money into a precise quantity without overriding price', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.numpadInput = '11.60';
    expect(s.armQuickAmount()).toBe(true);

    await s.addToCart(
        { id: 1, name: 'Taxed item', price: 20, tax_rate: 16, price_override_locked: 1 },
        { source: 'catalog', useQuickAmount: true }
    );

    expect(s.cart[0]).toMatchObject({ price: 20, qty: 0.5 });
    expect(s.cart[0].manual_price_override).toBeUndefined();
    expect(s.getItemTotalGross(s.cart[0])).toBeCloseTo(11.6, 5);
    expect(ui.quickTargetAmount).toBe(null);
    expect(ui.numpadInput).toBe('');
});

it('uses canonical base price before modifiers and preserves modifier behavior', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.numpadInput = '5';
    s.armQuickAmount();

    await s.addToCart({
        id: 2,
        name: 'Configured item',
        price: 10,
        tax_rate: 0,
        modifiers: JSON.stringify([{ id: 'g', name: 'Size', options: [{ id: 'o', name: 'Extra', price: 2 }] }])
    }, { source: 'catalog', useQuickAmount: true });

    expect(ui.activeModifierQty).toBe(0.5);
    expect(ui.quickTargetAmount).toBe(null);
    ui.selectedModifiers = { 0: [0] };
    await s.confirmModifiers();
    expect(s.cart[0]).toMatchObject({ price: 12, qty: 0.5 });
    expect(s.cartTotal).toBe(6);
});

it('consumes quick state on rejected products, zero prices, and barcode input', async () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();

    ui.numpadInput = '6';
    s.armQuickAmount();
    await s.addToCart({ id: 3, price: 10, can_sell: 0 }, { source: 'catalog', useQuickAmount: true });
    expect(ui.quickTargetAmount).toBe(null);

    ui.numpadInput = '6';
    s.armQuickAmount();
    await s.addToCart({ id: 4, price: 0, can_sell: 1 }, { source: 'catalog', useQuickAmount: true });
    expect(s.cart).toEqual([]);
    expect(ui.quickTargetAmount).toBe(null);

    ui.numpadInput = '6';
    s.armQuickAmount();
    await s.addToCart({ id: 5, price: 2, can_sell: 1 }, { source: 'barcode' });
    expect(s.cart.at(-1).qty).toBe(1);
    expect(ui.quickTargetAmount).toBe(null);
});

it('clears armed input through editing and every transient reset', () => {
    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    ui.numpadInput = '6';
    s.armQuickAmount();
    s.appendNumpad('2');
    expect(ui.quickTargetAmount).toBe(null);
    expect(ui.numpadInput).toBe('2');

    ui.numpadInput = '6';
    s.armQuickAmount();
    ui.resetTransient();
    expect(ui.quickTargetAmount).toBe(null);
    expect(ui.numpadInput).toBe('');
});
```

Also add focused cases for `C`, `DEL`, quantity rounding (`6 / 10 = 0.600`), sub-cent results that round to zero, stock rejection using the derived quantity, and a user without `pos.price_override`.

- [ ] **Step 2: Run the quick numpad tests and confirm RED**

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js -t "quick numpad"
```

Expected: FAIL because the quick state/actions do not exist.

- [ ] **Step 3: Add only the transient state required**

In `orderUiStore.js` add:

```js
const quickTargetAmount = ref(null);

const clearQuickTargetAmount = () => {
  quickTargetAmount.value = null;
};
```

Set it to `null` in `setNumpadMode()` and `resetTransient()`. Return the ref and action. Do not persist it, add it to a cart payload, or mirror it into localStorage.

- [ ] **Step 4: Add one local quantity derivation and one-shot actions**

In `orderSessionStore.js`, next to the existing numpad actions, implement:

```js
const cancelQuickAmount = ({ clearInput = true } = {}) => {
  const ui = useOrderUiStore();
  ui.clearQuickTargetAmount();
  if (clearInput) ui.numpadInput = '';
};

const armQuickAmount = () => {
  const ui = useOrderUiStore();
  if (selectedCartIndex.value !== null) {
    cancelQuickAmount();
    return false;
  }
  const amount = roundMoney(Number(ui.numpadInput));
  if (!(amount > 0)) {
    cancelQuickAmount();
    window.showPosToast?.(t('Enter a valid amount first.'), 'warning');
    return false;
  }
  ui.quickTargetAmount = amount;
  return true;
};

const quickQuantityForProduct = (product, targetAmount) => {
  const unitAmount = getItemTotalGross({
    ...product,
    qty: 1,
    discountType: null,
    discountValue: 0,
    modifier_surcharge: null,
    modifier_tax_amount: null,
    selectedModifiers: null
  });
  if (!(Number.isFinite(unitAmount) && unitAmount > 0)) return null;
  const qty = roundSix(targetAmount / unitAmount);
  return qty > 0 ? qty : null;
};
```

Use the existing imported `roundMoney` and `roundSix`; do not create another rounding helper.

- [ ] **Step 5: Consume before validation and reuse the normal add path**

At the start of `addToCart()`:

```js
const usesQuickAmount = options.source === 'catalog' && options.useQuickAmount === true;
const targetAmount = usesQuickAmount ? Number(ui.quickTargetAmount) : null;
if (ui.quickTargetAmount != null) cancelQuickAmount();

const quickQty = targetAmount > 0 ? quickQuantityForProduct(product, targetAmount) : null;
if (targetAmount > 0 && quickQty == null) {
  await window.showPosAlert(t('This product needs a valid price before its quantity can be calculated.'));
  return false;
}
const qtyToAdd = quickQty ?? getAddQuantity(!isBarcodeAdd);
```

Keep the existing sold-out, stock, modifier, and `processFinalAddToCart()` sequence. Because quick quantity is computed before stock validation and assigned to `activeModifierQty`, modifiers need no separate quick-mode branch.

When a quick amount is armed, `appendNumpad()` starts a fresh ordinary quantity input; `clearNumpad()` and `backspaceNumpad()` cancel the armed amount before their existing behavior. Export `armQuickAmount` and `cancelQuickAmount` from the session store and pass them through the logic-free `useCart()` facade. Export `quickTargetAmount` from the facade via `storeToRefs(ui)`.

Use the same transient clear at the existing successful order-boundary sites instead of relying on callers to remember later:

```js
ui.clearQuickTargetAmount();
ui.numpadInput = '';
```

Apply that pair when `loadSavedOrder()` or `loadOrderForEditing()` begins; after a successful register/cart clear; after successful held follow-up and held-baseline confirmation; and after successful `holdCurrentOrder()` in `tableOrderWorkflow.js`. Existing `startNewOrder()`, `restoreHeldOrder()`, table loading/closing, and checkout finalization already call `resetTransient()` and therefore clear the new ref automatically. Do not clear the arm when a hold/checkout request fails and the current draft remains editable.

- [ ] **Step 6: Run Task 3 tests GREEN, including the unchanged old modes**

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js -t "quick numpad|armed fractional numpad quantity|turns a requested line amount|derives quantity from the tax-inclusive"
```

Expected: all selected tests PASS. This command proves the new path and the existing Qty/Price behavior coexist while the setting is OFF.

- [ ] **Step 7: Break Task 3 before committing**

Add or confirm tests for:

- target `6`, effective price `10`, tax `0` → qty `0.600`, price `10`;
- target `11.60`, net price `20`, tax `16%` → qty `0.500`, gross `11.60`;
- price-locked product and denied `pos.price_override` still work because no price changes;
- stock `0.4` rejects a derived qty `0.5`;
- a failed catalog add cannot leave `quickTargetAmount` armed;
- a barcode scan adds qty `1` and cancels the pending catalog gesture;
- modifier confirmation uses the already-derived base quantity exactly once;
- direct cart clear, successful hold/follow-up/baseline, saved-cart/edit restore, `resetTransient()`, and POS deactivate/reactivate all clear state;
- no serialized cart/held/table payload contains `quickTargetAmount`.

- [ ] **Step 8: Commit Task 3**

```powershell
git add src/pos/stores/orderUiStore.js src/pos/stores/orderSessionStore.js src/pos/stores/orderSession/tableOrderWorkflow.js src/pos/useCart.js backend/tests/unit/orderSessionStore.test.js
git commit -m "feat(pos): add one-shot amount quantity input"
```

---

### Task 4: Wire the compact keypad and close every UI stale-state edge

**Files:**
- Modify: `src/components/pos/PosCartWorkspace.vue:200-265, 350-435`
- Modify: `src/components/pos/PosCatalogWorkspace.vue:235-390`
- Modify: `src/components/pos/ModifierSelectorModal.vue:1-75`
- Modify: `src/components/PosTerminal.vue:1176-1315`
- Modify: `src/pos/stores/orderSessionStore.js:2101-2145`
- Modify: `src/pos/useCart.js:80-135`
- Modify: `src/components/__tests__/posTerminalOwnership.spec.js`
- Modify: `src/components/pos/__tests__/callCenterWorkflow.spec.js`
- Create: `src/components/pos/__tests__/quickNumpadMode.spec.js`
- Modify: `src/shared/i18n/ar.json`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

**Interfaces:**
- Consumes: `useTerminal().quickNumpadMode`.
- Consumes: `useCart().quickTargetAmount`, `armQuickAmount()`, and `cancelQuickAmount()`.
- Calls: `addToCart(product, { source: 'catalog', useQuickAmount: quickNumpadMode })` for ordinary catalog products.

- [ ] **Step 1: Add RED source and behavior contracts for the switched keypad**

Create `src/components/pos/__tests__/quickNumpadMode.spec.js`:

```js
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cart = readFileSync(resolve(process.cwd(), 'src/components/pos/PosCartWorkspace.vue'), 'utf8');
const catalog = readFileSync(resolve(process.cwd(), 'src/components/pos/PosCatalogWorkspace.vue'), 'utf8');
const modifier = readFileSync(resolve(process.cwd(), 'src/components/pos/ModifierSelectorModal.vue'), 'utf8');

describe('Quick numpad UI contract', () => {
    it('switches three mode keys for one tall one-shot multiplier', () => {
        expect(cart).toContain('v-if="quickNumpadMode"');
        expect(cart).toContain('row-span-3');
        expect(cart).toContain('@click="armQuickAmount"');
        expect(cart).toContain('{{ quickTargetAmount != null ? $t(\'Amount\')');
        expect(cart).toMatch(/v-else[\s\S]*setNumpadMode\('qty'\)/);
        expect(cart).toMatch(/v-if="!quickNumpadMode"[\s\S]*setNumpadMode\('discount'\)/);
        expect(cart).toMatch(/v-if="!quickNumpadMode"[\s\S]*setNumpadMode\('price'\)/);
    });

    it('uses quick amount only for an ordinary catalog click', () => {
        expect(catalog).toContain("addToCart(product, { source: 'catalog', useQuickAmount: quickNumpadMode.value })");
        expect(catalog).toMatch(/isNoteProduct\(product\)[\s\S]*cancelQuickAmount\(\)/);
        expect(catalog).toMatch(/!isProductSellable\(product\)[\s\S]*cancelQuickAmount\(\)/);
    });

    it('cancels modifier work through one cleanup action', () => {
        expect(modifier).not.toContain('@click="showModifierModal = false"');
        expect(modifier.match(/@click="cancelModifiers"/g)).toHaveLength(2);
    });
});
```

- [ ] **Step 2: Run the component contract and confirm RED**

```powershell
npx vitest run src/components/pos/__tests__/quickNumpadMode.spec.js
```

Expected: FAIL because the switched keypad and cancellation wiring do not exist.

- [ ] **Step 3: Render one tall `×` key without changing the classic layout**

In `PosCartWorkspace.vue`, import/use `useTerminal()` and expose `quickNumpadMode`. Obtain `quickTargetAmount`, `armQuickAmount`, and `cancelQuickAmount` from `useCart()`.

At the current Qty key grid position render:

```vue
<button v-if="quickNumpadMode"
  type="button"
  @click="armQuickAmount"
  :disabled="selectedCartIndex !== null || !(Number(numpadInput) > 0)"
  :aria-pressed="quickTargetAmount != null"
  :class="['btn-3d row-span-3 rounded-xl border text-2xl font-black transition-all', quickTargetAmount != null ? 'bg-teal-600 text-white border-teal-700 shadow-md' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface hover:bg-surface-container-low']"
  :style="{ '--shadow-color': quickTargetAmount != null ? '#2b4b71' : '#6f7d8e' }">×</button>
<button v-else @click="setNumpadMode('qty')" ...>{{ $t('Qty') }}</button>
```

Add `v-if="!quickNumpadMode"` to the Discount and Price keys. Leave all digit, preset, C, decimal, and DEL keys in their existing positions.

When `quickTargetAmount != null`, show `Amount` / `المبلغ` in the console, keep the entered money visible, and keep the selected-row label logic unchanged otherwise.

Watch `quickNumpadMode` with `{ immediate: true }`. On initial component ownership and either ON→OFF or OFF→ON, call `cancelQuickAmount()`, then `setNumpadMode('qty')`. This closes the live-settings toggle edge and clears a legacy Discount/Price selection before those buttons disappear.

In `PosTerminal.vue`, obtain `cancelQuickAmount` from `useCart()`. Call it during `onActivated()` alongside the existing numpad reset and during `onDeactivated()` before listeners are removed. This makes page navigation a hard boundary even when the saved setting itself did not change.

- [ ] **Step 4: Scope consumption to catalog clicks and cancel rejected card clicks**

In `PosCatalogWorkspace.vue`, read `quickNumpadMode` from `useTerminal()` and `quickTargetAmount`/`cancelQuickAmount` from `useCart()`.

For an ordinary sellable product:

```js
await addToCart(product, {
  source: 'catalog',
  useQuickAmount: quickNumpadMode.value
});
```

Before returning from a sold-out product click or a note-product click, call `cancelQuickAmount()` only when `quickTargetAmount.value != null`. Do not cancel on long-press/context-menu availability management because that is not a sale attempt.

- [ ] **Step 5: Give modifier close/cancel one truthful cleanup path**

Add `cancelModifiers()` to `orderSessionStore.js`:

```js
const cancelModifiers = () => {
  const ui = useOrderUiStore();
  ui.showModifierModal = false;
  ui.activeModifierProduct = null;
  ui.activeModifierQty = 1;
  ui.selectedModifiers = {};
  cancelQuickAmount();
};
```

Have `confirmModifiers()` retain the required-option early return, then finish with one cleanup path:

```js
const added = processFinalAddToCart(product, ui.activeModifierQty, finalPrice, noteLines.join('\n'), {
  selectedModifiers,
  modifierSurcharge,
  modifierTaxAmount: includedModifierTax
});
cancelModifiers();
return added;
```

This closes the modal and clears modifier/quick state whether the final add succeeds or is rejected; a missing required option still leaves the modal open for correction. Export `cancelModifiers` through `useCart()`. Replace both direct `showModifierModal = false` buttons in `ModifierSelectorModal.vue` with `cancelModifiers`.

Add these exact Arabic messages in `src/shared/i18n/ar.json` and assert them in the quick-mode test:

```json
"Enter a valid amount first.": "أدخل مبلغاً صحيحاً أولاً.",
"This product needs a valid price before its quantity can be calculated.": "يجب أن يكون للصنف سعر صحيح قبل حساب كميته."
```

- [ ] **Step 6: Preserve classic call-center and permission behavior**

Update `callCenterWorkflow.spec.js` so it asserts:

- classic mode still renders Price and Discount disabled for call-center users;
- quick mode contains no permission condition on `×` because it changes quantity only;
- `pos.price_override` and `price_override_locked` remain attached only to the classic Price key.

Do not expand the restricted call-center `/api/system/settings` projection in Task 1. If the cashier register setting is unavailable, call center remains in classic mode.

- [ ] **Step 7: Run focused UI and store tests GREEN**

```powershell
npx vitest run src/components/pos/__tests__/quickNumpadMode.spec.js src/components/pos/__tests__/callCenterWorkflow.spec.js src/components/__tests__/posTerminalOwnership.spec.js
npx vitest run backend/tests/unit/orderSessionStore.test.js -t "quick numpad|modifier"
```

Expected: all selected tests PASS.

- [ ] **Step 8: Run the stale/ghost adversarial matrix**

Use focused Vitest cases (not a manual claim) to prove:

| Start state | Interruption | Required result |
|---|---|---|
| Quick setting ON, no arm | browser refresh | mode remains ON; amount is unarmed |
| Amount armed | browser refresh / Pinia recreation | mode remains ON; amount is gone |
| Amount armed | settings toggled OFF or ON | input and arm are cleared; mode is Qty |
| Amount armed | socket disconnect only | local arm remains usable; no server state is invented |
| Setting changed while disconnected | reconnect | newest server mode applies; arm is cleared by the mode watcher |
| Setting changed while POS deactivated | activation | newest server mode applies |
| Two settings responses overlap | older resolves last | newest-started response wins |
| Amount armed | sold-out/zero-price/note click/barcode scan | arm is cleared; no later product is affected |
| Amount armed | modifier cancel | no cart line; arm and modifier state cleared |
| Amount armed | modifier confirm | exactly one line with derived qty; state cleared |
| Classic mode | all old keys | behavior and permission gates unchanged |

Do not store the armed amount to survive an actual network disconnect. It is local UI intent and may remain in memory during a brief disconnect, but it must never resurrect after refresh, navigation reset, or settings reconciliation.

- [ ] **Step 9: Update the architecture authority**

Update `docs/architecture.json`:

- extend the `adm-flow-settings-toggle` summary/step 7 to name `quick_numpad_mode` and the activation/reconnect/disconnected-focus reconciliation;
- add an invariant that the saved feature flag is durable but `quickTargetAmount` is transient, one-shot, and never serialized;
- retain the invariant that `useCart()` is logic-free.

Regenerate and verify:

```powershell
npm run architecture
npm run architecture:check
```

Expected: generated HTML changes only through the architecture generator; check PASS.

- [ ] **Step 10: Commit Task 4**

```powershell
git add src/components/pos/PosCartWorkspace.vue src/components/pos/PosCatalogWorkspace.vue src/components/pos/ModifierSelectorModal.vue src/pos/stores/orderSessionStore.js src/pos/useCart.js src/components/__tests__/posTerminalOwnership.spec.js src/components/pos/__tests__/callCenterWorkflow.spec.js src/components/pos/__tests__/quickNumpadMode.spec.js src/shared/i18n/ar.json docs/architecture.json docs/architecture.html
git commit -m "feat(pos): enable quick numpad workflow"
```

---

## Final focused verification

- [ ] Run only the feature's server, state, settings, and UI tests:

```powershell
npx vitest run backend/tests/integration/settingsValidation.test.js backend/tests/unit/useTerminal.test.js backend/tests/unit/orderSessionStore.test.js src/admin/pages/__tests__/settingsQuickNumpad.spec.js src/components/pos/__tests__/quickNumpadMode.spec.js src/components/pos/__tests__/callCenterWorkflow.spec.js src/components/__tests__/posTerminalOwnership.spec.js -t "quick numpad|older settings response|event-loss boundary|armed fractional numpad quantity|requested line amount|tax-inclusive|modifier"
npm run architecture:check
```

- [ ] Inspect the final diff for forbidden state:

```powershell
git diff master...HEAD -- src backend docs/architecture.json | Select-String -Pattern "quickTargetAmount|quick_numpad_mode|localStorage|sessionStorage|manual_price_override"
```

Required reading of that output:

- `quick_numpad_mode` appears only in server settings, admin settings, terminal settings, tests, translations, and architecture documentation;
- `quickTargetAmount` appears only in transient UI/session/component code and tests;
- there is no new localStorage/sessionStorage write;
- there is no new `manual_price_override` assignment;
- no database migration exists;
- working tree contains only intended plan/execution changes.

## Definition of done

- Admin can persist Quick numpad mode and every register converges after refresh, reactivation, reconnect, or disconnected focus.
- Quick mode visually replaces exactly three privileged mode keys with one `×` key.
- `6 → × → 10 JD product` creates qty `0.600`, keeps the canonical unit price, and produces 6 JD before separate modifiers.
- Normal number-to-quantity behavior remains unchanged.
- Price override permissions and product price locks remain unchanged in classic mode and are irrelevant to quick quantity calculation.
- No failed/cancelled/interrupted flow can leave an invisible armed amount that affects a later product.
- Focused tests and architecture check pass; no full-suite claim is made.
