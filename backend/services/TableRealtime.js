const pool = require('../config/db');
const logger = require('../config/logger');
const cache = require('../config/cache');
const { orderDisplayNoSql } = require('../utils/orderNumber');
const { SPLIT_SUMMARY_JOIN, SPLIT_SUMMARY_COLUMNS } = require('./TableSummaryQuery');
const { getTableSectionIds, canAccessTables, canCheckout, canCheckoutTable, canSplitBill } = require('./PermissionService');

const tableRooms = sectionId => ['table-access:all', `table-access:section:${sectionId}`];

// Set by the server from the authenticated session, independent of which tab
// or floor section is visible. Client room requests cannot widen this scope.
function staffTableRooms(user) {
    if (!canAccessTables(user) && !canCheckout(user) && !canCheckoutTable(user) && !canSplitBill(user)) return [];
    const ids = getTableSectionIds(user);
    return ids === null ? ['table-access:all'] : ids.map(id => `table-access:section:${id}`);
}

async function broadcastTableDraftChanged(io, tableId, itemCount, sectionId = null) {
    if (!io) return;
    if (sectionId == null) {
        const [[table]] = await pool.query('SELECT section_id FROM restaurant_tables WHERE id=?', [tableId]);
        if (!table) return;
        sectionId = table.section_id;
    }
    io.to(tableRooms(sectionId)).emit('table_draft_changed', { tableId, itemCount });
}

async function broadcastTableUpdate(io, tableId, { invalidateDashboard = true } = {}) {
    if (!io || !tableId) return;
    try {
        if (invalidateDashboard) cache.invalidateDashboardCache();
        const [rows] = await pool.query(`
            SELECT t.id, t.section_id, t.table_number, t.status, t.current_order_id, t.parent_table_id, t.seating_parent_id, s.name as section_name,
                   ${SPLIT_SUMMARY_COLUMNS},
                   o.created_at as active_order_created_at,
                   o.waiter_id as waiter_id, u.name as active_order_waiter_name,
                   COALESCE(JSON_LENGTH(qd.cart_data), 0) as qr_draft_count,
                   o.order_id, o.order_type_id, o.invoice_number, o.invoice_issued_at,
                   CASE WHEN o.invoice_number IS NULL THEN NULL ELSE CAST(o.invoice_number AS CHAR) END AS invoice_display_no,
                   ${orderDisplayNoSql('o')} AS order_display_no,
                   CASE WHEN o.invoice_number IS NULL AND o.order_id IS NOT NULL THEN ${orderDisplayNoSql('o')} ELSE NULL END AS ticket_display_no,
                   CASE WHEN o.invoice_number IS NULL AND o.order_id IS NULL AND t.table_number IS NOT NULL THEN CAST(t.table_number AS CHAR) ELSE NULL END AS table_display_no
            FROM restaurant_tables t
            JOIN sections s ON t.section_id = s.id
            LEFT JOIN orders o ON t.current_order_id = o.invoice_id
            LEFT JOIN users u ON o.waiter_id = u.id
            LEFT JOIN qr_table_drafts qd ON t.id = qd.table_id
            ${SPLIT_SUMMARY_JOIN}
            WHERE t.id = ?
        `, [tableId]);
        if (rows.length > 0) {
            io.to(tableRooms(rows[0].section_id)).emit('table_update', { action: 'update_single_table', table: rows[0] });
        }
    } catch (err) {
        logger.error({ err, tableId }, 'Failed to broadcast single table update');
    }
}

async function broadcastTableUpdates(io, tableIds, { invalidateDashboard = true } = {}) {
    if (!io) return;
    const ids = [...new Set(
        (Array.isArray(tableIds) ? tableIds : [tableIds]).filter(Boolean)
    )];
    if (ids.length === 0) return;
    if (ids.length === 1) {
        return broadcastTableUpdate(io, ids[0], { invalidateDashboard });
    }
    try {
        if (invalidateDashboard) cache.invalidateDashboardCache();
        const placeholders = ids.map(() => '?').join(',');
        const [rows] = await pool.query(`
            SELECT t.id, t.section_id, t.table_number, t.status, t.current_order_id, t.parent_table_id, t.seating_parent_id, s.name as section_name,
                   ${SPLIT_SUMMARY_COLUMNS},
                   o.created_at as active_order_created_at,
                   o.waiter_id as waiter_id, u.name as active_order_waiter_name,
                   COALESCE(JSON_LENGTH(qd.cart_data), 0) as qr_draft_count,
                   o.order_id, o.order_type_id, o.invoice_number, o.invoice_issued_at,
                   CASE WHEN o.invoice_number IS NULL THEN NULL ELSE CAST(o.invoice_number AS CHAR) END AS invoice_display_no,
                   ${orderDisplayNoSql('o')} AS order_display_no,
                   CASE WHEN o.invoice_number IS NULL AND o.order_id IS NOT NULL THEN ${orderDisplayNoSql('o')} ELSE NULL END AS ticket_display_no,
                   CASE WHEN o.invoice_number IS NULL AND o.order_id IS NULL AND t.table_number IS NOT NULL THEN CAST(t.table_number AS CHAR) ELSE NULL END AS table_display_no
            FROM restaurant_tables t
            JOIN sections s ON t.section_id = s.id
            LEFT JOIN orders o ON t.current_order_id = o.invoice_id
            LEFT JOIN users u ON o.waiter_id = u.id
            LEFT JOIN qr_table_drafts qd ON t.id = qd.table_id
            ${SPLIT_SUMMARY_JOIN}
            WHERE t.id IN (${placeholders})
        `, ids);
        for (const table of rows) {
            io.to(tableRooms(table.section_id)).emit('table_update', { action: 'update_single_table', table });
        }
    } catch (err) {
        logger.error({ err, tableIds: ids }, 'Failed to broadcast batch table update');
    }
}

module.exports = { broadcastTableUpdate, broadcastTableUpdates, broadcastTableDraftChanged, staffTableRooms };
