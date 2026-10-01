# Platform Held-Order Settlement Implementation Plan

> **Superseded policy (2026-08-31):** Platform settlement no longer requires `kitchen_fired = 1`. Venues without kitchen printers may close every held platform order; kitchen printing remains an independent operator workflow. A fresh register checkout using an active `order_types.is_deferred_settlement = 1` type is also classified server-side as `payment_method = 'platform'`, with every tender field forced to zero. Browser-supplied `payment_method = 'platform'` remains invalid unless that database-owned order type authorizes it. References below to `PLATFORM_KITCHEN_NOT_FIRED`, kitchen-fired eligibility, and held-settlement-only platform derivation document the original implementation only.

> **For the inline executor:** REQUIRED SKILLS: `ponytail`, `executing-plans`, `test-driven-development`, `mysql`, `express-rest-api`, `vue`, `security-review`, and `verification-before-completion`. Work inline on a `codex/` feature branch. Do not spawn subagents, do not use brainstorming, do not merge, and do not touch unrelated untracked files. This plan intentionally does **not** integrate platform sales with JoFotara.

**Goal:** Let configured delivery-platform order types such as Talabat, Careem, Kabash, and Uber accumulate as held orders, be safely finalized in a batch after their kitchen tickets have already been fired, print one customer receipt per finalized order, and appear as sales under a separate `Platform Sales` line without entering cash, card, drawer, or JoFotara figures.

**Architecture:** `order_types.is_deferred_settlement` is the only configuration flag. A finalized order records the historical settlement classification as `orders.payment_method = 'platform'`; the order's existing `order_type_id` identifies the provider. The batch route is orchestration only: each held order is settled in its own database transaction through the existing `executeCheckout` engine. The server locks and consumes the held row inside that transaction, restores its server-authored price/tax/service-charge/bundle snapshot, creates the normal invoice/order/item/audit/stock records, and deletes the hold only on commit. Reports derive `platform_sales` through the existing financial helpers. No provider table, accounts-receivable ledger, new sale engine, generic integration framework, or JoFotara change is permitted.

**Tech Stack:** Vue 3, Pinia-compatible POS state, Express 5, Socket.IO, mysql2, MariaDB/InnoDB, Vitest/Supertest, the existing print-template compiler, and the tracked local print spooler.

## Executor Control Prompt

Use this prompt before every task:

```text
Execute only the current task from docs/superpowers/plans/2026-07-31-platform-held-order-settlement.md. Work inline, with no subagents and no brainstorming. Re-read the Locked Decisions, transaction contract, and task acceptance checks before editing. Write the specified failing tests first, prove RED for the intended reason, implement the smallest change using the named existing owners, then prove focused GREEN. Trace every edited payment-method conditional through checkout, refund, reporting, printing, identity, schema authority, and UI labels. Never accept `platform` from the public checkout payload; only the trusted held-order settlement context may create it. Never delete or claim a held row outside its checkout transaction. Never fire a kitchen ticket during batch settlement. Never add JoFotara eligibility, document creation, XML mapping, QR behavior, or retry behavior for platform sales. Never create a provider table, receivable record, generic payment abstraction, repository layer, controller layer, or per-report copy of financial math. If current evidence contradicts a locked decision, stop and report the exact conflict instead of improvising. Inspect the diff after every task and do not edit unrelated files.
```

## Terra Handoff Prompt

Copy this entire prompt to Terra:

```text
Execute docs/superpowers/plans/2026-07-31-platform-held-order-settlement.md completely and faithfully.

OPERATING MODE
- Work inline yourself. Do not create or use subagents.
- Do not use brainstorming.
- Use these skills in this order: ponytail (full), executing-plans, test-driven-development, mysql, express-rest-api, vue, security-review, verification-before-completion, then finishing-a-development-branch only for final verification/cleanup.
- Start from the latest clean master and create/switch to branch codex/platform-held-order-settlement. Do not work on master.
- Preserve every pre-existing untracked or unrelated file, especially POS1.zip and posapp.7z.
- Do not merge or push. Commit completed task groups on the feature branch with narrow, descriptive commits.
- Read the entire plan before editing. Then inspect every named existing file and verify the plan's assumptions against current code. If a named file moved, find its current equivalent; do not invent a duplicate owner.

ABSOLUTE SCOPE
- Implement only deferred delivery-platform settlement for register held orders, its customer-receipt spooler path, refunds, and the reporting surfaces explicitly named in the plan.
- Do not implement provider APIs, fees, commissions, bank remittance reconciliation, settlement dates, accounts receivable, a tender-management framework, revenue centers, background jobs, or batch-wide atomicity.
- Do not edit JoFotara production behavior. Do not add platform to JoFotara eligibility, XML, QR, documents, queues, credit notes, retries, operations UI, or tax mapping. Tests must prove platform sales/refunds create no JoFotara document.
- Do not add browser receipt-print behavior. The customer receipt path for this feature is backend canonical reload plus spooler.
- Do not introduce repositories, controllers, factories, generic payment adapters, provider tables, new frontend stores, per-page API files, or a second checkout implementation.
- Reuse executeCheckout, SavedOrderLines, CheckoutAttemptService, HeldOrderKitchenDispatch, financialSql, the existing refund transaction module, the print document model/compiler, and the tracked spooler.
- New production-file budget: one SQL migration and, only if three existing consumers truly duplicate payment labels, one tiny shared frontend label utility. Everything else extends existing owners.

FINANCIAL CONTRACT — NEVER DEVIATE
- order_types.is_deferred_settlement configures which open/held order types use the workflow.
- Finalized historical classification is orders.payment_method = 'platform'. order_type_id identifies Talabat/Careem/etc.
- Platform increases net/gross sales, tax, items, order count, order-type revenue, and platform_sales.
- Platform contributes exactly zero to cash, card, amount tendered, change due, expected drawer cash, and over/short.
- Platform refund_method is forced server-side to 'platform' and reduces platform/net sales only.
- Keep internal compatibility keys when required, but visible totals that include platform must be labeled Net Sales, not Sales Collected.
- Use cent-safe existing money helpers. Do not add new floating-point arithmetic or duplicate SQL formulas.

SECURITY AND TRANSACTION CONTRACT — NEVER DEVIATE
- The normal public checkout route must reject browser-supplied payment_method='platform'. Never add platform to public validatePayments allowlists or checkout controls.
- Only the internal settle-platform route may pass trusted platformHeldOrderId to executeCheckout.
- The browser sends order_type_id and explicit held IDs only. It never supplies trusted totals, cart, tax, tender, user, shift, or kitchen state.
- Require both existing hold and checkout permissions and the actor's own active open shift, including admin/programmer.
- Follow the existing shared-hold policy. Attribute the finalized order/Z to the closing actor and shift; audit both original holder and closer.
- For each ID, executeCheckout must begin/own the transaction, SELECT the held row FOR UPDATE, validate it, settle it, append audit, and delete the hold before commit.
- Never call or reuse /held_orders/claim. Never delete a hold before checkout. Never delete it outside the sale transaction.
- Derive payment_method='platform' and all tender fields as zero on the server.
- Restore only the locked server-authored current-version held snapshot for prices, tax, modifiers, discounts, bundles, and service charge. Legacy/corrupt context fails closed and remains held.
- Use deterministic idempotency key platform-held:<id>. Concurrent/repeated requests must create one invoice.
- Process IDs sequentially with one transaction per ID. Return explicit successes and failures. Never use one giant batch transaction.
- Batch settlement never calls a kitchen dispatcher. Require kitchen_fired=1. A no-matching-printer failure remains visible and cannot be silently treated as fired.
- Queue customer receipts only after commit and only for duplicate=false. Print failure never rolls back or reclassifies the sale.

TDD IS MANDATORY
- For every behavior, write the smallest meaningful test first and run it.
- Capture RED: it must fail because the behavior is missing, not because of syntax, fixtures, imports, or environment.
- Only after correct RED, write the smallest production change that makes it GREEN.
- Re-run the focused test immediately. Refactor only while green.
- Never write production code first. Never weaken an assertion to make code pass. Never replace a behavioral test with a source-string assertion when the real route/service/renderer can be exercised.
- Prefer existing fixtures/builders. Add helpers only when repeated setup is materially obscuring multiple tests.
- Execute every case enumerated in Tasks 1–10, including public-forgery rejection, permissions, own shift, shared hold attribution, kitchen gate/no refire, frozen price/tax, bundle drift, service charge, rollback preservation, partial batch, idempotent retry, true concurrency, canonical receipt, print failure, partial/full platform refund, all report surfaces, drawer invariance, and JoFotara exclusion.

TASK LOOP
For Task 1 through Task 10, in order:
1. Mark only that task in progress in your local plan/todo mechanism.
2. Re-read its files, TDD sequence, and applicable locked decisions.
3. Search all callers/conditionals before changing a shared helper.
4. Write and run the failing test(s); report the exact expected RED internally.
5. Implement the minimum cohesive change.
6. Run the task's focused GREEN tests.
7. Inspect SQL/locking/rollback behavior when applicable.
8. Run git diff --check and inspect the task diff for accidental scope.
9. Commit only that completed task group. Do not include unrelated files.
10. Continue automatically to the next task. Do not ask for routine approval.

STOP CONDITIONS
- Stop and report before improvising if current schema or runtime behavior fundamentally contradicts a locked plan decision.
- Stop if safe completion would require JoFotara integration, destructive migration, browser-supplied financial authority, or a new accounting/provider domain.
- If a test command names a stale/nonexistent test file, locate the existing equivalent as the plan instructs and continue. That alone is not a blocker.
- If an existing unrelated test is already failing, prove it is pre-existing, record it, and do not repair unrelated code.
- Do not claim completion while any affected test/build is failing or any listed acceptance case is unverified.

FINAL ATTACK AND VERIFICATION
- Run all focused commands in Task 10, schema drift validation, admin build, spooler renderer/report tests, and the complete browser workflow described by the plan.
- Search every payment_method/refund_method/cash_sales/card_sales/expected_cash conditional and explicitly classify each platform-relevant occurrence as changed, naturally generic, or intentionally excluded.
- Search the JoFotara production paths and prove there is no new platform eligibility or integration.
- Inspect migration/baseline/manifest/bootstrap/schema-validation parity and checksum authority.
- Attack concurrency, rollback, partial success, stale held snapshots, kitchen idempotency, print-after-commit, refund allocation, report reconciliation, and UI retry behavior one final time.
- Run git diff --check and review every changed file. Remove accidental abstractions, duplicate calculations, dead exports, debug output, generated artifacts, and unrelated formatting.
- Confirm master is untouched, feature branch commits are clean, and POS1.zip/posapp.7z are untouched.

FINAL REPORT
Report:
1. branch and commit list;
2. exact behavior delivered;
3. schema migration and rollback constraint;
4. tests run with pass counts;
5. browser workflow results;
6. proof that cash/card/drawer and JoFotara stayed excluded;
7. any remaining risk or manual physical-printer check.

Do not merge or push. Stop after the feature branch is complete and verified.
```

## Evidence and Locked Decisions

Repository evidence:

1. `backend/routes/pos/orders.js` already owns register held orders. Saved holds contain a server-authored cart, order type, customer/delivery metadata, order discount, tax mode/version, bundle selections, and service-charge snapshot. Its current `/claim` endpoint deletes the hold before checkout and reprices against the live catalog, so it is deliberately unsuitable for deferred-platform settlement.
2. `backend/modules/checkout/executeCheckout.js` already owns transaction boundaries, shift locking, permissions, price/tax calculation, service-charge transitions, stock deduction, order and item inserts, bundle children, invoice numbering, receipt presentation, idempotency, audits, cache invalidation, and realtime events. A second sale-writing implementation would be both duplication and a financial risk.
3. `backend/modules/orders/SavedOrderLines.js` already restores trusted saved prices and tax values for table/split settlement. Platform settlement must reuse this machinery for the locked server-held snapshot so an accepted marketplace price cannot change when the live catalog changes.
4. `backend/services/HeldOrderKitchenDispatch.js` and `/held_orders/fire_kitchen` already provide an idempotent `kitchen_fired` gate. Batch settlement must inspect that state but must never call the dispatcher.
5. `backend/services/financialSql.js`, `financeMetrics.js`, and `financialEventMetrics.js` are the existing financial source of truth used across daily, dashboard, shift, audit, refund, and print reports. Platform calculations belong there, not in route-local SQL copies.
6. `receivable` is the wrong settlement type. It creates due-date and outstanding-balance semantics, prints a receivable billing block, and participates in JoFotara flows. Delivery-platform sales need neither a customer debt nor cash collection today.
7. The receipt template already displays `payment.method` and hides Tendered/Change when their values are zero. The builder therefore needs no platform-specific block.
8. `orders.order_type_id` already preserves Talabat versus Careem versus other providers. One generic `platform` payment method gives the independent reporting axis without another provider model.

External evidence supports this shape: Oracle Simphony models each delivery provider as a dedicated tender that can assume the check is paid in full and reports tenders separately, while its close-check workflow can close held items without sending them again. Toast likewise supports delivery providers as separately reported “other payment options.” This plan adapts those concepts to the system's existing order-type model instead of copying their larger tender architecture.

- [Oracle Simphony tender configuration](https://docs.oracle.com/en/industries/food-beverage/simphony/19.7/simcg/t_dc_tender_media.htm)
- [Oracle Simphony Tender Media report](https://docs.oracle.com/en/industries/food-beverage/reporting-and-analytics/rarrg/c_tender_media.htm)
- [Oracle Simphony close check without resending held items](https://docs.oracle.com/en/industries/food-beverage/simphony/sipou/t_checks_end_round_close_check.htm)
- [Toast other payment options](https://central.toasttab.com/articles/Knowledge/Setting-Up-Other-Payment-Options)

Locked decisions:

1. The database value is `platform`; the visible English label is `Platform Sales` and Arabic is `مبيعات المنصات`. The order type continues to show the actual provider.
2. A platform sale contributes to gross/net sales, tax, item sales, product/category totals, order counts, order-type revenue, cashier/shift history, and refunds.
3. A platform sale contributes zero to cash sales, card sales, amount tendered, change, expected drawer cash, and cash-over/short.
4. `sales_collected` remains an internal compatibility key where already exposed, but visible UI/report copy must say `Net Sales` when the number includes non-cash platform revenue.
5. Batch settlement requires the acting user's own active open shift, including admin/programmer users. It also requires existing hold and checkout permissions. The browser cannot select another user's shift.
6. Every selected hold must belong to the requested configured platform order type and must have `kitchen_fired = 1`. The batch never fires or re-fires kitchen tickets.
7. Each hold commits independently and sequentially. One corrupt order does not roll back earlier valid orders; failures remain held and are returned explicitly.
8. Customer receipts are queued only after commit and only for newly finalized orders. A print failure does not roll back the sale. Duplicate retries do not auto-print again; the operator can reprint from order history.
9. Hold-time prices, taxes, modifiers, bundle choices, discount, customer/order metadata, and service charge are authoritative only when read from the locked server-held row with the current tax-context version. Missing/corrupt legacy context fails closed and the hold remains untouched.
10. `platform` is server-only. The ordinary `/checkout` endpoint and client payment selector continue accepting only their current methods.
11. Refunds of platform orders use `refund_method = 'platform'`, including partial refunds. They reduce platform sales and total net sales without changing cash/card/drawer values.
12. No JoFotara production file, configuration, eligibility set, XML builder, document state, queue, QR, or operations UI is changed. Platform orders create no JoFotara document in this phase.
13. Do not add `orders.is_deferred_settlement`, a settlement/provider table, a shift `final_platform_sales` column, or an index on the boolean order-type flag. The existing historical order and recomputed-report model is sufficient.
14. The migration is forward-only after platform orders exist. Rolling application code back may leave the additive column and enum value in place; the migration must not destructively remove them.
15. Follow the existing shared-claim policy: any user with both hold and checkout permissions may settle a visible platform hold. The finalized order and Z ownership belong to the closing user's current shift; an audit event must preserve both `held_by_user_id` and `settled_by_user_id`.
16. Invoice/business time is the actual settlement time, not the original hold time. The hold creation timestamp remains audit context. Backdating sales or provider remittance reconciliation is outside this phase.
17. `kitchen_fired = 1` means at least one kitchen print job was accepted by the existing dispatcher. A hold with no matching kitchen printer remains blocked; the system must expose that configuration failure rather than silently mark it sent or settle it.

## User Workflow and API Contract

1. An administrator edits an order type in Settings and enables `Deferred platform settlement`.
2. Cashiers hold provider orders exactly as today and explicitly use `Fire kitchen`. A successful fire immediately changes the card to `Kitchen sent` and disables that action.
3. In the Held Orders screen, the active flagged order-type lane shows `Close & print`, eligible count, and held total. On mobile the action appears once in the active order-type header, not on every card.
4. Confirmation names the provider, count, and total and states that the action finalizes sales without adding cash/card to the drawer.
5. The frontend sends an explicit snapshot of the visible IDs:

```http
POST /api/pos/held_orders/settle-platform
Content-Type: application/json

{
  "order_type_id": 4,
  "held_order_ids": [81, 82, 83]
}
```

6. Validate a nonempty, unique array with a conservative maximum of 100 positive integer IDs. Reject an invalid body, unflagged/inactive order type, missing own open shift, or missing permissions before processing.
7. Return HTTP 200 for a processed batch, including partial success:

```json
{
  "successes": [
    {
      "held_order_id": 81,
      "invoice_id": 410,
      "invoice_display_no": "INV-410",
      "total": 12.50,
      "duplicate": false
    }
  ],
  "failures": [
    {
      "held_order_id": 82,
      "publicCode": "PLATFORM_KITCHEN_NOT_FIRED",
      "message": "Fire this order to the kitchen before closing it."
    }
  ]
}
```

8. Use top-level 4xx responses only when no batch should start. A per-order validation or transaction failure belongs in `failures`. Do not expose SQL/internal stack messages.
9. The UI removes successes, retains failures, queues receipts for `duplicate: false` successes, and reports closed/failed/print-failed counts. It then refetches holds so another terminal's concurrent result is reflected.

## Transaction Contract

Add one optional, trusted `platformHeldOrderId` argument to `executeCheckout({ user, input, io, ipAddress, authorizeManagerOverride, platformHeldOrderId })`. It is supplied only by the internal batch route, never read from an HTTP checkout body.

For platform context, inside the existing checkout transaction:

1. Select the register-held row `FOR UPDATE` and reject missing/table-split rows.
2. Parse and validate `cart_data`; require the current `tax_context_version`, stored `tax_inclusive_at_hold`, stored tax-registration type, valid item/bundle structure, matching `order_type_id`, `is_deferred_settlement = 1`, and `kitchen_fired = 1`.
3. Replace all client financial/order inputs with the locked snapshot: cart, order type, customer fields, delivery date, order note, order discount, hash, service-charge snapshot, tax mode, and tax-registration type.
4. Derive `payment_method = 'platform'`, `amount_tendered = 0`, `cash_amount = 0`, `card_amount = 0`, and `change_due = 0` on the server. Do not call the public `validatePayments()` path for platform and do not add platform to its allowlist.
5. Use `SavedOrderLines` price and tax maps so live catalog changes cannot rewrite the accepted hold amount. Continue all normal total, discount permission, stock, invoice, order item, audit, service-charge, and receipt validation.
6. Use deterministic idempotency key `platform-held:<held_order_id>` through the existing checkout-attempt owner. Normal success returns `duplicate: false`; the duplicate response returns `duplicate: true`.
7. Append a platform-settlement audit event containing held order ID, original holding user ID, settling user ID, shift ID, order type ID, and invoice ID. Do not put customer/cart contents into the audit payload.
8. Delete the held row inside this same transaction only after all sale and audit writes have succeeded. A rollback preserves the hold.
9. Commit, then run the existing checkout post-commit work and emit `held_orders_changed`. Printing occurs outside this transaction.

Do not reuse `/held_orders/claim`; its delete-before-checkout and live-repricing semantics are intentionally different.

## Implementation Tasks

### Task 1: Add the minimal schema and schema authority

**Files:**

- Create: `backend/migrations/2026-07-31-platform-held-order-settlement.sql`
- Modify: `deployment/database/baseline.sql`
- Modify: `deployment/database/manifest.json`
- Modify: `deployment/tools/bootstrap-database.js`
- Modify: `backend/services/schemaValidation.js`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`
- Modify: `backend/tests/integration/installerBaseline.test.js`

**TDD sequence:**

1. Add failing schema-authority and installer-baseline assertions for `order_types.is_deferred_settlement` and the `platform` member of `orders.payment_method`.
2. Create an idempotent phpMyAdmin-safe migration that adds `is_deferred_settlement TINYINT(1) NOT NULL DEFAULT 0` and modifies the existing payment enum by preserving every current member and appending `platform`.
3. Update the canonical baseline, manifest checksum/order, bootstrap migration ledger, fixture schema, and validation constants together.
4. Do not index the boolean flag and do not add another order column.
5. Run `node scripts/validate-schema-drift.js` and `npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/integration/installerBaseline.test.js`.

### Task 2: Expose the order-type flag through existing configuration

**Files:**

- Modify: `backend/routes/admin/printers.js`
- Modify: `src/admin/pages/Settings.vue`
- Modify/add the nearest existing order-type admin test; do not create a new API layer.

**TDD sequence:**

1. Add failing create/update/read assertions that normalize the flag to `0/1` and preserve existing name/hash/default behavior.
2. Extend the existing order-type `INSERT` and `UPDATE`; `SELECT ot.*` already returns the field.
3. Add one Settings toggle with explanatory copy: orders of this type are held, kitchen-fired separately, and later finalized as platform sales outside the cash drawer.
4. Show a compact badge on configured types. Do not introduce provider credentials, settlement dates, commissions, or an order-type composable.
5. Verify admin build and focused route/UI tests.

### Task 3: Generalize the existing saved-bundle insertion helper

**Files:**

- Modify: `backend/services/bundleOrderItems.js`
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: existing bundle unit/integration tests under `backend/tests/`

**TDD sequence:**

1. Add failing tests showing that a trusted saved bundle can be inserted after the live bundle definition changes, removed children stay omitted, and removal audit rows are preserved for a register hold.
2. Rename/generalize `insertSplitSnapshotBundleChildren` to `insertSnapshotBundleChildren` with an options object such as `{ cashierId, auditRemoved }`.
3. Keep the split path behavior unchanged with `auditRemoved: false`; the later platform path uses `auditRemoved: true`.
4. Reuse the existing `bundle_modifications` audit shape. Do not make a second platform-only bundle helper and do not query the live bundle definition for trusted held snapshots.
5. Run the focused bundle and split-check tests to prove no regression.

### Task 4: Add trusted held-order settlement to the checkout engine

**Files:**

- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/utils/orderIdentity.js`
- Modify: `backend/services/printDocumentModel.js`
- Modify: `backend/tests/integration/checkout.test.js`
- Create: `backend/tests/integration/platformHeldSettlement.test.js`
- Modify: `backend/tests/unit/printDocumentModel.test.js`

**TDD sequence:**

1. First prove ordinary `/checkout` rejects browser-supplied `payment_method: 'platform'`.
2. Add failing integration cases for the full transaction contract: flagged type only, own active shift, required permissions, shared visible hold ownership, register hold only, kitchen already fired, order-type match, current tax-context version, frozen price/tax after catalog changes, service-charge finalization, bundles, discounts, stock, invoice identity, zero tender fields, original/settling-user audit attribution, deletion on commit, preservation on rollback, deterministic retry, and concurrent double-submit.
3. Implement the optional trusted context in `executeCheckout`; derive all values from the locked row and reuse existing checkout stages rather than branching into a second checkout function.
4. Rename the misleading `PAID_PAYMENT_METHODS` concept in `orderIdentity.js` to finalized/invoiced payment methods while adding `platform`; preserve its public function if callers rely on the name.
5. Allow `printDocumentModel` to construct the same zero-tender model used by receivable, but with method `platform` and no billing object. Do not expand public payment validation.
6. Return an explicit `duplicate` boolean from both normal and duplicate checkout results.
7. Confirm no platform checkout creates a row in `jofotara_documents`; do this through the platform integration test without editing JoFotara production code.

### Task 5: Add the batch route and make kitchen status truthful

**Files:**

- Modify: `backend/routes/pos/orders.js`
- Modify: `src/components/OrderNotes.vue`
- Modify: `src/components/OrderNoteCard.vue`
- Modify/add focused tests under `src/components/__tests__/` and `backend/tests/integration/platformHeldSettlement.test.js`

**TDD sequence:**

1. Add failing route tests for invalid/duplicate/oversized IDs, inactive or unflagged type, no own open shift, insufficient hold/checkout permission, mixed order types, partial success, stable public error codes, and sequential processing.
2. Implement `POST /held_orders/settle-platform` as a thin orchestrator. Preflight the acting user's open shift and type, then call `executeCheckout` once per requested ID. Do not open a batch-wide DB transaction.
3. Preserve success results when a later ID fails; log internal errors with held ID and return only safe messages.
4. Ensure the existing held-order GET data maps `kitchen_fired` and the order-type flag to the UI.
5. After a successful kitchen fire, update/refetch the held row immediately, show `Kitchen sent`, and disable the fire action so the operator does not discover idempotency through a 409 error.
6. Add the responsive lane/header action, confirmation, busy state, partial-result summary, success removal, failure retention, and final refetch. Prevent double-click while a batch is running.
7. Do not add the close button to ordinary held order types and do not add a second settlement modal if the current confirmation component can express the warning.

### Task 6: Print committed customer receipts through the canonical spooler path

**Files:**

- Modify: `src/components/OrderNotes.vue`
- Modify: `pos-spooler-printer/renderDocument.js`
- Modify: `pos-spooler-printer/tests/render-document.test.js`
- Modify: relevant backend print tests under `backend/tests/unit/`

**TDD sequence:**

1. Add failing tests that a platform receipt shows `Payment PLATFORM`, provider order type, normal totals/items/tax, and no Tendered, Change, receivable billing block, or JoFotara QR.
2. Add an explicit platform case to the spooler's legacy receipt renderer so legacy fallback also omits zero tender/change. The v1 template path should work through the generic payment field.
3. For each newly committed success, call the existing canonical backend print route with only `print_type: 'receipt'`, selected receipt printer, and `invoice_id`. Let the backend reload the order and receipt presentation.
4. Replace `OrderNotes.vue`'s hand-built customer-receipt reprint payload with the same canonical invoice-ID call if the current backend route already supplies all required fields. This removes an existing duplicate receipt-construction path within the edited feature.
5. Keep print after commit. Record/report queue failures separately and never convert them into settlement failures.
6. Do not call any kitchen print path from batch settlement.

### Task 7: Establish platform as a first-class financial dimension

**Files:**

- Modify: `backend/services/financialSql.js`
- Modify: `backend/services/financeMetrics.js`
- Modify: `backend/services/financialEventMetrics.js`
- Modify: `backend/services/dailyReportBuilder.js`
- Modify: `backend/services/dashboardDataBuilder.js`
- Modify: `backend/services/auditReportBuilder.js`
- Modify: existing financial unit/integration tests

**TDD sequence:**

1. Add failing fixture scenarios containing cash, card, platform, partial platform refund, subscription receivable issuance, and later subscription collection.
2. Extend the shared refund rollup with platform allocation and add shared `NET_PLATFORM`, defined as the order's net total only when its payment method is platform.
3. Extend finalized-order business-time logic so platform orders use invoice time like other finalized sales.
4. Return normalized `platform_sales` from financial metrics and `platform_sales`/`refund_platform` from financial-event combination. Keep cash/card fields unchanged.
5. Add platform to daily payment rows, dashboard payment breakdown, audit summary, and per-shift data. Include platform in net sales/tax/order metrics; exclude it from `total_collected` and expected drawer cash.
6. Preserve existing compatibility payload keys, but change visible `Sales Collected` labels to `Net Sales` wherever that value includes platform or receivable issuance.
7. Assert at cent precision that a platform sale increases net sales/tax/items/order count, a platform refund reduces platform/net sales, and neither operation changes cash/card/drawer numbers.

### Task 8: Wire X/Z, admin order history, and spooler reports

**Files:**

- Modify: `backend/routes/auth.js`
- Modify: `backend/routes/admin/shifts.js`
- Modify: `backend/routes/admin/orders.js`
- Modify: `backend/routes/print.js`
- Modify: `src/components/pos/ShiftReportModal.vue`
- Modify: `src/admin/pages/Shifts.vue`
- Modify: `src/admin/pages/Orders.vue`
- Modify: `src/admin/components/OrdersSummaryPanel.vue`
- Modify: `src/admin/pages/dailyReportPayloads.js` only if its allowlist drops unknown payment keys
- Modify: `pos-spooler-printer/server.js`
- Modify: `pos-spooler-printer/report-html.js`
- Modify: focused report/order/spooler tests

**TDD sequence:**

1. Add failing assertions for the same `platform_sales` value in X preview, Z preview, saved Z payload, canonical print reload, admin shift detail, daily summary, audit report, and spooler HTML.
2. Add the separate platform line everywhere cash and card tender summaries are shown. Leave expected cash equations exactly unchanged.
3. Extend backend print allowlists/sanitizers and daily-report payment-key labels so the field survives canonical reload instead of disappearing before the spooler.
4. Add `platform` to Orders filters, payment labels, and summary statistics as `platform_revenue`; keep provider grouping under existing order-type reporting.
5. Add one small shared frontend payment-label utility only if at least the existing `Orders.vue`, `WaiterPerformance.vue`, and A4/receipt view currently repeat the same cash/card/split fallback. Use it to prevent platform from being mislabeled as Split. Do not create per-page API owners or refactor these pages otherwise.
6. Verify platform appears as sales, never as collected cash/card, in every affected report surface.

### Task 9: Make platform refunds preserve tender truth

**Files:**

- Modify: `backend/routes/pos/refunds.js`
- Modify: the existing cohesive refund transaction module used by that route
- Modify: `backend/services/financialEventMetrics.js`
- Modify: `backend/services/dailyRefundReportBuilder.js`
- Modify: `src/admin/pages/Orders.vue`
- Modify: receipt/refund report labels in the existing backend/spooler owners
- Modify: `backend/tests/integration/refunds.test.js`

**TDD sequence:**

1. Add failing partial/full platform refund cases proving the server forces `refund_method = 'platform'` regardless of a browser cash/card value.
2. Make the refund transaction derive the method from the original platform order. Do not offer a tender selector for platform orders in Orders UI.
3. Extend `allocateRefundPayment()` to return `{ cash, card, platform }` consistently for every branch, allocating the full platform refund to platform and zero to cash/card.
4. Add platform to refund report filters and labels. Reuse the same shared financial rollup from Task 7.
5. Assert stock restoration, refund items, audit events, refund status, and customer receipt behavior remain the same as ordinary refunds while cash/card/drawer figures remain unchanged.
6. Assert no JoFotara credit-note/document row is created for a platform refund; do not edit JoFotara production files.

### Task 10: Cross-path verification and bounded cleanup

**Files:** No new production files unless a failing contract exposes a missing owner. Modify only stale tests or labels revealed by this task.

**Verification:**

1. Run schema checks:

```powershell
node scripts/validate-schema-drift.js
npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/integration/installerBaseline.test.js
```

2. Run checkout/hold/refund integration checks:

```powershell
npx vitest run backend/tests/integration/platformHeldSettlement.test.js backend/tests/integration/checkout.test.js backend/tests/integration/refunds.test.js
```

3. Run affected financial/report checks:

```powershell
npx vitest run backend/tests/integration/businessDayReconciliation.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/auditReports.test.js backend/tests/integration/dashboardDataBuilder.test.js backend/tests/integration/adminOrdersStats.test.js backend/tests/integration/printShiftReport.test.js
```

If an exact listed test file does not exist, locate the current equivalent with `rg --files backend/tests` and add the assertion there; do not create duplicate suites merely to preserve this filename.

4. Run spooler checks:

```powershell
node pos-spooler-printer/tests/render-document.test.js
node pos-spooler-printer/tests/report-html.test.js
node pos-spooler-printer/tests/spooler-report-rendering.test.js
```

5. Run focused component tests added by Tasks 2, 5, and 8, then build:

```powershell
npm run build:admin
```

6. Inspect the final diff with these searches:

```powershell
rg -n "platform|cash_sales|card_sales|expected_cash|payment_method|refund_method" backend src pos-spooler-printer
rg -n "JoFotara|Jofotara|jofotara" backend/modules/checkout backend/routes/pos backend/services/JofotaraService.js
git diff --check
git status --short
```

The JoFotara search must show no new platform eligibility or production integration. Review every payment-method conditional found by the first search; classify it as intentionally unchanged or covered by a platform branch/test.

7. Perform one browser workflow on a test database:

- Configure Talabat as deferred platform settlement and leave Dine In ordinary.
- Hold two Talabat orders and one ordinary order.
- Verify closing is blocked until each Talabat kitchen ticket has been fired.
- Fire each once; confirm UI disables repeat firing.
- Change a product's live price/tax after holding and before closing.
- Close Talabat; verify two invoices retain held totals, stock moves once, holds disappear, ordinary hold remains, and two customer receipts are queued.
- Repeat the same request and simulate two terminals; verify one invoice per hold and no automatic duplicate receipt.
- Force one corrupt hold; verify valid holds commit and the corrupt hold remains with a useful error.
- Refund part of one platform invoice; verify Platform Sales and Net Sales decrease while Cash, Card, Expected Cash, and over/short do not move.
- Verify X, Z, daily, audit, shift, dashboard, order history, order-type breakdown, and spooler output agree.
- Verify `jofotara_documents` has no rows for the platform sale or refund.

## Adversarial Review: How This Plan Was Attacked

| Attack | Required result | Design defense |
|---|---|---|
| Browser sends `payment_method: platform` to normal checkout | Rejected | Platform is absent from public payment validation and is derived only from trusted context. |
| Cashier changes IDs/type/total in batch payload | No forged sale | Payload contains IDs only; locked server rows own type, contents, and money. |
| Two terminals close the same hold | One invoice | Row lock plus deterministic checkout idempotency key. |
| Crash after order insert but before hold delete | Neither partial sale nor lost hold | Both writes share one transaction. |
| Print queue is unavailable after commit | Sale remains valid and reprintable | Printing is post-commit and separately reported. |
| Some order in a 30-order batch is corrupt | Earlier successes remain; corrupt hold remains | One transaction per hold and explicit partial results. |
| Kitchen was never fired | Settlement blocked | Locked row must have `kitchen_fired = 1`. |
| Kitchen was already fired | Never fired twice | Batch contains no dispatch call; UI disables the existing fire action after success. |
| No kitchen printer matches the order | Settlement remains blocked with a configuration error | Existing dispatcher does not mark `kitchen_fired`; batch never treats “nothing printed” as success. |
| Product price/tax/bundle changes after platform accepted order | Invoice retains accepted snapshot | Current-version server-held snapshot restored through saved-line helpers. |
| Legacy or manually corrupted hold lacks trusted tax context | No guessed money | Fail closed, preserve hold, instruct operator to restore/re-hold after deployment. |
| Cashier applies forbidden discount before hold | No permission bypass at settlement | Existing checkout discount authorization still runs for the actor. |
| Admin closes without an open shift | Blocked | Batch preflight requires the actor's own active shift for Z ownership. |
| Platform refund is submitted as cash | Drawer remains correct | Server forces refund method from original order. |
| Report adds platform to revenue but not refund allocation | Tests fail reconciliation | Shared `NET_PLATFORM` and explicit platform refund allocation feed every report. |
| Platform sale appears as cash/card or “Split” | Visible contract test fails | Separate platform field and shared display mapping. |
| Platform gets treated as customer receivable | No due/outstanding data exists | New server-only tender, not `receivable`. |
| Platform accidentally enters JoFotara | Regression test fails | No JoFotara code edits; unsupported method yields no document. |
| Order type flag later changes off | Historical reports remain stable | Finalized order stores `payment_method = platform`; flag configures future/open holds only. |
| One cashier holds and another closes | Sale belongs to the closer's current shift; both actors remain traceable | Existing shared-claim policy plus an explicit platform-settlement audit event. |
| An old hold is settled on a later day | It reports on settlement/invoice business day | No silent backdating; original held timestamp remains in audit context. |
| Boolean flag grows into provider accounting | Prevented by scope | Commissions, remittances, statements, settlement dates, and reconciliation ledgers are explicitly deferred. |

## Explicitly Deferred

- JoFotara submission, QR, document state, credit notes, or tax-code mapping for platform orders.
- Platform commissions, fees, net remittance, bank-check receipt, settlement date, statement import, or accounts reconciliation.
- Automatically creating/holding orders from provider APIs.
- A generic tender-management UI or one tender row per provider.
- Automatic kitchen firing during batch close.
- Batch-wide atomicity or background-job infrastructure.
- Revenue-center scoping from the separate deferred revenue-centers plan.

If platform settlement later needs provider remittance reconciliation, add that as a separate ledger keyed to the already-finalized platform orders. Do not retrofit it into this closing transaction.

## Completion Definition

This phase is complete only when a flagged held order can be kitchen-fired once, finalized exactly once through the existing checkout engine, printed as a normal customer receipt, refunded against the platform tender, and reconciled identically across X/Z, daily, audit, shift, dashboard, orders, item, and order-type reporting—while cash/card/drawer values remain unchanged and no JoFotara document is created. The final implementation should add only one migration, one new integration suite, and at most one small shared frontend label utility; all other work extends existing owners.
