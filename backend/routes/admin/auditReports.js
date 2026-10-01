const express = require('express');
const router = express.Router();
const pool = require('../../config/db');
const { getBusinessDate, getBusinessDayRange, getBusinessDateRange } = require('../../utils/businessDate');
const { buildAuditReportPayload } = require('../../services/auditReportBuilder');
const { buildCategoryItemsReportPayload } = require('../../services/categoryItemsReportBuilder');
const {
    buildYHeldItemsReportPayload,
    cleanupExpiredYHeldReportArchives,
    getConfiguredYOrderTypeId,
} = require('../../services/yHeldItemsReportBuilder');
const { sendError, logAdminRouteError, paidOrderTimeSql } = require('./helpers');
const logger = require('../../config/logger');
const { PRINT_STORE_INFO_KEYS, getPrintStoreInfo } = require('../../services/printStoreInfo');
const { buildShiftReportPayload } = require('../../services/shiftReportPayload');
const { enqueuePrintJobs } = require('../../services/printDispatch');
const { safePublishSpoolerSyncWake } = require('../../services/spoolerSyncWake');
const { sanitizePrintString } = require('../../services/printText');
const { emitHeldOrdersChanged } = require('../../services/HeldOrderEvents');

// This fallback belongs only to the admin Shifts report actions. Receipt and
// kitchen routing retain their existing explicit-printer rules.
async function resolveReportPrinter(req) {
    if (req.body?.delivery === undefined) return null;
    if (req.body.delivery !== 'spooler') {
        throw Object.assign(new Error('Invalid report delivery.'), { statusCode: 400 });
    }
    const [printers] = await pool.query("SELECT * FROM printers WHERE role='receipt' AND is_active=1 ORDER BY id ASC");
    const printer = printers.find(row => String(row.id) === String(req.body.receipt_printer_id)) || printers[0];
    if (!printer) throw Object.assign(new Error('No receipt printer found.'), { statusCode: 409 });
    return printer;
}

async function queueReport(printer, payload, executor = pool) {
    if (!printer) return;
    const data = { ...payload };
    // Also works with already-installed spoolers that still render Y receipts.
    // The complete recovery snapshot is retained in master_held.
    if (data.print_type === 'y_held_items_report') delete data.orders;
    await enqueuePrintJobs(executor, [{
        printer_id: printer.id,
        printer_name: sanitizePrintString(printer.windows_name, 200),
        printer_type: printer.type,
        network_ip: printer.network_ip,
        network_port: printer.network_port,
        status_capability: printer.status_capability || 'write_only',
        print_type: data.print_type,
        data,
    }]);
    if (executor === pool) safePublishSpoolerSyncWake();
}

const SERIAL_PREFIX = {
    x_audit: 'X',
    z_audit: 'Z',
};

function normalizeReportType(value) {
    if (value === 'x_audit' || value === 'z_audit') return value;
    return null;
}

function normalizeBusinessDate(value) {
    const date = value || getBusinessDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
    return String(date);
}

function normalizePayloadJson(value) {
    if (!value) return {};
    return typeof value === 'string' ? JSON.parse(value) : value;
}

function normalizeDateOnly(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
    return String(value);
}

const MAX_PERIOD_DAYS = 366;

router.get('/shift-reports/:shiftId/print-payload', async (req, res) => {
    try {
        const printPayload = await buildShiftReportPayload(pool, {
            shiftId: req.params.shiftId,
            printType: req.query.type,
            user: req.user,
            storeInfo: await getPrintStoreInfo(pool),
        });
        return res.json({ success: true, print_payload: printPayload });
    } catch (error) {
        if ([400, 403, 404].includes(error.statusCode)) {
            return sendError(res, error.statusCode, error.message);
        }
        logAdminRouteError(req, error);
        return sendError(res, 500, 'Failed to prepare shift report.');
    }
});

router.post('/shift-reports/:shiftId/print', async (req, res) => {
    try {
        const printer = await resolveReportPrinter(req);
        if (!printer) return sendError(res, 400, 'Thermal delivery is required.');
        const payload = await buildShiftReportPayload(pool, {
            shiftId: req.params.shiftId,
            printType: req.body.type,
            user: req.user,
            storeInfo: await getPrintStoreInfo(pool),
        });
        await queueReport(printer, payload);
        return res.json({ success: true, print_queued: true, print_payload: payload });
    } catch (error) {
        logAdminRouteError(req, error);
        return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Failed to queue shift report.');
    }
});

function daysBetween(startDate, endDate) {
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    return Math.round((end.getTime() - start.getTime()) / 86400000);
}

async function getOpenShiftsForBusinessDate(executor, businessDate) {
    const range = getBusinessDayRange(businessDate);
    const [rows] = await executor.query(`
        SELECT s.id AS shift_id, s.user_id, u.name AS cashier_name, s.opened_at
        FROM shifts s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.status = 'open'
          AND s.opened_at < ?
          AND (
            s.opened_at >= ?
            OR EXISTS (
              SELECT 1 FROM orders o
              WHERE o.shift_id = s.id
                AND ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?
                AND o.payment_method NOT IN ('unpaid_table', 'voided')
            )
            OR EXISTS (
              SELECT 1 FROM refunds r
              WHERE r.shift_id = s.id AND r.created_at >= ? AND r.created_at < ?
            )
            OR EXISTS (
              SELECT 1 FROM orders vo
              WHERE vo.shift_id = s.id
                AND vo.created_at >= ? AND vo.created_at < ?
                AND vo.payment_method = 'voided'
            )
          )
        ORDER BY s.opened_at ASC, s.id ASC
    `, [
        range.end,
        range.start,
        range.start, range.end,
        range.start, range.end,
        range.start, range.end,
    ]);
    return rows.map(row => ({
        shift_id: row.shift_id,
        user_id: row.user_id,
        cashier_name: row.cashier_name || 'Unknown',
        opened_at: row.opened_at,
    }));
}

async function markReportReady(documentId, status = 'browser_ready') {
    try {
        const [[column]] = await pool.query(`
            SELECT COLUMN_TYPE AS column_type
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'audit_report_documents'
              AND COLUMN_NAME = 'last_print_status'
        `);
        if (!String(column?.column_type || '').includes(`'${status}'`)) {
            logger.warn({ auditReportDocumentId: documentId, status }, 'Report delivery status is not available in this schema.');
            return;
        }
        await pool.query(`
            UPDATE audit_report_documents
            SET last_print_status = ?, last_print_error = NULL
            WHERE id = ?
        `, [status, documentId]);
    } catch (error) {
        logger.warn({ err: error, auditReportDocumentId: documentId, status }, 'Could not record report delivery status.');
    }
}

function assertBrowserSafePayload(payload) {
    const storeInfo = payload?.storeInfo;
    if (storeInfo && Object.keys(storeInfo).some(key => !PRINT_STORE_INFO_KEYS.includes(key))) {
        const error = new Error('Stored report must be redacted before browser preview.');
        error.statusCode = 409;
        throw error;
    }
    return payload;
}

async function prepareAuditPayload(req, document, eventType, printer) {
    const payload = assertBrowserSafePayload(normalizePayloadJson(document.payload_json));
    payload.audit_report_document_id = Number(document.id);
    payload.copy_label = eventType === 'reprint' ? 'REPRINT' : 'ORIGINAL';
    payload.payload_hash = document.payload_hash;

    if (eventType === 'reprint') {
        await pool.query(`
            UPDATE audit_report_documents
            SET last_printed_at = CURRENT_TIMESTAMP, last_printed_by_user_id = ?,
                reprint_count = reprint_count + 1
            WHERE id = ?
        `, [req.user.id, document.id]);
    }

    await queueReport(printer, payload);
    await markReportReady(document.id, printer ? 'queued' : 'browser_ready');
    return payload;
}

function documentResponse(document, reprint = false) {
    return {
        id: document.id,
        report_type: document.report_type,
        serial_no: Number(document.serial_no),
        serial_label: document.serial_label,
        business_date: document.business_date instanceof Date
            ? document.business_date.toISOString().slice(0, 10)
            : String(document.business_date),
        payload_hash: document.payload_hash,
        issued_at: document.issued_at,
        reprint,
    };
}

router.get('/audit-reports/status', async (req, res) => {
    try {
        const businessDate = normalizeBusinessDate(req.query.business_date || req.query.date);
        if (!businessDate) return sendError(res, 400, 'Invalid business date.');

        const openShifts = await getOpenShiftsForBusinessDate(pool, businessDate);
        const [documents] = await pool.query(`
            SELECT id, report_type, serial_no, serial_label, business_date, payload_hash, issued_at
            FROM audit_report_documents
            WHERE business_date = ? AND status = 'issued'
            ORDER BY id ASC
        `, [businessDate]);

        const normalizedDocuments = documents.map(row => documentResponse(row, false));
        return res.json({
            success: true,
            business_date: businessDate,
            can_issue_z: openShifts.length === 0,
            open_shifts: openShifts,
            documents: normalizedDocuments,
            z_document: normalizedDocuments.find(row => row.report_type === 'z_audit') || null,
        });
    } catch (err) {
        logAdminRouteError(req, err);
        return sendError(res, 500, 'Failed to load audit report status.');
    }
});

router.post('/audit-reports/print', async (req, res) => {
    const reportType = normalizeReportType(req.body.report_type);
    const businessDate = normalizeBusinessDate(req.body.business_date || req.body.date);

    if (!reportType) return sendError(res, 400, 'Invalid report type.');
    if (!businessDate) return sendError(res, 400, 'Invalid business date.');

    try {
        const printer = await resolveReportPrinter(req);
        if (reportType === 'z_audit') {
            const [existing] = await pool.query(`
                SELECT * FROM audit_report_documents
                WHERE report_type = 'z_audit' AND z_business_date_lock = ? AND status = 'issued'
                LIMIT 1
            `, [businessDate]);

            if (existing.length > 0) {
                const printPayload = await prepareAuditPayload(req, existing[0], 'reprint', printer);
                return res.json({
                    success: true,
                    print_queued: Boolean(printer),
                    document: documentResponse(existing[0], true),
                    print_payload: printPayload,
                    message: printer ? 'Z audit report queued.' : 'Z audit report prepared for browser preview.'
                });
            }

            const openShifts = await getOpenShiftsForBusinessDate(pool, businessDate);
            if (openShifts.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: 'Close all shifts before issuing the official Z audit report.',
                    open_shifts: openShifts,
                });
            }
        }

        const conn = await pool.getConnection();
        let insertedDocument;
        const lockName = `audit_report_serial_${reportType}`;
        try {
            const [[lockRow]] = await conn.query('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
            if (!lockRow.acquired) throw new Error('Could not acquire serial lock. Try again.');

            try {
                await conn.beginTransaction();

                const [[maxRow]] = await conn.query(
                    'SELECT COALESCE(MAX(serial_no), 0) AS max_serial FROM audit_report_documents WHERE report_type = ?',
                    [reportType]
                );
                const serialNo = Number(maxRow.max_serial) + 1;
                const serialLabel = `${SERIAL_PREFIX[reportType]}-${serialNo}`;
                const range = getBusinessDayRange(businessDate);
                const payload = await buildAuditReportPayload(conn, {
                    reportType,
                    businessDate,
                    serialLabel,
                    generatedByUser: req.user,
                });

                const [insertResult] = await conn.query(`
                    INSERT INTO audit_report_documents (
                        report_type, serial_no, serial_label, business_date, business_start_at,
                        business_end_at, z_business_date_lock, payload_json, payload_hash, issued_by_user_id,
                        last_print_status, last_printed_at, last_printed_by_user_id, reprint_count
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP, ?, 0)
                `, [
                    reportType,
                    serialNo,
                    serialLabel,
                    businessDate,
                    range.start,
                    range.end,
                    reportType === 'z_audit' ? businessDate : null,
                    JSON.stringify(payload),
                    payload.payload_hash,
                    req.user.id,
                    req.user.id,
                ]);

                await conn.commit();

                insertedDocument = {
                    id: insertResult.insertId,
                    report_type: reportType,
                    serial_no: serialNo,
                    serial_label: serialLabel,
                    business_date: businessDate,
                    payload_json: payload,
                    payload_hash: payload.payload_hash,
                };
            } catch (err) {
                await conn.rollback();
                throw err;
            } finally {
                await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
            }
        } finally {
            conn.release();
        }

        const printPayload = await prepareAuditPayload(req, insertedDocument, 'original', printer);
        return res.json({
            success: true,
            document: documentResponse(insertedDocument, false),
            print_queued: Boolean(printer),
            print_payload: printPayload,
            message: printer ? `${insertedDocument.serial_label} audit report queued.` : `${insertedDocument.serial_label} audit report prepared for browser preview.`
        });
    } catch (err) {
        logAdminRouteError(req, err);
        const statusCode = err.statusCode || 500;
        return sendError(res, statusCode, err.message || 'Failed to print audit report.');
    }
});

router.post('/audit-reports/print-period', async (req, res) => {
    const startDate = normalizeDateOnly(req.body.start_date);
    const endDate = normalizeDateOnly(req.body.end_date);

    if (!startDate) return sendError(res, 400, 'Invalid start date.');
    if (!endDate) return sendError(res, 400, 'Invalid end date.');
    if (endDate < startDate) return sendError(res, 400, 'End date must be on or after start date.');
    if (daysBetween(startDate, endDate) > MAX_PERIOD_DAYS) {
        return sendError(res, 400, `Period cannot exceed ${MAX_PERIOD_DAYS} days.`);
    }

    try {
        const printer = await resolveReportPrinter(req);
        const payload = await buildAuditReportPayload(pool, {
            startDate,
            endDate,
            generatedByUser: req.user,
        });

        await queueReport(printer, payload);
        return res.json({ success: true, print_queued: Boolean(printer), print_payload: payload, message: 'Period report prepared.' });
    } catch (err) {
        logAdminRouteError(req, err);
        const statusCode = err.statusCode || 500;
        return sendError(res, statusCode, err.message || 'Failed to print periodical report.');
    }
});

router.post('/audit-reports/print-items', async (req, res) => {
    const businessDate = req.body.business_date ? normalizeBusinessDate(req.body.business_date) : null;
    const startDate = req.body.start_date ? normalizeDateOnly(req.body.start_date) : null;
    const endDate = req.body.end_date ? normalizeDateOnly(req.body.end_date) : null;

    if (!businessDate && !startDate) {
        return sendError(res, 400, 'Provide either business_date or start_date/end_date.');
    }
    if (startDate) {
        if (!endDate) return sendError(res, 400, 'Invalid end date.');
        if (endDate < startDate) return sendError(res, 400, 'End date must be on or after start date.');
        if (daysBetween(startDate, endDate) > MAX_PERIOD_DAYS) {
            return sendError(res, 400, `Period cannot exceed ${MAX_PERIOD_DAYS} days.`);
        }
    }

    try {
        const printer = await resolveReportPrinter(req);
        const payload = await buildCategoryItemsReportPayload(pool, {
            businessDate: startDate ? null : businessDate,
            startDate: startDate || null,
            endDate: endDate || null,
            generatedByUser: req.user,
        });

        await queueReport(printer, payload);
        return res.json({ success: true, print_queued: Boolean(printer), print_payload: payload, message: 'Items report prepared.' });
    } catch (err) {
        logAdminRouteError(req, err);
        const statusCode = err.statusCode || 500;
        return sendError(res, statusCode, err.message || 'Failed to print items report.');
    }
});

router.post('/audit-reports/print-y', async (req, res) => {
    const businessDate = req.body.business_date ? normalizeBusinessDate(req.body.business_date) : null;
    const startDate = req.body.start_date ? normalizeDateOnly(req.body.start_date) : null;
    const endDate = req.body.end_date ? normalizeDateOnly(req.body.end_date) : null;

    if (!businessDate && !startDate) {
        return sendError(res, 400, 'Provide either business_date or start_date/end_date.');
    }
    if (startDate) {
        if (!endDate) return sendError(res, 400, 'Invalid end date.');
        if (endDate < startDate) return sendError(res, 400, 'End date must be on or after start date.');
        if (daysBetween(startDate, endDate) > MAX_PERIOD_DAYS) {
            return sendError(res, 400, `Period cannot exceed ${MAX_PERIOD_DAYS} days.`);
        }
    }

    let conn;
    let committed = false;
    try {
        const printer = await resolveReportPrinter(req);
        const range = startDate
            ? getBusinessDateRange(startDate, endDate)
            : getBusinessDayRange(businessDate);
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const yOrderTypeId = await getConfiguredYOrderTypeId(conn);
        const [heldRows] = await conn.query(
            `SELECT id, user_id, order_id, order_seq_scope, reference_name, cart_data, subtotal, kitchen_fired,
                    service_charge_snapshot_id, parent_invoice_id, table_id, call_center_user_id, created_at,
                    version, kitchen_snapshot, kitchen_dispatch_version,
                    claimed_by_user_id, claim_expires_at
               FROM held_orders
             WHERE created_at >= ? AND created_at < ?
               AND CASE WHEN JSON_VALID(cart_data)
                    THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(cart_data, '$.order_type_id')) AS UNSIGNED)
                    ELSE NULL END = ?
             ORDER BY id ASC
             FOR UPDATE`,
            [range.start, range.end, yOrderTypeId]
        );
        if (heldRows.length === 0) {
            const error = new Error('No Y held orders found for this report.');
            error.statusCode = 404;
            throw error;
        }
        const now = Date.now();
        if (heldRows.some(row => row.claimed_by_user_id != null && row.claim_expires_at && new Date(row.claim_expires_at).getTime() > now)) {
            const error = new Error('An active held-order edit must be released before the Y report can archive it.');
            error.statusCode = 409;
            error.publicCode = 'HELD_IN_USE';
            throw error;
        }
        const safeHeldRows = heldRows.map((row) => {
            const { claimed_by_user_id, claim_expires_at, ...safe } = row;
            return safe;
        });

        const payload = await buildYHeldItemsReportPayload(conn, {
            businessDate: startDate ? null : businessDate,
            startDate: startDate || null,
            endDate: endDate || null,
            generatedByUser: req.user,
            heldRows: safeHeldRows,
        });
        const [archive] = await conn.query(
            `INSERT INTO master_held
                (business_start_at, business_end_at, report_payload, held_orders_payload,
                 generated_by_user_id, expires_at)
             VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
            [
                range.start,
                range.end,
                JSON.stringify(payload),
                 JSON.stringify(safeHeldRows),
                req.user?.id || null,
            ]
        );
        const ids = heldRows.map(row => Number(row.id));
        const placeholders = ids.map(() => '?').join(',');
        const [removed] = await conn.query(`DELETE FROM held_orders WHERE id IN (${placeholders})`, ids);
        if (Number(removed.affectedRows) !== heldRows.length) {
            const error = new Error('Y held orders changed while preparing the report. Try again.');
            error.statusCode = 409;
            throw error;
        }
        await queueReport(printer, payload, conn);
        await conn.commit();
        committed = true;

        if (printer) safePublishSpoolerSyncWake();

        emitHeldOrdersChanged(req.io, 'cleared');

        return res.json({
            success: true,
            message: 'Y report prepared.',
            print_queued: Boolean(printer),
            archive_id: Number(archive.insertId),
            removed_count: heldRows.length,
            print_payload: payload,
        });
    } catch (err) {
        if (conn && !committed) {
            try { await conn.rollback(); } catch (_) {}
        }
        logAdminRouteError(req, err);
        const statusCode = err.statusCode || 500;
        return sendError(res, statusCode, err.message || 'Failed to print Y report.');
    } finally {
        if (conn) conn.release();
    }
});

async function printYArchive(req, res) {
    const archiveId = Number(req.params.id);
    if (!Number.isSafeInteger(archiveId) || archiveId <= 0) {
        return sendError(res, 400, 'Invalid Y archive.');
    }

    try {
        const printer = req.method === 'POST' ? await resolveReportPrinter(req) : null;
        const [[archive]] = await pool.query(
            `SELECT report_payload, expires_at, restored_at
             FROM master_held
             WHERE id = ?`,
            [archiveId]
        );
        if (!archive) return sendError(res, 404, 'Y recovery snapshot not found.');
        if (archive.restored_at) return sendError(res, 409, 'This Y report was already restored.');
        if (new Date(archive.expires_at).getTime() <= Date.now()) {
            return sendError(res, 410, 'This Y recovery snapshot has expired.');
        }
        const payload = assertBrowserSafePayload(normalizePayloadJson(archive.report_payload));
        await queueReport(printer, payload);
        return res.json({
            success: true,
            print_queued: Boolean(printer),
            print_payload: payload,
        });
    } catch (err) {
        logAdminRouteError(req, err);
        return sendError(res, err.statusCode || 500, err.message || 'Failed to reopen the Y report.');
    }
}
router.get('/audit-reports/y-archives/:id/print-payload', printYArchive);
router.post('/audit-reports/y-archives/:id/print', printYArchive);

router.get('/audit-reports/y-archive-status', async (req, res) => {
    try {
        await cleanupExpiredYHeldReportArchives(pool);
        const [[archive]] = await pool.query(
            `SELECT id, report_payload, created_at, expires_at
             FROM master_held
             WHERE restored_at IS NULL AND expires_at > NOW()
             ORDER BY id DESC
             LIMIT 1`
        );
        if (!archive) return res.json({ success: true, archive: null });
        const payload = normalizePayloadJson(archive.report_payload);
        return res.json({
            success: true,
            archive: {
                id: Number(archive.id),
                order_count: Number(payload.summary?.order_count || 0),
                created_at: archive.created_at,
                expires_at: archive.expires_at,
            },
        });
    } catch (err) {
        logAdminRouteError(req, err);
        return sendError(res, 500, 'Failed to load the Y recovery snapshot.');
    }
});

router.post('/audit-reports/restore-y', async (req, res) => {
    const archiveId = Number(req.body.archive_id);
    if (!Number.isSafeInteger(archiveId) || archiveId <= 0) {
        return sendError(res, 400, 'Invalid Y archive.');
    }

    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        // Restored carts must not appear inside an activation's held-order scan.
        await conn.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled' LOCK IN SHARE MODE");
        const [[archive]] = await conn.query(
            'SELECT * FROM master_held WHERE id = ? FOR UPDATE',
            [archiveId]
        );
        if (!archive) {
            await conn.rollback();
            return sendError(res, 404, 'Y recovery snapshot not found.');
        }
        if (archive.restored_at) {
            await conn.rollback();
            return sendError(res, 409, 'This Y report was already restored.');
        }
        if (new Date(archive.expires_at).getTime() <= Date.now()) {
            await cleanupExpiredYHeldReportArchives(conn);
            await conn.commit();
            return sendError(res, 410, 'This Y recovery snapshot has expired.');
        }

        const heldRows = normalizePayloadJson(archive.held_orders_payload);
        if (!Array.isArray(heldRows) || heldRows.length === 0) {
            const error = new Error('The Y recovery snapshot is invalid.');
            error.statusCode = 422;
            throw error;
        }
        const values = heldRows.map(row => [
            Number(row.id),
            Number(row.user_id),
            row.order_id ?? null,
            row.order_seq_scope ?? null,
            row.reference_name,
            typeof row.cart_data === 'string' ? row.cart_data : JSON.stringify(row.cart_data),
            row.subtotal,
            Number(row.kitchen_fired || 0),
            row.service_charge_snapshot_id || null,
            row.parent_invoice_id || null,
            row.table_id || null,
            row.call_center_user_id || null,
            new Date(row.created_at),
            Number(row.version || 1) + 1,
            null,
            null,
            null,
            null,
            new Date(),
            row.kitchen_snapshot || null,
            Number(row.kitchen_dispatch_version || 0),
            null,
            null,
            null,
        ]);
        await conn.query(
            `INSERT INTO held_orders
                (id, user_id, order_id, order_seq_scope, reference_name, cart_data, subtotal, kitchen_fired,
                 service_charge_snapshot_id, parent_invoice_id, table_id, call_center_user_id, created_at,
                 version, hold_request_id,
                 claimed_by_user_id, claim_token_hash, claim_expires_at, updated_at,
                 kitchen_snapshot, kitchen_dispatch_version, last_operation_id,
                 last_operation_kind, last_operation_result)
             VALUES ?`,
            [values]
        );
        await conn.query(
            'UPDATE master_held SET restored_at = NOW() WHERE id = ?',
            [archiveId]
        );
        await conn.commit();
        emitHeldOrdersChanged(req.io, 'cleared');
        return res.json({
            success: true,
            message: 'Y held orders restored.',
            restored_count: heldRows.length,
        });
    } catch (err) {
        if (conn) {
            try { await conn.rollback(); } catch (_) {}
        }
        if (err.code === 'ER_DUP_ENTRY') {
            return sendError(res, 409, 'Some Y held orders already exist; nothing was restored.');
        }
        logAdminRouteError(req, err);
        return sendError(res, err.statusCode || 500, err.message || 'Failed to restore Y held orders.');
    } finally {
        if (conn) conn.release();
    }
});

module.exports = router;
