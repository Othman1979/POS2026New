# Receipt and Display Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live cart rows, guest checks, held orders, split checks, paid receipts, duplicate copies, database reprints, admin documents, and physical spooler output render one truthful, footed, two-decimal receipt presentation without changing ordinary POS money formulas.

**Architecture:** Four small runtime modules cover the boundary: one pure backend builder, one matching frontend builder, one backend source adapter, and one self-contained spooler renderer. Shared fixtures/parity tests lock the builders together; existing routes and components call them directly. There is no receipt engine, persistence layer, registry, or generic rendering framework.

**Tech Stack:** Node.js/CommonJS, Vue 3, Pinia, Vite, Express, MySQL/InnoDB, Vitest, local Chromium/ESC-POS spooler.

## Global Constraints

- Execute on a new isolated branch/worktree; do not implement on `master`.
- Commit each numbered task separately with the exact commit message shown.
- Do not change ordinary checkout, table, split, service-charge, refund, or tax formulas.
- Approved exception: an open-table/split lifecycle keeps its server-frozen tax mode and each existing line's persisted `order_items.tax_rate` if settings or catalog rates change before settlement. A line added later adopts the then-current rate once.
- Ordinary register holds remain provisional: preserve their server-normalized hold-time preview, then adopt current mode and current catalog rates on restore and warn if mode, rates, or the visible total changes.
- Do not trust client `receipt_display_v1`, catalog tax rates, discount amounts, or tax-mode flags on authoritative numeric-invoice, held, split, or checkout paths.
- Never mutate `orders`, `order_items`, `held_orders`, refunds, or snapshots from a presentation builder.
- Stored paid-order headers and frozen item rows remain authoritative; no display fix may rewrite historical money.
- Financial receipt rows are net after line discount and before order discount/tax. Bundle children are descriptive and non-financial. Service charge is a normal financial row.
- Show actual order-discount money plus its rule; do not render an ambiguous raw `discount` field.
- Preserve stored tax. Show an explicit rounding row instead of deriving a replacement tax or discount.
- Bound summary rounding to `±0.02`; larger residuals, negative tax/discount, and child money are invalid rather than cosmetic.
- Inclusive mode says `Included in prices`; legacy zero-tax/unknown mode says `0.00 JD`.
- All scoped currency output uses two decimals. Product cards stay tax-inclusive menu prices and receive an `incl. tax` label in exclusive mode.
- Renderers display the builder's `netAmount`/`extendedPrice` fields and never recompute money as quantity multiplied by the two-decimal displayed unit price; fractional source prices can make that visual multiplication differ by a cent.
- No two Vitest processes may run concurrently because integration suites share `posapp_test`.
- Run focused tests after each task. Run the full suite once, at the final gate, with a progress reporter; do not hardcode an exact total test count.
- The service-charge production migration remains a separate parked rollout. Do not apply either production migration during implementation-plan execution.
- Preserve all unrelated untracked owner files.

## Simplicity Budget

- Add only four runtime modules: backend presentation, frontend presentation, backend source adapters, and the self-contained spooler renderer. Migration runners/tests are not runtime architecture.
- Use plain functions and existing route/store patterns. No classes, factories, dependency-injection layer, event bus, registry, generic receipt pipeline, cache, or new persistence table.
- Add no npm/composer dependency and no schema/validation framework; the contract is small enough for the explicit validators in Task 1 and the standalone spooler artifact.
- The public API is limited to the signatures named in each task. A private helper is allowed only when it is called from at least two places or isolates a security, database, or financial-authority boundary; otherwise keep the logic local.
- The route-local object-identity tax-rate map is the one deliberate non-JSON security boundary. Do not wrap it in a service or framework.
- Delete replaced receipt arithmetic in the same task. The only parallel implementation allowed afterward is a clearly named absent-v1 legacy branch.
- Comments explain invariants or compatibility reasons, not line-by-line mechanics. Do not add an unplanned runtime file without stopping for owner review.
- Before each task commit, inspect `git diff --stat` and the new-file list; remove any abstraction not required by a named test or a later public interface.

---

## File Structure

### New runtime files (hard limit: four)

- `backend/services/ReceiptPresentation.js` — pure CommonJS backend v1 builder and validator.
- `src/utils/receiptPresentation.js` — pure ESM frontend v1 builder, validator, and legacy adapter.
- `backend/services/ReceiptPresentationSources.js` — database/held/split adapters; no rendering.
- `spooler-shared/receiptDisplayV1.cjs` — tracked self-contained v1 renderer copied beside `server.js` on each print machine.

### New tests, migration, and deployment artifacts

- `backend/tests/fixtures/receiptPresentationCases.json` — shared deterministic contract vectors.
- `backend/tests/unit/receiptPresentation.test.js` — backend builder and validator tests.
- `backend/tests/unit/receiptPresentationParity.test.js` — shared fixtures and seeded frontend/backend parity.
- `backend/tests/unit/spoolerReceiptDisplay.test.js` — tracked physical-renderer contract tests.
- `spooler-shared/pos-spooler-server-receipt-v1.patch` — reviewable shim patch applied to each ignored spooler installation during rollout.
- `backend/migrations/2026-07-11-orders-tax-mode-at-sale.sql` — additive nullable order column.
- `backend/migrations/apply-orders-tax-mode-at-sale.js` — idempotent, confirmation-gated migration runner.
- `docs/superpowers/runbooks/2026-07-11-receipt-display-rollout.md` — schema/spooler/backend/frontend rollout and rollback.

### Existing files modified

- `backend/tests/fixtures/seed.js` — test schema column.
- `backend/routes/pos/checkout.js` — frozen mode, finalized v1, duplicate v1.
- `backend/routes/pos/tables.js` — open-table mode, split inheritance, v1 APIs.
- `backend/routes/pos/orders.js` — provisional hold metadata and v1 held/history APIs.
- `backend/services/PosCalculator.js` — route-owned frozen-rate override boundary; request JSON cannot set it.
- `backend/routes/print.js` — authoritative v1 rebuild for numeric/held/split print jobs.
- `backend/routes/admin/orders.js` — return DB-authoritative v1 with order details.
- `assets/js/composables/stores/orderSessionStore.js` — effective mode, checkout v1, guest v1, hold-mode warning.
- `assets/js/composables/receiptPrint.js` — thread v1; retain legacy raw fields.
- `src/components/PosTerminal.vue` — net ordered-cart rows and labelled product-card gross price.
- `src/components/pos/ReceiptPreviewModal.vue` — v1-only arithmetic with absent-v1 adapter.
- `src/print/PrintReceiptApp.vue` — v1 receipt rendering and present-invalid fail-closed behavior.
- `src/components/OrderNotes.vue` — held/history v1 rows and summary.
- `src/components/TableSplits.vue` — split card/preview v1 rows and summary.
- `src/admin/pages/ReportsInvoices.vue` — v1 admin drawer and reprint payload.
- `src/admin/pages/Orders.vue` — pass v1 into A4/delivery documents.
- `src/admin/components/A4Receipt.vue` — two-decimal v1 rows/summary.
- `src/admin/components/DeliveryInvoice.vue` — two-decimal v1 base receipt plus separate delivery charge.
- `docs/SPOOLER-CHANGES.md` — exact print-machine integration/deployment record.
- `pos-spooler-printer/server.js` — ignored local renderer checked read-only while planning; deployment applies the tracked patch after merge.

---

## Task 1: Build and Break the Versioned Presentation Contract

**Files:**
- Create: `backend/services/ReceiptPresentation.js`
- Create: `src/utils/receiptPresentation.js`
- Create: `backend/tests/fixtures/receiptPresentationCases.json`
- Create: `backend/tests/unit/receiptPresentation.test.js`
- Create: `backend/tests/unit/receiptPresentationParity.test.js`

**Interfaces:**
- Backend produces `buildReceiptPresentation(input) -> receipt_display_v1` and `validateReceiptPresentation(model) -> true`.
- Frontend produces the same two signatures plus `legacyReceiptPresentation(payload) -> receipt_display_v1` and `resolveReceiptPresentation(payload) -> { presentation, error, idle }`.
- Input is `{ items, summary, orderDiscount, taxMode, status }`.
- `summary` is authoritative `{ subtotal, tax, total }`; `orderDiscount` is explicit `{ type, value, amount }`.
- Builders are pure, synchronous, and mutation-free.

- [x] **Step 1: Add shared red contract vectors**

Create `backend/tests/fixtures/receiptPresentationCases.json` with these cases:

```json
[
  {
    "name": "fixed line plus percentage order discount",
    "input": {
      "items": [{ "key": "a", "name": "Burger", "qty": 2, "unitPrice": 10, "discountType": "fixed", "discountValue": 2 }],
      "summary": { "subtotal": 16, "tax": 2.05, "total": 14.85 },
      "orderDiscount": { "type": "percent", "value": 20, "amount": 3.2 },
      "taxMode": "exclusive",
      "status": "original"
    },
    "expected": {
      "rowNetCents": [1600],
      "discountCents": 320,
      "taxCents": 205,
      "roundingCents": 0,
      "totalCents": 1485
    }
  },
  {
    "name": "inclusive bundle and service charge",
    "input": {
      "items": [
        { "key": "parent", "name": "Meal", "qty": 1, "unitPrice": 12, "discountType": null, "discountValue": 0 },
        { "key": "child", "kind": "bundle_child", "name": "Fries", "qty": 1, "unitPrice": 0 },
        { "key": "fee", "name": "10% Service Charge", "note": "Auto-Gratuity", "qty": 1, "unitPrice": 1.2 }
      ],
      "summary": { "subtotal": 13.2, "tax": 0, "total": 13.2 },
      "orderDiscount": { "type": null, "value": 0, "amount": 0 },
      "taxMode": "inclusive",
      "status": "original"
    },
    "expected": {
      "rowNetCents": [1200, 0, 120],
      "discountCents": 0,
      "taxCents": 0,
      "roundingCents": 0,
      "totalCents": 1320
    }
  },
  {
    "name": "header rounding residue remains explicit",
    "input": {
      "items": [{ "key": "tiny", "name": "Sample", "qty": 1, "unitPrice": 0.1 }],
      "summary": { "subtotal": 0.1, "tax": 0.02, "total": 0.11 },
      "orderDiscount": { "type": "percent", "value": 1, "amount": 0 },
      "taxMode": "exclusive",
      "status": "original"
    },
    "expected": {
      "rowNetCents": [10],
      "discountCents": 0,
      "taxCents": 2,
      "roundingCents": -1,
      "totalCents": 11
    }
  },
  {
    "name": "percentage line half-cent operation-order boundary",
    "input": {
      "items": [{ "key": "percent-boundary", "name": "Boundary", "qty": 1, "unitPrice": 21.15, "discountType": "percent", "discountValue": 10 }],
      "summary": { "subtotal": 19.04, "tax": 0, "total": 19.04 },
      "orderDiscount": { "type": null, "value": 0, "amount": 0 },
      "taxMode": "exclusive",
      "status": "original"
    },
    "expected": {
      "rowNetCents": [1904],
      "discountCents": 0,
      "taxCents": 0,
      "roundingCents": 0,
      "totalCents": 1904
    }
  }
]
```

- [x] **Step 2: Write backend contract tests before implementation**

Create `backend/tests/unit/receiptPresentation.test.js`:

```javascript
const cases = require('../fixtures/receiptPresentationCases.json');
const {
  buildReceiptPresentation,
  validateReceiptPresentation
} = require('../../services/ReceiptPresentation');

describe('ReceiptPresentation', () => {
  it.each(cases)('$name', ({ input, expected }) => {
    const frozen = structuredClone(input);
    const model = buildReceiptPresentation(input);
    expect(input).toEqual(frozen);
    expect(model.version).toBe(1);
    expect(model.rows.map(row => Math.round(row.netAmount * 100))).toEqual(expected.rowNetCents);
    expect(Math.round(model.summary.orderDiscountAmount * 100)).toBe(expected.discountCents);
    expect(Math.round(model.summary.taxAmount * 100)).toBe(expected.taxCents);
    expect(Math.round(model.summary.roundingAdjustment * 100)).toBe(expected.roundingCents);
    expect(Math.round(model.summary.total * 100)).toBe(expected.totalCents);
    expect(validateReceiptPresentation(model)).toBe(true);
  });

  it('apportions line cents to the authoritative subtotal in stable order', () => {
    const model = buildReceiptPresentation({
      items: [
        { key: 'a', name: 'A', qty: 1, unitPrice: 0.335 },
        { key: 'b', name: 'B', qty: 1, unitPrice: 0.335 },
        { key: 'c', name: 'C', qty: 1, unitPrice: 0.335 }
      ],
      summary: { subtotal: 1.01, tax: 0, total: 1.01 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    });
    expect(model.rows.map(row => row.netAmount)).toEqual([0.33, 0.34, 0.34]);
    expect(model.rows.reduce((sum, row) => sum + Math.round(row.netAmount * 100), 0)).toBe(101);
  });

  it('rejects a header subtotal that cannot come from the supplied rows', () => {
    expect(() => buildReceiptPresentation({
      items: [{ key: 'a', name: 'A', qty: 1, unitPrice: 10 }],
      summary: { subtotal: 8, tax: 0, total: 8 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    })).toThrow(/subtotal does not match receipt rows/i);
  });

  it('rejects present-but-invalid v1 instead of accepting partial money', () => {
    expect(() => validateReceiptPresentation({ version: 1, rows: [], summary: { total: 1 } }))
      .toThrow(/invalid receipt presentation/i);
  });

  it('uses bit-identical percent-discount arithmetic to PosCalculator', () => {
    const model = buildReceiptPresentation({
      items: [{ key: 'p', name: 'P', qty: 1, unitPrice: 21.15, discountType: 'percent', discountValue: 10 }],
      summary: { subtotal: 19.04, tax: 0, total: 19.04 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    });
    expect(model.rows[0].netAmount).toBe(19.04);
  });

  it.each([
    ['unbounded summary residue', { subtotal: 10, tax: 0, total: 99 }, { type: null, value: 0, amount: 0 }],
    ['negative tax', { subtotal: 10, tax: -1, total: 9 }, { type: null, value: 0, amount: 0 }],
    ['negative discount', { subtotal: 10, tax: 0, total: 10 }, { type: 'fixed', value: -1, amount: -1 }]
  ])('rejects %s', (_name, summary, orderDiscount) => {
    expect(() => buildReceiptPresentation({
      items: [{ key: 'x', name: 'X', qty: 1, unitPrice: 10 }],
      summary, orderDiscount, taxMode: 'exclusive'
    })).toThrow(/invalid receipt presentation/i);
  });

  it('rejects child money and zero-quantity rows during validation', () => {
    const valid = buildReceiptPresentation({
      items: [{ key: 'x', name: 'X', qty: 1, unitPrice: 10 }],
      summary: { subtotal: 10, tax: 0, total: 10 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
    });
    expect(() => validateReceiptPresentation({
      ...valid, rows: [...valid.rows, { ...valid.rows[0], key: 'child', kind: 'bundle_child', netAmount: 1 }]
    })).toThrow(/invalid receipt presentation/i);
    expect(() => buildReceiptPresentation({
      items: [{ key: 'zero', name: 'Zero', qty: 0, unitPrice: 10 }],
      summary: { subtotal: 0, tax: 0, total: 0 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
    })).toThrow(/invalid receipt presentation/i);
  });

  it('does not treat a cart product id as a receipt-row identity', () => {
    const model = buildReceiptPresentation({
      items: [
        { id: 7, name: 'Same product A', qty: 1, unitPrice: 1 },
        { id: 7, name: 'Same product B', qty: 1, unitPrice: 1 }
      ],
      summary: { subtotal: 2, tax: 0, total: 2 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
    });
    expect(model.rows.map(row => row.key)).toEqual(['row-0', 'row-1']);
  });
});
```

- [x] **Step 3: Run the backend test and verify red**

Run:

```powershell
npx vitest run backend/tests/unit/receiptPresentation.test.js --reporter=verbose
```

Expected: FAIL because `backend/services/ReceiptPresentation.js` does not exist.

- [x] **Step 4: Implement the backend builder completely**

Create `backend/services/ReceiptPresentation.js` with these exact rules:

```javascript
const VALID_TAX_MODES = new Set(['exclusive', 'inclusive', 'legacy_unknown']);
const VALID_STATUSES = new Set(['original', 'voided', 'partially_refunded', 'fully_refunded']);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const cents = value => Math.round((finite(value) + Number.EPSILON) * 100);
const money = value => cents(value) / 100;
const fail = message => {
  const error = new Error(`Invalid receipt presentation: ${message}`);
  error.code = 'RECEIPT_PRESENTATION_INVALID';
  error.reason = message;
  throw error;
};

function normalizeLine(source = {}, index = 0) {
  const kind = source.kind === 'bundle_child' || source.parent_item_id != null
    ? 'bundle_child'
    : 'item';
  const rawQty = source.qty ?? source.quantity;
  const rawUnitPrice = source.unitPrice ?? source.price ?? source.price_at_sale;
  if (!Number.isFinite(Number(rawQty)) || !Number.isFinite(Number(rawUnitPrice))) fail(`non-finite row at index ${index}`);
  const qty = Number(rawQty);
  const unitPrice = Number(rawUnitPrice);
  const discountType = source.discountType ?? source.discount_type ?? null;
  const rawDiscountValue = source.discountValue ?? source.discount_value ?? 0;
  if (!Number.isFinite(Number(rawDiscountValue))) fail(`non-finite discount at index ${index}`);
  const discountValue = Number(rawDiscountValue);
  if (qty <= 0 || unitPrice < 0 || discountValue < 0) fail(`invalid row money at index ${index}`);
  if (discountValue > 0 && !['fixed', 'percent'].includes(discountType)) fail(`invalid discount type at index ${index}`);
  if (discountType === 'percent' && discountValue > 100) fail(`invalid discount percent at index ${index}`);
  const extendedRaw = kind === 'bundle_child' ? 0 : unitPrice * qty;
  let discountRaw = 0;
  if (discountType === 'fixed') discountRaw = discountValue * qty;
  if (discountType === 'percent') discountRaw = extendedRaw * (discountValue / 100);
  const netRaw = Math.max(0, extendedRaw - discountRaw);
  return {
    key: String(source.key ?? source.cartId ?? `row-${index}`),
    kind,
    name: String(source.name ?? source.product_name ?? source.item_name ?? 'Unknown Item'),
    note: String(source.note ?? ''),
    qty,
    unitPrice: money(unitPrice),
    extendedPrice: money(extendedRaw),
    lineDiscountAmount: money(Math.min(extendedRaw, Math.max(0, discountRaw))),
    lineDiscountLabel: discountValue > 0
      ? (discountType === 'percent' ? `${discountValue}%` : `${money(discountValue).toFixed(2)} x ${qty}`)
      : null,
    netRaw,
    netAmount: kind === 'bundle_child' ? 0 : money(netRaw),
    _index: index
  };
}

function apportionRows(rows, subtotal) {
  const financial = rows.filter(row => row.kind === 'item');
  const rawTotal = financial.reduce((sum, row) => sum + row.netRaw, 0);
  if (cents(rawTotal) !== cents(subtotal)) fail('subtotal does not match receipt rows');
  let delta = cents(subtotal) - financial.reduce((sum, row) => sum + cents(row.netRaw), 0);
  const ordered = [...financial].sort((a, b) => {
    const aFraction = a.netRaw * 100 - Math.floor(a.netRaw * 100);
    const bFraction = b.netRaw * 100 - Math.floor(b.netRaw * 100);
    return delta >= 0
      ? (bFraction - aFraction || a._index - b._index)
      : (aFraction - bFraction || a._index - b._index);
  });
  for (let cursor = 0; delta !== 0; cursor += 1) {
    if (cursor > ordered.length * 2) fail('row-cent residue is not reconcilable');
    const row = ordered[cursor % ordered.length];
    const next = cents(row.netAmount) + Math.sign(delta);
    if (next < 0) continue;
    row.netAmount = next / 100;
    delta -= Math.sign(delta);
  }
  return rows.map(({ netRaw, _index, ...row }) => row);
}

function buildReceiptPresentation(input = {}) {
  const taxMode = input.taxMode || 'legacy_unknown';
  const status = input.status || 'original';
  if (!VALID_TAX_MODES.has(taxMode)) fail('unknown tax mode');
  if (!VALID_STATUSES.has(status)) fail('unknown receipt status');
  if (![input.summary?.subtotal, input.summary?.tax, input.summary?.total, input.orderDiscount?.amount]
    .every(value => Number.isFinite(Number(value)))) fail('non-finite summary');
  const orderDiscountType = input.orderDiscount?.type ?? null;
  const orderDiscountValue = Number(input.orderDiscount?.value ?? 0);
  if (!Number.isFinite(orderDiscountValue) || orderDiscountValue < 0 ||
      (orderDiscountValue > 0 && !['fixed', 'percent'].includes(orderDiscountType)) ||
      (orderDiscountType === 'percent' && orderDiscountValue > 100)) fail('invalid order discount');
  const rawSubtotal = Number(input.summary.subtotal);
  const rawTaxAmount = Number(input.summary.tax);
  const rawTotal = Number(input.summary.total);
  const rawOrderDiscountAmount = Number(input.orderDiscount.amount);
  if (rawSubtotal < 0 || rawTaxAmount < 0 || rawTotal < 0 ||
      rawOrderDiscountAmount < 0 || rawOrderDiscountAmount > rawSubtotal) {
    fail('negative or impossible summary money');
  }
  const subtotal = money(rawSubtotal);
  const taxAmount = money(rawTaxAmount);
  const total = money(rawTotal);
  const orderDiscountAmount = money(rawOrderDiscountAmount);
  const rows = apportionRows((input.items || []).map(normalizeLine), subtotal);
  const roundingAdjustment = (
    cents(total) - cents(subtotal) + cents(orderDiscountAmount) - cents(taxAmount)
  ) / 100;
  if (Math.abs(cents(roundingAdjustment)) > 2) fail('summary rounding residue is not reconcilable');
  const model = {
    version: 1,
    currency: 'JD',
    decimals: 2,
    taxMode,
    status,
    rows,
    summary: {
      subtotal,
      orderDiscountAmount,
      orderDiscountLabel: orderDiscountType === 'percent'
        ? `${orderDiscountValue}%`
        : null,
      taxAmount,
      taxLabel: taxMode === 'inclusive' ? 'Included in prices' : null,
      roundingAdjustment: money(roundingAdjustment),
      total
    }
  };
  validateReceiptPresentation(model);
  return model;
}

function validateReceiptPresentation(model) {
  if (!model || model.version !== 1 || !Array.isArray(model.rows) || !model.summary) fail('shape');
  if (model.currency !== 'JD' || model.decimals !== 2 ||
      !VALID_TAX_MODES.has(model.taxMode) || !VALID_STATUSES.has(model.status)) fail('metadata');
  const { subtotal, orderDiscountAmount, taxAmount, roundingAdjustment, total } = model.summary;
  if (![subtotal, orderDiscountAmount, taxAmount, roundingAdjustment, total]
    .every(value => Number.isFinite(Number(value)))) fail('summary money');
  if (subtotal < 0 || orderDiscountAmount < 0 || orderDiscountAmount > subtotal || taxAmount < 0 || total < 0) fail('summary money');
  if (Math.abs(cents(roundingAdjustment)) > 2) fail('summary rounding residue');
  const keys = new Set();
  for (const row of model.rows) {
    if (!row || typeof row.key !== 'string' || row.key.length === 0 ||
        !['item', 'bundle_child'].includes(row.kind) || !Number.isFinite(row.netAmount) || row.netAmount < 0 ||
        !Number.isFinite(row.qty) || row.qty <= 0 || !Number.isFinite(row.unitPrice) || row.unitPrice < 0 ||
        !Number.isFinite(row.extendedPrice) || row.extendedPrice < 0 ||
        !Number.isFinite(row.lineDiscountAmount) || row.lineDiscountAmount < 0) fail('row');
    if (row.kind === 'bundle_child' && row.netAmount !== 0) fail('bundle child money');
    if (keys.has(row.key)) fail('duplicate row key');
    keys.add(row.key);
  }
  const financialCents = model.rows
    .filter(row => row.kind === 'item')
    .reduce((sum, row) => sum + cents(row.netAmount), 0);
  if (financialCents !== cents(model.summary.subtotal)) fail('row sum');
  const foot = cents(model.summary.subtotal)
    - cents(model.summary.orderDiscountAmount)
    + cents(model.summary.taxAmount)
    + cents(model.summary.roundingAdjustment);
  if (foot !== cents(model.summary.total)) fail('summary footing');
  return true;
}

module.exports = { buildReceiptPresentation, validateReceiptPresentation };
```

The percent-discount expression is a compatibility contract, not a style choice: it must remain bit-identical to `calculateLineTotal`/frontend `lineNet` (`extendedRaw - extendedRaw * (discountValue / 100)`). Algebraically equivalent re-parenthesization can move a binary float across a half-cent boundary and make a valid checkout fail presentation construction.

`source.id` is intentionally not a generic key fallback: in cart-shaped data it is a product ID and can repeat. Cart adapters use `cartId`; DB/held/split adapters must provide an explicit stable `key`; otherwise the builder uses the deterministic `row-${index}` fallback. The frontend copy must preserve both this rule and the exact percent operation order.

If the stable-order apportionment expectation exposes a `0.34,0.34,0.33` ordering instead of the fixture's `0.33,0.34,0.34`, do not edit the test casually: choose and document one deterministic tie policy in both builders. The approved requirement is deterministic conservation, not a particular favoured row.

- [x] **Step 5: Implement the frontend builder, not a renderer formula**

Create `src/utils/receiptPresentation.js` with the same constants and complete algorithm using ESM exports. Use the same function bodies above, replace only the final export with:

```javascript
export { buildReceiptPresentation, validateReceiptPresentation };

export function legacyReceiptPresentation(payload = {}) {
  if (payload.receipt_display_v1 !== undefined) {
    validateReceiptPresentation(payload.receipt_display_v1);
    return payload.receipt_display_v1;
  }
  const type = payload.discount_type || null;
  const raw = finite(payload.discount ?? payload.discount_value);
  const legacySubtotal = finite(payload.subtotal);
  const amount = type === 'percent'
    ? money(legacySubtotal - Math.max(0, legacySubtotal - legacySubtotal * (raw / 100)))
    : money(Math.min(legacySubtotal, Math.max(0, raw)));
  return buildReceiptPresentation({
    items: payload.items || [],
    summary: { subtotal: payload.subtotal, tax: payload.tax, total: payload.total },
    orderDiscount: { type, value: raw, amount },
    taxMode: payload.tax_mode || 'legacy_unknown',
    status: payload.status || 'original'
  });
}

export function resolveReceiptPresentation(payload) {
  if (!payload || Object.keys(payload).length === 0) {
    return { presentation: null, error: null, idle: true };
  }
  try {
    return {
      presentation: legacyReceiptPresentation(payload),
      error: null,
      idle: false
    };
  } catch (error) {
    if (error.code !== 'RECEIPT_PRESENTATION_INVALID') throw error;
    return { presentation: null, error, idle: false };
  }
}
```

Do not import Vue, Pinia, the DOM, or receipt components.

- [x] **Step 6: Add shared-fixture and seeded parity tests**

Create `backend/tests/unit/receiptPresentationParity.test.js`. Import the frontend ESM builder normally and load the backend CommonJS builder with `createRequire(import.meta.url)`. Use a fixed-seed LCG, generate at least 10,000 inputs, and assert deep equality. Randomly place—not append—a service-charge row. Track and assert positive counters for every required category:

```javascript
import { createRequire } from 'node:module';
import {
  buildReceiptPresentation as frontendBuild,
  resolveReceiptPresentation
} from '../../../src/utils/receiptPresentation.js';
import { posTotals, lineNet, roundMoney } from '../../../src/utils/posTotals.js';
import cases from '../fixtures/receiptPresentationCases.json';
const require = createRequire(import.meta.url);
const { buildReceiptPresentation: backendBuild } = require('../../services/ReceiptPresentation');
const { calculateExpectedTotals } = require('../../services/PosCalculator');

const lcg = seed => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

describe('receipt presentation parity', () => {
  it('resolves idle, legacy, valid-v1, and invalid-v1 states without an SFC harness', () => {
    expect(resolveReceiptPresentation({})).toEqual({ presentation: null, error: null, idle: true });
    const legacy = {
      items: [{ key: 'legacy', name: 'Legacy', qty: 1, price: 1 }],
      subtotal: 1, tax: 0, total: 1, discount: 0
    };
    expect(resolveReceiptPresentation(legacy)).toMatchObject({ error: null, idle: false });
    const v1 = frontendBuild({
      items: [{ key: 'v1', name: 'V1', qty: 1, unitPrice: 1 }],
      summary: { subtotal: 1, tax: 0, total: 1 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
    });
    expect(resolveReceiptPresentation({ receipt_display_v1: v1 })).toEqual({
      presentation: v1, error: null, idle: false
    });
    const invalid = resolveReceiptPresentation({ receipt_display_v1: { version: 1 } });
    expect(invalid).toMatchObject({ presentation: null, idle: false });
    expect(invalid.error.code).toBe('RECEIPT_PRESENTATION_INVALID');
  });

  it.each(cases)('matches shared vector: $name', ({ input }) => {
    expect(frontendBuild(structuredClone(input))).toEqual(backendBuild(structuredClone(input)));
  });

  it('matches 10k seeded cases and exercises every special path', () => {
    const random = lcg(0x5eedc0de);
    const seen = { fixedLine: 0, percentLine: 0, fixedOrder: 0, percentOrder: 0, inclusive: 0, zeroTax: 0, fractionalQty: 0, serviceCharge: 0, bundle: 0 };
    for (let i = 0; i < 10000; i += 1) {
      const taxInclusive = i % 2 === 0;
      if (taxInclusive) seen.inclusive += 1;
      const count = 1 + Math.floor(random() * 6);
      const financial = [];
      const productMap = new Map();
      for (let j = 0; j < count; j += 1) {
        const discountType = (i + j) % 4 === 0 ? 'fixed' : ((i + j) % 4 === 1 ? 'percent' : null);
        const discountValue = discountType === 'fixed' ? 0.5 : (discountType === 'percent' ? 10 : 0);
        if (discountType === 'fixed') seen.fixedLine += 1;
        if (discountType === 'percent') seen.percentLine += 1;
        const qty = (i + j) % 5 === 0 ? 1.5 : 1 + Math.floor(random() * 3);
        if (!Number.isInteger(qty)) seen.fractionalQty += 1;
        const taxRate = (i + j) % 5 === 0 ? 0 : ((i + j) % 2 === 0 ? 16 : 8);
        if (taxRate === 0) seen.zeroTax += 1;
        const productId = j + 1;
        financial.push({
          key: `p-${i}-${j}`, product_id: productId, name: `P${j}`,
          qty, price: roundMoney(1 + random() * 30), tax_rate: taxRate,
          discountType, discountValue
        });
        productMap.set(productId, { id: productId, tax_rate: taxRate });
      }
      if (i % 3 === 0) {
        const base = financial.reduce((sum, item) => sum + lineNet(item), 0);
        const fee = {
          key: `fee-${i}`, name: '10% Service Charge', note: 'Auto-Gratuity',
          qty: 1, price: roundMoney(base * 0.1), tax_rate: i % 2 ? 8 : 0,
          discountType: null, discountValue: 0
        };
        financial.splice(Math.floor(random() * (financial.length + 1)), 0, fee);
        seen.serviceCharge += 1;
      }
      const orderDiscount = i % 4 === 0
        ? { type: 'fixed', value: 1 }
        : (i % 4 === 1 ? { type: 'percent', value: 15 } : { type: null, value: 0 });
      if (orderDiscount.type === 'fixed') seen.fixedOrder += 1;
      if (orderDiscount.type === 'percent') seen.percentOrder += 1;
      const frontendTotals = posTotals(financial, orderDiscount, { taxInclusive });
      const backendTotals = calculateExpectedTotals({
        order_discount_type: orderDiscount.type,
        order_discount_value: orderDiscount.value
      }, financial, productMap, taxInclusive);
      expect(frontendTotals).toMatchObject({
        subtotal: backendTotals.subtotal,
        tax: backendTotals.tax,
        total: backendTotals.total
      });
      const displayItems = [...financial];
      if (i % 4 === 2) {
        displayItems.splice(1, 0, {
          key: `child-${i}`, kind: 'bundle_child', name: 'Bundle child', qty: 1, unitPrice: 0
        });
        seen.bundle += 1;
      }
      const input = {
        items: displayItems,
        summary: backendTotals,
        orderDiscount: { ...orderDiscount, amount: backendTotals.discount },
        taxMode: taxInclusive ? 'inclusive' : 'exclusive',
        status: 'original'
      };
      expect(frontendBuild(structuredClone(input))).toEqual(backendBuild(structuredClone(input)));
    }
    expect(Object.values(seen).every(count => count > 100)).toBe(true);
  });
});
```

- [x] **Step 7: Run contract and parity tests**

Run:

```powershell
npx vitest run backend/tests/unit/receiptPresentation.test.js backend/tests/unit/receiptPresentationParity.test.js --reporter=verbose
```

Expected: PASS; no input object changes; every coverage counter exceeds 100.

- [x] **Step 8: Commit the presentation contract**

```powershell
git add -- backend/services/ReceiptPresentation.js src/utils/receiptPresentation.js backend/tests/fixtures/receiptPresentationCases.json backend/tests/unit/receiptPresentation.test.js backend/tests/unit/receiptPresentationParity.test.js
git commit -m "feat(pos): define canonical receipt presentation model"
```

---

## Task 2: Add Tax-Mode Persistence Without Changing Calculations Yet

**Files:**
- Create: `backend/migrations/2026-07-11-orders-tax-mode-at-sale.sql`
- Create: `backend/migrations/apply-orders-tax-mode-at-sale.js`
- Modify: `backend/services/ReceiptPresentation.js`
- Modify: `backend/tests/unit/receiptPresentation.test.js`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `backend/routes/pos/checkout.js`
- Modify: `backend/routes/pos/tables.js`
- Modify: `backend/routes/pos/orders.js`
- Test: `backend/tests/integration/checkout.test.js`
- Test: `backend/tests/integration/tables.test.js`
- Test: `backend/tests/integration/heldOrders.test.js`

**Interfaces:**
- Produces `normalizeStoredTaxMode(value) -> true | false | null`.
- Produces `receiptTaxMode({ stored, tax }) -> 'inclusive' | 'exclusive' | 'legacy_unknown'`.
- Persists `orders.tax_inclusive_at_sale` but Task 2 deliberately leaves current calculations unchanged.

- [x] **Step 1: Write schema and helper tests first**

Append to `backend/tests/unit/receiptPresentation.test.js`:

```javascript
const { normalizeStoredTaxMode, receiptTaxMode } = require('../../services/ReceiptPresentation');

describe('receipt tax-mode helpers', () => {
  it('normalizes only explicit stored values', () => {
    expect(normalizeStoredTaxMode(1)).toBe(true);
    expect(normalizeStoredTaxMode('0')).toBe(false);
    expect(normalizeStoredTaxMode(null)).toBeNull();
    expect(normalizeStoredTaxMode(undefined)).toBeNull();
  });

  it('keeps legacy zero-tax history neutral', () => {
    expect(receiptTaxMode({ stored: null, tax: 0 })).toBe('legacy_unknown');
    expect(receiptTaxMode({ stored: null, tax: 1.6 })).toBe('exclusive');
    expect(receiptTaxMode({ stored: 1, tax: 0 })).toBe('inclusive');
    expect(receiptTaxMode({ stored: 0, tax: 0 })).toBe('exclusive');
  });
});
```

Append four named integration cases using the suites' existing login/product/order helpers:

1. `stamps the current tax mode on a new direct checkout`: set the setting to `0`, checkout and assert DB flag `0`; set it to `1`, checkout a second order and assert flag `1`.
2. `stamps the current tax mode on a new unpaid table only once`: save under `0`, flip to `1`, save the same invoice again, and assert the flag remains `0`.
3. `copies the parent tax mode into every split payload`: split a parent with flag `1`, parse every resulting `held_orders.cart_data`, and assert `tax_inclusive_at_sale === 1`.
4. `stores ordinary hold mode as preview metadata, not checkout authority`: create a hold under `0`, assert JSON `tax_inclusive_at_hold === 0`, claim it, and assert the claim response does not expose `tax_inclusive_at_sale` as a trusted checkout field.

- [x] **Step 2: Verify red state**

Run:

```powershell
npx vitest run backend/tests/unit/receiptPresentation.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js --reporter=verbose --pool=forks --maxWorkers=1
```

Expected: new assertions fail because the column/helper/JSON fields do not exist.

- [x] **Step 3: Add the nullable migration and test schema**

Create `backend/migrations/2026-07-11-orders-tax-mode-at-sale.sql`:

```sql
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tax_inclusive_at_sale TINYINT(1) NULL AFTER tax;
```

Add the same nullable column to the `orders` table in `backend/tests/fixtures/seed.js` immediately after `tax`.

Create `backend/migrations/apply-orders-tax-mode-at-sale.js` following the existing service-charge runner's dotenv/connection/finally structure. Require:

```javascript
if (process.env.RECEIPT_TAX_MODE_MIGRATION_CONFIRM !== 'apply-receipt-tax-mode') {
  throw new Error('Set RECEIPT_TAX_MODE_MIGRATION_CONFIRM=apply-receipt-tax-mode to continue.');
}
```

Query `information_schema.COLUMNS` first; if the column exists, print an idempotent success and exit. Otherwise execute the SQL file in one connection. Never log credentials.

- [x] **Step 4: Add the two pure tax-mode functions to the receipt domain module**

Append these functions to `backend/services/ReceiptPresentation.js` and add them to its existing `module.exports`; do not create a one-purpose lifecycle service:

```javascript
function normalizeStoredTaxMode(value) {
  if (value === 1 || value === '1' || value === true) return true;
  if (value === 0 || value === '0' || value === false) return false;
  return null;
}

function receiptTaxMode({ stored, tax }) {
  const normalized = normalizeStoredTaxMode(stored);
  if (normalized === true) return 'inclusive';
  if (normalized === false) return 'exclusive';
  return Number(tax || 0) > 0 ? 'exclusive' : 'legacy_unknown';
}

```

- [x] **Step 5: Stamp new durable sources while preserving existing rows**

In `checkout.js`, add `tax_inclusive_at_sale` to the direct/split INSERT and pass `taxInclusivePricing ? 1 : 0`. For an existing table UPDATE, do not overwrite the column in Task 2.

In `tables.js`, add `tax_inclusive_at_sale` to the new unpaid-table INSERT. Do not update it on subsequent table saves.

When creating split `cartPayload`, resolve a legacy-null parent once under the lock, persist that choice on the parent, then add:

```javascript
tax_inclusive_at_sale: parentOrder.tax_inclusive_at_sale == null
  ? (taxInclusivePricing ? 1 : 0)
  : (Number(parentOrder.tax_inclusive_at_sale) === 1 ? 1 : 0),
```

and include the column in the locked parent SELECT.

When creating an ordinary hold in `orders.js`, add only this JSON metadata:

```javascript
cartPayload.tax_inclusive_at_hold = taxInclusivePricing ? 1 : 0;
```

Load the current setting server-side through `getSettings`; never copy a client field.

- [x] **Step 6: Run focused persistence tests**

Run the same focused command from Step 2. Expected: PASS, and existing calculation assertions remain byte-identical.

- [x] **Step 7: Commit additive persistence**

```powershell
git add -- backend/migrations/2026-07-11-orders-tax-mode-at-sale.sql backend/migrations/apply-orders-tax-mode-at-sale.js backend/services/ReceiptPresentation.js backend/tests/unit/receiptPresentation.test.js backend/tests/fixtures/seed.js backend/routes/pos/checkout.js backend/routes/pos/tables.js backend/routes/pos/orders.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js
git commit -m "feat(pos): persist receipt tax mode at durable boundaries"
```

---

## Task 3: Freeze Durable Tax Context Across Setting and Catalog Changes

**Files:**
- Modify: `backend/routes/pos/checkout.js`
- Modify: `backend/routes/pos/tables.js`
- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/services/PosCalculator.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Test: `backend/tests/unit/PosCalculator.test.js`
- Test: `backend/tests/integration/checkout.test.js`
- Test: `backend/tests/integration/tables.test.js`
- Test: `backend/tests/integration/heldOrders.test.js`
- Test: `backend/tests/integration/serviceChargeSnapshots.test.js`
- Test: `backend/tests/unit/orderSessionStore.test.js`

**Interfaces:**
- Open table and split calculate with server-frozen `tax_inclusive_at_sale` and server-matched per-line rates.
- New/direct cart calculates with the current setting and current catalog rates.
- Ordinary held preview uses server-normalized hold-time rates; claim replaces catalog-line rates with current DB rates and exposes one warning when mode, any rate, or total differs.
- Route-owned tax overrides use a request-local `Map` keyed by normalized item object. They are never copied from request JSON or serialized into an API contract.

- [x] **Step 1: Add tax-context regressions**

Add integration tests with a `10.00`, `16%` product:

1. Save an exclusive open table (`subtotal=10`, `tax=1.60`, `total=11.60`), switch global setting to inclusive, reload and settle. Assert it still charges/stores `11.60`, tax `1.60`, and flag `0`.
2. Save an inclusive open table (`10.00`, tax `0`, total `10.00`), switch global setting to exclusive, settle. Assert it stays `10.00`, tax `0`, flag `1`.
3. Split an exclusive parent, switch setting, settle every seat. Assert each uses inherited exclusive mode and total conservation remains unchanged.
4. Include a service-charge split in the setting-flip case so tax-mode selection cannot bypass snapshot conservation.
5. Save a table line at `16%`, change its catalog row to `0%`, resave and settle; assert the existing line, order tax, and receipt still use `16%`.
6. After that catalog change, add a genuinely new line to the same table; assert the old line remains `16%`, the new line becomes `0%`, and both rates survive another save.
7. Split a parent containing frozen `16%` and `0%` lines after changing both catalog rows; assert every child inherits the matched parent `order_items.tax_rate` and all settled child totals conserve to the parent.
8. Submit `_frozenTaxRate`, `taxRateOverrides`, and a forged `tax_rate` on direct checkout; assert catalog lines still use the current DB rate.
9. Park an ordinary hold at `16%`, inspect its persisted normalized `cart_data`, change the catalog to `0%`, then claim it; assert stored hold-time data was `16%`, the claimed cart is returned at `0%`, and the response reports a rate/total change. The held v1 assertion belongs to Task 4, after routes emit v1.
10. Repeat the rate-change table/split cases with an Auto-Gratuity line and assert its snapshot-owned rate and allocated cents remain unchanged.
11. Recall a table, save it twice without reloading between saves, and assert both succeed with the same prices/rates. The first save remints `order_items.id`, so the second request deliberately carries stale IDs and exercises the unambiguous fallback.

Add store tests:

```javascript
it('restores an ordinary hold under current mode and warns when hold mode differs', async () => {
  // fixture held JSON has tax_inclusive_at_hold=0; terminal setting is true.
  // restoreHeldOrder keeps terminal current mode, recomputes totals, and emits one warning.
});

it('warns once when claim reports changed catalog tax rates or total', async () => {
  // claim response is already server-rehydrated; the store does not compare trusted client rates.
});
```

- [x] **Step 2: Run red tests**

```powershell
npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/serviceChargeSnapshots.test.js --reporter=verbose --pool=forks --maxWorkers=1
```

Expected: setting-flip money follows the new global mode, existing catalog lines follow mutable product rates, and claim does not disclose rate changes; the new assertions fail.

- [x] **Step 3: Use frozen mode under the server lock**

In checkout's locked order SELECT include `tax_inclusive_at_sale`. Change the settings destructure to a mutable effective variable:

```javascript
const checkoutSettings = await loadCheckoutSettings(conn);
const stockEnabled = checkoutSettings.stockEnabled;
let taxInclusivePricing = checkoutSettings.taxInclusivePricing;

if (isUnpaidTableSettle && orderLock[0].tax_inclusive_at_sale != null) {
  taxInclusivePricing = Number(orderLock[0].tax_inclusive_at_sale) === 1;
}
if (isSplitSettle && splitHeldPayload?.tax_inclusive_at_sale != null) {
  taxInclusivePricing = Number(splitHeldPayload.tax_inclusive_at_sale) === 1;
}
```

Do this before `calculateExpectedTotals`, tax stamping, and presentation construction. Never accept `data.tax_inclusive_at_sale`.

In table save, load the existing order's flag under `FOR UPDATE` before totals. Use it when non-null; new table orders use current mode. If a legacy existing row is null, choose current mode once and write that chosen flag in the same UPDATE. Include the flag in `GET /table_order` so frontend display uses the same mode.

In bill split, use `parentOrder.tax_inclusive_at_sale` for seat totals, tax/fee allocation inputs, and child JSON. If it is null, resolve current mode once and persist it before voiding the parent. Never use a later global-mode read when the parent flag exists.

When settling a legacy unpaid table whose flag is null, use current mode once and set `tax_inclusive_at_sale` in the same finalized-order UPDATE. New/direct and split-child INSERTs write the effective mode selected before totals.

- [x] **Step 4: Add an unforgeable server-only line-rate override boundary**

In `PosCalculator.js`, add:

```javascript
const validateTaxRate = value => {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    const error = new Error('Invalid tax rate on cart line.');
    error.statusCode = 400;
    throw error;
  }
  return rate;
};

const resolveLineTaxRate = (item, productMap, taxRateOverrides) => {
  if (taxRateOverrides?.has(item)) {
    return validateTaxRate(taxRateOverrides.get(item));
  }
  const product = item.product_id ? productMap.get(item.product_id) : null;
  return validateTaxRate(resolveTaxRate(product, item.tax_rate));
};
```

Extend `calculateExpectedTotals(data, cartItems, productMap, taxInclusivePricing, { taxRateOverrides } = {})` to call `resolveLineTaxRate`. Export the helper so the insertion loops use the identical resolution before `stampLineTax`. Do not use `toFiniteNumber(..., 0)` on an override: invalid server evidence must fail closed, not become zero tax.

The routes construct `const taxRateOverrides = new Map()` locally, only after server identity matching, and pass it explicitly to totals and line stamping. A request cannot construct a map entry for the newly normalized item objects, and the request-local map is discarded after the route completes. Do not add `_frozenTaxRate` or another enumerable item property: `normalizeCartItems` currently spreads arbitrary request fields and would make such a property forgeable.

Add unit tests proving the override changes totals for the exact object only, a cloned/request object cannot reuse it, invalid override rates fail, and the no-override path is byte-for-byte compatible with existing cases.

- [x] **Step 5: Match and reuse durable line rates under the same locks as prices**

Use these route-specific sources:

1. **Existing table save:** expand the saved item query to `id, product_id, item_name, note, quantity, price_at_sale, tax_rate`. Prefer `order_item_id`; if it names a current row, require product/note identity and then pin both price and rate. Because this route deletes and reinserts rows, a non-null ID that no longer exists can legitimately be stale on a second save; allow its fallback only if the product/custom-name + note group has one distinct saved price and one distinct saved rate. A line with no `order_item_id` is new and uses the current catalog rate even when the same product already exists—otherwise adding a second line after catalog drift would silently inherit the old rate. Ambiguous stale-ID groups return `409` with a refresh message. The replacement `order_items` rows persist the resolved rate.
2. **Unpaid-table checkout:** expand `savedRowById` and the saved SELECT with `tax_rate`. When the stable ID match succeeds, attach that row's rate to the override map. If the submitted ID is stale/absent, use the same single-price/single-rate current-order fallback; if it names a current row with a mismatched identity, reject it. Build the map after any service-charge canonicalization so object identity is final.
3. **Split creation:** after matching each seat item by parent `order_item_id`, set its serialized `tax_rate` to the parent's persisted rate and add the item/rate to the override map. For an absent/stale reminted ID, allow fallback only when the parent identity group has one distinct price and rate; reject an ID that names a mismatched current parent row. Do this for catalog and custom rows, not only `product_id == null`. Service-charge rows continue to use the snapshot rate and allocation checks.
4. **Split settlement:** ignore the submitted cart's rate. Match it to the locked split row exactly as the frozen-price path does, then use the stored child `cart_data` rate in the route-owned map. A missing/invalid rate in a newly versioned split payload is a `409`. For a pre-version payload, ignore its carried catalog rate, load the referenced parent `order_items.tax_rate` by `order_item_id`, and use current catalog data only when parent evidence is unavailable and the identity fallback is unambiguous. Cover both legacy paths.

Never use a current catalog rate for a successfully matched durable line. Never use a persisted durable rate for a new no-ID table line merely because it shares a product ID. The stale-ID fallback cannot authorize a client price/rate; it selects only an unambiguous server row.

- [x] **Step 6: Normalize ordinary holds at park and deliberately refresh them at claim**

In `POST /held_orders`, after catalog loading, database price pinning, and service-charge canonicalization, overwrite every catalog item's serialized `tax_rate` with the DB product rate. Preserve the server-owned snapshot rate for Auto-Gratuity and the existing validated custom-line behavior. Store `tax_inclusive_at_hold`, then build the parked preview from exactly this normalized payload.

Write `tax_context_version: 1` into every new ordinary-hold and split payload. Absence means pre-plan legacy data and invokes the legacy evidence-recovery rules in Steps 5/Task 4; when version `1` is present, every financial row must have a finite server-authored rate and missing/invalid values fail closed.

In `POST /held_orders/claim`, while the held row is locked and before deleting it:

1. parse and normalize its cart;
2. batch-load current products;
3. replace every catalog-line rate with the current DB value (missing/deleted products follow the route's existing product-not-found failure policy);
4. preserve snapshot-canonical Auto-Gratuity;
5. calculate old hold-time and new current-mode totals server-side;
6. return the rehydrated `cart_data` plus `pricing_context_changed: { taxMode, taxRates, total }` booleans.

The comparison is informational and must not create another durable claim state. If any step fails, roll back without deleting the hold or consuming its snapshot claim.

- [x] **Step 7: Thread effective context into the store without trusting ordinary holds**

Add a private `activeOrderTaxInclusive` ref. Set it from authoritative table/split responses only. Make `posTotals` use:

```javascript
const effectiveTaxInclusive = computed(() =>
  activeOrderTaxInclusive.value == null
    ? Boolean(getDeps().terminal.taxInclusivePricing?.value)
    : activeOrderTaxInclusive.value
);
```

Reset it in `clearOrderSlice` and table-session cleanup. A normal held-order claim must not set it. Consume the server's rehydrated claimed cart, recompute naturally, and show one warning toast if any `pricing_context_changed` flag is true. Do not send the hold-time flag, parked rates, or change metadata to checkout.

- [x] **Step 8: Run focused money and snapshot suites**

Run the Step 2 command. Expected: PASS; current direct-sale behavior remains unchanged, durable lifecycles retain mode/rates, ordinary holds visibly adopt current context, and snapshot conservation remains intact.

- [x] **Step 9: Commit lifecycle freezing**

```powershell
git add -- backend/routes/pos/checkout.js backend/routes/pos/tables.js backend/routes/pos/orders.js backend/services/PosCalculator.js assets/js/composables/stores/orderSessionStore.js backend/tests/unit/PosCalculator.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/unit/orderSessionStore.test.js
git commit -m "fix(pos): freeze durable tax context through settlement"
```

---

## Task 4: Build Authoritative Backend Presentation Sources

**Files:**
- Create: `backend/services/ReceiptPresentationSources.js`
- Modify: `backend/routes/pos/checkout.js`
- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/routes/pos/tables.js`
- Modify: `backend/routes/print.js`
- Modify: `backend/routes/admin/orders.js`
- Test: `backend/tests/integration/checkout.test.js`
- Test: `backend/tests/integration/heldOrders.test.js`
- Test: `backend/tests/integration/tables.test.js`
- Test: `backend/tests/integration/print.authz.test.js`
- Test: `backend/tests/integration/duplicateReceiptSetting.test.js`

**Interfaces:**
- Produces `buildOrderPresentation({ order, items }) -> receipt_display_v1`.
- Produces `buildOrderPresentationForRead({ order, items }) -> { presentation, legacyReason }` for the narrow pre-v1 historical mismatch fallback.
- Produces `buildHeldPresentations(queryable, heldRows, { split }) -> Array<{ presentation, error }>` for list routes without N+1 evidence queries or list-wide corruption failures.
- Authoritative route responses expose the model as `receipt_display_v1` while preserving legacy fields.

- [x] **Step 1: Add red authoritative-source tests**

Add these exact focused integration cases:

1. `returns DB-authoritative v1 from order_details and ignores current tax setting`: create an exclusive paid order, flip global mode to inclusive, GET details, and assert v1 remains exclusive, stored tax is unchanged, and row cents equal subtotal cents.
2. `rebuilds numeric receipt v1 and ignores a forged submitted v1`: submit numeric invoice print with a forged v1 total `0.01`, read the queued payload, and assert its v1 deep-equals the DB detail v1.
3. `rebuilds held and split v1 from lifecycle-authoritative tax evidence`: POST an ordinary hold with a forged catalog rate and assert the persisted preview uses the server-normalized hold-time rate; create a split after catalog drift and assert its v1 uses the matched parent's frozen rate plus the seat's stored order discount. Add direct-DB legacy holds with missing and forged-present catalog rates and assert both use the current DB rate. Add a legacy split with a forged-present rate and assert its referenced parent DB row wins over both JSON and current catalog.
4. `returns identical original and duplicate-checkout presentation money`: retry one idempotency key and deep-compare the two success bodies' v1 objects.
5. `isolates one corrupt held row without downgrading or hiding valid rows`: insert valid-corrupt-valid held rows, list them, assert both valid rows have v1, the corrupt row has only `receipt_display_error`, and printing the corrupt ID returns `422` with public code `RECEIPT_PRESENTATION_INVALID`.
6. `falls back only for an irreconcilable pre-v1 historical order`: create null-tax-context historical orders with `+0.01` and `+0.02` row/header mismatches and assert details, numeric reprint, A4, and delivery retain their legacy payload with `receipt_display_legacy_reason='PRE_V1_CENT_MISMATCH'` and no v1. Repeat with non-null `tax_inclusive_at_sale` and assert `422 RECEIPT_PRESENTATION_INVALID`, never legacy fallback.
7. `rejects self-footing but impossible guest-check v1`: submit one present v1 with `subtotal=10`, `roundingAdjustment=89`, `total=99`, and another with a money-bearing bundle child while the financial rows still foot. Assert both print requests return `422 RECEIPT_PRESENTATION_INVALID` and enqueue nothing.

Also add a voided-order case that asserts `original_subtotal`, `original_tax`, and `original_total` are used while `status='voided'`, and a partial-refund case that keeps original money with `status='partially_refunded'`.

- [x] **Step 2: Run source tests and verify red**

```powershell
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/duplicateReceiptSetting.test.js --reporter=verbose --pool=forks --maxWorkers=1
```

Expected: new `receipt_display_v1` assertions fail.

- [x] **Step 3: Implement DB and held adapters**

Create `backend/services/ReceiptPresentationSources.js`. It must import `calculateExpectedTotals`, `calculateLineTotal`, `normalizeCartItems`, `resolveTaxRate`, and `roundMoney` from `PosCalculator`/the existing helper boundary as appropriate, plus the Task 1 builder and Task 2 tax-mode helper.

Expose only these three public functions; routes keep their existing order queries instead of adding a generic loader:

```javascript
function buildOrderPresentation({ order, items }) {
  try {
    return buildReceiptPresentation(orderPresentationInput(order, items));
  } catch (error) {
    throw asRoutePresentationError(error);
  }
}

function buildOrderPresentationForRead({ order, items }) {
  try {
    return { presentation: buildOrderPresentation({ order, items }), legacyReason: null };
  } catch (error) {
    if (error.code !== 'RECEIPT_PRESENTATION_INVALID' ||
        error.reason !== 'subtotal does not match receipt rows' ||
        order.tax_inclusive_at_sale != null) throw error;
    return { presentation: null, legacyReason: 'PRE_V1_CENT_MISMATCH' };
  }
}

function asRoutePresentationError(error) {
  if (error?.code !== 'RECEIPT_PRESENTATION_INVALID') throw error;
  error.statusCode = 422;
  error.publicCode = error.code;
  return error;
}

async function buildHeldPresentations(queryable, heldRows, { split = false } = {}) {
  const entries = heldRows.map(row => {
    try {
      return { row, parsed: parseHeldCartData(row.cart_data), error: null };
    } catch (error) {
      if (error.code !== 'RECEIPT_PRESENTATION_INVALID') throw error;
      return { row, parsed: null, error: asRoutePresentationError(error) };
    }
  });
  const validEntries = entries.filter(entry => !entry.error);
  const legacyTaxEvidence = await loadLegacyTaxEvidence(queryable, validEntries, { split });
  return entries.map(entry => {
    if (entry.error) return { presentation: null, error: entry.error };
    try {
      const input = heldPresentationInput({
        heldRow: entry.row,
        parsed: entry.parsed,
        legacyTaxEvidence,
        split
      });
      return { presentation: buildReceiptPresentation(input), error: null };
    } catch (error) {
      if (error.code !== 'RECEIPT_PRESENTATION_INVALID') throw error;
      return { presentation: null, error: asRoutePresentationError(error) };
    }
  });
}

module.exports = {
  buildOrderPresentation,
  buildOrderPresentationForRead,
  buildHeldPresentations
};
```

Keep private logic inside this file and limited to five small boundaries:

- `parseHeldCartData`: parse legacy/current held JSON and emit the typed presentation error;
- `asRoutePresentationError`: map that typed error to HTTP `422` plus the same public code;
- `loadLegacyTaxEvidence`: batch-load legacy parent/catalog tax evidence;
- `orderPresentationInput`: adapt DB order rows into builder input;
- `heldPresentationInput`: adapt held rows into builder input and call `calculateExpectedTotals` with the request-local rate map.

`buildOrderPresentationForRead` may suppress only `error.reason === 'subtotal does not match receipt rows'` when `tax_inclusive_at_sale == null`. Negative money, malformed shapes, database/unknown errors, and every mismatch on a v1-era order remain failures. Do not extract another service from these private functions.

A null-context historical order can also fail for other builder reasons (summary residue over two cents, percent discount above 100, discount exceeding subtotal). Those deliberately stay `422` and block rollout. Do not extend this suppression list during plan execution: the current marker and frontend legacy adapter support only the proven cent-mismatch case. Any additional compatibility exception requires a separate reason-specific design that defines its own marker and proves details, Order Notes, numeric reprint, duplicate, A4, Delivery, browser receipt, and spooler behavior. Suppression never widens for v1-era orders.

`buildOrderPresentation` rules:

1. Financial rows are `parent_item_id == null`; keep child rows in the input as `kind='bundle_child'`. Map DB `order_items.id` explicitly to `key: 'order-item-' + id`; do not rely on the builder's raw `source.id`.
2. For a voided order use `original_subtotal`, `original_tax`, and `original_total` when non-null. Do not zero the reprinted original sale.
3. Derive refund status from `payment_method`/`refund_status`; never subtract refund quantities or amounts from rows.
4. Compute actual order-discount money from raw parent-line nets and the frozen `discount_type/value`, then round once. Do not calculate a percentage from the already-rounded order subtotal.
5. Resolve tax mode with `receiptTaxMode({ stored: order.tax_inclusive_at_sale, tax: chosenTax })`.
6. Pass stored/chosen header money into `buildReceiptPresentation`; never derive replacement tax or total.

`buildHeldPresentations` input rules:

1. Parse array-shaped legacy and object-shaped current `cart_data`. Map each row to an explicit unique key from server-authored `cartId`/`order_item_id` plus its stable input index; a repeating product `id` is never row identity.
2. Use `tax_inclusive_at_sale` for splits and `tax_inclusive_at_hold` for ordinary held previews.
3. For `tax_context_version: 1` payloads, require and use the finite rate that the server persisted: parent-inherited for splits and hold-time-normalized for ordinary holds. Do not overwrite it from today's catalog.
4. For every pre-version legacy catalog row, ignore the carried rate even when present. For splits, batch-load referenced parent `order_items` and use the identity-matched parent rate first; batch-load current products only for unresolved rows. For ordinary holds, batch-load current products. Keep this to at most one parent query plus one product query for the whole batch. Snapshot-backed Auto-Gratuity retains its server snapshot rate; preserve the existing validated custom-line policy.
5. Calculate the provisional summary with `calculateExpectedTotals`, the request-local rate map, and the stored `order_discount`.
6. Ignore `held_orders.subtotal` as a display authority.
7. Reject malformed JSON or irreconcilable rows with code `RECEIPT_PRESENTATION_INVALID`; never emit a partial model. At the route boundary map it to HTTP `422` and the same public code, not a bare `500`. Singular builders/print routes throw. Batch list builders isolate the error to that row, return no v1 for it, and let the API attach `receipt_display_error: 'RECEIPT_PRESENTATION_INVALID'` so one corrupt legacy hold cannot hide all valid rows.

- [x] **Step 4: Add v1 to checkout before commit and duplicate recovery**

For normal checkout, construct v1 after all `order_items` are inserted but before `conn.commit()`. A builder failure therefore rolls back an uncommitted checkout instead of creating a paid order with an invalid success body. Store it in a local `receiptPresentation` and include it in the success response after commit.

Extend `buildDuplicateCheckoutResponse` to use the same strict pre-v1 read fallback. It must still return the original success semantics. For a typed mismatch with null frozen context, log the fixed legacy reason, omit v1, and return the legacy duplicate success; never report a paid idempotent retry as failed. A non-null/new order mismatch remains `422`.

Add `receipt_display_v1: receiptPresentation` to the successful response and duplicate response when valid.

- [x] **Step 5: Add v1 to list/detail APIs without N+1 queries**

- `GET /api/admin/order_details`: build from the already-loaded order/items and return `receipt_display_v1` beside them. On the narrow pre-v1 mismatch return the existing raw order/items, omit v1, and add `receipt_display_legacy_reason`; do not return null props.
- `GET /api/pos/order_notes`: expand the order SELECT to include header discounts, original money, refund status, and frozen mode; group the existing batch item query and call `buildOrderPresentationForRead` in memory per order. A pre-v1 mismatch gets its explicit legacy reason without hiding neighboring history rows; a new-version mismatch gets a per-row presentation error. Do not query per order.
- `GET /api/pos/held_orders`: call `buildHeldPresentations` once; current versioned rows need no catalog query, while all legacy catalog rows are batch-loaded from current products because their carried rates predate server normalization. Attach each successful model without per-row queries; attach the fixed error code and no model for a failed row.
- `GET /api/pos/table_splits`: call `buildHeldPresentations` once with `split: true` and apply the same per-row success/error mapping.
- For legacy table splits, batch parent `order_items` across the full response before the optional unresolved-product query; never issue either query per split.

- [x] **Step 6: Make print authority mode-specific**

In `backend/routes/print.js`:

- numeric invoice: discard submitted v1; load the DB order/items and use `buildOrderPresentationForRead`. Attach v1 when valid; for the explicit pre-v1 mismatch enqueue the existing server-built legacy receipt fields plus `receipt_display_legacy_reason`, never a partial v1;
- held/split ID: discard submitted v1; call `buildHeldPresentations(queryable, [row], { split })`, unwrap the single result, and throw its typed error when present;
- guest check: if v1 is absent, build it from the provisional raw payload and server settings; if present, validate it and keep the explicit `provisional=true` boundary;
- always retain legacy `items/subtotal/tax/discount/total` fields during this plan.

Use nullish coalescing for persisted zero tax:

```javascript
tax_amount: item.tax_amount ?? null
```

Do not use `item.tax_amount || null`, which converts a meaningful zero into missing and re-enables tax-rate fallback.

- [x] **Step 7: Run authoritative-source suites**

Run the Step 2 command. Expected: PASS, including forged-v1 rejection, forged split tax rejection, duplicate equality, void/refund immutability, and no N+1 test query explosion.

- [x] **Step 8: Commit backend sources**

```powershell
git add -- backend/services/ReceiptPresentationSources.js backend/routes/pos/checkout.js backend/routes/pos/orders.js backend/routes/pos/tables.js backend/routes/print.js backend/routes/admin/orders.js backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/duplicateReceiptSetting.test.js
git commit -m "feat(pos): emit authoritative receipt presentation data"
```

---

## Task 5: Convert Live Cart, Guest Check, and POS Receipt Renderers

**Files:**
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `assets/js/composables/useCart.js`
- Modify: `src/components/PosTerminal.vue`
- Modify: `src/components/pos/ReceiptPreviewModal.vue`
- Modify: `src/print/PrintReceiptApp.vue`
- Test: `backend/tests/unit/orderSessionStore.test.js`
- Test: `backend/tests/unit/receiptPresentation.test.js`

**Interfaces:**
- Store produces `cartReceiptPresentation` from the frozen live cart and `posTotals`.
- `lastOrder.receipt_display_v1` is backend-authoritative after checkout and frontend-authoritative only for guest checks.
- Present-invalid v1 disables printing; absent v1 uses `legacyReceiptPresentation`.

- [x] **Step 1: Keep resolver prerequisites green; add red store-integration tests**

Task 1 already proves idle, absent-v1 legacy, valid-v1, and present-invalid resolver states. Run that parity test as a green prerequisite and do not duplicate those assertions here.

Add only these store-integration tests; they must be red before Task 5 implementation:

- a live exclusive cart with a line discount has net rows summing to `cartSubtotal`;
- guest check with a 20% order discount foots exactly;
- inclusive guest check does not gross line tax a second time;
- checkout stores the server-returned v1 object unchanged even if the cart snapshot differs;

- [x] **Step 2: Verify red**

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/unit/receiptPresentation.test.js backend/tests/unit/receiptPresentationParity.test.js --reporter=verbose
```

Expected: the Task 1 presentation/parity tests remain PASS; only the new store-integration assertions FAIL. If a resolver-state test fails, stop and repair Task 1 instead of continuing.

- [x] **Step 3: Add one live presentation computed**

In `orderSessionStore.js`, import the frontend builder and create:

```javascript
const cartReceiptPresentation = computed(() => buildReceiptPresentation({
  items: cart.value,
  summary: {
    subtotal: cartSubtotal.value,
    tax: cartTax.value,
    total: cartTotal.value
  },
  orderDiscount: {
    type: orderDiscount.value.type || null,
    value: Number(orderDiscount.value.value || 0),
    amount: cartOrderDiscountAmount.value
  },
  taxMode: effectiveTaxInclusive.value ? 'inclusive' : 'exclusive',
  status: 'original'
}));
```

Export it through the store return and `useCart.js`. Build the guest-check v1 from the same frozen cart/totals snapshot. On successful checkout, require `data.receipt_display_v1`, validate it, and place it on `lastOrder`; do not recalculate paid receipt rows from `cartSnapshot`.

- [x] **Step 4: Convert ordered-cart rows and label catalog gross**

In `PosTerminal.vue`:

- map each top-level cart row by stable key to `cartReceiptPresentation.rows`;
- show frozen pre-discount `unitPrice` in Price;
- show `netAmount` in Total;
- keep the existing line-discount badge and add the actual money amount from v1;
- show bundle children as descriptive only;
- change the product card caption to include `{{ $t('incl. tax') }}` in exclusive mode;
- do not change the product-card numeric formula.

The totals panel renders the same v1 summary, including an explicit non-zero Rounding row and the inclusive tax label.

- [x] **Step 5: Convert both POS thermal receipt renderers**

Import `resolveReceiptPresentation` from the existing frontend presentation module. In `ReceiptPreviewModal.vue` compute:

```javascript
const presentationState = computed(() => resolveReceiptPresentation(lastOrder.value));
const presentation = computed(() => presentationState.value.presentation);
const presentationError = computed(() => presentationState.value.error);
```

In `PrintReceiptApp.vue` use the same three computed values with `resolveReceiptPresentation(data.value)`. Do not duplicate validation/catch logic in either SFC. Render:

- item/bundle rows from `presentation.rows`;
- actual line-discount sublines;
- summary fields and optional rounding row;
- `taxLabel` instead of an amount for inclusive mode;
- two decimals everywhere.

Gate the receipt body and every print action on `presentation`. If `presentationError` exists, show a localized receipt error, disable browser/backend print, and do not call `window.print()`. The Task 1 pure resolver test locks idle, valid-v1, absent-v1 legacy, and present-invalid behavior without adding an SFC harness; verify only the rendered branches manually plus through the build.

- [x] **Step 6: Run focused tests and build**

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/unit/receiptPresentation.test.js backend/tests/unit/receiptPresentationParity.test.js --reporter=verbose
npm run build:admin
```

Expected: PASS/build succeeds. Manually preview exclusive, inclusive, line-discount, order-discount, bundle, and service-charge guest checks.

- [x] **Step 7: Commit POS renderers**

```powershell
git add -- assets/js/composables/stores/orderSessionStore.js assets/js/composables/useCart.js src/components/PosTerminal.vue src/components/pos/ReceiptPreviewModal.vue src/print/PrintReceiptApp.vue backend/tests/unit/orderSessionStore.test.js backend/tests/unit/receiptPresentation.test.js
git commit -m "fix(pos): render live and paid receipts from canonical presentation"
```

---

## Task 6: Convert Held Orders and Table Splits

**Files:**
- Modify: `src/components/OrderNotes.vue`
- Modify: `src/components/TableSplits.vue`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Test: `src/utils/orderNotesTax.spec.js`
- Test: `backend/tests/integration/heldOrders.test.js`
- Test: `backend/tests/integration/tables.test.js`

**Interfaces:**
- Held/history/split API rows already carry server-built `receipt_display_v1` from Task 4.
- Components render it directly and retain raw cart/order data only for restore/pay actions.

- [x] **Step 1: Add red held/split display assertions**

Add integration assertions for:

- multi-quantity fixed line discount survives into held v1;
- held mode metadata remains hold-time mode after the global setting changes;
- split v1 includes seat order discount and parent-frozen tax rate even after catalog drift;
- split card `summary.total` equals eventual settled child total;
- a service-charge seat preserves allocated cents and does not recompute the fee line.
- one row with `receipt_display_error` does not invoke the absent-v1 legacy adapter, does not hide neighboring rows, and cannot be previewed/printed/restored as if its money were valid.

Extend pure held tests so raw field aliases normalize without losing discounts.

- [x] **Step 2: Verify red**

```powershell
npx vitest run src/utils/orderNotesTax.spec.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js --reporter=verbose --pool=forks --maxWorkers=1
```

- [x] **Step 3: Remove Order Notes receipt math**

In `OrderNotes.vue`:

- remove `lineDisplayTotal` and the preview-only item remapping that drops discount fields;
- retain `heldOrderTotal` only where restore/legacy logic still requires it, not for v1 rendering;
- render history and held preview rows from `receipt_display_v1.rows`;
- render the canonical summary, order discount label, tax label, and rounding row;
- show two decimals;
- preserve raw held data for the claim/restore action.

For absent v1 old API responses, call `legacyReceiptPresentation` only when `receipt_display_error` is also absent. `receipt_display_legacy_reason='PRE_V1_CENT_MISMATCH'` deliberately selects that adapter and may show a historical-format label. The explicit error marker takes precedence: show a localized “receipt data is invalid” state, disable preview/print/restore/pay for that row, and retain only safe existing cleanup/support actions. Present-invalid v1 likewise shows an error rather than silently recomputing.

- [x] **Step 4: Remove split card/preview arithmetic**

In `TableSplits.vue`:

- remove `(item.qty * item.price)` and `splitCheckTotals` from cards/previews;
- show each split card's `receipt_display_v1.summary.total`;
- show preview financial rows' `netAmount` and full summary;
- keep bundle children descriptive;
- keep raw `cart_data` only for `restoreTableSplit`/pay;
- print requests still identify the held split; backend Task 4 rebuilds authoritative v1.
- apply the same explicit-error precedence; never turn a server-rejected split row into a legacy-calculated total.

- [x] **Step 5: Run suites and build**

```powershell
npx vitest run src/utils/orderNotesTax.spec.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js --reporter=verbose --pool=forks --maxWorkers=1
npm run build:admin
```

Manually verify a parked register hold after a mode change: the parked preview remains accurate, restore shows one warning, and the live cart visibly adopts current mode before payment.

- [x] **Step 6: Commit held/split renderers**

```powershell
git add -- src/components/OrderNotes.vue src/components/TableSplits.vue assets/js/composables/stores/orderSessionStore.js src/utils/orderNotesTax.spec.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js
git commit -m "fix(pos): unify held and split receipt presentation"
```

---

## Task 7: Convert Admin Preview, A4, Delivery, and Reprint Payloads

**Files:**
- Modify: `assets/js/composables/receiptPrint.js`
- Modify: `src/admin/pages/ReportsInvoices.vue`
- Modify: `src/admin/pages/Orders.vue`
- Modify: `src/admin/components/A4Receipt.vue`
- Modify: `src/admin/components/DeliveryInvoice.vue`
- Test: `backend/tests/unit/receiptPrint.test.js`
- Test: `backend/tests/integration/adminRouting.test.js`

**Interfaces:**
- `buildReceiptPayload(order, items, options)` threads a validated server v1 and keeps legacy fields.
- A4/Delivery components receive v1 for normal/new orders; the explicit pre-v1 mismatch response passes raw legacy fields plus `receipt_display_legacy_reason` instead of a null required prop.

- [x] **Step 1: Add red admin payload tests**

Extend `receiptPrint.test.js`:

```javascript
it('threads validated v1 unchanged into browser and spooler reprints', () => {
  const v1 = buildReceiptPresentation({
    items: [{ key: 'a', name: 'Burger', qty: 1, unitPrice: 10 }],
    summary: { subtotal: 10, tax: 1.6, total: 11.6 },
    orderDiscount: { type: null, value: 0, amount: 0 },
    taxMode: 'exclusive'
  });
  const payload = buildReceiptPayload(
    { ...order, receipt_display_v1: v1 },
    items,
    { storeInfo: {} }
  );
  expect(payload.receipt_display_v1).toEqual(v1);
});

it('throws when a present admin v1 is malformed', () => {
  expect(() => buildReceiptPayload({ ...order, receipt_display_v1: { version: 1 } }, items, {}))
    .toThrow(/invalid receipt presentation/i);
});

it('keeps the explicit pre-v1 mismatch on the absent-v1 legacy path', () => {
  const payload = buildReceiptPayload({
    ...order,
    receipt_display_legacy_reason: 'PRE_V1_CENT_MISMATCH'
  }, items, {});
  expect(payload.receipt_display_v1).toBeUndefined();
  expect(payload.receipt_display_legacy_reason).toBe('PRE_V1_CENT_MISMATCH');
  // buildReceiptPayload always remaps items (quantity->qty, product_name->name,
  // price_at_sale->price), so assert the mapped legacy shape, not input equality.
  expect(payload.items).toHaveLength(items.length);
  expect(payload.items[0]).toMatchObject({ qty: 2, name: 'Burger', price: 5 });
});
```

Add route coverage that `order_details` returns v1 for paid, voided, and partially refunded records, plus the Task 4 exact pre-v1 fallback/422 pair.

- [x] **Step 2: Verify red**

```powershell
npx vitest run backend/tests/unit/receiptPrint.test.js backend/tests/integration/adminRouting.test.js --reporter=verbose --pool=forks --maxWorkers=1
```

- [x] **Step 3: Thread the model through admin print helpers**

In `buildReceiptPayload`, validate and include `order.receipt_display_v1`. Keep existing raw item/header fields for the compatibility window. Do not rebuild v1 from admin item data.

In `ReportsInvoices.vue`, store `data.receipt_display_v1` with the selected order, render its rows/summary, and pass the same model to both spooler and browser reprint paths. If and only if the server returned `receipt_display_legacy_reason`, keep the existing legacy renderer and show a small “historical receipt format” label; absence without that marker is an error.

- [x] **Step 4: Convert A4 and delivery documents**

In `Orders.vue`, retain the v1 returned by `order_details`. For normal responses pass:

```html
<A4Receipt :order="selectedOrder" :items="selectedOrderItems" :presentation="selectedOrder.receipt_display_v1" :storeSettings="storeSettings" />
<DeliveryInvoice :order="selectedOrder" :items="selectedOrderItems" :presentation="selectedOrder.receipt_display_v1" />
```

Both components render canonical rows and summary at two decimals. Remove `receiptItemDisplayTotal` and raw percentage-only discount output.

For the explicit pre-v1 mismatch marker, pass the existing order/items through each component's named legacy branch instead of passing `presentation=null`. The legacy branch must be unreachable for a non-null tax-context/new order or a present-invalid v1. Tests render both A4 and Delivery successfully for the `+0.01` and `+0.02` historical fixtures.

`DeliveryInvoice` keeps its editable delivery cost outside v1:

```javascript
const documentGrandTotal = computed(() =>
  Number(props.presentation.summary.total) + Number(shippingCost.value || 0)
);
```

Label it as a separate document charge; never add it to v1 or persisted order money.

- [x] **Step 5: Run tests and build**

```powershell
npx vitest run backend/tests/unit/receiptPrint.test.js backend/tests/integration/adminRouting.test.js --reporter=verbose --pool=forks --maxWorkers=1
npm run build:admin
```

Manually compare admin drawer, A4 PDF preview, delivery document, browser reprint, and backend reprint for one invoice. All base receipt money must be identical; only the explicit delivery charge may extend a delivery document.

- [x] **Step 6: Commit admin documents**

```powershell
git add -- assets/js/composables/receiptPrint.js src/admin/pages/ReportsInvoices.vue src/admin/pages/Orders.vue src/admin/components/A4Receipt.vue src/admin/components/DeliveryInvoice.vue backend/tests/unit/receiptPrint.test.js backend/tests/integration/adminRouting.test.js
git commit -m "fix(admin): render documents from canonical receipt presentation"
```

---

## Task 8: Version and Verify the Physical Spooler Renderer

**Files:**
- Create: `spooler-shared/receiptDisplayV1.cjs`
- Create: `spooler-shared/pos-spooler-server-receipt-v1.patch`
- Create: `backend/tests/unit/spoolerReceiptDisplay.test.js`
- Modify: `docs/SPOOLER-CHANGES.md`
- Read-only compatibility check against: `pos-spooler-printer/server.js`

**Interfaces:**
- Produces `renderReceiptItems(model) -> escaped HTML`.
- Produces `renderReceiptSummary(model) -> escaped HTML`.
- Produces `escapeHtml(value) -> string` for existing header/meta/customer/footer interpolation sites.
- Present-invalid v1 throws `RECEIPT_PRESENTATION_INVALID`; absent v1 stays on the existing legacy path.

- [x] **Step 1: Add red renderer/escaping tests**

Create `backend/tests/unit/spoolerReceiptDisplay.test.js`:

```javascript
const { buildReceiptPresentation, validateReceiptPresentation } = require('../../services/ReceiptPresentation');
const { escapeHtml, renderReceiptItems, renderReceiptSummary } = require('../../../spooler-shared/receiptDisplayV1.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('physical receipt v1 renderer', () => {
  it('escapes user strings and renders net/discount rows', () => {
    const model = buildReceiptPresentation({
      items: [{ key: 'x', name: '<img onerror=alert(1)>', note: '& note', qty: 1, unitPrice: 10 }],
      summary: { subtotal: 10, tax: 1.6, total: 11.6 },
      orderDiscount: { type: null, value: 0, amount: 0 },
      taxMode: 'exclusive'
    });
    const html = renderReceiptItems(model);
    expect(html).toContain('&lt;img onerror=alert(1)&gt;');
    expect(html).toContain('&amp; note');
    expect(html).not.toContain('<img');
  });

  it('renders included tax and a non-zero rounding row', () => {
    const html = renderReceiptSummary(buildReceiptPresentation({
      items: [{ key: 'x', name: 'Sample', qty: 1, unitPrice: 0.1 }],
      summary: { subtotal: 0.1, tax: 0, total: 0.09 },
      orderDiscount: { type: 'percent', value: 1, amount: 0 },
      taxMode: 'inclusive'
    }));
    expect(html).toContain('Included in prices');
    expect(html).toMatch(/Rounding/);
  });

  it('fails closed for present malformed v1', () => {
    expect(() => renderReceiptSummary({ version: 1 })).toThrow(/invalid receipt presentation/i);
  });

  it.each([
    ['large rounding', model => ({ ...model, summary: { ...model.summary, roundingAdjustment: 89, total: 90 } })],
    ['bundle child money', model => ({ ...model, rows: [...model.rows, { ...model.rows[0], key: 'child', kind: 'bundle_child', netAmount: 1 }] })],
    ['negative tax', model => ({ ...model, summary: { ...model.summary, taxAmount: -1, total: 0 } })]
  ])('matches backend rejection for %s', (_name, mutate) => {
    const valid = buildReceiptPresentation({
      items: [{ key: 'x', name: 'X', qty: 1, unitPrice: 1 }],
      summary: { subtotal: 1, tax: 0, total: 1 },
      orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
    });
    const malformed = mutate(valid);
    expect(() => validateReceiptPresentation(malformed)).toThrow(/invalid receipt presentation/i);
    expect(() => renderReceiptSummary(malformed)).toThrow(/invalid receipt presentation/i);
  });

  it('escapes header, customer, and footer strings through the exported helper', () => {
    expect(escapeHtml(`A&B <Store> "quoted" 'single'`))
      .toBe('A&amp;B &lt;Store&gt; &quot;quoted&quot; &#39;single&#39;');
  });

  it('loads from an isolated print-machine directory without the web repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-spooler-'));
    const deployed = path.join(dir, 'receiptDisplayV1.cjs');
    fs.copyFileSync(path.resolve(__dirname, '../../../spooler-shared/receiptDisplayV1.cjs'), deployed);
    try {
      const isolated = require(deployed);
      expect(isolated.renderReceiptSummary(buildReceiptPresentation({
        items: [{ key: 'x', name: 'X', qty: 1, unitPrice: 1 }],
        summary: { subtotal: 1, tax: 0, total: 1 },
        orderDiscount: { type: null, value: 0, amount: 0 }, taxMode: 'exclusive'
      }))).toContain('1.00');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 2: Implement the tracked pure renderer**

Create `spooler-shared/receiptDisplayV1.cjs` as a self-contained deployment artifact. It must not require `backend/`, `spooler-shared/`, or any file outside its own directory. Inline the small v1 validator with the same metadata, non-negative money, two-cent rounding bound, bundle-child-zero, unique-key, row-sum, and summary-footing checks as Task 1. The isolated-directory test locks validator parity for accepted/rejected fixtures. Define and export one `escapeHtml` that replaces `& < > " '`. Validate before interpolation. Render bundle children without money, item discount sublines, two-decimal net amounts, tax label/amount, order discount money/label, optional rounding, and total.

Do not read environment variables, printers, the database, or the DOM in this module.

- [x] **Step 3: Run the renderer tests**

```powershell
npx vitest run backend/tests/unit/spoolerReceiptDisplay.test.js --reporter=verbose
```

Expected: PASS.

- [x] **Step 4: Create a reviewable patch for the ignored local spooler**

Create `spooler-shared/pos-spooler-server-receipt-v1.patch` against the current ignored `server.js`. The deployed patch requires the sibling machine-local file with `require('./receiptDisplayV1.cjs')`; it must not reference `../spooler-shared` or `../backend`. It escapes existing header/meta/customer/footer strings and changes the receipt items/totals blocks to:

```javascript
if (data.receipt_display_v1 !== undefined) {
  htmlContent += renderReceiptItems(data.receipt_display_v1);
} else {
  // Keep the complete existing legacy items block unchanged for old queued jobs.
}
```

and the equivalent `renderReceiptSummary` branch. Do not catch a v1 validation error and fall back. Keep the legacy `receiptItemDisplayTotal` only for absent-v1 jobs.

Do not modify `server.js` from an isolated feature worktree. Verify the patch against the known local installation with a read-only `git apply --check` or equivalent patch check. `docs/SPOOLER-CHANGES.md` and the rollout runbook must explicitly deploy two files to every machine: apply the server patch, then copy the tracked renderer to `pos-spooler-printer/receiptDisplayV1.cjs` beside `server.js`. Start the spooler only after both files exist. Record the exact copy/application commands; never assume the web repository or `spooler-shared/` exists on a print machine.

- [x] **Step 5: Define the rollout physical compatibility experiments**

Record this mandatory post-merge rollout matrix in `docs/SPOOLER-CHANGES.md` and the Task 9 runbook; branch completion may use HTML renderer snapshots, but deployment is blocked until a real print machine passes:

1. print one v1 exclusive receipt with both discount levels;
2. print one v1 inclusive receipt;
3. print a bundle plus service charge;
4. replay a stored old queue payload without v1 and confirm legacy rendering;
5. submit a malformed present v1 and confirm the job fails/retries instead of printing wrong money;
6. verify names/notes containing `<`, `>`, `&`, quotes render as text.

Record outcomes in `docs/SPOOLER-CHANGES.md` without committing printer identifiers or secrets.

- [x] **Step 6: Commit tracked spooler support**

```powershell
git add -- spooler-shared/receiptDisplayV1.cjs spooler-shared/pos-spooler-server-receipt-v1.patch backend/tests/unit/spoolerReceiptDisplay.test.js docs/SPOOLER-CHANGES.md
git commit -m "feat(spooler): render canonical receipt presentation"
```

---

## Task 9: Rollout Runbook, Cross-Surface Audit, and Final Verification

**Files:**
- Create: `docs/superpowers/runbooks/2026-07-11-receipt-display-rollout.md`
- Modify only if audit finds a scoped omission: files from Tasks 1-8

**Interfaces:**
- Produces a deployment sequence that cannot send v1 to an unprepared fleet without a fallback.
- Produces final evidence for database immutability, parity, compatibility, and physical/browser equality.

- [x] **Step 1: Write the rollout runbook**

The runbook must contain these exact gates:

1. database backup;
2. run `apply-orders-tax-mode-at-sale.js` with `RECEIPT_TAX_MODE_MIGRATION_CONFIRM=apply-receipt-tax-mode`;
3. verify nullable column and no money-column changes;
4. deploy/update every physical spooler first: copy self-contained `receiptDisplayV1.cjs` beside each machine's `server.js`, apply the sibling require patch, then verify v1 and absent-v1 fallback before starting the web rollout;
5. deploy backend v1 producer;
6. deploy frontend v1 consumers;
7. smoke matrix for live guest, ordinary hold, open table, split, paid, duplicate, DB reprint, A4, and delivery;
8. rollback: old app ignores column/v1; do not drop the column or legacy renderer;
9. fleet checklist proving every print machine was updated.

- [x] **Step 2: Run a current-data read-only reconciliation scan**

Run a read-only audit that loads parent order items and feeds them through the same `orderPresentationInput`/builder arithmetic used by read routes, using `original_subtotal` for voided rows. Do not substitute algebraically equivalent SQL discount math. Record every nonzero-cent mismatch—`0.01` and `0.02` are not ignored—and group by payment status plus null/non-null `tax_inclusive_at_sale`. Do not modify or auto-repair mismatches.

The same audit reports non-positive quantities, negative stored tax/discount/money, and duplicate/missing source identities separately. These are not covered by the cent-mismatch legacy exception and block rollout until reviewed.

Every mismatch on a non-null/v1-era order blocks rollout. A null-context historical mismatch may proceed only after the exact affected IDs pass the Task 4/7 explicit absent-v1 legacy fallback for details, numeric reprint, duplicate, A4, and Delivery; record the count and IDs in a private deployment artifact, not the repository. Any database/read error or builder reason outside that proven cent-mismatch fallback blocks rollout. Record its reason counts and IDs, then either resolve the data or create and approve the separate reason-specific design required by Task 4 before changing code; suppression-list expansion alone is forbidden.

- [x] **Step 3: Run scoped grep audit**

```powershell
rg -n "receiptItemDisplayTotal|lineDisplayTotal|item\.price_at_sale \* item\.quantity|item\.qty \* item\.price|toFixed\(3\)" src assets backend pos-spooler-printer/server.js
rg -n "receipt_display_v1" backend assets src spooler-shared
git diff --name-only master...HEAD
```

Expected:

- old money formulas remain only inside explicitly named absent-v1 legacy adapters/branches;
- every new flow emits or consumes v1;
- no scoped receipt/document uses three-decimal JD output;
- kitchen/report renderers remain untouched.
- the only new runtime modules are the four files listed under the simplicity budget; no receipt factory/registry/cache/framework or unplanned dependency was added.

- [x] **Step 4: Run focused financial and receipt suites**

```powershell
npx vitest run backend/tests/unit/receiptPresentation.test.js backend/tests/unit/receiptPresentationParity.test.js backend/tests/unit/spoolerReceiptDisplay.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/receiptPrint.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/duplicateReceiptSetting.test.js backend/tests/integration/adminRouting.test.js --reporter=verbose --pool=forks --maxWorkers=1
```

Expected: PASS.

- [x] **Step 5: Run the full suite once with visible progress**

Run directly through Vitest because the repository's pretest schema-drift gate will remain blocked until the production/dev migrations are deliberately applied:

```powershell
npx vitest run --reporter=verbose --pool=forks --maxWorkers=1
```

Expected: every discovered test passes; report the discovered count instead of comparing to a hardcoded number. Do not run another full suite unless code changes after this command.

- [x] **Step 6: Build the frontend**

```powershell
npm run build:admin
```

Expected: successful Vite build with no unresolved ESM/CommonJS imports.

- [ ] **Step 7: Perform the final visual/physical matrix**

For both English/LTR and Arabic/RTL, compare browser thermal and physical output for:

- no discount;
- fixed and percentage item discounts;
- fixed and percentage order discounts;
- mixed tax rates;
- inclusive mode;
- explicit `+0.01` and `-0.01` rounding fixtures;
- bundle children;
- service charge;
- ordinary hold mode-change warning;
- ordinary hold catalog-rate-change warning and current-rate rehydration;
- table/split setting and catalog-rate freeze, including a new line added after drift;
- voided and partially refunded reprints;
- pre-v1 `+0.01` and `+0.02` mismatch legacy reprints, plus a new-version mismatch that fails `422`;
- duplicate customer receipt;
- A4 and delivery document.

For each, verify displayed financial rows sum to Subtotal and the summary equation reaches Total.

- [x] **Step 8: Verify no financial database writes from read/display routes**

In integration tests, snapshot `orders`, `order_items`, `held_orders`, refunds, and service-charge snapshot financial/state fields before calling list/detail/print-preview routes; deep-compare afterward. Print queue insertion itself is expected, but source financial rows must remain unchanged.

- [x] **Step 9: Commit runbook and any scoped audit correction**

```powershell
git add -- docs/superpowers/runbooks/2026-07-11-receipt-display-rollout.md
git commit -m "docs(pos): add receipt display rollout runbook"
```

If the audit required a code correction, commit that correction separately before the runbook with a focused `fix(...)` message and rerun its affected suite plus the final full suite.

---

## Deferred and Explicitly Excluded

- Tax-exempt sale authorization, persistence, receipts, edits, refunds, and audit.
- Historical service-charge snapshot backfill.
- Modifier stable IDs and modifier surcharge tax policy.
- Bundle corrupt-parent recovery.
- C2 pre-pin split service-charge allocation refinement.
- Removal of legacy receipt payload fields and the legacy spooler branch; do that only after the deployed queue retention window has elapsed and every print machine reports v1 capability.
- A durable one-time claim-context subsystem for ordinary register holds. Holds remain provisional by owner decision.

## Expected Commit Sequence

1. `feat(pos): define canonical receipt presentation model`
2. `feat(pos): persist receipt tax mode at durable boundaries`
3. `fix(pos): freeze durable tax context through settlement`
4. `feat(pos): emit authoritative receipt presentation data`
5. `fix(pos): render live and paid receipts from canonical presentation`
6. `fix(pos): unify held and split receipt presentation`
7. `fix(admin): render documents from canonical receipt presentation`
8. `feat(spooler): render canonical receipt presentation`
9. `docs(pos): add receipt display rollout runbook`

## Definition of Done

- Nine reviewable task commits, plus only separately justified correction commits.
- New ordinary flows carry valid v1; authoritative routes rebuild rather than trust it.
- Present-invalid v1 fails closed; absent v1 preserves queued legacy jobs.
- An irreconcilable DB read may use absent-v1 legacy rendering only for a pre-v1 historical order with null frozen tax context and the explicit `PRE_V1_CENT_MISMATCH` reason; new-version mismatches return `422`.
- Browser, held, split, admin, duplicate, DB-reprint, and physical receipt money agrees.
- Open table/split setting or catalog changes cannot alter frozen mode or existing line rates; new lines adopt current rates once. Ordinary holds restore visibly under current mode/rates with one warning.
- Row/subtotal and summary/total equations conserve exact cents.
- Paid/historical financial rows remain byte-identical.
- Focused suites, seeded coverage, full suite, build, schema checks, and physical matrix pass.
- Production migrations remain unapplied until the runbook is deliberately executed.
