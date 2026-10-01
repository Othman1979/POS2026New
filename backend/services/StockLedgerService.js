'use strict';

const { createHash, randomUUID } = require('node:crypto');
const quantity = require('./stockQuantity');
const invalidation = require('./StockReportInvalidation');

function fail(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }
function id(value) {
    if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isSafeInteger(value))) fail('Invalid stock reference.');
    const text = String(value ?? '');
    if (!/^[1-9]\d{0,18}$/.test(text)) fail('Invalid stock reference.');
    return text;
}
function normalize(input, actorId) {
    if (!input || !Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100) fail('A stock operation requires 1 to 100 lines.');
    if (!['opening', 'receipt', 'count', 'issue', 'return', 'waste', 'correction'].includes(input.kind)) fail('Invalid stock operation kind.');
    if (typeof input.request_key !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(input.request_key)) fail('Invalid request key.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.business_date || '') ||
        !Number.isFinite(Date.parse(input.business_date)) || new Date(input.business_date).toISOString().slice(0, 10) !== input.business_date) fail('Invalid business date.');
    const keys = new Set();
    const lines = input.lines.map(line => {
        if (!line || typeof line !== 'object' || Array.isArray(line)) fail('Invalid stock line.');
        const key = [id(line.stock_item_id)];
        // Old internal intents retain their original hash for replay. New
        // operations identify stock by item only; legacy IDs are provenance.
        if (line.location_id != null || line.lot_id != null) key.push(id(line.location_id), id(line.lot_id));
        if (keys.has(key[0])) fail('Combine repeated stock items before posting.');
        keys.add(key[0]);
        let amount;
        try { amount = quantity.format(quantity.parse(line.quantity)); }
        catch (error) { fail(error.message); }
        const isCount = input.kind === 'count' || input.kind === 'opening';
        if (input.kind === 'count' && quantity.parse(amount) < 0n) fail('A physical count cannot be negative.');
        if (['receipt', 'return'].includes(input.kind) && quantity.parse(amount) <= 0n) fail('Received quantity must be positive.');
        if (['issue', 'waste'].includes(input.kind) && quantity.parse(amount) >= 0n) fail('Issued quantity must be negative.');
        const version = isCount ? String(line.expected_version ?? '') : null;
        if (isCount && !/^\d{1,20}$/.test(version)) fail('An observed stock version is required.', 409);
        if (line.source_line != null && (typeof line.source_line !== 'string' || line.source_line.length > 100)) fail('Invalid source line.');
        return { key, quantity: amount, expected_version: version, source_line: line.source_line ?? null };
    });
    if (input.kind === 'correction' && input.original_operation_id == null) fail('A correction requires its original operation.');
    const intent = { kind: input.kind, business_date: input.business_date, actor_id: actorId == null ? null : id(actorId),
        original_operation_id: input.original_operation_id == null ? null : id(input.original_operation_id), lines };
    return { ...intent, request_key: input.request_key,
        hash: createHash('sha256').update(JSON.stringify(intent)).digest('hex') };
}
function replay(row, intent) {
    if (row.payload_hash !== intent.hash) fail('This request key belongs to a different stock operation.', 409);
    if (!row.result_json) fail('The stock operation has no completed result.', 409);
    return { ...(typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json), replayed: true };
}
function compareKey(a, b) {
    for (let index = 0; index < a.length; index++) {
        const left = BigInt(a[index]); const right = BigInt(b[index]);
        if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
}

// Internal posting primitive. The caller authorizes the specific document/action
// and owns its transaction (including rollback and whole-transaction deadlock retry).
// Do not expose arbitrary signed movements as a public endpoint.
async function postMovement(conn, input, actorId, ingredientSources) {
    const intent = normalize(input, actorId);
    const [[previous]] = await conn.query('SELECT payload_hash,result_json FROM stock_operations WHERE request_key=?', [intent.request_key]);
    if (previous) return replay(previous, intent);
    const itemIds = [...new Set(intent.lines.map(line => line.key[0]))].sort((a, b) => compareKey([a], [b]));
    const items = new Map();
    // Identity before balances. No operation/dirty/report lock is held here.
    const [itemRows] = await conn.query('SELECT CAST(id AS CHAR) AS id,base_unit,tracking_state,is_active,availability_policy FROM stock_items WHERE id IN (?) ORDER BY stock_items.id FOR UPDATE', [itemIds]);
    for (const item of itemRows) {
        if ((!item.is_active && intent.kind !== 'return') || item.tracking_state !== 'active') fail('Stock item is not active.', 409);
        items.set(item.id, item);
    }
    if (items.size !== itemIds.length) fail('Stock item is not active.', 409);
    const ordered = [...intent.lines].sort((a, b) => compareKey(a.key, b.key));
    // A new balance is unknown until counted.
    await conn.query('INSERT IGNORE INTO stock_balances(stock_item_id,quantity_known) VALUES ?',
        [ordered.map(line => [line.key[0], 0])]);
    const [balanceRows] = await conn.query('SELECT CAST(stock_item_id AS CHAR) AS stock_item_id,CAST(location_id AS CHAR) AS location_id,CAST(lot_id AS CHAR) AS lot_id,CAST(quantity AS CHAR) AS quantity,quantity_known,CAST(version AS CHAR) AS version FROM stock_balances WHERE stock_item_id IN (?) ORDER BY stock_item_id FOR UPDATE', [itemIds]);
    const balances = new Map(balanceRows.map(balance => [balance.stock_item_id, balance]));
    for (const line of ordered) {
        const saved = balances.get(line.key[0]);
        if (line.key.length === 3 && (saved.location_id !== line.key[1] || saved.lot_id !== line.key[2])) {
            fail('The original stock identity does not match this item.', 409);
        }
    }
    // Claim the unique key after stock locks. Looking up a missing random key
    // FOR UPDATE takes a range gap lock and can block unrelated stock writers.
    // INSERT waits for an in-flight owner; only a duplicate needs a current read.
    // Replay still precedes stale-count validation, including after lock waits.
    let operation;
    try {
        [operation] = await conn.query(
            'INSERT INTO stock_operations(request_key,payload_hash,kind,actor_id,business_date,original_operation_id) VALUES (?,?,?,?,?,?)',
            [intent.request_key, intent.hash, intent.kind, intent.actor_id, intent.business_date, intent.original_operation_id]);
    } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        const [[completed]] = await conn.query('SELECT payload_hash,result_json FROM stock_operations WHERE request_key=? FOR UPDATE', [intent.request_key]);
        if (!completed) throw error;
        return replay(completed, intent);
    }
    if (intent.original_operation_id != null) {
        const [[original]] = await conn.query('SELECT id FROM stock_operations WHERE id=?', [intent.original_operation_id]);
        if (!original) fail('Original stock operation was not found.', 404);
    }
    const changes = [];
    for (const line of ordered) {
        const balance = balances.get(line.key[0]);
        const counted = intent.kind === 'count' || intent.kind === 'opening';
        if (counted && balance.version !== line.expected_version) fail('Stock changed after observation. Review this count.', 409);
        if (intent.kind === 'opening' && (balance.quantity_known || balance.version !== '0')) fail('Opening stock has already been recorded. Use a count.', 409);
        const before = quantity.parse(balance.quantity);
        const supplied = quantity.parse(line.quantity);
        const estimate = items.get(line.key[0]).availability_policy === 'estimate';
        if (intent.kind === 'opening' && supplied < 0n && !estimate) fail('Strict stock cannot open with a negative quantity.');
        const delta = counted ? supplied - before : supplied;
        if (delta < 0n && !counted) {
            // Recipe usage remains recordable without an opening count. The
            // resulting running delta is still unknown, not available stock.
            if (!balance.quantity_known && !estimate) fail('Count this stock before issuing it.', 409);
            if (before + delta < 0n && !estimate) fail('Insufficient stock.', 409);
        }
        let after; let signed;
        try { after = quantity.format(before + delta); signed = quantity.format(delta); }
        catch (error) { fail(error.message); }
        changes.push({ line, after, signed, known: counted || Boolean(balance.quantity_known), version: String(BigInt(balance.version) + 1n) });
    }
    await conn.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known,version,last_operation_id) VALUES ? ON DUPLICATE KEY UPDATE quantity=VALUES(quantity),quantity_known=VALUES(quantity_known),version=stock_balances.version+1,last_operation_id=VALUES(last_operation_id)',
        [changes.map(change => [change.line.key[0], change.after, change.known ? 1 : 0, change.version, operation.insertId])]);
    if (ingredientSources) {
        // Prepare each source's physical fields. appendIngredientRows performs
        // the only movement INSERT after all groups have validated their balances.
        const byItem = new Map(changes.map(change => [change.line.key[0], change]));
        for (const [index, source] of ingredientSources.entries()) Object.assign(source.row, {
            operation_id:operation.insertId, line_ordinal:index, stock_item_id:source.stock_item_id,
            quantity:intent.kind === 'count' ? byItem.get(source.stock_item_id).signed : source.quantity,
            unit_snapshot:items.get(source.stock_item_id).base_unit, source_line:source.source_line,
            establishes_known:intent.kind === 'count' ? 1 : 0
        });
    } else {
        await conn.query('INSERT INTO stock_movements(occurred_at,operation_id,line_ordinal,stock_item_id,location_id,lot_id,quantity,establishes_known,unit_snapshot,source_line,business_date) VALUES ?',
            [changes.map((change, index) => [null, operation.insertId, index, change.line.key[0], change.line.key[1] ?? null, change.line.key[2] ?? null, change.signed,
                intent.kind === 'count' || intent.kind === 'opening' ? 1 : 0, items.get(change.line.key[0]).base_unit,
                change.line.source_line, intent.business_date])]);
    }
    const result = { operation_id: operation.insertId, lines: changes.map(change => ({
        stock_item_id: change.line.key[0],
        quantity: change.after, quantity_known: change.known, version: change.version
    })) };
    await conn.query('UPDATE stock_operations SET result_json=? WHERE id=?', [JSON.stringify(result), operation.insertId]);
    await invalidation.operations(conn, intent.business_date, [operation.insertId]);
    await refreshAttention(conn, itemIds);
    return result;
}

async function refreshAttention(conn, itemIds) {
    if (!Array.isArray(itemIds) || !itemIds.length) return;
    await conn.query(`UPDATE stock_items s LEFT JOIN stock_balances b ON b.stock_item_id=s.id
        SET s.attention=CASE
            WHEN s.is_active=0 OR s.tracking_state<>'active' THEN 'inactive'
            WHEN b.stock_item_id IS NULL OR b.quantity_known=0 THEN 'unknown'
            WHEN b.quantity<0 THEN 'negative'
            ELSE 'ok' END
        WHERE s.id IN (?)`, [itemIds]);
}


function compareId(a, b) {
    const left = BigInt(a); const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
}

function qtyText(value) {
    try { return quantity.format(quantity.parse(value)); }
    catch (error) { fail(error.message, 400); }
}

function movementDay(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
    fail('Invalid business date.', 400);
}

function sourceKind(kind) {
    if (kind === 'usage' || kind === 'reversal') return 'ingredient_usage';
    if (kind === 'correction') return 'ingredient_correction';
    return 'ingredient_manual';
}

function stockKind(row) {
    if (row.kind === 'usage') return 'issue';
    if (row.kind === 'reversal') return 'return';
    if (row.kind === 'receipt') return 'receipt';
    if (row.kind === 'waste') return 'waste';
    if (row.kind === 'count') return 'count';
    if (row.kind === 'correction') {
        const amount = quantity.parse(qtyText(row.qty));
        if (amount === 0n) return null;
        return amount < 0n ? 'issue' : 'receipt';
    }
    return null;
}

async function recordSources(conn, operationId, lines) {
    await conn.query('INSERT INTO stock_operation_sources(operation_id,line_ordinal,source_kind,source_type,source_id,source_line,ingredient_id) VALUES ?',
        [lines.map((line, ordinal) => [operationId, ordinal, sourceKind(line.row.kind), line.row.source_type ?? null,
            line.row.source_id ?? null, line.row.line_key || line.row.client_key || line.source_line, line.ingredient_id])]);
}

// Ingredient rows are inserted under the caller's sorted ingredient locks.
async function prepareIngredientEffects(conn, rows, links) {
    const linked = new Map(links.map(link => [link.ingredient_id, link]));
    const lastCount = new Map(links.map(row => [row.ingredient_id, row.last_count_id]));
    const pending = [];
    for (const row of rows) {
        const link = linked.get(String(row.ingredient_id));
        if (!link) continue;
        const kind = stockKind(row);
        if (!kind) continue;
        if (kind !== 'count' && quantity.parse(qtyText(row.qty)) === 0n) continue;
        if (row.kind === 'correction' && lastCount.has(String(row.ingredient_id))
            && row.corrects_movement_id != null
            && BigInt(row.corrects_movement_id) <= BigInt(lastCount.get(String(row.ingredient_id)))) continue;
        pending.push({
            ingredient_id: Number(row.ingredient_id),
            stock_item_id: link.stock_item_id,
            kind,
            row,
            quantity: qtyText(row.qty),
            source_line: String(row.line_key || row.client_key || `${row.source_type || 'manual'}:${row.source_id ?? 0}`).slice(0, 100)
        });
    }
    if (!pending.length) return null;
    const itemIds = [...new Set(pending.map(line => line.stock_item_id))].sort(compareId);
    await conn.query('SELECT id FROM stock_items WHERE id IN (?) ORDER BY id FOR UPDATE', [itemIds]);
    const [balances]=await conn.query(`SELECT CAST(stock_item_id AS CHAR) stock_item_id,CAST(version AS CHAR) version
        FROM stock_balances WHERE stock_item_id IN (?) ORDER BY stock_item_id FOR UPDATE`,[itemIds]);
    const versions = new Map(balances.map(row => [row.stock_item_id, row.version]));
    for (const line of pending) {
        if (line.kind === 'count') line.expected_version = versions.get(line.stock_item_id) || '0';
    }
    const groups = new Map();
    for (const line of pending) {
        const groupKey = `${line.kind}/${movementDay(line.row.business_date)}`;
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(line);
    }
    const posted = [];
    for (const [groupKey, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const [kind, day] = groupKey.split('/');
        for (let offset = 0; offset < group.length; offset += 100) {
            const chunk = group.slice(offset, offset + 100);
            const physical = new Map();
            for (const line of chunk) {
                const key = line.stock_item_id;
                const existing = physical.get(key);
                if (existing) {
                    if (kind === 'count') fail('An ingredient can be counted only once per operation.', 400);
                    existing.quantity = quantity.format(quantity.parse(existing.quantity) + quantity.parse(line.quantity));
                } else physical.set(key, { ...line });
            }
            const result = await postMovement(conn, {
                kind,
                // Source writers deduplicate retries under ingredient locks. Each
                // new posting gets a fresh occurrence key, as its old insertion
                // ID did. This key is internal; client keys remain unchanged.
                request_key: `ing_${randomUUID()}`,
                business_date: day,
                lines: [...physical.values()].map(line => ({
                    stock_item_id: line.stock_item_id,
                    quantity: line.quantity,
                    expected_version: line.expected_version,
                    source_line: line.source_line
                }))
            }, chunk[0].row.user_id ?? null, chunk);
            // A fresh internal occurrence must prepare these rows' effects.
            // Client retries are resolved before posting or at the unique row key.
            if (result.replayed) fail('Ingredient posting occurrence already exists.', 409);
            await recordSources(conn, result.operation_id, chunk);
            posted.push(result);
        }
    }
    return posted;
}


// The original ingredient projection is also the public response shape. Physical
// fields and the discriminator stay internal to this ledger.
const ingredientWriteColumns = [
    'ingredient_id', 'kind', 'qty', 'unit_cost', 'reason', 'expected_qty', 'period_usage_qty',
    'line_key', 'unit_qty', 'product_qty', 'source_type', 'source_id', 'source_label',
    'product_id', 'product_name', 'user_id', 'user_name', 'business_date', 'note',
    'client_key', 'corrects_movement_id', 'purchase_priced', 'cost_source'
];
const ingredientColumns = (alias = '') => ['id', ...ingredientWriteColumns, 'occurred_at']
    .map(column => alias ? `${alias}.${column}` : column).join(',');

async function appendIngredientRows(conn, rows, {readBack = true} = {}) {
    if (!rows.length) return [];
    const ids = [...new Set(rows.map(row => Number(row.ingredient_id)))].sort((a,b) => a-b);
    const [links] = await conn.query(`SELECT CAST(id AS CHAR) ingredient_id,CAST(stock_item_id AS CHAR) stock_item_id,
        CAST(working_last_count_id AS CHAR) last_count_id FROM ingredients
        WHERE id IN (?) AND stock_item_id IS NOT NULL ORDER BY id FOR UPDATE`, [ids]);
    const prepared = rows.map(row => ({...row}));
    // A single manual movement can recover ER_DUP_ENTRY as a successful replay.
    // Roll back all prepared physical effects before that caller handles the key.
    // Unkeyed recipe usage propagates errors to its whole source transaction.
    const checkpoint = links.length && rows.some(row => row.client_key);
    if (checkpoint) await conn.query('SAVEPOINT ingredient_movement_post');
    try {
        if (links.length) await prepareIngredientEffects(conn, prepared, links);
        const physicalColumns = ['operation_id','line_ordinal','stock_item_id','quantity','unit_snapshot','source_line','establishes_known'];
        const [result] = await conn.query(`INSERT INTO stock_movements(movement_type,${ingredientWriteColumns.join(',')},${physicalColumns.join(',')}) VALUES ?`,
            [prepared.map(row => ['ingredient', ...ingredientWriteColumns.map(column => row[column] ?? null),
                ...physicalColumns.map(column => row[column] ?? (column === 'establishes_known' ? 0 : null))])]);
        if ((typeof result.insertId === 'number' && !Number.isSafeInteger(result.insertId))
            || !/^[1-9]\d*$/.test(String(result.insertId))) throw new TypeError('A durable ingredient insertion identity is required.');
        let inserted = rows;
        if (readBack) {
            [inserted] = await conn.query(`SELECT ${ingredientColumns()} FROM stock_movements
                WHERE movement_type='ingredient' AND id>=? AND ingredient_id IN (?) ORDER BY id LIMIT ?`,
                [String(result.insertId), ids, rows.length]);
            // Ingredient locks exclude another writer to these identities. Never
            // infer consecutive AUTO_INCREMENT IDs, including after rollback.
            if (inserted.length !== rows.length) throw new Error('Inserted ingredient rows could not be resolved.');
        }
        if (checkpoint) await conn.query('RELEASE SAVEPOINT ingredient_movement_post');
        return inserted;
    } catch (error) {
        // InnoDB deadlocks roll back the entire transaction, including savepoints.
        // Preserve that error so the source owner can retry the whole transaction.
        if (checkpoint && error.code !== 'ER_LOCK_DEADLOCK') {
            await conn.query('ROLLBACK TO SAVEPOINT ingredient_movement_post');
            await conn.query('RELEASE SAVEPOINT ingredient_movement_post');
        }
        throw error;
    }
}

const post = (conn, input, actorId) => postMovement(conn, input, actorId);
module.exports = { post, appendIngredientRows, ingredientColumns, refreshAttention };
