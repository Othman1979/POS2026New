# Table Settlement Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every live-table settlement, void, save, guest-check print, join, transfer, split, and realtime update operate on one exact database-owned table session without stale Vue state or extra floor refreshes.

**Architecture:** Add one deep CommonJS service, `TableSettlementContext`, that resolves a requested seat to its canonical root, locks the complete joined group before the order, validates exact invoice ownership, and optionally returns locked money rows plus the bound service snapshot. Existing Express routes keep transaction, permission, audit, print, and socket responsibilities; the Vue Pinia store adds explicit async session ownership, while `useTerminal` returns truthful print outcomes.

**Tech Stack:** Node.js 22-compatible CommonJS, Express 5, MariaDB/MySQL through `mysql2/promise`, Vue 3.5 Composition API, Pinia 2, Vitest 4, Supertest, Vite 6.

## Global Constraints

- Work only in `C:/xampp/htdocs/posapp/.worktrees/table-settlement-context` on `codex/table-settlement-context`.
- Keep `master` unchanged and do not merge without an explicit user request.
- Design contract: `docs/superpowers/specs/2026-07-15-table-settlement-context-design.md` at commit `6ac34c99`.
- Baseline application commit: `18c561ff`.
- No database migration, new table status, dependency upgrade, `npm audit fix`, outbox, event bus, or automatic deadlock retry.
- Direct register checkout, held split settlement, paid refunds, stock accounting, kitchen ticket content, and receipt design retain shipped behavior.
- Saved table price, tax, modifier snapshot, modifier surcharge, line discount, order discount, and bound service charge come from locked database rows.
- Lock order for live-table writes is table group, order, order items, service-charge snapshot.
- Every production change follows RED, GREEN, REFACTOR; integration files run one at a time because they share `posapp_test`.
- Timing results are recorded evidence, not pass/fail thresholds. Deterministic correctness and query-count assertions are the gates.
- No new Vue deep watcher, interval, whole-cart reactive clone, or exported internal session ref.
- User-visible digits and existing currency formatting are unchanged.

---

## File map

| File | Responsibility |
|---|---|
| `backend/services/TableSettlementContext.js` | Canonical table-group resolution, ordered locks, exact live-invoice validation, saved-money reconstruction |
| `backend/tests/integration/tableSettlementContext.test.js` | Direct service contract and group-invariant integration coverage |
| `backend/routes/pos/checkout.js` | Consume context for saved-table settlement; retain direct and split paths |
| `backend/routes/pos/tables.js` | Consume context for save/mark/split writes; harden joins, transfers, discard, read allowance |
| `backend/routes/pos/refunds.js` | Use table-first context for unpaid voids; preserve paid refund path |
| `backend/routes/pos/helpers.js` | Batch realtime payload parity and awaited group broadcast |
| `backend/tests/integration/checkout.test.js` | Cross-table, stored-money, rollback, and checkout race regressions |
| `backend/tests/integration/tables.test.js` | Mark, join, transfer, split-discard, cashier-read, and realtime regressions |
| `backend/tests/integration/refunds.test.js` | Table-first void locking and joined-group refresh regressions |
| `assets/js/composables/stores/orderSessionStore.js` | Vue table-session capture, snapshot request ownership, guest-check status patching |
| `assets/js/composables/useTerminal.js` | Truthful print dispatch and backend busy cleanup |
| `backend/tests/unit/tableSession.logic.test.js` | Leave/switch-during-save and service-snapshot stale-session tests |
| `backend/tests/unit/orderSessionStore.test.js` | Guest-check success/failure, split, mark response, and request-count tests |
| `backend/tests/unit/useTerminal.test.js` | Browser/backend print result contract tests |
| `scripts/benchmark-table-settlement.js` | Test-DB-only query/timing measurement for checkout and mark-printed |
| `docs/superpowers/evidence/2026-07-15-table-settlement-performance.md` | Baseline/final median, p95, query counts, and browser request count |

## Shared interfaces

```js
// backend/services/TableSettlementContext.js
async function lockTableSession(conn, {
    tableId,
    invoiceId,
    withMoney = true
})

function reconcileSavedTableSettlement({ context, submittedItems })

// successful context
{
    requestedTableId,
    rootTable,
    groupTables,
    groupTableIds,
    order,
    savedItems,
    serviceChargeSnapshot
}

// successful reconciliation
{
    items,
    orderDiscount: { type, value },
    hasBoundServiceCharge
}

// every identity/state mismatch
error.statusCode = 409
error.publicCode = 'TABLE_SESSION_CONFLICT'
```

`items` contains top-level saved rows in `sort_order,id` order. Each item uses the checkout shape (`product_id`, `name`, `qty`, `price`, `tax_rate`, `note`, `selectedModifiers`, `modifier_surcharge`, `discountType`, `discountValue`, `order_item_id`). Bundle parents additionally carry `persistedBundleParent` and `persistedBundleChildren`; checkout passes both to the existing `insertPersistedBundleChildren` export from `backend/services/bundleOrderItems.js`. No current bundle catalog is consulted for a saved order.

## Test-fixture contracts

Helper names introduced in test snippets are local functions created in that same test step; they are not assumed to exist. Keep these exact signatures and return shapes so later tasks remain type-consistent:

```js
// tableSettlementContext.test.js
seedJoinedTableOrder(options = {}) => Promise<{
    invoiceId: number,
    snapshotId: string | null,
    productItemId: number,
    childItemId: number | null
}>

// checkout.test.js
seedSavedTable(tableId, options = {}) => Promise<{ invoiceId: number, total: number }>
seedSavedTableWithBoundCharge() => Promise<{ invoiceId: number, total: number, fee: number }>
seedDiscountedSavedTable() => Promise<{ invoiceId: number, total: number }>
snapshotSettlementState(invoiceIds, tableIds) => Promise<{
    orders: object[], items: object[], tables: object[], refunds: object[], audits: object[]
}>
checkoutPayload({ tableId, invoiceId, total, key }) => object
relogin(userNumber) => Promise<string>

// tables.test.js and refunds.test.js
seedJoinedOpenOrder() => Promise<{ invoiceId: number, itemId: number, emptyTableId: number }>
seedCheckoutReadyTable() => Promise<{
    invoiceId: number,
    savePayload: object,
    checkoutPayload: object
}>
tableRows() => Promise<object[]>
tableSavePayload({ invoiceId }) => object
seedHeldTableSplit() => Promise<number>
```

Build these helpers only from existing `seedDatabase`, `SEED`, `createTableOrder`, `openShift`, Supertest calls, and direct deterministic SQL. Every inserted order must use `payment_method='unpaid_table'`, set `orders.table_id` to the root, point the root and child at the same invoice, and return inserted IDs rather than relying on hard-coded auto-increment values.

---

### Task 1: Add repeatable performance and query-count evidence

**Files:**
- Create: `scripts/benchmark-table-settlement.js`
- Create: `docs/superpowers/evidence/2026-07-15-table-settlement-performance.md`

**Interfaces:**
- Produces: stdout JSON `{ checkout: { medianMs, p95Ms, medianQueries, maxQueries }, markPrinted: {...} }`.
- Consumes: only `.env.test`, `posapp_test`, `seedDatabase`, Supertest, and the local Express app.

- [ ] **Step 1: Write the benchmark harness against the test database**

The script must set the test environment before loading `server.js`, wrap both `pool.query` and every borrowed connection's `query`/`execute`, and reset counters after fixture setup. Use 15 iterations so measurements remain quick but p95 is meaningful.

```js
'use strict';

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME || 'posapp_test';
process.env.LOG_LEVEL = 'silent';
process.env.RATE_LIMIT_MAX = '9999';
process.env.CHECKOUT_RATE_LIMIT_MAX = '9999';

const request = require('supertest');
const { performance } = require('node:perf_hooks');
const { app } = require('../server');
const pool = require('../backend/config/db');
const { seedDatabase, SEED } = require('../backend/tests/fixtures/seed');

const samples = { checkout: [], markPrinted: [] };
let queryCount = 0;
const wrapped = Symbol('benchmarkWrapped');
const originalPoolQuery = pool.query.bind(pool);
const originalGetConnection = pool.getConnection.bind(pool);

pool.query = async (...args) => {
    queryCount++;
    return originalPoolQuery(...args);
};
pool.getConnection = async () => {
    const conn = await originalGetConnection();
    if (!conn[wrapped]) {
        const query = conn.query.bind(conn);
        const execute = conn.execute.bind(conn);
        conn.query = async (...args) => { queryCount++; return query(...args); };
        conn.execute = async (...args) => { queryCount++; return execute(...args); };
        conn[wrapped] = true;
    }
    return conn;
};

const percentile = (values, fraction) => {
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
};
const summarize = rows => ({
    medianMs: Number(percentile(rows.map(row => row.ms), 0.5).toFixed(2)),
    p95Ms: Number(percentile(rows.map(row => row.ms), 0.95).toFixed(2)),
    medianQueries: percentile(rows.map(row => row.queries), 0.5),
    maxQueries: Math.max(...rows.map(row => row.queries))
});
const measure = async (bucket, action) => {
    queryCount = 0;
    const start = performance.now();
    const response = await action();
    const ms = performance.now() - start;
    if (response.statusCode !== 200) throw new Error(`${bucket} returned ${response.statusCode}: ${response.text}`);
    samples[bucket].push({ ms, queries: queryCount });
};

async function seedLiveOrder() {
    const [result] = await pool.query(
        `INSERT INTO orders
           (order_id, user_id, waiter_id, table_id, subtotal, tax, total, payment_method)
         VALUES (NULL, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table')`,
        [SEED.waiterUser.id, SEED.waiterUser.id, SEED.table.id]
    );
    await pool.query(
        `INSERT INTO order_items
           (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, sort_order)
         VALUES (?, ?, ?, 1, 5.00, 16.00, 0.80, 0)`,
        [result.insertId, SEED.product1.id, SEED.product1.name]
    );
    await pool.query(
        `UPDATE restaurant_tables
            SET status='occupied', current_order_id=?, parent_table_id=NULL
          WHERE id=?`,
        [result.insertId, SEED.table.id]
    );
    return result.insertId;
}

(async () => {
    await seedDatabase();
    const login = await request(app).post('/api/auth/login')
        .send({ user_number: SEED.cashierUser.user_number });
    const cookie = login.headers['set-cookie'][0];
    await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie)
        .send({ user_id: SEED.cashierUser.id, starting_cash: 50 });
    const [[shift]] = await pool.query(
        `SELECT id FROM shifts WHERE user_id=? AND status='open' LIMIT 1`,
        [SEED.cashierUser.id]
    );

    for (let i = 0; i < 15; i++) {
        const invoiceId = await seedLiveOrder();
        await measure('checkout', () => request(app).post('/api/pos/checkout')
            .set('Cookie', cookie)
            .send({
                edit_invoice_id: invoiceId,
                table_id: SEED.table.id,
                shift_id: shift.id,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: 5, order_item_id: null }],
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 6,
                change_due: 0.2,
                idempotency_key: `benchmark-checkout-${i}`
            }));
    }

    for (let i = 0; i < 15; i++) {
        const invoiceId = await seedLiveOrder();
        await measure('markPrinted', () => request(app).post('/api/pos/table_order')
            .set('Cookie', cookie)
            .send({ action: 'mark_printed', table_id: SEED.table.id, expected_invoice_id: invoiceId }));
    }

    process.stdout.write(JSON.stringify({
        checkout: summarize(samples.checkout),
        markPrinted: summarize(samples.markPrinted)
    }, null, 2) + '\n');
})().finally(async () => pool.end());
```

Create the evidence file with this exact initial structure before running the harness:

```markdown
# Table Settlement Performance Evidence

## Baseline (18c561ff)

- Checkout: pending measurement
- Mark printed: pending measurement
- Guest-check browser requests: 3 (print, mark, forced workspace refresh)

## Final

- Pending implementation and measurement
```

- [ ] **Step 2: Run the harness against baseline behavior**

Run: `node scripts/benchmark-table-settlement.js`

Expected: baseline checkout JSON is printed. Baseline mark-printed may return `200` while ignoring `expected_invoice_id`; record the measured values under `## Baseline (18c561ff)` using `apply_patch`.

- [ ] **Step 3: Commit the harness and baseline evidence**

```powershell
git add scripts/benchmark-table-settlement.js docs/superpowers/evidence/2026-07-15-table-settlement-performance.md
git commit -m "test(tables): capture settlement performance baseline"
```

---

### Task 2: Build the deep TableSettlementContext module

**Files:**
- Create: `backend/services/TableSettlementContext.js`
- Create: `backend/tests/integration/tableSettlementContext.test.js`

**Interfaces:**
- Produces: `lockTableSession(conn, options)` and `reconcileSavedTableSettlement(input)` exactly as declared in Shared interfaces.
- Consumes: `assertOrderItemBundleIntegrity`, `getForUpdate`, and the `SERVICE_NOTE` constant.

- [ ] **Step 1: Write failing direct-service integration tests**

Create deterministic fixtures for a root and child sharing one unpaid order. Cover root lookup, child lookup, sorted group IDs, exact invoice mismatch, inconsistent child invoice, wrong `orders.table_id`, missing order, and stored-money reconstruction.

```js
it('locks a joined child as the canonical root group and returns stored money', async () => {
    const { invoiceId, snapshotId } = await seedJoinedTableOrder({
        withFee: true,
        discountType: 'percent',
        discountValue: 10
    });
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    const context = await lockTableSession(conn, {
        tableId: SEED.table2.id,
        invoiceId,
        withMoney: true
    });
    expect(context.rootTable.id).toBe(SEED.table.id);
    expect(context.groupTableIds).toEqual([SEED.table.id, SEED.table2.id]);
    expect(context.order.invoice_id).toBe(invoiceId);
    expect(context.serviceChargeSnapshot.id).toBe(snapshotId);
    await conn.rollback();
    conn.release();
});

it.each([
    ['request invoice differs from table pointer', async ({ invoiceId }) => invoiceId + 999],
    ['child points at another invoice', async ({ invoiceId }) => {
        await pool.query('UPDATE restaurant_tables SET current_order_id=? WHERE id=?', [invoiceId + 1, SEED.table2.id]);
        return invoiceId;
    }],
    ['order points at another root', async ({ invoiceId }) => {
        await pool.query('UPDATE orders SET table_id=? WHERE invoice_id=?', [SEED.table2.id, invoiceId]);
        return invoiceId;
    }]
])('returns TABLE_SESSION_CONFLICT when %s', async (_label, arrangeInvoice) => {
    const fixture = await seedJoinedTableOrder();
    const invoiceId = await arrangeInvoice(fixture);
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await expect(lockTableSession(conn, { tableId: SEED.table.id, invoiceId }))
        .rejects.toMatchObject({ statusCode: 409, publicCode: 'TABLE_SESSION_CONFLICT' });
    await conn.rollback();
    conn.release();
});

it('rebuilds saved fee, discounts, modifiers and bundle children without trusting submitted money', async () => {
    const fixture = await seedJoinedTableOrder({ withFee: true, withBundle: true, discountType: 'fixed', discountValue: 1 });
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    const context = await lockTableSession(conn, { tableId: SEED.table.id, invoiceId: fixture.invoiceId });
    const submittedItems = context.savedItems
        .filter(row => row.parent_item_id == null && row.note !== 'Auto-Gratuity')
        .map(row => ({
            product_id: row.product_id,
            name: row.item_name,
            note: row.note || '',
            qty: Number(row.quantity),
            price: 0.01
        }));
    const settlement = reconcileSavedTableSettlement({
        context,
        submittedItems
    });
    expect(settlement.orderDiscount).toEqual({ type: 'fixed', value: 1 });
    expect(settlement.hasBoundServiceCharge).toBe(true);
    expect(settlement.items.at(-1).note).toBe('Auto-Gratuity');
    expect(settlement.items.find(item => item.is_bundle).persistedBundleChildren.length).toBeGreaterThan(0);
    await conn.rollback();
    conn.release();
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npx.cmd vitest run backend/tests/integration/tableSettlementContext.test.js --reporter=verbose`

Expected: FAIL because `backend/services/TableSettlementContext.js` does not exist.

- [ ] **Step 3: Implement ordered locking and reconciliation**

Use one non-locking requested-table probe, then one sorted group lock. Revalidate after the lock; never use the probe's business state.

```js
'use strict';

const { assertOrderItemBundleIntegrity } = require('./bundleIntegrity');
const { getForUpdate } = require('./ServiceChargeSnapshotService');
const { SERVICE_NOTE } = require('./ServiceChargeCalculator');

function conflict(message = 'Table session changed. Refresh and try again.') {
    const error = new Error(message);
    error.statusCode = 409;
    error.publicCode = 'TABLE_SESSION_CONFLICT';
    return error;
}

async function lockTableSession(conn, { tableId, invoiceId, withMoney = true }) {
    const requestedTableId = Number(tableId);
    const expectedInvoiceId = Number(invoiceId);
    if (!Number.isSafeInteger(requestedTableId) || requestedTableId <= 0 ||
        !Number.isSafeInteger(expectedInvoiceId) || expectedInvoiceId <= 0) {
        throw conflict();
    }

    const [[probe]] = await conn.query(
        'SELECT id, parent_table_id FROM restaurant_tables WHERE id=? LIMIT 1',
        [requestedTableId]
    );
    if (!probe) throw conflict('Table was not found. Refresh and try again.');
    const rootId = Number(probe.parent_table_id || probe.id);
    const [groupTables] = await conn.query(
        `SELECT id, table_number, status, current_order_id, parent_table_id
           FROM restaurant_tables
          WHERE id=? OR parent_table_id=?
          ORDER BY id
          FOR UPDATE`,
        [rootId, rootId]
    );
    const rootTable = groupTables.find(row => Number(row.id) === rootId);
    const requestedTable = groupTables.find(row => Number(row.id) === requestedTableId);
    const validStatuses = new Set(['occupied', 'printed']);
    if (!rootTable || rootTable.parent_table_id != null || !requestedTable ||
        groupTables.some(row => row.id !== rootId && Number(row.parent_table_id) !== rootId) ||
        groupTables.some(row => Number(row.current_order_id) !== expectedInvoiceId) ||
        groupTables.some(row => !validStatuses.has(row.status) || row.status !== rootTable.status)) {
        throw conflict();
    }

    const [[order]] = await conn.query(
        `SELECT invoice_id, order_id, shift_id, user_id, waiter_id, table_id,
                payment_method, subtotal, tax, total, discount_type, discount_value,
                service_charge_snapshot_id, tax_inclusive_at_sale, created_at
           FROM orders WHERE invoice_id=? FOR UPDATE`,
        [expectedInvoiceId]
    );
    if (!order || order.payment_method !== 'unpaid_table' || Number(order.table_id) !== rootId) {
        throw conflict();
    }

    let savedItems = [];
    let serviceChargeSnapshot = null;
    if (withMoney) {
        [savedItems] = await conn.query(
            `SELECT id, invoice_id, parent_item_id, product_id, item_name, quantity,
                    price_at_sale, tax_rate, tax_amount, note, selected_modifiers,
                    modifier_surcharge, discount_type, discount_value, sort_order, created_at
               FROM order_items WHERE invoice_id=? ORDER BY sort_order,id FOR UPDATE`,
            [expectedInvoiceId]
        );
        assertOrderItemBundleIntegrity(savedItems);
        if (order.service_charge_snapshot_id) {
            serviceChargeSnapshot = await getForUpdate(conn, order.service_charge_snapshot_id);
            if (serviceChargeSnapshot.state !== 'open_order' ||
                serviceChargeSnapshot.holder_type !== 'order' ||
                String(serviceChargeSnapshot.holder_id) !== String(expectedInvoiceId)) {
                throw conflict('Service-charge snapshot changed. Refresh and try again.');
            }
        }
    }

    return {
        requestedTableId,
        rootTable,
        groupTables,
        groupTableIds: groupTables.map(row => Number(row.id)),
        order,
        savedItems,
        serviceChargeSnapshot
    };
}
```

Complete `reconcileSavedTableSettlement` beside it. Aggregate submitted and saved non-fee parent quantities by `product_id + item_name + note`; reject add/remove/quantity mismatch with `403`. Build authoritative parent items from `savedItems`, attach child rows by `parent_item_id`, require exactly one saved fee when a snapshot is bound, and export both functions.

```js
const identityKey = ({ product_id, item_name, name, note }) => product_id == null
    ? `custom:${item_name || name || ''}|${note || ''}`
    : `product:${Number(product_id)}|${note || ''}`;

const changedItems = () => {
    const error = new Error('Items cannot be changed while cashing out. Edit the order on the floor plan first.');
    error.statusCode = 403;
    return error;
};

function reconcileSavedTableSettlement({ context, submittedItems }) {
    const parents = context.savedItems.filter(row => row.parent_item_id == null);
    const savedGoods = parents.filter(row => row.note !== SERVICE_NOTE);
    const submittedGoods = submittedItems.filter(row => row.note !== SERVICE_NOTE);
    const savedQty = new Map();
    const submittedQty = new Map();
    for (const row of savedGoods) {
        const key = identityKey(row);
        savedQty.set(key, (savedQty.get(key) || 0) + Number(row.quantity));
    }
    for (const row of submittedGoods) {
        const key = identityKey(row);
        submittedQty.set(key, (submittedQty.get(key) || 0) + Number(row.qty));
    }
    if (savedQty.size !== submittedQty.size ||
        [...savedQty].some(([key, qty]) => submittedQty.get(key) !== qty)) {
        throw changedItems();
    }

    const feeRows = parents.filter(row => row.note === SERVICE_NOTE);
    const hasBoundServiceCharge = !!context.serviceChargeSnapshot;
    if ((hasBoundServiceCharge && feeRows.length !== 1) || (!hasBoundServiceCharge && feeRows.length > 0)) {
        throw conflict('Service-charge line changed. Refresh and try again.');
    }

    const childrenByParent = new Map();
    for (const row of context.savedItems) {
        if (row.parent_item_id == null) continue;
        const parentId = Number(row.parent_item_id);
        if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
        childrenByParent.get(parentId).push(row);
    }
    const toCheckoutItem = row => {
        const children = childrenByParent.get(Number(row.id)) || [];
        return {
            product_id: row.product_id,
            name: row.item_name,
            qty: Number(row.quantity),
            price: Number(row.price_at_sale),
            tax_rate: Number(row.tax_rate),
            note: row.note || '',
            selectedModifiers: row.selected_modifiers,
            modifier_surcharge: row.modifier_surcharge == null ? null : Number(row.modifier_surcharge),
            discountType: row.discount_type || null,
            discountValue: Number(row.discount_value || 0),
            order_item_id: Number(row.id),
            ...(children.length ? {
                is_bundle: true,
                persistedBundleParent: row,
                persistedBundleChildren: children
            } : {})
        };
    };

    return {
        items: [...savedGoods.map(toCheckoutItem), ...feeRows.map(toCheckoutItem)],
        orderDiscount: {
            type: context.order.discount_type || null,
            value: Number(context.order.discount_value || 0)
        },
        hasBoundServiceCharge
    };
}

module.exports = { lockTableSession, reconcileSavedTableSettlement };
```

- [ ] **Step 4: Run direct-service coverage and existing bundle coverage**

Run: `npx.cmd vitest run backend/tests/integration/tableSettlementContext.test.js backend/tests/unit/bundleIntegrity.test.js --reporter=verbose`

Expected: PASS. The context file must not import Express, the pool singleton, permissions, sockets, or print code.

- [ ] **Step 5: Commit the deep module**

```powershell
git add backend/services/TableSettlementContext.js backend/tests/integration/tableSettlementContext.test.js
git commit -m "feat(tables): add authoritative settlement context"
```

---

### Task 3: Bind saved-table checkout to database-owned money

**Files:**
- Modify: `backend/routes/pos/checkout.js:4-63,156-320,372-839,930-1197,1225-1279`
- Modify: `backend/tests/integration/checkout.test.js`

**Interfaces:**
- Consumes: `lockTableSession` and `reconcileSavedTableSettlement` from Task 2.
- Produces: normal table checkout returns the existing receipt payload while rejecting cross-table identity with `TABLE_SESSION_CONFLICT`.

- [ ] **Step 1: Add failing route regressions**

Add four tests near the existing saved-table settlement cases:

```js
it('rejects a table/invoice cross-bind without mutating either table or order', async () => {
    await openShift();
    const a = await seedSavedTable(SEED.table.id, { total: 5.80 });
    const b = await seedSavedTable(SEED.table2.id, { total: 2.00, productId: SEED.product2.id });
    const before = await snapshotSettlementState([a.invoiceId, b.invoiceId], [SEED.table.id, SEED.table2.id]);
    const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie)
        .send(checkoutPayload({ tableId: SEED.table2.id, invoiceId: a.invoiceId, total: 5.80 }));
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('TABLE_SESSION_CONFLICT');
    expect(await snapshotSettlementState([a.invoiceId, b.invoiceId], [SEED.table.id, SEED.table2.id])).toEqual(before);
});

it('restores an omitted bound service line and settles at the saved total', async () => {
    await openShift();
    const saved = await seedSavedTableWithBoundCharge();
    const payload = checkoutPayload({ tableId: SEED.table.id, invoiceId: saved.invoiceId, total: saved.total });
    payload.cart = payload.cart.filter(item => item.note !== 'Auto-Gratuity');
    const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(payload);
    expect(res.statusCode).toBe(200);
    expect(Number(res.body.total)).toBe(saved.total);
    const [[fee]] = await pool.query("SELECT price_at_sale FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [saved.invoiceId]);
    expect(Number(fee.price_at_sale)).toBe(saved.fee);
});

it('preserves stored line and order discounts without a new cashier discount grant', async () => {
    await openShift();
    await pool.query("DELETE FROM user_permissions WHERE user_id=? AND perm_key='pos.discount'", [SEED.cashierUser.id]);
    invalidateUserSessions(SEED.cashierUser.id);
    cashierCookie = await relogin(SEED.cashierUser.user_number);
    const saved = await seedDiscountedSavedTable();
    const payload = checkoutPayload({ tableId: SEED.table.id, invoiceId: saved.invoiceId, total: saved.total });
    delete payload.order_discount_type;
    delete payload.order_discount_value;
    payload.cart = payload.cart.map(item => ({ ...item, discountType: null, discountValue: 0 }));
    const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(payload);
    expect(res.statusCode).toBe(200);
    expect(Number(res.body.total)).toBe(saved.total);
});

it('rolls back before releasing a connection when the edit invoice vanished', async () => {
    await openShift();
    const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie)
        .send(checkoutPayload({ tableId: SEED.table.id, invoiceId: 999999, total: 5.80 }));
    expect([404, 409]).toContain(res.statusCode);
    const conn = await pool.getConnection();
    const [[state]] = await conn.query('SELECT @@in_transaction AS active');
    expect(Number(state.active)).toBe(0);
    conn.release();
});
```

- [ ] **Step 2: Run checkout and verify RED**

Run: `npx.cmd vitest run backend/tests/integration/checkout.test.js --reporter=verbose`

Expected: the new cross-bind, omitted-fee, stored-discount, and transaction-state tests fail on baseline.

- [ ] **Step 3: Replace the saved-table shallow logic with the context**

Hoist the existing lock-derived locals (`originalShiftId`, totals, order ID, snapshot ID, and tax mode) immediately after `beginTransaction`. After the split-local declarations and before the split branch, create `tableContext` only for `edit_invoice_id + table_id` without `split_check_id`. Populate the hoisted locals from `tableContext.order`; do not execute the old order-first `FOR UPDATE` query for this path.

```js
let tableContext = null;
let tableSettlement = null;
const isSavedTableCandidate = !!(editInvoiceId && data.table_id && !data.split_check_id);
if (isSavedTableCandidate) {
    tableContext = await lockTableSession(conn, {
        tableId: data.table_id,
        invoiceId: editInvoiceId,
        withMoney: true
    });
    data.table_id = tableContext.rootTable.id;
    const locked = tableContext.order;
    originalPaymentMethod = locked.payment_method;
    originalShiftId = locked.shift_id;
    originalTotal = Number(locked.total);
    originalSubtotal = Number(locked.subtotal);
    lockedOrderId = locked.order_id;
    boundTableSnapshotId = locked.service_charge_snapshot_id || null;
    taxInclusiveAtSaleFromLock = locked.tax_inclusive_at_sale;
}
```

Normalize the submitted cart for identity/quantity checking, then replace the saved-table cart and order discount with reconciliation output before permission and total calculation:

```js
const submittedItems = normalizeCartItems(data.cart);
let cartItems = submittedItems;
if (tableContext) {
    tableSettlement = reconcileSavedTableSettlement({ context: tableContext, submittedItems });
    cartItems = tableSettlement.items;
    data.order_discount_type = tableSettlement.orderDiscount.type;
    data.order_discount_value = tableSettlement.orderDiscount.value;
}
```

Run discount and service-charge apply permissions only for genuinely new money actions. Preserving the context's stored discount and bound fee is not a new action. A saved-table payload that attempts different money is never applied during settlement; the authoritative context wins and edits remain in the permission-gated table-save flow. Reuse the already locked snapshot and do not require the browser to echo snapshot ID/version. Import `insertPersistedBundleChildren` from `backend/services/bundleOrderItems.js`; when reinserting a saved bundle, pass `parentRow: item.persistedBundleParent`, `childRows: item.persistedBundleChildren`, and the unchanged saved parent quantity. Release exactly `tableContext.groupTableIds`; remove the ghost-order branch from normal context settlement because exact binding proves `old_table_order_id === invoice_id`.

Replace the missing-order response inside the transaction with a thrown typed error. Set `hasTransaction = false` immediately after successful commit. Await one `broadcastTableUpdates` call in a post-commit `try/catch`; a socket failure is logged and never changes the successful HTTP result.

- [ ] **Step 4: Run checkout GREEN and inspect transaction state**

Run: `npx.cmd vitest run backend/tests/integration/checkout.test.js --reporter=verbose`

Expected: all checkout tests pass. Confirm the missing-order test reads `@@in_transaction = 0` from the next borrowed connection.

- [ ] **Step 5: Commit exact settlement checkout**

```powershell
git add backend/routes/pos/checkout.js backend/tests/integration/checkout.test.js
git commit -m "fix(tables): bind checkout to saved table state"
```

---

### Task 4: Align table save and unpaid void lock order

**Files:**
- Modify: `backend/routes/pos/tables.js:20-57,1237-1320,1660-1756,1900-1950`
- Modify: `backend/routes/pos/refunds.js:5-19,164-250,471-539,607-611`
- Modify: `backend/routes/pos/helpers.js:136-190,715-716`
- Modify: `backend/tests/integration/refunds.test.js`
- Modify: `backend/tests/integration/tables.test.js`

**Interfaces:**
- Consumes: `lockTableSession`; `broadcastTableUpdates(io, tableIds)`.
- Produces: all unpaid live-table writes lock table group before order/items/snapshot and publish one batch refresh.

- [ ] **Step 1: Add failing lock-order and group-refresh tests**

Instrument borrowed connection queries into an array for one request. Assert the first locking statements for save and void follow the same entity order. Add a partial-void socket test with a joined child.

```js
expect(lockTrace).toEqual(expect.arrayContaining([
    expect.stringMatching(/FROM restaurant_tables[\s\S]+FOR UPDATE/i),
    expect.stringMatching(/FROM orders[\s\S]+FOR UPDATE/i),
    expect.stringMatching(/FROM order_items[\s\S]+FOR UPDATE/i)
]));
expect(lockTrace.findIndex(sql => /restaurant_tables/.test(sql)))
    .toBeLessThan(lockTrace.findIndex(sql => /FROM orders/.test(sql)));

it('partial void broadcasts root and every joined child', async () => {
    const fixture = await seedJoinedOpenOrder();
    global.__mockEmit__.mockClear();
    const res = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
        .send({ intent: 'void', invoice_id: fixture.invoiceId, items: [{ order_item_id: fixture.itemId, qty: 1 }] });
    expect(res.statusCode).toBe(200);
    const ids = global.__mockEmit__.mock.calls.filter(([event]) => event === 'table_update')
        .map(([, payload]) => Number(payload.table.id));
    expect(ids).toEqual(expect.arrayContaining([SEED.table.id, SEED.table2.id]));
});
```

- [ ] **Step 2: Run focused suites and verify RED**

Run serially:

```powershell
npx.cmd vitest run backend/tests/integration/refunds.test.js --reporter=verbose
npx.cmd vitest run backend/tests/integration/tables.test.js --reporter=verbose
```

Expected: lock ordering and joined partial-void broadcast fail.

- [ ] **Step 3: Reuse context in table save and void**

For an existing table order, call context after resolving the requested root and before any `order_items` lock. Reuse `context.order`, `context.savedItems`, `context.groupTableIds`, and `context.serviceChargeSnapshot`; remove the later duplicate order/item reads and remove unused `requiresUpdatePermission`.

For refunds, first perform a non-locking probe of `payment_method,table_id`. If `intent='void'` and the probe is unpaid, call context and use `context.order`. Paid `intent='refund'` retains the order-only lock path. Load `order_items` without joining `products` under `FOR UPDATE`; fetch fallback product names in a separate non-locking query after the item lock.

```js
const [[probe]] = await conn.query(
    'SELECT payment_method, table_id FROM orders WHERE invoice_id=? LIMIT 1',
    [invoiceId]
);
let tableContext = null;
let order;
if (intent === 'void' && probe?.payment_method === 'unpaid_table') {
    tableContext = await lockTableSession(conn, {
        tableId: probe.table_id,
        invoiceId,
        withMoney: true
    });
    order = tableContext.order;
} else {
    [[order]] = await conn.query(
        `SELECT invoice_id, table_id, payment_method, refund_status, shift_id,
                discount_type, discount_value, subtotal, total,
                tax_inclusive_at_sale, service_charge_snapshot_id
           FROM orders WHERE invoice_id=? FOR UPDATE`,
        [invoiceId]
    );
}
```

Set partial and full void update IDs to `tableContext.groupTableIds`. Await `broadcastTableUpdates` once after commit. Change table-save, checkout, split, join, transfer, disjoin, and refund call sites that already know multiple IDs to the batch helper.

Add `o.waiter_id` to both single and batch helper payloads as `waiter_id` so realtime ownership matches `/get_tables`.

Add a concurrent save/checkout test that starts both requests against the same saved invoice and asserts both terminate as either success or `409`, never `500/1213`. After both complete, assert the table is either still bound to the same unpaid order or available with that order paid; reject every mixed state. Repeat the test body five times inside one test to exercise both scheduling orders without creating parallel test workers.

```js
for (let run = 0; run < 5; run++) {
    const fixture = await seedCheckoutReadyTable();
    const [save, checkout] = await Promise.all([
        request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send(fixture.savePayload),
        request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(fixture.checkoutPayload)
    ]);
    expect([200, 409]).toContain(save.statusCode);
    expect([200, 409]).toContain(checkout.statusCode);
    const [[table]] = await pool.query('SELECT status,current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
    const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id=?', [fixture.invoiceId]);
    const stillOpen = order.payment_method === 'unpaid_table' && Number(table.current_order_id) === fixture.invoiceId;
    const settled = order.payment_method !== 'unpaid_table' && table.status === 'available' && table.current_order_id == null;
    expect(stillOpen || settled).toBe(true);
}
```

- [ ] **Step 4: Fix the duplicate permission fixture, then run both suites GREEN**

Change the existing plain grant that duplicates the seeded `waiter.edit_locked` row:

```js
await pool.query(
    "INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'waiter.edit_locked')",
    [SEED.waiterUser.id]
);
```

Run serially:

```powershell
npx.cmd vitest run backend/tests/integration/refunds.test.js --reporter=verbose
npx.cmd vitest run backend/tests/integration/tables.test.js --reporter=verbose
```

Expected: both suites pass; no deadlock error `1213` appears.

- [ ] **Step 5: Commit ordered live-table writes**

```powershell
git add backend/routes/pos/tables.js backend/routes/pos/refunds.js backend/routes/pos/helpers.js backend/tests/integration/refunds.test.js backend/tests/integration/tables.test.js
git commit -m "refactor(tables): align live order lock ordering"
```

---

### Task 5: Make mark-printed atomic and invoice-bound

**Files:**
- Modify: `backend/routes/pos/tables.js:1120-1156`
- Modify: `backend/tests/integration/tables.test.js:2533-2594`

**Interfaces:**
- Consumes: `lockTableSession(conn,{withMoney:false})`.
- Produces: `POST /api/pos/table_order` mark response `{ success, table_ids, status:'printed', invoice_id }`.

- [ ] **Step 1: Write failing mark-state tests**

Update existing success calls to send `expected_invoice_id`. Add missing-ID `400`, stale-ID `409`, joined-group status, and controlled checkout race assertions.

```js
it('rejects a stale expected invoice and leaves the live group red', async () => {
    const invoiceId = await createTableOrder(adminCookie, SEED.table.id, baseCart, 5, 0.8, 5.8);
    const res = await request(app).post('/api/pos/table_order').set('Cookie', cashierCookie)
        .send({ action: 'mark_printed', table_id: SEED.table.id, expected_invoice_id: invoiceId + 1 });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('TABLE_SESSION_CONFLICT');
    const [[table]] = await pool.query('SELECT status,current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
    expect(table).toMatchObject({ status: 'occupied', current_order_id: invoiceId });
});

it('checkout racing mark-printed never leaves printed with a null order', async () => {
    const fixture = await seedCheckoutReadyTable();
    const [mark, checkout] = await Promise.all([
        request(app).post('/api/pos/table_order').set('Cookie', cashierCookie)
            .send({ action: 'mark_printed', table_id: SEED.table.id, expected_invoice_id: fixture.invoiceId }),
        request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(fixture.checkoutPayload)
    ]);
    expect([200, 409]).toContain(mark.statusCode);
    expect([200, 409]).toContain(checkout.statusCode);
    const [[table]] = await pool.query('SELECT status,current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
    expect(table.status === 'printed' && table.current_order_id == null).toBe(false);
});
```

- [ ] **Step 2: Run tables RED**

Run: `npx.cmd vitest run backend/tests/integration/tables.test.js --reporter=verbose`

Expected: stale invoice is accepted or ignored, joined children remain red, and baseline race can produce invalid state.

- [ ] **Step 3: Move mark-printed into one transaction**

Require positive `table_id` and `expected_invoice_id`. Begin a transaction, lock identity context, perform current authorization using `context.order.waiter_id`, update every `context.groupTableIds` row only while it still points at the expected invoice, require `affectedRows === groupTableIds.length`, commit, then batch broadcast.

```js
const context = await lockTableSession(conn, {
    tableId: data.table_id,
    invoiceId: data.expected_invoice_id,
    withMoney: false
});
const [updated] = await conn.query(
    `UPDATE restaurant_tables
        SET status='printed'
      WHERE id IN (?) AND current_order_id=? AND status IN ('occupied','printed')`,
    [context.groupTableIds, context.order.invoice_id]
);
if (updated.affectedRows !== context.groupTableIds.length) {
    const error = new Error('Table changed while marking the guest check.');
    error.statusCode = 409;
    error.publicCode = 'TABLE_SESSION_CONFLICT';
    throw error;
}
```

Translate MySQL/MariaDB deadlock `errno/code 1213/ER_LOCK_DEADLOCK` to `409 TABLE_SESSION_CONFLICT`. Do not retry automatically.

- [ ] **Step 4: Run tables GREEN twice**

Run twice: `npx.cmd vitest run backend/tests/integration/tables.test.js --reporter=dot`

Expected: both runs pass. The race invariant remains true on both runs.

- [ ] **Step 5: Commit atomic check-drop state**

```powershell
git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
git commit -m "fix(tables): bind printed status to live invoice"
```

---

### Task 6: Enforce joined-table structure during join and transfer

**Files:**
- Modify: `backend/routes/pos/tables.js:267-695,697-764`
- Modify: `backend/tests/integration/tables.test.js`

**Interfaces:**
- Produces: normalized unique join IDs, sorted locks, rejected self/missing/cycle shape, and joined-child transfer rejection.
- Preserves: root transfer, swap, and merge behavior already covered by the suite.

- [ ] **Step 1: Add failing structure tests**

```js
it.each([
    ['self join', ids => [SEED.table.id]],
    ['duplicate child', ids => [SEED.table2.id, SEED.table2.id]],
    ['missing child', ids => [999999]]
])('rejects %s without mutation', async (_label, childIds) => {
    const before = await tableRows();
    const res = await request(app).post('/api/pos/tables/join').set('Cookie', adminCookie)
        .send({ parentTableId: SEED.table.id, childTableIds: childIds() });
    expect([400, 404, 409]).toContain(res.statusCode);
    expect(await tableRows()).toEqual(before);
});

it('rejects a cycle-producing join without mutation', async () => {
    await pool.query('UPDATE restaurant_tables SET parent_table_id=? WHERE id=?', [SEED.table2.id, SEED.table.id]);
    const before = await tableRows();
    const res = await request(app).post('/api/pos/tables/join').set('Cookie', adminCookie)
        .send({ parentTableId: SEED.table.id, childTableIds: [SEED.table2.id] });
    expect(res.statusCode).toBe(409);
    expect(await tableRows()).toEqual(before);
});

it('rejects transfer from a joined child without duplicating the order pointer', async () => {
    const fixture = await seedJoinedOpenOrder();
    const res = await request(app).post('/api/pos/tables/transfer').set('Cookie', adminCookie)
        .send({ sourceTableId: SEED.table2.id, targetTableId: fixture.emptyTableId, action: 'transfer' });
    expect(res.statusCode).toBe(409);
    const [[count]] = await pool.query('SELECT COUNT(*) AS c FROM restaurant_tables WHERE current_order_id=?', [fixture.invoiceId]);
    expect(Number(count.c)).toBe(2);
});
```

- [ ] **Step 2: Run tables RED**

Run: `npx.cmd vitest run backend/tests/integration/tables.test.js --reporter=verbose`

Expected: at least self, missing child, cycle, and joined-child transfer tests fail.

- [ ] **Step 3: Normalize and lock all affected tables in one ordered query**

Convert IDs to positive safe integers before opening the transaction. Reject duplicate raw IDs rather than silently dropping them. Reject parent inclusion. Lock parent plus children with `WHERE id IN (...) ORDER BY id FOR UPDATE`; require exact row count. Validate parent is a root, children are standalone or already belong to that exact parent, no child is a parent of the requested root, and occupied children never point elsewhere.

For transfer/swap/merge, include `parent_table_id` in the ordered source/target locks and return `409 TABLE_SESSION_CONFLICT` when either requested ID is a joined child. Preserve existing root behavior and audits. Replace broadcast loops with one awaited batch call.

- [ ] **Step 4: Run tables GREEN**

Run: `npx.cmd vitest run backend/tests/integration/tables.test.js --reporter=verbose`

Expected: new structure tests and all existing transfer/swap/merge/disjoin cases pass.

- [ ] **Step 5: Commit group structure guards**

```powershell
git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
git commit -m "fix(tables): preserve joined group structure"
```

---

### Task 7: Make split discard atomic and allow settle-only table reads

**Files:**
- Modify: `backend/routes/pos/tables.js:1004-1038,2080-2127`
- Modify: `backend/tests/integration/tables.test.js`

**Interfaces:**
- Produces: one-winner split discard and read access for actors with `pos.checkout` or `waiter.checkout` without granting edit actions.

- [ ] **Step 1: Add failing read and discard tests**

```js
it('lets a settle-only cashier load another waiter table but still rejects save', async () => {
    const invoiceId = await createTableOrder(waiterCookie, SEED.table.id, baseCart, 5, 0.8, 5.8);
    const read = await request(app).get(`/api/pos/table_order?order_id=${invoiceId}`).set('Cookie', cashierCookie);
    expect(read.statusCode).toBe(200);
    const save = await request(app).post('/api/pos/table_order').set('Cookie', cashierCookie)
        .send(tableSavePayload({ invoiceId }));
    expect(save.statusCode).toBe(403);
});

it('concurrent split discards produce one success and one audit', async () => {
    const heldId = await seedHeldTableSplit();
    const [a, b] = await Promise.all([
        request(app).delete(`/api/pos/table_splits?id=${heldId}`).set('Cookie', adminCookie),
        request(app).delete(`/api/pos/table_splits?id=${heldId}`).set('Cookie', adminCookie)
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 404]);
    const [[audit]] = await pool.query("SELECT COUNT(*) AS c FROM audit_events WHERE event_type='discard_split_check' AND entity_id=?", [heldId]);
    expect(Number(audit.c)).toBe(1);
});
```

- [ ] **Step 2: Run tables RED**

Run: `npx.cmd vitest run backend/tests/integration/tables.test.js --reporter=verbose`

Expected: settle-only read returns `403`; concurrent discard may report two successes or write a stale audit.

- [ ] **Step 3: Tighten only the affected boundaries**

For GET ownership, allow `canCheckout(req.user) || canCheckoutTable(req.user)` in addition to owner/override. Do not change `canUpdateTable` or POST permissions.

For discard, acquire connection and transaction before reading. Lock the held row, verify `reference_name` starts with `Table `, delete it, require `affectedRows === 1`, insert audit, commit. Return `404` when the locked row is absent. Return `409` if the delete loses ownership. Never write an audit for a loser.

- [ ] **Step 4: Run tables GREEN**

Run: `npx.cmd vitest run backend/tests/integration/tables.test.js --reporter=verbose`

Expected: all assertions pass, including concurrent split discard and settle-only read boundaries.

- [ ] **Step 5: Commit split/read boundary fixes**

```powershell
git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
git commit -m "fix(tables): serialize split discard and settlement reads"
```

---

### Task 8: Own every Vue async continuation by its table session

**Files:**
- Modify: `assets/js/composables/stores/orderSessionStore.js:164-166,317-346,751-819,1096-1192`
- Modify: `backend/tests/unit/tableSession.logic.test.js:295-355`
- Modify: `backend/tests/unit/orderSessionStore.test.js:304-440,1224-1378`

**Interfaces:**
- Produces internal: `captureTableSession()` and `isCurrentTableSession(owner)`.
- Produces request owner: `{ seq, tableId, promise }`; no new public Pinia property.

- [ ] **Step 1: Keep the two existing failing save-race tests and add snapshot ownership tests**

```js
it('does not let table A snapshot populate table B', async () => {
    const s = useOrderSessionStore();
    mockProductsState.settings.value = {
      stock_enabled: '0', tables_enabled: '1', service_charge_enabled: '1',
      auto_apply_service_charge: '1', service_charge_percentage: '8',
      service_charge_tax_rate: '8'
    };
    s.activeTable = { id: 1, table_number: 1, status: 'available', current_order_id: null };
    s.cart = [{ id: 1, product_id: 1, name: 'Burger', price: 10, qty: 1, tax_rate: 0 }];
    let resolveSnapshot;
    let savePosts = 0;
    global.fetch = vi.fn((url, options = {}) => {
      const target = String(url);
      if (target.includes('service_charge_snapshots')) {
        return new Promise(resolve => { resolveSnapshot = resolve; });
      }
      if (target === 'api/pos/table_order' && options.method === 'POST') {
        savePosts++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, order_id: 202, invoice_id: 202, table_id: 2, table_number: 2
        }) });
      }
      if (target.includes('table-draft')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) });
      }
      if (target.includes('table_order?order_id=202')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, invoice_id: 202, cart: [], order_discount_type: null,
          order_discount_value: 0
        }) });
      }
      if (target.includes('get_tables')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, sections: [], tables: [], settings: {}
        }) });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });
    const saveA = s.updateActiveTableOrder();
    s.activeTable = { id: 2, table_number: 2, status: 'available', current_order_id: null };
    s.tableSessionSeq++;
    resolveSnapshot({ ok: true, json: () => Promise.resolve({
      success: true, snapshot: { id: 's81', percentage: 8, taxRate: 8, version: 1 }
    }) });
    await saveA;
    expect(s.serviceChargeSnapshot).toBeNull();
    expect(s.cart.some(item => item.note === 'Auto-Gratuity')).toBe(false);
    expect(savePosts).toBe(0);
});

it('deduplicates only within the same table session', async () => {
    const s = useOrderSessionStore();
    mockProductsState.settings.value = {
      stock_enabled: '0', tables_enabled: '1', service_charge_enabled: '1',
      auto_apply_service_charge: '1', service_charge_percentage: '8',
      service_charge_tax_rate: '8'
    };
    s.activeTable = { id: 1, table_number: 1, status: 'available', current_order_id: null };
    s.cart = [{ id: 1, product_id: 1, name: 'Burger', price: 10, qty: 1, tax_rate: 0 }];
    let snapshotPosts = 0;
    global.fetch = vi.fn((url, options = {}) => {
      const target = String(url);
      if (target.includes('service_charge_snapshots')) {
        snapshotPosts++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, snapshot: { id: 's1', percentage: 8, taxRate: 8, version: 1 }
        }) });
      }
      if (target === 'api/pos/table_order' && options.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, order_id: 101, invoice_id: 101, table_id: 1, table_number: 1
        }) });
      }
      if (target.includes('table-draft')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false }) });
      }
      if (target.includes('table_order?order_id=101')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, invoice_id: 101, cart: [], order_discount_type: null,
          order_discount_value: 0
        }) });
      }
      if (target.includes('get_tables')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, sections: [], tables: [], settings: {}
        }) });
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });
    const a = s.updateActiveTableOrder();
    const b = s.updateActiveTableOrder();
    await Promise.all([a, b]);
    expect(snapshotPosts).toBe(1);
});
```

- [ ] **Step 2: Run Vue tests and verify RED**

Run: `npx.cmd vitest run backend/tests/unit/tableSession.logic.test.js backend/tests/unit/orderSessionStore.test.js --reporter=verbose`

Expected: the existing leave/switch save tests throw at the late `activeTable` read, and new cross-session snapshot test fails.

- [ ] **Step 3: Add capture helpers and owner-aware snapshot request**

```js
const captureTableSession = () => ({
  seq: tableSessionSeq.value,
  tableId: activeTable.value?.id ?? null
});
const isCurrentTableSession = ({ seq, tableId }) => (
  seq === tableSessionSeq.value &&
  String(activeTable.value?.id ?? '') === String(tableId ?? '')
);
```

Replace `serviceChargeSnapshotPromise` with `serviceChargeSnapshotRequest`. For automatic table creation, capture owner before POST, deduplicate only an exact `{seq,tableId}` match, and assign `serviceChargeSnapshot` only when `isCurrentTableSession(owner)`. Its `finally` clears the record only when the record still owns that exact promise. `leaveTableSession` clears the ownership record.

At `updateActiveTableOrder`, capture owner and a shallow table snapshot before `ensureAutoTableServiceCharge`. Check ownership immediately after the await. Build payload identity from the captured table, not `activeTable.value`. Check ownership after every later await before table-scoped mutation.

- [ ] **Step 4: Run Vue tests GREEN**

Run: `npx.cmd vitest run backend/tests/unit/tableSession.logic.test.js backend/tests/unit/orderSessionStore.test.js --reporter=verbose`

Expected: all tests pass; the two baseline failures are green; no Vue warning appears.

- [ ] **Step 5: Commit Vue session ownership**

```powershell
git add assets/js/composables/stores/orderSessionStore.js backend/tests/unit/tableSession.logic.test.js backend/tests/unit/orderSessionStore.test.js
git commit -m "fix(tables): isolate asynchronous table sessions"
```

---

### Task 9: Make guest-check printing truthful and remove the forced refresh

**Files:**
- Modify: `assets/js/composables/useTerminal.js:215-253`
- Modify: `assets/js/composables/stores/orderSessionStore.js:1194-1214,2676-2748`
- Create: `backend/tests/unit/useTerminal.test.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js:974-1019,2070-2117`

**Interfaces:**
- Produces: `dispatchToNodeSpooler(type,payload) -> Promise<{success:boolean,message:string}>`.
- Produces: `printReceipt() -> Promise<boolean>`.
- Produces: `markActiveTablePrinted({ owner, tableId, invoiceId }) -> Promise<boolean>`.

- [ ] **Step 1: Write failing terminal and guest-check tests**

```js
it('returns false and clears backend busy state when spooler rejects', async () => {
    global.fetch = vi.fn().mockResolvedValue(okJson({ success: false, message: 'offline' }));
    const terminal = useTerminal();
    terminal.printMethod.value = 'backend';
    terminal.lastOrder.value = { total: 5 };
    await expect(terminal.printReceipt()).resolves.toBe(false);
    expect(terminal.isPrintingBackend.value).toBe(false);
});

it('returns true after browser print invocation', async () => {
    const terminal = useTerminal();
    terminal.printMethod.value = 'browser';
    terminal.lastOrder.value = { total: 5 };
    window.print = vi.fn();
    await expect(terminal.printReceipt()).resolves.toBe(true);
    expect(window.print).toHaveBeenCalledOnce();
});

it('failed guest-check print never calls mark-printed and keeps the table red', async () => {
    mockTerminalState.printReceipt.mockResolvedValueOnce(false);
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, table_number: 1, status: 'occupied', current_order_id: 101 };
    s.restaurantTables = [{ ...s.activeTable }];
    s.orderTypes = [{ id: 1, name: 'Dine In' }];
    s.selectedOrderType = 1;
    s.cart = [{ id: 1, product_id: 1, name: 'Burger', price: 5, qty: 1, tax_rate: 0 }];
    global.fetch = vi.fn();
    await s.printGuestCheck();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(s.activeTable.status).toBe('occupied');
});

it('successful mark patches local group rows without a workspace GET', async () => {
    mockTerminalState.printReceipt.mockResolvedValueOnce(true);
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, table_number: 1, status: 'occupied', current_order_id: 101 };
    s.restaurantTables = [
      { ...s.activeTable },
      { id: 2, table_number: 2, status: 'occupied', current_order_id: 101, parent_table_id: 1 }
    ];
    s.orderTypes = [{ id: 1, name: 'Dine In' }];
    s.selectedOrderType = 1;
    s.cart = [{ id: 1, product_id: 1, name: 'Burger', price: 5, qty: 1, tax_rate: 0 }];
    global.fetch = vi.fn((url, options = {}) => {
      if (String(url) === 'api/pos/table_order' && options.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          success: true, table_ids: [1, 2], status: 'printed', invoice_id: 101
        }) });
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });
    await s.printGuestCheck();
    expect(s.restaurantTables.filter(t => [1, 2].includes(t.id)).every(t => t.status === 'printed')).toBe(true);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('get_tables'))).toBe(false);
});

it('mark rejection keeps local table state red', async () => {
    mockTerminalState.printReceipt.mockResolvedValueOnce(true);
    const s = useOrderSessionStore();
    s.activeTable = { id: 1, table_number: 1, status: 'occupied', current_order_id: 101 };
    s.restaurantTables = [{ ...s.activeTable }];
    s.cart = [{ id: 1, product_id: 1, name: 'Burger', price: 5, qty: 1, tax_rate: 0 }];
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ success: false, code: 'TABLE_SESSION_CONFLICT' })
    });
    await s.printGuestCheck();
    expect(s.activeTable.status).toBe('occupied');
    expect(s.restaurantTables[0].status).toBe('occupied');
});

it('restored split print never marks a newly seated live table', async () => {
    mockTerminalState.printReceipt.mockResolvedValueOnce(true);
    const s = useOrderSessionStore();
    s.activeTable = {
      id: 77, table_number: 'Table 1 - Seat 1', status: 'occupied',
      current_order_id: 101, is_split: true, split_check_id: 77
    };
    s.cart = [{ id: 1, product_id: 1, name: 'Burger', price: 5, qty: 1, tax_rate: 0 }];
    global.fetch = vi.fn();
    await s.printGuestCheck();
    expect(global.fetch.mock.calls.some(([, init]) => init?.body?.includes('mark_printed'))).toBe(false);
});
```

- [ ] **Step 2: Run terminal/store tests RED**

Run: `npx.cmd vitest run backend/tests/unit/useTerminal.test.js backend/tests/unit/orderSessionStore.test.js --reporter=verbose`

Expected: dispatch/print return `undefined`, rejected print still marks, mark response failure still paints blue, and split print marks a table.

- [ ] **Step 3: Return explicit print outcomes**

```js
const dispatchToNodeSpooler = async (type, payloadData) => {
  try {
    const res = await fetch('api/print/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        print_type: type,
        receipt_printer_id: localPrinterId.value,
        ...payloadData
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      const message = data.message || 'Unknown error. Check printer connection.';
      window.showPosToast?.(`Print failed: ${message}`, 'error');
      return { success: false, message };
    }
    return { success: true, message: data.message || '' };
  } catch (_error) {
    const message = 'Print engine error. Check that the spooler is running and connected.';
    window.showPosToast?.(message, 'error');
    return { success: false, message };
  }
};

const printReceipt = async () => {
  if (!lastOrder.value) return false;
  if (printMethod.value === 'browser') {
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 150));
    document.body.classList.add('printing-thermal-receipt');
    try { window.print(); return true; }
    finally { document.body.classList.remove('printing-thermal-receipt'); }
  }
  isPrintingBackend.value = true;
  try { return (await dispatchToNodeSpooler('receipt', lastOrder.value)).success; }
  finally { isPrintingBackend.value = false; }
};
```

In `printGuestCheck`, await `printReceipt`. On false, restore `lastOrder`, keep red, close no state, and return false. Only a live non-split table with captured current invoice calls `markActiveTablePrinted`. Validate mark HTTP status/body and session ownership; patch returned `table_ids` in `activeTable` and `restaurantTables`; remove `loadTableWorkspace` from successful mark. A mark failure returns false and leaves local red state.

- [ ] **Step 4: Run print tests GREEN and prove request count**

Run: `npx.cmd vitest run backend/tests/unit/useTerminal.test.js backend/tests/unit/orderSessionStore.test.js --reporter=verbose`

Expected: all tests pass. The successful backend guest-check test observes exactly two POSTs after an optional save: print request and mark request, with no `/get_tables` request.

- [ ] **Step 5: Commit truthful guest-check printing**

```powershell
git add assets/js/composables/useTerminal.js assets/js/composables/stores/orderSessionStore.js backend/tests/unit/useTerminal.test.js backend/tests/unit/orderSessionStore.test.js
git commit -m "fix(tables): mark checks printed only after dispatch"
```

---

### Task 10: Measure final performance and verify the complete branch

**Files:**
- Modify: `docs/superpowers/evidence/2026-07-15-table-settlement-performance.md`
- Modify only if verification exposes a regression: files already named in Tasks 2-9, with a new failing test in the owning task's test file before correction.

**Interfaces:**
- Consumes: benchmark harness and all deterministic suites.
- Produces: clean verified feature branch; no merge.

- [ ] **Step 1: Run final benchmark and compare query counts**

Run: `node scripts/benchmark-table-settlement.js`

Expected: JSON prints. Record under `## Final` with the current commit. Saved-table checkout median query count must be less than or equal to baseline. Mark browser flow is documented as two requests instead of three. Timing median and p95 are recorded without a threshold.

- [ ] **Step 2: Run backend suites serially**

```powershell
npx.cmd vitest run backend/tests/integration/tableSettlementContext.test.js --reporter=verbose
npx.cmd vitest run backend/tests/integration/checkout.test.js --reporter=verbose
npx.cmd vitest run backend/tests/integration/refunds.test.js --reporter=verbose
npx.cmd vitest run backend/tests/integration/tables.test.js --reporter=verbose
```

Expected: all pass. Never combine these four commands into parallel processes.

- [ ] **Step 3: Run Vue/print units and static checks**

```powershell
npx.cmd vitest run backend/tests/unit/tableSession.logic.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/useTerminal.test.js backend/tests/unit/receiptPrint.test.js --reporter=verbose
node --check backend/services/TableSettlementContext.js
node --check backend/routes/pos/checkout.js
node --check backend/routes/pos/tables.js
node --check backend/routes/pos/refunds.js
node scripts/validate-schema-drift.js
node pos-spooler-printer/tests/report-html.test.js
npm.cmd run build:admin
git diff --check
```

Expected: all commands exit `0`; schema drift reports zero; admin build parses the Vue ESM files and succeeds; no Vue render warning is emitted by unit execution. Do not use `node --check` on the Vue ESM files because the repository root is CommonJS and Node would reject their valid `import` syntax outside Vite.

- [ ] **Step 4: Review scope and branch isolation**

```powershell
git status --short
git diff 18c561ff...HEAD --stat
git diff 18c561ff...HEAD -- backend/migrations package.json package-lock.json
git -C C:/xampp/htdocs/posapp status --short
git -C C:/xampp/htdocs/posapp branch --show-current
```

Expected: feature worktree has only the evidence edit before the final commit; no migration/dependency diff; root repository is clean on `master`.

- [ ] **Step 5: Commit performance evidence and verification record**

```powershell
git add docs/superpowers/evidence/2026-07-15-table-settlement-performance.md
git commit -m "test(tables): record settlement verification evidence"
git status --short
```

Expected: commit succeeds and final status is empty. Stop on the feature branch and report results; do not merge.
