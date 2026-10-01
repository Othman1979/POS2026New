# Sales and subscriptions schema consolidation audit

Date: 2026-09-12. Source: `codex/schema-consolidation-audit` at `af382ebe86f5ba3f904fb95c0c315f8753b212b3`.

## Verdict

There are further consolidation opportunities. I would pursue **three bounded changes removing four tables**, with an eventual fresh-schema count of **75 → 71**. These are design recommendations supported by the current schema and callers, not tested migrations or reproduced production defects.

| Priority | Change | Tables removed | Main benefit | Main cost |
|---|---|---:|---|---|
| 1 | Platform allocation and adjustment rows → one typed settlement-entry table | 1 | One child-row storage/read path under the existing settlement owner | Preserve allocation identity, signed amounts and adjustment-specific validation |
| 2 | Subscription plan metadata → its existing sale product | 1 | Remove a one-to-one companion row, duplicated active-state writes and plan-existence lookups | Catalog/query changes and explicit migration of plan identities |
| 3 | Invoice, shared daily and per-type daily counters → one scoped counter table | 2 | One counter storage convention and common reservation primitive | Checkout concurrency and frozen per-day prefix assignments must remain intact |

The resulting groups would be **22 → 19** for sales/floor/shifts/documents/platform, and **8 → 7** for subscriptions. The other 45 tables are outside this audit. No tables were removed by this audit.

Two additional candidates, QR drafts and Y-report archives, could remove another two tables (**71 → 69**), but their operational tradeoffs are less convincing. I would keep them deferred. I do not recommend a single generic table for every financial or subscription event.

## What was verified

- Recounted all `CREATE TABLE` declarations in the current canonical baseline: **75 distinct tables**. The requested groups contain exactly **30 distinct tables**. The earlier 80-table baseline is superseded by the completed stock consolidations.
- Inspected target definitions, foreign keys, unique keys, checks, and relevant later `ALTER TABLE` statements, including saved stock/recipe fields on sale and redemption lines.
- Followed current read/write paths through checkout numbering, subscription purchase/collection/redemption/extension, settlement recording/reversal, drawer expectations, refunds, table drafts, X/Z issuance, Y archive/restore, and JoFotara submission state.
- Read relevant existing regression tests as evidence of intended contracts. **No test suite, migration, EXE, live database, or Hostinger workload was executed for this audit.** No current row counts, query timings, or measured performance savings are claimed.
- Generated a source-reference inventory at [sales-subscriptions-schema-inventory.json](C:/xampp/htdocs/posapp/scratch/sales-subscriptions-schema-inventory.json). Its file counts are lexical reference counts, not execution counts or proof that every branch runs.

Baseline SHA-256: `878f7cbd33ca181eab25570615b28e1e6e9b50ee072f5c2d35ee55ebd3871984`.

## 1. Consolidate platform settlement children: three tables become two

The header is a real separate entity: a provider statement/payout has dates, a reference, an idempotency key, an actor, a net amount and a possible reversal. It owns multiple invoice allocations and multiple statement adjustments. Keeping that header avoids repeating its identity on every line.

The two child tables are a reasonable place to use a type. Both are monetary entries owned by the same settlement and handled by the same service. Recording and reversal currently each contain separate insert loops; report loading separately fetches both child collections. See [recording](C:/xampp/htdocs/posapp/backend/services/PlatformRemittanceService.js:463), [reversal](C:/xampp/htdocs/posapp/backend/services/PlatformRemittanceService.js:561), and [report child reads](C:/xampp/htdocs/posapp/backend/services/PlatformRemittanceService.js:775).

**Proposed direction:** retain `platform_remittances`; replace `platform_remittance_lines` and `platform_remittance_adjustments` with `platform_remittance_entries`, explicitly typed as allocation or adjustment. Preserve the public response's allocation/adjustment grouping if useful to the UI; one storage table does not require a UI redesign.

Required properties:

- Allocations require an invoice FK, a nonzero signed amount, and uniqueness for `(remittance_id, invoice_id)`.
- Adjustments have no invoice reference, retain direction/category/note rules, and use positive amounts. Multiple adjustments per settlement remain valid. A nullable invoice component permits those rows alongside a unique allocation key; MySQL documents that unique indexes allow multiple NULLs. This still needs explicit row-shape checks and validation on the actual deployment engine. [MySQL unique-index semantics](https://dev.mysql.com/doc/refman/8.0/en/create-index.html).
- Preserve the equation `net = signed allocations - deductions + additions`, including a fully explained zero payout. It is enforced in [validateEquation](C:/xampp/htdocs/posapp/backend/services/PlatformRemittanceService.js:390).
- A reversal copies the original allocation signs; the reversal header changes the reporting sign. It must not negate the copied amount and then negate it again during aggregation.
- Preserve order-first locking, provider matching, balance tokens, and retry/reversal uniqueness. Keep provider payouts separate from sales recognition and drawer cash.

**Payoff:** one fewer table and an opportunity to combine the two child SELECTs in report loading. Per-invoice receivable queries will still filter allocation entries and need an appropriate invoice index. This is not proof of faster checkout; settlements are not the checkout counter path.

## 2. Absorb subscription plan metadata into products: eight become seven

Every row in `subscription_plans` already has exactly one sale product, enforced by a required product FK and `UNIQUE(sale_product_id)`. The plan table adds credits, duration, active state and ownership/timestamps. Plan creation inserts a product and then a plan; editing updates both active flags in the same transaction. [Plan definition](C:/xampp/htdocs/posapp/deployment/database/baseline.sql:827), [creation](C:/xampp/htdocs/posapp/backend/routes/admin/subscriptions.js:180), [editing](C:/xampp/htdocs/posapp/backend/routes/admin/subscriptions.js:237).

**Proposed direction:** store the plan-specific metadata on its product, with an explicit subscription-product distinction. Keep eligibility relationships and purchased customer entitlements separate. This removes a companion row and makes checks such as “is this a plan product?” local to the product. Today those checks also appear throughout the ordinary product routes: [catalog exclusion](C:/xampp/htdocs/posapp/backend/routes/admin/products.js:446) and [edit protection](C:/xampp/htdocs/posapp/backend/routes/admin/products.js:600).

This is optional denormalization with a concrete code simplification, not evidence that the existing one-to-one design is inherently wrong. The cost is additional nullable product metadata and changes across subscription/catalog consumers. Plan-specific metadata and management restrictions must remain explicit; ordinary inventory editing must not acquire permission to alter plans.

The migration must map **old plan ID → sale product ID**. They are different identities and integer widths today. Update dependent FKs and caller contracts deliberately, preserving identifiers still needed by existing clients/history. Do not assume matching numbers, silently rewrite purchased terms, or add a permanent mapping table that cancels the intended saving. Resolve ID compatibility before choosing final columns.

Existing tests establish coupled product/plan editing and protection from normal product editing: [subscriptionPlans tests](C:/xampp/htdocs/posapp/backend/tests/integration/subscriptionPlans.test.js:87). They do not prove a future consolidated schema is correct.

### Why the other seven subscription tables have distinct jobs

| Table after this proposed cut | Meaning of one row | Why it remains |
|---|---|---|
| `subscription_plan_products` | One meal allowed by the current plan | Editable catalog eligibility; many meals per plan |
| `customer_subscriptions` | One customer's purchased or manually granted entitlement | Dates, purchased credits, status, customer and purchase linkage |
| `customer_subscription_products` | One meal allowed for an existing entitlement | Frozen eligibility copied when that entitlement is created |
| `subscription_collections` | One installment collection or its reversal | Real cash/card movement on a particular shift and business day |
| `subscription_extensions` | One extension from an old end date to a new one | Multiple extensions and their reasons/actors are displayed as history |
| `subscription_redemptions` | One meal-redemption operation | Shared retry identity, business day, status and reversal for its lines |
| `subscription_redemption_items` | One product line in that redemption | Quantities, modifiers/bundles and saved stock/recipe ownership |

The two eligibility lists are **not duplicate authorities**. Purchase copies the current plan list into the customer's list; later redemption reads the customer's list. Replacing it with a join to the current plan would change previously purchased eligibility when an administrator edits a plan. [Purchase copy](C:/xampp/htdocs/posapp/backend/services/SubscriptionService.js:395), [manual-entitlement copy](C:/xampp/htdocs/posapp/backend/routes/admin/subscriptions.js:426), [redemption eligibility](C:/xampp/htdocs/posapp/backend/routes/pos/subscriptions.js:714).

They could physically share a typed relationship table while preserving both ownership scopes. That saves one more table but introduces conditional owner columns, uniqueness rules and two ownership FKs; the copy operation remains. **Possible, but weak payoff; not included in the recommended target.** A generic `owner_type/owner_id` pair without enforceable owner relationships would be a regression.

Collections cannot become fields on the purchase invoice or subscription: a receivable can have several installments, across different shifts, plus individual reversals. Their cash contribution is separately included in drawer expectations. [Collection schema](C:/xampp/htdocs/posapp/deployment/database/baseline.sql:882), [drawer calculation](C:/xampp/htdocs/posapp/backend/services/expenseService.js:47), [installment/reversal regression cases](C:/xampp/htdocs/posapp/backend/tests/integration/subscriptionCollections.test.js:324).

Extensions are written alongside the end-date change and separately read for the detail screen. Replacing them with “latest extension” columns would lose earlier entries. Reusing general audit events is not equivalent because those writes can be suppressed by the existing audit policy. [Extension transaction](C:/xampp/htdocs/posapp/backend/routes/admin/subscriptions.js:602), [detail history](C:/xampp/htdocs/posapp/backend/routes/admin/subscriptions.js:309), [audit policy](C:/xampp/htdocs/posapp/backend/services/auditEvents.js:123).

Redemption headers and items are a real one-to-many operation. The reversal uses saved item stock/recipe data and produces kitchen void jobs before committing the header status. Moving these into sales would require every sales/tax/report query to distinguish zero-revenue entitlement consumption. A generic subscription event table combining collections, extensions and redemptions would likewise combine money, date changes and stock operations with different validation and reversal models. [Redemption reversal](C:/xampp/htdocs/posapp/backend/routes/admin/subscriptions.js:758).

## 3. Consolidate the three sequence tables, preserving their scopes

`invoice_sequences`, `daily_sequences` and `daily_order_type_sequences` all store increasing counters. A single scoped counter table can represent global invoice numbering, shared numbering for a business day, and numbering for each order type on that day. **Three → one saves two tables.**

Current writers are concentrated in [invoiceSequence.js](C:/xampp/htdocs/posapp/backend/utils/invoiceSequence.js:4) and [orderSequence.js](C:/xampp/htdocs/posapp/backend/utils/orderSequence.js:7). This is a credible storage abstraction, but the per-type table also owns the frozen prefix assignment; it is not just `(key, value)` data that can be discarded.

Preserve these behaviors:

- Distinct counter keys/rows for global, daily shared and daily per-type scopes. A shared table must not become one global lock for unrelated counters.
- The current daily coordination row used when assigning missing type prefixes; it already serializes that operation. Do not silently remove its role or claim that existing per-type allocations are lock-independent.
- Prefix uniqueness within a business date, old prefix assignments when order types are added/reordered/deactivated, the no-type case, and exact stored order scopes.
- Atomic reservation inside the caller's transaction, retry behavior, and business-day partitioning. Current allocators use `LAST_INSERT_ID` on the same connection.
- Existing printed identities and old counter values. Do not reseed from current row counts or renumber existing orders as part of this migration.

InnoDB lock scope depends on the keys/searches involved, so sharing a physical table does not by itself require serializing every counter. Preserve indexed scoped access and verify actual contention. [MySQL locking behavior](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking.html).

**Important boundary:** X/Z report serials currently use a named lock and `MAX(serial_no)` in `audit_report_documents`, not these three counter tables. Including report serials would be additional behavioral scope, not a free part of this consolidation. [Report serial allocation](C:/xampp/htdocs/posapp/backend/routes/admin/auditReports.js:308).

This cut has a clear table-count benefit but **no established latency benefit**. The initial reservation still needs a database operation. Since this touches newly verified numbering and local invoice-support compatibility, prioritize it after the more contained settlement change.

## 4. Two further cuts to defer

### QR drafts into restaurant tables: one table saved, possible contention cost

`qr_table_drafts` is a genuine one-to-one extension: table ID, cart JSON and its update timestamp. Absorbing nullable draft fields into `restaurant_tables` is technically straightforward and removes joins used for draft badges. [Definition](C:/xampp/htdocs/posapp/deployment/database/baseline.sql:820), [floor reads](C:/xampp/htdocs/posapp/backend/services/TableRealtime.js:26).

However, guest cart updates currently write the separate draft row through Socket.IO. Folding them into the floor-table row would share a write target with seating/join/checkout operations. That is a **contention risk inferred from the source**, not a reproduced defect. Preserve a dedicated draft timestamp, empty/absent behavior and stale-draft cleanup; keep cart JSON out of ordinary floor broadcasts. [Guest writes](C:/xampp/htdocs/posapp/server.js:281), [cleanup](C:/xampp/htdocs/posapp/server.js:588).

Decision: retain until concurrent guest autosave plus cashier table operations demonstrates that removing the join is worth sharing the row.

### Y archives into report documents: one table saved, different retention rules

`audit_report_documents` already combines X and Z using a type. `master_held` stores a Y report plus a complete recoverable snapshot of held orders. Both could live in one typed report-document store, keeping Y-specific recovery fields optional.

But X/Z issuance has serial uniqueness, hashes, reprint state and a Z business-day restriction. Y archives have an expiry and a one-time restore lifecycle. Y generation locks held rows, rejects active claims, stores their recovery data, removes the live holds and queues printing in the transaction. Restore reinserts original held identities with fresh claim/version state. [Y generation](C:/xampp/htdocs/posapp/backend/routes/admin/auditReports.js:476), [restore](C:/xampp/htdocs/posapp/backend/routes/admin/auditReports.js:634).

Any common table must ensure that Y expiry cleanup never deletes X/Z documents and that restoring a Y archive remains atomic and exclusive. Service-charge snapshot cleanup also reads active Y recovery payloads. [Archive cleanup](C:/xampp/htdocs/posapp/backend/services/yHeldItemsReportBuilder.js:304).

Decision: possible storage consolidation, modest code reuse. Keep deferred; do not simply fold recovery archives into live `held_orders` or assume all report types share their issuance/retention rules.

## 5. Disposition of all 22 sales/floor/shifts/documents/platform tables

The subscription table-by-table disposition is above. This completes the other 22; schema anchors refer to the current baseline, while runtime evidence supports the relevant conclusions elsewhere in this report.

| Table | Decision | Reason |
|---|---|---|
| `service_charge_snapshots` | Keep | Versioned ownership across draft, held, claimed, split and finalized states; not merely a copy of order tax fields |
| `audit_report_documents` | Keep; optional Y absorption | Already typed X/Z issued documents with serial/reprint rules |
| `sections` | Keep | One section owns multiple tables and participates in staff section access; embedding names loses independent identity and empty sections |
| `restaurant_tables` | Keep | Floor state, QR identity, joins and current-order pointer are distinct from sale history |
| `shifts` | Keep | Cash session identity and opening/closing counts own many orders, expenses and collections |
| `expense_categories` | Keep | Editable, independently active expense classification; not a sale category tree |
| `expenses` | Keep | Individual drawer/outside expenses and cancellation state; a shift total cannot replace the entries |
| `customers` | Keep | Shared customer identity across repeat orders and subscriptions; invoice buyer snapshots serve a different historical purpose |
| `orders` | Keep | Sale/open-table order header with its own identity and money state |
| `order_items` | Keep | Many sale lines, bundle relationships and frozen price/tax/stock facts per order |
| `refunds` | Keep | Multiple refund/void operations may relate to one order, with their own time, amount and shift |
| `refund_items` | Keep | Partial quantities and money per refund operation, linked back to original sale lines |
| `jofotara_documents` | Keep | Already typed invoices/credit notes; independent submission/retry state and saved payload per source document |
| `held_orders` | Keep | Editable cart, kitchen dispatch, claim lease, version and retry state differ from finalized invoices |
| `master_held` | Defer consolidation | Recoverable, expiring Y archive; possible absorption into report documents with explicit lifecycle isolation |
| `invoice_sequences` | Consolidate | Global invoice scope in a common counter store |
| `daily_sequences` | Consolidate | Shared daily scope and existing daily coordination role in that store |
| `daily_order_type_sequences` | Consolidate | Per-type/day counter plus stable prefix mapping in that store |
| `qr_table_drafts` | Defer consolidation | One-to-one candidate, but isolates guest writes from floor state |
| `platform_remittances` | Keep | Payout/statement header and reversal identity |
| `platform_remittance_lines` | Consolidate | Allocation entry kind under the same payout |
| `platform_remittance_adjustments` | Consolidate | Adjustment entry kind under the same payout |

### Larger mergers considered and rejected for this pass

**Orders/refunds and their lines into generic documents/lines:** technically possible, and could remove two tables, but it is a sales-ledger redesign. Current refund calculations sum prior quantities and amounts separately to prevent over-refunding, while a new refund owns a separate shift/time and stock reversal. The original item also carries facts that refund lines reference. Making all of this one document family requires new self-relations, kind-qualified constraints and changes to sales/report/JoFotara readers. It does not eliminate the two business operations. [Prior refund accounting](C:/xampp/htdocs/posapp/backend/services/RefundService.js:199), [refund writes](C:/xampp/htdocs/posapp/backend/services/RefundService.js:360).

**Held orders into orders:** possible only with a broader draft/sale lifecycle refactor. Today holds have claim expiry and operation retries, JSON carts and kitchen snapshots, while persisted sale lines own stock/tax/refund relationships. Every paid-order scan and identity transition would need review. One saved table does not justify that rewrite for this request.

**JoFotara documents into orders or report documents:** a single order can own its original invoice submission and multiple credit-note documents. Submission can be pending, in flight, accepted, rejected or uncertain independently of the sale. A single set of order columns cannot represent that cardinality. Sharing with X/Z/Y report storage would add unrelated credential/submission/expiry rules to one owner. [Credit-note creation and retry state](C:/xampp/htdocs/posapp/backend/services/JofotaraService.js:537).

**Service-charge snapshots into orders/holds:** snapshots exist before either holder, move between states with version/ownership checks, and participate in splits and recovery. Removing the table requires replacing that authority mechanism, not just moving percentage columns. [Transition and ownership checks](C:/xampp/htdocs/posapp/backend/services/ServiceChargeSnapshotService.js:126).

**Expense categories into sale categories using a type:** possible, but the current sale category model includes hierarchy, note groups and price-list roots, while expense categories have their own ordering and lifecycle. Catalog, menu and printer/report consumers would acquire exclusions to avoid leaking expense categories. The current small lookup avoids that coupling. [Category shapes](C:/xampp/htdocs/posapp/deployment/database/baseline.sql:192), [expense category shape](C:/xampp/htdocs/posapp/deployment/database/baseline.sql:307), [sale-category reader](C:/xampp/htdocs/posapp/backend/services/categoryItemsReportBuilder.js:55).

## 6. Verification needed before implementing any selected cut

These are acceptance boundaries for a future change, not claims of tests run today.

| Candidate | Focused evidence required |
|---|---|
| Platform entries | Existing platform service/transaction/report tests; mixed positive/negative allocations; additions/deductions; explained zero payouts; partial and concurrent allocation; exact replay; reversal once; unchanged sales, drawer, tax and receivable totals |
| Plan metadata | Existing subscription plan/purchase/management/redemption/collection tests; deliberately different plan/product IDs; edit plan after customers purchased and verify their credits/dates/eligibility; ordinary product edit guards; hidden plan products; cash/card/receivable purchase; price/active-state preservation |
| Scoped counters | Shared and per-type checkout/hold/split workflows; multi-connection reservation and rollback; retry after uncertain response; business midnight; new/deactivated types; setting toggles; preserved old printed references/prefix assignments; local invoice-support compatibility |
| Optional QR merge | Simultaneous guest drafts, seating, table joining and checkout; p95 lock/request latency comparison; empty/stale drafts and badges; no cart JSON in unrelated floor responses |
| Optional Y merge | Existing X/Z and Y tests; expiry, restore conflict, double restore, active claim rejection, service-charge cleanup and spooler payload preservation; prove Y cleanup cannot affect X/Z |

For an approved schema change, use the maintained [migration workflow](C:/xampp/htdocs/posapp/docs/agents/database-migrations.md) and [isolated verification commands](C:/xampp/htdocs/posapp/docs/agents/verification.md). Verify both fresh installation and upgrade with representative existing rows, totals/identity comparisons and restore/re-upgrade recovery. Keep migration/validation/reset code and the local invoice-support schema reader aligned; do not ship a compatibility table or view indefinitely just to report a lower count.

The performance test must compare the same workload and indexes before and after. Potential savings here are narrower queries, fewer coupled writes and simpler ownership. This source audit establishes no customer-visible speedup from reducing 75 to 71 tables.

Only this report and its ignored source inventory were written. Production source, SQL migrations, database contents, EXE and deployment artifacts were left unchanged.
