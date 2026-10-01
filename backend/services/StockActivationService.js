'use strict';

const { createHash } = require('node:crypto');
const quantity = require('./stockQuantity');
const ledger = require('./StockLedgerService');
const invalidation = require('./StockReportInvalidation');
const { appendAuditEvent } = require('./auditEvents');
const { getBusinessDate } = require('../utils/businessDate');

function fail(message, statusCode = 409) { throw Object.assign(new Error(message), { statusCode }); }
function productId(value) {
    if (!/^[1-9]\d{0,9}$/.test(String(value))) fail('Invalid product.', 400);
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) fail('Invalid product.', 400);
    return id;
}

async function inspect(conn, value, lockedProduct) {
    const id = productId(value);
    const [[product]] = lockedProduct ? [[lockedProduct]] : await conn.query(
        'SELECT id,name,CAST(stock AS CHAR) AS stock,CAST(stock_version AS CHAR) AS stock_version,is_active,is_bundle,category_id FROM products WHERE id=?', [id]);
    if (!product) fail('Product not found.', 404);
    const [links] = await conn.query('SELECT CAST(stock_item_id AS CHAR) AS stock_item_id FROM product_stock_links WHERE product_id=? ORDER BY stock_item_id', [id]);
    const link=links.length===1?links[0]:null;
    const state = { product_id: id, name: product.name, stock: product.stock, stock_version: String(product.stock_version),
        stock_item_id: link?.stock_item_id ?? null, quantity_known: product.stock != null, blockers: [] };
    if (links.length) {
        const {availabilitySql}=require('./StockProductAdapter');
        const [[available]]=await conn.query(`SELECT ${availabilitySql('p')} stock FROM products p WHERE p.id=?`,[id]);
        return {...state,stock:available.stock,quantity_known:available.stock!=null,stock_item_ids:links.map(row=>row.stock_item_id),component_count:links.length,active:true,can_activate:false};
    }
    const add = (code, message, reference) => state.blockers.push({ code, message, ...(reference ? { reference } : {}) });
    const [[setting]] = await conn.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled'");
    if (setting?.setting_value !== '1') add('stock_disabled', 'Enable stock tracking before recording stock movements.');
    if (Number(product.is_active) !== 1) add('inactive', 'Activate this product before enabling its stock record.');
    if (Number(product.is_bundle) === 1) add('bundle', 'A bundle uses its component stock. Set up its recipe instead.');
    if (product.stock != null && quantity.parse(product.stock) < 0n) add('negative', 'Count this product before enabling its stock record.');
    const [[policy]] = await conn.query(`SELECT
        EXISTS(SELECT 1 FROM product_recipe_lines WHERE product_id=?) AS has_recipe,
        EXISTS(SELECT 1 FROM categories WHERE id=? AND is_notes=1) AS is_note,
        EXISTS(SELECT 1 FROM stock_items WHERE legacy_product_id=?) AS has_identity`, [id, product.category_id, id]);
    if (policy.has_recipe) add('recipe', 'This product already consumes recipe ingredients. Manage its ingredient stock instead.');
    if (policy.is_note) add('non_stock_product', 'This product does not represent a separately stocked item.');
    if (policy.has_identity) add('existing_identity', 'This product already has a stock identity. Restore its existing link before continuing.');
    const [[open]] = await conn.query(`SELECT o.invoice_id,o.table_id FROM order_items oi
        JOIN orders o ON o.invoice_id=oi.invoice_id
        WHERE oi.product_id=? AND oi.parent_item_id IS NULL AND o.payment_method='unpaid_table' LIMIT 1`, [id]);
    if (open) add('open_order', 'Settle or clear open table orders containing this product first.', { invoice_id: open.invoice_id, table_id: open.table_id });
    const [[invalidHeld]] = await conn.query(`SELECT id FROM held_orders WHERE
        CASE WHEN JSON_VALID(cart_data)=1 THEN
            NOT (JSON_TYPE(cart_data)='ARRAY' OR
                (JSON_TYPE(cart_data)='OBJECT' AND COALESCE(JSON_TYPE(JSON_EXTRACT(cart_data,'$.items')),'')='ARRAY'))
        ELSE 1 END LIMIT 1`);
    if (invalidHeld) add('invalid_hold', 'A held order cannot be read safely. Review it before activating stock.', { held_order_id: invalidHeld.id });
    else {
        // Extract only identity fields before containment checks. Searching the
        // entire cart eight times made a large backlog expensive. JSON_CONTAINS
        // handles the nested result arrays and preserves numeric/string IDs.
        const ids = "JSON_EXTRACT(cart_data,'$[*].id','$[*].product_id','$.items[*].id','$.items[*].product_id')";
        const [[held]] = await conn.query(`SELECT id FROM held_orders
            WHERE JSON_CONTAINS(${ids},?)=1 OR JSON_CONTAINS(${ids},?)=1 LIMIT 1`, [JSON.stringify(id), JSON.stringify(String(id))]);
        if (held) add('held_order', 'Complete or remove held and split orders containing this product first.', { held_order_id: held.id });
    }
    return { ...state, active: false, can_activate: state.blockers.length === 0 };
}

// Caller uses a READ COMMITTED transaction. The product lock serializes mapping
// changes; non-locking source checks then see any order committed while waiting
// for that lock without reversing the checkout source-order/product lock order.
async function activate(conn, value, input, actorId, ipAddress) {
    const id = productId(value);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['expected_stock_version', 'request_key'].includes(key))) fail('Invalid activation request.', 400);
    const version = String(input.expected_stock_version ?? '');
    if (!/^\d{1,20}$/.test(version)) fail('Reload the product before enabling stock movements.');
    if (typeof input.request_key !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(input.request_key)) fail('Invalid request key.', 400);
    const hash = createHash('sha256').update(JSON.stringify(['activate_product', id, version, actorId])).digest('hex');
    await conn.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled' FOR UPDATE");
    const [[product]] = await conn.query('SELECT id,name,barcode,CAST(stock AS CHAR) AS stock,CAST(stock_version AS CHAR) AS stock_version,is_active,is_bundle,category_id FROM products WHERE id=? FOR UPDATE', [id]);
    if (!product) fail('Product not found.', 404);
    const [[previous]] = await conn.query('SELECT result_json FROM stock_operations WHERE request_key=?', [input.request_key]);
    if (previous) {
        const saved = typeof previous.result_json === 'string' ? JSON.parse(previous.result_json) : previous.result_json;
        if (saved?.activation?.payload_hash !== hash || !saved.activation.result) fail('This request key belongs to a different stock operation.');
        return { ...saved.activation.result, replayed: true };
    }
    if (String(product.stock_version) !== version) fail('Stock changed. Reload the product before enabling stock movements.');
    const state = await inspect(conn, id, product);
    if (state.active) fail('Stock movements are already enabled for this product.');
    if (!state.can_activate) fail(state.blockers[0].message);
    const [item] = await conn.query("INSERT INTO stock_items(name,measure,base_unit,legacy_product_id,tracking_state,barcode) VALUES (?,'count','unit',?,'active',?)",
        [[...product.name].slice(0, 100).join(''), id, product.barcode || null]);
    const businessDate = getBusinessDate();
    let posted;
    if (product.stock != null) {
        posted = await ledger.post(conn, { kind: 'opening', request_key: input.request_key, business_date: businessDate,
            lines: [{ stock_item_id: String(item.insertId),
                quantity: quantity.format(quantity.parse(product.stock)), expected_version: '0', source_line: `activation:product:${id}` }] }, actorId);
    } else {
        // Activation is evidence of the authority change, not an invented count.
        // The first explicit count will establish quantity_known and a movement.
        const [operation] = await conn.query("INSERT INTO stock_operations(request_key,payload_hash,kind,actor_id,business_date,legacy_product_id) VALUES (?,?,'activation',?,?,?)",
            [input.request_key, hash, actorId, businessDate, id]);
        await conn.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known,version,last_operation_id) VALUES (?,0,0,0,?)',
            [item.insertId, operation.insertId]);
        posted = { operation_id: operation.insertId, lines: [] };
        await invalidation.operations(conn, businessDate, [posted.operation_id]);
    }
    await conn.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale,policy_version) VALUES (?,?,1,1)', [id, item.insertId]);
    await conn.query('UPDATE products SET stock_version=stock_version+1 WHERE id=?', [id]);
    const result = { operation_id: posted.operation_id, product_id: id, stock_item_id: String(item.insertId), stock: product.stock,
        stock_version: String(BigInt(version) + 1n), quantity_known: product.stock != null, active: true };
    await conn.query('UPDATE stock_operations SET legacy_product_id=?,result_json=? WHERE id=?',
        [id, JSON.stringify({ ...posted, activation: { payload_hash: hash, result } }), posted.operation_id]);
    await appendAuditEvent(conn, { eventType: 'stock_authority_activated', userId: actorId, entityType: 'product', entityId: id,
        oldValue: { stock: product.stock, stock_version: version }, newValue: result, ipAddress });
    return result;
}

// Cutover evidence, not an activation command. The caller owns the transaction
// and must acquire any source/product locks before this ingredient lock. Current
// reads are intentional: a caller may already have an older consistent snapshot.
async function readIngredientOpening(conn, value, options = {}) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail('Invalid ingredient.', 400);
    const id = Number(value);
    const lock = options.lock === false ? '' : ' FOR UPDATE';
    const [[ingredient]] = await conn.query(`SELECT id,name,measure,is_active FROM ingredients WHERE id=?${lock}`, [id]);
    if (!ingredient) fail('Ingredient not found.', 404);
    const [[count]] = await conn.query(`SELECT CAST(id AS CHAR) AS id,CAST(qty AS CHAR) AS qty
        FROM stock_movements FORCE INDEX (idx_im_ingredient_kind_id)
        WHERE movement_type='ingredient' AND ingredient_id=? AND kind='count' ORDER BY id DESC LIMIT 1${lock}`, [id]);
    const countId = count?.id ?? '0';
    // A correction to a receipt predating a physical count changes historical
    // paperwork, not the stock observed at that count. Aggregate in SQL DECIMAL;
    // passing these quantities through Number can lose the sixth decimal place.
    const [[tail]] = await conn.query(`SELECT CAST(COALESCE(MAX(id),?) AS CHAR) AS watermark,
        CAST(COALESCE(SUM(CASE WHEN kind='correction' AND corrects_movement_id<=? THEN 0 ELSE qty END),0) AS CHAR) AS delta,
        CAST(CAST(? AS DECIMAL(16,6)) + COALESCE(SUM(CASE
            WHEN kind='correction' AND corrects_movement_id<=? THEN 0 ELSE qty END),0) AS CHAR) AS quantity
        FROM stock_movements FORCE INDEX (idx_im_balance)
        WHERE movement_type='ingredient' AND ingredient_id=? AND id>?${lock}`, [countId, countId, count?.qty ?? '0', countId, id, countId]);
    let opening = null;
    if (count) {
        try { opening = quantity.format(quantity.parse(tail.quantity)); }
        catch { fail('The ingredient balance exceeds the supported range. Review its movements before activation.'); }
    }
    const evidence = { ingredient_id: id, name: ingredient.name, measure: ingredient.measure,
        is_active: Boolean(ingredient.is_active), quantity: opening, quantity_known: Boolean(count),
        running_delta: tail.delta === '0' ? '0.000000' : tail.delta,
        count_id: count?.id ?? null, movement_watermark: tail.watermark };
    // Rechecking only the quantity misses an intervening receipt and issue that
    // cancel each other. Bind the observed source evidence as well as the value.
    return { ...evidence, observation_token: createHash('sha256')
        .update(JSON.stringify(['ingredient_opening_v1', evidence])).digest('hex') };
}

// Read-only preflight. Activation must repeat it under its source/catalog fence
// in READ COMMITTED; this result alone does not authorize a later cutover.
async function findIngredientOpenOrder(conn, value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value))) fail('Invalid ingredient.', 400);
    const ingredientId = Number(value);
    const [[row]] = await conn.query(`SELECT o.invoice_id,o.table_id,
        CASE WHEN oi.recipe_line_key IS NOT NULL AND r.line_key IS NULL
            THEN 'invalid_open_recipe' ELSE 'open_order' END AS code
        FROM orders o JOIN order_items oi ON oi.invoice_id=o.invoice_id
        LEFT JOIN recipe_ledger_lines r ON r.line_key=oi.recipe_line_key
        WHERE o.payment_method='unpaid_table' AND oi.parent_item_id IS NULL AND (
            (oi.recipe_line_key IS NOT NULL AND (r.line_key IS NULL
                OR JSON_CONTAINS(r.ingredient_ids,?)=1 OR JSON_CONTAINS(r.ingredient_ids,?)=1))
            OR (oi.recipe_line_key IS NULL AND (
                EXISTS(SELECT 1 FROM product_recipe_lines p WHERE p.product_id=oi.product_id AND p.ingredient_id=?)
                OR (NOT EXISTS(SELECT 1 FROM product_recipe_lines own WHERE own.product_id=oi.product_id)
                    AND EXISTS(SELECT 1 FROM product_bundle_items b JOIN product_recipe_lines p ON p.product_id=b.product_id
                        WHERE b.bundle_id=oi.product_id AND p.ingredient_id=?))
            ))) ORDER BY o.invoice_id,oi.id LIMIT 1`,
        [JSON.stringify(ingredientId), JSON.stringify(String(ingredientId)), ingredientId, ingredientId]);
    return row || null;
}

async function findIngredientHeldOrder(conn, value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value))) fail('Invalid ingredient.', 400);
    const ingredientId = Number(value);
    let cursor = 0;
    // Holds often repeat the same products. Cache only verified nonmatches for
    // this scan, with bounded memory; activation repeats preflight under its fence.
    const checkedKeys = new Set(), checkedProducts = new Set();
    const remember = (cache, values) => {
        if (cache.size + values.size > 1000) cache.clear();
        for (const value of values) cache.add(value);
    };
    for (;;) {
        const [holds] = await conn.query('SELECT id,cart_data FROM held_orders WHERE id>? ORDER BY id LIMIT 25', [cursor]);
        if (!holds.length) return null;
        for (const hold of holds) {
            const invalid = {held_order_id:hold.id,code:'invalid_held_recipe'};
            let cart;
            try { cart = JSON.parse(hold.cart_data); } catch { return invalid; }
            const lines = Array.isArray(cart) ? cart : cart?.items;
            if (!Array.isArray(lines)) return invalid;
            // Bound lookup parameters and deduplicate repeated meal lines. Frozen
            // evidence takes precedence, including explicitly empty recipes.
            for (let offset = 0; offset < lines.length; offset += 100) {
                const batch = lines.slice(offset, offset + 100);
                const keys = new Set(), products = new Set();
                for (const line of batch) {
                    if (!line || typeof line !== 'object' || Array.isArray(line)) return invalid;
                    if (line.recipe_line_key != null) {
                        if (typeof line.recipe_line_key !== 'string' || !/^[a-f0-9]{32}$/.test(line.recipe_line_key)) return invalid;
                        if (!checkedKeys.has(line.recipe_line_key)) keys.add(line.recipe_line_key);
                    } else {
                        const product = line.product_id ?? line.id;
                        if (!['string','number'].includes(typeof product) || !/^[1-9]\d{0,9}$/.test(String(product))) return invalid;
                        if (!checkedProducts.has(Number(product))) products.add(Number(product));
                    }
                }
                if (keys.size) {
                    const [saved] = await conn.query('SELECT line_key,ingredient_ids FROM recipe_ledger_lines WHERE line_key IN (?)', [[...keys]]);
                    if (saved.length !== keys.size) return invalid;
                    for (const row of saved) {
                        let ids;
                        try { ids = typeof row.ingredient_ids === 'string' ? JSON.parse(row.ingredient_ids) : row.ingredient_ids; }
                        catch { return invalid; }
                        if (!Array.isArray(ids)) return invalid;
                        if (ids.some(id => String(id) === String(ingredientId))) return {held_order_id:hold.id,code:'held_order'};
                    }
                    remember(checkedKeys, keys);
                }
                if (products.size) {
                    const ids = [...products];
                    const [matches] = await conn.query(`SELECT product_id FROM product_recipe_lines
                        WHERE product_id IN (?) AND ingredient_id=?
                        UNION ALL SELECT b.bundle_id AS product_id FROM product_bundle_items b
                        JOIN product_recipe_lines p ON p.product_id=b.product_id
                        WHERE b.bundle_id IN (?) AND p.ingredient_id=?
                        AND NOT EXISTS(SELECT 1 FROM product_recipe_lines own WHERE own.product_id=b.bundle_id)
                        LIMIT 1`, [ids, ingredientId, ids, ingredientId]);
                    if (matches.length) return {held_order_id:hold.id,code:'held_order'};
                    remember(checkedProducts, products);
                }
            }
            cursor = hold.id;
        }
    }
}

const INGREDIENT_BLOCKERS = {
    stock_disabled: 'Enable stock tracking before recording stock movements.',
    inactive: 'Activate this ingredient before enabling its stock record.',
    existing_identity: 'This ingredient already has a stock identity. Restore its existing link before continuing.',
    open_order: 'Settle or clear open table orders using this ingredient first.',
    invalid_open_recipe: 'A table order has an unreadable recipe record. Review it before activating stock.',
    held_order: 'Complete or remove held and split orders using this ingredient first.',
    invalid_held_recipe: 'A held order cannot be read safely. Review it before activating stock.'
};

function ingredientId(value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
        fail('Invalid ingredient.', 400);
    }
    return Number(value);
}

function measurePair(measure) {
    if (measure === 'weight') return ['weight', 'g'];
    if (measure === 'volume') return ['volume', 'ml'];
    if (measure === 'count') return ['count', 'unit'];
    fail('This ingredient measure cannot be activated.', 400);
}

async function inspectIngredient(conn, value, locked) {
    const id = ingredientId(value);
    const ingredient = locked?.ingredient;
    const [[row]] = ingredient ? [[ingredient]] : await conn.query(
        'SELECT id,name,measure,is_active FROM ingredients WHERE id=?', [id]);
    if (!row) fail('Ingredient not found.', 404);
    const [[link]] = await conn.query(`SELECT CAST(l.stock_item_id AS CHAR) AS stock_item_id,s.availability_policy
        FROM ingredients l JOIN stock_items s ON s.id=l.stock_item_id WHERE l.id=?`, [id]);
    const opening = locked?.opening || await readIngredientOpening(conn, id, { lock: Boolean(locked) });
    const state = {
        ingredient_id: id, name: row.name, measure: row.measure,
        quantity: opening.quantity, quantity_known: opening.quantity_known,
        running_delta: opening.running_delta, observation_token: opening.observation_token,
        movement_watermark: opening.movement_watermark, count_id: opening.count_id,
        availability_policy: link?.availability_policy ?? 'estimate',
        stock_item_id: link?.stock_item_id ?? null, blockers: []
    };
    if (link) {
        const [[balance]] = await conn.query(`SELECT CAST(b.quantity AS CHAR) AS quantity,b.quantity_known
            FROM stock_balances b WHERE b.stock_item_id=?`, [link.stock_item_id]);
        return { ...state, active: true, can_activate: false,
            quantity: balance?.quantity_known ? balance.quantity : null,
            quantity_known: Boolean(balance?.quantity_known) };
    }
    const add = (code, reference) => state.blockers.push({
        code, message: INGREDIENT_BLOCKERS[code], ...(reference ? { reference } : {})
    });
    const [[setting]] = await conn.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled'");
    if (setting?.setting_value !== '1') add('stock_disabled');
    if (Number(row.is_active) !== 1) add('inactive');
    const [[identity]] = await conn.query('SELECT id FROM stock_items WHERE legacy_ingredient_id=?', [id]);
    if (identity) add('existing_identity');
    const open = await findIngredientOpenOrder(conn, id);
    if (open) add(open.code, { invoice_id: open.invoice_id, table_id: open.table_id });
    const held = await findIngredientHeldOrder(conn, id);
    if (held) add(held.code, { held_order_id: held.held_order_id });
    return { ...state, active: false, can_activate: state.blockers.length === 0 };
}

// Caller uses a READ COMMITTED transaction. The ingredient lock serializes
// mapping changes; open/held checks then see orders committed while waiting
// without reversing checkout source-order/ingredient lock order.
async function activateIngredient(conn, value, input, actorId, ipAddress) {
    const id = ingredientId(value);
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['observation_token', 'request_key', 'availability_policy'].includes(key))) {
        fail('Invalid activation request.', 400);
    }
    const token = String(input.observation_token ?? '');
    if (!/^[a-f0-9]{64}$/.test(token)) fail('Reload the ingredient before enabling stock movements.');
    if (typeof input.request_key !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(input.request_key)) fail('Invalid request key.', 400);
    const policy = input.availability_policy == null ? 'estimate' : String(input.availability_policy);
    if (!['estimate', 'strict'].includes(policy)) fail('Invalid availability policy.', 400);
    const hash = createHash('sha256').update(JSON.stringify(['activate_ingredient', id, token, policy, actorId])).digest('hex');
    await conn.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled' FOR UPDATE");
    const opening = await readIngredientOpening(conn, id);
    const [[previous]] = await conn.query('SELECT result_json FROM stock_operations WHERE request_key=?', [input.request_key]);
    if (previous) {
        const saved = typeof previous.result_json === 'string' ? JSON.parse(previous.result_json) : previous.result_json;
        if (saved?.activation?.payload_hash !== hash || !saved.activation.result) fail('This request key belongs to a different stock operation.');
        return { ...saved.activation.result, replayed: true };
    }
    if (opening.observation_token !== token) fail('Stock changed. Reload the ingredient before enabling stock movements.');
    if (policy === 'strict' && opening.quantity_known && quantity.parse(opening.quantity) < 0n) {
        fail('Count this ingredient before enabling strict stock movements.');
    }
    const state = await inspectIngredient(conn, id, {
        ingredient: { id, name: opening.name, measure: opening.measure, is_active: opening.is_active ? 1 : 0 },
        opening
    });
    if (state.active) fail('Stock movements are already enabled for this ingredient.');
    if (!state.can_activate) fail(state.blockers[0].message);
    const [measure, baseUnit] = measurePair(opening.measure);
    const [item] = await conn.query(
        'INSERT INTO stock_items(name,measure,base_unit,legacy_ingredient_id,tracking_state,availability_policy) VALUES (?,?,?,?,\'active\',?)',
        [[...opening.name].slice(0, 100).join(''), measure, baseUnit, id, policy]);
    const businessDate = getBusinessDate();
    let posted;
    if (opening.quantity_known) {
        posted = await ledger.post(conn, { kind: 'opening', request_key: input.request_key, business_date: businessDate,
            lines: [{ stock_item_id: String(item.insertId),
                quantity: opening.quantity, expected_version: '0', source_line: `activation:ingredient:${id}` }] }, actorId);
    } else {
        const [operation] = await conn.query("INSERT INTO stock_operations(request_key,payload_hash,kind,actor_id,business_date) VALUES (?,?,'activation',?,?)",
            [input.request_key, hash, actorId, businessDate]);
        await conn.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known,version,last_operation_id) VALUES (?,0,0,0,?)',
            [item.insertId, operation.insertId]);
        posted = { operation_id: operation.insertId, lines: [] };
        await invalidation.operations(conn, businessDate, [posted.operation_id]);
    }
    await conn.query(`UPDATE ingredients SET stock_item_id=?,stock_activation_operation_id=?,stock_movement_watermark=?,stock_activation_count_id=?,stock_observation_token=?,stock_activation_quantity=?,stock_activation_quantity_known=?,stock_activation_request_key=?,stock_activated_at=CURRENT_TIMESTAMP(6),updated_at=updated_at WHERE id=?`,
        [item.insertId, posted.operation_id, opening.movement_watermark, opening.count_id,
            opening.observation_token, opening.quantity, opening.quantity_known ? 1 : 0, input.request_key, id]);
    await conn.query('INSERT INTO stock_operation_sources(operation_id,line_ordinal,source_kind,source_line,ingredient_id) VALUES (?,?,?,?,?)',
        [posted.operation_id, 0, 'ingredient_cutover', `activation:ingredient:${id}`, id]);
    const result = { operation_id: posted.operation_id, ingredient_id: id, stock_item_id: String(item.insertId),
        quantity: opening.quantity, quantity_known: opening.quantity_known, availability_policy: policy,
        movement_watermark: opening.movement_watermark, observation_token: opening.observation_token, active: true };
    await conn.query('UPDATE stock_operations SET result_json=? WHERE id=?',
        [JSON.stringify({ ...posted, activation: { payload_hash: hash, result } }), posted.operation_id]);
    await appendAuditEvent(conn, { eventType: 'stock_authority_activated', userId: actorId, entityType: 'ingredient', entityId: id,
        oldValue: { quantity: opening.quantity, movement_watermark: opening.movement_watermark }, newValue: result, ipAddress });
    return result;
}

module.exports = { inspect, activate, inspectIngredient, activateIngredient, readIngredientOpening, findIngredientOpenOrder, findIngredientHeldOrder };
