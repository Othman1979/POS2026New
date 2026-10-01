# Open-Table Void Ownership Implementation Plan

> Execution is intentionally deferred. Follow `docs/superpowers/plans/2026-07-24-refund-frontend-foundation-execution-prompt.md` when implementation is authorized.

**Goal:** Move the unpaid open-table void use case out of the Express route into one deep transaction module without changing any HTTP, financial, locking, audit, stock, kitchen, or realtime behavior.

**Architecture:** Keep `POST /api/pos/refunds` as the shared HTTP endpoint. Preserve `RefundService.refundPaidOrder()` exactly as the paid-refund domain operation. Add one `voidOpenTableOrder()` module that owns the unpaid-table void transaction and its post-commit use-case effects. The route parses the request, dispatches by explicit intent, and translates results/errors.

**Stack:** Node.js, Express 5, mysql2, Vitest/Supertest.

## Non-goals

- No paid-refund rewrite.
- No endpoint or response-shape change.
- No controller, repository, ORM, dependency-injection container, or generic transaction framework.
- No JoFotara, subscription, report, or checkout behavior change.
- No kitchen-print redesign.
- No splitting helper functions into separate files.

## Target files

**Create:**

- `backend/modules/refunds/voidOpenTableOrder.js`
- `backend/tests/unit/refundVoidModuleWiring.test.js`

**Modify:**

- `backend/routes/pos/refunds.js`
- `backend/tests/integration/refunds.test.js` only if a characterization gap below is not already covered

**Run without editing unless a real regression is found:**

- `backend/tests/integration/serviceChargeSnapshots.test.js`
- `backend/tests/integration/taxSourceOfTruth.test.js`
- relevant void cases in `backend/tests/integration/tables.test.js`

## Required module contract

```js
async function voidOpenTableOrder({
  user,
  invoiceId,
  items,
  io = null,
  ipAddress = null,
  printKitchenOrder
})
```

Return only the existing response facts:

```js
{
  refund_id,
  kind: 'void',
  scope,
  refund_status,
  amount_refunded: 0,
  table_freed
}
```

The route must not receive database rows, connections, table-lock objects, service-charge snapshots, or internal calculated line arrays.

## Task 1: Freeze the current endpoint contract and ownership boundary

**Files:**

- Create `backend/tests/unit/refundVoidModuleWiring.test.js`
- Verify `backend/tests/integration/refunds.test.js`

**Step 1: Add the static boundary test first**

The test must initially fail because the new module and delegation do not exist. It should assert:

- the route imports `../../modules/refunds/voidOpenTableOrder`;
- the void dispatch calls `voidOpenTableOrder({ ... })`;
- the post-dispatch void route slice contains no `pool.getConnection`, `beginTransaction`, `FOR UPDATE`, `INSERT INTO refunds`, `INSERT INTO refund_items`, `UPDATE restaurant_tables`, or `UPDATE order_items`;
- the new module contains no `req.`, `res.`, or `require('express')`;
- the module exports exactly `voidOpenTableOrder`;
- `RefundService.js` still exports and the route still calls `refundPaidOrder` for paid refunds.

**Step 2: Inventory behavior already covered**

Confirm existing integration cases cover at least:

- whole-order and partial void;
- permissions for occupied and printed tables;
- table-group-first lock order;
- stale order/table conflict;
- duplicate and empty selections;
- service-charge exclusion/repricing/abandonment;
- bundle parent/child reconstruction and kitchen routing;
- a printer/socket/cache failure after commit cannot turn a committed operation into an HTTP failure;
- stock restoration;
- audit rollback;
- repeated partial void quantities;
- tax and modifier-surcharge recomputation;
- joined-table release;
- response keys and statuses.

Add a characterization test only for an uncovered observable. Do not duplicate existing scenarios under a new test name.

**Step 3: Run the failing ownership test**

```powershell
npx vitest run backend/tests/unit/refundVoidModuleWiring.test.js
```

Expected: fail only because delegation/module ownership has not been implemented.

**Step 4: Keep the red ownership test uncommitted**

Do not commit a deliberately failing branch state. Carry the new test into Task 2 and commit it with the smallest implementation that makes it green. If a missing behavioral characterization was added and is already green against the old implementation, it may be committed separately.

## Task 2: Extract the one deep void use-case module

**Files:**

- Create `backend/modules/refunds/voidOpenTableOrder.js`
- Modify `backend/routes/pos/refunds.js`

**Step 1: Move imports according to ownership**

Move void-only transaction dependencies from the route into the module:

- database pool and logger;
- money/line calculation needed only by void;
- dashboard cache invalidation;
- table realtime broadcasting;
- bundle persistence and integrity;
- kitchen item normalization;
- service-charge calculation/snapshot operations;
- table settlement locking;
- audit append;
- order total recomputation;
- tax registration normalization;
- void permission assertion.

Keep route-owned imports:

- Express/router;
- authentication middleware;
- HTTP response helpers;
- paid-refund permission check;
- `refundPaidOrder`;
- printer router used to supply `printKitchenOrder`;
- paid-refund transaction dependencies that remain necessary.

**Step 2: Move the transaction without semantic edits**

Move the reachable unpaid-table void statements in their current order. In the first green version:

- keep the table-group lock before order/item mutation;
- keep audit creation before commit;
- keep kitchen normalization/printing after commit;
- keep kitchen failure non-fatal;
- keep broadcasts and cache invalidation after commit;
- isolate non-critical post-commit effects so an exception is logged but never reports a committed void as failed;
- keep connection release in `finally`;
- throw status-bearing errors instead of sending HTTP responses inside the module.

Use small local error helpers only if they reduce repeated error construction inside this one file. Do not create an error class hierarchy.

**Step 3: Make the route a truthful adapter**

The route should:

1. validate `invoice_id`, `intent`, `items`, duplicate item IDs, and paid-refund permission;
2. dispatch paid refunds through the unchanged `refundPaidOrder()` path;
3. call `voidOpenTableOrder()` for `intent === 'void'`;
4. pass `printRouter.printKitchenOrder` as the printer function;
5. translate the returned object with `sendSuccess()`;
6. translate thrown `statusCode/publicCode` consistently with the existing route.

Never pass `req` or `res` into the module.

**Step 4: Run the ownership test and focused integration file**

```powershell
npx vitest run backend/tests/unit/refundVoidModuleWiring.test.js
npx vitest run backend/tests/integration/refunds.test.js
```

Expected: both green before cleanup.

**Step 5: Commit the mechanical extraction**

```powershell
git add backend/modules/refunds/voidOpenTableOrder.js backend/routes/pos/refunds.js backend/tests/unit/refundVoidModuleWiring.test.js
git commit -m "refactor: own open-table void transaction"
```

## Task 3: Delete unreachable paid-refund branches from the void module

**Files:**

- Modify `backend/modules/refunds/voidOpenTableOrder.js`
- Modify `backend/routes/pos/refunds.js` only for newly unused imports

**Step 1: Prove reachability before deletion**

The route must return from the `intent === 'refund'` branch before calling the void module, and the void module must be called only under explicit `intent === 'void'` dispatch.

**Step 2: Collapse void constants**

Inside the module:

- remove `kind` branching and use `kind: 'void'` only where persisted/returned;
- remove refund-method selection;
- remove paid-refund quantity semantics;
- remove paid-refund amount-cap and paid refund-status branches;
- remove paid-only prior-money calculations when no longer used by reachable void math;
- keep cent allocation only if the void ledger still needs it to reconcile header and item rows;
- keep the fixed reasons exactly: item selection means `Item removed from table`; omitted selection means `Table cleared`.

Do not deduplicate with `RefundService` by introducing a shared generic refund/void calculator unless the remaining algorithm is genuinely identical after deletion. Similar-looking financial code with different semantics should remain local.

**Step 3: Verify behavior and deletion value**

```powershell
npx vitest run backend/tests/unit/refundVoidModuleWiring.test.js backend/tests/integration/refunds.test.js
```

Inspect the diff. The route should have materially fewer transaction imports and no void SQL. The new module should be one cohesive file, not a relocated copy that still pretends to support refunds.

**Step 4: Commit the void-only simplification**

```powershell
git add backend/modules/refunds/voidOpenTableOrder.js backend/routes/pos/refunds.js
git commit -m "refactor: remove unreachable refund logic from void flow"
```

## Task 4: Adversarial cross-feature verification

**Files:** No planned production edits.

**Step 1: Run targeted cross-feature suites once**

```powershell
npx vitest run backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/taxSourceOfTruth.test.js
npx vitest run backend/tests/integration/tables.test.js -t "void|saved product removals use void endpoint|restamps merged line tax"
npx vitest run backend/tests/integration/reportsRefunds.test.js
```

If Vitest's `-t` expression is unreliable in this environment, run `tables.test.js` once rather than inventing a new wrapper.

**Step 2: Perform static negative checks**

```powershell
rg -n "beginTransaction|FOR UPDATE|INSERT INTO refunds|INSERT INTO refund_items|UPDATE restaurant_tables|UPDATE order_items" backend/routes/pos/refunds.js
rg -n "req\.|res\.|require\('express'\)" backend/modules/refunds/voidOpenTableOrder.js
rg -n "refundPaidOrder" backend/routes/pos/refunds.js backend/routes/admin/subscriptions.js backend/services/RefundService.js
```

Expected:

- the first command may still show paid-refund transaction control but no void transaction SQL;
- the second returns no matches;
- the third proves paid-refund reuse remains.

**Step 3: Inspect transaction and post-commit ordering manually**

Confirm from the diff, not only tests:

- no success response can happen before commit;
- rollback is attempted only while a transaction may be active;
- kitchen failure cannot roll back an already committed void;
- socket/cache effects cannot occur before commit and cannot make the response fail after commit;
- connection release happens on all paths;
- a returned success never exposes internal rows.

**Step 4: Commit only if verification required a real fix**

Do not create an empty verification commit. Do not rerun the entire test suite after a clean merge if these exact commits were already verified.

## Backend acceptance gate

The backend task is complete only when:

- the route is a thin intent/HTTP adapter;
- paid refunds still use the existing reusable service;
- one module owns the complete unpaid-table void use case;
- no Express objects enter that module;
- no void SQL remains in the route;
- unreachable refund branches are gone from the void implementation;
- existing response bodies/statuses, lock order, audit atomicity, stock, service charge, bundle, kitchen, and realtime behavior remain green;
- exactly one production module was added.
