# Platform Provider Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `executing-plans` and implement this plan task-by-task with mandatory TDD. Do not use subagents unless the user separately authorizes them. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status:** implemented, browser-verified, merged, and released to `master` on 2026-08-03. This document is retained as implementation evidence, not as pending work.
>
> **Scope boundary:** This phase records manual provider remittances, partial invoice allocations, typed statement adjustments, provider-statement metadata, settlement dates, receivable balances, reversals, and their reporting. It intentionally makes **no JoFotara change**: no eligibility, documents, QR, XML, credit notes, submission, retry, or operations-screen work.

**Goal:** Reconcile real provider statements and bank payouts against finalized platform invoices without changing sales, drawer, shift, stock, tax, receipt, kitchen, or JoFotara behavior.

**Architecture:** Keep platform sales/refunds as existing immutable facts. Add one deep `PlatformRemittanceService` module over an append-only remittance header, invoice-allocation lines, and typed adjustment lines; all writes, cents math, locks, idempotency, reversal, and report totals stay behind that interface.

**Tech stack:** Node.js/CommonJS, Express, Vue 3, MySQL/MariaDB InnoDB, Vitest/Supertest, existing `fetchJson`, audit events, business-date helpers, and automatic migration/repair chain. No new dependency.

## Global constraints

- JoFotara is completely deferred.
- Existing sales/refund/report keys and X/Z drawer math remain unchanged.
- All database changes are additive and wired through fixed migration, automatic chain, repeatable repair, fresh baseline, fixture, validator, and Hostinger fallback.
- Integer cents are used for every JavaScript calculation; database money remains `DECIMAL(10,2)`.
- No generic ledger, provider integration, per-order fee-import engine, attachment system, or new store/repository/controller layer.

## Goal

Make the existing `payment_method='platform'` sales financially reconcilable after they were closed from held orders. A restaurant administrator must be able to select the already-finalized invoices for one provider/order type (Talabat, Careem, etc.), allocate all or part of each open balance, record the provider's monthly bank-check/transfer plus typed deductions or additions, see what remains outstanding or becomes a provider credit after later refunds, and audit/reverse an incorrect record safely.

This is a settlement-reconciliation feature. It must not change how an order is sold, kitchen-fired, printed, refunded, or submitted to JoFotara.

## Evidence and architecture decision

The current platform implementation already has the right sales boundary:

- `backend/modules/checkout/executeCheckout.js` is the only sale writer. It closes eligible held orders as `orders.payment_method='platform'`, with zero cash/card/tender/change, and retains `order_type_id` as the provider identity.
- `backend/services/RefundService.js` locks the original order `FOR UPDATE` and forcibly records platform refunds as `refund_method='platform'`.
- `backend/services/financialSql.js` is the source of truth for net platform sales: `NET_PLATFORM` subtracts platform refunds. `financeMetrics`, daily reports, audit reports, shift reports, X/Z payloads, and order statistics already consume that sales dimension.
- X/Z expected-cash calculations intentionally exclude `platform_sales`; `src/admin/pages/Shifts.vue` already labels it “Platform Sales (Not collected)”. A later bank check is not cash in the closing cashier's drawer and must never enter a shift or its variance calculation.
- `subscription_collections` demonstrates the useful parts of a financial collection record (append-only rows, idempotency, reversals, audit history and date-based reporting), but it is subscription-specific and cash/card/shift-bound. It must **not** be reused as a generic platform ledger.
- Real payout statements do not contain only invoice totals and one commission number. [Uber Eats merchant statements](https://help.uber.com/en/merchants-and-restaurants/article/view-and-download-current-and-past-weekly-pay-statements?nodeId=2dd1e1e6-96a5-4ae5-8d0b-03915aea4956) separate order totals, fees, adjustments and net payout; [Stripe payout reconciliation](https://docs.stripe.com/reports/payout-reconciliation) likewise preserves gross, fee and net activity grouped into a payout. Therefore partial allocations and itemized statement adjustments are reconciliation facts, not speculative accounting features.
- The automatic migration chain, fresh baseline, test fixture, schema validator, installer payload, and Hostinger fallback are all schema authority. Adding a table in only one is unsafe.

Therefore the smallest durable design is:

1. Keep `order_types` as the provider identity; do **not** create a provider table or a generic tender framework.
2. Add an append-only, three-table platform remittance record: one header, signed invoice allocations, and typed statement adjustments.
3. Put all reads, locking, amount derivation, writing, reversals, and reporting totals in one new cohesive backend module: `PlatformRemittanceService.js`.
4. Add one admin-only page and one focused admin router. Do not add a new store, repository, controller layer, or a file per endpoint.

## Locked business and financial contract

1. **Sales and collection dates remain different facts.** A platform invoice is sales/tax/item revenue on its invoice date. A provider remittance is an external collection on the date the administrator records its arrival. A remittance never changes the sale, its tax, stock, invoice, shift, receipt, refund, or order-type revenue.
2. **The provider is the existing `order_type_id`.** All remittance lines for one record belong to one order type. The current `is_deferred_settlement` flag is used to create future platform holds; it is not required to reconcile historical platform invoices after a provider is deactivated. Historical rows remain visible even if the order type is later renamed or deactivated. Because existing `orders.order_type_id` has no foreign key and older installations may already contain a deleted order type, the new remittance header deliberately stores the numeric ID and name snapshot without adding an `order_types` FK that could make the migration fail. A missing historical name is displayed as `Provider #<id>`.
3. **No cash-drawer mutation.** Platform remittance records have no `shift_id`, cash amount, card amount, tendered amount, or change. They do not alter X/Z, `expected_cash`, `actual_cash`, variance, cashier totals, or `expenses`.
4. **Settlement date and recording time are separate facts.** `settled_on` is the date on the provider check/transfer, while immutable `created_at` records when the administrator entered it. The form defaults `settled_on` to the current Amman business date from `getBusinessDate(new Date())`, but an administrator may enter an earlier valid date for a statement received previously. Reject future dates and malformed values; audit both dates. Optional statement start/end dates describe statement coverage only and must be both absent or a valid pair with start <= end.
5. **Open balances are server-owned; allocations and statement facts are administrator intent.** Each receivable row includes an opaque `balance_token`, derived as SHA-256 over provider ID, invoice ID and current open cents. The browser posts selected `{ invoice_id, balance_token, allocation_amount }` rows, typed adjustments, and the actual bank `net_received`. The server owns the current balance and validates every requested allocation; the administrator owns how the external statement allocated that balance and what the bank actually paid. The browser never supplies invoice total, refund total, provider name, or a replacement open balance.
6. **Partial allocations are allowed and default to full balance.** The service derives `open_amount = platform invoice total - platform refunds - signed prior allocations`, using integer cents. For a positive open balance, require `0 < allocation <= open`; for a negative provider credit, require `open <= allocation < 0`. Zero allocations are omitted. The sum of signed invoice allocations must be positive, but an individual credit may be partially or fully applied. Any unapplied amount remains visible on that invoice.
7. **Post-settlement refunds are preserved as provider credit.** If a settled invoice is later refunded, its open amount becomes negative. It remains visible and may be partially or fully allocated against a later positive statement. A credit-only batch remains unrecordable because this bounded feature records a provider payout/reconciliation, not money paid from the restaurant to the provider.
8. **Typed statement adjustments explain the payout without changing sales.** Each adjustment has a positive amount, a direction (`deduction` or `addition`), a bounded category, and an optional note. Categories are `commission`, `service_fee`, `marketing_fee`, `penalty`, `withholding_tax`, `reimbursement`, `incentive`, `correction`, and `other`. Commission/service/marketing/penalty/withholding are deductions; reimbursement/incentive are additions; correction/other may use either direction but require a nonblank note. Adjustments are statement-level, do not alter invoices, tax, expenses, or drawers, and are not a generic ledger.
9. **The payout equation must close exactly.** `computed_net = invoice_allocations - deductions + additions`, then `unreconciled_difference = entered_net_received - computed_net`, all in cents. `net_received` is the administrator-entered check/transfer amount and must be `>= 0`; zero is allowed only for a legitimate fully offset statement with at least one allocation and one adjustment. Both UI and service reject anything other than exactly zero difference. Negative-net statements/provider payables are deferred rather than disguised as a restaurant payment.
10. **No destructive correction.** A settlement is never edited or deleted. Reversing it appends one mirror header with copied allocations and adjustments, a mandatory reason, and restores the prior invoice balances. A record may have at most one reversal; a reversal cannot itself be reversed.
11. **Idempotency and locking are mandatory.** A unique idempotency key protects network retries. The service locks selected `orders` in ascending `invoice_id` before reading refunds or prior allocations; this matches `RefundService`'s order-first lock. Idempotency compatibility is exact: same actor, provider, sorted invoice/allocation pairs, settlement/statement dates, normalized reference, adjustment rows, and entered net. A reused key with different intent is always a conflict.
12. **Reports disclose, rather than blend, provider money.** Daily and audit reports get a distinct “Platform Reconciliation” section, dated by `settled_on`, showing positive allocations, provider credits applied, deductions by category, additions by category, net received, settlement count and reversal count. Existing platform sales continue to be reported as sales, not as cash collected.
13. **No provider integration or JoFotara.** There is no API import, payment terminal, attachment/scanned check, automatic held order, browser receipt change, kitchen dispatch, JoFotara document, credit note, or generic account/receivable framework.

## Data model

Create three InnoDB tables in a new migration named `2026-08-03-platform-provider-reconciliation-v1`.

### `platform_remittances`

| Column | Meaning |
| --- | --- |
| `id BIGINT UNSIGNED AUTO_INCREMENT` | immutable remittance identity |
| `order_type_id INT NOT NULL` | existing provider identity |
| `provider_name_at_entry VARCHAR(100) NOT NULL` | historical display snapshot if the order type is renamed |
| `kind ENUM('settlement','reversal') NOT NULL` | append-only signed direction |
| `statement_start_date DATE NULL`, `statement_end_date DATE NULL` | optional provider statement coverage, not sale authority |
| `settled_on DATE NOT NULL` | validated provider check/transfer date; defaults to current Amman business date |
| `reference VARCHAR(120) NULL` | check / transfer / statement reference |
| `net_received DECIMAL(10,2) NOT NULL` | actual nonnegative check/transfer amount entered by the administrator and equation-validated by the service |
| `reverses_remittance_id BIGINT UNSIGNED NULL` | populated only by a reversal; unique |
| `reason VARCHAR(255) NULL` | mandatory only on reversal |
| `recorded_by INT NOT NULL` | admin/programmer who created the record |
| `idempotency_key VARCHAR(80) NOT NULL` | unique retry key |
| `created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP` | immutable audit timestamp |

Constraints and indexes:

- foreign keys to `users` and the same remittance table with restrictive deletes; deliberately no `order_types` FK for compatibility with potentially orphaned historical order rows;
- unique `idempotency_key` and unique `reverses_remittance_id`;
- `(order_type_id, settled_on, id)` and `(settled_on, kind, id)` indexes for provider and report views;
- add `idx_orders_platform_provider (payment_method, order_type_id, invoice_id)` to `orders`; the current indexes do not support the provider receivables scan without avoidable historical scanning;
- check that `net_received >= 0`;
- check that statement dates are both null or both present in ascending order;
- check the settlement/reversal shape: settlement has no reverse target; reversal has one and a nonblank reason.

### `platform_remittance_lines`

| Column | Meaning |
| --- | --- |
| `id BIGINT UNSIGNED AUTO_INCREMENT` | immutable line identity |
| `remittance_id BIGINT UNSIGNED NOT NULL` | header |
| `invoice_id INT NOT NULL` | finalized platform invoice |
| `allocated_amount DECIMAL(10,2) NOT NULL` | administrator-requested signed allocation, validated against the locked current balance |

Constraints and indexes:

- foreign keys to `platform_remittances` and `orders` with restrictive deletes;
- one invoice once per remittance (`UNIQUE(remittance_id, invoice_id)`);
- `(invoice_id, remittance_id)` index for live balance derivation;
- `allocated_amount <> 0` check.

### `platform_remittance_adjustments`

| Column | Meaning |
| --- | --- |
| `id BIGINT UNSIGNED AUTO_INCREMENT` | immutable adjustment identity |
| `remittance_id BIGINT UNSIGNED NOT NULL` | owning header |
| `direction ENUM('deduction','addition') NOT NULL` | whether the row reduces or increases payout |
| `category ENUM('commission','service_fee','marketing_fee','penalty','withholding_tax','reimbursement','incentive','correction','other') NOT NULL` | bounded statement classification |
| `amount DECIMAL(10,2) NOT NULL` | positive adjustment amount |
| `note VARCHAR(255) NULL` | mandatory for `correction` and `other`; optional explanation otherwise |

Constraints and indexes:

- foreign key to `platform_remittances` with restrictive delete;
- `(remittance_id, id)` index for deterministic detail/report reads;
- `amount > 0` check;
- direction/category check enforcing the fixed deduction/addition categories and requiring a trimmed note for `correction` or `other`.

A reversal copies the original allocation and adjustment rows exactly. Query-time sign comes from the header kind: settlement allocations reduce invoice balance, reversal allocations restore it; settlement adjustments affect reconciliation totals, reversal adjustments negate them. This gives a complete, append-only history without mutating financial evidence.

## Backend owner and API contract

Create `backend/services/PlatformRemittanceService.js`. This is the only new backend module.

It owns:

- cents-safe money normalization, allocation caps, adjustment classification, and exact payout-equation validation;
- provider summary, outstanding-invoice list, remittance list/detail and date-range totals;
- `recordPlatformRemittance(conn, input)` and `reversePlatformRemittance(conn, input)`;
- order-first locks, the balance formula, idempotent retry lookup, append-only inserts and audit values.

Every balance query must aggregate refunds and signed allocation lines separately before joining them to `orders`. Every report query must also pre-aggregate adjustments by remittance before combining them with allocations. Never join raw refund, allocation, and adjustment rows together, which would multiply money when a record has more than one child of each type. Provider cards define `gross_due` as the sum of positive open balances, `provider_credit` as the absolute sum of negative open balances, and `net_outstanding = gross_due - provider_credit`. Providers with zero net but non-zero due and credit remain actionable.

It reuses `getBusinessDate`, `normalizeCheckoutAttemptKey`, `appendAuditEvent`, and the existing platform-refund truth from `refunds`. It must not copy checkout, refund, receipt, stock, JoFotara, or report SQL into a route.

Create `backend/routes/admin/platformRemittances.js` and mount it from `backend/routes/admin.js`. The parent admin router already provides admin/programmer authorization, so no new permission is needed.

Register every static route before `GET /:id`; otherwise the literal `providers` or `receivables` path can be interpreted as an ID route.

Routes:

| Route | Purpose |
| --- | --- |
| `GET /api/admin/platform-remittances/providers` | historical provider list with gross due, provider credit, and net outstanding; includes providers with platform orders or prior remittances even if now inactive |
| `GET /api/admin/platform-remittances/receivables?order_type_id=` | current non-zero invoice balances for one provider, with invoice identity, sale date, net platform sale/refund contribution, current open amount and opaque per-row balance token |
| `GET /api/admin/platform-remittances?order_type_id=&start_date=&end_date=` | settlement history and range totals, filtered by settlement date |
| `GET /api/admin/platform-remittances/:id` | immutable header plus allocations, adjustments, equation totals and reversal relationship |
| `POST /api/admin/platform-remittances` | record validated partial/full allocations, typed adjustments and actual net payout |
| `POST /api/admin/platform-remittances/:id/reverse` | append one audited mirror reversal with mandatory reason and idempotency key |

The create body permits only:

- `order_type_id`;
- de-duplicated `invoice_allocations` containing `{ invoice_id, balance_token, allocation_amount }`, maximum 200;
- `adjustments` containing `{ direction, category, amount, note }`, maximum 50;
- `net_received`, `settled_on`, optional statement period/reference, and `idempotency_key`.

Explicitly reject client authority fields including `invoice_total`, `refund_total`, `open_amount`, `provider_name`, `kind`, `recorded_by`, `reverses_remittance_id`, and any precomputed aggregate/difference field. Parse allocation, adjustment and net values through one strict cents parser; reject scientific notation, more than two decimals, non-finite values, unknown object keys, duplicate invoice IDs, and overlong strings. Trim optional text and store `NULL` when blank. Adjustment categories/directions follow the locked matrix above.

### Write transaction contract

For a new settlement:

1. Normalize the complete intent and idempotency key. Canonically sort allocations by invoice ID and preserve adjustment input order. If the key already exists, load its header, allocations and adjustments and return it only when actor and every normalized intent field match exactly; otherwise return `409 PLATFORM_REMITTANCE_IDEMPOTENCY_CONFLICT`.
2. Begin a transaction. Normalize/deduplicate/sort invoice IDs and lock exactly those `orders` in ascending `invoice_id` (`FOR UPDATE`). Reject missing IDs, non-platform orders, or orders outside the requested provider. Only after the order locks, read the referenced `order_types` row and snapshot its name without making it a financial prerequisite; use `Provider #<id>` if a legacy installation already orphaned that ID. Do not require the type to remain active/deferred when historical platform invoices exist.
3. Recheck the idempotency key inside the transaction after serialization. This closes the concurrent-retry window: an identical attempt returns the committed record, while incompatible reuse returns `409`.
4. Under the order locks, read platform refunds and existing allocation lines/headers. Derive each current balance in integer cents; reject zero balances. Recompute each selected invoice's balance token and reject stale confirmation. Validate each signed requested allocation against the locked balance and preserve the unapplied remainder.
5. Validate adjustment rows and calculate signed invoice allocations, deductions, additions, computed net, entered net and unreconciled difference in cents. Require positive total signed invoice allocation, nonnegative entered net, and exact zero difference. A zero payout additionally requires at least one adjustment. Validate `settled_on` as a non-future date, defaulting only an omitted value to the current Amman business date.
6. Insert the header, allocation rows and adjustment rows, then append one `platform_remittance_recorded` audit event containing provider snapshot, dates, reference, entered/computed net, full allocation details, full adjustment details and zero difference.
7. Commit. If the unique idempotency constraint still wins an edge race involving disjoint order sets, roll back, load the winner, and apply the same exact compatibility check; never surface a raw duplicate-key error. Any other failure leaves no header, allocation, adjustment, or audit row.

For a reversal:

1. Resolve a completed reversal retry by exact actor, original ID and normalized reason. Then begin a transaction and lock the original settlement. It must be `kind='settlement'` with no existing reversal; load allocations by invoice ID and adjustments by ID.
2. Recheck the idempotency key inside the transaction. Require a trimmed nonblank bounded reason. Insert a `kind='reversal'` header with the original net, copied allocations and copied adjustments, the current server business date and a link to the original; do not make a cash entry. The reversal date is intentionally not backdatable.
3. Append `platform_remittance_reversed` audit data containing original ID, reason and full monetary snapshot; commit atomically.

An order refund and a new remittance both lock the same order first, so a refund occurring during reconciliation either appears in the derived balance or waits for the record to finish; neither can silently over-settle the same cents. A reversal does not need order locks because it releases an exact immutable allocation and its arithmetic commutes with later refunds; the original-header lock prevents duplicate reversals.

## Admin workflow

Create one self-contained page, `src/admin/pages/PlatformRemittances.vue`, then add it to:

- `src/admin/pageRegistry.js` as `platform-remittances`;
- `src/admin/components/Sidebar.vue` as **Platform Reconciliation / تسوية المنصات** in Management;
- `src/shared/i18n.js` with the English/Arabic labels introduced here.

Also harden the existing order-type delete owner in `backend/routes/admin/printers.js`: return a clean `409` when the type has any platform order or remittance history and instruct the administrator to deactivate it instead. This protects future provider identity without changing ordinary non-platform order-type behavior. Add the focused route/UI error test; do not build a provider-management subsystem.

The page has three compact sections, not a generic accounting dashboard:

1. **Provider cards:** existing platform order types with “Due from provider”, “Provider credit”, and “Net outstanding”. The current configuration state is informative only; an old provider is still selectable until its historical balance is zero.
2. **Record settlement:** selecting a provider loads current non-zero invoices. Rows show invoice, sale date, sale net after refunds, previous allocations, current balance, an editable allocation defaulted to full balance, and a one-click reset to full. Negative rows are explicitly labeled provider credit. Below the rows, a compact adjustment editor adds direction, category, amount and conditional note; it is not a spreadsheet or drag-and-drop ledger. The summary shows positive allocations, credits applied, signed invoice allocation, deductions, additions, computed payout, entered check/transfer amount and unreconciled difference. Confirmation remains disabled until the difference is exactly `0.00`, every allocation is within its displayed balance, required notes exist, and the signed invoice allocation is positive.
3. **Settlement history:** filter by provider and settlement date, inspect immutable statement details, and reverse a record through a reason-confirmation flow. There is no edit/delete button.

Client idempotency uses one `crypto.randomUUID()` generated when the confirmation opens and retains it across a retry of that exact action. Changing any intent field after a failed attempt creates a new key. Disable the submit/reverse button while pending and reload the provider summary, receivables and history after success.

## Reporting contract

Extend the current report owners; do not alter `financeMetrics`, `NET_PLATFORM`, checkout, refunds, or shifts.

- `PlatformRemittanceService.getRangeTotals()` supplies one shared object for a date range: signed `positive_allocations`, `provider_credits_applied`, `invoice_allocations`, `deductions`, `additions`, `net_received`, adjustment-category totals, `settlement_count`, and `reversal_count`. Settlements add and reversals subtract. Its date filter uses `platform_remittances.settled_on`, never order invoice time. The API and UI label monetary totals “net of reversals”.
- `backend/services/dailyReportBuilder.js` adds `platform_reconciliation` beside existing `payments` and `subscriptions`. Preserve the existing platform-sales payload key exactly as it is; change only its human label where necessary. Renaming a live report/queue contract provides no ownership benefit and risks stale queued payloads.
- `src/admin/pages/ReportsSummary.vue` adds a separate Platform Reconciliation card (invoice allocations, deductions, additions, net received, counts, and link to the new page). It labels the sales row “Platform Sales (not collected)” / Arabic equivalent so the generic payment heading cannot imply it entered the drawer.
- `backend/routes/admin/reports.js`, `backend/services/auditReportBuilder.js`, `src/admin/pages/dailyReportPayloads.js`, `backend/routes/print.js`, and `src/print/PrintReceiptApp.vue` carry and render the same dedicated reconciliation block in daily/audit spooler reports. The audit report displays the existing platform sales line separately from the new remittance block. Add only the new reconciliation numeric fields to print sanitization/allowlists; do not use a browser-only print alternative.
- X/Z, `backend/routes/auth.js`, `backend/routes/admin/shifts.js`, `src/admin/pages/Shifts.vue`, `src/components/pos/ShiftReportModal.vue`, and the shift printer reload path are intentionally unchanged. Their existing Platform Sales line remains sales-only and outside expected cash.

## Schema authority and deployment files

This work is incomplete unless all of these move together:

1. Add canonical `backend/migrations/2026-08-03-platform-provider-reconciliation.sql` with its normal checksum conflict/idempotency guard.
2. Add Hostinger-safe `backend/migrations/2026-08-03-platform-provider-reconciliation.auto.sql` (no routines, delimiters, destructive DDL, or client-specific SQL). Append it after the current repeatable reconciliation in `backend/migrations/auto-manifest.json`, requiring `2026-08-01-additive-schema-reconciliation-v1` and its exact ledger checksum. Compute its normalized SHA-256 after the final SQL text is stable.
3. Append the verbatim auto-SQL block to `deployment/database/hostinger-manual-migrations.sql` with the required BEGIN/END markers and ledger insert. Do not regenerate or rewrite historical blocks.
4. Add all three tables, indexes, checks and foreign keys to `deployment/database/baseline.sql`; update `deployment/database/manifest.json` baseline SHA-256; seed the new migration ledger row in `deployment/tools/bootstrap-database.js`.
5. Add all three tables to `backend/tests/fixtures/seed.js` creation and reverse-FK drop order, and seed the new migration ledger entry.
6. Advance `backend/services/schemaValidation.js` to this new migration/checksum and verify tables, columns, constraints, indexes and foreign keys. Extend `backend/tests/unit/schemaAuthority.test.js`, automatic-migration tests, and installer baseline tests so a forgotten authority surface fails before deployment.

Extend the existing `2026-08-01-additive-schema-reconciliation` normal, automatic, and Hostinger fallback forms with additive repair for all three tables, their columns/constraints/indexes/FKs, and `idx_orders_platform_provider`. This is required by the project's established installer/updater auto-repair contract: a copied or damaged restaurant database whose ledger says current must be repairable without destructive DDL. Keep the new fixed migration as the normal ordered upgrade and keep the three repeatable-repair forms byte-equivalent under their existing tests; do not create a second generic repair framework.

## TDD implementation sequence

### Task 1 — lock the financial model and schema authority

**Files:** create `backend/migrations/2026-08-03-platform-provider-reconciliation.sql` and `backend/migrations/2026-08-03-platform-provider-reconciliation.auto.sql`; modify `backend/migrations/auto-manifest.json`, `backend/migrations/2026-08-01-additive-schema-reconciliation.sql`, `backend/migrations/2026-08-01-additive-schema-reconciliation.auto.sql`, `deployment/database/hostinger-manual-migrations.sql`, `deployment/database/baseline.sql`, `deployment/database/manifest.json`, `deployment/tools/bootstrap-database.js`, `backend/services/schemaValidation.js`, `backend/tests/fixtures/seed.js`, `backend/tests/unit/schemaAuthority.test.js`, `backend/tests/unit/automaticMigrations.test.js`, `backend/tests/integration/automaticMigrations.test.js`, and `backend/tests/integration/installerBaseline.test.js`.

- [x] Write RED schema-authority tests for all three tables, `idx_orders_platform_provider`, every unique/index/FK/check contract, migration predecessor/hash, fallback verbatim block, baseline, and validator failure.
- [x] Run the focused schema tests and confirm they fail because the three tables/index are absent.
- [x] Add the fixed normal/automatic SQL, manifest entry, manual fallback block, baseline, fixture, bootstrap ledger, validator requirements, and additive repeatable repair in one coherent change.
- [x] Run migration tests proving first apply, idempotent retry, checksum conflict, fresh install, and repair of a deliberately removed adjustment table/index/constraint without deleting seeded business rows.
- [x] Commit only schema-authority files with `feat: add platform reconciliation schema`.

**Produces:** the three durable tables and index consumed by every later task. No later task may redefine their money/category semantics.

### Task 2 — build the deep read-and-calculation module

**Files:** create `backend/services/PlatformRemittanceService.js`; create `backend/tests/unit/platformRemittanceService.test.js`; add focused database-backed service tests.

**Interface produced:**

```js
listProviders(executor)
listReceivables(executor, orderTypeId)
listRemittances(executor, filters)
getRemittance(executor, remittanceId)
getRangeTotals(executor, { startDate, endDate })
recordPlatformRemittance(conn, input) // implemented in Task 3
reversePlatformRemittance(conn, input) // implemented in Task 3
```

- [x] Write RED tests for live balance derivation after partial/full refunds, partial/full prior allocations, negative provider credit, partial credit application, and reversal-sign arithmetic.
- [ ] Write RED tests for strict cents parsing, balance tokens, allocation bounds, category/direction matrix, required notes, and the exact equation:

```text
signed invoice allocations - deductions + additions = entered net received
```

- [x] Implement the smallest internal helpers and read queries inside this one module. Pre-aggregate refunds, allocations, and adjustments independently; expose no route-local SQL or test-only public internals.
- [x] Run the focused tests and use `EXPLAIN` on provider receivables/range totals to verify `idx_orders_platform_provider` and child-table indexes are usable without raw child-row multiplication.
- [x] Commit with `feat: add platform reconciliation calculations`.

**Consumes:** Task 1 schema. **Produces:** the only balance/equation/read interface used by routes, reports, and UI payloads.

### Task 3 — add transactional settlement and reversal writes

**Files:** modify `backend/services/PlatformRemittanceService.js`; extend its unit/integration tests.

- [x] Write RED transaction tests for partial positive allocation, partial credit allocation, multiple typed adjustments, zero payout fully offset by adjustments, mismatch by one cent, negative computed payout, over-allocation, wrong sign, stale token, duplicate/missing/cross-provider IDs, invalid dates, invalid category/direction/note, and rollback without partial child/audit rows.
- [x] Write RED idempotency/reversal tests for exact retry, incompatible reuse, concurrent identical retry, duplicate-key race recovery, copied allocations/adjustments, one reversal only, and reversal restoring the precise pre-settlement balances/totals.
- [x] Implement order-first locking, locked balance/token revalidation, cents-only equation validation, header/allocation/adjustment inserts, and transaction-bound `platform_remittance_recorded` / `platform_remittance_reversed` audit events.
- [x] Run a real concurrent refund/remittance test and a concurrent remittance/remittance test. Assert no over-allocation, no deadlock-dependent correctness, and one valid final balance.
- [x] Commit with `feat: record and reverse platform reconciliations`.

**Consumes:** Task 2 module interface. **Produces:** trusted immutable records; later tasks only translate or render these results.

### Task 4 — expose the thin admin route and provider-delete guard

**Files:** create `backend/routes/admin/platformRemittances.js`; modify `backend/routes/admin.js` and `backend/routes/admin/printers.js`; create/extend Supertest integration tests.

- [x] Write RED route tests for admin/programmer access, provider/receivable/list/detail responses, partial-allocation payload, adjustment limits, unknown-key rejection, clean public error codes, stale `409`, and exact retry response.
- [x] Mount static routes before `/:id` and implement only validation/HTTP translation around Task 2/3 interfaces. Do not add financial SQL or formulas to the route.
- [x] Add the narrow order-type delete `409` when platform order/remittance history exists; prove deactivation and unrelated type deletion remain available.
- [x] Emit an existing conventional admin refresh event only after commit if such a pattern already exists; otherwise skip realtime updates and refetch after success.
- [x] Run route/service integration tests and commit with `feat: expose platform reconciliation admin api`.

### Task 5 — add reconciliation facts to reports without touching drawer math

**Files:** `backend/services/dailyReportBuilder.js`, `backend/routes/admin/reports.js`, `backend/services/auditReportBuilder.js`, `src/admin/pages/dailyReportPayloads.js`, `backend/routes/print.js`, `src/print/PrintReceiptApp.vue`, `src/admin/pages/ReportsSummary.vue`, report tests.

- [x] Write RED fixtures where a sale is day A, partial allocation plus deductions/additions and payout are day B, refund is day C, and reversal is day D.
- [x] Add one `platform_reconciliation` object from `getRangeTotals()`. Preserve existing platform-sales keys and keep reconciliation outside `payments.total_collected`, expected cash, shift sections, X/Z, sales, tax, stock, and invoice counts.
- [x] Add spooler report allowlisting/rendering for allocations, credits, category totals, additions, deductions and net received. Test payload sanitization and rendered labels in both languages.
- [x] Add the `ReportsSummary.vue` reconciliation card/link using the same payload object; do not calculate a second frontend summary.
- [x] Run daily/audit/print/shift invariance tests and commit with `feat: report platform reconciliation payouts`.

### Task 6 — build the bounded admin page after the interface is stable

**Files:** create `src/admin/pages/PlatformRemittances.vue`; modify `src/admin/pageRegistry.js`, `src/admin/components/Sidebar.vue`, `src/shared/i18n.js`; add focused page/router tests.

- [x] Write RED tests for registration/localization, default-full allocation, partial positive/credit allocation, add/remove adjustment rows, category/direction rules, required note, entered payout, exact-zero difference, stale response, idempotent retry, and reason-required reversal.
- [x] Implement the one page with existing admin layout/dialog conventions and `fetchJson`. Do not create a store, composable, API wrapper, allocation engine, or adjustment-category administration page.
- [x] On stale `409`, preserve statement metadata/adjustments, refetch receivables, clear affected selections, explain the changed balance, and require explicit reselection plus a new idempotency key. Never silently clamp an allocation.
- [x] Verify mobile rows retain invoice, balance, allocation, adjustment and difference information without horizontal loss.
- [x] Run page tests and `npm run build:admin`; commit with `feat: add platform reconciliation admin workflow`.

### Task 7 — adversarial verification and bounded cleanup

- [x] Run every focused command below plus refund, platform-held settlement, shift, audit, print and schema-drift suites.
- [x] Inspect every `platform`, `platform_sales`, `payment_method`, `refund_method`, `expected_cash`, `cash_sales`, `card_sales`, `total_collected`, and `jofotara` conditional in changed owners; classify each as unchanged, naturally generic, or explicitly covered.
- [x] Run the browser workflow: two invoices, partial allocation, partial provider credit, commission deduction, reimbursement addition, one-cent mismatch rejection, successful zero-difference payout, retry, later refund, later credit application, reversal, and historical-date report separation.
- [x] Confirm customer receipt, kitchen, checkout, JoFotara, stock, sales/tax, X/Z, shifts, expected cash, actual cash and variance are byte/amount-equivalent to their pre-feature behavior.
- [x] Run `git diff --check`; remove debug output, duplicated formulas, source-string-only tests where behavior tests exist, unrelated formatting, and any new abstraction with only one pass-through caller.

Suggested focused commands (adjust only if a current test file moved):

```powershell
npx vitest run backend/tests/unit/automaticMigrations.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/integration/installerBaseline.test.js
npx vitest run backend/tests/unit/platformRemittanceService.test.js backend/tests/integration/platformRemittances.test.js backend/tests/integration/platformHeldSettlement.test.js backend/tests/integration/refunds.test.js
npx vitest run backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/auditReports.test.js backend/tests/integration/printShiftReport.test.js backend/tests/unit/dailyReportPrintContract.test.js
npx vitest run src/admin/pages/__tests__/platformRemittancesPage.spec.js src/admin/pages/__tests__/dailyReportsNavigation.spec.js src/admin/pages/__tests__/dailyReportsLocalization.spec.js
npm run build:admin
node scripts/validate-schema-drift.js
```

## Adversarial plan review

| Attack | Required defense |
| --- | --- |
| Admin requests a partial allocation beyond the current balance or with the wrong sign | Service compares requested cents to the locked open balance and rejects it; the browser never overwrites the server balance. |
| Entered bank payout does not equal allocations minus deductions plus additions | Both UI and service calculate the difference in cents; the transaction is blocked unless it is exactly zero. |
| Admin disguises an unknown difference as an adjustment | Only bounded categories are accepted; `correction` and `other` require a durable explanation captured in detail and audit history. |
| A refund lands after the confirmation screen but before POST | Locked balances produce a different selection token; POST returns a stale-balance `409` and requires explicit reselection instead of recording a different check amount. |
| Provider is disabled after historical sales but still owes money | Provider query includes historical platform orders/remittances; reconciliation is allowed despite current flag state. |
| An older database already has orders pointing at a deleted order type | Migration does not add an unsafe provider FK; the service exposes `Provider #<id>`, snapshots it, and can still reconcile the history. Future platform-linked types return a clean delete `409`. |
| Two browser retries record the same monthly check | Unique idempotency key returns the single immutable record. |
| Two simultaneous requests use the same key before either commits | The in-transaction recheck handles serialized attempts; the unique-key fallback loads and compatibility-checks the winner for disjoint selections. |
| Two admins settle the same invoice or a refund races settlement | Both lock the order first; current balance is recalculated while locked; one transaction waits/rejects instead of over-settling. |
| An invoice/remittance has multiple refunds, allocations and adjustments | Each child set is pre-aggregated independently, preventing a raw-join multiplication bug. |
| A settled order is refunded later | Sales/refund facts stay untouched; the invoice becomes a visible provider credit, not a negative cash/refund entry. |
| A statement has commission, marketing fee and reimbursement together | Each is an immutable typed adjustment; direction/category rules and the payout equation keep it out of sales, tax, expenses and drawer math. |
| Provider pays only part of an invoice | The requested partial allocation reduces only that many cents; the remainder stays visible and can be reconciled later. |
| Someone discovers a typo after saving | Reversal with mandatory reason is the only correction; no edit/delete can erase evidence. |
| New remittance is accidentally counted in cashier X/Z | No shift link or X/Z payload change exists; integration tests pin cash/variance invariance. |
| Daily report mixes sale-day revenue and payment-day bank money | It renders two separately dated blocks and tests a three-day sale/remit/refund timeline. |
| The new feature quietly reactivates JoFotara work | No JoFotara production file is in scope; final search and tests prove no document/job/XML behavior was changed. |
| One deployment surface gets forgotten | Schema authority tests require migration, manifest hash, fallback block, baseline, bootstrap ledger, fixture and validation parity. |
| A copied/upgraded database says current but loses a new table/index | The existing additive repeatable repair recreates the missing object without deleting or rebuilding business data. |

## Explicitly deferred

- JoFotara documents, eligibility, QR, XML, submission, credit notes, tax mapping, retries and operations UI for platform orders or remittances.
- Provider API credentials, automatic statement import, automatic held-order creation, remittance webhooks and background sync.
- Generic payment/tender management, cash/card terminal integration, a GL/accounting/expense framework, multi-currency, provider-level negative payable/rollover statements, or reusable allocation-builder framework.
- Per-order adjustment attribution, provider-defined custom categories, automatic commission calculation, statement CSV import, and arbitrary adjustment categories. This phase records bounded statement-level facts manually.
- Scanned checks/statement file attachments and printing a remittance receipt.
- Revenue-center scoping and installer/updater work unrelated to adding this normal migration chain.

## Completion definition

The phase is complete when an administrator can partially or fully allocate finalized platform invoices, apply typed deductions/additions, match the entered check/transfer amount to an exact zero-difference equation, reverse the complete immutable statement, preserve unapplied balances and later refund credits, distinguish sale dates from payout dates, and prove platform payouts never affect sales/tax/stock, cash drawers, shifts, X/Z, receipts, kitchen, or JoFotara. Damaged additive schema must remain repairable through the established updater path. The implementation should consist of exactly one new service, one new admin route, one new admin page, three database tables, one supporting order index, one narrow existing order-type delete guard, and necessary existing-report/schema-authority extensions—nothing broader.
