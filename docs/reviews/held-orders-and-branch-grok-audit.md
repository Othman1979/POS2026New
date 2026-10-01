# Held-order and branch adversarial audit

Read-only review. No application, test, template, configuration, or database changes were made. No commit, merge, push, deploy, or physical printer contact. Prior completion notes in `docs/reviews/2026-09-09-*.md` were treated as claims, not evidence.

## 1. Scope

### Git revisions

| Item | Value |
| --- | --- |
| Branch | `codex/business-timezone-fix` |
| HEAD | `f4ad123f9d16701920daf31385916981344586ae` (`Repair migration verification and record full branch review evidence`) |
| `master` / `origin/master` | `f4ad123f9d16701920daf31385916981344586ae` |
| Merge-base with `master` | `f4ad123f9d16701920daf31385916981344586ae` |
| Commits unique to this branch | none (`master..HEAD` empty) |
| Review surface | entire dirty working tree plus untracked application files |

HEAD equals `master`. There is no committed delta to review against the merge-base. The entire held-order implementation and the rest of the branch work are uncommitted.

### Dirty / untracked files reviewed

Tracked modifications (96 files) plus untracked application files:

- Held-order: `backend/services/HeldOrderNumber.js`, `HeldOrderReceipt.js`, `HeldOrderLifecycleService.js`, `HeldOrderKitchenDispatch.js`, `backend/routes/pos/orders.js`, `backend/modules/checkout/executeCheckout.js`, `backend/routes/print.js`, `src/utils/heldReceiptPrint.js`, `src/pos/stores/orderSession/tableOrderWorkflow.js`, `src/pos/stores/orderSessionStore.js`, `src/components/OrderNoteCard.vue`, `src/components/OrderNotes.vue`
- Print pipeline: `printDocumentCompiler.js`, `printDocumentModel.js`, `printTemplateEngine.js`, `printTemplateDefaults.js`, `pos-spooler-printer/renderDocument.js`, `pos-spooler-printer/v2/artifact-renderer.js`, `src/print/PrintReceiptApp.vue`, `src/components/pos/ReceiptPreviewModal.vue`
- Schema: `backend/migrations/2026-09-09-held-order-numbers-v1.sql`, `.auto.sql`, `auto-manifest.json`, `deployment/database/baseline.sql`, `hostinger-manual-migrations.sql`, `deployment/tools/bootstrap-database.js`, `schemaValidation.js`
- Timezone / schedule: `backend/utils/businessDate.js`, `src/utils/businessDate.js`, `pos-spooler-printer/businessTime.js`, `databasePoolOptions.js`, `backend/routes/admin/audit.js`, `auditReports.js`, `src/main.js`, report/header pages
- JoFotara: `JofotaraService.js`, `JofotaraXmlBuilder.js`
- Kitchen routing: `kitchenPrintRouting.js`
- Scale: `scaleBarcode.js`, `src/pos/useTerminal.js`
- Auth/shift: `backend/routes/auth.js`
- Tests and review scripts listed in `git status`
- Architecture map: `docs/architecture.json` (generated HTML not independently authored)

Not treated as executable product logic: `.codex/config.toml`, prior `docs/reviews/2026-09-09-*.md`.

Secrets were not copied into this report. `.env.test` was inspected only for isolation (`DB_HOST=127.0.0.1`, `DB_NAME=posapp_test`).

### Coverage limitations

- No physical printers, no Hostinger/production database, no browser acceptance script this pass (`scripts/reviews/held-order-number-browser.cjs` not run).
- No full historical migration-chain integration run.
- Inventory/ingredient Vue and `ar.json` were checked for held-order/print/timezone interaction, not re-audited as a warehouse feature set.
- `src/print/__tests__/adminReportA4Rendering.spec.js` hit a Vite SSR harness timeout (`transport was disconnected`). That is an unverified risk for report A4 rendering, not a held-order paper finding.
- Parallel read-only passes: [Security Review](fd34a9f6-8396-4b07-b454-e34eb73c9289), [Held-order contract](7bb7945f-9aeb-4e3d-b2f0-93668d414237), [Print templates](1643fc7a-322e-4993-baad-163c11c3d3f0), [Branch-wide](ab46cdba-6a45-492b-bcbf-620c72932910). Findings below were re-checked on the call path after those passes returned.

## 2. Verdict

**The permanent held-order product contract is not satisfied.**

Unpaid status, scheduled deferral, archive/restore columns, and checkout reuse of an already-stored number are implemented. The isolated `heldOrderNumber` file stays green because it forces `shared_order_sequence='1'` and does not compile kitchen HTML or restaurant templates.

Three independent contract breaks remain:

1. **Templates.** Browser holds always compile the built-in receipt. Spooler holds discard any custom receipt whose JSON lacks the substring `meta.heldOrderReceipt`, or any custom that throws `TEMPLATE_*`. A leftover `heldOrderReceipt` condition on a non-identity node can keep a custom that still prints `GUEST CHECK` or no number.
2. **Default numbering.** Seed and bootstrap default to per-shift (`shared_order_sequence='0'`). Immediate call-center holds cannot send `shift_id` and have no open shift, so `ensureHeldOrderNumber` silently uses `daily_sequences`. A cashier sale on an open shift uses `shifts.last_order_seq`. Both tickets can show `#1`.
3. **Kitchen paper and completeness.** Compiled kitchen tickets print `Ticket:` and `Order:` with the same number. Immediate holds of unrouted prep items still save. Mixed tickets can mark `kitchen_fired=1` while a disabled override station’s lines never print.

Until those are fixed, this is not shippable as permanent behavior for every restaurant.

## 3. Findings

### HO-TPL-BROWSER — Blocker

**Location.** `prepareHeldCustomerReceipt` in `backend/services/HeldOrderReceipt.js` lines 30–33 (`getBuiltinTemplate`, `compileTemplate`, `templateRevisionId: 'builtin:receipt-v1'`). Caller: `POST /api/pos/held_orders` and `PATCH` when `shouldAutoFireHeldOrder` / `firstImmediate`, and `POST /api/pos/held_orders/:id/print_receipt`. Client: `src/utils/heldReceiptPrint.js` (`printHeldCustomerReceipt`) consumes `compiled_document_v1` in an iframe and never loads the restaurant template.

**Trigger.** Store setting `print_method` is anything other than `backend` (browser printing). Immediate hold, or manual Print Receipt.

**Expected.** The restaurant’s active receipt template (default or edited) prints. Only identity visibility changes: order number on, invoice/ticket/guest-check/payment/fiscal off.

**Actual.** The server compiles `getBuiltinTemplate('receipt', { heldOrderReceipt: true })` and returns that artifact. `resolveActiveTemplate` is never called on this path. A restaurant that already added a correct held-order branch, logo, fonts, or layout still gets the built-in receipt.

**Evidence.** Source as cited. Isolated `heldOrderNumber` “browser receipt” case only asserts Order: / no Invoice on the builtin HTML. No test compiles the active custom revision for browser mode.

**Impact.** Every browser-print restaurant loses its receipt design on every automatic and manual held customer copy. Operators cannot “pick the right template” to opt in; the path never consults the saved template.

**Smallest correction.** Browser mode must compile the same resolved active receipt as spooler mode. Adapt visibility of identity/payment/QR nodes for `meta.heldOrderReceipt`; do not swap the definition for `builtin:receipt-v1`.

**Regression.** Restaurant has a custom receipt whose header text is unique. Browser-mode immediate hold. Artifact HTML must contain that header and `Order:` + the reserved number, and must not contain `GUEST CHECK`, `Invoice:`, `Ticket:`, payment, or JoFotara QR. Repeat after editing only non-identity styles.

---

### HO-TPL-FALLBACK — Blocker

**Location.** `compileBuiltin` in `backend/services/printDocumentCompiler.js` lines 177–185 and 196–207. `validateReceiptStructure` in `backend/services/printTemplateEngine.js` lines 356–374 (held field optional). Locked in by `backend/tests/unit/printDocumentCompiler.test.js` lines 302–314 (`falls back from an older custom receipt to a numbered unpaid held layout`).

**Trigger.** Backend/spooler print of a numbered hold while the active custom receipt JSON does not include the substring `meta.heldOrderReceipt`, or while custom compile throws and `model.meta.heldOrderReceipt` is true.

**Expected.** Keep the restaurant template. Show the reserved order number using the existing public identity bindings (or a compile-time visibility rewrite of those nodes only). Hide invoice/ticket/guest-check/payment/QR.

**Actual.**

1. `JSON.stringify(resolved.definition).includes('meta.heldOrderReceipt')` is a substring gate. Missing → `resolved.fallback(...)`.
2. Non-custom or failed custom → `getBuiltinTemplate('receipt', { heldOrderReceipt: true })`.
3. Editor validation does **not** require a held identity field. Old templates still save. They are discarded at print time.

Direct compile of an older default (held-order-display removed, guest-check visible when `meta.provisional === true`) against a numbered held model produced `GUEST CHECK` and no `Order:` (runtime check in this audit). That is why fallback was added. Fallback solves identity by **throwing away** the restaurant layout, which the product contract forbids.

**Impact.** Most existing custom receipts are replaced on spooler held prints. Logo, paper block order, fonts, and bilingual copy disappear on those copies. The previous review’s sentence “Older custom receipt templates … fall back to the built-in held layout” describes this defect, not a completed contract.

**Smallest correction.** Remove the held-layout discard in `compileBuiltin`. At compile time, for `heldOrderReceipt` only, force-show `meta.orderDisplayNo` and force-hide invoice/ticket/guest-check/payment/jofotara on the **resolved restaurant definition**. Require neither a new saved field nor a builtin swap. Tighten validation later as an editor hint, not as a print-time veto.

**Regression.** Custom receipt without `meta.heldOrderReceipt`, unique store-name label, backend print of an immediate hold. Queued/compiled HTML must keep that label, show only `Order:` + number, and must not match `GUEST CHECK|Invoice:|Ticket:|Payment|Tendered`. A second custom that already has a held branch must keep its revision id (`revision:N`), not `builtin:receipt-v1`.

---

### HO-SEQ-CC-SHIFT — Blocker

**Location.** `ensureHeldOrderNumber` in `backend/services/HeldOrderNumber.js` lines 8–20 (`sharedMode: config.shared_sequence === '1' || !config.shift_id`). Create: `orders.js` 1630 with `shiftId: data.shift_id || null`. Call center cannot send `shift_id` (`CALL_CENTER_FORBIDDEN_TOP_LEVEL` lines 72–75). Checkout binds the cashier’s open shift (`executeCheckout.js` 614–640) then `orderIdScope.sharedMode = isSharedSeq || !data.shift_id` (1548–1551). Defaults: `backend/tests/fixtures/seed.js` 1373 and `deployment/tools/bootstrap-database.js` 92 set `shared_order_sequence='0'`.

**Trigger.** Default per-shift restaurant. Call center creates an immediate phone hold. A cashier with an open shift later sells a normal cash order.

**Expected.** One number from the same configured sequence used by normal checkout.

**Actual.** Phone holds have no open shift, so numbering uses `daily_sequences` / `date:YYYY-MM-DD`. Cashier checkout uses `shifts.last_order_seq` / `shift:{id}`. Both can display `#1`. Paying the hold later reuses the `date:` pair, so the unique indexes do not collide; **paper numbers do**. Isolated numbering tests force `shared_sequence='1'` except one cashier+shift case, so this default-config hole stays green.

**Impact.** Phone tickets and register sales reuse the same visible order number under the shipping default. Shared-sequence venues are unaffected.

**Smallest correction.** Use `daily_sequences` only when `shared_order_sequence='1'`. Resolve a register shift the same way checkout does. If an immediate phone hold has no register shift to mint from, fail closed (or mint only after a cashier fire/print on that cashier’s shift). Do not treat “no shift” as shared mode.

**Regression.** Default `shared_order_sequence='0'`: phone immediate hold vs cashier sale with an open shift must not share display `#1`. Shared-sequence restaurants and cashier holds that pass that cashier’s `shift_id` must keep today’s passing cases.

---

### HO-TPL-HEURISTIC — High

**Location.** `compileBuiltin` substring gate (`printDocumentCompiler.js` 179–181) plus `validateReceiptStructure` (`printTemplateEngine.js` 356–374). `meta.heldOrderReceipt` is a catalog boolean usable on any node.

**Trigger.** A valid older custom (paid identities + `GUEST CHECK` on `meta.provisional`) also has any non-identity node whose `visibleWhen.path` is `meta.heldOrderReceipt`. Print a numbered hold to the spooler.

**Expected.** Restaurant layout with a visible reserved order number.

**Actual.** `JSON.stringify(definition).includes('meta.heldOrderReceipt')` is true, so the custom is **kept**. Runtime: `guestCheck` is false, so a guest-check node gated on `meta.guestCheck` hides; a guest-check node gated on `meta.provisional` still shows **GUEST CHECK**. Paid identity fields stay hidden. Empty `orderDisplayNo` fields are skipped (`renderNode` empty text → `''`). Direct compile of the older default in this audit produced `GUEST CHECK` and no `Order:`.

**Impact.** The fallback heuristic can discard a good layout (HO-TPL-FALLBACK) **or** keep a bad one. Neither satisfies the contract.

**Smallest correction.** Delete the stringify/fallback. Compile the restaurant template with a held-only visibility rewrite of identity/payment/QR nodes (same as HO-TPL-FALLBACK).

**Regression.** Custom with a held-gated spacer only: numbered hold must show `Order:` + number and not `GUEST CHECK`.

---

### HO-TPL-COMPILE-ERR — High

**Location.** `compileBuiltin` catch, `printDocumentCompiler.js` 196–207.

**Trigger.** Active custom **has** a held branch, but `compileTemplate` throws any `TEMPLATE_*` (size, expansion, QR).

**Expected.** Fail the job (409) or keep the restaurant’s last good revision. Do not swap documents.

**Actual.** `fallback.definition` is overwritten with `getBuiltinTemplate('receipt', { heldOrderReceipt: true })` whenever `model.meta.heldOrderReceipt` is true.

**Impact.** A held-capable custom that fails compile prints the factory receipt while paid reprints of the same template fail or degrade differently.

**Smallest correction.** Do not overwrite `fallback.definition` for held. Fail closed like follow-up/cancel kitchen (`HELD_FOLLOW_UP_TEMPLATE_REQUIRED`).

**Regression.** Oversized custom with a held branch: held print 409s; it must not emit `builtin:receipt-v1`.

---

### HO-KITCHEN-TICKET — High

**Location.** `buildKitchenDocumentModel` in `backend/services/printDocumentModel.js` lines 192–194 (`ticketDisplayNo: … ticket_display_no || order_display_no`). Held payloads: `queueHeldKitchenRound` / `buildHeldKitchenBaseline` in `backend/services/HeldOrderKitchenDispatch.js` lines 318–324 and 362–368 (`ticket_display_no: null`, `order_display_no: String(heldOrder.order_id ?? heldOrder.id)`). Default kitchen field `kitchen-ticket` in `backend/services/printTemplateDefaults.js` line 115. Spooler fallback `renderKitchenDocument` in `pos-spooler-printer/renderDocument.js` lines 371–376 (labels `order_display_no` as **Ticket** when `invoice_display_no` is absent).

**Trigger.** Immediate hold (or fire) of a routable item. Inspect the compiled kitchen artifact or the raw HTML fallback, not only `print_queue.payload.data.ticket_display_no`.

**Expected.** Kitchen paper uses the reserved **order** number instead of a held-order identifier. It should not present a ticket/invoice/held identity.

**Actual.** Raw queue data correctly sets `ticket_display_no: null`. Compilation then copies `order_display_no` into `meta.ticketDisplayNo`. Default kitchen template therefore prints both:

- `Order: 17` (`data-node="kitchen-order"`)
- `Ticket: 17` (`data-node="kitchen-ticket"`, 36px)

Confirmed by compiling the builtin kitchen template against a held-shaped model: `kitchen.ticketDisplayNo=17`, HTML contains both labels. Spooler fallback does the same: `Ticket: ${kDisplayNo}` where `kDisplayNo` is `order_display_no`.

**Impact.** Kitchen reads a ticket number that is not an invoice and matches the order number. Tests that only read the raw payload (`heldOrderNumber.test.js` lines 31–36) report green while paper is wrong.

**Smallest correction.** For held kitchen models, leave `ticketDisplayNo` empty (do not coalesce to `order_display_no`). Keep `orderDisplayNo`. Mirror that in `renderKitchenDocument` when `held_order_receipt` or unpaid held payloads are present (`invoice_id` null and no paid invoice).

**Regression.** Immediate hold → compile kitchen artifact (and spooler fallback HTML). Must contain `Order:` + reserved number. Must not contain `Ticket:`, `Invoice:`, or the held row id as the public identity.

---

### HO-KITCHEN-SWALLOW — High

**Location.** `queueAutomaticHeldKitchenRound` in `orders.js` 143–156 (catches `HELD_KITCHEN_ITEMS_EMPTY` and returns `round: null`). `queueHeldKitchenRound` in `HeldOrderKitchenDispatch.js` 312–313. Create still numbers and prints the customer copy (1629–1653). Pinned by `heldOrders.autoFire.test.js` 261–286.

**Trigger.** Immediate hold of a prep item whose category has no active kitchen printer (inactive station, or no assignment).

**Expected.** Immediate hold automatically sends kitchen tickets and a customer receipt. A missing route for prep items is not “success.”

**Actual.** `routable.length === 0` throws `HELD_KITCHEN_ITEMS_EMPTY`. Automatic create/save swallows that code, reserves the number, queues the customer copy, and returns `kitchen_fired: false`. The POS hold success path only prints the customer artifact (`tableOrderWorkflow.js` 926) and does not inspect `kitchen_fired`. Manual `fire_kitchen` still 422s.

**Impact.** Kitchen never sees the ticket. The hold looks saved. The auto-fire test treats this as the desired outcome.

**Smallest correction.** Swallow empty-kitchen only when the cart has no preparation lines. If every prep line is unrouted, fail the automatic hold (or keep it unnumbered/unprinted) so the cashier sees the route problem.

**Regression.** Cart with no kitchen category must still hold without a kitchen job. Cart with a routed item and a dead station must not return 200 + `kitchen_fired: false` as success.

---

### HO-KITCHEN-PARTIAL — High

**Location.** `printersForCategory` in `kitchenPrintRouting.js` 65–69 (explicit assignment owns the route even when all those printers are inactive). `queueHeldKitchenRound` tickets only `routable`. `printKitchenOrder` in `print.js` 1043–1046 succeeds when `payloads.length > 0`. Auto-fire sets `kitchen_fired=1` if any round queued (`orders.js` 1638–1644).

**Trigger.** Subcategory assigned to station G (disabled). Same ticket also has a line that still routes to an active station. Immediate hold, table fire, or `printKitchenOrder`.

**Expected.** Do not silently send the override line to the parent (that part of the change is correct). Also do not treat a partial ticket as fully fired.

**Actual.** Disabled override lines become `unrouted`. Sibling lines print. Auto-fire marks `kitchen_fired=1`. `kitchenCategoryOverride.test.js` asserts the unrouted remainder and stops; it never asserts auto-fire/`printKitchenOrder` failure.

**Impact.** Grill items vanish; the rest of the ticket looks sent. Follow-up later has no baseline for the missing line.

**Smallest correction.** If `unroutedItems.length > 0` after exclusive-override routing, fail `queueHeldKitchenRound` / `printKitchenOrder` and do not set `kitchen_fired=1`.

**Regression.** Override station off, sibling still active: hold/fire must 409/422 listing the unrouted lines. Parent fallback must still not occur.

---

### HO-AUTO-RECEIPT-COMMIT — High

**Location.** `prepareHeldCustomerReceipt` 35–43 (`automatic: true` → `{ mode: 'unavailable' }`). Create 1650–1653. Contrast: manual `print_receipt` with a bad printer rolls back the number (`heldOrderNumber.test.js` 94–107 vs 101–107).

**Trigger.** Immediate hold, `print_method='backend'`, no usable receipt printer (none, or several and no `receipt_printer_id`).

**Expected.** Immediate hold sends kitchen **and** a customer receipt. A failed first customer print should not leave a half-applied hold.

**Actual.** Printer selection failure returns `unavailable` and the transaction **commits**. Kitchen jobs and the reserved number stay. The client toasts. Retry via `print_receipt` 409s while the printer is still missing.

**Impact.** Kitchen paper exists; customer copy does not. Number is burned. Manual first-print failure is stricter than automatic.

**Smallest correction.** On the first automatic print, treat receipt-printer failure like manual first-print failure: roll back number + kitchen + hold, or do not commit until both copies queue.

**Regression.** One kitchen printer + one receipt printer (current happy path) still 200s with both jobs. No receipt printer: hold create must not keep a kitchen job and a reserved number.

---

### TZ-BOOT-01 — High

**Location.** `bootstrapPos` in `src/main.js` 46–63 (`await loadBusinessConfig()` in the same `try` as `app.mount`). Contrast: `src/admin/bootstrap.js` 36–39 catch-and-continue.

**Trigger.** `GET api/config/business` throws (network, HTML 502, non-JSON). `fetchJson` always parses JSON.

**Expected.** Same as admin: log, keep built-in `+03:00` / 06:00, still mount login/POS.

**Actual.** Any config-load throw shows “POS System Failed to Start”. Login and device enrollment never render.

**Impact.** A config-only outage bricks every register SPA, including pages that do not need the business clock yet.

**Smallest correction.** Inner `try/catch` around `loadBusinessConfig` matching admin, then mount.

**Regression.** Stub `/api/config/business` as HTML 502; `/login` must still mount.

---

### HO-DUP-UNSCHEDULE — High

**Location.** `firstImmediate` in `backend/routes/pos/orders.js` lines 964–965 and 1033–1036. Frontend always attempts `printHeldCustomerReceipt(data.customer_receipt)` after a successful create **or save** (`src/pos/stores/orderSession/tableOrderWorkflow.js` lines 920–927). Manual print uses a new `print_request_id` (`src/components/OrderNotes.vue` `reprintDirect`, `getHeldOperationId('receipt', …)`).

**Trigger.**

1. Save a future scheduled hold (no number, no print).
2. Print customer receipt from the held card (reserves number; one customer job/dialog).
3. Clear `delivery_date` and save.

**Expected.** Keep the same number. Do not automatically print a second customer copy. Automatic print is for the first time an order becomes an immediate hold without an existing customer copy.

**Actual.** `firstImmediate = shouldAutoFireHeldOrder(nextPayload) && (row.order_id == null || !shouldAutoFireHeldOrder(previousPayload))`. After step 2, `order_id` is set and previous cart is still scheduled, so `firstImmediate` is true. Save calls `prepareHeldCustomerReceipt` with `automatic: true` and the **save** `operationId` (not the receipt key). New `print_request_id` `held-receipt-${id}-${operationId}` → second customer copy. Kitchen is not duplicated if already fired.

The isolated test `prints both copies when a scheduled hold becomes immediate` (lines 143–155) never prints first; it only unschedules. It pins the opposite of this operator sequence.

**Impact.** Extra customer paper (or a second browser dialog) after a normal “print now, cook later / then make it immediate” flow.

**Smallest correction.** Auto-print on first immediate transition only when no successful customer receipt request exists (durable flag or last receipt request id on the row). Do not key automatic print solely off `order_id == null || previous was scheduled`.

**Regression.** Scheduled hold → `print_receipt` → unschedule save. Receipt job count stays 1 (backend) or browser dialog runs only on the first print. Number unchanged. Immediate-from-scratch still auto-prints once.

---

### HO-TEST-MISLEAD — High

**Location.** `backend/tests/integration/heldOrderNumber.test.js` lines 23–37, 109–121, 181–189. `backend/tests/unit/printDocumentCompiler.test.js` lines 302–314. `docs/reviews/2026-09-09-held-order-numbering.md` (fallback described as intended).

**Trigger.** Relying on the existing suite as proof of the product contract.

**Expected.** Tests prove compiled customer and kitchen paper, both print methods, default per-shift numbering, and custom templates that must not be discarded.

**Actual.** Customer tests assert builtin HTML or raw `ticket_display_no: null`. Compiler unit test **requires** fallback away from custom. Kitchen compiled identity is untested. Browser path never resolves a custom revision. Numbering suite forces `shared_order_sequence='1'`, hiding HO-SEQ-CC-SHIFT. Auto-fire treats “no kitchen route” as success (HO-KITCHEN-SWALLOW).

**Impact.** The suite can stay green while HO-TPL-*, HO-KITCHEN-TICKET, HO-SEQ-CC-SHIFT, and HO-KITCHEN-SWALLOW remain.

**Smallest correction.** Replace the fallback-locking unit case. Add compiled kitchen HTML assertions. Add default `shared_order_sequence='0'` phone-hold vs cashier-sale. Treat unrouted prep as failure if that is the product rule.

**Regression.** The new cases in HO-TPL-BROWSER, HO-TPL-FALLBACK, HO-KITCHEN-TICKET, and HO-SEQ-CC-SHIFT. The old “fallback was called” and “no-route 200” expectations must fail if the product rule changes.

---

### HO-RETRY-KEY — Medium

**Location.** `src/components/OrderNotes.vue` `reprintDirect` lines 619–629: on `!response.ok` and `response.status < 500`, `clearHeldOperationId('receipt', …)`. `prepareHeldCustomerReceipt` lines 49–50 throws 409 when the **new** enqueue is not in `pending|processing|sent|acknowledged`. Receipt idempotency key is `receipt:${printerId}:${requestId}` (`backend/services/printJobIdentity.js` lines 71–74).

**Trigger.** Manual Print Receipt. Queue returns a review/uncertain status → 409. Operator presses Print again.

**Expected.** Same `print_request_id` replays the existing job. No second physical job after uncertain delivery. A later intentional reprint uses a new key only after a successful completion or an explicit reprint action.

**Actual.** 409 is `< 500`, so the client drops the key. The next click is a new UUID → `held-receipt-${id}-${newId}` → a second job. This is an operator click, not an automatic loop, but it is an unsafe retry after uncertain delivery.

**Impact.** Duplicate customer paper when the first attempt was not known-failed.

**Smallest correction.** Keep the receipt operation id on 409 review statuses. Only rotate the key after a completed success or an explicit “print again” that is not a replay.

**Regression.** Force enqueue to return a non-accepted status; retry with the same stored key; job count remains 1. After a clean success, a later print may create job 2.

---

### HO-REPLAY-BROWSER — Medium

**Location.** Create replay in `backend/routes/pos/orders.js` lines 1436–1473. Replay JSON has `order_display_no` but no `customer_receipt`. Browser path does not persist the artifact in `print_queue`.

**Trigger.** Browser-mode immediate hold. Response lost after commit. Client retries the same `hold_request_id`.

**Expected.** Either return the same compiled artifact so the dialog can run once, or leave automatic print to a single durable job. Do not silently skip the only customer copy.

**Actual.** Replay is idempotent for numbering and backend jobs (good). Browser mode has no queued job, so the retry cannot open the dialog. Operator can still use Print Receipt (new key; HO-RETRY-KEY if that 409-clears).

**Impact.** Missed automatic customer copy on the only path that does not enqueue.

**Smallest correction.** Include `customer_receipt` on create replay for `mode: 'browser'`, compiled from the already reserved number (no new reservation). Do not enqueue a second backend job.

**Regression.** Browser-mode hold, replay same `hold_request_id`, body contains the same order number and a compilable artifact. Queue receipt count stays 0.

---

### HO-TPL-VALIDATE — Medium

**Location.** `validateReceiptStructure` in `backend/services/printTemplateEngine.js` lines 370–374. Held identities are checked only if present.

**Trigger.** Admin saves a receipt template that still has paid + guest-check branches only.

**Expected.** Either the template remains valid **and** prints a numbered hold without replacement (preferred), or the editor blocks save with a precise message. Silent print-time discard is not acceptable.

**Actual.** Save succeeds. Print hits HO-TPL-FALLBACK / HO-TPL-BROWSER.

**Smallest correction.** Fix print-time behavior (HO-TPL-FALLBACK). Optional editor warning is not a substitute.

**Regression.** Save old template; print held copy; restaurant layout retained (see HO-TPL-FALLBACK).

---

### HO-PRINT-LEGACY-ID — Medium

**Location.** `backend/routes/print.js` lines 441–442, 531–539. Client `held_order_receipt` is forced false; `prepareHeldCustomerReceipt(..., { forceBackend: true, requestId: requestedPrintId || randomUUID() })`.

**Trigger.** `POST /api/print/print` with `payment_method: 'held'` and no `print_request_id`, or a new id on every retry.

**Expected.** Same semantics as `print_receipt`: stable request key, restaurant template, numbered unpaid copy.

**Actual.** Missing id → new UUID each call → extra jobs. `forceBackend` skips browser artifacts. Template path still goes through `compileBuiltin` (HO-TPL-FALLBACK). Auth is broader than `print_receipt` (reprint permission on any hold).

**Impact.** Duplicate spooler jobs from legacy clients; still hits builtin fallback.

**Smallest correction.** Require the same request-id rules as `print_receipt`. After template fix, this path uses the restaurant template automatically.

**Regression.** Two legacy prints with the same `print_request_id` → one receipt job. Omit id → 400.

---

### HO-SHIFT-ACTOR — Medium

**Location.** `ensureHeldOrderNumber` in `backend/services/HeldOrderNumber.js` lines 6–19. `print_receipt` and `fire_kitchen` pass `{ actorId: req.user.id }` (`orders.js` 1734, 1148). Create passes creator + `data.shift_id`.

**Trigger.** Per-shift sequence (`shared_order_sequence != '1'`). Cashier B prints or fires cashier A’s still-unnumbered scheduled hold.

**Expected.** Number comes from the same sequence that checkout of that hold will use (typically the originating open shift, or the daily counter when no shift).

**Actual.** Reservation uses the **acting** user’s open shift. Checkout later reuses `held_orders.order_seq_scope`, so the paid ticket stays on B’s shift sequence even if A tenders it.

**Impact.** Cross-cashier numbered holds on the wrong shift tape. Shared daily mode is unaffected.

**Smallest correction.** Prefer the hold owner’s still-open originating shift when `shift_id` was stored or is recoverable; otherwise the daily counter (same as create-without-shift). Do not silently mint on a random later cashier’s shift.

**Regression.** Per-shift mode: A opens shift, A schedules a hold, B prints it, A checks out. `orders.order_seq_scope` is `shift:<A>` (or daily if that is the create rule), not `shift:<B>`.

---

### HO-MIGRATE-FIRED — Medium

**Location.** `executeCheckout.js` 1554–1557 (`numberedHold?.order_id ?? reserveDailyOrderId`). `print_receipt` 1734–1735 numbers on first print. `fire_kitchen` 409s when `kitchen_fired=1`. Migration comment: existing holds stay unnumbered until next print/fire (`2026-09-09-held-order-numbers-v1.sql` line 4). Kitchen payloads still use `order_id ?? heldOrder.id` (`HeldOrderKitchenDispatch.js` 322–324).

**Trigger.** Deploy onto rows that already have `kitchen_fired=1` and `order_id` NULL (pre-change fire printed `held_orders.id`). Cashier later prints a customer receipt or checks out.

**Expected.** One durable order number on kitchen and customer copies.

**Actual.** Print/checkout mint **today’s** counter. Kitchen cannot be re-issued (`HELD_KITCHEN_ALREADY_FIRED`). Existing kitchen paper still shows the row id. Customer paper shows the new daily number.

**Impact.** Upgrade of in-flight fired holds splits kitchen and customer identity.

**Smallest correction.** Refuse customer print/checkout of already-fired unnumbered rows until a one-shot baseline reprint under the new number, or mint in a controlled backfill that records the mismatch. Do not silently invent a second identity.

**Regression.** Holds created after this change (they number before the first kitchen round) must stay unchanged.

---

### HO-KITCHEN-LEGACY — Medium

**Location.** `prepareQueuedPrintPayload` kitchen catch, `printDocumentCompiler.js` 297–316. Follow-up/cancel throw 409; normal kitchen logs and returns the raw payload. Spooler then uses `renderKitchenDocument`.

**Trigger.** Invalid/uncompilable custom kitchen on a normal held fire.

**Expected.** Same failure policy as follow-up/cancel.

**Actual.** Warn + persist without artifact. Spooler draws legacy kitchen (`KITCHEN TICKET`, Ticket:/Order:, XL qty). Restaurant kitchen template discarded.

**Smallest correction.** 409 for all kitchen compile failures when the ticket carries a reserved held number.

**Regression.** A bad custom kitchen that “still prints” via legacy would start blocking fires.

---

### HO-KITCHEN-XL — Boundary (not a contract fail by itself)

**Location.** Default kitchen qty/name: `printTemplateDefaults.js` lines 142–145 (`fontSize: 'xl'`). Token map: `printTemplateEngine.js` line 514 (`xl: 36`). Wrap/nowrap CSS: lines 603–604 and 644 (`.pt-kitchen-qty` / `.pt-kitchen-name`) only when `docType === 'kitchen'` **and** the parent row is flow layout. Spooler fallback: `renderDocument.js` lines 192–200 and 386–388 (`text-xl` = 36px, nowrap qty, wrapping name).

**Boundary.**

| Path | 36px qty/name | Nowrap qty + wrapping name |
| --- | --- | --- |
| Builtin / unedited kitchen, compiled | yes | yes (flow row) |
| Spooler HTML fallback | yes | yes |
| Edited kitchen that changes `fontSize` | no (uses the saved size) | yes if still flow qty/name |
| Edited kitchen using absolute item rows | restaurant sizes | **no** — `inFlowRow` is false, kitchen CSS classes not applied |
| Receipt item names | not kitchen; unchanged | n/a |

Kitchen structure validation (`validateKitchenStructure`, lines 404–423) requires visible `qty`/`name`; it does **not** require `xl`.

**Do not** treat “all templates are 36px” as implemented. Report this as the exact boundary.

---

### Out of numbered-hold contract (boundary, not expanded)

Table/split guest checks (`held_orders` with `table_id` or `parent_invoice_id`) stay on `POST /api/print/print` as `GUEST CHECK`. `print_receipt` 404s those rows (`isRegisterHold`). That matches existing progressive-split behavior. Do not treat it as a held-numbering hole unless product scope is explicitly widened.

Spooler v2 does **not** auto-retry `uncertain` / `dead_letter` jobs. Operator reprint of `dead_letter` can still duplicate paper if the first copy landed (HO-RETRY-KEY is the client-side new-key problem, not an agent loop).

### Other branch items (non-held)

- **Timezone / schedules.** `normalizeScheduledDateTime` stores venue wall-clock; `parseBackendTimestamp` treats timezone-free event SQL as UTC; `delivery_date` typeCast is field-name + DATETIME only; audit/JoFotara filters use exclusive next calendar midnight; JoFotara issue dates use `getBusinessCalendarDate`. Isolated `scheduledTimezone.test.js` passed. Scheduled holds still do **not** auto-number when the clock reaches `delivery_date` (eligibility remains empty date / fire / print).
- **Checkout integrity.** Invoice still minted only at paid insert. Fired holds with kitchen delta require follow-up before pay. No JoFotara on unpaid holds. Number reuse is intentional when `held_orders.order_id` is already set.
- **Scale.** 12-digit input is zero-prefixed; catalog exact barcode still wins.
- **Y archive/restore.** Select/insert include `order_id` and `order_seq_scope`.
- **Auth.** `closed_at` on shift payload only.
- **Security.** [Security Review](fd34a9f6-8396-4b07-b454-e34eb73c9289) found no unpaid fiscal issuance, held-receipt forgery, or SQL injection. Shared-terminal `print_receipt` without creator check matches `GET /held_orders` visibility. Sequence-scope issue is HO-SHIFT-ACTOR / HO-SEQ-CC-SHIFT.

Unverified residual: Vite A4 report harness timeout; `delivery_date` typeCast if mysql2 reports a non-`DATETIME` type; no physical-printer certification; no Hostinger upgrade replay in this pass.

## 4. Contract matrix

| Requirement | Result | Notes |
| --- | --- | --- |
| Same configured sequence as checkout | **Fail** | Helper is shared; **scope** is not. Default per-shift + phone holds use `daily_sequences` (HO-SEQ-CC-SHIFT). Cross-cashier print uses the actor’s shift (HO-SHIFT-ACTOR). Isolated tests hide this with `shared_sequence='1'`. |
| One reservation; retries do not advance | **Pass** | Row lock + existing `order_id`; create replay; concurrent print same key |
| Immediate hold auto kitchen + customer | **Fail** | Happy path with both printers works. Unrouted prep swallowed (HO-KITCHEN-SWALLOW). Partial tickets mark fired (HO-KITCHEN-PARTIAL). Missing receipt printer commits kitchen (HO-AUTO-RECEIPT-COMMIT). |
| Kitchen uses order number, not held id | **Fail** | Number is reserved, but paper also prints `Ticket:` (HO-KITCHEN-TICKET). Fallback `?? heldOrder.id` remains if numbering is skipped |
| Customer identity is only the order number | **Pass on builtin / fail on custom** | Builtin held layout OK. Old custom → GUEST CHECK if not discarded. Discard is itself a contract fail |
| Unpaid; no invoice / payment / fiscal | **Pass** | Model nulls invoice/payment/QR; no `orders` row on hold |
| Manual customer print | **Pass** | Card and details `Print Receipt` → `print_receipt` |
| Number survives edit / archive / restore / pay | **Pass** | Columns on Y snapshot; checkout reuses; prior-day number test |
| No duplicate allocation | **Pass** | Counter + unique `(order_seq_scope, order_id)` on holds |
| No automatic duplicate printing | **Fail** | HO-DUP-UNSCHEDULE; HO-RETRY-KEY; HO-PRINT-LEGACY-ID |
| Scheduled timing preserved | **Pass** | No number/print until fire, manual print, or become immediate |
| Default templates | **Pass** (customer builtin; kitchen Ticket extra) | New default receipt has `held-order-display` |
| Edited / custom templates | **Fail** | HO-TPL-BROWSER, HO-TPL-FALLBACK, HO-TPL-HEURISTIC, HO-TPL-COMPILE-ERR, HO-TPL-VALIDATE |
| Provisional / guest-check layouts | **Pass** (guest checks) | Numbered hold sets `guestCheck: false`. Old custom still treats provisional as guest check |
| Browser customer path | **Fail** | Always builtin artifact |
| Spooler customer path | **Fail** | Discard if no held string; keep-wrong-custom if substring is leftover; flatten to builtin on `TEMPLATE_*` |
| Kitchen 36px wrap/nowrap | **Boundary** | HO-KITCHEN-XL |
| Business-day rollover | **Pass** (verified in unit + isolated prior-day reuse) | Hold minted with `getBusinessDate()`; checkout keeps stored scope |

## 5. Verification

Isolation: `scripts/test-isolated.cjs` created `posapp_review_recipe_p1_e3ab082b1226` on loopback and dropped it. `.env.test` is loopback `posapp_test`; the isolated run did not use that name as the created schema.

| Command | Result |
| --- | --- |
| `npx vitest run` on `printDocumentCompiler`, `printDocumentModel`, `printTemplateParity`, `kitchenPrintRouting`, `scaleBarcode`, `businessDate`, `jofotaraXmlBuilder`, `automaticMigrations` | 8 files, **195 passed** |
| `npm run test:frontend --` scheduledTime, orderNotesFormat, orderNotesBoard, reportPeriodNavigation, adminReportA4Rendering | 4 files **26 passed**; `adminReportA4Rendering.spec.js` **hook timeout / 18 skipped** (harness, unverified) |
| `node pos-spooler-printer/tests/render-document.test.js` | passed (includes held fallback HTML without GUEST CHECK/payment; does **not** compile kitchen Ticket coalescing) |
| `node pos-spooler-printer/tests/business-time.test.js` | passed |
| `npm run test:isolated --` `heldOrderNumber`, `heldOrders.autoFire`, `scheduledTimezone`, `kitchenCategoryOverride` | 4 files, **38 passed** on generated DB |

**Observed defects vs green tests.** HO-TPL-*, HO-KITCHEN-TICKET, HO-SEQ-CC-SHIFT, HO-KITCHEN-SWALLOW, HO-KITCHEN-PARTIAL, HO-AUTO-RECEIPT-COMMIT, and TZ-BOOT-01 are present in source. Direct `compileTemplate` confirmed GUEST CHECK on old custom and Ticket:+Order: on kitchen. The 38 isolated tests do not compile kitchen HTML, force shared sequencing, and lock in custom-template fallback plus no-route 200.

**Not run.** Full migration chain, `held-order-number-browser.cjs`, production build, architecture check, physical printers.

## 6. Prioritized repair checklist

1. **Stop replacing restaurant receipts.** Delete held builtin swaps in `HeldOrderReceipt.js` (browser) and `printDocumentCompiler.js` (substring fallback, held compile-error flatten). Compile the active template; rewrite only identity/payment/QR visibility. Invert the fallback-locking unit test. Cover HO-TPL-HEURISTIC (held-gated non-identity node).
2. **Default sequence.** Do not treat “no shift” as shared mode (HO-SEQ-CC-SHIFT). Phone immediate holds must use the same counter as cashier checkout, or fail closed. Reserve on the hold owner’s shift, not the later printer (HO-SHIFT-ACTOR).
3. **Kitchen completeness.** Fail automatic hold / `printKitchenOrder` when prep lines are unrouted (HO-KITCHEN-SWALLOW, HO-KITCHEN-PARTIAL). Do not set `kitchen_fired=1` on a partial ticket. Roll back first automatic customer-print failure with the hold (HO-AUTO-RECEIPT-COMMIT).
4. **Kitchen identity.** Clear `ticketDisplayNo` for held/unpaid kitchen models; fix spooler `renderKitchenDocument`. 409 on kitchen `TEMPLATE_*` instead of legacy HTML (HO-KITCHEN-LEGACY). Assert compiled HTML.
5. **Auto-print once.** Gate `firstImmediate` on “no prior customer receipt”. Keep save-replay idempotent. Keep receipt operation ids on 409. Require `print_request_id` on the legacy print API.
6. **POS boot.** Catch `loadBusinessConfig` like admin (TZ-BOOT-01).
7. **Upgrade.** Already-fired unnumbered rows must not mint a second identity (HO-MIGRATE-FIRED).
8. **Tests.** Default `shared_order_sequence='0'` phone vs cashier; custom template retained; compiled kitchen without Ticket; unschedule-after-manual-print; partial unrouted fire fails; config-fetch failure still mounts POS.
9. **Do not** expand POS into warehouse/accounting or table-split guest-check numbering unless product scope changes. Do not rewrite every saved kitchen template to force 36px.

No fixes were applied in this audit.
