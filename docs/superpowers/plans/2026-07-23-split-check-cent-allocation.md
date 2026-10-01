# Split-Check Cent Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every newly created split check conserve the locked parent order's subtotal, authorized discount, reconciled tax, and payable cents exactly, while showing and charging the same deterministic amounts throughout the split lifecycle.

**Architecture:** The backend allocates integer cents from the locked parent order across validated active seats using deterministic largest-remainder allocation and persists each allocation in the existing `held_orders.cart_data` JSON. The frontend mirrors the allocation only for immediate preview; persisted backend allocations become authoritative when a held seat is restored, paid, printed, refunded, or reported. Legacy held splits without allocations retain their current calculation path.

**Tech Stack:** Vue 3, Pinia, Vite, Node.js/CommonJS, Express, MySQL/InnoDB, Vitest, Supertest, Playwright.

## Global Constraints

- Scope the behavior change to table split checks and their finalized child orders.
- Do not convert the whole application to integer-cents storage.
- Do not change product prices, quantities, tax rates, normal checkout totals, inventory logic, or global `roundMoney` behavior.
- Do not change the global `0.02` checkout tolerance; new allocated splits use exact cent comparison locally while legacy splits retain the existing fallback.
- Do not add a database migration: persist `split_money_cents` in the existing `held_orders.cart_data` JSON.
- Do not represent a remainder as a fake product, discount, service charge, or altered quantity.
- The backend remains authoritative and derives all allocations from the locked parent order and server-pinned seat items.
- The backend derives each child discount rule from the locked parent order; it never trusts `seat.order_discount` as authorization.
- Empty seats remain omitted before allocation.
- Stable active-seat order is the tie-breaker; the same inputs must always produce the same allocation.
- New allocations must satisfy `subtotal - discount + tax === total` for every seat and must sum component-by-component to the parent.
- A locked parent header may contain the existing one-cent independent-rounding residue. At split time only, derive the authorized discount from its stored rule and reconcile tax as `total - subtotal + discount`; accept this only when it differs from stored tax by at most one cent. Larger mismatches fail closed without mutation.
- Preserve compatibility with legacy held splits that have no `split_money_cents`.
- Add no dependency and no speculative abstraction.
- Execution must start from a branch containing commits `f60ee303` and `66bc7ae5`, or from `master` after those commits are merged.

---

## Scope Decision

This is a contained cross-layer split-check correction, not a system-wide money rewrite.

Production behavior changes are required in:

1. Split modal preview amounts.
2. Server-side split creation and held-check persistence.
3. Held split list/print presentation.
4. Restoring and settling a split child.
5. Final child receipt construction.
6. Full refund component allocation for finalized split children.

Production behavior must not change in:

- Normal register checkout.
- Ordinary saved-table checkout.
- Products, modifiers, subscriptions, customers, or inventory quantities.
- Database column types or schema.
- Global report formulas or global checkout tolerance.
- Legacy split checks already stored without `split_money_cents`.

Reports and JoFotara require regression coverage because they consume finalized split-child data, but no production change is planned there: JoFotara already reconciles a saved payable residue on its final line, and aggregate reports already consume stored order headers or unrounded line expressions. Change those modules only under a new separately reviewed plan if the specified regression tests disprove that evidence.

## Target Data Contract

Each new held split stores this server-authored object inside `cart_data`:

```js
split_money_cents: {
  subtotal: 204,
  discount: 0,
  tax: 33,
  total: 237
}
```

The sibling for a JOD 4.75 tax-exclusive parent is:

```js
split_money_cents: {
  subtotal: 205,
  discount: 0,
  tax: 33,
  total: 238
}
```

The server validates all four values as non-negative safe integers and requires:

```js
subtotal - discount + tax === total
```

## File Map

**Create:**

- `backend/services/SplitMoneyAllocator.js` — pure integer-cent allocation and allocation-shape validation.
- `backend/tests/unit/splitMoneyAllocator.test.js` — deterministic examples and seeded conservation checks.

**Modify:**

- `backend/modules/tables/splitChecks.js` — calculate authoritative seat totals, allocate parent cents, and persist them.
- `backend/modules/checkout/executeCheckout.js` — settle new split children from persisted cents and apportion stored line tax.
- `backend/services/ReceiptPresentation.js` — permit a one-cent row/subtotal apportionment only when explicitly authorized by a trusted split allocation.
- `backend/services/ReceiptPresentationSources.js` — use allocated held/final child summaries and actual child discount money.
- `backend/services/RefundService.js` — use the finalized child order's stored monetary components for split-child refunds.
- `src/pos/stores/orderSession/splitChecks.js` — mirrored preview allocation and request totals.
- `src/pos/stores/orderSessionStore.js` — expose allocated preview amounts and restore persisted split money.
- `src/pos/useTables.js` — expose the allocated item-total action through the existing component facade.
- `src/components/pos/SplitCheckModal.vue` — render allocated share and seat totals.
- `src/utils/receiptPresentation.js` — frontend parity for explicitly allocated split receipts.
- `backend/tests/unit/splitChecks.test.js`
- `backend/tests/unit/orderSessionStore.test.js`
- `backend/tests/unit/receiptPresentation.test.js`
- `backend/tests/integration/tables.test.js`
- `backend/tests/integration/refunds.test.js`
- `backend/tests/unit/jofotaraXmlBuilder.test.js`
- `tests/e2e/specs/admin.split-check.spec.js`

No controller, route, schema, migration, or new frontend component is needed.

---

### Task 1: Add the pure backend cent allocator

**Files:**

- Create: `backend/services/SplitMoneyAllocator.js`
- Create: `backend/tests/unit/splitMoneyAllocator.test.js`

**Interfaces:**

- Produces: `allocateCents(targetCents, weights, capacities?) -> number[]`
- Produces: `allocateSplitMoneyCents(parentTotals, seatTotals) -> SplitMoneyCents[]`
- Produces: `validateSplitMoneyCents(value) -> SplitMoneyCents`
- Produces: `moneyToCents(value) -> number`
- `parentTotals` and `seatTotals` use decimal monetary numbers; returned allocations use integer cents.

- [ ] **Step 1: Write failing deterministic allocation tests**

```js
const {
  allocateCents,
  allocateSplitMoneyCents,
  validateSplitMoneyCents,
  moneyToCents
} = require('../../services/SplitMoneyAllocator');

it('allocates the 4.75 tax-exclusive half-cent case without loss', () => {
  expect(allocateSplitMoneyCents(
    { subtotal: 4.09, tax: 0.66, total: 4.75 },
    [
      { subtotal: 2.047484, discount: 0, tax: 0.327484 },
      { subtotal: 2.047484, discount: 0, tax: 0.327484 }
    ]
  )).toEqual([
    { subtotal: 205, discount: 0, tax: 33, total: 238 },
    { subtotal: 204, discount: 0, tax: 33, total: 237 }
  ]);
});

it('allocates a 4.75 inclusive total as 2.38 and 2.37', () => {
  expect(allocateSplitMoneyCents(
    { subtotal: 4.75, tax: 0, total: 4.75 },
    [
      { subtotal: 2.375, discount: 0, tax: 0 },
      { subtotal: 2.375, discount: 0, tax: 0 }
    ]
  ).map(value => value.total)).toEqual([238, 237]);
});

it('caps allocated discount cents at each allocated seat subtotal', () => {
  expect(allocateCents(3, [1.5, 1.5], [2, 1])).toEqual([2, 1]);
});

it('rejects malformed or non-footing persisted allocations', () => {
  expect(() => validateSplitMoneyCents({ subtotal: 204, discount: 0, tax: 33, total: 238 }))
    .toThrow(/foot/i);
  expect(() => validateSplitMoneyCents({ subtotal: 204.5, discount: 0, tax: 33, total: 237 }))
    .toThrow(/integer/i);
});
```

- [ ] **Step 2: Run the new unit file and verify RED**

Run:

```bash
npx vitest run backend/tests/unit/splitMoneyAllocator.test.js
```

Expected: FAIL because `SplitMoneyAllocator` does not exist.

- [ ] **Step 3: Implement the minimum pure allocator**

Use integer targets, non-negative raw weights, optional integer capacities, and stable input order for equal remainders:

```js
const moneyToCents = value => Math.round((Number(value) + Number.EPSILON) * 100);

function allocateCents(targetCents, weights, capacities = null) {
  if (!Number.isSafeInteger(targetCents) || targetCents < 0 || !Array.isArray(weights) || !weights.length) {
    throw new Error('Invalid cent allocation input.');
  }
  const safeWeights = weights.map(value => Math.max(0, Number(value) || 0));
  const totalWeight = safeWeights.reduce((sum, value) => sum + value, 0);
  if (targetCents === 0) return safeWeights.map(() => 0);
  if (totalWeight <= 0) throw new Error('Cent allocation has no positive weight.');

  const raw = safeWeights.map(value => targetCents * value / totalWeight);
  const result = raw.map((value, index) => Math.min(
    Math.floor(value),
    capacities ? capacities[index] : Number.MAX_SAFE_INTEGER
  ));
  let remaining = targetCents - result.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);

  let cursor = 0;
  let skipped = 0;
  while (remaining > 0) {
    const candidate = order[cursor % order.length];
    cursor += 1;
    if (capacities && result[candidate.index] >= capacities[candidate.index]) {
      skipped += 1;
      if (skipped >= order.length) throw new Error('Cent allocation exceeds capacity.');
      continue;
    }
    result[candidate.index] += 1;
    remaining -= 1;
    skipped = 0;
  }
  return result;
}
```

`allocateSplitMoneyCents` must:

1. Convert parent subtotal, tax, and total to cents.
2. Derive the actual parent discount as `subtotal + tax - total`.
3. Allocate subtotal using raw seat subtotals.
4. Allocate discount using raw seat discounts with allocated subtotals as capacities.
5. Allocate tax using raw seat taxes.
6. Derive each seat total as `subtotal - discount + tax` rather than allocating total independently.
7. Assert every component sum equals the parent component.

- [ ] **Step 4: Add a seeded conservation test**

Run at least 5,000 deterministic partitions covering 2–8 seats, zero tax, 8%/16% tax, fixed/percent discount weights, and targets from JOD 0.01 through JOD 100,000. Assert safe integers, non-negative money, per-seat footing, component conservation, and repeat-call equality.

- [ ] **Step 5: Run tests and commit**

```bash
npx vitest run backend/tests/unit/splitMoneyAllocator.test.js
git add backend/services/SplitMoneyAllocator.js backend/tests/unit/splitMoneyAllocator.test.js
git commit -m "feat(pos): add deterministic split money allocation"
```

Expected: all allocator tests PASS.

---

### Task 2: Reconcile, allocate, and persist authoritative cents during split creation

**Files:**

- Modify: `backend/modules/tables/splitChecks.js:388-490`
- Test: `backend/tests/integration/tables.test.js`

**Interfaces:**

- Consumes: `allocateSplitMoneyCents(parentTotals, seatTotals)` from Task 1.
- Produces: `cart_data.split_money_cents` on every newly created held split.

- [ ] **Step 1: Write failing integration tests for upward and downward residue**

Create one tax-exclusive parent whose two raw halves independently total JOD 4.74 and one tax-inclusive JOD 4.75 parent whose two raw halves independently total JOD 4.76. For both cases:

```js
const [held] = await pool.query(
  'SELECT subtotal, cart_data FROM held_orders WHERE reference_name LIKE ? ORDER BY id',
  ['Table 1 - Cent Seat %']
);
const allocations = held.map(row => JSON.parse(row.cart_data).split_money_cents);

expect(allocations.map(value => value.total)).toEqual([238, 237]);
expect(allocations.reduce((sum, value) => sum + value.total, 0)).toBe(475);
expect(allocations.reduce((sum, value) => sum + value.subtotal, 0)).toBe(parentSubtotalCents);
expect(allocations.reduce((sum, value) => sum + value.tax, 0)).toBe(parentTaxCents);
expect(held.map(row => Math.round(Number(row.subtotal) * 100))).toEqual([238, 237]);
```

Add three-way and four-way cases, a fixed order discount case, a percent order discount case, and a service-charge case. Assert empty submitted seats are rejected and empty client seats omitted before submission never receive allocations.

- [ ] **Step 2: Run the focused integration case and verify RED**

```bash
npx vitest run backend/tests/integration/tables.test.js -t "conserves parent cents"
```

Expected: FAIL because held payloads lack `split_money_cents` and each held amount is independently rounded.

- [ ] **Step 3: Derive child discount rules from the parent**

After price/tax pinning and service-charge insertion, calculate every seat's undiscounted subtotal. Derive discount metadata from `parentOrder.discount_type` and `parentOrder.discount_value`, never from `seat.order_discount`:

```js
const parentDiscountType = parentOrder.discount_type || null;
const parentDiscountValue = Number(parentOrder.discount_value) || 0;
const rawSeatSubtotals = normalizedSplits.map(({ normalizedItems }) =>
  calculateExpectedTotals({}, normalizedItems, splitProductMap, !!parentTaxInclusive, {
    taxRateOverrides: splitTaxRateOverrides,
    taxRegistrationType: parentTaxRegistrationType
  }).subtotal
);
const parentSubtotalCents = moneyToCents(parentOrder.subtotal);
let parentDiscountCents = 0;
if (parentDiscountType === 'fixed') {
  parentDiscountCents = Math.min(parentSubtotalCents, moneyToCents(parentDiscountValue));
} else if (parentDiscountType === 'percent') {
  parentDiscountCents = moneyToCents(
    (parentSubtotalCents / 100) * (Math.min(100, parentDiscountValue) / 100)
  );
}
const allocatedSeatSubtotalCents = allocateCents(parentSubtotalCents, rawSeatSubtotals);
const fixedDiscountCents = allocateCents(
  parentDiscountCents,
  rawSeatSubtotals,
  allocatedSeatSubtotalCents
);
const serverSeatDiscounts = rawSeatSubtotals.map((_, index) => {
  if (!parentDiscountType || parentDiscountCents === 0) return null;
  if (parentDiscountType === 'percent') {
    return { type: 'percent', value: Math.min(100, parentDiscountValue) };
  }
  return { type: 'fixed', value: fixedDiscountCents[index] / 100 };
});
```

For a percent parent, retain the authorized percent as child metadata; the persisted `split_money_cents.discount` remains the authoritative monetary amount. For a fixed parent, persist each server-allocated fixed child amount.

- [ ] **Step 4: Collect server seat totals once**

In the existing loop that calls `calculateExpectedTotals`, use `serverSeatDiscounts[index]` and retain each result:

```js
const serverSeatTotals = [];
// existing validation loop
serverSeatTotals.push({
  subtotal: seatTotals.subtotal,
  discount: seatTotals.discount,
  tax: seatTotals.tax,
  total: seatTotals.total
});
```

Do not trust or allocate from `seat.subtotal`; keep it only as the existing stale-client validation hint. Remove the later `serverSeatNetSum`/`assertNearMoney` aggregate check: independent seat rounding is the bug being removed, and exact component conservation from `allocateSplitMoneyCents` replaces that check. Quantity conservation, frozen price/tax validation, per-seat stale-client validation, and exact allocated component sums remain the security boundary.

- [ ] **Step 5: Reconcile a verified one-cent parent residue and allocate**

Derive the actual discount cents from the locked parent's authorized `discount_type`/`discount_value`, then calculate `canonicalParentTaxCents = totalCents - subtotalCents + discountCents`. Require it to be non-negative and within one cent of the stored parent tax; otherwise return 400 and roll back without releasing the table. This split-boundary reconciliation is intentionally local: do not change `calculateExpectedTotals`, table save, ordinary checkout, or frontend totals.

Before voiding the parent, call:

```js
const splitMoneyCents = allocateSplitMoneyCents({
  subtotal: Number(parentOrder.subtotal),
  tax: canonicalParentTaxCents / 100,
  total: Number(parentOrder.total)
}, serverSeatTotals);
```

Assert allocation length equals `normalizedSplits.length` before any write.

- [ ] **Step 6: Persist the server allocation and discount metadata**

Add to `cartPayload`:

```js
split_money_cents: splitMoneyCents[splitIndex],
order_discount: serverSeatDiscounts[splitIndex],
```

Store the held row's existing `subtotal` column as the payable child total:

```js
const heldPayable = splitMoneyCents[splitIndex].total / 100;
```

Replace the existing `order_discount: seat.order_discount || null`; do not retain both. Do not accept any client-supplied `split_money_cents` and do not echo it from the request.

- [ ] **Step 7: Prove forged child discount metadata is not authoritative**

Add one integration request that submits a different `seat.order_discount` from the parent. Assert the persisted child metadata still comes from the parent and all allocated components still conserve the parent. If the forged metadata also makes the submitted `seat.subtotal` stale, the existing per-seat validation may reject the request instead; both outcomes are acceptable only if no forged rule is persisted.

- [ ] **Step 8: Run tests and commit**

```bash
npx vitest run backend/tests/unit/splitMoneyAllocator.test.js backend/tests/integration/tables.test.js -t "split|cent"
git add backend/modules/tables/splitChecks.js backend/tests/integration/tables.test.js
git commit -m "fix(pos): conserve parent cents when creating splits"
```

Expected: allocation and existing split-creation cases PASS.

---

### Task 3: Make held previews and receipts read trusted allocations

**Files:**

- Modify: `backend/services/ReceiptPresentation.js:57-108`
- Modify: `backend/services/ReceiptPresentationSources.js:243-345`
- Modify: `src/utils/receiptPresentation.js`
- Test: `backend/tests/unit/receiptPresentation.test.js`
- Test: `backend/tests/integration/tables.test.js`

**Interfaces:**

- Consumes: `validateSplitMoneyCents` from Task 1.
- Produces: held `receipt_display_v1.summary` matching `split_money_cents` exactly.
- Produces: an opt-in `subtotalAllocationToleranceCents: 1` receipt-builder input used only for trusted allocated split rows.

- [ ] **Step 1: Write failing receipt tests**

```js
it('apportions one trusted split cent into receipt rows', () => {
  const model = buildReceiptPresentation({
    taxMode: 'exclusive',
    status: 'original',
    summary: { subtotal: 2.04, tax: 0.33, total: 2.37 },
    orderDiscount: { type: null, value: 0, amount: 0 },
    subtotalAllocationToleranceCents: 1,
    items: [{ key: 'half', name: 'Item', qty: 0.5, price: 4.094968 }]
  });
  expect(model.rows[0].netAmount).toBe(2.04);
  expect(model.summary.total).toBe(2.37);
});

it('still rejects an ordinary one-cent subtotal mismatch', () => {
  expect(() => buildReceiptPresentation({
    taxMode: 'exclusive', status: 'original',
    summary: { subtotal: 2.04, tax: 0.33, total: 2.37 },
    orderDiscount: { type: null, value: 0, amount: 0 },
    items: [{ key: 'half', name: 'Item', qty: 0.5, price: 4.094968 }]
  })).toThrow(/subtotal/i);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run backend/tests/unit/receiptPresentation.test.js
```

Expected: trusted allocation case FAILS with `subtotal does not match receipt rows`.

- [ ] **Step 3: Add an explicit bounded receipt opt-in**

Change `apportionRows` in both backend and frontend receipt builders to accept a maximum raw-subtotal delta, defaulting to zero:

```js
function apportionRows(rows, subtotal, toleranceCents = 0) {
  const rawDelta = cents(subtotal) - cents(rawTotal);
  if (Math.abs(rawDelta) > toleranceCents) fail('subtotal does not match receipt rows');
  // existing stable row-cent apportionment continues
}
```

Do not relax the default behavior.

- [ ] **Step 4: Use persisted allocation for held splits**

In `heldPresentationInput`, only when `split === true` and `parsed.split_money_cents` exists:

```js
const allocated = validateSplitMoneyCents(parsed.split_money_cents);
summary: {
  subtotal: allocated.subtotal / 100,
  tax: allocated.tax / 100,
  total: allocated.total / 100
},
orderDiscount: {
  type: disc.type || null,
  value: Number(disc.value) || 0,
  amount: allocated.discount / 100
},
subtotalAllocationToleranceCents: 1
```

Missing allocation keeps the legacy calculation. Present-but-invalid allocation produces the existing isolated `RECEIPT_PRESENTATION_INVALID` result for that held row; it must never silently fall back.

- [ ] **Step 5: Make finalized child receipts use actual stored discount money**

In `orderPresentationInput`, for `order.parent_invoice_id != null`, derive:

```js
orderDiscountAmount = roundMoney(
  Math.max(0, Number(order.subtotal) + Number(order.tax) - Number(order.total))
);
```

Pass `subtotalAllocationToleranceCents: 1` only for those child orders. Ordinary orders keep the rule-derived discount and strict row/subtotal match.

- [ ] **Step 6: Verify held list and print presentation**

Extend the table integration test to assert:

```js
expect(seat.receipt_display_v1.summary).toMatchObject({
  subtotal: 2.04,
  taxAmount: 0.33,
  total: 2.37
});
expect(seat.receipt_display_v1.rows.reduce((sum, row) => sum + Math.round(row.netAmount * 100), 0)).toBe(204);
```

`TableSplits.vue` already prints `receipt_display_v1`; no component change is required.

- [ ] **Step 7: Run tests and commit**

```bash
npx vitest run backend/tests/unit/receiptPresentation.test.js backend/tests/integration/tables.test.js -t "receipt|cent|split"
git add backend/services/ReceiptPresentation.js backend/services/ReceiptPresentationSources.js src/utils/receiptPresentation.js backend/tests/unit/receiptPresentation.test.js backend/tests/integration/tables.test.js
git commit -m "fix(pos): present allocated split cents consistently"
```

---

### Task 4: Settle and persist the allocated child money exactly

**Files:**

- Modify: `backend/modules/checkout/executeCheckout.js:216-286, 851-937, 1100-1135`
- Test: `backend/tests/integration/checkout.test.js`
- Test: `backend/tests/integration/tables.test.js`

**Interfaces:**

- Consumes: `validateSplitMoneyCents`, `allocateCents`, and `moneyToCents` from Task 1.
- Produces: finalized child `orders.subtotal`, `orders.tax`, and `orders.total` equal persisted split allocation.
- Produces: top-level `order_items.tax_amount` cents summing exactly to the child `orders.tax`.

- [ ] **Step 1: Write failing settlement tests**

Pay both held halves created in Task 2 and assert:

```js
expect(childTotals).toEqual([238, 237]);
expect(childTotals.reduce((sum, cents) => sum + cents, 0)).toBe(475);
expect(childSubtotals.reduce((sum, cents) => sum + cents, 0)).toBe(parentSubtotalCents);
expect(childTaxes.reduce((sum, cents) => sum + cents, 0)).toBe(parentTaxCents);

for (const child of children) {
  const [[taxSum]] = await pool.query(
    'SELECT ROUND(SUM(tax_amount) * 100) AS cents FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
    [child.invoice_id]
  );
  expect(Number(taxSum.cents)).toBe(Math.round(Number(child.tax) * 100));
}
```

Also add:

- A malformed allocation test returning 409 without deleting the held row.
- A valid client payload one cent away from the allocation returning 400/409 without settlement.
- A legacy held split without allocation that still follows existing behavior.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js -t "allocated split|legacy split"
```

Expected: new children settle at independently calculated totals or malformed allocation is ignored.

- [ ] **Step 3: Validate allocation immediately after authenticating the held row**

```js
let trustedSplitMoney = null;
if (Object.hasOwn(splitHeldPayload, 'split_money_cents')) {
  try {
    trustedSplitMoney = validateSplitMoneyCents(splitHeldPayload.split_money_cents);
  } catch (_) {
    const error = new Error('Conflict: Split money allocation is invalid.');
    error.statusCode = 409;
    throw error;
  }
}
```

Do not accept an allocation from the checkout request.

- [ ] **Step 4: Override only new split expected totals**

Keep `calculateExpectedTotals` as the independent safety calculation, then construct:

```js
const calculatedTotals = calculateExpectedTotals(/* existing arguments */);
const expectedTotals = trustedSplitMoney ? {
  ...calculatedTotals,
  subtotal: trustedSplitMoney.subtotal / 100,
  discount: trustedSplitMoney.discount / 100,
  tax: trustedSplitMoney.tax / 100,
  total: trustedSplitMoney.total / 100
} : calculatedTotals;
```

Before using the override, require every allocated component to be within one cent of the independently calculated child component. This detects corrupt server state without reintroducing independent settlement rounding.

- [ ] **Step 5: Require exact client cents for allocated splits**

For `trustedSplitMoney`, compare `moneyToCents(data.subtotal)` and `moneyToCents(data.total)` to the stored integers. Otherwise keep the existing `assertNearMoney` calls for normal and legacy checkout.

- [ ] **Step 6: Allocate stored line tax to the child tax target**

Before inserting `order_items`, calculate every top-level line's raw `stampLineTax`, then:

```js
const splitLineTaxCents = trustedSplitMoney
  ? allocateCents(trustedSplitMoney.tax, rawLineTaxes)
  : null;
```

Use `splitLineTaxCents[index] / 100` instead of the raw stamped value only for allocated splits. Bundle children remain non-financial. This keeps refunds, product/category reporting, and JoFotara aligned with the child order tax header.

- [ ] **Step 7: Run tests and commit**

```bash
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js -t "allocated split|legacy split|split settle"
git add backend/modules/checkout/executeCheckout.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js
git commit -m "fix(pos): settle split children from trusted cents"
```

---

### Task 5: Show the allocated amounts before and during payment

**Files:**

- Modify: `src/pos/stores/orderSession/splitChecks.js`
- Modify: `src/pos/stores/orderSessionStore.js:212-244, 1444-1482, 1645-1720`
- Modify: `src/pos/useTables.js`
- Modify: `src/components/pos/SplitCheckModal.vue:90-160, 192-235`
- Test: `backend/tests/unit/splitChecks.test.js`
- Test: `backend/tests/unit/orderSessionStore.test.js`
- Test: `src/components/pos/__tests__/splitCheckModal.spec.js`

**Interfaces:**

- Produces: `buildSplitPreview({ seats, unassignedItems, parentTotals, orderDiscount, serviceChargeSnapshot, serviceChargeLine, taxInclusive })`.
- Produces: `getSplitItemTotal(bucketId, index)` alongside existing `getSeatTotal(seat)`.
- Consumes: persisted `split_money_cents` when restoring a held split.

- [ ] **Step 1: Write failing frontend allocation tests**

```js
it('previews 4.75 halves as complementary cents', () => {
  const preview = buildSplitPreview({
    seats: [
      { id: 1, items: [{ price: 4.75, qty: 0.5, tax_rate: 16 }] },
      { id: 2, items: [{ price: 4.75, qty: 0.5, tax_rate: 16 }] }
    ],
    unassignedItems: [],
    parentTotals: { subtotal: 4.75, discount: 0, tax: 0, total: 4.75 },
    orderDiscount: null,
    taxInclusive: true
  });
  expect(preview.buckets.map(bucket => bucket.totalCents)).toEqual([238, 237]);
  expect(preview.buckets.map(bucket => bucket.itemTotalCents[0])).toEqual([238, 237]);
});
```

Add a test where both fractional pieces remain unassigned; the pseudo-bucket must display `2.38` and `2.37` while preserving JOD 4.75. Add service-charge, fixed discount, and empty-seat tests.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run backend/tests/unit/splitChecks.test.js backend/tests/unit/orderSessionStore.test.js src/components/pos/__tests__/splitCheckModal.spec.js
```

Expected: FAIL because preview allocation and allocated item access do not exist.

- [ ] **Step 3: Implement the frontend mirror in the existing split module**

Keep the mirror inside `src/pos/stores/orderSession/splitChecks.js`; do not create another frontend file. Reuse the existing service-charge and order-discount distribution already used by `buildSplitRequest`.

The preview must:

1. Treat unassigned items as one temporary bucket so fractional pieces already show complementary cents.
2. Omit empty buckets from allocation.
3. Allocate parent subtotal, discount, and tax with the same stable largest-remainder rules as the backend.
4. Derive each bucket total from its allocated components.
5. Allocate each bucket's total across its item rows for display, using stable row order.
6. Return zero/empty values safely while the modal is initializing.

`buildSplitRequest` must reuse this preview calculation when `unassignedItems` is empty and submit each allocated payable total in the legacy `seat.subtotal` hint. It must never send `split_money_cents`; only the server may author that field.

- [ ] **Step 4: Wire reactive modal totals**

Create one computed preview in `orderSessionStore.js`; do not cache allocation in UI state. Change:

```js
const getSeatTotal = seat => moneyFromCents(splitPreview.value.byId.get(seat.id)?.totalCents || 0);
const getSplitItemTotal = (bucketId, index) => moneyFromCents(
  splitPreview.value.byId.get(bucketId)?.itemTotalCents[index] || 0
);
```

Use `bucketId = 'unassigned'` for the source pane and the numeric seat ID for a destination pane. Preserve the existing original-price text.

- [ ] **Step 5: Restore and use persisted allocation during checkout**

When `restoreTableSplit` parses `cart_data`, copy the validated shape to:

```js
splitTable.split_money_cents = parsed.split_money_cents || null;
```

In the central `totals` computed, override `subtotal`, `discount`, `discountedSubtotal`, `tax`, and `total` only when `activeTable.is_split` has a valid allocation. This automatically aligns checkout display, tender defaults, payment validation, request totals, and client receipt input without touching each consumer.

Present-but-invalid allocation must block restoration with a user-visible conflict; missing allocation remains legacy-compatible.

- [ ] **Step 6: Update the modal rendering**

Replace raw fractional display calls with allocated preview calls:

```vue
<!-- unassigned -->
<span>{{ getSplitItemTotal('unassigned', index) }}</span>

<!-- active seat -->
<span>{{ getSplitItemTotal(activeSeat.id, index) }}</span>
```

Keep all tax-inclusive wording, original price copy, responsive layout, and preset controls unchanged.

- [ ] **Step 7: Run tests and commit**

```bash
npx vitest run backend/tests/unit/splitChecks.test.js backend/tests/unit/orderSessionStore.test.js src/components/pos/__tests__/splitCheckModal.spec.js
npm run build
git add src/pos/stores/orderSession/splitChecks.js src/pos/stores/orderSessionStore.js src/pos/useTables.js src/components/pos/SplitCheckModal.vue src/components/pos/__tests__/splitCheckModal.spec.js backend/tests/unit/splitChecks.test.js backend/tests/unit/orderSessionStore.test.js
git commit -m "fix(pos): preview and restore allocated split cents"
```

---

### Task 6: Preserve split-child refund components and prove downstream compatibility

**Files:**

- Modify: `backend/services/RefundService.js:156-225`
- Modify: `backend/services/JofotaraXmlBuilder.js:58-330`
- Test: `backend/tests/integration/refunds.test.js`
- Test: `backend/tests/unit/jofotaraXmlBuilder.test.js`
- Test: `backend/tests/integration/tables.test.js`

**Interfaces:**

- Consumes: finalized allocated child order headers and allocated `order_items.tax_amount`.
- Produces: full split-child refunds whose subtotal, tax, and total match the finalized child exactly.

- [ ] **Step 1: Write a failing full-refund test**

For the JOD 2.04 subtotal + JOD 0.33 tax = JOD 2.37 child:

```js
expect(refund.subtotal_refunded).toBe('2.04');
expect(refund.tax_refunded).toBe('0.33');
expect(refund.amount_refunded).toBe('2.37');
expect(refundItems.reduce((sum, row) => sum + Math.round(Number(row.line_total) * 100), 0)).toBe(237);
```

Assert the sibling full refund is JOD 2.38 and both refunds total JOD 4.75.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run backend/tests/integration/refunds.test.js -t "allocated split child"
```

Expected: the independent discount/subtotal derivation moves a cent between refunded subtotal and tax, or the new test otherwise demonstrates the current behavior precisely.

- [ ] **Step 3: Use stored child components for split-child discounted subtotal**

For orders with `parent_invoice_id != null`, derive:

```js
discountedSubtotal = roundMoney(Math.max(0, Number(order.total) - Number(order.tax)));
```

Ordinary orders keep the existing discount-rule calculation. Continue using the existing integer-cent row apportionment and total clamps.

- [ ] **Step 4: Reconcile JoFotara split-child snapshots at the legal-document boundary**

Build sales- and income-tax snapshots for allocated 2.37/2.38 children. Assert each snapshot payable equals the child order total, saved sales-tax components foot, every legal line equation stays within JoFotara's 0.001 tolerance, and XML rendering succeeds. The regression disproved the original assumption: the sales builder moved the residue into tax and the income builder rejected the upward half-cent. Reconcile only split-child snapshots against their saved headers, keeping all ordinary invoice behavior unchanged. Emit monetary values and quantities at six decimal places, which is within the official JoFotara allowance of up to nine decimal places and preserves fractional split quantities.

- [ ] **Step 5: Add report reconciliation coverage without production changes**

Extend the split integration scenario to query the existing sales summary and product/category report builders after both children settle. Assert the order-header sales total and rounded product sales both equal JOD 4.75. Do not modify report SQL unless this exact regression fails; if it fails, stop and design a separate report-allocation plan rather than expanding this implementation silently.

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run backend/tests/integration/refunds.test.js backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/integration/tables.test.js -t "allocated split|cent conservation"
git add backend/services/RefundService.js backend/services/JofotaraXmlBuilder.js backend/tests/integration/refunds.test.js backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/integration/tables.test.js docs/superpowers/plans/2026-07-23-split-check-cent-allocation.md
git commit -m "fix(pos): preserve allocated split refunds"
```

---

### Task 7: Run the real 4.75 cashier workflow and final focused verification

**Files:**

- Modify: `tests/e2e/specs/admin.split-check.spec.js`
- Modify: `src/pos/stores/orderSessionStore.js`
- Test: `backend/tests/unit/orderSessionStore.test.js`
- Test: `backend/tests/integration/tables.test.js`

**Interfaces:**

- Verifies the complete user-visible lifecycle; produces no production API.
- Covers the processed Table Splits board shape, whose trusted allocation remains inside `cart_data` even when parsed `items` are also present.

- [ ] **Step 1: Add a tax-inclusive JOD 4.75 E2E fixture**

Use the test database directly, following existing E2E conventions:

```js
import pool from '../../../backend/config/db.js';

await pool.query('UPDATE products SET price=4.75, tax_rate=16 WHERE id=?', [SEED.product1.id]);
await pool.query(
  "UPDATE settings SET setting_value='1' WHERE setting_key='tax_inclusive_pricing'"
);
```

The existing `seedDatabase()` before each test provides cleanup.

- [ ] **Step 2: Assert the modal shows complementary item and seat cents**

After pressing `1/2` and assigning one half to each seat:

```js
await expect(dialog.locator('.split-seat-option')).toContainText(['2.38 JD', '2.37 JD']);
await dialog.locator('.split-mobile-switch button').nth(1).click();
await expect(dialog.locator('.split-seat-pane')).toContainText(/2\.3[78] JD/);
```

Do not assume which half the user moved first beyond the stable order defined by the allocator.

- [ ] **Step 3: Finalize, restore, and settle both held children**

Assert held cards display 2.38 and 2.37, payment defaults match those totals, both checkouts succeed, and a database query proves the two finalized child totals sum to 475 cents.

- [ ] **Step 4: Run the targeted verification matrix**

```bash
npx vitest run backend/tests/unit/splitMoneyAllocator.test.js backend/tests/unit/splitChecks.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/receiptPresentation.test.js backend/tests/integration/tables.test.js backend/tests/integration/checkout.test.js backend/tests/integration/refunds.test.js backend/tests/unit/jofotaraXmlBuilder.test.js src/components/pos/__tests__/splitCheckModal.spec.js
npx playwright test tests/e2e/specs/admin.split-check.spec.js
npm run build
git diff --check
```

Expected:

- All focused tests pass.
- The real 320px-to-desktop workflow passes.
- Production build exits zero.
- No whitespace errors.

- [ ] **Step 5: Review scope and commit**

Confirm the production diff contains no schema migration, global tolerance change, product-price mutation, normal-checkout override, report rewrite, or new dependency.

```bash
git add tests/e2e/specs/admin.split-check.spec.js
git commit -m "test(pos): cover split cent conservation end to end"
```

Do not merge unless explicitly requested.

---

## Execution Prompt for the Implementing Agent

```text
You are the execution owner for a high-risk POS money correction. Work inline in this session. Read this entire plan before editing, then use the executing-plans, test-driven-development, verification-before-completion, and Ponytail skills. Do not use brainstorming and do not delegate implementation. Execute Tasks 1-7 in order. The written plan is the contract: do not skip a step, silently reinterpret an invariant, or add adjacent improvements.

PRE-FLIGHT GATE -- DO NOT EDIT UNTIL ALL ITEMS PASS

1. Confirm HEAD is on a codex/ feature branch and contains commits f60ee303 and 66bc7ae5. Never implement directly on master.
2. Record `git status --short`, `git diff --stat`, and `git log --oneline -5`. Existing unrelated changes and untracked files belong to the user: do not stage, edit, delete, format, or commit them.
3. Read every production file and relevant test named in the current task. Trace the real path from split creation -> held cart_data -> held presentation/print -> restore -> checkout -> order/order_items persistence -> receipt/refund/JoFotara/reports before making the first production edit.
4. Verify the exact functions and data shapes named by the plan still exist. If the code has materially diverged, stop before editing and report the mismatch. Do not improvise a replacement architecture.
5. Run the narrow existing baseline tests for the current task. If they already fail for an unrelated reason, record the failure and stop; do not bury it beneath this change.

NON-NEGOTIABLE MONEY INVARIANTS

- The locked parent orders row and its authorized discount rule are the only monetary authority for allocation targets.
- For each new non-empty child: subtotal_cents - discount_cents + tax_cents === total_cents.
- Across all new children, subtotal, authorized discount, reconciled tax, and total each sum exactly to the accepted parent targets. Stored parent tax may differ by one cent only when the existing independently rounded header does not foot; larger differences fail closed.
- Stable active-seat order breaks equal remainders. Identical input must produce identical cents.
- `split_money_cents` is authored and validated only by the backend. Client values are stale-state hints, never authority.
- Stored top-level order_items.tax_amount cents sum exactly to the finalized child order tax. Bundle children stay non-financial.
- The same allocated cents must appear in the modal, held card, held print, restored checkout, payment request, finalized order header, receipt, and full refund.
- Missing `split_money_cents` means legacy fallback. Present-but-invalid allocation fails closed without deleting or settling the held row.
- Empty seats receive no allocation and create no held order.

STRICT SCOPE ALLOWLIST

Production files may change only when their assigned task requires them:

- backend/services/SplitMoneyAllocator.js (the sole new production file)
- backend/modules/tables/splitChecks.js
- backend/modules/checkout/executeCheckout.js
- backend/services/ReceiptPresentation.js
- backend/services/ReceiptPresentationSources.js
- backend/services/RefundService.js
- src/pos/stores/orderSession/splitChecks.js
- src/pos/stores/orderSessionStore.js
- src/pos/useTables.js
- src/components/pos/SplitCheckModal.vue
- src/utils/receiptPresentation.js

Tests may change only in the paths explicitly listed by Tasks 1-7. The plan document may receive progress and explicitly approved scope corrections. Do not modify routes, controllers, schemas, migrations, package manifests, lockfiles, report production code, global money helpers, global CheckoutValidation tolerance, unrelated UI, or configuration. The only JoFotara production exception is the Task 6 split-child reconciliation and six-decimal XML formatting in `backend/services/JofotaraXmlBuilder.js`. Add no dependency. Create no frontend helper/module, generic money framework, DTO layer, repository, controller, adapter, factory, or abstraction for hypothetical reuse.

The only permitted persistence addition is `cart_data.split_money_cents`. Do not alter product price, quantity, tax rate, discount metadata, service charge, or introduce a fake adjustment/discount/fee/product line to absorb a cent. Do not migrate the whole application to cents. Do not refactor neighboring code merely because it looks untidy.

TASK EXECUTION LOOP -- REPEAT FOR EVERY TASK

1. Re-read that task's Files, Interfaces, and steps.
2. Write only the specified failing tests. Run the exact focused command and prove RED for the intended missing behavior, not a syntax, fixture, import, or environment failure.
3. Implement the smallest root-cause change that satisfies the task and the invariants. Reuse existing calculation and presentation paths where the plan requires them.
4. Run the task's focused tests and inspect actual values, not only exit status.
5. Manually inspect the affected boundary: allocation arrays and sums, persisted cart_data, receipt source, restored totals, checkout validation, database headers/line tax, or refund components as appropriate.
6. Run `git diff --check` and inspect `git diff -- <task files>`. Search for all callers of every changed export and all readers of `split_money_cents` before accepting the task.
7. Compare `git status --short` with the pre-flight snapshot. Stage only that task's allowlisted files using explicit paths, review `git diff --cached`, and commit with the plan's message. Never use `git add .` or `git add -A`.
8. If any invariant fails, fix it inside the current task before continuing. Do not postpone correctness to a later task unless the plan explicitly assigns it there.

SPECIAL IMPLEMENTATION BOUNDARIES

- Use exactly one pure backend allocation service. Keep it integer-only at its public boundary, deterministic, dependency-free, and unaware of Express, MySQL, Vue, or receipts.
- Keep the frontend preview mirror inside existing `src/pos/stores/orderSession/splitChecks.js`. It is preview-only; never send `split_money_cents` from the client.
- Derive the parent's actual discount cents from locked subtotal + tax - total. Percent metadata may describe the authorized rule; fixed child money is server-allocated. Never trust `seat.order_discount`.
- Allocate child total by `subtotal - discount + tax`; do not independently allocate total and create a second rounding authority.
- Preserve strict receipt reconciliation globally. Permit the one-cent row/subtotal reconciliation only behind an explicit trusted-split flag sourced from validated server allocation.
- Preserve the independent checkout calculation as a corruption/staleness guard, but do not let its independent rounding overwrite trusted allocated cents.
- Do not weaken assertions or widen tolerances to make tests pass.

STOP CONDITIONS -- REPORT INSTEAD OF EXPANDING SCOPE

Stop immediately and report the exact file, value, and violated invariant if:

- parent monetary components cannot be derived unambiguously from the locked order;
- implementing a task requires a production file outside the allowlist;
- a schema/package/global helper/tolerance/report/JoFotara production change appears necessary;
- normal register, ordinary saved-table checkout, or legacy split behavior changes;
- the frontend mirror cannot match the backend named cases deterministically;
- a report or JoFotara regression fails and correcting it requires shared production behavior changes;
- an unrelated baseline failure prevents proving RED/GREEN;
- user-owned changes overlap a required hunk and cannot be preserved safely.

Do not bypass a stop condition, weaken a test, or label a mismatch "close enough." Update the plan only with explicit user approval if its architecture must change.

FINAL ATTACK AND VERIFICATION GATE

After Task 7, do not claim completion from unit tests alone:

1. Run the exact targeted Vitest matrix in Task 7, the Playwright split workflow, `npm run build`, and `git diff --check`. Do not run an unrelated full repository suite unless a focused failure proves it necessary.
2. Exercise the real JOD 4.75 case at 320px and desktop: complementary 2.38/2.37 display, held persistence, restore, settlement, finalized headers, SUM(top-level line tax), receipt, and full refunds must conserve 4.75.
3. Exercise downward and upward rounding, 2/3/4 seats, tax-inclusive and tax-exclusive pricing, fixed and percent discounts, service charge, empty seats, malformed allocation, forged client hints, and a legacy held split.
4. Inspect the complete branch diff from its merge-base. Confirm every production file is allowlisted, no dependency/schema/global/report/JoFotara production change exists, no duplicated allocator module was introduced, and unrelated user files remain untouched.
5. Search for stale raw split-total rendering and every `split_money_cents` reader/writer. Confirm there is one backend writer and all readers validate or consume the trusted shape as planned.
6. Report exact commands, pass/fail counts, commits, changed production files, manually inspected boundaries, and any remaining legacy limitation. Be truthful about anything not exercised.

Completion means all specified invariants are proven across the full split lifecycle with the smallest scoped diff. Do not merge, rebase, push, delete branches, or touch unrelated work unless the user explicitly asks after reviewing the result.
```

## Plan Attack Checklist

- [ ] The parent targets come from the locked `orders` row, never from the request; a one-cent non-footing tax residue is reconciled locally and anything larger fails closed.
- [ ] Empty seats cannot receive cents or persist held rows.
- [ ] Equal remainders use stable active-seat order.
- [ ] Child discount rules are derived from the locked parent, never authorized by the request.
- [ ] Discount allocation cannot exceed a seat's allocated subtotal.
- [ ] Every seat feet exactly and every component sums exactly to the parent.
- [ ] `held_orders.subtotal` means payable total for new allocated splits.
- [ ] Held cards, held printing, restore, checkout, finalized receipt, refund, JoFotara, and reports are covered.
- [ ] Stored top-level line tax sums to the allocated child tax.
- [ ] The modal shows complementary cents both while pieces are unassigned and after assignment.
- [ ] New split checkout uses exact cents; legacy split checkout keeps its fallback.
- [ ] Present-but-invalid allocation fails closed.
- [ ] Normal checkout and global receipt strictness remain unchanged.
- [ ] No migration, dependency, fake monetary line, or unrelated refactor is introduced.

## Self-Review Result

- Spec coverage: all saved-decision requirements are mapped to Tasks 1–7.
- Scope coverage: the plan includes the two downstream paths the decision note understated—receipt row apportionment and full-refund component preservation—without broadening normal checkout.
- Placeholder scan: no TBD/TODO or unspecified production error handling remains.
- Interface consistency: `allocateCents`, `allocateSplitMoneyCents`, `validateSplitMoneyCents`, `split_money_cents`, `buildSplitPreview`, and `getSplitItemTotal` retain the same names and shapes throughout.
- Migration decision: confirmed unnecessary because held allocations live in `cart_data`, while finalized child headers retain allocated subtotal/tax/total and `parent_invoice_id` identifies their lifecycle.
