const express = require('express');
const router = express.Router();
const {
    pool, sendSuccess, sendError, logAdminRouteError, invalidateCatalogCache, invalidateDashboardCache,
    triggerStaticMenuGeneration, emitInventoryChanged
} = require('./helpers');
const { getConnection: getStockConnection } = require('../../services/StockReportInvalidation');
const productPacks = require('../../services/ProductPacks');
const productBarcodes = require('../../services/productBarcodes');

// GET /api/admin/products/:id/packs
router.get('/products/:id/packs', async (req, res) => {
    try {
        return sendSuccess(res, { packs: await productPacks.list(pool, req.params.id) });
    } catch (error) {
        if (error.statusCode) return sendError(res, error.statusCode, error.message);
        logAdminRouteError(req, error);
        return sendError(res, 500, 'Unable to load the packs.');
    }
});

// PUT /api/admin/products/:id/packs — full replace: { packs: [{ label, factor, sale_price, barcode }] }
router.put('/products/:id/packs', async (req, res) => {
    try {
        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
            const conn = await getStockConnection(pool);
            try {
                // Selling a pack may enable the product's stock movements, which needs READ COMMITTED.
                await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
                await conn.beginTransaction();
                result = await productPacks.replace(conn, req.params.id, req.body?.packs, req.user.id, req.ip || null);
                await conn.commit();
                break;
            } catch (error) {
                await conn.rollback();
                if (error.code === 'ER_LOCK_DEADLOCK' && attempt < 2) continue;
                throw productBarcodes.asBarcodeConflict(error);
            } finally {
                conn.release();
            }
        }
        invalidateCatalogCache();
        invalidateDashboardCache();
        triggerStaticMenuGeneration();
        emitInventoryChanged(req, result.product_ids);
        return sendSuccess(res, { packs: result.packs });
    } catch (error) {
        if (error.statusCode) return sendError(res, error.statusCode, error.message, error.publicCode);
        logAdminRouteError(req, error);
        return sendError(res, 500, 'Unable to save the packs.');
    }
});

module.exports = router;
