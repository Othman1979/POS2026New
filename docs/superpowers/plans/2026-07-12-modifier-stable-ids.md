# Modifier Stable IDs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give modifier groups/options stable server-assigned IDs and persist each line's modifier selection to `order_items`, so restoration, splitting, bundles, and receipts preserve the correct modifiers even across option renames.

**Architecture:** Three thin layers on the existing design — (1) `products.modifiers` JSON gains an `id` per group/option, assigned server-side on admin save and backfilled by migration; (2) `PosCalculator` matches selections by id first (name fallback for legacy data) and emits a DB-priced snapshot; (3) a new nullable `order_items.selected_modifiers` JSON column persists that snapshot at every write site and is re-emitted by every cart-rebuild read path. Existing paid orders/receipts are not backfilled and keep rendering from `note`/stored money; live held/split/table JSON is canonicalized the next time the server saves it. No new tables, no joins, no receipt/spooler changes (receipts already render the unchanged `note` text).

**Tech Stack:** Node/Express, mysql2, Vue 3 + Pinia store, Vitest (+supertest integration).

## Anchor baseline — READ FIRST

All file:line anchors below were originally verified 2026-07-12 against branch **`gemini/receipt-display-consistency` @ `80f2541f`**, which is now merged to `master`. **Execute this plan only on a tree at or after merged `master` commit `62891d9d`.** Before Task 1, run the Task 0 anchor re-verification — if anything else landed, line numbers may have drifted (match on the quoted code, not the number).

## Problem (verified current behavior)

- Modifier definitions: `products.modifiers` longtext JSON `[{name, required, multi_select, options:[{name, price}]}]` — **no ids**, replaced wholesale on admin edit (`backend/routes/admin/products.js:199,234`). `validateProductInput` (`products.js:46-68`) does not validate the modifiers field at all.
- Cart lines carry `selectedModifiers: [{group, option, price}]` matched **by exact name `===`** against the DB definition in `computeModifierSurcharge` (`backend/services/PosCalculator.js:137-154`). Renaming an option silently drops its surcharge — a held cart created before the rename claims with the old frozen display price, then checkout re-prices DOWN to base and either 400s on the correct total or undercharges if the client resubmits the lower total.
- `selectedModifiers` is **never persisted**: the `order_items` INSERTs (`checkout.js:926`, `tables.js:1809`, merge copies `tables.js:425,476`) have no modifier column. Free-text `note` is the only survivor.
- Settle **deletes and re-inserts** `order_items` from the client cart (`checkout.js:806`, `tables.js:1720`), and the table-reload/edit-invoice/split-restore rebuilds drop `selectedModifiers` (`tables.js:1042-1057` emits none; store `restoreTableSplit` :1571-1586 and `loadOrderForEditing` :1662-1677 omit the field) — so after any table round-trip the structured selection is gone for good.
- Zero trust-boundary validation on `selectedModifiers` shape (`normalizeCartItems`, `PosCalculator.js:29-48`, spreads it through verbatim into `held_orders.cart_data` and split payloads).

Money is already safe (option price is DB-sourced; client price ignored). This plan fixes **identity**, plus the one real money bug: rename-induced surcharge drop.

## Chosen design (and what was rejected)

Per-product ids inside the existing JSON column + a per-line JSON snapshot column. Rejected: relational `modifier_groups`/`order_item_modifiers` tables (joins, migrations, admin CRUD rewrite — no benefit at this scale); driving receipts from structured data (note text already renders correctly on every surface — see Non-goals); global option ids (options only ever matched within one product).

Snapshot shape stored in `order_items.selected_modifiers` (JSON array or NULL):

```json
[{"gid":"a1b2c3d4","oid":"e5f6a7b8","group":"Size","option":"Large","price":0.5}]
```

- Matched selections are re-canonicalized from the DB definition at write time (ids + current names + DB price).
- Unmatched selections (legacy holds, notes-category pseudo-modifiers, deleted options) are kept as sanitized name-only entries — never silently dropped.

## Existing production data compatibility

- Existing `products.modifiers` blobs are migrated in place: old `{name, options:[{name, price}]}` definitions gain server ids without changing visible names/prices.
- Existing finalized/paid historical `order_items` are **not** backfilled. They already have durable `price_at_sale`, `tax_amount`, `note`, and receipt presentation data. Guessing historical structured selections from free-text notes would add risk with no runtime benefit.
- Existing open tables/held orders/split checks created before deploy can only be matched by names until a server write canonicalizes them. Therefore the rollout rule is: run the migration first, deploy backend before frontend, and avoid modifier renames while old open/held/split orders from before the migration still exist. If they are claimed/saved after deploy and names still match, the server upgrades their `selectedModifiers` to id-bearing snapshots.
- A legacy hold created before the migration and then renamed before it is touched cannot be perfectly recovered; the old payload has no stable id. The name fallback keeps behavior no worse than today, and the new server-side canonicalization prevents the same exposure for every payload saved after deploy.

## Invariants (do not violate)

1. **Snapshot is display/identity metadata only. Money is never derived from it.** `price_at_sale` (fold-in) remains the sole money authority; `computeModifierSurcharge` remains the sole surcharge authority. Never recompute totals from the snapshot.
2. Note text format is **unchanged** — both `"Group: Option (X.XX JD)"` (store :2109) and `"Name (+X.XX)"` (PosTerminal :1027-1029). Receipts, spooler, kitchen tickets untouched.
3. Line-identity keys (`product_id|note` in `helpers.js:209-214`, `checkout.js:422-423`, `tables.js:1447-1448,2207-2208`, merge match `tables.js:448-468`) are **unchanged**. The snapshot column is NOT part of any match key.
4. Name fallback must keep every legacy payload (id-less holds/splits parked across the deploy) behaving exactly as today.
5. `sendError` DB-sanitizer: new 400 messages must not contain the words "table"/"exist" or ER_/SQLSTATE patterns, or they get rewritten to a generic error.
6. Never parse `note` to reconstruct modifier ids for old paid history. Only canonicalize structured `selectedModifiers` when it is already present.

## Non-goals (explicitly out of scope)

- Modifier surcharge tax policy (fold-in stays) — now planned in `docs/superpowers/plans/2026-07-12-modifier-surcharge-untaxed.md`. (The previously referenced `2026-07-10-register-modifier-tax-DEFERRED.md` was never created — the finding lived only in session notes.)
- Checkout fingerprint (`orderSessionStore.js:455-499`) unchanged — note+price already distinguish modifier sets except when two same-named same-priced options differ only by id (accepted).
- Refund rows, kitchen-note derivation from structured data, receipt v1 `modifiers` field, notes-category pseudo-modifier ids: all deferred until a feature needs them.
- QR drafts (carry no modifiers at all today).

## Global constraints

- Test runner is **Vitest**: `npx vitest run <files>` — ONE vitest process at a time (shared `posapp_test` DB). Focused files during implementation; full suite exactly ONCE at the end (Task 8).
- Commit after every task. Messages `feat(pos): ...` / `test(pos): ...` as fits.
- FE has no SFC harness — store logic is unit-tested via `backend/tests/unit/orderSessionStore.test.js` (Pinia + mocks, see file head); Vue component changes verified by `npm run build`.
- Schema parity: any DDL goes to `backend/tests/fixtures/seed.js` AND a migration file; `scripts/validate-schema-drift.js` compares dev vs test DBs live, so apply the migration to the dev DB too before running it.

## File map

| File | Change |
|---|---|
| `backend/services/modifierDefs.js` | **Create** — definition canonicalizer + id assigner |
| `backend/routes/admin/products.js` | Wire canonicalizer into POST/PUT (:184-187, :234) |
| `backend/migrations/2026-07-12-modifier-stable-ids.sql` + `apply-modifier-stable-ids.js` | **Create** — add column + backfill definition ids |
| `backend/tests/fixtures/seed.js` | `order_items` CREATE gains `selected_modifiers` (:411 area) |
| `backend/services/PosCalculator.js` | `sanitizeSelectedModifiers`, id-first `findModifierOption`, `buildSelectedModifiersSnapshot`; `normalizeCartItems` sanitizes (:29-48, :137-154) |
| `backend/routes/pos/checkout.js` | INSERT writes snapshot (:914-940) |
| `backend/routes/pos/orders.js` | held-order save canonicalizes `cart_data.items[*].selectedModifiers` before storage/claim reuse |
| `backend/routes/pos/tables.js` | save INSERT (:1797-1823), merge copies (:425-426, :476-477), split held `cart_data` canonicalization, GET table_order emits (:1042-1057) |
| `assets/js/composables/stores/orderSessionStore.js` | `confirmModifiers` carries ids (:2110-2114); `restoreTableSplit` (:1571-1586) + `loadOrderForEditing` (:1662-1677) re-attach field |
| Tests | `backend/tests/unit/modifierDefs.test.js` (new), `PosCalculator.test.js`, `orderSessionStore.test.js`, `integration/products.test.js`, `checkout.test.js`, `tables.test.js`, `heldOrders.test.js` |

---

### Task 0: Anchor re-verification (no code)

- [ ] **Step 1:** Confirm the working tree contains the receipt-display-consistency changes: `git merge-base --is-ancestor 62891d9d HEAD` must exit 0, or `git log --oneline --decorate -20` must show `62891d9d` on the current branch history.
- [ ] **Step 2:** Spot-check the five load-bearing anchors; if any quoted code moved, update your working notes (not this doc) with the new lines:
  - `computeModifierSurcharge` at `backend/services/PosCalculator.js:137`
  - order_items INSERT at `backend/routes/pos/checkout.js:926` and `backend/routes/pos/tables.js:1809`
  - GET table_order cart build at `backend/routes/pos/tables.js:1042`
  - `confirmModifiers` push at `assets/js/composables/stores/orderSessionStore.js:2110`

### Task 1: Definition canonicalizer (`modifierDefs.js`)

**Files:**
- Create: `backend/services/modifierDefs.js`
- Test: `backend/tests/unit/modifierDefs.test.js`

**Interfaces:**
- Produces: `normalizeModifierDefinition(raw) -> Array|null` — validates an admin-supplied definition (string or array), assigns generated 8-hex ids to any group/option missing one, preserves valid existing ids matching `/^[A-Za-z0-9_-]{1,32}$/`, throws `Error(message)` on invalid shape. Used by Task 2 (admin routes) and Task 3 (backfill).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/unit/modifierDefs.test.js
import { describe, it, expect } from 'vitest';
const { normalizeModifierDefinition } = require('../../services/modifierDefs');

describe('normalizeModifierDefinition', () => {
    it('assigns ids to groups and options missing them', () => {
        const out = normalizeModifierDefinition([{ name: 'Size', options: [{ name: 'Large', price: 2 }] }]);
        expect(out[0].id).toMatch(/^[a-f0-9]{8}$/);
        expect(out[0].options[0].id).toMatch(/^[a-f0-9]{8}$/);
        expect(out[0].options[0].price).toBe(2);
    });

    it('preserves valid existing ids and renames in place', () => {
        const out = normalizeModifierDefinition([
            { id: 'g1', name: 'Size Renamed', options: [{ id: 'o1', name: 'XL', price: 3 }] }
        ]);
        expect(out[0].id).toBe('g1');
        expect(out[0].options[0].id).toBe('o1');
        expect(out[0].options[0].name).toBe('XL');
    });

    it('re-mints a duplicated id instead of keeping the collision', () => {
        const out = normalizeModifierDefinition([
            { id: 'dup', name: 'A', options: [{ id: 'dup', name: 'x', price: 0 }] }
        ]);
        expect(out[0].id).toBe('dup');
        expect(out[0].options[0].id).not.toBe('dup');
    });

    it('accepts a JSON string and returns null for empty inputs', () => {
        expect(normalizeModifierDefinition(null)).toBeNull();
        expect(normalizeModifierDefinition('')).toBeNull();
        expect(normalizeModifierDefinition('[]')).toBeNull();
        const out = normalizeModifierDefinition('[{"name":"S","options":[{"name":"a","price":"1.5"}]}]');
        expect(out[0].options[0].price).toBe(1.5); // numeric-string coerced
    });

    it('preserves common legacy string booleans during backfill', () => {
        const out = normalizeModifierDefinition([
            { name: 'Sauce', required: '1', multi_select: 'true', options: [{ name: 'Hot', price: 0 }] }
        ]);
        expect(out[0].required).toBe(true);
        expect(out[0].multi_select).toBe(true);
    });

    it('rejects invalid shapes with a clear error', () => {
        expect(() => normalizeModifierDefinition('not json')).toThrow(/JSON/);
        expect(() => normalizeModifierDefinition({ name: 'x' })).toThrow(/list/);
        expect(() => normalizeModifierDefinition([{ name: '', options: [{ name: 'a', price: 0 }] }])).toThrow(/name/);
        expect(() => normalizeModifierDefinition([{ name: 'G', options: [] }])).toThrow(/option/);
        expect(() => normalizeModifierDefinition([{ name: 'G', options: [{ name: 'a', price: -1 }] }])).toThrow(/price/);
        expect(() => normalizeModifierDefinition([{ name: 'G', options: [{ name: 'a', price: 'abc' }] }])).toThrow(/price/);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/tests/unit/modifierDefs.test.js`
Expected: FAIL — cannot find module `../../services/modifierDefs`.

- [ ] **Step 3: Implement**

```js
// backend/services/modifierDefs.js
// Canonicalizes an admin-supplied product modifier definition.
// Stable ids: 8-hex, unique within the product, survive renames because the
// admin UI round-trips the parsed JSON (ProductModal keeps unknown fields).
const crypto = require('crypto');

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

const toBool = (value) => value === true || value === 1 || value === '1' || value === 'true';

const normalizeModifierDefinition = (raw) => {
    if (raw === undefined || raw === null || raw === '') return null;
    let parsed = raw;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { throw new Error('Modifiers must be valid JSON.'); }
    }
    if (parsed === null) return null;
    if (!Array.isArray(parsed)) throw new Error('Modifiers must be a list of groups.');
    if (parsed.length === 0) return null;
    if (parsed.length > 50) throw new Error('Too many modifier groups (max 50).');

    const assigned = new Set();
    const claim = (id) => {
        if (typeof id === 'string' && ID_RE.test(id) && !assigned.has(id)) { assigned.add(id); return id; }
        let fresh;
        do { fresh = crypto.randomBytes(4).toString('hex'); } while (assigned.has(fresh));
        assigned.add(fresh);
        return fresh;
    };

    return parsed.map((g) => {
        if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error('Each modifier group must be an object.');
        const name = typeof g.name === 'string' ? g.name.trim() : '';
        if (!name || name.length > 100) throw new Error('Each modifier group needs a name (max 100 chars).');
        if (!Array.isArray(g.options) || g.options.length === 0) throw new Error(`Modifier group "${name}" needs at least one option.`);
        if (g.options.length > 100) throw new Error(`Modifier group "${name}" has too many options (max 100).`);
        return {
            id: claim(g.id),
            name,
            required: toBool(g.required),
            multi_select: toBool(g.multi_select),
            options: g.options.map((o) => {
                if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`Options of "${name}" must be objects.`);
                const optName = typeof o.name === 'string' ? o.name.trim() : '';
                if (!optName || optName.length > 100) throw new Error(`Each option of "${name}" needs a name (max 100 chars).`);
                const price = (o.price === undefined || o.price === null || o.price === '') ? 0 : Number(o.price);
                if (!Number.isFinite(price) || price < 0 || price > 10000) throw new Error(`Option "${optName}" has an invalid price.`);
                return { id: claim(o.id), name: optName, price };
            })
        };
    });
};

module.exports = { normalizeModifierDefinition };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run backend/tests/unit/modifierDefs.test.js`
Expected: PASS (all 6).

- [ ] **Step 5: Commit** — `git add backend/services/modifierDefs.js backend/tests/unit/modifierDefs.test.js && git commit -m "feat(pos): modifier definition canonicalizer with stable ids"`

### Task 2: Wire canonicalizer into admin products routes

**Files:**
- Modify: `backend/routes/admin/products.js:184-187` (POST) and `:234` (PUT)
- Test: `backend/tests/integration/products.test.js`

**Interfaces:**
- Consumes: `normalizeModifierDefinition` (Task 1).
- Produces: every stored `products.modifiers` blob is canonical (ids everywhere); invalid definitions get 400.

- [ ] **Step 1: Write the failing test** (append inside the existing `describe('Admin products route')` — harness: supertest + `adminCookie`, see file head)

```js
    test('POST/PUT canonicalize modifiers: ids assigned, preserved across rename, garbage rejected', async () => {
        const create = await request(app).post('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({
                name: '_mod_ids_probe', price: '11.60', tax_rate: 16,
                modifiers: [{ name: 'Size', options: [{ name: 'Large', price: 2 }] }]
            });
        expect(create.body.success).toBe(true);
        const id = create.body.id;

        const [[row]] = await pool.query('SELECT modifiers FROM products WHERE id = ?', [id]);
        const stored = JSON.parse(row.modifiers);
        expect(stored[0].id).toMatch(/^[a-f0-9]{8}$/);
        expect(stored[0].options[0].id).toMatch(/^[a-f0-9]{8}$/);
        const gid = stored[0].id, oid = stored[0].options[0].id;

        // Rename option, echoing ids back (as ProductModal does) — ids must survive.
        stored[0].options[0].name = 'Extra Large';
        const put = await request(app).put('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ id, modifiers: stored });
        expect(put.body.success).toBe(true);
        const [[row2]] = await pool.query('SELECT modifiers FROM products WHERE id = ?', [id]);
        const stored2 = JSON.parse(row2.modifiers);
        expect(stored2[0].id).toBe(gid);
        expect(stored2[0].options[0].id).toBe(oid);
        expect(stored2[0].options[0].name).toBe('Extra Large');

        // Garbage shape → 400, stored blob untouched.
        const bad = await request(app).put('/api/admin/products')
            .set('Cookie', adminCookie)
            .send({ id, modifiers: [{ name: 'G', options: [{ name: 'a', price: 'NaN' }] }] });
        expect(bad.statusCode).toBe(400);
        const [[row3]] = await pool.query('SELECT modifiers FROM products WHERE id = ?', [id]);
        expect(JSON.parse(row3.modifiers)[0].options[0].name).toBe('Extra Large');

        await pool.query('DELETE FROM products WHERE id = ?', [id]);
    });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/tests/integration/products.test.js`
Expected: FAIL — stored `modifiers[0].id` is `undefined`.

- [ ] **Step 3: Implement.** At the top of `products.js` add `const { normalizeModifierDefinition } = require('../../services/modifierDefs');`. Replace POST lines 184-187:

```js
            let modifiers = null;
            if (data.modifiers !== undefined) {
                try {
                    const canonical = normalizeModifierDefinition(data.modifiers);
                    modifiers = canonical ? JSON.stringify(canonical) : null;
                } catch (e) {
                    return sendError(res, 400, e.message);
                }
            }
```

Replace PUT line 234 (`if (has('modifiers')) put('modifiers', ...)`):

```js
            if (has('modifiers')) {
                try {
                    const canonical = normalizeModifierDefinition(data.modifiers);
                    put('modifiers', canonical ? JSON.stringify(canonical) : null);
                } catch (e) {
                    return sendError(res, 400, e.message);
                }
            }
```

(Verify the PUT handler can `return sendError(...)` at that point without leaking a transaction — this route uses plain `pool.query`, no transaction, per current code.)

- [ ] **Step 4: Run to verify it passes** — `npx vitest run backend/tests/integration/products.test.js` → PASS. Also run `npx vitest run backend/tests/unit/helpers.test.js backend/tests/unit/PosCalculator.test.js` to confirm no name-matching regression yet.
- [ ] **Step 5: Commit** — `git commit -am "feat(pos): validate + canonicalize modifier definitions on admin save"`

### Task 3: Schema migration + backfill

**Files:**
- Create: `backend/migrations/2026-07-12-modifier-stable-ids.sql`, `backend/migrations/apply-modifier-stable-ids.js`
- Modify: `backend/tests/fixtures/seed.js` (order_items CREATE, after `note text DEFAULT NULL,` at :411)

- [ ] **Step 1: SQL file**

```sql
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS selected_modifiers longtext DEFAULT NULL;
```

(No CHECK constraint: the server is the only writer and always writes `JSON.stringify` output or NULL. Do **not** use `AFTER note` in production DDL; this repo commonly runs MariaDB 10.4, and appending the nullable column is the safer/no-physical-order-dependency shape. The schema drift script does not compare column order.)

- [ ] **Step 2: Apply script** — mirror `apply-orders-tax-mode-at-sale.js` exactly (env gate, idempotent column probe), then backfill definition ids:

```js
// backend/migrations/apply-modifier-stable-ids.js
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { normalizeModifierDefinition } = require('../services/modifierDefs');

const envFile = process.env.NODE_ENV === 'test' ? '../../.env.test' : '../../.env';
require('dotenv').config({ path: path.join(__dirname, envFile), override: true });

async function run() {
    if (process.env.MODIFIER_IDS_MIGRATION_CONFIRM !== 'apply-modifier-ids') {
        throw new Error('Set MODIFIER_IDS_MIGRATION_CONFIRM=apply-modifier-ids to continue.');
    }
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'posapp',
        charset: 'utf8mb4',
        multipleStatements: true
    });
    try {
        const [[existing]] = await conn.query(`
            SELECT COUNT(*) AS count FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'selected_modifiers'
        `);
        if (Number(existing.count) === 0) {
            await conn.query(fs.readFileSync(path.join(__dirname, '2026-07-12-modifier-stable-ids.sql'), 'utf8'));
            console.log('order_items.selected_modifiers added.');
        } else {
            console.log('Column selected_modifiers already exists. Skipping DDL.');
        }

        // Backfill stable ids into every product's modifier definition (idempotent:
        // a second run finds all ids present and rewrites nothing).
        const [products] = await conn.query("SELECT id, modifiers FROM products WHERE modifiers IS NOT NULL AND modifiers != ''");
        let updated = 0;
        const skipped = [];
        for (const p of products) {
            let canonical;
            try { canonical = normalizeModifierDefinition(p.modifiers); }
            catch (e) { skipped.push({ productId: p.id, reason: e.message }); continue; }
            const json = canonical ? JSON.stringify(canonical) : null;
            if (json !== p.modifiers) {
                await conn.query('UPDATE products SET modifiers = ? WHERE id = ?', [json, p.id]);
                updated++;
            }
        }
        if (skipped.length > 0) {
            console.error('Modifier-id backfill refused to continue because some products have invalid modifier JSON:');
            for (const row of skipped) console.error(`  product ${row.productId}: ${row.reason}`);
            console.error('Fix those products in admin or SQL, then rerun this migration. No historical order_items backfill is required.');
            process.exitCode = 1;
            return;
        }
        console.log(`Backfill done: ${updated} products updated, 0 skipped.`);
    } finally {
        await conn.end();
    }
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
```

- [ ] **Step 3: seed.js** — in the `order_items` CREATE TABLE (:402-424), after the `parent_item_id int(11) DEFAULT NULL,` line add:

```sql
          selected_modifiers longtext DEFAULT NULL,
```

- [ ] **Step 4: Apply + verify.** Run against the DEV database: `MODIFIER_IDS_MIGRATION_CONFIRM=apply-modifier-ids node backend/migrations/apply-modifier-stable-ids.js` (PowerShell: `$env:MODIFIER_IDS_MIGRATION_CONFIRM='apply-modifier-ids'; node backend/migrations/apply-modifier-stable-ids.js`). Then run it AGAIN — expect "already exists" + "Backfill done: 0 products updated, 0 skipped." (idempotence proof). If it exits nonzero with skipped products, stop and fix those product modifier definitions; do not deploy code with invalid/id-less production modifier blobs. Then `node scripts/validate-schema-drift.js` — expect no drift (test DB rebuilds from seed.js on test runs; if drift is reported for `selected_modifiers`, run any seeded test once, e.g. `npx vitest run backend/tests/integration/products.test.js`, and re-check).
- [ ] **Step 5: Commit** — `git add backend/migrations backend/tests/fixtures/seed.js && git commit -m "feat(pos): order_items.selected_modifiers column + definition id backfill"`

**PROD NOTE (do not lose):** production deploy must run `apply-modifier-stable-ids.js` before this code ships traffic. Existing paid order history is intentionally untouched. If the script reports skipped products, production rollout stops until those product modifier definitions are cleaned. Add to the deploy runbook alongside the pending receipt/service-charge migrations.

### Task 4: id-first matching + sanitization + snapshot builder

**Files:**
- Modify: `backend/services/PosCalculator.js` — `normalizeCartItems` (:29-48), `computeModifierSurcharge` (:137-154), new exports
- Test: `backend/tests/unit/PosCalculator.test.js`

**Interfaces:**
- Produces:
  - `sanitizeSelectedModifiers(value) -> Array|null` — trust-boundary shape filter.
  - `buildSelectedModifiersSnapshot(product, line) -> Array|null` — entries `{gid?, oid?, group, option, price?}`; matched entries carry DB ids/names/price, unmatched pass through sanitized.
  - `computeModifierSurcharge(product, line) -> number` — unchanged signature, now id-first matching.
  - `normalizeCartItems` output lines have sanitized `selectedModifiers`.

- [ ] **Step 1: Write the failing tests** (append to `PosCalculator.test.js`; keep existing tests untouched — they prove name-fallback compatibility)

```js
describe('modifier stable ids', () => {
    const { computeModifierSurcharge, buildSelectedModifiersSnapshot, sanitizeSelectedModifiers, normalizeCartItems } = require('../../services/PosCalculator');

    const product = {
        modifiers: [{
            id: 'g1', name: 'Size',
            options: [{ id: 'o1', name: 'Large', price: 2 }, { id: 'o2', name: 'XL', price: 3 }]
        }]
    };

    it('matches by id even after group and option are renamed', () => {
        const renamed = JSON.parse(JSON.stringify(product));
        renamed.modifiers[0].name = 'Cup Size';
        renamed.modifiers[0].options[0].name = 'Grande';
        const line = { selectedModifiers: [{ gid: 'g1', oid: 'o1', group: 'Size', option: 'Large' }] };
        expect(computeModifierSurcharge(renamed, line)).toBe(2);
    });

    it('falls back to name matching for id-less legacy selections', () => {
        const line = { selectedModifiers: [{ group: 'Size', option: 'XL' }] };
        expect(computeModifierSurcharge(product, line)).toBe(3);
    });

    it('unknown ids AND unknown names yield zero (forgery-safe)', () => {
        const line = { selectedModifiers: [{ gid: 'zz', oid: 'zz', group: 'Nope', option: 'Nope', price: 99 }] };
        expect(computeModifierSurcharge(product, line)).toBe(0);
    });

    it('snapshot canonicalizes matched entries from the DB definition', () => {
        const line = { selectedModifiers: [{ group: 'Size', option: 'Large', price: 999 }] };
        expect(buildSelectedModifiersSnapshot(product, line)).toEqual([
            { gid: 'g1', oid: 'o1', group: 'Size', option: 'Large', price: 2 }
        ]);
    });

    it('snapshot keeps unmatched entries sanitized instead of dropping them', () => {
        const line = { selectedModifiers: [{ group: 'Extra Cheese', option: 'Extra Cheese', price: 0.5 }] };
        expect(buildSelectedModifiersSnapshot(product, line)).toEqual([
            { group: 'Extra Cheese', option: 'Extra Cheese', price: 0.5 }
        ]);
        expect(buildSelectedModifiersSnapshot(null, line)).toEqual([
            { group: 'Extra Cheese', option: 'Extra Cheese', price: 0.5 }
        ]);
    });

    it('sanitizer strips garbage at the trust boundary', () => {
        expect(sanitizeSelectedModifiers('not an array')).toBeNull();
        expect(sanitizeSelectedModifiers([])).toBeNull();
        expect(sanitizeSelectedModifiers([null, 42, { group: '', option: 'x' }, { group: 'ok', option: 'ok', price: 'evil', gid: { a: 1 } }]))
            .toEqual([{ group: 'ok', option: 'ok' }]);
    });

    it('normalizeCartItems sanitizes selectedModifiers in its output', () => {
        const [line] = normalizeCartItems([{ id: 1, qty: 1, price: 5, selectedModifiers: [{ group: 'Size', option: 'Large', junk: 'x' }] }]);
        expect(line.selectedModifiers).toEqual([{ group: 'Size', option: 'Large' }]);
        const [bare] = normalizeCartItems([{ id: 1, qty: 1, price: 5, selectedModifiers: 'garbage' }]);
        expect(bare.selectedModifiers).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run backend/tests/unit/PosCalculator.test.js` → FAIL (missing exports).
- [ ] **Step 3: Implement** in `PosCalculator.js`:

```js
const MOD_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

// Trust boundary: selectedModifiers arrives from the client (checkout, hold,
// table save, split). Money never derives from it (DB prices win), but it is
// persisted and replayed — so cap sizes and strip everything non-conforming.
const sanitizeSelectedModifiers = (value) => {
    if (!Array.isArray(value) || value.length === 0) return null;
    const out = [];
    for (const raw of value.slice(0, 50)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const group = typeof raw.group === 'string' ? raw.group.trim().slice(0, 120) : '';
        const option = typeof raw.option === 'string' ? raw.option.trim().slice(0, 120) : '';
        if (!group || !option) continue;
        const entry = { group, option };
        if (typeof raw.gid === 'string' && MOD_ID_RE.test(raw.gid)) entry.gid = raw.gid;
        if (typeof raw.oid === 'string' && MOD_ID_RE.test(raw.oid)) entry.oid = raw.oid;
        const price = Number(raw.price);
        if (raw.price !== undefined && Number.isFinite(price) && price >= 0 && price <= 10000) entry.price = price;
        out.push(entry);
    }
    return out.length > 0 ? out : null;
};

// id-first, name-fallback resolution of one selection against the product's
// definition. Ids survive renames; names keep legacy (pre-id) payloads working.
const findModifierOption = (product, selected) => {
    if (!product || !Array.isArray(product.modifiers)) return null;
    const group =
        (selected.gid && product.modifiers.find((m) => m && m.id === selected.gid)) ||
        product.modifiers.find((m) => m && m.name === selected.group);
    if (!group || !Array.isArray(group.options)) return null;
    const option =
        (selected.oid && group.options.find((o) => o && o.id === selected.oid)) ||
        group.options.find((o) => o && o.name === selected.option);
    return option ? { group, option } : null;
};

// Display/identity snapshot persisted to order_items.selected_modifiers.
// Matched entries are re-canonicalized from the DB definition (ids, current
// names, DB price). Unmatched entries pass through sanitized. NEVER a money source.
const buildSelectedModifiersSnapshot = (product, line) => {
    const sanitized = sanitizeSelectedModifiers(line && line.selectedModifiers);
    if (!sanitized) return null;
    return sanitized.map((sel) => {
        const match = findModifierOption(product, sel);
        if (!match) return sel;
        const entry = {
            group: match.group.name,
            option: match.option.name,
            price: toFiniteNumber(match.option.price, 0)
        };
        if (match.group.id) entry.gid = match.group.id;
        if (match.option.id) entry.oid = match.option.id;
        return entry;
    });
};
```

Rewrite `computeModifierSurcharge`'s loop body (:142-152) to use the shared resolver — behavior identical for name-only data:

```js
    for (const selected of line.selectedModifiers) {
        const match = findModifierOption(product, selected);
        if (match) surcharge += toFiniteNumber(match.option.price, 0);
    }
```

In `normalizeCartItems` (:39-46) add one line to the returned object:

```js
            selectedModifiers: sanitizeSelectedModifiers(item.selectedModifiers),
```

Export `sanitizeSelectedModifiers` and `buildSelectedModifiersSnapshot` from the module.exports block (keep `computeModifierSurcharge` exported as before; `findModifierOption` stays internal).

> Snapshot key order note: the test in Step 1 uses `toEqual`, which ignores key order — safe.

- [ ] **Step 4: Run** — `npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/unit/helpers.test.js` → PASS (existing modifier-surcharge-recovery tests in helpers.test.js:299-357 must stay green — they prove name fallback).
- [ ] **Step 5: Commit** — `git commit -am "feat(pos): id-first modifier matching + sanitized selection snapshot"`

### Task 5: Persist/canonicalize snapshots at every live write site

**Files:**
- Modify: `backend/routes/pos/checkout.js` (:914-940), `backend/routes/pos/orders.js` (held save/claim), `backend/routes/pos/tables.js` (save :1797-1823, merge :425-426 and :476-477, split held rows :2422-2443)
- Test: `backend/tests/integration/checkout.test.js`, `backend/tests/integration/heldOrders.test.js`, `backend/tests/integration/tables.test.js`

**Interfaces:**
- Consumes: `buildSelectedModifiersSnapshot` (Task 4). `product` is already in scope in the `order_items` insert loops (`checkout.js:915`, `tables.js:1798`). Held-order and split canonicalization use the existing `productMap`/`splitProductMap`.

- [ ] **Step 1: Write the failing checkout test** (append inside `checkout.test.js`'s main describe; helpers `openShift()`, `cashierCookie`, `cashierShiftId` per the existing modifier test at :1665)

```js
    it('persists a DB-canonical selected_modifiers snapshot on checkout', async () => {
        await openShift();
        const modifiersJson = JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 0.50 }] }]);
        await pool.query("UPDATE products SET modifiers = ? WHERE id = 1", [modifiersJson]);

        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{
                id: SEED.product1.id,
                qty: 1,
                price: 5.50,
                note: 'Size: Large (0.50 JD)',
                // client lies about price + sends junk field — snapshot must store DB truth
                selectedModifiers: [{ group: 'Size', option: 'Large', price: 99, junk: 'x' }]
            }],
            shift_id: cashierShiftId,
            subtotal: 5.50, tax: 0.88, total: 6.38, amount_tendered: 10, payment_method: 'cash', change_due: 3.62
        });
        expect(res.statusCode).toBe(200);

        const [[row]] = await pool.query(
            "SELECT selected_modifiers FROM order_items WHERE invoice_id = ? AND product_id = 1",
            [res.body.invoice_id]
        );
        expect(JSON.parse(row.selected_modifiers)).toEqual([
            { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0.5 }
        ]);
        await pool.query("UPDATE products SET modifiers = NULL WHERE id = 1");
    });

    it('stores NULL selected_modifiers for plain lines', async () => {
        await openShift();
        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: SEED.product1.id, qty: 1, price: 5.00 }],
            shift_id: cashierShiftId,
            subtotal: 5.00, tax: 0.80, total: 5.80, amount_tendered: 10, payment_method: 'cash', change_due: 4.20
        });
        expect(res.statusCode).toBe(200);
        const [[row]] = await pool.query(
            "SELECT selected_modifiers FROM order_items WHERE invoice_id = ?",
            [res.body.invoice_id]
        );
        expect(row.selected_modifiers).toBeNull();
    });
```

(If `res.body.invoice_id` is not in the checkout response, look up the invoice via the newest `orders` row for `cashierShiftId` — copy how the nearest existing test in this file resolves it.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run backend/tests/integration/checkout.test.js` → FAIL (`Unknown column 'selected_modifiers'` is NOT expected — seed already added it in Task 3; expected failure is `row.selected_modifiers` = null vs snapshot).
- [ ] **Step 3: Implement order_items persistence.**

In `checkout.js`, extend the PosCalculator require to include `buildSelectedModifiersSnapshot`. In the insert loop, before the INSERT (:925):

```js
                const modifierSnapshot = buildSelectedModifiersSnapshot(product, item);
```

Change the INSERT (:926) column list and params:

```js
                    "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, note, selected_modifiers, discount_type, discount_value, sort_order, parent_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
```

with `modifierSnapshot ? JSON.stringify(modifierSnapshot) : null` inserted after `item.note || null`.

In `tables.js` table-save insert loop (:1797-1823): identical change (same two lines).

In `tables.js` merge — both copy INSERTs get the column, values from the source row (sourceItems is `SELECT *` at :395, so the field is present):
- Bundle-parent copy (:425-426): add `selected_modifiers` after `note` in the column list and `item.selected_modifiers` after `item.note` in params.
- Normal-line fresh copy (:476-477): same. (The qty-increment branch :469-473 is untouched — the note-keyed match already implies same modifiers.)

- [ ] **Step 4: Implement live held/split JSON canonicalization.** This closes the stale-frontend/old-open-order gap: if a client sends name-only `selectedModifiers`, the server stores/returns an id-bearing snapshot as soon as names still match the DB.

In `backend/routes/pos/orders.js`, extend the existing PosCalculator require:

```js
const { calculateExpectedTotals, validateTaxRate, buildSelectedModifiersSnapshot } = require('../../services/PosCalculator');
```

In `POST /held_orders`, after `applyDatabasePrices(...)` and before `cartPayload.items = items`, canonicalize every non-fee line:

```js
        for (const item of items) {
            if (item.note === 'Auto-Gratuity') continue;
            const product = item.product_id != null ? productMap.get(item.product_id) : null;
            item.selectedModifiers = buildSelectedModifiersSnapshot(product, item);
        }
```

In `POST /held_orders/claim`, after `const productMap = await fetchCartProducts(conn, items);` and before `const originalItems = JSON.parse(JSON.stringify(items));`, canonicalize the claimed payload too. This upgrades old id-less held rows when their names still match:

```js
        for (const item of items) {
            if (item.note === 'Auto-Gratuity') continue;
            const product = item.product_id != null ? productMap.get(item.product_id) : null;
            item.selectedModifiers = buildSelectedModifiersSnapshot(product, item);
        }
```

In `backend/routes/pos/tables.js`, extend the PosCalculator require at the top:

```js
const { resolveLineTaxRate, buildSelectedModifiersSnapshot } = require('../../services/PosCalculator');
```

After `const splitProductMap = await fetchCartProducts(...)` in the split route and before parent-line pinning, canonicalize split-seat items before they are written into `held_orders.cart_data`:

```js
            for (const { normalizedItems } of normalizedSplits) {
                for (const item of normalizedItems) {
                    if (item.note === 'Auto-Gratuity') continue;
                    const product = item.product_id != null ? splitProductMap.get(item.product_id) : null;
                    item.selectedModifiers = buildSelectedModifiersSnapshot(product, item);
                }
            }
```

- [ ] **Step 5: Write held-order canonicalization tests** (append to `heldOrders.test.js`; use `SEED.product1` and `cashierCookie` from the existing harness):

```js
    it('stores DB-canonical selectedModifiers in held cart_data for name-only stale clients', async () => {
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
            SEED.product1.id
        ]);

        try {
            const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                reference_name: 'stale-client-mods',
                subtotal: 7.00,
                cart: { items: [{
                    id: SEED.product1.id, qty: 1, price: 7.00, tax_rate: 16,
                    note: 'Size: Large (2.00 JD)',
                    selectedModifiers: [{ group: 'Size', option: 'Large', price: 999 }]
                }] }
            });
            expect(held.statusCode).toBe(200);

            const [[row]] = await pool.query('SELECT cart_data FROM held_orders WHERE id = ?', [held.body.id]);
            const parsed = JSON.parse(row.cart_data);
            expect(parsed.items[0].selectedModifiers).toEqual([
                { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2 }
            ]);
        } finally {
            await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.product1.id]);
        }
    });

    it('claim upgrades an old name-only held row when names still match', async () => {
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
            SEED.product1.id
        ]);
        try {
            const cartData = JSON.stringify({ items: [{
                id: SEED.product1.id, product_id: SEED.product1.id, qty: 1, price: 7.00, tax_rate: 16,
                note: 'Size: Large (2.00 JD)',
                selectedModifiers: [{ group: 'Size', option: 'Large', price: 2 }]
            }] });
            const [ins] = await pool.query(
                'INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal) VALUES (?, ?, ?, ?)',
                [SEED.cashierUser.id, 'legacy-name-only', cartData, 7.00]
            );

            const claim = await request(app).post('/api/pos/held_orders/claim')
                .set('Cookie', cashierCookie).send({ id: ins.insertId });
            expect(claim.statusCode).toBe(200);
            const claimed = JSON.parse(claim.body.order.cart_data);
            expect(claimed.items[0].selectedModifiers).toEqual([
                { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2 }
            ]);
        } finally {
            await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.product1.id]);
        }
    });
```

- [ ] **Step 6: Write the failing merge test** (append to `tables.test.js`, mirroring the harness of the merge tests already in the file — seed two occupied tables where the source order's items were saved with `selected_modifiers`, merge, then):

```js
        const [rows] = await pool.query(
            "SELECT selected_modifiers FROM order_items WHERE invoice_id = ? AND product_id = ? ORDER BY id DESC LIMIT 1",
            [targetInvoiceId, SEED.product1.id]
        );
        expect(JSON.parse(rows[0].selected_modifiers)).toEqual([
            { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0.5 }
        ]);
```

The arrange half: save the source table order through `POST /api/pos/tables/save_table_order` (copy the payload shape from the nearest existing save test in this file) with the cart line carrying `selectedModifiers: [{ group: 'Size', option: 'Large' }]` after setting product 1's definition to Task 5 Step 1's `g_size/o_large` JSON; make the source and target items differ in `note` so the copy branch (not qty-increment) runs.

- [ ] **Step 7: Write the split-held-row canonicalization test** (append to `tables.test.js` inside `describe('Bill Split Calculations & Seat Totals')`):

```js
        it('canonicalizes name-only selectedModifiers before writing split held rows', async () => {
            await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
                JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 0.50 }] }]),
                SEED.product1.id
            ]);

            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{
                    id: SEED.product1.id,
                    qty: 1,
                    price: 5.50,
                    tax_rate: 16,
                    note: 'Size: Large (0.50 JD)',
                    selectedModifiers: [{ group: 'Size', option: 'Large', price: 0.50 }]
                }],
                5.50, 0.88, 6.38
            );

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [{
                        referenceName: 'Seat A',
                        subtotal: 6.38,
                        items: [{
                            id: SEED.product1.id,
                            qty: 1,
                            price: 5.50,
                            tax_rate: 16,
                            note: 'Size: Large (0.50 JD)',
                            selectedModifiers: [{ group: 'Size', option: 'Large', price: 999 }]
                        }]
                    }]
                });
            expect(res.statusCode).toBe(200);

            const [[held]] = await pool.query('SELECT cart_data FROM held_orders WHERE reference_name = ?', ['Seat A']);
            const parsed = JSON.parse(held.cart_data);
            expect(parsed.items[0].selectedModifiers).toEqual([
                { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0.5 }
            ]);
        });
```

This guards the stale-client split path before split settle.
- [ ] **Step 8: Run** — `npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js` → PASS.
- [ ] **Step 9: Commit** — `git commit -am "feat(pos): persist and canonicalize selected modifier snapshots"`

### Task 6: Read-back — server emits, FE re-attaches, selections carry ids

**Files:**
- Modify: `backend/routes/pos/tables.js` GET table_order cart build (:1042-1057)
- Modify: `assets/js/composables/stores/orderSessionStore.js` — `confirmModifiers` (:2110-2114), `restoreTableSplit` (:1571-1586), `loadOrderForEditing` (:1662-1677)
- Test: `backend/tests/integration/tables.test.js`, `backend/tests/unit/orderSessionStore.test.js`

**Interfaces:**
- Consumes: `selected_modifiers` column (Task 5); `admin/order_details` already returns it via `oi.*` (`backend/routes/admin/orders.js:159-171`) — no backend change there. `loadActiveTableOrder` (:830-837) spreads `{...item}` — no FE change there once the API emits the field.

- [ ] **Step 1: Failing integration test** (append to `tables.test.js`): save a table order with a modifier line using the same `g_size/o_large` definition and table-save payload shape from Task 5's merge arrange, then:

```js
        const res = await request(app)
            .get(`/api/pos/table_order?order_id=${orderId}`)
            .set('Cookie', cashierCookie);
        expect(res.statusCode).toBe(200);
        const line = res.body.cart.find((i) => i.id === SEED.product1.id);
        expect(line.selectedModifiers).toEqual([
            { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0.5 }
        ]);
```

Run: `npx vitest run backend/tests/integration/tables.test.js` → FAIL (`selectedModifiers` undefined).

- [ ] **Step 2: Backend emit.** In the GET table_order cart build (`tables.js:1042-1057`) add to `cartItem`:

```js
                selectedModifiers: (() => {
                    if (!item.selected_modifiers) return null;
                    try {
                        const parsed = JSON.parse(item.selected_modifiers);
                        return Array.isArray(parsed) ? parsed : null;
                    } catch { return null; }
                })(),
```

Re-run the test → PASS.

- [ ] **Step 3: FE — carry ids at creation.** `confirmModifiers` push (:2110-2114) becomes:

```js
        selectedModifiers.push({
          gid: group.id,
          oid: opt.id,
          group: group.name,
          option: opt.name,
          price: priceExt
        });
```

(`group.id`/`opt.id` are undefined until the definition is saved post-backfill — `JSON.stringify` drops undefined keys, and the sanitizer ignores non-string ids, so pre-backfill payloads are exactly today's.)

- [ ] **Step 4: FE — re-attach on the two explicit rebuilds.**

`restoreTableSplit` splitItems map (:1571-1586), after the `note` line add:

```js
        selectedModifiers: item.selectedModifiers || null,
```

`loadOrderForEditing` cart map (:1662-1677), after the `note` line add (order_details returns the raw DB string):

```js
          selectedModifiers: (() => {
            const rawMods = item.selected_modifiers;
            if (Array.isArray(rawMods)) return rawMods;
            if (typeof rawMods !== 'string' || !rawMods) return null;
            try {
              const parsed = JSON.parse(rawMods);
              return Array.isArray(parsed) ? parsed : null;
            } catch { return null; }
          })(),
```

- [ ] **Step 5: Store unit test** (append to `backend/tests/unit/orderSessionStore.test.js`, using its existing Pinia setup — find the nearest test that calls a restore action and mirror its store bootstrap):

```js
    it('restoreTableSplit re-attaches selectedModifiers from split items', async () => {
        const store = useOrderSessionStore();
        const splitCheck = {
            id: 77,
            reference_name: 'Table 5 - Seat 1',
            items: [{
                id: 1, name: 'Burger', price: 5.5, qty: 1, note: 'Size: Large (0.50 JD)',
                order_item_id: 42,
                selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0.5 }]
            }],
            parent_invoice_id: 9, parent_order_id: 3
        };
        await store.restoreTableSplit(splitCheck, {});
        expect(store.cart[0].selectedModifiers).toEqual(splitCheck.items[0].selectedModifiers);
    });
```

(If `restoreTableSplit` needs `loadTableWorkspace` mocked, stub the fetch the same way the file's other table tests do.)

- [ ] **Step 6: Run** — `npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/integration/tables.test.js` → PASS. Then `npm run build` → must succeed (FE changes).
- [ ] **Step 7: Commit** — `git commit -am "feat(pos): selections carry stable ids and survive every cart rebuild"`

### Task 7: Headline regression — rename no longer drops the surcharge

**Files:**
- Test: `backend/tests/integration/checkout.test.js`

This is the end-to-end proof of the bug this plan exists to fix: hold a cart with an id-bearing selection, rename the option in admin, claim the hold, then checkout the claimed cart. Claim alone is a false-green because it returns the frozen held display price even on master; checkout is where name-only matching currently drops the surcharge and rejects the correct total.

- [ ] **Step 1: Write the failing test** (append near the existing held modifier tamper test in `checkout.test.js`; use existing `openShift()`, `cashierCookie`, and `cashierShiftId`):

```js
    it('checks out a held modifier line at DB surcharge after the option was renamed (stable id match)', async () => {
        await openShift();
        const modifiersJson = JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]);
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [modifiersJson, SEED.modifierProduct.id]);

        const holdRes = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
            reference_name: 'rename-probe',
            cart: { items: [{
                id: SEED.modifierProduct.id, qty: 1, price: 7.00, tax_rate: 16,
                note: 'Size: Large (2.00 JD)',
                selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2.00 }]
            }] },
            subtotal: 7.00
        });
        expect(holdRes.body.success).toBe(true);

        // Rename BOTH group and option (ids preserved) — the old name-match would now fail.
        const renamedJson = JSON.stringify([{ id: 'g_size', name: 'Cup Size', options: [{ id: 'o_large', name: 'Grande', price: 2.00 }] }]);
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [renamedJson, SEED.modifierProduct.id]);

        const claim = await request(app).post('/api/pos/held_orders/claim')
            .set('Cookie', cashierCookie).send({ id: holdRes.body.id });
        expect(claim.statusCode).toBe(200);
        const claimedItems = JSON.parse(claim.body.order.cart_data).items;

        const pay = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: claimedItems,
            shift_id: cashierShiftId,
            subtotal: 7.00,
            tax: 1.12,
            total: 8.12,
            payment_method: 'cash',
            amount_tendered: 8.12,
            change_due: 0,
            idempotency_key: 'held_mod_rename_stable_id'
        });
        expect(pay.statusCode).toBe(200);

        const [[line]] = await pool.query(
            'SELECT price_at_sale, tax_amount FROM order_items WHERE invoice_id = ? AND product_id = ?',
            [pay.body.invoice_id, SEED.modifierProduct.id]
        );
        expect(Number(line.price_at_sale)).toBe(7.00);
        expect(Number(line.tax_amount)).toBe(1.12);
    });
```

- [ ] **Step 2: Verify the red boundary by temporarily disabling id matching** — this task is written after Tasks 4-6, so the new test is expected to be green on the real branch. To prove it locks the original bug, make this **temporary, uncommitted** edit in `backend/services/PosCalculator.js`:

```js
const findModifierOption = (product, selected) => {
    if (!product || !Array.isArray(product.modifiers)) return null;
    const group = product.modifiers.find((m) => m && m.name === selected.group);
    if (!group || !Array.isArray(group.options)) return null;
    const option = group.options.find((o) => o && o.name === selected.option);
    return option ? { group, option } : null;
};
```

Run: `npx vitest run backend/tests/integration/checkout.test.js` → FAIL with checkout returning 400 `Subtotal mismatch...`. Do not accept a claim-only pass; the assertion must reach checkout/persisted `price_at_sale`. Restore the Task 4 id-first version before continuing (`git restore -- backend/services/PosCalculator.js` is safe only if this temporary edit is the only uncommitted change in that file).
- [ ] **Step 3: Run with id-first matching restored** — `npx vitest run backend/tests/integration/checkout.test.js` → PASS.
- [ ] **Step 4: Commit** — `git commit -am "test(pos): held checkout keeps surcharge across option rename"`

### Task 8: Full verification + docs

- [ ] **Step 1:** Full suite, exactly once: `npx vitest run` — ALL green (merged-master baseline before this plan: 91 files / 1162 tests; expect that plus this plan's new tests).
- [ ] **Step 2:** `npm run build` — green.
- [ ] **Step 3:** On any failure: rerun ONLY the failing files, fix, then one final full run.
- [ ] **Step 4:** Update the deploy runbook in `docs/superpowers/runbooks/` with: run `apply-modifier-stable-ids.js` on prod BEFORE deploying this code; fix any skipped products until the migration exits zero; existing paid history is not backfilled; avoid modifier renames while pre-migration open/held/split orders still exist; deploy backend before frontend; no spooler deploy needed.
- [ ] **Step 5:** Commit docs, then follow superpowers:finishing-a-development-branch.

---

## Self-review notes (written against the spec, fresh-eyes pass)

- **Spec coverage:** restoration (Task 6: table reload auto via spread, split restore, edit invoice), splitting (Task 5 canonicalizes split `held_orders.cart_data`, split settle re-inserts through checkout with server-side payload items `checkout.js:485`), ordinary holds (Task 5 canonicalizes save + claim so stale/name-only clients are upgraded when names still match), bundles (parent lines snapshot like any line; children carry none by design — `processFinalAddToCart` gives subs `selectedModifiers: []`, bundle surcharge lives on the parent), receipts (unchanged by design — note text is already built once at add time and copied through every INSERT; nothing parses it), rename bug (Task 7 tests checkout, not claim-only false green).
- **Ordering:** Task 3 (seed column) must precede Task 5's tests — it does. Task 2 requires Task 1's module. Task 6's integration test requires Task 5's write path.
- **Type consistency:** snapshot entry shape `{gid?, oid?, group, option, price?}` is identical in Task 4 (builder), Task 5 (assertions), Task 6 (emit + FE), Task 7 (payload). `normalizeModifierDefinition` name identical in Tasks 1/2/3.
- **Known accepted edges:** two same-name same-price options differing only by id still collide in the checkout fingerprint (non-goal); a legacy hold/open/split created BEFORE migration and renamed before any post-deploy server write still cannot be recovered — unavoidable, data doesn't exist; merge qty-increment keeps the target row's snapshot (rows matched on identical note, so modifier names/prices are identical); finalized paid history is intentionally not backfilled.
- **Executor warnings:** anchors can drift — match quoted code, not line numbers (Task 0). Task 7 must assert checkout success/persisted line price, not just the claimed cart price. Exact response shapes in Tasks 5/7 (invoice id, claim body) must be copied from adjacent tests in the same files rather than guessed.
