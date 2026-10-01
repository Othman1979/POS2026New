# Table Order Save Transaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Use `ponytail` at full intensity throughout. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move both transactions behind `POST /api/pos/table_order` out of the 2,815-line Express route into focused table modules without changing HTTP, database, permission, printing, stock, audit, or realtime behavior.

**Architecture:** Keep `backend/routes/pos/tables.js` as the authenticated HTTP adapter. Extract the independent check-drop transaction to `markTablePrinted.js`, then move the normal save transaction to `saveTableOrder.js`; both return plain response data and throw errors carrying the existing `statusCode`/`publicCode`. The route remains responsible for `req`/`res`, success envelopes, and the two existing error-to-HTTP translations.

**Tech Stack:** Node.js CommonJS, Express 5, mysql2, Socket.IO, Vitest 4, Supertest, MySQL/MariaDB.

**Execution status:** Completed on `codex/table-order-save-transaction`; the post-review gate passed 163 test files / 1,734 tests, the production build, zero schema drift, and unchanged benchmark query counts.

## Global Constraints

- Start from Phase 1 commit `717f845ab88efdc757619a52df0fb2685ce02383` or a descendant containing it.
- Execute in an isolated worktree; do not disturb unrelated dirty or untracked files in the main workspace.
- Preserve `POST /api/pos/table_order`, `requireAuth` middleware order, request fields, response fields, status codes, public codes, and public messages.
- Preserve every SQL statement, lock, transaction boundary, mutation order, audit write, stock write, cache invalidation, broadcast, and print-failure policy during extraction.
- Do not change database schema, dependencies, authentication, permissions, or frontend code.
- Do not introduce controllers, repositories, DTOs, classes, factories, dependency containers, or generic transaction wrappers.
- Modules must not import Express or receive `req`/`res`.
- Pass the existing route-owned `printKitchenOrder` function as one concrete callback. Do not make a general dependency object.
- A temporary import from `backend/routes/pos/helpers.js` is explicitly allowed in these modules. Helper ownership is Phase 5; do not expand this phase to relocate shared helpers and do not create a re-export file to hide the dependency.
- Extract `mark_printed` and normal table saving in separate commits and review gates.
- Do not fix unrelated behavior discovered during code motion. Record it separately.
- Use focused tests after each task. Run the full suite and production build once at the Phase 2 gate; do not rerun the full suite after a later clean fast-forward merge of the already-tested commit.

## Current Evidence and Boundaries

- Phase 1 at `717f845a` passed 161 test files / 1,728 tests, the production build, zero schema drift, and the settlement benchmark.
- `backend/routes/pos/tables.js:1261-2173` currently owns the complete POST handler.
- `backend/routes/pos/tables.js:1263-1342` is the independent `mark_printed` transaction.
- `backend/routes/pos/tables.js:1344-2172` is the normal table-save transaction.
- Direct table-order POST coverage exists in eight integration files: `tables.test.js`, `bundle.tables.test.js`, `serviceChargeSnapshots.test.js`, `permissions.test.js`, `openTableNumbers.test.js`, `taxSourceOfTruth.test.js`, `subscriptionPurchase.test.js`, and `checkout.test.js`.
- The current benchmark measures checkout and `mark_printed`, but not normal table saving. Phase 2 must establish that missing baseline before production code moves.
- Phase 1 intentionally left the Saved Order Lines interface in `backend/modules/orders/SavedOrderLines.js`; Phase 2 must consume it unchanged.

## Interfaces

`backend/modules/tables/markTablePrinted.js` produces:

```js
async function markTablePrinted({ user, input, io }) {
    // Returns the existing success payload without the HTTP `success` envelope.
}

module.exports = { markTablePrinted };
```

`backend/modules/tables/saveTableOrder.js` produces:

```js
async function saveTableOrder({
    user,
    input,
    io,
    auditManagerId = null,
    ipAddress = null,
    printKitchenOrder
}) {
    // Returns the existing success payload without the HTTP `success` envelope.
}

module.exports = { saveTableOrder };
```

Both functions own connection acquisition, rollback, and release. They throw on failure. The route owns the final `sendSuccess`/`sendError` call.

---

## Phase 2A - Establish the Missing Baseline and Module Seam

### Task 1: Add normal table-save performance coverage

**Files:**
- Modify: `scripts/benchmark-table-settlement.js`
- Create: `docs/superpowers/evidence/2026-07-22-table-order-save-baseline.md`

**Interfaces:**
- Consumes: existing `measure()` and `summarize()` benchmark helpers.
- Produces: a `tableSave` result with median, p95, median query count, and maximum query count.

- [x] **Step 1: Add the table-save sample bucket**

Change the samples declaration and final output only as follows:

```js
const samples = { tableSave: [], checkout: [], markPrinted: [] };

// In the final JSON object:
tableSave: summarize(samples.tableSave),
checkout: summarize(samples.checkout),
markPrinted: summarize(samples.markPrinted)
```

- [x] **Step 2: Add an admin session and measured fresh-table save loop**

After `seedDatabase()`, log in the seeded admin separately from the existing cashier. Before the checkout loop, add 15 measured saves with this exact request shape:

```js
const adminLogin = await request(app)
    .post('/api/auth/login')
    .send({ user_number: SEED.adminUser.user_number });
const adminCookie = adminLogin.headers['set-cookie'][0];

for (let i = 0; i < 15; i++) {
    let response;
    await measure('tableSave', async () => {
        response = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table2.id,
                cart: [{
                    id: SEED.product1.id,
                    product_id: SEED.product1.id,
                    name: SEED.product1.name,
                    qty: 1,
                    price: 5,
                    note: ''
                }],
                subtotal: 5,
                tax: 0.8,
                total: 5.8
            });
        return response;
    });

    const invoiceId = response.body.invoice_id;
    await pool.query(
        "UPDATE restaurant_tables SET status='available', current_order_id=NULL, parent_table_id=NULL WHERE id=?",
        [SEED.table2.id]
    );
    await pool.query('DELETE FROM order_items WHERE invoice_id=?', [invoiceId]);
    await pool.query('DELETE FROM orders WHERE invoice_id=?', [invoiceId]);
}
```

Cleanup is outside `measure()`, so its queries do not pollute the sample. The seeded test setting has stock disabled; do not change application settings for the benchmark.

- [x] **Step 3: Run the benchmark before production changes**

```powershell
node scripts/benchmark-table-settlement.js
```

Expected: exit code 0 and JSON containing `tableSave`, `checkout`, and `markPrinted`.

- [x] **Step 4: Record the exact baseline**

Write the command, commit hash, timestamp, and all three result objects to `docs/superpowers/evidence/2026-07-22-table-order-save-baseline.md`. Do not invent pass thresholds from one local timing run. Query counts are the hard regression signal; timing is comparative evidence.

- [x] **Step 5: Commit the benchmark baseline**

```powershell
git add scripts/benchmark-table-settlement.js docs/superpowers/evidence/2026-07-22-table-order-save-baseline.md
git commit -m "test: baseline table order save performance"
```

---

## Phase 2B - Extract the Smaller Check-Drop Transaction

### Task 2: Specify and extract `mark_printed`

**Files:**
- Create: `backend/tests/unit/tableOrderModuleWiring.test.js`
- Create: `backend/modules/tables/markTablePrinted.js`
- Modify: `backend/routes/pos/tables.js:1261-1342`
- Test: `backend/tests/integration/tables.test.js:3066-3310`

**Interfaces:**
- Consumes: `markTablePrinted({ user, input, io })`.
- Produces: the existing mark-printed response payload and errors.

- [x] **Step 1: Write the failing check-drop boundary test**

```js
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const tablesSource = fs.readFileSync(
    path.resolve(root, 'backend/routes/pos/tables.js'),
    'utf8'
);

describe('table order transaction ownership', () => {
    it('delegates check drop to its table module', () => {
        expect(tablesSource).toContain("require('../../modules/tables/markTablePrinted')");
        expect(tablesSource).toContain('markTablePrinted({');
    });

    it('keeps Express out of the check-drop module', () => {
        const source = fs.readFileSync(
            path.resolve(root, 'backend/modules/tables/markTablePrinted.js'),
            'utf8'
        );
        expect(source).not.toMatch(/\breq\s*\./);
        expect(source).not.toMatch(/\bres\s*\./);
        expect(source).not.toContain("require('express')");
    });
});
```

- [x] **Step 2: Run and verify RED**

```powershell
npx vitest run backend/tests/unit/tableOrderModuleWiring.test.js
```

Expected: FAIL because the check-drop module and delegation do not exist.

- [x] **Step 3: Move only the check-drop transaction**

Move the implementation under `if (data.action === 'mark_printed')` into `markTablePrinted`. Preserve validation, `lockTableSession`, authorization, group update, commit-before-broadcast, rollback, and release. Replace only:

```text
req.user  -> user
req.io    -> io
data      -> input
sendSuccess(res, payload) -> return payload
sendError(...) -> throw the original error after rollback
```

The module may import `pool`, `broadcastTableUpdates`, `canCheckout`, `canCheckoutTable`, and `canEditLocked` from existing concrete owners. Do not copy any helper implementation.

The module catch owns rollback and release, then rethrows. The route branch retains the current deadlock/missing-table mapping and logging from the old catch (`tables.js:1325-1338`). Do not duplicate that translation in the module.

- [x] **Step 4: Delegate the route branch**

```js
if (data.action === 'mark_printed') {
    const result = await markTablePrinted({
        user: req.user,
        input: data,
        io: req.io
    });
    return sendSuccess(res, result);
}
```

Keep the current mark-printed deadlock, missing-table, logging, and HTTP-message translation in the route catch. It is HTTP adapter behavior, not transaction behavior.

- [x] **Step 5: Run focused check-drop tests and verify GREEN**

```powershell
npx vitest run backend/tests/unit/tableOrderModuleWiring.test.js
npx vitest run backend/tests/integration/tables.test.js -t "mark_printed authorization"
node scripts/benchmark-table-settlement.js
```

Expected: boundary and selected integration tests pass. `markPrinted` query counts match the recorded baseline; investigate any increase before continuing.

- [x] **Step 6: Review the small extraction before the main move**

```powershell
git diff --check
rg -n "\b(req|res)\." backend/modules/tables/markTablePrinted.js
```

Expected: no `req`/`res` in the module and no whitespace errors.

- [x] **Step 7: Commit the green slice**

```powershell
git add backend/tests/unit/tableOrderModuleWiring.test.js backend/modules/tables/markTablePrinted.js backend/routes/pos/tables.js
git commit -m "refactor: extract table check drop transaction"
```

---

## Phase 2C - Extract the Normal Table-Save Transaction

### Task 3: Move normal save behind `saveTableOrder`

**Files:**
- Create: `backend/modules/tables/saveTableOrder.js`
- Modify: `backend/routes/pos/tables.js:1344-2172`
- Test: the eight table-order integration files listed in Current Evidence.

**Interfaces:**
- Consumes: the exact `saveTableOrder` signature defined above.
- Produces: unchanged normal save behavior and response data.

- [x] **Step 1: Extend the boundary test and verify RED**

Append these cases to `tableOrderModuleWiring.test.js` using the existing `root` and `tablesSource` constants:

```js
it('delegates normal save to its table module', () => {
    expect(tablesSource).toContain("require('../../modules/tables/saveTableOrder')");
    expect(tablesSource).toContain('saveTableOrder({');
});

it('keeps transaction SQL out of the POST adapter', () => {
    const start = tablesSource.indexOf("router.post('/table_order'");
    const end = tablesSource.indexOf('// DELETE /api/pos/table-draft', start);
    const source = tablesSource.slice(start, end);
    expect(source).not.toContain('beginTransaction()');
    expect(source).not.toContain('INSERT INTO orders');
    expect(source).not.toContain('INSERT INTO order_items');
    expect(source).not.toContain('UPDATE restaurant_tables SET');
});

it('keeps Express out of the normal-save module', () => {
    const source = fs.readFileSync(
        path.resolve(root, 'backend/modules/tables/saveTableOrder.js'),
        'utf8'
    );
    expect(source).not.toMatch(/\breq\s*\./);
    expect(source).not.toMatch(/\bres\s*\./);
    expect(source).not.toContain("require('express')");
});
```

Run:

```powershell
npx vitest run backend/tests/unit/tableOrderModuleWiring.test.js
```

Expected: FAIL because normal save is still route-owned.

- [x] **Step 2: Mechanically move the existing normal-save block**

Move the code beginning with `let conn; let hasTransaction = false;` and ending with its `finally { if (conn) conn.release(); }` into `saveTableOrder`. Do not rewrite SQL or split business rules while moving. Apply only these substitutions:

```text
const data = req.body                  -> const data = input
req.user                               -> user
req.io                                 -> io
req.auditManagerId                     -> auditManagerId
req.ip                                 -> ipAddress
printRouter.printKitchenOrder(req.io, payload)
                                       -> printKitchenOrder(io, payload)
return sendSuccess(res, payload)       -> return payload
return sendError(res, ...)             -> throw the original error
req.originalUrl / req.method in logs   -> '/api/pos/table_order' / 'POST'
```

Keep these ordered regions intact:

1. Acquire connection and begin transaction.
2. Resolve fixed/dynamic table and lock the full table group.
3. Load settings and historical tax context.
4. Reject invalid empty-cart saves.
5. Normalize cart; validate bundles, permissions, subscriptions, Saved Order Lines, prices, and service-charge snapshots.
6. Calculate and assert server totals.
7. Validate owner/edit/reduction policy.
8. Update or create the order, stock, snapshots, table state, order items, bundle children, and audits.
9. Commit.
10. Read display identity, attempt kitchen printing non-fatally, broadcast, invalidate caches, and return response data.

The post-commit kitchen print failure remains logged and non-fatal. Other post-commit failures retain their current response behavior; do not redesign them in this refactor.

The module catch retains connection rollback, rollback-failure logging, and release from the old catch/finally (`tables.js:2124-2139,2170-2172`), then rethrows. The route retains the main failure log and HTTP classification (`tables.js:2140-2169`). This split keeps transaction cleanup with the transaction and HTTP translation with Express.

- [x] **Step 3: Keep the route as the HTTP adapter**

```js
const result = await saveTableOrder({
    user: req.user,
    input: data,
    io: req.io,
    auditManagerId: req.auditManagerId || null,
    ipAddress: req.ip || null,
    printKitchenOrder: printRouter.printKitchenOrder
});
return sendSuccess(res, result);
```

Keep the existing normal-save error classification in the route: explicit `statusCode`, database-error redaction, `Forbidden:` to 403, `Conflict:` to 409, the current validation-message mapping, and `publicCode` forwarding.

- [x] **Step 4: Run the architecture tests and verify GREEN**

```powershell
npx vitest run backend/tests/unit/tableOrderModuleWiring.test.js backend/tests/unit/SavedOrderLines.test.js backend/tests/unit/savedOrderLinesWiring.test.js
```

Expected: all selected tests pass.

- [x] **Step 5: Run all direct endpoint integration coverage**

```powershell
npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/bundle.tables.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/permissions.test.js backend/tests/integration/openTableNumbers.test.js backend/tests/integration/taxSourceOfTruth.test.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/checkout.test.js
```

Expected: all selected files pass. If a behavior assertion changes, fix the extraction; do not update expected behavior merely to make the refactor green.

- [x] **Step 6: Commit the green slice**

```powershell
git add backend/tests/unit/tableOrderModuleWiring.test.js backend/modules/tables/saveTableOrder.js backend/routes/pos/tables.js
git commit -m "refactor: extract table order save transaction"
```

---

## Phase 2D - Remove Route Debris and Verify the Phase

### Task 4: Prune imports and prove one owner

**Files:**
- Modify: `backend/routes/pos/tables.js`
- Modify only if required by the seam assertion: `backend/tests/unit/tableOrderModuleWiring.test.js`

- [x] **Step 1: Remove only imports made unused by the extraction**

Use `rg` for each imported identifier before deletion. Do not reorder or clean unrelated imports. The route must retain imports used by transfer, join, disjoin, manager, GET, draft, and split endpoints.

- [x] **Step 2: Prove the POST adapter owns no transaction SQL**

```powershell
npx vitest run backend/tests/unit/tableOrderModuleWiring.test.js
rg -n "router.post\('/table_order'|markTablePrinted|saveTableOrder" backend/routes/pos/tables.js
rg -n "\b(req|res)\." backend/modules/tables/markTablePrinted.js backend/modules/tables/saveTableOrder.js
git diff --check
```

Expected: the unit test passes; modules contain no `req`/`res`; whitespace check passes.

- [x] **Step 3: Confirm there is no duplicate implementation**

```powershell
rg -n "INSERT INTO orders|INSERT INTO order_items|bindDraft\(|appendDiscountAuditEvents\(|printKitchenOrder\(" backend/routes/pos/tables.js backend/modules/tables
```

Expected: normal-save transaction markers exist in `saveTableOrder.js`, check-drop writes exist in `markTablePrinted.js`, and the POST adapter contains only the injected print callback reference.

- [x] **Step 4: Commit cleanup**

```powershell
git add backend/routes/pos/tables.js backend/tests/unit/tableOrderModuleWiring.test.js
git commit -m "refactor: thin table order route adapter"
```

### Task 5: Phase 2 verification and handoff record

**Files:**
- Modify: `docs/superpowers/plans/2026-07-22-table-order-save-transaction.md` checkbox statuses only.
- Modify: `docs/superpowers/plans/2026-07-22-pos-architecture-refactor-roadmap.md` Phase 2 status only.
- Modify: `docs/superpowers/evidence/2026-07-22-table-order-save-baseline.md` with post-refactor comparison.

- [x] **Step 1: Run the full suite once for this major extraction**

```powershell
npm run test:unit
```

Expected: zero schema drift and zero failed tests.

- [x] **Step 2: Run the production build once**

```powershell
npm run build
```

Expected: exit code 0 with all Vite entrypoints emitted.

- [x] **Step 3: Run and record the post-refactor benchmark**

```powershell
node scripts/benchmark-table-settlement.js
```

Expected: exit code 0. `tableSave` and `markPrinted` query counts must not increase. Compare timings, but treat normal local timing variance as evidence rather than an automatic failure.

- [x] **Step 4: Inspect final scope**

```powershell
git diff --check
git diff --stat 717f845ab88efdc757619a52df0fb2685ce02383...HEAD
git status --short
```

Expected: only the two table modules, route adapter, boundary test, benchmark/evidence, and plan status files changed. No public route, schema, dependency, or frontend file changed.

- [x] **Step 5: Commit verification records**

```powershell
git add docs/superpowers/plans/2026-07-22-table-order-save-transaction.md docs/superpowers/plans/2026-07-22-pos-architecture-refactor-roadmap.md docs/superpowers/evidence/2026-07-22-table-order-save-baseline.md
git commit -m "docs: record table order extraction verification"
```

## Stop Conditions for a Less-Capable Agent

Stop and request review instead of guessing when any of these occurs:

- Phase 1 commit `717f845a` is not in branch history.
- The live handler anchors no longer match the two transactions described above.
- A move requires changing a SQL statement, response field, error message, permission rule, or transaction order.
- The table-save or mark-printed query count increases.
- An existing integration assertion fails after extraction.
- The module appears to require `req` or `res`.
- The agent proposes a repository, controller layer, dependency container, or helper relocation to finish this phase.

## Self-Review

- **Scope:** only POST table-order actions move; transfer, join, disjoin, table manager, GET, drafts, and splits stay in `tables.js`.
- **Ordering:** the small check-drop transaction is extracted and reviewed before the much larger normal-save move.
- **Interfaces:** both modules have exact input and output contracts; Express and HTTP response shaping remain outside.
- **Dependency direction:** route-owned printing is injected as one concrete callback; the shared-helper reverse dependency is acknowledged and deferred to Phase 5 instead of hidden.
- **Coverage:** every test file directly posting to the endpoint is named, and the affected normal-save path gains a benchmark before code motion.
- **YAGNI:** no new architectural layer, schema, dependency, or speculative module is introduced.
