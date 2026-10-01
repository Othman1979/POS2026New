# Scale Barcode Support Implementation Plan

**Goal:** Accept the customer's EAN-13 scale labels while preserving ordinary barcode behavior and every existing product money path.

**Branch:** `codex/scale-barcode-support`

## Fixed behavior

- An exact full product barcode always wins and adds quantity `1`.
- Only an exact miss may fall back to a valid scale label.
- Scale format: leading `0`, six-digit product barcode, five-digit total in cents, EAN-13 checksum.
- A scale result uses the current sales-context product price and derives six-decimal quantity from the encoded gross total.
- The cart receives a normal catalog product. Held orders, tables, checkout repricing, stock, receipts, and refunds stay unchanged.
- Invalid checksum, zero total, missing/ineligible product, note product, unavailable product, zero price, or unrepresentable quantity adds nothing.
- No schema, setting, permission, dependency, cache, custom product type, or alternate checkout path.

## Task 1: Decode scale labels at the catalog boundary

**Files:**
- Create `backend/services/scaleBarcode.js`
- Create `backend/tests/unit/scaleBarcode.test.js`

1. Add RED unit cases for both photographed labels, invalid checksum, wrong prefix/length/non-digits, zero total, and the maximum valid five-digit-cent total.
2. Run `npx vitest run backend/tests/unit/scaleBarcode.test.js` and confirm the missing module/function failure.
3. Implement one pure `decodeScaleBarcode()` helper with no dependency.
4. Run the focused test GREEN.
5. Commit: `feat(pos): decode scale barcodes safely`

## Task 2: Resolve exact barcodes before scale fallback

**Files:**
- Modify `backend/routes/pos/catalog.js`
- Modify `backend/tests/integration/bundle.catalog.test.js`

1. Add RED real-MySQL route cases proving:
   - `0100000040591` resolves six-digit product `100000` with `scale_total_cents: 4059`;
   - an exact product with the full 13-digit barcode wins with no scale amount;
   - even an exact but ineligible full barcode blocks fallback to a different product;
   - invalid checksum and missing decoded products remain unknown;
   - register price-list resolution still supplies the effective price;
   - ordinary barcodes keep their existing response.
2. Run only the barcode/catalog integration file and confirm RED.
3. Extend the existing lookup query so a valid scale scan checks exact and decoded candidates in one indexed lookup, orders exact first, and forbids decoded fallback whenever any exact full-barcode row exists. Keep the existing sales-context and subscription exclusions.
4. Return `scale_total_cents` only when the decoded six-digit product actually won.
5. Run the focused integration file GREEN.
6. Compare instrumented ordinary and scale route requests; scale must not add a database command beyond ordinary uncached lookup.
7. Commit: `feat(pos): resolve scale barcodes through catalog authority`

## Task 3: Convert scale totals to normal cart quantities

**Files:**
- Modify `src/pos/useTerminal.js`
- Modify `src/pos/stores/orderSessionStore.js`
- Modify `backend/tests/unit/useTerminal.test.js`
- Modify `backend/tests/unit/orderSessionStore.test.js`

1. Add RED cases proving:
   - ordinary local/exact scans still call `addToCart` with barcode source and quantity `1` behavior;
   - a scale response forwards its gross target amount once;
   - malformed scale metadata adds nothing;
   - context-switch races still drop the result;
   - 40.59 at 11.00 becomes `3.690000` and 54.36 at 12.00 becomes `4.530000`;
   - taxed products derive quantity from gross unit price;
   - zero-price, sold-out, stock-insufficient, and below-six-decimal quantities fail closed;
   - repeated scans merge quantities through the existing barcode path without duplicate requests.
2. Run the two focused unit files and confirm RED.
3. Generalize the existing Quick Numpad target-amount calculation to accept an explicit positive `targetAmount` option. Do not create another calculator.
4. Pass validated `scale_total_cents / 100` from the terminal lookup into `addToCart`; leave normal scans untouched.
5. Run the focused unit files GREEN.
6. Commit: `feat(pos): add weighed items as fractional quantities`

## Task 4: Prove the existing downstream paths remain authoritative

**Files:** tests only unless a proven defect requires the smallest correction.

1. Run focused held-order, checkout, inventory, refund, and table tests covering six-decimal quantities.
2. Run a disposable real-MySQL flow: seed a six-digit product, resolve a photographed label, build the normal cart line, hold/restore it, checkout it, and verify invoice quantity, gross total, and stock movement; roll back or reseed afterward.
3. Run the complete scanner/catalog/cart focused set together to expose shared-state ordering failures.
4. Run `npm run architecture:check`; update `docs/architecture.json` only if an existing traced boundary became inaccurate.
5. Review the complete branch diff for alternate money paths, stale UI state, ordinary-barcode regressions, secrets, schema drift, or unnecessary abstractions.
6. Commit any test-only closure as `test(pos): prove scale barcode money paths`; do not create an empty commit.

## Acceptance

- Both photographed labels resolve to product `100000` and totals 40.59/54.36.
- Exact ordinary barcodes are never interpreted as scale labels.
- Scale scanning adds a normal fractional-quantity line and never overrides unit price.
- Current register/table pricing, tax, stock, held orders, checkout, receipt, and refund behavior remain authoritative.
- Offline or invalid scale lookup adds nothing rather than guessing from stale catalog data.
- Scale lookup has the same DB-command count as ordinary uncached barcode lookup.
- Focused tests and the disposable real-MySQL flow pass with a clean worktree except committed plan/implementation changes.
