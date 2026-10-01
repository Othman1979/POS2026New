const { createHash } = require('node:crypto');

const validOperationId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{16,64}$/.test(value);
const positiveId = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nullableId = value => value === null || positiveId(value);
const groupState = rows => rows.map(row => ({
    id: Number(row.id), current_order_id: row.current_order_id == null ? null : Number(row.current_order_id),
    status: row.status, parent_table_id: row.parent_table_id == null ? null : Number(row.parent_table_id)
})).sort((a, b) => a.id - b.id);

function normalizeExpectedTables(rows) {
    if (!Array.isArray(rows) || rows.length < 2 || rows.length > 5000) return null;
    if (!rows.every(row => row && positiveId(row.id) && nullableId(row.current_order_id)
        && nullableId(row.parent_table_id) && ['available', 'occupied', 'printed'].includes(row.status))) return null;
    if (new Set(rows.map(row => row.id)).size !== rows.length) return null;
    return groupState(rows);
}

// The unique operation lock precedes the existing sorted group locks. A concurrent
// duplicate waits here and reads the first transaction's committed result. Failed
// actions roll this reservation back, so no pending operation can be committed.
async function claimTableAction(conn, { operationId, userId, sourceId, targetId, action, expectedTables, itemTransfer }) {
    const request = { sourceId, targetId, action, expectedTables };
    // Omit the extension for existing actions so their durable hashes keep working.
    if (itemTransfer !== undefined) request.itemTransfer = itemTransfer;
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    await conn.execute(`INSERT INTO table_action_operations (operation_id,user_id,action,request_hash)
        VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE operation_id=VALUES(operation_id)`, [operationId, userId, action, hash]);
    const [[row]] = await conn.execute(
        'SELECT user_id,request_hash,result_json FROM table_action_operations WHERE operation_id=? FOR UPDATE', [operationId]
    );
    if (Number(row.user_id) !== Number(userId) || row.request_hash !== hash) return { conflict: true };
    return { result: row.result_json ? JSON.parse(row.result_json) : null };
}

module.exports = { validOperationId, groupState, normalizeExpectedTables, claimTableAction };
