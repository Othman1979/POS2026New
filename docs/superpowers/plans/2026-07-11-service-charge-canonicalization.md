# Service-Charge Canonicalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all service-charge formula variants with deterministic backend/frontend authorities, freeze percentage and tax per order, preserve snapshots through tables and held-order claims, and conserve fee cents across splits.

**Architecture:** A pure CommonJS backend calculator and mirrored pure-ESM frontend helpers implement raw-base/round-once fee math. A transactional `service_charge_snapshots` state machine freezes rates and owns draft, order, held, claim, split, and finalized lifecycles; routes canonicalize fee lines after authoritative product-price pinning and before total calculation. The server remains financial authority and exact-cent mismatches fail closed.

**Tech Stack:** Node.js/CommonJS, Express, MySQL/InnoDB, Vue 3, Pinia, Vite 6, Vitest 4, Node `crypto`.

## Global Constraints

- Read the approved design first: `docs/superpowers/specs/2026-07-11-service-charge-canonicalization-design.md`.
- POS Calculation Part C must be merged before execution; verify `src/utils/posTotals.js` and backend `stampLineTax` exist on `master`.
- Create a new isolated worktree from updated `master`; suggested branch: `codex/service-charge-canonicalization`.
- Run one Vitest process at a time because integration suites share `posapp_test`.
- Record execution-start test file/test counts; final verification requires zero failures and no missing planned tests, not a hardcoded count.
- Do not execute the production migration until the operational cutoff has removed every open-table and held-order `Auto-Gratuity` line.
- Do not infer snapshots from historical names or rounded fee values.
- Canonical formula: raw line-discounted non-fee base, multiply by frozen percentage, apply `roundMoney` exactly once.
- Never use `toFixed()` as arithmetic input.
- Do not change ordinary product, bundle, modifier, refund, receipt, tax-exempt, or order-discount behavior.
- Preserve the current rule that order discounts reduce the service-charge line proportionally.
- Do not change global `MONEY_TOLERANCE`; service-charge cents use exact equality after canonical rounding.
- Backend canonicalizes after database price pinning and before `calculateExpectedTotals`.
- Stage only files named by the current task; never use `git add -A`.

---

## Execution Preflight

- [ ] **Step 1: Verify the Part C prerequisite**

Run:

```bash
git switch master
git pull --ff-only
test -f src/utils/posTotals.js
rg -n "stampLineTax|resolveTaxRate" backend/services/PosCalculator.js
```

Expected: the file exists and both backend helpers are found. Stop if Part C is not merged.

- [ ] **Step 2: Create the isolated execution worktree**

Run from the main repository:

```bash
git worktree add .worktrees/codex-service-charge-canonicalization -b codex/service-charge-canonicalization master
```

- [ ] **Step 3: Record the baseline**

Run in the new worktree:

```bash
npm install
npx vitest run
npm run build:admin
```

Expected: zero test failures and a successful Vite build. Record `BASELINE_FILES` and `BASELINE_TESTS` in execution notes.

---

## File Structure

**Create:**

- `backend/services/ServiceChargeCalculator.js` — pure backend base, fee, fee-line validation/stamping, and split-cent allocation.
- `backend/services/ServiceChargeSnapshotService.js` — transactional snapshot creation, loading, binding, claiming, token verification, and state transitions.
- `backend/routes/pos/serviceCharges.js` — draft creation and abandonment endpoints only.
- `backend/migrations/2026-07-11-service-charge-snapshots.sql` — snapshot schema and nullable order/held references.
- `backend/migrations/apply-service-charge-snapshots.js` — operational-cutoff preflight followed by migration execution.
- `backend/tests/unit/serviceChargeCalculator.test.js` — backend calculator contract and split conservation.
- `backend/tests/unit/serviceChargeParity.test.js` — backend/frontend differential grid.
- `backend/tests/unit/serviceChargeSnapshotService.test.js` — state and token helper contract with mocked connection.
- `backend/tests/integration/serviceChargeSnapshots.test.js` — endpoint, persistence, concurrency, and lifecycle integration.

**Modify:**

- `src/utils/posTotals.js` — add mirrored `serviceChargeBase` and `serviceChargeFee`.
- `backend/routes/pos.js` — mount the snapshot router.
- `backend/routes/pos/helpers.js` — replace tolerant inline service validation export with calculator boundary; return snapshots from order loading.
- `backend/routes/pos/checkout.js` — direct/final checkout snapshot binding and exact canonicalization.
- `backend/routes/pos/tables.js` — table snapshot persistence/load and split allocation.
- `backend/routes/pos/orders.js` — held creation and claim-state transitions.
- `assets/js/composables/stores/orderSessionStore.js` — snapshot state, asynchronous first add, frozen-rate updates, payload threading, restore/reset.
- `assets/js/composables/useCart.js` — expose snapshot state only if existing consumers require it.
- `src/components/OrderNotes.vue` — thread authoritative claim token/snapshot into restore payload.
- `backend/routes/system.js` — enforce representable percentage/tax precision.
- `backend/tests/fixtures/seed.js` — fixture schema.
- Existing checkout/table/held/store/settings tests — behavior and regression locks.

---

## Task 1: Pure canonical calculation authorities

**Files:**

- Create: `backend/services/ServiceChargeCalculator.js`
- Create: `backend/tests/unit/serviceChargeCalculator.test.js`
- Create: `backend/tests/unit/serviceChargeParity.test.js`
- Modify: `src/utils/posTotals.js`

**Interfaces:**

- Produces backend `serviceChargeBase(items) -> number`.
- Produces backend `serviceChargeFee(items, percentage) -> number`.
- Produces backend `canonicalizeServiceCharge(items, snapshot) -> { items, base, fee, hasFee }`.
- Produces backend `allocateServiceChargeCents(seats, parentFee, percentage) -> number[]`.
- Produces frontend `serviceChargeBase(items) -> number` and `serviceChargeFee(items, percentage) -> number`.
- `snapshot` shape: `{ id, percentage, taxRate }`.

- [ ] **Step 1: Add failing backend calculation tests**

Create `backend/tests/unit/serviceChargeCalculator.test.js` with these exact cases:

```javascript
import { describe, expect, it } from 'vitest';
import calculator from '../../services/ServiceChargeCalculator.js';
const {
    serviceChargeBase,
    serviceChargeFee,
    canonicalizeServiceCharge,
    allocateServiceChargeCents
} = calculator;

describe('ServiceChargeCalculator', () => {
    it('uses raw line-discounted goods and rounds once', () => {
        const items = [{ price: 0.045, qty: 1 }];
        expect(serviceChargeBase(items)).toBe(0.045);
        expect(serviceChargeFee(items, 10)).toBe(0);
    });

    it('excludes fee lines and applies fixed discounts per unit', () => {
        const items = [
            { price: 10, qty: 2, discountType: 'fixed', discountValue: 2 },
            { price: 99, qty: 1, note: 'Auto-Gratuity' }
        ];
        expect(serviceChargeBase(items)).toBe(16);
        expect(serviceChargeFee(items, 12.5)).toBe(2);
    });

    it('rejects malformed and duplicate fee lines', () => {
        const snapshot = { id: 's1', percentage: 10, taxRate: 5 };
        expect(() => canonicalizeServiceCharge([
            { price: 10, qty: 1 },
            { price: 1, qty: 2, note: 'Auto-Gratuity' }
        ], snapshot)).toThrow(/quantity/i);
        expect(() => canonicalizeServiceCharge([
            { price: 10, qty: 1 },
            { price: 1, qty: 1, note: 'Auto-Gratuity' },
            { price: 1, qty: 1, note: 'Auto-Gratuity' }
        ], snapshot)).toThrow(/one service-charge line/i);
    });

    it('returns a server-stamped canonical fee line', () => {
        const snapshot = { id: 's1', percentage: 10, taxRate: 5 };
        const result = canonicalizeServiceCharge([
            { product_id: 1, price: 10, qty: 1 },
            { id: 'FEE_x', price: 1, qty: 1, note: 'Auto-Gratuity', tax_rate: 5 }
        ], snapshot);
        expect(result.fee).toBe(1);
        expect(result.items[1]).toMatchObject({
            product_id: null,
            name: '10% Service Charge',
            note: 'Auto-Gratuity',
            price: 1,
            qty: 1,
            tax_rate: 5,
            discountType: null,
            discountValue: 0
        });
    });

    it('allocates parent cents without gain or loss', () => {
        const cents = allocateServiceChargeCents([
            { items: [{ price: 3.333, qty: 1 }] },
            { items: [{ price: 3.333, qty: 1 }] },
            { items: [{ price: 3.334, qty: 1 }] }
        ], 1, 10);
        expect(cents).toEqual([33, 33, 34]);
        expect(cents.reduce((a, b) => a + b, 0)).toBe(100);
    });
});
```

- [ ] **Step 2: Verify the backend tests fail**

Run:

```bash
npx vitest run backend/tests/unit/serviceChargeCalculator.test.js
```

Expected: FAIL because `ServiceChargeCalculator` does not exist.

- [ ] **Step 3: Implement the backend calculator**

Create `backend/services/ServiceChargeCalculator.js`:

```javascript
const {
    calculateLineTotal,
    roundMoney
} = require('./PosCalculator');

const SERVICE_NOTE = 'Auto-Gratuity';

const badRequest = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
};

const toRate = (value, label) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 100) {
        throw badRequest(`${label} must be between 0 and 100.`);
    }
    return number;
};

const serviceChargeBase = (items = []) => {
    if (!Array.isArray(items)) throw badRequest('Cart items must be an array.');
    return items
        .filter(item => item?.note !== SERVICE_NOTE)
        .reduce((sum, item) => sum + calculateLineTotal(item), 0);
};

const serviceChargeFee = (items, percentage) =>
    roundMoney(serviceChargeBase(items) * (toRate(percentage, 'Service charge percentage') / 100));

const canonicalName = (percentage) =>
    `${Number(percentage).toFixed(4).replace(/\.?0+$/, '')}% Service Charge`;

const canonicalizeServiceCharge = (items, snapshot) => {
    if (!snapshot?.id) throw badRequest('A service-charge snapshot is required.');
    const percentage = toRate(snapshot.percentage, 'Service charge percentage');
    const taxRate = toRate(snapshot.taxRate, 'Service charge tax rate');
    const feeLines = items.filter(item => item?.note === SERVICE_NOTE);
    if (feeLines.length > 1) throw badRequest('Only one service-charge line is allowed.');

    const base = serviceChargeBase(items);
    const fee = serviceChargeFee(items, percentage);
    if (feeLines.length === 0) return { items: [...items], base, fee, hasFee: false };

    const submitted = feeLines[0];
    if (Number(submitted.qty) !== 1) throw badRequest('Service-charge quantity must be 1.');
    if (submitted.product_id != null) throw badRequest('Service charge cannot reference a product.');
    if (submitted.discountType || Number(submitted.discountValue || 0) !== 0) {
        throw badRequest('Service charge cannot have a line discount.');
    }
    if (roundMoney(submitted.price) !== fee) {
        const error = new Error('Service charge changed. Refresh the cart and try again.');
        error.statusCode = 409;
        throw error;
    }
    if (fee === 0) {
        const error = new Error('Service charge is zero. Refresh the cart and try again.');
        error.statusCode = 409;
        throw error;
    }

    const canonicalLine = {
        ...submitted,
        product_id: null,
        name: canonicalName(percentage),
        note: SERVICE_NOTE,
        price: fee,
        qty: 1,
        tax_rate: taxRate,
        discountType: null,
        discountValue: 0
    };
    return {
        items: items.map(item => item === submitted ? canonicalLine : item),
        base,
        fee,
        hasFee: true
    };
};

const allocateServiceChargeCents = (seats, parentFee, percentage) => {
    const target = Math.round(roundMoney(parentFee) * 100);
    const raw = seats.map(seat => serviceChargeBase(seat.items) * (toRate(percentage, 'Service charge percentage') / 100) * 100);
    const cents = raw.map(value => Math.floor(value));
    let remaining = target - cents.reduce((sum, value) => sum + value, 0);
    const order = raw
        .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
        .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let i = 0; i < remaining; i += 1) cents[order[i % order.length].index] += 1;
    if (cents.reduce((sum, value) => sum + value, 0) !== target) {
        throw badRequest('Split service-charge allocation does not conserve the parent fee.');
    }
    return cents;
};

module.exports = {
    SERVICE_NOTE,
    serviceChargeBase,
    serviceChargeFee,
    canonicalizeServiceCharge,
    allocateServiceChargeCents
};
```

- [ ] **Step 4: Add frontend helpers and differential tests**

Append to `src/utils/posTotals.js`:

```javascript
export const serviceChargeBase = (items) => {
    const cart = Array.isArray(items) ? items : [];
    return cart
        .filter(item => item?.note !== 'Auto-Gratuity')
        .reduce((sum, item) => sum + lineNet(item), 0);
};

export const serviceChargeFee = (items, percentage) => {
    const parsed = Number(percentage);
    const rate = Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 0;
    return roundMoney(serviceChargeBase(items) * (rate / 100));
};
```

Create `backend/tests/unit/serviceChargeParity.test.js` with a deterministic grid and seeded mixed carts. It must import backend functions through the CommonJS default and frontend functions through ESM, and assert exact equality:

```javascript
import { describe, expect, it } from 'vitest';
import backend from '../../services/ServiceChargeCalculator.js';
import { serviceChargeBase, serviceChargeFee } from '../../../src/utils/posTotals.js';

const seeded = (seed) => () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
};

describe('service-charge FE/BE parity', () => {
    it('matches deterministic boundary combinations', () => {
        for (const price of [0, 0.001, 0.045, 1.005, 9.999999, 100]) {
            for (const qty of [0.001, 0.25, 1, 3]) {
                for (const percentage of [0, 0.0001, 5, 10, 12.5, 100]) {
                    const items = [{ price, qty, discountType: 'percent', discountValue: 0.5 }];
                    expect(serviceChargeBase(items)).toBe(backend.serviceChargeBase(items));
                    expect(serviceChargeFee(items, percentage)).toBe(backend.serviceChargeFee(items, percentage));
                }
            }
        }
    });

    it('matches 5000 seeded mixed carts', () => {
        const random = seeded(0x5c0ffee);
        for (let run = 0; run < 5000; run += 1) {
            const length = 1 + Math.floor(random() * 8);
            const feeIndex = run % 2 === 0 ? Math.floor(random() * length) : -1;
            const items = Array.from({ length }, (_, index) => ({
                price: [0.001, 0.045, 1.005, 9.99, 100][Math.floor(random() * 5)],
                qty: [0.001, 0.25, 1, 2, 3][Math.floor(random() * 5)],
                discountType: [null, 'fixed', 'percent'][Math.floor(random() * 3)],
                discountValue: [0, 0.01, 0.5, 10, 100][Math.floor(random() * 5)],
                note: index === feeIndex ? 'Auto-Gratuity' : ''
            }));
            const percentage = [0.0001, 5, 10, 12.5, 100][Math.floor(random() * 5)];
            expect(serviceChargeBase(items)).toBe(backend.serviceChargeBase(items));
            expect(serviceChargeFee(items, percentage)).toBe(backend.serviceChargeFee(items, percentage));
        }
    });
});
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run backend/tests/unit/serviceChargeCalculator.test.js backend/tests/unit/serviceChargeParity.test.js backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js
```

Expected: all tests pass with zero parity mismatches.

- [ ] **Step 6: Commit the calculation contract**

```bash
git add backend/services/ServiceChargeCalculator.js backend/tests/unit/serviceChargeCalculator.test.js backend/tests/unit/serviceChargeParity.test.js src/utils/posTotals.js
git commit -m "refactor(pos): define canonical service-charge math"
```

---

## Task 2: Snapshot schema and transactional state service

**Files:**

- Create: `backend/migrations/2026-07-11-service-charge-snapshots.sql`
- Create: `backend/migrations/apply-service-charge-snapshots.js`
- Create: `backend/services/ServiceChargeSnapshotService.js`
- Create: `backend/tests/unit/serviceChargeSnapshotService.test.js`
- Modify: `backend/tests/fixtures/seed.js`

**Interfaces:**

- Produces `createDraft(conn, { userId, percentage, taxRate, now })`.
- Produces `getForUpdate(conn, snapshotId)`.
- Produces `assertDraftUsableBy(snapshot, userId, version)`.
- Produces `bindDraft(conn, { snapshotId, version, userId, state, holderType, holderId })`.
- Produces `transition(conn, { snapshotId, version, from, to, holderType, holderId })`.
- Produces `touchOpenOrder(conn, { snapshotId, version, orderId }) -> newVersion`.
- Produces `claimHeld(conn, { snapshotId, version, heldOrderId }) -> { snapshot, claimToken }`.
- Produces `consumeClaim(conn, { snapshotId, version, claimToken, to, holderType, holderId })`.
- Produces `abandonDraft(conn, { snapshotId, version, userId })`.
- Produces `createChildHeldSnapshot(conn, { parentSnapshot, heldOrderId, userId })`.
- Produces `cleanupExpiredDrafts(conn, now)`.
- Snapshot conflicts expose `error.publicCode` as `SERVICE_CHARGE_SNAPSHOT_EXPIRED` or `SERVICE_CHARGE_SNAPSHOT_CONFLICT`.

- [ ] **Step 1: Add the fixture schema first**

In `backend/tests/fixtures/seed.js`, create `service_charge_snapshots` after `users` and before `orders`, add the two nullable snapshot columns, and include the table in cleanup ordering:

```sql
CREATE TABLE service_charge_snapshots (
  id char(36) NOT NULL,
  percentage decimal(7,4) NOT NULL,
  tax_rate decimal(5,2) NOT NULL,
  parent_snapshot_id char(36) DEFAULT NULL,
  state enum('draft','held','claimed','open_order','split_parent','finalized','abandoned') NOT NULL,
  holder_type enum('none','held_order','claim','order') NOT NULL DEFAULT 'none',
  holder_id varchar(80) DEFAULT NULL,
  claim_token_hash char(64) DEFAULT NULL,
  created_by int(11) NOT NULL,
  version int(11) NOT NULL DEFAULT 1,
  expires_at datetime DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT current_timestamp(),
  updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  KEY idx_scs_state_expires (state, expires_at),
  KEY idx_scs_holder (holder_type, holder_id),
  KEY idx_scs_parent (parent_snapshot_id),
  CONSTRAINT fk_scs_parent FOREIGN KEY (parent_snapshot_id) REFERENCES service_charge_snapshots(id),
  CONSTRAINT fk_scs_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
```

Add `service_charge_snapshot_id char(36) DEFAULT NULL` plus indexes/FKs to `orders` and `held_orders`. Ensure cleanup deletes `orders` and `held_orders` before `service_charge_snapshots`.

- [ ] **Step 2: Add the production migration and cutoff applicator**

Create `backend/migrations/2026-07-11-service-charge-snapshots.sql` with the same table and idempotent `ADD COLUMN IF NOT EXISTS`/index statements.

Create `backend/migrations/apply-service-charge-snapshots.js`. Before reading/executing the SQL, run both preflight queries and exit nonzero if either count is nonzero:

```javascript
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const envFile = process.env.NODE_ENV === 'test' ? '../../.env.test' : '../../.env';
require('dotenv').config({ path: path.join(__dirname, envFile), override: true });

async function run() {
    const database = process.env.DB_NAME || 'posapp';
    if (process.env.SERVICE_CHARGE_MIGRATION_CONFIRM !== database) {
        throw new Error(`Set SERVICE_CHARGE_MIGRATION_CONFIRM=${database} to confirm the migration target.`);
    }
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database,
        charset: 'utf8mb4',
        multipleStatements: true
    });
    try {
        const [[open]] = await conn.query(`
            SELECT COUNT(DISTINCT o.invoice_id) AS count
            FROM orders o
            JOIN order_items oi ON oi.invoice_id = o.invoice_id
            WHERE o.payment_method = 'unpaid_table'
              AND oi.note = 'Auto-Gratuity'
        `);
        const [[held]] = await conn.query(`
            SELECT COUNT(*) AS count
            FROM held_orders
            WHERE cart_data LIKE '%Auto-Gratuity%'
        `);
        if (Number(open.count) > 0 || Number(held.count) > 0) {
            throw new Error(`Operational cutoff failed: ${open.count} open table order(s), ${held.count} held order(s) contain service charges.`);
        }
        const sql = fs.readFileSync(
            path.join(__dirname, '2026-07-11-service-charge-snapshots.sql'),
            'utf8'
        );
        await conn.query(sql);
        console.log('Service-charge snapshot migration applied.');
    } finally {
        await conn.end();
    }
}

run().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
```

Do not run this applicator against production during implementation.

- [ ] **Step 3: Add failing state-service unit tests**

Create `backend/tests/unit/serviceChargeSnapshotService.test.js`. Require Node's shared `crypto` object before importing the service, then use `vi.spyOn` so the CommonJS service observes the same mocked methods:

```javascript
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

vi.spyOn(crypto, 'randomUUID')
    .mockReturnValue('00000000-0000-4000-8000-000000000001');
vi.spyOn(crypto, 'randomBytes')
    .mockReturnValue(Buffer.alloc(32, 0x2a));

let snapshotService;
beforeAll(async () => {
    snapshotService = (await import('../../services/ServiceChargeSnapshotService.js')).default;
});
afterEach(() => vi.clearAllMocks());
afterAll(() => vi.restoreAllMocks());
```

Use a connection with queued query results and this exact matrix:

| Case | Mock row/result | Exact assertion |
|---|---|---|
| Create draft | INSERT returns one row with `10.0000`, `5.00`, version `1` | returned ID matches UUID; expiry equals `now + 24h` |
| Expired bind | draft `expires_at = now - 1ms` | status `409`, public code `SERVICE_CHARGE_SNAPSHOT_EXPIRED`; no UPDATE query |
| Wrong creator | `created_by=2`, caller `1` | status `409`; no UPDATE query |
| Version conflict | UPDATE `affectedRows=0` | status `409` |
| Claim | held snapshot version `2` | DB receives the SHA-256 hex of the mocked token, never plaintext |
| Consume once | stored hash matches supplied token | transition succeeds and clears `claim_token_hash` |
| Replay | state already `finalized` or hash null | status `409`; no state mutation |
| Illegal transition | request `finalized -> held` | status `409`; no UPDATE query |
| Plain open-order touch | matching holder/version | version increments once without state change; stale duplicate gets `409` |
| Split settle | `held -> finalized` | allowed with holder changed from held row to paid order |
| Claimed fee removed | valid one-time token | `claimed -> abandoned`; token hash cleared |
| Cleanup | expired draft plus old abandoned row | both deleted; held/open/finalized rows untouched |

Run:

```bash
npx vitest run backend/tests/unit/serviceChargeSnapshotService.test.js
```

Expected: FAIL because the service does not exist.

- [ ] **Step 4: Implement the state service**

Create `backend/services/ServiceChargeSnapshotService.js` using `crypto.randomUUID()`, `crypto.randomBytes(32)`, SHA-256, `crypto.timingSafeEqual`, and `SELECT ... FOR UPDATE`. Define conflicts first:

```javascript
const conflict = (
    message,
    publicCode = 'SERVICE_CHARGE_SNAPSHOT_CONFLICT'
) => {
    const error = new Error(message);
    error.statusCode = 409;
    error.publicCode = publicCode;
    return error;
};
```

Use updates shaped like:

```javascript
const [result] = await conn.query(`
    UPDATE service_charge_snapshots
       SET state=?, holder_type=?, holder_id=?, claim_token_hash=?, version=version+1
     WHERE id=? AND state=? AND version=?
`, [to, holderType, holderId, claimTokenHash, snapshotId, from, version]);
if (result.affectedRows !== 1) throw conflict('Service-charge snapshot changed. Refresh and try again.');
```

Use an explicit transition map:

```javascript
const ALLOWED = new Set([
    'draft:open_order', 'draft:held', 'draft:finalized', 'draft:abandoned',
    'open_order:finalized', 'open_order:split_parent',
    'held:claimed', 'held:finalized',
    'claimed:held', 'claimed:finalized', 'claimed:abandoned'
]);
```

Plain table saves do not change state but must still invalidate concurrent clients. Implement a separate primitive rather than adding `open_order:open_order` to the transition map:

```javascript
const touchOpenOrder = async (conn, { snapshotId, version, orderId }) => {
    const [result] = await conn.query(`
        UPDATE service_charge_snapshots
           SET version=version+1
         WHERE id=? AND state='open_order'
           AND holder_type='order' AND holder_id=? AND version=?
    `, [snapshotId, String(orderId), version]);
    if (result.affectedRows !== 1) {
        throw conflict('Service-charge snapshot changed. Refresh and try again.');
    }
    return Number(version) + 1;
};
```

Export and use this guard before a first bind:

```javascript
const assertDraftUsableBy = (snapshot, userId, version) => {
    const expired = snapshot.expires_at && new Date(snapshot.expires_at).getTime() <= Date.now();
    if (expired) {
        throw conflict(
            'Service-charge snapshot expired. Add the service charge again.',
            'SERVICE_CHARGE_SNAPSHOT_EXPIRED'
        );
    }
    if (
        snapshot.state !== 'draft' ||
        Number(snapshot.created_by) !== Number(userId) ||
        Number(snapshot.version) !== Number(version)
    ) {
        throw conflict('Service-charge snapshot changed. Refresh and try again.');
    }
};
```

Draft creation must use `expires_at = DATE_ADD(?, INTERVAL 24 HOUR)`. `consumeClaim` hashes the supplied token and compares 32-byte hash buffers with `timingSafeEqual` before clearing `claim_token_hash`.

Implement opportunistic cleanup, called before every draft insert:

```javascript
const cleanupExpiredDrafts = (conn, now = new Date()) => conn.query(`
    DELETE FROM service_charge_snapshots
     WHERE (state='draft' AND expires_at < ?)
        OR (state='abandoned' AND updated_at < DATE_SUB(?, INTERVAL 1 DAY))
`, [now, now]);
```

It must never delete held, claimed, open-order, split-parent, or finalized snapshots.

- [ ] **Step 5: Run schema/service gates**

Run:

```bash
npx vitest run backend/tests/unit/serviceChargeSnapshotService.test.js backend/tests/integration/settingsValidation.test.js
```

Expected: all selected tests pass and fixture setup/teardown succeeds with the new FKs.

- [ ] **Step 6: Commit snapshot persistence**

```bash
git add backend/migrations/2026-07-11-service-charge-snapshots.sql backend/migrations/apply-service-charge-snapshots.js backend/services/ServiceChargeSnapshotService.js backend/tests/unit/serviceChargeSnapshotService.test.js backend/tests/fixtures/seed.js
git commit -m "feat(pos): add service-charge snapshot state model"
```

---

## Task 3: Draft API and frontend frozen snapshot state

**Files:**

- Create: `backend/routes/pos/serviceCharges.js`
- Create: `backend/tests/integration/serviceChargeSnapshots.test.js`
- Modify: `backend/routes/pos.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`

**Interfaces:**

- Produces `POST /api/pos/service_charge_snapshots`.
- Produces `DELETE /api/pos/service_charge_snapshots/:id` for best-effort draft abandonment.
- Store state: `serviceChargeSnapshot = ref(null | { id, percentage, taxRate, version, claimToken? })`.
- Store payload helper: `serviceChargeSnapshotPayload() -> { id, version, claim_token? } | null`.
- Store recovery helper: `handleServiceChargeSnapshotConflict(status, body) -> Promise<boolean>`.

- [ ] **Step 1: Add failing API tests**

In `backend/tests/integration/serviceChargeSnapshots.test.js`, use cashier/admin cookies and direct settings updates. Assert this matrix:

| Request/state | Expected HTTP and DB result |
|---|---|
| Cashier without `pos.service_charge` POST | `403`; zero snapshot rows |
| Permitted cashier, `service_charge_enabled=0` POST | `403`; zero rows |
| Permitted cashier, enabled, percentage `12.5`, tax `16` | `200`; row is draft `12.5000/16.00`, version `1`, expiry 24h |
| Creator DELETE on draft | `200`; state becomes `abandoned`, version increments |
| Different user DELETE | `409`; row remains draft |
| DELETE after state changed to `open_order` | `409`; row unchanged |

Run and verify `404`/module absence:

```bash
npx vitest run backend/tests/integration/serviceChargeSnapshots.test.js
```

- [ ] **Step 2: Implement and mount the router**

Create `backend/routes/pos/serviceCharges.js`. Use `requireAuth`, `canApplyServiceCharge`, `getSettings`, and snapshot service calls. Call `cleanupExpiredDrafts` immediately before `createDraft` on the same connection. Return:

```javascript
return sendSuccess(res, {
    snapshot: {
        id: snapshot.id,
        percentage: Number(snapshot.percentage),
        taxRate: Number(snapshot.tax_rate),
        version: snapshot.version
    }
});
```

The router's catch preserves public snapshot codes without relying on Task 4's later shared-helper change:

```javascript
const status = error.statusCode || 500;
return res.status(status).json({
    success: false,
    message: status === 500 ? 'Operation failed. Please try again.' : error.message,
    ...(error.publicCode ? { code: error.publicCode } : {})
});
```

Mount in `backend/routes/pos.js`:

```javascript
const serviceChargesRouter = require('./pos/serviceCharges');
router.use('/', serviceChargesRouter);
```

- [ ] **Step 3: Add failing store tests**

Extend `backend/tests/unit/orderSessionStore.test.js` with exact mocked flows:

| Flow | Exact assertion |
|---|---|
| Snapshot POST returns `500` | original cart unchanged; no fee; alert shown |
| Call `addServiceCharge()` twice before deferred POST resolves | one POST and one fee line |
| POST returns `{id:'s1',percentage:10,taxRate:5,version:1}` on goods `10` | one fee line at `1.00`, tax `5`; snapshot persisted |
| Change live settings from `10` to `20`, then change goods to `20` | fee becomes `2.00`, not `4.00` |
| Change goods base to zero | fee line removed; snapshot remains `s1` |
| Re-add after zero/base restore | no new POST; fee uses snapshot `10%` |
| `startNewOrder()` with draft | DELETE attempted once; cart/snapshot/local storage cleared even if DELETE rejects |
| Checkout fingerprint/payload | includes snapshot ID `s1`, version `1`, and no plaintext rates as authority |
| `409` with `SERVICE_CHARGE_SNAPSHOT_EXPIRED` | fee and snapshot/local-storage key cleared; warning toast says to add again |
| Bound-table `SERVICE_CHARGE_SNAPSHOT_CONFLICT` | fee/snapshot retained; authoritative table reload requested |

Part C intentionally added two characterization locks that now conflict with this approved behavior change. In the same red-test edit:

- replace `addServiceCharge calculates from the rounded cart subtotal` with `addServiceCharge uses the canonical raw non-fee base`, mock snapshot creation, `await s.addServiceCharge()`, and change the `0.045 @ 10%` expectation from `0.01` to no zero-value fee line plus a retained snapshot;
- rename `updateServiceCharge calculates from the raw non-fee subtotal` to `updateServiceCharge uses the canonical raw non-fee base` and retain its expected fee `0`/line-removal behavior;
- search for and remove any remaining assertion that requires rounded `cartSubtotal` as the add-fee base.

Run the focused test before production edits. Expected RED reasons are the async snapshot request/state not existing and the old rounded-base lock still producing `0.01`; there must be no unexplained legacy-lock failure left for the green run.

The half-cent expectation changes deliberately:

```javascript
// raw 0.045 * 10% = 0.0045 -> canonical roundMoney = 0.00
expect(fee.price).toBe(0);
```

Run and verify failures against current rounded-base add behavior:

```bash
npx vitest run backend/tests/unit/orderSessionStore.test.js
```

- [ ] **Step 4: Implement store snapshot state**

In `orderSessionStore.js`:

- import `serviceChargeFee` from `src/utils/posTotals.js`;
- add/persist `serviceChargeSnapshot` under `pos_service_charge_snapshot`;
- add a private `isCreatingServiceChargeSnapshot` guard that is set before fetch and cleared in `finally`;
- make `addServiceCharge` async;
- POST only when no snapshot exists;
- compute both add and update through `serviceChargeFee(cart.value, snapshot.percentage)`;
- retain the existing deep cart watcher as the only recomputation hook: `watch(cart, ... nextTick(updateServiceCharge), { deep: true })`;
- make `updateServiceCharge` return when either the fee line or frozen snapshot is absent, and mutate only when canonical price/name differs so the watcher reaches a fixed point;
- retain the snapshot when fee becomes zero or the line is removed;
- clear/abandon it only when clearing the entire order lifecycle;
- include ID/version/claim token in checkout, hold, and table payload builders;
- include snapshot identity in idempotency fingerprint.

Do not add recomputation calls to individual quantity, price, discount, modifier, scan, or removal actions. Their mutations already flow through the deep watcher. Add direct-mutation tests for goods quantity, price, fixed discount, percent discount, and removal; after `await nextTick()` each must show the canonical fee and must not issue another snapshot POST.

Implement snapshot-specific recovery:

```javascript
const handleServiceChargeSnapshotConflict = async (status, body) => {
  if (status !== 409) return false;
  if (body?.code === 'SERVICE_CHARGE_SNAPSHOT_EXPIRED') {
    cart.value = cart.value.filter(item => item.note !== 'Auto-Gratuity');
    serviceChargeSnapshot.value = null;
    localStorage.removeItem('pos_service_charge_snapshot');
    window.showPosToast?.(
      t('Service charge expired. Add it again before checkout.'),
      'warning'
    );
    return true;
  }
  if (body?.code === 'SERVICE_CHARGE_SNAPSHOT_CONFLICT' && activeTable.value?.id) {
    await loadActiveTableOrder({ ...activeTable.value }, { clearEmpty: false });
    return true;
  }
  return false;
};
```

Checkout, hold, and table-save response handlers `await` this before their generic error handling. Bound snapshots are never cleared or replaced from current settings.

The fee-line creation must use:

```javascript
const fee = serviceChargeFee(cart.value, serviceChargeSnapshot.value.percentage);
if (fee > 0) {
  cart.value.push({
    id: `FEE_${Date.now()}`,
    product_id: null,
    name: `${serviceChargeSnapshot.value.percentage}% Service Charge`,
    price: fee,
    tax_rate: serviceChargeSnapshot.value.taxRate,
    cartId: Date.now() + Math.random().toString(36).slice(2, 11),
    qty: 1,
    note: 'Auto-Gratuity',
    discountType: null,
    discountValue: 0
  });
}
```

- [ ] **Step 5: Run API/store/build gates**

```bash
npx vitest run backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/serviceChargeParity.test.js
npm run build:admin
```

Expected: tests and build pass; failed snapshot creation never adds a line.

- [ ] **Step 6: Commit draft creation and client state**

```bash
git add backend/routes/pos/serviceCharges.js backend/routes/pos.js backend/tests/integration/serviceChargeSnapshots.test.js assets/js/composables/stores/orderSessionStore.js backend/tests/unit/orderSessionStore.test.js
git commit -m "feat(pos): freeze service-charge settings on first add"
```

---

## Task 4: Direct checkout binding and exact canonical persistence

**Files:**

- Modify: `backend/routes/pos/helpers.js`
- Modify: `backend/routes/pos/checkout.js`
- Modify: `backend/tests/integration/checkout.test.js`
- Modify: `backend/tests/integration/serviceChargeSnapshots.test.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`

**Interfaces:**

- Consumes Task 1 `canonicalizeServiceCharge`.
- Consumes Task 2 `getForUpdate`, `bindDraft`, `abandonDraft`, and `transition`.
- Checkout request consumes `service_charge_snapshot: { id, version, claim_token? }`.
- This task handles only ordinary direct checkout from a user-owned draft. Task 6 owns claimed-token checkout, and Task 7 owns split-held settlement; route those modes before this draft-only block.

- [ ] **Step 1: Add failing direct-checkout tests**

Add direct-checkout cases with these exact outcomes:

| Input | Expected outcome |
|---|---|
| Valid `Auto-Gratuity` line, no snapshot | `400`; no order |
| Draft created by admin, checkout as cashier | `409`; draft unchanged |
| Snapshot version `1`, payload version `0` | `409`; no order |
| Expected fee `1.00`, submitted `1.01` | `409` even though difference is within global money tolerance |
| Submitted fee qty `1`, name junk, tax `99`, canonical price | accepted only after canonical name/tax/discount fields are stamped; assert persisted row |
| Valid direct checkout | snapshot becomes finalized, holder is invoice ID, order FK matches |
| Inject order-item INSERT failure | transaction rolls back; snapshot remains draft |
| No fee and no snapshot | current successful checkout behavior unchanged |
| Fee removed but valid draft still supplied | checkout succeeds; draft becomes `abandoned`; order FK stays null; no fee row persists |
| Store checkout receives expired-snapshot code | goods remain; fee/snapshot cleared; warning toast shown; checkout state unlocks |
| Store checkout receives unrelated `409` | fee/snapshot retained; normal conflict shown |

Run:

```bash
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/unit/orderSessionStore.test.js
```

Expected: new tests fail because checkout still validates against live settings and tolerance.

- [ ] **Step 2: Replace tolerant fee validation at checkout**

First extend the shared POS error response without changing existing callers:

```javascript
const sendError = (res, status, message, code = null) => {
    let msg = message;
    const isDbMessage = typeof msg === 'string' && (
        msg.includes('ER_') ||
        msg.includes('SQLSTATE') ||
        msg.includes('mysql') ||
        msg.includes('SQL Error') ||
        (msg.includes('Table') && msg.includes('exist')) ||
        (msg.includes('table') && msg.includes('exist'))
    );
    if ((status === 500 && process.env.NODE_ENV === 'production') || isDbMessage) {
        msg = 'Operation failed. Please try again.';
    }
    const payload = { success: false, message: msg };
    if (code) payload.code = code;
    return res.status(status).json(payload);
};
```

Checkout, table, held-order, and snapshot-route catch blocks pass `e.publicCode || null`. This is the stable signal used by frontend recovery; do not parse human-readable messages.

In `checkout.js`, after `applyDatabasePrices` and before `calculateExpectedTotals`, run this block only when the request is neither a claimed held-order checkout nor a `split_check_id` settlement:

```javascript
const submittedSnapshot = data.service_charge_snapshot || null;
const hasFee = cartItems.some(item => item.note === SERVICE_NOTE);
let snapshot = null;
if (hasFee && !submittedSnapshot?.id) {
    const error = new Error('A service-charge snapshot is required.');
    error.statusCode = 400;
    throw error;
}
if (submittedSnapshot?.id) {
    snapshot = await getForUpdate(conn, submittedSnapshot.id);
    assertDraftUsableBy(snapshot, api_user.id, submittedSnapshot.version);
    if (hasFee) {
        const canonical = canonicalizeServiceCharge(cartItems, {
            id: snapshot.id,
            percentage: snapshot.percentage,
            taxRate: snapshot.tax_rate
        });
        cartItems = canonical.items;
    }
}
```

Change the normalized cart declaration from `const cartItems` to `let cartItems` so every downstream consumer receives the canonical array. After inserting the order and obtaining `invoiceId`:

```javascript
if (snapshot && hasFee) {
    await bindDraft(conn, {
        snapshotId: snapshot.id,
        version: snapshot.version,
        userId: api_user.id,
        state: 'finalized',
        holderType: 'order',
        holderId: String(invoiceId)
    });
    await conn.query(
        'UPDATE orders SET service_charge_snapshot_id=? WHERE invoice_id=?',
        [snapshot.id, invoiceId]
    );
} else if (snapshot) {
    await abandonDraft(conn, {
        snapshotId: snapshot.id,
        version: snapshot.version,
        userId: api_user.id
    });
}
```

Thus a removed fee remains reusable while the cart is active but does not create a meaningless finalized snapshot/order link. Replace checkout's unconditional `assertServiceChargeValid` call with a transitional guard: retain the legacy call for claim-token and `split_check_id` modes, while ordinary direct-draft checkout uses the new canonicalizer. Task 6 removes the claim-token legacy call when it takes ownership of claimed checkout; Task 7 removes the split-settle legacy call when it takes ownership of exact allocated settlement. This keeps every intermediate task commit independently safe from forged fee persistence. Keep permission enforcement. In checkout's catch, call `sendError(res, status, msg, e.publicCode || null)` so expired drafts reach the store recovery helper.

- [ ] **Step 3: Preserve server-authoritative totals and persistence**

Ensure `calculateExpectedTotals`, submitted-total assertions, order insert/update, and order-item inserts all consume the canonicalized `cartItems`. No later code may fall back to the original `data.cart` array.

- [ ] **Step 4: Run checkout security gates**

```bash
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/unit/PosCalculator.test.js backend/tests/unit/serviceChargeCalculator.test.js backend/tests/unit/orderSessionStore.test.js
```

Expected: all pass, including old qty-inflation/duplicate/tax forgery tests updated to include legitimate snapshots where needed.

- [ ] **Step 5: Commit direct checkout authority**

```bash
git add backend/routes/pos/helpers.js backend/routes/pos/checkout.js backend/tests/integration/checkout.test.js backend/tests/integration/serviceChargeSnapshots.test.js assets/js/composables/stores/orderSessionStore.js backend/tests/unit/orderSessionStore.test.js
git commit -m "fix(pos): canonicalize service charges at checkout"
```

---

## Task 5: Open-table snapshot lifecycle

**Files:**

- Modify: `backend/routes/pos/tables.js`
- Modify: `backend/routes/pos/helpers.js`
- Modify: `backend/routes/pos/checkout.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`

**Interfaces:**

- Table GET returns `service_charge_snapshot: { id, percentage, taxRate, version } | null`.
- First table save binds `draft -> open_order`.
- Later saves use the order-bound snapshot regardless of current settings.
- Every successful later save of an order with a bound snapshot calls `touchOpenOrder` and returns the incremented version; orders that never had a fee continue saving without snapshot work.
- Final table checkout transitions `open_order -> finalized`.

- [ ] **Step 1: Add failing table lifecycle tests**

Add table cases with exact DB assertions:

| Flow | Expected result |
|---|---|
| First save with draft `10%/5%` | order FK set; snapshot `open_order`; canonical fee persisted |
| GET/load table | response snapshot ID/rates/version equal DB row |
| Change settings to `20%/16%`, update goods | fee still uses `10%/5%` |
| Disable globally after first save | update and settle remain valid with frozen snapshot |
| Remove fee and save | no fee row; order FK/snapshot remain |
| Re-add after settings change | same snapshot ID; frozen rates |
| Submit another snapshot ID/version | `409`; order/items unchanged |
| Two updates from same version | exactly one `200`; other `409`; version increments once |
| Bound snapshot version conflict in store | fee/snapshot retained; table reload called; current settings never copied in |

Run the table and store suites; expect failures.

- [ ] **Step 2: Return snapshots from table loading**

Extend the order/table load query with a left join to `service_charge_snapshots` and return:

```javascript
service_charge_snapshot: row.service_charge_snapshot_id ? {
    id: row.service_charge_snapshot_id,
    percentage: Number(row.service_charge_percentage),
    taxRate: Number(row.service_charge_tax_rate),
    version: Number(row.service_charge_snapshot_version)
} : null
```

Thread this through `loadTableOrder(..., opts)` into `serviceChargeSnapshot.value`.

- [ ] **Step 3: Bind or load snapshot before table canonicalization**

For a new table order with a fee, lock and bind the submitted draft after the order row obtains an invoice ID. For an existing table order, select `orders.service_charge_snapshot_id` and snapshot `FOR UPDATE`; reject a mismatching submitted ID/version. Canonicalize with stored rates after `applyDatabasePrices`.

When the fee line is absent, leave the bound snapshot unchanged. Do not consult current enabled/percentage/tax settings for a bound snapshot.

After every successful existing-table save **when the order has a bound snapshot**, before commit, call:

```javascript
const nextSnapshotVersion = await touchOpenOrder(conn, {
    snapshotId: snapshot.id,
    version: submittedSnapshot.version,
    orderId: order_id
});
```

Return `nextSnapshotVersion` in the table-save response and replace the store's local snapshot version only after the response succeeds. This gives the two-concurrent-save test a real compare-and-swap primitive without inventing a state transition.

In the table route catch, forward `e.publicCode || null` through the extended `sendError`. The table-save frontend passes the parsed status/body to `handleServiceChargeSnapshotConflict` before generic error handling.

- [ ] **Step 4: Use the bound snapshot during table checkout**

In the table-settle branch of checkout, read the snapshot ID through the locked order row. Do not require a draft owned by the current cashier. Canonicalize using the order-bound snapshot and transition it to `finalized` only when checkout commits.

- [ ] **Step 5: Run table/checkout/store gates**

```bash
npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/checkout.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/unit/orderSessionStore.test.js
npm run build:admin
```

- [ ] **Step 6: Commit table lifecycle**

```bash
git add backend/routes/pos/tables.js backend/routes/pos/helpers.js backend/routes/pos/checkout.js assets/js/composables/stores/orderSessionStore.js backend/tests/integration/tables.test.js backend/tests/unit/orderSessionStore.test.js
git commit -m "feat(pos): preserve service-charge snapshots on tables"
```

---

## Task 6: Held-order bind, claim, and re-hold continuity

**Files:**

- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/routes/pos/checkout.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `src/components/OrderNotes.vue`
- Modify: `backend/tests/integration/heldOrders.test.js`
- Modify: `backend/tests/integration/checkout.test.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`

**Interfaces:**

- Hold request consumes root `service_charge_snapshot`.
- Claimed response returns snapshot plus one-time `claimToken`.
- Re-hold/checkout consumes the token and exact version.

- [ ] **Step 1: Add failing held lifecycle/security tests**

Add held-order cases with exact outcomes:

| Input/transition | Expected result |
|---|---|
| Hold contains fee but no snapshot | `400`; no held row |
| Client product price forged low | held base/fee derive from database price; stored cart is canonical |
| Valid hold | held row FK and snapshot holder ID match in one commit |
| Claim | held row deleted; snapshot `claimed`; response carries token but DB stores only hash |
| Settings change, then re-hold with token | same rates and snapshot ID; state `held`; token hash cleared |
| Claim then checkout | snapshot finalized and linked to paid order |
| Claim, remove fee, then checkout | token is consumed to `abandoned`; checkout succeeds with no fee and no order snapshot FK |
| Claim, remove fee, then re-hold | token is consumed to `abandoned`; new held row has no fee and no snapshot FK |
| Reuse consumed token | `409`; no duplicate hold/order |
| Inject held DELETE failure after claim update | entire transaction rolls back to held state/row |
| Submit one-cent fee mismatch on hold | `409`; draft remains usable and client cart remains intact |

- [ ] **Step 2: Canonicalize and bind during hold creation**

Change held creation to a transaction. For carts with a fee:

1. fetch/pin product prices using existing helpers;
2. lock the draft snapshot;
3. enforce `pos.service_charge` permission and canonicalize the fee;
4. recompute held subtotal from canonical items;
5. insert `held_orders` with canonical `cart_data` and `service_charge_snapshot_id`;
6. transition `draft` or `claimed` to `held` in the same transaction.

Do not trust submitted held subtotal or fee line after this change.

- [ ] **Step 3: Transition held snapshot during claim**

Inside the existing `SELECT ... FOR UPDATE` claim transaction, call `claimHeld` before deleting the held row. Return:

```javascript
order: {
    ...row,
    service_charge_snapshot: snapshot ? {
        id: snapshot.id,
        percentage: Number(snapshot.percentage),
        taxRate: Number(snapshot.tax_rate),
        version: snapshot.version,
        claimToken
    } : null
}
```

Any failure rolls back both snapshot transition and held-row deletion.

- [ ] **Step 4: Restore and persist claimed state in the frontend**

In `OrderNotes.vue`, copy the authoritative returned snapshot into `restorePayload.service_charge_snapshot`. In `restoreHeldOrder`, set `serviceChargeSnapshot.value`; persist its claim token in the order-scoped local-storage key. Include it in checkout or re-hold payloads, and clear it only after successful consumption/finalization.

- [ ] **Step 5: Consume claim on re-hold or checkout**

Detect a submitted claim token before entering Task 4's draft-only checkout block. Lock the claimed snapshot and verify the exact snapshot ID, version, token, user, and `claimed` state. Then branch inside the same transaction that creates the replacement holder:

1. fee present at checkout: canonicalize using frozen rates, insert the paid order, then `consumeClaim(..., to: 'finalized', holderType: 'order', holderId: invoiceId)` and set the order FK;
2. fee present on re-hold: canonicalize using frozen rates, insert the held row, then `consumeClaim(..., to: 'held', holderType: 'held_order', holderId: heldOrderId)` and set the held-row FK;
3. fee absent at checkout or re-hold: do not call draft-only `abandonDraft`; call `consumeClaim(..., to: 'abandoned', holderType: 'none', holderId: null)`, and leave the new order/held-row snapshot FK null.

`claimed -> abandoned` is an allowed transition and consumes/clears the claim-token hash. A token mismatch, old version, or consumed state returns `409` without deleting cart state client-side. This prevents a restored hold whose fee was intentionally removed from entering an unrecoverable draft-state conflict.

Held creation/claim catches forward `e.publicCode || null` through the extended `sendError`. An expired unbound draft therefore triggers the same fee/snapshot cleanup and re-add toast as direct checkout; a claimed/bound conflict never clears its frozen snapshot.

- [ ] **Step 6: Run held and checkout gates**

```bash
npx vitest run backend/tests/integration/heldOrders.test.js backend/tests/integration/heldOrders.fireKitchen.test.js backend/tests/integration/bundle.heldOrders.fire.test.js backend/tests/integration/checkout.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/unit/orderSessionStore.test.js
```

- [ ] **Step 7: Commit held continuity**

```bash
git add backend/routes/pos/orders.js backend/routes/pos/checkout.js assets/js/composables/stores/orderSessionStore.js src/components/OrderNotes.vue backend/tests/integration/heldOrders.test.js backend/tests/integration/checkout.test.js backend/tests/unit/orderSessionStore.test.js
git commit -m "feat(pos): preserve service-charge snapshots through holds"
```

---

## Task 7: Split-check largest-remainder allocation

**Files:**

- Modify: `backend/routes/pos/tables.js`
- Modify: `backend/routes/pos/checkout.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/tests/integration/checkout.test.js`
- Modify: `backend/tests/integration/serviceChargeSnapshots.test.js`
- Modify: `backend/tests/unit/serviceChargeCalculator.test.js`

**Interfaces:**

- Consumes `allocateServiceChargeCents(seats, parentFee, percentage)`.
- Consumes snapshot-service `getForUpdate` and `transition` for exact child settlement.
- Parent snapshot transitions `open_order -> split_parent`.
- Produces one child snapshot per non-empty held split.
- Each child held payload persists its authoritative `service_charge_allocation_cents`; child settlement never derives that amount again from the seat base.

- [ ] **Step 1: Add property and integration tests first**

Extend calculator tests with 5,000 seeded seat partitions asserting:

```javascript
expect(allocated.reduce((sum, cents) => sum + cents, 0)).toBe(Math.round(parentFee * 100));
expect(allocated.every(cents => Number.isInteger(cents) && cents >= 0)).toBe(true);
```

Add integration cases with exact persistence checks:

| Split condition | Expected result |
|---|---|
| Client puts forged full fee on seat 2 | server removes submitted fees and writes generated allocations |
| Three equal bases, parent fee `1.00` | seat fees in stable order are `0.34/0.33/0.33`; sum `1.00` |
| Equal fractional remainders | earlier submitted seat receives residual cent |
| Successful split | every held row references a child snapshot with parent ID and identical rates |
| Allocated cents `0` | no fee line on that seat, but child lineage snapshot still exists |
| Split then settle all seats | sum of persisted paid service-charge rows equals parent `1.00`; totals/tax match calculators |
| Settle the `0.34` child whose seat base would independently round to `0.33` | paid fee remains exactly `0.34`; no canonical recomputation rewrites it |
| Split settle sends no snapshot or the parent snapshot | server ignores the client snapshot field and resolves the child through the locked held-row FK |
| Persisted child fee differs from `service_charge_allocation_cents` | `409`; held row and child snapshot remain `held` |
| Successful child settle | child snapshot transitions `held -> finalized` and paid order FK points to it in the checkout transaction |
| Inject existing audit INSERT failure | parent remains open, no child snapshots/held rows survive |

- [ ] **Step 2: Generate fees server-side during split normalization**

Before per-seat total validation:

1. load and lock the parent order snapshot;
2. remove all submitted `Auto-Gratuity` lines from seat items;
3. pin ordinary items to parent/order prices;
4. calculate parent canonical fee from its persisted line;
5. allocate fee cents across seats;
6. append canonical fee lines using allocated cents and frozen tax rate, and persist `service_charge_allocation_cents: allocatedCents` in that seat's `cart_data` payload;
7. calculate seat totals from generated lines.

Do not run the ordinary exact-rate fee validator against allocated child amounts; the allocation result is the authority for split children.

- [ ] **Step 3: Create child snapshots transactionally**

For each non-empty seat, call `createChildHeldSnapshot` with:

```javascript
{
  percentage: parent.percentage,
  tax_rate: parent.tax_rate,
  parent_snapshot_id: parent.id,
  state: 'held',
  holder_type: 'held_order',
  holder_id: String(heldOrderId)
}
```

Insert the held row with a null snapshot FK, call the snapshot service using the new held-row ID, update the held row's snapshot FK, and transition the parent to `split_parent` before the existing audit insert/commit. Any failure rolls back all rows.

- [ ] **Step 4: Settle split children from locked persisted allocation**

In `checkout.js`, route `split_check_id` before Task 4's generic draft/snapshot block. Extend the existing locked held-row query to select `service_charge_snapshot_id`, and use the held row's server-side `cart_data` as it does today. Ignore any client-supplied `service_charge_snapshot` for this branch.

While the held row is locked:

1. load its child snapshot by `service_charge_snapshot_id` with `getForUpdate`;
2. require snapshot state `held`, holder type `held_order`, holder ID equal to the locked held-row ID, and unchanged frozen fee/tax rates;
3. read `service_charge_allocation_cents` from the persisted held payload;
4. require exactly one stored `Auto-Gratuity` line when allocation is positive, or none when it is zero; validate exact integer cents plus canonical name, quantity `1`, tax, and zero-discount shape;
5. do **not** call `canonicalizeServiceCharge` or recompute the allocated child fee from its seat base;
6. insert the paid order/items using that validated server-held cart, transition the child `held -> finalized`, set its holder to the invoice ID, and set `orders.service_charge_snapshot_id` in the same transaction;
7. delete the held row only within that transaction, so any validation, insert, transition, or delete failure restores the complete held state on rollback.

Add `held:finalized` to the transition allowlist. Do not add a tolerant or `requireExact: false` mode to the ordinary canonicalizer: split allocation is a separate exact-persistence invariant.

- [ ] **Step 5: Mirror allocation in split preview**

The store preview uses the same integer-cent largest-remainder algorithm for display only. The server still regenerates allocations. Include seat order in the payload and never use mutable labels as tie-breakers.

- [ ] **Step 6: Run split/bundle/checkout gates**

```bash
npx vitest run backend/tests/unit/serviceChargeCalculator.test.js backend/tests/integration/tables.test.js backend/tests/integration/checkout.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/bundle.tables.test.js backend/tests/integration/bundle.checkout.test.js backend/tests/unit/orderSessionStore.test.js
npm run build:admin
```

- [ ] **Step 7: Commit split conservation**

```bash
git add backend/routes/pos/tables.js backend/routes/pos/checkout.js assets/js/composables/stores/orderSessionStore.js backend/tests/integration/tables.test.js backend/tests/integration/checkout.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/unit/serviceChargeCalculator.test.js
git commit -m "fix(pos): conserve service-charge cents across splits"
```

---

## Task 8: Settings precision, migration rehearsal, and rollout documentation

**Files:**

- Modify: `backend/routes/system.js`
- Modify: `src/admin/pages/Settings.vue`
- Modify: `backend/tests/integration/settingsValidation.test.js`
- Create: `docs/superpowers/runbooks/2026-07-11-service-charge-snapshot-rollout.md`

**Interfaces:**

- Percentage accepts at most four fractional digits.
- Tax rate accepts at most two fractional digits.
- Runbook provides exact preflight, apply, verification, and rollback commands.

- [ ] **Step 1: Add failing precision tests**

Add four requests using exact payloads and outcomes:

| Field/value | Expected |
|---|---|
| percentage `12.3456` | `200`, persisted string `12.3456` |
| percentage `12.34567` | `400`, setting unchanged |
| tax `16.25` | `200`, persisted string `16.25` |
| tax `16.255` | `400`, setting unchanged |
| payload omits both service-charge numeric fields | `200`; unrelated setting saves; service-charge settings remain untouched |

- [ ] **Step 2: Enforce representable precision**

In `backend/routes/system.js`, add:

```javascript
const decimalPlaces = (value) => {
    const text = String(value).trim();
    const match = text.match(/^[-+]?\d+(?:\.(\d+))?$/);
    return match ? (match[1]?.length || 0) : Infinity;
};

if (
    data.service_charge_percentage !== undefined &&
    decimalPlaces(data.service_charge_percentage) > 4
) {
    return sendError(res, 400, 'Service charge percentage supports at most 4 decimal places.');
}
if (
    data.service_charge_tax_rate !== undefined &&
    decimalPlaces(data.service_charge_tax_rate) > 2
) {
    return sendError(res, 400, 'Service charge tax rate supports at most 2 decimal places.');
}
```

Set matching HTML input steps: percentage `0.0001`, tax `0.01`.

- [ ] **Step 3: Write the rollout runbook**

Create the runbook with these exact phases:

```text
1. Disable new service-charge application operationally.
2. Query open unpaid orders joined to order_items note='Auto-Gratuity'.
3. Query held_orders cart_data containing Auto-Gratuity.
4. Stop if either result is nonzero.
5. Back up orders, order_items, held_orders, settings, and schema.
6. Run node backend/migrations/apply-service-charge-snapshots.js.
7. Verify table/columns/indexes and zero draft rows.
8. Deploy backend, then frontend.
9. Create one test order; verify snapshot, canonical fee, tax, hold/restore, and checkout.
10. Re-enable service-charge application.
```

Rollback section: disable new application; do not drop snapshot schema after any snapshot exists; keep backend compatibility until all bound orders finalize.

- [ ] **Step 4: Rehearse migration against the test database only**

With a clean fixture database, run the applicator using test credentials and an explicit matching confirmation, then verify schema:

```bash
$env:NODE_ENV='test'
$env:SERVICE_CHARGE_MIGRATION_CONFIRM='posapp_test'
node backend/migrations/apply-service-charge-snapshots.js
```

Then reset the test database, insert one held `Auto-Gratuity` row, and rerun the same command to prove preflight exits nonzero before DDL.

Never point this rehearsal at production.

- [ ] **Step 5: Run settings/admin gates**

```bash
npx vitest run backend/tests/integration/settingsValidation.test.js backend/tests/integration/serviceChargeSnapshots.test.js
npm run build:admin
```

- [ ] **Step 6: Commit precision and rollout controls**

```bash
git add backend/routes/system.js src/admin/pages/Settings.vue backend/tests/integration/settingsValidation.test.js docs/superpowers/runbooks/2026-07-11-service-charge-snapshot-rollout.md
git commit -m "docs(pos): guard service-charge snapshot rollout"
```

---

## Final Verification

- [ ] **Step 1: Run focused financial/security suites in one process**

```bash
npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js backend/tests/unit/serviceChargeCalculator.test.js backend/tests/unit/serviceChargeParity.test.js backend/tests/unit/serviceChargeSnapshotService.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/heldOrders.fireKitchen.test.js backend/tests/integration/bundle.checkout.test.js backend/tests/integration/bundle.tables.test.js backend/tests/integration/settingsValidation.test.js
```

Expected: zero failures.

- [ ] **Step 2: Run the complete suite once**

```bash
npx vitest run
```

Expected: zero failures; test-file/test counts are at least the execution baseline plus all tests added by Tasks 1-8.

- [ ] **Step 3: Build production bundles**

```bash
npm run build:admin
```

Expected: successful Vite build.

- [ ] **Step 4: Run static formula and forbidden-scope audits**

```bash
rg -n "service.?charge|Auto-Gratuity|FEE_" backend assets src
rg -n "toFixed\(2\).*service|cartSubtotal.*service_charge|assertNearMoney\('Service charge'" backend assets src
git diff --check master...HEAD
git status --short
```

Expected:

- every production fee calculation delegates to the new authority;
- no arithmetic uses `toFixed()`;
- no rounded `cartSubtotal` is a fee base;
- no tolerant `assertNearMoney('Service charge', ...)` remains;
- no unrelated user files are staged or modified.

- [ ] **Step 5: Verify migration is not accidentally applied to production**

Inspect execution logs and database target. The implementation branch may contain migration files and test-database rehearsal evidence only; production application requires the separate rollout window and cutoff.

- [ ] **Step 6: Review commit boundaries**

```bash
git log --oneline master..HEAD
```

Expected eight independently reviewable commits matching Tasks 1-8.

---

## Deferred and Explicitly Excluded

- Tax-exempt sale contract.
- Receipt net/gross presentation.
- Table-merge snapshot reconciliation and orphan cleanup. Deleting a source order can strand its `open_order` snapshot, and merging two fee-bearing orders needs an explicit conservation/ownership policy before either snapshot or fee line is discarded.
- General money-tolerance changes.
- Historical service-charge snapshot backfill.
- Modifier stable IDs.
- Bundle corruption recovery.

These require separate approval and must not be folded into this branch.
