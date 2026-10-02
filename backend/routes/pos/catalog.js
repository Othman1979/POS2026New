const { availabilitySql } = require('../../services/StockProductAdapter');
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const {
    getCachedCatalog,
    getCachedCatalogEtag,
    getCatalogCacheGeneration,
    getCatalogGenerationToken,
    beginCatalogBuild,
    setCachedCatalog,
    invalidateCatalogCache
} = require('../../config/cache');
const pool = require('../../config/db');
const crypto = require('crypto');
const logger = require('../../config/logger');
const { getSettings, POS_CATALOG_SETTING_KEYS } = require('../../config/settingsHelper');
const packageInfo = require('../../../package.json');
const { sendPosError: sendError, sendPosSuccess: sendSuccess } = require('../../http/jsonResponse');
const { generateStaticMenu } = require('../../config/menuCache');
const { PERMISSIONS, userHas, isCallCenterRole } = require('../../services/PermissionService');
const { normalizeCustomerPhone, redactCustomerPhone } = require('../../services/customerPhone');
const { appendAuditEvent } = require('../../services/auditEvents');
const { attachRegisterPrices } = require('../../services/categoryPriceLists');
const { decodeScaleBarcode } = require('../../services/scaleBarcode');
const { OWNER_IDS_SQL, EXTRA_OWNER_IDS_SQL } = require('../../services/productBarcodes');
const APP_VERSION = packageInfo.version || '0.0.0';

const createCatalogEtag = (payloadString) => `"${crypto.createHash('md5').update(payloadString).digest('hex')}"`;
const setCatalogCacheHeaders = (res, etag) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);
};

const parseSalesContext = (value) => {
    const context = String(value || 'register').trim().toLowerCase();
    return context === 'register' || context === 'table' ? context : null;
};

const presentCatalogProduct = (product) => {
    product.base_price = Number(product.base_price ?? product.price);
    product.price = Number(product.effective_price ?? product.price);
    product.price_list_root_id = product.price_list_root_id ?? null;
    product.price_list_root_name = product.price_list_root_name ?? null;
    product.has_price_override = Number(product.has_price_override) || 0;
    product.price_override_locked = Number(product.price_override_locked) || 0;
    delete product.effective_price;
    delete product.product_id;
    return product;
};

// GET /api/pos/products
router.get('/products', requireAuth, async (req, res) => {
    let catalogBuild = null;
    try {
        const salesContext = parseSalesContext(req.query.sales_context);
        if (!salesContext) return sendError(res, 400, 'Invalid sales context.');
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 120, 1), 300);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const search = String(req.query.search || '').trim();
        const toPosIntOrNull = (v) => {
            const n = parseInt(v, 10);
            return Number.isInteger(n) && n > 0 ? n : null;
        };
        const categoryId = toPosIntOrNull(req.query.category_id);
        const subcategoryId = toPosIntOrNull(req.query.subcategory_id);
        // Exact-id read (QR import): the listed products only, no category work.
        let productIds = null;
        if (req.query.product_ids !== undefined) {
            const parts = typeof req.query.product_ids === 'string' ? req.query.product_ids.split(',') : [];
            if (parts.length === 0 || !parts.every(part => /^[1-9]\d{0,9}$/.test(part.trim()))) {
                return sendError(res, 400, 'Invalid product ids.');
            }
            productIds = [...new Set(parts.map(Number))];
            if (productIds.length > 300) return sendError(res, 400, 'Too many product ids.');
        }
        const isLightweight = Boolean(productIds) || req.query.lightweight === '1' || req.query.lightweight === 'true';

        // Cache hits only for standard root load (no active search/filters) to keep memory footprint simple
        const isCacheable = salesContext === 'register' && !isLightweight && !search && !categoryId && !subcategoryId && offset === 0 && limit === 120;
        const categoryContextSql = salesContext === 'table'
            ? ' AND c.price_list_root_id IS NULL'
            : ` AND NOT EXISTS (
                SELECT 1 FROM categories inactive_root
                WHERE inactive_root.id = c.price_list_root_id
                  AND inactive_root.price_list_root_id = inactive_root.id
                  AND inactive_root.is_active <> 1
            )`;
        const productContextSql = salesContext === 'table'
            ? ' AND (p.category_id IS NULL OR c.price_list_root_id IS NULL)'
            : ` AND NOT EXISTS (
                SELECT 1 FROM categories inactive_root
                WHERE inactive_root.id = c.price_list_root_id
                  AND inactive_root.price_list_root_id = inactive_root.id
                  AND inactive_root.is_active <> 1
            )`;

        // The grid leaves out categories kept off the POS screen (or under a parent that is) and the sale
        // entries of packs; both still sell by barcode and search.
        const visibleCategoryCondition = `COALESCE(c.hide_in_pos, 0) = 0 AND NOT EXISTS (
                SELECT 1 FROM categories hidden_parent
                WHERE hidden_parent.id = c.parent_id AND hidden_parent.hide_in_pos = 1
            )`;
        const gridProductCondition = `(p.category_id IS NULL OR (${visibleCategoryCondition}))
            AND NOT EXISTS (SELECT 1 FROM product_packs sale_pack WHERE sale_pack.sale_product_id = p.id)`;
        const gridCategorySql = ` AND ${visibleCategoryCondition}`;
        const gridProductSql = ` AND ${gridProductCondition}`;

        // A committed catalog mutation can invalidate a cold read while its queries
        // are still in flight. Retry that read under the new generation so neither
        // the owner nor callers sharing its promise receive a stale snapshot.
        const maxCatalogBuildAttempts = isCacheable ? 2 : 1;
        for (let catalogBuildAttempt = 0; catalogBuildAttempt < maxCatalogBuildAttempts; catalogBuildAttempt += 1) {
        const cacheGeneration = getCatalogCacheGeneration();
        catalogBuild = null;

        if (isCacheable) {
            const cachedPayload = getCachedCatalog();
            const cachedEtag = getCachedCatalogEtag();
            if (cachedPayload && cachedEtag) {
                setCatalogCacheHeaders(res, cachedEtag);
                if (req.headers['if-none-match'] === cachedEtag) {
                    return res.status(304).send();
                }
                return res.status(200).json(cachedPayload);
            }

            catalogBuild = beginCatalogBuild(cacheGeneration);
            if (!catalogBuild.owner) {
                const sharedBuild = await catalogBuild.promise;
                if (sharedBuild.invalidated) {
                    catalogBuild = null;
                    if (catalogBuildAttempt + 1 < maxCatalogBuildAttempts) continue;
                    const error = new Error('The catalog changed while it was loading. Try again.');
                    error.statusCode = 503;
                    error.publicCode = 'CATALOG_CHANGED_DURING_LOAD';
                    throw error;
                }
                const { payload, etag } = sharedBuild;
                setCatalogCacheHeaders(res, etag);
                if (req.headers['if-none-match'] === etag) return res.status(304).send();
                return res.status(200).json(payload);
            }
        }

        let categories = [];
        let settingsData = {};
        let categoryFilterIds = [];
        let selectedCategoryId = categoryId;

        if (isLightweight) {
            if (!search && !productIds) {
                if (subcategoryId) {
                    categoryFilterIds = [subcategoryId];
                } else if (selectedCategoryId) {
                    const [subRows] = await pool.query(
                        `SELECT c.id FROM categories c WHERE c.parent_id = ? AND c.is_active = 1${categoryContextSql}${gridCategorySql}`,
                        [selectedCategoryId]
                    );
                    categoryFilterIds = [selectedCategoryId, ...subRows.map(r => r.id)];
                }
            }
        } else {
            // Fire all 3 independent full-load queries in parallel —
            // categories, settings, and category-counts have no dependency on each other.
            const [
                [catRows],
                catalogSettings,
                [countRows]
            ] = await Promise.all([
                pool.query(`
                    SELECT c.*
                    FROM categories c
                    WHERE c.is_active = 1${categoryContextSql}${gridCategorySql}
                    ORDER BY id ASC
                `),
                getSettings(pool, POS_CATALOG_SETTING_KEYS),
                pool.query(`
                    SELECT p.category_id, COUNT(*) AS total
                    FROM products p
                    LEFT JOIN categories c ON c.id = p.category_id
                    WHERE p.is_active = 1${productContextSql}${gridProductSql}
                    GROUP BY p.category_id
                `)
            ]);

            categories = catRows;
            settingsData = catalogSettings;

            const categoryCounts = new Map(countRows.map((row) => [String(row.category_id), Number(row.total)]));
            const sameId = (left, right) => String(left) === String(right);
            const subcategoryIdsFor = (parentId) => categories
                .filter((category) => sameId(category.parent_id, parentId))
                .map((category) => category.id);
            const mainCategories = categories.filter((category) => !category.parent_id || category.parent_id == 0);

            if (!search) {
                if (subcategoryId) {
                    categoryFilterIds = [subcategoryId];
                } else {
                    if (!selectedCategoryId && mainCategories.length > 0) {
                        const mainWithProducts = mainCategories.find((main) => {
                            const subIds = subcategoryIdsFor(main.id);
                            return categoryCounts.has(String(main.id)) || subIds.some((id) => categoryCounts.has(String(id)));
                        });
                        selectedCategoryId = (mainWithProducts || mainCategories[0]).id;
                    }

                    if (selectedCategoryId) {
                        categoryFilterIds = [selectedCategoryId, ...subcategoryIdsFor(selectedCategoryId)];
                    }
                }
            }
        }

        const where = ['p.is_active = 1'];
        const params = [];

        if (productIds) {
            where.push(`p.id IN (${productIds.map(() => '?').join(',')})`);
            params.push(...productIds);
        } else if (search) {
            // An extra barcode matches the exact text only; the main barcode keeps its substring match.
            where.push(`(p.name LIKE ? OR p.barcode LIKE ? OR p.sku LIKE ? OR p.id = ${EXTRA_OWNER_IDS_SQL})`);
            const query = `%${search}%`;
            params.push(query, query, query, search);
        } else {
            if (categoryFilterIds.length > 0) {
                where.push(`p.category_id IN (${categoryFilterIds.map(() => '?').join(',')})`);
                params.push(...categoryFilterIds);
            }
            where.push(gridProductCondition);
        }

        const whereSql = where.join(' AND ');
        const knownSettings = isLightweight ? await getSettings(pool, ['stock_enabled']) : settingsData;
        // Stock is presentation-only while tracking is disabled; skip the linked
        // balance subqueries then.
        const stockProjectionSql = knownSettings.stock_enabled === '0'
            ? 'p.stock'
            : availabilitySql('p');
        const [[totalRow]] = await pool.query(`
            SELECT COUNT(*) AS total
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE ${whereSql}${productContextSql}
        `, params);
        const [products] = await pool.query(`
            SELECT p.id, p.category_id, p.barcode, p.name, p.price, p.modifiers,
                   p.price_override_locked,
                   p.tax_rate, p.jofotara_tax_category, ${stockProjectionSql} AS stock, p.background_color, p.is_bundle, p.is_available,
                   c.name AS category_name, c.is_notes AS category_is_notes, c.is_active AS category_is_active,
                   CASE
                     WHEN p.is_available = 1
                      AND (p.is_bundle = 0 OR NOT EXISTS (
                        SELECT 1
                        FROM product_bundle_items pbi
                        JOIN products child ON child.id = pbi.product_id
                        WHERE pbi.bundle_id = p.id
                          AND (child.is_active <> 1 OR child.is_available <> 1)
                      ))
                     THEN 1 ELSE 0
                   END AS can_sell
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE ${whereSql}${productContextSql}
            ORDER BY p.name
            LIMIT ? OFFSET ?
        `, [...params, productIds ? productIds.length : limit, productIds ? 0 : offset]);

        const productMap = new Map(products.map(product => [Number(product.id), product]));
        if (salesContext === 'register') await attachRegisterPrices(pool, productMap);
        products.forEach(presentCatalogProduct);

        // Attach sub-items to bundle products in one bulk query.
        const bundleIds = products.filter(p => Number(p.is_bundle) === 1).map(p => p.id);
        if (bundleIds.length > 0) {
            const placeholders = bundleIds.map(() => '?').join(',');
            const [bundleRows] = await pool.query(`
                SELECT pbi.bundle_id, pbi.product_id, pbi.qty, pbi.sort_order,
                       p.name, p.category_id, p.tax_rate, p.jofotara_tax_category, p.modifiers, p.is_active, p.is_available
                FROM product_bundle_items pbi
                JOIN products p ON pbi.product_id = p.id
                WHERE pbi.bundle_id IN (${placeholders})
                ORDER BY pbi.bundle_id, pbi.sort_order ASC, pbi.id ASC
            `, bundleIds);

            const byBundle = new Map();
            for (const row of bundleRows) {
                if (!byBundle.has(row.bundle_id)) byBundle.set(row.bundle_id, []);
                byBundle.get(row.bundle_id).push({
                    product_id: row.product_id,
                    name: row.name,
                    qty: row.qty,
                    sort_order: row.sort_order,
                    category_id: row.category_id,
                    tax_rate: row.tax_rate,
                    jofotara_tax_category: row.jofotara_tax_category,
                    modifiers: row.modifiers,
                    is_active: row.is_active,
                    is_available: row.is_available
                });
            }
            for (const p of products) {
                if (Number(p.is_bundle) === 1) p.bundleItems = byBundle.get(p.id) || [];
            }
        }

        const payload = {
            success: true,
            app_version: APP_VERSION,
            // Generation this read started under: a client compares it on its first
            // socket connect to skip a redundant gap-reconcile read.
            catalog_generation: getCatalogGenerationToken(cacheGeneration),
            categories,
            products,
            settings: settingsData,
            categories_included: !isLightweight,
            selected_category_id: selectedCategoryId,
            pagination: {
                total: Number(totalRow?.total || 0),
                limit,
                offset,
                has_more: offset + products.length < Number(totalRow?.total || 0)
            }
        };

        const payloadString = JSON.stringify(payload);
        const etag = createCatalogEtag(payloadString);

        if (isCacheable) {
            if (!setCachedCatalog(payload, etag, cacheGeneration)) {
                catalogBuild.resolve({ invalidated: true });
                catalogBuild = null;
                if (catalogBuildAttempt + 1 < maxCatalogBuildAttempts) continue;
                const error = new Error('The catalog changed while it was loading. Try again.');
                error.statusCode = 503;
                error.publicCode = 'CATALOG_CHANGED_DURING_LOAD';
                throw error;
            }
            catalogBuild.resolve({ payload, etag });
            catalogBuild = null;
        }

        setCatalogCacheHeaders(res, etag);
        if (req.headers['if-none-match'] === etag) {
            return res.status(304).send();
        }

        return res.status(200).json(payload);
        }
    } catch (e) {
        if (catalogBuild?.owner) catalogBuild.reject(e);
        logger.error({
            err: e,
            route: req.originalUrl,
            method: req.method,
            userId: req.user?.id,
            role: req.user?.role
        }, 'POS catalog fetch failed.');
        sendError(
            res,
            e.statusCode || 500,
            e.statusCode ? e.message : "Failed to load catalog. Please try again.",
            e.publicCode || null
        );
    }
});

// GET /api/pos/product_lookup?barcode=...
router.get('/product_lookup', requireAuth, async (req, res) => {
    const salesContext = parseSalesContext(req.query.sales_context);
    if (!salesContext) return sendError(res, 400, 'Invalid sales context.');
    const barcode = String(req.query.barcode || '').trim();
    if (!barcode) return sendError(res, 400, "Barcode required.");
    const scaleBarcode = decodeScaleBarcode(barcode);

    try {
        // A code matches a product's main or an extra barcode, read through the two unique indexes.
        let barcodePredicate = `p.id IN (${OWNER_IDS_SQL})`;
        let barcodeParams = [barcode, barcode];
        let resolvedFromScale = false;
        if (scaleBarcode) {
            // A scale label resolves only when exactly one product (in any state) owns
            // one of its readings, except that a product holding the exact full barcode
            // always wins. Otherwise nothing matches, so the cashier sees Unknown Code
            // instead of a guess.
            const candidates = [barcode, ...scaleBarcode.itemCodes];
            const [holders] = await pool.query(
                `SELECT id AS product_id, barcode FROM products WHERE barcode IN (?)
                 UNION ALL
                 SELECT product_id, barcode FROM product_barcodes WHERE barcode IN (?)`,
                [candidates, candidates]
            );
            const exact = holders.find(holder => holder.barcode === barcode);
            const owners = new Set(holders.map(holder => Number(holder.product_id)));
            if (!exact && owners.size !== 1) return sendSuccess(res, { product: null, scale_total_cents: null });
            barcodePredicate = 'p.id = ?';
            barcodeParams = [Number((exact || holders[0]).product_id)];
            resolvedFromScale = !exact;
        }

        const [rows] = await pool.query(`
            SELECT p.id, p.category_id, p.barcode, p.name, p.price, p.modifiers,
                   p.price_override_locked,
                   p.tax_rate, p.jofotara_tax_category, ${availabilitySql('p')} AS stock, p.background_color, p.is_bundle, p.is_available,
                   c.name AS category_name, c.is_notes AS category_is_notes, c.is_active AS category_is_active,
                   CASE
                     WHEN p.is_available = 1
                      AND (p.is_bundle = 0 OR NOT EXISTS (
                        SELECT 1
                        FROM product_bundle_items pbi
                        JOIN products child ON child.id = pbi.product_id
                        WHERE pbi.bundle_id = p.id
                          AND (child.is_active <> 1 OR child.is_available <> 1)
                      ))
                     THEN 1 ELSE 0
                   END AS can_sell
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.is_active = 1 AND ${barcodePredicate}
              ${salesContext === 'table'
                ? 'AND (p.category_id IS NULL OR c.price_list_root_id IS NULL)'
                : `AND NOT EXISTS (
                    SELECT 1 FROM categories inactive_root
                    WHERE inactive_root.id = c.price_list_root_id
                      AND inactive_root.price_list_root_id = inactive_root.id
                      AND inactive_root.is_active <> 1
                )`}
            LIMIT 1
        `, barcodeParams);

        if (rows.length === 0) return sendSuccess(res, { product: null, scale_total_cents: null });
        const product = rows[0];
        if (salesContext === 'register') {
            await attachRegisterPrices(pool, new Map([[Number(product.id), product]]));
        }
        return sendSuccess(res, {
            product: presentCatalogProduct(product),
            scale_total_cents: resolvedFromScale ? scaleBarcode.totalCents : null
        });
    } catch (e) {
        logger.error({
            err: e,
            route: req.originalUrl,
            method: req.method,
            userId: req.user?.id,
            role: req.user?.role,
            barcode
        }, 'POS product barcode lookup failed.');
        return sendError(res, 500, "Failed to load data. Please try again.");
    }
});

// POST /api/pos/category-prices/resolve
router.post('/category-prices/resolve', requireAuth, async (req, res) => {
    const salesContext = parseSalesContext(req.body?.sales_context);
    if (!salesContext) return sendError(res, 400, 'Invalid sales context.');

    const submittedIds = req.body?.product_ids;
    if (!Array.isArray(submittedIds) || submittedIds.some(id => !Number.isInteger(Number(id)) || Number(id) <= 0)) {
        return sendError(res, 400, 'Product IDs must be positive integers.');
    }
    const productIds = [...new Set(submittedIds.map(Number))];
    if (productIds.length > 300) return sendError(res, 400, 'A maximum of 300 products may be resolved.');
    if (productIds.length === 0) return sendSuccess(res, { products: [], missing_product_ids: [] });

    try {
        const placeholders = productIds.map(() => '?').join(',');
        const [rows] = await pool.query(`
            SELECT p.id, p.name, p.price, p.tax_rate, p.jofotara_tax_category,
                   p.price_override_locked,
                   p.is_active AS product_is_active,
                   c.is_active AS category_is_active,
                   c.is_notes AS category_is_notes
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.id IN (${placeholders})
        `, productIds);
        const productMap = new Map(rows.map(product => [Number(product.id), product]));
        if (salesContext === 'register') await attachRegisterPrices(pool, productMap);

        const products = rows.map(product => ({
            product_id: Number(product.id),
            price: Number(product.effective_price ?? product.price),
            base_price: Number(product.base_price ?? product.price),
            tax_rate: Number(product.tax_rate) || 0,
            name: product.name,
            product_is_active: Number(product.product_is_active) || 0,
            category_is_active: Number(product.category_is_active) || 0,
            category_is_notes: Number(product.category_is_notes) || 0,
            jofotara_tax_category: product.jofotara_tax_category,
            price_list_root_id: product.price_list_root_id ?? null,
            has_price_override: Number(product.has_price_override) || 0,
            price_override_locked: Number(product.price_override_locked) || 0
        }));
        const foundIds = new Set(products.map(product => product.product_id));
        return sendSuccess(res, {
            products,
            missing_product_ids: productIds.filter(id => !foundIds.has(id))
        });
    } catch (e) {
        logger.error({ err: e, productIds, userId: req.user?.id }, 'Register price resolution failed.');
        return sendError(res, 500, 'Failed to resolve product prices.');
    }
});

// PATCH /api/pos/products/:id/availability
// Operational switch only: checkout and table-save routes intentionally do not gate on it.
router.patch('/products/:id/availability', requireAuth, async (req, res) => {
    const productId = Number.parseInt(req.params.id, 10);
    const requested = req.body?.is_available;
    const isBooleanValue = requested === true || requested === false || requested === 1 || requested === 0 || requested === '1' || requested === '0';

    if (!Number.isInteger(productId) || productId <= 0) return sendError(res, 400, 'Invalid product.');
    if (!isBooleanValue) return sendError(res, 400, 'Availability must be true or false.');
    if (!userHas(req.user, PERMISSIONS.POS_PRODUCT_AVAILABILITY)) {
        return sendError(res, 403, 'You do not have permission to manage product availability.');
    }

    const nextAvailability = requested === true || requested === 1 || requested === '1' ? 1 : 0;
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const [[existing]] = await conn.query(
            'SELECT id, name, is_available FROM products WHERE id = ? FOR UPDATE',
            [productId]
        );
        if (!existing) {
            await conn.rollback();
            return sendError(res, 404, 'Product not found.');
        }

        const previousAvailability = Number(existing.is_available);
        if (previousAvailability !== nextAvailability) {
            await conn.query('UPDATE products SET is_available = ? WHERE id = ?', [nextAvailability, productId]);
            await appendAuditEvent(conn, {
                eventType: 'product_availability_changed',
                userId: req.user.id,
                managerId: req.auditManagerId || null,
                entityType: 'product',
                entityId: productId,
                oldValue: { is_available: previousAvailability },
                newValue: { is_available: nextAvailability },
                ipAddress: req.ip || null
            });
        }

        const [affectedProducts] = await conn.query(`
            SELECT p.id AS product_id, p.is_available,
                   CASE
                     WHEN p.is_available = 1
                      AND (p.is_bundle = 0 OR NOT EXISTS (
                        SELECT 1
                        FROM product_bundle_items child_link
                        JOIN products child ON child.id = child_link.product_id
                        WHERE child_link.bundle_id = p.id
                          AND (child.is_active <> 1 OR child.is_available <> 1)
                      ))
                     THEN 1 ELSE 0
                   END AS can_sell
            FROM products p
            WHERE p.id = ?
               OR p.id IN (SELECT bundle_id FROM product_bundle_items WHERE product_id = ?)
        `, [productId, productId]);

        await conn.commit();
        conn.release();
        conn = null;

        invalidateCatalogCache();
        await generateStaticMenu();
        const payload = {
            product_id: productId,
            is_available: nextAvailability,
            products: affectedProducts.map(row => ({
                product_id: Number(row.product_id),
                is_available: Number(row.is_available),
                can_sell: Number(row.can_sell)
            }))
        };
        if (req.io) {
            try {
                req.io.to('staff').emit('inventory_changed', { scope: 'availability' });
                req.io.emit('product_availability_changed', payload);
            } catch (error) {
                logger.error({ err: error, productId }, 'Availability notification failed after commit.');
            }
        }

        const changedProduct = payload.products.find(product => product.product_id === productId);
        return sendSuccess(res, { product: { id: productId, ...changedProduct } });
    } catch (e) {
        if (conn) await conn.rollback().catch(() => {});
        logger.error({ err: e, productId, userId: req.user?.id }, 'Product availability update failed.');
        return sendError(res, 500, 'Failed to update product availability.');
    } finally {
        if (conn) conn.release();
    }
});

// GET /api/pos/order_types
router.get('/order_types', requireAuth, async (req, res) => {
    try {
        const phoneRoleFilter = isCallCenterRole(req.user)
            ? `AND COALESCE(ot.is_deferred_settlement, 0)=0
               AND (COALESCE(y.setting_value, '')='' OR ot.id<>CAST(y.setting_value AS UNSIGNED))`
            : '';
        const [rows] = await pool.query(`
            SELECT ot.*,
                CASE WHEN ot.id = CAST(s.setting_value AS UNSIGNED) THEN 1 ELSE 0 END AS is_default
            FROM order_types ot
            LEFT JOIN settings s ON s.setting_key = 'default_order_type_id'
            LEFT JOIN settings y ON y.setting_key = 'y_order_type_id'
            WHERE ot.is_active = 1 ${phoneRoleFilter}
            ORDER BY ot.id ASC
        `);
        return sendSuccess(res, { data: rows });
    } catch (e) {
        sendError(res, 500, "Database error.");
    }
});

async function customerLookup(req, res, rawPhone) {
    res.set('Cache-Control', 'no-store');
    try {
        const phone = normalizeCustomerPhone(rawPhone);
        const [rows] = await pool.query(`
            SELECT c.id, c.name, c.address
              FROM customers c
             WHERE c.phone_normalized=?
             ORDER BY c.id ASC
             LIMIT 2
        `, [phone]);
        if (rows.length > 1) {
            return sendError(res, 409, 'More than one customer uses this phone number. Enter the details manually.', 'CUSTOMER_PHONE_AMBIGUOUS');
        }
        return sendSuccess(res, { customer: rows[0] || null });
    } catch (e) {
        logger.error({ err: e, phone: redactCustomerPhone(rawPhone), userId: req.user?.id }, 'customer_lookup failed');
        return sendError(res, e.statusCode || 500, e.statusCode ? e.message : 'Customer lookup failed.', e.publicCode || null);
    }
}

// Legacy register lookup remains available to normal POS roles. Call-center
// phone values must never be placed in a URL or access log.
router.get('/customer_lookup', requireAuth, async (req, res) => {
    if (isCallCenterRole(req.user)) return sendError(res, 405, 'Use the private phone lookup request.', 'CUSTOMER_LOOKUP_POST_REQUIRED');
    return customerLookup(req, res, req.query?.phone);
});

router.post('/customer_lookup', requireAuth, async (req, res) => {
    if (!isCallCenterRole(req.user)) return sendError(res, 403, 'Forbidden.', 'CALL_CENTER_ROLE_REQUIRED');
    return customerLookup(req, res, req.body?.phone);
});

module.exports = router;
