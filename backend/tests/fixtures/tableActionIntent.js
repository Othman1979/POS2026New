const { randomUUID } = require('node:crypto');

// For compatibility tests that intentionally act on the current groups. Stale-action
// regressions must capture this once, before the competing action, and retain it.
async function tableActionIntent(pool, payload) {
    const [rows] = await pool.query(
        `SELECT id, current_order_id, status, parent_table_id FROM restaurant_tables
         WHERE id IN (?,?) OR parent_table_id IN (?,?) ORDER BY id`,
        [payload.sourceTableId, payload.targetTableId, payload.sourceTableId, payload.targetTableId]
    );
    return { ...payload, operation_id: randomUUID(), expected_tables: rows };
}

module.exports = { tableActionIntent };
