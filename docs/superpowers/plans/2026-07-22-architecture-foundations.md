# Architecture Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove one artificial frontend dependency cycle and establish one canonical Saved Order Line implementation used by checkout and table saving without changing public behavior.

**Architecture:** Keep existing route and composable interfaces stable. Add one deep backend module for persisted-line identity, historical price, modifier, surcharge, quantity, and tax context; checkout and table-save remain HTTP adapters at the existing URLs. The frontend change deletes unused coupling rather than adding another abstraction.

**Tech Stack:** Node.js CommonJS, Express 5, mysql2, Vue 3, Pinia, Vitest 4, Supertest, MySQL/MariaDB.

## Global Constraints

- Preserve every public URL and response shape.
- Preserve database schema and transaction ordering.
- Preserve number-only employee login.
- Do not add backup behavior.
- Add no dependencies.
- Add no controller, repository, DTO, class hierarchy, or strategy interface.
- Keep exactly one implementation of each moved rule; compatibility modules may only re-export.
- Use red-green-refactor for every production change.
- Do not move unrelated files.

---

### Task 1: Remove the artificial catalog-to-cart dependency

**Files:**
- Create: `backend/tests/unit/useProducts.independence.test.js`
- Modify: `assets/js/composables/useProducts.js:1-2,19,271-276`
- Modify: `assets/js/composables/stores/orderSessionStore.js:46-48`

**Interfaces:**
- Consumes: Existing `useProducts()` with no required arguments.
- Produces: `useProducts()` with the same returned refs/actions and no dependency on `useCart()`.

- [x] **Step 1: Write the failing independence test**

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../assets/js/composables/useCart.js', () => ({
  useCart: () => {
    throw new Error('catalog must not initialize cart');
  }
}));

describe('useProducts dependency ownership', () => {
  beforeEach(() => vi.resetModules());

  it('initializes catalog state without initializing cart state', async () => {
    const { useProducts } = await import('../../../assets/js/composables/useProducts.js');
    expect(() => useProducts()).not.toThrow();
  });
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```powershell
npx vitest run backend/tests/unit/useProducts.independence.test.js
```

Expected: FAIL with `catalog must not initialize cart` from the current `useProducts()` fallback.

- [x] **Step 3: Delete the unused dependency**

In `assets/js/composables/useProducts.js`:

```js
import { ref, computed, watch } from 'vue';

// Delete cartCoreRef.

export function useProducts() {
  return {
    // existing return object remains byte-for-byte behaviorally unchanged
  };
}
```

Delete the obsolete circular-dependency comment in `orderSessionStore.js`. Do not change the `useProducts()` call there.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
npx vitest run backend/tests/unit/useProducts.independence.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/tableSession.logic.test.js backend/tests/unit/useCart.logic.test.js
```

Expected: all selected files pass.

- [x] **Step 5: Verify the dependency is absent**

Run:

```powershell
rg -n "useCart|cartCoreRef|cartCore" assets/js/composables/useProducts.js
```

Expected: no matches.

- [x] **Step 6: Commit**

```powershell
git add backend/tests/unit/useProducts.independence.test.js assets/js/composables/useProducts.js assets/js/composables/stores/orderSessionStore.js
git commit -m "refactor: remove catalog cart dependency"
```

---

### Task 2: Specify the Saved Order Line interface with failing tests

**Files:**
- Create: `backend/tests/unit/SavedOrderLines.test.js`
- Create after RED: `backend/modules/orders/SavedOrderLines.js`

**Interfaces:**
- Consumes: the persisted order-item rows selected by each caller and submitted cart lines using current database/client field names.
- Produces:
  - `savedLineKey(line): string`
  - `buildSavedLineIndex(savedLines): SavedLineIndex`
  - `resolveCheckoutSavedLine(index, submittedLine, { allowMissingTax? }): SavedLineContext | null`
  - `resolveTableSavedLine(index, submittedLine): SavedLineContext | null`
  - `priceMapFor(index): Map<string, number>`
  - `taxOverridesFor(resolvedContexts): Map<object, number>`

Two resolver functions are intentional. Checkout and table re-save share identity/indexing implementation, but their established conflict policies are different: checkout consumes persisted quantity and returns `403` for an ambiguous fallback; table re-save does not consume quantity and returns `409` when a stale or id-less line has more than one complete persisted context. Do not hide those differences behind a strategy object or boolean soup.

`SavedLineContext` has this concrete runtime shape:

```js
{
  price: Number,
  taxRate: Number | null,
  product_id: Number | null,
  name: String | null,
  note: String,
  selectedModifiers: String | null,
  modifier_surcharge: Number | null,
  modifier_tax_amount: Number | null,
  remaining: Number,
  matchedById: Boolean
}
```

- [x] **Step 1: Write failing tests for the real invariants**

Create tests covering:

```js
const saved = {
  id: 10,
  product_id: 4,
  item_name: 'Burger',
  note: '',
  quantity: 2,
  price_at_sale: 5.25,
  tax_rate: 16,
  selected_modifiers: JSON.stringify([{ gid: 'g1', oid: 'o1', group: 'Size', option: 'Large' }]),
  modifier_surcharge: 0.75,
  modifier_tax_amount: 0.1
};

it('pins a submitted line to its persisted id and consumes quantity', () => {
  const index = buildSavedLineIndex([saved]);
  const submitted = { order_item_id: 10, product_id: 4, name: 'Burger', note: '', qty: 1 };
  const context = resolveCheckoutSavedLine(index, submitted);
  expect(context).toMatchObject({ price: 5.25, taxRate: 16, remaining: 1 });
});

it('rejects reusing a cheap saved id after its quantity is consumed in a mixed-price group', () => {
  const index = buildSavedLineIndex([
    { ...saved, quantity: 1 },
    { ...saved, id: 11, quantity: 1, price_at_sale: 6 }
  ]);
  resolveCheckoutSavedLine(index, {
    order_item_id: 10, product_id: 4, name: 'Burger', note: '', qty: 1
  });
  expect(() => resolveCheckoutSavedLine(index, {
    order_item_id: 10, product_id: 4, name: 'Burger', note: '', qty: 1
  })).toThrow('Items cannot be changed while cashing out');
});

it('rejects a saved id borrowed by another product', () => {
  const index = buildSavedLineIndex([saved]);
  expect(() => resolveCheckoutSavedLine(index, {
    order_item_id: 10, product_id: 9, name: 'Drink', note: '', qty: 1
  })).toThrow('Saved item identity changed');
});

it('allows id-less fallback only for an unambiguous group', () => {
  const index = buildSavedLineIndex([saved]);
  const context = resolveCheckoutSavedLine(index, { product_id: 4, name: 'Burger', note: '', qty: 1 });
  expect(context.price).toBe(5.25);
  expect(context.taxRate).toBe(16);
});

it('rejects id-less fallback when one identity has multiple historical prices', () => {
  const index = buildSavedLineIndex([
    saved,
    { ...saved, id: 11, quantity: 1, price_at_sale: 6 }
  ]);
  expect(() => resolveCheckoutSavedLine(index, {
    product_id: 4, name: 'Burger', note: '', qty: 1
  })).toThrow('Items cannot be changed while cashing out');
});

it('keys custom lines by name and note', () => {
  expect(savedLineKey({ product_id: null, item_name: 'Open Item', note: 'No salt' }))
    .toBe('custom:Open Item|No salt');
});
```

Add these exact ambiguity cases in the same file:

```js
it('rejects id-less fallback when tax context is ambiguous', () => {
  const index = buildSavedLineIndex([
    saved,
    { ...saved, id: 11, quantity: 1, tax_rate: 8 }
  ]);
  expect(() => resolveCheckoutSavedLine(index, {
    product_id: 4, name: 'Burger', note: '', qty: 1
  })).toThrow('Items cannot be changed while cashing out');
});

it('returns the persisted modifier money context', () => {
  const index = buildSavedLineIndex([saved]);
  const context = resolveCheckoutSavedLine(index, {
    order_item_id: 10,
    product_id: 4,
    name: 'Burger',
    note: '',
    qty: 1,
    selectedModifiers: [{ gid: 'g1', oid: 'o1', group: 'Size', option: 'Large' }]
  });
  expect(context.selectedModifiers).toContain('"gid":"g1"');
  expect(context.modifier_surcharge).toBe(0.75);
  expect(context.modifier_tax_amount).toBe(0.1);
});

it('uses checkout modifier identity to select one of otherwise equivalent snapshots', () => {
  const large = saved.selected_modifiers;
  const small = JSON.stringify([{ gid: 'g1', oid: 'o2', group: 'Size', option: 'Small' }]);
  const index = buildSavedLineIndex([
    saved,
    { ...saved, id: 11, quantity: 1, selected_modifiers: small }
  ]);
  const context = resolveCheckoutSavedLine(index, {
    product_id: 4,
    name: 'Burger',
    note: '',
    qty: 1,
    selectedModifiers: JSON.parse(large)
  });
  expect(context.selectedModifiers).toBe(large);
});

it('allows missing tax only for a legacy checkout snapshot', () => {
  const index = buildSavedLineIndex([{ ...saved, tax_rate: undefined }]);
  expect(() => resolveCheckoutSavedLine(index, {
    product_id: 4, name: 'Burger', note: '', qty: 1
  })).toThrow('Items cannot be changed while cashing out');
  expect(resolveCheckoutSavedLine(index, {
    product_id: 4, name: 'Burger', note: '', qty: 1
  }, { allowMissingTax: true }).taxRate).toBeNull();
});

it('table re-save accepts a stale id only when one complete context exists', () => {
  const index = buildSavedLineIndex([saved]);
  expect(resolveTableSavedLine(index, {
    order_item_id: 999, product_id: 4, name: 'Burger', note: '', qty: 1
  })).toMatchObject({ price: 5.25, taxRate: 16, matchedById: false });
});

it('table re-save rejects an id-less line with conflicting modifier snapshots', () => {
  const index = buildSavedLineIndex([
    saved,
    { ...saved, id: 11, selected_modifiers: JSON.stringify([
      { gid: 'g1', oid: 'o2', group: 'Size', option: 'Small' }
    ]) }
  ]);
  expect(() => resolveTableSavedLine(index, {
    product_id: 4, name: 'Burger', note: '', qty: 1
  })).toThrow('Saved item context is stale or ambiguous');
});

it('preserves saved tax coercion while excluding invalid exact-id rates', () => {
  const finiteLine = { product_id: 4 };
  const legacyNullLine = { product_id: 5 };
  const overrides = taxOverridesFor(new Map([
    [finiteLine, { taxRate: 16 }],
    [legacyNullLine, { taxRate: null }],
    [{ product_id: 6 }, { taxRate: Number.NaN }]
  ]));
  expect(overrides.get(finiteLine)).toBe(16);
  expect(overrides.get(legacyNullLine)).toBe(0);
  expect(overrides.size).toBe(2);
});

it('exposes the single-price fallback map expected by database repricing', () => {
  const index = buildSavedLineIndex([saved]);
  expect(priceMapFor(index).get('4|')).toBe(5.25);
});

it('keeps mixed-price identities marked as frozen for database repricing', () => {
  const index = buildSavedLineIndex([saved, { ...saved, id: 11, price_at_sale: 6 }]);
  expect(priceMapFor(index).has('4|')).toBe(true);
  expect(priceMapFor(index).get('4|')).toBe(6);
});
```

Also characterize these preservation cases before implementation: financial ambiguity is rejected before modifier matching; absent or unmatched submitted modifiers yield a null saved snapshot; fallback name is null when saved names differ; one finite tax plus a missing or invalid tax value uses the finite rate, while explicit null is preserved as zero; legacy mode accepts zero or multiple finite rates and returns null unless exactly one rate exists.

- [x] **Step 2: Run the tests and verify RED**

Run:

```powershell
npx vitest run backend/tests/unit/SavedOrderLines.test.js
```

Expected: FAIL because `backend/modules/orders/SavedOrderLines.js` does not exist.

- [x] **Step 3: Implement the minimum deep module**

Implement `SavedOrderLines.js` as CommonJS. Internally keep:

```js
function buildSavedLineIndex(savedLines) {
  return {
    rowById: new Map(),
    contextsByKey: new Map(),
    pricesByKey: new Map(),
    taxRatesByKey: new Map(),
    modifierSnapshotsByKey: new Map(),
    surchargesByKey: new Map(),
    modifierTaxesByKey: new Map(),
    namesByKey: new Map()
  };
}
```

Populate the maps in one pass. Callers decide whether child rows are part of the input; the module must not silently filter them.

Both resolvers must resolve a supplied `order_item_id` first and reject a found row whose product, custom-item name, or note identity changed with the existing `409` identity error.

`resolveCheckoutSavedLine` must consume `remaining` quantity on an exact match. Its fallback evaluates the whole group's price, finite tax rates (unless `allowMissingTax`), surcharge, and modifier tax before looking at modifiers. Multiple modifier snapshots do not disambiguate money: return the matching persisted snapshot when submitted identity matches, otherwise return null, preserving checkout's established nullable fallback. A unique saved name is returned; differing names return null. An unresolved or financially ambiguous frozen group throws the existing checkout message with `statusCode = 403`.

Preserve tax provenance from the old routes: index tax with `Number(rawTax)` so explicit `null` is 0, finite numeric strings become numbers, and missing/invalid values remain `NaN`. Only finite values participate in group ambiguity. `taxOverridesFor` preserves the legacy null-to-zero fallback but excludes non-finite exact-ID contexts.

`resolveTableSavedLine` must not consume quantity. An exact ID returns its exact context. A stale or absent ID may fall back only when the key has one complete persisted context, including modifier snapshot; otherwise it throws the existing table message with `statusCode = 409`.

`priceMapFor` must contain every persisted identity, including mixed-price groups, and preserve the original last-row value. `applyDatabasePrices` uses map membership to recognize a frozen line; omitting a mixed-price key would reprice it from the current catalog.

Return `null` when the submitted identity has no persisted group, because route-only lines such as Auto-Gratuity remain outside this module.

Export only:

```js
module.exports = {
  savedLineKey,
  buildSavedLineIndex,
  resolveCheckoutSavedLine,
  resolveTableSavedLine,
  priceMapFor,
  taxOverridesFor
};
```

- [x] **Step 4: Run the unit tests and verify GREEN**

Run:

```powershell
npx vitest run backend/tests/unit/SavedOrderLines.test.js
```

Expected: all tests pass.

- [x] **Step 5: Commit**

```powershell
git add backend/modules/orders/SavedOrderLines.js backend/tests/unit/SavedOrderLines.test.js
git commit -m "refactor: centralize saved order line context"
```

---

### Task 3: Route settled checkout through Saved Order Lines

**Files:**
- Create: `backend/tests/unit/savedOrderLinesWiring.test.js`
- Modify: `backend/routes/pos/checkout.js:602-899`
- Test: `backend/tests/integration/checkout.test.js`

**Interfaces:**
- Consumes: Task 2 exports.
- Produces: unchanged `POST /api/pos/checkout` behavior using the canonical Saved Order Line implementation.

- [x] **Step 1: Add a failing architecture assertion proving the route crosses the module seam**

```js
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const checkoutPath = path.resolve(process.cwd(), 'backend/routes/pos/checkout.js');
const checkoutSource = fs.readFileSync(checkoutPath, 'utf8');

describe('Saved Order Lines route ownership', () => {
  it('routes checkout frozen-line rules through the canonical module', () => {
    expect(checkoutSource).toContain("require('../../modules/orders/SavedOrderLines')");
    expect(checkoutSource).not.toContain('const registerSavedRow =');
    expect(checkoutSource).not.toContain('const modifierSnapshotMatches =');
  });
});
```

Runtime behavior remains protected by the existing multi-price, stable-line-id, price-swap, modifier snapshot, bundle, and table-settlement cases in `checkout.test.js`.

- [x] **Step 2: Run only the new checkout ownership assertion and verify RED**

Run:

```powershell
npx vitest run backend/tests/unit/savedOrderLinesWiring.test.js
```

Expected: FAIL because checkout does not yet import the canonical module and still defines `registerSavedRow`.

- [x] **Step 3: Replace local indexing/resolution implementation**

At the top of checkout:

```js
const {
  savedLineKey,
  buildSavedLineIndex,
  resolveCheckoutSavedLine,
  priceMapFor,
  taxOverridesFor
} = require('../../modules/orders/SavedOrderLines');
```

Replace the local `keyOfSaved`, modifier-snapshot parsers, `registerSavedRow`, saved group maps, and line-resolution loop. Preserve route-only responsibilities:

- Loading table or split persisted rows.
- Legacy split database lookup.
- Calling bundle validation.
- Applying current catalog prices to non-frozen lines.
- Service-charge snapshot validation.
- Transaction ordering and response handling.

Do not move those responsibilities in this task.

- [x] **Step 4: Run checkout and settlement tests**

Run:

```powershell
npx vitest run backend/tests/unit/SavedOrderLines.test.js backend/tests/integration/tableSettlementContext.test.js backend/tests/integration/checkout.test.js
```

Expected: all selected tests pass.

- [x] **Step 5: Confirm the duplicated local helpers are gone**

Run:

```powershell
rg -n "serializeStoredModifierSnapshot|modifierSnapshotMatches|selectSavedModifierSnapshot|registerSavedRow" backend/routes/pos/checkout.js
```

Expected: no matches.

- [x] **Step 6: Commit**

```powershell
git add backend/routes/pos/checkout.js backend/tests/unit/savedOrderLinesWiring.test.js
git commit -m "refactor: use saved line module in checkout"
```

---

### Task 4: Route table saving through Saved Order Lines

**Files:**
- Modify: `backend/tests/unit/savedOrderLinesWiring.test.js`
- Modify: `backend/routes/pos/tables.js:1562-1863`
- Test: `backend/tests/integration/tables.test.js`

**Interfaces:**
- Consumes: Task 2 exports.
- Produces: unchanged `POST /api/pos/table_order` behavior using the same canonical Saved Order Line implementation as checkout.

- [x] **Step 1: Add a failing architecture assertion for table saving**

Append to `savedOrderLinesWiring.test.js`:

```js
const tablesPath = path.resolve(process.cwd(), 'backend/routes/pos/tables.js');
const tablesSource = fs.readFileSync(tablesPath, 'utf8');

it('routes table-save frozen-line rules through the canonical module', () => {
  expect(tablesSource).toContain("require('../../modules/orders/SavedOrderLines')");
  expect(tablesSource).not.toContain('const savedContextsByKey =');
  expect(tablesSource).not.toContain('const savedGroupSurcharges =');
  expect(tablesSource).not.toContain('const savedGroupModifierTaxes =');
});
```

Runtime behavior remains protected by the existing historical-price, stable-row-id, modifier, bundle, tax drift, void, and rollback cases in `tables.test.js` and `bundle.tables.test.js`.

- [x] **Step 2: Run only the new table case and verify RED against the unwired module seam**

Run:

```powershell
npx vitest run backend/tests/unit/savedOrderLinesWiring.test.js
```

Expected: FAIL because table saving does not yet import the canonical module and still owns the saved context maps.

- [x] **Step 3: Replace local indexing/resolution implementation**

Import `buildSavedLineIndex`, `resolveTableSavedLine`, `priceMapFor`, and `taxOverridesFor`. Delete local financial-context indexes, group ambiguity maps, and frozen-context selection code where the new module owns those rules.

Keep a route-local raw `savedRowsById` map because bundle reconstruction and persistence later in this handler require the original database rows. This map is not a second financial resolver: it must only support the table-specific bundle responsibilities below.

Keep table-only responsibilities in the route:

- Loading existing rows under the current transaction.
- Bundle-child reconstruction and persistence.
- Permission/void/new-item decisions.
- Service-charge snapshot state transitions.
- Stock, kitchen print, table status, audit, and broadcast behavior.

- [x] **Step 4: Run table and shared-line tests**

Run:

```powershell
npx vitest run backend/tests/unit/SavedOrderLines.test.js backend/tests/integration/tables.test.js backend/tests/integration/bundle.tables.test.js
```

Expected: all selected tests pass.

- [x] **Step 5: Confirm route duplication is removed**

Run:

```powershell
rg -n "savedContextsByKey|resolvedSavedTaxRates|savedGroupSurcharges|savedGroupModifierTaxes" backend/routes/pos/tables.js backend/routes/pos/checkout.js
```

Expected: no route-owned saved-line context maps remain; equivalent implementation exists only in `SavedOrderLines.js`.

- [x] **Step 6: Commit**

```powershell
git add backend/routes/pos/tables.js backend/tests/unit/savedOrderLinesWiring.test.js
git commit -m "refactor: use saved line module in table orders"
```

---

### Task 5: Phase verification and documentation

**Files:**
- Modify: `docs/superpowers/plans/2026-07-22-architecture-foundations.md` checkbox statuses only.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: verified Phase 1 baseline for the next table-order transaction plan.

- [x] **Step 1: Verify no unexpected public-path changes**

Run:

```powershell
git diff master...HEAD -- backend/routes/pos.js backend/routes/admin.js server.js src/router.js src/admin/router.js
```

Expected: no changes to route mounts, middleware order, or frontend routes.

- [x] **Step 2: Run the full automated suite**

Run:

```powershell
npm run test:unit
```

Expected: 0 failed tests.

- [x] **Step 3: Run the production build**

Run:

```powershell
npm run build
```

Expected: exit code 0 with all four Vite entrypoints emitted.

- [x] **Step 4: Run the settlement benchmark**

Run:

```powershell
node scripts/benchmark-table-settlement.js
```

Expected: exit code 0; record median, p95, and query counts. Investigate any query-count increase before proceeding.

- [x] **Step 5: Check whitespace, paths, and worktree status**

Run:

```powershell
git diff --check
rg -n "useCart|cartCoreRef|cartCore" assets/js/composables/useProducts.js
rg -n "serializeStoredModifierSnapshot|modifierSnapshotMatches|selectSavedModifierSnapshot|registerSavedRow|savedContextsByKey" backend/routes/pos/checkout.js backend/routes/pos/tables.js
git status --short
```

Expected: no whitespace errors; no removed dependency/duplicated-helper matches; only intentional files modified.

- [x] **Step 6: Commit plan status**

```powershell
git add docs/superpowers/plans/2026-07-22-architecture-foundations.md
git commit -m "docs: record architecture foundations completion"
```

## Self-review

- Spec coverage: authentication style and backup non-goals are explicit; backend duplication, frontend cycle, stable paths, TDD, and verification are assigned to concrete tasks.
- Placeholder scan: no TODO/TBD or unspecified implementation step remains.
- Interface consistency: Tasks 3 and 4 consume the checkout/table-specific resolvers and shared index helpers produced by Task 2; their intentionally different conflict policies stay explicit.
- Scope control: table transaction extraction, checkout transaction extraction, frontend path relocation, store ownership, helper cleanup, and native HTTP migration are deliberately separate follow-up plans in the roadmap.
