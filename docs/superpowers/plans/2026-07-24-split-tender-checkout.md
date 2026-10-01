# Split-Tender Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable a cashier to complete one order with both cash and card, conserve the order total exactly, persist each tender independently, and print customer receipts with separate `Cash` and `Card` rows.

**Architecture:** Preserve the existing `payment_method='split'`, `cash_amount`, and `card_amount` database contract. Deepen the existing checkout validation and request-builder modules instead of adding a payment framework: the cashier enters the card charge and physical cash received; the application derives the cash allocation, balance, and change. Paid receipt paths carry the authoritative persisted tender fields and render two tender rows rather than presenting `Split` as if it were a third tender.

**Tech Stack:** Vue 3, Pinia, Express, MySQL, Vitest, Supertest, Vite, existing HTML thermal spooler.

## Global Constraints

- Ponytail full: reuse the existing split state, request builder, validation, order columns, reporting queries, and receipt layouts.
- No database migration, payment-provider interface, terminal authorization, event bus, plugin system, or unrelated checkout redesign.
- `split` is the checkout mode; customer-facing tender rows are `Cash` and `Card`.
- A true split requires both cash and card allocations to be greater than zero.
- The card allocation must be less than the total; cash allocation is the exact remainder.
- Physical cash received may exceed the cash allocation; only the excess becomes change.
- All comparisons and derived allocations operate at currency-cent precision.
- Backend validation remains authoritative for direct register, saved table, and split-check settlement checkout paths.
- Existing cash-only and card-only behavior must remain unchanged.
- JoFotara, daily reports, shift totals, refunds, subscriptions, and duplicate checkout recovery continue using the persisted order fields.

---

## Evidence and current path

- Toast documents multiple payments on one check as a supported split-payment workflow, distinct from splitting one order into separate checks: https://central.toasttab.com/articles/Knowledge/Linking-a-Credit-Card-or-Debit-Card-To-A-Loyalty-Account
- Oracle Simphony treats payments as individual tenders that reduce the remaining check balance, supports cash over-tender/change, and prints each partial payment on the customer receipt: https://docs.oracle.com/en/industries/food-beverage/simphony/19.7/sipou/F96892_03.pdf
- Oracle's broader multiple-tender model can repeat tenders (including multiple cards), but this phase deliberately closes the verified Cash + Card weakness without introducing a generic tender ledger: https://docs.oracle.com/en/industries/food-beverage/simphony/19.4/sipou/t_payment_multiple_credit_card.htm
- `src/components/pos/CheckoutModal.vue` renders Cash and Card but disables Split.
- `src/pos/stores/orderUiStore.js` already owns `splitCardAmount` and `splitCashTendered`.
- `src/pos/stores/orderSessionStore.js` already derives split change/balance and sends both values.
- `src/pos/stores/orderSession/checkoutFlow.js` already builds `payment_method`, `cash_amount`, `card_amount`, `amount_tendered`, and `change_due`, but uses floating subtraction and does not carry tender fields into `lastOrder`.
- `backend/services/CheckoutValidation.js` already accepts split payments, but tolerates cent mismatches and permits a nominal split with one zero tender.
- `backend/modules/checkout/executeCheckout.js` persists `cash_amount` and `card_amount`; normal and duplicate success responses omit them.
- Shift, dashboard, and report queries already sum `cash_amount` and `card_amount`, so a correctly persisted split naturally contributes to both.
- `backend/routes/print.js` securely reloads paid orders but omits the two tender fields from its receipt payload.
- `src/shared/receiptPrint.js`, `src/components/pos/ReceiptPreviewModal.vue`, and `pos-spooler-printer/server.js` currently render only Payment/Tendered/Change.

## Strict execution prompt

> Implement only the split-tender checkout described in this plan. Start from the existing contract; do not invent a payment provider, adapter, composable, store, database table, or generic receipt model. Before each production edit, add the smallest behavioral test and observe the expected failure. Treat monetary allocation in integer cents. Preserve cash-only/card-only behavior and all existing table/split-check semantics. A split succeeds only when `cash_amount + card_amount === total`, both allocations are positive, card is below total, physical cash received covers the derived cash allocation, and `change_due` equals the excess cash received. Return and print authoritative `cash_amount` and `card_amount` on normal and duplicate checkout paths. On customer receipts, show separate Cash and Card rows; do not show `Split` as a tender label. Inspect every receipt entry point and every response path, then run focused unit, integration, renderer, and build verification. If evidence contradicts the plan, stop and correct the plan before widening scope.

### Task 1: Harden the authoritative split-payment contract

**Files:**
- Modify: `backend/tests/unit/helpers.test.js`
- Modify: `backend/services/CheckoutValidation.js`

**Interfaces:**
- Consumes: `validatePayments(data, total)`.
- Produces: normalized `{ paymentMethod, amountTendered, cashAmount, cardAmount, changeDue }` with exact-cent split invariants.

- [ ] Add failing tests proving a split rejects zero cash, zero card, a one-cent sum mismatch, insufficient physical cash, and incorrect change; prove `5.00 cash + 6.60 card = 11.60` succeeds and cash over-tender produces valid change.
- [ ] Run `npx vitest run backend/tests/unit/helpers.test.js` and verify the new tests fail for the missing invariants.
- [ ] Implement cent-based split validation in `CheckoutValidation.js` without changing non-split normalization beyond what the tests require.
- [ ] Re-run the focused unit test and verify it passes.

### Task 2: Make request and response tender data exact and complete

**Files:**
- Modify: `backend/tests/unit/checkoutFlow.test.js`
- Modify: `src/pos/stores/orderSession/checkoutFlow.js`
- Modify: `backend/tests/integration/checkout.test.js`
- Modify: `backend/modules/checkout/executeCheckout.js`

**Interfaces:**
- Consumes: UI payment `{ method, splitCardAmount, splitCashTendered, changeDue }`.
- Produces: exact-cent checkout payload and success `lastOrder` carrying `cash_amount` and `card_amount`.

- [ ] Add failing request-builder cases for decimal edge values and success-result cases requiring both tender fields.
- [ ] Observe focused unit failure with `npx vitest run backend/tests/unit/checkoutFlow.test.js`.
- [ ] Derive card, cash remainder, physical tender, and change using integer cents in `buildCheckoutRequest`; copy authoritative response fields into `lastOrder`, falling back to the frozen payload only when absent.
- [ ] Add integration assertions that normal split checkout returns and persists both fields and that invalid split allocations receive HTTP 400 without creating an order.
- [ ] Add `cash_amount` and `card_amount` to normal and duplicate checkout responses.
- [ ] Run the focused unit and checkout integration tests.

### Task 3: Enable the cashier split workflow

**Files:**
- Create: `src/components/pos/__tests__/checkoutSplitPayment.spec.js`
- Modify: `backend/tests/unit/orderSessionBoundaries.test.js`
- Modify: `src/components/pos/CheckoutModal.vue`
- Modify: `src/pos/useCart.js`
- Modify: `src/pos.css`
- Modify: `src/shared/i18n.js`

**Interfaces:**
- Consumes: existing `splitCardAmount`, `splitCashTendered`, `splitBalanceDue`, `changeDue`, and `cartTotal` refs.
- Produces: accessible split selection, card-charge field, cash-received field, derived cash allocation/balance/change, and guarded confirmation.

- [ ] Add a failing component contract test requiring an enabled Split option, two labeled decimal inputs, derived Cash/Card summary, split shortfall/error state, and mobile-safe CSS.
- [ ] Observe failure with `npx vitest run src/components/pos/__tests__/checkoutSplitPayment.spec.js`.
- [ ] Bind the existing split refs in `CheckoutModal.vue`; display Card, Cash due, Cash received, Balance due, and Change without adding new state ownership.
- [ ] Disable confirmation when split values are non-finite, either allocation is zero, card is not below total, or balance remains.
- [ ] Add only the required existing-theme CSS and Arabic strings; keep the current responsive modal behavior.
- [ ] Run the component contract test and existing checkout/store unit tests.

### Task 4: Print Cash and Card as the customer-facing tenders

**Files:**
- Modify: `backend/tests/unit/receiptPrint.test.js`
- Modify: `src/shared/receiptPrint.js`
- Create: `src/components/pos/__tests__/receiptSplitPayment.spec.js`
- Modify: `src/components/pos/ReceiptPreviewModal.vue`
- Modify: `src/admin/components/A4Receipt.vue`
- Modify: `backend/tests/integration/print.authz.test.js`
- Modify: `backend/routes/print.js`
- Modify: `backend/tests/unit/spoolerReceiptDisplay.test.js`
- Modify: `pos-spooler-printer/server.js`

**Interfaces:**
- Consumes: authoritative `payment_method`, `cash_amount`, `card_amount`, `amount_tendered`, and `change_due`.
- Produces: identical split-tender presentation in immediate preview, browser print, POS thermal spooler, and admin reprint.

- [ ] Add failing payload tests requiring `cash_amount` and `card_amount` passthrough.
- [ ] Add failing receipt component/renderer tests proving split receipts contain Cash and Card rows and do not render `Payment: Split`.
- [ ] Add a paid-order print integration assertion proving the server replaces client values with persisted cash/card amounts.
- [ ] Thread both fields through immediate and secure-reprint payloads.
- [ ] Render two rows for split payment in both receipt-preview branches and the spooler; retain Payment/Tendered/Change for cash/card receipts and retain Change for split when non-zero.
- [ ] Run all focused receipt and print tests.

### Task 5: Adversarial verification and scope audit

**Files:**
- Modify only if a focused test exposes a defect in the files above.

- [ ] Run focused unit tests for checkout validation, request construction, UI state, receipt payloads, receipt rendering, and source contracts.
- [ ] Run checkout and print authorization integration tests.
- [ ] Run subscription split-purchase and business-day/shift financial tests because they consume both tender fields.
- [ ] Run `npm run build:admin`.
- [ ] Search for disabled Split controls and receipt paths that still present `split` as the sole customer-facing tender.
- [ ] Review `git diff --check`, `git status --short`, and the complete diff against every Global Constraint.
- [ ] Do not merge automatically; report the tested feature branch for owner review.
