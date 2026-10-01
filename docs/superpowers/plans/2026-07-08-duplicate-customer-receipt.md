# Duplicate Customer Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only setting that, when enabled, automatically prints a second copy of the customer receipt right after a successful register checkout — spooler print method only.

**Architecture:** New key-value setting `duplicate_customer_receipt` ('0'/'1') stored in the existing generic `settings` table (no migration needed — same EAV pattern as `tax_inclusive_pricing`). Loaded into the POS terminal's existing module-scope settings singleton (`useTerminal.js`) via the existing `loadSettings()` fetch, which already re-runs live on every `settings_changed` socket broadcast — so admin toggles propagate to open POS tabs without a page reload, same as every sibling flag. At checkout success, if the flag is on and `printMethod === 'backend'`, the store fires one extra `dispatchToNodeSpooler('receipt', ...)` call. This is safe by construction: the print-queue's idempotency key for `print_type: 'receipt'` embeds a fresh `crypto.randomUUID()` per HTTP request when the client sends no explicit `print_request_id` (`backend/services/printJobIdentity.js:32,46`), so two independent calls always enqueue two distinct jobs — no spooler/queue code changes required.

**Tech Stack:** Express (backend/routes/system.js), Vue 3 Composition API + Pinia (assets/js/composables), Vitest (backend/tests/unit + integration), MySQL settings table.

## Global Constraints

- Setting values persisted as the string `'0'` or `'1'` (matches every existing boolean setting — `tax_inclusive_pricing`, `use_invoice_no_only`, etc.). Never store booleans.
- Write access to `POST /api/system/settings` stays behind `requireAuth` + `requireAdmin` (already true for the whole route — do not weaken it).
- Feature is spooler-only (`print_method === 'backend'`). Never wire it into the `window.print()` / browser path.
- Scope is checkout auto-print only. Do not touch Orders.vue reprint, OrderNotes, or TableSplits reprint flows.
- Arabic translations are mandatory for any new user-facing string (project has an `en`-keyed dict with `ar` overrides in `assets/js/admin/i18n.js`; a missing entry silently falls back to raw English for Arabic users).
- Run `npx vitest run` (NOT `npx jest` — this repo's jest binary gives false race/pool failures) after every task.

---

### Task 1: Backend setting — `duplicate_customer_receipt`

**Files:**
- Modify: `backend/routes/system.js:44-65` (GET default), `backend/routes/system.js:73-86` (POST allowed_keys + validation)
- Test: `backend/tests/integration/duplicateReceiptSetting.test.js` (create)

**Interfaces:**
- Consumes: nothing new — reuses `getSettings(pool)`, `sendSuccess`, `sendError`, `requireAuth`, `requireAdmin` already imported in `system.js`.
- Produces: `GET /api/system/settings` response gains `duplicate_customer_receipt: '0' | '1'`. `POST /api/system/settings` accepts `duplicate_customer_receipt` in its body and persists it, coerced to exactly `'0'` or `'1'`.

- [ ] **Step 1: Write the failing integration test**

Create `backend/tests/integration/duplicateReceiptSetting.test.js`:

```javascript
// backend/tests/integration/duplicateReceiptSetting.test.js
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('duplicate_customer_receipt setting', () => {
    let adminCookie;
    let cashierCookie;

    beforeAll(async () => {
        await seedDatabase();

        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];

        const cashierRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = cashierRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.query("DELETE FROM settings WHERE setting_key = 'duplicate_customer_receipt'");
        await pool.end();
    });

    it('defaults to "0" when never set', async () => {
        const res = await request(app)
            .get('/api/system/settings')
            .set('Cookie', adminCookie);

        expect(res.statusCode).toBe(200);
        expect(res.body.duplicate_customer_receipt).toBe('0');
    });

    it('rejects writes from non-admin accounts', async () => {
        const res = await request(app)
            .post('/api/system/settings')
            .set('Cookie', cashierCookie)
            .send({ duplicate_customer_receipt: '1' });

        expect(res.statusCode).toBe(403);
    });

    it('persists "1" when an admin enables it', async () => {
        const postRes = await request(app)
            .post('/api/system/settings')
            .set('Cookie', adminCookie)
            .send({ duplicate_customer_receipt: '1' });

        expect(postRes.statusCode).toBe(200);
        expect(postRes.body.success).toBe(true);

        const getRes = await request(app)
            .get('/api/system/settings')
            .set('Cookie', adminCookie);

        expect(getRes.body.duplicate_customer_receipt).toBe('1');
    });

    it('coerces any non-"0"/"1" value to "0" instead of persisting garbage', async () => {
        const postRes = await request(app)
            .post('/api/system/settings')
            .set('Cookie', adminCookie)
            .send({ duplicate_customer_receipt: 'DROP TABLE settings;' });

        expect(postRes.statusCode).toBe(200);
        expect(postRes.body.success).toBe(true);

        const [rows] = await pool.query(
            "SELECT setting_value FROM settings WHERE setting_key = 'duplicate_customer_receipt'"
        );
        expect(rows[0].setting_value).toBe('0');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/tests/integration/duplicateReceiptSetting.test.js`
Expected: FAIL — `duplicate_customer_receipt` is `undefined`, not `'0'`, on the GET assertion (the key doesn't exist yet).

- [ ] **Step 3: Add the GET default**

In `backend/routes/system.js`, inside the `sendSuccess(res, { ... })` call at the end of `GET /settings` (currently ends `store_icon: settingsData['store_icon'] ?? null`), add one line:

```javascript
            store_icon: settingsData['store_icon'] ?? null,
            duplicate_customer_receipt: settingsData['duplicate_customer_receipt'] ?? '0'
        });
```

- [ ] **Step 4: Add the POST allowed key + strict validation**

In `backend/routes/system.js`, the `POST /settings` handler currently starts:

```javascript
        const data = req.body;
        if (!data) return sendError(res, 400, "Invalid payload received.");
        if (data.admin_language !== undefined && !['en', 'ar'].includes(data.admin_language)) {
            data.admin_language = 'en';
        }

        const allowed_keys = [
            'barcode_enabled', 'print_method', 'store_name', 'store_address', 
            'store_phone', 'tables_enabled', 'stock_enabled', 'table_mode', 
            'tax_inclusive_pricing', 'receipt_config', 'shared_order_sequence', 'use_invoice_no_only', 'spooler_address',
            'admin_language', 'low_stock_threshold', 'service_charge_enabled', 'service_charge_percentage', 'service_charge_tax_rate'
        ];
```

Change it to (new validation block mirrors the existing `admin_language` guard; new key appended to the list):

```javascript
        const data = req.body;
        if (!data) return sendError(res, 400, "Invalid payload received.");
        if (data.admin_language !== undefined && !['en', 'ar'].includes(data.admin_language)) {
            data.admin_language = 'en';
        }
        if (data.duplicate_customer_receipt !== undefined && !['0', '1'].includes(data.duplicate_customer_receipt)) {
            data.duplicate_customer_receipt = '0';
        }

        const allowed_keys = [
            'barcode_enabled', 'print_method', 'store_name', 'store_address', 
            'store_phone', 'tables_enabled', 'stock_enabled', 'table_mode', 
            'tax_inclusive_pricing', 'receipt_config', 'shared_order_sequence', 'use_invoice_no_only', 'spooler_address',
            'admin_language', 'low_stock_threshold', 'service_charge_enabled', 'service_charge_percentage', 'service_charge_tax_rate',
            'duplicate_customer_receipt'
        ];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run backend/tests/integration/duplicateReceiptSetting.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/routes/system.js backend/tests/integration/duplicateReceiptSetting.test.js
git commit -m "feat(settings): add duplicate_customer_receipt setting"
```

---

### Task 2: POS terminal — load the setting

**Files:**
- Modify: `assets/js/composables/useTerminal.js`

**Interfaces:**
- Consumes: `GET /api/system/settings` response field `duplicate_customer_receipt` (Task 1).
- Produces: new exported ref `duplicateCustomerReceipt` (boolean) on the object returned by `useTerminal()`, alongside the existing `printMethod`. Task 3 depends on this exact name.

No dedicated unit test in this task — `loadSettings()` has no existing direct test coverage for any of its sibling fields (`taxInclusivePricing`, `useInvoiceNoOnly`, `barcodeEnabled` are all untested at this layer too); Task 3 tests the consumption side against a mock, and Task 5 verifies the real parsing end-to-end via the running app. Adding a bespoke test harness solely for this one field, when no sibling field has one, would be inconsistent scope creep.

- [ ] **Step 1: Add the ref**

In `assets/js/composables/useTerminal.js`, near the other module-scope settings refs:

```javascript
const printMethod = ref("browser");
const isPrintingBackend = ref(false);
const taxInclusivePricing = ref(false);
const useInvoiceNoOnly = ref(false);
const duplicateCustomerReceipt = ref(false);
```

- [ ] **Step 2: Parse it in `loadSettings()`**

Currently:

```javascript
                printMethod.value = data.print_method || "browser";
                taxInclusivePricing.value = data.tax_inclusive_pricing === "1";
                useInvoiceNoOnly.value = data.use_invoice_no_only === "1";
```

Change to:

```javascript
                printMethod.value = data.print_method || "browser";
                taxInclusivePricing.value = data.tax_inclusive_pricing === "1";
                useInvoiceNoOnly.value = data.use_invoice_no_only === "1";
                duplicateCustomerReceipt.value = data.duplicate_customer_receipt === "1";
```

- [ ] **Step 3: Export it**

Currently the `return` statement includes:

```javascript
        showTerminalSettings, receiptPrinters, localPrinterId, printMethod, isPrintingBackend, taxInclusivePricing,
```

Change to:

```javascript
        showTerminalSettings, receiptPrinters, localPrinterId, printMethod, isPrintingBackend, taxInclusivePricing, duplicateCustomerReceipt,
```

- [ ] **Step 4: Sanity-check the build**

Run: `npx vite build`
Expected: build succeeds, no import/reference errors.

- [ ] **Step 5: Commit**

```bash
git add assets/js/composables/useTerminal.js
git commit -m "feat(pos): load duplicate_customer_receipt into terminal state"
```

---

### Task 3: Checkout — fire the duplicate dispatch

**Files:**
- Modify: `assets/js/composables/stores/orderSessionStore.js:2266`
- Test: `backend/tests/unit/orderSessionStore.test.js`

**Interfaces:**
- Consumes: `deps.terminal.printMethod.value` (string), `deps.terminal.duplicateCustomerReceipt.value` (boolean, from Task 2), `deps.terminal.dispatchToNodeSpooler(type, data)` (existing fn), `deps.terminal.lastOrder.value` (existing object) — all already present on the `deps.terminal` object built from `useTerminal()`.
- Produces: nothing new consumed downstream — this is the terminal action for this feature.

- [ ] **Step 1: Extend the existing terminal mock**

In `backend/tests/unit/orderSessionStore.test.js`, the hoisted mock currently reads:

```javascript
const mockTerminalState = vi.hoisted(() => ({
  taxInclusivePricing: { value: false },
  lastOrder: { value: null },
  printReceipt: vi.fn(),
  printMethod: { value: 'frontend' },
  dispatchToNodeSpooler: vi.fn()
}));
```

Change to:

```javascript
const mockTerminalState = vi.hoisted(() => ({
  taxInclusivePricing: { value: false },
  lastOrder: { value: null },
  printReceipt: vi.fn(),
  printMethod: { value: 'frontend' },
  duplicateCustomerReceipt: { value: false },
  dispatchToNodeSpooler: vi.fn()
}));
```

- [ ] **Step 2: Write the failing tests**

In `backend/tests/unit/orderSessionStore.test.js`, inside `describe('useOrderSessionStore — B2: lastOrder uses server totals', ...)`, the `beforeEach` currently resets terminal mock state:

```javascript
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockTerminalState.lastOrder.value = null;
    mockTerminalState.printReceipt.mockClear();
    mockTerminalState.dispatchToNodeSpooler.mockClear();
    mockTerminalState.printMethod.value = 'frontend';
  });
```

Change to also reset the new field:

```javascript
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockTerminalState.lastOrder.value = null;
    mockTerminalState.printReceipt.mockClear();
    mockTerminalState.dispatchToNodeSpooler.mockClear();
    mockTerminalState.printMethod.value = 'frontend';
    mockTerminalState.duplicateCustomerReceipt.value = false;
  });
```

Then add a new `describe` block right after that describe block closes (after the `});` that follows the `'stores only a hashed checkout fingerprint...'` test group, i.e. after line 629 in the current file):

```javascript
describe('useOrderSessionStore — duplicate customer receipt on checkout', () => {
  const checkoutFetchMock = () => vi.fn(() => Promise.resolve({
    json: () => Promise.resolve({
      success: true,
      invoice_id: 77,
      order_id: 5,
      subtotal: 10,
      tax: 0,
      total: 10,
      discount: 0,
      payment_method: 'cash',
      amount_tendered: 10,
      change_due: 0
    })
  }));

  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    mockTerminalState.lastOrder.value = null;
    mockTerminalState.printReceipt.mockClear();
    mockTerminalState.dispatchToNodeSpooler.mockClear();
  });

  it('fires one extra dispatchToNodeSpooler("receipt", ...) when backend + flag are on', async () => {
    mockTerminalState.printMethod.value = 'backend';
    mockTerminalState.duplicateCustomerReceipt.value = true;
    global.fetch = checkoutFetchMock();
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });

    const receiptCalls = mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(c => c[0] === 'receipt');
    expect(receiptCalls.length).toBe(1);
    expect(receiptCalls[0][1]).toBe(mockTerminalState.lastOrder.value);
    expect(mockTerminalState.printReceipt).toHaveBeenCalledTimes(1);
  });

  it('does not fire the extra dispatch when the flag is off', async () => {
    mockTerminalState.printMethod.value = 'backend';
    mockTerminalState.duplicateCustomerReceipt.value = false;
    global.fetch = checkoutFetchMock();
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });

    const receiptCalls = mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(c => c[0] === 'receipt');
    expect(receiptCalls.length).toBe(0);
  });

  it('does not fire the extra dispatch on browser print method, even if the flag is on', async () => {
    mockTerminalState.printMethod.value = 'frontend';
    mockTerminalState.duplicateCustomerReceipt.value = true;
    global.fetch = checkoutFetchMock();
    const store = useOrderSessionStore();
    store.cart = [{ id: 1, price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];

    await store.processCheckout({ payment_method: 'cash', amount_tendered: 10, change_due: 0 });

    const receiptCalls = mockTerminalState.dispatchToNodeSpooler.mock.calls.filter(c => c[0] === 'receipt');
    expect(receiptCalls.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run backend/tests/unit/orderSessionStore.test.js -t "duplicate customer receipt"`
Expected: FAIL on the first test — `receiptCalls.length` is `0`, not `1` (the store doesn't fire the extra dispatch yet).

- [ ] **Step 4: Implement the checkout wiring**

In `assets/js/composables/stores/orderSessionStore.js`, the checkout-success block currently reads:

```javascript
        deps.terminal.printReceipt();
        showPaymentSuccess(payload.change_due);
```

Change to:

```javascript
        deps.terminal.printReceipt();
        // print-queue idempotency keys embed a per-request random UUID for
        // print_type 'receipt' when the client sends none (printJobIdentity.js),
        // so this second call always queues a distinct job — never deduped.
        if (deps.terminal.printMethod.value === 'backend' && deps.terminal.duplicateCustomerReceipt?.value) {
          deps.terminal.dispatchToNodeSpooler('receipt', deps.terminal.lastOrder.value);
        }
        showPaymentSuccess(payload.change_due);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run backend/tests/unit/orderSessionStore.test.js`
Expected: PASS (all tests in the file, including the 3 new ones)

- [ ] **Step 6: Commit**

```bash
git add assets/js/composables/stores/orderSessionStore.js backend/tests/unit/orderSessionStore.test.js
git commit -m "feat(pos): duplicate customer receipt on checkout when enabled"
```

---

### Task 4: Admin Settings UI

**Files:**
- Modify: `src/admin/pages/Settings.vue`
- Modify: `assets/js/admin/i18n.js`

**Interfaces:**
- Consumes: `GET /api/system/settings` field `duplicate_customer_receipt` (Task 1), writes it via `POST /api/system/settings` (Task 1).
- Produces: nothing consumed by other tasks — this is the admin-facing leaf.

- [ ] **Step 1: Add the ref**

In `src/admin/pages/Settings.vue`, near the other general-settings refs:

```javascript
        const taxInclusivePricing = ref(false);
        const useInvoiceNoOnly = ref(false);
        const tableMode = ref('fixed');
        const printMethod = ref('browser');
```

Change to:

```javascript
        const taxInclusivePricing = ref(false);
        const useInvoiceNoOnly = ref(false);
        const tableMode = ref('fixed');
        const printMethod = ref('browser');
        const duplicateCustomerReceipt = ref(false);
```

- [ ] **Step 2: Load it**

Currently:

```javascript
                    taxInclusivePricing.value = dataSet.tax_inclusive_pricing === '1';
                    useInvoiceNoOnly.value = dataSet.use_invoice_no_only === '1';
                    tableMode.value = dataSet.table_mode || 'fixed';
                    printMethod.value = dataSet.print_method || 'browser';
```

Change to:

```javascript
                    taxInclusivePricing.value = dataSet.tax_inclusive_pricing === '1';
                    useInvoiceNoOnly.value = dataSet.use_invoice_no_only === '1';
                    tableMode.value = dataSet.table_mode || 'fixed';
                    printMethod.value = dataSet.print_method || 'browser';
                    duplicateCustomerReceipt.value = dataSet.duplicate_customer_receipt === '1';
```

- [ ] **Step 3: Save it**

Currently `saveSettings()`'s payload:

```javascript
                tax_inclusive_pricing: taxInclusivePricing.value ? '1' : '0',
                use_invoice_no_only: useInvoiceNoOnly.value ? '1' : '0',
                table_mode: tableMode.value,
                print_method: printMethod.value,
```

Change to:

```javascript
                tax_inclusive_pricing: taxInclusivePricing.value ? '1' : '0',
                use_invoice_no_only: useInvoiceNoOnly.value ? '1' : '0',
                table_mode: tableMode.value,
                print_method: printMethod.value,
                duplicate_customer_receipt: duplicateCustomerReceipt.value ? '1' : '0',
```

- [ ] **Step 4: Add the template toggle**

The "Printing" section currently reads (in the template):

```html
                        <!-- Printing -->
                        <section class="space-y-4 border-t border-zinc-200 pt-8">
                            <h3 class="font-display font-semibold text-xs text-foreground flex items-center gap-2">
                                <i class="fa-solid fa-print text-muted-foreground"></i> {{ $t('Printing') }}
                            </h3>
                            <div class="max-w-md">
                                <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Print method') }}</label>
                                <select v-model="printMethod" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none h-9">
                                    <option value="browser">{{ $t('Browser printing (Ctrl+P / AirPrint)') }}</option>
                                    <option value="backend">{{ $t('Local print server (silent)') }}</option>
                                </select>
                                <p class="text-[10px] text-muted-foreground mt-2 leading-relaxed">{{ $t('For silent printing, set up your printers in the Printers tab and run the local print service.') }}</p>
                            </div>
                        </section>
```

Change to (new toggle only rendered for the spooler method, matching the same checkbox-label styling as the other toggles in this file, e.g. `taxInclusivePricing` at line 168):

```html
                        <!-- Printing -->
                        <section class="space-y-4 border-t border-zinc-200 pt-8">
                            <h3 class="font-display font-semibold text-xs text-foreground flex items-center gap-2">
                                <i class="fa-solid fa-print text-muted-foreground"></i> {{ $t('Printing') }}
                            </h3>
                            <div class="max-w-md">
                                <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Print method') }}</label>
                                <select v-model="printMethod" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-semibold text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none h-9">
                                    <option value="browser">{{ $t('Browser printing (Ctrl+P / AirPrint)') }}</option>
                                    <option value="backend">{{ $t('Local print server (silent)') }}</option>
                                </select>
                                <p class="text-[10px] text-muted-foreground mt-2 leading-relaxed">{{ $t('For silent printing, set up your printers in the Printers tab and run the local print service.') }}</p>
                            </div>

                            <label v-if="printMethod === 'backend'" :class="['flex items-center justify-between p-4 rounded-lg border cursor-pointer transition-colors max-w-md', duplicateCustomerReceipt ? 'bg-teal-50/60 border-teal-300' : 'bg-muted/40 border-zinc-300 hover:bg-muted']">
                                <div class="flex items-center gap-3">
                                    <i class="fa-solid fa-copy text-lg text-muted-foreground"></i>
                                    <div>
                                        <span class="text-xs font-semibold block text-foreground">{{ $t('Print customer receipt twice') }}</span>
                                        <span class="text-[10px] text-muted-foreground mt-0.5 block">{{ $t('Automatically print a second copy of the customer receipt at checkout.') }}</span>
                                    </div>
                                </div>
                                <input type="checkbox" v-model="duplicateCustomerReceipt" class="accent-teal-600 w-4 h-4">
                            </label>
                        </section>
```

- [ ] **Step 5: Export it from `setup()`**

Currently:

```javascript
            barcodeEnabled, tablesEnabled, stockEnabled, taxInclusivePricing, useInvoiceNoOnly, tableMode, printMethod, storeName, storeAddress, storePhone, sharedOrderSequence, lowStockThreshold, saveSettings,
```

Change to:

```javascript
            barcodeEnabled, tablesEnabled, stockEnabled, taxInclusivePricing, useInvoiceNoOnly, tableMode, printMethod, duplicateCustomerReceipt, storeName, storeAddress, storePhone, sharedOrderSequence, lowStockThreshold, saveSettings,
```

- [ ] **Step 6: Add Arabic translations**

In `assets/js/admin/i18n.js`, near the other Printing/receipt-related entries (e.g. next to `'Tax-inclusive pricing'` at line 132), add:

```javascript
    'Print customer receipt twice': 'طباعة إيصال الزبون مرتين',
    'Automatically print a second copy of the customer receipt at checkout.': 'طباعة نسخة ثانية تلقائياً من إيصال الزبون عند الدفع.',
```

- [ ] **Step 7: Build check**

Run: `npx vite build`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/admin/pages/Settings.vue assets/js/admin/i18n.js
git commit -m "feat(admin): add duplicate customer receipt toggle to Settings"
```

---

### Task 5: Full verification sweep (security + stale-state + live end-to-end)

**Files:** none (verification only)

**Interfaces:** none — this task only runs and observes.

- [ ] **Step 1: Full automated suite**

Run: `npx vitest run`
Expected: all tests pass, including the new ones from Tasks 1 and 3.

- [ ] **Step 2: Full production build**

Run: `npx vite build`
Expected: succeeds, no warnings about unresolved imports.

- [ ] **Step 3: Re-check the security surface by hand**

Confirm, by reading the diff (`git diff master`):
- `POST /api/system/settings` still requires `requireAuth, requireAdmin` (Task 1 did not touch the route's middleware chain).
- `duplicate_customer_receipt` is coerced to exactly `'0'`/`'1'` server-side before it ever reaches the `INSERT ... ON DUPLICATE KEY UPDATE` (Task 1, Step 4) — a malicious or buggy client cannot smuggle an arbitrary string into the `settings` table through this key.
- The checkout duplicate-dispatch (Task 3) reads the copy count from server-loaded settings state only — the client has no request parameter that lets it choose how many copies print. The number of copies is always exactly 1 or 2, decided by an admin-controlled setting, never by request input.
- The new receipt job goes through the exact same `dispatchToNodeSpooler` → `POST /api/print/print` → DB-verified-order path as every other receipt print (`backend/routes/print.js` re-loads the order from `orders`/`order_items` by `invoice_id` — the client-supplied `lastOrder.value` snapshot is not trusted for money fields). No new trust boundary is introduced.

- [ ] **Step 4: Manually verify the live-refresh path (this is the actual "stale settings" check)**

This exercises the real `settings_changed` → `terminal.loadSettings()` path (`src/components/PosTerminal.vue:1262-1270`), not a mock — confirming the new flag doesn't go stale in an already-open POS tab.

1. Start the app (`npm run dev` or your usual local run).
2. Open the POS register in one browser tab, and Admin → Settings → Printing in another tab, both logged in.
3. In Admin, set Print method to "Local print server (silent)" and save.
4. Enable the new "Print customer receipt twice" toggle and save.
5. Without reloading the POS tab, configure a receipt printer (Printers tab) if none exists, then complete a cash checkout in the POS tab.
6. Confirm two receipt print jobs appear (check the Settings → Print Queue Health panel, or your spooler's job log) for that one checkout.
7. In Admin, turn the toggle back off and save — without reloading the POS tab, complete another checkout and confirm only one receipt job is queued this time.
8. Switch Print method back to "Browser printing" and save — confirm the toggle disappears from the Settings UI (the `v-if="printMethod === 'backend'"` guard) without a reload.

- [ ] **Step 5: Record the result**

If all of Step 4's checks pass, the feature is confirmed working end-to-end with no stale-settings gap. If any check fails, treat it as a bug in this plan's tasks — do not mark this task complete until Step 4 passes for real.
