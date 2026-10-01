const { getConnection: getStockConnection } = require('../../services/StockReportInvalidation');
const express = require('express');
const router = express.Router();
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { getBusinessDate } = require('../../utils/businessDate');
const { appendAuditEvent } = require('../../services/auditEvents');
const L = require('../../services/RecipeLedgerService');
const cache = require('../../config/cache');
const { announceStockChanged } = require('../../services/StockEventScope');

function sendError(res, error) {
    const status = error.statusCode
        || (error.code === 'ER_DUP_ENTRY' ? 409 : error instanceof TypeError ? 400 : 500);
    if (status === 500) logger.error({ err: error }, 'Admin recipe ledger operation failed.');
    const duplicateName = error.code === 'ER_DUP_ENTRY'
        ? 'An ingredient with this name already exists.'
        : null;
    const payload = {
        success: false,
        message: duplicateName || (status === 500 ? 'Recipe ledger operation failed.' : error.message),
    };
    if (error.dependents) payload.dependents = error.dependents;
    return res.status(status).json(payload);
}

function fail(statusCode, message, extra) {
    throw Object.assign(new Error(message), { statusCode, ...extra });
}

function positiveId(value, label = 'id') {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) fail(400, `${label} is invalid.`);
    return id;
}

function actorOf(req) {
    return { id: req.user.id, name: req.user.name };
}

function hasOwn(body, key) {
    return Object.prototype.hasOwnProperty.call(body || {}, key);
}

function requireName(value) {
    const name = String(value || '').trim();
    if (name.length < 1 || name.length > 100) fail(400, 'Name must be 1–100 characters.');
    return name;
}

function requireMeasure(value) {
    if (!['weight', 'volume', 'count'].includes(value)) fail(400, 'Measure is invalid.');
    return value;
}

function requireDisplayUnit(measure, unit) {
    if (!L.unitBelongsTo(measure, unit)) fail(400, 'Display unit does not match this measure.');
    return unit;
}

function optionalBaseQty(value, unit, label) {
    if (value == null || value === '') return null;
    if (!unit) fail(400, `${label} unit is required.`);
    const qty = L.toBaseQty(value, unit);
    if (qty < 0) fail(400, `${label} cannot be negative.`);
    return qty;
}

function optionalBaseCost(value, unit) {
    if (value == null || value === '') return null;
    const cost = L.toBaseCost(value, unit);
    if (cost < 0) fail(400, 'Cost cannot be negative.');
    return cost;
}

function parsePack(name, size, unit) {
    const packName = name == null || name === '' ? null : String(name).trim();
    const hasSize = size != null && size !== '';
    if (!packName && !hasSize) return { pack_name: null, pack_size: null };
    if (!packName || !hasSize) fail(400, 'Pack name and size are required together.');
    const packSize = L.toBaseQty(size, unit);
    if (!(packSize > 0)) fail(400, 'Pack size must be greater than zero.');
    return { pack_name: packName, pack_size: packSize };
}

function shapeIngredient(row) {
    return {
        id: Number(row.id),
        name: row.name,
        measure: row.measure,
        display_unit: row.display_unit,
        unit_cost: row.unit_cost == null ? null : Number(row.unit_cost),
        par_qty: row.par_qty == null ? null : Number(row.par_qty),
        pack_name: row.pack_name,
        pack_size: row.pack_size == null ? null : Number(row.pack_size),
        is_active: Number(row.is_active) === 1,
    };
}

async function loadIngredientRow(conn, id) {
    const [[row]] = await conn.query('SELECT * FROM ingredients WHERE id=? FOR UPDATE', [id]);
    if (!row) fail(404, 'Ingredient not found.');
    return row;
}

async function emitChanged(req, ingredientIds) {
    const ids = [...new Set((ingredientIds || []).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) return;
    req.io?.to('staff').emit('ingredients_changed', { ingredientIds: ids });
    // Ingredient balances move the availability of the products linked to them, so
    // the catalog cache is dropped and tills learn which products to re-read.
    cache.invalidateCatalogCache();
    if (req.io) announceStockChanged(req.io, { ingredientIds: ids, logContext: { route: req.originalUrl, method: req.method } });
}

async function withWriteTx(req, res, work) {
    const conn = await getStockConnection(pool);
    try {
        // Current Count reads can meet an InnoDB gap-lock deadlock when two
        // previously uncounted ingredients get their first Count concurrently.
        // Retry the entire transaction; audit and events must never escape it.
        for (let attempt = 0; attempt < 3; attempt++) {
            let result;
            try {
                await conn.beginTransaction();
                result = await work(conn);
                await conn.commit();
            } catch (error) {
                await conn.rollback();
                if (error.code === 'ER_LOCK_DEADLOCK' && attempt < 2) continue;
                return sendError(res, error);
            }
            if (result.emitIds && !result.replay) await emitChanged(req, result.emitIds);
            return res.json({ success: true, ...result.body });
        }
    } finally {
        conn.release();
    }
}

router.get('/ingredients/portions', async (req, res) => {
    try {
        const productId = req.query.product_id == null ? undefined : positiveId(req.query.product_id, 'product_id');
        return res.json({ success: true, portions: await L.getPortionsReport(pool, { productId }) });
    } catch (error) {
        return sendError(res, error);
    }
});

router.get('/ingredients/options', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM ingredients WHERE is_active=1 ORDER BY name,id');
        return res.json({ success: true, ingredients: rows.map(shapeIngredient) });
    } catch (error) { return sendError(res, error); }
});

router.get('/ingredients', async (req, res) => {
    try {
        const page = await L.listIngredientPage(pool, {
            view:req.query.view,
            businessDate: getBusinessDate(),
            includeInactive: req.query.include_inactive === '1',
            q: req.query.q,
            cursor: req.query.cursor,
            limit: req.query.limit,
            status: req.query.status,
            measure:req.query.measure,attention:req.query.attention,sort:req.query.sort,
        });
        return res.json({ success: true, ingredients: page.items, next_cursor: page.next_cursor, has_more: page.has_more, limit: page.limit, freshness:page.freshness,daily_freshness:page.daily_freshness });
    } catch (error) {
        return sendError(res, error);
    }
});

router.post('/ingredients', async (req, res) => {
    return withWriteTx(req, res, async (conn) => {
        const name = requireName(req.body.name);
        const measure = requireMeasure(req.body.measure);
        const displayUnit = requireDisplayUnit(measure, req.body.display_unit);
        const unit = requireDisplayUnit(measure, req.body.cost_unit || displayUnit);
        const parUnit = requireDisplayUnit(measure, req.body.par_unit || displayUnit);
        const packUnit = requireDisplayUnit(measure, req.body.pack_unit || displayUnit);
        const pack = parsePack(req.body.pack_name, req.body.pack_size, packUnit);
        const [insert] = await conn.query(
            `INSERT INTO ingredients
              (name, measure, display_unit, unit_cost, par_qty, pack_name, pack_size, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
            [
                name,
                measure,
                displayUnit,
                optionalBaseCost(req.body.unit_cost, unit),
                optionalBaseQty(req.body.par_qty, parUnit, 'Par'),
                pack.pack_name,
                pack.pack_size,
            ]
        );
        const [[row]] = await conn.query('SELECT * FROM ingredients WHERE id=?', [insert.insertId]);
        await appendAuditEvent(conn, {
            eventType: 'ingredient_created',
            userId: req.user.id,
            entityType: 'ingredient',
            entityId: insert.insertId,
            newValue: { name, measure, display_unit: displayUnit },
            ipAddress: req.ip || null,
        });
        return { emitIds: [insert.insertId], body: { ingredient: shapeIngredient(row) } };
    });
});

router.get('/ingredients/:id/movements', async (req, res) => {
    try {
        const result = await L.listMovements(pool, {
            ingredientId: positiveId(req.params.id, 'ingredient'),
            from: req.query.from,
            to: req.query.to,
            beforeId: req.query.before_id ? positiveId(req.query.before_id, 'before_id') : null,
            limit: req.query.limit,
        });
        return res.json({ success: true, rows: result.rows });
    } catch (error) {
        return sendError(res, error);
    }
});

router.post('/ingredients/:id/movements', async (req, res) => {
    return withWriteTx(req, res, async (conn) => {
        const ingredientId = positiveId(req.params.id, 'ingredient');
        const result = await L.recordManualMovement(conn, {
            ingredientId,
            kind: req.body.kind,
            qty: req.body.qty,
            unit: req.body.unit,
            packs: req.body.packs,
            reason: req.body.reason,
            unitCost: req.body.unit_cost,
            costUnit: req.body.cost_unit,
            note: req.body.note,
            clientKey: req.body.client_key,
            actor: actorOf(req),
            businessDate: getBusinessDate(),
        });
        await appendAuditEvent(conn, {
            eventType: 'ingredient_movement',
            userId: req.user.id,
            entityType: 'ingredient',
            entityId: ingredientId,
            newValue: { kind: req.body.kind, client_key: req.body.client_key, replay: result.replay },
            ipAddress: req.ip || null,
        });
        return {
            replay: result.replay,
            emitIds: [ingredientId],
            body: { movement: result.movement, replay: result.replay },
        };
    });
});

router.put('/ingredients/:id', async (req, res) => {
    return withWriteTx(req, res, async (conn) => {
        const id = positiveId(req.params.id, 'ingredient');
        const current = await loadIngredientRow(conn, id);
        const name = requireName(hasOwn(req.body, 'name') ? req.body.name : current.name);
        const displayUnit = requireDisplayUnit(
            current.measure,
            hasOwn(req.body, 'display_unit') ? req.body.display_unit : current.display_unit
        );
        const nextActive = hasOwn(req.body, 'is_active')
            ? ([false, 0, '0'].includes(req.body.is_active) ? 0 : 1)
            : Number(current.is_active);
        if (nextActive === 0 && Number(current.is_active) === 1) {
            const [dependents] = await conn.query(
                `SELECT p.id AS product_id, p.name
                   FROM product_recipe_lines prl
                   JOIN products p ON p.id = prl.product_id
                  WHERE prl.ingredient_id=? AND p.is_active=1
                  ORDER BY p.id`,
                [id]
            );
            if (dependents.length) {
                fail(409, 'This ingredient is used by active product recipes.', {
                    dependents: dependents.map((row) => ({ product_id: Number(row.product_id), name: row.name })),
                });
            }
        }
        const costUnit = requireDisplayUnit(current.measure, req.body.cost_unit || displayUnit);
        const parUnit = requireDisplayUnit(current.measure, req.body.par_unit || displayUnit);
        const packUnit = requireDisplayUnit(current.measure, req.body.pack_unit || displayUnit);
        const unitCost = hasOwn(req.body, 'unit_cost')
            ? optionalBaseCost(req.body.unit_cost, costUnit)
            : current.unit_cost;
        const parQty = hasOwn(req.body, 'par_qty')
            ? optionalBaseQty(req.body.par_qty, parUnit, 'Par')
            : current.par_qty;
        const pack = (hasOwn(req.body, 'pack_name') || hasOwn(req.body, 'pack_size'))
            ? parsePack(
                hasOwn(req.body, 'pack_name') ? req.body.pack_name : current.pack_name,
                hasOwn(req.body, 'pack_size') ? req.body.pack_size
                    : (current.pack_size == null ? null : L.fromBaseQty(current.pack_size, packUnit)),
                packUnit
            )
            : { pack_name: current.pack_name, pack_size: current.pack_size };
        await conn.query(
            `UPDATE ingredients
                SET name=?, display_unit=?, unit_cost=?, par_qty=?, pack_name=?, pack_size=?, is_active=?
              WHERE id=?`,
            [name, displayUnit, unitCost, parQty, pack.pack_name, pack.pack_size, nextActive, id]
        );
        const [identities]=await conn.query('SELECT id FROM stock_items WHERE legacy_ingredient_id=? ORDER BY id FOR UPDATE',[id]);
        await conn.query('UPDATE stock_items SET name=?,is_active=? WHERE legacy_ingredient_id=?',[name,nextActive,id]);
        await require('../../services/StockLedgerService').refreshAttention(conn,identities.map(row=>row.id));
        const [[row]] = await conn.query('SELECT * FROM ingredients WHERE id=?', [id]);
        await appendAuditEvent(conn, {
            eventType: 'ingredient_updated',
            userId: req.user.id,
            entityType: 'ingredient',
            entityId: id,
            oldValue: { name: current.name, display_unit: current.display_unit, is_active: Number(current.is_active) },
            newValue: { name, display_unit: displayUnit, is_active: nextActive },
            ipAddress: req.ip || null,
        });
        return { emitIds: [id], body: { ingredient: shapeIngredient(row) } };
    });
});

router.post('/ingredient-movements/:id/amend', async (req, res) => {
    return withWriteTx(req, res, async conn => {
        const movementId = positiveId(req.params.id, 'movement');
        const result = await L.amendManualMovement(conn, {
            movementId, qty: req.body.qty, unit: req.body.unit, note: req.body.note,
            clientKey: req.body.client_key, actor: actorOf(req), businessDate: getBusinessDate(),
        });
        if (!result.replay) await appendAuditEvent(conn, {
            eventType: 'ingredient_corrected', userId: req.user.id, entityType: 'ingredient_movement', entityId: movementId,
            newValue: { qty: req.body.qty, unit: req.body.unit, note: req.body.note, client_key: req.body.client_key }, ipAddress: req.ip || null,
        });
        return { replay: result.replay, emitIds: [Number(result.movement.ingredient_id)], body: result };
    });
});

router.get('/ingredients/analysis', async (req,res) => {
    let conn;
    try {
        conn=await getStockConnection(pool);
        await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await conn.query('START TRANSACTION READ ONLY');
        const report=await require('../../services/StockReportReadService').getPublishedAnalysis(conn,{startDate:req.query.from,endDate:req.query.to,
            productId:req.query.product_id ? positiveId(req.query.product_id,'product') : undefined,
            eventCursor:req.query.event_cursor,partsCursor:req.query.parts_cursor,
            ingredientId:req.query.ingredient_id ? positiveId(req.query.ingredient_id,'ingredient') : undefined,
            view:req.query.view,cursor:req.query.cursor,q:req.query.q});
        await conn.commit();
        return res.json({success:true,...report});
    } catch(error) {
        if(conn) await conn.rollback().catch(rollbackError=>logger.warn({err:rollbackError},'Ingredient analysis rollback failed.'));
        return sendError(res,error);
    }
    finally { conn?.release(); }
});

router.get('/products/:id/recipe', async (req, res) => {
    try {
        const productId = positiveId(req.params.id, 'product');
        const [[product]] = await pool.query('SELECT id, price FROM products WHERE id=?', [productId]);
        if (!product) fail(404, 'Product not found.');
        const [rows] = await pool.query(
            `SELECT prl.ingredient_id, prl.qty_per_unit, prl.yield_pct, prl.sort_order,
                    i.name, i.display_unit, i.unit_cost, i.is_active, i.measure
               FROM product_recipe_lines prl
               JOIN ingredients i ON i.id = prl.ingredient_id
              WHERE prl.product_id=?
              ORDER BY prl.sort_order, prl.id`,
            [productId]
        );
        const costs = await L.resolveIngredientCosts(pool, rows.map(row => ({id:row.ingredient_id,unit_cost:row.unit_cost})));
        const lines = rows.map((row) => ({
            ingredient_id: Number(row.ingredient_id),
            name: row.name,
            qty: L.fromBaseQty(Number(row.qty_per_unit) * Number(row.yield_pct) / 100, row.display_unit),
            stock_qty: L.fromBaseQty(row.qty_per_unit, row.display_unit),
            yield_pct: Number(row.yield_pct),
            unit: row.display_unit,
            qty_per_unit: Number(row.qty_per_unit),
            unit_cost: costs.get(Number(row.ingredient_id)).unit_cost,
            cost_source: costs.get(Number(row.ingredient_id)).cost_source,
            is_active: Number(row.is_active) === 1,
            measure: row.measure,
        }));
        const costed = lines.filter((line) => line.unit_cost != null);
        const plate_cost = costed.reduce(
            (sum, line) => L.roundEight(sum + line.qty_per_unit * line.unit_cost),
            0
        );
        const price = Number(product.price) || 0;
        const allCosted = lines.length > 0 && costed.length === lines.length;
        return res.json({
            success: true,
            lines,
            price,
            plate_cost: costed.length ? plate_cost : null,
            margin_pct: allCosted && price > 0 ? L.roundEight((price - plate_cost) / price) : null,
        });
    } catch (error) {
        return sendError(res, error);
    }
});

router.put('/products/:id/recipe', async (req, res) => {
    return withWriteTx(req, res, async (conn) => {
        // Clearing an overriding bundle recipe can expose member ingredients.
        // Serialize catalog changes with ingredient activation before product locks.
        await conn.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled' LOCK IN SHARE MODE");
        const productId = positiveId(req.params.id, 'product');
        const [[product]] = await conn.query('SELECT id FROM products WHERE id=? FOR UPDATE', [productId]);
        if (!product) fail(404, 'Product not found.');
        const incoming = Array.isArray(req.body.lines) ? req.body.lines : fail(400, 'lines is required.');
        if (incoming.length) {
            const [[stockLink]] = await conn.query('SELECT stock_item_id FROM product_stock_links WHERE product_id=? FOR UPDATE', [productId]);
            if (stockLink) fail(409, 'A product cannot consume both packaged stock and a recipe. Change its stock policy first.');
        }
        if (incoming.length > 100) fail(400, 'A recipe can have at most 100 ingredients.');
        const ids = incoming.map((line) => Number(line.ingredient_id));
        if (ids.some((id) => !Number.isInteger(id) || id <= 0)) fail(400, 'ingredient_id is invalid.');
        if (new Set(ids).size !== ids.length) fail(400, 'Recipe ingredients must be unique.');
        const normalized = [];
        for (const [index, line] of incoming.entries()) {
            const ingredient = await loadIngredientRow(conn, Number(line.ingredient_id));
            if (Number(ingredient.is_active) !== 1) fail(400, 'Ingredient is inactive.');
            if (!L.unitBelongsTo(ingredient.measure, line.unit)) fail(400, 'Unit does not match this ingredient.');
            const qty = L.toBaseQty(line.qty, line.unit);
            if (!(qty > 0)) fail(400, 'Recipe quantity must be greater than zero.');
            const yieldPct = Math.round(Number(line.yield_pct ?? 100) * 10000) / 10000;
            if (!Number.isFinite(yieldPct) || yieldPct <= 0 || yieldPct > 1000) fail(400, 'Preparation yield must be greater than zero and at most 1000%.');
            const stockQty=L.roundSix(qty * 100 / yieldPct);
            if (!(stockQty>0)) fail(400,'Recipe quantity must be greater than zero.');
            normalized.push({
                ingredient_id: Number(ingredient.id),
                qty_per_unit: stockQty,
                yield_pct: yieldPct,
                sort_order: index,
            });
        }
        const [previous] = await conn.query(
            'SELECT ingredient_id FROM product_recipe_lines WHERE product_id=?',
            [productId]
        );
        await conn.query('DELETE FROM product_recipe_lines WHERE product_id=?', [productId]);
        if (normalized.length) {
            await conn.query(
                'INSERT INTO product_recipe_lines (product_id, ingredient_id, qty_per_unit, yield_pct, sort_order) VALUES ?',
                [normalized.map((line) => [productId, line.ingredient_id, line.qty_per_unit, line.yield_pct, line.sort_order])]
            );
        }
        await appendAuditEvent(conn, {
            eventType: 'product_recipe_changed',
            userId: req.user.id,
            entityType: 'product',
            entityId: productId,
            newValue: { lines: normalized.length },
            ipAddress: req.ip || null,
        });
        return {
            emitIds: [...previous.map((row) => Number(row.ingredient_id)), ...normalized.map((line) => line.ingredient_id)],
            body: { lines: normalized.length },
        };
    });
});

module.exports = router;
