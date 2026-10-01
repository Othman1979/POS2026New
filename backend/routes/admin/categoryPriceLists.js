const { getConnection: getStockConnection } = require('../../services/StockReportInvalidation');
const express = require('express');
const router = express.Router();
const {
    pool,
    sendSuccess,
    sendError,
    logAdminRouteError,
    invalidateCatalogCache,
    invalidateDashboardCache,
    triggerStaticMenuGeneration,
    emitInventoryChanged
} = require('./helpers');
const { appendAuditEvent } = require('../../services/auditEvents');
const {
    grossToNet,
    netToGross,
    collectCategorySubtree,
    resolveInheritedRootId
} = require('../../services/categoryPriceLists');

function routeError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function positiveId(value, label) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw routeError(400, `${label} is invalid.`);
    return id;
}

function nullableId(value, label) {
    return value === null || value === undefined || value === '' ? null : positiveId(value, label);
}

function reportRouteError(req, res, error) {
    if (!error.statusCode || error.statusCode >= 500) logAdminRouteError(req, error);
    return sendError(res, error.statusCode || 500, error.message);
}

function afterTreeCopy(req) {
    invalidateCatalogCache();
    invalidateDashboardCache();
    triggerStaticMenuGeneration();
    if (req.io) req.io.to('staff').emit('inventory_changed');
}

function isValidRoot(root) {
    return root
        && Number(root.id) === Number(root.price_list_root_id)
        && root.parent_id == null
        && Number(root.is_notes) === 0;
}

async function loadRoot(executor, rootId, lock = false) {
    const [[root]] = await executor.query(
        `SELECT id, name, parent_id, is_active, is_notes, price_list_root_id
           FROM categories WHERE id = ? ${lock ? 'FOR UPDATE' : ''}`,
        [rootId]
    );
    if (!root) throw routeError(404, 'Price-list root not found.');
    if (!isValidRoot(root)) throw routeError(400, 'Category is not a valid price-list root.');
    return root;
}

function categoryPath(categoriesById, categoryId) {
    const names = [];
    const seen = new Set();
    let cursor = categoriesById.get(Number(categoryId));
    while (cursor && !seen.has(Number(cursor.id))) {
        seen.add(Number(cursor.id));
        names.unshift(cursor.name);
        cursor = cursor.parent_id == null ? null : categoriesById.get(Number(cursor.parent_id));
    }
    return names.join(' > ');
}

router.post('/categories/:id/copy', async (req, res) => {
    let sourceId;
    let targetParentId;
    try {
        sourceId = positiveId(req.params.id, 'Source category');
        targetParentId = nullableId(req.body?.target_parent_id, 'Target category');
    } catch (error) {
        return reportRouteError(req, res, error);
    }
    const renamed = Object.prototype.hasOwnProperty.call(req.body || {}, 'name');
    const requestedName = renamed ? String(req.body.name || '').trim() : null;
    if (renamed && !requestedName) return sendError(res, 400, 'Copied category name is required.');
    if (requestedName && requestedName.length > 50) return sendError(res, 400, 'Copied category name cannot exceed 50 characters.');

    const conn = await getStockConnection(pool);
    let result;
    try {
        await conn.beginTransaction();
        const [categories] = await conn.query(
            'SELECT id, parent_id, name, is_active, is_notes, price_list_root_id FROM categories ORDER BY id FOR UPDATE'
        );
        const categoriesById = new Map(categories.map(row => [Number(row.id), row]));
        const source = categoriesById.get(sourceId);
        if (!source) throw routeError(404, 'Source category not found.');
        if (targetParentId != null && !categoriesById.has(targetParentId)) throw routeError(404, 'Target category not found.');

        const sourceCategories = collectCategorySubtree(categories, sourceId);
        const sourceCategoryIds = sourceCategories.map(row => Number(row.id));
        if (targetParentId != null && sourceCategoryIds.includes(targetParentId)) {
            throw routeError(409, 'The destination cannot be inside the copied category tree.');
        }
        const destinationRootId = resolveInheritedRootId(categoriesById, targetParentId);

        const categoryIdMap = new Map();
        for (const category of sourceCategories) {
            const isSourceRoot = Number(category.id) === sourceId;
            const parentId = isSourceRoot ? targetParentId : categoryIdMap.get(Number(category.parent_id));
            const [insert] = await conn.query(
                `INSERT INTO categories (parent_id, name, is_active, is_notes, price_list_root_id)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    parentId,
                    isSourceRoot && renamed ? requestedName : category.name,
                    Number(category.is_active) === 1 ? 1 : 0,
                    Number(category.is_notes) === 1 ? 1 : 0,
                    destinationRootId
                ]
            );
            categoryIdMap.set(Number(category.id), Number(insert.insertId));
        }

        const categoryPlaceholders = sourceCategoryIds.map(() => '?').join(',');
        const [sourceProducts] = await conn.query(
            `SELECT id, category_id, name, price, cost_price, tax_rate, jofotara_tax_category, modifiers, image, color,
                    is_active, is_available, stock, min_stock_level, max_stock_level,
                    show_in_grid, is_bundle, background_color, price_override_locked
               FROM products
              WHERE category_id IN (${categoryPlaceholders})
              ORDER BY id FOR UPDATE`,
            sourceCategoryIds
        );
        const productIdMap = new Map();
        for (const product of sourceProducts) {
            const [insert] = await conn.query(
                `INSERT INTO products
                 (category_id, barcode, sku, name, price, cost_price, tax_rate, jofotara_tax_category, modifiers, image, color,
                  is_active, is_available, stock, min_stock_level, max_stock_level,
                  show_in_grid, is_bundle, background_color, price_override_locked)
                 VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    categoryIdMap.get(Number(product.category_id)),
                    product.name,
                    product.price,
                    product.cost_price,
                    product.tax_rate,
                    product.jofotara_tax_category,
                    product.modifiers,
                    product.image,
                    product.color,
                    product.is_active,
                    product.is_available,
                    product.stock == null ? null : 0,
                    product.min_stock_level,
                    product.max_stock_level,
                    product.show_in_grid,
                    product.is_bundle,
                    product.background_color,
                    Number(product.price_override_locked) === 1 ? 1 : 0
                ]
            );
            productIdMap.set(Number(product.id), Number(insert.insertId));
        }

        const [printerMappings] = await conn.query(
            `SELECT printer_id, category_id
               FROM printer_categories
              WHERE category_id IN (${categoryPlaceholders})
              ORDER BY printer_id, category_id FOR UPDATE`,
            sourceCategoryIds
        );
        if (printerMappings.length > 0) {
            await conn.query(
                'INSERT IGNORE INTO printer_categories (printer_id, category_id) VALUES ?',
                [printerMappings.map(mapping => [mapping.printer_id, categoryIdMap.get(Number(mapping.category_id))])]
            );
        }

        const sourceProductIds = sourceProducts.map(product => Number(product.id));
        if (sourceProductIds.length > 0) {
            const productPlaceholders = sourceProductIds.map(() => '?').join(',');
            const [bundleLinks] = await conn.query(
                `SELECT bundle_id, product_id, qty, sort_order
                   FROM product_bundle_items
                  WHERE bundle_id IN (${productPlaceholders})
                  ORDER BY bundle_id, sort_order, id FOR UPDATE`,
                sourceProductIds
            );
            if (bundleLinks.length > 0) {
                await conn.query(
                    'INSERT INTO product_bundle_items (bundle_id, product_id, qty, sort_order) VALUES ?',
                    [bundleLinks.map(link => [
                        productIdMap.get(Number(link.bundle_id)),
                        productIdMap.get(Number(link.product_id)) || Number(link.product_id),
                        link.qty,
                        link.sort_order
                    ])]
                );
            }
            for (const [oldId, newId] of productIdMap) {
                await conn.query(
                    `INSERT INTO product_recipe_lines (product_id, ingredient_id, qty_per_unit, yield_pct, sort_order)
                     SELECT ?, ingredient_id, qty_per_unit, yield_pct, sort_order
                       FROM product_recipe_lines
                      WHERE product_id = ?`,
                    [newId, oldId]
                );
            }
        }

        result = {
            root_category_id: categoryIdMap.get(sourceId),
            categories_copied: sourceCategories.length,
            products_copied: sourceProducts.length
        };
        await appendAuditEvent(conn, {
            eventType: 'category_tree_copied',
            userId: req.user?.id || null,
            entityType: 'category',
            entityId: result.root_category_id,
            newValue: {
                source_category_id: sourceId,
                target_parent_id: targetParentId,
                ...result
            },
            ipAddress: req.ip || null
        });
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        return reportRouteError(req, res, error);
    } finally {
        conn.release();
    }

    afterTreeCopy(req);
    return sendSuccess(res, result);
});

router.get('/category-price-lists/:rootId/products', async (req, res) => {
    let rootId;
    try {
        rootId = positiveId(req.params.rootId, 'Price-list root');
        const root = await loadRoot(pool, rootId);
        const [categories] = await pool.query(
            `SELECT id, parent_id, name, is_notes
               FROM categories
              WHERE price_list_root_id = ?
              ORDER BY id`,
            [rootId]
        );
        const categoriesById = new Map(categories.map(category => [Number(category.id), category]));
        const eligibleCategoryIds = categories
            .filter(category => Number(category.is_notes) === 0)
            .map(category => Number(category.id));
        let products = [];
        if (eligibleCategoryIds.length > 0) {
            const placeholders = eligibleCategoryIds.map(() => '?').join(',');
            const [rows] = await pool.query(
                `SELECT p.id AS product_id, p.name, p.category_id, p.tax_rate, p.price AS base_net_price,
                        p.is_active, price_override.price AS override_net_price
                   FROM products p
                   LEFT JOIN product_price_overrides price_override
                     ON price_override.price_list_root_id = ?
                    AND price_override.product_id = p.id
                  WHERE p.category_id IN (${placeholders})`,
                [rootId, ...eligibleCategoryIds]
            );
            products = rows.map(row => {
                const baseNet = Number(row.base_net_price);
                const overrideNet = row.override_net_price == null ? null : Number(row.override_net_price);
                const tax = Number(row.tax_rate) || 0;
                const baseGross = netToGross(baseNet, tax);
                const overrideGross = overrideNet == null ? null : netToGross(overrideNet, tax);
                return {
                    product_id: Number(row.product_id),
                    name: row.name,
                    category_id: Number(row.category_id),
                    category_path: categoryPath(categoriesById, row.category_id),
                    tax_rate: tax,
                    base_net_price: baseNet,
                    base_gross_price: baseGross,
                    override_net_price: overrideNet,
                    override_gross_price: overrideGross,
                    effective_gross_price: overrideGross ?? baseGross,
                    is_active: Number(row.is_active) === 1 ? 1 : 0
                };
            }).sort((left, right) =>
                left.category_path.localeCompare(right.category_path)
                || left.name.localeCompare(right.name)
                || left.product_id - right.product_id
            );
        }
        return sendSuccess(res, {
            root: { id: Number(root.id), name: root.name, is_active: Number(root.is_active) === 1 ? 1 : 0 },
            products
        });
    } catch (error) {
        return reportRouteError(req, res, error);
    }
});

router.put('/category-price-lists/:rootId/prices', async (req, res) => {
    let rootId;
    let normalized;
    try {
        rootId = positiveId(req.params.rootId, 'Price-list root');
        if (!Array.isArray(req.body?.prices)) throw routeError(400, 'prices must be an array.');
        if (req.body.prices.length > 1000) throw routeError(400, 'A price batch can contain at most 1,000 products.');
        const seen = new Set();
        normalized = req.body.prices.map((change, index) => {
            const productId = positiveId(change?.product_id, `Product at row ${index + 1}`);
            if (seen.has(productId)) throw routeError(400, `Product ${productId} appears more than once.`);
            seen.add(productId);
            if (change.gross_price === null || change.gross_price === '') {
                return { product_id: productId, gross_price: null };
            }
            const grossPrice = Number(change.gross_price);
            if (!Number.isFinite(grossPrice) || grossPrice < 0) {
                throw routeError(400, `Gross price for product ${productId} must be a finite number of zero or more.`);
            }
            return { product_id: productId, gross_price: grossPrice };
        });
        normalized.sort((left, right) => left.product_id - right.product_id);
    } catch (error) {
        return reportRouteError(req, res, error);
    }

    const conn = await getStockConnection(pool);
    let changes = [];
    try {
        await conn.beginTransaction();
        await loadRoot(conn, rootId, true);
        const productIds = normalized.map(change => change.product_id);
        let products = [];
        let existingOverrides = [];
        if (productIds.length > 0) {
            const placeholders = productIds.map(() => '?').join(',');
            [products] = await conn.query(
                `SELECT p.id, p.name, p.tax_rate, p.is_active, p.category_id,
                        category.price_list_root_id, category.is_notes
                   FROM products p
                   LEFT JOIN categories category ON category.id = p.category_id
                  WHERE p.id IN (${placeholders})
                  ORDER BY p.id FOR UPDATE`,
                productIds
            );
            if (products.length !== productIds.length) throw routeError(409, 'One or more products no longer exist.');
            const invalid = products.find(product =>
                Number(product.price_list_root_id) !== rootId || Number(product.is_notes) === 1
            );
            if (invalid) throw routeError(409, `Product ${invalid.id} is no longer inside this price-list root.`);
            [existingOverrides] = await conn.query(
                `SELECT product_id, price
                   FROM product_price_overrides
                  WHERE price_list_root_id = ?
                    AND product_id IN (${placeholders})
                  ORDER BY product_id FOR UPDATE`,
                [rootId, ...productIds]
            );
        }

        const productById = new Map(products.map(product => [Number(product.id), product]));
        const overrideByProduct = new Map(existingOverrides.map(row => [Number(row.product_id), Number(row.price)]));
        changes = normalized.flatMap(change => {
            const product = productById.get(change.product_id);
            let newNet = null;
            if (change.gross_price != null) {
                try {
                    newNet = grossToNet(change.gross_price, Number(product.tax_rate) || 0);
                } catch (error) {
                    throw routeError(400, error.message);
                }
            }
            const oldNet = overrideByProduct.has(change.product_id) ? overrideByProduct.get(change.product_id) : null;
            if (oldNet === newNet) return [];
            const tax = Number(product.tax_rate) || 0;
            return [{
                product_id: change.product_id,
                old_net_price: oldNet,
                old_gross_price: oldNet == null ? null : netToGross(oldNet, tax),
                new_net_price: newNet,
                new_gross_price: newNet == null ? null : netToGross(newNet, tax)
            }];
        });

        const upserts = changes.filter(change => change.new_net_price != null);
        if (upserts.length > 0) {
            await conn.query(
                `INSERT INTO product_price_overrides (price_list_root_id, product_id, price)
                 VALUES ?
                 ON DUPLICATE KEY UPDATE price = VALUES(price)`,
                [upserts.map(change => [rootId, change.product_id, change.new_net_price])]
            );
        }
        const deletions = changes.filter(change => change.new_net_price == null).map(change => change.product_id);
        if (deletions.length > 0) {
            await conn.query(
                `DELETE FROM product_price_overrides
                  WHERE price_list_root_id = ?
                    AND product_id IN (${deletions.map(() => '?').join(',')})`,
                [rootId, ...deletions]
            );
        }
        if (changes.length > 0) {
            await appendAuditEvent(conn, {
                eventType: 'category_price_overrides_changed',
                userId: req.user?.id || null,
                entityType: 'category',
                entityId: rootId,
                oldValue: {
                    root_id: rootId,
                    prices: changes.map(change => ({ product_id: change.product_id, net_price: change.old_net_price, gross_price: change.old_gross_price }))
                },
                newValue: {
                    root_id: rootId,
                    changed_product_ids: changes.map(change => change.product_id),
                    prices: changes.map(change => ({ product_id: change.product_id, net_price: change.new_net_price, gross_price: change.new_gross_price }))
                },
                ipAddress: req.ip || null
            });
        }
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        return reportRouteError(req, res, error);
    } finally {
        conn.release();
    }

    if (changes.length > 0) {
        invalidateCatalogCache();
        emitInventoryChanged(req, changes.map(change => change.product_id));
    }
    return sendSuccess(res, {
        changed_count: changes.length,
        changed_product_ids: changes.map(change => change.product_id)
    });
});

module.exports = router;
