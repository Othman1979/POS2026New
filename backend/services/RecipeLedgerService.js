const crypto = require('crypto');
const { getBusinessDate } = require('../utils/businessDate');
const { appendIngredientRows, ingredientColumns } = require('./StockLedgerService');
const invalidation = require('./StockReportInvalidation');
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
// Scale six-place quantities before integer division and allocation boundaries.
const qtyMicros = (value) => BigInt(finite(value, 'Quantity').toFixed(6).replace('.', ''));
const fromMicros = (value) => Number(value) / 1e6;
const multiplyQty = (left, right) => fromMicros((qtyMicros(left) * qtyMicros(right) + 500000n) / 1000000n);

const assignLineKey = ({ hasSavedContext, savedKey, matchedById = false, enabled, claimedKeys, isService = false }) => {
    if (isService) return { lineKey: null, isNew: false };
    if (matchedById) {
        if (!savedKey) return { lineKey: null, isNew: false };
        claimedKeys.add(savedKey);
        return { lineKey: savedKey, isNew: false };
    }
    if (hasSavedContext && !savedKey) return { lineKey: null, isNew: false };
    if (savedKey && !claimedKeys.has(savedKey)) {
        claimedKeys.add(savedKey);
        return { lineKey: savedKey, isNew: false };
    }
    const lineKey = enabled ? newLineKey() : null;
    if (lineKey) claimedKeys.add(lineKey);
    return { lineKey, isNew: true };
};

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
    const available = qtyMicros(recorded.productQty);
    const requested = qtyMicros(qty);
    const reversible = requested < available ? requested : available;
    if (reversible <= 0n) return [];
    const remaining = available - reversible;
    return [...recorded.byIngredient].map(([ingredient_id, { unit_qty, net_qty }]) => {
        const net = qtyMicros(net_qty);
        const remainingDemand = (remaining * qtyMicros(unit_qty) + 500000n) / 1000000n;
        const restored = net > remainingDemand ? net - remainingDemand : 0n;
        // Keep product_qty in sync even when this component rounds to zero.
        return {
            ingredient_id, kind: 'reversal',
            qty: fromMicros(remaining === 0n ? net : restored),
            unit_qty, product_qty: -fromMicros(reversible),
        };
    });
};

const planLineRows = (line, recorded) => {
    const qty = roundSix(line.qty);
    if (!recorded) {
        if (!line.isNew) return [];
        return line.composition.map(c => ({
            ingredient_id: c.ingredient_id, kind: 'usage',
            qty: -multiplyQty(c.unit_qty, qty), unit_qty: c.unit_qty, product_qty: qty,
        }));
    }
    const delta = roundSix(qty - recorded.productQty);
    if (delta === 0) return [];
    if (delta > 0) {
        return [...recorded.byIngredient].map(([ingredient_id, { unit_qty, net_qty }]) => ({
            ingredient_id, kind: 'usage',
            qty: -Math.max(0, roundSix(multiplyQty(unit_qty, qty) - net_qty)),
            unit_qty, product_qty: delta,
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
        const portions = Math.max(0, Number(qtyMicros(expected) / qtyMicros(r.qty_per_unit)));
        if (best === null || portions < best.portions) {
            best = { portions, limiting_ingredient_id: Number(r.ingredient_id) };
        }
    }
    return best;
};

const fail = (statusCode, message) => {
    throw Object.assign(new Error(message), { statusCode });
};

const inClause = (values) => ({
    sql: values.map(() => '?').join(','),
    params: values,
});

const actorFields = (actor = {}) => ({
    user_id: actor.id ?? actor.user_id ?? null,
    user_name: actor.name ?? actor.user_name ?? null,
});

const asNumber = (value) => (value == null ? null : Number(value));

const sumKind = (rows, kind) => rows
    .filter((row) => row.kind === kind)
    .reduce((sum, row) => roundSix(sum + Number(row.qty)), 0);

const sameManualPayload = (existing, next) => (
    Number(existing.ingredient_id) === Number(next.ingredient_id)
    && existing.kind === next.kind
    && roundSix(existing.qty) === roundSix(next.qty)
    && (existing.reason || null) === (next.reason || null)
    && (next.purchase_priced == null || Boolean(Number(existing.purchase_priced)) === Boolean(next.purchase_priced))
    && (
        existing.unit_cost == null || next.unit_cost == null
            ? existing.unit_cost == null && next.unit_cost == null
            : roundEight(existing.unit_cost) === roundEight(next.unit_cost)
    )
);

const isEnabled = async (conn) => {
    const [[row]] = await conn.query(
        "SELECT setting_value FROM settings WHERE setting_key='recipe_ledger_enabled' LIMIT 1"
    );
    return String(row?.setting_value || '0') === '1';
};

const loadRecipeContext = async (conn, cartLines) => {
    const productIds = [...new Set((cartLines || [])
        .map((line) => Number(line.product_id))
        .filter((id) => Number.isSafeInteger(id) && id > 0))];
    const recipeLinesByProductId = new Map();
    const bundleMembersByProductId = new Map();
    if (!productIds.length) return { recipeLinesByProductId, bundleMembersByProductId };

    const products = inClause(productIds);
    const [bundleRows] = await conn.query(
        `SELECT bundle_id, product_id, qty FROM product_bundle_items WHERE bundle_id IN (${products.sql})`,
        products.params
    );
    for (const row of bundleRows) {
        const bundleId = Number(row.bundle_id);
        if (!bundleMembersByProductId.has(bundleId)) bundleMembersByProductId.set(bundleId, []);
        bundleMembersByProductId.get(bundleId).push({
            product_id: Number(row.product_id),
            qty: Number(row.qty),
        });
    }
    const memberIds = bundleRows.map((row) => Number(row.product_id));
    const allIds = [...new Set([...productIds, ...memberIds])];
    if (!allIds.length) return { recipeLinesByProductId, bundleMembersByProductId };
    const recipes = inClause(allIds);
    const [recipeRows] = await conn.query(
        `SELECT product_id, ingredient_id, qty_per_unit
           FROM product_recipe_lines
          WHERE product_id IN (${recipes.sql})
          ORDER BY product_id, sort_order, id`,
        recipes.params
    );
    for (const row of recipeRows) {
        const productId = Number(row.product_id);
        if (!recipeLinesByProductId.has(productId)) recipeLinesByProductId.set(productId, []);
        recipeLinesByProductId.get(productId).push({
            ingredient_id: Number(row.ingredient_id),
            qty_per_unit: Number(row.qty_per_unit),
        });
    }
    return { recipeLinesByProductId, bundleMembersByProductId };
};

const lockLineIngredients = async (conn, lineKeys, newIngredientIds = []) => {
    const keys = [...new Set(lineKeys.filter(Boolean))];
    const ids = new Set(newIngredientIds.map(Number));
    const recordedKeys = [];
    if (keys.length) {
        const list = inClause(keys);
        const [references] = await conn.query(
            `SELECT line_key, ingredient_ids FROM recipe_ledger_lines WHERE line_key IN (${list.sql}) ORDER BY line_key FOR UPDATE`, list.params
        );
        if (references.length !== keys.length) fail(409, 'Saved recipe line is missing its ingredient record.');
        // Current, immutable discovery works even with an older caller snapshot.
        // Empty compositions are explicit; only actual ingredients take locks.
        for (const row of references) {
            const ingredientIds = typeof row.ingredient_ids === 'string' ? JSON.parse(row.ingredient_ids) : row.ingredient_ids;
            for (const id of ingredientIds) ids.add(Number(id));
            if (ingredientIds.length) recordedKeys.push(row.line_key);
        }
    }
    let ingredients = [];
    if (ids.size) {
        const list = inClause([...ids].sort((a, b) => a - b));
        [ingredients] = await conn.query(`SELECT id, unit_cost FROM ingredients WHERE id IN (${list.sql}) ORDER BY id FOR UPDATE`, list.params);
    }
    return { recordedKeys, ingredients };
};

const loadRecorded = async (conn, lineKeys) => {
    const keys = [...new Set((lineKeys || []).filter(Boolean))];
    const recorded = new Map();
    if (!keys.length) return recorded;
    const list = inClause(keys);
    const [rows] = await conn.query(
        `SELECT line_key, ingredient_id, unit_qty, unit_cost, -SUM(qty) AS net_qty, SUM(product_qty) AS net_pq
           FROM stock_movements
          WHERE movement_type='ingredient' AND line_key IN (${list.sql}) AND kind IN ('usage','reversal')
          GROUP BY line_key, ingredient_id, unit_qty, unit_cost
          ORDER BY MAX(CASE WHEN kind='usage' THEN id END) DESC FOR UPDATE`,
        list.params
    );
    for (const row of rows) {
        if (!recorded.has(row.line_key)) {
            recorded.set(row.line_key, { productQty: 0, byIngredient: new Map() });
        }
        const byIngredient = recorded.get(row.line_key).byIngredient;
        const ingredientId = Number(row.ingredient_id);
        const entry = byIngredient.get(ingredientId) || { unit_qty: Number(row.unit_qty), net_qty: 0, productQty: 0, costs: [] };
        entry.net_qty = roundSix(entry.net_qty + Number(row.net_qty));
        entry.productQty = roundSix(entry.productQty + Number(row.net_pq));
        entry.costs.push({ qty: Number(row.net_qty), unit_cost: row.unit_cost == null ? null : Number(row.unit_cost) });
        byIngredient.set(ingredientId, entry);
    }
    for (const line of recorded.values()) line.productQty = line.byIngredient.values().next().value.productQty;
    return recorded;
};

const withReversalCosts = (rows, recordedMap) => rows.flatMap(row => {
    if (row.kind !== 'reversal') return [row];
    const costs = recordedMap.get(row.line_key).byIngredient.get(Number(row.ingredient_id)).costs;
    let remaining = qtyMicros(row.qty);
    const allocated = [];
    // Return the newest outstanding usage costs first. Distinct cost snapshots
    // remain distinct, including an explicitly unknown (null) original cost.
    for (const cost of costs) {
        const available = qtyMicros(cost.qty);
        if (remaining <= 0n) break;
        if (available <= 0n) continue;
        const amount = remaining < available ? remaining : available;
        allocated.push({ ...row, qty: fromMicros(amount), unit_cost: cost.unit_cost,
            product_qty: allocated.length ? 0 : row.product_qty });
        remaining -= amount;
        cost.qty = fromMicros(available - amount);
    }
    // A component can round to zero while its line quantity still changes.
    if (!allocated.length) allocated.push({ ...row, unit_cost: costs[0]?.unit_cost ?? null });
    return allocated;
});

const loadIngredient = async (conn, ingredientId) => {
    const [[ingredient]] = await conn.query(
        `SELECT id, name, measure, display_unit, unit_cost, par_qty, pack_name, pack_size, is_active
           FROM ingredients WHERE id=? FOR UPDATE`,
        [ingredientId]
    );
    if (!ingredient) fail(404, 'Ingredient not found.');
    return ingredient;
};

// Prices are purchase estimates, not on-hand inventory valuation. Unpriced and
// legacy receipts cannot safely be inferred to contain an actual purchase price.
const resolveIngredientCosts = async (conn, ingredients, businessDate = getBusinessDate()) => {
    const result = new Map(ingredients.map(row => [Number(row.id), {
        unit_cost: row.unit_cost == null ? null : Number(row.unit_cost),
        cost_source: row.unit_cost == null ? 'missing' : 'reference',
    }]));
    if (!ingredients.length) return result;
    const clause = inClause(ingredients.map(row => Number(row.id)));
    const [prices] = await conn.query(`
        SELECT r.ingredient_id,
          SUM((r.qty + COALESCE(c.qty,0))*r.unit_cost) / NULLIF(SUM(r.qty + COALESCE(c.qty,0)),0) AS average_cost
        FROM stock_movements r
        LEFT JOIN stock_movements c ON c.movement_type='ingredient' AND c.corrects_movement_id=r.id AND c.business_date<=?
        WHERE r.movement_type='ingredient' AND r.ingredient_id IN (${clause.sql}) AND r.kind='receipt' AND r.purchase_priced=1
          AND r.business_date BETWEEN DATE_SUB(?, INTERVAL 29 DAY) AND ?
          AND r.unit_cost IS NOT NULL AND r.qty + COALESCE(c.qty,0)>0
        GROUP BY r.ingredient_id`, [businessDate, ...clause.params, businessDate, businessDate]);
    for (const row of prices) if (row.average_cost != null) result.set(Number(row.ingredient_id), {
        unit_cost: roundEight(row.average_cost), cost_source: 'purchase_average',
    });
    return result;
};

const insertRows = async (conn, rows, { ingredients, readBack = true, workingBalances: preparedBalances }) => {
    if (!rows.length) return [];
    const workingBalances=preparedBalances || await ensureWorkingBalances(conn,ingredients.map(row=>Number(row.id)));
    const costById = new Map(ingredients.map((row) => [Number(row.id), row.unit_cost == null ? null : Number(row.unit_cost)]));
    const needsCost = rows.some(row => ['usage','waste'].includes(row.kind) && !Object.prototype.hasOwnProperty.call(row, 'unit_cost'));
    // Estimate prices from this transaction's consistent snapshot. A locking
    // range read on missing receipts can gap-lock unrelated ingredient inserts.
    const estimates = needsCost ? await resolveIngredientCosts(conn, ingredients, rows[0].business_date) : new Map();
    const resolved = rows.map(row => {
        const unitCost = Object.prototype.hasOwnProperty.call(row, 'unit_cost')
            ? row.unit_cost : estimates.get(Number(row.ingredient_id))?.unit_cost ?? costById.get(Number(row.ingredient_id)) ?? null;
        return {...row, unit_cost:unitCost, purchase_priced:row.purchase_priced ? 1 : 0,
            cost_source:row.cost_source || estimates.get(Number(row.ingredient_id))?.cost_source || (unitCost == null ? 'missing' : 'reference')};
    });
    const inserted = await appendIngredientRows(conn, resolved, {readBack});
    await updateWorkingBalances(conn,inserted,workingBalances);
    await invalidation.fromMovements(conn, inserted);
    return inserted;
};

const findByClientKey = async (conn, clientKey, current = false) => {
    if (!clientKey) return null;
    const [[row]] = await conn.query(`SELECT ${ingredientColumns()} FROM stock_movements WHERE movement_type='ingredient' AND client_key=? LIMIT 1` + (current ? ' FOR UPDATE' : ''), [clientKey]);
    return row || null;
};

const attachLineMeta = (planned, line, source) => planned.map((row) => ({
    ...row,
    line_key: line.key,
    product_id: line.product_id ?? null,
    product_name: line.product_name ?? null,
    ...source,
}));

const syncKeyedLines = async (conn, { sourceType, sourceId, sourceLabel, lines, removedKeys, actor, businessDate, enabled, recipeContext }) => {
    if (!(enabled ?? await isEnabled(conn))) return { written: 0, changedIngredientIds: [] };
    const source = {
        source_type: sourceType,
        source_id: sourceId ?? null,
        source_label: sourceLabel ?? null,
        ...actorFields(actor),
        business_date: businessDate,
    };
    const freshLines = (lines || []).filter(line => line.key && line.isNew);
    const ctx = recipeContext || await loadRecipeContext(conn, freshLines);
    const keys = [...(lines || []).filter(line => !line.isNew).map((line) => line.key), ...(removedKeys || [])].filter(Boolean);
    const compositions = new Map((lines || []).map(line => [line, line.isNew ? resolveComposition(line, ctx) : []]));
    if (freshLines.length) {
        await conn.query('INSERT INTO recipe_ledger_lines (line_key, ingredient_ids) VALUES ?', [
            freshLines.map(line => [line.key, JSON.stringify(compositions.get(line).map(row => row.ingredient_id).sort((a,b) => a-b))])
                .sort((a,b) => a[0].localeCompare(b[0]))
        ]);
    }
    const { recordedKeys, ingredients } = await lockLineIngredients(conn, keys, [...compositions.values()].flat().map(row => row.ingredient_id));
    // New server-minted keys need no absent-key locking read or gap locks.
    const recordedMap = await loadRecorded(conn, recordedKeys);
    const planned = [];
    for (const line of lines || []) {
        if (!line?.key) continue;
        const composition = compositions.get(line);
        planned.push(...attachLineMeta(
            planLineRows({ ...line, composition }, recordedMap.get(line.key) || null),
            line,
            source
        ));
    }
    for (const key of removedKeys || []) {
        const recorded = recordedMap.get(key);
        if (!recorded) continue;
        planned.push(...reversalRows(recorded, recorded.productQty).map((row) => ({
            ...row,
            line_key: key,
            ...source,
        })));
    }
    const inserted = await insertRows(conn, withReversalCosts(planned, recordedMap), { ingredients, readBack: false });
    return {
        written: inserted.length,
        changedIngredientIds: [...new Set(inserted.map((row) => Number(row.ingredient_id)))],
    };
};

const syncOrderLines = async (conn, args) => (
    syncKeyedLines(conn, { ...args, sourceType: 'order' })
);

const reverseLinesUsage = async (conn, { lines, sourceType, sourceId, sourceLabel, actor, businessDate }) => {
    const quantities = new Map();
    for (const { lineKey, qty } of lines) {
        if (lineKey) quantities.set(lineKey, roundSix((quantities.get(lineKey) || 0) + Number(qty)));
    }
    const keys = [...quantities.keys()];
    const { recordedKeys, ingredients } = await lockLineIngredients(conn, keys);
    const recordedMap = await loadRecorded(conn, recordedKeys);
    const planned = [...quantities].flatMap(([lineKey, qty]) => {
        const recorded = recordedMap.get(lineKey);
        if (!recorded) return [];
        return reversalRows(recorded, qty).map((row) => ({
        ...row,
        line_key: lineKey,
        source_type: sourceType,
        source_id: sourceId ?? null,
        source_label: sourceLabel ?? null,
        ...actorFields(actor),
        business_date: businessDate,
        }));
    });
    const inserted = await insertRows(conn, withReversalCosts(planned, recordedMap), { ingredients, readBack: false });
    return {
        written: inserted.length,
        changedIngredientIds: [...new Set(inserted.map((row) => Number(row.ingredient_id)))],
    };
};

const reverseLineUsage = (conn, { lineKey, qty, ...source }) => (
    reverseLinesUsage(conn, { ...source, lines: [{ lineKey, qty }] })
);

// A partial table move gives each editable bill its own consumption key. Paired
// journal entries move the recorded allocation and cost; their physical net is
// zero. Reusing one key on two editable bills would make a later save reverse the
// other bill's ingredients when syncOrderLines reconciles that key's quantity.
async function transferLineUsage(conn, { lines, sourceId, targetId, sourceLabel, targetLabel, actor, businessDate }) {
    const selected = lines.filter(line => line.recipe_line_key);
    if (!selected.length) return new Map();
    const keys = selected.map(line => line.recipe_line_key);
    if (new Set(keys).size !== keys.length) fail(409, 'Saved preparation identity is ambiguous. Keep these items on their current bill.');
    const { recordedKeys, ingredients } = await lockLineIngredients(conn, keys);
    const recordedMap = await loadRecorded(conn, recordedKeys);
    const recordedKeySet = new Set(recordedKeys);
    const references = [], planned = [], movedKeys = new Map();
    for (const line of selected) {
        const recorded = recordedMap.get(line.recipe_line_key);
        if (recordedKeySet.has(line.recipe_line_key) && (!recorded || qtyMicros(recorded.productQty) !== qtyMicros(line.original_quantity))) {
            fail(409, 'Saved preparation quantity changed. Keep these items on their current bill.');
        }
        const newKey = newLineKey();
        movedKeys.set(Number(line.id), newKey);
        references.push([newKey, JSON.stringify(recorded ? [...recorded.byIngredient.keys()].sort((a, b) => a - b) : [])]);
        if (!recorded) continue; // An explicitly empty recipe still gets its own key.
        const reversals = reversalRows(recorded, line.quantity).map(row => ({
            ...row, line_key: line.recipe_line_key, source_type: 'order', source_id: sourceId,
            source_label: sourceLabel, product_id: line.product_id,
            product_name: line.item_name, ...actorFields(actor), business_date: businessDate
        }));
        const priced = withReversalCosts(reversals, recordedMap);
        planned.push(...priced, ...priced.map(row => ({
            ...row, line_key: newKey, kind: 'usage', qty: -row.qty, product_qty: -row.product_qty,
            source_id: targetId, source_label: targetLabel
        })));
    }
    await conn.query('INSERT INTO recipe_ledger_lines(line_key,ingredient_ids) VALUES ?', [references.sort((a, b) => a[0].localeCompare(b[0]))]);
    await insertRows(conn, planned, { ingredients, readBack: false });
    return movedKeys;
}

async function countExpectationsFor(conn, ids) {
    const states=await ensureWorkingBalances(conn,ids);
    const [links]=await conn.query('SELECT id AS ingredient_id,CAST(stock_item_id AS CHAR) stock_item_id FROM ingredients WHERE id IN (?) AND stock_item_id IS NOT NULL ORDER BY id FOR UPDATE',[ids]);
    const physical=new Map();
    if(links.length){
        const itemIds=[...new Set(links.map(row=>row.stock_item_id))].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
        await conn.query('SELECT id FROM stock_items WHERE id IN (?) ORDER BY id FOR UPDATE',[itemIds]);
        // Current reads preserve a concurrent sale committed after our snapshot.
        const [balances]=await conn.query('SELECT CAST(stock_item_id AS CHAR) stock_item_id,quantity,quantity_known FROM stock_balances WHERE stock_item_id IN (?) ORDER BY stock_item_id FOR UPDATE',[itemIds]);
        for(const row of balances){
            const total=physical.get(row.stock_item_id)||{quantity:0n,known:true};
            total.quantity+=qtyMicros(row.quantity);total.known=total.known&&Boolean(row.quantity_known);physical.set(row.stock_item_id,total);
        }
    }
    const linked=new Map(links.map(row=>[Number(row.ingredient_id),row.stock_item_id]));
    const expectations=new Map(ids.map(id=>{
        const state=states.get(Number(id)),core=physical.get(linked.get(Number(id)));
        const expected=linked.has(Number(id))?(core?.known?fromMicros(core.quantity):null):(state.quantity_known?Number(state.quantity):null);
        return [Number(id),{expected_qty:expected,period_usage_qty:expected==null?null:Number(state.period_usage),last_count_id:String(state.last_count_id),variance_qty:state.variance_qty}];
    }));
    return {expectations,workingBalances:states};
}

// Ingredient locks belong to the source transaction. Initialize only missing
// rows once; subsequent receipts, counts, corrections and sales are O(lines).
async function ensureWorkingBalances(conn,ids) {
    if(!ids.length)return new Map();
    ids=[...new Set(ids)].sort((a,b)=>a-b);
    const [existing] = await conn.query(`SELECT id AS ingredient_id,
        working_quantity AS quantity,working_quantity_known AS quantity_known,
        working_last_count_id AS last_count_id,working_period_usage AS period_usage,
        working_variance_qty AS variance_qty,working_initialized AS initialized
        FROM ingredients WHERE id IN (?) ORDER BY id FOR UPDATE`, [ids]);
    const missing=existing.filter(row=>!row.initialized).map(row=>Number(row.ingredient_id));
    const states=new Map(existing.map(row=>[Number(row.ingredient_id),row]));
    if(missing.length){
        // No post-upgrade writer can change retained history without initializing
        // this same locked projection. A missing row therefore has stable legacy
        // history; mixed old/new application writers are not an upgrade mode.
        const [history]=await conn.query(`SELECT i.id,${currentBalanceSql} quantity,c.id last_count_id,
            CASE WHEN c.expected_qty IS NULL THEN NULL ELSE c.qty-c.expected_qty END variance_qty,
            (SELECT -COALESCE(SUM(m.qty),0) FROM stock_movements m FORCE INDEX (idx_im_balance)
                WHERE m.movement_type='ingredient' AND m.ingredient_id=i.id AND m.id>COALESCE(c.id,0) AND m.kind IN ('usage','reversal')) period_usage
            FROM ingredients i ${latestCountJoinSql} WHERE i.id IN (?)`,[missing]);
        // A concurrently created ingredient may be outside this transaction's
        // old snapshot. It has no pre-upgrade history to initialize.
        const visible=new Set(history.map(row=>Number(row.id)));
        for(const id of missing)if(!visible.has(id))history.push({id,quantity:null,last_count_id:0,period_usage:0,variance_qty:null});
        const values=history.map(row=>[row.id,row.quantity||0,row.quantity==null?0:1,row.last_count_id||0,row.period_usage||0,row.variance_qty]);
        await saveWorkingBalances(conn, values);
        for(const row of history)states.set(Number(row.id),{ingredient_id:row.id,quantity:row.quantity||0,quantity_known:row.quantity==null?0:1,last_count_id:row.last_count_id||0,period_usage:row.period_usage||0,variance_qty:row.variance_qty,initialized:1});
    }
    return states;
}
// Existing ingredient rows are already locked. A bounded update avoids inserting
// partial catalog rows and keeps catalog edit timestamps independent of stock.
async function saveWorkingBalances(conn, values) {
    if (!values.length) return;
    const rowSql = `SELECT ? id,CAST(? AS DECIMAL(28,6)) quantity,? quantity_known,
        CAST(? AS UNSIGNED) last_count_id,CAST(? AS DECIMAL(28,6)) period_usage,
        CAST(? AS DECIMAL(28,6)) variance_qty`;
    await conn.query(`UPDATE ingredients i JOIN (${values.map(() => rowSql).join(' UNION ALL ')}) v ON v.id=i.id
        SET i.working_quantity=v.quantity,i.working_quantity_known=v.quantity_known,
        i.working_last_count_id=v.last_count_id,i.working_period_usage=v.period_usage,
        i.working_variance_qty=v.variance_qty,i.working_initialized=1,i.updated_at=i.updated_at`, values.flat());
}
async function updateWorkingBalances(conn,rows,current) {
    const states=new Map([...current].map(([id,row])=>[id,{...row,quantity:qtyMicros(row.quantity),period_usage:qtyMicros(row.period_usage)}]));
    for(const row of rows){
        const state=states.get(Number(row.ingredient_id)),amount=qtyMicros(row.qty);
        if(row.kind==='count'){
            state.quantity=amount;state.quantity_known=1;state.last_count_id=row.id;state.period_usage=0n;
            state.variance_qty=row.expected_qty==null?null:fromMicros(amount-qtyMicros(row.expected_qty));
        }else{
            if(row.kind!=='correction'||BigInt(row.corrects_movement_id)>BigInt(state.last_count_id))state.quantity+=amount;
            if(['usage','reversal'].includes(row.kind))state.period_usage-=amount;
        }
    }
    const decimal=value=>{const negative=value<0n,n=negative?-value:value;return (negative?'-':'')+String(n/1000000n)+'.'+String(n%1000000n).padStart(6,'0');};
    await saveWorkingBalances(conn, [...states.values()].map(row => [row.ingredient_id,
        decimal(row.quantity),row.quantity_known,row.last_count_id,decimal(row.period_usage),row.variance_qty]));
}
async function backfillWorkingBalances(pool,{afterId=0}={}) {
    if(!Number.isSafeInteger(Number(afterId))||Number(afterId)<0)throw new Error('Invalid ingredient backfill cursor.');
    const conn=await pool.getConnection();
    try{
        await conn.beginTransaction();
        const [rows]=await conn.query('SELECT id FROM ingredients WHERE id>? ORDER BY id LIMIT 16 FOR UPDATE',[afterId]);
        await ensureWorkingBalances(conn,rows.map(row=>row.id));await conn.commit();return {complete:rows.length<16,rows:rows.length,after_id:Number(rows.at(-1)?.id??afterId)};
    }catch(error){await conn.rollback();throw error;}finally{conn.release();}
}

const recordManualMovement = async (conn, {
    ingredientId, kind, qty, unit, packs, reason, unitCost, costUnit, note, clientKey, actor, businessDate,
}) => {
    if (!clientKey || String(clientKey).length > 64) fail(400, 'client_key is required.');
    if (!['receipt', 'waste', 'count'].includes(kind)) fail(400, 'Invalid movement kind.');
    const existing = await findByClientKey(conn, clientKey);
    const ingredient = await loadIngredient(conn, ingredientId);
    if (!unitBelongsTo(ingredient.measure, unit)) fail(400, 'Unit does not match this ingredient.');
    const baseQty = packsToBase(packs, ingredient.pack_size, qty, unit);
    if (kind === 'count') {
        if (baseQty < 0) fail(400, 'Count cannot be negative.');
    } else if (!(baseQty > 0)) {
        fail(400, 'Quantity must be greater than zero.');
    }
    if (kind === 'waste') {
        if (!WASTE_REASONS.includes(reason)) fail(400, 'Waste requires a reason.');
    } else if (reason != null) {
        fail(400, 'Reason is only allowed on waste.');
    }
    const signedQty = kind === 'waste' ? roundSix(-baseQty) : baseQty;
    if (kind === 'receipt' && unitCost != null) {
        if (!unitBelongsTo(ingredient.measure, costUnit || unit)) fail(400, 'Cost unit does not match this ingredient.');
        if (finite(unitCost, 'Cost') < 0) fail(400, 'Cost cannot be negative.');
    }
    const wasteEstimate = kind === 'waste' ? (existing ? {unit_cost: existing.unit_cost, cost_source: existing.cost_source} : (await resolveIngredientCosts(conn,[ingredient],businessDate)).get(Number(ingredientId))) : null;
    const movementCost = wasteEstimate ? wasteEstimate.unit_cost : kind === 'receipt' && unitCost != null
        ? toBaseCost(unitCost, costUnit || unit)
        : (existing ? existing.unit_cost : ingredient.unit_cost == null ? null : Number(ingredient.unit_cost));
    const payload = {
        ingredient_id: Number(ingredientId),
        kind,
        qty: signedQty,
        reason: kind === 'waste' ? reason : null,
        unit_cost: movementCost,
        purchase_priced: kind === 'receipt' && unitCost != null,
        cost_source: wasteEstimate?.cost_source || (kind === 'receipt' && unitCost != null ? 'purchase' : undefined),
    };
    if (existing) {
        if (!sameManualPayload(existing, payload)) fail(409, 'client_key was reused with a different payload.');
        return { movement: existing, replay: true };
    }
    const countState=kind==='count'?await countExpectationsFor(conn,[Number(ingredientId)]):null;
    const countMeta=countState?.expectations.get(Number(ingredientId)) || {};
    const rows = [{
        ...payload,
        expected_qty: countMeta.expected_qty ?? null,
        period_usage_qty: countMeta.period_usage_qty ?? null,
        source_type: 'manual',
        ...actorFields(actor),
        business_date: businessDate,
        note: note ?? null,
        client_key: clientKey,
    }];
    try {
        const [movement] = await insertRows(conn, rows, { ingredients: [ingredient],workingBalances:countState?.workingBalances });
        return { movement, replay: false };
    } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        // Insertion waits for the winner. Take a current read of the now-existing
        // key, without introducing gap locks for ordinary new requests.
        const winner = await findByClientKey(conn, clientKey, true);
        if (!winner) throw error;
        if (!sameManualPayload(winner, payload)) fail(409, 'client_key was reused with a different payload.');
        return { movement: winner, replay: true };
    }
};

// The caller owns the transaction. Lock ingredients in the same order for the
// whole operation; retries must match every row, not only a surviving subset.
// Receipts posted by a purchase invoice carry this label and the invoice id as their source. Only the
// invoice's own reversal may correct them; the generic "correct recorded quantity" flow refuses them.
const PURCHASE_SOURCE_LABEL = 'Purchase invoice';

const recordStockBatch = async (conn, { kind, entries, clientKey, actor, businessDate, source = null }) => {
    if (!['receipt', 'count'].includes(kind)) fail(400, 'Invalid movement kind.');
    if (typeof clientKey !== 'string' || !clientKey.length || clientKey.length > 64) fail(400, 'client_key is required.');
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) fail(400, 'Enter between 1 and 100 ingredients.');
    const sorted = entries.map(entry => ({ ...entry, ingredient_id: Number(entry?.ingredient_id) })).sort((a, b) => a.ingredient_id - b.ingredient_id);
    if (sorted.some(entry => !Number.isSafeInteger(entry.ingredient_id) || entry.ingredient_id <= 0
        || entry.qty == null || String(entry.qty).trim() === '' || !Number.isFinite(Number(entry.qty)))
        || new Set(sorted.map(entry => entry.ingredient_id)).size !== sorted.length) fail(400, 'Enter a valid quantity for each unique ingredient.');
    const clause = inClause(sorted.map(entry => entry.ingredient_id));
    const [ingredients] = await conn.query(`SELECT id,is_active,measure,unit_cost FROM ingredients WHERE id IN (${clause.sql}) ORDER BY id FOR UPDATE`, clause.params);
    if (ingredients.length !== sorted.length) fail(404, 'Ingredient not found.');
    const prefix = 'batch:' + crypto.createHash('sha256').update(clientKey).digest('hex').slice(0, 40) + ':';
    const [stored] = await conn.query(`SELECT ${ingredientColumns()} FROM stock_movements WHERE movement_type='ingredient' AND client_key LIKE ? ORDER BY ingredient_id FOR UPDATE`, [prefix + '%']);
    if (stored.length && (stored.length !== sorted.length || stored.some((row, i) => Number(row.ingredient_id) !== sorted[i].ingredient_id || row.kind !== kind))) {
        fail(409, 'client_key was reused with a different payload.');
    }
    if (!stored.length && ingredients.some(row => !row.is_active)) fail(400, 'Inactive ingredients cannot receive stock movements.');
    const rows = sorted.map((entry, i) => {
        const ingredient = ingredients[i];
        if (!unitBelongsTo(ingredient.measure, entry.unit)) fail(400, 'Unit does not match this ingredient.');
        const qty = toBaseQty(entry.qty, entry.unit);
        if (kind === 'count' ? qty < 0 : !(qty > 0)) fail(400, 'Enter valid quantities for up to 100 ingredients. Receipts must be greater than zero.');
        if (entry.unit_cost != null && (kind !== 'receipt' || !Number.isFinite(Number(entry.unit_cost)) || Number(entry.unit_cost) < 0)) fail(400, 'Cost cannot be negative.');
        return {
            ingredient_id: entry.ingredient_id, kind, qty, reason: null,
            unit_cost: entry.unit_cost != null ? toBaseCost(entry.unit_cost, entry.unit) : (stored.length ? stored[i].unit_cost : ingredient.unit_cost),
            purchase_priced: kind === 'receipt' && entry.unit_cost != null,
            cost_source: kind === 'receipt' && entry.unit_cost != null ? 'purchase' : undefined,
            client_key: prefix + entry.ingredient_id, source_type: 'manual', ...actorFields(actor), business_date: businessDate,
            ...(source ? { source_label: source.label, source_id: source.id } : {}),
        };
    });
    if (stored.length) {
        if (stored.some((row, i) => !sameManualPayload(row, rows[i]))) fail(409, 'client_key was reused with a different payload.');
        return { movements: stored, replay: true };
    }
    const countState=kind==='count'?await countExpectationsFor(conn,rows.map(row=>row.ingredient_id)):null;
    if(countState)for(const row of rows)Object.assign(row,countState.expectations.get(row.ingredient_id));
    return { movements: await insertRows(conn, rows, { ingredients,workingBalances:countState?.workingBalances }), replay: false };
};

const recordOpeningCounts = async (conn, { entries, clientKey, actor, businessDate }) => {
    if (typeof clientKey !== 'string' || !clientKey.length || clientKey.length > 64) fail(400, 'client_key is required.');
    if (!Array.isArray(entries) || !entries.length) fail(400, 'Opening entries are required.');
    const incoming = entries.map(entry => ({
        ingredientId: Number(entry?.ingredientId ?? entry?.ingredient_id),
        qty: entry?.qty, unit: entry?.unit, packs: entry?.packs,
    })).sort((a, b) => a.ingredientId - b.ingredientId);
    if (incoming.some(entry => !Number.isSafeInteger(entry.ingredientId) || entry.ingredientId <= 0)
        || new Set(incoming.map(entry => entry.ingredientId)).size !== incoming.length) {
        fail(400, 'Opening ingredients must be valid and unique.');
    }
    const normalized = [];
    const ingredientList = inClause(incoming.map(entry => entry.ingredientId));
    const [ingredients] = await conn.query(
        `SELECT id, measure, unit_cost, pack_size,
                (SELECT id FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=ingredients.id AND kind='count' ORDER BY id DESC LIMIT 1 FOR UPDATE) AS previous_count_id
           FROM ingredients WHERE id IN (${ingredientList.sql}) ORDER BY id FOR UPDATE`,
        ingredientList.params
    );
    const ingredientById = new Map(ingredients.map(row => [Number(row.id), row]));
    for (const entry of incoming) {
        const ingredient = ingredientById.get(entry.ingredientId);
        if (!ingredient) fail(404, 'Ingredient not found.');
        if (!unitBelongsTo(ingredient.measure, entry.unit)) fail(400, 'Unit does not match this ingredient.');
        const qty = packsToBase(entry.packs, ingredient.pack_size, entry.qty, entry.unit);
        if (qty < 0) fail(400, 'Count cannot be negative.');
        normalized.push({ ingredient_id: entry.ingredientId, qty });
    }
    const prefix = 'opening:' + crypto.createHash('sha256').update(clientKey).digest('hex').slice(0, 32) + ':';
    const legacyPrefix = clientKey.replace(/[=%_]/g, '=$&') + ':%';
    const replay = async (current) => {
        const [stored] = await conn.query(
            `SELECT ${ingredientColumns()} FROM stock_movements
              WHERE movement_type='ingredient' AND (client_key=? OR client_key LIKE ? OR client_key LIKE ? ESCAPE '=')
              ORDER BY ingredient_id` + (current ? ' FOR UPDATE' : ''),
            [clientKey, prefix + '%', legacyPrefix]
        );
        if (stored.length !== normalized.length || stored.some((row, i) =>
            row.kind !== 'count' || row.source_type !== 'manual'
            || Number(row.ingredient_id) !== normalized[i].ingredient_id
            || roundSix(row.qty) !== normalized[i].qty)) {
            fail(409, 'client_key was reused with a different payload.');
        }
        return { movements: stored, replay: true };
    };
    if (await findByClientKey(conn, clientKey)) return replay(false);
    const rows = normalized.map((entry, index) => ({
        ...entry, kind: 'count', expected_qty: null, period_usage_qty: null,
        source_type: 'manual', source_label: 'Opening count',
        ...actorFields(actor), business_date: businessDate,
        client_key: index === 0 ? clientKey : prefix + entry.ingredient_id,
    }));
    // Older clients still use opening entry. A repeat is a real reconciliation,
    // not a fresh baseline that discards comparison with the previous count.
    const repeated=rows.filter(row=>ingredientById.get(row.ingredient_id).previous_count_id != null);
    if(repeated.length){
        const {expectations}=await countExpectationsFor(conn,repeated.map(row=>row.ingredient_id));
        for(const row of repeated)Object.assign(row,expectations.get(row.ingredient_id));
    }
    try {
        return { movements: await insertRows(conn, rows, { ingredients }), replay: false };
    } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY' || !await findByClientKey(conn, clientKey, true)) throw error;
        return replay(true);
    }
};

const correctManualMovement = async (conn, { movementId, note, clientKey, actor, businessDate, correctedQty, unit, allowPurchase = false }) => {
    if (!clientKey || String(clientKey).length > 64) fail(400, 'client_key is required.');
    const existing = await findByClientKey(conn, clientKey);
    const [[target]] = await conn.query(
        `SELECT ${ingredientColumns()} FROM stock_movements WHERE movement_type='ingredient' AND id=?`,
        [movementId]
    );
    if (!target) fail(404, 'Movement not found.');
    if (!['receipt', 'waste'].includes(target.kind)) fail(400, 'Only receipt and waste can be corrected.');
    if (target.source_label === PURCHASE_SOURCE_LABEL && !allowPurchase) {
        fail(409, 'This receipt belongs to a purchase invoice. Reverse the invoice instead.');
    }
    const ingredient = await loadIngredient(conn, target.ingredient_id);
    let replacementQty = 0;
    if (correctedQty != null) {
        if (!unitBelongsTo(ingredient.measure, unit)) fail(400, 'Unit does not match this ingredient.');
        replacementQty = toBaseQty(correctedQty, unit) * (target.kind === 'waste' ? -1 : 1);
        if (Math.abs(replacementQty) === Math.abs(Number(target.qty))) fail(400, 'Enter a different quantity to correct this entry.');
    }
    const [[already]] = await conn.query(
        `SELECT id FROM stock_movements WHERE movement_type='ingredient' AND corrects_movement_id=? LIMIT 1 FOR UPDATE`,
        [target.id]
    );
    const payload = {
        ingredient_id: Number(target.ingredient_id),
        kind: 'correction',
        qty: roundSix(replacementQty - Number(target.qty)),
        reason: null,
        unit_cost: target.unit_cost == null ? null : Number(target.unit_cost),
    };
    if (existing) {
        if (!sameManualPayload(existing, payload) || Number(existing.corrects_movement_id) !== Number(target.id) || (correctedQty != null && existing.note !== note)) {
            fail(409, 'client_key was reused with a different payload.');
        }
        return { movement: existing, replay: true };
    }
    if (already) {
        const winner = await findByClientKey(conn, clientKey, true);
        if (winner && Number(winner.corrects_movement_id) === Number(target.id) && sameManualPayload(winner, payload) && (correctedQty == null || winner.note === note)) {
            return { movement: winner, replay: true };
        }
        fail(409, 'This movement was already corrected.');
    }
    const [movement] = await insertRows(conn, [{
        ...payload,
        source_type: 'manual',
        source_id: target.id,
        ...actorFields(actor),
        business_date: businessDate,
        note: note ?? null,
        client_key: clientKey,
        corrects_movement_id: target.id,
    }], { ingredients: [ingredient] });
    return { movement, replay: false };
};

const amendManualMovement = async (conn, { qty, note, ...args }) => {
    if (qty == null || String(qty).trim() === '' || !Number.isFinite(Number(qty)) || Number(qty) < 0) fail(400, 'Enter the correct quantity, or zero to cancel the entry.');
    if (typeof note !== 'string' || !note.trim() || note.trim().length > 500) fail(400, 'Enter a correction reason of up to 500 characters.');
    // A linked delta, rather than a new receipt, also preserves any physical
    // count made after the original entry. The original remains immutable.
    return correctManualMovement(conn, { ...args, correctedQty: Number(qty), note: note.trim() });
};

const lastCountShape = (row) => {
    if (!row) return null;
    const expected = asNumber(row.expected_qty);
    const period = asNumber(row.period_usage_qty);
    const qty = Number(row.qty);
    const variance_qty = expected == null ? null : roundSix(qty - expected);
    return {
        at: row.occurred_at,
        qty,
        expected_qty: expected,
        variance_qty,
        variance_pct: variance_qty == null || !(period > 0) ? null : roundSix(variance_qty / period),
    };
};

const currentBalanceSql = `CASE WHEN c.id IS NULL THEN NULL
    WHEN c.id=(SELECT id FROM stock_movements FORCE INDEX (idx_im_balance)
                WHERE movement_type='ingredient' AND ingredient_id=i.id ORDER BY id DESC LIMIT 1) THEN c.qty
    ELSE c.qty + (
        SELECT COALESCE(SUM(CASE
            WHEN t.kind='count' OR (t.kind='correction' AND t.corrects_movement_id<=c.id) THEN 0
            ELSE t.qty END),0)
        FROM stock_movements t FORCE INDEX (idx_im_balance) WHERE t.movement_type='ingredient' AND t.ingredient_id=i.id AND t.id>c.id
    ) END`;
const latestCountJoinSql = `LEFT JOIN stock_movements c ON c.movement_type='ingredient' AND c.id=(
    SELECT id FROM stock_movements FORCE INDEX (idx_im_ingredient_kind_id)
    WHERE movement_type='ingredient' AND ingredient_id=i.id AND kind='count' ORDER BY id DESC LIMIT 1
)`;

const ingredientCatalogSql = 'i.id,i.name,i.measure,i.display_unit,i.unit_cost,i.par_qty,i.pack_name,i.pack_size,i.is_active,i.created_at,i.updated_at';
const workingBalanceSql = `CASE WHEN i.stock_item_id IS NOT NULL THEN
    (SELECT CASE WHEN b.quantity_known=1 THEN b.quantity ELSE NULL END
     FROM stock_balances b WHERE b.stock_item_id=i.stock_item_id)
    WHEN i.working_quantity_known=1 THEN i.working_quantity ELSE NULL END`;

const getIngredientBalances = async (conn, { ingredientIds, includeInactive = false } = {}) => {
    if (ingredientIds && !ingredientIds.length) return [];
    const ids = ingredientIds ? inClause([...new Set(ingredientIds)]) : null;
    const [rows] = await conn.query(`
        SELECT ${ingredientCatalogSql}, ${workingBalanceSql} AS expected_remaining
          FROM ingredients i
         WHERE (?=1 OR i.is_active=1) ${ids ? `AND i.id IN (${ids.sql})` : ''}
         ORDER BY i.name,i.id`, [includeInactive ? 1 : 0, ...(ids?.params || [])]);
    return rows.map(row => {
        const expected = asNumber(row.expected_remaining), par = asNumber(row.par_qty);
        return { ...row, id: Number(row.id), expected_remaining: expected, par_qty: par,
            pack_size: asNumber(row.pack_size),
            below_par: par != null && expected != null && expected < par };
    });
};

const getIngredientSummaries = async (conn, { businessDate, includeInactive, ids, dailyProjection } = {}) => {
    const idList = Array.isArray(ids)
        ? [...new Set(ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))]
        : null;
    if (idList && !idList.length) return [];
    const movementFilter = idList ? ' WHERE business_date=? AND ingredient_id IN (?)' : ' WHERE business_date=?';
    const identityFilter = idList ? ' WHERE i.id IN (?)' : ' WHERE ?=1 OR i.is_active=1';
    let params = idList
        ? [businessDate || getBusinessDate(), idList, idList]
        : [businessDate || getBusinessDate(), includeInactive ? 1 : 0];
    let dailySql=`              SELECT ingredient_id,
                     MIN(CASE WHEN kind='count' THEN id END) AS opening_id,
                     SUM(CASE WHEN kind='receipt' THEN qty ELSE 0 END) AS received,
                     -SUM(CASE WHEN kind IN ('usage','reversal') THEN qty ELSE 0 END) AS used,
                     -SUM(CASE WHEN kind='waste' THEN qty ELSE 0 END) AS waste,
                     SUM(CASE WHEN kind='correction' THEN qty ELSE 0 END) AS corrections,
                     -SUM(CASE WHEN kind IN ('usage','reversal') THEN qty*COALESCE(unit_cost,0) ELSE 0 END) AS used_cost,
                     -SUM(CASE WHEN kind='waste' THEN qty*COALESCE(unit_cost,0) ELSE 0 END) AS waste_cost
                FROM stock_movements${movementFilter} AND movement_type='ingredient' GROUP BY ingredient_id
`;
    if(dailyProjection){
        const fields=['ingredient_id','opening_id','received','used','waste','corrections','used_cost','waste_cost'];
        dailySql=dailyProjection.rows.map(()=>`SELECT ${fields.map(field=>`? ${field}`).join(',')}`).join(' UNION ALL ');
        params=[...dailyProjection.rows.flatMap(row=>[row.id,row.opening_id,...fields.slice(2).map(field=>row[field])]),...(idList?[idList]:[includeInactive?1:0])];
    }
    // One statement gives every field the same snapshot. Each latest Count is a
    // bounded index lookup; today's aggregation reads only the requested date.
    // Pin balance scans to their covering index: stale growth statistics can
    // otherwise choose the Count index and fetch every movement's full row.
    const [rows] = await conn.query(`
        SELECT ${ingredientCatalogSql},
               CAST(i.stock_item_id AS CHAR) AS stock_item_id,
               (SELECT COUNT(*) FROM product_recipe_lines r WHERE r.ingredient_id=i.id) AS recipe_product_count,
               c.id AS count_id, c.qty AS count_qty, c.occurred_at AS count_at,
               c.expected_qty AS count_expected, c.period_usage_qty AS count_period,
               ${workingBalanceSql} AS expected_remaining,
               opening.qty AS opening_qty,
               COALESCE(d.received,0) AS received, COALESCE(d.used,0) AS used,
               COALESCE(d.waste,0) AS waste, COALESCE(d.corrections,0) AS corrections,
               COALESCE(d.used_cost,0) AS used_cost, COALESCE(d.waste_cost,0) AS waste_cost
          FROM ingredients i

          LEFT JOIN stock_movements c ON c.movement_type='ingredient' AND c.id=i.working_last_count_id
          LEFT JOIN (${dailySql}) d ON d.ingredient_id=i.id
          LEFT JOIN stock_movements opening ON opening.movement_type='ingredient' AND opening.id=d.opening_id
        ${identityFilter}
         ORDER BY i.name,i.id
    `, params);
    return rows.map(row => {
        const expected = asNumber(row.expected_remaining);
        const par = asNumber(row.par_qty);
        return {
            id: Number(row.id), name: row.name, measure: row.measure,
            display_unit: row.display_unit, unit_cost: asNumber(row.unit_cost),
            par_qty: par, pack_name: row.pack_name, pack_size: asNumber(row.pack_size),
            is_active: Number(row.is_active) === 1,
            stock_item_id: row.stock_item_id ?? null,
            recipe_product_count: Number(row.recipe_product_count),
            today: {
                opening: dailyProjection?.freshness.state==='rebuilding'?null:asNumber(row.opening_qty), received: roundSix(row.received),
                used: roundSix(row.used), waste: roundSix(row.waste),
                corrections: roundSix(row.corrections),
                used_cost: roundEight(row.used_cost), waste_cost: roundEight(row.waste_cost),
                ...(dailyProjection?.freshness.state==='rebuilding'?Object.fromEntries(['opening','received','used','waste','corrections','used_cost','waste_cost'].map(key=>[key,null])):{}),
            },
            expected_remaining: expected,
            below_par: par != null && expected != null && expected < par,
            last_count: row.count_id == null ? null : lastCountShape({
                qty: row.count_qty, occurred_at: row.count_at,
                expected_qty: row.count_expected, period_usage_qty: row.count_period,
            }),
        };
    });
};

const listIngredientPage = async (conn, query = {}) => {
    const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
    const limit = query.limit == null || query.limit === '' ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('An ingredient page contains 1 to 100 items.');
    const q=String(query.q||'').trim(),status=query.status||(query.includeInactive?'all':'active');
    const measure=query.measure||'all',attention=query.attention||'all',sort=query.sort||'name';
    if([...q].length>100||!['active','inactive','all'].includes(status)||!['all','weight','volume','count'].includes(measure)
        ||!['all','attention','uncounted','missing-price','variance'].includes(attention)||!['name','attention','variance'].includes(sort))invalid('Invalid ingredient filter.');
    const view=query.view||'ledger';if(!['ledger','picker'].includes(view))invalid('Invalid ingredient view.');
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify({q,status,measure,attention,sort,view})).digest('hex');
    let after;
    if(query.cursor)try{
        if(typeof query.cursor!=='string'||query.cursor.length>1400)throw new Error();
        after=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8'));
        if(after.v!==2||after.filter!==fingerprint||typeof after.name!=='string'||[...after.name].length>100||!Number.isSafeInteger(after.id)||after.id<1||!Number.isFinite(after.priority))throw new Error();
    }catch{invalid('The ingredient page cursor does not match these filters. Start from the first page.');}
    const shortage=`(i.is_active=1 AND (${workingBalanceSql}<0 OR ${workingBalanceSql}<i.par_qty))`;
    const priority=sort==='attention'?`COALESCE(${shortage},0)`:sort==='variance'?'COALESCE(ABS(i.working_variance_qty),0)':'0';
    const where=[],args=[];
    if(status!=='all'){where.push('i.is_active=?');args.push(status==='active'?1:0);}
    if(measure!=='all'){where.push('i.measure=?');args.push(measure);}
    if(q){where.push("i.name LIKE ? ESCAPE '='");args.push(q.replace(/[=%_]/g,char=>'='+char)+'%');}
    if(attention==='attention')where.push(shortage);
    if(attention==='uncounted')where.push(`i.is_active=1 AND i.working_initialized=1 AND ${workingBalanceSql} IS NULL`);
    if(attention==='missing-price')where.push('i.is_active=1 AND i.unit_cost IS NULL');
    if(attention==='variance')where.push('i.is_active=1 AND ABS(i.working_variance_qty)>0');
    if(after){where.push(`(${priority}<? OR (${priority}=? AND (i.name>? OR (i.name=? AND i.id>?))))`);args.push(after.priority,after.priority,after.name,after.name,after.id);}
    const [identities]=await conn.query(`SELECT i.id,i.name,${priority} priority FROM ingredients i
        ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY priority DESC,i.name,i.id LIMIT ?`,[...args,limit+1]);
    const more=identities.length>limit,page=identities.slice(0,limit);
    const daily=view==='picker'?null:await require('./StockReportFactService').readDaily(conn,{day:query.businessDate||getBusinessDate(),ids:page.map(row=>row.id),kind:'ingredient'});
    const hydrated=view==='picker'?await getIngredientBalances(conn,{includeInactive:true,ingredientIds:page.map(row=>row.id)}):await getIngredientSummaries(conn,{businessDate:query.businessDate,includeInactive:true,ids:page.map(row=>row.id),dailyProjection:daily});
    const byId=new Map(hydrated.map(row=>[row.id,row]));
    const [[missing]]=await conn.query('SELECT i.id FROM ingredients i WHERE i.working_initialized=0 LIMIT 1');
    const last=page.at(-1);
    return {items:page.map(row=>byId.get(row.id)),next_cursor:more?Buffer.from(JSON.stringify({v:2,filter:fingerprint,name:last.name,id:last.id,priority:Number(last.priority)})).toString('base64url'):null,
        limit,has_more:more,freshness:{state:missing?'rebuilding':'current'},...(daily?{daily_freshness:daily.freshness}:{})};
};

const listMovements = async (conn, { ingredientId, from, to, beforeId, limit } = {}) => {
    const pageSize = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 200);
    const params = [ingredientId];
    let sql = `SELECT ${ingredientColumns('m')},
        (SELECT id FROM stock_movements WHERE movement_type='ingredient' AND corrects_movement_id=m.id LIMIT 1) AS corrected_by_id,
        (SELECT qty FROM stock_movements WHERE movement_type='ingredient' AND id=m.corrects_movement_id) AS original_qty
        FROM stock_movements m WHERE m.movement_type='ingredient' AND ingredient_id=?`;
    if (from) { sql += ' AND business_date>=?'; params.push(from); }
    if (to) { sql += ' AND business_date<=?'; params.push(to); }
    if (beforeId) { sql += ' AND id<?'; params.push(beforeId); }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(pageSize);
    const [page] = await conn.query(sql, params);
    if (!page.length) return { rows: [] };
    const firstId = page[page.length - 1].id;
    const lastId = page[0].id;
    // Movements are immutable. Bound every later read to this page's ids so new
    // commits cannot change its historical balances.
    const [[anchor]] = await conn.query(
        `SELECT c.id, c.qty + (
            SELECT COALESCE(SUM(CASE
                WHEN t.kind='count' OR (t.kind='correction' AND t.corrects_movement_id<=c.id) THEN 0
                ELSE t.qty END),0)
              FROM stock_movements t FORCE INDEX (idx_im_balance)
             WHERE t.movement_type='ingredient' AND t.ingredient_id=? AND t.id>c.id AND t.id<?
        ) AS balance
          FROM stock_movements c FORCE INDEX (idx_im_ingredient_kind_id)
         WHERE c.movement_type='ingredient' AND c.ingredient_id=? AND c.kind='count' AND c.id<?
         ORDER BY c.id DESC LIMIT 1`,
        [ingredientId, firstId, ingredientId, firstId]
    );
    const [span] = await conn.query(
        `SELECT id,kind,qty,corrects_movement_id FROM stock_movements
          WHERE movement_type='ingredient' AND ingredient_id=? AND id>=? AND id<=? ORDER BY id`,
        [ingredientId, firstId, lastId]
    );
    let countId = anchor?.id ?? null;
    let balance = anchor ? Number(anchor.balance) : null;
    const balances = new Map();
    for (const row of span) {
        if (row.kind === 'count') { countId = row.id; balance = Number(row.qty); }
        else if (balance != null && !(row.kind === 'correction' && Number(row.corrects_movement_id) <= Number(countId))) {
            balance = roundSix(balance + Number(row.qty));
        }
        balances.set(String(row.id), balance);
    }
    return { rows: page.map(row => {
        const shaped = lastCountShape(row.kind === 'count' ? row : null);
        return { ...row, running_balance: balances.get(String(row.id)),
            variance_qty: shaped?.variance_qty ?? null, variance_pct: shaped?.variance_pct ?? null };
    }) };
};

const getPortionsReport = async (conn, { productId } = {}) => {
    const [lines] = await conn.query(`
        SELECT p.id AS product_id, p.name, prl.ingredient_id, prl.qty_per_unit
          FROM product_recipe_lines prl
          JOIN products p ON p.id = prl.product_id
         WHERE p.is_active = 1 ${productId ? 'AND p.id=?' : ''}
         ORDER BY p.id, prl.sort_order, prl.id
    `, productId ? [productId] : []);
    if (!lines.length) return [];
    const summaries = await getIngredientBalances(conn, {
        ingredientIds: lines.map(row => Number(row.ingredient_id)), includeInactive: true,
    });
    const expectedByIngredient = new Map(summaries.map(row => [row.id, row.expected_remaining]));
    const nameByIngredient = new Map(summaries.map(row => [row.id, row.name]));
    const byProduct = new Map();
    for (const row of lines) {
        const productId = Number(row.product_id);
        if (!byProduct.has(productId)) {
            byProduct.set(productId, { product_id: productId, name: row.name, recipeLines: [] });
        }
        byProduct.get(productId).recipeLines.push({
            ingredient_id: Number(row.ingredient_id),
            qty_per_unit: Number(row.qty_per_unit),
        });
    }
    return [...byProduct.values()].map((product) => {
        const possible = portionsPossible(product.recipeLines, expectedByIngredient);
        return {
            product_id: product.product_id,
            name: product.name,
            portions_possible: possible ? possible.portions : null,
            limiting_ingredient: possible
                ? { id: possible.limiting_ingredient_id, name: nameByIngredient.get(possible.limiting_ingredient_id) || null }
                : null,
        };
    });
};

const emptyDaySummary = () => ({
    ingredients: [],
    waste_by_reason: {},
    totals: {
        used_cost: 0,
        waste_cost: 0,
        sales_total: null,
        food_cost_pct: null,
        below_par_count: 0,
    },
});

const isDateOnly = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const [year, month, day] = String(value).split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() === month - 1
        && parsed.getUTCDate() === day;
};

const getDaySummary = async (conn, { businessDate, date } = {}) => {
    const day = businessDate || date;
    if (!isDateOnly(day)) return emptyDaySummary();

    // Carry all post-Count movements through the requested day, not merely the
    // selected day's rows. Aggregate the interval in SQL instead of loading all
    // historical Counts or transferring the entire movement history.
    const [ingredients] = await conn.query(`
        SELECT i.id, i.name, i.measure, i.display_unit, i.unit_cost, i.par_qty,
               i.pack_name, i.pack_size, i.is_active,
               CASE WHEN c.id IS NULL THEN NULL ELSE c.qty + (
                   SELECT COALESCE(SUM(CASE
                       WHEN t.kind='count' OR (t.kind='correction' AND t.corrects_movement_id<=c.id) THEN 0
                       ELSE t.qty END),0)
                     FROM stock_movements t FORCE INDEX (idx_im_balance)
                    WHERE t.movement_type='ingredient' AND t.ingredient_id=i.id AND t.id>c.id AND t.business_date<=?
               ) END AS closing_expected
          FROM ingredients i
          LEFT JOIN stock_movements c ON c.movement_type='ingredient' AND c.id=(
              SELECT id FROM stock_movements FORCE INDEX (idx_im_ingredient_kind_id)
               WHERE movement_type='ingredient' AND ingredient_id=i.id AND kind='count' AND business_date<=?
               ORDER BY id DESC LIMIT 1
          )
         ORDER BY i.name,i.id
    `, [day, day]);
    const [dayRows] = await conn.query(
        `SELECT ingredient_id, kind,
                reason, SUM(qty) AS qty, SUM(qty*COALESCE(unit_cost,0)) AS cost
           FROM stock_movements WHERE movement_type='ingredient' AND business_date=? AND kind<>'count'
          GROUP BY ingredient_id, kind, reason`,
        [day]
    );
    const [countRows] = await conn.query(
        `SELECT ingredient_id, kind, qty, expected_qty, period_usage_qty, occurred_at
           FROM stock_movements WHERE movement_type='ingredient' AND business_date=? AND kind='count' ORDER BY ingredient_id, id`,
        [day]
    );

    const dayByIngredient = new Map();
    for (const row of [...dayRows, ...countRows]) {
        const id = Number(row.ingredient_id);
        if (!dayByIngredient.has(id)) dayByIngredient.set(id, []);
        dayByIngredient.get(id).push(row);
    }

    const waste_by_reason = {};
    let usedCostTotal = 0;
    let wasteCostTotal = 0;
    let belowParCount = 0;

    const rows = ingredients.map((ingredient) => {
        const id = Number(ingredient.id);
        const today = dayByIngredient.get(id) || [];
        const firstCount = today.find((row) => row.kind === 'count');
        const closing_expected = asNumber(ingredient.closing_expected);
        const par = asNumber(ingredient.par_qty);
        const below_par = par != null && closing_expected != null && closing_expected < par;
        if (below_par) belowParCount += 1;

        const reasonMap = {};
        for (const row of today.filter((item) => item.kind === 'waste')) {
            const reason = row.reason || 'other';
            reasonMap[reason] = roundSix((reasonMap[reason] || 0) + (-Number(row.qty)));
            waste_by_reason[reason] = roundSix((waste_by_reason[reason] || 0) + (-Number(row.qty)));
        }

        // Sum exact stored quantity x cost in SQL before rounding, as on the
        // ingredient list. Per-movement rounding loses fractional recipe costs.
        const used_cost = roundEight(-today.filter(row => row.kind === 'usage' || row.kind === 'reversal').reduce((sum, row) => sum + Number(row.cost), 0));
        const waste_cost = roundEight(-today.filter(row => row.kind === 'waste').reduce((sum, row) => sum + Number(row.cost), 0));
        usedCostTotal = roundEight(usedCostTotal + used_cost);
        wasteCostTotal = roundEight(wasteCostTotal + waste_cost);

        return {
            id,
            name: ingredient.name,
            measure: ingredient.measure,
            display_unit: ingredient.display_unit,
            unit_cost: asNumber(ingredient.unit_cost),
            par_qty: par,
            pack_name: ingredient.pack_name,
            pack_size: asNumber(ingredient.pack_size),
            is_active: Number(ingredient.is_active) === 1,
            opening: firstCount ? Number(firstCount.qty) : null,
            received: sumKind(today, 'receipt'),
            used: roundSix(-sumKind(today, 'usage') - sumKind(today, 'reversal')),
            waste: roundSix(-sumKind(today, 'waste')),
            waste_by_reason: reasonMap,
            corrections: sumKind(today, 'correction'),
            closing_expected,
            below_par,
            counts: today.filter((row) => row.kind === 'count').map((row) => lastCountShape(row)),
            used_cost,
            waste_cost,
        };
    });

    const { parseDailyReportPeriod } = require('./dailyReportPeriod');
    const { getFinancialEventsForPeriod, combineFinancialEvents } = require('./financialEventMetrics');
    const period = parseDailyReportPeriod({ startDate: day, endDate: day });
    const metrics = await getFinancialEventsForPeriod(conn, period.business_start_at, period.business_end_at);
    const sales_total = combineFinancialEvents(metrics, metrics).sales_collected;
    const food_cost_pct = Number.isFinite(sales_total) && sales_total > 0
        ? roundEight(usedCostTotal / sales_total)
        : null;

    return {
        date: day,
        period,
        ingredients: rows,
        waste_by_reason,
        totals: {
            used_cost: usedCostTotal,
            waste_cost: wasteCostTotal,
            sales_total,
            food_cost_pct,
            below_par_count: belowParCount,
        },
    };
};

module.exports = {
    roundSix, roundEight, SCALE, DISPLAY_UNITS, WASTE_REASONS, unitBelongsTo, resolveIngredientCosts,
    toBaseQty, fromBaseQty, toBaseCost, fromBaseCost, packsToBase, newLineKey, assignLineKey,
    resolveComposition, reversalRows, planLineRows, effectiveBalance, portionsPossible,
    isEnabled, lockLineIngredients, loadRecipeContext,
    syncOrderLines, reverseLineUsage, reverseLinesUsage, transferLineUsage,
    recordManualMovement, recordOpeningCounts, recordStockBatch, correctManualMovement, amendManualMovement, PURCHASE_SOURCE_LABEL,
    backfillWorkingBalances, getIngredientSummaries, listIngredientPage, listMovements, getPortionsReport,
    getDaySummary,
};
