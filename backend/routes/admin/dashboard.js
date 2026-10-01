const { availabilitySql } = require('../../services/StockProductAdapter');
const express = require('express');
const router = express.Router();
const {
    pool,
    sendSuccess,
    sendError,
    logAdminRouteError,
    getDashboardAnalyticsCache,
    getDashboardCacheGeneration,
    setDashboardAnalyticsCache,
} = require('./helpers');
const { getBusinessDate } = require('../../utils/businessDate');
const { buildDashboardData } = require('../../services/dashboardDataBuilder');
const { getSettings } = require('../../config/settingsHelper');

const DASHBOARD_ANALYTICS_CACHE_TTL_MS = 30 * 1000;

// GET /api/admin/alerts
router.get('/alerts', async (req, res) => {
    try {
        const settings = await getSettings(pool, [
            'stock_enabled',
            'low_stock_threshold'
        ]);
        const stockEnabled = settings.stock_enabled === '1';
        const rawThreshold = settings.low_stock_threshold;
        const parsedThreshold = rawThreshold != null
            && String(rawThreshold).trim() !== ''
            ? Number(rawThreshold)
            : Number.NaN;
        const threshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 0
            ? parsedThreshold
            : 3;

        let lowStockItems = [];
        if (stockEnabled) {
            const [rows] = await pool.query(
                `SELECT p.id,p.name,${availabilitySql('p')} AS stock FROM products p WHERE p.is_active=1 HAVING stock IS NOT NULL AND stock <= ? ORDER BY stock ASC`,
                [threshold]
            );
            lowStockItems = rows;
        }
        return sendSuccess(res, { lowStockItems });
    } catch (error) {
        logAdminRouteError(req, error);
        return sendError(res, 500, 'Database error');
    }
});

// GET /api/admin/dashboard
router.get('/dashboard', async (req, res) => {
    try {
        const now = new Date();
        const cacheKey = `${getBusinessDate(now)}:${Math.floor(now.getTime() / 60000)}`;
        const cached = getDashboardAnalyticsCache(cacheKey);
        if (cached && cached.expiresAt > now.getTime()) {
            return sendSuccess(res, cached.payload);
        }

        const buildGeneration = getDashboardCacheGeneration();
        const payload = await buildDashboardData(pool, { now });
        setDashboardAnalyticsCache(
            cacheKey,
            payload,
            now.getTime() + DASHBOARD_ANALYTICS_CACHE_TTL_MS,
            buildGeneration
        );
        return sendSuccess(res, payload);
    } catch (error) {
        logAdminRouteError(req, error);
        return sendError(res, 500, 'Dashboard data fetch failed.');
    }
});

module.exports = router;
