const { orderDisplayNoSql } = require('../../utils/orderNumber');
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin, rejectCallCenterRole } = require('../../middleware/auth');
const printRouter = require('../print');
const { reconstructBundleSubs } = require('../../services/bundleOrderItems');
const {
    BUNDLE_ORDER_CORRUPT,
    assertOrderItemBundleIntegrity
} = require('../../services/bundleIntegrity');
const { buildOrderIdentity } = require('../../utils/orderIdentity');
const pool = require('../../config/db');
const crypto = require('crypto');
const logger = require('../../config/logger');
const { getSettings } = require('../../config/settingsHelper');
const { sendPosSuccess: sendSuccess, sendPosError: sendError } = require('../../http/jsonResponse');
const {
    isAdminRole: isAdminUser,
    canSplitBill,
    canAccessTables,
    canOverrideTables,
    canEditLocked,
    canTransferTable,
    canMergeTables,
    canCheckoutTable,
    canCheckout,
    getTableSectionIds,
    assertTableSectionAccess
} = require('../../services/PermissionService');
const { buildHeldPresentations } = require('../../services/ReceiptPresentationSources');
const { broadcastTableDraftChanged } = require('../../services/TableRealtime');
const { SPLIT_SUMMARY_JOIN, SPLIT_SUMMARY_COLUMNS } = require('../../services/TableSummaryQuery');
const { markTablePrinted } = require('../../modules/tables/markTablePrinted');
const { saveTableOrder } = require('../../modules/tables/saveTableOrder');
const { processTableAction, joinTables, disjoinTables } = require('../../modules/tables/tableRelationships');
const { transferTableItems } = require('../../modules/tables/tableItemTransfer');
const { validOperationId } = require('../../modules/tables/tableActionIdentity');
const { discardSplitCheck, createSplitChecks, rewriteUnpaidSplitChecks } = require('../../modules/tables/splitChecks');

// Permission middleware for split operations
const checkSplitBillPermission = (req, res, next) => {
    if (canSplitBill(req.user)) {
        next();
    } else {
        return sendError(res, 403, "Forbidden: Split bill permission required.");
    }
};

// Identifies exactly which stored draft a terminal imported, so its dismiss
// cannot erase lines the customer added after the import.
const draftHash = (cartData) => crypto.createHash('sha256')
    .update(typeof cartData === 'string' ? cartData : JSON.stringify(cartData))
    .digest('hex');

// GET /api/pos/table-draft/:tableId (Public for QR scans & terminals with token verification)
router.get('/table-draft/:tableId', async (req, res) => {
    const tableId = parseInt(req.params.tableId);
    if (!tableId || isNaN(tableId)) {
        return sendError(res, 400, "Invalid Table ID.");
    }
    try {
        // 1. Try to verify if it is a staff request first via the httpOnly session cookie.
        let user = null;
        const { verifyToken, parseCookies } = require('../../middleware/auth');
        const cookies = req.headers['cookie'] ? parseCookies(req.headers['cookie']) : {};
        const rawToken = cookies['pos_token'] || null;
        if (rawToken) {
            user = await verifyToken(rawToken);
        }

        // 2. Fetch the table's QR token from database
        const [tableRows] = await pool.query(
            "SELECT id, section_id, qr_code_token FROM restaurant_tables WHERE id = ? LIMIT 1",
            [tableId]
        );
        if (tableRows.length === 0) {
            return sendError(res, 404, "Table not found.");
        }

        const table = tableRows[0];

        // A valid guest token remains an independent read-only capability.
        // Staff cookie access uses the same grant and section policy as the floor.
        const guest = Boolean(req.query.token) && req.query.token === table.qr_code_token;
        if (!guest) {
            if (!canAccessTables(user)) {
                return sendError(res, 403, "Access Denied: Invalid or missing QR table token.");
            }
            assertTableSectionAccess(user, [table]);
        }

        // 4. Fetch the draft. Staff (who import and dismiss it) first get the latest
        // accepted customer cart written; a guest read keeps the write cooldown.
        if (!guest) await req.app.locals.customerCartWriter?.flush(tableId);
        const [rows] = await pool.query(
            "SELECT cart_data FROM qr_table_drafts WHERE table_id = ?",
            [tableId]
        );
        if (rows.length === 0) {
            return sendSuccess(res, { cart: [] });
        }
        const cart = typeof rows[0].cart_data === 'string' ? JSON.parse(rows[0].cart_data) : rows[0].cart_data;
        return sendSuccess(res, { cart, draft_hash: draftHash(rows[0].cart_data) });
    } catch (e) {
        logger.error({ err: e, tableId }, 'Failed to fetch table draft cart.');
        return sendError(res, e.statusCode || 500, e.statusCode ? e.message : 'Failed to fetch table draft.', e.publicCode || null);
    }
});

// The public QR draft read above intentionally remains available. Every staff
// table workflow below is forbidden to the fixed call-center role.
router.use(requireAuth, rejectCallCenterRole);

// GET /api/pos/get_tables
router.get('/get_tables', async (req, res, next) => {
    const requestedUserId = req.query.user_id || req.user.id;
    if (!requestedUserId) return sendError(res, 400, "User ID is required.");
    if (!isAdminUser(req.user) && String(requestedUserId) !== String(req.user.id)) {
        return sendError(res, 403, "Forbidden: Cannot load another user's tables.");
    }
    // Tables-page access: cashiers need the explicit grant; waiters inherently use the
    // floor plan (waiter perms are a separate project); admin/programmer bypass via userHas.
    if (!canAccessTables(req.user)) {
        return sendError(res, 403, "Forbidden: Tables access permission required.");
    }
    try {
        const [user, settings] = await Promise.all([
            String(requestedUserId) === String(req.user.id) ? req.user : (async () => {
                const [[selected]] = await pool.query("SELECT id, role, allowed_sections, table_access_scope FROM users WHERE id = ?", [requestedUserId]);
                if (selected) selected.permissions = await require('../../services/PermissionService').loadUserPermissions(selected.id, selected.role);
                return selected;
            })(),
            getSettings(pool, ['tables_enabled', 'table_mode', 'admin_language', 'use_invoice_no_only'])
        ]);
        if (!user) return sendError(res, 404, "User not found.");

        settings.tables_enabled = settings.tables_enabled === '1';
        settings.admin_language = ['en', 'ar'].includes(settings.admin_language) ? settings.admin_language : 'en';
        settings.use_invoice_no_only = settings.use_invoice_no_only === '1';

        // Explicit scope controls the floor and every direct table action alike.
        // An empty/invalid selected list grants no sections, regardless of staff role.
        const sectionIds = getTableSectionIds(user);
        const isAllSections = sectionIds === null;

        let sectionsPromise;
        let tablesPromise;
        const tokenColumn = isAdminUser(req.user) ? 't.qr_code_token, ' : '';

        if (isAllSections) {
            sectionsPromise = pool.query("SELECT id, name FROM sections ORDER BY id ASC");
            tablesPromise = pool.query(`
                SELECT t.id, t.section_id, t.table_number, t.status, t.current_order_id, ${tokenColumn}t.parent_table_id, t.seating_parent_id, s.name as section_name,
                       ${SPLIT_SUMMARY_COLUMNS},
                       o.created_at as active_order_created_at, u.name as active_order_waiter_name,
                       COALESCE(JSON_LENGTH(qd.cart_data), 0) as qr_draft_count,
                       o.order_id, o.order_type_id, o.invoice_number, o.invoice_issued_at, o.waiter_id,
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
                ORDER BY t.section_id ASC, CAST(t.table_number AS UNSIGNED) ASC, LENGTH(t.table_number) ASC, t.table_number ASC
            `);
        } else {
            // Parse the comma-separated allowed_sections string into an array of integers
            // so MySQL can use the index on sections.id and restaurant_tables.section_id
            // instead of performing a full table scan with FIND_IN_SET.
            if (sectionIds.length === 0) {
                return sendSuccess(res, {
                    settings,
                    sections: [],
                    tables: [],
                    permissions: {
                        can_update_table: false,
                        can_transfer_table: false,
                        can_join_tables: false,
                        can_override_tables: false,
                        can_checkout_table: false,
                    }
                });
            }

            const sectionPlaceholders = sectionIds.map(() => '?').join(',');
            sectionsPromise = pool.query(
                `SELECT id, name FROM sections WHERE id IN (${sectionPlaceholders}) ORDER BY id ASC`,
                sectionIds
            );
            tablesPromise = pool.query(`
                SELECT t.id, t.section_id, t.table_number, t.status, t.current_order_id, ${tokenColumn}t.parent_table_id, t.seating_parent_id, s.name as section_name,
                       ${SPLIT_SUMMARY_COLUMNS},
                       o.created_at as active_order_created_at, u.name as active_order_waiter_name,
                       COALESCE(JSON_LENGTH(qd.cart_data), 0) as qr_draft_count,
                       o.order_id, o.order_type_id, o.invoice_number, o.invoice_issued_at, o.waiter_id,
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
                WHERE t.section_id IN (${sectionPlaceholders})
                ORDER BY t.section_id ASC, CAST(t.table_number AS UNSIGNED) ASC, LENGTH(t.table_number) ASC, t.table_number ASC
            `, sectionIds);
        }

        const [[sections], [tables]] = await Promise.all([sectionsPromise, tablesPromise]);

        return sendSuccess(res, {
            settings,
            sections,
            tables,
            permissions: {
                can_update_table: canEditLocked(user),
                can_transfer_table: canTransferTable(user),
                can_join_tables: canMergeTables(user),
                can_override_tables: canOverrideTables(user),
                can_checkout_table: canCheckoutTable(user),
            }
        });
    } catch (e) {
        next(e);
    }
});

// GET /api/pos/tables/transfer/:operationId
// A read never retries a mutation. An absent receipt can still be in flight;
// clients retain the original key and expected state for any explicit retry.
router.get('/tables/transfer/:operationId', async (req, res, next) => {
    if (!validOperationId(req.params.operationId)) return sendError(res, 400, 'Invalid table action key.');
    if (!canTransferTable(req.user) && !canMergeTables(req.user)) return sendError(res, 403, 'Table action permission required.');
    try {
        const [[row]] = await pool.execute('SELECT user_id,action,result_json FROM table_action_operations WHERE operation_id=?', [req.params.operationId]);
        if (row && Number(row.user_id) !== Number(req.user.id)) return sendError(res, 404, 'Table action not found.');
        if (row && !(row.action === 'merge' ? canMergeTables(req.user) : canTransferTable(req.user))) return sendError(res, 403, 'Table action permission required.');
        return sendSuccess(res, { committed: !!row?.result_json, ...(row?.result_json ? { result: JSON.parse(row.result_json) } : {}) });
    } catch (error) { next(error); }
});

router.post('/tables/transfer/preview', async (req, res) => {
    try {
        return sendSuccess(res, await transferTableItems({ user: req.user, input: req.body, preview: true }));
    } catch (error) {
        const status = error.statusCode || 500;
        return sendError(res, status, status < 500 && !error.sqlState ? error.message : 'Unable to preview this item transfer.', error.publicCode || null);
    }
});

// POST /api/pos/tables/transfer
router.post('/tables/transfer', async (req, res) => {
    const { sourceTableId, targetTableId, action } = req.body;
    if (!sourceTableId || !targetTableId || !action) {
        return sendError(res, 400, "Missing required fields.");
    }
    if (!['transfer', 'swap', 'merge', 'move_items'].includes(action)) {
        return sendError(res, 400, "Invalid table action.");
    }

    const sourceId = Number(sourceTableId);
    const targetId = Number(targetTableId);
    if (![sourceId, targetId].every(id => Number.isSafeInteger(id) && id > 0)) {
        return sendError(res, 400, 'Invalid table IDs.');
    }

    if (sourceId === targetId) {
        return sendError(res, 400, 'Source and target tables must be different.');
    }

    try {
        const result = action === 'move_items'
            ? await transferTableItems({ user: req.user, input: req.body, io: req.io, ipAddress: req.ip || null })
            : await processTableAction({
            user: req.user,
            sourceId,
            targetId,
            action,
            operationId: req.body.operation_id,
            expectedTables: req.body.expected_tables,
            io: req.io,
            ipAddress: req.ip || null
        });
        if (result.error) return sendError(res, result.status, result.message, result.code);
        return sendSuccess(res, result);
    } catch (err) {
        const status = err.statusCode || 500;
        const isDbError = !!(err.code || err.errno || err.sqlState || err.sql);
        const msg = (status !== 500 && !isDbError)
            ? err.message
            : ((process.env.NODE_ENV === 'production' || isDbError) ? 'Operation failed due to a database error.' : (err.message || 'Operation failed.'));
        return sendError(res, status, msg, err.publicCode || null);
    }
});

// POST /api/pos/tables/join
router.post('/tables/join', async (req, res) => {
    const { parentTableId, childTableIds, managerPin } = req.body;
    if (!parentTableId || !Array.isArray(childTableIds) || childTableIds.length === 0) {
        return sendError(res, 400, "Missing required fields.");
    }

    const parentId = Number(parentTableId);
    const childIds = childTableIds.map(Number);
    if (![parentId, ...childIds].every(id => Number.isSafeInteger(id) && id > 0)) {
        return sendError(res, 400, 'Invalid table IDs.');
    }
    if (new Set(childIds).size !== childIds.length) {
        return sendError(res, 400, 'Duplicate child table IDs are not allowed.');
    }
    if (childIds.includes(parentId)) {
        return sendError(res, 400, 'A table cannot be joined to itself.');
    }
    const requestedIds = [parentId, ...childIds].sort((a, b) => a - b);

    try {
        const result = await joinTables({
            user: req.user,
            parentId,
            childIds,
            requestedIds,
            managerPin,
            io: req.io,
            ipAddress: req.ip || req.socket?.remoteAddress || null,
            route: req.originalUrl
        });
        if (result.error) return sendError(res, result.status, result.message, result.code);
        return sendSuccess(res, result);
    } catch (err) {
        const status = err.statusCode || 500;
        const isDbError = !!(err.code || err.errno || err.sqlState || err.sql);
        const msg = (status !== 500 && !isDbError)
            ? err.message
            : ((process.env.NODE_ENV === 'production' || isDbError) ? 'Operation failed due to a database error.' : (err.message || 'Operation failed.'));
        return sendError(res, status, msg, err.publicCode || null);
    }
});

// POST /api/pos/tables/disjoin
router.post('/tables/disjoin', async (req, res) => {
    const { tableIds, managerPin } = req.body;
    if (!Array.isArray(tableIds) || tableIds.length === 0) {
        return sendError(res, 400, "Missing required fields.");
    }

    const parsedTableIds = tableIds.map(tableId => Number(tableId));
    if (parsedTableIds.some(tableId => !Number.isInteger(tableId) || tableId <= 0)) {
        return sendError(res, 400, "Invalid table IDs.");
    }
    const normalizedTableIds = [...new Set(parsedTableIds)].sort((a, b) => a - b);

    try {
        const result = await disjoinTables({
            user: req.user,
            normalizedTableIds,
            managerPin,
            io: req.io,
            ipAddress: req.ip || req.socket?.remoteAddress || null,
            route: req.originalUrl
        });
        if (result.error) return sendError(res, result.status, result.message, result.code);
        return sendSuccess(res, result);
    } catch (err) {
        const status = err.statusCode || 500;
        const isDbError = !!(err.code || err.errno || err.sqlState || err.sql);
        const msg = status !== 500 && !isDbError
            ? err.message
            : ((process.env.NODE_ENV === 'production' || isDbError) ? 'Operation failed due to a database error.' : (err.message || 'Operation failed.'));
        return sendError(res, status, msg, err.publicCode || null);
    }
});

// A table id is a canonical positive integer: 7 or "7", never "1e2", "07" or "7abc".
function canonicalTableId(value) {
    const id = typeof value === 'number' ? value : (/^[1-9]\d*$/.test(String(value)) ? Number(value) : NaN);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// POST /api/pos/table_manager
router.post('/table_manager', requireAdmin, async (req, res) => {
    const data = req.body;
    const action = data.action || '';
    try {
        if (action === 'add_section') {
            const name = String(data.name ?? '').trim();
            if (!name) return sendError(res, 400, "Section name is required.");
            await pool.query("INSERT INTO sections (name) VALUES (?)", [name]);
            if (req.io) req.io.to('staff').emit('table_update', { action: 'refresh_sections' });
            return sendSuccess(res, {});
        } else if (action === 'delete_section') {
            const [[tablesCount]] = await pool.query("SELECT COUNT(*) as count FROM restaurant_tables WHERE section_id = ?", [data.id]);
            if (tablesCount.count > 0) {
                return sendError(res, 400, "Cannot delete section: There are active tables assigned to this section. Please delete or move the tables first.");
            }
            await pool.query("DELETE FROM sections WHERE id = ?", [data.id]);
            if (req.io) req.io.to('staff').emit('table_update', { action: 'refresh_sections' });
            return sendSuccess(res, {});
        } else if (action === 'add_table') {
            const tableNumber = String(data.table_number ?? '').trim();
            if (!data.section_id || !tableNumber) {
                return sendError(res, 400, "Section and table number are required.");
            }
            const secureToken = crypto.randomBytes(16).toString('hex');
            try {
                await pool.query(
                    "INSERT INTO restaurant_tables (section_id, table_number, x_pos, y_pos, qr_code_token) VALUES (?, ?, 20, 20, ?)",
                    [data.section_id, tableNumber, secureToken]
                );
            } catch (insertErr) {
                // NOTE: sendError() scrubs any message containing "table"+"exist" as a
                // suspected raw-DB leak (helpers.js). Phrase this WITHOUT the word "table"
                // so the friendly 409 survives the sanitizer.
                if (insertErr && insertErr.code === 'ER_DUP_ENTRY') {
                    return sendError(res, 409, `"${tableNumber}" already exists in this section.`);
                }
                throw insertErr;
            }
            if (req.io) req.io.to('staff').emit('table_update', { action: 'refresh_tables' });
            return sendSuccess(res, {});
        } else if (action === 'bulk_add_tables') {
            const { section_id, tables } = data;
            if (!section_id || !Array.isArray(tables) || tables.length === 0) {
                return sendError(res, 400, "Invalid parameters.");
            }
            if (tables.length > 100) {
                return sendError(res, 400, "Bulk table creation limit exceeded. Maximum 100 tables allowed per request.");
            }
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();
                const [existing] = await conn.query("SELECT LOWER(table_number) as num FROM restaurant_tables WHERE section_id = ?", [section_id]);
                const existingSet = new Set(existing.map(r => r.num));
                const insertValues = [];
                const insertParams = [];
                for (const tNum of tables) {
                    const trimmed = String(tNum).trim();
                    if (trimmed && !existingSet.has(trimmed.toLowerCase())) {
                        existingSet.add(trimmed.toLowerCase());
                        insertValues.push("(?, ?, 20, 20, ?)");
                        const secureToken = crypto.randomBytes(16).toString('hex');
                        insertParams.push(section_id, trimmed, secureToken);
                    }
                }
                if (insertValues.length > 0) {
                    await conn.query(
                        `INSERT INTO restaurant_tables (section_id, table_number, x_pos, y_pos, qr_code_token) VALUES ${insertValues.join(', ')}`,
                        insertParams
                    );
                }
                await conn.commit();
                if (req.io) req.io.to('staff').emit('table_update', { action: 'refresh_tables' });
                return sendSuccess(res, { count: insertValues.length });
            } catch (err) {
                await conn.rollback();
                throw err;
            } finally {
                conn.release();
            }
        } else if (action === 'delete_table') {
            const tableId = canonicalTableId(data.id);
            if (tableId === null) return sendError(res, 400, "Invalid table id.");
            const delConn = await pool.getConnection();
            try {
                await delConn.beginTransaction();
                const [[tableRow]] = await delConn.query(
                    "SELECT status, current_order_id FROM restaurant_tables WHERE id = ? FOR UPDATE",
                    [tableId]
                );
                if (!tableRow) {
                    await delConn.rollback();
                    return sendError(res, 404, "Table not found.");
                }
                if (tableRow.status !== 'available' || tableRow.current_order_id !== null) {
                    await delConn.rollback();
                    return sendError(res, 409, "Cannot delete a table with an active order.");
                }
                const [[{ activeChildren }]] = await delConn.query(
                    "SELECT COUNT(*) AS activeChildren FROM restaurant_tables WHERE (parent_table_id = ? OR seating_parent_id = ?) AND status != 'available'",
                    [tableId, tableId]
                );
                if (activeChildren > 0) {
                    await delConn.rollback();
                    return sendError(res, 409, "Cannot delete a table that has active joined tables.");
                }
                const [[{ historicalOrders }]] = await delConn.query(
                    "SELECT COUNT(*) AS historicalOrders FROM orders WHERE table_id = ?",
                    [tableId]
                );
                if (historicalOrders > 0) {
                    await delConn.rollback();
                    return sendError(
                        res,
                        409,
                        "Cannot delete a table referenced by historical orders. Deactivate it instead.",
                        'TABLE_HAS_HISTORY'
                    );
                }
                await delConn.query("DELETE FROM restaurant_tables WHERE id = ?", [tableId]);
                await delConn.commit();
            } catch (err) {
                await delConn.rollback();
                throw err;
            } finally {
                delConn.release();
            }
            req.app.locals.customerCartWriter?.cancel(tableId);
            if (req.io) {
                req.io.to('staff').emit('table_update', { action: 'refresh_tables' });
                req.io.in(`table_room_${tableId}`).disconnectSockets(true);
            }
            return sendSuccess(res, {});
        } else if (action === 'regenerate_qr_token') {
            const tableId = canonicalTableId(data.id);
            if (tableId === null) return sendError(res, 400, "Invalid table id.");
            const secureToken = crypto.randomBytes(16).toString('hex');
            await pool.query("UPDATE restaurant_tables SET qr_code_token = ? WHERE id = ?", [secureToken, tableId]);
            req.app.locals.customerCartWriter?.cancel(tableId);
            if (req.io) {
                req.io.to('staff').emit('table_update', { action: 'refresh_tables', table_id: tableId });
                // The old QR must stop working now, including for sockets already connected.
                req.io.in(`table_room_${tableId}`).disconnectSockets(true);
            }
            return sendSuccess(res, { qr_code_token: secureToken });
        } else {
            return sendError(res, 400, "Invalid action.");
        }
    } catch (e) {
        logger.error({ err: e, action }, 'table_manager action failed');
        sendError(res, 500, "Operation failed. Please try again.");
    }
});

// GET /api/pos/table_order
router.get('/table_order', async (req, res) => {
    const { order_id } = req.query;
    if (!order_id || order_id === 'null') return sendError(res, 400, "Missing order ID");
    if (!canAccessTables(req.user) && !canCheckout(req.user) && !canCheckoutTable(req.user)) {
        return sendError(res, 403, 'Forbidden: Tables access permission required.');
    }
    try {
        const [orderData] = await pool.query(
            `SELECT o.invoice_id, o.version, o.order_id, o.order_seq_scope, o.order_type_id, o.invoice_number, o.invoice_issued_at, o.created_at,
                    o.waiter_id, o.table_id, o.payment_method, o.discount_type, o.discount_value, o.tax_inclusive_at_sale, o.receipt_tax_inclusive_at_sale, o.tax_exempt_at_sale, o.tax_registration_type_at_sale, t.table_number, t.section_id,
                    o.service_charge_snapshot_id, scs.percentage AS service_charge_percentage,
                    scs.tax_rate AS service_charge_tax_rate, scs.jofotara_tax_category AS service_charge_tax_category,
                    scs.version AS service_charge_snapshot_version
             FROM orders o LEFT JOIN restaurant_tables t ON o.table_id = t.id
             LEFT JOIN service_charge_snapshots scs ON scs.id = o.service_charge_snapshot_id
             WHERE o.invoice_id = ?`,
            [order_id]
        );
        if (orderData.length === 0) {
            return sendError(res, 404, "Table order not found.");
        }
        const order = orderData[0];
        assertTableSectionAccess(req.user, [order]);
        if (order.payment_method !== 'unpaid_table') {
            return sendError(res, 409, "This table order is no longer active. Reopen the table from the floor plan.");
        }
        const [liveTableRows] = await pool.query(
            "SELECT id, section_id FROM restaurant_tables WHERE current_order_id = ?",
            [order_id]
        );
        if (liveTableRows.length === 0) {
            return sendError(res, 409, "This table order is no longer active. Reopen the table from the floor plan.");
        }
        assertTableSectionAccess(req.user, liveTableRows);
        const [[activeSplits]] = await pool.query(
            'SELECT COUNT(*) count FROM held_orders WHERE parent_invoice_id=?',
            [order_id]
        );
        if (Number(activeSplits.count) > 0) {
            return sendError(
                res,
                409,
                'This table has unpaid split checks. Continue from the Table Splits Board.',
                'SPLIT_CHECKS_OPEN'
            );
        }
        const waiterId = order.waiter_id;
        if (waiterId && waiterId !== req.user.id) {
            const maySettle = canCheckout(req.user) || canCheckoutTable(req.user);
            if (!canOverrideTables(req.user) && !maySettle) {
                return sendError(res, 403, "Forbidden: This table belongs to another waiter.");
            }
        }

        const [items] = await pool.query(`
            SELECT oi.*, COALESCE(oi.item_name, p.name) AS name, p.barcode, oi.tax_rate,
                   p.category_id, p.is_available, p.price_override_locked,
                   CASE
                     WHEN p.id IS NULL OR (
                       p.is_available = 1
                       AND (p.is_bundle = 0 OR NOT EXISTS (
                         SELECT 1
                         FROM product_bundle_items pbi
                         JOIN products child ON child.id = pbi.product_id
                         WHERE pbi.bundle_id = p.id
                           AND (child.is_active <> 1 OR child.is_available <> 1)
                       ))
                     )
                     THEN 1 ELSE 0
                   END AS can_sell
            FROM order_items oi 
            LEFT JOIN products p ON oi.product_id = p.id 
            WHERE oi.invoice_id = ? ORDER BY oi.sort_order ASC
        `, [order_id]);
        assertOrderItemBundleIntegrity(items);

        const childRows = items.filter(r => r.parent_item_id != null);
        const cart = [];
        for (const item of items) {
            if (item.parent_item_id != null) continue; // Skip children from top level

            const isBundleParent = childRows.some(c => c.parent_item_id === item.id);
            const cartItem = {
                id: item.product_id,
                name: item.name,
                price: item.price_before_tax_exemption != null
                    ? parseFloat(item.price_before_tax_exemption)
                    : parseFloat(item.price_at_sale),
                qty: parseFloat(item.quantity),
                originalQty: parseFloat(item.quantity),
                note: item.note || '',
                discountType: item.discount_type ?? null,
                discountValue: parseFloat(item.discount_value || 0),
                tax_rate: parseFloat(item.tax_rate || 0),
                jofotara_tax_category: item.jofotara_tax_category,
                is_available: item.product_id == null ? 1 : Number(item.is_available),
                can_sell: Number(item.can_sell),
                price_override_locked: Number(item.price_override_locked) || 0,
                cartId: 'db_' + (item.id || Math.floor(Math.random() * 90000) + 10000),
                // DB order_items.id of this parent line; the refund endpoint resolves
                // selections by order_item_id. Only top-level/parent lines map to a
                // refundable parent row; bundle children carry no money of their own.
                order_item_id: item.id,
                modifier_surcharge: item.modifier_surcharge != null ? Number(item.modifier_surcharge) : null,
                modifier_tax_amount: item.modifier_tax_amount != null ? Number(item.modifier_tax_amount) : null,
                selectedModifiers: (() => {
                    if (!item.selected_modifiers) return null;
                    try {
                        const parsed = JSON.parse(item.selected_modifiers);
                        return Array.isArray(parsed) ? parsed : null;
                    } catch { return null; }
                })(),
            };

            if (isBundleParent) {
                cartItem.is_bundle = true;
                const subs = childRows.filter(c => c.parent_item_id === item.id);
                // Persisted children are the complete historical bundle structure.
                cartItem.bundleItems = await reconstructBundleSubs(pool, item, subs);
            }
            cart.push(cartItem);
        }

        const orderIdentity = buildOrderIdentity(orderData.length > 0 ? orderData[0] : {});

        return sendSuccess(res, {
            cart,
            version: Number(order.version ?? 1),
            invoice_id: orderData.length > 0 ? orderData[0].invoice_id : null,
            order_id: orderData.length > 0 ? orderData[0].order_id : null,
            order_type_id: order.order_type_id,
            waiter_id: order.waiter_id ?? null,
            tax_inclusive_at_sale: orderData.length > 0 ? orderData[0].tax_inclusive_at_sale : null,
            receipt_tax_inclusive_at_sale: orderData.length > 0 ? orderData[0].receipt_tax_inclusive_at_sale : null,
            tax_exempt_at_sale: orderData.length > 0 ? Number(orderData[0].tax_exempt_at_sale) === 1 : false,
            tax_registration_type_at_sale: orderData.length > 0 ? orderData[0].tax_registration_type_at_sale : null,
            order_taken_at: orderData.length > 0 ? orderData[0].created_at : null,
            created_at: orderData.length > 0 ? orderData[0].created_at : null,
            ...orderIdentity,
            order_discount_type: orderData.length > 0 ? (orderData[0].discount_type || null) : null,
            order_discount_value: orderData.length > 0 ? Number(orderData[0].discount_value || 0) : 0,
            service_charge_snapshot: order.service_charge_snapshot_id ? {
                id: order.service_charge_snapshot_id,
                percentage: Number(order.service_charge_percentage),
                taxRate: Number(order.service_charge_tax_rate),
                taxCategory: order.service_charge_tax_category,
                version: Number(order.service_charge_snapshot_version)
            } : null
        });
    } catch (e) {
        logger.error({ err: e, route: req.originalUrl, method: req.method, userId: req.user?.id }, 'table_order GET failed.');
        return sendError(
            res,
            e.statusCode || 500,
            e.statusCode ? e.message : 'Operation failed. Please try again.',
            e.publicCode || null
        );
    }
});

// POST /api/pos/table_order
router.post('/table_order', async (req, res) => {
    const data = req.body;
    if (data.action === 'mark_printed') {
        const tableId = Number(data.table_id);
        const expectedInvoiceId = Number(data.expected_invoice_id);
        try {
            const result = await markTablePrinted({
                user: req.user,
                input: data,
                io: req.io
            });
            return sendSuccess(res, result);
        } catch (e) {
            const isDeadlock = e.errno === 1213 || e.code === 'ER_LOCK_DEADLOCK';
            const tableMissing = e.publicCode === 'TABLE_SESSION_CONFLICT'
                && /table was not found/i.test(e.message);
            const status = tableMissing ? 404 : (isDeadlock ? 409 : (e.statusCode || 500));
            const publicCode = isDeadlock ? 'TABLE_SESSION_CONFLICT' : (e.publicCode || null);
            if (status === 500) {
                logger.error({ err: e, tableId, expectedInvoiceId }, 'Mark printed failed.');
            }
            return sendError(
                res,
                status,
                status === 500 ? 'Operation failed. Please try again.' : e.message,
                publicCode
            );
        }
    }

    try {
        const result = await saveTableOrder({
            user: req.user,
            input: data,
            io: req.io,
            auditManagerId: req.auditManagerId || null,
            ipAddress: req.ip || null,
            printKitchenOrder: printRouter.printKitchenOrder
        });
        return sendSuccess(res, result);
    } catch (e) {
        logger.error({
            err: e,
            route: req.originalUrl,
            method: req.method,
            userId: req.user?.id,
            role: req.user?.role,
            tableId: data.table_id,
            currentOrderId: data.current_order_id || null,
            action: data.action || null
        }, 'Table order failed.');
        let status = e.statusCode || 500;
        const isDbError = !!(e.code || e.errno || e.sqlState || e.sql);
        if (status === 500 && !isDbError) {
            if (e.message?.startsWith('Forbidden:')) status = 403;
            else if (e.message?.startsWith('Conflict:')) status = 409;
            else if (
                e.message?.includes('mismatch') ||
                e.message?.includes('Table') ||
                e.message?.includes('table') ||
                e.message?.includes('Enter a valid') ||
                e.message?.includes('Insufficient stock') ||
                e.message?.includes('exist') ||
                e.message?.includes('printed') ||
                e.message?.includes('permission')
            ) {
                status = 400;
            }
        }
        const msg = (status !== 500 && !isDbError) ? e.message : "Operation failed. Please try again.";
        return sendError(res, status, msg, e.publicCode || null);
    }
});

// DELETE /api/pos/table-draft/:tableId (POS/Waiter Only)
router.delete('/table-draft/:tableId', async (req, res) => {
    const tableId = parseInt(req.params.tableId);
    if (!tableId || isNaN(tableId)) {
        return sendError(res, 400, "Invalid Table ID.");
    }
    if (!canAccessTables(req.user)) return sendError(res, 403, 'Forbidden: Tables access permission required.');
    const expectedHash = req.body?.expected_hash;
    if (expectedHash !== undefined && (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash))) {
        return sendError(res, 400, 'Invalid draft hash.');
    }
    let conn;
    try {
        // A queued customer cart must reach the database first, or it would be written after
        // this delete and offer the imported lines again.
        await req.app.locals.customerCartWriter?.flush(tableId);
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const [[table]] = await conn.query('SELECT id, section_id FROM restaurant_tables WHERE id=? FOR UPDATE', [tableId]);
        if (!table) {
            await conn.rollback();
            return sendError(res, 404, 'Table not found.');
        }
        assertTableSectionAccess(req.user, [table]);
        if (expectedHash !== undefined) {
            const [[draft]] = await conn.query('SELECT cart_data FROM qr_table_drafts WHERE table_id = ? FOR UPDATE', [tableId]);
            // A missing draft is already gone (e.g. a retried dismiss whose first answer was lost).
            if (draft && draftHash(draft.cart_data) !== expectedHash) {
                await conn.rollback();
                return sendError(res, 409, 'The customer changed the QR order after it was imported.', 'DRAFT_CHANGED');
            }
        }
        await conn.query("DELETE FROM qr_table_drafts WHERE table_id = ?", [tableId]);
        await conn.commit();
        conn.release();
        conn = null;

        await broadcastTableDraftChanged(req.io, tableId, 0, table.section_id);
        
        return sendSuccess(res, { message: "Table draft cleared successfully." });
    } catch (e) {
        if (conn) await conn.rollback().catch(() => {});
        logger.error({ err: e, tableId }, 'Failed to delete table draft cart.');
        return sendError(res, e.statusCode || 500, e.statusCode ? e.message : 'Failed to delete table draft.', e.publicCode || null);
    } finally {
        if (conn) conn.release();
    }
});

// GET /api/pos/table_splits
router.get('/table_splits', checkSplitBillPermission, async (req, res) => {
    try {
        const requestedParent = req.query.parent_invoice_id;
        if (requestedParent !== undefined && (typeof requestedParent !== 'string'
            || !/^[1-9]\d*$/.test(requestedParent) || !Number.isSafeInteger(Number(requestedParent)))) {
            return sendError(res, 400, 'A valid parent invoice ID is required.');
        }
        const sectionIds = getTableSectionIds(req.user);
        if (sectionIds?.length === 0) return sendSuccess(res, { data: [] });
        const scoped = sectionIds !== null;
        const [rows] = await pool.query(`
            SELECT h.id, h.reference_name, h.cart_data, h.subtotal, h.created_at,
                   h.table_id, h.parent_invoice_id, u.name as cashier_name,
                   COALESCE(paid.paid_split_count, 0) AS paid_split_count
            FROM held_orders h 
            LEFT JOIN users u ON h.user_id = u.id 
            LEFT JOIN (
                SELECT parent_invoice_id, COUNT(*) AS paid_split_count
                  FROM orders
                 WHERE payment_method IN ('cash','card','split')
                   AND parent_invoice_id IN (SELECT parent_invoice_id FROM held_orders WHERE parent_invoice_id IS NOT NULL)
                 GROUP BY parent_invoice_id
            ) paid ON paid.parent_invoice_id=h.parent_invoice_id
            ${scoped ? 'LEFT JOIN orders parent ON parent.invoice_id=h.parent_invoice_id LEFT JOIN restaurant_tables t ON t.id=COALESCE(h.table_id,parent.table_id)' : ''}
            WHERE (h.parent_invoice_id IS NOT NULL OR h.table_id IS NOT NULL)
            ${requestedParent !== undefined ? 'AND h.parent_invoice_id=?' : ''}
            ${scoped ? `AND t.section_id IN (${sectionIds.map(() => '?').join(',')})
                AND NOT EXISTS (
                    SELECT 1 FROM restaurant_tables member
                     WHERE (member.id=t.parent_table_id OR member.parent_table_id=COALESCE(t.parent_table_id,t.id))
                       AND member.section_id NOT IN (${sectionIds.map(() => '?').join(',')})
                )` : ''}
            ORDER BY h.created_at DESC
        `, [...(requestedParent !== undefined ? [Number(requestedParent)] : []), ...(scoped ? [...sectionIds, ...sectionIds] : [])]);
        const presentations = await buildHeldPresentations(pool, rows, { split: true });
        presentations.forEach((pres, idx) => {
            if (pres.error?.publicCode === BUNDLE_ORDER_CORRUPT) {
                logger.warn({
                    err: pres.error,
                    heldOrderId: rows[idx].id,
                    integrityReason: pres.error.integrityReason,
                    integrityContext: pres.error.integrityContext
                }, 'Corrupt table-split bundle data.');
            }
        });
        const data = rows.map((row, idx) => {
            const pres = presentations[idx];
            return {
                id: row.id,
                reference_name: row.reference_name,
                cart_data: row.cart_data,
                subtotal: row.subtotal,
                created_at: row.created_at,
                table_id: row.table_id,
                parent_invoice_id: row.parent_invoice_id,
                cashier_name: row.cashier_name,
                paid_split_count: row.paid_split_count,
                receipt_display_v1: pres.presentation || null,
                receipt_display_error: pres.error ? (pres.error.publicCode || pres.error.code || 'RECEIPT_PRESENTATION_INVALID') : null
            };
        });
        return sendSuccess(res, { data });
    } catch (e) {
        logger.error({ err: e }, 'POS /table_splits endpoint failed');
        return sendError(res, 500, "Failed to retrieve table splits.");
    }
});

// DELETE /api/pos/table_splits
router.delete('/table_splits', checkSplitBillPermission, async (req, res) => {
    const id = Number(req.query.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
        return sendError(res, 400, 'A valid split check ID is required.');
    }

    try {
        const result = await discardSplitCheck({ user: req.user, id, io: req.io, ipAddress: req.ip || null });
        return sendSuccess(res, result);
    } catch (e) {
        const status = e.statusCode || 500;
        const isDbError = !!(e.code || e.errno || e.sqlState || e.sql);
        const message = status !== 500 && !isDbError ? e.message : 'Failed to delete table split.';
        return sendError(res, status, message, e.publicCode || null);
    }
});

router.put('/table_splits', checkSplitBillPermission, async (req, res) => {
    try {
        const result = await rewriteUnpaidSplitChecks({
            user: req.user,
            splitId: Number(req.body?.splitId),
            expectedChecks: req.body?.expectedChecks,
            splits: req.body?.splits,
            io: req.io,
            ipAddress: req.ip || null
        });
        return sendSuccess(res, result);
    } catch (e) {
        const status = e.statusCode || 500;
        const isDbError = !!(e.code || e.errno || e.sqlState || e.sql);
        return sendError(res, status, status !== 500 && !isDbError ? e.message : 'Failed to update table splits.', e.publicCode || null);
    }
});

// POST /api/pos/table_splits/split
router.post('/table_splits/split', checkSplitBillPermission, async (req, res) => {
    logger.info({ body: req.body }, 'Received splits payload');
    const { tableId, currentOrderId, splits } = req.body;
    
    if (!Array.isArray(splits) || splits.length === 0) {
        return sendError(res, 400, "Missing splits data.");
    }
    if (!tableId || !currentOrderId) {
        return sendError(res, 400, "Split checks must start from a saved table order.");
    }

    try {
        const result = await createSplitChecks({
            user: req.user,
            tableId,
            currentOrderId,
            splits,
            io: req.io,
            ipAddress: req.ip || null
        });
        return sendSuccess(res, result);
    } catch (e) {
        const isDbError = !!(e.code || e.errno || e.sqlState || e.sql);
        let status = e.statusCode || (e.message?.startsWith('Forbidden:') ? 403 : (e.message?.startsWith('Conflict:') ? 409 : 500));
        if (status === 500 && !isDbError && (
            e.message?.includes('mismatch') ||
            e.message?.includes('required') ||
            e.message?.includes('Invalid') ||
            e.message?.includes('Service charge')
        )) status = 400;
        const msg = e.statusCode && !isDbError
            ? e.message
            : ((process.env.NODE_ENV === 'production' || isDbError)
                ? 'Failed to split bill due to a database error.'
                : (e.message || 'Failed to split bill.'));
        return sendError(res, status, msg, e.publicCode || null);
    }
});

module.exports = router;
