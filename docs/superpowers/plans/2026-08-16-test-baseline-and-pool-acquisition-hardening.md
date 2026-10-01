# Test Baseline and Pool Acquisition Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the existing POS regression suite to a trustworthy green baseline and bound database-pool acquisition waits without changing checkout accounting, print rendering, business rules, schema, or ordinary successful database work.

**Architecture:** The 26 failures are repaired only at their stale test/golden boundaries; production money, printing, remittance, split, and frontend module behavior stays unchanged. Queued database acquisition is bounded once at the callback-based mysql2 core pool before exposing its documented Promise API, so `query`, `execute`, and explicit transactions share the same guard while connection establishment and running SQL keep their existing mysql2 behavior. A timed-out queued acquisition remains owned until mysql2 eventually returns it, at which point the wrapper releases it immediately instead of leaking it.

**Tech Stack:** Node.js 24, Express 5, mysql2 3.20.0, MySQL/MariaDB, Vitest 4, Supertest, existing spooler HTML renderer and golden generator.

## Global Constraints

- Do not change production checkout accounting, `ServiceChargeCalculator`, `PosCalculator`, receipt presentation, the spooler renderer, remittance deletion behavior, split behavior, or frontend runtime imports to satisfy stale tests.
- Keep `Service charge changed. Refresh the cart and try again.` as the authoritative 409 guard. Never accept or silently reprice a stale client fee during an ordinary new checkout.
- Regenerate print goldens only with `backend/tests/fixtures/printGoldens/generate.js`. Do not hand-edit 22 generated HTML files.
- The print-golden diff must be fully explained by commit `2eb23cfa`: two shared CSS rules in every document and inline-to-class kitchen quantity/name markup in kitchen documents. Any other change stops execution for review.
- Do not add Vitest state-reset APIs. Test files remain isolated by Vitest's default `isolate: true`; only correct the comments that claim otherwise.
- Do not add a dependency, environment variable, setting, schema migration, table, column, installer/updater change, or production-data operation.
- Use one fixed queued pool-acquisition limit of 10,000 ms. Do not expose another operator knob.
- Apply the acquisition timeout to the callback-based core pool before calling `corePool.promise()`. Do not wrap ~80 call sites and do not use `Promise.race`.
- Start the timeout only when mysql2 emits `enqueue` for that acquisition. Initial connection establishment remains owned and labeled by mysql2's existing `connectTimeout`; the wrapper must never relabel a slow handshake as `DB_POOL_ACQUIRE_TIMEOUT`.
- The timeout covers queued waiting for a pool connection only. It must never cancel or time out a query or transaction after a connection has been acquired.
- A connection delivered after its caller timed out must be released exactly once. A late error must not call the original callback a second time.
- mysql2 provides no public cancellation API for a queued callback. Timed-out callbacks may remain in its private queue until a connection becomes available, but their count stays bounded by the existing `queueLimit: 50`; they must drain by releasing late connections without running abandoned operations.
- Preserve mysql2's existing `connectionLimit`, `queueLimit`, `connectTimeout`, connection events, Promise return shapes, and queue-limit errors.
- Timeout logs contain only the stable code and timeout duration—never SQL, credentials, hostnames, user data, or request bodies.
- Use only the local test database for integration evidence. Never touch production or customer data.
- Preserve the pre-existing modified adversarial review and the catalog-backed priced-note plan. Stage only the files named by the active task.
- Do not deploy, merge, push, migrate, rebuild installers, or alter Hostinger settings in this plan.

---

## Evidence and Decision Record

### The 26 failures are fully classified

Focused execution reproduced exactly 26 failures:

| File | Failures | Proven cause | Runtime change allowed? |
| --- | ---: | --- | --- |
| `backend/tests/unit/printGoldens.test.js` | 22 | Frozen HTML predates renderer commit `2eb23cfa` | No |
| `backend/tests/integration/taxExemptWorkflow.test.js` | 1 | Fixture still submits the former inclusive-accounting fee | No |
| `backend/tests/unit/frontendRuntimePaths.test.js` | 1 | Component scan includes `__tests__` | No |
| `backend/tests/integration/platformRemittanceRoutes.test.js` | 1 | Test expects a code that exists nowhere in production | No |
| `backend/tests/unit/orderSessionBoundaries.test.js` | 1 | Frozen public facade list omits three intentional split APIs | No |

The print-golden diagnosis was attacked by rendering all 22 cases in memory, reversing only the two CSS additions and the two class substitutions from `2eb23cfa`, and comparing them with the frozen files. Residual mismatches: `[]`. Therefore regeneration must not authorize any renderer edit.

The corrected tax-exempt request was exercised through the real Express checkout, database persistence, report, print queue, and refund paths against `.env.test`. The authoritative values are:

```json
{
  "checkout": { "subtotal": 22.17, "tax": 0, "total": 22.17 },
  "goods": { "price_at_sale": 20.15, "price_before_tax_exemption": 20.15 },
  "service_charge": { "price_at_sale": 2.02, "price_before_tax_exemption": null },
  "audit": { "original_total": 25.68, "exempt_total": 22.17, "tax_removed": 3.51, "final_tax": 0 },
  "report_sales_processed": 22.17,
  "receipt_total": 22.17,
  "refund_amount": 22.17
}
```

Direct canonicalization accepted `2.02` and rejected `1.74` with the existing 409. This separates a stale fixture from a product defect and forbids weakening the guard.

### Vitest isolation correction

`vitest.config.mjs` sets sequential execution but does not disable isolation. Vitest 4 defaults `isolate` to `true`; `fileParallelism: false` and `maxWorkers: 1` control scheduling, not module-cache sharing. The checkout limiter incident happened because `checkout.test.js` itself drives hundreds of requests as one actor. It is already handled by the test-only `CHECKOUT_RATE_LIMIT_MAX=9999` override. No cross-file reset framework is justified.

### Pool root cause and prototype evidence

`backend/config/databasePoolOptions.js` configures `waitForConnections: true`, `connectionLimit: 10`, `queueLimit: 50`, and `connectTimeout: 10000`. mysql2 3.20.0's core pool emits `enqueue` immediately before it pushes a waiting callback into `_connectionQueue`; new-connection handshakes and immediate queue-limit failures do not emit it. `connectTimeout` already bounds connection establishment, so the POS timer must begin at `enqueue`, not at entry to `getConnection`.

A naïve `Promise.race` was rejected because it abandons the underlying queued mysql2 request. The selected seam is the documented callback pool:

```text
mysql.createPool(options) -> attach bounded core getConnection -> corePool.promise() -> exported pool
```

The proposed callback wrapper was exercised against a real one-connection test pool:

- a queued query failed with `DB_POOL_ACQUIRE_TIMEOUT` at the injected 60 ms limit;
- before release the pool had one active connection, zero free, and one queued callback;
- after the held connection was released, the late callback released it: one connection, one free, zero queued;
- the next query succeeded;
- an already-running `SELECT SLEEP(0.08)` completed after roughly 100 ms despite a 30 ms queued-acquisition limit;
- the existing queue-limit error remained immediate;
- a simulated handshake lasting beyond the injected acquisition limit received no POS timeout and preserved its underlying `ETIMEDOUT` error;
- a 50-waiter saturation probe produced 50 bounded timeout errors, retained at most the configured 50 internal callbacks while the sole connection was held, drained to zero after release, restored one free connection, and allowed the next query to succeed;
- `query`, `execute`, and explicit `getConnection` all route through the patched core seam.

No design blocker remains. Execution must still prove RED/GREEN and the full-suite gate below before completion is claimed.

---

## Locked File Structure

- Regenerate only the 22 `backend/tests/fixtures/printGoldens/*.html` files from the existing generator.
- Modify `backend/tests/integration/taxExemptWorkflow.test.js` with the measured current-accounting facts.
- Modify `backend/tests/unit/frontendRuntimePaths.test.js`, `backend/tests/integration/platformRemittanceRoutes.test.js`, and `backend/tests/unit/orderSessionBoundaries.test.js` only at their stale expectations.
- Modify comments only in `backend/tests/setup.js` and `vitest.config.mjs`.
- Correct the isolation section in `docs/superpowers/evidence/2026-08-15-pre-existing-issues-triage.md`; do not rewrite the other evidence.
- Create `backend/services/databasePoolAcquireTimeout.js` as the single core-pool attachment.
- Create `backend/tests/unit/databasePoolAcquireTimeout.test.js` for deterministic timer/callback ownership.
- Create `backend/tests/integration/databasePoolAcquireTimeout.test.js` for the real mysql2 queue and running-query boundary.
- Modify `backend/config/db.js` to build the callback pool, attach the timeout, and export its Promise wrapper.
- Modify `docs/architecture.json` for the pool invariant, then regenerate `docs/architecture.html`.

---

### Task 1: Regenerate the 22 Intentionally Stale Print Goldens

**Files:**
- Modify: `backend/tests/fixtures/printGoldens/*.html` (22 generated files)
- Verify only: `backend/tests/fixtures/printGoldens/generate.js`
- Test: `backend/tests/unit/printGoldens.test.js`
- Test: `backend/tests/unit/printTemplateParity.test.js`
- Test: `backend/tests/unit/spoolerPackageContract.test.js`

**Interfaces:**
- Consumes: `renderReceiptDocument(input)` and `renderKitchenDocument(input)` from `pos-spooler-printer/renderDocument.js`.
- Produces: frozen HTML equal to the current renderer output for all IDs in `cases.json`.

- [ ] **Step 1: Reproduce the stale-golden failure**

Run:

```powershell
npx vitest run backend/tests/unit/printGoldens.test.js --reporter=dot
```

Expected: 22 failures and 2 passes. Every receipt diff includes only the two shared kitchen CSS rules; kitchen diffs additionally replace the two inline item columns with `kitchen-item-qty` and `kitchen-item-name` classes.

- [ ] **Step 2: Generate from the existing authority**

Run:

```powershell
node backend/tests/fixtures/printGoldens/generate.js
```

Expected: `generated 22 print goldens` and no change to `cases.json` or `generate.js`.

- [ ] **Step 3: Attack the generated diff before accepting it**

Run:

```powershell
git diff --check -- backend/tests/fixtures/printGoldens
git diff --stat -- backend/tests/fixtures/printGoldens
git diff --word-diff=plain -- backend/tests/fixtures/printGoldens
git diff --ignore-space-at-eol --exit-code -- backend/tests/fixtures/printGoldens/generate.js backend/tests/fixtures/printGoldens/cases.json
```

Required result:

- exactly 22 `.html` files changed;
- every file gains the same two CSS rules;
- only the five kitchen documents replace quantity/name inline styles with the two new classes;
- receipt bodies, kitchen text, amounts, dates, tax presentation, Arabic text, cut behavior, and item order do not change.

The tracked golden files are normalized as LF in Git but are currently CRLF in the Windows worktree (`core.autocrlf=true`). The Node generator writes LF, so Git may print a line-ending normalization warning even when the indexed content change is correct. Do not stop solely for that warning and do not change `.gitattributes` or the generator to silence it. Stop only if the commands above reveal a content change outside the proven renderer diff or any change to `generate.js`/`cases.json`. Do not edit the renderer to make the files look smaller.

- [ ] **Step 4: Verify the print contract**

Run:

```powershell
npx vitest run backend/tests/unit/printGoldens.test.js backend/tests/unit/printTemplateParity.test.js backend/tests/unit/spoolerPackageContract.test.js --reporter=dot
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit only the generated goldens**

```powershell
git add backend/tests/fixtures/printGoldens/*.html
git commit -m "test(print): refresh intentional renderer goldens"
```

---

### Task 2: Align the Tax-Exempt Lifecycle Fixture with Current Sale Accounting

**Files:**
- Modify: `backend/tests/integration/taxExemptWorkflow.test.js`
- Verify only: `backend/services/ServiceChargeCalculator.js`
- Verify only: `backend/modules/checkout/executeCheckout.js`

**Interfaces:**
- Consumes: the existing database-authoritative service-charge canonicalizer and net-plus-tax new-sale invariant.
- Produces: one cross-module integration fixture whose request and all downstream assertions describe the same persisted sale.

- [ ] **Step 1: Reproduce the exact 409**

Run:

```powershell
npx vitest run backend/tests/integration/taxExemptWorkflow.test.js --reporter=verbose
```

Expected: one failure at the expected 200 assertion; actual status 409 and message `Service charge changed. Refresh the cart and try again.`

- [ ] **Step 2: Replace the stale request facts and every coupled assertion**

Apply these exact value changes in the single test:

```js
// Checkout request
{ id: 'FEE_1', qty: 1, price: 2.02, tax_rate: 16, note: 'Auto-Gratuity' }
subtotal: 22.17,
tax: 0,
total: 22.17,
amount_tendered: 22.17,
change_due: 0,

// Checkout and order facts
expect(checkout.body).toMatchObject({ tax_exempt: true, tax: 0, total: 22.17 });
expect(order).toMatchObject({ tax_exempt_at_sale: 1, subtotal: '22.17', tax: '0.00', total: '22.17' });

// Persisted lines
expect(Number(lines[0].price_at_sale)).toBeCloseTo(20.15, 6);
expect(Number(lines[0].price_before_tax_exemption)).toBeCloseTo(20.15, 6);
expect(Number(lines[0].tax_amount)).toBe(0);
expect(Number(lines[1].price_at_sale)).toBe(2.02);
expect(lines[1].price_before_tax_exemption).toBeNull();
expect(Number(lines[1].tax_amount)).toBe(0);

// Audit
expect(JSON.parse(audit.new_value)).toMatchObject({
    original_total: 25.68,
    exempt_total: 22.17,
    tax_removed: 3.51,
    final_tax: 0
});

// Report and receipt
expect(Number(report.body.summary.sales_processed)).toBeCloseTo(22.17, 2);
expect(printPayload.receipt_display_v1).toMatchObject({
    taxExempt: true,
    summary: { taxAmount: 0, taxLabel: '(معفي من الضريبة)', total: 22.17 }
});

// Refund
expect(Number(refund.body.amount_refunded)).toBe(22.17);
expect(refundRow).toMatchObject({
    subtotal_refunded: '22.17',
    tax_refunded: '0.00',
    amount_refunded: '22.17'
});
```

Do not change the product price, modifier price, tax rates, service-charge percentage, receipt setting, JoFotara zero-tax assertions, next normal checkout, or forged-permission rejection.

- [ ] **Step 3: Verify the full cross-module workflow**

Run:

```powershell
npx vitest run backend/tests/integration/taxExemptWorkflow.test.js --reporter=verbose
```

Expected: 1 passed, 0 failed. This one test must reach checkout, persistence, audit, report, reprint, JoFotara XML, refund, the next normal checkout, and forged-exemption rejection.

- [ ] **Step 4: Verify adjacent money authorities**

Run:

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderPricing.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/checkout.test.js backend/tests/integration/refunds.test.js backend/tests/integration/jofotara.test.js --reporter=dot
```

Expected: all selected tests pass. A failure in production money code is not permission to change that code under this task; stop and diagnose it separately.

- [ ] **Step 5: Commit only the corrected fixture**

```powershell
git add backend/tests/integration/taxExemptWorkflow.test.js
git commit -m "test(tax): align exempt service-charge lifecycle fixture"
```

---

### Task 3: Answer the Three Intended Boundary Guards

**Files:**
- Modify: `backend/tests/unit/frontendRuntimePaths.test.js`
- Modify: `backend/tests/integration/platformRemittanceRoutes.test.js`
- Modify: `backend/tests/unit/orderSessionBoundaries.test.js`

**Interfaces:**
- Consumes: current production boundaries and error behavior unchanged.
- Produces: guards that reject real runtime drift without treating tests or reviewed public APIs as defects.

- [ ] **Step 1: Reproduce the three failures together**

Run:

```powershell
npx vitest run backend/tests/unit/frontendRuntimePaths.test.js backend/tests/integration/platformRemittanceRoutes.test.js backend/tests/unit/orderSessionBoundaries.test.js --reporter=dot
```

Expected: exactly three failures.

- [ ] **Step 2: Exclude tests only at the component-runtime assertion**

In `frontendRuntimePaths.test.js`, keep the generic `sourceFiles()` collector unchanged and filter only this assertion's inputs:

```js
const componentFiles = sourceFiles(
  path.join(ROOT, 'src', 'components'),
  path.join(ROOT, 'src', 'admin')
).filter(file => !file.split('/').includes('__tests__'));
```

Do not exclude `__tests__` globally: `sourceConsumers()` intentionally scans test code for deleted old runtime paths.

- [ ] **Step 3: Use the existing generic remittance/history code**

Change both fictional expectations in the same test; production uses the same generic code for the order-history and remittance-history `EXISTS` branches:

```js
expect(blocked.body.code).toBe('ORDER_TYPE_HAS_HISTORY');
expect(remittanceBlocked.body.code).toBe('ORDER_TYPE_HAS_HISTORY');
```

Keep both 409 assertions and both order-history and remittance-history deletion cases unchanged. Do not add `PLATFORM_ORDER_TYPE_HAS_HISTORY` to production.

- [ ] **Step 4: Record the three reviewed public split APIs**

Add these names to `TABLE_KEYS` in sorted position:

```js
'editSplitGroup',
'moveAllItemToSeat',
'splitEditContext',
```

Do not loosen the exact key-set equality and do not remove the APIs from `useTables()`; `TableSplits.vue` and `SplitCheckModal.vue` consume them.

- [ ] **Step 5: Verify the guards**

Run:

```powershell
npx vitest run backend/tests/unit/frontendRuntimePaths.test.js backend/tests/integration/platformRemittanceRoutes.test.js backend/tests/unit/orderSessionBoundaries.test.js --reporter=dot
```

Expected: all selected tests pass, with the exact-key and deletion protections still exercised.

- [ ] **Step 6: Commit the reviewed expectations**

```powershell
git add backend/tests/unit/frontendRuntimePaths.test.js backend/tests/integration/platformRemittanceRoutes.test.js backend/tests/unit/orderSessionBoundaries.test.js
git commit -m "test: align POS boundary guards with reviewed behavior"
```

---

### Task 4: Correct the Vitest Isolation Record Without Adding Reset Machinery

**Files:**
- Modify comments only: `backend/tests/setup.js`
- Modify comments only: `vitest.config.mjs`
- Modify: `docs/superpowers/evidence/2026-08-15-pre-existing-issues-triage.md`

**Interfaces:**
- Consumes: Vitest 4 default file isolation and existing test-only checkout limit override.
- Produces: truthful test-harness documentation; no runtime or test behavior change.

- [ ] **Step 1: Correct `setup.js` comments**

Replace the two-concern header with the one behavior the file actually owns:

```js
// setup.js — runs before each test FILE (not each test).
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.test'), override: true });
// Injects and resets the Socket.IO test double used by integration routes.
// Vitest's default file isolation owns module-cache separation between files.
```

Rename the `Reset Between Tests` section heading to `Reset Socket.IO Mocks Between Tests`. Do not add imports or reset functions.

- [ ] **Step 2: Correct the `vitest.config.mjs` setup comment**

Use:

```js
// Per-test-file setup: inject and reset the Socket.IO route test double.
setupFiles: ['./backend/tests/setup.js'],
```

Do not add an explicit `isolate: true`; the default already provides it and no configuration change is needed.

- [ ] **Step 3: Correct only finding 3 in the evidence report**

Change its verdict to:

```markdown
| 3 | `setup.js` does not reset module state | **The comment is stale; the claimed cross-file contamination is withdrawn.** |
```

Replace Section 3 with a concise record containing these facts:

- `setup.js` resets only the Socket.IO mocks;
- Vitest defaults to isolated test-file environments;
- sequential scheduling does not disable isolation;
- F7 accumulated inside `checkout.test.js`, which sends hundreds of requests as one actor;
- the existing test-only checkout limit override closes F7;
- no module reset API is needed without a reproducible same-file contamination defect.

Remove `setup.js` from the suggested work list except for correcting its comment. Do not change the report's pool or 26-failure evidence.

- [ ] **Step 4: Verify this task is documentation-only**

Run:

```powershell
git diff --check -- backend/tests/setup.js vitest.config.mjs docs/superpowers/evidence/2026-08-15-pre-existing-issues-triage.md
git diff --unified=20 -- backend/tests/setup.js vitest.config.mjs
```

Expected: only comments changed in the two JavaScript configuration files; no executable token changed.

- [ ] **Step 5: Commit the corrected record**

```powershell
git add backend/tests/setup.js vitest.config.mjs docs/superpowers/evidence/2026-08-15-pre-existing-issues-triage.md
git commit -m "docs(test): correct Vitest isolation record"
```

---

### Task 5: Bound Pool Acquisition at the Single Core mysql2 Seam

**Files:**
- Create: `backend/services/databasePoolAcquireTimeout.js`
- Create: `backend/tests/unit/databasePoolAcquireTimeout.test.js`
- Create: `backend/tests/integration/databasePoolAcquireTimeout.test.js`
- Modify: `backend/config/db.js`

**Interfaces:**
- Consumes: callback pool `mysql.createPool(options)` and its documented `.promise()` wrapper.
- Consumes: the core pool's documented `enqueue` event to distinguish a queued waiter from a new-connection handshake.
- Produces: `attachDatabasePoolAcquireTimeout(corePool, { timeoutMs?, logger? })`; stable queued-wait timeout code `DB_POOL_ACQUIRE_TIMEOUT`; default 10,000 ms.

- [ ] **Step 1: Write deterministic unit tests before the helper exists**

Create `backend/tests/unit/databasePoolAcquireTimeout.test.js`:

```js
const { EventEmitter } = require('node:events');
const { attachDatabasePoolAcquireTimeout } = require('../../services/databasePoolAcquireTimeout');

describe('database pool acquire timeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const harness = () => {
        let pending;
        let enqueueNext = false;
        const corePool = new EventEmitter();
        const rawGetConnection = vi.fn(callback => {
            pending = callback;
            if (enqueueNext) {
                enqueueNext = false;
                corePool.emit('enqueue');
            }
        });
        corePool.getConnection = rawGetConnection;
        const logger = { warn: vi.fn() };
        return {
            corePool,
            logger,
            rawGetConnection,
            queueNext: () => { enqueueNext = true; },
            deliver: (...args) => pending(...args)
        };
    };

    it('passes through an acquisition completed before the deadline', () => {
        const h = harness();
        const callback = vi.fn();
        const connection = { release: vi.fn() };
        attachDatabasePoolAcquireTimeout(h.corePool, { timeoutMs: 50, logger: h.logger });

        h.corePool.getConnection(callback);
        h.deliver(null, connection);
        vi.advanceTimersByTime(100);

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith(null, connection);
        expect(connection.release).not.toHaveBeenCalled();
        expect(h.logger.warn).not.toHaveBeenCalled();
    });

    it('times out once and releases a connection delivered later', () => {
        const h = harness();
        const callback = vi.fn();
        const connection = { release: vi.fn() };
        attachDatabasePoolAcquireTimeout(h.corePool, { timeoutMs: 50, logger: h.logger });

        h.queueNext();
        h.corePool.getConnection(callback);
        vi.advanceTimersByTime(50);

        expect(callback).toHaveBeenCalledOnce();
        expect(callback.mock.calls[0][0]).toMatchObject({ code: 'DB_POOL_ACQUIRE_TIMEOUT' });
        expect(callback.mock.calls[0][1]).toBeUndefined();
        expect(h.logger.warn).toHaveBeenCalledWith(
            { code: 'DB_POOL_ACQUIRE_TIMEOUT', timeout_ms: 50 },
            'Database pool acquisition timed out.'
        );

        h.deliver(null, connection);
        expect(callback).toHaveBeenCalledOnce();
        expect(connection.release).toHaveBeenCalledOnce();
    });

    it('does not relabel a slow connection handshake and attaches only once', () => {
        const h = harness();
        const callback = vi.fn();
        const first = attachDatabasePoolAcquireTimeout(h.corePool, { timeoutMs: 50, logger: h.logger });
        const second = attachDatabasePoolAcquireTimeout(h.corePool, { timeoutMs: 50, logger: h.logger });
        const connectionError = Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });

        h.corePool.getConnection(callback);
        vi.advanceTimersByTime(100);

        expect(callback).not.toHaveBeenCalled();
        expect(h.logger.warn).not.toHaveBeenCalled();

        h.deliver(connectionError);

        expect(second).toBe(first);
        expect(h.rawGetConnection).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith(connectionError, undefined);
        expect(h.logger.warn).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run the unit test RED**

Run:

```powershell
npx vitest run backend/tests/unit/databasePoolAcquireTimeout.test.js --reporter=verbose
```

Expected: fail because `backend/services/databasePoolAcquireTimeout.js` does not exist.

- [ ] **Step 3: Implement the minimal callback-owner wrapper**

Create `backend/services/databasePoolAcquireTimeout.js`:

```js
const ATTACHMENT = Symbol.for('posapp.databasePoolAcquireTimeout');
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;

function attachDatabasePoolAcquireTimeout(corePool, {
    timeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
    logger
} = {}) {
    if (
        !corePool
        || typeof corePool.getConnection !== 'function'
        || typeof corePool.once !== 'function'
        || typeof corePool.removeListener !== 'function'
    ) {
        throw new Error('A callback-based mysql2 pool is required.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error('Database pool acquisition timeout must be a positive integer.');
    }
    if (corePool[ATTACHMENT]) return corePool[ATTACHMENT];

    const rawGetConnection = corePool.getConnection.bind(corePool);
    corePool.getConnection = function getConnectionWithTimeout(callback) {
        let settled = false;
        let timer;
        const finish = (error, connection) => {
            if (settled) {
                connection?.release();
                return;
            }
            settled = true;
            clearTimeout(timer);
            callback(error, connection);
        };

        const startQueueTimer = () => {
            timer = setTimeout(() => {
                if (settled) return;
                const error = new Error('Database is busy. Try again shortly.');
                error.code = 'DB_POOL_ACQUIRE_TIMEOUT';
                logger?.warn(
                    { code: error.code, timeout_ms: timeoutMs },
                    'Database pool acquisition timed out.'
                );
                finish(error);
            }, timeoutMs);
            timer.unref?.();
        };

        corePool.once('enqueue', startQueueTimer);
        try {
            rawGetConnection(finish);
        } catch (error) {
            finish(error);
        } finally {
            corePool.removeListener('enqueue', startQueueTimer);
        }
    };

    const attachment = Object.freeze({ timeoutMs });
    Object.defineProperty(corePool, ATTACHMENT, { value: attachment });
    return attachment;
}

module.exports = { attachDatabasePoolAcquireTimeout, DEFAULT_ACQUIRE_TIMEOUT_MS };
```

mysql2 emits `enqueue` synchronously inside the matching `getConnection` call before adding that callback to its queue, so the temporary listener cannot attach the timer to a later caller. A new-connection handshake and an immediate queue-limit error do not emit `enqueue`; they retain mysql2's existing `connectTimeout` and error object. Do not expose SQL or the underlying error in the timeout log. Do not inspect or remove mysql2's queued callback through private `_connectionQueue` internals.

- [ ] **Step 4: Run the unit test GREEN**

Run:

```powershell
npx vitest run backend/tests/unit/databasePoolAcquireTimeout.test.js --reporter=verbose
```

Expected: 3 passed, 0 failed.

- [ ] **Step 5: Write the real mysql2 integration boundary**

Create `backend/tests/integration/databasePoolAcquireTimeout.test.js`:

```js
const mysql = require('mysql2');
const { buildDatabasePoolOptions } = require('../../config/databasePoolOptions');
const { attachDatabasePoolAcquireTimeout } = require('../../services/databasePoolAcquireTimeout');

describe('database pool acquire timeout integration', () => {
    it('bounds queued acquisition, releases late delivery, and leaves running SQL alone', async () => {
        const corePool = mysql.createPool({
            ...buildDatabasePoolOptions(process.env),
            connectionLimit: 1,
            maxIdle: 1,
            queueLimit: 2
        });
        attachDatabasePoolAcquireTimeout(corePool, {
            timeoutMs: 40,
            logger: { warn: vi.fn() }
        });
        const testPool = corePool.promise();
        let held;

        try {
            const [slowRows] = await testPool.query('SELECT SLEEP(0.08) AS slept');
            expect(Number(slowRows[0].slept)).toBe(0);

            held = await testPool.getConnection();
            await expect(testPool.execute('SELECT 1'))
                .rejects.toMatchObject({ code: 'DB_POOL_ACQUIRE_TIMEOUT' });

            held.release();
            held = null;
            const [nextRows] = await testPool.query('SELECT 7 AS ok');
            expect(Number(nextRows[0].ok)).toBe(7);
        } finally {
            held?.release();
            await testPool.end();
        }
    });
});
```

The first query intentionally runs longer than the 40 ms queued-acquisition limit. If it times out, the implementation incorrectly covers query execution. The unit handshake test separately proves that no timer starts before `enqueue`. The final query proves the late acquired connection returned to the pool.

- [ ] **Step 6: Run the integration test against the test database**

Run:

```powershell
npx vitest run backend/tests/integration/databasePoolAcquireTimeout.test.js --reporter=verbose
```

Expected: 1 passed, 0 failed. No table or row is created or changed.

- [ ] **Step 7: Attach the guard before the Promise wrapper**

Change the pool construction portion of `backend/config/db.js` to:

```js
const mysql = require('mysql2');
const logger = require('./logger');
const { buildDatabasePoolOptions } = require('./databasePoolOptions');
const { attachDatabasePoolAcquireTimeout } = require('../services/databasePoolAcquireTimeout');
const { attachDatabasePoolTelemetry } = require('../services/databasePoolTelemetry');

// ...existing environment loading and production validation remain unchanged...

const corePool = mysql.createPool(buildDatabasePoolOptions(process.env));
attachDatabasePoolAcquireTimeout(corePool, { logger });
const pool = corePool.promise();
const telemetry = attachDatabasePoolTelemetry(pool, { logger });
```

Keep the existing `pool.on('connection', ...)`, telemetry snapshot property, and export unchanged below this construction block.

- [ ] **Step 8: Verify every public pool path and representative consumers**

Run:

```powershell
npx vitest run backend/tests/unit/databasePoolAcquireTimeout.test.js backend/tests/unit/databasePoolOptions.test.js backend/tests/unit/databasePoolTelemetry.test.js backend/tests/integration/databasePoolAcquireTimeout.test.js backend/tests/integration/loginRateLimitIdentity.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/printQueue.test.js --reporter=dot
```

Expected: all selected tests pass. Confirm test output contains no `DB_POOL_ACQUIRE_TIMEOUT` outside the deliberate saturation test.

- [ ] **Step 9: Commit the bounded acquisition seam**

```powershell
git add backend/services/databasePoolAcquireTimeout.js backend/tests/unit/databasePoolAcquireTimeout.test.js backend/tests/integration/databasePoolAcquireTimeout.test.js backend/config/db.js
git commit -m "fix(db): bound pool acquisition waits"
```

---

### Task 6: Record the Pool Invariant and Run Final Gates

**Files:**
- Modify: `docs/architecture.json`
- Generate: `docs/architecture.html`

**Interfaces:**
- Consumes: the implemented core-pool timeout contract from Task 5.
- Produces: architecture documentation and complete verification evidence.

- [ ] **Step 1: Update the `core-db` architecture node**

Change its `sub` text to state:

```text
One normalized mysql2 callback pool exposed through its Promise API; bounded connections, queue and 10s queued-acquisition wait; connection handshakes retain connectTimeout; timed-out late acquisitions are released; redacted process-local creation telemetry; refuses production boot without DB_USER/PASSWORD/NAME
```

Append this invariant to the single flat `meta.invariants` array (currently 45 strings); do not create a nested database/runtime list:

```text
The database queued-acquisition timeout starts only after mysql2 enqueues a waiter: connection establishment remains bounded by connectTimeout, running SQL is untouched, and a connection delivered after queue timeout is released without running the abandoned operation.
```

- [ ] **Step 2: Generate and verify the architecture view**

Run:

```powershell
npm run architecture
npm run architecture:check
```

Expected: architecture generation and validation pass. Do not edit `docs/architecture.html` manually.

- [ ] **Step 3: Re-run the restored 26-failure baseline as one focused gate**

Run:

```powershell
npx vitest run backend/tests/unit/printGoldens.test.js backend/tests/integration/taxExemptWorkflow.test.js backend/tests/unit/frontendRuntimePaths.test.js backend/tests/integration/platformRemittanceRoutes.test.js backend/tests/unit/orderSessionBoundaries.test.js --reporter=dot
```

Expected: 43 passed, 0 failed.

- [ ] **Step 4: Run the complete Vitest suite because the pool seam is global**

Run:

```powershell
npm run test:unit -- --reporter=dot
```

Expected: zero failed test files and zero failed tests. A failure caused by `DB_POOL_ACQUIRE_TIMEOUT` means the 10-second acquisition bound exposed real suite starvation; diagnose it rather than raising or bypassing the production limit.

- [ ] **Step 5: Build the admin client and run final static checks**

Run:

```powershell
npm run build:admin
git diff --check
git status --short
```

Expected: build passes; no whitespace errors; only planned files or explicitly preserved pre-existing user files are present.

- [ ] **Step 6: Commit architecture only after all gates pass**

```powershell
git add docs/architecture.json docs/architecture.html
git commit -m "docs: record bounded database acquisition"
```

Do not merge, push, deploy, migrate, or build installers.

---

## Adversarial Execution Gate

Before implementation is considered complete, the executor must answer every row with the named evidence. “Code inspection” alone is insufficient where a runnable check is listed.

| Attack | Failure if implemented incorrectly | Required evidence | Status in plan |
| --- | --- | --- | --- |
| Accept stale tax fee | Checkout silently accepts `1.74` | Existing direct canonicalizer still rejects 1.74; corrected lifecycle sends 2.02 | Covered Task 2 |
| Change tax accounting to satisfy fixture | Ordinary sales or receipts regress | No production money file changed in Tasks 1–4; adjacent money suite passes | Covered Task 2 |
| Blind golden refresh hides print drift | Real receipt/kitchen regression is frozen | All 22 diffs match only `2eb23cfa`; parity/package tests pass | Covered Task 1 |
| Scanner exclusion becomes global | Deleted runtime imports in tests become invisible | Filter is applied only to component boundary inputs | Covered Task 3 |
| Platform-specific code is invented | New unused API surface | Production route unchanged; generic stable code asserted | Covered Task 3 |
| Facade guard is weakened | Future accidental exports pass | Exact sorted equality remains; only three named APIs added | Covered Task 3 |
| Reset framework is added for a false premise | More mutable test-only APIs | Comment-only diff; no executable token changes | Covered Task 4 |
| `Promise.race` abandons a waiter | Late connection leaks | Core callback remains owner and releases late delivery | Covered Task 5 unit + integration |
| Timeout kills running SQL | Long transactions fail after 10 seconds | `SELECT SLEEP(0.08)` survives a 40 ms acquire limit | Covered Task 5 integration |
| Slow handshake is relabeled as pool starvation | Operators diagnose the wrong failure and the 10s timers race | Timer starts only on mysql2 `enqueue`; unit test advances past the POS limit before preserving underlying `ETIMEDOUT` | Covered Task 5 unit |
| Timeout callback fires twice | Promise/callback corruption | Fake-timer test asserts one call after late delivery | Covered Task 5 unit |
| Underlying connection error is rewritten | Diagnosis and reconnect semantics regress | Unit test preserves the exact `ETIMEDOUT` object | Covered Task 5 unit |
| Existing queue bound changes | Saturation behavior changes unexpectedly | Pool options unchanged; real queue path tested | Covered Tasks 5–6 |
| Fifty timed-out waiters become fifty leaked connections | Recovery churn exhausts the pool | 50-waiter probe drains the internal queue to zero, leaves one free connection, and the next query succeeds | Proven design evidence; guarded by late-release tests |
| One caller bypasses the fix | Some routes still wait forever | Guard is attached to callback core before `.promise()`; query/execute/getConnection prototype evidence | Covered Task 5 |
| New configuration burden appears | Installer/Hostinger drift | Fixed 10,000 ms constant; no env/template change | Covered globally |
| Global DB seam breaks unrelated routes | Broad production regression | Representative integrations plus full Vitest suite | Covered Task 6 |
| Architecture claims more than code | Future maintainers trust a false guarantee | Architecture generated only after implementation and gates | Covered Task 6 |

### Stop conditions

Stop implementation and report instead of improvising if any of these occur:

- generated print diff contains anything beyond the proven renderer commit;
- corrected tax values differ from the measured facts above;
- a production money/rendering/remittance/split file appears necessary for the 26 failures;
- a running query is interrupted by the acquisition timer;
- an initial connection/handshake failure is returned as `DB_POOL_ACQUIRE_TIMEOUT` instead of its mysql2 error;
- a late connection is not returned to the pool;
- mysql2 Promise return shapes or connection events change after switching construction form;
- any focused or full-suite failure is “fixed” only by increasing/disable-bypassing the timeout;
- any schema, dependency, environment, installer, deployment, or customer-data change appears necessary.

## Plan Self-Review Result

Three review passes were applied:

1. **Scope pass:** separated test-only corrections, comment-only correction, and the one production availability change. No business behavior change is used to make a stale test green.
2. **Hostile lifecycle pass:** rejected `Promise.race`, proved late release, proved a running query outlives the queued-acquisition limit, proved a slow handshake keeps its mysql2 `ETIMEDOUT`, preserved queue errors, and required a full suite because the seam is global.
3. **Executability pass:** every task names exact files, commands, expected results, values, interfaces, commit boundaries, and stop conditions; both remittance assertions and the exact flat `meta.invariants` target are explicit. No migration, dependency, env variable, deployment, or unverified production fact is required.

**Plan state: READY FOR IMPLEMENTATION.** This means the design is closed and experimentally supported. It does not claim the implementation exists or that final tests have passed.
