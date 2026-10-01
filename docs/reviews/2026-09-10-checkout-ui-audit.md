# Checkout and related UI audit — 2026-09-10

Audit only. No application code, tracked tests, commits, or pushes were changed. Temporary experiments live under ignored `scratch/`. Isolated checks used a generated loopback database (`posapp_review_recipe_p1_02f71eda7a77`) and removed only that database. The application/customer database was not used.

Branch: `codex/checkout-receipt-formatter` at `48e6721d`. Ten Grok investigators were dispatched in parallel across the requested areas. Every finding below was re-traced in source and, where noted, reproduced here. Agent-only claims that could not be re-verified are omitted.

This report does not claim the checkout UI is clean. Several existing suites passed while the reproduced defects below remained.

Confirmed money-path / recovery issues: **C1**, **C6–C8**, **C15–C17** (High); **C2**, **C3**, **C5**, **C9–C14**, **C18** (Medium); **C4** (Low). See the rejected-claims table for investigator notes that were not promoted.

## Recent fixes

### ad56bb48 — receipt template could not access `formatBusinessDateTime`

**Status: fixed on this branch.**

`ReceiptPreviewModal.vue` imports `formatBusinessDateTime` and returns it from `setup()`. The thermal “Taken At” line binds `formatBusinessDateTime(lastOrder.order_taken_at || lastOrder.date)`. The on-screen meta line still uses `receiptTakenTime` → `formatBusinessTimeShort` (short clock, not a missing-symbol crash).

Sibling print surfaces already expose a formatter (`PrintReceiptApp.vue` returns `formatBusinessDateTime`; `ShiftReportModal.vue` returns it; `A4Receipt.vue` and `TableSplits.vue` return a `formatDateTime` wrapper).

Evidence: `src/components/pos/__tests__/receiptPreviewRender.spec.js` (5 cases) plus scratch presence check.

### 48e6721d — `useCart` omitted `syncCheckoutPaymentForOrderType`

**Status: fixed on this branch.**

`src/pos/useCart.js` re-exports `syncCheckoutPaymentForOrderType: session.syncCheckoutPaymentForOrderType`. `CheckoutModal.vue` destructures it and calls it from `clearOrderType` / `applyOrderType`. Isolated store tests render the modal after those handlers for platform, clear, table, and receivable.

The original crash class (calling an undefined facade action when selecting or clearing an order type) is closed. Remaining order-type issues below are different: selected-state coercion and hash focus, not a missing export.

---

## Confirmed defects

### C1 — Charged sale, then invalid `receipt_display_v1`, is shown as a network failure and the retry becomes a no-op

| Field | Detail |
| --- | --- |
| Severity | **High** |
| Location | `processCheckout` in `src/pos/stores/orderSessionStore.js` **2476–2480**, **2550–2552**; `buildSuccessfulCheckoutResult` → `validateReceiptPresentation` in `src/pos/stores/orderSession/checkoutFlow.js` **178–181** and `src/utils/receiptPresentation.js` **7–11** |
| Trigger | 1. Cart has items. 2. Pay. 3. Server returns `success: true` **and** a `receipt_display_v1` that fails validation (missing required summary/rows). 4. Cashier taps Pay again without changing the cart. 5. Optional: change quantity and pay again. |
| Observed | First attempt: `checkoutError` becomes `"Network error. Could not connect."`, cart is kept, `lastOrder` stays null, success toast does not run. Second attempt with the same fingerprint: HTTP checkout is sent again, then `completedCheckoutKeys.has(checkoutKey)` returns early. Cart still has items, `checkoutError` is cleared, print never runs. Changing the cart rotates the idempotency key. |
| Impact | The sale is already committed. The cashier is told the network failed and still has the cart. A same-cart retry does not finalize or show a receipt. A changed-cart retry can charge a second invoice. |
| Evidence | `npx vitest run --config scratch/vitest.checkout-audit.config.mjs` — case `treats a charged sale with invalid receipt display as a network error and then ignores the retry` (pass). Existing `processCheckout isolates a receipt-print failure` only covers `printReceipt` rejection, not a throw from `buildSuccessfulCheckoutResult`. |
| Recommended fix | Add the key to `completedCheckoutKeys` only after `buildSuccessfulCheckoutResult` succeeds, or catch presentation failures inside the success arm. On presentation failure after a charged sale, finalize the draft, show a receipt-layout warning, and never map that throw to `"Network error. Could not connect."`. A same-key success retry must still finalize if the first success arm aborted. |

`completedCheckoutKeys.add` runs before `buildSuccessfulCheckoutResult`. Any throw there falls into the outer `catch` and is labeled a network error. Print failures are already isolated; this path is not.

The backend usually omits `receipt_display_v1` when it cannot build one (`executeCheckout.js` duplicate-success path). The hole is still live for a present-but-invalid v1 object, and for any other throw between the `add` and `finalizeCheckout`.

### C2 — Kitchen (and shared spooler) print failure after a charged sale uses a generic error toast

| Field | Detail |
| --- | --- |
| Severity | **Medium** |
| Location | `processCheckout` kitchen dispatch `src/pos/stores/orderSessionStore.js` **2485–2487** (not awaited); `dispatchToNodeSpooler` `src/pos/useTerminal.js` **258–274**, toast ``Print failed: ${message}`` |
| Trigger | Complete a register sale (not a table, not an already-fired held kitchen). Kitchen or receipt spooler POST fails. |
| Observed | Cart is cleared, `checkoutError` stays empty, “Paid Successfully” can still run. An error toast says `Print failed: …`. Hold uses a different, accurate string: “Order saved. Customer receipt was not printed…”. |
| Impact | Cashier can believe payment failed after the sale has already finalized. Duplicate charge risk if they re-ring. Kitchen ticket may also be missing. |
| Evidence | Scratch case `uses the generic Print failed toast for kitchen dispatch after a charged sale`. Source: kitchen call is fire-and-forget into the same helper that always toasts `'error'`. Isolated test “does not surface a checkout error when printReceipt rejects” only asserts `checkoutError === ''`. |
| Recommended fix | After a committed sale, print/kitchen failures should use a warning that the sale is complete (same pattern as hold / JoFotara). Do not reuse the unpaid-looking `Print failed` error toast. Await kitchen dispatch only for logging, not for checkout success. |

The same toast also fires for backend receipt print after charge (`printReceipt` → `dispatchToNodeSpooler`) and for subscription collect/reverse/refund receipt queueing. Those are the same defect class.

### C3 — Order-type selected state uses `===` while the click handler uses `String(...)`

| Field | Detail |
| --- | --- |
| Severity | **Medium** |
| Location | Template `src/components/pos/CheckoutModal.vue` **75–76** (`selectedOrderType === type.id`); click path `toggleOrderType` **652–663** (`String(selectedOrderType.value) === String(type.id)`); restore `restoreHeldOrder` `src/pos/stores/orderSessionStore.js` **1054** (raw `payload.order_type_id`, not normalized) |
| Trigger | Open checkout when `selectedOrderType` is the string `"3"` and catalog `type.id` is the number `3` (held `cart_data` / mixed API JSON). The selected type looks unselected. Click it. |
| Observed | Rendered HTML has no `order-type-option is-selected`. Click is treated as “already selected” and clears the type or snaps to the default. `syncCheckoutPaymentForOrderType()` then resets settlement (platform → cash, split leftovers cleared). |
| Impact | Wrong highlight; a click meant to confirm the type can wipe it and change payment method. Platform/receivable settlement can silently fall back to cash UI. |
| Evidence | Scratch case `renders the selected mark when the restored type id is a string and catalog ids are numbers` — HTML contains the name and does **not** contain `order-type-option is-selected`. Persisted register context *does* normalize via `positiveInteger` (`orderSessionPersistence.js` **142**); held restore does not. The click handler already coerces, which is why the template `===` is the leftover gap. |
| Recommended fix | Use `String(selectedOrderType) === String(type.id)` in the template class and `aria-pressed`. Normalize `order_type_id` in `restoreHeldOrder` the same way persisted context does. |

### C4 — Hash field never receives focus after selecting a hash-required type

| Field | Detail |
| --- | --- |
| Severity | **Low** |
| Location | `handleOrderTypeSelection` `src/pos/stores/orderSessionStore.js` **1591–1595** (`document.getElementById('hashInput')`); input `src/components/pos/CheckoutModal.vue` **90–91** (`id="checkout-hash"`) |
| Trigger | Select an order type with `requires_hash == 1`. |
| Observed | `getElementById('hashInput')` is the only use of that id in the repo. The visible input is `checkout-hash`. Focus is a no-op. Checkout still blocks pay with `"A Hash Number is required for this order type!"` if left empty. |
| Impact | Extra keystrokes only. No crash, no wrong charge. |
| Evidence | Repo-wide search: one `hashInput` read, zero `id="hashInput"`. Scratch case `focuses a hashInput id that checkout modal does not render`. |
| Recommended fix | Focus `#checkout-hash` (or a shared ref). |

### C5 — Failed held-order handoff is retried on later POS activation and can replace an unrelated draft

| Field | Detail |
| --- | --- |
| Severity | **Medium** |
| Location | `OrderNotes.vue` `restoreHeldOrder` catch **911–919** (handoff left in place on network failure — intentional D5); `PosTerminal.vue` `checkAndRestoreHeldOrder` catch **1021–1023** (does not clear handoff, no toast); `onActivated` **1217–1219** retries when KeepAlive returns |
| Trigger | 1. Restore a held ticket; claim/network fails after `storeHeldOrderHandoff`. 2. Start a new register sale on POS. 3. Leave POS and return (Tables → POS) after the claim can succeed. |
| Observed | Retry claims and calls `restoreHeldOrder`, which `clearOrderSlice`s first. The in-progress walk-in cart is replaced. Failed POS-side restore only `console.error`s. |
| Impact | Lost in-progress register items. The held ticket may load later, which is the recovery goal, but there is no “cart already dirty” guard. |
| Evidence | Code trace. OrderNotes comments document leaving the envelope for recovery. `onActivated` retries without checking `cart` length or draft sequence. Not browser-replayed in this pass. |
| Recommended fix | Clear or expire the handoff after an operator starts a new draft. If retrying, confirm before replacing a non-empty cart that is not that held order. Surface POS-side restore failure with a toast, not only `console.error`. |

### C6 — Receivable checkout silently drops extra cart lines

| Field | Detail |
| --- | --- |
| Severity | **High** |
| Location | Client: `addToCart` `orderSessionStore.js` **~2082** (no `pendingSubscriptionSale` lock); `closeCheckoutModal` `orderUiStore.js` **75–79** does not cancel the pending sale. Server: `executeCheckout.js` **~823–827** rewrites a receivable cart to one plan line **before** the “exactly one plan” check **~1477**. |
| Trigger | Start a subscription receivable. Close checkout (sale stays pending). Add ordinary products. Reopen checkout and confirm ISSUE RECEIVABLE. |
| Observed | UI totals can include the extra lines. Server accepts the receivable and charges the plan only. Paid mixed carts still 400; receivable does not. |
| Impact | Customer is billed the plan. Extra items never appear on the invoice. Cashier can believe they sold both. |
| Evidence | Source as above. Scratch: `does not lock add-to-cart or Pay against a pending subscription or in-flight hold`. Official suites do not mix extra lines onto a pending receivable. |
| Recommended fix | Keep `pendingSubscriptionSale` exclusive: refuse `addToCart`, or cancel the sale when the cart changes. Server should reject extra lines on receivable instead of rewriting them away. |

### C7 — Sibling split checks share one payment idempotency fingerprint

| Field | Detail |
| --- | --- |
| Severity | **High** |
| Location | `buildCheckoutFingerprintSource` `checkoutFlow.js` **46–47** (`activeTableId` + `activeTableOrderId` only). Cache: `checkoutAttemptCache.js` `resolveCheckoutAttemptKey`. `openCheckoutModal` clears the in-memory key then reuses the persisted key when the fingerprint matches. `processCheckout` **2513–2516**: superseded success skips `finalizeCheckout` and therefore skips `clearCachedCheckoutAttempt`. |
| Trigger | Open or fail checkout on check A, then Pay sibling check B on the same table with the same lines, totals, and tender (two identical coffees / seats). Restored splits typically share one table id and `current_order_id: null`. |
| Observed | Fingerprint omits `split_check_id`, `split_revision`, and `parent_invoice_id`. Cart rows omit `order_item_id`. Backend `findOwnedCheckoutAttempt` / `ER_DUP_ENTRY` can return check A’s invoice as success for B. |
| Impact | UI can clear check B and show paid. Check B’s held row can remain unpaid. Customer B is not charged; A is replayed. Combined with C9, a superseded success still toasts/prints. |
| Evidence | Scratch: `fingerprintForSplit(80) === fingerprintForSplit(81)`; fingerprint function text has no `split_check_id` / `split_revision`. `orderWorkflowTransitions.spec.js` restores and pays one check, not two siblings. |
| Recommended fix | Put `split_check_id`, `split_revision`, and `parent_invoice_id` in the fingerprint. Do not reuse a cached key when the split identity changed. Drop the submitted key even when the draft was superseded. |

### C8 — Split Pay can restore `table_id: null`; settle is rejected

| Field | Detail |
| --- | --- |
| Severity | **High** |
| Location | `restoreTableSplit` `tableOrderWorkflow.js` **1344–1412** (table id from `restaurantTables` name regex only). Board `processedSplits` `TableSplits.vue` **389–412** already keeps `table_id`. Server `executeCheckout.js` **520–522** requires a table id bound to the parent invoice. |
| Trigger | Board Pay when the parent table is missing from `restaurantTables` (section wall, workspace miss, renamed number, `"Table 7 - Check 2"` ≠ `table_number`). |
| Observed | Restore ignores `splitCheck.table_id`. Checkout posts `table_id: null`. Server: “This split check is not linked to the selected table.” `wasTableOrder` is also false when `table_id` is null. |
| Impact | Pay opens POS, then Confirm dies. Check stays on the board. A hypothetical success would kitchen-fire and skip table teardown. |
| Evidence | Transition test seeds `restaurantTables = [{ id: 7, table_number: '7' }]` and a matching reference. No official case without a matching floor row. |
| Recommended fix | Prefer `splitCheck.table_id` (and parent invoice/order ids). Use name lookup only as fallback. Refuse Pay if the id is still missing. |

### C9 — Stale checkout success still toasts and prints after a newer draft owns the session

| Field | Detail |
| --- | --- |
| Severity | **Medium** (High if combined with C7) |
| Location | `processCheckout` `orderSessionStore.js`: `finalizeCheckout` / `clearActiveTableSession` only when `isCurrentOrderSession(checkoutOwner)` **2513–2516**; `showPaymentSuccess` **2532** is outside that guard. KeepAlive `PosTerminal.onActivated` **1194–1211** sets `showCheckoutModal = false` and `isProcessing = false` without aborting the in-flight request. |
| Trigger | Confirm checkout, then immediately switch tables / Pay another check / return to POS while the first request is still in flight. |
| Observed | Historical ownership still prevents the first success from wiping the newer cart (`orderWorkflowTransitions` “stale error stays off the new draft”). The first success still runs the success toast and print. KeepAlive close also lets a second Pay start. |
| Impact | Wrong receipt can print. With C7, the wrong invoice can also be treated as the sibling’s payment. |
| Evidence | Source vs transition test (asserts stale **error** only). Not browser-replayed. |
| Recommended fix | Gate toast/print on `ownsCheckoutSession`. Keep a busy/owner token across KeepAlive so a second Pay cannot start while the first request is open. |

### C10 — Pay is allowed while hold or follow-up is in flight

| Field | Detail |
| --- | --- |
| Severity | **Medium** |
| Location | `processCheckout` **2429** `if (ui.isProcessing) return` only. Confirm `:disabled="!canPay \|\| isProcessing \|\| paymentBlocked"` (`CheckoutModal.vue`). `holdCurrentOrder` already guards `isHolding \|\| isProcessing` **~849**. Board Pay `TableSplits.vue` **458–461** is not disabled for `isProcessing`. `restoreTableSplit` **1339–1346** has no busy gate (unlike `confirmSplit` **1138**). |
| Trigger | Click Pay while Hold/Follow Up is running, or double-click board Pay / Pay check B while restore A is still in `await loadTableWorkspace`. |
| Observed | Two overlapping writes can race. Last `loadTableOrder` wins on the board. Not a second `splitTable` post (that path is still guarded). |
| Impact | Wrong check in the cart, or hold + checkout on the same draft. |
| Evidence | Scratch source assertions on `processCheckout` and Confirm disabled attrs. Official hold tests cover hold’s own guard, not Pay-during-hold. |
| Recommended fix | Same busy gate as `confirmSplit` / hold. Disable Confirm and board Pay while `isHolding` or `isProcessing`. After workspace load, abort if a newer restore owns the session. |

### C11 — Persist drops `baselineUnknown`; Pay/Follow Up reappear after reload

| Field | Detail |
| --- | --- |
| Severity | **Medium** |
| Location | `normalizeHeldOrderContext` `orderSessionPersistence.js` **42–56** keeps `kitchenFired`, omits `baselineUnknown`. UI `PosCartWorkspace.vue` **440–453** gates Follow Up / Pay / Confirm baseline on that flag. |
| Trigger | Restore a kitchen-fired held ticket whose baseline is unknown. Reload or leave/return POS so context is persisted and rehydrated. |
| Observed | After reload, Pay and Follow Up show; the baseline-confirm gate hides. Later server 409 `HELD_KITCHEN_BASELINE_UNKNOWN`. |
| Impact | Operator is offered actions the server will reject. Session before reload was correctly locked. |
| Evidence | Scratch: `writeOrderContext` then `readOrderSnapshot` — `kitchenFired` remains, `baselineUnknown` is absent. |
| Recommended fix | Persist `baselineUnknown` with the held context and restore it on hydrate. |

### C12 — Browser guest check is rendered as a normal receipt

| Field | Detail |
| --- | --- |
| Severity | **Medium** (higher if `printMethod === 'browser'`) |
| Location | `guestOrder` `orderSessionStore.js` **2617–2644**: `invoice_id: "GUEST CHECK"`, no `provisional` / `receipt_display_v1`. Preview uses `table_display_no` identity. Backend/spooler guest path is marked provisional. |
| Trigger | Print guest check from the table cart when the station uses the browser preview path. |
| Observed | Preview looks like a sale receipt (identity is the table display number, not a GUEST CHECK banner). Scratch: guest builder has no `provisional` flag. |
| Impact | Guest check can be mistaken for a paid receipt. |
| Evidence | Source + scratch `guest check payload has no provisional flag`. No browser print in this pass. |
| Recommended fix | Mark guest checks `provisional` on the client path and show a GUEST CHECK banner in preview, matching the spooler path. |

### C13 — Reverse and Full Refund share one subscription idempotency key

| Field | Detail |
| --- | --- |
| Severity | **Medium** |
| Location | `SubscriptionModal.vue` **341**, **541**, **557**. `submitting` is set **after** the confirm dialog. |
| Trigger | Reverse, then Full Refund (or the reverse) on the same subscription without a new client key. Double-click before `submitting` is set. |
| Observed | Both actions reuse `returnKey`. Second call can hit `SUBSCRIPTION_IDEMPOTENCY_CONFLICT`. |
| Impact | Operator sees a conflict error; one of the two money movements may have already succeeded. |
| Evidence | Source. Existing subscription modal tests do not issue reverse then refund with the same key. |
| Recommended fix | Separate keys per action. Set `submitting` before the confirm await, or disable both buttons as soon as either is clicked. |

### C14 — Table/split checkout hides order-type/hash UI but still applies register rules

| Field | Detail |
| --- | --- |
| Severity | **Medium** |
| Location | `showOrderTypePanel` `CheckoutModal.vue` **543** is `!activeTable`. `processCheckout` **2437–2440**, **2455–2458** still requires hash and sends `order_type_id` / deferred flags. `reconcileDraftOrderType` `tableOrderWorkflow.js` **272**. |
| Trigger | Table or split draft whose persisted/default type requires a hash, or is deferred. |
| Observed | Hash/type cannot be edited. Confirm can stick on “A Hash Number is required…” with no field. Server deferred/platform rules are for direct register checkout; a table can still post a deferred type with cash/card/split. |
| Impact | Confirm blocked with no recovery UI, or a table sale stored under the wrong type. |
| Evidence | Modal hides the panel; store still validates/sends type. No official table+hash test. |
| Recommended fix | For `activeTable`, pin type from the saved table/split (or omit it). Do not apply register default/hash rules. Show hash only if that table type actually needs it. |

### C15 — Restored platform hold: Confirm Platform Sale is rejected

| Field | Detail |
| --- | --- |
| Severity | **High** |
| Location | Client `isDirectPlatformCheckout` `orderSessionStore.js` **1386–1393** (does **not** exclude `restoredHeldOrder`). Modal `CheckoutModal.vue` **173**, **328** (`CONFIRM PLATFORM SALE`). Server `executeCheckout.js` **179** `isOrdinaryHeldCheckout`, **926–949** (`isDirectRegisterCheckout` false when held), **1445–1446**, `CheckoutValidation.js` **20–25**. |
| Trigger | Hold a deferred register order (Talabat). Restore from Order Notes. Pay → Confirm Platform Sale. |
| Observed | UI treats this as direct platform (no table/edit/subscription). It hides cash/card and sends `payment_method: "platform"`, tender `0`, plus `held_order_context`. Server ordinary-held checkout does not derive platform payment and `validatePayments` only allows `cash`/`card`/`split`. Result: **Invalid payment method.** Hold stays claimed. |
| Impact | The intended-looking button is a dead end. Cashier is stuck with a leased hold. Nothing is sold. |
| Evidence | Source as above. Scratch: `treats a restored deferred hold as direct platform checkout` (`isDirectPlatformCheckout === true` with a held context). Existing backend test rejects browser `platform` **without** `held_order_context`. No official restore + platform confirm case. |
| Recommended fix | On restore of a deferred type, hide Pay / do not offer Confirm Platform Sale; send the cashier to Order Notes **Close & print**. Do not send public `payment_method: platform` with `held_order_context`. |

### C16 — Same restore, then cash: sale posts as cash + locked platform type

| Field | Detail |
| --- | --- |
| Severity | **High** |
| Location | After C15, cashier switches type so cash reappears (`CheckoutModal.vue` **647–663**). Server `executeCheckout.js` **347** (`data.order_type_id = heldPayload.order_type_id \|\| …`) runs during held hydration, **before** payment validation. `validatePayments` then accepts cash. |
| Trigger | Restore a Talabat hold. After Confirm Platform Sale fails (C15), switch the UI type to Dine In / Takeaway and confirm cash. |
| Observed | Client sends `payment_method: cash` and a non-deferred `order_type_id`. Server overwrites the type from the held snapshot (still Talabat). Sale commits as **cash + platform order type**. |
| Impact | Drawer / cash sales include money that should be platform receivables. Shift over/short and platform reconciliation are wrong. |
| Evidence | Held hydration at `:347` is unconditional for ordinary held checkout. `validatePayments` allows cash. No integration test for held + deferred type + cash. |
| Recommended fix | Refuse ordinary held checkout when the locked hold type is deferred (409 + keep the hold). Do not let type switching unlock cash for those rows. |

### C17 — Over-tender / split close-reopen mints a new idempotency key after a committed sale

| Field | Detail |
| --- | --- |
| Severity | **High** |
| Location | Fingerprint includes `amountTendered` / split fields (`checkoutFlow.js` **62–66**). Store passes `payment: ui` (`orderSessionStore.js` **712**). `openCheckoutModal` **2377–2378** clears `activeIdempotencyKey` then `syncCheckoutPaymentForOrderType` resets tender/split to exact cash. Cache `resolveCheckoutAttemptKey` mints when the fingerprint misses. |
| Trigger | Cash over-tender or split amounts → Pay → request times out *after* the server insert → operator hits X (or KeepAlive closes the modal) → opens checkout again. |
| Observed | Pay-time fingerprint is the over-tender (K2). Reopen fingerprints the reset exact total, misses the cached K2 record, and mints K3. Server treats K3 as a new sale. Combined with C1: changing the cart after a poisoned success also rotates the key. |
| Impact | Duplicate paid sale. Cart is then cleared for the *second* sale. Operator can believe they only retried the first. A same-key retry after timeout *would* recover — only if they never close/reopen after over-tender. |
| Evidence | Scratch: over-tender 20 vs reset 5.8 fingerprints differ; `openCheckoutModal` clears the in-memory key and resyncs. Tracked test `keeps the checkout fingerprint stable while transient payment input resets` documents reopen reset as intended. No tracked “timeout + over-tender + reopen.” |
| Recommended fix | Bind the in-flight/cached key across close/reopen until the *charged* identity (cart/type/held/split) changes. Do not mint a new key on modal open after a sent Pay. On network error, tell the operator to retry the same attempt without changing tender. |

### C18 — Successful platform sale still says “Paid Successfully / Change Due”

| Field | Detail |
| --- | --- |
| Severity | **Medium** |
| Location | `showPaymentSuccess` `orderSessionStore.js` **82–116**, called at **2532** with `{ receivable: data.payment_method === 'receivable' }` only. |
| Trigger | Fresh register checkout with a deferred type (cash/card hidden; tender 0). |
| Observed | Receivable gets “Receivable Issued / No payment was collected.” Platform always hits the cash toast: **Paid Successfully** + **Change Due: 0 JD**. Browser preview still prints Tendered / Change (`ReceiptPreviewModal.vue` **103–106**; `buildSuccessfulCheckoutResult` uses client tender). Spooler path zeros those fields. |
| Impact | Looks like cash was taken. Training / drawer-count errors. Happy-path posted tender is still 0 on the server. |
| Evidence | Source. Receivable is special-cased in `orderSessionStore.test.js`. No equivalent platform assertion. |
| Recommended fix | Same pattern as receivable: if `payment_method === 'platform'`, toast “Platform sale recorded / No cash or card collected.” Hide Tendered/Change on platform/receivable preview. |

---

## Suspicions (not independently proven as user-visible failures)

| ID | Severity | Location | Why it is not confirmed | If true |
| --- | --- | --- | --- | --- |
| S1 | Low | `PrintReceiptApp.vue` **13–41**: `v-if="!presentationError"` then `presentation.rows` | `data` starts as `{}` (idle → null presentation) but `printType` is not `'receipt'` until a payload arrives. A non-empty, non-validatable payload that returns `{ presentation: null, error: null }` was not constructed. | Browser print window throw; no paper. |
| S2 | Low | `lookupCustomer` `orderSessionStore.js` **1573–1574** empty `catch` | Spinner always clears. No toast. Not exercised against a real 5xx. | Cashier types a known phone and gets a blank name with no explanation. |
| S3 | Low | `fetchHeldOrders` `tableOrderWorkflow.js` **945–950**, **1198** | Reached only if split confirm succeeds with `!activeTable`. Splits require a table. No `try/catch`. | Unhandled rejection on that dead/rare branch. |
| S4 | Low | `showPaymentSuccess` `orderSessionStore.js` **82–116**, called at **2532** without `await` | Production installs `window.showPosAlert` in `App.vue`. If both Swal and the helper were missing, the rejection would be unhandled and would **not** enter `processCheckout`’s catch. The **session-ownership** gap is C9, not this missing await. | Success toast missing after a paid, finalized sale. |
| S5 | Info | `onDeactivated` `PosTerminal.vue` **1266** → `cancelSubscriptionSale` | Comment on `pendingSubscriptionSale`: checkout-only intent must not survive into another session. Navigating away mid-receivable checkout wipes the cart. `onActivated` also closes the modal, so this is not an empty leftover dialog. | Operator must start the subscription sale again. Likely intentional. |
| S6 | Low | `PrintReceiptApp.vue` idle `{ presentation: null, error: null }` → `presentation.rows` | Scratch SSR can throw. No production writer found that sets a receipt payload with null presentation and null error while `printType === 'receipt'`. | Browser print window throw; no paper. |
| S7 | Low | Last held line `removeSelectedCartItem` **1782–1788** only `clearOrderSlice` | `clearCart` / `startNewOrder` release/cancel. Lease linger was not replayed against the claim API. | Held claim can remain until timeout. |
| S8 | Low | `closeCheckoutModal` **75–78** clears `activeIdempotencyKey` but not `checkoutError` or the persisted attempt cache | `openCheckoutModal` clears the error and resyncs payment. Leftover split tender after close is overwritten on reopen via `syncCheckoutPaymentForOrderType`. | Stale error flash or leftover split amounts only if Confirm is reached without reopen/sync (feeds C7 if they never synced). |
| S9 | Info | `showReceiptModal` is never set `true` in `src/` (tests only) | Thermal teleport still mounts on `lastOrder`. Preview/reprint UX looks dead, not a charge bug. | Operators cannot reopen the last receipt from that control. |
| S10 | Info | `canPay` is `canCheckout \|\| canCheckoutTable`; `processCheckout` does not check grants | Backend is `canCheckout(user) \|\| (user.role === 'waiter' && canCheckoutTable(user))` at `executeCheckout.js` **754**. Non-waiter with only `waiter.checkout` sees Pay and gets 403. Waiter with only `waiter.checkout` can take register payment. | Permission mismatch, not a wrong charge on an authorized cashier. |
| S11 | Medium | `handleOrderTypeSelection` does not call `syncCheckoutPaymentForOrderType`; `processCheckout` never re-syncs | Current modal click path is protected (`applyOrderType` / `clearOrderType` sync). Leftover split on Talabat or leftover platform on dine-in is only if a caller skips the modal. | Client can submit the previous type’s settlement. Server coerces leftover cash on a deferred *direct* register type to platform, or rejects leftover `platform` on an ordinary type. |
| S12 | Low | `handleOrderTypeSelection(null)` reads `type.id` | Current modal clear writes `null` and syncs; it does not call the store action with null. | Residual 48e6721d-class throw for a future/store-only caller. |
| S13 | Low | Register Confirm is not gated on `selectedOrderType` (call-center save is) | Server may stamp `defaultOrderTypeId`. If that default is deferred, client sent `deferred: false` → 409 refresh. If there is no default, a sale can complete with no type. | Sale stored as the default, or with no type. |
| S14 | Low | Fingerprint is wired `payment: ui` but reads `payment.method` | Store UI exposes `paymentMethod`, not `method`. Fingerprint method is always `null`. Cash↔card with the same tender reuses the key (reduces method-only double-charge; replay receipt can mix fields). | Wrong receipt method text on replay, not a second insert. |

---

## Area notes (traced, no extra confirmed defect)

| Area | What was traced | Result beyond C1–C5 |
| --- | --- | --- |
| 1. Template bindings | Checkout, receipt preview (screen + thermal), PrintReceiptApp, ShiftReport, A4, TableSplits, POS terminal | ad56bb48 holds. No second missing-helper crash found on those surfaces. |
| 2. Composable/store exports | Full `useCart()` return vs every `src/` consumer (`CheckoutModal`, `PosTerminal`, `PosCartWorkspace`, `PosCatalogWorkspace`, `SubscriptionModal`, `ModifierSelectorModal`, `CartNotesModal`, `SplitCheckModal`, `OrderNotes`) | 48e6721d holds. No other **called** missing facade action. Store still has table/hold actions that UI reaches via `useTables()`, not `useCart`. |
| 3. Order-type switching | `handleOrderTypeSelection`, `syncCheckoutPaymentForOrderType`, modal handlers, `isDirectPlatformCheckout` | Settlement reset on select/clear works on the **modal** path. Table, paid subscription, and invoice-edit stay on cash/card/split. **C3**, **C4**, **C14**, S11–S13 remain. |
| 4. Platform / deferred | Modal platform pane, `buildCheckoutRequest` `noTenderPayment`, 409 `ORDER_TYPE_SETTLEMENT_CHANGED` refresh, held restore | Opening a **fresh** deferred register type sets `paymentMethod = 'platform'` and tender `0`. Stale cash/split is cleared. Table deferred stays ordinary payment (tested; looks intentional). **C15** / **C16** are the restore-path money bugs. **C18** is the success-toast mismatch. |
| 5. Subscription receivables | `beginSubscriptionSale` → `openCheckoutModal` → sync to `receivable`; collect/reverse/refund | Receivable UI and due date bind. Collect treats API success as success even if print returns `success: false` (`print_queued`). Print still toasts via C2. **C6** (extra lines dropped) and **C13** (shared reverse/refund key) are the money-path gaps. |
| 6. Table / split checkout | `confirmSplit` busy flag, `restoreTableSplit` revision/`table_id`, `canCheckoutTable`, split payment contract spec, `orderWorkflowTransitions.spec.js` | Duplicate-split submit still guarded (`isProcessing \|\| isHolding`). Happy-path restore still keeps revision 3 when the floor row matches. **C7**, **C8**, **C10** (board Pay), **C14**, and S10 are the remaining gaps. |
| 7. Held restore / rehold / checkout | `restoreHeldOrder`, `holdCurrentOrder`, follow-up/baseline, handoff claim | Kitchen-fired checkout uses the submitted held snapshot (`kitchenAlreadyFired` from the frozen context). Follow-up/baseline errors are toasted and do not clear the draft on network failure. **C5**, **C10** (Pay during hold), **C11**, S7 remain. |
| 8. Receipt render / print | Preview modal, presentation resolver, guest check, hold receipt | Thermal wrapper is `lastOrder && !presentationError`. Guest-check print failure does not become a checkout error. Hold print failure message is accurate. **C1**, **C2**, **C12**, S6, S9 remain. |
| 9. Async errors / toasts | `processCheckout`, hold, print, JoFotara, customer lookup | Print reject after charge does **not** set `checkoutError` (existing isolated test). Kitchen `dispatchToNodeSpooler` swallows and returns `{success:false}` — the defect is C2’s toast, not an unhandled rejection. JoFotara miss uses a warning that the sale succeeded even if `queueAutomaticReceiptSet` failed (same class as C2). |
| 10. Retries / idempotency / post-success | `resolveCheckoutAttemptKey`, `isProcessing` double-submit, fingerprint reuse after reload, `finalizeCheckout` → `clearCachedCheckoutAttempt` | Same-cart retry after a **failed HTTP** reuses the persisted key **if tender/split/cart are unchanged** (good). Double-click Pay hits `if (ui.isProcessing) return` (isolated test). **C1** is broken post-success recovery. **C7** is sibling-key reuse. **C9** is stale success toast/print. **C17** is close/reopen after over-tender. S14 is the ignored `payment.method` wiring. |

---

## Tested paths and results

| Command | Result |
| --- | --- |
| `npm run test:frontend -- src/components/pos/__tests__/receiptPreviewRender.spec.js src/pos/orderWorkflowTransitions.spec.js src/components/pos/__tests__/checkoutSplitPayment.spec.js src/utils/defaultOrderType.spec.js src/components/pos/__tests__/receiptSplitPayment.spec.js src/components/pos/__tests__/splitCheckModal.spec.js src/components/pos/__tests__/tableSplitsBoard.spec.js` | 7 files, **52 passed** |
| `npm run test:frontend -- src/components/pos/__tests__/subscriptionModal.spec.js src/components/pos/__tests__/callCenterWorkflow.spec.js src/pos/orderWorkflowTransitions.spec.js src/components/pos/__tests__/receiptPreviewRender.spec.js` | 4 files, **41 passed** (overlap with the first run) |
| `npm run test:isolated -- backend/tests/unit/orderSessionStore.test.js backend/tests/unit/useCart.logic.test.js backend/tests/unit/checkoutAttemptCache.test.js` | 3 files, **238 passed**; fixture `posapp_review_recipe_p1_02f71eda7a77` created and removed by the runner |
| `npx vitest run --config scratch/vitest.checkout-audit.config.mjs` | 1 file, **12 passed** (fix presence + C1–C4, C7 fingerprint, C11 persist, C10/C6 guards, C12 guest flag, C15 held-platform flag, C17 over-tender fingerprint) |

Passing existing suites did not imply C1–C18 were absent.

## Claims checked and not promoted

These appeared in investigator notes. Independent source review did **not** treat them as current product defects.

| Claim | Disposition |
| --- | --- |
| Empty checkout dialog still open after leaving POS (subscription) | `onActivated` closes the modal. Sale wipe on deactivate is S5 (likely intentional). |
| Leftover settlement on every order-type click | Modal `applyOrderType` / `clearOrderType` sync. Store-only leftover is S11, not a current click bug. |
| Kitchen dispatch leaves an unhandled rejection | `dispatchToNodeSpooler` swallows and returns `{success:false}`. User-visible issue is C2. |
| `useCart` still missing `syncCheckoutPaymentForOrderType` / `holdCurrentOrder` | 48e6721d holds. `holdCurrentOrder` is on `useTables()` by contract. |
| ad56bb48 incomplete (`formatBusinessDateTime` unbound) | Import + return + thermal line still present; official render spec passed. |
| `presentation.rows` idle crash as a production bug | Real TypeError in scratch SSR; no production writer found. Kept as S6. |
| Revision discarded on split restore (2026-09-06) | Happy path still keeps revision 3 when the floor row matches. Remaining risks are C7 (fingerprint omits revision) and C8 (never reaches a valid settle). |
| Missing helpers in SplitCheckModal / TableSplits | `editSplitGroup` / `confirmSplit` / `restoreTableSplit` / seat totals are present. |
| `orderSessionBoundaries.test.js` omitting `syncCheckoutPaymentForOrderType` from `CART_KEYS` | Test-contract drift only. Not a runtime miss. Isolated run of that file was not part of the first official batch. |

## Untested limitations

- No production build, Playwright, or physical printer/cash-drawer/card-terminal/JoFotara live run.
- No browser walkthrough of C5 (handoff overwrite), C15/C16 (hold → Confirm Platform Sale → cash workaround), or live hash-required types.
- No isolated integration `checkout.test.js` / `checkoutPostCommit.test.js` in this pass (unit + frontend + scratch only).
- Not every cash/card/split/platform/receivable permutation under arbitrary network ordering.
- Call-center claim-lease races and remote table ownership were not replayed.
- Scratch experiments mock `useTerminal` / `orderSessionApi`; they do not hit MySQL.

## Dedup

C2 covers kitchen toast, backend receipt toast after charge, and subscription collection print toast. They are one helper (`dispatchToNodeSpooler`) used after a committed money movement.

C1 is not the already-tested `printReceipt` rejection path. That path keeps `checkoutError` empty. C1 is a throw **before** finalize, mislabeled as a network error, then a poisoned in-memory success key.

C17 is the close/reopen key-rotation path that turns a recoverable timeout (same key) into a second charge. C1’s “change the cart and pay again” is the same class.

C15 and C16 are one restore flow: the platform button is a dead end; the cash workaround misclassifies the sale.
