const express = require('express');
const router = express.Router();
const { requireAuth, rejectCallCenterRole } = require('../../middleware/auth');
const { canApplyServiceCharge } = require('../../services/PermissionService');
const pool = require('../../config/db');
const { getSettings } = require('../../config/settingsHelper');
const { sendPosSuccess: sendSuccess } = require('../../http/jsonResponse');
const { createDraft, abandonDraft, consumeClaim } = require('../../services/ServiceChargeSnapshotService');

const sendSnapshotError = (res, error) => {
    const status = error.statusCode || 500;
    return res.status(status).json({
        success: false,
        message: status === 500 ? 'Operation failed. Please try again.' : error.message,
        ...(error.publicCode ? { code: error.publicCode } : {})
    });
};

router.post('/service_charge_snapshots', requireAuth, rejectCallCenterRole, async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const settings = await getSettings(conn, [
            'tables_enabled',
            'service_charge_enabled',
            'service_charge_percentage',
            'service_charge_tax_rate',
            'service_charge_jofotara_tax_category',
            'auto_apply_service_charge'
        ]);
        if (settings.service_charge_enabled !== '1') {
            await conn.rollback();
            return res.status(403).json({ success: false, message: 'Service charge is disabled.' });
        }
        const automaticTableRequest = req.body?.auto_table === true || req.body?.auto_table === '1';
        if (automaticTableRequest) {
            if (settings.tables_enabled !== '1' || settings.auto_apply_service_charge !== '1') {
                await conn.rollback();
                return res.status(403).json({ success: false, message: 'Automatic table service charge is disabled.' });
            }
            const tableId = Number(req.body?.table_id);
            if (!Number.isInteger(tableId) || tableId <= 0) {
                await conn.rollback();
                return res.status(400).json({ success: false, message: 'A valid table is required.' });
            }
            const [[table]] = await conn.query('SELECT id FROM restaurant_tables WHERE id=? LIMIT 1', [tableId]);
            if (!table) {
                await conn.rollback();
                return res.status(404).json({ success: false, message: 'Table not found.' });
            }
        } else if (!canApplyServiceCharge(req.user)) {
            await conn.rollback();
            return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to apply a service charge.' });
        }
        const snapshot = await createDraft(conn, {
            userId: req.user.id,
            percentage: settings.service_charge_percentage,
            taxRate: settings.service_charge_tax_rate,
            taxCategory: settings.service_charge_jofotara_tax_category
        });
        await conn.commit();
        return sendSuccess(res, { snapshot });
    } catch (error) {
        if (conn) await conn.rollback();
        return sendSnapshotError(res, error);
    } finally {
        if (conn) conn.release();
    }
});

router.delete('/service_charge_snapshots/:id', requireAuth, rejectCallCenterRole, async (req, res) => {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const version = Number(req.body?.version ?? req.query?.version);
        const claimToken = req.body?.claim_token || null;
        // A claim (restored hold) abandons through its one-time token; a plain draft through
        // creator/version. Both end 'abandoned' so the register clearing an order never strands
        // a claimed snapshot for the time-based reaper to break later.
        const nextVersion = claimToken
            ? await consumeClaim(conn, {
                snapshotId: req.params.id,
                version,
                claimToken,
                userId: req.user.id,
                to: 'abandoned',
                holderType: 'none',
                holderId: null
            })
            : await abandonDraft(conn, {
                snapshotId: req.params.id,
                version,
                userId: req.user.id
            });
        await conn.commit();
        return sendSuccess(res, { version: nextVersion });
    } catch (error) {
        if (conn) await conn.rollback();
        return sendSnapshotError(res, error);
    } finally {
        if (conn) conn.release();
    }
});

module.exports = router;
