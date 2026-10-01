# Checkout Transaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the complete paid-checkout transaction behind one transport-independent module while preserving every public URL, middleware, response, lock, authorization, accounting, tax, inventory, subscription, table-settlement, receipt, and idempotency behavior.

**Architecture:** Keep `POST /api/pos/checkout` as a thin Express adapter and introduce `backend/modules/checkout/executeCheckout.js` as the single owner of checkout connection acquisition, transaction state, row locks, pricing, writes, audit events, duplicate recovery, result construction, commit, and post-commit notifications. The adapter retains request parsing, the existing manager-PIN request-context bridge, error logging/classification, and `sendSuccess`/`sendError`; Phase 5, not this phase, relocates shared helpers out of `backend/routes/pos/helpers.js`.

**Tech Stack:** Node.js CommonJS, Express 5, mysql2, Socket.IO, Vitest 4, Supertest, MySQL/MariaDB.

**Execution status:** Completed on `codex/checkout-transaction`; the final reviewed gate passed zero schema drift, 165 test files / 1,739 tests, the production build, and unchanged checkout benchmark query counts of 24/24.

## Global Constraints

- Start from merged `master` at or after `358bf72e`; Phases 1 and 2 are prerequisites.
- Use ponytail at full intensity: one deep module, no controller/service/repository hierarchy, no dependency injection container, and no speculative submodules.
- Do not change `/api/pos/checkout`, `/api/pos/log_drawer_pop`, `requireAuth`, or the checkout rate-limiter mount order in `server.js`.
- Do not change database schema, SQL meaning, lock order, public response shapes, error messages/codes, authentication style, dependencies, frontend code, receipt rules, tax rules, or invoice/order sequencing.
- Do not move `backend/routes/pos/helpers.js` in this phase. Its ownership migration remains Phase 5.
- Do not split pricing, service-charge, bundle, subscription, table-release, or persistence sections into extra modules during this extraction.
- The transaction module must not import or reference Express `req` or `res`.
- Use TDD for the ownership seam and post-commit regression. Run focused tests per task; run the full suite only at the final phase gate.
- Preserve the existing basic-checkout benchmark query count of 24. Local timing is comparative evidence, not a hard threshold.

## Evidence and corrected boundary

- `backend/routes/pos/checkout.js` is 1,509 lines and contains two routes. The checkout handler spans lines 149–1,423; `log_drawer_pop` begins at line 1,426 and stays in the route file.
- Connection acquisition begins at line 198, the SQL transaction begins at line 239, commit occurs at line 1,323, idempotent duplicate-key recovery spans lines 1,367–1,389, and HTTP error translation spans lines 1,391–1,416.
- Direct checkout behavior is covered by 13 integration files: `bundle.checkout.test.js`, `bundle.tables.test.js`, `checkout.test.js`, `openTableNumbers.test.js`, `permissions.test.js`, `reports.test.js`, `security.test.js`, `serviceChargeSnapshots.test.js`, `shift.test.js`, `subscriptionPurchase.test.js`, `subscriptionRedemptions.test.js`, `tables.test.js`, and `taxSourceOfTruth.test.js`.
- Phase 2 recorded the current basic-checkout benchmark at 24 median/max queries.
- `server.js` mounts `checkoutRateLimit` at `/api/pos/checkout` before `posRoutes`; this file does not need modification.
- The roadmap's original `executeCheckout({ user, input, io })` signature omitted request IP and the request-scoped manager override seam. The implementable interface is:

```js
executeCheckout({
    user,
    input,
    io,
    ipAddress,
    authorizeManagerOverride
})
```

- `authorizeManagerOverride(managerPin)` is an adapter callback returning `{ allowed, managerId }`. It delegates to the existing `validateManagerPinOverride(req, managerPin)` only when the current checkout logic requires an override. The callback preserves current lockout/audit behavior and the existing mutation of the same `user` object passed into `executeCheckout`, without leaking Express into the module.

## File ownership

| File | Responsibility after Phase 3 |
|---|---|
| `backend/modules/checkout/executeCheckout.js` | Checkout connection, transaction, locking, pricing, persistence, audit, duplicate recovery, receipt result, commit, and post-commit effects. |
| `backend/routes/pos/checkout.js` | Express parsing, basic request-shape rejection, manager-PIN adapter callback, HTTP success/error translation, and the unchanged drawer-pop route. |
| `backend/tests/unit/checkoutModuleWiring.test.js` | Static ownership and dependency-boundary regression checks. |
| `backend/tests/integration/checkoutPostCommit.test.js` | Isolated post-commit notification failure regression. |
| `scripts/benchmark-table-settlement.js` | Existing query-count benchmark; read/run only. |
| `docs/superpowers/evidence/2026-07-22-checkout-transaction.md` | Baseline commit, focused/full verification, build, schema, and benchmark comparison. |

---

### Task 1: Lock the checkout ownership seam and baseline

**Files:**
- Create: `backend/tests/unit/checkoutModuleWiring.test.js`
- Create: `docs/superpowers/evidence/2026-07-22-checkout-transaction.md`
- Read only: `backend/routes/pos/checkout.js`
- Read only: `server.js`
- Read only: `scripts/benchmark-table-settlement.js`

**Interfaces:**
- Consumes: merged Phase 1 Saved Order Lines and Phase 2 table transaction interfaces.
- Produces: a failing architecture check for `executeCheckout` and a pre-change query-count record.

- [x] **Step 1: Create the boundary test**

```js
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const routePath = path.join(root, 'backend/routes/pos/checkout.js');
const modulePath = path.join(root, 'backend/modules/checkout/executeCheckout.js');
const serverPath = path.join(root, 'server.js');

describe('checkout transaction ownership', () => {
    const routeSource = fs.readFileSync(routePath, 'utf8');
    const checkoutStart = routeSource.indexOf("router.post('/checkout'");
    const drawerStart = routeSource.indexOf("router.post('/log_drawer_pop'");
    const checkoutAdapter = routeSource.slice(checkoutStart, drawerStart);

    it('delegates checkout to the deep transaction module', () => {
        const moduleSource = fs.readFileSync(modulePath, 'utf8');

        expect(routeSource).toContain("require('../../modules/checkout/executeCheckout')");
        expect(checkoutAdapter).toContain('executeCheckout({');
        expect(checkoutAdapter).not.toContain('pool.getConnection');
        expect(checkoutAdapter).not.toMatch(/\bconn\.(?:query|beginTransaction|commit|rollback)\b/);
        expect(checkoutAdapter).not.toContain('buildDuplicateCheckoutResponse');
        expect(moduleSource).not.toMatch(/\b(?:req|res)\b/);
    });

    it('preserves checkout rate limiting before the POS router', () => {
        const serverSource = fs.readFileSync(serverPath, 'utf8');
        const limiter = serverSource.indexOf("app.use('/api/pos/checkout', checkoutRateLimit)");
        const router = serverSource.indexOf("app.use('/api/pos', posRoutes)");

        expect(limiter).toBeGreaterThan(-1);
        expect(router).toBeGreaterThan(limiter);
    });
});
```

- [x] **Step 2: Run the new test and verify RED**

```powershell
npx vitest run backend/tests/unit/checkoutModuleWiring.test.js
```

Expected: FAIL because `backend/modules/checkout/executeCheckout.js` does not exist and the route still owns transaction SQL.

- [x] **Step 3: Record the pre-change baseline**

Run:

```powershell
node scripts/benchmark-table-settlement.js
git rev-parse HEAD
```

Create `docs/superpowers/evidence/2026-07-22-checkout-transaction.md` with the exact commit, command, timestamp, and all `tableSave`, `checkout`, and `markPrinted` results. The checkout hard gate is 24 median/max queries; record actual timings without inventing a timing threshold.

- [x] **Step 4: Commit the red boundary and baseline**

```powershell
git add backend/tests/unit/checkoutModuleWiring.test.js docs/superpowers/evidence/2026-07-22-checkout-transaction.md
git commit -m "test: baseline checkout transaction extraction"
```

---

### Task 2: Extract the checkout transaction mechanically

**Files:**
- Create: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/routes/pos/checkout.js`
- Test: `backend/tests/unit/checkoutModuleWiring.test.js`

**Interfaces:**
- Consumes: `executeCheckout({ user, input, io, ipAddress, authorizeManagerOverride })` and the existing helpers/services imported by the route.
- Produces: the unchanged checkout success payload or the same thrown error fields (`statusCode`, `publicCode`, database error metadata) consumed by the Express adapter.

- [x] **Step 1: Move duplicate-response construction and transaction ownership**

Create `backend/modules/checkout/executeCheckout.js`. Move `buildDuplicateCheckoutResponse` and the checkout lifecycle beginning with edit-invoice locking/connection acquisition through connection release into it. Preserve SQL, query order, comments, lock order, condition order, error messages, public codes, receipt construction, cache invalidation, and notification order.

Use this module shell:

```js
async function executeCheckout({
    user,
    input,
    io,
    ipAddress = null,
    authorizeManagerOverride
}) {
    const data = input;
    const editInvoiceId = data.edit_invoice_id || null;
    let auditManagerId = null;
    let conn;
    let hasTransaction = false;

    const applyManagerOverride = async managerPin => {
        const result = await authorizeManagerOverride(managerPin);
        if (result?.managerId != null) auditManagerId = result.managerId;
        return result?.allowed === true;
    };

    // Existing activeCheckoutLocks, connection, transaction, and checkout body.
}

module.exports = { executeCheckout };
```

Apply only these transport substitutions inside the moved body:

| Old route expression | Module expression |
|---|---|
| `api_user` or `req.user` | `user` |
| `req.io` | `io` |
| `req.ip || null` | `ipAddress` |
| `req.auditManagerId || null` | `auditManagerId` |
| `validateManagerPinOverride(req, data.manager_pin)` | `applyManagerOverride(data.manager_pin)` |
| `return sendSuccess(res, payload)` | `return payload` |
| `return sendError(...)` | throw/preserve the existing error for adapter translation |

The module owns:

- `activeCheckoutLocks` acquisition and release;
- `pool.getConnection()`, `beginTransaction()`, commit/rollback, and connection release;
- both preflight and duplicate-key idempotency recovery through `buildDuplicateCheckoutResponse`;
- all checkout SQL and business decisions;
- post-commit broadcasts and cache invalidation;
- the final plain success object.

Set `hasTransaction = false` immediately after commit. If rollback itself throws, log the rollback failure and rethrow the original checkout error, matching the transaction-safety policy established in Phase 2.

- [x] **Step 2: Replace the route body with the adapter**

Keep the current cart/ID/subscription-object validation and idempotency-key normalization before delegation so their direct 400 responses remain unchanged. Then delegate with this shape:

```js
try {
    const result = await executeCheckout({
        user: req.user,
        input: data,
        io: req.io,
        ipAddress: req.ip || null,
        authorizeManagerOverride: async managerPin => ({
            allowed: await validateManagerPinOverride(req, managerPin),
            managerId: req.auditManagerId || null
        })
    });
    return sendSuccess(res, result);
} catch (e) {
    logger.error({
        err: e,
        route: req.originalUrl,
        method: req.method,
        userId: req.user?.id,
        role: req.user?.role,
        invoiceId: data.edit_invoice_id || null,
        tableId: data.table_id || null,
        shiftId: data.shift_id || null,
        paymentMethod: data.payment_method,
        idempotencyKey: data.idempotency_key || null
    }, 'Checkout failed.');
    let status = e.statusCode || (e.message?.startsWith('Forbidden:') ? 403 : (e.message?.startsWith('Conflict:') ? 409 : 500));
    const isDbError = !!(e.errno || e.sqlState || e.sql || String(e.code || '').startsWith('ER_'));
    if (status === 500 && !isDbError && (
        e.message?.includes('mismatch') ||
        e.message?.includes('required') ||
        e.message?.includes('Forbidden') ||
        e.message?.includes('less than') ||
        e.message?.includes('negative') ||
        e.message?.includes('payment method')
    )) status = 400;
    const msg = (status !== 500 && !isDbError)
        ? e.message
        : 'Checkout failed. Please try again and contact support if the issue persists.';
    return sendError(res, status, msg, e.publicCode || null);
}
```

Do not modify the `log_drawer_pop` handler.

- [x] **Step 3: Run syntax and ownership checks**

```powershell
node --check backend/modules/checkout/executeCheckout.js
node --check backend/routes/pos/checkout.js
npx vitest run backend/tests/unit/checkoutModuleWiring.test.js backend/tests/unit/SavedOrderLines.test.js backend/tests/unit/savedOrderLinesWiring.test.js
```

Expected: all checks pass; the module contains no `req`/`res`, and the adapter contains no transaction SQL.

- [x] **Step 4: Commit the green extraction**

```powershell
git add backend/modules/checkout/executeCheckout.js backend/routes/pos/checkout.js backend/tests/unit/checkoutModuleWiring.test.js
git commit -m "refactor: extract checkout transaction"
```

---

### Task 3: Attack the risky checkout seams

**Files:**
- Create: `backend/tests/integration/checkoutPostCommit.test.js`
- Modify only for extraction defects: `backend/modules/checkout/executeCheckout.js`
- Modify only for adapter defects: `backend/routes/pos/checkout.js`

**Interfaces:**
- Consumes: the extracted endpoint with unchanged HTTP behavior.
- Produces: explicit protection for commit-before-notification behavior plus green authorization, idempotency, concurrency, tax, subscription, bundle, table, and shift flows.

- [x] **Step 1: Add a failing post-commit notification regression**

Create this isolated integration test:

```js
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('checkout post-commit effects', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        const login = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = login.headers['set-cookie'][0];
        await pool.query(
            "UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'"
        );
    });

    afterEach(() => {
        global.__mockEmit__.mockReset();
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('returns success when inventory broadcasting fails after commit', async () => {
        const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        global.__mockEmit__.mockImplementation(event => {
            if (event === 'inventory_changed') throw new Error('socket unavailable');
        });

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 10,
                change_due: 4.2,
                idempotency_key: 'checkout-post-commit-broadcast'
            });

        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);
        const [[order]] = await pool.query(
            'SELECT invoice_id, payment_method FROM orders WHERE invoice_id = ?',
            [response.body.invoice_id]
        );
        expect(order).toMatchObject({ payment_method: 'cash' });
        expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({ invoiceId: order.invoice_id }),
            'Checkout post-commit broadcast failed.'
        );
    });
});
```

- [x] **Step 2: Verify the regression, then correct only extraction defects**

```powershell
npx vitest run backend/tests/integration/checkoutPostCommit.test.js
```

Expected: PASS if commit state and the broadcast guard were moved correctly. If it fails, fix the extracted module without changing endpoint behavior.

- [x] **Step 3: Run the high-risk focused cohorts**

```powershell
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/bundle.checkout.test.js backend/tests/integration/openTableNumbers.test.js backend/tests/integration/permissions.test.js backend/tests/integration/security.test.js
npx vitest run backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/taxSourceOfTruth.test.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/subscriptionRedemptions.test.js
npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/bundle.tables.test.js backend/tests/integration/shift.test.js backend/tests/integration/reports.test.js
```

Expected: all selected files pass. Do not update established assertions merely to make an extraction green.

- [x] **Step 4: Inspect idempotency and transaction cleanup explicitly**

```powershell
rg -n "findOwnedCheckoutAttempt|ER_DUP_ENTRY|buildDuplicateCheckoutResponse|activeCheckoutLocks|beginTransaction|commit\(|rollback\(|release\(" backend/routes/pos/checkout.js backend/modules/checkout/executeCheckout.js
rg -n "\b(req|res)\." backend/modules/checkout/executeCheckout.js
git diff --check
```

Expected: all idempotency and transaction markers are module-owned, the route owns none, the module has no Express request/response access, and whitespace is clean.

- [x] **Step 5: Commit the seam regression**

```powershell
git add backend/tests/integration/checkoutPostCommit.test.js backend/modules/checkout/executeCheckout.js backend/routes/pos/checkout.js
git commit -m "test: protect checkout post-commit success"
```

---

### Task 4: Remove stale route ownership and verify the phase

**Files:**
- Modify: `backend/routes/pos/checkout.js`
- Modify: `docs/superpowers/plans/2026-07-22-pos-architecture-refactor-roadmap.md`
- Modify: `docs/superpowers/evidence/2026-07-22-checkout-transaction.md`

**Interfaces:**
- Consumes: the green extracted module and all focused test evidence.
- Produces: a thin adapter, no duplicate checkout implementation, unchanged performance/query counts, and recorded Phase 3 completion.

- [x] **Step 1: Remove only imports made unused by extraction**

Use `rg` for each candidate identifier before deletion. Preserve `express`, `requireAuth`, `hashPin`, `verifyPin`, drawer-pop dependencies, `sendSuccess`, `sendError`, `logger`, and any helper still used by `log_drawer_pop`. Do not reorder unrelated imports or clean the drawer route.

- [x] **Step 2: Prove there is one checkout implementation**

```powershell
rg -n "INSERT INTO orders|UPDATE orders|INSERT INTO order_items|DELETE FROM order_items|ensurePaidInvoiceNumber|deductStockForCart|createSubscriptionFromPaidOrder" backend/routes/pos/checkout.js backend/modules/checkout
npx vitest run backend/tests/unit/checkoutModuleWiring.test.js
git diff --check
```

Expected: transaction markers exist only in `executeCheckout.js`; the route delegates and retains HTTP/drawer behavior only.

- [x] **Step 3: Run the final phase gate once**

```powershell
npm run test:unit
npm run build
node scripts/benchmark-table-settlement.js
```

Expected: zero schema drift, zero failed tests, successful Vite build, and unchanged checkout median/max query counts of 24. Investigate any query increase before continuing; record timing variance as evidence.

- [x] **Step 4: Record exact evidence and Phase 3 status**

Append the final commit under test, full test file/test counts, build result, schema result, and benchmark JSON to `docs/superpowers/evidence/2026-07-22-checkout-transaction.md`. Update only Phase 3 status in the architecture roadmap; do not mark Phase 4 or Phase 5 started.

- [x] **Step 5: Aggressively review the final branch**

Review `master...HEAD` for:

- missing or reordered SQL/locks;
- altered error status/message/public-code behavior;
- manager-PIN callback invocation timing and audit manager propagation;
- duplicate idempotency response/recovery drift;
- rollback/release and active-lock cleanup on every return/throw;
- post-commit failures incorrectly becoming checkout failures;
- stale route SQL or duplicated response builders;
- changes to `server.js`, schema, dependencies, frontend, helper ownership, or drawer-pop behavior.

Fix concrete defects only, rerun the smallest affected cohort, and reserve another full suite for actual production-code changes made after the final gate.

- [x] **Step 6: Commit verification records**

```powershell
git add backend/routes/pos/checkout.js docs/superpowers/plans/2026-07-22-pos-architecture-refactor-roadmap.md docs/superpowers/evidence/2026-07-22-checkout-transaction.md
git commit -m "docs: record checkout extraction verification"
```

## Self-review result

- Spec coverage: transaction ownership, HTTP boundary, manager override, idempotency, table settlement, bundle integrity, tax, subscription, audit, inventory, receipt response, middleware order, performance, and final evidence all have explicit gates.
- Placeholder scan: no implementation placeholders or undefined follow-up tasks remain.
- Interface consistency: every task uses `executeCheckout({ user, input, io, ipAddress, authorizeManagerOverride })`; the callback consistently returns `{ allowed, managerId }`.
- Scope control: helper relocation, repositories, frontend checkout state, schema work, and drawer-pop refactoring are explicitly deferred.
