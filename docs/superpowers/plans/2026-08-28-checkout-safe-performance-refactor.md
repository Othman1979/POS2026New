# Checkout Safe Performance Refactor Implementation Plan

> **Execution contract:** Implement this plan task by task on the ordinary branch `codex/checkout-safe-performance-refactor`. Use RED/GREEN tests and commit each task separately. Do not create a worktree, schema migration, deployment, release bump, framework migration, cache, queue, worker thread, or new service process. If a measured command budget or invariant differs from this document, stop and explain the exact difference before changing the design.

**Goal:** Cut the database round trips and transaction work of the existing checkout path without weakening server-authoritative pricing, priced-note handling, bundle validation, stock locking, subscription intent, table settlement, idempotency, invoice sequencing, fiscal recovery, or audit atomicity.

**Selected architecture:** Keep Express and the existing deep `executeCheckout()` transaction. Consume counter values already present in the successful DML result, remove repeated reads by enriching the one non-locking product-admission query, keep the later stock-deduction `FOR UPDATE` read separate and unexpanded, batch rows that do not need generated parent IDs, delete one proven duplicate table-settlement comparison, and give the post-commit JoFotara preparation a single-read no-transaction path when no fiscal document is required. No cross-request business-data cache is introduced.

**Tech stack:** Node.js 22, Express 5, mysql2 3, MariaDB/MySQL InnoDB, Vitest 4, and the existing services. No dependency, environment-variable, API-response, schema, or migration change.

## Current-source fixed point

This plan was written from clean branch `codex/checkout-safe-performance-refactor` at `f575055e`, after the completed spooler branch was fast-forwarded into local `master`, focused verification passed, and the old spooler feature branch was removed. The executor must re-read the named files on the actual starting commit. Do not reset to this hash and do not treat line numbers as authority if later commits move them.

Verified current facts:

- `backend/routes/pos/checkout.js` is a thin HTTP controller. It calls the one deep `executeCheckout()` operation, then separately calls `prepareCheckoutInvoiceIfAutomatic()` after the payment transaction commits.
- `backend/modules/checkout/executeCheckout.js` is 2,144 lines. Its size is not itself the performance problem. Arbitrarily splitting it would create parameter-heavy shallow modules while preserving the same database commands.
- A normal fresh cash sale performs four overlapping admission reads: base/note products, subscription-plan ownership, register price context, and bundle-parent identity.
- `deductStockForCart()` deliberately performs a later `fetchCartProducts(..., { lock: true, includeNoteProducts: false })` and then the stock update. That existing query already reads direct category and bundle-availability context; this plan does not redesign it. It must remain separate and must not gain the new price-list, price-override, subscription-plan, or bundle-definition joins.
- `loadCheckoutSettings()` reads ten settings, then checkout separately reads `shared_order_sequence` later in the same transaction.
- `reserveDailyOrderId()` and `reserveInvoiceNumber()` each set the reserved value with `LAST_INSERT_ID(expr)` and then issue `SELECT LAST_INSERT_ID()`. The successful DML statement's OK packet already carries that same connection-local value as mysql2 `ResultSetHeader.insertId`.
- `reconcileSavedTableSettlement()` already locks and authenticates the saved table order and validates submitted parent identities and aggregate quantities. `executeCheckout()` then rebuilds and compares the same maps again before using the saved rows for frozen-price resolution.
- Every ordinary parent order item is inserted with a separate statement. A ten-line order therefore adds nine database commands over a one-line order.
- Bundle parents require their generated `order_items.id` to bind child rows and cannot be included in a parent batch. Ordinary parents and bundle children do not have that requirement.
- With JoFotara disabled, `prepareCheckoutInvoiceIfAutomatic()` still opens a second transaction, reads the order, reads 15 settings, locks the nonexistent document row, commits, and returns `not_required`.
- The JoFotara recovery worker scans finalized invoices with no document after the configured cutoff. A process restart or an enablement race therefore remains recoverable; the checkout fast path must not use a process cache.
- Current database-runtime work distinguishes connection health and command disconnects, but does not correlate per-route query counts. This plan uses a focused real-MySQL performance contract instead of adding always-on `AsyncLocalStorage`, per-query production timing, or log volume.

## Measured baseline

A temporary focused Vitest probe was run against the repository's real `posapp_test` MariaDB schema and then deleted. It wrapped every connection used by one HTTP checkout, counted `query`, `beginTransaction`, `commit`, and `rollback`, and printed normalized SQL without parameter values.

### One ordinary product, cash, stock off, JoFotara off

```text
Main checkout transaction:       18 query calls + BEGIN + COMMIT = 20 commands
Post-commit JoFotara preparation: 3 query calls + BEGIN + COMMIT =  5 commands
Total:                                                      25 commands
```

The 18 main queries included:

1. idempotency lookup;
2. shift lock;
3. checkout settings;
4. product/note-product admission;
5. subscription-plan ownership;
6. register price context;
7. bundle-parent identity;
8. standalone `shared_order_sequence`;
9-10. daily order sequence update/read;
11. order insert;
12. one parent item insert;
13-16. paid invoice number lock/sequence/read/update;
17-18. final order/items reconstruction.

### Ten ordinary product lines, same conditions

```text
Main checkout transaction:       27 query calls + BEGIN + COMMIT = 29 commands
Post-commit JoFotara preparation: 3 query calls + BEGIN + COMMIT =  5 commands
Total:                                                      34 commands
```

Exactly nine additional commands were the additional nine single-row `order_items` inserts.

### Proposed joined admission query

The proposed product/category/price-override/subscription join was run through `EXPLAIN` on the real test schema. The product and direct category used `PRIMARY`; subscription ownership used `uq_subscription_plans_sale_product`; the price override is structurally one row through primary key `(price_list_root_id, product_id)`. Every join estimated at most one row for the tested product. There is no many-to-many join in the admission query.

## Accepted performance budget

After all tasks, the same one-line and ten-line cases must both meet:

```text
Main checkout:        12 query calls + BEGIN + COMMIT = 14 commands
JoFotara disabled:     1 autocommit query, no transaction =  1 command
Route total:                                             15 commands
```

That is a deterministic command reduction of:

- one-line checkout: `25 -> 15` (40%);
- ten-line checkout: `34 -> 15` (56% rounded).

These are protocol-command budgets, not invented production latency percentages. Local timing is not a Hostinger latency benchmark. Physical production acceptance must compare representative checkout response times after deployment, but the branch is not allowed to claim a specific millisecond improvement before that canary.

When stock is enabled and the product has tracked stock, the existing stock-deduction locking read and stock update add two commands. The corresponding target is 17, not 15. Customer upsert, service-charge snapshots, order-type hashes, subscriptions, tables, splits, held orders, bundles, and fiscal-required flows legitimately add their own commands and get separate semantic tests rather than being forced into the ordinary-sale ceiling.

## Production-code simplicity contract

The plan is detailed because checkout is a money path; the production implementation must remain boring and small:

| Task | Expected production shape | Do not introduce |
|---|---|---|
| 1 | Reuse the loaded setting and read two sequence values directly from the existing DML result headers | settings cache/service, sequence abstraction, stored function, multi-statements |
| 2 | Add two conditional SQL fragments to `fetchCartProducts()` and optional trusted inputs to the existing subscription/bundle validators | `CheckoutCatalogContext` class/file, repository layer, duplicate validator, generic query builder |
| 3 | Use mysql2's existing `VALUES ?` nested-row expansion, one small local flush closure in checkout, and at most one private chunk helper inside `bundleOrderItems.js` | shared batching framework, insert DSL, factory, multi-statements, prepared-statement manager |
| 4 | Delete the duplicate map comparison while keeping the existing authoritative reconciliation | replacement abstraction or rewritten table-settlement flow |
| 5 | Add one private preflight query function and reuse `loadAutomaticInvoicePolicy()`, `automaticRequired()`, `ensurePendingSalesDocument()`, and `publicState()` | new settings lock, policy engine, repository, generic transaction wrapper, cache, background job |

If a task cannot be implemented within that shape, stop and report the concrete reason instead of adding architecture. A few repeated SQL column names are preferable to a generic insert system on this money path.

## Pre-execution dry run

The measured command graph was replayed with only each task's explicit deletions/additions. Transaction controls count as commands; Task 4 is intentionally zero because it is a code-ownership cleanup:

| Scenario | Current | Task 1 | Task 2 | Task 3 | Task 4 | Task 5 final |
|---|---:|---:|---:|---:|---:|---:|
| One ordinary line, stock off, fiscal off | 25 | 22 | 19 | 19 | 19 | 15 |
| Ten ordinary lines, stock off, fiscal off | 34 | 31 | 28 | 19 | 19 | 15 |
| One ordinary tracked-stock line, fiscal off | 27 | 24 | 21 | 21 | 21 | 17 |

The fiscal-only branches model as:

- disabled/no document: `5 -> 1` command;
- existing standard document: `6 -> 1` command;
- newly required document: `11 -> 10` commands, because the read-only preflight is added but the outer duplicate document lock and final duplicate read are removed.

Expected runtime behavior:

- a one-line checkout sends less SQL but performs the same arithmetic, locks, writes, and receipt reconstruction;
- daily-order and invoice counters retain the same atomic `LAST_INSERT_ID(expr)` writes and lock order, but consume the value already returned in each OK packet instead of asking the server for it again;
- a ten-line checkout sends one bounded parent-row insert instead of ten, trading a slightly larger packet for nine fewer client/server command cycles;
- bundle parents remain individual, while child IDs remain unused and can be inserted in bounded groups without changing parent links or audit rollback;
- the common JoFotara-disabled path no longer opens a transaction; a required document stays post-commit and uses the existing creator/unique-key authority;
- any batch error still rejects the same transaction, so the cashier never receives partial success.

These are command-graph outcomes, not a claimed Hostinger latency percentage. The permanent real-MariaDB contract in Task 5 must prove them before the branch is considered complete.

## MySQL skill audit

The final plan was checked against the disposable `posapp_test` database, not only against source text:

- MariaDB is `10.4.32`, the transaction isolation level is `REPEATABLE-READ`, and local `max_allowed_packet` is only `1,048,576` bytes.
- The proposed admission read is driven by `products.PRIMARY`; direct category and price-list root are `eq_ref` through `categories.PRIMARY`; the price override is `eq_ref` through primary key `(price_list_root_id, product_id)`; and subscription ownership is `eq_ref` through unique key `uq_subscription_plans_sale_product`.
- A rolled-back drift probe deliberately attached a note category to a valid price-list root and created an override for its product. Adding `direct_category.is_notes = 0` to the root join returned `root_id=NULL`, `override_price=NULL`, and the original catalog price, proving both the shortcut and note-price invariant at the SQL boundary.
- `ANALYZE FORMAT=JSON` executed the three-product admission shape in about `0.36 ms` on the tiny warm test fixture. That proves the joins execute as a bounded lookup locally; it is not a Hostinger latency claim.
- The JoFotara preflight has an existing unique/indexed path for every lookup: `orders.PRIMARY`, `settings.PRIMARY`, `uq_jofotara_source`, and `uq_customer_subscriptions_invoice`. Against a rolled-back finalized-order probe, `EXPLAIN`/`ANALYZE FORMAT=JSON` used `const` access for the order, all three settings aliases, and the document source key; the probe order was removed by rollback.
- A temporary-table protocol probe on the installed mysql2/MariaDB pair returned `insertId=1` for the first `INSERT ... LAST_INSERT_ID(1)`, `insertId=2` for its duplicate-key increment, and `insertId=1` for `UPDATE ... LAST_INSERT_ID(column + 1)`. A two-connection probe against the real test `daily_sequences` key kept the second statement blocked until the first commit, then returned `1` and `2` with stored value `2`; the probe row was removed afterward. MySQL documents `mysql_insert_id()`/the OK packet as the direct client result of `LAST_INSERT_ID(expr)` in `INSERT` or `UPDATE`; no follow-up `SELECT` is needed.
- A hostile batch-format probe used 50 rows filled with quotes, backslashes, newlines, and large modifier JSON. The 256-KiB row-data budget split them into 13 statements; the largest mysql2-formatted SQL was `272,496` bytes, safely below the measured 1-MiB packet ceiling, while ten ordinary rows remained one `606`-byte statement.
- Tiny fixture tables may legitimately make MariaDB choose `ALL` plus an in-memory filesort for bundle members or final receipt rows. Permanent tests must assert bounded result identity and eligible keys, not freeze one optimizer access-type string.

No new index is justified by this workload. A covering product index is inappropriate because the admission read is already PK-driven and deliberately selects wide mutable data including modifier JSON; duplicating those columns would increase every catalog write and buffer-pool use. Likewise, adding `(bundle_id, sort_order)` solely to remove a filesort over one bundle's small member list would increase write/index maintenance without measured production benefit. Keep the existing `idx_pbi_bundle` filter and reconsider the composite index only if a production query digest or `ANALYZE` on representative data shows that member ordering is material.

## Load-bearing invariants

1. Client prices, modifier prices, priced-note prices, totals, tax, and discounts remain untrusted. The server still reconstructs them from database or frozen server-authored state before validating submitted subtotal and total.
2. A priced note is loaded in the same authoritative context as its parent product; note-category eligibility and current catalog price remain required.
3. Sold-out `is_available=0` products already present in a cashier cart retain the current allowed behavior. This refactor must not invent a new availability rejection.
4. Fresh subscription-plan sale products remain blocked unless the request carries the matching subscription-purchase intent. Frozen table/held semantics remain unchanged.
5. Bundle parent identity and every submitted child membership remain database-authenticated. Client child quantity, name, and product identity remain untrusted.
6. The admission query is a non-locking consistent read. Stock deduction retains its separate later `FOR UPDATE`, after existing shift/table/order locks and in the same current lock order; none of the new checkout-context joins may enter that lock query.
7. No `Promise.all()` is used on one transactional mysql2 connection. Query order remains explicit.
8. No price, modifier, note, stock, setting, subscription-plan, or service-charge value is cached across requests.
9. Daily order ID and paid invoice number allocation remain write-based and race-safe. Neither sequence is replaced by `MAX()+1` or client state.
10. Bundle parents remain single inserts because their generated IDs bind child rows. Only rows whose IDs have no downstream consumer may be batched.
11. A failed multi-row insert rolls back the same enclosing checkout transaction. No partial order, stock mutation, audit event, subscription, or invoice identity may commit.
12. Table settlement retains exactly one authoritative submitted-versus-saved identity/quantity comparison plus stable saved-line price pinning. Removing duplicate work must not remove the stronger `order_item_id` anti-swap check.
13. JoFotara preparation remains post-payment-commit. A fiscal preparation error cannot roll back or disguise a successful payment.
14. A pre-existing standard-invoice JoFotara document remains visible on checkout replay even when automatic submission is currently disabled; platform and subscription-purchase sources remain Operations-only.
15. A JoFotara enable/disable or cutoff change is observed from the database on the next request. The fast path uses no process cache and the recovery worker remains authoritative for missed required documents.
16. Idempotency preflight, the unique-key race recovery, shift locks, table locks, service-charge locks, stock locks, audits, and receipt reconstruction stay in their current transaction phase.
17. No API response field, status code, public error code, receipt money, persisted money, or print payload changes as a performance side effect.

## Explicit non-goals

- No Fastify migration. The measured cost is database command count inside one route, not Express dispatch overhead.
- No Redis, message broker, stored procedure, microservice, read replica, worker thread, or additional process.
- No broad repository-layer rewrite and no arbitrary breakup of `executeCheckout()`.
- No cross-request catalog/settings cache.
- No removal or earlier acquisition of stock, shift, table, order, sequence, service-charge, or idempotency locks.
- No move of final receipt reconstruction after commit; that would change post-commit failure behavior.
- No batching of bundle parents.
- No production per-query logging and no SQL values in diagnostics.

---

## Task 1: Establish the command budget and remove three redundant reads

**Files:**

- Create: `backend/tests/integration/checkoutPerformanceContract.test.js`
- Modify: `backend/services/OrderPricing.js`
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/utils/orderSequence.js`
- Modify: `backend/utils/invoiceSequence.js`
- Modify: `backend/tests/unit/checkoutModuleWiring.test.js`
- Modify: `backend/tests/unit/orderSequence.test.js`
- Modify: `backend/tests/unit/invoiceSequence.test.js`

### Step 1.1 - RED: add a real-MySQL command capture local to the test

In `checkoutPerformanceContract.test.js`, use the existing real integration seed and HTTP route. Patch `pool.getConnection` only for the duration of one request. Treat every acquisition as a new lease even when mysql2 returns the same pooled connection object: save that lease's original `query`, `beginTransaction`, `commit`, `rollback`, and `release`; wrap them for one command group; restore them before the real `release`; and restore any unreleased lease plus `pool.getConnection` in `finally` even when checkout fails. Never leave a wrapper on an object returned to the pool and never wrap a prior wrapper. Task 5's one-read fiscal disposition must also use an explicitly acquired connection (`getConnection` -> one query -> release, with no transaction) so it remains visible in this same capture without adding global instrumentation.

The capture must:

- record normalized SQL text but never parameter values;
- keep commands grouped per acquisition lease so the main transaction and post-commit fiscal phase remain distinguishable even if the pool reuses one physical connection;
- prove the response is 200 and persisted totals/items are correct before examining performance;
- assert one main transaction and one fiscal transaction at the current RED point;
- assert the main settings query does not yet contain `shared_order_sequence` and that a standalone lookup still exists;
- assert the main transaction currently issues exactly two standalone `SELECT LAST_INSERT_ID()` reads: one for the daily order ID and one for the public invoice number.

Add a unit assertion that `loadCheckoutSettings()` exposes a boolean `sharedOrderSequence` sourced from the settings helper. It must fail before implementation.

In the existing real-MariaDB sequence tests, count SQL commands around each reservation. Add RED assertions that the first-insert, duplicate-update, and per-shift-update cases should return their reserved number from one DML command and issue no `SELECT LAST_INSERT_ID()`. Retain rollback-unburn behavior and add a two-connection serialization case that returns two distinct consecutive values after the first transaction releases its lock.

Run:

```powershell
npx vitest run backend/tests/integration/checkoutPerformanceContract.test.js backend/tests/unit/checkoutModuleWiring.test.js backend/tests/unit/orderSequence.test.js backend/tests/unit/invoiceSequence.test.js
```

Expected RED: the shared setting is absent, its standalone SQL remains, and both sequence helpers still execute their standalone result reads.

### Step 1.2 - GREEN: fold the setting into the existing read

Add `shared_order_sequence` to the existing `getSettings()` key list in `loadCheckoutSettings()` and return `sharedOrderSequence: s.shared_order_sequence === '1'`.

In `executeCheckout()`, delete the standalone settings query and derive `isSharedSeq` from `checkoutSettings.sharedOrderSequence`. Do not move daily sequence allocation or alter its scope logic.

The focused test must now show one fewer main query and no SQL statement whose sole purpose is `shared_order_sequence`.

### Step 1.3 - GREEN: consume the two sequence OK-packet values

Keep both existing counter DML statements unchanged: `LAST_INSERT_ID(expr)` remains the atomic connection-local reservation mechanism. In `reserveDailyOrderId()` and `reserveInvoiceNumber()`, retain the `ResultSetHeader` returned by that DML statement, derive the positive number from `result.insertId`, and delete only the following `SELECT LAST_INSERT_ID()`.

For the per-shift `UPDATE`, preserve the existing `affectedRows === 0` missing-shift error before accepting `insertId`. Do not change counter tables, lock order, rollback behavior, sequence scope, or collision handling. Do not add a helper, stored function, `RETURNING`, multi-statements, or a second connection.

The tests must prove:

- first insert and duplicate-key increment both return the correct number from one command;
- per-shift update returns the incremented `last_order_seq` from one command;
- rollback still un-burns a reservation;
- two connections serialize and receive unique consecutive values;
- checkout emits neither standalone `SELECT LAST_INSERT_ID()` statement.

The focused performance contract must now show three fewer main queries in total for Task 1.

### Step 1.4 - Verify and commit

Run only:

```powershell
npx vitest run backend/tests/integration/checkoutPerformanceContract.test.js backend/tests/unit/checkoutModuleWiring.test.js backend/tests/unit/orderSequence.test.js backend/tests/unit/invoiceSequence.test.js backend/tests/integration/openTableNumbers.test.js
```

Commit:

```text
perf(checkout): remove redundant result reads
```

---

## Task 2: Collapse four admission reads into one non-locking checkout context

**Files:**

- Modify: `backend/services/InventoryService.js`
- Modify: `backend/services/SubscriptionService.js`
- Modify: `backend/services/bundleOrderItems.js`
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/tests/unit/inventoryService.test.js`
- Modify: `backend/tests/unit/subscriptionService.test.js`
- Modify: `backend/tests/integration/checkoutPerformanceContract.test.js`
- Modify: `backend/tests/integration/categoryPriceLists.test.js`
- Modify: `backend/tests/integration/bundle.checkout.test.js`
- Modify: `backend/tests/integration/subscriptionPurchase.test.js`
- Modify: the priced-note cases in `backend/tests/integration/checkout.test.js`

### Step 2.1 - RED: specify the checkout-context row contract

Extend `fetchCartProducts()` with an explicit option named `includeCheckoutContext` (default `false`). Tests must require that the option adds, for each unique base or note product:

- `is_bundle`;
- the validated price-list root identity/name;
- `effective_price`, using the one matching `product_price_overrides` row or base price;
- `subscription_plan_id`, nullable and one-to-one through `uq_subscription_plans_sale_product`.

Keep this inside the existing function: one conditional SELECT fragment, one conditional JOIN fragment, and the existing row-to-`Map` normalization. Do not introduce a query-builder helper, a context object class, or a new production file. The returned value remains the same ordinary product `Map`; its rows simply carry the extra fields when requested.

Put `direct_category.is_notes = 0` in the validated-root join itself. This prevents note-category products from probing `product_price_overrides` and makes their catalog-price rule structural rather than relying only on the JavaScript normalizer.

The existing product, category, note-category, modifier JSON, tax, stock, and `can_sell` fields remain present.

Add hostile tests for:

- a base product plus priced-note product both appearing exactly once;
- an active category price override winning over base price;
- an invalid/inactive price-list root falling back to base price;
- a note-category product ignoring a price-list override and retaining its own catalog price, matching `loadRegisterPriceContext()` today;
- a subscription sale product exposing the matching plan ID;
- an inactive subscription plan's sale product still exposing its plan ID, because the existing checkout intent guard does not exempt inactive plans;
- no row multiplication when the cart repeats a product;
- `includeCheckoutContext: true` combined with `lock: true` throwing an internal `TypeError` before SQL is issued; the ordinary stock-lock call continues to use `includeCheckoutContext: false`, contains `FOR UPDATE`, and does not join `product_price_overrides`, `subscription_plans`, or price-list roots.

### Step 2.2 - RED: make subscription intent validation consume trusted rows

Extend the existing `assertSubscriptionSaleProductIntent()` options with `trustedProductMap`. When supplied, validate cart base-product IDs against `subscription_plan_id` in that map and issue no query. When omitted, retain the current query for every existing caller. Do not add a second exported helper or a new module.

Tests must preserve all current outcomes:

- ordinary product: allowed;
- one plan product with no intent: `SUBSCRIPTION_PURCHASE_INTENT_REQUIRED`;
- matching `allowPlanId`: allowed;
- mismatching or multiple plan products: rejected.

No fallback query is allowed when checkout explicitly supplies the trusted map. Missing map entries are an error, not permission to continue.

### Step 2.3 - RED: reuse trusted bundle metadata

Let `validateBundleCartLines()` accept an optional trusted product map. With it:

- bundle/non-bundle identity comes from `product.is_bundle` in that map;
- it must not re-query `products`;
- only actual nested bundle parents trigger the bundle-member query;
- that one member query must return the authoritative member `product_id`, `qty`, `name`, and `sort_order` needed later by `insertBundleChildren()`;
- order the result by `bundle_id, sort_order` so definitions for multiple bundle parents remain deterministic;
- the validator returns a bundle-definition map for the caller.

Pass the returned definition into `insertBundleChildren()` so checkout does not query the same bundle definition a second time. Existing callers that do not supply a trusted map retain their current behavior.

Hostile tests must prove:

- a nested array on a non-bundle product;
- a bundle product with a missing nested array on a fresh checkout;
- an undeclared, malformed, or removed member identity;
- forged client quantity/name being ignored in favor of the returned database definition;

### Step 2.4 - GREEN: wire one context into checkout

For checkout admission only:

1. call `fetchCartProducts(conn, cartItems, { includeCheckoutContext: true })` once;
2. validate subscription intent from that map;
3. remove the checkout call to `attachRegisterPrices()`;
4. pass the same map into bundle validation;
5. pass returned bundle definitions into bundle child insertion.

Do not change `attachRegisterPrices()` or the async subscription helper for catalog, held-order, table-save, or other callers.

The resulting query replaces these four current statements:

- base/note product admission;
- `subscription_plans` intent lookup;
- register price context lookup;
- bundle-parent `products` lookup.

The member query remains conditional on an actual bundle. The later stock `FOR UPDATE` remains unchanged.

### Step 2.5 - Verify the execution plan and semantics

After the exact joined SQL exists, run `EXPLAIN` and the version-appropriate read-only execution plan (`ANALYZE FORMAT=JSON` on MariaDB, `EXPLAIN ANALYZE` on supported MySQL) once against `posapp_test`, then record the normalized access result in the task handoff. Confirm that the product/category/override/subscription joins remain bounded by the existing primary or unique keys and that the result still has one row per requested product. Do not make an optimizer's exact `type` string a permanent assertion—MariaDB may choose a different valid plan as table cardinality changes. Do not add an index or migration: the required keys already exist.

Run:

```powershell
npx vitest run backend/tests/unit/inventoryService.test.js backend/tests/unit/subscriptionService.test.js backend/tests/integration/categoryPriceLists.test.js backend/tests/integration/bundle.checkout.test.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/checkoutPerformanceContract.test.js
npx vitest run backend/tests/integration/checkout.test.js -t "priced note|already in the cart when it became sold out"
```

The performance contract must show three fewer main queries than Task 1, while persisted totals, taxes, note snapshots, override prices, and error codes remain identical.

Commit:

```text
perf(checkout): load one authoritative catalog context
```

---

## Task 3: Batch rows that do not need generated identities

**Files:**

- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/services/bundleOrderItems.js`
- Modify: `backend/tests/integration/checkoutPerformanceContract.test.js`
- Modify: `backend/tests/integration/checkout.test.js`
- Modify: `backend/tests/integration/bundle.checkout.test.js`

### Step 3.1 - RED: ordinary parent batching

Add a ten-line ordinary cash checkout to the performance contract. Before implementation it must observe ten single-row parent `order_items` inserts.

Specify the target:

- consecutive non-bundle parent rows are inserted with one multi-value statement per batch;
- the batch is bounded by both 50 rows and 256 KiB of finalized row-array data; estimate the latter with `Buffer.byteLength(JSON.stringify(row), 'utf8')` before adding the row;
- flush a non-empty pending batch before the next row would cross either bound; a single oversized row is sent alone, matching the current single-row behavior rather than inventing a new public validation rule;
- one to fifty ordinary rows that remain below the byte budget produce one parent insert statement;
- 51 small rows produce two, without changing `sort_order`;
- use the repository's existing `conn.query('... VALUES ?', [rows])` nested-row pattern; do not interpolate names, notes, JSON, or money, and do not use variable-shape `execute()` statements that would fill mysql2's per-connection prepared-statement cache.

MariaDB documents multi-value `INSERT` as the direct speed optimization for many rows and identifies `max_allowed_packet` as the bound. Do not enable multi-statements, disable integrity checks, or change transaction boundaries.

### Step 3.2 - GREEN: preserve bundle parent identity

Refactor only the item-persistence loop:

1. compute the same tax category, tax amount, selected-modifier snapshot, persisted source price, charged price, discounts, and sort order before persistence;
2. accumulate ordinary/service-charge parents into a bounded pending batch;
3. before any row whose generated parent ID is consumed by catalog, snapshot, or persisted bundle children, flush pending ordinary rows;
4. insert the bundle parent alone and use its `insertId` for children;
5. flush the trailing ordinary batch.

Keep the flush closure local to `executeCheckout()`. Keep only two local counters—the pending rows and their estimated bytes—flush on the fixed row/byte constants, call `conn.query(... VALUES ?, [rows])`, then clear both. Do not query `@@max_allowed_packet` per checkout, export the closure, or make it configurable. Do not infer bundle status from the client alone; retain the current trusted/frozen bundle decisions.

### Step 3.3 - GREEN: batch bundle child rows without batching parents

Inside `bundleOrderItems.js`, use one small private `insertBundleChildRows(conn, sql, rows)` helper with the same fixed 50-row/256-KiB boundaries and `conn.query(sql, [chunk])`. It must not accept table names, column names, callbacks, mappers, limits, or options, and it must not be exported. Apply it to current-catalog, persisted, and server-snapshot children while preserving:

- the parent ID supplied by the single bundle-parent insert;
- authoritative quantity/name/member identity;
- removed-child audit behavior;
- exact `sort_order` progression;
- current frozen tax/modifier fields on persisted children;
- transaction rollback on any child failure.

Do not batch different bundle parents together. Removed-child audit rows may remain individual; they are exceptional and audited, not the common throughput path.

### Step 3.4 - Attack the batching boundary

Add/retain focused tests for:

- ten ordinary rows: one parent insert, ten persisted rows, exact totals;
- normal -> bundle -> normal: the two ordinary regions may be separate batches, the bundle parent gets the correct children, and all sort orders are stable;
- two bundles: distinct parent IDs and no child crosses parents;
- priced notes and formal modifiers survive JSON/money persistence unchanged;
- service charge and tax-exempt metadata remain exact;
- a forced failure in one batched row rolls back order, items, stock, subscription, and audits;
- one synthetic checkout containing 51 ordinary lines proves two parent batches without exporting or directly testing the local closure; do not turn this into 51 HTTP requests.
- finalized rows containing large escaped notes/modifier snapshots cross the 256-KiB boundary into multiple statements; in the test only, use `mysql2.format()` to prove each produced statement stays below the measured 1-MiB test-server packet limit.

Run:

```powershell
npx vitest run backend/tests/integration/checkoutPerformanceContract.test.js backend/tests/integration/bundle.checkout.test.js
npx vitest run backend/tests/integration/checkout.test.js -t "Happy Path|priced note|modifier|batch|rolls back"
```

The ten-line ordinary main transaction must now have the same query count as the one-line main transaction.

Commit:

```text
perf(checkout): batch independent order item rows
```

---

## Task 4: Keep one authoritative table-settlement comparison

**Files:**

- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/tests/integration/tableSettlementContext.test.js`
- Modify: focused table-settlement cases in `backend/tests/integration/checkout.test.js`

### Step 4.1 - RED: pin the stronger comparison

Before deleting anything, add tests proving `reconcileSavedTableSettlement()` is the sole policy owner and catches:

- added, removed, or quantity-changed products;
- product/note/name identity changes;
- duplicate reuse of one `order_item_id`;
- pointing a submitted line at another saved line with the same product but a different frozen price;
- bundle parent/child corruption;
- more than one submitted service-charge exception;
- a valid unchanged order with duplicate product/note groups and stable IDs.

The stable-ID anti-swap checks at `TableSettlementContext.js` are stronger than the later aggregate map comparison and must remain.

### Step 4.2 - GREEN: delete only the duplicate policy

In `executeCheckout()`:

- keep `tableContext.savedItems` as the source for `savedRows`, `buildSavedLineIndex()`, frozen prices, frozen taxes, audit comparisons, and persisted bundle children;
- remove the second saved-map/cart-map identity and quantity comparison;
- retain the defensive fallback reload when `tableContext` is absent; it is not reached on the measured checkout route, costs nothing on that hot path, and preserves the callable operation's behavior for any non-route caller;
- retain the exclusion of the service-charge line from frozen product matching;
- retain `assertOrderItemBundleIntegrity()` at the authoritative locked-context boundary.

This is a deletion/ownership cleanup, not a claimed round-trip reduction on the current happy path. Report the deleted duplicate lines separately from the command-count gain.

### Step 4.3 - Verify and commit

Run:

```powershell
npx vitest run backend/tests/integration/tableSettlementContext.test.js
npx vitest run backend/tests/integration/checkout.test.js -t "table|settle|saved item|price-line|service charge"
```

Commit:

```text
refactor(checkout): keep one table settlement authority
```

---

## Task 5: Make non-required JoFotara preparation one read and close the budget

**Files:**

- Modify: `backend/services/JofotaraService.js`
- Modify: `backend/tests/integration/jofotara.test.js`
- Modify: `backend/tests/integration/checkoutPerformanceContract.test.js`
- Modify: `backend/tests/integration/checkoutPostCommit.test.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

### Step 5.1 - RED: specify a single-read disposition

Add one private `loadCheckoutAutomaticDisposition()` function in `JofotaraService.js`. It explicitly acquires a pool connection, performs one autocommit query, and releases it in `finally`. It must not call `beginTransaction`, `commit`, or `rollback`. The one statement must read:

- immutable finalized-order eligibility fields;
- subscription-purchase existence;
- `jofotara_enabled`, `jofotara_auto_submit`, and `jofotara_auto_submit_since` from the database;
- an existing document's public state by unique `source_key`.

Drive the query from `orders.invoice_id = ?`. Join the three settings as three literal-key aliases on `settings.PRIMARY`, join the existing document by `uq_jofotara_source`, and use `EXISTS` on unique `customer_subscriptions.purchase_invoice_id`. Select explicit public-state columns only. Do not use `SELECT *`, a CTE/derived settings pivot, JSON aggregation, credential secrets, or large XML/response fields on this preflight.

Tests must require:

- disabled + no document: `not_required`, one query, no acquired transaction connection beyond the autocommit command;
- enabled but outside cutoff + no document: `not_required`, one query, no transaction;
- platform/subscription exclusion: current result code, one query, no transaction;
- disabled + an existing standard-invoice document in every supported status (`pending`, `submitting`, `accepted`, `rejected`, or `unknown`): existing public state is returned as `required`, not hidden by the disabled policy;
- changing the setting between two calls is observed immediately, proving no process cache.

### Step 5.2 - GREEN: retain the locked creation path only when required

Apply the current disposition precedence exactly: first return `not_required` for platform and subscription-purchase sources, which remain Operations-only even if they already have a document; next return an existing standard-invoice document's public state regardless of current automatic settings; then return `not_required` when automatic creation is not required. Only the final required-and-absent case enters a transaction.

Only when a document is required and absent:

1. open the existing transaction;
2. call the existing `loadAutomaticInvoicePolicy()` again inside that transaction so source eligibility and automatic settings are re-read using today's behavior;
3. if policy is now not-required, commit and return without creating a document;
4. call `ensurePendingSalesDocument()` exactly once; it remains the sole owner of the `source_key ... FOR UPDATE` lock, the race check, invoice loading, and creation;
5. use the `document` it returns for the response, whether found under the lock or newly created; do not issue the current outer duplicate lock or final duplicate `SELECT`;
6. commit and release.

Do not add a settings `FOR UPDATE`, create a second transaction helper, or add a new policy module. A settings change after the transactional policy read has the same effect it has today: the in-flight request may finish under the policy it read, and the next request observes the new value. The existing source-key lock and unique constraint remain the concurrency authorities. Do not move XML creation into the checkout payment transaction.

The operations worker remains unchanged and continues to recover a required finalized invoice with no document after its two-minute safety window.

### Step 5.3 - Attack policy and replay races

Tests must cover:

- two concurrent required preparations create one row and return the same document identity;
- an existing platform/subscription document remains hidden from the checkout surface and returns the current `not_required` exclusion code;
- settings disabled after preflight but before mutation: the transactional recheck creates nothing;
- settings enabled after a disabled preflight: the current request may return not-required, and the existing recovery-worker candidate query still finds the eligible invoice from the configured cutoff;
- checkout replay after a document exists returns the stored state without creating a second row;
- preparation failure remains a post-commit `preparation_failed` result and the paid order remains committed;
- no credential value appears in the preflight result, response, or logs.

### Step 5.4 - Close the measured budgets

The permanent performance contract must assert:

```text
ordinary one-line, stock off, fiscal off: 13 query calls, 1 transaction pair, 15 commands total
ordinary ten-line, stock off, fiscal off: 13 query calls, 1 transaction pair, 15 commands total
ordinary one-line, tracked stock on:       15 query calls, 1 transaction pair, 17 commands total
```

Also assert query-shape facts rather than relying only on a total:

- no standalone `shared_order_sequence` lookup;
- no standalone `SELECT LAST_INSERT_ID()` lookup;
- one checkout-context product read;
- no checkout-side standalone subscription or price-context read;
- no product-identity lookup in bundle validation when trusted context is supplied;
- one parent insert for ten ordinary rows;
- no JoFotara transaction when the one-read disposition is not required;
- the stock locking read still exists and contains no checkout-context joins.

Run focused verification:

```powershell
npx vitest run backend/tests/integration/checkoutPerformanceContract.test.js backend/tests/integration/checkoutPostCommit.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/tableSettlementContext.test.js backend/tests/integration/categoryPriceLists.test.js backend/tests/integration/bundle.checkout.test.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/unit/inventoryService.test.js backend/tests/unit/subscriptionService.test.js backend/tests/unit/checkoutModuleWiring.test.js
npm run architecture
npm run architecture:check
```

Update the checkout, catalog-pricing, bundle, table-settlement, and JoFotara nodes/flows in `docs/architecture.json`, then regenerate the HTML. Do not claim a Hostinger millisecond result in architecture documentation.

Commit:

```text
perf(checkout): skip non-required fiscal transactions
```

---

## Adversarial plan attack

The executor must re-run this table after each task, not only at the end.

| Attack | Why the tempting shortcut fails | Required defense |
|---|---|---|
| Merge catalog admission into stock `FOR UPDATE` | Joined locking reads can lock scanned index records and extend contention into overrides, subscriptions, and price-list roots | Keep the current later stock-deduction read separate, do not add checkout-context joins, and preserve lock order |
| Cache settings or catalog state in Node | A changed price, note, subscription plan, tax profile, service charge, or fiscal policy becomes stale across checkouts | Read transaction-scoped state every request |
| Read a later session `LAST_INSERT_ID()` or use another connection | Any intervening command/lease mistake can return the wrong counter and restores the removed round trip | Read `insertId` immediately from the exact successful DML `ResultSetHeader`; keep the existing connection and DML unchanged |
| Run independent queries with `Promise.all()` | One mysql2 transaction connection is serialized and ordering is part of deadlock/security policy | Preserve explicit sequential awaits |
| Batch bundle parents | Child rows need each generated parent ID | Flush ordinary batch, insert each bundle parent alone |
| Trust client bundle children to avoid the member query | Quantity/name/membership forgery becomes possible | Keep one authoritative bundle-member read per actual bundle set |
| Skip fiscal document lookup whenever disabled | A standard-invoice checkout replay hides a previously created document in any status | One preflight query must include existing document state while preserving platform/subscription exclusion precedence |
| Trust fiscal preflight for mutation | Settings may change before document creation | Re-read policy and lock source key in the required transaction |
| Move receipt reconstruction after commit | A reconstruction failure becomes a paid checkout reported as failed | Keep current pre-commit reconstruction |
| Delete both table comparisons | Frozen price-line swaps become possible | Keep `reconcileSavedTableSettlement()` and stable-ID consumption |
| Add new indexes reflexively | Existing primary/unique keys already produce one-row joins; extra indexes increase write cost | Keep schema unchanged and verify with `EXPLAIN` |
| Replace Express/Fastify or use workers | Framework/CPU changes do not remove measured MySQL commands and expand failure surface | Optimize the actual command graph |
| Add broad runtime tracing | Always-on per-query correlation/logging consumes the resources being saved and risks SQL/data leakage | Keep a test-only command contract and existing connection telemetry |

## Expected outcome and honest limits

If all gates pass, the ordinary checkout performs the same durable business operation with ten fewer MySQL commands for one line and nineteen fewer for ten lines. The improvement comes from deleting redundant network/database work, not weakening checks or adding infrastructure.

This plan does not promise that every checkout path takes 15 commands. Tables, splits, held orders, subscriptions, service charges, customers, tracked stock, bundles, tax exemptions, price overrides, and required JoFotara documents do more work by design. Their acceptance criterion is unchanged correctness plus removal of the specific duplicated reads/inserts that apply to them.

The final release decision still needs one controlled Hostinger canary comparing the same realistic cart before and after deployment. Record median and p95 HTTP checkout duration, database pool acquisition/enqueue counters, checkout error rate, and any lock waits. Do not retry money-path requests automatically and do not deploy as part of this implementation branch.

## Definition of done

1. Five task commits exist in order with the subjects above.
2. The feature branch contains no schema, migration, dependency, environment, API, deployment, installer, or spooler change.
3. The 15/15/17 command budgets pass against real MariaDB.
4. The product-context `EXPLAIN` is reviewed against the final SQL, remains primary/unique bounded, and one-row-per-product behavior is a permanent test.
5. Stock uses its separate existing `FOR UPDATE`, gains none of the checkout-context joins, and preserves current lock ordering.
6. Priced notes, category prices, modifiers, bundles, subscriptions, tables, service charges, tax exemption, idempotency, and audits retain their focused tests and public codes.
7. Multi-row persistence preserves exact rows, sort order, parent relationships, taxes, discounts, modifier snapshots, and rollback atomicity.
8. JoFotara disabled/outside-cutoff paths use one read and no transaction; required creation remains locked, unique, and recoverable.
9. Architecture JSON/HTML are current and `architecture:check` passes.
10. No merge, push, deployment, version bump, or production canary occurs without a separate explicit instruction.
11. The production diff adds no new production module, class, dependency, cache, repository/query-builder layer, generic batching framework, or transaction wrapper. Task 4 is a net deletion. Task 1 remains direct settings/result reuse; Task 2 enriches and passes the existing map; Task 3 uses only local/private batching; Task 5 adds only its private preflight function and reuses the existing fiscal helpers.
12. Common small carts still use one multi-row insert, while large textual rows split at the fixed 256-KiB estimate as well as the 50-row cap. No checkout performs a packet-size settings query, and the focused test proves the generated statements remain below the disposable server's measured 1-MiB packet limit.

## Primary technical references

- [MySQL 8.4: locks set by statements](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html)
- [MySQL 8.4: locking reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)
- [MySQL 8.4: minimizing deadlocks](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks-handling.html)
- [MariaDB: multi-value INSERT optimization and packet bound](https://mariadb.com/docs/server/ha-and-performance/optimization-and-tuning/query-optimizations/how-to-quickly-insert-data-into-mariadb)
- [MariaDB INSERT syntax](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/inserting-loading-data/insert)
- [MariaDB `LAST_INSERT_ID(expr)`: the value is sent to the client](https://mariadb.com/docs/server/reference/sql-functions/secondary-functions/information-functions/last_insert_id)
- [MariaDB `mysql_insert_id`: returns the last `LAST_INSERT_ID(expr)` value](https://mariadb.com/docs/connectors/mariadb-connector-c/api-functions/mysql_insert_id)
- [MySQL client API: `mysql_insert_id()` after `LAST_INSERT_ID(expr)`](https://dev.mysql.com/doc/c-api/8.4/en/mysql-insert-id.html)
- [mysql2 `ResultSetHeader.insertId`](https://sidorares.github.io/node-mysql2/docs/documentation/typescript-examples#resultsetheader)
