# Recipe ledger

Work on `codex/inventory-recipe-research` in the shared checkout. One commit per task, using the message given. Do not push, merge, or deploy.

**Build:** optional ingredient ledger, off by default (`recipe_ledger_enabled = 0`). When on, sold lines write usage from their recipe (g / ml / count). Refunds and voids reverse the same quantities. Admin posts receipts, waste (with reason), and counts. After a count, the UI shows expected remaining, variance, par shortfall, and portions possible. Optional unit cost adds JD figures and plate cost. Never reads or writes `products.stock` / `stock_enabled` / `stock_deducted` / `refunds.restocked`. Never rejects a sale.

**Do not build:** modifiers, sub-recipes, POS badges, CSV, yield calculator, purchase orders, suppliers, OCR, auto-86, anything that blocks a sale.

## Rules

- Ledger writes stay in the caller's transaction. The service never commits and never emits. Callers emit `ingredients_changed` once after commit when `changedIngredientIds` is non-empty.
- Feature off: no usage writes, `recipe_line_key` stays NULL. Reversals still run and no-op if there are no rows.
- Line identity is `recipe_line_key` on `order_items` / `subscription_redemption_items`, minted server-side on first commit, copied through `SavedOrderLines` the same way frozen prices already move. Client `recipe_line_key` is discarded except on the server-stored progressive-split payload.
- Frozen recipe lives in the line's `usage` rows (`line_key`, `ingredient_id`, `unit_qty`). Existing lines never re-resolve the current recipe. Empty composition stays empty.
- Split children inherit the parent line's key and reverse against that key's remaining pool. Last reversal that would leave `< 1e-6` takes the exact remainder. Legacy split children write no usage.
- Pre-activation lines stay NULL forever. Quantity growth on those lines is not charged.
- Merge copies `recipe_line_key` and only quantity-merges when keys match (`AND recipe_line_key <=> ?`).
- Movements are append-only. No FK to orders, refunds, redemptions, products, or users.
- Forms send `{ qty, unit }` (optional `packs`). Convert with the submitted unit, not the current `display_unit`.
- Quantities `DECIMAL(16,6)` base units; costs `DECIMAL(16,8)` JD per base unit. mysql2 returns DECIMAL as strings. `Number()` then `roundSix` / `roundEight`. Reject non-finite input and positive recipe qty that rounds to 0.
- One correction per target. A correction moves a counted balance only if `corrects_movement_id >` the applicable count id. Counts accept 0.
- History running balance = latest count at or before the page + every intervening row, including rows hidden by filters. Filters do not change arithmetic.
- Summaries: today's rows by date index; latest count via `(ingredient_id, kind, id)`; tail via `(ingredient_id, id)`.
- No new permissions. Admin routes only. Static `$t` keys; numbers next to text get `data-no-i18n`. Arabic in `src/shared/i18n/ar.json`.
- Follow `docs/agents/database-migrations.md` and `AGENTS.md`. Confirm symbols in source; line numbers below are hints. Inspect test DB setup before any destructive seed.

## Schema

```sql
CREATE TABLE ingredients (
  id int(11) NOT NULL AUTO_INCREMENT,
  name varchar(100) NOT NULL,
  measure enum('weight','volume','count') NOT NULL,
  display_unit enum('g','kg','ml','l','unit') NOT NULL,
  unit_cost decimal(16,8) DEFAULT NULL,
  par_qty decimal(16,6) DEFAULT NULL,
  pack_name varchar(40) DEFAULT NULL,
  pack_size decimal(16,6) DEFAULT NULL,
  is_active tinyint(1) NOT NULL DEFAULT 1,
  created_at datetime NOT NULL DEFAULT current_timestamp(),
  updated_at datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ingredients_name (name),
  CONSTRAINT chk_ingredients_unit CHECK (
    (measure='weight' AND display_unit IN ('g','kg')) OR
    (measure='volume' AND display_unit IN ('ml','l')) OR
    (measure='count'  AND display_unit='unit')),
  CONSTRAINT chk_ingredients_pack CHECK (
    (pack_name IS NULL AND pack_size IS NULL) OR
    (pack_name IS NOT NULL AND pack_size > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE product_recipe_lines (
  id int(11) NOT NULL AUTO_INCREMENT,
  product_id int(11) NOT NULL,
  ingredient_id int(11) NOT NULL,
  qty_per_unit decimal(16,6) NOT NULL,
  sort_order int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_recipe_lines (product_id, ingredient_id),
  KEY idx_prl_ingredient (ingredient_id),
  CONSTRAINT fk_prl_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_prl_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients (id),
  CONSTRAINT chk_prl_qty CHECK (qty_per_unit > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE ingredient_movements (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  ingredient_id int(11) NOT NULL,
  kind enum('usage','reversal','receipt','waste','count','correction') NOT NULL,
  qty decimal(16,6) NOT NULL,
  unit_cost decimal(16,8) DEFAULT NULL,
  reason enum('spoiled','expired','dropped_or_burnt','over_prepared','staff_meal','other') DEFAULT NULL,
  expected_qty decimal(16,6) DEFAULT NULL,
  period_usage_qty decimal(16,6) DEFAULT NULL,
  line_key char(32) DEFAULT NULL,
  unit_qty decimal(16,6) DEFAULT NULL,
  product_qty decimal(16,6) DEFAULT NULL,
  source_type enum('order','redemption','refund','void','manual') NOT NULL,
  source_id int(11) DEFAULT NULL,
  source_label varchar(64) DEFAULT NULL,
  product_id int(11) DEFAULT NULL,
  product_name varchar(255) DEFAULT NULL,
  user_id int(11) DEFAULT NULL,
  user_name varchar(100) DEFAULT NULL,
  business_date date NOT NULL,
  occurred_at datetime NOT NULL DEFAULT current_timestamp(),
  note varchar(255) DEFAULT NULL,
  client_key varchar(64) DEFAULT NULL,
  corrects_movement_id bigint(20) unsigned DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_im_client_key (client_key),
  UNIQUE KEY uq_im_corrects (corrects_movement_id),
  KEY idx_im_ingredient_id (ingredient_id, id),
  KEY idx_im_ingredient_kind_id (ingredient_id, kind, id),
  KEY idx_im_date_ingredient (business_date, ingredient_id),
  KEY idx_im_line_key (line_key),
  KEY idx_im_source (source_type, source_id),
  CONSTRAINT fk_im_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients (id),
  CONSTRAINT chk_im_signs CHECK (
    (kind IN ('usage','waste') AND qty <= 0) OR
    (kind IN ('reversal','receipt') AND qty >= 0) OR
    (kind = 'count' AND qty >= 0) OR
    kind = 'correction'),
  CONSTRAINT chk_im_reason CHECK (kind = 'waste' OR reason IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE order_items ADD COLUMN recipe_line_key char(32) DEFAULT NULL,
  ADD KEY idx_order_items_recipe_line_key (recipe_line_key);
ALTER TABLE subscription_redemption_items ADD COLUMN recipe_line_key char(32) DEFAULT NULL,
  ADD KEY idx_sri_recipe_line_key (recipe_line_key);
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('recipe_ledger_enabled', '0');
```

- `qty`: signed base units. `count.qty` is the counted figure (absolute, `>= 0`).
- `expected_qty` / `period_usage_qty`: count rows only. Variance = `qty − expected_qty`. Variance % = that / `period_usage_qty` when `period_usage_qty > 0`.
- `unit_cost` on a movement is the snapshot at write time, except a receipt may store the price paid.
- Row money = `qty × unit_cost` when cost is not null.

## Service — `backend/services/RecipeLedgerService.js`

```js
// pure
roundSix(n), roundEight(n)
toBaseQty(qty, unit), fromBaseQty(baseQty, unit), unitBelongsTo(measure, unit)
toBaseCost(costPerUnit, unit), fromBaseCost(costPerBase, unit)
packsToBase(packs, packSize, looseQty, unit)
newLineKey()
resolveComposition(line, ctx) -> [{ ingredient_id, unit_qty }]
planLineRows(line, recorded) -> rows
reversalRows(recorded, qty) -> rows
effectiveBalance(rows, countId) -> number
portionsPossible(recipeLines, expectedByIngredient) -> { portions, limiting_ingredient_id } | null

// DB — conn is the caller's; nothing commits or emits
isEnabled(conn)
loadRecipeContext(conn, cartLines)
loadRecorded(conn, lineKeys)
syncOrderLines(conn, { sourceId, sourceLabel, lines, removedKeys, actor, businessDate })
  -> { written, changedIngredientIds }
syncRedemptionLines(conn, { sourceId, sourceLabel, lines, actor, businessDate })
reverseLineUsage(conn, { lineKey, qty, sourceType, sourceId, sourceLabel, actor, businessDate })
recordManualMovement(conn, { ingredientId, kind, qty, unit, packs, reason, unitCost, note, clientKey, actor, businessDate })
  -> { movement, replay }
recordOpeningCounts(conn, { entries: [{ ingredientId, qty, unit, packs }], clientKey, actor, businessDate })
correctManualMovement(conn, { movementId, note, clientKey, actor, businessDate })
getIngredientSummaries(conn, { businessDate, includeInactive })
listMovements(conn, { ingredientId, from, to, beforeId, limit })
getShoppingList(conn)
getPortionsReport(conn)
getDaySummary(conn, { businessDate })
```

`summary`: `{ id, name, measure, display_unit, unit_cost, par_qty, pack_name, pack_size, is_active, recipe_product_count, today: { opening, received, used, waste, corrections, used_cost, waste_cost }, expected_remaining, below_par, last_count: { at, qty, expected_qty, variance_qty, variance_pct } | null }`. Quantities in base units.

`recipe_ledger_enabled` (`'0'`/`'1'`): `loadCheckoutSettings.recipeLedgerEnabled`, `/api/system` payload, settings PUT allow-list. Toggle audits `recipe_ledger_toggled`.

## Admin API — `backend/routes/admin/recipeLedger.js`

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/api/admin/ingredients` | `?include_inactive=1` |
| POST | `/api/admin/ingredients` | `{ name, measure, display_unit, unit_cost?, cost_unit?, par_qty?, par_unit?, pack_name?, pack_size?, pack_unit? }` |
| PUT | `/api/admin/ingredients/:id` | same minus `measure`, plus `is_active` |
| POST | `/api/admin/ingredients/:id/movements` | `{ kind: receipt\|waste\|count, qty, unit, packs?, reason?, unit_cost?, cost_unit?, note?, client_key }` |
| POST | `/api/admin/ingredients/opening` | `{ entries: [{ ingredient_id, qty, unit, packs? }], client_key }` |
| POST | `/api/admin/ingredient-movements/:id/correct` | `{ note, client_key }` |
| GET | `/api/admin/ingredients/:id/movements` | `?from&to&before_id&limit=50` |
| GET | `/api/admin/ingredients/shopping-list` | |
| GET | `/api/admin/ingredients/portions` | |
| GET | `/api/admin/products/:id/recipe` | |
| PUT | `/api/admin/products/:id/recipe` | `{ lines: [{ ingredient_id, qty, unit }] }` |
| GET | `/api/admin/reports/ingredients` | `?date=YYYY-MM-DD` |

- `client_key` required on movement writes. Same key + same payload → `{ replay: true }`. Same key + different payload → 409.
- Waste requires `reason`. Count `qty >= 0`; receipt/waste `> 0` after pack conversion. `unit_cost` only on receipt.
- Archive (`is_active: 0`) → 409 `{ dependents }` while an active product recipe uses it. Measure is immutable.
- Writes audit in-transaction and emit after commit. Do not invalidate catalog cache or regenerate the static menu.

## Files this plan touches

`InventoryService.js`, `OrderPricing.js`, `SavedOrderLines.js`, `saveTableOrder.js`, `executeCheckout.js`, `splitChecks.js`, `tableRelationships.js`, `RefundService.js`, `voidOpenTableOrder.js`, `routes/pos/refunds.js`, `routes/pos/subscriptions.js`, `routes/admin/subscriptions.js`, `categoryPriceLists.js`, `import.js`, `routes/system.js`, `routes/admin.js`, `routes/admin/reports.js`, `seed.js`, `pageRegistry.js`, `Sidebar.vue`, `Settings.vue`, `ProductModal.vue`, `docs/architecture.json`, `src/shared/i18n/ar.json`. New: `RecipeLedgerService.js`, `routes/admin/recipeLedger.js`, Ingredients page + four small components, `ProductRecipeEditor.vue`, `ReportsIngredients.vue`, matching tests, `backend/migrations/2026-09-05-recipe-ledger-v1.sql`.

---

## Task 1 — Fix `restockOrderItems`

Files: `backend/services/InventoryService.js`, `backend/tests/unit/inventoryService.test.js`.

- [ ] **RED**

```js
it('restockOrderItems restores every line of a product that appears twice', async () => {
  const query = vi.fn(async (sql) => {
    if (String(sql).includes('FROM order_items')) return [[
      { product_id: 5, quantity: 1 }, { product_id: 5, quantity: 2 }, { product_id: 7, quantity: 1 }
    ]];
    return [{ affectedRows: 2 }];
  });
  await restockOrderItems({ query }, 42);
  const update = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE products'));
  expect(update[1]).toEqual([5, 3, 7, 1, 5, 7]);
});
```

- [ ] `npx vitest run backend/tests/unit/inventoryService.test.js` fails (current params include `5,1,5,2`).
- [ ] **GREEN** — move `restoreStockForCart` above `restockOrderItems`:

```js
const restockOrderItems = async (conn, invoiceId) => {
    const [oldItems] = await conn.query(
        'SELECT product_id, quantity FROM order_items WHERE invoice_id = ? AND product_id IS NOT NULL AND parent_item_id IS NULL',
        [invoiceId]
    );
    if (oldItems.length === 0) return;
    await restoreStockForCart(conn, oldItems);
};
```

- [ ] Unit file + `npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/checkout.test.js` green.
- [ ] Commit `fix(inventory): restock every duplicate product line on table re-save`

## Task 2 — Schema

Files: `backend/migrations/2026-09-05-recipe-ledger-v1.sql`, `backend/tests/fixtures/seed.js`. This task is implementation approval for the migration: write the dated evidence SQL, then the Hostinger-safe `.auto.sql`, manifest entry, and verbatim fallback block per `docs/agents/database-migrations.md`. Re-read the manifest tail before hashing; do not type hashes by hand.

- [ ] Evidence SQL: same header style as `2026-09-03-y-order-type-setting-v1.sql`, `SET NAMES utf8mb4;`, schema above with `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `ADD KEY IF NOT EXISTS`, `INSERT IGNORE` setting, `schema_migrations` insert.
- [ ] `seed.js`: drop `ingredient_movements`, `product_recipe_lines`, `ingredients` first; CREATE the three tables after `expenses`; add `recipe_line_key` + KEY on `order_items` and `subscription_redemption_items`; seed `('recipe_ledger_enabled','0')`.
- [ ] Scratch DB at the exact predecessor: run the real migration runner (confirm target DB first), `SHOW CREATE TABLE` for `ingredient_movements`, `ingredients`, `order_items`; run again (no-op); missing predecessor / checksum conflict fail closed. Put commands and engine version in the commit body.
- [ ] `backend/tests/integration/recipeLedgerSchema.test.js` asserts fixture columns via `information_schema`: `qty decimal(16,6)`, `unit_cost decimal(16,8)`, `reason` enum, `expected_qty`, `recipe_line_key char(32)` on both line tables.
- [ ] Commit `feat(recipe-ledger): schema evidence migration and fixture`

## Task 3 — Pure arithmetic

Files: `backend/services/RecipeLedgerService.js`, `backend/tests/unit/recipeLedgerPure.test.js`.

- [ ] **RED**

```js
const L = require('../../services/RecipeLedgerService');

describe('units and costs', () => {
  it('converts within a dimension only', () => {
    expect(L.toBaseQty(0.2, 'kg')).toBe(200);
    expect(L.toBaseQty(1.5, 'l')).toBe(1500);
    expect(L.fromBaseQty(2500, 'kg')).toBe(2.5);
    expect(L.unitBelongsTo('weight', 'kg')).toBe(true);
    expect(L.unitBelongsTo('weight', 'ml')).toBe(false);
    expect(() => L.toBaseQty('x', 'g')).toThrow();
    expect(() => L.toBaseQty(1, 'oz')).toThrow();
  });
  it('converts cost per display unit to cost per base unit and back', () => {
    expect(L.toBaseCost(4.5, 'kg')).toBe(0.0045);
    expect(L.fromBaseCost(0.0045, 'kg')).toBe(4.5);
    expect(L.toBaseCost(0.35, 'unit')).toBe(0.35);
  });
  it('packs plus loose', () => {
    expect(L.packsToBase(3, 24, 5, 'unit')).toBe(77);
    expect(L.packsToBase(2, 10000, 0.5, 'kg')).toBe(20500);
    expect(() => L.packsToBase(-1, 24, 0, 'unit')).toThrow();
  });
});

describe('resolveComposition', () => {
  const ctx = {
    recipeLinesByProductId: new Map([
      [1, [{ ingredient_id: 10, qty_per_unit: 200 }, { ingredient_id: 11, qty_per_unit: 100 }]],
      [2, [{ ingredient_id: 12, qty_per_unit: 1 }]],
    ]),
    bundleMembersByProductId: new Map([[4, [{ product_id: 1, qty: 1 }, { product_id: 2, qty: 2 }]]]),
  };
  it('uses own lines, or bundle members minus removed ones, or nothing', () => {
    expect(L.resolveComposition({ product_id: 1 }, ctx)).toEqual([
      { ingredient_id: 10, unit_qty: 200 }, { ingredient_id: 11, unit_qty: 100 },
    ]);
    expect(L.resolveComposition({ product_id: 4, bundleItems: [{ product_id: 2, removed: true }] }, ctx))
      .toEqual([{ ingredient_id: 10, unit_qty: 200 }, { ingredient_id: 11, unit_qty: 100 }]);
    expect(L.resolveComposition({ product_id: 4 }, ctx)).toEqual([
      { ingredient_id: 10, unit_qty: 200 }, { ingredient_id: 11, unit_qty: 100 }, { ingredient_id: 12, unit_qty: 2 },
    ]);
    expect(L.resolveComposition({ product_id: 99 }, ctx)).toEqual([]);
  });
});

describe('planLineRows', () => {
  const rec = (productQty, net) => ({ productQty, byIngredient: new Map([[10, { unit_qty: 200, net_qty: net }]]) });
  it('new line writes usage; empty composition writes nothing', () => {
    expect(L.planLineRows({ key: 'k', qty: 3, isNew: true, composition: [{ ingredient_id: 10, unit_qty: 200 }] }, null))
      .toEqual([{ ingredient_id: 10, kind: 'usage', qty: -600, unit_qty: 200, product_qty: 3 }]);
    expect(L.planLineRows({ key: 'k', qty: 3, isNew: true, composition: [] }, null)).toEqual([]);
  });
  it('existing line without rows stays empty', () => {
    expect(L.planLineRows({ key: 'k', qty: 5, isNew: false, composition: [{ ingredient_id: 10, unit_qty: 200 }] }, null)).toEqual([]);
  });
  it('unchanged writes nothing; increase uses frozen unit_qty', () => {
    expect(L.planLineRows({ key: 'k', qty: 3, isNew: false, composition: [{ ingredient_id: 10, unit_qty: 999 }] }, rec(3, 600))).toEqual([]);
    expect(L.planLineRows({ key: 'k', qty: 4, isNew: false, composition: [] }, rec(3, 600)))
      .toEqual([{ ingredient_id: 10, kind: 'usage', qty: -200, unit_qty: 200, product_qty: 1 }]);
  });
  it('decrease reverses, bounded, last fraction exact', () => {
    expect(L.planLineRows({ key: 'k', qty: 1, isNew: false, composition: [] }, rec(3, 600)))
      .toEqual([{ ingredient_id: 10, kind: 'reversal', qty: 400, unit_qty: 200, product_qty: -2 }]);
    let r = rec(1, 200);
    const a = L.reversalRows(r, 0.333333);
    r = rec(0.666667, 200 - a[0].qty);
    const b = L.reversalRows(r, 0.333333);
    r = rec(0.333334, r.byIngredient.get(10).net_qty - b[0].qty);
    const c = L.reversalRows(r, 0.333334);
    expect(L.roundSix(a[0].qty + b[0].qty + c[0].qty)).toBe(200);
    expect(L.reversalRows(rec(3, 600), 10)[0]).toEqual({
      ingredient_id: 10, kind: 'reversal', qty: 600, unit_qty: 200, product_qty: -3,
    });
  });
});

describe('effectiveBalance and portions', () => {
  it('ignores corrections whose target predates the count', () => {
    const rows = [
      { id: 1, kind: 'receipt', qty: 10 }, { id: 2, kind: 'count', qty: 100 },
      { id: 3, kind: 'correction', qty: -10, corrects_movement_id: 1 },
      { id: 4, kind: 'waste', qty: -5 }, { id: 5, kind: 'correction', qty: 5, corrects_movement_id: 4 },
    ];
    expect(L.effectiveBalance(rows, 2)).toBe(100);
  });
  it('portions possible is the floor of the tightest ingredient', () => {
    const lines = [{ ingredient_id: 10, qty_per_unit: 200 }, { ingredient_id: 12, qty_per_unit: 1 }];
    expect(L.portionsPossible(lines, new Map([[10, 4700], [12, 30]])))
      .toEqual({ portions: 23, limiting_ingredient_id: 10 });
    expect(L.portionsPossible(lines, new Map([[10, 4700]]))).toBeNull();
    expect(L.portionsPossible(lines, new Map([[10, -300], [12, 30]])))
      .toEqual({ portions: 0, limiting_ingredient_id: 10 });
  });
});
```

- [ ] Run → fail.
- [ ] **GREEN**

```js
const crypto = require('crypto');
const roundSix = (n) => Math.round(Number(n) * 1e6) / 1e6;
const roundEight = (n) => Math.round(Number(n) * 1e8) / 1e8;
const SCALE = { g: 1, kg: 1000, ml: 1, l: 1000, unit: 1 };
const DISPLAY_UNITS = { weight: ['g', 'kg'], volume: ['ml', 'l'], count: ['unit'] };
const WASTE_REASONS = ['spoiled', 'expired', 'dropped_or_burnt', 'over_prepared', 'staff_meal', 'other'];
const unitBelongsTo = (measure, unit) => (DISPLAY_UNITS[measure] || []).includes(unit);
const finite = (v, what) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new TypeError(`${what} must be a finite number.`);
    return n;
};
const scaleOf = (unit) => {
    if (!(unit in SCALE)) throw new TypeError(`Unsupported unit ${unit}.`);
    return SCALE[unit];
};
const toBaseQty = (qty, unit) => roundSix(finite(qty, 'Quantity') * scaleOf(unit));
const fromBaseQty = (baseQty, unit) => roundSix(Number(baseQty) / scaleOf(unit));
const toBaseCost = (cost, unit) => roundEight(finite(cost, 'Cost') / scaleOf(unit));
const fromBaseCost = (cost, unit) => roundEight(Number(cost) * scaleOf(unit));
const packsToBase = (packs, packSize, looseQty, unit) => {
    const p = finite(packs ?? 0, 'Packs');
    if (p < 0) throw new TypeError('Packs cannot be negative.');
    if (p > 0 && !(Number(packSize) > 0)) throw new TypeError('This ingredient has no pack size.');
    return roundSix(p * Number(packSize || 0) + toBaseQty(looseQty ?? 0, unit));
};
const newLineKey = () => crypto.randomBytes(16).toString('hex');

const resolveComposition = (line, { recipeLinesByProductId, bundleMembersByProductId }) => {
    const productId = Number(line.product_id);
    const own = recipeLinesByProductId.get(productId);
    if (own && own.length) {
        return own.map(r => ({ ingredient_id: Number(r.ingredient_id), unit_qty: roundSix(r.qty_per_unit) }));
    }
    const members = bundleMembersByProductId.get(productId);
    if (!members) return [];
    const removed = new Set((line.bundleItems || []).filter(s => s?.removed === true).map(s => Number(s.product_id)));
    const acc = new Map();
    for (const m of members) {
        if (removed.has(Number(m.product_id))) continue;
        for (const r of recipeLinesByProductId.get(Number(m.product_id)) || []) {
            const id = Number(r.ingredient_id);
            acc.set(id, roundSix((acc.get(id) || 0) + Number(r.qty_per_unit) * Number(m.qty)));
        }
    }
    return [...acc].map(([ingredient_id, unit_qty]) => ({ ingredient_id, unit_qty }));
};

const reversalRows = (recorded, qty) => {
    const reversible = Math.min(roundSix(qty), recorded.productQty);
    if (!(reversible > 0)) return [];
    const exhausts = recorded.productQty - reversible < 1e-6;
    const rows = [];
    for (const [ingredient_id, { unit_qty, net_qty }] of recorded.byIngredient) {
        const amount = exhausts ? net_qty : Math.min(roundSix(reversible * unit_qty), net_qty);
        if (amount > 0) {
            rows.push({ ingredient_id, kind: 'reversal', qty: roundSix(amount), unit_qty, product_qty: roundSix(-reversible) });
        }
    }
    return rows;
};

const planLineRows = (line, recorded) => {
    const qty = roundSix(line.qty);
    if (!recorded) {
        if (!line.isNew) return [];
        return line.composition.map(c => ({
            ingredient_id: c.ingredient_id, kind: 'usage',
            qty: roundSix(-c.unit_qty * qty), unit_qty: c.unit_qty, product_qty: qty,
        }));
    }
    const delta = roundSix(qty - recorded.productQty);
    if (delta === 0) return [];
    if (delta > 0) {
        return [...recorded.byIngredient].map(([ingredient_id, { unit_qty }]) => ({
            ingredient_id, kind: 'usage', qty: roundSix(-unit_qty * delta), unit_qty, product_qty: delta,
        }));
    }
    return reversalRows(recorded, -delta);
};

const effectiveBalance = (rows, countId) => rows.reduce((sum, r) => {
    if (r.id <= countId) return r.id === countId ? Number(r.qty) : sum;
    if (r.kind === 'count') return sum;
    if (r.kind === 'correction' && Number(r.corrects_movement_id) <= countId) return sum;
    return roundSix(sum + Number(r.qty));
}, 0);

const portionsPossible = (recipeLines, expectedByIngredient) => {
    let best = null;
    for (const r of recipeLines) {
        const expected = expectedByIngredient.get(Number(r.ingredient_id));
        if (expected === undefined || expected === null) return null;
        const portions = Math.max(0, Math.floor(Number(expected) / Number(r.qty_per_unit)));
        if (best === null || portions < best.portions) {
            best = { portions, limiting_ingredient_id: Number(r.ingredient_id) };
        }
    }
    return best;
};

module.exports = {
    roundSix, roundEight, SCALE, DISPLAY_UNITS, WASTE_REASONS, unitBelongsTo,
    toBaseQty, fromBaseQty, toBaseCost, fromBaseCost, packsToBase, newLineKey,
    resolveComposition, reversalRows, planLineRows, effectiveBalance, portionsPossible,
};
```

- [ ] Run → pass. Commit `feat(recipe-ledger): units, costs, composition, frozen line arithmetic`

## Task 4 — Writes and reads

Files: extend `RecipeLedgerService.js`; `backend/tests/integration/recipeLedgerService.test.js`.

Fixture on seeded DB (`SEED.product1` burger 5.00, `SEED.product2` drink): chicken weight/kg, cost 4.5 JD/kg, par 5 kg, pack sack 10 kg, 200 g per burger; pepsi count, cost 0.35, pack carton 24, 1 per drink. Enable the setting in `beforeAll`.

- [ ] **RED**

```js
it('sync writes usage for new lines only, snapshots cost, and is idempotent', async () => {
  const k1 = L.newLineKey(), k2 = L.newLineKey();
  const lines = [
    { key: k1, product_id: 1, product_name: 'B', qty: 3, isNew: true },
    { key: k2, product_id: 2, product_name: 'D', qty: 2, isNew: true },
  ];
  await tx(async conn => {
    expect((await L.syncOrderLines(conn, { sourceId: 9001, sourceLabel: 'Table 1', lines, removedKeys: [], actor, businessDate })).written).toBe(2);
  });
  await tx(async conn => {
    expect((await L.syncOrderLines(conn, { sourceId: 9001, sourceLabel: 'Table 1', lines: lines.map(l => ({ ...l, isNew: false })), removedKeys: [], actor, businessDate })).written).toBe(0);
  });
  await tx(async conn => {
    expect((await L.syncOrderLines(conn, { sourceId: 9001, sourceLabel: 'Table 1', lines: [{ ...lines[0], qty: 4, isNew: false }, { ...lines[1], isNew: false }], removedKeys: [], actor, businessDate })).written).toBe(1);
  });
  expect(await net(chicken, k1)).toBe(-800);
  const [[row]] = await pool.query('SELECT unit_cost FROM ingredient_movements WHERE line_key = ? ORDER BY id LIMIT 1', [k1]);
  expect(Number(row.unit_cost)).toBe(0.0045);
});

it('a recipe change after the first save does not touch the saved line', async () => {
  await pool.query('UPDATE product_recipe_lines SET qty_per_unit = 250 WHERE product_id = 1');
  await tx(async conn => {
    expect((await L.syncOrderLines(conn, { sourceId: 9001, sourceLabel: 'Table 1', lines: [{ key: k1, product_id: 1, qty: 5, isNew: false }], removedKeys: [], actor, businessDate })).written).toBe(1);
  });
  expect(await net(chicken, k1)).toBe(-1000);
  await pool.query('UPDATE product_recipe_lines SET qty_per_unit = 200 WHERE product_id = 1');
});

it('reverseLineUsage is bounded and exact', async () => {
  await tx(conn => L.reverseLineUsage(conn, { lineKey: k1, qty: 2, sourceType: 'refund', sourceId: 77, sourceLabel: 'Refund #77', actor, businessDate }));
  await tx(conn => L.reverseLineUsage(conn, { lineKey: k1, qty: 10, sourceType: 'refund', sourceId: 78, sourceLabel: 'Refund #78', actor, businessDate }));
  expect(await net(chicken, k1)).toBe(0);
});

it('counts store expected and period usage; corrections respect count order', async () => {
  let s = await summary(pepsi);
  expect(s.today.used).toBe(2);
  expect(s.expected_remaining).toBeNull();
  expect(s.last_count).toBeNull();
  await tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'receipt', qty: 10, unit: 'unit', clientKey: 'r0', actor, businessDate }));
  const opening = await tx(conn => L.recordOpeningCounts(conn, { entries: [{ ingredientId: pepsi, qty: 4, unit: 'unit', packs: 4 }], clientKey: 'open1', actor, businessDate }));
  expect(Number(opening.movements[0].qty)).toBe(100);
  expect(opening.movements[0].expected_qty).toBeNull();
  await tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'receipt', qty: 1, unit: 'unit', packs: 1, unitCost: 0.30, clientKey: 'k1', actor, businessDate }));
  const replay = await tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'receipt', qty: 1, unit: 'unit', packs: 1, unitCost: 0.30, clientKey: 'k1', actor, businessDate }));
  expect(replay.replay).toBe(true);
  await expect(tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'receipt', qty: 26, unit: 'unit', clientKey: 'k1', actor, businessDate }))).rejects.toMatchObject({ statusCode: 409 });
  await expect(tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'waste', qty: 4, unit: 'unit', clientKey: 'w0', actor, businessDate }))).rejects.toMatchObject({ statusCode: 400 });
  await tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'waste', qty: 4, unit: 'unit', reason: 'expired', clientKey: 'w1', actor, businessDate }));
  await tx(conn => L.syncOrderLines(conn, { sourceId: 9002, sourceLabel: 'Order #2', lines: [{ key: L.newLineKey(), product_id: 2, product_name: 'D', qty: 6, isNew: true }], removedKeys: [], actor, businessDate }));
  s = await summary(pepsi);
  expect(s.today.opening).toBe(100);
  expect(s.expected_remaining).toBe(115);
  expect(s.today.waste_cost).toBeCloseTo(1.4, 6);
  const count = await tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'count', qty: 112, unit: 'unit', clientKey: 'c1', actor, businessDate }));
  expect(Number(count.movement.expected_qty)).toBe(115);
  expect(Number(count.movement.period_usage_qty)).toBe(6);
  s = await summary(pepsi);
  expect(s.last_count.variance_qty).toBe(-3);
  expect(s.last_count.variance_pct).toBeCloseTo(-0.5, 6);
  expect(s.expected_remaining).toBe(112);
  await tx(conn => L.correctManualMovement(conn, { movementId: idOf('r0'), note: 'typo', clientKey: 'x0', actor, businessDate }));
  expect((await summary(pepsi)).expected_remaining).toBe(112);
  await expect(tx(conn => L.correctManualMovement(conn, { movementId: idOf('r0'), note: 'again', clientKey: 'x1', actor, businessDate }))).rejects.toMatchObject({ statusCode: 409 });
  expect(Number((await tx(conn => L.recordManualMovement(conn, { ingredientId: pepsi, kind: 'count', qty: 0, unit: 'unit', clientKey: 'z', actor, businessDate }))).movement.qty)).toBe(0);
});

it('shopping list and portions use expected remaining', async () => {
  expect(await L.getShoppingList(pool)).toEqual([]);
  expect((await L.getPortionsReport(pool)).find(p => p.product_id === 1)?.portions_possible ?? null).toBeNull();
  await tx(conn => L.recordManualMovement(conn, { ingredientId: chicken, kind: 'count', qty: 4.7, unit: 'kg', clientKey: 'ch', actor, businessDate }));
  const list = await L.getShoppingList(pool);
  expect(list.find(x => x.ingredient.id === chicken)).toMatchObject({ shortfall: 300, packs_to_buy: 1 });
  expect((await L.getPortionsReport(pool)).find(p => p.product_id === 1)).toMatchObject({ portions_possible: 23, limiting_ingredient: expect.anything() });
});

it('history running balance includes hidden prefix rows', async () => {
  const { rows } = await L.listMovements(pool, { ingredientId: pepsi, beforeId: null, limit: 2 });
  // newest first; each running_balance equals effectiveBalance over ALL rows up to that id
});
```

- [ ] Run → fail.
- [ ] **GREEN**
  - `loadRecorded`: `SELECT line_key, ingredient_id, unit_qty, -SUM(qty) AS net_qty, SUM(product_qty) AS net_pq FROM ingredient_movements WHERE line_key IN (?) AND kind IN ('usage','reversal') GROUP BY line_key, ingredient_id, unit_qty`. `productQty` = `net_pq` of any group for that key.
  - `insertRows`: `SELECT id, unit_cost FROM ingredients WHERE id IN (?) ORDER BY id FOR UPDATE`; stamp cost unless the row already has one (priced receipt); bulk insert.
  - `syncOrderLines`: `planLineRows` with `resolveComposition` only when `isNew`. Removed keys get `reversalRows(..., recorded.productQty)`.
  - `recordManualMovement`: lock ingredient; convert packs; waste needs reason; count writes `expected_qty` (latest count + tail, or null) and `period_usage_qty` (−Σ usage+reversal since that count). Dup `client_key`: replay if `(ingredient_id, kind, qty, reason, unit_cost)` match, else 409.
  - `recordOpeningCounts`: lock ids ascending; first row `client_key`, rest `${clientKey}:${ingredientId}`.
  - `correctManualMovement`: receipt/waste only; insert `qty = -target.qty`, same `unit_cost`; dup target → 409.
  - `getIngredientSummaries`: three indexed queries, assemble in JS. `used = −Σ usage − Σ reversal`. `below_par` only when both par and expected exist.
  - `listMovements`: page `id < before_id` newest first; running balance from count + prefix + fold. Count rows include stored variance.
  - `getShoppingList`: `below_par` rows, `packs_to_buy = pack_size ? ceil(shortfall / pack_size) : null`.
  - `getPortionsReport`: active products with recipe lines × expected map.
- [ ] Run → pass. Commit `feat(recipe-ledger): transactional writes, counts with variance, cost snapshots, reads`

## Task 5 — Table save and checkout

Files: `SavedOrderLines.js`, `saveTableOrder.js`, `executeCheckout.js`, `OrderPricing.js`, `backend/tests/integration/recipeLedgerTables.test.js`.

- [ ] **RED** (HTTP, patterns from `tables.test.js`, setting on):
  1. Save 2 burgers (A) + 1 burger noted "no onion" (B) → two keys, chicken −600.
  2. Re-save unchanged → same keys, zero new rows.
  3. Re-save A at 3 → −200 on A; B untouched.
  4. Recipe → 250 g; re-save A at 4 → −200 frozen.
  5. New burger line C → −250 current recipe.
  6. Settle (`edit_invoice_id`) → keys kept, zero new rows.
  7. Setting off: save writes no rows, keys NULL; turn on and re-save → still no rows for those lines.
  8. Direct checkout of 2 drinks → keys + pepsi −2; held-order checkout same.
- [ ] Run → fail.
- [ ] **GREEN**
  - `buildSavedLineIndex`: add `recipe_line_key` to the context. Add the column to every saved-rows SELECT that feeds the index (`saveTableOrder`, `executeCheckout`, table settlement context if it lists columns).
  - `loadCheckoutSettings`: include `recipe_ledger_enabled` → `recipeLedgerEnabled`.
  - `saveTableOrder` parent insert:

```js
const savedContext = resolvedSavedContexts.get(item);
const isNewLine = !savedContext;
const lineKey = item.note === SERVICE_NOTE ? null
    : (savedContext ? (savedContext.recipe_line_key || null)
    : (settingsBundle.recipeLedgerEnabled ? newLineKey() : null));
```

    Collect keyed lines; after inserts `syncOrderLines` with `sourceLabel: \`Table ${lockedTable.table_number}\`` when enabled. Emit after commit.

  - `executeCheckout`: strip `recipe_line_key` from cart when `!isSplitSettle`. Split settle: keep payload key, no sync. Else: saved context key or mint if enabled. After inserts, `syncOrderLines` when enabled and not a split settle (`Table N` or `Order #${resetting_order_id}`). Legacy `old_table_order_id !== invoice_id`: reverse that order's keys as `void` before the void. Add the column to `parentInsertSql` / `parentRow`. Emit beside `inventory_changed`.
- [ ] New test + `tables.test.js`, `checkout.test.js`, `bundle.tables.test.js`, `bundle.checkout.test.js`, `tableSettlementContext.test.js`, `checkoutPostCommit.test.js`, `tableOrderPostCommit.test.js`.
- [ ] Commit `feat(recipe-ledger): line keys through saved-line seam; usage on table save and checkout`

## Task 6 — Splits and merges

Files: `splitChecks.js`, `tableRelationships.js`, `backend/tests/integration/recipeLedgerSplitsMerges.test.js`.

- [ ] **RED**
  1. 2 burgers key A; progressive split 1+1; settle both → children carry A; no new usage; refund each child +200; third refund rejected, no row.
  2. One burger split three ways; refund all three → +200 exact.
  3. Merge table (burger A, drink D) into a table that already has drink E → D and E stay two rows; re-save unchanged → zero rows; refund D after settle reverses D.
- [ ] **GREEN**
  - `splitChecks`: parent query includes `recipe_line_key`. Id-matched seats copy it; fallback-matched seats delete it. It rides in `cart_data.items`.
  - `tableRelationships`: copy the column on both inserts; add `AND recipe_line_key <=> ?` to the quantity-merge match. No movement writes.
- [ ] New test + table/split tests. Commit `feat(recipe-ledger): preserve line keys through splits and merges`

## Task 7 — Refunds, voids, redemptions

Files: `RefundService.js`, `routes/pos/refunds.js`, `voidOpenTableOrder.js`, `routes/pos/subscriptions.js`, `routes/admin/subscriptions.js`, `backend/tests/integration/recipeLedgerReversals.test.js`.

- [ ] **RED**
  1. Checkout 3 burgers; refund 1 → +200; full refund → +400; further refund rejected; 30% discount changes none of this; reversal `unit_cost` matches usage.
  2. Void a bundle line (burger + drink, drink removed) → +200 only.
  3. Redeem 1 burger → −200 and a key on the redemption item; reverse → +200, `source_type='redemption'`.
  4. Turn setting off after the sale; refund still reverses.
- [ ] **GREEN**
  - Refund: select and propagate `recipe_line_key`; after `refunds` insert, `reverseLineUsage` per keyed line (`sourceType: 'refund'`). Return `ledger_changed_ingredient_ids`; emit in `routes/pos/refunds.js` next to `inventory_changed`.
  - Void: same, `sourceType: 'void'`, emit in `runPostCommitEffects`.
  - Redemption: mint key when enabled, insert it, `syncRedemptionLines`, emit.
  - Admin reversal: select `sri.recipe_line_key`, `reverseLineUsage`, emit.
- [ ] New test + `refunds.test.js`, `reportsRefunds.test.js`, subscription tests. Commit `feat(recipe-ledger): exact reversals on refunds, voids, and redemption reversal`

## Task 8 — Catalog and setting

Files: `categoryPriceLists.js`, `import.js`, `routes/system.js`. Tests: `categoryCopy.test.js`, import test, settings test.

- [ ] **RED**: category copy with a recipe and unequal ids copies lines to the new id; `replaceCatalog` → 409 `Catalog replacement is blocked while product recipes exist. Clear recipes first.`; PUT `recipe_ledger_enabled: '1'` persists, shows on `/api/system`, audits `recipe_ledger_toggled`; operational reset does not delete the three ledger tables.
- [ ] **GREEN**: `for (const [oldId, newId] of productIdMap) INSERT ... SELECT ?, ... WHERE product_id = ?` with `[newId, oldId]`. Import: `SELECT 1 FROM product_recipe_lines LIMIT 1 FOR UPDATE` before mutation. Settings: add the key to `allowed_keys` and the GET payload; accept `'0'|'1'`.
- [ ] Commit `feat(recipe-ledger): settings toggle, recipe copy, replacement guard`

## Task 9 — Admin API

Files: `backend/routes/admin/recipeLedger.js`, mount in `admin.js`, `backend/tests/integration/recipeLedgerAdmin.test.js`.

- [ ] **RED** as admin: create Chicken (weight, kg, cost 4.5/kg, par 5 kg, sack 10 kg) → stored `0.0045`, `5000`, `10000`. `display_unit: 'ml'` → 400. Pack name without size → 400. Duplicate → 409. PUT recipe `{ qty: 0.2, unit: 'kg' }` stores 200; GET returns `qty: 0.2`, `plate_cost: 0.9`, `margin_pct: 0.82`. Change display to g; receipt `{ qty: 2, unit: 'kg' }` still 2000. Receipt `{ packs: 1, qty: 0.5, unit: 'kg' }` → 10500. Waste without reason → 400; with `spoiled` → 200. Count 0 → 200 and `expected_qty` set. Replay → `replay: true`. Same key different qty → 409. Archive while used → 409 `{ dependents }`. Opening two entries, replay-safe. Correct twice → second 409. Shopping list after 4.7 kg count → `packs_to_buy: 1`. Portions → burger 23. Cashier → 403.
- [ ] **GREEN**: same handler shape as `expenses.js`. Validate name 1–100, units against measure, recipe ≤ 100 unique active ingredients, `client_key` 1–64, `reason ∈ WASTE_REASONS`. Recipe GET: `plate_cost` = Σ `qty_per_unit × unit_cost` over costed lines; `margin_pct` only when price > 0 and every line is costed.
- [ ] Commit `feat(recipe-ledger): admin API with costs, par, packs, shopping list, portions`

## Task 10 — Ingredients page

Files: `src/admin/pages/Ingredients.vue`, `IngredientFormModal.vue`, `IngredientMovementModal.vue`, `IngredientOpeningModal.vue`, `IngredientHistoryDrawer.vue`, `pageRegistry.js`, `Sidebar.vue`, `Settings.vue`, `ar.json`, `src/admin/pages/__tests__/ingredientsPage.spec.js`.

Sidebar: same `/api/system` fetch as `tablesEnabled`; item `{ page: 'ingredients', icon: 'fa-carrot', label: 'Ingredients', show: admin && recipeLedgerEnabled }` after inventory. Settings: toggle next to stock, help text `Records recipe ingredients per sale, with optional costs and counts. Does not affect product stock and never blocks a sale.`

- [ ] **RED** source spec (not copy): uses `fetchJson`; hits `api/admin/ingredients`, `.../opening`, `.../shopping-list`, `.../portions`; modal sends `unit`, `packs`, waste `reason`, receipt `unit_cost`, and a `client_key` that changes when the payload changes; drawer uses `before_id`; registry/sidebar/settings exist; variance colors use 0.03 and 0.05.
- [ ] **GREEN**
  - Header: Set today's opening (prefill expected remaining; skip blanks), Shopping list, Portions, Add ingredient. Day totals Used JD / Waste JD when any row is costed.
  - Columns: Name, Unit, Opening, Received, Used, Waste, Expected (— until a count; red if negative; amber if below par), last-count variance (green <3%, amber 3–5%, red >5%), Receive / Waste / Count / History / Edit. Sort by |variance %| then name.
  - Form: name, measure (locked after create), display unit, cost, par, pack name + size.
  - Movement modal: qty + unit; packs if set; waste reason; optional receipt price; count preview Expected / Counted / Difference; `client_key = crypto.randomUUID()` on payload change.
  - History: 7-day default, `before_id` pagination, Correct on uncorrected receipt/waste.
  - Refetch on `ingredients_changed` (same socket pattern as `Inventory.vue`); drop stale responses by sequence.
- [ ] Spec + `npm run build:admin`. Commit `feat(recipe-ledger): Ingredients page with opening, variance, costs, par, portions`

## Task 11 — Recipe tab

Files: `ProductRecipeEditor.vue`, `ProductModal.vue`, `ar.json`, `src/admin/components/__tests__/productRecipeEditor.spec.js`.

Tab `recipe` on products and bundles when the setting is on. Unsaved product: `Save the product first, then add its recipe.`

- [ ] **RED**: loads `api/admin/products/${id}/recipe`, PUT sends `unit` per line, skips inactive ingredients, per-1 / per-10 totals, plate cost only when the API returns it, unsaved-change guard on tab switch (`requestClose` from `CategoryPriceListModal`), bundle note present.
- [ ] **GREEN**: picker excludes added/inactive; unit constrained by measure; own Save. Footer shows plate cost / price / margin when all lines are costed, otherwise `Plate cost (2 of 3 ingredients costed)`. Portions when known. Bundle note: `A bundle with its own recipe ignores its members' recipes.`
- [ ] Spec + `npm run build:admin`. Commit `feat(recipe-ledger): Recipe tab with plate cost and margin`

## Task 12 — Day report

Files: `getDaySummary` in the service; `GET /reports/ingredients` on `routes/admin/reports.js`; `ReportsIngredients.vue`; register `reports-ingredients` and add it to the existing reports sub-nav; `backend/tests/integration/recipeLedgerReport.test.js`, `src/admin/pages/__tests__/reportsIngredients.spec.js`.

- [ ] **RED**: for the Task 4 date, each ingredient has opening (first count that day or null), received, used, `waste_by_reason`, corrections, `closing_expected`, `counts[]` with variance, `used_cost`, `waste_cost`. Totals include `sales_total` from the same helper Daily Reports uses, and `food_cost_pct = used_cost / sales_total` when both exist. Empty date → empty arrays. Cashier → 403.
- [ ] **GREEN**: query that `business_date` plus the last count at or before the day's first row. Page: date picker (today), Used JD, Waste JD, food cost %, below-par count, table, waste-by-reason, print with the existing report print helper.
- [ ] Commit `feat(recipe-ledger): ingredient day report`

## Task 13 — Map and verify

- [ ] Update `docs/architecture.json` for the service, three tables, two `recipe_line_key` columns, the hook files, admin route, report, pages, `ingredients_changed`, and the setting. `npm run architecture && npm run architecture:check`.
- [ ] `npx vitest run backend/tests/unit/inventoryService.test.js backend/tests/unit/recipeLedgerPure.test.js backend/tests/integration/recipeLedger*.test.js backend/tests/integration/tables.test.js backend/tests/integration/checkout.test.js backend/tests/integration/refunds.test.js backend/tests/integration/bundle.tables.test.js backend/tests/integration/bundle.checkout.test.js backend/tests/integration/categoryCopy.test.js backend/tests/integration/tableSettlementContext.test.js src/admin/pages/__tests__/ingredientsPage.spec.js src/admin/pages/__tests__/reportsIngredients.spec.js src/admin/components/__tests__/productRecipeEditor.spec.js` then `npm run build:admin`.
- [ ] Browser, EN then AR: setting off → no Ingredients item, sale unchanged. On → Chicken (kg, 4.5, par 5, sack 10) and Pepsi (0.35, carton 24); burger 0.2 kg, drink 1 can; Recipe tab 0.90 JD / 82%. Opening: 1 sack chicken, 4 cartons + 4 pepsi. Table 3 burgers + 2 drinks, re-save, add one burger, split, settle, refund one burger. Expect chicken used 0.6 kg / 2.70 JD, remaining 9.4 kg; pepsi used 2, remaining 98; portions 47. Receive 2 kg at 4.2, waste 0.5 spoiled → 10.9; correct waste → 11.4; correct a pre-opening receipt → no change. Count 11.1 → variance −0.3 kg. Day report used 2.70 JD. Next-day opening prefilled 11.1, overwrite 11. Setting off, refund still restores 0.2 kg.
- [ ] Commit `docs(architecture): recipe ledger`

Do not open a PR unless asked. Do not wait on Release gate. Do not deploy.
