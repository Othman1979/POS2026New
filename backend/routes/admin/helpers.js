const pool = require('../../config/db');
const logger = require('../../config/logger');
const {
    invalidateCatalogCache,
    getDashboardAnalyticsCache,
    getDashboardCacheGeneration,
    setDashboardAnalyticsCache,
    invalidateDashboardCache
} = require('../../config/cache');
const { triggerStaticMenuGeneration } = require('../../config/menuCache');
const { requireAuth, requireAdmin, invalidateUserSessions } = require('../../middleware/auth');
const financialSql = require('../../services/financialSql');
const { sendAdminError: sendError, sendAdminSuccess: sendSuccess } = require('../../http/jsonResponse');

const logAdminRouteError = (req, err) => {
    logger.error({
        err,
        route: req.originalUrl,
        method: req.method,
        userId: req.user?.id,
        role: req.user?.role
    }, 'Admin route failed.');
};

function parsePagination(query) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;
    return { page, limit, offset };
}

function catalogScopeProductIds(productIds) {
    if (!Array.isArray(productIds) || productIds.length === 0) return null;
    const ids = new Set();
    for (const value of productIds) {
        if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
        const id = Number(value);
        if (!Number.isInteger(id) || id <= 0) return null;
        ids.add(id);
    }
    return [...ids];
}

function emitInventoryChanged(req, productIds) {
    if (!req.io) return;
    const ids = catalogScopeProductIds(productIds);
    if (ids) req.io.to('staff').emit('inventory_changed', { scope: 'catalog', productIds: ids });
    else req.io.to('staff').emit('inventory_changed');
}

// Stock balances changed but no product row, price or category did: POS terminals revalidate rows only.
function emitStockChanged(req) {
    if (!req.io) return;
    req.io.to('staff').emit('inventory_changed', { scope: 'stock' });
}

module.exports = {
    pool,
    logger,
    invalidateCatalogCache,
    getDashboardAnalyticsCache,
    getDashboardCacheGeneration,
    setDashboardAnalyticsCache,
    invalidateDashboardCache,
    triggerStaticMenuGeneration,
    requireAuth,
    requireAdmin,
    invalidateUserSessions,
    sendError,
    sendSuccess,
    logAdminRouteError,
    parsePagination,
    catalogScopeProductIds,
    emitInventoryChanged,
    emitStockChanged,
    ...financialSql
};
