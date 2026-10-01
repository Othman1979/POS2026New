const express = require('express');
const router = express.Router();
const { pool, sendSuccess, sendError, logAdminRouteError, invalidateCatalogCache, emitInventoryChanged } = require('./helpers');

// GET /api/admin/products/:id/bundle-items
router.get('/products/:id/bundle-items', async (req, res) => {
    try {
        const bundleId = parseInt(req.params.id, 10);
        if (!Number.isInteger(bundleId)) return sendError(res, 400, 'Invalid product id.');

        const [items] = await pool.query(`
            SELECT pbi.product_id, pbi.qty, pbi.sort_order,
                   p.name, p.price, p.tax_rate, p.category_id, p.modifiers
            FROM product_bundle_items pbi
            JOIN products p ON pbi.product_id = p.id
            WHERE pbi.bundle_id = ?
            ORDER BY pbi.sort_order ASC, pbi.id ASC
        `, [bundleId]);

        return sendSuccess(res, { items });
    } catch (e) {
        logAdminRouteError(req, e);
        return sendError(res, 500, e.message);
    }
});

// PUT /api/admin/products/:id/bundle-items — full replace
router.put('/products/:id/bundle-items', async (req, res) => {
    const bundleId = parseInt(req.params.id, 10);
    if (!Number.isInteger(bundleId)) return sendError(res, 400, 'Invalid product id.');

    const items = Array.isArray(req.body.items) ? req.body.items : [];

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        // Ingredient activation checks held bundle compositions under this fence.
        await conn.query("SELECT setting_value FROM settings WHERE setting_key='stock_enabled' LOCK IN SHARE MODE");

        const [[bundle]] = await conn.query("SELECT id, is_bundle FROM products WHERE id = ?", [bundleId]);
        if (!bundle) {
            await conn.rollback();
            return sendError(res, 404, 'Product not found.');
        }
        if (Number(bundle.is_bundle) !== 1) {
            await conn.rollback();
            return sendError(res, 400, 'This product is not a bundle.');
        }

        // Validate every sub-item exists and is NOT itself a bundle (one level deep only).
        const normalized = [];
        for (let i = 0; i < items.length; i++) {
            const productId = parseInt(items[i].product_id, 10);
            const qty = Number(items[i].qty);
            const sortOrder = Number.isInteger(parseInt(items[i].sort_order, 10)) ? parseInt(items[i].sort_order, 10) : i;
            if (!Number.isInteger(productId)) {
                await conn.rollback();
                return sendError(res, 400, `Invalid sub-item product id on row ${i + 1}.`);
            }
            if (productId === bundleId) {
                await conn.rollback();
                return sendError(res, 400, 'A bundle cannot contain itself.');
            }
            const [[sub]] = await conn.query("SELECT id, is_bundle FROM products WHERE id = ?", [productId]);
            if (!sub) {
                await conn.rollback();
                return sendError(res, 400, `Sub-item product ${productId} does not exist.`);
            }
            if (Number(sub.is_bundle) === 1) {
                await conn.rollback();
                return sendError(res, 400, 'A bundle cannot contain another bundle.');
            }
            normalized.push([bundleId, productId, Number.isFinite(qty) && qty > 0 ? qty : 1, sortOrder]);
        }

        await conn.query("DELETE FROM product_bundle_items WHERE bundle_id = ?", [bundleId]);
        if (normalized.length > 0) {
            await conn.query(
                "INSERT INTO product_bundle_items (bundle_id, product_id, qty, sort_order) VALUES ?",
                [normalized]
            );
        }

        await conn.commit();
        invalidateCatalogCache();
        emitInventoryChanged(req, [bundleId]);
        return sendSuccess(res, { message: 'Bundle items saved.' });
    } catch (e) {
        await conn.rollback();
        logAdminRouteError(req, e);
        return sendError(res, 500, e.message);
    } finally {
        conn.release();
    }
});

module.exports = router;
