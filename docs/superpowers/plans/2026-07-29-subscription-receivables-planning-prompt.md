# Subscription Receivables — Implementation-Planning Prompt

Use this prompt to produce or re-audit the implementation plan for subscription paid-now, pay-later, and collection workflows.

---

You are the owner of a restaurant POS financial change. Work from repository evidence, not assumptions. Use ponytail, security-review, mysql, codebase-design, JoFotara integration, Vue, and TDD guidance. Do not use brainstorming and do not delegate to subagents.

Your job is to write a complete, executable TDD implementation plan—do not implement it.

## Required business contract

1. Preserve the existing cashier subscription sale/renewal and redemption workflows and the existing `pos.subscriptions` permission.
2. Preserve manual/complimentary admin subscriptions as a clearly labelled non-financial workflow.
3. Add a real receivable workflow for a subscription issued now but paid later. The subscription may be redeemed while the receivable is open, so this is not a reservation or an unpaid cart.
4. Keep three independent facts:
   - invoice/issue date: when the subscription sale legally happened;
   - due date: when payment is expected;
   - collection date, shift, operator, and tender: when money actually entered the business.
5. Never let a client-supplied due date, subscription start date, or end date move a cash/card collection into another business day or shift.
6. A cashier who takes cash today must record a collection today. If they fraudulently choose pay-later, the receivable must appear immediately and prominently in the admin Subscriptions page as outstanding, attributed to that cashier and shift. Be explicit that software cannot detect physical cash that was never entered at all.
7. Admin dashboard users may issue a receivable without an open shift, but must not record cash/card collections there. All money collection/refund/reversal actions must run through a POS user’s authenticated open shift.
8. Paid-now sales stay on the existing checkout path. Receivable issuance must reuse the canonical checkout/order/pricing/invoice machinery rather than duplicate order math.
9. Later collection must not create a second order, second sale, second subscription, or second JoFotara invoice.
10. Receivable issuance must create the JoFotara receivable invoice using the frozen tax profile (`022` sales-tax receivable; `021` income-tax receivable remains unverified by the production reference), and buyer data must meet the proven official receivable requirements. Do not enable the workflow until the invoice code and minimum buyer shape are validated. JoFotara has no known public sandbox, so never fake a live invoice merely to satisfy a test.
11. Credit notes retain the existing configured return name (`012` sales-tax or `011` income-tax) with document type `381`; do not mirror `022`/`021` without new live evidence.
12. A later collection is cash movement, not new revenue. Sales reports count the invoice on issue date; drawer/Z/X/audit cash reports count the collection on collection date and shift.
13. V1 collection is full outstanding balance only. Design the ledger so partial payment can be added later without schema replacement, but do not expose or implement partial-payment UI now.
14. Support safe cancellation/refund and mistaken-collection reversal. Never delete or rewrite collection history; append a reversal linked to the original collection and require a reason.
15. Preserve cash tendered/change for deterministic receipts while accounting and drawer totals use only net cash applied.
16. Freeze the receivable buyer name/phone/address on the order so later customer edits cannot change delayed JoFotara submission or reprints. Do not add speculative tax/national-ID fields unless validation proves them required.
17. Due date and receivable reason are immutable in V1. Disabling new receivable issuance must never hide or block settlement/refund of existing debt.
18. Preserve all existing paid, manual, redemption, refund, split-payment, receipt-display, JoFotara retry, and installer/schema-authority contracts.

## Evidence that must be rechecked

- `backend/modules/checkout/executeCheckout.js`: authenticated shift locking, canonical pricing, invoice creation, idempotency, subscription activation, and post-commit behavior.
- `backend/services/SubscriptionService.js`: source derivation, entitlement snapshots, redemption usability, and paid-order activation.
- `backend/routes/admin/subscriptions.js`: current manual creation, listing/detail, metrics, cancellation, reversal, and refund behavior.
- `backend/routes/pos/subscriptions.js`: customer lookup and shift-owned redemption.
- `backend/services/JofotaraService.js` and `backend/services/JofotaraXmlBuilder.js`: current cash-only eligibility and `011`/`012` hardcoding.
- `backend/services/financialSql.js` plus every consumer of `orders.cash_amount`, `orders.card_amount`, and `payment_method NOT IN ('unpaid_table','voided')` in shift, Z/X, audit, daily, admin, expense, customer, and subscription reports.
- `src/components/pos/SubscriptionModal.vue`, `src/components/pos/CheckoutModal.vue`, `src/pos/stores/orderSessionStore.js`, and `src/pos/stores/orderSession/checkoutFlow.js`.
- `src/admin/pages/Subscriptions.vue`, `src/admin/components/SubscriptionAssignmentModal.vue`, and `src/admin/components/SubscriptionDetailDrawer.vue`.
- `backend/tests/fixtures/seed.js`, `deployment/database/baseline.sql`, `deployment/tools/bootstrap-database.js`, `backend/services/schemaValidation.js`, installer baseline tests, migration preflight/apply/verify conventions, and schema drift checks.
- The official JoFotara manuals: receivable invoices are distinct from cash invoices and require buyer information.

## Design constraints

- Prefer one narrow `subscription_collections` ledger over a generic accounting framework. Store only `subscription_id`; derive the unique purchase invoice through the subscription instead of duplicating `invoice_id`.
- Extend the existing `orders` invoice model with `payment_method='receivable'` and `payment_due_on`; do not invent a parallel invoice table.
- Keep subscription commercial rules in `SubscriptionService.js` unless a genuinely deep independent module emerges. Do not create one file per operation, repositories, controllers, event buses, or a generic AR framework.
- Reuse `executeCheckout` for canonical receivable issuance under a strict subscription-only guard.
- Derive outstanding/partial/paid/overdue from immutable invoice and collection facts; do not maintain a mutable duplicate balance/status column.
- Add shared financial SQL helpers for collection rollups, then wire every existing money report intentionally. Do not globally redefine “cash sales” to silently include debt collections.
- Add the smallest separate permission needed for issuing credit (`pos.subscription_credit`, default off for cashiers) while leaving ordinary subscription sell/redeem permission unchanged; reuse the existing manager-override audit path when approval is needed.
- Mark `pos.subscription_credit` as implemented and manager-overridable in the canonical permission catalog, while keeping `default_cashier=0`; verify the existing override service returns and audits the approving manager ID.
- Treat a JoFotara tax-registration-profile change as invalidating receivable enablement. Disable new issuance atomically when the active profile changes; existing receivables must remain visible and collectible.
- Use server time, Amman business-date utilities, authenticated actor, and locked current shift as authorities.
- Use InnoDB transactions, deterministic lock order, `FOR UPDATE`, unique idempotency keys, database checks, and append-only audits.
- Do not add card-terminal integration, generic customer accounts, accounting exports, inventory features, or browser-printing work.

## Required plan quality

- Start with an evidence summary and an explicit state machine.
- Include exact schema fields, constraints, indexes, backfill behavior, migration verification, baseline/fixture parity, and rollback/feature-disable behavior.
- Divide work into small dependency-ordered phases with red/green/refactor steps and named files.
- For each task, state the failing test first, the minimal implementation, the focused test command, and the commit boundary.
- Include adversarial tests for date tampering, shift spoofing, duplicate submissions, concurrent collection, amount tampering, unauthorized credit issuance, collection on closed/wrong shift, reporting double-counts, JoFotara type codes, refunds, reversals, and admin visibility.
- Include real browser workflows for cashier paid-now, cashier pay-later, admin receivable issuance, redemption before payment, collection today against a future due date, overdue visibility, and mobile layouts.
- Include a report matrix proving whether each number belongs to sale date, due date, or collection date.
- Include a release gate: feature disabled until schema verification, focused/full tests, browser workflows, JoFotara receivable validation, receipt/spooler checks, and backup/restore rehearsal pass.
- Attack the completed plan: look for duplicated money math, ambiguous dates, status drift, bypasses, missing report consumers, legal invoice mismatches, upgrade/baseline drift, and refund paths. Amend the plan before declaring it ready.

End with a brutally honest risk rating and list any facts that require controlled authorized live JoFotara validation, direct ISTD confirmation, or accountant confirmation. JoFotara has no known public sandbox; do not imply that a configured test environment exists. Do not claim 100% safety from code review alone.
