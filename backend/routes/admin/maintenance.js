const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { pool, sendSuccess, sendError, logAdminRouteError, invalidateDashboardCache, invalidateCatalogCache, triggerStaticMenuGeneration } = require('./helpers');
const { resetOperationalData } = require('../../services/operationalDataReset');
const { factoryReset } = require('../../services/factoryReset');
const { refreshFailedPrintJobsCount } = require('../../services/printQueueWatchdog');
const { emitHeldOrdersChanged } = require('../../services/HeldOrderEvents');

const DEFAULT_PASSWORD_HASH = 'd11f7959eb14c240009f427cff3020b913e9d7d02b123d7f0388bee391d3640a';

function validMaintenancePassword(password) {
    const expectedHex = process.env.MAINTENANCE_RESET_PASSWORD_HASH || DEFAULT_PASSWORD_HASH;
    if (!/^[a-f\d]{64}$/i.test(expectedHex)) return false;
    const supplied = crypto.createHash('sha256').update(String(password || '')).digest();
    return crypto.timingSafeEqual(supplied, Buffer.from(expectedHex, 'hex'));
}

function announceReset(req) {
    invalidateDashboardCache();
    invalidateCatalogCache(); // The reset changes catalog visibility.
    req.io?.to('staff').emit('inventory_changed');
    emitHeldOrdersChanged(req.io, 'cleared');
    req.io?.to('staff').emit('table_update', { action: 'refresh_tables' });
    req.io?.to('staff').emit('jofotara_operations_changed', { action: 'reset' });
}

async function refreshPrintState(req) {
    // The reset emptied print_queue behind the in-memory badge count and stale-station
    // cache. Refresh both now; a stale read that started earlier is dropped by the runner.
    const watchdog = req.app.get('printQueueWatchdog');
    watchdog?.wake();
    const refreshes = await Promise.allSettled([
        watchdog?.refreshStale?.(),
        refreshFailedPrintJobsCount(pool, count => req.io?.to('staff').emit('failed_print_jobs_count', count))
    ]);
    for (const r of refreshes) if (r.status === 'rejected') logAdminRouteError(req, r.reason);
}

function resetRoute(reset, { successMessage, failureMessage, afterCommit = () => {} }) {
    return async (req, res) => {
        if (!validMaintenancePassword(req.body?.password)) {
            return sendError(res, 403, 'Invalid maintenance password.');
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const summary = await reset(conn, {
                userId: req.user?.id || null,
                ipAddress: req.ip || null
            });
            await conn.commit();

            announceReset(req);
            afterCommit(req);
            await refreshPrintState(req);

            return sendSuccess(res, { message: successMessage, summary });
        } catch (error) {
            await conn.rollback();
            if (!error.statusCode) logAdminRouteError(req, error);
            return sendError(res, error.statusCode || 500, error.statusCode ? error.message : failureMessage);
        } finally {
            conn.release();
        }
    };
}

router.post('/maintenance/reset-operational-data', resetRoute(resetOperationalData, {
    successMessage: 'Operational data was reset.',
    failureMessage: 'Unable to reset operational data.'
}));

router.post('/maintenance/factory-reset', resetRoute(factoryReset, {
    successMessage: 'The system was reset to a fresh start.',
    failureMessage: 'Unable to reset the system.',
    afterCommit: (req) => {
        req.io?.to('staff').emit('ingredients_changed');
        triggerStaticMenuGeneration();
    }
}));

module.exports = router;
