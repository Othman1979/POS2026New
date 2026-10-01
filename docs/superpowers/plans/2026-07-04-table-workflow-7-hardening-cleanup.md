# Table Workflow Hardening & Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to run this task-by-task in the current session (or superpowers:executing-plans for a separate session with review checkpoints). Every task follows superpowers:test-driven-development — the failing test lands FIRST, proven red, then the minimal fix, proven green. Steps use checkbox (`- [ ]`) syntax. **Run one Task per agent dispatch; commit before the next.**
>
> **Git hygiene:** the owner keeps unrelated WIP in the tree. Do NOT `git stash`. When committing, stage ONLY the files each task names (`git add <exact file>` per listed file) — never `git add -A`.
>
> **Land order:** this plan touches files also edited by sibling plans 1/2/3/4/6 (different regions). It is designed to land **LAST**. See `## Cross-plan file overlap` at the bottom before starting.

**Goal:** Close seven confirmed table-workflow defects (2× P2 security/UX, 5× P3 correctness/lock-scope/session-race) plus two dead-code cleanups found in the deep table-workflow audit. Every behavior change ships with a red→green test; two genuinely UI-only socket/async behaviors ship with an exact MANUAL VERIFICATION repro. No money math changes semantics except the NULL-tax rollup correction (P3-14), which is itself a fix.

**Architecture:** Vue 3 (Composition API `<script setup>` in `src/components/PosTerminal.vue`) + Pinia stores (`assets/js/composables/stores/orderSessionStore.js`, `orderUiStore.js`) behind logic-free facades (`useCart.js`, `useTables.js`). Express 5 + `mysql2/promise` backend: the floor-plan read (`GET /api/pos/get_tables`) and the table-save write (`POST /api/pos/table_order`) both live in `backend/routes/pos/tables.js`; shared helpers (money asserts, permission checks, socket broadcasts) in `backend/routes/pos/helpers.js`; pure totals math in `backend/services/PosCalculator.js`. Stale-write protection uses the `tableSessionSeq` token pattern: capture `const mySeq = tableSessionSeq.value` before an await, then bail if `mySeq !== tableSessionSeq.value` after it.

**Tech Stack:** Vue 3, Vite 6, Pinia, Tailwind v4; Express 5, `mysql2/promise`; Vitest + supertest. Test runner is **Vitest** — `npx vitest run <file>`, never jest. Frontend store units run under Vitest too (fetch-mock + `setActivePinia(createPinia())`).

## Global Constraints

- Failing test FIRST, then the fix. Prove red → green with the exact commands shown.
- Money via `roundMoney` / `assertNearMoney`; never hand-roll float compares (`Math.abs(...) > 0.001` is only for tax-rate equality, mirroring checkout.js).
- `sendError()` sanitizes any message containing both `table` and `exist` (and `ER_`/`SQLSTATE`/`mysql`) into a generic error — do not rely on such phrasing surviving to the client. Prefer setting `err.statusCode` explicitly over leaning on the message→status mapper.
- Preserve every existing test. After each backend task: `npx vitest run backend/tests/integration/tables.test.js` (+ the task's own file). After each frontend task: `npm run build`.
- `tableSessionSeq` is exported from the session store (used by `useTables.js` facade). Do not expose new internal refs beyond what a task names.
- Stage only the files each task lists.

---

## Task 1 — P2-7: validate the Auto-Gratuity service-charge amount/tax on table save

**Finding P2-7** — `backend/routes/pos/tables.js` gates the Auto-Gratuity line on permission only (`~L1113`) and never recomputes `fee = subtotal × pct` nor validates `tax_rate`, and never checks `service_charge_enabled`. `applyDatabasePrices` skips `product_id`-null lines (`~L1139`), so the client-supplied fee/tax survive; the only anchor is `assertNearMoney('Subtotal')` (`~L1147`), which passes because the client subtotal already includes the injected fee. `checkout.js` validates exactly this (`~L296-306`) — `tables.js` has no equivalent. A forged fee persists into `orders` + the guest check, then checkout re-validates and throws → the table wedges. **Defect: missing server-side recompute/validation of the injected service-charge line.**

**Files:** `backend/routes/pos/tables.js` (imports `~L23-25`; settings load `~L967`; new validation after `applyDatabasePrices` `~L1139`). Test: `backend/tests/integration/tables.test.js`.

**Interfaces:** reuse `calculateLineTotal`, `roundMoney`, `assertNearMoney` from `./helpers` (checkout.js already imports all three; tables.js currently imports only `assertNearMoney`). Settings keys: `service_charge_enabled`, `service_charge_percentage`, `service_charge_tax_rate` (seeded in `backend/tests/fixtures/seed.js` at `'0' / '10' / '0'`).

- [ ] **Step 1 — full failing test.** Append to `backend/tests/integration/tables.test.js`, INSIDE the top-level `describe('Table Bill Split Integration Tests', ...)` (so it inherits `adminCookie` / `SEED` / `createTableOrder`), just before the file's final closing `});`:
```javascript
    describe('Auto-Gratuity service-charge validation (P2-7)', () => {
        beforeEach(async () => {
            await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'service_charge_enabled'");
        });

        it('rejects a table order whose Auto-Gratuity fee is not subtotal × percentage', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [
                        { id: SEED.product1.id, name: SEED.product1.name, price: 5.00, qty: 1, tax_rate: 16 },
                        { name: 'Auto-Gratuity', note: 'Auto-Gratuity', price: 5.00, qty: 1, tax_rate: 0 } // forged: should be 0.50
                    ],
                    subtotal: 10.00, tax: 0.80, total: 10.80
                });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/service charge/i);
        });

        it('accepts a table order whose Auto-Gratuity fee equals subtotal × percentage', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [
                        { id: SEED.product1.id, name: SEED.product1.name, price: 5.00, qty: 1, tax_rate: 16 },
                        { name: 'Auto-Gratuity', note: 'Auto-Gratuity', price: 0.50, qty: 1, tax_rate: 0 } // 10% of 5.00
                    ],
                    subtotal: 5.50, tax: 0.80, total: 6.30
                });
            expect(res.statusCode).toBe(200);
        });
    });
```

- [ ] **Step 2 — run → FAIL.** `npx vitest run backend/tests/integration/tables.test.js`. The **reject** case FAILS: today the forged fee survives (no validation), so `assertNearMoney('Subtotal', 10, 10)` passes and the save returns 200, not 400.

- [ ] **Step 3 — minimal fix.**
  Edit A — add the two helper imports. In the `require('./helpers')` destructure (`~L23-25`):
  ```javascript
  // BEFORE
      calculateExpectedTotals,
      calculateLineTax,
      assertNearMoney,
  // AFTER
      calculateExpectedTotals,
      calculateLineTax,
      calculateLineTotal,
      roundMoney,
      assertNearMoney,
  ```
  Edit B — load the service-charge settings. At `~L967`:
  ```javascript
  // BEFORE
          const checkoutSettings = await getSettings(conn, ['stock_enabled', 'tax_inclusive_pricing']);
          const stockEnabled = checkoutSettings.stock_enabled === '1';
          const taxInclusivePricing = checkoutSettings.tax_inclusive_pricing === '1';
  // AFTER
          const checkoutSettings = await getSettings(conn, ['stock_enabled', 'tax_inclusive_pricing', 'service_charge_enabled', 'service_charge_percentage', 'service_charge_tax_rate']);
          const stockEnabled = checkoutSettings.stock_enabled === '1';
          const taxInclusivePricing = checkoutSettings.tax_inclusive_pricing === '1';
          const serviceChargeEnabledSetting = checkoutSettings.service_charge_enabled === '1';
          const serviceChargePct = parseFloat(checkoutSettings.service_charge_percentage || '10');
          const serviceChargeTax = parseFloat(checkoutSettings.service_charge_tax_rate || '0');
  ```
  Edit C — recompute & validate the fee AFTER `applyDatabasePrices` (so the base uses DB-authoritative line prices) and before `calculateExpectedTotals`. The existing permission gate at `~L1113` stays untouched (it already enforces `canApplyServiceCharge`); this block adds the enabled + amount + tax checks. At `~L1139`:
  ```javascript
  // BEFORE
          // Apply database product prices to prevent price manipulation tampering
          applyDatabasePrices(cartItems, productMap, req.user, false, savedPriceMap);

          // 3. Compute expected totals for the new cart items
  // AFTER
          // Apply database product prices to prevent price manipulation tampering
          applyDatabasePrices(cartItems, productMap, req.user, false, savedPriceMap);

          // Auto-Gratuity service-charge validation — mirrors checkout.js (~L296-306).
          // applyDatabasePrices skips product_id-null lines, so a forged service-charge
          // fee/tax would otherwise survive (the Subtotal anchor already includes the fee).
          // Recompute the fee over the non-service lines against DB settings and reject a
          // tampered line, a bad tax rate, or a service charge added while the feature is off.
          const serviceChargeLine = cartItems.find(item => item.note === 'Auto-Gratuity');
          if (serviceChargeLine) {
              if (!serviceChargeEnabledSetting) {
                  const err = new Error("Service charge is disabled in system settings.");
                  err.statusCode = 400;
                  throw err;
              }
              const subtotalWithoutFees = cartItems
                  .filter(item => item.note !== 'Auto-Gratuity')
                  .reduce((sum, item) => sum + calculateLineTotal(item), 0);
              const expectedFee = roundMoney(subtotalWithoutFees * (serviceChargePct / 100));
              assertNearMoney('Service charge', serviceChargeLine.price, expectedFee);
              if (Math.abs(parseFloat(serviceChargeLine.tax_rate) - serviceChargeTax) > 0.001) {
                  const err = new Error("Invalid tax rate on service charge line.");
                  err.statusCode = 400;
                  throw err;
              }
          }

          // 3. Compute expected totals for the new cart items
  ```
  (The forged-fee case throws `Service charge mismatch. Please refresh totals and try again.` from `assertNearMoney`; `mismatch` maps to 400 via the existing error mapper. The disabled/tax cases carry an explicit `err.statusCode = 400`.)

- [ ] **Step 4 — run → PASS.** `npx vitest run backend/tests/integration/tables.test.js` — both new cases green; all pre-existing table tests green.

- [ ] **Step 5 — file gate.** `npx vitest run backend/tests/integration/tables.test.js`

- [ ] **Step 6 — commit.** `git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js` then `git commit -m "fix(tables): validate Auto-Gratuity fee/tax on table save (P2-7)"`

---

## Task 2 — P2-8: `isProcessing` wedged true after every successful table save

**Finding P2-8** — `assets/js/composables/stores/orderSessionStore.js` `updateActiveTableOrder` captures `mySeq = tableSessionSeq.value` (`~L818`), sets `ui.isProcessing = true`, and on success awaits `loadActiveTableOrder` (`~L846`), which calls `invalidateTableSession` (`~L622`) → `tableSessionSeq.value++`. The `finally` (`~L864`) only clears `isProcessing` when `mySeq === tableSessionSeq.value` — always false after the self-inflicted bump — so `isProcessing` never resets. It locks the Update/Pay buttons after every save and guest-check print; `processRefund` early-returns while `isProcessing` (`~L1508`), so subsequent voids/refunds are silently blocked. **Defect: the finally's stale-session guard cannot distinguish a self-triggered token bump from a genuine newer session, so the success path never clears the lock.**

**Files:** `assets/js/composables/stores/orderSessionStore.js` (`updateActiveTableOrder`, success branch `~L844-846`). Test: `backend/tests/unit/orderSessionStore.test.js`.

**Interfaces:** `updateActiveTableOrder(options = {})`; `ui.isProcessing` lives on `useOrderUiStore`. `options.keepProcessingOnSuccess` (guest-check print) intentionally holds the lock through its own flow.

- [ ] **Step 1 — full failing test.** Append to `backend/tests/unit/orderSessionStore.test.js` (mirror the existing `'useOrderSessionStore - table save metadata resync'` mock shape — same four fetch branches):
```javascript
describe('useOrderSessionStore — updateActiveTableOrder clears isProcessing on success (P2-8)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('resets ui.isProcessing to false after a successful save', async () => {
    mockPermissionsState.can.mockReturnValue(true);
    global.window.setTimeout = vi.fn((fn) => fn());
    global.fetch = vi.fn((url, options = {}) => {
      const u = String(url);
      if (u === 'api/pos/table_order' && options.method === 'POST') {
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true, order_id: 99, invoice_id: 99, table_id: 7, table_number: '3',
            invoice_display_no: null, order_display_no: null, ticket_display_no: null, table_display_no: '3'
          })
        });
      }
      if (u.includes('table-draft')) {
        return Promise.resolve({ json: () => Promise.resolve({ success: false }) });
      }
      if (u.includes('api/pos/table_order?order_id=99')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            cart: [{ id: 10, name: 'Saved burger', price: 5, qty: 2, originalQty: 2, tax_rate: 8, discountValue: 0, order_item_id: 501 }],
            invoice_id: 99, order_id: null, table_display_no: '3', order_discount_type: null, order_discount_value: 0
          })
        });
      }
      if (u.includes('api/pos/get_tables')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true,
            settings: { tables_enabled: true, table_mode: 'fixed' },
            sections: [],
            tables: [{ id: 7, table_number: '3', status: 'occupied', current_order_id: 99 }]
          })
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${u}`));
    });

    const store = useOrderSessionStore();
    const ui = useOrderUiStore();
    store.activeTable = { id: 7, table_number: '3', status: 'available', current_order_id: null };
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 2, tax_rate: 8 }];

    const saved = await store.updateActiveTableOrder();

    expect(saved).toBe(true);
    expect(ui.isProcessing).toBe(false); // was stuck true — the reload self-bumped tableSessionSeq
  });
});
```

- [ ] **Step 2 — run → FAIL.** `npx vitest run backend/tests/unit/orderSessionStore.test.js`. FAILS: `ui.isProcessing` is `true` after the await because `loadActiveTableOrder` bumped `tableSessionSeq`, so the `finally` guard skipped the reset.

- [ ] **Step 3 — minimal fix.** Clear the lock on the success path BEFORE the self-bumping reload; leave the `finally` unchanged (it now correctly no-ops on success — seq already bumped — and still clears on the error/early-return paths). In `updateActiveTableOrder`, at `~L844`:
```javascript
// BEFORE
      persistActiveTable();
      try {
        await loadActiveTableOrder(activeTable.value);
// AFTER
      persistActiveTable();
      // Save is committed for THIS session. Clear the processing lock NOW — before the
      // best-effort reload below calls loadActiveTableOrder → invalidateTableSession(),
      // which bumps tableSessionSeq so the `finally` guard (mySeq === tableSessionSeq.value)
      // can never fire on success and would otherwise wedge ui.isProcessing = true forever.
      // keepProcessingOnSuccess (guest-check print) intentionally holds the lock.
      if (!options.keepProcessingOnSuccess) ui.isProcessing = false;
      try {
        await loadActiveTableOrder(activeTable.value);
```

- [ ] **Step 4 — run → PASS.** `npx vitest run backend/tests/unit/orderSessionStore.test.js` — new case green; the existing `'table save metadata resync'` case still green (its `saved === true` assertions are unaffected).

- [ ] **Step 5 — file gate + build.** `npx vitest run backend/tests/unit/orderSessionStore.test.js` then `npm run build`.

- [ ] **Step 6 — commit.** `git add assets/js/composables/stores/orderSessionStore.js backend/tests/unit/orderSessionStore.test.js` then `git commit -m "fix(pos): clear isProcessing after successful table save (P2-8)"`

---

## Task 3 — P2-9: waiter with blank `allowed_sections` must fail closed

**Finding P2-9** — `backend/routes/pos/tables.js` `get_tables` `isAllSections` (`~L136`) is true for admin/programmer OR any blank `allowed_sections`. A non-admin **waiter** with `allowed_sections = ''` (the NULL default) hits the all-sections branch and sees every table, while a non-blank-but-invalid value like `'0'` reaches the zero-tables branch (`~L168-181`). Inconsistent fail-open vs fail-closed; the admin UI renders blank as a red "No sections" badge. **Defect: blank sections grant the entire floor to waiters.**

**Files:** `backend/routes/pos/tables.js` (`isAllSections` `~L136`). Test: `backend/tests/integration/tables.test.js`.

**Interfaces:** `get_tables` returns `{ settings, sections, tables, permissions }`; the empty-sections shape is `sections: [], tables: []` (`~L168-181`).

- [ ] **Step 1 — full failing test.** Append inside the top-level table describe:
```javascript
    describe('Waiter section access — blank fails closed (P2-9)', () => {
        it('a waiter with blank allowed_sections sees no tables (fail closed)', async () => {
            await pool.query("UPDATE users SET allowed_sections = '' WHERE id = ?", [SEED.waiterUser.id]);
            // get_tables re-queries allowed_sections fresh, so the existing waiterCookie suffices.
            const res = await request(app).get('/api/pos/get_tables').set('Cookie', waiterCookie);
            expect(res.statusCode).toBe(200);
            expect(res.body.tables).toEqual([]);
            expect(res.body.sections).toEqual([]);
        });

        it('an admin with blank allowed_sections still sees all tables', async () => {
            const res = await request(app).get('/api/pos/get_tables').set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            expect(res.body.tables.length).toBeGreaterThan(0);
        });
    });
```

- [ ] **Step 2 — run → FAIL.** `npx vitest run backend/tests/integration/tables.test.js`. The waiter case FAILS: today blank → `isAllSections` true → all 2 seeded tables return, so `tables` is not `[]`.

- [ ] **Step 3 — minimal fix.** At `~L136`:
```javascript
// BEFORE
        const isAllSections = user.role === 'admin' || user.role === 'programmer' || !user.allowed_sections || String(user.allowed_sections).trim() === '';
// AFTER
        // Blank allowed_sections is fail-CLOSED for waiters — a NULL default must not grant the
        // entire floor. Only admin/programmer see all sections. Non-waiter, non-admin roles keep
        // the historical fail-open on blank. A waiter with blank/'0' sections falls through to the
        // scoped branch → sectionIds empty → the documented no-access shape (~L168-181).
        const isBlankSections = !user.allowed_sections || String(user.allowed_sections).trim() === '';
        const isAllSections = user.role === 'admin' || user.role === 'programmer' || (isBlankSections && user.role !== 'waiter');
```

- [ ] **Step 4 — run → PASS.** `npx vitest run backend/tests/integration/tables.test.js` — both cases green; the transfer/PIN waiter tests (which don't depend on `get_tables` section shape) stay green.

- [ ] **Step 5 — file gate.** `npx vitest run backend/tests/integration/tables.test.js`

- [ ] **Step 6 — commit.** `git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js` then `git commit -m "fix(tables): waiter blank allowed_sections fails closed (P2-9)"`

---

## Task 4 — P3-17: floor-plan waiter badge shows the owning waiter, not the last editor

**Finding P3-17** — `get_tables` derives `active_order_waiter_name` from `LEFT JOIN users u ON o.user_id = u.id` (`~L155` all-sections and `~L200` scoped), but `orders.user_id` is overwritten to `req.user.id` on **every** save (`~L1268`) while `waiter_id` (set once at INSERT `~L1326`) is never updated. Ownership is enforced on `waiter_id` everywhere, so after a cross-user (override) edit the badge diverges from the enforced owner. The two socket-broadcast queries in `helpers.js` (`~L137`, `~L169`) mirror the same join. **Defect: badge sourced from last-editor `user_id` instead of owner `waiter_id`.**

**Files:** `backend/routes/pos/tables.js` (`~L155`, `~L200`), `backend/routes/pos/helpers.js` (`~L137`, `~L169`). Test: `backend/tests/integration/tables.test.js`.

**Interfaces:** four identical join clauses `LEFT JOIN users u ON o.user_id = u.id`.

- [ ] **Step 1 — full failing test.** Append inside the top-level table describe:
```javascript
    describe('Floor-plan waiter badge shows owner not last editor (P3-17)', () => {
        async function grantWaiter(keys) {
            await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [SEED.waiterUser.id]);
            if (keys.length) {
                await pool.query("INSERT INTO user_permissions (user_id, perm_key) VALUES ?", [keys.map(k => [SEED.waiterUser.id, k])]);
            }
            invalidateUserSessions(SEED.waiterUser.id);
            const relog = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
            return relog.headers['set-cookie'][0];
        }

        it('active_order_waiter_name reflects the owning waiter after a cross-user override save', async () => {
            const cookie = await grantWaiter(['tables.access', 'waiter.edit_locked']);
            const invoiceId = await createTableOrder(
                cookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            // Admin (override) re-saves the SAME items — no reduction, so no void gate trips.
            const editRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId,
                    cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                    subtotal: 10.00, tax: 1.60, total: 11.60
                });
            expect(editRes.statusCode).toBe(200);

            // user_id is now the admin (last editor); waiter_id stays the owner.
            const [[o]] = await pool.query("SELECT user_id, waiter_id FROM orders WHERE invoice_id = ?", [invoiceId]);
            expect(o.user_id).toBe(SEED.adminUser.id);
            expect(o.waiter_id).toBe(SEED.waiterUser.id);

            const list = await request(app).get('/api/pos/get_tables').set('Cookie', adminCookie);
            const table = list.body.tables.find(t => Number(t.id) === Number(SEED.table.id));
            expect(table.active_order_waiter_name).toBe(SEED.waiterUser.name); // owner, not editor
        });
    });
```

- [ ] **Step 2 — run → FAIL.** `npx vitest run backend/tests/integration/tables.test.js`. FAILS: badge reads `'Test Admin'` (last editor) not `'Test Waiter'` (owner).

- [ ] **Step 3 — minimal fix.** Change the join from `o.user_id` to `o.waiter_id` in ALL FOUR occurrences (tables.js `get_tables` all-sections `~L155` + scoped `~L200`; helpers.js `broadcastTableUpdate` `~L137` + `broadcastTableUpdates` `~L169`). The clause text is identical everywhere:
```sql
-- BEFORE
                LEFT JOIN users u ON o.user_id = u.id
-- AFTER
                LEFT JOIN users u ON o.waiter_id = u.id
```
  (The two helpers.js changes have no direct test — they mirror the read for socket payloads; changed for consistency so the live floor-plan push and the poll agree.)

- [ ] **Step 4 — run → PASS.** `npx vitest run backend/tests/integration/tables.test.js` — new case green; all existing table tests green (the transfer test asserts only the `'staff'` room, not the waiter name).

- [ ] **Step 5 — file gate.** `npx vitest run backend/tests/integration/tables.test.js`

- [ ] **Step 6 — commit.** `git add backend/routes/pos/tables.js backend/routes/pos/helpers.js backend/tests/integration/tables.test.js` then `git commit -m "fix(tables): waiter badge shows owner (waiter_id) not last editor (P3-17)"`

---

## Task 5 — P3-14: tax rollup must not trust client `item.tax_rate` for NULL-tax products

**Finding P3-14** — `backend/services/PosCalculator.js` (`~L91`): `toFiniteNumber(product?.tax_rate ?? item.tax_rate, 0)`. For a real product whose DB `tax_rate` is NULL, `product?.tax_rate` is `null`, so `?? item.tax_rate` falls through to the **client** rate — while every per-line tax stamp uses `product.tax_rate || 0` (checkout.js `~L579`, tables.js `~L1366`). `orders.tax` then diverges from `SUM(order_items.tax_amount)`; a client sending a positive rate makes the customer overpay. **Defect: nullish-coalescing trusts the client rate when the product's DB rate is NULL.**

**Files:** `backend/services/PosCalculator.js` (`calculateExpectedTotals`, exclusive-tax reduce `~L89-91`). Test: `backend/tests/unit/PosCalculator.test.js`.

**Interfaces:** `calculateExpectedTotals(data, cartItems, productMap, taxInclusivePricing)` → `{ subtotal, tax, total, discount, orderDiscount, discountRatio }`.

- [ ] **Step 1 — full failing test.** Add inside `describe('calculateExpectedTotals (exclusive tax)', ...)` in `backend/tests/unit/PosCalculator.test.js`:
```javascript
    it('treats a product with NULL db tax_rate as 0 and ignores client item.tax_rate (P3-14)', () => {
        const nullTaxMap = new Map([[1, { id: 1, tax_rate: null }]]);
        const items = [{ product_id: 1, price: 10, qty: 1, discountType: null, discountValue: 0, tax_rate: 16 }];
        const totals = calculateExpectedTotals({ order_discount_type: null, order_discount_value: 0 }, items, nullTaxMap, false);
        expect(totals.tax).toBe(0);      // NULL db rate → 0, NOT the client's 16%
        expect(totals.total).toBe(10.00);
    });
```

- [ ] **Step 2 — run → FAIL.** `npx vitest run backend/tests/unit/PosCalculator.test.js`. FAILS: `null ?? 16` → 16 → `tax = 10 * 1 * 0.16 = 1.60` (expected 0).

- [ ] **Step 3 — minimal fix.** At `~L89-91`:
```javascript
// BEFORE
    const tax = cartItems.reduce((sum, item) => {
        const product = item.product_id ? productMap.get(item.product_id) : null;
        const taxRate = toFiniteNumber(product?.tax_rate ?? item.tax_rate, 0);
// AFTER
    const tax = cartItems.reduce((sum, item) => {
        const product = item.product_id ? productMap.get(item.product_id) : null;
        // A real catalog line uses the DB tax_rate (NULL → 0, mirroring the per-line stamp
        // `product.tax_rate || 0`); only genuine custom lines fall back to the client rate.
        // `?? item.tax_rate` wrongly trusted the client when product.tax_rate was NULL.
        const taxRate = toFiniteNumber(product ? (Number(product.tax_rate) || 0) : item.tax_rate, 0);
```
  (Safe for existing cases: `product.tax_rate = 16` → `Number(16)||0 = 16`; `0` → `0`; product-absent custom line → `item.tax_rate`. The `product_id:null, tax_rate:150` "throws on invalid tax rate" case still throws.)

- [ ] **Step 4 — run → PASS.** `npx vitest run backend/tests/unit/PosCalculator.test.js` — new case green; all pre-existing PosCalculator cases (incl. `'uses productMap tax_rate over item.tax_rate'` and the financial-simulation table) green.

- [ ] **Step 5 — file gate.** `npx vitest run backend/tests/unit/PosCalculator.test.js`

- [ ] **Step 6 — commit.** `git add backend/services/PosCalculator.js backend/tests/unit/PosCalculator.test.js` then `git commit -m "fix(calc): NULL product tax_rate rolls up as 0, not client rate (P3-14)"`

---

## Task 6 — P3-5: socket `table_update` must treat a changed `current_order_id` as a session boundary

**Finding P3-5** — `src/components/PosTerminal.vue` `onTableUpdate` (`~L1285-1301`): it tears down only when the payload is `available` with no `current_order_id` (`~L1295`); otherwise it blindly merges the fresh floor row (including a **new** `current_order_id`) into the live `activeTable` with no cart reload and no `tableSessionSeq` guard. Reachable via a transfer/swap reassignment → the next save overwrites the new order's items (the backend conflict guard passes once the ids match). **Defect: blind field-merge across an order-identity change.** This is a Socket.IO handler in component setup — not unit-testable without mounting + a mock socket (this repo has no `@vue/test-utils`/jsdom harness). **Because this bug can silently OVERWRITE a live table's cart contents (data loss), this task carries a MANDATORY manual-verification gate (Step 3): the task is NOT complete until the repro is executed and its outcome recorded in the commit message / PR.** If a Vue component test harness is added later, convert Step 3 to an automated mount test. The session-teardown primitive it calls (`closeTable` → `session.closeTable`) is already covered by store unit tests (`closeTable clears activeTable + order slice`).

**Files:** `src/components/PosTerminal.vue` (`onTableUpdate` `~L1295`).

- [ ] **Step 1 — apply the guard.** At `~L1295`:
```javascript
// BEFORE
      if (payload.table.status === 'available' && !payload.table.current_order_id) {
        closeTable({ router });
      } else {
        activeTable.value = { ...activeTable.value, ...payload.table };
      }
// AFTER
      if (payload.table.status === 'available' && !payload.table.current_order_id) {
        closeTable({ router });
      } else if (
        payload.table.current_order_id &&
        activeTable.value.current_order_id &&
        String(payload.table.current_order_id) !== String(activeTable.value.current_order_id)
      ) {
        // The table I'm editing was reassigned to a DIFFERENT order elsewhere (transfer/swap).
        // Blindly merging the new current_order_id would let my next save overwrite that new
        // order's items (the backend conflict guard passes once the ids match). Treat it as a
        // session boundary: leave the table and land on the floor plan instead of merging.
        closeTable({ router });
      } else {
        activeTable.value = { ...activeTable.value, ...payload.table };
      }
```

- [ ] **Step 2 — build gate.** `npm run build` — must compile clean (SFC change, no syntax break).

- [ ] **Step 3 — MANDATORY MANUAL VERIFICATION (release gate — do NOT mark this task done, and do NOT merge, until this repro is performed and its outcome recorded in the commit/PR).**
  1. Terminal A: open the POS register on table T1 (has an active order O1), add an item but do NOT save yet.
  2. Terminal B (or an admin): transfer/swap so T1 is reassigned to a different order O2 (T1 now carries `current_order_id = O2`). This emits `table_update` with `action: 'update_single_table'` for T1.
  3. On Terminal A observe: instead of silently swapping T1's `current_order_id` to O2 under the open cart, the session closes and A lands on the floor plan.
  4. Confirm the negative: re-open T1 and Save — the items belong to O2's real contents; A's stale cart did NOT overwrite O2. (Pre-fix: A's save overwrote O2's items because the merged `current_order_id` matched the backend conflict guard.)

- [ ] **Step 4 — commit.** `git add src/components/PosTerminal.vue` then `git commit -m "fix(pos): treat changed current_order_id in table_update as session boundary (P3-5)"`

---

## Task 7 — P3-13: guard the QR-draft dismissal against a stale late resolve

**Finding P3-13** — `src/components/PosTerminal.vue` `dismissQrDraft` (`~L1237-1252`) unconditionally nulls the shared `activeQrDraft` after its awaited DELETE resolves, with no `mySeq` capture (unlike the store's `loadActiveTableDraft` `~L572`). A late-resolving A-session DELETE can null a newer B-session's freshly-loaded draft banner. **Defect: unguarded cross-session null-out.** Fix at the store seam (real unit test): add a guarded `dismissActiveQrDraft` store action mirroring `loadActiveTableDraft`, expose it through the `useTables` facade, and delegate the component's `dismissQrDraft` to it.

**Files:** `assets/js/composables/stores/orderSessionStore.js` (new action after `loadActiveTableDraft` `~L583`; export `~L2331`), `assets/js/composables/useTables.js` (facade actions), `src/components/PosTerminal.vue` (`dismissQrDraft` `~L1237`, `tables` destructure `~L935`). Test: `backend/tests/unit/orderSessionStore.test.js`.

**Interfaces:** new `dismissActiveQrDraft(tableId)` store action; `invalidateTableSession()` (exported, bumps `tableSessionSeq` and clears `activeQrDraft`).

- [ ] **Step 1 — full failing test.** Append to `backend/tests/unit/orderSessionStore.test.js`:
```javascript
describe('useOrderSessionStore — dismissActiveQrDraft session guard (P3-13)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('does not null a newer session draft when an older DELETE resolves late', async () => {
    let resolveDelete;
    const deletePromise = new Promise(r => { resolveDelete = r; });
    global.fetch = vi.fn(() => deletePromise.then(() => ({ json: () => Promise.resolve({ success: true }) })));

    const store = useOrderSessionStore();
    // Session A begins dismissing table 7's draft.
    const p = store.dismissActiveQrDraft(7);
    // Operator switches to table B mid-flight: the token bumps and B loads its own draft banner.
    store.invalidateTableSession();
    store.activeQrDraft = [{ product_id: 1, name: 'B-draft' }];

    resolveDelete();
    await p;

    // A's late DELETE must NOT clear B's freshly-loaded draft.
    expect(store.activeQrDraft).toEqual([{ product_id: 1, name: 'B-draft' }]);
  });
});
```

- [ ] **Step 2 — run → FAIL.** `npx vitest run backend/tests/unit/orderSessionStore.test.js`. FAILS: `store.dismissActiveQrDraft` does not exist yet (`TypeError: store.dismissActiveQrDraft is not a function`).

- [ ] **Step 3 — minimal fix.**
  Edit A — new guarded action, inserted right after `loadActiveTableDraft` closes (`~L583`):
```javascript
  // Guarded QR draft dismissal — mirrors loadActiveTableDraft. Captures the table-session
  // token before the DELETE and skips the activeQrDraft null-out if the session changed
  // mid-flight, so a late-resolving dismiss from a table the operator already left cannot
  // null a newer session's freshly-loaded draft banner.
  const dismissActiveQrDraft = async (tableId) => {
    if (!tableId) return;
    const mySeq = tableSessionSeq.value;
    try {
      const res = await fetch(`api/pos/table-draft/${tableId}`, { method: 'DELETE' });
      const data = await res.json();
      if (mySeq !== tableSessionSeq.value) return; // session changed mid-flight
      if (data.success) {
        activeQrDraft.value = null;
      } else {
        console.error('Failed to dismiss table draft:', data.message);
      }
    } catch (err) {
      console.error('Error dismissing table draft:', err);
    }
  };
```
  Edit B — export it in the store return object, next to `loadActiveTableDraft` (`~L2331`):
```javascript
// BEFORE
    loadActiveTableDraft,
// AFTER
    loadActiveTableDraft,
    dismissActiveQrDraft,
```
  Edit C — `assets/js/composables/useTables.js`, add to the `// actions` block (e.g. beside `holdCurrentOrder: session.holdCurrentOrder,`):
```javascript
    dismissActiveQrDraft: session.dismissActiveQrDraft,
```
  Edit D — `src/components/PosTerminal.vue`, add `dismissActiveQrDraft` to the `tables` destructure (`~L935`, the line ending `... loadActiveTableOrder, loadActiveTableDraft,`):
```javascript
  activeMode, activeModeSourceTable, joinSelectedChildIds, loadActiveTableOrder, loadActiveTableDraft, dismissActiveQrDraft,
```
  Edit E — `src/components/PosTerminal.vue`, replace the component `dismissQrDraft` (`~L1237-1252`) with a thin delegate:
```javascript
// BEFORE
const dismissQrDraft = async () => {
  if (!activeTable.value?.id) return;
  try {
    const res = await fetch(`api/pos/table-draft/${activeTable.value.id}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      activeQrDraft.value = null;
    } else {
      console.error("Failed to dismiss table draft:", data.message);
    }
  } catch (err) {
    console.error("Error dismissing table draft:", err);
  }
};
// AFTER
const dismissQrDraft = async () => {
  if (!activeTable.value?.id) return;
  await dismissActiveQrDraft(activeTable.value.id);
};
```

- [ ] **Step 4 — run → PASS.** `npx vitest run backend/tests/unit/orderSessionStore.test.js` — new case green; existing store cases green.

- [ ] **Step 5 — file gate + build.** `npx vitest run backend/tests/unit/orderSessionStore.test.js` then `npm run build` (verifies facade + SFC wiring compiles; `dismissQrDraft` is still referenced by `importQrDraftItems` `~L1225`).

- [ ] **Step 6 — commit.** `git add assets/js/composables/stores/orderSessionStore.js assets/js/composables/useTables.js src/components/PosTerminal.vue backend/tests/unit/orderSessionStore.test.js` then `git commit -m "fix(pos): guard QR-draft dismissal against stale session (P3-13)"`

---

## Task 8 — P3-6 (PLAUSIBLE, lower priority): scope the `existingItemsForPrint` FOR UPDATE lock to `order_items` + remove the dead error-mapper branch

**Finding P3-6** — `backend/routes/pos/tables.js` (`~L1181-1188`): the applied `item_name` COALESCE fix added `LEFT JOIN products` inside a `FOR UPDATE` query. MariaDB has no `FOR UPDATE OF`, so it X-locks the matched rows of **all** joined tables — every product on the order is locked for the whole save txn, though the name fetch needs no such lock. **Defect: the display-name join widened the write lock onto `products`.** Behavior-preserving refactor: keep `FOR UPDATE` on a single-table `order_items` query; resolve the catalog fallback names in a SEPARATE non-locking query and COALESCE in JS.

**Also folds the CLEANUP finding** — the error-status mapper (`~L1520`) still matches `e.message?.includes('reason is required')`, but no path throws that message anymore (the void-reason hard-throws were removed). Remove the dead condition.

> **SEQUENCING:** land this task AFTER sibling **Plan 2** (its P1-1 filter reads this same `existingItemsForPrint` query). Re-open `~L1181` first — its shape may have shifted.

**Files:** `backend/routes/pos/tables.js` (`existingItemsForPrint` `~L1181`; error mapper `~L1520`). Test: `backend/tests/integration/tables.test.js` (characterization).

**Interfaces:** `existingItemsForPrint` rows carry `{ product_id, item_name, quantity, note, parent_item_id }`; `item_name` must remain `COALESCE(order_items.item_name, products.name)` for the void-item audit (`~L1222`).

- [ ] **Step 1 — characterization test (green throughout; this is a behavior-preserving refactor, so there is NO red phase for the lock scope — the lock change is covered by MANUAL VERIFICATION in Step 3b).** Append inside the top-level table describe. It pins the COALESCE'd audit `item_name` for a product line whose `order_items.item_name` is NULL (must resolve to `products.name`):
```javascript
    describe('existingItemsForPrint COALESCE name preserved after lock-scope refactor (P3-6)', () => {
        it('void_item audit still records the catalog name for a NULL item_name line', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );
            // Reduce 2 → 1 → item-level void audit fires with the COALESCE'd name.
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id, current_order_id: invoiceId,
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00, tax: 0.80, total: 5.80
                });
            expect(res.statusCode).toBe(200);
            const [events] = await pool.query(
                "SELECT old_value FROM audit_events WHERE event_type = 'void_item' AND entity_id = ? ORDER BY id DESC",
                [invoiceId]
            );
            expect(events.length).toBeGreaterThan(0);
            const burger = JSON.parse(events[0].old_value).items.find(i => i.product_id === SEED.product1.id);
            expect(burger.item_name).toBe(SEED.product1.name); // resolved from products.name (order_items.item_name is NULL)
        });
    });
```

- [ ] **Step 2 — run → GREEN (baseline).** `npx vitest run backend/tests/integration/tables.test.js`. This passes against current code (the existing COALESCE join produces the name). It characterizes the behavior the refactor must preserve. (The existing `'Item-Level Void Audit'` suite asserts the same name and must also stay green.)

- [ ] **Step 3a — refactor (preserve COALESCE, scope the lock).** At `~L1181`:
```javascript
// BEFORE
            const [rows] = await conn.query(`
                SELECT oi.product_id, COALESCE(oi.item_name, p.name) AS item_name, oi.quantity, oi.note, oi.parent_item_id
                FROM order_items oi
                LEFT JOIN products p ON oi.product_id = p.id
                WHERE oi.invoice_id = ?
                FOR UPDATE
            `, [order_id]);
            existingItemsForPrint = rows;
// AFTER
            // Lock ONLY order_items (single-table FOR UPDATE). MariaDB has no `FOR UPDATE OF`,
            // so a LEFT JOIN products here would X-lock every joined products row for the whole
            // save txn — the display-name fetch does not need that lock. Resolve the catalog
            // fallback names in a SEPARATE non-locking query and COALESCE in JS.
            const [rows] = await conn.query(`
                SELECT oi.product_id, oi.item_name, oi.quantity, oi.note, oi.parent_item_id
                FROM order_items oi
                WHERE oi.invoice_id = ?
                FOR UPDATE
            `, [order_id]);
            const missingNameIds = [...new Set(
                rows.filter(r => r.item_name == null && r.product_id != null).map(r => r.product_id)
            )];
            let catalogNameById = new Map();
            if (missingNameIds.length > 0) {
                const [prodRows] = await conn.query(
                    `SELECT id, name FROM products WHERE id IN (${missingNameIds.map(() => '?').join(',')})`,
                    missingNameIds
                );
                catalogNameById = new Map(prodRows.map(p => [p.id, p.name]));
            }
            existingItemsForPrint = rows.map(r => ({
                ...r,
                item_name: r.item_name != null
                    ? r.item_name
                    : (r.product_id != null ? (catalogNameById.get(r.product_id) ?? null) : null)
            }));
```
  Edit — remove the dead error-mapper branch at `~L1519-1520`:
```javascript
// BEFORE
            else if (
                e.message?.includes('reason is required') ||
                e.message?.includes('mismatch') ||
// AFTER
            else if (
                e.message?.includes('mismatch') ||
```

- [ ] **Step 3b — MANUAL VERIFICATION (lock scope; hard to unit-test).** With two DB sessions: BEGIN a table save txn that reaches the `existingItemsForPrint` `FOR UPDATE` on order O (which references product P), and hold it open; in a second session run `SELECT ... FROM products WHERE id = <P> FOR UPDATE`. Pre-fix this second lock blocks on the save txn's products lock; post-fix it acquires immediately (only `order_items` rows are locked). (Alternatively confirm via `SHOW ENGINE INNODB STATUS` / `performance_schema.data_locks` that no `products` row is X-locked during the save txn.)

- [ ] **Step 4 — run → GREEN (unchanged).** `npx vitest run backend/tests/integration/tables.test.js` — characterization case + existing audit suite stay green (COALESCE result identical). The removed mapper branch has no test (dead message — noted in Self-Review).

- [ ] **Step 5 — file gate.** `npx vitest run backend/tests/integration/tables.test.js`

- [ ] **Step 6 — commit.** `git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js` then `git commit -m "refactor(tables): scope save FOR UPDATE to order_items + drop dead error branch (P3-6)"`

---

## Task 9 — P3-15 (cleanup, last): remove dead `checkHasVoids`

**Finding P3-15** — after the void-modal removal, `checkHasVoids` (defined `assets/js/composables/stores/orderSessionStore.js` `~L2087`, exported `~L2413`, re-exported `assets/js/composables/useCart.js` `~L86`) is called by NO component — its only reference is `backend/tests/unit/orderSessionStore.test.js`. Confirmed by grep: matches only in those three files, zero component/`src` references. **Defect: dead code.**

**Files:** `assets/js/composables/stores/orderSessionStore.js` (definition `~L2087-2110`, export `~L2413`), `assets/js/composables/useCart.js` (`~L86`), `backend/tests/unit/orderSessionStore.test.js` (the `'saved-item void detection'` describe `~L778-795`).

- [ ] **Step 1 — prove zero live references (the "test" for a dead-code removal).**
```bash
npx vitest run backend/tests/unit/orderSessionStore.test.js   # baseline green
```
  Then confirm the only non-test references are the definition, the store export, and the facade passthrough:
```bash
grep -rn "checkHasVoids" assets/js src backend | grep -v "backend/tests/"
```
  Expect exactly three hits: the `const checkHasVoids = () => {` definition, the `checkHasVoids,` store export, and `checkHasVoids: session.checkHasVoids,` in `useCart.js`. No `src/` component hit.

- [ ] **Step 2 — remove the code.**
  Edit A — delete the `checkHasVoids` definition in `orderSessionStore.js` (`~L2087-2110`, the full `const checkHasVoids = () => { ... };` block up to and including its closing `};`).
  Edit B — remove the export line in the store return object (`~L2413`):
```javascript
// BEFORE
    processCheckout,
    checkHasVoids,
    toggleTaxExempt,
// AFTER
    processCheckout,
    toggleTaxExempt,
```
  Edit C — remove the facade passthrough in `useCart.js` (`~L86`):
```javascript
// BEFORE
    // actions (functions — passthrough, NOT via storeToRefs)
    checkHasVoids: session.checkHasVoids,
    getItemTotal: session.getItemTotal,
// AFTER
    // actions (functions — passthrough, NOT via storeToRefs)
    getItemTotal: session.getItemTotal,
```
  Edit D — remove the now-dangling unit test: delete the entire `describe('useOrderSessionStore - saved-item void detection', ...)` block (`~L778-795`) from `backend/tests/unit/orderSessionStore.test.js`. (This is the ONLY test that calls `checkHasVoids`; the metadata-resync test does not reference it.)

- [ ] **Step 3 — run → PASS (no references break).**
```bash
npx vitest run backend/tests/unit/orderSessionStore.test.js
grep -rn "checkHasVoids" assets/js src backend    # expect: no matches
```

- [ ] **Step 4 — build gate.** `npm run build` — compiles clean (facade no longer exposes the removed action).

- [ ] **Step 5 — file gate.** `npx vitest run backend/tests/unit/orderSessionStore.test.js`

- [ ] **Step 6 — commit.** `git add assets/js/composables/stores/orderSessionStore.js assets/js/composables/useCart.js backend/tests/unit/orderSessionStore.test.js` then `git commit -m "chore(pos): remove dead checkHasVoids after void-modal removal (P3-15)"`

---

## Post-plan verification (run before declaring done)

- `npx vitest run backend/tests/integration/tables.test.js` — green.
- `npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/unit/PosCalculator.test.js` — green.
- **Full backend suite:** `npx vitest run` — no regressions (this plan touches the shared `tables.js` / `helpers.js` / `PosCalculator.js` seams that `checkout.test.js` and `permissions.test.js` also exercise).
- `npm run build` — green.
- Manual smoke: save a table with a correct Auto-Gratuity line (200) and a forged one (400); save a table twice as a non-waiter and confirm the Update/Pay buttons re-enable (P2-8); a waiter with blank sections sees an empty floor; after an admin override save the floor badge still shows the original waiter; transfer a table under an open cart and confirm the editing terminal leaves rather than merging.

## Self-Review

- **P2-7** mirrors the checkout.js validation (`~L296-306`) but places the recompute AFTER `applyDatabasePrices` so `subtotalWithoutFees` uses DB-authoritative prices (stricter than checkout, not weaker). Requires two new helper imports (`calculateLineTotal`, `roundMoney`) — verified NOT already imported in tables.js. The `service_charge_enabled = '0'` seed default means the accept-case test MUST enable it first (done in `beforeEach`). Admin passes the pre-existing `canApplyServiceCharge` gate (`userHas` returns true for admin/programmer — confirmed in helpers.js `~L42`). `assertNearMoney` throws `"… mismatch …"` → 400 via the mapper; disabled/tax paths carry explicit `err.statusCode = 400`.
- **P2-8** is a one-line-plus-comment addition on the success path; the `finally` is left byte-for-byte because it already no-ops on success (seq bumped) and still clears on error/early-return. `keepProcessingOnSuccess` semantics preserved (guest-check print keeps the lock). The existing `'table save metadata resync'` test remains valid.
- **P2-9** only narrows the waiter path; cashier/other non-admin roles keep the historical fail-open on blank (per finding scope). `get_tables` re-queries `allowed_sections` fresh each call, so the existing `waiterCookie` reflects the UPDATE without re-login.
- **P3-17** changes four identical join clauses; only the two `get_tables` ones are directly tested (the two helpers.js broadcast queries are consistency changes with no assertion — noted in the task). The admin override save keeps qty=2 to avoid tripping the void gate.
- **P3-14** narrows the nullish fallback to custom lines only; re-checked every existing PosCalculator case (real rates, 0 rate, `product_id:null` invalid-rate throw) stays green.
- **P3-5** and the lock-scope half of **P3-6** are the two behaviors that resist a real unit test (component socket handler; InnoDB row-lock scope). Both ship with explicit MANUAL VERIFICATION repros; each still routes through a store primitive that IS unit-tested (`closeTable`) or a preserved characterization test (COALESCE name). **P3-13** was deliberately moved to a store-seam action so it CAN carry a real red→green unit test rather than manual-only.
- **P3-6** is behavior-preserving, so its task has no red phase for the refactor itself — this is called out explicitly (characterization test green throughout). The task is marked PLAUSIBLE / lower priority per the finding and is sequenced last among the backend edits, after sibling Plan 2.
- **CLEANUP (dead error-mapper branch)** is folded into Task 8's commit (nearest tables.js task); it has no test because no code throws `'reason is required'` anymore — noted here as required.
- **P3-15** is pure dead-code removal proven by grep (three references, all removed); no `src/` component imports break.
- Deferred / out of scope: no new UI to surface the owner-vs-editor distinction (P3-17 keeps a single badge = owner); no attempt to also scope the merge/settle `FOR UPDATE` queries elsewhere (only the audited `existingItemsForPrint` join was widened).

## Cross-plan file overlap

This plan edits files that sibling plans also touch — **different regions**, but sequence matters:

| File | This plan's regions | Also edited by |
|---|---|---|
| `backend/routes/pos/tables.js` | auto-gratuity validation (~L1113/1139), `get_tables` isAllSections (~L136) + waiter join (~L155/200), `existingItemsForPrint` (~L1181), error mapper (~L1520) | Plans 1 / 2 / 3 / 6 (distinct regions) |
| `backend/routes/pos/helpers.js` | broadcast waiter join (~L137/169) | Plan 6 |
| `backend/services/PosCalculator.js` | tax rollup (~L91) | interacts with Plan 2's bundle stock math |
| `assets/js/composables/stores/orderSessionStore.js` | `updateActiveTableOrder` finally, `dismissActiveQrDraft`, `checkHasVoids` removal | Plans 4 / 6 |
| `assets/js/composables/useCart.js` | `checkHasVoids` passthrough removal | Plan 4 |
| `assets/js/composables/useTables.js` | `dismissActiveQrDraft` facade export | Plan 6 |
| `src/components/PosTerminal.vue` | `onTableUpdate`, `dismissQrDraft` | Plan 3 |

**Recommendations:** land this plan **LAST**. In particular sequence **Task 8 (P3-6)** after sibling **Plan 2** — its P1-1 filter reads the SAME `existingItemsForPrint` query this task restructures — and note **P3-14 (PosCalculator)** interacts with Plan 2's bundle-stock path. Re-open every cited `file:line` before editing (line numbers drift as sibling plans land). After this plan, re-run the FULL backend suite `npx vitest run` plus `npm run build`.
