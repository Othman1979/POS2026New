'use strict';

const { markDirty, scopeFor } = require('./StockReportGenerationService');

function fail(message, statusCode = 400) {
    throw Object.assign(new Error(message), { statusCode });
}

function movementDay(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
    fail('Invalid stock report day.');
}

function invoiceId(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('Stock report source IDs must be exact integers.');
    const text = String(value ?? '');
    if (!/^[1-9]\d{0,19}$/.test(text)) return null;
    return text;
}

function allScopes(day) {
    return Array.from({ length: 32 }, (_, scope_id) => ({ day, scope_id }));
}

// Source transactions call this after document and stock locks. Batches stay
// within markDirty's 64-scope cap by flushing sorted unique keys in chunks.
async function flush(conn, scopes) {
    const unique = new Map();
    for (const scope of scopes || []) {
        if (!scope) continue;
        unique.set(`${scope.day}/${String(scope.scope_id).padStart(2, '0')}`, scope);
    }
    const values = [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, scope]) => scope);
    for (let index = 0; index < values.length; index += 64) {
        await markDirty(conn, values.slice(index, index + 64));
    }
}

async function apply(conn, scopes) {
    if (conn.collectReportScopes) { conn.collectReportScopes(scopes); return; }
    // Direct internal callers own a single completed source mutation. Production
    // multi-writer entrypoints use getConnection below, with one final flush.
    await flush(conn, scopes);
}

let activeTransactions = 0;
function hasSourcePressure() { return activeTransactions > 0; }

// Explicit transaction facade, never a patch on a pooled driver connection.
// Its scope collection belongs to this lease and is discarded on every exit.
async function getConnection(pool) {
    const raw = await pool.getConnection();
    const pending = new Map();
    let active = false, released = false;
    function finish() {
        if (active) activeTransactions--;
        active = false; pending.clear();
    }
    return {
        get threadId() { return raw.threadId; },
        query(...args) { return raw.query(...args); },
        execute(...args) { return raw.execute(...args); },
        collectReportScopes(scopes) {
            if (!active || released) throw new Error('Stock report invalidation requires its active source transaction.');
            for (const scope of scopes || []) if (scope) pending.set(`${scope.day}/${scope.scope_id}`,scope);
        },
        async beginTransaction() {
            if (active || released) throw new Error('Invalid stock transaction lifecycle.');
            await raw.beginTransaction(); active = true; activeTransactions++;
        },
        async commit() {
            if (released) throw new Error('Stock transaction connection is released.');
            if (active) await flush(raw,[...pending.values()]);
            await raw.commit(); finish();
        },
        async rollback() { try { await raw.rollback(); } catch(error) { released=true;raw.destroy();throw error; } finally { finish(); } },
        release() {
            if (released) return;
            released = true;
            // An abandoned transaction must not be handed to another request.
            const abandoned = active; finish();
            if (abandoned) raw.destroy(); else raw.release();
        },
        destroy() { if (released) return; released=true; finish(); raw.destroy(); }
    };
}

async function invoices(conn, day, ids) {
    const scopes = [];
    for (const id of ids || []) {
        const invoice = invoiceId(id);
        if (invoice) scopes.push({ day: movementDay(day), scope_id: scopeFor('invoice', invoice) });
    }
    await apply(conn, scopes);
}

async function operations(conn, day, ids) {
    const scopes = [];
    for (const id of ids || []) {
        const operation = invoiceId(id);
        if (operation) scopes.push({ day: movementDay(day), scope_id: scopeFor('operation', operation) });
    }
    await apply(conn, scopes);
}

async function physicalDay(conn, day) {
    await apply(conn, allScopes(movementDay(day)));
}

// Invoice-linked rows use the original invoice partition. Refunds map to that
// invoice. Manual, void, redemption and other non-invoice physical rows dirty
// every partition for the movement day because writers do not know the later
// movement-id hash used by the fact stream.
async function fromMovements(conn, rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    const scopes = [];
    const refundsByDay = new Map();
    const allDays = new Set();
    for (const row of rows) {
        const day = movementDay(row.business_date);
        if (row.source_type === 'order' && row.source_id) {
            const invoice = invoiceId(row.source_id);
            if (invoice) scopes.push({ day, scope_id: scopeFor('invoice', invoice) });
            continue;
        }
        if (row.source_type === 'refund' && row.source_id) {
            const refund = invoiceId(row.source_id);
            if (!refund) continue;
            if (!refundsByDay.has(day)) refundsByDay.set(day, []);
            refundsByDay.get(day).push(refund);
            continue;
        }
        allDays.add(day);
    }
    for (const day of allDays) scopes.push(...allScopes(day));
    for (const [day, refundIds] of refundsByDay) {
        if (allDays.has(day)) continue;
        const [mapped] = await conn.query('SELECT invoice_id FROM refunds WHERE id IN (?)', [refundIds]);
        for (const row of mapped) {
            const invoice = invoiceId(row.invoice_id);
            if (invoice) scopes.push({ day, scope_id: scopeFor('invoice', invoice) });
        }
    }
    await apply(conn, scopes);
}

module.exports = { apply, invoices, operations, physicalDay, fromMovements, getConnection, hasSourcePressure };
